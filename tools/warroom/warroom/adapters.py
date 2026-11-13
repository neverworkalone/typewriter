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
import sys
import tempfile
import threading
from dataclasses import dataclass
from pathlib import Path

@dataclass(frozen=True)
class RunSpec:
    """The model, reasoning effort, and optional Codex settings one run is pinned to."""
    model: str
    effort: str
    permission_profile: str = ""   # Codex only: named `[permissions.<name>]` profile; empty = leave the CLI default
    fast: bool | None = None       # Codex only; None = inherit the CLI setting


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
    needs_git_dir = False   # True: start/resume also receive `git_dir`, the owned linked worktree's Git admin directory

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

    def output_identity_problem(self, log_file: Path, run: RunSpec | None, expected_session: str | None,
                                cwd=None, env=None) -> tuple[str, str] | None:
        """Check this run's own identity and pinned model without requiring a terminal success event."""
        return None

    def completion_incomplete(self, log_file: Path, run: RunSpec | None, expected_session: str | None,
                              cwd=None, env=None) -> bool:
        """True when only this run's terminal completion event is missing and its identity/pins are valid."""
        return False

    def denied_actions(self, log_file: Path) -> list[dict] | None:
        """Denied actions, or None when this adapter cannot determine the permission outcome from its log."""
        return []

    def policy_refusal(self, log_file: Path) -> str | None:
        """A reason when the CLI's own policy refused an action (seen in the log), or None. Used when a run ended
        without its result (no PR): such a run is PAUSED for the operator instead of counted as a plain error."""
        return None

    def confirmed_prompt_refusal(self, log_file: Path) -> str | None:
        """An exact provider-confirmed refusal of the prompt itself, never text from an answer or tool output."""
        return None

    def final_answer(self, log_file: Path) -> str | None:
        """The FINAL assistant answer of this run (its own log), or None. Tool output and earlier messages never count."""
        return final_answer(log_file)

    def stop(self, pid: int) -> None: ...
    def alive(self, pid: int) -> bool: ...
    def session_id(self, log_file: Path) -> str | None: ...
    def exit_code(self, exit_file: Path) -> int | None: ...

    def read_pid(self, exit_file: Path) -> int | None:
        """The worker's PID as the launch wrapper itself recorded it (recovers a run whose PID was never stored)."""
        return None


def is_answer_only(env) -> bool:
    """The Supervisor marks an A/B answer-only chunk launch (`_launch_env`): the AI only answers; nothing it writes counts."""
    return env.get("WARROOM_ANSWER_ONLY") == "1"


def is_stage2_repair(env) -> bool:
    """Stage 2 local repair is an answer-only run with adapter-enforced write restrictions."""
    return env.get("WARROOM_STAGE2_REPAIR") == "1"


def is_stage2_chunk(env) -> bool:
    """The Supervisor marks a Stage 2 chunk launch in its worker environment (`_launch_env`)."""
    return env.get("WARROOM_STAGE2_CHUNK") == "1"


def stage2_git_executables(env) -> list[str]:
    """The discovered Git binaries a chunk must not run (`WARROOM_GIT_EXECUTABLES`), with resolved targets."""
    try:
        items = json.loads(env.get("WARROOM_GIT_EXECUTABLES") or "[]")
    except json.JSONDecodeError as e:
        raise RuntimeError("Stage 2 청크의 Git 차단 경로가 손상되었습니다") from e
    if not isinstance(items, list):
        raise RuntimeError("Stage 2 청크의 Git 차단 경로가 올바르지 않습니다")
    paths = set()
    for item in items:
        if not isinstance(item, str) or not item or not Path(item).is_absolute():
            raise RuntimeError("Stage 2 청크를 시작하지 않습니다: Git 실행 경로가 절대 경로가 아닙니다")
        paths.add(str(Path(item)))
        paths.add(str(Path(item).resolve()))
    if not paths:
        raise RuntimeError("Stage 2 청크를 시작하지 않습니다: 차단할 Git 실행 파일 경로를 확인하지 못했습니다")
    return sorted(paths)


def stage2_protected_paths(env) -> list[str]:
    """Supervisor-owned paths that a chunk worker must not replace or write."""
    try:
        items = json.loads(env.get("WARROOM_PROTECTED_PATHS") or "[]")
    except json.JSONDecodeError as e:
        raise RuntimeError("Stage 2 청크의 보호 경로 설정이 손상되었습니다") from e
    if not isinstance(items, list) or not items:
        raise RuntimeError("Stage 2 청크를 시작하지 않습니다: Supervisor 보호 경로를 확인하지 못했습니다")
    paths = set()
    for item in items:
        if not isinstance(item, str) or not item or not Path(item).is_absolute():
            raise RuntimeError("Stage 2 청크를 시작하지 않습니다: 보호 경로가 절대 경로가 아닙니다")
        resolved = Path(item).resolve()
        if not resolved.exists():
            raise RuntimeError("Stage 2 청크를 시작하지 않습니다: 보호 경로가 없습니다")
        paths.add(str(resolved))
    return sorted(paths)


