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
import shlex
from pathlib import Path

FIELDS = ("input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens",
          "reasoning_output_tokens", "tool_calls", "submit_failures")
_SUBMIT = re.compile(r"(?:literary-context-cli\.mjs\s+submit|d-chunk-cli\.mjs\s+save)\b")
_C_SUBMIT = re.compile(r"literary-context-cli\.mjs\s+submit\b")
_C_DIAGNOSTIC = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
_C_SUBMIT_FILE_WRITE = re.compile(r"cat\s+>\s+['\"]?\.warroom-scratch/c-chunk-\d{3}\.submit\.json")


def submit_attempts(log_file) -> int | None:
    """Count official C submit invocations in one completed adapter log; unknown log formats stay unknown."""
    try:
        text = Path(log_file).read_text("utf-8", errors="replace")
    except OSError:
        return None

    recognized = False
    attempts: set[str] = set()
    for line_no, line in enumerate(text.splitlines()):
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind in ("thread.started", "turn.started", "turn.completed", "turn.failed"):
            recognized = True
        elif kind == "result" and isinstance(event.get("session_id"), str):
            recognized = True
        elif kind in ("assistant", "user", "system") and isinstance(event.get("message"), dict):
            recognized = True
            blocks = event["message"].get("content")
            for block in blocks if isinstance(blocks, list) else []:
                if not isinstance(block, dict) or block.get("type") != "tool_use" or block.get("name") != "Bash":
                    continue
                command = block.get("input", {}).get("command") if isinstance(block.get("input"), dict) else None
                identity = block.get("id")
                if isinstance(command, str) and _C_SUBMIT.search(command):
                    attempts.add(identity if isinstance(identity, str) and identity else f"claude:{line_no}")
        elif kind in ("item.started", "item.completed") and isinstance(event.get("item"), dict):
            recognized = True
            item = event["item"]
            if item.get("type") != "command_execution":
                continue
            command, identity = item.get("command"), item.get("id")
            if isinstance(command, str) and _C_SUBMIT.search(command):
                attempts.add(identity if isinstance(identity, str) and identity else f"codex:{line_no}")
        elif kind == "tool_use":
            recognized = True
            part = event.get("part") if isinstance(event.get("part"), dict) else {}
            state = part.get("state") if isinstance(part.get("state"), dict) else {}
            command = (state.get("input", {}).get("command")
                       if isinstance(state.get("input"), dict) else None)
            identity = part.get("callID") or part.get("id")
            if isinstance(command, str) and _C_SUBMIT.search(command):
                attempts.add(identity if isinstance(identity, str) and identity else f"opencode:{line_no}")
        elif kind == "step_start" or kind in ("text", "reasoning", "error"):
            recognized = True
        elif kind == "step_finish":
            part = event.get("part") if isinstance(event.get("part"), dict) else {}
            if (not recognized and not isinstance(part.get("tokens"), dict)
                    and not isinstance(part.get("id"), str)
                    and not (isinstance(event.get("sessionID"), str)
                             and isinstance(part.get("messageID"), str))):
                continue
            recognized = True

    return len(attempts) if recognized else None


def _c_cli_tokens(command: object, *, expected_cli_path, command_cwd) -> list[str] | None:
    if not isinstance(command, str):
        return None
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return None
    if (len(tokens) == 3 and Path(tokens[0]).name in {"bash", "sh", "zsh"}
            and tokens[1] in ("-c", "-lc")):
        return _c_cli_tokens(tokens[2], expected_cli_path=expected_cli_path, command_cwd=command_cwd)
    if (len(tokens) < 3 or Path(tokens[0]).name != "node" or not tokens[2]
            or any(token in {";", "&&", "||", "|", "&"} for token in tokens)):
        return None
    if not _c_script_matches(tokens[1], expected_cli_path=expected_cli_path, command_cwd=command_cwd):
        return None
    return tokens


def _c_script_matches(script_arg: str, *, expected_cli_path, command_cwd) -> bool:
    script = Path(script_arg)
    if not script.is_absolute():
        script = Path(command_cwd) / script
    try:
        return script.resolve(strict=True) == Path(expected_cli_path).resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return False


def _c_option_value(tokens: list[str], name: str) -> str | None:
    matches = []
    for index, token in enumerate(tokens[3:], 3):
        if token == name:
            if index + 1 >= len(tokens):
                return None
            matches.append(tokens[index + 1])
        elif token.startswith(name + "="):
            matches.append(token[len(name) + 1:])
    return matches[0] if len(matches) == 1 and matches[0] else None


