"""Issue #2034: Method D runs as serial 25-record chunk sessions with a deterministic, idempotent finalization."""
import json
import unittest

from pathlib import Path

from tests.fakes import HEAD1, World
from warroom.github import GhError
from warroom import control, dchunk, prompts

REL = "data/relation-candidates/001/001_01_d_deepseek.jsonl"


class DWorld(World):
    def __init__(self, records=60, **kw):
        super().__init__(**kw)
        index = Path(self.tmp.name) / "approved.sqlite"
        index.write_bytes(b"x")
        self.cfg["corpus_index_path"] = str(index)
        self.runner.dchunk.records = records
        self.git.on_create = self.runner.dchunk.write_canonical
        self.git.local_head = HEAD1

    def row_(self):
        return self.row("deepseek", "d")

    def wt(self):
        return Path(self.row_()["worktree"])

    def active(self):
        return json.loads((self.wt() / dchunk.names(self.row_()).active).read_text())

    def ai(self, code=0, session="ses_d", save=True):
        """Queue a fake AI whose effect saves the active chunk (the `save` call), or nothing."""
        def effect():
            if save:
                self.runner.dchunk.save(self.wt(), self.active()["chunk_no"])
        self.adapter.plan.append({"code": code, "session": session, "effect": effect})

    def ai_rejected(self, code=0, session="ses_d", scope="decisions", stale=False, failed_search_after=False):
        """A fake AI whose `save` is rejected: decisions.txt stays, the CLI's diagnostic for the active chunk is written."""
        def effect():
            rec = self.active()
            folder = self.wt() / dchunk.names(self.row_()).directory
            (folder / "decisions.txt").write_text("s1 Z\n")
            if failed_search_after:   # a search after the rejected save failed: the repairable diagnostic is now stale
                with open(folder / "searches.jsonl", "a") as fh:
                    fh.write(json.dumps({"record_id": "w0001", "status": "SEARCH_FAILED", "hits": 0}) + "\n")
            (folder / "save-rejected.json").write_text(json.dumps({
                "diagnostic": "save_rejected", "chunk_no": rec["chunk_no"],
                "view_sha256": "0" * 64 if stale else rec["view_sha256"], "git_head": rec["git_head"], "repair_scope": scope,
                "senses": ["s1"], "errors": ["s1: Z needs every recorded search of this record to be complete with 0 hits"],
                "error_count": 1}))
        self.adapter.plan.append({"code": code, "session": session, "effect": effect})

    def finish_last(self):
        self.adapter.finish(self.adapter.launches[-1]["pid"])

    def kinds(self):
        return [r["kind"] for r in reversed(self.store.runs(self.row_()["id"]))]

    def run_chunks(self, n):
        for i in range(n):                                              # every plan is queued before a launch consumes it
            self.ai(session=f"ses_{i}")
        for _ in range(n):
            self.tick()
            self.finish_last()
            self.tick()


