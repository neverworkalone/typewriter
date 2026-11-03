"""Issue #3044: repair only omitted candidates while preserving the same bounded page attempt."""
import copy
import hashlib
import json
import re
import unittest
from pathlib import Path

from tests.test_issue_1684 import S2
from tests.test_issue_2307 import answer, clean_report, conflict_report, start_repair
from warroom import control, stage2

FP = "4" * 64


def repair_text(fingerprint, candidates, *, unresolved=None, duplicate=None):
    names = list(candidates)
    if duplicate and names:
        names.append(names[0])
    decisions = [{"source_sense_id": "source-sense", "candidate": candidate,
                  "additional_relations": []} for candidate in names]
    body = {"decisions": decisions, "peer_adjustments": [], "unresolved": unresolved or []}
    return f"repair @{fingerprint}\n" + json.dumps(body, ensure_ascii=False)


def repair_path(batch):
    bb, pp = stage2.split_key(batch["batch"])
    return Path(batch["worktree"]) / ".warroom-scratch" / \
        f"relation-admission-{batch['shard']}-{bb}-{pp}.json"


def repair_input(prompt):
    match = re.search(r"<<<PREFLIGHT_CASES_BEGIN>>>(.*?)<<<PREFLIGHT_CASES_END>>>", prompt, re.DOTALL)
    return json.loads(match.group(1))


