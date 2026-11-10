"""Out-of-process Supervisor restart controller (#5162).

The Supervisor is a replaceable reconciler, never the owner of the work: AI runs are detached processes with their own
PID/exit/log evidence, Git/Node children are journalled by the fence, and every batch re-enters from its DB, checkpoint,
worktree, Git and PR facts. So a Restart never waits for another Line. The Controller moves the live instance to
STOPPING, gives its in-flight Workers at most HANDOFF_GRACE seconds to return, ends it, optionally fast-forwards the
operating checkout to a requested fix, and starts the next instance - the same path a crashed Supervisor recovers by.

Replacing the instance and updating the code are separate: a code update that cannot be applied leaves the line running
on the current code and never blocks a replacement.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from .config import Paths, ROOT_ENV, load_config
from .fence import owner_state
from .logtail import redact
from .store import Store

TMUX_SUP = "warroom-supervisor"
STARTUP_TIMEOUT = 20
HANDOFF_GRACE = 30        # the MOST a STOPPING Supervisor is given for its in-flight Workers; then it is ended
CODE_RETRY_SECONDS = 300  # how long a code update that could not be applied waits before it is examined again


def _atomic_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")), "utf-8")
    os.replace(tmp, path)


def _read_json(path: Path) -> dict | None:
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


@contextmanager
def _decision(paths: Paths):
    """The one atomic boundary between request-file changes (new, cancelled, superseded) and the Controller's STOPPING
    approval: both happen under this lock, so a withdrawal either lands before the approval (which then sees it) or after
    it (too late by definition). Never nest it: flock on a second descriptor of the same process would block."""
    paths.restart_requests.mkdir(parents=True, exist_ok=True)
    with (paths.restart_requests / ".decision.lock").open("a+") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _write_live(path: Path, fields: dict) -> bool:
    """Controller write onto the CURRENT file, never onto a copy read earlier: a request cancelled or finished meanwhile is
    left exactly as it is. Caller holds the decision lock."""
    current = _read_json(path)
    if current is None or current.get("state") in TERMINAL_REQUEST_STATES:
        return False
    current.update(fields)
    _atomic_json(path, current)
    return True


def request_path(paths: Paths, defect_id: int) -> Path:
    return paths.restart_requests / f"restart-{defect_id}.json"


def write_restart_request(paths: Paths, defect: dict, loaded_code_sha: str | None) -> Path:
    """Persist one request tied to the exact merged defect and loaded Supervisor SHA."""
    defect = dict(defect)  # Store.defects() yields sqlite3.Row, which does not implement get().
    path = request_path(paths, defect["id"])
    current = _read_json(path)
    request = {
        "version": 1, "state": "requested", "runtime_root": str(paths.repo_root.resolve()),
        "defect_id": defect["id"], "issue": defect.get("issue_number"), "batch_id": defect.get("batch_id"),
        "merge_sha": defect.get("merge_sha"), "loaded_code_sha": loaded_code_sha,
    }
    if current and all(current.get(k) == request.get(k) for k in
                       ("version", "runtime_root", "defect_id", "issue", "batch_id", "merge_sha")):
        return path
    with _decision(paths):
        _atomic_json(path, request)
    return path


def _head(root: Path) -> str | None:
    result = _git(["rev-parse", "HEAD"], root)
    sha = result.stdout.strip() if result.returncode == 0 else ""
    return sha if re.fullmatch(r"[0-9a-f]{40}", sha) else None


def request_operator_restart(paths: Paths, code_sha: str) -> Path:
    """Request loading an already deployed commit, without asserting that an incident was fixed."""
    if not re.fullmatch(r"[0-9a-f]{40}", code_sha):
        raise ValueError("code SHA must be a full lowercase commit SHA")
    root = paths.repo_root.resolve()
    head = _head(root)
    status = _git(["status", "--porcelain", "--", "tools/warroom/warroom", "tools/warroom/prompts"], root)
    if head is None or status.returncode or status.stdout.strip() or not _ancestor(root, code_sha, head):
        raise ValueError("operating checkout must be clean and contain the requested code SHA")
    path = request_path(paths, 0)  # reserved for operator requests; no defect is associated
    with _decision(paths):
        current = _read_json(path)
        carried = {}
        if current and current.get("state") not in TERMINAL_REQUEST_STATES:
            if current.get("merge_sha") == code_sha or _ancestor(root, code_sha, current.get("merge_sha")):
                return path   # the pending request already covers this commit
            if not _ancestor(root, current.get("merge_sha"), code_sha):
                raise ValueError("another operator code reload is pending for an unrelated commit")
            carried = {k: current[k] for k in ("replace", "requested_restart_at", "previous_instance") if k in current}
        _atomic_json(path, {"version": 1, "state": "requested", "kind": "operator_code_reload",
                            "runtime_root": str(root), "defect_id": 0, "issue": None, "batch_id": None,
                            "merge_sha": code_sha, "loaded_code_sha": None, **carried})
    return path


def request_operator_replace(paths: Paths) -> Path:
    """`./kwar`: replace the Supervisor instance with the code the operating checkout holds NOW. It asks for no code
    update of its own; a code update that is already pending is carried out by the same single replacement. The request
    is complete only for an instance other than the one running at this moment, even at an unchanged SHA."""
    root = paths.repo_root.resolve()
    head = _head(root)
    if head is None:
        raise ValueError("운영 checkout의 HEAD를 읽을 수 없습니다")
    runtime = _read_json(paths.runtime_record_file) or {}
    path = request_path(paths, 0)
    with _decision(paths):
        current = _read_json(path)
        pending = current if current and current.get("state") not in TERMINAL_REQUEST_STATES else None
        if pending and pending.get("replace"):
            return path   # a replacement is already under way: join it, never restart its clock
        _atomic_json(path, {"version": 1, "state": "requested",
                            "kind": pending.get("kind") if pending else "operator_replace", "replace": True,
                            "runtime_root": str(root), "defect_id": 0, "issue": None, "batch_id": None,
                            "merge_sha": pending["merge_sha"] if pending else head, "loaded_code_sha": None,
                            "requested_restart_at": time.time(), "previous_instance": runtime.get("instance")})
    return path


def update_restart_request(paths: Paths, defect_id: int, state: str, **fields) -> bool:
    path = request_path(paths, defect_id)
    with _decision(paths):
        request = _read_json(path)
        if request is None or request.get("defect_id") != defect_id:
            return False
        request.update(fields, state=state, updated_at=time.time())
        _atomic_json(path, request)
    return True


def record_runtime(paths: Paths, code_sha: str | None, *, configured_workers: int = 1, workers: int | None = None,
                   instance: str | None = None) -> None:
    """`workers` is what this process actually runs (default: the configured count); `instance` ties the record to the
    fence/restart_phase instance, so an earlier instance's record or phase never vouches for this one (#3774)."""
    _atomic_json(paths.runtime_record_file, {
        "version": 1, "runtime_root": str(paths.repo_root.resolve()), "loaded_code_sha": code_sha,
        "pid": os.getpid(), "started_at": time.time(),
        "supervisor_workers": configured_workers if workers is None else workers,
        "configured_supervisor_workers": configured_workers, "instance": instance,
    })


