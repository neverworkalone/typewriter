"""Issue #1720: the Board's browser script must keep refreshing while a top-bar <select> has focus (jsdom, real app.js)."""
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


class WebBoardJs(unittest.TestCase):
    def test_board_refreshes_under_select_focus(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "node is required for the Web UI script regression")
        r = subprocess.run([node, str(Path(__file__).with_name("web_board.mjs"))], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
