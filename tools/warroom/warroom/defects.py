"""Structured shared-defect reports (Issue #1555): schema, identity, review escalation marker and Issue text.

A shared defect is a repeatable fault of the common producer/validator/build/process layer, not one bad candidate.
It is recognised only from an explicit JSON report, never from free-text keywords:

* a producer AI writes `.warroom-scratch/shared-defect.json` in its own worktree, or
* a trusted PR reviewer posts a fenced block ```` ```warroom-shared-defect ```` holding the same JSON.

Everything here is pure (no I/O) so the rules are testable without a Supervisor.
"""
from __future__ import annotations

import hashlib
import json
import re

REPORT_FILE = ".warroom-scratch/shared-defect.json"   # inside the batch worktree; git-ignored scratch
FENCE = "warroom-shared-defect"
VERSION = 1
MIN_FAILING_CASES = 2   # one failing candidate is a dispute about that candidate, not a repeatable defect class
MAX_FAILING_CASES = 20
MAX_TEXT = 4000
TEXT_FIELDS = ("summary", "reproduction", "root_cause", "scope", "proposed_fix", "regression")
_CLASS = re.compile(r"^[a-z0-9][a-z0-9-]{2,63}$")
_KEYS = {"version", "defect_class", "failing_cases", *TEXT_FIELDS}


class ReportProblem(ValueError):
    """The report is not usable evidence; the batch is held for the operator, no Issue is created."""


def parse(text: str) -> dict:
    """Validate one report (JSON text) and return its canonical form. Raises ReportProblem."""
    try:
        data = json.loads(text)
    except ValueError as e:
        raise ReportProblem(f"JSON을 해석할 수 없습니다: {e}") from e
    if not isinstance(data, dict):
        raise ReportProblem("보고의 최상위 값은 JSON 객체여야 합니다.")
    unknown = sorted(set(data) - _KEYS)
    if unknown:
        raise ReportProblem(f"알 수 없는 필드: {', '.join(unknown)}")
    if data.get("version") != VERSION:
        raise ReportProblem(f"version은 {VERSION}이어야 합니다.")
    cls = data.get("defect_class")
    if not isinstance(cls, str) or not _CLASS.match(cls):
        raise ReportProblem("defect_class는 소문자·숫자·하이픈으로 된 3~64자 slug여야 합니다.")
    out: dict = {"version": VERSION, "defect_class": cls}
    for key in TEXT_FIELDS:
        v = data.get(key)
        if not isinstance(v, str) or not v.strip():
            raise ReportProblem(f"{key}가 비어 있습니다 (실제 근거가 필요합니다).")
        if len(v) > MAX_TEXT:
            raise ReportProblem(f"{key}가 너무 깁니다 (최대 {MAX_TEXT}자).")
        out[key] = v.strip()
    cases = data.get("failing_cases")
    if not isinstance(cases, list) or not all(isinstance(c, str) and c.strip() for c in cases):
        raise ReportProblem("failing_cases는 비어 있지 않은 문자열 목록이어야 합니다.")
    cases = [c.strip() for c in cases]
    if len(set(cases)) < MIN_FAILING_CASES:
        raise ReportProblem(f"서로 다른 실제 실패 사례가 {MIN_FAILING_CASES}건 이상 필요합니다 "
                            "(후보 1건의 오류·논쟁은 공통 결함이 아닙니다).")
    if len(cases) > MAX_FAILING_CASES or any(len(c) > MAX_TEXT for c in cases):
        raise ReportProblem(f"failing_cases는 최대 {MAX_FAILING_CASES}건, 각 {MAX_TEXT}자 이하여야 합니다.")
    out["failing_cases"] = cases
    return out


