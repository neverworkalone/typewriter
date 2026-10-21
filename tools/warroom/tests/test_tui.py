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
