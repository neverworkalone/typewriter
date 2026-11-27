"""Operator commands (TUI -> Supervisor) and status views, via the shared DB only.

Every command is scoped to one Line (model, method) or, for the `*_all` variants, to the
whole Factory. A Line never reads or writes another Line's controls.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, time as wall_time, timedelta

from . import refine, stage2
from .config import (maintainer_id, maintainer_problem, ordered_models, refine_models, refine_problem,
                     stage2_models, stage2_problem)
from .store import DROP_METHOD, MAINTENANCE_METHOD, REFINE_METHODS, STAGE2_METHOD, STAGE3_METHOD, Store
from .timing import elapsed_seconds

STATES_HELP = ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING", "MERGED", "CLEANUP",
               "COMPLETE", "PAUSED", "ERROR", "CLEARING")
MODES = {"single": "Single", "continuous": "Continuous"}   # Continuous = sequential batches in ONE Line

# #9933: War Room runs only Stage 2, the refinement line (Stage 3, ...) and the Maintainer, on Claude/Codex. Historical Stage 1 (A/B/C/D) and
# DeepSeek/OpenCode rows stay in the DB for viewing; this one rule keeps them out of every execution path.
LIVE_METHODS = frozenset({STAGE2_METHOD, *REFINE_METHODS, MAINTENANCE_METHOD})
RETIRED_REFUSAL = "지원 종료된 Line입니다 (Stage 1·DeepSeek/OpenCode, #9933): 조회만 가능하고 실행 명령은 받지 않습니다."


def retired_line(model: str, method: str, cfg: dict | None = None) -> bool:
    """A Line of a removed method, or (with `cfg`) of a producer whose retired OpenCode entry was dropped from config."""
    return method not in LIVE_METHODS or model in ((cfg or {}).get("_retired_producers") or ())


def retired(row, cfg: dict | None = None) -> bool:
    """`retired_line` for a Line row (model, method) or a batch row (producer, method)."""
    return retired_line(row["producer"] if "producer" in row.keys() else row["model"], row["method"], cfg)


def retired_rows(store: Store, cfg: dict) -> list:
    """Retired Lines and unfinished batches still in the DB (startup notice only; they are never dispatched)."""
    return [r for r in (*store.lines(), *store.incomplete_batches()) if retired(r, cfg)]


def start(store: Store, model: str, method: str, mode: str, cfg: dict | None = None) -> tuple[bool, str]:
    """Request production on a Line. Never creates a second batch for an occupied Line.

    Stage 2 (`s2`) and the refinement line (`s3`) each use one serial process for the whole factory; both need `cfg`
    to prove the selected model and role pin, and their occupancy is reserved atomically in the store (missing `cfg`
    fails closed). The refinement Stage of a NEW shard is known only when it is selected, so its `assignments.<role>`
    is proven there (and before every run); here only the line's own unfinished batch's Stage is checked.
    """
    if method == STAGE2_METHOD:
        problem = "설정을 확인할 수 없어 Stage 2를 시작하지 않습니다" if cfg is None else stage2_problem(cfg, model)
        return (False, problem) if problem else store.start_stage2(model, mode)
    if method in REFINE_METHODS:
        if cfg is None:
            return False, "설정을 확인할 수 없어 정제 Stage를 시작하지 않습니다"
        b = store.latest_batch(model, method)
        try:
            role = refine.spec_for(b).role if b is not None and b["state"] != "COMPLETE" else None
        except refine.RefineError as error:
            return False, str(error)
        if why := refine_problem(cfg, model, role):
            return False, why
        return store.start_stage3(model, mode, method)
    return False, RETIRED_REFUSAL


def drain_all(store: Store, lines) -> int:
    """Drain only target Lines that currently own an unfinished batch; cancel empty Start reservations."""
    n = store.request_drain_all(lines)
    store.log(None, f"Drain All: {n}개 미완료 배치 보유 Line Drain ON")
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
    if retired_line(model, method):
        return False, RETIRED_REFUSAL
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
    keys = [(model, STAGE2_METHOD) for model in models if model in stage2_models(cfg)]
    keys += [(model, STAGE3_METHOD) for model in refine_models(cfg)]
    keys += [(model, DROP_METHOD) for model in refine_models(cfg)]   # #10171: the Drop line below Refinement
    return [(model, method) for model, method in keys if not retired_line(model, method, cfg)]


REFINE_LABEL = "Refinement"   # the one shared refinement line; its batches show their own Stage label
DROP_LABEL = "Drop"           # #10171: the second line of the refinement engine (D1, ...), beside Refinement


def method_label(method: str) -> str:
    """Board/Detail name of a Line's method: `Stage 2`, `Refinement` or `Maintainer` (a retired method: its letter)."""
    return ("Stage 2" if method == STAGE2_METHOD else REFINE_LABEL if method == STAGE3_METHOD
            else DROP_LABEL if method == DROP_METHOD else "Maintainer" if method == MAINTENANCE_METHOD else method.upper())