def stage2_chunk_sandbox_command(cmd: list[str], git_executables: list[str], protected_paths: list[str],
                                 path: str) -> list[str]:
    """Deny Git execution and writes to Supervisor-owned state for a chunk worker."""
    paths = stage2_git_executables({"WARROOM_GIT_EXECUTABLES": json.dumps(git_executables)})
    protected = stage2_protected_paths({"WARROOM_PROTECTED_PATHS": json.dumps(protected_paths)})
    if sys.platform == "darwin":
        sandbox = shutil.which("sandbox-exec", path=path)
        if not sandbox:
            raise RuntimeError("Stage 2 청크를 시작하지 않습니다: macOS sandbox-exec를 찾을 수 없습니다")
        protected_rules = [
            f"(deny file-write* ({'subpath' if Path(item).is_dir() else 'literal'} {json.dumps(item)}))"
            for item in protected
        ]
        rules = " ".join([*(f"(deny process-exec (literal {json.dumps(item)}))" for item in paths),
                           *protected_rules])
        profile = f"(version 1) (allow default) {rules}"
        return [sandbox, "-p", profile, *cmd]
    if sys.platform.startswith("linux"):
        bubblewrap = shutil.which("bwrap", path=path)
        if not bubblewrap:
            raise RuntimeError("Stage 2 청크를 시작하지 않습니다: Git 실행을 차단할 bwrap을 찾을 수 없습니다")
        masked = [arg for item in paths for arg in ("--ro-bind", "/dev/null", item)]
        readonly = [arg for item in protected for arg in ("--ro-bind", item, item)]
        return [bubblewrap, "--die-with-parent", "--new-session", "--bind", "/", "/", *masked, *readonly,
                "--", *cmd]
    raise RuntimeError(f"Stage 2 청크를 시작하지 않습니다: {sys.platform}용 Git 실행 샌드박스가 없습니다")


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
    # True: do not wrap this adapter in the common chunk sandbox. Its own CLI policy (or compatibility needs)
    # defines the boundary; macOS also refuses nested sandbox_apply calls.
    native_stage2_chunk_sandbox = False
    # Opt-in seam for #3787, after every task launcher has been connected.
    required_launch_gate = None

    def _spawn(self, cmd: list[str], cwd, env, log_file: Path, exit_file: Path) -> Handle:
        gate = self.required_launch_gate
        if gate is not None and not gate.held():
            raise RuntimeError("AI spawn requires the current thread's launch permit")
        log_file, exit_file = Path(log_file), Path(exit_file)
        log_file.parent.mkdir(parents=True, exist_ok=True)
        exit_file.unlink(missing_ok=True)
        env = dict(env)
        if is_stage2_chunk(env) and not self.native_stage2_chunk_sandbox:
            cmd = stage2_chunk_sandbox_command(cmd, stage2_git_executables(env), stage2_protected_paths(env),
                                               env.get("PATH", os.defpath))
        env.pop("WARROOM_GIT_EXECUTABLES", None)
        env.pop("WARROOM_PROTECTED_PATHS", None)
        # The wrapper records the exit status so a restarted Supervisor can still
        # learn how the (detached) child ended.
        # It records its own PID (= the process group id) first, and the child never starts if that record cannot be
        # written: a run whose PID the Supervisor never stored (it stopped right after the detached start) is either
        # findable through that record or has no worker at all.
        wrapper = ['echo $$ > "$WARROOM_EXIT_FILE.pid" || { echo 126 > "$WARROOM_EXIT_FILE"; exit 126; }', '"$@"', "echo $? > \"$WARROOM_EXIT_FILE\""]
        env["WARROOM_EXIT_FILE"] = str(exit_file)
        with open(log_file, "wb") as log:   # a launch's log is its own: never continued behind an earlier run's events
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

    def read_pid(self, exit_file: Path) -> int | None:
        try:
            return int(Path(f"{exit_file}.pid").read_text().strip())
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

    def preflight(self, runner, env, runs, answer_required=frozenset()):
        """`answer_required`: models (the GOAT/API tier) whose probe must show a clean answer, not just a provider reply."""
        listing = self._model_listing(runner, env)
        if not listing["done"].is_set():
            return f"{PREFLIGHT_PENDING} 모델 목록"
        if listing["problem"]:
            return listing["problem"]
        missing = [r.model for r in runs if r.model not in listing["ids"]]
        if missing:
            return f"OpenCode가 지원하지 않는 모델 ID: {', '.join(missing)}"
        for run in runs:
            problem = self._variant_problem(runner, env, run, strict=run.model in answer_required)
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

    def _variant_problem(self, runner, env, run, strict: bool = False) -> str | None:
        """Start-time proof that the CLI accepts this model+variant (`--model <id>#<effort>`).

        Each pair is probed once per Supervisor life. While its probe runs this returns a PREFLIGHT_PENDING reason,
        so the caller waits for it on a later tick and the other Lines keep moving.
        """
        key = self.model_arg(run)
        cache_key = f"{key}|strict" if strict else key   # a strict answer proof and a variant proof never share a result
        with self._probe_lock:
            probe = self._probes.get(cache_key)
            if probe is None:
                probe = self._probes[cache_key] = {"done": threading.Event(), "problem": None}
                if self.probe_async:
                    threading.Thread(target=self._probe, args=(runner, env, run, probe, strict), daemon=True).start()
                else:
                    self._probe(runner, env, run, probe, strict)
        if not probe["done"].is_set():
            return f"{PREFLIGHT_PENDING} {key}"
        return probe["problem"]

    def _probe(self, runner, env, run, probe, strict: bool = False) -> None:
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
            probe["problem"] = self._probe_outcome(res, run, strict)
        except Exception as e:   # any failure is "not proven"
            probe["problem"] = f"OpenCode가 {run.model}의 추론 수준을 확인하지 못했습니다 ({e}) — 실행하지 않습니다."
        finally:
            shutil.rmtree(work, ignore_errors=True)
            probe["done"].set()

    @staticmethod
    def _probe_outcome(res, run, strict: bool = False) -> str | None:
        """Non-strict (Free/Go): an answer or a provider error proves the variant. Strict (the API/GOAT tier, #6027):
        only a clean answer passes — exit 0, a top-level text event and no top-level error event."""
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
        if strict:
            errors = [e.get("error") or {} for e in events if isinstance(e, dict) and e.get("type") == "error"]
            if answered and not errors and res.code == 0:
                return None
            # Only the error's type/status: a provider body is never echoed (it may carry account details).
            detail = ", ".join(f"{(x.get('type') if isinstance(x, dict) else None) or 'error'}"
                               f"{'/' + str(x.get('status')) if isinstance(x, dict) and x.get('status') is not None else ''}"
                               for x in errors) or ("응답 없음" if not answered else "비정상 종료")
            return (f"OpenCode가 {run.model}#{run.effort}에서 정상 응답을 확인하지 못했습니다 (exit {res.code}: {detail}) — "
                    "인증·모델·한도 확인 전에는 실행하지 않습니다.")
        if answered or provider_reached:
            return None
        detail = (res.err or res.out).strip()[:200]
        return (f"OpenCode가 {run.model}#{run.effort}의 추론 수준을 확인하지 못했습니다 (exit {res.code}: {detail}) — "
                "검증되지 않은 설정으로 실행하지 않습니다.")


