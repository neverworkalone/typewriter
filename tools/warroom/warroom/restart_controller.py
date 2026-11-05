"""Out-of-process, fail-closed Supervisor restart controller.

The TUI is a separate process from the Supervisor and remains alive while the Supervisor's own Python code is replaced.
It can restart only the operating-root Supervisor tmux session after durable request and worker/control checks pass.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

from .config import Paths, ROOT_ENV
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
    _atomic_json(path, {"version": 1, "state": "requested", "kind": "operator_code_reload",
                        "runtime_root": str(root), "defect_id": 0, "issue": None, "batch_id": None,
                        "merge_sha": code_sha, "loaded_code_sha": None})
    return path


def update_restart_request(paths: Paths, defect_id: int, state: str, **fields) -> bool:
    path = request_path(paths, defect_id)
    request = _read_json(path)
    if request is None or request.get("defect_id") != defect_id:
        return False
    request.update(fields, state=state, updated_at=time.time())
    _atomic_json(path, request)
    return True


def record_runtime(paths: Paths, code_sha: str | None) -> None:
    _atomic_json(paths.runtime_record_file, {
        "version": 1, "runtime_root": str(paths.repo_root.resolve()), "loaded_code_sha": code_sha,
        "pid": os.getpid(), "started_at": time.time(),
    })


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
        if line["drain"] or (line["force_stop"] and not recovering_stopped_supervisor):
            return f"operator Stop/Drain is active on {line['model']}/{line['method']}"
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


def _tmux(command: list[str], timeout=5) -> subprocess.CompletedProcess:
    return subprocess.run(["tmux", *command], capture_output=True, text=True, timeout=timeout)


def _set_waiting(paths: Paths, request: dict, reason: str) -> tuple[str, str]:
    request.update(state="waiting", blocker=reason, checked_at=time.time())
    _atomic_json(request_path(paths, int(request["defect_id"])), request)
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
                and _ancestor(root, request["merge_sha"], runtime.get("loaded_code_sha", ""))):
            request.update(state="loaded", loaded_code_sha=runtime.get("loaded_code_sha"), checked_at=time.time())
            _atomic_json(path, request)
            continue

    pending = [(path, request) for path, request in requests
               if (_read_json(path) or {}).get("state") not in
               ("loaded", "progress_verified", "recovery_blocked", "cancelled")]
    if not pending:
        # A durable loaded record outlives its process. Let the normal launcher
        # recover a stopped Supervisor instead of mistaking that record for a lock.
        return ("locked", None) if _lock_held(paths.lock) else None

    recovering = not _lock_held(paths.lock)
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
        if blocker := _live_work_or_controls(store):
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

    for path, request in pending:
        request.update(state="restarting", blocker=None, requested_restart_at=time.time())
        _atomic_json(path, request)

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
                and all(_ancestor(root, req["merge_sha"], runtime.get("loaded_code_sha", "")) for _, req in pending)):
            loaded = runtime
            break
        time.sleep(1)
    if loaded is None:
        return _set_waiting(paths, pending[0][1], "updated Supervisor runtime root/loaded code SHA did not verify")
    for path, request in pending:
        request.update(state="loaded", loaded_code_sha=loaded.get("loaded_code_sha"),
                       supervisor_pid=loaded.get("pid"), loaded_at=time.time(), blocker=None)
        _atomic_json(path, request)
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
