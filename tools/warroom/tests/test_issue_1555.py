"""Issue #1555: structured shared defect -> PAUSED batch -> one urgent Issue -> hidden serial Maintainer -> merged PR +
Maintainer cleanup -> fix applied to the paused batch and verified -> exactly one automatic Retry. Fake AI/GitHub/git
plus a real-git section (temp repo, linked worktree with uncommitted partial output)."""
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.fakes import HEAD1, HEAD2, World
from tests.test_lines import PRODUCERS, multi_world
from tests.test_supervisor import review
from warroom import control, defects, prompts
from warroom.config import config_problem, maintainer_problem, reload_problem, registry
from warroom.gitops import Git, IntegrationBlocked
from warroom.shell import Runner
from warroom.store import SCHEMA_VERSION, Store
from warroom.supervisor import Supervisor

MERGE = "c" * 40


def report(**over):
    r = {"version": 1, "defect_class": "span-in-jsonl-form", "summary": "validator accepts clause-like candidates",
         "failing_cases": ["C000123 → 걸음을 옮기며 걷는다", "C000456 → 말을 건네며 웃는다"],
         "reproduction": "node scripts/validate/candidate-form.mjs <file>", "root_cause": "form gate ignores predicates",
         "scope": "all existing and future A/B batches", "proposed_fix": "reject predicate endings",
         "regression": "table over predicate endings"}
    r.update(over)
    return {k: v for k, v in r.items() if v is not None}


def world(maintainer="sonnet"):
    w = multi_world()
    w.cfg["maintainer"] = maintainer
    return w


def write_report(w, row, data=None, raw=None):
    f = Path(row["worktree"]) / defects.REPORT_FILE
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(raw if raw is not None else json.dumps(data or report()))


def produce_and_report(w, model="deepseek", method="a", data=None, raw=None):
    """A Line produces, its AI writes a shared-defect report, War Room pauses exactly that batch."""
    w.start("single", model, method)
    w.adapter.plan.append({"code": 0, "session": f"ses_{model}_{method}"})
    w.tick()
    row = w.row(model, method)
    assert row["state"] == "PRODUCING", row["state"]
    write_report(w, row, data, raw)
    w.tick(2)    # the first tick only notes the file (it may still be mid-write); the second acts on it
    return w.row(model, method)


def maintainer_row(w):
    return next((b for b in w.store.all_batches() if b["method"] == "m"), None)


def run_maintainer_to_merge(w, issue, pr=50, merge_sha=MERGE):
    """Maintainer launches, opens its PR, the PR is merged and the Maintainer is cleaned up."""
    w.tick()   # PREPARE -> PRODUCING
    m = maintainer_row(w)
    assert m["state"] == "PRODUCING", m["state"]
    branch = f"maint-{issue}"

    def opened():
        w.pr_info(pr, HEAD1, head_ref=branch)
        w.gh.by_branch[branch] = [{"number": pr, "state": "OPEN", "headRefOid": HEAD1}]
    opened()
    w.adapter.finish(w.adapter.launches[-1]["pid"])
    w.tick()
    assert maintainer_row(w)["state"] == "WAITING_REVIEW"
    w.pr_info(pr, HEAD1, state="closed", merged=True, head_ref=branch, merge_sha=merge_sha)
    w.tick(3)   # merged=true -> MERGED -> CLEANUP -> COMPLETE


