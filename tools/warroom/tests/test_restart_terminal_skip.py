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
from warroom import tui
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

    def test_supervisor_autostart_proceeds_when_every_request_is_finished(self):
        path = write_restart_request(self.w.paths, {"id": 0, "merge_sha": HEAD1}, None)
        _set_state(path, "loaded")
        calls = []

        def run(command, **kwargs):
            calls.append(command)
            # `which tmux` ok, no existing Supervisor session, new-session ok
            return mock.Mock(returncode=1 if command[:2] == ["tmux", "has-session"] else 0, stdout="", stderr="")

        git, ancestor, lock = self._patches(ancestor=False)
        with git, ancestor, lock, mock.patch("warroom.tui.subprocess.run", side_effect=run):
            self.assertEqual(tui.ensure_supervisor(self.w.paths), ("starting", None))
        self.assertTrue(any(c[:2] == ["tmux", "new-session"] for c in calls), calls)

    def test_unfinished_request_outside_head_still_blocks_restart(self):
        path = write_restart_request(self.w.paths, {"id": 91, "merge_sha": HEAD1}, None)
        self.assertEqual(request_path(self.w.paths, 91), path)
        git, ancestor, lock = self._patches(ancestor=False)
        with git, ancestor, lock:
            self.assertEqual(handle_pending_restart(self.w.paths, self.w.store), ("starting", None))
        data = json.loads(path.read_text())
        self.assertEqual(data["state"], "waiting")
        self.assertIn("does not contain the requested merge", data["blocker"])


if __name__ == "__main__":
    unittest.main()
