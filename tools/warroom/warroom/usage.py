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
_SUBMIT = re.compile(r"literary-context-cli\.mjs\s+submit\b")


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
    if read is None and write is None:
        return None   # a result without cache fields cannot be priced/compared honestly
    details = u.get("output_tokens_details")
    reason = _count(details.get("thinking_tokens")) if isinstance(details, dict) else None
    if reason is not None and reason > out:
        return None
    return {"input_tokens": fresh + (read or 0) + (write or 0), "cached_input_tokens": read,
            "cache_write_tokens": write, "output_tokens": out, "reasoning_output_tokens": reason}


def parse_usage(log_file) -> dict | None:
    """The run's usage dict (FIELDS -> int | None), or None when the log is unreadable or not a Codex/Claude stream."""
    tokens: dict = {}
    codex = claude = False
    calls: set = set()
    commands: dict = {}      # Claude tool_use id -> command
    failed: set = set()
    seen_usage = False
    try:
        fh = open(log_file, encoding="utf-8", errors="replace")
    except OSError:
        return None
    with fh:
        for line in fh:
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                ev = json.loads(line)
            except ValueError:
                continue
            kind = ev.get("type") if isinstance(ev, dict) else None
            if not isinstance(kind, str):
                continue
            if kind.startswith(("turn.", "item.", "thread.")):
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
    if not (codex or claude):
        return None   # OpenCode and anything unrecognised: usage stays unknown
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
