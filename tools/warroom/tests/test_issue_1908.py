"""Issue #1908: each Stage 2 checkpoint chunk has an independent run, with saved-decision progress."""
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from tests.test_issue_1684 import S2, merge_part, s2_world as _s2_world
from tests.fakes import HEAD1, HEAD2
from tests.test_claude_adapter import init, result, stream
from tests.test_issue_1832 import Reporting
from warroom import control, progress, stage2
from warroom.gitops import GitError


def s2_world(test):
    """A Stage 2 world whose fake `prepare` writes the two-candidate Part these tests save chunk by chunk."""
    w = _s2_world(test)
    w.git.chunk_view_total = 2
    return w


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
        self.assertTrue(json.loads(first["git_sandbox_paths"]))
        self.assertEqual(first["git_sandbox_paths"], second["git_sandbox_paths"])
        real_git = str(Path(shutil.which("git", path=os.environ.get("PATH", os.defpath))).resolve())
        for worker_path in (first["worker_path"], second["worker_path"]):
            self.assertEqual(shutil.which("git", path=worker_path), first["git_shim"])
            self.assertIn(real_git, json.loads(first["git_sandbox_paths"]))
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
        self.assertIsNone(final.get("git_sandbox_paths"))
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


class Stage2ChunkView(unittest.TestCase):
    """The Supervisor renders the compact chunk view itself; the AI only reads it, judges and saves."""

    def test_supervisor_prepares_and_renders_each_chunk_before_a_self_contained_prompt(self):
        w = s2_world(self)
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.adapter.plan.append({"code": 0, "session": "ses_chunk_1", "effect": lambda: write_state(
            w.store.active_batch("claude", S2), decided=1, total=2, next_chunk=2)})
        w.tick()
        b = w.store.active_batch("claude", S2)
        wt = str(b["worktree"])
        self.assertEqual(w.git.chunk_views, [(wt, "001", "01", "01", True)])
        self.assertTrue((Path(wt) / ".warroom-scratch" / "active-chunk.txt").is_file())
        prompt = w.adapter.launches[-1]["prompt"]
        for needed in ("active-chunk.txt", "--format compact", "decisions.txt", "연상 Tier 1"):
            self.assertIn(needed, prompt)
        for gone in ("docs/relation-factory.md을 읽", "prepare --shard", "read-chunk --checkpoint"):
            self.assertNotIn(gone, prompt)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.git.chunk_views[-1], (wt, "001", "01", "01", False))  # an existing checkpoint is reused
        self.assertEqual(w.store.batch(b["id"])["run_kind"], "s2_chunk_new")

    def test_a_failed_chunk_view_starts_no_ai(self):
        w = s2_world(self)
        w.git.chunk_view_error = GitError("admission-cli prepare 실패: inputs incomplete")
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["state"], len(w.adapter.launches)), ("ERROR", 0))
        self.assertIn("admission-cli prepare 실패", b["error"])

    def test_a_part_with_nothing_to_judge_goes_straight_to_finalize(self):
        w = s2_world(self)
        w.git.chunk_view_total = 0
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["run_kind"], len(w.adapter.launches)), ("s2_finalize_new", 1))
        self.assertIn("finalize", w.adapter.launches[-1]["prompt"])


