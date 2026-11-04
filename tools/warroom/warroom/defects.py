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

from .logtail import redact as _redact_tokens

REPORT_FILE = ".warroom-scratch/shared-defect.json"   # inside the batch worktree; git-ignored scratch
FENCE = "warroom-shared-defect"
VERSION = 1
# The producer reports cheaply: one really failing case, how to reproduce it and the shared layer it suspects.
# Root cause, scope, fix and regression design are the Maintainer's work, so they are optional hints. What keeps a single
# disputed candidate out is not a case count but the pair "reproducible command + suspected shared layer".
REQUIRED_TEXT = ("summary", "reproduction", "suspected_layer")
OPTIONAL_TEXT = ("root_cause", "scope", "proposed_fix", "regression")
TEXT_FIELDS = REQUIRED_TEXT + OPTIONAL_TEXT
MIN_FAILING_CASES = 1
MAX_FAILING_CASES = 20
MAX_TEXT = 4000
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
        if key not in data and key in OPTIONAL_TEXT:
            continue
        v = data.get(key)
        if not isinstance(v, str) or not v.strip():
            raise ReportProblem(f"{key}가 비어 있습니다 (필수: {', '.join(REQUIRED_TEXT)}; 선택 항목은 생략하거나 내용을 채우세요).")
        if len(v) > MAX_TEXT:
            raise ReportProblem(f"{key}가 너무 깁니다 (최대 {MAX_TEXT}자).")
        out[key] = v.strip()
    cases = data.get("failing_cases")
    if not isinstance(cases, list) or not all(isinstance(c, str) and c.strip() for c in cases):
        raise ReportProblem("failing_cases는 비어 있지 않은 문자열 목록이어야 합니다.")
    cases = [c.strip() for c in cases]
    if len(set(cases)) < MIN_FAILING_CASES:
        raise ReportProblem(f"실제로 재현되는 실패 사례가 {MIN_FAILING_CASES}건 이상 필요합니다.")
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


_URL_USERINFO = re.compile(r"(?i)(\b[a-z][a-z0-9+.-]*://)[^/\s@]+@")
_BASIC = re.compile(r"(?i)\b(basic)(\s+)[A-Za-z0-9+/=]{8,}")
_ASSIGNED = re.compile(r"(?i)\b(password|passwd|secret|credential)s?(\"?\s*[:=]\s*\"?)[^\s\"',;&]+")


def public(text) -> str:
    """Text that may leave this machine (GitHub Issue / comment): credentials removed. The raw text stays in the local
    DB and evidence bundle; only this safe form is ever published."""
    text = _redact_tokens(str(text))
    text = _URL_USERINFO.sub(lambda m: m.group(1) + "[REDACTED]@", text)
    text = _BASIC.sub(lambda m: m.group(1) + m.group(2) + "[REDACTED]", text)
    return _ASSIGNED.sub(lambda m: m.group(1) + m.group(2) + "[REDACTED]", text)


def marker(kind: str, value: str) -> str:
    return f"<!-- {kind}:{value} -->"


def markers(body: str) -> set[tuple[str, str]]:
    """(kind, value) of every identity marker line in an Issue/comment body (full-line matches only)."""
    return {(m.group(1), m.group(2)) for m in _MARK_LINE.finditer(body or "")}


def issue_title(report: dict, source: str = "report") -> str:
    if source == "incident":
        return f"[urgent][War Room] 장애 접수: {report['defect_class']}"
    return f"[urgent][War Room] 공통 결함: {report['defect_class']}"


# ---- Autonomous incident intake (Issue #3326): an approved Maintainer integration HEAD the boundary check rejected ------
class BoundaryProblem(str):
    """A boundary rejection that was proven, at the moment of rejection, to be the batch's own RELEASED integration HEAD.

    Only the HEAD-mismatch branch of a boundary check returns this, and only after `Maintenance.approved_integration_receipt`
    proved it (same-batch RELEASED receipt, ancestry, unchanged remote, clean worktree). Every other rejection stays a plain
    `str`. `+` keeps the type (callers append a suffix); f-strings, slicing and `format` drop it on purpose.
    """
    receipt: dict

    def __new__(cls, text: str, receipt: dict):
        obj = super().__new__(cls, text)
        obj.receipt = receipt
        return obj

    def __add__(self, other):
        return BoundaryProblem(str.__add__(self, other), self.receipt) if isinstance(other, str) else NotImplemented

    def __radd__(self, other):
        return BoundaryProblem(str.__add__(other, self), self.receipt) if isinstance(other, str) else NotImplemented


