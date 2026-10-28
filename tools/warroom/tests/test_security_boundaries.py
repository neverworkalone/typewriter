"""Regression checks for local Web Server and Stage 2 worker security boundaries."""
from __future__ import annotations

import http.client
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from warroom.adapters import ProcessAdapter, stage2_chunk_sandbox_command, stage2_git_executables
from warroom.config import Paths, load_config
from warroom.store import Store
from warroom.web import api
from warroom.web.server import WebServer, check_loopback


CONFIG = {"producers": {
    "claude": {"adapter": "claude", "label": "Claude", "model": "m", "effort": "high"},
    "deepseek": {"adapter": "opencode", "label": "DeepSeek", "models": {"free": "x-free", "go": "x"}},
}}


class LocalWebSecurity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.paths = Paths(repo_root=Path(cls.tmp.name), local=Path(cls.tmp.name) / ".local")
        cls.paths.ensure()
        cls.paths.config_file.write_text(json.dumps(CONFIG), "utf-8")
        cls.cfg = load_config(cls.paths)
        cls.store = Store(cls.paths.db)
        cls.store.set("heartbeat", str(time.time()))
        cls.server = WebServer("127.0.0.1", 0, cls.paths, ["warroom.example.ts.net"])
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.port

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def request(self, method, path, body=None, **headers):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        request_headers = {"Host": f"localhost:{self.port}", **headers}
        request_headers = {
            key.replace("_", "-"): value
            for key, value in request_headers.items()
            if value is not None
        }
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        result = response.status, dict(response.getheaders()), response.read()
        connection.close()
        return result

    def post_command(self, body, **headers):
        raw = json.dumps(body)
        base = {
            "Origin": f"http://localhost:{self.port}",
            "Content-Type": "application/json",
            "Content-Length": str(len(raw)),
        }
        return self.request("POST", "/api/command", raw, **{**base, **headers})

    def test_server_binding_accepts_loopback_and_refuses_other_interfaces(self):
        allowed = ("127.0.0.1", "localhost", "::1", "127.0.0.2")
        refused = ("0.0.0.0", "::", "", "192.168.0.4", "100.64.0.1", "example.com", "8.8.8.8")
        for host in allowed:
            with self.subTest(host=host):
                check_loopback(host)
        for host in refused:
            with self.subTest(host=host), self.assertRaises(ValueError):
                check_loopback(host)
        self.assertEqual(self.server.server_address[0], "127.0.0.1")

    def test_host_header_blocks_untrusted_hosts_on_static_and_api_routes(self):
        bad_hosts = (
            "evil.example", f"evil.example:{self.port}", "localhost:1", "127.0.0.1",
            f"169.254.1.1:{self.port}",
        )
        for host in bad_hosts:
            with self.subTest(host=host):
                self.assertEqual(self.request("GET", "/api/board", Host=host)[0], 403)
                self.assertEqual(self.request("GET", "/", Host=host)[0], 403)
        self.assertEqual(self.request("GET", "/api/board", Host=f"127.0.0.1:{self.port}")[0], 200)
        self.assertEqual(self.request("GET", "/api/board", Host="warroom.example.ts.net")[0], 200)

    def test_command_route_enforces_origin_fetch_content_type_and_body_limits(self):
        self.assertEqual(self.post_command({"cmd": "invalid"})[0], 400)
        rejected = (
            ("missing origin", {"Origin": None}, 403),
            ("foreign origin", {"Origin": "https://evil.example"}, 403),
            ("wrong port", {"Origin": "http://localhost:1"}, 403),
            ("null origin", {"Origin": "null"}, 403),
            ("origin path", {"Origin": f"http://localhost:{self.port}/outside"}, 403),
            ("cross-site fetch", {"Sec-Fetch-Site": "cross-site"}, 403),
            ("same-site fetch", {"Sec-Fetch-Site": "same-site"}, 403),
            ("plain text", {"Content-Type": "text/plain"}, 415),
            ("form data", {"Content-Type": "application/x-www-form-urlencoded"}, 415),
            ("foreign host", {"Host": "evil.example"}, 403),
        )
        for name, headers, status in rejected:
            with self.subTest(case=name):
                self.assertEqual(self.post_command({"cmd": "drain_all"}, **headers)[0], status)
        self.assertEqual(self.post_command({"cmd": "invalid"}, Origin="https://warroom.example.ts.net",
                                           Host="warroom.example.ts.net")[0], 400)
        self.assertEqual(self.request(
            "POST", "/api/command", "not json", Origin=f"http://localhost:{self.port}",
            Content_Type="application/json", Content_Length="8",
        )[0], 400)
        self.assertEqual(self.request(
            "POST", "/api/command", "x" * 5000, Origin=f"http://localhost:{self.port}",
            Content_Type="application/json", Content_Length="5000",
        )[0], 413)

    def test_paths_cannot_escape_the_fixed_server_routes(self):
        paths = (
            "/../store.py", "/%2e%2e/store.py", "/app.js/../../config.py", "/api/line/claude/a/../../..",
        )
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(self.request("GET", path)[0], 404)

    def test_server_responses_keep_security_headers(self):
        for path in ("/", "/api/board"):
            with self.subTest(path=path):
                status, headers, _ = self.request("GET", path)
                self.assertEqual(status, 200)
                self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(headers["X-Frame-Options"], "DENY")
                self.assertEqual(headers["Referrer-Policy"], "no-referrer")

    def test_recorded_logs_outside_the_log_directory_are_never_read(self):
        outside = Path(self.tmp.name) / "secret.txt"
        outside.write_text("private marker", "utf-8")
        self.store.line("claude", "a")
        batch_id = self.store.create_batch(method="a", producer="claude", shard="001", batch="01",
                                           branch="test", worktree=str(Path(self.tmp.name) / "worktree"))
        self.store.add_run(batch_id, "produce", None, 1, outside, outside.with_suffix(".exit"))
        result = api.read_log(self.store, self.cfg, self.paths, "claude", "a")
        self.assertTrue(result["missing"])
        self.assertNotIn("private marker", json.dumps(result))


class Stage2GitSandbox(unittest.TestCase):
    def git_alias(self, root):
        target = Path(root) / "git-real"
        alias = Path(root) / "git"
        target.write_text("fixture", "utf-8")
        alias.symlink_to(target)
        return str(alias), str(target)

    def test_linux_policy_masks_each_git_executable_and_keeps_worker_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            alias, _target = self.git_alias(tmp)
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
            alias, _target = self.git_alias(tmp)
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
