"""Per-run token / tool-call usage read from ONE run's agent log (Issue #2033).

Every run owns its own log file (a resume starts a new run with a new log), so aggregating a run's log never
counts a resumed or earlier run twice. Nothing is guessed: a value the log does not state stays None (stored as
NULL), never 0, and a malformed usage record makes the token fields unknown instead of partially summed.

Token convention (the same for every adapter, so runs and batches add up):
  input_tokens          all input tokens, cached and cache-write included
  cached_input_tokens   served from cache (Codex `cached_input_tokens`, Claude `cache_read_input_tokens`)
  cache_write_tokens    written to cache (Codex `cache_write_input_tokens`, Claude `cache_creation_input_tokens`)
  output_tokens         all output tokens, reasoning included
  reasoning_output_tokens  the reasoning SUBSET of output_tokens (never added to it again)
"""
from __future__ import annotations

import json
import re

FIELDS = ("input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens",
          "reasoning_output_tokens", "tool_calls", "submit_failures")
_SUBMIT = re.compile(r"(?:literary-context-cli\.mjs\s+submit|d-chunk-cli\.mjs\s+save)\b")


def _count(v):
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def _add(total: dict, key: str, value) -> bool:
    """Accumulate; a missing/invalid part makes the whole field unknown (None) and stays unknown."""
    if key in total and total[key] is None:
        return False
    total[key] = None if value is None else (total.get(key) or 0) + value
    return value is not None


def _codex_usage(u: dict) -> dict | None:
    inp, out = _count(u.get("input_tokens")), _count(u.get("output_tokens"))
    if inp is None or out is None:
        return None
    cached, write, reason = (_count(u.get(k)) for k in
                             ("cached_input_tokens", "cache_write_input_tokens", "reasoning_output_tokens"))
    if reason is not None and reason > out or cached is not None and cached > inp:
        return None   # contradicts "subset" -> do not guess
    return {"input_tokens": inp, "cached_input_tokens": cached, "cache_write_tokens": write,
            "output_tokens": out, "reasoning_output_tokens": reason}


