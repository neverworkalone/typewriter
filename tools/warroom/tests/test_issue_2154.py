"""Issue #2154: a completed Stage 2 Batch/Shard whose exact verify fails deterministically gets exactly one active block,
one urgent Issue and one Maintainer run, and is released only by a successful exact verify on the latest master.

Fake AI/GitHub/git (the real `verify --json` is covered by scripts/relation/admission-cli.test.mjs): this proves
classification, the state machine and `batch_id=0` isolation, not a real daemon run."""
import json
import unittest
import threading

from tests.fakes import World
from tests.test_issue_1684 import S2, s2_world
from warroom import control, defects, stage2
from warroom.gitops import Git, GitError, GitTransient, VerifyOutcome, parse_verify_failure
from warroom.shell import Result

SHA1, SHA2, SHA3 = "1" * 40, "2" * 40, "3" * 40
MERGE = "c" * 40
ERRORS = ["w2-s1: candidate '남정' has no relation, drop or existing approved relation", "w9-s1: reverse duplicate"]
CLS = "stage2-verify-batch-001-01"


def failure(errors=ERRORS, family="accounting"):
    return VerifyOutcome(False, "tail", {"family": family, "errors": list(errors), "total": len(errors)})


def line(**over):
    base = {"version": 1, "ok": False, "family": "accounting", "errors": ["a", "b"], "total": 2}
    return json.dumps({**base, **over})


class Classification(unittest.TestCase):
    def test_only_exit_2_with_a_fully_valid_json_line_is_classified(self):
        good = {"family": "accounting", "errors": ["a", "b"], "total": 2}
        cases = [
            (2, line(), good),
            (2, line(family="rows"), {**good, "family": "rows"}),
            (2, line() + "\n", good),
            (0, line(), None), (1, line(), None), (124, line(), None), (127, line(), None),
            (2, "", None), (2, "{broken", None), (2, "[]", None), (2, line(version=2), None), (2, line(ok=True), None),
            (2, line(family="checkpoint"), None), (2, line(total=3), None), (2, line(errors=[]), None),
            (2, line(errors=["a", 1], total=2), None), (2, line(errors=["a", " "], total=2), None),
            (2, line(total=2.0), None), (2, json.dumps({"version": 1, "ok": False, "family": "rows", "errors": ["a"]}), None),
            (2, line() + "\nextra", None),
        ]
        for code, out, expected in cases:
            self.assertEqual(parse_verify_failure(code, out), expected, (code, out))

    def test_outcome_runs_json_verify_on_the_exact_commit_and_keeps_git_errors(self):
        class R:
            def __init__(self, result): self.result, self.argv = result, None
            def run(self, argv, **kw): self.argv = argv; return self.result
        git = Git.__new__(Git)
        git.verify_lock = threading.Lock()
        git.env = {}
        git._verify_checkout = lambda sha: "/x"
        for result, ok, has_failure in ((Result(0, "valid"), True, False), (Result(2, line()), False, True),
                                        (Result(1, "", "boom"), False, False), (Result(124, "", ""), False, False),
                                        (Result(2, "{no"), False, False)):
            git.r = R(result)
            out = git.verify_stage2_outcome(SHA1, "batch", "001", "01", None)
            self.assertEqual((out.ok, out.failure is not None), (ok, has_failure), result)
            self.assertEqual(git.r.argv[-6:], ["verify", "--shard", "001", "--batch", "01", "--json"])
        for exc in (GitError("x"), GitTransient("y")):
            git._verify_checkout = lambda sha, exc=exc: (_ for _ in ()).throw(exc)
            with self.assertRaises(type(exc)):
                git.verify_stage2_outcome(SHA1, "shard", "001", None, None)
        with self.assertRaises(GitError):
            git.verify_stage2_outcome(SHA1, "batch", "001", None, None)

    def test_fingerprint_covers_the_complete_unordered_error_set_and_never_the_sha(self):
        f = lambda errors, family="accounting", batch="01": stage2.fingerprint("batch", "001", batch, family, errors)
        many = [f"e{i}" for i in range(40)]
        self.assertEqual(f(many), f(list(reversed(many))))
        self.assertNotEqual(f(many), f(many[:20]))   # the first 20 alone must not identify the cause
        self.assertNotEqual(f(many), f(many[:-1] + ["other"]))
        self.assertNotEqual(f(many), f(many, "rows"))
        self.assertNotEqual(f(many), f(many, batch="02"))


