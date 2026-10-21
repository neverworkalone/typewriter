"""Agent boundary (start/resume/preflight/stop/alive/session_id/exit_code) and the CLI adapters.

Every CLI runs detached in its own process group behind an exit-status wrapper, so a restarted
Supervisor can still tell how it ended. The model and reasoning effort are never left to the CLI's
own settings: every start and every resume receives an explicit `RunSpec`.
"""
from __future__ import annotations

import json
import os
import re
import signal
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RunSpec:
    """The model and reasoning effort one run is pinned to; passed explicitly on every launch."""
    model: str
    effort: str


@dataclass
class Handle:
    pid: int
    exit_file: Path
    log_file: Path


class AgentAdapter:
    name = "base"
    capabilities: dict = {}

    def start(self, prompt, cwd, env, run: RunSpec, title, log_file, exit_file) -> Handle: ...
    def resume(self, session_id, prompt, cwd, env, run: RunSpec, log_file, exit_file) -> Handle: ...

    def preflight(self, runner, env, runs: list[RunSpec]) -> str | None:
        """Why this CLI cannot honour these pinned runs as requested, or None. Checked before any process starts."""
        return None

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


class ProcessAdapter(AgentAdapter):
    """Process handling shared by every CLI: detached group, exit wrapper, liveness, stop, log scan."""

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

    def stop(self, pid: int) -> None:
        try:
            os.killpg(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    def alive(self, pid: int) -> bool:
        """True while ANY non-zombie process is left in the run's dedicated process group.

        `pid` is the sh wrapper's PID and also the group id; the wrapper can exit while the
        AI child it launched keeps running, which must still count as alive.
        """
        try:
            os.killpg(pid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            pass  # macOS: a group holding only a zombie reports EPERM; the ps scan decides
        r = subprocess.run(["ps", "-A", "-o", "pgid=,stat="], capture_output=True, text=True)
        for line in r.stdout.splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[0] == str(pid) and not parts[1].startswith("Z"):
                return True
        return False

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


def _pinned(run: RunSpec) -> RunSpec:
    """Refuse to launch without an explicit model and effort (never fall back to a CLI default)."""
    if not run.model or not run.effort:
        raise ValueError("모델과 추론 수준을 명시해야 실행할 수 있습니다.")
    return run


class OpenCodeAdapter(ProcessAdapter):
    name = "opencode"
    capabilities = {"resume": True, "stop": True}

    def __init__(self, binary: str = "opencode"):
        self.binary = binary

    @staticmethod
    def model_arg(run: RunSpec) -> str:
        # The installed CLI has no --variant flag (`opencode run --variant` -> "Unrecognized flag");
        # the reasoning variant is the `#variant` suffix of --model (provider/model#variant).
        return f"{run.model}#{run.effort}"

    def start(self, prompt, cwd, env, run, title, log_file, exit_file):
        cmd = [self.binary, "run", "--auto", "--format", "json", "--title", title,
               "--model", self.model_arg(_pinned(run))]
        return self._spawn(cmd + [prompt], cwd, env, log_file, exit_file)

    def resume(self, session_id, prompt, cwd, env, run, log_file, exit_file):
        cmd = [self.binary, "run", "--auto", "--format", "json", "--session", session_id,
               "--model", self.model_arg(_pinned(run))]
        return self._spawn(cmd + [prompt], cwd, env, log_file, exit_file)

    def preflight(self, runner, env, runs):
        res = runner.run([self.binary, "models"], env=env, timeout=60)
        if not res.ok:
            return f"`{self.binary} models` 실행 실패: {res.err.strip()[:200]}"
        known = set(res.out.split())
        missing = [r.model for r in runs if r.model not in known]
        if missing:
            return f"OpenCode가 지원하지 않는 모델 ID: {', '.join(missing)}"
        return None


# --- failure classification: free-quota exhaustion is the ONLY trigger for Go ---
def classify_failure(log_text: str, quota_patterns: list[str]) -> str:
    """'free_quota' | 'effort' | 'rate_limit' | 'auth' | 'network' | 'unknown'.

    Quota patterns come from config and are checked first; a bare 429 / rate
    limit is never quota exhaustion, and anything unrecognised stays 'unknown'
    so the Supervisor pauses instead of silently moving to paid usage. A model or
    effort the CLI refuses is 'effort': the run stops, nothing is substituted.
    """
    for pat in quota_patterns:
        if re.search(pat, log_text, re.I):
            return "free_quota"
    low = log_text.lower()
    if re.search(r"variant unavailable|unsupported value|supported values are|unsupported (reasoning )?effort", low):
        return "effort"
    if re.search(r"\b429\b|rate.?limit|too many requests", low):
        return "rate_limit"
    if re.search(r"\b401\b|\b403\b|unauthori[sz]ed|invalid api key|authentication", low):
        return "auth"
    if re.search(r"econnreset|etimedout|enotfound|network|socket hang up|connection (refused|reset)", low):
        return "network"
    return "unknown"