class SharedDefectFlow(unittest.TestCase):
    def setUp(self):
        self.w = world()

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_report_to_single_retry_after_merge_and_cleanup(self):
        w = self.w
        b = produce_and_report(w)
        # the batch is PAUSED for the defect, nothing of it is lost, and exactly one urgent Issue exists
        self.assertEqual((b["state"], b["pause_reason"], b["paused_from"]), ("PAUSED", "shared_defect", "PRODUCING"))
        self.assertEqual(b["session_id"], "ses_deepseek_a")
        self.assertTrue(Path(b["worktree"]).exists())
        self.assertEqual(w.gh.created, [101])
        issue = w.gh.issues[101]
        self.assertEqual(issue["labels"], ["urgent"])
        for needle in ("span-in-jsonl-form", "C000123", "001_01", "deepseek", "a-deepseek-001-01", "node scripts/validate"):
            self.assertIn(needle, issue["body"])
        d = w.store.defects()[0]
        self.assertEqual((d["state"], d["issue_number"], d["batch_id"]), ("LINKED", 101, b["id"]))
        # the yellow line shows the real state of the persisted work
        self.assertIn("urgent issue #101", control.urgent_line(w.store, w.cfg))
        # the hidden Maintainer: one slot, own worktree off the base branch, the configured producer, no Board card
        m = maintainer_row(w)
        self.assertEqual((m["method"], m["producer"], m["branch"], m["batch"]), ("m", "sonnet", "maint-101", "101"))
        self.assertEqual(control.line_status(w.store, "sonnet", "a")["batch"], None)
        w.tick()
        launch = w.adapter.launches[-1]
        self.assertEqual((launch["kind"], launch["cwd"]), ("start", str(w.paths.worktrees / "maint-101")))
        self.assertIn("#101", launch["prompt"])
        self.assertNotIn("shared-defect", launch["prompt"])
        self.assertEqual(launch["model"], "p/sonnet-free")
        self.assertIn("urgent issue #101 · Maintainer WORKING >> 수정 중 · PR 생성 전", control.urgent_line(w.store, w.cfg))
        # while the Maintainer works nothing resumes the paused batch, however many ticks pass
        w.tick(4)
        self.assertEqual(w.row()["state"], "PAUSED")
        launches = len(w.adapter.launches)

        w.pr_info(50, HEAD1, head_ref="maint-101")
        w.gh.by_branch["maint-101"] = [{"number": 50, "state": "OPEN", "headRefOid": HEAD1}]
        w.adapter.finish(launch["pid"])
        w.tick()
        self.assertEqual(maintainer_row(w)["state"], "WAITING_REVIEW")
        self.assertIn("urgent issue #101 · PR #50 · 리뷰 대기", control.urgent_line(w.store, w.cfg))
        # a PR that is open, approved or merely green is never a release trigger
        w.gh.reviews_ = [review(21, HEAD1, "+2")]
        w.tick(3)
        self.assertEqual(w.row()["state"], "PAUSED")

        # merged=true but the Maintainer's cleanup is blocked: still no release
        w.git.block = "dirty maintainer worktree"
        w.pr_info(50, HEAD1, state="closed", merged=True, head_ref="maint-101", merge_sha=MERGE)
        w.tick(3)
        self.assertEqual(maintainer_row(w)["state"], "ERROR")
        self.assertIn("Maintainer ERROR", control.urgent_line(w.store, w.cfg))
        self.assertEqual((w.row()["state"], w.store.defects()[0]["state"]), ("PAUSED", "LINKED"))
        self.assertEqual(w.git.integrated, [])
        # operator fixes the cleanup problem and retries the Maintainer: now merged + cleaned -> fix applied -> one Retry
        w.git.block = None
        self.assertTrue(control.retry_maintainer(w.store))
        w.tick(3)
        self.assertEqual(maintainer_row(w)["state"], "COMPLETE")
        self.assertEqual(w.git.integrated, [(b["worktree"], MERGE)])
        b = w.row()
        self.assertEqual((b["state"], b["pause_reason"], b["defect_id"], b["error"]), ("PRODUCING", "", None, None))
        d = w.store.defects()[0]
        self.assertEqual((d["state"], d["merge_sha"]), ("RELEASED", MERGE))
        self.assertEqual(control.urgent_line(w.store, w.cfg), "")
        # the retry resumed the SAME session in the SAME worktree; ticking on never retries again
        w.tick()
        relaunch = w.adapter.launches[-1]
        self.assertEqual((relaunch["kind"], relaunch["session"], relaunch["cwd"]), ("resume", "ses_deepseek_a", b["worktree"]))
        w.tick(5)
        self.assertEqual(len(w.adapter.launches), launches + 1)       # exactly one relaunch of the batch AI
        self.assertEqual(len(w.gh.created), 1)

    def test_unconfigured_maintainer_keeps_report_issue_and_pause_but_runs_nothing(self):
        w = world(maintainer=None)
        b = produce_and_report(w)
        self.assertEqual((b["state"], b["pause_reason"]), ("PAUSED", "shared_defect"))
        self.assertEqual(w.gh.created, [101])
        w.tick(5)
        self.assertIsNone(maintainer_row(w))
        self.assertIn("Maintainer 미설정", control.urgent_line(w.store, w.cfg))
        w.tmp.cleanup()

    def test_only_the_reporting_batch_pauses(self):
        w = self.w
        w.start("single", "deepseek", "b")
        w.adapter.plan.append({"code": 0, "session": "ses_b"})
        w.tick()
        b_row = w.row("deepseek", "b")
        produce_and_report(w, "deepseek", "a")
        self.assertEqual(w.row("deepseek", "b")["state"], "PRODUCING")
        self.assertEqual(w.row("deepseek", "b")["id"], b_row["id"])
        self.assertEqual(w.row("deepseek", "a")["state"], "PAUSED")
        self.assertEqual(w.row("deepseek", "b")["pause_reason"], "")


class IdempotentIssue(unittest.TestCase):
    def setUp(self):
        self.w = world(maintainer=None)

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_same_event_twice_and_restart_create_one_issue_and_one_defect(self):
        w = self.w
        b = produce_and_report(w)
        raw = (Path(b["worktree"]) / defects.REPORT_FILE).read_text()
        key = defects.report_event_key(b["id"], raw)
        w.sup.maint.report(b, "report", key, raw)                     # duplicate delivery of the same event
        w.sup.maint.report(w.row(), "report", key, raw)
        w.sup = w.make_sup()                                          # Supervisor restart over the same DB
        w.tick(4)
        self.assertEqual((len(w.store.defects()), w.gh.created), (1, [101]))
        self.assertEqual(w.row()["state"], "PAUSED")

    def test_failed_create_keeps_everything_then_a_crash_after_create_links_instead_of_duplicating(self):
        w = self.w
        w.gh.fail_create = True
        b = produce_and_report(w)
        w.tick(3)
        self.assertEqual((w.row()["state"], w.store.defects()[0]["state"], w.gh.created), ("PAUSED", "REPORTED", []))
        self.assertTrue(Path(b["worktree"]).exists())
        # the Issue got created but the Supervisor died before recording it: simulate by creating it behind its back
        d = w.store.defects()[0]
        report_, facts = w.sup.maint._split(d)
        w.gh.fail_create = False
        number = w.gh.create_issue(defects.issue_title(report_), defects.issue_body(report_, d["event_key"], facts, "report"), ["urgent"])
        w.tick(3)
        self.assertEqual((w.gh.created, w.store.defects()[0]["issue_number"], w.store.defects()[0]["state"]), ([number], number, "LINKED"))
        w.gh.fail_list = True
        w.tick(2)                                                     # GitHub down: state kept, nothing duplicated
        self.assertEqual(w.gh.created, [number])

    def test_unreachable_github_never_loses_the_report(self):
        w = self.w
        w.gh.fail_list = True
        produce_and_report(w)
        w.tick(3)
        self.assertEqual((w.store.defects()[0]["state"], w.row()["state"]), ("REPORTED", "PAUSED"))
        w.gh.fail_list = False
        w.tick()
        self.assertEqual((w.store.defects()[0]["state"], w.gh.created), ("LINKED", [101]))

    def test_second_batch_of_the_same_class_joins_the_open_issue(self):
        w = self.w
        produce_and_report(w, "deepseek", "a")
        produce_and_report(w, "sonnet", "a")
        self.assertEqual(w.gh.created, [101])
        self.assertEqual({d["issue_number"] for d in w.store.defects()}, {101})
        self.assertEqual(len(w.gh.issue_comments_[101]), 1)
        w.tick(3)
        self.assertEqual(len(w.gh.issue_comments_[101]), 1)           # the link comment is added once
        # a different class gets its own Issue
        produce_and_report(w, "deepseek", "b", data=report(defect_class="another-class"))
        self.assertEqual(w.gh.created, [101, 102])


