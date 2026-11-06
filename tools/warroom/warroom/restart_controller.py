"""Out-of-process, fail-closed Supervisor restart controller.

The TUI is a separate process from the Supervisor and remains alive while the Supervisor's own Python code is replaced.
It can restart only the operating-root Supervisor tmux session after durable request and worker/control checks pass.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
from contextlib import contextmanager
from pathlib import Path

from .config import Paths, ROOT_ENV
from .fence import owner_state
from .store import MAINTENANCE_METHOD, Store

TMUX_SUP = "warroom-supervisor"
STARTUP_TIMEOUT = 20


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


def request_operator_restart(paths: Paths, code_sha: str) -> Path:
    """Request loading an already deployed commit, without asserting that an incident was fixed."""
    if not re.fullmatch(r"[0-9a-f]{40}", code_sha):
        raise ValueError("code SHA must be a full lowercase commit SHA")
    root = paths.repo_root.resolve()
    head = _git(["rev-parse", "HEAD"], root)
    status = _git(["status", "--porcelain", "--", "tools/warroom/warroom", "tools/warroom/prompts"], root)
    if head.returncode or status.returncode or status.stdout.strip() or not _ancestor(root, code_sha, head.stdout.strip()):
        raise ValueError("operating checkout must be clean and contain the requested code SHA")
    path = request_path(paths, 0)  # reserved for operator code reload; no defect is associated
    current = _read_json(path)
    if current and current.get("state") not in ("loaded", "cancelled"):
        if current.get("merge_sha") == code_sha:
            return path
        raise ValueError("another operator code reload is pending")
    with _decision(paths):
        _atomic_json(path, {"version": 1, "state": "requested", "kind": "operator_code_reload",
                            "runtime_root": str(root), "defect_id": 0, "issue": None, "batch_id": None,
                            "merge_sha": code_sha, "loaded_code_sha": None})
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
    fence/restart_phase instance, so an earlier instance's record or READY never vouches for this one (#3774)."""
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


def policy_blocker(store: Store) -> str | None:
    """Policy that forbids (or revokes) a restart even when no work is live."""
    for batch in store.incomplete_batches():
        if store.get(f"defect_hold_{batch['id']}"):
            return f"defect hold is active on batch {batch['id']}"
    return None


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


def _live_work_or_controls(store: Store, *, recovering_stopped_supervisor: bool = False) -> str | None:
    batches = store.incomplete_batches()
    for batch in batches:
        open_runs = [r for r in store.runs(batch["id"]) if r["ended_at"] is None]
        def finished(run):
            if _pid_alive(run["pid"]) or not run["exit_file"]:
                return False
            try:
                int(Path(run["exit_file"]).read_text("utf-8").strip())
                return True
            except (OSError, ValueError):
                return False
        recorded_pid = batch["pid"]
        proven = (recovering_stopped_supervisor and all(finished(r) for r in open_runs)
                  and (recorded_pid is None or any(r["pid"] == recorded_pid for r in open_runs)))
        if (recorded_pid is not None or open_runs) and not proven:
            return f"batch {batch['id']} still has an AI/task process or unclosed run"
    for line in store.lines():
        # A dead Supervisor must be allowed to consume pending Stop requests, after all workers above are
        # proven finished. The Stop flag stays set; the restarted Supervisor remains responsible for it.
        if line["force_stop"] and not recovering_stopped_supervisor:
            return f"operator Stop is active on {line['model']}/{line['method']}"
        # A stopped Supervisor must be able to consume a previously requested Clear after every worker is
        # proven finished. Its ordinary Clear path still validates ownership and preserves blocked requests.
        if store.clear_request(line["model"], line["method"]) is not None and not recovering_stopped_supervisor:
            return f"operator Clear is active on {line['model']}/{line['method']}"
        if (store.get(f"stop_pin_{line['model']}_{line['method']}") is not None
                and not recovering_stopped_supervisor):
            return f"operator Stop pin is active on {line['model']}/{line['method']}"
    for batch in batches:
        if store.get(f"defect_hold_{batch['id']}"):
            return f"defect hold is active on batch {batch['id']}"
    return None


