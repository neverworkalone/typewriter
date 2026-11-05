"""Issue #3640: recover only exact, reverse-covered Stage 2 ID-pair conflicts."""
import json
import unittest
from pathlib import Path

from tests.test_issue_2982 import _mark_integrated, _world, clean_report
from warroom import stage2


FINGERPRINT = "1" * 64
SOURCE_SENSE = "source-sense"
TARGET_SENSE = "target-sense"
CANDIDATE = "candidate-0"
KEY = f"{SOURCE_SENSE}\u0000{CANDIDATE}"


def _relation(source_sense, source_record, source_lemma, target_sense, target_record, target_lemma,
              *, forms=(), reverse_forms=()):
    return {
        "source_record_id": source_record, "source_sense_id": source_sense,
        "target_record_id": target_record, "target_sense_id": target_sense,
        "type": "near", "relevance": 2, "reverse_type": "near", "reverse_relevance": 2,
        "candidate_assignment_version": 1, "candidate_forms": list(forms),
        "reverse_candidate_forms": list(reverse_forms),
        "source": {"record_id": source_record, "sense_id": source_sense, "lemma": source_lemma,
                   "pos": "noun", "gloss": "source gloss"},
        "target": {"record_id": target_record, "sense_id": target_sense, "lemma": target_lemma,
                   "pos": "noun", "gloss": "target gloss"},
    }


def duplicate_report(*, already_accounted=False, reverse_candidate=CANDIDATE):
    existing = _relation(TARGET_SENSE, "target-record", CANDIDATE,
                         SOURCE_SENSE, "source-record", "source-lemma")
    proposed = _relation(SOURCE_SENSE, "source-record", "source-lemma",
                         TARGET_SENSE, "target-record", CANDIDATE, forms=[CANDIDATE])
    if reverse_candidate != CANDIDATE:
        existing["source"]["lemma"] = reverse_candidate
    decision = ({"source_sense_id": SOURCE_SENSE, "candidate": CANDIDATE, "disposition": "existing"}
                if already_accounted else {
                    "source_sense_id": SOURCE_SENSE, "candidate": CANDIDATE, "disposition": "relation",
                    "type": "near", "relevance": 2, "target_resolution": "exact",
                    "target_record_id": "target-record", "target_sense_id": TARGET_SENSE,
                })
    optional = ([
        {"source_sense_id": SOURCE_SENSE, "candidate": CANDIDATE, "disposition": "relation",
         "type": "association", "relevance": 3, "target_resolution": "exact",
         "target_record_id": "target-record", "target_sense_id": TARGET_SENSE},
        {"source_sense_id": SOURCE_SENSE, "candidate": CANDIDATE, "disposition": "relation",
         "type": "scene", "relevance": 4, "target_resolution": "exact",
         "target_record_id": "other-record", "target_sense_id": "other-sense"},
    ] if already_accounted else None)
    candidate = {
        "source_sense_id": SOURCE_SENSE, "source_record_id": "source-record", "source_lemma": "source-lemma",
        "source_pos": "noun", "source_gloss": "source gloss", "candidate": CANDIDATE,
        "decision": decision, "additional_relations": optional, "already_accounted": already_accounted,
        "target_senses": [{"record_id": "target-record", "lemma": CANDIDATE,
                           "sense_id": TARGET_SENSE, "pos": "noun", "gloss": "target gloss"}],
        "approved_peers": [], "same_group_peers": [], "drop_gloss": [],
    }
    conflict = {"code": "id-pair-conflict", "candidate_keys": [KEY],
                "relations": [existing, proposed], "message": "duplicate pair"}
    return {
        "version": 1, "type_tier_policy": "source-mirror-v1", "ok": False, "repairable": True,
        "shard": "003", "batch": "01", "part": "05", "fingerprint": FINGERPRINT,
        "total": 1, "candidate_total": 1, "problems": [
            {"candidate_keys": [KEY], "conflicts": [conflict], "drop_gloss": [], "candidates": [candidate]},
        ], "unclassified": [], "coverage": {"merge_conflicts": "complete", "drop_gloss": "complete"},
    }


