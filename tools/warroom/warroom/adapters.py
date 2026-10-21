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
    requires_session_for_pr = False   # True: a PR is taken over from a live run only after the CLI reported its session
    requires_final_result_for_pr = False   # True: a PR is taken over only after the run exited and its result was verified

    def start(self, prompt, cwd, env, run: RunSpec, title, log_file, exit_file) -> Handle: ...
    def resume(self, session_id, prompt, cwd, env, run: RunSpec, log_file, exit_file) -> Handle: ...

    def preflight(self, runner, env, runs: list[RunSpec]) -> str | None:
        """Why this CLI cannot honour these pinned runs as requested, or None. Checked before any process starts."""
        return None

    def run_problem(self, log_file: Path, run: RunSpec | None, expected_session: str | None) -> tuple[str, str] | None:
        """What the CLI reports about this run contradicts its pins: (state, reason), or None.

        Checked on every poll, so a wrong model or session is stopped before it can open a PR.
        """
        return None

    def completion_problem(self, log_file: Path, run: RunSpec | None, expected_session: str | None,
                           cwd=None, env=None) -> tuple[str, str] | None:
        """Why a run that exited 0 must not be accepted as finished (no PR intake), or None.

        Checked once the process has exited successfully, before its result is used. The mid-run check is
        `run_problem`; this one requires the evidence that the run's own work was recorded.
        """
        return None

    def policy_refusal(self, log_file: Path) -> str | None:
        """A reason when the CLI's own policy refused an action (seen in the log), or None. Used when a run ended
        without its result (no PR): such a run is PAUSED for the operator instead of counted as a plain error."""
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


# Permissions are the operator's own local Claude settings (~/.claude/settings.json, project settings), applied by
# the CLI's own precedence. War Room passes no permission option: no allowlist, no permission mode, no bypass.
# A tool the local settings do not allow is denied by the CLI and reported in `permission_denials`, which stops
# the run in PAUSED (see run_problem). Model, effort and the session are the only things War Room pins.
CLAUDE_REQUIRED_FLAGS = ("--model", "--effort", "--resume", "--name", "--output-format", "stream-json")
_CLAUDE_EFFORT_FALLBACK = "ignoring it and using the default effort"   # the CLI's own warning for an unknown --effort


def _json_objects(text: str):
    for line in text.splitlines():
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if isinstance(o, dict):
            yield o


