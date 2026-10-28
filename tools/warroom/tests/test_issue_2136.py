"""#2136: bounded chunk re-entry, storage-first hand-off and session-loss recovery."""
import json
import unittest
from pathlib import Path

from tests.test_issue_1908 import s2_world
from tests.test_issue_2033_c import CWorld
from tests.test_issue_2034_d import DWorld
from tests.test_issue_2035 import ABWorld
from tests.test_issue_2047 import CHUNK, GOOD, answer
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
        self.assertEqual(checkpoint["pending_chunk"]["chunk_id"], CHUNK)

        w.sup = w.make_sup()  # the one-use allowance survives a Supervisor restart
        b = self.finish(w, b)
        self.assertEqual((b["state"], len(w.adapter.launches)), ("ERROR", 2))
        checkpoint = stage2.checkpoint(b["worktree"], "001", "01-01")
        self.assertEqual(checkpoint["pending_chunk"]["chunk_id"], CHUNK)
        target = w.sup._chunk_retry_target(b)
        key = w.sup._auto_retry_key(b, target)
        self.assertEqual(w.store.get(key), "1")

        self.assertTrue(control.retry(w.store, "claude", "s2"))
        w.tick(2)
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        b = self.finish(w, b)
        self.assertEqual((b["run_kind"], len(w.git.save_calls)), ("s2_finalize_new", 1))
        self.assertIsNone(w.store.get(key))

    def test_missing_answer_without_a_session_uses_one_safe_fresh_session(self):
        w, b = self.world({"code": 0, "text": answer("조금 더 살펴보겠습니다")},
                          {"code": 0, "session": "s2", "text": answer(GOOD)})
        self.finish(w, b)
        self.assertEqual((w.row("claude", "s2")["run_kind"], w.adapter.launches[-1]["kind"]),
                         ("s2_chunk_new", "start"))
        checkpoint = stage2.checkpoint(w.row("claude", "s2")["worktree"], "001", "01-01")
        self.assertEqual(checkpoint["pending_chunk"]["chunk_id"], CHUNK)

    def test_missing_session_falls_back_to_one_new_session_for_the_same_part(self):
        w, b = self.world({"code": 2, "session": "s1", "text": "no conversation found with session id s1"},
                          {"code": 0, "session": "s2", "text": answer(GOOD)})
        b = self.finish(w, b)
        self.assertEqual((b["state"], b["run_kind"], w.adapter.launches[-1]["kind"]),
                         ("PRODUCING", "s2_chunk_new", "start"))
        checkpoint = stage2.checkpoint(b["worktree"], "001", "01-01")
        self.assertEqual(checkpoint["pending_chunk"]["chunk_id"], CHUNK)
        b = self.finish(w, b)
        self.assertEqual((b["run_kind"], len(w.adapter.launches)), ("s2_finalize_new", 2))


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
            with open(folder / "searches.jsonl", "a", encoding="utf-8") as fh:
                fh.write(json.dumps({"record_id": "w0001", "status": "SEARCH_FAILED", "hits": 0}) + "\n")
        w.adapter.plan.append({"code": 2, "session": "ses_d", "text": "no conversation found with session id ses_d",
                               "effect": failed_search})
        w.start("single", "deepseek", "d")
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual((w.row_()["state"], len(w.adapter.launches)), ("PAUSED", 1))
        self.assertTrue((w.wt() / dchunk.names(w.row_()).directory / "searches.jsonl").read_text().endswith("\n"))


if __name__ == "__main__":
    unittest.main()
