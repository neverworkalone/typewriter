"""#3774 / #5162: a Supervisor is replaced at any time (RUNNING -> STOPPING by Store CAS, at most HANDOFF_GRACE for its
in-flight Workers) and the next instance continues every batch from its own state. A Restart never waits for a Line.

Event-based: a real D parallel batch (the common fixture of #3074) is driven through the Coordinator's own cycle with a
real thread pool; Workers are held/released with Events, AI exits are produced by the fake adapter."""
import json
import os
import subprocess
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path
from unittest import mock

from tests.fakes import HEAD1, HEAD2
from tests.test_issue_3074 import ParallelDHelpers
from warroom import restart_controller as rc
from warroom.fence import Fence
from warroom.config import Paths
from warroom.launch_gate import LaunchDenied, LaunchGate

LINE = ("deepseek", "d")


class Drive:
    """The Coordinator's cycle with a real pool; each cycle waits for the Workers it submitted (deterministic)."""

    def __init__(self, w, workers=16):
        w.cfg["supervisor_workers"] = workers
        self.w, self.workers = w, workers
        self.pool, self.pending, self.cursor = ThreadPoolExecutor(workers), {}, 0
        w.sup.code_sha = HEAD2

    def cycle(self, wait_workers=True):
        self.cursor = self.w.sup._parallel_cycle(self.pool, self.pending, self.cursor, self.workers)
        if wait_workers:
            wait(list(self.pending.values()), timeout=10)

    def cycles(self, n):
        for _ in range(n):
            self.cycle()

    def close(self):
        self.pool.shutdown(wait=True)


class RestartWorld(ParallelDHelpers):
    def world(self, records=250, **kw):
        w = super().world(records=records, **kw)
        self.drive = Drive(w)
        self.addCleanup(self.drive.close)
        self.fence = Fence(w.paths.children, instance=w.sup.phase_instance).open()
        self.addCleanup(self.fence.close)
        w.sup.begin_instance()
        return w

    @staticmethod
    def request(w, defect=91):
        return rc.write_restart_request(w.paths, {"id": defect, "merge_sha": HEAD1}, None)

    @staticmethod
    def phase(w):
        return (w.store.restart_phase() or {}).get("phase")

    # -- the real Controller against the real phase/fence/runtime files; only tmux, Git and process probes are faked ----
    def controller(self, w, *, grace=30, head=HEAD1, next_sha=HEAD1, alive=True, state=None, **patches):
        """One Controller call. `state` carries the fake process world across calls: `alive` (the Supervisor holds its
        lock), `kill` (forced ends), `started` (new instances) and every tmux call made."""
        paths, store = w.paths, w.store
        if state is None:
            state = {"alive": alive, "kill": 0, "started": 0, "tmux": []}
            rc.record_runtime(paths, HEAD2, configured_workers=16, workers=16, instance=w.sup.phase_instance)
            paths.runtime_root_file.write_text(str(paths.repo_root.resolve()), "utf-8")
            os.utime(paths.runtime_root_file, (0, 0))   # an instance that started long ago, not one still starting

        def tmux(args, **kw):
            state["tmux"].append(list(args))
            if args[0] == "has-session":
                return mock.Mock(returncode=0 if state["alive"] else 1, stdout="")
            if args[0] == "kill-session":
                state["kill"] += 1
                state["alive"] = False
            if args[0] == "new-session":
                state["started"] += 1
                store.begin_restart_phase(f"next-{state['started']}")
                rc.record_runtime(paths, state.get("head", next_sha), configured_workers=16, workers=16,
                                  instance=f"next-{state['started']}")
                state["alive"] = True
            out = {"display-message": str(os.getpid()) if "#{pane_pid}" in args else "0"}.get(args[0], "")
            return mock.Mock(returncode=1 if args[0] == "show-environment" else 0, stdout=out)

        defaults = {"_head": mock.Mock(side_effect=lambda root: state.get("head", head)),
                    "_ancestor": mock.Mock(side_effect=lambda root, older, newer: older == newer or newer == HEAD1),
                    "_boot_problem": mock.Mock(return_value=None),
                    "_live_runtime_owner": mock.Mock(return_value=True)}
        defaults.update(patches)
        with mock.patch.multiple(rc, **defaults), \
             mock.patch.object(rc, "_lock_held", side_effect=lambda _path: state["alive"]), \
             mock.patch.object(rc, "_pid_alive", return_value=True), \
             mock.patch.object(rc, "HANDOFF_GRACE", grace), \
             mock.patch.object(rc, "STARTUP_TIMEOUT", 2), \
             mock.patch.object(rc.os, "getpgid", return_value=1), \
             mock.patch.object(rc, "_tmux", side_effect=tmux), \
             mock.patch.object(rc.time, "sleep"):
            state["result"] = rc.handle_pending_restart(paths, store)
        return state



