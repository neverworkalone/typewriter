"""Issue #2506: Stage 3 recovery, Maintainer release, and final verify routing."""
import json
import unittest
from unittest import mock

from tests.fakes import HEAD1, HEAD2, World
from warroom import stage3
from warroom.gitops import VerifyOutcome
from warroom.store import STAGE3_METHOD


RELATION = "data/relations/relation-001.jsonl"
DROP = "data/relation-drops/drop-001.jsonl"


def checkpoint(done=None):
    return {"version": 1, "shard": "001", "chunk_total": 2,
            "completed_chunks": list(done or []), "decisions": []}


def prepared_view(chunk="001"):
    return {"chunk": chunk, "relation_count": 1,
            "senses": [{"relations": [{"n": 1, "target": "word"}]}]}


class Stage3RunRecovery(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)
        self.w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}
        self.path = self.w.paths.worktrees / "s3-001"
        self.path.mkdir(parents=True)
        self.branch = "s3-codex-001"
        self.w.git.reg[str(self.path)] = self.branch
        self.w.git.remote[self.branch] = HEAD1
        self.before = checkpoint()
        cp_path = stage3.checkpoint_path(self.path, "001")
        cp_path.parent.mkdir(parents=True, exist_ok=True)
        cp_path.write_text(json.dumps(self.before), "utf-8")
        self.view = prepared_view()
        batch_id = self.w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="all",
                                             branch=self.branch, worktree=str(self.path))
        self.log = self.path / "answer.log"
        self.log.write_text("ordinary failed exit", "utf-8")
        self.w.store.update(batch_id, state="PRODUCING", run_kind="s3_chunk_new", log_file=str(self.log))
        self.batch_id = batch_id
        self.batch = self.w.store.batch(batch_id)
        self.w.store.set(stage3.run_start_key(batch_id), json.dumps({
            "checkpoint": self.before, "chunk": "001", "branch": self.branch, "worktree": str(self.path),
            "head": HEAD1, "remote_head": HEAD1, "view": self.view,
        }, sort_keys=True))

    def _save_first_chunk(self, _runner, _env, worktree, shard, chunk, decisions):
        self.assertEqual((shard, chunk), ("001", "001"))
        self.assertEqual(decisions, "chunk 001\nD 1\n")
        after = checkpoint(done=["001"])
        stage3.checkpoint_path(worktree, shard).write_text(json.dumps(after), "utf-8")
        return {"chunk": chunk}

    def test_nonzero_exit_routes_complete_answer_through_strict_save_without_ai_retry(self):
        w = self.w
        next_chunk = mock.Mock()
        w.sup._launch_stage3_next = next_chunk
        with mock.patch.object(w.adapter, "final_answer", return_value="chunk 001\nD 1\n"), \
                mock.patch.object(stage3, "read_chunk", return_value=self.view), \
                mock.patch.object(stage3, "save_chunk", side_effect=self._save_first_chunk) as save, \
                mock.patch.object(w.adapter, "start", side_effect=AssertionError("must not call AI")):
            w.sup._run_failed(self.batch, 1)
        save.assert_called_once()
        next_chunk.assert_called_once()
        self.assertEqual(stage3.checkpoint(self.path, "001")["completed_chunks"], ["001"])

    def test_nonzero_exit_with_header_only_answer_does_not_save_or_advance(self):
        w = self.w
        with mock.patch.object(w.adapter, "final_answer", return_value="chunk 001\n"), \
                mock.patch.object(stage3, "save_chunk", side_effect=AssertionError("incomplete answer must not save")):
            w.sup._run_failed(self.batch, 1)
        self.assertEqual(stage3.checkpoint(self.path, "001"), self.before)
        self.assertEqual(w.store.batch(self.batch_id)["state"], "PAUSED")

    def test_nonzero_exit_with_explicit_none_is_saved(self):
        w = self.w
        next_chunk = mock.Mock()

        def save_none(_runner, _env, worktree, shard, chunk, decisions):
            self.assertEqual((shard, chunk, decisions), ("001", "001", "chunk 001\nnone\n"))
            stage3.checkpoint_path(worktree, shard).write_text(json.dumps(checkpoint(done=["001"])), "utf-8")
            return {"chunk": chunk}

        w.sup._launch_stage3_next = next_chunk
        with mock.patch.object(w.adapter, "final_answer", return_value="chunk 001\nnone\n"), \
                mock.patch.object(stage3, "read_chunk", return_value=self.view), \
                mock.patch.object(stage3, "save_chunk", side_effect=save_none) as save, \
                mock.patch.object(w.adapter, "start", side_effect=AssertionError("must not call AI")):
            w.sup._run_failed(self.batch, 1)
        save.assert_called_once()
        next_chunk.assert_called_once()

    def test_exit0_missing_marker_with_header_only_answer_does_not_save_or_advance(self):
        w = self.w
        next_chunk = mock.Mock()
        w.sup._run_ok_stage3_chunk = next_chunk
        with mock.patch.object(w.adapter, "final_answer", return_value="chunk 001\n"), \
                mock.patch.object(w.adapter, "completion_problem", return_value=("ERROR", "missing terminal marker")), \
                mock.patch.object(w.adapter, "completion_incomplete", return_value=True), \
                mock.patch.object(w.sup, "_saved_chunk_identity_problem", return_value=None), \
                mock.patch.object(w.sup, "_denials_cleared", return_value=True), \
                mock.patch.object(stage3, "save_chunk", side_effect=AssertionError("incomplete answer must not save")):
            w.sup._judge_exit0(self.batch)
        next_chunk.assert_not_called()
        self.assertEqual(stage3.checkpoint(self.path, "001"), self.before)
        self.assertEqual(w.store.batch(self.batch_id)["state"], "ERROR")

    def test_nonzero_exit_with_saved_checkpoint_advances_without_resaving(self):
        w = self.w
        after = checkpoint(done=["001"])
        stage3.checkpoint_path(self.path, "001").write_text(json.dumps(after), "utf-8")
        next_chunk = mock.Mock()
        w.sup._launch_stage3_next = next_chunk
        with mock.patch.object(w.adapter, "final_answer", return_value=None), \
                mock.patch.object(stage3, "save_chunk", side_effect=AssertionError("must not save twice")):
            w.sup._run_failed(self.batch, 1)
        next_chunk.assert_called_once()
        self.assertEqual(stage3.checkpoint(self.path, "001"), after)

    def test_auth_failure_does_not_accept_valid_answer(self):
        w = self.w
        with mock.patch.object(w.sup, "_classify_run", return_value="auth"), \
                mock.patch.object(w.adapter, "final_answer", return_value="chunk 001\nD 1\n"), \
                mock.patch.object(stage3, "save_chunk", side_effect=AssertionError("auth failure must not save")):
            w.sup._run_failed(self.batch, 1)
        self.assertEqual(w.store.batch(self.batch_id)["state"], "PAUSED")
        self.assertEqual(stage3.checkpoint(self.path, "001"), self.before)

    def test_exit0_without_completion_marker_accepts_only_complete_answer_only_response(self):
        w = self.w
        next_chunk = mock.Mock()
        w.sup._run_ok_stage3_chunk = next_chunk
        with mock.patch.object(w.adapter, "final_answer", return_value="chunk 001\nD 1\n"), \
                mock.patch.object(w.adapter, "completion_problem", return_value=("ERROR", "missing terminal marker")), \
                mock.patch.object(w.adapter, "completion_incomplete", return_value=True), \
                mock.patch.object(w.sup, "_saved_chunk_identity_problem", return_value=None), \
                mock.patch.object(w.sup, "_denials_cleared", return_value=True):
            w.sup._judge_exit0(self.batch)
        next_chunk.assert_called_once()

        next_chunk.reset_mock()
        with mock.patch.object(w.adapter, "final_answer", return_value="chunk 002\nD 1\n"), \
                mock.patch.object(w.adapter, "completion_problem", return_value=("ERROR", "missing terminal marker")), \
                mock.patch.object(w.adapter, "completion_incomplete", return_value=True), \
                mock.patch.object(w.sup, "_saved_chunk_identity_problem", return_value=None), \
                mock.patch.object(w.sup, "_denials_cleared", return_value=True):
            w.sup._judge_exit0(self.batch)
        next_chunk.assert_not_called()
        self.assertEqual(w.store.batch(self.batch_id)["state"], "ERROR")

    def test_missing_session_can_retry_only_exact_unsaved_prepared_chunk(self):
        w = self.w
        with mock.patch.object(stage3, "read_chunk", return_value=self.view):
            self.assertTrue(w.sup._safe_fresh_chunk_after_missing_session(self.batch))
            self.assertEqual(w.sup._chunk_retry_target(self.batch), "s3:001:001")
        stage3.checkpoint_path(self.path, "001").write_text(json.dumps(checkpoint(done=["001"])), "utf-8")
        with mock.patch.object(stage3, "read_chunk", side_effect=AssertionError("saved chunk needs no retry")):
            self.assertFalse(w.sup._safe_fresh_chunk_after_missing_session(self.batch))
            self.assertIsNone(w.sup._chunk_retry_target(self.batch))