def _claude_usage(u: dict) -> dict | None:
    fresh, read, write, out = (_count(u.get(k)) for k in
                               ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"))
    if fresh is None or out is None:
        return None
    details = u.get("output_tokens_details")
    reason = _count(details.get("thinking_tokens")) if isinstance(details, dict) else None
    if reason is not None and reason > out:
        return None
    # Total input is the sum of three parts: a missing part makes the total unknown (never a part read as 0);
    # the parts that ARE stated are kept.
    total = None if read is None or write is None else fresh + read + write
    return {"input_tokens": total, "cached_input_tokens": read,
            "cache_write_tokens": write, "output_tokens": out, "reasoning_output_tokens": reason}


def _opencode_usage(u: dict) -> dict:
    """Map one OpenCode `step_finish.part.tokens` delta to the shared inclusive token convention."""
    fresh = _count(u.get("input"))
    output = _count(u.get("output"))
    reasoning = _count(u.get("reasoning"))
    cache = u.get("cache")
    cached = _count(cache.get("read")) if isinstance(cache, dict) else None
    write = _count(cache.get("write")) if isinstance(cache, dict) else None
    if output is not None and reasoning is not None and reasoning > output:
        output = reasoning = None
    total_input = fresh + cached + write if fresh is not None and cached is not None and write is not None else None
    return {"input_tokens": total_input, "cached_input_tokens": cached, "cache_write_tokens": write,
            "output_tokens": output, "reasoning_output_tokens": reasoning}


def _opencode_identity(kind: str, ev: dict, part: dict) -> tuple:
    """Prefer the stable OpenCode part identity; use the full event when older payloads omit it."""
    session = ev.get("sessionID") or part.get("sessionID")
    part_id = part.get("id")
    if isinstance(part_id, str) and part_id:
        return (kind, session if isinstance(session, str) else "", part_id)
    return (kind, json.dumps(ev, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def _opencode_step_key(ev: dict, part: dict) -> tuple | None:
    session = ev.get("sessionID") or part.get("sessionID")
    message = part.get("messageID")
    if isinstance(session, str) and session and isinstance(message, str) and message:
        return session, message
    return None


def parse_usage(log_file) -> dict | None:
    """Usage from this run's own Codex, Claude, or OpenCode JSONL log.

    OpenCode `step_finish` values are per-step deltas. Its CLI may omit a final event, so its persisted `usage_quality`
    is always best-effort and becomes incomplete when the observed step lifecycle or trailing JSONL is incomplete.
    """
    tokens: dict = {}
    codex = claude = opencode = False
    calls: set = set()
    commands: dict = {}      # Claude tool_use id -> command
    failed: set = set()
    opencode_tool_calls: set = set()
    opencode_tool_unidentified = False
    opencode_submit: dict = {}
    opencode_events: dict = {}
    opencode_open_steps: dict = {}
    opencode_incomplete = False
    last_nonempty_line_invalid_json = False
    seen_usage = False
    try:
        fh = open(log_file, encoding="utf-8", errors="replace")
    except OSError:
        return None
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                last_nonempty_line_invalid_json = True
                continue
            last_nonempty_line_invalid_json = False
            kind = ev.get("type") if isinstance(ev, dict) else None
            if not isinstance(kind, str):
                continue
            if kind in ("step_start", "step_finish", "text", "reasoning", "tool_use", "error"):
                part = ev.get("part") if isinstance(ev.get("part"), dict) else {}
                if kind == "step_finish" and not opencode:
                    part_id = part.get("id")
                    if (not isinstance(part.get("tokens"), dict)
                            and _opencode_step_key(ev, part) is None
                            and not (isinstance(part_id, str) and part_id)):
                        # A bare finish event without a token payload or lifecycle identity does not
                        # distinguish an OpenCode stream from arbitrary JSONL.
                        continue
                opencode = True
                if kind == "step_start":
                    identity = _opencode_identity(kind, ev, part)
                    if identity not in opencode_events:
                        opencode_events[identity] = None
                        step = _opencode_step_key(ev, part)
                        if step is None:
                            opencode_incomplete = True
                        else:
                            opencode_open_steps[step] = opencode_open_steps.get(step, 0) + 1
                elif kind == "step_finish":
                    identity = _opencode_identity(kind, ev, part)
                    part_tokens = part.get("tokens")
                    fingerprint = json.dumps(part_tokens, sort_keys=True, separators=(",", ":"))
                    if identity in opencode_events:
                        if opencode_events[identity] != fingerprint:
                            opencode_incomplete = True
                            seen_usage = True
                            for key in FIELDS[:5]:
                                _add(tokens, key, None)
                        continue
                    opencode_events[identity] = fingerprint
                    step = _opencode_step_key(ev, part)
                    if step is None or not opencode_open_steps.get(step):
                        opencode_incomplete = True
                    else:
                        opencode_open_steps[step] -= 1
                        if not opencode_open_steps[step]:
                            del opencode_open_steps[step]
                    if isinstance(part_tokens, dict):
                        seen_usage = True
                        usage = _opencode_usage(part_tokens)
                        for key in FIELDS[:5]:
                            _add(tokens, key, usage[key])
                elif kind == "tool_use":
                    call_id = part.get("callID")
                    part_id = part.get("id")
                    identity = call_id if isinstance(call_id, str) and call_id else part_id
                    if not isinstance(identity, str) or not identity:
                        opencode_tool_unidentified = True
                        continue
                    opencode_tool_calls.add(identity)
                    state = part.get("state") if isinstance(part.get("state"), dict) else {}
                    state_input = state.get("input") if isinstance(state.get("input"), dict) else {}
                    command = state_input.get("command")
                    if isinstance(command, str) and _SUBMIT.search(command):
                        status = state.get("status")
                        metadata = state.get("metadata") if isinstance(state.get("metadata"), dict) else {}
                        exit_code = metadata.get("exit")
                        outcome = None
                        if status == "error":
                            outcome = False
                        elif status == "completed" and isinstance(exit_code, int) and not isinstance(exit_code, bool):
                            outcome = exit_code == 0
                        opencode_submit[identity] = outcome
            elif kind.startswith(("turn.", "item.", "thread.")):
                codex = True
                if kind == "turn.completed" and isinstance(ev.get("usage"), dict):
                    seen_usage = True
                    part = _codex_usage(ev["usage"])
                    for k in ("input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens",
                              "reasoning_output_tokens"):
                        _add(tokens, k, None if part is None else part[k])
                elif kind == "item.completed" and isinstance(ev.get("item"), dict):
                    item = ev["item"]
                    if item.get("type") == "command_execution":
                        key = item.get("id") if isinstance(item.get("id"), str) else len(calls)
                        if key not in calls:
                            calls.add(key)
                            code = item.get("exit_code")
                            if (isinstance(item.get("command"), str) and _SUBMIT.search(item["command"])
                                    and isinstance(code, int) and not isinstance(code, bool) and code != 0):
                                failed.add(key)
            elif kind == "result" and "session_id" in ev:
                claude = True
                if isinstance(ev.get("usage"), dict):
                    seen_usage = True
                    part = _claude_usage(ev["usage"])
                    for k in ("input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens",
                              "reasoning_output_tokens"):
                        _add(tokens, k, None if part is None else part[k])
            elif kind in ("assistant", "user", "system") and isinstance(ev.get("message", {}), dict):
                claude = claude or kind != "system" or "session_id" in ev
                content = ev.get("message", {}).get("content")
                for block in content if isinstance(content, list) else []:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_use" and block.get("name") == "Bash" and isinstance(block.get("id"), str):
                        inp = block.get("input")
                        calls.add(block["id"])
                        commands[block["id"]] = inp.get("command") if isinstance(inp, dict) else None
                    elif block.get("type") == "tool_result" and block.get("is_error") is True:
                        cmd = commands.get(block.get("tool_use_id"))
                        if isinstance(cmd, str) and _SUBMIT.search(cmd):
                            failed.add(block["tool_use_id"])
    if opencode:
        if opencode_open_steps or last_nonempty_line_invalid_json:
            opencode_incomplete = True
        out = {k: (tokens.get(k) if seen_usage else None) for k in FIELDS[:5]}
        out["tool_calls"] = None if opencode_tool_unidentified or not opencode_tool_calls else len(opencode_tool_calls)
        if not opencode_submit or any(value is None for value in opencode_submit.values()):
            out["submit_failures"] = None
        else:
            out["submit_failures"] = sum(value is False for value in opencode_submit.values())
        out["usage_quality"] = "incomplete" if opencode_incomplete else "best_effort"
        return out
    if not (codex or claude):
        return None   # Unrecognised stream: usage stays unknown
    out = {k: (tokens.get(k) if seen_usage else None) for k in FIELDS[:5]}
    out["tool_calls"] = len(calls)
    out["submit_failures"] = len(failed)
    return out


def sum_usage(rows) -> dict:
    """Totals over runs (rows with the FIELDS columns). A field is None when NO run knows it; `partial` lists the
    fields where some runs did not report, so the total is a lower bound and must be shown as incomplete."""
    total: dict = {k: None for k in FIELDS}
    partial: list[str] = []
    for k in FIELDS:
        vals = [r[k] for r in rows]
        known = [v for v in vals if v is not None]
        total[k] = sum(known) if known else None
        if known and len(known) != len(vals):
            partial.append(k)
    total["runs"] = len(rows)
    total["partial"] = partial
    qualities = []
    for row in rows:
        try:
            qualities.append(row["usage_quality"])
        except (IndexError, KeyError, TypeError):
            qualities.append(None)
    total["best_effort_runs"] = sum(value in ("best_effort", "incomplete") for value in qualities)
    total["incomplete_runs"] = sum(value == "incomplete" for value in qualities)
    return total


def estimate_cost(usage: dict, pricing: dict | None) -> float | None:
    """USD estimate from `pricing` ({input, cached_input, cache_write, output} per 1M tokens), or None (unknown).

    Unknown when the model has no pricing, a needed rate is missing, or the token counts are unknown/partial.
    A rate that is not needed (the run had no cache writes) may be absent; a missing rate is never read as 0."""
    if not isinstance(pricing, dict) or usage.get("partial"):
        return None
    inp, out = usage.get("input_tokens"), usage.get("output_tokens")
    if inp is None or out is None:
        return None
    cached, write = usage.get("cached_input_tokens"), usage.get("cache_write_tokens")
    if cached is None or write is None or cached + write > inp:
        return None   # the cached/write split is unknown (or contradictory): input has no honest single rate
    parts = [(inp - cached - write, "input"), (cached, "cached_input"), (write, "cache_write"), (out, "output")]
    cost = 0.0
    for n, rate in parts:
        if n == 0:
            continue
        price = pricing.get(rate)
        if isinstance(price, bool) or not isinstance(price, (int, float)) or price < 0:
            return None
        cost += n * price / 1_000_000
    return cost


def pricing_problems(pricing) -> list[str]:
    """Config problems of the optional `pricing` table ({model: {rate: USD per 1M tokens}})."""
    if pricing is None:
        return []
    if not isinstance(pricing, dict):
        return ["pricing은 {모델 ID: 단가 객체} 형태여야 합니다"]
    bad = []
    for model, rates in pricing.items():
        if not isinstance(rates, dict):
            bad.append(f"pricing.{model}는 객체여야 합니다")
            continue
        for k, v in rates.items():
            if k not in ("input", "cached_input", "cache_write", "output"):
                bad.append(f"pricing.{model}.{k}는 알 수 없는 단가 항목입니다")
            elif isinstance(v, bool) or not isinstance(v, (int, float)) or v < 0 or v != v or v == float("inf"):
                bad.append(f"pricing.{model}.{k}는 0 이상의 숫자여야 합니다")
    return bad