# Permissions are the operator's own local Claude settings (~/.claude/settings.json, project settings), applied by
# the CLI's own precedence. War Room passes no permission option: no allowlist, no permission mode, no bypass.
# A tool the local settings do not allow is denied by the CLI and reported in `permission_denials`. The Supervisor
# keeps such a run in PAUSED unless owned-PR and Part verify evidence shows the required work completed anyway
# (Supervisor._denied_run_completed). Model, effort and the session are the only things War Room pins.
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


def final_answer(log_file) -> str | None:
    """The last assistant answer in one launch's log, for any of the three CLIs:
    Claude `result.result` (success only), Codex the last completed `agent_message`, OpenCode the text parts of the
    last step that produced text. A log is one launch, so an earlier run's answer can never be returned."""
    try:
        text = Path(log_file).read_text("utf-8", errors="replace")
    except OSError:
        return None
    claude = codex = None
    steps: list[list[str]] = [[]]
    for o in _json_objects(text):
        kind = o.get("type")
        if kind == "result" and o.get("subtype") == "success" and o.get("is_error") is False and isinstance(o.get("result"), str):
            claude = o["result"]
        elif kind == "item.completed" and isinstance(o.get("item"), dict) and o["item"].get("type") == "agent_message" \
                and isinstance(o["item"].get("text"), str):
            codex = o["item"]["text"]
        elif kind == "step_start":
            steps.append([])
        elif kind == "text" and isinstance(o.get("part"), dict) and isinstance(o["part"].get("text"), str):
            steps[-1].append(o["part"]["text"])
    if claude is not None:
        return claude
    if codex is not None:
        return codex
    for texts in reversed(steps):
        if texts:
            return "".join(texts)
    return None


