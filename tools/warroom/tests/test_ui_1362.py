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

    def test_card_is_three_fixed_lines_for_every_phase_and_text_length(self):
        from warroom.tui import CARD_W, ICON, card_text
        from rich.cells import cell_len
        long_ko = "아주 긴 활동 메시지 " * 20
        for state in list(ICON) + ["UNKNOWN"]:
            for kw in ({}, {"pr": 1349, "progress": "500/500", "drain": True,
                            "activity": (time.time(), long_ko)}):
                lines = card_text(self.status(state=state, **kw)).split("\n")
                self.assertEqual(len(lines), 3, (state, kw))
                self.assertTrue(all(cell_len(l) <= CARD_W for l in lines), (state, lines))
        empty = card_text(self.status(batch=None)).split("\n")
        self.assertEqual(len(empty), 3)
        full = card_text(self.status(state="WAITING_REVIEW", pr=7, progress="500/500", drain=True)).split("\n")
        self.assertTrue(full[0].startswith("A · 009_02"))
        self.assertEqual(full[1], "REVIEW + DRAIN 500/500")
        self.assertEqual(full[2], "PR #7")
        self.assertNotIn("500", card_text(self.status()))   # progress only when observed

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
        from warroom.tui import detail_header, detail_meta
        w = World()
        bid = w.store.create_batch(method="a", producer="deepseek", shard="009", batch="02",
                                   branch="br", worktree="/gone/wt")
        w.store.update(bid, state="COMPLETE", pr_number=1349, head_sha="f" * 40, session_id="ses_abc",
                       records_done=500, records_total=500)
        st = control.line_status(w.store, "deepseek", "a")
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

        asyncio.run(go())
        w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
