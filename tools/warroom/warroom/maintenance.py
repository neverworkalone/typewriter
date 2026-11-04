"""Shared-defect handling and the hidden Maintainer (Issue #1555).

A producing batch (or its PR review) reports a *shared defect* in a structured report:

  report -> batch PAUSED (work kept) -> one urgent Issue -> one serial Maintainer implements it in its own worktree
  -> the existing review/merge/cleanup flow -> the exact PR is merged AND the Maintainer's worktree is cleaned up
  -> the merged fix is merged into the paused batch worktree and verified -> that batch is retried exactly once.

The Maintainer is not a new state machine: its execution is an ordinary `batches` row under the reserved method `m`
(hidden from the Production Board), so launching, session/pin handling, PR watching, review fixes and cleanup are the
Supervisor's existing code. This module owns only what is new: the issue-scoped task record (`maintenance`), the defect
rows (`defects`), Issue publication, and applying a merged fix to a paused batch.
"""
from __future__ import annotations

import json
import hashlib
import os
import re
from pathlib import Path

from . import auth, dchunk, defects, literary, stage2, stage3
from .config import maintainer_id, maintainer_problem
from .gitops import FastForwardBlocked, GitError, GitTransient, IntegrationBlocked
from .store import MAINTENANCE_METHOD, STAGE2_METHOD, STAGE3_METHOD

_NODE_TEST = re.compile(r"(?:.+/)?[^/]+\.test\.mjs")   # `node --test <file>` regression files wherever they live (AGENTS.md)
_PY_TEST = re.compile(r"tools/warroom/tests/test_[^/]+\.py")
_TESTISH = re.compile(r"(?:^|/)(?:tests?|__tests__)/|\.(?:test|spec)\.|(?:^|/)test_[^/]+\.py$")
_SUPPORT_FILE = re.compile(r"(?:^|/)(?:fixtures?|helpers?)/|(?:^|/)(?:fakes|fake_runner|__init__)\.py$")   # test support, not a test
_DOC = re.compile(r"\.md$|^docs/|^tools/warroom/prompts/")
VERIFY_TIMEOUT = 900
OPEN_DEFECT = ("REPORTED", "LINKED", "FIX_MERGED", "HELD")