def prepare_world(test, report, *, already_accounted=False):
    w, b, checkpoint = _world(test)
    data = json.loads(checkpoint.read_text("utf-8"))
    candidate = data["items"][0]["candidates"][0]
    row = report["problems"][0]["candidates"][0]
    candidate["decision"] = row["decision"]
    if already_accounted:
        candidate["already_accounted"] = True
        candidate["additional_relations"] = row["additional_relations"]
    checkpoint.write_text(json.dumps(data), "utf-8")

    keys = sorted(f"{r['source_sense_id']}\u0000{r['candidate']}" for r in report["problems"][0]["candidates"])
    w.git.stage2_repair_checker = lambda _repair: {
        "version": 1, "ok": True, "already_applied": False, "repaired": 1,
        "request_id": "c" * 64, "candidate_keys": keys, "normalized": [], "invalid_candidates": [],
    }
    _mark_integrated(w, b)
    w.git.stage2_preflight_reports.extend([report, clean_report()])
    return w, b, checkpoint


class DuplicateIdPairFallback(unittest.TestCase):
    def test_exact_reverse_projected_primary_pair_uses_drop_e_and_clears_preflight(self):
        report = duplicate_report()
        w, b, checkpoint = prepare_world(self, report)

        stopped = w.sup._stage2_preflight_repair(b, stage2.checkpoint(b["worktree"], b["shard"], b["batch"]))

        self.assertFalse(stopped, w.store.batch(b["id"])["error"])
        self.assertEqual(w.store.batch(b["id"])["state"], "PRODUCING")
        self.assertEqual(len(w.git.stage2_preflight_calls), 2)
        self.assertEqual(len(w.git.stage2_repair_check_calls), 1)
        self.assertEqual(len(w.git.stage2_repair_calls), 1)
        self.assertEqual(w.git.stage2_repair_calls[0]["decisions"][0]["decision"], {
            "source_sense_id": SOURCE_SENSE, "candidate": CANDIDATE, "disposition": "drop", "reason": "e",
        })
        saved = json.loads(checkpoint.read_text("utf-8"))
        self.assertEqual(saved["items"][0]["candidates"][0]["decision"], {
            "source_sense_id": SOURCE_SENSE, "candidate": CANDIDATE, "disposition": "drop", "reason": "e",
        })
        state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        self.assertEqual(state["current"]["duplicate_pair_fallback"]["status"], "verified")
        self.assertTrue(state["history"][-1]["resolved"])
        self.assertEqual(state["history"][-1]["duplicate_pair_fallback"]["candidate_keys"], [KEY])

    def test_accounted_primary_is_preserved_and_only_conflicting_optional_pair_is_removed(self):
        report = duplicate_report(already_accounted=True)
        w, b, checkpoint = prepare_world(self, report, already_accounted=True)
        original_decision = report["problems"][0]["candidates"][0]["decision"]
        unrelated = report["problems"][0]["candidates"][0]["additional_relations"][1]

        stopped = w.sup._stage2_preflight_repair(b, stage2.checkpoint(b["worktree"], b["shard"], b["batch"]))

        self.assertFalse(stopped, w.store.batch(b["id"])["error"])
        saved = json.loads(checkpoint.read_text("utf-8"))["items"][0]["candidates"][0]
        self.assertEqual(saved["decision"], original_decision)
        self.assertEqual(saved["additional_relations"], [unrelated])
        repair = w.git.stage2_repair_calls[0]["decisions"][0]
        self.assertIsNone(repair["decision"])
        self.assertEqual(repair["additional_relations"], [unrelated])

    def test_missing_reverse_candidate_projection_stays_fail_closed(self):
        report = duplicate_report(reverse_candidate="different-form")
        w, b, checkpoint = prepare_world(self, report)
        before = checkpoint.read_bytes()
        w.git.stage2_preflight_reports = [report]

        stopped = w.sup._stage2_preflight_repair(b, stage2.checkpoint(b["worktree"], b["shard"], b["batch"]))

        self.assertTrue(stopped)
        self.assertIn("repeated fingerprint", w.store.batch(b["id"])["error"])
        self.assertEqual(checkpoint.read_bytes(), before)
        self.assertEqual(w.git.stage2_repair_check_calls, [])
        self.assertEqual(w.git.stage2_repair_calls, [])

    def test_repair_prompt_explains_reverse_pair_resolution_and_preservation(self):
        prompt = Path(__file__).resolve().parents[1] / "prompts" / "s2_repair.md"
        text = prompt.read_text("utf-8")
        self.assertIn("id-pair-conflict", text)
        self.assertIn("remove only the optional link(s)", text)
        self.assertIn("mark the case unresolved rather than guessing", text)


if __name__ == "__main__":
    unittest.main()
