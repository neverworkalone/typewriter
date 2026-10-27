"""Issue #2033 (PR 2): Method C runs as serial chunk sessions with a deterministic, idempotent finalization."""
import json
import unittest
from pathlib import Path

from tests.fakes import HEAD1, World
from warroom import control, literary, prompts, stage2

CP_NAME = "001_01_c_deepseek.checkpoint.json"


class CWorld(World):
    def __init__(self, senses=30, **kw):
        super().__init__(**kw)
        index = Path(self.tmp.name) / "approved.sqlite"
        index.write_bytes(b"x")
        self.cfg["literary_index_path"] = str(index)
        self.runner.literary.senses = senses
        self.runner.literary.head = HEAD1

    def wt(self):
        return Path(self.row("deepseek", "c")["worktree"])

    def active(self):
        return json.loads((self.wt() / literary.ACTIVE).read_text())

    def ai(self, mark=None, code=0, session="ses_c"):
        """Queue a fake AI whose effect stores the active chunk's senses (or only `mark` of them)."""
        def effect():
            ids = self.active()["sense_ids"]
            self.runner.literary.mark(self.wt(), f".warroom-scratch/{CP_NAME}", ids if mark is None else ids[:mark])
        self.adapter.plan.append({"code": code, "session": session, "effect": effect})

    def finish_last(self):
        self.adapter.finish(self.adapter.launches[-1]["pid"])

    def kinds(self):
        return [r["kind"] for r in reversed(self.store.runs(self.row("deepseek", "c")["id"]))]


