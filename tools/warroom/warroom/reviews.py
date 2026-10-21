"""Which reviewer events require a fix run (pure functions, no I/O).

Invariant: an event triggers a fix only if it is a `-1` verdict (or an inline /
general comment) that applies to the PR's *current* HEAD, was not written by the
producer account itself, and has not been handled for (PR, HEAD, event id).
"""
from __future__ import annotations

import re
from datetime import datetime

_VERDICT = re.compile(r"^\s*([+-][12])\b")
_HEAD = re.compile(r"HEAD:\s*([0-9a-f]{40})", re.I)


def verdict(body: str | None) -> str | None:
    m = _VERDICT.match(body or "")
    return m.group(1) if m else None


def head_marker(body: str | None) -> str | None:
    m = _HEAD.search(body or "")
    return m.group(1).lower() if m else None


def _ts(s: str | None) -> float:
    if not s:
        return 0.0
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def fix_events(*, head_sha: str, head_pushed_at: float, self_login: str,
               reviews: list[dict], inline: list[dict], issue: list[dict]) -> list[dict]:
    """Return applicable events: [{key, kind, author, body, path?}] oldest first.

    A `-1` review is applicable when its HEAD marker (or, lacking one, its
    commit_id) equals head_sha. Inline comments are applicable when anchored to
    head_sha. General comments need an explicit `-1` verdict and either a
    matching HEAD marker or, with no marker, a timestamp after the HEAD push.
    """
    head = head_sha.lower()
    out: list[dict] = []

    def author(x):
        return ((x.get("user") or {}).get("login") or "")

    live_review_ids = set()
    for r in reviews:
        if author(r) == self_login or verdict(r.get("body")) != "-1":
            continue
        marker = head_marker(r.get("body")) or (r.get("commit_id") or "").lower()
        if marker != head:
            continue
        live_review_ids.add(r["id"])
        out.append({"key": f"review:{r['id']}", "kind": "review", "author": author(r),
                    "body": r.get("body") or "", "ts": _ts(r.get("submitted_at"))})
    for c in inline:
        if author(c) == self_login or (c.get("commit_id") or "").lower() != head:
            continue
        if not (c.get("body") or "").strip():
            continue
        out.append({"key": f"inline:{c['id']}", "kind": "inline", "author": author(c),
                    "body": c["body"], "path": c.get("path"), "line": c.get("line"),
                    "ts": _ts(c.get("created_at"))})
    for c in issue:
        if author(c) == self_login or verdict(c.get("body")) != "-1":
            continue
        marker = head_marker(c.get("body"))
        if marker is not None:
            if marker != head:
                continue
        elif _ts(c.get("created_at")) < head_pushed_at:
            continue
        out.append({"key": f"issue:{c['id']}", "kind": "comment", "author": author(c),
                    "body": c.get("body") or "", "ts": _ts(c.get("created_at"))})
    # Inline comments alone never start a fix: they must accompany a -1 verdict
    # (review or comment) on this HEAD, otherwise approvals with nits would loop.
    if not any(e["kind"] in ("review", "comment") for e in out):
        return []
    return sorted(out, key=lambda e: e["ts"])
