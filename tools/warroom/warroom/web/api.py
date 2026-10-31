"""Web API over the shared Store and `control` (Issue #1720). A second View, never a second Controller.

Reads come from `control.line_status` and `views`; every change goes through the same `control` function the TUI
calls. Nothing here starts a Supervisor, an AI CLI, tmux, git or a shell, and no business rule is duplicated.
Stdlib only, so CI tests it without Textual.
"""
from __future__ import annotations

import re
import time
from pathlib import Path

from .. import control, views
from ..config import Paths, adapter_label, adapters, methods, ordered_models, registry, role_view, stage2_models, STAGE2_ADAPTERS
from ..logrender import render_line
from ..logtail import INITIAL_BYTES, MAX_CHUNK, redact
from ..store import STAGE2_METHOD, Store

MAX_LINE_CHARS = 8000        # one log line sent to the browser
MAX_LOG_LINES = 1000         # lines per log response (the rest arrives on the next poll)
AUDIT_TAIL = 300             # audit events shown on the first view
SOURCE = re.compile(r"^(latest|audit|run:[0-9]{1,12})$")
OFFLINE_MSG = "Supervisor가 실행 중이 아닙니다(OFFLINE). 상태·이력 조회만 가능하며 변경 명령은 거절됩니다."


class ApiError(Exception):
    def __init__(self, status: int, message: str, **extra):
        super().__init__(message)
        self.status, self.message, self.extra = status, message, extra


def clean(value):
    """Redact every string of a JSON-able structure: no credential leaves the server, whatever field it sits in."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean(v) for v in value]
    return value


# --- the Board's Lines (same set as the TUI) ------------------------------------------------------------------------
def board_lines(store: Store, cfg: dict) -> tuple[list[str], list[tuple[str, str]]]:
    cols = ordered_models(cfg)
    cols += sorted({ln["model"] for ln in store.lines()} - set(cols))
    s2 = set(stage2_models(cfg))
    ms = methods(cfg)
    return cols, [(m, me) for m in cols for me in ms] + [(m, STAGE2_METHOD) for m in cols if m in s2]


def _line_view(st: dict) -> dict:
    """Card fields the browser needs, computed with the TUI's own helpers."""
    out = dict(st)
    idle = st["batch"] is None
    out["label"] = control.method_label(st["method"])
    out["idle"] = idle
    out["phase"] = None if idle else views.PHASE.get(st["state"], st["state"])
    out["icon"] = None if idle else views.ICON.get(st["state"], "?")
    out["idle_text"] = views._idle_phase(st).lstrip("— ").strip() if idle else None
    done, total, unit = views.progress_of(st)
    observed = done is not None and bool(total)
    out["progress_text"] = f"{done} / {total} {unit}" if observed else None
    out["progress_pct"] = round(min(done, total) / total * 100, 1) if observed else None
    out["elapsed_text"] = views.fmt_elapsed(st["elapsed"]) if st.get("elapsed") is not None else None
    out["activity"] = list(st["activity"]) if st["activity"] else None
    return out


def _controls(cfg: dict) -> dict:
    reg = registry(cfg)
    ms = methods(cfg)
    groups = []
    for a in adapters(cfg):
        meths = [{"id": m, "label": m.upper()} for m in ms]
        if a in STAGE2_ADAPTERS:
            meths.append({"id": STAGE2_METHOD, "label": "Stage 2"})
        groups.append({"id": a, "label": adapter_label(a), "methods": meths,
                       "models": [{"id": p, "label": f"{reg[p]['label']} ({p})"}
                                  for p in ordered_models(cfg) if reg[p]["adapter"] == a]})
    return {"adapters": groups, "modes": [{"id": k, "label": v} for k, v in control.MODES.items()]}


def board(store: Store, cfg: dict) -> dict:
    cols, keys = board_lines(store, cfg)
    reg = registry(cfg)
    statuses = {k: control.line_status(store, *k) for k in keys}
    capable = set(stage2_models(cfg))
    maint_col = next((m for m in cols if m not in capable), None)
    stage2_owner = views.stage2_display_model(
        store, cfg, {model: statuses[(model, STAGE2_METHOD)] for model in capable})
    stage2_card = None
    if stage2_owner:
        stage2_card = _line_view(statuses[(stage2_owner, STAGE2_METHOD)])
        stage2_card["owner_label"] = adapter_label(reg[stage2_owner]["adapter"])
        stage2_card["column"] = views.stage2_column(cfg)
    alive = control.supervisor_alive(store)
    notes = [f"{s['model']}/{control.method_label(s['method'])} BLOCKED: {s['blocked']}"
             for s in statuses.values() if s["blocked"]]
    if not alive:
        notes.insert(0, OFFLINE_MSG)
    return clean({
        "now": time.time(), "alive": alive, "notes": notes,
        "columns": [{"id": m, "label": reg.get(m, {}).get("label", m)} for m in cols],
        "lines": [_line_view(statuses[k]) for k in keys],
        "stage2_card": stage2_card, "stage3_column": views.role_column(cfg, "codex"),
        "maintainer": {"column": maint_col, **control.maintainer_card(store, cfg)} if maint_col else None,
        "urgent": [{"text": t, "bad": bad} for t, bad in control.urgent_items(store, cfg)],
        "tier": control.tier_state(store, cfg, methods(cfg)),
        "can_stop_all": control.can_stop_all(store, keys),
        "controls": _controls(cfg),
    })


