"""Operator commands (TUI -> Supervisor) and status views, via the shared DB only.

Every command is scoped to one Line (model, method) or, for the `*_all` variants, to the
whole Factory. A Line never reads or writes another Line's controls.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, time as wall_time, timedelta

from . import stage2
from .config import (maintainer_id, maintainer_problem, methods, ordered_models, registry, stage2_models,
                     stage2_problem, stage3_model, stage3_problem)
from .store import MAINTENANCE_METHOD, STAGE2_METHOD, STAGE3_METHOD, Store

STATES_HELP = ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING", "MERGED", "CLEANUP",
               "COMPLETE", "PAUSED", "ERROR", "CLEARING")
MODES = {"single": "Single", "continuous": "Continuous"}   # Continuous = sequential batches in ONE Line


def start(store: Store, model: str, method: str, mode: str, cfg: dict | None = None) -> tuple[bool, str]:
    """Request production on a Line. Never creates a second batch for an occupied Line.

    Stage 2 (`s2`) is one serial process for the whole factory and Stage 3 (`s3`) uses the fixed Codex line; both need
    `cfg` to prove the model and pin, and their occupancy is reserved atomically in the store (missing `cfg` fails closed).
    """
    if method == STAGE2_METHOD:
        problem = "설정을 확인할 수 없어 Stage 2를 시작하지 않습니다" if cfg is None else stage2_problem(cfg, model)
        return (False, problem) if problem else store.start_stage2(model, mode)
    if method == STAGE3_METHOD:
        if cfg is None:
            return False, "설정을 확인할 수 없어 Stage 3를 시작하지 않습니다"
        owner = stage3_model(cfg)
        if owner is None or model != owner:
            return False, f"Stage 3 실행 모델은 지정된 Codex 라인 {owner or '(없음)'}이어야 합니다."
        if why := stage3_problem(cfg, model):
            return False, why
        return store.start_stage3(model, mode)
    reason, b = store.request_start(model, method, mode)
    if reason == "active":
        return False, f"{model}/{method.upper()} 라인은 이미 미완료 배치 {b['shard']}_{b['batch']}({b['state']})를 소유 중입니다."
    if reason == "drain":
        return False, f"{model}/{method.upper()} 라인이 Drain 중입니다. 해당 라인의 Cancel Drain 후 시작하세요."
    return True, ""


def drain_all(store: Store, lines) -> int:
    """Set the same per-Line Drain as Detail on for every target, including empty Lines."""
    n = store.request_drain_all(lines)
    store.log(None, f"Drain All: {n}개 생산 라인 Drain ON")
    return n


def next_drain_due(hour: int | str, now: float | None = None) -> float:
    """Return the next local occurrence of an exact hour (00:00–23:00); a reached hour means tomorrow."""
    if isinstance(hour, bool):
        raise ValueError("시간은 00:00~23:00 정각이어야 합니다")
    try:
        hour = int(hour)
    except (TypeError, ValueError):
        raise ValueError("시간은 00:00~23:00 정각이어야 합니다") from None
    if not 0 <= hour <= 23:
        raise ValueError("시간은 00:00~23:00 정각이어야 합니다")
    now = time.time() if now is None else now
    local = datetime.fromtimestamp(now)
    due = datetime.combine(local.date(), wall_time(hour=hour))
    if due.timestamp() <= now:
        due = datetime.combine(local.date() + timedelta(days=1), wall_time(hour=hour))
    return due.timestamp()


def schedule_drain_all(store: Store, hour: int | str, now: float | None = None) -> tuple[bool, str]:
    now = time.time() if now is None else now
    return store.create_drain_schedule("all", next_drain_due(hour, now), created_at=now)


def schedule_batch_drain(store: Store, model: str, method: str, batch_id: int, hour: int | str,
                         now: float | None = None) -> tuple[bool, str]:
    if method == MAINTENANCE_METHOD:
        return False, "Maintainer는 배치 Drain 예약 대상이 아닙니다."
    now = time.time() if now is None else now
    return store.create_drain_schedule(f"batch:{batch_id}", next_drain_due(hour, now), model=model,
                                       method=method, batch_id=batch_id, created_at=now)


def cancel_drain_schedule(store: Store, target: str) -> bool:
    return store.cancel_drain_schedule(target)


def board_line_keys(store: Store, cfg: dict) -> list[tuple[str, str]]:
    """The production Lines represented on the Board; shared by TUI and scheduled Drain All."""
    models = ordered_models(cfg)
    known = set(models)
    models += sorted({ln["model"] for ln in store.lines()} - known)
    configured_methods = methods(cfg)
    keys = [(model, method) for model in models for method in configured_methods]
    keys += [(model, STAGE2_METHOD) for model in models if model in stage2_models(cfg)]
    if owner := stage3_model(cfg):
        keys.append((owner, STAGE3_METHOD))
    return [(model, method) for model, method in keys if method != MAINTENANCE_METHOD]


def method_label(method: str) -> str:
    """Board/Detail name of a Line's method: `A`-`D`, `Stage 2` or `Maintainer`."""
    return ("Stage 2" if method == STAGE2_METHOD else "Stage 3" if method == STAGE3_METHOD
            else "Maintainer" if method == MAINTENANCE_METHOD else method.upper())


