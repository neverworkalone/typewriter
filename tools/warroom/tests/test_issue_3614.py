"""Issue #3614: Maintainer AI slots are separate from per-Issue PR watches."""
from __future__ import annotations

import json
import hashlib
import unittest
from unittest import mock
from pathlib import Path

from tests.fakes import HEAD1
from tests.test_issue_1555 import maintainer_row, produce_and_report, report as shared_report, world
from tests.test_issue_2034_d import DWorld
from tests.test_supervisor import review
from tests.test_lines import PRODUCERS
from warroom import control, defects, dchunk, dparallel
from warroom.restart_controller import (_live_work_or_controls, has_pending_restart, record_runtime,
                                        update_restart_request, write_restart_request)


class MaintainerQueue(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)

    def queue_issue(self, number: int) -> None:
        w = self.w
        request = w.store.request_issue(f"issue-{number}", f"Typewriter request {number}", "diagnosis", urgent=True)
        self.assertTrue(w.store.mark_issue_request_created(request["id"], number))
        self.assertTrue(w.store.complete_issue_request(request["id"], number))
        w.gh.issues[number] = {
            "state": "open", "labels": ["urgent"], "title": f"Issue {number}", "body": "diagnosis",
        }

    def open_pr_for(self, issue: int, pr: int) -> dict:
        w = self.w
        branch = f"maint-{issue}"
        w.pr_info(pr, HEAD1, head_ref=branch)
        w.gh.by_branch[branch] = [{"number": pr, "state": "OPEN", "headRefOid": HEAD1}]
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        batch = next(b for b in w.store.maintenance_batches() if b["batch"] == str(issue))
        self.assertEqual(batch["state"], "WAITING_REVIEW")
        return batch

    def test_waiting_pr_returns_ai_slot_and_next_issue_starts(self):
        w = self.w
        produce_and_report(w)
        w.tick()  # Maintainer #101 starts
        first = maintainer_row(w)
        self.assertEqual(first["state"], "PRODUCING")

        first = self.open_pr_for(101, 50)
        self.assertFalse(w.store.maintenance_batch_open())
        self.queue_issue(102)
        w.tick()  # claims Issue 102 while PR 50 remains under review
        second = next(b for b in w.store.maintenance_batches() if b["batch"] == "102")
        self.assertEqual(second["state"], "PREPARE")
        self.assertEqual(w.store.batch(first["id"])["state"], "WAITING_REVIEW")

        w.tick()  # starts Issue 102's AI work
        second = w.store.batch(second["id"])
        self.assertEqual(second["state"], "PRODUCING")
        self.assertTrue(w.store.maintenance_batch_open())

    def test_review_fix_waits_for_the_shared_ai_slot_and_keeps_pr_ownership(self):
        w = self.w
        produce_and_report(w)
        w.tick()
        first = self.open_pr_for(101, 50)
        self.queue_issue(102)
        w.tick()
        second = next(b for b in w.store.maintenance_batches() if b["batch"] == "102")
        w.tick()  # Issue 102 AI starts
        self.assertEqual(w.store.batch(second["id"])["state"], "PRODUCING")

        launch_count = len(w.adapter.launches)
        w.gh.reviews_ = [review(71, HEAD1, "-1 correct the issue-scoped fix")]
        w.store.delete(f"last_poll_{first['id']}")
        w.tick()
        self.assertEqual(w.store.batch(first["id"])["state"], "WAITING_REVIEW")
        self.assertEqual(len(w.adapter.launches), launch_count)
        pending = w.store.get(f"maintenance_review_pending_{first['id']}")
        self.assertIsNotNone(pending)

        w.pr_info(51, HEAD1, head_ref="maint-102")
        w.gh.by_branch["maint-102"] = [{"number": 51, "state": "OPEN", "headRefOid": HEAD1}]
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()  # Issue 102 enters review; the older PR's fix then takes the now-free slot
        self.assertEqual(w.store.batch(second["id"])["state"], "WAITING_REVIEW")
        self.assertEqual(w.store.batch(first["id"])["state"], "FIXING")
        fix = w.adapter.launches[-1]
        self.assertEqual(fix["cwd"], first["worktree"])
        self.assertIn("PR #50", fix["prompt"])
        self.assertIn("Issue #101", fix["prompt"])
        self.assertTrue(w.store.maintenance_batch_open())

    def test_stale_pinned_stop_does_not_stop_next_maintainer_execution(self):
        w = self.w
        produce_and_report(w)
        w.tick()
        first = maintainer_row(w)
        self.assertTrue(control.stop_maintainer(w.store, "sonnet", first["id"]))
        w.store.update(first["id"], state="COMPLETE", pid=None)
        second = w.store.create_batch(method="m", producer="sonnet", shard="", batch="102",
                                      branch="maint-102", worktree=str(w.paths.worktrees / "maint-102"),
                                      state="PRODUCING")
        w.store.update(second, state="PRODUCING")

        w.sup._tick_maintenance()
        self.assertEqual(w.store.batch(second)["state"], "PRODUCING")
        self.assertIsNone(w.store.get("stop_pin_sonnet_m"))
        self.assertEqual(w.store.peek_line("sonnet", "m")["force_stop"], 0)