def _worktree_ownership_problem(paths: Paths, store: Store, *, recovering_stopped_supervisor: bool = False) -> str | None:
    result = _git(["worktree", "list", "--porcelain"], paths.repo_root, timeout=10)
    if result.returncode:
        return "worktree ownership could not be read"
    owned = {}
    current = None
    for line in result.stdout.splitlines():
        if line.startswith("worktree "):
            current = line[len("worktree "):]
            owned[current] = None
        elif line.startswith("branch ") and current is not None:
            owned[current] = line[len("branch "):]
    for batch in store.incomplete_batches():
        raw = batch["worktree"]
        if not raw:
            continue
        path = Path(raw)
        if not path.exists():
            if batch["state"] == "PREPARE":
                continue
            req = store.clear_request(batch["producer"], batch["method"])
            branch = batch["branch"]
            expected = (f"maint-{batch['batch']}" if batch["method"] == MAINTENANCE_METHOD else
                        f"{batch['method']}-{batch['producer']}-{batch['shard']}-{batch['batch']}")
            maint = store.maintenance(int(batch["batch"])) if (batch["method"] == MAINTENANCE_METHOD
                                                               and str(batch["batch"]).isdigit()) else None
            try:
                rel = path.resolve().relative_to(paths.worktrees.resolve())
            except ValueError:
                rel = Path(".")
            ref = f"refs/heads/{branch}"
            if (recovering_stopped_supervisor and batch["state"] == "CLEARING" and req is not None
                    and req["batch_id"] == batch["id"] and req["model"] == batch["producer"]
                    and req["method"] == batch["method"] and branch == expected and rel.parts
                    and (batch["method"] != MAINTENANCE_METHOD or (maint is not None and maint["batch_id"] == batch["id"]))
                    and str(path.resolve()) not in owned and ref not in owned.values()
                    and _git(["show-ref", "--verify", "--quiet", ref], paths.repo_root).returncode == 1):
                continue
            return f"owned worktree for batch {batch['id']} is missing"
        if owned.get(str(path.resolve())) != f"refs/heads/{batch['branch']}":
            return f"worktree ownership differs for batch {batch['id']}"
    return None


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


def _is_serial_runtime(runtime: dict | None) -> bool:
    return isinstance(runtime, dict) and runtime.get("supervisor_workers") == 1


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


def _ready_problem(paths: Paths, store: Store, runtime: dict | None, pending) -> tuple[str | None, dict | None]:
    """Why a live parallel Supervisor may not be stopped yet (None: its current instance is READY, or already STOPPING
    for this very request set after a failed kill)."""
    phase = store.restart_phase()
    if phase is None:
        return "Supervisor has not published a restart_phase (waiting for READY)", None
    instance = phase.get("instance")
    if not isinstance(instance, str) or owner_state(paths.children / instance) != "alive":
        return "restart_phase belongs to an instance that is not running; it is no evidence about the live Supervisor", None
    if isinstance(runtime, dict) and runtime.get("instance") not in (None, instance):
        return "runtime record and restart_phase name different instances", None
    loaded = runtime.get("loaded_code_sha") if isinstance(runtime, dict) else None
    identity = request_identity(paths, loaded)
    if not identity or phase.get("request") != identity:
        return "restart_phase request identity differs from the pending request set", None
    if phase.get("phase") in ("READY", "STOPPING"):
        return None, phase
    return f"Supervisor is {phase.get('phase')}; waiting for READY (in-flight Workers and AI runs finish first)", None


def _to_stopping(store: Store, phase: dict | None) -> bool:
    if phase is None:
        return False
    if phase.get("phase") == "STOPPING":
        return True
    return store.cas_restart_phase(phase, "STOPPING", phase["request"]) is not None


def _tmux(command: list[str], timeout=5) -> subprocess.CompletedProcess:
    return subprocess.run(["tmux", *command], capture_output=True, text=True, timeout=timeout)


def _set_waiting(paths: Paths, request: dict, reason: str) -> tuple[str, str]:
    with _decision(paths):
        _write_live(request_path(paths, int(request["defect_id"])),
                    {"state": "waiting", "blocker": reason, "checked_at": time.time()})
    return "starting", None


