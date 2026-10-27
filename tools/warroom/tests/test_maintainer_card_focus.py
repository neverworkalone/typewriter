"""The Board's Maintainer card (row 5, DeepSeek column) is selectable like every other Card.

Invariant: every card on the Board is reachable by Tab, arrow keys and mouse click, and Enter/click on the Maintainer
card only opens the shared Batch Detail (#2022). Textual-dependent: skipped when the War Room venv is not installed.
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

    def test_enter_and_click_open_the_batch_detail_without_changing_anything(self):
        async def scenario(app, pilot):
            card = app.query_one("#card-maintainer", tui.MaintainerCard)
            card.focus()
            await pilot.press("enter")
            await pilot.pause()
            self.assertIsInstance(app.screen, tui.LineDetail)
            self.assertEqual(app.screen.method, "m")
            await pilot.press("escape")
            await pilot.pause()
            self.assertIs(app.screen, app.screen_stack[0])
            await pilot.click("#card-maintainer")
            await pilot.pause()
            self.assertIsInstance(app.screen, tui.LineDetail)
            self.assertEqual(app.store.maintenance_rows(), [])   # opening starts/changes nothing
        self.run_app(scenario)


class MaintainerDetailTextTests(unittest.TestCase):
    """The detail shows every hold reason / error uncut; the Board summary keeps its 70-char limit."""
    LONG = "원인 " + "가나다라마바사 " * 30 + "끝-마커"

    def world(self):
        from warroom import control
        w = World()
        self.addCleanup(w.tmp.cleanup)
        st = w.store
        bid = st.create_batch(method="a", producer="deepseek", shard="001", batch="01", branch="b", worktree="w")
        did = st.report_defect(bid, "k", "report", "span", "REPORTED", "{}", "shared_defect", "paused")
        st.update_defect(did, state="HELD", issue_number=7, hold_reason=self.LONG)    # held dependency
        st.ensure_maintenance(7)
        mb = st.create_batch(method="b",producer="deepseek", shard="001", batch="02", branch="m", worktree="w2")
        st.update(mb, state="ERROR", error=self.LONG)                                  # failed Maintainer batch
        st.ensure_maintenance(8)
        st.update_maintenance(8, state="ACTIVE", batch_id=mb)
        return w, control

    def test_full_detail_vs_short_summary(self):
        w, control = self.world()
        marker = "끝-마커"
        for full, expect_marker in ((True, True), (False, False)):
            texts = [t for t, _ in control.urgent_items(w.store, w.cfg, full=full)]
            self.assertEqual(len(texts), 2)
            for t in texts:
                self.assertEqual(marker in t, expect_marker, t)
                self.assertEqual(" ".join(self.LONG.split()) in t, expect_marker)
                if not full:
                    self.assertLessEqual(len(t), 130)
        self.assertEqual(control.urgent_items(w.store, w.cfg), control.urgent_items(w.store, w.cfg, full=False))


if __name__ == "__main__":
    unittest.main()
