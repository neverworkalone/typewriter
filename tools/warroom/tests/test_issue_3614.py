"""Issue #3614: Maintainer AI slots are separate from per-Issue PR watches."""
from __future__ import annotations

import json
import unittest
from unittest import mock
from pathlib import Path

from tests.fakes import HEAD1
from tests.test_issue_1555 import maintainer_row, produce_and_report, report as shared_report, world
from tests.test_supervisor import review
from warroom import control, defects, stage2
from warroom.restart_controller import (_request_files, handle_pending_restart, has_pending_restart, record_runtime,
                                        request_operator_restart, update_restart_request, write_restart_request)


class MaintainerActionsEvidence(unittest.TestCase):
    def test_only_exact_terminal_required_job_failure_triggers(self):
        from warroom.github import GhClient
        client = GhClient(None, {}, "owner/repo")
        run = {"id": 42, "event": "pull_request", "path": ".github/workflows/ci.yml",
               "head_sha": "b" * 40, "head_branch": "maint-101", "status": "completed", "conclusion": "failure",
               "run_attempt": 1, "pull_requests": [{"number": 50, "head": {"sha": HEAD1}}]}
        job = {"id": 99, "name": "Validate and test Typewriter", "head_sha": "b" * 40,
               "status": "completed", "conclusion": "failure", "steps": [{"name": "Tests", "conclusion": "failure"}]}
        def lookup(path):
            if "/workflows/" in path:
                return {"workflow_runs": [run], "total_count": 1}
            if "/attempts/" in path:
                return {"jobs": [job], "total_count": 1}
            return run
        with mock.patch.object(client, "_api", side_effect=lookup):
            self.assertEqual(client.maintainer_ci_failure(50, HEAD1, "maint-101")["key"], "ci:42:1")
            for field, value in [("status", "in_progress"), ("conclusion", "success"),
                                 ("conclusion", "skipped"), ("head_sha", "c" * 40),
                                 ("pull_requests", [{"number": 51, "head": {"sha": HEAD1}}])]:
                old = run[field]
                run[field] = value
                self.assertIsNone(client.maintainer_ci_failure(50, HEAD1, "maint-101"), field)
                run[field] = old
            run["pull_requests"][0]["head"]["sha"] = "c" * 40
            self.assertIsNone(client.maintainer_ci_failure(50, HEAD1, "maint-101"))
            run["pull_requests"][0]["head"]["sha"] = HEAD1
            job["conclusion"] = "skipped"
            self.assertIsNone(client.maintainer_ci_failure(50, HEAD1, "maint-101"))


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

    def test_merged_fix_waiting_for_batch_is_coming(self):
        from warroom import views
        w = self.w
        source = produce_and_report(w)
        w.tick()
        maint = maintainer_row(w)
        w.store.update(maint["id"], state="COMPLETE", pid=None)
        w.store.update_maintenance(101, state="DONE", merge_sha=HEAD1)
        defect = w.store.defects()[0]
        w.store.update_defect(defect["id"], state="FIX_MERGED")
        card = control.maintainer_card(w.store, w.cfg)
        self.assertEqual(card["state"], "COMING")
        self.assertIn("COMING", views.maintainer_card_text(card))
        w.store.update_maintenance(101, state="RECOVERING")
        w.store.update_defect(defect["id"], state="RELEASED")
        self.assertEqual(control.maintainer_card(w.store, w.cfg)["state"], "COMING")
        w.store.update_maintenance(101, state="HELD", hold_reason="failure")
        w.store.update_defect(defect["id"], state="HELD", hold_reason="failure")
        self.assertEqual(control.maintainer_card(w.store, w.cfg)["state"], "ERROR")

    def paused_source_with_maintainer(self):
        w = self.w
        source = produce_and_report(w)
        w.tick()
        return source, maintainer_row(w), w.store.defects()[0]

    def test_card_follows_the_current_situation(self):
        w = self.w
        card = lambda: control.maintainer_card(w.store, w.cfg)
        source, maint, defect = self.paused_source_with_maintainer()

        w.store.update(maint["id"], state="PRODUCING")   # a running AI outranks an older hold reason
        w.store.update_defect(defect["id"], state="HELD", hold_reason="old failure")
        self.assertEqual(card()["state"], "WORKING")
        self.assertNotIn("보류", card()["text"])
        w.store.update_defect(defect["id"], state="LINKED", hold_reason=None)

        w.store.update(maint["id"], state="WAITING_REVIEW", pid=None, pr_number=50)
        self.assertEqual((card()["state"], card()["pr"]), ("WORKING", "PR #50"))

        w.store.update(maint["id"], state="ERROR", error="boom")   # the source batch is still paused: act on it
        self.assertEqual(card()["state"], "ERROR")

        # Recovery is still being verified: shown even though the attempt and the source batch are COMPLETE.
        w.store.update(maint["id"], state="COMPLETE", error=None)
        w.store.update_maintenance(101, state="RECOVERING")
        w.store.update_defect(defect["id"], state="RECOVERING")
        w.store.update(source["id"], state="COMPLETE")
        self.assertEqual(card()["state"], "COMING")
        self.assertIn("복구 확인 중", card()["text"])
        self.assertTrue(control.open_maintenance(w.store))

    def test_queued_issue_is_waiting(self):
        from warroom import views
        w = self.w
        w.store.ensure_maintenance(300)
        card = control.maintainer_card(w.store, w.cfg)
        self.assertEqual(card["state"], "WAITING")
        self.assertIn("대기 중", views.maintainer_card_text(card))

    def test_past_error_of_a_finished_source_leaves_the_card_but_stays_clearable(self):
        w = self.w
        source, maint, defect = self.paused_source_with_maintainer()
        w.store.update(maint["id"], state="ERROR", pid=None, error="no PR")
        w.store.update_defect(defect["id"], state="OVERRIDDEN")
        w.store.update(source["id"], state="COMPLETE")
        self.assertEqual(control.maintainer_card(w.store, w.cfg)["state"], "IDLE")
        self.assertEqual(control.open_maintenance(w.store), [])
        self.assertEqual(control.urgent_items(w.store, w.cfg), [])

        # The Detail still shows the leftover attempt with its exact Issue, so the existing Clear is accepted.
        st = control.maintainer_status(w.store, w.cfg, maint["producer"])
        self.assertEqual((st["issue_number"], st["batch_id"]), (101, maint["id"]))
        self.assertTrue(st["maintainer"]["residual"])
        self.assertIn("잔여 Maintainer 기록", st["maintainer"]["text"])

        w.store.ensure_maintenance(300)   # a current Issue takes the card and is not counted with the past record
        card = control.maintainer_card(w.store, w.cfg)
        self.assertEqual(card["state"], "WAITING")
        self.assertIn("#300", card["issue"])
        self.assertNotIn("건 대기", card["issue"])
        st = control.maintainer_status(w.store, w.cfg, maint["producer"])   # the attempt on screen keeps its own Issue
        self.assertEqual((st["issue_number"], st["batch_id"]), (101, maint["id"]))
        self.assertEqual([n for n, _ in st["maintainer"]["others"]], [300])
        self.assertEqual(control.request_clear(w.store, maint["producer"], "m", maint["id"], 101), (True, ""))

    def test_held_record_is_past_only_with_explicit_source_completion(self):
        w = self.w
        source, maint, defect = self.paused_source_with_maintainer()
        w.store.update(maint["id"], state="COMPLETE", pid=None)
        w.store.update_maintenance(101, state="HELD", hold_reason="resume failed")
        w.store.update_defect(defect["id"], state="HELD", hold_reason="resume failed")
        self.assertEqual(control.maintainer_card(w.store, w.cfg)["state"], "ERROR")   # source still paused
        w.store.update(source["id"], state="COMPLETE")
        self.assertEqual(control.maintainer_card(w.store, w.cfg)["state"], "IDLE")
        self.assertEqual(control.open_maintenance(w.store), [])
        w.store.update_defect(defect["id"], batch_id=999999)   # a missing source row is not proof of completion
        self.assertEqual(control.maintainer_card(w.store, w.cfg)["state"], "ERROR")

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
        card = control.maintainer_card(w.store, w.cfg)
        self.assertIn("#102", card["issue"])
        self.assertIn("+1", card["issue"])

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

    def conflict_pr(self):
        w = self.w
        produce_and_report(w)
        w.tick()
        first = self.open_pr_for(101, 50)
        base = "c" * 40
        w.git.base_sha = base
        w.git.remote[first["branch"]] = HEAD1
        w.gh.prs[50].update(base_ref=w.cfg["base_branch"], base_sha=base, mergeable=False)
        w.store.delete(f"last_poll_{first['id']}")
        return first, base

    def test_conflict_is_combined_with_review_and_ci_in_owned_slot(self):
        w = self.w
        first, base = self.conflict_pr()
        w.gh.reviews_ = [review(71, HEAD1, "-1 correct the issue-scoped fix")]
        w.gh.ci_failure = {"kind": "ci", "author": "GitHub Actions", "key": "ci:42:1", "body": "failed"}
        w.tick()
        self.assertEqual(w.store.batch(first["id"])["state"], "FIXING")
        prompt = w.adapter.launches[-1]["prompt"]
        self.assertIn("conflict:" + base, prompt)
        self.assertIn("ci:42:1", prompt)
        self.assertIn("review:71", prompt)
        for key in ("conflict:" + base, "ci:42:1", "review:71"):
            self.assertEqual(w.store.handled_event(first["id"], 50, HEAD1, key)["status"], "CLAIMED")

    def test_conflict_waits_for_slot_and_dirty_or_moved_checkout_never_launches(self):
        w = self.w
        first, base = self.conflict_pr()
        w.sup._watch(first, allow_fix=False)
        self.assertEqual(w.store.batch(first["id"])["state"], "WAITING_REVIEW")
        self.assertIsNotNone(w.store.get(f"maintenance_review_pending_{first['id']}"))
        w.store.delete(f"last_poll_{first['id']}")
        w.git.dirty_text = " M existing-file"
        w.sup._watch(w.store.batch(first["id"]))
        self.assertEqual(w.store.batch(first["id"])["state"], "ERROR")
        self.assertEqual(w.git.dirty_text, " M existing-file")

    def test_branch_moved_by_own_push_after_poll_is_rewatched_not_errored(self):
        w = self.w
        first, base = self.conflict_pr()
        count = len(w.adapter.launches)
        w.git.remote_head = lambda branch: "e" * 40
        w.store.delete(f"last_poll_{first['id']}")
        w.sup._watch(first)
        self.assertEqual(len(w.adapter.launches), count)
        self.assertEqual(w.store.batch(first["id"])["state"], "WAITING_REVIEW")

    def test_unknown_mergeability_and_base_race_do_not_launch(self):
        w = self.w
        first, base = self.conflict_pr()
        count = len(w.adapter.launches)
        w.gh.prs[50]["mergeable"] = None
        w.sup._watch(first)
        self.assertEqual(len(w.adapter.launches), count)
        self.assertEqual(w.store.batch(first["id"])["state"], "WAITING_REVIEW")
        w.store.delete(f"last_poll_{first['id']}")
        w.gh.prs[50]["mergeable"] = False
        w.git.base_sha = "d" * 40
        w.sup._watch(first)
        self.assertEqual(len(w.adapter.launches), count)
        self.assertEqual(w.store.batch(first["id"])["state"], "WAITING_REVIEW")

    def test_conflict_completion_returns_to_existing_review_watch(self):
        w = self.w
        first, base = self.conflict_pr()
        w.tick()
        batch = w.store.batch(first["id"])
        new_head = "b" * 40
        w.git.local_head = new_head
        w.git.remote[first["branch"]] = new_head
        w.git.integrated.extend([(str(first["worktree"]), HEAD1), (str(first["worktree"]), base)])
        w.gh.prs[50].update(head_sha=new_head, mergeable=True)
        w.gh.issue_comments_[50] = [{"id": 88, "user": {"login": w.cfg["expected_account"]},
            "body": f"resolved and tested\nWarRoom-Conflict-Event: conflict:{base}\nWarRoom-Conflict-Fix-Head: {new_head}",
            "created_at": "2099-01-01T00:00:00Z"}]
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        after = w.store.batch(first["id"])
        self.assertEqual(after["state"], "WAITING_REVIEW")
        self.assertEqual(after["head_sha"], new_head)
        self.assertEqual(w.store.handled_event(first["id"], 50, HEAD1, "conflict:" + base)["status"], "HANDLED")

    def test_conflict_completion_requires_both_ancestors_and_exact_reply(self):
        w = self.w
        first, base = self.conflict_pr()
        w.tick()
        batch = w.store.batch(first["id"])
        run = w.store.runs(first["id"])[0]
        w.store.finish_run(run["id"], 0)
        w.store.set(f"verified_completion_run_{first['id']}", str(run["id"]))
        new_head = "b" * 40
        w.gh.issue_comments_[50] = [{"id": 88, "user": {"login": w.cfg["expected_account"]},
            "body": f"resolved and tested\nWarRoom-Conflict-Event: conflict:{base}\nWarRoom-Conflict-Fix-Head: {new_head}",
            "created_at": "2099-01-01T00:00:00Z"}]
        info = {"head_sha": new_head}
        w.git.local_head = new_head
        w.git.remote[first["branch"]] = new_head
        w.gh.prs[50]["head_sha"] = new_head
        self.assertIsNotNone(w.sup._complete_producer_fix_events(batch, info))
        w.git.integrated.extend([(str(first["worktree"]), HEAD1), (str(first["worktree"]), base)])
        self.assertIsNone(w.sup._complete_producer_fix_events(batch, info))
        self.assertEqual(w.store.handled_event(first["id"], 50, HEAD1, "conflict:" + base)["status"], "HANDLED")

    def test_ci_failure_uses_single_slot_and_claims_without_completing(self):
        w = self.w
        produce_and_report(w)
        w.tick()
        first = self.open_pr_for(101, 50)
        w.gh.ci_failure = {"kind": "ci", "author": "GitHub Actions", "key": "ci:42:1", "body": "failed"}
        w.store.delete(f"last_poll_{first['id']}")
        w.tick()
        self.assertEqual(w.store.batch(first["id"])["state"], "FIXING")
        row = w.store.handled_event(first["id"], 50, HEAD1, "ci:42:1")
        self.assertEqual(row["status"], "CLAIMED")
        self.assertIn("ci:42:1", w.adapter.launches[-1]["prompt"])

    def test_ci_completion_requires_new_head_and_matching_comment(self):
        w = self.w
        produce_and_report(w)
        w.tick()
        first = self.open_pr_for(101, 50)
        w.gh.ci_failure = {"kind": "ci", "author": "GitHub Actions", "key": "ci:42:1", "body": "failed"}
        w.store.delete(f"last_poll_{first['id']}")
        w.tick()
        batch = w.store.batch(first["id"])
        run = w.store.runs(first["id"])[0]
        w.store.finish_run(run["id"], 0)
        w.store.set(f"verified_completion_run_{first['id']}", str(run["id"]))
        w.gh.issue_comments_[50] = [{"id": 88, "user": {"login": w.cfg["expected_account"]},
                                      "body": "수정 및 검증 완료\nWarRoom-CI-Event: ci:42:1\nWarRoom-CI-Fix-Head: " + "b" * 40, "created_at": "2099-01-01T00:00:00Z"}]
        self.assertIsNotNone(w.sup._complete_producer_fix_events(batch, {"head_sha": HEAD1}))
        self.assertEqual(w.store.handled_event(first["id"], 50, HEAD1, "ci:42:1")["status"], "CLAIMED")
        self.assertIsNone(w.sup._complete_producer_fix_events(batch, {"head_sha": "b" * 40}))
        self.assertEqual(w.store.handled_event(first["id"], 50, HEAD1, "ci:42:1")["status"], "HANDLED")

    def test_clear_uses_request_owner_when_another_model_sorts_first(self):
        w = self.w
        produce_and_report(w)
        w.tick()
        target = maintainer_row(w)
        w.store.update(target["id"], state="ERROR", pid=None)
        w.store.finish_runs(target["id"], 0)
        w.store.line("aaa", "m")
        self.assertTrue(control.request_clear(w.store, target["producer"], "m", target["id"], 101)[0])
        w.sup._drain.set()
        w.sup._tick_maintenance(collection_only=True)
        self.assertIsNone(w.store.batch(target["id"]))
        self.assertIsNone(w.store.clear_request(target["producer"], "m"))
        self.assertEqual(w.store.maintenance(101)["state"], "HELD")
        self.assertEqual(w.store.peek_line("aaa", "m")["run"], 0)

    def test_blocked_clear_does_not_starve_other_requests(self):
        for blocked_model in ("aaa", "sonnet"):
            with self.subTest(blocked_model=blocked_model):
                w = world()
                self.addCleanup(w.tmp.cleanup)
                produce_and_report(w)
                w.tick()
                target = maintainer_row(w)
                w.store.update(target["id"], state="ERROR", pid=None)
                w.store.finish_runs(target["id"], 0)
                with w.store._conn() as db:
                    blocked = db.execute(
                        "INSERT INTO batches(method,producer,shard,batch,branch,worktree,state,model_tier,created_at,updated_at) "
                        "SELECT method,?,shard,?, ?,worktree,?,model_tier,created_at,updated_at FROM batches WHERE id=?",
                        (blocked_model, "102", "maint-102", "CLEARING", target["id"])).lastrowid
                    db.execute("INSERT INTO clear_requests(batch_id,model,method,status,prior_state,requested_at) "
                               "VALUES(?,?,?,?,?,?)", (blocked, blocked_model, "m", "BLOCKED", "ERROR", 0))
                self.assertTrue(control.request_clear(w.store, target["producer"], "m", target["id"], 101)[0])
                w.sup._drain.set()
                w.sup._tick_maintenance(collection_only=True)
                self.assertIsNone(w.store.batch(target["id"]))
                self.assertEqual(w.store.clear_request(blocked_model, "m", batch_id=blocked)["status"], "BLOCKED")

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
    def test_batch_investigation_allows_saved_tasks_at_finalize_only(self):
        from warroom.maintenance import Maintenance
        for method, kind in (("s2", "s2_deterministic_finalize"), ("s3", "s3_finalize")):
            with self.subTest(method=method):
                source = {"method": method, "run_kind": kind}
                self.assertTrue(Maintenance._batch_investigation_scope(source, [{"state": "SAVED"}]))
                self.assertFalse(Maintenance._batch_investigation_scope(source, [{"state": "FAILED"}]))
                self.assertFalse(Maintenance._batch_investigation_scope(source, [{"state": "SAVED"}, {"state": "RUNNING"}]))
        self.assertFalse(Maintenance._batch_investigation_scope({"method": "s3", "run_kind": "s2_deterministic_finalize"},
                                                                [{"state": "SAVED"}]))

    def test_batch_investigation_allows_saved_s2_tasks_only_for_repair(self):
        from warroom.maintenance import Maintenance
        source = {"method": "s2", "run_kind": "s2_repair_new"}
        self.assertTrue(Maintenance._batch_investigation_scope(source, [{"state": "SAVED"}]))
        self.assertFalse(Maintenance._batch_investigation_scope(source, [{"state": "FAILED"}]))
        self.assertFalse(Maintenance._batch_investigation_scope({"method": "s3", "run_kind": "s2_repair_new"}, [{"state": "SAVED"}]))
    def test_s2_review_fix_investigation_requires_all_tasks_saved(self):
        from warroom.maintenance import Maintenance
        for kind in ("fix_new", "fix_resume"):
            with self.subTest(kind=kind):
                source = {"method": "s2", "run_kind": kind}
                self.assertTrue(Maintenance._batch_investigation_scope(source, [{"state": "SAVED"}]))
                self.assertFalse(Maintenance._batch_investigation_scope(source, [{"state": "SAVED"}, {"state": "FAILED"}]))
                self.assertFalse(Maintenance._batch_investigation_scope({"method": "s3", "run_kind": kind}, [{"state": "SAVED"}]))

    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)

    def prepare_failed_s2_task(self):
        """A parallel Stage 2 Part whose task 002 FAILED (acknowledged) and whose report paused it for Issue 101."""
        w = self.w
        source_wt = w.paths.worktrees / "s2-codex-081-01-01"
        branch = "s2-codex-081-01-01"
        w.git.create_worktree(source_wt, branch, HEAD1)
        batch_id = w.store.create_batch(method="s2", producer="codex", shard="081", batch="01-01",
                                        branch=branch, worktree=str(source_wt), state="PREPARE")
        w.store.line("codex", "s2")
        w.store.update(batch_id, state="PRODUCING", run_kind="s2_parallel")
        w.store.set(stage2.mode_key(batch_id), stage2.PARALLEL)
        report = '{"version":1,"defect_class":"s2-task-report","summary":"저장 결과의 Sense ID 대조 필요"}'
        report_path = source_wt / defects.REPORT_FILE
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(report, "utf-8")
        defect_id = w.store.report_defect(batch_id, defects.report_event_key(batch_id, report), "report",
                                          "s2-task-report", "LINKED", report, "shared_defect", None)
        self.assertIsNotNone(defect_id)
        w.store.update_defect(defect_id, issue_number=101)

        run_log = w.paths.logs / "source-s2-002.log"
        run_log.parent.mkdir(parents=True, exist_ok=True)
        run_log.write_text("official save-chunk rejected task 002", "utf-8")
        w.store.add_tasks(batch_id, [("002", "002")])
        run_id = w.store.add_run(batch_id, "s2_chunk_new", "s2-session-002", None,
                                 run_log, run_log.with_suffix(".exit"), task="002")
        w.store.finish_run(run_id, 0)
        w.store.update_task(batch_id, "002", state="FAILED", run_id=run_id,
                            session_id="s2-session-002", data='{"ack":true}')

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
        batch_id, defect_id, maintainer, request = self.prepare_failed_s2_task()
        scope = {"task": "002", "chunk": "002"}
        summary = "s22의 실제 검색 hit 때문에 Z 저장이 올바르게 거부된 false report였다."
        cause = "원 Sense ID와 저장 거부 진단을 다시 대조했다."
        action = "Stage 2 task 002를 기존 session의 같은 청크에서 다시 판정한다."
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

        # A pre-existing save reflected after approval is not new recovery progress.
        w.store.update_task(batch_id, "002", state="SAVED")
        w.tick()
        self.assertEqual(w.store.defect(defect_id)["state"], "RECOVERING")
        run = w.store.add_run(batch_id, "s2_chunk_resume", "s2-session-002", None, "", "", task="002")
        w.store.finish_run(run, 0)
        w.tick()
        self.assertEqual(w.store.defect(defect_id)["state"], "RELEASED")
        self.assertEqual(w.store.maintenance(101)["state"], "DONE")