class ChangedBetween(unittest.TestCase):
    def test_a_verify_input_moved_out_of_its_directory_is_reported_under_its_original_path(self):
        import os
        import subprocess
        import tempfile
        from pathlib import Path
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        repo = Path(tmp.name) / "repo"
        sh = lambda *a: subprocess.run(a, cwd=repo, check=True, capture_output=True, text=True).stdout.strip()
        (repo / "data/relations").mkdir(parents=True)
        sh("git", "init", "-q", "-b", "master")
        (repo / "data/relations/relation-001.jsonl").write_text("".join(f'{{"row":{i}}}\n' for i in range(20)))
        sh("git", "add", "-A")
        sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a")
        old = sh("git", "rev-parse", "HEAD")
        (repo / "data/archive").mkdir()
        sh("git", "mv", "data/relations/relation-001.jsonl", "data/archive/relation-001.jsonl")   # a pure rename
        sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "b")
        new = sh("git", "rev-parse", "HEAD")
        paths = Git(Shell_runner(), repo, dict(os.environ), Path(tmp.name) / "wt").changed_between(old, new)
        self.assertIn("data/relations/relation-001.jsonl", paths)
        self.assertTrue(stage2.scope_inputs_changed(paths, "001"))


def Shell_runner():
    from warroom.shell import Runner
    return Runner()


class VerifyBlock(unittest.TestCase):
    def test_existing_verify_failure_reporting_remains_idempotent(self):
        w = s2_world(self)
        fingerprint = stage2.fingerprint("batch", "001", "01", "accounting", ERRORS)
        event = stage2.VerifyFailure("batch", "001", "01", SHA1, "verify --shard 001 --batch 01 --json",
                                     "accounting", tuple(ERRORS), fingerprint)
        w.sup.maint.report_verify(event)
        w.sup.maint.report_verify(event)
        self.assertEqual(len(w.store.defects()), 1)
        self.assertEqual(w.store.active_verify(CLS)["state"], "REPORTED")