class ClaudeCodeAdapter(ProcessAdapter):
    """Claude Code (`claude -p --output-format stream-json`). Model and effort are passed on every launch."""
    name = "claude"
    capabilities = {"resume": True, "stop": True}
    requires_session_for_pr = True
    requires_final_result_for_pr = True   # its final denials and session are verified only at exit (run_problem/completion)

    def __init__(self, binary: str = "claude"):
        self.binary = binary

    @staticmethod
    def _pins(run: RunSpec) -> list[str]:
        return ["--model", run.model, "--effort", run.effort, "--output-format", "stream-json", "--verbose"]

    def start(self, prompt, cwd, env, run, title, log_file, exit_file):
        cmd = [self.binary, "-p", prompt, *self._pins(_pinned(run)), "--name", title]
        return self._spawn(cmd, cwd, env, log_file, exit_file)

    def resume(self, session_id, prompt, cwd, env, run, log_file, exit_file):
        cmd = [self.binary, "-p", prompt, "--resume", session_id, *self._pins(_pinned(run))]
        return self._spawn(cmd, cwd, env, log_file, exit_file)

    def preflight(self, runner, env, runs):
        v = runner.run([self.binary, "--version"], env=env, timeout=60)
        if not v.ok:
            return f"`{self.binary} --version` 실행 실패: {v.err.strip()[:200]}"
        h = runner.run([self.binary, "--help"], env=env, timeout=60)
        if not h.ok:
            return f"`{self.binary} --help` 실행 실패: {h.err.strip()[:200]}"
        missing = [f for f in CLAUDE_REQUIRED_FLAGS if f not in h.out]
        if missing:
            return f"설치된 Claude Code CLI({v.out.strip()})가 필요한 옵션을 지원하지 않습니다: {', '.join(missing)}"
        a = runner.run([self.binary, "auth", "status"], env=env, timeout=60)
        if not a.ok or not _logged_in(a.out):
            return "Claude CLI가 로그인되어 있지 않습니다 (`claude auth login`)."
        for run in runs:   # an environment override would decide the effective value instead of the pin
            for name, value in (("ANTHROPIC_MODEL", run.model), ("CLAUDE_CODE_EFFORT_LEVEL", run.effort)):
                if env.get(name) and env[name] != value:
                    return f"환경 변수 {name}={env[name]!r}가 실행 설정 {value!r}을 덮어씁니다 — 해제한 뒤 실행하세요."
        return None

    def run_problem(self, log_file, run, expected_session):
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")
        except OSError:
            return None
        if _CLAUDE_EFFORT_FALLBACK in text:   # the CLI would run at its default effort: never accept that
            return ("ERROR", "CLI가 추론 수준을 인식하지 못해 기본값으로 실행하려 했습니다 — 다른 값으로 대체하지 않습니다.")
        init = result = None
        for o in _json_objects(text):
            if o.get("type") == "system" and o.get("subtype") == "init" and init is None:
                init = o
            elif o.get("type") == "result":
                result = o
        if init is None:
            if result is not None:   # the run ended without ever reporting its session: nothing to verify it by
                return ("ERROR", "CLI가 세션 ID를 보고하지 않고 끝났습니다 — 세션을 확인하지 못해 PR을 인정하지 않습니다.")
            return None   # not started yet
        session = init.get("session_id")
        if not isinstance(session, str) or not session.strip():   # absent, empty or not a string: fail closed
            return ("ERROR", "CLI가 세션 ID를 보고하지 않았습니다(없음·빈 값·형식 오류) — 중지하고 보존합니다.")
        if expected_session and session != expected_session:
            return ("ERROR", f"세션 ID 불일치: 요청 {expected_session}, 실제 {session} — 중지하고 보존합니다.")
        reported = str(init.get("model") or "")
        if not reported:
            return ("ERROR", "CLI가 실행 모델을 보고하지 않아 요청한 모델로 실행됐는지 확인할 수 없습니다.")
        if run and run.model.lower() not in reported.lower():
            return ("ERROR", f"CLI가 보고한 모델 {reported!r}이 요청한 {run.model!r}과 다릅니다 — 중지합니다.")
        if result is not None and result.get("permission_denials"):
            names = sorted({str(d.get("tool_name")) for d in result["permission_denials"] if isinstance(d, dict)})
            return ("PAUSED", f"로컬 CLI 권한 정책상 거부되어 실행이 불완전합니다 (도구: {', '.join(names)}). "
                              "자동 권한 상승 없이 중지합니다. 로컬 Claude 설정을 직접 확인한 뒤 Retry 하세요 "
                              "(worktree·PR·세션 보존).")
        return None

    def completion_problem(self, log_file, run, expected_session, cwd=None, env=None):
        """An exited run is accepted only if its init event reported its own session. An empty log, or one with no
        parsable event, has no session and is refused (run_problem alone treats a run with no events as not started)."""
        problem = self.run_problem(log_file, run, expected_session)
        if problem:
            return problem
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")
        except OSError:
            return ("ERROR", "실행 로그를 읽을 수 없어 완료를 확인하지 못했습니다.")
        init = next((o for o in _json_objects(text) if o.get("type") == "system" and o.get("subtype") == "init"), None)
        if init is None:
            return ("ERROR", "CLI가 세션 ID를 보고하지 않고 끝났습니다 — 세션을 확인하지 못해 PR을 인정하지 않습니다.")
        return None


# Codex runs under the operator's own local CLI policy: its config, sandbox, approval and execpolicy rules are used
# as they are. War Room pins only the model and the reasoning effort (on every launch, first run and resume alike)
# and checks what Codex actually did: the thread id, the recorded model and effort. It never overrides sandbox,
# approval, network or writable roots. A command the local policy denies stops the run in PAUSED, nothing is retried.
CODEX_REQUIRED_EXEC_FLAGS = ("--json", "--model", "--config")
CODEX_REQUIRED_RESUME_FLAGS = ("resume", "--json", "--model")
_CODEX_DENIED = re.compile(r"operation not permitted|permission denied|requires approval|approval required|"
                           r"blocked by (the )?(sandbox|policy)|not allowed by (the )?(sandbox|policy)", re.I)