def set_drain(store: Store, model: str, method: str, on: bool) -> None:
    if method == MAINTENANCE_METHOD:   # one Maintainer queue: the flag is global to it, whichever producer ran an Issue
        for ln in store.lines():
            if ln["method"] == MAINTENANCE_METHOD and ln["drain"] and not on:
                store.set_line(ln["model"], MAINTENANCE_METHOD, drain=0)
        return store.set_line(model, method, drain=1) if on else None
    return store.request_drain(model, method, on)


def drained(store: Store, ln) -> bool:
    """The Line's single Drain flag blocks all new batch assignments, regardless of which control set it."""
    return bool(ln["drain"])


def stop_line(store: Store, model: str, method: str) -> None:
    store.stop_lines(model, method)


def stop_maintainer(store: Store, model: str, batch_id: int) -> bool:
    """Stop the Maintainer execution `batch_id` the operator saw; False (nothing stopped) when it is no longer current."""
    return store.request_stop_pinned(model, MAINTENANCE_METHOD, batch_id)


def stop_all(store: Store) -> None:
    store.stop_lines()


def request_clear(store: Store, model: str, method: str, batch_id: int, issue_number: int | None = None) -> tuple[bool, str]:
    """Operator Clear of ONE unfinished batch: only writes the batch-ID-specific request (the Supervisor tears down).

    The Maintainer's execution must also name the urgent Issue the operator saw (a stale screen touches nothing else).
    """
    return store.request_clear(model, method, batch_id, issue_number)


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


def retry_maintainer(store: Store, issue_number: int | None = None, batch_id: int | None = None) -> bool:
    """Retry the Maintainer: its PAUSED/ERROR execution, or (Detail only: `issue_number` given) an Issue the operator
    cleared and that therefore waits HELD with no execution. `issue_number`/`batch_id` pin what the operator saw: a
    screen that no longer matches retries nothing."""
    for b in store.incomplete_batches():
        if b["method"] == MAINTENANCE_METHOD:
            if batch_id is not None and b["id"] != batch_id:
                return False
            if issue_number is not None:
                m = store.maintenance(issue_number)
                if m is None or m["batch_id"] != b["id"]:
                    return False
            return retry(store, b["producer"], MAINTENANCE_METHOD)
    if issue_number is not None and batch_id is None:
        return store.requeue_maintenance(issue_number)
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