def handle_pending_restart(paths: Paths, store: Store) -> tuple[str, str | None] | None:
    """Service a durable request while the operating-root TUI remains alive."""
    requests = []
    for path in _request_files(paths, store):
        request = _read_json(path)
        if request is None or request.get("state") in ("progress_verified", "recovery_blocked", "cancelled"):
            continue
        requests.append((path, request))
    if not requests:
        return None

    root = paths.repo_root.resolve()
    for path, request in requests:
        if request.get("runtime_root") != str(root) or not isinstance(request.get("merge_sha"), str):
            return _set_waiting(paths, request, "restart request is malformed or belongs to another runtime root")
        head_result = _git(["rev-parse", "HEAD"], root)
        if head_result.returncode or not _ancestor(root, request["merge_sha"], head_result.stdout.strip()):
            return _set_waiting(paths, request, "operating checkout does not contain the requested merge")
        runtime = _read_json(paths.runtime_record_file)
        if (runtime and runtime.get("runtime_root") == str(root)
                and _ancestor(root, request["merge_sha"], runtime.get("loaded_code_sha", ""))
                and _live_runtime_owner(paths, store, runtime)
                and (request.get("requested_restart_at") is None
                     or _is_new_instance(runtime, {"instance": request.get("previous_instance")},
                                         request["requested_restart_at"]))):
            with _decision(paths):
                _write_live(path, {"state": "loaded", "loaded_code_sha": runtime.get("loaded_code_sha"),
                                   "supervisor_pid": runtime.get("pid"), "supervisor_instance": runtime.get("instance"),
                                   "checked_at": time.time(), "blocker": None})
            continue

    pending = [(path, request) for path, request in requests
               if (_read_json(path) or {}).get("state") not in
               ("loaded", "progress_verified", "recovery_blocked", "cancelled")]
    if not pending:
        # A durable loaded record outlives its process. Let the normal launcher
        # recover a stopped Supervisor instead of mistaking that record for a lock.
        return ("locked", None) if _lock_held(paths.lock) else None

    recovering = not _lock_held(paths.lock)
    runtime_now = _read_json(paths.runtime_record_file)
    # A live parallel Supervisor is never judged by "no work is running": only its own READY proves that. A missing,
    # damaged or inconsistent runtime record is not a reason to take the serial rule (workers must be proven 1 for that).
    parallel_live = not recovering and not _is_serial_runtime(runtime_now)
    ready = None
    if parallel_live:
        blocker, ready = _ready_problem(paths, store, runtime_now, pending)
        blocker = blocker or policy_blocker(store) or _worktree_ownership_problem(paths, store)
    else:
        blocker = (_live_work_or_controls(store, recovering_stopped_supervisor=recovering)
                   or _worktree_ownership_problem(paths, store, recovering_stopped_supervisor=recovering))
    if blocker:
        for path, request in pending:
            _set_waiting(paths, request, blocker)
        store.log_once(None, f"Supervisor 자동 재시작 대기: {blocker}", "warn", line="maintainer")
        return "starting", None

    tui_root = _tmux(["show-environment", "-t", "warroom", ROOT_ENV], timeout=2)
    if tui_root.returncode == 0:
        observed = tui_root.stdout.strip().partition("=")[2]
        if observed != str(root):
            return _set_waiting(paths, pending[0][1], "live TUI runtime root does not match the operating checkout")

    if _lock_held(paths.lock):
        if not parallel_live and (blocker := _live_work_or_controls(store)):
            return _set_waiting(paths, pending[0][1], blocker)
        # The supervisor is live; it may only be replaced after the exact shared tmux session and operating root pass.
        try:
            live_root = paths.runtime_root_file.read_text("utf-8").strip()
        except OSError:
            live_root = ""
        if live_root != str(root):
            return _set_waiting(paths, pending[0][1], "live Supervisor runtime root does not match the operating checkout")
        runtime = _read_json(paths.runtime_record_file)
        if (runtime is None or runtime.get("runtime_root") != str(root)
                or not _pid_alive(runtime.get("pid"))):
            return _set_waiting(paths, pending[0][1], "live Supervisor process identity cannot be verified")
        has = _tmux(["has-session", "-t", TMUX_SUP])
        if has.returncode:
            return _set_waiting(paths, pending[0][1], "Supervisor lock is live but its owned tmux session is unavailable")
        pane = _tmux(["display-message", "-p", "-t", TMUX_SUP, "#{pane_dead}"], timeout=2)
        if pane.returncode or pane.stdout.strip() != "0":
            return _set_waiting(paths, pending[0][1], "owned Supervisor tmux pane is not live")
        pane_pid = _tmux(["display-message", "-p", "-t", TMUX_SUP, "#{pane_pid}"], timeout=2)
        try:
            same_pane = (pane_pid.returncode == 0
                         and os.getpgid(int(pane_pid.stdout.strip())) == os.getpgid(runtime["pid"]))
        except (OSError, TypeError, ValueError):
            same_pane = False
        if not same_pane:
            return _set_waiting(paths, pending[0][1], "Supervisor lock owner differs from the owned tmux pane")

    old_runtime = runtime_now
    restart_mark = time.time()
    denied = None
    with _decision(paths):
        # The single decision point. Request files are re-read HERE, under the same lock every withdrawal/new request
        # takes: a cancel or a changed request set that landed after the READY check is seen now, and one that lands later
        # is too late. Only then the Controller turns READY into STOPPING (never reverted; a failed kill is retried).
        if parallel_live:
            loaded_sha = runtime_now.get("loaded_code_sha") if isinstance(runtime_now, dict) else None
            if request_identity(paths, loaded_sha) != (ready or {}).get("request"):
                denied = "restart request was withdrawn or changed after READY"
            else:
                denied = policy_blocker(store) or (None if _to_stopping(store, ready)
                                                   else "READY was cancelled or superseded before STOPPING")
        if denied is None:
            written = [_write_live(path, {"state": "restarting", "blocker": None, "requested_restart_at": restart_mark,
                                         "previous_instance": (old_runtime or {}).get("instance")})
                       for path, _ in pending]
            if not any(written):
                denied = "restart request was withdrawn before the restart"
    if denied:
        return _set_waiting(paths, pending[0][1], denied)

    # Only the Supervisor session is replaced. The separate TUI/controller and production worker processes are preserved.
    if _tmux(["has-session", "-t", TMUX_SUP]).returncode == 0:
        killed = _tmux(["kill-session", "-t", TMUX_SUP], timeout=5)
        if killed.returncode and _tmux(["has-session", "-t", TMUX_SUP]).returncode == 0:
            return _set_waiting(paths, pending[0][1], "could not stop the owned Supervisor tmux session")

    deadline = time.monotonic() + STARTUP_TIMEOUT
    while time.monotonic() < deadline and _lock_held(paths.lock):
        time.sleep(0.25)
    if _lock_held(paths.lock):
        return _set_waiting(paths, pending[0][1], "Supervisor lock did not release after the owned session stopped")

    wr = str(root / "tools" / "warroom")
    py = sys.executable
    supervisor_command = shlex.join(["env", f"PYTHONPATH={wr}", f"{ROOT_ENV}={root}", py, "-m", "warroom.supervisor"])
    command = f"tmux set-window-option -t {TMUX_SUP} remain-on-exit failed && {supervisor_command}"
    started = _tmux(["new-session", "-d", "-s", TMUX_SUP, "-c", str(root), command], timeout=5)
    if started.returncode and _tmux(["has-session", "-t", TMUX_SUP]).returncode != 0:
        return _set_waiting(paths, pending[0][1], "updated Supervisor could not be started")

    deadline = time.monotonic() + STARTUP_TIMEOUT
    loaded = None
    while time.monotonic() < deadline:
        runtime = _read_json(paths.runtime_record_file)
        if (runtime and runtime.get("runtime_root") == str(root)
                and _is_new_instance(runtime, old_runtime, restart_mark)
                and all(_ancestor(root, req["merge_sha"], runtime.get("loaded_code_sha", "")) for _, req in pending)
                and _live_runtime_owner(paths, store, runtime)):
            loaded = runtime
            break
        time.sleep(1)
    if loaded is None:
        # Not a success record, and not necessarily a failure: a recovering instance records itself only after its fence scan.
        if _lock_held(paths.lock):
            return _set_waiting(paths, pending[0][1], "updated Supervisor is starting (fence recovery may still be running); "
                                "it is not recorded as loaded until its own runtime record verifies")
        return _set_waiting(paths, pending[0][1], "updated Supervisor runtime root/loaded code SHA did not verify")
    with _decision(paths):
        for path, _request in pending:
            _write_live(path, {"state": "loaded", "loaded_code_sha": loaded.get("loaded_code_sha"),
                               "supervisor_pid": loaded.get("pid"), "supervisor_instance": loaded.get("instance"),
                               "loaded_at": time.time(), "blocker": None})
    return "starting", None


def main() -> int:
    """One-shot launcher entry point used by ./war before attaching to an existing TUI session."""
    paths = Paths()
    paths.ensure()
    from .supervisor import acquire_lock
    lock = acquire_lock(paths.local / "supervisor-launch.lock")
    if lock is None:
        return 0
    try:
        if len(sys.argv) == 3 and sys.argv[1] == "--request-code-sha":
            request_operator_restart(paths, sys.argv[2])
        elif len(sys.argv) != 1:
            raise SystemExit("usage: python -m warroom.restart_controller [--request-code-sha FULL_SHA]")
        handle_pending_restart(paths, Store(paths.db))
    finally:
        lock.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
