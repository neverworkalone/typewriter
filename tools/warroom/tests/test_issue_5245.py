"""Issue #5245: a Maintainer run ending is not completion. Unfinished attempts continue in the same attempt through
the continuation queue (no round budget); binding values are never rewritten; refused results and failed recovery
authorizations are not reused; queue order is fair; Drain only stops new claims; an incomplete review fix continues."""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest import mock

from tests.fakes import HEAD1
from tests.test_issue_1555 import maintainer_row, produce_and_report, world
from tests import test_issue_3614 as t3614
from tests.test_supervisor import review
from warroom import defects
from warroom.maintenance import CONTINUATION_PAUSE, REJECTION_FILE

DIAG = ".warroom-scratch/incident-diagnosis.json"
REQUEST = ".warroom-scratch/incident-diagnosis-request.json"


def rejection(m) -> dict:
    return json.loads((Path(m["worktree"]) / REJECTION_FILE).read_text("utf-8"))


class NoPrContinuation(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)

    def test_exit_zero_without_pr_or_result_continues_the_same_attempt(self):
        """Old: ERROR "AI가 정상 종료했지만 PR을 찾지 못했습니다" parked until an operator Retry. New: same attempt resumes."""
        w = self.w
        produce_and_report(w)
        w.tick()
        m = maintainer_row(w)
        self.assertEqual(m["state"], "PRODUCING")
        launches = len(w.adapter.launches)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        current = w.store.batch(m["id"])
        self.assertNotEqual(current["state"], "ERROR", current["error"])
        self.assertEqual(rejection(m)["reason"], "no_pr_no_result")
        self.assertIn("PR 또는 version 2 구조화 결과", rejection(m)["contract"])
        w.tick(3)
        current = w.store.batch(m["id"])
        self.assertEqual(current["state"], "PRODUCING")
        self.assertGreater(len(w.adapter.launches), launches)
        relaunch = w.adapter.launches[-1]
        self.assertEqual(relaunch["cwd"], m["worktree"])
        self.assertIn("incident-diagnosis-rejection.json", relaunch["prompt"])   # m_recovery reads the reason first
        self.assertEqual(w.store.maintenance(101)["batch_id"], m["id"])            # same attempt, no new claim
        self.assertEqual(len([b for b in w.store.all_batches() if b["method"] == "m"]), 1)
        resumed = json.loads(w.store.get(f"m_continuation_resumed_{m['id']}"))
        self.assertEqual((resumed["reason"], resumed["kind"]), ("no_pr_no_result", "produce"))

    def test_a_pr_that_appears_while_waiting_is_adopted_on_resume_without_a_new_ai_run(self):
        w = self.w
        produce_and_report(w)
        w.tick()
        m = maintainer_row(w)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        with mock.patch.object(w.sup.maint, "_start"):
            w.tick()
        self.assertEqual(w.store.batch(m["id"])["pause_reason"], CONTINUATION_PAUSE)
        w.pr_info(50, HEAD1, head_ref="maint-101")
        w.gh.by_branch["maint-101"] = [{"number": 50, "state": "OPEN", "headRefOid": HEAD1}]
        w.gh.files[50] = [{"path": "tools/warroom/prompts/m.md"}]
        launches = len(w.adapter.launches)
        w.tick(3)
        current = w.store.batch(m["id"])
        self.assertEqual((current["state"], current["pr_number"]), ("WAITING_REVIEW", 50))
        self.assertEqual(len(w.adapter.launches), launches)

    def test_a_blocked_boundary_stops_with_its_reason_and_is_not_continued(self):
        w = self.w
        produce_and_report(w)
        w.tick()
        m = maintainer_row(w)
        (Path(m["worktree"]) / DIAG).write_text("{}", "utf-8")
        w.store.delete(f"m_base_head_{m['id']}")   # an ownership/integrity fact the Maintainer cannot repair
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick(3)
        current = w.store.batch(m["id"])
        self.assertEqual(current["state"], "ERROR")
        self.assertIn("[maintainer_base_missing]", current["error"])
        self.assertIsNone(w.store.get(f"m_continuation_{m['id']}"))


