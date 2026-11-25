"""Issue requests: a never-sent PENDING request creates without listing Issues, and the lost-response lookup of a
CREATING request is bounded by the request time instead of paging the whole repository (it outgrew the 60s timeout
and starved the Maintainer job, e.g. a merged Maintainer PR stuck in MERGED)."""
import re
import unittest

from tests.test_reload import stage2_world


class IssueRequestLookupBound(unittest.TestCase):
    def setUp(self):
        self.w = stage2_world()
        self.w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_pending_request_creates_without_listing_issues(self):
        w = self.w
        w.gh.all_issue_calls = []
        w.sup.maint.report_issue("목록", "C000123", event_key="pending:no-list")
        w.tick(2)
        self.assertEqual(w.gh.created, [101])
        self.assertEqual(w.store.issue_requests()[0]["issue_number"], 101)
        self.assertEqual(w.gh.all_issue_calls, [])

    def test_creating_request_lookup_is_bounded_by_request_time(self):
        w = self.w
        w.gh.fail_create_lost = True
        w.sup.maint.report_issue("목록", "C000123", event_key="creating:bounded")
        w.tick()
        self.assertEqual(w.store.issue_requests()[0]["state"], "CREATING")
        w.gh.all_issue_calls = []
        w.sup = w.make_sup()
        w.tick(2)
        self.assertEqual(w.gh.created, [101])
        self.assertEqual(w.store.issue_requests()[0]["issue_number"], 101)
        self.assertTrue(w.gh.all_issue_calls)
        for since in w.gh.all_issue_calls:
            self.assertRegex(since or "", r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_github_listing_passes_since(self):
        from warroom.github import GhClient as GitHub
        seen = []

        class R:
            def run(self, argv, env=None, timeout=None):
                seen.append(argv)
                return type("X", (), {"ok": True, "out": "[[]]", "err": ""})()

        gh = GitHub.__new__(GitHub)
        gh.runner, gh.env, gh.repo = R(), {}, "o/r"
        gh.all_issues(since="2026-11-25T00:00:00Z")
        gh.all_issues()
        self.assertIn("repos/o/r/issues?state=all&per_page=100&since=2026-11-25T00:00:00Z", seen[0])
        self.assertIn("repos/o/r/issues?state=all&per_page=100", seen[1])
        self.assertFalse(any("since=" in a for a in seen[1]))


if __name__ == "__main__":
    unittest.main()
