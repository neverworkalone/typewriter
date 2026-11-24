"""#2136: bounded Stage 2 chunk re-entry and session-loss recovery (the C/D/A-B cases left with Stage 1, #9933)."""
import unittest

from tests.test_issue_1908 import s2_world
from tests.test_issue_2047 import CHUNK, GOOD, answer
from warroom import control, stage2


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


if __name__ == "__main__":
    unittest.main()
