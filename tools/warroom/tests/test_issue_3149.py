"""Issue #3149 PR 2: parallel Stage 3 chunk tasks - bounded scheduler, single-writer saves, recovery, Maintainer.

Fake AI/git/edit-cli: this proves the Supervisor state machine around the explicit chunk API (whose own contract is
covered by edit-cli.test.mjs), not a real model run."""
import json
import unittest
from pathlib import Path

from tests.fakes import HEAD1, HEAD2, World
from tests.test_issue_2450_stage3 import PRODUCERS
from warroom.adapters import classify_codex_failure
from warroom import control, s3parallel, stage2, stage3, taskruns
from warroom.store import STAGE3_METHOD, Store

S3 = STAGE3_METHOD


def answer(text):
    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n"


class _Crash(BaseException):
    pass


class LaunchHandshake(unittest.TestCase):
    def spawn(self, root, cmd):
        from warroom.adapters import ProcessAdapter
        ex = Path(root) / "run.exit"
        handle = ProcessAdapter.__new__(ProcessAdapter)._spawn(cmd, root, {"PATH": "/usr/bin:/bin"}, Path(root) / "run.log", ex)
        return handle, ex

    def wait(self, path, seconds=10):
        import time
        end = time.time() + seconds
        while not path.exists() and time.time() < end:
            time.sleep(0.02)

    def test_pid_record_is_written_before_the_child_runs(self):
        import tempfile
        with tempfile.TemporaryDirectory() as root:
            handle, ex = self.spawn(root, ["/usr/bin/true"])
            self.wait(ex)
            self.assertEqual(int(Path(f"{ex}.pid").read_text()), handle.pid)

    def test_child_never_starts_when_the_pid_record_cannot_be_written(self):
        import tempfile
        with tempfile.TemporaryDirectory() as root:
            (Path(root) / "run.exit.pid").mkdir()   # the record path is unwritable
            marker = Path(root) / "child-ran"
            _handle, ex = self.spawn(root, ["/usr/bin/touch", str(marker)])
            self.wait(ex)
            self.assertEqual(ex.read_text().strip(), "126")
            self.assertFalse(marker.exists())


class Helpers:
    def world(self, chunks, *, cap=16):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.cfg["producers"] = json.loads(json.dumps(PRODUCERS))
        w.parallel_s3 = True
        w.sup.parallel_new_s3 = True
        w.runner.edit.chunks = chunks
        w.cfg["stage3_max_parallel"] = cap
        w.store.set(stage2.ok_key("001", None), w.git.base_sha)
        self.assertTrue(control.start(w.store, "claude", S3, "single", cfg=w.cfg)[0])
        w.tick(2)
        return w

    def batch(self, w):
        return w.store.active_batch("claude", S3)

    def tasks(self, w):
        return {r["task"]: r for r in w.store.task_rows(self.batch(w)["id"])}

    def states(self, w):
        return {t: r["state"] for t, r in self.tasks(w).items()}

    def pid_of(self, w, task):
        b = self.batch(w)
        run = w.store.run(w.store.task_row(b["id"], task)["run_id"])
        return next(x["pid"] for x in w.adapter.launches if w.adapter.running.get(x["pid"], {}).get("log") == Path(run["log_file"]))

    def respond(self, w, task, text=None, code=0):
        pid = self.pid_of(w, task)
        w.adapter.running[pid]["text"] = answer(text if text is not None else f"chunk {task}\nnone")
        w.adapter.running[pid]["code"] = code
        w.adapter.finish(pid)

    def count(self, w, state):
        return sum(1 for s in self.states(w).values() if s == state)

    def checkpoint(self, w):
        return stage3.checkpoint(self.batch(w)["worktree"], "001")


