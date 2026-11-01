"""Regression: Maintainer PR reviews use the Issue-scoped fix card, not Candidate producer_fix."""
from __future__ import annotations

import unittest

from tests.fakes import HEAD1
from tests.test_issue_1555 import maintainer_row, produce_and_report, world
from tests.test_supervisor import review
from warroom import prompts


class MaintainerFixPrompt(unittest.TestCase):
    def test_issue_scoped_prompt_renders_for_new_and_resumed_review(self):
        b = {
            "method": "m", "shard": "000", "batch": "2563", "branch": "maint-2563",
            "pr_number": 2564, "head_sha": HEAD1,
        }
        events = [{"kind": "review", "author": "genonfire", "key": "review:71",
                   "body": "-1\nHEAD: " + HEAD1 + "\nFix the common validator."}]
        for resumed in (False, True):
            with self.subTest(resumed=resumed):
                card = prompts.fix(b, events, resumed)
                for expected in ("Issue #2563", "PR #2564", "maint-2563", HEAD1,
                                 "review:71", "WarRoom-Review-Event: review:",
                                 "git status --short --branch", "공유 회귀 테스트"):
                    self.assertIn(expected, card)
                for producer_only in ("candidate-amend.mjs", "candidate-contract.mjs",
                                      "{{canonical}}", "{{output}}", "{{method_contract}}",
                                      "{{method_fix_scope}}"):
                    self.assertNotIn(producer_only, card)
                self.assertIn("새 Issue·PR 생성", card)
                self.assertIn("PASS", card)
                self.assertIn("기존 PR", card)


class MaintainerReviewLifecycle(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)
        produce_and_report(self.w)
        self.w.tick()  # PREPARE -> PRODUCING, original Maintainer Issue #101
        self.m = maintainer_row(self.w)
        self.assertEqual(self.m["state"], "PRODUCING")
        self.w.pr_info(50, HEAD1, head_ref="maint-101")
        self.w.gh.by_branch["maint-101"] = [
            {"number": 50, "state": "OPEN", "headRefOid": HEAD1}
        ]
        self.w.adapter.finish(self.w.adapter.launches[-1]["pid"])
        self.w.tick()
        self.assertEqual(maintainer_row(self.w)["state"], "WAITING_REVIEW")

    def test_blocking_review_starts_fix_instead_of_prompt_error(self):
        w = self.w
        w.gh.reviews_ = [review(11, HEAD1, "-1 fix the common regression")]
        w.adapter.plan.append({"code": 0, "session": "maint_fix"})
        w.tick()
        current = maintainer_row(w)
        self.assertEqual(current["state"], "FIXING", current["error"])
        launch = w.adapter.launches[-1]
        self.assertEqual(launch["kind"], "start")
        self.assertIn("Issue #101", launch["prompt"])
        self.assertIn("PR #50", launch["prompt"])
        self.assertIn("review:11", launch["prompt"])
        self.assertNotIn("candidate-contract.mjs", launch["prompt"])

    def test_pass_reviews_do_not_start_a_fix(self):
        w = self.w
        count = len(w.adapter.launches)
        w.gh.reviews_ = [review(11, HEAD1, "+1"), review(12, HEAD1, "+2")]
        w.tick()
        self.assertEqual(maintainer_row(w)["state"], "WAITING_REVIEW")
        self.assertEqual(len(w.adapter.launches), count)


if __name__ == "__main__":
    unittest.main()
