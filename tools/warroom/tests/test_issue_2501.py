"""Issue #2501: deterministic Stage 3 edit normalization and single-chunk recovery."""
import json
import unittest
from unittest import mock

from tests.fakes import HEAD1, World
from warroom import stage3
from warroom.store import STAGE3_METHOD


def view(chunk="008"):
    return {
        "chunk": chunk,
        "total_chunks": 99,
        "relation_count": 4,
        "senses": [{"relations": [
            {"n": 490, "target": "연결된 표제어"},
            {"n": 491, "text": "남길 수 있는 삭제 제안", "targets": []},
            {"n": 492, "text": "연결할 후보", "targets": [
                {"alias": "T1", "record_id": "w1", "sense_id": "w1-s1"},
                {"alias": "T2", "record_id": "w2", "sense_id": "w2-s2"},
            ]},
            {"n": 493, "text": "후보가 없는 텍스트", "targets": []},
        ]}],
    }


class Stage3DecisionNormalization(unittest.TestCase):
    def setUp(self):
        self.context = stage3.decision_context(view(), "008")

    def test_mixed_valid_and_invalid_proposals_keep_valid_decisions(self):
        text, warnings = stage3.normalize_decisions(
            "chunk 008\nD 491 999\nL 490 T1\nL 492 T2\n", "008", self.context)
        self.assertEqual(text, "chunk 008\nD 491\nL 492 T2\n")
        self.assertEqual(len(warnings), 2)
        self.assertIn("Relation 999", warnings[0])
        self.assertIn("Relation 490", warnings[1])
        self.assertIn("ID-linked", warnings[1])

    def test_drop_row_numbers_are_judged_independently(self):
        text, warnings = stage3.normalize_decisions("chunk 008\nD 490 491 404\n", "008", self.context)
        self.assertEqual(text, "chunk 008\nD 490\nD 491\n")
        self.assertEqual(warnings, ["Relation 404: 존재하지 않는 번호의 제안 폐기; 원본 유지"])

    def test_unknown_target_alias_and_malformed_link_keep_only_the_named_relation(self):
        text, warnings = stage3.normalize_decisions(
            "chunk 008\nL 492 T99\nL 493\nD 491\n", "008", self.context)
        self.assertEqual(text, "chunk 008\nD 491\n")
        self.assertEqual(len(warnings), 2)
        self.assertTrue(any("실제 후보가 아닌 T99" in warning for warning in warnings))
        self.assertTrue(any("Relation 493" in warning for warning in warnings))

    def test_duplicate_and_conflicting_proposals_discard_all_instructions_for_that_row(self):
        text, warnings = stage3.normalize_decisions(
            "chunk 008\nD 490 491\nD 490\nL 491 T1\nD 492\n", "008", self.context)
        self.assertEqual(text, "chunk 008\nD 492\n")
        self.assertEqual(len(warnings), 2)
        self.assertIn("Relation 490", warnings[0])
        self.assertIn("Relation 491", warnings[1])

    def test_unparseable_body_lines_and_mixed_none_preserve_valid_rows(self):
        text, warnings = stage3.normalize_decisions(
            "chunk 008\nD 491\n이해할 수 없는 메모\nnone\nL 492 T2\n", "008", self.context)
        self.assertEqual(text, "chunk 008\nD 491\nL 492 T2\n")
        self.assertEqual(len(warnings), 2)
        self.assertIn("메모", warnings[0])
        self.assertIn("none", warnings[1])

    def test_missing_or_mismatched_chunk_header_fails_closed(self):
        for answer in (None, "설명만 있음", "chunk 009\nD 491"):
            with self.subTest(answer=answer), self.assertRaises(stage3.Stage3Error):
                stage3.normalize_decisions(answer, "008", self.context)
        self.assertEqual(stage3.normalize_decisions("chunk 008\n", "008", self.context)[0],
                         "chunk 008\nnone\n")
        self.assertEqual(stage3.normalize_decisions("chunk 008\nnone\n", "008", self.context)[0],
                         "chunk 008\nnone\n")

    def test_all_invalid_proposals_become_none_with_audit_reasons(self):
        text, warnings = stage3.normalize_decisions(
            "chunk 008\nL 490 T1\nL 493 T2\nD 404\n", "008", self.context)
        self.assertEqual(text, "chunk 008\nnone\n")
        self.assertEqual(len(warnings), 3)

    def test_view_requires_unique_relation_numbers_and_real_target_aliases(self):
        repeated = view()
        repeated["senses"][0]["relations"][1]["n"] = 490
        with self.assertRaises(stage3.Stage3Error):
            stage3.decision_context(repeated, "008")
        invalid_alias = view()
        invalid_alias["senses"][0]["relations"][2]["targets"][0]["alias"] = "T0"
        with self.assertRaises(stage3.Stage3Error):
            stage3.decision_context(invalid_alias, "008")