class Maintenance:
    def __init__(self, sup):
        self.sup = sup

    # shortcuts: the Supervisor replaces `cfg` on a reload, so nothing here caches it
    @property
    def store(self):
        return self.sup.store

    @property
    def cfg(self):
        return self.sup.cfg

    def _due(self, key: str, every: float | None = None) -> bool:
        """Rate limit for GitHub/auth calls that failed or wait on something external."""
        now = self.sup.clock()
        gap = self.cfg["poll_seconds"] if every is None else every
        if now - float(self.store.get(key, "0")) < gap:
            return False
        self.store.set(key, str(now))
        return True

    def step(self) -> None:
        for fn in (self._intake_errors, self._publish, self._publish_issue_requests, self._start, self._track, self._release,
                   self._report_outcomes, self._resume_diagnoses):
            try:
                fn()
            except Exception as e:   # GitHub/git trouble never stops the production Lines; the state is re-read next tick
                self.store.log(None, f"Maintainer {fn.__name__} 예외(재시도 예정): {e}", "warn")

    # ---- reporting (called by the Supervisor when it finds a report) ---------------------------------------------
    def report_issue(self, title: str, body: str, urgent: bool = False, event_key: str = "") -> int:
        """Persist a caller-authored Issue request. Only urgent requests join the existing Maintainer queue."""
        request = self.store.request_issue(event_key, title, body, urgent)
        return request["id"]

    def report(self, b, source: str, event_key: str, raw: str, pr_info: dict | None = None,
               error: str | None = None, expect: dict | None = None) -> None:
        """Pause `b` for one defect event. A malformed or insufficient report holds the batch for the operator and
        creates no Issue; a valid one is queued for publication. Repeating the same event changes nothing.

        `source == "incident"` (#3349) carries an envelope of observed facts instead of a reproduced defect; an invalid
        envelope never pauses the batch (its ERROR stays) and `expect` is re-verified inside the pausing transaction."""
        if source == "incident":
            try:
                env = defects.parse_incident(raw)
            except defects.ReportProblem as e:
                return self.store.log(b["id"], f"장애 접수 거부(incident envelope): {e} — ERROR 유지", "warn")
            did = self.store.report_defect(
                b["id"], event_key, source, env["defect_class"], "REPORTED",
                defects.canonical(env) + "\n" + defects.batch_facts(b, None), "shared_defect", error, expect=expect)
            if did is not None:
                self.store.log(b["id"], f"ERROR 사건 e{env['error_seq']}를 장애 `{env['defect_class']}`로 접수 → 배치 PAUSED, 작업물·세션 보존", "warn")
            elif self._due(f"incident_deferred_{b['id']}_{env['error_seq']}", 600):
                self.store.log(b["id"], f"장애 접수 보류(e{env['error_seq']}): 접수 직전 재검증이 달라졌거나 운영자 제어가 우선합니다. ERROR 유지", "warn")
            return
        try:
            report = defects.parse(raw)
        except defects.ReportProblem as e:
            did = self.store.report_defect(b["id"], event_key, source, "", "UNVERIFIED", raw[:20000], "defect_unverified",
                                           f"공통 결함 보고 근거 부족 — 배치를 보존하고 운영자 확인을 기다립니다: {e}")
            if did is not None:
                self.store.log(b["id"], f"공통 결함 보고 거부({source}): {e} → PAUSED, Issue 미생성 (Retry로 재개)", "warn")
            return
        facts = defects.batch_facts(b, pr_info)
        did = self.store.report_defect(
            b["id"], event_key, source, report["defect_class"], "REPORTED",
            defects.canonical(report) + "\n" + facts, "shared_defect",
            error or f"공통 결함 `{report['defect_class']}` 보고 — 배치 PAUSED, urgent Issue 등록·수정 반영 대기")
        if did is not None:
            self.store.log(b["id"], f"공통 결함 `{report['defect_class']}` 보고({source}) → 배치 PAUSED, 작업물·세션 보존", "warn")

    @staticmethod
    def _issue_request_marker(event_key: str) -> str:
        digest = hashlib.sha256(event_key.encode("utf-8")).hexdigest()
        return f"<!-- warroom-issue-request:{digest} -->"

    @staticmethod
    def _issue_request_title(request) -> str:
        """Temporary, event-specific title used only until the created Issue number is durably recorded."""
        digest = hashlib.sha256(request["event_key"].encode("utf-8")).hexdigest()
        title = f"Typewriter request {digest}"
        return f"{title} (pending)" if title == request["title"] else title

    def _issue_retry_due(self, key: str) -> bool:
        return self.sup._transient_due(f"issue:{key}")

    def _issue_retry_failed(self, key: str, error) -> None:
        self.sup._transient_wait(f"issue:{key}", error)

    def _issue_retry_succeeded(self, key: str) -> None:
        self.sup._transient_clear(f"issue:{key}")

    def _find_issue_request(self, request) -> int | None:
        """Find this event's comment marker or temporary title, never an unrelated matching Issue."""
        expected_marker = self._issue_request_marker(request["event_key"])
        prefix = "<!-- warroom-issue-request:"
        temporary_title = self._issue_request_title(request)
        issues = self.sup.gh.all_issues()
        exact = [i for i in issues if not i.get("pull_request")
                 and i.get("title", "") in (request["title"], temporary_title)
                 and i.get("body", "") == request["body"]]
        same_event = []
        created_with_request_title = []
        for issue in exact:
            comments = self.sup.gh.issue_comments(issue["number"])
            bodies = [c.get("body") or "" for c in comments]
            if any(expected_marker in body for body in bodies):
                same_event.append(issue["number"])
                continue
            if any(prefix in body for body in bodies):
                continue
            if request["state"] == "CREATING" and issue.get("title") == temporary_title:
                created_with_request_title.append(issue["number"])
        if len(same_event) > 1 or len(created_with_request_title) > 1:
            raise RuntimeError("Issue 생성 응답 유실 후 요청 식별 후보가 여러 개라 복구 대상이 모호합니다")
        return same_event[0] if same_event else (created_with_request_title[0] if created_with_request_title else None)

    def _publish_issue_requests(self) -> None:
        """Publish durable ordinary/urgent requests independently from the shared-defect state machine."""
        for request in self.store.issue_requests(("PENDING", "CREATING", "CREATED")):
            retry_key = f"request:{request['id']}"
            if not self._issue_retry_due(retry_key):
                continue
            try:
                if request["state"] == "CREATED":
                    number = request["issue_number"]
                    if number is None:
                        raise RuntimeError("CREATED 요청에 GitHub Issue 번호가 없습니다")
                else:
                    def lookup():
                        return self._find_issue_request(request), False

                    def persist_attempt():
                        if not self.store.mark_issue_request_creating(request["id"]):
                            raise RuntimeError("GitHub Issue 생성 전 요청 상태를 저장하지 못했습니다")

                    number, _fresh = self._find_or_create_issue(
                        self._issue_request_title(request), request["body"],
                        ["urgent"] if request["urgent"] else [],
                        lookup, before_create=persist_attempt)
                    if not self.store.mark_issue_request_created(request["id"], number):
                        raise RuntimeError("발행된 Issue 번호를 요청에 영속화하지 못했습니다")

                issue = self.sup.gh.issue(number)
                if issue["pull_request"]:
                    raise RuntimeError(f"Issue 요청 #{number}가 pull request를 가리킵니다")
                temporary_title = self._issue_request_title(request)
                if issue["title"] == temporary_title:
                    self.sup.gh.edit_issue_title(number, request["title"])
                elif issue["title"] != request["title"]:
                    raise RuntimeError(f"Issue #{number} 제목이 요청 원문과 일치하지 않아 덮어쓰지 않습니다")

                marker = self._issue_request_marker(request["event_key"])
                comments = self.sup.gh.issue_comments(number)
                if not any(marker in (c.get("body") or "") for c in comments):
                    self.sup.gh.comment_issue(number, marker)

                if request["urgent"]:
                    if issue["state"] != "open" or "urgent" not in issue["labels"]:
                        raise RuntimeError(f"urgent 요청 Issue #{number}가 열린 urgent Issue가 아닙니다")
                if not self.store.complete_issue_request(request["id"], number):
                    raise RuntimeError("Issue 발행 완료 상태를 영속화하지 못했습니다")
                self._issue_retry_succeeded(retry_key)
                self.store.log(None, f"Issue 요청 {request['id']} 발행 완료: #{number}"
                               f" ({'urgent / Maintainer 큐' if request['urgent'] else '수동 처리'})")
            except Exception as e:
                self._issue_retry_failed(retry_key, e)

    def _find_or_create_issue(self, title: str, body: str, labels: list[str], lookup,
                              before_create=None) -> tuple[int, bool]:
        """Share Issue creation across generic requests, shared defects and verify blocks.

        Each caller owns its established duplicate policy (event marker, defect class, or exact request payload),
        while this common boundary performs exactly one GitHub create when that policy finds no reusable Issue.
        """
        number, fresh = lookup()
        if number is None:
            if before_create is not None:
                before_create()
            return self.sup.gh.create_issue(title, body, labels), True
        return number, fresh

    @staticmethod
    def _split(d) -> tuple[dict, str]:
        text, _, facts = d["report"].partition("\n")
        if d["source"] == "incident" and defects.is_incident_envelope(text):
            return defects.parse_incident(text), facts
        return defects.parse(text), facts

    # ---- 1. Issue publication (idempotent) --------------------------------------------------------------------
    def _publish(self) -> None:
        for d in self.store.defects(("LINKED",)):   # a crash between the old two-step link left LINKED without a queue row
            if d["issue_number"] and self.store.maintenance(d["issue_number"]) is None:
                self.store.ensure_maintenance(d["issue_number"])
        for d in self.store.defects(("REPORTED",)):
            if d["source"] == "verify":
                self._publish_verify(d)
                continue
            retry_key = f"defect:{d['id']}"
            if not self._issue_retry_due(retry_key):
                continue
            report, facts = self._split(d)
            try:
                issues = self.sup.gh.urgent_issues()
            except Exception as e:
                self.store.log(d["batch_id"], f"urgent Issue 조회 실패(보고·작업물 보존, 재시도 예정): {e}", "warn")
                self._issue_retry_failed(retry_key, e)
                continue
            try:
                envelope = d["source"] == "incident" and report.get("kind") == "incident"
                number, fresh = self._find_or_create_issue(
                    defects.incident_issue_title(report) if envelope else defects.issue_title(report, d["source"]),
                    defects.incident_issue_body(report, d["event_key"]) if envelope
                    else defects.issue_body(report, d["event_key"], facts, d["source"]), ["urgent"],
                    lambda: self._find(issues, d, report))
            except Exception as e:
                self.store.log(d["batch_id"], f"urgent Issue 생성 실패(보고·작업물 보존, 재시도 예정): {e}", "warn")
                self._issue_retry_failed(retry_key, e)
                continue
            if number and not fresh:
                number = self._attach(number, d, report, facts)
                if number is None:
                    self._issue_retry_failed(retry_key, "Issue 연결 코멘트 실패")
                    continue
            self.store.link_defect(d["id"], number)
            self._issue_retry_succeeded(retry_key)
            self.store.log(d["batch_id"], f"urgent Issue #{number} 연결 (공통 결함 `{report['defect_class']}`)")
        self._post_verify_evidence()

    def _find(self, issues, d, report) -> tuple[int | None, bool]:
        """(number, created-for-this-event). 1) the Issue this exact event already created (crash/restart/duplicate);
        2) an open Issue of the same defect class that no fix has been merged for; else None -> create."""
        for i in issues:
            if (defects.EVENT_MARK, d["event_key"]) in defects.markers(i["body"]):
                return i["number"], True
        for i in issues:
            if d["source"] == "incident":   # every ERROR event is its own incident: never merged by class
                break
            if i["state"] != "open" or (defects.CLASS_MARK, report["defect_class"]) not in defects.markers(i["body"]):
                continue
            m = self.store.maintenance(i["number"])
            if m is None or m["state"] in ("QUEUED", "ACTIVE"):
                return i["number"], False
        return None, False

    def _attach(self, number: int, d, report, facts: str) -> int | None:
        """Record this batch on an already open Issue of the same class (once: the comment carries the event marker)."""
        try:
            done = any((defects.EVENT_MARK, d["event_key"]) in defects.markers(c.get("body"))
                       for c in self.sup.gh.issue_comments(number))
            if not done:
                self.sup.gh.comment_issue(number, defects.link_comment(report, d["event_key"], facts))
        except Exception as e:
            self.store.log(d["batch_id"], f"기존 Issue #{number} 연결 코멘트 실패(재시도 예정): {e}", "warn")
            return None
        return number

    # ---- Stage 2 Batch/Shard verify blocks (Issue #2154) -----------------------------------------------------------
    def report_verify(self, f) -> None:
        """Record a reproduced deterministic verify failure. A scope has exactly one active block: a repeat only
        refreshes its evidence, a different fingerprint before the fix merges is added as evidence, and a failure that
        survives a merged fix (or recurs while HELD) holds the block for the operator. Never a second Issue or PAUSE."""
        cls = f.defect_class
        block = self.store.active_verify(cls)
        if block is None:
            base = f"verify:{f.kind}:{f.shard}{':' + f.batch if f.batch else ''}:{f.fingerprint}"
            key = f"{base}:after:{self.store.last_verify_defect_id(cls)}" if self.store.defect_by_event(base) else base
            if self.store.report_verify_failure(key, cls, defects.verify_report(f)) is not None:
                self.store.log(None, f"Stage 2 {f.scope} verify 실패({f.family} {f.total}건, 지문 {f.fingerprint}) → 범위 차단, urgent Issue 등록 대기",
                               "error", line=self._line())
            return
        try:
            d = defects.parse_verify(block["report"])
        except defects.ReportProblem:
            d = None   # unusable stored evidence: replaced by this reproduced failure below
        same = d is not None and d["fingerprint"] == f.fingerprint
        extra = d["extra"] if d else []
        if d is not None and not same and block["state"] in ("REPORTED", "LINKED"):
            if all(x["fingerprint"] != f.fingerprint for x in extra) and d["fingerprint"] != f.fingerprint:
                extra = (extra + [{"fingerprint": f.fingerprint, "sha": f.sha, "total": f.total,
                                   "errors": defects.verify_evidence(f.errors), "posted": False}])[-defects.VERIFY_EXTRA_MAX:]
            report = defects.canonical({**d, "sha": f.sha, "extra": extra})
        else:
            report = defects.verify_report(f, extra)
        fields = {"report": report}
        if block["state"] in ("FIX_MERGED", "HELD"):
            fields["state"] = "HELD"
            old = d["fingerprint"] if d else "?"
            fields["hold_reason"] = (f"수정 머지({(block['merge_sha'] or '')[:10]}) 후에도 최신 master {f.sha[:10]}에서 {f.scope} verify가 계속 실패합니다 "
                                     f"(지문 {f.fingerprint}, 최초 {old}). 새 Issue/Maintainer를 자동으로 만들지 않습니다 — 운영자 확인 필요."
                                     if block["state"] == "FIX_MERGED" else block["hold_reason"] or "운영자 확인 필요")
            if block["state"] == "FIX_MERGED":
                self.store.log(None, fields["hold_reason"], "error", line=self._line())
        self.store.update_defect(block["id"], **fields)

    def _line(self) -> str:
        return f"{maintainer_id(self.cfg) or 'm'}/s2"

    def _publish_verify(self, d) -> None:
        retry_key = f"verify:{d['id']}"
        if not self._issue_retry_due(retry_key):
            return
        try:
            v = defects.parse_verify(d["report"])
        except defects.ReportProblem as e:
            self.store.update_defect(d["id"], state="HELD", hold_reason=f"verify 보고 스키마 오류 — Issue를 만들지 않습니다: {e}")
            return self.store.log(None, f"Stage 2 verify 보고 거부(HELD): {e}", "error", line=self._line())
        try:
            issues = self.sup.gh.urgent_issues()
        except Exception as e:
            self._issue_retry_failed(retry_key, e)
            return self.store.log(None, f"urgent Issue 조회 실패(차단 보존, 재시도 예정): {e}", "warn", line=self._line())
        try:
            number, fresh = self._find_or_create_issue(
                defects.verify_issue_title(v),
                defects.verify_issue_body(v, d["event_key"], d["defect_class"]), ["urgent"],
                lambda: self._find_verify(issues, d, v))
        except Exception as e:
            self._issue_retry_failed(retry_key, e)
            return self.store.log(None, f"urgent Issue 생성 실패(차단 보존, 재시도 예정): {e}", "warn", line=self._line())
        if not fresh:
            if not self._comment_once(number, d["event_key"], defects.verify_link_comment(v, d["event_key"])):
                self._issue_retry_failed(retry_key, "Issue 연결 코멘트 실패")
                return
        self.store.link_defect(d["id"], number)
        self._issue_retry_succeeded(retry_key)
        self.store.log(None, f"urgent Issue #{number} 연결 (Stage 2 verify 차단 `{d['defect_class']}`)", line=self._line())

    def _comment_once(self, number: int, event_key: str, body: str) -> bool:
        """Add `body` to Issue `number` unless a comment with this event marker exists. False: GitHub failed (retried)."""
        try:
            if not any((defects.EVENT_MARK, event_key) in defects.markers(c.get("body")) for c in self.sup.gh.issue_comments(number)):
                self.sup.gh.comment_issue(number, body)
        except Exception as e:
            self.store.log(None, f"Issue #{number} 코멘트 실패(재시도 예정): {e}", "warn", line=self._line())
            return False
        return True

    def _find_verify(self, issues, d, v) -> tuple[int | None, bool]:
        """(number, created-for-this-event): 1) the Issue this exact event created (restart); 2) an open Issue of this
        scope's class with no finished fix; 3) an open manual urgent Issue naming BOTH the scope label and the first
        verify error (title similarity alone never links). DONE/HELD Issues are never reused for new work."""
        for i in issues:
            if (defects.EVENT_MARK, d["event_key"]) in defects.markers(i["body"]):
                return i["number"], True
        def usable(i):
            m = self.store.maintenance(i["number"])
            return i["state"] == "open" and (m is None or m["state"] in ("QUEUED", "ACTIVE"))
        for i in issues:
            if usable(i) and (defects.CLASS_MARK, d["defect_class"]) in defects.markers(i["body"]):
                return i["number"], False
        scope = re.compile(rf"(?<![0-9_]){re.escape(defects.verify_scope(v))}(?![0-9_])")
        first = " ".join(v["errors"][0].split()).rstrip("…")
        for i in issues:
            if not usable(i) or any(k == defects.CLASS_MARK for k, _ in defects.markers(i["body"])):
                continue
            text = " ".join(f"{i.get('title', '')}\n{i['body']}".split())
            if scope.search(text) and first in text:
                return i["number"], False
        return None, False

    def _post_verify_evidence(self) -> None:
        """Comment, once each, the additional fingerprints seen on an active scope before its fix merged."""
        for d in self.store.defects(("LINKED",)):
            if d["source"] != "verify" or not d["issue_number"]:
                continue
            try:
                v = defects.parse_verify(d["report"])
            except defects.ReportProblem:
                continue
            if all(x["posted"] for x in v["extra"]) or not self._due(f"verify_evidence_try_{d['id']}"):
                continue
            for x in v["extra"]:
                if not x["posted"] and self._comment_once(d["issue_number"], f"{d['event_key']}:evidence:{x['fingerprint']}",
                                                          defects.verify_evidence_comment(x, v, f"{d['event_key']}:evidence:{x['fingerprint']}")):
                    x["posted"] = True
            self.store.update_defect(d["id"], report=defects.canonical(v))

    # ---- 2. start the single Maintainer ------------------------------------------------------------------------
    def _start(self) -> None:
        if self.store.maintenance_batch_open() or self.store.maintenance_drained():   # Drain: no automatic next claim
            return
        queued = [m for m in self.store.maintenance_rows() if m["state"] == "QUEUED"]
        if not queued or maintainer_id(self.cfg) is None:   # unconfigured: reports, Issues and PAUSED stay; nothing runs
            return
        producer = maintainer_id(self.cfg)
        problem = maintainer_problem(self.cfg)
        if problem:   # fail closed: never another model
            if self._due("maintainer_problem_log", 600):
                self.store.log(None, f"Maintainer 시작 차단 ({producer}): {problem}", "error")
            return
        m = queued[0]
        if not self._due("maintainer_start_try"):
            return
        problem = self.sup._adapter_problem(producer)
        if problem:
            return self.store.log(None, f"Maintainer 시작 차단 ({producer}): {problem}", "error")
        d = auth.diagnose(self.sup.runner, self.sup.env, self.cfg["repo"], self.cfg["expected_account"])
        if d.get("transient"):   # a GitHub API/network answer, whatever its status: ask again, never block (#2810)
            return self.store.log(None, f"Maintainer 시작 보류 — GitHub 조회 복구 대기, 다음 주기에 재시도: {d['transient']}", "warn")
        if not d["ok"]:
            return self.store.log(None, "Maintainer 시작 차단: " + "; ".join(d["problems"]), "error")
        issue = self.sup.gh.issue(m["issue_number"])
        if issue["pull_request"] or issue["state"] != "open" or "urgent" not in issue["labels"]:
            self.store.update_maintenance(m["issue_number"], state="HELD", hold_reason=(
                f"Issue #{m['issue_number']}가 열린 urgent Issue가 아닙니다 (state={issue['state']}, "
                f"labels={issue['labels']}) — 수정 PR 없이 닫힌 Issue는 해제 근거가 아닙니다. 운영자 확인 필요."))
            return self.store.log(None, self.store.maintenance(m["issue_number"])["hold_reason"], "error")
        n = m["issue_number"]
        linked = [x for x in self.store.defects() if x["source"] == "incident" and x["issue_number"] == n]
        if linked and all(x["state"] == "OVERRIDDEN" for x in linked):   # the operator already took these batches over
            self.store.update_maintenance(n, state="HELD", hold_reason="연결된 incident가 모두 운영자에 의해 OVERRIDDEN — Maintainer를 시작하지 않습니다")
            return self.store.log(None, f"Issue #{n}: 연결된 incident가 모두 운영자 제어로 해제되어 Maintainer를 시작하지 않습니다", "warn")
        wt = self.sup.paths.worktrees / f"maint-{n}"
        bid = self.store.claim_maintenance(n, producer, f"maint-{n}", str(wt))
        if bid is not None:
            self.store.log(bid, f"Maintainer({producer}) 시작: urgent Issue #{n}, worktree 준비 (최신 {self.cfg['base_branch']})")

    # ---- 3. merged PR + Maintainer cleanup -> the fix is ready ----------------------------------------------------
    def _track(self) -> None:
        for m in self.store.maintenance_rows():
            if m["state"] != "ACTIVE" or m["batch_id"] is None:
                continue
            b = self.store.batch(m["batch_id"])
            if b["state"] != "COMPLETE":   # merged AND cleaned up is the only way a batch row becomes COMPLETE
                continue
            if not b["pr_number"] or not b["merged"]:
                self.store.update_maintenance(m["issue_number"], state="HELD", hold_reason="COMPLETE인데 merged PR 기록이 없습니다")
                continue
            info = self.sup.gh.pull(b["pr_number"])   # a failure retries on the next tick
            sha = info.get("merge_commit_sha") or ""
            why = None
            if not info["merged"]:
                why = f"PR #{b['pr_number']}의 merged=true를 재확인하지 못했습니다"
            elif info["head_ref"] != b["branch"]:
                why = f"PR #{b['pr_number']}의 head {info['head_ref']!r}가 Maintainer 브랜치 {b['branch']!r}가 아닙니다"
            elif not re.fullmatch(r"[0-9a-f]{40}", sha):
                why = f"PR #{b['pr_number']}의 merge commit을 알 수 없습니다"
            if why:
                self.store.update_maintenance(m["issue_number"], state="HELD", hold_reason=why)
                self.store.log(b["id"], why, "error")
                continue
            self.store.update_maintenance(m["issue_number"], state="DONE", pr_number=b["pr_number"], merge_sha=sha)
            for d in self.store.defects(("LINKED",)):
                if d["issue_number"] == m["issue_number"]:
                    self.store.update_defect(d["id"], state="FIX_MERGED", merge_sha=sha)
            self.store.log(b["id"], f"Issue #{m['issue_number']}: PR #{b['pr_number']} merged=true + Maintainer cleanup 완료 "
                           f"(merge commit {sha[:10]}) → 종속 배치에 수정 반영")

    # ---- 4. apply the merged fix to each paused batch, verify, retry once ------------------------------------------
    def _workers_running(self, b) -> bool:
        """The batch's AI process, or (parallel Stage 2) ANY task run, is not confirmed gone."""
        return b["pid"] is not None or bool(self.store.open_task_runs(b["id"]))

    def _release(self) -> None:
        for d in self.store.defects(("FIX_MERGED",)):
            if d["source"] == "verify":   # no production batch: the scope's exact verify on master releases it (stage2.choose)
                continue
            b = self.store.batch(d["batch_id"])
            if b is None:   # the batch no longer exists: this defect can never be applied, and must not block the others
                self.store.update_defect(d["id"], state="OVERRIDDEN", hold_reason="배치가 더 이상 존재하지 않음")
                continue
            if b["state"] != "PAUSED" or b["pause_reason"] != "shared_defect" or b["defect_id"] != d["id"]:
                # the operator already resumed (Stop + Retry) or the batch moved on: this fix is no longer ours to apply
                self.store.update_defect(d["id"], state="OVERRIDDEN", hold_reason="운영자가 배치를 직접 재개함")
                continue
            if self.store.get(f"defect_hold_{b['id']}") or self._workers_running(b):
                continue   # operator Stop is pending/active, or the stopped AI is not confirmed gone yet
            if d["source"] == "incident":
                try:
                    self._release_incident(d, b)
                except GitTransient as e:
                    self.store.log(b["id"], f"incident 수정 반영 중 일시 오류(재시도 예정): {e}", "warn")
                except IntegrationBlocked as e:
                    self._hold(d, b, f"재개 증명 불가: {b['run_kind'] or b['paused_from']}: {e}")
                except GitError as e:
                    self.store.log(b["id"], f"수정 반영 중 Git 오류(재시도 예정): {e}", "warn")
                continue
            if self._fix_not_loaded(d):
                continue
            if not self._due(f"defect_release_try_{d['id']}"):
                continue
            try:
                head, run_start = self._apply(d, b)
            except IntegrationBlocked as e:
                self._hold(d, b, str(e))
                continue
            except GitError as e:
                self.store.log(b["id"], f"수정 반영 중 Git 오류(재시도 예정): {e}", "warn")
                continue
            if head is None:
                continue
            if not self._archive_report(d, b):
                continue   # the resolved report could not be set aside: never resume into a stale stop signal
            if run_start is None:
                run_start = self._retargeted_run_start(b, head)
            if run_start is None and ((b["method"] == STAGE3_METHOD
                    and (str(b["run_kind"] or "").startswith("s3_chunk_") or b["run_kind"] in ("s3_finalize", "s3_parallel")))
                    or (b["method"] == dchunk.METHOD and b["run_kind"] == "d_parallel")
                    or (b["method"] == literary.METHOD and b["run_kind"] == "c_parallel")):
                self._hold(d, b, "원래 실행 기준을 통합 HEAD에 안전하게 재결속할 수 없습니다. "
                                  "checkpoint/view/commit과 소유 worktree를 보존하고 자동 재개하지 않습니다.")
                continue
            if self.store.release_defect(d["id"], b["id"], head, run_start):
                self.store.log(b["id"], f"공통 수정 {d['merge_sha'][:10]} 반영·검증 완료 (HEAD {head[:10]}) → "
                               f"{b['paused_from'] or 'PRODUCING'}부터 자동 Retry 1회")

    def _retargeted_run_start(self, b, new_head: str, *, completed_pr_head: str | None = None) -> tuple[str, str] | None:
        """Retarget a Stage 2/3 run baseline after the approved fix is integrated and verified.

        Invariant: the baseline's owned HEAD may only advance to a HEAD that is a verified Maintainer integration of this
        same branch/worktree. The old HEAD must be an ancestor (a plain forward merge). An in-flight run also requires
        its original remote boundary; a completed Stage 3 PR may instead rebind at its exact current owner PR HEAD.
        """
        if b["method"] == STAGE3_METHOD and b["run_kind"] == "s3_finalize":
            commit_key = f"s3_commit_head_{b['id']}"
            committed = self.store.get(commit_key)
            remote_key = f"s3_commit_remote_head_{b['id']}"
            saved_remote = self.store.get(remote_key)
            wt = Path(b["worktree"])
            try:
                remote = self.sup.git.remote_head(b["branch"])
                saved_remote_is_ancestor = (saved_remote == "" or
                                            (isinstance(saved_remote, str)
                                             and re.fullmatch(r"[0-9a-f]{40}", saved_remote)
                                             and self.sup.git.contains(wt, saved_remote)))
                completed_pr = (completed_pr_head is not None and b["state"] == "PAUSED"
                                and b["pause_reason"] == "shared_defect" and b["paused_from"] == "WAITING_REVIEW"
                                and b["pr_number"] is not None and isinstance(b["head_sha"], str)
                                and completed_pr_head in {b["head_sha"], new_head}
                                and remote in {b["head_sha"], new_head} and saved_remote_is_ancestor)
                remote_matches_start = (saved_remote is not None and saved_remote == (remote or ""))
                if (not isinstance(committed, str) or not re.fullmatch(r"[0-9a-f]{40}", committed)
                        or not (completed_pr if completed_pr_head is not None else remote_matches_start)
                        or self.sup.git.registered(wt) != b["branch"] or self.sup.git.head(wt) != new_head
                        or not self.sup.git.contains(wt, committed)):
                    return None
            except GitTransient:
                raise
            except Exception:
                return None
            return f"s3_finalize_released_head_{b['id']}", new_head
        if b["method"] == STAGE3_METHOD and b["run_kind"] == "s3_parallel":
            return self._retargeted_s3_parallel(b, new_head)
        if b["method"] == STAGE3_METHOD and isinstance(b["run_kind"], str) \
                and b["run_kind"].startswith("s3_chunk_"):
            key = stage3.run_start_key(b["id"])
        elif b["method"] == STAGE2_METHOD:   # each Stage 2 step checks its OWN baseline key
            key = {"s2_links_new": stage2.links_start_key, "s2_links_fix": stage2.links_start_key,
                   "s2_repair_new": stage2.repair_run_start_key}.get(b["run_kind"], stage2.run_start_key)(b["id"])
        elif b["method"] == dchunk.METHOD and (b["run_kind"] == "d_parallel" or self._serial_d(b)):
            key = dchunk.run_start_key(b["id"])   # only the run baseline moves; `d_base_head` stays the first HEAD
        elif b["method"] == literary.METHOD and (b["run_kind"] == "c_parallel" or self._serial_c(b)):
            key = literary.run_start_key(b["id"])   # the one approved runtime baseline; the checkpoint HEAD stays
        else:
            return None
        raw = self.store.get(key)
        if raw is None:
            return None
        wt = Path(b["worktree"])
        try:
            base = json.loads(raw)
            if not isinstance(base, dict) or base.get("branch") != b["branch"] or base.get("worktree") != str(wt) \
                    or not isinstance(base.get("head"), str) or "remote_head" not in base:
                return None
            if self.sup.git.registered(wt) != b["branch"]:   # detached or another branch: not the owned checkout
                return None
            if self.sup.git.head(wt) != new_head or not self.sup.git.contains(wt, base["head"]) \
                    or self.sup.git.remote_head(b["branch"]) != base["remote_head"]:
                return None
            if b["method"] == literary.METHOD:
                # The baseline only moves forward when the integration kept every input the batch is bound to: the
                # Canonical shard, the checkpoint's original identity and the exact view of each active chunk.
                if isinstance(base.get("canonical_sha256"), str):
                    canonical = hashlib.sha256((wt / literary.names(b).canonical).read_bytes()).hexdigest()
                    if base["canonical_sha256"] != canonical:
                        return None
                elif literary.names(b).canonical in self.sup.git.changed_between(base["head"], new_head):
                    return None   # a serial baseline records no canonical sha: the integration itself must not touch it
                literary.checkpoint_head(wt, b)
                for number, rec in literary.active_chunks(wt, b).items():
                    literary.read_view(wt, rec, number)
            if b["method"] == STAGE3_METHOD:
                checkpoint = base.get("checkpoint")
                chunk = base.get("chunk")
                if (not isinstance(checkpoint, dict) or checkpoint.get("shard") != b["shard"]
                        or chunk != stage3.next_chunk(checkpoint) or not isinstance(base.get("view"), dict)):
                    return None
                current = stage3.checkpoint(wt, b["shard"])
                if current != checkpoint and not stage3.chunk_saved_since(checkpoint, current):
                    return None
                refreshed = stage3.refresh_pending_chunks(self.sup.runner, self.sup.env, wt, b["shard"])
                if current == checkpoint:
                    current_view = refreshed.get("current_view")
                    if refreshed.get("current_chunk") != chunk or not isinstance(current_view, dict):
                        return None
                    if refreshed.get("active_changed") or current_view != base["view"]:
                        # The previous answer was bound to a different Stage 3 input view. Rebind the exact pending
                        # chunk to the newly rendered Git inputs and make the Supervisor launch it afresh instead of
                        # reusing the answer. refresh_pending_chunks also proves that every saved chunk's full raw view,
                        # including hidden Relation row bindings, remains unchanged.
                        base["view"] = current_view
                        base["answer_invalidated"] = True
        except GitTransient:
            raise
        except Exception:
            return None
        if b["method"] == literary.METHOD:   # each preserved active chunk follows the one approved runtime baseline
            try:
                for number, rec in literary.active_chunks(wt, b).items():
                    if rec["git_head"] != new_head:
                        path = wt / literary._active_paths(number)[0]
                        tmp = path.with_name(path.name + ".tmp")
                        tmp.write_text(json.dumps({**rec, "git_head": new_head}, sort_keys=True), "utf-8")
                        tmp.replace(path)
            except Exception:
                return None
        if b["method"] == dchunk.METHOD and self._serial_d(b):   # each preserved active chunk follows the run baseline
            try:
                for number, rec in dchunk.active_chunks(wt, b).items():
                    if rec["git_head"] != new_head:
                        path = wt / dchunk.chunk_names(b, number).active
                        tmp = path.with_name(path.name + ".tmp")
                        tmp.write_text(json.dumps({**rec, "git_head": new_head}, sort_keys=True), "utf-8")
                        tmp.replace(path)
            except Exception:
                return None
        if base["head"] != new_head:
            base["head"] = new_head
            stage = {STAGE2_METHOD: "Stage 2", dchunk.METHOD: "D", literary.METHOD: "C"}.get(b["method"], "Stage 3")
            self.store.log(b["id"], f"승인된 Maintainer 통합으로 {stage} 실행 Git 경계 기준을 HEAD {new_head[:10]}로 전환했습니다.")
        return key, json.dumps(base, sort_keys=True)

    @staticmethod
    def _serial_d(b) -> bool:
        k = b["run_kind"] or ""
        return b["method"] == dchunk.METHOD and (k.startswith("d_chunk_") or k == "d_finalize")

    @staticmethod
    def _serial_c(b) -> bool:
        k = b["run_kind"] or ""
        return b["method"] == literary.METHOD and (k.startswith("c_chunk_") or k == "c_finalize")

    def _retargeted_s3_parallel(self, b, new_head: str) -> tuple[str, str] | None:
        """Parallel Stage 3: move the one baseline forward and name the pending tasks whose rendered view changed.

        Invalidation is decided from the CHECKPOINT and the prepared view digests, never from SQLite task state: a
        chunk the checkpoint holds is never invalidated (if its view changed, `refresh-pending` fails and this HOLDs)."""
        key = stage3.parallel_start_key(b["id"])
        wt = Path(b["worktree"])
        try:
            base = json.loads(self.store.get(key) or "null")
            if not isinstance(base, dict) or base.get("branch") != b["branch"] or base.get("worktree") != str(wt) \
                    or not isinstance(base.get("head"), str) or "remote_head" not in base:
                return None
            if self.sup.git.registered(wt) != b["branch"]:
                return None
            if self.sup.git.head(wt) != new_head or not self.sup.git.contains(wt, base["head"]) \
                    or self.sup.git.remote_head(b["branch"]) != base["remote_head"]:
                return None
            refreshed = stage3.refresh_pending_chunks(self.sup.runner, self.sup.env, wt, b["shard"])   # fails on completed-view/count change
            digests = refreshed.get("pending_view_sha256")
            state = stage3.checkpoint(wt, b["shard"])
            if not isinstance(digests, dict) or state is None:
                return None
            done = set(state["completed_chunks"])
            changed = {row["task"] for row in self.store.task_rows(b["id"])
                       if row["task"] not in done and row["view_sha256"] and row["task"] in digests
                       and digests[row["task"]] != row["view_sha256"]}
            base["invalidated"] = sorted(set(base.get("invalidated") or []) | changed)
        except GitTransient:
            raise
        except Exception:
            return None
        if base["head"] != new_head:
            base["head"] = new_head
            self.store.log(b["id"], f"승인된 Maintainer 통합으로 Stage 3 병렬 Git 경계 기준을 HEAD {new_head[:10]}로 전환했습니다"
                           + (f" (view 변경 task {len(base['invalidated'])}개는 새 세션으로 재판정)" if base["invalidated"] else "") + ".")
        return key, json.dumps(base, sort_keys=True)

    def adopt_released_baseline(self, b) -> None:
        """Recover a released Stage 2/3 baseline only at this batch's verified Maintainer integration HEAD."""
        if b["method"] == STAGE2_METHOD:
            key = stage2.run_start_key(b["id"])
        elif b["method"] == STAGE3_METHOD and isinstance(b["run_kind"], str) \
                and b["run_kind"].startswith("s3_chunk_"):
            key = stage3.run_start_key(b["id"])
        elif b["method"] == STAGE3_METHOD and b["run_kind"] == "s3_parallel":
            key = stage3.parallel_start_key(b["id"])
        elif b["method"] == STAGE3_METHOD and b["run_kind"] == "s3_finalize":
            key = f"s3_finalize_released_head_{b['id']}"
        elif b["method"] == dchunk.METHOD and b["run_kind"] == "d_parallel":
            key = dchunk.run_start_key(b["id"])
        elif b["method"] == literary.METHOD and b["run_kind"] == "c_parallel":
            key = literary.run_start_key(b["id"])
        else:
            return
        try:
            head = self.sup.git.head(Path(b["worktree"]))
            raw = self.store.get(key)
            recorded = raw if b["run_kind"] == "s3_finalize" else (json.loads(raw) if raw else None)
            if raw is None or (recorded == head if b["run_kind"] == "s3_finalize" else recorded.get("head") == head):
                return
            for d in self.store.defects(("RELEASED",)):
                if d["batch_id"] != b["id"] or d["integrated_sha"] != head:
                    continue
                if b["method"] == dchunk.METHOD and b["run_kind"] == "d_parallel":
                    old_head = recorded.get("head") if isinstance(recorded, dict) else None
                    proven = self._released_integration_proof(b, old_head, head, d)
                else:
                    proven = self.sup.git.contains(Path(b["worktree"]), d["merge_sha"])
                if proven:
                    moved = self._retargeted_run_start(b, head)
                    if moved:
                        self.store.set(*moved)
                    return
        except GitTransient:
            raise
        except Exception:
            return   # unreadable evidence: the unchanged baseline keeps failing closed

    def _released_integration_proof(self, b, old_head: str, integrated_head: str, receipt=None, pending: dict | None = None) -> bool:
        """Prove a same-batch RELEASED Maintainer merge is an ancestor of this owned worktree.

        `pending` (#3349) stands in for the receipt that does not exist yet: the immutable result of
        `_fix_merged_integration_proof` for the FIX_MERGED defect. It is accepted only while that very row is still
        FIX_MERGED, and only for the integrated HEAD it was proven for. Nothing is stored."""
        if (not isinstance(old_head, str) or not re.fullmatch(r"[0-9a-f]{40}", old_head)
                or not isinstance(integrated_head, str) or not re.fullmatch(r"[0-9a-f]{40}", integrated_head)
                or old_head == integrated_head):
            return False
        wt = Path(b["worktree"])
        try:
            if (self.sup.git.registered(wt) != b["branch"]
                    or not self.sup.git.is_ancestor(old_head, integrated_head, path=wt)
                    or not self.sup.git.contains(wt, integrated_head)):
                return False
            if pending is not None:
                row = self.store.defect(pending["defect_id"])
                return bool(row is not None and row["state"] == "FIX_MERGED" and row["batch_id"] == b["id"]
                            and row["merge_sha"] == pending["merge_sha"] and pending["head"] == integrated_head
                            and isinstance(pending["merge_sha"], str) and re.fullmatch(r"[0-9a-f]{40}", pending["merge_sha"])
                            and self.sup.git.contains(wt, pending["merge_sha"]))
            receipts = [receipt] if receipt is not None else self.store.defects(("RELEASED",))
            for item in receipts:
                merge_sha = item["merge_sha"]
                if (item["state"] == "RELEASED" and item["batch_id"] == b["id"]
                        and item["integrated_sha"] == integrated_head
                        and isinstance(merge_sha, str) and re.fullmatch(r"[0-9a-f]{40}", merge_sha)
                        and self.sup.git.contains(wt, merge_sha)):
                    return True
        except GitTransient:
            raise
        except Exception:
            return False
        return False

    def _fix_merged_integration_proof(self, b, d, old_base: str, new_head: str) -> dict | None:
        """Direct proof, from the FIX_MERGED defect itself (no RELEASED receipt needed), that `new_head` is this batch's
        own integration of the merged fix. Returns the immutable `pending` object, or None."""
        sha = d["merge_sha"]
        if d["state"] != "FIX_MERGED" or d["batch_id"] != b["id"] or not (isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha)):
            return None
        pending = {"defect_id": d["id"], "merge_sha": sha, "head": new_head}
        return pending if self._released_integration_proof(b, old_base, new_head, pending=pending) \
            and self.sup.git.head(Path(b["worktree"])) == new_head else None

    # ---- autonomous incident intake (Issues #3326, #3349) ---------------------------------------------------------
    # Every non-ERROR -> ERROR transition of a C/D/Stage 2/Stage 3 batch carries an incident number (`Store.update`). The
    # sweep below is the single intake boundary: whatever wrote the ERROR (`_fail`, a direct write, a parallel task, a
    # restart) is received here, after the batch's process and task runs are confirmed gone.
    DIAGNOSIS_FILE = ".warroom-scratch/incident-diagnosis.json"
    DIAGNOSIS_OUTCOMES = ("no_code_fix", "external", "undetermined", "recurrence")
    INTAKE_METHODS = ("c", "d", "s2", "s3")

    def _intake_errors(self) -> None:
        legacy = self.store.legacy_errors()
        if legacy and self.store.get("incident_legacy_logged") is None:
            self.store.set("incident_legacy_logged", "1")
            self.store.log(None, "사건 번호가 없는 기존 ERROR 배치는 자동 접수하지 않습니다(운영자 확인): "
                           + ", ".join(f"#{r['id']} {r['method']} {r['shard']}_{r['batch']}" for r in legacy), "warn")
        for b in self.store.intake_candidates():
            try:
                self._intake(b)
            except Exception as e:   # one batch's trouble never blocks the others; the ERROR stays as written
                self.store.log(b["id"], f"장애 접수 예외(ERROR와 증거 보존, 재시도 예정): {e}", "warn")

    def _intake(self, b) -> None:
        bid, seq = b["id"], b["error_seq"]
        if b["pid"] is not None or self.store.open_task_runs(bid):
            return   # the stopped process / task runs must be confirmed gone first: the next sweep
        if self.store.get(f"incident_recurrence_{bid}_{seq}") == "done":
            return
        evidence = self._error_evidence(bid, seq)
        prior = self._prior_incidents(bid)
        fp = evidence.get("fingerprint") if evidence else None
        if fp:
            again = [p for p in prior if p["fingerprint"] == fp and b["error_at"] is not None and b["error_at"] > p["released_at"]]
            if again:
                return self._recurrence_blocked(b, again[0])
        for other in self.store.incomplete_batches():
            if other["id"] != bid and (other["branch"] == b["branch"] or other["worktree"] == b["worktree"]):
                if self._due(f"incident_conflict_{bid}_{seq}", 600):
                    self.store.log(bid, f"장애 접수 차단: 같은 branch/worktree를 다른 미완료 배치 #{other['id']}가 소유합니다. ERROR 유지", "error")
                return
        env = defects.incident_envelope(b, self._observe(b, evidence), [
            {k: p[k] for k in ("defect_id", "merge_sha", "fingerprint")} for p in prior])
        try:
            raw = defects.canonical(env)
            defects.parse_incident(raw)
        except defects.ReportProblem as e:
            if self._due(f"incident_envelope_{bid}_{seq}", 600):
                self.store.log(bid, f"장애 접수 차단(envelope 불완전: {e}). ERROR 유지", "error")
            return
        self.report(b, "incident", defects.incident_event_key(bid, seq), raw,
                    expect={k: b[k] for k in ("error_seq", "paused_from", "run_kind", "branch", "worktree")})

    def _error_evidence(self, bid: int, seq: int) -> dict | None:
        try:
            ev = json.loads(self.store.get(f"error_evidence_{bid}_{seq}") or "null")
        except ValueError:
            return None
        if not isinstance(ev, dict):
            return None
        return {**ev, "fingerprint": defects.evidence_fingerprint(ev)}

    def _prior_incidents(self, bid: int) -> list[dict]:
        out = []
        for d in self.store.defects(("RELEASED",)):
            if d["batch_id"] != bid or d["source"] != "incident":
                continue
            fp = None
            try:
                env = defects.parse_incident(d["report"].partition("\n")[0])
                o = env["observed"]["error_evidence"]
                fp = o["value"].get("fingerprint") if o["status"] == "ok" and isinstance(o["value"], dict) else None
            except (defects.ReportProblem, KeyError):
                pass
            out.append({"defect_id": d["id"], "merge_sha": d["merge_sha"], "fingerprint": fp, "released_at": d["updated_at"],
                        "issue_number": d["issue_number"]})
        return out

    def _recurrence_blocked(self, b, prior: dict) -> None:
        """Proven same cause after its fix was applied: no new incident, the ERROR stays, the old Issue says so once."""
        bid, seq = b["id"], b["error_seq"]
        key = f"incident_recurrence_{bid}_{seq}"
        if self.store.get(key) is None:
            self.store.log(bid, f"수정 후 동일 증거 재발(defect #{prior['defect_id']}, 지문 {prior['fingerprint']}) — 자동 재수정 차단, "
                           "운영자 확인 필요. ERROR 유지", "error")
            self.store.set(key, "seen")
        if not prior["issue_number"]:
            return self.store.set(key, "done")
        ev = f"incident-recurrence-{bid}-{seq}"
        if self._comment_once(prior["issue_number"], ev,
                              "수정 후 동일 증거 재발 — 자동 재수정 차단, 운영자 확인\n\n"
                              f"- 배치 `{b['shard']}_{b['batch']}` · 사건 e{seq} · 증거 지문 `{prior['fingerprint']}`\n\n"
                              + defects.marker(defects.EVENT_MARK, ev)):
            self.store.set(key, "done")

    # observations ---------------------------------------------------------------------------------------------
    def _git_facts(self, b) -> dict:
        wt = Path(b["worktree"])
        return {"head": self.sup.git.head(wt), "remote_head": self.sup.git.remote_head(b["branch"]),
                "dirty": bool(self.sup.git.dirty(wt).strip()), "registered": self.sup.git.registered(wt),
                "pr_number": b["pr_number"], "pr_head": b["head_sha"]}

    @staticmethod
    def _scratch_digests(b) -> dict | None:
        """sha256 of every checkpoint / view / chunk file under the worktree scratch (None: no scratch directory)."""
        root = Path(b["worktree"]) / ".warroom-scratch"
        if not root.is_dir():
            return None
        out = {}
        for f in sorted(root.rglob("*")):
            rel = f.relative_to(root)
            if not f.is_file() or rel.parts[0] in ("resolved-defects", "incident") or f.suffix in (".log", ".tmp"):
                continue
            out[str(rel)] = hashlib.sha256(f.read_bytes()).hexdigest()
        return out

    def _observe(self, b, evidence: dict | None) -> dict:
        ok, missing, unknown = defects.observation, lambda: defects.observation("missing"), lambda e: defects.observation("unknown", str(e)[:200])
        obs = {}

        def put(name, fn):
            try:
                obs[name] = fn()
            except Exception as e:   # a failed lookup is `unknown`, never a blocked intake
                obs[name] = unknown(e)
        wt_exists = Path(b["worktree"]).is_dir()
        put("runs", lambda: (ok("ok", [{"id": r["id"], "kind": r["kind"], "exit_status": r["exit_status"], "log_file": r["log_file"]}
                                       for r in self.store.runs(b["id"])[:20]]) if self.store.runs(b["id"]) else missing()))
        put("log_file", lambda: ok("ok", {"path": b["log_file"], "size": Path(b["log_file"]).stat().st_size})
            if b["log_file"] and Path(b["log_file"]).is_file() else missing())
        put("events", lambda: ok("ok", [{"ts": e["ts"], "level": e["level"], "msg": e["msg"][:300]}
                                        for e in self.store.batch_events(b["id"])[-20:]]))
        put("checkpoint", lambda: (lambda d: ok("ok", d) if d is not None else missing())(self._scratch_digests(b)))
        put("git", lambda: ok("ok", self._git_facts(b)) if wt_exists else missing())
        put("receipts", lambda: ok("ok", [{"defect_id": x["id"], "merge_sha": x["merge_sha"], "integrated_sha": x["integrated_sha"],
                                           "fix_kind": x["fix_kind"]} for x in self.store.defects(("RELEASED",))
                                          if x["batch_id"] == b["id"]]))
        put("error_evidence", lambda: ok("ok", evidence) if evidence else missing())
        return obs

    def _preserved(self, b, obs: dict, head_moves: bool) -> str | None:
        """Compare the intake-time observations with now. None = preserved; else the reason it cannot be proven."""
        for name, o in obs.items():
            if o["status"] == "unknown":
                return f"접수 시 `{name}` 관측이 unknown이라 보존을 증명할 수 없습니다"
        try:
            wt_exists = Path(b["worktree"]).is_dir()
            git = obs["git"]
            if git["status"] == "missing":
                if wt_exists:
                    return "접수 시 없던 worktree가 지금은 존재합니다"
            else:
                if not wt_exists:
                    return "접수 시 있던 worktree가 사라졌습니다"
                now, then = self._git_facts(b), git["value"]
                for key in ("remote_head", "dirty", "pr_number", "pr_head") + (() if head_moves else ("head",)):
                    if now[key] != then[key]:
                        return f"접수 이후 {key}가 바뀌었습니다"
            cp, digests = obs["checkpoint"], (self._scratch_digests(b) if wt_exists else None)
            if cp["status"] == "missing" and digests is not None:
                return "접수 시 없던 checkpoint/view 산출물이 생겼습니다"
            if cp["status"] == "ok" and digests != cp["value"]:
                return "접수 이후 checkpoint/view/완료 청크 digest가 바뀌었습니다"
            runs = obs["runs"]
            now_runs = [r["id"] for r in self.store.runs(b["id"])[:20]]
            if (runs["status"] == "missing") != (not now_runs) or (runs["status"] == "ok" and now_runs != [r["id"] for r in runs["value"]]):
                return "접수 이후 새 실행(run) 기록이 생겼습니다"
        except GitTransient:
            raise
        except Exception as e:
            return f"보존 증명 중 조회 실패: {e}"
        return None

    def approved_integration_receipt(self, b, base: str, head: str, site: str, remote_expected) -> dict | None:
        """Proof, at the moment of rejection, that `head` is this batch's approved integration: the existing same-batch
        RELEASED receipt + ancestry proof, the remote branch still where the baseline recorded it, and a clean worktree.
        None (any doubt or error): the caller keeps its plain rejection."""
        try:
            wt = Path(b["worktree"])
            for d in self.store.defects(("RELEASED",)):
                if d["batch_id"] != b["id"] or d["integrated_sha"] != head:
                    continue
                if not self._released_integration_proof(b, base, head, d):
                    continue
                if self.sup.git.remote_head(b["branch"]) != remote_expected or self.sup.git.dirty(wt).strip():
                    return None
                return {"defect_id": d["id"], "base": base, "head": head, "site": site,
                        "merge_sha": d["merge_sha"], "remote_head": remote_expected}
        except Exception:
            return None
        return None

    @staticmethod
    def _evidence_keys(b) -> list[str]:
        """The only kv entries an incident bundle may carry: explicit per method (no `*_{bid}` sweep)."""
        bid = b["id"]
        extra = f"error_evidence_{bid}_{b['error_seq']}"
        if b["method"] == "d":
            return [f"d_base_head_{bid}", f"d_commit_head_{bid}", dchunk.run_start_key(bid), extra]
        if b["method"] == "c":
            return [literary.run_start_key(bid), f"c_commit_head_{bid}", extra]
        if b["method"] == STAGE2_METHOD:
            return [stage2.run_start_key(bid), stage2.links_start_key(bid), stage2.repair_run_start_key(bid),
                    f"s2_commit_head_{bid}", extra]
        return [stage3.run_start_key(bid), stage3.parallel_start_key(bid), f"s3_commit_head_{bid}", extra]

    @staticmethod
    def _envelope_of(d):
        try:
            return defects.parse_incident(d["report"].partition("\n")[0])
        except defects.ReportProblem:
            return None

    def _bundle_git(self, ob, owt: Path) -> dict:
        """Observed Git facts with the same ok/missing/unknown meaning as the envelope; never raises."""
        if not owt.is_dir():
            return {"worktree": str(owt), "status": "missing"}
        try:
            return {"worktree": str(owt), "status": "ok", "head": self.sup.git.head(owt),
                    "remote_head": self.sup.git.remote_head(ob["branch"])}
        except Exception as e:
            return {"worktree": str(owt), "status": "unknown", "error": str(e)[:200]}

    def write_incident_evidence(self, b) -> str | None:
        """Atomically write the local evidence bundle of each incident Issue this Maintainer execution works on, BEFORE
        the AI starts. Returns a problem text (the Maintainer must not start) or None."""
        try:
            n = int(b["batch"])
            wt = Path(b["worktree"])
            linked = [d for d in self.store.defects(("LINKED",)) if d["source"] == "incident" and d["issue_number"] == n]
            if not linked:
                return None
            if self.store.get(f"m_base_head_{b['id']}") is None:
                self.store.set(f"m_base_head_{b['id']}", self.sup.git.head(wt))
            for d in linked:
                ob = self.store.batch(d["batch_id"])
                if (ob is None or ob["state"] != "PAUSED" or ob["pause_reason"] != "shared_defect"
                        or ob["defect_id"] != d["id"]):
                    return f"장애 증거 소유 확인 실패: 원 배치가 이 incident #{d['id']}로 PAUSED 상태가 아닙니다. Maintainer를 시작하지 않습니다"
                owt = Path(ob["worktree"])
                data = {
                    "defect": {"id": d["id"], "event_key": d["event_key"], "class": d["defect_class"]},
                    "batch": {k: ob[k] for k in ob.keys() if k != "log_file"},
                    "events": [{"ts": e["ts"], "level": e["level"], "msg": e["msg"][:500]}
                               for e in self.store.batch_events(ob["id"])[-50:]],
                    "runs": [{"id": r["id"], "kind": r["kind"], "log_file": r["log_file"], "exit_status": r["exit_status"]}
                             for r in self.store.runs(ob["id"])[:20]],
                    "kv": {k: (self.store.get(k) or "")[:2000] for k in self._evidence_keys(ob) if self.store.get(k) is not None},
                    "envelope": self._envelope_of(d),
                    "git": self._bundle_git(ob, owt),
                    "receipts": [{"defect_id": x["id"], "merge_sha": x["merge_sha"], "integrated_sha": x["integrated_sha"]}
                                 for x in self.store.defects(("RELEASED",)) if x["batch_id"] == ob["id"]],
                    "db": {"path": str(self.store.path), "example": f"sqlite3 -readonly '{self.store.path}' "
                           f"'select * from events where batch_id={ob['id']} order by id desc limit 50'"},
                }
                out = wt / ".warroom-scratch" / "incident" / f"{d['id']}.json"
                out.parent.mkdir(parents=True, exist_ok=True)
                tmp = out.with_suffix(".json.tmp")
                tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1, default=str), "utf-8")
                os.replace(tmp, out)
        except Exception as e:
            return f"장애 증거 묶음을 작성하지 못해 Maintainer를 시작하지 않습니다: {e}"
        return None

    def finish_diagnosis(self, b) -> bool:
        """A Maintainer that exited 0 without a PR is accepted ONLY as a documented diagnosis-only result: valid
        diagnosis file + marked Issue comment, no commit, no remote branch, clean worktree. The proof is persisted
        BEFORE anything is removed (`m_diag_<id>`); `_complete_diagnosis` then removes the worktree without force and
        completes everything in one transaction, and can be re-entered after a crash. False: a condition is missing ->
        the caller keeps the existing ERROR."""
        key = f"m_diag_{b['id']}"
        if self.store.get(key) is not None:
            return self._complete_diagnosis(b)
        try:
            n, wt, git = int(b["batch"]), Path(b["worktree"]), self.sup.git
            linked = [d for d in self.store.defects(("LINKED",)) if d["source"] == "incident" and d["issue_number"] == n]
            base = self.store.get(f"m_base_head_{b['id']}")
            if not linked or not base or b["pr_number"]:
                return False
            data = json.loads((wt / self.DIAGNOSIS_FILE).read_text("utf-8"))
            if (not isinstance(data, dict) or data.get("version") != 1 or data.get("issue") != n
                    or data.get("outcome") not in self.DIAGNOSIS_OUTCOMES
                    or set(data) - {"version", "issue", "outcome", "summary", "recurrence_of", "evidence"}):
                return False
            if data["outcome"] == "recurrence" and not self._recurrence_verified(linked[0], data.get("recurrence_of")):
                data["outcome"] = "undetermined"   # an unverified recurrence claim is held like any undetermined cause
            ev = f"incident-diagnosis-{n}"
            if not any((defects.EVENT_MARK, ev) in defects.markers(c.get("body")) for c in self.sup.gh.issue_comments(n)):
                return False
            if (git.head(wt) != base or git.registered(wt) != b["branch"] or git.remote_head(b["branch"]) is not None
                    or git.dirty(wt).strip() or self.sup.gh.prs_for_branch(b["branch"])):
                return False
            self.store.set(key, json.dumps({"issue": n, "outcome": data["outcome"], "base": base, "branch": b["branch"],
                                            "worktree": str(wt)}, sort_keys=True))
        except Exception:
            return False
        return self._complete_diagnosis(b)

    def _recurrence_verified(self, d, claimed) -> bool:
        """The Maintainer's `recurrence_of` must name a RELEASED incident of the SAME batch that the envelope listed."""
        env = self._envelope_of(d)
        if env is None or type(claimed) is not int:
            return False
        listed = {p.get("defect_id") for p in env["prior_incidents"]}
        prior = self.store.defect(claimed)
        return (claimed in listed and prior is not None and prior["state"] == "RELEASED" and prior["source"] == "incident"
                and prior["batch_id"] == d["batch_id"])

    def _complete_diagnosis(self, b) -> bool:
        """Idempotent second half: non-force worktree removal, then ONE transaction. True: handled (done or retried later)."""
        try:
            m = json.loads(self.store.get(f"m_diag_{b['id']}"))
            if m["branch"] != b["branch"] or m["worktree"] != b["worktree"] or m["issue"] != int(b["batch"]):
                raise ValueError("진단 종료 표식이 이 Maintainer 실행과 다릅니다")
            self.sup.git.remove_diagnosis_worktree(Path(m["worktree"]), m["branch"], m["base"])
        except Exception as e:
            if self._due(f"m_diag_retry_{b['id']}", 60):
                self.store.log(b["id"], f"진단 종료 정리를 완료하지 못했습니다(소유 worktree 보존, 재시도 예정): {e}", "warn")
            return True
        why = f"진단만 종료({m['outcome']}): 코드 수정 PR 없음 — 운영자 확인 필요, 자동 재개하지 않음"
        self.store.complete_diagnosis(b["id"], m["issue"], why)
        self.store.finish_runs(b["id"], None)
        self.store.log(b["id"], f"Issue #{m['issue']}: {why}; Maintainer worktree 정리·슬롯 반환")
        return True

    def _resume_diagnoses(self) -> None:
        """A restart between the persisted proof and the transaction finishes the same diagnosis, never a second one."""
        for m in self.store.maintenance_rows():
            if m["state"] != "ACTIVE" or m["batch_id"] is None:
                continue
            b = self.store.batch(m["batch_id"])
            if b is not None and b["state"] != "COMPLETE" and self.store.get(f"m_diag_{b['id']}") is not None:
                self._complete_diagnosis(b)

    # ---- applying a merged incident fix (Issue #3349) -------------------------------------------------------------
    # Two proofs, never mixed: RUNTIME-ONLY (the fix lives in War Room's own code/prompts: the worktree is not touched,
    # `integrated_sha` stays NULL and `applied_code_sha` says which checkout carried it) and WORKTREE INTEGRATION (the fix
    # reaches the production worktree; the run baseline moves to the integrated HEAD in the release transaction itself).
    # Whatever cannot be proven is HELD with its reason and the batch stays PAUSED.
    class _Shim:
        """The two lookups a parallel guard takes from its per-round object, answered fresh (pure queries)."""

        def __init__(self, maint, b):
            self.maint, self.b = maint, b

        def remote(self):
            return self.maint.sup.git.remote_head(self.b["branch"])

        def pr(self):
            return self.maint.sup._find_recovery_pr(self.b)

    def _hold_unprovable(self, d, b, why: str) -> None:
        self._hold(d, b, f"재개 증명 불가: {b['run_kind'] or b['paused_from']}: {why}")

    def _release_incident(self, d, b) -> None:
        if self.store.get(f"stop_pin_{b['producer']}_{b['method']}") or self.store.clear_request(b["producer"], b["method"]):
            return   # the operator's Stop / Clear decides; the release transaction re-checks them as well
        try:
            files = self.sup.git.changed_files(d["merge_sha"])
        except Exception as e:
            return self.store.log(b["id"], f"수정 변경 파일 조회 실패(재시도 예정): {e}", "warn")
        env = self._envelope_of(d)
        if not files:
            return self._hold_unprovable(d, b, "수정 PR의 변경 파일을 확인할 수 없습니다")
        if env is None:
            return self._hold_unprovable(d, b, "접수 시 관측값(envelope)이 없는 이전 형식의 incident입니다")
        runtime = (all(f.startswith("tools/warroom/") for f in files)
                   and any(f.startswith(("tools/warroom/warroom/", "tools/warroom/prompts/")) for f in files))
        if runtime and self._runtime_not_ready(d, b, files):
            return
        if not self._due(f"defect_release_try_{d['id']}"):
            return
        if runtime:
            return self._release_runtime(d, b, env)
        return self._release_worktree(d, b, env)

    def _runtime_not_ready(self, d, b, files) -> bool:
        """True = wait (restart / checkout not yet carrying the fix) or held. Python: the loaded code_sha; prompts: the
        main checkout has them clean AND the resumed launch actually renders the changed prompt."""
        if any(f.startswith("tools/warroom/warroom/") for f in files) and self._fix_not_loaded(d):
            return True
        prompt_files = [f for f in files if f.startswith("tools/warroom/prompts/")]
        if not prompt_files:
            return False
        try:
            carried = self.sup.git.is_ancestor(d["merge_sha"], self.sup.git.head(self.sup.code_root), path=self.sup.code_root)
            clean = self.sup.prompt_checkout_clean(prompt_files)
        except Exception as e:
            carried, clean = False, False
            self.store.log(b["id"], f"프롬프트 반영 여부 조회 실패: {e}", "warn")
        if not (carried and clean):
            key = f"restart_needed_{d['id']}"
            if self.store.get(key) is None:
                self.store.set(key, "1")
                self.store.log(b["id"], f"수정 {d['merge_sha'][:10]}이 프롬프트를 바꿨지만 메인 checkout이 아직 이를 포함·clean 상태가 "
                               "아닙니다 — checkout 반영 전에는 배치를 재개하지 않습니다(프로세스 재시작은 필요 없음)", "error")
            return True
        names = self.sup.resume_prompt_names(b)
        changed = {Path(f).stem for f in prompt_files if f.endswith(".md")}
        if names is None:
            self._hold_unprovable(d, b, "재개될 launch의 prompt 집합을 정할 수 없어 수정 prompt의 전달을 증명할 수 없음")
            return True
        if not changed <= names:
            self._hold_unprovable(d, b, f"수정 prompt가 재개 실행에 전달되지 않음 (수정 {sorted(changed)} / 재개 {sorted(names)})")
            return True
        return False

    def _pr_state_problem(self, b) -> str | None:
        """WAITING_REVIEW / MERGED / CLEANUP: the PR and its ownership are read again before anything resumes."""
        pf = b["paused_from"]
        if pf not in ("WAITING_REVIEW", "MERGED", "CLEANUP"):
            return None
        if not b["pr_number"]:
            return f"{pf} 배치에 PR 번호가 없습니다"
        info = self.sup.gh.pull(b["pr_number"])
        if info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]:
            return f"PR #{b['pr_number']}의 번호 또는 head 브랜치가 소유 기록과 다릅니다"
        if pf == "WAITING_REVIEW":
            if info.get("merged"):
                return None   # the existing merged path takes over after the resume
            if info.get("state") != "open":
                return f"PR #{b['pr_number']}이 머지 없이 닫혀 있어 재개하지 않습니다"
            if info.get("head_sha") != b["head_sha"]:
                return f"PR #{b['pr_number']} HEAD가 기록값과 다릅니다"
            return None
        return None if info.get("merged") is True else f"PR #{b['pr_number']}의 merged=true를 확인하지 못했습니다"

    def _release_runtime(self, d, b, env) -> None:
        if why := self._preserved(b, env["observed"], head_moves=False):
            return self._hold_unprovable(d, b, why)
        if why := self._pr_state_problem(b):
            return self._hold_unprovable(d, b, why)
        code_root = self.sup.code_root
        problem = self._verify(d, code_root)   # the fix runs from the code checkout, never inside the production worktree
        if problem:
            return self._hold_unprovable(d, b, f"수정 반영 후 필수 검증 실패: {problem}")
        if not self._archive_report(d, b):
            return
        applied = self.sup.git.head(code_root)
        if self.store.release_defect(d["id"], b["id"], None, None, force_run=False, fix_kind="runtime", applied_code_sha=applied):
            self.store.log(b["id"], f"공통 수정 {d['merge_sha'][:10]} runtime 반영 확인(code {applied[:10]}, worktree 통합 없음) → "
                           f"{b['paused_from'] or 'PRODUCING'}부터 자동 Retry 1회")

    def _resume_kind(self, b) -> str | None:
        """The run_kinds whose resume guard can be run BEFORE the release (None = no such guard: the integration is held)."""
        k, m = b["run_kind"] or "", b["method"]
        if k.startswith("fix_") and b["pr_number"] and b["paused_from"] == "FIXING":
            return "fix"
        if m == dchunk.METHOD:
            return "d_parallel" if k == "d_parallel" else ("d_serial" if self._serial_d(b) else None)
        if m == literary.METHOD:
            return "c_parallel" if k == "c_parallel" else ("c_serial" if self._serial_c(b) else None)
        if m == STAGE2_METHOD:
            return ("s2_chunk" if k.startswith("s2_chunk_") else "s2_links" if k in ("s2_links_new", "s2_links_fix")
                    else "s2_repair" if k == "s2_repair_new" else None)
        if m == STAGE3_METHOD:
            return "s3_chunk" if k.startswith("s3_chunk_") else None
        return None

    def _first_head(self, b, kind: str) -> str | None:
        """The FIRST recorded HEAD of the batch's current baseline chain (never rewritten by this module)."""
        if kind.startswith("d_"):
            return self.store.get(f"d_base_head_{b['id']}")
        if kind.startswith("c_"):
            return literary.checkpoint_head(Path(b["worktree"]), b)
        key = {"s2_links": stage2.links_start_key, "s2_repair": stage2.repair_run_start_key,
               "s3_chunk": stage3.run_start_key}.get(kind, stage2.run_start_key)(b["id"])
        try:
            return json.loads(self.store.get(key) or "null")["head"]
        except (ValueError, KeyError, TypeError):
            return None

    def _prerun_guards(self, b, kind: str, base: dict, pending: dict) -> str | None:
        """Run the resume guards of this run_kind as PURE queries against the proposed baseline. None = they all pass."""
        sup, wt = self.sup, Path(b["worktree"])
        shim = self._Shim(self, b)
        if kind == "d_parallel":
            return sup._d_parallel_head_problem(b, wt, base, pending) or sup.dp._boundary_problem(b, shim, base)
        if kind == "d_serial":
            return sup._d_head_problem(b, wt, base, pending) or sup._stage2_chunk_boundary_problem(b, None, base)
        if kind == "c_parallel":
            return sup._c_head_problem(b, wt, base, pending) or sup.cp._boundary_problem(b, shim, base)
        if kind == "c_serial":
            return sup._c_head_problem(b, wt, base, pending) or sup._stage2_chunk_boundary_problem(b, None, base)
        if kind == "s2_chunk":
            return sup._stage2_chunk_boundary_problem(b, None, base)
        if kind == "s2_links":
            return sup._stage2_links_boundary_problem(b, base)
        if kind == "s2_repair":
            return sup._stage2_repair_boundary_problem(b, base)
        if kind == "s3_chunk":
            return sup._stage3_chunk_boundary_problem(b, base)
        return "사전 실행할 guard가 없습니다"

    def _release_worktree(self, d, b, env) -> None:
        wt = Path(b["worktree"])
        kind = self._resume_kind(b)
        if b["paused_from"] in ("WAITING_REVIEW", "MERGED", "CLEANUP"):
            return self._hold_unprovable(d, b, "완료·리뷰·정리 단계의 배치는 worktree에 통합하지 않습니다(runtime-only 수정만 재개 가능)")
        if not wt.is_dir():
            return self._hold_unprovable(d, b, "worktree가 없어 통합할 수 없습니다(runtime-only 수정만 재개 가능)")
        if kind is None:
            return self._hold_unprovable(d, b, "이 단계는 재개 guard를 사전에 실행해 증명할 수 없습니다")
        if self._fix_not_loaded(d):
            return
        old_first = self._first_head(b, kind) if kind != "fix" else None
        if kind != "fix" and not old_first:
            return self._hold_unprovable(d, b, "최초 기준 HEAD를 확인할 수 없습니다")
        if why := self._preserved(b, env["observed"], head_moves=True):
            return self._hold_unprovable(d, b, why)
        head, run_start = self._apply(d, b)
        if head is None:
            return
        if kind == "fix":
            pairs = []
        else:
            pending = self._fix_merged_integration_proof(b, d, old_first, head)
            if pending is None:
                return self._hold_unprovable(d, b, "수정 통합 HEAD를 FIX_MERGED 상태에서 직접 증명하지 못했습니다")
            moved = self._retargeted_run_start(b, head)
            if moved is None:
                return self._hold_unprovable(d, b, "원래 실행 기준을 통합 HEAD에 안전하게 재결속할 수 없습니다")
            if problem := self._prerun_guards(b, kind, json.loads(moved[1]), pending):
                return self._hold_unprovable(d, b, f"재개 guard 사전 검증 실패: {str(problem)[:300]}")
            pairs = [moved]
        if not self._archive_report(d, b):
            return
        if self.store.release_defect(d["id"], b["id"], head, pairs, force_run=False, fix_kind="worktree"):
            self.store.log(b["id"], f"공통 수정 {d['merge_sha'][:10]} worktree 통합·검증·guard 사전 확인 완료 (HEAD {head[:10]}) → "
                           f"{b['paused_from'] or 'PRODUCING'}부터 자동 Retry 1회")

    def _fix_not_loaded(self, d) -> bool:
        """Fail closed: a fix that changed the Supervisor's own code is applied only when the running process PROVABLY
        loaded it. Unknown (no recorded code_sha, dirty runtime source, a failed lookup) waits."""
        try:
            runtime = any(f.startswith("tools/warroom/warroom/") for f in self.sup.git.changed_files(d["merge_sha"]))
            if not runtime:
                return False
            code = getattr(self.sup, "code_sha", None)
            if code and self.sup.git.is_ancestor(d["merge_sha"], code, path=self.sup.code_root):
                return False
            reason = "실행 중인 코드 SHA를 증명할 수 없거나 수정이 포함되지 않았습니다"
        except Exception as e:
            reason = f"로드 여부를 확인하지 못했습니다: {e}"
        key = f"restart_needed_{d['id']}"
        if self.store.get(key) is None:
            self.store.set(key, "1")
            self.store.log(d["batch_id"], f"수정 {d['merge_sha'][:10]}이 Supervisor 코드를 바꿨지만 {reason} — "
                           "Supervisor 재시작 필요, 증명되기 전에는 배치를 재개하지 않습니다", "error")
        return True

    def _report_outcomes(self) -> None:
        """Say on the Issue where an incident batch actually is, one comment per phase with its own marker: diagnosis
        result (HELD), fix applied (runtime / worktree), review (intermediate), complete (final), stopped. A merged fix
        or an opened PR is not the final result."""
        for d in self.store.defects(("HELD",)):
            if d["source"] != "incident" or not d["issue_number"] or not d["hold_reason"]:
                continue
            key = f"incident_outcome_{d['id']}_diagnosis"
            ev = f"incident-outcome-{d['id']}-diagnosis"
            if not self.store.get(key) and self._comment_once(
                    d["issue_number"], ev, f"진단/보류 결과: {defects.public(d['hold_reason'])[:500]} — 배치는 PAUSED로 보존됩니다.\n\n"
                    + defects.marker(defects.EVENT_MARK, ev)):
                self.store.set(key, "1")
        for d in self.store.defects(("RELEASED",)):
            if d["source"] != "incident" or not d["issue_number"]:
                continue
            b = self.store.batch(d["batch_id"])
            if b is None:
                continue
            phases = []
            if d["fix_kind"] in ("runtime", "worktree"):
                phases.append("applied")
            phases.append({"WAITING_REVIEW": "review", "COMPLETE": "complete", "ERROR": "stopped-error",
                           "PAUSED": "stopped-paused"}.get(b["state"]))
            for phase in phases:
                if phase is None:
                    continue
                key = f"incident_outcome_{d['id']}_{phase}"
                if self.store.get(key):
                    continue
                ev = f"incident-outcome-{d['id']}-{phase}"
                pr = f" · PR #{b['pr_number']}" if b["pr_number"] else ""
                if phase == "applied":
                    head = (f"수정 {(d['merge_sha'] or '')[:10]}가 반영·확인되어 원 배치 `{b['shard']}_{b['batch']}`를 한 번 재개했습니다 "
                            + (f"(runtime-only: worktree 통합 없음, code {(d['applied_code_sha'] or '?')[:10]})." if d["fix_kind"] == "runtime"
                               else f"(worktree 통합 HEAD {(d['integrated_sha'] or '?')[:10]}). 아직 완료가 아닙니다."))
                elif phase == "review":
                    head = f"원 배치 `{b['shard']}_{b['batch']}`가 PR 리뷰 대기에 들어갔습니다{pr}. 아직 완료가 아닙니다."
                elif phase == "complete":
                    head = f"원 배치 `{b['shard']}_{b['batch']}`가 COMPLETE에 도달했습니다{pr}."
                else:
                    why = b["pause_reason"] or ""
                    head = (f"원 배치 `{b['shard']}_{b['batch']}`가 {b['state']}로 중단되었습니다{pr} "
                            f"{('(' + why + ') ') if why else ''}— 작업물은 보존됩니다. 오류: {defects.public(b['error'] or '')[:300]}")
                if self._comment_once(d["issue_number"], ev, head + "\n\n" + defects.marker(defects.EVENT_MARK, ev)):
                    self.store.set(key, "1")

    def _archive_report(self, d, b) -> bool:
        """Set the RESOLVED report aside so the resumed producer does not read it as an unresolved stop signal.

        Only the exact file of this defect event moves (to `.warroom-scratch/resolved-defects/`); a report whose content
        changed since is new evidence and stays. False: the move failed (retried on the next tick, batch stays PAUSED).
        """
        # A parallel Stage 2 task writes its own report file; that exact file is the one set aside.
        f = Path(b["worktree"]) / (self.store.get(f"s2_defect_path_{b['id']}") or defects.REPORT_FILE)
        try:
            raw = f.read_text("utf-8", errors="replace")
        except FileNotFoundError:
            # The primary file may already be set aside by an interrupted earlier attempt: still finish its twins.
            try:
                self._archive_twins(d, b, f, d["event_key"].split(":after:")[0])
            except OSError as e:
                self.store.log(b["id"], f"해결된 공통 결함의 동일 보고서 보관 실패로 재개를 미룹니다(재시도 예정): {e}", "warn")
                return False
            return True
        except OSError as e:
            self.store.log(b["id"], f"해결된 공통 결함 보고서를 읽지 못해 재개를 미룹니다(재시도 예정): {e}", "warn")
            return False
        base = defects.report_event_key(b["id"], raw)
        if d["event_key"] != base and not d["event_key"].startswith(base + ":after:"):
            return True   # a different (changed) report: new evidence, left for the normal report scan
        dest = f.parent / "resolved-defects" / f"defect-{d['id']}.json"
        try:
            dest.parent.mkdir(parents=True, exist_ok=True)
            f.replace(dest)
            self._archive_twins(d, b, f, base)
        except OSError as e:
            self.store.log(b["id"], f"해결된 공통 결함 보고서 보관 실패로 재개를 미룹니다(재시도 예정): {e}", "warn")
            return False
        self.store.log(b["id"], f"해결된 공통 결함 #{d['id']} 보고서를 {dest.relative_to(b['worktree'])}로 보관")
        self.store.delete(f"s2_defect_path_{b['id']}")
        return True

    def _archive_twins(self, d, b, f: Path, base: str) -> None:
        """Another task of the same parallel batch may have written the identical report: it is the same resolved event
        and must not come back as a recurrence after the fix, so it is set aside with its twin (idempotent, OSError retries)."""
        for other in self.sup._task_report_files(b):
            twin = Path(b["worktree"]) / other
            if twin != f and twin.is_file() and defects.report_event_key(
                    b["id"], twin.read_text("utf-8", errors="replace")) == base:
                (twin.parent / "resolved-defects").mkdir(parents=True, exist_ok=True)
                twin.replace(twin.parent / "resolved-defects" / f"defect-{d['id']}-{twin.stem}.json")

    def resolved_note(self, b, short: bool = False) -> str:
        """Evidence-backed context: defects of this batch whose merged fix was applied and verified (RELEASED)."""
        done = [d for d in self.store.defects(("RELEASED",)) if d["batch_id"] == b["id"]]
        if not done:
            return ""
        refs = ", ".join(f"#{d['id']}(`{d['defect_class']}`, 수정 {d['merge_sha'][:10]}, 반영 {('HEAD ' + d['integrated_sha'][:10]) if d['integrated_sha'] else 'runtime ' + (d['applied_code_sha'] or '?')[:10]})"
                         for d in done)
        if short:
            return (f"이 배치는 공통 결함 {refs}의 수정이 반영·검증된 뒤 재개된 실행입니다. 재개된 AI가 이미 해결된 보고서 "
                    "때문에 멈췄는지 로그를 확인하세요 (같은 보고서로는 자동 재시작하지 않음).")
        return ("이 배치가 이전에 보고한 공통 결함 " + refs + "은(는) 수정이 머지되어 이 worktree HEAD에 반영·검증되었다 "
                "(War Room이 해당 보고서를 `.warroom-scratch/resolved-defects/`로 보관했다). 그 보고서를 미해결 오류로 "
                "취급하거나 그것 때문에 멈추지 말고, 수정된 CLI로 실패했던 단계(예: `export`)를 다시 실행해 남은 작업을 계속하라. "
                "수정 후에도 같은 결함이 실제로 재현되거나 새로운 결함이 확인되면 그때는 새 증거로 `shared-defect.json`을 "
                "다시 작성해 보고하고 멈춘다.\n")

    def _apply(self, d, b) -> tuple[str, tuple[str, str] | None]:
        wt, git = Path(b["worktree"]), self.sup.git
        initial_pr = None
        batch_head = None
        if b["pr_number"]:   # an existing PR: the worktree must still be exactly what the PR holds
            initial_pr = self.sup.gh.pull(b["pr_number"])
            if initial_pr.get("number") != b["pr_number"]:
                raise IntegrationBlocked(f"조회한 PR 번호가 배치 소유 PR #{b['pr_number']}과 다릅니다")
            if initial_pr.get("merged") or initial_pr.get("state") != "open":
                raise IntegrationBlocked(f"PR #{b['pr_number']}이 더 이상 열려 있지 않습니다 "
                                         f"(state={initial_pr.get('state')}, merged={initial_pr.get('merged')})")
            if initial_pr.get("head_ref") != b["branch"]:
                raise IntegrationBlocked(f"PR #{b['pr_number']}의 head 브랜치 {initial_pr.get('head_ref')!r}가 "
                                         "소유 브랜치와 다릅니다")
            batch_head = b["head_sha"]
            local = git.head(wt)
            pr_head = initial_pr.get("head_sha")
            if not isinstance(pr_head, str) or not re.fullmatch(r"[0-9a-f]{40}", pr_head):
                raise IntegrationBlocked(f"PR #{b['pr_number']} HEAD가 유효한 commit SHA가 아닙니다")
            if local != pr_head and not git.contains(wt, pr_head):
                raise IntegrationBlocked(f"로컬 HEAD {local[:10]}가 PR HEAD {pr_head[:10]}를 포함하지 않습니다 "
                                         "(HEAD 불일치)")
        head = git.integrate(wt, b["branch"], self.cfg["base_branch"], d["merge_sha"])
        if not git.contains(wt, d["merge_sha"]):   # proof by the commit actually applied, not by the Issue/PR state
            raise IntegrationBlocked("수정 commit이 배치 HEAD에 포함된 것을 확인하지 못했습니다")
        problem = self._verify(d, wt)
        if problem:
            raise IntegrationBlocked(f"수정 반영 후 필수 검증 실패: {problem}")
        run_start = None
        if initial_pr is not None:
            try:
                protected = self.sup._pr_protected_paths(b, initial_pr)
            except (FastForwardBlocked, GitError) as e:
                raise IntegrationBlocked(f"기존 PR의 보호 산출물 소유권을 확인할 수 없습니다: {e}") from e
            if b["method"] == STAGE3_METHOD and b["run_kind"] == "s3_finalize":
                run_start = self._retargeted_run_start(b, head, completed_pr_head=initial_pr["head_sha"])
                if run_start is None:
                    raise IntegrationBlocked("완료된 Stage 3 PR의 원래 finalize 기준을 승인된 최신 PR HEAD에 "
                                             "안전하게 재결속할 수 없어 push를 중단합니다")
            head = self._sync_approved_integration(b, d, initial_pr, batch_head, head, protected)
        return head, run_start

    def _sync_approved_integration(self, b, d, initial_pr, batch_head: str, integrated_head: str,
                                   protected_paths: set[str]) -> str:
        """Sync an approved fix to this exact open PR before releasing its one automatic Retry."""
        number, branch, wt = b["pr_number"], b["branch"], Path(b["worktree"])
        allowed_heads = {batch_head, integrated_head}

        def recheck(expected_head: str) -> None:
            current_batch = self.store.batch(b["id"])
            if (current_batch is None or current_batch["state"] != "PAUSED"
                    or current_batch["pause_reason"] != "shared_defect"
                    or current_batch["defect_id"] != d["id"] or self._workers_running(current_batch)
                    or current_batch["pr_number"] != number or current_batch["branch"] != branch
                    or Path(current_batch["worktree"]) != wt or current_batch["head_sha"] != batch_head):
                raise IntegrationBlocked("동기화 직전 batch/AI/PR 소유 상태가 바뀌었습니다")
            if self.store.get(f"defect_hold_{b['id']}"):
                raise GitTransient("운영자 Stop이 대기 중이므로 PR 동기화와 자동 재개를 미룹니다")

            info = self.sup.gh.pull(number)
            if info.get("number") != number or info.get("head_ref") != branch:
                raise IntegrationBlocked(f"PR #{number}의 repo 또는 소유 head 브랜치가 바뀌었습니다")
            if info.get("state") != "open" or info.get("merged"):
                raise IntegrationBlocked(f"PR #{number}가 동기화 중 open 상태를 벗어났습니다")
            current_head = info.get("head_sha")
            if not isinstance(current_head, str) or not re.fullmatch(r"[0-9a-f]{40}", current_head):
                raise IntegrationBlocked(f"PR #{number} HEAD가 유효한 commit SHA가 아닙니다")
            if current_head != expected_head:
                if current_head in allowed_heads and expected_head in allowed_heads:
                    raise GitTransient(f"PR #{number} API가 동기화 HEAD를 아직 반영하지 않았습니다 "
                                        f"({expected_head} / {current_head})")
                raise IntegrationBlocked(f"PR #{number} HEAD가 승인 통합과 다른 commit으로 이동했습니다 "
                                         f"({expected_head} / {current_head})")

        try:
            return self.sup.git.push_approved_maintainer_integration(
                wt, branch, initial_pr["head_sha"], batch_head, d["merge_sha"], protected_paths,
                recheck=recheck)
        except FastForwardBlocked as e:
            raise IntegrationBlocked(str(e)) from e

    def _verify(self, d, wt: Path) -> str | None:
        """Required verification of the merged fix, derived from what its PR changed. None = verified.

        Supported regression files run: every changed `*.test.mjs` (`node --test`) and War Room's Python suite
        (`tools/warroom/tests/*.py` -> `node tools/warroom/run-tests.mjs`). Configured `shared_defect_verify` commands
        always run. Fail closed: a fix that changed a test of a kind this cannot run (and no configured command covers
        it), or code with no runnable verification at all, is NOT verified (documentation/prompt-only fixes need only the ancestry proof).
        """
        files = self.sup.git.changed_files(d["merge_sha"])
        if not files:
            return "수정 PR의 변경 파일을 확인할 수 없어 필수 검증을 정할 수 없습니다"
        node_tests = sorted(f for f in files if _NODE_TEST.fullmatch(f) and (wt / f).is_file())
        py_tests = [f for f in files if _PY_TEST.fullmatch(f) and (wt / f).is_file()]
        cmds = ([["node", "--test", *node_tests]] if node_tests else [])
        cmds += ([["node", "tools/warroom/run-tests.mjs"]] if py_tests else [])
        cmds += [list(c) for c in self.cfg["shared_defect_verify"]]
        unsupported = [f for f in files if _TESTISH.search(f) and f not in node_tests and f not in py_tests
                       and not _SUPPORT_FILE.search(f)]
        if unsupported and not self.cfg["shared_defect_verify"]:   # configured commands are the operator's own verification
            return f"지원하지 않는 종류의 회귀 테스트가 변경되어 검증할 수 없습니다: {', '.join(unsupported[:5])} (shared_defect_verify 설정 필요)"
        if not cmds and not all(_DOC.search(f) for f in files):
            return ("수정 PR이 코드를 바꿨지만 실행할 수 있는 필수 검증이 없습니다 "
                    "(변경된 tests/*.test.mjs 또는 tools/warroom/tests/*.py 없음, shared_defect_verify 미설정)")
        for argv in cmds:
            r = self.sup.runner.run(argv, cwd=wt, env=self.sup.env, timeout=VERIFY_TIMEOUT)
            if not r.ok:
                return f"`{' '.join(argv)[:200]}` 종료 코드 {r.code}: {(r.err or r.out).strip()[-400:]}"
        return None

    def _hold(self, d, b, why: str) -> None:
        """Fail closed: the batch stays PAUSED with everything preserved, the reason is shown, no automatic Retry."""
        self.store.update_defect(d["id"], state="HELD", hold_reason=why)
        self.store.update(b["id"], error=f"공통 수정 반영 보류: {why}")
        self.store.log(b["id"], f"공통 수정 반영 보류(자동 Retry 안 함, 작업물 보존): {why}", "error")
