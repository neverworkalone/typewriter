"""Issue #1875: a proven partial worktree removal survives a Supervisor restart and resumes on Retry."""
from __future__ import annotations

import unittest
from pathlib import Path

from tests.fakes import HEAD1
from tests.test_issue_1555 import make_batch, world
from tests.test_issue_1908 import write_state
from warroom import control
from warroom.gitops import GitError


class Recovery(unittest.TestCase):
    def test_cleanup_proof_survives_supervisor_restart_and_retry(self):
        w = world(maintainer=None)
        self.addCleanup(w.tmp.cleanup)
        b = make_batch(w, state="MERGED", run_kind="s2_deterministic_finalize", pr_number=1870,
                       head_sha=HEAD1, merged=1)
        write_state(b, decided=2, total=2, merged=True)
        w.git.verified.add(("part", "001", "01", "01"))   # the merged Part re-verifies on latest master
        w.pr_info(1870, HEAD1, state="closed", merged=True, head_ref=b["branch"])
        w.gh.by_branch[b["branch"]] = [{"number": 1870, "state": "CLOSED", "headRefOid": HEAD1}]
        w.tick()  # MERGED -> CLEANUP

        original = w.git.remove_owned
        failed_once = {"value": False}

        def partial(path, branch, head, *, cleanup_proof=None, on_verified=None):
            if not failed_once["value"]:
                failed_once["value"] = True
                on_verified()
                w.git.reg.pop(str(path), None)  # admin entry gone; checkout remains
                raise GitError("git worktree remove: Operation not permitted")
            return original(path, branch, head, cleanup_proof=cleanup_proof, on_verified=on_verified)

        w.git.remove_owned = partial
        w.tick()
        row = w.store.batch(b["id"])
        self.assertEqual((row["state"], row["paused_from"]), ("ERROR", "CLEANUP"))
        self.assertTrue(w.store.get(f"cleanup_proof_{b['id']}"))

        w.sup = w.make_sup()  # same durable Store, a new Supervisor instance
        w.sup_runner_ok()
        self.assertTrue(control.retry(w.store, "codex", "s2", cfg=w.sup.cfg))
        w.tick()  # Retry restores CLEANUP; no producer launch
        w.tick()  # the saved proof lets cleanup resume

        self.assertEqual(w.store.batch(b["id"])["state"], "COMPLETE")
        self.assertFalse(Path(b["worktree"]).exists())
        self.assertIsNone(w.store.get(f"cleanup_proof_{b['id']}"))
        self.assertEqual(w.adapter.launches, [])


if __name__ == "__main__":
    unittest.main()
