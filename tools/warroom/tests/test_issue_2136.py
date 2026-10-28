"""#2136: bounded chunk re-entry, storage-first hand-off and session-loss recovery."""
import json
import unittest
from pathlib import Path

from tests.test_issue_1908 import s2_world
from tests.test_issue_2033_c import CWorld
from tests.test_issue_2034_d import DWorld
from tests.test_issue_2035 import ABWorld
from tests.test_issue_2047 import CHUNK, GOOD, answer
from warroom.adapters import ClaudeCodeAdapter
from warroom import control, dchunk, stage1ab, stage2


class Stage2Reentry(unittest.TestCase):
    def world(self, *plans):
        w = s2_world(self)
        control.start(w.store, "claude", "s2", "single", cfg=w.cfg)
        w.adapter.plan.extend(plans)
        w.tick()
        return w, w.store.active_batch("claude", "s2")

    def finish(self, w, batch):
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick(2)
        return w.store.batch(batch["id"])

    def test_missing_answer_retries_same_pending_chunk_once_and_operator_retry_regrants_it(self):
        w, b = self.world({"code": 0, "session": "s1", "text": answer("작업 중")},
                          {"code": 0, "session": "s1", "text": answer("계속 작업 중")},
                          {"code": 0, "session": "s1", "text": answer(GOOD)})
        self.finish(w, b)
        self.assertEqual((w.adapter.launches[-1]["kind"], w.row("claude", "s2")["run_kind"]),
                         ("resume", "s2_chunk_resume"))
        checkpoint = stage2.checkpoint(w.row("claude", "s2")["worktree"], "001", "01-01")
        self.assertEqual(checkpoint["pending_chunk"], CHUNK)

        w.sup = w.make_sup()  # the one-use allowance survives a Supervisor restart
        b = self.finish(w, b)
        self.assertEqual((b["state"], len(w.adapter.launches)), ("ERROR", 2))
        checkpoint = stage2.checkpoint(b["worktree"], "001", "01-01")
        self.assertEqual(checkpoint["pending_chunk"], CHUNK)
        target = w.sup._chunk_retry_target(b)
        key = w.sup._auto_retry_key(b, target)
        self.assertEqual(w.store.get(key), "1")

        self.assertTrue(control.retry(w.store, "claude", "s2"))
        w.tick(2)
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        b = self.finish(w, b)
        self.assertEqual((b["run_kind"], len(w.git.save_calls)), ("s2_deterministic_finalize", 1))
        self.assertIsNone(w.store.get(key))

    def test_missing_answer_without_a_session_uses_one_safe_fresh_session(self):
        w, b = self.world({"code": 0, "text": answer("조금 더 살펴보겠습니다")},
                          {"code": 0, "session": "s2", "text": answer(GOOD)})
        self.finish(w, b)
        self.assertEqual((w.row("claude", "s2")["run_kind"], w.adapter.launches[-1]["kind"]),
                         ("s2_chunk_new", "start"))
        checkpoint = stage2.checkpoint(w.row("claude", "s2")["worktree"], "001", "01-01")
        self.assertEqual(checkpoint["pending_chunk"], CHUNK)

    def test_missing_session_falls_back_to_one_new_session_for_the_same_part(self):
        w, b = self.world({"code": 2, "session": "s1", "text": "no conversation found with session id s1"},
                          {"code": 0, "session": "s2", "text": answer(GOOD)})
        b = self.finish(w, b)
        self.assertEqual((b["state"], b["run_kind"], w.adapter.launches[-1]["kind"]),
                         ("PRODUCING", "s2_chunk_new", "start"))
        checkpoint = stage2.checkpoint(b["worktree"], "001", "01-01")
        self.assertEqual(checkpoint["pending_chunk"], CHUNK)
        b = self.finish(w, b)
        self.assertEqual((b["run_kind"], len(w.adapter.launches)), ("s2_deterministic_finalize", 2))