class Stage2RepairMissingCandidates(unittest.TestCase):
    def run_text(self, w, text):
        run = w.adapter.launches[-1]
        w.adapter.running[run["pid"]]["text"] = answer(text)
        w.adapter.finish(run["pid"])
        w.tick()

    def start(self, candidates):
        fp = FP
        w, batch = start_repair(self,
            [conflict_report(fp, list(candidates)), clean_report("5" * 64)], candidate_count=len(candidates))
        return w, batch, fp

    def test_single_and_multiple_missing_candidates_are_requested_alone_and_saved_once(self):
        cases = (
            ([f"candidate-{i}" for i in range(3)], ["candidate-0", "candidate-1"]),
            ([f"candidate-{i}" for i in range(3)], ["candidate-0"]),
            ([f"candidate-{i}" for i in range(3)], []),
        )
        for candidates, first_rows in cases:
            with self.subTest(page_size=len(candidates), first_rows=first_rows):
                w, batch, fp = self.start(candidates)
                checkpoint = repair_path(batch)
                before = checkpoint.read_bytes()
                original_launches = len(w.adapter.launches)
                first = repair_text(fp, first_rows)

                self.run_text(w, first)

                saved = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
                current = saved["current"]
                requested = sorted(set(candidates) - set(first_rows))
                correction = current["response_correction"]
                self.assertEqual(current["last_response"], first)
                self.assertEqual(correction["kind"], "coverage")
                self.assertEqual(correction["requested_keys"],
                                 [f"source-sense\u0000{name}" for name in requested])
                self.assertEqual([row["candidate"] for row in correction["accepted_answer"]["decisions"]], first_rows)
                self.assertEqual(current["attempt_log"][0]["status"], "rejected")
                self.assertEqual(current["attempt_log"][0]["reason_code"], "coverage")
                self.assertEqual(current["attempt_log"][0]["response_sha256"], correction["response_sha256"])
                self.assertEqual(checkpoint.read_bytes(), before)
                self.assertEqual(len(w.adapter.launches), original_launches + 1)
                self.assertEqual(w.git.stage2_repair_calls, [])

                repair = w.adapter.launches[-1]
                payload = repair_input(repair["prompt"])
                prompt_keys = sorted(key for group in payload["groups"] for key in group["candidate_keys"])
                self.assertEqual(prompt_keys, correction["requested_keys"])
                self.assertEqual(payload["repair_correction"]["kind"], "coverage")
                self.assertEqual(repair["stage2_repair"], "1")
                self.assertEqual(repair["stage2_chunk_git"], "1")

                w.sup = w.make_sup()  # the persisted correction and attempt budget survive Supervisor restart
                self.run_text(w, repair_text(fp, requested))

                batch = w.store.batch(batch["id"])
                saved = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
                self.assertEqual(batch["state"], "WAITING_REVIEW", batch["error"])
                self.assertEqual(len(w.git.stage2_repair_calls), 1)
                decisions = w.git.stage2_repair_calls[0]["decisions"]
                self.assertEqual([row["candidate"] for row in decisions], candidates)
                self.assertEqual([attempt["status"] for attempt in saved["current"]["attempt_log"]],
                                 ["rejected", "applied"])
                self.assertEqual(saved["current"]["attempt_log"][1]["correction_candidate_keys"],
                                 correction["requested_keys"])
                self.assertEqual([row["additional_relations"] for row in decisions], [[] for _ in candidates])
                self.assertIsNone(saved["current"].get("response_correction"))
                self.assertEqual(len([run for run in w.store.runs(batch["id"]) if run["kind"] == "s2_chunk_new"]), 1)

    def test_missing_candidates_and_schema_correction_share_one_exact_scope(self):
        candidates = ["candidate-0", "candidate-1", "candidate-2"]
        w, batch, fp = self.start(candidates)
        first_rows = [
            {"source_sense_id": "source-sense", "candidate": "candidate-0",
             "additional_relations": [], "decision": {"disposition": "relation"}},
            {"source_sense_id": "source-sense", "candidate": "candidate-1", "additional_relations": []},
        ]
        first = f"repair @{fp}\n" + json.dumps({"decisions": first_rows, "peer_adjustments": [], "unresolved": []})

        self.run_text(w, first)

        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        correction = state["current"]["response_correction"]
        expected = ["source-sense\u0000candidate-0", "source-sense\u0000candidate-2"]
        self.assertEqual(correction["kind"], "schema_and_coverage")
        self.assertEqual(correction["requested_keys"], expected)
        self.assertEqual([row["candidate"] for row in correction["accepted_answer"]["decisions"]], ["candidate-1"])
        prompt = repair_input(w.adapter.launches[-1]["prompt"])
        self.assertEqual(sorted(key for group in prompt["groups"] for key in group["candidate_keys"]), expected)
        self.assertEqual([row["code"] for row in prompt["repair_correction"]["diagnostics"]],
                         ["already_accounted_fields_mismatch", "missing_candidate"])

        self.run_text(w, repair_text(fp, ["candidate-0", "candidate-2"]))

        batch = w.store.batch(batch["id"])
        self.assertEqual(batch["state"], "WAITING_REVIEW", batch["error"])
        self.assertEqual([row["candidate"] for row in w.git.stage2_repair_calls[0]["decisions"]], candidates)

    def test_incomplete_correction_exhausts_budget_without_applying_any_row(self):
        candidates = ["candidate-0", "candidate-1", "candidate-2"]
        w, batch, fp = self.start(candidates)
        checkpoint = repair_path(batch)
        before = checkpoint.read_bytes()
        self.run_text(w, repair_text(fp, ["candidate-0"]))
        correction = repair_input(w.adapter.launches[-1]["prompt"])
        self.assertEqual(correction["repair_correction"]["candidate_keys"],
                         ["source-sense\u0000candidate-1", "source-sense\u0000candidate-2"])
        launches = len(w.adapter.launches)

        self.run_text(w, repair_text(fp, ["candidate-1"]))

        batch = w.store.batch(batch["id"])
        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        self.assertEqual(batch["state"], "ERROR")
        self.assertIn("coverage correction did not complete", batch["error"])
        self.assertEqual([row["status"] for row in state["current"]["attempt_log"]], ["rejected", "rejected"])
        self.assertEqual(state["current"]["attempts"], stage2.REPAIR_ATTEMPTS_PER_PAGE)
        self.assertEqual(len(w.adapter.launches), launches)
        self.assertEqual(w.git.stage2_repair_calls, [])
        self.assertEqual(w.gh.created_prs, [])
        self.assertEqual(checkpoint.read_bytes(), before)
        w.sup._launch_stage2_repair_page(batch)
        self.assertEqual(len(w.adapter.launches), launches)

    def test_duplicate_foreign_and_unresolved_keys_fail_closed(self):
        cases = {
            "duplicate": lambda fp: repair_text(fp, ["candidate-0"], duplicate=True),
            "foreign": lambda fp: repair_text(fp, ["candidate-0", "outside-page"]),
            "unresolved": lambda fp: f"repair @{fp}\n" + json.dumps({
                "decisions": [{"source_sense_id": "source-sense", "candidate": "candidate-0",
                               "additional_relations": []}],
                "peer_adjustments": [],
                "unresolved": [{"source_sense_id": "source-sense", "candidate": "candidate-1",
                                "reason": "needs evidence"}],
            }),
        }
        candidates = ["candidate-0", "candidate-1", "candidate-2"]
        for name, make_response in cases.items():
            with self.subTest(name=name):
                w, batch, fp = self.start(candidates)
                launches = len(w.adapter.launches)
                self.run_text(w, make_response(fp))
                saved = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
                self.assertEqual(w.store.batch(batch["id"])["state"], "ERROR")
                self.assertNotIn("response_correction", saved["current"])
                self.assertEqual(saved["current"]["attempt_log"][-1]["status"], "rejected")
                self.assertEqual(len(w.adapter.launches), launches)
                self.assertEqual(w.git.stage2_repair_calls, [])

    def test_stale_fingerprint_page_head_or_checkpoint_cannot_apply_response(self):
        candidates = ["candidate-0", "candidate-1"]
        for mutation in ("fingerprint", "page", "head", "checkpoint"):
            with self.subTest(mutation=mutation):
                w, batch, fp = self.start(candidates)
                self.run_text(w, repair_text(fp, ["candidate-0"]))
                state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
                if mutation == "fingerprint":
                    state["current"]["fingerprint"] = "6" * 64
                elif mutation == "page":
                    state["current"]["response_correction"]["page_keys"] = ["other-sense\u0000other"]
                elif mutation == "head":
                    w.git.local_head = "7" * 40
                else:
                    checkpoint = repair_path(batch)
                    data = json.loads(checkpoint.read_text("utf-8"))
                    data["next_chunk_number"] += 1
                    checkpoint.write_text(json.dumps(data), "utf-8")
                if mutation in {"fingerprint", "page"}:
                    w.store.set(stage2.repair_state_key(batch["id"]), json.dumps(state, sort_keys=True))
                self.run_text(w, repair_text(fp, ["candidate-1"]))
                self.assertEqual(w.store.batch(batch["id"])["state"], "ERROR")
                self.assertEqual(w.git.stage2_repair_calls, [])
                self.assertEqual(w.gh.created_prs, [])

    def test_operator_retry_replays_legacy_missing_response_without_resetting_page_or_budget(self):
        candidates = ["candidate-0", "candidate-1", "candidate-2"]
        w, batch, fp = self.start(candidates)
        old_run = w.adapter.launches[-1]
        first = repair_text(fp, ["candidate-0"])
        w.adapter.running[old_run["pid"]]["text"] = answer(first)
        w.adapter.finish(old_run["pid"])
        w.store.finish_runs(batch["id"], "0")
        run = w.store.runs(batch["id"])[0]
        error = "repair response does not cover every requested candidate (2 missing)"
        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        attempt = state["current"]["attempt_log"][-1]
        attempt.update({"status": "rejected", "rejection_version": 1, "reason_code": "content",
                        "response_sha256": hashlib.sha256(first.encode()).hexdigest(),
                        "error_sha256": hashlib.sha256(error.encode()).hexdigest(),
                        "rejected_at": w.now, "run_exit_status": "0", "run_ended_at": run["ended_at"]})
        state["current"]["last_response"] = first
        state["current"]["last_error"] = error
        w.store.set(stage2.repair_state_key(batch["id"]), json.dumps(state, sort_keys=True))
        w.store.update(batch["id"], pid=None, state="ERROR", paused_from="PRODUCING",
                       error=f"Stage 2 repair answer rejected; no checkpoint change was made: {error}")
        before_attempt = copy.deepcopy(attempt)
        before_checkpoint = repair_path(batch).read_bytes()
        primary_runs = len([row for row in w.store.runs(batch["id"]) if row["kind"] == "s2_chunk_new"])

        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick()  # operator Retry returns this Part to PRODUCING
        w.tick()  # revalidate the persisted response, then launch only its missing candidate keys

        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        correction = state["current"]["response_correction"]
        self.assertEqual(correction["requested_keys"], ["source-sense\u0000candidate-1", "source-sense\u0000candidate-2"])
        self.assertTrue(correction["source_replayed"])
        self.assertEqual(state["current"]["attempt_log"][0], before_attempt)
        self.assertEqual(state["current"]["attempts"], 2)
        self.assertEqual(repair_path(batch).read_bytes(), before_checkpoint)
        self.assertEqual(len([row for row in w.store.runs(batch["id"]) if row["kind"] == "s2_chunk_new"]), primary_runs)
        self.assertEqual(sorted(key for group in repair_input(w.adapter.launches[-1]["prompt"])["groups"]
                                for key in group["candidate_keys"]), correction["requested_keys"])

        self.run_text(w, repair_text(fp, ["candidate-1", "candidate-2"]))

        batch = w.store.batch(batch["id"])
        state = json.loads(w.store.get(stage2.repair_state_key(batch["id"])))
        self.assertEqual(batch["state"], "WAITING_REVIEW", batch["error"])
        self.assertEqual([row["candidate"] for row in w.git.stage2_repair_calls[0]["decisions"]], candidates)
        self.assertEqual([row["status"] for row in state["current"]["attempt_log"]], ["rejected", "applied"])
        self.assertEqual(state["current"]["attempt_log"][1]["correction_response_sha256"],
                         hashlib.sha256(first.encode()).hexdigest())
        self.assertEqual(len([row for row in w.store.runs(batch["id"]) if row["kind"] == "s2_chunk_new"]), primary_runs)


if __name__ == "__main__":
    unittest.main()