def stage_label(b) -> str | None:
    """The registered Stage label of a refinement batch ("Stage 3"); None for another method or an unknown tag."""
    if b is None or b["method"] not in REFINE_METHODS:
        return None
    try:
        return refine.spec_for(b).label
    except refine.RefineError:
        return None


def set_drain(store: Store, model: str, method: str, on: bool, cfg: dict | None = None) -> None:
    if retired_line(model, method, cfg):
        return
    if method == MAINTENANCE_METHOD:   # one Maintainer queue: the flag is global to it, whichever producer ran an Issue
        for ln in store.lines():
            if ln["method"] == MAINTENANCE_METHOD and ln["drain"] and not on:
                store.set_line(ln["model"], MAINTENANCE_METHOD, drain=0)
        return store.set_line(model, method, drain=1) if on else None
    return store.request_drain(model, method, on)


def drained(store: Store, ln) -> bool:
    """The Line's single Drain flag blocks all new batch assignments, regardless of which control set it."""
    return bool(ln["drain"])


def stop_line(store: Store, model: str, method: str, cfg: dict | None = None) -> None:
    if not retired_line(model, method, cfg):
        store.stop_lines(model, method)


def stop_batch(store: Store, model: str, method: str, batch_id: int, cfg: dict | None = None) -> bool:
    """Stop bound to one producer execution: False (nothing written) unless `batch_id` is still this Line's unfinished
    batch, and the Supervisor drops the request if another batch became current before it consumes it."""
    return not retired_line(model, method, cfg) and store.request_stop_pinned(model, method, batch_id)


def stop_maintainer(store: Store, model: str, batch_id: int) -> bool:
    """Stop the Maintainer execution `batch_id` the operator saw; False (nothing stopped) when it is no longer current."""
    return store.request_stop_pinned(model, MAINTENANCE_METHOD, batch_id)


def stop_all(store: Store) -> None:
    store.stop_lines()


def request_clear(store: Store, model: str, method: str, batch_id: int, issue_number: int | None = None,
                  cfg: dict | None = None) -> tuple[bool, str]:
    """Operator Clear of ONE unfinished batch: only writes the batch-ID-specific request (the Supervisor tears down).

    The Maintainer's execution must also name the urgent Issue the operator saw (a stale screen touches nothing else).
    """
    if retired_line(model, method, cfg):
        return False, RETIRED_REFUSAL
    return store.request_clear(model, method, batch_id, issue_number)


def defect_locked(store: Store, b) -> bool:
    """A batch paused for a shared defect resumes only through the automatic release; an operator can override it
    only after an explicit Stop (which sets the hold), so a plain Retry never skips the fix."""
    return b["pause_reason"] == "shared_defect" and not store.get(f"defect_hold_{b['id']}")


def retry(store: Store, model: str, method: str, batch_id: int | None = None, cfg: dict | None = None) -> bool:
    if retired_line(model, method, cfg):
        return False
    b = store.batch(batch_id) if batch_id is not None else store.active_batch(model, method)
    if (b is not None and b["producer"] == model and b["method"] == method
            and store.clear_request(model, method) is None and b["state"] in ("PAUSED", "ERROR")
            and b["pid"] is None and not store.open_task_runs(b["id"]) and not defect_locked(store, b)):
        store.set_line(model, method, retry_batch=b["id"])
        return True
    return False


