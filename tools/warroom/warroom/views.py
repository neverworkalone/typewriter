"""Pure view text for the War Room board and Batch Detail (stdlib only, so CI can test it without Textual)."""
from __future__ import annotations

import os
import time
import unicodedata

from . import control
from .config import TIERED_ADAPTERS, adapter_label


def _hhmm(ts) -> str:
    return time.strftime("%H:%M:%S", time.localtime(ts)) if ts else "-"


def _when(ts) -> str:
    """Time of day for today, date + time otherwise."""
    if not ts:
        return "-"
    t = time.localtime(ts)
    return time.strftime("%H:%M" if t[:3] == time.localtime()[:3] else "%m-%d %H:%M", t)


CARD_W = 34   # content cells of a card (column 38 - border - padding): every line is fit to it
PHASE = {"WAITING_REVIEW": "REVIEW", "PRODUCING": "WORKING"}   # display names; the stored state stays PRODUCING
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


SELECT_CHROME = 10    # border 2 + padding 4 + arrow/gap 4: a label of N cells needs N + 10 columns on one line
BUTTON_W = 14         # Start / Drain All / Stop All share one width
CONTROLS_MIN_W = 8


def select_width(labels, minimum: int = CONTROLS_MIN_W) -> int:
    """Width of a top-bar Select so its longest option label stays on one line."""
    return max([cell_len(str(x)) for x in labels] + [minimum]) + SELECT_CHROME


def control_columns(widths, total: int) -> int:
    """Grid columns for the wrapped top bar: every equal-width cell must hold the widest visible control."""
    widest = max([w for w in widths if w > 0] + [1])
    return max(1, min(len(widths) or 1, total // widest))


def _fit(text: str, width: int = CARD_W) -> str:
    text = " ".join(text.split())
    return text if cell_len(text) <= width else set_cell_size(text, width - 1).rstrip() + "…"


def _idle_phase(st: dict) -> str:
    """A Line without a batch: a pending Start or a Drain that will block it is still operator-relevant."""
    if st["drain"]:
        return "비어 있음 + DRAIN" + ("  시작 예약" if st.get("run") else "")
    return "—  시작 예약 중" if st.get("run") else "—  실행 이력 없음"


CARD_LINES = 4   # every card has exactly these content lines (empty ones stay blank) so all cards share one height


def fmt_elapsed(seconds) -> str:
    s = int(seconds)
    if s < 60:
        return f"{s}초"
    if s < 3600:
        return f"{s // 60}분 {s % 60:02d}초"
    return f"{s // 3600}시간 {s % 3600 // 60:02d}분"


def _two_sided(left: str, right: str, width: int = CARD_W) -> str:
    """`left` flush left, `right` flush right; `left` is the one that gets cut when they do not fit."""
    right = _fit(right, width)
    room = width - cell_len(right) - (1 if right else 0)
    left = _fit(left, max(room, 0)) if room > 0 else ""
    return left + " " * (width - cell_len(left) - cell_len(right)) + right


def model_title(label: str, width: int = CARD_W + 2) -> str:
    """Column heading: the model's display name as written (cut with an ellipsis only if it overflows)."""
    return _fit(label, width)


def progress_bar(done: int, total: int, width: int = CARD_W) -> str:
    n = round(width * min(done, total) / total) if total else 0
    return "█" * n + "░" * (width - n)


def card_text(st: dict) -> str:
    """Card = Line summary in a fixed 4-line layout (title / records / bar / PR + elapsed).

    Only observed values are shown: no records -> `진행량 확인 중` and no bar, never an estimate. DRAIN is
    spelled out (never colour-only); every line is fit to the card so it never grows. Activity stays in Detail.
    """
    m = st["method"].upper()
    if st["batch"] is None:
        return "\n".join([_fit(m), _fit(_idle_phase(st))] + [""] * (CARD_LINES - 2))
    icon = ICON.get(st["state"], "?")
    phase = PHASE.get(st["state"], st["state"]) + (" + DRAIN" if st["drain"] else "")
    title = _two_sided(f"{m} · {st['batch']}", f"{phase}  {icon}")
    done, total = st.get("records_done"), st.get("records_total")
    observed = done is not None and bool(total)
    if observed:
        records = _two_sided(f"{done} / {total} records", f"{done / total * 100:.1f}%")
        bar = progress_bar(done, total)
    else:
        records, bar = "진행량 확인 중", ""
    ops = _two_sided(f"PR #{st['pr']}" if st["pr"] else "PR 생성 전",
                     f"경과 {fmt_elapsed(st['elapsed'])}" if st.get("elapsed") is not None else "")
    return "\n".join([title, records, bar, ops])


TIER_FOOTER = {
    "free": ("Free", "b green"),
    "go": ("Go", "b #ffa500"),
    "mixed": ("혼합", "b yellow"),
    "none": ("DeepSeek Go 모델 미설정", "dim"),
}


def tier_footer(state: str) -> str:
    """One-line board footer with the current tier nested under f; values are Rich markup."""
    label, style = TIER_FOOTER.get(state, TIER_FOOTER["none"])
    return (f"[b]q[/] Quit · [b]s[/] Settings · [b]r[/] 설정 리로드 · "
            f"[b]f[/] Free/Go 전환 ([{style}]{label}[/])")


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
    if st["drain_once"]:
        second.append("Drain All: 현재 배치 후 종료")
    lines.append("  ·  ".join(second))
    if st["error"]:
        lines.append(f"ERROR/PAUSED 사유: {st['error']}")
    if st["blocked"]:
        lines.append(f"BLOCKED: {st['blocked']}")
    return "\n".join(lines)


def _pins(reg: dict, st: dict) -> str:
    """The Free/Go tier for OpenCode; the fixed model ID and effort for the single-model CLIs (no tiers there)."""
    if reg.get("adapter") in TIERED_ADAPTERS:
        return f"tier: {st['tier']}   effort: {reg.get('effort') or '-'}"
    return f"model id: {reg.get('model') or '-'}   effort: {reg.get('effort') or '-'}"


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
        f"model: {reg.get('label', model)} ({model})   adapter: {reg.get('adapter', '?')}   {_pins(reg, st)}",
        f"branch: {st['branch'] or '-'}", f"HEAD: {st['head'] or '-'}", f"session: {st['session'] or '-'}", wt_line])
