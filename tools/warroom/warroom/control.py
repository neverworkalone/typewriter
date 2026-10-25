"""Operator commands (TUI -> Supervisor) and status views, via the shared DB only.

Every command is scoped to one Line (model, method) or, for the `*_all` variants, to the
whole Factory. A Line never reads or writes another Line's controls.
"""
from __future__ import annotations

import time

from . import stage2
from .config import maintainer_problem, registry, stage2_problem
from .store import MAINTENANCE_METHOD, STAGE2_METHOD, Store

STATES_HELP = ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING", "MERGED", "CLEANUP",
               "COMPLETE", "PAUSED", "ERROR", "CLEARING")
MODES = {"single": "Single", "continuous": "Continuous"}   # Continuous = sequential batches in ONE Line


def start(store: Store, model: str, method: str, mode: str, cfg: dict | None = None) -> tuple[bool, str]:
    """Request production on a Line. Never creates a second batch for an occupied Line.

    Stage 2 (`s2`) is one serial process for the whole factory and runs on Claude/Codex only: it needs `cfg` to prove
    the model, and its occupancy is reserved atomically in the store (a missing `cfg` fails closed).
    """
    if method == STAGE2_METHOD:
        problem = "설정을 확인할 수 없어 Stage 2를 시작하지 않습니다" if cfg is None else stage2_problem(cfg, model)
        return (False, problem) if problem else store.start_stage2(model, mode)
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
    n = store.request_drain_all(lines)
    store.log(None, f"Drain All: {n}개 라인 종료 요청")
    return n


def method_label(method: str) -> str:
    """Board/Detail name of a Line's method: `A`-`D`, or `Stage 2`."""
    return "Stage 2" if method == STAGE2_METHOD else method.upper()


def set_drain(store: Store, model: str, method: str, on: bool) -> None:
    b = store.active_batch(model, method)
    if on and b is not None and b["state"] == "CLEARING":   # a Clear leaves the Line IDLE: no Drain may outlive it
        return
    store.set_line(model, method, drain=1 if on else 0)


def drained(store: Store, ln) -> bool:
    """Only the Line's own drain blocks assigning a new batch (Drain All ends the run instead)."""
    return bool(ln["drain"])


def stop_line(store: Store, model: str, method: str) -> None:
    store.stop_lines(model, method)


def stop_all(store: Store) -> None:
    store.stop_lines()


def request_clear(store: Store, model: str, method: str, batch_id: int) -> tuple[bool, str]:
    """Operator Clear of ONE unfinished batch: only writes the batch-ID-specific request (the Supervisor tears down)."""
    return store.request_clear(model, method, batch_id)


def defect_locked(store: Store, b) -> bool:
    """A batch paused for a shared defect resumes only through the automatic release; an operator can override it
    only after an explicit Stop (which sets the hold), so a plain Retry never skips the fix."""
    return b["pause_reason"] == "shared_defect" and not store.get(f"defect_hold_{b['id']}")


def retry(store: Store, model: str, method: str) -> bool:
    b = store.active_batch(model, method)
    if (b is not None and store.clear_request(model, method) is None and b["state"] in ("PAUSED", "ERROR")
            and b["pid"] is None and not defect_locked(store, b)):
        store.set_line(model, method, retry_batch=b["id"])
        return True
    return False


def retry_maintainer(store: Store) -> bool:
    """Retry the hidden Maintainer's PAUSED/ERROR execution (it is not on the Board, so it has no card)."""
    for b in store.incomplete_batches():
        if b["method"] == MAINTENANCE_METHOD:
            return retry(store, b["producer"], MAINTENANCE_METHOD)
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
           "records_done": None, "elapsed": None, "stage2": None, "wait": ""}
    if method == STAGE2_METHOD:
        out["wait"] = store.get(f"s2_wait_{model}") or ""
    out["drain"] = out["line_drain"] or out["drain_once"]
    if b is not None and b["state"] != "COMPLETE":   # a finished batch leaves the slot EMPTY; it stays in history
        out.update(state=b["state"], batch=f"{b['shard']}_{b['batch']}", branch=b["branch"],
                   pr=b["pr_number"], head=b["head_sha"], session=b["session_id"],
                   error=b["error"], worktree=b["worktree"], batch_id=b["id"], updated=b["updated_at"],
                   records_total=b["records_total"], records_done=b["records_done"],
                   occupied=True)
        if method == STAGE2_METHOD:   # the Part's identity replaces the record counters
            batch, part = stage2.split_key(b["batch"])
            out["stage2"] = {"shard": b["shard"], "batch": batch, "part": part}
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
    out["can_drain"] = (out["occupied"] and st != "CLEARING") or out["run"]
    out["can_stop"] = out["occupied"] and st not in ("PAUSED", "ERROR", "CLEARING") or out["run"]
    out["stoppable"] = (out["occupied"] and st != "CLEARING") or out["run"]   # what `stop_lines` can actually affect
    out["can_retry"] = st in ("PAUSED", "ERROR") and b["pid"] is None and not defect_locked(store, b)
    req = store.clear_request(model, method) if out["occupied"] else None
    out["clear"] = None if req is None else {"status": req["status"], "error": req["error"]}
    # Clear needs a specific unfinished batch; once started it can only be re-armed after a BLOCKED teardown.
    out["can_clear"] = out["occupied"] and (req is None or req["status"] == "BLOCKED")
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