def _known(store: Store, cfg: dict, model: str, method: str) -> None:
    if (model, method) not in board_lines(store, cfg)[1]:
        raise ApiError(404, "알 수 없는 라인입니다.")


def _run_row(r) -> dict:
    return {"id": r["id"], "shard": r["shard"], "batch": r["batch"], "kind": r["kind"], "model": r["model"],
            "effort": r["effort"], "started_at": r["started_at"], "ended_at": r["ended_at"],
            "exit_status": r["exit_status"]}


def line_detail(store: Store, cfg: dict, paths: Paths, model: str, method: str) -> dict:
    _known(store, cfg, model, method)
    st = control.line_status(store, model, method)
    reg = role_view(cfg, model, method)   # the pin this Line's stage runs on, never another stage's
    runs = store.line_runs(model, method)
    return clean({
        "line": _line_view(st), "header": views.detail_header(st, reg, model), "meta": views.detail_meta(st, reg, model),
        "runs": [{**_run_row(r), "log_exists": _log_path(paths, r["log_file"]) is not None} for r in runs],
    })


# --- logs: only runs recorded in the DB, never a client-supplied path ----------------------------------------------
def _log_path(paths: Paths, recorded: str | None) -> Path | None:
    """The recorded log file if it exists inside the War Room log directory; None otherwise."""
    if not recorded:
        return None
    try:
        p, root = Path(recorded).resolve(), paths.logs.resolve()
        return p if root in p.parents and p.is_file() else None
    except OSError:
        return None


def _read_file(path: Path, cursor: int | None) -> tuple[list[str], int, bool]:
    """(raw lines, next cursor, reset). First view = the tail of a long log; later views read only appended bytes."""
    size = path.stat().st_size
    reset, skip_first = False, False
    if cursor is None:
        cursor = max(0, size - INITIAL_BYTES)
        skip_first = cursor > 0
    elif cursor > size:                       # truncated / rotated: start again from the top
        cursor, reset = 0, True
    if size == cursor:
        return [], cursor, reset
    with open(path, "rb") as fh:
        fh.seek(cursor)
        chunk = fh.read(min(size - cursor, MAX_CHUNK))
    end = chunk.rfind(b"\n") + 1              # only complete lines; a partial tail waits for the next poll
    if end == 0:
        if len(chunk) < MAX_CHUNK and cursor + len(chunk) >= size:
            return [], cursor, reset
        end = len(chunk)                      # one huge line: do not stall on it
    parts = chunk[:end].split(b"\n")
    if parts and parts[-1] == b"":
        parts.pop()
    take = parts[:MAX_LOG_LINES]              # the rest arrives on the next poll
    used = sum(len(p) + 1 for p in take)
    if skip_first and take:                   # we may have started mid-line
        take = take[1:]
    return [l.decode("utf-8", errors="replace").rstrip("\r") for l in take], cursor + min(used, end), reset


def _shorten(line: str) -> str:
    return line if len(line) <= MAX_LINE_CHARS else line[:MAX_LINE_CHARS] + f"… (+{len(line) - MAX_LINE_CHARS}자 생략)"


def read_log(store: Store, cfg: dict, paths: Paths, model: str, method: str, source: str = "latest",
             cursor: int | None = None, run: int | None = None, raw: bool = False) -> dict:
    _known(store, cfg, model, method)
    if not SOURCE.match(source):
        raise ApiError(400, "알 수 없는 로그 종류입니다.")
    runs = store.line_runs(model, method)
    if source == "audit":
        # first view: one bounded tail query (cost independent of history size); then only newer events
        events = list(store.line_events_tail(model, method, AUDIT_TAIL) if cursor is None
                      else store.line_events(model, method, cursor))
        nxt = events[-1]["id"] if events else (cursor or 0)
        return clean({"key": "audit", "live": any(r["ended_at"] is None for r in runs), "missing": False,
                      "message": "", "reset": False, "cursor": nxt,
                      "lines": [f"{views._hhmm(e['ts'])} {e['level'].upper():5} {e['msg']}" for e in events]})
    target = runs[0] if source == "latest" and runs else next(
        (r for r in runs if source != "latest" and r["id"] == int(source[4:])), None)
    if target is None:
        return {"key": source, "live": False, "missing": True, "reset": False, "cursor": 0, "lines": [],
                "message": "실행 기록이 없습니다." if source == "latest" else "이 라인의 실행 기록에 없는 실행입니다."}
    key = f"run:{target['id']}"
    live = target["ended_at"] is None
    path = _log_path(paths, target["log_file"])
    if path is None:
        why = "로그 파일이 아직 생성되지 않았습니다." if live else (
            "로그 파일이 삭제되었거나 없습니다. 실행 이력(DB)만 남아 있습니다.")
        return {"key": key, "live": live, "missing": True, "message": why, "reset": False, "cursor": 0, "lines": []}
    if run is not None and run != target["id"]:
        cursor = None                         # the cursor belongs to another run's file
    try:
        lines, nxt, reset = _read_file(path, cursor)
    except OSError:
        return {"key": key, "live": live, "missing": True, "reset": False, "cursor": 0, "lines": [],
                "message": "로그 파일을 읽을 수 없습니다."}
    seen: set = set()
    out: list[str] = []
    for line in lines:
        out += [line] if raw else render_line(line, seen)
    return clean({"key": key, "run_id": target["id"], "live": live, "missing": False, "message": "",
                  "reset": reset or (run is not None and run != target["id"]), "cursor": nxt,
                  "lines": [_shorten(l) for l in out]})


