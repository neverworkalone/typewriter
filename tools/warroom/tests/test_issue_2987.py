"""Issue #2987: repair schema failures get one candidate-scoped correction within the page budget."""
import json
import re
import unittest
from pathlib import Path

from tests.test_issue_2307 import answer, clean_report, conflict_report, s2_world
from warroom import stage2

FP = "d" * 64


def repair_text(rows, *, peer_adjustments=None, unresolved=None):
    body = {"decisions": rows, "peer_adjustments": peer_adjustments or [], "unresolved": unresolved or []}
    return f"repair @{FP}\n" + json.dumps(body, ensure_ascii=False)


def accounted_row(candidate, *, extra_decision=False, relations=None):
    row = {"source_sense_id": "source-sense", "candidate": candidate,
           "additional_relations": [] if relations is None else relations}
    if extra_decision:
        row["decision"] = {"disposition": "relation", "type": "scene", "relevance": 4}
    return row


def start_repair(test, reports, candidate_count=3):
    w = s2_world(test)
    w.git.chunk_view_total = candidate_count
    w.git.optional_candidate_after_chunk = True
    from warroom import control
    from tests.test_issue_2307 import S2

    control.start(w.store, "claude", S2, "single", cfg=w.cfg)
    w.adapter.plan.append({"code": 0, "session": "ses_chunk",
                           "text": answer("chunk 001-01-01-001\nc1 D first\nc2 D second\nc3 D third")})
    w.tick()
    batch = w.store.active_batch("claude", S2)
    w.adapter.finish(w.adapter.launches[-1]["pid"])
    w.tick()
    links = w.adapter.launches[-1]
    digest = json.loads(w.store.get(stage2.links_start_key(batch["id"])))['digest']
    w.adapter.running[links["pid"]]["text"] = answer(f"links @{digest}\nc1 skip\nc2 skip\nc3 skip")
    w.adapter.running[links["pid"]]["session"] = "ses_links"
    w.git.stage2_preflight_reports.extend(reports)
    w.adapter.finish(links["pid"])
    w.tick()
    return w, w.store.batch(batch["id"])


