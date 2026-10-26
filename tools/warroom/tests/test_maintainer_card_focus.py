"""The Board's Maintainer card (row 5, DeepSeek column) is selectable like every other Card.

Invariant: every card on the Board is reachable by Tab, arrow keys and mouse click, and Enter/click on the Maintainer
card only opens a read-only detail. Textual-dependent: skipped when the War Room venv is not installed.
"""
import asyncio
import unittest
from unittest import mock

from tests.fakes import World

try:
    from warroom import tui
except ModuleNotFoundError:   # plain python3 without the venv: the core suite stays stdlib-only
    tui = None


@unittest.skipIf(tui is None, "textual not installed")
class MaintainerCardFocusTests(unittest.TestCase):
    def app(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.cfg["producers"] = {"claude": {"adapter": "claude", "model": "m", "effort": "high"},
                              "deepseek": {"adapter": "opencode", "models": {"free": "p/free-x-free", "go": "p/go"}}}
        patches = [mock.patch.object(tui, "Paths", return_value=w.paths),
                   mock.patch.object(tui, "load_config", return_value=w.cfg),
                   mock.patch.object(tui, "ensure_supervisor", return_value=""),
                   mock.patch.object(tui.WarRoom, "check_auth", lambda self: None)]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        return tui.WarRoom()

    def run_app(self, scenario):
        app = self.app()

        async def go():
            async with app.run_test(size=(200, 60)) as pilot:
                await pilot.pause()
                await scenario(app, pilot)
        asyncio.run(go())

    def test_card_is_focusable_and_in_arrow_and_tab_order(self):
        async def scenario(app, pilot):
            card = app.query_one("#card-maintainer", tui.MaintainerCard)
            self.assertTrue(card.focusable)
            col = app.maintainer_col
            app.query_one(f"#card-{col}-{app.methods[-1]}", tui.Card).focus()   # the Line above it
            await pilot.press("down")
            self.assertIs(app.focused, card)
            await pilot.press("up")
            self.assertEqual((app.focused.model, app.focused.method), (col, app.methods[-1]))
            self.assertIn(card, list(app.query(tui.Card)))   # Tab's "cards" region and arrows see it
        self.run_app(scenario)

    def test_enter_and_click_open_read_only_detail(self):
        async def scenario(app, pilot):
            card = app.query_one("#card-maintainer", tui.MaintainerCard)
            card.focus()
            await pilot.press("enter")
            await pilot.pause()
            self.assertIsInstance(app.screen, tui.MaintainerDetail)
            await pilot.press("escape")
            await pilot.pause()
            self.assertIs(app.screen, app.screen_stack[0])
            await pilot.click("#card-maintainer")
            await pilot.pause()
            self.assertIsInstance(app.screen, tui.MaintainerDetail)
            self.assertEqual(app.store.maintenance_rows(), [])   # opening starts/changes nothing
        self.run_app(scenario)


if __name__ == "__main__":
    unittest.main()