class IssueMatching(unittest.TestCase):
    def setUp(self):
        self.w = w = s2_world(self, canon={1: 100})
        w.git.verified |= {("part", "001", "01", "01")}
        w.git.base_sha = SHA1
        self.reported = False

    def tick(self, n=1):
        if not self.reported:
            fingerprint = stage2.fingerprint("batch", "001", "01", "accounting", ERRORS)
            event = stage2.VerifyFailure("batch", "001", "01", SHA1, "verify --shard 001 --batch 01 --json",
                                         "accounting", tuple(ERRORS), fingerprint)
            self.w.sup.maint.report_verify(event)
            self.reported = True
        for _ in range(n):
            self.w.now += self.w.cfg["poll_seconds"] + 1
            self.w.tick()

    def manual(self, n, body, title="[urgent] 남정 역방향 중복", state="open"):
        self.w.gh.issues[n] = {"state": state, "labels": ["urgent"], "title": title, "body": body}

    def test_a_manual_urgent_issue_naming_scope_and_first_error_is_reused_once(self):
        w = self.w
        self.manual(2150, "001_01 verify 실패\n\n  w2-s1:   candidate '남정' has no relation, drop or existing approved relation\n")
        self.tick(2)
        self.assertEqual((w.gh.created, w.store.defects()[0]["issue_number"]), ([], 2150))
        self.assertEqual(w.store.maintenance(2150)["state"], "QUEUED")
        self.assertEqual(len(w.gh.issue_comments_[2150]), 1)   # the event marker comment, once
        self.tick(2)
        self.assertEqual(len(w.gh.issue_comments_[2150]), 1)

    def test_title_similarity_alone_or_a_missing_half_never_links(self):
        w = self.w
        self.manual(2150, "001_01 verify 실패", title="Stage 2 001_01 남정 verify")
        self.manual(2151, "w2-s1: candidate '남정' has no relation, drop or existing approved relation (shard 002_01)")
        self.manual(2152, "0001_01 / 1001_01 w2-s1: candidate '남정' has no relation, drop or existing approved relation")
        self.tick()
        self.assertEqual(len(w.gh.created), 1)   # none of the three manual Issues was linked: a new one was created
        self.assertNotIn(w.store.defects()[0]["issue_number"], (2150, 2151, 2152))

    def test_done_or_held_maintenance_issues_are_never_reused_for_new_work(self):
        w = self.w
        text = "001_01 w2-s1: candidate '남정' has no relation, drop or existing approved relation"
        for n, state in ((2150, "DONE"), (2151, "HELD")):
            self.manual(n, text)
            w.store.ensure_maintenance(n)
            w.store.update_maintenance(n, state=state)
        self.manual(2152, text, state="closed")
        self.tick()
        self.assertEqual(len(w.gh.created), 1)
        self.assertEqual({m["issue_number"]: m["state"] for m in w.store.maintenance_rows()}.get(2150), "DONE")

    def test_restart_after_issue_creation_reuses_the_issue_by_event_marker(self):
        w = self.w
        w.fail_link = True
        orig = w.store.link_defect
        w.store.link_defect = lambda *a: (_ for _ in ()).throw(RuntimeError("crash before the DB link"))
        self.tick()
        self.assertEqual((len(w.gh.created), w.store.defects()[0]["state"]), (1, "REPORTED"))
        w.store.link_defect = orig
        self.tick(2)
        self.assertEqual((len(w.gh.created), w.store.defects()[0]["state"], w.store.defects()[0]["issue_number"]), (1, "LINKED", 101))
        self.assertEqual([m["issue_number"] for m in w.store.maintenance_rows()], [101])

    def test_github_failures_preserve_the_block_and_retry(self):
        w = self.w
        w.gh.fail_create = True
        self.tick(2)
        self.assertEqual((w.store.defects()[0]["state"], w.gh.created), ("REPORTED", []))
        w.gh.fail_create = False
        w.gh.fail_list = True
        self.tick()
        self.assertEqual(w.store.defects()[0]["state"], "REPORTED")
        w.gh.fail_list = False
        self.tick()
        self.assertEqual((w.store.defects()[0]["state"], len(w.gh.created)), ("LINKED", 1))

    def test_link_is_atomic_and_orphan_linked_defects_get_their_queue_row(self):
        w = self.w
        did = w.store.report_verify_failure("verify:batch:001:01:x", CLS, "{}")
        self.assertTrue(w.store.link_defect(did, 77))
        self.assertEqual((w.store.defects()[0]["state"], w.store.maintenance(77)["state"]), ("LINKED", "QUEUED"))
        self.assertFalse(w.store.link_defect(did, 78))   # not REPORTED any more: nothing changes
        self.assertIsNone(w.store.maintenance(78))
        # an old LINKED defect without a queue row (crash between the two former writes) is repaired; ACTIVE is untouched
        with w.store._conn() as c:
            c.execute("DELETE FROM maintenance")
        w.store.ensure_maintenance(5)
        w.store.update_maintenance(5, state="ACTIVE")
        w.store.update_defect(did, issue_number=5)
        w.sup.maint.step()
        self.assertEqual(w.store.maintenance(5)["state"], "ACTIVE")
        w.store.update_defect(did, issue_number=6)
        w.sup.maint.step()
        self.assertEqual(w.store.maintenance(6)["state"], "QUEUED")

    def test_a_broken_stored_report_is_held_without_an_issue(self):
        w = self.w
        w.store.report_verify_failure("verify:batch:001:01:bad", CLS, json.dumps({"version": 1}))
        w.sup.maint.step()
        d = w.store.defects()[0]
        self.assertEqual((d["state"], w.gh.created), ("HELD", []))


if __name__ == "__main__":
    unittest.main()
