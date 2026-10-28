"""The Line detail shows batch data as text: a PAUSED reason with Rich-markup-like brackets (a denied heredoc command)
once raised MarkupError and ended the War Room. Textual-dependent: skipped when the War Room venv is not installed."""
import asyncio
import unittest
from unittest import mock

from tests.fakes import World

try:
    from warroom import tui
except ModuleNotFoundError:
    tui = None


@unittest.skipIf(tui is None, "textual not installed")
class LineDetailMarkup(unittest.TestCase):
    def test_detail_opens_for_error_text_with_brackets(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.cfg["producers"] = {"claude": {"adapter": "claude", "model": "m", "effort": "high"}}
        w.start("single", "claude", "a")
        w.tick()
        bid = w.row("claude", "a")["id"]
        reasons = ['거부됨 (명령: cat <<EOF d=[("s1",["가스 | python3)', "[/x] [bold", "[red]x", "]["]
        for p in (mock.patch.object(tui, "Paths", return_value=w.paths), mock.patch.object(tui, "load_config", return_value=w.cfg),
                  mock.patch.object(tui, "ensure_supervisor", return_value=("starting", None)),
                  mock.patch.object(tui.WarRoom, "check_auth", lambda self: None)):
            p.start()
            self.addCleanup(p.stop)

        async def go():
            app = tui.WarRoom()
            async with app.run_test(size=(200, 60)) as pilot:
                for reason in reasons:
                    app.store.update(bid, state="PAUSED", error=reason)
                    app.push_screen(tui.LineDetail("claude", "a"))
                    await pilot.pause()
                    self.assertIsInstance(app.screen, tui.LineDetail)
                    app.screen.refresh_view()
                    app.pop_screen()
                    await pilot.pause()
        asyncio.run(go())


if __name__ == "__main__":
    unittest.main()
