"""Supervisor process guards shared by every Line: the single-instance lock and the Start-time account check.

The Stage 2/3 and Maintainer lifecycles (production, review fixes, Update-branch sync, merge and cleanup) are covered
by their own suites; the Stage 1 producer lifecycle that used to live here was removed with Stage 1 (#9933)."""
import unittest

from tests.test_issue_1684 import s2_world
from warroom.supervisor import acquire_lock


def review(i, head, body="-1", user="genonfire"):
    return {"id": i, "user": {"login": user}, "body": f"{body}\nHEAD: {head}\nfix it",
            "commit_id": head, "submitted_at": "2026-10-21T10:00:00Z"}


class Operations(unittest.TestCase):
    def test_blocked_on_wrong_account(self):
        w = s2_world(self)
        w.runner.account = "genonfire"
        w.start("single", "codex", "s2")
        w.tick()
        self.assertIsNone(w.store.active_batch("codex", "s2"))
        self.assertEqual(w.adapter.launches, [])
        self.assertIn("계정 불일치", w.store.line("codex", "s2")["blocked"])

    def test_single_instance_lock(self):
        w = s2_world(self)
        a = acquire_lock(w.paths.lock)
        self.assertIsNotNone(a)
        self.assertIsNone(acquire_lock(w.paths.lock))
        a.close()
        b = acquire_lock(w.paths.lock)
        self.assertIsNotNone(b)
        b.close()


if __name__ == "__main__":
    unittest.main()
