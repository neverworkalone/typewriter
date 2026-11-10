"""A finished restart request must never keep the Supervisor from starting (regression of the 2026-11-09 outage).

A `loaded` request whose merge SHA is no longer in the operating HEAD (checkout moved to another branch) made
handle_pending_restart() return ("starting", None) forever, so ensure_supervisor() never reached its tmux launch.
"""
from __future__ import annotations

import json
import unittest
from unittest import mock

from tests.fakes import HEAD1
from tests.test_issue_1555 import world
from warroom.restart_controller import (TERMINAL_REQUEST_STATES, handle_pending_restart, request_path,
                                        write_restart_request)


def _set_state(path, state):
    data = json.loads(path.read_text())
    data["state"] = state
    path.write_text(json.dumps(data))


class TerminalRequestsDoNotBlock(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.addCleanup(self.w.tmp.cleanup)
        self.head = mock.Mock(returncode=0, stdout=HEAD1)

    def _patches(self, *, ancestor, lock_held=False):
        return (mock.patch("warroom.restart_controller._git", return_value=self.head),
                mock.patch("warroom.restart_controller._ancestor", return_value=ancestor),
                mock.patch("warroom.restart_controller._lock_held", return_value=lock_held))

    def test_loaded_request_outside_head_is_ignored(self):
        path = write_restart_request(self.w.paths, {"id": 0, "merge_sha": HEAD1}, None)
        for state in TERMINAL_REQUEST_STATES:
            _set_state(path, state)
            git, ancestor, lock = self._patches(ancestor=False)
            with git, ancestor, lock:
                self.assertIsNone(handle_pending_restart(self.w.paths, self.w.store), state)
            self.assertNotEqual(json.loads(path.read_text()).get("state"), "waiting", state)

    def test_autostart_path_stays_open_when_every_request_is_finished(self):
        # ensure_supervisor() proceeds to its tmux launch exactly when this returns None (lock free); a live
        # Supervisor still reports "locked". Mix a stale `loaded` request (SHA not in HEAD) with finished ones.
        loaded = write_restart_request(self.w.paths, {"id": 0, "merge_sha": HEAD1}, None)
        done = write_restart_request(self.w.paths, {"id": 7, "merge_sha": HEAD1}, None)
        _set_state(loaded, "loaded")
        _set_state(done, "progress_verified")
        git, ancestor, lock = self._patches(ancestor=False, lock_held=False)
        with git, ancestor, lock:
            self.assertIsNone(handle_pending_restart(self.w.paths, self.w.store))
        git, ancestor, lock = self._patches(ancestor=False, lock_held=True)
        with git, ancestor, lock:
            self.assertEqual(handle_pending_restart(self.w.paths, self.w.store), ("locked", None))

    def test_unfinished_request_outside_head_never_keeps_a_stopped_supervisor_down(self):
        """#5162: a code update that cannot be applied is set aside with its reason; the line is started on the current code."""
        path = write_restart_request(self.w.paths, {"id": 91, "merge_sha": HEAD1}, None)
        self.assertEqual(request_path(self.w.paths, 91), path)
        started = []

        def tmux(args, **kw):
            if args[0] == "new-session":
                started.append(args)
            return mock.Mock(returncode=0 if args[0] == "new-session" else 1, stdout="")
        git, ancestor, lock = self._patches(ancestor=False)
        with git, ancestor, lock, \
             mock.patch("warroom.restart_controller._update_target", return_value=(None, "origin/master에 없습니다")), \
             mock.patch("warroom.restart_controller._tmux", side_effect=tmux), \
             mock.patch("warroom.restart_controller.STARTUP_TIMEOUT", 0.01), \
             mock.patch("warroom.restart_controller.time.sleep"):
            self.assertEqual(handle_pending_restart(self.w.paths, self.w.store), ("starting", None))
        data = json.loads(path.read_text())
        self.assertEqual((data["state"], len(started)), ("waiting", 1))
        self.assertIn("현재 코드로 계속 운영", data["blocker"])


if __name__ == "__main__":
    unittest.main()