TERMINAL_REQUEST_STATES = ("loaded", "progress_verified", "recovery_blocked", "cancelled")
_ANCESTORS: set[tuple[str, str, str]] = set()   # (root, older, newer) proven ancestors; a Git ancestry never reverses


def _loaded_already(root: Path, merge_sha, loaded_sha) -> bool:
    key = (str(root), str(merge_sha), str(loaded_sha))
    if key in _ANCESTORS:
        return True
    if _ancestor(root, merge_sha, loaded_sha):
        _ANCESTORS.add(key)
        return True
    return False


def pending_requests(paths: Paths, loaded_sha: str | None = None) -> list[dict]:
    """Durable restart requests still waiting to be carried out, skipping any whose merge the loaded code already contains."""
    out = []
    root = paths.repo_root.resolve()
    for path in sorted(paths.restart_requests.glob("restart-*.json")):
        request = _read_json(path)
        if request is None or request.get("state") in TERMINAL_REQUEST_STATES:
            continue
        if loaded_sha and _loaded_already(root, request.get("merge_sha"), loaded_sha):
            continue
        out.append(request)
    return out


def request_identity(paths: Paths, loaded_sha: str | None = None) -> str:
    """Stable id of the pending request SET (sorted ids + target SHAs); "" when nothing is pending. Includes the reserved
    operator code-reload id 0."""
    items = sorted((int(r.get("defect_id") or 0), str(r.get("merge_sha"))) for r in pending_requests(paths, loaded_sha))
    if not items:
        return ""
    return hashlib.sha256(json.dumps(items, separators=(",", ":")).encode("utf-8")).hexdigest()[:16]


def _git(args: list[str], root: Path, timeout: int = 10) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=root, capture_output=True, text=True, timeout=timeout)


def _ancestor(root: Path, older: str, newer: str) -> bool:
    if not (isinstance(older, str) and len(older) == 40 and isinstance(newer, str) and len(newer) == 40):
        return False
    return _git(["merge-base", "--is-ancestor", older, newer], root).returncode == 0


def _lock_held(path: Path) -> bool:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a+") as fh:
        try:
            fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return True
        finally:
            try:
                fcntl.flock(fh, fcntl.LOCK_UN)
            except OSError:
                pass
    return False


