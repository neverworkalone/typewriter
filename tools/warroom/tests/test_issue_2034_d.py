"""Issue #2034: Method D runs as serial 25-record chunk sessions with a deterministic, idempotent finalization."""
import hashlib
import json
import unittest

from pathlib import Path
from unittest import mock

from tests.fakes import HEAD1, HEAD2, World
from warroom.github import GhError
from warroom import control, dchunk, dparallel, prompts

REL = "data/relation-candidates/001/001_01_d_deepseek.jsonl"


class DWorld(World):
    def __init__(self, records=60, parallel=False, **kw):
        super().__init__(**kw)
        if not parallel:   # a batch already in progress without the mode key finishes on the serial path (#3074)
            patch = mock.patch.object(dparallel.ParallelD, "starts_fresh", lambda self, b: False)
            patch.start()
            cleanup = self.tmp.cleanup
            self.tmp.cleanup = lambda: (patch.stop(), cleanup())[1]
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
        return dchunk.read_active(self.wt(), self.row_())

    def ai(self, code=0, session="ses_d", save=True):
        """Queue a fake AI whose effect saves the active chunk (the `save` call), or nothing."""
        def effect():
            if save:
                self.runner.dchunk.save(self.wt(), self.active()["chunk_no"])
        self.adapter.plan.append({"code": code, "session": session, "effect": effect})

    def ai_rejected(self, code=0, session="ses_d", scope="decisions", stale=False, failed_search_after=False,
                    failed_record=None):
        """A fake AI whose `save` is rejected: decisions.txt stays, the CLI's diagnostic for the active chunk is written."""
        def effect():
            rec = self.active()
            names = dchunk.chunk_names(self.row_(), rec["chunk_no"])
            folder = self.wt() / names.directory
            active = dchunk.read_active(self.wt(), self.row_())
            target_record = failed_record or active["senses"][0]["sense_id"].rsplit("-s", 1)[0]
            sense_id = f"{target_record}-s1"
            sense_ref = next(sense["ref"] for sense in active["senses"]
                             if sense["sense_id"] == sense_id)
            error = (f"{sense_ref}: Z needs every recorded search of this record to be complete with 0 hits "
                     "(a LIMITED, failed, or hit-bearing search cannot support Z; "
                     "decision_state=V_N_ALLOWED searches=1 recorded_hits=4 all_complete=false)")
            (self.wt() / names.decisions).write_text(f"{sense_ref} Z\n")
            if failed_search_after:   # a search after the rejected save failed: the repairable diagnostic is now stale
                with open(self.wt() / names.searches, "a") as fh:
                    fh.write(json.dumps({"record_id": target_record, "status": "SEARCH_FAILED", "hits": 0,
                                         "chunk_no": rec["chunk_no"], "view_sha256": rec["view_sha256"]}) + "\n")
            (self.wt() / names.rejected).write_text(json.dumps({
                "diagnostic": "save_rejected", "chunk_no": rec["chunk_no"],
                "view_sha256": "0" * 64 if stale else rec["view_sha256"], "git_head": rec["git_head"], "repair_scope": scope,
                "senses": [sense_ref], "errors": [error],
                "failed_records": [{"record_id": target_record, "failed_sense_ids": [sense_id],
                                    "errors": [error]}],
                "hit_bearing_z": [sense_ref],
                "decisions_sha256": hashlib.sha256((self.wt() / names.decisions).read_bytes()).hexdigest(),
                "searches_sha256": hashlib.sha256((self.wt() / names.searches).read_bytes()).hexdigest(),
                "error_count": 1}))
        self.adapter.plan.append({"code": code, "session": session, "effect": effect})

    def inspect_rejection(self, rejection, *, repair_scope="decisions", search_failed=False, **changes):
        digest = lambda value: hashlib.sha256(json.dumps(value, ensure_ascii=False,
                                                          separators=(",", ":")).encode("utf-8")).hexdigest()
        summary = {
            "status": "REJECTED", "diagnostic": rejection["diagnostic"], "repair_scope": repair_scope,
            "chunk_no": rejection["chunk_no"], "view_sha256": rejection["view_sha256"],
            "git_head": rejection["git_head"], "senses": rejection["senses"],
            "decisions_sha256": rejection["decisions_sha256"], "searches_sha256": rejection["searches_sha256"],
            "errors_sha256": digest(rejection["errors"]),
            "failed_records_sha256": digest(rejection["failed_records"]),
            "errors_complete": True, "search_failed": search_failed, "error_count": rejection["error_count"],
        }
        self.runner.dchunk.inspection = summary | changes

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
        self.assertEqual(first["d_chunk_cli"], str(dchunk.cli_path()))
        self.assertEqual(first["d_canonical_root"], str(w.wt().resolve()))
        self.assertEqual(first["d_scratch"], str((w.wt() / dchunk.SCRATCH).resolve()))
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
        self.assertEqual(len(w.gh.created_prs), 1)
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

    def test_zero_exit_without_saved_chunk_gets_one_retry_and_operator_retry_resumes_short(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai(save=False)
        w.ai(save=False)
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual((w.adapter.launches[-1]["kind"], len(w.adapter.launches)), ("resume", 2))
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), 2)
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

    def test_verified_chunk_cleanup_is_scoped_and_the_next_chunk_starts_a_new_session(self):
        w = DWorld(records=50)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "d")
        w.ai(session="ses_first")
        w.ai(session="ses_second")
        w.tick()
        b = w.row_()
        first = dchunk.chunk_names(b, 1)
        folder = w.wt() / first.directory
        (w.wt() / first.decisions).write_text("s1 V old\n")
        (w.wt() / first.rejected).write_text("{}\n")
        (folder / "view-001.p1of2.txt").write_text("first page\n")
        (folder / "view-001.p2of2.txt").write_text("second page\n")
        # Stale scratch for another chunk and another batch is preserved and cannot be consumed by chunk 002.
        sibling = {"shard": "001", "batch": "01", "producer": "deepseek"}
        other = dchunk.chunk_names(sibling, 20)
        other_path = w.wt() / other.decisions
        other_path.write_text("keep me\n")
        other_batch = folder.parent / "d-001_02" / "decision-001.txt"
        other_batch.parent.mkdir(parents=True, exist_ok=True)
        other_batch.write_text("other batch\n")

        w.finish_last()
        w.tick()

        self.assertTrue((w.wt() / first.directory / "chunk-001.jsonl").is_file())
        for rel in (first.active, first.view, first.searches, first.decisions, first.rejected,
                    f"{first.directory}/view-001.p1of2.txt", f"{first.directory}/view-001.p2of2.txt"):
            self.assertFalse((w.wt() / rel).exists(), rel)
        self.assertEqual(other_path.read_text(), "keep me\n")
        self.assertEqual(other_batch.read_text(), "other batch\n")
        self.assertEqual((w.row_()["run_kind"], w.adapter.launches[-1]["kind"]), ("d_chunk_new", "start"))
        self.assertEqual(w.active()["chunk_no"], 2)
        self.assertIn("decision-002.txt", w.adapter.launches[-1]["prompt"])
        self.assertNotIn("old\n", w.adapter.launches[-1]["prompt"])
        dchunk.clear_active(w.wt(), b, 1)  # cleanup can be safely repeated for the saved prefix
        self.assertTrue((w.wt() / first.directory / "chunk-001.jsonl").is_file())
        self.assertEqual(w.active()["chunk_no"], 2)
        self.assertTrue((w.wt() / dchunk.chunk_names(b, 2).active).is_file())

    def test_cleanup_failure_blocks_next_chunk_and_preserves_saved_and_active_files(self):
        w = DWorld(records=50)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "d")
        w.ai(session="ses_first")
        w.ai(session="ses_second")
        w.tick()
        active = dchunk.chunk_names(w.row_(), 1)
        real_clear = dchunk.clear_active
        dchunk.clear_active = lambda *args: (_ for _ in ()).throw(dchunk.DChunkError("simulated unlink failure"))
        try:
            w.finish_last()
            w.tick()
        finally:
            dchunk.clear_active = real_clear
        self.assertEqual((w.row_()["state"], len(w.adapter.launches)), ("ERROR", 1))
        self.assertTrue((w.wt() / f"{active.directory}/chunk-001.jsonl").is_file())
        self.assertTrue((w.wt() / active.active).is_file())
        self.assertTrue((w.wt() / active.view).is_file())

    def test_restart_after_cleanup_finishes_handoff_without_resuming_the_old_session(self):
        w = DWorld(records=50)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "d")
        w.ai(session="ses_old")
        w.ai(session="ses_new")
        w.tick()
        real_clear = dchunk.clear_active

        def remove_then_interrupt(worktree, batch, chunk_no):
            (Path(worktree) / dchunk.chunk_names(batch, chunk_no).active).unlink()
            raise dchunk.DChunkError("simulated Supervisor interruption after cleanup")

        dchunk.clear_active = remove_then_interrupt
        try:
            w.finish_last()
            w.tick()
        finally:
            dchunk.clear_active = real_clear
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertIsNotNone(w.store.get(dchunk.run_start_key(w.row_()["id"])))
        self.assertIsNone(dchunk.read_active(w.wt(), w.row_()))
        self.assertTrue((w.wt() / dchunk.chunk_names(w.row_(), 1).view).is_file())

        self.assertTrue(control.retry(w.store, "deepseek", "d"))
        w.tick(2)
        self.assertEqual((w.row_()["run_kind"], w.active()["chunk_no"]), ("d_chunk_new", 2))
        self.assertEqual(w.adapter.launches[-1]["kind"], "start")
        self.assertNotEqual(w.adapter.launches[-1].get("session"), "ses_old")
        self.assertEqual(json.loads(w.store.get(dchunk.run_start_key(w.row_()["id"])))["chunk_no"], 2)
        self.assertFalse((w.wt() / dchunk.chunk_names(w.row_(), 1).view).exists())


    def test_damaged_saved_chunk_is_never_cleaned_or_advanced(self):
        w = DWorld(records=50)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "d")
        w.ai()
        w.ai()
        w.tick()
        b = w.row_()
        files = dchunk.chunk_names(b, 1)
        w.finish_last()
        (w.wt() / f"{files.directory}/chunk-001.jsonl").write_text("{ damaged\n")

        problem = w.make_sup()._d_accept_saved(b)

        self.assertIsNotNone(problem)
        self.assertTrue((w.wt() / f"{files.directory}/chunk-001.jsonl").is_file())
        self.assertTrue((w.wt() / files.active).is_file())
        self.assertTrue((w.wt() / files.view).is_file())
        self.assertEqual(len(w.adapter.launches), 1)

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


    def test_oversize_view_falls_back_to_pages_for_that_chunk_only(self):
        w = self.w
        w.runner.dchunk.padding = 12_000
        w.start("single", "deepseek", "d")
        w.ai()
        w.tick()
        prompt = w.adapter.launches[-1]["prompt"]
        self.assertNotIn(prompts.VIEW_BEGIN, prompt)
        self.assertIn("cat .warroom-scratch/d-001_01/view-001.p1of", prompt)
        self.assertEqual("".join((w.wt() / p).read_text() for p in
                                 [l.split("`")[1].split()[1] for l in prompt.splitlines() if l.strip().startswith("- `cat ")]),
                         (w.wt() / dchunk.chunk_names(w.row_(), 1).view).read_text())


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
        self.assertIn("실제 hit 문맥을 읽고", fix["prompt"])
        self.assertIn("decision_state=V_N_ALLOWED", fix["prompt"])
        self.assertIn(".warroom-scratch/d-001_01/decision-001.txt", fix["prompt"])
        self.assertNotIn(prompts.VIEW_BEGIN, fix["prompt"])
        self.assertNotIn("{{", fix["prompt"])
        w.finish_last()
        w.tick()
        self.assertEqual(dchunk.verified_prefix(w.wt(), w.row_())[0], 1)
        self.assertEqual(w.kinds(), ["d_chunk_new", "d_chunk_fix", "d_chunk_new"])
        self.assertEqual(w.active()["chunk_no"], 2)
        self.assertFalse((w.wt() / dchunk.chunk_names(w.row_(), 1).rejected).exists())   # accepted chunk scratch was removed

    def test_repeated_record_local_rejection_skips_only_that_record_and_continues(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai_rejected(failed_record="w0003")
        w.tick()
        w.finish_last()
        rec = w.active()
        with self.assertRaisesRegex(dchunk.DChunkError, "exhausted fix budget"):
            dchunk.supervisor_skip(w.store, w.runner, w.sup._d_env(w.row_()), w.wt(), w.row_(), rec)
        w.ai_rejected(failed_record="w0003")
        w.tick()
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        w.finish_last()
        w.tick()
        self.assertEqual((w.row_()["state"], w.row_()["run_kind"], w.active()["chunk_no"]),
                         ("PRODUCING", "d_chunk_new", 2))
        self.assertEqual(len(w.adapter.launches), 3)                 # fallback saves chunk 1 and immediately launches chunk 2
        rows = [json.loads(line) for line in (w.wt() / dchunk.names(w.row_()).directory / "chunk-001.jsonl").read_text().splitlines()]
        first = next(row for row in rows if row["record_id"] == "w0003")
        other = next(row for row in rows if row["record_id"] == "w0002")
        self.assertEqual(first["senses"], [
            {"sense_id": "w0003-s1", "candidates": []},
            {"sense_id": "w0003-s2", "candidates": ["후보"]},
        ])
        self.assertTrue(all(sense["candidates"] == ["후보"] for sense in other["senses"]))
        skip = json.loads((w.wt() / dchunk.chunk_names(w.row_(), 1).technical_skips).read_text())
        self.assertEqual((skip["fix_attempts"], skip["skips"][0]["record_id"], skip["skips"][0]["sense_ids"],
                          skip["skips"][0]["failed_sense_ids"]),
                         (1, "w0003", ["w0003-s1", "w0003-s2"], ["w0003-s1"]))
        audit = next(event["msg"] for event in w.store.recent_events()
                     if event["batch_id"] == w.row_()["id"] and "D 기술적 생산 제외:" in event["msg"])
        expected = json.dumps(skip["skips"], ensure_ascii=False, separators=(",", ":"))
        self.assertIn(f"technical_skips={expected}", audit)
        self.assertIn("same-session-fixes=1", audit)
        self.assertIn("실패 Sense만 후보 []로 저장", audit)
        self.assertNotIn("Record 전체", audit)
        self.assertIn("failed_records=w0003:w0003-s1", next(event["msg"] for event in w.store.recent_events()
                     if event["batch_id"] == w.row_()["id"] and "판정 오류" in event["msg"]))
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 3)
        self.assertEqual(w.store.get(dchunk.fix_key(w.row_()["id"], 1)), "1")

    def test_operator_retry_regrants_one_correction_before_the_local_fallback(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai_rejected(session=None)  # without a live session the Supervisor preserves the failure for an operator
        self.run_once()
        self.assertEqual(w.row_()["state"], "ERROR")
        w.ai_rejected(session="ses_retry")
        w.ai_rejected(session="ses_retry")
        self.assertTrue(control.retry(w.store, "deepseek", "d"))
        w.tick(2)
        w.finish_last()
        w.tick()
        self.assertEqual(w.kinds()[-1], "d_chunk_fix")
        w.finish_last()
        w.tick()
        self.assertEqual((w.row_()["state"], w.active()["chunk_no"]), ("PRODUCING", 2))
        self.assertEqual(w.store.get(dchunk.fix_key(w.row_()["id"], 1)), "1")

    def test_unrepairable_or_stale_diagnostics_start_no_ai(self):
        for label, kw in (("search evidence failure", {"scope": "stop_and_report"}), ("stale view", {"stale": True}),
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


class RestartHandoff(unittest.TestCase):
    def setUp(self):
        self.w = DWorld(records=50)
        self.addCleanup(self.w.tmp.cleanup)

    @staticmethod
    def restart(w, records=50):
        w.sup = w.make_sup()
        w.sup_runner_ok()
        w.runner.dchunk.records = records

    def save_first_then_interrupt_next_dispatch(self, w=None):
        w = w or self.w
        w.start("single", "deepseek", "d")
        w.ai(session="ses_first")
        w.ai(session="ses_second")
        w.tick()
        real_next = w.sup._launch_d_next
        w.sup._launch_d_next = lambda _b: (_ for _ in ()).throw(RuntimeError("simulated supervisor restart"))
        w.finish_last()
        w.tick()
        w.sup._launch_d_next = real_next
        return w.row_()

    def test_restart_after_old_baseline_deletion_starts_only_the_next_chunk(self):
        w = self.w
        b = self.save_first_then_interrupt_next_dispatch()
        sha = dchunk.chunk_sha(w.wt(), b, 1)
        self.assertEqual((b["state"], b["run_kind"], b["session_id"]), ("PREPARE", None, None))
        self.assertIsNone(w.store.get(dchunk.run_start_key(b["id"])))

        self.restart(w)
        w.tick()

        self.assertEqual(len(w.adapter.launches), 2)
        self.assertEqual((w.row_()["state"], w.row_()["run_kind"], w.active()["chunk_no"]),
                         ("PRODUCING", "d_chunk_new", 2))
        self.assertEqual(dchunk.chunk_sha(w.wt(), b, 1), sha)

    def test_restart_after_prepare_persisted_but_before_baseline_delete_is_idempotent(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai(session="ses_first")
        w.ai(session="ses_second")
        w.tick()
        b = w.row_()
        key = dchunk.run_start_key(b["id"])
        real_delete = w.store.delete
        armed = [True]

        def interrupt_delete(found):
            if found == key and armed[0]:
                armed[0] = False
                raise RuntimeError("simulated restart before baseline deletion")
            return real_delete(found)

        w.store.delete = interrupt_delete
        w.finish_last()
        w.tick()
        w.store.delete = real_delete
        self.assertEqual(w.row_()["state"], "PREPARE")
        self.assertIsNotNone(w.store.get(key))
        before = dchunk.chunk_sha(w.wt(), b, 1)

        self.restart(w)
        w.tick()

        self.assertEqual(len(w.adapter.launches), 2)
        self.assertEqual(w.active()["chunk_no"], 2)
        self.assertEqual(dchunk.chunk_sha(w.wt(), b, 1), before)

    def test_restart_after_cleanup_before_prepare_marker_uses_existing_baseline(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai(session="ses_first")
        w.ai(session="ses_second")
        w.tick()
        b = w.row_()
        real_update = w.store.update
        armed = [True]

        def interrupt_update(batch_id, **fields):
            if batch_id == b["id"] and fields.get("state") == "PREPARE" and armed[0]:
                armed[0] = False
                raise RuntimeError("simulated restart before PREPARE marker")
            return real_update(batch_id, **fields)

        w.store.update = interrupt_update
        w.finish_last()
        w.tick()
        w.store.update = real_update
        self.assertEqual(w.row_()["state"], "PRODUCING")
        self.assertIsNone(dchunk.read_active(w.wt(), b))
        self.assertIsNotNone(w.store.get(dchunk.run_start_key(b["id"])))

        self.restart(w)
        w.tick()

        self.assertEqual((len(w.adapter.launches), w.active()["chunk_no"]), (2, 2))

    def test_prepare_with_next_chunk_baseline_fails_closed_without_launch(self):
        w = self.w
        b = self.save_first_then_interrupt_next_dispatch()
        rec = dchunk.prepare(w.runner, w.sup._d_env(b), w.wt(), b, 2,
                             str(Path(w.cfg["corpus_index_path"])), HEAD1)
        self.assertEqual(rec["status"], "READY")
        w.store.set(dchunk.run_start_key(b["id"]), json.dumps({"chunk_no": 2}))
        launches = len(w.adapter.launches)

        self.restart(w)
        w.tick()

        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertIn("실행 시작 여부가 모호", w.row_()["error"])
        self.assertEqual(len(w.adapter.launches), launches)

    def test_legacy_missing_baseline_recovers_only_with_complete_run_and_sha_evidence(self):
        w = self.w
        b = self.save_first_then_interrupt_next_dispatch()
        before = dchunk.chunk_sha(w.wt(), b, 1)
        w.store.update(b["id"], state="PRODUCING", run_kind="d_chunk_new")

        self.restart(w)
        w.tick()

        self.assertEqual((w.row_()["state"], w.active()["chunk_no"], len(w.adapter.launches)),
                         ("PRODUCING", 2, 2))
        self.assertEqual(dchunk.chunk_sha(w.wt(), b, 1), before)

    def test_legacy_missing_baseline_rejects_unproven_or_ambiguous_state(self):
        mutations = {
            "sha mismatch": lambda w, b: w.store.set(f"d_chunk_sha_{b['id']}_1", "0" * 64),
            "sha missing": lambda w, b: w.store.delete(f"d_chunk_sha_{b['id']}_1"),
            "completion marker missing": lambda w, b: w.store.delete(f"verified_completion_run_{b['id']}"),
            "changed HEAD": lambda w, b: setattr(w.git, "local_head", HEAD2),
            "changed remote": lambda w, b: w.git.remote.__setitem__(b["branch"], HEAD2),
            "dirty tracked files": lambda w, b: setattr(w.git, "dirty_text", " M README.md"),
            "log mismatch": lambda w, b: w.store.update(b["id"], log_file="/missing/other-run.log"),
            "active next chunk": lambda w, b: dchunk.prepare(w.runner, w.sup._d_env(b), w.wt(), b, 2,
                                                               str(Path(w.cfg["corpus_index_path"])), HEAD1),
        }
        for label, mutate in mutations.items():
            with self.subTest(label=label):
                w = DWorld(records=50)
                self.addCleanup(w.tmp.cleanup)
                b = self.save_first_then_interrupt_next_dispatch(w)
                saved_bytes = (w.wt() / dchunk.chunk_names(b, 1).directory / "chunk-001.jsonl").read_bytes()
                w.store.update(b["id"], state="PRODUCING", run_kind="d_chunk_new")
                mutate(w, b)
                launches = len(w.adapter.launches)
                self.restart(w)

                w.tick()

                self.assertEqual(w.row_()["state"], "ERROR")
                self.assertEqual(len(w.adapter.launches), launches)
                self.assertEqual((w.wt() / dchunk.chunk_names(b, 1).directory / "chunk-001.jsonl").read_bytes(),
                                 saved_bytes)


    def test_legacy_missing_baseline_rejects_an_owned_pr_before_any_new_run(self):
        w = self.w
        b = self.save_first_then_interrupt_next_dispatch()
        w.store.update(b["id"], state="PRODUCING", run_kind="d_chunk_new")
        w.gh.prs[17] = {"number": 17, "state": "closed", "merged": False, "head_sha": HEAD1,
                        "head_ref": b["branch"], "url": "", "merge_commit_sha": ""}
        w.gh.by_branch[b["branch"]] = [{"number": 17, "state": "CLOSED", "headRefOid": HEAD1}]
        w.gh.files[17] = [{"path": f"data/relation-candidates/{b['shard']}/"
                                  f"{b['shard']}_{b['batch']}_d_{b['producer']}.jsonl"}]
        launches = len(w.adapter.launches)

        self.restart(w)
        w.tick()

        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertIn("이미 PR", w.row_()["error"])
        self.assertEqual(len(w.adapter.launches), launches)


    def test_last_chunk_restart_runs_idempotent_finalizer_once(self):
        w = DWorld(records=50)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "d")
        for n in range(2):
            w.ai(session=f"ses_{n + 1}")
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual(w.active()["chunk_no"], 2)
        real_next = w.sup._launch_d_next
        w.sup._launch_d_next = lambda _b: (_ for _ in ()).throw(RuntimeError("restart after final save"))
        w.finish_last()
        w.tick()
        w.sup._launch_d_next = real_next
        self.assertEqual((w.row_()["state"], dchunk.verified_prefix(w.wt(), w.row_())[0]), ("PREPARE", 2))

        self.restart(w, records=50)
        w.tick()
        w.tick(2)

        b = w.row_()
        self.assertEqual(b["state"], "WAITING_REVIEW")
        self.assertEqual((len(w.adapter.launches), len(w.git.commits), len(w.git.pushes), len(w.gh.created_prs)),
                         (2, 1, 1, 1))
        self.assertEqual(w.runner.dchunk.validations, 1)


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

    def test_verified_chunks_allows_gaps_and_waits_only_for_owned_tmp(self):
        self.assertEqual(dchunk.verified_chunks(self.wt, self.b), (set(), 3))
        self.cli.save(self.wt, 3)
        self.cli.save(self.wt, 1)
        self.assertEqual(dchunk.verified_chunks(self.wt, self.b), ({1, 3}, 3))      # 002 missing: a gap, not an error
        with self.assertRaises(dchunk.DChunkError):
            dchunk.verified_prefix(self.wt, self.b)                                 # the serial contract is unchanged
        (self.folder / "chunk-002.jsonl.tmp").write_text("")
        self.assertEqual(dchunk.verified_chunks(self.wt, self.b, running=[2]), ({1, 3}, 3))   # owned save in flight
        for running in ([], [1, 3]):
            with self.assertRaises(dchunk.DChunkError):                              # no owner: preserved as an error
                dchunk.verified_chunks(self.wt, self.b, running=running)
        (self.folder / "chunk-002.jsonl.tmp").unlink()
        (self.folder / "chunk-004.jsonl").write_text("{}\n")
        with self.assertRaises(dchunk.DChunkError):
            dchunk.verified_chunks(self.wt, self.b)
        (self.folder / "chunk-004.jsonl").unlink()
        self.chunk(3).write_text("not json\n")
        with self.assertRaises(dchunk.DChunkError):
            dchunk.verified_chunks(self.wt, self.b)

    def test_explicit_active_chunks_coexist_and_publish_tmp_is_not_damage(self):
        def active(n):
            rec = {"shard": "001", "batch": "01", "model": "deepseek", "chunk_no": n, "view_sha256": "a" * 64,
                   "git_head": "b" * 40, "senses": [{"sense_id": "w0001-s1"}]}
            (self.folder / f"active-{n:03d}.json").write_text(json.dumps(rec))
        self.folder.mkdir(parents=True, exist_ok=True)
        active(1)
        active(2)
        (self.folder / "active-004.json.tmp").write_text("{")                       # another task is publishing
        with self.assertRaises(dchunk.DChunkError):
            dchunk.read_active(self.wt, self.b)                                      # no number: still ambiguous
        self.assertEqual(dchunk.read_active(self.wt, self.b, 2)["chunk_no"], 2)
        self.assertIsNone(dchunk.read_active(self.wt, self.b, 3))
        self.assertEqual(sorted(dchunk.active_chunks(self.wt, self.b)), [1, 2])
        (self.folder / "active-bogus.json").write_text("{}")
        for call in (lambda: dchunk.read_active(self.wt, self.b, 2), lambda: dchunk.active_chunks(self.wt, self.b)):
            with self.assertRaises(dchunk.DChunkError):
                call()
        (self.folder / "active-bogus.json").unlink()
        (self.folder / "active-002.json.tmp").write_text("{")                       # this chunk's own unpublished file
        with self.assertRaises(dchunk.DChunkError):
            dchunk.read_active(self.wt, self.b, 2)

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

    def test_legacy_active_layout_is_preserved_and_blocked(self):
        folder = self.folder
        folder.mkdir(parents=True, exist_ok=True)
        legacy = folder / "active-chunk.json"
        legacy.write_text('{"chunk_no":1}\n')
        (folder / "decisions.txt").write_text("legacy decisions\n")
        with self.assertRaisesRegex(dchunk.DChunkError, "자동 이전·삭제 없이 보존"):
            dchunk.read_active(self.wt, self.b)
        self.assertEqual(legacy.read_text(), '{"chunk_no":1}\n')
        self.assertEqual((folder / "decisions.txt").read_text(), "legacy decisions\n")


class LegacyRejectionRepair(unittest.TestCase):
    def test_old_stop_diagnostic_is_reissued_only_after_current_cli_proves_identical_local_errors(self):
        w = DWorld(records=75)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "d")
        for chunk_no in range(1, 2):
            w.ai(session=f"ses_{chunk_no}")
        w.ai_rejected(session="ses_2", scope="stop_and_report")
        for _ in range(1):
            w.tick()
            w.finish_last()
            w.tick()
        self.assertEqual(w.active()["chunk_no"], 2)
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")

        b = w.row_()
        names = dchunk.chunk_names(b, 2)
        folder = w.wt() / names.directory
        rejected_path = w.wt() / names.rejected
        legacy = json.loads(rejected_path.read_text("utf-8"))
        legacy.pop("hit_bearing_z", None)  # the pre-#2981 persisted schema contains no summary-only field
        rejected_path.write_text(json.dumps(legacy, ensure_ascii=False, separators=(",", ":")), "utf-8")
        w.inspect_rejection(legacy)
        prefix = {number: dchunk.chunk_sha(w.wt(), b, number) for number in range(1, 2)}
        active_before = (w.wt() / names.active).read_bytes()
        decisions_before = (w.wt() / names.decisions).read_bytes()
        searches_before = (w.wt() / names.searches).read_bytes()
        view_before = (w.wt() / names.view).read_bytes()

        w.ai(session="ses_2")
        self.assertTrue(control.retry(w.store, "deepseek", "d"))
        w.tick(2)

        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        reissued = json.loads(rejected_path.read_text("utf-8"))
        self.assertEqual(reissued["repair_scope"], "decisions")
        self.assertEqual({key: value for key, value in reissued.items() if key != "repair_scope"},
                         {key: value for key, value in legacy.items() if key != "repair_scope"})
        self.assertEqual((w.wt() / names.active).read_bytes(), active_before)
        self.assertEqual((w.wt() / names.decisions).read_bytes(), decisions_before)
        self.assertEqual((w.wt() / names.searches).read_bytes(), searches_before)
        self.assertEqual((w.wt() / names.view).read_bytes(), view_before)
        self.assertTrue(any(call[0] == "node" and Path(call[1]) == dchunk.cli_path() and call[2] == "inspect"
                            and call[call.index("--canonical-root") + 1] == str(w.wt().resolve())
                            for call in w.runner.dchunk.calls))
        for number, digest in prefix.items():
            self.assertEqual(dchunk.chunk_sha(w.wt(), b, number), digest)

        w.finish_last()
        w.tick()
        self.assertTrue((folder / "chunk-002.jsonl").is_file())
        self.assertEqual(w.active()["chunk_no"], 3)
        saved = [json.loads(line) for line in (folder / "chunk-002.jsonl").read_text("utf-8").splitlines()]
        self.assertEqual(len(saved), 25)
        self.assertTrue(all(sense["candidates"] == ["후보"] for row in saved for sense in row["senses"]))
        for number, digest in prefix.items():
            self.assertEqual(dchunk.chunk_sha(w.wt(), b, number), digest)

    def test_search_failure_evidence_mismatch_and_head_drift_block_reissue_without_launch(self):
        cases = (
            ("search failure", {"repair_scope": "stop_and_report", "search_failed": True}, None,
             "legacy_rejection_reissue_blocked[search_failure]"),
            ("diagnostic mismatch", {"repair_scope": "decisions"}, {"decisions_sha256": "0" * 64},
             "legacy_rejection_reissue_blocked[diagnostic_evidence_mismatch]"),
            ("head drift", {"repair_scope": "decisions"}, {"head": HEAD2},
             "legacy_rejection_reissue_blocked[head_mismatch]"),
        )
        for label, inspection_options, mutation, expected in cases:
            with self.subTest(label=label):
                w = DWorld(records=50)
                self.addCleanup(w.tmp.cleanup)
                w.start("single", "deepseek", "d")
                w.ai_rejected(scope="stop_and_report")
                w.tick()
                w.finish_last()
                w.tick()
                b = w.row_()
                names = dchunk.chunk_names(b, 1)
                rejected_path = w.wt() / names.rejected
                legacy = json.loads(rejected_path.read_text("utf-8"))
                legacy.pop("hit_bearing_z", None)
                rejected_path.write_text(json.dumps(legacy, ensure_ascii=False, separators=(",", ":")), "utf-8")
                options = dict(inspection_options)
                changes = mutation if mutation and "decisions_sha256" in mutation else {}
                if mutation and "head" in mutation:
                    w.git.local_head = mutation["head"]
                w.inspect_rejection(legacy, **options, **changes)
                prior_bytes = rejected_path.read_bytes()
                launches = len(w.adapter.launches)

                self.assertTrue(control.retry(w.store, "deepseek", "d"))
                w.tick(2)

                self.assertEqual(w.row_()["state"], "ERROR")
                self.assertIn(expected, w.row_()["error"])
                self.assertEqual(len(w.adapter.launches), launches)
                self.assertEqual(rejected_path.read_bytes(), prior_bytes)
                self.assertTrue((w.wt() / names.active).is_file())

    def test_malformed_or_unsupported_rejection_files_block_retry_without_rewrite_or_launch(self):
        cases = (
            ("JSON scalar", '"not an object"\n', "diagnostic_shape_mismatch"),
            ("unknown repair scope", None, "unsupported_repair_scope"),
        )
        for label, replacement, reason in cases:
            with self.subTest(label=label):
                w = DWorld(records=50)
                self.addCleanup(w.tmp.cleanup)
                w.start("single", "deepseek", "d")
                w.ai_rejected(scope="stop_and_report")
                w.tick()
                w.finish_last()
                w.tick()

                b = w.row_()
                names = dchunk.chunk_names(b, 1)
                rejected_path = w.wt() / names.rejected
                if replacement is None:
                    diagnostic = json.loads(rejected_path.read_text("utf-8"))
                    diagnostic["repair_scope"] = "unsupported_future_scope"
                    replacement = json.dumps(diagnostic, ensure_ascii=False, separators=(",", ":")) + "\n"
                rejected_path.write_text(replacement, encoding="utf-8")
                prior_bytes = rejected_path.read_bytes()
                launches = len(w.adapter.launches)

                self.assertTrue(control.retry(w.store, "deepseek", "d"))
                w.tick(2)

                self.assertEqual(w.row_()["state"], "ERROR")
                self.assertIn(f"legacy_rejection_reissue_blocked[{reason}]", w.row_()["error"])
                self.assertEqual(len(w.adapter.launches), launches)
                self.assertEqual(rejected_path.read_bytes(), prior_bytes)
                self.assertTrue((w.wt() / names.active).is_file())


class Prompts(unittest.TestCase):

    def test_exactly_one_of_view_or_pages_and_the_card_binds_the_save_call(self):
        b = {"shard": "001", "batch": "01", "branch": "d-x-001-01"}
        with self.assertRaises(prompts.PromptError):
            prompts.d_chunk(b, 1)
        with self.assertRaises(prompts.PromptError):
            prompts.d_chunk(b, 1, view="v\n", pages=["p"])
        card = prompts.d_chunk(b, 3, view="VIEW\n")
        self.assertIn('TYPEWRITER_D_SCRATCH/d-001_01/decision-003.txt', card)
        self.assertIn('node "$TYPEWRITER_D_CHUNK_CLI" save --chunk 003 --in', card)
        self.assertIn('--dir "$TYPEWRITER_D_SCRATCH" --canonical-root "$TYPEWRITER_D_CANONICAL_ROOT"', card)
        self.assertNotIn("{{", card)

    def test_d_worker_prompts_keep_prepare_supervisor_only(self):
        b = {"shard": "001", "batch": "01", "branch": "d-x-001-01"}
        prompts_to_check = (
            prompts.d_chunk(b, 3, view="VIEW\n"),
            prompts.d_chunk_resume(3, decisions="decision-003.txt", searches="search-003.jsonl"),
            prompts.d_chunk_fix(b, 3, "fixture rejection"),
        )
        boundary = "`prepare`는 Supervisor 전용이며 작업자 세션에서는 호출하지 않는다."
        for prompt in prompts_to_check:
            with self.subTest(prompt=prompt[:24]):
                self.assertIn(boundary, prompt)
                self.assertIn("view가 없거나 불완전하면 `prepare`를 시도하지 말고", prompt)

    def test_d_chunk_prompt_requires_explicit_record_binding_on_each_sense_row(self):
        b = {"shard": "081", "batch": "01", "branch": "d-codex-081-01"}
        card = prompts.d_chunk(b, 2, view="## w110620 말국\ns22 [record=w110620] w110620-s2 [noun] 뜻\n")
        self.assertIn("sN [record=<record_id>] <sense_id> [<pos>] <gloss>", card)
        self.assertIn("`sN` 행의 `[record=…]`와 `sense_id`를 확인한다", card)


if __name__ == "__main__":
    unittest.main()