class ReportEvidence(unittest.TestCase):
    CASES = [
        ("plain text", dict(raw="이건 공통 결함인 것 같다 shared defect")),
        ("not an object", dict(raw="[1, 2]")),
        ("one failing case only", dict(data=report(failing_cases=["only one"]))),
        ("duplicate failing cases", dict(data=report(failing_cases=["same", "same"]))),
        ("missing reproduction", dict(data=report(reproduction=None))),
        ("blank root cause", dict(data=report(root_cause="  "))),
        ("bad class slug", dict(data=report(defect_class="Bad Class"))),
        ("unknown field", dict(data={**report(), "note": "x"})),
        ("wrong version", dict(data=report(version=2))),
        ("failing_cases not strings", dict(data=report(failing_cases=[1, 2]))),
    ]

    def test_insufficient_evidence_holds_the_batch_without_an_issue_and_retry_resumes(self):
        for name, kw in self.CASES:
            with self.subTest(name):
                w = world()
                b = produce_and_report(w, **kw)
                self.assertEqual((b["state"], b["pause_reason"]), ("PAUSED", "defect_unverified"), name)
                self.assertEqual(w.gh.created, [])
                self.assertEqual(w.store.defects()[0]["state"], "UNVERIFIED")
                self.assertIsNone(maintainer_row(w))
                self.assertEqual(control.urgent_line(w.store, w.cfg), "")
                w.tick(3)
                self.assertEqual(w.gh.created, [])
                # an ordinary Retry works for this pause (it is not a shared-defect pause) and the same file is not re-read
                self.assertTrue(control.retry(w.store, "deepseek", "a"))
                w.tick(2)
                self.assertEqual(w.row()["state"], "PRODUCING")
                self.assertEqual((len(w.store.defects()), w.gh.created), (1, []))
                w.tmp.cleanup()

    def test_valid_but_unusual_reports_are_accepted(self):
        for name, data in [("max cases", report(failing_cases=[f"c{i}" for i in range(20)])),
                           ("unicode and markers in text", report(summary="`--> <!-- warroom-defect-class:x --> 한글 ✓")),
                           ("minimal slug", report(defect_class="abc"))]:
            with self.subTest(name):
                w = world(maintainer=None)
                b = produce_and_report(w, data=data)
                self.assertEqual(b["pause_reason"], "shared_defect")
                body = w.gh.issues[101]["body"]
                # report text can neither forge nor end an identity marker
                self.assertEqual({v for k, v in defects.markers(body) if k == defects.CLASS_MARK}, {data["defect_class"]})
                w.tmp.cleanup()

    def test_a_report_being_written_is_not_acted_on_until_stable(self):
        w = self.w = world()
        w.start("single", "deepseek", "a")
        w.adapter.plan.append({"code": 0})
        w.tick()
        write_report(w, w.row(), raw='{"version": 1, "defect_cl')
        w.tick()
        write_report(w, w.row(), data=report())      # the AI finished writing between ticks
        w.tick()
        self.assertEqual(w.row()["state"], "PRODUCING")
        w.tick()
        self.assertEqual((w.row()["pause_reason"], w.gh.created), ("shared_defect", [101]))
        w.tmp.cleanup()

    def test_a_finished_ai_with_a_report_is_paused_not_reported_as_a_missing_pr(self):
        w = self.w = world()
        w.start("single", "deepseek", "a")
        w.adapter.plan.append({"code": 0, "session": "s"})
        w.tick()
        write_report(w, w.row())
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual((w.row()["state"], w.row()["pause_reason"]), ("PAUSED", "shared_defect"))
        w.tmp.cleanup()

    def test_ordinary_failures_are_not_shared_defects(self):
        w = self.w = world()
        w.start("single", "deepseek", "a")
        w.adapter.plan.append({"code": 1, "text": "401 unauthorized: please login", "session": "s"})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        b = w.row()
        self.assertEqual((b["state"], b["pause_reason"]), ("PAUSED", ""))
        self.assertEqual((w.store.defects(), w.gh.created), ([], []))
        w.tmp.cleanup()


