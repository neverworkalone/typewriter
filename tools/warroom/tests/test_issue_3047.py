"""Issue #3047 PR 2: parallel Stage 2 primary tasks - bounded scheduler, single-writer saves, corrections, Stop/Retry.

Fake AI/git: this proves the Supervisor state machine around the Admission task API (whose own contract is covered by
admission-cli.test.mjs), not a real model run.
"""
import json
import unittest
from pathlib import Path

from tests.fakes import FakeAdapter
from tests.test_issue_1684 import S2, s2_world
from warroom import control, stage2
from warroom.config import DEFAULTS, config_problem
from warroom.store import SCHEMA_VERSION, Store

PREFIX = "001-01-01"


def answer(text):
    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n"


def drop_rows(task, count, *, bad=()):
    lines = [f"chunk {task}"]
    lines += [f"c{n} D {'BAD' if n in bad else 'e'}" for n in range(1, count + 1)]
    return "\n".join(lines)


class ParallelStage2(unittest.TestCase):
    def world(self, layout, *, cap=16, target=250):
        w = s2_world(self)
        w.parallel_s2 = True
        w.sup.parallel_new_parts = True
        w.git.task_layout = layout
        w.cfg["stage2_max_parallel"], w.cfg["stage2_chunk_candidates"] = cap, target
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        return w

    def tasks(self, w):
        b = w.store.active_batch("claude", S2)
        return {r["task"]: r for r in w.store.task_rows(b["id"])}

    def respond(self, w, task, text=None, count=None):
        """The task's AI finishes with its answer (default: Drop e for every candidate of the planned task)."""
        b = w.store.active_batch("claude", S2)
        row = w.store.task_row(b["id"], task)
        run = w.store.run(row["run_id"])
        pid = next(launch["pid"] for launch in w.adapter.launches if launch["pid"] and w.adapter.running.get(launch["pid"], {}).get("log") == Path(run["log_file"]))
        planned = next(t for t in stage2.read_plan(b["worktree"])["tasks"] if t["id"] == task)
        w.adapter.running[pid]["text"] = answer(text if text is not None else drop_rows(task, count or planned["candidate_count"]))
        w.adapter.finish(pid)

    def launch(self, w, n=1):
        for _ in range(n):
            w.adapter.plan.append({"code": 0, "session": f"ses_{len(w.adapter.plan)}"})

    def test_five_tasks_start_together_and_save_in_completion_order(self):
        w = self.world([(f"sense-{i}", 240) for i in range(5)])
        self.launch(w, 5)
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["state"], b["run_kind"], b["pid"]), ("PRODUCING", "s2_parallel", None))
        self.assertEqual(len(w.adapter.launches), 5)
        self.assertEqual(w.store.get(stage2.mode_key(b["id"])), "parallel")
        self.assertEqual(len({r["task"] for r in w.store.open_task_runs(b["id"])}), 5)
        order = [f"{PREFIX}-t0{n}" for n in (4, 1, 5, 2, 3)]
        for task in order:
            self.respond(w, task)
            w.tick()
        self.assertEqual(w.git.task_save_calls, order)   # saved one by one as they completed, never two at once
        checkpoint = stage2.checkpoint(b["worktree"], "001", "01-01")
        self.assertEqual((checkpoint["decided"], checkpoint["total"], checkpoint["next_chunk_number"]), (1200, 1200, 6))
        row = w.store.batch(b["id"])
        self.assertEqual(w.store.get(f"s2_plan_{b['id']}"), "closed")
        self.assertEqual((row["state"], row["run_kind"]), ("WAITING_REVIEW", "s2_deterministic_finalize"))
        self.assertEqual(len(w.adapter.launches), 5)   # nothing else ran an AI: finalization is deterministic
        self.assertEqual(w.git.close_plan_calls, [("001", "01", "01")])

    def test_cap_bounds_active_sessions_and_free_slots_refill_immediately(self):
        w = self.world([(f"sense-{i}", 240) for i in range(20)], cap=16)
        self.launch(w, 20)
        w.tick()
        self.assertEqual(len(w.adapter.launches), 16)
        self.respond(w, f"{PREFIX}-t01")
        self.respond(w, f"{PREFIX}-t02")
        w.tick()
        self.assertEqual(len(w.adapter.launches), 18)   # two slots opened, two refilled, no wave barrier
        self.assertEqual(len([t for t in self.tasks(w).values() if t["state"] == "RUNNING"]), 16)

    def test_cap_one_runs_the_same_plan_sequentially(self):
        w = self.world([(f"sense-{i}", 240) for i in range(3)], cap=1)
        self.launch(w, 3)
        for n in range(1, 4):
            w.tick()
            self.assertEqual(len(w.adapter.launches), n)
            self.respond(w, f"{PREFIX}-t0{n}")
        w.tick()
        self.assertEqual(w.store.batch(w.store.active_batch("claude", S2)["id"])["state"], "WAITING_REVIEW")

    def test_large_sense_chain_waits_for_saved_predecessor_and_gets_slot_priority(self):
        w = self.world([("big", 600), ("small", 100)], cap=2, target=250)
        self.launch(w, 4)
        w.tick()
        tasks = self.tasks(w)
        # big -> t01..t03 (chain), small -> t04. Cap 2: the chain head and the (larger) chain outranks the small one.
        self.assertEqual(sorted(t for t, r in tasks.items() if r["state"] == "RUNNING"), [f"{PREFIX}-t01", f"{PREFIX}-t04"])
        self.assertEqual(tasks[f"{PREFIX}-t02"]["state"], "PENDING")
        self.respond(w, f"{PREFIX}-t01")
        w.tick()
        tasks = self.tasks(w)
        self.assertEqual(tasks[f"{PREFIX}-t01"]["state"], "SAVED")
        self.assertEqual(tasks[f"{PREFIX}-t02"]["state"], "RUNNING")   # the freed slot continues the chain
        self.assertEqual(tasks[f"{PREFIX}-t03"]["state"], "PENDING")   # still waits for t02's save

    def test_rejected_candidate_gets_one_same_session_correction_then_saves(self):
        w = self.world([("s", 3)], target=250)
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.respond(w, task, drop_rows(task, 3, bad=(2,)))
        w.tick()
        row = self.tasks(w)[task]
        self.assertEqual(row["state"], "RUNNING")
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        self.assertIn("c2", w.adapter.launches[-1]["prompt"])
        self.respond(w, task, f"chunk {task}\nc2 D e")
        w.tick()
        self.assertEqual(self.tasks(w)[task]["state"], "SAVED")
        self.assertEqual(len(w.adapter.launches), 2)

    def test_single_residual_candidate_after_the_correction_gets_technical_drop(self):
        w = self.world([("s", 3)], target=250)
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.respond(w, task, drop_rows(task, 3, bad=(2,)))
        w.tick()
        self.respond(w, task, f"chunk {task}\nc2 D BAD")
        w.tick()
        self.assertEqual(self.tasks(w)[task]["state"], "SAVED")
        self.assertEqual([c["alias"] for c in w.git.technical_fallback_calls], ["c2"])
        self.assertEqual(len(w.adapter.launches), 2)   # no further AI run for the fallback

    def test_multiple_residual_candidates_after_the_correction_stop_without_f(self):
        w = self.world([("s", 3)], target=250)
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.respond(w, task, drop_rows(task, 3, bad=(1, 2)))
        w.tick()
        self.respond(w, task, f"chunk {task}\nc1 D BAD\nc2 D BAD")
        w.tick(2)
        b = w.store.active_batch("claude", S2)
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(w.git.technical_fallback_calls, [])
        self.assertEqual(self.tasks(w)[task]["state"], "FAILED")

    def test_failed_task_keeps_other_tasks_saving_then_halts_and_retry_reruns_only_it(self):
        w = self.world([(f"sense-{i}", 10) for i in range(2)], target=10)
        self.launch(w, 3)
        w.tick()
        t1, t2 = f"{PREFIX}-t01", f"{PREFIX}-t02"
        self.respond(w, t1, "no decisions at all")   # no task header: the task re-runs once in a fresh session
        self.respond(w, t2)
        w.tick()
        self.assertEqual(self.tasks(w)[t2]["state"], "SAVED")
        self.assertEqual(len(w.adapter.launches), 3)
        self.respond(w, t1, "still nothing")
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["state"], self.tasks(w)[t1]["state"]), ("ERROR", "FAILED"))
        self.assertEqual(self.tasks(w)[t2]["state"], "SAVED")
        self.launch(w, 1)
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 4)   # only the failed task runs again; SAVED work is not redone
        self.assertEqual(self.tasks(w)[t1]["state"], "RUNNING")

    def test_stop_stops_every_task_and_retry_restarts_only_unsaved_tasks(self):
        w = self.world([(f"sense-{i}", 240) for i in range(3)])
        self.launch(w, 6)
        w.tick()
        t1 = f"{PREFIX}-t01"
        self.respond(w, t1)
        w.tick()   # t01 SAVED
        self.assertEqual(self.tasks(w)[t1]["state"], "SAVED")
        control.stop_line(w.store, "claude", S2)
        w.tick(2)
        b = w.store.active_batch("claude", S2)
        self.assertEqual(b["state"], "PAUSED")
        self.assertEqual(w.adapter.running, {})
        self.assertEqual(w.store.open_task_runs(b["id"]), [])
        launches = len(w.adapter.launches)
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        tasks = self.tasks(w)
        self.assertEqual(tasks[t1]["state"], "SAVED")
        self.assertEqual(len(w.adapter.launches), launches + 2)   # only the two unsaved tasks run again

    def test_restart_keeps_polling_running_tasks_without_new_launches(self):
        w = self.world([(f"sense-{i}", 240) for i in range(2)])
        self.launch(w, 2)
        w.tick()
        w.sup = w.make_sup()   # Supervisor restart: everything is rebuilt from the store and the worktree
        w.sup.parallel_new_parts = True
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 2)
        self.respond(w, f"{PREFIX}-t01")
        self.respond(w, f"{PREFIX}-t02")
        w.sup = w.make_sup()
        w.sup.parallel_new_parts = True
        w.tick()
        self.assertEqual(w.store.get(f"s2_plan_{w.store.active_batch('claude', S2)['id']}"), "closed")

    def test_common_remote_and_pr_lookups_do_not_grow_with_the_task_count(self):
        w = self.world([(f"sense-{i}", 240) for i in range(16)])
        calls = {"remote": 0, "pr": 0}
        remote, pr = w.git.remote_head, w.sup._find_recovery_pr
        w.git.remote_head = lambda *a, **k: (calls.__setitem__("remote", calls["remote"] + 1), remote(*a, **k))[1]
        w.sup._find_recovery_pr = lambda *a, **k: (calls.__setitem__("pr", calls["pr"] + 1), pr(*a, **k))[1]
        self.launch(w, 16)
        w.tick()
        self.assertEqual(len(w.adapter.launches), 16)
        started = dict(calls)
        w.tick()   # a plain waiting tick adds no common remote/PR lookup
        self.assertEqual(calls, started)
        self.assertLessEqual(started["pr"], 1)

    def test_prompt_puts_policy_before_the_task_block_and_the_whole_view_after_it(self):
        w = self.world([("s", 3)])
        self.launch(w, 1)
        w.tick()
        prompt = w.adapter.launches[0]["prompt"]
        task = f"{PREFIX}-t01"
        self.assertLess(prompt.index("답변 형식"), prompt.index("## 이번 task"))
        self.assertLess(prompt.index("## 이번 task"), prompt.index("<<<CHUNK_VIEW_BEGIN>>>"))
        self.assertIn(f"chunk <task ID>", prompt)
        self.assertIn(f"`{task}`", prompt)
        self.assertIn("c3\ts-cand-2", prompt)   # the full view, nothing truncated
        self.assertNotIn("checkpoint 0/", prompt)   # Part-wide progress is left out of the shared prefix