_THREAD_ID = re.compile(r"[0-9A-Za-z][0-9A-Za-z_-]*")


def _valid_thread(value) -> bool:
    """A usable Codex thread id: a non-empty plain token (never empty, non-string or containing glob/path characters)."""
    return isinstance(value, str) and _THREAD_ID.fullmatch(value) is not None


def _turn_contexts(thread_id: str) -> list[dict]:
    """What Codex recorded for each turn of a thread: the effective model, effort and policy (rollout file)."""
    if not _valid_thread(thread_id):   # an empty/odd id must never widen the rollout search to other sessions
        return []
    home = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
    files = list((home / "sessions").glob(f"*/*/*/rollout-*{thread_id}.jsonl"))
    if not files:
        return []
    out = []
    for o in _json_objects(files[0].read_text("utf-8", errors="replace")):
        if o.get("type") == "turn_context" and isinstance(o.get("payload"), dict):
            out.append(o["payload"])
    return out


def _baseline_path(log_file) -> Path:
    return Path(str(log_file) + ".baseline.json")


def _baseline(log_file) -> tuple[str | None, int]:
    """(thread, turns) recorded when a resume started; (None, 0) for a fresh start (every turn is then this run's)."""
    try:
        data = json.loads(_baseline_path(log_file).read_text("utf-8"))
        return str(data["thread"]), int(data["turns"])
    except (OSError, ValueError, KeyError, TypeError):
        return None, 0


def _run_contexts(log_file, thread: str) -> list[dict]:
    """The turn records written by this run only: the thread's records after the baseline."""
    _, turns = _baseline(log_file)
    return _turn_contexts(thread)[turns:]


_NONZERO_EXIT = re.compile(r"exit\s*code\D{0,12}?[1-9]\d*|exit\s+[1-9]\d*", re.I)


