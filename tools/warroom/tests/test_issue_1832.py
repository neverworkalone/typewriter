"""Issue #1832: a Claude run that succeeded (final success result, owned PR, Part verify) is not PAUSED merely because
its final `permission_denials` list is non-empty; every real block of required work still pauses.

Fake AI/GitHub/git: proves the Supervisor decision table, not a real Claude run or a real `admission-cli verify`."""
import unittest

from tests.fakes import HEAD1, FakeAdapter
from tests.test_claude_adapter import SESSION, init, result, stream
from tests.test_issue_1684 import S2, merge_part, s2_world, write_checkpoint
from warroom import control
from warroom.adapters import ClaudeCodeAdapter, ProcessAdapter

BRANCH = "s2-claude-001-01-01"
BASH = [{"tool_name": "Bash", "tool_input": {"command": "gh pr create --fill"}}]


class Reporting(FakeAdapter):
    run_problem = ClaudeCodeAdapter.run_problem
    completion_problem = ClaudeCodeAdapter.completion_problem
    denied_actions = ClaudeCodeAdapter.denied_actions
    requires_session_for_pr = ClaudeCodeAdapter.requires_session_for_pr
    requires_final_result_for_pr = ClaudeCodeAdapter.requires_final_result_for_pr
    session_id = ProcessAdapter.session_id


def final(denials=BASH, **kw):
    return stream(init("claude-x"), result(denials=denials, **kw))


