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


class ClearRemovesPromptFiles(unittest.TestCase):
    def test_clear_removes_prompt_files_of_every_adapter(self):
        from types import SimpleNamespace
        from warroom.supervisor import Supervisor
        for cls, kw in ((ClaudeCodeAdapter, {}), (CodexCLIAdapter, {}), (OpenCodeAdapter, {"probe_async": False})):
            with self.subTest(adapter=cls.__name__), tempfile.TemporaryDirectory() as d:
                d = Path(d).resolve()
                fake = d / "fakecli"
                fake.write_text("#!/bin/sh\ncat >/dev/null\n")
                fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
                log, ex = d / "batch-7-1.log", d / "batch-7-1.exit"
                ad = cls(binary=str(fake), **kw)
                run = RunSpec("m", "medium", permission_profile="p")
                extra = {"git_dir": str(d)} if cls is CodexCLIAdapter else {}
                ad.start(BIG, d, {"PATH": os.environ["PATH"]}, run, "t", log, ex, **extra)
                prompt = d / "batch-7-1.log.prompt"
                self.assertTrue(prompt.exists())
                sup = SimpleNamespace(paths=SimpleNamespace(logs=d),
                                      store=SimpleNamespace(runs=lambda _id: [{"log_file": str(log), "exit_file": str(ex)}]))
                Supervisor._remove_run_files(sup, {"id": 7, "log_file": None, "exit_file": None})
                self.assertFalse(prompt.exists())
                self.assertFalse(log.exists())


class FailedSpawnLeavesNoEvidence(unittest.TestCase):
    """The #6920 recurrence: a failed Popen left an empty log, so recovery refused to re-run a launch that never ran."""

    def test_failed_spawn_removes_log_and_prompt(self):
        from unittest import mock
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            log, ex = d / "run.log", d / "run.exit"
            ad = ClaudeCodeAdapter(binary="/bin/true")
            with mock.patch("subprocess.Popen", side_effect=OSError(7, "Argument list too long")):
                with self.assertRaises(OSError):
                    ad._spawn(["x"], d, {"PATH": os.environ["PATH"]}, log, ex, stdin_text="p")
            self.assertEqual(sorted(p.name for p in d.iterdir()), [])

    def _sup(self, events=(), runs=()):
        from types import SimpleNamespace
        from warroom.supervisor import Supervisor
        sup = SimpleNamespace(START_FAILURE_PREFIX=Supervisor.START_FAILURE_PREFIX,
                              store=SimpleNamespace(runs=lambda _i: list(runs), batch_events=lambda _i: list(events)))
        return lambda spawn, attempt=None, current=None: Supervisor._spawn_never_started(
            sup, {"id": 1}, spawn, attempt or {"prior_run_id": 0}, current or {})

    def test_unregistered_start_window_is_not_never_started(self):
        """Reviewer race: child spawned, Supervisor died before the pid/run row; no files yet => must stay fail-closed."""
        with tempfile.TemporaryDirectory() as d:
            spawn = {"log_file": str(Path(d) / "a.log"), "exit_file": str(Path(d) / "a.exit")}
            check = self._sup()
            self.assertFalse(check(spawn))                       # nothing on disk, no failure proof
            Path(spawn["log_file"]).write_bytes(b"")
            self.assertFalse(check(spawn))                       # empty log alone is not proof

    def test_durable_failure_proof(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            spawn = {"log_file": str(d / "a.log"), "exit_file": str(d / "a.exit"), "start_failed": True}
            check = self._sup()
            (d / "a.log").write_bytes(b"")
            self.assertTrue(check(spawn))
            (d / "a.log").write_text("output")
            self.assertFalse(check(spawn))                       # worker wrote output
            (d / "a.log").write_bytes(b"")
            Path(str(d / "a.exit") + ".pid").write_text("1")
            self.assertFalse(check(spawn))                       # wrapper started
            Path(str(d / "a.exit") + ".pid").unlink()
            (d / "a.exit").write_text("0")
            self.assertFalse(check(spawn))
            self.assertFalse(check({}))

    def test_legacy_proof_is_the_unconsumed_start_failure_event(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            spawn = {"log_file": str(d / "a.log"), "exit_file": str(d / "a.exit")}
            (d / "a.log").write_bytes(b"")
            ev = [{"id": 5, "ts": 10.0, "msg": "AI 실행 시작 실패: [Errno 7] Argument list too long"}]
            self.assertTrue(self._sup(ev)(spawn))
            self.assertFalse(self._sup(ev)(spawn, current={"start_failure_consumed_event": 5}))
            self.assertFalse(self._sup([{"id": 6, "ts": 1.0, "msg": ev[0]["msg"]}],
                                       [{"id": 3, "started_at": 9.0}])(spawn, {"prior_run_id": 3}))


if __name__ == "__main__":
    unittest.main()
