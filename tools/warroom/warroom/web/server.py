"""Loopback-only HTTP server for the War Room Web UI (Issue #1720). Stdlib, no new dependency.

Trust boundary: it listens on a loopback address only. Network access beyond this Mac is the job of Tailscale Serve
(which proxies to the loopback port); the Host/Origin checks below keep other web pages and DNS rebinding from
driving the local API, and `--allow-host` names the tailnet host name Serve forwards.
"""
from __future__ import annotations

import ipaddress
import json
import re
import socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from ..config import Paths, load_config
from ..store import Store
from . import api

STATIC_DIR = Path(__file__).parent / "static"
STATIC = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
          "/app.css": ("app.css", "text/css; charset=utf-8")}   # fixed whitelist: a request path never reaches the disk
LOOPBACK_NAMES = ("localhost", "127.0.0.1", "::1")
MAX_BODY = 4096
LINE_PATH = re.compile(r"^/api/line/([a-z0-9-]{1,40})/([a-z0-9]{1,8})(/log)?$")


def check_loopback(host: str) -> str:
    """Refuse every bind address that is not loopback (no 0.0.0.0, no LAN/public interface)."""
    if host == "localhost":
        return "127.0.0.1"
    try:
        if ipaddress.ip_address(host).is_loopback:
            return host
    except ValueError:
        pass
    raise ValueError(f"loopback 주소만 사용할 수 있습니다 (요청: {host!r}). 외부 접속은 Tailscale Serve를 사용하세요.")


def _parse_host(value: str):
    try:
        u = urlsplit("//" + value)
        return (u.hostname or "").lower(), u.port
    except ValueError:
        return "", None


class WebServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, host: str, port: int, paths: Paths, allow_hosts=()):
        host = check_loopback(host)
        self.address_family = socket.AF_INET6 if ":" in host else socket.AF_INET
        self.paths = paths
        self.store = Store(paths.db)
        self.allow_hosts = {h.lower() for h in allow_hosts}
        super().__init__((host, port), Handler)
        self.port = self.server_address[1]

    def host_ok(self, value: str | None, default_port: int | None = None) -> bool:
        """Loopback names only on OUR port; a tailnet host name only when the owner listed it."""
        name, port = _parse_host(value or "")
        if name in self.allow_hosts:
            return True
        return name in LOOPBACK_NAMES and (port if port is not None else default_port) == self.port

    def origin_ok(self, origin: str | None) -> bool:
        if not origin:
            return False
        u = urlsplit(origin)
        if u.scheme not in ("http", "https") or u.path not in ("", "/") or u.query or u.fragment:
            return False
        try:
            port = u.port if u.port is not None else (443 if u.scheme == "https" else 80)
        except ValueError:
            return False
        name = (u.hostname or "").lower()
        return name in self.allow_hosts or (name in LOOPBACK_NAMES and port == self.port)


class Handler(BaseHTTPRequestHandler):
    server: WebServer
    protocol_version = "HTTP/1.1"
    server_version = "WarRoomWeb"

    def log_message(self, fmt, *args) -> None:   # request logs would carry query strings; keep the console quiet
        pass

    # --- plumbing ---
    def _send(self, status: int, body: bytes, ctype: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, payload: dict) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _fail(self, e: api.ApiError) -> None:
        self._json(e.status, {"ok": False, "error": e.message, **e.extra})

    def _cfg(self) -> dict:
        try:
            return load_config(self.server.paths)
        except (OSError, ValueError) as e:
            raise api.ApiError(500, f"설정을 읽을 수 없습니다: {type(e).__name__}")

    # --- GET ---
    def do_GET(self) -> None:
        try:
            if not self.server.host_ok(self.headers.get("Host"), 80):
                return self._json(403, {"ok": False, "error": "허용되지 않은 Host입니다."})
            u = urlsplit(self.path)
            if u.path in STATIC:
                name, ctype = STATIC[u.path]
                return self._send(200, (STATIC_DIR / name).read_bytes(), ctype)
            srv = self.server
            if u.path == "/api/board":
                return self._json(200, api.board(srv.store, self._cfg()))
            m = LINE_PATH.match(u.path)
            if not m:
                return self._json(404, {"ok": False, "error": "찾을 수 없습니다."})
            model, method, log = m.group(1), m.group(2), m.group(3)
            cfg = self._cfg()
            if not log:
                return self._json(200, api.line_detail(srv.store, cfg, srv.paths, model, method))
            q = parse_qs(u.query)
            one = lambda k: (q.get(k) or [None])[0]
            num = lambda k: int(one(k)) if (one(k) or "").isdigit() and len(one(k)) < 16 else None
            self._json(200, api.read_log(srv.store, cfg, srv.paths, model, method, one("source") or "latest",
                                         num("cursor"), num("run"), one("raw") == "1"))
        except api.ApiError as e:
            self._fail(e)
        except Exception:   # never leak internals (paths, SQL, tokens) to the client
            self._json(500, {"ok": False, "error": "서버 오류"})

    # --- POST (the only mutating route) ---
    def do_POST(self) -> None:
        try:
            srv = self.server
            if urlsplit(self.path).path != "/api/command":
                return self._json(404, {"ok": False, "error": "찾을 수 없습니다."})
            if not srv.host_ok(self.headers.get("Host"), 80) or not srv.origin_ok(self.headers.get("Origin")):
                return self._json(403, {"ok": False, "error": "허용되지 않은 Origin입니다."})
            if self.headers.get("Sec-Fetch-Site") not in (None, "same-origin", "none"):
                return self._json(403, {"ok": False, "error": "cross-site 요청은 거절됩니다."})
            if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
                return self._json(415, {"ok": False, "error": "Content-Type은 application/json이어야 합니다."})
            try:
                n = int(self.headers.get("Content-Length") or "")
            except ValueError:
                return self._json(411, {"ok": False, "error": "Content-Length가 필요합니다."})
            if not 0 < n <= MAX_BODY:
                return self._json(413, {"ok": False, "error": "요청 본문 크기가 올바르지 않습니다."})
            try:
                body = json.loads(self.rfile.read(n))
            except (ValueError, UnicodeDecodeError):
                return self._json(400, {"ok": False, "error": "JSON이 올바르지 않습니다."})
            self._json(200, api.clean(api.command(srv.store, self._cfg(), body)))
        except api.ApiError as e:
            self._fail(e)
        except Exception:
            self._json(500, {"ok": False, "error": "서버 오류"})