# --- the single "urgent" status line (Issue #1555) ---------------------------------------------------------------------
def _short(text: str | None, n: int = 70) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def _maintainer_text(store: Store, cfg: dict, m, deps) -> str:
    """What one urgent Issue is doing right now, read only from persisted state (no invented progress)."""
    st = m["state"]
    held = [d for d in deps if d["state"] == "HELD"]
    if held:
        return f"보류: {_short(held[0]['hold_reason'])}"
    if st == "HELD":
        return f"보류: {_short(m['hold_reason'])}"
    if st == "QUEUED":
        if cfg.get("maintainer") is None:
            return "Maintainer 미설정 · 대기"
        problem = maintainer_problem(cfg)
        return f"Maintainer 설정 오류 · {_short(problem)}" if problem else "Maintainer 대기 중"
    if st == "DONE":
        return "머지·Cleanup 완료 · 종속 배치 수정 반영 중"
    b = store.batch(m["batch_id"]) if m["batch_id"] else None
    if b is None:
        return "Maintainer 준비 중"
    pr = f"PR #{b['pr_number']} · " if b["pr_number"] else ""
    return {"PREPARE": "Maintainer WORKING >> 수정 중 · PR 생성 전" if not b["pr_number"] else f"{pr}수정 중",
            "PRODUCING": "Maintainer WORKING >> 수정 중 · PR 생성 전" if not b["pr_number"] else f"{pr}수정 중",
            "WAITING_REVIEW": f"{pr}리뷰 대기", "FIXING": f"{pr}수정 중",
            "MERGED": f"{pr}머지됨 · Cleanup 중", "CLEANUP": f"{pr}머지됨 · Cleanup 중",
            "PAUSED": f"{pr}Maintainer PAUSED · {_short(b['error'])} (m: Retry)",
            "ERROR": f"{pr}Maintainer ERROR · {_short(b['error'])} (m: Retry)"}.get(b["state"], b["state"])


_BAD_PREFIXES = ("보류", "Maintainer 설정 오류", "Maintainer 미설정")


def urgent_items(store: Store, cfg: dict) -> list[tuple[str, bool]]:
    """(text, needs_attention) of every open urgent Issue, oldest first; [] when nothing is open.

    An Issue disappears only after its PR is merged, the Maintainer is cleaned up and every batch that depended on
    it was released (or deliberately resumed by the operator). Held and failed states stay visible.
    """
    deps_by_issue: dict[int, list] = {}
    for d in store.defects(("LINKED", "FIX_MERGED", "HELD")):
        deps_by_issue.setdefault(d["issue_number"], []).append(d)
    items = []
    for d in store.defects(("REPORTED",)):
        items.append((f"urgent · 공통 결함 `{d['defect_class']}` · Issue 등록 대기", False))
    for m in store.maintenance_rows():
        deps = deps_by_issue.get(m["issue_number"], [])
        if m["state"] in ("DONE", "HELD") and not deps:   # nothing depends on it any more (all released/overridden)
            continue
        text = _maintainer_text(store, cfg, m, deps)
        bad = text.startswith(_BAD_PREFIXES) or "PAUSED" in text or "ERROR" in text
        items.append((f"urgent issue #{m['issue_number']} · {text}", bad))
    return items


def urgent_line(store: Store, cfg: dict) -> str:
    """One line for the current urgent Issue (+ how many others wait); "" when nothing is open."""
    items = urgent_items(store, cfg)
    if not items:
        return ""
    return items[0][0] + (f" (+{len(items) - 1}건 대기)" if len(items) > 1 else "")


def maintainer_card(store: Store, cfg: dict) -> dict:
    """Status-only content of the Board's Maintainer card (Issue #1684): {"state": IDLE|WORKING|ERROR, "text": str}.

    It shows the #1555 Maintainer's persisted progress whichever model runs it; it starts nothing. Colour is meant
    only while a task exists: IDLE (no open urgent Issue) is the neutral empty card.
    """
    items = urgent_items(store, cfg)
    if not items:
        return {"state": "IDLE", "text": ""}
    text = items[0][0] + (f" (+{len(items) - 1}건 대기)" if len(items) > 1 else "")
    return {"state": "ERROR" if any(bad for _, bad in items[:1]) else "WORKING", "text": text}
