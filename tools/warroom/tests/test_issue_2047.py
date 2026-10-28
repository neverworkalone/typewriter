"""Issue #2047: a Stage 2 chunk run is answer-only; the Supervisor stores the decisions, runs save-chunk and
corrects only the rejected rows in the same session (at most twice)."""
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.test_issue_1684 import S2
from tests.test_issue_1908 import s2_world
from warroom import control, prompts, stage2

CHUNK = "001-01-01-001"
GOOD = f"chunk {CHUNK}\nc1 D first\nc2 D second"


def answer(text):
    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n"


class AnswerOnlyChunk(unittest.TestCase):
    def world(self, *plans):
        w = s2_world(self)
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.adapter.plan.extend(plans)
        w.tick()
        return w, w.store.active_batch("claude", S2)

    def finish(self, w, b, ticks=2):
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick(ticks)
        return w.store.batch(b["id"])

    def failures(self, w, b):
        return [r["submit_failures"] or 0 for r in reversed(w.store.runs(b["id"]))]

    def decisions(self, b):
        return (Path(b["worktree"]) / stage2.DECISIONS).read_text("utf-8")

    def test_new_chunk_carries_the_whole_view_and_its_answer_is_saved_by_the_supervisor(self):
        w, b = self.world({"code": 0, "session": "s1", "text": answer(GOOD)})
        first = w.adapter.launches[0]
        self.assertIn(Path(b["worktree"]).joinpath(stage2.CHUNK_VIEW).read_text("utf-8"), first["prompt"])
        self.assertIn(f"chunk {CHUNK}", first["prompt"])
        self.assertNotIn("cat .warroom-scratch", first["prompt"])
        b = self.finish(w, b)
        self.assertEqual(self.decisions(b), GOOD + "\n")
        self.assertEqual(len(w.git.save_calls), 1)
        self.assertEqual(self.failures(w, b)[0], 0)
        self.assertEqual((b["run_kind"], w.adapter.launches[-1]["kind"]), ("s2_deterministic_finalize", "start"))   # saved: next step

    def test_nonzero_exit_with_the_current_header_is_saved_but_a_headerless_text_is_no_response(self):
        w, b = self.world({"code": 2, "session": "s1", "text": answer(GOOD)})
        b = self.finish(w, b)
        self.assertEqual(b["run_kind"], "s2_deterministic_finalize")
        self.assertEqual(len(w.git.save_calls), 1)
        for text in ("조금 더 살펴보겠습니다", "chunk 001-01-01-000\nc1 D old\nc2 D old"):
            with self.subTest(text=text):
                w, b = self.world({"code": 2, "session": "s1", "text": answer(text)})
                b = self.finish(w, b)
                self.assertEqual((w.git.save_calls, b["state"]), ([], "PAUSED"))   # existing failure handling
                self.assertEqual(self.failures(w, b), [0])
                self.assertFalse((Path(b["worktree"]) / stage2.DECISIONS).exists())
                self.assertEqual(len(w.adapter.launches), 1)

    def test_nonzero_exit_with_a_structural_but_malformed_current_answer_uses_same_session_format_fix(self):
        malformed = f"chunk {CHUNK} c1 R near 1 c2 R near 3"
        w, b = self.world({"code": 2, "session": "s1", "text": answer(malformed)},
                          {"code": 0, "session": "s1", "text": answer(GOOD)})
        b = self.finish(w, b, 1)
        fix = w.adapter.launches[-1]
        self.assertEqual((b["run_kind"], fix["kind"], fix["session"]),
                         ("s2_chunk_format_fix", "resume", "s1"))
        self.assertIn("현재 청크 전체", fix["prompt"])
        self.assertNotIn("c1 R near 1 c2 R near 3", fix["prompt"])
        b = self.finish(w, b, 1)
        self.assertEqual((self.decisions(b), b["run_kind"]), (GOOD + "\n", "s2_deterministic_finalize"))
        self.assertEqual(len(w.git.save_calls), 1)

    def test_nonzero_exit_format_fix_is_blocked_by_auth_usage_and_run_pin_failures(self):
        malformed = f"chunk {CHUNK} c1 R near 1 c2 R near 3"
        for name, suffix, pin_error in (("auth", "authentication failed", None),
                                        ("usage", "usage limit reached", None),
                                        ("pin", "", ("ERROR", "output identity mismatch"))):
            with self.subTest(name=name):
                w, b = self.world({"code": 2, "session": "s1", "text": answer(malformed) + suffix})
                if pin_error:
                    w.adapter.output_identity_problem = lambda *args: pin_error
                b = self.finish(w, b, 1)
                self.assertEqual((b["state"], len(w.adapter.launches), w.git.save_calls), ("PAUSED" if name != "pin" else "ERROR", 1, []))

    def test_partial_fix_with_bad_format_rechecks_aliases_and_preserves_good_rows(self):
        w, b = self.world(
            {"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc1 D first")},
            {"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK} c2 D second")},
            {"code": 0, "session": "s1", "text": answer(GOOD)})
        b = self.finish(w, b, 1)
        first_fix = w.adapter.launches[-1]
        self.assertEqual((b["run_kind"], first_fix["kind"]), ("s2_chunk_fix", "resume"))
        b = self.finish(w, b, 1)
        second_fix = w.adapter.launches[-1]
        self.assertEqual((b["run_kind"], second_fix["kind"], second_fix["session"]),
                         ("s2_chunk_fix", "resume", "s1"))
        self.assertIn("c2", second_fix["prompt"])
        self.assertIn("출력 형식이 잘못", second_fix["prompt"])
        self.assertEqual(self.decisions(b), f"chunk {CHUNK}\nc1 D first\n")
        b = self.finish(w, b, 1)
        self.assertEqual((self.decisions(b), b["run_kind"]), (GOOD + "\n", "s2_deterministic_finalize"))
        self.assertEqual(stage2.fixes_used(w.store.runs(b["id"]), "s2_chunk_new",
                                           ("s2_chunk_fix", "s2_chunk_format_fix")), 2)

    def test_usage_limit_retry_revalidates_current_rows_and_fixes_only_rejected_aliases(self):
        quota = json.dumps({"type": "result", "subtype": "error_during_execution", "is_error": True,
                            "api_error": "usage_limit_reached", "api_error_status": 429, "session_id": "s1",
                            "usage": {"input_tokens": 0, "output_tokens": 0}, "result": ""}) + "\n"
        w, b = self.world({"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc1 D first")},
                          {"code": 1, "session": "s1", "text": quota},
                          {"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc2 D second")})
        w.adapter.name = "claude"
        b = self.finish(w, b, 1)
        self.assertEqual((b["run_kind"], self.decisions(b)), ("s2_chunk_fix", f"chunk {CHUNK}\nc1 D first\n"))
        b = self.finish(w, b)
        self.assertEqual(b["state"], "PAUSED")
        usage_run = w.store.runs(b["id"])[0]
        self.assertEqual((usage_run["exit_status"], usage_run["output_tokens"]), ("1", 0))
        self.assertEqual(stage2.fixes_used(w.store.runs(b["id"]), "s2_chunk_new",
                                            ("s2_chunk_fix", "s2_chunk_format_fix")), 0)
        with mock.patch.object(stage2, "clear_decisions", wraps=stage2.clear_decisions) as clear:
            self.assertTrue(control.retry(w.store, "claude", S2))
            w.tick(2)
            clear.assert_not_called()
        fix = w.adapter.launches[-1]
        self.assertEqual((w.store.batch(b["id"])["run_kind"], fix["kind"], fix.get("session")),
                         ("s2_chunk_fix", "resume", "s1"))
        self.assertIn("c2", fix["prompt"])
        self.assertNotIn("c1 D first", fix["prompt"])
        self.assertEqual(self.decisions(w.store.batch(b["id"])), f"chunk {CHUNK}\nc1 D first\n")
        b = self.finish(w, b)
        self.assertEqual((self.decisions(b), b["run_kind"]), (GOOD + "\n", "s2_deterministic_finalize"))

    def test_current_decisions_without_session_stop_and_preserve_on_retry(self):
        w, b = self.world()
        w.adapter.stop(b["pid"])
        w.store.finish_runs(b["id"], 1)
        w.store.update(b["id"], pid=None, session_id=None, state="ERROR", paused_from="PRODUCING",
                       run_kind="s2_chunk_fix", error="test")
        stage2.write_decisions(b["worktree"], CHUNK, ["c1 D preserve"])
        before = self.decisions(b)
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        b = w.store.batch(b["id"])
        self.assertEqual((b["state"], len(w.adapter.launches), self.decisions(b)), ("ERROR", 1, before))
        self.assertIn("새 전체 재판정은 하지 않습니다", b["error"])

    def test_failed_same_session_resume_with_current_decisions_does_not_start_a_fresh_session(self):
        w, b = self.world({"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc1 D keep")},
                          {"code": 1, "session": "s1", "text": "No conversation found with session ID: old"})
        w.adapter.name = "claude"
        b = self.finish(w, b, 1)
        before = self.decisions(b)
        b = self.finish(w, b)
        self.assertEqual((b["state"], len(w.adapter.launches), self.decisions(b)), ("PAUSED", 2, before))
        self.assertIn("세션 ID를 찾지 못했습니다", b["error"])

    def test_corrupt_decisions_stop_and_preserve_on_retry(self):
        w, b = self.world()
        w.adapter.stop(b["pid"])
        w.store.finish_runs(b["id"], 1)
        w.store.update(b["id"], pid=None, session_id="s1", state="ERROR", paused_from="PRODUCING",
                       run_kind="s2_chunk_fix", error="test")
        path = Path(b["worktree"]) / stage2.DECISIONS
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("chunk broken\nnot a row\n", "utf-8")
        before = path.read_text("utf-8")
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        b = w.store.batch(b["id"])
        self.assertEqual((b["state"], len(w.adapter.launches), path.read_text("utf-8")), ("ERROR", 1, before))

    def test_format_failure_does_not_overwrite_an_empty_or_wrong_chunk_decisions_file(self):
        malformed = f"chunk {CHUNK} c1 R near 1 c2 R near 3"
        for contents in ("", "chunk 001-01-01-000\nc1 D old\n", f"chunk {CHUNK}\nnot a decision row\n"):
            with self.subTest(contents=contents):
                w, b = self.world({"code": 0, "session": "s1", "text": answer(malformed)})
                path = Path(b["worktree"]) / stage2.DECISIONS
                path.write_text(contents, "utf-8")
                b = self.finish(w, b, 1)
                self.assertEqual((b["state"], len(w.adapter.launches), w.git.save_calls),
                                 ("ERROR", 1, []))
                self.assertEqual(path.read_text("utf-8"), contents)

    def test_rejection_resumes_the_same_session_for_only_the_reported_rows(self):
        w, b = self.world(
            {"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc1 D first")},
            {"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc2 D second\nc1 D REPLACED")})
        views = len(w.git.chunk_views)
        b = self.finish(w, b, 1)
        fix = w.adapter.launches[-1]
        self.assertEqual((b["run_kind"], fix["kind"], fix["session"]), ("s2_chunk_fix", "resume", "s1"))
        self.assertEqual(self.failures(w, b), [1, 0])
        self.assertIn("c2", fix["prompt"])
        self.assertNotIn("<<<CHUNK_VIEW_BEGIN>>>", fix["prompt"])
        self.assertEqual(len(w.git.chunk_views), views)                       # no new prepare / view / cursor
        self.assertEqual(self.decisions(b), f"chunk {CHUNK}\nc1 D first\n")   # incomplete answer is kept
        b = self.finish(w, b)
        self.assertEqual(self.decisions(b), f"chunk {CHUNK}\nc1 D first\nc2 D second\n")   # c1 unchanged, extra row ignored
        self.assertEqual(b["run_kind"], "s2_deterministic_finalize")
        self.assertEqual(self.failures(w, b)[:2], [1, 0])

    def test_out_of_range_alias_rows_are_removed_and_do_not_block_the_chunk(self):
        w, b = self.world({"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc1 D first\nc2 D second\nc3 D extra")})
        b = self.finish(w, b)
        self.assertEqual(self.decisions(b), GOOD + "\n")
        self.assertEqual((len(w.git.save_calls), b["run_kind"]), (2, "s2_deterministic_finalize"))   # no fix run was needed
        w, b = self.world({"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc1 D first\nc3 D extra")},
                          {"code": 0, "session": "s1", "text": answer(f"chunk {CHUNK}\nc2 D second")})
        b = self.finish(w, b, 1)
        self.assertEqual(self.decisions(b), f"chunk {CHUNK}\nc1 D first\n")   # c3 gone, c1 kept, only c2 to fix
        b = self.finish(w, b)
        self.assertEqual((self.decisions(b), b["run_kind"]), (GOOD + "\n", "s2_deterministic_finalize"))

    def test_two_failed_corrections_then_owner_retry_preserves_rows_and_grants_one_same_session_fix(self):
        bad = answer(f"chunk {CHUNK}\nc1 D first\nc2 R x BAD")
        w, b = self.world({"code": 0, "session": "s1", "text": bad}, {"code": 0, "session": "s1", "text": bad},
                          {"code": 0, "session": "s1", "text": bad}, {"code": 0, "session": "s1", "text": answer(GOOD)})
        b = self.finish(w, b, 1)
        b = self.finish(w, b, 1)
        self.assertEqual((b["run_kind"], len(w.adapter.launches)), ("s2_chunk_fix", 3))
        b = self.finish(w, b)
        self.assertEqual((b["state"], len(w.adapter.launches)), ("ERROR", 3))   # 1 answer + 2 fixes, then preserved
        self.assertIn("c2", b["error"])
        self.assertEqual(stage2.fixes_used(w.store.runs(b["id"]), "s2_chunk_new", ("s2_chunk_fix", "s2_chunk_format_fix")), 2)
        w.tick(3)
        self.assertEqual((w.store.batch(b["id"])["state"], len(w.adapter.launches)), ("ERROR", 3))   # no automatic restart
        with mock.patch.object(stage2, "clear_decisions", wraps=stage2.clear_decisions) as clear:
            self.assertTrue(control.retry(w.store, "claude", S2))
            w.tick(2)
            clear.assert_not_called()
        fix = w.adapter.launches[-1]
        self.assertEqual((fix["kind"], fix.get("session")), ("resume", "s1"))
        self.assertEqual(w.store.batch(b["id"])["run_kind"], "s2_chunk_fix")
        self.assertEqual(self.decisions(w.store.batch(b["id"])), f"chunk {CHUNK}\nc1 D first\nc2 R x BAD\n")
        grant = json.loads(w.store.get(stage2.retry_fix_key(b["id"])))
        self.assertEqual((grant["chunk_id"], grant["session_id"], grant["state"]), (CHUNK, "s1", "consumed"))
        b = self.finish(w, b)
        self.assertEqual((b["run_kind"], len(w.adapter.launches)), ("s2_deterministic_finalize", 4))
        self.assertEqual(self.decisions(b), GOOD + "\n")

    def test_consumed_operator_retry_grant_cannot_be_regranted_for_the_same_chunk_session(self):
        bad = answer(f"chunk {CHUNK}\nc1 D first\nc2 R x BAD")
        w, b = self.world({"code": 0, "session": "s1", "text": bad}, {"code": 0, "session": "s1", "text": bad},
                          {"code": 0, "session": "s1", "text": bad}, {"code": 0, "session": "s1", "text": bad})
        b = self.finish(w, b, 1)
        b = self.finish(w, b, 1)
        b = self.finish(w, b)
        self.assertEqual(b["state"], "ERROR")
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        self.assertEqual((w.adapter.launches[-1]["kind"], w.adapter.launches[-1].get("session")), ("resume", "s1"))
        self.assertEqual(json.loads(w.store.get(stage2.retry_fix_key(b["id"])))["state"], "consumed")
        b = self.finish(w, b)
        self.assertEqual((b["state"], len(w.adapter.launches)), ("ERROR", 4))
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(3)
        self.assertEqual((w.store.batch(b["id"])["state"], len(w.adapter.launches)), ("ERROR", 4))

    def test_recovery_revalidates_only_the_current_chunks_decisions_without_a_failure_record(self):
        w, b = self.world({"code": 2, "session": "s1", "text": answer("작업 중")}, {"code": 0, "session": "s2"})
        b = self.finish(w, b, 1)
        self.assertEqual(b["state"], "PAUSED")
        self.assertEqual(stage2.decision_file_state(b["worktree"], CHUNK), "missing")
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        resumed = w.adapter.launches[-1]   # "no response": the existing resume path, with the short request only
        self.assertEqual((w.git.save_calls, resumed["kind"]), ([], "resume"))
        self.assertNotIn("<<<CHUNK_VIEW_BEGIN>>>", resumed["prompt"])
        w2, b2 = self.world({"code": 2, "session": "s1", "text": answer("작업 중")})
        b2 = self.finish(w2, b2, 1)
        stage2.write_decisions(b2["worktree"], CHUNK, ["c1 D first", "c2 D second"])
        self.assertTrue(control.retry(w2.store, "claude", S2))
        w2.tick(2)
        b2 = w2.store.batch(b2["id"])
        self.assertEqual((len(w2.git.save_calls), b2["run_kind"]), (1, "s2_deterministic_finalize"))   # saved, no extra AI for the chunk
        self.assertEqual(len(w2.adapter.launches), 1)  # deterministic finalization does not launch an AI session
        self.assertEqual(self.failures(w2, b2), [0])