class CodexCLIAdapter(ProcessAdapter):
    """Codex CLI (`codex exec --json`, `codex exec resume <thread id>`). Model and effort pinned on every launch."""
    name = "codex"
    capabilities = {"resume": True, "stop": True}
    requires_session_for_pr = True
    requires_final_result_for_pr = True   # a PR is taken over only after the run exited and its final result was checked

    def __init__(self, binary: str = "codex"):
        self.binary = binary

    @staticmethod
    def _pins(run: RunSpec) -> list[str]:
        return ["--json", "-m", run.model, "-c", f"model_reasoning_effort={run.effort}"]

    def start(self, prompt, cwd, env, run, title, log_file, exit_file):
        cmd = [self.binary, "exec", *self._pins(_pinned(run)), prompt]
        return self._spawn(cmd, cwd, env, log_file, exit_file)

    def resume(self, session_id, prompt, cwd, env, run, log_file, exit_file):
        cmd = [self.binary, "exec", "resume", session_id, *self._pins(_pinned(run)), prompt]
        # The turns recorded before this run: only turns after this baseline belong to this run.
        Path(log_file).parent.mkdir(parents=True, exist_ok=True)
        _baseline_path(log_file).write_text(json.dumps({"thread": session_id,
                                                         "turns": len(_turn_contexts(session_id))}))
        return self._spawn(cmd, cwd, env, log_file, exit_file)

    def session_id(self, log_file):
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")
        except OSError:
            return None
        for o in _json_objects(text):
            if o.get("type") == "thread.started" and _valid_thread(o.get("thread_id")):
                return o["thread_id"]
        return None

    def preflight(self, runner, env, runs):
        v = runner.run([self.binary, "--version"], env=env, timeout=60)
        if not v.ok:
            return f"`{self.binary} --version` 실행 실패: {v.err.strip()[:200]}"
        h = runner.run([self.binary, "exec", "--help"], env=env, timeout=60)
        if not h.ok:
            return f"`{self.binary} exec --help` 실행 실패: {h.err.strip()[:200]}"
        missing = [f for f in CODEX_REQUIRED_EXEC_FLAGS if f not in h.out]
        r = runner.run([self.binary, "exec", "resume", "--help"], env=env, timeout=60)
        if not r.ok:
            return f"`{self.binary} exec resume --help` 실행 실패: {r.err.strip()[:200]}"
        missing += [f for f in CODEX_REQUIRED_RESUME_FLAGS if f not in r.out]
        if missing:
            return f"설치된 Codex CLI({v.out.strip()})가 필요한 옵션을 지원하지 않습니다: {', '.join(sorted(set(missing)))}"
        lg = runner.run([self.binary, "login", "status"], env=env, timeout=60)
        if not lg.ok or not (lg.out + lg.err).strip().lower().startswith("logged in"):
            return "Codex CLI가 로그인되어 있지 않습니다 (`codex login`)."
        return None

    def policy_refusal(self, log_file):
        """A refusal the local policy actually produced: a command that failed with a refusal message, or the agent
        reporting such a failure with a non-zero exit. Output of a command that succeeded never counts."""
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")
        except OSError:
            return None
        for e in _json_objects(text):
            item = e.get("item") if isinstance(e.get("item"), dict) else {}
            if e.get("type") != "item.completed":
                continue
            if item.get("type") == "command_execution" and item.get("exit_code") not in (0, None):
                if _CODEX_DENIED.search(str(item.get("aggregated_output") or "")):
                    return f"로컬 Codex 정책이 명령을 거부했습니다 ({str(item.get('command') or 'command')[:160]})"
            if item.get("type") == "agent_message":
                msg = str(item.get("text") or "")
                if _CODEX_DENIED.search(msg) and _NONZERO_EXIT.search(msg):
                    return "로컬 Codex 정책이 명령을 거부한 것으로 보고되었습니다"
        return None

    def completion_problem(self, log_file, run, expected_session, cwd=None, env=None):
        """A run that exited 0 is accepted only with its own thread id and the turn record of this run."""
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")
        except OSError:
            return ("ERROR", "실행 로그를 읽을 수 없어 완료를 확인하지 못했습니다.")
        events = list(_json_objects(text))
        started = next((e for e in events if e.get("type") == "thread.started"), None)
        if started is None:
            return ("ERROR", "세션(thread) ID가 기록되지 않은 실행은 완료로 인정하지 않습니다 — PR이 있어도 중지하고 보존합니다.")
        thread = started.get("thread_id")
        if not _valid_thread(thread):
            return ("ERROR", "thread.started의 thread_id가 없거나 비어 있거나 형식이 올바르지 않습니다 — 중지하고 보존합니다.")
        if expected_session and thread != expected_session:
            return ("ERROR", f"세션 ID 불일치: 요청 {expected_session}, 실제 {thread} — 중지하고 보존합니다.")
        base_thread, _ = _baseline(log_file)
        if base_thread and thread != base_thread:
            return ("ERROR", f"재개가 다른 세션 {thread}으로 진행되었습니다 (요청 {base_thread}) — 중지합니다.")
        # The log belongs to this run alone (one file per launch), so its terminal events are this run's result.
        failed = next((e for e in events if e.get("type") == "turn.failed"), None)
        if failed is not None:
            err = failed.get("error")
            err = err.get("message") if isinstance(err, dict) else err
            return ("ERROR", f"Codex 턴이 실패로 끝났습니다 (turn.failed: {str(err or '사유 없음')[:200]}) — "
                             "exit 0이어도 완료로 인정하지 않고 보존합니다.")
        if not any(e.get("type") == "turn.completed" for e in events):
            return ("ERROR", "이번 실행의 turn.completed가 기록되지 않았습니다 (중단되었거나 잘린 로그) — "
                             "exit 0이어도 완료로 인정하지 않고 보존합니다.")
        new = _run_contexts(log_file, thread)
        if not new:
            return ("ERROR", "이번 실행의 턴 기록(turn_context)이 없어 실제 모델·추론 수준을 확인할 수 없습니다 "
                             "(과거 턴 기록으로 대신하지 않음).")
        for ctx in new:
            if run is not None and ctx.get("model") != run.model:
                return ("ERROR", f"Codex가 실행한 모델 {ctx.get('model')!r}이 요청한 {run.model!r}과 다릅니다 — 중지합니다.")
            if run is not None and ctx.get("effort") != run.effort:
                return ("ERROR", f"Codex가 실행한 추론 수준 {ctx.get('effort')!r}이 요청한 {run.effort!r}과 다릅니다 — 중지합니다.")
        return None

    def run_problem(self, log_file, run, expected_session, cwd=None, env=None):
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")
        except OSError:
            return None
        events = list(_json_objects(text))
        started = next((e for e in events if e.get("type") == "thread.started"), None)
        if started is None:   # not started yet
            return None
        thread = started.get("thread_id")
        if not _valid_thread(thread):
            return ("ERROR", "thread.started의 thread_id가 없거나 비어 있거나 형식이 올바르지 않습니다 — 중지하고 보존합니다.")
        if expected_session and thread != expected_session:
            return ("ERROR", f"세션 ID 불일치: 요청 {expected_session}, 실제 {thread} — "
                             "새 세션으로 진행된 것으로 보고 중지합니다.")
        denied = _denied_command(events)
        if denied:   # the local policy refused a command (or asked for approval): stop, keep everything, wait for the operator
            return ("PAUSED", f"로컬 Codex 정책이 명령을 거부했습니다 ({denied}). 자동 권한 상승 없이 중지합니다. "
                              "로컬 설정을 확인한 뒤 Retry 하세요 (worktree·브랜치·PR·세션 보존).")
        base_thread, _ = _baseline(log_file)
        if base_thread and thread != base_thread:
            return ("ERROR", f"재개가 다른 세션 {thread}으로 진행되었습니다 (요청 {base_thread}) — 중지합니다.")
        finished = any(e.get("type") in ("turn.completed", "turn.failed") for e in events)
        contexts = _run_contexts(log_file, thread)
        if not contexts:
            if finished:
                return ("ERROR", "Codex가 실행 설정 기록(turn_context)을 남기지 않아 실제 모델·추론 수준을 확인할 수 없습니다.")
            return None
        for ctx in contexts:
            if run is not None and ctx.get("model") != run.model:
                return ("ERROR", f"Codex가 실행한 모델 {ctx.get('model')!r}이 요청한 {run.model!r}과 다릅니다 — 중지합니다.")
            if run is not None and ctx.get("effort") != run.effort:
                return ("ERROR", f"Codex가 실행한 추론 수준 {ctx.get('effort')!r}이 요청한 {run.effort!r}과 다릅니다 — 중지합니다.")
        return None