def canonical(report: dict) -> str:
    return json.dumps(report, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def report_event_key(batch_id: int, raw: str) -> str:
    """Identity of one producer report: the batch plus its exact content, so a re-read never makes a second Issue."""
    return f"report:{batch_id}:{digest(raw)}"


def review_event_key(batch_id: int, pr: int, event_key: str) -> str:
    return f"review:{batch_id}:{pr}:{event_key}"


def review_block(body: str) -> str | None:
    """The JSON inside the first ```warroom-shared-defect fence of a review/comment body (None: no escalation)."""
    inside, lines = False, []
    for line in (body or "").splitlines():
        s = line.strip()
        if not inside:
            if s == "```" + FENCE:
                inside = True
        elif s == "```":
            return "\n".join(lines)
        else:
            lines.append(line)
    return None


# ---- GitHub Issue text -------------------------------------------------------------------------------------------
EVENT_MARK = "warroom-defect-event"
CLASS_MARK = "warroom-defect-class"
_MARK_LINE = re.compile(r"^<!-- (warroom-defect-(?:event|class)):([a-z0-9:_-]{1,128}) -->$", re.M)


def _safe(text: str) -> str:
    """Report text is data: it can neither close a comment nor forge an identity marker inside the Issue body."""
    return text.replace("<!--", "&lt;!--").replace("-->", "--&gt;").replace("```", "'''")


def marker(kind: str, value: str) -> str:
    return f"<!-- {kind}:{value} -->"


def markers(body: str) -> set[tuple[str, str]]:
    """(kind, value) of every identity marker line in an Issue/comment body (full-line matches only)."""
    return {(m.group(1), m.group(2)) for m in _MARK_LINE.finditer(body or "")}


def issue_title(report: dict) -> str:
    return f"[urgent][War Room] 공통 결함: {report['defect_class']}"


def batch_facts(b, pr: dict | None) -> str:
    """Origin of the report: which batch/method/producer, and the PR/HEAD it concerned."""
    lines = [f"- 배치: `{b['shard']}_{b['batch']}` · Method {b['method'].upper()} · 생산자 `{b['producer']}`",
             f"- 브랜치: `{b['branch']}`"]
    if pr:
        lines.append(f"- 관련 PR: #{pr['number']} · HEAD `{pr['head_sha']}`")
    else:
        lines.append("- 관련 PR: 아직 없음")
    return "\n".join(lines)


def issue_body(report: dict, event_key: str, facts: str, source: str) -> str:
    cases = "\n".join(f"- {_safe(c)}" for c in report["failing_cases"])
    return "\n".join([
        "## 공통 결함 (War Room 자동 등록)",
        "",
        f"원 배치가 **Shared defect**를 구조화된 보고({'생산자' if source == 'report' else '리뷰'})로 제출했습니다. "
        "해당 배치만 PAUSED 되었고 작업물·브랜치·세션은 보존됩니다. 이 Issue가 머지되고 Maintainer cleanup이 "
        "끝나면 배치에 수정이 반영된 뒤 한 번만 자동 재개됩니다.",
        "",
        facts,
        "",
        f"### 결함 분류\n`{report['defect_class']}`",
        f"### 요약\n{_safe(report['summary'])}",
        f"### 실제 실패 사례\n{cases}",
        f"### 재현\n{_safe(report['reproduction'])}",
        f"### 원인 / 공통 계층\n{_safe(report['root_cause'])}",
        f"### 적용 범위 (기존 및 향후 배치)\n{_safe(report['scope'])}",
        f"### 제안 수정\n{_safe(report['proposed_fix'])}",
        f"### 회귀 검증\n{_safe(report['regression'])}",
        "",
        marker(EVENT_MARK, event_key),
        marker(CLASS_MARK, report["defect_class"]),
    ])


def link_comment(report: dict, event_key: str, facts: str) -> str:
    """Added to an already open Issue of the same defect class when another batch reports it."""
    cases = "\n".join(f"- {_safe(c)}" for c in report["failing_cases"])
    return "\n".join(["같은 결함 분류를 다른 배치가 보고했습니다 (해당 배치도 이 Issue에 종속되어 PAUSED).", "",
                      facts, "", f"### 실제 실패 사례\n{cases}", f"### 재현\n{_safe(report['reproduction'])}", "",
                      marker(EVENT_MARK, event_key)])
