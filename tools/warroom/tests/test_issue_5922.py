"""Issue #5922: a usage_limit failure records the stated reset time; a resume before it waits instead of failing again."""
import datetime
import json
import unittest
from pathlib import Path

from tests.test_issue_3076 import Helpers
from warroom import control
from warroom.adapters import classify_codex_failure, usage_limit_reset_at

LIMIT_LOG = json.dumps({"type": "turn.failed", "error": {
    "message": "You've hit your usage limit. Upgrade to Pro or try again at Nov 16th, 2026 11:41 PM."}})


class UsageLimitReset(unittest.TestCase):
    def test_parses_stated_reset(self):
        got = usage_limit_reset_at("x\n" + LIMIT_LOG)
        self.assertEqual(datetime.datetime.fromtimestamp(got), datetime.datetime(2026, 11, 16, 23, 41))
        self.assertEqual(datetime.datetime.fromtimestamp(usage_limit_reset_at("try again at Dec 1, 2026 12:05 AM")),
                         datetime.datetime(2026, 12, 1, 0, 5))
        self.assertIsNone(usage_limit_reset_at("session limit reached"))


class ResumeWaitsForReset(Helpers, unittest.TestCase):
    def test_resume_before_reset_does_not_launch_and_after_reset_does(self):
        from tests.test_issue_3076 import ParallelCWorld
        w = self.world(senses=12)
        w.adapter.plan.clear()
        w.adapter.plan.append({"code": 1, "session": "ses_lim", "text": LIMIT_LOG})
        w.start("single", "deepseek", "c")
        w.tick()
        w.sup._classify_run = lambda _p, log: classify_codex_failure(Path(log).read_text("utf-8"), [])
        self.finish(w, "001", save=False)
        w.tick()
        until = self.data(w, "001")["limit_until"]
        self.assertEqual(self.tasks(w)["001"]["state"], "FAILED")
        launches = len(w.adapter.launches)
        now = w.sup.clock()
        w.sup.clock = lambda: min(now, until - 3600)
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.adapter.plan.append({"code": 0, "session": "ses_lim"})
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), launches)           # still waiting: no doomed re-run
        self.assertEqual(self.data(w, "001")["retry_after"], until)
        w.sup.clock = lambda: until + 1
        w.tick(3)
        self.assertGreater(len(w.adapter.launches), launches)         # resumes once the limit has reset


if __name__ == "__main__":
    unittest.main()
