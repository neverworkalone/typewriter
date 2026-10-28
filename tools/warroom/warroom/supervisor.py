"""Supervisor: persistent per-batch state machine, independent of the TUI.

One Supervisor drives many independent Production Lines: a Line is (logical model, method)
and owns at most one unfinished batch. Every state transition, poll, stop and drain below is
scoped to that Line; no Line reads another Line's controls or batch.

PREPARE -> PRODUCING -> WAITING_REVIEW <-> FIXING -> MERGED -> CLEANUP -> COMPLETE
with PAUSED (recoverable, needs operator) and ERROR (safety stop, everything kept).
The AI process exiting never completes a batch; only GitHub `merged=true` does.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import time
import traceback
from pathlib import Path

from . import auth, batches, control, dchunk, defects, literary, progress, prompts, reviews, stage1ab, stage2
from .adapters import PREFLIGHT_PENDING, QUOTA_EVIDENCE, RunSpec, classify_failure, opencode_free_quota
from .config import (TIERED_ADAPTERS, adapter_label, config_problem, load_config, registry, registry_problems,
                     reload_problem, role_of, role_problem, run_spec, stage2_problem)
from .github import GhError, GhTransient
from .gitops import CleanupBlocked, GitError, GitTransient
from .maintenance import Maintenance
from .store import MAINTENANCE_METHOD, STAGE2_METHOD, LineBusy, LineNotRunnable


# A failed *query* asking again can fix. It is never a verdict: callers re-raise it past every broad `except`.
TRANSIENT = (GhTransient, GitTransient)


class DuplicateClaim(Exception):
    pass


class RecoveryBlocked(Exception):
    """A discovered PR cannot be tied safely to this batch's completed producer run."""


def acquire_lock(path: Path):
    """Single War Room instance: returns an open locked file, or None if held."""
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "a+")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    f.seek(0)
    f.truncate()
    f.write(str(os.getpid()))
    f.flush()
    return f