# --- commands ------------------------------------------------------------------------------------------------------
FIELDS = {
    "start": {"model", "method", "mode"},
    "drain": {"model", "method", "on"},
    "retry": {"model", "method"},
    "stop": {"model", "method", "confirm"},
    "clear": {"model", "method", "batch_id", "confirm"},
    "drain_all": set(),
    "stop_all": {"confirm"},
}
STOP_ALL_CONFIRM = "stop-all"


def _str(body: dict, key: str) -> str:
    v = body.get(key)
    if not isinstance(v, str) or not v:
        raise ApiError(400, f"'{key}' 값이 필요합니다.")
    return v


def command(store: Store, cfg: dict, body) -> dict:
    """Validate, then run ONE allowed command through `control`. Every refusal is an ApiError; nothing else mutates."""
    if not isinstance(body, dict) or not isinstance(body.get("cmd"), str) or body["cmd"] not in FIELDS:
        raise ApiError(400, "허용되지 않은 명령입니다.")
    cmd = body["cmd"]
    extra = set(body) - FIELDS[cmd] - {"cmd"}
    if extra:
        raise ApiError(400, "허용되지 않은 인자입니다: " + ", ".join(sorted(map(str, extra))))
    keys = board_lines(store, cfg)[1]
    target = None
    if "model" in FIELDS[cmd]:
        target = (_str(body, "model"), _str(body, "method"))
        if cmd == "start" and target[1] == STAGE2_METHOD:
            if target[0] not in registry(cfg):
                raise ApiError(404, "알 수 없는 모델입니다.")
        elif target not in keys:
            raise ApiError(404, "알 수 없는 라인입니다.")
    if cmd == "start" and body.get("mode") not in control.MODES:
        raise ApiError(400, "mode는 single 또는 continuous여야 합니다.")
    if cmd == "drain" and not isinstance(body.get("on"), bool):
        raise ApiError(400, "'on'은 true/false여야 합니다.")
    if cmd == "clear" and (type(body.get("batch_id")) is not int):
        raise ApiError(400, "'batch_id'는 정수여야 합니다.")
    if not control.supervisor_alive(store):   # OFFLINE: view only, every change is refused
        raise ApiError(409, OFFLINE_MSG, offline=True)

    def need(expected: str) -> None:
        if body.get("confirm") != expected:
            raise ApiError(400, "확인이 필요한 명령입니다.", confirm_required=expected)

    if cmd == "start":
        ok, msg = control.start(store, *target, body["mode"], cfg=cfg)
        if not ok:
            raise ApiError(409, msg)
        return {"ok": True, "message": "시작 요청됨"}
    st = control.line_status(store, *target) if target else None
    if cmd == "drain":
        if body["on"] and not (st["can_drain"] or st["line_drain"]):
            raise ApiError(409, "Drain할 대상이 없습니다.")
        control.set_drain(store, *target, body["on"])
        return {"ok": True, "message": "Drain 설정됨" if body["on"] else "Drain 해제됨"}
    if cmd == "retry":
        if not control.retry(store, *target):
            raise ApiError(409, "지금은 Retry할 수 없는 상태입니다.")
        return {"ok": True, "message": "Retry 요청됨"}
    if cmd == "stop":
        need(f"{target[0]}/{target[1]}")
        if not st["can_stop"]:
            raise ApiError(409, "중지할 실행이 없습니다.")
        control.stop_line(store, *target)
        return {"ok": True, "message": "중지 요청됨"}
    if cmd == "clear":
        need(f"{target[0]}/{target[1]}/{body['batch_id']}")
        if not st["can_clear"] or st["batch_id"] != body["batch_id"]:
            raise ApiError(409, "대상 배치가 바뀌었거나 Clear할 수 없는 상태입니다 (화면을 새로 고치세요).")
        ok, msg = control.request_clear(store, *target, body["batch_id"])
        if not ok:
            raise ApiError(409, msg)
        return {"ok": True, "message": "Clear 요청됨 — 정리 진행 중"}
    if cmd == "drain_all":
        return {"ok": True, "message": f"{control.drain_all(store, keys)}개 라인 종료 요청"}
    need(STOP_ALL_CONFIRM)                    # stop_all
    if not control.can_stop_all(store, keys):
        raise ApiError(409, "중지할 라인이 없습니다.")
    control.stop_all(store)
    return {"ok": True, "message": "모든 라인 중지 요청됨"}