def transient_wait_text(store: Store, keys: list[str]) -> str:
    """One `wait` line per recorded transient-retry record (count, next attempt, last error); "" when none."""
    parts = []
    for key in keys:
        try:
            rec = json.loads(store.get(key) or "")
            parts.append(f"조회 재시도 {rec['count']}회째 대기(다음 시도 {time.strftime('%H:%M:%S', time.localtime(rec['next_at']))}): "
                         f"{str(rec.get('last_error', ''))[:120]}")
        except (ValueError, KeyError, TypeError):
            continue
    return "; ".join(parts)


def line_status(store: Store, model: str, method: str) -> dict:
    """Card/detail view of one Line: current unfinished batch (COMPLETE -> empty slot, history kept) + controls."""
    ln = store.peek_line(model, method)
    b = store.latest_batch(model, method)
    out = {"model": model, "method": method, "state": "IDLE", "batch": None, "pr": None, "head": None,
           "session": None, "error": None, "progress": None, "worktree": None, "branch": None,
           "mode": ln["mode"], "run": bool(ln["run"]), "line_drain": bool(ln["drain"]),
           "blocked": ln["blocked"] or "", "tier": ln["model_tier"],
           "batch_id": None, "activity": None, "occupied": False, "updated": None, "records_total": None,
           "records_done": None, "progress_kind": None, "progress_done": None, "progress_total": None,
           "elapsed": None, "stage2": None, "wait": ""}
    if method == STAGE2_METHOD:
        out["wait"] = store.get(f"s2_wait_{model}") or ""
    elif method == STAGE3_METHOD:
        out["wait"] = store.get(f"s3_wait_{model}") or ""
    out["drain"] = out["line_drain"]
    keys = [f"tw_line:{model}:{method}:prepare"]
    if b is not None and b["state"] != "COMPLETE":
        keys += [r["key"] for r in store.kv_prefix(f"tw_b{b['id']}:")]
    if text := transient_wait_text(store, keys):   # a stage-2 Part wait and a retry wait may both be shown
        out["wait"] = "; ".join(x for x in (out["wait"], text) if x)
    if b is not None and b["state"] != "COMPLETE":   # a finished batch leaves the slot EMPTY; it stays in history
        out.update(state=b["state"], batch=f"{b['shard']}_{b['batch']}", branch=b["branch"],
                   pr=b["pr_number"], head=b["head_sha"], session=b["session_id"],
                   error=b["error"], worktree=b["worktree"], batch_id=b["id"], updated=b["updated_at"],
                   records_total=b["records_total"], records_done=b["records_done"],
                   progress_kind=b["progress_kind"], progress_done=b["progress_done"],
                   progress_total=b["progress_total"],
                   occupied=True)
        if method == STAGE2_METHOD:   # the Part's identity replaces the record counters
            batch, part = stage2.split_key(b["batch"])
            out["stage2"] = {"shard": b["shard"], "batch": batch, "part": part}
        if b["progress_kind"] and b["progress_done"] is not None and b["progress_total"]:
            out["progress"] = f"{b['progress_done']}/{b['progress_total']} {b['progress_kind']}"
        elif b["records_done"] is not None and b["records_total"]:
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
def _short(text: str | None, n: int | None = 70) -> str:
    """One-line summary cut at `n` cells' worth of characters; n=None keeps the whole text (detail views)."""
    t = " ".join((text or "").split())
    return t if n is None or len(t) <= n else t[: n - 1] + "…"


