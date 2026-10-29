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
import re
from pathlib import Path

from . import auth, defects, stage2
from .config import maintainer_id, maintainer_problem
from .gitops import GitError, IntegrationBlocked
from .store import MAINTENANCE_METHOD, STAGE2_METHOD

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
        for fn in (self._publish, self._publish_issue_requests, self._start, self._track, self._release):
            try:
                fn()
            except Exception as e:   # GitHub/git trouble never stops the production Lines; the state is re-read next tick
                self.store.log(None, f"Maintainer {fn.__name__} 예외(재시도 예정): {e}", "warn")

    # ---- reporting (called by the Supervisor when it finds a report) ---------------------------------------------
    def report_issue(self, title: str, body: str, urgent: bool = False, event_key: str = "") -> int:
        """Persist a caller-authored Issue request. Only urgent requests join the existing Maintainer queue."""
        request = self.store.request_issue(event_key, title, body, urgent)
        return request["id"]

    def report(self, b, source: str, event_key: str, raw: str, pr_info: dict | None = None) -> None:
        """Pause `b` for one defect event. A malformed or insufficient report holds the batch for the operator and
        creates no Issue; a valid one is queued for publication. Repeating the same event changes nothing."""
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
            f"공통 결함 `{report['defect_class']}` 보고 — 배치 PAUSED, urgent Issue 등록·수정 반영 대기")
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

    def _find_issue_request(self, request) -> tuple[int | None, list[int]]:
        """Find this event's comment marker or temporary title, never an unrelated matching Issue."""
        expected_marker = self._issue_request_marker(request["event_key"])
        prefix = "<!-- warroom-issue-request:"
        temporary_title = self._issue_request_title(request)
        issues = self.sup.gh.all_issues()
        exact = [i for i in issues if not i.get("pull_request")
                 and i.get("title", "") in (request["title"], temporary_title)
                 and i.get("body", "") == request["body"]]
        matching_numbers = [i["number"] for i in exact]
        try:
            previous_numbers = set(json.loads(request.get("attempt_issue_numbers") or "[]"))
        except (TypeError, ValueError):
            raise RuntimeError("저장된 Issue 생성 기준점이 손상되어 복구 대상을 특정할 수 없습니다")
        same_event = None
        created_with_request_title = []
        for issue in exact:
            comments = self.sup.gh.issue_comments(issue["number"])
            bodies = [c.get("body") or "" for c in comments]
            if any(expected_marker in body for body in bodies):
                same_event = issue["number"]
                break
            if any(prefix in body for body in bodies):
                continue
            if request["state"] == "CREATING" and issue.get("title") == temporary_title:
                created_with_request_title.append(issue["number"])
        if same_event is not None:
            return same_event, matching_numbers
        created_after_snapshot = [number for number in created_with_request_title if number not in previous_numbers]
        if len(created_after_snapshot) > 1 or (not created_after_snapshot and len(created_with_request_title) > 1):
            raise RuntimeError("Issue 생성 응답 유실 후 요청 식별 제목의 후보가 여러 개라 복구 대상이 모호합니다")
        return (created_after_snapshot[0] if created_after_snapshot else
                created_with_request_title[0] if created_with_request_title else None), matching_numbers

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
                    before_create = {}

                    def lookup():
                        number, matching_numbers = self._find_issue_request(request)
                        before_create["matching_numbers"] = matching_numbers
                        return number, False

                    def persist_attempt():
                        if not self.store.prepare_issue_attempt(
                                request["id"], before_create.get("matching_numbers", [])):
                            raise RuntimeError("GitHub Issue 생성 전 기준점을 영속화하지 못했습니다")

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
                number, fresh = self._find_or_create_issue(
                    defects.issue_title(report),
                    defects.issue_body(report, d["event_key"], facts, d["source"]), ["urgent"],
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
        if not d["ok"]:
            return self.store.log(None, "Maintainer 시작 차단: " + "; ".join(d["problems"]), "error")
        issue = self.sup.gh.issue(m["issue_number"])
        if issue["pull_request"] or issue["state"] != "open" or "urgent" not in issue["labels"]:
            self.store.update_maintenance(m["issue_number"], state="HELD", hold_reason=(
                f"Issue #{m['issue_number']}가 열린 urgent Issue가 아닙니다 (state={issue['state']}, "
                f"labels={issue['labels']}) — 수정 PR 없이 닫힌 Issue는 해제 근거가 아닙니다. 운영자 확인 필요."))
            return self.store.log(None, self.store.maintenance(m["issue_number"])["hold_reason"], "error")
        n = m["issue_number"]
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
            if self.store.get(f"defect_hold_{b['id']}") or b["pid"] is not None:
                continue   # operator Stop is pending/active, or the stopped AI is not confirmed gone yet
            if not self._due(f"defect_release_try_{d['id']}"):
                continue
            try:
                head = self._apply(d, b)
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
            if self.store.release_defect(d["id"], b["id"], head, self._retargeted_run_start(b, head)):
                self.store.log(b["id"], f"공통 수정 {d['merge_sha'][:10]} 반영·검증 완료 (HEAD {head[:10]}) → "
                               f"{b['paused_from'] or 'PRODUCING'}부터 자동 Retry 1회")

    def _retargeted_run_start(self, b, new_head: str) -> tuple[str, str] | None:
        """The Stage 2 chunk run-start baseline moved to the approved integrated HEAD, or None (leave it untouched).

        Invariant: the baseline's owned HEAD may only advance to a HEAD that is a verified Maintainer integration of this
        same branch/worktree. The old HEAD must be an ancestor (a plain forward merge) and the remote ref must still be
        what the chunk started with; anything else keeps the old baseline so the boundary check still fails closed.
        """
        if b["method"] != STAGE2_METHOD:
            return None
        key = stage2.run_start_key(b["id"])
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
        except Exception:
            return None
        if base["head"] != new_head:
            base["head"] = new_head
            self.store.log(b["id"], f"승인된 Maintainer 통합으로 Stage 2 청크 Git 경계 기준을 HEAD {new_head[:10]}로 전환했습니다.")
        return key, json.dumps(base, sort_keys=True)

    def adopt_released_baseline(self, b) -> None:
        """Recover a batch released before the baseline was retargeted: only when its HEAD is exactly the HEAD a RELEASED
        defect of this batch integrated (and that integration is still verifiable); any other movement stays a problem."""
        try:
            head = self.sup.git.head(Path(b["worktree"]))
            key = stage2.run_start_key(b["id"])
            raw = self.store.get(key)
            if raw is None or json.loads(raw).get("head") == head:
                return
            for d in self.store.defects(("RELEASED",)):
                if d["batch_id"] == b["id"] and d["integrated_sha"] == head and self.sup.git.contains(Path(b["worktree"]), d["merge_sha"]):
                    moved = self._retargeted_run_start(b, head)
                    if moved:
                        self.store.set(*moved)
                    return
        except Exception:
            return   # unreadable evidence: the unchanged baseline keeps failing closed

    def _archive_report(self, d, b) -> bool:
        """Set the RESOLVED report aside so the resumed producer does not read it as an unresolved stop signal.

        Only the exact file of this defect event moves (to `.warroom-scratch/resolved-defects/`); a report whose content
        changed since is new evidence and stays. False: the move failed (retried on the next tick, batch stays PAUSED).
        """
        f = Path(b["worktree"]) / defects.REPORT_FILE
        try:
            raw = f.read_text("utf-8", errors="replace")
        except FileNotFoundError:
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
        except OSError as e:
            self.store.log(b["id"], f"해결된 공통 결함 보고서 보관 실패로 재개를 미룹니다(재시도 예정): {e}", "warn")
            return False
        self.store.log(b["id"], f"해결된 공통 결함 #{d['id']} 보고서를 {dest.relative_to(b['worktree'])}로 보관")
        return True

    def resolved_note(self, b, short: bool = False) -> str:
        """Evidence-backed context: defects of this batch whose merged fix was applied and verified (RELEASED)."""
        done = [d for d in self.store.defects(("RELEASED",)) if d["batch_id"] == b["id"]]
        if not done:
            return ""
        refs = ", ".join(f"#{d['id']}(`{d['defect_class']}`, 수정 {d['merge_sha'][:10]}, 반영 HEAD {d['integrated_sha'][:10]})"
                         for d in done)
        if short:
            return (f"이 배치는 공통 결함 {refs}의 수정이 반영·검증된 뒤 재개된 실행입니다. 재개된 AI가 이미 해결된 보고서 "
                    "때문에 멈췄는지 로그를 확인하세요 (같은 보고서로는 자동 재시작하지 않음).")
        return ("이 배치가 이전에 보고한 공통 결함 " + refs + "은(는) 수정이 머지되어 이 worktree HEAD에 반영·검증되었다 "
                "(War Room이 해당 보고서를 `.warroom-scratch/resolved-defects/`로 보관했다). 그 보고서를 미해결 오류로 "
                "취급하거나 그것 때문에 멈추지 말고, 수정된 CLI로 실패했던 단계(예: `export`)를 다시 실행해 남은 작업을 계속하라. "
                "수정 후에도 같은 결함이 실제로 재현되거나 새로운 결함이 확인되면 그때는 새 증거로 `shared-defect.json`을 "
                "다시 작성해 보고하고 멈춘다.\n")

    def _apply(self, d, b) -> str | None:
        wt, git = Path(b["worktree"]), self.sup.git
        if b["pr_number"]:   # an existing PR: the worktree must still be exactly what the PR holds
            info = self.sup.gh.pull(b["pr_number"])
            if info["merged"] or info["state"] != "open":
                raise IntegrationBlocked(f"PR #{b['pr_number']}이 더 이상 열려 있지 않습니다 (state={info['state']}, merged={info['merged']})")
            if info["head_ref"] != b["branch"]:
                raise IntegrationBlocked(f"PR #{b['pr_number']}의 head 브랜치 {info['head_ref']!r}가 소유 브랜치와 다릅니다")
            local = git.head(wt)
            if local != info["head_sha"] and not git.contains(wt, info["head_sha"]):
                raise IntegrationBlocked(f"로컬 HEAD {local[:10]}가 PR HEAD {info['head_sha'][:10]}를 포함하지 않습니다 (HEAD 불일치)")
        head = git.integrate(wt, b["branch"], self.cfg["base_branch"], d["merge_sha"])
        if not git.contains(wt, d["merge_sha"]):   # proof by the commit actually applied, not by the Issue/PR state
            raise IntegrationBlocked("수정 commit이 배치 HEAD에 포함된 것을 확인하지 못했습니다")
        problem = self._verify(d, wt)
        if problem:
            raise IntegrationBlocked(f"수정 반영 후 필수 검증 실패: {problem}")
        return head

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
