"""Issue #6920: an oversized AI prompt must not be passed through argv (`[Errno 7] Argument list too long`)."""
from __future__ import annotations

import os
import stat
import tempfile
import time
import unittest
from pathlib import Path

from warroom.adapters import SpawnNotStarted, ClaudeCodeAdapter, CodexCLIAdapter, OpenCodeAdapter, RunSpec

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
                with self.assertRaises(SpawnNotStarted):
                    ad._spawn(["x"], d, {"PATH": os.environ["PATH"]}, log, ex, stdin_text="p")
            self.assertEqual(sorted(p.name for p in d.iterdir()), [])

    def test_ambiguous_popen_failure_keeps_evidence(self):
        """Reviewer: an exception that can follow fork (MemoryError, non-exec OSError) must not be read as 'no child'."""
        from unittest import mock
        for exc in (MemoryError(), OSError(5, "I/O error")):
            with self.subTest(exc=repr(exc)), tempfile.TemporaryDirectory() as d:
                d = Path(d)
                log, ex = d / "run.log", d / "run.exit"
                ad = ClaudeCodeAdapter(binary="/bin/true")
                with mock.patch("subprocess.Popen", side_effect=exc):
                    with self.assertRaises(type(exc)) as ctx:
                        ad._spawn(["x"], d, {"PATH": os.environ["PATH"]}, log, ex, stdin_text="p")
                self.assertNotIsInstance(ctx.exception, SpawnNotStarted)
                self.assertTrue(log.exists())
                self.assertTrue((d / "run.log.prompt").exists())

    def test_legacy_event_must_be_a_refused_spawn(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            spawn = {"log_file": str(d / "batch-1-105.log"), "exit_file": str(d / "batch-1-105.exit")}
            (d / "batch-1-105.log").write_bytes(b"")
            for msg in ("AI 실행 시작 실패: ", "AI 실행 시작 실패: [Errno 5] I/O error"):
                self.assertFalse(self._sup([{"id": 5, "ts": 106.0, "msg": msg}])(spawn), msg)

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

    def test_legacy_proof_is_attributed_to_this_reservations_launch(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            spawn = {"log_file": str(d / "batch-1-105.log"), "exit_file": str(d / "batch-1-105.exit")}
            (d / "batch-1-105.log").write_bytes(b"")
            msg = "AI 실행 시작 실패: [Errno 7] Argument list too long"
            mine = [{"id": 5, "ts": 105.2, "msg": msg}]
            self.assertTrue(self._sup(mine)(spawn))
            self.assertFalse(self._sup(mine)(spawn, current={"start_failure_consumed_event": 5}))
            # earlier launch A failed at t=100; reservation B (same prior_run_id) spawned at 105, then the
            # Supervisor restarted before the wrapper wrote its pid: A's event must not vouch for B
            older = [{"id": 4, "ts": 100.3, "msg": msg}]
            self.assertFalse(self._sup(older)(spawn, {"prior_run_id": 3}))
            self.assertFalse(self._sup(older + [{"id": 6, "ts": 106.0, "msg": "other"}])(spawn))
            # unparseable launch time stays fail-closed
            odd = {"log_file": str(d / "x.log"), "exit_file": str(d / "x.exit")}
            self.assertFalse(self._sup(mine)(odd))


if __name__ == "__main__":
    unittest.main()


class OversizedRepairPageRelaunch(unittest.TestCase):
    """Recurrence e3: turn/start rejected a recorded 8-group page (input_too_large); the retry must relaunch a budgeted page."""

    REJECT = ('{"type":"thread.started","thread_id":"t"}\nError: turn/start: turn/start failed: Input exceeds the maximum '
              'length of 1048576 characters. (code -32602), data: {"input_error_code":"input_too_large","max_chars":1048576}\n')

    def _check(self, log_text, keys_of_page=8, n_groups=16):
        from types import SimpleNamespace
        from warroom.supervisor import Supervisor
        groups = [{"candidate_keys": [f"k{i:02d}"], "blob": "가" * 160_000} for i in range(n_groups)]
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "run.log"
            log.write_text(log_text, encoding="utf-8")
            current = {"groups": groups, "cursor": 0}
            attempt = {"target_keys": sorted(f"k{i:02d}" for i in range(keys_of_page))}
            return Supervisor._stage2_repair_input_rejected(
                SimpleNamespace(), {"log_file": str(log)}, attempt, current)

    def test_rejected_oversized_recorded_page_is_dropped_for_relaunch(self):
        self.assertTrue(self._check(self.REJECT))

    def test_other_failures_and_worked_runs_are_not_dropped(self):
        self.assertFalse(self._check("Error: some other failure\n"))
        self.assertFalse(self._check(self.REJECT + '{"type":"item.completed"}\n'))

    def test_already_budgeted_page_is_not_looped(self):
        self.assertFalse(self._check(self.REJECT, keys_of_page=3))


class CorrectionInputRejectedTransition(unittest.TestCase):
    """Review 5911292931: an oversized *correction* attempt must not be re-reserved with its rejected boundary."""

    def test_correction_attempt_rejected_for_size_relaunches_smaller_page(self):
        from types import SimpleNamespace
        from warroom.supervisor import Supervisor
        n = 16
        groups = [{"candidate_keys": [f"k{i:02d}"], "blob": "가" * 160_000} for i in range(n)]
        old_keys = sorted(f"k{i:02d}" for i in range(8))
        with tempfile.TemporaryDirectory() as d:
            log, ex = Path(d) / "run.log", Path(d) / "run.exit"
            log.write_text(OversizedRepairPageRelaunch.REJECT, encoding="utf-8")
            ex.write_text("1")
            rejected = {"cursor": 0, "attempt": 1, "status": "rejected", "target_keys": old_keys, "fingerprint": "f"}
            launched = {"cursor": 0, "attempt": 2, "status": "launched", "target_keys": old_keys, "fingerprint": "f",
                        "prior_run_id": 1, "run_id": 2, "correction_candidate_keys": ["k00"],
                        "spawn": {"log_file": str(log), "exit_file": str(ex)}}
            current = {"groups": groups, "cursor": 0, "fingerprint": "f", "attempts": 2,
                       "attempt_log": [rejected, launched], "last_response": "r",
                       "response_correction": {"page_keys": old_keys, "requested_keys": ["k00"]}}
            run = {"id": 2, "kind": "s2_repair_new", "log_file": str(log), "exit_file": str(ex), "pid": None,
                   "ended_at": 1, "exit_status": "1"}
            b = {"id": 1, "pid": None, "log_file": str(log), "exit_file": str(ex)}
            saved = []
            sup = SimpleNamespace(
                _adapter=lambda _p: SimpleNamespace(alive=lambda _pid: False),
                store=SimpleNamespace(runs=lambda _id: [run], log=lambda *a: None),
                _save_stage2_repair_state=lambda *_a: saved.append(True),
                _fail=lambda *a: self.fail("must not fail"),
                _stage2_repair_correction=Supervisor._stage2_repair_correction,
                _stage2_repair_noncandidate_attempts=lambda c: 0)
            sup._stage2_repair_input_rejected = lambda *a: Supervisor._stage2_repair_input_rejected(sup, *a)
            sup._stage2_repair_launch_page = lambda c: Supervisor._stage2_repair_launch_page(sup, c)
            b["producer"] = "codex"
            self.assertIs(Supervisor._stage2_repair_recover_launched(sup, b, {}, current), False)
            self.assertTrue(saved)
            self.assertEqual([a["status"] for a in current["attempt_log"]], ["rejected"])
            self.assertNotIn("response_correction", current)
            page = sup._stage2_repair_launch_page(current)
            self.assertLess(len(page), 8)
            self.assertEqual(len(page), 3)
