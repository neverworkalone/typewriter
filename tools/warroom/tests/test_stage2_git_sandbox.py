"""Deterministic checks for Stage 2 worker Git isolation policy wiring."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from warroom.adapters import ProcessAdapter, stage2_chunk_sandbox_command, stage2_git_executables


class Stage2GitSandbox(unittest.TestCase):
    def git_alias(self, root):
        target = Path(root) / "git-real"
        alias = Path(root) / "git"
        target.write_text("fixture", "utf-8")
        alias.symlink_to(target)
        return str(alias)

    def test_linux_policy_masks_each_git_executable_and_keeps_worker_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            alias = self.git_alias(tmp)
            with patch("warroom.adapters.sys.platform", "linux"), \
                    patch("warroom.adapters.shutil.which", return_value="/usr/bin/bwrap"):
                command = stage2_chunk_sandbox_command(["python", "worker.py"], [alias], "/safe/bin")
            self.assertEqual(command[:6], [
                "/usr/bin/bwrap", "--die-with-parent", "--new-session", "--bind", "/", "/",
            ])
            for path in stage2_git_executables({"WARROOM_GIT_EXECUTABLES": json.dumps([alias])}):
                self.assertIn(["--ro-bind", "/dev/null", path], [command[i:i + 3] for i in range(len(command) - 2)])
            self.assertEqual(command[command.index("--") + 1:], ["python", "worker.py"])

    def test_macos_policy_denies_each_git_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            alias = self.git_alias(tmp)
            with patch("warroom.adapters.sys.platform", "darwin"), \
                    patch("warroom.adapters.shutil.which", return_value="/usr/bin/sandbox-exec"):
                command = stage2_chunk_sandbox_command(["python", "worker.py"], [alias], "/safe/bin")
            self.assertEqual(command[:2], ["/usr/bin/sandbox-exec", "-p"])
            for path in stage2_git_executables({"WARROOM_GIT_EXECUTABLES": json.dumps([alias])}):
                self.assertIn(f"(deny process-exec (literal {json.dumps(path)}))", command[2])
            self.assertEqual(command[3:], ["python", "worker.py"])

    def test_process_adapter_applies_policy_and_does_not_forward_git_paths(self):
        git_path = "/opt/typewriter/bin/git"
        env = {"PATH": "/safe/bin", "WARROOM_STAGE2_CHUNK": "1",
               "WARROOM_GIT_EXECUTABLES": json.dumps([git_path])}
        with tempfile.TemporaryDirectory() as tmp, \
                patch("warroom.adapters.sys.platform", "linux"), \
                patch("warroom.adapters.shutil.which", return_value="/usr/bin/bwrap"), \
                patch("warroom.adapters.subprocess.Popen") as popen:
            popen.return_value.pid = 42
            ProcessAdapter()._spawn(["python", "worker.py"], tmp, env,
                                    Path(tmp) / "worker.log", Path(tmp) / "worker.exit")
        spawned = popen.call_args.args[0]
        worker_env = popen.call_args.kwargs["env"]
        command = spawned[spawned.index("/usr/bin/bwrap"):]
        self.assertIn(["--ro-bind", "/dev/null", git_path],
                      [command[i:i + 3] for i in range(len(command) - 2)])
        self.assertEqual(command[command.index("--") + 1:], ["python", "worker.py"])
        self.assertNotIn("WARROOM_GIT_EXECUTABLES", worker_env)
        self.assertEqual(worker_env["WARROOM_STAGE2_CHUNK"], "1")


if __name__ == "__main__":
    unittest.main()
