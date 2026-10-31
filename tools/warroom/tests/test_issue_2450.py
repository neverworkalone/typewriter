"""#2450 Phase 1: Stage 3 change evidence and source/target owner scoped Stage 2 reconciliation."""
import unittest
from pathlib import Path

from tests.fakes import World
from tests.test_issue_1684 import S2, s2_world
from warroom import control, stage2
from warroom.gitops import IntegrationBlocked


BASE, STAGE3, HEAD = "1" * 40, "2" * 40, "3" * 40
OTHER_HEAD, NEW_MASTER = "4" * 40, "5" * 40
RELATION = "data/relations/relation-001.jsonl"


class Stage3ChangePoint(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)

    def configure_pr(self, files=None, *, deleted=True):
        w = self.w
        w.git.changed_between_paths = [RELATION]
        w.git.ancestor_pairs = {(BASE, STAGE3), (STAGE3, HEAD), (BASE, HEAD)}
        w.git.commit_ranges = {(BASE, STAGE3, HEAD)}
        if deleted:
            w.git.deleted_id_relation_ranges.add((BASE, HEAD))
        w.git.changed[STAGE3] = [RELATION]
        w.gh.merged_stage3_prs = [{"number": 2451, "title": "[Relation Stage 3] 001", "base_ref": "master",
                                   "shard": "001", "merge_commit_sha": STAGE3}]
        w.gh.files[2451] = [{"path": path} for path in (files or [RELATION])]

    def test_only_exact_merged_stage3_pr_files_are_accepted_and_checked_once(self):
        self.configure_pr()
        worktree = Path(self.w.paths.repo_root)
        first = self.w.sup._stage3_commits_between(BASE, HEAD, worktree, HEAD)
        second = self.w.sup._stage3_commits_between(BASE, HEAD, worktree, HEAD)
        self.assertEqual((first, second), ([STAGE3], [STAGE3]))
        self.assertEqual(self.w.gh.merged_stage3_prs_calls, 1)
        self.assertEqual(self.w.gh.pull_files_calls, [2451])

    def test_completed_parts_on_the_same_master_share_one_pr_inventory(self):
        self.configure_pr()
        self.w.git.ancestor_pairs |= {(BASE, OTHER_HEAD), (STAGE3, OTHER_HEAD)}
        self.w.git.commit_ranges.add((BASE, STAGE3, OTHER_HEAD))
        self.w.git.deleted_id_relation_ranges.add((BASE, OTHER_HEAD))
        worktree = Path(self.w.paths.repo_root)
        first = self.w.sup._stage3_commits_between(BASE, HEAD, worktree, HEAD)
        second = self.w.sup._stage3_commits_between(BASE, OTHER_HEAD, worktree, HEAD)
        self.assertEqual((first, second), ([STAGE3], [STAGE3]))
        self.assertEqual(self.w.gh.merged_stage3_prs_calls, 1)
        self.assertEqual(self.w.gh.pull_files_calls, [2451])

    def test_a_new_master_sha_refreshes_the_pr_inventory(self):
        self.configure_pr()
        self.w.git.ancestor_pairs.add((NEW_MASTER, HEAD))
        worktree = Path(self.w.paths.repo_root)
        first = self.w.sup._stage3_commits_between(BASE, HEAD, worktree, HEAD)
        second = self.w.sup._stage3_commits_between(BASE, HEAD, worktree, NEW_MASTER)
        self.assertEqual((first, second), ([STAGE3], [STAGE3]))
        self.assertEqual(self.w.gh.merged_stage3_prs_calls, 2)
        self.assertEqual(self.w.gh.pull_files_calls, [2451])

    def test_relation_additions_across_new_master_shas_skip_pr_inventory(self):
        self.configure_pr(deleted=False)
        self.w.git.ancestor_pairs |= {(BASE, OTHER_HEAD), (OTHER_HEAD, NEW_MASTER)}
        worktree = Path(self.w.paths.repo_root)
        first = self.w.sup._stage3_commits_between(BASE, HEAD, worktree, HEAD)
        second = self.w.sup._stage3_commits_between(OTHER_HEAD, NEW_MASTER, worktree, NEW_MASTER)
        self.assertEqual((first, second), ([], []))
        self.assertEqual(self.w.gh.merged_stage3_prs_calls, 0)
        self.assertEqual(self.w.gh.pull_files_calls, [])

    def test_stage3_pr_file_list_must_match_its_declared_shard_and_merge_commit(self):
        self.configure_pr([RELATION, "README.md"])
        with self.assertRaises(IntegrationBlocked):
            self.w.sup._stage3_commits_between(BASE, HEAD, Path(self.w.paths.repo_root), HEAD)
        self.assertEqual(self.w.gh.pull_files_calls, [2451])


