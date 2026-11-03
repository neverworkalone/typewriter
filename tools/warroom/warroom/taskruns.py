"""Mechanical run management shared by the parallel task schedulers (Stage 2 `s2parallel`, Method D `dparallel`).

Only what is identical for both lives here: which task runs are still open, whether their processes live, how one run
is observed until it ends, how all of them are stopped, and how many slots they occupy. What a finished run *means*
(a decision answer, a saved chunk), where an unfinished task returns to and every save/accept rule stay in the method.
"""
from __future__ import annotations

from pathlib import Path


def recorded_spec(run_row):
    """The model/effort/permission pins a run was launched with, or None for a run without a recorded model."""
    from .adapters import RunSpec
    return RunSpec(run_row["model"], run_row["effort"], run_row["permission_profile"] or "") \
        if run_row is not None and run_row["model"] else None


def open_runs(store, batch_id: int) -> list:
    """Task runs with no recorded end. A run counts here until its process is confirmed gone, answer or not."""
    return store.open_task_runs(batch_id)


def slots_used(store, batch_id: int) -> int:
    """Concurrency slots in use: live runs plus runs whose end is not yet confirmed (never a task state)."""
    return len(open_runs(store, batch_id))


def workers_alive(store, ad, batch_id: int) -> bool:
    """True while any task run may still be alive (no recorded PID, or its PID still lives)."""
    return any(run["pid"] is None or ad.alive(run["pid"]) for run in open_runs(store, batch_id))


def stop_open_runs(store, ad, batch_id: int, on_stopped) -> bool:
    """Ask every live task process to stop; True once all are confirmed gone and their runs closed.

    A run that had already exited 0 keeps that status so the next poll still reads its result. Any other gone run is
    closed as "stopped" and handed to `on_stopped(run)`, which returns its task to the method's restartable state."""
    gone = True
    for run in open_runs(store, batch_id):
        if run["pid"] is not None and ad.alive(run["pid"]):
            ad.stop(run["pid"])
            gone = False
            continue
        if ad.exit_code(Path(run["exit_file"])) == 0:
            store.finish_run(run["id"], 0)
            continue
        store.finish_run(run["id"], "stopped")
        on_stopped(run)
    return gone


def observe_run(store, ad, run, session_id):
    """Advance one run record. Returns ("wait", sid), ("problem", message) or ("ended", exit code or None, run row).

    While the process runs this discovers and records the session, checks the CLI's pins and stops a run that
    contradicts them; once the process is gone it closes exactly this run (own usage, own exit status)."""
    log = Path(run["log_file"])
    if run["ended_at"] is not None:
        status = run["exit_status"]
        return "ended", (None if status in (None, "unknown") else _int(status)), run
    sid = session_id or ad.session_id(log)
    if sid and sid != session_id:
        store.set_run_session_by_id(run["id"], sid)
    tolerant = {"tolerate_denied": True} if getattr(ad, "supports_tolerate_denied", False) else {}
    problem = ad.run_problem(log, recorded_spec(run), session_id or sid, **tolerant)
    if problem:   # the CLI contradicts its pins: stop it and keep everything for the operator
        if run["pid"] is not None and ad.alive(run["pid"]):
            ad.stop(run["pid"])
            return "wait", sid
        store.finish_run(run["id"], "stopped")
        return "problem", problem[1]
    if run["pid"] is not None and ad.alive(run["pid"]):
        return "wait", sid
    code = ad.exit_code(Path(run["exit_file"]))
    store.finish_run(run["id"], code)
    return "ended", code, store.run(run["id"])


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
