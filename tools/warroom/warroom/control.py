"""Operator commands (TUI -> Supervisor) and status views, via the shared DB only.

Every command is scoped to one Line (model, method) or, for the `*_all` variants, to the
whole Factory. A Line never reads or writes another Line's controls.
"""
from __future__ import annotations

import time

from .store import Store

STATES_HELP = ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING", "MERGED", "CLEANUP",
               "COMPLETE", "PAUSED", "ERROR")
MODES = {"single": "Single", "continuous": "Continuous"}   # Continuous = sequential batches in ONE Line


def start(store: Store, model: str, method: str, mode: str) -> tuple[bool, str]:
    """Request production on a Line. Never creates a second batch for an occupied Line."""
    b = store.active_batch(model, method)
    if b is not None:
        return False, f"{model}/{method.upper()} 라인은 이미 미완료 배치 {b['shard']}_{b['batch']}({b['state']})를 소유 중입니다."
    if global_drain(store):
        return False, "Drain All 상태입니다. Cancel Drain 후 시작하세요."
    if store.peek_line(model, method)["drain"]:
        return False, f"{model}/{method.upper()} 라인이 Drain 중입니다. 해당 라인의 Cancel Drain 후 시작하세요."
    store.set_line(model, method, mode="continuous" if mode == "continuous" else "single",
                   force_stop=0, blocked="", run=1)
    return True, ""


def global_drain(store: Store) -> bool:
    return store.get("drain_all") == "1"


def set_drain_all(store: Store, on: bool) -> None:
    store.set("drain_all", "1" if on else "0")   # per-Line drains are untouched


def set_drain(store: Store, model: str, method: str, on: bool) -> None:
    store.set_line(model, method, drain=1 if on else 0)


def drained(store: Store, ln) -> bool:
    """Either the Line drain or Drain All blocks assigning a new batch."""
    return bool(ln["drain"]) or global_drain(store)


def stop_line(store: Store, model: str, method: str) -> None:
    store.stop_lines(model, method)


def stop_all(store: Store) -> None:
    store.stop_lines()


def retry(store: Store, model: str, method: str) -> bool:
    b = store.active_batch(model, method)
    if b is not None and b["state"] in ("PAUSED", "ERROR") and b["pid"] is None:
        store.set_line(model, method, retry_batch=b["id"])
        return True
    return False


def supervisor_alive(store: Store, now: float | None = None, max_age: float = 30) -> bool:
    hb = store.get("heartbeat")
    return hb is not None and (now or time.time()) - float(hb) < max_age


def line_status(store: Store, model: str, method: str) -> dict:
    """Card/detail view of one Line: latest batch (kept after COMPLETE) + controls."""
    ln = store.peek_line(model, method)
    b = store.latest_batch(model, method)
    out = {"model": model, "method": method, "state": "IDLE", "batch": None, "pr": None, "head": None,
           "session": None, "error": None, "progress": None, "worktree": None, "branch": None,
           "mode": ln["mode"], "run": bool(ln["run"]), "line_drain": bool(ln["drain"]),
           "global_drain": global_drain(store), "blocked": ln["blocked"] or "", "tier": ln["model_tier"],
           "batch_id": None, "activity": None, "occupied": False, "updated": None, "records_total": None}
    out["drain"] = out["line_drain"] or out["global_drain"]
    if b is not None:
        out.update(state=b["state"], batch=f"{b['shard']}_{b['batch']}", branch=b["branch"],
                   pr=b["pr_number"], head=b["head_sha"], session=b["session_id"],
                   error=b["error"], worktree=b["worktree"], batch_id=b["id"], updated=b["updated_at"],
                   records_total=b["records_total"],
                   occupied=b["state"] != "COMPLETE")
        if b["records_done"] is not None and b["records_total"]:
            out["progress"] = f"{b['records_done']}/{b['records_total']}"  # recorded only
        ev = store.last_event(b["id"])
        if ev:
            out["activity"] = (ev["ts"], ev["msg"])
    # Buttons: only meaningful commands are enabled.
    st = out["state"]
    out["can_drain"] = out["occupied"] or out["run"]
    out["can_stop"] = out["occupied"] and st not in ("PAUSED", "ERROR") or out["run"]
    out["stoppable"] = out["occupied"] or out["run"]   # what `stop_lines` can actually affect
    out["can_retry"] = st in ("PAUSED", "ERROR") and b["pid"] is None
    return out


def can_stop_all(store: Store, lines) -> bool:
    """Stop All has a target while any Line has an unfinished batch (incl. PAUSED/ERROR) or a run flag."""
    return any(line_status(store, m, me)["stoppable"] for m, me in lines)