class NoCodeRecovery(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)

    def prepare_failed_d_task(self, *, serial=False):
        w = self.w
        source_wt = w.paths.worktrees / "d-codex-081-01"
        branch = "d-deepseek-081-01"
        w.git.create_worktree(source_wt, branch, HEAD1)
        batch_id = w.store.create_batch(method="d", producer="deepseek", shard="081", batch="01",
                                        branch=branch, worktree=str(source_wt), state="PREPARE")
        w.store.line("deepseek", "d")
        w.store.update(batch_id, state="PRODUCING", run_kind="d_parallel")
        if not serial:
            w.store.set(f"d_mode_{batch_id}", "parallel")
        report = '{"version":1,"defect_class":"d-task-report","summary":"保存 결과의 Sense ID 대조 필요"}'
        report_path = source_wt / defects.REPORT_FILE
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report, "utf-8")
        defect_id = w.store.report_defect(batch_id, defects.report_event_key(batch_id, report), "report",
                                          "d-task-report", "LINKED", report, "shared_defect", None)
        self.assertIsNotNone(defect_id)
        w.store.update_defect(defect_id, issue_number=101)

        run_log = w.paths.logs / "source-d-002.log"
        run_log.parent.mkdir(parents=True, exist_ok=True)
        run_log.write_text("official save-chunk rejected task 002", "utf-8")
        if serial:
            source = w.store.batch(batch_id)
            canonical = source_wt / dchunk.names(source).canonical
            canonical.parent.mkdir(parents=True, exist_ok=True)
            canonical.write_text(json.dumps({
                "id": "w0001", "lemma": "단어", "senses": [{"id": "w0001-s1"}],
            }) + "\n", "utf-8")
            active = dchunk.chunk_names(source, 1)
            active_path = source_wt / active.active
            active_path.parent.mkdir(parents=True, exist_ok=True)
            view = "bound D view"
            (source_wt / active.view).write_text(view, "utf-8")
            active_path.write_text(json.dumps({
                "shard": "081", "batch": "01", "model": "deepseek", "chunk_no": 1,
                "view_sha256": hashlib.sha256(view.encode()).hexdigest(),
                "git_head": HEAD1, "senses": [{"sense_id": "w0001-s1"}],
            }), "utf-8")
            w.store.update(batch_id, run_kind="d_chunk_new", session_id="d-session-002")
            w.store.set(f"d_base_head_{batch_id}", HEAD1)
            w.store.set(dchunk.run_start_key(batch_id), json.dumps({
                "branch": branch, "worktree": str(source_wt), "head": HEAD1,
                "remote_head": None, "chunk_no": 1,
            }, sort_keys=True))
            run_id = w.store.add_run(batch_id, "d_chunk_new", "d-session-002", None,
                                     run_log, run_log.with_suffix(".exit"))
            w.store.finish_run(run_id, 0)
            w.store.update(batch_id, state="PAUSED", pause_reason="shared_defect", paused_from="PRODUCING",
                           defect_id=defect_id, session_id="d-session-002", pid=None)
        else:
            w.store.add_tasks(batch_id, [("002", "002")])
            run_id = w.store.add_run(batch_id, "d_chunk_new", "d-session-002", None,
                                     run_log, run_log.with_suffix(".exit"), task="002")
            w.store.finish_run(run_id, 0)
            w.store.update_task(batch_id, "002", state="FAILED", run_id=run_id,
                                session_id="d-session-002", data='{"ack":true}')

        w.cfg["maintainer"] = "sonnet"
        w.gh.issues[101] = {"state": "open", "labels": ["urgent"], "title": "Issue 101", "body": "diagnosis"}
        w.store.ensure_maintenance(101)
        m_id = w.store.claim_maintenance(101, "sonnet", "maint-101", str(w.paths.worktrees / "maint-101"))
        self.assertIsNotNone(m_id)
        w.tick()
        maintainer = w.store.batch(m_id)
        self.assertEqual(maintainer["state"], "PRODUCING")
        request_path = Path(maintainer["worktree"]) / ".warroom-scratch/incident-diagnosis-request.json"
        request = json.loads(request_path.read_text("utf-8"))
        return batch_id, defect_id, maintainer, request

    def test_structured_no_code_result_releases_only_the_bound_task_and_waits_for_saved_progress(self):
        w = self.w
        batch_id, defect_id, maintainer, request = self.prepare_failed_d_task()
        scope = {"task": "002", "chunk": "002"}
        summary = "s22의 실제 검색 hit 때문에 Z 저장이 올바르게 거부된 false report였다."
        cause = "원 Sense ID와 저장 거부 진단을 다시 대조했다."
        action = "D task 002를 기존 session의 active chunk에서 다시 판정한다."
        next_action = "공식 save-chunk가 task를 SAVED로 만들 때까지 같은 task를 추적한다."
        result = {
            "version": 2, "issue": 101, "attempt": maintainer["id"], "round": request["round"],
            "defect_id": defect_id, "event_key": request["event_key"], "batch_id": batch_id,
            "source_head": request["source_head"], "evidence_sha256": request["evidence_sha256"],
            "scope": scope, "outcome": "no_code_resume", "summary": summary, "cause": cause,
            "recovery": {"type": "resume_failed_task", **scope, "action": action},
            "blocker": None, "next_action": next_action,
        }
        maintainer_wt = Path(maintainer["worktree"])
        (maintainer_wt / ".warroom-scratch/incident-diagnosis.json").write_text(
            json.dumps(result, ensure_ascii=False), "utf-8")
        marker = f"incident-recovery-101-attempt-{maintainer['id']}-round-{request['round']}"
        w.gh.comment_issue(101, "\n".join((summary, cause, action, next_action, request["evidence_sha256"],
                                           defects.marker(defects.EVENT_MARK, marker))))
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()

        self.assertEqual(w.store.batch(batch_id)["state"], "PRODUCING")
        self.assertEqual(w.store.batch(maintainer["id"])["state"], "COMPLETE")
        self.assertEqual(w.store.defect(defect_id)["state"], "RECOVERING")
        self.assertEqual(w.store.maintenance(101)["state"], "RECOVERING")
        approval = json.loads(w.store.get(f"no_code_approval_{defect_id}"))
        self.assertEqual((approval["status"], approval["task"], approval["chunk"]), ("APPROVED", "002", "002"))
        self.assertIsNone(w.store.defect(defect_id)["merge_sha"])
        self.assertFalse(w.store.maintenance_batch_open())

        # Resume alone is intermediate; only the original task's persisted SAVED state resolves the Issue.
        w.store.update_task(batch_id, "002", state="SAVED")
        w.tick()
        self.assertEqual(w.store.defect(defect_id)["state"], "RELEASED")
        self.assertEqual(w.store.maintenance(101)["state"], "DONE")

    def test_legacy_serial_no_code_resume_keeps_the_exact_active_chunk_and_session(self):
        w = self.w
        batch_id, defect_id, maintainer, request = self.prepare_failed_d_task(serial=True)
        scope = {"task": None, "chunk": "001"}
        summary = "D의 활성 001 청크 저장 경계에서 공통 코드 결함 없이 멈춘 것을 확인했다."
        cause = "공식 active chunk와 종료된 원 세션이 같은 청크를 가리킨다."
        action = "D의 기존 세션에서 활성 001 청크를 재개한다."
        next_action = "동일 001 청크의 공식 저장 진전만 확인한다."
        result = {
            "version": 2, "issue": 101, "attempt": maintainer["id"], "round": request["round"],
            "defect_id": defect_id, "event_key": request["event_key"], "batch_id": batch_id,
            "source_head": request["source_head"], "evidence_sha256": request["evidence_sha256"],
            "scope": scope, "outcome": "no_code_resume", "summary": summary, "cause": cause,
            "recovery": {"type": "resume_same_session", **scope, "action": action},
            "blocker": None, "next_action": next_action,
        }
        maintainer_wt = Path(maintainer["worktree"])
        (maintainer_wt / ".warroom-scratch/incident-diagnosis.json").write_text(
            json.dumps(result, ensure_ascii=False), "utf-8")
        marker = f"incident-recovery-101-attempt-{maintainer['id']}-round-{request['round']}"
        w.gh.comment_issue(101, "\n".join((summary, cause, action, next_action, request["evidence_sha256"],
                                           defects.marker(defects.EVENT_MARK, marker))))
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()

        resumed = w.store.batch(batch_id)
        self.assertEqual((resumed["state"], resumed["run_kind"], resumed["session_id"]),
                         ("PRODUCING", "d_chunk_new", "d-session-002"))
        self.assertEqual(w.store.task_rows(batch_id), [])
        approval = json.loads(w.store.get(f"no_code_approval_{defect_id}"))
        self.assertEqual((approval["status"], approval["task"], approval["chunk"],
                          approval["recovery_type"]),
                         ("APPROVED", None, "001", "resume_same_session"))
        self.assertEqual(w.store.defect(defect_id)["state"], "RECOVERING")
        self.assertEqual(w.store.maintenance(101)["state"], "RECOVERING")

        with mock.patch.object(dchunk, "verified_chunks", return_value=(set(), 1)):
            w.tick()
        self.assertEqual(w.store.maintenance(101)["state"], "RECOVERING")
        with mock.patch.object(dchunk, "verified_chunks", return_value=({1}, 1)):
            w.tick()
        self.assertEqual(w.store.defect(defect_id)["state"], "RELEASED")
        self.assertEqual(w.store.maintenance(101)["state"], "DONE")

    def test_task_report_pause_resumes_its_exact_d_task_through_the_normal_save_path(self):
        w = DWorld(records=25, parallel=True)
        self.addCleanup(w.tmp.cleanup)
        w.cfg["producers"] = PRODUCERS
        w.runner.models.append("p/sonnet-free")
        w.cfg["maintainer"] = "sonnet"
        w.gh.issues[101] = {"state": "open", "labels": ["urgent"], "title": "Issue 101", "body": "diagnosis"}
        w.start("single", "deepseek", "d")
        w.ai(save=False, session="d-session-002")
        w.tick()

        source = w.row_()
        task = w.store.task_row(source["id"], "001")
        self.assertEqual(task["state"], "RUNNING")
        raw = json.dumps(shared_report(defect_class="d-save-boundary", summary="D task reports a shared save failure"),
                         ensure_ascii=False)
        report_path = w.wt() / dparallel.defect_path(source, "001")
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(raw, "utf-8")

        self.assertFalse(w.sup._scan_task_reports(source, w.sup.dp))  # stable-file first observation
        self.assertTrue(w.sup._scan_task_reports(source, w.sup.dp))   # asks the exact worker to stop
        self.assertEqual(w.store.batch(source["id"])["state"], "PRODUCING")
        self.assertTrue(w.sup._scan_task_reports(w.store.batch(source["id"]), w.sup.dp))
        source = w.store.batch(source["id"])
        stopped = w.store.task_row(source["id"], "001")
        self.assertEqual((source["state"], stopped["state"], stopped["run_id"], stopped["session_id"]),
                         ("PAUSED", "FIXQ", None, "d-session-002"))
        self.assertFalse(w.store.open_task_runs(source["id"]))

        defect = w.store.defect_by_event(defects.report_event_key(source["id"], raw))
        self.assertIsNotNone(defect)
        w.store.update_defect(defect["id"], state="LINKED", issue_number=101)
        w.store.ensure_maintenance(101)
        maintainer_id = w.store.claim_maintenance(101, "sonnet", "maint-101", str(w.paths.worktrees / "maint-101"))
        self.assertIsNotNone(maintainer_id)
        w.tick()
        maintainer = w.store.batch(maintainer_id)
        request_path = Path(maintainer["worktree"]) / ".warroom-scratch/incident-diagnosis-request.json"
        request = json.loads(request_path.read_text("utf-8"))
        owner = request["scope"]["task_report"]
        self.assertEqual((owner["task"], owner["chunk"], owner["row_state"], owner["session_id"]),
                         ("001", "001", "FIXQ", "d-session-002"))
        self.assertEqual(owner["path"], dparallel.defect_path(source, "001"))

        scope = {"task": "001", "chunk": "001"}
        summary = "D의 원 보고 작성 task에서 무코드 저장 재개가 필요하다."
        cause = "보고서 경로, 활성 chunk, 종료된 worker run과 세션을 대조했다."
        action = "D task 001을 기존 세션에서 같은 chunk로 재개한다."
        next_action = "공식 D save가 task 001을 SAVED로 만들 때까지 추적한다."
        result = {
            "version": 2, "issue": 101, "attempt": maintainer_id, "round": request["round"],
            "defect_id": defect["id"], "event_key": defect["event_key"], "batch_id": source["id"],
            "source_head": request["source_head"], "evidence_sha256": request["evidence_sha256"],
            "scope": scope, "outcome": "no_code_resume", "summary": summary, "cause": cause,
            "recovery": {"type": "resume_report_task", **scope, "action": action},
            "blocker": None, "next_action": next_action,
        }
        maintainer_wt = Path(maintainer["worktree"])
        (maintainer_wt / ".warroom-scratch/incident-diagnosis.json").write_text(
            json.dumps(result, ensure_ascii=False), "utf-8")
        marker = f"incident-recovery-101-attempt-{maintainer_id}-round-{request['round']}"
        w.gh.comment_issue(101, "\n".join((summary, cause, action, next_action, request["evidence_sha256"],
                                           defects.marker(defects.EVENT_MARK, marker))))
        w.adapter.finish(maintainer["pid"])
        w.adapter.plan.append({"code": 0, "session": "d-session-002",
                               "effect": lambda: w.runner.dchunk.save(w.wt(), 1)})
        w.tick()
        self.assertEqual(w.store.batch(source["id"])["state"], "PRODUCING")
        self.assertEqual(w.store.task_row(source["id"], "001")["state"], "FIXQ")

        w.tick()
        resumed = w.adapter.launches[-1]
        self.assertEqual((resumed["kind"], resumed["session"]), ("resume", "d-session-002"))
        resumed_run = w.store.runs(source["id"])[0]
        self.assertEqual((resumed_run["task"], resumed_run["session_id"]), ("001", "d-session-002"))
        w.adapter.finish(resumed["pid"])
        w.tick()
        self.assertEqual(w.store.task_row(source["id"], "001")["state"], "SAVED")
        self.assertEqual(w.store.defect(defect["id"])["state"], "RELEASED")
        self.assertEqual(w.store.maintenance(101)["state"], "DONE")

    def test_report_without_session_stops_workers_and_cannot_authorize_resume(self):
        w = DWorld(records=50, parallel=True)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "d")
        w.ai(save=False, session=None)
        w.ai(save=False, session="sibling-session")
        w.tick()
        source = w.row_()
        self.assertGreaterEqual(len(w.store.open_task_runs(source["id"])), 2)
        raw = json.dumps(shared_report(defect_class="d-save-boundary", summary="D task reports a shared save failure"))
        report_path = w.wt() / dparallel.defect_path(source, "001")
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(raw, "utf-8")

        self.assertFalse(w.sup._scan_task_reports(source, w.sup.dp))
        self.assertTrue(w.sup._scan_task_reports(source, w.sup.dp))
        self.assertTrue(w.sup._scan_task_reports(w.store.batch(source["id"]), w.sup.dp))
        source = w.store.batch(source["id"])
        self.assertEqual(source["state"], "PAUSED")
        self.assertFalse(w.store.open_task_runs(source["id"]))
        defect = w.store.defect_by_event(defects.report_event_key(source["id"], raw))
        self.assertIsNotNone(defect)
        owner = w.sup.maint._task_report_scope(defect, source)
        self.assertTrue(owner is None or not owner["session_id"])
        evidence = {"defect": {"source": "report"}, "task_report": owner,
                    "task_report_path": dparallel.defect_path(source, "001")}
        self.assertFalse(w.sup.maint._validate_report_task(source, evidence, {"task": "001", "chunk": "001"}))

    def test_restart_controller_refuses_operator_controls_and_open_workers(self):
        w = self.w
        self.assertIsNone(_live_work_or_controls(w.store))
        w.store.line("deepseek", "a")
        w.store.set_line("deepseek", "a", drain=1)
        self.assertIn("Stop/Drain", _live_work_or_controls(w.store))
        w.store.set_line("deepseek", "a", drain=0)
        w.store.set_line("deepseek", "a", force_stop=1)
        self.assertIn("Stop/Drain", _live_work_or_controls(w.store))


