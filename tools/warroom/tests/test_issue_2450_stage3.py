"""Issue #2450 Phase 3: Stage 3 War Room ownership, chunk flow and PR recovery."""
import json
import unittest
from pathlib import Path
from unittest import mock

from tests.fakes import HEAD1, HEAD2, World
from warroom import batches, control, prompts, stage2, stage3
from warroom.config import stage3_model
from warroom.store import LineBusy, STAGE2_METHOD, STAGE3_METHOD
from warroom.supervisor import RecoveryBlocked
from warroom.web.api import _controls

PRODUCERS = {
    "claude": {"adapter": "claude", "model": "claude-x", "effort": "high"},
    "codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"},
    "deepseek": {"adapter": "opencode", "models": {"free": "p/free-x-free", "go": "p/go"}},
}
RELATION = "data/relations/relation-001.jsonl"
DROP = "data/relation-drops/drop-001.jsonl"


def s3_world(test):
    world = World()
    test.addCleanup(world.tmp.cleanup)
    world.cfg["producers"] = json.loads(json.dumps(PRODUCERS))
    return world


def checkpoint(shard="001", total=2, done=None):
    return {"version": 1, "shard": shard, "chunk_total": total,
            "completed_chunks": list(done or []), "decisions": []}


class Stage3SelectionAndOwnership(unittest.TestCase):
    def setUp(self):
        self.w = s3_world(self)

    def test_selection_requires_current_full_shard_stage2_verification_and_no_owner(self):
        w = self.w
        with mock.patch.object(stage3, "SHARDS", 2):
            self.assertEqual(stage3.choose(sha=HEAD1, kv=w.store, open_prs=[], stage2_batches=[],
                                           stage3_batches=[]).status, "wait")
            w.store.set(stage2.ok_key("002", None), HEAD1)
            choice = stage3.choose(sha=HEAD1, kv=w.store, open_prs=[], stage2_batches=[], stage3_batches=[])
            self.assertEqual((choice.status, choice.shard), ("shard", "002"))
            w.store.set(stage2.ok_key("001", None), "stale-master")
            self.assertEqual(stage3.choose(sha=HEAD1, kv=w.store, open_prs=[], stage2_batches=[],
                                           stage3_batches=[]).shard, "002")
            w.store.set(stage2.ok_key("001", None), HEAD1)
            stage2_running = [{"shard": "001", "state": "PRODUCING"}]
            self.assertEqual(stage3.choose(sha=HEAD1, kv=w.store, open_prs=[], stage2_batches=stage2_running,
                                           stage3_batches=[]).shard, "002")
            open_pr = {"number": 8, "files": [{"path": DROP}]}
            self.assertEqual(stage3.choose(sha=HEAD1, kv=w.store, open_prs=[open_pr], stage2_batches=[],
                                           stage3_batches=[]).shard, "002")
            done = [{"shard": "001", "state": "COMPLETE", "merged": 1}]
            self.assertEqual(stage3.choose(sha=HEAD1, kv=w.store, open_prs=[], stage2_batches=[],
                                           stage3_batches=done).shard, "002")

    def test_only_fixed_codex_line_can_start_and_store_reserves_one_shard(self):
        w = self.w
        ok, reason = control.start(w.store, "claude", STAGE3_METHOD, "single", cfg=w.cfg)
        self.assertFalse(ok)
        self.assertIn("Codex", reason)
        w.cfg["producers"]["codex-backup"] = {"adapter": "codex", "model": "gpt-backup", "effort": "high",
                                                "label": "ZZZ Backup"}
        owner = stage3_model(w.cfg)
        self.assertIn(owner, w.cfg["producers"])
        codex_controls = next(group for group in _controls(w.cfg)["adapters"] if group["id"] == "codex")
        self.assertIn("s3", [method["id"] for method in codex_controls["methods"]])
        self.assertEqual(_controls(w.cfg)["stage3_model"], owner)
        other_codex = next(model for model, producer in w.cfg["producers"].items()
                           if producer["adapter"] == "codex" and model != owner)
        self.assertFalse(control.start(w.store, other_codex, STAGE3_METHOD, "single", cfg=w.cfg)[0])
        self.assertTrue(control.start(w.store, owner, STAGE3_METHOD, "single", cfg=w.cfg)[0])
        batch_id = w.store.create_batch(method=STAGE3_METHOD, producer=owner, shard="001", batch="all",
                                        branch=f"s3-{owner}-001", worktree="/tmp/s3-001", from_run=True)
        self.assertEqual(w.store.batch(batch_id)["method"], STAGE3_METHOD)
        self.assertFalse(w.store.start_stage3(owner, "continuous")[0])
        with self.assertRaises(LineBusy):
            w.store.create_batch(method=STAGE2_METHOD, producer="claude", shard="001", batch="01-01",
                                 branch="s2-claude-001-01-01", worktree="/tmp/s2-001")
        with self.assertRaises(LineBusy):
            w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="002", batch="all",
                                 branch="s3-codex-002", worktree="/tmp/s3-002")

    def test_stage3_wait_reason_and_chunk_progress_are_exposed_on_its_line(self):
        w = self.w
        w.store.set_line("codex", STAGE3_METHOD, run=1)
        w.store.set("s3_wait_codex", "Stage 2 미완료")
        status = control.line_status(w.store, "codex", STAGE3_METHOD)
        self.assertEqual(status["wait"], "Stage 2 미완료")
        batch_id = w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="all",
                                        branch="s3-codex-001", worktree="/tmp/s3-001")
        path = stage3.checkpoint_path("/tmp/s3-001", "001")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(checkpoint(done=["001"])), "utf-8")
        w.store.update(batch_id, state="PRODUCING", progress_kind="chunks", progress_done=1, progress_total=2)
        status = control.line_status(w.store, "codex", STAGE3_METHOD)
        self.assertEqual((status["progress_kind"], status["progress_done"], status["progress_total"]),
                         ("chunks", 1, 2))