class ClaudeCodeAdapter(ProcessAdapter):
    """Claude Code (`claude -p --output-format stream-json`). Model and effort are passed on every launch."""
    name = "claude"
    capabilities = {"resume": True, "stop": True}
    requires_session_for_pr = True
    requires_final_result_for_pr = True   # its final denials and session are verified only at exit (run_problem/completion)

    def __init__(self, binary: str = "claude"):
        self.binary = binary
        self._help_flags: set[str] | None = None   # option names the installed CLI lists (set by preflight)

    @staticmethod
    def _pins(run: RunSpec) -> list[str]:
        return ["--model", run.model, "--effort", run.effort, "--output-format", "stream-json", "--verbose"]

    def _answer_only_args(self, env) -> list[str]:
        """Answer-only chunk: every tool removed (`--tools ""`), MCP limited to none, slash commands off. `--bare` also
        drops CLAUDE.md/hooks/plugins/memory but needs API-key auth, so it is used only when the key is in the worker
        environment. The tool removal is the isolation guarantee: a CLI without `--tools` is refused, not guessed at."""
        if not is_answer_only(env):
            return []
        flags = self._help_flags
        if flags is None or "--tools" not in flags:
            raise RuntimeError("답변 전용 청크를 시작하지 않습니다: 설치된 Claude CLI가 --tools 로 도구를 제거하는 것을 지원하는지 확인하지 못했습니다")
        if is_stage2_repair(env) and "--strict-mcp-config" not in flags:
            raise RuntimeError("Stage 2 repair를 시작하지 않습니다: 설치된 Claude CLI가 strict MCP 제한을 지원하는지 확인하지 못했습니다")
        args = ["--tools", ""]
        for optional in ("--strict-mcp-config", "--disable-slash-commands"):
            if optional in flags:
                args.append(optional)
        if "--bare" in flags and env.get("ANTHROPIC_API_KEY"):
            args.append("--bare")
        return args

    def start(self, prompt, cwd, env, run, title, log_file, exit_file):
        cmd = [self.binary, "-p", prompt, *self._pins(_pinned(run)), "--name", title, *self._answer_only_args(env)]
        return self._spawn(cmd, cwd, env, log_file, exit_file)

    def resume(self, session_id, prompt, cwd, env, run, log_file, exit_file):
        cmd = [self.binary, "-p", prompt, "--resume", session_id, *self._pins(_pinned(run)), *self._answer_only_args(env)]
        return self._spawn(cmd, cwd, env, log_file, exit_file)

    def preflight(self, runner, env, runs):
        v = runner.run([self.binary, "--version"], env=env, timeout=60)
        if not v.ok:
            return f"`{self.binary} --version` 실행 실패: {v.err.strip()[:200]}"
        h = runner.run([self.binary, "--help"], env=env, timeout=60)
        if not h.ok:
            return f"`{self.binary} --help` 실행 실패: {h.err.strip()[:200]}"
        self._help_flags = set(re.findall(r"--[a-z][a-z-]*", h.out))
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
        return None

    def denied_actions(self, log_file):
        """The final result's `permission_denials`; None until that result proves the permission outcome.

        A denial is not by itself a failed run: the Supervisor accepts a successful run with denials only on owned-PR
        and Part verify evidence.
        """
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")
        except OSError:
            return None
        result = None
        for o in _json_objects(text):
            if o.get("type") == "result":
                result = o
        if result is None:
            return None
        denials = result.get("permission_denials") if result is not None else None
        return [d if isinstance(d, dict) else {"tool_name": str(d)} for d in denials] \
            if isinstance(denials, list) else None

    def completion_problem(self, log_file, run, expected_session, cwd=None, env=None):
        """An exited run is accepted only with its own evidence: the session its init event reported AND a final
        successful `result` event for that session. An init alone proves the run started, not that it succeeded; an
        empty log or one with no parsable event is refused (run_problem alone treats it as not started)."""
        problem = self.run_problem(log_file, run, expected_session)
        if problem:
            return problem
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")
        except OSError:
            return ("ERROR", "실행 로그를 읽을 수 없어 완료를 확인하지 못했습니다.")
        init = result = None
        for o in _json_objects(text):
            if o.get("type") == "system" and o.get("subtype") == "init" and init is None:
                init = o
            elif o.get("type") == "result":
                result = o
        if init is None:
            return ("ERROR", "CLI가 세션 ID를 보고하지 않고 끝났습니다 — 세션을 확인하지 못해 PR을 인정하지 않습니다.")
        if result is None:
            return ("ERROR", "CLI가 최종 result 이벤트 없이 종료되었습니다 — 성공을 확인하지 못해 PR을 인정하지 않습니다 "
                             "(worktree·PR·세션 보존).")
        if result.get("is_error") is not False or result.get("subtype") != "success":
            return ("ERROR", f"CLI가 실패 결과로 종료되었습니다 (subtype={result.get('subtype')!r}, "
                             f"is_error={result.get('is_error')!r}) — PR을 인정하지 않고 보존합니다.")
        reported = result.get("session_id")   # required by the result schema: absent/null/empty cannot prove the match
        if not isinstance(reported, str) or not reported.strip() or reported != init.get("session_id"):
            return ("ERROR", f"최종 result의 세션 ID {reported!r}가 없거나 init의 {init.get('session_id')!r}와 다릅니다 — 중지하고 보존합니다.")
        return None

    def output_identity_problem(self, log_file, run, expected_session, cwd=None, env=None):
        try:
            events = list(_json_objects(Path(log_file).read_text("utf-8", errors="replace")))
        except OSError:
            return ("ERROR", "실행 로그를 읽을 수 없어 청크를 만든 세션을 확인하지 못했습니다.")
        init = next((e for e in events if e.get("type") == "system" and e.get("subtype") == "init"), None)
        if init is None:
            return ("ERROR", "청크를 만든 실행의 세션 ID를 확인할 수 없습니다.")
        session = init.get("session_id")
        if not isinstance(session, str) or not session.strip() or (expected_session and session != expected_session):
            return ("ERROR", "청크를 만든 실행의 세션 ID가 없거나 요청한 세션과 다릅니다.")
        model = str(init.get("model") or "")
        if not model or run is None or run.model.lower() not in model.lower():
            return ("ERROR", "청크를 만든 실행의 모델 핀을 확인하지 못했습니다.")
        for result in (e for e in events if e.get("type") == "result"):
            reported = result.get("session_id")
            if reported is not None and reported != session:
                return ("ERROR", "최종 result의 세션 ID가 청크를 만든 실행과 다릅니다.")
        return None

    def completion_incomplete(self, log_file, run, expected_session, cwd=None, env=None):
        if self.output_identity_problem(log_file, run, expected_session, cwd, env):
            return False
        try:
            return not any(e.get("type") == "result" for e in _json_objects(
                Path(log_file).read_text("utf-8", errors="replace")))
        except OSError:
            return False