def _maintainer_text(store: Store, cfg: dict, m, deps, full: bool = False) -> str:
    """What one urgent Issue is doing right now, read only from persisted state (no invented progress).

    `full` keeps hold reasons and errors uncut (Maintainer detail); the Board card/yellow line keep the 70-char summary.
    """
    n = None if full else 70
    st = m["state"]
    held = [d for d in deps if d["state"] == "HELD"]
    if held:
        return f"보류: {_short(held[0]['hold_reason'], n)}"
    if st == "HELD":
        return f"보류: {_short(m['hold_reason'], n)}"
    if st == "QUEUED":
        if cfg.get("maintainer") is None:
            return "Maintainer 미설정 · 대기"
        problem = maintainer_problem(cfg)
        return f"Maintainer 설정 오류 · {_short(problem, n)}" if problem else "Maintainer 대기 중"
    if st == "DONE":
        return "머지·Cleanup 완료 · 종속 배치 수정 반영 중"
    b = store.batch(m["batch_id"]) if m["batch_id"] else None
    if b is None:
        return "Maintainer 준비 중"
    pr = f"PR #{b['pr_number']} · " if b["pr_number"] else ""
    retry_hint = "(Retry 버튼 또는 Board의 m)" if full else "(m: Retry)"   # the Detail has its own buttons
    return {"PREPARE": "Maintainer WORKING >> 수정 중 · PR 생성 전" if not b["pr_number"] else f"{pr}수정 중",
            "PRODUCING": "Maintainer WORKING >> 수정 중 · PR 생성 전" if not b["pr_number"] else f"{pr}수정 중",
            "WAITING_REVIEW": f"{pr}리뷰 대기", "FIXING": f"{pr}수정 중",
            "MERGED": f"{pr}머지됨 · Cleanup 중", "CLEANUP": f"{pr}머지됨 · Cleanup 중",
            "PAUSED": f"{pr}Maintainer PAUSED · {_short(b['error'], n)} {retry_hint}",
            "ERROR": f"{pr}Maintainer ERROR · {_short(b['error'], n)} {retry_hint}",
            "CLEARING": f"{pr}Maintainer Clear 진행 중"}.get(b["state"], b["state"])


def open_maintenance(store: Store) -> list[tuple]:
    """(maintenance row, its dependent defects) of every open urgent Issue, oldest first."""
    deps_by_issue: dict[int, list] = {}
    for d in store.defects(("LINKED", "FIX_MERGED", "HELD")):
        deps_by_issue.setdefault(d["issue_number"], []).append(d)
    return [(m, deps_by_issue.get(m["issue_number"], [])) for m in store.maintenance_rows()
            # DONE/HELD with nothing depending on it any more (all released/overridden) is closed
            if not (m["state"] in ("DONE", "HELD") and not deps_by_issue.get(m["issue_number"]))]


_BAD_PREFIXES = ("보류", "Maintainer 설정 오류", "Maintainer 미설정")


def urgent_items(store: Store, cfg: dict, full: bool = False) -> list[tuple[str, bool]]:
    """(text, needs_attention) of every open urgent Issue, oldest first; [] when nothing is open.

    An Issue disappears only after its PR is merged, the Maintainer is cleaned up and every batch that depended on
    it was released (or deliberately resumed by the operator). Held and failed states stay visible. `full` leaves
    hold reasons/errors uncut for the Maintainer detail screen.
    """
    items = []
    for d in store.defects(("REPORTED",)):
        items.append((f"urgent · 공통 결함 `{d['defect_class']}` · Issue 등록 대기", False))
    for m, deps in open_maintenance(store):
        text = _maintainer_text(store, cfg, m, deps, full)
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
    out = {"state": "ERROR" if any(bad for _, bad in items[:1]) else "WORKING", "text": text,
           "issue": "", "pr": "", "detail": "", "elapsed": None}
    head, sep, rest = items[0][0].partition(" · ")
    if not head.startswith("urgent issue #"):   # a pending defect report has no Issue yet: keep the plain wrap
        return out
    out["issue"] = head + (f" (+{len(items) - 1}건 대기)" if len(items) > 1 else "")
    rows = [m for m in store.maintenance_rows() if f"urgent issue #{m['issue_number']} · " in items[0][0]]
    b = store.batch(rows[0]["batch_id"]) if rows and rows[0]["batch_id"] else None
    if b is not None:   # the same real execution time as every other card: recorded runs, an unfinished one up to now
        runs, now = store.runs(b["id"]), time.time()
        if runs:
            out["elapsed"] = sum(max(0.0, (r["ended_at"] or now) - r["started_at"]) for r in runs)
    if out["state"] == "ERROR" or not sep:
        out["detail"] = rest
    elif b is not None and b["pr_number"] and b["state"] in ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING"):
        out["pr"] = f"PR #{b['pr_number']}"
    elif b is not None and b["state"] in ("PREPARE", "PRODUCING"):
        out["pr"] = "PR 생성 전"
    else:   # hold / queued / merged states keep their own wording on the bottom-left
        out["detail"] = rest
    return out


