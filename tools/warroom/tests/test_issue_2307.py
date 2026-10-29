"""Issue #2307: Stage 2 preflight and bounded local repair before PR creation."""
import json
import unittest
from pathlib import Path

from tests.test_issue_1684 import S2
from tests.test_issue_1908 import s2_world
from warroom import control, stage2


def answer(text):
    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n"


def conflict_report(fingerprint, candidates):
    rows = []
    for candidate in candidates:
        rows.append({
            "source_sense_id": "source-sense",
            "source_record_id": "source-record",
            "source_lemma": "원천",
            "source_pos": "noun",
            "source_gloss": "원천의 뜻",
            "candidate": candidate,
            "decision": {"disposition": "existing"},
            "additional_relations": [],
            "already_accounted": True,
            "target_senses": [],
            "approved_peers": [],
            "same_group_peers": [],
            "drop_gloss": [],
        })
    group = {"candidate_keys": [f"source-sense\u0000{name}" for name in candidates],
             "conflicts": [{"code": "id-pair-conflict", "message": "conflicting decisions", "relations": []}],
             "drop_gloss": [], "candidates": rows}
    return {"version": 1, "ok": False, "repairable": True, "shard": "001", "batch": "01", "part": "01",
            "fingerprint": fingerprint, "total": 1, "candidate_total": len(candidates), "problems": [group],
            "unclassified": [], "coverage": {"merge_conflicts": "complete", "drop_gloss": "complete"}}


def clean_report(fingerprint):
    return {"version": 1, "ok": True, "repairable": False, "shard": "001", "batch": "01", "part": "01",
            "fingerprint": fingerprint, "total": 0, "candidate_total": 0, "problems": [],
            "unclassified": [], "coverage": {"merge_conflicts": "complete", "drop_gloss": "complete"}}


def repair_answer(fingerprint, candidates):
    decisions = [{"source_sense_id": "source-sense", "candidate": candidate, "additional_relations": []}
                 for candidate in candidates]
    return answer(f"repair @{fingerprint}\n" + json.dumps(
        {"decisions": decisions, "peer_adjustments": [], "unresolved": []}, ensure_ascii=False))