def _c_checkpoint_matches(raw_path: str | None, expected_path, command_cwd) -> bool:
    if raw_path is None:
        return False
    actual, expected = Path(raw_path), Path(expected_path)
    if not actual.is_absolute():
        actual = Path(command_cwd) / actual
    if not expected.is_absolute():
        expected = Path(command_cwd) / expected
    try:
        return actual.resolve() == expected.resolve()
    except (OSError, RuntimeError, ValueError):
        return False


_CHECKPOINT_MUTATING_C_COMMANDS = {"init", "chunk", "submit", "add-form", "clear-candidates"}
_READ_ONLY_C_COMMANDS = {"preflight", "report", "export", "validate"}


def _c_unparsed_checkpoint_mutation(command: object, *, expected_cli_path, command_cwd) -> bool:
    """Fail closed on shell-composed or unresolved invocations that could mutate the official CLI checkpoint."""
    if not isinstance(command, str):
        return False
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return str(expected_cli_path) in command
    if (len(tokens) == 3 and Path(tokens[0]).name in {"bash", "sh", "zsh"}
            and tokens[1] in ("-c", "-lc")):
        return _c_unparsed_checkpoint_mutation(tokens[2], expected_cli_path=expected_cli_path,
                                               command_cwd=command_cwd)
    for index, token in enumerate(tokens[:-2]):
        if Path(token).name != "node":
            continue
        script, operation = tokens[index + 1], tokens[index + 2]
        if operation in _READ_ONLY_C_COMMANDS:
            continue
        if operation not in _CHECKPOINT_MUTATING_C_COMMANDS:
            continue
        if _c_script_matches(script, expected_cli_path=expected_cli_path, command_cwd=command_cwd):
            return True
        if "$" in script or "${" in script:
            return True
    return False