def retry_maintainer(store: Store, issue_number: int | None = None, batch_id: int | None = None) -> bool:
    """Retry the Maintainer: its PAUSED/ERROR execution, or (Detail only: `issue_number` given) an Issue the operator
    cleared and that therefore waits HELD with no execution. `issue_number`/`batch_id` pin what the operator saw: a
    screen that no longer matches retries nothing."""
    if issue_number is not None:
        owner = store.maintenance(issue_number)
        if owner is None:
            return False
        if owner["batch_id"] is None:
            if batch_id is not None or any(b["method"] == MAINTENANCE_METHOD for b in store.incomplete_batches()):
                return False
            return store.requeue_maintenance(issue_number)
        if batch_id is not None and owner["batch_id"] != batch_id:
            return False
        target = store.batch(owner["batch_id"])
        if target is None or target["state"] == "COMPLETE":
            if batch_id is not None or any(b["method"] == MAINTENANCE_METHOD for b in store.incomplete_batches()):
                return False
            return store.requeue_maintenance(issue_number)
    elif batch_id is not None:
        target = store.batch(batch_id)
    else:
        target = next((b for b in store.incomplete_batches() if b["method"] == MAINTENANCE_METHOD), None)

    if target is None or target["method"] != MAINTENANCE_METHOD:
        return False
    if batch_id is not None and target["id"] != batch_id:
        return False
    owner = next((m for m in store.maintenance_rows() if m["batch_id"] == target["id"]), None)
    if owner is None or (issue_number is not None and owner["issue_number"] != issue_number):
        return False
    if any(b["id"] != target["id"] and (
            b["state"] in ("PREPARE", "PRODUCING", "FIXING") or b["pid"] is not None
            or store.open_task_runs(b["id"])) for b in store.maintenance_batches()):
        return False
    return retry(store, target["producer"], MAINTENANCE_METHOD, target["id"])


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
           "blocked": ln["blocked"] or "",
           "batch_id": None, "activity": None, "occupied": False, "updated": None, "records_total": None,
           "records_done": None, "progress_kind": None, "progress_done": None, "progress_total": None,
           "elapsed": None, "stage2": None, "wait": "", "stage_label": None}
    if method == STAGE2_METHOD:
        out["wait"] = store.get(f"s2_wait_{model}") or ""
    elif method in REFINE_METHODS:
        out["wait"] = store.get(f"{method}_wait_{model}") or ""
    out["drain"] = out["line_drain"]
    keys = [f"tw_line:{model}:{method}:prepare"]
    if b is not None and b["state"] != "COMPLETE":
        keys += [r["key"] for r in store.kv_prefix(f"tw_b{b['id']}:")]
    if text := transient_wait_text(store, keys):   # a stage-2 Part wait and a retry wait may both be shown
        out["wait"] = "; ".join(x for x in (out["wait"], text) if x)
    if b is not None and b["state"] != "COMPLETE":   # a finished batch leaves the slot EMPTY; it stays in history
        batch_name = f"Issue #{b['batch']}" if method == MAINTENANCE_METHOD else f"{b['shard']}_{b['batch']}"
        out.update(state=b["state"], batch=batch_name, branch=b["branch"],
                   pr=b["pr_number"], head=b["head_sha"], session=b["session_id"],
                   error=b["error"], worktree=b["worktree"], batch_id=b["id"], updated=b["updated_at"],
                   records_total=b["records_total"], records_done=b["records_done"],
                   progress_kind=b["progress_kind"], progress_done=b["progress_done"],
                   progress_total=b["progress_total"],
                   occupied=True)
        if method == STAGE2_METHOD:   # the Part's identity replaces the record counters
            batch, part = stage2.split_key(b["batch"])
            out["stage2"] = {"shard": b["shard"], "batch": batch, "part": part}
            tasks = store.task_rows(b["id"])
            if tasks:   # parallel primary: running / queued (not started or waiting for a slot) / saved task counts
                count = lambda *states: sum(1 for t in tasks if t["state"] in states)
                out["stage2"]["tasks"] = {"running": count("RUNNING"), "queued": count("PENDING", "FIXQ", "RESPONDED"),
                                          "saved": count("SAVED"), "failed": count("FAILED"), "total": len(tasks)}
        if method in REFINE_METHODS:   # parallel refinement chunks: running / queued / responded / saved / failed
            out["stage_label"] = stage_label(b)
            tasks = store.task_rows(b["id"])
            if tasks:
                count = lambda *states: sum(1 for t in tasks if t["state"] in states)
                out["tasks"] = {"running": count("RUNNING"), "queued": count("PENDING"), "responded": count("RESPONDED"),
                                "saved": count("SAVED"), "failed": count("FAILED"), "total": len(tasks)}
                # Each task becomes SAVED only after save-chunk is reflected in the checkpoint. The checkpoint
                # snapshot can lag by one parallel poll when the last responses are saved and finalization begins.
                out["progress_kind"], out["progress_done"], out["progress_total"] = (
                    "chunks", out["tasks"]["saved"], out["tasks"]["total"])
        if b["progress_kind"] and b["progress_done"] is not None and b["progress_total"]:
            out["progress"] = f"{b['progress_done']}/{b['progress_total']} {b['progress_kind']}"
        elif b["records_done"] is not None and b["records_total"]:
            out["progress"] = f"{b['records_done']}/{b['records_total']}"  # recorded only
        runs = store.runs(b["id"])
        if runs:   # actual batch elapsed time: the union of recorded run intervals
            now = time.time()
            out["elapsed"] = elapsed_seconds(runs, now=now)
        ev = store.last_event(b["id"])
        if ev:
            out["activity"] = (ev["ts"], ev["msg"])
    # Buttons: only meaningful commands are enabled.
    st = out["state"]
    out["can_drain"] = (out["occupied"] and st != "CLEARING") or out["run"]
    out["can_stop"] = out["occupied"] and st not in ("PAUSED", "ERROR", "CLEARING") or out["run"]
    out["stoppable"] = (out["occupied"] and st != "CLEARING") or out["run"]   # what `stop_lines` can actually affect
    out["can_retry"] = (st in ("PAUSED", "ERROR") and b["pid"] is None and not store.open_task_runs(b["id"])
                        and not defect_locked(store, b))
    req = store.clear_request(model, method) if out["occupied"] else None
    out["clear"] = None if req is None else {"status": req["status"], "error": req["error"]}
    # Clear needs a specific unfinished batch; once started it can only be re-armed after a BLOCKED teardown.
    out["can_clear"] = out["occupied"] and (req is None or req["status"] == "BLOCKED")
    return out