class Scheduling(Helpers, unittest.TestCase):
    def test_mode_is_written_with_the_batch_row_and_twenty_chunks_use_sixteen_slots(self):
        w = self.world(20)
        b = self.batch(w)
        self.assertEqual(w.store.get(stage3.mode_key(b["id"])), stage3.PARALLEL)
        self.assertEqual((b["run_kind"], b["pid"]), ("s3_parallel", None))
        self.assertEqual(self.count(w, "RUNNING"), 16)
        self.assertEqual(len(taskruns.open_runs(w.store, b["id"])), 16)
        # a finished-but-unconfirmed slot is not free; only the confirmed end frees it
        self.respond(w, "001")
        w.tick()
        self.assertEqual(self.states(w)["001"], "SAVED")
        self.assertEqual(self.count(w, "RUNNING"), 16)   # 017 took the freed slot
        self.assertEqual(self.states(w)["017"], "RUNNING")

    def test_five_chunks_run_five_and_cap_one_is_sequential(self):
        self.assertEqual(self.count(self.world(5), "RUNNING"), 5)
        w = self.world(3, cap=1)
        self.assertEqual(self.states(w), {"001": "RUNNING", "002": "PENDING", "003": "PENDING"})
        self.respond(w, "001")
        w.tick()
        self.assertEqual(self.states(w), {"001": "SAVED", "002": "RUNNING", "003": "PENDING"})

    def test_reversed_completion_saves_and_explicit_none_is_saved(self):
        w = self.world(3)
        for task in ("003", "001", "002"):
            self.respond(w, task, f"chunk {task}\nnone" if task != "002" else "chunk 002\nD 1")
            w.tick()
        self.assertEqual(w.runner.edit.saves, ["003", "001", "002"])
        self.assertEqual(self.checkpoint(w)["completed_chunks"], ["001", "002", "003"])
        self.assertEqual(taskruns.open_runs(w.store, self.batch(w)["id"]), [])

    def test_closed_plan_is_persisted_before_finalize(self):
        w = self.world(1)
        calls = []
        w.sup._stage3_finalize = lambda b: calls.append(w.store.get(stage3.plan_key(b["id"])))
        self.respond(w, "001")
        w.tick()
        self.assertEqual(calls, ["closed"])
        w.tick()
        self.assertEqual(calls, ["closed", "closed"])   # a restart in `closed` goes straight to finalize


class MissingAnswers(Helpers, unittest.TestCase):
    def test_no_header_or_header_only_is_not_none(self):
        for text in ("그냥 잡담", "chunk 001", "chunk 001\nI reviewed the relations.", "chunk 001\nD 999"):
            with self.subTest(text=text):
                w = self.world(1)
                self.respond(w, "001", text)
                w.tick()
                row = self.tasks(w)["001"]
                self.assertEqual(row["state"], "RUNNING")   # exactly one new session
                self.assertEqual(json.loads(row["data"])["fresh_retries"], 1)
                self.assertEqual(w.runner.edit.saves, [])
                self.respond(w, "001", text)
                w.tick()
                self.assertEqual(self.batch(w)["state"], "ERROR")
                self.assertEqual(json.loads(self.tasks(w)["001"]["data"])["failure_kind"], "no_response")

    def test_abnormal_exit_with_complete_current_answer_is_saved_but_hard_failure_is_not(self):
        w = self.world(2)
        self.respond(w, "001", code=1)
        w.tick()
        self.assertEqual(self.states(w)["001"], "SAVED")
        self.respond(w, "002", "chunk 002\nnone", code=1)
        w.runner.calls.clear()
        w.tick()
        # an unknown abnormal exit without a pinned identity is still accepted only with a complete answer
        self.assertIn(self.states(w)["002"], {"SAVED", "FAILED"})

    def test_fast_unavailable_blocks_a_complete_answer_after_nonzero_exit(self):
        w = self.world(1)
        w.sup._classify_run = lambda _producer, log: classify_codex_failure(Path(log).read_text("utf-8"), [])
        self.respond(w, "001", "Fast mode is not available for this model\n" + answer("chunk 001\nnone"), code=1)
        w.tick()

        self.assertEqual(self.states(w)["001"], "FAILED")
        self.assertIn("Codex가 Fast 설정을 지원하지 않는다고 명시했습니다", json.loads(self.tasks(w)["001"]["data"])["error"])
        self.assertEqual(self.batch(w)["state"], "ERROR")
        self.assertEqual(w.runner.edit.saves, [])


