"""Operator commands (TUI -> Supervisor) and status views, via the shared DB only.

Every command is scoped to one Line (model, method) or, for the `*_all` variants, to the
whole Factory. A Line never reads or writes another Line's controls.
"""
from __future__ import annotations

import time

from .config import registry
from .store import Store

STATES_HELP = ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING", "MERGED", "CLEANUP",
               "COMPLETE", "PAUSED", "ERROR")
MODES = {"single": "Single", "continuous": "Continuous"}   # Continuous = sequential batches in ONE Line


def start(store: Store, model: str, method: str, mode: str) -> tuple[bool, str]:
    """Request production on a Line. Never creates a second batch for an occupied Line."""
    b = store.active_batch(model, method)
    if b is not None:
        return False, f"{model}/{method.upper()} 라인은 이미 미완료 배치 {b['shard']}_{b['batch']}({b['state']})를 소유 중입니다."
    if store.peek_line(model, method)["drain"]:
        return False, f"{model}/{method.upper()} 라인이 Drain 중입니다. 해당 라인의 Cancel Drain 후 시작하세요."
    store.set_line(model, method, mode="continuous" if mode == "continuous" else "single",
                   force_stop=0, blocked="", run=1, drain_once=0)
    return True, ""


def drain_all(store: Store, lines) -> int:
    """One-shot request: every Line that is running finishes its current batch and then stops.

    A Line with an unfinished batch gets `drain_once` (kept across PAUSED/ERROR/Retry and Supervisor restarts);
    a Line with only a pending run reservation loses it. Later Starts and per-Line `drain` are untouched.
    """
    n = 0
    for m, me in lines:
        ln = store.peek_line(m, me)
        if store.active_batch(m, me) is not None:
            store.set_line(m, me, drain_once=1)
            n += 1
        elif ln["run"]:
            store.set_line(m, me, run=0)
            n += 1
    store.log(None, f"Drain All: {n}개 라인 종료 요청")
    return n


def set_drain(store: Store, model: str, method: str, on: bool) -> None:
    store.set_line(model, method, drain=1 if on else 0)


def drained(store: Store, ln) -> bool:
    """Only the Line's own drain blocks assigning a new batch (Drain All ends the run instead)."""
    return bool(ln["drain"])


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


def request_reload(store: Store) -> str:
    """TUI -> Supervisor: re-read config.json. Same shared-DB channel as every other command (kv, no new channel)."""
    token = f"{time.time():.6f}"
    store.set("reload_req", token)
    return token


def reload_result(store: Store) -> tuple[str, bool, str] | None:
    """(token, ok, message) of the Supervisor's last handled reload request, or None if none was handled yet."""
    raw = store.get("reload_result")
    if not raw:
        return None
    token, ok, msg = raw.split("\t", 2)
    return token, ok == "ok", msg


def supervisor_alive(store: Store, now: float | None = None, max_age: float = 30) -> bool:
    hb = store.get("heartbeat")
    return hb is not None and (now or time.time()) - float(hb) < max_age


def line_status(store: Store, model: str, method: str) -> dict:
    """Card/detail view of one Line: current unfinished batch (COMPLETE -> empty slot, history kept) + controls."""
    ln = store.peek_line(model, method)
    b = store.latest_batch(model, method)
    out = {"model": model, "method": method, "state": "IDLE", "batch": None, "pr": None, "head": None,
           "session": None, "error": None, "progress": None, "worktree": None, "branch": None,
           "mode": ln["mode"], "run": bool(ln["run"]), "line_drain": bool(ln["drain"]),
           "drain_once": bool(ln["drain_once"]), "blocked": ln["blocked"] or "", "tier": ln["model_tier"],
           "batch_id": None, "activity": None, "occupied": False, "updated": None, "records_total": None,
           "records_done": None, "elapsed": None}
    out["drain"] = out["line_drain"] or out["drain_once"]
    if b is not None and b["state"] != "COMPLETE":   # a finished batch leaves the slot EMPTY; it stays in history
        out.update(state=b["state"], batch=f"{b['shard']}_{b['batch']}", branch=b["branch"],
                   pr=b["pr_number"], head=b["head_sha"], session=b["session_id"],
                   error=b["error"], worktree=b["worktree"], batch_id=b["id"], updated=b["updated_at"],
                   records_total=b["records_total"], records_done=b["records_done"],
                   occupied=True)
        if b["records_done"] is not None and b["records_total"]:
            out["progress"] = f"{b['records_done']}/{b['records_total']}"  # recorded only
        runs = store.runs(b["id"])
        if runs:   # real execution time: the sum of recorded runs, an unfinished one counted up to now
            now = time.time()
            out["elapsed"] = sum(max(0.0, (r["ended_at"] or now) - r["started_at"]) for r in runs)
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


# --- Free/Go model tier (operator switch; the automatic Free->Go switch on quota exhaustion is separate) ---
TIER_SWITCH_MODELS = ("deepseek",)   # the operator Free/Go switch applies to DeepSeek only


def go_models(cfg: dict) -> list[str]:
    """Models the tier switch may touch: DeepSeek, run through OpenCode (the only CLI with a free tier),
    and only when it has a Go model configured."""
    return [pid for pid, p in registry(cfg).items()
            if pid in TIER_SWITCH_MODELS and p["adapter"] == "opencode" and p["models"].get("go")]


def tier_state(store: Store, cfg: dict, methods) -> str:
    """'free' | 'go' | 'mixed' over every Line of the models that have a Go model; 'none' if DeepSeek has no Go model."""
    tiers = {store.peek_line(m, me)["model_tier"] for m in go_models(cfg) for me in methods}
    if not tiers:
        return "none"
    return tiers.pop() if len(tiers) == 1 else "mixed"


def next_tier(state: str) -> str | None:
    """f: Free -> Go; Go or a mixed board -> Free (never silently towards paid when unsure); none -> nothing."""
    return {"free": "go", "go": "free", "mixed": "free"}.get(state)


def set_tier(store: Store, cfg: dict, methods, tier: str) -> int:
    """Apply `tier` to every DeepSeek Line (and its unfinished batch).

    A running AI keeps its model; the next launch (new batch, fix, recovery) uses the new tier.
    """
    if tier not in ("free", "go"):
        raise ValueError(tier)
    models = go_models(cfg)
    for m in models:
        for me in methods:
            store.set_line(m, me, model_tier=tier)
    n = 0
    for b in store.incomplete_batches():
        if b["producer"] in models and b["model_tier"] != tier:
            store.update(b["id"], model_tier=tier)
            store.log(b["id"], f"운영자가 모델 단계를 {tier.upper()}로 전환 (다음 실행부터 적용)")
            n += 1
    store.log(None, f"운영자 모델 단계 전환 → {tier.upper()} ({len(models)}개 모델)")
    return n