class Stage3Recovery(unittest.TestCase):
    def setUp(self):
        self.world = World()
        self.addCleanup(self.world.tmp.cleanup)
        self.world.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}
        worktree = self.world.paths.worktrees / "s3-001"
        worktree.mkdir(parents=True)
        self.branch = "s3-codex-001"
        self.world.git.reg[str(worktree)] = self.branch
        self.world.git.remote[self.branch] = HEAD1
        self.batch_id = self.world.store.create_batch(
            method=STAGE3_METHOD, producer="codex", shard="001", batch="all",
            branch=self.branch, worktree=str(worktree))
        self.world.store.update(self.batch_id, state="ERROR", run_kind="s3_chunk_new",
                                log_file=str(worktree / "answer.log"))
        self.batch = self.world.store.batch(self.batch_id)
        self.before = {"version": 1, "shard": "001", "chunk_total": 99,
                       "completed_chunks": [f"{number:03d}" for number in range(1, 8)], "decisions": []}
        self.checkpoint_path = stage3.checkpoint_path(worktree, "001")
        self.checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        self.checkpoint_path.write_text(json.dumps(self.before), "utf-8")
        self.view = view()
        baseline = {
            "checkpoint": self.before,
            "chunk": "008",
            "branch": self.branch,
            "worktree": str(worktree),
            "head": HEAD1,
            "remote_head": HEAD1,
            "view": self.view,
        }
        self.world.store.set(stage3.run_start_key(self.batch_id), json.dumps(baseline, sort_keys=True))

    def test_pilot_retry_saves_valid_rows_without_an_ai_call_and_continues(self):
        w = self.world
        next_chunk = mock.Mock()
        w.sup._launch_stage3_next = next_chunk

        def save(_runner, _env, worktree, shard, chunk, decisions):
            self.assertEqual((shard, chunk), ("001", "008"))
            self.assertEqual(decisions, "chunk 008\nD 491\nL 492 T2\n")
            after = {**self.before, "completed_chunks": [*self.before["completed_chunks"], "008"]}
            self.checkpoint_path.write_text(json.dumps(after), "utf-8")
            return {"chunk": chunk}

        with mock.patch.object(w.adapter, "final_answer", return_value=
                               "chunk 008\nD 491 999\nL 490 T1\nL 492 T2\n"), \
                mock.patch.object(w.adapter, "start", side_effect=AssertionError("Retry must not call AI")), \
                mock.patch.object(stage3, "read_chunk", return_value=self.view), \
                mock.patch.object(stage3, "save_chunk", side_effect=save):
            w.sup._relaunch_stage3_chunk(self.batch)

        next_chunk.assert_called_once()
        refreshed = w.store.batch(self.batch_id)
        self.assertEqual((refreshed["progress_done"], refreshed["progress_total"]), (8, 99))
        self.assertIsNone(w.store.get(stage3.run_start_key(self.batch_id)))
        warnings = [event for event in w.store.recent_events() if event["level"] == "warn"]
        self.assertTrue(any("청크 008" in event["msg"] and "Relation 490" in event["msg"]
                            for event in warnings))

    def test_checkpoint_mismatch_fails_closed_without_keep_all_or_new_ai(self):
        w = self.world
        changed = {**self.before, "completed_chunks": [*self.before["completed_chunks"], "009"]}
        self.checkpoint_path.write_text(json.dumps(changed), "utf-8")
        with mock.patch.object(w.adapter, "final_answer", return_value="chunk 008\nnone\n"), \
                mock.patch.object(w.adapter, "start", side_effect=AssertionError("mismatch must not retry AI")), \
                mock.patch.object(stage3, "save_chunk", side_effect=AssertionError("mismatch must not save")):
            w.sup._relaunch_stage3_chunk(self.batch)
        self.assertEqual(w.store.batch(self.batch_id)["state"], "ERROR")
        self.assertIsNotNone(w.store.get(stage3.run_start_key(self.batch_id)))

    def test_prepared_view_mismatch_fails_closed_without_saving(self):
        w = self.world
        changed_view = json.loads(json.dumps(self.view))
        changed_view["senses"][0]["relations"][2]["targets"][1]["sense_id"] = "w9-s9"
        with mock.patch.object(w.adapter, "final_answer", return_value="chunk 008\nL 492 T2\n"), \
                mock.patch.object(stage3, "read_chunk", return_value=changed_view), \
                mock.patch.object(stage3, "save_chunk", side_effect=AssertionError("mismatch must not save")):
            w.sup._run_ok_stage3_chunk(self.batch)
        self.assertEqual(w.store.batch(self.batch_id)["state"], "ERROR")
        self.assertIsNotNone(w.store.get(stage3.run_start_key(self.batch_id)))

    def test_legacy_run_without_view_discards_saved_answer_and_starts_one_fresh_chunk(self):
        w = self.world
        baseline = json.loads(w.store.get(stage3.run_start_key(self.batch_id)))
        del baseline["view"]
        w.store.set(stage3.run_start_key(self.batch_id), json.dumps(baseline, sort_keys=True))
        changed_view = json.loads(json.dumps(self.view))
        changed_view["senses"][0]["relations"][2]["targets"][0].update(
            record_id="w9", sense_id="w9-s9")
        launch = mock.Mock()
        w.sup._launch = launch
        with mock.patch.object(w.adapter, "final_answer", return_value="chunk 008\nL 492 T1\n") as answer, \
                mock.patch.object(stage3, "read_chunk", return_value=changed_view) as read_view, \
                mock.patch.object(stage3, "save_chunk", side_effect=AssertionError("legacy answer must not save")):
            w.sup._relaunch_stage3_chunk(self.batch)
        answer.assert_not_called()
        read_view.assert_not_called()
        launch.assert_called_once()
        self.assertEqual(launch.call_args.args[1], "s3_chunk_fallback_new")
        self.assertEqual(w.store.batch(self.batch_id)["run_kind"], "s3_chunk_fallback_new")
        self.assertEqual(stage3.checkpoint(w.paths.worktrees / "s3-001", "001"), self.before)

    def test_successful_legacy_run_without_view_also_discards_answer(self):
        w = self.world
        baseline = json.loads(w.store.get(stage3.run_start_key(self.batch_id)))
        del baseline["view"]
        w.store.set(stage3.run_start_key(self.batch_id), json.dumps(baseline, sort_keys=True))
        launch = mock.Mock()
        w.sup._launch = launch
        with mock.patch.object(w.adapter, "final_answer", side_effect=AssertionError("legacy answer must not read")), \
                mock.patch.object(stage3, "save_chunk", side_effect=AssertionError("legacy answer must not save")):
            w.sup._run_ok_stage3_chunk(self.batch)
        launch.assert_called_once()
        self.assertEqual(launch.call_args.args[1], "s3_chunk_fallback_new")

    def test_legacy_saved_checkpoint_without_view_fails_closed_before_next_chunk(self):
        w = self.world
        baseline = json.loads(w.store.get(stage3.run_start_key(self.batch_id)))
        del baseline["view"]
        w.store.set(stage3.run_start_key(self.batch_id), json.dumps(baseline, sort_keys=True))
        after = {**self.before, "completed_chunks": [*self.before["completed_chunks"], "008"]}
        self.checkpoint_path.write_text(json.dumps(after), "utf-8")
        next_chunk = mock.Mock()
        w.sup._launch_stage3_next = next_chunk
        with mock.patch.object(w.sup, "_saved_chunk_identity_problem", return_value=None) as identity:
            w.sup._relaunch_stage3_chunk(self.batch)
        self.assertEqual(w.store.batch(self.batch_id)["state"], "ERROR")
        self.assertIn("원본을 증명할 수 없어", w.store.batch(self.batch_id)["error"])
        self.assertEqual(stage3.checkpoint(w.paths.worktrees / "s3-001", "001"), after)
        self.assertIsNotNone(w.store.get(stage3.run_start_key(self.batch_id)))
        identity.assert_not_called()
        next_chunk.assert_not_called()

    def test_wrong_chunk_header_fails_closed_without_saving(self):
        w = self.world
        with mock.patch.object(w.adapter, "final_answer", return_value="chunk 009\nD 491\n"), \
                mock.patch.object(stage3, "read_chunk", return_value=self.view), \
                mock.patch.object(stage3, "save_chunk", side_effect=AssertionError("wrong header must not save")):
            w.sup._run_ok_stage3_chunk(self.batch)
        self.assertEqual(w.store.batch(self.batch_id)["state"], "ERROR")
        self.assertEqual(stage3.checkpoint(w.paths.worktrees / "s3-001", "001"), self.before)

    def test_unidentified_response_uses_one_fresh_chunk_session_then_stops(self):
        w = self.world
        launch = mock.Mock()
        w.sup._launch = launch
        with mock.patch.object(w.adapter, "final_answer", return_value=None):
            w.sup._relaunch_stage3_chunk(self.batch)
        launch.assert_called_once()
        self.assertEqual(launch.call_args.args[1], "s3_chunk_fallback_new")
        self.assertIsNone(w.store.batch(self.batch_id)["session_id"])

        w.store.update(self.batch_id, run_kind="s3_chunk_fallback_new")
        launch.reset_mock()
        with mock.patch.object(w.adapter, "final_answer", return_value=None):
            w.sup._relaunch_stage3_chunk(w.store.batch(self.batch_id))
        launch.assert_not_called()
        self.assertEqual(w.store.batch(self.batch_id)["state"], "PAUSED")


if __name__ == "__main__":
    unittest.main()