class Stage2RepairSchemaCorrection(unittest.TestCase):
    def run_text(self, w, text):
        run = w.adapter.launches[-1]
        w.adapter.running[run["pid"]]["text"] = answer(text)
        w.adapter.finish(run["pid"])
        w.tick()

    def start(self, candidates=("candidate-0", "candidate-1", "candidate-2")):
        w, batch = start_repair(self,
            [conflict_report(FP, list(candidates)), clean_report("e" * 64)], candidate_count=len(candidates))
        return w, batch

    def test_mixed_page_prompt_declares_the_per_candidate_field_contract(self):
        w = s2_world(self)
        page = [{"candidate_keys": ["sense\u0000ordinary", "sense\u0000accounted"], "candidates": [
            {"source_sense_id": "sense", "candidate": "ordinary", "already_accounted": False},
            {"source_sense_id": "sense", "candidate": "accounted", "already_accounted": True},
        ]}]
        prompt_input = w.sup._stage2_repair_prompt_input(
            {"schema_repair": None}, page, ["sense\u0000accounted", "sense\u0000ordinary"])
        rows = {row["candidate"]: row for row in prompt_input["groups"][0]["candidates"]}
        self.assertEqual(rows["ordinary"]["required_output_fields"], ["source_sense_id", "candidate", "decision"])
        self.assertEqual(rows["ordinary"]["forbidden_output_fields"], ["additional_relations"])
        self.assertEqual(rows["accounted"]["required_output_fields"],
                         ["source_sense_id", "candidate", "additional_relations"])
        self.assertEqual(rows["accounted"]["forbidden_output_fields"], ["decision"])

    def test_invalid_already_accounted_row_gets_local_correction_and_keeps_other_rows(self):
        candidates = ["candidate-0", "candidate-1", "candidate-2"]
        w, batch = self.start(candidates)
        checkpoint = Path(batch["worktree"]) / ".warroom-scratch" / "relation-admission-001-01-01.json"
        before = checkpoint.read_bytes()
        initial = repair_text([accounted_row(candidates[0], extra_decision=True),
                               accounted_row(candidates[1], relations=[{"target_sense_id": "target-2",
                                                                       "type": "scene", "relevance": 4}]),
                               accounted_row(candidates[2])])
        self.run_text(w, initial)

        batch = w.store.batch(batch["id"])
        self.assertEqual((batch["state"], batch["run_kind"]), ("PRODUCING", "s2_repair_new"), batch["error"])
        self.assertEqual(checkpoint.read_bytes(), before)
        self.assertEqual(w.git.stage2_repair_calls, [])
        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        correction = state["current"]["response_correction"]
        self.assertEqual(correction["fingerprint"], FP)
        self.assertEqual(correction["requested_keys"], ["source-sense\u0000candidate-0"])
        self.assertEqual(correction["diagnostics"][0]["code"], "already_accounted_fields_mismatch")
        self.assertTrue(re.fullmatch(r"[a-f0-9]{64}", correction["response_sha256"]))
        self.assertEqual([row["candidate"] for row in correction["accepted_answer"]["decisions"]],
                         ["candidate-1", "candidate-2"])

        prompt = w.adapter.launches[-1]["prompt"]
        self.assertIn("repair_correction", prompt)
        self.assertIn("already_accounted_fields_mismatch", prompt)
        match = re.search(r"<<<PREFLIGHT_CASES_BEGIN>>>(.*?)<<<PREFLIGHT_CASES_END>>>", prompt, re.DOTALL)
        prompt_input = json.loads(match.group(1))
        self.assertEqual(prompt_input["repair_correction"]["candidate_keys"], ["source-sense\u0000candidate-0"])
        self.assertEqual([row["candidate"] for row in prompt_input["groups"][0]["candidates"]], ["candidate-0"])
        self.assertEqual(prompt_input["groups"][0]["candidates"][0]["forbidden_output_fields"], ["decision"])

        self.run_text(w, repair_text([accounted_row(candidates[0])]))
        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "WAITING_REVIEW", batch["error"])
        self.assertEqual(len(w.git.stage2_repair_calls), 1)
        repaired = w.git.stage2_repair_calls[0]["decisions"]
        self.assertEqual([row["candidate"] for row in repaired], candidates)
        self.assertEqual(repaired[0]["expected_decision"], {"disposition": "existing"})
        self.assertIsNone(repaired[0]["decision"])
        self.assertEqual(repaired[0]["additional_relations"], [])
        self.assertEqual(repaired[1]["additional_relations"],
                         [{"target_sense_id": "target-2", "type": "scene", "relevance": 4}])
        self.assertEqual(repaired[2]["additional_relations"], [])
        after = json.loads(checkpoint.read_text("utf-8"))
        kept = next(item for item in after["items"] if item["sense_id"] == "source-sense")["candidates"][0]
        self.assertEqual(kept["decision"], {"disposition": "existing"})

    def test_second_schema_failure_stops_without_saving_or_an_extra_attempt(self):
        w, batch = self.start()
        initial_launches = len(w.adapter.launches)
        self.run_text(w, repair_text([accounted_row("candidate-0", extra_decision=True),
                                      accounted_row("candidate-1"), accounted_row("candidate-2")]))
        self.assertEqual(len(w.adapter.launches), initial_launches + 1)
        self.run_text(w, repair_text([accounted_row("candidate-0", extra_decision=True)]))

        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "ERROR")
        self.assertIn("schema correction exhausted", batch["error"])
        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        self.assertEqual((state["current"]["attempts"],
                          [row["status"] for row in state["current"]["attempt_log"]]),
                         (2, ["rejected", "rejected"]))
        self.assertEqual(len(w.adapter.launches), initial_launches + 1)
        self.assertEqual(w.git.stage2_repair_calls, [])


if __name__ == "__main__":
    unittest.main()