class StructuredContinuation(unittest.TestCase):
    """Uses the #3614 failed-D-task incident fixture: Maintainer #101 diagnoses source task 002."""

    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)
        self.batch_id, self.defect_id, self.m, self.request = t3614.NoCodeRecovery.prepare_failed_d_task(self)

    def submit(self, **over):
        w, m = self.w, self.m
        request = json.loads((Path(m["worktree"]) / REQUEST).read_text("utf-8"))
        scope = {"task": "002", "chunk": "002"}
        result = {
            "version": 2, "issue": 101, "attempt": m["id"], "round": request["round"],
            "defect_id": self.defect_id, "event_key": request["event_key"], "batch_id": self.batch_id,
            "source_head": request["source_head"], "evidence_sha256": request["evidence_sha256"],
            "scope": scope, "outcome": "investigate", "summary": f"round {request['round']} 조사 요약",
            "cause": f"round {request['round']}에서 확인한 사실", "blocker": None,
            "recovery": {"type": "continue_same_session", **scope, "action": f"round {request['round']} 다음 대조"},
            "next_action": f"round {request['round']} 이후 실행할 구체적 단계",
        }
        result.update(over)
        (Path(m["worktree"]) / DIAG).write_text(json.dumps(result, ensure_ascii=False), "utf-8")
        marker = f"incident-recovery-101-attempt-{m['id']}-round-{result['round']}"
        recovery = result["recovery"] if isinstance(result["recovery"], dict) else {}
        w.gh.comment_issue(101, "\n".join(str(v) for v in (result["summary"], result["cause"], recovery.get("action"),
                                                             result["next_action"], request["evidence_sha256"]))
                           + "\n" + defects.marker(defects.EVENT_MARK, marker))
        return result

    def end_run(self, ticks=3):
        w = self.w
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick(ticks)
        return w.store.batch(self.m["id"])

    def test_investigation_continues_past_the_former_two_round_budget(self):
        """Old: round 2 returned False → ERROR parked. New: every round continues the same attempt and worktree."""
        w, m = self.w, self.m
        for expected_round in range(4):
            self.submit()
            launches = len(w.adapter.launches)
            current = self.end_run()
            self.assertEqual(current["state"], "PRODUCING", current["error"])
            self.assertGreater(len(w.adapter.launches), launches)
            self.assertEqual(w.adapter.launches[-1]["cwd"], m["worktree"])
            self.assertEqual(int(w.store.get(f"m_diagnosis_round_{m['id']}")), expected_round + 1)
            history = Path(m["worktree"]) / ".warroom-scratch/incident-diagnosis-history"
            self.assertEqual(len(list(history.glob("round-*.json"))), expected_round + 1)
        self.assertEqual(w.store.defect(self.defect_id)["state"], "LINKED")
        self.assertEqual(w.store.batch(self.batch_id)["state"], "PAUSED")

    def test_a_late_result_of_an_earlier_round_is_refused_never_rewritten(self):
        w, m = self.w, self.m
        self.submit()
        self.end_run()
        self.assertEqual(int(w.store.get(f"m_diagnosis_round_{m['id']}")), 1)
        stale = self.submit(round=0, next_action="round 0 판단을 늦게 다시 제출")
        self.end_run()
        self.assertEqual(rejection(m)["reason"], "binding_mismatch")
        self.assertEqual(int(w.store.get(f"m_diagnosis_round_{m['id']}")), 1)   # not advanced by the stale result
        self.assertEqual(json.loads((Path(m["worktree"]) / DIAG).read_text("utf-8"))["round"], stale["round"])
        self.assertIsNone(w.store.get(f"no_code_approval_{self.defect_id}"))

    def test_the_same_task_written_differently_is_accepted_but_another_task_is_refused(self):
        w, m = self.w, self.m
        self.submit(scope={"task": "2", "chunk": 2})
        self.end_run()
        self.assertEqual(int(w.store.get(f"m_diagnosis_round_{m['id']}")), 1)   # accepted as the same task 002
        self.submit(scope={"task": "003", "chunk": "003"})
        self.end_run()
        self.assertEqual(rejection(m)["reason"], "scope_other_task")
        self.assertEqual(int(w.store.get(f"m_diagnosis_round_{m['id']}")), 1)

    def test_a_refused_result_resubmitted_unchanged_is_not_new_work(self):
        w, m = self.w, self.m
        bad = {"outcome": "no_code_resume",
               "recovery": {"type": "resume_same_session", "task": "002", "chunk": "002", "action": "기존 세션 재개"}}
        self.submit(**bad)
        self.end_run()
        self.assertEqual(rejection(m)["reason"], "recovery_type")
        # After the reason was handed to it, the next run submits exactly the same refused result again.
        current = self.end_run()
        self.assertEqual(rejection(m)["reason"], "repeated_rejected_result")
        self.assertIn("recovery_type", rejection(m)["fact"])
        self.assertNotEqual(current["state"], "COMPLETE")
        self.assertIsNone(w.store.get(f"no_code_approval_{self.defect_id}"))
        self.assertIsNone(w.store.get(f"m_diag_{m['id']}"))

    def test_a_result_refused_only_for_its_missing_comment_is_accepted_once_the_comment_exists(self):
        w, m = self.w, self.m
        result = self.submit()
        w.gh.issue_comments_[101] = [c for c in w.gh.issue_comments_.get(101, [])
                                     if f"attempt-{m['id']}-round-0" not in c.get("body", "")]
        self.end_run()
        self.assertEqual(rejection(m)["reason"], "comment_missing")
        self.submit(**{k: result[k] for k in ("summary", "cause", "recovery", "next_action")})   # same file + its comment
        self.end_run()
        self.assertEqual(int(w.store.get(f"m_diagnosis_round_{m['id']}")), 1)

    def test_a_recurred_no_code_authorization_is_not_granted_again(self):
        w, m = self.w, self.m
        w.store.set(f"no_code_approval_{self.defect_id}", json.dumps({
            "status": "RECURRENCE", "batch_id": self.batch_id, "task": "002", "chunk": "002"}))
        self.submit(outcome="no_code_resume",
                    recovery={"type": "resume_failed_task", "task": "002", "chunk": "002", "action": "같은 task 재개"})
        with mock.patch.object(w.store, "approve_no_code_resume", wraps=w.store.approve_no_code_resume) as approve:
            current = self.end_run()
        approve.assert_not_called()
        self.assertEqual(rejection(m)["reason"], "repeated_failed_recovery")
        self.assertNotEqual(current["state"], "COMPLETE")
        self.assertEqual(json.loads(w.store.get(f"no_code_approval_{self.defect_id}"))["status"], "RECURRENCE")


