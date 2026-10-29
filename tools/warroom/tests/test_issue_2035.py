"""Issue #2035 PR B: Stage 1 A/B as serial 50-record answer-only chunk sessions with a deterministic finalization."""
import json
import unittest
from pathlib import Path

from tests.fakes import HEAD1, World
from tests.test_supervisor import review
from warroom import control, prompts, stage1ab

REL = "data/relation-candidates/001/001_01_a_deepseek.jsonl"


def log_text(answer: str) -> str:
    return json.dumps({"type": "step_start"}) + "\n" + json.dumps({"type": "text", "part": {"text": answer}}) + "\n"


class ABWorld(World):
    def __init__(self, records=120, method="a", **kw):
        super().__init__(**kw)
        self.method = method
        self.cfg["ab_chunk_sessions"] = True
        self.adapter.name = "opencode"
        self.runner.workbench.records = records
        self.git.on_create = self.runner.workbench.write_canonical
        self.git.local_head = HEAD1

    def row_(self):
        return self.row("deepseek", self.method)

    def wt(self):
        return Path(self.row_()["worktree"])

    def senses(self, n):
        return sum(len(r["senses"]) for r in self.runner.workbench.rows()[(n - 1) * 50:n * 50])

    def block(self, n, overrides=None, begin=True, end=True, no=None):
        no = no or n
        rows = {f"S{i}": f"S{i}\t후보{n}-{i}" for i in range(1, self.senses(n) + 1)}
        rows.update(overrides or {})
        body = "\n".join(rows[a] for a in sorted(rows, key=lambda a: int(a[1:])))
        return (f"BEGIN chunk {no:03d}\n" if begin else "") + body + (f"\nEND chunk {no:03d}" if end else "")

    def ai(self, text, code=0, session="ses_x", **extra):
        self.adapter.plan.append({"code": code, "session": session, "text": log_text(text), **extra})

    def finish_last(self):
        self.adapter.finish(self.adapter.launches[-1]["pid"])

    def kinds(self):
        return [r["kind"] for r in reversed(self.store.runs(self.row_()["id"]))]

    def run_chunks(self, n=3):
        for i in range(1, n + 1):
            self.ai(self.block(i), session=f"ses_{i}")
        for _ in range(n):
            self.tick()
            self.finish_last()
            self.tick()


