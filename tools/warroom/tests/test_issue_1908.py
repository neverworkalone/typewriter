"""Issue #1908: each Stage 2 checkpoint chunk has an independent run, with saved-decision progress."""
import json
import os
import shutil
import unittest
from pathlib import Path

from tests.test_issue_1684 import S2, merge_part, s2_world
from tests.fakes import HEAD1, HEAD2
from tests.test_claude_adapter import init, result, stream
from tests.test_issue_1832 import Reporting
from warroom import control, progress


def write_state(batch, *, decided, total=2, next_chunk=2, pending=None, merged=False):
    path = Path(batch["worktree"]) / ".warroom-scratch" / \
        f"relation-admission-{batch['shard']}-{batch['batch'].split('-')[0]}-{batch['batch'].split('-')[1]}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    candidates = [{"text": f"candidate-{i}",
                   "decision": {"disposition": "drop"} if i < decided else None}
                  for i in range(total)]
    path.write_text(json.dumps({
        "version": 1, "shard": batch["shard"], "batch": batch["batch"].split("-")[0],
        "part": batch["batch"].split("-")[1], "complete": True, "stats": {},
        "next_chunk_number": next_chunk, "pending_chunk": pending, "merged": merged,
        "items": [{"sense_id": "source-sense", "candidates": candidates}],
    }), "utf-8")
    return path


class SavedStage2Progress(unittest.TestCase):
    def setUp(self):
        progress._cache.clear()
        self.w = s2_world(self)
        control.start(self.w.store, "claude", S2, "single", cfg=self.w.cfg)
        self.w.tick()

    def test_only_valid_saved_decisions_count_and_web_view_uses_same_values(self):
        b = self.w.store.active_batch("claude", S2)
        path = write_state(b, decided=1, total=3, next_chunk=2,
                           pending={"chunk_id": "001-01-01-002", "candidate_count": 1,
                                    "slices": [{"sense_id": "source-sense", "start": 1, "end": 2}]})
        self.assertEqual(progress.observe(b["worktree"], "001", "01-01", S2, "claude"),
                         ("candidates", 1, 3))  # the pending candidate is not saved yet
        self.w.store.update(b["id"], state="PAUSED")
        self.w.sup._record_progress(self.w.store.batch(b["id"]))
        status = control.line_status(self.w.store, "claude", S2)
        self.assertEqual((status["progress_kind"], status["progress_done"], status["progress_total"], status["progress"]),
                         ("candidates", 1, 3, "1/3 candidates"))
        from warroom.web.api import _line_view
        line = _line_view(status)
        self.assertEqual((line["progress_text"], line["progress_pct"], line["stage2"]),
                         ("1 / 3 candidates", 33.3, {"shard": "001", "batch": "01", "part": "01"}))
        path.write_text("{broken", "utf-8")
        progress._cache.clear()
        self.assertIsNone(progress.observe(b["worktree"], "001", "01-01", S2, "claude"))

    def test_wrong_part_and_unsupported_checkpoint_are_unconfirmed(self):
        b = self.w.store.active_batch("claude", S2)
        path = write_state(b, decided=1)
        data = json.loads(path.read_text())
        data["part"] = "02"
        path.write_text(json.dumps(data), "utf-8")
        progress._cache.clear()
        self.assertIsNone(progress.observe(b["worktree"], "001", "01-01", S2, "claude"))