class QueueOrder(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)
        w = self.w
        produce_and_report(w)
        w.tick()
        self.m = maintainer_row(w)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        with mock.patch.object(w.sup.maint, "_start"):   # hold the attempt in the queue for the ordering checks
            w.tick()
        self.assertEqual((w.store.batch(self.m["id"])["state"], w.store.batch(self.m["id"])["pause_reason"]),
                         ("PAUSED", CONTINUATION_PAUSE))
        self.assertFalse(w.store.maintenance_batch_open())
        self.waited_at = json.loads(w.store.get(f"m_continuation_{self.m['id']}"))["queued_at"]

    def queue_issue(self, number, at):
        t3614.MaintainerQueue.queue_issue(self, number)
        w = self.w
        self.assertEqual(w.store.maintenance(number)["state"], "QUEUED")
        w.store.set(f"m_queued_at_{number}", repr(at))

    def start(self):
        with mock.patch.object(self.w.sup.maint, "_due", return_value=True):
            self.w.sup.maint._start()

    def test_an_unfinished_attempt_is_not_starved_by_newer_issues(self):
        w, m = self.w, self.m
        self.queue_issue(102, self.waited_at + 10)
        w.store.update(m["id"], error="unrelated row update")   # updated_at moves; the queue time does not
        self.start()
        self.assertEqual(w.store.batch(m["id"])["state"], "PRODUCING")
        self.assertEqual(w.store.maintenance(102)["state"], "QUEUED")

    def test_an_older_new_issue_is_claimed_before_a_later_continuation(self):
        w, m = self.w, self.m
        self.queue_issue(102, self.waited_at - 10)
        self.start()
        self.assertEqual(w.store.maintenance(102)["state"], "ACTIVE")
        self.assertEqual(w.store.batch(m["id"])["state"], "PAUSED")
        self.start()   # the slot is taken by #102: the continuation keeps waiting, never runs alongside it
        self.assertEqual(w.store.batch(m["id"])["state"], "PAUSED")

    def test_drain_stops_new_claims_but_not_an_issue_already_started(self):
        w, m = self.w, self.m
        self.queue_issue(102, self.waited_at - 10)
        w.store.set_line("sonnet", "m", drain=1)
        self.assertTrue(w.store.maintenance_drained())
        self.start()
        self.assertEqual(w.store.batch(m["id"])["state"], "PRODUCING")
        self.assertEqual(w.store.maintenance(102)["state"], "QUEUED")

    def test_stop_clear_and_retry_pin_keep_the_attempt_waiting(self):
        w, m = self.w, self.m
        for control_on, control_off in (
                (lambda: w.store.set_line("sonnet", "m", force_stop=1), lambda: w.store.set_line("sonnet", "m", force_stop=0)),
                (lambda: w.store.set("stop_pin_sonnet_m", str(m["id"])), lambda: w.store.delete("stop_pin_sonnet_m")),
                (lambda: w.store.set_line("sonnet", "m", retry_batch=m["id"]),
                 lambda: w.store.set_line("sonnet", "m", retry_batch=None))):
            control_on()
            self.assertFalse(w.store.resume_maintainer_continuation(m["id"]))
            self.assertEqual(w.store.batch(m["id"])["state"], "PAUSED")
            control_off()
        self.assertTrue(w.store.resume_maintainer_continuation(m["id"]))
        self.assertFalse(w.store.resume_maintainer_continuation(m["id"]))   # one resume per queue entry


