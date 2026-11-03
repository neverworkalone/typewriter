"""Issue #2833: a malformed Stage 2 repair answer retries only the same page, within the persisted attempt budget."""
import json
import unittest

from tests.test_issue_2307 import answer, clean_report, conflict_report, start_repair
from warroom import stage2

FP = "a" * 64
CANDIDATES = ["candidate-0", "candidate-1"]


def valid_body(candidates=CANDIDATES):
    decisions = [{"source_sense_id": "source-sense", "candidate": c, "additional_relations": []} for c in candidates]
    return json.dumps({"decisions": decisions, "peer_adjustments": [], "unresolved": []}, ensure_ascii=False)


class RepairAnswerExtraction(unittest.TestCase):
    def test_headerless_json_and_exact_legacy_header_parse_without_accepting_near_headers(self):
        body = valid_body()
        expected = json.loads(body)
        accepted = [body, f"repair @{FP}\n{body}", f"intro\nrepair @{FP}\n```json\n{body}\n```\n",
                    f"repair @{FP}\n```\n{body}\n```", f"repair @{FP}\r\n```json\r\n{body}\r\n```"]
        for text in accepted:
            with self.subTest(text=text[:40]):
                self.assertEqual(stage2.extract_repair_answer(text, FP), expected)
        rejected = [f"repair @{FP}\n", f"repair @{FP}\nHere it is:\n```json\n{body}\n```",
                    f"repair @{FP}\n```python\n{body}\n```", f"repair @{FP}\n```json\n{body}\n```\nnote",
                    f"repair @{FP}\n{body}\n{body}", f"repair @{FP}\n{body[:-5]}",
                    f"repair @{FP}\n```json\n{body}\n```\n```json\n{body}\n```",
                    f"repair @{FP}\n[1]", f"repair @{FP}\n" + json.dumps({"decisions": []}),
                    '{"decisions":[],"peer_adjustments":[],"unresolved":[],"unresolved":[]}']
        for text in rejected:
            with self.subTest(text=text[:40]):
                with self.assertRaises(stage2.RepairFormatError):
                    stage2.extract_repair_answer(text, FP)
        for text in (f"repair @{'b' * 64}\n{body}", f"repair @{FP[:-1]}\n{body}", None):
            self.assertIsNone(stage2.extract_repair_answer(text, FP))

    def test_bound_legacy_replay_parses_body_only_after_the_supervisor_proves_the_run(self):
        body = valid_body()
        self.assertEqual(stage2.extract_bound_repair_answer(f"repair @{FP[:-1]}\n{body}"), json.loads(body))
        for text in (f"comment\nrepair @{FP[:-1]}\n{body}", f"repair @not-a-digest\n{body}",
                     f"repair @{FP[:-1]}\n{body}\nextra"):
            with self.subTest(text=text[:40]):
                with self.assertRaises(stage2.RepairFormatError):
                    stage2.extract_bound_repair_answer(text)


