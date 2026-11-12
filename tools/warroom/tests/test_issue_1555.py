"""Issue #1555: structured shared defect -> PAUSED batch -> one urgent Issue -> hidden serial Maintainer -> merged PR +
Maintainer cleanup -> fix applied to the paused batch and verified -> exactly one automatic Retry. Fake AI/GitHub/git
plus a real-git section (temp repo, linked worktree with uncommitted partial output)."""
import hashlib
import json
import os
import sqlite3
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.fakes import HEAD1, HEAD2
from tests.test_lines import PRODUCERS, multi_world
from tests.test_supervisor import review
from warroom import control, dchunk, defects, dparallel, literary, stage2
from warroom.config import config_problem, maintainer_problem, reload_problem, registry
from warroom.gitops import Git, IntegrationBlocked
from warroom.shell import Runner
from warroom.store import SCHEMA_VERSION, Store
from warroom.supervisor import Supervisor

MERGE = "c" * 40


def report(**over):
    r = {"version": 1, "defect_class": "span-in-jsonl-form", "summary": "validator accepts clause-like candidates",
         "failing_cases": ["C000123 → 걸음을 옮기며 걷는다", "C000456 → 말을 건네며 웃는다"],
         "reproduction": "node scripts/validate/candidate-form.mjs <file>", "suspected_layer": "scripts/validate/candidate-form.mjs",
         "root_cause": "form gate ignores predicates",
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


def assert_continued(case, w, m, reason):
    """#5245: an unaccepted no-PR result is neither completion nor a parked ERROR; the same attempt continues."""
    current = w.store.batch(m["id"])
    case.assertNotIn(current["state"], ("ERROR", "COMPLETE"), current["error"])
    case.assertIsNone(w.store.get(f"m_diag_{m['id']}"))
    case.assertEqual((w.store.maintenance(101)["state"], w.store.maintenance(101)["batch_id"]), ("ACTIVE", m["id"]))
    rejection = json.loads((Path(m["worktree"]) / ".warroom-scratch/incident-diagnosis-rejection.json").read_text("utf-8"))
    case.assertEqual(rejection["reason"], reason)
    case.assertEqual(rejection["attempt"], m["id"])
    for d in [x for x in w.store.defects() if x["source"] == "incident" and x["issue_number"] == 101]:
        case.assertEqual(d["state"], "LINKED")   # nothing resolved or handed off
        source = w.store.batch(d["batch_id"])
        case.assertEqual((source["state"], source["pause_reason"]), ("PAUSED", "shared_defect"))


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
        # while the Maintainer works nothing resumes the paused batch, however many ticks pass
        w.tick(4)
        self.assertEqual(w.row()["state"], "PAUSED")
        launches = len(w.adapter.launches)

        w.pr_info(50, HEAD1, head_ref="maint-101")
        w.gh.by_branch["maint-101"] = [{"number": 50, "state": "OPEN", "headRefOid": HEAD1}]
        w.adapter.finish(launch["pid"])
        w.tick()
        self.assertEqual(maintainer_row(w)["state"], "WAITING_REVIEW")
        # a PR that is open, approved or merely green is never a release trigger
        w.gh.reviews_ = [review(21, HEAD1, "+2")]
        w.tick(3)
        self.assertEqual(w.row()["state"], "PAUSED")

        # merged=true but the Maintainer's cleanup is blocked: still no release
        w.git.block = "dirty maintainer worktree"
        w.pr_info(50, HEAD1, state="closed", merged=True, head_ref="maint-101", merge_sha=MERGE)
        w.tick(3)
        self.assertEqual(maintainer_row(w)["state"], "ERROR")
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
        # the retry resumed the SAME session in the SAME worktree; ticking on never retries again
        w.tick()
        relaunch = w.adapter.launches[-1]
        self.assertEqual((relaunch["kind"], relaunch["session"], relaunch["cwd"]), ("resume", "ses_deepseek_a", b["worktree"]))
        w.tick(5)
        self.assertEqual(len(w.adapter.launches), launches + 1)       # exactly one relaunch of the batch AI
        self.assertEqual(len(w.gh.created), 1)

    def test_unconfigured_maintainer_keeps_report_issue_and_pause_but_runs_nothing(self):
        w = self.w
        w.cfg["maintainer"] = None
        b = produce_and_report(w)
        self.assertEqual((b["state"], b["pause_reason"]), ("PAUSED", "shared_defect"))
        self.assertEqual(w.gh.created, [101])
        w.tick(5)
        self.assertIsNone(maintainer_row(w))

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
        ("no failing case", dict(data=report(failing_cases=[]))),
        ("blank failing case", dict(data=report(failing_cases=["  "]))),
        ("missing reproduction", dict(data=report(reproduction=None))),
        ("missing suspected layer", dict(data=report(suspected_layer=None))),
        ("blank suspected layer", dict(data=report(suspected_layer="  "))),
        ("blank optional root cause", dict(data=report(root_cause="  "))),
        ("blank optional regression", dict(data=report(regression=""))),
        ("bad class slug", dict(data=report(defect_class="Bad Class"))),
        ("unknown field", dict(data={**report(), "note": "x"})),
        ("wrong version", dict(data=report(version=2))),
        ("failing_cases not strings", dict(data=report(failing_cases=[1, 2]))),
    ]

    def test_insufficient_evidence_holds_the_batch_without_an_issue_and_retry_resumes(self):
        for name, kw in self.CASES:
            with self.subTest(name):
                raw = kw.get("raw", json.dumps(kw.get("data")))
                with self.assertRaises(defects.ReportProblem):
                    defects.parse(raw)

        for name, kw in (self.CASES[0], self.CASES[4]):
            with self.subTest(name):
                w = world()
                b = produce_and_report(w, **kw)
                self.assertEqual((b["state"], b["pause_reason"]), ("PAUSED", "defect_unverified"), name)
                self.assertEqual(w.gh.created, [])
                self.assertEqual(w.store.defects()[0]["state"], "UNVERIFIED")
                self.assertIsNone(maintainer_row(w))
                w.tick(3)
                self.assertEqual(w.gh.created, [])
                # an ordinary Retry works for this pause (it is not a shared-defect pause) and the same file is not re-read
                self.assertTrue(control.retry(w.store, "deepseek", "a"))
                w.tick(2)
                self.assertEqual(w.row()["state"], "PRODUCING")
                self.assertEqual((len(w.store.defects()), w.gh.created), (1, []))
                w.tmp.cleanup()

    def test_valid_but_unusual_reports_are_accepted(self):
        minimal = {k: v for k, v in report().items() if k not in ("root_cause", "scope", "proposed_fix", "regression")}
        cases = [("max cases", report(failing_cases=[f"c{i}" for i in range(20)])),
                 ("one real case, cheap report", report(failing_cases=["C000123 → 걸음을 옮기며 걷는다"])),
                 ("only the required fields", minimal),
                 ("unicode and markers in text", report(summary="`--> <!-- warroom-defect-class:x --> 한글 ✓")),
                 ("minimal slug", report(defect_class="abc"))]
        for name, data in cases:
            self.assertEqual(defects.parse(json.dumps(data))["defect_class"], data["defect_class"], name)

        for name, data in cases[2:4]:
            with self.subTest(name):
                w = world(maintainer=None)
                b = produce_and_report(w, data=data)
                self.assertEqual(b["pause_reason"], "shared_defect")
                body = w.gh.issues[101]["body"]
                if name == "only the required fields":
                    self.assertIn("Maintainer가 조사", body)         # unreported analysis is left to the Maintainer
                    self.assertIn("scripts/validate/candidate-form.mjs", body)
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

    def test_verification_is_derived_from_the_fix_and_fails_closed(self):
        """A fix PR whose regression cannot be run must not release the batch (review: Python-only tests passed vacuously)."""
        from warroom.shell import Result
        wt = Path(self.b["worktree"])
        for rel in ("tools/warroom/tests/test_x.py", "tests/y.test.mjs", "tests/z.test.js", "scripts/v.mjs", "docs/n.md",
                    "scripts/relation/candidate-workbench.mjs", "scripts/relation/candidate-workbench.test.mjs"):
            (wt / rel).parent.mkdir(parents=True, exist_ok=True)
            (wt / rel).write_text("")
        ok = lambda: None
        cases = [
            ("War Room fake helper with its Python regression", ["tools/warroom/warroom/s.py", "tools/warroom/tests/fake_example.py", "tools/warroom/tests/test_x.py"], [], ["node", "tools/warroom/run-tests.mjs"], True),
            ("fake helper alone cannot verify a code fix", ["tools/warroom/warroom/s.py", "tools/warroom/tests/fake_example.py"], [], None, False),   # (name, changed files, configured, expected command prefix or None, verified?)
            ("python tests run War Room's suite", ["tools/warroom/warroom/s.py", "tools/warroom/tests/test_x.py"], [], ["node", "tools/warroom/run-tests.mjs"], True),
            ("node tests run node --test", ["scripts/v.mjs", "tests/y.test.mjs"], [], ["node", "--test", "tests/y.test.mjs"], True),
            ("shared producer fix beside its scripts/** node test", ["scripts/relation/candidate-workbench.mjs", "scripts/relation/candidate-workbench.test.mjs"], [],
             ["node", "--test", "scripts/relation/candidate-workbench.test.mjs"], True),
            ("unsupported test but the operator configured verification", ["scripts/v.mjs", "tests/z.test.js"], [["python3", "-c", "pass"]],
             ["python3", "-c", "pass"], True),
            ("code only, nothing runnable", ["scripts/v.mjs"], [], None, False),
            ("unsupported vitest file", ["scripts/v.mjs", "tests/z.test.js"], [], None, False),
            ("unsupported test beside a runnable one", ["tests/y.test.mjs", "tests/z.test.js"], [], None, False),   # refused before anything runs
            ("configured command covers code-only fix", ["scripts/v.mjs"], [["python3", "-c", "pass"]], ["python3", "-c", "pass"], True),
            ("docs and prompts need only the ancestry proof", ["docs/n.md", "tools/warroom/prompts/m.md"], [], None, True),
            ("unknown change set", [], [], None, False),
        ]
        for name, files, configured, prefix, verified in cases:
            with self.subTest(name):
                w = self.w
                w.cfg["shared_defect_verify"] = configured
                w.git.changed[MERGE] = files
                seen = []
                w.runner.run = lambda argv, cwd=None, _s=seen, **kw: (_s.append(argv), Result(0))[1]
                d = {"merge_sha": MERGE}
                problem = w.sup.maint._verify(d, wt)
                self.assertEqual(problem is None, verified, problem)
                self.assertEqual(any(a[:len(prefix)] == prefix for a in seen) if prefix else not seen, True, seen)


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
                w.tick(2)          # merged PR reaches CLEANUP; tracker holds if cleanup or merge proof fails
                w.pr_info(50, HEAD1, state="closed", merged=True, **{"head_ref": branch, "merge_sha": MERGE, **kw})
                w.store.update_maintenance(101, state="ACTIVE")
                w.tick(2)
                task = w.store.maintenance(101)
                if name == "other branch":
                    # CLEANUP sees the changed branch identity itself and blocks before COMPLETE.
                    self.assertEqual(task["state"], "ACTIVE")
                    batch = w.store.batch(task["batch_id"])
                    self.assertEqual(batch["state"], "ERROR")
                    self.assertIn("head 브랜치", batch["error"])
                else:
                    self.assertEqual(task["state"], "HELD")
                self.assertEqual(w.git.integrated, [])
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
        w2.tmp.cleanup()