class ReplaceNeverWaitsForOtherLines(RestartWorld, unittest.TestCase):
    def test_running_ai_holds_stop_and_clear_do_not_delay_the_replacement_and_nothing_is_spawned_twice(self):
        w = self.world()
        self.plan_all(w, range(1, 11))
        w.start("single", "deepseek", "d")
        self.drive.cycle()                                    # 8 of 10 chunks run; two are queued
        self.assertEqual(len(w.adapter.launches), 8)
        w.store.set(f"defect_hold_{w.row_()['id']}", "1")     # another incident's hold: a batch fact, not a Restart gate
        w.store.line("idle", "a")
        w.store.set_line("idle", "a", force_stop=1)           # an operator Stop: handed to the next instance
        request = self.request(w)
        state = self.controller(w)
        cur = w.store.restart_phase()
        self.assertEqual((cur["phase"], state["kill"], state["result"]), ("STOPPING", 0, ("starting", None)))
        self.drive.cycle()
        self.assertFalse(w.sup.accepting_new_work() or w.sup.launch_gate.is_open)
        with mock.patch.object(w.sup, "_tick_line") as tick, mock.patch.object(w.sup, "_parallel_maintenance") as maint:
            self.drive.cycles(3)
        self.assertFalse(tick.called or maint.called)         # STOPPING submits nothing at all
        self.request(w, defect=92)                            # a second request joins the same handoff ...
        self.controller(w, state=state)
        self.assertEqual(w.store.restart_phase()["stopping_at"], cur["stopping_at"])   # ... and never restarts its clock
        self.assertEqual((state["kill"], state["started"]), (0, 0))
        state["alive"] = False                                # its in-flight Workers returned: the instance left by itself
        self.controller(w, state=state)
        self.assertEqual((state["kill"], state["started"]), (0, 1))
        self.assertEqual(json.loads(request.read_text())["state"], "loaded")
        self.assertEqual(len(self.open_runs(w)), 8)           # the eight AI runs were never touched

        w.sup = w.make_sup()                                  # the next instance: same DB, worktree and live AI runs
        w.sup.begin_instance()
        self.finish_task(w, "001")
        w.tick(2)
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")
        launched = [l["pid"] for l in w.adapter.launches]
        self.assertEqual(len(launched), len(set(launched)))
        self.assertLessEqual(len(launched), 10)               # running chunks were re-attached, never started again
        self.assertEqual(w.store.line("idle", "a")["force_stop"], 0)   # the Stop was carried out by the new instance
        self.assertTrue(w.store.get(f"defect_hold_{w.row_()['id']}"))

    def test_thirty_seconds_is_a_maximum_then_the_supervisor_is_ended_and_recovered(self):
        """A deterministic Worker (e.g. a long verify) no longer keeps the Supervisor: past the grace it is ended."""
        w = self.world(records=25)
        w.store.line(*LINE)
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)

        def verify(model, method):
            started.set()
            release.wait(10)
        with mock.patch.object(w.sup, "_tick_line", side_effect=verify):
            self.drive.cycle(wait_workers=False)
            self.assertTrue(started.wait(5))
            request = self.request(w)
            state = self.controller(w)
            self.assertEqual((self.phase(w), state["kill"]), ("STOPPING", 0))        # inside the grace: only asked
            self.drive.cycle(wait_workers=False)
            self.assertTrue(w.sup._submit_hold and self.drive.pending)              # the Worker is still running
            self.controller(w, state=state, grace=0)                                # the grace is over
            self.assertEqual((state["kill"], state["started"]), (1, 1))
            self.assertEqual(json.loads(request.read_text())["state"], "loaded")
            self.assertEqual([c for c in state["tmux"] if c[0] == "kill-session"], [["kill-session", "-t", rc.TMUX_SUP]])
            release.set()
            wait(list(self.drive.pending.values()), timeout=10)

    def test_a_stopped_supervisor_is_started_at_once_whatever_was_running(self):
        w = self.world()
        self.plan_all(w, range(1, 11))
        w.start("single", "deepseek", "d")
        self.drive.cycle()
        w.store.set_line(*LINE, force_stop=1)
        request = self.request(w)
        self.fence.close()                                                         # the instance died
        state = self.controller(w, alive=False)
        self.assertEqual((state["kill"], state["started"]), (0, 1))
        self.assertEqual(json.loads(request.read_text())["state"], "loaded")

    def test_run_parallel_leaves_once_stopping_and_its_workers_returned(self):
        w = self.world(records=25)
        cur = w.store.restart_phase()
        self.assertIsNotNone(w.store.cas_restart_phase(cur, "STOPPING", "r", stopping_at=1.0))
        w.cfg["supervisor_workers"] = 4
        done = threading.Thread(target=lambda: w.sup.run_parallel(interval=0.01, stop_event=threading.Event()))
        done.start()
        done.join(10)
        self.assertFalse(done.is_alive())
        self.assertFalse(w.sup.launch_gate.is_open)

    def test_same_sha_replace_gives_a_new_instance_and_leaves_the_tui_and_the_checkout_alone(self):
        w = self.world(records=25)
        rc.record_runtime(w.paths, HEAD1, configured_workers=16, workers=16, instance=w.sup.phase_instance)
        with mock.patch.object(rc, "_head", return_value=HEAD1):
            path = rc.request_operator_replace(w.paths)
            first = json.loads(path.read_text())
            self.assertEqual(rc.request_operator_replace(w.paths), path)             # a repeated ./kwar joins
        self.assertEqual(json.loads(path.read_text()), first)
        self.assertEqual((first["merge_sha"], first["replace"], first["previous_instance"]),
                         (HEAD1, True, w.sup.phase_instance))
        update, forward = mock.Mock(), mock.Mock()
        state = {"alive": True, "kill": 0, "started": 0, "tmux": []}
        w.paths.runtime_root_file.write_text(str(w.paths.repo_root.resolve()), "utf-8")
        os.utime(w.paths.runtime_root_file, (0, 0))
        self.controller(w, state=state, grace=0, _update_target=update, _fast_forward=forward)
        self.assertEqual((state["kill"], state["started"]), (1, 1))                 # loaded SHA alone is not "done"
        self.assertEqual(json.loads(path.read_text())["state"], "loaded")
        self.assertFalse(update.called or forward.called)                           # ./kwar asks for no code update
        self.assertFalse([c for c in state["tmux"] if "warroom" in c and c[0] != "show-environment"])