class RestartHandoff(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)

    def test_loaded_request_does_not_mask_a_stopped_supervisor(self):
        w = self.w
        write_restart_request(w.paths, {"id": 91, "merge_sha": HEAD1}, None)
        record_runtime(w.paths, HEAD1)
        result = mock.Mock(returncode=0, stdout=HEAD1)
        with mock.patch("warroom.restart_controller._git", return_value=result), \
             mock.patch("warroom.restart_controller._ancestor", return_value=True), \
             mock.patch("warroom.restart_controller._live_runtime_owner", return_value=True), \
             mock.patch("warroom.restart_controller._lock_held", return_value=True):
            self.assertEqual(handle_pending_restart(w.paths, w.store), ("locked", None))
        with mock.patch("warroom.restart_controller._git", return_value=result), \
             mock.patch("warroom.restart_controller._ancestor", return_value=True), \
             mock.patch("warroom.restart_controller._lock_held", return_value=False):
            self.assertIsNone(handle_pending_restart(w.paths, w.store))

    def test_restart_never_waits_for_a_worker_and_the_new_supervisor_consumes_the_pinned_maintainer_stop(self):
        """#5162: an open run, a recorded worker PID and a pinned operator Stop are batch facts for the next instance to
        reconcile, never a reason to keep a stopped Supervisor down."""
        w = self.w
        store = w.store
        store.line("sonnet", "m")
        batch = store.create_batch(method="m", producer="sonnet", shard="", batch="101",
                                   branch="maint-101", worktree="", state="PRODUCING")
        exit_file = Path(w.tmp.name) / "worker.exit"
        store.add_run(batch, "m_new", None, 999999, Path(w.tmp.name) / "worker.log", exit_file)
        store.update(batch, pid=999999)
        self.assertTrue(store.request_stop_pinned("sonnet", "m", batch))
        request = write_restart_request(w.paths, {"id": 91, "merge_sha": HEAD1}, None)
        result = mock.Mock(returncode=0, stdout=HEAD1)
        absent = mock.Mock(returncode=1, stdout="")

        def tmux(args, **kwargs):
            if args[0] == "new-session":
                record_runtime(w.paths, HEAD1, instance="new-instance")
                w.sup._tick_maintenance()
                return result
            return absent

        with mock.patch("warroom.restart_controller._git", return_value=result), \
             mock.patch("warroom.restart_controller._ancestor", return_value=True), \
             mock.patch("warroom.restart_controller._lock_held", return_value=False), \
             mock.patch("warroom.restart_controller._live_runtime_owner", return_value=True), \
             mock.patch("warroom.restart_controller._tmux", side_effect=tmux):
            handle_pending_restart(w.paths, store)       # the run is still open: the start does not wait for it
        self.assertEqual(json.loads(request.read_text())["state"], "loaded")
        self.assertIsNone(store.get("stop_pin_sonnet_m"))
        self.assertEqual(store.line("sonnet", "m")["force_stop"], 0)
        self.assertEqual(store.batch(batch)["state"], "PAUSED")

    def test_operator_reload_is_not_an_incident_and_requires_clean_containing_checkout(self):
        result = mock.Mock(returncode=0, stdout=HEAD1)
        clean = mock.Mock(returncode=0, stdout="")
        with mock.patch("warroom.restart_controller._git", side_effect=[result, clean, clean, result]), \
             mock.patch("warroom.restart_controller._ancestor", return_value=True):
            path = request_operator_restart(self.w.paths, HEAD1)
        request = json.loads(path.read_text())
        self.assertEqual((request["kind"], request["issue"], request["batch_id"], request["merge_sha"]),
                         ("operator_code_reload", None, None, HEAD1))
        self.assertTrue(has_pending_restart(self.w.paths))
        with self.assertRaises(ValueError):
            request_operator_restart(self.w.paths, "bad")
        dirty = mock.Mock(returncode=0, stdout=" M tools/warroom/warroom/supervisor.py")
        with mock.patch("warroom.restart_controller._git", side_effect=[result, dirty]):
            with self.assertRaises(ValueError):
                request_operator_restart(self.w.paths, HEAD1)

    def test_operator_reload_accepts_only_merged_remote_code_before_checkout_update(self):
        head = mock.Mock(returncode=0, stdout=HEAD1)
        clean = mock.Mock(returncode=0, stdout="")
        fetched = mock.Mock(returncode=0, stdout="")
        tip = mock.Mock(returncode=0, stdout="b" * 40)
        wanted = "a" * 40
        with mock.patch("warroom.restart_controller._git", side_effect=[head, clean, fetched, tip]), \
             mock.patch("warroom.restart_controller._ancestor", side_effect=[True, True]):
            path = request_operator_restart(self.w.paths, wanted)
        self.assertEqual(json.loads(path.read_text())["merge_sha"], wanted)
        path.unlink()
        with mock.patch("warroom.restart_controller._git", side_effect=[head, clean, fetched, tip]), \
             mock.patch("warroom.restart_controller._ancestor", side_effect=[True, False]):
            with self.assertRaises(ValueError):
                request_operator_restart(self.w.paths, wanted)
        self.assertFalse(path.exists())

    def test_restart_request_and_loaded_sha_survive_process_boundaries(self):
        w = self.w
        defect = {"id": 91, "issue_number": 92, "batch_id": 93, "merge_sha": HEAD1}
        path = write_restart_request(w.paths, defect, "b" * 40)
        self.assertTrue(path.is_file())
        self.assertTrue(has_pending_restart(w.paths))

        record_runtime(w.paths, HEAD1)
        self.assertTrue(update_restart_request(w.paths, 91, "loaded", loaded_code_sha=HEAD1))
        self.assertFalse(has_pending_restart(w.paths))

    def test_persisted_restart_signal_converts_database_row_once(self):
        w = self.w
        source = produce_and_report(w)
        defect = w.store.defects()[0]
        w.store.update_defect(defect["id"], state="FIX_MERGED", issue_number=101, merge_sha=HEAD1)
        w.store.set(f"restart_needed_{defect['id']}", "1")

        paths = _request_files(w.paths, w.store)
        self.assertEqual(len(paths), 1)
        request = json.loads(paths[0].read_text("utf-8"))
        self.assertEqual((request["defect_id"], request["issue"], request["batch_id"], request["merge_sha"]),
                         (defect["id"], 101, source["id"], HEAD1))
        self.assertTrue(update_restart_request(w.paths, defect["id"], "loaded", loaded_code_sha=HEAD1))
        self.assertEqual(_request_files(w.paths, w.store), paths)
        self.assertEqual(json.loads(paths[0].read_text("utf-8"))["state"], "loaded")


class MergedFixProgress(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)

    def prepare_released_fix(self):
        w = self.w
        source_wt = w.paths.worktrees / "s2-codex-081-01-01"
        branch = "s2-codex-081-01-01"
        w.git.create_worktree(source_wt, branch, HEAD1)
        batch_id = w.store.create_batch(method="s2", producer="codex", shard="081", batch="01-01",
                                        branch=branch, worktree=str(source_wt), state="PREPARE")
        w.store.line("codex", "s2")
        w.store.update(batch_id, state="PRODUCING", run_kind="s2_parallel")
        w.store.add_tasks(batch_id, [("002", "002")])
        w.store.update_task(batch_id, "002", state="FAILED", data='{"ack":true}')
        raw = json.dumps(shared_report(defect_class="s2-merged-recovery", summary="Stage 2 task failure needs shared code repair"))
        defect_id = w.store.report_defect(batch_id, defects.report_event_key(batch_id, raw), "report",
                                          "s2-merged-recovery", "LINKED", raw, "shared_defect", None)
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
