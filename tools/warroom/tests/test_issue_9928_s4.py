"""Issue #9928: Stage 4 is registered on the shared refinement line by spec, rule and prompts only."""
import unittest
from unittest import mock

from tests.fakes import World, assign_profiles
from warroom import prompts, refine, s3parallel, stage3, stage4
from warroom.adapters import RunSpec
from warroom.store import STAGE3_METHOD

S4_RELATION, S4_DROP = "data/relations/relation-001.jsonl", "data/relation-drops/drop-001.jsonl"
OTHER = "data/relations/relation-007.jsonl"


def world(test):
    w = World()
    test.addCleanup(w.tmp.cleanup)
    w.cfg["producers"] = {"codex": {"label": "Sol", "adapter": "codex", "model": "gpt-x", "effort": "high"}}
    assign_profiles(w.cfg)
    w.cfg["model_profiles"]["sol"] = {"adapter": "codex", "model": "gpt-6.1-sol", "effort": "medium",
                                      "permission_profile": "worktree"}
    w.cfg["assignments"]["stage4"] = {"codex": "sol"}
    return w


def view(senses):
    """A stripped Stage 4 chunk view: `senses` is [(record_id, [dir, ...]), ...]."""
    out, n = [], 0
    for index, (record, dirs) in enumerate(senses, start=1):
        rels = []
        for direction in dirs:
            n += 1
            rels.append({"n": n, "dir": direction, "type": "near", "tier": 3})
        out.append({"n": index, "record_id": record, "sense_id": f"{record}-s{index}", "relations": rels})
    return {"chunk": "001", "total_chunks": 1, "sense_count": len(out), "relation_count": n, "senses": out}


class Stage4Registration(unittest.TestCase):
    def setUp(self):
        self.w = world(self)
        self.assertTrue(self.w.store.start_stage3("codex", "continuous")[0])

    def start(self):
        with mock.patch.object(self.w.sup, "_prepare_existing") as prepare:
            self.w.sup._prepare_new_stage3(dict(self.w.store.line("codex", STAGE3_METHOD)))
        return prepare

    def test_stage4_follows_stage3_per_shard_on_its_own_profile_and_continues_over_no_change_shards(self):
        w = self.w
        self.assertEqual([spec.id for spec in refine.stages()], ["s3", "s4"])
        w.gh.merged_stage3_prs = [{"title": "[S3/Sol] 427", "merge_commit_sha": w.git.base_sha}]
        w.store.set(stage3.ok_key("001"), w.git.base_sha)
        self.start()
        latest = w.store.latest_batch("codex", STAGE3_METHOD)
        self.assertTrue(latest is None or latest["batch"] == "all", "Stage 3 is not done: no Stage 4")

        w.gh.merged_stage3_prs = [{"title": "[S3/Sol] 428", "merge_commit_sha": w.git.base_sha}]
        self.assertTrue(w.store.start_stage3("codex", "continuous")[0])
        # Shards 001-002 completed without changes (no PR); the next selection is 003, gated on its Stage 3 success.
        w.store.set(stage4.SPEC.nochange_key("001"), w.git.base_sha)
        w.store.set(stage4.SPEC.nochange_key("002"), w.git.base_sha)
        self.start().assert_not_called()   # shard 003 has no Stage 3 success yet: the line ends
        self.assertEqual(w.store.line("codex", STAGE3_METHOD)["run"], 0)
        w.store.set(stage3.ok_key("003"), w.git.base_sha)
        self.assertTrue(w.store.start_stage3("codex", "continuous")[0])
        self.start().assert_called_once()
        b = w.store.latest_batch("codex", STAGE3_METHOD)
        self.assertEqual((b["shard"], b["batch"], b["branch"]), ("003", "s4", "s4-codex-003"))
        self.assertIs(refine.spec_for(b), stage4.SPEC)
        self.assertEqual(w.sup._run(b), RunSpec("gpt-6.1-sol", "medium", "worktree"))
        round_ = s3parallel._Round(w.sup.s3p, b)
        self.assertIsNone(round_.preflight())
        self.assertEqual(round_.run, w.sup._run(b), "the parallel round spawns exactly the Stage 4 profile")

    def test_missing_stage4_assignment_blocks_only_stage4(self):
        w = self.w
        del w.cfg["assignments"]["stage4"]
        w.gh.merged_stage3_prs = [{"title": "[S3/Sol] 428", "merge_commit_sha": w.git.base_sha}]
        w.store.set(stage3.ok_key("001"), w.git.base_sha)
        self.start().assert_not_called()
        self.assertIn("Stage 4", w.store.line("codex", STAGE3_METHOD)["blocked"])

    def test_scope_prompts_and_answer_rule(self):
        spec = stage4.SPEC
        self.assertEqual(spec.scope("001", [OTHER, "README.md"]), {S4_RELATION, S4_DROP, OTHER})
        self.assertEqual(stage3.SPEC.scope("001", [OTHER]), {S4_RELATION, S4_DROP}, "Stage 3 keeps its two files")
        pr = {"number": 5, "title": "[S4/Sol] 001", "body": "Refs #9929", "base_ref": "master"}
        self.assertEqual(refine.ops_for(spec).validate_pr(pr, [{"path": OTHER}]), "001", "a reverse-only PR is valid")
        with self.assertRaises(refine.RefineError):
            refine.ops_for(spec).validate_pr(pr, [{"path": "README.md"}])
        for name in ("s4_chunk", "s4_fix", "s4_policy_card"):
            self.assertTrue((prompts.PROMPT_DIR / f"{name}.md").read_text("utf-8").strip())

        context = stage4.decision_context(view([("w1", ["F", "R"]), ("w1", ["X"]), ("w2", [])]), "001")
        normalized, warnings = stage4.normalize_decisions(
            "chunk 001\nskip 3 9\nD 1 7\nC 2 mood 4\nC 2 scene 4\nA 3 \"적적함\" mood 3\nM 3 1\nM 2 3\nprose", "001", context)
        self.assertEqual(normalized, "chunk 001\nskip 3\nA 3 \"적적함\" mood 3\nD 1\nM 3 1\n")
        self.assertEqual(len(warnings), 5)
        with self.assertRaises(refine.NoJudgment):   # nothing usable is never an implicit Keep-all
            stage4.normalize_decisions("chunk 001\nD 99\nprose", "001", context)
        self.assertEqual(stage4.normalize_decisions("chunk 001\nnone", "001", context)[0], "chunk 001\nnone\n")


