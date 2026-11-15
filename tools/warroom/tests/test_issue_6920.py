"""Issue #6920: an oversized AI prompt must not be passed through argv (`[Errno 7] Argument list too long`)."""
from __future__ import annotations

import os
import stat
import tempfile
import time
import unittest
from pathlib import Path

from warroom.adapters import ClaudeCodeAdapter, CodexCLIAdapter, OpenCodeAdapter, RunSpec

BIG = "가" * 400_000   # ~1.2 MB UTF-8: above macOS ARG_MAX and Linux MAX_ARG_STRLEN


class OversizedPrompt(unittest.TestCase):
    def _run(self, adapter_cls, **kw):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            fake = d / "fakecli"
            fake.write_text('#!/bin/sh\nfor a in "$@"; do echo "ARG:${#a}"; done\nwc -c\n')
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            ad = adapter_cls(binary=str(fake), **kw)
            log, ex = d / "run.log", d / "run.exit"
            env = {"PATH": os.environ["PATH"]}
            run = RunSpec("m", "medium", permission_profile="p")
            ad.start(BIG, d, env, run, "t", log, ex) if adapter_cls is not CodexCLIAdapter else \
                ad.start(BIG, d, env, run, "t", log, ex, git_dir=str(d))
            for _ in range(100):
                if ex.exists():
                    break
                time.sleep(0.1)
            self.assertEqual(ex.read_text().strip(), "0")
            return log.read_text(), d

    def test_claude_sends_big_prompt_on_stdin(self):
        out, _ = self._run(ClaudeCodeAdapter)
        self.assertNotIn("ARG:400000", out)
        self.assertIn(str(len(BIG.encode())), out.splitlines()[-1])

    def test_codex_sends_big_prompt_on_stdin(self):
        out, _ = self._run(CodexCLIAdapter)
        self.assertNotIn("ARG:400000", out)
        self.assertIn("ARG:1", out)   # the "-" stdin marker
        self.assertIn(str(len(BIG.encode())), out.splitlines()[-1])

    def test_opencode_points_to_prompt_file(self):
        out, _ = self._run(OpenCodeAdapter, probe_async=False)
        self.assertTrue(all(int(l[4:]) < 4096 for l in out.splitlines() if l.startswith("ARG:")))


if __name__ == "__main__":
    unittest.main()