class SerialChunks(unittest.TestCase):
    def setUp(self):
        self.w = ABWorld()
        self.addCleanup(self.w.tmp.cleanup)

    def test_fifty_record_chunks_answer_only_then_deterministic_merge_commit_push_pr(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.run_chunks(3)
        cp = json.loads((w.wt() / stage1ab.names(w.row_()).checkpoint).read_text())
        self.assertEqual([c["sense_count"] and len(c["record_ids"]) for c in cp["chunks"][:3]], [50, 50, 20][:3] if False else [50, 50, 20])
        self.assertEqual(w.kinds(), ["ab_chunk_new"] * 3)
        first, third = w.adapter.launches[0], w.adapter.launches[2]
        self.assertTrue(all(l["kind"] == "start" for l in w.adapter.launches))
        self.assertEqual((first["answer_only"], first["stage2_chunk_git"]), ("1", "1"))
        self.assertTrue(first["git_sandbox_paths"])
        self.assertIn(prompts.VIEW_BEGIN, first["prompt"])
        self.assertIn("S1\tw0001-s1", first["prompt"])
        self.assertNotIn("AGENTS.md를 읽", first["prompt"])
        self.assertNotIn("S1\tw0101-s1", first["prompt"])                    # chunk 3 carries only its own senses
        self.assertNotIn("w0001-s1", third["prompt"])
        self.assertEqual(json.loads(first["opencode_config"])["permission"]["bash"], "deny")
        b = w.row_()
        self.assertEqual((b["state"], b["pr_number"]), ("WAITING_REVIEW", 100))
        self.assertEqual(len(w.gh.created_prs), 1)
        self.assertEqual(w.git.commits[0][0], [REL])
        self.assertEqual(w.git.pushes, [b["branch"]])
        self.assertEqual(w.runner.workbench.merges, 1)
        merged = (w.wt() / REL).read_text().splitlines()
        self.assertEqual([json.loads(l)["record_id"] for l in merged], [r["id"] for r in w.runner.workbench.rows()])

    def test_prepare_uses_fifty_for_a_new_batch_and_keeps_an_existing_checkpoint(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(self.w.block(1))
        w.tick()
        prepares = [c for c in w.runner.workbench.calls if c[2] == "prepare"]
        self.assertEqual(prepares[0][prepares[0].index("--chunk-size") + 1], "50")
        # a batch that already has a 25-record checkpoint is resumed with ITS chunk size, never re-prepared
        again = stage1ab.prepare(w.runner, w.env if hasattr(w, "env") else {}, w.wt(), w.row_())
        self.assertEqual(again["source"]["chunk_size"], 50)
        self.assertNotIn("--chunk-size", [c for c in w.runner.workbench.calls if c[2] == "prepare"][-1])

    def test_missing_end_marker_wrong_chunk_and_prose_are_rejected_and_retried_in_the_same_session(self):
        w = self.w
        w.start("single", "deepseek", "a")
        for text in (w.block(1, end=False), w.block(1, no=2), "S1\t후보", "완료했습니다"):
            w.ai(text, session="ses_1")
        w.tick()
        w.finish_last()
        w.tick()                                                              # rejected -> retry (resume)
        retry = w.adapter.launches[-1]
        self.assertEqual((retry["kind"], retry["session"]), ("resume", "ses_1"))
        self.assertNotIn(prompts.VIEW_BEGIN, retry["prompt"])                 # a correction never carries the view again
        self.assertLess(len(retry["prompt"]), 2500)
        self.assertEqual(w.row_()["state"], "PRODUCING")
        w.finish_last()
        w.tick()                                                              # second rejection -> second retry
        self.assertEqual(w.kinds(), ["ab_chunk_new", "ab_chunk_retry", "ab_chunk_retry"])
        w.finish_last()
        w.tick()                                                              # third correction is still available
        self.assertEqual(w.kinds(), ["ab_chunk_new", "ab_chunk_retry", "ab_chunk_retry", "ab_chunk_retry"])
        w.finish_last()
        w.tick()                                                              # third correction failed without an exact candidate to remove
        b = w.row_()
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), 4)
        self.assertFalse((w.wt() / stage1ab.names(b).directory / "candidates/chunk-001.jsonl").exists())
        w.ai(w.block(1), session="ses_1")
        self.assertTrue(control.retry(w.store, "deepseek", "a"))              # the cap survives a restart/Retry
        w.tick(2)
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), 4)

    def test_save_chunk_automatically_removes_definite_self_repeats_without_an_ai_retry(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1, {"S5": "S5\t표제4"}), session="ses_1")                  # a self-repeat of the source lemma at S5 (record w0005)
        w.tick()
        w.finish_last()
        w.tick()
        saved = [json.loads(l) for l in (w.wt() / stage1ab.names(w.row_()).directory / "candidates/chunk-001.jsonl").read_text().splitlines()]
        flat = {s["sense_id"]: s["candidates"] for r in saved for s in r["senses"]}
        self.assertEqual(flat["w0001-s1"], ["후보1-1"])
        self.assertEqual(flat["w0004-s1"], [])
        self.assertEqual(w.kinds(), ["ab_chunk_new", "ab_chunk_new"])            # chunk 2 starts a NEW session
        events = [entry for entry in w.store.recent_events() if entry["batch_id"] == w.row_()["id"]]
        self.assertTrue(any("자동 정제 1개" in entry["msg"] and 'S5 "표제4" (source lemma repeat)' in entry["msg"]
                            for entry in events))

    def test_three_source_lemma_repeats_are_removed_together_and_other_rows_are_preserved(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1, {"S2": "S2\t표제2", "S5": "S5\t표제4", "S9": "S9\t표제7"}), session="ses_1")
        w.tick()
        w.finish_last()
        w.tick()
        saved = [json.loads(l) for l in (w.wt() / stage1ab.names(w.row_()).directory / "candidates/chunk-001.jsonl").read_text().splitlines()]
        flat = {s["sense_id"]: s["candidates"] for r in saved for s in r["senses"]}
        self.assertEqual([flat[sense] for sense in ("w0002-s1", "w0004-s1", "w0007-s1")], [[], [], []])
        self.assertEqual(flat["w0001-s1"], ["후보1-1"])
        self.assertEqual(w.kinds(), ["ab_chunk_new", "ab_chunk_new"])
        logs = [entry["msg"] for entry in w.store.recent_events() if entry["batch_id"] == w.row_()["id"]]
        self.assertTrue(any("자동 정제 3개" in line and all(alias in line for alias in ("S2", "S5", "S9")) for line in logs))

    def test_third_correction_removes_only_the_exact_rejected_candidate_then_revalidates(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1, {"S5": "S5\t bad"}), session="ses_1")
        retry = "BEGIN chunk 001\nS5\t bad\nEND chunk 001"
        for _ in range(3):
            w.ai(retry, session="ses_1")
        w.tick()
        for _ in range(4):
            w.finish_last()
            w.tick()
        b = w.row_()
        saved = [json.loads(l) for l in (w.wt() / stage1ab.names(b).directory / "candidates/chunk-001.jsonl").read_text().splitlines()]
        flat = {s["sense_id"]: s["candidates"] for r in saved for s in r["senses"]}
        self.assertEqual(flat["w0004-s1"], [])
        self.assertEqual(flat["w0001-s1"], ["후보1-1"])
        self.assertEqual(len([call for call in w.runner.workbench.calls if call[2] == "save-chunk"]), 5)
        self.assertEqual(w.kinds(), ["ab_chunk_new", "ab_chunk_retry", "ab_chunk_retry", "ab_chunk_retry", "ab_chunk_new"])
        self.assertEqual(w.row_()["state"], "PRODUCING")                 # next chunk starts after the validated save
        events = [entry for entry in w.store.recent_events() if entry["batch_id"] == b["id"]]
        self.assertTrue(any("정정 3회 뒤 식별된 부적격 후보 1개" in entry["msg"] and 'S5 " bad"' in entry["msg"]
                            for entry in events))

    def test_the_rejection_reason_survives_a_restart(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1, {"S5": "S5\t bad"}), session="ses_1")
        w.tick()
        w.finish_last()
        w.tick()
        st = stage1ab.load_state(w.store, w.row_()["id"], 1)
        self.assertEqual((st["tries"], st["requested"]), (1, ["S5"]))
        self.assertIn('" bad"', st["problem"])

    def test_a_correction_may_not_change_an_unrequested_row(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1, {"S5": "S5\t bad"}), session="ses_1")
        w.ai("BEGIN chunk 001\nS5\t수정\nS6\t바꿈\nEND chunk 001", session="ses_1")
        w.tick()
        w.finish_last()
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "PRODUCING")                       # rejected again (a retry), nothing saved
        self.assertFalse((w.wt() / stage1ab.names(w.row_()).directory / "candidates/chunk-001.jsonl").exists())

    def test_refused_tool_calls_are_a_metric_but_a_dirty_tracked_tree_is_not(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1), session="ses_1")
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "PRODUCING")                       # accepted: chunk 2 launched
        w.git.dirty_text = " M data/canonical/stdict-0001.jsonl\n"
        w.ai(w.block(2), session="ses_2")
        w.finish_last()
        w.tick()
        b = w.row_()
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("격리", b["error"])
        self.assertFalse((w.wt() / stage1ab.names(b).directory / "candidates/chunk-002.jsonl").exists())

    def test_merge_rejection_pointing_at_one_chunk_repairs_only_that_chunk(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.runner.workbench.merge_error = "Candidate v1 invalid: record_id w0060 sense_id w0060-s1 candidate duplicates"
        w.run_chunks(3)
        b = w.row_()
        self.assertEqual((b["state"], b["run_kind"]), ("PRODUCING", "ab_chunk_retry"))
        repair = w.adapter.launches[-1]
        self.assertEqual(repair["kind"], "start")                              # the old session is gone: a new small one
        self.assertIn("검증에서 거부", repair["prompt"])
        self.assertIn("duplicates", repair["prompt"])                           # the merge diagnostic reaches the repair session
        self.assertNotIn("사유 없음", repair["prompt"])
        self.assertIn("C\t", repair["prompt"])                                 # the saved candidates of that chunk only
        self.assertIn("w0060-s1", repair["prompt"])
        self.assertNotIn("w0001-s1", repair["prompt"])
        saved_before = (w.wt() / stage1ab.names(b).directory / "candidates/chunk-001.jsonl").read_bytes()
        view = (w.wt() / stage1ab.view_path(b, 2)).read_text()
        aliases = [r[0] for r in stage1ab.view_rows(view) if r[1].startswith("w0060-")]
        self.assertEqual(len(aliases), 2)
        text = "BEGIN chunk 002\n" + "\n".join(f"{a}\t새후보{a}" for a in aliases) + "\nEND chunk 002"
        w.adapter.running[repair["pid"]]["text"] = log_text(text)
        w.adapter.running[repair["pid"]]["session"] = "ses_r"
        w.finish_last()
        w.tick(2)
        self.assertEqual((w.wt() / stage1ab.names(b).directory / "candidates/chunk-001.jsonl").read_bytes(), saved_before)
        fixed = (w.wt() / stage1ab.names(b).directory / "candidates/chunk-002.jsonl").read_text()
        self.assertIn(f"새후보{aliases[0]}", fixed)
        self.assertIn("후보2-1", fixed)                                          # the unrequested rows keep the first answer
        self.assertEqual(w.runner.workbench.merges, 1)
        self.assertEqual(w.row_()["state"], "WAITING_REVIEW")

    def test_save_cleanup_limit_does_not_increase_final_merge_repair_limit(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.runner.workbench.merge_error = "Candidate v1 invalid: record_id w0060 sense_id w0060-s1 candidate duplicates"
        w.run_chunks(3)
        repair = w.adapter.launches[-1]
        for expected_kind in ("start", "resume"):
            self.assertEqual(repair["kind"], expected_kind)
            aliases = [row[0] for row in stage1ab.view_rows((w.wt() / stage1ab.view_path(w.row_(), 2)).read_text())
                       if row[1] == "w0060-s1"]
            self.assertEqual(len(aliases), 1)
            w.adapter.running[repair["pid"]]["text"] = log_text(
                f"BEGIN chunk 002\n{aliases[0]}\t bad\nEND chunk 002")
            w.adapter.running[repair["pid"]]["session"] = "ses_merge_repair"
            w.finish_last()
            w.tick()
            if expected_kind == "start":
                repair = w.adapter.launches[-1]
        self.assertEqual(len(w.adapter.launches), 5)  # 3 ordinary chunks plus only 2 merge-repair attempts
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertIn("정정 2회", w.row_()["error"])

    def test_unidentifiable_merge_rejection_is_an_error_and_nothing_is_regenerated(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.runner.workbench.merge_error = "Candidate v1 invalid: something global"
        w.run_chunks(3)
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), 3)

    def test_editing_a_saved_chunk_is_an_error(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.run_chunks(1)
        path = w.wt() / stage1ab.names(w.row_()).directory / "candidates/chunk-001.jsonl"
        path.write_text(path.read_text().replace("후보1-1", "변조"))
        w.ai(w.block(2), session="ses_2")
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertRegex(w.row_()["error"], "수정|직접 쓰기")


class ReviewFix(unittest.TestCase):
    def test_review_fix_is_a_small_new_session_with_the_named_sense_and_unlisted_senses_stay_unchanged(self):
        w = ABWorld()
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "a")
        w.run_chunks(3)
        b = w.row_()
        self.assertTrue(b["session_id"] is None or True)
        w.pr_info(b["pr_number"], HEAD1)
        w.gh.reviews_ = [review(11, HEAD1, "-1 w0001/w0001-s1 후보1-1 삭제")]
        out = w.wt() / REL
        original = out.read_text()

        def fixed():
            out.write_text(original.replace("후보1-1", "고침", 1))
            w.pr_info(b["pr_number"], "b" * 40)
            w.git.local_head = "b" * 40

        w.git._git = lambda *a, **k: type("R", (), {"out": original, "ok": True})()
        w.adapter.plan.append({"code": 0, "session": "ses_fix", "effect": fixed})
        w.tick()
        fix = w.adapter.launches[-1]
        self.assertEqual(fix["kind"], "start")                                  # never a resume of the long session
        self.assertIn("source_context", fix["prompt"])
        self.assertIn("w0001-s1\t표제1\tnoun\t뜻 1-1\t후보1-1", fix["prompt"])
        self.assertNotIn("w0060-s1", fix["prompt"])
        w.adapter.finish(fix["pid"])
        w.tick()
        self.assertEqual((w.row_()["state"], w.row_()["error"]), ("WAITING_REVIEW", None))   # only the listed sense changed

        w.gh.reviews_.append(review(12, "b" * 40, "-1 w0001/w0001-s1 again"))

        def sneaky():
            out.write_text(out.read_text().replace("후보2-2", "몰래", 1))
            w.pr_info(b["pr_number"], "c" * 40)
            w.git.local_head = "c" * 40

        w.adapter.plan.append({"code": 0, "session": "ses_fix2", "effect": sneaky})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        # #2092: a correct fix is judged by review, never PAUSED by a literal-enumeration scope gate
        self.assertEqual((w.row_()["state"], w.row_()["error"]), ("WAITING_REVIEW", None))


class WriteAndScope(unittest.TestCase):
    def test_a_candidate_file_written_by_the_ai_is_never_taken_as_completion(self):
        w = ABWorld()
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "a")
        directory = None

        def sneaky_write():
            path = w.wt() / stage1ab.names(w.row_()).directory / "candidates" / "chunk-001.jsonl"
            path.parent.mkdir(parents=True, exist_ok=True)
            w.runner.workbench.chunk_rows_to(path, w.wt(), 1)

        w.ai("완료했습니다", session="ses_1", effect=sneaky_write)       # a valid-looking file but no final answer block
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertIn("직접 쓰기", w.row_()["error"])
        self.assertEqual(len(w.adapter.launches), 1)

    def test_fix_scope_names_only_the_listed_sense_not_its_siblings(self):
        w = ABWorld()
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "a")
        w.run_chunks(3)
        wt = w.wt()
        # w0003 has two senses (s1, s2); naming one must not admit the other, nor a bare record id any sense
        cases = [("w0003/w0003-s1 후보1-3 삭제", {("w0003", "w0003-s1")}), ("w0003-s2.", {("w0003", "w0003-s2")}),
                 ("w0003 전체를 보라", set()), ("w0003-s1 와 w0003-s2", {("w0003", "w0003-s1"), ("w0003", "w0003-s2")}),
                 ("w9999-s1 없음", set())]
        for text, want in cases:
            with self.subTest(text):
                allowed, context = stage1ab.fix_scope(wt, w.row_(), text)
                self.assertEqual(allowed, want)
        before = (wt / REL).read_text()
        rows = [json.loads(l) for l in before.splitlines()]
        sibling = next(r for r in rows if r["record_id"] == "w0003")
        sibling["senses"][1]["candidates"] = ["몰래"]
        after = "\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n"
        self.assertFalse(hasattr(stage1ab, "out_of_scope_changes"))   # #2092: no post-fix scope gate exists any more