def _pid_alive(pid) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _request_files(paths: Paths, store: Store) -> list[Path]:
    paths.restart_requests.mkdir(parents=True, exist_ok=True)
    # The previous Supervisor persists restart_needed_<id> in the DB. Convert that already-authorized signal into
    # the durable cross-process request when the updated TUI starts.
    for defect in store.defects(("FIX_MERGED",)):
        if defect["merge_sha"] and store.get(f"restart_needed_{defect['id']}") is not None:
            write_restart_request(paths, defect, None)
    return sorted(paths.restart_requests.glob("restart-*.json"))


def has_pending_restart(paths: Paths) -> bool:
    return any((_read_json(path) or {}).get("state") not in
               ("loaded", "progress_verified", "recovery_blocked", "cancelled")
               for path in paths.restart_requests.glob("restart-*.json"))


def _is_new_instance(runtime: dict, old: dict | None, since: float) -> bool:
    """A restart succeeded only for a record written AFTER the kill by a different instance: the loaded SHA alone (or a
    surviving earlier record) is not proof that the new Supervisor passed its own startup checks."""
    started = runtime.get("started_at")
    if not isinstance(started, (int, float)) or started < since:
        return False
    previous = old.get("instance") if isinstance(old, dict) else None
    return previous is None or runtime.get("instance") != previous


def _live_runtime_owner(paths: Paths, store: Store, runtime: dict) -> bool:
    """Bind the recorded process to the current Supervisor instance and its live owned session."""
    instance = runtime.get("instance")
    phase = store.restart_phase()
    if (not isinstance(instance, str) or not instance or not phase or phase.get("instance") != instance
            or not _pid_alive(runtime.get("pid")) or not _lock_held(paths.lock)
            or owner_state(paths.children / instance) != "alive"):
        return False
    pane = _tmux(["display-message", "-p", "-t", TMUX_SUP, "#{pane_dead}"], timeout=2)
    pid = _tmux(["display-message", "-p", "-t", TMUX_SUP, "#{pane_pid}"], timeout=2)
    try:
        return (pane.returncode == 0 and pane.stdout.strip() == "0" and pid.returncode == 0
                and os.getpgid(int(pid.stdout.strip())) == os.getpgid(runtime["pid"]))
    except (OSError, TypeError, ValueError):
        return False


def _tmux(command: list[str], timeout=5) -> subprocess.CompletedProcess:
    return subprocess.run(["tmux", *command], capture_output=True, text=True, timeout=timeout)


def _set_waiting(paths: Paths, request: dict, reason: str, **fields) -> tuple[str, str]:
    with _decision(paths):
        _write_live(request_path(paths, int(request["defect_id"])),
                    {"state": "waiting", "blocker": reason, "checked_at": time.time(), **fields})
    return "starting", None


# ---- code update: what the next instance should run (decided while nothing is changed) ---------------------------
_BOOT_CHECK = (
    "import sys\n"
    "import warroom.supervisor, warroom.restart_controller\n"
    "from warroom.config import Paths, config_problem, load_config\n"
    "problem = config_problem(load_config(Paths()))\n"
    "sys.exit('config.json: ' + problem if problem else 0)\n")


def _boot_problem(paths: Paths, root: Path, sha: str | None) -> str | None:
    """Why the Supervisor code of commit `sha` (None: the operating checkout as it is) obviously cannot start: it does
    not import under the operating venv, or it rejects the operating config. The one pre-start check; it changes nothing
    in the checkout. Everything subtler is found by the new instance actually starting."""
    code, scratch = root / "tools" / "warroom", None
    try:
        if sha is not None:
            scratch = paths.supervisor_state / f"preflight-{sha[:12]}"
            shutil.rmtree(scratch, ignore_errors=True)
            scratch.mkdir(parents=True)
            archive = subprocess.run(["git", "archive", "--format=tar", sha, "tools/warroom/warroom"], cwd=root,
                                     capture_output=True, timeout=60)
            if archive.returncode:
                return "대상 commit의 Supervisor 코드를 읽을 수 없습니다"
            if subprocess.run(["tar", "-xf", "-", "-C", str(scratch)], input=archive.stdout, capture_output=True,
                              timeout=60).returncode:
                return "대상 commit의 Supervisor 코드를 풀 수 없습니다"
            code = scratch / "tools" / "warroom"
        env = {**os.environ, "PYTHONPATH": str(code), ROOT_ENV: str(root), "PYTHONDONTWRITEBYTECODE": "1"}
        check = subprocess.run([sys.executable, "-c", _BOOT_CHECK], cwd=root, env=env, capture_output=True, text=True,
                               timeout=120)
        if check.returncode == 0:
            return None
        lines = (check.stderr or check.stdout).strip().splitlines()
        return lines[-1][:300] if lines else f"exit {check.returncode}"
    except (OSError, subprocess.SubprocessError) as error:
        return f"{type(error).__name__}: {error}"
    finally:
        if scratch is not None:
            shutil.rmtree(scratch, ignore_errors=True)