class RepairFormatRetry(unittest.TestCase):
    def run_text(self, w, text):
        run = w.adapter.launches[-1]
        w.adapter.running[run["pid"]]["text"] = answer(text)
        w.adapter.finish(run["pid"])
        w.tick()

    def attempts(self, w, batch):
        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        return state["current"]["attempts"], [a["status"] for a in state["current"]["attempt_log"]]

    def test_headerless_answer_succeeds_without_retry(self):
        w, batch = start_repair(self, [conflict_report(FP, CANDIDATES), clean_report("2" * 64)])
        launches = len(w.adapter.launches)
        self.run_text(w, valid_body())
        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "WAITING_REVIEW", batch["error"])
        self.assertEqual(len(w.adapter.launches), launches)
        self.assertEqual(len(w.git.stage2_repair_calls), 1)

    def test_format_feedback_retries_same_page_then_accepts_headerless_json(self):
        w, batch = start_repair(self, [conflict_report(FP, CANDIDATES), clean_report("2" * 64)])
        launches = len(w.adapter.launches)
        self.run_text(w, f"repair @{FP[:-1]}\n{valid_body()}")
        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "PRODUCING", batch["error"])
        self.assertEqual(len(w.adapter.launches), launches + 1)
        self.assertIn("header that does not match", w.adapter.launches[-1]["prompt"])
        self.assertNotIn(FP, w.adapter.launches[-1]["prompt"])
        self.assertEqual(w.git.stage2_repair_calls, [])
        self.assertEqual(self.attempts(w, batch), (2, ["rejected", "launched"]))
        self.run_text(w, valid_body())
        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "WAITING_REVIEW", batch["error"])
        self.assertEqual(len(w.git.stage2_repair_calls), 1)
        self.assertEqual(len(w.adapter.launches), launches + 1)
        self.assertEqual(len(w.gh.created_prs), 1)

    def test_operator_retry_replays_one_exact_saved_format_run_without_a_new_ai_attempt(self):
        w, batch = start_repair(self, [conflict_report(FP, CANDIDATES), clean_report("2" * 64)])
        launches = len(w.adapter.launches)
        self.run_text(w, f"repair @{'b' * 64}\n{valid_body()}")
        self.run_text(w, f"repair @{FP[:-1]}\n{valid_body()}")
        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), launches + 1)
        before = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        source = before["current"]["attempt_log"][-1]
        source_hash = source["response_sha256"]

        w.sup._relaunch_do(batch)

        after = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        self.assertEqual(w.store.batch(batch["id"])["state"], "WAITING_REVIEW")
        self.assertEqual(len(w.adapter.launches), launches + 1)
        self.assertEqual(len(w.git.stage2_repair_calls), 1)
        self.assertEqual([row["status"] for row in after["current"]["attempt_log"]],
                         ["rejected", "rejected", "applied"])
        replay = after["current"]["attempt_log"][-1]["replay_source"]
        self.assertEqual(replay["source_attempt"], source["attempt"])
        self.assertEqual(replay["source_run_id"], source["run_id"])
        self.assertEqual(replay["response_sha256"], source_hash)

    def test_saved_response_replay_rejects_a_run_id_that_does_not_match_its_output_hash(self):
        w, batch = start_repair(self, [conflict_report(FP, CANDIDATES), clean_report("2" * 64)])
        self.run_text(w, f"repair @{'b' * 64}\n{valid_body()}")
        self.run_text(w, f"repair @{FP[:-1]}\n{valid_body()}")
        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        original_run_id = state["current"]["attempt_log"][-1]["run_id"]
        state["current"]["attempt_log"][-1]["run_id"] = state["current"]["attempt_log"][0]["run_id"]
        w.store.set(stage2.repair_state_key(batch["id"]), json.dumps(state, sort_keys=True))

        handled, problem = w.sup._stage2_repair_replay_saved_format(w.store.batch(batch["id"]), state)

        self.assertTrue(handled)
        self.assertIn("cannot be rebound", problem)
        self.assertIsNone(state["current"].get("pending_answer"))
        self.assertEqual(len(w.git.stage2_repair_calls), 0)
        self.assertNotEqual(original_run_id, state["current"]["attempt_log"][-1]["run_id"])

    def test_two_format_failures_error_and_never_exceed_the_budget(self):
        w, batch = start_repair(self, [conflict_report(FP, CANDIDATES), clean_report("2" * 64)])
        launches = len(w.adapter.launches)
        self.run_text(w, f"repair @{FP}\nnot json")
        self.run_text(w, f"repair @{FP}\n```json\n{valid_body()[:-3]}\n```")
        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), launches + 1)
        self.assertEqual(self.attempts(w, batch), (2, ["rejected", "rejected"]))
        self.assertEqual((w.git.stage2_repair_calls, w.gh.created_prs), ([], []))

    def test_content_errors_are_not_retried(self):
        cases = {"foreign": valid_body(["other"]), "duplicate": valid_body(CANDIDATES + CANDIDATES[:1])}
        for name, body in cases.items():
            with self.subTest(name):
                w, batch = start_repair(self, [conflict_report(FP, CANDIDATES), clean_report("2" * 64)])
                launches = len(w.adapter.launches)
                self.run_text(w, f"repair @{FP}\n{body}")
                batch = w.store.batch(batch["id"])
                self.assertEqual(batch["state"], "ERROR")
                self.assertEqual(len(w.adapter.launches), launches)
                self.assertEqual(w.git.stage2_repair_calls, [])


if __name__ == "__main__":
    unittest.main()
