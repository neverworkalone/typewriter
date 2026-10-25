"""Issue #1362: readable agent log, fixed-size cards, Stop All target, Batch Detail header, board controls."""
import json
import time
import unittest

from tests.fakes import World
from warroom import control
from warroom.logrender import render_line


def ev(kind, part=None, **extra):
    return json.dumps({"type": kind, **({"part": part} if part is not None else {}), **extra}, ensure_ascii=False)


class ReadableLog(unittest.TestCase):
    def test_event_table(self):
        tool = {"type": "tool", "tool": "bash", "state": {
            "status": "completed", "input": {"command": "git push origin HEAD", "description": "push"},
            "output": "ok\nline2", "metadata": {"exit": 0}}}
        cases = [
            (ev("text", {"text": 'JSON in text: {"a": "b\\n"}\nsecond'}), ["● JSON in text: {\"a\": \"b\\n\"}", "  second"]),
            (ev("tool_use", tool), ["▸ bash — push", "  $ git push origin HEAD", "  exit=0", "  → ok", "    line2"]),
            (ev("tool_use", {"type": "tool", "tool": "read", "state": {"status": "completed", "input": {"filePath": "/a/b"}}}),
             ["▸ read", "  filePath=/a/b"]),
            (ev("tool_use", {"type": "tool", "tool": "bash", "state": {"status": "error", "input": {"command": "x"}, "error": "boom"}}),
             ["▸ bash", "  $ x", "  [error]", "  ✖ boom"]),
            (ev("error", error={"name": "APIError", "data": {"message": "quota"}}), ["✖ ERROR: APIError — quota"]),
            (ev("step_start", {}), ["── step ──"]),
            (ev("step_finish", {"reason": "stop"}), ["── step 종료 (stop) ──"]),
            ("plain stderr line", ["plain stderr line"]),
            ("{not json", ["{not json"]),
            ("[1, 2]", ["[1, 2]"]),
            ("", []),
        ]
        for raw, want in cases:
            self.assertEqual(render_line(raw), want, raw)

    def test_unknown_event_is_shown_not_dropped_and_no_invented_timestamp(self):
        out = render_line(ev("mystery", {"x": 1}))
        self.assertEqual(len(out), 1)
        self.assertTrue(out[0].startswith("? mystery:") and '"x": 1' in out[0])
        self.assertNotRegex(render_line(ev("step_start", {}))[0], r"^\d\d:\d\d")
        self.assertRegex(render_line(ev("step_start", {}, timestamp=1700000000000))[0], r"^\d\d:\d\d:\d\d ")

    def test_long_output_is_summarised_with_raw_pointer_and_secrets_redacted(self):
        big = "\n".join(f"row {i}" for i in range(100))
        out = render_line(ev("tool_use", {"type": "tool", "tool": "bash", "state": {
            "status": "completed", "input": {"command": "seq"}, "output": big}}))
        self.assertLess(len(out), 20)
        self.assertIn("Raw Log", out[-1])
        sec = render_line(ev("text", {"text": "token: ghp_" + "a" * 30}))
        self.assertNotIn("ghp_a", "".join(sec))
        self.assertIn("[REDACTED]", "".join(sec))