def incident_report(site: str, bid: int, sha8: str, cases: list[str], reproduction: str) -> str:
    """The report JSON for one incident. The class is unique per incident: nothing merges it with another before a cause is known."""
    return json.dumps({
        "version": VERSION, "defect_class": f"incident-{site}-{bid}-{sha8}",
        "summary": f"승인된 Maintainer 통합 HEAD가 경계 검사에서 거부되어 배치가 ERROR가 되었습니다 ({site}). 원인 분석을 요청합니다.",
        "failing_cases": cases, "reproduction": reproduction, "suspected_layer": site,
    }, ensure_ascii=False, sort_keys=True)


# ---- Autonomous incident envelope (Issue #3349): every C/D/Stage 2/Stage 3 production ERROR -----------------------------
INCIDENT_VERSION = 2
INCIDENT_ERROR_MAX = 600
_ENVELOPE_IDENTITY = ("batch_id", "method", "producer", "shard", "batch", "branch", "worktree", "state", "paused_from",
                      "run_kind", "error_seq", "error_at", "error", "error_first")
OBSERVATIONS = ("runs", "log_file", "events", "checkpoint", "git", "receipts", "error_evidence")
STATUSES = ("ok", "missing", "unknown")


def incident_event_key(bid: int, seq: int) -> str:
    return f"incident:{bid}:e{seq}"


def incident_class(method: str, bid: int, seq: int) -> str:
    return f"incident-{method}-{bid}-e{seq}"   # unique per ERROR event: nothing merges two causes before one is known


def observation(status: str, value=None) -> dict:
    """One observed fact. `missing` = confirmed absent; `unknown` = the lookup failed or cannot be answered."""
    if status not in STATUSES:
        raise ReportProblem(f"관측 상태가 올바르지 않습니다: {status!r}")
    return {"status": status, "value": value}


def evidence_fingerprint(evidence: dict) -> str | None:
    """Cause identity of a structured evidence record. Today: a BoundaryProblem receipt's (site, base, head)."""
    if not isinstance(evidence, dict) or evidence.get("kind") != "boundary":
        return None
    parts = [evidence.get(k) for k in ("site", "base", "head")]
    return digest("|".join(parts)) if all(isinstance(x, str) and x for x in parts) else None


def incident_envelope(b, observed: dict, prior: list) -> dict:
    """Identity of one ERROR event taken from the batch row, plus observations that may each be ok/missing/unknown.
    No cause and no reproduction command is invented here."""
    env = {"version": INCIDENT_VERSION, "kind": "incident",
           "defect_class": incident_class(b["method"], b["id"], b["error_seq"]),
           "batch_id": b["id"], "method": b["method"], "producer": b["producer"], "shard": b["shard"], "batch": b["batch"],
           "branch": b["branch"], "worktree": b["worktree"], "state": b["state"], "paused_from": b["paused_from"],
           "run_kind": b["run_kind"] or "", "error_seq": b["error_seq"], "error_at": b["error_at"],
           "error": (b["error"] or "")[:INCIDENT_ERROR_MAX], "error_first": (b["error_first"] or "")[:INCIDENT_ERROR_MAX],
           "observed": observed, "prior_incidents": prior}
    return env


def is_incident_envelope(text: str) -> bool:
    try:
        d = json.loads(text)
    except ValueError:
        return False
    return isinstance(d, dict) and d.get("kind") == "incident" and d.get("version") == INCIDENT_VERSION