class CompletedPartReconcile(unittest.TestCase):
    def configure(self, w):
        old_sha, stage3_commit, latest = BASE, STAGE3, HEAD
        w.git.base_sha = latest
        w.git.relation_owner_shards = {"001"}
        w.git.changed_between_paths = [RELATION]
        w.git.ancestor_pairs = {(old_sha, stage3_commit), (stage3_commit, latest), (old_sha, latest)}
        w.git.commit_ranges = {(old_sha, stage3_commit, latest)}
        w.git.deleted_id_relation_ranges.add((old_sha, latest))
        w.git.changed[stage3_commit] = [RELATION]
        w.gh.merged_stage3_prs = [{"number": 2451, "title": "[Relation Stage 3] 001", "base_ref": "master",
                                   "shard": "001", "merge_commit_sha": stage3_commit}]
        w.gh.files[2451] = [{"path": RELATION}]
        return old_sha, stage3_commit, latest

    def test_proven_orphans_open_a_drop_only_reconciliation_pr_without_ai(self):
        w = s2_world(self, canon={1: 100})
        old_sha, stage3_commit, latest = self.configure(w)
        prior_id = w.store.create_batch(method=S2, producer="claude", shard="001", batch="01-01",
                                        branch="s2-claude-001-01-01", worktree="/old/stage2-part")
        w.store.update(prior_id, state="COMPLETE", merged=1, pr_number=2410, head_sha=old_sha)
        w.store.set(stage2.ok_key("001", "01", "01"), old_sha)
        w.git.reconcile_preview_added = 1
        w.git.reconcile_added = 1
        self.assertTrue(control.start(w.store, "claude", S2, "single", cfg=w.cfg)[0])
        w.tick()

        batch = w.store.active_batch("claude", S2)
        self.assertEqual(batch["id"], prior_id, "the unique Stage 2 Part identity is reused for reconciliation")
        self.assertEqual(batch["run_kind"], f"s2_reconcile|{latest}|{old_sha}|{stage3_commit}")
        self.assertEqual(batch["state"], "WAITING_REVIEW", batch["error"])
        self.assertTrue(any("이전 PR #2410" in event["msg"] for event in w.store.line_events_tail("claude", S2)))
        self.assertEqual(w.git.reconcile_preview_calls, [(latest, "001", (stage3_commit,), "01", "01")])
        self.assertEqual(w.git.reconcile_calls, [(batch["worktree"], "001", (stage3_commit,), "01", "01", False)])
        self.assertEqual(w.git.commits, [(["data/relation-drops/drop-001.jsonl"], "[Stage 2 Reconcile] 001_01 Part 01")])
        self.assertEqual(w.adapter.launches, [])
        self.assertEqual(w.gh.created_prs[0]["title"], "[Stage 2 Reconcile] 001_01 Part 01")
        self.assertEqual(w.gh.pull_files(100), [{"path": "data/relation-drops/drop-001.jsonl"}])

    def test_no_proven_orphan_drop_means_exact_verify_without_a_pr(self):
        w = s2_world(self, canon={1: 100})
        old_sha, _stage3_commit, latest = self.configure(w)
        w.store.set(stage2.ok_key("001", "01", "01"), old_sha)
        w.git.reconcile_preview_added = 0
        w.git.verified |= {("part", "001", "01", "01"), ("batch", "001", "01", None),
                           ("shard", "001", None, None)}
        self.assertTrue(control.start(w.store, "claude", S2, "single", cfg=w.cfg)[0])
        w.tick()

        self.assertEqual(w.store.incomplete_batches(), [])
        self.assertEqual(w.store.get(stage2.ok_key("001", "01", "01")), latest)
        self.assertEqual(w.git.verify_calls, [("part", "001", "01", "01"),
                                             ("batch", "001", "01", None), ("shard", "001", None, None)])
        self.assertEqual(w.gh.created_prs, [])
        self.assertEqual(w.adapter.launches, [])

    def test_reconcile_review_fix_uses_checkpoint_free_owner_path_and_retry_returns_to_review(self):
        w = s2_world(self, canon={1: 100})
        old_sha, stage3_commit, latest = self.configure(w)
        prior_id = w.store.create_batch(method=S2, producer="claude", shard="001", batch="01-01",
                                        branch="s2-claude-001-01-01", worktree="/old/stage2-part")
        w.store.update(prior_id, state="COMPLETE", merged=1, pr_number=2410, head_sha=old_sha)
        prior_run_id = w.store.add_run(prior_id, "s2_chunk_new", "ses_original", 123,
                                       "original.log", "original.exit")
        w.store.set(stage2.ok_key("001", "01", "01"), old_sha)
        w.git.reconcile_preview_added = 1
        w.git.reconcile_added = 1
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        batch = w.store.active_batch("claude", S2)
        self.assertEqual(batch["state"], "WAITING_REVIEW")
        self.assertIsNone(stage2.checkpoint(batch["worktree"], "001", batch["batch"]))
        original_head = batch["head_sha"]

        w.gh.reviews_ = [{"id": 2452, "state": "COMMENTED", "user": {"login": "genonfire"},
                          "body": f"-1\nHEAD: {original_head}\nplease correct the Drop",
                          "commit_id": original_head, "submitted_at": "2026-10-31T07:00:00Z"}]
        w.sup._watch(batch)
        paused = w.store.batch(batch["id"])
        self.assertEqual((paused["state"], paused["paused_from"]), ("PAUSED", "WAITING_REVIEW"))
        self.assertIn("오너가", paused["error"])
        self.assertNotIn("checkpoint가 없습니다", paused["error"])
        self.assertEqual(w.adapter.launches, [])
        self.assertEqual(w.store.runs(prior_id)[-1]["id"], prior_run_id,
                         "the earlier Stage 2 Part's run history remains intact")
        self.assertTrue(any("이전 PR #2410" in event["msg"]
                            for event in w.store.line_events_tail("claude", S2)))
        self.assertEqual(w.store.batch(batch["id"])["run_kind"], batch["run_kind"])

        owner_head = "9" * 40
        w.git.local_head = owner_head
        w.git.remote[batch["branch"]] = owner_head
        w.gh.prs[batch["pr_number"]]["head_sha"] = owner_head
        w.gh.reviews_.append({"id": 2453, "state": "COMMENTED", "user": {"login": "genonfire"},
                              "body": f"+2\nHEAD: {owner_head}\nfixed",
                              "commit_id": owner_head, "submitted_at": "2026-10-31T07:01:00Z"})
        w.store.set_line("claude", S2, retry_batch=batch["id"])
        w.sup._wait_operator(paused)
        self.assertEqual(w.store.batch(batch["id"])["state"], "WAITING_REVIEW")
        w.now += w.cfg["poll_seconds"] + 1
        w.sup._watch(w.store.batch(batch["id"]))
        current = w.store.batch(batch["id"])
        self.assertEqual((current["state"], current["head_sha"]), ("WAITING_REVIEW", owner_head))
        self.assertEqual(current["pr_number"], batch["pr_number"])
        self.assertEqual(w.adapter.launches, [])
        self.assertEqual(w.store.runs(prior_id)[-1]["id"], prior_run_id)