class ReviewFixContinuation(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)

    def test_an_incomplete_fix_waits_without_the_slot_then_redoes_only_unanswered_events(self):
        """Old: "Maintainer 수정 실행의 완료 증거가 없습니다" ERROR, which operator Retry re-hit. New: queued continuation."""
        w = self.w
        produce_and_report(w)
        w.tick()
        first = t3614.MaintainerQueue.open_pr_for(self, 101, 50)
        w.gh.reviews_ = [review(71, HEAD1, "-1 correct the issue-scoped fix")]
        w.store.delete(f"last_poll_{first['id']}")
        w.tick()
        fixing = w.store.batch(first["id"])
        self.assertEqual(fixing["state"], "FIXING")
        claim = json.loads(w.store.get(f"fix_claim_{first['id']}"))
        key, = claim["event_keys"]
        # The fix run ends without its PR reply: the event has no answer evidence.
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        with mock.patch.object(w.sup.maint, "_start"):
            w.tick(4)
        waiting = w.store.batch(first["id"])
        self.assertEqual((waiting["state"], waiting["pause_reason"], waiting["paused_from"]),
                         ("PAUSED", CONTINUATION_PAUSE, "FIXING"), waiting["error"])
        self.assertFalse(w.store.maintenance_batch_open())   # waiting never holds the AI slot
        self.assertEqual(rejection(first)["reason"], "fix_incomplete")
        launches = len(w.adapter.launches)
        w.tick(3)
        resumed = w.store.batch(first["id"])
        self.assertEqual(resumed["state"], "FIXING")
        self.assertEqual(len(w.adapter.launches), launches + 1)
        self.assertEqual(json.loads(w.store.get(f"fix_claim_{first['id']}"))["event_keys"], [key])
        self.assertEqual(resumed["pr_number"], 50)


if __name__ == "__main__":
    unittest.main()


