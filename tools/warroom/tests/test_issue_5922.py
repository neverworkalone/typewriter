"""Issue #5922: a usage_limit failure records the stated reset time. An automatic resume waits for it; an operator
Retry declares the limit reset (the owner reset the tokens) and relaunches at once (#3887)."""
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

    def test_opencode_free_limit_retry_after_ms_is_the_reset(self):
        # Issue #8413: the OpenCode free-limit 429 states its wait only as retryAfterMs; without it a resumed task relaunched at once.
        event = json.dumps({"type": "error", "timestamp": 1795061327894, "error": {
            "type": "provider.free-limit", "status": 429, "retryAfterMs": 71838000}})
        self.assertEqual(usage_limit_reset_at("noise\n" + event), (1795061327894 + 71838000) / 1000)
        for bad in ({"type": "text", "timestamp": 1, "error": {"status": 429, "retryAfterMs": 5}},
                    {"type": "error", "timestamp": 1, "error": {"status": 500, "retryAfterMs": 5}},
                    {"type": "error", "error": {"status": 429, "retryAfterMs": 5}}):
            self.assertIsNone(usage_limit_reset_at(json.dumps(bad)))


class OperatorRetryOverridesStatedReset(Helpers, unittest.TestCase):
    def test_operator_retry_before_the_stated_reset_relaunches_at_once(self):
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
        self.assertGreater(len(w.adapter.launches), launches)         # the owner's Retry does not wait for the stated reset
        self.assertNotIn("limit_until", self.data(w, "001"))


class UsageLimitPausesForOwnerRetry(Helpers, unittest.TestCase):
    """A usage_limit stop is PAUSED, not ERROR: no Maintainer incident (shared_defect) locks the owner's Retry."""

    def test_c_parallel_usage_limit_pauses_without_an_incident_and_retry_stays_enabled(self):
        w = self.world(senses=12)
        w.adapter.plan.clear()
        w.adapter.plan.append({"code": 1, "session": "ses_lim", "text": LIMIT_LOG})
        w.start("single", "deepseek", "c")
        w.tick()
        w.sup._classify_run = lambda _p, log: classify_codex_failure(Path(log).read_text("utf-8"), [])
        self.finish(w, "001", save=False)
        w.tick(3)
        b = w.store.active_batch("deepseek", "c")
        self.assertEqual(b["state"], "PAUSED")
        self.assertNotEqual(b["pause_reason"], "shared_defect")
        self.assertEqual([d for d in w.store.defects() if d["batch_id"] == b["id"]], [])
        self.assertFalse(control.defect_locked(w.store, b))
        until = self.data(w, "001")["limit_until"]
        w.sup.clock = lambda: until + 1
        launches = len(w.adapter.launches)
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.adapter.plan.append({"code": 0, "session": "ses_lim"})
        w.tick(3)
        self.assertGreater(len(w.adapter.launches), launches)


if __name__ == "__main__":
    unittest.main()
