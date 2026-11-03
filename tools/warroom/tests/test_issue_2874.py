"""Issue #2874: one candidate-bound Stage 2 repair, with a technical Drop only after it fails."""
import json
import unittest
from pathlib import Path

from tests.test_issue_1684 import S2
from tests.test_issue_1908 import s2_world
from warroom import control, stage2

CHUNK = "001-01-01-001"


def answer(text):
    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n"


class TechnicalFallback(unittest.TestCase):
    def world(self, *plans, candidates=1):
        w = s2_world(self)
        w.git.chunk_view_total = candidates
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.adapter.plan.extend(plans)
        w.tick()
        return w, w.store.active_batch("claude", S2)

    def finish(self, w, b, ticks=2):
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick(ticks)
        return w.store.batch(b["id"])

    def test_headerless_fix_is_repaired_then_only_its_failed_candidate_gets_f(self):
        w, b = self.world({"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc1 D BAD\nc2 D x")},
                          {"code": 0, "session": "s1", "text": answer("c1 R near 1 T999")}, candidates=2)
        b = self.finish(w, b, 1)
        baseline = json.loads(w.store.get(stage2.run_start_key(b["id"])) or "null")
        detail = f"chunk {CHUNK} not saved, checkpoint unchanged: 1 problem(s)\nc1 candidate-0: bad decision"
        diagnostic = {"error": b["error"], "baseline_keys": list(baseline),
                      "expected_checkpoint": baseline.get("checkpoint"),
                      "current_checkpoint": stage2.checkpoint(b["worktree"], b["shard"], b["batch"]),
                      "checkpoint_unchanged": w.sup._stage2_checkpoint_unchanged(b, CHUNK, baseline),
                      "candidate_binding": stage2.candidate_binding_from_view(
                          b["worktree"], CHUNK, "c1", baseline.get("chunk_view_sha256", "")),
                      "single_failure": stage2.single_candidate_failure_alias(detail, CHUNK)}
        self.assertEqual(b["run_kind"], "s2_chunk_fix", diagnostic)
        self.assertEqual(len([run for run in w.store.runs(b["id"]) if run["kind"] == "s2_chunk_fix"]), 1)
        b = self.finish(w, b)

        self.assertEqual(len(w.git.technical_fallback_calls), 1)
        proof = w.git.technical_fallback_calls[0]
        self.assertEqual((proof["chunk_id"], proof["alias"], proof["record_id"], proof["sense_id"],
                          proof["candidate"], proof["retry_count"]),
                         (CHUNK, "c1", "source-record", "source-sense", "candidate-0", 1))
        self.assertEqual(w.git.save_calls[-1].splitlines(), [f"chunk {CHUNK}", "c2 D x"])
        events = [event["msg"] for event in w.store.recent_events(100) if event["batch_id"] == b["id"]]
        self.assertTrue(any("header-only 결정적 복구" in event for event in events))
        self.assertTrue(any("technical Drop Fallback 저장" in event and '"drop_reason": "f"' in event for event in events))
        checkpoint_path = Path(b["worktree"]) / ".warroom-scratch" / \
            f"relation-admission-{b['shard']}-01-01.json"
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        self.assertEqual([candidate["decision"]["reason"] for candidate in checkpoint["items"][0]["candidates"]], ["f", "x"])
        self.assertEqual(len([run for run in w.store.runs(b["id"]) if run["kind"] == "s2_chunk_fix"]), 1)

    def test_multi_candidate_and_nonlocal_diagnostics_fail_closed(self):
        multi = f"chunk {CHUNK} not saved, checkpoint unchanged: 2 problem(s)\nc1 candidate-0: bad\nc2 candidate-1: bad"
        local = {"alias": "c1", "record_id": "source-record", "sense_id": "source-sense", "candidate": "candidate-0"}
        self.assertIsNone(stage2.single_candidate_failure_alias(multi, CHUNK, local))
        self.assertIsNone(stage2.single_candidate_failure_alias(
            f"chunk {CHUNK} not saved, checkpoint unchanged: 1 problem(s)\ntypes: near is invalid", CHUNK, local))
        self.assertEqual(stage2.single_candidate_failure_alias(
            f"chunk {CHUNK} not saved, checkpoint unchanged: 1 problem(s)\nc1 candidate-0: bad", CHUNK, local), "c1")

        w, b = self.world({"code": 0, "session": "s1", "text": answer(
            f"chunk {CHUNK}\nc1 D BAD\nc2 D BAD\nc99 D e")}, candidates=2)
        b = self.finish(w, b)
        self.assertEqual((b["state"], len(w.adapter.launches), w.git.technical_fallback_calls),
                         ("ERROR", 1, []))

    def test_checkpoint_drift_blocks_candidate_retry(self):
        w, b = self.world({"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc1 D BAD")})
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        checkpoint_path = Path(b["worktree"]) / f".warroom-scratch/relation-admission-{b['shard']}-01-01.json"
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        checkpoint["unexpected"] = "changed"
        checkpoint_path.write_text(json.dumps(checkpoint), "utf-8")
        w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual((b["state"], len(w.adapter.launches), w.git.technical_fallback_calls),
                         ("ERROR", 1, []))
        self.assertIn("정확히 결속하지 못해", b["error"])

    def test_retry_restores_and_rejects_changes_to_non_target_decision_rows(self):
        w, b = self.world({"code": 0, "session": "s1", "text": answer(
            f"chunk {CHUNK}\nc1 D BAD\nc2 D x")},
            {"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc1 D e")}, candidates=2)
        b = self.finish(w, b, 1)
        self.assertEqual(b["run_kind"], "s2_chunk_fix")
        decisions = Path(b["worktree"]) / stage2.DECISIONS
        initial = decisions.read_bytes()
        self.assertIn(b"c2 D x\n", initial)
        decisions.write_bytes(initial.replace(b"c2 D x\n", b"c2 D e\n"))

        b = self.finish(w, b)
        checkpoint_path = Path(b["worktree"]) / ".warroom-scratch" / \
            f"relation-admission-{b['shard']}-01-01.json"
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("Retry 중 기존 판정 파일이 바뀌어 최초 스냅샷을 복원", b["error"])
        self.assertEqual(decisions.read_bytes(), initial, "all original rows are restored before stopping")
        self.assertIsNotNone(checkpoint["pending_chunk"], "the rejected retry cannot advance the checkpoint")
        self.assertEqual(len(w.git.save_calls), 1, "no retry save runs against the changed non-target row")
        self.assertEqual(w.git.technical_fallback_calls, [])

    def test_missing_fix_output_keeps_the_single_retry_budget_across_manual_retry(self):
        w, b = self.world({"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc1 D BAD")},
                          {"code": 0, "session": "s1", "text": ""})
        b = self.finish(w, b, 1)
        self.assertEqual(b["run_kind"], "s2_chunk_fix", b["error"])
        b = self.finish(w, b)
        self.assertEqual((b["state"], len(w.adapter.launches), w.git.technical_fallback_calls), ("ERROR", 2, []))

        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        b = w.store.batch(b["id"])
        self.assertEqual((b["state"], len(w.adapter.launches), w.git.technical_fallback_calls), ("ERROR", 2, []))
        self.assertIn("후보 단위 Retry 1회", b["error"])

    def test_headerless_repair_rejects_extra_text_or_another_alias(self):
        self.assertEqual(stage2.headerless_fix_row("c190 R near 1 T579", "c190"), "c190 R near 1 T579")
        for text in ("c190 R near 1 T579\n추가 설명", "c190 R near 1 T579\nc191 D e",
                     "c189 R near 1 T579", "c190 D f"):
            with self.subTest(text=text):
                self.assertIsNone(stage2.headerless_fix_row(text, "c190"))


if __name__ == "__main__":
    unittest.main()
