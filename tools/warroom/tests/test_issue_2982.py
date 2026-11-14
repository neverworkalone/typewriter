"""Issue #2982: rebind completed Stage 2 Repair state only after a proven master integration."""
import hashlib
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.test_issue_1684 import S2, s2_world
from tests.fakes import HEAD1, HEAD2
from warroom import stage2
from warroom.gitops import Git
from warroom.shell import Runner


OLD_FINGERPRINT = "1" * 64
RECEIPT_ID = "2" * 64
REPAIR_NONCE = "3" * 64


def clean_report(shard="003", batch="01", part="05", fingerprint="4" * 64):
    return {"version": 1, "ok": True, "repairable": False, "shard": shard, "batch": batch, "part": part,
            "fingerprint": fingerprint, "total": 0, "candidate_total": 0, "problems": [],
            "unclassified": [], "coverage": {"merge_conflicts": "complete", "drop_gloss": "complete"}}


def conflict_report(fingerprint, candidate="candidate-1", shard="003", batch="01", part="05"):
    key = f"source-sense\u0000{candidate}"
    candidate_row = {"source_sense_id": "source-sense", "candidate": candidate, "decision": {"disposition": "drop"},
                     "additional_relations": [], "already_accounted": True, "same_group_peers": []}
    group = {"candidate_keys": [key], "conflicts": [{"code": "id-pair-conflict", "message": "conflict", "relations": []}],
             "drop_gloss": [], "candidates": [candidate_row]}
    return {"version": 1, "ok": False, "repairable": True, "shard": shard, "batch": batch, "part": part,
            "fingerprint": fingerprint, "total": 1, "candidate_total": 1, "problems": [group],
            "unclassified": [], "coverage": {"merge_conflicts": "complete", "drop_gloss": "complete"}}


def _checkpoint_path(worktree):
    return Path(worktree) / ".warroom-scratch" / "relation-admission-003-01-05.json"


def _checkpoint(worktree, total=1, *, ready_premerge=True):
    items = [{"sense_id": "source-sense", "candidates": [
        {"text": f"candidate-{i}", "decision": {"disposition": "drop", "reason": "e"}}
        for i in range(total)
    ]}]
    premerge = {"status": "ready", "identity": "003/01/05", "relations": {"exists": False, "sha256": None},
                "drops": {"exists": False, "sha256": None}, "relation_diff": None} if ready_premerge else None
    path = _checkpoint_path(worktree)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "version": 1, "shard": "003", "batch": "01", "part": "05", "complete": True,
        "next_chunk_number": 8, "pending_chunk": None, "merged": False, "base_revision": HEAD1,
        "optional_review_complete": True, "optional_review_digest": "5" * 64,
        "optional_review_state_sha256": "6" * 64, "items": items, "premerge": premerge,
        "repair_receipts": [],
    }), "utf-8")
    return path


def _completed_state(w, b, old_head=HEAD1):
    path = _checkpoint_path(b["worktree"])
    data = json.loads(path.read_text("utf-8"))
    key = "source-sense\u0000candidate-0"
    data["repair_receipts"] = [{"request_id": RECEIPT_ID, "fingerprint": OLD_FINGERPRINT,
                                "supervisor_nonce": REPAIR_NONCE, "candidate_keys": [key]}]
    path.write_text(json.dumps(data), "utf-8")
    state = {
        "version": 1,
        "identity": {"branch": b["branch"], "worktree": str(b["worktree"]),
                     "base_head": old_head, "remote_head": None},
        "rounds_used": 1,
        "history": [{"round": 1, "fingerprint": OLD_FINGERPRINT, "target_keys": [key],
                     "applied_candidate_keys": [key], "resolved": False}],
        "status": "active",
        "current": {
            "fingerprint": OLD_FINGERPRINT,
            "groups": [{"candidate_keys": [key], "conflicts": [], "candidates": [
                {"source_sense_id": "source-sense", "candidate": "candidate-0", "same_group_peers": []}
            ]}],
            "cursor": 1, "attempts": 0, "target_keys": [key], "pending_answer": None,
            "applied_candidate_keys": [key], "attempt_log": [{"cursor": 0, "attempt": 1,
                "fingerprint": OLD_FINGERPRINT, "target_keys": [key], "status": "applied", "receipt": RECEIPT_ID}],
            "last_receipt": RECEIPT_ID,
        },
    }
    w.store.set(stage2.repair_state_key(b["id"]), json.dumps(state, sort_keys=True))
    w.store.set(stage2.repair_run_start_key(b["id"]), json.dumps({
        "branch": b["branch"], "worktree": str(b["worktree"]), "head": old_head, "remote_head": None,
        "checkpoint_sha256": hashlib.sha256(b"before-repair").hexdigest(),
        "fingerprint": OLD_FINGERPRINT, "cursor": 0, "page_keys": [key],
    }, sort_keys=True))
    return state