class RecurrenceReintake(unittest.TestCase):
    """A recovery that recurs before it is verified continues on the Issue that owns it, as a real follow-up attempt."""

    def test_merged_fix_recurrence_starts_a_separate_attempt_that_never_adopts_the_merged_pr(self):
        from tests import test_issue_1555 as t1555
        proof = t1555.IncidentRecoveryProof()
        proof.setUp()
        self.addCleanup(proof.tearDown)
        w = proof.w
        b = t1555.make_batch(w, "d", run_kind="d_chunk_resume", session_id="ses_1")
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="boom")
        w.store.set(f"error_evidence_{b['id']}_1", json.dumps(proof.EVIDENCE))
        w.git.changed[t1555.MERGE] = [proof.PROMPT]
        w.tick(2)
        d, = t1555.incidents(w)
        proof.merge_fix(b, d)
        proof.settle(d)
        first = maintainer_row(w)
        self.assertEqual((first["branch"], first["pr_number"], first["state"]), ("maint-101", 50, "COMPLETE"))
        w.gh.issues[101] = {"state": "closed", "labels": ["urgent"], "title": "Issue 101", "body": "fixed"}  # Closes #101
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="again after the fix")
        w.store.set(f"error_evidence_{b['id']}_2", json.dumps(proof.EVIDENCE))
        w.tick(3)
        attempts = [x for x in w.store.all_batches() if x["method"] == "m" and x["batch"] == "101"]
        self.assertEqual(len(attempts), 2)
        follow = attempts[-1]
        self.assertEqual(w.gh.issues[101]["state"], "open")   # reopened for the follow-up fix
        self.assertEqual((follow["branch"], follow["shard"]), ("maint-101-2", "issue-2"))
        self.assertEqual(w.store.maintenance(101)["batch_id"], follow["id"])
        again = t1555.incidents(w)[-1]
        evidence = json.loads((Path(follow["worktree"]) / f".warroom-scratch/incident/{again['id']}.json").read_text("utf-8"))
        prior = {row["defect_id"]: row for row in evidence["prior_recoveries"]}
        self.assertIn("defect_recovery", prior[d["id"]])     # the earlier fix receipt is reference evidence
        self.assertEqual(json.loads(prior[d["id"]]["defect_recovery"])["status"], "RECURRENCE")
        # The follow-up ends without its own PR: the merged PR #50 on the first attempt's branch is never adopted.
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick(2)
        follow = w.store.batch(follow["id"])
        self.assertIsNone(follow["pr_number"])
        self.assertNotIn(follow["state"], ("WAITING_REVIEW", "COMPLETE", "ERROR"), follow["error"])
        w.tick(3)   # duplicate sweeps create no third attempt
        self.assertEqual(len([x for x in w.store.all_batches() if x["method"] == "m" and x["batch"] == "101"]), 2)

    def test_no_code_recurrence_requeues_the_same_issue_and_refuses_the_spent_authorization(self):
        w = world()
        self.addCleanup(w.tmp.cleanup)
        self.w = w
        batch_id, defect_id, m, request = t3614.NoCodeRecovery.prepare_failed_d_task(self)
        scope = {"task": "002", "chunk": "002"}
        texts = ("오진이었다", "Sense ID를 다시 대조했다", "task 002를 기존 세션에서 다시 판정한다", "002의 공식 저장을 확인한다")
        result = {"version": 2, "issue": 101, "attempt": m["id"], "round": request["round"], "defect_id": defect_id,
                  "event_key": request["event_key"], "batch_id": batch_id, "source_head": request["source_head"],
                  "evidence_sha256": request["evidence_sha256"], "scope": scope, "outcome": "no_code_resume",
                  "summary": texts[0], "cause": texts[1], "blocker": None, "next_action": texts[3],
                  "recovery": {"type": "resume_failed_task", **scope, "action": texts[2]}}
        (Path(m["worktree"]) / DIAG).write_text(json.dumps(result, ensure_ascii=False), "utf-8")
        w.gh.comment_issue(101, "\n".join((*texts, request["evidence_sha256"], defects.marker(
            defects.EVENT_MARK, f"incident-recovery-101-attempt-{m['id']}-round-{request['round']}"))))
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.store.maintenance(101)["state"], "RECOVERING")
        for run in w.store.open_task_runs(batch_id):   # the resumed task's worker stops without saving
            w.store.finish_run(run["id"], 1)
        w.store.update_task(batch_id, "002", state="FAILED")
        source = w.store.batch(batch_id)
        w.store.update(batch_id, pid=None)
        w.sup._fail(source, "ERROR", "task 002가 재개 후 다시 저장 거부")
        w.intake = True
        w.sup.maint.__dict__.pop("_intake_errors", None)
        w.tick(4)
        attempts = [x for x in w.store.all_batches() if x["method"] == "m" and x["batch"] == "101"]
        self.assertEqual(len(attempts), 2, [x["state"] for x in attempts])
        follow = attempts[-1]
        self.assertEqual(follow["branch"], "maint-101-2")
        self.assertEqual(w.store.defect(defect_id)["state"], "OVERRIDDEN")
        self.assertEqual(json.loads(w.store.get(f"no_code_approval_{defect_id}"))["status"], "RECURRENCE")
        again = [d for d in w.store.defects() if d["source"] == "incident"][-1]
        self.assertEqual((again["issue_number"], again["state"]), (101, "LINKED"))
        self.assertEqual((w.store.batch(batch_id)["state"], w.store.batch(batch_id)["defect_id"]), ("PAUSED", again["id"]))

    def test_the_follow_up_diagnoses_the_new_evidence_and_cannot_reuse_the_spent_resume(self):
        self.test_no_code_recurrence_requeues_the_same_issue_and_refuses_the_spent_authorization()
        w = self.w
        follow = [x for x in w.store.all_batches() if x["method"] == "m" and x["batch"] == "101"][-1]
        self.assertEqual(follow["state"], "PRODUCING")
        request = json.loads((Path(follow["worktree"]) / REQUEST).read_text("utf-8"))
        again = [d for d in w.store.defects() if d["source"] == "incident"][-1]
        self.assertEqual((request["attempt"], request["defect_id"]), (follow["id"], again["id"]))
        evidence = json.loads((Path(follow["worktree"]) / f".warroom-scratch/incident/{again['id']}.json").read_text("utf-8"))
        self.assertEqual(evidence["envelope"]["error_seq"], w.store.batch(again["batch_id"])["error_seq"])

        def submit(outcome, recovery):
            scope = {"task": "002", "chunk": "002"}
            texts = (f"{outcome} 요약", f"{outcome} 원인", recovery["action"], f"{outcome} 다음 단계")
            data = {"version": 2, "issue": 101, "attempt": follow["id"], "round": request["round"],
                    "defect_id": again["id"], "event_key": again["event_key"], "batch_id": again["batch_id"],
                    "source_head": request["source_head"], "evidence_sha256": request["evidence_sha256"],
                    "scope": scope, "outcome": outcome, "summary": texts[0], "cause": texts[1], "blocker": None,
                    "next_action": texts[3], "recovery": {**recovery, **scope}}
            (Path(follow["worktree"]) / DIAG).write_text(json.dumps(data, ensure_ascii=False), "utf-8")
            w.gh.comment_issue(101, "\n".join((*texts, request["evidence_sha256"], defects.marker(
                defects.EVENT_MARK, f"incident-recovery-101-attempt-{follow['id']}-round-{request['round']}"))))
            w.adapter.finish(w.adapter.launches[-1]["pid"])
            w.tick(3)

        submit("no_code_resume", {"type": "resume_failed_task", "action": "같은 task 002를 다시 재개"})
        self.assertEqual(rejection(follow)["reason"], "repeated_failed_recovery")
        self.assertNotEqual(json.loads(w.store.get(f"no_code_approval_{again['id']}") or "{}").get("status"), "APPROVED")
        submit("investigate", {"type": "continue_same_session", "action": "저장 거부 경로를 재현해 공통 원인을 찾는다"})
        self.assertEqual(int(w.store.get(f"m_diagnosis_round_{follow['id']}")), 1)   # accepted on the current evidence