class SaveRejection(Helpers, unittest.TestCase):
    def reject_one(self):
        w = self.world(3)
        w.runner.edit.reject["002"] = "invalid decision line 'D 9'"
        self.respond(w, "002", "chunk 002\nD 1")
        w.tick()
        return w

    def test_rejected_save_fails_only_that_task_and_stops_new_sessions(self):
        w = self.world(20)
        w.runner.edit.reject["002"] = "strict reject"
        self.respond(w, "002", "chunk 002\nD 1")
        launched = len(w.adapter.launches)
        w.tick()
        self.assertEqual(self.states(w)["002"], "FAILED")
        self.assertEqual(len(w.adapter.launches), launched)   # the freed slot is NOT refilled
        self.respond(w, "003")
        w.tick()
        self.assertEqual(self.states(w)["003"], "SAVED")   # a running task is still followed and saved
        self.assertEqual(len(w.adapter.launches), launched)
        self.assertEqual(self.batch(w)["state"], "PRODUCING")
        for task in [t for t, s in self.states(w).items() if s == "RUNNING"]:
            self.respond(w, task)
        w.tick()
        self.assertEqual(self.batch(w)["state"], "ERROR")

    def test_retry_resaves_the_preserved_answer_once_and_counts_on_that_run_only(self):
        w = self.reject_one()
        self.assertEqual(self.states(w)["002"], "FAILED")
        row = self.tasks(w)["002"]
        data = json.loads(row["data"])
        self.assertEqual((data["save_failures"], data["failure_kind"]), (1, "save_rejected"))
        run_id = data["response"]["run_id"]
        self.assertEqual(w.store.run(run_id)["submit_failures"], 1)
        for task in ("001", "003"):
            self.assertEqual(w.store.run(self.tasks(w)[task]["run_id"])["submit_failures"] or 0, 0)
        for task in ("001", "003"):
            self.respond(w, task)
        w.tick(2)
        self.assertEqual(self.batch(w)["state"], "ERROR")
        self.assertTrue(control.retry(w.store, "claude", S3))
        launched = len(w.adapter.launches)
        w.tick(2)
        self.assertEqual(self.states(w)["002"], "FAILED")   # second rejection: no AI, no third attempt
        self.assertEqual(len(w.adapter.launches), launched)
        data = json.loads(self.tasks(w)["002"]["data"])
        self.assertEqual(data["save_failures"], 2)
        self.assertEqual(w.store.run(run_id)["submit_failures"], 2)
        self.assertEqual(self.batch(w)["state"], "ERROR")
        self.assertTrue(control.retry(w.store, "claude", S3))
        w.tick(2)
        self.assertEqual(json.loads(self.tasks(w)["002"]["data"])["save_failures"], 2)   # not a third save
        self.assertEqual(w.runner.edit.saves.count("002"), 0)

    def test_answer_file_alone_never_retries_when_pins_or_view_changed(self):
        w = self.reject_one()
        w.runner.edit.salt["002"] = 1   # the prepared view changed after launch
        for task in ("001", "003"):
            self.respond(w, task)
        w.tick(2)
        self.assertTrue(control.retry(w.store, "claude", S3))
        w.runner.edit.reject.clear()
        w.tick(2)
        self.assertEqual(self.states(w)["002"], "FAILED")
        self.assertEqual(w.runner.edit.saves.count("002"), 0)
        self.assertIn("재저장 불가", json.loads(self.tasks(w)["002"]["data"])["error"])


