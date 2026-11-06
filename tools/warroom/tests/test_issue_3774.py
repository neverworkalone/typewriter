"""#3774: a Restart of a parallel Supervisor passes RUNNING -> DRAINING -> READY -> STOPPING by Store CAS.

Event-based: a real D parallel batch (the common fixture of #3074) is driven through the Coordinator's own cycle with a
real thread pool; Workers are held/released with Events, AI exits are produced by the fake adapter."""
import json
import os
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path
from unittest import mock

from tests.fakes import HEAD1, HEAD2
from tests.test_issue_3074 import ParallelDHelpers
from warroom import restart_controller as rc
from warroom.fence import Fence
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


class DrainCollectsThenReady(RestartWorld, unittest.TestCase):
    def test_running_ai_is_collected_and_saved_while_draining_then_ready_with_no_new_spawn(self):
        w = self.world()
        self.plan_all(w, range(1, 11))
        w.start("single", "deepseek", "d")
        self.drive.cycle()                                    # 8 of 10 chunks run; two are queued
        self.assertEqual(len(w.adapter.launches), 8)
        self.request(w)
        self.drive.cycle()
        self.assertEqual(self.phase(w), "DRAINING")
        self.assertFalse(w.sup.launch_gate.is_open)           # admission is closed; the AI already running is not killed
        self.assertFalse(w.sup.accepting_new_work())
        self.finish_task(w, "001")                            # first exit: collected and saved, the queued chunk is NOT started
        self.drive.cycle()
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")
        self.assertEqual(len(w.adapter.launches), 8)
        self.assertEqual(self.phase(w), "DRAINING")
        # the lane was denied a new launch, yet the other seven running tasks are still collected (frozen != skipped)
        self.assertIn(LINE, w.sup._frozen_lanes)
        for n in range(2, 9):
            self.finish_task(w, f"{n:03d}")
        self.drive.cycles(2)
        self.assertEqual({t: r["state"] for t, r in self.tasks(w).items() if int(t) <= 8}, {f"{n:03d}": "SAVED" for n in range(1, 9)})
        self.assertEqual(self.phase(w), "READY")
        self.assertEqual(len(w.adapter.launches), 8)          # zero new AI spawn through the whole drain
        self.assertEqual(self.open_runs(w), [])
        # READY submits nothing at all
        with mock.patch.object(w.sup, "_tick_line") as tick, mock.patch.object(w.sup, "_parallel_maintenance") as maint:
            self.drive.cycles(3)
        self.assertFalse(tick.called or maint.called)

    def test_ready_needs_the_worker_to_finish_even_when_no_ai_is_running(self):
        """A deterministic Worker (e.g. a long verify) keeps the Supervisor out of READY; the Controller cannot kill."""
        w = self.world(records=25)
        w.store.line(*LINE)
        started, release = threading.Event(), threading.Event()

        def verify(model, method):
            started.set()
            self.assertTrue(release.wait(10))
        with mock.patch.object(w.sup, "_tick_line", side_effect=verify):
            self.drive.cycle(wait_workers=False)
            self.assertTrue(started.wait(5))
            self.request(w)
            self.drive.cycle(wait_workers=False)
            self.assertEqual(self.phase(w), "DRAINING")
            self.assertEqual(self.open_runs(w) if w.store.incomplete_batches() else [], [])    # zero AI anywhere
            killed = self.controller(w)
            self.assertEqual(killed["kill"], 0)
            self.assertEqual(self.phase(w), "DRAINING")
            self.assertIn("READY", json.loads(self.request(w).read_text())["blocker"])
            release.set()
            wait(list(self.drive.pending.values()), timeout=10)
        self.drive.cycle()
        self.assertEqual(self.phase(w), "READY")
        killed = self.controller(w)
        self.assertEqual((killed["kill"], self.phase(w)), (1, "STOPPING"))

    def ready_world(self):
        w = self.world(records=25)
        self.plan_all(w, [1])
        w.start("single", "deepseek", "d")
        self.drive.cycle()
        self.finish_task(w, "001")
        self.request(w)
        self.drive.cycles(4)
        self.assertEqual(self.phase(w), "READY")
        return w

    def test_a_withdrawal_or_new_request_right_after_the_ready_check_stops_the_kill(self):
        for name, race in (("withdrawn", lambda w: rc.update_restart_request(w.paths, 91, "cancelled")),
                           ("changed set", lambda w: self.request(w, defect=92))):
            with self.subTest(name):
                w = self.ready_world()
                self.fence_ok = True
                fired = []

                def ownership(*a, **k):      # runs after _ready_problem() read the identity, before the decision
                    if not fired:
                        fired.append(1)
                        race(w)
                state = self.controller(w, ownership)
                self.assertEqual((state["kill"], self.phase(w)), (0, "READY"))     # no STOPPING, no kill
                if name == "withdrawn":
                    self.assertEqual(json.loads(self.request(w).read_text())["state"], "cancelled")   # not overwritten
                self.drive.cycle()                                                # the Coordinator then decides on its own
                self.assertIn(self.phase(w), ("RUNNING", "READY"))

    # -- the real Controller against the real phase/fence/runtime files, with only tmux/Git/ps mocked ------------------
    def controller(self, w, ownership=None):
        paths, store = w.paths, w.store
        rc.record_runtime(paths, HEAD2, configured_workers=16, workers=16, instance=w.sup.phase_instance)
        paths.runtime_root_file.write_text(str(paths.repo_root.resolve()), "utf-8")
        state = {"kill": 0, "alive": True}

        def lock_held(_path):
            return state["alive"]

        def tmux(args, **kw):
            if args[0] == "kill-session":
                state["kill"] += 1
                state["alive"] = False
            if args[0] == "new-session":
                rc.record_runtime(paths, HEAD1, configured_workers=16, workers=16, instance="next-instance")
            out = {"display-message": str(os.getpid()) if "#{pane_pid}" in args else "0"}.get(args[0], "")
            return mock.Mock(returncode=1 if args[0] == "show-environment" else 0, stdout=out)

        head = mock.Mock(returncode=0, stdout=HEAD1)
        with mock.patch.object(rc, "_git", return_value=head), \
             mock.patch.object(rc, "_ancestor", side_effect=lambda root, older, newer: newer == HEAD1), \
             mock.patch.object(rc, "_worktree_ownership_problem", side_effect=ownership or (lambda *a, **k: None)), \
             mock.patch.object(rc, "_lock_held", side_effect=lock_held), \
             mock.patch.object(rc, "_pid_alive", return_value=True), \
             mock.patch.object(rc, "STARTUP_TIMEOUT", 2), \
             mock.patch.object(rc.os, "getpgid", return_value=1), \
             mock.patch.object(rc, "_tmux", side_effect=tmux), \
             mock.patch.object(rc.time, "sleep"):
            rc.handle_pending_restart(paths, store)
        return state


