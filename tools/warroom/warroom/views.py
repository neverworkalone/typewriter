"""Pure view text for the War Room board and Batch Detail (stdlib only, so CI can test it without Textual)."""
from __future__ import annotations

import os
import time
import unicodedata

from . import control
from .config import adapter_label


def _hhmm(ts) -> str:
    return time.strftime("%H:%M:%S", time.localtime(ts)) if ts else "-"


def _when(ts) -> str:
    """Time of day for today, date + time otherwise."""
    if not ts:
        return "-"
    t = time.localtime(ts)
    return time.strftime("%H:%M" if t[:3] == time.localtime()[:3] else "%m-%d %H:%M", t)


CARD_W = 34   # content cells of a card (column 38 - border - padding): every line is fit to it
PHASE = {"WAITING_REVIEW": "REVIEW"}
ICON = {"PREPARE": "…", "PRODUCING": "▶", "WAITING_REVIEW": "◔", "FIXING": "✎", "MERGED": "⇄",
        "CLEANUP": "⌫", "COMPLETE": "✓", "PAUSED": "‖", "ERROR": "✖"}


def cell_len(text: str) -> int:
    """Terminal cells: East Asian wide/fullwidth characters take two."""
    return sum(0 if unicodedata.combining(ch) else 2 if unicodedata.east_asian_width(ch) in "WF" else 1 for ch in text)


def set_cell_size(text: str, width: int) -> str:
    """Longest prefix of `text` that fits `width` cells."""
    out, used = [], 0
    for ch in text:
        w = cell_len(ch)
        if used + w > width:
            break
        out.append(ch)
        used += w
    return "".join(out)


def _fit(text: str, width: int = CARD_W) -> str:
    text = " ".join(text.split())
    return text if cell_len(text) <= width else set_cell_size(text, width - 1).rstrip() + "…"


def _idle_phase(st: dict) -> str:
    """A Line without a batch: a pending Start or a Drain that will block it is still operator-relevant."""
    if st["drain"]:
        return "비어 있음 + DRAIN" + ("  시작 예약" if st.get("run") else "")
    return "—  시작 예약 중" if st.get("run") else "—  실행 이력 없음"


def card_text(st: dict) -> str:
    """Card = Line summary in a fixed 3-line layout (title / phase + progress / PR + activity).

    DRAIN is spelled out (never colour-only); every line is fit to the card so it never grows.
    """
    m = st["method"].upper()
    if st["batch"] is None:
        return "\n".join([_fit(m), _fit(_idle_phase(st)), _fit("")])
    icon = ICON.get(st["state"], "?")
    title = _fit(f"{m} · {st['batch']}", CARD_W - 2)
    phase = PHASE.get(st["state"], st["state"]) + (" + DRAIN" if st["drain"] else "")
    if st["progress"]:
        phase += f"  {st['progress']}"
    last = []
    if st["pr"]:
        last.append(f"PR #{st['pr']}")
    if st["activity"]:
        last.append(f"{_when(st['activity'][0])} {st['activity'][1]}")
    return "\n".join([title + " " + icon.rjust(CARD_W - cell_len(title) - 1), _fit(phase), _fit(" · ".join(last))])


def detail_header(st: dict, reg: dict, model: str) -> str:
    """Short operating header; ids, SHAs and paths live in `detail_meta`."""
    who = f"{adapter_label(reg.get('adapter', '?'))} / {st['method'].upper()}"
    if st["batch"] is None:
        return f"{who}  ({_idle_phase(st).lstrip('— ')})"
    head = [f"{who} · {st['batch']}", PHASE.get(st["state"], st["state"]) + (" + DRAIN" if st["drain"] else "")]
    if st["pr"]:
        head.append(f"PR #{st['pr']}")
    if st["progress"]:
        head.append(st["progress"])
    lines = ["   ".join(head)]
    second = [control.MODES.get(st["mode"], "Single")]
    if st["state"] == "COMPLETE":
        second.append(f"완료 {_when(st['updated'])}")
    elif st["activity"]:
        second.append(f"최근 활동 {_when(st['activity'][0])} {st['activity'][1]}")
    if st["run"]:
        second.append("실행 예약 중")
    if st["global_drain"]:
        second.append("전역 Drain")
    lines.append("  ·  ".join(second))
    if st["error"]:
        lines.append(f"ERROR/PAUSED 사유: {st['error']}")
    if st["blocked"]:
        lines.append(f"BLOCKED: {st['blocked']}")
    return "\n".join(lines)


def detail_meta(st: dict, reg: dict, model: str) -> str:
    """Metadata / Details: what the header leaves out. A cleaned-up worktree is history, not a live path."""
    wt = st["worktree"]
    if not wt:
        wt_line = "worktree: -"
    elif st["state"] == "COMPLETE":
        wt_line = f"worktree (과거 사용 경로 · 정리 완료, 현재 존재하지 않음): {wt}"
    elif not os.path.exists(wt):
        wt_line = f"worktree (경로 없음): {wt}"
    else:
        wt_line = f"worktree: {wt}"
    return "\n".join([
        f"model: {reg.get('label', model)} ({model})   adapter: {reg.get('adapter', '?')}   tier: {st['tier']}",
        f"branch: {st['branch'] or '-'}", f"HEAD: {st['head'] or '-'}", f"session: {st['session'] or '-'}", wt_line])