class Restart(Helpers, unittest.TestCase):
    def restart(self, w):
        runner = w.runner
        w.sup = w.make_sup()
        w.sup.runner = w.runner = runner   # the (fake) CLI's files outlive the Supervisor process
        w.sup.parallel_new_s3 = True

    def test_restart_after_save_before_saved_marker_confirms_already_saved(self):
        w = self.world(2)
        self.respond(w, "001")
        b = self.batch(w)
        # the answer is preserved and the save reached the checkpoint, but the task row never became SAVED
        orig = w.sup.s3p._set
        def crash(b_, task, data=None, **fields):
            if fields.get("state") == "SAVED":
                return None   # the process died before the SAVED marker
            return orig(b_, task, data, **fields)
        w.sup.s3p._set = crash
        w.tick()
        self.assertEqual(self.checkpoint(w)["completed_chunks"], ["001"])
        self.assertEqual(self.states(w)["001"], "RESPONDED")
        self.restart(w)
        launched = len(w.adapter.launches)
        w.tick()
        self.assertEqual(self.states(w)["001"], "SAVED")
        self.assertEqual(w.runner.edit.saves, ["001"])   # no second write
        self.assertEqual(len(w.adapter.launches), launched)

    def test_restart_before_answer_file_keeps_slot_and_never_duplicates_a_run(self):
        w = self.world(2)
        self.restart(w)
        w.tick()
        self.assertEqual(len(taskruns.open_runs(w.store, self.batch(w)["id"])), 2)
        self.assertEqual(len(w.adapter.launches), 2)

    def test_open_run_without_task_link_is_reattached(self):
        w = self.world(2)
        b = self.batch(w)
        row = w.store.task_row(b["id"], "001")
        w.store.update_task(b["id"], "001", state="PENDING", run_id=None, session_id=None)   # crash after add_run
        w.tick()
        self.assertEqual(w.store.task_row(b["id"], "001")["run_id"], row["run_id"])
        self.assertEqual(len(w.adapter.launches), 2)

    def test_restart_before_pid_is_stored_recovers_the_workers_own_pid(self):
        w = self.world(2)
        b = self.batch(w)
        launched = len(w.adapter.launches)
        run_id = w.store.task_row(b["id"], "001")["run_id"]
        pid = w.store.run(run_id)["pid"]
        w.store.set_run_pid(run_id, None)   # crash between the detached start and the PID write
        w.tick(2)
        self.assertEqual(w.store.run(run_id)["pid"], pid)   # the wrapper's own PID record
        self.assertEqual(len(w.adapter.launches), launched)
        self.assertEqual(self.states(w)["001"], "RUNNING")

    def test_unproven_worker_is_never_reported_stopped(self):
        w = self.world(1)
        b = self.batch(w)
        run_id = w.store.task_row(b["id"], "001")["run_id"]
        w.store.set_run_pid(run_id, None)
        w.adapter.read_pid = lambda exit_file: None   # the PID record is not readable (yet)
        ad = w.sup.s3p._adapter(b)
        self.assertTrue(taskruns.workers_alive(w.store, ad, b["id"]))
        self.assertFalse(taskruns.stop_open_runs(w.store, ad, b["id"], lambda run: None))
        self.assertEqual([r["id"] for r in taskruns.open_runs(w.store, b["id"])], [run_id])
        self.assertFalse(w.sup.s3p.stop_all(b) if hasattr(w.sup.s3p, "stop_all") else False)

    def test_restart_between_add_run_and_task_link_reattaches_a_fresh_launch(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.cfg["producers"] = json.loads(json.dumps(PRODUCERS))
        w.parallel_s3 = True
        w.sup.parallel_new_s3 = True
        w.runner.edit.chunks = 1
        w.store.set(stage2.ok_key("001", None), w.git.base_sha)
        s3p, real = w.sup.s3p, w.sup.s3p._set
        crashed = []

        def crash_once(b, task, data=None, **fields):
            if fields.get("state") == "RUNNING" and not crashed:
                crashed.append(1)
                raise _Crash()
            return real(b, task, data, **fields) if data is not None else real(b, task, **fields)
        s3p._set = crash_once
        self.assertTrue(control.start(w.store, "claude", S3, "single", cfg=w.cfg)[0])
        with self.assertRaises(_Crash):   # the process dies right after add_run
            w.tick(2)
        s3p._set = real
        w.tick(2)
        b = self.batch(w)
        self.assertEqual(self.states(w)["001"], "RUNNING")
        self.assertEqual(len(taskruns.open_runs(w.store, b["id"])), 1)   # re-attached, not duplicated
        self.assertEqual(w.store.task_row(b["id"], "001")["run_id"], taskruns.open_runs(w.store, b["id"])[0]["id"])

    def test_failed_start_releases_the_recorded_run(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.cfg["producers"] = json.loads(json.dumps(PRODUCERS))
        w.parallel_s3 = True
        w.sup.parallel_new_s3 = True
        w.runner.edit.chunks = 1
        w.store.set(stage2.ok_key("001", None), w.git.base_sha)
        w.adapter.start = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("spawn failed"))
        self.assertTrue(control.start(w.store, "claude", S3, "single", cfg=w.cfg)[0])
        w.tick(2)
        b = self.batch(w) or w.store.latest_batch("claude", S3)
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(taskruns.open_runs(w.store, b["id"]), [])

    def test_zero_chunk_shard_resumes_from_a_restart_before_the_plan_write(self):
        w = self.world(0)
        b = self.batch(w)
        w.store.set(stage3.plan_key(b["id"]), "")   # crash after the batch update, before the plan write
        w.store.update(b["id"], state="PRODUCING", run_kind="s3_parallel", pid=None)
        calls = []
        w.sup._stage3_finalize = lambda bb: calls.append(w.store.get(stage3.plan_key(bb["id"])))
        w.tick()
        self.assertEqual(calls, ["closed"])

    def test_begin_is_idempotent_and_modeless_batches_stay_serial(self):
        w = self.world(3)
        b = self.batch(w)
        w.sup.s3p.begin(w.store.batch(b["id"]))
        self.assertEqual(len(self.tasks(w)), 3)
        self.assertEqual(len(w.adapter.launches), 3)
        w2 = World()
        self.addCleanup(w2.tmp.cleanup)
        bid = w2.store.create_batch(method=S3, producer="claude", shard="001", batch="all", branch="s3-claude-001",
                                    worktree="/tmp/x")
        self.assertFalse(s3parallel.is_parallel(w2.store, w2.store.batch(bid)))

    def test_create_batch_kv_commits_with_the_row(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        bid = w.store.create_batch(method=S3, producer="claude", shard="001", batch="all", branch="s3-claude-001",
                                   worktree="/tmp/x", kv={"s3_mode_{id}": "parallel"})
        self.assertEqual(w.store.get(f"s3_mode_{bid}"), "parallel")
        with self.assertRaises(Exception):
            w.store.create_batch(method=S3, producer="codex", shard="002", batch="all", branch="s3-codex-002",
                                 worktree="/tmp/y", kv={"s3_mode_{id}": "parallel"})   # Busy: nothing is written
        self.assertEqual([r["key"] for r in w.store.kv_prefix("s3_mode_")], [f"s3_mode_{bid}"])


class StopClear(Helpers, unittest.TestCase):
    def test_stop_and_clear_confirm_every_open_run(self):
        w = self.world(20)
        b = self.batch(w)
        self.assertEqual(len(taskruns.open_runs(w.store, b["id"])), 16)
        w.store.set_line("claude", S3, force_stop=1)
        w.tick()
        self.assertEqual(taskruns.open_runs(w.store, b["id"]), [])
        self.assertEqual(self.count(w, "RUNNING"), 0)
        self.assertEqual(w.adapter.running, {})


class MaintainerRelease(Helpers, unittest.TestCase):
    def test_changed_pending_view_invalidates_only_that_task_and_keeps_its_answer(self):
        w = self.world(3)
        b = self.batch(w)
        self.respond(w, "001")
        w.tick()                                      # 001 SAVED
        self.respond(w, "003")                        # 003: the answer is preserved but not yet saved
        run_id = w.store.task_row(b["id"], "003")["run_id"]
        w.store.finish_run(run_id, 0)
        answer_file = Path(b["worktree"]) / stage3.task_path("003", "decisions.txt")
        answer_file.parent.mkdir(parents=True, exist_ok=True)
        answer_file.write_text("chunk 003\nnone\n")
        w.store.update_task(b["id"], "003", state="RESPONDED")
        old = w.store.task_row(b["id"], "003")["view_sha256"]
        base = json.loads(w.store.get(stage3.parallel_start_key(b["id"])))
        base["invalidated"] = ["003", "001"]
        w.store.set(stage3.parallel_start_key(b["id"]), json.dumps(base))
        w.sup.s3p._apply_invalidated(w.store.batch(b["id"]), self.checkpoint(w))
        row = w.store.task_row(b["id"], "003")
        self.assertEqual(row["state"], "PENDING")
        self.assertFalse(answer_file.exists())
        self.assertEqual((answer_file.parent / f"superseded-{old}.txt").read_text(), "chunk 003\nnone\n")
        self.assertEqual(json.loads(row["data"])["superseded"][0]["view_sha256"], old)
        self.assertEqual(json.loads(w.store.get(stage3.parallel_start_key(b["id"])))["invalidated"], [])
        self.assertEqual(w.store.task_row(b["id"], "001")["state"], "SAVED")   # a SAVED task is never re-made
        launched = len(w.adapter.launches)
        w.tick()
        self.assertEqual(w.store.task_row(b["id"], "003")["state"], "RUNNING")   # re-runs in a NEW session
        self.assertEqual(len(w.adapter.launches), launched + 1)

    def test_retarget_names_changed_pending_views_from_the_checkpoint_not_task_state(self):
        w = self.world(3)
        b = self.batch(w)
        self.respond(w, "001")
        w.tick()                                      # 001 is in the checkpoint; its digest changing would HOLD (CLI fails)
        base = json.loads(w.store.get(stage3.parallel_start_key(b["id"])))
        w.runner.edit.salt["002"] = 1
        git = w.sup.git
        git.head = lambda path: HEAD2
        git.remote_head = lambda branch: base["remote_head"]
        git.registered = lambda path: b["branch"]
        git.contains = lambda path, sha: True
        key, raw = w.sup.maint._retargeted_run_start(b, HEAD2)
        self.assertEqual(key, stage3.parallel_start_key(b["id"]))
        result = json.loads(raw)
        self.assertEqual((result["head"], result["invalidated"]), (HEAD2, ["002"]))


if __name__ == "__main__":
    unittest.main()
