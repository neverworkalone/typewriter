"""Issue #2154: a completed Stage 2 Batch/Shard whose exact verify fails deterministically gets exactly one active block,
one urgent Issue and one Maintainer run, and is released only by a successful exact verify on the latest master.

Fake AI/GitHub/git (the real `verify --json` is covered by scripts/relation/admission-cli.test.mjs): this proves
classification, the state machine and `batch_id=0` isolation, not a real daemon run."""
import json
import unittest

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


class VerifyBlock(unittest.TestCase):
    def setUp(self):
        self.w = w = s2_world(self, canon={1: 100})
        w.cfg["maintainer"] = "claude"
        w.git.verified |= {("part", "001", "01", "01")}
        w.git.base_sha = SHA1
        w.git.outcomes[("batch", "001", "01")] = [failure()]
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)

    def tick(self, n=1):
        for _ in range(n):
            self.w.now += self.w.cfg["poll_seconds"] + 1
            self.w.tick()

    def block(self):
        return self.w.store.active_verify(CLS)

    def issue_count(self):
        return len(self.w.gh.created)

    def maint(self):
        return self.w.store.maintenance_rows()

    def fix_merged(self):
        """What Maintenance._track records once the Issue's PR is merged and cleaned up."""
        b = self.block()
        self.w.store.update_maintenance(b["issue_number"], state="DONE", merge_sha=MERGE)
        self.w.store.update_defect(b["id"], state="FIX_MERGED", merge_sha=MERGE)

    def test_deterministic_batch_failure_blocks_the_scope_with_one_issue_and_one_maintainer(self):
        w = self.w
        self.tick()
        self.assertEqual(w.git.verify_calls[1:], [("batch", "001", "01", None)] * 2)   # reproduced on the same SHA once
        b = self.block()
        self.assertEqual((b["state"], b["batch_id"], b["source"], b["last_sha"]), ("LINKED", 0, "verify", SHA1))
        self.assertEqual((self.issue_count(), [m["state"] for m in self.maint()]), (1, ["ACTIVE"]))
        issue = w.gh.issues[101]
        self.assertEqual(issue["labels"], ["urgent"])
        for needle in ("남정", "001_01", "accounting", "verify --shard 001 --batch 01 --json", SHA1, CLS):
            self.assertIn(needle, issue["body"])
        ln = w.store.peek_line("claude", S2)
        self.assertEqual((ln["run"], ln["blocked"]), (1, ""))   # the Line waits, it is not stopped
        self.assertEqual(w.store.incomplete_batches()[0]["method"], "m")   # only the Maintainer runs; no Stage 2 Part
        # repeated ticks, a restart and the same SHA: no re-verify, no second Issue, no second Maintainer
        calls = len(w.git.verify_calls)
        self.tick(3)
        w.sup = w.make_sup()
        self.tick(2)
        self.assertEqual((len(w.git.verify_calls), self.issue_count(), len(self.maint())), (calls, 1, 1))
        self.assertIn("#101", w.store.get("s2_wait_claude"))

    def test_shard_failure_is_its_own_scope(self):
        w = self.w
        w.git.verified.add(("batch", "001", "01", None))
        w.git.outcomes.clear()
        w.git.outcomes[("shard", "001", None)] = [failure(["shard-level duplicate"], "rows")]
        self.tick()
        b = w.store.active_verify("stage2-verify-shard-001")
        self.assertEqual((b["state"], self.issue_count()), ("LINKED", 1))
        self.assertIn("Shard 001", w.gh.issues[101]["title"])
        self.assertIsNone(self.block())

    def test_unclassified_or_unreproducible_failures_create_nothing_and_stop_for_the_operator(self):
        w = self.w
        w.git.outcomes[("batch", "001", "01")] = [VerifyOutcome(False, "node: command not found")]
        self.tick()
        self.assertEqual((self.issue_count(), self.block(), w.store.peek_line("claude", S2)["run"]), (0, None, 0))
        self.assertIn("분류되지 않음", w.store.peek_line("claude", S2)["blocked"])
        w.store.set_line("claude", S2, blocked="")
        w.git.outcomes[("batch", "001", "01")] = [failure(["a"]), failure(["b"])]   # a different cause on the 2nd run
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        self.tick()
        self.assertEqual((self.issue_count(), self.block()), (0, None))
        self.assertIn("재현되지 않음", w.store.peek_line("claude", S2)["blocked"])
        w.store.set_line("claude", S2, blocked="")
        w.git.outcomes[("batch", "001", "01")] = [failure(), VerifyOutcome(True, "")]   # flaky: passes the 2nd time
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        self.tick()
        self.assertEqual((self.issue_count(), self.block()), (0, None))

    def test_transient_git_error_keeps_backoff_and_creates_nothing(self):
        w = self.w
        w.git.verify_error = GitTransient("network")
        self.tick()
        self.assertEqual((self.issue_count(), self.block(), w.store.peek_line("claude", S2)["blocked"]), (0, None, ""))

    def test_fix_merged_then_exact_verify_success_releases_and_caches_in_one_step(self):
        w = self.w
        self.tick()
        self.fix_merged()
        w.git.base_sha = SHA2
        w.git.outcomes[("batch", "001", "01")] = [VerifyOutcome(True, "")]
        w.git.verified.add(("shard", "001", None, None))
        w.git.verify_calls.clear()
        self.tick()
        self.assertEqual(w.store.defects()[0]["state"], "RELEASED")
        self.assertEqual(w.store.defects()[0]["integrated_sha"], SHA2)
        self.assertEqual(w.store.get(stage2.ok_key("001", "01")), SHA2)
        self.assertEqual(w.git.verify_calls[0], ("batch", "001", "01", None))
        self.assertEqual(w.store.get("s2_wait_claude"), "")
        self.assertIsNone(self.block())

    def test_fix_merged_but_still_failing_holds_without_a_new_issue_or_maintainer(self):
        for fresh_cause in (False, True):   # the same fingerprint and a different one both hold
            with self.subTest(fresh_cause=fresh_cause):
                self.setUp()
                w = self.w
                self.tick()
                self.fix_merged()
                w.git.base_sha = SHA2
                w.git.outcomes[("batch", "001", "01")] = [failure(["other"] if fresh_cause else ERRORS)]
                self.tick()
                b = self.block()
                self.assertEqual(b["state"], "HELD")
                self.assertIn(stage2.fingerprint("batch", "001", "01", "accounting", ["other"] if fresh_cause else ERRORS), b["hold_reason"])
                self.assertEqual((self.issue_count(), len(self.maint()), b["last_sha"]), (1, 1, SHA2))
                self.assertIn("보류", control.urgent_items(w.store, w.cfg)[0][0])

    def test_held_waits_on_the_same_sha_and_rechecks_exactly_on_a_new_one(self):
        w = self.w
        self.tick()
        self.fix_merged()
        w.git.base_sha = SHA2
        w.git.outcomes[("batch", "001", "01")] = [failure(["other"])]
        self.tick()
        calls = len(w.git.verify_calls)
        self.tick(2)
        self.assertEqual(len(w.git.verify_calls), calls)   # same SHA: no re-verify
        w.git.base_sha = SHA3
        w.git.outcomes[("batch", "001", "01")] = [failure(["third"])]
        self.tick()
        b = self.block()
        self.assertEqual((b["state"], b["last_sha"], self.issue_count(), len(self.maint())), ("HELD", SHA3, 1, 1))
        self.assertEqual(json.loads(b["report"])["sha"], SHA3)
        w.git.base_sha = "4" * 40
        w.git.outcomes[("batch", "001", "01")] = [VerifyOutcome(True, "")]
        w.git.verified.add(("shard", "001", None, None))
        self.tick()
        self.assertEqual((self.block(), w.store.defects()[0]["state"]), (None, "RELEASED"))

    def test_a_new_fingerprint_before_the_fix_is_evidence_on_the_same_issue(self):
        w = self.w
        self.tick()
        w.git.base_sha = SHA2
        w.git.outcomes[("batch", "001", "01")] = [failure(["a different error"])]
        self.tick(2)
        b = self.block()
        self.assertEqual((self.issue_count(), len(self.maint()), len(w.store.defects())), (1, 1, 1))
        report = defects.parse_verify(b["report"])
        self.assertEqual(len(report["extra"]), 1)
        comments = w.gh.issue_comments_[101]
        self.assertEqual(len(comments), 1)
        self.assertIn("a different error", comments[0]["body"])
        self.assertTrue(report["extra"][0]["posted"])
        self.tick(2)
        self.assertEqual(len(w.gh.issue_comments_[101]), 1)   # posted once, not on every poll

    def test_a_failure_after_release_is_a_new_event_and_still_one_active_block(self):
        w = self.w
        self.tick()
        self.fix_merged()
        w.git.base_sha = SHA2
        w.git.outcomes[("batch", "001", "01")] = [VerifyOutcome(True, "")]
        w.git.verified.add(("shard", "001", None, None))
        self.tick()
        self.assertIsNone(self.block())
        w.git.changed_paths = ["data/relations/relation-001.jsonl"]   # a later master changes what the scope reads
        w.git.verified.add(("shard", "001", None, None))
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.git.base_sha = SHA3
        w.git.outcomes[("batch", "001", "01")] = [failure()]
        self.tick()
        keys = [d["event_key"] for d in w.store.defects()]
        self.assertEqual(len(keys), 2)
        self.assertTrue(keys[1].startswith(keys[0] + ":after:"))
        self.assertEqual(sum(d["state"] not in ("RELEASED", "OVERRIDDEN") for d in w.store.defects()), 1)
        self.assertEqual(w.store.report_verify_failure("verify:batch:001:01:ffff", CLS, "{}"), None)   # second active block refused

    def test_a_cached_scope_success_carries_over_only_while_its_inputs_are_unchanged(self):
        w = self.w
        self.tick()
        self.fix_merged()
        w.git.base_sha = SHA2
        w.git.outcomes[("batch", "001", "01")] = [VerifyOutcome(True, "")]
        w.git.verified.add(("shard", "001", None, None))
        self.tick()
        self.assertEqual(w.store.get(stage2.ok_key("001", "01")), SHA2)
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        calls = len(w.git.verify_calls)
        w.git.base_sha = SHA3
        w.git.changed_paths = ["data/relations/relation-002.jsonl", "docs/x.md", "data/relation-candidates/0010/x.jsonl"]
        self.tick()
        self.assertEqual((len(w.git.verify_calls), w.store.get(stage2.ok_key("001", "01"))), (calls, SHA3))   # carried over
        for n, path in enumerate(("data/relation-drops/drop-001.jsonl", "scripts/relation/admission.mjs", "data/canonical/stdict-0001.jsonl",
                                  "data/relation-candidates/001/001_01_a_codex.jsonl")):
            with self.subTest(path=path):
                control.start(w.store, "claude", S2, "single", cfg=w.cfg)
                sha = f"{n + 4}" * 40
                w.git.base_sha, w.git.changed_paths = sha, [path]
                calls = len(w.git.verify_calls)
                self.tick()
                self.assertGreater(len(w.git.verify_calls), calls)   # verified again on the new master
                self.assertEqual(w.store.get(stage2.ok_key("001", "01")), sha)

    def test_batch_id_zero_never_reaches_production_batch_paths(self):
        w = self.w
        self.tick()
        self.fix_merged()
        before = w.store.defects()[0]["state"]
        w.sup.maint.step()   # _release must not OVERRIDE a verify block for "no longer existing batch 0"
        self.assertEqual((before, w.store.defects()[0]["state"]), ("FIX_MERGED", "FIX_MERGED"))
        self.assertEqual(w.sup.maint.resolved_note({"id": 0}), "")
        self.assertIn("urgent issue #101", control.urgent_line(w.store, w.cfg))

    def test_maintainer_unset_leaves_the_block_and_issue_only(self):
        w = self.w
        w.cfg["maintainer"] = None
        self.tick(2)
        self.assertEqual((self.issue_count(), [m["state"] for m in self.maint()], self.block()["state"]), (1, ["QUEUED"], "LINKED"))
        self.assertEqual(w.store.peek_line("claude", S2)["run"], 1)


class IssueMatching(unittest.TestCase):
    def setUp(self):
        self.w = w = s2_world(self, canon={1: 100})
        w.git.verified |= {("part", "001", "01", "01")}
        w.git.base_sha = SHA1
        w.git.outcomes[("batch", "001", "01")] = [failure()]
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)

    def tick(self, n=1):
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