# ---- #5256: transient queries in the diagnosis path; atomic continuation handoff --------------------------------------
class Died(BaseException):
    """A Supervisor process death: not an Exception, so no tick handler absorbs it."""


def restart(w):
    w.sup = w.make_sup()
    w.sup_runner_ok()


def fail_once(obj, name, exc):
    original = getattr(obj, name)
    calls = []

    def wrapped(*args, **kwargs):
        calls.append(args)
        if len(calls) == 1:
            raise exc
        return original(*args, **kwargs)
    setattr(obj, name, wrapped)
    return calls


class TransientDiagnosisQuery(unittest.TestCase):
    """Old: a GitHub query failure became BLOCKED(validation_exception) → ERROR + operator Retry; a Git one DEFERRED,
    which the next tick turned into a new AI launch. New: only the same ended run's judgement is retried with backoff."""

    setUp, submit, end_run = StructuredContinuation.setUp, StructuredContinuation.submit, StructuredContinuation.end_run

    def assert_waits_then_continues(self, calls, *, restart_between=False):
        w, m = self.w, self.m
        self.submit()
        launches = len(w.adapter.launches)
        current = self.end_run(ticks=1)
        self.assertEqual((current["state"], current["error"]), ("PRODUCING", None))
        self.assertEqual(json.loads(w.store.get(f"pending_{m['id']}"))["stage"], "exit0")
        self.assertEqual(len(w.adapter.launches), launches)        # no AI run while the query is failing
        self.assertEqual(int(w.store.get(f"m_diagnosis_round_{m['id']}", "0")), 0)
        self.assertFalse((Path(m["worktree"]) / REJECTION_FILE).exists())
        if restart_between:
            restart(w)
        w.now += 3600   # the query backoff elapsed
        w.tick(3)
        self.assertGreaterEqual(len(calls), 2)
        self.assertEqual(int(w.store.get(f"m_diagnosis_round_{m['id']}")), 1)   # the same result was verified
        self.assertEqual(len(w.adapter.launches), launches + 1)                   # one continuation, no duplicate
        self.assertEqual(w.store.batch(m["id"])["state"], "PRODUCING")
        self.assertIsNone(w.store.get(f"pending_{m['id']}"))

    def fail_inside_judgement(self, name, exc):
        """Fail the first `name` lookup made BY the structured judgement (not the PR discovery before it)."""
        w, calls, armed = self.w, [], []
        original, judge = getattr(w.gh, name), w.sup.maint._finish_structured_diagnosis

        def lookup(*args, **kwargs):
            if armed:
                calls.append(args)
                if len(calls) == 1:
                    raise exc
            return original(*args, **kwargs)

        def judging(*args, **kwargs):
            armed.append(True)
            return judge(*args, **kwargs)
        setattr(w.gh, name, lookup)
        w.sup.maint._finish_structured_diagnosis = judging
        return calls

    def test_issue_comment_lookup_failure_is_re_judged_not_blocked(self):
        from warroom.github import GhTransient
        calls = self.fail_inside_judgement("issue_comments", GhTransient("gh api: HTTP 502"))
        self.assert_waits_then_continues(calls)

    def test_pr_lookup_failure_is_re_judged_across_a_supervisor_restart(self):
        from warroom.github import GhTransient
        calls = self.fail_inside_judgement("prs_for_branch", GhTransient("gh pr list: connection reset"))
        self.assert_waits_then_continues(calls, restart_between=True)

    def test_git_query_failure_is_re_judged_without_relaunching_the_ai(self):
        from warroom.gitops import GitTransient
        calls = fail_once(self.w.sup.maint, "_git_facts", GitTransient("index.lock"))
        self.assert_waits_then_continues(calls)

    def test_a_real_evidence_mismatch_is_still_blocked(self):
        w, m = self.w, self.m
        self.submit()
        evidence = Path(m["worktree"]) / f".warroom-scratch/incident/{self.defect_id}.json"
        evidence.write_text(evidence.read_text("utf-8") + " ", "utf-8")   # the preserved evidence no longer matches
        current = self.end_run()
        self.assertEqual(current["state"], "ERROR")
        self.assertIn("[evidence_integrity]", current["error"])