class OperatorControls(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.b = produce_and_report(self.w)

    def tearDown(self):
        self.w.tmp.cleanup()


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

    def test_batch_pinned_stop_refuses_another_batch_id_and_keeps_stop_then_retry(self):
        w = self.w
        other = produce_and_report(w, "sonnet", "a")
        line = dict(w.store.peek_line("deepseek", "a"))
        self.assertFalse(control.stop_batch(w.store, "deepseek", "a", other["id"]))   # not this Line's batch
        self.assertEqual(dict(w.store.peek_line("deepseek", "a")), line)
        self.assertIsNone(w.store.get("stop_pin_deepseek_a"))
        self.assertTrue(control.stop_batch(w.store, "deepseek", "a", self.b["id"]))
        w.tick()
        self.assertEqual(w.store.get(f"defect_hold_{self.b['id']}"), "1")
        self.assertTrue(control.retry(w.store, "deepseek", "a", self.b["id"]))
        w.tick(2)
        self.assertEqual((w.row()["state"], w.row()["pause_reason"]), ("PRODUCING", ""))
        self.assertEqual(w.row("sonnet", "a")["state"], "PAUSED")          # the other Line was never touched


class SerialMaintainer(unittest.TestCase):
    def test_one_maintainer_at_a_time_in_issue_order(self):
        w = world()
        produce_and_report(w, "deepseek", "a")
        produce_and_report(w, "deepseek", "b", data=report(defect_class="second-class"))
        w.tick(3)
        self.assertEqual(w.gh.created, [101, 102])
        self.assertEqual([b["batch"] for b in w.store.all_batches() if b["method"] == "m"], ["101"])
        self.assertEqual(w.store.maintenance(102)["state"], "QUEUED")
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

    def test_paused_shared_defect_batch_whose_pr_merges_goes_to_cleanup_without_another_run(self):
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
        self.assertEqual((w.row()["state"], w.row()["pause_reason"]), ("PAUSED", "shared_defect"))
        launches = len(w.adapter.launches)
        w.pr_info(7, HEAD1, state="closed", merged=True, head_ref="a-deepseek-001-01", merge_sha=MERGE)
        w.now += 120
        w.tick(3)
        self.assertEqual(w.row()["state"], "COMPLETE")
        self.assertEqual(len(w.adapter.launches), launches)   # no resume/fix AI run on a merged PR
        w.tmp.cleanup()


class ResolvedReportResume(unittest.TestCase):
    """Issue #1825: a RELEASED defect's own report must not stop the resumed producer again."""

    def released(self):
        w = world()
        b = produce_and_report(w)
        run_maintainer_to_merge(w, 101)
        w.tick(3)
        return w, w.row()

    def test_resolved_report_is_archived_and_the_resume_prompt_carries_the_evidence(self):
        w, b = self.released()
        wt = Path(b["worktree"])
        d = w.store.defects()[0]
        self.assertEqual(d["state"], "RELEASED")
        self.assertFalse((wt / defects.REPORT_FILE).exists())
        self.assertTrue((wt / ".warroom-scratch/resolved-defects" / f"defect-{d['id']}.json").exists())
        self.assertTrue(w.sup.maint._archive_report(d, b))  # absent source report is an idempotent success
        self.assertFalse((wt / defects.REPORT_FILE).exists())
        prompt = [l for l in w.adapter.launches if l["cwd"] == b["worktree"]][-1]["prompt"]
        self.assertIn("resolved-defects", prompt)
        self.assertIn(MERGE[:10], prompt)
        # the resumed AI finishes with a PR: the batch continues to review instead of pausing again
        branch = b["branch"]
        w.pr_info(60, HEAD1, head_ref=branch)
        w.gh.by_branch[branch] = [{"number": 60, "state": "OPEN", "headRefOid": HEAD1}]
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick(2)
        self.assertEqual((w.row()["state"], w.row()["pr_number"]), ("WAITING_REVIEW", 60))
        self.assertEqual(len(w.gh.created), 1)
        w.tmp.cleanup()


    def test_same_report_written_again_after_release_is_new_evidence(self):
        w, b = self.released()
        write_report(w, b)                    # the fixed HEAD still reproduces the defect: identical content, new event
        w.tick(2)
        b2 = w.row()
        self.assertEqual((b2["state"], b2["pause_reason"]), ("PAUSED", "shared_defect"))
        rows = w.store.defects()
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[1]["event_key"].endswith(f":after:{rows[0]['id']}"))
        w.tick(4)
        self.assertEqual(len(w.store.defects()), 2)      # the same file is not re-reported every tick
        w.tmp.cleanup()

    def test_changed_report_is_not_archived_and_pauses_as_new_evidence(self):
        w = world()
        produce_and_report(w)
        b = w.row()
        write_report(w, b, report(summary="a different symptom"))   # edited after the first report was recorded
        run_maintainer_to_merge(w, 101)
        w.tick(4)
        self.assertEqual(w.row()["pause_reason"], "shared_defect")
        self.assertEqual(len(w.store.defects()), 2)
        w.tmp.cleanup()

    def test_exit_zero_without_pr_after_release_names_the_cause_and_never_restarts(self):
        w, b = self.released()
        n = len(w.adapter.launches)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick(3)
        b = w.row()
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("PR을 찾지 못했습니다", b["error"])
        self.assertIn("공통 결함 #1", b["error"])
        w.tick(5)
        self.assertEqual(len(w.adapter.launches), n)
        w.tmp.cleanup()


RELEASE_HEAD = MERGE


def make_batch(w, method="d", model="deepseek", shard="001", batch="01", run_kind="d_chunk_new", state="PRODUCING",
               worktree=True, **fields):
    """A production batch row of any method with an (optionally real) fake worktree, no AI process and no live task run."""
    branch = f"{method}-{model}-{shard}-{batch}"
    path = w.paths.worktrees / branch
    bid = w.store.create_batch(method=method, producer=model, shard=shard, batch=batch, branch=branch, worktree=str(path))
    if worktree:
        w.git.create_worktree(path, branch, "master")
    w.store.update(bid, state=state, run_kind=run_kind, **fields)
    return w.store.batch(bid)


def break_batch(w, b, error="boom", direct=False, paused_from="PRODUCING"):
    """The batch enters ERROR: through `_fail` (default) or a direct Store write."""
    if direct:
        w.store.update(b["id"], state="ERROR", paused_from=paused_from, error=error)
    else:
        w.sup._fail(w.store.batch(b["id"]), "ERROR", error)
    return w.store.batch(b["id"])


def incidents(w):
    return [d for d in w.store.defects() if d["source"] == "incident"]