def parse_incident(text: str) -> dict:
    """Validate a stored envelope. Any missing/contradictory identity field raises ReportProblem (no intake, ERROR kept)."""
    try:
        d = json.loads(text)
    except ValueError as e:
        raise ReportProblem(f"incident envelope JSON을 해석할 수 없습니다: {e}") from e
    if not isinstance(d, dict) or d.get("kind") != "incident" or d.get("version") != INCIDENT_VERSION:
        raise ReportProblem("incident envelope의 kind/version이 올바르지 않습니다.")
    for k in _ENVELOPE_IDENTITY:
        if k not in d or (k not in ("run_kind", "error_first") and d[k] in (None, "")):
            raise ReportProblem(f"incident envelope 필수 항목이 없습니다: {k}")
    if d["state"] != "ERROR" or type(d["batch_id"]) is not int or type(d["error_seq"]) is not int or d["error_seq"] < 1:
        raise ReportProblem("incident envelope의 상태/사건 번호가 올바르지 않습니다.")
    if d["method"] not in ("c", "d", "s2", "s3") or d["defect_class"] != incident_class(d["method"], d["batch_id"], d["error_seq"]):
        raise ReportProblem("incident envelope의 method/분류가 사건 번호와 모순됩니다.")
    obs = d.get("observed")
    if not isinstance(obs, dict) or set(obs) != set(OBSERVATIONS) or not all(
            isinstance(v, dict) and v.get("status") in STATUSES and set(v) == {"status", "value"} for v in obs.values()):
        raise ReportProblem("incident envelope 관측 항목이 올바르지 않습니다.")
    if not isinstance(d.get("prior_incidents"), list):
        raise ReportProblem("incident envelope의 prior_incidents가 올바르지 않습니다.")
    return d


def incident_issue_title(env: dict) -> str:
    return f"[urgent][War Room] 장애 접수: {env['method'].upper()} {env['shard']}_{env['batch']} {env['run_kind'] or env['paused_from']}"


def _short(value, limit: int = 160) -> str:
    text = json.dumps(value, ensure_ascii=False, sort_keys=True) if not isinstance(value, str) else value
    return _safe(public(text if len(text) <= limit else text[:limit - 1] + "…"))