class CardsAndControl(unittest.TestCase):
    def status(self, **kw):
        base = {"method": "a", "batch": "009_02", "state": "PRODUCING", "drain": False, "progress": None,
                "pr": None, "activity": None}
        return {**base, **kw}

    def test_card_shows_only_observed_progress_and_real_elapsed_without_activity(self):
        from warroom.views import CARD_W, card_text, cell_len, fmt_elapsed
        act = (time.mktime(time.strptime(time.strftime("%Y-%m-%d") + " 18:47", "%Y-%m-%d %H:%M")),
               "PRODUCING 시작 (produce, model tier=free)")
        # (status overrides, records line, bar shown, ops line)
        table = [
            (dict(), "진행량 확인 중", False, "PR 생성 전"),
            (dict(elapsed=312, activity=act), "진행량 확인 중", False, "PR 생성 전 경과 5분 12초"),
            (dict(records_done=127, records_total=500, elapsed=312), "127 / 500 records 25.4%", True,
             "PR 생성 전 경과 5분 12초"),
            (dict(state="COMPLETE", records_done=83, records_total=83, pr=1349, elapsed=3900),
             "83 / 83 records 100.0%", True, "PR #1349 경과 1시간 05분"),
            (dict(records_done=None, records_total=500), "진행량 확인 중", False, "PR 생성 전"),
            (dict(records_done=0, records_total=500), "0 / 500 records 0.0%", True, "PR 생성 전"),
        ]
        for kw, records, bar, ops in table:
            lines = card_text(self.status(**kw)).split("\n")
            self.assertEqual(" ".join(lines[1].split()), records, kw)
            self.assertEqual(bool(lines[2]), bar, kw)
            self.assertEqual(" ".join(lines[3].split()), ops, kw)
            self.assertNotIn("최근:", "\n".join(lines), kw)
            if bar:
                self.assertEqual(cell_len(lines[2]), CARD_W)
        half = card_text(self.status(records_done=250, records_total=500)).split("\n")[2]
        self.assertEqual((half.count("█"), half.count("░")), (CARD_W // 2, CARD_W // 2))
        # State, batch and PR number appear once; the first line carries Method, batch, state and icon.
        full = card_text(self.status(state="WAITING_REVIEW", pr=7, drain=True)).split("\n")
        self.assertTrue(full[0].startswith("A · 009_02") and full[0].endswith("REVIEW + DRAIN ◔"))
        self.assertEqual(sum(l.count("REVIEW") for l in full), 1)
        self.assertEqual([fmt_elapsed(x) for x in (0, 59, 60, 312, 3599, 3900)],
                         ["0초", "59초", "1분 00초", "5분 12초", "59분 59초", "1시간 05분"])

    def test_producing_is_shown_as_working_but_stays_producing_in_the_state_machine(self):
        from warroom.views import card_text, detail_header
        st = self.status(state="PRODUCING", mode="single", run=False, drain_once=False, error=None, blocked="",
                         activity=(time.time(), "PRODUCING 시작"))
        self.assertIn("WORKING ▶", card_text(st).split("\n")[0])
        self.assertNotIn("PRODUCING", card_text(st))
        header = detail_header(st, {"adapter": "opencode"}, "deepseek")
        self.assertIn("WORKING", header)
        self.assertNotIn("PRODUCING", header.splitlines()[0])
        self.assertIn("최근 활동", header)
        self.assertIn("PRODUCING 시작", header)        # detail keeps the recent event hidden from the card
        self.assertIn("PRODUCING", control.STATES_HELP)      # stored/supervisor state names are unchanged

    def test_elapsed_is_the_sum_of_recorded_runs(self):
        w = World()
        bid = w.store.create_batch(method="a", producer="deepseek", shard="009", batch="02",
                                   branch="b", worktree="/x")
        self.assertIsNone(control.line_status(w.store, "deepseek", "a")["elapsed"])   # no run yet: nothing shown
        with w.store._conn() as c:
            c.execute("INSERT INTO runs(batch_id,kind,started_at,ended_at) VALUES(?,?,?,?)", (bid, "produce", 100.0, 160.0))
            c.execute("INSERT INTO runs(batch_id,kind,started_at,ended_at) VALUES(?,?,?,?)", (bid, "fix", 500.0, 530.0))
        self.assertEqual(control.line_status(w.store, "deepseek", "a")["elapsed"], 90.0)   # waiting time is not counted
        w.tmp.cleanup()

    def test_empty_line_shows_pending_start_and_drain_via_real_commands(self):
        from warroom.views import card_text, detail_header
        w = World()
        cell = lambda: control.line_status(w.store, "deepseek", "a")
        mid = lambda: card_text(cell()).split("\n")[1]
        reg = {"adapter": "opencode"}
        self.assertEqual(mid(), "— 실행 이력 없음")
        ok, _ = control.start(w.store, "deepseek", "a", "single")      # reserved, no batch yet
        self.assertTrue(ok)
        self.assertEqual(mid(), "— 시작 예약 중")
        control.set_drain(w.store, "deepseek", "a", True)               # blocks the new batch
        self.assertEqual(mid(), "비어 있음 + DRAIN 시작 예약")
        self.assertIn("DRAIN", detail_header(cell(), reg, "deepseek"))
        control.set_drain(w.store, "deepseek", "a", False)              # Cancel Drain
        self.assertEqual(mid(), "— 시작 예약 중")
        control.stop_line(w.store, "deepseek", "a")
        self.assertEqual(mid(), "— 실행 이력 없음")
        control.start(w.store, "deepseek", "a", "single")
        control.drain_all(w.store, [("deepseek", m) for m in "abcd"])   # a reservation without a batch is cancelled
        self.assertEqual(mid(), "— 실행 이력 없음")
        self.assertEqual(len(card_text(cell()).split("\n")), 4)
        w.tmp.cleanup()

    def test_stop_all_target_matches_what_stop_lines_controls(self):
        w = World()
        lines = [("deepseek", m) for m in "abcd"]
        self.assertFalse(control.can_stop_all(w.store, lines))
        for state, run, want in [("COMPLETE", 0, False), ("PRODUCING", 0, True), ("FIXING", 0, True),
                                 ("WAITING_REVIEW", 0, True), ("PAUSED", 0, True), ("ERROR", 0, True),
                                 ("COMPLETE", 1, True)]:
            w = World()
            bid = w.store.create_batch(method="a", producer="deepseek", shard="001", batch="01",
                                       branch="b", worktree="/x")
            w.store.update(bid, state=state)
            w.store.set_line("deepseek", "a", run=run)
            self.assertEqual(control.can_stop_all(w.store, lines), want, (state, run))
        w.tmp.cleanup()

    def test_detail_header_is_short_and_cleaned_worktree_is_history(self):
        from warroom.views import detail_meta
        w = World()
        bid = w.store.create_batch(method="a", producer="deepseek", shard="009", batch="02",
                                   branch="br", worktree="/gone/wt")
        w.store.update(bid, state="COMPLETE", pr_number=1349, head_sha="f" * 40, session_id="ses_abc",
                       records_done=500, records_total=500)
        st = control.line_status(w.store, "deepseek", "a")
        self.assertEqual((st["state"], st["batch"], st["occupied"]), ("IDLE", None, False))   # COMPLETE -> EMPTY
        self.assertEqual(len(w.store.line_batches("deepseek", "a")), 1)                        # history is kept
        st.update(state="COMPLETE", batch="009_02", pr=1349, head="f" * 40, session="ses_abc",
                  worktree="/gone/wt", progress="500/500", updated=0)
        reg = {"label": "DeepSeek", "adapter": "opencode", "models": {}}

        meta = detail_meta(st, reg, "deepseek")
        self.assertIn("ses_abc", meta)
        self.assertIn("f" * 40, meta)
        w.tmp.cleanup()


class SelectWidth(unittest.TestCase):
    def test_width_fits_longest_label(self):
        from warroom.views import select_width
        cases = [(["OpenCode", "Codex"], 18), (["Single", "Continuous"], 20), (["A"], 18), ([], 18),
                 (["한글라벨"], 18), (["가" * 6], 22)]
        from warroom.views import control_columns
        for widths, total, want in [([18, 29, 12, 20, 14, 14, 14], 58, 2), ([18, 12, 14], 98, 3), ([30], 10, 1), ([], 5, 1),
                                    ([10, 10, 10, 10], 100, 4)]:
            self.assertEqual(control_columns(widths, total), want, (widths, total))
        for labels, want in cases:
            self.assertEqual(select_width(labels), want, labels)