def can_stop_all(store: Store, lines) -> bool:
    """Stop All has a target while any Line has an unfinished batch (incl. PAUSED/ERROR) or a run flag."""
    return any(line_status(store, m, me)["stoppable"] for m, me in lines)


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
    b = store.batch(m["batch_id"]) if m["batch_id"] else None
    live = b is not None and b["state"] in _MAINT_AI + _MAINT_PR   # a running attempt outranks an older hold reason
    held = [d for d in deps if d["state"] == "HELD"]
    if held and not live:
        return f"보류: {_short(held[0]['hold_reason'], n)}"
    if st == "HELD" and not live:
        return f"보류: {_short(m['hold_reason'], n)}"
    if st == "QUEUED":
        if cfg.get("maintainer") is None:
            return "Maintainer 미설정 · 대기"
        problem = maintainer_problem(cfg)
        return f"Maintainer 설정 오류 · {_short(problem, n)}" if problem else "Maintainer 대기 중"
    if st == "DONE":
        return "머지·Cleanup 완료 · 종속 배치 수정 반영 중"
    if st == "RECOVERING":
        return "원 배치 복구 확인 중"
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
            "CLEARING": f"{pr}Maintainer Clear 진행 중",
            "COMPLETE": f"{pr}Cleanup 완료 · 머지 확인 중"}.get(b["state"], b["state"])