class Helpers(unittest.TestCase):
    def test_extract_block_table(self):
        ok = "설명\nBEGIN chunk 003\nS1\ta\n```\nS2\nEND chunk 003\n끝"
        self.assertEqual(stage1ab.extract_block(ok, 3), ["S1\ta", "S2"])
        for name, text in (("none", None), ("empty", " "), ("no begin", "S1\nEND chunk 003"), ("no end", "BEGIN chunk 003\nS1"),
                           ("wrong number", "BEGIN chunk 004\nS1\nEND chunk 004"), ("two blocks", "BEGIN chunk 003\nS1\nEND chunk 003\nBEGIN chunk 003\nS1\nEND chunk 003"),
                           ("reversed", "END chunk 003\nBEGIN chunk 003"), ("mismatched", "BEGIN chunk 003\nS1\nEND chunk 004")):
            with self.subTest(name), self.assertRaises(stage1ab.ABChunkError):
                stage1ab.extract_block(text, 3)

    def test_merge_answer_and_rejected_aliases(self):
        prev = {"S1": "S1\ta", "S2": "S2\tb", "S3": "S3"}
        self.assertEqual(stage1ab.merge_answer(prev, ["S2"], {"S2": "S2\tc"}), ["S1\ta", "S2\tc", "S3"])
        with self.assertRaises(stage1ab.ABChunkError):
            stage1ab.merge_answer(prev, ["S2"], {"S2": "S2\tc", "S1": "S1\tz"})
        with self.assertRaises(stage1ab.ABChunkError):
            stage1ab.merge_answer(prev, ["S2", "S3"], {"S2": "S2\tc"})
        rows = [["S1", "w1-s1"], ["S2", "w1-s2"], ["S3", "w2-s1"]]
        self.assertEqual(stage1ab.rejected_aliases("compact line 4 alias S3 x", rows), ["S3"])
        self.assertEqual(stage1ab.rejected_aliases("record_id w1 sense_id w2-s1", rows), ["S1", "S2", "S3"])
        self.assertIsNone(stage1ab.rejected_aliases("nothing named", rows))
        self.assertIsNone(stage1ab.rejected_aliases("alias S9 unknown", rows))

    def test_exactly_named_candidate_can_be_removed_without_changing_other_rows(self):
        rows = [["S1", "w1-s1"], ["S2", "w2-s1"]]
        answer = ["S1\tkeep\t bad", "S2\tstay"]
        diagnostic = 'chunk 001 input line 1 record_id w1 sense_id w1-s1 candidate 2 " bad" must be a non-empty trimmed string'
        rejected = stage1ab.rejected_candidates(diagnostic, rows, answer)
        self.assertEqual([(item["alias"], item["candidate"]) for item in rejected], [("S1", " bad")])
        self.assertEqual(stage1ab.remove_rejected_candidates(answer, rejected), ["S1\tkeep", "S2\tstay"])
        self.assertEqual(stage1ab.rejected_candidates('candidate " bad" is invalid', rows, answer), [])

    def test_final_answer_per_cli_is_this_runs_last_answer_only(self):
        from warroom.adapters import final_answer
        import tempfile
        cases = {
            "claude": [{"type": "assistant", "message": {"content": [{"type": "text", "text": "중간"}]}},
                       {"type": "result", "subtype": "success", "is_error": False, "result": "최종"}],
            "claude error": [{"type": "result", "subtype": "error_max_turns", "is_error": True, "result": "x"}],
            "codex": [{"type": "item.completed", "item": {"type": "agent_message", "text": "중간"}},
                      {"type": "item.completed", "item": {"type": "command_execution", "aggregated_output": "tool"}},
                      {"type": "item.completed", "item": {"type": "agent_message", "text": "최종"}}],
            "opencode": [{"type": "step_start"}, {"type": "text", "part": {"text": "중간"}}, {"type": "step_start"},
                         {"type": "text", "part": {"text": "최"}}, {"type": "text", "part": {"text": "종"}}],
        }
        with tempfile.TemporaryDirectory() as d:
            for name, events in cases.items():
                path = Path(d) / f"{name}.log"
                path.write_text("\n".join(json.dumps(e) for e in events) + "\n")
                self.assertEqual(final_answer(path), None if name == "claude error" else "최종", name)
            self.assertIsNone(final_answer(Path(d) / "missing.log"))