# --- the Maintainer's Detail: the same Batch Detail as every Line, over the one hidden `m` Line (Issue #2022) ---------
def maintainer_producer(store: Store, cfg: dict, default: str | None = None) -> str | None:
    """The producer whose Maintainer Line the Detail shows: the unfinished execution's, else the last execution's,
    else the configured one. Always the model that actually runs it, never the Board column the card sits in."""
    runs = [b for b in store.all_batches() if b["method"] == MAINTENANCE_METHOD]
    open_ = [b for b in runs if b["state"] != "COMPLETE"]
    if open_ or runs:
        return (open_ or runs)[-1]["producer"]
    try:
        return maintainer_id(cfg) or default
    except Exception:
        return default


def maintainer_issue_row(store: Store):
    """(row, deps) of the Issue the Detail shows: the one with a live execution first (ACTIVE/ERROR), then the oldest
    open one; None when nothing is open. The screen never switches Issues silently: its controls carry the Issue."""
    rows = open_maintenance(store)
    live = {b["id"] for b in store.incomplete_batches() if b["method"] == MAINTENANCE_METHOD}
    return next((r for r in rows if r[0]["batch_id"] in live), rows[0] if rows else None)


def maintainer_status(store: Store, cfg: dict, model: str) -> dict:
    """`line_status` of the Maintainer Line plus its Issue-scoped facts (`st["maintainer"]`) and its own button rules."""
    st = line_status(store, model, MAINTENANCE_METHOD)
    rows = open_maintenance(store)
    target = maintainer_issue_row(store)
    info = {"issue": None, "row_state": None, "text": "", "hold": "", "others": [], "drain_note": "", "reasons": {}}
    if target is not None:
        m, deps = target
        info.update(issue=m["issue_number"], row_state=m["state"], text=_maintainer_text(store, cfg, m, deps, True),
                    hold=m["hold_reason"] or "")
        info["others"] = [(o["issue_number"], _short(_maintainer_text(store, cfg, o, od, False), 90))
                          for o, od in rows if o["issue_number"] != m["issue_number"]]
        if not st["occupied"]:   # no execution: the state is the Issue's own
            held = any(d["state"] == "HELD" for d in deps)
            st["state"] = ("HELD" if held or m["state"] == "HELD" else "QUEUED" if m["state"] == "QUEUED"
                           else "FIX_MERGED")
    elif not st["occupied"]:
        st["state"] = "IDLE"
    drained = store.maintenance_drained()
    st["maintainer"] = info
    st["line_drain"] = drained
    st["drain"] = drained
    waiting = any(r[0]["state"] == "QUEUED" for r in rows)
    st["can_drain"] = drained or (st["occupied"] and st["state"] != "CLEARING") or waiting
    if not st["can_drain"]:
        info["reasons"]["drain"] = "Drain 비활성: 현재 실행 중이거나 대기 중인 Issue가 없습니다."
    if drained:
        info["drain_note"] = "Drain: 현재 Issue는 정상 완료하고 다음 Issue는 자동으로 시작하지 않습니다 (Cancel Drain으로 해제)."
    if not st["can_stop"]:
        info["reasons"]["stop"] = "Stop 비활성: 중지할 Maintainer 실행이 없습니다."
    # Retry also revives an Issue the operator cleared (HELD, no execution); a hold with an execution needs the operator.
    cleared = target is not None and not st["occupied"] and target[0]["state"] == "HELD" and target[0]["batch_id"] is None
    st["can_retry"] = st["can_retry"] or cleared
    st["issue_number"] = info["issue"]
    return st