class Stage2PreflightRepair(unittest.TestCase):
    def start_repair(self, reports, candidate_count=3):
        w = s2_world(self)
        w.git.chunk_view_total = candidate_count
        w.git.optional_candidate_after_chunk = True
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.adapter.plan.append({"code": 0, "session": "ses_chunk",
                               "text": answer("chunk 001-01-01-001\nc1 D first\nc2 D second\nc3 D third")})
        w.tick()
        batch = w.store.active_batch("claude", S2)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        links = w.adapter.launches[-1]
        self.assertEqual(w.store.batch(batch["id"])["run_kind"], "s2_links_new")
        digest = json.loads(w.store.get(stage2.links_start_key(batch["id"])))['digest']
        w.adapter.running[links["pid"]]["text"] = answer(f"links @{digest}\nc1 skip\nc2 skip\nc3 skip")
        w.adapter.running[links["pid"]]["session"] = "ses_links"
        w.git.stage2_preflight_reports.extend(reports)
        w.adapter.finish(links["pid"])
        w.tick()
        return w, w.store.batch(batch["id"])

    def test_one_fresh_repair_covers_every_candidate_in_a_conflict_group_before_pr(self):
        fingerprint = "1" * 64
        candidates = ["candidate-0", "candidate-1", "candidate-2"]
        w, batch = self.start_repair([conflict_report(fingerprint, candidates), clean_report("2" * 64)])

        self.assertEqual(batch["run_kind"], "s2_repair_new")
        repair = w.adapter.launches[-1]
        self.assertEqual(repair["kind"], "start")
        self.assertEqual(repair["stage2_chunk_git"], "1")
        self.assertEqual(repair["stage2_repair"], "1")
        self.assertEqual(repair["answer_only"], "1")
        self.assertIn(f"repair @{fingerprint}", repair["prompt"])
        self.assertEqual(w.gh.created_prs, [])
        self.assertEqual(getattr(w.git, "commits", []), [])

        w.adapter.running[repair["pid"]]["text"] = repair_answer(fingerprint, candidates)
        w.adapter.finish(repair["pid"])
        w.tick()

        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "WAITING_REVIEW", batch["error"])
        self.assertEqual(len(w.git.stage2_repair_calls), 1)
        self.assertEqual(len(w.git.stage2_repair_calls[0]["decisions"]), 3)
        self.assertEqual(len(w.git.stage2_preflight_calls), 2)
        self.assertEqual(len(w.gh.created_prs), 1)
        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        self.assertEqual(state["rounds_used"], 1)
        self.assertEqual(state["status"], "complete")

    def test_newly_exposed_conflicts_use_a_second_fresh_session(self):
        first, second = "3" * 64, "4" * 64
        reports = [conflict_report(first, ["candidate-0"]),
                   conflict_report(second, ["candidate-1"]), clean_report("5" * 64)]
        w, batch = self.start_repair(reports)
        run1 = w.adapter.launches[-1]
        w.adapter.running[run1["pid"]]["text"] = repair_answer(first, ["candidate-0"])
        w.adapter.finish(run1["pid"])
        w.tick()

        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["run_kind"], "s2_repair_new")
        run2 = w.adapter.launches[-1]
        self.assertNotEqual(run1["pid"], run2["pid"])
        self.assertEqual(run2["kind"], "start")
        self.assertIn(f"repair @{second}", run2["prompt"])
        self.assertEqual(w.gh.created_prs, [])
        w.adapter.running[run2["pid"]]["text"] = repair_answer(second, ["candidate-1"])
        w.adapter.finish(run2["pid"])
        w.tick()

        batch = w.store.batch(batch["id"])
        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        self.assertEqual((batch["state"], state["rounds_used"], len(state["history"])),
                         ("WAITING_REVIEW", 2, 2), batch["error"])
        self.assertEqual(len(w.git.stage2_repair_calls), 2)
        self.assertEqual(len(w.gh.created_prs), 1)

    def test_repeated_fingerprint_stops_without_merge_or_duplicate_repair(self):
        fingerprint = "6" * 64
        w, batch = self.start_repair([conflict_report(fingerprint, ["candidate-0"]),
                                      conflict_report(fingerprint, ["candidate-0"])])
        run = w.adapter.launches[-1]
        w.adapter.running[run["pid"]]["text"] = repair_answer(fingerprint, ["candidate-0"])
        w.adapter.finish(run["pid"])
        w.tick()

        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "ERROR")
        self.assertIn("repeated fingerprint", batch["error"])
        self.assertEqual(len(w.git.stage2_repair_calls), 1)
        self.assertEqual(w.git.stage2_merge_calls, [])
        self.assertEqual(w.gh.created_prs, [])

    def test_checkpoint_change_during_ai_run_is_preserved_and_blocks_repair(self):
        fingerprint = "7" * 64
        w, batch = self.start_repair([conflict_report(fingerprint, ["candidate-0"]), clean_report("8" * 64)])
        run = w.adapter.launches[-1]
        checkpoint = Path(batch["worktree"]) / ".warroom-scratch" / \
            "relation-admission-001-01-01.json"
        altered = json.loads(checkpoint.read_text("utf-8"))
        altered["next_chunk_number"] += 1
        checkpoint.write_text(json.dumps(altered), "utf-8")
        altered_bytes = checkpoint.read_bytes()
        w.adapter.running[run["pid"]]["text"] = repair_answer(fingerprint, ["candidate-0"])
        w.adapter.finish(run["pid"])
        w.tick()

        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "ERROR")
        self.assertIn("changed the checkpoint", batch["error"])
        self.assertEqual(checkpoint.read_bytes(), altered_bytes)
        self.assertEqual(w.git.stage2_repair_calls, [])
        self.assertEqual(w.git.stage2_merge_calls, [])
        self.assertEqual(w.gh.created_prs, [])

    def test_unrelated_decision_and_forged_receipt_cannot_cross_repair_boundary(self):
        fingerprint = "b" * 64
        w, batch = self.start_repair([conflict_report(fingerprint, ["candidate-0"]), clean_report("c" * 64)])
        run = w.adapter.launches[-1]
        w.adapter.running[run["pid"]]["text"] = repair_answer(fingerprint, ["candidate-0"])
        w.adapter.finish(run["pid"])
        state = w.sup._stage2_repair_state(batch, required=True)
        self.assertIsNotNone(w.sup._stage2_repair_response(batch, state))

        boundary = json.loads(w.store.get(stage2.repair_run_start_key(batch["id"])))
        checkpoint = Path(batch["worktree"]) / ".warroom-scratch" / \
            "relation-admission-001-01-01.json"
        altered = json.loads(checkpoint.read_text("utf-8"))
        target_keys = set(boundary["page_keys"])
        unrelated = next(
            (item, candidate) for item in altered["items"] for candidate in item["candidates"]
            if f"{item['sense_id']}\u0000{candidate['text']}" not in target_keys
        )
        item, candidate = unrelated
        candidate["decision"] = {"disposition": "drop", "reason": "forged unrelated edit"}
        altered.setdefault("repair_receipts", []).append({
            "request_id": "d" * 64, "fingerprint": fingerprint,
            "candidate_keys": boundary["page_keys"],
        })
        checkpoint.write_text(json.dumps(altered), "utf-8")

        problem = w.sup._stage2_repair_boundary_problem(w.store.batch(batch["id"]))
        self.assertIn("without its persisted Supervisor apply intent", problem)
        self.assertEqual(w.git.stage2_repair_calls, [])
        self.assertEqual(w.gh.created_prs, [])

    def test_receipt_backed_replay_survives_supervisor_restart(self):
        fingerprint = "9" * 64
        w, batch = self.start_repair([conflict_report(fingerprint, ["candidate-0"]), clean_report("a" * 64)])
        run = w.adapter.launches[-1]
        w.adapter.running[run["pid"]]["text"] = repair_answer(fingerprint, ["candidate-0"])
        w.adapter.finish(run["pid"])
        state = w.sup._stage2_repair_state(batch, required=True)
        self.assertIsNotNone(w.sup._stage2_repair_response(batch, state))

        original_apply = w.git.stage2_repair

        class SimulatedSupervisorCrash(BaseException):
            pass

        def apply_then_crash(*args, **kwargs):
            original_apply(*args, **kwargs)
            raise SimulatedSupervisorCrash()

        w.git.stage2_repair = apply_then_crash
        with self.assertRaises(SimulatedSupervisorCrash):
            w.sup._apply_stage2_repair_answer(batch, state)
        w.git.stage2_repair = original_apply
        checkpoint = Path(batch["worktree"]) / ".warroom-scratch" / "relation-admission-001-01-01.json"
        after_first_apply = json.loads(checkpoint.read_text("utf-8"))
        self.assertEqual(len(after_first_apply["repair_receipts"]), 1)

        w.sup = w.make_sup()
        recovered = w.store.batch(batch["id"])
        self.assertIsNone(w.sup._stage2_repair_boundary_problem(recovered))
        replay_state = w.sup._stage2_repair_state(recovered, required=True)
        self.assertEqual(replay_state["current"]["pending_answer"]["decisions"][0]["candidate"], "candidate-0")
        w.sup._apply_stage2_repair_answer(recovered, replay_state)

        final_checkpoint = json.loads(checkpoint.read_text("utf-8"))
        self.assertEqual(len(final_checkpoint["repair_receipts"]), 1)
        self.assertTrue(w.git.stage2_repair_results[-1]["already_applied"])
        self.assertEqual(w.store.batch(batch["id"])["state"], "WAITING_REVIEW")
        self.assertEqual(len(w.gh.created_prs), 1)

    def test_four_round_limit_preserves_checkpoint_and_does_not_launch_a_fifth_run(self):
        reports = [conflict_report(f"{i:064x}", ["candidate-0"]) for i in range(1, 6)]
        w, batch = self.start_repair(reports)
        for round_number in range(1, 5):
            run = w.adapter.launches[-1]
            fingerprint = f"{round_number:064x}"
            w.adapter.running[run["pid"]]["text"] = repair_answer(fingerprint, ["candidate-0"])
            w.adapter.finish(run["pid"])
            w.tick()
            batch = w.store.batch(batch["id"])
            if round_number < 4:
                self.assertEqual(batch["run_kind"], "s2_repair_new")

        batch = w.store.batch(batch["id"])
        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        self.assertEqual(batch["state"], "ERROR")
        self.assertIn("round limit (4)", batch["error"])
        self.assertEqual(state["rounds_used"], 4)
        self.assertEqual(len(w.git.stage2_repair_calls), 4)
        self.assertEqual(w.git.stage2_merge_calls, [])
        self.assertEqual(w.gh.created_prs, [])


if __name__ == "__main__":
    unittest.main()