class Stage3EditContract(unittest.TestCase):
    def test_checkpoint_rejects_malformed_chunk_identity_without_type_error(self):
        with __import__("tempfile").TemporaryDirectory() as directory:
            path = stage3.checkpoint_path(directory, "001")
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps(checkpoint(done=[["not-hashable"]])), "utf-8")
            with self.assertRaises(stage3.Stage3Error):
                stage3.checkpoint(directory, "001")

    def test_saved_chunk_must_be_the_next_single_checkpoint_advance(self):
        before = checkpoint(total=2)
        self.assertTrue(stage3.chunk_saved_since(before, checkpoint(total=2, done=["001"])))
        self.assertFalse(stage3.chunk_saved_since(before, checkpoint(total=2, done=["002"])))
        self.assertFalse(stage3.chunk_saved_since(before, checkpoint(total=2, done=["001", "002"])))
        self.assertFalse(stage3.chunk_saved_since(before, checkpoint(total=3, done=["001"])))

    def test_answer_and_prompt_are_limited_to_drop_or_exact_link_repair(self):
        self.assertEqual(stage3.decision_text("chunk 001\nD 1 4\nL 5 T2\n", "001"),
                         "chunk 001\nD 1 4\nL 5 T2\n")
        self.assertEqual(stage3.decision_text("chunk 001\nnone\n", "001"), "chunk 001\nnone\n")
        for answer in ("chunk 002\nnone", "chunk 001\nkeep 1", "chunk 001\nnone\nD 1"):
            with self.subTest(answer=answer), self.assertRaises(stage3.Stage3Error):
                stage3.decision_text(answer, "001")
        self.assertIn("s3_policy_card", prompts.ALLOWED)
        self.assertIn("s3_chunk", prompts.ALLOWED)
        prompt = prompts.stage3_chunk({"shard": "001", "branch": "s3-codex-001"}, "001",
                                      '{"chunk":"001","senses":[]}')
        self.assertIn("chunk 001", prompt)
        self.assertIn("깜빡대다→가물가물", prompt)
        self.assertIn('{"chunk":"001","senses":[]}', prompt)

    def test_stage3_review_fix_prompt_is_shard_scoped_and_has_no_producer_contract_placeholders(self):
        batch = {"method": STAGE3_METHOD, "pr_number": 9, "head_sha": HEAD1,
                 "branch": "s3-codex-001", "shard": "001", "batch": "all"}
        event = {"kind": "review", "author": "reviewer", "key": "review:123",
                 "body": f"-1\nHEAD: {HEAD1}\nCorrect this shard row."}
        prompt = prompts.fix(batch, [event], False)
        self.assertIn("data/relations/relation-001.jsonl", prompt)
        self.assertIn("data/relation-drops/drop-001.jsonl", prompt)
        self.assertIn("node scripts/relation/admission-cli.mjs verify --shard 001 --json", prompt)
        self.assertIn("WarRoom-Review-Event: review:<actual-event-id>", prompt)
        self.assertIn("review:123", prompt)
        self.assertNotIn("{{canonical}}", prompt)
        self.assertNotIn("{{method_contract}}", prompt)

    def test_pr_identity_requires_issue_link_base_and_only_its_own_relation_drop_files(self):
        pr = {"number": 9, "title": "[Relation Stage 3] 001", "body": "Implements #2450", "base_ref": "master"}
        self.assertEqual(stage3.validate_pr(pr, [{"path": RELATION}, {"path": DROP}]), "001")
        self.assertEqual(stage3.validate_pr(pr, []), "001")  # a no-change shard may have an empty diff
        for bad_pr, files in (
            ({**pr, "body": "unlinked"}, [{"path": RELATION}]),
            ({**pr, "base_ref": "develop"}, [{"path": RELATION}]),
            ({**pr, "title": "[Relation Stage 3] 002"}, [{"path": RELATION}]),
            (pr, [{"path": RELATION}, {"path": "README.md"}]),
            (pr, [{"path": RELATION}, {"path": RELATION}]),
            (pr, [None]),
        ):
            with self.subTest(bad_pr=bad_pr, files=files), self.assertRaises(stage3.Stage3Error):
                stage3.validate_pr(bad_pr, files)