_MAINT_AI = ("PREPARE", "PRODUCING", "FIXING")
_MAINT_PR = ("WAITING_REVIEW", "MERGED", "CLEANUP", "CLEARING")


def _maintenance_residual(store: Store, m, linked) -> bool:
    """Whether an Issue is only a past Maintainer record: its source work is over and nothing is being done for it.

    Only explicit local evidence counts: every linked defect is RELEASED/OVERRIDDEN or its source batch row exists and
    is COMPLETE (a missing source row proves nothing). A RECOVERING/QUEUED/DONE Issue is never residual — the
    Supervisor still has to settle it — and neither is one whose attempt is running or owns a PR lifecycle.
    """
    if m["state"] not in ("HELD", "ACTIVE") or not linked:
        return False
    b = store.batch(m["batch_id"]) if m["batch_id"] else None
    if b is not None and (b["state"] in _MAINT_AI + _MAINT_PR or b["pid"] is not None):
        return False
    for d in linked:
        if d["state"] in ("RELEASED", "OVERRIDDEN"):
            continue
        source = store.batch(d["batch_id"])
        if source is None or source["state"] != "COMPLETE":
            return False
    return True


def _maintenance_split(store: Store) -> tuple[list[tuple], list[tuple]]:
    """(current, residual) lists of (maintenance row, its dependent defects), oldest first."""
    linked: dict[int, list] = {}
    for d in store.defects():
        if d["issue_number"] is not None:
            linked.setdefault(d["issue_number"], []).append(d)
    current, residual = [], []
    for m in store.maintenance_rows():
        own = linked.get(m["issue_number"], [])
        deps = [d for d in own if d["state"] in ("LINKED", "FIX_MERGED", "HELD")]
        if m["state"] in ("DONE", "HELD") and not deps:
            continue   # nothing depends on it any more (all released/overridden): closed
        (residual if _maintenance_residual(store, m, own) else current).append((m, deps))
    return current, residual


def open_maintenance(store: Store) -> list[tuple]:
    """(maintenance row, its dependent defects) of every urgent Issue that still needs work or attention, oldest first.

    Past records whose source batches already finished are left out (see `residual_maintenance`)."""
    return _maintenance_split(store)[0]


def residual_maintenance(store: Store) -> list[tuple]:
    """Past Issues that still own an unfinished Maintainer attempt (Detail only: the operator can still Clear it)."""
    unfinished = {b["id"] for b in store.maintenance_batches()}
    return [(m, deps) for m, deps in _maintenance_split(store)[1] if m["batch_id"] in unfinished]


_BAD_PREFIXES = ("보류", "Maintainer 설정 오류", "Maintainer 미설정")


def _needs_attention(text: str) -> bool:
    return text.startswith(_BAD_PREFIXES) or "PAUSED" in text or "ERROR" in text


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
        items.append((f"urgent issue #{m['issue_number']} · {text}", _needs_attention(text)))
    return items


def urgent_line(store: Store, cfg: dict) -> str:
    """One line for the current urgent Issue (+ how many others wait); "" when nothing is open."""
    items = urgent_items(store, cfg)
    if not items:
        return ""
    return items[0][0] + (f" (+{len(items) - 1}건 대기)" if len(items) > 1 else "")


def _card_rank(store: Store, m, deps) -> tuple[int, int]:
    """Board card order of one open Issue: running AI, owned PR lifecycle, fix landing / recovery being verified,
    a failure that needs the operator, then a queued Issue. Running attempts go newest first, the rest oldest first."""
    b = store.batch(m["batch_id"]) if m["batch_id"] else None
    if b is not None and (b["state"] in _MAINT_AI or b["pid"] is not None):
        return 0, -b["id"]
    if b is not None and b["state"] in _MAINT_PR:
        return 1, -b["id"]
    held = m["state"] == "HELD" or any(d["state"] == "HELD" for d in deps)
    if m["state"] == "ACTIVE" and b is not None and b["state"] == "COMPLETE" and not held:
        return 1, -b["id"]   # cleaned up; the Supervisor confirms the merge on its next tick
    if m["state"] in ("DONE", "RECOVERING") and not held:
        return 2, 0
    return (4, 0) if m["state"] == "QUEUED" and not held else (3, 0)


