"""Issue #6555 §5: refinement Stages share one line and run in order, each a `RefineSpec`."""
import dataclasses
import re
import unittest
from unittest import mock

from tests.fakes import World
from warroom import refine, stage3
from warroom.store import STAGE3_METHOD


class RefinementStageRegistry(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)
        self.w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}
        self.assertTrue(self.w.store.start_stage3("codex", "continuous")[0])
        # A later Stage is only a spec: its own CLI, prompts, PR naming and its gate on the Stage before it.
        self.s4 = refine.register(dataclasses.replace(
            stage3.SPEC, id="s4", tag="s4", label="Stage 4", short="S4", cli="scripts/relation/s4-cli.mjs",
            scratch="relation-s4", title=re.compile(r"^\[S4/[^\]/\s]+\] (\d{3})$"),
            detail_title=re.compile(r"\[S4/([A-Za-z0-9-]+)\] (\d{3})"), search_phrases=('"S4"',), legacy_title=None,
            gate=lambda kv, shard: bool(kv.get(stage3.SPEC.ok_key(shard))), gate_label="Stage 3",
            fix=dataclasses.replace(stage3.SPEC.fix, prefix="s4", label="Stage 4"), module=None))
        self.addCleanup(refine._REGISTRY.remove, self.s4)
        self.addCleanup(refine._OPS.pop, "s4", None)

    def start(self):
        with mock.patch.object(self.w.sup, "_prepare_existing") as prepare:
            self.w.sup._prepare_new_stage3(dict(self.w.store.line("codex", STAGE3_METHOD)))
        return prepare

    def test_the_next_stage_starts_after_every_shard_of_the_previous_one_gated_per_shard(self):
        w = self.w
        w.gh.merged_stage3_prs = [{"title": "[S3/Codex] 428", "merge_commit_sha": w.git.base_sha}]
        self.start().assert_not_called()   # Stage 3 is done, but shard 001 has no Stage 3 success yet
        self.assertEqual(w.store.line("codex", STAGE3_METHOD)["run"], 0)
        self.assertIsNone(w.store.latest_batch("codex", STAGE3_METHOD))

        self.assertTrue(w.store.start_stage3("codex", "continuous")[0])
        w.store.set(stage3.SPEC.ok_key("001"), w.git.base_sha)
        self.start().assert_called_once()
        b = w.store.latest_batch("codex", STAGE3_METHOD)
        self.assertEqual((b["shard"], b["batch"], b["branch"]), ("001", "s4", "s4-codex-001"))
        self.assertTrue(b["worktree"].endswith("s4-001"))
        ops = refine.ops(b)
        self.assertIsInstance(ops, refine.RefineOps)
        self.assertEqual(ops.spec.cli, "scripts/relation/s4-cli.mjs")
        self.assertEqual(str(ops.checkpoint_path("/wt", "001")), "/wt/.warroom-scratch/relation-s4-001.json")
        self.assertIs(refine.spec_for(b), self.s4)
        self.assertIs(w.sup._refine_fix(b).spec, self.s4.fix)

    def test_stage3_keeps_its_own_operations_and_historical_names(self):
        w = self.w
        w.store.set("s2_ok_001", w.git.base_sha)
        with mock.patch("warroom.stage2.ok_key", return_value="s2_ok_001"):
            self.start().assert_called_once()
        b = w.store.latest_batch("codex", STAGE3_METHOD)
        self.assertEqual((b["batch"], b["branch"]), ("all", "s3-codex-001"))
        self.assertIs(refine.ops(b), stage3)
        self.assertEqual(stage3.ok_key("001"), "s3_ok_001")


if __name__ == "__main__":
    unittest.main()