class AutonomousIncident(unittest.TestCase):
    """Issues #3326 / #3349: every C/D/Stage 2/Stage 3 production ERROR is received by the Maintainer sweep as an incident."""

    def setUp(self):
        self.w = world()
        self.w.intake = True
        self.w.sup.maint.__dict__.pop("_intake_errors", None)   # the autonomous intake is on in these tests
        self.w.git.integrate_updates_head = True   # the integration HEAD is MERGE, a descendant of HEAD1

    def tearDown(self):
        self.w.tmp.cleanup()

    def released(self, *models):
        """Batches (converted to Method D, no AI running) that already own a RELEASED same-batch Maintainer receipt."""
        w = self.w
        for m in models:
            produce_and_report(w, m, "a")
        run_maintainer_to_merge(w, 101)
        w.tick(3)
        out = []
        for m in models:
            b = w.row(m, "a")
            self.assertEqual(b["state"], "PRODUCING")
            w.store.set_line(m, "a", run=0)
            w.store.finish_runs(b["id"], None)
            with w.store._conn() as c:
                c.execute("UPDATE batches SET method='d', pid=NULL, run_kind='d_chunk_new' WHERE id=?", (b["id"],))
            w.store.set(f"d_base_head_{b['id']}", HEAD1)
            out.append(w.store.batch(b["id"]))
        return out

    def rejected(self, b):
        return self.w.sup._d_head_problem(b, Path(b["worktree"]))

    def test_approved_integration_error_keeps_its_evidence_and_is_received_by_the_sweep_once(self):
        w = self.w
        b, = self.released("deepseek")
        problem = self.rejected(b)
        self.assertIsInstance(problem, defects.BoundaryProblem)
        w.sup._fail(b, "ERROR", problem + " worktree를 보존합니다.")   # the exact concatenation _d_finalize performs
        row = w.store.batch(b["id"])
        self.assertEqual((row["state"], row["error_seq"], incidents(w)), ("ERROR", 1, []))   # nothing is received inside _fail
        ev = json.loads(w.store.get(f"error_evidence_{b['id']}_1"))
        self.assertEqual((ev["kind"], ev["site"], ev["head"]), ("boundary", "d-head", MERGE))
        w.tick(2)
        row = w.store.batch(b["id"])
        self.assertEqual((row["state"], row["pause_reason"], row["paused_from"]), ("PAUSED", "shared_defect", "PRODUCING"))
        self.assertIn("배치 기준 HEAD", row["error"])                  # the original message survives
        self.assertEqual(len(incidents(w)), 1)
        self.assertEqual(w.gh.created, [101, 102])
        self.assertIn("장애 접수", w.gh.issues[102]["title"])
        self.assertNotIn("Traceback", w.gh.issues[102]["body"])
        w.sup = w.make_sup()                                          # a restart over the same DB
        w.sup.maint.__dict__.pop("_intake_errors", None)
        w.tick(3)
        self.assertEqual((len(incidents(w)), w.gh.created), (1, [101, 102]))

    def test_any_error_without_structured_evidence_is_received_with_that_item_missing(self):
        w = self.w
        b = make_batch(w)
        break_batch(w, b, "plain failure text")
        w.tick(2)
        d, = incidents(w)
        env = defects.parse_incident(d["report"].partition("\n")[0])
        self.assertEqual(env["observed"]["error_evidence"]["status"], "missing")
        self.assertEqual(env["error"], "plain failure text")
        self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")

    def test_a_failing_report_keeps_the_error(self):
        w = self.w
        b = make_batch(w)
        break_batch(w, b)

        def boom(*a, **k):
            raise RuntimeError("db locked")
        w.sup.maint.report = boom
        w.tick(2)
        row = w.store.batch(b["id"])
        self.assertEqual((row["state"], row["error"]), ("ERROR", "boom"))
        self.assertTrue(any("장애 접수 예외" in e["msg"] for e in w.store.batch_events(b["id"])))
        self.assertEqual(incidents(w), [])

    def test_two_batches_are_two_issues_never_merged_by_class(self):
        w = self.w
        batches = self.released("deepseek", "sonnet")
        for b in batches:
            w.sup._fail(b, "ERROR", self.rejected(b))
        w.tick(3)
        self.assertEqual(w.gh.created, [101, 102, 103])
        self.assertEqual(len({d["defect_class"] for d in incidents(w)}), 2)

    def diagnose(self, valid=True, commit=False, outcome="undetermined", blocked=False,
                 unknown_observation="checkpoint", stale_marker=False, **extra):
        w = self.w
        b = make_batch(w)
        blocker = {"observation": unknown_observation,
                   "reason": f"접수 시 필수 관측 `{unknown_observation}`가 unknown이라 원본 증거 무결성을 검증할 수 없습니다"}
        if blocked:
            observe = w.sup.maint._observe
            def observed_with_unknown(batch, evidence):
                result = observe(batch, evidence)
                result[unknown_observation] = {"status": "unknown", "value": "fixture read failure"}
                return result
            w.sup.maint._observe = observed_with_unknown
        break_batch(w, b)
        w.tick(4)   # Issue 101 -> its Maintainer starts
        m = [x for x in w.store.all_batches() if x["method"] == "m"][-1]
        self.assertEqual((m["state"], m["batch"]), ("PRODUCING", "101"))
        wt = Path(m["worktree"])
        evidence = next((wt / ".warroom-scratch/incident").glob("*.json"))
        data = json.loads(evidence.read_text())
        self.assertIn("events", data)
        self.assertEqual(data["envelope"]["error_seq"], 1)
        if valid:
            summary = "접수 증거를 재검증하지 못했습니다"
            next_action = "운영자가 원본 evidence 접근과 hash를 확인한 뒤 Maintainer를 다시 실행합니다"
            payload = {"version": 1, "issue": 101, "outcome": outcome, "summary": summary,
                       "blocker": blocker if blocked else None, "next_action": next_action, **extra}
            (wt / ".warroom-scratch/incident-diagnosis.json").write_text(json.dumps(payload))
        comment = "진단\n"
        if valid:
            comment += f"\n{summary}\n{blocker['reason'] if blocked else '차단 근거 미검증'}\n{next_action}\n"
        marker_attempt = data["maintainer_attempt"] - 1 if stale_marker else data["maintainer_attempt"]
        w.gh.comment_issue(101, comment + "\n" + defects.marker(
            defects.EVENT_MARK, f"incident-diagnosis-101-attempt-{marker_attempt}"))
        if commit:
            w.git.local_head = "9" * 40
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick(3)
        return w, [x for x in w.store.all_batches() if x["method"] == "m"][-1]

    def test_proven_evidence_blocker_hands_off_but_does_not_resolve_production(self):
        w, m = self.diagnose(blocked=True)
        self.assertEqual(m["state"], "COMPLETE")
        self.assertEqual(w.store.maintenance(101)["state"], "HELD")
        self.assertEqual([d["state"] for d in incidents(w)], ["HELD"])
        row = w.store.batch(incidents(w)[0]["batch_id"])
        self.assertEqual((row["state"], row["pause_reason"]), ("PAUSED", "shared_defect"))
        self.assertIn("unknown이라 원본 증거", row["error"])
        self.assertIn("다음 조치:", row["error"])
        self.assertFalse(w.store.maintenance_batch_open())
        w.tick(5)
        self.assertEqual(w.store.batch(row["id"])["state"], "PAUSED")   # never auto-resumed

    def test_undetermined_diagnosis_has_an_explicit_retry_that_only_relinks_the_paused_incident(self):
        w, first = self.diagnose(outcome="undetermined", blocked=True)
        d, = incidents(w)
        st = control.maintainer_status(w.store, w.cfg, "sonnet")
        self.assertTrue(w.store.maintenance_retryable(101))
        self.assertTrue(st["can_retry"])
        self.assertTrue(control.retry_maintainer(w.store, 101))
        self.assertFalse(control.retry_maintainer(w.store, 101))  # one explicit queue transition
        self.assertEqual((w.store.maintenance(101)["state"], w.store.maintenance(101)["batch_id"]), ("QUEUED", None))
        self.assertEqual((w.store.defect(d["id"])["state"], w.store.batch(d["batch_id"])["state"]),
                         ("LINKED", "PAUSED"))

        w.tick(4)
        attempts = [b for b in w.store.all_batches() if b["method"] == "m" and b["batch"] == "101"]
        second = attempts[-1]
        self.assertEqual(len(attempts), 2)
        self.assertNotEqual(second["id"], first["id"])
        self.assertEqual((second["shard"], second["batch"]), ("issue-2", "101"))
        self.assertEqual(w.store.maintenance(101)["batch_id"], second["id"])
        self.assertEqual(w.store.batch(d["batch_id"])["state"], "PAUSED")

    def test_diagnosis_retry_requires_undetermined_outcome_and_unchanged_incident_state(self):
        w, _ = self.diagnose(outcome="external")
        self.assertFalse(w.store.maintenance_retryable(101))
        self.assertFalse(w.store.requeue_maintenance(101))

        self.tearDown()
        self.setUp()
        w, _ = self.diagnose(outcome="undetermined", blocked=True)
        d, = incidents(w)
        w.store.update(d["batch_id"], state="ERROR")
        self.assertFalse(w.store.maintenance_retryable(101))
        self.assertFalse(w.store.requeue_maintenance(101))
        self.assertEqual(w.store.defect(d["id"])["state"], "HELD")

    def test_retry_diagnosis_does_not_accept_a_previous_attempt_marker(self):
        w, first = self.diagnose(outcome="undetermined", blocked=True)
        first_marker = f"incident-diagnosis-101-attempt-{first['id']}"
        self.assertTrue(any(first_marker in c["body"] for c in w.gh.issue_comments_[101]))
        self.assertTrue(control.retry_maintainer(w.store, 101))
        w.tick(4)
        second = [b for b in w.store.all_batches() if b["method"] == "m"][-1]
        self.assertEqual(second["shard"], "issue-2")
        path = Path(second["worktree"]) / ".warroom-scratch/incident-diagnosis.json"
        evidence_path, = (Path(second["worktree"]) / ".warroom-scratch/incident").glob("*.json")
        evidence = json.loads(evidence_path.read_text())
        self.assertEqual(evidence["maintainer_attempt"], second["id"])
        unknown = sorted(k for k, v in evidence["envelope"]["observed"].items() if v["status"] == "unknown")
        names = ",".join(unknown)
        reason = f"접수 시 필수 관측 `{names}`가 unknown이라 원본 증거 무결성을 검증할 수 없습니다"
        summary = "접수 증거를 재검증하지 못했습니다"
        next_action = "운영자가 원본 evidence 접근과 hash를 확인한 뒤 Maintainer를 다시 실행합니다"
        path.write_text(json.dumps({"version": 1, "issue": 101, "outcome": "undetermined", "summary": summary,
                                    "blocker": {"observation": names, "reason": reason}, "next_action": next_action}))
        # The existing Issue comment has only the prior attempt's marker.
        current_marker = f"incident-diagnosis-101-attempt-{second['id']}"
        self.assertFalse(any(current_marker in c["body"] for c in w.gh.issue_comments_[101]))
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick(3)
        assert_continued(self, w, second, "comment_missing")

    def test_classification_without_a_proven_blocker_is_refused_and_continues(self):
        for i, (outcome, reason) in enumerate((("no_code_fix", "result_schema"), ("external", "result_schema"),
                                               ("undetermined", "undetermined_unproven"),
                                               ("recurrence", "result_schema"))):
            if i:
                self.tearDown()
                self.setUp()
            w, m = self.diagnose(outcome=outcome)
            assert_continued(self, w, m, reason)
            d, = incidents(w)
            self.assertEqual(d["state"], "LINKED", outcome)
            self.assertEqual(w.store.batch(d["batch_id"])["state"], "PAUSED", outcome)

    def test_a_fabricated_blocker_is_refused_and_continues(self):
        w, m = self.diagnose(blocked=False, blocker={"observation": "checkpoint", "reason": "invented"})
        assert_continued(self, w, m, "undetermined_unproven")
        d, = incidents(w)
        self.assertEqual(d["state"], "LINKED")
        self.assertEqual(w.store.batch(d["batch_id"])["state"], "PAUSED")

    def test_noncritical_unknown_observation_does_not_prove_an_evidence_blocker(self):
        w, m = self.diagnose(blocked=True, unknown_observation="events")
        assert_continued(self, w, m, "undetermined_unproven")

    def test_prior_attempt_marker_cannot_authorize_a_new_handoff(self):
        w, m = self.diagnose(blocked=True, stale_marker=True)
        assert_continued(self, w, m, "comment_missing")

    def test_diagnosis_missing_or_with_a_commit_continues_with_its_reason(self):
        for kwargs, reason in (({"valid": False}, "no_pr_no_result"),
                               ({"commit": True, "blocked": True}, "handoff_worktree_not_clean")):
            with self.subTest(kwargs):
                self.tearDown()
                self.setUp()
                w, m = self.diagnose(**kwargs)
                assert_continued(self, w, m, reason)

    def test_fix_to_supervisor_code_waits_until_the_running_process_has_it(self):
        w = self.w
        b = produce_and_report(w)
        w.git.changed[MERGE] = ["tools/warroom/warroom/supervisor.py"]
        w.cfg["shared_defect_verify"] = [["true"]]
        w.sup.code_sha = "1" * 40
        run_maintainer_to_merge(w, 101)
        w.tick(5)
        self.assertEqual((w.row()["state"], w.store.defects()[0]["state"]), ("PAUSED", "FIX_MERGED"))
        self.assertEqual(sum("재시작 필요" in e["msg"] for e in w.store.batch_events(b["id"])), 1)
        w.git.ancestor_pairs.add((MERGE, w.sup.code_sha))   # restarted: the loaded code contains the fix
        w.tick(3)
        self.assertEqual(w.row()["state"], "PRODUCING")
        self.assertEqual(w.store.defects()[0]["state"], "RELEASED")