class RestartHandoff(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)

    def test_restart_request_and_loaded_sha_survive_process_boundaries(self):
        w = self.w
        defect = {"id": 91, "issue_number": 92, "batch_id": 93, "merge_sha": HEAD1}
        path = write_restart_request(w.paths, defect, "b" * 40)
        self.assertTrue(path.is_file())
        self.assertTrue(has_pending_restart(w.paths))

        record_runtime(w.paths, HEAD1)
        self.assertTrue(update_restart_request(w.paths, 91, "loaded", loaded_code_sha=HEAD1))
        self.assertFalse(has_pending_restart(w.paths))
        self.assertFalse(_live_work_or_controls(w.store))


class MergedFixProgress(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)

    def prepare_released_fix(self):
        w = self.w
        source_wt = w.paths.worktrees / "d-codex-081-01"
        branch = "d-deepseek-081-01"
        w.git.create_worktree(source_wt, branch, HEAD1)
        batch_id = w.store.create_batch(method="d", producer="deepseek", shard="081", batch="01",
                                        branch=branch, worktree=str(source_wt), state="PREPARE")
        w.store.line("deepseek", "d")
        w.store.update(batch_id, state="PRODUCING", run_kind="d_parallel")
        w.store.add_tasks(batch_id, [("002", "002")])
        w.store.update_task(batch_id, "002", state="FAILED", data='{"ack":true}')
        raw = json.dumps(shared_report(defect_class="d-merged-recovery", summary="D task failure needs shared code repair"))
        defect_id = w.store.report_defect(batch_id, defects.report_event_key(batch_id, raw), "report",
                                          "d-merged-recovery", "LINKED", raw, "shared_defect", None)
        w.store.update_defect(defect_id, issue_number=101)
        w.gh.issues[101] = {"state": "open", "labels": ["urgent"], "title": "Issue 101", "body": "fix"}
        w.store.ensure_maintenance(101)
        m_id = w.store.claim_maintenance(101, "sonnet", "maint-101", str(w.paths.worktrees / "maint-101"))
        self.assertIsNotNone(m_id)
        w.store.update_defect(defect_id, state="FIX_MERGED", merge_sha=HEAD1)
        snapshot = {"version": 1, "defect_id": defect_id, "issue": 101, "batch_id": batch_id,
                    "source_error_seq": 0, "failed_tasks": [{"task": "002", "chunk": "002"}]}
        self.assertTrue(w.store.release_defect(defect_id, batch_id, None, force_run=False,
                                               fix_kind="runtime", applied_code_sha=HEAD1,
                                               recovery_snapshot=snapshot))
        return batch_id, defect_id

    def test_merged_fix_resolves_only_after_the_exact_failed_task_is_saved(self):
        w = self.w
        batch_id, defect_id = self.prepare_released_fix()
        w.sup.maint.step()
        proof = json.loads(w.store.get(f"defect_recovery_{defect_id}"))
        self.assertEqual((proof.get("status"), w.store.maintenance(101)["state"]), (None, "RECOVERING"))

        w.store.update_task(batch_id, "002", state="SAVED")
        w.sup.maint.step()
        proof = json.loads(w.store.get(f"defect_recovery_{defect_id}"))
        self.assertEqual(proof["status"], "VERIFIED")
        self.assertEqual(w.store.maintenance(101)["state"], "DONE")

    def test_merged_fix_recurrence_keeps_the_incident_unresolved(self):
        w = self.w
        batch_id, defect_id = self.prepare_released_fix()
        w.store.update(batch_id, state="ERROR", error="same task failed again")
        w.sup.maint.step()
        proof = json.loads(w.store.get(f"defect_recovery_{defect_id}"))
        self.assertEqual(proof["status"], "RECURRENCE")
        self.assertEqual(w.store.defect(defect_id)["state"], "HELD")
        self.assertEqual(w.store.maintenance(101)["state"], "HELD")

if __name__ == "__main__":
    unittest.main()