# Codex runs under the operator's configured CLI policy. War Room pins the model, reasoning effort and configured
# permission profile on every launch (including chunks and resumes), then checks the thread, model and effort it used.
# A permission-related command failure is kept as evidence (`denied_actions`) and never stops the live run by itself:
# the CLI/sandbox already enforced it, and the exit verdict's completion gates decide the run. Nothing is retried or
# widened here. `codex exec --json` records a command only as completed/failed with free-form output (no structured
# refusal, approval or decision field), so this evidence never claims which of those it was: unknown, never "allowed". For ordinary starts the linked worktree's Git
# admin directory (`git_dir`) is opened alone with `--add-dir`; resume adds the same exact-directory grant to the named
# configured profile because `exec resume` has no `--add-dir` flag. The repository's `.git` is never granted.
# Chunks add only lightweight web-search/project-doc settings. Answer-only output remains a result contract, not a
# permission-profile override. Codex is not wrapped in the common Git-blocking chunk sandbox.
CODEX_REQUIRED_EXEC_FLAGS = ("--json", "--model", "--config", "--add-dir")
CODEX_REQUIRED_RESUME_FLAGS = ("resume", "--json", "--model", "--config")
_PROFILE_NAME = re.compile(r"[A-Za-z0-9_-]+")
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


_ZSH_NICE_FAILURE = re.compile(r"^\s*(?:zsh:\d+:\s*)?nice(?:\(\d+\))?\s+failed:\s*operation not permitted\s*$", re.I)

# Exact structured provider error messages. Keep providers empty until their own CLI gives us evidence.
PROMPT_POLICY_REFUSALS = {
    "codex": (
        "Invalid prompt: your prompt was flagged as potentially violating our usage policy.",
        # The live CLI appends this fixed advice sentence and link (batch 4165 log); both forms are exact.
        "Invalid prompt: your prompt was flagged as potentially violating our usage policy. "
        "Please try again with a different prompt: "
        "https://platform.openai.com/docs/guides/reasoning#advice-on-prompting",
    ),
    "claude": (),
    "opencode": (),
}


def _codex_denial_evidence(output) -> str | None:
    """Return a policy-denial line, ignoring zsh's OS-level nice diagnostic.

    `nice(5) failed: operation not permitted` is emitted by zsh when it cannot
    apply its scheduling hint; it does not say the requested command was denied
    by Codex's sandbox. Keep all other denial evidence, including a real denial
    reported alongside this shell diagnostic.
    """
    lines = [line.strip() for line in str(output or "").splitlines()
             if line.strip() and not _ZSH_NICE_FAILURE.fullmatch(line)]
    for line in lines:
        if _CODEX_DENIED.search(line):
            return line[:240]
    # Keep matching multi-line output observable without treating the known
    # standalone zsh diagnostic as a refusal.
    text = "\n".join(lines)
    if _CODEX_DENIED.search(text):
        match = _CODEX_DENIED.search(text)
        return text[max(0, match.start() - 100):match.end() + 100].replace("\n", " ")[:240]
    return None


def _command_denial(item: dict) -> str | None:
    if item.get("exit_code") in (0, None):
        return None
    evidence = _codex_denial_evidence(item.get("aggregated_output"))
    if evidence is None:
        return None
    command = str(item.get("command") or "command")[:160]
    return f"{command} (exit={item.get('exit_code')}; 출력: {evidence})"


