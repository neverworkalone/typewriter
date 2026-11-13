"""Issue #5987: a verified C/D fix whose own push was rejected leaves an owned commit; the Supervisor pushes it."""
import unittest
from unittest.mock import patch

import tests.test_issue_2165 as _t


class UnpushedVerifiedFix(unittest.TestCase):
    start_optional_part = _t.Stage2Finalization.start_optional_part

    def _world(self, method):
        w, b = self.start_optional_part()
        head, local = "a" * 40, "b" * 40
        w.store.update(b["id"], state="FIXING", run_kind="fix_resume", pr_number=7, method=method, pid=None)
        b = w.store.batch(b["id"])
        w.pr_info(7, head, head_ref=b["branch"])
        w.git.local_head, w.git.remote[b["branch"]] = local, head
        w.git.ancestor_pairs.add((head, local))
        return w, b, w.gh.pull(7), head, local

    def test_supervisor_pushes_verified_owned_fix_without_force(self):
        for method in ("c", "d"):
            w, b, info, head, local = self._world(method)
            with patch.object(w.sup, "_completed_fix_run", return_value=True):
                self.assertEqual(w.sup._check_fix_head(b, info), "wait")
            self.assertEqual(w.git.owned_fix_pushes, [(b["branch"], head, local)])

    def test_unverified_or_diverged_fix_is_not_pushed(self):
        w, b, info, head, local = self._world("d")
        with patch.object(w.sup, "_completed_fix_run", return_value=False):
            w.sup._check_fix_head(b, info)
        self.assertFalse(getattr(w.git, "owned_fix_pushes", []))
        w.git.ancestor_pairs.clear()
        with patch.object(w.sup, "_completed_fix_run", return_value=True):
            w.sup._check_fix_head(b, info)
        self.assertFalse(getattr(w.git, "owned_fix_pushes", []))

    def test_push_does_not_need_review_replies_that_follow_the_head_check(self):
        w, b, info, head, local = self._world("d")
        with patch.object(w.sup, "_completed_fix_run", return_value=True), \
                patch.object(w.sup, "_verified_fix_exit", return_value=False):
            self.assertEqual(w.sup._check_fix_head(b, info), "wait")
        self.assertEqual(w.git.owned_fix_pushes, [(b["branch"], head, local)])

    def test_completed_fix_unpushed_detection(self):
        w, b, info, head, local = self._world("d")
        with patch.object(w.sup, "_completed_fix_run", return_value=True):
            self.assertTrue(w.sup._completed_fix_unpushed(b))
            w.git.ancestor_pairs.clear()
            self.assertFalse(w.sup._completed_fix_unpushed(b))
        with patch.object(w.sup, "_completed_fix_run", return_value=False):
            w.git.ancestor_pairs.add((head, local))
            self.assertFalse(w.sup._completed_fix_unpushed(b))

    def test_rejected_push_preserves_worktree_as_error(self):
        w, b, info, head, local = self._world("d")
        w.git.push_error = "rejected"
        with patch.object(w.sup, "_completed_fix_run", return_value=True):
            self.assertEqual(w.sup._check_fix_head(b, info), "stop")
        self.assertEqual(w.store.batch(b["id"])["state"], "ERROR")

if __name__ == "__main__":
    unittest.main()
