"""Agent boundary (start/resume/preflight/stop/alive/session_id/exit_code) and the CLI adapters.

Every CLI runs detached in its own process group behind an exit-status wrapper, so a restarted
Supervisor can still tell how it ended. The model and reasoning effort are never left to the CLI's
own settings: every start and every resume receives an explicit `RunSpec`.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
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


PREFLIGHT_PROMPT = "Reply with exactly: OK"
# Every tool is denied for the probe. Verified on opencode 2.0.32 with --standalone: the model gets no tool and nothing runs.
PROBE_PERMISSIONS = '{"permission":{"*":"deny"}}'
PREFLIGHT_PENDING = "추론 수준 확인 중"   # a reason that means "not yet known", not "refused"
PROBE_TIMEOUT = 90


class OpenCodeAdapter(ProcessAdapter):
    name = "opencode"
    capabilities = {"resume": True, "stop": True}

    def __init__(self, binary: str = "opencode", probe_async: bool = True):
        self.binary = binary
        self.probe_async = probe_async   # True: probes and the model listing run in the background, never blocking a tick
        self._probes: dict[str, dict] = {}   # model#variant -> {"done": Event, "problem": str | None}
        self._listing: dict | None = None    # `opencode models`, listed once per Supervisor life
        self._probe_lock = threading.Lock()

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
        listing = self._model_listing(runner, env)
        if not listing["done"].is_set():
            return f"{PREFLIGHT_PENDING} 모델 목록"
        if listing["problem"]:
            return listing["problem"]
        missing = [r.model for r in runs if r.model not in listing["ids"]]
        if missing:
            return f"OpenCode가 지원하지 않는 모델 ID: {', '.join(missing)}"
        for run in runs:
            problem = self._variant_problem(runner, env, run)
            if problem:
                return problem
        return None

    def _model_listing(self, runner, env) -> dict:
        """`opencode models`, listed once per Supervisor life. A slow listing runs in the background, so it never
        holds up a tick; until it finishes the caller gets PREFLIGHT_PENDING."""
        with self._probe_lock:
            if self._listing is None:
                self._listing = {"done": threading.Event(), "ids": set(), "problem": None}
                if self.probe_async:
                    threading.Thread(target=self._list_models, args=(runner, env, self._listing), daemon=True).start()
                else:
                    self._list_models(runner, env, self._listing)
        return self._listing

    def _list_models(self, runner, env, listing) -> None:
        try:
            res = runner.run([self.binary, "models"], env=env, timeout=60)
            if res.ok:
                listing["ids"] = set(res.out.split())
            else:
                listing["problem"] = f"`{self.binary} models` 실행 실패: {res.err.strip()[:200]}"
        except Exception as e:   # any failure is fail-closed
            listing["problem"] = f"`{self.binary} models` 실행 실패: {e}"
        finally:
            listing["done"].set()

    def _variant_problem(self, runner, env, run) -> str | None:
        """Start-time proof that the CLI accepts this model+variant (`--model <id>#<effort>`).

        Each pair is probed once per Supervisor life. While its probe runs this returns a PREFLIGHT_PENDING reason,
        so the caller waits for it on a later tick and the other Lines keep moving.
        """
        key = self.model_arg(run)
        with self._probe_lock:
            probe = self._probes.get(key)
            if probe is None:
                probe = self._probes[key] = {"done": threading.Event(), "problem": None}
                if self.probe_async:
                    threading.Thread(target=self._probe, args=(runner, env, run, probe), daemon=True).start()
                else:
                    self._probe(runner, env, run, probe)
        if not probe["done"].is_set():
            return f"{PREFLIGHT_PENDING} {key}"
        return probe["problem"]

    def _probe(self, runner, env, run, probe) -> None:
        """One short request from an empty directory outside the repository, without `--auto` and without tools.

        The CLI validates the variant before it calls the provider: `Variant unavailable` refuses; an answer or a
        provider error proves it. Anything else (silence, timeout, unreadable output) is not proof and blocks.
        """
        work = Path(tempfile.mkdtemp(prefix="wr-variant-probe-"))
        try:
            res = runner.run([self.binary, "run", "--standalone", "--format", "json", "--title", "WR preflight",
                              "--model", self.model_arg(run), PREFLIGHT_PROMPT],
                             cwd=work, env={**env, "OPENCODE_CONFIG_CONTENT": PROBE_PERMISSIONS},
                             input="", timeout=PROBE_TIMEOUT)
            probe["problem"] = self._probe_outcome(res, run)
        except Exception as e:   # any failure is "not proven"
            probe["problem"] = f"OpenCode가 {run.model}의 추론 수준을 확인하지 못했습니다 ({e}) — 실행하지 않습니다."
        finally:
            shutil.rmtree(work, ignore_errors=True)
            probe["done"].set()

    @staticmethod
    def _probe_outcome(res, run) -> str | None:
        if "Variant unavailable" in (res.out + res.err):
            return f"OpenCode가 {run.model}에서 추론 수준(variant) {run.effort!r}를 지원하지 않습니다 — Start를 차단합니다."
        events = []
        for line in res.out.splitlines():
            try:
                events.append(json.loads(line))
            except ValueError:
                continue
        answered = any(isinstance(e, dict) and e.get("type") == "text" for e in events)
        provider_reached = any(isinstance(e, dict) and e.get("type") == "error"
                               and str((e.get("error") or {}).get("type", "")).startswith("provider.") for e in events)
        if answered or provider_reached:
            return None
        detail = (res.err or res.out).strip()[:200]
        return (f"OpenCode가 {run.model}#{run.effort}의 추론 수준을 확인하지 못했습니다 (exit {res.code}: {detail}) — "
                "검증되지 않은 설정으로 실행하지 않습니다.")


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
