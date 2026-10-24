"""Issue #1362: readable agent log, fixed-size cards, Stop All target, Batch Detail header, board controls."""
import asyncio
import json
import time
import unittest

from tests.fakes import World
from tests.test_tui import PRODUCERS, make_app, textual
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

    def test_card_is_four_fixed_lines_for_every_phase_and_text_length(self):
        from warroom.views import CARD_LINES, CARD_W, ICON, card_text
        from warroom.views import cell_len
        long_ko = "아주 긴 활동 메시지 " * 20
        for state in list(ICON) + ["UNKNOWN"]:
            for kw in ({}, {"pr": 1349, "records_done": 500, "records_total": 500, "drain": True,
                            "elapsed": 99999, "activity": (time.time(), long_ko)}):
                lines = card_text(self.status(state=state, **kw)).split("\n")
                self.assertEqual(len(lines), CARD_LINES, (state, kw))
                self.assertTrue(all(cell_len(l) <= CARD_W for l in lines), (state, lines))
        empty = card_text(self.status(batch=None)).split("\n")
        self.assertEqual(len(empty), CARD_LINES)

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

    def test_modes_have_only_short_labels(self):
        self.assertEqual(control.MODES, {"single": "Single", "continuous": "Continuous"})

    def test_detail_header_is_short_and_cleaned_worktree_is_history(self):
        from warroom.views import detail_header, detail_meta
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
        head = detail_header(st, reg, "deepseek")
        self.assertTrue(head.startswith("OpenCode / A · 009_02   COMPLETE   PR #1349   500/500"))
        for hidden in ("ffff", "ses_abc", "/gone/wt", "tier", "adapter="):
            self.assertNotIn(hidden, head)
        meta = detail_meta(st, reg, "deepseek")
        self.assertIn("ses_abc", meta)
        self.assertIn("f" * 40, meta)
        self.assertIn("과거 사용 경로", meta)
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


