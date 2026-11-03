"""Issue #2991: reconcile one legacy failed Repair attempt only from its exact run evidence."""
import hashlib
import json
import unittest

from tests.test_issue_2982 import (_mark_integrated, _world, clean_report)
from warroom import stage2

FP = "9" * 64
KEY = "source-sense\u0000candidate-0"
ERROR_PREFIX = "Stage 2 repair answer rejected; no checkpoint change was made:"


def _answer(fingerprint=FP, *, valid=False):
    row = {"source_sense_id": "source-sense", "candidate": "candidate-0"}
    if valid:
        row["additional_relations"] = []
    body = {"decisions": [row], "peer_adjustments": [], "unresolved": []}
    return f"repair @{fingerprint}\n" + json.dumps(body, ensure_ascii=False)


def _log_run(w, b, text, ordinal, *, finish=True):
    log = w.paths.logs / f"legacy-repair-{ordinal}.log"
    exit_file = w.paths.logs / f"legacy-repair-{ordinal}.exit"
    log.write_text(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n",
                   "utf-8")
    run_id = w.store.add_run(b["id"], "s2_repair_new", f"session-{ordinal}", 1000 + ordinal,
                             log, exit_file, model="test-model", effort="high")
    if finish:
        w.store.finish_runs(b["id"], "0")
    return run_id


def _attempt(status, number):
    row = {"cursor": 0, "attempt": number, "fingerprint": FP, "target_keys": [KEY], "status": status}
    if status == "applied":
        row["receipt"] = "2" * 64
    return row


def _legacy_world(test, statuses=("launched", "applied"), *, error_event=True, duplicate_run=False):
    w, b, checkpoint = _world(test, total=1)
    state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
    state["current"]["fingerprint"] = FP
    state["history"][-1]["fingerprint"] = FP
    state["current"]["attempt_log"] = [_attempt(status, i + 1) for i, status in enumerate(statuses)]
    state["current"]["target_keys"] = [KEY]
    state["current"]["groups"][0]["candidate_keys"] = [KEY]
    state["history"][-1]["target_keys"] = [KEY]
    state["history"][-1]["applied_candidate_keys"] = [KEY]
    state["current"]["applied_candidate_keys"] = [KEY]
    w.store.set(stage2.repair_state_key(b["id"]), json.dumps(state, sort_keys=True))

    data = json.loads(checkpoint.read_text("utf-8"))
    data["repair_receipts"][-1].update({"fingerprint": FP, "candidate_keys": [KEY]})
    checkpoint.write_text(json.dumps(data), "utf-8")
    w.store.set(stage2.repair_run_start_key(b["id"]), json.dumps({
        "branch": b["branch"], "worktree": str(b["worktree"]), "head": "a" * 40,
        "remote_head": None, "checkpoint_sha256": hashlib.sha256(b"before-repair").hexdigest(),
        "fingerprint": FP, "cursor": 0, "page_keys": [KEY],
    }, sort_keys=True))

    ordinal = 0
    for status in statuses:
        ordinal += 1
        is_legacy_failure = status == "launched"
        _log_run(w, b, _answer(valid=not is_legacy_failure), ordinal)
        if is_legacy_failure and error_event:
            w.store.log(b["id"], f"{ERROR_PREFIX} source-sense/candidate-0 must return a complete optional-link list",
                        level="error")
    if duplicate_run:
        ordinal += 1
        _log_run(w, b, _answer(valid=True), ordinal)

    _mark_integrated(w, b)
    w.git.stage2_preflight_reports.append(clean_report())
    return w, w.store.batch(b["id"]), checkpoint


