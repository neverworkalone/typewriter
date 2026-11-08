"""Stage 3 may refresh only the Stage 2 shard verify cache it needs (#2478)."""
import unittest
from unittest import mock

from tests.fakes import HEAD1, HEAD2, World
from warroom import stage2, stage3
from warroom.store import STAGE2_METHOD, STAGE3_METHOD

RELATION = "data/relations/relation-001.jsonl"


class Stage2ShardVerifyCache(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)

    def refresh(self, *, changed, owners=None, verify=None):
        return stage2.refresh_shard_success(
            "001", HEAD2, kv=self.w.store, changed=changed, relation_owners=owners,
            verify=verify or mock.Mock(return_value=(True, "")),
        )

    def test_old_success_carries_across_unrelated_change_without_exact_verify(self):
        self.w.store.set(stage2.ok_key("001", None), HEAD1)
        verify = mock.Mock(return_value=(True, ""))

        ready, detail = self.refresh(changed=lambda _old, _new: ["README.md"], verify=verify)

        self.assertTrue(ready)
        self.assertEqual(detail, "")
        self.assertEqual(self.w.store.get(stage2.ok_key("001", None)), HEAD2)
        verify.assert_not_called()

    def test_related_change_requires_exact_current_master_verify_before_cache_update(self):
        self.w.store.set(stage2.ok_key("001", None), HEAD1)
        self.w.git.relation_owner_shards = {"001"}
        verify = mock.Mock(return_value=(True, ""))

        ready, detail = self.refresh(changed=lambda _old, _new: [RELATION],
                                     owners=self.w.git.stage2_affected_relation_shards, verify=verify)

        self.assertTrue(ready)
        self.assertEqual(detail, "")
        verify.assert_called_once_with("shard", "001", None, None)
        self.assertEqual(self.w.store.get(stage2.ok_key("001", None)), HEAD2)

    def test_unknown_change_evidence_requires_exact_verify_and_failure_keeps_old_cache(self):
        self.w.store.set(stage2.ok_key("001", None), HEAD1)
        self.w.git.relation_owner_shards = None
        verify = mock.Mock(return_value=(False, "accounting incomplete"))

        ready, detail = self.refresh(changed=lambda _old, _new: [RELATION],
                                     owners=self.w.git.stage2_affected_relation_shards, verify=verify)

        self.assertFalse(ready)
        self.assertEqual(detail, "accounting incomplete")
        verify.assert_called_once_with("shard", "001", None, None)
        self.assertEqual(self.w.store.get(stage2.ok_key("001", None)), HEAD1)

    def test_missing_prior_shard_success_is_not_upgraded_by_cache_refresh(self):
        verify = mock.Mock(return_value=(True, ""))

        ready, detail = self.refresh(changed=lambda _old, _new: [], verify=verify)

        self.assertFalse(ready)
        self.assertEqual(detail, "Stage 2 shard verify 성공 기록 없음")
        verify.assert_not_called()
        self.assertIsNone(self.w.store.get(stage2.ok_key("001", None)))


class Stage3IndependentStart(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)
        self.w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}
        self.assertTrue(self.w.store.start_stage3("codex", "continuous")[0])

    def start(self):
        with mock.patch.object(self.w.sup, "_prepare_existing") as prepare:
            self.w.sup._prepare_new_stage3(dict(self.w.store.line("codex", STAGE3_METHOD)))
        return prepare

    def test_old_success_is_trusted_without_reverification(self):
        self.w.store.set(stage2.ok_key("001", None), "any recorded value")
        self.start().assert_called_once()
        self.assertEqual(self.w.git.verify_calls, [])
        self.assertEqual(self.w.store.get(stage2.ok_key("001", None)), "any recorded value")

    def test_missing_success_stops_without_skipping(self):
        self.w.store.set(stage2.ok_key("002", None), HEAD1)
        self.start().assert_not_called()
        self.assertEqual(self.w.store.line("codex", STAGE3_METHOD)["run"], 0)
        self.assertIsNone(self.w.store.latest_batch("codex", STAGE3_METHOD))

    def test_merge_lag_waits_with_poll_interval_and_manual_restart_clears_wait(self):
        w = self.w
        w.cfg["poll_seconds"] = 300
        w.gh.merged_stage3_prs = [{"title": "[S3/Codex] 006", "merge_commit_sha": HEAD1}]
        self.start().assert_not_called()
        self.assertIn("master", w.store.get("s3_wait_codex"))
        self.start().assert_not_called()
        self.assertEqual(w.gh.merged_stage3_prs_calls, 1)
        w.store.set_line("codex", STAGE3_METHOD, run=0)
        self.assertTrue(w.store.start_stage3("codex", "continuous")[0])
        self.assertIsNone(w.store.get("s3_wait_codex"))
        self.start().assert_not_called()
        self.assertEqual(w.gh.merged_stage3_prs_calls, 2)

    def test_existing_occupancy_precedes_search(self):
        w = self.w
        w.store.create_batch(method=STAGE3_METHOD, producer="other", shard="001", batch="all", branch="s3-other-001", worktree="/tmp/s3-test")
        self.start().assert_not_called()
        self.assertEqual(w.gh.merged_stage3_prs_calls, 0)
        self.assertIn("점유", w.store.get("s3_wait_codex"))


if __name__ == "__main__":
    unittest.main()
