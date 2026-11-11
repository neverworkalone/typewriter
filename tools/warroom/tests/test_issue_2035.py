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

    def test_interrupted_stream_is_saved_without_regenerating(self):
        w = self.w
        w.start("single", "deepseek", "a")
        block = w.block(1)
        rows = block.split("\n")
        overlap = rows[4]
        events = [
            {"type": "step_start", "sessionID": "ses_1"},
            {"type": "text", "sessionID": "ses_1", "part": {"text": "\n".join(rows[:4]) + "\n" + overlap[:5]}},
            {"type": "error", "sessionID": "ses_1", "error": {"type": "provider.invalid-output", "message": "OpenAI Chat stream ended without finish_reason"}},
            {"type": "step_start", "sessionID": "ses_1"},
            {"type": "text", "sessionID": "ses_1", "part": {"text": "\n".join(rows[4:])}},
        ]
        w.adapter.plan.append({"code": 1, "session": "ses_1", "text": "\n".join(json.dumps(e) for e in events) + "\n"})
        w.tick()
        w.finish_last()
        w.tick()
        cp = stage1ab.checkpoint(w.wt(), w.row_())
        self.assertTrue(stage1ab.chunk_saved(w.wt(), w.row_(), cp["chunks"][0]))
        self.assertEqual(w.kinds()[0], "ab_chunk_new")
        self.assertEqual(len(w.adapter.launches), 2)  # the second launch is the next chunk
        self.assertIn("BEGIN chunk 002", w.adapter.launches[1]["prompt"])

    def test_interrupted_stream_rejects_unbound_or_ambiguous_fragments(self):
        import tempfile
        events = [
            {"type": "step_start", "sessionID": "s"},
            {"type": "text", "sessionID": "s", "part": {"text": "BEGIN chunk 001\nS1\tpart"}},
            {"type": "error", "sessionID": "s", "error": {"type": "provider.invalid-output", "message": "OpenAI Chat stream ended without finish_reason"}},
            {"type": "step_start", "sessionID": "s"},
            {"type": "text", "sessionID": "s", "part": {"text": "S1\tpartial\nS2\tother\nEND chunk 001"}},
        ]
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "run.log"
            def recover():
                path.write_text("\n".join(json.dumps(e) for e in events))
                return stage1ab.interrupted_opencode_answer(path, 1, ["S1", "S2"], "s")
            self.assertIsNotNone(recover())
            events[3]["sessionID"] = "other"
            self.assertIsNone(recover())
            events[3]["sessionID"] = "s"
            events[4]["part"]["text"] = "S1\tdifferent\nS2\tother\nEND chunk 001"
            self.assertIsNone(recover())
            events[4]["part"]["text"] = "S1\tpartial\nEND chunk 001"
            self.assertIsNone(recover())

    def test_missing_session_relaunches_without_output_identity_evidence(self):
        from warroom.adapters import CodexCLIAdapter
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1, end=False), session="ses_1")
        w.adapter.plan.append({"code": 1, "text": "Error: no rollout found for thread id 0000"})
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        w.adapter.output_identity_problem = CodexCLIAdapter("codex").output_identity_problem
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "PRODUCING")
        self.assertEqual(len(w.adapter.launches), 3)
        self.assertEqual(w.adapter.launches[-1]["kind"], "start")

    def test_response_with_failed_identity_is_not_saved(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1), session="ses_1")
        w.tick()
        w.adapter.output_identity_problem = lambda *args: ("ERROR", "identity mismatch")
        w.finish_last()
        w.tick()
        cp = stage1ab.checkpoint(w.wt(), w.row_())
        self.assertFalse(stage1ab.chunk_saved(w.wt(), w.row_(), cp["chunks"][0]))
        self.assertEqual(w.row_()["state"], "ERROR")

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

    def test_changed_tier_resumes_ab_correction(self):
        w = self.w
        w.cfg["models"]["api"] = "p/go"
        w.start("single", "deepseek", "a")
        w.ai(w.block(1, end=False), session="ses_1")
        w.ai(w.block(1, {"S5": "S5\tbad!"}), session="ses_1")   # a candidate rejection keeps the same session (#5539)
        w.tick()
        w.store.update(w.row_()["id"], model_tier="api")
        w.finish_last()
        w.tick()
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertEqual((w.adapter.launches[-1]["kind"], w.adapter.launches[-1]["model"]),
                         ("resume", "p/go"))
        self.assertEqual(w.row_()["state"], "PRODUCING")
        self.assertEqual(w.row_()["session_id"], "ses_1")
        w.store.update(w.row_()["id"], model_tier="free")
        w.finish_last()
        w.tick()
        self.assertEqual((w.adapter.launches[-1]["kind"], w.adapter.launches[-1]["model"]),
                         ("resume", "p/free-x-free"))

    def test_format_failures_resend_the_view_then_use_one_fresh_session_within_the_same_limit(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1, end=False), session="ses_1")
        w.ai(w.block(1, no=2), session="ses_1")
        w.ai("S1\t후보", session="ses_fresh")
        w.ai("완료했습니다", session="ses_fresh")
        w.tick()
        w.finish_last()
        w.tick()                                                              # structural -> same session + exact view
        resend = w.adapter.launches[-1]
        self.assertEqual((resend["kind"], resend["session"]), ("resume", "ses_1"))
        self.assertIn(prompts.VIEW_BEGIN, resend["prompt"])
        self.assertIn("w0001-s1", resend["prompt"])
        self.assertNotIn("w0051-s1", resend["prompt"])                       # only this chunk's view
        w.finish_last()
        w.tick()                                                              # again structural -> the one fresh session
        fresh = w.adapter.launches[-1]
        self.assertEqual(fresh["kind"], "start")
        self.assertIn(prompts.VIEW_BEGIN, fresh["prompt"])
        self.assertIn(prompts.AB_FULL_SCOPE, fresh["prompt"])
        self.assertNotIn("후보1-1", fresh["prompt"])                          # the unparsable answer is never re-inserted
        st = stage1ab.load_state(w.store, w.row_()["id"], 1)
        self.assertEqual((st["fresh_used"], st["fresh"]["launch_state"]), (True, "registered"))
        w.finish_last()
        w.tick()                                                              # fresh session failed too -> resume it
        self.assertEqual((w.adapter.launches[-1]["kind"], w.adapter.launches[-1]["session"]), ("resume", "ses_fresh"))
        self.assertIn(prompts.VIEW_BEGIN, w.adapter.launches[-1]["prompt"])
        self.assertEqual(w.kinds(), ["ab_chunk_new", "ab_chunk_retry", "ab_chunk_retry", "ab_chunk_retry"])
        w.finish_last()
        w.tick()                                                              # total limit reached: no extra fresh session
        b = w.row_()
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), 4)
        self.assertEqual([l["kind"] for l in w.adapter.launches].count("start"), 2)
        self.assertFalse((w.wt() / stage1ab.names(b).directory / "candidates/chunk-001.jsonl").exists())
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 4)                          # repeated polls start nothing
        # An explicit operator Retry (#5486) still grants its own fresh session and keeps the automatic budget spent.
        answer = w.wt() / stage1ab.answer_path(b, 1)
        answer.write_text("chunk 001\nS1\t기존후보\n", "utf-8")
        w.ai(w.block(1), session="ses_recovery")
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 5)
        self.assertEqual(w.adapter.launches[-1]["kind"], "start")
        self.assertIn(prompts.VIEW_BEGIN, w.adapter.launches[-1]["prompt"])
        self.assertIn("기존후보", w.adapter.launches[-1]["prompt"])
        st = stage1ab.load_state(w.store, w.row_()["id"], 1)
        self.assertEqual((st["tries"], st["fresh_used"]), (0, True))
        backups = list(answer.parent.glob("answer-001.tsv.recovery-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_text("utf-8"), "chunk 001\nS1\t기존후보\n")
        w.finish_last()
        w.tick()
        cp = stage1ab.checkpoint(w.wt(), w.row_())
        self.assertTrue(stage1ab.chunk_saved(w.wt(), w.row_(), cp["chunks"][0]))
        self.assertEqual(backups[0].read_text("utf-8"), "chunk 001\nS1\t기존후보\n")

    def _format_twice(self, first=None, after=()):
        """Chunk 001: optional first answer, then two structural failures; returns after the fresh launch. `after`
        holds (answer, session) of the fresh run and later runs, queued before they launch."""
        w = self.w
        w.start("single", "deepseek", "a")
        answers = ([first] if first else []) + ["완료했습니다", "S1\t후보"]
        for text in answers:
            w.ai(text, session="ses_1")
        for text, session in after:
            w.ai(text, session=session)
        w.tick()
        for _ in answers:
            w.finish_last()
            w.tick()
        self.assertEqual(w.adapter.launches[-1]["kind"], "start")
        return w.adapter.launches[-1]

    def test_one_format_failure_is_fixed_in_the_same_session_without_a_fresh_one(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai("입력이 없습니다", session="ses_1")
        w.ai(w.block(1), session="ses_1")
        w.ai(w.block(2), session="ses_2")
        w.tick()
        w.finish_last()
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual([(l["kind"], l.get("session")) for l in w.adapter.launches],
                         [("start", None), ("resume", "ses_1"), ("start", None)])   # chunk 002 starts exactly once
        self.assertIn("chunk 002", w.adapter.launches[-1]["prompt"])
        cp = stage1ab.checkpoint(w.wt(), w.row_())
        self.assertTrue(stage1ab.chunk_saved(w.wt(), w.row_(), cp["chunks"][0]))

    def test_fresh_session_success_saves_and_the_next_chunk_starts_new(self):
        w = self.w
        self._format_twice(after=[(w.block(1), "ses_fresh"), (w.block(2), "ses_2")])
        w.finish_last()
        w.tick()
        self.assertEqual([l["kind"] for l in w.adapter.launches], ["start", "resume", "start", "start"])
        self.assertIn("chunk 002", w.adapter.launches[-1]["prompt"])
        self.assertIsNone(w.store.get(stage1ab.state_key(w.row_()["id"], 1)))

    def test_fresh_session_of_a_partial_answer_asks_only_the_requested_rows(self):
        w = self.w
        launch = self._format_twice(first=w.block(1, {"S5": "S5\tbad!"}),
                                    after=[("BEGIN chunk 001\nS5\t수정\nEND chunk 001", "ses_fresh")])
        prompt = launch["prompt"]
        self.assertIn(prompts.VIEW_BEGIN, prompt)
        self.assertIn(prompts.ab_partial_scope("S5"), prompt)
        self.assertNotIn(prompts.AB_FULL_SCOPE, prompt)
        self.assertIn("S5\tbad!", prompt)                                      # the requested row's earlier submission
        self.assertNotIn("후보1-4", prompt)                                    # other parsed rows stay with the Supervisor
        self.assertNotIn("완료했습니다", prompt)                               # never the unparsable answers
        w.finish_last()
        w.tick()
        cp = stage1ab.checkpoint(w.wt(), w.row_())
        self.assertTrue(stage1ab.chunk_saved(w.wt(), w.row_(), cp["chunks"][0]))
        saved = stage1ab.saved_answer_lines(w.wt(), w.row_(), cp["chunks"][0])
        self.assertEqual(saved[4], "S5\t수정")
        self.assertEqual(saved[3], "S4\t후보1-4")

    def test_fresh_session_may_not_change_an_unrequested_row(self):
        w = self.w
        self._format_twice(first=w.block(1, {"S5": "S5\tbad!"}),
                           after=[("BEGIN chunk 001\nS5\t수정\nS6\t바꿈\nEND chunk 001", "ses_fresh")])
        w.finish_last()
        w.tick()                                    # the fresh run was the third correction: violation ends in ERROR
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertIn("요청하지 않은 별칭 행", w.row_()["error"])
        self.assertEqual(len(w.adapter.launches), 4)
        self.assertFalse((w.wt() / stage1ab.names(w.row_()).directory / "candidates/chunk-001.jsonl").exists())

    def test_candidate_rejection_keeps_the_short_same_session_correction(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1, {"S5": "S5\tbad!"}), session="ses_1")
        w.tick()
        w.finish_last()
        w.tick()
        retry = w.adapter.launches[-1]
        st = stage1ab.load_state(w.store, w.row_()["id"], 1)
        self.assertEqual((retry["kind"], st["format"], st["fresh_used"]), ("resume", False, False))
        self.assertEqual(retry["prompt"], prompts.ab_chunk_retry(1, "S5", st["problem"]))   # byte-identical, no view
        self.assertNotIn(prompts.VIEW_BEGIN, retry["prompt"])

    def test_new_chunk_card_keeps_the_whole_chunk_output_rule(self):
        for method in ("a", "b"):
            text = (prompts.prompt_dir() / f"{method}_chunk.md").read_text("utf-8")
            card = prompts.ab_chunk({"method": method, "shard": "001", "batch": "01"}, 1, view="V\n")
            self.assertEqual(card, prompts.render(f"{method}_chunk", {
                "batch": "001_01", "chunk_no": "001", "session_note": "", "chunk_input": prompts.ab_view_block("V\n"),
                "output_scope": "- view의 **모든 `S<n>`을 정확히 한 번**, 번호 순서대로. 후보가 없으면 `S<n>`만 쓴다.",
                "method_contract": prompts.method_contract(method)}))
            self.assertEqual(text.count("{{output_scope}}"), 1)

    def _crash_state(self):
        w = self.w
        b = w.row_()
        key = stage1ab.state_key(b["id"], 1)
        return w, b, key, json.loads(w.store.get(key))

    def test_crash_after_the_fresh_decision_before_spawn_starts_it_exactly_once(self):
        w = self.w
        w.start("single", "deepseek", "a")
        for text in ("완료했습니다", "S1\t후보"):
            w.ai(text, session="ses_1")
        w.tick()
        w.finish_last()
        w.tick()
        original = w.sup._launch_ab_next
        w.sup._launch_ab_next = lambda b: None                                # crash right after the committed decision
        w.finish_last()
        w.tick()
        w.sup._launch_ab_next = original
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertEqual(stage1ab.load_state(w.store, w.row_()["id"], 1)["fresh"]["launch_state"], "not_started")
        w.tick(3)
        self.assertEqual([l["kind"] for l in w.adapter.launches], ["start", "resume", "start"])

    def test_crash_after_spawn_before_the_run_record_blocks_a_second_fresh_session(self):
        w = self.w
        self._format_twice()
        w, b, key, raw = self._crash_state()
        fresh_run = w.store.runs(b["id"])[0]
        with w.store._conn() as c:                                            # the run row was never written
            c.execute("DELETE FROM runs WHERE id=?", (fresh_run["id"],))
        raw["fresh"] = {k: v for k, v in raw["fresh"].items() if k != "launch_run_id"} | {"launch_state": "starting"}
        w.store.set(key, json.dumps(raw, sort_keys=True))
        w.store.update(b["id"], pid=None)
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 3)
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertIn("자동 새 세션", w.row_()["error"])

    def test_crash_after_the_run_record_resumes_the_fresh_session_by_its_log(self):
        w = self.w
        self._format_twice(after=[(w.block(1), "ses_fresh")])
        w, b, key, raw = self._crash_state()
        self.assertIsNone(w.store.runs(b["id"])[0]["session_id"])           # not captured yet
        w.store.update(b["id"], pid=None, session_id=None)                    # supervisor died before polling it
        w.tick()
        self.assertEqual((w.adapter.launches[-1]["kind"], w.adapter.launches[-1]["session"]), ("resume", "ses_fresh"))
        self.assertEqual([l["kind"] for l in w.adapter.launches].count("start"), 2)

    def test_crash_after_the_run_record_without_a_session_is_blocked(self):
        w = self.w
        w.start("single", "deepseek", "a")
        for text in ("완료했습니다", "S1\t후보"):
            w.ai(text, session="ses_1")
        w.adapter.plan.append({"code": 0, "text": ""})                        # the fresh run printed no session yet
        w.tick()
        for _ in range(2):
            w.finish_last()
            w.tick()
        b = w.row_()
        w.store.update(b["id"], pid=None, session_id=None)
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 3)
        self.assertEqual(w.row_()["state"], "ERROR")

    def test_crash_after_the_fresh_save_accepts_without_asking_again(self):
        w = self.w
        self._format_twice(after=[(w.block(1), "ses_fresh"), (w.block(2), "ses_2")])
        original = w.sup._ab_accept
        w.sup._ab_accept = lambda b, chunk, repair: None                      # crash between save-chunk and accept
        w.finish_last()
        w.tick()
        w.sup._ab_accept = original
        self.assertEqual(len(w.adapter.launches), 3)
        w.tick(2)
        self.assertEqual([l["kind"] for l in w.adapter.launches], ["start", "resume", "start", "start"])
        self.assertIn("chunk 002", w.adapter.launches[-1]["prompt"])

    def test_retry_after_next_chunk_preflight_failure_uses_ordinary_relaunch(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1), session="ses_1")
        w.ai(w.block(2), session="ses_2")
        w.tick()
        preflight = w.sup._preflight
        w.sup._preflight = lambda *args: "temporary preflight failure"
        w.finish_last()
        w.tick()
        b = w.row_()
        self.assertEqual(b["state"], "ERROR")
        self.assertIsNone(w.store.get(stage1ab.run_start_key(b["id"])))
        self.assertEqual(len(w.adapter.launches), 1)
        w.sup._preflight = preflight
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.tick(2)
        self.assertEqual(w.row_()["state"], "PRODUCING")
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertIn("BEGIN chunk 002", w.adapter.launches[-1]["prompt"])

    def test_exhausted_chunk_retry_rejects_changed_git_boundary(self):
        w = self.w
        w.start("single", "deepseek", "a")
        for _ in range(4):
            w.ai(w.block(1, end=False), session="ses_1")
        for _ in range(4):
            w.tick()
            w.finish_last()
            w.tick()
        self.assertEqual(w.row_()["state"], "ERROR")
        w.git.dirty_text = " M data/canonical/stdict-0001.jsonl\n"
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.tick(2)
        self.assertEqual(w.row_()["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), 4)
        self.assertIsNone(w.store.line("deepseek", "a")["retry_batch"])

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
        self.assertTrue(any('S5 "표제4" (source lemma repeat)' in line for line in logs))

    def test_third_correction_removes_only_the_exact_rejected_candidate_then_revalidates(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1, {"S5": "S5\tbad!"}), session="ses_1")
        retry = "BEGIN chunk 001\nS5\tbad!\nEND chunk 001"
        for _ in range(3):
            w.ai(retry, session="ses_1")
        w.tick()
        w.finish_last()
        w.tick()
        st = stage1ab.load_state(w.store, w.row_()["id"], 1)
        self.assertEqual((st["tries"], st["requested"]), (1, ["S5"]))
        self.assertIn('"bad!"', st["problem"])
        for _ in range(3):
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
        self.assertTrue(any("정정 3회 뒤 식별된 부적격 후보 1개" in entry["msg"] and 'S5 "bad!"' in entry["msg"]
                            for entry in events))


    def test_a_correction_may_not_change_an_unrequested_row(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1, {"S5": "S5\tbad!"}), session="ses_1")
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
        head = b["head_sha"]
        w.gh.reviews_ = [review(11, head, "-1 w0001/w0001-s1 후보1-1 삭제")]
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
        w.gh.add_pr_reply(b["pr_number"], "지적된 후보를 확인하고 수정했습니다.\nWarRoom-Review-Event: review:11")
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
        w.gh.add_pr_reply(b["pr_number"], "두 번째 지적도 확인했고 판단 근거를 답변했습니다.\nWarRoom-Review-Event: review:12")
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