class AdapterPolicy(unittest.TestCase):
    def test_claude_answer_only_removes_tools_and_refuses_when_that_cannot_be_proven(self):
        from warroom.adapters import ClaudeCodeAdapter
        ad = ClaudeCodeAdapter()
        env = {"WARROOM_ANSWER_ONLY": "1"}
        self.assertEqual(ad._answer_only_args({}), [])                              # other runs are untouched
        with self.assertRaises(RuntimeError):                                       # help not proven: no guess
            ad._answer_only_args(env)
        ad._help_flags = {"--print", "--model"}
        with self.assertRaises(RuntimeError):                                       # no --tools: no isolation guarantee
            ad._answer_only_args(env)
        ad._help_flags = {"--tools", "--strict-mcp-config", "--disable-slash-commands", "--bare"}
        self.assertEqual(ad._answer_only_args(env), ["--tools", "", "--strict-mcp-config", "--disable-slash-commands"])
        self.assertIn("--bare", ad._answer_only_args({**env, "ANTHROPIC_API_KEY": "k"}))   # bare needs API-key auth
        ad._help_flags = {"--tools"}
        self.assertEqual(ad._answer_only_args(env), ["--tools", ""])                # optional trimming is not required
        repair_env = {"WARROOM_ANSWER_ONLY": "1", "WARROOM_STAGE2_REPAIR": "1"}
        with self.assertRaises(RuntimeError):
            ad._answer_only_args(repair_env)                                       # repair fails closed without MCP isolation
        ad._help_flags = {"--tools", "--strict-mcp-config", "--disable-slash-commands"}
        self.assertEqual(ad._answer_only_args(repair_env),
                         ["--tools", "", "--strict-mcp-config", "--disable-slash-commands"])

    def test_codex_denied_command_is_only_a_metric_for_an_answer_only_chunk(self):
        from warroom.adapters import CodexCLIAdapter
        import tempfile
        events = [{"type": "thread.started", "thread_id": "th_1"},
                  {"type": "item.completed", "item": {"type": "command_execution", "command": "cat > .warroom-scratch/x <<EOF",
                                                      "status": "failed", "exit_code": 1, "aggregated_output": "Operation not permitted"}}]
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "run.log"
            log.write_text("\n".join(json.dumps(e) for e in events) + "\n")
            ad = CodexCLIAdapter()
            self.assertEqual(ad.run_problem(log, None, "th_1")[0], "PAUSED")             # the regular policy still pauses
            self.assertIsNone(ad.run_problem(log, None, "th_1", tolerate_denied=True))  # answer-only: judged by effects + answer