class TransientLegacyDiagnosis(unittest.TestCase):
    def test_legacy_handoff_comment_lookup_failure_reaches_the_proven_handoff(self):
        from tests import test_issue_1555 as t1555
        from warroom.github import GhTransient
        case = t1555.AutonomousIncident()
        case.setUp()
        self.addCleanup(case.tearDown)
        w = case.w
        judge = w.sup.maint._judge_diagnosis_file
        state = {"armed": False}

        def judge_once(*args, **kwargs):   # fail the first comment lookup made BY the diagnosis judgement
            if not state["armed"]:
                state["armed"] = True
                fail_once(w.gh, "issue_comments", GhTransient("gh api: HTTP 503"))
            return judge(*args, **kwargs)
        w.sup.maint._judge_diagnosis_file = judge_once
        w, m = case.diagnose(blocked=True)
        self.assertNotEqual(m["state"], "ERROR", m["error"])
        w.now += 3600
        w.tick(3)
        self.assertEqual(w.store.batch(m["id"])["state"], "COMPLETE")   # the proven handoff completed after the retry
        self.assertEqual(w.store.maintenance(101)["state"], "HELD")


class AtomicContinuationHandoff(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)
        produce_and_report(self.w)
        self.w.tick()
        self.m = maintainer_row(self.w)

    def die_at_handoff_end(self):
        """Kill the Supervisor at the last write of the handoff, whichever shape it has (old: the pause_reason update
        after PAUSED was committed; new: the event inside the one reservation transaction)."""
        from warroom.store import Store
        update, add_event = Store.update, Store._add_event

        def dying_update(store, batch_id, **fields):
            if fields.get("pause_reason") == CONTINUATION_PAUSE:
                raise Died()
            return update(store, batch_id, **fields)

        def dying_event(c, batch_id, msg, **kwargs):
            if "Maintainer 작업 미완료" in msg:
                raise Died()
            return add_event(c, batch_id, msg, **kwargs)
        return mock.patch.multiple(Store, update=dying_update, _add_event=staticmethod(dying_event))

    def test_a_stop_during_the_handoff_never_loses_the_attempt(self):
        w, m = self.w, self.m
        launches = len(w.adapter.launches)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        with self.die_at_handoff_end(), self.assertRaises(Died):
            w.tick()
        restart(w)
        current = w.store.batch(m["id"])
        self.assertIn((current["state"], current["pause_reason"]),
                      (("PRODUCING", ""), ("PRODUCING", None)))      # rolled back: no half handoff
        self.assertIsNone(w.store.get(f"m_continuation_{m['id']}"))
        w.tick(3)   # re-entry judges the same ended run again, hands it off and the queue resumes it
        self.assertEqual(json.loads(w.store.get(f"m_continuation_resumed_{m['id']}"))["reason"], "no_pr_no_result")
        self.assertEqual(w.store.batch(m["id"])["state"], "PRODUCING")
        self.assertEqual(len(w.adapter.launches), launches + 1)

    def test_a_committed_handoff_survives_a_restart_and_a_repeat_keeps_its_queue_time(self):
        w, m = self.w, self.m
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        with mock.patch.object(w.sup.maint, "_start"):
            w.tick()
        record = json.loads(w.store.get(f"m_continuation_{m['id']}"))
        w.now += 100
        w.sup.maint.continue_later(w.store.batch(m["id"]), "no_pr_no_result", "repeat of the same ended run", "produce")
        self.assertEqual(json.loads(w.store.get(f"m_continuation_{m['id']}"))["queued_at"], record["queued_at"])
        restart(w)
        launches = len(w.adapter.launches)
        w.tick(3)
        self.assertEqual(w.store.batch(m["id"])["state"], "PRODUCING")
        self.assertEqual(len(w.adapter.launches), launches + 1)

    def test_a_failed_description_file_keeps_the_reservation_and_is_rewritten_on_resume(self):
        from warroom import maintenance
        w, m = self.w, self.m
        real = os.replace

        def failing_replace(src, dst):
            if str(dst).endswith("incident-diagnosis-rejection.json"):
                raise OSError("disk full")
            return real(src, dst)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        with mock.patch.object(maintenance.os, "replace", failing_replace), mock.patch.object(w.sup.maint, "_start"):
            w.tick()
        self.assertEqual(w.store.batch(m["id"])["pause_reason"], CONTINUATION_PAUSE)
        self.assertIsNotNone(w.store.get(f"m_continuation_{m['id']}"))
        self.assertFalse((Path(m["worktree"]) / REJECTION_FILE).exists())
        w.tick(3)
        self.assertEqual(rejection(m)["reason"], "no_pr_no_result")   # rewritten from the DB record before the run

    def test_stop_clear_and_a_live_run_are_never_overwritten_by_a_handoff(self):
        w, m = self.w, self.m
        run_id = w.store.runs(m["id"])[0]["id"]
        args = dict(expected_state="PRODUCING", run_id=run_id, record={"kind": "produce", "reason": "x"}, error="x")
        self.assertEqual(w.store.reserve_maintainer_continuation(m["id"], **args), "REFUSED")   # still running
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.store.finish_runs(m["id"], 0, clear_pid=True)
        w.store.set_line("sonnet", "m", force_stop=1)
        self.assertEqual(w.store.reserve_maintainer_continuation(m["id"], **args), "REFUSED")
        w.store.set_line("sonnet", "m", force_stop=0)
        w.store.set("stop_pin_sonnet_m", str(m["id"]))
        self.assertEqual(w.store.reserve_maintainer_continuation(m["id"], **args), "REFUSED")
        w.store.delete("stop_pin_sonnet_m")
        self.assertEqual(w.store.reserve_maintainer_continuation(m["id"], **{**args, "run_id": run_id - 1}), "REFUSED")
        self.assertEqual(w.store.batch(m["id"])["state"], "PRODUCING")
        self.assertEqual(w.store.reserve_maintainer_continuation(m["id"], **args), "RESERVED")
        self.assertEqual(w.store.reserve_maintainer_continuation(m["id"], **args), "ALREADY")