class FrozenLaneDoesNotBlockOtherTasks(RestartWorld, unittest.TestCase):
    def test_cancel_releases_only_the_frozen_lanes_this_drain_made(self):
        w = self.world(records=25)
        self.plan_all(w, [1])
        w.start("single", "deepseek", "d")
        self.drive.cycle()
        request = self.request(w)
        self.drive.cycle()
        self.assertEqual(self.phase(w), "DRAINING")
        w.sup._freeze(("older", "x"))                    # same closed gate, same drain: tagged with this drain's seq
        w.sup._frozen_lanes.add(("foreign", "y"))        # frozen by something that is not provably this drain
        w.sup._frozen_seq[("foreign", "y")] = None
        request.unlink()                                 # the request is withdrawn
        self.drive.cycle()
        self.assertEqual(self.phase(w), "RUNNING")
        self.assertTrue(w.sup.launch_gate.is_open and w.sup.accepting_new_work())
        self.assertNotIn(("older", "x"), w.sup._frozen_lanes)
        self.assertIn(("foreign", "y"), w.sup._frozen_lanes)          # not wiped wholesale; the reason is logged
        self.assertTrue(any("frozen 유지" in e["msg"] for e in w.store.recent_events()))


class FinalizationBoundary(RestartWorld, unittest.TestCase):
    def test_last_chunk_saved_then_drain_holds_and_the_next_instance_finalizes_exactly_once(self):
        w = self.world(records=25)
        self.plan_all(w, [1])
        w.start("single", "deepseek", "d")
        self.drive.cycle()
        self.request(w)
        self.drive.cycle()
        self.assertEqual(self.phase(w), "DRAINING")
        self.finish_task(w, "001")
        self.drive.cycles(3)
        b = w.row_()
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")           # the last chunk is saved ...
        self.assertEqual((w.gh.created_prs, b["run_kind"]), ([], "d_parallel"))   # ... and Finalization has written nothing
        self.assertEqual(self.phase(w), "READY")
        w.sup = w.make_sup()                                                # the next instance, same DB and worktree
        w.sup.begin_instance()
        w.tick(3)
        w.tick(3)
        self.assertEqual(len(w.gh.created_prs), 1)                          # exactly one Finalization, one PR
        self.assertEqual(w.row_()["state"], "WAITING_REVIEW")

    def test_a_started_finalization_continues_but_a_new_one_is_held_for_every_method(self):
        w = self.world(records=25)
        w.sup._drain.set()
        for name, kind in (("_c_finalize", "c_finalize"), ("_d_finalize", "d_finalize"), ("_ab_finalize", "ab_finalize"),
                           ("_stage2_finalize", "s2_deterministic_finalize"), ("_stage3_finalize", "s3_finalize")):
            with self.subTest(name), mock.patch.object(w.sup, "_guarded") as guarded:
                getattr(w.sup, name)({"id": 1, "run_kind": "something_else"})
                self.assertFalse(guarded.called)                             # held before any write
                getattr(w.sup, name)({"id": 1, "run_kind": kind})
                self.assertTrue(guarded.called)                              # started before the drain: run to completion
        with mock.patch.object(w.sup.git, "stage2_close_plan") as close:
            w.sup.s2p._finish({"id": 1, "run_kind": "s2_chunk_new"}, {})
            self.assertFalse(close.called)
        with mock.patch.object(w.store, "set") as put:
            w.sup.s3p._finish({"id": 1, "run_kind": "s3_chunk_new"})
            self.assertFalse(put.called)