class Stage2ChunkPages(unittest.TestCase):
    """Each page of the compact view must reach the model whole in one tool call (Codex: 10,000 tokens = bytes/4)."""

    def test_pages_rejoin_exactly_and_each_fits_one_tool_call(self):
        hangul = "T{}\tw{}-s1\tw{}\t사제\tnoun\t" + "스승과 제자를 아울러 이르는 말. " * 6 + "\n"
        ascii_line = "c{}\tcandidate\ta_codex,b_claude\tT1,T2,T3,T4,T5,T6,T7,T8\n"
        cases = {
            "one short line": "# Stage 2 chunk 001-01-03-001\n",
            "no trailing newline": "# head\nc1\t말\ta_codex\t-",
            "large Korean chunk": "".join(hangul.format(i, i, i) for i in range(1, 1500)),
            "ASCII-heavy (character budget binds)": "".join(ascii_line.format(i) for i in range(1, 2000)),
            "exactly one full page": "x" * (stage2.PAGE_MAX_CHARS - 1) + "\n",
            "one byte over a page": "가" * 11_999 + "\n" + "나\n",
        }
        for name, text in cases.items():
            with self.subTest(name):
                pages = stage2.chunk_pages(text)
                self.assertEqual("".join(pages), text)          # nothing dropped, duplicated or reordered
                for page in pages:
                    self.assertLessEqual(len(page.encode("utf-8")), stage2.PAGE_MAX_BYTES)
                    self.assertLessEqual(len(page), stage2.PAGE_MAX_CHARS)
                    self.assertLessEqual(len(page.encode("utf-8")) / 4, 9_000)   # Codex token estimate, with margin
                    self.assertTrue(page.endswith("\n") or page is pages[-1])    # pages break only between lines
        self.assertGreater(len(stage2.chunk_pages(cases["large Korean chunk"])), 1)
        with self.assertRaises(ValueError):
            stage2.chunk_pages("가" * 20_000 + "\n")             # one line cannot be split without cutting a gloss

    def test_written_pages_replace_stale_ones_and_one_page_is_the_view_itself(self):
        with tempfile.TemporaryDirectory() as d:
            scratch = Path(d) / ".warroom-scratch"
            scratch.mkdir()
            view = scratch / "active-chunk.txt"
            view.write_text("가나다\n" * 20_000, "utf-8")
            paths = stage2.write_chunk_pages(d)
            self.assertGreater(len(paths), 1)
            self.assertEqual("".join((Path(d) / p).read_text("utf-8") for p in paths), view.read_text("utf-8"))
            view.write_text("# small\n", "utf-8")
            self.assertEqual(stage2.write_chunk_pages(d), [stage2.CHUNK_VIEW])
            self.assertEqual(list(scratch.glob("active-chunk.p*of*.txt")), [])   # an earlier chunk's pages are gone

    def test_supervisor_lists_every_page_in_order_and_refuses_an_unpageable_view(self):
        w = s2_world(self)
        w.git.chunk_view_text = "T1\tw1-s1\tw1\t말\tnoun\t" + "뜻풀이 " * 10 + "\n"
        w.git.chunk_view_text *= 900
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        prompt = w.adapter.launches[-1]["prompt"]
        wt = Path(w.store.active_batch("claude", S2)["worktree"])
        pages = sorted((wt / ".warroom-scratch").glob("active-chunk.p*of*.txt"))
        self.assertGreater(len(pages), 1)
        for i in range(1, len(pages) + 1):
            self.assertIn(f"cat .warroom-scratch/active-chunk.p{i}of{len(pages)}.txt` ({i}/{len(pages)})", prompt)
        self.assertIn("max_output_tokens: 10000", prompt)

        w2 = s2_world(self)
        w2.git.chunk_view_text = "가" * 20_000 + "\n"
        control.start(w2.store, "claude", S2, "single", cfg=w2.cfg)
        w2.tick()
        b = w2.store.active_batch("claude", S2)
        self.assertEqual((b["state"], len(w2.adapter.launches)), ("ERROR", 0))


class Stage2ChunkCodexConfig(unittest.TestCase):
    def test_only_chunk_runs_disable_web_search_and_project_docs(self):
        from tests.test_codex_adapter import GIT_DIR, Recording
        from warroom.adapters import RunSpec
        run = RunSpec("gpt-6-luna", "xhigh", "worktree")
        chunk_env = {"WARROOM_STAGE2_CHUNK": "1", "WARROOM_GIT_EXECUTABLES": json.dumps(["/usr/bin/git"])}
        for env, expected in ((chunk_env, True), ({}, False)):
            with self.subTest(chunk=expected), tempfile.TemporaryDirectory() as d:
                log, ex = Path(d) / "l.log", Path(d) / "l.exit"
                a = Recording("codex")
                a.start("p", d, env, run, "t", log, ex, git_dir=GIT_DIR)
                start = a.cmd
                a.resume("019a0000-0000-7000-8000-000000000000", "p", d, env, run, log, ex, git_dir=GIT_DIR)
                for argv in (start, a.cmd):
                    self.assertEqual('web_search="disabled"' in argv, expected)
                    self.assertEqual("project_doc_max_bytes=0" in argv, expected)
                    self.assertEqual(argv[-1], "p")


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
