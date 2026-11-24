"""#1515: a fix pushed to origin while the PR API `head.sha` still lags is a wait, never a false 'unpushed' ERROR.

The fix under test is the hidden Maintainer's review fix of its own PR (the Stage 1 producer that used to carry these
cases left with #9933); the head-lag gate is the same one every review fix passes."""
import unittest

from tests.fakes import HEAD1, HEAD2
from tests.test_issue_1555 import maintainer_row, produce_and_report, world
from warroom.github import GhError, GhTransient
from warroom.gitops import GitError

BRANCH = "maint-101"
HEAD3 = "c" * 40


def World():
    return world()


class FixHeadLag(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.w.cfg["pr_head_lag_timeout_seconds"] = 100

    def tearDown(self):
        self.w.tmp.cleanup()

    def row(self, w):
        return maintainer_row(w)

    def to_finished_fix(self, pushed=HEAD2, remote=HEAD2, api=HEAD1, head_ref=BRANCH, w=None):
        """Review -1 on HEAD1 -> fix run ends with the local HEAD `pushed`; origin has `remote`; PR API shows `api`."""
        w = w or self.w
        produce_and_report(w)
        w.adapter.plan.append({"code": 0, "session": "ses_1",
                               "effect": lambda: (w.pr_info(7, HEAD1, head_ref=BRANCH),
                                                  w.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        self.assertEqual(self.row(w)["state"], "WAITING_REVIEW")
        w.gh.reviews_ = [{"id": 11, "user": {"login": "genonfire"}, "body": f"-1\nHEAD: {HEAD1}\nfix it",
                          "commit_id": HEAD1, "submitted_at": "2026-10-21T10:00:00Z"}]
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": lambda: setattr(w.git, "local_head", pushed)})
        w.git.remote[BRANCH] = remote
        w.pr_info(7, api, head_ref=BRANCH)
        w.tick()
        self.assertEqual(self.row(w)["state"], "FIXING")
        w.pr_info(7, api, head_ref=head_ref)   # what the PR API reports once the fix run has ended
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        return w

    def test_timeout_only_warns_while_origin_holds_the_local_head(self):
        w = self.to_finished_fix()
        n = len(w.adapter.launches)
        w.tick()
        w.now += 101
        w.tick()
        b = self.row(w)
        self.assertEqual((b["state"], b["error"]), ("FIXING", None))   # lag past the window is a warning, not a verdict
        self.assertEqual(w.git.removed, [])
        w.now += 400
        w.tick(2)
        self.assertEqual((self.row(w)["state"], len(w.adapter.launches)), ("FIXING", n))   # still no AI
        w.gh.add_pr_reply(7, "수정했습니다.\nWarRoom-Review-Event: review:11")   # the event completes with its reply (#5987)
        w.pr_info(7, HEAD2, head_ref=BRANCH)
        w.tick()
        self.assertEqual((self.row(w)["state"], self.row(w)["head_sha"]), ("WAITING_REVIEW", HEAD2))
        self.assertEqual(w.store.kv_prefix(f"tw_b{b['id']}:"), [])   # the warning counter left with the transition

    def test_gh_failure_while_waiting_is_a_wait_only_when_retryable(self):
        cases = [("transient", GhTransient("HTTP 502"), "FIXING"),
                 ("local", GhError("gh api: unknown flag"), "ERROR"), ("unknown", RuntimeError("boom"), "ERROR")]
        for name, exc, want in cases:
            with self.subTest(name):
                w = World()
                w.cfg["pr_head_lag_timeout_seconds"] = 100
                self.addCleanup(w.tmp.cleanup)
                self.to_finished_fix(w=w)
                w.tick()
                w.gh.pull = lambda n, e=exc: (_ for _ in ()).throw(e)
                w.tick()
                w.now += 101
                w.tick()
                self.assertEqual(self.row(w)["state"], want)
                if want == "ERROR":
                    self.assertEqual(w.git.removed, [])

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
                b = self.row(w)
                self.assertEqual(b["state"], "ERROR")
                self.assertEqual(w.git.removed, [])
                w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
