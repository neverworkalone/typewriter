"""Issue #6555 §5: refinement Stages share one line and run in order, each a `RefineSpec`."""
import dataclasses
import re
import unittest
from unittest import mock

from tests.fakes import World, assign_profiles
from warroom import refine, s3parallel, stage3, stage4, stage_d1
from warroom.adapters import RunSpec
from warroom.config import config_problem, role_problem
from warroom.store import DROP_METHOD, STAGE3_METHOD, LineBusy


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
        # The registry mechanics are proven with a test-only Stage right after Stage 3, so the real Stage 4 (#9928) steps
        # aside for these tests and returns to its place afterwards.
        refine.stages()
        position = refine._REGISTRY.index(stage4.SPEC)
        refine._REGISTRY.remove(stage4.SPEC)
        self.addCleanup(refine._REGISTRY.insert, position, stage4.SPEC)
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
        w.store.set(stage3.ok_key("428"), w.git.base_sha)   # its recorded final-shard completion
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
        w.store.set(stage3.ok_key("428"), w.git.base_sha)   # its recorded final-shard completion
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
        w.store.set(stage3.ok_key("428"), w.git.base_sha)   # its recorded final-shard completion
        w.gh.latest_s4_pr = {"title": "[S4/Codex] 428", "merge_commit_sha": w.git.base_sha}
        w.store.set(self.s4.ok_key("428"), w.git.base_sha)
        self.start().assert_not_called()
        self.assertEqual(w.store.line("codex", STAGE3_METHOD)["run"], 0)
        self.assertIsNone(w.store.latest_batch("codex", STAGE3_METHOD))
        self.assertIn("등록된 모든 정제 Stage", " ".join(e["msg"] for e in w.store.recent_events()))

    def later_stage(self, base, sid, gate_on, method=STAGE3_METHOD, **extra):
        """#10512: a test-only Stage after `gate_on` on `method`'s line, with its own profile."""
        role = f"{sid}-test"
        self.w.cfg["assignments"][role] = {"codex": "codex-s4"}
        spec = refine.register(dataclasses.replace(
            base, id=sid, tag=sid, label=sid.upper(), role=role, short=sid.upper(), method=method,
            title=re.compile(rf"^\[{sid.upper()}/[^\]/\s]+\] (\d{{3}})$"),
            detail_title=re.compile(rf"\[{sid.upper()}/([A-Za-z0-9-]+)\] (\d{{3}})"),
            search_phrases=(f'"{sid.upper()}"',), gate=lambda kv, shard: bool(kv.get(gate_on.ok_key(shard))),
            gate_label=gate_on.label, fix=dataclasses.replace(base.fix, prefix=sid, label=sid.upper()), module=None,
            **extra))
        self.addCleanup(refine._REGISTRY.remove, spec)
        self.addCleanup(refine._OPS.pop, sid, None)
        return spec

    def start_looked_up(self, method=STAGE3_METHOD):
        """Run one selection; return whether a batch was prepared and the Stage ids whose PRs were looked up."""
        w = self.w
        with mock.patch.object(w.gh, "latest_refine_production", wraps=w.gh.latest_refine_production) as lookup, \
                mock.patch.object(w.sup, "_prepare_existing") as prepare:
            w.sup._prepare_new_stage3(dict(w.store.line("codex", method)))
        return prepare.called, [call.args[1].id for call in lookup.call_args_list]

    def test_a_completed_stage_is_skipped_without_any_pr_lookup_on_every_later_selection(self):
        w, final = self.w, f"{refine.SHARDS:03d}"
        s5 = self.later_stage(self.s4, "s5", self.s4)
        w.store.set(stage3.SPEC.ok_key(final), w.git.base_sha)
        w.store.set(self.s4.ok_key(final), w.git.base_sha)
        w.store.set(self.s4.ok_key("001"), w.git.base_sha)
        self.assertEqual(self.start_looked_up(), (True, ["s5"]))
        b = w.store.latest_batch("codex", STAGE3_METHOD)
        self.assertEqual((b["shard"], b["batch"]), ("001", "s5"))
        # its next shard after a restart: the recorded completions persist, so still only S5 is looked up
        w.store.update(b["id"], state="COMPLETE", merged=1)
        w.store.set(s5.ok_key("001"), w.git.base_sha)
        w.gh.latest_s5_pr = {"title": "[S5/Codex] 001", "merge_commit_sha": w.git.base_sha}
        w.store.set(self.s4.ok_key("002"), w.git.base_sha)
        self.assertTrue(w.store.start_stage3("codex", "continuous")[0])
        self.assertEqual(self.start_looked_up(), (True, ["s5"]))
        self.assertEqual(w.store.latest_batch("codex", STAGE3_METHOD)["shard"], "002")

    def test_the_drop_line_skips_a_stage_whose_last_shard_completed_without_changes(self):
        w, final = self.w, f"{refine.SHARDS:03d}"
        d2 = self.later_stage(stage_d1.SPEC, "d2", stage_d1.SPEC, method=DROP_METHOD)
        self.assertTrue(w.store.start_stage3("codex", "continuous", DROP_METHOD)[0])
        w.store.set(stage_d1.SPEC.nochange_key(final), w.git.base_sha)   # its official no-change: no PR
        w.store.set(stage_d1.SPEC.ok_key(final), w.git.base_sha)
        w.store.set(stage_d1.SPEC.ok_key("001"), w.git.base_sha)
        self.assertEqual(self.start_looked_up(DROP_METHOD), (True, ["d2"]))
        self.assertEqual(w.store.latest_batch("codex", DROP_METHOD)["batch"], "d2")

        w.store.update(w.store.latest_batch("codex", DROP_METHOD)["id"], state="COMPLETE", merged=1)
        w.store.set(d2.ok_key(final), w.git.base_sha)
        self.assertTrue(w.store.start_stage3("codex", "continuous", DROP_METHOD)[0])
        self.assertEqual(self.start_looked_up(DROP_METHOD), (False, []), "every Stage done: no lookup at all")
        self.assertEqual(w.store.line("codex", DROP_METHOD)["run"], 0)
        self.assertIn("등록된 모든 정제 Stage", " ".join(e["msg"] for e in w.store.recent_events()))

    def test_a_merged_last_pr_without_its_recorded_completion_does_not_skip_the_stage(self):
        w = self.w
        w.gh.merged_stage3_prs = [{"title": "[S3/Codex] 428", "merge_commit_sha": w.git.base_sha}]
        w.store.set(stage3.SPEC.ok_key("001"), w.git.base_sha)
        self.assertEqual(self.start_looked_up(), (False, ["s3"]))
        self.assertEqual(w.store.line("codex", STAGE3_METHOD)["run"], 0)
        self.assertIsNone(w.store.latest_batch("codex", STAGE3_METHOD))
        self.assertIn("Stage 3 최종 샤드 428 완료 기록 없음", " ".join(e["msg"] for e in w.store.recent_events()))

    def test_the_no_change_summary_is_the_stages_own(self):
        w = self.w
        with self.assertRaises(ValueError):
            refine.register(dataclasses.replace(self.s4, id="s9", tag="s9", role="s9-test", no_change_complete=True))
        s5 = self.later_stage(self.s4, "s5", self.s4, no_change_complete=True,
                              no_change_summary=lambda result: f"S5 판정 {result['n']}건")
        wt = w.paths.worktrees / "s5-001"
        bid = w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="s5",
                                   branch="s5-codex-001", worktree=str(wt))
        w.git.reg[str(wt)] = "s5-codex-001"
        with mock.patch.object(w.sup, "_stage3_finalize_verify", return_value=None):
            w.sup._refine_no_change(w.store.batch(bid), w.git.base_sha, {"n": 7})
        self.assertEqual(w.store.get(s5.ok_key("001")), w.git.base_sha)
        self.assertIn("샤드 001 무변경 완료: S5 판정 7건", " ".join(e["msg"] for e in w.store.recent_events()))

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
