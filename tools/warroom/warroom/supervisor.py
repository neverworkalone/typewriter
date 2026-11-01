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
import hashlib
import json
import os
import re
import secrets
import time
import traceback
from pathlib import Path

from . import auth, batches, control, dchunk, defects, literary, progress, prompts, reviews, stage1ab, stage2, stage3
from .adapters import (PREFLIGHT_PENDING, QUOTA_EVIDENCE, RunSpec, classify_claude_failure, classify_failure,
                       opencode_free_quota)
from .config import (TIERED_ADAPTERS, adapter_label, config_problem, load_config, registry, registry_problems,
                     reload_problem, role_of, role_problem, run_spec, stage2_problem, stage3_model, stage3_problem)
from .github import GhError, GhTransient
from .gitops import CleanupBlocked, FastForwardBlocked, FastForwardRace, GitError, GitTransient, IntegrationBlocked
from .maintenance import Maintenance
from .store import MAINTENANCE_METHOD, STAGE2_METHOD, STAGE3_METHOD, LineBusy, LineNotRunnable


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
        self._s2_fix_problem: dict[int, str] = {}   # batch id -> the save/format diagnostic for the next same-session fix
        self._s2_links_problem: dict[int, str] = {} # batch id -> optional-link save/format diagnostic
        self._stage3_pr_files: dict[int, tuple[tuple, set[str]]] = {}
        self._stage3_pr_inventory_sha: str | None = None
        self._stage3_pr_inventory: list[dict] | None = None
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
        # Scheduled operator commands are one-shot and must commit before this tick can assign work to any Line.
        self.store.fire_due_drain_schedules(self.clock(), control.board_line_keys(self.store, self.cfg))
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

    def _chunk_retry_target(self, b) -> str | None:
        """Stable identity of the currently active chunk for the bounded, persisted AI re-entry allowance."""
        try:
            wt = Path(b["worktree"])
            if b["method"] in stage1ab.METHODS:
                cp = stage1ab.checkpoint(wt, b)
                repair = self.store.get(f"ab_repair_{b['id']}")
                chunk = stage1ab.chunk_by_number(cp, int(repair)) if repair else stage1ab.next_chunk(wt, b, cp)
                return None if chunk is None else f"ab:{chunk['number']}"
            if b["method"] == literary.METHOD:
                rec = literary.read_active(wt, b)
                return None if rec is None else f"c:{rec['chunk_no']}"
            if b["method"] == dchunk.METHOD:
                rec = dchunk.read_active(wt, b)
                return None if rec is None else f"d:{rec['chunk_no']}"
            if b["method"] == STAGE2_METHOD:
                checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
                pending = checkpoint.get("pending_chunk") if checkpoint else None
                return None if pending is None else f"s2:{pending}"
            if self._stage3_chunk_run(b):
                raw = self.store.get(stage3.run_start_key(b["id"]))
                baseline = json.loads(raw or "null")
                if not isinstance(baseline, dict) or not isinstance(baseline.get("checkpoint"), dict):
                    return None
                if baseline.get("chunk") != stage3.next_chunk(baseline["checkpoint"]):
                    return None
                current = stage3.checkpoint(wt, b["shard"])
                if current != baseline["checkpoint"] or self._stage3_chunk_saved(b):
                    return None
                return f"s3:{b['shard']}:{baseline['chunk']}"
        except (OSError, ValueError, KeyError, TypeError, stage1ab.ABChunkError,
                literary.LiteraryError, dchunk.DChunkError, stage3.Stage3Error):
            return None
        return None

    def _auto_retry_key(self, b, target: str) -> str:
        return f"auto_chunk_retry_{b['id']}:{b['method']}:{target}"

    def _auto_retry_chunk(self, b, reason: str, *, fresh_session: bool = False) -> bool:
        """Use the one persisted additional re-entry for this exact active chunk, then reuse its normal Retry path."""
        if b["state"] != "PRODUCING" or b["pid"] is not None:
            return False
        target = self._chunk_retry_target(b)
        if target is None or (not fresh_session and not b["session_id"]):
            return False
        key = self._auto_retry_key(b, target)
        try:
            used = int(self.store.get(key) or 0)
        except (TypeError, ValueError):
            used = 1   # a damaged retry count must fail closed
        if used >= 1:
            self.store.log(b["id"], f"{target} 자동 재진입 한도를 이미 사용했습니다. 현재 상태를 보존합니다.", "warn")
            return False
        self.store.set(key, str(used + 1))   # persisted before launch; duplicate ticks/restarts cannot regrant it
        if fresh_session:
            self.store.update(b["id"], session_id=None)
        self.store.log(b["id"], f"{target} {reason} — 같은 청크의 안전한 재개를 한 번 시도합니다 (1/1)", "warn")
        self._relaunch(self.store.batch(b["id"]))
        return True

    def _retry_unsaved_chunk(self, b, reason: str) -> bool:
        """Re-enter a missing-output chunk once, using a fresh session only when its method boundary is self-contained."""
        fresh = not bool(b["session_id"])
        if fresh and not self._safe_fresh_chunk_after_missing_session(b):
            return False
        return self._auto_retry_chunk(b, reason, fresh_session=fresh)

    def _saved_chunk_for_run(self, b) -> bool:
        """Exact active-chunk evidence for output-producing exits, bound to this run's start baseline."""
        if b["method"] == STAGE3_METHOD and str(b["run_kind"] or "").startswith("s3_chunk_"):
            return self._stage3_chunk_saved(b)
        if self._s2_chunk_run(b):
            return self._stage2_chunk_saved(b)
        if self._c_chunk_run(b):
            return self._c_chunk_saved(b)
        if self._d_chunk_run(b):
            return self._d_chunk_saved(b)
        return False

    def _saved_chunk_identity_problem(self, b):
        ad = self._adapter(b["producer"])
        return ad.output_identity_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"],
                                          b["worktree"], self.env)

    def _stage3_chunk_run(self, b) -> bool:
        return b["method"] == STAGE3_METHOD and isinstance(b["run_kind"], str) \
            and b["run_kind"].startswith("s3_chunk_")

    def _stage3_answer_only(self, b) -> bool:
        """True only for a complete D/L answer bound to this exact current Stage 3 chunk."""
        if not self._stage3_chunk_run(b) or b["state"] != "PRODUCING":
            return False
        try:
            raw = self.store.get(stage3.run_start_key(b["id"]))
            baseline = json.loads(raw or "null")
            if (not isinstance(baseline, dict) or not isinstance(baseline.get("checkpoint"), dict)
                    or not isinstance(baseline.get("view"), dict)
                    or baseline.get("chunk") != stage3.next_chunk(baseline["checkpoint"])):
                return False
            answer = self._adapter(b["producer"]).final_answer(Path(b["log_file"])) if b["log_file"] else None
            context = stage3.decision_context(baseline["view"], baseline["chunk"])
            # The normalizer deliberately turns an empty body into `none` for its caller's save path. An
            # answer-only recovery must require an explicit decision body so a truncated header cannot advance.
            answer_lines = [line.strip() for line in answer.splitlines() if line.strip()] \
                if isinstance(answer, str) else []
            if len(answer_lines) < 2:
                return False
            normalized, warnings = stage3.normalize_decisions(answer, baseline["chunk"], context)
            decisions = [line.strip() for line in normalized.splitlines() if line.strip()][1:]
            if decisions == ["none"]:
                return answer_lines[1:] == ["none"] and not warnings
            return bool(decisions)
        except (OSError, ValueError, KeyError, TypeError, stage3.Stage3Error):
            return False

    def _safe_fresh_chunk_after_missing_session(self, b) -> bool:
        """Only methods with a self-contained, still-unsaved chunk may leave a dead session for a new one."""
        wt = Path(b["worktree"])
        if self._s2_chunk_run(b) and b["run_kind"] not in ("s2_chunk_fix", "s2_chunk_format_fix"):
            pending = self._stage2_pending(b)
            decisions = wt / stage2.DECISIONS
            try:
                return pending is not None and (not decisions.exists() or not decisions.read_text("utf-8").strip())
            except OSError:
                return False
        if self._c_chunk_run(b):
            try:
                rec = literary.read_active(wt, b)
                if rec is None:
                    return False
                submit = wt / f"{literary.names(b).submit_prefix}{rec['chunk_no']:03d}.submit.json"
                diag = submit.with_name(submit.name + ".diag.json")
                if submit.exists() or diag.exists():
                    return False
                state = literary.sense_report(self.runner, self._c_env(b), wt, b, rec["sense_ids"])
                return not rec.get("repair") and not any(s["done"] for s in state["senses"])
            except (literary.LiteraryError, OSError, ValueError, KeyError, TypeError):
                return False
        if self._d_chunk_run(b) and b["run_kind"] != "d_chunk_fix":
            try:
                rec = dchunk.read_active(wt, b)
                if rec is None or dchunk.has_search_failure(wt, b):
                    return False
                n = dchunk.chunk_names(b, rec["chunk_no"])
                decisions = wt / n.decisions
                rejected = wt / n.rejected
                if rejected.exists():
                    return False
                return not decisions.exists() or not decisions.read_text("utf-8").strip()
            except (dchunk.DChunkError, OSError, ValueError):
                return False
        if self._stage3_chunk_run(b) and b["run_kind"] == "s3_chunk_new":
            raw = self.store.get(stage3.run_start_key(b["id"]))
            try:
                baseline = json.loads(raw or "null")
                if (not isinstance(baseline, dict) or baseline.get("view") is None
                        or self._stage3_chunk_boundary_problem(b) is not None
                        or self._stage3_chunk_saved(b)):
                    return False
                view = stage3.read_chunk(self.runner, self.env, wt, b["shard"])
                return view == baseline["view"] and view.get("chunk") == baseline.get("chunk")
            except (OSError, ValueError, KeyError, TypeError, stage3.Stage3Error):
                return False
        return False

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
            fin = {"ab_finalize": self._ab_finalize, "c_finalize": self._c_finalize, "d_finalize": self._d_finalize,
                   "s2_deterministic_finalize": self._stage2_finalize}
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
            target = self._chunk_retry_target(b)
            if target is not None:
                self.store.delete(self._auto_retry_key(b, target))   # only an explicit operator Retry grants one new chance
            if (b["method"] == STAGE2_METHOD and b["state"] in ("PAUSED", "ERROR") and not b["pr_number"]
                    and self._s2_chunk_run(b)
                    and stage2.fixes_used(self.store.runs(b["id"]), "s2_chunk_new",
                                          ("s2_chunk_fix", "s2_chunk_format_fix")) >= stage2.MAX_FIXES):
                pending = self._stage2_pending(b)
                file_state = stage2.decision_file_state(b["worktree"], pending) if pending else "corrupt"
                if b["session_id"] and pending and file_state in ("current", "missing"):
                    status = self._s2_retry_fix_status(b, pending)
                    if status is None:
                        self._write_s2_retry_fix_status(b, pending, "granted")
                        self.store.log(b["id"], "운영자 Retry: 현재 청크/세션에 추가 판정 수정 1회를 결속했습니다")
            if self._d_chunk_run(b) and not b["pr_number"]:
                self.store.delete_prefix(f"d_fix_{b['id']}:")   # only an explicit Retry regrants the automatic correction
            resume_state = b["paused_from"] or "PRODUCING"
            legacy_ff_error = (b["state"] == "ERROR" and b["paused_from"] == "FIXING" and b["pr_number"] is not None
                              and isinstance(b["error"], str)
                              and b["error"].startswith("원격 ref와 로컬 HEAD 불일치:"))
            stranded_review = (b["state"] == "ERROR" and b["paused_from"] == "WAITING_REVIEW"
                               and b["pr_number"] is not None and b["method"] in ("a", "b", "c", "d")
                               and isinstance(b["error"], str)
                               and b["error"].startswith("미완료 리뷰 이벤트 감지:"))
            if legacy_ff_error:
                # Older Supervisor releases treated every remote/local SHA difference as divergence. Re-enter the
                # owned PR watcher; it retries only after the complete safe fast-forward proof below.
                resume_state = "WAITING_REVIEW"
                self.store.log(b["id"], "기존 원격/local HEAD 불일치 오류: AI 재실행 없이 소유 PR fast-forward 안전 조건을 재확인합니다", "warn")
            if stranded_review:
                # An interrupted fix may have returned to REVIEW via the safe PR fast-forward. Do not let a
                # historical launch-time marker silently suppress the active -1, or auto-run it indefinitely.
                resume_state = "FIXING"
                self.store.log(b["id"], "운영자 Retry: 미완료 리뷰 이벤트의 현재 PR/HEAD 및 답글 증거를 다시 확인합니다", "warn")
            fields = dict(state=resume_state, error=None, retries=0, retry_after=None,
                          pause_reason="", defect_id=None)
            if stranded_review and not str(b["run_kind"] or "").startswith("fix"):
                fields["run_kind"] = "fix_new"
            self.store.set_line(b["producer"], b["method"], retry_batch=None, run=1)
            self.store.update(b["id"], **fields)
            self.store.log(b["id"], f"운영자 재시도: {resume_state}로 복귀")

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
                (b["run_kind"].startswith("s2_finalize_") or b["run_kind"] == "s2_deterministic_finalize"):
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
        completed = (last is not None and isinstance(last["kind"], str) and last["kind"].startswith("fix")
                and last["ended_at"] is not None and str(last["exit_status"]) == "0"
                and self.store.get(f"verified_completion_run_{b['id']}") == str(last["id"]) and bool(b["pr_number"]))
        if not completed:
            return False
        if b["method"] not in ("a", "b", "c", "d"):
            return True
        try:
            claim = json.loads(self.store.get(f"fix_claim_{b['id']}") or "")
            if claim.get("status") != "HANDLED" or claim.get("run_id") != last["id"]:
                return False
            for key in claim["event_keys"]:
                event = self.store.handled_event(b["id"], claim["pr"], claim["head_sha"], key)
                if (event is None or event["status"] != "HANDLED" or event["run_id"] != last["id"]
                        or event["reply_id"] is None or event["completed_at"] is None):
                    return False
            return True
        except (TypeError, ValueError, KeyError):
            return False

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
        if b["method"] == STAGE3_METHOD:
            try:
                shard = stage3.validate_pr(info, files)
            except stage3.Stage3Error as error:
                raise RecoveryBlocked(str(error)) from error
            if shard != b["shard"]:
                raise RecoveryBlocked(f"PR #{number}가 Stage 3 소유 샤드 {b['shard']}와 다릅니다 ({shard})")
        candidates = batches.pr_claims(b, {"number": number, "files": files})
        expected = batches.expected_claim(b)
        stage3_empty_diff = b["method"] == STAGE3_METHOD and files == []
        if not stage3_empty_diff and (candidates.count(expected) != 1 or any(item != expected for item in candidates)):
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
        if method == STAGE3_METHOD:
            if model != stage3_model(self.cfg):
                return self._blocked(ln, "시작 차단: Stage 3는 고정된 Codex 역할 모델에서만 실행합니다")
            if why := stage3_problem(self.cfg, model):
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
        if method == STAGE3_METHOD:
            return self._prepare_new_stage3(ln)
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

    def _stage3_recover_merged(self, producer: str, base: str) -> None:
        """Restore Stage 3 completion only from issue-linked, merged PRs with the exact shard file scope."""
        if getattr(self, "_s3_recovery_sha", None) == base:
            return
        rows = self.gh.merged_relation_stage3_prs()
        known = {(batch["shard"], batch["pr_number"]) for batch in self.store.all_batches()
                 if batch["method"] == STAGE3_METHOD and batch["state"] == "COMPLETE"
                 and batch["merged"] and batch["pr_number"] is not None}
        seen: set[str] = set()
        for pr in rows:
            shard = stage3.shard_pr(pr)
            if shard is None or pr.get("base_ref") != "master":
                raise stage3.Stage3Error(f"PR #{pr.get('number')} is not a linked Stage 3 PR on master")
            if shard in seen:
                raise stage3.Stage3Error(f"여러 merged Stage 3 PR이 샤드 {shard}를 주장합니다")
            seen.add(shard)
            merge_sha = pr.get("merge_commit_sha") or ""
            if (shard, pr.get("number")) in known:
                continue
            files = self.gh.pull_files(pr["number"])
            if stage3.validate_pr(pr, files) != shard:
                raise stage3.Stage3Error(f"PR #{pr['number']} changed files do not match its shard")
            if not re.fullmatch(r"[a-f0-9]{40}", merge_sha):
                raise stage3.Stage3Error(f"PR #{pr['number']}의 merge commit SHA를 확인할 수 없습니다")
            if not self.git.contains_on_base(merge_sha, self.cfg["base_branch"]):
                continue
            ok, detail = self.git.verify_stage2(base, "shard", shard, None, None)
            if not ok:
                raise stage3.Stage3Error(f"PR #{pr['number']} 머지 후 master Stage 3 shard verify 실패: {detail}")
            self.store.set(stage3.ok_key(shard), base)
            if not self.store.restore_stage3_completion(producer=producer, shard=shard, pr_number=pr["number"],
                                                        merge_sha=merge_sha):
                raise stage3.Stage3Error(f"PR #{pr['number']}와 기존 Stage 3 Store 소유권이 충돌합니다")
        self._s3_recovery_sha = base

    def _prepare_new_stage3(self, ln) -> None:
        """Select the earliest Stage 2 shard verified on this master and not occupied by an edit/PR."""
        model, method = ln["model"], STAGE3_METHOD
        base, line = self.cfg["base_branch"], f"{model}/{method}"
        key = f"line:{model}:{method}:prepare"
        try:
            sha = self.git.fetch_base(base)
            self._stage3_recover_merged(model, sha)
            choice = stage3.choose(sha=sha, kv=self.store, open_prs=self.gh.open_prs(),
                                   stage2_batches=[b for b in self.store.all_batches() if b["method"] == STAGE2_METHOD],
                                   stage3_batches=[b for b in self.store.all_batches() if b["method"] == STAGE3_METHOD],
                                   pin=ln["shard_pin"] if ln["mode"] == "single" else "",
                                   refresh_stage2=lambda shard: stage2.refresh_shard_success(
                                       shard, sha, kv=self.store, changed=self.git.changed_between,
                                       relation_owners=self.git.stage2_affected_relation_shards,
                                       verify=lambda *args: self.git.verify_stage2(sha, *args)))
        except TRANSIENT as error:
            return self._transient_wait(key, error, line=line)
        except Exception as error:
            return self._blocked(ln, f"Stage 3 샤드 선정 실패: {error}")
        self._transient_clear(key, line=line)
        if choice.status == "wait":
            wait_key = f"s3_wait_{model}"
            if self.store.get(wait_key) != choice.note:
                self.store.log(None, f"Stage 3 대기: {choice.note}", line=line)
            self.store.set(wait_key, choice.note)
            return
        self.store.set(f"s3_wait_{model}", "")
        if choice.status == "done":
            self.store.set_line(model, method, run=0, shard_pin="")
            return self.store.log(None, choice.note, line=line)
        shard = choice.shard
        branch = f"s3-{model}-{shard}"
        wt = self.paths.worktrees / f"s3-{shard}"
        try:
            bid = self.store.create_batch(method=method, producer=model, shard=shard, batch="all", branch=branch,
                                          worktree=str(wt), model_tier=ln["model_tier"], from_run=True,
                                          shard_pin=shard if ln["mode"] == "single" else None,
                                          run_kind="s3_chunk_new")
        except LineNotRunnable:
            return
        except LineBusy as error:
            return self.store.log(None, str(error), "warn", line=line)
        self.store.log(bid, f"Stage 3 샤드 {shard} 선정, 단일 PR 청크 편집을 준비합니다")
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
                                   verify=lambda *a: self.git.verify_stage2(sha, *a),
                                   outcome=lambda *a: self.git.verify_stage2_outcome(sha, *a), blocks=self.store,
                                   changed=self.git.changed_between,
                                   relation_owners=self.git.stage2_affected_relation_shards,
                                   relation_owners_many=self.git.stage2_affected_relation_shards_many,
                                   reconcile_completed=lambda *args: self._stage2_start_reconcile(ln, *args))
        except TRANSIENT as e:
            return self._transient_wait(f"line:{model}:{method}:prepare", e, line=line)
        except Exception as e:   # BatchError, GitError, GhError
            return self._blocked(ln, f"Stage 2 Part 선정 실패: {e}")
        self._transient_clear(f"line:{model}:{method}:prepare", line=line)
        if choice.status == "stop":
            return self._blocked(ln, choice.note)
        if choice.status == "verify_failed":   # #2154: a scope block + urgent Issue + Maintainer, never `run=0`
            self.maint.report_verify(choice.failure)
            choice = stage2.Choice("wait", note=f"{choice.failure.scope} verify 실패 차단 — urgent Issue 등록·복구 대기")
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
        if method == STAGE3_METHOD and (problem := stage3_problem(self.cfg, producer)):
            return problem
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
        env.pop("WARROOM_STAGE2_REPAIR", None)
        env.pop("WARROOM_GIT_EXECUTABLES", None)
        env.pop("WARROOM_ANSWER_ONLY", None)
        env.pop("OPENCODE_CONFIG_CONTENT", None)
        ab_chunk = b["method"] in stage1ab.METHODS and isinstance(kind, str) and kind.startswith("ab_chunk_")
        if ab_chunk:   # A/B answer-only is an output contract; adapter-specific tool handling remains unchanged
            env["WARROOM_ANSWER_ONLY"] = "1"
            if self._adapter(b["producer"]).name == "opencode":
                env["OPENCODE_CONFIG_CONTENT"] = json.dumps({"permission": {"edit": "deny", "bash": "deny", "webfetch": "deny"}})
        if b["method"] == STAGE2_METHOD and kind == "s2_repair_new":
            env["WARROOM_ANSWER_ONLY"] = "1"
            env["WARROOM_STAGE2_REPAIR"] = "1"
        # Chunk runs suppress auto-loaded AGENTS.md and web lookup. Execution rules stay adapter-specific; Codex keeps
        # the operator's configured permission profile, while answer-only results are judged by their output contract.
        if (b["method"] in (STAGE2_METHOD, STAGE3_METHOD) and isinstance(kind, str) and
                kind.startswith(("s2_chunk_", "s2_links_", "s2_repair_", "s3_chunk_"))) or \
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
                if self._stage2_reconcile_task(b):
                    base_revision, _change_point, _commits = self._stage2_reconcile_task(b)
                    self.git.create_worktree_at(wt, b["branch"], base_revision)
                else:
                    self.git.fetch_base(self.cfg["base_branch"])
                    self.git.create_worktree(wt, b["branch"], self.cfg["base_branch"])
            elif self.git.registered(wt) != b["branch"]:
                return self._fail(b, "ERROR", f"worktree가 있지만 소유 확인 불가: {wt}")
        except TRANSIENT:
            raise
        except (GitError, ValueError) as e:
            return self._fail(b, "ERROR", f"worktree 준비 실패: {e}")
        if b["method"] == STAGE2_METHOD:
            if self._stage2_reconcile_task(b):
                return self._stage2_reconcile_finalize(b)
            return self._launch_stage2_next(b)
        if b["method"] == STAGE3_METHOD:
            return self._launch_stage3_next(b)
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
        """Start one primary/optional review session or continue deterministic local finalization."""
        try:
            checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
            phase = stage2.next_action(checkpoint)
        except (OSError, ValueError, KeyError, TypeError) as e:
            return self._fail(b, "ERROR", f"Stage 2 checkpoint 확인 실패: {e}. worktree를 보존합니다.")
        if phase == "complete_optional":
            try:
                bb, pp = stage2.split_key(b["batch"])
                self.git.stage2_complete_optional(Path(b["worktree"]), b["shard"], bb, pp)
            except TRANSIENT:
                raise
            except (GitError, OSError, ValueError) as e:
                return self._fail(b, "ERROR", f"optional-link 완료 표시 실패: {e}. worktree를 보존합니다.")
            return self._launch_stage2_next(self.store.batch(b["id"]))
        if phase == "finalize":
            return self._stage2_finalize(b)
        return self._launch(b, "s2_links_new" if phase == "links" else "s2_chunk_new")

    def _launch_stage3_next(self, b) -> None:
        self._guarded(b, "prelaunch", lambda current: self._launch(current, "s3_chunk_new"),
                      entrypoint="launch_stage3_next")

    def _relaunch_stage3_chunk(self, b) -> None:
        """Resume this exact unsaved chunk or accept its one saved checkpoint advance; never select a new shard."""
        try:
            if self.git.registered(Path(b["worktree"])) != b["branch"]:
                return self._fail(b, "ERROR", "Stage 3 worktree가 소유 브랜치에 등록되어 있지 않습니다. 보존합니다.")
            if self.git.dirty(b["worktree"]).strip():
                return self._fail(b, "ERROR", "Stage 3 재시도 전 추적 파일 변경이 있어 보존합니다.")
            if self._find_recovery_pr(b) is not None:
                return self._fail(b, "ERROR", "Stage 3 청크 중 예상하지 않은 소유 PR이 있어 재실행을 중단합니다. 보존합니다.")
        except TRANSIENT:
            raise
        except Exception as error:
            return self._fail(b, "ERROR", f"Stage 3 재시도 전 worktree/PR 확인 실패: {error}. 보존합니다.")
        raw = self.store.get(stage3.run_start_key(b["id"]))
        if raw is not None:
            problem = self._stage3_chunk_boundary_problem(b)
            if problem:
                return self._fail(b, "ERROR", problem)
            baseline = json.loads(raw)
            if baseline.get("view") is None:
                if self._stage3_chunk_saved(b):
                    return self._fail(b, "ERROR", "view 스냅샷이 없는 구 Stage 3 실행에서 checkpoint가 진행됐습니다. 저장 응답의 원본을 증명할 수 없어 다음 청크로 진행하지 않고 보존합니다.")
                return self._stage3_fallback_for_missing_view(b)
            if not isinstance(baseline["view"], dict):
                return self._fail(b, "ERROR", "Stage 3 실행 시작 read-chunk view 스냅샷이 손상되었습니다. worktree와 응답을 보존합니다.")
            if baseline.get("answer_invalidated"):
                if self._stage3_chunk_saved(b):
                    return self._fail(b, "ERROR", "입력 view 변경으로 응답이 무효화된 Stage 3 청크가 이미 저장됐습니다. checkpoint와 결과를 보존합니다.")
                try:
                    current_view = stage3.read_chunk(self.runner, self.env, b["worktree"], b["shard"])
                except TRANSIENT:
                    raise
                except Exception as error:
                    return self._fail(b, "ERROR", f"Maintainer 통합 후 현재 Stage 3 청크 재준비를 확인하지 못했습니다: {error}. 보존합니다.")
                if current_view != baseline["view"] or current_view.get("chunk") != baseline.get("chunk"):
                    return self._fail(b, "ERROR", "Maintainer 통합 후 Stage 3 청크 view가 재결속된 기준과 달라 재사용/재생성을 중단합니다. 보존합니다.")
                try:
                    if self._find_recovery_pr(b) is not None:
                        return self._fail(b, "ERROR", "Stage 3 청크 재준비 전에 예상하지 않은 소유 PR이 있어 중단합니다. 보존합니다.")
                except TRANSIENT:
                    raise
                except Exception as error:
                    return self._fail(b, "ERROR", f"Stage 3 청크 재준비 전 PR 소유권 확인 실패: {error}. 보존합니다.")
                self.store.log(b["id"], f"Maintainer 통합으로 Stage 3 청크 {baseline['chunk']} 입력 view가 바뀌어 이전 답변을 폐기하고 같은 미완료 청크만 새 세션으로 준비합니다.", "warn")
                self.store.update(b["id"], session_id=None)
                return self._launch(self.store.batch(b["id"]), "s3_chunk_fallback_new")
        if self._stage3_chunk_saved(b):
            if problem := self._saved_chunk_identity_problem(b):
                return self._fail(b, problem[0], f"저장된 Stage 3 청크의 실행 소유권/핀 확인 실패: {problem[1]}")
            self.store.log(b["id"], "이전 실행의 현재 Stage 3 청크 저장을 확인했습니다. 재생산하지 않고 다음 청크로 진행합니다.")
            self.store.delete(stage3.run_start_key(b["id"]))
            self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
            return self._launch_stage3_next(self.store.batch(b["id"]))
        if raw is not None:
            if b["run_kind"] == "s3_chunk_fallback_new":
                return self._fail(b, "PAUSED", "해당 Stage 3 청크의 허용된 새 세션도 완료되지 않았습니다. 추가 AI 재호출 없이 상태를 보존합니다.")
            latest_run = next(iter(self.store.runs(b["id"])), None)
            submit_failures = int(latest_run["submit_failures"] or 0) if latest_run else 0
            if submit_failures >= 2:
                return self._fail(b, "ERROR", "정규화한 Stage 3 응답도 strict save-chunk가 거부했습니다. AI 재호출 없이 worktree와 응답을 보존합니다.")
            answer = self._adapter(b["producer"]).final_answer(Path(b["log_file"])) if b["log_file"] else None
            if answer is not None:
                if problem := self._saved_chunk_identity_problem(b):
                    self.store.log(b["id"], f"보존된 Stage 3 응답 소유권을 확인하지 못해 현재 청크만 새 세션으로 전환합니다: {problem[1]}", "warn")
                else:
                    self.store.log(b["id"], "보존된 Stage 3 응답과 청크 소유권을 확인했습니다. AI 재호출 없이 결정 정규화와 strict 저장을 다시 수행합니다.", "warn")
                    return self._run_ok_stage3_chunk(self.store.batch(b["id"]))
            else:
                self.store.log(b["id"], "보존된 Stage 3 최종 응답이 없어 현재 미완료 청크만 새 세션으로 생성합니다.", "warn")
            self.store.update(b["id"], session_id=None, run_kind="s3_chunk_fallback_new")
            return self._launch(self.store.batch(b["id"]), "s3_chunk_fallback_new")
        else:
            # A failed launch can occur before a chunk baseline is saved. Start only from a clean owned worktree;
            # `_launch` will create/validate the checkpoint and pin the exact current next chunk.
            kind = "s3_chunk_new"
        return self._launch(b, kind)

    def _stage3_chunk_saved(self, b) -> bool:
        raw = self.store.get(stage3.run_start_key(b["id"]))
        if raw is None:
            return False
        try:
            baseline = json.loads(raw)
            if (not isinstance(baseline, dict) or not isinstance(baseline.get("checkpoint"), dict)
                    or baseline.get("chunk") != stage3.next_chunk(baseline["checkpoint"])):
                return False
            after = stage3.checkpoint(b["worktree"], b["shard"])
            return stage3.chunk_saved_since(baseline["checkpoint"], after)
        except (OSError, ValueError, KeyError, TypeError, stage3.Stage3Error):
            return False

    def _stage3_chunk_boundary_problem(self, b) -> str | None:
        raw = self.store.get(stage3.run_start_key(b["id"]))
        if raw is None:
            return "Stage 3 청크 실행 기준이 없어 재개를 중단합니다. worktree를 보존합니다."
        try:
            baseline = json.loads(raw)
            if (not isinstance(baseline, dict) or baseline.get("branch") != b["branch"]
                    or baseline.get("worktree") != str(b["worktree"])
                    or baseline.get("chunk") != stage3.next_chunk(baseline.get("checkpoint", {}))):
                return "Stage 3 청크 실행 기준이 손상되었거나 다른 실행을 가리킵니다. worktree를 보존합니다."
            wt = Path(b["worktree"])
            if self.git.registered(wt) != b["branch"]:
                return "Stage 3 worktree가 소유 브랜치에 등록되어 있지 않습니다. 보존합니다."
            if self.git.head(wt) != baseline.get("head"):
                return "Stage 3 AI 실행 중 worktree HEAD가 바뀌었습니다. 보존합니다."
            if self.git.remote_head(b["branch"]) != baseline.get("remote_head"):
                return "Stage 3 AI 실행 중 원격 브랜치가 바뀌었습니다. 보존합니다."
            if self.git.dirty(wt).strip():
                return "Stage 3 AI가 Git 추적 파일을 변경했습니다. 결정 파일로 받아들이지 않고 보존합니다."
            current = stage3.checkpoint(wt, b["shard"])
            original = baseline["checkpoint"]
            if current is None or (current != original and not stage3.chunk_saved_since(original, current)):
                return "Stage 3 checkpoint가 실행 시작 상태와 다릅니다. 변경을 Keep-all로 가리지 않고 보존합니다."
        except TRANSIENT:
            raise
        except Exception as error:
            return f"Stage 3 실행 경계를 확인하지 못했습니다: {error}. 보존합니다."
        return None

    def _stage3_fallback_for_missing_view(self, b) -> None:
        """Discard an unbound legacy answer and start this exact chunk once with a saved view."""
        if b["run_kind"] == "s3_chunk_fallback_new":
            return self._fail(b, "PAUSED", "새 Stage 3 fallback 실행 기준에 read-chunk view가 없습니다. 추가 AI 재호출 없이 상태를 보존합니다.")
        self.store.log(b["id"], "기존 Stage 3 실행에 원본 read-chunk view 스냅샷이 없어 보존 응답을 폐기하고 현재 청크만 새 세션으로 처리합니다.", "warn")
        self.store.update(b["id"], session_id=None, run_kind="s3_chunk_fallback_new")
        return self._launch(self.store.batch(b["id"]), "s3_chunk_fallback_new")

    def _run_ok_stage3_chunk(self, b) -> None:
        if problem := self._stage3_chunk_boundary_problem(b):
            return self._fail(b, "ERROR", problem)
        try:
            baseline = json.loads(self.store.get(stage3.run_start_key(b["id"])) or "{}")
            chunk = baseline["chunk"]
            if baseline.get("view") is None:
                if self._stage3_chunk_saved(b):
                    return self._fail(b, "ERROR", "view 스냅샷이 없는 구 Stage 3 실행에서 checkpoint가 진행됐습니다. 저장 응답의 원본을 증명할 수 없어 다음 청크로 진행하지 않고 보존합니다.")
                info = self._find_recovery_pr(b)
                if info is not None:
                    raise stage3.Stage3Error(f"청크 실행 중 소유 PR #{info['number']}이 발견되었습니다")
                return self._stage3_fallback_for_missing_view(b)
            if not isinstance(baseline["view"], dict):
                raise stage3.Stage3Error("Stage 3 실행 시작 read-chunk view 스냅샷이 손상되었습니다")
            if self._stage3_chunk_saved(b):
                info = self._find_recovery_pr(b)
                if info is not None:
                    raise stage3.Stage3Error(f"저장 청크 진행 중 소유 PR #{info['number']}이 발견되었습니다")
                saved = {"chunk": chunk}
                after = stage3.checkpoint(b["worktree"], b["shard"])
            else:
                info = self._find_recovery_pr(b)
                if info is not None:
                    raise stage3.Stage3Error(f"청크 실행 중 소유 PR #{info['number']}이 발견되었습니다")
                answer = self._adapter(b["producer"]).final_answer(Path(b["log_file"]))
                view = stage3.read_chunk(self.runner, self.env, b["worktree"], b["shard"])
                original_view = baseline["view"]
                if original_view != view:
                    raise stage3.Stage3Error("read-chunk view가 실행 시작 시 저장한 결정 기준과 다릅니다")
                context = stage3.decision_context(original_view, chunk)
                normalized, warnings = stage3.normalize_decisions(answer, chunk, context)
                if warnings:
                    self.store.log(b["id"], f"Stage 3 청크 {chunk} 판정 정규화: {'; '.join(warnings)}", "warn")
                saved = stage3.save_chunk(self.runner, self.env, b["worktree"], b["shard"], chunk, normalized)
                after = stage3.checkpoint(b["worktree"], b["shard"])
                if saved.get("chunk") != chunk or not stage3.chunk_saved_since(baseline["checkpoint"], after):
                    raise stage3.Stage3Error("save-chunk 결과가 checkpoint를 정확히 한 청크만 진행시키지 않았습니다")
            progress = stage3.progress(after)
        except TRANSIENT:
            raise
        except (OSError, ValueError, KeyError, TypeError, RecoveryBlocked, DuplicateClaim, stage3.Stage3Error) as error:
            self.store.add_submit_failure(b["id"])
            return self._fail(b, "ERROR", f"Stage 3 청크 응답을 저장하지 못했습니다. worktree와 로그를 보존합니다: {error}")
        self.store.delete(stage3.run_start_key(b["id"]))
        self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None,
                          progress_kind="chunks", progress_done=progress[0], progress_total=progress[1])
        self.store.log(b["id"], f"Stage 3 청크 {saved.get('chunk', chunk)} 저장 ({progress[0]}/{progress[1]}). 다음 청크는 새 세션에서 시작합니다.")
        return self._launch_stage3_next(self.store.batch(b["id"]))

    @staticmethod
    def _stage3_cli_crash(outcome) -> bool:
        """Only a repeated project-code runtime exception can enter the shared Maintainer route.

        Structured rows/accounting failures are data or editorial verification findings. Unclassified command failures
        stay local unless their evidence identifies an uncaught exception in the shared Relation CLI itself.
        """
        code = getattr(outcome, "code", None)
        detail = str(getattr(outcome, "tail", "") or "")
        lowered = detail.lower()
        if (type(code) is not int or code in (0, 2, 124, 127)
                or not re.search(r"\b(?:TypeError|ReferenceError|SyntaxError|RangeError|AssertionError|ERR_ASSERTION)\b", detail)
                or not re.search(r"(?:scripts/relation/|admission-cli\.mjs)", detail)):
            return False
        return not any(token in lowered for token in (
            "permission denied", "eacces", "eperm", "unauthorized", "authentication", "rate limit",
            "timed out", "timeout", "network", "module not found", "cannot find module", "command not found",
        ))

    def _stage3_finalize_verify(self, b, head: str) -> str | None:
        """Verify this exact Stage 3 commit; return an error or reported after a proven shared CLI crash."""
        args = (head, "shard", b["shard"], None, None)
        command = f"node scripts/relation/admission-cli.mjs verify --shard {b['shard']} --json"
        first = self.git.verify_stage2_outcome(*args)
        if first.ok:
            return None
        if first.failure is not None:
            return f"Stage 3 shard verify에서 데이터/편집 검증 오류가 확인됐습니다 (HEAD {head[:10]}): {first.tail}"
        second = self.git.verify_stage2_outcome(*args)
        same_failure = (not second.ok and second.failure is None and first.code == second.code
                        and first.tail == second.tail)
        if not same_failure or not self._stage3_cli_crash(first):
            detail = second.tail if not same_failure else first.tail
            return (f"Stage 3 shard verify 실패를 공통 코드 결함으로 확인하지 못했습니다 "
                    f"(HEAD {head[:10]}, 재현 일치={same_failure}): {detail}")

        fingerprint = hashlib.sha256(f"{head}\n{command}\n{first.code}\n{first.tail}".encode("utf-8")).hexdigest()[:16]
        report = {
            "version": 1,
            "defect_class": f"stage3-verify-cli-{b['shard']}",
            "summary": f"Stage 3 샤드 {b['shard']} verify가 같은 HEAD에서 Relation CLI runtime exception으로 두 번 실패했습니다.",
            "failing_cases": [f"HEAD {head}; {command}; exit {first.code}; {first.tail}"],
            "reproduction": f"{command} at HEAD {head}; 두 번 실행해 exit {first.code}와 동일 오류를 확인했습니다.",
            "suspected_layer": f"{command} (uncaught project-code runtime exception)",
            "root_cause": "공식 verify 명령이 코드 예외로 종료했습니다. Maintainer가 공유 CLI/검증기 원인을 조사해야 합니다.",
            "scope": f"Stage 3 최종화, shard {b['shard']}; 동일 명령과 오류를 재현한 HEAD {head}.",
            "proposed_fix": "예외를 발생시킨 공유 CLI/검증기 원인을 수정하고 재현 회귀를 추가합니다.",
            "regression": f"HEAD {head}의 {command}에서 관찰된 예외를 old-fails/new-passes로 재현합니다.",
        }
        event_key = f"stage3-verify:{b['id']}:{head}:{fingerprint}"
        self.maint.report(b, "report", event_key, json.dumps(report, ensure_ascii=False, sort_keys=True))
        current = self.store.batch(b["id"])
        if current["state"] == "PAUSED" and current["pause_reason"] == "shared_defect":
            self.store.log(b["id"], f"Stage 3 shard verify의 공통 CLI 예외를 같은 HEAD에서 재현해 기존 Maintainer 경로로 이관했습니다 ({command}).", "warn")
            return "reported"
        return "Stage 3 verify의 재현된 CLI 오류를 Maintainer 경로에 등록하지 못했습니다. worktree를 보존합니다."

    def _stage3_log_repair_conflicts(self, b, result: dict) -> None:
        conflicts = result.get("repair_conflicts", [])
        if not conflicts:
            return
        details = []
        for item in conflicts:
            conflict = item["conflict"]
            if conflict["kind"] == "other_shard_relation":
                origin = "다른 샤드 승인 Relation"
            elif conflict["kind"] == "surviving_relation":
                origin = f"기존 Relation row {conflict['relation_row']}"
            else:
                origin = f"앞서 선택한 Link Repair row {conflict['relation_row']}"
            details.append(
                f"row {item['relation_row']} {item['source_sense_id']}↔{item['target_sense_id']} "
                f"(중복 상대: {origin} {conflict['source_sense_id']}↔{conflict['target_sense_id']})"
            )
        self.store.log_once(b["id"], "중복 ID pair Link Repair를 text-only로 보존: " + "; ".join(details))

    def _stage3_finalize(self, b) -> None:
        self._guarded(b, "finalize", self._stage3_finalize_do)

    def _stage3_finalize_do(self, b) -> None:
        """Apply all persisted chunk edits, verify and submit the shard's single bounded data PR."""
        wt = Path(b["worktree"])
        self.store.update(b["id"], state="PRODUCING", pid=None, run_kind="s3_finalize", error=None)
        allowed = {f"data/relations/relation-{b['shard']}.jsonl",
                   f"data/relation-drops/drop-{b['shard']}.jsonl"}
        title = f"[Relation Stage 3] {b['shard']}"
        try:
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._to_review(b, info)
            checkpoint = stage3.checkpoint(wt, b["shard"])
            applied_key = f"s3_apply_ready_{b['id']}"
            result_key = f"s3_apply_result_{b['id']}"
            if checkpoint is not None:
                if len(checkpoint["completed_chunks"]) != checkpoint["chunk_total"]:
                    raise stage3.Stage3Error("모든 Stage 3 청크 완료 전에 apply 할 수 없습니다")
                # The edit CLI removes the local checkpoint after its atomic two-file apply. Persist this in-flight
                # finalization state so a Supervisor restart can report the Git diff and continue without re-editing.
                self.store.set(applied_key, "1")
                result = stage3.apply(self.runner, self.env, wt, b["shard"])
                self.store.set(result_key, json.dumps(result, sort_keys=True))
            elif self.store.get(applied_key) == "1":
                raw_result = self.store.get(result_key)
                try:
                    result = json.loads(raw_result) if raw_result else {}
                except (TypeError, ValueError) as error:
                    raise stage3.Stage3Error("저장된 Stage 3 apply 결과를 읽을 수 없습니다") from error
                if not isinstance(result, dict):
                    raise stage3.Stage3Error("저장된 Stage 3 apply 결과 형식이 올바르지 않습니다")
            else:
                raise stage3.Stage3Error("Stage 3 checkpoint가 없어 apply 완료 여부를 복구할 수 없습니다")
            self._stage3_log_repair_conflicts(b, result)
            report = stage3.report(self.runner, self.env, wt, b["shard"])
            result.setdefault("removed", len(report.get("deleted_relations", [])))
            result.setdefault("repaired", len(report.get("link_repairs", [])))
            result.setdefault("edit_drops_added", len(report.get("added_drops", [])))
            self.store.set(result_key, json.dumps(result, sort_keys=True))
            changed = self.git.changed_paths(wt)
            unexpected = changed - allowed
            if unexpected:
                raise GitError(f"Stage 3 apply가 허용되지 않은 파일을 변경했습니다: {sorted(unexpected)}")
            commit_key = f"s3_commit_head_{b['id']}"
            committed = self.store.get(commit_key)
            head = self.git.head(wt)
            self.maint.adopt_released_baseline(self.store.batch(b["id"]))
            released_head = self.store.get(f"s3_finalize_released_head_{b['id']}")
            if committed is not None:
                if committed == head:
                    if changed or set(self.git.changed_files(head)) - allowed:
                        raise GitError(f"기록된 Stage 3 commit이 허용 파일 범위를 벗어났습니다 ({committed} / {head})")
                elif (released_head != head or not self.git.contains(wt, committed)
                      or set(self.git.changed_files(committed)) - allowed):
                    raise GitError(f"기록된 Stage 3 commit과 승인된 Maintainer 통합 HEAD가 다릅니다 ({committed} / {head})")
                else:
                    self.store.log(b["id"], f"승인된 Maintainer 통합 HEAD {head[:10]}에서 기존 Stage 3 데이터 commit {committed[:10]}을 이어 검증합니다.")
            elif changed:
                head = self.git.commit_paths(wt, sorted(changed), title)
                self.store.set(commit_key, head)
                self.store.log(b["id"], f"Stage 3 변경 파일을 commit했습니다 ({head[:10]})")
            elif self.git.commit_subject(wt) == title and self.git.commit_parent(wt) is not None:
                committed_paths = set(self.git.changed_files(head))
                unexpected = committed_paths - allowed
                if unexpected:
                    raise GitError(f"기존 Stage 3 commit이 허용되지 않은 파일을 변경했습니다: {sorted(unexpected)}")
                head = self.git.head(wt)
                self.store.set(commit_key, head)
            else:
                head = self.git.commit_paths(wt, [], title, allow_empty=True)
                self.store.set(commit_key, head)
                self.store.log(b["id"], "Stage 3 변경이 없는 샤드를 명시적 empty commit으로 기록했습니다")
            if self.git.dirty(wt).strip():
                raise GitError("Stage 3 commit 뒤 worktree가 깨끗하지 않아 push를 중단합니다")
            remote = self.git.remote_head(b["branch"])
            remote_key = f"s3_commit_remote_head_{b['id']}"
            previous_remote = self.store.get(remote_key)
            if previous_remote is None:
                self.store.set(remote_key, remote or "")
            elif previous_remote != (remote or "") and remote != head:
                raise GitError(f"Stage 3 verify 전 기록한 원격 기준이 변경됐습니다 ({previous_remote or None} / {remote})")
            verify = self._stage3_finalize_verify(b, head)
            if verify == "reported":
                return
            if verify:
                raise GitError(verify)
            if remote != head:
                if remote is not None and not self.git.contains(wt, remote):
                    raise GitError(f"Stage 3 원격 브랜치가 로컬 HEAD의 조상이 아닙니다 ({remote} / {head})")
                self.git.push_branch(wt, b["branch"])
                remote = self.git.remote_head(b["branch"])
            if remote != head:
                raise GitError(f"push 뒤 Stage 3 원격 HEAD가 다릅니다 ({remote} / {head})")
            open_prs = self.gh.open_prs()
            occupied = set().union(*(batches.pr_stage3_shards(pr) for pr in open_prs)) if open_prs else set()
            if b["shard"] in occupied:
                raise stage3.Stage3Error(f"샤드 {b['shard']} Relation/Drop을 점유한 다른 PR이 열려 있습니다")
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._to_review(b, info)
            issue = self.gh.issue(2450)
            labels = issue.get("labels", [])
            body = "\n".join([
                "Relation Factory Stage 3 샤드 편집",
                f"- 관련 작업: #2450",
                f"- 샤드: {b['shard']}",
                "- 범위: 승인 Relation Drop 및 text-only Link Repair",
                f"- 결과: {result.get('removed', 0)}행 삭제, {result.get('repaired', 0)}행 Link Repair, "
                f"{result.get('edit_drops_added', 0)}개 edit Drop 추가",
                "- 검증: edit-cli apply 및 shard admission verify",
                "- 변경 파일: 해당 샤드 Relation/Drop 파일만",
            ]) + "\n"
            return self._create_pr_once(b, title, body, labels)
        except TRANSIENT:
            raise
        except (GitError, stage3.Stage3Error, OSError, ValueError, KeyError, TypeError) as error:
            return self._fail(b, "ERROR", f"Stage 3 최종화 중단: {error}. worktree와 checkpoint를 보존합니다.")
        except Exception as error:
            return self._fail(b, "ERROR", f"Stage 3 최종화 중단: {error}. worktree와 checkpoint를 보존합니다.")

    # ---- launching runs ------------------------------------------------
    def _run(self, b) -> RunSpec:
        """The model and effort this batch's next run is pinned to (the current tier for OpenCode)."""
        return run_spec(self.cfg, b["producer"], b["model_tier"], role_of(b["method"]))

    def _recorded_run(self, b) -> RunSpec | None:
        """The model and effort the batch's current run was launched with (the store is the source of truth)."""
        r = next((r for r in self.store.runs(b["id"]) if r["model"]), None)
        return RunSpec(r["model"], r["effort"], r["permission_profile"] or "") if r else None

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
        """Launch one run with the current effective settings; Stage 2/3 use bounded review-fix prompts."""
        if (b["method"] == STAGE2_METHOD and str(b["run_kind"] or "").startswith("s2_reconcile|")
                and isinstance(kind, str) and kind.startswith("fix")):
            return self._stage2_reconcile_review_fix(b, events)
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
        if b["method"] == STAGE3_METHOD and kind.endswith("_resume"):
            recorded = self._recorded_run(b)
            if recorded is None:
                return self._fail(b, "ERROR", "Stage 3 기존 세션의 model/effort/permission_profile 기록이 없어 재개하지 않습니다. "
                                  "worktree와 세션을 보존합니다.")
            if recorded != run:
                return self._fail(
                    b, "ERROR",
                    "Stage 3 프로필이 기존 실행 후 바뀌어 그 세션을 새 설정으로 재개하지 않습니다 "
                    f"(기존 model={recorded.model}, effort={recorded.effort}, "
                    f"permission_profile={recorded.permission_profile or '(기본)'}; "
                    f"현재 model={run.model}, effort={run.effort}, "
                    f"permission_profile={run.permission_profile or '(기본)'}). "
                    "worktree와 세션을 보존합니다.",
                )
        if kind.startswith("fix") and b["method"] in ("a", "b", "c", "d", STAGE3_METHOD) and not events:
            return self._fail(b, "ERROR", "현재 PR HEAD에 유효한 리뷰 수정 이벤트가 없어 AI를 시작하지 않았습니다. 오래된 HEAD 이벤트는 되살리지 않습니다.")
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
        fix_context_digests = {}
        extra = {}
        if getattr(ad, "needs_git_dir", False):   # one rule for every launch kind: the owned worktree's Git admin dir
            try:
                extra["git_dir"] = self.git.worktree_gitdir(Path(wt))
            except Exception as e:
                return self._fail(b, "ERROR", f"worktree의 Git 관리 디렉터리를 확인할 수 없어 AI를 시작하지 않았습니다: {e}")
        try:
            run_env = self._launch_env(b, kind, agent_env)
            remote = "?"
            if isinstance(kind, str) and kind.startswith(("s2_chunk_", "s2_links_", "s2_repair_", "s3_chunk_", "c_chunk_", "d_chunk_", "ab_chunk_")):
                remote = self.git.remote_head(b["branch"])   # the one remote read, before any view/page/decision write
            if b["method"] == STAGE3_METHOD and kind.startswith("s3_chunk_"):
                checkpoint = stage3.checkpoint(wt, b["shard"])
                if checkpoint is None:
                    checkpoint = stage3.prepare(self.runner, run_env, wt, b["shard"])
                chunk = stage3.next_chunk(checkpoint)
                if chunk is None:
                    return self._stage3_finalize(b)
                view = stage3.read_chunk(self.runner, run_env, wt, b["shard"])
                if view["chunk"] != chunk:
                    raise prompts.PromptError("Stage 3 read-chunk가 checkpoint의 다음 청크와 다릅니다")
                prompt = prompts.stage3_chunk(b, chunk, json.dumps(view, ensure_ascii=False, indent=2),
                                              resumed=kind == "s3_chunk_resume")
                baseline = {"checkpoint": checkpoint, "chunk": chunk, "branch": b["branch"],
                            "worktree": str(wt), "head": self.git.head(Path(wt)), "remote_head": remote,
                            "view": view}
                self.store.set(stage3.run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                title = f"Stage 3 {b['shard']} chunk {chunk}"
                if kind == "s3_chunk_resume":
                    h = ad.resume(sid, prompt, wt, run_env, run, log, ex, **extra)
                else:
                    h = ad.start(prompt, wt, run_env, run, title, log, ex, **extra)
            elif b["method"] == STAGE2_METHOD and kind.startswith("s2_"):
                checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
                if kind.startswith("s2_chunk_"):
                    if kind == "s2_chunk_new" and stage2.next_action(checkpoint) == "chunk":
                    # The Supervisor, not the AI, prepares the Part and renders the one compact chunk view; the whole
                    # view goes into the prompt and the AI only answers with its decisions.
                        bb, pp = stage2.split_key(b["batch"])
                        self.git.stage2_chunk_view(Path(wt), b["shard"], bb, pp, prepare=checkpoint is None)
                        checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
                        if stage2.next_action(checkpoint) != "chunk":
                            self.store.log(b["id"], "primary 후보가 없어 다음 deterministic Stage 2 단계로 진행합니다.")
                            return self._launch_stage2_next(self.store.batch(b["id"]))
                        view = (Path(wt) / stage2.CHUNK_VIEW).read_text("utf-8")
                        stage2.clear_decisions(wt)   # a new chunk never inherits the previous chunk's decision file
                    if stage2.next_action(checkpoint) != "chunk":
                        raise prompts.PromptError("Stage 2 primary 청크 실행과 현재 checkpoint 상태가 다릅니다")
                    title = f"Stage 2 {stage2.label(b['shard'], b['batch'])} chunk"
                    if kind in ("s2_chunk_fix", "s2_chunk_format_fix"):
                        problem = self._stage2_chunk_boundary_problem(b)
                        if problem:
                            return self._fail(b, "ERROR", problem)
                        detail = self._s2_fix_problem.pop(b["id"], None)
                        if not sid or not checkpoint["pending_chunk"] or not detail:
                            raise prompts.PromptError("수정 요청에 기존 세션·pending 청크·오류 목록이 모두 필요합니다")
                        file_state = stage2.decision_file_state(wt, checkpoint["pending_chunk"])
                        if kind == "s2_chunk_format_fix":
                            if file_state != "missing":
                                raise prompts.PromptError("전체 형식 수정에는 기존 판정 파일이 없어야 합니다")
                            prompt = prompts.stage2_chunk_format_fix(checkpoint["pending_chunk"], detail, checkpoint)
                        else:
                            if file_state != "current":
                                raise prompts.PromptError("부분 수정에는 현재 pending 청크의 기존 판정 파일이 필요합니다")
                            prompt = prompts.stage2_chunk_fix(checkpoint["pending_chunk"], detail, checkpoint)
                        h = ad.resume(sid, prompt, wt, run_env, run, log, ex, **extra)
                    else:
                        if kind == "s2_chunk_resume":
                            if not checkpoint["pending_chunk"]:
                                raise prompts.PromptError("이어갈 pending 청크가 없습니다")
                            prompt = prompts.stage2_chunk_resume(checkpoint["pending_chunk"], checkpoint)
                        else:
                            prompt = prompts.stage2(b, "chunk", checkpoint, resumed=False, view=view)
                        baseline = {"checkpoint": checkpoint, "branch": b["branch"], "worktree": str(wt),
                                    "head": self.git.head(wt), "remote_head": remote}
                        self.store.set(stage2.run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                        if kind.endswith("_resume"):
                            h = ad.resume(sid, prompt, wt, run_env, run, log, ex, **extra)
                        else:
                            h = ad.start(prompt, wt, run_env, run, title, log, ex, **extra)
                elif kind in ("s2_links_new", "s2_links_fix"):
                    if checkpoint is None or stage2.next_action(checkpoint) != "links":
                        raise prompts.PromptError("optional-link 검토가 필요한 checkpoint가 없습니다")
                    bb, pp = stage2.split_key(b["batch"])
                    link_path = Path(wt) / ".warroom-scratch" / "optional-decisions.txt"
                    if kind == "s2_links_new":
                        link_path.unlink(missing_ok=True)
                        view = self.git.stage2_optional_view(Path(wt), b["shard"], bb, pp)
                        if view.startswith("# no optional links"):
                            self.git.stage2_complete_optional(Path(wt), b["shard"], bb, pp)
                            return self._launch_stage2_next(self.store.batch(b["id"]))
                        pages = stage2.chunk_pages(view)
                        view_path = ".warroom-scratch/active-links.txt"
                        (Path(wt) / view_path).write_text(view, "utf-8")
                        page_paths = stage2.write_pages(Path(wt), view_path, pages)
                        if len(page_paths) == 1:
                            link_input = f"<<<OPTIONAL_LINKS_BEGIN>>>\n{view}<<<OPTIONAL_LINKS_END>>>"
                        else:
                            link_input = ("입력이 커서 다음 page 파일로 나뉘었다. 각 파일을 별도 도구 호출로 한 번씩 읽는다. "
                                          "모든 page는 같은 target alias와 digest를 사용한다.\n" +
                                          "\n".join(f"- cat {name} ({i}/{len(page_paths)})" for i, name in enumerate(page_paths, 1)))
                        prompt = prompts.stage2_links(b, checkpoint, link_input)
                        digest_match = re.search(r"^links @([a-f0-9]{64})$", view, re.M)
                        if not digest_match:
                            raise prompts.PromptError("optional-link view에 digest header가 없습니다")
                        baseline = {"checkpoint_sha256": hashlib.sha256((Path(wt) / ".warroom-scratch" /
                                    f"relation-admission-{b['shard']}-{bb}-{pp}.json").read_bytes()).hexdigest(),
                                    "branch": b["branch"], "worktree": str(wt), "head": self.git.head(wt),
                                    "remote_head": remote, "digest": digest_match.group(1)}
                        self.store.set(stage2.links_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                        h = ad.start(prompt, wt, run_env, run, f"Stage 2 {stage2.label(b['shard'], b['batch'])} optional links", log, ex, **extra)
                    else:
                        problem = self._stage2_links_boundary_problem(b)
                        detail = self._s2_links_problem.pop(b["id"], None)
                        if problem:
                            return self._fail(b, "ERROR", problem)
                        if not sid or not detail:
                            raise prompts.PromptError("optional-link 수정에는 같은 세션과 저장 거부 진단이 필요합니다")
                        baseline = json.loads(self.store.get(stage2.links_start_key(b["id"])) or "{}")
                        if not re.fullmatch(r"[a-f0-9]{64}", baseline.get("digest", "")):
                            raise prompts.PromptError("optional-link 수정 digest 기준이 없습니다")
                        prompt = prompts.stage2_links_fix(baseline["digest"], detail, checkpoint)
                        h = ad.resume(sid, prompt, wt, run_env, run, log, ex, **extra)
                elif kind == "s2_repair_new":
                    state = self._stage2_repair_state(b, required=True)
                    current = state.get("current")
                    if not isinstance(current, dict) or current.get("pending_answer") is not None:
                        raise prompts.PromptError("Stage 2 repair needs one unapplied, persisted repair page")
                    cursor = current.get("cursor")
                    groups = current.get("groups")
                    if type(cursor) is not int or not isinstance(groups, list) or cursor >= len(groups):
                        raise prompts.PromptError("Stage 2 repair page cursor is outside its saved conflict list")
                    page = groups[cursor:cursor + stage2.REPAIR_GROUPS_PER_RUN]
                    page_keys = sorted({key for group in page for key in group.get("candidate_keys", [])})
                    bb, pp = stage2.split_key(b["batch"])
                    cp_path = Path(wt) / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.json"
                    baseline = {"branch": b["branch"], "worktree": str(wt), "head": self.git.head(Path(wt)),
                                "remote_head": remote, "checkpoint_sha256": hashlib.sha256(cp_path.read_bytes()).hexdigest(),
                                "fingerprint": current["fingerprint"], "cursor": cursor, "page_keys": page_keys}
                    self.store.set(stage2.repair_run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                    prompt = prompts.stage2_repair(
                        b, current["fingerprint"], json.dumps({"groups": page}, ensure_ascii=False, separators=(",", ":")),
                        f"{state['rounds_used']}/{stage2.MAX_REPAIR_ROUNDS}; groups {cursor + 1}..{cursor + len(page)} of {len(groups)}",
                        type_tier_policy=current.get("type_tier_policy", "legacy-independent"),
                    )
                    h = ad.start(prompt, wt, run_env, run,
                                 f"Stage 2 {stage2.label(b['shard'], b['batch'])} local repair", log, ex, **extra)
                else:
                    raise prompts.PromptError("Stage 2 finalization은 Supervisor의 deterministic 단계입니다")
            elif b["method"] == literary.METHOD and kind in ("c_chunk_new", "c_chunk_resume"):
                prompt, baseline = self._c_chunk_prompt(b, kind, remote)
                self.store.set(literary.run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                title = f"C {b['shard']}_{b['batch']} chunk {baseline['chunk_no']:03d}"
                if kind == "c_chunk_resume":
                    h = ad.resume(sid, prompt, wt, run_env, run, log, ex, **extra)
                else:
                    h = ad.start(prompt, wt, run_env, run, title, log, ex, **extra)
            elif b["method"] == dchunk.METHOD and kind == "d_chunk_fix":
                # Correction of the unsaved active chunk: same session, same run-start baseline (not rewritten), the CLI's
                # own rejection reasons for exactly this chunk, and the decision file it left in place.
                problem = self._stage2_chunk_boundary_problem(b, dchunk.run_start_key(b["id"]))
                if problem:
                    return self._fail(b, "ERROR", problem)
                rec = dchunk.read_active(Path(wt), b)
                diag = dchunk.read_rejection(Path(wt), b, rec) if rec else None
                if not sid or diag is None:
                    raise prompts.PromptError("수정 요청에 기존 세션과 활성 청크에 결속된 저장 거부 진단이 필요합니다")
                prompt = prompts.d_chunk_fix(b, rec["chunk_no"], dchunk.fix_problem(diag))
                h = ad.resume(sid, prompt, wt, run_env, run, log, ex, **extra)
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
                checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"]) if b["method"] == STAGE2_METHOD else None
                h = ad.resume(sid, prompts.recovery(b, resolved_defects=self.maint.resolved_note(b), checkpoint=checkpoint), wt, run_env, run, log, ex, **extra)
            elif kind == "produce_recover":
                checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"]) if b["method"] == STAGE2_METHOD else None
                h = ad.start(prompts.recovery(b, resolved_defects=self.maint.resolved_note(b), checkpoint=checkpoint), wt, run_env, run,
                                       f"{b['method'].upper()} {b['shard']}_{b['batch']} recover", log, ex, **extra)
            elif kind == "fix_resume":
                checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"]) if b["method"] == STAGE2_METHOD else None
                if b["method"] == STAGE2_METHOD and checkpoint is None:
                    raise prompts.PromptError("Stage 2 리뷰 수정 재개에 현재 Part checkpoint가 없습니다")
                source_context = ""
                if b["method"] in ("a", "b", "c", "d"):
                    source_context, fix_context_digests = self._producer_fix_context(b, events, session_id=sid)
                h = ad.resume(sid, prompts.fix(b, events, True, source_context=source_context,
                                               checkpoint=checkpoint), wt, run_env, run, log, ex, **extra)
            else:  # fix_new
                context = ""
                checkpoint = None
                if b["method"] in ("a", "b", "c", "d"):
                    context, fix_context_digests = self._producer_fix_context(b, events)
                elif b["method"] == STAGE2_METHOD:
                    context = self._s2_fix_context(b, events)
                    checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
                    if checkpoint is None:
                        raise prompts.PromptError("Stage 2 리뷰 수정에 현재 Part checkpoint가 없습니다")
                    cp_path = Path(wt) / ".warroom-scratch" / f"relation-admission-{b['shard']}-{b['batch'].split('-')[0]}-{b['batch'].split('-')[1]}.json"
                    baseline = {"branch": b["branch"], "worktree": str(wt), "head": self.git.head(wt),
                                "checkpoint_sha256": hashlib.sha256(cp_path.read_bytes()).hexdigest(),
                                "amend_revision": checkpoint.get("amend_revision", 0)}
                    self.store.set(f"s2_fix_start_{b['id']}", json.dumps(baseline, sort_keys=True))
                h = ad.start(prompts.fix(b, events, False, source_context=context, checkpoint=checkpoint), wt, run_env, run,
                                       f"PR {b['pr_number']} fix", log, ex, **extra)
        except prompts.PromptError as e:   # rendered before any process is started
            return self._fail(b, "ERROR", f"프롬프트 오류로 AI를 시작하지 않았습니다: {e}")
        except TRANSIENT:
            raise
        except Exception as e:
            return self._fail(b, "ERROR", f"AI 실행 시작 실패: {e}")
        self.store.set(f"headlag_{b['id']}", "")   # a new run supersedes any earlier push verification
        if b["method"] == STAGE2_METHOD:
            self.store.delete(f"s2_safe_ff_{b['id']}")
        self._clear_batch_retry(b["id"])
        state = "FIXING" if kind.startswith("fix") else "PRODUCING"
        fields = dict(state=state, pid=h.pid, exit_file=str(ex), log_file=str(log),
                      run_kind=kind, retry_after=None, error=None)
        if kind == "fix_new" or kind in ("produce", "produce_recover", "s2_chunk_new", "s2_links_new", "s2_repair_new", "s2_finalize_new", "s3_chunk_new", "c_chunk_new",
                                         "d_chunk_new", "ab_chunk_new"):
            fields["session_id"] = None  # captured from the new run's log
        self.store.update(b["id"], **fields)
        run_id = self.store.add_run(b["id"], kind, fields.get("session_id", sid), h.pid, log, ex,
                                    model=run.model, effort=run.effort, permission_profile=run.permission_profile)
        if events:
            keys = [e["key"] for e in events]
            if b["method"] in ("a", "b", "c", "d", STAGE3_METHOD) and kind.startswith("fix"):
                self.store.claim_events(b["id"], b["pr_number"], b["head_sha"], keys, run_id)
                self.store.set(f"fix_claim_{b['id']}", json.dumps({
                    "pr": b["pr_number"], "head_sha": b["head_sha"], "event_keys": keys,
                    "run_id": run_id, "status": "CLAIMED",
                }, sort_keys=True))
                if fix_context_digests:
                    self.store.set(f"fix_context_pending_{b['id']}", json.dumps({
                        "run_id": run_id, "digests": fix_context_digests,
                    }, sort_keys=True))
                else:
                    self.store.delete(f"fix_context_pending_{b['id']}")
            else:  # Stage 2 retains its existing event lifecycle; its behavior is outside #2322.
                self.store.mark_handled(b["id"], b["pr_number"], b["head_sha"], keys)
        tier = f", tier={b['model_tier']}" if self._tiered(b["producer"]) else ""
        permission = (f", permission_profile={run.permission_profile or '(기본)'}"
                      if registry(self.cfg)[b["producer"]]["adapter"] == "codex" else "")
        self.store.log(b["id"], f"{state} 시작 ({kind}, model={run.model}, effort={run.effort}{permission}{tier})")

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
        if b["method"] == STAGE3_METHOD and not b["pr_number"]:
            if b["run_kind"] == "s3_finalize":
                self.maint.adopt_released_baseline(b)
                return self._stage3_finalize(b)
            if isinstance(b["run_kind"], str) and b["run_kind"].startswith("s3_chunk_"):
                self.maint.adopt_released_baseline(b)
                return self._relaunch_stage3_chunk(b)
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
        if b["method"] == STAGE2_METHOD and not b["pr_number"] and b["run_kind"] in ("s2_links_new", "s2_links_fix"):
            if checkpoint := stage2.checkpoint(b["worktree"], b["shard"], b["batch"]):
                if checkpoint.get("optional_review_complete"):
                    self.store.delete(stage2.links_start_key(b["id"]))
                    return self._launch_stage2_next(b)
            problem = self._stage2_links_boundary_problem(b)
            if problem:
                return self._fail(b, "ERROR", problem)
            try:
                if self._find_recovery_pr(b) is not None:
                    return self._fail(b, "ERROR", "optional-link 재개 전에 예상하지 않은 PR이 있어 중단합니다. 보존합니다.")
            except TRANSIENT:
                raise
            except Exception as e:
                return self._fail(b, "ERROR", f"optional-link 재개 전 PR 소유권 확인 실패: {e}. 보존합니다.")
            fixes = stage2.fixes_used(self.store.runs(b["id"]), "s2_links_new", ("s2_links_fix",))
            if not b["session_id"] or fixes >= stage2.MAX_FIXES:
                self.store.update(b["id"], session_id=None)
                self.store.delete(stage2.links_start_key(b["id"]))
                return self._launch_stage2_next(self.store.batch(b["id"]))
            self._s2_links_problem[b["id"]] = "이전 optional-link 실행이 중단되었습니다. 같은 세션의 기존 판단을 보존하고 전체 응답을 다시 제출하세요."
            return self._launch(b, "s2_links_fix")
        if self._s2_repair_run(b) and not b["pr_number"]:
            try:
                state = self._stage2_repair_state(b, required=True)
                current = state.get("current")
                if not isinstance(current, dict):
                    return self._fail(b, "ERROR", "Stage 2 repair Retry has no active round; preserving evidence")
                if current.get("pending_answer") is not None:
                    return self._apply_stage2_repair_answer(b, state)
                if problem := self._stage2_repair_boundary_problem(b):
                    return self._fail(b, "ERROR", problem)
                return self._launch_stage2_repair_page(b)
            except TRANSIENT:
                raise
            except Exception as error:
                return self._fail(b, "ERROR", f"Stage 2 repair Retry is unsafe: {error}. Worktree is preserved.")
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
            file_state = stage2.decision_file_state(b["worktree"], pending) if pending is not None else "missing"
            if file_state == "corrupt":
                return self._fail(b, "ERROR", f"현재 청크 판정 파일이 손상되었거나 다른 청크에 속해 있습니다. "
                                  f"파일과 checkpoint를 보존합니다: {stage2.DECISIONS}")
            if file_state == "current":
                if not b["session_id"]:
                    return self._fail(b, "ERROR", f"현재 청크 판정 파일은 보존했지만 연결된 세션이 없습니다. "
                                      f"새 전체 재판정은 하지 않습니다: {stage2.DECISIONS}")
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
                isinstance(b["run_kind"], str) and (b["run_kind"].startswith("s2_finalize_") or
                                                     b["run_kind"] == "s2_deterministic_finalize"):
            try:
                info = self._find_recovery_pr(b)
            except TRANSIENT:
                raise
            except Exception as e:
                return self._fail(b, "ERROR", f"최종화 Retry 전 기존 PR 소유권 확인 실패: {e}. worktree를 보존합니다.")
            if info is not None:
                return self._handoff_recovered_pr(b, info, "운영자 Retry 직전")
            return self._stage2_finalize(b)
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
                    if b["method"] == STAGE2_METHOD:
                        if problem := self._stage2_fix_result_problem(b, info):
                            return self._fail(b, "ERROR", problem)
                        self.store.delete(f"s2_fix_start_{b['id']}")
                    elif b["method"] == STAGE3_METHOD:
                        if problem := self._stage3_fix_completion_problem(b, info):
                            return self._fail(b, "ERROR", problem)
                    self._to_review(b, info)
                return
            if b["method"] in ("a", "b", "c", "d", STAGE3_METHOD):
                return self._retry_producer_fix(b)
            return self._launch(b, self._fix_kind(b), self._events(b)[1])
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
        policy_chunk = self._ab_policy_skip_chunk(b)
        policy_refusal = (ad.confirmed_prompt_refusal(Path(b["log_file"])) if policy_chunk is not None else None)
        tolerant = {"tolerate_denied": True} if (self._ab_chunk_run(b) or self._s2_chunk_run(b)) \
            and getattr(ad, "supports_tolerate_denied", False) else {}
        problem = ad.run_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"], **tolerant)
        if problem and not policy_refusal:   # the CLI contradicts its pins: stop it, keep worktree/PR, wait for the operator
            state, msg = problem
            if ad.alive(b["pid"]):
                ad.stop(b["pid"])
            return self._fail(b, state, msg)
        if ad.alive(b["pid"]):
            if b["state"] == "PRODUCING" and not (b["method"] == STAGE3_METHOD and
                    str(b["run_kind"] or "").startswith("s3_chunk_")) and not self._c_chunk_run(b) and not self._d_chunk_run(b) \
                    and not self._ab_chunk_run(b):
                self._adopt_pr_while_running(b)
            return
        code = ad.exit_code(Path(b["exit_file"]))
        self.store.update(b["id"], pid=None)
        self.store.finish_runs(b["id"], code)
        b = self.store.batch(b["id"])
        if policy_refusal:
            return self._handle_ab_policy_refusal(b, policy_chunk)
        if code is None:
            saved_chunk = self._saved_chunk_for_run(b)
            stage3_answer_only = self._stage3_answer_only(b)
            if saved_chunk or stage3_answer_only:
                if self._saved_output_failure(b, self._classify_run(b["producer"], b["log_file"])):
                    return
                ad = self._adapter(b["producer"])
                if problem := self._saved_chunk_identity_problem(b):
                    return self._fail(b, problem[0], f"종료 기록은 없지만 청크 응답 실행 소유권/핀을 확인하지 못했습니다: {problem[1]}")
                problem = ad.completion_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"],
                                                b["worktree"], self.env)
                if problem and not ad.completion_incomplete(Path(b["log_file"]), self._recorded_run(b),
                                                            b["session_id"], b["worktree"], self.env):
                    return self._fail(b, "ERROR", f"종료 상태 기록이 없고 실행 증거도 불완전합니다: {problem[1]}. 청크 응답과 worktree를 보존합니다.")
                if not self._denials_cleared(b, Path(b["log_file"])):
                    return
                if saved_chunk:
                    self.store.log(b["id"], "AI 종료 상태 기록은 없지만 현재 청크의 정확한 저장 증거와 실행 핀을 확인했습니다. 저장물을 다시 만들지 않고 진행합니다.", "warn")
                else:
                    self.store.log(b["id"], "AI 종료 상태 기록은 없지만 현재 Stage 3 청크의 완전한 D/L 응답과 실행 핀을 확인했습니다. 같은 strict save 경로로 저장합니다.", "warn")
                return self._run_ok(b)
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
        saved = self._saved_chunk_for_run(b)
        answer_only = ((self._ab_chunk_run(b) and self._ab_chunk_response(b))
                       or self._stage3_answer_only(b))
        if saved or answer_only:
            if problem := self._saved_chunk_identity_problem(b):
                return self._fail(b, problem[0], f"저장 청크 실행의 소유권/핀 확인 실패: {problem[1]}")
        problem = ad.completion_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"],
                                        b["worktree"], self.env)
        if problem:
            if not (saved or answer_only) or not ad.completion_incomplete(
                    Path(b["log_file"]), self._recorded_run(b), b["session_id"], b["worktree"], self.env):
                return self._fail(b, problem[0], problem[1])
            if self._saved_output_failure(b, self._classify_run(b["producer"], b["log_file"])):
                return
            self.store.log(b["id"], "CLI의 최종 완료 로그는 없지만 현재 청크의 정확한 저장과 실행 핀을 확인했습니다. 저장물을 다시 만들지 않습니다.", "warn")
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
        if denied is None:
            if (self._ab_chunk_run(b) or ((self._s2_chunk_run(b) or self._s2_links_run(b) or self._s2_repair_run(b))
                                          and b["state"] == "PRODUCING")
                    or (self._stage3_chunk_run(b) and b["state"] == "PRODUCING"
                        and (self._stage3_chunk_saved(b) or self._stage3_answer_only(b)))):
                self.store.log(b["id"], "answer-only 청크 권한 결과가 없어도 출력·저장 및 부작용 경계로 판정합니다.", "warn")
                return True
            self._fail(b, "PAUSED", "CLI 최종 result가 없어 권한 거부 여부를 확인할 수 없습니다. 저장물과 실행 기록을 보존하고 중지합니다.")
            return False
        if not denied:
            return True
        if (self._ab_chunk_run(b) or ((self._s2_chunk_run(b) or self._s2_links_run(b) or self._s2_repair_run(b))
                                      and b["state"] == "PRODUCING")
                or (self._stage3_chunk_run(b) and b["state"] == "PRODUCING"
                    and (self._stage3_chunk_saved(b) or self._stage3_answer_only(b)))):
            # Answer-only: a refused tool call is a metric, not a failure. The answer is judged by its block and its save,
            # and any real side effect (dirty tracked tree, moved HEAD/remote) by `_run_ok_ab_chunk`.
            if self._stage3_chunk_run(b):
                problem = self._stage3_chunk_boundary_problem(b)
                if problem:
                    self._fail(b, "ERROR", problem)
                    return False
                self.store.log(b["id"], f"Stage 3 answer-only 청크에서 도구 호출 {len(denied)}건이 거부됐습니다 "
                               "(정확한 view/checkpoint 경계와 출력 검증으로 판정합니다)", "warn")
                return True
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
        if b["method"] == STAGE3_METHOD:
            try:
                done, total = stage3.progress(stage3.checkpoint(b["worktree"], b["shard"]))
            except (OSError, ValueError, KeyError, TypeError, stage3.Stage3Error):
                return
            fields = {"records_done": None, "progress_kind": "chunks" if total else None,
                      "progress_done": done if total else None, "progress_total": total if total else None}
            changed = {key: value for key, value in fields.items() if value != b[key]}
            if changed:
                self.store.update(b["id"], **changed)
            return
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
        if b["method"] == STAGE3_METHOD and b["state"] == "PRODUCING" and \
                isinstance(b["run_kind"], str) and b["run_kind"].startswith("s3_chunk_"):
            return self._run_ok_stage3_chunk(b)
        if b["method"] == STAGE2_METHOD and b["state"] == "PRODUCING" and b["run_kind"] in ("s2_links_new", "s2_links_fix"):
            return self._run_ok_stage2_links(b)
        if self._s2_repair_run(b) and b["state"] == "PRODUCING":
            return self._run_ok_stage2_repair(b)
        if b["state"] == "FIXING" and b["method"] in ("a", "b", "c", "d"):
            self._remember_fix_context_delivery(b)
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
                return self._fail(b, "PAUSED" if denied is None or denied else "ERROR", problem)
        if b["state"] == "FIXING":
            if self._check_fix_head(b, info) != "ok":
                return
            if b["method"] in ("a", "b", "c", "d"):
                if info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]:
                    return self._fail(b, "ERROR", "리뷰 수정 완료 PR의 번호 또는 소유 브랜치가 다릅니다. worktree·PR을 보존합니다.")
                if info.get("state") != "open" or info.get("merged"):
                    return self._fail(b, "ERROR", "리뷰 수정 완료 시 소유 PR이 열린 상태가 아닙니다. worktree·PR을 보존합니다.")
                if problem := self._complete_producer_fix_events(b):
                    return self._fail(b, "ERROR", problem)
            if b["method"] == STAGE2_METHOD:
                if problem := self._stage2_fix_result_problem(b, info):
                    return self._fail(b, "ERROR", problem)
                self.store.delete(f"s2_fix_start_{b['id']}")
            elif b["method"] == STAGE3_METHOD:
                if problem := self._stage3_fix_completion_problem(b, info):
                    return self._fail(b, "ERROR", problem)
            elif info["head_sha"] == b["head_sha"]:
                self.store.log(b["id"], "수정 실행이 끝났지만 새 HEAD 없음 (코멘트로만 응답했을 수 있음)", "warn")
        self._to_review(b, info)

    def _stage3_fix_result_problem(self, b, info) -> str | None:
        """Accept a Stage 3 review fix only when its owned PR still has the shard scope and verify passes on its HEAD."""
        if (info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]
                or info.get("state") != "open" or info.get("merged")):
            return "Stage 3 리뷰 수정이 열린 소유 PR 번호/head 브랜치에서 끝나지 않았습니다. worktree와 PR을 보존합니다."
        head = info.get("head_sha")
        if not isinstance(head, str) or not re.fullmatch(r"[a-f0-9]{40}", head):
            return "Stage 3 리뷰 수정 PR HEAD가 유효한 commit SHA가 아닙니다. PR을 보존합니다."
        try:
            files = self.gh.pull_files(b["pr_number"])
            shard = stage3.validate_pr(info, files)
        except TRANSIENT:
            raise
        except Exception as error:
            return f"Stage 3 리뷰 수정 PR 파일 범위를 검증할 수 없습니다: {error}. PR을 보존합니다."
        if shard != b["shard"]:
            return f"Stage 3 리뷰 수정 PR 샤드 {shard}가 소유 샤드 {b['shard']}와 다릅니다. PR을 보존합니다."
        try:
            ok, detail = self.git.verify_stage2(head, "shard", b["shard"], None, None)
        except TRANSIENT:
            raise
        except Exception as error:
            return f"Stage 3 리뷰 수정 HEAD 검증을 실행할 수 없습니다: {error}. PR을 보존합니다."
        if not ok:
            return f"Stage 3 리뷰 수정 HEAD의 shard verify 실패: {detail}. PR을 보존합니다."
        return None

    def _stage3_fix_completion_problem(self, b, info) -> str | None:
        """Share the same PR scope, exact-HEAD verify and event-reply gate across every fix completion route."""
        if problem := self._stage3_fix_result_problem(b, info):
            return problem
        return self._complete_producer_fix_events(b)

    def _stage2_final_pr_problem(self, b, info) -> str | None:
        """Require local checkpoint verification and an independent exact PR-HEAD verification."""
        try:
            reconcile_task = self._stage2_reconcile_task(b)
            if reconcile_task:
                base_revision, _change_point, _commits = reconcile_task
                if info.get("head_ref") != b["branch"]:
                    return "Stage 2 reconciliation PR head branch does not match its owned branch"
                wt = Path(b["worktree"])
                if self.git.dirty(wt).strip():
                    return "Stage 2 reconciliation PR worktree has uncommitted changes"
                head = self.git.head(wt)
                if not head or head != info.get("head_sha"):
                    return f"Stage 2 reconciliation PR HEAD differs from its owned worktree ({info.get('head_sha')} / {head})"
                if self.git.remote_head(b["branch"]) != head:
                    return "Stage 2 reconciliation PR HEAD is not on its remote owned branch"
                allowed = {f"data/relation-drops/drop-{b['shard']}.jsonl"}
                files = {row.get("path") for row in self.gh.pull_files(info["number"])}
                if files != allowed or set(self.git.changed_files(head)) != allowed:
                    return f"Stage 2 reconciliation PR must change only its shard Drop file (found {sorted(files)})"
                if not self.git.is_ancestor(base_revision, head, path=wt):
                    return "Stage 2 reconciliation PR does not contain its recorded base revision"
                bb, pp = stage2.split_key(b["batch"])
                ok, tail = self.git.verify_stage2_local(wt, b["shard"], bb, pp, checkpoint=False)
                if not ok:
                    return f"{stage2.label(b['shard'], b['batch'])} reconciliation verify failed: {tail}"
                ok, tail = self.git.verify_stage2_exact(head, b["shard"], bb, pp)
                if not ok:
                    return f"{stage2.label(b['shard'], b['batch'])} exact reconciliation PR HEAD verify failed: {tail}"
                return None
            checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
            if checkpoint is None or not checkpoint["complete"] or checkpoint["pending_chunk"] is not None or \
                    checkpoint["decided"] != checkpoint["total"] or not checkpoint["merged"] or \
                    not checkpoint.get("optional_review_complete") or \
                    not isinstance(checkpoint.get("premerge"), dict) or checkpoint["premerge"].get("status") != "ready":
                return "Stage 2 PR 거부: primary/optional checkpoint 완료와 신뢰된 premerge snapshot이 필요합니다"
            if info.get("head_ref") != b["branch"]:
                return "Stage 2 PR의 head 브랜치가 이 Part의 소유 브랜치와 다릅니다"
            wt = Path(b["worktree"])
            if self.git.dirty(wt).strip():
                return "Stage 2 PR 거부: worktree에 미커밋 변경이 있습니다"
            head = self.git.head(wt)
            if not head or head != info.get("head_sha"):
                return f"Stage 2 PR HEAD와 소유 worktree HEAD가 다릅니다 ({info.get('head_sha')} / {head})"
            remote = self.git.remote_head(b["branch"])
            if remote != head:
                return f"Stage 2 PR HEAD가 원격 소유 브랜치에 없습니다 ({remote} / {head})"
            batch, part = stage2.split_key(b["batch"])
            ok, tail = self.git.verify_stage2_local(wt, b["shard"], batch, part, checkpoint=True)
            if not ok:
                return f"{stage2.label(b['shard'], b['batch'])} 로컬 checkpoint verify 실패: {tail}"
            ok, tail = self.git.verify_stage2_exact(head, b["shard"], batch, part)
            if not ok:
                return f"{stage2.label(b['shard'], b['batch'])} PR 정확한 HEAD의 별도 checkout verify 실패: {tail}"
        except TRANSIENT:
            raise
        except Exception as e:
            return f"Stage 2 PR 검증 실패: {e}"
        return None

    def _stage2_fix_result_problem(self, b, info) -> str | None:
        """A changed review HEAD needs CLI amend evidence; a no-change rebuttal keeps the exact old checkpoint/head."""
        raw = self.store.get(f"s2_fix_start_{b['id']}")
        if raw is None:
            return "Stage 2 리뷰 수정 기준이 없어 결과를 수락하지 않습니다. worktree와 PR을 보존합니다."
        try:
            baseline = json.loads(raw)
            if baseline.get("branch") != b["branch"] or baseline.get("worktree") != str(b["worktree"]) or \
                    not re.fullmatch(r"[a-f0-9]{64}", baseline.get("checkpoint_sha256", "")):
                return "Stage 2 리뷰 수정 기준이 손상되거나 다른 worktree를 가리킵니다"
            wt = Path(b["worktree"])
            bb, pp = stage2.split_key(b["batch"])
            cp_path = wt / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.json"
            cp_sha = hashlib.sha256(cp_path.read_bytes()).hexdigest()
            checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
            if checkpoint is None:
                return "Stage 2 리뷰 수정 뒤 checkpoint를 읽을 수 없습니다"
            if info.get("head_ref") != b["branch"] or self.git.head(wt) != info.get("head_sha") or \
                    self.git.remote_head(b["branch"]) != info.get("head_sha") or self.git.dirty(wt).strip():
                return "Stage 2 리뷰 수정 결과의 branch/로컬·원격 HEAD/clean 상태가 일치하지 않습니다"
            try:
                safe_ff = json.loads(self.store.get(f"s2_safe_ff_{b['id']}") or "")
            except (TypeError, ValueError):
                safe_ff = {}
            safe_ff_no_change = (isinstance(safe_ff, dict) and safe_ff.get("branch") == b["branch"] and
                                 safe_ff.get("worktree") == str(wt) and safe_ff.get("from") == baseline.get("head") and
                                 safe_ff.get("to") == info.get("head_sha"))
            if info.get("head_sha") == baseline.get("head"):
                if cp_sha != baseline["checkpoint_sha256"] or checkpoint.get("amend_revision", 0) != baseline.get("amend_revision", 0):
                    return "HEAD 변경 없는 Stage 2 반론에서 checkpoint가 달라졌습니다"
            elif safe_ff_no_change:
                if cp_sha != baseline["checkpoint_sha256"] or checkpoint.get("amend_revision", 0) != baseline.get("amend_revision", 0):
                    return "안전 fast-forward 중 Stage 2 checkpoint가 변경되었습니다"
            else:
                if checkpoint.get("amend_revision", 0) <= baseline.get("amend_revision", 0):
                    return "Stage 2 PR HEAD가 바뀌었지만 공식 amend revision이 증가하지 않았습니다. 직접 파일 변경은 수락하지 않습니다"
                journal = cp_path.with_name(cp_path.stem + ".amend-state.json")
                if not journal.is_file():
                    return "Stage 2 amend recovery evidence가 없어 리뷰 수정 HEAD를 수락하지 않습니다"
            return self._stage2_final_pr_problem(b, info)
        except TRANSIENT:
            raise
        except Exception as e:
            return f"Stage 2 리뷰 수정 결과 검증 실패: {e}"

    def _stage2_finalize(self, b) -> None:
        self._guarded(b, "finalize", self._stage2_finalize_do)

    def _stage2_repair_state(self, b, *, required: bool = False) -> dict | None:
        raw = self.store.get(stage2.repair_state_key(b["id"]))
        if raw is None:
            if required:
                raise ValueError("Stage 2 repair state is missing")
            return None
        try:
            state = json.loads(raw)
        except (TypeError, ValueError) as error:
            raise ValueError(f"Stage 2 repair state is malformed: {error}") from error
        identity = state.get("identity") if isinstance(state, dict) else None
        if not isinstance(identity, dict) or identity.get("branch") != b["branch"] \
                or identity.get("worktree") != str(b["worktree"]) or state.get("version") != 1 \
                or not isinstance(state.get("history"), list):
            raise ValueError("Stage 2 repair state does not match the owned Part")
        return state

    def _save_stage2_repair_state(self, b, state: dict) -> None:
        self.store.set(stage2.repair_state_key(b["id"]), json.dumps(state, ensure_ascii=False, sort_keys=True))

    def _stage2_repair_boundary_problem(self, b) -> str | None:
        raw = self.store.get(stage2.repair_run_start_key(b["id"]))
        if raw is None:
            return "Stage 2 repair has no persisted run boundary; preserving the worktree"
        try:
            baseline = json.loads(raw)
            if not isinstance(baseline, dict) or baseline.get("branch") != b["branch"] \
                    or baseline.get("worktree") != str(b["worktree"]) \
                    or not re.fullmatch(r"[a-f0-9]{64}", baseline.get("checkpoint_sha256", "")):
                return "Stage 2 repair run boundary is malformed or belongs to another Part"
            wt = Path(b["worktree"])
            bb, pp = stage2.split_key(b["batch"])
            checkpoint = wt / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.json"
            if self.git.registered(wt) != b["branch"]:
                return "Stage 2 repair worktree is no longer registered to its owned branch"
            current_sha = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
            if current_sha != baseline["checkpoint_sha256"]:
                state = self._stage2_repair_state(b, required=True)
                current = state.get("current", {})
                intent = current.get("apply_intent") if isinstance(current, dict) else None
                receipts = json.loads(checkpoint.read_text("utf-8")).get("repair_receipts", [])
                intent_keys = intent.get("candidate_keys") if isinstance(intent, dict) else None
                nonce = intent.get("supervisor_nonce") if isinstance(intent, dict) else None
                replay_proven = current.get("pending_answer") is not None \
                    and isinstance(intent_keys, list) and all(isinstance(key, str) for key in intent_keys) \
                    and re.fullmatch(r"[a-f0-9]{64}", nonce or "") \
                    and intent.get("fingerprint") == baseline.get("fingerprint") \
                    and any(receipt.get("supervisor_nonce") == nonce
                            and receipt.get("fingerprint") == baseline.get("fingerprint")
                            and receipt.get("candidate_keys") == intent_keys for receipt in receipts
                            if isinstance(receipt, dict))
                if not replay_proven:
                    return "Stage 2 repair run changed the checkpoint without its persisted Supervisor apply intent; preserving it"
            if self.git.dirty(wt).strip():
                return "Stage 2 repair AI changed tracked worktree files; preserving the worktree"
            if self.git.head(wt) != baseline.get("head") or self.git.remote_head(b["branch"]) != baseline.get("remote_head"):
                return "Stage 2 repair AI changed the owned HEAD or remote branch; preserving the worktree"
            state = self._stage2_repair_state(b, required=True)
            current = state.get("current")
            if not isinstance(current, dict) or current.get("fingerprint") != baseline.get("fingerprint") \
                    or current.get("cursor") != baseline.get("cursor"):
                return "Stage 2 repair round or target page changed while AI was running"
        except TRANSIENT:
            raise
        except Exception as error:
            return f"Stage 2 repair boundary check failed: {error}"
        return None

    def _launch_stage2_repair_page(self, b) -> None:
        try:
            state = self._stage2_repair_state(b, required=True)
            current = state.get("current")
            groups = current.get("groups") if isinstance(current, dict) else None
            cursor = current.get("cursor") if isinstance(current, dict) else None
            if not isinstance(groups, list) or type(cursor) is not int or cursor < 0 or cursor >= len(groups):
                return self._fail(b, "ERROR", "Stage 2 repair page cursor is invalid; preserving all evidence")
            if current.get("pending_answer") is not None:
                return self._apply_stage2_repair_answer(b, state)
            if current.get("attempts", 0) >= stage2.REPAIR_ATTEMPTS_PER_PAGE:
                return self._fail(b, "ERROR", "Stage 2 repair response retry limit reached; saved checkpoint and round evidence are preserved")
            page = groups[cursor:cursor + stage2.REPAIR_GROUPS_PER_RUN]
            page_keys = sorted({key for group in page for key in group.get("candidate_keys", [])})
            if not page_keys:
                return self._fail(b, "ERROR", "Stage 2 repair page has no target candidates")
            current["attempts"] = current.get("attempts", 0) + 1
            current["page_keys"] = page_keys
            current.setdefault("attempt_log", []).append({"cursor": cursor, "attempt": current["attempts"],
                "fingerprint": current["fingerprint"], "target_keys": page_keys, "status": "launched"})
            self._save_stage2_repair_state(b, state)
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._fail(b, "ERROR", f"Stage 2 repair is pre-PR only; unexpected PR #{info['number']} found")
            wt = Path(b["worktree"])
            if self.git.registered(wt) != b["branch"]:
                return self._fail(b, "ERROR", "Stage 2 repair worktree is no longer registered to its owned branch")
            self.git.worktree_gitdir(wt)
            bb, pp = stage2.split_key(b["batch"])
            cp = wt / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.json"
            remote = self.git.remote_head(b["branch"])
            baseline = {"branch": b["branch"], "worktree": str(wt), "head": self.git.head(wt),
                        "remote_head": remote, "checkpoint_sha256": hashlib.sha256(cp.read_bytes()).hexdigest(),
                        "fingerprint": current["fingerprint"], "cursor": cursor, "page_keys": page_keys}
            self.store.set(stage2.repair_run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
            return self._launch(self.store.batch(b["id"]), "s2_repair_new")
        except TRANSIENT:
            raise
        except (OSError, ValueError, KeyError, TypeError, GitError) as error:
            return self._fail(b, "ERROR", f"Stage 2 repair page 준비 실패: {error}. worktree와 checkpoint를 보존합니다.")

    def _stage2_repair_response(self, b, state: dict) -> dict | None:
        current = state["current"]
        if current.get("pending_answer") is not None:
            return current["pending_answer"]
        final = self._adapter(b["producer"]).final_answer(Path(b["log_file"]))
        current["last_response"] = final
        self._save_stage2_repair_state(b, state)
        try:
            answer = stage2.extract_repair_answer(final, current["fingerprint"])
        except ValueError as error:
            current["last_error"] = str(error)
            self._save_stage2_repair_state(b, state)
            raise
        if answer is None:
            current["last_error"] = "repair response is missing the exact fingerprint header"
            if current.get("attempt_log"):
                current["attempt_log"][-1]["status"] = "rejected"
            self._save_stage2_repair_state(b, state)
            return None
        page = current["groups"][current["cursor"]:current["cursor"] + stage2.REPAIR_GROUPS_PER_RUN]
        required = {}
        allowed_peers = {}
        for group in page:
            for candidate in group.get("candidates", []):
                key = (candidate["source_sense_id"], candidate["candidate"])
                required[key] = candidate
                for peer in candidate.get("same_group_peers", []):
                    allowed_peers[(peer["source_sense_id"], peer["candidate"])] = peer
        direct_rows = answer["decisions"]
        unresolved_rows = answer["unresolved"]
        peer_rows = answer["peer_adjustments"]
        seen = set()
        for row in direct_rows:
            if not isinstance(row, dict) or not isinstance(row.get("source_sense_id"), str) or not isinstance(row.get("candidate"), str):
                raise ValueError("repair decision needs an exact source_sense_id/candidate key")
            key = (row["source_sense_id"], row["candidate"])
            if key not in required or key in seen:
                raise ValueError("repair response contains a duplicate or out-of-page candidate")
            candidate = required[key]
            if candidate["already_accounted"]:
                if set(row) != {"source_sense_id", "candidate", "additional_relations"} or not isinstance(row["additional_relations"], list):
                    raise ValueError(f"{key[0]}/{key[1]} must return a complete optional-link list")
            elif set(row) != {"source_sense_id", "candidate", "decision"} or not isinstance(row["decision"], dict):
                raise ValueError(f"{key[0]}/{key[1]} must return one complete decision")
            seen.add(key)
        for row in unresolved_rows:
            if not isinstance(row, dict) or set(row) != {"source_sense_id", "candidate", "reason"} \
                    or not isinstance(row.get("reason"), str) or not row["reason"].strip():
                raise ValueError("unresolved repair items need an exact candidate key and reason")
            key = (row["source_sense_id"], row["candidate"])
            if key not in required or key in seen:
                raise ValueError("unresolved response contains a duplicate or out-of-page candidate")
            seen.add(key)
        if seen != set(required):
            missing = sorted(set(required) - seen)
            raise ValueError(f"repair response does not cover every target candidate ({len(missing)} missing)")
        if unresolved_rows:
            current["last_error"] = "unresolved: " + "; ".join(
                f"{row['source_sense_id']}/{row['candidate']}: {row['reason']}" for row in unresolved_rows[:8])
            self._save_stage2_repair_state(b, state)
            raise ValueError(current["last_error"])
        affected_types = {}
        for row in direct_rows:
            candidate = required[(row["source_sense_id"], row["candidate"])]
            previous = candidate.get("decision") or {}
            changed = row.get("decision", {}).get("type") if isinstance(row.get("decision"), dict) else None
            if changed and previous.get("type") != changed:
                types = affected_types.setdefault(row["source_sense_id"], set())
                if previous.get("disposition") == "relation" and previous.get("type"):
                    types.add(previous["type"])
                types.add(changed)
        normalized_peers = set()
        for row in peer_rows:
            if not isinstance(row, dict) or set(row) != {"source_sense_id", "candidate", "decision"} \
                    or not isinstance(row.get("decision"), dict):
                raise ValueError("peer adjustments need an exact candidate key and complete decision")
            key = (row["source_sense_id"], row["candidate"])
            peer = allowed_peers.get(key)
            if peer is None or key in required or key in normalized_peers or row["source_sense_id"] not in affected_types \
                    or peer["decision"].get("type") not in affected_types[row["source_sense_id"]]:
                raise ValueError("peer adjustment is outside the directly affected same-source UI group")
            normalized_peers.add(key)
        answer["decisions"] = direct_rows
        answer["peer_adjustments"] = peer_rows
        current["pending_answer"] = answer
        if current.get("attempt_log"):
            current["attempt_log"][-1]["status"] = "answer_saved"
        current.pop("last_error", None)
        self._save_stage2_repair_state(b, state)
        return answer

    def _apply_stage2_repair_answer(self, b, state: dict | None = None) -> None:
        try:
            state = state or self._stage2_repair_state(b, required=True)
            current = state["current"]
            if current.get("pending_answer") is None:
                answer = self._stage2_repair_response(b, state)
                if answer is None:
                    return self._fail(b, "ERROR", "Stage 2 repair answer is missing or incomplete; preserving the run output and checkpoint")
            else:
                answer = current["pending_answer"]
            if problem := self._stage2_repair_boundary_problem(b):
                return self._fail(b, "ERROR", problem)
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._fail(b, "ERROR", f"Stage 2 repair cannot continue after PR creation; unexpected PR #{info['number']} found")
            page = current["groups"][current["cursor"]:current["cursor"] + stage2.REPAIR_GROUPS_PER_RUN]
            targets = {}
            for group in page:
                for candidate in group["candidates"]:
                    targets[(candidate["source_sense_id"], candidate["candidate"])] = candidate
            changes = []
            def add_change(key, new_decision=None, new_optional=None):
                candidate = targets.get(key)
                if candidate is None:
                    candidate = next((peer for group in page for target in group["candidates"]
                                      for peer in target.get("same_group_peers", [])
                                      if (peer["source_sense_id"], peer["candidate"]) == key), None)
                if candidate is None:
                    raise ValueError(f"repair answer target is not in the persisted preflight page: {key[0]}/{key[1]}")
                changes.append({"source_sense_id": key[0], "candidate": key[1],
                    "expected_decision": candidate["decision"],
                    "expected_additional_relations": candidate.get("additional_relations"),
                    "decision": new_decision, "additional_relations": new_optional})
            for row in answer["decisions"]:
                key = (row["source_sense_id"], row["candidate"])
                if key not in targets:
                    raise ValueError("repair decision key changed after answer validation")
                if targets[key]["already_accounted"]:
                    add_change(key, None, row["additional_relations"])
                else:
                    add_change(key, row["decision"], None)
            for row in answer["peer_adjustments"]:
                add_change((row["source_sense_id"], row["candidate"]), row["decision"], None)
            repair_input = {"version": 1, "fingerprint": current["fingerprint"],
                            "decisions": sorted(changes, key=lambda row: (row["source_sense_id"], row["candidate"]))}
            candidate_keys = sorted(f"{row['source_sense_id']}\u0000{row['candidate']}" for row in repair_input["decisions"])
            intent = current.get("apply_intent")
            if intent is None:
                intent = {"supervisor_nonce": secrets.token_hex(32), "fingerprint": current["fingerprint"],
                          "candidate_keys": candidate_keys}
                current["apply_intent"] = intent
                self._save_stage2_repair_state(b, state)
            elif not isinstance(intent, dict) or intent.get("fingerprint") != current["fingerprint"] \
                    or intent.get("candidate_keys") != candidate_keys \
                    or not re.fullmatch(r"[a-f0-9]{64}", intent.get("supervisor_nonce", "")):
                raise ValueError("persisted Supervisor apply intent does not match the pending repair answer")
            repair_input["supervisor_nonce"] = intent["supervisor_nonce"]
            receipt = self.git.stage2_repair(Path(b["worktree"]), b["shard"], *stage2.split_key(b["batch"]), repair_input)
            if receipt.get("ok") is not True or not re.fullmatch(r"[a-f0-9]{64}", receipt.get("request_id", "")) \
                    or receipt.get("supervisor_nonce") != intent["supervisor_nonce"] \
                    or receipt.get("candidate_keys") != candidate_keys:
                return self._fail(b, "ERROR", "official repair CLI returned no valid idempotent receipt; preserving state")
            target_keys = [f"{row['source_sense_id']}\u0000{row['candidate']}" for row in repair_input["decisions"]]
            current.setdefault("applied_candidate_keys", []).extend(target_keys)
            current["cursor"] += len(page)
            current["attempts"] = 0
            current["last_receipt"] = receipt["request_id"]
            current["pending_answer"] = None
            current.pop("apply_intent", None)
            current.pop("last_response", None)
            if state.get("history"):
                state["history"][-1]["applied_candidate_keys"] = list(current["applied_candidate_keys"])
            if current.get("attempt_log"):
                current["attempt_log"][-1]["status"] = "applied"
                current["attempt_log"][-1]["receipt"] = receipt["request_id"]
            self._save_stage2_repair_state(b, state)
            self.store.log(b["id"], f"Stage 2 국소 재판정 {len(target_keys)}건을 공식 admission-cli로 저장했습니다 (round {state['rounds_used']}/{stage2.MAX_REPAIR_ROUNDS})")
            self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None,
                              state="PRODUCING", run_kind="s2_deterministic_finalize", pid=None)
            return self._stage2_finalize(self.store.batch(b["id"]))
        except TRANSIENT:
            raise
        except (OSError, ValueError, KeyError, TypeError, GitError) as error:
            try:
                state = state or self._stage2_repair_state(b, required=True)
                state["current"]["last_error"] = str(error)[:800]
                self._save_stage2_repair_state(b, state)
            except Exception:
                pass
            return self._fail(b, "ERROR", f"Stage 2 repair 저장/재개 실패: {error}. response, checkpoint와 receipts를 보존합니다.")

    def _stage2_preflight_repair(self, b, checkpoint: dict) -> bool:
        """Run the read-only complete preflight; return True once it has launched or stopped a repair action."""
        try:
            bb, pp = stage2.split_key(b["batch"])
            report = self.git.stage2_preflight(Path(b["worktree"]), b["shard"], bb, pp)
        except TRANSIENT:
            raise
        except Exception as error:
            self._fail(b, "ERROR", f"Stage 2 read-only preflight failed: {error}. Worktree is preserved.")
            return True
        state = self._stage2_repair_state(b)
        if report.get("ok") is True:
            if state:
                state["status"] = "complete"
                state["last_success_fingerprint"] = report.get("fingerprint")
                if state.get("history"):
                    state["history"][-1]["resolved"] = True
                    state["history"][-1]["residual_fingerprint"] = report.get("fingerprint")
                self._save_stage2_repair_state(b, state)
            return False
        if report.get("repairable") is not True or not report.get("problems"):
            summary = "; ".join(report.get("unclassified", [])[:3]) or "no bounded repairable cases were returned"
            self._fail(b, "ERROR", f"Stage 2 preflight found a non-local or incomplete failure; automatic semantic repair is blocked: {summary}")
            return True
        fingerprint = report.get("fingerprint")
        if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            self._fail(b, "ERROR", "Stage 2 preflight returned an invalid conflict fingerprint")
            return True
        if state is None:
            state = {"version": 1, "identity": {"branch": b["branch"], "worktree": str(b["worktree"]),
                      "base_head": self.git.head(Path(b["worktree"])), "remote_head": self.git.remote_head(b["branch"])},
                     "rounds_used": 0, "history": [], "status": "active", "current": None}
        if state.get("identity", {}).get("base_head") != self.git.head(Path(b["worktree"])) \
                or state.get("identity", {}).get("remote_head") != self.git.remote_head(b["branch"]):
            self._fail(b, "ERROR", "Stage 2 repair owner HEAD/remote identity changed; preserving prior decisions and receipts")
            return True
        seen = {entry.get("fingerprint") for entry in state["history"] if isinstance(entry, dict)}
        if fingerprint in seen:
            self._fail(b, "ERROR", f"Stage 2 repair made no preflight progress (repeated fingerprint {fingerprint[:12]}); evidence is preserved")
            return True
        if state.get("rounds_used", 0) >= stage2.MAX_REPAIR_ROUNDS:
            self._fail(b, "ERROR", f"Stage 2 automatic repair round limit ({stage2.MAX_REPAIR_ROUNDS}) reached; checkpoint and successful earlier repairs are preserved")
            return True
        groups = report["problems"]
        target_keys = sorted({key for group in groups for key in group.get("candidate_keys", [])})
        if not target_keys:
            self._fail(b, "ERROR", "Stage 2 preflight has no repair target identity")
            return True
        if state["history"]:
            previous = state["history"][-1]
            if not previous.get("resolved") and previous.get("residual_fingerprint") is None:
                previous["residual_fingerprint"] = fingerprint
                previous["remaining_candidate_keys"] = target_keys
        state["rounds_used"] += 1
        state["current"] = {"fingerprint": fingerprint, "groups": groups, "cursor": 0, "attempts": 0,
                             "target_keys": target_keys, "pending_answer": None, "applied_candidate_keys": [],
                             "attempt_log": [], "type_tier_policy": report.get("type_tier_policy", "legacy-independent")}
        state["history"].append({"round": state["rounds_used"], "fingerprint": fingerprint,
                                 "target_keys": target_keys, "applied_candidate_keys": [], "resolved": False})
        state["status"] = "active"
        self._save_stage2_repair_state(b, state)
        self.store.log(b["id"], f"Stage 2 preflight detected {len(groups)} conflict groups / {len(target_keys)} candidates; starting fresh bounded repair round {state['rounds_used']}/{stage2.MAX_REPAIR_ROUNDS}", "warn")
        self._launch_stage2_repair_page(b)
        return True

    def _stage3_commits_between(self, base_revision: str, head: str, worktree: Path,
                                master_sha: str) -> list[str]:
        """Return only verified merged #2450 Stage 3 data PR commits between two known master points."""
        if not self.git.is_ancestor(base_revision, head, path=worktree):
            raise IntegrationBlocked("Stage 2 change-point is not an ancestor of the synchronized worktree")
        changed_paths = self.git.changed_between(base_revision, head)
        if not any(re.fullmatch(r"data/relations/relation-\d{3}\.jsonl", item) for item in changed_paths):
            return []
        if not self.git.has_deleted_id_relation_rows(base_revision, head, path=worktree):
            return []
        if self._stage3_pr_inventory_sha != master_sha:
            self._stage3_pr_inventory = self.gh.merged_relation_stage3_prs()
            self._stage3_pr_inventory_sha = master_sha
        commits = []
        seen = set()
        for pr in self._stage3_pr_inventory or []:
            sha = pr.get("merge_commit_sha")
            if pr.get("base_ref") != self.cfg["base_branch"] or not re.fullmatch(r"[a-f0-9]{40}", sha or ""):
                continue
            if not self.git.commit_in_range(base_revision, sha, head, path=worktree):
                continue
            shard = pr["shard"]
            allowed = {f"data/relations/relation-{shard}.jsonl", f"data/relation-drops/drop-{shard}.jsonl"}
            identity = (pr.get("title"), pr.get("base_ref"), shard, sha)
            cached = self._stage3_pr_files.get(pr["number"])
            if cached is None:
                pr_paths = {row.get("path") for row in self.gh.pull_files(pr["number"])}
                commit_paths = set(self.git.changed_files(sha))
                self._stage3_pr_files[pr["number"]] = (identity, pr_paths)
            else:
                cached_identity, pr_paths = cached
                if cached_identity != identity:
                    raise IntegrationBlocked(f"merged Stage 3 PR #{pr['number']} identity changed after verification")
                commit_paths = set(self.git.changed_files(sha))
            if not pr_paths or not pr_paths.issubset(allowed) or commit_paths != pr_paths:
                raise IntegrationBlocked(f"merged Stage 3 PR #{pr['number']} changed files do not match its declared shard scope")
            if sha in seen:
                raise IntegrationBlocked(f"multiple Stage 3 PR records claim merge commit {sha[:10]}")
            seen.add(sha)
            commits.append(sha)
        return sorted(commits)

    def _stage2_change_point(self, b, checkpoint, worktree: Path) -> str:
        """Durably capture pre-sync HEAD for checkpoints created before `base_revision` was recorded."""
        key = f"s2_stage3_change_point_{b['id']}"
        stored = self.store.get(key)
        checkpoint_revision = checkpoint.get("base_revision")
        if stored is not None and checkpoint_revision is not None and stored != checkpoint_revision:
            raise IntegrationBlocked("Stage 2 change point differs from its checkpoint; preserving the worktree")
        revision = stored or checkpoint_revision
        if revision is None:
            revision = self.git.head(worktree)
        if not re.fullmatch(r"[a-f0-9]{40}", revision or ""):
            raise IntegrationBlocked("Stage 2 change-point revision is invalid; preserving the worktree")
        if stored != revision:
            self.store.set(key, revision)
        return revision

    @staticmethod
    def _stage2_reconcile_task(b) -> tuple[str, str, list[str]] | None:
        """Decode a durable, deterministic reconciliation task from its run_kind."""
        value = b["run_kind"]
        if not isinstance(value, str) or not value.startswith("s2_reconcile|"):
            return None
        fields = value.split("|", 3)
        if len(fields) != 4 or not all(re.fullmatch(r"[a-f0-9]{40}", sha) for sha in fields[1:3]):
            raise ValueError("Stage 2 reconciliation task has invalid base/change-point revisions")
        commits = fields[3].split(",") if fields[3] else []
        if not commits or any(not re.fullmatch(r"[a-f0-9]{40}", sha) for sha in commits) or len(set(commits)) != len(commits):
            raise ValueError("Stage 2 reconciliation task has invalid Stage 3 commit IDs")
        return fields[1], fields[2], commits

    def _stage2_start_reconcile(self, ln, shard: str, batch: str, part: str,
                                old_sha: str, sha: str) -> str | None:
        """Preview the exact Part on latest master and enqueue a Stage2-only Drop repair if proven necessary."""
        verifier = self.git._verify_checkout(sha)
        commits = self._stage3_commits_between(old_sha, sha, verifier, sha)
        if not commits:
            return None
        preview = self.git.stage2_reconcile_latest(sha, shard, commits, batch=batch, part=part)
        if preview["added"] == 0:
            return None
        if self.git.fetch_base(self.cfg["base_branch"]) != sha:
            return "master advanced during completed-Part reconciliation preview; checking the new head next"
        model = ln["model"]
        task = f"s2_reconcile|{sha}|{old_sha}|{','.join(commits)}"
        branch = f"s2-reconcile-{model}-{shard}-{batch}-{part}-{sha[:8]}"
        wt = self.paths.worktrees / branch
        try:
            fields = dict(producer=model, shard=shard, batch=stage2.batch_key(batch, part), branch=branch,
                          worktree=str(wt), model_tier=ln["model_tier"], run_kind=task, from_run=True,
                          shard_pin=shard if ln["mode"] == "single" else "")
            bid = self.store.restart_completed_stage2_for_reconcile(**fields)
            if bid is None:
                bid = self.store.create_batch(method=STAGE2_METHOD, **fields)
        except LineNotRunnable:
            return "Stage 2 line stopped before reconciliation could be assigned"
        except LineBusy:
            return "another Stage 2 Part or reconciliation is active; waiting for its completion"
        self.store.log(bid, f"Stage 3 삭제 후 고아 Candidate {preview['added']}개를 확인해 "
                       f"{stage2.label(shard, stage2.batch_key(batch, part))} 전용 Drop 조정을 시작합니다")
        self._prepare_existing(self.store.batch(bid))
        return f"{stage2.label(shard, stage2.batch_key(batch, part))} Stage 3 고아 Candidate를 위한 Stage 2 reconcile PR 대기"

    def _stage2_reconcile_review_fix(self, b, events) -> None:
        """A reconcile PR has no Part checkpoint; preserve it for an explicit owner edit instead of launching AI."""
        if not events:
            return self._fail(b, "ERROR", "현재 HEAD에 유효한 reconcile 리뷰 수정 이벤트가 없습니다. PR과 worktree를 보존합니다.")
        keys = ", ".join(str(event.get("key", "unknown")) for event in events)
        self._fail(b, "PAUSED", "Stage 2 reconcile PR은 Part checkpoint가 없는 결정적 Drop 수정 작업입니다. "
                   "AI 수정은 시작하지 않았습니다. 오너가 리뷰 근거에 따라 기존 소유 브랜치의 "
                   "Drop 전용 변경을 명시적으로 수정하고 검증해 푸시한 뒤 Retry를 실행하세요. "
                   f"현재 리뷰 이벤트: {keys}. 기존 Stage 2 Part 판정과 reconcile 증거는 보존했습니다.")

    def _stage2_reconcile_finalize(self, b) -> None:
        """Write only proven edit Drops, verify the exact Part, and submit a separate Stage2-only PR."""
        wt = Path(b["worktree"])
        try:
            info = self._find_recovery_pr(b)
            if info is not None:
                if problem := self._stage2_final_pr_problem(b, info):
                    return self._fail(b, "ERROR", problem)
                return self._to_review(b, info)
            base_revision, change_point, _stage3_commits = self._stage2_reconcile_task(b)
            if not self.git.is_ancestor(base_revision, self.git.head(wt), path=wt):
                raise IntegrationBlocked("reconciliation branch no longer contains its verified base revision")
            latest = self.git.fetch_base(self.cfg["base_branch"])
            if not self.git.contains(wt, latest):
                self.git.integrate(wt, b["branch"], self.cfg["base_branch"], latest)
            latest = self.git.fetch_base(self.cfg["base_branch"])
            if not self.git.contains(wt, latest):
                self.git.integrate(wt, b["branch"], self.cfg["base_branch"], latest)
            latest = self.git.fetch_base(self.cfg["base_branch"])
            if not self.git.contains(wt, latest):
                raise IntegrationBlocked("latest master advanced during reconciliation; preserving the worktree")
            head = self.git.head(wt)
            stage3_commits = self._stage3_commits_between(change_point, head, wt, latest)
            if not stage3_commits:
                raise IntegrationBlocked("latest master no longer contains a verified Stage 3 relation change")
            task = f"s2_reconcile|{base_revision}|{change_point}|{','.join(stage3_commits)}"
            if task != b["run_kind"]:
                self.store.update(b["id"], run_kind=task)
                b = self.store.batch(b["id"])
            bb, pp = stage2.split_key(b["batch"])
            title = f"[Stage 2 Reconcile] {b['shard']}_{bb} Part {pp}"
            allowed = {f"data/relation-drops/drop-{b['shard']}.jsonl"}
            commit_key = f"s2_reconcile_commit_{b['id']}"
            committed = self.store.get(commit_key)
            head = self.git.head(wt)
            if committed is not None:
                if committed != head or self.git.dirty(wt).strip() or set(self.git.changed_files(head)) != allowed:
                    raise GitError("recorded reconciliation commit differs from the clean owned HEAD")
            elif self.git.commit_subject(wt) == title:
                if set(self.git.changed_files(head)) != allowed:
                    raise GitError("interrupted reconciliation commit changed unexpected paths")
                self.store.set(commit_key, head)
                committed = head
            if committed is None:
                result = self.git.stage2_reconcile(wt, b["shard"], stage3_commits, batch=bb, part=pp)
                changed = self.git.changed_paths(wt)
            else:
                result, changed = {"added": 0}, set()
            if result["added"] == 0 and not changed and committed is None:
                ok, tail = self.git.verify_stage2_local(wt, b["shard"], bb, pp, checkpoint=False)
                if not ok:
                    raise GitError(f"reconciled Part verify failed without any proven orphan Drops: {tail}")
                self.git.remove_owned(wt, b["branch"], self.git.head(wt))
                self.store.complete_batch(b["id"])
                self.store.log(b["id"], "최신 master에서 exact Part verify 통과; 고아 Candidate가 없어 PR 없이 정리 완료")
                return
            if committed is None and changed != allowed:
                raise GitError(f"reconciliation changed paths outside its Stage2-only Drop output: {sorted(changed)}")
            ok, tail = self.git.verify_stage2_local(wt, b["shard"], bb, pp, checkpoint=False)
            if not ok:
                raise GitError(f"reconciled Part verify failed: {tail}")
            if committed is None:
                head = self.git.commit_paths(wt, sorted(changed), title)
                self.store.set(commit_key, head)
            if self.git.dirty(wt).strip():
                raise GitError("worktree is not clean after the reconciliation commit")
            remote = self.git.remote_head(b["branch"])
            if remote is None:
                self.git.push_branch(wt, b["branch"])
                remote = self.git.remote_head(b["branch"])
            if remote != head:
                raise GitError(f"reconciliation branch remote HEAD differs ({remote} / {head})")
            issue = self.gh.issue(927)
            labels = [label for label in issue.get("labels", []) if label != "batch"]
            body = "\n".join([
                "- 방식: Stage 2 고아 Candidate 조정",
                f"- 샤드 / 배치 / 파트: {b['shard']} / {bb} / {pp}",
                f"- Stage 3 머지 커밋: {', '.join(stage3_commits)}",
                "- 근거: 머지된 #2450 Stage 3 PR에서 삭제된 정확한 ID Relation 행과 Part verify 통과",
                "- 변경: 사유가 edit인 Drop만 추가; 신규 후보 발굴·의미 판단 없음",
                "- 관련 이슈: #927, #2450",
            ]) + "\n"
            return self._create_pr_once(b, title, body, labels)
        except TRANSIENT:
            raise
        except (GitError, IntegrationBlocked, RecoveryBlocked, OSError, ValueError, KeyError, TypeError) as error:
            return self._fail(b, "ERROR", f"Stage 2 orphan reconciliation stopped: {error}. Worktree is preserved.")

    def _stage2_finalize_do(self, b) -> None:
        """Optional completion, snapshot merge, two validations, one commit/push and one owned PR; every step resumes from facts."""
        wt = Path(b["worktree"])
        title = f"[Stage 2] {b['shard']}_{b['batch'].split('-')[0]} Part {b['batch'].split('-')[1]}"
        self.store.update(b["id"], state="PRODUCING", pid=None, run_kind="s2_deterministic_finalize", error=None)
        try:
            info = self._find_recovery_pr(b)
            if info is not None:
                if problem := self._stage2_final_pr_problem(b, info):
                    return self._fail(b, "ERROR", problem)
                return self._to_review(b, info)
            checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
            if checkpoint is None or not checkpoint["complete"] or checkpoint["pending_chunk"] is not None or \
                    checkpoint["decided"] != checkpoint["total"] or not checkpoint.get("optional_review_complete"):
                return self._fail(b, "ERROR", "Stage 2 deterministic finalization requires complete primary and optional decisions")
            bb, pp = stage2.split_key(b["batch"])
            base_key = f"s2_finalize_base_{b['id']}"
            base = self.store.get(base_key)
            if checkpoint.get("merged") and base is None:
                return self._fail(b, "ERROR", "merged checkpoint has no deterministic finalization HEAD baseline; preserving the worktree")
            if base is not None and not re.fullmatch(r"[a-f0-9]{40}", base):
                return self._fail(b, "ERROR", "Stage 2 finalization HEAD baseline is invalid")
            if not checkpoint.get("merged"):
                try:
                    repair_state = self._stage2_repair_state(b)
                    current_repair = repair_state.get("current") if repair_state else None
                    if isinstance(current_repair, dict):
                        if current_repair.get("pending_answer") is not None:
                            return self._apply_stage2_repair_answer(b, repair_state)
                        cursor, groups = current_repair.get("cursor"), current_repair.get("groups")
                        if type(cursor) is int and isinstance(groups, list) and cursor < len(groups):
                            return self._launch_stage2_repair_page(b)
                    premerge = checkpoint.get("premerge")
                    integrated = False
                    target = self.cfg["base_branch"]
                    change_point = self._stage2_change_point(b, checkpoint, wt)
                    latest = self.git.fetch_base(target)
                    if not self.git.contains(wt, latest):
                        self.git.integrate(wt, b["branch"], target, latest)
                        integrated = True
                    latest = self.git.fetch_base(target)
                    if not self.git.contains(wt, latest):
                        self.git.integrate(wt, b["branch"], target, latest)
                        integrated = True
                    latest = self.git.fetch_base(target)
                    if not self.git.contains(wt, latest):
                        raise IntegrationBlocked("latest master advanced during Stage 2 finalization; preserving the worktree")
                    synchronized_head = self.git.head(wt)
                    stage3_commits = self._stage3_commits_between(change_point, synchronized_head, wt, latest)
                    refresh_premerge = integrated or not isinstance(premerge, dict) or \
                        premerge.get("stage3_commits") != stage3_commits
                    self.git.stage2_prepare_merge(wt, b["shard"], bb, pp, stage3_commits,
                                                  refresh=refresh_premerge)
                    base = synchronized_head
                    self.store.set(base_key, base)
                    checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
                    if checkpoint is None or not isinstance(checkpoint.get("premerge"), dict) \
                            or checkpoint["premerge"].get("status") != "ready":
                        return self._fail(b, "ERROR", "trusted premerge snapshot could not be prepared")
                    if self._stage2_preflight_repair(b, checkpoint):
                        return
                except TRANSIENT:
                    raise
                except (GitError, IntegrationBlocked, OSError, ValueError, KeyError, TypeError) as e:
                    return self._fail(b, "ERROR", f"Stage 2 preflight preparation failed: {e}. Worktree is preserved.")
            self.git.stage2_merge(wt, b["shard"], bb, pp)
            checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
            if checkpoint is None or not checkpoint.get("merged") or not checkpoint.get("optional_review_complete") or \
                    not isinstance(checkpoint.get("premerge"), dict) or checkpoint["premerge"].get("status") != "ready":
                return self._fail(b, "ERROR", "merge가 완료되지 않았거나 trusted premerge snapshot이 없습니다")
            ok, detail = self.git.verify_stage2_local(wt, b["shard"], bb, pp, checkpoint=True)
            if not ok:
                return self._fail(b, "ERROR", f"로컬 checkpoint-bearing Part verify 실패: {detail}")
            allowed = {f"data/relations/relation-{b['shard']}.jsonl", f"data/relation-drops/drop-{b['shard']}.jsonl"}
            changed = self.git.changed_paths(wt)
            unexpected = changed - allowed
            if unexpected:
                return self._fail(b, "ERROR", f"Stage 2 finalization에 허용되지 않은 변경 파일이 있습니다: {sorted(unexpected)}")
            head = self.git.head(wt)
            commit_key = f"s2_commit_head_{b['id']}"
            committed = self.store.get(commit_key)
            if committed is not None:
                if committed != head or changed:
                    return self._fail(b, "ERROR", f"기록된 Stage 2 commit HEAD와 worktree가 다릅니다 ({committed} / {head})")
            elif changed:
                head = self.git.commit_paths(wt, sorted(changed), title)
                self.store.set(commit_key, head)
                self.store.log(b["id"], f"변경된 Stage 2 출력 {', '.join(sorted(changed))}을 commit했습니다 ({head[:10]})")
            elif head == base:
                head = self.git.commit_paths(wt, [], title, allow_empty=True)
                self.store.set(commit_key, head)
                self.store.log(b["id"], "출력 파일 변경이 없는 완전한 Part를 명시적 empty commit으로 기록했습니다")
            elif self.git.commit_parent(wt) == base and self.git.commit_subject(wt) == title:
                # A crash after Git commit but before the persistent marker; accept only our exact one-commit transition.
                self.store.set(commit_key, head)
            else:
                return self._fail(b, "ERROR", f"HEAD가 finalization baseline과 달라 승인된 Stage 2 commit을 확인하지 못했습니다 ({base} / {head})")
            if self.git.dirty(wt).strip():
                return self._fail(b, "ERROR", "Stage 2 commit 뒤 worktree가 깨끗하지 않아 push를 중단합니다")
            remote = self.git.remote_head(b["branch"])
            if remote != head:
                if remote is not None and not self.git.contains(wt, remote):
                    return self._fail(b, "ERROR", f"원격 Stage 2 브랜치가 로컬 HEAD의 조상이 아닙니다 ({remote} / {head}); push하지 않습니다")
                self.git.push_branch(wt, b["branch"])
                remote = self.git.remote_head(b["branch"])
            if remote != head:
                return self._fail(b, "ERROR", f"push 뒤 원격 HEAD가 로컬 HEAD와 다릅니다 ({remote} / {head})")
            info = self._find_recovery_pr(b)
            if info is not None:
                if problem := self._stage2_final_pr_problem(b, info):
                    return self._fail(b, "ERROR", problem)
                return self._to_review(b, info)
            label = registry(self.cfg)[b["producer"]].get("label", b["producer"])
            body = "\n".join([
                "- 방식: Stage 2",
                f"- 모델: {label}",
                f"- 샤드: {b['shard']}",
                f"- 배치: {bb}",
                f"- 파트: {pp}",
                "- 관련 작업: #927 Stage 2 production",
                "- 검증: 로컬 checkpoint 포함 Part verify 및 PR 정확한 HEAD의 별도 verify",
                "- 무변경 정책: 변경 파일이 없는 완전한 Part도 명시적 empty commit과 전용 PR을 생성",
                "- 참고 기준선: Opus 보고값으로 001/01/05의 fix_resume 5회 누적 약 80M tokens, s2_finalize_resume 4회 누적 약 9.7M tokens; 원로그 대조 및 독립 재집계 전이라 검증되지 않음",
                "- 이번 실행 측정: 입력/출력/cache read/cache write tokens, finalizer·fix 실행 횟수, 시간은 미측정; 다음 정식 Part에서 기록",
            ]) + "\n"
            issue = self.gh.issue(927)
            labels = [label for label in issue.get("labels", []) if label != "batch"]
            return self._create_pr_once(b, title, body, labels)
        except TRANSIENT:
            raise
        except (GitError, DuplicateClaim, OSError, ValueError, KeyError, TypeError) as e:
            return self._fail(b, "ERROR", f"Stage 2 deterministic finalization 중단: {e}. worktree를 보존합니다.")
        except Exception as e:
            return self._fail(b, "ERROR", f"Stage 2 deterministic finalization 중단: {e}. worktree를 보존합니다.")

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
        label = {STAGE2_METHOD: "Stage 2", literary.METHOD: "C", dchunk.METHOD: "D"}.get(
            b["method"], str(b["method"]).upper())
        raw = self.store.get(key or stage2.run_start_key(b["id"]))
        if raw is None:
            return f"{label} 청크의 Git 경계 기준이 없어 Retry를 중단합니다. worktree와 브랜치를 보존합니다."
        try:
            baseline = json.loads(raw)
            if not isinstance(baseline, dict) or baseline.get("branch") != b["branch"] or \
                    baseline.get("worktree") != str(b["worktree"]) or not isinstance(baseline.get("head"), str) or \
                    "remote_head" not in baseline:
                return f"{label} 청크의 Git 경계 기준이 손상되거나 다른 실행을 가리킵니다. worktree를 보존합니다."
            head = self.git.head(Path(b["worktree"]))
            if head != baseline["head"]:
                return f"{label} 청크 실행 중 소유 HEAD가 변경됐습니다 ({baseline['head']} / {head}). 후속 실행을 중단합니다."
            remote = self.git.remote_head(b["branch"])
            if remote != baseline["remote_head"]:
                return (f"{label} 청크 실행 중 원격 브랜치 {b['branch']}가 변경됐습니다 "
                        f"({baseline['remote_head']} / {remote}). 후속 실행을 중단합니다.")
        except TRANSIENT:
            raise
        except Exception as e:
            return f"{label} 청크의 HEAD/원격 브랜치 경계를 확인하지 못했습니다: {e}. worktree를 보존합니다."
        return None

    def _stage2_links_boundary_problem(self, b) -> str | None:
        """Optional-link sessions may read, but cannot change checkpoint, tracked outputs, HEAD, or remote ref."""
        raw = self.store.get(stage2.links_start_key(b["id"]))
        if raw is None:
            return "Stage 2 optional-link Git/checkpoint 기준이 없어 실행을 중단합니다. worktree를 보존합니다."
        try:
            baseline = json.loads(raw)
            if not isinstance(baseline, dict) or baseline.get("branch") != b["branch"] or \
                    baseline.get("worktree") != str(b["worktree"]) or "remote_head" not in baseline or \
                    not re.fullmatch(r"[a-f0-9]{64}", baseline.get("checkpoint_sha256", "")) or \
                    not re.fullmatch(r"[a-f0-9]{64}", baseline.get("digest", "")):
                return "Stage 2 optional-link 기준이 손상되거나 다른 Part를 가리킵니다. worktree를 보존합니다."
            wt = Path(b["worktree"])
            bb, pp = stage2.split_key(b["batch"])
            cp = wt / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.json"
            cp_sha = hashlib.sha256(cp.read_bytes()).hexdigest()
            if cp_sha != baseline["checkpoint_sha256"]:
                return "optional-link AI 실행 중 checkpoint가 변경됐습니다. 수정 없이 worktree를 보존합니다."
            if self.git.dirty(wt).strip():
                return "optional-link AI 실행 중 tracked 산출물 또는 Git 파일이 변경됐습니다. worktree를 보존합니다."
            head = self.git.head(wt)
            if head != baseline.get("head"):
                return f"optional-link AI 실행 중 소유 HEAD가 변경됐습니다 ({baseline.get('head')} / {head})."
            remote = self.git.remote_head(b["branch"])
            if remote != baseline["remote_head"]:
                return f"optional-link AI 실행 중 원격 브랜치가 변경됐습니다 ({baseline['remote_head']} / {remote})."
        except TRANSIENT:
            raise
        except Exception as e:
            return f"Stage 2 optional-link 경계를 확인하지 못했습니다: {e}. worktree를 보존합니다."
        return None

    @staticmethod
    def _s2_chunk_run(b) -> bool:
        return b["method"] == STAGE2_METHOD and isinstance(b["run_kind"], str) and b["run_kind"].startswith("s2_chunk_")

    @staticmethod
    def _s2_links_run(b) -> bool:
        return b["method"] == STAGE2_METHOD and b["run_kind"] in ("s2_links_new", "s2_links_fix")

    @staticmethod
    def _s2_repair_run(b) -> bool:
        return b["method"] == STAGE2_METHOD and b["run_kind"] == "s2_repair_new"

    def _stage2_pending(self, b) -> str | None:
        try:
            checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
        except (OSError, ValueError, KeyError, TypeError):
            return None
        return checkpoint["pending_chunk"] if checkpoint else None

    def _s2_retry_fix_status(self, b, pending: str) -> str | None:
        key = stage2.retry_fix_key(b["id"])
        raw = self.store.get(key)
        if raw is None:
            return None
        try:
            status = json.loads(raw)
        except (TypeError, ValueError):
            self.store.delete(key)
            return None
        if not isinstance(status, dict):
            self.store.delete(key)
            return None
        expected = {"batch_id": b["id"], "shard": b["shard"], "batch": b["batch"],
                    "chunk_id": pending, "session_id": b["session_id"]}
        if any(status.get(name) != value for name, value in expected.items()) \
                or status.get("state") not in ("granted", "consumed"):
            self.store.delete(key)
            return None
        return status["state"]

    def _write_s2_retry_fix_status(self, b, pending: str, state: str) -> None:
        self.store.set(stage2.retry_fix_key(b["id"]), json.dumps({
            "batch_id": b["id"], "shard": b["shard"], "batch": b["batch"],
            "chunk_id": pending, "session_id": b["session_id"], "state": state,
        }, sort_keys=True))

    def _consume_s2_retry_fix(self, b, pending: str) -> bool:
        if self._s2_retry_fix_status(b, pending) != "granted":
            return False
        self._write_s2_retry_fix_status(b, pending, "consumed")
        return True

    def _run_ok_stage2_links(self, b) -> None:
        """Save the final optional-link answer through the official CLI; retries stay in this session."""
        if problem := self._stage2_links_boundary_problem(b):
            return self._fail(b, "ERROR", problem)
        try:
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._fail(b, "ERROR", f"optional-link 실행 중 예상하지 않은 PR #{info['number']}이 있습니다. 보존합니다.")
        except TRANSIENT:
            raise
        except Exception as e:
            return self._fail(b, "ERROR", f"optional-link 종료 후 기존 PR 소유권 확인 실패: {e}. 보존합니다.")
        try:
            baseline = json.loads(self.store.get(stage2.links_start_key(b["id"])) or "{}")
            digest = baseline.get("digest")
            if not re.fullmatch(r"[a-f0-9]{64}", digest or ""):
                return self._fail(b, "ERROR", "optional-link digest 기준이 없거나 손상되었습니다. worktree를 보존합니다.")
            final = self._adapter(b["producer"]).final_answer(Path(b["log_file"]))
            format_problem = stage2.link_format_problem(final, digest)
            if format_problem:
                return self._stage2_links_rejected(b, format_problem)
            rows = stage2.extract_link_decisions(final, digest)
            if rows is None:
                return self._stage2_links_rejected(b, f"최종 답변이 없습니다. 첫 줄 `links @{digest}` 뒤에 전체 candidate rows를 제출하세요.")
            decisions = Path(b["worktree"]) / ".warroom-scratch" / "optional-decisions.txt"
            decisions.parent.mkdir(parents=True, exist_ok=True)
            decisions.write_text(f"links @{digest}\n" + "\n".join(rows) + "\n", "utf-8")
            bb, pp = stage2.split_key(b["batch"])
            ok, detail = self.git.stage2_save_optional(Path(b["worktree"]), b["shard"], bb, pp)
            if not ok:
                self.store.add_submit_failure(b["id"])
                self.store.log(b["id"], f"Stage 2 optional-link 저장 거부: {detail[:300]}", "warn")
                return self._stage2_links_rejected(b, detail)
            checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
            if checkpoint is None or not checkpoint.get("optional_review_complete") or checkpoint.get("pending_chunk") is not None:
                return self._fail(b, "ERROR", "save-optional 뒤 checkpoint 완료 증거가 없습니다. 다음 단계로 진행하지 않습니다.")
        except TRANSIENT:
            raise
        except (GitError, OSError, ValueError, TypeError, KeyError) as e:
            return self._fail(b, "ERROR", f"optional-link 응답 저장 처리 실패: {e}. 파일과 checkpoint를 보존합니다.")
        self.store.delete(stage2.links_start_key(b["id"]))
        self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
        self.store.log(b["id"], "optional-link 결과와 완료 증거를 checkpoint에 저장했습니다. AI 재실행 없이 deterministic finalization으로 진행합니다.")
        return self._launch_stage2_next(self.store.batch(b["id"]))

    def _run_ok_stage2_repair(self, b) -> None:
        """Accept one fresh answer-only repair page, persist it, then apply only through admission-cli."""
        if problem := self._stage2_repair_boundary_problem(b):
            return self._fail(b, "ERROR", problem)
        try:
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._fail(b, "ERROR", f"Stage 2 repair completed after an unexpected PR #{info['number']} appeared; preserving evidence")
            state = self._stage2_repair_state(b, required=True)
            answer = self._stage2_repair_response(b, state)
            if answer is None:
                return self._fail(b, "ERROR", "Stage 2 repair answer is missing the exact fingerprint header; preserving the run and checkpoint")
            return self._apply_stage2_repair_answer(b, state)
        except TRANSIENT:
            raise
        except (OSError, ValueError, KeyError, TypeError, GitError) as error:
            return self._fail(b, "ERROR", f"Stage 2 repair answer rejected; no checkpoint change was made: {error}")

    def _stage2_links_rejected(self, b, diagnostic: str) -> None:
        used = stage2.fixes_used(self.store.runs(b["id"]), "s2_links_new", ("s2_links_fix",))
        if used < stage2.MAX_FIXES and b["session_id"]:
            self._s2_links_problem[b["id"]] = diagnostic
            self.store.update(b["id"], retries=0, retry_after=None, error=None)
            return self._launch(self.store.batch(b["id"]), "s2_links_fix")
        return self._fail(b, "ERROR", "Stage 2 optional-link 판정이 저장 검증을 통과하지 못했고 같은 세션 수정 기회를 소진했습니다. "
                          f"결정 파일과 checkpoint를 보존합니다: {diagnostic[:600]}")

    def _stage2_response(self, b) -> list[str] | None:
        """The `c<n>` rows of this run's final answer for the CURRENT pending chunk, or None (no response)."""
        pending = self._stage2_pending(b)
        if pending is None:
            return None
        return stage2.extract_decisions(self._adapter(b["producer"]).final_answer(Path(b["log_file"])), pending)

    def _stage2_format_problem(self, b) -> str | None:
        """A malformed but clearly attempted current-chunk answer from this run's FINAL response, or None (MISSING)."""
        pending = self._stage2_pending(b)
        if pending is None:
            return None
        final = self._adapter(b["producer"]).final_answer(Path(b["log_file"]))
        return stage2.format_problem(final, pending)

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
        self.store.delete(stage2.retry_fix_key(b["id"]))
        self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
        self.store.log(b["id"], "Stage 2 청크가 admission-cli save-chunk를 통과해 checkpoint에 저장됐습니다. 다음 단계는 새 세션으로 실행합니다.")
        return self._launch_stage2_next(self.store.batch(b["id"]))

    def _stage2_saved_or_fail(self, b) -> None:
        if not self._stage2_chunk_saved(b):
            return self._fail(b, "ERROR", "save-chunk가 성공했지만 checkpoint가 시작 시점 대비 정확히 한 청크만 전진하지 않았습니다. "
                              "자동 재생산하지 않고 worktree와 기록을 보존합니다.")
        return self._stage2_accept(b)

    def _stage2_rejected(self, b, diagnostic: str) -> None:
        """Route a saved/format rejection by the preserved decisions file: absent means full format repair, current means alias repair."""
        pending = self._stage2_pending(b)
        if pending is None:
            return self._fail(b, "ERROR", "Stage 2 수정 요청에 현재 pending 청크가 없습니다. 결정 파일과 checkpoint를 보존합니다.")
        file_state = stage2.decision_file_state(b["worktree"], pending)
        if file_state == "corrupt":
            return self._fail(b, "ERROR", f"Stage 2 판정 파일이 비어 있거나 현재 청크와 맞지 않거나 손상되어 수정하지 않습니다. "
                              f"파일과 checkpoint를 보존합니다: {stage2.DECISIONS}")
        used = stage2.fixes_used(self.store.runs(b["id"]), "s2_chunk_new",
                                 ("s2_chunk_fix", "s2_chunk_format_fix"))
        extra = bool(b["session_id"] and used >= stage2.MAX_FIXES and self._consume_s2_retry_fix(b, pending))
        if b["session_id"] and (used < stage2.MAX_FIXES or extra):
            self._s2_fix_problem[b["id"]] = stage2.compact_fix_diagnostic(diagnostic)
            self.store.update(b["id"], retries=0, retry_after=None, error=None)
            kind = "s2_chunk_format_fix" if file_state == "missing" else "s2_chunk_fix"
            return self._launch(self.store.batch(b["id"]), kind)
        return self._fail(b, "ERROR", "Stage 2 청크 판정이 저장 검증을 통과하지 못했고 자동 수정 기회가 없습니다 "
                          f"(결정 파일 {stage2.DECISIONS} 보존; 명시적 Retry는 같은 세션의 추가 수정 1회만 허용): {diagnostic[:600]}")

    def _stage2_invalid_format(self, b, problem: str) -> None:
        """Reject a parse-level format failure to the same session without discarding a prior partial decision file."""
        pending = self._stage2_pending(b)
        if pending is None:
            return self._fail(b, "ERROR", "Stage 2 형식 오류를 처리할 현재 pending 청크가 없습니다. 기록을 보존합니다.")
        file_state = stage2.decision_file_state(b["worktree"], pending)
        self.store.add_submit_failure(b["id"])
        self.store.log(b["id"], f"Stage 2 청크 출력 형식 거부: {problem[:300]}", "warn")
        if file_state == "corrupt":
            return self._fail(b, "ERROR", f"Stage 2 판정 파일이 비어 있거나 현재 청크와 맞지 않거나 손상되어 형식 수정에 사용하지 않습니다. "
                              f"파일과 checkpoint를 보존합니다: {stage2.DECISIONS}")
        if file_state == "current":
            try:
                ok, detail = self._stage2_save(b)  # re-check the original aliases before asking for another partial fix
            except TRANSIENT:
                raise
            except (OSError, ValueError, GitError) as e:
                return self._fail(b, "ERROR", f"기존 Stage 2 판정 재검증 실패: {e}. 파일과 checkpoint를 보존합니다.")
            if ok:
                return self._stage2_saved_or_fail(b)
            diagnostic = f"{detail}\n\n현재 청크의 수정 응답도 출력 형식이 잘못되었습니다: {problem}"
        else:
            diagnostic = problem
        return self._stage2_rejected(b, diagnostic)

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
        if rows is None:
            if format_problem := self._stage2_format_problem(b):
                return self._stage2_invalid_format(b, format_problem)
            # No recognizable current-chunk judgment: keep the bounded missing-output path, never relabel it as format.
            if b["run_kind"] not in ("s2_chunk_fix", "s2_chunk_format_fix") \
                    and self._retry_unsaved_chunk(b, "현재 청크 응답 누락"):
                return
            return self._fail(b, "ERROR", "Stage 2 청크 실행은 종료됐지만 현재 청크 ID 헤더가 있는 판정 응답이 없고 시작 시점 대비 "
                              "checkpoint가 정확히 전진하지 않았거나 pending_chunk가 남아 있습니다. 자동 재진입 한도를 소진했거나 안전하지 않아 기록을 보존합니다.")
        if format_problem := stage2.joined_decision_rows_problem(rows):
            return self._stage2_invalid_format(b, format_problem)
        pending = self._stage2_pending(b)
        try:
            file_state = stage2.decision_file_state(b["worktree"], pending)
            if b["run_kind"] == "s2_chunk_fix":
                if file_state != "current":
                    return self._fail(b, "ERROR", "부분 수정 응답을 병합할 현재 청크 판정 파일이 없거나 손상됐습니다. "
                                      f"수정하지 않고 파일과 checkpoint를 보존합니다: {stage2.DECISIONS}")
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
                if file_state != "missing":
                    return self._fail(b, "ERROR", "전체 Stage 2 응답을 쓸 판정 파일이 이미 있거나 손상됐습니다. "
                                      f"덮어쓰지 않고 파일과 checkpoint를 보존합니다: {stage2.DECISIONS}")
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
            prompt = prompts.c_chunk_resume(rec["chunk_no"], checkpoint, remaining, note=rec.get("note", ""))
        else:
            note = rec.get("note", "")
            if self.store.get(literary.run_start_key(b["id"])):
                note += ("이전 세션을 찾지 못해 새 세션으로 같은 활성 청크를 이어간다. 이미 checkpoint에 완료된 Sense와 "
                         "기존 제출·판정은 보존하고, 남은 Sense만 처리한다.\n")
            card_bytes = len(prompts.c_chunk(b, rec["chunk_no"], checkpoint, view="", note=note).encode("utf-8"))
            if literary.delivery(card_bytes, view) == "inline":
                prompt = prompts.c_chunk(b, rec["chunk_no"], checkpoint, view=view, note=note)
            else:   # only this chunk falls back to pages; a failure here starts no AI
                prompt = prompts.c_chunk(b, rec["chunk_no"], checkpoint, pages=literary.write_pages(wt, view),
                                         note=note)
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
            rec = diag = None
            try:
                rec = literary.read_active(Path(b["worktree"]), b)
                if rec is not None:
                    diag = Path(b["worktree"]) / f"{literary.names(b).submit_prefix}{rec['chunk_no']:03d}.submit.json.diag.json"
            except (literary.LiteraryError, OSError, ValueError, KeyError, TypeError):
                pass
            if rec is not None and diag is not None and not diag.exists() and b["run_kind"] != "c_chunk_fix" \
                    and self._retry_unsaved_chunk(b, "checkpoint 미완료"):
                return
            return self._fail(b, "ERROR", "C 청크 실행이 종료됐지만 활성 청크의 모든 sense가 완료되지 않았습니다 (checkpoint 완료 증거 없음). "
                              "자동 재진입 한도를 소진했거나 제출 진단 때문에 안전하지 않아 보존합니다 — Retry는 같은 청크의 미완료 sense만 이어갑니다.")
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
            self.store.delete(f"c_repair_issue_count_{b['id']}")
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
            if b["method"] == STAGE2_METHOD:
                if problem := self._stage2_final_pr_problem(b, info):
                    return self._fail(b, "ERROR", problem)
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
        if not exp.candidate_issues or not exp.repair_ids:
            return self._fail(b, "ERROR", "정확한 source/sense에 결속된 Candidate v1 후보 내용 오류가 없어 자동 복구를 중단합니다.")
        key = f"c_repair_issue_count_{b['id']}"
        current_issues = exp.candidate_issue_count
        if current_issues <= 0:
            return self._fail(b, "ERROR", "Candidate v1 복구할 후보 오류 수가 확인되지 않아 자동 재호출을 중단합니다.")
        previous = self.store.get(key)
        if previous is not None:
            try:
                previous_issues = int(previous)
            except (TypeError, ValueError):
                return self._fail(b, "ERROR", "Candidate v1 복구 진행 상태가 손상되어 자동 재호출을 중단합니다.")
            if current_issues >= previous_issues:
                try:
                    cleared = literary.clear_candidates(self.runner, self._c_env(b), wt, b, list(exp.repair_ids))
                except (literary.LiteraryError, OSError, ValueError) as e:
                    return self._fail(b, "ERROR", f"정확한 Sense 후보 비우기 실패: {e}. worktree를 보존합니다.")
                self.store.delete(key)
                self.store.log(b["id"], f"Candidate v1 내용 오류가 줄지 않아 해당 Sense 후보를 비웠습니다 ({cleared['senses']} senses / {cleared['candidates']} candidates)", "warn")
                return self._c_finalize(b)
        self.store.set(key, str(current_issues))
        try:
            view = literary.render_chunk(self.runner, self._c_env(b), wt, b, self._c_db(), sense_ids=list(exp.repair_ids))
            literary.write_active(wt, b, view, list(exp.repair_ids), self.git.head(wt), self._c_next_no(b),
                                  repair=True, checkpoint_sha=literary.checkpoint_sha(wt, b),
                                  note="Candidate v1 검증이 아래 Sense의 후보를 거부했다. 후보 문자열만 고쳐 이 Sense들을 다시 제출한다: "
                                       + exp.diagnostic + "\n")
        except (literary.LiteraryError, OSError) as e:
            return self._fail(b, "ERROR", f"복구 청크 준비 실패: {e}")
        self.store.log(b["id"], f"Candidate v1 내용 오류 {current_issues}건이 남은 sense {list(exp.repair_ids)}만 재판정합니다", "warn")
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

    def _d_prepare_handoff(self, b) -> None:
        """Persist the existing PREPARE state before dropping the completed run's boundary baseline."""
        self.store.update(b["id"], state="PREPARE", run_kind=None, pid=None, session_id=None,
                          retries=0, retry_after=None, error=None)

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
            rec = dchunk.read_active(wt, b)
            if rec is not None:
                if rec["chunk_no"] == done:
                    if problem := self._stage2_chunk_boundary_problem(b, dchunk.run_start_key(b["id"])):
                        return self._fail(b, "ERROR", problem)
                    if problem := self._d_accept_saved(b, boundary_checked=True):
                        return self._fail(b, "ERROR", problem)
                    self._d_prepare_handoff(b)
                    self.store.delete(dchunk.run_start_key(b["id"]))
                    rec = None
                elif rec["chunk_no"] < done:
                    return self._fail(b, "ERROR", f"저장 완료 prefix {done} 뒤에 이전 활성 청크 {rec['chunk_no']}가 남아 있습니다. 보존합니다.")
                elif rec["chunk_no"] != done + 1:
                    return self._fail(b, "ERROR", f"활성 청크 {rec['chunk_no']}가 연속 prefix {done} 다음이 아닙니다. 보존합니다.")
                else:
                    if b["state"] == "PREPARE" and self.store.get(dchunk.run_start_key(b["id"])) is not None:
                        return self._fail(b, "ERROR", "D 다음 청크 실행 baseline이 PREPARE 상태에 남아 있습니다. 실행 시작 여부가 모호해 AI를 시작하지 않고 보존합니다.")
                    self._d_remember(b, done)
                    dchunk.read_view(wt, b, rec)   # the view must still be the one this record was written for
            else:
                raw = self.store.get(dchunk.run_start_key(b["id"]))
                if raw is not None:
                    try:
                        baseline = json.loads(raw)
                        baseline_chunk = baseline.get("chunk_no") if isinstance(baseline, dict) else None
                    except (TypeError, ValueError):
                        baseline_chunk = None
                    if baseline_chunk != done:
                        return self._fail(b, "ERROR", "D 청크 활성 파일은 없지만 실행 baseline이 저장 완료 prefix와 일치하지 않습니다. 보존합니다.")
                    if problem := self._stage2_chunk_boundary_problem(b, dchunk.run_start_key(b["id"])):
                        return self._fail(b, "ERROR", problem)
                    self._d_remember(b, done)
                    dchunk.clear_active(wt, b, done)  # idempotently finish any chunk-local cleanup interrupted after save verification
                    self._d_prepare_handoff(b)
                    self.store.delete(dchunk.run_start_key(b["id"]))
                else:
                    self._d_remember(b, done)
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
        chunk_files = dchunk.chunk_names(b, rec["chunk_no"])
        note = ""
        if kind == "d_chunk_new" and self.store.get(dchunk.run_start_key(b["id"])):
            note = ("이전 세션을 찾지 못해 새 세션으로 같은 활성 청크를 이어간다. "
                    f"{chunk_files.decisions}와 {chunk_files.searches}의 기존 판정·검색 증거를 읽고 보존한다. "
                    "이미 완성된 판정을 다시 만들거나 검색 기록을 삭제하지 말고, 미완료 Sense만 이어서 처리한다.\n")
        if kind == "d_chunk_resume":
            prompt = prompts.d_chunk_resume(rec["chunk_no"], decisions=chunk_files.decisions,
                                            searches=chunk_files.searches)
        else:
            card_bytes = len(prompts.d_chunk(b, rec["chunk_no"], view="", note=note).encode("utf-8"))
            if dchunk.delivery(card_bytes, view) == "inline":
                prompt = prompts.d_chunk(b, rec["chunk_no"], view=view, note=note)
            else:   # only this chunk falls back to pages; a failure here starts no AI
                prompt = prompts.d_chunk(b, rec["chunk_no"], pages=dchunk.write_pages(wt, b, view), note=note)
        baseline = {"branch": b["branch"], "worktree": str(wt), "head": self.git.head(wt),
                    "remote_head": self.git.remote_head(b["branch"]) if remote == "?" else remote,
                    "chunk_no": rec["chunk_no"]}
        return prompt, baseline

    def _d_chunk_saved(self, b) -> bool:
        """The active chunk is stored: the verified prefix has reached exactly its number (asked when a run ended / on retry)."""
        try:
            rec = dchunk.read_active(Path(b["worktree"]), b)
            return rec is not None and dchunk.verified_prefix(Path(b["worktree"]), b)[0] >= rec["chunk_no"]
        except (dchunk.DChunkError, OSError, ValueError):
            return False

    def _d_accept_saved(self, b, *, boundary_checked: bool = False) -> str | None:
        """After a saved chunk: exactly one chunk advanced, nothing else changed. A problem string, or None."""
        wt = Path(b["worktree"])
        try:
            rec = dchunk.read_active(wt, b)
            if rec is None:
                return "저장된 청크의 활성 메타가 없습니다. 보존합니다."
            if not boundary_checked:
                if problem := self._stage2_chunk_boundary_problem(b, dchunk.run_start_key(b["id"])):
                    return problem
            raw = self.store.get(dchunk.run_start_key(b["id"]))
            try:
                baseline = json.loads(raw) if raw is not None else None
            except (TypeError, ValueError):
                baseline = None
            if not isinstance(baseline, dict) or baseline.get("chunk_no") != rec["chunk_no"] \
                    or baseline.get("head") != rec["git_head"]:
                return "저장된 D 청크 번호와 실행 baseline이 일치하지 않습니다. 보존합니다."
            done, _total = dchunk.verified_prefix(wt, b)
            if done != rec["chunk_no"]:
                return f"저장된 청크 수({done})가 활성 청크({rec['chunk_no']})와 맞지 않습니다. 보존합니다."
            dchunk.read_view(wt, b, rec)  # the saved metadata must still bind the exact view being cleaned
            if problem := self._d_chunks_problem(b, done):
                return problem
            self._d_remember(b, done)
            dchunk.clear_active(wt, b, rec["chunk_no"])
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
            if self._d_fix(b):
                return
            wt = Path(b["worktree"])
            try:
                rec = dchunk.read_active(wt, b)
            except (dchunk.DChunkError, OSError, ValueError) as e:
                return self._fail(b, "ERROR", f"활성 D 청크 상태를 읽지 못했습니다. 임시 파일을 보존합니다: {e}")
            rejected = wt / dchunk.chunk_names(b, rec["chunk_no"]).rejected if rec else wt / "missing-d-rejection"
            if b["run_kind"] != "d_chunk_fix" and not rejected.exists() \
                    and not dchunk.has_search_failure(wt, b) \
                    and self._retry_unsaved_chunk(b, "활성 청크 저장 누락"):
                return
            return self._fail(b, "ERROR", "D 청크 실행이 종료됐지만 활성 청크가 저장되지 않았습니다 (chunk-NNN.jsonl 증거 없음). "
                              "자동 재진입 한도를 소진했거나 저장/검색 진단 때문에 안전하지 않아 보존합니다 — Retry는 같은 청크를 이어갑니다." + self._d_rejection_note(b))
        if problem := self._d_accept_saved(b, boundary_checked=True):
            return self._fail(b, "ERROR", problem)
        self._d_prepare_handoff(b)
        self.store.delete(dchunk.run_start_key(b["id"]))
        self.store.log(b["id"], "D 청크 저장을 확인했습니다. 다음 단계는 새 세션으로 실행합니다.")
        return self._launch_d_next(self.store.batch(b["id"]))

    def _d_fix(self, b) -> bool:
        """The run ended with nothing saved and the CLI's own `save` rejection for exactly this active chunk says the
        decisions can be repaired (a hit-bearing Z, `SEARCH_FAILED` or any other state never qualifies). Ask the SAME
        session to correct only the reported senses, at most `MAX_FIXES` times per chunk. The count is a persistent KV
        written before the launch, so a restart or a duplicate tick cannot add a second one; only an operator Retry clears it."""
        wt = Path(b["worktree"])
        try:
            rec = dchunk.read_active(wt, b)
            diag = dchunk.read_rejection(wt, b, rec) if rec else None
            has_decisions = (wt / dchunk.chunk_names(b, rec["chunk_no"]).decisions).is_file() if rec else False
        except (dchunk.DChunkError, OSError, ValueError):
            return False
        if rec is None or diag is None or not has_decisions or not b["session_id"]:
            return False
        key = dchunk.fix_key(b["id"], rec["chunk_no"])
        used = int(self.store.get(key) or 0)
        if used >= dchunk.MAX_FIXES:
            return False
        self.store.set(key, str(used + 1))
        self.store.update(b["id"], retries=0, retry_after=None, error=None)
        self.store.log(b["id"], f"D 청크 {rec['chunk_no']:03d} 저장 거부({diag.get('error_count', len(diag['errors']))}건). "
                       f"같은 세션에서 지목된 판정만 수정해 다시 저장합니다 ({used + 1}/{dchunk.MAX_FIXES})", "warn")
        self._launch(self.store.batch(b["id"]), "d_chunk_fix")
        return True

    def _d_rejection_note(self, b) -> str:
        """The recorded `save` rejection of the active chunk (reasons only), shown with the ERROR so the operator sees why."""
        try:
            rec = dchunk.read_active(Path(b["worktree"]), b)
            if rec is None:
                return ""
            diag = json.loads((Path(b["worktree"]) / dchunk.chunk_names(b, rec["chunk_no"]).rejected).read_text("utf-8"))
            return " 마지막 save 거부: " + " / ".join(str(e) for e in diag["errors"][:3])[:600]
        except (OSError, ValueError, KeyError, TypeError):
            return ""

    def _relaunch_d(self, b) -> None:
        legacy_handoff = self.store.get(dchunk.run_start_key(b["id"])) is None
        if legacy_handoff:
            if problem := self._d_legacy_handoff_problem(b):
                return self._fail(b, "ERROR", f"D 청크 재시작 복구를 안전하게 확인하지 못했습니다: {problem}. worktree와 브랜치를 보존합니다.")
        else:
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
        if legacy_handoff:
            self._d_prepare_handoff(b)
            self.store.log(b["id"], "D 청크의 완료 기록과 저장 prefix를 확인했습니다. 새 실행 전에 PREPARE로 복구합니다.", "warn")
            return self._launch_d_next(self.store.batch(b["id"]))
        if self._d_chunk_saved(b):
            if problem := self._d_accept_saved(b, boundary_checked=True):
                return self._fail(b, "ERROR", problem)
            self._d_prepare_handoff(b)
            self.store.delete(dchunk.run_start_key(b["id"]))
        return self._launch_d_next(self.store.batch(b["id"]))

    def _d_legacy_handoff_problem(self, b) -> str | None:
        """Prove a completed old D chunk handoff before recovering a missing run baseline; never invent one."""
        if b["state"] != "PRODUCING" or b["pid"] is not None or b["session_id"] is not None or \
                b["run_kind"] != "d_chunk_new" or b["pr_number"] is not None or b["retry_after"] is not None:
            return "배치가 완료된 청크와 다음 청크 사이의 예상된 상태가 아닙니다"
        if self.store.get(f"pending_{b['id']}") is not None:
            return "재시도 대기 상태가 남아 있습니다"
        wt = Path(b["worktree"])
        try:
            if not wt.is_dir() or self.git.registered(wt) != b["branch"]:
                return "배치 소유 worktree 또는 브랜치가 일치하지 않습니다"
            if self.git.dirty(wt).strip():
                return "worktree에 Git 변경이 남아 있습니다"
            base = self.store.get(f"d_base_head_{b['id']}")
            head = self.git.head(wt)
            if not base or head != base or self.store.get(f"d_commit_head_{b['id']}") is not None:
                return "현재 HEAD가 기록된 배치 기준 HEAD와 다릅니다"
            if self.git.remote_head(b["branch"]) is not None:
                return "원격 브랜치 ref가 비어 있지 않아 기존 경계를 증명할 수 없습니다"
        except TRANSIENT:
            raise
        except Exception as e:
            return f"배치 소유 Git 경계를 확인하지 못했습니다: {e}"
        try:
            done, _total = dchunk.verified_prefix(wt, b)
            if done < 1:
                return "검증된 완료 청크가 없습니다"
            for chunk_no in range(1, done + 1):
                known = self.store.get(f"d_chunk_sha_{b['id']}_{chunk_no}")
                if known is None or known != dchunk.chunk_sha(wt, b, chunk_no):
                    return f"완료 청크 {chunk_no:03d}의 기록된 SHA가 없거나 달라졌습니다"
            if dchunk.read_active(wt, b) is not None:
                return "활성 D 청크 메타가 남아 있어 다음 실행 여부가 모호합니다"
            folder = wt / dchunk.names(b).directory
            allowed = {f"chunk-{n:03d}.jsonl" for n in range(1, done + 1)}
            if {p.name for p in folder.iterdir()} != allowed:
                return "D scratch에 저장 청크 외 파일이 있어 실행/임시 상태가 모호합니다"
        except TRANSIENT:
            raise
        except (dchunk.DChunkError, OSError, ValueError) as e:
            return f"완료 prefix 또는 D scratch를 검증하지 못했습니다: {e}"
        runs = self.store.runs(b["id"])
        if len(runs) != done or any(r["kind"] != "d_chunk_new" or r["ended_at"] is None or
                                      str(r["exit_status"]) != "0" or r["submit_failures"] for r in runs):
            return "저장 청크 수와 정상 종료한 D 실행 기록이 일치하지 않습니다"
        last = runs[0]
        if self.store.get(f"verified_completion_run_{b['id']}") != str(last["id"]):
            return "마지막 AI 실행의 완료 확인 기록이 없습니다"
        if b["log_file"] != last["log_file"] or b["exit_file"] != last["exit_file"] or not last["session_id"]:
            return "배치 실행 파일 또는 세션이 마지막 AI 실행 기록과 다릅니다"
        try:
            if Path(last["exit_file"]).read_text("utf-8").strip() != "0":
                return "마지막 AI 실행의 종료 코드 파일이 성공을 증명하지 않습니다"
            ad = self._adapter(b["producer"])
            run = RunSpec(last["model"], last["effort"], last["permission_profile"] or "") if last["model"] else None
            if run is None:
                return "마지막 AI 실행의 모델 핀 기록이 없습니다"
            if ad.output_identity_problem(Path(last["log_file"]), run, last["session_id"], wt, self.env):
                return "마지막 AI 실행의 소유권 또는 모델 핀 로그를 확인하지 못했습니다"
            if ad.completion_problem(Path(last["log_file"]), run, last["session_id"], wt, self.env):
                return "마지막 AI 실행의 정상 완료 증거를 확인하지 못했습니다"
        except TRANSIENT:
            raise
        except (OSError, TypeError, ValueError, KeyError) as e:
            return f"마지막 AI 실행 증거를 읽지 못했습니다: {e}"
        return None

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

    @staticmethod
    def _ab_policy_skip_event_key(b, chunk: dict) -> str:
        return f"ab-policy-skip:{b['shard']}:{b['batch']}:{b['method']}:{b['producer']}:{chunk['number']:03d}"

    def _ab_policy_skip_chunk(self, b) -> dict | None:
        """Only a first, answer-only A/B chunk can be converted after an exact provider refusal."""
        if b["state"] != "PRODUCING" or b["method"] not in stage1ab.METHODS or b["run_kind"] != "ab_chunk_new":
            return None
        try:
            raw = self.store.get(stage1ab.run_start_key(b["id"]))
            baseline = json.loads(raw or "")
            if not isinstance(baseline, dict):
                return None
            if baseline.get("repair"):
                return None
            chunk = stage1ab.chunk_by_number(stage1ab.checkpoint(b["worktree"], b), int(baseline["chunk_no"]))
            state = stage1ab.load_state(self.store, b["id"], chunk["number"])
            return chunk if state["tries"] == 0 and state["requested"] is None else None
        except (stage1ab.ABChunkError, OSError, ValueError, KeyError, TypeError):
            return None

    def _ab_complete_response(self, b, chunk: dict) -> bool:
        """True only when the current answer block covers every alias in the chunk's exact saved view."""
        try:
            body = stage1ab.extract_block(self._adapter(b["producer"]).final_answer(Path(b["log_file"])), chunk["number"])
            revised = stage1ab.split_rows(body)
            view = (Path(b["worktree"]) / stage1ab.view_path(b, chunk["number"])).read_text("utf-8")
            aliases = [row[0] for row in stage1ab.view_rows(view)]
            return len(revised) == len(aliases) and set(revised) == set(aliases)
        except (stage1ab.ABChunkError, OSError, ValueError, KeyError, TypeError):
            return False

    def _ab_save_policy_skip(self, b, chunk: dict) -> None:
        """Persist the manual ID list, save an all-empty chunk through save-chunk, then use normal acceptance."""
        key = stage1ab.run_start_key(b["id"])
        if problem := self._stage2_chunk_boundary_problem(b, key):
            return self._fail(b, "ERROR", problem)
        wt = Path(b["worktree"])
        try:
            if self.git.dirty(wt).strip():
                return self._fail(b, "ERROR", "정책 거부 청크 종료 뒤 worktree에 추적 변경이 있습니다. 보존합니다.")
            if self._find_recovery_pr(b) is not None:
                return self._fail(b, "ERROR", "정책 거부 청크 실행 중 소유 브랜치에 PR이 생겼습니다. 보존합니다.")
            baseline = json.loads(self.store.get(key) or "")
            cp = stage1ab.checkpoint(wt, b)
            chunk = stage1ab.chunk_by_number(cp, int(baseline["chunk_no"]))
            if stage1ab.saved_snapshot(wt, b, cp) != baseline.get("saved"):
                return self._fail(b, "ERROR", "정책 거부 청크 실행 중 저장물이 변경됐습니다. 덮어쓰지 않고 보존합니다.")
            if stage1ab.chunk_saved(wt, b, chunk):
                self.store.log(b["id"], f"A/B 청크 {chunk['number']:03d}에 기존 저장 후보가 있어 정책 Skip으로 덮어쓰지 않습니다.", "warn")
                return self._ab_accept(b, chunk, False)
            if self._ab_complete_response(b, chunk):
                self.store.log(b["id"], f"A/B 청크 {chunk['number']:03d}에 완성 응답이 있어 기존 저장 검증 경로로 전달합니다.", "warn")
                return self._run_ok_ab_chunk(b)
            record_ids = stage1ab.chunk_record_ids(wt, b, chunk)
            view = (wt / stage1ab.view_path(b, chunk["number"])).read_text("utf-8")
            lines = [row[0] for row in stage1ab.view_rows(view)]
            if len(lines) != chunk["sense_count"]:
                raise stage1ab.ABChunkError("정책 Skip compact view의 sense 수가 checkpoint와 다릅니다")
        except TRANSIENT:
            raise
        except (stage1ab.ABChunkError, OSError, ValueError, KeyError, TypeError, GitError) as e:
            return self._fail(b, "ERROR", f"정책 거부 청크 확인 실패: {e}. 보존합니다.")
        title = (f"[Policy Skip][{b['method'].upper()}/{b['producer']}] "
                 f"{b['shard']}_{b['batch']} Chunk {chunk['number']:03d}")
        body = "\n".join(record_ids)
        try:
            request_id = self.maint.report_issue(title, body, urgent=False,
                                                 event_key=self._ab_policy_skip_event_key(b, chunk))
        except Exception as e:
            return self._fail(b, "ERROR", f"정책 Skip 수동 Issue 요청을 영속화하지 못했습니다. 청크와 실행 기록을 보존합니다: {e}")
        try:
            saved, diag = stage1ab.save(self.runner, self.env, wt, b, chunk, lines)
            if not saved:
                return self._fail(b, "ERROR", f"수동 Issue 요청은 영속화했지만 빈 후보 청크 저장이 거부됐습니다: {diag}. 보존합니다.")
            if not stage1ab.chunk_saved(wt, b, chunk):
                return self._fail(b, "ERROR", "빈 후보 저장은 성공했지만 Canonical ID/sense 검증을 통과하지 못했습니다. 보존합니다.")
        except (stage1ab.ABChunkError, OSError, ValueError, KeyError, TypeError) as e:
            return self._fail(b, "ERROR", f"수동 Issue 요청 #{request_id} 뒤 빈 후보 청크 저장 확인 실패: {e}. 보존합니다.")
        except Exception as e:
            return self._fail(b, "ERROR", f"수동 Issue 요청 #{request_id} 뒤 빈 후보 청크 저장 실패: {e}. 보존합니다.")
        self.store.log(b["id"], f"Codex 정책 거부: A/B 청크 {chunk['number']:03d}의 빈 후보 저장과 수동 Issue 요청 #{request_id}를 확인했습니다.", "warn")
        return self._ab_accept(b, chunk, False)

    def _handle_ab_policy_refusal(self, b, chunk: dict) -> None:
        """A confirmed refusal is accepted only after the run identity and the normal chunk boundary are checked."""
        ad = self._adapter(b["producer"])
        if problem := ad.output_identity_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"],
                                                 b["worktree"], self.env):
            return self._fail(b, problem[0], f"Codex 정책 거부 실행의 소유권/핀 확인 실패: {problem[1]}")
        return self._ab_save_policy_skip(b, chunk)

    def _fix_kind(self, b) -> str:
        """Stage 2/3 and chunked A/B review fixes start a bounded fresh session."""
        if b["method"] in (STAGE2_METHOD, STAGE3_METHOD):
            return "fix_new"
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
            max_tries = stage1ab.MAX_TRIES if repair else stage1ab.MAX_SAVE_TRIES
            if st["tries"] > max_tries:
                return self._fail(b, "ERROR", f"청크 {chunk['number']:03d}의 저장 거부가 정정 {max_tries}회 뒤에도 해소되지 않았습니다. "
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
                if st["requested"] is None:
                    note = f"이 청크의 이전 세션을 찾지 못해 완전한 답변이 남지 않았다. 전체 청크를 새로 답한다. 사유: {st.get('problem') or '세션 없음'}\n"
                else:
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

    def _ab_log_auto_removals(self, b, chunk: dict, save_result: str) -> None:
        """Record exact compact-save cleanup only when the CLI reports removals."""
        if '"items":[]' in save_result:
            return
        try:
            result = json.loads(save_result)
            cleanup = result.get("autoRemoved", {})
            items = cleanup.get("items", [])
            count = int(cleanup.get("count", len(items)))
        except (TypeError, ValueError, AttributeError):
            return
        if count <= 0 or not items:
            return
        details = "; ".join(f"{item['alias']} {json.dumps(item['candidate'], ensure_ascii=False)} ({item['reason']})"
                             for item in items if isinstance(item, dict) and {"alias", "candidate", "reason"} <= item.keys())
        self.store.log(b["id"], f"A/B 청크 {chunk['number']:03d} 자동 정제 {count}개: {details}", "warn")

    def _ab_log_candidate_discards(self, b, chunk: dict, rejected: list[dict]) -> None:
        details = "; ".join(f"{item['alias']} {json.dumps(item['candidate'], ensure_ascii=False)} ({item['reason']})" for item in rejected)
        self.store.log(b["id"], f"A/B 청크 {chunk['number']:03d} 정정 3회 뒤 식별된 부적격 후보 {len(rejected)}개를 제거하고 재검증합니다: {details}", "warn")

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
        submitted_lines = None
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
            submitted_lines = lines
            ok, diag = stage1ab.save(self.runner, self.env, wt, b, chunk, lines)
            if ok:
                self._ab_log_auto_removals(b, chunk, diag)
                if not stage1ab.chunk_saved(wt, b, chunk):
                    return self._fail(b, "ERROR", "save-chunk가 성공했지만 저장 파일이 chunk의 Canonical ID와 맞지 않습니다. 보존합니다.")
                return self._ab_accept(b, chunk, repair)
            st["requested"] = stage1ab.rejected_aliases(diag, rows)
        except stage1ab.ABChunkError as e:
            diag = str(e)   # an unusable answer: ask the same rows again
        except (OSError, ValueError) as e:
            return self._fail(b, "ERROR", f"답변 처리 중 파일 오류: {e}. 보존합니다.")
        st["problem"] = diag[:1500]
        if repair and st["tries"] >= stage1ab.MAX_TRIES:
            return self._fail(b, "ERROR", f"최종 merge 거부 뒤 청크 {chunk['number']:03d}의 정정 {stage1ab.MAX_TRIES}회가 저장되지 않았습니다. "
                              f"실제 저장 오류: {diag}. 답변과 상태를 보존합니다.")
        if not repair and st["tries"] >= stage1ab.MAX_SAVE_TRIES:
            rejected = stage1ab.rejected_candidates(diag, rows, submitted_lines or [])
            if not rejected:
                st["tries"] = stage1ab.MAX_SAVE_TRIES + 1
                stage1ab.save_state(self.store, b["id"], chunk["number"], st)
                self.store.log(b["id"], f"A/B 청크 {chunk['number']:03d} 마지막 정정 저장 거부: {diag[:200]}", "warn")
                return self._fail(b, "ERROR", f"청크 {chunk['number']:03d}의 정정 3회 뒤에도 저장되지 않았고 제거할 부적격 후보를 정확히 특정하지 못했습니다. 실제 저장 오류: {diag}. 답변과 상태를 보존합니다.")
            try:
                cleaned = stage1ab.remove_rejected_candidates(submitted_lines or [], rejected)
                saved, final_diag = stage1ab.save(self.runner, self.env, wt, b, chunk, cleaned)
            except (stage1ab.ABChunkError, OSError, ValueError) as e:
                st["tries"] = stage1ab.MAX_SAVE_TRIES + 1
                stage1ab.save_state(self.store, b["id"], chunk["number"], st)
                return self._fail(b, "ERROR", f"청크 {chunk['number']:03d}의 정정 3회 뒤 후보 정리 실패: {e}. 기존 오류: {diag}. 답변과 상태를 보존합니다.")
            self._ab_log_candidate_discards(b, chunk, rejected)
            if not saved:
                st["tries"] = stage1ab.MAX_SAVE_TRIES + 1
                st["problem"] = final_diag[:1500]
                stage1ab.save_state(self.store, b["id"], chunk["number"], st)
                return self._fail(b, "ERROR", f"청크 {chunk['number']:03d}의 정정 3회 뒤 정확히 식별된 후보를 제거했지만 동일 save-chunk 검증이 실패했습니다: {final_diag}. 답변과 상태를 보존합니다.")
            self._ab_log_auto_removals(b, chunk, final_diag)
            if not stage1ab.chunk_saved(wt, b, chunk):
                return self._fail(b, "ERROR", "후보 제거 후 save-chunk가 성공했지만 저장 파일이 chunk의 Canonical ID와 맞지 않습니다. 보존합니다.")
            return self._ab_accept(b, chunk, repair)
        st["tries"] += 1
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

    def _ab_chunk_attempted(self, b) -> bool:
        """Exact current `BEGIN chunk NNN` line in this run's final answer, even when its block is malformed."""
        try:
            baseline = json.loads(self.store.get(stage1ab.run_start_key(b["id"])) or "")
            marker = f"BEGIN chunk {int(baseline['chunk_no']):03d}"
            final = self._adapter(b["producer"]).final_answer(Path(b["log_file"]))
            return isinstance(final, str) and any(line.strip() == marker for line in final.replace("\r\n", "\n").split("\n"))
        except (OSError, ValueError, KeyError, TypeError):
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
            policy_chunk = self._ab_policy_skip_chunk(b)
            if policy_chunk is not None:
                if self._ab_complete_response(b, policy_chunk):
                    return self._run_ok_ab_chunk(b)
                refusal = self._adapter(b["producer"]).confirmed_prompt_refusal(Path(b["log_file"]))
                if refusal:
                    return self._handle_ab_policy_refusal(b, policy_chunk)
                if self.store.issue_request(self._ab_policy_skip_event_key(b, policy_chunk)) is not None:
                    return self._ab_save_policy_skip(b, policy_chunk)
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

    def _producer_fix_context(self, b, events, session_id: str | None = None) -> tuple[str, dict[str, str]]:
        """Provide the exact current Candidate/Canonical evidence and only reuse it after confirmed same-session delivery."""
        text = "\n".join(str(e.get("body", "")) for e in (events or []))
        try:
            if b["method"] in stage1ab.METHODS:
                names = stage1ab.names(b)
            elif b["method"] == literary.METHOD:
                names = literary.names(b)
            elif b["method"] == dchunk.METHOD:
                names = dchunk.names(b)
            else:
                raise stage1ab.ABChunkError(f"알 수 없는 Candidate 방식: {b['method']}")
            _allowed, context, digests = stage1ab.fix_scope_data(
                Path(b["worktree"]), b, text, output_path=names.output, canonical_path=names.canonical)
            key = f"fix_context_sent_{b['id']}"
            previous = {}
            try:
                previous = json.loads(self.store.get(key) or "{}")
            except (TypeError, ValueError):
                pass
            sent = previous.get("digests") if previous.get("session_id") == session_id and session_id else {}
            sent = sent if isinstance(sent, dict) else {}
            repeated = sorted(sid for sid, digest in digests.items() if sent.get(sid) == digest)
            digests = {sid: digest for sid, digest in digests.items() if sid not in repeated}
            if repeated:
                note = f"이 세션에 이미 전달된 동일 근거: {', '.join(repeated)}"
                if not digests:
                    return note, {}
                context_lines = context.splitlines()
                context_lines = [line for line in context_lines if not (
                    len(line.split("\t")) == 6 and line.split("\t")[1] in repeated)]
                context = note + "\n" + "\n".join(context_lines) + "\n"
            if len(context.encode("utf-8")) > 90_000:
                pages = stage2.chunk_pages(context)
                page_paths = stage2.write_pages(Path(b["worktree"]), ".warroom-scratch/producer-fix-context.txt", pages)
                context = ("source_context가 90 KB를 넘어 손실 없이 분할했다. 아래 page를 각각 별도 도구 호출 한 번씩 읽는다:\n" +
                           "\n".join(f"- cat {path} ({i}/{len(page_paths)})"
                                     for i, path in enumerate(page_paths, 1)) + "\n")
            return context, digests
        except TRANSIENT:
            raise
        except (stage1ab.ABChunkError, OSError, ValueError, KeyError, TypeError) as e:
            return f"source_context 없음: {e}\n", {}

    def _retry_producer_fix(self, b) -> None:
        """Owner Retry rechecks the attached PR and current-HEAD blockers before assigning incomplete review events."""
        try:
            info, events = self._events(b)
            if info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]:
                return self._fail(b, "ERROR", "Retry 차단: 현재 PR 번호 또는 head 브랜치가 배치 소유권과 다릅니다. 보존합니다.")
            if info.get("state") != "open" or info.get("merged"):
                return self._fail(b, "ERROR", "Retry 차단: 소유 PR이 열린 상태가 아닙니다. worktree와 PR을 보존합니다.")
            local = self.git.head(Path(b["worktree"]))
            if local != info["head_sha"]:
                self._fast_forward_pr_head(b, info)
                info, events = self._events(b)  # re-read review events after safe synchronization
                if info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"] \
                        or info.get("state") != "open" or info.get("merged"):
                    return self._fail(b, "ERROR", "Retry 중 소유 PR이 바뀌었습니다. worktree와 PR을 보존합니다.")
                if self.git.head(Path(b["worktree"])) != info["head_sha"]:
                    return self._fail(b, "ERROR", "Retry 중 local HEAD와 현재 PR HEAD가 일치하지 않습니다. 보존합니다.")
            remote = self.git.remote_head(b["branch"])
            if remote != info["head_sha"]:
                return self._fail(b, "ERROR", f"Retry 차단: 원격 소유 브랜치와 PR HEAD가 다릅니다 ({remote} / {info['head_sha']}). 보존합니다.")
            if b["head_sha"] != info["head_sha"]:
                self.store.update(b["id"], head_sha=info["head_sha"])
                b = self.store.batch(b["id"])
            events, problem = self._retryable_producer_fix_events(b, events)
            if problem:
                return self._fail(b, "ERROR", problem)
            if not events:
                self._to_review(b, info, "운영자 Retry: 현재 HEAD에 유효한 미해결 리뷰 이벤트가 없어 오래된 이벤트를 다시 실행하지 않았습니다.")
                return self.store.log(b["id"], "운영자 Retry: 현재 HEAD의 미해결 리뷰 이벤트 없음 — 리뷰 감시로 복귀")
            return self._launch(b, self._fix_kind(b), events)
        except TRANSIENT:
            raise
        except Exception as e:
            return self._fail(b, "ERROR", f"Retry 전 현재 PR/HEAD/리뷰 확인 실패: {e}. worktree와 PR을 보존합니다.")

    def _retryable_producer_fix_events(self, b, events) -> tuple[list[dict], str | None]:
        """Skip proven completions; recover legacy launch-time markers only when missing reply evidence proves a gap."""
        pending = []
        for event in events:
            row = self.store.handled_event(b["id"], b["pr_number"], b["head_sha"], event["key"])
            if row is None or row["status"] == "CLAIMED":
                pending.append(event)
                continue
            if row["status"] == "HANDLED":
                continue
            if row["status"] != "LEGACY":
                return [], f"알 수 없는 리뷰 이벤트 상태 {row['status']!r}; 이벤트와 PR을 보존했습니다."

            # Before #2322, the marker was written immediately after add_run(). Correlate only a nearby prior fix run;
            # if the old evidence cannot be tied to that event, do not revive or overwrite it speculatively.
            prior_runs = [run for run in self.store.runs(b["id"])
                          if isinstance(run["kind"], str) and run["kind"].startswith("fix")
                          and run["started_at"] is not None and run["started_at"] <= row["ts"]]
            prior_run = max(prior_runs, key=lambda run: run["started_at"], default=None)
            if prior_run is None or row["ts"] - prior_run["started_at"] > 60:
                return [], (f"legacy 이벤트 {event['key']}의 과거 fix 실행을 정확히 연결할 수 없어 자동 복구하지 않았습니다. "
                            "기록을 보존했습니다. 오너가 실행·답글 증거를 확인해야 합니다.")
            replies = []
            for comment in self.gh.issue_comments(b["pr_number"]):
                user = comment.get("user") if isinstance(comment.get("user"), dict) else {}
                if (str(user.get("login") or "").casefold() == str(self.cfg["expected_account"]).casefold()
                        and str(comment.get("body") or "").strip() and comment.get("id") is not None
                        and reviews._ts(comment.get("created_at")) >= prior_run["started_at"]):
                    replies.append(comment)
            if replies:
                return [], (f"legacy 이벤트 {event['key']}의 과거 fix 실행 뒤 PR 답글이 있어 완료 여부가 모호합니다. "
                            "이벤트와 PR을 보존하고 자동 재실행하지 않았습니다.")
            pending.append(event)
            self.store.log(b["id"], f"운영자 Retry: legacy 리뷰 이벤트 {event['key']}의 관련 fix 실행은 있으나 "
                           "실행 후 PR 답글 증거가 없어 미완료 이벤트로 복구합니다.", "warn")
        return pending, None

    def _remember_fix_context_delivery(self, b) -> None:
        """Persist only source rows from a successfully completed fix prompt with its actual session ID."""
        key = f"fix_context_pending_{b['id']}"
        try:
            pending = json.loads(self.store.get(key) or "")
            run = self._last_run(b)
            digests = pending.get("digests")
            if (run is None or pending.get("run_id") != run["id"] or not run["kind"].startswith("fix")
                    or run["ended_at"] is None or str(run["exit_status"]) != "0"
                    or self.store.get(f"verified_completion_run_{b['id']}") != str(run["id"])
                    or not isinstance(run["session_id"], str) or not run["session_id"].strip()
                    or not isinstance(digests, dict) or not digests):
                return
            session_id = run["session_id"]
            sent_key = f"fix_context_sent_{b['id']}"
            try:
                previous = json.loads(self.store.get(sent_key) or "{}")
            except (TypeError, ValueError):
                previous = {}
            old = previous.get("digests") if previous.get("session_id") == session_id else {}
            merged = dict(old) if isinstance(old, dict) else {}
            merged.update(digests)
            self.store.set(sent_key, json.dumps({"session_id": session_id, "digests": merged}, sort_keys=True))
            self.store.delete(key)
        except (TypeError, ValueError, KeyError):
            return

    def _complete_producer_fix_events(self, b) -> str | None:
        """A fix event is complete only after its exact run, owned PR and a new PR reply are confirmed."""
        try:
            claim = json.loads(self.store.get(f"fix_claim_{b['id']}") or "")
            run = self._last_run(b)
            if (not isinstance(claim, dict) or claim.get("status") != "CLAIMED"
                    or claim.get("pr") != b["pr_number"] or claim.get("head_sha") != b["head_sha"]
                    or not isinstance(claim.get("event_keys"), list) or not claim["event_keys"]
                    or run is None or claim.get("run_id") != run["id"] or not run["kind"].startswith("fix")
                    or run["ended_at"] is None or str(run["exit_status"]) != "0"
                    or self.store.get(f"verified_completion_run_{b['id']}") != str(run["id"])):
                return "수정 완료 증거가 현재 PR/HEAD에 배정된 fix 실행과 일치하지 않습니다. 리뷰 이벤트는 미완료로 보존했습니다."
            replies = []
            for comment in self.gh.issue_comments(b["pr_number"]):
                user = comment.get("user") if isinstance(comment.get("user"), dict) else {}
                if (str(user.get("login") or "").casefold() != str(self.cfg["expected_account"]).casefold()
                        or not str(comment.get("body") or "").strip()
                        or reviews._ts(comment.get("created_at")) < run["started_at"]
                        or comment.get("id") is None):
                    continue
                replies.append(comment)
            event_replies = {}
            for comment in replies:
                body_lines = {line.strip() for line in str(comment.get("body") or "").splitlines()}
                for key in claim["event_keys"]:
                    if f"WarRoom-Review-Event: {key}" in body_lines:
                        comment_id = int(comment["id"])
                        old = event_replies.get(key)
                        if old is None or (reviews._ts(comment.get("created_at")), comment_id) > old[0]:
                            event_replies[key] = ((reviews._ts(comment.get("created_at")), comment_id), comment_id)
            for key, (_order, reply_id) in event_replies.items():
                self.store.mark_handled(b["id"], b["pr_number"], claim["head_sha"], [key],
                                        run_id=run["id"], reply_id=reply_id)
            missing = [key for key in claim["event_keys"] if key not in event_replies]
            if missing:
                claim.update(status="PARTIAL" if event_replies else "CLAIMED",
                             handled_event_keys=sorted(event_replies), missing_event_keys=missing,
                             completed_at=self.clock() if event_replies else None)
                self.store.set(f"fix_claim_{b['id']}", json.dumps(claim, sort_keys=True))
                if not event_replies:
                    return (f"fix 실행 #{run['id']}의 성공 응답은 확인했지만 PR #{b['pr_number']}에 리뷰 이벤트 키가 표시된 "
                            "실행 후 답글이 없습니다. 이벤트는 미완료로 보존했습니다. 원인 확인 후 소유자 Retry가 필요합니다.")
                return (f"fix 실행 #{run['id']}의 PR 답글은 확인했지만 답변 증거가 없는 리뷰 이벤트가 남았습니다: "
                        f"{', '.join(missing)}. 표시된 이벤트만 완료 처리하고 나머지는 보존했습니다. 원인 확인 후 소유자 Retry가 필요합니다.")
            reply_ids = {key: reply_id for key, (_order, reply_id) in event_replies.items()}
            claim.update(status="HANDLED", reply_ids=reply_ids, completed_at=self.clock())
            self.store.set(f"fix_claim_{b['id']}", json.dumps(claim, sort_keys=True))
            return None
        except TRANSIENT:
            raise
        except Exception as e:
            return f"리뷰 수정 완료 증거 조회 실패: {e}. 이벤트는 미완료로 보존했습니다."

    def _s2_fix_context(self, b, events) -> str:
        """Inspect exact reviewed pairs and every Part Sense mentioned outside tuple spans."""
        try:
            checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
            if checkpoint is None:
                return "source_context 없음: 현재 Part checkpoint를 읽을 수 없습니다."
            bb, pp = stage2.split_key(b["batch"])
            cp_path = Path(b["worktree"]) / ".warroom-scratch" / \
                f"relation-admission-{b['shard']}-{bb}-{pp}.json"
            raw_checkpoint = json.loads(cp_path.read_text("utf-8"))
            if (raw_checkpoint.get("shard"), raw_checkpoint.get("batch"), raw_checkpoint.get("part")) != \
                    (b["shard"], bb, pp) or not isinstance(raw_checkpoint.get("items"), list):
                return "source_context 없음: 현재 Part checkpoint의 source Sense 목록을 신뢰할 수 없습니다."
            event_texts = [str(e.get("body", "")) for e in (events or [])]
            review = stage2.review_events(event_texts, raw_checkpoint["items"])
            selected = sorted({pair["source_sense_id"] for pair in review["pairs"]} |
                              set(review["fallback_sense_ids"]))
            in_part = {item["sense_id"] for item in raw_checkpoint["items"]
                       if isinstance(item, dict) and isinstance(item.get("sense_id"), str)}
            unknown = sorted(set(review["mentioned_sense_ids"]) - in_part)
            if not selected:
                suffix = f" 리뷰의 Part 밖/없는 Sense ID: {', '.join(unknown[:20])}." if unknown else ""
                return ("source_context 없음: 리뷰에 현재 Part의 Sense ID 또는 정확한 candidate tuple이 없습니다." + suffix +
                        " Sense ID나 유효 튜플이 없는 순수 지시 문장은 source에 기계적으로 결속할 수 없습니다. "
                        "필요한 Sense·후보만 좁게 inspect 하세요.")
            selection_path = ".warroom-scratch/s2-fix-select.json"
            selection_file = Path(b["worktree"]) / selection_path
            selection_file.parent.mkdir(parents=True, exist_ok=True)
            selection_file.write_text(json.dumps({"candidates": [
                {"source_sense_id": pair["source_sense_id"], "candidate": pair["candidate"]}
                for pair in review["pairs"]
            ]}, ensure_ascii=False) + "\n", "utf-8")
            context = self.git.stage2_inspect(Path(b["worktree"]), b["shard"], *stage2.split_key(b["batch"]), selected,
                                              selection_path=selection_path)
            diagnostics = []
            for pair in review["unmatched_pairs"]:
                diagnostics.append("# Review tuple did not exactly match this Part: " +
                                   ", ".join((pair["record_id"], pair["source_sense_id"], pair["candidate"])))
            if review["fallback_sense_ids"]:
                diagnostics.append("# Full-sense detail for prose-mentioned or unmatched-tuple Senses: " +
                                   ", ".join(review["fallback_sense_ids"]))
            if unknown:
                diagnostics.append("# Review-mentioned IDs outside this Part (diagnostic only): " + ", ".join(unknown[:20]))
            if diagnostics:
                context += "\n" + "\n".join(diagnostics) + "\n"
            if len(context.encode("utf-8")) <= 90_000:
                return context
            page_paths = stage2.write_pages(Path(b["worktree"]), ".warroom-scratch/s2-fix-context.txt",
                                            stage2.chunk_pages(context))
            return ("Inspect 결과를 손실 없이 bounded pages로 저장했다. 필요한 page를 별도 도구 호출로 한 번씩 읽는다:\n" +
                    "\n".join(f"- cat {name} ({i}/{len(page_paths)})" for i, name in enumerate(page_paths, 1)))
        except TRANSIENT:
            raise
        except Exception as e:
            return f"source_context 조회 실패: {e}. 전체 checkpoint를 출력하지 말고 필요한 ID만 inspect 하세요."

    def _to_review(self, b, info, recovery_note: str | None = None) -> None:
        if b["method"] == STAGE2_METHOD:
            self._record_progress(b)   # the verified final checkpoint may be newer than the last producer poll
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
        self.store.delete(f"s2_safe_ff_{b['id']}")
        self.store.log(b["id"], f"PR #{info['number']} HEAD {info['head_sha'][:10]} 리뷰 대기")

    def _pr_protected_paths(self, b, info) -> set[str]:
        """Return this PR's exact output paths whose contents must not change in an Update branch merge."""
        try:
            files = self.gh.pull_files(info["number"])
            if not isinstance(files, list) or any(not isinstance(f, dict) or not isinstance(f.get("path"), str)
                                                  for f in files):
                raise FastForwardBlocked("PR 파일 목록을 확인할 수 없습니다")
            paths = {f["path"] for f in files}
            if b["method"] in stage1ab.METHODS or b["method"] in (literary.METHOD, dchunk.METHOD):
                claim = batches.expected_claim(b)
                found = batches.pr_claims(b, {"number": info["number"], "files": files})
                expected_path = (f"data/relation-candidates/{b['shard']}/"
                                 f"{b['shard']}_{b['batch']}_{b['method']}_{b['producer']}.jsonl")
                if found.count(claim) != 1 or any(item != claim for item in found) or expected_path not in paths:
                    raise FastForwardBlocked(f"PR #{info['number']}의 Candidate 파일 소유권이 배치와 일치하지 않습니다")
                return {expected_path}
            if b["method"] == STAGE2_METHOD:
                claim = batches.expected_claim(b)
                found = batches.pr_claims(b, {"number": info["number"], "files": files})
                if found.count(claim) != 1 or any(item != claim for item in found):
                    raise FastForwardBlocked(f"PR #{info['number']}의 Stage 2 산출물 소유권이 shard와 일치하지 않습니다")
                owned = {f"data/relations/relation-{b['shard']}.jsonl",
                         f"data/relation-drops/drop-{b['shard']}.jsonl"}
                protected = paths & owned
                if not protected:
                    raise FastForwardBlocked(f"PR #{info['number']}에 보호할 Stage 2 산출물이 없습니다")
                return protected
            if b["method"] == STAGE3_METHOD:
                claim = batches.expected_claim(b)
                found = batches.pr_claims(b, {"number": info["number"], "files": files})
                expected = [] if not files else [claim]
                if found != expected:
                    raise FastForwardBlocked(f"PR #{info['number']}의 Stage 3 산출물 소유권이 샤드와 일치하지 않습니다")
                try:
                    shard = stage3.validate_pr(info, files)
                except stage3.Stage3Error as error:
                    raise FastForwardBlocked(str(error)) from error
                if shard != b["shard"]:
                    raise FastForwardBlocked(f"PR #{info['number']}의 Stage 3 샤드가 배치와 일치하지 않습니다")
                return paths
            if b["method"] == MAINTENANCE_METHOD and paths:
                return paths
            raise FastForwardBlocked(f"Method {b['method']!r}의 보호 산출물을 증명할 수 없습니다")
        except batches.BatchError as e:
            raise FastForwardBlocked(str(e)) from e

    def _fast_forward_pr_head(self, b, info) -> str:
        """Apply the shared ownership, process, PR, remote, ancestry, artifact, and clean-worktree gates."""
        number, branch, wt = b["pr_number"], b["branch"], Path(b["worktree"])
        if number is None or info.get("number") != number:
            raise FastForwardBlocked("PR 번호가 batch 소유 PR과 일치하지 않습니다")
        if info.get("state") != "open" or info.get("merged"):
            raise FastForwardRace(f"PR #{number}가 동기화 중 open 상태에서 이동했습니다")
        if info.get("head_ref") != branch:
            raise FastForwardBlocked(f"PR #{number}의 head 브랜치가 소유 브랜치 {branch!r}와 다릅니다")
        target = info.get("head_sha")
        if not isinstance(target, str) or not re.fullmatch(r"[a-f0-9]{40}", target):
            raise FastForwardBlocked(f"PR #{number} HEAD가 유효한 commit SHA가 아닙니다")
        if b["pid"] is not None:
            raise FastForwardRace("AI 프로세스 종료가 확인되지 않아 worktree 동기화를 미룹니다")

        protected = self._pr_protected_paths(b, info)

        def recheck_pr() -> None:
            current = self.gh.pull(number)
            if current.get("number") != number or current.get("head_ref") != branch:
                raise FastForwardBlocked(f"PR #{number}의 repository 또는 소유 head 브랜치가 바뀌었습니다")
            if current.get("state") != "open" or current.get("merged"):
                raise FastForwardRace(f"PR #{number}가 동기화 중 open 상태에서 이동했습니다")
            if current.get("head_sha") != target:
                raise FastForwardRace(f"PR #{number} HEAD가 확인 중 이동했습니다 ({target} / {current.get('head_sha')})")

        old = self.git.head(wt)
        self.git.fast_forward_open_pr(wt, branch, target, protected, recheck=recheck_pr)
        if b["method"] == STAGE2_METHOD and b["state"] == "FIXING":
            key = f"s2_safe_ff_{b['id']}"
            try:
                prior = json.loads(self.store.get(key) or "")
            except (TypeError, ValueError):
                prior = {}
            start = prior.get("from") if prior.get("branch") == branch and prior.get("to") == old else old
            self.store.set(key, json.dumps({"branch": branch, "worktree": str(wt), "from": start, "to": target},
                                           sort_keys=True))
        self.store.log(b["id"], f"소유 PR #{number} 안전 fast-forward: {old} -> {target}")
        return old

    # ---- FIXING: is the fix really on the PR? ------------------------------
    def _check_fix_head(self, b, info) -> str:
        """Accept a fix only on the owned PR; safely follow an Update branch fast-forward before returning to review."""
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
        if info["state"] != "open":
            self.store.set(key, "")
            self._fail(b, "ERROR", f"PR #{info['number']}이 머지 없이 닫혔습니다 ({short}). worktree 보존, 수동 조치 필요.")
            return "stop"
        if info["head_ref"] != b["branch"]:
            self.store.set(key, "")
            self._fail(b, "ERROR", (f"PR #{info['number']}의 head 브랜치 {info['head_ref']!r}가 소유 브랜치 "
                                      f"{b['branch']!r}와 다릅니다 (잘못된 PR/브랜치). 보존."))
            return "stop"
        try:
            remote = self.git.remote_head(b["branch"])
            if remote is None:
                self.store.set(key, "")
                self._fail(b, "ERROR", f"원격 소유 브랜치 {b['branch']}가 없습니다. worktree·브랜치를 보존합니다.")
                return "stop"
            if remote == local:
                return self._head_lag_wait(
                    b, key, f"원격에는 local HEAD {local[:10]}이 있지만 PR API HEAD는 {info['head_sha'][:10]}입니다")
            if remote != info["head_sha"]:
                # A stale PR API can briefly trail an Update branch push. Re-read once before classifying
                # an unrelated origin SHA as divergence; only a PR now pointing at that exact SHA may sync.
                current = self.gh.pull(info["number"])
                if current.get("merged"):
                    self.store.set(key, "")
                    self.store.update(b["id"], state="MERGED", merged=1, head_sha=current["head_sha"], error=None)
                    self.store.log(b["id"], f"PR #{info['number']} merged=true 확인 중 HEAD 재조회 — 정리 단계에서 검증")
                    return "stop"
                if current.get("state") != "open":
                    self.store.set(key, "")
                    self._fail(b, "ERROR", f"PR #{info['number']}이 머지 없이 닫혔습니다. worktree 보존.")
                    return "stop"
                if current.get("number") != b["pr_number"] or current.get("head_ref") != b["branch"]:
                    self.store.set(key, "")
                    self._fail(b, "ERROR", f"PR #{info['number']}의 repository 또는 소유 head 브랜치가 바뀌었습니다. worktree 보존.")
                    return "stop"
                if current.get("head_sha") != remote:
                    self.store.set(key, "")
                    self._fail(b, "ERROR", (f"원격 ref와 PR HEAD 불일치: 원격 {remote[:10]} / 로컬 {local[:10]} "
                                              f"(PR HEAD {current.get('head_sha')}). worktree·브랜치를 보존합니다."))
                    return "stop"
                info.update(current)
            self._fast_forward_pr_head(b, info)
            latest = self.gh.pull(info["number"])
            if latest.get("number") != b["pr_number"] or latest.get("head_ref") != b["branch"]:
                self.store.set(key, "")
                self._fail(b, "ERROR", f"PR #{info['number']}의 repository 또는 소유 head 브랜치가 바뀌었습니다. worktree 보존.")
                return "stop"
            if latest.get("merged"):
                self.store.set(key, "")
                self.store.update(b["id"], state="MERGED", merged=1, head_sha=latest["head_sha"], error=None)
                self.store.log(b["id"], f"PR #{info['number']} fast-forward 중 merged=true 확인 — 정리 단계에서 검증")
                return "stop"
            if latest.get("state") != "open":
                self.store.set(key, "")
                self._fail(b, "ERROR", f"PR #{info['number']}이 fast-forward 중 머지 없이 닫혔습니다. worktree 보존.")
                return "stop"
            local = self.git.head(wt)
            remote = self.git.remote_head(b["branch"])
            if remote is None:
                self.store.set(key, "")
                self._fail(b, "ERROR", f"원격 소유 브랜치 {b['branch']}가 fast-forward 후 사라졌습니다. worktree 보존.")
                return "stop"
            if latest.get("head_sha") != local or remote != local:
                return self._head_lag_wait(
                    b, key, f"fast-forward 후 PR/원격 HEAD가 local HEAD와 다릅니다 "
                    f"({latest.get('head_sha')} / {remote} / {local})")
            info.update(latest)
        except TRANSIENT as e:
            return self._head_lag_wait(b, key, f"안전 fast-forward 확인 일시 실패({e}); {short}")
        except GitError as e:
            self.store.set(key, "")
            self._fail(b, "ERROR", f"안전 fast-forward 차단: {e}. worktree·브랜치를 보존합니다.")
            return "stop"
        except Exception as e:
            self.store.set(key, "")
            self._fail(b, "ERROR", f"안전 fast-forward 확인 실패: {e}. worktree·브랜치를 보존합니다.")
            return "stop"
        self.store.set(key, "")
        return "ok"

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
            if b["method"] == STAGE2_METHOD:
                if problem := self._stage2_fix_result_problem(b, info):
                    return self._fail(b, "ERROR", problem)
                self.store.delete(f"s2_fix_start_{b['id']}")
            elif b["method"] == STAGE3_METHOD:
                if problem := self._stage3_fix_completion_problem(b, info):
                    return self._fail(b, "ERROR", problem)
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
            if b["method"] in (STAGE2_METHOD, STAGE3_METHOD):   # one Stage 2/3 PR per shard: the Relation/Drop files collide
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
        if getattr(self._adapter(producer), "name", None) == "claude":
            return classify_claude_failure(log_file, text, self.cfg["quota_patterns"])
        if self._tiered(producer):
            if opencode_free_quota(log_file):
                return "free_quota"
            return classify_failure(text, [])
        return classify_failure(text, self.cfg["quota_patterns"])

    def _saved_output_failure(self, b, cls: str) -> bool:
        """Keep known authentication, quota, and run-pin failures blocking even when a chunk file exists."""
        if cls == "effort":
            self._fail(b, "ERROR", "CLI가 요청한 모델 또는 추론 수준을 받아들이지 않았습니다 — 다른 값으로 "
                       f"대체하지 않습니다. 로그 확인 후 설정을 고치세요: {b['log_file']}")
            return True
        messages = {
            "auth": "인증 실패 — Board 상단의 GitHub 인증 안내를 확인하세요.",
            "usage_limit": "CLI 사용량 한도에 도달했습니다 — 자동 전환·재시도 없이 중지합니다. 한도 해제 후 Retry.",
            "free_quota": "무료 한도 소진이 확인되었습니다 — 저장 증거가 있어도 자동 모델 전환 없이 중지합니다.",
        }
        if cls in messages:
            self._fail(b, "PAUSED", messages[cls])
            return True
        return False

    def _run_failed(self, b, code: int) -> None:
        cls = self._classify_run(b["producer"], b["log_file"])
        self.store.log(b["id"], f"AI 종료 코드 {code}, 분류={cls}", "warn")
        # A stored chunk can outlive an ordinary non-zero exit, but it never converts a known authentication,
        # quota, or run-pin failure into success.
        safe_to_accept_stored = cls not in ("effort", "auth", "usage_limit", "free_quota")
        if safe_to_accept_stored and self._stage3_chunk_run(b) and b["state"] == "PRODUCING":
            saved = self._stage3_chunk_saved(b)
            answer = self._stage3_answer_only(b)
            if saved or answer:
                reason = "checkpoint 저장" if saved else "완전한 현재 청크 D/L 응답"
                self.store.log(b["id"], f"AI가 비정상 종료했지만 {reason}을 확인해 Stage 3의 기존 검증·저장 경로로 전달합니다.", "warn")
                if problem := self._saved_chunk_identity_problem(b):
                    if cls == "session_missing":
                        self.store.log(b["id"], f"현재 Stage 3 응답의 세션 identity가 불충분합니다. 새 세션 재진입 안전성을 확인합니다: {problem[1]}", "warn")
                        if saved:
                            return self._fail(b, "PAUSED", f"저장 청크의 실행 세션을 확인할 수 없어 완료로 인정하지 않습니다. checkpoint와 worktree를 보존합니다: {problem[1]}")
                    else:
                        return self._fail(b, problem[0], f"현재 Stage 3 응답의 소유권/모델·effort/session 핀 확인 실패: {problem[1]}")
                else:
                    if not self._denials_cleared(b, Path(b["log_file"])):
                        return
                    return self._run_ok_stage3_chunk(b)
        if safe_to_accept_stored and self._s2_chunk_run(b) and b["state"] == "PRODUCING" and self._stage2_chunk_saved(b):
            self.store.log(b["id"], "AI가 비정상 종료했지만 현재 Stage 2 청크의 checkpoint 저장이 확인되어 재생산하지 않습니다.", "warn")
            if problem := self._saved_chunk_identity_problem(b):
                return self._fail(b, problem[0], f"저장 청크 실행의 소유권/핀 확인 실패: {problem[1]}")
            if not self._denials_cleared(b, Path(b["log_file"])):
                return
            return self._run_ok_stage2_chunk(b)
        s2_rows = self._stage2_response(b) if self._s2_chunk_run(b) and b["state"] == "PRODUCING" else None
        s2_format_problem = (self._stage2_format_problem(b) if s2_rows is None and self._s2_chunk_run(b)
                             and b["state"] == "PRODUCING" else None)
        if safe_to_accept_stored and self._s2_chunk_run(b) and b["state"] == "PRODUCING" \
                and (s2_rows is not None or s2_format_problem is not None):
            # A nonzero exit is not the verdict: a clearly attempted current-chunk answer, including a malformed one,
            # is routed through the existing answer/validator path after the normal identity and boundary checks.
            reason = "현재 청크 판정 응답" if s2_rows is not None else "현재 청크의 형식 오류 응답"
            self.store.log(b["id"], f"AI가 비정상 종료했지만 {reason}이 있어 기존 저장 검증 경로로 전달합니다.", "warn")
            if problem := self._saved_chunk_identity_problem(b):
                return self._fail(b, problem[0], f"현재 청크 응답의 소유권/핀 확인 실패: {problem[1]}")
            return self._run_ok_stage2_chunk(b)
        if safe_to_accept_stored and self._ab_chunk_run(b) and b["state"] == "PRODUCING" \
                and (self._ab_chunk_response(b) or self._ab_chunk_attempted(b)):
            # A nonzero exit may leave a malformed current block. Its exact BEGIN marker is enough to enter the existing
            # same-session correction path; absent or different chunk markers remain a missing response.
            self.store.log(b["id"], "AI가 비정상 종료했지만 현재 A/B 청크의 답변 시도 표식이 있어 기존 저장·정정 경로로 전달합니다.", "warn")
            if problem := self._saved_chunk_identity_problem(b):
                return self._fail(b, problem[0], f"현재 청크 응답의 소유권/핀 확인 실패: {problem[1]}")
            return self._run_ok_ab_chunk(b)
        if safe_to_accept_stored and self._c_chunk_run(b) and b["state"] == "PRODUCING" and self._c_chunk_saved(b):
            # The submit was stored (e.g. the CLI died or its answer was lost afterwards): never produce it again.
            self.store.log(b["id"], "AI가 비정상 종료했지만 활성 청크의 submit 저장이 확인되어 재생산하지 않습니다.", "warn")
            if problem := self._saved_chunk_identity_problem(b):
                return self._fail(b, problem[0], f"저장 청크 실행의 소유권/핀 확인 실패: {problem[1]}")
            if not self._denials_cleared(b, Path(b["log_file"])):
                return
            return self._run_ok_c_chunk(b)
        if safe_to_accept_stored and self._d_chunk_run(b) and b["state"] == "PRODUCING" and self._d_chunk_saved(b):
            # The save was stored (e.g. the CLI died or its answer was lost afterwards): never produce it again.
            self.store.log(b["id"], "AI가 비정상 종료했지만 활성 청크의 save 저장이 확인되어 재생산하지 않습니다.", "warn")
            if problem := self._saved_chunk_identity_problem(b):
                return self._fail(b, problem[0], f"저장 청크 실행의 소유권/핀 확인 실패: {problem[1]}")
            if not self._denials_cleared(b, Path(b["log_file"])):
                return
            return self._run_ok_d_chunk(b)
        if self._d_chunk_run(b) and b["state"] == "PRODUCING" and cls == "unknown" and not b["pr_number"] \
                and not self._d_chunk_saved(b):
            if problem := self._saved_chunk_identity_problem(b):
                return self._fail(b, problem[0], f"저장 거부를 만든 실행의 소유권/핀 확인 실패: {problem[1]}")
            if not self._denials_cleared(b, Path(b["log_file"])):
                return
            if self._d_fix(b):
                # The CLI left its own repairable rejection, and permission evidence is explicitly clear.
                return
        chunk_run = (b["method"] == STAGE2_METHOD and isinstance(b["run_kind"], str)
                     and (b["run_kind"].startswith("s2_chunk_") or b["run_kind"] == "s2_repair_new")) or self._c_chunk_run(b) or self._d_chunk_run(b) \
            or self._ab_chunk_run(b) or self._stage3_chunk_run(b)
        if b["state"] == "PRODUCING" and not b["pr_number"] and not chunk_run:
            if self._handoff_failed_pr(b, code, cls):
                return
        if cls == "effort":
            return self._fail(b, "ERROR", "CLI가 요청한 모델 또는 추론 수준을 받아들이지 않았습니다 — 다른 값으로 "
                              f"대체하지 않습니다. 로그 확인 후 설정을 고치세요: {b['log_file']}")
        if cls == "session_missing":
            if self._ab_chunk_run(b) and b["state"] == "PRODUCING":
                try:
                    raw = self.store.get(stage1ab.run_start_key(b["id"]))
                    baseline = json.loads(raw or "")
                    chunk_no = int(baseline["chunk_no"])
                    state = stage1ab.load_state(self.store, b["id"], chunk_no)
                    state["sid"] = None   # the recorded session is gone; the existing bounded save retry starts a new one
                    if state["requested"] is None:
                        state["problem"] = "이전 세션을 찾지 못해 완전한 청크 답변이 남지 않았습니다"
                    stage1ab.save_state(self.store, b["id"], chunk_no, state)
                except (stage1ab.ABChunkError, OSError, ValueError, KeyError, TypeError) as e:
                    return self._fail(b, "ERROR", f"A/B 청크 세션 복구 상태 확인 실패: {e}. 보존합니다.")
                self.store.update(b["id"], session_id=None)
                self.store.log(b["id"], "A/B 세션을 찾지 못했습니다. 기존 청크별 저장 정정 한도를 사용해 같은 청크를 새 세션으로 이어갑니다.", "warn")
                return self._run_ok_ab_chunk(self.store.batch(b["id"]))
            if b["state"] == "PRODUCING" and self._safe_fresh_chunk_after_missing_session(b):
                self.store.update(b["id"], session_id=None)   # same chunk's local evidence is sufficient for a fresh session
                b = self.store.batch(b["id"])
                if self._auto_retry_chunk(b, "기존 세션을 찾지 못함", fresh_session=True):
                    return
            return self._fail(b, "PAUSED", "세션 ID를 찾지 못했습니다 — 이 청크의 저장·검색 상태로 안전한 새 세션 재개가 증명되지 않거나 자동 재진입 한도를 소진했습니다. "
                              "worktree와 기록을 보존합니다. 원인 확인 후 Retry.")
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
            return self._fail(b, "PAUSED", "인증 실패 — Board 상단의 GitHub 인증 안내를 확인하세요.")
        if b["run_kind"] == "fix_resume":  # session resume impossible -> safe recovery once
            self.store.log(b["id"], "세션 resume 실패 → 새 AI 세션으로 복구", "warn")
            return self._launch(b, "fix_new", self._events(b)[1])
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
        # A Stage 2 PR is only accepted after its complete checkpoint verifies. The last producer poll may have
        # recorded an earlier candidate count, so reconcile that persisted snapshot while the verified PR waits.
        if b["method"] == STAGE2_METHOD and (
                b["progress_kind"] != "candidates" or b["progress_done"] != b["progress_total"]):
            self._record_progress(b)
            b = self.store.batch(b["id"])
        last = float(self.store.get(f"last_poll_{b['id']}", "0"))
        if self.clock() - last < self.cfg["poll_seconds"]:
            return
        self.store.set(f"last_poll_{b['id']}", str(self.clock()))
        try:
            synced = False
            while True:
                info, evs = self._events(b)
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
                try:
                    local = self.git.head(Path(b["worktree"]))
                except Exception as e:
                    return self._fail(b, "ERROR", f"소유 worktree HEAD를 확인할 수 없습니다: {e}. 보존.")
                if local != info["head_sha"]:
                    if synced:
                        self._transient_wait(f"b{b['id']}:branch_sync", "FF 중 PR HEAD가 다시 이동", b["id"])
                        return
                    try:
                        self._fast_forward_pr_head(b, info)
                    except TRANSIENT as e:
                        return self._transient_wait(f"b{b['id']}:branch_sync", e, b["id"])
                    except GitError as e:
                        return self._fail(b, "ERROR", f"안전 fast-forward 차단: {e}. worktree·브랜치를 보존합니다.")
                    except Exception as e:
                        return self._fail(b, "ERROR", f"안전 fast-forward 확인 실패: {e}. worktree·브랜치를 보존합니다.")
                    self._transient_clear(f"b{b['id']}:branch_sync", b["id"])
                    synced = True
                    continue   # re-read PR HEAD and review events after the FF; never act on a stale snapshot
                self._transient_clear(f"b{b['id']}:branch_sync", b["id"])
                if b["method"] in ("a", "b", "c", "d", STAGE3_METHOD) and not live:
                    # Older versions marked an event handled when the fix process STARTED, not when the
                    # reply was confirmed. A safe Update branch can return that failed run to REVIEW.
                    # Likewise, a stranded CLAIMED event must not launch again without operator Retry.
                    stranded = []
                    for event in evs:
                        row = self.store.handled_event(b["id"], b["pr_number"], info["head_sha"], event["key"])
                        if row is not None and row["status"] in ("LEGACY", "CLAIMED"):
                            stranded.append(f"{event['key']}({row['status']})")
                    if stranded:
                        return self._fail(
                            b, "ERROR", "미완료 리뷰 이벤트 감지: " + ", ".join(stranded) +
                            ". 이전 수정 실행의 완료·PR 답글 증거가 확정되지 않았습니다. "
                            "자동 재실행하지 않고 보존했습니다. 운영자 Retry에서 현재 PR/HEAD와 답글을 "
                            "재확인하여 미완료 이벤트만 복구합니다.")
                if fresh:
                    self.store.log(b["id"], f"새 리뷰 이벤트 {len(fresh)}건 → 수정 실행")
                    self._launch(b, self._fix_kind(b), fresh)
                return
        except TRANSIENT as e:
            return self._transient_wait(f"b{b['id']}:watch", e, b["id"])
        except Exception as e:
            return self.store.log(b["id"], f"GitHub 폴링 실패(재시도 예정): {e}", "warn")

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
            if b["method"] == STAGE3_METHOD:
                try:
                    if stage3.validate_pr(info, self.gh.pull_files(b["pr_number"])) != b["shard"]:
                        return self._fail(b, "ERROR", "머지 Stage 3 PR 파일 범위가 소유 샤드와 다릅니다. worktree를 보존합니다.")
                except stage3.Stage3Error as error:
                    return self._fail(b, "ERROR", f"머지 Stage 3 PR 범위 검증 실패: {error}. worktree를 보존합니다.")
                if not self._stage3_merged_verify(b, info):
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
        self.store.complete_batch(b["id"])
        self._clear_batch_retry(b["id"])
        self.store.delete(f"pr_create_{b['id']}")
        self.store.delete(f"cleanup_proof_{b['id']}")
        self.store.delete(f"stop_after_pr_{b['id']}")
        if b["method"] == STAGE2_METHOD:
            self.store.delete(stage2.run_start_key(b["id"]))
            self.store.delete(f"s2_reconcile_commit_{b['id']}")
            self.store.delete(f"s2_stage3_change_point_{b['id']}")
            self.store.delete(f"s2_stage3_change_point_{b['id']}")
        if b["method"] == STAGE3_METHOD:
            self.store.delete(stage3.run_start_key(b["id"]))
            self.store.delete(f"s3_apply_ready_{b['id']}")
            self.store.delete(f"s3_apply_result_{b['id']}")
            self.store.delete(f"s3_commit_head_{b['id']}")
            self.store.delete(f"s3_merge_wait_{b['id']}")
        self.store.finish_runs(b["id"], None)
        self.store.log(b["id"], f"배치 {b['shard']}_{b['batch']} 정리 완료")

    def _stage2_merged_verify(self, b, info) -> bool:
        """A merged Part counts only after its exact verify succeeds on the latest master, BEFORE its worktree is removed
        and before the next Part may start. False: waiting (merge commit not on master yet / GitHub or git trouble) or
        stopped in ERROR (verify failed); the worktree, PR and session stay and Retry re-verifies without any AI run."""
        bb, pp = stage2.split_key(b["batch"])
        ok_key, gate = stage2.ok_key(b["shard"], bb, pp), f"s2_merge_wait_{b['id']}"
        is_reconciliation = self._stage2_reconcile_task(b) is not None
        if self.store.get(ok_key) and not is_reconciliation:
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
        self.store.log(b["id"], f"최신 master {sha[:10]}에서 {stage2.label(b['shard'], b['batch'])} "
                       f"{'reconciliation ' if is_reconciliation else ''}verify 통과")
        return True

    def _stage3_merged_verify(self, b, info) -> bool:
        """Count a Stage 3 shard complete only after its merged files verify on the current master."""
        gate = f"s3_merge_wait_{b['id']}"
        if self.clock() - float(self.store.get(gate, "0")) < self.cfg["poll_seconds"]:
            return False
        self.store.set(gate, str(self.clock()))
        base = self.cfg["base_branch"]
        try:
            sha = self.git.fetch_base(base)
            merge_sha = info.get("merge_commit_sha")
            if not isinstance(merge_sha, str) or not re.fullmatch(r"[a-f0-9]{40}", merge_sha):
                self._fail(b, "ERROR", "Stage 3 PR merge commit SHA를 확인할 수 없어 완료 처리하지 않습니다.")
                return False
            if not self.git.contains_on_base(merge_sha, base):
                self.store.log(b["id"], f"머지 커밋 {merge_sha[:10]}이 아직 origin/{base}에 보이지 않습니다 — 재확인 예정", "warn")
                return False
            if self.store.get(stage3.ok_key(b["shard"])) == sha:
                return True
            ok, detail = self.git.verify_stage2(sha, "shard", b["shard"], None, None)
        except TRANSIENT as error:
            self._transient_wait(gate, error, b["id"])
            return False
        except Exception as error:
            self.store.log(b["id"], f"머지 후 Stage 3 shard verify 준비 실패(재시도 예정): {error}", "warn")
            return False
        if not ok:
            self._fail(b, "ERROR", f"PR #{info['number']} 머지 후 최신 master에서 샤드 {b['shard']} verify 실패: "
                       f"{detail}. worktree를 보존하고 확인 후 Retry 하세요.")
            self.store.set(gate, "0")
            return False
        self.store.set(stage3.ok_key(b["shard"]), sha)
        self.store.log(b["id"], f"최신 master {sha[:10]}에서 Stage 3 샤드 {b['shard']} verify 통과")
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