class CodeUpdate(RestartWorld, unittest.TestCase):
    NEW = "c" * 40

    def test_checkout_changes_only_after_the_previous_instance_is_gone_and_the_new_sha_is_loaded(self):
        w = self.world(records=25)
        request = rc.write_restart_request(w.paths, {"id": 91, "merge_sha": self.NEW}, None)
        state = {"alive": True, "kill": 0, "started": 0, "tmux": []}
        w.paths.runtime_root_file.write_text(str(w.paths.repo_root.resolve()), "utf-8")
        os.utime(w.paths.runtime_root_file, (0, 0))
        rc.record_runtime(w.paths, HEAD1, configured_workers=16, workers=16, instance=w.sup.phase_instance)
        seen = []

        def forward(paths, root, head, target):
            seen.append((state["alive"], head, target))
            state["head"] = target

        kw = {"_update_target": mock.Mock(return_value=(self.NEW, None)), "_fast_forward": mock.Mock(side_effect=forward),
              "_ancestor": mock.Mock(side_effect=lambda root, older, newer: older == newer)}
        self.controller(w, state=state, **kw)
        self.assertEqual((self.phase(w), seen), ("STOPPING", []))                   # asked to stop: nothing changed yet
        self.controller(w, state=state, grace=0, **kw)
        self.assertEqual(seen, [(False, HEAD1, self.NEW)])                          # no Supervisor ran during the update
        done = json.loads(request.read_text())
        self.assertEqual((done["state"], done["loaded_code_sha"]), ("loaded", self.NEW))

    def test_an_update_that_cannot_be_applied_leaves_the_supervisor_alone_but_never_blocks_a_replace(self):
        w = self.world(records=25)
        request = rc.write_restart_request(w.paths, {"id": 91, "merge_sha": self.NEW}, None)
        kw = {"_update_target": mock.Mock(return_value=(None, "운영 checkout에 커밋되지 않은 변경이 있습니다")),
              "_fast_forward": mock.Mock(), "_ancestor": mock.Mock(side_effect=lambda root, older, newer: older == newer)}
        state = self.controller(w, grace=0, **kw)
        waiting = json.loads(request.read_text())
        self.assertEqual((state["result"], state["kill"], self.phase(w)), (("locked", None), 0, "RUNNING"))
        self.assertEqual(waiting["state"], "waiting")
        self.assertIn("현재 코드로 계속 운영", waiting["blocker"])
        self.controller(w, state=state, grace=0, **kw)
        self.assertEqual(kw["_update_target"].call_count, 1)                        # not examined again before retry_after
        with mock.patch.object(rc, "_head", return_value=HEAD1):
            replace = rc.request_operator_replace(w.paths)                           # the operator still gets a new instance
        self.controller(w, state=state, grace=0, **kw)
        self.assertEqual((state["kill"], state["started"]), (1, 1))
        self.assertEqual(json.loads(replace.read_text())["state"], "loaded")
        self.assertEqual(json.loads(request.read_text())["state"], "waiting")       # only the code update is still owed
        self.assertFalse(kw["_fast_forward"].called)

    def test_code_that_cannot_boot_never_replaces_a_running_supervisor(self):
        w = self.world(records=25)
        request = self.request(w)
        state = self.controller(w, grace=0, _boot_problem=mock.Mock(return_value="SyntaxError: invalid syntax"))
        self.assertEqual((state["kill"], state["started"], self.phase(w)), (0, 0, "RUNNING"))
        self.assertIn("SyntaxError", json.loads(request.read_text())["blocker"])

    def test_a_replaced_instance_that_cannot_prove_the_commit_is_not_replaced_again_and_again(self):
        w = self.world(records=25)
        request = self.request(w)
        never = mock.Mock(side_effect=lambda root, older, newer: newer == HEAD1 and older == HEAD1)
        state = self.controller(w, grace=0, next_sha=None, _ancestor=never)        # e.g. modified runtime source: no SHA
        self.assertEqual((state["kill"], state["started"]), (1, 1))
        self.assertEqual(json.loads(request.read_text())["state"], "waiting")
        for _ in range(3):
            self.controller(w, state=state, grace=0, next_sha=None, _ancestor=never)
        self.assertEqual((state["kill"], state["started"]), (1, 1))