class AutonomousIncidentReview(unittest.TestCase):
    """Review fixes for #3326: fail-closed code gate, crash-safe diagnosis cleanup, explicit atomic evidence, per-phase outcomes."""

    def setUp(self):
        self.t = AutonomousIncident()
        self.t.setUp()
        self.w = self.t.w

    def tearDown(self):
        self.t.tearDown()

    def test_unprovable_code_load_waits(self):
        w = self.w
        produce_and_report(w)
        w.git.changed[MERGE] = ["tools/warroom/warroom/supervisor.py"]
        w.cfg["shared_defect_verify"] = [["true"]]
        w.sup.code_sha = None                        # unknown / dirty runtime source
        run_maintainer_to_merge(w, 101)
        w.tick(4)
        self.assertEqual(w.store.defects()[0]["state"], "FIX_MERGED")
        orig = w.git.changed_files
        w.sup.code_sha = "1" * 40
        w.git.ancestor_pairs.add((MERGE, w.sup.code_sha))
        w.git.changed_files = lambda sha: (_ for _ in ()).throw(RuntimeError("lookup failed"))
        w.tick(3)
        self.assertEqual(w.store.defects()[0]["state"], "FIX_MERGED")   # a failed lookup is not proof either
        w.git.changed_files = orig
        w.tick(3)
        self.assertEqual(w.store.defects()[0]["state"], "RELEASED")

    def test_evidence_is_explicit_atomic_and_required(self):
        t, w = self.t, self.w
        b, = t.released("deepseek")
        w.store.set(f"unrelated_secret_{b['id']}", "x")
        w.sup._fail(b, "ERROR", t.rejected(b))
        w.tick(4)
        m = [x for x in w.store.all_batches() if x["method"] == "m"][-1]
        files = list((Path(m["worktree"]) / ".warroom-scratch/incident").glob("*.json"))
        data = json.loads(files[0].read_text())
        self.assertIn(f"d_base_head_{b['id']}", data["kv"])
        self.assertIn(f"error_evidence_{b['id']}_1", data["kv"])
        self.assertEqual(data["maintainer_attempt"], m["id"])
        self.assertNotIn(f"unrelated_secret_{b['id']}", data["kv"])
        self.assertEqual(list(files[0].parent.glob("*.tmp")), [])

    def test_evidence_write_failure_does_not_start_the_maintainer(self):
        t, w = self.t, self.w
        b, = t.released("deepseek")
        launches = len(w.adapter.launches)
        w.sup._fail(b, "ERROR", t.rejected(b))
        w.sup.maint.write_incident_evidence = lambda mb: "증거 작성 실패(테스트)"
        w.tick(4)
        m = [x for x in w.store.all_batches() if x["method"] == "m"][-1]
        self.assertEqual((m["state"], len(w.adapter.launches)), ("ERROR", launches))

    def test_legacy_diagnosis_marker_does_not_bypass_the_new_handoff_proof(self):
        t, w = self.t, self.w
        b, = t.released("deepseek")
        w.sup._fail(b, "ERROR", t.rejected(b))
        w.tick(4)
        m = [x for x in w.store.all_batches() if x["method"] == "m"][-1]
        wt = Path(m["worktree"])
        w.store.set(f"m_diag_{m['id']}", json.dumps({"issue": 102, "outcome": "undetermined",
                                                     "base": w.git.local_head, "branch": m["branch"],
                                                     "worktree": m["worktree"]}))
        self.assertEqual(w.sup.maint.finish_diagnosis(m).kind, "BLOCKED")
        self.assertTrue(wt.exists())
        self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")

    def test_diagnosis_cleanup_survives_a_crash_before_the_state_transaction(self):
        t, w = self.t, self.w
        b, = t.released("deepseek")
        observe = w.sup.maint._observe
        def observed_with_unknown(batch, evidence):
            result = observe(batch, evidence)
            result["checkpoint"] = {"status": "unknown", "value": "fixture read failure"}
            return result
        w.sup.maint._observe = observed_with_unknown
        w.sup._fail(b, "ERROR", t.rejected(b))
        w.tick(4)
        m = [x for x in w.store.all_batches() if x["method"] == "m"][-1]
        wt = Path(m["worktree"])
        summary = "접수 증거를 재검증하지 못했습니다"
        reason = "접수 시 필수 관측 `checkpoint`가 unknown이라 원본 증거 무결성을 검증할 수 없습니다"
        next_action = "운영자가 원본 evidence 접근과 hash를 확인한 뒤 Maintainer를 다시 실행합니다"
        data = {"version": 1, "issue": 102, "outcome": "undetermined", "summary": summary,
                "blocker": {"observation": "checkpoint", "reason": reason}, "next_action": next_action}
        (wt / ".warroom-scratch/incident-diagnosis.json").write_text(json.dumps(data))
        marker = f"incident-diagnosis-102-attempt-{m['id']}"
        w.gh.comment_issue(102, f"{summary}\n{reason}\n{next_action}\n\n"
                              + defects.marker(defects.EVENT_MARK, f"incident-diagnosis-102-attempt-{m['id']}"))
        real = w.store.complete_diagnosis
        w.store.complete_diagnosis = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("crash"))
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        try:
            w.tick(2)
        except RuntimeError:
            pass
        self.assertFalse(wt.exists())                                   # removed, state not yet saved
        proof = json.loads(w.store.get(f"m_diag_{m['id']}"))
        self.assertEqual(proof["version"], 2)                          # proof is persisted before cleanup
        self.assertEqual(proof["outcome"], "undetermined")
        w.store.complete_diagnosis = real
        w.tick(2)                                                       # re-entry finishes the same diagnosis
        self.assertEqual(w.store.batch(m["id"])["state"], "COMPLETE")
        self.assertEqual(w.store.maintenance(102)["state"], "HELD")
        self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")

    def test_outcomes_are_reported_once_per_phase(self):
        t, w = self.t, self.w
        b, = t.released("deepseek")
        d = w.store.defects()[0]
        with w.store._conn() as c:
            c.execute("UPDATE defects SET source='incident' WHERE id=?", (d["id"],))   # a RELEASED incident of this batch
            c.execute("UPDATE batches SET method='a' WHERE id=?", (b["id"],))          # an A batch is never re-received
        w.store.update(b["id"], state="WAITING_REVIEW", pr_number=70)
        w.tick(3)
        w.store.update(b["id"], state="COMPLETE")
        w.tick(3)
        w.store.update(b["id"], state="ERROR", error="later failure")
        w.tick(3)
        w.tick(3)
        bodies = [c["body"] for c in w.gh.issue_comments_.get(101, [])]
        for phase in ("review", "complete", "stopped-error"):
            self.assertEqual(sum(f"incident-outcome-{d['id']}-{phase}" in x for x in bodies), 1, phase)