def maintainer_card(store: Store, cfg: dict) -> dict:
    """Status-only content of the Board's Maintainer card (Issue #1684):
    {"state": IDLE|WORKING|COMING|ERROR|WAITING, "text": str, ...}.

    It shows the #1555 Maintainer's persisted progress whichever model runs it; it starts nothing. The TUI and the
    web Board both show exactly this: the one Issue that matters now among those still needing work or attention
    (`open_maintenance`). Past records whose source batches already finished never reach the card; IDLE is the
    neutral empty card.
    """
    rows = open_maintenance(store)
    reported = store.defects(("REPORTED",))
    more = len(rows) + len(reported) - 1
    suffix = f" (+{more}건 대기)" if more > 0 else ""
    out = {"state": "IDLE", "text": "", "issue": "", "pr": "", "detail": "", "elapsed": None}
    if not rows:
        if not reported:
            return {"state": "IDLE", "text": ""}
        # a pending defect report has no Issue yet: keep the plain wrap
        out.update(state="WORKING", text=f"urgent · 공통 결함 `{reported[0]['defect_class']}` · Issue 등록 대기" + suffix)
        return out
    ranked = sorted(rows, key=lambda r: _card_rank(store, *r))   # stable: equal ranks stay oldest first
    m, deps = ranked[0]
    rank = _card_rank(store, m, deps)[0]
    rest = _maintainer_text(store, cfg, m, deps)
    head = f"urgent issue #{m['issue_number']}"
    out["state"] = ("ERROR" if _needs_attention(rest) or rank == 3 else
                    "WORKING" if rank < 2 else "COMING" if rank == 2 else "WAITING")
    out["text"] = f"{head} · {rest}{suffix}"
    out["issue"] = head + suffix
    b = store.batch(m["batch_id"]) if m["batch_id"] else None
    if b is not None:   # the same actual elapsed time as every other card
        runs, now = store.runs(b["id"]), time.time()
        if runs:
            out["elapsed"] = elapsed_seconds(runs, now=now)
    if out["state"] == "ERROR":
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
    unfinished = {b["id"] for b in store.maintenance_batches()}
    residual = None
    if st["occupied"] and (target is None or target[0]["batch_id"] not in unfinished):
        # The unfinished attempt on screen belongs to a past Issue: keep its exact Issue number so Clear still works.
        residual = next((r for r in residual_maintenance(store) if r[0]["batch_id"] == st["batch_id"]), None)
        target = residual or target
    info = {"issue": None, "row_state": None, "text": "", "hold": "", "others": [], "drain_note": "", "reasons": {},
            "residual": residual is not None}
    if target is not None:
        m, deps = target
        text = _maintainer_text(store, cfg, m, deps, True)
        if residual is not None:
            text = "원 배치 완료 · 잔여 Maintainer 기록 · " + text
        info.update(issue=m["issue_number"], row_state=m["state"], text=text, hold=m["hold_reason"] or "")
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
    # Retry revives an operator-cleared Issue or explicitly reopens an undetermined diagnosis; other holds stay held.
    cleared = target is not None and not st["occupied"] and target[0]["state"] == "HELD" and target[0]["batch_id"] is None
    diagnosis_retry = (target is not None and not st["occupied"] and target[0]["state"] == "HELD"
                       and store.maintenance_retryable(target[0]["issue_number"]))
    st["can_retry"] = st["can_retry"] or cleared or diagnosis_retry
    st["issue_number"] = info["issue"]
    return st


# --- the Recovery lane's Board card and read-only Detail ----------------------------------------------------------------
RECOVERY_STATES = ("IDLE", "WORKING", "TRACKING", "WAITING_OWNER", "ERROR")