class RealCheckoutUpdate(unittest.TestCase):
    """The fast-forward decision against real Git: read-only until `_fast_forward`, and never a reset or a stash."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        base = Path(self.tmp.name)
        self.git(base, "init", "-q", "--bare", "-b", "master", "origin.git")
        self.git(base, "clone", "-q", "origin.git", "op")
        self.op, self.other = base / "op", base / "other"
        self.commit(self.op, "pnpm-lock.yaml", "v1")
        self.git(self.op, "push", "-q", "origin", "master")
        self.git(base, "clone", "-q", "origin.git", "other")
        self.paths = Paths(repo_root=self.op, local=base / "local")
        self.head = self.sha(self.op)

    @staticmethod
    def git(cwd, *args):
        done = subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
                               *args], cwd=cwd, capture_output=True, text=True)
        if done.returncode:
            raise AssertionError(done.stderr)
        return done.stdout.strip()

    def sha(self, repo):
        return self.git(repo, "rev-parse", "HEAD")

    def commit(self, repo, name, text):
        (repo / name).parent.mkdir(parents=True, exist_ok=True)
        (repo / name).write_text(text)
        self.git(repo, "add", "-A")
        self.git(repo, "commit", "-q", "-m", name)
        return self.sha(repo)

    def publish(self, name="tools/fix.py", text="fix"):
        new = self.commit(self.other, name, text)
        self.git(self.other, "push", "-q", "origin", "master")
        return new

    def target(self, wanted):
        with mock.patch.object(rc, "_boot_problem", return_value=None):
            return rc._update_target(self.paths, self.op, self.head, [wanted])

    def test_plan_changes_nothing_and_the_fast_forward_lands_exactly_the_planned_commit(self):
        new = self.publish()
        self.assertEqual(self.target(new), (new, None))
        self.assertEqual(self.sha(self.op), self.head)                              # deciding touched no file
        self.assertFalse((self.op / "tools" / "fix.py").exists())
        self.assertIsNone(rc._fast_forward(self.paths, self.op, self.head, new))
        self.assertEqual(self.sha(self.op), new)

    def test_a_checkout_that_moved_after_planning_is_never_advanced(self):
        """Planned on master; while the previous instance was leaving, the checkout went to another clean branch of the
        same ancestor, or master itself moved. Neither is fast-forwarded."""
        new = self.publish()
        self.assertEqual(self.target(new), (new, None))
        self.git(self.op, "checkout", "-q", "-b", "side")
        self.assertIn("master 브랜치가 아닙니다", rc._fast_forward(self.paths, self.op, self.head, new))
        self.assertEqual((self.sha(self.op), self.git(self.op, "rev-parse", "master")), (self.head, self.head))
        self.assertFalse((self.op / "tools" / "fix.py").exists())
        self.git(self.op, "checkout", "-q", "master")
        moved = self.commit(self.op, "local.txt", "moved")
        self.assertIn("계획한 commit과 다릅니다", rc._fast_forward(self.paths, self.op, self.head, new))
        self.assertEqual(self.sha(self.op), moved)

    def test_refusals_leave_the_checkout_exactly_as_it_was(self):
        new = self.publish()
        (self.op / "pnpm-lock.yaml").write_text("local edit")
        self.assertIn("커밋되지 않은 변경", self.target(new)[1])
        self.git(self.op, "checkout", "-q", "--", "pnpm-lock.yaml")
        (self.op / "tools").mkdir()
        (self.op / "tools" / "fix.py").write_text("mine")                           # untracked, would be overwritten
        self.assertIn("추적되지 않는 파일", self.target(new)[1])
        self.assertIn("추적되지 않는 파일", rc._fast_forward(self.paths, self.op, self.head, new))   # re-checked right before the merge
        self.assertEqual(((self.op / "tools" / "fix.py").read_text(), self.sha(self.op)), ("mine", self.head))
        (self.op / "tools" / "fix.py").unlink()
        with mock.patch.object(rc, "_boot_problem", return_value="ImportError: x"):
            self.assertIn("기동 검증 실패", rc._update_target(self.paths, self.op, self.head, [new])[1])
        self.assertIn("origin/master에 없습니다", self.target("d" * 40)[1])
        locked = self.publish("pnpm-lock.yaml", "v2")
        self.assertIn("pnpm-lock.yaml", self.target(locked)[1])
        local = self.commit(self.op, "local.txt", "diverged")
        self.head = local
        self.assertIn("갈라져", self.target(locked)[1])
        self.assertEqual(self.sha(self.op), local)

    def test_boot_check_runs_the_target_commits_own_code_without_touching_the_checkout(self):
        pkg = "tools/warroom/warroom/"
        for name, text in (("__init__.py", ""), ("supervisor.py", ""), ("restart_controller.py", ""),
                           ("config.py", "class Paths: pass\ndef load_config(p): return {}\ndef config_problem(c): return None\n")):
            self.commit(self.other, pkg + name, text)
        good = self.sha(self.other)
        broken = self.commit(self.other, pkg + "supervisor.py", "def (:\n")
        rejected = self.commit(self.other, pkg + "supervisor.py", "")
        rejected = self.commit(self.other, pkg + "config.py",
                               "class Paths: pass\ndef load_config(p): return {}\ndef config_problem(c): return 'bad key'\n")
        self.git(self.other, "push", "-q", "origin", "master")
        self.git(self.op, "fetch", "-q", "origin", "master")
        self.paths.supervisor_state.mkdir(parents=True, exist_ok=True)
        self.assertIsNone(rc._boot_problem(self.paths, self.op, good))
        self.assertIn("SyntaxError", rc._boot_problem(self.paths, self.op, broken))
        self.assertIn("config.json: bad key", rc._boot_problem(self.paths, self.op, rejected))
        self.assertEqual(self.sha(self.op), self.head)
        self.assertFalse((self.op / "tools").exists())
        self.assertEqual(list(self.paths.supervisor_state.glob("preflight-*")), [])


class KwarEntry(unittest.TestCase):
    def world(self):
        from tests.test_issue_1555 import world
        w = world()
        self.addCleanup(w.tmp.cleanup)
        return w

    def run_replace(self, w, step, **consts):
        consts.setdefault("STARTUP_TIMEOUT", rc.STARTUP_TIMEOUT)
        with mock.patch.object(rc, "_head", return_value=HEAD1), \
             mock.patch.object(rc, "handle_pending_restart", side_effect=step), \
             mock.patch.object(rc, "_live_runtime_owner", return_value=True), \
             mock.patch.multiple(rc, **consts), \
             mock.patch.object(rc.time, "sleep"), mock.patch("builtins.print"):
            return rc._replace(w.paths)

    def test_exit_code_is_zero_only_for_a_verified_new_instance(self):
        w = self.world()
        rc.record_runtime(w.paths, HEAD1, instance="old")
        self.assertEqual(self.run_replace(w, lambda paths, store: rc.record_runtime(paths, HEAD1, instance="new")), 0)

        w = self.world()
        rc.record_runtime(w.paths, HEAD1, instance="old")
        refuse = lambda paths, store: rc.update_restart_request(paths, 0, "cancelled", blocker="현재 코드가 기동 검증에 실패")
        self.assertEqual(self.run_replace(w, refuse), 1)

        w = self.world()
        rc.record_runtime(w.paths, HEAD1, instance="old")                            # still the old instance: not a success
        self.assertEqual(self.run_replace(w, lambda paths, store: None, HANDOFF_GRACE=0, STARTUP_TIMEOUT=0), 2)

    def test_kwar_opens_the_tui_only_after_a_successful_replace(self):
        repo = Path(__file__).resolve().parents[3]
        for code in (0, 1, 2):
            with self.subTest(code=code), tempfile.TemporaryDirectory() as tmp:
                root = Path(tmp) / "root"
                (root / ".git").mkdir(parents=True)
                (root / "tools/warroom/prompts").mkdir(parents=True)
                (root / "tools/warroom/prompts/m.md").write_text("m")
                venv = root / "tools/warroom/.local/venv/bin"
                venv.mkdir(parents=True)
                log = Path(tmp) / "calls"
                (venv / "python").write_text(f'#!/bin/sh\necho "python $*" >> "{log}"\nexit {code}\n')
                fake = Path(tmp) / "bin"
                fake.mkdir()
                (fake / "tmux").write_text(f'#!/bin/sh\necho "tmux $*" >> "{log}"\n[ "$1" = has-session ] && exit 1\nexit 0\n')
                for script in (venv / "python", fake / "tmux"):
                    script.chmod(0o755)
                for name in ("war", "kwar"):
                    (root / name).write_text((repo / name).read_text())
                    (root / name).chmod(0o755)
                env = {"PATH": f"{fake}:/usr/bin:/bin", "HOME": tmp}
                done = subprocess.run(["/bin/sh", str(root / "kwar")], env=env, capture_output=True, text=True, timeout=30)
                calls = log.read_text().splitlines()
                self.assertEqual(done.returncode, code)
                self.assertEqual(calls[0], "python -m warroom.restart_controller --replace")
                self.assertEqual(any(c.startswith("tmux new-session") for c in calls), code == 0)
                self.assertFalse(any("kill" in c for c in calls))                   # nothing is killed by hand


class SerialSupervisorStopping(RestartWorld, unittest.TestCase):
    """workers=1: the same boundary as the Coordinator's - nothing new is dispatched or launched once STOPPING is recorded."""

    def stop(self, w):
        self.assertIsNotNone(w.store.cas_restart_phase(w.store.restart_phase(), "STOPPING", "r", stopping_at=1.0))

    def test_stopping_recorded_before_the_next_tick_dispatches_nothing(self):
        w = self.world(records=25)
        self.plan_all(w, [1])
        w.start("single", "deepseek", "d")
        self.stop(w)                                              # recorded while the serial loop was asleep
        with mock.patch.object(w.sup, "tick", wraps=w.sup.tick) as tick, mock.patch("warroom.supervisor.time.sleep"):
            w.sup.run_forever(interval=0.01)                      # returns: it left
        self.assertFalse(tick.called)
        self.assertEqual((w.adapter.launches, w.store.incomplete_batches()), ([], []))

    def test_stopping_recorded_during_a_tick_stops_the_remaining_lines_and_every_new_launch(self):
        w = self.world(records=25)
        self.plan_all(w, [1])
        w.start("single", "deepseek", "d")
        for name in ("aaa", "zzz"):
            w.store.line(name, "a")
        seen, real = [], w.sup._tick_line

        def tick_line(model, method):
            seen.append((model, method))
            if len(seen) == 1:
                self.stop(w)                                      # the Controller's CAS lands in the middle of the tick
            return real(model, method)
        with mock.patch.object(w.sup, "_tick_line", side_effect=tick_line), mock.patch("warroom.supervisor.time.sleep"):
            w.sup.run_forever(interval=0.01)
        self.assertEqual(len(seen), 1)                            # no further Line of that tick, and no further tick
        self.assertEqual(w.adapter.launches, [])

    def test_a_line_past_its_dispatch_check_claims_no_new_batch_and_starts_no_git_work(self):
        """STOPPING lands after the Line was dispatched and found runnable: the admission boundary of a NEW batch is the
        Store claim itself (one write lock with the Controller's CAS), with the Git work before it checked on the way."""
        for moment in ("_preflight", "fetch_base"):
            with self.subTest(stopping_recorded_during=moment):
                w = self.world(records=25)
                self.plan_all(w, [1])
                w.start("single", "deepseek", "d")
                owner = w.sup if moment == "_preflight" else w.sup.git
                real = getattr(owner, moment)

                def landed(*a, **k):
                    self.stop(w)
                    return real(*a, **k)
                with mock.patch.object(owner, moment, side_effect=landed) as hit, \
                     mock.patch.object(w.sup.git, "create_worktree") as worktree:
                    fetch = mock.patch.object(w.sup.git, "fetch_base", wraps=w.sup.git.fetch_base)
                    with (fetch if moment == "_preflight" else mock.MagicMock()) as fetched:
                        w.sup._tick_line_locked(*LINE)            # already past the dispatch-time check
                    self.assertTrue(hit.called)
                    if moment == "_preflight":
                        self.assertFalse(fetched.called)          # no Git work begins after STOPPING
                    self.assertFalse(worktree.called)
                self.assertEqual((w.store.incomplete_batches(), w.adapter.launches), ([], []))
                self.assertEqual(w.store.line(*LINE)["run"], 1)   # the reservation is kept for the next instance

    def test_an_existing_batch_is_still_claimed_normally_while_running(self):
        w = self.world(records=25)
        self.plan_all(w, [1])
        w.start("single", "deepseek", "d")
        w.tick()
        self.assertEqual((len(w.store.incomplete_batches()), len(w.adapter.launches)), (1, 1))

    def test_a_line_already_inside_its_tick_is_denied_the_launch_permit(self):
        w = self.world(records=25)
        self.plan_all(w, [1])
        w.start("single", "deepseek", "d")
        self.stop(w)
        try:
            w.sup._tick_line_locked(*LINE)                        # past every dispatch check: only the gate is left
        except LaunchDenied:
            pass
        self.assertEqual(w.adapter.launches, [])                  # STOPPING was read at the permit, before any spawn
        self.assertFalse(w.sup.launch_gate.is_open or w.sup.accepting_new_work())
        with self.assertRaises(LaunchDenied):
            with w.sup.launch_gate.permit():
                pass