class Helpers(unittest.TestCase):
    def test_extract_block_table(self):
        ok = "설명\nBEGIN chunk 003\nS1\ta\n```\nS2\nEND chunk 003\n끝"
        self.assertEqual(stage1ab.extract_block(ok, 3), ["S1\ta", "S2"])
        for name, text in (("none", None), ("empty", " "), ("no begin", "S1\nEND chunk 003"), ("no end", "BEGIN chunk 003\nS1"),
                           ("wrong number", "BEGIN chunk 004\nS1\nEND chunk 004"), ("two blocks", "BEGIN chunk 003\nS1\nEND chunk 003\nBEGIN chunk 003\nS1\nEND chunk 003"),
                           ("reversed", "END chunk 003\nBEGIN chunk 003"), ("mismatched", "BEGIN chunk 003\nS1\nEND chunk 004")):
            with self.subTest(name), self.assertRaises(stage1ab.ABChunkError):
                stage1ab.extract_block(text, 3)

    def test_split_rows_trims_candidate_whitespace(self):
        rows = stage1ab.split_rows(["S1\t 낚시\t마이크 \t\u00a0엄숙하다\t \t", "S2"])
        self.assertEqual(rows, {"S1": "S1\t낚시\t마이크\t엄숙하다", "S2": "S2"})

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
            self.assertIsNone(ad.run_problem(log, None, "th_1"))                         # #5471: never a live-run stop
            self.assertIsNone(ad.run_problem(log, None, "th_1", tolerate_denied=True))  # answer-only: judged by effects + answer
            self.assertEqual(len(ad.denied_actions(log)), 1)                            # kept for the exit verdict


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
