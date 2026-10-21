import asyncio
import unittest

try:
    import textual  # noqa: F401
except ImportError:  # pragma: no cover - TUI deps are optional for core tests
    textual = None

from tests.fakes import World


def make_app(w, producers=None):
    from warroom import tui
    tui.ensure_supervisor = lambda paths: None
    if producers:
        w.cfg["producers"] = producers

    class App(tui.WarRoom):
        def __init__(self):
            super().__init__()
            self.paths, self.store, self.cfg = w.paths, w.store, w.cfg
            from warroom.config import registry
            self.models = list(registry(w.cfg))

        def check_auth(self):
            self._auth = {"ok": True, "account": "neverworkalone-agent", "problems": []}

    return App()


PRODUCERS = {
    "deepseek": {"adapter": "opencode", "models": {"free": "p/free-x-free", "go": "p/go"}},
    "sonnet": {"adapter": "opencode", "models": {"free": "p/s-free", "go": ""}},
    "gpt": {"adapter": "opencode", "models": {"free": "p/g-free", "go": ""}},
    "extra": {"adapter": "opencode", "models": {"free": "p/e-free", "go": ""}},
}


@unittest.skipIf(textual is None, "textual not installed")
class TuiSmoke(unittest.TestCase):
    def test_board_layout_and_stop_dialog(self):
        from textual.widgets import Button
        from warroom import tui
        w = World()

        async def go():
            app = make_app(w, PRODUCERS)
            async with app.run_test(size=(180, 50)) as pilot:
                await pilot.pause(0.3)
                cards = list(app.query(tui.Card))
                self.assertEqual({c.region.height for c in cards}, {7})          # A-D and empty cards share a height
                col = app.query_one("#col-deepseek").region
                title = app.query_one("#title-deepseek")
                self.assertEqual(str(title.render()), "DeepSeek")
                self.assertEqual(title.region.width, col.width)
                # The card border is drawn mid-row, so 2 blank rows above / 1 below look even on screen.
                self.assertEqual(title.region.y - app.query_one("#controls").region.bottom, 2)
                self.assertEqual(app.query_one("#card-deepseek-a").region.y - title.region.bottom, 1)
                first = app.query_one("#card-deepseek-a").region
                self.assertGreaterEqual(first.y, title.region.bottom + 1)        # gap under the heading
                # Columns keep their order and widths with several models.
                self.assertEqual(len({c.region.width for c in cards}), 1)
                app.push_screen(tui.Confirm("deepseek / Method A 라인의 AI 실행을 즉시 중지합니다."))
                await pilot.pause(0.2)
                no, yes = app.screen.query_one("#no", Button), app.screen.query_one("#yes", Button)
                self.assertIs(app.focused, no)                                   # default is No ...
                self.assertLess(no.region.x, yes.region.x)                       # ... on the left
                box = app.screen.query_one("#confirm").region
                self.assertLessEqual(box.height, 8)                              # no empty space under the buttons
                self.assertLessEqual(box.bottom - yes.region.bottom, 3)
                await pilot.press("escape")

        asyncio.run(go())
        w.tmp.cleanup()

    def test_focus_border_shows_on_every_card_state(self):
        from warroom import tui
        w = World()
        for i, state in enumerate(("PRODUCING", "ERROR", "PAUSED", "COMPLETE"), 1):
            bid = w.store.create_batch(method="abcd"[i - 1], producer="deepseek", shard="001", batch="01",
                                       branch=f"b{i}", worktree=f"/x{i}")
            w.store.update(bid, state=state)

        async def go():
            app = make_app(w, PRODUCERS)
            async with app.run_test(size=(200, 60)) as pilot:
                await pilot.pause(1.3)
                seen = {}
                for me, state in zip("abcd", ("PRODUCING", "ERROR", "PAUSED", "COMPLETE")):
                    card = app.query_one(f"#card-deepseek-{me}")
                    self.assertTrue(card.has_class(state), (me, state))
                    before = card.styles.border_top
                    card.focus()
                    await pilot.pause(0.1)
                    seen[state] = (before, card.styles.border_top)
                focused = {v[1] for v in seen.values()}
                self.assertEqual(len(focused), 1, seen)                       # one focus look for all states
                for state, (before, after) in seen.items():
                    self.assertNotEqual(before, after, state)                  # and it differs from the resting border

        asyncio.run(go())
        w.tmp.cleanup()

    def test_tab_switches_between_regions_and_remembers_last_stop(self):
        from warroom import tui
        w = World()

        async def go():
            app = make_app(w, PRODUCERS)
            async with app.run_test(size=(200, 60)) as pilot:
                await pilot.pause(0.2)
                app.query_one("#method").focus()
                await pilot.press("tab")
                self.assertEqual(app.focused.id, "card-deepseek-a")          # first visit: first card
                await pilot.press("down", "right")
                self.assertEqual(app.focused.id, "card-sonnet-b")
                await pilot.press("tab")
                self.assertEqual(app.focused.id, "method")                   # back to where the bar was left
                await pilot.press("tab")
                self.assertEqual(app.focused.id, "card-sonnet-b")            # and to the card that was left
                await pilot.press("shift+tab")
                self.assertEqual(app.focused.id, "method")
                # Open Select: Tab does not move focus out of the dropdown.
                await pilot.press("enter")
                await pilot.pause(0.1)
                before = app.focused
                await pilot.press("tab")
                self.assertIs(app.focused, before)
                await pilot.press("escape")
                # Detail: buttons/source <-> log, remembering the button.
                app.query_one("#card-deepseek-a").focus()
                await pilot.press("enter")
                await pilot.pause(0.3)
                d = app.screen
                self.assertIsInstance(d, tui.LineDetail)
                d.query_one("#raw").focus()
                await pilot.press("tab")
                self.assertIs(app.focused, d.log_w)
                await pilot.press("tab")
                self.assertEqual(app.focused.id, "raw")
                await pilot.press("right", "right")
                self.assertEqual(app.focused.id, "source")
                await pilot.press("tab")
                self.assertIs(app.focused, d.log_w)
                await pilot.press("tab")
                self.assertEqual(app.focused.id, "source")

        asyncio.run(go())
        w.tmp.cleanup()

    def test_arrow_keys_move_between_controls_and_cards(self):
        from warroom import tui
        w = World()

        async def go():
            app = make_app(w, PRODUCERS)
            async with app.run_test(size=(200, 60)) as pilot:
                await pilot.pause(0.2)
                app.query_one("#adapter").focus()
                await pilot.press("right")
                self.assertEqual(app.focused.id, "model")
                await pilot.press("left")
                self.assertEqual(app.focused.id, "adapter")
                await pilot.press("left")          # wraps to the last enabled control
                self.assertEqual(app.focused.id, "drain-all")
                app.query_one("#card-deepseek-a").focus()
                await pilot.press("down")
                self.assertEqual(app.focused.id, "card-deepseek-b")
                await pilot.press("right")
                self.assertEqual(app.focused.id, "card-sonnet-b")
                await pilot.press("left", "up")
                self.assertEqual(app.focused.id, "card-deepseek-a")
                await pilot.press("left")          # edge: stays put
                self.assertEqual(app.focused.id, "card-deepseek-a")
                await pilot.press("up")            # top row returns to the controls
                self.assertEqual(app.focused.id, "start")
                # An open Select keeps Left/Right out of focus movement.
                app.query_one("#adapter").focus()
                await pilot.press("enter")
                await pilot.pause(0.1)
                before = app.focused
                await pilot.press("right")
                self.assertIs(app.focused, before)
                await pilot.press("escape")
                # Detail screen: Left/Right walk its buttons and the source Select.
                app.query_one("#card-deepseek-a").focus()
                await pilot.press("enter")
                await pilot.pause(0.3)
                self.assertIsInstance(app.screen, tui.LineDetail)
                app.screen.query_one("#raw").focus()
                await pilot.press("right")
                self.assertEqual(app.focused.id, "back")
                await pilot.press("right")
                self.assertEqual(app.focused.id, "source")
                first = next(b for b in app.screen.query_one("#line-controls").children
                             if b.display and b.focusable)
                await pilot.press("right")          # wraps to the first enabled button
                self.assertIs(app.focused, first)
                await pilot.press("left")
                self.assertEqual(app.focused.id, "source")

        asyncio.run(go())
        w.tmp.cleanup()

    def test_board_dynamic_columns_start_and_confirmations(self):
        from warroom import tui
        w = World()

        async def go():
            app = make_app(w, PRODUCERS)
            async with app.run_test(size=(200, 60)) as pilot:
                await pilot.pause(0.2)
                # 4 registered models x A/B/C/D fixed slots, none hard-coded to 3.
                self.assertEqual(len(app.query(tui.Card)), 16)
                self.assertEqual(len(app.query(".col")), 4)
                # No static Settings block on the board.
                self.assertEqual(len(app.query("#settings")), 0)
                # Clicking an empty slot opens detail and changes nothing.
                await pilot.click("#card-sonnet-b")
                await pilot.pause(0.2)
                self.assertIsInstance(app.screen, tui.LineDetail)
                self.assertEqual(w.store.lines(), [])  # viewing never creates a Line row
                await pilot.press("escape")
                await pilot.pause(0.1)
                self.assertNotIsInstance(app.screen, tui.LineDetail)
                # Start (default model/method) claims only that Line.
                await pilot.click("#start")
                await pilot.pause(0.2)
                self.assertEqual([(r["model"], r["method"], r["run"]) for r in w.store.lines()],
                                 [("deepseek", "a", 1)])
                # Stop All: Enter = No, Esc = No, Y = yes.
                await pilot.click("#stop-all")
                await pilot.pause(0.1)
                await pilot.press("enter")
                await pilot.pause(0.1)
                self.assertEqual(w.store.line("deepseek", "a")["force_stop"], 0)
                await pilot.click("#stop-all")
                await pilot.pause(0.1)
                await pilot.press("escape")
                await pilot.pause(0.1)
                self.assertEqual(w.store.line("deepseek", "a")["force_stop"], 0)
                await pilot.click("#stop-all")
                await pilot.pause(0.1)
                await pilot.press("y")
                await pilot.pause(0.1)
                ln = w.store.line("deepseek", "a")
                self.assertEqual((ln["force_stop"], ln["run"]), (1, 0))
                # Drain All <-> Cancel Drain toggles only the global flag.
                w.store.set_line("deepseek", "a", drain=1)
                await pilot.click("#drain-all")
                await pilot.pause(0.4)
                self.assertEqual(w.store.get("drain_all"), "1")
                await pilot.click("#drain-all")
                await pilot.pause(0.4)
                self.assertEqual(w.store.get("drain_all"), "0")
                self.assertEqual(w.store.line("deepseek", "a")["drain"], 1)

        asyncio.run(go())
        w.tmp.cleanup()

    def test_detail_tails_log_incrementally_and_follow(self):
        from warroom import tui
        w = World()
        w.start("single")
        w.adapter.plan.append({"code": 0})
        w.tick()
        b = w.row()
        log = w.paths.logs / "live.log"
        log.write_text("one\ntwo\n")
        w.store.add_run(b["id"], "produce", None, None, log, log.with_suffix(".exit"))

        async def go():
            app = make_app(w)
            async with app.run_test(size=(160, 50)) as pilot:
                await pilot.pause(0.2)
                await pilot.click("#card-deepseek-a")
                await pilot.pause(0.2)
                scr = app.screen
                self.assertIsInstance(scr, tui.LineDetail)
                scr.refresh_view()
                self.assertEqual(len(scr.log_w.lines), 2)
                with open(log, "a") as f:
                    f.write("three\n")
                scr.refresh_view()
                self.assertEqual(len(scr.log_w.lines), 3)   # only the increment was appended
                await pilot.press("up")
                self.assertFalse(scr.log_w.auto_scroll)
                await pilot.press("f")
                self.assertTrue(scr.log_w.auto_scroll)
                # Stop is gated by the confirm modal and scoped to this Line.
                await pilot.click("#stop")
                await pilot.pause(0.1)
                await pilot.press("n")
                await pilot.pause(0.1)
                self.assertEqual(w.store.line("deepseek", "a")["force_stop"], 0)
                await pilot.press("escape")
                await pilot.pause(0.1)
                self.assertNotIsInstance(app.screen, tui.LineDetail)

        asyncio.run(go())
        w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