class Supervisor:
    def __init__(self, paths, cfg, store, runner, adapter, gh, git, env, clock=time.time):
        self.paths, self.cfg, self.store = paths, cfg, store
        self.runner, self.adapter, self.gh, self.git, self.env = runner, adapter, gh, git, env
        self.clock = clock
        self._worker_git_executables = []
        self._s2_fix_problem: dict[int, str] = {}   # batch id -> the rejected save's error list for the next `s2_chunk_fix`
        self.maint = Maintenance(self)   # shared-defect Issues, the hidden Maintainer and applying its merged fix

    def _adapter(self, producer: str):
        """`adapter` is one AgentAdapter, or a {name: adapter} map resolved via the registry."""
        if not isinstance(self.adapter, dict):
            return self.adapter
        name = registry(self.cfg).get(producer, {}).get("adapter", "opencode")
        if name not in self.adapter:
            raise RuntimeError(f"adapter {name!r} 미지원")
        return self.adapter[name]

    # ---- control -------------------------------------------------------
    def tick(self) -> None:
        self.store.set("heartbeat", str(self.clock()))
        self._handle_reload()
        for b in self.store.incomplete_batches():  # a Line row always exists for a live batch
            self.store.line(b["producer"], b["method"])
        for ln in self.store.lines():
            try:
                self._tick_line(ln["model"], ln["method"])
            except Exception:  # one Line's failure never stalls the others
                self.store.log(None, f"line {ln['model']}/{ln['method']} 예외:\n"
                               + traceback.format_exc()[-800:], "error", line=f"{ln['model']}/{ln['method']}")
        self.maint.step()   # after the Lines: it reads the batch states they just advanced

    def _handle_reload(self) -> None:
        """Operator `r`: re-read config.json. The new config replaces `self.cfg` only if it passes every check."""
        token = self.store.get("reload_req")
        if token is None or token == self.store.get("reload_done"):
            return
        self.store.set("reload_done", token)   # one request is answered once, whatever the outcome
        try:
            new = load_config(self.paths)
            problem = reload_problem(self.cfg, new, {b["producer"] for b in self.store.incomplete_batches()})
        except (OSError, ValueError) as e:   # unreadable file or invalid JSON (JSONDecodeError is a ValueError)
            new, problem = None, f"config.json을 읽을 수 없습니다: {e}"
        if problem:
            msg = f"설정 리로드 거부 (기존 설정 유지): {problem}"
            self.store.log(None, msg, "error")
            self.store.set("reload_result", f"{token}\tfail\t{msg}")
            return
        self.cfg = new
        cleared = 0
        for ln in self.store.lines():   # a config-caused Start block is re-evaluated by the next Start
            if (ln["blocked"] or "").startswith("시작 차단:"):
                self.store.set_line(ln["model"], ln["method"], blocked="")
                cleared += 1
        msg = f"설정 리로드 완료: 모델 {', '.join(registry(new))}" + (f" · 차단 메시지 {cleared}건 정리" if cleared else "")
        self.store.log(None, msg)
        self.store.set("reload_result", f"{token}\tok\t{msg}")

    def _tick_line(self, model: str, method: str) -> None:
        ln = self.store.line(model, method)
        if self.store.pin_clear(model, method) is not None:   # a Clear pins its batch before anything else can act
            b = self.store.active_batch(model, method)
            if b is not None and b["state"] == "CLEARING":
                return self._clear(b)
        b = self.store.active_batch(model, method)
        if ln["force_stop"]:
            self.store.set_line(model, method, force_stop=0)
            pin = self.store.get(f"stop_pin_{model}_{method}")
            if pin is not None:   # a Stop bound to the execution on screen never lands on another one
                self.store.delete(f"stop_pin_{model}_{method}")
                if b is None or str(b["id"]) != pin:
                    return self.store.log(b["id"] if b else None, f"Stop 무시: 요청한 실행 #{pin}이 더 이상 현재 실행이 아닙니다",
                                          "warn", line=f"{model}/{method}")
            return self._force_stop(b) if b is not None else self.store.set_line(model, method, run=0)
        if b is None:
            if ln["drain_once"]:
                # Drain All landed after this Line's last batch completed (or with only a reservation): the
                # request is consumed here, whatever the interleaving, so no further batch is assigned.
                self.store.set_line(model, method, run=0, drain_once=0)
                return
            if ln["run"] and not control.drained(self.store, ln):
                self._prepare_new(ln)
            return
        handler = {"PREPARE": self._prepare_existing, "PRODUCING": self._poll_run,
                   "FIXING": self._poll_run, "WAITING_REVIEW": self._watch,
                   "MERGED": self._to_cleanup, "CLEANUP": self._cleanup,
                   "PAUSED": self._wait_operator, "ERROR": self._wait_operator}[b["state"]]
        handler(b)

    def _fail(self, b, state: str, msg: str) -> None:
        prev = b["state"] if b["state"] not in ("PAUSED", "ERROR") else b["paused_from"]
        self.store.update(b["id"], state=state, paused_from=prev, error=msg)
        self._clear_batch_retry(b["id"])
        self.store.log(b["id"], msg, "error")

    # ---- transient (retryable query) failures ---------------------------------------------------------------------
    # Invariant: a query that failed in a way asking again can fix never changes the Line (run/mode/drain) or the batch
    # (state/run_kind/baseline/output) and never starts an AI; only that query/judgement is retried with backoff.
    def _transient_gap(self, count: int) -> float:
        return min(self.cfg["rate_limit_backoff_seconds"] * (2 ** max(0, count - 1)), self.cfg["poll_seconds"])

    def _transient_wait(self, key: str, exc, bid: int | None = None, line: str | None = None) -> None:
        """Record one more failed attempt for `key` and schedule the next one (logged at attempt 1 and powers of two)."""
        key = f"tw_{key}"
        try:
            rec = json.loads(self.store.get(key) or "")
            count = int(rec["count"]) + 1
            first = float(rec["first"])
        except (TypeError, ValueError, KeyError):
            count, first = 1, self.clock()
        gap = self._transient_gap(count)
        self.store.set(key, json.dumps({"first": first, "count": count, "last_error": str(exc)[:300],
                                        "next_at": self.clock() + gap}))
        if count & (count - 1) == 0:
            self.store.log(bid, f"조회 일시 실패 {count}회째({key[3:]}): {str(exc)[:200]} — {int(gap)}s 후 같은 조회만 재시도 "
                           "(AI 재실행·상태 변경 없음)", "warn", line=line)

    def _transient_due(self, key: str) -> bool:
        try:
            return self.clock() >= float(json.loads(self.store.get(f"tw_{key}") or "")["next_at"])
        except (TypeError, ValueError, KeyError):
            return True

    def _transient_clear(self, key: str, bid: int | None = None, line: str | None = None) -> None:
        if self.store.get(f"tw_{key}") is not None:
            self.store.delete(f"tw_{key}")
            self.store.log(bid, f"조회 회복({key}) — 정상 진행", line=line)

    def _clear_batch_retry(self, bid: int) -> None:
        """A decided transition: stale pending re-entry records and backoff counters of THIS batch go away."""
        self.store.delete(f"pending_{bid}")
        self.store.delete_prefix(f"tw_b{bid}:")

    def _pend(self, b, stage: str, exc, **evidence) -> None:
        """Remember what must be re-judged once the failed query works again (no state change, no AI)."""
        self.store.set(f"pending_{b['id']}", json.dumps({"stage": stage, "evidence": evidence}, sort_keys=True))
        self._transient_wait(f"b{b['id']}:{stage}", exc, b["id"])

    def _last_run(self, b):
        runs = self.store.runs(b["id"])
        return runs[0] if runs else None

    def _target_ident(self, b):
        """What the next AI start would work on (chunk number / Part cursor), for pending re-entry checks; None: unknown."""
        try:
            wt = Path(b["worktree"])
            if b["method"] in stage1ab.METHODS:
                cp = stage1ab.checkpoint(wt, b)
                repair = self.store.get(f"ab_repair_{b['id']}")
                chunk = stage1ab.chunk_by_number(cp, int(repair)) if repair else stage1ab.next_chunk(wt, b, cp)
                return "final" if chunk is None else f"ab:{chunk['number']}"
            if b["method"] == literary.METHOD:
                return f"c:{self._c_next_no(b)}"
            if b["method"] == dchunk.METHOD:
                return f"d:{1 + sum(1 for r in self.store.runs(b['id']) if r['kind'] == 'd_chunk_new')}"
            if b["method"] == STAGE2_METHOD:
                cp = stage2.checkpoint(wt, b["shard"], b["batch"])
                return json.dumps([stage2.next_action(cp), cp], sort_keys=True, default=str)
        except Exception:   # an unknown target is compared as unknown, never guessed
            return None
        return None

    def _guarded(self, b, stage: str, fn, **evidence):
        """Run one retryable step; a transient query failure becomes a pending re-entry instead of ERROR/PAUSED."""
        try:
            return fn(b)
        except TRANSIENT as e:
            last = self._last_run(b)
            b = self.store.batch(b["id"])
            if stage == "prelaunch":
                evidence = dict(evidence, target=self._target_ident(b), run_kind=b["run_kind"], worktree=str(b["worktree"]),
                                last_run_id=last["id"] if last else None, head=self._local_head(b))
            elif stage == "finalize":
                evidence = dict(evidence, run_kind=b["run_kind"], worktree=str(b["worktree"]), head=self._local_head(b))
            self._pend(b, stage, e, **evidence)

    def _local_head(self, b):
        try:
            return self.git.head(Path(b["worktree"]))
        except Exception:
            return None

    def _pending_gate(self, b) -> bool:
        """True: a pending re-entry exists (waiting for its backoff, re-entered now, or rejected as stale)."""
        raw = self.store.get(f"pending_{b['id']}")
        if raw is None:
            return False
        try:
            rec = json.loads(raw)
            stage, ev = rec["stage"], rec["evidence"]
        except (TypeError, ValueError, KeyError):
            self.store.delete(f"pending_{b['id']}")
            self._fail(b, "ERROR", "pending 재판정 기록이 손상되어 AI 재실행 없이 보존합니다.")
            return True
        if not self._transient_due(f"b{b['id']}:{stage}"):
            return True
        problem = self._pending_problem(b, stage, ev)
        if problem:
            self._fail(b, "ERROR", f"pending 재판정 증거 불일치({stage}: {problem}) — AI 재실행 없이 보존")
            return True
        self.store.delete(f"pending_{b['id']}")   # consumed: a repeated transient failure records a new one
        if stage == "exit0":
            self._guarded(b, "exit0", self._judge_exit0, run_id=ev["run_id"])
        elif stage == "exit_failed":
            self._guarded(b, "exit_failed", lambda x: self._run_failed(x, ev["code"]), run_id=ev["run_id"], code=ev["code"])
        elif stage == "finalize":
            fin = {"ab_finalize": self._ab_finalize, "c_finalize": self._c_finalize, "d_finalize": self._d_finalize}
            fin[ev["run_kind"]](b)
        elif stage == "prelaunch":
            entry = {"prepare_existing": self._prepare_existing, "launch_ab_next": self._launch_ab_next,
                     "launch_c_next": self._launch_c_next, "launch_d_next": self._launch_d_next,
                     "launch_stage2_next": self._launch_stage2_next, "relaunch": self._relaunch}[ev["entrypoint"]]
            entry(b)
        return True

    def _pending_problem(self, b, stage: str, ev: dict) -> str | None:
        """Why a pending record no longer describes this batch (None: the same situation, safe to re-enter)."""
        last = self._last_run(b)
        try:
            if stage in ("exit0", "exit_failed"):
                if last is None or last["id"] != ev["run_id"] or last["ended_at"] is None:
                    return f"기대 run #{ev['run_id']} / 실제 {last['id'] if last else None}"
                want = "0" if stage == "exit0" else str(ev["code"])
                if str(last["exit_status"]) != want or b["pid"] is not None:
                    return f"기대 exit {want} / 실제 {last['exit_status']}"
                return None
            if stage == "finalize":
                if b["run_kind"] != ev["run_kind"] or str(b["worktree"]) != ev["worktree"] \
                        or self.git.registered(Path(b["worktree"])) != b["branch"]:
                    return f"기대 {ev['run_kind']} / 실제 {b['run_kind']}"
                return None
            if stage == "prelaunch":
                if b["pid"] is not None or (last["id"] if last else None) != ev["last_run_id"]:
                    return f"기대 마지막 run #{ev['last_run_id']} / 실제 {last['id'] if last else None}"
                if ev["entrypoint"] != "prepare_existing" or Path(b["worktree"]).exists():
                    if str(b["worktree"]) != ev["worktree"] or b["run_kind"] != ev["run_kind"]:
                        return f"기대 {ev['run_kind']} / 실제 {b['run_kind']}"
                    if ev["head"] is not None and self._local_head(b) != ev["head"]:
                        return f"기대 HEAD {str(ev['head'])[:10]} / 실제 {str(self._local_head(b))[:10]}"
                    if ev["target"] is not None and self._target_ident(b) != ev["target"]:
                        return "대상 청크/Part가 달라졌습니다"
                return None
        except (KeyError, TypeError) as e:
            return f"증거 형식 오류 {e}"
        return f"알 수 없는 단계 {stage}"

    def _reap_stopped(self, b) -> bool:
        """Clear the PID of a stop-requested run only once the process is really gone."""
        if b["pid"] is None:
            return True
        if self._adapter(b["producer"]).alive(b["pid"]):
            return False
        self.store.update(b["id"], pid=None)
        self.store.finish_runs(b["id"], "stopped")
        return True

    def _wait_operator(self, b) -> None:
        if b["method"] == STAGE2_METHOD:
            self._record_progress(b)   # checkpoint progress survives Stop, PAUSED/ERROR and Supervisor restart
            b = self.store.batch(b["id"])
        ln = self.store.line(b["producer"], b["method"])
        if not self._reap_stopped(b):
            # Stop is pending: Retry is not honoured (and not remembered) while the old AI lives.
            if ln["retry_batch"] is not None:
                self.store.set_line(b["producer"], b["method"], retry_batch=None)
            return
        b = self.store.batch(b["id"])
        if b["pause_reason"] == "shared_defect":
            # Paused for a shared defect: only Maintenance._release resumes it (once, after the fix is applied and
            # verified). An operator Retry counts only after an explicit Stop (the hold), as a deliberate override.
            if ln["retry_batch"] != b["id"]:
                return
            if not self.store.get(f"defect_hold_{b['id']}"):
                return self.store.set_line(b["producer"], b["method"], retry_batch=None)
            self._override_defect(b)
        elif ln["retry_batch"] != b["id"] and self._recover_if_merged(b):
            return
        elif (ln["retry_batch"] == b["id"] and not b["pr_number"]
              and self._complete_progress(b) and not self._verified_late_producer_exit(b)):
            # A full saved output can already have a merged PR even when the run
            # status was lost. Rule that out before honoring Retry.
            previous_error = b["error"]
            if self._recover_if_merged(b, force=True):
                return
            current = self.store.batch(b["id"])
            if current["state"] != b["state"] or current["error"] != previous_error:
                return
        if ln["retry_batch"] == b["id"]:
            if b["method"] == STAGE2_METHOD and b["state"] == "ERROR" and not b["pr_number"] and self._s2_chunk_run(b) \
                    and stage2.fixes_used(self.store.runs(b["id"])) >= stage2.MAX_FIXES:
                # Only the owner's explicit Retry after the corrections are used up restarts this pending chunk in a new
                # session; `fixes_used` counts from that new session, so the correction chances start over.
                stage2.clear_decisions(b["worktree"])
                self.store.update(b["id"], session_id=None)
                self.store.log(b["id"], "수정 기회 소진 뒤 운영자 Retry: 같은 청크를 새 AI 세션으로 다시 시작합니다")
            self.store.set_line(b["producer"], b["method"], retry_batch=None, run=1)
            self.store.update(b["id"], state=b["paused_from"] or "PRODUCING", error=None,
                              retries=0, retry_after=None, pause_reason="", defect_id=None)
            self.store.log(b["id"], f"운영자 재시도: {b['paused_from']}로 복귀")

    def _override_defect(self, b) -> None:
        if b["defect_id"] is not None:
            self.store.update_defect(b["defect_id"], state="OVERRIDDEN",
                                     hold_reason="운영자가 Stop 후 Retry로 수정 반영 없이 직접 재개함")
        self.store.set(f"defect_hold_{b['id']}", "")
        self.store.log(b["id"], "공통 결함 PAUSED를 운영자가 직접 해제 (수정 반영 없음)", "warn")

    @staticmethod
    def _complete_progress(b) -> bool:
        done, total = b["records_done"], b["records_total"]
        return isinstance(done, int) and isinstance(total, int) and total > 0 and done == total

    def _recover_if_merged(self, b, force: bool = False) -> bool:
        """Recover a failed producer batch from its owned PR without starting another AI run.

        Known PRs keep the existing merged-only recovery. A missing PR number is rediscovered only when the producer
        exit is verified or saved record progress is complete. PR ownership is checked independently of worktree
        registration; cleanup separately rechecks merged=true and its worktree safety gates.
        """
        if b["paused_from"] == "CLEANUP" or b["pid"] is not None:
            return False
        verified_exit = self._verified_late_producer_exit(b)
        if not b["pr_number"] and not verified_exit and not self._complete_progress(b):
            return False
        key = f"last_merge_check_{b['id']}"
        if not force and self.clock() - float(self.store.get(key, "0")) < max(self.cfg["poll_seconds"], 60):
            return False
        self.store.set(key, str(self.clock()))
        try:
            if b["pr_number"]:
                info = self.gh.pull(b["pr_number"])
            else:
                info = self._find_recovery_pr(b)
        except Exception as e:
            if b["pr_number"]:
                self.store.log(b["id"], f"오류 배치 머지 재확인 실패(재시도 예정): {e}", "warn")
            else:
                self._fail(b, "ERROR", f"실패 배치의 기존 PR 재발견/머지 확인이 불명확합니다: {e}. "
                           "worktree와 실행 상태를 보존하며 AI를 재실행하지 않습니다.")
                return True
            return False
        if info is None:
            if self.store.get(f"no_pr_recovery_{b['id']}") != "1":
                self.store.log(b["id"], "완료 기록이 남은 소유 브랜치에서 기존 PR을 찾지 못했습니다. "
                               "AI 재실행 없이 다음 제한 폴링에서 다시 확인합니다.", "warn")
                self.store.set(f"no_pr_recovery_{b['id']}", "1")
            return False
        if not b["pr_number"]:
            if info["merged"]:
                return self._enter_merged(b, info, f"{b['state']} 상태에서 누락 PR 복구")
            return self._handoff_recovered_pr(b, info, "PAUSED/ERROR 상태에서")
        if not info["merged"]:
            return False
        return self._enter_merged(b, info, f"{b['state']} 상태에서")

    def _handoff_recovered_pr(self, b, info, context: str) -> bool:
        """Attach a previously untracked, fully ownership-checked PR without rerunning production."""
        if b["method"] == STAGE2_METHOD and isinstance(b["run_kind"], str) and \
                b["run_kind"].startswith("s2_finalize_"):
            problem = self._stage2_final_pr_problem(b, info)
            if problem:
                self._fail(b, "ERROR", problem)
                return True
        self.store.update(b["id"], pr_number=info["number"], head_sha=info["head_sha"])
        self.store.log(b["id"], f"누락 PR #{info['number']} 재발견 및 소유권 확인 완료 (브랜치 {b['branch']})", "warn")
        b = self.store.batch(b["id"])
        if info["state"] == "open" and not info["merged"]:
            self._to_review(b, info, recovery_note=f"{context} 기존 PR #{info['number']} 재발견; "
                            "기존 리뷰·검증 게이트로 복귀했습니다 (AI 재실행 없음).")
            return True
        if not info["merged"]:
            # Keep the closed PR attached so an operator retry cannot relaunch production and create a duplicate.
            self.store.update(b["id"], state="ERROR", paused_from="WAITING_REVIEW",
                              error=f"PR #{info['number']}이 머지 없이 닫혀 있어 자동 복구하지 않습니다. "
                              "worktree·브랜치를 보존합니다.")
            self.store.log(b["id"], f"재발견한 PR #{info['number']}은 머지 없이 닫힘; 안전 정지", "error")
            return True
        return self._enter_merged(b, info, f"{context} 기존 PR #{info['number']} 확인 후")

    def _verified_fix_exit(self, b) -> bool:
        """The last run is a finished FIX run (exit 0) whose completion evidence the Supervisor recorded."""
        last = self._last_run(b)
        return (last is not None and isinstance(last["kind"], str) and last["kind"].startswith("fix")
                and last["ended_at"] is not None and str(last["exit_status"]) == "0"
                and self.store.get(f"verified_completion_run_{b['id']}") == str(last["id"]) and bool(b["pr_number"]))

    def _verified_late_producer_exit(self, b) -> bool:
        """Only inspect PRs after a terminal producer result, never after a stop or unverified success."""
        if b["pid"] is not None or b["paused_from"] != "PRODUCING":
            return False
        runs = self.store.runs(b["id"])
        if not runs:
            return False
        run = runs[0]
        if not isinstance(run["kind"], str) or not (run["kind"].startswith("produce") or
                                                     run["kind"].startswith("s2_finalize_")) or run["ended_at"] is None:
            return False
        try:
            code = int(run["exit_status"])
        except (TypeError, ValueError):
            return False
        if code != 0:
            return True
        # Keep completion evidence separate from mutable operator-facing error text. A later GitHub failure can
        # replace that text, but must not revoke proof that this exact producer run passed its completion gate.
        return self.store.get(f"verified_completion_run_{b['id']}") == str(run["id"])

    def _verified_current_producer_exit(self, b, code: int) -> bool:
        if b["pid"] is not None:
            return False
        runs = self.store.runs(b["id"])
        if not runs:
            return False
        run = runs[0]
        try:
            recorded = int(run["exit_status"])
        except (TypeError, ValueError):
            return False
        return (isinstance(run["kind"], str) and (run["kind"].startswith("produce") or
                                                   run["kind"].startswith("s2_finalize_"))
                and run["ended_at"] is not None and recorded == code)

    def _eligible_branch_prs(self, b, prs):
        """Exclude provably older unmerged C PRs without hiding the attached or same-HEAD PR."""
        if b["method"] != literary.METHOD:
            return prs
        attached = b["pr_number"]
        stale = [pr for pr in prs if (
            str(pr.get("state", "")).lower() == "closed"
            and "mergedAt" in pr and pr["mergedAt"] is None
            and isinstance(pr.get("number"), int) and not isinstance(pr.get("number"), bool)
            and pr.get("number") != attached
            and isinstance(pr.get("headRefOid"), str) and re.fullmatch(r"[0-9a-f]{40}", pr["headRefOid"])
        )]
        if not stale:
            return prs
        try:
            wt = Path(b["worktree"])
            if self.git.registered(wt) != b["branch"]:
                return prs
            current_head = self.git.head(wt)
        except (GitError, OSError, ValueError):
            return prs
        known_heads = {current_head}
        finalized_head = self.store.get(f"c_commit_head_{b['id']}")
        if isinstance(finalized_head, str):
            known_heads.add(finalized_head)
        return [pr for pr in prs if not (
            str(pr.get("state", "")).lower() == "closed"
            and "mergedAt" in pr and pr["mergedAt"] is None
            and isinstance(pr.get("number"), int) and not isinstance(pr.get("number"), bool)
            and pr.get("number") != attached
            and isinstance(pr.get("headRefOid"), str) and re.fullmatch(r"[0-9a-f]{40}", pr["headRefOid"])
            and pr["headRefOid"] not in known_heads
        )]

    def _find_recovery_pr(self, b):
        """Find one existing PR and prove its branch/candidate claim belongs to this batch before handoff."""
        prs = self.gh.prs_for_branch(b["branch"])
        if not isinstance(prs, list):
            raise RecoveryBlocked("소유 브랜치 PR 조회 결과 형식이 잘못되었습니다")
        prs = self._eligible_branch_prs(b, prs)
        if not prs:
            return None
        if len(prs) != 1:
            numbers = ", ".join(str(pr.get("number", "?")) for pr in prs)
            raise RecoveryBlocked(f"소유 브랜치에 PR이 여러 개 있습니다: #{numbers}")
        number = prs[0].get("number")
        if not isinstance(number, int):
            raise RecoveryBlocked("소유 브랜치 PR 번호가 없습니다")
        info = self.gh.pull(number)
        if info.get("number") != number or info.get("head_ref") != b["branch"]:
            raise RecoveryBlocked(f"PR #{number}의 head 브랜치가 배치 소유 브랜치와 다릅니다")
        files = self.gh.pull_files(number)
        candidates = batches.pr_claims(b, {"number": number, "files": files})
        expected = batches.expected_claim(b)
        if candidates.count(expected) != 1 or any(item != expected for item in candidates):
            raise RecoveryBlocked(f"PR #{number}의 Candidate 파일 소유권이 배치와 일치하지 않습니다 "
                                  f"(기대 {expected}, 확인 {candidates})")
        dup = self._duplicate_claim(b, number)
        if dup:
            raise RecoveryBlocked(f"같은 배치를 다른 열린 PR #{dup}이 점유 — 복구를 중단합니다")
        if info.get("merged"):
            if info.get("state") != "closed":
                raise RecoveryBlocked(f"PR #{number}의 merged/state 값이 상충합니다")
            # The merged PR proves the durable batch/branch/candidate claim. Registration and residual files are
            # checked separately by CLEANUP, which requires a pre-removal proof before resuming partial deletion.
            return info
        wt = Path(b["worktree"])
        if self.git.registered(wt) != b["branch"]:
            raise RecoveryBlocked(f"worktree가 소유 브랜치 {b['branch']}로 등록되어 있지 않습니다")
        self.git.worktree_gitdir(wt)
        local = self.git.head(wt)
        if info.get("state") == "open":
            if local != info.get("head_sha"):
                raise RecoveryBlocked(f"PR #{number} HEAD와 로컬 worktree HEAD가 다릅니다 "
                                      f"({info.get('head_sha')} / {local})")
            remote = self.git.remote_head(b["branch"])
            if remote != local:
                raise RecoveryBlocked(f"PR #{number} HEAD와 원격 소유 브랜치가 다릅니다 "
                                      f"({info.get('head_sha')} / {remote})")
        elif info.get("state") == "closed":
            # Return the owned but unmerged PR so the caller can attach it and prevent a production Retry.
            if local != info.get("head_sha"):
                raise RecoveryBlocked(f"닫힌 PR #{number} HEAD와 로컬 worktree HEAD가 다릅니다 "
                                      f"({info.get('head_sha')} / {local})")
        else:
            raise RecoveryBlocked(f"PR #{number}의 GitHub 상태가 불명확합니다: {info.get('state')!r}")
        return info

    def _enter_merged(self, b, info, reason: str) -> bool:
        self.store.update(b["id"], state="MERGED", pr_number=info["number"], merged=1,
                          head_sha=info["head_sha"], error=None, retries=0, retry_after=None,
                          pause_reason="", defect_id=None)
        self._clear_batch_retry(b["id"])
        self.store.delete(f"pr_create_{b['id']}")
        self.store.log(b["id"], f"{reason} PR #{info['number']} merged=true 확인 → MERGED "
                       "(기존 cleanup worktree 검증으로 인계, AI 재실행 없음)")
        return True

    def _force_stop(self, b) -> None:
        ad = self._adapter(b["producer"])
        if b["pid"] and ad.alive(b["pid"]):
            ad.stop(b["pid"])   # keep the PID: it is cleared only after exit is confirmed
        self.store.set_line(b["producer"], b["method"], run=0, retry_batch=None)  # Stop wins over Retry
        if b["pause_reason"] == "shared_defect":   # the operator took over: no automatic release until a deliberate Retry
            self.store.set(f"defect_hold_{b['id']}", "1")
        self.store.update(b["id"], retry_after=None)
        self._fail(b, "PAUSED", "강제 중지됨. worktree·브랜치·PR은 보존됨 (프로세스 종료 확인 후 Retry로 재개).")
        self._reap_stopped(self.store.batch(b["id"]))

    # ---- CLEARING: operator-confirmed abandon of one batch ------------------
    def _clear_block(self, b, msg: str) -> None:
        """Teardown stopped safely: keep the CLEARING pin (nothing relaunches) until the operator re-arms Clear."""
        self.store.set_clear(b["id"], status="BLOCKED", error=msg)
        self.store.update(b["id"], error=msg)
        self.store.log(b["id"], f"Clear 중단(보존, 재시도 가능): {msg}", "error")

    def _clear(self, b) -> None:
        """Invariant: nothing is deleted before the AI process is gone and ownership of the worktree, every PR on the
        branch and the remote branch is proven; every step is idempotent, so a restart or retry resumes teardown."""
        req = self.store.clear_request(b["producer"], b["method"])
        if req is None or req["batch_id"] != b["id"]:
            return self._fail(b, "ERROR", "Clear 요청 기록을 찾을 수 없어 보존합니다.")
        if req["status"] == "BLOCKED":
            return
        ad = self._adapter(b["producer"])
        if b["pid"] is not None:
            if ad.alive(b["pid"]):
                ad.stop(b["pid"])
                return self.store.log(b["id"], "Clear: AI 프로세스 종료 요청, 종료 확인 대기")
            self.store.update(b["id"], pid=None)
            self.store.finish_runs(b["id"], "cleared")
            b = self.store.batch(b["id"])
        try:
            merged = self._clear_teardown(b, req)
        except (CleanupBlocked, GitError, RecoveryBlocked) as e:
            return self._clear_block(b, str(e))
        except Exception as e:
            return self._clear_block(b, f"{type(e).__name__}: {e}")
        if merged is not None:   # merged work is never abandoned: hand it to the regular merged cleanup path
            self.store.drop_clear(b["id"])
            self._enter_merged(b, merged, "Clear 중단: 머지된")

    def _clear_teardown(self, b, req):
        branch, wt = b["branch"], Path(b["worktree"])
        maint = b["method"] == MAINTENANCE_METHOD
        if branch != (f"maint-{b['batch']}" if maint else f"{b['method']}-{b['producer']}-{b['shard']}-{b['batch']}"):
            raise RecoveryBlocked(f"브랜치 {branch!r}가 War Room 소유 이름이 아닙니다")
        if maint:   # the Issue's task row must still point at exactly this execution (never another Issue's)
            row = self.store.maintenance(int(b["batch"])) if str(b["batch"]).isdigit() else None
            if row is None or row["batch_id"] != b["id"]:
                raise RecoveryBlocked(f"Issue #{b['batch']}의 Maintainer 작업 기록이 이 실행을 가리키지 않습니다")
        exists = self.git.verify_owned(wt, branch)
        nums = {p["number"] for p in self.gh.prs_for_branch(branch)} | ({b["pr_number"]} if b["pr_number"] else set())
        for pr in self.gh.open_prs():
            if pr.get("baseRefName") == branch and pr["number"] not in nums:
                raise RecoveryBlocked(f"열린 PR #{pr['number']}이 이 브랜치를 base로 사용합니다")
        infos = []
        for n in sorted(nums):
            info = self.gh.pull(n)
            if info.get("head_ref") != branch:
                raise RecoveryBlocked(f"PR #{n}의 head 브랜치 {info.get('head_ref')!r}가 소유 브랜치와 다릅니다")
            if info["merged"]:
                return info
            infos.append(info)
        open_prs = [i for i in infos if i["state"] == "open"]
        if not maint:   # a Maintainer PR is Issue-scoped: its ownership proof is the head branch checked above
            expected = batches.expected_claim(b)
            for i in open_prs:
                cands = batches.pr_claims(b, {"number": i["number"], "files": self.gh.pull_files(i["number"])})
                if cands != [expected]:
                    raise RecoveryBlocked(f"PR #{i['number']}의 Candidate 파일 소유권이 배치와 일치하지 않습니다 "
                                          f"(기대 {expected}, 확인 {cands})")
        # Every ownership proof comes BEFORE the first irreversible step: a failing check must never leave a closed PR.
        remote = self.git.remote_head(branch)
        if remote is not None:
            allowed = {i["head_sha"] for i in infos} | ({self.git.head(wt)} if exists else set())
            if remote not in allowed:
                raise RecoveryBlocked(f"원격 브랜치 HEAD {remote[:10]}가 확인된 PR/로컬 HEAD와 다릅니다")
        for i in open_prs:
            self.gh.close_pr(i["number"])
            after = self.gh.pull(i["number"])
            if after["merged"]:
                return after
            if after["state"] == "open":
                raise RecoveryBlocked(f"PR #{i['number']}을 닫지 못했습니다")
            self.store.add_clear_note(b["id"], f"PR #{i['number']} 머지 없이 닫음; ")
            self.store.log(b["id"], f"Clear: PR #{i['number']} 머지 없이 닫음")
        if remote is not None:
            self.git.delete_remote_branch(branch, remote)   # lease: refused if origin moved since the proof above
            if self.git.remote_head(branch) is not None:
                raise RecoveryBlocked("원격 브랜치 삭제를 확인하지 못했습니다")
            self.store.add_clear_note(b["id"], "원격 브랜치 삭제; ")
        self.git.discard_owned(wt, branch)
        self._remove_run_files(b)
        note = self.store.clear_request(b["producer"], b["method"])["note"]
        what = f"Maintainer urgent Issue #{b['batch']}" if maint else f"{b['method'].upper()} 배치 {b['shard']}_{b['batch']}"
        self.store.finish_clear(b, f"Clear 완료: {b['producer']}/{b['method'].upper()} {what} "
                                   f"(이전 상태 {req['prior_state']}, 기록 PR {('#' + str(b['pr_number'])) if b['pr_number'] else '없음'}); "
                                   f"{note}worktree·로컬 브랜치·실행 파일 정리")
        return None

    def _remove_run_files(self, b) -> None:
        logs = self.paths.logs.resolve()
        files = {Path(f) for r in self.store.runs(b["id"]) for f in (r["log_file"], r["exit_file"]) if f}
        files |= {Path(f) for f in (b["log_file"], b["exit_file"]) if f}
        files |= set(logs.glob(f"batch-{b['id']}-*.log")) | set(logs.glob(f"batch-{b['id']}-*.exit"))
        for f in files:
            if f.parent.resolve() == logs and f.name.startswith(f"batch-{b['id']}-"):
                f.unlink(missing_ok=True)

    # ---- PREPARE -------------------------------------------------------
    def _blocked(self, ln, msg: str) -> None:
        self.store.set_line(ln["model"], ln["method"], blocked=msg, run=0)
        self.store.log(None, msg, "error", line=f"{ln['model']}/{ln['method']}")

    def _prepare_new(self, ln) -> None:
        model, method = ln["model"], ln["method"]
        reg = registry(self.cfg)
        if model not in reg:
            return self._blocked(ln, f"시작 차단: 등록되지 않은 모델 {model!r}")
        if model in registry_problems(self.cfg):
            return self._blocked(ln, "시작 차단: " + registry_problems(self.cfg)[model])
        if method == STAGE2_METHOD and (why := stage2_problem(self.cfg, model)):   # fail closed here too, not only in Start
            return self._blocked(ln, "시작 차단: " + why)
        if why := role_problem(self.cfg, model, role_of(method)):   # the stage's assigned profile must resolve to a valid pin
            return self._blocked(ln, "시작 차단: " + why)
        key, line = f"line:{model}:{method}:prepare", f"{model}/{method}"
        if not self._transient_due(key):
            return   # a retryable lookup is backing off: the Line stays exactly as the operator left it
        d = auth.diagnose(self.runner, self.env, self.cfg["repo"], self.cfg["expected_account"])
        if d.get("transient"):
            return self._transient_wait(key, d["transient"], line=line)
        if not d["ok"]:
            return self._blocked(ln, "시작 차단: " + "; ".join(d["problems"]))
        problem = self._preflight(model, method)
        if problem and problem.startswith(PREFLIGHT_PENDING):
            return   # the CLI check runs in the background: this Line waits here, the others keep moving
        if problem:
            return self._blocked(ln, "시작 차단: " + problem)
        if method == STAGE2_METHOD:
            return self._prepare_new_stage2(ln)
        try:
            self.git.fetch_base(self.cfg["base_branch"])
            nb = batches.next_batch(
                self.runner, self.paths.repo_root, self.env,
                ref=f"origin/{self.cfg['base_branch']}", method=method, producer=model,
                open_prs=self.gh.open_prs(),
                owned=self.store.claimed_keys(method, None if batches.is_shared_queue(method) else model))
        except TRANSIENT as e:
            return self._transient_wait(key, e, line=line)
        except Exception as e:  # BatchError, GitError, GhError
            return self._blocked(ln, f"배치 선정 실패: {e}")
        self._transient_clear(key, line=line)
        if nb is None:
            self.store.set_line(model, method, run=0)
            return self.store.log(None, "더 이상 생산할 미점유 배치가 없습니다.", line=f"{model}/{method}")
        branch = f"{method}-{model}-{nb.shard}-{nb.batch}"
        wt = self.paths.worktrees / f"{method}-{model}-{nb.stem}"
        try:
            bid = self.store.create_batch(method=method, producer=model, shard=nb.shard,
                                          batch=nb.batch, branch=branch, worktree=str(wt),
                                          model_tier=ln["model_tier"], records_total=nb.records, from_run=True)
        except LineNotRunnable:   # Stop / Drain / Drain All landed after this tick read the Line: nothing is created
            return
        except LineBusy as e:
            return self.store.log(None, str(e), "warn", line=f"{model}/{method}")
        self.store.set_line(model, method, blocked="")
        self.store.log(bid, f"배치 {nb.stem} 선정, worktree 준비")
        self._prepare_existing(self.store.batch(bid))

    def _prepare_new_stage2(self, ln) -> None:
        """Assign the next Stage 2 Part: the earliest ready Part whose exact verify has not yet succeeded on master.

        Single stays on the shard chosen at its first Part (waiting there rather than moving on); Continuous goes on to
        the next shard. With nothing runnable it waits and re-checks at poll_seconds instead of re-running or
        opening a duplicate PR.
        """
        model, method, base = ln["model"], STAGE2_METHOD, self.cfg["base_branch"]
        wait_key, poll_key, line = f"s2_wait_{model}", f"s2_poll_{model}", f"{model}/{method}"
        if self.store.get(wait_key) and self.clock() - float(self.store.get(poll_key, "0")) < self.cfg["poll_seconds"]:
            return
        if not self._transient_due(f"line:{model}:{method}:prepare"):
            return
        pin = ln["shard_pin"] if ln["mode"] == "single" else ""
        try:
            sha = self.git.fetch_base(base)
            choice = stage2.choose(self.runner, self.paths.repo_root, self.env, ref=f"origin/{base}", sha=sha,
                                   open_prs=self.gh.open_prs(), kv=self.store, pin=pin,
                                   verify=lambda *a: self.git.verify_stage2(sha, *a))
        except TRANSIENT as e:
            return self._transient_wait(f"line:{model}:{method}:prepare", e, line=line)
        except Exception as e:   # BatchError, GitError, GhError
            return self._blocked(ln, f"Stage 2 Part 선정 실패: {e}")
        self._transient_clear(f"line:{model}:{method}:prepare", line=line)
        if choice.status == "stop":
            return self._blocked(ln, choice.note)
        if choice.status == "wait":
            if self.store.get(wait_key) != choice.note:
                self.store.log(None, f"Stage 2 대기: {choice.note}", line=line)
            self.store.set(wait_key, choice.note)
            return self.store.set(poll_key, str(self.clock()))
        self.store.set(wait_key, "")
        if choice.status == "done":
            self.store.set_line(model, method, run=0, shard_pin="")
            return self.store.log(None, choice.note, line=line)
        part = choice.part
        branch = f"{method}-{model}-{part.shard}-{part.key}"
        wt = self.paths.worktrees / f"{method}-{model}-{part.shard}_{part.key}"
        try:
            bid = self.store.create_batch(method=method, producer=model, shard=part.shard, batch=part.key,
                                          branch=branch, worktree=str(wt), model_tier=ln["model_tier"], from_run=True,
                                          shard_pin=part.shard if ln["mode"] == "single" else "")
        except LineNotRunnable:
            return
        except LineBusy as e:   # another model already holds the one Stage 2 occupancy
            return self.store.log(None, str(e), "warn", line=line)
        self.store.log(bid, f"Stage 2 {stage2.label(part.shard, part.key)} 선정, worktree 준비")
        self._prepare_existing(self.store.batch(bid))

    def _tiered(self, producer: str) -> bool:
        """Free/Go tiers and the automatic quota switch belong to the producer's CLI (OpenCode only)."""
        return registry(self.cfg)[producer]["adapter"] in TIERED_ADAPTERS

    def _adapter_problem(self, producer: str) -> str | None:
        """Start is refused, never redirected, when this build has no adapter for the producer's CLI."""
        name = registry(self.cfg)[producer]["adapter"]
        if isinstance(self.adapter, dict) and name not in self.adapter:
            return f"{adapter_label(name)} CLI 어댑터가 이 War Room 빌드에 없습니다 — 다른 CLI로 대신 실행하지 않습니다."
        return None

    def _preflight(self, producer: str, method: str = "a") -> str | None:
        """Fail closed before any process starts: the CLI must be able to run exactly the pinned model and effort."""
        problem = self._adapter_problem(producer)
        if problem:
            return problem
        if method in ("c", "d") and (problem := self._literary_index_problem(method)):
            return problem
        ad = self._adapter(producer)
        if self._tiered(producer):   # OpenCode/DeepSeek: the free tier must be an explicit, recognisably free model
            free = registry(self.cfg)[producer]["models"].get("free", "")
            if not free:
                return (f"{producer}: models.free 미설정 — OpenCode 기본 모델이 무료라는 보장이 없어 실행하지 않습니다 "
                        f"({self.paths.config_file}).")
            if not re.search(self.cfg.get("free_model_pattern", r"-free$"), free):
                return f"models.free={free!r} 는 무료 모델 ID로 확인되지 않습니다 (패턴 {self.cfg.get('free_model_pattern', '-free$')})."
        try:
            runs = self._pinned_runs(producer, role_of(method))
        except ValueError as e:
            return str(e)
        return ad.preflight(self.runner, self.env, runs)

    def _literary_index_problem(self, method: str = "c") -> str | None:
        """Methods C (literary index) and D (paragraph corpus index) each receive one explicitly configured approved
        index; never search for a substitute."""
        key = "corpus_index_path" if method == "d" else "literary_index_path"
        configured = self.cfg.get(key, "")
        if not isinstance(configured, str) or not configured.strip():
            return (f"Method {method.upper()} 시작 차단: {key}가 설정되지 않았습니다. "
                    "tools/warroom/.local/config.json에 승인 SQLite의 절대 경로를 설정하세요.")
        database = Path(configured.strip()).expanduser()
        try:
            readable = database.is_absolute() and database.is_file() and os.access(database, os.R_OK)
        except (OSError, ValueError):
            readable = False
        if not readable:
            return (f"Method {method.upper()} 시작 차단: {key}가 읽을 수 있는 절대 파일을 가리키지 않습니다. "
                    "tools/warroom/.local/config.json을 확인하세요.")
        return None

    def _launch_env(self, b, kind: str, base_env: dict | None = None) -> dict:
        """Add run-specific worker environment without inheriting Stage 2 chunk restrictions into finalization."""
        env = dict(self.env if base_env is None else base_env)
        key = "TYPEWRITER_APPROVED_LITERARY_DB"
        env.pop(key, None)
        env.pop("TYPEWRITER_APPROVED_CORPUS_DB", None)
        if b["method"] == "c":
            env[key] = str(Path(self.cfg["literary_index_path"].strip()).expanduser())
        if b["method"] == "d" and isinstance(kind, str) and kind.startswith(("d_chunk_", "d_cli")):
            env["TYPEWRITER_APPROVED_CORPUS_DB"] = str(Path(self.cfg["corpus_index_path"].strip()).expanduser())
        env.pop("WARROOM_STAGE2_CHUNK", None)
        env.pop("WARROOM_GIT_EXECUTABLES", None)
        env.pop("WARROOM_ANSWER_ONLY", None)
        env.pop("OPENCODE_CONFIG_CONTENT", None)
        ab_chunk = b["method"] in stage1ab.METHODS and isinstance(kind, str) and kind.startswith("ab_chunk_")
        if ab_chunk:   # A/B answer-only is an output contract; adapter-specific tool handling remains unchanged
            env["WARROOM_ANSWER_ONLY"] = "1"
            if self._adapter(b["producer"]).name == "opencode":
                env["OPENCODE_CONFIG_CONTENT"] = json.dumps({"permission": {"edit": "deny", "bash": "deny", "webfetch": "deny"}})
        # Chunk runs suppress auto-loaded AGENTS.md and web lookup. Execution rules stay adapter-specific; Codex keeps
        # the operator's configured permission profile, while answer-only results are judged by their output contract.
        if (b["method"] == STAGE2_METHOD and isinstance(kind, str) and kind.startswith("s2_chunk_")) or \
                (b["method"] == literary.METHOD and isinstance(kind, str) and kind.startswith("c_chunk_")) or \
                (b["method"] == dchunk.METHOD and isinstance(kind, str) and kind.startswith("d_chunk_")) or ab_chunk:
            env["WARROOM_STAGE2_CHUNK"] = "1"
            env["WARROOM_GIT_EXECUTABLES"] = json.dumps(self._worker_git_executables)
        return env

    def _pinned_runs(self, producer: str, role: str = "stage1"):
        """Every model/effort this producer may run with: both tiers of a tiered CLI (a configured Go model too)."""
        if not self._tiered(producer):
            return [run_spec(self.cfg, producer, role=role)]
        go = registry(self.cfg)[producer]["models"].get("go")
        return [run_spec(self.cfg, producer, "free", role)] + ([run_spec(self.cfg, producer, "go", role)] if go else [])

    def _prepare_existing(self, b) -> None:
        if self._pending_gate(b):
            return
        self._guarded(b, "prelaunch", self._prepare_existing_do, entrypoint="prepare_existing")

    def _prepare_existing_do(self, b) -> None:
        wt = Path(b["worktree"])
        try:
            if not wt.exists():
                self.git.fetch_base(self.cfg["base_branch"])
                self.git.create_worktree(wt, b["branch"], self.cfg["base_branch"])
            elif self.git.registered(wt) != b["branch"]:
                return self._fail(b, "ERROR", f"worktree가 있지만 소유 확인 불가: {wt}")
        except TRANSIENT:
            raise
        except GitError as e:
            return self._fail(b, "ERROR", f"worktree 준비 실패: {e}")
        if b["method"] == STAGE2_METHOD:
            return self._launch_stage2_next(b)
        if b["method"] == literary.METHOD:
            return self._launch_c_next(b)
        if b["method"] == dchunk.METHOD:
            return self._launch_d_next(b)
        if b["method"] in stage1ab.METHODS and self.cfg.get("ab_chunk_sessions", True) \
                and not str(b["run_kind"] or "").startswith("produce"):
            return self._launch_ab_next(b)   # new A/B batches run as answer-only chunks (#2035); an old long session stays as it is
        self._launch(b, "produce")

    def _launch_stage2_next(self, b) -> None:
        self._guarded(b, "prelaunch", self._launch_stage2_next_do, entrypoint="launch_stage2_next")

    def _launch_stage2_next_do(self, b) -> None:
        """Start exactly one checkpoint chunk in a fresh session, or the separate Part finalizer."""
        try:
            checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
            phase = stage2.next_action(checkpoint)
        except (OSError, ValueError, KeyError, TypeError) as e:
            return self._fail(b, "ERROR", f"Stage 2 checkpoint 확인 실패: {e}. worktree를 보존합니다.")
        return self._launch(b, f"s2_{phase}_new")

    # ---- launching runs ------------------------------------------------
    def _run(self, b) -> RunSpec:
        """The model and effort this batch's next run is pinned to (the current tier for OpenCode)."""
        return run_spec(self.cfg, b["producer"], b["model_tier"], role_of(b["method"]))

    def _recorded_run(self, b) -> RunSpec | None:
        """The model and effort the batch's current run was launched with (the store is the source of truth)."""
        r = next((r for r in self.store.runs(b["id"]) if r["model"]), None)
        return RunSpec(r["model"], r["effort"], r["permission_profile"] or "") if r else None

    @staticmethod
    def _pin_drift(b, run: RunSpec, tiered: bool, runs, tier_models=None) -> str | None:
        """Every relaunch of a batch (resume, recovery, fix) runs on the pin its last recorded run used.

        The only model change allowed is a tiered CLI's Free -> Go switch of its own configured IDs (`tier_models` is
        (free, go)). Any other model change, and any effort change, stops the batch before a process starts.
        """
        prev = next((r for r in runs if r["effort"]), None)
        if prev is None:   # a run from before pins were recorded: nothing to compare with
            return None
        same_model = prev["model"] == run.model
        free_to_go = False
        if tiered and tier_models:
            free, go = tier_models
            free_to_go = bool(free and go) and prev["model"] == free and run.model == go
        # NULL = recorded before profiles were tracked: nothing to compare. '' = recorded with no profile.
        prev_profile = prev["permission_profile"]
        profile_drift = prev_profile is not None and prev_profile != run.permission_profile
        if prev["effort"] != run.effort or profile_drift or (not same_model and not (tiered and free_to_go)):
            was = f"{prev['model']} / {prev['effort']}" + (f" / {prev_profile or '(프로필 없음)'}" if prev_profile is not None else "")
            now = f"{run.model} / {run.effort}" + (f" / {run.permission_profile or '(프로필 없음)'}" if prev_profile is not None else "")
            return (f"실행 설정 변경 차단: 기록된 실행 설정 {was} 과 현재 설정 "
                    f"{now} 이 다릅니다. 설정을 되돌리고 Board에서 r(설정 리로드) 후 Retry 하세요.")
        return None

    def _agent_env(self) -> dict:
        """Worker CLIs run with the normal environment (and normal Git). The Git binaries on PATH are only recorded so
        a Stage 2 chunk can have them blocked; with none found, only that chunk fails closed (`stage2_git_executables`)."""
        env = {k: v for k, v in self.env.items() if k not in ("WARROOM_GIT_SHIM", "WARROOM_GIT_SHIM_EXEC_PID",
                                                               "WARROOM_REAL_GIT")}   # leftovers of the removed shim
        git_executables = set()
        for entry in env.get("PATH", os.defpath).split(os.pathsep):
            candidate = Path(entry or os.curdir).expanduser() / "git"
            if candidate.is_file() and os.access(candidate, os.X_OK):
                git_executables.add(str(candidate.absolute()))
                git_executables.add(str(candidate.resolve()))
        self._worker_git_executables = sorted(git_executables)
        return env

    def _launch(self, b, kind: str, events=None) -> None:
        """Launch one pinned run; Stage 2 kinds identify one chunk or the separate finalizer."""
        ts = int(self.clock())
        while any((self.paths.logs / f"batch-{b['id']}-{ts}.{x}").exists() for x in ("log", "exit")):
            ts += 1   # one launch per log: a launch in the same second must not reuse (and append to) an earlier log
        log, ex = self.paths.logs / f"batch-{b['id']}-{ts}.log", self.paths.logs / f"batch-{b['id']}-{ts}.exit"
        wt = b["worktree"]
        sid = b["session_id"]
        ad = self._adapter(b["producer"])
        try:   # never run with a CLI default model or effort
            run = self._run(b)
        except ValueError as e:
            return self._fail(b, "ERROR", f"실행 설정 오류로 AI를 시작하지 않았습니다: {e}")
        p = registry(self.cfg)[b["producer"]]
        tier_models = (p["models"].get("free", ""), p["models"].get("go", "")) if self._tiered(b["producer"]) else None
        drift = self._pin_drift(b, run, self._tiered(b["producer"]), self.store.runs(b["id"]), tier_models)
        if drift:
            return self._fail(b, "ERROR", drift)
        # Every launch proves the CLI again (cached once proven); C review fixes also need the approved source index.
        problem = self._preflight(b["producer"], b["method"])
        if problem and problem.startswith(PREFLIGHT_PENDING):
            return   # still proving the pin in the background; the next tick retries this relaunch
        if problem:
            return self._fail(b, "ERROR", f"실행 전 확인 실패: {problem}")
        try:
            agent_env = self._agent_env()
        except Exception as e:
            return self._fail(b, "ERROR", f"AI 실행 환경 설정 실패: {e}")
        extra = {}
        if getattr(ad, "needs_git_dir", False):   # one rule for every launch kind: the owned worktree's Git admin dir
            try:
                extra["git_dir"] = self.git.worktree_gitdir(Path(wt))
            except Exception as e:
                return self._fail(b, "ERROR", f"worktree의 Git 관리 디렉터리를 확인할 수 없어 AI를 시작하지 않았습니다: {e}")
        try:
            run_env = self._launch_env(b, kind, agent_env)
            remote = "?"
            if isinstance(kind, str) and kind.startswith(("s2_chunk_", "c_chunk_", "d_chunk_", "ab_chunk_")):
                remote = self.git.remote_head(b["branch"])   # the one remote read, before any view/page/decision write
            if b["method"] == STAGE2_METHOD and kind.startswith("s2_"):
                phase = "finalize" if "_finalize_" in kind else "chunk"
                checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
                view = None
                if kind == "s2_chunk_new" and stage2.next_action(checkpoint) == "chunk":
                    # The Supervisor, not the AI, prepares the Part and renders the one compact chunk view; the whole
                    # view goes into the prompt and the AI only answers with its decisions.
                    bb, pp = stage2.split_key(b["batch"])
                    self.git.stage2_chunk_view(Path(wt), b["shard"], bb, pp, prepare=checkpoint is None)
                    checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
                    if stage2.next_action(checkpoint) == "finalize":
                        self.store.log(b["id"], "prepare 결과 판정할 필수 후보가 없어 바로 최종화 단계로 진행합니다.")
                        return self._launch(b, "s2_finalize_new")
                    view = (Path(wt) / stage2.CHUNK_VIEW).read_text("utf-8")
                    stage2.clear_decisions(wt)   # a new chunk never inherits the previous chunk's decision file
                if stage2.next_action(checkpoint) != phase:
                    raise prompts.PromptError("Stage 2 실행 단계와 현재 checkpoint 상태가 다릅니다")
                title = f"Stage 2 {stage2.label(b['shard'], b['batch'])} {phase}"
                if kind == "s2_chunk_fix":
                    # Correction of the unsaved pending chunk: same session, same baseline, no new prepare/view/cursor.
                    problem = self._stage2_chunk_boundary_problem(b)
                    if problem:
                        return self._fail(b, "ERROR", problem)
                    detail = self._s2_fix_problem.pop(b["id"], None)
                    if not sid or not checkpoint["pending_chunk"] or not detail:
                        raise prompts.PromptError("수정 요청에 기존 세션·pending 청크·오류 목록이 모두 필요합니다")
                    prompt = prompts.stage2_chunk_fix(checkpoint["pending_chunk"], detail)
                    h = ad.resume(sid, prompt, wt, run_env, run, log, ex, **extra)
                else:
                    if kind == "s2_chunk_resume":
                        if not checkpoint["pending_chunk"]:
                            raise prompts.PromptError("이어갈 pending 청크가 없습니다")
                        prompt = prompts.stage2_chunk_resume(checkpoint["pending_chunk"])
                    else:
                        prompt = prompts.stage2(b, phase, checkpoint, resumed=kind.endswith("_resume"), view=view)
                    if phase == "chunk":
                        # Snapshot the checkpoint and both Git refs before each chunk; neither may move mid-run.
                        baseline = {"checkpoint": checkpoint, "branch": b["branch"], "worktree": str(wt),
                                    "head": self.git.head(wt), "remote_head": remote}
                        self.store.set(stage2.run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                    else:
                        self.store.delete(stage2.run_start_key(b["id"]))
                    if kind.endswith("_resume"):
                        h = ad.resume(sid, prompt, wt, run_env, run, log, ex, **extra)
                    else:
                        h = ad.start(prompt, wt, run_env, run, title, log, ex, **extra)
            elif b["method"] == literary.METHOD and kind in ("c_chunk_new", "c_chunk_resume"):
                prompt, baseline = self._c_chunk_prompt(b, kind, remote)
                self.store.set(literary.run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                title = f"C {b['shard']}_{b['batch']} chunk {baseline['chunk_no']:03d}"
                if kind == "c_chunk_resume":
                    h = ad.resume(sid, prompt, wt, run_env, run, log, ex, **extra)
                else:
                    h = ad.start(prompt, wt, run_env, run, title, log, ex, **extra)
            elif b["method"] == dchunk.METHOD and kind in ("d_chunk_new", "d_chunk_resume"):
                prompt, baseline = self._d_chunk_prompt(b, kind, remote)
                self.store.set(dchunk.run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                title = f"D {b['shard']}_{b['batch']} chunk {baseline['chunk_no']:03d}"
                if kind == "d_chunk_resume":
                    h = ad.resume(sid, prompt, wt, run_env, run, log, ex, **extra)
                else:
                    h = ad.start(prompt, wt, run_env, run, title, log, ex, **extra)
            elif b["method"] in stage1ab.METHODS and kind in ("ab_chunk_new", "ab_chunk_retry"):
                prompt, baseline, resume = self._ab_chunk_prompt(b, kind, remote)
                self.store.set(stage1ab.run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                title = f"{b['method'].upper()} {b['shard']}_{b['batch']} chunk {baseline['chunk_no']:03d}"
                if resume:
                    h = ad.resume(sid, prompt, wt, run_env, run, log, ex, **extra)
                else:
                    h = ad.start(prompt, wt, run_env, run, title, log, ex, **extra)
            elif kind == "produce":
                h = ad.start(prompts.produce(b), wt, run_env, run,
                                       f"{b['method'].upper()} {b['shard']}_{b['batch']}", log, ex, **extra)
            elif kind == "produce_resume":
                h = ad.resume(sid, prompts.recovery(b, resolved_defects=self.maint.resolved_note(b)), wt, run_env, run, log, ex, **extra)
            elif kind == "produce_recover":
                h = ad.start(prompts.recovery(b, resolved_defects=self.maint.resolved_note(b)), wt, run_env, run,
                                       f"{b['method'].upper()} {b['shard']}_{b['batch']} recover", log, ex, **extra)
            elif kind == "fix_resume":
                h = ad.resume(sid, prompts.fix(b, events, True), wt, run_env, run, log, ex, **extra)
            else:  # fix_new
                context = self._ab_fix_context(b, events) if b["method"] in stage1ab.METHODS else ""
                h = ad.start(prompts.fix(b, events, False, source_context=context), wt, run_env, run,
                                       f"PR {b['pr_number']} fix", log, ex, **extra)
        except prompts.PromptError as e:   # rendered before any process is started
            return self._fail(b, "ERROR", f"프롬프트 오류로 AI를 시작하지 않았습니다: {e}")
        except TRANSIENT:
            raise
        except Exception as e:
            return self._fail(b, "ERROR", f"AI 실행 시작 실패: {e}")
        self.store.set(f"headlag_{b['id']}", "")   # a new run supersedes any earlier push verification
        self._clear_batch_retry(b["id"])
        state = "FIXING" if kind.startswith("fix") else "PRODUCING"
        fields = dict(state=state, pid=h.pid, exit_file=str(ex), log_file=str(log),
                      run_kind=kind, retry_after=None, error=None)
        if kind == "fix_new" or kind in ("produce", "produce_recover", "s2_chunk_new", "s2_finalize_new", "c_chunk_new",
                                         "d_chunk_new", "ab_chunk_new"):
            fields["session_id"] = None  # captured from the new run's log
        self.store.update(b["id"], **fields)
        self.store.add_run(b["id"], kind, fields.get("session_id", sid), h.pid, log, ex,
                           model=run.model, effort=run.effort, permission_profile=run.permission_profile)
        if events:  # claim only after the run really started
            self.store.mark_handled(b["id"], b["pr_number"], b["head_sha"], [e["key"] for e in events])
        tier = f", tier={b['model_tier']}" if self._tiered(b["producer"]) else ""
        self.store.log(b["id"], f"{state} 시작 ({kind}, model={run.model}, effort={run.effort}{tier})")

    def _retry_denied_success(self, b) -> bool:
        """Retry after a denial pause: if the last exited run was a successful one (own session/result evidence) whose only
        problem was its permission denials, re-run the same completion evidence check instead of relaunching the AI."""
        if b["state"] == "FIXING":   # a fix denial is never cleared (see _denied_run_problem): Retry re-runs the fix
            return False
        runs = self.store.runs(b["id"])
        # "unknown": the exit file was lost (e.g. a Supervisor restart). "stopped": the pre-#1832 denial pause stopped the
        # still-live CLI right after its final result. In both the log's own final success result, session and denial
        # evidence below, plus the owned-PR/Part verify gate, replace the exit code (a run stopped mid-way has no result).
        if not runs or runs[0]["ended_at"] is None or str(runs[0]["exit_status"]) not in ("0", "unknown", "stopped"):
            return False
        log = Path(runs[0]["log_file"] or "")
        ad = self._adapter(b["producer"])
        if not ad.denied_actions(log):
            return False
        if ad.completion_problem(log, self._recorded_run(b), b["session_id"], b["worktree"], self.env):
            return False   # not a clean success otherwise: the regular handling decides
        why = self._denied_run_problem(b)
        if why is not None:
            # No proof the required work finished: the operator's explicit Retry takes the regular relaunch path
            # (owned-PR recovery checks, then session resume), never a re-pause on the old log.
            self.store.log(b["id"], f"권한 거부 후 Retry: 완료 증거 없음({why}) — 기존 재개 경로로 진행", "warn")
            return False
        self.store.log(b["id"], "권한 거부가 있었으나 소유 PR·push된 HEAD·Part verify로 필수 작업 완료를 확인했습니다 — 리뷰 감시로 인계", "warn")
        self.store.set(f"verified_completion_run_{b['id']}", str(runs[0]["id"]))
        self._run_ok(b)
        return True

    def _relaunch(self, b) -> None:
        self._guarded(b, "prelaunch", self._relaunch_do, entrypoint="relaunch")

    def _relaunch_do(self, b) -> None:
        if self._retry_denied_success(b):
            return
        if self._c_chunk_run(b) and not b["pr_number"]:
            return self._relaunch_c(b)
        if b["method"] == literary.METHOD and not b["pr_number"] and b["run_kind"] == "c_finalize":
            return self._c_finalize(b)
        if self._d_chunk_run(b) and not b["pr_number"]:
            return self._relaunch_d(b)
        if b["method"] == dchunk.METHOD and not b["pr_number"] and b["run_kind"] == "d_finalize":
            return self._d_finalize(b)
        if self._ab_chunk_run(b) and not b["pr_number"]:
            return self._relaunch_ab(b)
        if b["method"] in stage1ab.METHODS and not b["pr_number"] and b["run_kind"] == "ab_finalize":
            return self._ab_finalize(b)
        if b["method"] == STAGE2_METHOD and not b["pr_number"] and \
                isinstance(b["run_kind"], str) and b["run_kind"].startswith("s2_chunk_"):
            self.maint.adopt_released_baseline(b)
            problem = self._stage2_chunk_boundary_problem(b)
            if problem:
                return self._fail(b, "ERROR", problem)
            try:
                if self._find_recovery_pr(b) is not None:
                    return self._fail(b, "ERROR", "청크 실행 브랜치에 이미 PR이 있어 자동 재개를 중단합니다. "
                                      "PR과 worktree를 보존합니다.")
            except TRANSIENT:
                raise
            except Exception as e:
                return self._fail(b, "ERROR", f"청크 재개 전 기존 PR 소유권 확인 실패: {e}. worktree를 보존합니다.")
            if self._stage2_chunk_saved(b):
                self.store.log(b["id"], "이전 실행의 검증된 checkpoint 청크 저장을 확인했습니다. 같은 결정을 다시 만들지 않고 다음 새 세션으로 진행합니다.")
                self.store.delete(stage2.run_start_key(b["id"]))
                self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
                return self._launch_stage2_next(self.store.batch(b["id"]))
            pending = self._stage2_pending(b)
            if pending is not None and stage2.decisions_header(b["worktree"]) == pending:
                # Restart / Retry: re-validate the saved decisions of THIS chunk only (an older chunk's file is "no
                # response"); no AI run, and no failure is recorded for this re-check.
                try:
                    ok, detail = self._stage2_save(b)
                except TRANSIENT:
                    raise
                except (OSError, ValueError, GitError) as e:
                    return self._fail(b, "ERROR", f"저장된 판정 재검증 실패: {e}. worktree를 보존합니다.")
                if ok:
                    return self._stage2_saved_or_fail(b)
                return self._stage2_rejected(b, detail)
            # An incomplete chunk may resume only its own session; without one, a fresh session reads the same pending
            # checkpoint chunk. It never selects a different Part or changes the owned checkout.
            kind = "s2_chunk_resume" if b["session_id"] else "s2_chunk_new"
            return self._launch(b, kind)
        if b["method"] == STAGE2_METHOD and not b["pr_number"] and \
                isinstance(b["run_kind"], str) and b["run_kind"].startswith("s2_finalize_"):
            try:
                info = self._find_recovery_pr(b)
            except TRANSIENT:
                raise
            except Exception as e:
                return self._fail(b, "ERROR", f"최종화 Retry 전 기존 PR 소유권 확인 실패: {e}. worktree를 보존합니다.")
            if info is not None:
                return self._handoff_recovered_pr(b, info, "운영자 Retry 직전")
            kind = "s2_finalize_resume" if b["session_id"] else "s2_finalize_new"
            return self._launch(b, kind)
        kind = b["run_kind"] or "produce"
        base = "fix" if kind.startswith("fix") else "produce"
        if base == "fix":
            if self._verified_fix_exit(b):
                # The fix run ended 0 with its own completion evidence: only its push is unverified. No AI, commit or push.
                try:
                    info = self.gh.pull(b["pr_number"])
                except TRANSIENT:
                    raise
                except Exception as e:
                    return self._fail(b, "ERROR", f"검증된 수정 실행 뒤 PR 조회가 확정적으로 실패했습니다: {e}. 보존합니다.")
                if self._check_fix_head(b, info) == "ok":
                    self._to_review(b, info)
                return
            return self._launch(b, self._fix_kind(b), self._all_events(b))
        if not b["pr_number"]:
            runs = self.store.runs(b["id"])
            if runs:
                try:
                    failed_code = int(runs[0]["exit_status"])
                except (TypeError, ValueError):
                    failed_code = None
                is_terminal_producer = (isinstance(runs[0]["kind"], str)
                                        and runs[0]["kind"].startswith("produce")
                                        and runs[0]["ended_at"] is not None)
                if is_terminal_producer and failed_code is not None and failed_code != 0:
                    cls = self._classify_run(b["producer"], runs[0]["log_file"])
                    if self._handoff_failed_pr(b, failed_code, cls):
                        return
                elif is_terminal_producer and failed_code == 0:
                    # Retry is an explicit request to relaunch, but it must first rule out a PR from the prior run.
                    # Only a run that passed its completion gate can be adopted; an unverified zero exit is fail-closed.
                    try:
                        info = self._find_recovery_pr(b)
                    except TRANSIENT:
                        raise
                    except Exception as e:
                        self._fail(b, "ERROR", f"Retry 전 기존 PR 조회/검증 실패: {e}. "
                                   "worktree를 보존하고 AI를 재실행하지 않습니다.")
                        return
                    if info is not None:
                        if not self._verified_late_producer_exit(b):
                            self._fail(b, "ERROR", f"기존 소유 PR #{info['number']}을 확인했지만 종료 실행의 완료 증거가 "
                                       "없어 인계하거나 AI를 재실행하지 않습니다. worktree와 PR을 보존합니다.")
                            return
                        self._handoff_recovered_pr(b, info, "운영자 Retry 직전")
                        return
                elif is_terminal_producer and failed_code is None:
                    # An unknown exit status is not proof that production failed before creating a PR. Resolve the
                    # owned branch before an operator Retry; without completion evidence, never adopt a discovered PR.
                    try:
                        info = self._find_recovery_pr(b)
                    except TRANSIENT:
                        raise
                    except Exception as e:
                        self._fail(b, "ERROR", f"Retry 전 종료 상태가 불명확하고 기존 PR 조회/검증도 실패했습니다: {e}. "
                                   "worktree를 보존하고 AI를 재실행하지 않습니다.")
                        return
                    if info is not None:
                        self._fail(b, "ERROR", f"종료 상태를 확인할 수 없고 기존 소유 PR #{info['number']}이 있습니다. "
                                   "완료 증거가 없어 PR을 인계하거나 AI를 재실행하지 않습니다. "
                                   "worktree와 PR을 보존합니다.")
                        return
        self._launch(b, "produce_resume" if b["session_id"] else "produce_recover")

    # ---- PRODUCING / FIXING -------------------------------------------
    def _poll_run(self, b) -> None:
        if self._scan_report(b):
            return
        if b["pid"] is None:  # backoff elapsed, or operator Retry after PAUSED/ERROR
            if self._pending_gate(b):
                return   # a retryable query failed earlier: re-judge exactly that, never relaunch the AI
            if b["state"] == "FIXING" and self.store.get(f"headlag_{b['id']}"):
                return self._recheck_fix_head(b)   # the fix already ran: only verify its push, never re-run the AI
            if b["retry_after"] is None or self.clock() >= b["retry_after"]:
                self._relaunch(b)
            return
        ad = self._adapter(b["producer"])
        sid = b["session_id"] or ad.session_id(Path(b["log_file"]))
        if sid and sid != b["session_id"]:
            self.store.update(b["id"], session_id=sid)
            self.store.set_run_session(b["id"], sid)
            b = self.store.batch(b["id"])
        self._record_progress(b)
        tolerant = {"tolerate_denied": True} if (self._ab_chunk_run(b) or self._s2_chunk_run(b)) \
            and getattr(ad, "supports_tolerate_denied", False) else {}
        problem = ad.run_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"], **tolerant)
        if problem:   # the CLI contradicts its pins: stop it, keep worktree/PR, wait for the operator
            state, msg = problem
            if ad.alive(b["pid"]):
                ad.stop(b["pid"])
            return self._fail(b, state, msg)
        if ad.alive(b["pid"]):
            if b["state"] == "PRODUCING" and not self._c_chunk_run(b) and not self._d_chunk_run(b) \
                    and not self._ab_chunk_run(b):
                self._adopt_pr_while_running(b)
            return
        code = ad.exit_code(Path(b["exit_file"]))
        self.store.update(b["id"], pid=None)
        self.store.finish_runs(b["id"], code)
        b = self.store.batch(b["id"])
        if code is None:
            return self._fail(b, "ERROR", "AI 프로세스가 종료 상태 기록 없이 사라졌습니다. "
                              "자동 재생산하지 않음 — worktree/PR 확인 후 Retry.")
        last = self._last_run(b)
        if code == 0:
            return self._guarded(b, "exit0", self._judge_exit0, run_id=last["id"] if last else None)
        self._guarded(b, "exit_failed", lambda x: self._run_failed(x, code), run_id=last["id"] if last else None, code=code)

    def _judge_exit0(self, b) -> None:
        """Accept the result only with the run's own evidence (Claude: the session its init event reported; Codex: its
        thread id and turn record). Reads the log and GitHub only, so a retryable query failure re-runs just this."""
        ad = self._adapter(b["producer"])
        problem = ad.completion_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"],
                                        b["worktree"], self.env)
        if problem:
            return self._fail(b, problem[0], problem[1])
        if not self._denials_cleared(b, Path(b["log_file"])):
            return
        runs = self.store.runs(b["id"])
        if runs:
            self.store.set(f"verified_completion_run_{b['id']}", str(runs[0]["id"]))
        return self._run_ok(b)

    def _denials_cleared(self, b, log_file: Path) -> bool:
        """True: the exited, otherwise successful run had no permission denial, or its required work is proven done.

        Invariant: a permission denial pauses the run unless the owned PR is open at the pushed local HEAD AND the exact
        Part `verify` passes on that HEAD (Stage 2 only). Nothing is relaxed in the CLI permissions; a real block of a
        required step leaves the PR missing, unpushed or failing verify, so it stays PAUSED. False: already failed."""
        denied = self._adapter(b["producer"]).denied_actions(log_file)
        if not denied:
            return True
        if self._ab_chunk_run(b) or (self._s2_chunk_run(b) and b["state"] == "PRODUCING"):
            # Answer-only: a refused tool call is a metric, not a failure. The answer is judged by its block and its save,
            # and any real side effect (dirty tracked tree, moved HEAD/remote) by `_run_ok_ab_chunk`.
            self.store.log(b["id"], f"answer-only 청크에서 도구 호출 {len(denied)}건이 거부됐습니다 (부작용 없으면 실패 아님)", "warn")
            return True
        names = sorted({str(d.get("tool_name")) for d in denied})
        cmds = [" ".join(str((d.get("tool_input") or {}).get("command", "")).split())[:80] for d in denied
                if isinstance(d.get("tool_input"), dict) and (d.get("tool_input") or {}).get("command")]
        what = f"도구: {', '.join(names)}" + (f"; 명령: {' | '.join(cmds[:3])}" if cmds else "")
        pause = (f"로컬 CLI 권한 정책상 거부되어 실행이 불완전합니다 ({what}). 자동 권한 상승 없이 중지합니다. "
                 "로컬 Claude 설정을 직접 확인한 뒤 Retry 하세요 (worktree·PR·세션 보존).")
        why = self._denied_run_problem(b)
        if why is None:
            self.store.log(b["id"], f"권한 거부 {len(denied)}건({what}) 있었으나 소유 PR·push된 HEAD·Part verify로 "
                           "필수 작업 완료를 확인했습니다 — 리뷰 감시로 인계", "warn")
            return True
        self._fail(b, "PAUSED", f"{pause} 완료 증거 없음: {why}")
        return False

    def _denied_run_problem(self, b) -> str | None:
        """Why a run with permission denials cannot be accepted as complete, or None when the evidence is conclusive."""
        try:
            info = self._find_recovery_pr(b)
            if info is None:
                return "소유 브랜치에 PR이 없습니다"
            if b["pr_number"] and info["number"] != b["pr_number"]:
                return f"PR #{info['number']}이 기록된 PR #{b['pr_number']}과 다릅니다"
            if info["state"] != "open" or info["merged"]:
                return f"PR #{info['number']}이 열린 상태가 아닙니다"
            if b["state"] == "FIXING":
                # A pending review blocker is semantic: Part verify passes before and after, and a new HEAD proves only
                # some change. Nothing shows the denied edit was non-required, so the fix flow is preserved (PAUSED).
                return "리뷰 피드백 수정 실행의 권한 거부는 필수 편집이 반영됐다는 증거가 없어 완료로 인정하지 않습니다"
            wt = Path(b["worktree"])
            if self.git.dirty(wt).strip():
                return "worktree에 미커밋 변경이 있습니다"
            if b["method"] != STAGE2_METHOD:
                # A/B/C/D batches have no Part verify: the same proof as a clean run is the owned open PR carrying the
                # local HEAD from a clean worktree (the review gates validate the content).
                return None if self.git.head(wt) == info["head_sha"] else "worktree HEAD가 PR HEAD와 다릅니다(push 안 됨)"
            bb, pp = stage2.split_key(b["batch"])
            ok, tail = self.git.verify_stage2(self.git.head(wt), "part", b["shard"], bb, pp)
        except TRANSIENT:
            raise
        except Exception as e:
            return f"확인 실패: {e}"
        return None if ok else f"{stage2.label(b['shard'], b['batch'])} verify 실패: {tail}"

    def _scan_report(self, b) -> bool:
        """A producer's structured shared-defect report (its own worktree scratch file) pauses its batch. True: handled.

        The file must be unchanged since the previous tick while the AI still runs (it may be mid-write); the Maintainer
        itself never reports. The same content is the same event, so it is processed once.
        """
        if b["method"] == MAINTENANCE_METHOD:
            return False
        f = Path(b["worktree"]) / defects.REPORT_FILE
        try:
            st = f.stat()
            raw = f.read_text("utf-8", errors="replace")
        except OSError:
            return False
        if not raw.strip():
            return False
        key = defects.report_event_key(b["id"], raw)
        prior = self.store.defect_by_event(key)
        while prior is not None and prior["state"] == "RELEASED":
            # The same content written again after its fix was applied (resolved reports are archived at release) is
            # new evidence that the defect still reproduces on the fixed HEAD: a new event, not the resolved one.
            key = f"{key}:after:{prior['id']}"
            prior = self.store.defect_by_event(key)
        if prior is not None:
            return False
        ad = self._adapter(b["producer"])
        live = bool(b["pid"]) and ad.alive(b["pid"])
        sig, sig_key = f"{st.st_mtime_ns}:{st.st_size}", f"defect_file_{b['id']}"
        if live and self.store.get(sig_key) != sig:
            self.store.set(sig_key, sig)
            return False
        if live:
            ad.stop(b["pid"])   # the PID is cleared only once the exit is confirmed (_reap_stopped)
        self.maint.report(b, "report", key, raw)
        return True

    def _record_progress(self, b) -> None:
        """Observed progress of the current worktree only: the final file's records, else saved chunks/senses."""
        if b["method"] == STAGE2_METHOD:
            obs = progress.observe(b["worktree"], b["shard"], b["batch"], b["method"], b["producer"])
            fields = {"records_done": None, "progress_kind": obs[0] if obs else None,
                      "progress_done": obs[1] if obs else None, "progress_total": obs[2] if obs else None}
            changed = {k: v for k, v in fields.items() if v != b[k]}
            if changed:
                self.store.update(b["id"], **changed)
            return
        f = Path(b["worktree"]) / "data/relation-candidates" / b["shard"] / \
            f"{b['shard']}_{b['batch']}_{b['method']}_{b['producer']}.jsonl"
        try:
            with open(f, "rb") as fh:
                n = sum(1 for _ in fh)
            obs, fields = None, {"records_done": n}
        except OSError:
            obs = progress.observe(b["worktree"], b["shard"], b["batch"], b["method"], b["producer"])
            fields = {"records_done": None}   # the final file is not there (any more): a past count is not evidence
        fields.update(progress_kind=obs[0] if obs else None, progress_done=obs[1] if obs else None,
                      progress_total=obs[2] if obs else None)
        changed = {k: v for k, v in fields.items() if v != b[k]}
        if changed:
            self.store.update(b["id"], **changed)

    def _run_ok(self, b) -> None:
        if self._c_chunk_run(b) and b["state"] == "PRODUCING":
            return self._run_ok_c_chunk(b)
        if self._d_chunk_run(b) and b["state"] == "PRODUCING":
            return self._run_ok_d_chunk(b)
        if self._ab_chunk_run(b) and b["state"] == "PRODUCING":
            return self._run_ok_ab_chunk(b)
        if b["method"] == STAGE2_METHOD and b["state"] == "PRODUCING" and \
                isinstance(b["run_kind"], str) and b["run_kind"].startswith("s2_chunk_"):
            return self._run_ok_stage2_chunk(b)
        try:
            if b["state"] == "PRODUCING":
                info = self._find_recovery_pr(b) if b["method"] in {"a", "b", "c", "d"} else self._find_pr(b)
                if info is None:
                    refusal = self._adapter(b["producer"]).policy_refusal(Path(b["log_file"]))
                    if refusal:   # the local CLI policy stopped the PR step: keep everything, wait for the operator
                        return self._fail(b, "PAUSED", f"{refusal}. PR이 만들어지지 않았습니다. 로컬 설정을 확인한 뒤 "
                                          "Retry 하세요 (worktree·브랜치·세션 보존).")
                    cause = self.maint.resolved_note(b, short=True)
                    return self._fail(b, "ERROR", "AI가 정상 종료했지만 PR을 찾지 못했습니다 "
                                      "(자동 재생산 안 함, 로그 확인 후 Retry)." + (f" {cause}" if cause else ""))
            else:
                info = self.gh.pull(b["pr_number"])
        except DuplicateClaim as e:
            return self._fail(b, "ERROR", str(e))
        except TRANSIENT:
            raise
        except Exception as e:
            return self._fail(b, "ERROR", f"GitHub 조회 실패: {e}")
        if b["method"] == STAGE2_METHOD and b["state"] == "PRODUCING" and \
                isinstance(b["run_kind"], str) and b["run_kind"].startswith("s2_finalize_"):
            problem = self._stage2_final_pr_problem(b, info)
            if problem:
                denied = self._adapter(b["producer"]).denied_actions(Path(b["log_file"]))
                return self._fail(b, "PAUSED" if denied else "ERROR", problem)
        if b["state"] == "FIXING":
            if self._check_fix_head(b, info) != "ok":
                return
            if info["head_sha"] == b["head_sha"]:
                self.store.log(b["id"], "수정 실행이 끝났지만 새 HEAD 없음 (코멘트로만 응답했을 수 있음)", "warn")
        self._to_review(b, info)

    def _stage2_final_pr_problem(self, b, info) -> str | None:
        """Require a complete merged checkpoint and exact Part verify on the PR's pushed worktree HEAD."""
        try:
            checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
            if checkpoint is None or not checkpoint["complete"] or checkpoint["pending_chunk"] is not None or \
                    checkpoint["decided"] != checkpoint["total"] or not checkpoint["merged"]:
                return "Stage 2 finalizer PR 거부: checkpoint가 모든 decision 저장 및 merge 완료 상태가 아닙니다"
            if info.get("head_ref") != b["branch"]:
                return "Stage 2 finalizer PR의 head 브랜치가 이 Part의 소유 브랜치와 다릅니다"
            wt = Path(b["worktree"])
            if self.git.dirty(wt).strip():
                return "Stage 2 finalizer PR 거부: worktree에 미커밋 변경이 있습니다"
            head = self.git.head(wt)
            if not head or head != info.get("head_sha"):
                return f"Stage 2 finalizer PR HEAD와 소유 worktree HEAD가 다릅니다 ({info.get('head_sha')} / {head})"
            batch, part = stage2.split_key(b["batch"])
            ok, tail = self.git.verify_stage2(head, "part", b["shard"], batch, part)
            if not ok:
                return f"{stage2.label(b['shard'], b['batch'])} PR HEAD verify 실패: {tail}"
        except TRANSIENT:
            raise
        except Exception as e:
            return f"Stage 2 finalizer PR 검증 실패: {e}"
        return None

    def _stage2_chunk_saved(self, b) -> bool:
        """Compare the current checkpoint to the saved chunk-run baseline."""
        raw = self.store.get(stage2.run_start_key(b["id"]))
        if raw is None:
            return False
        try:
            baseline = json.loads(raw)
            if not isinstance(baseline, dict) or "checkpoint" not in baseline:
                return False
            after = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
        except (OSError, ValueError, KeyError, TypeError):
            return False
        return stage2.chunk_saved_since(baseline["checkpoint"], after)

    def _stage2_chunk_boundary_problem(self, b, key: str | None = None) -> str | None:
        """Fail closed if a chunk run changed or lost the Part's owned HEAD or remote branch ref."""
        raw = self.store.get(key or stage2.run_start_key(b["id"]))
        if raw is None:
            return "Stage 2 청크의 Git 경계 기준이 없어 Retry를 중단합니다. worktree와 브랜치를 보존합니다."
        try:
            baseline = json.loads(raw)
            if not isinstance(baseline, dict) or baseline.get("branch") != b["branch"] or \
                    baseline.get("worktree") != str(b["worktree"]) or not isinstance(baseline.get("head"), str) or \
                    "remote_head" not in baseline:
                return "Stage 2 청크의 Git 경계 기준이 손상되거나 다른 Part를 가리킵니다. worktree를 보존합니다."
            head = self.git.head(Path(b["worktree"]))
            if head != baseline["head"]:
                return f"Stage 2 청크 실행 중 소유 HEAD가 변경됐습니다 ({baseline['head']} / {head}). 후속 실행을 중단합니다."
            remote = self.git.remote_head(b["branch"])
            if remote != baseline["remote_head"]:
                return (f"Stage 2 청크 실행 중 원격 브랜치 {b['branch']}가 변경됐습니다 "
                        f"({baseline['remote_head']} / {remote}). 후속 실행을 중단합니다.")
        except TRANSIENT:
            raise
        except Exception as e:
            return f"Stage 2 청크의 HEAD/원격 브랜치 경계를 확인하지 못했습니다: {e}. worktree를 보존합니다."
        return None

    @staticmethod
    def _s2_chunk_run(b) -> bool:
        return b["method"] == STAGE2_METHOD and isinstance(b["run_kind"], str) and b["run_kind"].startswith("s2_chunk_")

    def _stage2_pending(self, b) -> str | None:
        try:
            checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
        except (OSError, ValueError, KeyError, TypeError):
            return None
        return checkpoint["pending_chunk"] if checkpoint else None

    def _stage2_response(self, b) -> list[str] | None:
        """The `c<n>` rows of this run's final answer for the CURRENT pending chunk, or None (no response)."""
        pending = self._stage2_pending(b)
        if pending is None:
            return None
        return stage2.extract_decisions(self._adapter(b["producer"]).final_answer(Path(b["log_file"])), pending)

    def _stage2_save(self, b) -> tuple[bool, str]:
        bb, pp = stage2.split_key(b["batch"])
        ok, detail = self.git.stage2_save_chunk(Path(b["worktree"]), b["shard"], bb, pp)
        extra = stage2.unknown_aliases(detail) if not ok else []
        if extra:   # a row for a candidate this chunk does not have can never be saved or corrected: drop it, then re-check
            stage2.write_decisions(b["worktree"], stage2.decisions_header(b["worktree"]),
                                   [r for r in stage2.read_rows(b["worktree"]) if stage2.alias_of(r) not in extra])
            self.store.log(b["id"], f"청크에 없는 후보 별칭 행 {', '.join(extra)}을 제거하고 다시 검증합니다", "warn")
            ok, detail = self.git.stage2_save_chunk(Path(b["worktree"]), b["shard"], bb, pp)
        return ok, detail

    def _stage2_accept(self, b) -> None:
        self._clear_batch_retry(b["id"])
        self.store.delete(stage2.run_start_key(b["id"]))
        self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
        self.store.log(b["id"], "Stage 2 청크가 admission-cli save-chunk를 통과해 checkpoint에 저장됐습니다. 다음 단계는 새 세션으로 실행합니다.")
        return self._launch_stage2_next(self.store.batch(b["id"]))

    def _stage2_saved_or_fail(self, b) -> None:
        if not self._stage2_chunk_saved(b):
            return self._fail(b, "ERROR", "save-chunk가 성공했지만 checkpoint가 시작 시점 대비 정확히 한 청크만 전진하지 않았습니다. "
                              "자동 재생산하지 않고 worktree와 기록을 보존합니다.")
        return self._stage2_accept(b)

    def _stage2_rejected(self, b, diagnostic: str) -> None:
        """The pending chunk's decisions failed `save-chunk` (checkpoint unchanged, decision file kept): ask the SAME
        session to correct only the reported rows, at most `MAX_FIXES` times since the chunk's new session."""
        if stage2.fixes_used(self.store.runs(b["id"])) < stage2.MAX_FIXES and b["session_id"]:
            self._s2_fix_problem[b["id"]] = diagnostic
            self.store.update(b["id"], retries=0, retry_after=None, error=None)
            return self._launch(self.store.batch(b["id"]), "s2_chunk_fix")
        return self._fail(b, "ERROR", "Stage 2 청크 판정이 저장 검증을 통과하지 못했고 자동 수정 기회가 없습니다 "
                          f"(결정 파일 {stage2.DECISIONS} 보존; 오너 Retry는 같은 청크를 새 세션으로 다시 시작): {diagnostic[:600]}")

    def _run_ok_stage2_chunk(self, b) -> None:
        """Accept one saved chunk as an intermediate success; never accept or create an intermediate PR.

        The AI only answered: its final answer's rows for the current chunk become the decision file and the
        Supervisor runs `save-chunk`. A first-response rejection is recorded on that AI run."""
        problem = self._stage2_chunk_boundary_problem(b)
        if problem:
            return self._fail(b, "ERROR", problem)
        try:
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._fail(b, "ERROR", f"청크 실행 중 소유 브랜치에 예상하지 않은 PR #{info['number']}이 있습니다. "
                                  "PR과 worktree를 보존하고 자동 인계하지 않습니다.")
        except TRANSIENT:
            raise
        except Exception as e:
            return self._fail(b, "ERROR", f"중간 청크 종료 후 기존 PR 소유권 확인 실패: {e}. worktree를 보존합니다.")
        if self._stage2_chunk_saved(b):
            return self._stage2_accept(b)
        rows = self._stage2_response(b)
        if rows is None:   # no `chunk <current id>` header: nothing to save, no correction or failure is consumed
            return self._fail(b, "ERROR", "Stage 2 청크 실행은 종료됐지만 현재 청크 ID 헤더가 있는 판정 응답이 없고 시작 시점 대비 "
                              "checkpoint가 정확히 전진하지 않았거나 pending_chunk가 남아 있습니다. 자동 재생산하지 않고 worktree와 기록을 보존합니다.")
        pending = self._stage2_pending(b)
        try:
            if b["run_kind"] == "s2_chunk_fix":
                ok, detail = self._stage2_save(b)   # the same rejection the fix prompt was built from, to find its rows
                if ok:
                    return self._stage2_saved_or_fail(b)
                targets = stage2.error_aliases(detail)
                merged, ignored = stage2.merge_fix(stage2.read_rows(b["worktree"]), rows, targets)
                if ignored:
                    self.store.log(b["id"], f"수정 응답의 허용 범위 밖 행 {len(ignored)}개를 무시했습니다: "
                                   f"{', '.join(stage2.alias_of(r) for r in ignored[:10])}", "warn")
                stage2.write_decisions(b["worktree"], pending, merged)
            else:
                stage2.write_decisions(b["worktree"], pending, rows)
            ok, detail = self._stage2_save(b)
        except TRANSIENT:
            raise
        except (OSError, ValueError, GitError) as e:
            return self._fail(b, "ERROR", f"판정 저장 처리 실패: {e}. worktree를 보존합니다.")
        if ok:
            return self._stage2_saved_or_fail(b)
        self.store.add_submit_failure(b["id"])
        self.store.log(b["id"], f"Stage 2 청크 저장 거부: {detail[:300]}", "warn")
        return self._stage2_rejected(b, detail)

    # ---- Method C: serial chunks, then deterministic finalization (Issue #2033) ----------------------------------
    @staticmethod
    def _c_chunk_run(b) -> bool:
        return b["method"] == literary.METHOD and isinstance(b["run_kind"], str) and b["run_kind"].startswith("c_chunk_")

    def _c_db(self) -> str:
        return str(Path(self.cfg["literary_index_path"].strip()).expanduser())

    def _c_env(self, b) -> dict:
        return self._launch_env(b, "c_cli", self.env)

    def _c_head_problem(self, b, wt: Path) -> str | None:
        """The checkpoint is bound to the HEAD it was created on; the only later HEAD allowed is our own Candidate commit."""
        try:
            created = literary.checkpoint_head(wt, b)
            head = self.git.head(wt)
        except TRANSIENT:
            raise
        except Exception as e:
            return f"checkpoint/HEAD 결속을 확인하지 못했습니다: {e}"
        if head == created or head == self.store.get(f"c_commit_head_{b['id']}"):
            return None
        try:   # a crash between our commit and recording it: accept only that exact commit, then remember it
            if self.git.is_candidate_child(wt, created, literary.names(b).output):
                self.store.set(f"c_commit_head_{b['id']}", head)
                return None
        except GitError:
            pass
        return f"worktree HEAD {head[:10]}가 checkpoint 기준 HEAD {created[:10]}도, Supervisor가 만든 Candidate commit도 아닙니다."

    def _launch_c_next(self, b) -> None:
        self._guarded(b, "prelaunch", self._launch_c_next_do, entrypoint="launch_c_next")

    def _launch_c_next_do(self, b) -> None:
        """Advance Method C: init once, then the active chunk (resume or render a new one), or finalize when all done."""
        wt = Path(b["worktree"])
        try:
            if not literary.checkpoint_exists(wt, b):
                literary.init_checkpoint(self.runner, self._c_env(b), wt, b, self._c_db())
            elif problem := self._c_head_problem(b, wt):
                return self._fail(b, "ERROR", problem + " worktree를 보존합니다.")
            rec = literary.read_active(wt, b)
            if rec is not None:
                if literary.chunk_finished(self.runner, self._c_env(b), wt, b, rec):
                    literary.clear_active(wt)
                    rec = None
                else:
                    literary.read_view(wt, rec)   # the view must still be the one this record was written for
            if rec is None and literary.all_done(literary.summary(self.runner, self._c_env(b), wt, b)):
                return self._c_finalize(b)
            for _ in range(60):   # chunks that only advance ZERO_HITS render empty: re-evaluate, bounded
                if rec is not None:
                    break
                view = literary.render_chunk(self.runner, self._c_env(b), wt, b, self._c_db())
                ids, failed, unsearchable = literary.view_ids(view)
                done, total, zero, _unread = literary.progress_numbers(view)
                if failed:
                    literary.write_active(wt, b, view, ids, self.git.head(wt), self._c_next_no(b))
                    return self._fail(b, "PAUSED", f"SEARCH_FAILED sense {failed}: 승인 index 진단이 필요합니다 (stop_and_report). "
                                      "AI를 시작하지 않았습니다.")
                if not ids:
                    if literary.all_done(literary.summary(self.runner, self._c_env(b), wt, b)):
                        return self._c_finalize(b)
                    if zero == 0:
                        return self._fail(b, "ERROR", "chunk가 항목도 ZERO_HITS 진전도 없이 비었는데 미완료 sense가 남았습니다. 보존합니다.")
                    continue
                literary.sense_report(self.runner, self._c_env(b), wt, b, ids)   # unknown / damaged ids fail closed
                rec = literary.write_active(wt, b, view, ids, self.git.head(wt), self._c_next_no(b))
            if rec is None:
                return self._fail(b, "ERROR", "chunk가 60번 연속 비어 진행하지 않습니다. 보존합니다.")
        except (literary.LiteraryError, OSError, ValueError, GitError) as e:
            return self._fail(b, "ERROR", f"Method C 상태 확인 실패: {e}. worktree를 보존합니다.")
        resume = bool(b["session_id"]) and self.store.get(literary.run_start_key(b["id"])) is not None
        return self._launch(b, "c_chunk_resume" if resume else "c_chunk_new")

    def _c_next_no(self, b) -> int:
        return 1 + sum(1 for r in self.store.runs(b["id"]) if r["kind"] == "c_chunk_new")

    def _c_chunk_prompt(self, b, kind: str, remote="?") -> tuple[str, dict]:
        """(prompt, run-start baseline) for the active chunk. A resume sends only the still-open sense ids."""
        wt = Path(b["worktree"])
        rec = literary.read_active(wt, b)
        if rec is None:
            raise prompts.PromptError("활성 청크 기록이 없습니다")
        view = literary.read_view(wt, rec)
        checkpoint = literary.names(b).checkpoint
        if kind == "c_chunk_resume":
            if rec.get("repair"):   # these senses are already stored: all of them are re-judged
                remaining = list(rec["sense_ids"])
            else:
                state = literary.sense_report(self.runner, self._c_env(b), wt, b, rec["sense_ids"])
                remaining = [s["sense_id"] for s in state["senses"] if not s["done"]]
            if not remaining:
                raise prompts.PromptError("이어갈 미완료 sense가 없습니다")
            prompt = prompts.c_chunk_resume(rec["chunk_no"], checkpoint, remaining)
        else:
            card_bytes = len(prompts.c_chunk(b, rec["chunk_no"], checkpoint, view="", note=rec.get("note", "")).encode("utf-8"))
            if literary.delivery(card_bytes, view) == "inline":
                prompt = prompts.c_chunk(b, rec["chunk_no"], checkpoint, view=view, note=rec.get("note", ""))
            else:   # only this chunk falls back to pages; a failure here starts no AI
                prompt = prompts.c_chunk(b, rec["chunk_no"], checkpoint, pages=literary.write_pages(wt, view),
                                         note=rec.get("note", ""))
        baseline = {"branch": b["branch"], "worktree": str(wt), "head": self.git.head(wt),
                    "remote_head": self.git.remote_head(b["branch"]) if remote == "?" else remote, "chunk_no": rec["chunk_no"]}
        return prompt, baseline

    def _c_chunk_saved(self, b) -> bool:
        """Every sense of the active chunk is done by the CLI's own meaning (asked only when a run ended / on recovery)."""
        try:
            rec = literary.read_active(Path(b["worktree"]), b)
            return rec is not None and literary.chunk_finished(self.runner, self._c_env(b), Path(b["worktree"]), b, rec)
        except (literary.LiteraryError, OSError, ValueError):
            return False

    def _c_boundary_problem(self, b) -> str | None:
        return self._stage2_chunk_boundary_problem(b, literary.run_start_key(b["id"]))

    def _run_ok_c_chunk(self, b) -> None:
        """A zero exit is not success: the chunk counts only when its checkpoint says every sense is done."""
        problem = self._c_boundary_problem(b)
        if problem:
            return self._fail(b, "ERROR", problem)
        try:
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._fail(b, "ERROR", f"청크 실행 중 소유 브랜치에 예상하지 않은 PR #{info['number']}이 있습니다. 보존합니다.")
        except TRANSIENT:
            raise
        except Exception as e:
            return self._fail(b, "ERROR", f"청크 종료 후 기존 PR 소유권 확인 실패: {e}. worktree를 보존합니다.")
        if not self._c_chunk_saved(b):
            if self._c_resubmit(b):
                return
            return self._fail(b, "ERROR", "C 청크 실행이 종료됐지만 활성 청크의 모든 sense가 완료되지 않았습니다 (checkpoint 완료 증거 없음). "
                              "자동 재생산하지 않고 보존합니다 — Retry는 같은 청크의 미완료 sense만 이어갑니다.")
        self.store.delete(literary.run_start_key(b["id"]))
        self.store.delete(literary.resubmit_key(b["id"]))
        self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
        self.store.log(b["id"], "C 청크의 모든 sense 저장을 확인했습니다. 다음 단계는 새 세션으로 실행합니다.")
        try:
            literary.clear_active(Path(b["worktree"]))
        except OSError as e:
            return self._fail(b, "ERROR", f"활성 청크 정리 실패: {e}")
        return self._launch_c_next(self.store.batch(b["id"]))

    def _c_resubmit(self, b) -> bool:
        """The run ended with nothing saved and the CLI's own diagnostic marking the rejection repairable in place
        (`stop_and_report`, unknown or missing diagnostics never qualify).
        Ask the SAME session (candidates and judgments intact) to repair only that file, at most `MAX_RESUBMITS` times per chunk."""
        try:
            rec = literary.read_active(Path(b["worktree"]), b)
            left = rec is not None and literary.submit_retryable(Path(b["worktree"]), b, rec["chunk_no"])
        except (OSError, ValueError, literary.LiteraryError):
            return False
        used = int(self.store.get(literary.resubmit_key(b["id"])) or 0)
        if not left or not b["session_id"] or used >= literary.MAX_RESUBMITS:
            return False
        self.store.set(literary.resubmit_key(b["id"]), str(used + 1))
        self.store.update(b["id"], retries=0, retry_after=None, error=None)
        self.store.log(b["id"], f"C 청크 제출이 저장되지 않았습니다. 같은 세션에서 제출 파일만 국소 수정해 다시 제출합니다 ({used + 1}/{literary.MAX_RESUBMITS})", "warn")
        self._launch_c_next(self.store.batch(b["id"]))
        return True

    def _relaunch_c(self, b) -> None:
        problem = self._c_boundary_problem(b)
        if problem:
            return self._fail(b, "ERROR", problem)
        try:
            if self._find_recovery_pr(b) is not None:
                return self._fail(b, "ERROR", "청크 실행 브랜치에 이미 PR이 있어 자동 재개를 중단합니다. 보존합니다.")
        except TRANSIENT:
            raise
        except Exception as e:
            return self._fail(b, "ERROR", f"청크 재개 전 기존 PR 소유권 확인 실패: {e}. worktree를 보존합니다.")
        if self._c_chunk_saved(b):
            self.store.delete(literary.run_start_key(b["id"]))
            self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
            literary.clear_active(Path(b["worktree"]))
        return self._launch_c_next(self.store.batch(b["id"]))

    def _c_finalize(self, b) -> None:
        self._guarded(b, "finalize", self._c_finalize_do)

    def _c_finalize_do(self, b) -> None:
        """Export, commit, push and PR from current file / Git / GitHub facts; any step already true is skipped."""
        wt = Path(b["worktree"])
        n = literary.names(b)
        self.store.update(b["id"], state="PRODUCING", pid=None, run_kind="c_finalize")
        try:
            if problem := self._c_head_problem(b, wt):
                return self._fail(b, "ERROR", problem)
            label = registry(self.cfg)[b["producer"]].get("label", b["producer"])
            info = self._find_recovery_pr(b)
            if info is not None:   # a PR from an earlier, interrupted finalization (or a lost response)
                return self._to_review(b, info)
            exp = literary.ensure_export(self.runner, self._c_env(b), wt, b)
            if exp.status == "repair":
                return self._c_repair(b, exp)
            title = literary.pr_title(label, b)
            if not self.git.is_committed(wt, n.output):
                sha = self.git.commit_paths(wt, [n.output], title)
                self.store.set(f"c_commit_head_{b['id']}", sha)
                self.store.log(b["id"], f"Candidate 파일을 commit했습니다 ({sha[:10]})")
            else:
                self.store.set(f"c_commit_head_{b['id']}", self.git.head(wt))
            head, remote = self.git.head(wt), self.git.remote_head(b["branch"])
            if remote is None:
                self.git.push_branch(wt, b["branch"])
                remote = self.git.remote_head(b["branch"])
            if remote != head:
                return self._fail(b, "ERROR", f"원격 브랜치 {b['branch']}가 로컬 HEAD와 다릅니다 ({remote} / {head}). force push 없이 보존합니다.")
            if rival := self._shared_occupied(b):
                return self._fail(b, "ERROR", f"같은 C 배치가 이미 점유됐습니다 ({rival}). 다른 배치로 바꾸지 않고 보존합니다.")
            return self._create_pr_once(b, title, literary.pr_body(label, b, exp.coverage), [literary.PR_LABEL])
        except TRANSIENT:
            raise
        except (literary.LiteraryError, GitError, RecoveryBlocked, DuplicateClaim, OSError, ValueError) as e:
            return self._fail(b, "ERROR", f"C 최종화 중단: {e}. worktree를 보존합니다.")
        except Exception as e:
            return self._fail(b, "ERROR", f"C 최종화 중 GitHub/Git 오류: {e}. worktree를 보존합니다.")

    def _create_pr_once(self, b, title: str, body: str, labels: list[str]) -> None:
        """Open the batch PR at most once. Invariant: while it is unknown whether a create request made a PR, the request is
        never repeated; only the owned-branch lookup is (a transient 'unconfirmed' outcome raises GhTransient)."""
        key = f"pr_create_{b['id']}"
        raw = self.store.get(key)
        if raw is None:
            self.store.set(key, json.dumps({"head": self._local_head(b), "at": self.clock()}))
            try:
                self.gh.create_pr(b["branch"], self.cfg["base_branch"], title, body, labels)
            except GhTransient as e:   # unknown whether GitHub created it: look, never create again
                self.store.log(b["id"], f"PR 생성 응답 오류(생성 여부 미확정, 재생성 금지): {e}", "warn")
            except GhError as e:   # gh got an answer: a definite rejection unless it says the PR is already there
                if "already exists" not in str(e).lower():   # a definite rejection: nothing was created
                    self.store.delete(key)
                    return self._fail(b, "ERROR", f"PR 생성이 거부되었습니다(생성되지 않음): {e}. worktree·브랜치를 보존합니다.")
                self.store.log(b["id"], f"PR 생성이 같은 head/base의 기존 PR을 보고했습니다 — 소유권·HEAD를 확인합니다: {e}", "warn")
            except Exception as e:   # no answer to interpret (lost response, local failure): outcome unknown, never create again
                self.store.log(b["id"], f"PR 생성 응답 오류(생성 여부 미확정, 재생성 금지): {e}", "warn")
            raw = self.store.get(key)
        info = self._find_recovery_pr(b)
        if info is not None:
            self.store.delete(key)
            return self._to_review(b, info)
        try:
            waited = self.clock() - float(json.loads(raw)["at"])
        except (TypeError, ValueError, KeyError):
            waited = 0
        note = "PR 생성 여부 미확정 — 운영자 확인 필요(GitHub에서 소유 브랜치로 PR을 만들면 인계됩니다)" \
            if waited >= self.cfg["pr_head_lag_timeout_seconds"] else "PR 생성 반영 대기(목록 조회만 반복, 재생성 없음)"
        raise GhTransient(note)

    def _shared_occupied(self, b) -> str | None:
        """Claim at PR-creation time, same key as `_duplicate_claim` and `batches.next_batch`: A/B conflict only with
        the same producer's completed Candidate on master (#860); C/D (#1155/#1156) with any model's. Open formal PRs likewise."""
        base = f"origin/{self.cfg['base_branch']}"
        self.git.fetch_base(self.cfg["base_branch"])
        shared = batches.is_shared_queue(b["method"])
        for path in batches._candidate_counts(self.runner, self.paths.repo_root, self.env, base):
            m = batches._CAND.fullmatch(path)
            if m and (m.group(1), m.group(2), m.group(3)) == (b["shard"], b["batch"], b["method"]) \
                    and (shared or m.group(4) == b["producer"]):
                return f"master에 {path}"
        rival = self._duplicate_claim(b, 0)
        return f"열린 PR #{rival}" if rival else None

    def _c_repair(self, b, exp) -> None:
        """Candidate v1 named senses: re-read exactly those in a session, resubmit, then export again."""
        wt = Path(b["worktree"])
        key = f"c_repairs_{b['id']}"
        tries = int(self.store.get(key) or 0)
        if tries >= literary.MAX_REPAIRS:
            return self._fail(b, "ERROR", f"Candidate v1 검증 복구를 {literary.MAX_REPAIRS}번 시도했지만 해결되지 않았습니다: {exp.diagnostic}")
        self.store.set(key, str(tries + 1))
        try:
            view = literary.render_chunk(self.runner, self._c_env(b), wt, b, self._c_db(), sense_ids=list(exp.repair_ids))
            literary.write_active(wt, b, view, list(exp.repair_ids), self.git.head(wt), self._c_next_no(b),
                                  repair=True, checkpoint_sha=literary.checkpoint_sha(wt, b),
                                  note="Candidate v1 검증이 아래 Sense의 후보를 거부했다. 후보 문자열만 고쳐 이 Sense들을 다시 제출한다: "
                                       + exp.diagnostic + "\n")
        except (literary.LiteraryError, OSError) as e:
            return self._fail(b, "ERROR", f"복구 청크 준비 실패: {e}")
        self.store.log(b["id"], f"Candidate v1 거부 sense {list(exp.repair_ids)}만 재판정합니다 ({tries + 1}/{literary.MAX_REPAIRS})", "warn")
        self.store.update(b["id"], session_id=None)
        return self._launch(b, "c_chunk_new")

    # ---- Method D: serial 25-record chunks, then deterministic finalization (Issue #2034) ---------------------------
    @staticmethod
    def _d_chunk_run(b) -> bool:
        return b["method"] == dchunk.METHOD and isinstance(b["run_kind"], str) and b["run_kind"].startswith("d_chunk_")

    def _d_env(self, b) -> dict:
        return self._launch_env(b, "d_cli", self.env)

    def _d_head_problem(self, b, wt: Path) -> str | None:
        """The batch is bound to the HEAD of its first chunk; the only later HEAD allowed is our own Candidate commit."""
        try:
            head = self.git.head(wt)
            base = self.store.get(f"d_base_head_{b['id']}")
            if base is None:
                self.store.set(f"d_base_head_{b['id']}", head)
                return None
            if head == base or head == self.store.get(f"d_commit_head_{b['id']}"):
                return None
            if self.git.is_candidate_child(wt, base, dchunk.names(b).output):
                self.store.set(f"d_commit_head_{b['id']}", head)
                return None
        except TRANSIENT:
            raise
        except Exception as e:
            return f"HEAD 결속을 확인하지 못했습니다: {e}"
        return f"worktree HEAD {head[:10]}가 배치 기준 HEAD {base[:10]}도, Supervisor가 만든 Candidate commit도 아닙니다."

    def _d_chunks_problem(self, b, done: int) -> str | None:
        """Every chunk accepted earlier must still be byte-identical (an AI session never edits a saved chunk)."""
        wt = Path(b["worktree"])
        try:
            for k in range(1, done + 1):
                known = self.store.get(f"d_chunk_sha_{b['id']}_{k}")
                if known is not None and known != dchunk.chunk_sha(wt, b, k):
                    return f"이미 저장된 청크 {k:03d}이 수정되었습니다. 덮어쓰지 않고 보존합니다."
        except dchunk.DChunkError as e:
            return str(e)
        return None

    def _d_remember(self, b, done: int) -> None:
        """Record the SHA-256 of the newest accepted chunk the first time it is seen."""
        key = f"d_chunk_sha_{b['id']}_{done}"
        if done > 0 and self.store.get(key) is None:
            self.store.set(key, dchunk.chunk_sha(Path(b["worktree"]), b, done))

    def _launch_d_next(self, b) -> None:
        self._guarded(b, "prelaunch", self._launch_d_next_do, entrypoint="launch_d_next")

    def _launch_d_next_do(self, b) -> None:
        """Advance Method D from the saved files: the active chunk (resume or prepare a new one), or finalize when all saved."""
        wt = Path(b["worktree"])
        try:
            if problem := self._d_head_problem(b, wt):
                return self._fail(b, "ERROR", problem + " worktree를 보존합니다.")
            done, total = dchunk.verified_prefix(wt, b)
            if problem := self._d_chunks_problem(b, done):
                return self._fail(b, "ERROR", problem)
            self._d_remember(b, done)
            rec = dchunk.read_active(wt, b)
            if rec is not None:
                if rec["chunk_no"] <= done:
                    dchunk.clear_active(wt, b)   # that chunk is already saved
                    rec = None
                elif rec["chunk_no"] != done + 1:
                    return self._fail(b, "ERROR", f"활성 청크 {rec['chunk_no']}가 연속 prefix {done} 다음이 아닙니다. 보존합니다.")
                else:
                    dchunk.read_view(wt, b, rec)   # the view must still be the one this record was written for
            while rec is None:
                if done == total:
                    return self._d_finalize(b)
                res = dchunk.prepare(self.runner, self._d_env(b), wt, b, done + 1,
                                       str(Path(self.cfg["corpus_index_path"].strip()).expanduser()), self.git.head(wt))
                if res["status"] == "SEARCH_FAILED":
                    return self._fail(b, "PAUSED", f"SEARCH_FAILED record {res.get('failed_records')}: 승인 index 진단이 필요합니다 "
                                      "(stop_and_report). AI를 시작하지 않았습니다.")
                if res["status"] == "AUTO_COMPLETE":   # every sense mechanically proven ZERO_HITS: saved without an AI
                    new_done, _ = dchunk.verified_prefix(wt, b)
                    if new_done != done + 1:
                        return self._fail(b, "ERROR", "자동 완료 청크가 정확히 한 청크만 전진시키지 않았습니다. 보존합니다.")
                    done = new_done
                    self._d_remember(b, done)
                    self.store.log(b["id"], f"D 청크 {done:03d}: 모든 sense가 기계적으로 증명된 ZERO_HITS라 AI 없이 저장했습니다.")
                    continue
                rec = dchunk.read_active(wt, b)
                if rec is None or rec["chunk_no"] != done + 1:
                    return self._fail(b, "ERROR", "prepare가 활성 청크를 만들지 못했습니다. 보존합니다.")
        except (dchunk.DChunkError, OSError, ValueError, GitError) as e:
            return self._fail(b, "ERROR", f"Method D 상태 확인 실패: {e}. worktree를 보존합니다.")
        resume = bool(b["session_id"]) and self.store.get(dchunk.run_start_key(b["id"])) is not None
        return self._launch(b, "d_chunk_resume" if resume else "d_chunk_new")

    def _d_chunk_prompt(self, b, kind: str, remote="?") -> tuple[str, dict]:
        """(prompt, run-start baseline) for the active chunk. A resume sends only a short continue instruction."""
        wt = Path(b["worktree"])
        rec = dchunk.read_active(wt, b)
        if rec is None:
            raise prompts.PromptError("활성 청크 기록이 없습니다")
        view = dchunk.read_view(wt, b, rec)
        if kind == "d_chunk_resume":
            prompt = prompts.d_chunk_resume(rec["chunk_no"])
        else:
            card_bytes = len(prompts.d_chunk(b, rec["chunk_no"], view="").encode("utf-8"))
            if dchunk.delivery(card_bytes, view) == "inline":
                prompt = prompts.d_chunk(b, rec["chunk_no"], view=view)
            else:   # only this chunk falls back to pages; a failure here starts no AI
                prompt = prompts.d_chunk(b, rec["chunk_no"], pages=dchunk.write_pages(wt, b, view))
        baseline = {"branch": b["branch"], "worktree": str(wt), "head": self.git.head(wt),
                    "remote_head": self.git.remote_head(b["branch"]) if remote == "?" else remote, "chunk_no": rec["chunk_no"]}
        return prompt, baseline

    def _d_chunk_saved(self, b) -> bool:
        """The active chunk is stored: the verified prefix has reached exactly its number (asked when a run ended / on retry)."""
        try:
            rec = dchunk.read_active(Path(b["worktree"]), b)
            return rec is not None and dchunk.verified_prefix(Path(b["worktree"]), b)[0] >= rec["chunk_no"]
        except (dchunk.DChunkError, OSError, ValueError):
            return False

    def _d_accept_saved(self, b) -> str | None:
        """After a saved chunk: exactly one chunk advanced, nothing else changed. A problem string, or None."""
        wt = Path(b["worktree"])
        try:
            rec = dchunk.read_active(wt, b)
            done, _total = dchunk.verified_prefix(wt, b)
            if rec is None or done != rec["chunk_no"]:
                return f"저장된 청크 수({done})가 활성 청크({rec and rec['chunk_no']})와 맞지 않습니다. 보존합니다."
            if problem := self._d_chunks_problem(b, done - 1):
                return problem
            self._d_remember(b, done)
            dchunk.clear_active(wt, b)
        except (dchunk.DChunkError, OSError, ValueError) as e:
            return f"저장된 청크를 확인하지 못했습니다: {e}. 보존합니다."
        return None

    def _run_ok_d_chunk(self, b) -> None:
        """A zero exit is not success: the chunk counts only when its exact file is stored; then the next chunk starts anew."""
        problem = self._stage2_chunk_boundary_problem(b, dchunk.run_start_key(b["id"]))
        if problem:
            return self._fail(b, "ERROR", problem)
        try:
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._fail(b, "ERROR", f"청크 실행 중 소유 브랜치에 예상하지 않은 PR #{info['number']}이 있습니다. 보존합니다.")
        except TRANSIENT:
            raise
        except Exception as e:
            return self._fail(b, "ERROR", f"청크 종료 후 기존 PR 소유권 확인 실패: {e}. worktree를 보존합니다.")
        if not self._d_chunk_saved(b):
            return self._fail(b, "ERROR", "D 청크 실행이 종료됐지만 활성 청크가 저장되지 않았습니다 (chunk-NNN.jsonl 증거 없음). "
                              "자동 재생산하지 않고 보존합니다 — Retry는 같은 청크를 이어갑니다.")
        if problem := self._d_accept_saved(b):
            return self._fail(b, "ERROR", problem)
        self.store.delete(dchunk.run_start_key(b["id"]))
        self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
        self.store.log(b["id"], "D 청크 저장을 확인했습니다. 다음 단계는 새 세션으로 실행합니다.")
        return self._launch_d_next(self.store.batch(b["id"]))

    def _relaunch_d(self, b) -> None:
        problem = self._stage2_chunk_boundary_problem(b, dchunk.run_start_key(b["id"]))
        if problem:
            return self._fail(b, "ERROR", problem)
        try:
            if self._find_recovery_pr(b) is not None:
                return self._fail(b, "ERROR", "청크 실행 브랜치에 이미 PR이 있어 자동 재개를 중단합니다. 보존합니다.")
        except TRANSIENT:
            raise
        except Exception as e:
            return self._fail(b, "ERROR", f"청크 재개 전 기존 PR 소유권 확인 실패: {e}. worktree를 보존합니다.")
        if self._d_chunk_saved(b):
            if problem := self._d_accept_saved(b):
                return self._fail(b, "ERROR", problem)
            self.store.delete(dchunk.run_start_key(b["id"]))
            self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
        return self._launch_d_next(self.store.batch(b["id"]))

    def _d_finalize(self, b) -> None:
        self._guarded(b, "finalize", self._d_finalize_do)

    def _d_finalize_do(self, b) -> None:
        """Assemble, validate once, commit, push and PR from current file / Git / GitHub facts; any step already true is skipped."""
        wt = Path(b["worktree"])
        n = dchunk.names(b)
        self.store.update(b["id"], state="PRODUCING", pid=None, run_kind="d_finalize")
        try:
            if problem := self._d_head_problem(b, wt):
                return self._fail(b, "ERROR", problem + " worktree를 보존합니다.")
            label = registry(self.cfg)[b["producer"]].get("label", b["producer"])
            info = self._find_recovery_pr(b)
            if info is not None:   # a PR from an earlier, interrupted finalization (or a lost response)
                return self._to_review(b, info)
            done, total = dchunk.verified_prefix(wt, b)
            if done != total:
                return self._fail(b, "ERROR", f"모든 청크가 저장되지 않았습니다 ({done}/{total}). 보존합니다.")
            if problem := self._d_chunks_problem(b, done):
                return self._fail(b, "ERROR", problem)
            dchunk.assemble(wt, b)
            coverage = dchunk.validate(self.runner, self._d_env(b), wt, b)   # fails closed: no rewrite session exists
            title = dchunk.pr_title(label, b)
            if not self.git.is_committed(wt, n.output):
                sha = self.git.commit_paths(wt, [n.output], title)
                self.store.set(f"d_commit_head_{b['id']}", sha)
                self.store.log(b["id"], f"Candidate 파일을 commit했습니다 ({sha[:10]})")
            else:
                self.store.set(f"d_commit_head_{b['id']}", self.git.head(wt))
            head, remote = self.git.head(wt), self.git.remote_head(b["branch"])
            if remote is None:
                self.git.push_branch(wt, b["branch"])
                remote = self.git.remote_head(b["branch"])
            if remote != head:
                return self._fail(b, "ERROR", f"원격 브랜치 {b['branch']}가 로컬 HEAD와 다릅니다 ({remote} / {head}). force push 없이 보존합니다.")
            if rival := self._shared_occupied(b):
                return self._fail(b, "ERROR", f"같은 D 배치가 이미 점유됐습니다 ({rival}). 다른 배치로 바꾸지 않고 보존합니다.")
            return self._create_pr_once(b, title, dchunk.pr_body(label, b, coverage), [dchunk.PR_LABEL])
        except TRANSIENT:
            raise
        except (dchunk.DChunkError, GitError, RecoveryBlocked, DuplicateClaim, OSError, ValueError) as e:
            return self._fail(b, "ERROR", f"D 최종화 중단: {e}. worktree를 보존합니다.")
        except Exception as e:
            return self._fail(b, "ERROR", f"D 최종화 중 GitHub/Git 오류: {e}. worktree를 보존합니다.")

    # ---- Stage 1 A/B: serial 50-record answer-only chunks, then deterministic finalization (Issue #2035) -------------
    @staticmethod
    def _ab_chunk_run(b) -> bool:
        return b["method"] in stage1ab.METHODS and isinstance(b["run_kind"], str) and b["run_kind"].startswith("ab_chunk_")

    def _fix_kind(self, b) -> str:
        """A/B review fixes start a small new session (never a resume of a long production session)."""
        small = b["method"] in stage1ab.METHODS and self.cfg.get("ab_chunk_sessions", True)
        return "fix_new" if small or not b["session_id"] else "fix_resume"

    def _ab_head_problem(self, b, wt: Path) -> str | None:
        """The batch is bound to the HEAD of its first chunk; the only later HEAD allowed is our own Candidate commit."""
        try:
            head = self.git.head(wt)
            base = self.store.get(f"ab_base_head_{b['id']}")
            if base is None:
                self.store.set(f"ab_base_head_{b['id']}", head)
                return None
            if head == base or head == self.store.get(f"ab_commit_head_{b['id']}"):
                return None
            if self.git.is_candidate_child(wt, base, stage1ab.names(b).output):
                self.store.set(f"ab_commit_head_{b['id']}", head)
                return None
        except TRANSIENT:
            raise
        except Exception as e:
            return f"HEAD 결속을 확인하지 못했습니다: {e}"
        return f"worktree HEAD {head[:10]}가 배치 기준 HEAD {base[:10]}도, Supervisor가 만든 Candidate commit도 아닙니다."

    def _ab_chunks_problem(self, b, cp: dict, skip: int | None = None) -> str | None:
        """Every chunk accepted earlier must still be byte-identical (an AI session never edits a saved chunk)."""
        wt = Path(b["worktree"])
        try:
            for chunk in cp["chunks"]:
                known = self.store.get(f"ab_sha_{b['id']}_{chunk['number']}")
                if known is not None and chunk["number"] != skip and known != stage1ab.chunk_sha(wt, b, chunk):
                    return f"이미 저장된 청크 {chunk['number']:03d}이 수정되었습니다. 덮어쓰지 않고 보존합니다."
        except stage1ab.ABChunkError as e:
            return str(e)
        return None

    def _ab_remember(self, b, chunk: dict) -> None:
        self.store.set(f"ab_sha_{b['id']}_{chunk['number']}", stage1ab.chunk_sha(Path(b["worktree"]), b, chunk))

    def _launch_ab_next(self, b) -> None:
        self._guarded(b, "prelaunch", self._launch_ab_next_do, entrypoint="launch_ab_next")

    def _launch_ab_next_do(self, b) -> None:
        """Advance A/B from the saved files: prepare once, then the first unsaved chunk (new or correction session), or finalize."""
        wt = Path(b["worktree"])
        try:
            if problem := self._ab_head_problem(b, wt):
                return self._fail(b, "ERROR", problem + " worktree를 보존합니다.")
            cp = stage1ab.prepare(self.runner, self.env, wt, b)   # a prepared batch is reused as it is
            repair = self.store.get(f"ab_repair_{b['id']}")
            chunk = stage1ab.chunk_by_number(cp, int(repair)) if repair else stage1ab.next_chunk(wt, b, cp)
            if problem := self._ab_chunks_problem(b, cp, skip=int(repair) if repair else None):
                return self._fail(b, "ERROR", problem)
            if chunk is None:
                return self._ab_finalize(b)
            st = stage1ab.load_state(self.store, b["id"], chunk["number"])
            if st["tries"] > stage1ab.MAX_TRIES:
                return self._fail(b, "ERROR", f"청크 {chunk['number']:03d}의 저장 거부가 정정 {stage1ab.MAX_TRIES}회 뒤에도 해소되지 않았습니다. "
                                  f"답변({stage1ab.answer_path(b, chunk['number'])})과 상태를 보존합니다.")
        except (stage1ab.ABChunkError, OSError, ValueError, GitError) as e:
            return self._fail(b, "ERROR", f"Stage 1 A/B 상태 확인 실패: {e}. worktree를 보존합니다.")
        retry = st["tries"] > 0 or bool(repair)
        self.store.update(b["id"], session_id=st["sid"] if retry and st["sid"] and not repair else None)
        return self._launch(b, "ab_chunk_retry" if retry else "ab_chunk_new")

    def _ab_chunk_prompt(self, b, kind: str, remote="?") -> tuple[str, dict, bool]:
        """(prompt, run-start baseline, resume?) for the active chunk. A correction resumes only that chunk's own session."""
        wt = Path(b["worktree"])
        cp = stage1ab.checkpoint(wt, b)
        repair = self.store.get(f"ab_repair_{b['id']}")
        chunk = stage1ab.chunk_by_number(cp, int(repair)) if repair else stage1ab.next_chunk(wt, b, cp)
        if chunk is None:
            raise prompts.PromptError("저장되지 않은 청크가 없습니다")
        st = stage1ab.load_state(self.store, b["id"], chunk["number"])
        view = stage1ab.write_view(self.runner, self.env, wt, b, chunk)
        requested = ", ".join(st["requested"]) if st["requested"] else "모든 S<n> 줄(전체 청크 답변)"
        resume = kind == "ab_chunk_retry" and bool(b["session_id"])
        if resume:
            prompt = prompts.ab_chunk_retry(chunk["number"], requested, st.get("problem") or "사유 없음")
        else:
            note = ""
            if kind == "ab_chunk_retry":
                note = (f"이 청크는 이미 답변·저장이 있으나 검증에서 거부됐다. 거부 사유: {st.get('problem') or '사유 없음'}\n"
                        f"고칠 줄: {requested}. `C` 줄이 현재 저장된 후보다.\n")
            card_bytes = len(prompts.ab_chunk(b, chunk["number"], view="", note=note).encode("utf-8"))
            if stage1ab.delivery(card_bytes, view) != "inline":
                raise prompts.PromptError("청크 view가 한 argv 요소 한도를 넘어 inline 전달할 수 없습니다 (자동 분할 없음, 청크 보존)")
            prompt = prompts.ab_chunk(b, chunk["number"], view=view, note=note)
        baseline = {"branch": b["branch"], "worktree": str(wt), "head": self.git.head(wt),
                    "remote_head": self.git.remote_head(b["branch"]) if remote == "?" else remote, "chunk_no": chunk["number"], "repair": bool(repair),
                    "saved": stage1ab.saved_snapshot(wt, b, cp)}
        return prompt, baseline, resume

    def _ab_accept(self, b, chunk: dict, repair: bool) -> None:
        """A saved chunk: remember its bytes, clear its run state, and move on with a new session."""
        self._clear_batch_retry(b["id"])
        self._ab_remember(b, chunk)
        if repair:
            self.store.delete(f"ab_repair_{b['id']}")
        self.store.delete(stage1ab.run_start_key(b["id"]))
        self.store.delete(stage1ab.state_key(b["id"], chunk["number"]))
        self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
        self._record_progress(self.store.batch(b["id"]))
        self.store.log(b["id"], f"A/B 청크 {chunk['number']:03d} 저장을 확인했습니다. 다음 단계는 새 세션으로 실행합니다.")
        return self._launch_ab_next(self.store.batch(b["id"]))

    def _run_ok_ab_chunk(self, b) -> None:
        """A zero exit is not success: the chunk counts only when the run's FINAL answer parsed, saved and the exact file exists."""
        problem = self._stage2_chunk_boundary_problem(b, stage1ab.run_start_key(b["id"]))
        if problem:
            return self._fail(b, "ERROR", problem)
        wt = Path(b["worktree"])
        try:
            if self.git.dirty(wt).strip():
                return self._fail(b, "ERROR", "answer-only 청크 실행 뒤 worktree에 추적 변경이 있습니다 (격리 위반 가능). 보존합니다.")
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._fail(b, "ERROR", f"청크 실행 중 소유 브랜치에 예상하지 않은 PR #{info['number']}이 있습니다. 보존합니다.")
            baseline = json.loads(self.store.get(stage1ab.run_start_key(b["id"])) or "{}")
            cp = stage1ab.checkpoint(wt, b)
            chunk = stage1ab.chunk_by_number(cp, baseline["chunk_no"])
            repair = bool(baseline.get("repair"))
            if stage1ab.saved_snapshot(wt, b, cp) != baseline.get("saved"):   # the AI only answers: it never writes a chunk file
                return self._fail(b, "ERROR", "answer-only 청크 실행 중 Supervisor가 만들지 않은 저장물 변경이 있습니다 (AI의 직접 쓰기). "
                                  "완료로 인정하지 않고 보존합니다.")
            st = stage1ab.load_state(self.store, b["id"], chunk["number"])
            st["sid"] = b["session_id"] or st["sid"]
            rows = stage1ab.view_rows((wt / stage1ab.view_path(b, chunk["number"])).read_text("utf-8"))
        except TRANSIENT:
            raise
        except (stage1ab.ABChunkError, OSError, ValueError, KeyError, GitError) as e:
            return self._fail(b, "ERROR", f"A/B 청크 종료 확인 실패: {e}. 보존합니다.")
        except Exception as e:
            return self._fail(b, "ERROR", f"청크 종료 후 GitHub/Git 확인 실패: {e}. worktree를 보존합니다.")
        ok, diag = False, ""
        try:
            body = stage1ab.extract_block(self._adapter(b["producer"]).final_answer(Path(b["log_file"])), chunk["number"])
            revised = stage1ab.split_rows(body)
            previous = None
            answer_file = wt / stage1ab.answer_path(b, chunk["number"])
            if st["requested"] is not None or repair:
                if repair and not answer_file.exists():
                    answer_file.parent.mkdir(parents=True, exist_ok=True)
                    answer_file.write_text(stage1ab.compact_text(chunk["number"], stage1ab.saved_answer_lines(wt, b, chunk)), "utf-8")
                previous = stage1ab.split_rows(answer_file.read_text("utf-8").split("\n")[1:-1])
            lines = stage1ab.merge_answer(previous, st["requested"], revised)
            ok, diag = stage1ab.save(self.runner, self.env, wt, b, chunk, lines)
            if ok:
                if not stage1ab.chunk_saved(wt, b, chunk):
                    return self._fail(b, "ERROR", "save-chunk가 성공했지만 저장 파일이 chunk의 Canonical ID와 맞지 않습니다. 보존합니다.")
                return self._ab_accept(b, chunk, repair)
            st["requested"] = stage1ab.rejected_aliases(diag, rows)
        except stage1ab.ABChunkError as e:
            diag = str(e)   # an unusable answer: ask the same rows again
        except (OSError, ValueError) as e:
            return self._fail(b, "ERROR", f"답변 처리 중 파일 오류: {e}. 보존합니다.")
        st["tries"] += 1
        st["problem"] = diag[:1500]
        stage1ab.save_state(self.store, b["id"], chunk["number"], st)
        self.store.log(b["id"], f"A/B 청크 {chunk['number']:03d} 저장 거부 {st['tries']}회: {diag[:200]}", "warn")
        self.store.delete(stage1ab.run_start_key(b["id"]))
        return self._launch_ab_next(self.store.batch(b["id"]))

    def _ab_chunk_response(self, b) -> bool:
        """The last run's FINAL answer holds one complete, well-formed block for the chunk it was started for."""
        try:
            baseline = json.loads(self.store.get(stage1ab.run_start_key(b["id"])) or "")
            body = stage1ab.extract_block(self._adapter(b["producer"]).final_answer(Path(b["log_file"])), baseline["chunk_no"])
            return bool(stage1ab.split_rows(body))
        except (stage1ab.ABChunkError, OSError, ValueError, KeyError, TypeError):
            return False

    def _relaunch_ab(self, b) -> None:
        problem = self._stage2_chunk_boundary_problem(b, stage1ab.run_start_key(b["id"]))
        if problem and self.store.get(stage1ab.run_start_key(b["id"])) is not None:
            return self._fail(b, "ERROR", problem)
        try:
            if self._find_recovery_pr(b) is not None:
                return self._fail(b, "ERROR", "청크 실행 브랜치에 이미 PR이 있어 자동 재개를 중단합니다. 보존합니다.")
        except TRANSIENT:
            raise
        except Exception as e:
            return self._fail(b, "ERROR", f"청크 재개 전 기존 PR 소유권 확인 실패: {e}. worktree를 보존합니다.")
        raw = self.store.get(stage1ab.run_start_key(b["id"]))
        if raw is not None:
            wt = Path(b["worktree"])
            try:
                baseline = json.loads(raw)
                chunk = stage1ab.chunk_by_number(stage1ab.checkpoint(wt, b), baseline["chunk_no"])
                saved = stage1ab.chunk_saved(wt, b, chunk)
            except (stage1ab.ABChunkError, OSError, ValueError, KeyError, TypeError) as e:
                return self._fail(b, "ERROR", f"A/B 청크 재개 전 저장 확인 실패: {e}. 보존합니다.")
            if saved:   # the exact file is already there: accept it, never ask the AI again
                self.store.log(b["id"], "이전 실행의 A/B 청크 저장을 확인했습니다 — AI 재실행 없이 다음 단계로 진행합니다.")
                return self._ab_accept(b, chunk, bool(baseline.get("repair")))
            if self._ab_chunk_response(b):   # a complete answer from the prior run: judge it instead of regenerating it
                return self._run_ok_ab_chunk(b)
        self.store.update(b["id"], retries=0, retry_after=None, error=None)
        return self._launch_ab_next(self.store.batch(b["id"]))

    def _ab_finalize(self, b) -> None:
        self._guarded(b, "finalize", self._ab_finalize_do)

    def _ab_finalize_do(self, b) -> None:
        """Merge once, commit, push and PR from current file / Git / GitHub facts; any step already true is skipped."""
        wt = Path(b["worktree"])
        n = stage1ab.names(b)
        self.store.update(b["id"], state="PRODUCING", pid=None, run_kind="ab_finalize")
        try:
            if problem := self._ab_head_problem(b, wt):
                return self._fail(b, "ERROR", problem + " worktree를 보존합니다.")
            label = registry(self.cfg)[b["producer"]].get("label", b["producer"])
            info = self._find_recovery_pr(b)
            if info is not None:   # a PR from an earlier, interrupted finalization (or a lost response)
                return self._to_review(b, info)
            cp = stage1ab.checkpoint(wt, b)
            if stage1ab.next_chunk(wt, b, cp) is not None:
                return self._fail(b, "ERROR", "모든 청크가 저장되지 않았습니다. 보존합니다.")
            if problem := self._ab_chunks_problem(b, cp):
                return self._fail(b, "ERROR", problem)
            try:
                coverage = stage1ab.merge(self.runner, self.env, wt, b)
            except stage1ab.MergeRejected as e:
                chunk = stage1ab.chunk_of_error(cp, e.raw)
                if chunk is None:
                    return self._fail(b, "ERROR", f"{e} — 오류가 한 청크로 특정되지 않아 임의 재생산 없이 보존합니다.")
                st = stage1ab.load_state(self.store, b["id"], chunk["number"])
                if st["tries"] >= stage1ab.MAX_TRIES:
                    return self._fail(b, "ERROR", f"{e} — 청크 {chunk['number']:03d} 정정 {stage1ab.MAX_TRIES}회 뒤에도 해소되지 않았습니다. 보존합니다.")
                rows = stage1ab.view_rows(stage1ab.write_view(self.runner, self.env, wt, b, chunk))
                st.update(requested=stage1ab.rejected_aliases(e.raw, rows), problem=str(e)[:1500], sid=None)
                st["tries"] += 1
                stage1ab.save_state(self.store, b["id"], chunk["number"], st)
                self.store.set(f"ab_repair_{b['id']}", str(chunk["number"]))
                self.store.log(b["id"], f"최종 merge 거부가 청크 {chunk['number']:03d}을 지목해 그 범위만 정정합니다: {str(e)[:200]}", "warn")
                return self._launch_ab_next(self.store.batch(b["id"]))
            title = stage1ab.pr_title(label, b)
            if not self.git.is_committed(wt, n.output):
                sha = self.git.commit_paths(wt, [n.output], title)
                self.store.set(f"ab_commit_head_{b['id']}", sha)
                self.store.log(b["id"], f"Candidate 파일을 commit했습니다 ({sha[:10]})")
            else:
                self.store.set(f"ab_commit_head_{b['id']}", self.git.head(wt))
            head, remote = self.git.head(wt), self.git.remote_head(b["branch"])
            if remote is None:
                self.git.push_branch(wt, b["branch"])
                remote = self.git.remote_head(b["branch"])
            if remote != head:
                return self._fail(b, "ERROR", f"원격 브랜치 {b['branch']}가 로컬 HEAD와 다릅니다 ({remote} / {head}). force push 없이 보존합니다.")
            if rival := self._shared_occupied(b):
                return self._fail(b, "ERROR", f"같은 {b['method'].upper()} 배치가 이미 점유됐습니다 ({rival}). 다른 배치로 바꾸지 않고 보존합니다.")
            return self._create_pr_once(b, title, stage1ab.pr_body(label, b, coverage), [stage1ab.PR_LABEL])
        except TRANSIENT:
            raise
        except (stage1ab.ABChunkError, GitError, RecoveryBlocked, DuplicateClaim, OSError, ValueError) as e:
            return self._fail(b, "ERROR", f"A/B 최종화 중단: {e}. worktree를 보존합니다.")
        except Exception as e:
            return self._fail(b, "ERROR", f"A/B 최종화 중 GitHub/Git 오류: {e}. worktree를 보존합니다.")

    def _ab_fix_context(self, b, events) -> str:
        """The reviewer's fixed list reduced to exact source rows + saved candidates for the small `fix_new` session.
        It is context only: the fix is judged by review, never by a scope gate that rejects a correct in-range change."""
        text = "\n".join(str(e.get("body", "")) for e in (events or []))
        try:
            _allowed, context = stage1ab.fix_scope(Path(b["worktree"]), b, text)
        except stage1ab.ABChunkError as e:
            return f"source_context 없음: {e}\n"
        return context

    def _to_review(self, b, info, recovery_note: str | None = None) -> None:
        if b["method"] == STAGE2_METHOD:
            self.store.delete(stage2.run_start_key(b["id"]))
        if b["method"] == literary.METHOD:
            self.store.delete(literary.run_start_key(b["id"]))
        if b["method"] == dchunk.METHOD:
            self.store.delete(dchunk.run_start_key(b["id"]))
        if b["method"] in stage1ab.METHODS:
            self.store.delete(stage1ab.run_start_key(b["id"]))
        self.store.update(b["id"], state="WAITING_REVIEW", pr_number=info["number"],
                          head_sha=info["head_sha"], error=recovery_note, retries=0)
        self._clear_batch_retry(b["id"])
        self.store.delete(f"pr_create_{b['id']}")
        self.store.log(b["id"], f"PR #{info['number']} HEAD {info['head_sha'][:10]} 리뷰 대기")

    # ---- FIXING: is the fix really on the PR? ------------------------------
    def _check_fix_head(self, b, info) -> str:
        """After a fix run: "ok" (clean, local HEAD == PR HEAD), "wait" (only the PR API lags) or "stop" (handled).

        Invariant: a fix is accepted only if its commit is on the PR. A PR API `head.sha` that differs from the local
        HEAD is "not pushed" only when origin's own branch ref says so; if origin already holds the local HEAD, the
        PR metadata is merely late and is re-polled for a bounded time. Nothing is ever forced, reset or re-created.
        """
        key, wt = f"headlag_{b['id']}", Path(b["worktree"])
        if self.git.dirty(wt).strip():
            self.store.set(key, "")
            self._fail(b, "ERROR", "수정 후 worktree에 미커밋 변경이 있어 보존합니다.")
            return "stop"
        local = self.git.head(wt)
        if local == info["head_sha"]:
            self.store.set(key, "")
            return "ok"
        short = f"로컬 HEAD {local[:10]} / PR HEAD {info['head_sha'][:10]}"
        if info["merged"]:   # merged meanwhile: cleanup's own gates (clean, same HEAD or fast-forward) decide what is removed
            self.store.set(key, "")
            self.store.update(b["id"], state="MERGED", merged=1, head_sha=info["head_sha"], error=None)
            self.store.log(b["id"], f"PR #{info['number']} merged=true 확인 ({short}) — 정리 단계에서 검증")
            return "stop"
        stop = None
        if info["state"] != "open":
            stop = f"PR #{info['number']}이 머지 없이 닫혔습니다 ({short}). worktree 보존, 수동 조치 필요."
        elif info["head_ref"] != b["branch"]:
            stop = (f"PR #{info['number']}의 head 브랜치 {info['head_ref']!r}가 소유 브랜치 {b['branch']!r}와 다릅니다 "
                    "(잘못된 PR/브랜치). 보존.")
        else:
            try:
                remote = self.git.remote_head(b["branch"])
            except TRANSIENT as e:   # the query failed: neither "pushed" nor "not pushed" is known yet
                return self._head_lag_wait(b, key, f"원격 브랜치 조회 일시 실패({e}); 로컬 HEAD {local[:10]} / PR HEAD {info['head_sha'][:10]}")
            except Exception as e:
                stop = f"원격 브랜치 조회 실패 — push 여부를 확인할 수 없어 보존합니다 ({short}): {e}"
            else:
                if remote is None:
                    stop = f"실제 미push: 원격에 브랜치 {b['branch']}가 없습니다 ({short}). 보존."
                elif remote != local:
                    stop = (f"원격 ref와 로컬 HEAD 불일치: 원격 {remote[:10]} / 로컬 {local[:10]} "
                            f"(미push 또는 분기, PR HEAD {info['head_sha'][:10]}). 보존.")
        if stop:
            self.store.set(key, "")
            self._fail(b, "ERROR", stop)
            return "stop"
        return self._head_lag_wait(b, key, f"원격 브랜치는 로컬 HEAD {local[:10]}인데 PR API HEAD는 {info['head_sha'][:10]}")

    def _head_lag_wait(self, b, key: str, what: str) -> str:
        """PR metadata lag: wait (bounded by pr_head_lag_timeout_seconds) instead of declaring an unpushed fix."""
        now, first = self.clock(), self.store.get(key) or ""
        if first in ("", "expired"):
            self.store.set(key, str(now))
            self.store.log(b["id"], f"PR 메타데이터 지연: {what} — poll_seconds 간격으로 재확인 (AI 재실행 없음)", "warn")
            return "wait"
        if now - float(first) >= self.cfg["pr_head_lag_timeout_seconds"]:
            # Only a confirmed mismatch (origin's own ref) stops the fix; lag past the window is a warning, not a verdict.
            self._transient_wait(f"b{b['id']}:headlag", f"PR HEAD 반영 지연이 {self.cfg['pr_head_lag_timeout_seconds']}s를 넘음: {what}", b["id"])
        return "wait"

    def _recheck_fix_head(self, b) -> None:
        """FIXING with the AI finished and PR metadata lagging: re-poll the PR (rate-limited by poll_seconds)."""
        pk, key = f"last_poll_fixhead_{b['id']}", f"headlag_{b['id']}"
        if self.store.get(key) == "expired":   # operator Retry: a fresh window
            self.store.set(key, str(self.clock()))
        elif self.clock() - float(self.store.get(pk, "0")) < self.cfg["poll_seconds"]:
            return
        self.store.set(pk, str(self.clock()))
        try:
            info = self.gh.pull(b["pr_number"])
        except TRANSIENT as e:   # only a retryable failure is "lag"; a definite answer (401/404/...) is a verdict
            if self._head_lag_wait(b, key, f"GitHub 조회 일시 실패({e})") == "wait":
                self.store.log(b["id"], f"PR 재조회 실패(재시도 예정): {e}", "warn")
            return
        except Exception as e:
            return self._fail(b, "ERROR", f"수정 후 PR 재조회가 확정적으로 실패했습니다: {e}. worktree·원격 브랜치를 보존합니다.")
        if self._check_fix_head(b, info) == "ok":
            self._to_review(b, info)

    def _find_pr(self, b):
        """The batch's PR (by its owned branch) or None; raises DuplicateClaim on a rival PR."""
        prs = self.gh.prs_for_branch(b["branch"])
        if b["method"] == literary.METHOD:
            prs = self._eligible_branch_prs(b, prs)
        if not prs:
            return None
        pr = sorted(prs, key=lambda p: p["number"])[-1]
        dup = self._duplicate_claim(b, pr["number"])
        if dup:
            raise DuplicateClaim(f"같은 배치를 다른 열린 PR #{dup}이 점유 — 중복 방지로 중단")
        return self.gh.pull(pr["number"])

    def _adopt_pr_while_running(self, b) -> None:
        """Hand a validated PR to Supervisor while the producer is live, then stop that process."""
        ad = self._adapter(b["producer"])
        stage1 = b["method"] in {"a", "b", "c", "d"}
        if not stage1 and ad.requires_final_result_for_pr:
            return   # Stage 2/maintenance retain their existing final-result and verify gates.
        if ad.requires_session_for_pr and not b["session_id"]:
            return
        last = float(self.store.get(f"last_poll_{b['id']}", "0"))
        if self.clock() - last < self.cfg["poll_seconds"]:
            return
        self.store.set(f"last_poll_{b['id']}", str(self.clock()))
        try:
            # Keep the live final-result gate ahead of open-PR adoption. Other Stage 1 paths can validate ownership
            # immediately; final-result producers validate exact ownership after their completion/denial gates.
            info = self._find_pr(b) if stage1 and ad.requires_final_result_for_pr else (
                self._find_recovery_pr(b) if stage1 else self._find_pr(b))
        except (DuplicateClaim, RecoveryBlocked) as e:
            ad.stop(b["pid"])
            return self._fail(b, "ERROR", str(e))
        except Exception as e:
            return self.store.log(b["id"], f"PR 조회 실패(재시도 예정): {e}", "warn")
        if info is None:
            return
        if stage1 and info["merged"] and ad.requires_final_result_for_pr:
            try:
                info = self._find_recovery_pr(b)  # merged recovery still requires the exact Candidate claim
            except (DuplicateClaim, RecoveryBlocked) as e:
                ad.stop(b["pid"])
                return self._fail(b, "ERROR", str(e))
        if not stage1:
            self.store.update(b["id"], state="WAITING_REVIEW", pr_number=info["number"],
                              head_sha=info["head_sha"], error=None, retries=0)
            self.store.set(f"last_poll_{b['id']}", "0")
            self.store.log(b["id"], f"AI 실행 중 PR #{info['number']} 감지 → 리뷰 감시로 인계")
            return
        if info["merged"]:
            ad.stop(b["pid"])
            return self._enter_merged(b, info, "생산 실행 중 소유 PR 발견")
        if info["state"] != "open":
            ad.stop(b["pid"])
            self.store.update(b["id"], state="ERROR", paused_from="WAITING_REVIEW", pr_number=info["number"],
                              head_sha=info["head_sha"], error=f"PR #{info['number']}이 머지 없이 닫혀 있습니다. "
                              "worktree·브랜치를 보존합니다.")
            return self.store.log(b["id"], f"생산 실행 중 닫힌 PR #{info['number']} 발견; 안전 정지", "error")
        if ad.requires_final_result_for_pr:
            result_problem = ad.completion_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"],
                                                   b["worktree"], self.env)
            if result_problem:
                return   # keep the established success/denial gate for an open PR
            if not self._denials_cleared(b, Path(b["log_file"])):
                ad.stop(b["pid"])
                return
            if stage1:
                try:
                    info = self._find_recovery_pr(b)
                except (DuplicateClaim, RecoveryBlocked) as e:
                    ad.stop(b["pid"])
                    return self._fail(b, "ERROR", str(e))
        self.store.update(b["id"], state="WAITING_REVIEW", pr_number=info["number"],
                          head_sha=info["head_sha"], error=None, retries=0)
        self.store.set(f"last_poll_{b['id']}", "0")
        self.store.set(f"stop_after_pr_{b['id']}", "1")
        ad.stop(b["pid"])
        self.store.log(b["id"], f"AI 실행 중 소유 PR #{info['number']} 감지 → Supervisor로 인계하고 생산 프로세스 종료 요청")

    def _duplicate_claim(self, b, my_pr: int) -> int | None:
        """A rival open PR on the same batch file: same model for A/B, any model for the shared C/D queue."""
        if b["method"] == MAINTENANCE_METHOD:   # an Issue-scoped PR, not a Candidate batch: the Issue claim is the guard
            return None
        shared = batches.is_shared_queue(b["method"])
        for pr in self.gh.open_prs():
            if pr["number"] == my_pr:
                continue
            try:
                claims = batches.pr_claims(b, pr)
            except batches.BatchError as e:   # unknown file list: a duplicate cannot be ruled out -> stop
                raise DuplicateClaim(f"{e} — 중복 방지로 중단") from e
            if b["method"] == STAGE2_METHOD:   # one open Stage 2 PR per shard: the cumulative Relation/Drop files collide
                if batches.expected_claim(b) in claims:
                    return pr["number"]
                continue
            for shard, batch, method, who in claims:
                if (shard, batch, method) == (b["shard"], b["batch"], b["method"]) and (shared or who == b["producer"]):
                    return pr["number"]
        return None

    def _handoff_failed_pr(self, b, code: int, cls: str) -> bool:
        """A failed producer may still have submitted its batch PR immediately before exiting."""
        if not self._verified_current_producer_exit(b, code):
            self._fail(b, "ERROR", f"AI 종료 코드 {code} 뒤 PR 인계를 검증할 종료 실행 증거가 없습니다. "
                       "worktree를 보존하고 AI를 재실행하지 않습니다.")
            return True
        try:
            info = self._find_recovery_pr(b)
        except TRANSIENT:
            raise
        except Exception as e:
            self._fail(b, "ERROR", f"AI 종료 코드 {code}, 분류={cls}; 실패 직후 소유 PR 조회/검증 실패: {e}. "
                       "worktree를 보존하고 AI를 재실행하지 않습니다.")
            return True
        if info is None:
            self.store.log(b["id"], f"AI 종료 코드 {code}, 분류={cls}; 소유 브랜치 PR 미발견 "
                           "(확인된 미발견이며 기존 실패 분류를 계속 적용합니다).", "warn")
            return False
        if b["method"] == STAGE2_METHOD and isinstance(b["run_kind"], str) and \
                b["run_kind"].startswith("s2_finalize_"):
            problem = self._stage2_final_pr_problem(b, info)
            if problem:
                self._fail(b, "ERROR", problem)
                return True
        self.store.log(b["id"], f"AI 종료 코드 {code}, 분류={cls}; 기존 소유 PR #{info['number']} 인계 "
                       f"(state={info['state']}, merged={info['merged']}, HEAD {info['head_sha'][:10]}) — "
                       "AI 재실행 없이 기존 검증 절차를 유지합니다.", "warn")
        if info["merged"]:
            return self._enter_merged(b, info, f"AI 종료 코드 {code} 확인 후")
        if info["state"] == "open":
            self._to_review(b, info, recovery_note=f"AI 종료 코드 {code} (분류={cls}) 후 소유 PR "
                            f"#{info['number']} 인계; 기존 리뷰·검증 게이트를 계속합니다.")
            return True
        self.store.update(b["id"], state="ERROR", paused_from="WAITING_REVIEW", pr_number=info["number"],
                          head_sha=info["head_sha"], error=f"PR #{info['number']}이 머지 없이 닫혀 있어 "
                          "자동 복구하지 않습니다. worktree·브랜치를 보존합니다.")
        self.store.log(b["id"], f"AI 종료 코드 {code} 이후 발견한 PR #{info['number']}이 머지 없이 닫힘; "
                       "재생산을 막고 수동 확인을 요청합니다.", "error")
        return True

    def _classify_run(self, producer: str, log_file) -> str:
        """Failure class of ONE run's log. For the tiered CLI (OpenCode) only a structured provider Free-quota
        error event is `free_quota`; text patterns never are. Other CLIs keep the configured text patterns."""
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")[-30000:]
        except OSError:
            text = ""
        if self._tiered(producer):
            if opencode_free_quota(log_file):
                return "free_quota"
            return classify_failure(text, [])
        return classify_failure(text, self.cfg["quota_patterns"])

    def _run_failed(self, b, code: int) -> None:
        cls = self._classify_run(b["producer"], b["log_file"])
        self.store.log(b["id"], f"AI 종료 코드 {code}, 분류={cls}", "warn")
        if self._s2_chunk_run(b) and b["state"] == "PRODUCING" and self._stage2_response(b) is not None:
            # A nonzero exit is not the verdict: run_problem found no model/permission/policy block, and a judgement for
            # the current chunk is in the log, so it is saved and judged by save-chunk like any other answer.
            self.store.log(b["id"], "AI가 비정상 종료했지만 현재 청크의 판정 응답이 있어 저장을 시도합니다.", "warn")
            return self._run_ok_stage2_chunk(b)
        if self._ab_chunk_run(b) and b["state"] == "PRODUCING" and self._ab_chunk_response(b):
            # A nonzero exit is not the verdict (`run_problem` found no model/permission/policy block): the log holds this
            # chunk's complete answer, so it is saved and judged by save-chunk like any other answer.
            self.store.log(b["id"], "AI가 비정상 종료했지만 현재 A/B 청크의 완성된 답변이 있어 저장을 시도합니다.", "warn")
            return self._run_ok_ab_chunk(b)
        if self._c_chunk_run(b) and b["state"] == "PRODUCING" and self._c_chunk_saved(b):
            # The submit was stored (e.g. the CLI died or its answer was lost afterwards): never produce it again.
            self.store.log(b["id"], "AI가 비정상 종료했지만 활성 청크의 submit 저장이 확인되어 재생산하지 않습니다.", "warn")
            return self._run_ok_c_chunk(b)
        if self._d_chunk_run(b) and b["state"] == "PRODUCING" and self._d_chunk_saved(b):
            # The save was stored (e.g. the CLI died or its answer was lost afterwards): never produce it again.
            self.store.log(b["id"], "AI가 비정상 종료했지만 활성 청크의 save 저장이 확인되어 재생산하지 않습니다.", "warn")
            return self._run_ok_d_chunk(b)
        chunk_run = (b["method"] == STAGE2_METHOD and isinstance(b["run_kind"], str)
                     and b["run_kind"].startswith("s2_chunk_")) or self._c_chunk_run(b) or self._d_chunk_run(b) \
            or self._ab_chunk_run(b)
        if b["state"] == "PRODUCING" and not b["pr_number"] and not chunk_run:
            if self._handoff_failed_pr(b, code, cls):
                return
        if cls == "effort":
            return self._fail(b, "ERROR", "CLI가 요청한 모델 또는 추론 수준을 받아들이지 않았습니다 — 다른 값으로 "
                              f"대체하지 않습니다. 로그 확인 후 설정을 고치세요: {b['log_file']}")
        if cls == "session_missing":
            return self._fail(b, "PAUSED", "세션 ID를 찾지 못했습니다 — 새 세션을 만들지 않고 worktree·PR을 보존합니다. "
                              "원인 확인 후 Retry.")
        if cls == "usage_limit":
            return self._fail(b, "PAUSED", "CLI 사용량 한도에 도달했습니다 — 자동 전환·재시도 없이 중지합니다. 한도 해제 후 Retry.")
        if cls == "free_quota":
            if not self._tiered(b["producer"]):
                return self._fail(b, "PAUSED", "사용량 한도 도달로 보입니다. 이 CLI는 자동 모델 전환을 하지 않습니다 "
                                  "(로그 확인 후 Retry).")
            go = registry(self.cfg).get(b["producer"], {}).get("models", {}).get("go")
            if b["model_tier"] == "free" and go:
                self.store.set_line(b["producer"], b["method"], model_tier="go")
                self.store.update(b["id"], model_tier="go")
                self.store.log(b["id"], f"제공자 Free 한도 오류 확인 ({QUOTA_EVIDENCE}) → Go 모델로 전환")
                return self._relaunch(self.store.batch(b["id"]))
            return self._fail(b, "PAUSED", "무료 한도 소진이 확인되었지만 전환할 Go 모델이 없거나 이미 Go입니다.")
        if cls in ("rate_limit", "network"):
            if b["retries"] < self.cfg["rate_limit_retries"]:
                wait = self.cfg["rate_limit_backoff_seconds"] * (2 ** b["retries"])
                self.store.update(b["id"], retries=b["retries"] + 1, retry_after=self.clock() + wait)
                return self.store.log(b["id"], f"{cls}: {wait}s 후 재시도 ({b['retries'] + 1})", "warn")
            return self._fail(b, "PAUSED", f"{cls} 재시도 한도 초과 (무료 한도 소진으로 간주하지 않음)")
        if cls == "auth":
            return self._fail(b, "PAUSED", "인증 실패 — Settings의 인증 안내를 확인하세요.")
        if b["run_kind"] == "fix_resume":  # session resume impossible -> safe recovery once
            self.store.log(b["id"], "세션 resume 실패 → 새 AI 세션으로 복구", "warn")
            return self._launch(b, "fix_new", self._all_events(b))
        self._fail(b, "PAUSED", f"인식할 수 없는 AI 실패(코드 {code}) — 조용히 유료 전환/재생산하지 않음. 로그: {b['log_file']}")

    # ---- WAITING_REVIEW ------------------------------------------------
    def _events(self, b):
        info = self.gh.pull(b["pr_number"])
        evs = reviews.fix_events(
            head_sha=info["head_sha"], head_pushed_at=self.gh.commit_time(info["head_sha"]),
            self_login=self.cfg["expected_account"],
            reviews=self.gh.reviews(b["pr_number"]), inline=self.gh.inline_comments(b["pr_number"]),
            issue=self.gh.issue_comments(b["pr_number"]),
            trusted=self.cfg["trusted_reviewers"])
        return info, evs

    def _all_events(self, b):
        try:
            return self._events(b)[1]
        except Exception:
            return []

    def _reap(self, b):
        """Clear a finished AI pid; returns (batch, still_alive)."""
        if b["pid"] is None:
            return b, False
        ad = self._adapter(b["producer"])
        if ad.alive(b["pid"]):
            return b, True
        self.store.update(b["id"], pid=None)
        self.store.finish_runs(b["id"], ad.exit_code(Path(b["exit_file"])) if b["exit_file"] else None)
        self.store.log(b["id"], "AI 프로세스 종료 확인")
        return self.store.batch(b["id"]), False

    def _watch(self, b) -> None:
        b, live = self._reap(b)
        stop_key = f"stop_after_pr_{b['id']}"
        if self.store.get(stop_key):
            if live:
                self._adapter(b["producer"]).stop(b["pid"])
                return
            self.store.delete(stop_key)
        last = float(self.store.get(f"last_poll_{b['id']}", "0"))
        if self.clock() - last < self.cfg["poll_seconds"]:
            return
        self.store.set(f"last_poll_{b['id']}", str(self.clock()))
        try:
            info, evs = self._events(b)
        except Exception as e:
            return self.store.log(b["id"], f"GitHub 폴링 실패(재시도 예정): {e}", "warn")
        if info["merged"]:
            self.store.update(b["id"], state="MERGED", merged=1, head_sha=info["head_sha"])
            return self.store.log(b["id"], f"PR #{b['pr_number']} merged=true 확인")
        if info["state"] != "open":
            if live:
                self._adapter(b["producer"]).stop(b["pid"])
            return self._fail(b, "ERROR", f"PR #{b['pr_number']}이 머지 없이 닫혔습니다. worktree 보존, 수동 조치 필요.")
        if info["head_sha"] != b["head_sha"]:
            self.store.update(b["id"], head_sha=info["head_sha"])
            b = self.store.batch(b["id"])
            self.store.log(b["id"], f"HEAD 변경 감지 → {info['head_sha'][:10]}")
        for e in ([] if b["method"] == MAINTENANCE_METHOD else evs):   # a trusted reviewer's explicit shared-defect
            raw = defects.review_block(e["body"])                      # block pauses the batch instead of a fix run
            key = defects.review_event_key(b["id"], b["pr_number"], e["key"])
            if raw is not None and not self.store.defect_by_event(key):
                if live:
                    self._adapter(b["producer"]).stop(b["pid"])
                return self.maint.report(b, "review", key, raw, info)
        fresh = [e for e in evs if not self.store.is_handled(b["id"], b["pr_number"], info["head_sha"], e["key"])]
        if fresh and live:
            # Never run two AI processes in one worktree: stop the old one, confirm exit
            # on a following tick, then start the fix run.
            self._adapter(b["producer"]).stop(b["pid"])
            self.store.set(f"last_poll_{b['id']}", "0")
            return self.store.log(b["id"], "새 리뷰 이벤트 — 실행 중인 AI 종료 요청, 종료 확인 후 수정 실행")
        if fresh:
            self.store.log(b["id"], f"새 리뷰 이벤트 {len(fresh)}건 → 수정 실행")
            self._launch(b, self._fix_kind(b), fresh)

    # ---- MERGED / CLEANUP / COMPLETE ---------------------------------
    def _to_cleanup(self, b) -> None:
        try:
            info = self.gh.pull(b["pr_number"])
        except Exception as e:
            return self.store.log(b["id"], f"머지 재확인 실패: {e}", "warn")
        if not info["merged"]:
            return self._fail(b, "ERROR", "merged=true가 재확인되지 않아 정리하지 않습니다.")
        self.store.update(b["id"], state="CLEANUP", head_sha=info["head_sha"])
        self.store.log(b["id"], f"PR #{b['pr_number']} merged=true 재확인 → MERGED→CLEANUP "
                       "(clean/HEAD/소유 worktree 검증)")

    def _cleanup(self, b) -> None:
        key = f"b{b['id']}:cleanup"
        if not self._transient_due(key):
            return
        ad = self._adapter(b["producer"])
        if b["pid"] and ad.alive(b["pid"]):
            ad.stop(b["pid"])
            return self.store.log(b["id"], "남은 AI 프로세스 정지 요청, 종료 확인 대기")
        try:
            info = self.gh.pull(b["pr_number"])
            if (info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]):
                return self._fail(b, "ERROR", "PR 번호/head 브랜치가 배치 소유권과 일치하지 않아 정리하지 않습니다.")
            if not info.get("merged") or info.get("state") != "closed":
                return self._fail(b, "ERROR", "merged=true 아님 — 정리하지 않음")
            if b["method"] == STAGE2_METHOD and not self._stage2_merged_verify(b, info):
                return
            path = Path(os.path.abspath(b["worktree"])).resolve()
            proof = {
                "version": 1,
                "batch_id": b["id"],
                "method": b["method"],
                "producer": b["producer"],
                "shard": b["shard"],
                "batch": b["batch"],
                "path": str(path),
                "branch": b["branch"],
                "pr_number": b["pr_number"],
                "head_sha": info["head_sha"],
                "remove_started": True,
            }
            proof_key = f"cleanup_proof_{b['id']}"
            saved = None
            try:
                candidate = json.loads(self.store.get(proof_key, ""))
            except (TypeError, ValueError):
                candidate = None
            if candidate == proof:
                saved = candidate

            def record_proof() -> None:
                self.store.set(proof_key, json.dumps(proof, sort_keys=True))
                self.store.log(b["id"], f"PR #{info['number']} merged + clean/HEAD/worktree ownership 확인 기록 후 cleanup 시작")

            self.git.remove_owned(path, b["branch"], info["head_sha"], cleanup_proof=saved,
                                  on_verified=record_proof)
        except TRANSIENT as e:   # the same ownership/HEAD/merged proof is simply asked again later
            return self._transient_wait(key, e, b["id"])
        except CleanupBlocked as e:
            return self._fail(b, "ERROR", f"정리 차단(보존): {e}")
        except Exception as e:
            return self._fail(b, "ERROR", f"정리 실패(보존): {e}")
        self.store.update(b["id"], state="COMPLETE", error=None)
        self._clear_batch_retry(b["id"])
        self.store.delete(f"pr_create_{b['id']}")
        self.store.delete(f"cleanup_proof_{b['id']}")
        self.store.delete(f"stop_after_pr_{b['id']}")
        if b["method"] == STAGE2_METHOD:
            self.store.delete(stage2.run_start_key(b["id"]))
        self.store.finish_runs(b["id"], None)
        self.store.log(b["id"], f"배치 {b['shard']}_{b['batch']} 정리 완료")
        ln = self.store.line(b["producer"], b["method"])
        if b["method"] == MAINTENANCE_METHOD:   # Drain outlives the Issue (it stops the NEXT claim); only Cancel Drain ends it
            return self.store.set_line(b["producer"], b["method"], run=0, drain_once=0)
        if b["method"] == STAGE2_METHOD:   # Single ends when its shard is complete (next pick), not after every Part
            if ln["drain"] or ln["drain_once"]:
                self.store.set_line(b["producer"], b["method"], run=0, drain=0, drain_once=0, shard_pin="")
            return
        if ln["mode"] != "continuous" or ln["drain"] or ln["drain_once"]:
            # Single batch done, this Line's Drain took effect, or Drain All asked this Line to finish.
            self.store.set_line(b["producer"], b["method"], run=0, drain=0, drain_once=0)

    def _stage2_merged_verify(self, b, info) -> bool:
        """A merged Part counts only after its exact verify succeeds on the latest master, BEFORE its worktree is removed
        and before the next Part may start. False: waiting (merge commit not on master yet / GitHub or git trouble) or
        stopped in ERROR (verify failed); the worktree, PR and session stay and Retry re-verifies without any AI run."""
        bb, pp = stage2.split_key(b["batch"])
        ok_key, gate = stage2.ok_key(b["shard"], bb, pp), f"s2_merge_wait_{b['id']}"
        if self.store.get(ok_key):
            return True
        if self.clock() - float(self.store.get(gate, "0")) < self.cfg["poll_seconds"]:
            return False
        self.store.set(gate, str(self.clock()))
        base = self.cfg["base_branch"]
        try:
            sha = self.git.fetch_base(base)
            merged = info.get("merge_commit_sha")
            if merged and not self.git.contains_on_base(merged, base):
                self.store.log(b["id"], f"머지 커밋 {merged[:10]}이 아직 origin/{base}에 보이지 않습니다 — 재확인 예정", "warn")
                return False
            ok, tail = self.git.verify_stage2(sha, "part", b["shard"], bb, pp)
        except Exception as e:
            self.store.log(b["id"], f"머지 후 Part verify 준비 실패(재시도 예정): {e}", "warn")
            return False
        if not ok:
            self._fail(b, "ERROR", f"PR #{info['number']} 머지 후 최신 master에서 {stage2.label(b['shard'], b['batch'])} "
                       f"verify가 실패했습니다: {tail}. worktree를 보존하고 다음 Part를 시작하지 않습니다 (확인 후 Retry).")
            self.store.set(gate, "0")
            return False
        self.store.set(ok_key, sha)
        self.store.log(b["id"], f"최신 master {sha[:10]}에서 {stage2.label(b['shard'], b['batch'])} verify 통과")
        return True

    # ---- daemon --------------------------------------------------------
    def run_forever(self, interval: float = 5.0) -> None:
        while True:
            try:
                self.tick()
            except Exception:
                self.store.log(None, "supervisor tick 예외:\n" + traceback.format_exc()[-800:], "error")
            time.sleep(interval)


def build(paths=None):
    """Wire the production Supervisor."""
    import os as _os

    from .adapters import ClaudeCodeAdapter, CodexCLIAdapter, OpenCodeAdapter
    from .config import Paths, load_config
    from .gitops import Git
    from .github import GhClient
    from .shell import Runner
    from .store import Store
    paths = paths or Paths()
    paths.ensure()
    cfg = load_config(paths)
    problem = config_problem(cfg)   # the same check a reload applies: never start on a config a reload would refuse
    if problem:
        raise SystemExit(f"config.json 오류: {problem}")
    env = auth.build_env(dict(_os.environ), paths.gh_config, cfg["git_name"], cfg["git_email"])
    runner = Runner()
    adapters = {"opencode": OpenCodeAdapter(cfg["opencode_bin"]), "claude": ClaudeCodeAdapter(cfg["claude_bin"]),
                "codex": CodexCLIAdapter(cfg["codex_bin"])}
    return Supervisor(paths, cfg, Store(paths.db), runner, adapters,
                      GhClient(runner, env, cfg["repo"]),
                      Git(runner, paths.repo_root, env, paths.worktrees), env)


def main() -> int:
    from .config import Paths
    paths = Paths()
    paths.ensure()
    lock = acquire_lock(paths.lock)
    if lock is None:
        print("War Room supervisor가 이미 실행 중입니다.")
        return 1
    sup = build(paths)
    sup.store.log(None, "supervisor 시작")
    sup.run_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