class Stage3SupervisorFlow(unittest.TestCase):
    def setUp(self):
        self.w = s3_world(self)

    def _batch(self, *, state="PRODUCING", run_kind="s3_chunk_new"):
        w = self.w
        path = w.paths.worktrees / "s3-001"
        path.mkdir(parents=True)
        branch = "s3-codex-001"
        w.git.reg[str(path)] = branch
        w.git.remote[branch] = HEAD1
        batch_id = w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="all",
                                        branch=branch, worktree=str(path))
        w.store.update(batch_id, state=state, run_kind=run_kind)
        return w.store.batch(batch_id)

    def _claimed_fix(self, *, with_reply=True):
        w = self.w
        batch = self._batch(state="WAITING_REVIEW", run_kind="s3_finalize")
        w.store.update(batch["id"], pr_number=9, head_sha=HEAD1, session_id="old-production-session")
        batch = w.store.batch(batch["id"])
        event = {"kind": "review", "author": "reviewer", "key": "review:stage3-test",
                 "body": f"-1\nHEAD: {HEAD1}\nCorrect this shard row."}
        with mock.patch.object(w.sup, "_preflight", return_value=None), \
                mock.patch.object(w.sup, "_agent_env", return_value={}), \
                mock.patch.object(w.sup, "_launch_env", return_value={}):
            w.sup._launch(batch, "fix_new", [event])
        run = w.store.runs(batch["id"])[0]
        w.store.finish_runs(batch["id"], 0)
        w.store.update(batch["id"], pid=None)
        w.store.set(f"verified_completion_run_{batch['id']}", str(run["id"]))
        w.git.local_head = HEAD2
        w.git.remote[batch["branch"]] = HEAD2
        w.gh.prs[9] = {"number": 9, "state": "open", "merged": False, "head_sha": HEAD2,
                        "head_ref": batch["branch"], "title": "[Relation Stage 3] 001",
                        "body": "Implements #2450", "base_ref": "master"}
        w.gh.files[9] = [{"path": RELATION}, {"path": DROP}]
        w.git.verify_heads.add((HEAD2, "shard", "001", None, None))
        if with_reply:
            w.gh.add_pr_reply(9, "Corrected and verified.\n\nWarRoom-Review-Event: review:stage3-test",
                              login=w.cfg["expected_account"])
        return w.store.batch(batch["id"]), run

    def test_completed_chunk_is_saved_once_and_next_chunk_gets_a_fresh_launch(self):
        w = self.w
        batch = self._batch()
        before = checkpoint(total=2)
        decision_view = {"chunk": "001", "relation_count": 0, "senses": []}
        path = stage3.checkpoint_path(batch["worktree"], "001")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(before), "utf-8")
        w.store.set(stage3.run_start_key(batch["id"]), json.dumps({
            "checkpoint": before, "chunk": "001", "branch": batch["branch"],
            "worktree": batch["worktree"], "head": HEAD1, "remote_head": HEAD1,
            "view": decision_view,
        }))
        w.store.update(batch["id"], log_file=str(Path(batch["worktree"]) / "answer.log"))
        next_step = mock.Mock()
        w.sup._launch_stage3_next = next_step

        def save(_runner, _env, worktree, shard, chunk, _answer):
            self.assertEqual((shard, chunk), ("001", "001"))
            updated = checkpoint(total=2, done=["001"])
            stage3.checkpoint_path(worktree, shard).write_text(json.dumps(updated), "utf-8")
            return {"chunk": chunk}

        with mock.patch.object(stage3, "read_chunk", return_value=decision_view), \
                mock.patch.object(stage3, "save_chunk", side_effect=save), \
                mock.patch.object(w.adapter, "final_answer", return_value="chunk 001\nnone\n"):
            w.sup._run_ok_stage3_chunk(w.store.batch(batch["id"]))
        next_step.assert_called_once()
        refreshed = w.store.batch(batch["id"])
        self.assertEqual((refreshed["progress_kind"], refreshed["progress_done"], refreshed["progress_total"]),
                         ("chunks", 1, 2))
        self.assertIsNone(w.store.get(stage3.run_start_key(batch["id"])))

    def test_chunk_exit_recovers_exact_checkpoint_advance_without_resaving(self):
        w = self.w
        batch = self._batch()
        before = checkpoint(total=2)
        path = stage3.checkpoint_path(batch["worktree"], "001")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(checkpoint(total=2, done=["001"])), "utf-8")
        w.store.set(stage3.run_start_key(batch["id"]), json.dumps({
            "checkpoint": before, "chunk": "001", "branch": batch["branch"],
            "worktree": batch["worktree"], "head": HEAD1, "remote_head": HEAD1,
        }))
        next_step = mock.Mock()
        w.sup._launch_stage3_next = next_step
        with mock.patch.object(stage3, "save_chunk", side_effect=AssertionError("must not save twice")):
            w.sup._run_ok_stage3_chunk(batch)
        next_step.assert_called_once()

    def test_owned_stage3_pr_recovery_rejects_wrong_scope(self):
        w = self.w
        batch = self._batch(state="PRODUCING", run_kind="s3_finalize")
        w.gh._register(batch["branch"], "[Relation Stage 3] 001", "Implements #2450", [])
        pr = w.gh.created_prs[-1]["number"]
        w.gh.files[pr] = [{"path": RELATION}, {"path": "README.md"}]
        with self.assertRaises(RecoveryBlocked):
            w.sup._find_recovery_pr(batch)

    def test_blocking_review_launches_the_stage3_fix_route_and_claims_its_event(self):
        w = self.w
        batch = self._batch(state="WAITING_REVIEW", run_kind="s3_finalize")
        w.store.update(batch["id"], pr_number=9, head_sha=HEAD1, session_id="old-production-session")
        event = {"kind": "review", "author": "reviewer", "key": "review:123",
                 "body": f"-1\nHEAD: {HEAD1}\nCorrect this shard row."}
        batch = w.store.batch(batch["id"])
        self.assertEqual(w.sup._fix_kind(batch), "fix_new")
        with mock.patch.object(w.sup, "_preflight", return_value=None), \
                mock.patch.object(w.sup, "_agent_env", return_value={}), \
                mock.patch.object(w.sup, "_launch_env", return_value={}):
            w.sup._launch(batch, w.sup._fix_kind(batch), [event])
        launched = w.adapter.launches[-1]
        self.assertIn("data/relations/relation-001.jsonl", launched["prompt"])
        self.assertIn("verify --shard 001 --json", launched["prompt"])
        self.assertEqual(w.store.batch(batch["id"])["state"], "FIXING")
        claim = json.loads(w.store.get(f"fix_claim_{batch['id']}"))
        self.assertEqual((claim["pr"], claim["head_sha"], claim["event_keys"], claim["status"]),
                         (9, HEAD1, ["review:123"], "CLAIMED"))
        self.assertEqual(claim["run_id"], w.store.runs(batch["id"])[0]["id"])

    def test_stage3_fix_rejects_unauthorized_pr_files_before_verify_and_reverifies_exact_head(self):
        w = self.w
        batch = self._batch(state="FIXING", run_kind="fix_new")
        w.store.update(batch["id"], pr_number=9, head_sha=HEAD1)
        batch = w.store.batch(batch["id"])
        info = {"number": 9, "state": "open", "merged": False, "head_ref": batch["branch"],
                "head_sha": HEAD2, "title": "[Relation Stage 3] 001", "body": "Implements #2450",
                "base_ref": "master"}
        verify = mock.Mock(wraps=w.git.verify_stage2)
        w.gh.files[9] = [{"path": RELATION}, {"path": "README.md"}]
        with mock.patch.object(w.git, "verify_stage2", verify):
            problem = w.sup._stage3_fix_result_problem(batch, info)
            self.assertIn("changed files do not match", problem)
            verify.assert_not_called()

            w.gh.files[9] = [{"path": RELATION}, {"path": DROP}]
            w.git.verify_heads.add((HEAD2, "shard", "001", None, None))
            self.assertIsNone(w.sup._stage3_fix_result_problem(batch, info))
            verify.assert_called_once_with(HEAD2, "shard", "001", None, None)

    def test_headlag_stage3_fix_completion_rechecks_scope_verify_and_event_reply(self):
        w = self.w
        batch, run = self._claimed_fix()
        stale = dict(w.gh.prs[9], head_sha=HEAD1)
        self.assertEqual(w.sup._check_fix_head(batch, stale), "wait")
        before_launches = len(w.adapter.launches)
        before_replies = len(w.gh.issue_comments(9))

        w.sup._recheck_fix_head(batch)

        result = w.store.batch(batch["id"])
        event = w.store.handled_event(batch["id"], 9, HEAD1, "review:stage3-test")
        self.assertEqual(result["state"], "WAITING_REVIEW")
        self.assertEqual(event["status"], "HANDLED")
        self.assertEqual(event["run_id"], run["id"])
        self.assertEqual(len(w.adapter.launches), before_launches)
        self.assertEqual(len(w.gh.issue_comments(9)), before_replies)

    def test_headlag_stage3_fix_completion_stops_on_scope_verify_or_missing_reply(self):
        for failure in ("scope", "verify", "reply"):
            with self.subTest(failure=failure):
                original = self.w
                w = s3_world(self)
                self.w = w
                try:
                    batch, _run = self._claimed_fix()
                    if failure == "scope":
                        w.gh.files[9] = [{"path": RELATION}, {"path": "README.md"}]
                    elif failure == "verify":
                        w.git.verify_heads.clear()
                    else:
                        w.gh.issue_comments_[9] = []
                    before_launches = len(w.adapter.launches)

                    w.sup._recheck_fix_head(batch)

                    result = w.store.batch(batch["id"])
                    event = w.store.handled_event(batch["id"], 9, HEAD1, "review:stage3-test")
                    self.assertEqual(result["state"], "ERROR")
                    self.assertEqual(event["status"], "CLAIMED")
                    self.assertEqual(len(w.adapter.launches), before_launches)
                finally:
                    self.w = original

    def test_verified_fix_operator_retry_uses_the_same_gate_without_duplicate_run_or_reply(self):
        w = self.w
        batch, run = self._claimed_fix()
        before_launches = len(w.adapter.launches)
        before_replies = len(w.gh.issue_comments(9))
        with mock.patch.object(w.sup, "_retry_denied_success", return_value=False), \
                mock.patch.object(w.sup, "_verified_fix_exit", return_value=True):
            w.sup._relaunch_do(batch)
        result = w.store.batch(batch["id"])
        event = w.store.handled_event(batch["id"], 9, HEAD1, "review:stage3-test")
        self.assertEqual(result["state"], "WAITING_REVIEW")
        self.assertEqual(event["status"], "HANDLED")
        self.assertEqual(event["run_id"], run["id"])
        self.assertEqual(len(w.adapter.launches), before_launches)
        self.assertEqual(len(w.gh.issue_comments(9)), before_replies)

    def test_verified_fix_operator_retry_stops_when_the_pr_scope_is_invalid(self):
        w = self.w
        batch, _run = self._claimed_fix()
        w.gh.files[9] = [{"path": RELATION}, {"path": "README.md"}]
        before_launches = len(w.adapter.launches)
        with mock.patch.object(w.sup, "_retry_denied_success", return_value=False), \
                mock.patch.object(w.sup, "_verified_fix_exit", return_value=True):
            w.sup._relaunch_do(batch)
        result = w.store.batch(batch["id"])
        event = w.store.handled_event(batch["id"], 9, HEAD1, "review:stage3-test")
        self.assertEqual(result["state"], "ERROR")
        self.assertEqual(event["status"], "CLAIMED")
        self.assertEqual(len(w.adapter.launches), before_launches)

    def test_finalization_commits_only_the_two_shard_files_then_opens_one_issue_linked_pr(self):
        w = self.w
        batch = self._batch(state="PRODUCING", run_kind="s3_finalize")
        w.git.remote.pop(batch["branch"], None)
        w.git.dirty_text = f" M {RELATION}\n"
        w.git.verified.add(("shard", "001", None, None))
        w.gh.issues[2450] = {"state": "open", "labels": ["batch"], "title": "Stage 3", "body": ""}
        with mock.patch.object(stage3, "checkpoint", return_value=checkpoint(total=1, done=["001"])), \
                mock.patch.object(stage3, "apply", return_value={"removed": 1, "repaired": 0, "edit_drops_added": 1}), \
                mock.patch.object(stage3, "report", return_value={"shard": "001", "deleted_relations": [],
                                                                    "link_repairs": [], "added_drops": []}):
            w.sup._stage3_finalize_do(batch)
        self.assertEqual(w.store.batch(batch["id"])["state"], "WAITING_REVIEW",
                         w.store.batch(batch["id"])["error"])
        self.assertEqual(w.git.commits, [([RELATION], "[Relation Stage 3] 001")])
        self.assertEqual(w.gh.created_prs[0]["title"], "[Relation Stage 3] 001")
        self.assertEqual(w.gh.created_prs[0]["labels"], ["batch"])
        self.assertIn("#2450", w.gh.created_prs[0]["body"])
        self.assertEqual(w.store.batch(batch["id"])["state"], "WAITING_REVIEW")

    def test_finalize_restart_keeps_apply_report_counts_before_creating_pr(self):
        w = self.w
        batch = self._batch(state="PRODUCING", run_kind="s3_finalize")
        w.git.remote.pop(batch["branch"], None)
        w.store.set(f"s3_apply_ready_{batch['id']}", "1")
        w.store.set(f"s3_apply_result_{batch['id']}", json.dumps({"removed": 3, "repaired": 2, "edit_drops_added": 1}))
        w.git.verified.add(("shard", "001", None, None))
        w.gh.issues[2450] = {"state": "open", "labels": [], "title": "Stage 3", "body": ""}
        with mock.patch.object(stage3, "checkpoint", return_value=None), \
                mock.patch.object(stage3, "apply", side_effect=AssertionError("apply already completed")), \
                mock.patch.object(stage3, "report", return_value={"shard": "001", "deleted_relations": [],
                                                                    "link_repairs": [], "added_drops": []}):
            w.sup._stage3_finalize_do(batch)
        self.assertEqual(w.store.batch(batch["id"])["state"], "WAITING_REVIEW",
                         w.store.batch(batch["id"])["error"])
        body = w.gh.created_prs[0]["body"]
        self.assertIn("3행 삭제", body)
        self.assertIn("2행 Link Repair", body)
        self.assertIn("1개 edit Drop", body)

    def test_finalize_retry_after_commit_reuses_applied_edits_without_duplicate_commit(self):
        w = self.w
        batch = self._batch(state="PRODUCING", run_kind="s3_finalize")
        w.git.remote.pop(batch["branch"], None)
        w.git.verified.add(("shard", "001", None, None))
        w.git.dirty_text = ""
        w.gh.issues[2450] = {"state": "open", "labels": [], "title": "Stage 3", "body": ""}
        checkpoint_path = stage3.checkpoint_path(batch["worktree"], "001")
        checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        checkpoint_path.write_text(json.dumps(checkpoint(total=1, done=["001"])), "utf-8")

        def apply(_runner, _env, _worktree, _shard):
            checkpoint_path.unlink()
            w.git.dirty_text = f" M {RELATION}\n M {DROP}\n"
            return {"removed": 3, "repaired": 2, "edit_drops_added": 1}

        report = {"shard": "001", "deleted_relations": [], "link_repairs": [], "added_drops": []}
        with mock.patch.object(stage3, "apply", side_effect=apply) as apply_call, \
                mock.patch.object(stage3, "report", return_value=report):
            with mock.patch.object(w.gh, "issue", side_effect=RuntimeError("GitHub unavailable")):
                w.sup._stage3_finalize_do(batch)
            self.assertEqual(w.store.batch(batch["id"])["state"], "ERROR")
            self.assertFalse(checkpoint_path.exists())
            self.assertEqual(w.git.commits, [([DROP, RELATION], "[Relation Stage 3] 001")])
            committed_head = w.git.local_head
            self.assertEqual(w.store.get(f"s3_apply_result_{batch['id']}"), json.dumps({
                "edit_drops_added": 1, "removed": 3, "repaired": 2,
            }, sort_keys=True))

            # Simulate a process stopping after the Git commit but before saving its Store commit marker.
            w.store.delete(f"s3_commit_head_{batch['id']}")
            w.sup._stage3_finalize_do(w.store.batch(batch["id"]))
            apply_call.assert_called_once()
        self.assertEqual(w.git.local_head, committed_head)
        self.assertEqual(w.git.commits, [([DROP, RELATION], "[Relation Stage 3] 001")])
        self.assertEqual(len(w.gh.created_prs), 1)
        self.assertEqual(w.gh.created_prs[0]["title"], "[Relation Stage 3] 001")
        self.assertEqual(w.store.batch(batch["id"])["state"], "WAITING_REVIEW")

    def test_finalize_recovery_rejects_an_unmarked_commit_outside_stage3_file_scope(self):
        w = self.w
        batch = self._batch(state="PRODUCING", run_kind="s3_finalize")
        head = "f" * 40
        w.git.local_head = head
        w.git.commit_message = "[Relation Stage 3] 001"
        w.git.commit_parent_sha = HEAD1
        w.git.changed[head] = ["README.md"]
        w.store.set(f"s3_apply_ready_{batch['id']}", "1")
        w.store.set(f"s3_apply_result_{batch['id']}", json.dumps({"removed": 1}))
        with mock.patch.object(stage3, "checkpoint", return_value=None), \
                mock.patch.object(stage3, "report", return_value={"shard": "001", "deleted_relations": [],
                                                                    "link_repairs": [], "added_drops": []}):
            w.sup._stage3_finalize_do(batch)
        result = w.store.batch(batch["id"])
        self.assertEqual(result["state"], "ERROR")
        self.assertIn("허용되지 않은 파일", result["error"])
        self.assertEqual(w.gh.created_prs, [])

    def test_merged_pr_recovery_requires_valid_files_and_latest_master_verify(self):
        w = self.w
        merge = "2" * 40
        w.git.on_base = True
        w.git.verified.add(("shard", "001", None, None))
        w.gh.merged_stage3_prs = [{"number": 88, "title": "[Relation Stage 3] 001", "body": "implements #2450",
                                   "base_ref": "master", "merge_commit_sha": merge}]
        w.gh.files[88] = [{"path": RELATION}]
        w.sup._stage3_recover_merged("codex", w.git.base_sha)
        row = w.store.latest_batch("codex", STAGE3_METHOD)
        self.assertEqual((row["state"], row["merged"], row["pr_number"], row["head_sha"]),
                         ("COMPLETE", 1, 88, merge))
        self.assertEqual(w.store.get(stage3.ok_key("001")), w.git.base_sha)
        w.sup._stage3_recover_merged("codex", w.git.base_sha)
        self.assertEqual(w.gh.merged_stage3_prs_calls, 1)
        self.assertEqual(w.gh.pull_files_calls, [88])

    def test_merged_pr_recovery_does_not_mark_shard_complete_when_verify_fails(self):
        w = self.w
        w.git.on_base = True
        w.gh.merged_stage3_prs = [{"number": 89, "title": "[Relation Stage 3] 001", "body": "implements #2450",
                                   "base_ref": "master", "merge_commit_sha": "2" * 40}]
        w.gh.files[89] = [{"path": RELATION}]
        with self.assertRaises(stage3.Stage3Error):
            w.sup._stage3_recover_merged("codex", w.git.base_sha)
        self.assertIsNone(w.store.latest_batch("codex", STAGE3_METHOD))


if __name__ == "__main__":
    unittest.main()