class IncidentNumberAndIntake(unittest.TestCase):
    """#3349 §1–§4: the incident number counts transitions only; one sweep receives every supported production ERROR;
    operator controls win inside the pausing transaction; intake is idempotent and fails safe."""

    def setUp(self):
        self.t = AutonomousIncident()
        self.t.setUp()
        self.w = self.t.w

    def tearDown(self):
        self.t.tearDown()

    def test_the_number_counts_transitions_and_keeps_the_first_values(self):
        w = self.w
        b = make_batch(w)
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="first text")
        one = w.store.batch(b["id"])
        self.assertEqual((one["error_seq"], one["error_first"]), (1, "first text"))
        w.store.update(b["id"], state="ERROR", error="second text")          # same ERROR, new wording
        two = w.store.batch(b["id"])
        self.assertEqual((two["error_seq"], two["error_at"], two["error_first"], two["error"]),
                         (1, one["error_at"], "first text", "second text"))
        w.store.update(b["id"], state="PRODUCING", error=None)               # operator Retry
        w.store.update(b["id"], state="ERROR", error="again")
        three = w.store.batch(b["id"])
        self.assertEqual((three["error_seq"], three["error_first"]), (2, "again"))
        w.store.update(b["id"], pid=None, session_id="x")                     # a non-state write never counts
        self.assertEqual(w.store.batch(b["id"])["error_seq"], 2)

    def test_error_evidence_of_an_event_keeps_its_first_record(self):
        w = self.w
        b, = self.t.released("deepseek")
        problem = self.t.rejected(b)
        w.sup._fail(b, "ERROR", problem)
        first = w.store.get(f"error_evidence_{b['id']}_1")
        w.git.local_head = "d" * 40                       # a later write of the SAME ERROR with another receipt
        w.sup._fail(w.store.batch(b["id"]), "ERROR", defects.BoundaryProblem("later", {**problem.receipt, "head": "d" * 40}))
        self.assertEqual((w.store.get(f"error_evidence_{b['id']}_1"), w.store.batch(b["id"])["error_seq"]), (first, 1))

    def test_batches_without_a_number_are_not_received_and_are_listed_once(self):
        w = self.w
        b = make_batch(w)
        with w.store._conn() as c:
            c.execute("UPDATE batches SET state='ERROR', paused_from='PRODUCING', error='old' WHERE id=?", (b["id"],))
        w.tick(3)
        self.assertEqual((incidents(w), w.store.batch(b["id"])["state"]), ([], "ERROR"))
        self.assertEqual(sum("사건 번호가 없는" in e["msg"] for e in w.store.recent_events(500)), 1)

    def test_one_sweep_receives_c_d_stage2_stage3_through_any_error_path(self):
        w = self.w
        rows = [make_batch(w, "c", "deepseek", "001", "01", "c_parallel"),
                make_batch(w, "d", "deepseek", "002", "01", "d_chunk_new"),
                make_batch(w, "s2", "deepseek", "003", "01-01", "s2_parallel"),
                make_batch(w, "s3", "deepseek", "004", "00", "s3_finalize")]
        for i, b in enumerate(rows):
            break_batch(w, b, direct=bool(i % 2))          # `_fail` for two, a direct Store write for the others
        w.tick(2)
        self.assertEqual(sorted(d["event_key"] for d in incidents(w)), sorted(f"incident:{b['id']}:e1" for b in rows))
        self.assertTrue(all(w.store.batch(b["id"])["state"] == "PAUSED" for b in rows))

    def test_a_b_maintainer_stop_and_clearing_are_never_received(self):
        w = self.w
        a = make_batch(w, "a", "deepseek", "001", "01", "produce")
        break_batch(w, a)
        d = make_batch(w, "d", "deepseek", "002", "01")
        w.store.update(d["id"], state="PAUSED", paused_from="PRODUCING", error="Stop")              # not an ERROR
        c = make_batch(w, "c", "deepseek", "003", "01", "c_chunk_new")
        w.store.update(c["id"], state="ERROR", paused_from="CLEARING", error="clear failed")        # Clear in progress
        w.tick(3)
        self.assertEqual(incidents(w), [])
        self.assertEqual(w.store.batch(a["id"])["state"], "ERROR")

    def test_a_prepare_error_without_a_worktree_is_received_with_missing_observations(self):
        w = self.w
        b = make_batch(w, "d", state="PREPARE", run_kind=None, worktree=False)
        break_batch(w, b, "worktree 준비 실패: boom", paused_from="PREPARE")
        w.tick(2)
        d, = incidents(w)
        env = defects.parse_incident(d["report"].partition("\n")[0])
        self.assertEqual([env["observed"][k]["status"] for k in ("git", "checkpoint", "runs", "log_file")], ["missing"] * 4)
        self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")

    def test_a_live_process_or_task_run_defers_the_intake_and_a_conflicting_owner_blocks_it(self):
        w = self.w
        b = break_batch(w, make_batch(w))
        w.store.update(b["id"], pid=4242)
        w.sup.maint._intake_errors()
        self.assertEqual(incidents(w), [])
        w.store.update(b["id"], pid=None)
        other = make_batch(w, "d", "sonnet", "009", "01")
        with w.store._conn() as c:
            c.execute("UPDATE batches SET branch=? WHERE id=?", (b["branch"], other["id"]))
        w.sup.maint._intake_errors()
        self.assertEqual((incidents(w), w.store.batch(b["id"])["state"]), ([], "ERROR"))   # contradictory identity
        w.store.update(other["id"], state="COMPLETE")
        w.sup.maint._intake_errors()
        self.assertEqual(len(incidents(w)), 1)

    def test_operator_controls_win_inside_the_pausing_transaction(self):
        w = self.w
        cases = {
            "clear request": lambda b: w.store.request_clear("deepseek", "d", b["id"]),
            "force stop": lambda b: w.store.set_line("deepseek", "d", force_stop=1),
            "retry": lambda b: w.store.set_line("deepseek", "d", retry_batch=b["id"]),
            "stop pin": lambda b: w.store.set("stop_pin_deepseek_d", str(b["id"])),
            "defect hold": lambda b: w.store.set(f"defect_hold_{b['id']}", "1"),
            "live pid": lambda b: w.store.update(b["id"], pid=77),
            "task run": lambda b: w.store.add_run(b["id"], "d_chunk_new", None, 5, "/l", "/e", task="001"),
        }
        for n, (name, arrange) in enumerate(cases.items()):
            with self.subTest(name):
                b = break_batch(w, make_batch(w, "d", "deepseek", f"{n + 1:03d}", "01"))
                expect = {k: b[k] for k in ("error_seq", "paused_from", "run_kind", "branch", "worktree")}
                kw = dict(batch_id=b["id"], event_key=f"k{n}", source="incident", defect_class="incident-d-1-e1", state="REPORTED",
                          report="{}", pause_reason="shared_defect", error=None)
                arrange(b)
                self.assertIsNone(w.store.report_defect(expect=expect, **kw))
                self.assertEqual((w.store.batch(b["id"])["state"], incidents(w)), ("ERROR", []))
                w.store.set_line("deepseek", "d", force_stop=0, retry_batch=None)       # the next case starts clean
                w.store.delete("stop_pin_deepseek_d")
                with w.store._conn() as c:
                    c.execute("DELETE FROM clear_requests")
                w.store.update(b["id"], state="COMPLETE", pid=None)
        b = break_batch(w, make_batch(w, "d", "deepseek", "099", "01"))
        kw = dict(batch_id=b["id"], event_key="kx", source="incident", defect_class="incident-d-1-e1", state="REPORTED",
                  report="{}", pause_reason="shared_defect", error=None)
        expect = {k: b[k] for k in ("error_seq", "paused_from", "run_kind", "branch", "worktree")}
        self.assertIsNone(w.store.report_defect(expect={**expect, "error_seq": 9}, **kw))   # another event
        self.assertIsNotNone(w.store.report_defect(expect=expect, **kw))                     # the exact one passes

    def test_defect_hold_and_stop_pin_each_block_and_an_emptied_hold_does_not(self):
        w = self.w
        b = break_batch(w, make_batch(w))
        w.store.set(f"defect_hold_{b['id']}", "1")
        w.sup.maint._intake_errors()
        self.assertEqual(incidents(w), [])
        w.store.set(f"defect_hold_{b['id']}", "")          # an emptied hold is no hold
        w.store.set("stop_pin_deepseek_d", "1")
        w.sup.maint._intake_errors()
        self.assertEqual(incidents(w), [])
        w.store.delete("stop_pin_deepseek_d")
        w.sup.maint._intake_errors()
        self.assertEqual(len(incidents(w)), 1)

    def test_operator_clear_overrides_the_incident_and_the_maintainer_is_not_started(self):
        w = self.w
        b = break_batch(w, make_batch(w))
        w.sup.maint._intake_errors()
        d, = incidents(w)
        w.store.request_clear("deepseek", "d", b["id"])
        w.store.pin_clear("deepseek", "d")
        self.assertEqual(w.store.defect(d["id"])["state"], "OVERRIDDEN")
        w.store.update_defect(d["id"], issue_number=101, state="OVERRIDDEN")
        w.store.ensure_maintenance(101)
        w.tick(3)
        self.assertIsNone(maintainer_row(w))
        self.assertEqual(w.store.maintenance(101)["state"], "HELD")

    def test_repeated_ticks_other_events_and_other_batches(self):
        w = self.w
        b = break_batch(w, make_batch(w))
        w.tick(4)
        self.assertEqual((len(incidents(w)), w.gh.created), (1, [101]))
        # operator Retry resumes it; the next ERROR is a NEW event and a NEW Issue; another batch is separate too
        w.store.update(b["id"], state="PRODUCING", pause_reason="", defect_id=None, error=None)
        w.store.update_defect(incidents(w)[0]["id"], state="OVERRIDDEN")
        break_batch(w, w.store.batch(b["id"]), "second event")
        other = break_batch(w, make_batch(w, "c", "deepseek", "005", "01", "c_chunk_new"))
        w.tick(4)
        self.assertEqual(sorted(d["event_key"] for d in incidents(w)),
                         sorted([f"incident:{b['id']}:e1", f"incident:{b['id']}:e2", f"incident:{other['id']}:e1"]))
        self.assertEqual(len(w.gh.created), 3)

    def test_credentials_in_an_error_never_reach_github_but_stay_in_the_local_record(self):
        w = self.w
        secrets = ["ghp_" + "a" * 30, "https://user:hunter2pass@example.com/x.git", "Bearer abcdef0123456789abcd"]
        raw = "git 실패: " + " ".join(secrets) + " token=zzzzzzzzzzzzzzzz1"
        pad = "x" * (590 - len(raw) % 590)
        raw = raw + " " + pad + " Bearer abcdefghijklmnop0123 https://u:pw1234567@h.example/r"   # secrets straddle the 600-char cut
        b = break_batch(w, make_batch(w), raw)
        w.tick(2)
        d, = incidents(w)
        w.store.update_defect(d["id"], state="HELD", hold_reason="검증 실패 " + raw)
        w.store.update(b["id"], error=raw)
        w.sup.maint._report_outcomes()
        published = [w.gh.issues[101]["body"]] + [c["body"] for c in w.gh.issue_comments_.get(101, [])]
        self.assertTrue(any("진단/보류 결과" in x for x in published))
        for text in published:
            for secret in secrets + ["hunter2pass", "zzzzzzzzzzzzzzzz1", "abcdefghijklmnop", "abcdefghijk", "pw1234567", "u:pw", "Bearer ab", "u:p"]:
                self.assertNotIn(secret, text)
        self.assertIn("[REDACTED]", w.gh.issues[101]["body"])
        self.assertEqual(w.store.batch(b["id"])["error_first"], raw)       # the original stays local
        self.assertIn(secrets[1], d["report"] + (w.store.batch(b["id"])["error"] or ""))

    def test_envelope_failure_keeps_the_error(self):
        w = self.w
        b = break_batch(w, make_batch(w))
        w.sup.maint._observe = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no envelope"))
        w.tick(2)
        self.assertEqual((w.store.batch(b["id"])["state"], incidents(w)), ("ERROR", []))
        del w.sup.maint._observe
        w.tick(2)
        self.assertEqual(len(incidents(w)), 1)

    def test_an_unobservable_item_is_unknown_not_a_blocked_intake(self):
        w = self.w
        b = break_batch(w, make_batch(w))
        real = w.git.remote_head
        w.git.remote_head = lambda branch: (_ for _ in ()).throw(RuntimeError("git down"))
        w.tick(2)
        w.git.remote_head = real
        d, = incidents(w)
        env = defects.parse_incident(d["report"].partition("\n")[0])
        self.assertEqual(env["observed"]["git"]["status"], "unknown")


