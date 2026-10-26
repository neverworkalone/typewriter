"""`./war-web`: the War Room Web UI as its own process. It never starts, stops or restarts the Supervisor."""
from __future__ import annotations

import argparse
import sys

from ..config import Paths
from .server import WebServer


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="war-web", description="War Room Web UI (loopback only)")
    ap.add_argument("--host", default="127.0.0.1", help="loopback address only (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--allow-host", action="append", default=[], metavar="NAME",
                    help="extra Host/Origin name to accept, e.g. the tailnet name Tailscale Serve forwards")
    args = ap.parse_args(argv)
    paths = Paths()
    paths.ensure()
    try:
        srv = WebServer(args.host, args.port, paths, args.allow_host)
    except (ValueError, OSError) as e:
        print(f"[war-web] 시작 실패: {e}", file=sys.stderr)
        return 1
    print(f"[war-web] http://localhost:{srv.port}  (loopback 전용 · Ctrl+C로 종료, Supervisor에는 영향 없음)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