class CodexCLIAdapter(ProcessAdapter):
    """Codex CLI (`codex exec --json`, `codex exec resume <thread id>`), with optional per-launch Fast pins."""
    name = "codex"
    capabilities = {"resume": True, "stop": True}
    requires_session_for_pr = True
    requires_final_result_for_pr = True   # a PR is taken over only after the run exited and its final result was checked
    needs_git_dir = True
    native_stage2_chunk_sandbox = True

    def __init__(self, binary: str = "codex"):
        self.binary = binary

    @staticmethod
    def _pins(run: RunSpec) -> list[str]:
        # The profile is selected by name only (`permission_profile` in the producer config); its rules stay in local config.
        pins = ["--json", "-m", run.model, "-c", f"model_reasoning_effort={run.effort}"]
        if run.permission_profile:
            pins += ["-c", f"default_permissions={run.permission_profile}"]
        if run.fast is True:
            pins += ["-c", "service_tier=fast", "-c", "features.fast_mode=true"]
        elif run.fast is False:
            pins += ["-c", "service_tier=default", "-c", "features.fast_mode=false"]
        return pins

    @staticmethod
    def _git_dir(git_dir) -> str:
        """The absolute Git admin directory to open for writing; a missing or unusable one refuses the launch."""
        text = str(git_dir) if git_dir else ""
        if not text or not os.path.isabs(text) or any(ord(c) < 32 for c in text):
            raise ValueError("worktree의 Git 관리 디렉터리를 알 수 없어 Codex를 시작하지 않았습니다.")
        return text

    def _chunk_args(self) -> list[str]:
        """Keep chunk input lean without replacing the operator's configured permission or approval policy."""
        return ["-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0"]

    def _launch_args(self, env, run: RunSpec, grant: list[str]) -> list[str]:
        """Pin the configured run profile; chunks add only input optimizations and omit Git admin grants."""
        pins = self._pins(run)
        if is_stage2_repair(env) or is_stage2_chunk(env):
            return [*pins, *self._chunk_args()]
        return [*pins, *grant]

    def start(self, prompt, cwd, env, run, title, log_file, exit_file, git_dir=None):
        run = _pinned(run)
        grant = [] if is_stage2_chunk(env) else ["--add-dir", self._git_dir(git_dir)]
        cmd = [self.binary, "exec", *self._launch_args(env, run, grant), prompt]
        _baseline_path(log_file).unlink(missing_ok=True)   # a fresh start has no baseline: every turn is its own
        return self._spawn(cmd, cwd, env, log_file, exit_file)

    def resume(self, session_id, prompt, cwd, env, run, log_file, exit_file, git_dir=None):
        run = _pinned(run)
        grant = []
        if not is_stage2_chunk(env):
            if not _PROFILE_NAME.fullmatch(run.permission_profile or ""):
                raise ValueError("`codex exec resume`에는 --add-dir이 없어 permission_profile 없이는 Git 관리 디렉터리를 "
                                 "열 수 없습니다. producer 설정에 permission_profile을 지정하세요.")
            grant = ["-c", f"permissions.{run.permission_profile}.filesystem="
                           f"{{{json.dumps(self._git_dir(git_dir))}=\"write\"}}"]
        cmd = [self.binary, "exec", "resume", session_id, *self._launch_args(env, run, grant), prompt]
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
        """A permission-related failure of a command this run actually executed (non-zero exit with that output).
        The agent's own messages are diagnostic text only and never count; output of a succeeded command never counts."""
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")
        except OSError:
            return None
        for item in _failed_permission_commands(_json_objects(text)):
            return (f"로컬 Codex 명령이 권한 관련 오류로 실패했습니다 ({_command_denial(item)}). CLI 로그에는 정책 거절·"
                    "승인 대기·일반 OS 권한 오류를 구분하는 구조화 근거가 없어 미확인으로 보존합니다")
        return None

    def denied_actions(self, log_file):
        """Permission-related command failures of this launch (one log per launch), kept as evidence for the exit verdict.

        None when the log cannot prove the outcome (unreadable, or the thread never started): unknown is never "none"."""
        try:
            events = list(_json_objects(Path(log_file).read_text("utf-8", errors="replace")))
        except OSError:
            return None
        if not any(e.get("type") == "thread.started" for e in events):
            return None
        return [{"tool_name": "command_execution", "tool_input": {"command": str(item.get("command") or "command")},
                 "exit_code": item.get("exit_code"), "evidence": _command_denial(item)}
                for item in _failed_permission_commands(events)]

    def confirmed_prompt_refusal(self, log_file):
        """Match only Codex's exact structured turn.failed error message for this launch."""
        try:
            events = list(_json_objects(Path(log_file).read_text("utf-8", errors="replace")))
        except OSError:
            return None
        terminal = [e for e in events if e.get("type") in ("turn.completed", "turn.failed")]
        if len(terminal) != 1 or terminal[0].get("type") != "turn.failed":
            return None
        error = terminal[0].get("error")
        message = error.get("message") if isinstance(error, dict) else None
        return message if isinstance(message, str) and message in PROMPT_POLICY_REFUSALS[self.name] else None

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

    def output_identity_problem(self, log_file, run, expected_session, cwd=None, env=None):
        try:
            events = list(_json_objects(Path(log_file).read_text("utf-8", errors="replace")))
        except OSError:
            return ("ERROR", "실행 로그를 읽을 수 없어 청크를 만든 세션을 확인하지 못했습니다.")
        started = next((e for e in events if e.get("type") == "thread.started"), None)
        if started is None or not _valid_thread(started.get("thread_id")):
            return ("ERROR", "청크를 만든 Codex thread ID를 확인할 수 없습니다.")
        thread = started["thread_id"]
        if expected_session and thread != expected_session:
            return ("ERROR", "청크를 만든 Codex thread ID가 요청한 세션과 다릅니다.")
        base_thread, _ = _baseline(log_file)
        if base_thread and thread != base_thread:
            return ("ERROR", "재개 실행이 청크를 만든 Codex 세션과 다릅니다.")
        if run is None:
            return ("ERROR", "청크를 만든 Codex 실행 설정을 확인할 수 없습니다.")
        contexts = _run_contexts(log_file, thread)
        if not contexts:
            return ("ERROR", "청크를 만든 Codex 모델·추론 수준 기록이 없습니다.")
        for ctx in contexts:
            if ctx.get("model") != run.model or ctx.get("effort") != run.effort:
                return ("ERROR", "청크를 만든 Codex 실행의 모델 또는 추론 수준이 요청한 핀과 다릅니다.")
        return None

    def completion_incomplete(self, log_file, run, expected_session, cwd=None, env=None):
        if self.output_identity_problem(log_file, run, expected_session, cwd, env):
            return False
        try:
            events = list(_json_objects(Path(log_file).read_text("utf-8", errors="replace")))
        except OSError:
            return False
        return not any(e.get("type") in ("turn.failed", "turn.completed") for e in events)

    supports_tolerate_denied = True

    def run_problem(self, log_file, run, expected_session, cwd=None, env=None, tolerate_denied=False):
        """Identity/pin violations only. A permission-related command failure never stops a live run here: it is kept
        in `denied_actions` and judged once at exit. `tolerate_denied` is accepted for the Supervisor's call signature."""
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


def _failed_permission_commands(events):
    """Completed command executions that failed with permission-related output, in log order."""
    for e in events:
        item = e.get("item") if isinstance(e.get("item"), dict) else {}
        if e.get("type") == "item.completed" and item.get("type") == "command_execution" and _command_denial(item):
            yield item


def _logged_in(out: str) -> bool:
    try:
        return json.loads(out).get("loggedIn") is True
    except (ValueError, AttributeError):
        return False


QUOTA_EVIDENCE = "provider.quota / FreeUsageLimitError / 429"


