"""Incremental `tail -f` reader: only bytes appended since the last offset are read."""
from __future__ import annotations

import re
from pathlib import Path

INITIAL_BYTES = 64 * 1024      # first view of a long log shows only its tail
MAX_CHUNK = 256 * 1024         # per-poll read cap; the rest arrives on the next poll

_SECRETS = [
    re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?i)\b(bearer)(\s+)[A-Za-z0-9._~+/=-]{12,}"),
    re.compile(r"(?i)\b(token|api[_-]?key|authorization)(\"?\s*[:=]\s*\"?)[A-Za-z0-9._~+/=-]{12,}"),
]


def redact(text: str) -> str:
    """Never show credentials in the log pane."""
    for pat in _SECRETS:
        text = pat.sub(lambda m: (m.group(1) + m.group(2) + "[REDACTED]") if m.lastindex == 2 else "[REDACTED]", text)
    return text


class LogTail:
    """One followed file. `read()` returns newly appended complete lines."""

    def __init__(self, path: str | Path | None):
        self.path = Path(path) if path else None
        self.offset = 0
        self.started = False
        self._partial = b""

    def read(self) -> list[str]:
        if self.path is None:
            return []
        try:
            size = self.path.stat().st_size
        except OSError:
            return []          # no log yet / removed: not an error
        if not self.started:
            self.started = True
            self.offset = max(0, size - INITIAL_BYTES)
            skip_first = self.offset > 0   # we may start mid-line
        else:
            skip_first = False
            if size < self.offset:         # truncated/rotated: restart from the top
                self.offset, self._partial = 0, b""
        if size == self.offset:
            return []
        with open(self.path, "rb") as fh:
            fh.seek(self.offset)
            chunk = fh.read(min(size - self.offset, MAX_CHUNK))
        self.offset += len(chunk)
        data = self._partial + chunk
        *lines, self._partial = data.split(b"\n")
        if skip_first and lines:
            lines = lines[1:]
        return [redact(l.decode("utf-8", errors="replace").rstrip("\r")) for l in lines]