def _c_chunk_scope_request(tokens: list[str]) -> dict | None:
    """Safe task-scope facts from one exact official C `chunk` invocation, if its args are unambiguous."""
    if len(tokens) < 3 or tokens[2] != "chunk":
        return None
    chunk = _c_option_value(tokens, "--chunk")
    raw_ids = _c_option_value(tokens, "--sense-ids")
    if chunk is None or not re.fullmatch(r"\d{1,6}", chunk) or int(chunk) < 1 or raw_ids is None:
        return None
    sense_ids = raw_ids.split(",")
    if (not sense_ids or len(set(sense_ids)) != len(sense_ids)
            or any(not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}", sense_id) for sense_id in sense_ids)):
        return None
    return {"chunk_no": int(chunk), "sense_ids": sense_ids}


def _c_cli_output_text(value: object) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "\n".join(
            item if isinstance(item, str) else item.get("text", "")
            for item in value
            if isinstance(item, str) or isinstance(item, dict) and isinstance(item.get("text"), str)
        )
    return ""


def _c_stop_diagnostic(operation: str, output: object) -> dict | None:
    for line in _c_cli_output_text(output).splitlines():
        try:
            result = json.loads(line)
        except ValueError:
            continue
        if not isinstance(result, dict):
            continue
        if result.get("status") == "OUTPUT_LIMIT":
            return {"operation": operation, "diagnostic": "output_limit"}
        if result.get("status") != "FAILED" or result.get("repair_scope") != "stop_and_report":
            continue
        diagnostic = result.get("diagnostic")
        if isinstance(diagnostic, str) and _C_DIAGNOSTIC.fullmatch(diagnostic):
            safe = {"operation": operation, "diagnostic": diagnostic}
            if diagnostic == "chunk_scope" and result.get("code") == "LITERARY_CHUNK_SCOPE":
                safe["error_code"] = "LITERARY_CHUNK_SCOPE"
            return safe
    return None


def _c_write_failure(command: object, output: object, *, exit_code=None, tool_error=False) -> dict | None:
    if (not isinstance(command, str) or not _C_SUBMIT_FILE_WRITE.search(command)
            or "echo WRITE_FAILED" not in command or "exit 90" not in command
            or not (exit_code == 90 or tool_error)):
        return None
    if any(line.strip() == "WRITE_FAILED" for line in _c_cli_output_text(output).splitlines()):
        return {"operation": "submit_write", "diagnostic": "write_failed"}
    return None


def official_c_stop_diagnostics(log_file, *, expected_cli_path=None, command_cwd=None,
                                expected_checkpoint_path=None, command_facts: list[dict] | None = None) -> list[dict]:
    """Read command-bound C stop evidence from the configured CLI and prompted write-failure wrapper.

    Codex records command and output together, Claude pairs Bash tool calls with their tool results, and OpenCode
    records the command result in the completed tool state. CLI output counts only when its command resolves to the
    exact script path used by the Supervisor; assistant prose never counts. Optional `command_facts` records only
    checkpoint-mutating operations and whether their `--checkpoint` resolved to the expected active checkpoint.
    """
    if (not isinstance(log_file, (str, Path)) or not isinstance(expected_cli_path, (str, Path))
            or not isinstance(command_cwd, (str, Path))):
        return []
    try:
        lines = Path(log_file).read_text("utf-8", errors="replace").splitlines()
    except OSError:
        return []

    diagnostics: list[dict] = []
    seen: set[tuple[str, str]] = set()
    indexes: dict[tuple[str, str], int] = {}
    commands: dict[str, str] = {}

    def add(command: object, output: object, *, exit_code=None, tool_error=False) -> None:
        tokens = _c_cli_tokens(command, expected_cli_path=expected_cli_path, command_cwd=command_cwd)
        operation = tokens[2] if tokens is not None else None
        if (command_facts is not None and tokens is not None
                and operation in _CHECKPOINT_MUTATING_C_COMMANDS):
            fact = {"operation": operation}
            if expected_checkpoint_path is not None:
                fact["checkpoint_matches"] = _c_checkpoint_matches(
                    _c_option_value(tokens, "--checkpoint"), expected_checkpoint_path, command_cwd)
            if operation == "chunk":
                request = _c_chunk_scope_request(tokens)
                if request is not None:
                    fact.update(request)
            command_facts.append(fact)
        elif (command_facts is not None and tokens is None
              and _c_unparsed_checkpoint_mutation(command, expected_cli_path=expected_cli_path,
                                                  command_cwd=command_cwd)):
            command_facts.append({"operation": "unparsed_checkpoint_mutation", "checkpoint_matches": False})
        result = (_c_stop_diagnostic(operation, output) if operation is not None else None)
        if result is None:
            result = _c_write_failure(command, output, exit_code=exit_code, tool_error=tool_error)
        if result is None:
            return
        key = (result["operation"], result["diagnostic"])
        if key in seen:
            if key == ("chunk", "chunk_scope"):
                diagnostics[indexes[key]]["occurrences"] += 1
            return
        seen.add(key)
        if key == ("chunk", "chunk_scope"):
            result["occurrences"] = 1
            if tokens is not None:
                request = _c_chunk_scope_request(tokens)
                if request is not None:
                    result.update(request)
        indexes[key] = len(diagnostics)
        diagnostics.append(result)

    for line in lines:
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        item = event.get("item") if isinstance(event.get("item"), dict) else {}
        if kind == "item.completed" and item.get("type") == "command_execution":
            output = item.get("aggregated_output")
            if output is None:
                output = item.get("output")
            add(item.get("command"), output,
                exit_code=item.get("exit_code"))
        elif kind in ("assistant", "user", "system"):
            message = event.get("message") if isinstance(event.get("message"), dict) else {}
            blocks = message.get("content")
            for block in blocks if isinstance(blocks, list) else []:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use" and block.get("name") == "Bash":
                    tool_id = block.get("id")
                    inp = block.get("input") if isinstance(block.get("input"), dict) else {}
                    if isinstance(tool_id, str) and isinstance(inp.get("command"), str):
                        commands[tool_id] = inp["command"]
                elif block.get("type") == "tool_result":
                    tool_id = block.get("tool_use_id")
                    add(commands.get(tool_id) if isinstance(tool_id, str) else None, block.get("content"),
                        tool_error=block.get("is_error") is True)
        elif kind == "tool_use":
            part = event.get("part") if isinstance(event.get("part"), dict) else {}
            state = part.get("state") if isinstance(part.get("state"), dict) else {}
            inp = state.get("input") if isinstance(state.get("input"), dict) else {}
            output = state.get("output")
            if output is None:
                metadata = state.get("metadata") if isinstance(state.get("metadata"), dict) else {}
                output = metadata.get("output")
            metadata = state.get("metadata") if isinstance(state.get("metadata"), dict) else {}
            if state.get("status") in ("completed", "error"):
                add(inp.get("command"), output, exit_code=metadata.get("exit"),
                    tool_error=state.get("status") == "error")

    return diagnostics


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