class FinalizationBoundary(RestartWorld, unittest.TestCase):
    def test_a_chunk_that_ends_during_stopping_is_saved_and_finalized_exactly_once_by_the_next_instance(self):
        w = self.world(records=25)
        self.plan_all(w, [1])
        w.start("single", "deepseek", "d")
        self.drive.cycle()
        self.assertIsNotNone(w.store.cas_restart_phase(w.store.restart_phase(), "STOPPING", "r", stopping_at=1.0))
        self.drive.cycle()
        self.finish_task(w, "001")                                          # the AI ends while the instance is leaving
        self.drive.cycles(3)
        self.assertEqual((w.gh.created_prs, w.row_()["run_kind"]), ([], "d_parallel"))   # nothing was collected or written
        w.sup = w.make_sup()                                                # the next instance, same DB and worktree
        w.sup.begin_instance()
        for _ in range(6):
            w.tick()
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")
        self.assertEqual(len(w.gh.created_prs), 1)                          # exactly one Finalization, one PR
        self.assertEqual((w.row_()["state"], len(w.adapter.launches)), ("WAITING_REVIEW", 1))

    def test_a_started_finalization_continues_but_a_new_one_is_held_for_every_method(self):
        w = self.world(records=25)
        w.sup._drain.set()
        for name, kind in (("_c_finalize", "c_finalize"), ("_d_finalize", "d_finalize"), ("_ab_finalize", "ab_finalize"),
                           ("_stage2_finalize", "s2_deterministic_finalize"), ("_stage3_finalize", "s3_finalize")):
            with self.subTest(name), mock.patch.object(w.sup, "_guarded") as guarded:
                getattr(w.sup, name)({"id": 1, "run_kind": "something_else"})
                self.assertFalse(guarded.called)                             # held before any write
                getattr(w.sup, name)({"id": 1, "run_kind": kind})
                self.assertTrue(guarded.called)                              # started before STOPPING: run to completion
        with mock.patch.object(w.sup.git, "stage2_close_plan") as close:
            w.sup.s2p._finish({"id": 1, "run_kind": "s2_chunk_new"}, {})
            self.assertFalse(close.called)
        with mock.patch.object(w.store, "set") as put:
            w.sup.s3p._finish({"id": 1, "run_kind": "s3_chunk_new"})
            self.assertFalse(put.called)