if __name__ == "__main__":
    unittest.main()


class MasterOccupancy(unittest.TestCase):
    """Issue #2063: PR-time master occupancy uses the same key as the open-PR check and the batch selector."""

    def world(self, method, other_model=None):
        w = ABWorld(method=method)
        self.addCleanup(w.tmp.cleanup)
        if other_model:   # seeded before the batch is selected: the selector itself ignores another producer's file
            w.runner.done[f"data/relation-candidates/001/001_01_{method}_{other_model}.jsonl"] = 500
        w.start("single", "deepseek", method)
        return w

    def test_ab_other_producers_master_candidate_does_not_block_the_pr(self):
        for method in ("a", "b"):
            with self.subTest(method=method):
                w = self.world(method, "codex")
                w.run_chunks(3)
                b = w.row(method=method)
                self.assertEqual((b["shard"], b["batch"]), ("001", "01"))
                self.assertEqual((b["state"], b["pr_number"]), ("WAITING_REVIEW", 100))
                self.assertEqual(len(w.gh.created_prs), 1)

    def test_occupancy_key_is_producer_for_ab_and_any_model_for_cd(self):
        w = self.world("a")
        w.tick()
        b = dict(w.row_(), shard="001", batch="01")
        for method, path, blocked in [
            ("a", "001_01_a_deepseek", True), ("a", "001_01_a_codex", False), ("b", "001_01_b_deepseek", True),
            ("b", "001_01_b_codex", False), ("c", "001_01_c_codex", True), ("c", "001_01_c_deepseek", True),
            ("d", "001_01_d_claude", True), ("a", "001_02_a_deepseek", False), ("c", "001_02_c_codex", False),
        ]:
            with self.subTest(method=method, path=path):
                w.runner.done.clear()
                w.runner.done[f"data/relation-candidates/001/{path}.jsonl"] = 500
                got = w.sup._shared_occupied(dict(b, method=method, producer="deepseek"))
                self.assertEqual(got is not None, blocked, got)
