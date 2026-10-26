"""Issue #1720: the Web UI is a second View over the shared Store/control, bound to loopback and fail-closed.

Invariant: the Web layer only (1) reads through `control`/`views`, (2) changes state through the allowed `control`
commands after server-side validation, OFFLINE gating and Stop/Clear confirmation, (3) serves only DB-recorded
logs from the log directory with secrets redacted, and (4) is reachable only via a loopback bind with Host/Origin checks.
"""
import http.client
import json
import tempfile
import threading
import time
import unittest
from pathlib import Path

from warroom import control
from warroom.config import Paths
from warroom.logtail import INITIAL_BYTES
from warroom.store import Store
from warroom.web import api
from warroom.web.server import WebServer, check_loopback

CONFIG = {"producers": {
    "claude": {"adapter": "claude", "label": "Claude", "model": "m", "effort": "high"},
    "deepseek": {"adapter": "opencode", "label": "DeepSeek", "models": {"free": "x-free", "go": "x"}}}}
TOKEN = "ghp_" + "A" * 30


class Env:
    def __init__(self, alive=True):
        self.tmp = tempfile.TemporaryDirectory()
        self.paths = Paths(repo_root=Path(self.tmp.name), local=Path(self.tmp.name) / ".local")
        self.paths.ensure()
        self.paths.config_file.write_text(json.dumps(CONFIG))
        self.store = Store(self.paths.db)
        self.cfg = json.loads(json.dumps({**__import__("warroom.config", fromlist=["DEFAULTS"]).DEFAULTS, **CONFIG}))
        self.heartbeat(alive)

    def heartbeat(self, alive=True):
        self.store.set("heartbeat", str(time.time() if alive else time.time() - 600))

    def batch(self, model="claude", method="a", log_text=None, ended=True, log_dir=None):
        self.store.line(model, method)   # a Line row exists once the Supervisor has touched it
        bid = self.store.create_batch(method=method, producer=model, shard="001", batch="01",
                                      branch="b", worktree=str(Path(self.tmp.name) / "wt"))
        self.store.update(bid, state="PRODUCING", error=f"boom {TOKEN}")
        log = Path(log_dir or self.paths.logs) / f"batch-{bid}.log"
        if log_text is not None:
            log.parent.mkdir(parents=True, exist_ok=True)
            log.write_text(log_text)
        rid = self.store.add_run(bid, "produce", None, 1, log, log.with_suffix(".exit"))
        if ended:
            self.store.finish_runs(bid, 0)
        return bid, rid, log

    def close(self):
        self.tmp.cleanup()


class CommandTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.addCleanup(self.e.close)

    def cmd(self, **body):
        return api.command(self.e.store, self.e.cfg, body)

    def refused(self, status, **body):
        with self.assertRaises(api.ApiError) as cm:
            self.cmd(**body)
        self.assertEqual(cm.exception.status, status, cm.exception.message)
        return cm.exception

    def test_invalid_commands_rejected_without_state_change(self):
        table = [
            ({"cmd": "rm -rf"}, 400), ({"cmd": "shell", "argv": ["ls"]}, 400), ({}, 400), ({"cmd": ["start"]}, 400),
            ({"cmd": "start", "model": "claude", "method": "a", "mode": "single", "path": "/etc"}, 400),
            ({"cmd": "start", "model": "claude", "method": "a", "mode": "forever"}, 400),
            ({"cmd": "start", "model": "claude", "method": "a"}, 400),
            ({"cmd": "start", "model": "nobody", "method": "a", "mode": "single"}, 404),
            ({"cmd": "start", "model": "claude", "method": "z", "mode": "single"}, 404),
            ({"cmd": "start", "model": "claude", "method": "m", "mode": "single"}, 404),   # hidden Maintainer line
            ({"cmd": "start", "model": "deepseek", "method": "s2", "mode": "single"}, 409),   # Stage 2: Claude/Codex only
            ({"cmd": "start", "model": 5, "method": "a", "mode": "single"}, 400),
            ({"cmd": "drain", "model": "claude", "method": "a", "on": "yes"}, 400),
            ({"cmd": "clear", "model": "claude", "method": "a", "batch_id": True, "confirm": "x"}, 400),
            ({"cmd": "stop_all", "confirm": "stop-all", "extra": 1}, 400),
        ]
        for body, status in table:
            with self.subTest(body=body):
                with self.assertRaises(api.ApiError) as cm:
                    api.command(self.e.store, self.e.cfg, body)
                self.assertEqual(cm.exception.status, status, cm.exception.message)
        self.assertFalse(any(l["run"] for l in map(dict, self.e.store.lines())))
        with self.assertRaises(api.ApiError):
            api.command(self.e.store, self.e.cfg, [])

    def test_offline_refuses_every_change_but_reads_still_work(self):
        self.e.heartbeat(False)
        bodies = [{"cmd": "start", "model": "claude", "method": "a", "mode": "single"},
                  {"cmd": "drain", "model": "claude", "method": "a", "on": True},
                  {"cmd": "retry", "model": "claude", "method": "a"},
                  {"cmd": "stop", "model": "claude", "method": "a", "confirm": "claude/a"},
                  {"cmd": "clear", "model": "claude", "method": "a", "batch_id": 1, "confirm": "claude/a/1"},
                  {"cmd": "drain_all"}, {"cmd": "stop_all", "confirm": "stop-all"}]
        for body in bodies:
            with self.subTest(cmd=body["cmd"]):
                err = None
                try:
                    api.command(self.e.store, self.e.cfg, body)
                except api.ApiError as e:
                    err = e
                self.assertIsNotNone(err)
                self.assertEqual((err.status, err.extra.get("offline")), (409, True))
        self.assertEqual(self.e.store.peek_line("claude", "a")["run"], 0)
        b = api.board(self.e.store, self.e.cfg)
        self.assertFalse(b["alive"])
        self.assertTrue(b["notes"][0].startswith("Supervisor가 실행 중이 아닙니다"))

    def test_start_uses_control_and_never_double_books_a_line(self):
        self.assertTrue(self.cmd(cmd="start", model="claude", method="a", mode="continuous")["ok"])
        ln = self.e.store.peek_line("claude", "a")
        self.assertEqual((ln["run"], ln["mode"]), (1, "continuous"))
        self.e.batch("claude", "a")
        self.assertEqual(self.refused(409, cmd="start", model="claude", method="a", mode="single").message[:6], "claude")

    def test_stop_stop_all_and_clear_need_the_exact_confirmation(self):
        bid, _, _ = self.e.batch("claude", "a")
        for body, expected in [
            ({"cmd": "stop", "model": "claude", "method": "a"}, "claude/a"),
            ({"cmd": "stop", "model": "claude", "method": "a", "confirm": "codex/a"}, "claude/a"),
            ({"cmd": "stop_all"}, "stop-all"), ({"cmd": "stop_all", "confirm": True}, "stop-all"),
            ({"cmd": "clear", "model": "claude", "method": "a", "batch_id": bid}, f"claude/a/{bid}"),
            ({"cmd": "clear", "model": "claude", "method": "a", "batch_id": bid, "confirm": "claude/a"}, f"claude/a/{bid}"),
        ]:
            with self.subTest(body=body):
                err = self.refused(400, **body)
                self.assertEqual(err.extra["confirm_required"], expected)
        self.assertEqual(self.e.store.peek_line("claude", "a")["force_stop"], 0)
        self.assertIsNone(self.e.store.clear_request("claude", "a"))
        self.cmd(cmd="stop", model="claude", method="a", confirm="claude/a")
        self.assertEqual(self.e.store.peek_line("claude", "a")["force_stop"], 1)
        self.refused(409, cmd="clear", model="claude", method="a", batch_id=bid + 99, confirm=f"claude/a/{bid + 99}")
        self.cmd(cmd="clear", model="claude", method="a", batch_id=bid, confirm=f"claude/a/{bid}")
        self.assertIsNotNone(self.e.store.clear_request("claude", "a"))

    def test_drain_retry_and_drain_all_follow_tui_semantics(self):
        self.refused(409, cmd="drain", model="claude", method="b", on=True)       # nothing to drain, like the disabled button
        self.cmd(cmd="drain", model="claude", method="b", on=False)               # cancelling is always fine
        bid, _, _ = self.e.batch("claude", "a")
        self.cmd(cmd="drain", model="claude", method="a", on=True)
        self.assertEqual(self.e.store.peek_line("claude", "a")["drain"], 1)
        self.cmd(cmd="drain", model="claude", method="a", on=False)
        self.assertEqual(self.e.store.peek_line("claude", "a")["drain"], 0)
        self.refused(409, cmd="retry", model="claude", method="a")                # PRODUCING: not retryable
        self.e.store.update(bid, state="PAUSED")
        self.cmd(cmd="retry", model="claude", method="a")
        self.assertEqual(self.e.store.peek_line("claude", "a")["retry_batch"], bid)
        self.assertEqual(self.cmd(cmd="drain_all")["ok"], True)
        self.assertEqual(self.e.store.peek_line("claude", "a")["drain_once"], 1)
        self.cmd(cmd="stop_all", confirm="stop-all")
        self.assertEqual(self.e.store.peek_line("claude", "a")["force_stop"], 1)