class Stage2ChunkRuns(unittest.TestCase):
    def setUp(self):
        self.w = s2_world(self)
        control.start(self.w.store, "claude", S2, "single", cfg=self.w.cfg)
        self.w.adapter.plan.extend([
            {"code": 0, "session": "ses_chunk_1", "effect": lambda: write_state(
                self.w.store.active_batch("claude", S2), decided=1, total=2, next_chunk=2)},
            {"code": 0, "session": "ses_chunk_2", "effect": lambda: write_state(
                self.w.store.active_batch("claude", S2), decided=2, total=2, next_chunk=3)},
            {"code": 0, "session": "ses_finalize", "effect": lambda: write_state(
                self.w.store.active_batch("claude", S2), decided=2, total=2, next_chunk=3, merged=True)},
        ])
        self.w.tick()

    def test_two_chunks_use_new_sessions_then_final_verify_and_one_pr(self):
        w = self.w
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["run_kind"], b["branch"], b["state"]),
                         ("s2_chunk_new", "s2-claude-001-01-01", "PRODUCING"))
        first = w.adapter.launches[-1]
        w.adapter.finish(first["pid"])
        w.tick()
        w.tick()  # capture the new session id while the independent second run is live
        b = w.store.batch(b["id"])
        self.assertEqual((b["run_kind"], b["session_id"], b["state"]), ("s2_chunk_new", "ses_chunk_2", "PRODUCING"))
        second = w.adapter.launches[-1]
        self.assertEqual(second["kind"], "start")  # a fresh CLI session, never --resume after a saved chunk
        self.assertEqual((first["stage2_chunk_git"], second["stage2_chunk_git"]), ("1", "1"))
        self.assertEqual((first["git_shim"], second["git_shim"]), (str(Path(__file__).parents[1] / "bin" / "git"),) * 2)
        self.assertEqual((first["real_git"], second["real_git"]), (None, None))
        expected_git_paths = [str(w.git.worktree_gitdir(Path(first["cwd"])).parent.parent),
                              str(Path(first["cwd"]) / ".git")]
        self.assertEqual(json.loads(first["stage2_git_metadata_paths"]), expected_git_paths)
        self.assertEqual(first["stage2_git_metadata_paths"], second["stage2_git_metadata_paths"])
        for worker_path in (first["worker_path"], second["worker_path"]):
            self.assertTrue(worker_path.startswith(str(Path(__file__).parents[1] / "bin") + os.pathsep))
        self.assertEqual((second["model"], second["effort"], second["cwd"]),
                         (first["model"], first["effort"], first["cwd"]))
        self.assertIn("chunk", second["prompt"])
        self.assertEqual(w.gh.by_branch.get(b["branch"], []), [])
        w.adapter.finish(second["pid"])
        w.tick()
        w.tick()  # likewise capture the independent finalizer session
        b = w.store.batch(b["id"])
        final = w.adapter.launches[-1]
        self.assertEqual((b["run_kind"], final["kind"]), ("s2_finalize_new", "start"))
        self.assertIsNone(final["stage2_chunk_git"])  # only the finalizer may commit and push
        self.assertEqual(final["git_shim"], str(Path(__file__).parents[1] / "bin" / "git"))
        self.assertIsNone(final["real_git"])
        self.assertIsNone(final.get("stage2_git_metadata_paths"))
        final_path = final["worker_path"].split(os.pathsep)
        self.assertIn(str(Path(shutil.which("git", path=os.environ.get("PATH", os.defpath))).parent), final_path)
        self.assertIn("finalize", final["prompt"])
        self.assertEqual(b["branch"], w.git.created[0][1])
        self.assertEqual(w.git.local_head, HEAD1)
        self.assertIsNone(b["pr_number"])

        merge_part(w, "claude", "001", "01", "01")
        w.git.verify_heads.add((HEAD1, "part", "001", "01", "01"))
        w.adapter.finish(final["pid"])
        w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual((b["state"], b["pr_number"]), ("WAITING_REVIEW", 7))
        self.assertEqual([r["kind"] for r in w.store.runs(b["id"])],
                         ["s2_finalize_new", "s2_chunk_new", "s2_chunk_new"])
        self.assertEqual(w.git.verify_calls[-1], ("part", "001", "01", "01"))

    def test_zero_exit_without_exact_checkpoint_advance_is_not_success(self):
        w = self.w
        b = w.store.active_batch("claude", S2)
        w.adapter.running[w.adapter.launches[-1]["pid"]]["effect"] = None
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("checkpoint가 정확히 전진하지 않았거나", b["error"])
        self.assertEqual(len(w.adapter.launches), 1)

    def test_chunk_refuses_to_advance_after_owned_head_or_remote_branch_moves(self):
        for changed_ref in ("HEAD", "origin branch"):
            with self.subTest(changed_ref=changed_ref):
                w = s2_world(self)
                self.addCleanup(w.tmp.cleanup)
                control.start(w.store, "claude", S2, "single", cfg=w.cfg)
                w.adapter.plan.append({"code": 0, "session": "ses_chunk", "effect": lambda: write_state(
                    w.store.active_batch("claude", S2), decided=1, total=2, next_chunk=2)})
                w.tick()
                b = w.store.active_batch("claude", S2)
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                if changed_ref == "HEAD":
                    w.git.local_head = HEAD2
                else:
                    w.git.remote[b["branch"]] = HEAD2
                w.tick()
                b = w.store.batch(b["id"])
                self.assertEqual((b["state"], len(w.adapter.launches)), ("ERROR", 1))
                self.assertIn("변경됐습니다", b["error"])