class RestartPhaseCas(RestartWorld, unittest.TestCase):
    def test_stopping_at_is_written_once_and_stopping_never_returns_to_running(self):
        w = self.world(records=25)
        first = w.store.cas_restart_phase(w.store.restart_phase(), "STOPPING", "r", stopping_at=10.0)
        again = w.store.cas_restart_phase(first, "STOPPING", "r2", stopping_at=99.0)
        self.assertEqual((first["stopping_at"], again["stopping_at"], again["request"]), (10.0, 10.0, "r2"))
        self.assertIsNone(w.store.cas_restart_phase(first, "RUNNING", ""))            # a stale value never wins
        self.drive.cycles(2)
        self.assertEqual(self.phase(w), "STOPPING")
        self.assertFalse(w.sup.launch_gate.is_open)

    def test_an_earlier_instances_stopping_is_no_evidence_about_the_next_instance(self):
        w = self.world(records=25)
        w.store.cas_restart_phase(w.store.restart_phase(), "STOPPING", "r", stopping_at=1.0)
        self.fence.close()                                                           # that instance died ...
        w.sup = w.make_sup()                                                         # ... and a new one starts
        w.sup.begin_instance()
        self.assertEqual(self.phase(w), "RUNNING")
        self.assertNotIn("stopping_at", w.store.restart_phase())
        self.assertFalse(w.sup._stopping())
        self.assertTrue(w.sup.accepting_new_work())

    def test_restart_success_needs_a_new_instance_record_written_after_the_kill(self):
        old = {"instance": "a", "started_at": 100.0}
        self.assertFalse(rc._is_new_instance({"instance": "a", "started_at": 200.0}, old, 150.0))   # same instance
        self.assertFalse(rc._is_new_instance({"instance": "b", "started_at": 120.0}, old, 150.0))   # stale record
        self.assertTrue(rc._is_new_instance({"instance": "b", "started_at": 200.0}, old, 150.0))