def _update_target(paths: Paths, root: Path, head: str, wanted: list[str]) -> tuple[str | None, str | None]:
    """(commit to fast-forward the operating checkout to, None) or (None, why it cannot be done now). Read-only apart
    from `git fetch`: the checkout itself is only changed by `_fast_forward`, after the previous instance is gone."""
    try:
        base = load_config(paths)["base_branch"]
    except (OSError, ValueError, KeyError) as error:
        return None, f"config.json을 읽을 수 없습니다: {error}"
    problem = _branch_problem(root, base, head)
    if problem:
        return None, problem
    fetched = _git(["fetch", "origin", base], root, timeout=120)
    if fetched.returncode:
        return None, f"git fetch origin {base} 실패: {fetched.stderr.strip()[:200]}"
    tip = _git(["rev-parse", f"refs/remotes/origin/{base}"], root)
    target = tip.stdout.strip() if tip.returncode == 0 else ""
    if not re.fullmatch(r"[0-9a-f]{40}", target):
        return None, f"origin/{base}를 읽을 수 없습니다"
    if not _ancestor(root, head, target):
        return None, f"운영 checkout이 origin/{base}에서 갈라져 fast-forward 할 수 없습니다"
    missing = [sha for sha in wanted if not _ancestor(root, sha, target)]
    if missing:
        return None, f"요청한 수정 {missing[0][:10]}이 origin/{base}에 없습니다"
    problem = _checkout_problem(root, head, target)
    if problem is None and (boot := _boot_problem(paths, root, target)):
        problem = f"대상 코드 {target[:10]} 기동 검증 실패: {boot}"
    return (None, problem) if problem else (target, None)


def _branch_problem(root: Path, base: str, head: str) -> str | None:
    """The operating checkout must be ON the base branch AT the commit the update was planned from."""
    branch = _git(["symbolic-ref", "--quiet", "--short", "HEAD"], root)
    if branch.returncode or branch.stdout.strip() != base:
        return f"운영 checkout이 {base} 브랜치가 아닙니다"
    if _head(root) != head:
        return "운영 checkout의 HEAD가 갱신을 계획한 commit과 다릅니다"
    return None


def _checkout_problem(root: Path, head: str, target: str) -> str | None:
    """Why `git merge --ff-only target` must not be tried on this working tree (checked again right before it)."""
    status = _git(["status", "--porcelain", "--untracked-files=no"], root, timeout=60)
    if status.returncode or status.stdout.strip():
        return "운영 checkout에 커밋되지 않은 변경이 있습니다"
    added = _git(["diff", "--name-only", "--diff-filter=A", "-z", head, target], root, timeout=60)
    if added.returncode:
        return "들어올 변경을 읽을 수 없습니다"
    for name in filter(None, added.stdout.split("\0")):
        if os.path.lexists(root / name):
            return f"추적되지 않는 파일이 들어올 변경과 충돌합니다: {name}"
    if _git(["diff", "--quiet", head, target, "--", "pnpm-lock.yaml"], root, timeout=60).returncode:
        return "pnpm-lock.yaml이 바뀌어 의존성 설치가 먼저 필요합니다"
    return None


def _fast_forward(paths: Paths, root: Path, head: str, target: str) -> str | None:
    """Apply the update decided earlier, now that no Supervisor runs. The branch, the HEAD and the working tree are all
    examined again right here: the previous instance may have taken up to the whole grace to leave, and a checkout that
    moved meanwhile (another branch, another commit) is never advanced. Never reset, stash or force: a refusal leaves
    the checkout exactly as it was and the next instance starts on the current code."""
    try:
        base = load_config(paths)["base_branch"]
    except (OSError, ValueError, KeyError) as error:
        return f"config.json을 읽을 수 없습니다: {error}"
    problem = _branch_problem(root, base, head) or _checkout_problem(root, head, target)
    if problem:
        return problem
    merged = _git(["merge", "--ff-only", target], root, timeout=300)
    if merged.returncode or _head(root) != target:
        return f"git merge --ff-only {target[:10]} 실패: {(merged.stderr or merged.stdout).strip()[:200]}"
    return None