class Stage2Retry(unittest.TestCase):
    def setUp(self):
        self.w = s2_world(self)
        control.start(self.w.store, "claude", S2, "single", cfg=self.w.cfg)
        self.w.adapter.plan.append({"code": 2, "session": "ses_failed",
                                    "effect": lambda: write_state(self.w.store.active_batch("claude", S2),
                                                                  decided=1, total=2, next_chunk=2)})
        self.w.tick()

    def test_retry_after_saved_chunk_does_not_reproduce_it_or_resume_old_session(self):
        w = self.w
        b = w.store.active_batch("claude", S2)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        b = w.store.batch(b["id"])
        self.assertEqual((b["run_kind"], b["state"]), ("s2_chunk_new", "PRODUCING"))
        self.assertEqual(w.adapter.launches[-1]["kind"], "start")
        self.assertNotEqual(w.adapter.launches[-1].get("session"), "ses_failed")
        self.assertEqual(progress.observe(b["worktree"], "001", "01-01", S2, "claude"),
                         ("candidates", 1, 2))

    def test_retry_after_denied_but_saved_chunk_advances_from_checkpoint(self):
        w = s2_world(self)
        self.addCleanup(w.tmp.cleanup)
        w.adapter = Reporting()
        w.sup.adapter = w.adapter
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.adapter.plan.append({"code": 0, "effect": lambda: write_state(
            w.store.active_batch("claude", S2), decided=1, total=2, next_chunk=2),
            "text": stream(init("claude-x"), result(denials=[{"tool_name": "Bash"}]))})
        w.tick()
        b = w.store.active_batch("claude", S2)
        first = w.adapter.launches[-1]
        w.adapter.finish(first["pid"])
        w.tick()
        self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")
        self.assertEqual(len(w.adapter.launches), 1)

        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        b = w.store.batch(b["id"])
        self.assertEqual((b["run_kind"], b["state"]), ("s2_chunk_new", "PRODUCING"))
        self.assertEqual(w.adapter.launches[-1]["kind"], "start")
        self.assertNotEqual(w.adapter.launches[-1]["pid"], first["pid"])
        self.assertEqual(progress.observe(b["worktree"], "001", "01-01", S2, "claude"),
                         ("candidates", 1, 2))

    def test_pending_unsaved_chunk_retries_the_same_session_and_checkpoint(self):
        w = s2_world(self)
        self.addCleanup(w.tmp.cleanup)
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.adapter.plan.append({"code": 2, "session": "ses_pending", "effect": lambda: write_state(
            w.store.active_batch("claude", S2), decided=0, total=2, next_chunk=1,
            pending={"chunk_id": "001-01-01-001", "candidate_count": 1,
                     "slices": [{"sense_id": "source-sense", "start": 0, "end": 1}]})})
        w.tick()
        b = w.store.active_batch("claude", S2)
        b0 = b["id"]
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.store.batch(b0)["state"], "PAUSED")
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        self.assertEqual(w.adapter.launches[-1]["session"], "ses_pending")
        checkpoint = json.loads((Path(b["worktree"]) / ".warroom-scratch" /
                                 "relation-admission-001-01-01.json").read_text())
        self.assertEqual(checkpoint["pending_chunk"]["chunk_id"], "001-01-01-001")


if __name__ == "__main__":
    unittest.main()