class IncidentRecoveryProof(unittest.TestCase):
    """#3349 §4–§6: recurrence only when proven; Runtime-only vs Worktree-integration proofs; HOLD when unprovable."""

    PROMPT = "tools/warroom/prompts/d_chunk_resume.md"
    PY = "tools/warroom/warroom/supervisor.py"

    def setUp(self):
        self.t = AutonomousIncident()
        self.t.setUp()
        self.w = self.t.w
        self.w.cfg["shared_defect_verify"] = [["true"]]
        self.w.sup.prompt_checkout_clean = lambda paths: True      # the main checkout carries the prompts unmodified
        self.w.sup.code_sha = "1" * 40
        self.w.git.ancestor_pairs |= {(MERGE, HEAD1), (MERGE, "d" * 40), (MERGE, self.w.sup.code_sha)}   # the checkouts contain the fix

    def tearDown(self):
        self.t.tearDown()

    def merged(self, files, method="d", run_kind="d_chunk_resume", paused_from="PRODUCING", error_fields=None, **fields):
        """An incident for a fresh batch, its Maintainer fix merged (FIX_MERGED), nothing applied yet."""
        w = self.w
        b = make_batch(w, method, run_kind=run_kind, **fields)
        w.store.update(b["id"], state="ERROR", paused_from=paused_from, error="boom", **(error_fields or {}))
        w.git.changed[MERGE] = files
        w.tick(2)                                  # the sweep receives it, the Issue is published, the Maintainer starts
        d, = incidents(w)
        return self.merge_fix(b, d)

    def merge_fix(self, b, d):
        """The Maintainer's PR merges and is cleaned up; the release is held back so a test can arrange its situation."""
        w = self.w
        w.sup.maint._release = lambda: None
        run_maintainer_to_merge(w, d["issue_number"])
        d = w.store.defect(d["id"])
        self.assertEqual(d["state"], "FIX_MERGED")
        return w.store.batch(b["id"]), d

    def settle(self, d, ticks=1):
        self.w.sup.maint.__dict__.pop("_release", None)
        self.w.tick(ticks)
        return self.w.store.defect(d["id"])

    def test_stage2_prepare_incident_integrates_only_an_untouched_part(self):
        from unittest.mock import patch
        for changed in (False, True):
            with self.subTest(changed=changed):
                if changed:
                    self.tearDown()
                    self.setUp()
                w = self.w
                b = make_batch(w, "s2", shard="003", batch="01-01", run_kind=None, state="PREPARE")
                w.store.set(stage2.mode_key(b["id"]), stage2.PARALLEL)
                w.store.update(b["id"], state="ERROR", paused_from="PREPARE", error=(
                    "Stage 2 병렬 task 계획 준비 실패: admission-cli prepare 실패: missing sense"))
                w.git.changed[MERGE] = ["scripts/relation/admission.mjs"]
                w.tick(2)
                d, = incidents(w)
                b, d = self.merge_fix(b, d)
                w.git.integrate_updates_head = True
                if changed:
                    w.store.add_tasks(b["id"], [("unexpected", "001")])
                with patch.object(w.sup.maint, "_verify", return_value=None):
                    w.sup.maint._release_incident(d, b)
                d = w.store.defect(d["id"])
                b = w.store.batch(b["id"])
                if changed:
                    self.assertEqual((d["state"], b["state"]), ("HELD", "PAUSED"))
                    self.assertFalse(any(path == b["worktree"] for path, _ in w.git.integrated))
                else:
                    self.assertEqual((d["state"], b["state"], d["integrated_sha"]),
                                     ("RELEASED", "PREPARE", MERGE))
                    self.assertTrue(w.git.contains(Path(b["worktree"]), MERGE))
                    self.assertEqual(w.store.task_rows(b["id"]), [])
                    with patch.object(w.sup.s2p, "poll"):
                        w.sup._prepare_existing_do(b)
                    resumed = w.store.batch(b["id"])
                    self.assertEqual((resumed["state"], resumed["run_kind"]), ("PRODUCING", "s2_parallel"))
                    self.assertTrue(w.store.task_rows(b["id"]))
                    self.assertIsNotNone(stage2.checkpoint(b["worktree"], b["shard"], b["batch"]))

    # ---- Runtime-only ---------------------------------------------------------------------------------------------
    def test_prompt_only_fix_resumes_without_restart_integration_or_line_flag_change(self):
        w = self.w
        b, d = self.merged([self.PROMPT], session_id="ses_1")
        before = dict(w.store.line("deepseek", "d"))
        d = self.settle(d)
        row = w.store.batch(b["id"])
        self.assertEqual((d["state"], d["fix_kind"], d["integrated_sha"], d["applied_code_sha"]), ("RELEASED", "runtime", None, HEAD1))
        self.assertEqual((row["state"], row["pause_reason"]), ("PRODUCING", ""))
        self.assertEqual(w.git.integrated, [x for x in w.git.integrated if x[0] != b["worktree"]])   # production worktree untouched
        after = dict(w.store.line("deepseek", "d"))
        self.assertEqual((after["run"], after["drain"], after["force_stop"]), (before["run"], before["drain"], before["force_stop"]))
        self.assertIsNone(w.store.get(f"restart_needed_{d['id']}"))
        bodies = [c["body"] for c in w.gh.issue_comments_.get(d["issue_number"], [])]
        self.assertEqual(sum(f"incident-outcome-{d['id']}-applied" in x for x in bodies), 1)

    def test_python_fix_waits_for_the_loaded_code_then_resumes(self):
        w = self.w
        w.git.ancestor_pairs.discard((MERGE, w.sup.code_sha))
        b, d = self.merged([self.PY])
        d = self.settle(d)
        d = self.settle(d)
        self.assertEqual((d["state"], w.store.batch(b["id"])["state"]), ("FIX_MERGED", "PAUSED"))
        self.assertEqual(sum("재시작 필요" in e["msg"] for e in w.store.batch_events(b["id"])), 1)
        w.git.ancestor_pairs.add((MERGE, w.sup.code_sha))
        d = self.settle(d)
        self.assertEqual((d["state"], d["fix_kind"], d["integrated_sha"]), ("RELEASED", "runtime", None))

    def test_d_cli_fix_waits_for_supervisor_checkout_before_worktree_release(self):
        w = self.w
        b, d = self.merged(["scripts/relation/d-chunk-cli.mjs"])
        w.git.ancestor_pairs.discard((MERGE, w.sup.code_sha))
        d = self.settle(d)
        self.assertEqual((d["state"], w.store.batch(b["id"])["state"]), ("FIX_MERGED", "PAUSED"))
        self.assertFalse(any(path == b["worktree"] for path, *_ in w.git.integrated))
        w.git.ancestor_pairs.add((MERGE, w.sup.code_sha))
        self.assertFalse(w.sup.maint._fix_not_loaded(d))
        w.sup.prompt_checkout_clean = lambda paths: False
        self.assertTrue(w.sup.maint._fix_not_loaded(d))

    def test_a_prompt_the_resumed_launch_does_not_render_holds(self):
        w = self.w
        b, d = self.merged(["tools/warroom/prompts/d_chunk.md"], session_id="ses_1")   # a resume sends only d_chunk_resume
        d = self.settle(d)
        self.assertEqual(d["state"], "HELD")
        self.assertIn("재개 증명 불가", d["hold_reason"])
        self.assertIn("재개 실행에 전달되지 않음", d["hold_reason"])
        self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")

    def test_stage2_deterministic_finalize_releases_for_repair_prompt_only(self):
        w = self.w
        b, d = self.merged([self.PY, "tools/warroom/prompts/s2_repair.md"],
                           method="s2", run_kind="s2_deterministic_finalize")
        self.assertEqual(w.sup.resume_prompt_names(b), {"s2_repair"})
        d = self.settle(d)
        self.assertEqual(d["state"], "RELEASED")
        self.assertEqual(w.store.batch(b["id"])["state"], "PRODUCING")

    def test_stage2_deterministic_finalize_does_not_claim_other_prompts(self):
        w = self.w
        b, d = self.merged(["tools/warroom/prompts/s2_links.md"],
                           method="s2", run_kind="s2_deterministic_finalize")
        d = self.settle(d)
        self.assertEqual(d["state"], "HELD")
        self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")

    def test_stage2_repair_rejected_answer_can_render_repair_prompt(self):
        from unittest import mock
        w = self.w
        b, d = self.merged([self.PY, "tools/warroom/prompts/s2_repair.md"],
                           method="s2", run_kind="s2_repair_new")
        current = {"pending_answer": None, "apply_intent": None, "cursor": 0, "fingerprint": "page",
                   "groups": [{"candidate_keys": ["candidate"]}],
                   "attempt_log": [{"status": "rejected", "cursor": 0, "fingerprint": "page"}]}
        with mock.patch.object(w.sup, "_stage2_repair_state", return_value={"current": current}):
            self.assertEqual(w.sup.resume_prompt_names(b), {"s2_repair"})
            d = self.settle(d)
        self.assertEqual(d["state"], "RELEASED")
        self.assertEqual(w.store.batch(b["id"])["state"], "PRODUCING")

    def test_stage2_repair_exhausted_retry_budget_holds_prompt_fix(self):
        from unittest import mock
        w = self.w
        b, d = self.merged(["tools/warroom/prompts/s2_repair.md"], method="s2", run_kind="s2_repair_new")
        attempt = {"status": "rejected", "cursor": 0, "fingerprint": "page", "reason_code": "content"}
        current = {"pending_answer": None, "apply_intent": None, "cursor": 0, "fingerprint": "page",
                   "groups": [{"candidate_keys": ["candidate"]}], "attempt_log": [attempt, dict(attempt)]}
        with mock.patch.object(w.sup, "_stage2_repair_state", return_value={"current": current}):
            self.assertIsNone(w.sup.resume_prompt_names(b))
            d = self.settle(d)
        self.assertEqual(d["state"], "HELD")
        self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")

    def test_stage2_repair_pending_answer_is_not_claimed_as_new_prompt(self):
        from unittest import mock
        w = self.w
        b, d = self.merged(["tools/warroom/prompts/s2_repair.md"], method="s2", run_kind="s2_repair_new")
        current = {"pending_answer": {"decisions": []}, "attempt_log": [{"status": "rejected"}]}
        with mock.patch.object(w.sup, "_stage2_repair_state", return_value={"current": current}):
            self.assertIsNone(w.sup.resume_prompt_names(b))
            d = self.settle(d)
        self.assertEqual(d["state"], "HELD")
        self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")

    def test_parallel_d_retry_with_one_used_fix_predicts_and_launches_the_fix_prompt(self):
        from unittest import mock
        from warroom import prompts

        w = self.w
        b = make_batch(w, "d", run_kind="d_parallel")
        task = "001"
        w.store.add_tasks(b["id"], [(task, task)])
        w.store.update_task(b["id"], task, state="FAILED", session_id="ses_1",
                            data=json.dumps({"ack": True, "kind": "resume", "resumed": True}))
        w.store.add_run(b["id"], "d_chunk_new", "ses_1", None, "old.log", "old.exit",
                        model="p/free-x-free", effort="high", task=task)
        w.store.set(dchunk.fix_key(b["id"], 1), "1")
        active = {"chunk_no": 1, "view_sha256": "v" * 64, "git_head": HEAD1}
        rejection = {"errors": ["fixture rejection"]}
        with mock.patch.object(dchunk, "read_active", return_value=active), \
             mock.patch.object(dchunk, "read_rejection", return_value=rejection), \
             mock.patch.object(dchunk, "fix_bindings", return_value="s1 [record=w1] w1-s1 · 표제어"):
            predicted = w.sup.resume_prompt_names(w.store.batch(b["id"]))
            self.assertEqual(predicted, {"d_chunk_fix"})

            round_ = dparallel._Round(w.sup.dp, w.store.batch(b["id"]))
            w.sup.dp._reset_acknowledged_failures(w.store.batch(b["id"]), round_)
            row = w.store.task_row(b["id"], task)
            self.assertEqual((row["state"], json.loads(row["data"])["kind"]), ("FIXQ", "fix"))

            w.adapter.plan.append({"code": 0, "session": "ses_1"})
            self.assertTrue(w.sup.dp._launch(w.store.batch(b["id"]), row, round_))

        launch = w.adapter.launches[-1]
        self.assertEqual(launch["prompt"], prompts.d_chunk_fix(b, 1, "fixture rejection\n\n거부된 Sense의 정확한 결속 (active 청크 기준):\ns1 [record=w1] w1-s1 · 표제어"))
        self.assertEqual(w.store.runs(b["id"])[0]["kind"], "d_chunk_fix")

    def test_parallel_d_stale_rejection_is_proved_without_writing_then_refreshed_for_retry(self):
        from unittest import mock
        w = self.w
        b = make_batch(w, "d", run_kind="d_parallel")
        task = "001"
        w.store.add_tasks(b["id"], [(task, task)])
        w.store.update_task(b["id"], task, state="FAILED", session_id="ses_1",
                            data=json.dumps({"ack": True, "kind": "fix"}))
        w.store.set(dchunk.fix_key(b["id"], 1), "1")
        active = {"chunk_no": 1, "view_sha256": "v" * 64, "git_head": HEAD1}
        rejection = {"errors": ["remaining rejected sense"]}
        with mock.patch.object(dchunk, "read_active", return_value=active), \
             mock.patch.object(dchunk, "read_rejection", return_value=None), \
             mock.patch.object(dchunk, "refresh_stale_search_rejection", return_value=rejection) as refresh:
            self.assertEqual(w.sup.resume_prompt_names(b), {"d_chunk_fix"})
            self.assertTrue(refresh.call_args.kwargs["dry_run"])
            self.assertTrue(refresh.call_args.kwargs["limit_to_previous"])
            round_ = dparallel._Round(w.sup.dp, b)
            w.sup.dp._reset_acknowledged_failures(b, round_)
            self.assertNotIn("dry_run", refresh.call_args.kwargs)
            row = w.store.task_row(b["id"], task)
            self.assertEqual((row["state"], json.loads(row["data"])["kind"]), ("FIXQ", "fix"))

    def test_parallel_d_queued_fix_reinspects_stale_rejection_before_launch(self):
        from unittest import mock
        from warroom import prompts
        w = self.w
        b = make_batch(w, "d", run_kind="d_parallel")
        w.store.add_tasks(b["id"], [("001", "001")])
        w.store.update_task(b["id"], "001", state="FIXQ", session_id="ses_1",
                            data=json.dumps({"kind": "fix"}))
        w.store.add_run(b["id"], "d_chunk_new", "ses_1", None, "old.log", "old.exit",
                        model="p/free-x-free", effort="high", task="001")
        w.store.set(dchunk.fix_key(b["id"], 1), str(dchunk.MAX_FIXES))
        active = {"chunk_no": 1, "view_sha256": "v" * 64, "git_head": HEAD1}
        rejection = {"errors": ["remaining rejected sense"]}
        round_ = dparallel._Round(w.sup.dp, b)
        w.adapter.plan.append({"code": 0, "session": "ses_1"})
        with mock.patch.object(dchunk, "read_active", return_value=active), \
             mock.patch.object(dchunk, "read_rejection", return_value=None), \
             mock.patch.object(dchunk, "refresh_stale_search_rejection", return_value=rejection) as refresh, \
             mock.patch.object(dchunk, "fix_bindings", return_value="s1 [record=w1] w1-s1 · 표제어"):
            self.assertTrue(w.sup.dp._launch(b, w.store.task_row(b["id"], "001"), round_))
            self.assertTrue(refresh.call_args.kwargs["limit_to_previous"])
        self.assertEqual(w.adapter.launches[-1]["prompt"], prompts.d_chunk_fix(b, 1, "remaining rejected sense\n\n거부된 Sense의 정확한 결속 (active 청크 기준):\ns1 [record=w1] w1-s1 · 표제어"))

    def test_parallel_d_queued_fix_with_already_valid_decisions_resumes_to_save(self):
        """#5171: a fix run repaired the judgments but stopped before save; no rejection is left to bind, so the queued
        fix must continue the same session as a resume instead of ending in a prompt error."""
        from unittest import mock
        w = self.w
        b = make_batch(w, "d", run_kind="d_parallel")
        w.store.add_tasks(b["id"], [("001", "001")])
        w.store.update_task(b["id"], "001", state="FIXQ", session_id="ses_1", data=json.dumps({"kind": "fix"}))
        w.store.add_run(b["id"], "d_chunk_fix", "ses_1", None, "old.log", "old.exit",
                        model="p/free-x-free", effort="high", task="001")
        w.store.set(dchunk.fix_key(b["id"], 1), str(dchunk.MAX_FIXES))
        active = {"chunk_no": 1, "view_sha256": "v" * 64, "git_head": HEAD1}
        round_ = dparallel._Round(w.sup.dp, b)
        w.adapter.plan.append({"code": 0, "session": "ses_1"})
        with mock.patch.object(dchunk, "read_active", return_value=active), \
             mock.patch.object(dchunk, "read_rejection", return_value=None), \
             mock.patch.object(dchunk, "refresh_stale_search_rejection", return_value=None), \
             mock.patch.object(dchunk, "corrected_decisions_valid", return_value=True), \
             mock.patch.object(w.sup, "_d_chunk_prompt", return_value=("resume prompt", None)):
            self.assertTrue(w.sup.dp._launch(b, w.store.task_row(b["id"], "001"), round_))
        self.assertEqual(w.store.batch(b["id"])["state"], "PRODUCING")
        self.assertEqual(w.adapter.launches[-1]["prompt"], "resume prompt")
        self.assertEqual(w.store.runs(b["id"])[0]["kind"], "d_chunk_resume")   # runs() is newest-first
        # an invalid/unknown inspection still fails closed
        w.store.update_task(b["id"], "001", state="FIXQ")
        with mock.patch.object(dchunk, "read_active", return_value=active), \
             mock.patch.object(dchunk, "read_rejection", return_value=None), \
             mock.patch.object(dchunk, "refresh_stale_search_rejection", return_value=None), \
             mock.patch.object(dchunk, "corrected_decisions_valid", return_value=False):
            self.assertFalse(w.sup.dp._launch(b, w.store.task_row(b["id"], "001"), round_))

    def test_parallel_c_retry_predicts_the_actual_correction_prompt(self):
        from unittest import mock
        from warroom import literary, cparallel

        w = self.w
        b = make_batch(w, "c", run_kind="c_parallel")
        w.store.add_tasks(b["id"], [("004", "004")])
        w.store.update_task(b["id"], "004", state="FAILED", session_id="ses_1",
                            data=json.dumps({"ack": True, "completed_fix_runs": []}))
        with mock.patch.object(literary, "read_active", return_value={"chunk_no": 4}), \
             mock.patch.object(literary, "submit_retryable", return_value=True):
            self.assertEqual(w.sup.resume_prompt_names(b), {"c_chunk_resume"})
            round_ = cparallel._Round(w.sup.cp, b)
            w.sup.cp._reset_acknowledged_failures(b, round_)
            row = w.store.task_row(b["id"], "004")
            self.assertEqual((row["state"], json.loads(row["data"])["kind"]), ("FIXQ", "fix"))
        with mock.patch.object(literary, "read_active", return_value=None):
            w.store.update_task(b["id"], "004", state="FAILED", data=json.dumps({"ack": True}))
            self.assertIsNone(w.sup.resume_prompt_names(b))

    def test_a_held_incident_is_reproved_after_the_code_checkout_changes(self):
        from unittest import mock
        from pathlib import Path
        from warroom import dchunk

        w = self.w
        files = ["tools/warroom/prompts/d_chunk.md", "tools/warroom/prompts/d_chunk_fix.md",
                 "tools/warroom/prompts/d_chunk_resume.md"]
        b, d = self.merged(files, run_kind="d_parallel")
        task = "009"
        w.store.add_tasks(b["id"], [(task, task)])
        w.store.update_task(b["id"], task, state="FAILED", session_id="ses_1",
                            data=json.dumps({"ack": True, "kind": "resume", "resumed": True}))
        w.store.set(f"defect_reproof_head_{d['id']}", HEAD1)
        w.store.update_defect(d["id"], state="HELD", hold_reason="재개 증명 불가: d_parallel: 이전 코드에서 prompt 집합을 계산할 수 없음")
        w.sup.code_sha = HEAD1
        w.git.ancestor_pairs.add((MERGE, HEAD2))
        w.store.set(f"defect_hold_{b['id']}", "1")
        self.assertFalse(w.store.rearm_held_defect(d["id"], b["id"], HEAD2))
        self.assertEqual(w.store.defect(d["id"])["state"], "HELD")
        w.store.delete(f"defect_hold_{b['id']}")
        active = {"chunk_no": 9, "view_sha256": "v" * 64, "git_head": HEAD1}
        with mock.patch.object(w.git, "head", side_effect=lambda path: HEAD2 if Path(path) == w.sup.code_root else HEAD1), \
             mock.patch.object(dchunk, "read_active", return_value=active), \
             mock.patch.object(dchunk, "read_rejection", return_value=None):
            d = self.settle(d)   # checkout H2 with H1 loaded must not consume H2's reproof
            self.assertEqual((d["state"], w.store.get(f"defect_reproof_head_{d['id']}")), ("HELD", HEAD1))
            w.sup.code_sha = HEAD2   # the Supervisor has now restarted from H2
            d = self.settle(d)

        self.assertEqual((d["state"], d["fix_kind"], d["applied_code_sha"]), ("RELEASED", "runtime", HEAD2))
        self.assertEqual((w.store.batch(b["id"])["state"], w.store.batch(b["id"])["pause_reason"]), ("PRODUCING", ""))

    def test_a_failed_held_reproof_waits_for_another_code_change(self):
        from unittest import mock
        from warroom import dchunk

        w = self.w
        b, d = self.merged(["tools/warroom/prompts/d_chunk.md"], run_kind="d_parallel")
        task = "009"
        w.store.add_tasks(b["id"], [(task, task)])
        w.store.update_task(b["id"], task, state="FAILED", session_id="ses_1",
                            data=json.dumps({"ack": True, "kind": "resume", "resumed": True}))
        w.sup.code_sha = HEAD1
        w.store.set(f"defect_reproof_head_{d['id']}", "c" * 40)
        w.store.update_defect(d["id"], state="HELD", hold_reason="재개 증명 불가: d_parallel: 이전 코드에서 prompt 집합을 계산할 수 없음")
        active = {"chunk_no": 9, "view_sha256": "v" * 64, "git_head": HEAD1}
        with mock.patch.object(dchunk, "read_active", return_value=active), \
             mock.patch.object(dchunk, "read_rejection", return_value=None):
            d = self.settle(d)
            held_events = [e["msg"] for e in w.store.batch_events(b["id"]) if "공통 수정 반영 보류" in e["msg"]]
            self.assertEqual(d["state"], "HELD")
            self.assertEqual(w.store.get(f"defect_reproof_head_{d['id']}"), HEAD1)

            self.assertEqual(self.settle(d)["state"], "HELD")
            again = [e["msg"] for e in w.store.batch_events(b["id"]) if "공통 수정 반영 보류" in e["msg"]]
        self.assertEqual(again, held_events)

    def test_an_unmodelled_run_kind_cannot_prove_prompt_delivery(self):
        b, d = self.merged([self.PROMPT], run_kind="d_finalize", session_id="ses_1")
        d = self.settle(d)
        self.assertEqual(d["state"], "HELD")
        self.assertIn("prompt 집합을 정할 수 없어", d["hold_reason"])

    def test_the_prompt_must_be_in_the_main_checkout_and_clean(self):
        w = self.w
        w.sup.prompt_checkout_clean = lambda paths: False
        b, d = self.merged([self.PROMPT], session_id="ses_1")
        d = self.settle(d)
        self.assertEqual((d["state"], w.store.batch(b["id"])["state"]), ("FIX_MERGED", "PAUSED"))   # waits, no restart needed
        w.sup.prompt_checkout_clean = lambda paths: True
        self.assertEqual(self.settle(d)["state"], "RELEASED")

    def test_changed_or_unobserved_state_holds(self):
        for label, arrange in (("head moved", lambda w, b: setattr(w.git, "local_head", "d" * 40)),
                               ("remote moved", lambda w, b: w.git.remote.__setitem__(b["branch"], "e" * 40)),
                               ("checkpoint changed", lambda w, b: (Path(b["worktree"]) / ".warroom-scratch").mkdir(parents=True, exist_ok=True)
                                or (Path(b["worktree"]) / ".warroom-scratch/c.json").write_text("{}")),
                               ("unknown observation", lambda w, b: self.make_unknown(b))):
            with self.subTest(label):
                self.tearDown()
                self.setUp()
                w = self.w
                b, d = self.merged([self.PROMPT], session_id="ses_1")
                arrange(w, b)
                d = self.settle(d)
                self.assertEqual(d["state"], "HELD", label)
                self.assertIn("재개 증명 불가", d["hold_reason"])
                self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")

    def make_unknown(self, b):
        w = self.w
        d, = incidents(w)
        text, _, facts = d["report"].partition("\n")
        env = json.loads(text)
        env["observed"]["git"] = {"status": "unknown", "value": "git down"}
        w.store.update_defect(d["id"], report=defects.canonical(env) + "\n" + facts)

    def test_waiting_review_resumes_on_an_open_owned_pr_and_holds_on_an_unmerged_close(self):
        for state, merged, want in (("open", False, "RELEASED"), ("closed", False, "HELD")):
            with self.subTest(state=state, merged=merged):
                self.tearDown()
                self.setUp()
                w = self.w
                branch = "d-deepseek-001-01"
                w.pr_info(70, HEAD1, state=state, merged=merged, head_ref=branch)
                b, d = self.merged([self.PY], run_kind=None, paused_from="WAITING_REVIEW", pr_number=70, head_sha=HEAD1)
                d = self.settle(d)
                self.assertEqual(d["state"], want)
                self.assertEqual(w.store.batch(b["id"])["state"], "WAITING_REVIEW" if want == "RELEASED" else "PAUSED")
                if want == "HELD":
                    self.assertIn("머지 없이 닫혀", d["hold_reason"])

    def test_a_prepare_error_without_a_worktree_resumes_on_a_runtime_fix_only(self):
        w = self.w
        b, d = self.merged([self.PY], run_kind=None, paused_from="PREPARE", state="PREPARE", worktree=False)
        d = self.settle(d)
        self.assertEqual((d["state"], d["fix_kind"], w.store.batch(b["id"])["state"]), ("RELEASED", "runtime", "PREPARE"))

    # ---- Worktree integration ---------------------------------------------------------------------------------------
    def d_baseline(self, b, head=HEAD1):
        wt = Path(b["worktree"])
        self.w.git.integrated.append((str(wt), head))
        self.w.store.set(f"d_base_head_{b['id']}", head)
        self.w.store.set(dchunk.run_start_key(b["id"]), json.dumps(
            {"branch": b["branch"], "worktree": str(wt), "head": head, "remote_head": None, "chunk_no": 1}, sort_keys=True))

    def worktree_fix(self, run_kind, parallel=False):
        w = self.w
        b = make_batch(w, "d", run_kind=run_kind, session_id="ses_1")
        if parallel:
            w.store.set(dparallel.mode_key(b["id"]), dparallel.PARALLEL)
        self.d_baseline(b)
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="boom")
        w.git.changed[MERGE] = ["scripts/relation/d-chunk-cli.mjs"]
        w.tick(2)
        d, = incidents(w)
        return self.merge_fix(b, d)

    def test_serial_d_integration_moves_only_the_run_baseline_and_the_resume_guard_passes(self):
        w = self.w
        b, d = self.worktree_fix("d_chunk_resume")
        d = self.settle(d)
        row = w.store.batch(b["id"])
        self.assertEqual((d["state"], d["fix_kind"], d["integrated_sha"]), ("RELEASED", "worktree", MERGE))
        self.assertEqual(row["state"], "PRODUCING")
        self.assertEqual(w.store.get(f"d_base_head_{b['id']}"), HEAD1)                         # the first HEAD never moves
        self.assertEqual(json.loads(w.store.get(dchunk.run_start_key(b["id"])))["head"], MERGE)
        self.assertIsNone(w.sup._d_head_problem(row, Path(row["worktree"])))                   # the real guard, now by receipt

    def test_parallel_d_integration_keeps_the_first_head_and_passes_both_guards(self):
        w = self.w
        b, d = self.worktree_fix("d_parallel", parallel=True)
        d = self.settle(d)
        row = w.store.batch(b["id"])
        self.assertEqual((d["state"], d["integrated_sha"]), ("RELEASED", MERGE))
        self.assertEqual(w.store.get(f"d_base_head_{b['id']}"), HEAD1)
        self.assertIsNone(w.sup._d_head_problem(row, Path(row["worktree"])))

    def test_serial_c_keeps_the_checkpoint_head_and_resumes_on_the_run_baseline(self):
        w = self.w
        b = make_batch(w, "c", run_kind="c_chunk_new", session_id="ses_1")
        wt = Path(b["worktree"])
        cp = wt / literary.names(b).checkpoint
        cp.parent.mkdir(parents=True, exist_ok=True)
        cp.write_text(json.dumps({"batch": {"git_head": HEAD1}}))
        w.git.integrated.append((str(wt), HEAD1))
        w.store.set(literary.run_start_key(b["id"]), json.dumps(
            {"branch": b["branch"], "worktree": str(wt), "head": HEAD1, "remote_head": None, "chunk_no": 1}, sort_keys=True))
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="boom")
        w.git.changed[MERGE] = ["scripts/relation/c-chunk-cli.mjs"]
        w.tick(2)
        d, = incidents(w)
        b, d = self.merge_fix(b, d)
        d = self.settle(d)
        row = w.store.batch(b["id"])
        self.assertEqual((d["state"], d["integrated_sha"], row["state"]), ("RELEASED", MERGE, "PRODUCING"))
        self.assertEqual(literary.checkpoint_head(wt, row), HEAD1)                                   # never rewritten
        self.assertEqual(json.loads(w.store.get(literary.run_start_key(b["id"])))["head"], MERGE)
        self.assertIsNone(w.sup._c_head_problem(row, wt))                                            # the real guard, by receipt

    def test_stage2_links_use_their_own_baseline_key(self):
        w = self.w
        b = make_batch(w, "s2", run_kind="s2_links_new", shard="001", batch="01-01", session_id="ses_1")
        wt = Path(b["worktree"])
        cp = wt / ".warroom-scratch" / "relation-admission-001-01-01.json"
        cp.parent.mkdir(parents=True, exist_ok=True)
        cp.write_text("{}")
        base = {"branch": b["branch"], "worktree": str(wt), "head": HEAD1, "remote_head": None,
                "checkpoint_sha256": hashlib.sha256(b"{}").hexdigest(), "digest": "a" * 64}
        w.git.integrated.append((str(wt), HEAD1))
        w.store.set(stage2.links_start_key(b["id"]), json.dumps(base, sort_keys=True))
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="boom")
        w.git.changed[MERGE] = ["scripts/relation/admission-cli.mjs"]
        w.tick(2)
        d, = incidents(w)
        b, d = self.merge_fix(b, d)
        d = self.settle(d)
        row = w.store.batch(b["id"])
        self.assertEqual((d["state"], d["integrated_sha"], row["state"]), ("RELEASED", MERGE, "PRODUCING"))
        self.assertEqual(json.loads(w.store.get(stage2.links_start_key(b["id"])))["head"], MERGE)
        self.assertIsNone(w.store.get(stage2.run_start_key(b["id"])))                                # no other step's key invented
        self.assertIsNone(w.sup._stage2_links_boundary_problem(row))

    def test_a_failed_pre_run_guard_holds_and_leaves_the_first_head_and_chunks_alone(self):
        w = self.w
        b, d = self.worktree_fix("d_chunk_resume")
        real = w.sup._stage2_chunk_boundary_problem
        w.sup._stage2_chunk_boundary_problem = lambda *a, **k: "청크 경계 거부(테스트)"
        d = self.settle(d)
        self.assertEqual((d["state"], w.store.batch(b["id"])["state"]), ("HELD", "PAUSED"))
        self.assertIn("재개 guard 사전 검증 실패", d["hold_reason"])
        self.assertEqual(w.store.get(f"d_base_head_{b['id']}"), HEAD1)
        self.assertEqual(json.loads(w.store.get(dchunk.run_start_key(b["id"])))["head"], HEAD1)   # nothing was stored
        w.sup._stage2_chunk_boundary_problem = real

    def test_a_run_kind_without_a_pre_runnable_guard_is_held_before_any_integration(self):
        w = self.w
        b = make_batch(w, "s3", "deepseek", "004", "00", "s3_finalize")
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="boom")
        w.git.changed[MERGE] = ["scripts/relation/edit-cli.mjs"]
        w.tick(2)
        d, = incidents(w)
        self.merge_fix(b, d)
        d = self.settle(d)
        self.assertEqual(d["state"], "HELD")
        self.assertIn("사전에 실행해 증명할 수 없습니다", d["hold_reason"])
        self.assertEqual(w.git.integrated, [x for x in w.git.integrated if x[0] != b["worktree"]])   # no integration happened

    # ---- recurrence ---------------------------------------------------------------------------------------------------
    EVIDENCE = {"kind": "boundary", "site": "d-head", "base": HEAD1, "head": MERGE}

    def test_same_structured_evidence_after_the_fix_continues_on_the_same_issue_once(self):
        """#5245: the same evidence after a merged fix is not parked for the operator; the fixing Issue continues."""
        w = self.w
        b = make_batch(w, "d", run_kind="d_chunk_resume", session_id="ses_1")
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="boom")
        w.store.set(f"error_evidence_{b['id']}_1", json.dumps(self.EVIDENCE))
        w.git.changed[MERGE] = [self.PROMPT]
        w.tick(2)
        d, = incidents(w)
        self.merge_fix(b, d)
        d = self.settle(d)
        self.assertEqual(d["state"], "RELEASED")
        import time as _t
        _t.sleep(0.02)
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="a different wording")
        w.store.set(f"error_evidence_{b['id']}_2", json.dumps(self.EVIDENCE))
        for _ in range(3):
            w.sup.maint._intake_errors()
        w.sup.maint.step()
        w.sup.maint.step()
        self.assertEqual((len(incidents(w)), w.store.batch(b["id"])["state"], w.store.batch(b["id"])["error_seq"]),
                         (2, "PAUSED", 2))
        again = incidents(w)[-1]
        self.assertEqual((again["event_key"], again["state"], again["issue_number"]),
                         (f"incident:{b['id']}:e2", "LINKED", d["issue_number"]))   # same Issue, no new one
        superseded = w.store.defect(d["id"])   # its recovery was never verified: superseded, receipt kept as evidence
        self.assertEqual(superseded["state"], "OVERRIDDEN")
        self.assertIn(f"defect #{again['id']}", superseded["hold_reason"])
        receipt = json.loads(w.store.get(f"defect_recovery_{d['id']}"))
        self.assertEqual((receipt["status"], receipt["superseded_by"]), ("RECURRENCE", again["id"]))
        self.assertIn(w.store.maintenance(d["issue_number"])["state"], ("QUEUED", "ACTIVE"))
        bodies = [c["body"] for c in w.gh.issue_comments_.get(d["issue_number"], [])]
        self.assertEqual(sum(f"incident:{b['id']}:e2" in x for x in bodies), 1)
        w.sup.maint._intake_errors()   # the same event seen again creates nothing more
        self.assertEqual(len(incidents(w)), 2)
        # a different fingerprint, and one with no evidence at all, are new incidents that list the earlier one
        w.store.update(b["id"], state="PRODUCING", error=None)
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="elsewhere")
        w.store.set(f"error_evidence_{b['id']}_3", json.dumps({**self.EVIDENCE, "site": "d-parallel-head"}))
        w.sup.maint._intake_errors()
        newest = incidents(w)[-1]
        self.assertEqual(newest["event_key"], f"incident:{b['id']}:e3")
        env = defects.parse_incident(newest["report"].partition("\n")[0])
        self.assertEqual([p["defect_id"] for p in env["prior_incidents"]], [d["id"]])

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
        w.tmp.cleanup()

    def test_a_started_task_keeps_its_producer_across_maintainer_target_change_and_restart(self):
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

    def test_diagnosis_cleanup_never_force_deletes_an_unmerged_branch(self):
        from warroom.gitops import CleanupBlocked
        sh("git", "checkout", "-q", "-b", "side", cwd=self.repo)
        (self.repo / "side.txt").write_text("s\n")
        sh("git", "add", ".", cwd=self.repo)
        sh("git", "commit", "-qm", "side", cwd=self.repo)
        base = sh("git", "rev-parse", "HEAD", cwd=self.repo)
        sh("git", "checkout", "-q", "master", cwd=self.repo)
        wt = self.wt.parent / "diag"
        sh("git", "worktree", "add", "-q", "-b", "diag", str(wt), base, cwd=self.repo)
        for _ in range(2):   # the second pass is the re-entry after the worktree is already gone
            with self.assertRaises(CleanupBlocked):
                self.git.remove_diagnosis_worktree(wt, "diag", base)
        self.assertEqual(sh("git", "rev-parse", "--verify", "refs/heads/diag", cwd=self.repo), base)
        self.assertFalse(wt.exists())

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
        w.cfg["shared_defect_verify"] = [["true"]]      # the fix is code (validator.mjs): a runnable verification is required
        w.git = self.git
        w.sup = w.make_sup()
        wt = str(self.wt)
        bid = w.store.create_batch(method="a", producer="deepseek", shard="001", batch="01", branch="a-x-001-01", worktree=wt)
        w.store.update(bid, state="PRODUCING", session_id="ses_1")
        w.store.add_run(bid, "produce_new", "ses_1", None, "old.log", "old.exit",
                        model="p/free-x-free", effort="high")
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