class LegacyRepairAttemptReconciliation(unittest.TestCase):
    def test_proves_one_legacy_schema_rejection_then_rebinds_from_the_later_receipt(self):
        w, b, checkpoint = _legacy_world(self)
        checkpoint_before = checkpoint.read_bytes()
        state_before = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        rejected_response = _answer(valid=False)

        stopped = w.sup._stage2_preflight_repair(
            b, stage2.checkpoint(b["worktree"], b["shard"], b["batch"]))

        self.assertFalse(stopped, w.store.batch(b["id"])["error"])
        state_after = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        failed, applied = state_after["current"]["attempt_log"]
        self.assertEqual([failed["status"], applied["status"]], ["rejected", "applied"])
        self.assertEqual(failed["reason_code"], "schema")
        self.assertEqual(failed["response_sha256"], hashlib.sha256(rejected_response.encode()).hexdigest())
        self.assertEqual(failed["error_sha256"], hashlib.sha256(
            b"source-sense/candidate-0 must return a complete optional-link list").hexdigest())
        self.assertEqual(failed["reconciliation"]["source"], "legacy_run_ledger")
        self.assertEqual(len(failed["reconciliation"]["proof_sha256"]), 64)
        self.assertEqual(state_after["rounds_used"], state_before["rounds_used"])
        self.assertEqual(state_after["history"][0]["target_keys"], state_before["history"][0]["target_keys"])
        self.assertEqual(state_after["history"][0]["applied_candidate_keys"],
                         state_before["history"][0]["applied_candidate_keys"])
        self.assertEqual(len(state_after["rebindings"]), 1)
        self.assertEqual(state_after["identity"]["base_head"], "b" * 40)
        self.assertEqual(checkpoint.read_bytes(), checkpoint_before)
        self.assertEqual(w.adapter.launches, [])
        self.assertEqual(w.git.stage2_repair_calls, [])

        # Re-entry after a restart sees the already-recorded reconciliation and does not append a second rebind.
        w.git.stage2_preflight_reports.append(clean_report())
        self.assertFalse(w.sup._stage2_preflight_repair(
            w.store.batch(b["id"]), stage2.checkpoint(b["worktree"], b["shard"], b["batch"])))
        state_restarted = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        self.assertEqual(len(state_restarted["rebindings"]), 1)

    def test_ambiguous_or_incomplete_legacy_evidence_stays_fail_closed(self):
        cases = (
            ("two_legacy_failures", ("launched", "launched", "applied"), True, False, False),
            ("missing_validation_event", ("launched", "applied"), False, False, False),
            ("duplicate_run", ("launched", "applied"), True, True, False),
            ("running_process", ("launched", "applied"), True, False, True),
        )
        for name, statuses, error_event, duplicate_run, running in cases:
            with self.subTest(name=name):
                w, b, checkpoint = _legacy_world(self, statuses, error_event=error_event,
                                                  duplicate_run=duplicate_run)
                if running:
                    w.store.update(b["id"], pid=4321)
                    b = w.store.batch(b["id"])
                before_state = w.store.get(stage2.repair_state_key(b["id"]))
                before_checkpoint = checkpoint.read_bytes()

                stopped = w.sup._stage2_preflight_repair(
                    b, stage2.checkpoint(b["worktree"], b["shard"], b["batch"]))

                self.assertTrue(stopped)
                self.assertEqual(w.store.batch(b["id"])["state"], "ERROR")
                self.assertEqual(w.store.get(stage2.repair_state_key(b["id"])), before_state)
                self.assertEqual(checkpoint.read_bytes(), before_checkpoint)
                self.assertEqual(w.git.stage2_repair_calls, [])


class RepairRejectionReasonCodes(unittest.TestCase):
    def _record_response(self, test, response, *, already_accounted=False):
        w, b, _checkpoint = _world(test, total=1)
        state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        state["current"]["fingerprint"] = FP
        state["history"][-1]["fingerprint"] = FP
        candidate = state["current"]["groups"][0]["candidates"][0]
        candidate["already_accounted"] = already_accounted
        candidate["decision"] = {"disposition": "existing" if already_accounted else "drop"}
        state["current"]["attempt_log"] = [_attempt("launched", 1)]
        w.store.set(stage2.repair_state_key(b["id"]), json.dumps(state, sort_keys=True))

        log = w.paths.logs / "repair-response.log"
        log.write_text(json.dumps({"type": "item.completed", "item": {
            "type": "agent_message", "text": response}}) + "\n", "utf-8")
        exit_file = w.paths.logs / "repair-response.exit"
        run_id = w.store.add_run(b["id"], "s2_repair_new", "session-response", 5555,
                                 log, exit_file, model="test-model", effort="high")
        w.store.finish_runs(b["id"], "0")
        w.store.update(b["id"], log_file=str(log), run_kind="s2_repair_new", state="PRODUCING")
        return w, w.store.batch(b["id"]), run_id

    def test_format_schema_unresolved_and_content_rejections_are_distinguished(self):
        key = {"source_sense_id": "source-sense", "candidate": "candidate-0"}
        rows = {
            "format": "wrong header\nnot a repair object",
            "schema": f"repair @{FP}\n" + json.dumps({"decisions": [key | {"decision": {}}],
                "peer_adjustments": [], "unresolved": []}),
            "unresolved": f"repair @{FP}\n" + json.dumps({"decisions": [], "peer_adjustments": [],
                "unresolved": [key | {"reason": "needs source evidence"}]}),
            "content": f"repair @{FP}\n" + json.dumps({"decisions": [key | {"candidate": "outside-page",
                "additional_relations": []}], "peer_adjustments": [], "unresolved": []}),
        }
        for expected, response in rows.items():
            with self.subTest(reason=expected):
                w, b, run_id = self._record_response(self, response, already_accounted=expected == "schema")
                state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
                if expected == "format":
                    self.assertIsNone(w.sup._stage2_repair_response(b, state))
                else:
                    with self.assertRaises(ValueError):
                        w.sup._stage2_repair_response(b, state)
                saved = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
                attempt = saved["current"]["attempt_log"][-1]
                self.assertEqual(attempt["status"], "rejected")
                self.assertEqual(attempt["reason_code"], expected)
                self.assertEqual(attempt["run_id"], run_id)
                self.assertEqual(attempt["run_exit_status"], "0")
                self.assertRegex(attempt["response_sha256"], r"^[a-f0-9]{64}$")
                self.assertRegex(attempt["error_sha256"], r"^[a-f0-9]{64}$")

    def test_missing_final_output_remains_unfinished(self):
        w, b, _run_id = self._record_response(self, None)
        state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))

        self.assertIsNone(w.sup._stage2_repair_response(b, state))

        saved = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        attempt = saved["current"]["attempt_log"][-1]
        self.assertEqual(attempt["status"], "launched")
        self.assertNotIn("rejection_version", attempt)
        self.assertIsNone(saved["current"]["last_response"])


if __name__ == "__main__":
    unittest.main()
