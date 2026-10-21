"""Human-readable view of an agent log line (OpenCode `run --format json` and Claude `stream-json` JSON Lines).

Stateless and per line, so the incremental `tail -f` reader never re-parses the whole log. Only what
the line actually contains is shown (no invented timestamps, progress or results); long strings are
shortened with an explicit "Raw Log" pointer, and anything unrecognised is shown as-is.
"""
from __future__ import annotations

import json
import time

from .logtail import redact

MAX_TEXT = 4000          # model text
MAX_COMMAND_LINES = 12
MAX_OUTPUT_LINES = 12
MAX_OUTPUT_CHARS = 1500
MAX_INLINE = 300         # compact JSON / single-line fields
_SHORT_KEYS = ("command", "filePath", "file_path", "path", "pattern", "query", "url", "description")


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[:limit]}… (+{len(text) - limit}자, Raw Log에서 전체 확인)"


def _block(text: str, max_lines: int, max_chars: int) -> list[str]:
    lines = text.splitlines() or [""]
    extra = max(0, len(lines) - max_lines)
    out = lines[:max_lines]
    joined = "\n".join(out)
    if len(joined) > max_chars:
        joined = joined[:max_chars]
        out, extra = joined.splitlines() or [""], max(extra, 1)
    return out + ([f"… (+{extra}줄 이상 생략, Raw Log에서 전체 확인)"] if extra else [])


def _stamp(ev: dict) -> str:
    ts = ev.get("timestamp")
    if isinstance(ts, bool) or not isinstance(ts, (int, float)):
        return ""
    try:
        return time.strftime("%H:%M:%S ", time.localtime(ts / 1000 if ts > 1e11 else ts))
    except (OverflowError, OSError, ValueError):
        return ""


def _indent(lines: list[str], first: str, rest: str) -> list[str]:
    return [(first if i == 0 else rest) + l for i, l in enumerate(lines)]


def _tool(ev: dict, part: dict) -> list[str]:
    st = part.get("state") if isinstance(part.get("state"), dict) else {}
    tool = str(part.get("tool") or "tool")
    inp = st.get("input") if isinstance(st.get("input"), dict) else {}
    title = st.get("title") or inp.get("description")
    head = f"{_stamp(ev)}▸ {tool}" + (f" — {_clip(str(title), MAX_INLINE)}" if title else "")
    out = [head]
    if tool == "bash" and isinstance(inp.get("command"), str):
        out += _indent(_block(inp["command"], MAX_COMMAND_LINES, MAX_OUTPUT_CHARS), "  $ ", "    ")
    else:
        shown = [f"{k}={_clip(str(inp[k]), MAX_INLINE)}" for k in _SHORT_KEYS if k in inp and k != "description"]
        if not shown and inp:
            shown = [_clip(json.dumps(inp, ensure_ascii=False), MAX_INLINE)]
        out += [f"  {s}" for s in shown]
    status = st.get("status")
    meta = st.get("metadata") if isinstance(st.get("metadata"), dict) else {}
    exit_code = meta.get("exit")
    if status and status != "completed":
        out.append(f"  [{status}]")
    if exit_code not in (None, ""):
        out.append(f"  exit={exit_code}")
    if st.get("error"):
        out += _indent(_block(str(st["error"]), MAX_OUTPUT_LINES, MAX_OUTPUT_CHARS), "  ✖ ", "    ")
    output = st.get("output")
    if isinstance(output, str) and output.strip():
        out += _indent(_block(output.rstrip(), MAX_OUTPUT_LINES, MAX_OUTPUT_CHARS), "  → ", "    ")
    return out


def _error(ev: dict) -> list[str]:
    err = ev.get("error")
    if isinstance(err, dict):
        data = err.get("data") if isinstance(err.get("data"), dict) else {}
        msg = data.get("message") or err.get("message")
        name = err.get("name")
        body = " — ".join(str(x) for x in (name, msg) if x) or json.dumps(err, ensure_ascii=False)
    else:
        body = str(err) if err else json.dumps(ev, ensure_ascii=False)
    return _indent(_block(body, 20, 4000), f"{_stamp(ev)}✖ ERROR: ", "    ")