class Stage3MaintainerRelease(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)
        self.w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}
        self.path = self.w.paths.worktrees / "s3-001"
        self.path.mkdir(parents=True)
        self.branch = "s3-codex-001"
        self.w.git.reg[str(self.path)] = self.branch
        self.w.git.remote[self.branch] = HEAD1
        self.before = checkpoint()
        cp_path = stage3.checkpoint_path(self.path, "001")
        cp_path.parent.mkdir(parents=True, exist_ok=True)
        cp_path.write_text(json.dumps(self.before), "utf-8")
        self.view = prepared_view()
        self.batch_id = self.w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="all",
                                                  branch=self.branch, worktree=str(self.path))
        self.w.store.update(self.batch_id, state="PRODUCING", run_kind="s3_chunk_new")
        self.batch = self.w.store.batch(self.batch_id)
        self.w.store.set(stage3.run_start_key(self.batch_id), json.dumps({
            "checkpoint": self.before, "chunk": "001", "branch": self.branch, "worktree": str(self.path),
            "head": HEAD1, "remote_head": HEAD1, "view": self.view,
        }, sort_keys=True))
        self.merge_sha = "c" * 40
        self.w.git.local_head = HEAD2
        self.w.git.integrated.append((str(self.path), HEAD1))
        self.w.git.integrated.append((str(self.path), self.merge_sha))

    def test_unchanged_view_retargets_head_and_reuses_bound_answer(self):
        w = self.w
        batch = w.store.batch(self.batch_id)
        with mock.patch.object(stage3, "read_chunk", return_value=self.view):
            moved = w.sup.maint._retargeted_run_start(batch, HEAD2)
        self.assertIsNotNone(moved)
        baseline = json.loads(moved[1])
        self.assertEqual(baseline["head"], HEAD2)
        self.assertNotIn("answer_invalidated", baseline)

    def test_changed_view_invalidates_answer_and_relaunches_only_same_chunk(self):
        w = self.w
        batch = w.store.batch(self.batch_id)
        new_view = prepared_view()
        new_view["senses"][0]["relations"][0]["target"] = "changed"
        with mock.patch.object(stage3, "read_chunk", return_value=new_view):
            moved = w.sup.maint._retargeted_run_start(batch, HEAD2)
        baseline = json.loads(moved[1])
        self.assertTrue(baseline["answer_invalidated"])
        self.assertEqual(baseline["view"], new_view)
        w.store.set(*moved)
        launch = mock.Mock()
        w.sup._launch = launch
        with mock.patch.object(stage3, "read_chunk", return_value=new_view), \
                mock.patch.object(w.adapter, "final_answer", side_effect=AssertionError("invalidated answer is unused")):
            w.sup._relaunch_stage3_chunk(w.store.batch(self.batch_id))
        launch.assert_called_once()
        self.assertEqual(launch.call_args.args[1], "s3_chunk_fallback_new")
        self.assertEqual(stage3.checkpoint(self.path, "001"), self.before)

    def test_released_finalization_head_marker_allows_original_data_commit_after_fix(self):
        w = self.w
        batch = w.store.batch(self.batch_id)
        w.store.update(self.batch_id, run_kind="s3_finalize")
        batch = w.store.batch(self.batch_id)
        w.store.set(f"s3_commit_head_{self.batch_id}", HEAD1)
        w.store.set(f"s3_commit_remote_head_{self.batch_id}", HEAD1)
        w.git.changed[HEAD1] = [RELATION, DROP]
        with mock.patch.object(stage3, "read_chunk", side_effect=AssertionError("finalize has no active chunk")):
            moved = w.sup.maint._retargeted_run_start(batch, HEAD2)
        self.assertEqual(moved, (f"s3_finalize_released_head_{self.batch_id}", HEAD2))

    def test_released_shared_defect_resumes_original_batch_and_preserves_chunk(self):
        w = self.w
        report = {
            "version": 1, "defect_class": "shared-validator-bug", "summary": "reproducible common defect",
            "failing_cases": ["exact Stage 3 chunk failure"], "reproduction": "run verifier",
            "suspected_layer": "shared validator",
        }
        w.sup.maint.report(self.batch, "report", "event:stage3-release", json.dumps(report))
        defect = w.store.defects()[0]
        w.store.update_defect(defect["id"], state="FIX_MERGED", merge_sha=self.merge_sha)
        w.git.integrate_updates_head = True
        w.git.changed[self.merge_sha] = ["docs/fix.md"]
        with mock.patch.object(stage3, "read_chunk", return_value=self.view):
            w.sup.maint._release()
        current = w.store.batch(self.batch_id)
        self.assertEqual(current["state"], "PRODUCING")
        self.assertEqual(w.store.defect(defect["id"])["state"], "RELEASED")
        baseline = json.loads(w.store.get(stage3.run_start_key(self.batch_id)))
        self.assertEqual(baseline["head"], self.merge_sha)
        self.assertEqual(stage3.checkpoint(self.path, "001"), self.before)


