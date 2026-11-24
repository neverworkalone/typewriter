"""Issue #5922: a usage_limit failure records the stated reset time. An automatic resume waits for it; an operator
Retry declares the limit reset (the owner reset the tokens) and relaunches at once (#3887; Stage 2 tasks: test_issue_3047)."""
import datetime
import json
import unittest

from warroom.adapters import usage_limit_reset_at

LIMIT_LOG = json.dumps({"type": "turn.failed", "error": {
    "message": "You've hit your usage limit. Upgrade to Pro or try again at Nov 16th, 2026 11:41 PM."}})


class UsageLimitReset(unittest.TestCase):
    def test_parses_stated_reset(self):
        got = usage_limit_reset_at("x\n" + LIMIT_LOG)
        self.assertEqual(datetime.datetime.fromtimestamp(got), datetime.datetime(2026, 11, 16, 23, 41))
        self.assertEqual(datetime.datetime.fromtimestamp(usage_limit_reset_at("try again at Dec 1, 2026 12:05 AM")),
                         datetime.datetime(2026, 12, 1, 0, 5))
        self.assertIsNone(usage_limit_reset_at("session limit reached"))


if __name__ == "__main__":
    unittest.main()
