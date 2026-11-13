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

    def test_retry_push_then_head_recheck_completes_events_before_review(self):
        # Retry -> Supervisor push -> head-lag wait -> PR HEAD reflects the push -> events completed, then review.
        w, b, info, head, local = self._world("d")
        w.store.update(b["id"], head_sha=head)
        with patch.object(w.sup, "_completed_fix_run", return_value=True), \
                patch.object(w.sup, "_fix_claim_status", return_value="CLAIMED"):
            self.assertEqual(w.sup._check_fix_head(b, info), "wait")
            self.assertEqual(w.git.owned_fix_pushes, [(b["branch"], head, local)])
            w.pr_info(7, local, head_ref=b["branch"])
            w.git.remote[b["branch"]] = local
            with patch.object(w.sup, "_complete_producer_fix_events", return_value=None) as done, \
                    patch.object(w.sup, "_to_review") as review:
                w.store.set(f"last_poll_fixhead_{b['id']}", "0")
                w.sup._recheck_fix_head(w.store.batch(b["id"]))
            done.assert_called_once()
            review.assert_called_once()
            self.assertEqual(len(w.git.owned_fix_pushes), 1)

    def test_recheck_with_incomplete_events_is_error_not_review(self):
        w, b, info, head, local = self._world("c")
        w.git.local_head = head
        w.store.set(f"last_poll_fixhead_{b['id']}", "0")
        with patch.object(w.sup, "_fix_claim_status", return_value="CLAIMED"), \
                patch.object(w.sup, "_complete_producer_fix_events", return_value="미완료"), \
                patch.object(w.sup, "_to_review") as review:
            w.sup._recheck_fix_head(w.store.batch(b["id"]))
        review.assert_not_called()
        self.assertEqual(w.store.batch(b["id"])["state"], "ERROR")

    def test_rejected_push_preserves_worktree_as_error(self):
        w, b, info, head, local = self._world("d")
        w.git.push_error = "rejected"
        with patch.object(w.sup, "_completed_fix_run", return_value=True):
            self.assertEqual(w.sup._check_fix_head(b, info), "stop")
        self.assertEqual(w.store.batch(b["id"])["state"], "ERROR")

if __name__ == "__main__":
    unittest.main()
