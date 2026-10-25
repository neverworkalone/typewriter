"""#1515: a fix pushed to origin while the PR API `head.sha` still lags is a wait, never a false 'unpushed' ERROR;
an errored batch whose PR was merged later recovers through the normal MERGED -> CLEANUP -> COMPLETE gates."""
import unittest

from tests.fakes import HEAD1, HEAD2, World
from warroom import control
from warroom.gitops import GitError

BRANCH = "a-deepseek-001-01"
HEAD3 = "c" * 40


class FixHeadLag(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.w.cfg["pr_head_lag_timeout_seconds"] = 100

    def tearDown(self):
        self.w.tmp.cleanup()

    def to_finished_fix(self, pushed=HEAD2, remote=HEAD2, api=HEAD1, head_ref=BRANCH, w=None):
        """Review -1 on HEAD1 -> fix run ends with the local HEAD `pushed`; origin has `remote`; PR API shows `api`."""
        w = w or self.w
        w.start("single")
        w.adapter.plan.append({"code": 0, "session": "ses_1",
                               "effect": lambda: (w.pr_info(7, HEAD1, head_ref=BRANCH),
                                                  w.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")
        w.gh.reviews_ = [{"id": 11, "user": {"login": "genonfire"}, "body": f"-1\nHEAD: {HEAD1}\nfix it",
                          "commit_id": HEAD1, "submitted_at": "2026-10-21T10:00:00Z"}]
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": lambda: setattr(w.git, "local_head", pushed)})
        w.git.remote[BRANCH] = remote
        w.pr_info(7, api, head_ref=head_ref)
        w.tick()
        self.assertEqual(w.row()["state"], "FIXING")
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        return w

    def test_lagging_pr_api_waits_then_reviews(self):
        w = self.to_finished_fix()
        n = len(w.adapter.launches)
        w.tick()
        self.assertEqual((w.row()["state"], w.row()["error"]), ("FIXING", None))
        w.tick(3)                                   # still lagging: still waiting, the AI is never re-run
        self.assertEqual((w.row()["state"], len(w.adapter.launches)), ("FIXING", n))
        w.pr_info(7, HEAD2, head_ref=BRANCH)        # PR API caught up
        w.tick()
        self.assertEqual((w.row()["state"], w.row()["head_sha"]), ("WAITING_REVIEW", HEAD2))
        self.assertEqual(len(w.adapter.launches), n)

    def test_merge_during_lag_goes_to_cleanup_without_ai(self):
        w = self.to_finished_fix()
        n = len(w.adapter.launches)
        w.tick()
        w.pr_info(7, HEAD2, state="closed", merged=True, head_ref=BRANCH)
        w.tick(4)
        self.assertEqual(w.row()["state"], "COMPLETE")
        self.assertEqual(len(w.adapter.launches), n)

    def test_timeout_preserves_then_retry_reverifies_without_ai(self):
        w = self.to_finished_fix()
        n = len(w.adapter.launches)
        w.tick()
        w.now += 101
        w.tick()
        b = w.row()
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(w.git.removed, [])
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.tick()
        self.assertEqual((w.row()["state"], len(w.adapter.launches)), ("FIXING", n))   # re-verifying, no AI
        w.pr_info(7, HEAD2, head_ref=BRANCH)
        w.tick()
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")

    def test_gh_failure_while_waiting_times_out_closed(self):
        w = self.to_finished_fix()
        w.tick()
        w.gh.pull = lambda n: (_ for _ in ()).throw(RuntimeError("boom"))
        w.tick()
        self.assertEqual(w.row()["state"], "FIXING")
        w.now += 101
        w.tick()
        self.assertEqual(w.row()["state"], "ERROR")

    def test_real_problems_are_not_waits(self):
        cases = [  # name, kwargs, remote override, expected text
            ("not on origin", dict(remote=None), "실제 미push"),
            ("origin has another SHA", dict(remote=HEAD3), "불일치"),
            ("origin lookup fails", dict(remote=GitError("net")), "조회 실패"),
            ("wrong PR branch", dict(head_ref="other"), "잘못된 PR/브랜치"),
        ]
        for name, kw, text in cases:
            with self.subTest(name):
                w = World()
                self.to_finished_fix(w=w, **kw)
                w.tick()
                b = w.row()
                self.assertEqual(b["state"], "ERROR")
                self.assertEqual(w.git.removed, [])
                w.tmp.cleanup()


class MergedErrorRecovery(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.w.cfg["poll_seconds"] = 60

    def tearDown(self):
        self.w.tmp.cleanup()

    def errored(self):
        w = self.w
        w.start("continuous")
        w.adapter.plan.append({"code": 0, "session": "ses_1",
                               "effect": lambda: (w.pr_info(7, HEAD1, head_ref=BRANCH),
                                                  w.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        w.store.update(w.row()["id"], state="ERROR", paused_from="FIXING", error="x")
        return w

    def test_late_merge_recovers_with_gates(self):
        w = self.errored()
        n = len(w.adapter.launches)
        w.tick(2)
        self.assertEqual(w.row()["state"], "ERROR")          # open PR: other errors are never turned into success
        w.pr_info(7, HEAD1, state="closed", merged=True, head_ref=BRANCH)
        w.now += 61
        bid = w.row()["id"]
        w.tick(4)
        self.assertEqual(w.store.batch(bid)["state"], "COMPLETE")
        self.assertEqual(w.store.latest_batch("deepseek", "a")["id"] != bid, True)   # Continuous moves on
        self.assertEqual(w.adapter.launches[n - 1]["kind"], "start")
        self.assertEqual(len(w.adapter.launches), n + 1)   # only the next batch's produce run, no fix/re-run
        self.assertEqual(w.git.removed[0][1], BRANCH)

    def test_merged_but_unsafe_worktree_is_preserved(self):
        for name, setup in [("dirty", lambda g: setattr(g, "dirty_text", " M x")),
                            ("divergent", lambda g: setattr(g, "local_head", HEAD3))]:
            with self.subTest(name):
                self.w = World()
                self.w.cfg["poll_seconds"] = 60
                w = self.errored()
                setup(w.git)
                w.pr_info(7, HEAD1, state="closed", merged=True, head_ref=BRANCH)
                w.now += 61
                w.tick(3)
                b = w.store.latest_batch("deepseek", "a")
                self.assertEqual((b["state"], b["paused_from"]), ("ERROR", "CLEANUP"))
                self.assertEqual(w.git.removed, [])
                w.now += 61
                w.tick(3)   # a blocked cleanup is not retried automatically
                self.assertEqual(w.store.latest_batch("deepseek", "a")["state"], "ERROR")
                w.tmp.cleanup()

    def test_unmerged_closed_pr_never_completes(self):
        w = self.errored()
        w.pr_info(7, HEAD1, state="closed", merged=False, head_ref=BRANCH)
        w.now += 61
        w.tick(3)
        self.assertEqual(w.row()["state"], "ERROR")
        self.assertEqual(w.git.removed, [])


if __name__ == "__main__":
    unittest.main()