_CLAUDE_HIDDEN = ("commands_changed", "post_turn_summary", "rate_limit_event")   # noise in the readable view; Raw Log keeps them


def _claude(ev: dict) -> list[str] | None:
    """Claude Code stream-json events; None when the line is not one of them."""
    kind = ev.get("type")
    if kind == "system" and ev.get("subtype") == "init":
        return [f"── session {ev.get('session_id', '?')} · model {ev.get('model', '?')} ──"]
    if kind in _CLAUDE_HIDDEN or (kind == "system" and ev.get("subtype") in _CLAUDE_HIDDEN):
        return []
    if kind in ("assistant", "user") and isinstance(ev.get("message"), dict):
        content = ev["message"].get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        out: list[str] = []
        for block in content if isinstance(content, list) else []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                out += _indent(_clip(block["text"].strip(), MAX_TEXT).splitlines() or [""], "● ", "  ")
            elif block.get("type") == "tool_use":
                inp = block.get("input") if isinstance(block.get("input"), dict) else {}
                out.append(f"▸ {block.get('name') or 'tool'}")
                if isinstance(inp.get("command"), str):
                    out += _indent(_block(inp["command"], MAX_COMMAND_LINES, MAX_OUTPUT_CHARS), "  $ ", "    ")
                else:
                    shown = [f"{k}={_clip(str(inp[k]), MAX_INLINE)}" for k in _SHORT_KEYS if k in inp and k != "description"]
                    out += [f"  {x}" for x in shown]
            elif block.get("type") == "tool_result":
                body = block.get("content")
                text = body if isinstance(body, str) else json.dumps(body, ensure_ascii=False) if body is not None else ""
                if text.strip():
                    out += _indent(_block(text.rstrip(), MAX_OUTPUT_LINES, MAX_OUTPUT_CHARS), "  → ", "    ")
        return out
    if kind == "result":
        denied = ev.get("permission_denials") or []
        tail = f"   permission_denials={len(denied)}" if denied else ""
        return [f"■ result: {ev.get('subtype', '?')}{' (error)' if ev.get('is_error') else ''}{tail}"]
    return None


def render_line(raw: str) -> list[str]:
    """Readable display lines for one raw log line (plain text, already redacted)."""
    stripped = raw.strip()
    if not stripped:
        return []
    ev = None
    if stripped[0] == "{":
        try:
            ev = json.loads(stripped)
        except ValueError:
            ev = None
    if not isinstance(ev, dict):
        return [redact(raw)]          # plain stderr / non-JSON output: shown untouched
    claude = _claude(ev)
    if claude is not None:
        return [redact(l) for l in claude]
    part = ev.get("part") if isinstance(ev.get("part"), dict) else {}
    kind = ev.get("type")
    if kind == "text" and isinstance(part.get("text"), str):
        out = _indent(_clip(part["text"].strip(), MAX_TEXT).splitlines() or [""], f"{_stamp(ev)}● ", "  ")
    elif kind == "reasoning" and isinstance(part.get("text"), str):
        out = _indent(_clip(part["text"].strip(), MAX_TEXT).splitlines() or [""], f"{_stamp(ev)}… ", "  ")
    elif kind == "tool_use":
        out = _tool(ev, part)
    elif kind == "error":
        out = _error(ev)
    elif kind == "step_start":
        out = [f"{_stamp(ev)}── step ──"]
    elif kind == "step_finish":
        reason = part.get("reason")
        out = [f"{_stamp(ev)}── step 종료" + (f" ({reason})" if reason else "") + " ──"]
    else:
        out = [f"{_stamp(ev)}? {kind or 'event'}: " + _clip(json.dumps(ev, ensure_ascii=False), MAX_INLINE)]
    return [redact(l) for l in out]
