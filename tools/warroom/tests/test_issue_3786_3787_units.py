"""One admission per task: closing the gate while the first task is inside its spawn stops the loop before the
second task writes anything - from the steady-state slot fill and from the nested `_launch_*_next` permit alike."""
import json
import sqlite3
import threading
import unittest
from pathlib import Path

from tests.fakes import World
from warroom import control, stage2, taskruns


def db_lines(w):
    conn = sqlite3.connect(w.store.path)
    try:
        return [line for line in conn.iterdump() if "heartbeat" not in line]
    finally:
        conn.close()


def tree(w):
    return {str(p): p.read_bytes() for p in sorted(Path(w.tmp.name).rglob("*"))
            if p.is_file() and p.suffix not in (".sqlite", ".db") and not p.name.endswith(("-wal", "-shm"))}


# A builder returns (world, trigger): `trigger()` is the tick whose launch loop has >= 2 waiting tasks. With
# nested=True the loop runs under the `_guarded("prelaunch")` permit of the batch start; otherwise it is the
# steady-state refill after two running tasks completed (no enclosing permit).
def build_s3(case, nested):
    from tests.test_issue_2450_stage3 import PRODUCERS
    from tests.test_issue_3149 import Helpers
    from warroom.store import STAGE3_METHOD
    h = Helpers()
    w = World()
    case.addCleanup(w.tmp.cleanup)
    w.cfg["producers"] = json.loads(json.dumps(PRODUCERS))
    w.parallel_s3 = True
    w.sup.parallel_new_s3 = True
    w.runner.edit.chunks = 3 if nested else 4
    w.cfg["stage3_max_parallel"] = 2   # two slots: the second task is the one a closing gate must stop
    w.store.set(stage2.ok_key("001", None), w.git.base_sha)
    assert control.start(w.store, "claude", STAGE3_METHOD, "single", cfg=w.cfg)[0]
    if not nested:
        w.tick(2)
        h.respond(w, "001"), h.respond(w, "002")
    return w, w.tick


def build_s2(case, nested):
    from tests.test_issue_3047 import PREFIX, Helpers
    h = Helpers()
    h.addCleanup = case.addCleanup
    w = h.world([(f"sense-{i}", 240) for i in range(3 if nested else 4)], cap=2)
    h.launch(w, 4)
    if not nested:
        w.tick()
        h.respond(w, f"{PREFIX}-t01"), h.respond(w, f"{PREFIX}-t02")
    return w, w.tick


def build_d(case, nested):
    from tests.test_issue_3074 import ParallelDHelpers
    h = ParallelDHelpers()
    h.addCleanup = case.addCleanup
    w = h.world()
    h.plan_all(w, range(1, 11))
    w.start("single", "deepseek", "d")
    if not nested:
        w.tick()
        h.finish_task(w, "001"), h.finish_task(w, "002")
    return w, w.tick


def build_c(case, nested):
    from tests.test_issue_3076 import Helpers
    h = Helpers()
    h.addCleanup = case.addCleanup
    w = h.world(senses=400)
    w.start("single", "deepseek", "c")
    if not nested:
        w.tick()
        h.finish(w, "001"), h.finish(w, "002")
    return w, w.tick


BUILDERS = {"s2": build_s2, "d": build_d, "c": build_c, "s3": build_s3}


class UnitAdmission(unittest.TestCase):
    def scenario(self, name, nested):
        w, trigger = BUILDERS[name](self, nested)
        gate = w.sup.launch_gate
        runs_before = {r["id"] for b in w.store.all_batches() for r in w.store.runs(b["id"])}
        launches_before = len(w.adapter.launches)
        entered, release, spawned, closed = threading.Event(), threading.Event(), [], {}
        real_start = w.adapter.start

        def blocking_start(*args, **kwargs):
            spawned.append(1)
            if len(spawned) == 1:
                entered.set()
                self.assertTrue(release.wait(10))
            return real_start(*args, **kwargs)

        def close():
            gate.close()
            closed["pids"] = {r["id"]: r["pid"] for b in w.store.all_batches() for r in w.store.runs(b["id"])}

        w.adapter.start = blocking_start
        worker, closer = threading.Thread(target=trigger), threading.Thread(target=close)
        worker.start()
        self.assertTrue(entered.wait(10), "the first task never reached its spawn")
        closer.start()
        with gate._condition:
            self.assertTrue(gate._condition.wait_for(lambda: not gate._open, timeout=10))
        db_before, files_before = db_lines(w), tree(w)
        release.set()
        worker.join(15), closer.join(15)
        self.assertFalse(worker.is_alive() or closer.is_alive())
        w.adapter.start = real_start

        self.assertEqual(len(spawned), 1, "only the task already inside its spawn may start")
        self.assertEqual(len(w.adapter.launches), launches_before + 1)
        new = [r for b in w.store.all_batches() for r in w.store.runs(b["id"]) if r["id"] not in runs_before]
        self.assertEqual(len(new), 1)
        first = new[0]["task"]
        self.assertTrue(first)
        self.assertIsNotNone(closed["pids"][new[0]["id"]], "close() returned before the first task's PID was recorded")
        changed = set(db_lines(w)) ^ set(db_before)
        for line in changed:   # only the started task's own rows, its run and the log may differ
            if line.startswith('INSERT INTO "s2_tasks"'):
                self.assertIn(f"'{first}'", line)
            else:
                self.assertTrue(line.startswith(('INSERT INTO "events"', 'INSERT INTO "runs"', 'INSERT INTO "sqlite_sequence"')), line[:120])
        after = tree(w)
        for path in set(after) | set(files_before):
            if after.get(path) != files_before.get(path):
                self.assertIn(first, Path(path).name, path)   # no other task's active chunk, view or checkpoint moved
        return w, first

    def restart_is_exactly_once(self, w, first):
        runner = w.runner
        w.sup = w.make_sup()   # a new Supervisor on the same DB and worktree: new gate, no frozen lanes carried over
        w.sup.runner = w.runner = runner
        self.assertTrue(w.sup.launch_gate.is_open and not w.sup._frozen_lanes)
        w.tick(3)
        runs = [r for b in w.store.all_batches() for r in w.store.runs(b["id"]) if r["task"]]
        tasks = [r["task"] for r in runs]
        self.assertEqual(len(tasks), len(set(tasks)), "a task was started twice")
        self.assertIn(first, tasks)
        self.assertEqual(len(w.adapter.launches), len(tasks))

    def check(self, name, nested):
        w, first = self.scenario(name, nested)
        self.restart_is_exactly_once(w, first)

    def test_s2_nested(self):
        self.check("s2", True)

    def test_s2_steady(self):
        self.check("s2", False)

    def test_d_nested(self):
        self.check("d", True)

    def test_d_steady(self):
        self.check("d", False)

    def test_c_nested(self):
        self.check("c", True)

    def test_c_steady(self):
        self.check("c", False)

    def test_s3_nested(self):
        self.check("s3", True)

    def test_s3_steady(self):
        self.check("s3", False)