def _denied_command(events: list[dict]) -> str | None:
    """The first command that failed with a policy refusal (`Operation not permitted`, an approval request, ...)."""
    for e in events:
        item = e.get("item") if isinstance(e.get("item"), dict) else {}
        if e.get("type") != "item.completed" or item.get("type") != "command_execution":
            continue
        if item.get("exit_code") in (0, None):
            continue
        if _CODEX_DENIED.search(str(item.get("aggregated_output") or "")):
            return str(item.get("command") or "command")[:160]
    return None


def _logged_in(out: str) -> bool:
    try:
        return json.loads(out).get("loggedIn") is True
    except (ValueError, AttributeError):
        return False


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
    if re.search(r"variant unavailable|unsupported value|supported values are|unsupported (reasoning )?effort|"
                 r"unknown --effort value", low):
        return "effort"
    if re.search(r"no conversation found with session id|no rollout found for thread id|thread/resume failed", low):
        return "session_missing"   # never answered by a silent new session: the worktree and PR are kept
    if re.search(r"usage limit|5-hour limit|weekly limit", low):
        return "usage_limit"       # a plan limit is not retried or switched automatically
    if re.search(r"\b429\b|rate.?limit|too many requests", low):
        return "rate_limit"
    if re.search(r"\b401\b|\b403\b|unauthori[sz]ed|invalid api key|authentication|not logged in|please run /login", low):
        return "auth"
    if re.search(r"econnreset|etimedout|enotfound|network|socket hang up|connection (refused|reset)", low):
        return "network"
    return "unknown"