# ---- ending the previous instance ---------------------------------------------------------------------------------
def _command_of(pid: int) -> str:
    try:
        out = subprocess.run(["/bin/ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return ""
    return out.stdout.strip() if out.returncode == 0 else ""


def _sweep_group(pgid: int | None) -> None:
    """Make sure nothing of the ended Supervisor's own process group (a plain `gh`/`ps` child) outlives it into the next
    instance. A sweep, never a condition: the next instance starts whatever this finds."""
    if pgid is None or pgid <= 1 or pgid == os.getpgrp():
        return
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return
        except OSError:
            break
        time.sleep(0.1)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except OSError:
        pass


def _signal_supervisor(pid: int, group: int | None, sig) -> None:
    try:
        if group is not None and group > 1 and group != os.getpgrp():
            os.killpg(group, sig)
        else:
            os.kill(pid, sig)
    except OSError:
        pass


def _end_supervisor(paths: Paths, root: Path, runtime: dict | None) -> str | None:
    """End the Supervisor that holds the lock; None once the lock is free. Only a process identified as that Supervisor
    is signalled: the owned tmux session (its pane group is the recorded PID's group, or no live PID is recorded), else
    the recorded PID when it is a `warroom.supervisor` process. Its own process group is then swept; detached AI runs and
    fenced Git/Node children live in other groups and are left to the next instance."""
    pid = runtime.get("pid") if isinstance(runtime, dict) and runtime.get("runtime_root") == str(root) else None
    pid = pid if _pid_alive(pid) else None
    try:
        group = os.getpgid(pid) if pid is not None else None
    except OSError:
        group = None
    pane_group = None
    if _tmux(["has-session", "-t", TMUX_SUP]).returncode == 0:
        pane = _tmux(["display-message", "-p", "-t", TMUX_SUP, "#{pane_dead}"], timeout=2)
        shown = _tmux(["display-message", "-p", "-t", TMUX_SUP, "#{pane_pid}"], timeout=2)
        try:
            if pane.returncode == 0 and pane.stdout.strip() == "0" and shown.returncode == 0:
                pane_group = os.getpgid(int(shown.stdout.strip()))
        except (OSError, ValueError):
            pane_group = None
    if pane_group is not None and (pid is None or pane_group == group):
        group = pane_group
        killed = _tmux(["kill-session", "-t", TMUX_SUP], timeout=5)
        if killed.returncode and _tmux(["has-session", "-t", TMUX_SUP]).returncode == 0:
            return "소유한 Supervisor tmux 세션을 종료하지 못했습니다"
    elif pid is not None and "warroom.supervisor" in _command_of(pid):
        _signal_supervisor(pid, group, signal.SIGTERM)
    else:
        return "Supervisor lock을 쥔 프로세스를 식별할 수 없어 종료하지 않았습니다 (tmux 세션·runtime 기록 불일치)"
    deadline = time.monotonic() + STARTUP_TIMEOUT
    while time.monotonic() < deadline and _lock_held(paths.lock):
        time.sleep(0.25)
    if _lock_held(paths.lock) and pid is not None:
        _signal_supervisor(pid, group, signal.SIGKILL)
        time.sleep(1)
    if _lock_held(paths.lock):
        return "Supervisor를 종료했지만 lock이 풀리지 않았습니다"
    _sweep_group(group)
    return None


def _published(paths: Paths, store: Store, runtime: dict | None) -> dict | None:
    """The live instance's own restart_phase, or None while the lock holder has not published one (still starting)."""
    phase = store.restart_phase()
    if (phase is None or not isinstance(phase.get("instance"), str) or not isinstance(runtime, dict)
            or runtime.get("instance") != phase["instance"] or not _pid_alive(runtime.get("pid"))
            or owner_state(paths.children / phase["instance"]) != "alive"):
        return None
    return phase


def _start_supervisor(paths: Paths, store: Store, root: Path, old_runtime: dict | None) -> tuple[dict | None, str]:
    """Start the Supervisor session: (runtime record of the NEW live instance or None when not verified yet, what an
    earlier failed start left on its pane - the reason a start keeps failing must not vanish with the session)."""
    left = ""
    if _tmux(["has-session", "-t", TMUX_SUP]).returncode == 0:
        pane = _tmux(["display-message", "-p", "-t", TMUX_SUP, "#{pane_dead}"], timeout=2)
        if pane.returncode == 0 and pane.stdout.strip() == "0":
            time.sleep(2)   # another launcher's Supervisor may be about to take the lock: never kill that
            if _lock_held(paths.lock):
                return None, left
        else:
            shown = _tmux(["capture-pane", "-p", "-t", TMUX_SUP], timeout=2)
            if shown.returncode == 0:
                left = " / ".join(redact(line) for line in shown.stdout.strip().splitlines()[-4:])[:400]
        _tmux(["kill-session", "-t", TMUX_SUP], timeout=5)
    mark = time.time()
    wr = str(root / "tools" / "warroom")
    supervisor_command = shlex.join(["env", f"PYTHONPATH={wr}", f"{ROOT_ENV}={root}", sys.executable, "-m", "warroom.supervisor"])
    command = f"tmux set-window-option -t {TMUX_SUP} remain-on-exit failed && {supervisor_command}"
    started = _tmux(["new-session", "-d", "-s", TMUX_SUP, "-c", str(root), command], timeout=5)
    if started.returncode and _tmux(["has-session", "-t", TMUX_SUP]).returncode != 0:
        return None, left
    deadline = time.monotonic() + STARTUP_TIMEOUT
    while time.monotonic() < deadline:
        runtime = _read_json(paths.runtime_record_file)
        if (runtime and runtime.get("runtime_root") == str(root) and _is_new_instance(runtime, old_runtime, mark)
                and _live_runtime_owner(paths, store, runtime)):
            return runtime, left
        time.sleep(1)
    return None, left


def _request_loaded(paths: Paths, store: Store, root: Path, request: dict, runtime: dict | None) -> bool:
    """A request is carried out only by a live instance that holds its commit AND, once a replacement was asked for or
    begun, is a different instance started after that moment. A surviving earlier record proves nothing."""
    return bool(runtime and runtime.get("runtime_root") == str(root)
                and _ancestor(root, request["merge_sha"], runtime.get("loaded_code_sha", ""))
                and _live_runtime_owner(paths, store, runtime)
                and (request.get("requested_restart_at") is None
                     or _is_new_instance(runtime, {"instance": request.get("previous_instance")},
                                         request["requested_restart_at"])))


def _mark_loaded(paths: Paths, path: Path, runtime: dict) -> None:
    with _decision(paths):
        _write_live(path, {"state": "loaded", "loaded_code_sha": runtime.get("loaded_code_sha"),
                           "supervisor_pid": runtime.get("pid"), "supervisor_instance": runtime.get("instance"),
                           "loaded_at": time.time(), "checked_at": time.time(), "blocker": None})


def handle_pending_restart(paths: Paths, store: Store) -> tuple[str, str | None] | None:
    """Carry the pending requests one step further; safe to call again at any point (the TUI does, every few seconds).

    None: nothing to do here (the caller may start a missing Supervisor). ("locked", None): a Supervisor runs and stays.
    ("starting", None): a replacement is under way. Nothing here asks whether other Lines are busy."""
    root = paths.repo_root.resolve()
    runtime = _read_json(paths.runtime_record_file)
    pending = []
    for path in _request_files(paths, store):
        request = _read_json(path)
        if request is None or request.get("state") in TERMINAL_REQUEST_STATES:
            continue   # a finished request never blocks a start
        if request.get("runtime_root") != str(root) or not isinstance(request.get("merge_sha"), str):
            _set_waiting(paths, request, "restart request is malformed or belongs to another runtime root")
            continue   # one unusable request never holds the others
        if _request_loaded(paths, store, root, request, runtime):
            _mark_loaded(paths, path, runtime)
            continue
        pending.append((path, request))

    live = _lock_held(paths.lock)
    phase = _published(paths, store, runtime) if live else None
    stopping = phase is not None and phase.get("phase") == "STOPPING"
    if not pending and not stopping:
        # A durable loaded record outlives its process: let the normal launcher recover a stopped Supervisor.
        return ("locked", None) if live else None

    tui_root = _tmux(["show-environment", "-t", "=warroom", ROOT_ENV], timeout=2)   # exact: never `warroom-supervisor`
    if tui_root.returncode == 0 and tui_root.stdout.strip().partition("=")[2] != str(root):
        for _path, request in pending:
            _set_waiting(paths, request, "live TUI runtime root does not match the operating checkout")
        return ("locked", None) if live else None
    if live:
        try:
            live_root = paths.runtime_root_file.read_text("utf-8").strip()
        except OSError:
            live_root = ""
        if live_root != str(root):
            for _path, request in pending:
                _set_waiting(paths, request, "live Supervisor runtime root does not match the operating checkout")
            return "locked", None

    # 1. What the next instance should run. A code update that cannot be applied is set aside, never a reason to wait
    #    with the replacement of an instance that was asked for (or of one that is not running at all).
    head = _head(root)
    replace = any(request.get("replace") for _path, request in pending)
    behind = [(path, request) for path, request in pending
              if head is None or not _ancestor(root, request["merge_sha"], head)]
    target, why = head, None
    now = time.time()
    if behind and head is not None:
        if not replace and all(float(request.get("retry_after") or 0) > now for _path, request in behind):
            why = behind[0][1].get("blocker") or "코드 갱신 재시도 대기"
        else:
            target, why = _update_target(paths, root, head, [request["merge_sha"] for _path, request in behind])
            if why:
                target = head
    elif behind:
        why = "운영 checkout의 HEAD를 읽을 수 없습니다"
    if why:
        for _path, request in behind:
            _set_waiting(paths, request, f"코드 갱신 보류(현재 코드로 계속 운영): {why}", retry_after=now + CODE_RETRY_SECONDS)
        store.log_once(None, f"Supervisor 코드 갱신 보류(현재 코드로 계속 운영): {why}", "warn", line="maintainer")
    # A request whose commit the checkout holds is acted on once per checkout HEAD: an instance that was already replaced
    # for it and still cannot prove the commit loaded (e.g. modified runtime source) is not replaced again and again.
    def due(request) -> bool:
        if request.get("replace"):
            return True
        if float(request.get("retry_after") or 0) > now:
            return False
        return not (request.get("attempted_head") == head and isinstance(runtime, dict)
                    and _is_new_instance(runtime, {"instance": request.get("previous_instance")},
                                         request.get("requested_restart_at") or float("inf")))
    ready = [request for item in pending if item not in behind and due(request := item[1])]
    actionable = stopping or bool(ready) or target != head
    if live and not actionable:
        return "locked", None

    # 2. The live instance: STOPPING (once), at most HANDOFF_GRACE for its Workers, then it is ended.
    if live:
        if phase is None:
            # The lock holder has published nothing: a Supervisor still starting (give it its startup time; it writes
            # runtime-root right after taking the lock) or one this code cannot talk to (ended without a grace it could
            # not use).
            try:
                begun = paths.runtime_root_file.stat().st_mtime
            except OSError:
                begun = 0
            if now - begun < 3 * STARTUP_TIMEOUT:
                return "starting", None
        elif not stopping:
            if target == head and (problem := _boot_problem(paths, root, None)):
                reason = f"현재 코드가 기동 검증에 실패해 실행 중인 Supervisor를 유지합니다: {problem}"
                for path, request in pending:
                    if request.get("replace") and (path, request) not in behind:
                        with _decision(paths):   # an operator replace is answered once, not retried for ever
                            _write_live(path, {"state": "cancelled", "blocker": reason, "checked_at": now})
                    else:
                        _set_waiting(paths, request, reason, retry_after=now + CODE_RETRY_SECONDS)
                store.log_once(None, f"Supervisor 재시작 보류: {reason}", "error", line="maintainer")
                return "locked", None
            group = None
            try:
                group = os.getpgid(runtime["pid"])
            except (OSError, KeyError, TypeError):
                pass
            with _decision(paths):
                # The single decision point: request files are re-read HERE, under the lock every withdrawal takes.
                still = [path for path, _request in pending
                         if (_read_json(path) or {}).get("state") not in TERMINAL_REQUEST_STATES]
                if not still:
                    return "locked", None
                moved = store.cas_restart_phase(phase, "STOPPING", request_identity(paths), stopping_at=now)
                if moved is None:
                    return "starting", None   # the phase moved under us: the next call reads it again
                for path in still:
                    current = _read_json(path) or {}
                    fields = {"state": "restarting", "blocker": None, "previous_pid": runtime.get("pid"),
                              "previous_group": group}
                    if current.get("requested_restart_at") is None:
                        fields.update(requested_restart_at=now, previous_instance=runtime.get("instance"))
                    _write_live(path, fields)
            store.log(None, f"Restart: STOPPING 요청 (최대 {HANDOFF_GRACE}초 유예 후 종료, 남은 작업은 새 instance가 이어서 처리)", "warn")
            phase = moved
        if phase is not None and now < float(phase.get("stopping_at") or 0) + HANDOFF_GRACE and _lock_held(paths.lock):
            return "starting", None
        if _lock_held(paths.lock):
            problem = _end_supervisor(paths, root, runtime)
            if problem:
                for path, request in pending:
                    if request.get("replace"):
                        with _decision(paths):
                            _write_live(path, {"state": "cancelled", "blocker": problem, "checked_at": time.time()})
                    else:
                        _set_waiting(paths, request, problem)
                store.log_once(None, f"Supervisor 재시작 실패: {problem}", "error", line="maintainer")
                return "starting", None

    # 3. No Supervisor runs now: this is the only moment the operating checkout changes.
    if target is not None and head is not None and target != head:
        problem = _fast_forward(paths, root, head, target)
        if problem:
            for _path, request in behind:
                _set_waiting(paths, request, f"코드 갱신 보류(현재 코드로 계속 운영): {problem}",
                             retry_after=time.time() + CODE_RETRY_SECONDS)
            store.log_once(None, f"Supervisor 코드 갱신 보류(현재 코드로 계속 운영): {problem}", "warn", line="maintainer")

    # 4. The next instance, whatever the above achieved: the line runs again first, requests are settled after.
    with _decision(paths):
        for path, _request in pending:
            current = _read_json(path) or {}
            fields = {"attempted_head": _head(root)}
            if current.get("requested_restart_at") is None:
                fields.update(requested_restart_at=time.time(),
                              previous_instance=(runtime or {}).get("instance") if live else None)
            _write_live(path, fields)
    loaded, left = _start_supervisor(paths, store, root, runtime)
    if loaded is None:
        note = ("새 Supervisor가 시작 중입니다 (fence 복구 중일 수 있음) — 자체 runtime 기록이 확인된 뒤에만 loaded로 기록합니다"
                if _lock_held(paths.lock) else "새 Supervisor의 기동이 확인되지 않았습니다 (warroom-supervisor 세션 출력 확인)")
        if left:
            note += f" · 직전 기동 실패 출력: {left}"
            store.log_once(None, f"Supervisor 기동 실패 출력: {left}", "error", line="maintainer")
        with _decision(paths):
            for path, _request in pending:
                current = _read_json(path) or {}
                if current.get("state") == "restarting" or not current.get("blocker"):
                    _write_live(path, {"state": "waiting", "blocker": note, "checked_at": time.time()})
        return "starting", None
    for path, request in pending:
        if _ancestor(root, request["merge_sha"], loaded.get("loaded_code_sha", "")):
            _mark_loaded(paths, path, loaded)
        else:
            with _decision(paths):   # the instance was replaced; only the code update is still owed
                current = _read_json(path) or {}
                _write_live(path, {"state": "waiting", "replace": False, "checked_at": time.time(),
                                   "blocker": current.get("blocker") or "새 instance가 요청한 수정을 아직 포함하지 않습니다"})
    return "starting", None


def _replace(paths: Paths) -> int:
    """`--replace` (`./kwar`): 0 only when a NEW live instance is verified; 1 refused/failed; 2 not finished in time."""
    from .supervisor import acquire_lock
    store = Store(paths.db)
    before, mark = _read_json(paths.runtime_record_file) or {}, time.time()
    try:
        path = request_operator_replace(paths)
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"[kwar] 재시작 요청 실패: {error}", file=sys.stderr)
        return 1
    deadline = time.monotonic() + HANDOFF_GRACE + 4 * STARTUP_TIMEOUT
    said = None
    while True:
        lock = acquire_lock(paths.local / "supervisor-launch.lock")
        if lock is not None:   # otherwise the TUI is carrying the same request out right now
            try:
                handle_pending_restart(paths, store)
            finally:
                lock.close()
        runtime = _read_json(paths.runtime_record_file)
        request = _read_json(path) or {}
        if runtime and _is_new_instance(runtime, before, mark) and _live_runtime_owner(paths, store, runtime):
            print(f"[kwar] Supervisor 교체 완료: instance {str(runtime.get('instance'))[:8]} · pid {runtime.get('pid')} · "
                  f"code {str(runtime.get('loaded_code_sha'))[:10]}")
            for other in sorted(paths.restart_requests.glob("restart-*.json")):
                left = _read_json(other) or {}
                if left.get("state") not in TERMINAL_REQUEST_STATES and left.get("blocker"):
                    print(f"[kwar] 경고: 대기 중인 요청 {other.stem} — {left['blocker']}", file=sys.stderr)
            return 0
        if request.get("state") == "cancelled":
            print(f"[kwar] 재시작 실패 (실행 중인 작업은 보존됨): {request.get('blocker')}", file=sys.stderr)
            return 1
        phase = store.restart_phase() or {}
        line = request.get("blocker") or {"requested": "요청 접수", "restarting": "기존 Supervisor 종료 대기"}.get(
            request.get("state"), str(request.get("state")))
        if phase.get("phase") == "STOPPING" and _lock_held(paths.lock):
            line = f"기존 Supervisor STOPPING — 최대 {HANDOFF_GRACE}초 후 종료합니다"
        if line != said:
            print(f"[kwar] {line}")
            said = line
        if time.monotonic() >= deadline:
            print("[kwar] 제한 시간 안에 새 Supervisor를 확인하지 못했습니다. 실행 중인 작업은 보존되며 TUI가 계속 복구를 "
                  "시도합니다 — 성공으로 간주하지 마세요.", file=sys.stderr)
            return 2
        time.sleep(1)


def main() -> int:
    """Launcher entry point: `./war` (one step before attaching), the TUI (`--json`) and `./kwar` (`--replace`)."""
    paths = Paths()
    paths.ensure()
    args = sys.argv[1:]
    if args == ["--replace"]:
        return _replace(paths)
    as_json = args == ["--json"]
    if not (as_json or not args or (len(args) == 2 and args[0] == "--request-code-sha")):
        raise SystemExit("usage: python -m warroom.restart_controller [--replace | --json | --request-code-sha FULL_SHA]")
    from .supervisor import acquire_lock
    lock = acquire_lock(paths.local / "supervisor-launch.lock")
    result = ("starting", None)   # another launcher is checking/starting the shared session
    if lock is not None:
        try:
            if len(args) == 2:
                request_operator_restart(paths, args[1])
            result = handle_pending_restart(paths, Store(paths.db))
        finally:
            lock.close()
    if as_json:
        print(json.dumps({"result": result}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
