"""Operator commands (TUI -> Supervisor) and status views, via the shared DB only."""
from __future__ import annotations

import time

from .store import Store

STATES_HELP = ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING", "MERGED", "CLEANUP",
               "COMPLETE", "PAUSED", "ERROR")


def start(store: Store, mode: str) -> None:
    store.set("mode", "continuous" if mode == "continuous" else "single")
    store.set("stop_after", "0")
    store.set("blocked", "")
    store.set("run", "1")


def stop_after_current(store: Store) -> None:
    store.set("stop_after", "1")


def force_stop(store: Store) -> None:
    store.set("force_stop", "1")


def retry(store: Store) -> None:
    b = store.active_batch()
    if b is not None and b["state"] in ("PAUSED", "ERROR"):
        store.set("retry", str(b["id"]))


def supervisor_alive(store: Store, now: float | None = None, max_age: float = 30) -> bool:
    hb = store.get("heartbeat")
    return hb is not None and (now or time.time()) - float(hb) < max_age


def status(store: Store) -> dict:
    b = store.active_batch()
    out = {"state": "IDLE", "mode": store.get("mode", "single"),
           "run": store.get("run") == "1", "stop_after": store.get("stop_after") == "1",
           "blocked": store.get("blocked") or "", "supervisor": supervisor_alive(store),
           "tier": store.get("model_tier", "free"), "error": None}
    if b is not None:
        out.update(state=b["state"], batch=f"{b['shard']}_{b['batch']}", branch=b["branch"],
                   pr=b["pr_number"], head=b["head_sha"], session=b["session_id"],
                   error=b["error"], worktree=b["worktree"])
        if b["records_done"] is not None and b["records_total"]:
            out["progress"] = f"{b['records_done']}/{b['records_total']}"  # recorded only
    return out
