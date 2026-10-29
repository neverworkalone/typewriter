import json
import tempfile
import unittest
from pathlib import Path

from warroom import progress, prompts


class DirectionPolicyPrompts(unittest.TestCase):
    def setUp(self):
        self.batch = {
            "method": "s2", "shard": "001", "batch": "01-01", "branch": "codex/issue-2309",
            "pr_number": 2309, "head_sha": "a" * 40,
        }
        self.new = {"type_tier_policy": "source-mirror-v1", "pending_chunk": "001-01-01-001",
                    "next_chunk_number": 1, "decided": 0, "total": 1}
        self.legacy = {"type_tier_policy": None, "pending_chunk": "001-01-01-001",
                       "next_chunk_number": 1, "decided": 0, "total": 1}

    def test_primary_optional_repair_and_revision_cards_follow_checkpoint_policy(self):
        new_card = prompts.stage2(self.batch, "chunk", self.new, view="# decision: c<n> R <type> <tier> T<k>\n")
        old_card = prompts.stage2(self.batch, "chunk", self.legacy, view="# decision: reverse_type reverse_tier\n")
        self.assertIn("judge type/relevance once from the source sense", new_card)
        self.assertIn("independently judge the reverse type/relevance", old_card)

        links = prompts.stage2_links(self.batch, self.new, "links @digest\n")
        self.assertIn("CLI derives and saves the same type/relevance", links)
        repair = prompts.stage2_repair(self.batch, "f" * 64, '{"groups":[]}', "1/2", "source-mirror-v1")
        legacy_repair = prompts.stage2_repair(self.batch, "f" * 64, '{"groups":[]}', "1/2", "legacy-independent")
        self.assertIn("Never supply or independently judge reverse values", repair)
        self.assertIn("independently judge the reverse type/relevance", legacy_repair)

        resume = prompts.stage2_chunk_resume("001-01-01-001", self.new)
        correction = prompts.stage2_chunk_fix("001-01-01-001", "c1: format", self.new)
        link_correction = prompts.stage2_links_fix("d" * 64, "format", self.new)
        self.assertIn("Never supply or independently judge reverse values", resume)
        self.assertIn("Never supply or independently judge reverse values", correction)
        self.assertIn("Never supply or independently judge reverse values", link_correction)

    def test_stage2_pr_fix_uses_current_checkpoint_policy(self):
        event = {"kind": "review", "author": "reviewer", "key": "review-1", "body": "Use the source-side Tier."}
        new_fix = prompts.fix(self.batch, [event], False, source_context="inspect c1", checkpoint=self.new)
        old_fix = prompts.fix(self.batch, [event], False, source_context="inspect c1", checkpoint=self.legacy)
        self.assertIn("judge type/relevance once from the source sense", new_fix)
        self.assertIn("independently judge the reverse type/relevance", old_fix)

    def test_stage2_recovery_uses_saved_checkpoint_policy(self):
        new_recovery = prompts.recovery(self.batch, checkpoint=self.new)
        old_recovery = prompts.recovery(self.batch, checkpoint=self.legacy)
        self.assertIn("judge type/relevance once from the source sense", new_recovery)
        self.assertIn("independently judge the reverse type/relevance", old_recovery)


class ProgressMarkerCompatibility(unittest.TestCase):
    def _checkpoint(self, marker="missing"):
        payload = {
            "version": 1, "shard": "001", "batch": "01", "part": "01", "complete": True,
            "merged": False, "next_chunk_number": 1, "pending_chunk": None, "items": [],
        }
        if marker != "missing":
            payload["type_tier_policy"] = marker
        return payload

    def test_progress_accepts_new_and_marker_free_checkpoints_and_rejects_unknown_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scratch = root / ".warroom-scratch"
            scratch.mkdir()
            path = scratch / "relation-admission-001-01-01.json"
            for marker, expected in (("source-mirror-v1", "source-mirror-v1"), ("missing", None)):
                path.write_text(json.dumps(self._checkpoint(marker)), encoding="utf-8")
                observed = progress.stage2_checkpoint(root, "001", "01-01")
                self.assertEqual(observed["type_tier_policy"], expected)
            path.write_text(json.dumps(self._checkpoint("unknown")), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "Type/Tier direction policy"):
                progress.stage2_checkpoint(root, "001", "01-01")


if __name__ == "__main__":
    unittest.main()
