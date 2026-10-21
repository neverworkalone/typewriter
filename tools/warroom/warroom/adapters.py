"""Minimal agent boundary (start/resume/stop/events/capabilities) + OpenCode."""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass
class Handle:
    pid: int
    exit_file: Path
    log_file: Path


class AgentAdapter:
    name = "base"
    capabilities: dict = {}

    def start(self, prompt, cwd, env, model, title, log_file, exit_file) -> Handle: ...
    def resume(self, session_id, prompt, cwd, env, model, log_file, exit_file) -> Handle: ...
    def stop(self, pid: int) -> None: ...
    def alive(self, pid: int) -> bool: ...
    def session_id(self, log_file: Path) -> str | None: ...
    def exit_code(self, exit_file: Path) -> int | None: ...


_SESSION = re.compile(r"\bses_[A-Za-z0-9]+")


def _ids_in(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in ("sessionID", "sessionId", "session_id") and isinstance(v, str):
                yield v
            else:
                yield from _ids_in(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _ids_in(v)


class OpenCodeAdapter(AgentAdapter):
    name = "opencode"
    capabilities = {"resume": True, "stop": True}

    def __init__(self, binary: str = "opencode"):
        self.binary = binary

    def _spawn(self, cmd: list[str], cwd, env, log_file: Path, exit_file: Path) -> Handle:
        log_file, exit_file = Path(log_file), Path(exit_file)
        log_file.parent.mkdir(parents=True, exist_ok=True)
        exit_file.unlink(missing_ok=True)
        # The wrapper records the exit status so a restarted Supervisor can still
        # learn how the (detached) child ended.
        wrapper = ['"$@"', "echo $? > \"$WARROOM_EXIT_FILE\""]
        env = {**env, "WARROOM_EXIT_FILE": str(exit_file)}
        with open(log_file, "ab") as log:
            p = subprocess.Popen(["/bin/sh", "-c", "; ".join(wrapper), "sh", *cmd],
                                 cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                 stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        return Handle(p.pid, exit_file, log_file)

    def start(self, prompt, cwd, env, model, title, log_file, exit_file):
        cmd = [self.binary, "run", "--auto", "--format", "json", "--title", title]
        if model:
            cmd += ["--model", model]
        return self._spawn(cmd + [prompt], cwd, env, log_file, exit_file)

    def resume(self, session_id, prompt, cwd, env, model, log_file, exit_file):
        cmd = [self.binary, "run", "--auto", "--format", "json", "--session", session_id]
        if model:
            cmd += ["--model", model]
        return self._spawn(cmd + [prompt], cwd, env, log_file, exit_file)

    def stop(self, pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def alive(self, pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        # A zombie child of this process is not alive.
        r = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
        return bool(r.stdout.strip()) and not r.stdout.strip().startswith("Z")

    def session_id(self, log_file: Path) -> str | None:
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")
        except OSError:
            return None
        for line in text.splitlines():
            try:
                for sid in _ids_in(json.loads(line)):
                    return sid
            except ValueError:
                m = _SESSION.search(line)
                if m:
                    return m.group(0)
        return None

    def exit_code(self, exit_file: Path) -> int | None:
        try:
            return int(Path(exit_file).read_text().strip())
        except (OSError, ValueError):
            return None


# --- failure classification: free-quota exhaustion is the ONLY trigger for Go ---
def classify_failure(log_text: str, quota_patterns: list[str]) -> str:
    """'free_quota' | 'rate_limit' | 'auth' | 'network' | 'unknown'.

    Quota patterns come from config and are checked first; a bare 429 / rate
    limit is never quota exhaustion, and anything unrecognised stays 'unknown'
    so the Supervisor pauses instead of silently moving to paid usage.
    """
    for pat in quota_patterns:
        if re.search(pat, log_text, re.I):
            return "free_quota"
    low = log_text.lower()
    if re.search(r"\b429\b|rate.?limit|too many requests", low):
        return "rate_limit"
    if re.search(r"\b401\b|\b403\b|unauthori[sz]ed|invalid api key|authentication", low):
        return "auth"
    if re.search(r"econnreset|etimedout|enotfound|network|socket hang up|connection (refused|reset)", low):
        return "network"
    return "unknown"