@unittest.skipIf(textual is None, "textual not installed")
class BoardAndDetail(unittest.TestCase):
    def test_controls_one_row_no_supervisor_text_and_model_select_hidden(self):
        from textual.widgets import Button, Select
        w = World()

        async def go():
            app = make_app(w)    # one registered model: deepseek / opencode
            async with app.run_test(size=(100, 40)) as pilot:
                await pilot.pause(0.3)
                ids = ["adapter", "method", "mode", "start", "drain-all", "stop-all"]
                rows = {i: app.query_one(f"#{i}").region for i in ids}
                self.assertEqual({r.y for r in rows.values()}, {rows["adapter"].y}, rows)
                self.assertTrue(all(r.right <= 100 for r in rows.values()), rows)
                self.assertFalse(app.query_one("#model").display)
                self.assertEqual(app.query_one("#adapter", Select).value, "opencode")
                self.assertEqual([v for _, v in app.query_one("#mode", Select)._options if v != Select.BLANK],
                                 ["single", "continuous"])
                text = " ".join(str(s.render()) for s in app.query("Static"))
                self.assertNotIn("Supervisor: running", text)
                self.assertNotIn("진행 라인", text)
                # Stop All is disabled with nothing to stop, then Start enables it.
                self.assertTrue(app.query_one("#stop-all", Button).disabled)
                await pilot.click("#start")
                await pilot.pause(1.3)
                self.assertEqual(w.store.line("deepseek", "a")["run"], 1)
                self.assertFalse(app.query_one("#stop-all", Button).disabled)

        asyncio.run(go())
        w.tmp.cleanup()

    def test_control_bar_labels_one_line_and_buttons_equal_width(self):
        w = World()

        async def go():
            for width in (100, 120):
                app = make_app(w)
                async with app.run_test(size=(width, 40)) as pilot:
                    await pilot.pause(0.3)
                    sel = {i: app.query_one(f"#{i}").region for i in ("adapter", "method", "mode")}
                    btn = {i: app.query_one(f"#{i}").region for i in ("start", "drain-all", "stop-all")}
                    self.assertEqual({r.height for r in sel.values()}, {3}, sel)   # border + one text line
                    for i, labels in (("adapter", ["OpenCode"]), ("mode", ["Continuous"])):
                        self.assertGreaterEqual(sel[i].width - 10, max(map(len, labels)))
                    self.assertEqual(len({r.width for r in btn.values()}), 1, btn)
                    self.assertGreaterEqual(btn["start"].width, 14)
                    allr = [*sel.values(), *btn.values()]
                    self.assertEqual(len({r.y for r in allr}), 1, allr)
                    self.assertTrue(all(r.right <= width for r in allr))

        asyncio.run(go())
        w.tmp.cleanup()

    def test_narrow_terminal_does_not_clip_controls(self):
        w = World()

        async def go():
            app = make_app(w, PRODUCERS)   # several models on one adapter -> model Select shown
            async with app.run_test(size=(60, 40)) as pilot:
                await pilot.pause(0.4)
                for i in ["adapter", "model", "method", "mode", "start", "drain-all", "stop-all"]:
                    r = app.query_one(f"#{i}").region
                    self.assertTrue(app.query_one(f"#{i}").display and r.right <= 60 and r.width > 0, (i, r))

        asyncio.run(go())
        w.tmp.cleanup()

    def test_narrow_multi_model_selects_keep_full_label_and_do_not_overlap(self):
        w = World()

        async def go():
            app = make_app(w, PRODUCERS)
            ids = ["adapter", "model", "method", "mode", "start", "drain-all", "stop-all"]
            async with app.run_test(size=(120, 40)) as pilot:
                for width in (60, 40, 120, 60):      # shrink, shrink further, grow back, shrink again
                    await pilot.resize_terminal(width, 40)
                    await pilot.pause(0.4)
                    rs = {i: app.query_one(f"#{i}").region for i in ids}
                    for i in ("adapter", "model", "method", "mode"):
                        sel = app.query_one(f"#{i}")
                        want = sel.styles.width.value      # width the label needs (select_width)
                        self.assertEqual(rs[i].width, want, (width, i, rs[i]))
                        self.assertEqual(rs[i].height, 3, (width, i, rs[i]))
                    self.assertEqual(len({rs[i].width for i in ("start", "drain-all", "stop-all")}), 1, rs)
                    self.assertTrue(all(r.right <= width for r in rs.values()), (width, rs))
                    for a in ids:
                        for b in ids:
                            if a < b:
                                self.assertFalse(rs[a].intersection(rs[b]).area, (width, a, b, rs))

        asyncio.run(go())
        w.tmp.cleanup()

    def test_adapter_switch_without_resize_refits_controls(self):
        w = World()
        short = {"a": {"adapter": "codex", "models": {"free": "p/a", "go": "p/a2"}},
                 "b": {"adapter": "codex", "models": {"free": "p/b", "go": "p/b2"}},
                 "deepseek-long-label": {"adapter": "opencode", "models": {"free": "p/d", "go": "p/d2"}},
                 "sonnet-long-label": {"adapter": "opencode", "models": {"free": "p/s", "go": "p/s2"}}}
        ids = ["adapter", "model", "method", "mode", "start", "drain-all", "stop-all"]

        async def go():
            from textual.widgets import Select
            app = make_app(w, short)
            async with app.run_test(size=(100, 40)) as pilot:
                await pilot.pause(0.4)
                for target in ("opencode", "codex", "opencode", "codex"):   # terminal size never changes
                    app.query_one("#adapter", Select).value = target
                    await pilot.pause(0.5)
                    rs = {i: app.query_one(f"#{i}").region for i in ids if app.query_one(f"#{i}").display}
                    for i in ("adapter", "model", "method", "mode"):
                        self.assertEqual(rs[i].width, app.query_one(f"#{i}").styles.width.value, (target, i, rs[i]))
                        self.assertEqual(rs[i].height, 3, (target, i, rs[i]))
                    self.assertEqual(len({rs[i].width for i in ("start", "drain-all", "stop-all")}), 1, rs)
                    names = sorted(rs)
                    for a in names:
                        for b in names:
                            if a < b:
                                self.assertFalse(rs[a].intersection(rs[b]).area, (target, a, b, rs))

        asyncio.run(go())
        w.tmp.cleanup()

    def test_supervisor_failure_stays_visible(self):
        w = World()

        async def go():
            app = make_app(w)
            app._t0 -= 60        # past the first-heartbeat grace
            async with app.run_test(size=(100, 40)) as pilot:
                await pilot.pause(0.3)
                self.assertIn("Supervisor", str(app.query_one("#banner").render()))
                w.store.set("heartbeat", str(time.time()))
                await pilot.pause(1.3)
                self.assertFalse(app.query_one("#banner").display)

        asyncio.run(go())
        w.tmp.cleanup()

    def test_detail_readable_raw_and_autoscroll_visibility(self):
        from textual.widgets import Button
        from warroom import tui
        w = World()
        w.start("single")
        w.adapter.plan.append({"code": 0})
        w.tick()
        b = w.row()
        log = w.paths.logs / "live.log"
        lines = [ev("step_start", {}), ev("text", {"text": "hello"})]
        log.write_text("\n".join(lines) + "\n")
        w.store.add_run(b["id"], "produce", None, None, log, log.with_suffix(".exit"))

        def shown(scr):
            return ["".join(seg.text for seg in l) for l in scr.log_w.lines]

        async def go():
            app = make_app(w)
            async with app.run_test(size=(140, 50)) as pilot:
                await pilot.pause(0.2)
                await pilot.click("#card-deepseek-a")
                await pilot.pause(0.3)
                scr = app.screen
                scr.refresh_view()
                self.assertEqual([s.strip() for s in shown(scr)], ["── step ──", "● hello"])
                self.assertTrue(scr.query_one("#follow", Button).display)       # run still active
                self.assertIn("Auto-scroll", str(scr.query_one("#follow", Button).label))
                with open(log, "a") as f:                                      # incremental, not reloaded
                    f.write(ev("text", {"text": "more"}) + "\n")
                scr.refresh_view()
                self.assertEqual(len(scr.log_w.lines), 3)
                # Raw Log shows the same file verbatim.
                await pilot.click("#raw")
                await pilot.pause(0.2)
                scr.refresh_view()
                self.assertEqual(shown(scr)[0].strip(), lines[0])
                self.assertEqual(len(scr.log_w.lines), 3)
                await pilot.click("#raw")
                # Finished run: Auto-scroll hidden, scrolling does not toggle anything.
                w.store.finish_runs(b["id"], 0)
                scr.refresh_view()
                self.assertFalse(scr.query_one("#follow", Button).display)
                # Audit Log of an unfinished batch (PAUSED, every Run ended): no live Run -> hidden.
                w.store.update(b["id"], state="PAUSED", pid=None)
                scr._switch("audit")
                scr.refresh_view()
                self.assertFalse(scr.query_one("#follow", Button).display)
                # A Run that is still running makes Audit (and its Run) live again; manual scroll / resume.
                rid = w.store.add_run(b["id"], "fix_resume", None, None, log, log.with_suffix(".exit"))
                scr.refresh_view()
                self.assertTrue(scr.query_one("#follow", Button).display)
                scr._manual_scroll()
                self.assertFalse(scr.log_w.auto_scroll)
                scr.action_follow()
                self.assertTrue(scr.log_w.auto_scroll)
                scr._switch(f"run:{rid}")
                scr.refresh_view()
                self.assertTrue(scr.query_one("#follow", Button).display)

        asyncio.run(go())
        w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