def _is_free_quota_event(e: object) -> bool:
    """A top-level OpenCode `error` event whose provider body is FreeUsageLimitError; nothing looser qualifies."""
    err = e.get("error") if isinstance(e, dict) and e.get("type") == "error" else None
    if not isinstance(err, dict) or err.get("type") != "provider.quota":
        return False
    status = err.get("status")
    resp = err.get("response")
    body = resp.get("body") if isinstance(resp, dict) else None
    if isinstance(status, bool) or status != 429 or not isinstance(body, str):
        return False
    try:
        inner = json.loads(body)
    except ValueError:
        return False
    inner_err = inner.get("error") if isinstance(inner, dict) else None
    return isinstance(inner_err, dict) and inner_err.get("type") == "FreeUsageLimitError"


def opencode_free_quota(log_file: str | Path) -> bool:
    """True only when this run's JSONL log holds a real provider Free-quota error event.

    The file is streamed line by line, so an error event is never lost to a tail cut; AI text, tool output
    and embedded JSON strings are never top-level events and cannot qualify. Unreadable or malformed
    input is simply not evidence (fail closed: the caller keeps its non-paid recovery paths)."""
    try:
        with open(log_file, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if '"provider.quota"' not in line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                if _is_free_quota_event(ev):
                    return True
    except OSError:
        return False
    return False


GOAT_PROVIDER = "commandcode/"   # #6027: the persisted model ID of a Command Code GOAT run starts with this provider


def is_goat_model(model: object) -> bool:
    """A run was a GOAT run iff its PERSISTED model ID names the GOAT provider (never the current config or tier)."""
    return isinstance(model, str) and model.startswith(GOAT_PROVIDER)


def opencode_provider_errors(log_file: str | Path) -> tuple[list[dict], str]:
    """Top-level OpenCode `error` events ({type, status, param}) and the non-JSON CLI diagnostic lines of one run log.

    Every other JSON line (AI text, tool output, step events) is ignored, so a string the model or a tool printed
    can never become a billing, limit or auth verdict. `param` is the provider body's `error.param`, when the body is
    JSON. Unreadable input is simply no evidence."""
    errors, diagnostic = [], []
    try:
        with open(log_file, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                try:
                    ev = json.loads(line)
                except ValueError:
                    if line.strip():
                        diagnostic.append(line.rstrip("\n"))
                    continue
                err = ev.get("error") if isinstance(ev, dict) and ev.get("type") == "error" else None
                if not isinstance(err, dict):
                    continue
                status = err.get("status")
                resp = err.get("response")
                body = resp.get("body") if isinstance(resp, dict) else None
                param = None
                if isinstance(body, str):
                    try:
                        inner = json.loads(body)
                    except ValueError:
                        inner = None
                    inner_err = inner.get("error") if isinstance(inner, dict) else None
                    if isinstance(inner_err, dict) and isinstance(inner_err.get("param"), str):
                        param = inner_err["param"]
                errors.append({"type": err.get("type") if isinstance(err.get("type"), str) else "",
                               "status": status if isinstance(status, int) and not isinstance(status, bool) else None,
                               "param": param,
                               "message": err.get("message") if isinstance(err.get("message"), str) else ""})
    except OSError:
        return [], ""
    return errors, "\n".join(diagnostic[-200:])


def classify_goat_failure(log_file: str | Path) -> str:
    """'auth' | 'usage_limit' | 'network' | 'effort' | 'session_missing' | 'unknown' for a GOAT run.

    Only top-level provider error events decide billing, limit and auth. A 429 is never split into limit vs.
    transient without evidence: it is a hold (`usage_limit`). Without a provider event only the non-JSON CLI
    diagnostics are classified; no evidence is `unknown` (held, never a silent new session or paid fallback)."""
    errors, diagnostic = opencode_provider_errors(log_file)
    for e in errors:
        status = e["status"]
        if status in (401, 403):
            return "auth"
        if status == 429:
            return "usage_limit"
    for e in errors:
        if e["status"] == 400 and e["param"] == "reasoning_effort":
            return "effort"
        if isinstance(e["status"], int) and 500 <= e["status"] <= 599:
            return "network"
        # A dropped connection mid-stream reports its HTTP status as 200; the transport type and a network-fault
        # message are the evidence (a transient fault, retried within the existing bounded network backoff).
        if e["type"] == "provider.transport" and classify_failure(e["message"], []) == "network":
            return "network"
    if errors:
        return "unknown"
    # CLI diagnostics may prove a CLI-side condition, never billing, limit or auth (those need a provider event).
    cls = classify_failure(diagnostic, []) if diagnostic else "unknown"
    return cls if cls in ("effort", "session_missing", "network") else "unknown"


# --- failure classification: a structured OpenCode Free-quota error is the ONLY trigger for Go ---
def classify_failure(log_text: str, quota_patterns: list[str]) -> str:
    """'free_quota' | 'usage_limit' | 'effort' | 'rate_limit' | 'auth' | 'network' | 'unknown'.

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
    if re.search(r"session limit|usage[ _]limit|5-hour limit|weekly limit", low):
        return "usage_limit"       # a plan limit is not retried or switched automatically
    if re.search(r"\b429\b|rate.?limit|too many requests", low):
        return "rate_limit"
    if re.search(r"\b401\b|\b403\b|unauthori[sz]ed|invalid api key|authentication|not logged in|please run /login", low):
        return "auth"
    if re.search(r"econnreset|etimedout|enotfound|network|socket hang up|connection (refused|reset)", low):
        return "network"
    return "unknown"


_LIMIT_RESET = re.compile(r"try again at ([A-Z][a-z]{2,8})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}) (\d{1,2}):(\d{2}) ?([AP]M)", re.I)


def usage_limit_override_key(batch_id: int) -> str:
    """Store key: the last run id of this batch when an operator Retry declared its plan usage limit reset; a
    usage-limit failure of that run or an earlier one no longer waits for its stated reset."""
    return f"usage_limit_override_{batch_id}"


def usage_limit_reset_at(log_text: str) -> float | None:
    """Epoch seconds (local time) of the 'try again at <date>' a plan usage-limit error reports, else None."""
    import datetime
    for m in _LIMIT_RESET.finditer(log_text):
        month, day, year, hour, minute, ampm = m.groups()
        try:
            when = datetime.datetime.strptime(f"{month[:3].title()} {day} {year} {hour}:{minute} {ampm.upper()}", "%b %d %Y %I:%M %p")
        except ValueError:
            continue
        return when.timestamp()
    return None


def classify_codex_failure(log_text: str, quota_patterns: list[str]) -> str:
    """Recognize explicit Codex Fast-setting rejection without guessing from model/auth failures."""
    diagnostics = []
    for line in log_text.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            diagnostics.append(line)
            continue
        if not isinstance(event, dict):
            continue
        # Ignore assistant/tool content; only top-level CLI failure events count as a confirmed diagnosis.
        if event.get("type") not in ("turn.failed", "error", "provider.quota") \
                and not ("error" in event and "item" not in event):
            continue
        error = event.get("error")
        if isinstance(error, dict):
            diagnostics.extend(str(error[key]) for key in ("type", "code", "status", "message")
                               if isinstance(error.get(key), (str, int)) and not isinstance(error.get(key), bool))
        elif isinstance(error, str):
            diagnostics.append(error)
        message = event.get("message")
        if isinstance(message, str):
            diagnostics.append(message)
    diagnostic = "\n".join(diagnostics)
    low = diagnostic.lower()
    common = classify_failure(diagnostic, quota_patterns)
    if common in ("free_quota", "usage_limit", "rate_limit", "auth", "network", "session_missing"):
        return common
    # Codex reports temporary provider capacity without an HTTP 429. Use the
    # existing bounded transient retry path, but only for CLI diagnostics.
    if re.search(r"\bselected model is at capacity\b", low):
        return "rate_limit"
    if re.search(r"\b(?:401|403)\b|unauthori[sz]ed|invalid api key|authentication|not logged in", low):
        return "auth"
    fast_key = r"(?:service_tier|features\.fast_mode)"
    config_rejection = (
        re.search(rf"(?:unknown|unrecognized|unsupported|invalid)[^\n]{{0,100}}{fast_key}", low)
        or re.search(rf"{fast_key}[^\n]{{0,100}}(?:unknown|unrecognized|unsupported|invalid|not supported)", low)
    )
    fast_unavailable = (re.search(r"\bfast mode\b[^\n]{0,100}\b(?:not available|unavailable|unsupported|not supported)\b", low)
                        or re.search(r"\bservice_tier\b[^\n]{0,80}\bfast\b[^\n]{0,80}\b(?:not available|unavailable|unsupported|not supported)\b", low))
    if config_rejection or fast_unavailable:
        return "fast_unavailable"
    return common


def classify_claude_failure(log_file: str | Path, fallback_text: str, quota_patterns: list[str]) -> str:
    """Classify Claude's stream-json errors without treating model/tool text as provider errors.

    Only the final structured `result` event can prove the exact usage-limit API error. If that evidence is absent,
    use the existing text fallback on plain or damaged log lines plus structured error metadata; omit valid assistant
    and tool-output events so their ordinary text cannot be mistaken for a quota response.
    """
    final_result = None
    saw_json = False
    fallback_lines: list[str] = []
    try:
        with open(log_file, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                stripped = line.strip()
                if not stripped:
                    continue
                try:
                    event = json.loads(stripped)
                except ValueError:
                    fallback_lines.append(stripped)
                    continue
                if not isinstance(event, dict):
                    fallback_lines.append(stripped)
                    continue
                saw_json = True
                if event.get("type") == "result":
                    final_result = event
                error = event.get("error")
                if isinstance(error, str):
                    fallback_lines.append(error)
                elif isinstance(error, dict):
                    for key in ("type", "code", "status", "message"):
                        value = error.get(key)
                        if isinstance(value, (str, int)) and not isinstance(value, bool):
                            fallback_lines.append(str(value))
    except OSError:
        return classify_failure(fallback_text, quota_patterns)

    if (final_result is not None and final_result.get("is_error") is True
            and final_result.get("api_error") == "usage_limit_reached"):
        return "usage_limit"
    if final_result is not None:
        api_error = final_result.get("api_error")
        if isinstance(api_error, str) and api_error != "usage_limit_reached":
            fallback_lines.append(api_error)
        status = final_result.get("api_error_status")
        if isinstance(status, int) and not isinstance(status, bool):
            fallback_lines.append(str(status))
    if not saw_json:
        return classify_failure("\n".join(fallback_lines) or fallback_text, quota_patterns)
    return classify_failure("\n".join(fallback_lines), quota_patterns)
