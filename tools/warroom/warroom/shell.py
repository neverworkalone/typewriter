"""Command runner seam: production uses subprocess, tests inject a fake."""
from __future__ import annotations

import re
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


# A failure that asking again can fix (the request itself was fine): one table for gh and git diagnostics.
# An explicit HTTP status decides first (`HTTP 502`, git's `returned error: 404`): only 5xx / 429 / a secondary rate limit
# retry, every other status is a definite answer. Network phrases apply only when the diagnostic carries no status, and
# never a generic wrapper such as git's `unable to access` (it prefixes definite 404s too).
_STATUS = re.compile(r"\b(?:http(?:/\d(?:\.\d)?)?|error:)\s*(\d{3})\b")
RATE_LIMIT_TOKENS = ("secondary rate limit", "abuse detection", "rate limit exceeded")
NETWORK_TOKENS = (
    "could not resolve host", "could not resolve hostname", "temporary failure in name resolution",
    "connection timed out", "connection reset", "connection refused", "connection closed", "broken pipe",
    "operation timed out", "network is unreachable", "no route to host", "ssl connection timeout",
    "tls handshake timeout", "i/o timeout", "unexpected eof", "the remote end hung up", "early eof",
    "gnutls_handshake", "timeout awaiting response", "failed to connect to", "bad gateway",
    "service unavailable", "gateway time-out",
)


def transient(res: Result) -> str | None:
    """Why `res` (a failed command) is worth asking again, or None for a definite answer (401/403/404/422, local errors)."""
    if res.ok:
        return None
    why = (res.err.strip() or res.out.strip())[:300]
    if res.code == 124:
        return why or "timeout"
    text = f"{res.err}\n{res.out}".lower()
    statuses = [int(x) for x in _STATUS.findall(text)]
    if statuses:
        if any(x >= 500 or x == 429 for x in statuses) or (403 in statuses and any(t in text for t in RATE_LIMIT_TOKENS)):
            return why or "http"
        return None
    if any(t in text for t in RATE_LIMIT_TOKENS + NETWORK_TOKENS):
        return why or "network"
    return None
