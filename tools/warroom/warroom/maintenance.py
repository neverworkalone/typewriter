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

import re
from pathlib import Path

from . import auth, defects
from .config import maintainer_id, maintainer_problem
from .gitops import GitError, IntegrationBlocked
from .store import MAINTENANCE_METHOD

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
        for fn in (self._publish, self._start, self._track, self._release):
            try:
                fn()
            except Exception as e:   # GitHub/git trouble never stops the production Lines; the state is re-read next tick
                self.store.log(None, f"Maintainer {fn.__name__} 예외(재시도 예정): {e}", "warn")

    # ---- reporting (called by the Supervisor when it finds a report) ---------------------------------------------
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
    def _split(d) -> tuple[dict, str]:
        text, _, facts = d["report"].partition("\n")
        return defects.parse(text), facts

    # ---- 1. Issue publication (idempotent) --------------------------------------------------------------------
    def _publish(self) -> None:
        for d in self.store.defects(("REPORTED",)):
            if not self._due(f"defect_issue_try_{d['id']}"):
                continue
            report, facts = self._split(d)
            try:
                issues = self.sup.gh.urgent_issues()
            except Exception as e:
                self.store.log(d["batch_id"], f"urgent Issue 조회 실패(보고·작업물 보존, 재시도 예정): {e}", "warn")
                continue
            number, fresh = self._find(issues, d, report)
            if number is None:
                try:
                    number = self.sup.gh.create_issue(
                        defects.issue_title(report), defects.issue_body(report, d["event_key"], facts, d["source"]),
                        ["urgent"])
                except Exception as e:
                    self.store.log(d["batch_id"], f"urgent Issue 생성 실패(보고·작업물 보존, 재시도 예정): {e}", "warn")
                    continue
                fresh = True
            elif number and not fresh:
                number = self._attach(number, d, report, facts)
                if number is None:
                    continue
            self.store.update_defect(d["id"], state="LINKED", issue_number=number)
            self.store.ensure_maintenance(number)
            self.store.log(d["batch_id"], f"urgent Issue #{number} 연결 (공통 결함 `{report['defect_class']}`)")

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

    # ---- 2. start the single Maintainer ------------------------------------------------------------------------
    def _start(self) -> None:
        if self.store.maintenance_batch_open():
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
            b = self.store.batch(d["batch_id"])
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
            if self.store.release_defect(d["id"], b["id"], head):
                self.store.log(b["id"], f"공통 수정 {d['merge_sha'][:10]} 반영·검증 완료 (HEAD {head[:10]}) → "
                               f"{b['paused_from'] or 'PRODUCING'}부터 자동 Retry 1회")

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