class ReviewEscalation(unittest.TestCase):
    def test_trusted_reviewer_block_pauses_instead_of_fixing_and_the_review_is_fixed_after_release(self):
        w = world()
        w.start("single", "deepseek", "a")
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": lambda: (
            w.pr_info(7, HEAD1, head_ref="a-deepseek-001-01"),
            w.gh.by_branch.update({"a-deepseek-001-01": [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")
        body = "-1\nHEAD: " + HEAD1 + "\n결함\n```warroom-shared-defect\n" + json.dumps(report()) + "\n```\n"
        w.gh.reviews_ = [{"id": 31, "user": {"login": "genonfire"}, "body": body, "commit_id": HEAD1,
                          "submitted_at": "2026-10-21T10:00:00Z"}]
        batch_runs = lambda: [l for l in w.adapter.launches if l["cwd"] == w.row()["worktree"]]
        launches = len(batch_runs())
        w.tick(2)
        b = w.row()
        self.assertEqual((b["state"], b["pause_reason"], b["paused_from"], b["pr_number"]), ("PAUSED", "shared_defect", "WAITING_REVIEW", 7))
        self.assertEqual(len(batch_runs()), launches)                 # no fix run for the escalation itself
        self.assertEqual(w.gh.created, [101])
        self.assertIn("#7", w.gh.issues[101]["body"])
        self.assertIn(HEAD1, w.gh.issues[101]["body"])
        # an untrusted account's block is plain text: never an escalation
        w2 = world()
        w2.start("single", "deepseek", "a")
        w2.adapter.plan.append({"code": 0, "session": "s", "effect": lambda: (
            w2.pr_info(7, HEAD1), w2.gh.by_branch.update({"a-deepseek-001-01": [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w2.tick()
        w2.adapter.finish(w2.adapter.launches[-1]["pid"])
        w2.tick()
        w2.gh.reviews_ = [{"id": 32, "user": {"login": "stranger"}, "body": body, "commit_id": HEAD1,
                           "submitted_at": "2026-10-21T10:00:00Z"}]
        w2.tick(2)
        self.assertEqual((w2.row()["state"], w2.gh.created), ("WAITING_REVIEW", []))
        w.tmp.cleanup()
        w2.tmp.cleanup()

    def test_malformed_review_block_holds_without_an_issue(self):
        w = world()
        w.start("single", "deepseek", "a")
        w.adapter.plan.append({"code": 0, "session": "s", "effect": lambda: (
            w.pr_info(7, HEAD1), w.gh.by_branch.update({"a-deepseek-001-01": [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        w.gh.reviews_ = [{"id": 33, "user": {"login": "genonfire"},
                          "body": "-1\nHEAD: " + HEAD1 + "\n```warroom-shared-defect\n{not json}\n```", "commit_id": HEAD1,
                          "submitted_at": "2026-10-21T10:00:00Z"}]
        w.tick(2)
        self.assertEqual((w.row()["state"], w.row()["pause_reason"], w.gh.created), ("PAUSED", "defect_unverified", []))
        # Retry returns to review watching; this event is already recorded, so it now goes to the ordinary fix run
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.tick(2)
        self.assertEqual(w.row()["state"], "FIXING")
        w.tmp.cleanup()


class FailClosed(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.b = produce_and_report(self.w)
        self.w.tick()   # Maintainer record exists (PREPARE) after the defect was linked

    def tearDown(self):
        self.w.tmp.cleanup()

    def merged_and_cleaned(self):
        run_maintainer_to_merge(self.w, 101)

    def assert_still_paused(self, defect_state):
        w = self.w
        w.tick(4)
        self.assertEqual((w.row()["state"], w.row()["pause_reason"]), ("PAUSED", "shared_defect"))
        self.assertEqual(w.store.defects()[0]["state"], defect_state)
        launches = [l for l in w.adapter.launches if l["cwd"] == self.b["worktree"]]
        self.assertEqual(len(launches), 1)            # the batch AI was never started again

    def test_conflict_holds_the_batch_with_its_reason_and_never_retries(self):
        w = self.w
        w.git.integrate_error = IntegrationBlocked("merge 충돌 또는 거부: CONFLICT (content)")
        self.merged_and_cleaned()
        self.assert_still_paused("HELD")
        self.assertIn("CONFLICT", w.row()["error"])
        self.assertIn("보류", control.urgent_line(w.store, w.cfg))
        self.assertIn("CONFLICT", control.urgent_line(w.store, w.cfg))
        self.assertFalse(control.retry(w.store, "deepseek", "a"))      # a plain Retry cannot skip the fix
        self.assertTrue(Path(w.row()["worktree"]).exists())

    def test_transient_git_error_is_retried_not_held(self):
        from warroom.gitops import GitError
        w = self.w
        w.git.integrate_error = GitError("git fetch: network down")
        self.merged_and_cleaned()
        self.assert_still_paused("FIX_MERGED")
        w.git.integrate_error = None
        w.tick(2)
        self.assertEqual(w.store.defects()[0]["state"], "RELEASED")
        self.assertEqual(w.row()["state"], "PRODUCING")

    def test_failed_verification_holds(self):
        w = self.w
        w.git.changed[MERGE] = ["tests/form.test.mjs", "tests/helpers/x.mjs", "README.md"]
        (Path(self.b["worktree"]) / "tests").mkdir()
        (Path(self.b["worktree"]) / "tests" / "form.test.mjs").write_text("")
        orig = w.runner.run

        def run(argv, cwd=None, **kw):
            if argv[:2] == ["node", "--test"]:
                run.seen.append((argv, str(cwd)))
                from warroom.shell import Result
                return Result(1, "", "not ok 1 - form")
            return orig(argv, cwd=cwd, **kw)
        run.seen = []
        w.runner.run = run
        self.merged_and_cleaned()
        self.assert_still_paused("HELD")
        self.assertEqual(run.seen[0], (["node", "--test", "tests/form.test.mjs"], self.b["worktree"]))   # only real regression files
        self.assertIn("필수 검증 실패", w.row()["error"])

    def test_configured_verification_commands_must_pass(self):
        w = self.w
        w.cfg["shared_defect_verify"] = [["python3", "-c", "pass"]]
        from warroom.shell import Result
        orig = w.runner.run
        w.runner.run = lambda argv, cwd=None, **kw: Result(3, "", "boom") if argv[:1] == ["python3"] else orig(argv, cwd=cwd, **kw)
        self.merged_and_cleaned()
        self.assert_still_paused("HELD")

    def test_pr_head_mismatch_holds(self):
        w = self.w
        w.pr_info(9, HEAD2, head_ref="a-deepseek-001-01")
        w.store.update(self.b["id"], pr_number=9, head_sha=HEAD2)
        w.git.local_head = HEAD1                       # local does not contain what the PR holds
        self.merged_and_cleaned()
        self.assert_still_paused("HELD")
        self.assertIn("HEAD", w.row()["error"])

    def test_closed_batch_pr_holds(self):
        w = self.w
        w.pr_info(9, HEAD1, state="closed", head_ref="a-deepseek-001-01")
        w.store.update(self.b["id"], pr_number=9, head_sha=HEAD1)
        self.merged_and_cleaned()
        self.assert_still_paused("HELD")

    def test_unmerged_close_of_the_maintainer_pr_never_releases(self):
        w = self.w
        w.tick()
        branch = "maint-101"
        w.pr_info(50, HEAD1, head_ref=branch)
        w.gh.by_branch[branch] = [{"number": 50, "state": "OPEN", "headRefOid": HEAD1}]
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        w.pr_info(50, HEAD1, state="closed", merged=False, head_ref=branch)
        self.assert_still_paused("LINKED")
        self.assertEqual(maintainer_row(w)["state"], "ERROR")
        self.assertEqual(w.git.integrated, [])

    def test_wrong_head_branch_or_missing_merge_commit_holds_the_issue_task(self):
        for name, kw in [("other branch", dict(head_ref="elsewhere")), ("no merge commit", dict(merge_sha=""))]:
            with self.subTest(name):
                w = world()
                produce_and_report(w)
                w.tick(2)
                branch = "maint-101"
                w.pr_info(50, HEAD1, head_ref=branch)
                w.gh.by_branch[branch] = [{"number": 50, "state": "OPEN", "headRefOid": HEAD1}]
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                w.tick()
                w.pr_info(50, HEAD1, state="closed", merged=True, head_ref=branch, merge_sha=MERGE)
                w.tick(2)          # merged: the Maintainer completes; the tracker then re-reads the PR
                w.pr_info(50, HEAD1, state="closed", merged=True, **{"head_ref": branch, "merge_sha": MERGE, **kw})
                w.store.update_maintenance(101, state="ACTIVE")
                w.tick(2)
                self.assertEqual(w.store.maintenance(101)["state"], "HELD")
                self.assertEqual(w.git.integrated, [])
                self.assertIn("보류", control.urgent_line(w.store, w.cfg))
                w.tmp.cleanup()

    def test_closed_issue_without_a_fix_is_not_a_release(self):
        w = world(maintainer=None)
        produce_and_report(w, data=report())
        w2 = w
        w2.gh.issues[101]["state"] = "closed"          # someone closed the Issue; no PR
        w2.cfg["maintainer"] = "sonnet"
        w2.tick(3)
        self.assertEqual(w2.store.maintenance(101)["state"], "HELD")
        self.assertIsNone(maintainer_row(w2))
        self.assertEqual(w2.row()["state"], "PAUSED")
        self.assertIn("보류", control.urgent_line(w2.store, w2.cfg))
        w2.tmp.cleanup()


class OperatorControls(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.b = produce_and_report(self.w)

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_stop_all_and_drain_do_not_touch_the_maintainer(self):
        w = self.w
        w.tick()
        m = maintainer_row(w)
        self.assertEqual(m["state"], "PRODUCING")
        control.stop_all(w.store)
        w.tick(2)
        self.assertEqual(maintainer_row(w)["state"], "PRODUCING")
        self.assertEqual(w.row()["state"], "PAUSED")

    def test_stop_then_retry_is_an_explicit_override_and_blocks_the_automatic_release(self):
        w = self.w
        self.assertFalse(control.retry(w.store, "deepseek", "a"))           # plain Retry: locked
        self.assertFalse(control.line_status(w.store, "deepseek", "a")["can_retry"])
        control.stop_line(w.store, "deepseek", "a")
        w.tick()
        self.assertTrue(control.line_status(w.store, "deepseek", "a")["can_retry"])
        run_maintainer_to_merge(w, 101)
        w.tick(3)
        self.assertEqual(w.row()["state"], "PAUSED")                       # operator hold: no automatic release
        self.assertEqual(w.git.integrated, [])
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.tick(2)
        b = w.row()
        self.assertEqual((b["state"], b["pause_reason"]), ("PRODUCING", ""))
        self.assertEqual(w.store.defects()[0]["state"], "OVERRIDDEN")
        w.tick(3)
        self.assertEqual(w.git.integrated, [])

    def test_unrelated_line_keeps_running_and_normal_pause_semantics_are_unchanged(self):
        w = self.w
        w.start("single", "sonnet", "b")
        w.adapter.plan.append({"code": 0, "session": "s"})
        w.tick(3)
        self.assertEqual(w.row("sonnet", "b")["state"], "PRODUCING")
        self.assertEqual(w.row("sonnet", "b")["pause_reason"], "")
        control.stop_line(w.store, "sonnet", "b")
        w.tick()
        self.assertEqual(w.row("sonnet", "b")["state"], "PAUSED")
        self.assertTrue(control.retry(w.store, "sonnet", "b"))             # ordinary Stop/Retry as before


class SerialMaintainer(unittest.TestCase):
    def test_one_maintainer_at_a_time_in_issue_order(self):
        w = world()
        produce_and_report(w, "deepseek", "a")
        produce_and_report(w, "deepseek", "b", data=report(defect_class="second-class"))
        w.tick(3)
        self.assertEqual(w.gh.created, [101, 102])
        self.assertEqual([b["batch"] for b in w.store.all_batches() if b["method"] == "m"], ["101"])
        self.assertEqual(w.store.maintenance(102)["state"], "QUEUED")
        self.assertIn("(+1건 대기)", control.urgent_line(w.store, w.cfg))
        run_maintainer_to_merge(w, 101)
        w.tick(2)
        self.assertEqual(w.row("deepseek", "a")["state"], "PRODUCING")     # the first batch resumed
        self.assertEqual(w.row("deepseek", "b")["state"], "PAUSED")        # the second still waits for its own fix
        self.assertEqual([b["batch"] for b in w.store.all_batches() if b["method"] == "m"], ["101", "102"])
        w.tmp.cleanup()

    def test_one_fix_releases_every_batch_of_its_issue_once_each(self):
        w = world()
        produce_and_report(w, "deepseek", "a")
        produce_and_report(w, "sonnet", "a")
        run_maintainer_to_merge(w, 101)
        w.tick(3)
        self.assertEqual({w.row("deepseek", "a")["state"], w.row("sonnet", "a")["state"]}, {"PRODUCING"})
        self.assertEqual(len(w.git.integrated), 2)
        w.tick(5)
        self.assertEqual(len(w.git.integrated), 2)
        self.assertEqual({d["state"] for d in w.store.defects()}, {"RELEASED"})
        w.tmp.cleanup()

    def test_released_batch_resumes_in_its_original_phase_with_its_pr(self):
        w = world(maintainer=None)
        w.start("single", "deepseek", "a")
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": lambda: (
            w.pr_info(7, HEAD1, head_ref="a-deepseek-001-01"),
            w.gh.by_branch.update({"a-deepseek-001-01": [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        body = "-1\nHEAD: " + HEAD1 + "\n```warroom-shared-defect\n" + json.dumps(report()) + "\n```\n"
        w.gh.reviews_ = [{"id": 31, "user": {"login": "genonfire"}, "body": body, "commit_id": HEAD1,
                          "submitted_at": "2026-10-21T10:00:00Z"}]
        w.tick(2)
        w.cfg["maintainer"] = "sonnet"
        w.tick(1)
        run_maintainer_to_merge(w, 101)
        w.tick(2)
        # back in the phase it was paused in (review watching, same PR/session), where the escalating review is now an
        # ordinary blocking review: exactly one resume fix run, not a second escalation
        b = w.row()
        self.assertEqual((b["state"], b["pr_number"], b["head_sha"], b["session_id"]), ("FIXING", 7, HEAD1, "ses_1"))
        fixes = [l for l in w.adapter.launches if l["cwd"] == b["worktree"] and l["kind"] == "resume"]
        self.assertEqual(len(fixes), 1)
        self.assertIn("warroom-shared-defect", fixes[0]["prompt"])
        self.assertEqual(len(w.gh.created), 1)
        w.tmp.cleanup()


class MaintainerConfig(unittest.TestCase):
    def test_config_table(self):
        w = world()
        base = dict(w.cfg)
        for name, value, ok in [("unset", None, True), ("registered", "sonnet", True), ("registered other", "deepseek", True),
                                ("empty string", "", False), ("unregistered", "ghost", False), ("number", 5, False),
                                ("list", ["sonnet"], False), ("bool", True, False)]:
            with self.subTest(name):
                cfg = {**base, "maintainer": value}
                self.assertEqual(config_problem(cfg) is None, ok, config_problem(cfg))
        for name, value, ok in [("none", [], True), ("argv list", [["node", "--test", "x"]], True), ("flat list", ["node"], False),
                                ("empty argv", [[]], False), ("non string", [[1]], False), ("not a list", "x", False)]:
            with self.subTest("verify " + name):
                self.assertEqual(config_problem({**base, "shared_defect_verify": value}) is None, ok)
        w.tmp.cleanup()

    def test_invalid_producer_entry_blocks_the_maintainer_never_another_model(self):
        w = world()
        w.cfg["producers"] = {**PRODUCERS, "sonnet": {"adapter": "claude", "model": "m", "effort": "bogus"}}
        self.assertIsNotNone(maintainer_problem(w.cfg))
        produce_and_report(w, "deepseek", "a")
        w.tick(3)
        self.assertIsNone(maintainer_row(w))
        self.assertEqual(w.row()["state"], "PAUSED")
        self.assertIn("설정 오류", control.urgent_line(w.store, w.cfg))
        w.tmp.cleanup()

    def test_a_started_task_keeps_its_producer_and_pin_across_reload_and_restart(self):
        w = world()
        produce_and_report(w, "deepseek", "a")
        w.tick(2)
        m = maintainer_row(w)
        self.assertEqual(m["producer"], "sonnet")
        launch_model = w.adapter.launches[-1]["model"]
        w.cfg["maintainer"] = "deepseek"                       # selection changed after the task started
        w.sup = w.make_sup()                                   # and the Supervisor restarted
        w.tick(3)
        self.assertEqual(maintainer_row(w)["producer"], "sonnet")
        self.assertEqual(len([l for l in w.adapter.launches if l["cwd"] == str(w.paths.worktrees / "maint-101")]), 1)
        self.assertEqual(w.adapter.launches[-1]["model"], launch_model)
        # the producer of an unfinished Maintainer task cannot be removed or swapped to another CLI by a reload
        new = {**w.cfg, "producers": {"deepseek": PRODUCERS["deepseek"]}}
        self.assertIsNotNone(reload_problem(w.cfg, new, {b["producer"] for b in w.store.incomplete_batches()}))
        w.tmp.cleanup()

    def test_prompts_for_the_maintainer_and_producers(self):
        row = {"method": "m", "shard": "issue", "batch": "101", "branch": "maint-101"}
        text = prompts.produce(row)
        self.assertIn("#101", text)
        self.assertIn("maint-101", text)
        self.assertIn("리뷰를 요청", text)
        self.assertIn("#101", prompts.recovery(row))
        for method in "abcd":
            self.assertIn("shared-defect.md", prompts.produce({"method": method, "shard": "001", "batch": "01", "branch": "b"}))
        self.assertIn("shared-defect.md", prompts.recovery({"method": "a", "shard": "001", "batch": "01", "branch": "b"}))


class Schema(unittest.TestCase):
    def test_v5_database_migrates_additively(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "w.db"
            Store(path)
            c = sqlite3.connect(path)
            c.execute("DROP TABLE defects")
            c.execute("DROP TABLE maintenance")
            c.execute("ALTER TABLE batches DROP COLUMN pause_reason")
            c.execute("ALTER TABLE batches DROP COLUMN defect_id")
            c.execute("INSERT INTO batches(method,producer,shard,batch,branch,worktree,state,created_at,updated_at)"
                      " VALUES('a','x','001','01','b','w','PAUSED',1,1)")
            c.execute("PRAGMA user_version=5")
            c.commit()
            c.close()
            s = Store(path)
            b = s.all_batches()[0]
            self.assertEqual((b["state"], b["pause_reason"], b["defect_id"]), ("PAUSED", "", None))
            self.assertEqual(s.defects(), [])
            c = sqlite3.connect(path)
            self.assertEqual(c.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            c.close()


# ---------------------------------------------------------------------------------------------------------------------
# Real git: a paused batch worktree with uncommitted partial output receives a merged shared fix.
ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}


def sh(*a, cwd):
    return subprocess.run(a, cwd=cwd, env=ENV, check=True, capture_output=True, text=True).stdout.strip()


class RealGitIntegration(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        sh("git", "init", "-q", "--bare", "-b", "master", "origin.git", cwd=t)
        sh("git", "clone", "-q", "origin.git", "repo", cwd=t)
        self.repo = t / "repo"
        (self.repo / "validator.mjs").write_text("old\n")
        (self.repo / "data").mkdir()
        (self.repo / "data" / "shared.txt").write_text("base\n")
        sh("git", "add", ".", cwd=self.repo)
        sh("git", "commit", "-qm", "init", cwd=self.repo)
        sh("git", "push", "-q", "origin", "HEAD:master", cwd=self.repo)
        self.git = Git(Runner(), self.repo, ENV, t / "wts")
        self.wt = t / "wts" / "a-x-001-01"
        self.git.fetch_base("master")
        self.git.create_worktree(self.wt, "a-x-001-01", "master")

    def tearDown(self):
        self.tmp.cleanup()

    def land_fix(self, path="validator.mjs", text="fixed\n"):
        (self.repo / path).write_text(text)
        sh("git", "add", path, cwd=self.repo)
        sh("git", "commit", "-qm", "shared fix", cwd=self.repo)
        sh("git", "push", "-q", "origin", "HEAD:master", cwd=self.repo)
        return sh("git", "rev-parse", "HEAD", cwd=self.repo)

    def test_fix_is_merged_and_partial_output_and_commits_survive(self):
        (self.wt / "partial.jsonl").write_text('{"id":"C1"}\n' * 3)          # uncommitted partial batch output
        (self.wt / "mine.txt").write_text("commit")
        sh("git", "add", "mine.txt", cwd=self.wt)
        sh("git", "commit", "-qm", "work", cwd=self.wt)
        work = self.git.head(self.wt)
        sha = self.land_fix()
        head = self.git.integrate(self.wt, "a-x-001-01", "master", sha)
        self.assertEqual(head, self.git.head(self.wt))
        self.assertTrue(self.git.contains(self.wt, sha))
        self.assertTrue(self.git.contains(self.wt, work))                   # own commit kept
        self.assertEqual((self.wt / "validator.mjs").read_text(), "fixed\n")
        self.assertEqual((self.wt / "partial.jsonl").read_text(), '{"id":"C1"}\n' * 3)
        self.assertEqual(self.git.integrate(self.wt, "a-x-001-01", "master", sha), head)   # idempotent
        self.assertEqual(sh("git", "rev-list", "--count", f"{sha}..HEAD", cwd=self.wt), "2")
        self.assertEqual(self.git.changed_files(sha), ["validator.mjs"])

    def test_conflict_is_aborted_and_leaves_the_worktree_untouched(self):
        (self.wt / "validator.mjs").write_text("mine\n")
        sh("git", "commit", "-qam", "my edit", cwd=self.wt)
        (self.wt / "partial.jsonl").write_text("keep\n")
        before = self.git.head(self.wt)
        sha = self.land_fix()
        with self.assertRaises(IntegrationBlocked):
            self.git.integrate(self.wt, "a-x-001-01", "master", sha)
        self.assertEqual(self.git.head(self.wt), before)
        self.assertEqual((self.wt / "validator.mjs").read_text(), "mine\n")
        self.assertEqual((self.wt / "partial.jsonl").read_text(), "keep\n")
        self.assertEqual(self.git.dirty(self.wt).strip(), "?? partial.jsonl")
        self.assertFalse((Path(sh("git", "rev-parse", "--absolute-git-dir", cwd=self.wt)) / "MERGE_HEAD").exists())

    def test_uncommitted_change_in_a_file_the_fix_touches_is_refused_not_overwritten(self):
        (self.wt / "validator.mjs").write_text("uncommitted\n")
        sha = self.land_fix()
        before = self.git.head(self.wt)
        with self.assertRaises(IntegrationBlocked):
            self.git.integrate(self.wt, "a-x-001-01", "master", sha)
        self.assertEqual(self.git.head(self.wt), before)
        self.assertEqual((self.wt / "validator.mjs").read_text(), "uncommitted\n")

    def test_only_commits_on_the_base_branch_foreign_or_unregistered_paths_are_accepted(self):
        sha = self.land_fix()
        side = self.repo.parent / "side"
        sh("git", "clone", "-q", "origin.git", "side", cwd=self.repo.parent)
        (side / "x").write_text("x")
        sh("git", "add", "x", cwd=side)
        sh("git", "commit", "-qm", "unpublished", cwd=side)
        unpublished = sh("git", "rev-parse", "HEAD", cwd=side)
        sh("git", "push", "-q", "origin", "HEAD:refs/heads/other", cwd=side)           # exists on origin, not on master
        before = self.git.head(self.wt)
        for name, args in [("not on base", (self.wt, "a-x-001-01", "master", unpublished)),
                           ("wrong branch", (self.wt, "other", "master", sha)),
                           ("outside War Room", (self.repo, "master", "master", sha)),
                           ("missing path", (self.wt.parent / "nope", "b", "master", sha))]:
            with self.subTest(name), self.assertRaises(IntegrationBlocked):
                self.git.integrate(*args)
        self.assertEqual(self.git.head(self.wt), before)

    def test_supervisor_resumes_a_paused_batch_on_a_real_worktree_after_the_real_integration(self):
        """Release path end to end on real git: defect-paused batch row -> integrate -> verify -> one release."""
        w = world(maintainer=None)
        w.git = self.git
        w.sup = w.make_sup()
        wt = str(self.wt)
        bid = w.store.create_batch(method="a", producer="deepseek", shard="001", batch="01", branch="a-x-001-01", worktree=wt)
        w.store.update(bid, state="PRODUCING", session_id="ses_1")
        (self.wt / "partial.jsonl").write_text("p\n")
        did = w.store.report_defect(bid, "k", "report", "span-in-jsonl-form", "REPORTED", "{}", "shared_defect", "paused")
        sha = self.land_fix()
        w.store.update_defect(did, state="FIX_MERGED", issue_number=1, merge_sha=sha)
        w.store.ensure_maintenance(1)
        w.tick(2)
        b = w.store.batch(bid)
        self.assertEqual((b["state"], b["pause_reason"]), ("PRODUCING", ""))
        self.assertEqual(w.store.defect(did)["state"], "RELEASED")
        self.assertTrue(self.git.contains(self.wt, sha))
        self.assertEqual((self.wt / "partial.jsonl").read_text(), "p\n")
        self.assertEqual(w.store.defect(did)["integrated_sha"], self.git.head(self.wt))
        w.tick(3)
        self.assertEqual(len([l for l in w.adapter.launches if l["cwd"] == wt]), 1)    # one relaunch, never two
        w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()


try:
    import textual  # noqa: F401
except ImportError:  # pragma: no cover
    textual = None


@unittest.skipIf(textual is None, "textual not installed")
class UrgentLineInTui(unittest.TestCase):
    def test_one_yellow_line_shows_the_issue_beside_drain_and_vanishes_when_done(self):
        import asyncio
        from textual.widgets import Static
        from tests.test_tui import PRODUCERS as TUI_PRODUCERS, make_app
        w = world()
        w.cfg["producers"] = TUI_PRODUCERS
        produce_and_report(w)
        w.cfg["producers"] = PRODUCERS

        async def go():
            app = make_app(w, PRODUCERS)
            async with app.run_test(size=(200, 60)) as pilot:
                await pilot.pause(0.3)
                note = app.query_one("#drain-note", Static)
                text = str(note.render())
                self.assertTrue(note.display)
                self.assertEqual(len(text.splitlines()), 1)
                self.assertIn("urgent issue #101", text)
                control.drain_all(w.store, [("sonnet", "a")] + [("deepseek", "a")])
                await pilot.pause(1.3)
                text = str(note.render())
                self.assertEqual(len(text.splitlines()), 1)
                self.assertIn("urgent issue #101", text)
                self.assertIn("DRAIN ALL", text)
                self.assertEqual(text.index("urgent"), 0)              # the urgent Issue comes first
                # [brackets] in a hold reason are text, not markup
                w.store.update_maintenance(101, state="HELD", hold_reason="merge [CONFLICT] in a.mjs")
                await pilot.pause(1.3)
                self.assertIn("[CONFLICT]", str(note.render()))
                w.store.update_defect(w.store.defects()[0]["id"], state="RELEASED")
                w.store.update_maintenance(101, state="DONE")
                await pilot.pause(1.3)
                self.assertNotIn("urgent", str(note.render()))
        asyncio.run(go())
        w.tmp.cleanup()
