"""A merged Maintainer fix that must reach the worktree (e.g. scripts/relation/refine/core.mjs) can resume a Stage 3
finalize that stopped BEFORE its data commit: the integration is accepted only while nothing was committed, pushed or
opened, every chunk is saved, and the integration leaves the shard's Stage 3 input files unchanged (batch 8067)."""
import json
import unittest
from unittest import mock

from tests.fakes import HEAD1, HEAD2, World, assign_profiles
from warroom import stage3
from warroom.store import STAGE3_METHOD

RELATION = "data/relations/relation-001.jsonl"
DROP = "data/relation-drops/drop-001.jsonl"


class S3FinalizeFixRelease(unittest.TestCase):
    def setUp(self):
        w = self.w = World()
        self.addCleanup(w.tmp.cleanup)
        w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}
        assign_profiles(w.cfg)
        self.path = w.paths.worktrees / "s3-001"
        self.path.mkdir(parents=True)
        self.branch = "s3-codex-001"
        w.git.reg[str(self.path)] = self.branch
        w.git.remote.pop(self.branch, None)
        cp = stage3.checkpoint_path(self.path, "001")
        cp.parent.mkdir(parents=True, exist_ok=True)
        cp.write_text(json.dumps({"version": 1, "shard": "001", "chunk_total": 2,
                                  "completed_chunks": ["001", "002"], "decisions": []}), "utf-8")
        self.bid = w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="all",
                                        branch=self.branch, worktree=str(self.path))
        w.store.update(self.bid, state="PAUSED", paused_from="PRODUCING", run_kind="s3_finalize",
                       pause_reason="shared_defect")
        w.store.set(stage3.mode_key(self.bid), stage3.PARALLEL)
        w.store.set(stage3.plan_key(self.bid), "closed")
        w.store.set(stage3.parallel_start_key(self.bid), json.dumps(
            {"branch": self.branch, "worktree": str(self.path), "head": HEAD1, "remote_head": None}))
        w.git.local_head = HEAD1
        w.git.changed_between_paths = ["scripts/relation/refine/core.mjs"]

    def b(self):
        return self.w.store.batch(self.bid)

    def test_finalize_before_commit_has_a_resume_kind_and_its_start_head(self):
        m = self.w.sup.maint
        self.assertEqual(m._resume_kind(self.b()), "s3_finalize")
        self.assertEqual(m._first_head(self.b(), "s3_finalize"), HEAD1)
        self.assertIsNone(m._s3_finalize_boundary(self.b(), HEAD1))

    def test_finalize_with_an_open_pr_is_not_this_kind(self):
        self.w.store.update(self.bid, pr_number=7)
        self.assertIsNone(self.w.sup.maint._resume_kind(self.b()))

    def test_boundary_refuses_any_committed_pushed_or_moved_state(self):
        m, w = self.w.sup.maint, self.w
        cases = [
            lambda: w.store.set(f"s3_commit_head_{self.bid}", HEAD1),
            lambda: w.store.set(f"s3_commit_remote_head_{self.bid}", ""),
            lambda: w.git.remote.__setitem__(self.branch, HEAD1),
            lambda: setattr(w.git, "dirty_text", " M data/x"),
            lambda: setattr(w.git, "local_head", HEAD2),
            lambda: w.store.set(stage3.plan_key(self.bid), "open"),
            lambda: stage3.checkpoint_path(self.path, "001").unlink(),
        ]
        for i, mutate in enumerate(cases):
            with self.subTest(i):
                self.setUp()
                m = self.w.sup.maint
                w = self.w
                mutate()
                self.assertIsNotNone(m._s3_finalize_boundary(self.b(), HEAD1))

    def test_integration_must_not_touch_the_shard_inputs(self):
        m, w = self.w.sup.maint, self.w
        w.git.local_head = HEAD2
        self.assertIsNone(m._s3_finalize_boundary(self.b(), HEAD1, HEAD2))
        for path in (RELATION, DROP):
            w.git.changed_between_paths = ["scripts/relation/refine/core.mjs", path]
            self.assertIn(path, m._s3_finalize_boundary(self.b(), HEAD1, HEAD2))

    def test_cross_shard_stage_refuses_an_integration_touching_any_shard_data(self):
        from warroom import refine
        m, w = self.w.sup.maint, self.w
        w.git.local_head = HEAD2
        other = "data/relations/relation-002.jsonl"
        w.git.changed_between_paths = ["scripts/relation/refine/core.mjs", other]
        spec = refine.spec_for(self.b())
        self.assertIsNone(m._s3_finalize_boundary(self.b(), HEAD1, HEAD2))   # two-file Stage 3: another shard is not input
        cross = __import__("dataclasses").replace(spec, cross_shard=True)
        with mock.patch.object(refine, "spec_for", return_value=cross):
            self.assertIn(other, m._s3_finalize_boundary(self.b(), HEAD1, HEAD2))

    def test_stage4_batch_takes_the_same_proof_with_its_cross_shard_scope(self):
        from warroom import refine
        w = self.w
        w.store.update(self.bid, batch="s4")
        b = self.b()
        ops = refine.ops(b)
        cp = ops.checkpoint_path(self.path, "001")
        cp.parent.mkdir(parents=True, exist_ok=True)
        cp.write_text(json.dumps({"version": 1, "shard": "001", "chunk_total": 1,
                                  "completed_chunks": ["001"], "decisions": []}), "utf-8")
        m = w.sup.maint
        self.assertEqual(refine.spec_for(b).id, "s4")
        self.assertEqual(m._resume_kind(b), "s3_finalize")
        self.assertIsNone(m._s3_finalize_boundary(b, HEAD1))
        w.git.local_head = HEAD2
        self.assertIsNone(m._s3_finalize_boundary(b, HEAD1, HEAD2))
        w.git.changed_between_paths = ["data/relations/relation-300.jsonl"]
        self.assertIn("relation-300", m._s3_finalize_boundary(b, HEAD1, HEAD2))

    def test_release_records_the_released_finalize_head(self):
        m, w = self.w.sup.maint, self.w
        d = {"id": 1, "merge_sha": "c" * 40, "issue_number": 9, "batch_id": self.bid}
        env = {"observed": {}}

        def apply(_d, _b):
            w.git.local_head = HEAD2
            return HEAD2, None

        released = {}
        with mock.patch.object(m, "_fix_not_loaded", return_value=False), \
                mock.patch.object(m, "_preserved", return_value=None), \
                mock.patch.object(m, "_apply", side_effect=apply), \
                mock.patch.object(m, "_fix_merged_integration_proof", return_value={"head": HEAD2}), \
                mock.patch.object(m, "_archive_report", return_value=True), \
                mock.patch.object(m, "_recovery_snapshot", return_value=None), \
                mock.patch.object(m, "_hold_unprovable", side_effect=lambda _d, _b, why: self.fail(why)), \
                mock.patch.object(w.store, "release_defect",
                                  side_effect=lambda *a, **k: released.update(args=a, kw=k) or True):
            m._release_worktree(d, self.b(), env)
        self.assertEqual(released["args"][2], HEAD2)
        self.assertEqual(released["args"][3], [(f"s3_finalize_released_head_{self.bid}", HEAD2)])
        self.assertEqual(released["kw"]["fix_kind"], "worktree")


if __name__ == "__main__":
    unittest.main()