def incident_issue_body(env: dict, event_key: str) -> str:
    """An investigation request. The raw error (bounded), observation statuses and prior incidents; never logs or secrets."""
    rows = []
    for name in OBSERVATIONS:
        o = env["observed"][name]
        rows.append(f"- `{name}`: {o['status']}" + (f" — {_short(o['value'])}" if o["status"] == "ok" and name != "events" else ""))
    prior = [f"- defect #{p.get('defect_id')} · merge `{p.get('merge_sha')}` · 지문 `{p.get('fingerprint')}`" for p in env["prior_incidents"]]
    return "\n".join([
        "## 장애 접수·원인 분석 요청 (War Room 자동 접수)", "",
        "C/D/Stage 2/Stage 3 생산 배치가 ERROR로 정지해 증거를 보존한 채 PAUSED로 접수했습니다. 원인은 아직 확정되지 않았습니다. "
        "증거 묶음은 Maintainer worktree의 `.warroom-scratch/incident/`에 있습니다 (로그 원문은 이 Issue에 넣지 않았습니다). "
        "코드·프롬프트 결함이면 PR로 고치고, 아니면 PR 없이 진단만 남기고 종료하세요.", "",
        f"- 배치: `{env['shard']}_{env['batch']}` · Method {env['method'].upper()} · 생산자 `{env['producer']}`",
        f"- 브랜치: `{env['branch']}`",
        f"- 단계: `{env['run_kind'] or '(run 없음)'}` · ERROR 이전 상태 `{env['paused_from']}` · 사건 번호 e{env['error_seq']}",
        f"- 최초 오류: {_short(env['error_first'] or env['error'], 600)}",
        f"- 최신 오류: {_short(env['error'], 600)}", "",
        "### 관측 항목", *rows, "",
        *(["### 이전 incident", *prior, ""] if prior else []),
        marker(EVENT_MARK, event_key), marker(CLASS_MARK, env["defect_class"]),
    ])


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
    pending = "(보고자가 제시하지 않음 — Maintainer가 조사)"
    opt = lambda key: _safe(report[key]) if key in report else pending
    return "\n".join([
        *(["## 공통 결함 (War Room 자동 등록)", ""] if source != "incident" else []),
        *(["## 장애 접수·원인 분석 요청 (War Room 자동 접수)", "",
           "승인된 Maintainer 통합 HEAD를 배치의 Git 경계 검사가 거부해 배치가 ERROR가 되었고, 증거를 보존한 채 PAUSED로 접수했습니다. "
           "원인은 아직 확정되지 않았습니다. 증거 묶음은 Maintainer worktree의 `.warroom-scratch/incident/`에 있습니다 (로그 원문은 이 Issue에 넣지 않았습니다). "
           "코드 결함이면 PR로 고치고, 아니면 PR 없이 진단만 남기고 종료하세요.", ""] if source == "incident" else []),
        ("" if source == "incident" else
         f"원 배치가 **Shared defect**를 구조화된 보고({'생산자' if source == 'report' else '리뷰'})로 제출했습니다. ")
        + "해당 배치만 PAUSED 되었고 작업물·브랜치·세션은 보존됩니다. 이 Issue가 머지되고 Maintainer cleanup이 "
        "끝나면 배치에 수정이 반영된 뒤 한 번만 자동 재개됩니다.",
        "",
        facts,
        "",
        f"### 결함 분류\n`{report['defect_class']}`",
        f"### 요약\n{_safe(report['summary'])}",
        f"### 실제 실패 사례\n{cases}",
        f"### 재현\n{_safe(report['reproduction'])}",
        f"### 의심되는 공유 계층\n{_safe(report['suspected_layer'])}",
        f"### 원인 (보고자 추정)\n{opt('root_cause')}",
        f"### 적용 범위 (기존 및 향후 배치)\n{opt('scope')}",
        f"### 제안 수정\n{opt('proposed_fix')}",
        f"### 회귀 검증\n{opt('regression')}",
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


# ---- Stage 2 verify blocks (Issue #2154): system-generated, not producer/reviewer reports ---------------------------
VERIFY_EVIDENCE_ERRORS = 20      # errors kept in a report / Issue (the fingerprint always covers the complete list)
VERIFY_ERROR_CHARS = 300
VERIFY_EXTRA_MAX = 5             # other fingerprints seen before the fix is merged (evidence only, never a new Issue)
_VERIFY_KEYS = {"version", "kind", "shard", "batch", "sha", "command", "family", "fingerprint", "total", "errors", "extra"}
_SHARD = re.compile(r"^\d{3}$")
_BATCH = re.compile(r"^\d{2}$")
_SHA = re.compile(r"^[0-9a-f]{40}$")
_FP = re.compile(r"^[0-9a-f]{16}$")


def verify_evidence(errors) -> list[str]:
    return [e if len(e) <= VERIFY_ERROR_CHARS else e[:VERIFY_ERROR_CHARS - 1] + "…" for e in list(errors)[:VERIFY_EVIDENCE_ERRORS]]


def verify_report(failure, extra: list | None = None) -> str:
    """Canonical JSON of one verify failure (a `stage2.VerifyFailure`)."""
    return canonical({"version": VERSION, "kind": failure.kind, "shard": failure.shard, "batch": failure.batch,
                      "sha": failure.sha, "command": failure.command, "family": failure.family,
                      "fingerprint": failure.fingerprint, "total": failure.total,
                      "errors": verify_evidence(failure.errors), "extra": extra or []})


def parse_verify(text: str) -> dict:
    """Validate a stored verify report and return it. Raises ReportProblem (the block is HELD, no Issue)."""
    try:
        d = json.loads(text)
    except ValueError as e:
        raise ReportProblem(f"verify 보고 JSON을 해석할 수 없습니다: {e}") from e
    if not isinstance(d, dict) or set(d) != _VERIFY_KEYS or d["version"] != VERSION:
        raise ReportProblem("verify 보고의 필드/version이 올바르지 않습니다.")
    ok = (d["kind"] in ("batch", "shard") and isinstance(d["shard"], str) and _SHARD.match(d["shard"])
          and (d["batch"] is None if d["kind"] == "shard" else isinstance(d["batch"], str) and bool(_BATCH.match(d["batch"])))
          and isinstance(d["sha"], str) and _SHA.match(d["sha"]) and isinstance(d["command"], str) and d["command"]
          and d["family"] in ("rows", "accounting") and isinstance(d["fingerprint"], str) and _FP.match(d["fingerprint"])
          and type(d["total"]) is int and d["total"] >= 1
          and isinstance(d["errors"], list) and 1 <= len(d["errors"]) <= min(d["total"], VERIFY_EVIDENCE_ERRORS)
          and all(isinstance(e, str) and e.strip() for e in d["errors"]) and isinstance(d["extra"], list)
          and len(d["extra"]) <= VERIFY_EXTRA_MAX
          and all(isinstance(x, dict) and set(x) == {"fingerprint", "sha", "total", "errors", "posted"} for x in d["extra"]))
    if not ok:
        raise ReportProblem("verify 보고의 값이 스키마에 맞지 않습니다.")
    return d


def verify_scope(d: dict) -> str:
    return f"{d['shard']}_{d['batch']}" if d["kind"] == "batch" else d["shard"]


def verify_event_key(d: dict) -> str:
    return f"verify:{d['kind']}:{d['shard']}{':' + d['batch'] if d['batch'] else ''}:{d['fingerprint']}"


def verify_issue_title(d: dict) -> str:
    what = f"Batch {verify_scope(d)}" if d["kind"] == "batch" else f"Shard {d['shard']}"
    return f"[urgent][War Room][Stage 2] {what} verify 실패: {d['family']} {d['total']}건"


def _verify_errors(d: dict) -> str:
    more = f"\n- … 외 {d['total'] - len(d['errors'])}건 (전체는 재현 명령으로 확인)" if d["total"] > len(d["errors"]) else ""
    return "\n".join(f"- {_safe(e)}" for e in d["errors"]) + more


def verify_issue_body(d: dict, event_key: str, cls: str) -> str:
    return "\n".join([
        "## Stage 2 verify 실패 (War Room 자동 등록)", "",
        f"완료된 Stage 2 **{'Batch' if d['kind'] == 'batch' else 'Shard'} `{verify_scope(d)}`**의 exact verify가 같은 master SHA에서 두 번 "
        "동일하게 실패했습니다. 이 범위는 차단되었고 (Stage 2 Line은 대기, 다른 Line은 영향 없음) 최신 master에서 같은 verify가 "
        "성공해야만 해제됩니다. 데이터 충돌인지 공통 코드/검증기 결함인지는 Maintainer가 증거로 판단합니다.", "",
        f"- master SHA: `{d['sha']}`", f"- 재현: `{d['command']}`", f"- family: `{d['family']}` · 오류 {d['total']}건 · 지문 `{d['fingerprint']}`", "",
        f"### 오류 (앞 {len(d['errors'])}건)", _verify_errors(d), "",
        marker(EVENT_MARK, event_key), marker(CLASS_MARK, cls)])


def verify_link_comment(d: dict, event_key: str) -> str:
    return "\n".join(["War Room이 이 Issue를 같은 범위의 Stage 2 verify 실패로 연결했습니다.", "",
                      f"- 범위: `{verify_scope(d)}` · master SHA `{d['sha']}`", f"- 재현: `{d['command']}`",
                      f"- family `{d['family']}` · 오류 {d['total']}건 · 지문 `{d['fingerprint']}`", "",
                      f"### 오류 (앞 {len(d['errors'])}건)", _verify_errors(d), "", marker(EVENT_MARK, event_key)])


def verify_evidence_comment(x: dict, d: dict, event_key: str) -> str:
    """Another fingerprint seen on the same scope before the fix merged: evidence only, never a new Issue."""
    return "\n".join(["수정 전 같은 범위에서 다른 verify 오류 지문이 확인되었습니다 (증거 추가).", "",
                      f"- 범위: `{verify_scope(d)}` · master SHA `{x['sha']}` · 지문 `{x['fingerprint']}` · 오류 {x['total']}건", "",
                      _verify_errors(x), "", marker(EVENT_MARK, event_key)])
