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
    """Return the *currently effective* blocking events for head_sha, oldest first.

    Invariant: a `-1` blocks only while no later same-HEAD PASS (`+1`/`+2`) exists;
    DISMISSED reviews never count; verdicts are ordered by time (then id). A `-1`
    review applies to head_sha when its HEAD marker (or, lacking one, its
    commit_id) equals it. Inline comments are context of an effective `-1` review
    (or standalone, anchored to head_sha and newer than the latest PASS) and never
    trigger alone. General comments need an explicit verdict and a matching HEAD
    marker or, without one, a timestamp after the HEAD push.
    """
    head = head_sha.lower()

    def author(x):
        return ((x.get("user") or {}).get("login") or "")

    # (ts, id, verdict, event) for every applicable verdict on this HEAD
    verdicts: list[tuple[float, int, str, dict]] = []
    for r in reviews:
        v = verdict(r.get("body"))
        if v is None or author(r) == self_login or (r.get("state") or "").upper() == "DISMISSED":
            continue
        marker = head_marker(r.get("body")) or (r.get("commit_id") or "").lower()
        if marker != head:
            continue
        ev = {"key": f"review:{r['id']}", "kind": "review", "author": author(r),
              "body": r.get("body") or "", "ts": _ts(r.get("submitted_at")), "review_id": r["id"]}
        verdicts.append((ev["ts"], r["id"], v, ev))
    for c in issue:
        v = verdict(c.get("body"))
        if v is None or author(c) == self_login:
            continue
        marker = head_marker(c.get("body"))
        ts = _ts(c.get("created_at"))
        if marker is not None:
            if marker != head:
                continue
        elif ts < head_pushed_at:
            continue
        ev = {"key": f"issue:{c['id']}", "kind": "comment", "author": author(c),
              "body": c.get("body") or "", "ts": ts}
        verdicts.append((ts, c["id"], v, ev))
    verdicts.sort(key=lambda t: (t[0], t[1]))
    last_pass = max((t[0] for t in verdicts if t[2] != "-1"), default=None)
    active = [t[3] for t in verdicts
              if t[2] == "-1" and (last_pass is None or t[0] > last_pass)]
    if not active:
        return []
    active_reviews = {e["review_id"] for e in active if e["kind"] == "review"}
    out = list(active)
    for c in inline:
        if author(c) == self_login or (c.get("commit_id") or "").lower() != head:
            continue
        if not (c.get("body") or "").strip():
            continue
        rid, ts = c.get("pull_request_review_id"), _ts(c.get("created_at"))
        if rid is not None and rid not in active_reviews:
            continue  # belongs to a PASS / superseded / dismissed review
        if rid is None and last_pass is not None and ts <= last_pass:
            continue
        out.append({"key": f"inline:{c['id']}", "kind": "inline", "author": author(c),
                    "body": c["body"], "path": c.get("path"), "line": c.get("line"), "ts": ts})
    return sorted(out, key=lambda e: (e["ts"], e["kind"] == "inline", e["key"]))
