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
        self.w.cfg["producers"] = {
            "codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"},
        }

    def _start(self, *, old_success=HEAD1, changed_paths=None, verified=True):
        w = self.w
        w.git.base_sha = HEAD2
        w.git.changed_between_paths = list(changed_paths or [])
        w.git.relation_owner_shards = {"001"}
        if verified:
            w.git.verify_heads.add((HEAD2, "shard", "001", None, None))
        if old_success:
            w.store.set(stage2.ok_key("001", None), old_success)
        self.assertTrue(w.store.start_stage3("codex", "continuous")[0])
        line = dict(w.store.line("codex", STAGE3_METHOD))
        with mock.patch.object(w.sup, "_stage3_recover_merged"), \
                mock.patch.object(w.sup, "_prepare_existing") as prepare, \
                mock.patch.object(stage3, "SHARDS", 1):
            w.sup._prepare_new_stage3(line)
        return prepare

    def test_stage3_starts_from_old_unrelated_shard_cache_without_running_stage2(self):
        prepare = self._start(changed_paths=["README.md"])
        batch = self.w.store.latest_batch("codex", STAGE3_METHOD)

        self.assertEqual(batch["shard"], "001")
        prepare.assert_called_once()
        self.assertEqual(self.w.store.get(stage2.ok_key("001", None)), HEAD2)
        self.assertEqual(self.w.git.verify_calls, [])
        self.assertIsNone(self.w.store.latest_batch("codex", STAGE2_METHOD))
        self.assertEqual(self.w.store.line("codex", STAGE2_METHOD)["run"], 0)

    def test_stage3_reverifies_related_change_on_master_before_starting(self):
        prepare = self._start(changed_paths=[RELATION])
        batch = self.w.store.latest_batch("codex", STAGE3_METHOD)

        self.assertEqual(batch["shard"], "001")
        prepare.assert_called_once()
        self.assertEqual(self.w.git.verify_calls, [("shard", "001", None, None)])
        self.assertEqual(self.w.store.get(stage2.ok_key("001", None)), HEAD2)

    def test_failed_reverify_waits_without_cache_update_or_stage3_ownership(self):
        prepare = self._start(changed_paths=[RELATION], verified=False)

        prepare.assert_not_called()
        self.assertIsNone(self.w.store.latest_batch("codex", STAGE3_METHOD))
        self.assertEqual(self.w.store.get(stage2.ok_key("001", None)), HEAD1)
        wait = self.w.store.get("s3_wait_codex")
        self.assertIn("구 SHA shard verify 필요 또는 실패", wait)
        self.assertIn("최신 master verify 실패", wait)

    def test_missing_success_evidence_waits_as_stage2_incomplete(self):
        w = self.w
        with mock.patch.object(stage3, "SHARDS", 1):
            choice = stage3.choose(sha=HEAD2, kv=w.store, open_prs=[], stage2_batches=[], stage3_batches=[])

        self.assertEqual(choice.status, "wait")
        self.assertIn("Stage 2 미완료", choice.note)
        self.assertNotIn("구 SHA", choice.note)
        self.assertEqual(w.git.verify_calls, [])


if __name__ == "__main__":
    unittest.main()