class RestartPhaseCas(RestartWorld, unittest.TestCase):
    def ready(self, w):
        self.plan_all(w, [1])
        w.start("single", "deepseek", "d")
        self.drive.cycle()
        self.finish_task(w, "001")
        self.request(w)
        self.drive.cycles(4)
        self.assertEqual(self.phase(w), "READY")

    def test_controller_wins_ready_to_stopping_and_the_cancel_loses_for_good(self):
        w = self.world(records=25)
        self.ready(w)
        cur = w.store.restart_phase()
        self.assertIsNotNone(w.store.cas_restart_phase(cur, "STOPPING", cur["request"]))
        self.assertEqual(w.sup._cancel_restart(cur, "late cancel"), "none")        # the stale READY loses
        self.assertEqual(self.phase(w), "STOPPING")
        self.request(w).unlink()
        self.drive.cycles(2)
        self.assertEqual(self.phase(w), "STOPPING")                                 # STOPPING never returns to RUNNING
        self.assertFalse(w.sup.launch_gate.is_open)

    def test_exactly_one_of_stopping_and_cancel_wins_a_real_race(self):
        for _ in range(20):
            w = self.world(records=25)
            self.addCleanup(w.tmp.cleanup)
            w.store.begin_restart_phase(w.sup.phase_instance)
            cur = w.store.cas_restart_phase(w.store.restart_phase(), "READY", "r")
            barrier, wins = threading.Barrier(2), []

            def go(target):
                barrier.wait(5)
                wins.append((target, w.store.cas_restart_phase(cur, target, "r" if target == "STOPPING" else "") is not None))
            threads = [threading.Thread(target=go, args=(t,)) for t in ("STOPPING", "RUNNING")]
            [t.start() for t in threads]
            [t.join(5) for t in threads]
            self.assertEqual(sum(ok for _, ok in wins), 1)
            self.assertEqual(self.phase(w), next(t for t, ok in wins if ok))

    def test_cancel_returns_to_running_and_reopens_the_gate(self):
        w = self.world(records=25)
        self.ready(w)
        self.request(w).unlink()
        self.drive.cycle()
        self.assertEqual(self.phase(w), "RUNNING")
        self.assertTrue(w.sup.launch_gate.is_open and w.sup.accepting_new_work())
        self.assertFalse(w.sup._submit_hold)

    def test_a_new_operator_drain_or_defect_hold_cancels_instead_of_waiting_forever(self):
        for revoke in (lambda w: w.store.request_drain(*LINE, True),
                       lambda w: w.store.set(f"defect_hold_{w.row_()['id']}", "1")):
            w = self.world(records=25)
            self.ready(w)
            revoke(w)
            self.drive.cycle()
            self.assertEqual(self.phase(w), "RUNNING")

    def test_stop_before_ready_is_processed_and_stop_after_ready_is_handed_to_the_next_supervisor(self):
        w = self.world(records=25)
        self.plan_all(w, [1])
        w.start("single", "deepseek", "d")
        w.store.line("idle", "a")
        self.drive.cycle()
        self.finish_task(w, "001")
        w.store.set_line("idle", "a", force_stop=1)                                  # accepted during the drain
        self.request(w)
        self.drive.cycles(4)
        self.assertEqual(self.phase(w), "READY")
        self.assertEqual(w.store.line("idle", "a")["force_stop"], 0)                  # consumed before READY
        w.store.set_line("idle", "a", force_stop=1)                                  # accepted after READY
        with mock.patch.object(w.sup, "_tick_line") as tick:
            self.drive.cycles(2)
        self.assertFalse(tick.called)
        self.assertEqual((self.phase(w), w.store.line("idle", "a")["force_stop"]), ("READY", 1))
        self.assertIsNone(rc._ready_problem(w.paths, w.store, {"instance": w.sup.phase_instance}, [])[0])   # not a blocker
        w.sup = w.make_sup()
        w.sup.begin_instance()
        w.tick()
        self.assertEqual(w.store.line("idle", "a")["force_stop"], 0)                  # the new Supervisor carries it out

    def test_an_earlier_instances_ready_is_no_evidence_about_the_next_instance(self):
        w = self.world(records=25)
        self.ready(w)
        old = w.sup.phase_instance
        runtime = {"instance": old, "supervisor_workers": 16}
        self.assertIsNone(rc._ready_problem(w.paths, w.store, runtime, [])[0])
        self.fence.close()                                                           # that instance died ...
        self.assertIn("not running", rc._ready_problem(w.paths, w.store, runtime, [])[0])
        w.sup = w.make_sup()                                                         # ... and a new one starts
        w.sup.begin_instance()
        problem = rc._ready_problem(w.paths, w.store, {"instance": w.sup.phase_instance}, [])[0]
        self.assertIsNotNone(problem)
        self.assertEqual(self.phase(w), "RUNNING")

    def test_a_missing_or_damaged_runtime_record_never_takes_the_serial_shortcut(self):
        self.assertFalse(rc._is_serial_runtime(None))
        self.assertFalse(rc._is_serial_runtime({"supervisor_workers": "1"}))
        self.assertFalse(rc._is_serial_runtime({}))
        self.assertTrue(rc._is_serial_runtime({"supervisor_workers": 1}))

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
            self.assertFalse(w.sup._lane_has_drain_work(None))
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
                     mock.patch.object(rc, "_worktree_ownership_problem", return_value=None), \
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
    def test_draining_never_selects_a_new_batch_or_runs_the_maintainer_step(self):
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
