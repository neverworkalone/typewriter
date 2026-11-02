"""Issue #2812: an owned PR that is already merged recovers via MERGED->CLEANUP; open-PR gates never apply to it."""
import unittest

from tests.fakes import HEAD2
from tests.test_issue_1684 import S2
from tests.test_issue_1908 import s2_world, write_state
from warroom import control
from warroom.github import GhTransient


class MergedStage2Recovery(unittest.TestCase):
    def drive_to_lost_pr(self):
        """Both chunks saved and finalized, but the PR-create response is lost so no PR number is known."""
        w = s2_world(self)
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.adapter.plan.extend([
            {"code": 0, "session": "ses_1", "effect": lambda: write_state(
                w.store.active_batch("claude", S2), decided=1, total=2, next_chunk=2)},
            {"code": 0, "session": "ses_2", "effect": lambda: write_state(
                w.store.active_batch("claude", S2), decided=2, total=2, next_chunk=3)},
        ])
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick(2)
        w.gh.create_pr_error = GhTransient("HTTP 404")
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        return w, w.store.active_batch("claude", S2)

    def external_pr(self, w, b, *, state, merged, head_ref=None, remote=False, files=None):
        branch = b["branch"]
        w.gh.create_pr_error = None
        w.gh.prs[2809] = {"number": 2809, "state": state, "merged": merged, "head_sha": w.git.local_head,
                          "head_ref": head_ref or branch, "url": "", "merge_commit_sha": "m" * 40}
        w.gh.by_branch[branch] = [{"number": 2809, "state": state.upper(), "headRefOid": w.git.local_head}]
        w.gh.files[2809] = files or [{"path": f"data/relations/relation-{b['shard']}.jsonl"},
                                     {"path": f"data/relation-drops/drop-{b['shard']}.jsonl"}]
        if remote:
            w.git.remote[branch] = w.git.local_head
        else:
            w.git.remote.pop(branch, None)   # the merge deleted the remote head branch

    def settle(self, w, b, ticks=4):
        w.tick(ticks)
        return w.store.batch(b["id"])   # COMPLETE starts the next Part, so follow this batch by id

    def test_merged_pr_recovers_with_or_without_remote_branch(self):
        for remote in (False, True):
            for retry in (False, True):
                with self.subTest(remote=remote, retry=retry):
                    w, b = self.drive_to_lost_pr()
                    w.git.verified.add(("part", b["shard"], "01", "01"))   # master verify of the merged Part succeeds
                    self.external_pr(w, b, state="closed", merged=True, remote=remote)
                    if retry:
                        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="lost")
                        control.retry(w.store, "claude", S2)
                    runs, created = len(w.store.runs(b["id"])), len(w.gh.created_prs)
                    row = self.settle(w, b)
                    self.assertEqual(row["state"], "COMPLETE", row["error"])
                    self.assertEqual(row["pr_number"], 2809)
                    self.assertEqual((len(w.store.runs(b["id"])), len(w.gh.created_prs)), (runs, created))

    def test_open_pr_with_remote_head_mismatch_still_blocks(self):
        w, b = self.drive_to_lost_pr()
        self.external_pr(w, b, state="open", merged=False, remote=True)
        w.git.remote[b["branch"]] = HEAD2
        row = self.settle(w, b)
        self.assertEqual(row["state"], "ERROR")
        self.assertEqual(row["state"], "ERROR")

    def test_unowned_or_unmerged_closed_pr_is_never_taken_as_merged(self):
        cases = [
            ("closed unmerged", dict(state="closed", merged=False)),
            ("other branch", dict(state="closed", merged=True, head_ref="s2-claude-009-09-09")),
            ("other files", dict(state="closed", merged=True, files=[{"path": "data/relations/relation-009.jsonl"}])),
        ]
        for name, kw in cases:
            with self.subTest(name):
                w, b = self.drive_to_lost_pr()
                self.external_pr(w, b, **kw)
                row = self.settle(w, b)
                self.assertNotIn(row["state"], ("MERGED", "CLEANUP", "COMPLETE"))


if __name__ == "__main__":
    unittest.main()