class SerialChunks(unittest.TestCase):
    def setUp(self):
        self.w = CWorld()
        self.addCleanup(self.w.tmp.cleanup)

    def test_new_session_per_chunk_inline_view_then_one_pr(self):
        w = self.w
        w.start("single", "deepseek", "c")
        for n in range(3):
            w.ai(session=f"ses_{n}")
        for n in range(3):
            w.tick()
            if n == 0:   # init exactly once, the card carries the whole view and the chunk policy env
                launch = w.adapter.launches[-1]
                self.assertEqual(launch["stage2_chunk_git"], "1")
                self.assertTrue(launch["approved_literary_db"])
                ids = w.active()["sense_ids"]
                self.assertEqual(len(ids), 12)
                self.assertTrue(all(f"## {i} — " in launch["prompt"] for i in ids))
                self.assertIn(prompts.VIEW_BEGIN, launch["prompt"])
                self.assertNotIn("cat .warroom-scratch", launch["prompt"])
                self.assertNotIn("AGENTS.md를 읽", launch["prompt"])
            w.finish_last()
            w.tick()
        self.assertEqual(w.kinds(), ["c_chunk_new"] * 3)
        self.assertTrue(all(l["kind"] == "start" for l in w.adapter.launches))   # never a resume of an old chunk
        prompts_ = [l["prompt"] for l in w.adapter.launches]
        self.assertNotIn("s0000 —", prompts_[2])    # chunk 3 does not carry chunk 1's text
        self.assertEqual(sum(1 for c in w.runner.literary.calls if c[2] == "init"), 1)
        b = w.row("deepseek", "c")
        self.assertEqual(b["state"], "WAITING_REVIEW")
        self.assertEqual(b["pr_number"], 100)
        pr = w.gh.created_prs[0]
        self.assertEqual(pr["labels"], ["batch"])
        self.assertRegex(pr["title"], r"^\[C/[^\]]+\] 001_01$")
        self.assertEqual([l.split(":")[0] for l in pr["body"].splitlines()],
                         ["- Method", "- Model", "- Shard", "- Batch", "- Coverage", "- Candidates"])
        self.assertNotIn("1155", pr["body"])
        self.assertEqual(w.git.commits[0][0], ["data/relation-candidates/001/001_01_c_deepseek.jsonl"])
        self.assertEqual(w.git.pushes, [b["branch"]])
        self.assertEqual(w.runner.literary.exports, 1)

    def test_zero_exit_without_checkpoint_evidence_is_not_success_and_retry_resumes_only_the_rest(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai(mark=5)
        w.tick()
        ids = w.active()["sense_ids"]
        w.finish_last()
        w.tick()
        b = w.row("deepseek", "c")
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), 1)
        # Retry continues the same chunk in the same session with only the open sense ids, never the chunk body.
        w.ai()
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.tick(2)
        resume = w.adapter.launches[-1]
        self.assertEqual(resume["kind"], "resume")
        self.assertNotIn(prompts.VIEW_BEGIN, resume["prompt"])
        self.assertNotIn("원문", resume["prompt"])
        for done in ids[:5]:
            self.assertNotIn(done, resume["prompt"])
        for left in ids[5:]:
            self.assertIn(left, resume["prompt"])

    def test_saved_submit_survives_an_unclean_exit(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai(code=1)   # submit stored, then the CLI died
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual(w.kinds()[:2], ["c_chunk_new", "c_chunk_new"])   # moved on to a NEW chunk, not a re-run
        self.assertEqual(len(w.adapter.launches), 2)

    def test_search_failed_stops_before_any_ai(self):
        w = self.w
        w.runner.literary.chunk_status["s0003"] = "SEARCH_FAILED"
        w.start("single", "deepseek", "c")
        w.tick()
        self.assertEqual(w.adapter.launches, [])
        self.assertEqual(w.row("deepseek", "c")["state"], "PAUSED")

    def test_restart_never_reinitializes_a_checkpoint(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()
        w.finish_last()
        w.tick()
        literary_cli = w.runner.literary
        w.sup = w.make_sup()   # Supervisor restart: new process, same files
        w.runner.literary = literary_cli
        b = w.row("deepseek", "c")
        w.sup._launch_c_next(w.store.batch(b["id"]))
        self.assertEqual(sum(1 for c in w.runner.literary.calls if c[2] == "init"), 1)

    def test_foreign_checkpoint_head_is_an_error_and_nothing_is_overwritten(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()
        w.finish_last()
        w.git.local_head = "9" * 40   # HEAD moved by something that is not our commit
        w.tick()
        self.assertEqual(w.row("deepseek", "c")["state"], "ERROR")

    def test_oversize_view_falls_back_to_pages_for_that_chunk_only(self):
        w = self.w
        w.runner.literary.senses = 12
        orig = literary.INLINE_MAX_PROMPT_BYTES
        literary.INLINE_MAX_PROMPT_BYTES = 3_000   # card alone is bigger: forces the page path
        self.addCleanup(setattr, literary, "INLINE_MAX_PROMPT_BYTES", orig)
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()
        prompt = w.adapter.launches[-1]["prompt"]
        self.assertNotIn(prompts.VIEW_BEGIN, prompt)
        self.assertIn("cat .warroom-scratch/c-active-chunk", prompt)


class Finalization(unittest.TestCase):
    def setUp(self):
        self.w = CWorld(senses=12)
        self.addCleanup(self.w.tmp.cleanup)

    def run_to_finalize(self, tick_after=True):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()
        w.finish_last()
        if tick_after:
            w.tick()
        return w.row("deepseek", "c")

    def test_lost_pr_response_never_creates_a_second_pr(self):
        w = self.w
        w.gh.create_pr_error = RuntimeError("timeout")
        w.gh.create_pr_lost = True   # the PR exists although the answer was lost
        b = self.run_to_finalize()
        self.assertEqual(b["state"], "WAITING_REVIEW")
        self.assertEqual(len(w.gh.created_prs), 1)

    def test_failed_pr_creation_keeps_commit_and_push_and_retry_does_not_repeat_them(self):
        w = self.w
        w.gh.create_pr_error = RuntimeError("boom")
        b = self.run_to_finalize()
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual((len(w.git.commits), len(w.git.pushes)), (1, 1))
        w.gh.create_pr_error = None
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.tick(2)
        self.assertEqual((len(w.git.commits), len(w.git.pushes), w.runner.literary.exports), (1, 1, 1))
        self.assertEqual(w.row("deepseek", "c")["state"], "WAITING_REVIEW")

    def test_unintended_tracked_change_blocks_the_commit(self):
        w = self.w
        w.git.dirty_text = " M README.md\n"
        b = self.run_to_finalize()
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(getattr(w.git, "commits", []), [])
        self.assertEqual(w.gh.created_prs if hasattr(w.gh, "created_prs") else [], [])

    def test_moved_remote_branch_is_an_error_without_force(self):
        w = self.w
        w.git.remote[w.row("deepseek", "c")["branch"] if w.row("deepseek", "c") else "c-deepseek-001-01"] = "e" * 40
        b = self.run_to_finalize()
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(getattr(w.gh, "created_prs", []), [])

    def test_occupied_batch_stops_instead_of_switching_batches(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()   # the batch is assigned and its chunk running; only then does a rival PR claim the same C batch
        w.gh.open = [{"number": 9, "headRefName": "c-codex-001-01", "files": [{"path": "data/relation-candidates/001/001_01_c_codex.jsonl"}]}]
        w.finish_last()
        w.tick()
        b = w.row("deepseek", "c")
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(getattr(w.gh, "created_prs", []), [])

    def test_candidate_v1_rejection_reopens_only_the_named_senses(self):
        w = self.w
        w.runner.literary.export_error = json.dumps({"status": "FAILED", "diagnostic": "candidate_validation",
                                                      "affected": {"sense_ids": ["s0002", "s0007"]}})

        def resubmit():   # the repair run changes the checkpoint (a successful submit); export is then accepted
            w.runner.literary.mark(w.wt(), f".warroom-scratch/{CP_NAME}", ["s0002", "s0007"])
            w.runner.literary.export_error = None
        w.start("single", "deepseek", "c")
        w.ai()
        w.adapter.plan.append({"code": 0, "session": "ses_r", "effect": resubmit})
        w.tick()
        w.finish_last()
        w.tick()
        rec = json.loads((w.wt() / literary.ACTIVE).read_text())
        self.assertTrue(rec["repair"])
        self.assertEqual(rec["sense_ids"], ["s0002", "s0007"])
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertIn("s0002", w.adapter.launches[-1]["prompt"])
        self.assertNotIn("s0005 —", w.adapter.launches[-1]["prompt"])
        w.finish_last()
        w.tick()
        self.assertEqual(w.row("deepseek", "c")["state"], "WAITING_REVIEW")
        self.assertEqual(len(w.gh.created_prs), 1)


class CommitRecovery(unittest.TestCase):
    def test_restart_between_commit_and_recording_resumes_but_arbitrary_head_does_not(self):
        rel = "data/relation-candidates/001/001_01_c_deepseek.jsonl"
        for name, child, want in (("our exact commit", True, "WAITING_REVIEW"), ("arbitrary HEAD move", False, "ERROR")):
            with self.subTest(name):
                w = CWorld(senses=12)
                self.addCleanup(w.tmp.cleanup)
                real_set, armed = w.store.set, [True]

                def crashing_set(key, value, _real=real_set, _armed=armed):
                    if key.startswith("c_commit_head_") and _armed[0]:
                        _armed[0] = False
                        raise RuntimeError("process died right after the commit")
                    return _real(key, value)
                w.store.set = crashing_set
                w.start("single", "deepseek", "c")
                w.ai()
                w.tick()
                w.finish_last()
                w.tick()   # commit happened, its HEAD was never recorded
                self.assertEqual(w.row("deepseek", "c")["state"], "ERROR")
                self.assertEqual(len(w.git.commits), 1)
                w.git.child_of = (HEAD1, rel) if child else None
                self.assertTrue(control.retry(w.store, "deepseek", "c"))
                w.tick(2)
                self.assertEqual(w.row("deepseek", "c")["state"], want)
                self.assertEqual(len(w.git.commits), 1)   # never a second commit


class PureHelpers(unittest.TestCase):
    def test_view_ids_table(self):
        view = ("batch=001_01 done=0/5 zero_hit=0 not_yet_read=0\n\n## a1 — 표제 [noun]\n뜻\nhits=1 unseen=0\n[k] 출처\n"
                "본문 ## x — 가짜\n\n## a2 — SEARCH_FAILED\n\n## a3 — UNSEARCHABLE\n")
        self.assertEqual(literary.view_ids(view), (["a1", "a2", "a3"], ["a2"], ["a3"]))
        self.assertEqual(literary.view_ids("batch=001_01 done=5/5 zero_hit=2 not_yet_read=0\n\n"), ([], [], []))
        self.assertEqual(literary.progress_numbers(view), (0, 5, 0, 0))
        with self.assertRaises(literary.LiteraryError):
            literary.progress_numbers("nonsense")

    def test_delivery_and_pages_are_lossless(self):
        view = "".join(f"줄 {i} 한국어 원문\n" for i in range(5000))
        self.assertEqual(literary.delivery(8000, view), "pages")
        self.assertEqual(literary.delivery(8000, "짧은 view\n"), "inline")
        self.assertEqual("".join(stage2.chunk_pages(view)), view)
        with self.assertRaises(ValueError):
            stage2.chunk_pages("가" * 30_000 + "\n")   # an over-long single line is never cut

    def test_affected_senses(self):
        ok = json.dumps({"diagnostic": "candidate_validation", "affected": {"sense_id": "s1"}})
        many = json.dumps({"diagnostic": "candidate_validation", "affected": {"sense_ids": ["s1", "s2", "bad id"]}})
        for text, want in [(ok, ["s1"]), (many, ["s1", "s2"]), ("not json", []), ("", []),
                           (json.dumps({"diagnostic": "other", "affected": {"sense_id": "s1"}}), [])]:
            self.assertEqual(literary.affected_senses(text), want)

    def test_pr_body_has_exactly_six_items(self):
        b = {"shard": "001", "batch": "01"}
        body = literary.pr_body("Luna", b, {"records": 500, "senses": 560, "candidates": 3})
        self.assertEqual(len(body.strip().splitlines()), 6)
        self.assertIn("Coverage: 500 records / 560 senses", body)


if __name__ == "__main__":
    unittest.main()