class Stage4Finalize(unittest.TestCase):
    def setUp(self):
        self.w = world(self)
        path = self.w.paths.worktrees / "s4-001"
        path.mkdir(parents=True)
        self.w.git.reg[str(path)] = "s4-codex-001"
        bid = self.w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="s4",
                                        branch="s4-codex-001", worktree=str(path))
        self.w.store.update(bid, state="PRODUCING", run_kind="s3_finalize")
        self.b = self.w.store.batch(bid)
        self.ops = refine.ops_for(stage4.SPEC)
        self.w.gh.issues[9929] = {"state": "open", "labels": ["batch"], "title": "Stage 4", "body": ""}

    def finalize(self, applied):
        cp = {"version": 1, "shard": "001", "chunk_total": 1, "completed_chunks": ["001"], "decisions": []}
        with mock.patch.object(self.ops, "checkpoint", side_effect=[cp, None, None, None]), \
                mock.patch.object(self.ops, "apply", side_effect=applied), \
                mock.patch.object(self.ops, "report", return_value={"shard": "001"}):
            self.w.sup._stage3_finalize_do(self.w.store.batch(self.b["id"]))
        return self.w.store.batch(self.b["id"])

    def test_cross_shard_pr_commits_other_shard_files_and_verifies_affected_shards_once(self):
        w = self.w

        def applied(*_args):
            w.git.dirty_text = f" M {OTHER}\n"   # a reverse-only edit: the produced shard's files are unchanged
            return {"status": "applied", "senses": {"total": 9, "skipped": 4, "polished": 5},
                    "decisions": {"add": 0, "drop": 1, "set": 0, "rebind": 0}, "affected_shards": ["001", "007"],
                    "conflicts": [], "z_added": 0}
        b = self.finalize(applied)
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self.assertEqual(w.git.commits, [([OTHER], "[S4/Sol] 001")])
        self.assertEqual(len(w.git.refine_verify_calls), 1)
        self.assertEqual(w.git.refine_verify_calls[0][1:3], ("scripts/relation/s4-cli.mjs", "001"))
        body = w.gh.created_prs[0]["body"]
        self.assertIn("Refs #9929", body)
        self.assertIn("- Senses: 9 (Polish 5, Skip 4)", body)
        self.assertIn("- Affected Shards: 001, 007", body)

    def test_no_change_shard_completes_without_commit_or_pr_and_resumes_cleanup(self):
        w = self.w
        b = self.finalize(lambda *_args: {"status": "no-change", "senses": {"total": 9, "skipped": 9, "polished": 0},
                                          "affected_shards": ["001"], "changed_files": []})
        self.assertEqual(b["state"], "CLEANUP", b["error"])
        self.assertEqual((getattr(w.git, "commits", []), getattr(w.gh, "created_prs", [])), ([], []))
        head = w.git.local_head
        self.assertEqual(w.store.get(stage4.SPEC.nochange_key("001")), head)
        self.assertEqual(w.store.get(stage4.SPEC.ok_key("001")), head)
        # A restart before cleanup re-enters CLEANUP only: no AI run and no re-apply.
        w.sup._cleanup(w.store.batch(b["id"]))
        self.assertEqual(w.store.batch(b["id"])["state"], "COMPLETE")
        self.assertEqual(w.git.removed, [(str(self.w.paths.worktrees / "s4-001"), "s4-codex-001")])

    def test_a_failed_no_change_verify_records_nothing(self):
        w = self.w
        w.git.refine_verify_fail = ("001",)
        b = self.finalize(lambda *_args: {"status": "no-change", "senses": {}, "affected_shards": ["001"]})
        self.assertEqual(b["state"], "ERROR")
        self.assertIsNone(w.store.get(stage4.SPEC.nochange_key("001")))


if __name__ == "__main__":
    unittest.main()