def _case_rank(store: Store, case, open_runs) -> tuple[int, int]:
    run = next((r for r in open_runs if r["case_id"] == case["id"]), None)
    if run is not None:
        return 0, case["id"]
    return {"OPEN": 1, "WAITING_OWNER": 2, "TRACKING": 3, "MAINTAINER": 3}.get(case["state"], 4), case["id"]


def recovery_card(store: Store, cfg: dict, watchdog: dict | None = None, now: float | None = None) -> dict:
    """Status-only content of the Recovery card (below the Maintainer card): the case that matters now, its model,
    elapsed time and summary. A watchdog startup failure is an ERROR. It starts nothing."""
    now = time.time() if now is None else now
    out = {"state": "IDLE", "key": "", "model": "", "elapsed": None, "summary": "", "more": 0}
    if watchdog and watchdog.get("failed_key"):
        attempt = watchdog.get("evidence") or {}
        out.update(state="ERROR", key="supervisor",
                   summary=f"Supervisor 기동 실패 (./kwar exit {attempt.get('kwar_exit')}) — 같은 조건 재시도 중단")
    try:
        cases, runs = store.open_recovery_cases(), store.open_recovery_runs()
    except Exception:   # an older DB without the Recovery tables: nothing to show
        cases, runs = [], []
    if not cases:
        if out["state"] == "IDLE":
            out["summary"] = "열린 복구 case 없음" if cfg.get("recovery") is not None else "Recovery 꺼짐 (config recovery 미설정)"
        return out
    ranked = sorted(cases, key=lambda c: _case_rank(store, c, runs))
    case = ranked[0]
    out["more"] = len(cases) - 1
    run = next((r for r in runs if r["case_id"] == case["id"]), None)
    try:
        report = json.loads(case["last_report"] or "{}")
    except ValueError:
        report = {}
    if out["state"] != "ERROR":
        if run is not None:
            out["state"] = "WORKING"
        elif case["state"] == "WAITING_OWNER":
            out["state"] = "WAITING_OWNER"
        elif case["state"] in ("TRACKING", "MAINTAINER"):
            out["state"] = "TRACKING"
        elif case["next_action_at"] and case["next_action_at"] > now:
            out["state"] = "ERROR"   # backing off after no progress: the owner should look
        else:
            out["state"] = "WORKING"
        out["key"] = case["key"]
        notes = (case["notes"] or "").strip().splitlines()
        out["summary"] = (report.get("REMAINING") or report.get("DONE") or (notes[-1] if notes else "")
                          or case["kind"])
    model = (run["model"] if run is not None else None) or case["producer"] or ""
    out["model"] = model
    if run is not None:
        out["elapsed"] = max(0.0, now - run["started_at"])
    elif case["opened_at"]:
        out["elapsed"] = max(0.0, now - case["opened_at"])
    return out


def recovery_detail(store: Store, limit: int = 20) -> list[dict]:
    """Every open case first, then recent resolved ones: state, ownership, blocking unit, session, report, logs, wait."""
    try:
        cases = list(store.open_recovery_cases()) + [c for c in store.recovery_cases(limit) if c["state"] == "RESOLVED"]
    except Exception:
        return []
    out = []
    for c in cases[:limit]:
        def load(text):
            try:
                return json.loads(text or "null")
            except ValueError:
                return text
        out.append({"id": c["id"], "key": c["key"], "kind": c["kind"], "state": c["state"], "issue": c["issue"],
                    "pr": c["pr_number"], "session": c["session_id"], "producer": c["producer"],
                    "batches": store.recovery_case_batch_ids(c["id"]), "blocking_unit": load(c["blocking_unit"]),
                    "wait_reason": load(c["wait_reason"]), "last_report": load(c["last_report"]),
                    "notes": c["notes"], "opened_at": c["opened_at"], "resolved_at": c["resolved_at"],
                    "runs": [{k: r[k] for k in ("id", "kind", "model", "pid", "log_file", "started_at", "ended_at",
                                               "exit_status")} for r in store.recovery_runs(c["id"])[-5:]]})
    return out