class ParallelStage2Recovery(ParallelStage2):
    def finish_code(self, w, task, code, text):
        b = w.store.active_batch("claude", S2)
        run = w.store.run(w.store.task_row(b["id"], task)["run_id"])
        pid = next(l["pid"] for l in w.adapter.launches if w.adapter.running.get(l["pid"], {}).get("log") == Path(run["log_file"]))
        w.adapter.running[pid].update(code=code, text=text)
        w.adapter.finish(pid)

    def test_complete_answer_survives_a_nonzero_exit(self):
        w = self.world([("s", 3)])
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.finish_code(w, task, 1, answer(drop_rows(task, 3)))
        w.tick()
        self.assertEqual(self.tasks(w)[task]["state"], "SAVED")
        self.assertEqual(len(w.adapter.launches), 1)

    def test_unknown_failure_without_answer_is_preserved_not_rerun(self):
        w = self.world([("s", 3)])
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.finish_code(w, task, 1, "something odd happened\n")
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(w.store.active_batch("claude", S2)["state"], "ERROR")

    def test_rate_limit_failure_is_retried_for_that_task(self):
        w = self.world([("s", 3)])
        self.launch(w, 2)
        w.tick()
        task = f"{PREFIX}-t01"
        self.finish_code(w, task, 1, "HTTP 429 rate limit exceeded\n")
        w.tick()
        w.now += 1000
        w.tick()
        self.assertEqual(len(w.adapter.launches), 2)

    def test_restart_after_technical_drop_save_resaves_with_persisted_evidence(self):
        w = self.world([("s", 3)])
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.respond(w, task, drop_rows(task, 3, bad=(2,)))
        w.tick()
        self.respond(w, task, f"chunk {task}\nc2 D BAD")
        real = w.store.update_task
        def lose_saved(batch_id, t, **fields):   # the CLI saved, then the Supervisor died before recording SAVED
            if fields.get("state") == "SAVED":
                raise RuntimeError("crash")
            return real(batch_id, t, **fields)
        w.store.update_task = lose_saved
        with self.assertRaises(RuntimeError):
            w.sup.s2p.poll(w.store.active_batch("claude", S2))
        w.store.update_task = real
        self.assertEqual(self.tasks(w)[task]["state"], "RESPONDED")
        w.sup = w.make_sup()
        w.sup.parallel_new_parts = True
        w.tick()
        self.assertEqual(self.tasks(w)[task]["state"], "SAVED")
        b = w.store.active_batch("claude", S2) or w.store.latest_batch("claude", S2)
        self.assertEqual(stage2.checkpoint(b["worktree"], "001", "01-01")["next_chunk_number"], 2)


class ConfigAndMigration(unittest.TestCase):
    def test_defaults_and_validation(self):
        self.assertEqual((DEFAULTS["stage2_chunk_candidates"], DEFAULTS["stage2_max_parallel"]), (250, 16))
        for key in ("stage2_chunk_candidates", "stage2_max_parallel"):
            bad = json.loads(json.dumps(DEFAULTS))
            bad[key] = 0
            self.assertIn(key, config_problem(bad) or "")

    def test_additive_migration_creates_task_state(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "w.db")
            with store._conn() as c:
                tables = {r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                runs = {r["name"] for r in c.execute("PRAGMA table_info(runs)")}
                version = c.execute("PRAGMA user_version").fetchone()[0]
        self.assertIn("s2_tasks", tables)
        self.assertIn("task", runs)
        self.assertEqual(version, SCHEMA_VERSION)


if __name__ == "__main__":
    unittest.main()
