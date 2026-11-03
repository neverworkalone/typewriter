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
    def test_raw_and_single_json_fence_parse_identically_others_are_format_errors(self):
        body = valid_body()
        expected = json.loads(body)
        accepted = [f"repair @{FP}\n{body}", f"intro\nrepair @{FP}\n```json\n{body}\n```\n",
                    f"repair @{FP}\n```\n{body}\n```", f"repair @{FP}\r\n```json\r\n{body}\r\n```"]
        for text in accepted:
            with self.subTest(text=text[:40]):
                self.assertEqual(stage2.extract_repair_answer(text, FP), expected)
        rejected = [f"repair @{FP}\n", f"repair @{FP}\nHere it is:\n```json\n{body}\n```",
                    f"repair @{FP}\n```python\n{body}\n```", f"repair @{FP}\n```json\n{body}\n```\nnote",
                    f"repair @{FP}\n{body}\n{body}", f"repair @{FP}\n{body[:-5]}",
                    f"repair @{FP}\n```json\n{body}\n```\n```json\n{body}\n```",
                    f"repair @{FP}\n[1]", f"repair @{FP}\n" + json.dumps({"decisions": []})]
        for text in rejected:
            with self.subTest(text=text[:40]):
                with self.assertRaises(stage2.RepairFormatError):
                    stage2.extract_repair_answer(text, FP)
        for text in (f"repair @{'b' * 64}\n{body}", f"{body}", None):
            self.assertIsNone(stage2.extract_repair_answer(text, FP))


class RepairFormatRetry(unittest.TestCase):
    def run_text(self, w, text):
        run = w.adapter.launches[-1]
        w.adapter.running[run["pid"]]["text"] = answer(text)
        w.adapter.finish(run["pid"])
        w.tick()

    def attempts(self, w, batch):
        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        return state["current"]["attempts"], [a["status"] for a in state["current"]["attempt_log"]]

    def test_fenced_answer_succeeds_without_retry(self):
        w, batch = start_repair(self, [conflict_report(FP, CANDIDATES), clean_report("2" * 64)])
        launches = len(w.adapter.launches)
        self.run_text(w, f"repair @{FP}\n```json\n{valid_body()}\n```")
        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "WAITING_REVIEW", batch["error"])
        self.assertEqual(len(w.adapter.launches), launches)
        self.assertEqual(len(w.git.stage2_repair_calls), 1)

    def test_format_failure_retries_same_page_then_converges(self):
        for bad in ("repair @{fp}\n{trunc}", "repair @{wrong}\n{body}"):
            with self.subTest(bad=bad[:30]):
                w, batch = start_repair(self, [conflict_report(FP, CANDIDATES), clean_report("2" * 64)])
                launches = len(w.adapter.launches)
                body = valid_body()
                self.run_text(w, bad.format(fp=FP, body=body, trunc=body[:-4], wrong="c" * 64))
                batch = w.store.batch(batch["id"])
                self.assertEqual(batch["state"], "PRODUCING", batch["error"])
                self.assertEqual(len(w.adapter.launches), launches + 1)
                self.assertIn(f"repair @{FP}", w.adapter.launches[-1]["prompt"])
                self.assertEqual(w.git.stage2_repair_calls, [])
                self.assertEqual(self.attempts(w, batch), (2, ["rejected", "launched"]))
                self.run_text(w, f"repair @{FP}\n{valid_body()}")
                batch = w.store.batch(batch["id"])
                self.assertEqual(batch["state"], "WAITING_REVIEW", batch["error"])
                self.assertEqual(len(w.git.stage2_repair_calls), 1)
                self.assertEqual(len(w.adapter.launches), launches + 1)
                self.assertEqual(len(w.gh.created_prs), 1)

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
