"""Command runner seam: production uses subprocess, tests inject a fake."""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Result:
    code: int
    out: str = ""
    err: str = ""

    @property
    def ok(self) -> bool:
        return self.code == 0


class Runner:
    def run(self, argv: list[str], cwd: Path | str | None = None,
            env: dict | None = None, input: str | None = None,
            timeout: float | None = 120) -> Result:
        try:
            p = subprocess.run(argv, cwd=cwd, env=env, input=input, text=True,
                               capture_output=True, timeout=timeout)
        except FileNotFoundError as e:
            return Result(127, "", str(e))
        except subprocess.TimeoutExpired:
            return Result(124, "", f"timeout: {argv[0]}")
        return Result(p.returncode, p.stdout, p.stderr)


# A failure that asking again can fix (the request itself was fine): one token table for gh and git diagnostics.
TRANSIENT_TOKENS = (
    "http 500", "http 502", "http 503", "http 504", "http 429",
    "secondary rate limit", "abuse detection", "rate limit exceeded",
    "could not resolve host", "could not resolve hostname", "temporary failure in name resolution",
    "connection timed out", "connection reset", "connection refused", "connection closed", "broken pipe",
    "operation timed out", "network is unreachable", "no route to host", "ssl connection timeout",
    "tls handshake timeout", "i/o timeout", "unexpected eof", "remote end hung up", "the remote end hung up",
    "early eof", "rpc failed", "gnutls_handshake", "timeout awaiting response", "failed to connect to",
    "unable to access", "stream error", "server error", "bad gateway", "service unavailable", "gateway time-out",
)


def transient(res: Result) -> str | None:
    """Why `res` (a failed command) is worth asking again, or None for a definite answer (401/403/404/422, local errors)."""
    if res.ok:
        return None
    if res.code == 124:
        return res.err.strip() or "timeout"
    text = f"{res.err}\n{res.out}".lower()
    for token in TRANSIENT_TOKENS:
        if token in text:
            return (res.err.strip() or res.out.strip())[:300] or token
    return None