class FixHelpers(unittest.TestCase):
    def test_header_and_row_extraction(self):
        text = f"설명\nchunk {CHUNK}\nc1 R near 1\n진행\nc2 D x\n```\nc3 D ignored"
        self.assertEqual(stage2.extract_decisions(text, CHUNK), ["c1 R near 1", "c2 D x"])
        for none in (None, "", "chunk 001-01-01-002\nc1 D x", "c1 D x"):
            self.assertIsNone(stage2.extract_decisions(none, CHUNK))
        self.assertEqual(stage2.error_aliases("c3 x: a\nc1: b\n  c3 again\ntypes: ..."), ["c3", "c1"])

    def test_format_problem_only_accepts_structural_current_chunk_attempts(self):
        self.assertEqual(stage2.format_problem(f"chunk {CHUNK}\nc1 D x\nc2 D y", CHUNK), None)
        self.assertEqual(stage2.format_problem(f"chunk {CHUNK}\n", CHUNK), None)  # VALID([]), then save-chunk decides
        for malformed in (f"chunk {CHUNK} c1 D x c2 D y", f"**chunk {CHUNK}**:\nc1 D x"):
            with self.subTest(malformed=malformed):
                self.assertIsNotNone(stage2.format_problem(malformed, CHUNK))
        for missing in (f"작업 중 chunk {CHUNK} c1 D x", "chunk 001-01-01-000 c1 D x", "진행 안내만 있음"):
            with self.subTest(missing=missing):
                self.assertIsNone(stage2.format_problem(missing, CHUNK))

    def test_joined_decision_rows_are_detected_only_for_allowed_row_syntax(self):
        for rows in (["c1 R near 1", "c2 D reason"], ["c1 D mentions c12 as a reference"],
                     ["c1 D mentions c12 in a sentence that is not a row"]):
            with self.subTest(rows=rows):
                self.assertIsNone(stage2.joined_decision_rows_problem(rows))
        joined = ["c1 R near 1 c2 R mood 3 T4 near 4", "c3 D reason c4 D another reason"]
        problem = stage2.joined_decision_rows_problem(joined)
        self.assertIn("2개 판정 행", problem)
        self.assertIn("c2, c4", problem)
        self.assertNotIn(joined[0], problem)

    def test_large_repeated_save_diagnostics_keep_every_alias_when_compacted(self):
        diagnostic = "chunk 001-01-01-001 not saved, checkpoint unchanged: 231 problem(s)\n" + "\n".join(
            f"c{i} candidate-{i}: c{i}: relation needs 2, 4 or 5 fields after R  ->  c{i} R <type> <tier>"
            for i in range(1, 232)) + "\ntypes: near/mood; tier: one digit 1..9"
        compact = stage2.compact_fix_diagnostic(diagnostic)
        self.assertLess(len(compact), len(diagnostic) * 2 // 5)
        self.assertIn("relation needs 2, 4 or 5 fields after R (231 aliases)", compact)
        for i in range(1, 232):
            self.assertIn(f"c{i}: c{i} R <type> <tier>", compact)
        self.assertIn("types: near/mood", compact)

    def test_decisions_file_state_distinguishes_absent_current_and_corrupt(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / stage2.DECISIONS
            self.assertEqual(stage2.decision_file_state(temp, CHUNK), "missing")
            path.parent.mkdir(parents=True)
            path.write_text(f"chunk {CHUNK}\nc1 D old\n", "utf-8")
            self.assertEqual(stage2.decision_file_state(temp, CHUNK), "current")
            for text in ("", "chunk 001-01-01-000\nc1 D old\n", f"chunk {CHUNK}\nnot a row\n"):
                with self.subTest(text=text):
                    path.write_text(text, "utf-8")
                    self.assertEqual(stage2.decision_file_state(temp, CHUNK), "corrupt")

    def test_merge_changes_only_allowed_aliases(self):
        merged, ignored = stage2.merge_fix(["c1 D a", "c2 R bad", "c3 D c"], ["c2 D b", "c3 D HACK", "c4 D new"], ["c2", "c4"])
        self.assertEqual((merged, ignored), (["c1 D a", "c2 D b", "c3 D c", "c4 D new"], ["c3 D HACK"]))

    def test_fix_count_starts_after_the_latest_new_session(self):
        def run(kind, status, output):
            return {"kind": kind, "exit_status": status, "output_tokens": output}

        chunk = ("s2_chunk_new", ("s2_chunk_fix", "s2_chunk_format_fix"))
        links = ("s2_links_new", ("s2_links_fix",))
        self.assertEqual(stage2.fixes_used([run("s2_chunk_format_fix", "1", 0),
                                            run("s2_chunk_fix", "2", 0),
                                            run("s2_chunk_new", "0", 20)], *chunk), 0)
        self.assertEqual(stage2.fixes_used([run("s2_chunk_format_fix", "0", 0), run("s2_chunk_fix", "0", 1),
                                            run("s2_chunk_new", "0", 20)], *chunk), 2)
        self.assertEqual(stage2.fixes_used([run("s2_chunk_fix", "0", 4), run("s2_chunk_fix", "1", 4),
                                            run("s2_chunk_new", "0", 20)], *chunk), 2)
        self.assertEqual(stage2.fixes_used([run("s2_chunk_fix", "1", None), run("s2_chunk_new", "0", 20)], *chunk), 1)
        self.assertEqual(stage2.fixes_used([run("s2_chunk_fix", None, 0), run("s2_chunk_new", "0", 20)], *chunk), 1)
        mixed = [run("s2_chunk_fix", "0", 4), run("s2_chunk_new", "0", 20),
                 run("s2_chunk_fix", "0", 4), run("s2_chunk_new", "0", 20)]
        self.assertEqual(stage2.fixes_used(mixed, *chunk), 1)
        links_runs = [run("s2_links_fix", "0", 4), run("s2_chunk_fix", "0", 4),
                      run("s2_links_new", "0", 20), run("s2_chunk_fix", "0", 4),
                      run("s2_chunk_new", "0", 20)]
        self.assertEqual(stage2.fixes_used(links_runs, *links), 1)
        self.assertEqual(stage2.fixes_used(links_runs, *chunk), 2)

    def test_prompts(self):
        self.assertIn(CHUNK, prompts.stage2_chunk_resume(CHUNK))
        self.assertNotIn("VIEW", prompts.stage2_chunk_resume(CHUNK))
        self.assertIn("c4: 오류", prompts.stage2_chunk_fix(CHUNK, "c4: 오류"))
        format_prompt = prompts.stage2_chunk_format_fix(CHUNK, "형식 오류")
        self.assertIn("현재 청크 전체", format_prompt)
        self.assertIn("형식 오류", format_prompt)
        self.assertNotIn("원본 241행", format_prompt)


if __name__ == "__main__":
    unittest.main()