class Stage3FinalizeVerifyRouting(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)
        self.w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}
        path = self.w.paths.worktrees / "s3-001"
        path.mkdir(parents=True)
        branch = "s3-codex-001"
        self.w.git.reg[str(path)] = branch
        self.w.git.remote[branch] = HEAD1
        self.batch_id = self.w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="all",
                                                  branch=branch, worktree=str(path))
        self.w.store.update(self.batch_id, state="PRODUCING", run_kind="s3_finalize")
        self.batch = self.w.store.batch(self.batch_id)

    def test_data_verify_failure_is_not_routed_as_shared_code_defect(self):
        outcome = VerifyOutcome(False, "rows 1 error: invalid relation", {
            "family": "rows", "errors": ["invalid relation"], "total": 1,
        }, 2)
        with mock.patch.object(self.w.git, "verify_stage2_outcome", return_value=outcome) as verify, \
                mock.patch.object(self.w.sup.maint, "report", side_effect=AssertionError("data error must not escalate")):
            result = self.w.sup._stage3_finalize_verify(self.batch, HEAD1)
        self.assertIn("데이터/편집 검증 오류", result)
        verify.assert_called_once()

    def test_only_identical_project_cli_runtime_failure_reaches_existing_maintainer_route(self):
        crash = VerifyOutcome(False, "TypeError: cannot read property x at scripts/relation/admission-cli.mjs:9:1", None, 1)
        with mock.patch.object(self.w.git, "verify_stage2_outcome", side_effect=[crash, crash]) as verify:
            result = self.w.sup._stage3_finalize_verify(self.batch, HEAD1)
        self.assertEqual(result, "reported")
        verify.assert_has_calls([
            mock.call(HEAD1, "shard", "001", None, None),
            mock.call(HEAD1, "shard", "001", None, None),
        ])
        batch = self.w.store.batch(self.batch_id)
        self.assertEqual((batch["state"], batch["pause_reason"]), ("PAUSED", "shared_defect"))
        defect = self.w.store.defects()[0]
        self.assertEqual(defect["batch_id"], self.batch_id)
        self.assertIn(HEAD1, defect["report"])
        self.assertIn("verify --shard 001 --json", defect["report"])

    def test_unclassified_transient_or_permission_error_stays_local(self):
        failure = VerifyOutcome(False, "TypeError: permission denied at scripts/relation/admission-cli.mjs:9:1", None, 1)
        with mock.patch.object(self.w.git, "verify_stage2_outcome", side_effect=[failure, failure]) as verify, \
                mock.patch.object(self.w.sup.maint, "report", side_effect=AssertionError("permission failure must not escalate")):
            result = self.w.sup._stage3_finalize_verify(self.batch, HEAD1)
        self.assertIn("공통 코드 결함으로 확인하지 못했습니다", result)
        self.assertEqual(verify.call_count, 2)
        self.assertEqual(self.w.store.batch(self.batch_id)["state"], "PRODUCING")


if __name__ == "__main__":
    unittest.main()