class MaintainerDrainBoundary(unittest.TestCase):
    def test_collects_running_batch_without_advancing_other_prs_then_resumes(self):
        from tests.test_issue_1555 import world, produce_and_report, maintainer_row
        w = world()
        self.addCleanup(w.tmp.cleanup)
        produce_and_report(w)
        w.tick()
        a = maintainer_row(w)
        self.assertEqual(a["state"], "PRODUCING")
        with w.store._conn() as db:
            b_id = db.execute(
                "INSERT INTO batches(method,producer,shard,batch,branch,worktree,state,model_tier,created_at,updated_at) "
                "SELECT method,producer,shard,'102','maint-102',worktree,'MERGED',model_tier,created_at,updated_at "
                "FROM batches WHERE id=?", (a["id"],)).lastrowid
        w.pr_info(50, HEAD1, head_ref="maint-101")
        w.gh.by_branch["maint-101"] = [{"number": 50, "state": "OPEN", "headRefOid": HEAD1}]
        w.adapter.finish(a["pid"])
        launches = len(w.adapter.launches)
        w.sup._drain.set()
        with mock.patch.object(w.sup, "_to_cleanup", wraps=w.sup._to_cleanup) as cleanup, \
             mock.patch.object(w.sup, "_watch", wraps=w.sup._watch) as watch:
            w.sup._parallel_maintenance()
            self.assertEqual(w.store.batch(a["id"])["state"], "WAITING_REVIEW")
            self.assertEqual(w.store.batch(b_id)["state"], "MERGED")
            self.assertFalse(cleanup.called or watch.called)
            self.assertEqual(len(w.adapter.launches), launches)
        w.sup = w.make_sup()
        with mock.patch.object(w.sup, "_to_cleanup") as cleanup:
            w.sup._tick_maintenance()
            cleanup.assert_called_once()
            self.assertEqual(cleanup.call_args.args[0]["id"], b_id)

    def test_runtime_confirmation_requires_live_coherent_owner(self):
        from tests.test_issue_1555 import world
        w = world()
        self.addCleanup(w.tmp.cleanup)
        runtime = {"instance": "new", "pid": 123, "started_at": 200.0, "loaded_code_sha": HEAD1}
        old = {"instance": "old", "started_at": 100.0}
        w.store.begin_restart_phase("new")
        pane = lambda args, **kw: mock.Mock(returncode=0, stdout="0" if "#{pane_dead}" in args else "123")
        with mock.patch.object(rc, "_lock_held", return_value=True), \
             mock.patch.object(rc, "owner_state", return_value="alive"), \
             mock.patch.object(rc, "_tmux", side_effect=pane), \
             mock.patch.object(rc.os, "getpgid", return_value=123), \
             mock.patch.object(rc, "_pid_alive", return_value=True) as alive:
            self.assertTrue(rc._is_new_instance(runtime, old, 150.0))
            self.assertTrue(rc._live_runtime_owner(w.paths, w.store, runtime))
            alive.return_value = False
            self.assertFalse(rc._live_runtime_owner(w.paths, w.store, runtime))
            alive.return_value = True
            w.store.begin_restart_phase("other")
            self.assertFalse(rc._live_runtime_owner(w.paths, w.store, runtime))
            self.assertFalse(rc._is_new_instance({**runtime, "instance": "old"}, old, 150.0))


    def test_controller_confirms_only_fresh_live_instance(self):
        from tests.test_issue_1555 import world
        for case in ("live", "dead", "old"):
            with self.subTest(case=case):
                w = world()
                self.addCleanup(w.tmp.cleanup)
                rc.record_runtime(w.paths, HEAD2, instance="old")
                request = rc.write_restart_request(w.paths, {"id": 91, "merge_sha": HEAD1}, None)
                launched = []
                def tmux(args, **kw):
                    if args[0] == "new-session":
                        launched.append(True)
                        instance = "old" if case == "old" else "new"
                        w.store.begin_restart_phase(instance)
                        rc.record_runtime(w.paths, HEAD1, instance=instance)
                    if args[0] in ("show-environment", "has-session"):
                        return mock.Mock(returncode=1, stdout="")
                    return mock.Mock(returncode=0, stdout="0" if "#{pane_dead}" in args else str(os.getpid()))
                with mock.patch.object(rc, "_git", return_value=mock.Mock(returncode=0, stdout=HEAD1)), \
                     mock.patch.object(rc, "_ancestor", side_effect=lambda root, older, newer: newer == HEAD1), \
                     mock.patch.object(rc, "_lock_held", side_effect=lambda _: bool(launched) and case != "dead"), \
                     mock.patch.object(rc, "_pid_alive", return_value=case != "dead"), \
                     mock.patch.object(rc, "owner_state", return_value="alive"), \
                     mock.patch.object(rc, "_tmux", side_effect=tmux), \
                     mock.patch.object(rc, "STARTUP_TIMEOUT", 0.01), \
                     mock.patch.object(rc.time, "sleep"):
                    rc.handle_pending_restart(w.paths, w.store)
                result = json.loads(request.read_text())
                self.assertEqual(result["state"], "loaded" if case == "live" else "waiting")
                if case == "live":
                    self.assertEqual((result["loaded_code_sha"], result["supervisor_instance"], result["supervisor_pid"]),
                                     (HEAD1, "new", os.getpid()))


    def test_startup_timeout_then_next_call_records_verified_owner(self):
        from tests.test_issue_1555 import world
        w = world()
        self.addCleanup(w.tmp.cleanup)
        request = rc.write_restart_request(w.paths, {"id": 91, "merge_sha": HEAD1}, None)
        rc.update_restart_request(w.paths, 91, "waiting", requested_restart_at=100.0,
                                  previous_instance="old", blocker="starting")
        w.store.begin_restart_phase("new")
        rc.record_runtime(w.paths, HEAD1, instance="new")
        def tmux(args, **kw):
            return mock.Mock(returncode=0, stdout="0" if "#{pane_dead}" in args else str(os.getpid()))
        with mock.patch.object(rc, "_git", return_value=mock.Mock(returncode=0, stdout=HEAD1)), \
             mock.patch.object(rc, "_ancestor", return_value=True), \
             mock.patch.object(rc, "_lock_held", return_value=True), \
             mock.patch.object(rc, "_pid_alive", return_value=True), \
             mock.patch.object(rc, "owner_state", return_value="alive"), \
             mock.patch.object(rc, "_tmux", side_effect=tmux):
            rc.handle_pending_restart(w.paths, w.store)
        result = json.loads(request.read_text())
        self.assertEqual((result["state"], result["loaded_code_sha"], result["supervisor_pid"],
                          result["supervisor_instance"], result["blocker"]),
                         ("loaded", HEAD1, os.getpid(), "new", None))