def _world(test, total=1):
    w = s2_world(test)
    branch = "s2-codex-003-01-05"
    wt = w.paths.worktrees / branch
    w.git.create_worktree(wt, branch, HEAD1)
    batch_id = w.store.create_batch(method=S2, producer="codex", shard="003", batch="01-05", branch=branch,
                                    worktree=str(wt), model_tier="free", run_kind="s2_deterministic_finalize")
    w.store.update(batch_id, state="PRODUCING", run_kind="s2_deterministic_finalize")
    b = w.store.batch(batch_id)
    w.git.local_head = HEAD1
    path = _checkpoint(wt, total=total)
    _completed_state(w, b)
    w.store.set(f"s2_relation_change_point_{b['id']}", HEAD1)
    return w, b, path


def _mark_integrated(w, b, *, old=HEAD1, new=HEAD2):
    w.git.base_sha = new
    w.git.local_head = new
    w.git.integrated.append((b["worktree"], new))
    w.git.ancestor_pairs.update({(old, new), (HEAD1, new)})
    w.store.set(f"s2_finalize_base_{b['id']}", new)
    w.git.stage2_prepare_merge(Path(b["worktree"]), b["shard"], "01", "05", refresh=True)


class Stage2RepairRebind(unittest.TestCase):
    def test_complete_part_rebinds_after_supervisor_master_merge_and_reaches_pr_without_repair_rerun(self):
        w, b, path = _world(self, total=2)
        w.git.base_sha = HEAD2
        w.git.integrate_updates_head = True
        w.git.ancestor_pairs.add((HEAD1, HEAD2))
        w.git.stage2_preflight_reports.append(clean_report())

        w.sup._stage2_finalize_do(b)

        saved = w.store.batch(b["id"])
        state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        checkpoint = json.loads(path.read_text("utf-8"))
        self.assertEqual((saved["state"], len(w.gh.created_prs)), ("WAITING_REVIEW", 1), saved["error"])
        self.assertEqual(w.adapter.launches, [])
        self.assertEqual(w.git.stage2_repair_calls, [])
        self.assertEqual(len(w.git.stage2_preflight_calls), 1)
        self.assertEqual(len(w.git.integration_proof_calls), 1)
        self.assertEqual((state["rounds_used"], len(state["history"])), (1, 1))
        self.assertEqual(state["history"][0]["fingerprint"], OLD_FINGERPRINT)
        self.assertEqual(state["history"][0]["target_keys"], ["source-sense\u0000candidate-0"])
        self.assertEqual(state["history"][0]["applied_candidate_keys"], ["source-sense\u0000candidate-0"])
        self.assertEqual(state["identity"]["base_head"], HEAD2)
        self.assertEqual(len(state["rebindings"]), 1)
        self.assertEqual((checkpoint["merged"], checkpoint["optional_review_complete"],
                          checkpoint["optional_review_digest"], checkpoint["optional_review_state_sha256"]),
                         (True, True, "5" * 64, "6" * 64))
        self.assertEqual(sum(len(item["candidates"]) for item in checkpoint["items"]), 2)
        self.assertEqual(len(checkpoint["repair_receipts"]), 1)

    def test_repair_rebind_accepts_maintainer_retargeted_run_start_without_finalize_base(self):
        # Issue #6601: a Maintainer integration during a Repair run moves only the Repair run-start baseline.
        w, b, path = _world(self, total=2)
        state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        state["history"][0]["base_head"] = HEAD1
        w.store.set(stage2.repair_state_key(b["id"]), json.dumps(state, sort_keys=True))
        start = json.loads(w.store.get(stage2.repair_run_start_key(b["id"])))
        w.store.set(stage2.repair_run_start_key(b["id"]), json.dumps({**start, "head": HEAD2}, sort_keys=True))
        w.git.base_sha = HEAD2
        w.git.local_head = HEAD2
        w.git.integrated.append((b["worktree"], HEAD2))
        w.git.ancestor_pairs.update({(HEAD1, HEAD2)})
        w.git.stage2_prepare_merge(Path(b["worktree"]), b["shard"], "01", "05", refresh=True)
        self.assertIsNone(w.store.get(f"s2_finalize_base_{b['id']}"))

        checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
        self.assertIsNone(w.sup._stage2_repair_rebind_problem(b, state, checkpoint, "7" * 64))
        self.assertEqual(state["identity"]["base_head"], HEAD2)
        self.assertEqual(len(state["rebindings"]), 1)

    def test_repair_rebind_still_rejects_unrelated_head_without_any_baseline(self):
        w, b, path = _world(self, total=2)
        state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        w.git.local_head = HEAD2
        checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
        self.assertIn("finalization HEAD baseline", w.sup._stage2_repair_rebind_problem(b, state, checkpoint, "7" * 64))

    def _stale_unresolved_world(self):
        # Issue #6601: a rejected-unresolved page never applied; a later clean preflight and master integration moved HEAD.
        w, b, path = _world(self, total=2)
        state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        cur = state["current"]
        cur["groups"].append({"candidate_keys": ["s2\0x"], "conflicts": [], "candidates": []})
        cur["attempt_log"].append({"cursor": 1, "attempt": 1, "fingerprint": OLD_FINGERPRINT, "target_keys": ["s2\0x"],
                                   "status": "rejected", "reason_code": "unresolved"})
        cur["last_error"] = "unresolved: s2/x"
        w.store.set(stage2.repair_state_key(b["id"]), json.dumps(state, sort_keys=True))
        _mark_integrated(w, b)
        return w, b, state

    def test_stale_unresolved_page_rebinds_and_closes_when_preflight_is_clean(self):
        w, b, state = self._stale_unresolved_world()
        checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
        self.assertIsNone(w.sup._stage2_repair_rebind_problem(b, state, checkpoint, "7" * 64))
        saved = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        self.assertEqual(saved["identity"]["base_head"], HEAD2)
        self.assertEqual((saved["current"]["cursor"], len(saved["current"]["groups"])), (0, 0))
        self.assertEqual(saved["current"]["abandoned"]["cursor"], 1)
        self.assertEqual(saved["current"]["abandoned"]["superseded_by"], "7" * 64)
        self.assertEqual(len(saved["rebindings"]), 1)
        # A later HEAD move on the closed round rebinds again instead of reporting an unfinished page.
        w.git.local_head = HEAD1
        saved["identity"]["base_head"] = HEAD2
        self.assertNotIn("unfinished", w.sup._stage2_repair_rebind_problem(b, saved, checkpoint, "8" * 64) or "")

    def test_stale_page_with_pending_answer_or_unproven_integration_still_fails_closed(self):
        w, b, state = self._stale_unresolved_world()
        checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
        pending = json.loads(json.dumps(state))
        pending["current"]["pending_answer"] = {"decisions": []}
        self.assertIn("unfinished", w.sup._stage2_repair_rebind_problem(b, pending, checkpoint, "7" * 64))
        w.git.verified_supervisor_integration = lambda *_a, **_k: False
        self.assertIn("master-integration chain", w.sup._stage2_repair_rebind_problem(b, state, checkpoint, "7" * 64))

    def test_repeated_gloss_conflict_gets_one_officially_checked_retry(self):
        from unittest.mock import patch
        w, b, path = _world(self)
        key = "source-sense\0candidate-0"
        decision = {"source_sense_id": "source-sense", "candidate": "candidate-0", "disposition": "drop", "reason": "x"}
        candidate = {"source_sense_id": "source-sense", "candidate": "candidate-0", "decision": decision,
                     "additional_relations": None, "already_accounted": False, "same_group_peers": []}
        group = {"candidate_keys": [key], "conflicts": [], "drop_gloss": ["named"], "candidates": [candidate]}
        report = {**conflict_report(OLD_FINGERPRINT), "problems": [group]}
        w.git.stage2_repair_checker = lambda _: {"ok": False, "invalid_candidates": [{"candidate_key": key,
            "problems": [{"field_path": "decision.reason", "condition": "gloss_named", "message": "named"}]}]}
        before = path.read_bytes()
        with patch.object(w.sup, "_launch_stage2_repair_page") as launch:
            self.assertTrue(w.sup._stage2_preflight_repair(b, stage2.checkpoint(b["worktree"], b["shard"], b["batch"]), report))
            launch.assert_called_once()
        state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        self.assertEqual(state["gloss_rechecks"], [OLD_FINGERPRINT])
        self.assertEqual(state["rounds_used"], 2)
        self.assertEqual(path.read_bytes(), before)
        self.assertTrue(w.sup._stage2_preflight_repair(b, stage2.checkpoint(b["worktree"], b["shard"], b["batch"]), report))
        self.assertIn("repeated fingerprint", w.store.batch(b["id"])["error"])
        self.assertEqual(path.read_bytes(), before)

    def test_incident_finalize_retargets_only_owned_completed_repair(self):
        from unittest.mock import patch
        for dirty in (False, True):
            with self.subTest(dirty=dirty):
                w, b, _ = _world(self)
                w.store.set(f"s2_finalize_base_{b['id']}", HEAD1)
                w.git.dirty_text = " M unrelated\n" if dirty else ""
                maint = w.sup.maint
                d = {"id": 57, "merge_sha": HEAD2}
                def apply(*_):
                    w.git.local_head = HEAD2
                    return HEAD2, None
                with patch.object(maint, "_preserved", return_value=None), \
                     patch.object(maint, "_fix_not_loaded", return_value=False), \
                     patch.object(maint, "_apply", side_effect=apply) as integrate, \
                     patch.object(maint, "_fix_merged_integration_proof", return_value={"head": HEAD2}), \
                     patch.object(maint, "_archive_report", return_value=True), \
                     patch.object(maint, "_recovery_snapshot", return_value={}), \
                     patch.object(maint, "_hold_unprovable") as hold, \
                     patch.object(w.store, "release_defect", return_value=True) as release:
                    maint._release_worktree(d, b, {"observed": {}})
                    if dirty:
                        integrate.assert_not_called()
                        release.assert_not_called()
                        hold.assert_called_once()
                    else:
                        integrate.assert_called_once()
                        self.assertEqual(release.call_args.args[3], [(f"s2_finalize_base_{b['id']}", HEAD2)])

    def test_incident_finalize_accepts_integration_moved_baseline_only_with_verified_chain(self):
        from unittest.mock import patch
        for proven in (True, False):
            with self.subTest(proven=proven):
                w, b, _ = _world(self)   # Repair identity base_head is HEAD1
                _mark_integrated(w, b)   # Supervisor already moved HEAD and finalize base to HEAD2
                maint = w.sup.maint
                d = {"id": 57, "merge_sha": HEAD2}
                w.git.verified_supervisor_integration = lambda *_a, **_k: proven
                def apply(*_):
                    return HEAD2, None
                with patch.object(maint, "_preserved", return_value=None), \
                     patch.object(maint, "_fix_not_loaded", return_value=False), \
                     patch.object(maint, "_apply", side_effect=apply) as integrate, \
                     patch.object(maint, "_fix_merged_integration_proof", return_value={"head": HEAD2}), \
                     patch.object(maint, "_archive_report", return_value=True), \
                     patch.object(maint, "_recovery_snapshot", return_value={}), \
                     patch.object(maint, "_hold_unprovable") as hold, \
                     patch.object(w.store, "release_defect", return_value=True) as release:
                    maint._release_worktree(d, b, {"observed": {}})
                    if proven:
                        integrate.assert_called_once()
                        release.assert_called_once()
                        hold.assert_not_called()
                    else:
                        integrate.assert_not_called()
                        release.assert_not_called()
                        hold.assert_called_once()

    def test_preflight_incident_without_repair_state_releases_only_with_intact_evidence(self):
        from unittest.mock import patch
        for case in ("clean", "receipt", "run_start", "wrong_error", "dirty", "unfinished"):
            with self.subTest(case=case):
                w, b, path = _world(self)
                w.store.delete(stage2.repair_state_key(b["id"]))
                w.store.delete(stage2.repair_run_start_key(b["id"]))
                data = json.loads(path.read_text("utf-8"))
                data["repair_receipts"] = []
                if case == "receipt":
                    data["repair_receipts"] = [{"request_id": RECEIPT_ID}]
                if case == "unfinished":
                    data["optional_review_complete"] = False
                path.write_text(json.dumps(data), "utf-8")
                if case == "run_start":
                    w.store.set(stage2.repair_run_start_key(b["id"]), "{}")
                if case == "dirty":
                    w.git.dirty_text = " M unrelated\n"
                w.store.set(f"s2_finalize_base_{b['id']}", HEAD1)
                maint = w.sup.maint
                d = {"id": 57, "merge_sha": HEAD2}
                env = {"observed": {}, "error": ("other failure" if case == "wrong_error" else
                       "Stage 2 read-only preflight failed: output limit")}
                def apply(*_):
                    w.git.local_head = HEAD2
                    return HEAD2, None
                with patch.object(maint, "_preserved", return_value=None), \
                     patch.object(maint, "_fix_not_loaded", return_value=False), \
                     patch.object(maint, "_apply", side_effect=apply) as integrate, \
                     patch.object(maint, "_fix_merged_integration_proof", return_value={"head": HEAD2}), \
                     patch.object(maint, "_archive_report", return_value=True), \
                     patch.object(maint, "_recovery_snapshot", return_value={}), \
                     patch.object(maint, "_hold_unprovable") as hold, \
                     patch.object(w.store, "release_defect", return_value=True) as release:
                    maint._release_worktree(d, b, env)
                    if case == "clean":
                        integrate.assert_called_once()
                        self.assertEqual(release.call_args.args[3], [(f"s2_finalize_base_{b['id']}", HEAD2)])
                        hold.assert_not_called()
                    else:
                        integrate.assert_not_called()
                        release.assert_not_called()
                        hold.assert_called_once()

    def test_inflight_answer_dirty_owner_remote_and_receipt_mismatch_fail_closed(self):
        cases = ("pending", "apply_intent", "dirty", "remote", "wrong_branch", "non_ancestor", "baseline", "receipt")
        for case in cases:
            with self.subTest(case=case):
                w, b, path = _world(self)
                _mark_integrated(w, b)
                before_checkpoint = path.read_bytes()
                state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
                if case == "pending":
                    state["current"]["pending_answer"] = {"decisions": []}
                elif case == "apply_intent":
                    state["current"]["apply_intent"] = {"fingerprint": OLD_FINGERPRINT}
                elif case == "dirty":
                    w.git.dirty_text = " M README.md\n"
                elif case == "remote":
                    w.git.remote[b["branch"]] = HEAD2
                elif case == "wrong_branch":
                    w.git.reg[b["worktree"]] = "s2-other-003-01-05"
                elif case == "non_ancestor":
                    w.git.ancestor_pairs.clear()
                elif case == "baseline":
                    w.store.set(f"s2_finalize_base_{b['id']}", HEAD1)
                elif case == "receipt":
                    data = json.loads(path.read_text("utf-8"))
                    data["repair_receipts"][0]["candidate_keys"] = ["source-sense\u0000different"]
                    path.write_text(json.dumps(data), "utf-8")
                    before_checkpoint = path.read_bytes()
                if case in {"pending", "apply_intent"}:
                    w.store.set(stage2.repair_state_key(b["id"]), json.dumps(state, sort_keys=True))
                original_state = w.store.get(stage2.repair_state_key(b["id"]))
                checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
                w.git.stage2_preflight_reports.append(clean_report())

                stopped = w.sup._stage2_preflight_repair(b, checkpoint)

                self.assertTrue(stopped)
                self.assertEqual(w.store.batch(b["id"])["state"], "ERROR")
                self.assertEqual(w.store.get(stage2.repair_state_key(b["id"])), original_state)
                self.assertEqual(path.read_bytes(), before_checkpoint)
                self.assertEqual(w.git.stage2_repair_calls, [])
                self.assertEqual(w.gh.created_prs, [])

    def test_same_fingerprint_still_stops_and_repeated_tick_after_restart_is_idempotent(self):
        w, b, _path = _world(self)
        _mark_integrated(w, b)
        w.git.stage2_preflight_reports.extend([
            conflict_report(OLD_FINGERPRINT, candidate="candidate-0"),
            conflict_report(OLD_FINGERPRINT, candidate="candidate-0"),
        ])
        checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])

        self.assertTrue(w.sup._stage2_preflight_repair(b, checkpoint))
        after_first = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        self.assertEqual(after_first["identity"]["base_head"], HEAD2)
        self.assertEqual(len(after_first["rebindings"]), 1)
        self.assertEqual(w.git.stage2_repair_calls, [])
        history = after_first["history"]

        w.sup = w.make_sup()
        self.assertTrue(w.sup._stage2_preflight_repair(b, checkpoint))
        after_restart = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        self.assertEqual(w.store.batch(b["id"])["state"], "ERROR")
        self.assertIn("repeated fingerprint", w.store.batch(b["id"])["error"])
        self.assertEqual(after_restart["history"], history)
        self.assertEqual(len(after_restart["rebindings"]), 1)
        self.assertEqual(len(w.git.integration_proof_calls), 1)

    def test_new_fingerprint_uses_fresh_preflight_targets_and_preserves_prior_round(self):
        w, b, _path = _world(self, total=2)
        _mark_integrated(w, b)
        new_fp = "7" * 64
        w.git.stage2_preflight_reports.append(conflict_report(new_fp, candidate="candidate-1"))
        checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])

        self.assertTrue(w.sup._stage2_preflight_repair(b, checkpoint))

        state = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        current = state["current"]
        self.assertEqual(state["rounds_used"], 2)
        self.assertEqual([entry["fingerprint"] for entry in state["history"]], [OLD_FINGERPRINT, new_fp])
        self.assertEqual(state["history"][0]["applied_candidate_keys"], ["source-sense\u0000candidate-0"])
        self.assertEqual(current["fingerprint"], new_fp)
        self.assertEqual(current["target_keys"], ["source-sense\u0000candidate-1"])
        self.assertEqual(w.adapter.launches[-1]["kind"], "start")
        self.assertNotIn("repair @", w.adapter.launches[-1]["prompt"])
        self.assertNotIn(new_fp, w.adapter.launches[-1]["prompt"])
        self.assertEqual(w.git.stage2_repair_calls, [])

    def test_two_master_advances_and_supervisor_restart_preserve_repair_history(self):
        w, b, _path = _world(self)
        _mark_integrated(w, b)
        w.git.stage2_preflight_reports.append(clean_report())
        checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
        self.assertFalse(w.sup._stage2_preflight_repair(b, checkpoint))

        head3 = "c" * 40
        _mark_integrated(w, b, old=HEAD2, new=head3)
        w.git.stage2_preflight_reports.extend([clean_report(fingerprint="8" * 64), clean_report(fingerprint="8" * 64)])
        checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
        w.sup = w.make_sup()
        self.assertFalse(w.sup._stage2_preflight_repair(b, checkpoint))
        after_second = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        history = after_second["history"]
        self.assertEqual(after_second["identity"]["base_head"], head3)
        self.assertEqual(len(after_second["rebindings"]), 2)
        self.assertEqual(after_second["rounds_used"], 1)
        self.assertEqual(after_second["history"][0]["applied_candidate_keys"], ["source-sense\u0000candidate-0"])

        w.sup = w.make_sup()
        self.assertFalse(w.sup._stage2_preflight_repair(b, checkpoint))
        after_duplicate = json.loads(w.store.get(stage2.repair_state_key(b["id"])))
        self.assertEqual(after_duplicate["history"], history)
        self.assertEqual(len(after_duplicate["rebindings"]), 2)
        self.assertEqual(len(w.git.integration_proof_calls), 2)


