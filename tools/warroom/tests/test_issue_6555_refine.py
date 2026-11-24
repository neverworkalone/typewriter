"""Issue #6555 §5: refinement Stages share one line and run in order, each a `RefineSpec`."""
import dataclasses
import re
import unittest
from unittest import mock

from tests.fakes import World, assign_profiles
from warroom import refine, s3parallel, stage3
from warroom.adapters import RunSpec
from warroom.config import config_problem, role_problem
from warroom.store import STAGE3_METHOD, LineBusy


class RefinementStageRegistry(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)
        self.w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}
        assign_profiles(self.w.cfg)
        # #9934: the test-only Stage's own profile, distinct from Stage 3's, under its own `assignments.<role>`.
        self.w.cfg["model_profiles"]["codex-s4"] = {"adapter": "codex", "model": "gpt-s4", "effort": "xhigh"}
        self.w.cfg["assignments"]["stage-test"] = {"codex": "codex-s4"}
        self.assertTrue(self.w.store.start_stage3("codex", "continuous")[0])
        # A later Stage is only a spec: its own CLI, prompts, PR naming and its gate on the Stage before it.
        self.s4 = refine.register(dataclasses.replace(
            stage3.SPEC, id="s4", tag="s4", label="Stage 4", role="stage-test", short="S4", cli="scripts/relation/s4-cli.mjs",
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

        # The shard's merged Stage 3 batch is in the store, as in production; it blocks only another Stage 3 batch.
        done = w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="all",
                                    branch="s3-codex-001", worktree="/tmp/s3-001")
        w.store.update(done, state="COMPLETE", merged=1)
        with self.assertRaises(LineBusy):
            w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="all",
                                 branch="s3-codex-001", worktree="/tmp/s3-001")
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
        # its runs resolve to its own Stage profile, and the round's preflight proves exactly the RunSpec it spawns
        self.assertEqual(w.sup._run(b), RunSpec("gpt-s4", "xhigh"))
        self.assertEqual(w.sup.batch_run(b), (RunSpec("gpt-s4", "xhigh"), None))
        round_ = s3parallel._Round(w.sup.s3p, b)
        self.assertIsNone(round_.preflight())
        self.assertEqual(round_.run, RunSpec("gpt-s4", "xhigh"))
        self.assertIsNone(config_problem(w.cfg))

    def test_a_missing_stage_profile_blocks_only_that_stage_and_never_borrows_another(self):
        w = self.w
        del w.cfg["assignments"]["stage-test"]
        w.gh.merged_stage3_prs = [{"title": "[S3/Codex] 428", "merge_commit_sha": w.git.base_sha}]
        w.store.set(stage3.SPEC.ok_key("001"), w.git.base_sha)
        self.start().assert_not_called()
        line = w.store.line("codex", STAGE3_METHOD)
        self.assertIn("Stage 4", line["blocked"])
        self.assertIn("assignments.stage-test", line["blocked"])
        self.assertIsNone(w.store.latest_batch("codex", STAGE3_METHOD))
        self.assertIsNone(role_problem(w.cfg, "codex", "stage2"))   # Stage 2 still runs on its own profile
        self.assertIsNone(role_problem(w.cfg, "codex", "stage3"))

    def test_the_line_ends_normally_after_the_last_registered_stage(self):
        w = self.w
        w.gh.merged_stage3_prs = [{"title": "[S3/Codex] 428", "merge_commit_sha": w.git.base_sha}]
        w.gh.latest_s4_pr = {"title": "[S4/Codex] 428", "merge_commit_sha": w.git.base_sha}
        self.start().assert_not_called()
        self.assertEqual(w.store.line("codex", STAGE3_METHOD)["run"], 0)
        self.assertIsNone(w.store.latest_batch("codex", STAGE3_METHOD))
        self.assertIn("등록된 모든 정제 Stage", " ".join(e["msg"] for e in w.store.recent_events()))

    def test_registration_rejects_a_duplicate_or_reserved_role(self):
        for role in ("stage-test", "stage3", "stage2", "maintainer"):
            with self.subTest(role=role), self.assertRaises(ValueError):
                refine.register(dataclasses.replace(self.s4, id="s9", tag="s9", role=role))

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