class CoordinatorDetails(RestartWorld, unittest.TestCase):
    def test_stopping_never_selects_a_new_batch_or_runs_the_maintainer_step(self):
        w = self.world(records=25)
        w.start("single", "deepseek", "d")
        w.sup._drain.set()
        w.tick()
        self.assertEqual(w.store.incomplete_batches(), [])                          # no new batch was selected
        with mock.patch.object(w.sup, "_tick_maintenance") as collect, mock.patch.object(w.sup.maint, "step") as step:
            w.sup._parallel_maintenance()
        self.assertTrue(collect.called)
        self.assertFalse(step.called)

    def test_close_is_non_blocking_and_denial_is_immediate(self):
        gate = LaunchGate()
        entered, release = threading.Event(), threading.Event()

        def hold():
            with gate.permit():
                entered.set()
                release.wait(5)
        t = threading.Thread(target=hold)
        t.start()
        self.assertTrue(entered.wait(5))
        gate.begin_close()                                # returns at once although a permit is active
        self.assertFalse(gate.drained)
        with self.assertRaises(LaunchDenied):
            with gate.permit():
                pass
        release.set()
        t.join(5)
        self.assertTrue(gate.drained)
        gate.end_close()
        gate.open()
        with gate.permit():
            pass

    def test_a_long_job_is_logged_once(self):
        w = self.world(records=25)
        w.sup._interval = 0.0
        w.store.line("slow", "a")
        release = threading.Event()
        with mock.patch.object(w.sup, "_tick_line", side_effect=lambda *a: release.wait(10)):
            self.drive.cycle(wait_workers=False)
            for _ in range(3):
                self.drive.cycle(wait_workers=False)
            release.set()
            wait(list(self.drive.pending.values()), timeout=10)
        self.assertEqual(sum("2×interval" in e["msg"] and "slow/a" in e["msg"] for e in w.store.recent_events()), 1)

    def test_main_scans_fences_and_records_the_actual_workers_before_the_first_dispatch(self):
        import warroom.supervisor as sv
        order = []
        w = self.world(records=25)
        w.cfg["supervisor_workers"] = 16

        class FakeFence:
            def __init__(self, *a, **k):
                pass

            def open(self):
                return self

            def scan_previous(self):
                order.append("scan")

            def drain_reports(self):
                return []

        class FakeSup:
            cfg, code_sha, phase_instance, store = w.cfg, HEAD2, "inst-x", w.store

            def begin_instance(self):
                order.append("phase")

            def run_parallel(self, **kw):
                order.append("dispatch")

        def build(paths, fence):
            order.append("build")
            return FakeSup()
        recorded = {}
        with mock.patch("warroom.config.check_runtime_root", return_value=w.paths.repo_root), \
             mock.patch.object(sv, "acquire_lock", return_value=mock.Mock()), \
             mock.patch.object(sv, "build", side_effect=build), \
             mock.patch("warroom.fence.Fence", FakeFence), \
             mock.patch("warroom.config.Paths", return_value=w.paths), \
             mock.patch("warroom.restart_controller.record_runtime",
                        side_effect=lambda *a, **k: (order.append("runtime"), recorded.update(k))):
            self.assertEqual(sv.main(), 0)
        self.assertEqual(order, ["scan", "build", "phase", "runtime", "dispatch"])
        self.assertEqual((recorded["workers"], recorded["instance"]), (16, "inst-x"))


if __name__ == "__main__":
    unittest.main()