class VerifiedIntegrationReflog(unittest.TestCase):
    def test_only_uninterrupted_fast_forward_merges_from_origin_master_prove_integration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "repo"
            worktrees = root / "tools" / "warroom" / ".local" / "worktrees"
            wt = worktrees / "s2-codex-003-01-05"
            remote = Path(tmp) / "origin.git"

            def git(cwd, *args):
                result = subprocess.run(["git", *args], cwd=cwd, text=True, capture_output=True, check=True)
                return result.stdout.strip()

            git(Path(tmp), "init", "--bare", str(remote))
            root.mkdir()
            git(root, "init", "-b", "master")
            git(root, "config", "user.name", "Typewriter Test")
            git(root, "config", "user.email", "typewriter-test@example.invalid")
            (root / "README.md").write_text("base\n", "utf-8")
            git(root, "add", "README.md")
            git(root, "commit", "-m", "initial")
            git(root, "remote", "add", "origin", str(remote))
            git(root, "push", "-u", "origin", "master")
            git(root, "fetch", "origin", "master")
            old = git(root, "rev-parse", "HEAD")
            (root / "README.md").write_text("master advances\n", "utf-8")
            git(root, "commit", "-am", "master advance")
            new = git(root, "rev-parse", "HEAD")
            git(root, "push", "origin", "master")
            git(root, "fetch", "origin", "master")
            worktrees.mkdir(parents=True)
            git(root, "worktree", "add", "-b", "s2-codex-003-01-05", str(wt), old)
            git(wt, "merge", "--no-edit", new)

            implementation = Git(Runner(), root, os.environ.copy(), worktrees)
            self.assertTrue(implementation.verified_supervisor_integration(wt, "s2-codex-003-01-05", "master", old, new))

            (wt / "README.md").write_text("external change\n", "utf-8")
            git(wt, "commit", "-am", "external change")
            external = git(wt, "rev-parse", "HEAD")
            self.assertFalse(implementation.verified_supervisor_integration(wt, "s2-codex-003-01-05", "master", old, external))


if __name__ == "__main__":
    unittest.main()