class ChunkStorageAndLimits(unittest.TestCase):
    def test_unknown_exit_accepts_only_an_exact_saved_d_chunk(self):
        w = DWorld(records=25)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "d")
        w.ai(save=True)
        w.tick()
        w.finish_last()
        Path(w.store.batch(w.row_()["id"])["exit_file"]).unlink()
        w.tick()
        self.assertEqual((w.row_()["state"], len(w.adapter.launches)), ("WAITING_REVIEW", 1))

    def test_unknown_exit_without_exact_saved_chunk_stops_without_retry(self):
        w = DWorld(records=25)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "d")
        w.ai(save=False)
        w.tick()
        w.finish_last()
        Path(w.store.batch(w.row_()["id"])["exit_file"]).unlink()
        w.tick()
        self.assertEqual((w.row_()["state"], len(w.adapter.launches)), ("ERROR", 1))

    def test_missing_completion_event_does_not_discard_exact_saved_d_chunk(self):
        w = DWorld(records=25)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "d")
        w.ai(save=True)
        w.tick()
        w.finish_last()
        w.adapter.completion_problem = lambda *args: ("ERROR", "turn.completed is missing")
        w.adapter.completion_incomplete = lambda *args: True
        w.tick()
        self.assertEqual((w.row_()["state"], len(w.adapter.launches)), ("WAITING_REVIEW", 1))

    def test_saved_d_chunk_with_unknown_claude_permissions_never_advances(self):
        for code in (0, 1):
            with self.subTest(exit_code=code):
                w = DWorld(records=25)
                self.addCleanup(w.tmp.cleanup)
                w.start("single", "deepseek", "d")
                w.ai(code=code)
                w.tick()
                w.finish_last()
                b = w.row_()
                run = w.store.runs(b["id"])[0]
                events = [
                    {"type": "system", "subtype": "init", "session_id": "ses_d", "model": run["model"]},
                    {"type": "assistant", "message": {"content": [{"type": "tool_use", "name": "Bash",
                                                                          "input": {"command": "node submit"}}]}},
                ]
                Path(b["log_file"]).write_text("".join(json.dumps(event) + "\n" for event in events))
                claude = ClaudeCodeAdapter()
                w.adapter.run_problem = claude.run_problem
                w.adapter.completion_problem = claude.completion_problem
                w.adapter.completion_incomplete = claude.completion_incomplete
                w.adapter.output_identity_problem = claude.output_identity_problem
                w.adapter.denied_actions = claude.denied_actions

                w.tick()

                b = w.row_()
                saved = Path(b["worktree"]) / dchunk.names(b).directory / "chunk-001.jsonl"
                self.assertEqual((b["state"], len(w.adapter.launches)), ("PAUSED", 1))
                self.assertTrue(saved.is_file())
                self.assertIsNone(claude.denied_actions(Path(b["log_file"])))

    def test_a_b_missing_session_uses_existing_chunk_correction_budget(self):
        w = ABWorld(records=60, method="a")
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "a")
        w.ai("no conversation found with session id s1", code=2, session="s1")
        w.ai(w.block(1), session="s2")
        w.tick()
        w.finish_last()
        w.tick()
        b = w.row_()
        self.assertEqual((b["run_kind"], len(w.adapter.launches)), ("ab_chunk_retry", 2))
        self.assertEqual(w.adapter.launches[-1]["kind"], "start")
        self.assertIn("이전 세션을 찾지 못해", w.adapter.launches[-1]["prompt"])
        self.assertEqual(stage1ab.load_state(w.store, b["id"], 1)["tries"], 1)

    def test_nonzero_ab_exit_with_the_exact_current_begin_marker_repairs_malformed_block(self):
        w = ABWorld(records=60, method="a")
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "a")
        w.ai("BEGIN chunk 001\nS1\t후보", code=2, session="ses_ab", end=False)
        w.ai(w.block(1), session="ses_ab")
        w.tick()
        w.finish_last()
        w.tick()
        b = w.row_()
        self.assertEqual((b["run_kind"], len(w.adapter.launches)), ("ab_chunk_retry", 2))
        self.assertEqual((w.adapter.launches[-1]["kind"], w.adapter.launches[-1].get("session")), ("resume", "ses_ab"))
        self.assertIn("TAB", w.adapter.launches[-1]["prompt"])
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["run_kind"], "ab_chunk_new")

    def test_nonzero_ab_exit_without_an_exact_current_begin_marker_stays_missing(self):
        for text in ("작업 안내: BEGIN chunk 001", "BEGIN chunk 002\nS1\t후보\nEND chunk 002", "S1\t후보"):
            with self.subTest(text=text):
                w = ABWorld(records=60, method="a")
                self.addCleanup(w.tmp.cleanup)
                w.start("single", "deepseek", "a")
                w.ai(text, code=2, session="ses_ab")
                w.tick()
                w.finish_last()
                w.tick()
                self.assertEqual((w.row_()["state"], len(w.adapter.launches)), ("PAUSED", 1))

    def test_nonzero_ab_malformed_current_answer_still_requires_the_existing_run_identity_check(self):
        w = ABWorld(records=60, method="a")
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "a")
        w.ai("BEGIN chunk 001\nS1\t후보", code=2, session="ses_ab")
        w.tick()
        w.finish_last()
        w.adapter.output_identity_problem = lambda *args: ("ERROR", "output identity mismatch")
        w.tick()
        self.assertEqual((w.row_()["state"], len(w.adapter.launches)), ("ERROR", 1))

    def test_c_missing_session_starts_one_new_session_only_when_no_sense_was_saved(self):
        w = CWorld(senses=30)
        self.addCleanup(w.tmp.cleanup)
        def nothing_saved():
            w.runner.literary.mark(w.wt(), ".warroom-scratch/001_01_c_deepseek.checkpoint.json", [])
        w.adapter.plan.extend([
            {"code": 2, "session": "ses_c", "text": "no conversation found with session id ses_c", "effect": nothing_saved},
            {"code": 0, "session": "ses_new"},
        ])
        w.start("single", "deepseek", "c")
        w.tick()
        chunk_no = w.active()["chunk_no"]
        w.finish_last()
        w.tick()
        self.assertEqual((w.row("deepseek", "c")["run_kind"], w.adapter.launches[-1]["kind"]), ("c_chunk_new", "start"))
        self.assertEqual(w.active()["chunk_no"], chunk_no)
        self.assertIn("이전 세션을 찾지 못해 새 세션", w.adapter.launches[-1]["prompt"])

    def test_c_candidate_repair_without_cli_diagnostic_resumes_same_repair_chunk_once(self):
        w = CWorld(senses=12)
        self.addCleanup(w.tmp.cleanup)
        w.runner.literary.export_error = json.dumps({"status": "FAILED", "diagnostic": "candidate_validation",
                                                     "affected": {"sense_ids": ["s0002"]}})
        w.ai(session="ses_first")
        def malformed_submit():
            rec = w.active()
            path = w.wt() / f".warroom-scratch/c-chunk-{rec['chunk_no']:03d}.submit.json"
            path.write_text('{"senses":[{"sense_id":"s0002","verified":[],"candidates":["후보"]}]\nnode scripts/relation/literary-context-cli.mjs submit\n')
        w.adapter.plan.append({"code": 0, "session": "ses_repair", "effect": malformed_submit})
        def repaired_submit():
            rec = w.active()
            w.runner.literary.mark(w.wt(), ".warroom-scratch/001_01_c_deepseek.checkpoint.json", rec["sense_ids"])
            w.runner.literary.export_error = None
        w.adapter.plan.append({"code": 0, "session": "ses_repair", "effect": repaired_submit})
        w.start("single", "deepseek", "c")
        w.tick()
        w.finish_last()
        w.tick()
        repair = w.active()
        self.assertTrue(repair["repair"])
        repair_chunk = repair["chunk_no"]

        w.finish_last()
        w.tick()
        retry = w.adapter.launches[-1]
        self.assertEqual((retry["kind"], retry["session"], w.active()["chunk_no"]),
                         ("resume", "ses_repair", repair_chunk))
        self.assertIn("Candidate v1 검증이", retry["prompt"])
        self.assertIn("같은 파일을 다시 제출", retry["prompt"])

        w.finish_last()
        w.tick(2)
        self.assertEqual((w.row("deepseek", "c")["state"], len(w.adapter.launches)), ("WAITING_REVIEW", 3))

    def test_d_missing_session_uses_a_new_session_for_the_same_empty_chunk(self):
        w = DWorld(records=25)
        self.addCleanup(w.tmp.cleanup)
        w.adapter.plan.extend([
            {"code": 2, "session": "ses_d", "text": "no conversation found with session id ses_d"},
            {"code": 0, "session": "ses_new"},
        ])
        w.start("single", "deepseek", "d")
        w.tick()
        chunk_no = w.active()["chunk_no"]
        w.finish_last()
        w.tick()
        self.assertEqual((w.row_()["run_kind"], w.adapter.launches[-1]["kind"]), ("d_chunk_new", "start"))
        self.assertEqual(w.active()["chunk_no"], chunk_no)
        self.assertIn("이전 세션을 찾지 못해 새 세션", w.adapter.launches[-1]["prompt"])

    def test_d_search_failed_evidence_blocks_a_missing_session_retry(self):
        w = DWorld(records=25)
        self.addCleanup(w.tmp.cleanup)
        def failed_search():
            folder = w.wt() / dchunk.names(w.row_()).directory
            rec = w.active()
            with open(folder / "search-001.jsonl", "a", encoding="utf-8") as fh:
                fh.write(json.dumps({"record_id": "w0001", "status": "SEARCH_FAILED", "hits": 0,
                                     "chunk_no": rec["chunk_no"], "view_sha256": rec["view_sha256"]}) + "\n")
        w.adapter.plan.append({"code": 2, "session": "ses_d", "text": "no conversation found with session id ses_d",
                               "effect": failed_search})
        w.start("single", "deepseek", "d")
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual((w.row_()["state"], len(w.adapter.launches)), ("PAUSED", 1))
        self.assertTrue((w.wt() / dchunk.names(w.row_()).directory / "search-001.jsonl").read_text().endswith("\n"))

    def test_nonzero_d_rejection_requires_known_clear_claude_permissions_before_fix(self):
        cases = (("missing result", None, "PAUSED", 1),
                 ("denial", [{"tool_name": "Bash", "tool_input": {"command": "node submit"}}], "PAUSED", 1),
                 ("clear", [], "PRODUCING", 2))
        for name, denials, want_state, want_launches in cases:
            with self.subTest(name=name):
                w = DWorld(records=25)
                self.addCleanup(w.tmp.cleanup)
                w.start("single", "deepseek", "d")
                w.ai_rejected(code=1)
                w.adapter.plan.append({"code": 0, "session": "ses_d"})
                w.tick()
                w.finish_last()
                b = w.row_()
                run = w.store.runs(b["id"])[0]
                events = [{"type": "system", "subtype": "init", "session_id": "ses_d", "model": run["model"]}]
                if denials is not None:
                    events.append({"type": "result", "subtype": "success", "is_error": False,
                                   "session_id": "ses_d", "permission_denials": denials})
                log = Path(b["log_file"])
                log.write_text("".join(json.dumps(event) + "\n" for event in events))
                claude = ClaudeCodeAdapter()
                w.adapter.run_problem = claude.run_problem
                w.adapter.output_identity_problem = claude.output_identity_problem
                w.adapter.denied_actions = claude.denied_actions
                w.adapter.session_id = claude.session_id
                names = dchunk.chunk_names(b, 1)
                rejection = Path(b["worktree"]) / names.rejected
                decisions = Path(b["worktree"]) / names.decisions
                rejection_before, decisions_before = rejection.read_bytes(), decisions.read_bytes()

                w.tick()

                b = w.row_()
                self.assertEqual((b["state"], len(w.adapter.launches)), (want_state, want_launches))
                self.assertEqual(w.kinds()[-1], "d_chunk_fix" if want_launches == 2 else "d_chunk_new")
                self.assertEqual((rejection.read_bytes(), decisions.read_bytes()), (rejection_before, decisions_before))


if __name__ == "__main__":
    unittest.main()