class SerialChunks(unittest.TestCase):
    def setUp(self):
        self.w = DWorld()
        self.addCleanup(self.w.tmp.cleanup)

    def test_new_session_per_chunk_inline_view_then_one_pr(self):
        w = self.w
        w.start("single", "deepseek", "d")
        for n in range(3):
            w.ai(session=f"ses_{n}")
        w.tick()
        first = w.adapter.launches[-1]
        self.assertEqual(first["stage2_chunk_git"], "1")                 # the lightweight chunk policy
        self.assertTrue(first["git_sandbox_paths"])
        self.assertTrue(first["approved_corpus_db"])
        self.assertIsNone(first["approved_literary_db"])
        self.assertIn(prompts.VIEW_BEGIN, first["prompt"])
        self.assertIn("## w0001", first["prompt"])
        self.assertNotIn("cat .warroom-scratch", first["prompt"])        # inline-first: zero reads
        self.assertNotIn("AGENTS.md를 읽", first["prompt"])
        w.finish_last()
        w.tick()
        for _ in (1, 2):
            w.finish_last()
            w.tick()
        self.assertEqual(w.kinds(), ["d_chunk_new"] * 3)
        self.assertTrue(all(l["kind"] == "start" for l in w.adapter.launches))
        self.assertNotIn("## w0001", w.adapter.launches[2]["prompt"])    # chunk 3 does not carry chunk 1
        b = w.row_()
        self.assertEqual((b["state"], b["pr_number"]), ("WAITING_REVIEW", 100))
        pr = w.gh.created_prs[0]
        self.assertEqual(pr["labels"], ["batch"])
        self.assertRegex(pr["title"], r"^\[D/[^\]]+\] 001_01$")
        self.assertNotIn("1156", pr["body"])
        self.assertIn("- Candidates:", pr["body"])
        self.assertEqual(w.git.commits[0][0], [REL])
        self.assertEqual(w.git.pushes, [b["branch"]])
        self.assertEqual(w.runner.dchunk.validations, 1)                 # the final Candidate v1 check runs once
        assembled = (w.wt() / REL).read_text().splitlines()
        self.assertEqual([json.loads(l)["record_id"] for l in assembled], [r["id"] for r in w.runner.dchunk.rows()])

    def test_all_zero_hit_chunk_is_saved_without_an_ai_session(self):
        w = self.w
        w.runner.dchunk.auto = {2}
        w.start("single", "deepseek", "d")
        w.run_chunks(2)
        self.assertEqual(len(w.adapter.launches), 2)                     # chunks 1 and 3 only
        self.assertEqual(w.row_()["state"], "WAITING_REVIEW")
        self.assertEqual(dchunk.verified_prefix(w.wt(), w.row_()), (3, 3))

    def test_zero_exit_without_saved_chunk_is_not_success_and_retry_resumes_with_a_short_prompt(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai(save=False)
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), 1)
        w.ai()
        self.assertTrue(control.retry(w.store, "deepseek", "d"))
        w.tick(2)
        resume = w.adapter.launches[-1]
        self.assertEqual(resume["kind"], "resume")
        self.assertNotIn(prompts.VIEW_BEGIN, resume["prompt"])           # a resume never puts the view in again
        self.assertNotIn("## w0001", resume["prompt"])
        self.assertLess(len(resume["prompt"]), 2000)

    def test_saved_chunk_survives_an_unclean_exit_and_is_never_produced_again(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai(code=1)
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual(w.kinds(), ["d_chunk_new", "d_chunk_new"])
        self.assertEqual(w.active()["chunk_no"], 2)
        self.assertEqual(len(w.adapter.launches), 2)

    def test_search_failed_pauses_before_any_ai(self):
        w = self.w
        w.runner.dchunk.failed = {1}
        w.start("single", "deepseek", "d")
        w.tick()
        self.assertEqual(w.adapter.launches, [])
        self.assertEqual(w.row_()["state"], "PAUSED")

    def test_editing_a_saved_chunk_is_an_error(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai()
        w.ai()
        w.tick()
        w.finish_last()
        w.tick()                                                         # chunk 1 accepted, chunk 2 running
        w.runner.dchunk.save(w.wt(), 1, lambda sid: ["바뀐 후보"])         # still a structurally valid chunk
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertIn("수정", w.row_()["error"])

    def test_head_and_remote_changes_during_a_run_are_errors(self):
        for what in ("head", "remote"):
            with self.subTest(what):
                w = DWorld()
                self.addCleanup(w.tmp.cleanup)
                w.start("single", "deepseek", "d")
                w.ai()
                w.tick()
                if what == "head":
                    w.git.local_head = "9" * 40
                else:
                    w.git.remote[w.row_()["branch"]] = "e" * 40
                w.finish_last()
                w.tick()
                self.assertEqual(w.row_()["state"], "ERROR")
                self.assertEqual(len(w.adapter.launches), 1)

    def test_foreign_head_before_the_next_chunk_is_an_error(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai()
        w.tick()
        w.git.local_head = "9" * 40
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")

    def test_oversize_view_falls_back_to_pages_for_that_chunk_only(self):
        w = self.w
        w.runner.dchunk.padding = 12_000
        w.start("single", "deepseek", "d")
        w.ai()
        w.tick()
        prompt = w.adapter.launches[-1]["prompt"]
        self.assertNotIn(prompts.VIEW_BEGIN, prompt)
        self.assertIn("cat .warroom-scratch/d-001_01/active-chunk.p1of", prompt)
        self.assertEqual("".join((w.wt() / p).read_text() for p in
                                 [l.split("`")[1].split()[1] for l in prompt.splitlines() if l.strip().startswith("- `cat ")]),
                         (w.wt() / dchunk.names(w.row_()).view).read_text())


class SaveRejectedFix(unittest.TestCase):
    """Issue #2136: a `save` the CLI rejected is corrected in the same session once per chunk, never beyond what its own
    diagnostic says is repairable, and the count survives ticks and restarts until an explicit operator Retry."""

    def setUp(self):
        self.w = DWorld()
        self.addCleanup(self.w.tmp.cleanup)

    def run_once(self):
        self.w.tick()
        self.w.finish_last()
        self.w.tick()

    def test_repairable_rejection_resumes_the_same_session_once_then_continues(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai_rejected()
        w.ai()                                                           # the fix run saves chunk 1
        w.ai(session="ses_2")
        self.run_once()
        self.assertEqual(w.row_()["state"], "PRODUCING")
        fix = w.adapter.launches[-1]
        self.assertEqual((fix["kind"], w.kinds()[-1]), ("resume", "d_chunk_fix"))
        self.assertIn("Z needs every recorded search", fix["prompt"])
        self.assertIn(".warroom-scratch/d-001_01/decisions.txt", fix["prompt"])
        self.assertNotIn(prompts.VIEW_BEGIN, fix["prompt"])
        self.assertNotIn("{{", fix["prompt"])
        w.finish_last()
        w.tick()
        self.assertEqual(dchunk.verified_prefix(w.wt(), w.row_())[0], 1)
        self.assertEqual(w.kinds(), ["d_chunk_new", "d_chunk_fix", "d_chunk_new"])
        self.assertEqual(w.active()["chunk_no"], 2)
        self.assertFalse((w.wt() / dchunk.names(w.row_()).rejected).exists())   # clear_active dropped it

    def test_repeated_rejection_stops_after_the_limit_and_extra_ticks_launch_nothing(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai_rejected()
        w.ai_rejected()
        self.run_once()
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertIn("마지막 save 거부", w.row_()["error"])
        self.assertEqual(len(w.adapter.launches), 2)
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertEqual(w.store.get(dchunk.fix_key(w.row_()["id"], 1)), "1")

    def test_operator_retry_regrants_exactly_one_correction(self):
        w = self.w
        w.start("single", "deepseek", "d")
        for _ in range(3):
            w.ai_rejected()
        self.run_once()
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertTrue(control.retry(w.store, "deepseek", "d"))
        w.tick(2)                                                        # the Retry resumes the chunk (existing path)
        w.finish_last()
        w.tick()
        self.assertEqual(w.kinds()[-1], "d_chunk_fix")                   # ...and a new rejection gets one fresh correction
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")
        w.tick(3)
        self.assertEqual(w.kinds().count("d_chunk_fix"), 2)

    def test_unrepairable_stale_or_missing_diagnostics_start_no_ai(self):
        for label, kw in (("hit-bearing Z", {"scope": "stop_and_report"}), ("stale view", {"stale": True}),
                           ("search failed after the rejection", {"failed_search_after": True})):
            with self.subTest(label):
                w = DWorld()
                self.addCleanup(w.tmp.cleanup)
                w.start("single", "deepseek", "d")
                w.ai_rejected(**kw)
                w.tick()
                w.finish_last()
                w.tick()
                self.assertEqual(w.row_()["state"], "ERROR")
                self.assertEqual(len(w.adapter.launches), 1)
        w = DWorld()                                                     # no CLI diagnostic at all (e.g. SEARCH_FAILED mid-chunk)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "d")
        w.ai(save=False)
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual((w.row_()["state"], len(w.adapter.launches)), ("ERROR", 1))

    def test_nonzero_exit_with_a_repairable_rejection_is_corrected_not_paused(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai_rejected(code=2)
        self.run_once()
        self.assertEqual(w.kinds(), ["d_chunk_new", "d_chunk_fix"])
        self.assertEqual(w.row_()["state"], "PRODUCING")

    def test_completed_chunks_are_untouched_by_a_later_chunks_fix(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai()
        w.ai_rejected(session="ses_2")
        w.tick()
        w.finish_last()
        w.tick()
        before = dchunk.chunk_sha(w.wt(), w.row_(), 1)
        w.finish_last()
        w.tick()
        self.assertEqual(w.kinds(), ["d_chunk_new", "d_chunk_new", "d_chunk_fix"])
        self.assertEqual(dchunk.chunk_sha(w.wt(), w.row_(), 1), before)


class Finalization(unittest.TestCase):
    def setUp(self):
        self.w = DWorld(records=25)
        self.addCleanup(self.w.tmp.cleanup)

    def run_to_finalize(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai()
        w.tick()
        w.finish_last()
        w.tick()
        return w.row_()

    def test_validation_failure_is_an_error_without_commit_or_rewrite_session(self):
        w = self.w
        w.runner.dchunk.validate_error = "Candidate:3:1 candidate repeats source lemma"
        b = self.run_to_finalize()
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("repeats source lemma", b["error"])
        self.assertEqual(getattr(w.git, "commits", []), [])
        self.assertEqual(len(w.adapter.launches), 1)                     # no automatic rewrite / repair session
        self.assertTrue((w.wt() / dchunk.names(b).directory / "chunk-001.jsonl").exists())   # state preserved

    def test_lost_pr_response_never_creates_a_second_pr(self):
        w = self.w
        w.gh.create_pr_error = RuntimeError("timeout")
        w.gh.create_pr_lost = True
        b = self.run_to_finalize()
        self.assertEqual(b["state"], "WAITING_REVIEW")
        self.assertEqual(len(w.gh.created_prs), 1)

    def test_failed_pr_creation_keeps_commit_and_push_and_retry_does_not_repeat_them(self):
        w = self.w
        w.gh.create_pr_error = GhError("gh pr create: boom")
        b = self.run_to_finalize()
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual((len(w.git.commits), len(w.git.pushes)), (1, 1))
        w.gh.create_pr_error = None
        self.assertTrue(control.retry(w.store, "deepseek", "d"))
        w.tick(2)
        self.assertEqual((len(w.git.commits), len(w.git.pushes)), (1, 1))
        self.assertEqual(w.row_()["state"], "WAITING_REVIEW")

    def test_unintended_tracked_change_blocks_the_commit(self):
        w = self.w
        w.git.dirty_text = " M README.md\n"
        self.assertEqual(self.run_to_finalize()["state"], "ERROR")
        self.assertEqual(getattr(w.git, "commits", []), [])

    def test_moved_remote_branch_is_an_error_without_force(self):
        w = self.w
        w.git.remote["d-deepseek-001-01"] = "e" * 40
        self.assertEqual(self.run_to_finalize()["state"], "ERROR")
        self.assertEqual(getattr(w.gh, "created_prs", []), [])

    def test_occupied_batch_by_another_model_stops_instead_of_switching_batches(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai()
        w.tick()
        w.gh.open = [{"number": 9, "headRefName": "d-codex-001-01", "files": [{"path": "data/relation-candidates/001/001_01_d_codex.jsonl"}]}]
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertEqual(getattr(w.gh, "created_prs", []), [])


class CommitRecovery(unittest.TestCase):
    def test_restart_between_commit_and_recording_resumes_but_arbitrary_head_does_not(self):
        for name, child, want in (("our exact commit", True, "WAITING_REVIEW"), ("arbitrary HEAD move", False, "ERROR")):
            with self.subTest(name):
                w = DWorld(records=25)
                self.addCleanup(w.tmp.cleanup)
                real_set, armed = w.store.set, [True]

                def crashing_set(key, value, _real=real_set, _armed=armed):
                    if key.startswith("d_commit_head_") and _armed[0]:
                        _armed[0] = False
                        raise RuntimeError("process died right after the commit")
                    return _real(key, value)
                w.store.set = crashing_set
                w.start("single", "deepseek", "d")
                w.ai()
                w.tick()
                w.finish_last()
                w.tick()
                self.assertEqual(w.row_()["state"], "ERROR")
                self.assertEqual(len(w.git.commits), 1)
                w.git.child_of = (HEAD1, REL) if child else None
                self.assertTrue(control.retry(w.store, "deepseek", "d"))
                w.tick(2)
                self.assertEqual(w.row_()["state"], "WAITING_REVIEW" if want == "WAITING_REVIEW" else "ERROR")
                self.assertEqual(len(w.git.commits), 1)


class VerifiedPrefix(unittest.TestCase):
    """The exact contiguous prefix is the only completion evidence."""

    def setUp(self):
        self.w = DWorld(records=60)
        self.addCleanup(self.w.tmp.cleanup)
        self.b = {"shard": "001", "batch": "01", "producer": "deepseek"}
        self.wt = Path(self.w.tmp.name) / "wt"
        self.w.runner.dchunk.write_canonical(self.wt)
        self.cli = self.w.runner.dchunk
        self.folder = self.wt / dchunk.names(self.b).directory

    def chunk(self, n):
        return self.folder / f"chunk-{n:03d}.jsonl"

    def test_valid_prefixes(self):
        self.assertEqual(dchunk.verified_prefix(self.wt, self.b), (0, 3))
        self.cli.save(self.wt, 1)
        self.assertEqual(dchunk.verified_prefix(self.wt, self.b), (1, 3))
        self.cli.save(self.wt, 2)
        self.cli.save(self.wt, 3)                                        # the last chunk holds the 10 remaining records
        self.assertEqual(dchunk.verified_prefix(self.wt, self.b), (3, 3))

    def test_anomalies_are_errors_not_a_shorter_prefix(self):
        def corrupt(mutate):
            self.cli.save(self.wt, 1)
            mutate()
        rows = lambda n: [json.loads(l) for l in self.chunk(n).read_text().splitlines()]
        write = lambda n, rows_: self.chunk(n).write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows_))

        def gap():
            self.cli.save(self.wt, 3)

        def stray_number():
            (self.folder / "chunk-004.jsonl").write_text("{}\n")

        def tmp_left():
            (self.folder / "chunk-002.jsonl.tmp").write_text("")

        def swapped_records():
            r = rows(1)
            write(1, [r[1], r[0], *r[2:]])

        def missing_record():
            write(1, rows(1)[:-1])

        def extra_key():
            r = rows(1)
            r[0]["note"] = "x"
            write(1, r)

        def sense_order():
            r = rows(1)
            r[2]["senses"].reverse()
            write(1, r)

        def candidates_not_strings():
            r = rows(1)
            r[0]["senses"][0]["candidates"] = [1]
            write(1, r)

        def unparsable():
            self.chunk(1).write_text("not json\n")

        for name, mutate in [("gap", gap), ("stray number", stray_number), ("leftover tmp", tmp_left), ("swapped records", swapped_records),
                             ("missing record", missing_record), ("extra key", extra_key), ("sense order", sense_order),
                             ("non-string candidate", candidates_not_strings), ("unparsable", unparsable)]:
            with self.subTest(name):
                for f in self.folder.glob("chunk-*"):
                    f.unlink()
                corrupt(mutate)
                with self.assertRaises(dchunk.DChunkError):
                    dchunk.verified_prefix(self.wt, self.b)

    def test_assemble_is_byte_exact_idempotent_and_never_overwrites(self):
        for n in (1, 2, 3):
            self.cli.save(self.wt, n)
        out = dchunk.assemble(self.wt, self.b)
        data = (self.wt / out).read_bytes()
        self.assertEqual(data, b"".join(self.chunk(n).read_bytes() for n in (1, 2, 3)))
        self.assertEqual(dchunk.assemble(self.wt, self.b), out)          # same bytes: skipped
        (self.wt / out).write_bytes(b"other\n")
        with self.assertRaises(dchunk.DChunkError):
            dchunk.assemble(self.wt, self.b)
        self.assertEqual((self.wt / out).read_bytes(), b"other\n")

    def test_assemble_needs_every_chunk(self):
        self.cli.save(self.wt, 1)
        with self.assertRaises(dchunk.DChunkError):
            dchunk.assemble(self.wt, self.b)

    def test_pr_body_facts(self):
        body = dchunk.pr_body("Luna", self.b, {"records": 500, "senses": 560, "candidates": 3, "empty_senses": 9})
        self.assertIn("Coverage: 500 records / 560 senses", body)
        self.assertIn("Candidates: 3 (9 empty senses)", body)
        self.assertIn("Candidate v1: validated", body)


class Prompts(unittest.TestCase):
    def test_exactly_one_of_view_or_pages_and_the_card_binds_the_save_call(self):
        b = {"shard": "001", "batch": "01", "branch": "d-x-001-01"}
        with self.assertRaises(prompts.PromptError):
            prompts.d_chunk(b, 1)
        with self.assertRaises(prompts.PromptError):
            prompts.d_chunk(b, 1, view="v\n", pages=["p"])
        card = prompts.d_chunk(b, 3, view="VIEW\n")
        self.assertIn(".warroom-scratch/d-001_01/decisions.txt", card)
        self.assertIn("d-chunk-cli.mjs save --in", card)
        self.assertIn("청크 003", card)
        self.assertNotIn("{{", card)


if __name__ == "__main__":
    unittest.main()
