"""TUI recovery of a missing Supervisor, without replacing a live lock/session."""
import asyncio
import re
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from tests.fakes import World
from warroom.config import Paths
from warroom.supervisor import acquire_lock

try:
    from warroom import tui
except ModuleNotFoundError:
    tui = None


def completed(args, code=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(args, code, stdout, stderr)


@unittest.skipIf(tui is None, "textual not installed")
class EnsureSupervisorTests(unittest.TestCase):
    def paths(self, root):
        paths = Paths(repo_root=root, local=root / ".local")
        paths.ensure()
        return paths

    def test_supervisor_lock_means_no_tmux_replacement(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = self.paths(Path(tmp))
            lock = acquire_lock(paths.lock)
            self.assertIsNotNone(lock)
            try:
                with mock.patch.object(tui.subprocess, "run") as run:
                    self.assertEqual(tui.ensure_supervisor(paths), ("locked", None))
                run.assert_not_called()
            finally:
                lock.close()

    def test_live_tmux_pane_is_preserved_until_heartbeat_arrives(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = self.paths(Path(tmp))

            def run(args, **kwargs):
                if args[0] == "which":
                    return completed(args)
                if args[1] == "has-session":
                    return completed(args)
                if args[1] == "display-message":
                    return completed(args, stdout="0\n")
                self.fail(f"unexpected command: {args}")

            with mock.patch.object(tui.subprocess, "run", side_effect=run) as mocked:
                self.assertEqual(tui.ensure_supervisor(paths), ("starting", None))
            self.assertFalse(any(call.args[0][1] == "kill-session" for call in mocked.call_args_list))
            self.assertFalse(any(call.args[0][1] == "new-session" for call in mocked.call_args_list))

    def test_dead_tmux_pane_reports_output_and_is_removed_for_cooldown_retry(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = self.paths(Path(tmp))
            session = {"exists": True}
            commands = []

            def run(args, **kwargs):
                commands.append(args)
                if args[0] == "which":
                    return completed(args)
                if args[1] == "has-session":
                    return completed(args, 0 if session["exists"] else 1)
                if args[1] == "display-message":
                    return completed(args, stdout="1\n")
                if args[1] == "capture-pane":
                    return completed(args, stdout="config.json 오류: invalid pin\n")
                if args[1] == "kill-session":
                    session["exists"] = False
                    return completed(args)
                self.fail(f"unexpected command: {args}")

            with mock.patch.object(tui.subprocess, "run", side_effect=run):
                state, error = tui.ensure_supervisor(paths)
            self.assertEqual(state, "failed")
            self.assertIn("invalid pin", error)
            self.assertFalse(session["exists"])
            self.assertFalse(any(args[1] == "new-session" for args in commands))

    def test_concurrent_tuis_only_create_one_supervisor_session(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = self.paths(Path(tmp))
            creating = threading.Event()
            finish_create = threading.Event()
            commands = []
            result = []
            errors = []

            def run(args, **kwargs):
                commands.append(args)
                if args[0] == "which":
                    return completed(args)
                if args[1] == "has-session":
                    return completed(args, 1)
                if args[1] == "new-session":
                    creating.set()
                    if not finish_create.wait(2):
                        raise TimeoutError("test did not release new-session")
                    # The launcher lock serializes TUI calls; the process lock itself is free for the child.
                    child_lock = acquire_lock(paths.lock)
                    if child_lock is not None:
                        child_lock.close()
                    else:
                        errors.append("launcher held the Supervisor lock during startup")
                    return completed(args)
                self.fail(f"unexpected command: {args}")

            def first_tui():
                try:
                    result.append(tui.ensure_supervisor(paths))
                except Exception as exc:
                    errors.append(str(exc))

            with mock.patch.object(tui.subprocess, "run", side_effect=run):
                worker = threading.Thread(target=first_tui)
                worker.start()
                self.assertTrue(creating.wait(2), "first TUI did not reach tmux startup")
                second = tui.ensure_supervisor(paths)
                finish_create.set()
                worker.join(2)

            self.assertFalse(worker.is_alive())
            self.assertEqual(errors, [])
            self.assertEqual(result, [("starting", None)])
            self.assertEqual(second, ("starting", None))
            self.assertEqual(sum(args[1] == "new-session" for args in commands), 1)


@unittest.skipIf(tui is None, "textual not installed")
class SupervisorRecoveryBannerTests(unittest.TestCase):
    def make_app(self):
        world = World()
        self.addCleanup(world.tmp.cleanup)
        world.cfg["producers"] = {"claude": {"adapter": "claude", "model": "m", "effort": "high"}}
        patches = [
            mock.patch.object(tui, "Paths", return_value=world.paths),
            mock.patch.object(tui, "load_config", return_value=world.cfg),
            mock.patch.object(tui, "ensure_supervisor", return_value=("starting", None)),
            mock.patch.object(tui.WarRoom, "check_auth", lambda self: None),
        ]
        for patcher in patches:
            patcher.start()
            self.addCleanup(patcher.stop)
        return tui.WarRoom()

    def test_waits_for_startup_grace_then_retries_once_per_cooldown(self):
        app = self.make_app()

        async def go():
            async with app.run_test(size=(180, 60)) as pilot:
                await pilot.pause()
                now = time.monotonic()
                app._t0 = now - (tui.SUPERVISOR_STARTUP_GRACE_SECONDS - 1)
                app._supervisor_retry_at = 0
                with (mock.patch.object(tui.control, "supervisor_alive", return_value=False),
                      mock.patch.object(tui, "ensure_supervisor", return_value=("locked", None)) as ensure):
                    app.refresh_view()
                    self.assertEqual(ensure.call_count, 0)
                    app._t0 = time.monotonic() - tui.SUPERVISOR_STARTUP_GRACE_SECONDS - 1
                    app.refresh_view()
                    await pilot.pause()
                    self.assertEqual(ensure.call_count, 1)
                    self.assertEqual(app._supervisor_state, "locked")
                    self.assertIn("lock이 점유", str(app.query_one("#banner", tui.Static).content))
                    app.refresh_view()
                    await pilot.pause()
                    self.assertEqual(ensure.call_count, 1)

        asyncio.run(go())

    def test_launcher_failure_is_visible_and_retry_uses_cooldown(self):
        app = self.make_app()

        async def go():
            async with app.run_test(size=(180, 60)) as pilot:
                await pilot.pause()
                with mock.patch.object(tui.control, "supervisor_alive", return_value=False):
                    before = time.monotonic()
                    app._t0 = before - 1
                    app._finish_supervisor_recovery("failed", "config.json 오류: invalid pin")
                    self.assertGreaterEqual(app._supervisor_retry_at - before, 4)
                    self.assertLessEqual(app._supervisor_retry_at - before, 6)
                    banner = str(app.query_one("#banner", tui.Static).content)
                    self.assertIn("invalid pin", banner)
                    countdown = re.search(r"\((\d+)초 후 재시도\)", banner)
                    self.assertIsNotNone(countdown)
                    self.assertLessEqual(int(countdown.group(1)), 6)

        asyncio.run(go())


if __name__ == "__main__":
    unittest.main()
