import asyncio
import unittest

try:
    import textual  # noqa: F401
except ImportError:  # pragma: no cover - TUI deps are optional for core tests
    textual = None

from tests.fakes import World


@unittest.skipIf(textual is None, "textual not installed")
class TuiSmoke(unittest.TestCase):
    def test_start_button_sets_run_and_shows_state(self):
        from warroom import tui
        w = World()
        tui.ensure_supervisor = lambda paths: None

        class App(tui.WarRoom):
            def __init__(self):
                super().__init__()
                self.paths, self.store = w.paths, w.store

            def check_auth(self):
                self._auth = {"ok": True, "account": "neverworkalone-agent", "problems": []}

        async def go():
            app = App()
            async with app.run_test() as pilot:
                await pilot.click("#start")
                await pilot.pause(0.2)
                self.assertEqual(w.store.get("run"), "1")
                await pilot.click("#stop")
                self.assertEqual(w.store.get("stop_after"), "1")
                await pilot.click("#force")
                await pilot.pause(0.1)
                self.assertEqual(w.store.get("force_stop") or "0", "0")  # needs confirmation
                await pilot.click("#no")
                self.assertEqual(w.store.get("force_stop") or "0", "0")
                self.assertIn("WAR ROOM", app.TITLE)

        asyncio.run(go())
        w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