class DeniedButCompleted(unittest.TestCase):
    def setUp(self):
        self.w = w = s2_world(self)
        w.adapter = Reporting()
        w.sup.adapter = w.adapter
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)

    def run_part(self, text, pr=True, verified=True, remote=HEAD1, dirty="", head_ref=BRANCH):
        w = self.w
        # Drive one independently saved chunk, then exercise PR handling in the separate finalizer run.
        w.adapter.plan.extend([{"code": 0, "text": stream(init("claude-x"), result())},
                               {"code": 0, "text": text}])
        w.tick()
        write_checkpoint(w, merged=False)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        if pr:
            # The simulated finalizer merge is reflected in the checkpoint before it opens its PR.
            write_checkpoint(w, merged=True)
            merge_part(w, "claude", "001", "01", "01")
            w.gh.prs[7]["head_ref"] = head_ref
        w.git.remote[BRANCH] = remote
        w.git.dirty_text = dirty
        if verified:
            w.git.verified.add(("part", "001", "01", "01"))
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        return w.store.active_batch("claude", S2)

    def test_success_with_a_denial_and_proven_work_reaches_review_without_rerun(self):
        b = self.run_part(final())
        self.assertEqual((b["state"], b["pr_number"]), ("WAITING_REVIEW", 7))
        self.assertEqual(len(self.w.adapter.launches), 2)
        self.assertEqual(self.w.git.verify_calls[0], ("part", "001", "01", "01"))

    def test_clean_success_is_unchanged(self):
        self.assertEqual(self.run_part(final(denials=()))["state"], "WAITING_REVIEW")

    def test_blocked_or_unproven_work_stays_paused(self):
        cases = [
            ("no PR", dict(pr=False)),
            ("Part verify fails", dict(verified=False)),
            ("PR HEAD not pushed", dict(remote="d" * 40)),
            ("uncommitted worktree", dict(dirty=" M data/x")),
            ("PR from another branch", dict(head_ref="other")),
            ("error result", dict(text=final(is_error=True))),
            ("no final result", dict(text=stream(init("claude-x")))),
        ]
        for name, kw in cases:
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                kw.setdefault("text", final())
                b = self.run_part(**kw)
                self.assertIn(b["state"], ("PAUSED", "ERROR"))
                self.assertIsNone(b["pr_number"])

    def test_retry_after_the_old_pause_adopts_the_pr_without_rerun(self):
        w = self.w
        w.git.verified.clear()
        b = self.run_part(final(), verified=False)       # the pre-fix outcome: denial + unproven -> PAUSED
        self.assertEqual(b["state"], "PAUSED")
        w.git.verified.add(("part", "001", "01", "01"))  # the operator's missing evidence now exists
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["state"], b["pr_number"]), ("WAITING_REVIEW", 7))
        self.assertEqual(len(w.adapter.launches), 2)      # no chunk or finalizer is duplicated

    def test_fixing_with_a_denial_is_never_cleared(self):
        # #1828: Part verify passes whether or not the review blocker was fixed, so even a really pushed new HEAD
        # (PR, worktree and origin all agree) is no proof that the denied edit was non-required: stay PAUSED.
        w = self.w
        b = self.run_part(final())
        new = "e" * 40
        for name, pushed in [("HEAD unchanged", False), ("new HEAD pushed", True)]:
            with self.subTest(name):
                if pushed:
                    w.gh.prs[7]["head_sha"] = new
                    w.git.local_head = new
                    w.git.remote[BRANCH] = new
                w.store.update(b["id"], state="FIXING", head_sha=HEAD1)
                self.assertIn("필수 편집", w.sup._denied_run_problem(w.store.batch(b["id"])))

    def test_retry_after_a_blocked_pr_creation_resumes_the_session(self):
        w = self.w
        b = self.run_part(final(), pr=False)                  # gh pr create was denied: success result, no PR
        self.assertEqual(b["state"], "PAUSED")
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 2)           # nothing restarts before the operator's Retry
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["state"], len(w.adapter.launches)), ("PRODUCING", 3))
        self.assertIn(w.adapter.launches[-1]["kind"], ("resume", "start"))
        self.assertEqual(b["branch"], BRANCH)

    def test_retry_with_an_unverified_existing_pr_never_relaunches(self):
        w = self.w
        b = self.run_part(final(), verified=False)
        self.assertEqual(b["state"], "PAUSED")
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 2)           # an existing PR is never duplicated by a new run
        self.assertIn(w.store.active_batch("claude", S2)["state"], ("PAUSED", "ERROR"))

    def test_retry_with_a_lost_exit_status_uses_the_log_and_pr_evidence(self):
        # Real #1828: the run's exit status was recorded as 'unknown' (lost exit file) although its log ends in success.
        for name, verified, want, status in [("verified", True, "WAITING_REVIEW", "unknown"),
                                             ("stopped by the old denial pause", True, "WAITING_REVIEW", "stopped"),
                                             ("verify fails", False, None, "unknown")]:
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                w = self.w
                b = self.run_part(final(), verified=False)
                with w.store._conn() as c:
                    c.execute("UPDATE runs SET exit_status=? WHERE batch_id=?", (status, b["id"]))
                if verified:
                    w.git.verified.add(("part", "001", "01", "01"))
                self.assertTrue(control.retry(w.store, "claude", S2))
                w.tick(2)
                state = w.store.active_batch("claude", S2)["state"]
                self.assertEqual(len(w.adapter.launches), 2)       # neither chunk nor finalizer is duplicated
                self.assertEqual(state, want) if want else self.assertIn(state, ("PAUSED", "ERROR"))

    def test_retry_of_a_fixing_denial_is_not_swallowed(self):
        w = self.w
        b = self.run_part(final())
        w.store.update(b["id"], state="FIXING")
        self.assertFalse(w.sup._retry_denied_success(w.store.batch(b["id"])))   # falls through to the fix relaunch
        w.store.update(b["id"], state="PRODUCING")
        self.assertTrue(w.sup._retry_denied_success(w.store.batch(b["id"])))    # a producing success is still adopted

    def test_non_stage2_denial_is_cleared_by_owned_pr_pushed_head_and_clean_worktree(self):
        # A/B/C/D have no Part verify: a denied stray command must not block a run whose owned PR, pushed HEAD and clean
        # worktree prove completion (real #1849, A 003_02); the same Retry never adopts anything less.
        for name, kw, ok in [("proven", {}, True),
                             ("uncommitted worktree", dict(dirty=" M data/x"), False),
                             ("local HEAD not on the PR", dict(local="d" * 40), False),
                             ("no PR", dict(pr=False), False)]:
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                w = self.w
                b = self.run_part(final(), verified=False)
                self.assertEqual(b["state"], "PAUSED")
                w.store.update(b["id"], method="a", batch="01", state="PRODUCING")   # as the operator Retry leaves it
                w.gh.files[7] = [{"path": "data/relation-candidates/001/001_01_a_claude.jsonl"}]
                if not kw.get("pr", True):
                    w.gh.by_branch[BRANCH] = []
                w.git.dirty_text = kw.get("dirty", "")
                if "local" in kw:
                    w.git.local_head = kw["local"]
                b = w.store.batch(b["id"])
                self.assertEqual(w.sup._denied_run_problem(b) is None, ok)
                self.assertEqual(w.sup._retry_denied_success(b), ok)
                self.assertEqual(w.store.batch(b["id"])["state"], "WAITING_REVIEW" if ok else "PRODUCING")
                self.assertEqual(len(w.adapter.launches), 2)

if __name__ == "__main__":
    unittest.main()