class ReadTests(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.addCleanup(self.e.close)

    def log(self, run=None, source="latest", **kw):
        return api.read_log(self.e.store, self.e.cfg, self.e.paths, "claude", "a", source, run=run, **kw)

    def test_board_matches_control_line_status_and_redacts(self):
        self.e.batch("claude", "a", log_text="x\n")
        b = api.board(self.e.store, self.e.cfg)
        ids = {(l["model"], l["method"]) for l in b["lines"]}
        self.assertEqual(ids, {("claude", m) for m in "abcd"} | {("claude", "s2")} | {("deepseek", m) for m in "abcd"})
        line = next(l for l in b["lines"] if (l["model"], l["method"]) == ("claude", "a"))
        ref = control.line_status(self.e.store, "claude", "a")
        self.assertEqual((line["state"], line["batch"], line["can_stop"]), (ref["state"], ref["batch"], ref["can_stop"]))
        self.assertNotIn(TOKEN, json.dumps(b))
        self.assertIn("[REDACTED]", line["error"])
        self.assertEqual(b["maintainer"]["column"], "deepseek")

    def test_stage2_saved_candidate_progress_uses_the_shared_board_and_detail_view(self):
        self.e.store.line("claude", "s2")
        bid = self.e.store.create_batch(method="s2", producer="claude", shard="001", batch="01-03",
                                        branch="s2-claude-001-01-03", worktree=str(self.e.paths.worktrees / "part"))
        self.e.store.update(bid, state="PAUSED", progress_kind="candidates", progress_done=0, progress_total=100)
        board = api.board(self.e.store, self.e.cfg)
        line = next(item for item in board["lines"] if item["method"] == "s2")
        self.assertEqual((line["progress_text"], line["progress_pct"], line["stage2"]),
                         ("0 / 100 candidates", 0.0, {"shard": "001", "batch": "01", "part": "03"}))
        detail = api.line_detail(self.e.store, self.e.cfg, self.e.paths, "claude", "s2")
        self.assertIn("Shard 001 · Batch 01 · Part 03", detail["header"])
        self.assertEqual(detail["line"]["progress_text"], "0 / 100 candidates")

    def test_unknown_line_is_404(self):
        for model, method in [("nobody", "a"), ("claude", "m"), ("deepseek", "s2"), ("claude", "z")]:
            with self.subTest(line=(model, method)), self.assertRaises(api.ApiError) as cm:
                api.line_detail(self.e.store, self.e.cfg, self.e.paths, model, method)
            self.assertEqual(cm.exception.status, 404)

    def test_log_is_redacted_incremental_and_limited(self):
        _, rid, log = self.e.batch("claude", "a", log_text=f"first {TOKEN}\n" + "y" * 20000 + "\npartial", ended=False)
        d = self.log()
        self.assertEqual(d["lines"][0], "first [REDACTED]")
        self.assertEqual(len(d["lines"][1]), api.MAX_LINE_CHARS + len("… (+11992자 생략)"))
        self.assertTrue(d["live"] and not d["missing"])
        with open(log, "a") as fh:
            fh.write(" done\nnext\n")
        d2 = self.log(cursor=d["cursor"], run=rid)
        self.assertEqual(d2["lines"], ["partial done", "next"])                 # the partial tail waited for its newline
        self.assertEqual(self.log(cursor=d2["cursor"], run=rid)["lines"], [])
        log.write_text("short\n")                                               # truncated / rotated
        d3 = self.log(cursor=d2["cursor"], run=rid)
        self.assertEqual((d3["reset"], d3["lines"]), (True, ["short"]))
        log.write_text("".join(f"l{i}\n" for i in range(api.MAX_LOG_LINES + 5)))
        d4 = self.log(raw=True)
        self.assertEqual((len(d4["lines"]), d4["lines"][0]), (api.MAX_LOG_LINES, "l0"))
        rest = self.log(cursor=d4["cursor"], run=rid, raw=True)
        self.assertEqual(rest["lines"][-1], f"l{api.MAX_LOG_LINES + 4}")

    def test_audit_first_view_is_one_bounded_tail_query(self):
        bid, _, _ = self.e.batch("claude", "a")
        for n in range(api.AUDIT_TAIL + 250):
            self.e.store.log(bid, f"ev{n}")
        calls = []
        full, tail = self.e.store.line_events, self.e.store.line_events_tail
        self.e.store.line_events = lambda *a, **k: calls.append("scan") or full(*a, **k)
        self.e.store.line_events_tail = lambda *a, **k: calls.append(a[2]) or tail(*a, **k)
        d = self.log(source="audit")
        self.assertEqual(calls, [api.AUDIT_TAIL])                 # no full scan, one LIMIT-bounded query
        self.assertEqual(len(d["lines"]), api.AUDIT_TAIL)
        self.assertTrue(d["lines"][0].endswith(f"ev{250}") and d["lines"][-1].endswith(f"ev{api.AUDIT_TAIL + 249}"))
        self.e.store.log(bid, "fresh")
        d2 = self.log(source="audit", cursor=d["cursor"])
        self.assertEqual([l.split()[-1] for l in d2["lines"]], ["fresh"])
        self.assertEqual(self.log(source="audit", cursor=d2["cursor"])["lines"], [])

    def test_long_log_starts_at_its_tail(self):
        self.e.batch("claude", "a", log_text=("z" * 99 + "\n") * (INITIAL_BYTES // 100 + 500))
        d = self.log()
        self.assertLess(len(d["lines"]), INITIAL_BYTES // 100 + 5)
        self.assertTrue(all(l == "z" * 99 for l in d["lines"]))

    def test_only_db_recorded_logs_inside_the_log_dir_are_served(self):
        outside = Path(self.e.tmp.name) / "secret.txt"
        outside.write_text("top secret\n")
        _, _, log = self.e.batch("claude", "a", log_text="ok\n")
        for bad in ["../../etc/passwd", "/etc/passwd", "run:1/../..", "run:x", "file:///etc/passwd", "run:" + "9" * 20, ""]:
            with self.subTest(source=bad), self.assertRaises(api.ApiError) as cm:
                self.log(source=bad)
            self.assertEqual(cm.exception.status, 400)
        # a run row pointing outside the log dir (corrupt/hostile DB value) is treated as missing, never read
        bid2 = self.e.store.create_batch(method="b", producer="claude", shard="001", batch="01", branch="b", worktree="w")
        self.e.store.add_run(bid2, "produce", None, 1, outside, outside.with_suffix(".exit"))
        d = api.read_log(self.e.store, self.e.cfg, self.e.paths, "claude", "b")
        self.assertTrue(d["missing"])
        self.assertNotIn("top secret", json.dumps(d))
        # another Line's run id is not addressable through this Line
        other = api.read_log(self.e.store, self.e.cfg, self.e.paths, "claude", "b", "run:1")
        self.assertTrue(other["missing"] and other["lines"] == [])

    def test_history_without_file_is_reported_as_deleted(self):
        _, rid, log = self.e.batch("claude", "a", log_text="gone\n")
        log.unlink()
        d = self.log(source=f"run:{rid}")
        self.assertTrue(d["missing"])
        self.assertIn("삭제", d["message"])
        detail = api.line_detail(self.e.store, self.e.cfg, self.e.paths, "claude", "a")
        self.assertFalse(detail["runs"][0]["log_exists"])
        self.assertEqual(self.log(source="audit")["missing"], False)


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.e = Env()
        cls.srv = WebServer("127.0.0.1", 0, cls.e.paths, ["mac.tail1234.ts.net"])
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.port = cls.srv.port

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.srv.server_close()
        cls.e.close()

    def req(self, method, path, body=None, **headers):
        c = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        h = {"Host": f"localhost:{self.port}", **headers}
        h = {k.replace("_", "-"): v for k, v in h.items() if v is not None}
        c.request(method, path, body=body, headers=h)
        r = c.getresponse()
        data = r.read()
        c.close()
        return r.status, dict(r.getheaders()), data

    def post(self, body, **headers):
        raw = json.dumps(body)
        base = {"Origin": f"http://localhost:{self.port}", "Content-Type": "application/json",
                "Content-Length": str(len(raw))}
        return self.req("POST", "/api/command", raw, **{**base, **headers})

    def test_bind_is_loopback_only(self):
        for host, ok in [("127.0.0.1", True), ("localhost", True), ("::1", True), ("127.0.0.2", True),
                         ("0.0.0.0", False), ("::", False), ("", False), ("192.168.0.4", False), ("100.64.0.1", False),
                         ("example.com", False), ("8.8.8.8", False)]:
            with self.subTest(host=host):
                if ok:
                    check_loopback(host)
                else:
                    with self.assertRaises(ValueError):
                        check_loopback(host)
        self.assertEqual(self.srv.server_address[0], "127.0.0.1")

    def test_serves_fixed_assets_with_hardening_headers_and_nothing_else(self):
        for path in ["/", "/app.js", "/app.css"]:
            status, hdr, _ = self.req("GET", path)
            self.assertEqual(status, 200, path)
            self.assertIn("default-src 'self'", hdr["Content-Security-Policy"])
            self.assertEqual(hdr["X-Content-Type-Options"], "nosniff")
        for path in ["/../store.py", "/%2e%2e/store.py", "/static/app.js", "/app.js/../../config.py", "/api/nope",
                     "/api/line/claude/a/../../..", "/api/line/Claude/a", "/api/line/claude/a/log/x"]:
            with self.subTest(path=path):
                self.assertEqual(self.req("GET", path)[0], 404)
        self.assertEqual(self.req("GET", "/api/line/nobody/a")[0], 404)
        status, _, data = self.req("GET", "/api/board")
        self.assertEqual(status, 200)
        self.assertNotIn("html", json.loads(data).get("error", ""))

    def test_host_header_is_checked_on_every_route(self):
        for host in ["evil.example", f"evil.example:{self.port}", "localhost:1", "127.0.0.1", "169.254.1.1:" + str(self.port)]:
            with self.subTest(host=host):
                self.assertEqual(self.req("GET", "/api/board", Host=host)[0], 403)
                self.assertEqual(self.req("GET", "/", Host=host)[0], 403)
        self.assertEqual(self.req("GET", "/api/board", Host=f"127.0.0.1:{self.port}")[0], 200)
        self.assertEqual(self.req("GET", "/api/board", Host="mac.tail1234.ts.net")[0], 200)   # --allow-host (Tailscale Serve)

    def test_post_requires_same_origin_json_and_a_valid_command(self):
        ok = {"cmd": "drain_all"}
        self.assertEqual(self.post(ok)[0], 200)
        for name, extra, status in [
            ("no origin", {"Origin": None}, 403), ("evil origin", {"Origin": "https://evil.example"}, 403),
            ("other port", {"Origin": "http://localhost:1"}, 403), ("null origin", {"Origin": "null"}, 403),
            ("path in origin", {"Origin": f"http://localhost:{self.port}/x"}, 403),
            ("cross-site fetch", {"Sec-Fetch-Site": "cross-site"}, 403), ("same-site fetch", {"Sec-Fetch-Site": "same-site"}, 403),
            ("text/plain", {"Content-Type": "text/plain"}, 415), ("form", {"Content-Type": "application/x-www-form-urlencoded"}, 415),
            ("bad host", {"Host": "evil.example"}, 403),
            ("tailnet origin", {"Origin": "https://mac.tail1234.ts.net", "Host": "mac.tail1234.ts.net"}, 200),
        ]:
            with self.subTest(case=name):
                self.assertEqual(self.post(ok, **extra)[0], status)
        self.assertEqual(self.req("POST", "/api/command", "not json", Origin=f"http://localhost:{self.port}",
                                  Content_Type="application/json", Content_Length="8")[0], 400)
        self.assertEqual(self.req("POST", "/api/command", "x" * 5000, Origin=f"http://localhost:{self.port}",
                                  Content_Type="application/json", Content_Length="5000")[0], 413)
        self.assertEqual(self.post({"cmd": "bash", "argv": ["id"]})[0], 400)
        self.assertEqual(self.req("PUT", "/api/command")[0], 501)
        self.assertEqual(self.req("POST", "/api/board", "{}", Origin=f"http://localhost:{self.port}",
                                  Content_Type="application/json", Content_Length="2")[0], 404)


if __name__ == "__main__":
    unittest.main()
