"""Parallel Stage 3 chunk judgment (Issue #3149, PR 2): dynamic chunk-task scheduler with a single-writer save.

A *new* shard (`s3_mode_<batch>` = "parallel") judges its prepared `edit-cli` chunks as independent answer-only
sessions, up to `stage3_max_parallel` at once. The batch stays PRODUCING with `run_kind="s3_parallel"` and `pid=None`;
the real executions are task runs (`runs.task`, `s2_tasks`). Each tick, in this fixed order:

1. apply a Maintainer release (invalidated tasks) and restore tasks whose chunk the checkpoint already holds,
2. re-attach open runs that lost their task link, then follow RUNNING tasks to their end and preserve each answer
   (`.warroom-scratch/s3-tasks/NNN/decisions.txt`),
3. save preserved answers one at a time with `save-chunk --chunk NNN --expect-view-sha256` (the Supervisor is the only
   writer; completion order never changes the final data),
4. a FAILED task blocks every new assignment (running ones are still followed and saved), then halts to ERROR,
5. once every chunk is SAVED and the checkpoint is complete, persist `closed` and hand over to the existing finalize,
6. fill free slots (`stage3_max_parallel - slots in use`, a slot being free only when its run's end is confirmed).

Task states: PENDING, RUNNING, RESPONDED (answer preserved, save pending), SAVED, FAILED. Stage 3 has no same-session
correction loop: a missing answer gets exactly one new session; a strict save rejection never calls the AI again.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import prompts, stage3, taskruns
from .gitops import GitError, GitTransient
from .launch_gate import LaunchDenied, task_launch_scope
from .github import GhTransient
from .stage3 import Stage3Error
from .store import STAGE3_METHOD

RUN_KIND = "s3_parallel"
RUN_RECORD_KIND = "s3_chunk_new"
TRANSIENT = (GhTransient, GitTransient)
_ERRORS = (GitError, Stage3Error, OSError, ValueError, KeyError, TypeError)
HARD = ("auth", "usage_limit", "free_quota", "effort", "fast_unavailable")
MAX_SAVE_FAILURES = 2


def is_parallel(store, b) -> bool:
    return b["method"] == STAGE3_METHOD and store.get(stage3.mode_key(b["id"])) == stage3.PARALLEL


def plan_state(store, b) -> str | None:
    return store.get(stage3.plan_key(b["id"])) if is_parallel(store, b) else None


def _data(row) -> dict:
    try:
        data = json.loads(row["data"] or "{}")
    except ValueError:
        data = {}
    return data if isinstance(data, dict) else {}


def complete_response(answer, task: str) -> str | None:
    """The answer when it has the exact chunk header AND a body; None for no answer, no header or a header only.

    The serial normalizer turns a header-only answer into `none` (kept for the serial path); a parallel task never
    does: only an explicit `chunk NNN` + `none` is Keep-all."""
    if not isinstance(answer, str):
        return None
    lines = [line.strip() for line in answer.strip().splitlines() if line.strip()]
    return answer if len(lines) >= 2 and lines[0] == f"chunk {task}" else None


class _Round:
    """The remote/PR/preflight lookups of ONE processing round, made lazily once (a plain wait tick never asks)."""

    def __init__(self, s3p, b):
        self.s3p, self.b = s3p, b
        self._remote = self._pr = self._preflight = self._unset = object()
        self.boundary = None

    def remote(self):
        if self._remote is self._unset:
            self._remote = self.s3p.sup.git.remote_head(self.b["branch"])
        return self._remote

    def pr(self):
        if self._pr is self._unset:
            self._pr = self.s3p.sup._find_recovery_pr(self.b)
        return self._pr

    def preflight(self):
        if self._preflight is self._unset:
            self._preflight = self.s3p.sup._preflight(self.b["producer"], self.b["method"])
        return self._preflight


class ParallelStage3:
    def __init__(self, sup):
        self.sup = sup

    # ---- accessors -----------------------------------------------------------------------------------------------
    @property
    def store(self):
        return self.sup.store

    @property
    def cfg(self):
        return self.sup.cfg

    def _wt(self, b) -> Path:
        return Path(b["worktree"])

    def _adapter(self, b):
        return self.sup._adapter(b["producer"])

    def _env(self, b) -> dict:
        return self.sup._launch_env(b, RUN_RECORD_KIND, self.sup._agent_env())

    def _set(self, b, task: str, data: dict | None = None, **fields) -> None:
        if data is not None:
            fields["data"] = json.dumps(data, ensure_ascii=False, sort_keys=True)
        self.store.update_task(b["id"], task, **fields)

    def _decisions(self, b, task: str) -> Path:
        return self._wt(b) / stage3.task_path(task, "decisions.txt")

    def _baseline(self, b) -> dict | None:
        try:
            value = json.loads(self.store.get(stage3.parallel_start_key(b["id"])) or "null")
        except ValueError:
            return None
        return value if isinstance(value, dict) else None

    def workers_alive(self, b) -> bool:
        return taskruns.workers_alive(self.store, self._adapter(b), b["id"])

    def stop_workers(self, b, acknowledge: bool = False) -> bool:
        """Ask every live task process to stop; True once all are confirmed gone and their runs closed.

        A run that had exited 0 keeps its status so the next poll still reads its answer. Any other stopped run returns
        its task to PENDING (a new session); preserved answers, budgets and SAVED tasks are untouched. Only the
        operator's own Stop (`acknowledge`) acknowledges FAILED tasks."""
        if acknowledge:
            for row in self.store.task_rows(b["id"]):
                data = _data(row)
                if row["state"] == "FAILED" and not data.get("ack"):
                    self._set(b, row["task"], data | {"ack": True})

        def returned(run):
            row = self.store.task_row(b["id"], run["task"])
            if row is not None and row["state"] == "RUNNING" and row["run_id"] == run["id"]:
                self._set(b, row["task"], _data(row), state="PENDING", run_id=None, session_id=None)
        return taskruns.stop_open_runs(self.store, self._adapter(b), b["id"], returned)

    # ---- shard start ----------------------------------------------------------------------------------------------
    def begin(self, b) -> None:
        """Own worktree -> parallel Git baseline (once) -> prepare (once) -> register tasks. Every step is idempotent."""
        wt = self._wt(b)
        try:
            if self.sup.git.registered(wt) != b["branch"]:
                return self.sup._fail(b, "ERROR", f"worktree가 있지만 소유 확인 불가: {wt}")
            head, remote = self.sup.git.head(wt), self.sup.git.remote_head(b["branch"])
            env = self._env(b)
            state = stage3.checkpoint(wt, b["shard"])
            if state is None:
                state = stage3.prepare(self.sup.runner, env, wt, b["shard"])
        except TRANSIENT:
            raise
        except _ERRORS as error:
            return self.sup._fail(b, "ERROR", f"Stage 3 병렬 청크 계획 준비 실패: {error}. worktree를 보존합니다.")
        if self.store.get(stage3.parallel_start_key(b["id"])) is None:   # not the serial s3_run_start baseline
            self.store.set(stage3.parallel_start_key(b["id"]), json.dumps(
                {"branch": b["branch"], "worktree": str(b["worktree"]), "head": head, "remote_head": remote,
                 "invalidated": []}, sort_keys=True))
        total = state["chunk_total"]
        self.store.add_tasks(b["id"], [(f"{n:03d}", f"{n:03d}") for n in range(1, total + 1)])
        self.store.update(b["id"], state="PRODUCING", run_kind=RUN_KIND, pid=None, session_id=None, retries=0,
                          retry_after=None, error=None, progress_kind="chunks", progress_done=len(state["completed_chunks"]),
                          progress_total=total)
        if total == 0:
            self.store.set(stage3.plan_key(b["id"]), "closed")
            return self.continue_after_close(self.store.batch(b["id"]))
        self.store.set(stage3.plan_key(b["id"]), "open")
        self.store.log(b["id"], f"Stage 3 병렬 청크 계획: {total}개 청크 · 동시 상한 {self.cfg['stage3_max_parallel']}")
        self.poll(self.store.batch(b["id"]))

    # ---- one scheduling tick ----------------------------------------------------------------------------------------
    def poll(self, b) -> None:
        try:
            self._poll(b)
        except TRANSIENT as error:
            self.sup._transient_wait(f"b{b['id']}:s3_parallel", error, b["id"])

    def _poll(self, b) -> None:
        self.sup.maint.adopt_released_baseline(b)   # a crash between a Maintainer release and its baseline write
        b = self.store.batch(b["id"])
        self.sup._record_progress(b)
        if self.store.get(stage3.plan_key(b["id"])) == "closed":
            return self.continue_after_close(b)
        try:
            state = stage3.checkpoint(self._wt(b), b["shard"])
        except Stage3Error as error:
            return self.sup._fail(b, "ERROR", f"{error}. worktree를 보존합니다.")
        if state is None:
            return self.begin(b)
        if state["chunk_total"] == 0:   # a restart between the batch update and the plan write of a zero-chunk shard
            self.store.set(stage3.plan_key(b["id"]), "closed")
            return self.continue_after_close(b)
        self.store.add_tasks(b["id"], [(f"{n:03d}", f"{n:03d}") for n in range(1, state["chunk_total"] + 1)])
        round_ = _Round(self, b)
        self._restore_saved(b, state)
        self._apply_invalidated(b, state)
        self._adopt(b)
        self._reset_acknowledged_failures(b, round_)
        for row in self.store.task_rows(b["id"]):
            if row["state"] == "RUNNING":
                self._poll_task(b, row, round_)
        for row in self.store.task_rows(b["id"]):
            if row["state"] == "RESPONDED":
                if self._halted_by_boundary(b, round_):
                    break
                self._save_task(b, self.store.task_row(b["id"], row["task"]), round_)
        b = self.store.batch(b["id"])
        if b["state"] != "PRODUCING":
            return
        rows = {r["task"]: r for r in self.store.task_rows(b["id"])}
        failed = [r for r in rows.values() if r["state"] == "FAILED"]
        if failed:   # before any slot is refilled: nothing new starts, running tasks are still followed and saved
            if not any(r["state"] in ("RUNNING", "RESPONDED") for r in rows.values()) \
                    and not taskruns.open_runs(self.store, b["id"]):
                return self._halt(b, failed)
            return
        if self._all_saved(b, rows):
            return self._finish(b)
        self._fill_slots(b, rows, round_)

    def _all_saved(self, b, rows) -> bool:
        if not rows or any(r["state"] != "SAVED" for r in rows.values()) or taskruns.open_runs(self.store, b["id"]):
            return False
        try:
            state = stage3.checkpoint(self._wt(b), b["shard"])
        except Stage3Error:
            return False
        return state is not None and sorted(state["completed_chunks"]) == sorted(rows)

    # ---- Git boundary ---------------------------------------------------------------------------------------------------
    def _halted_by_boundary(self, b, round_: _Round) -> bool:
        problem = self._boundary_problem(b, round_)
        if problem:
            self.sup._fail(b, "ERROR", problem)
            return True
        return False

    def _boundary_problem(self, b, round_: _Round) -> str | None:
        """Cheap local ownership checks every time; remote ref and PR lookups once per processing round."""
        base = self._baseline(b)
        try:
            if base is None or base.get("branch") != b["branch"] or base.get("worktree") != str(b["worktree"]):
                return "Stage 3 병렬 Git 경계 기준이 없거나 다른 실행을 가리킵니다. worktree를 보존합니다."
            wt = self._wt(b)
            if self.sup.git.registered(wt) != b["branch"]:
                return f"Stage 3 병렬 worktree가 소유 브랜치 {b['branch']}에 있지 않습니다. 후속 실행을 중단합니다."
            head = self.sup.git.head(wt)
            if head != base.get("head"):
                return f"Stage 3 병렬 실행 중 소유 HEAD가 변경됐습니다 ({base.get('head')} / {head}). 후속 실행을 중단합니다."
            tracked = [line for line in self.sup.git.dirty(wt).splitlines() if line and not line.startswith("??")]
            if tracked:
                return "Stage 3 병렬 실행 중 추적 파일이 수정됐습니다. 후속 실행을 중단하고 보존합니다."
            if round_.remote() != base.get("remote_head"):
                return (f"Stage 3 병렬 실행 중 원격 브랜치 {b['branch']}가 변경됐습니다 "
                        f"({base.get('remote_head')} / {round_.remote()}). 후속 실행을 중단합니다.")
            info = round_.pr()
            if info is not None:
                return f"병렬 Stage 3 실행 중 소유 브랜치에 예상하지 않은 PR #{info['number']}이 있습니다. PR과 worktree를 보존합니다."
        except TRANSIENT:
            raise
        except Exception as error:   # RecoveryBlocked, GitError, ...
            return f"Stage 3 병렬 Git/PR 경계를 확인하지 못했습니다: {error}. worktree를 보존합니다."
        return None

    # ---- Maintainer release, saved-chunk restore, orphan runs ------------------------------------------------------------
    def _restore_saved(self, b, state) -> None:
        """A chunk the checkpoint already holds whose task is not SAVED (a crash between save and the task update):
        confirm it with the preserved answer (`already_saved`) and mark SAVED. The AI is never called."""
        done = set(state["completed_chunks"])
        busy = {r["task"] for r in taskruns.open_runs(self.store, b["id"])}
        for row in self.store.task_rows(b["id"]):
            task = row["task"]
            if row["state"] == "SAVED" or task not in done or task in busy:
                continue
            data = _data(row)
            rel = stage3.task_path(task, "decisions.txt")
            if not (self._wt(b) / rel).exists() or not row["view_sha256"]:
                self._task_failed(b, row, data, f"[{task}] checkpoint에는 완료됐지만 보존된 응답 또는 view 증거가 없어 SAVED로 복원할 수 없습니다",
                                  "ownership")
                continue
            try:
                result = stage3.save_chunk_by_number(self.sup.runner, self._env(b), self._wt(b), b["shard"], task, rel,
                                                     row["view_sha256"])
            except Stage3Error as error:
                self._task_failed(b, row, data, f"[{task}] 완료 청크의 저장 응답을 확인하지 못했습니다: {error}", "ownership")
                continue
            if result.get("already_saved") is not True:
                self._task_failed(b, row, data, f"[{task}] 완료 청크의 응답 확인이 already_saved가 아닙니다", "ownership")
                continue
            self._set(b, task, data, state="SAVED")
            self.store.log(b["id"], f"[{task}] checkpoint 완료 청크를 보존된 응답으로 확인해 SAVED로 복원했습니다 (AI 호출 없음)")

    def _apply_invalidated(self, b, state) -> None:
        """Tasks whose pending view the Maintainer's integration changed: keep the old answer aside, re-run fresh."""
        base = self._baseline(b)
        pending = (base or {}).get("invalidated") or []
        if not pending:
            return
        done = set(state["completed_chunks"])
        busy = {r["task"] for r in taskruns.open_runs(self.store, b["id"])}
        remaining = []
        for task in pending:
            row = self.store.task_row(b["id"], task)
            if row is None or row["state"] == "SAVED" or task in done:
                continue
            if task in busy:
                remaining.append(task)
                continue
            data = _data(row)
            old = row["view_sha256"] or "none"
            answer = self._decisions(b, task)
            if answer.exists():
                answer.replace(answer.with_name(f"superseded-{old}.txt"))
            data.setdefault("superseded", []).append({"view_sha256": old, "run_id": row["run_id"]})
            for key in ("response", "save_failures", "failure_kind", "error", "ack"):
                data.pop(key, None)
            self._set(b, task, data, state="PENDING", run_id=None, session_id=None, view_sha256=None)
            self.store.log(b["id"], f"[{task}] 승인된 통합으로 view가 바뀌어 이전 응답을 superseded로 보존하고 새 세션으로 다시 판정합니다", "warn")
        base["invalidated"] = remaining
        self.store.set(stage3.parallel_start_key(b["id"]), json.dumps(base, sort_keys=True))

    def _adopt(self, b) -> None:
        """An open run whose task link was not written (crash right after the run was recorded) is re-attached; a run
        whose owner is unclear keeps its slot and is only preserved."""
        for run in taskruns.open_runs(self.store, b["id"]):
            row = self.store.task_row(b["id"], run["task"])
            if row is not None and row["state"] == "RUNNING" and row["run_id"] == run["id"]:
                continue
            if row is not None and row["state"] == "PENDING" and row["run_id"] is None and row["view_sha256"]:
                self._set(b, row["task"], _data(row), state="RUNNING", run_id=run["id"], session_id=run["session_id"],
                          attempts=row["attempts"] + 1)
                self.store.log(b["id"], f"[{row['task']}] task 링크가 없던 실행 중 run을 다시 연결했습니다")
            else:
                key = f"s3_orphan_run_{run['id']}"
                if self.store.get(key) is None:
                    self.store.set(key, "1")
                    self.store.log(b["id"], f"run #{run['id']}의 task 소유가 불명확해 슬롯을 점유한 채 보존·차단합니다", "warn")

    # ---- task run results -------------------------------------------------------------------------------------------------
    def _poll_task(self, b, row, round_: _Round) -> None:
        ad, task = self._adapter(b), row["task"]
        run = self.store.run(row["run_id"]) if row["run_id"] is not None else None
        data = _data(row)
        if run is None:
            return self._task_failed(b, row, data, f"[{task}] task 실행 기록(run)이 없습니다", "ownership")
        log = Path(run["log_file"])
        seen = taskruns.observe_run(self.store, ad, run, row["session_id"])
        if seen[0] == "wait":
            if seen[1] and seen[1] != row["session_id"]:
                self._set(b, task, session_id=seen[1])
            return
        if seen[0] == "problem":
            return self._task_failed(b, row, data, f"[{task}] {seen[1]}", "hard")
        code, run = seen[1], seen[2]
        if run["session_id"] and run["session_id"] != row["session_id"]:
            self._set(b, task, session_id=run["session_id"])
            row = self.store.task_row(b["id"], task)
        if code is None:
            return self._task_failed(b, row, data, f"[{task}] AI 프로세스가 종료 상태 기록 없이 사라졌습니다. 응답·세션을 보존합니다.", "run_failed")
        if code != 0:
            return self._run_failed(b, row, data, run, code)
        sid = row["session_id"] or ad.session_id(log)
        recorded = taskruns.recorded_spec(run)
        problem = ad.completion_problem(log, recorded, sid, b["worktree"], self.sup.env)
        if problem and not ad.completion_incomplete(log, recorded, sid, b["worktree"], self.sup.env):
            return self._task_failed(b, row, data, f"[{task}] {problem[1]}", "hard")
        self._accept_answer(b, row, data, run)

    def _run_failed(self, b, row, data, run, code: int) -> None:
        task = row["task"]
        cls = self.sup._classify_run(b["producer"], run["log_file"])
        self.store.log(b["id"], f"[{task}] AI 종료 코드 {code}, 분류={cls}", "warn")
        hard = cls in HARD
        if not hard:   # a complete current answer with a proven run identity survives an ordinary non-zero exit
            ad, log = self._adapter(b), Path(run["log_file"])
            sid = run["session_id"] or ad.session_id(log)
            if complete_response(ad.final_answer(log), task) is not None \
                    and ad.output_identity_problem(log, taskruns.recorded_spec(run), sid, b["worktree"], self.sup.env) is None:
                self.store.log(b["id"], f"[{task}] 비정상 종료지만 현재 청크의 완전한 응답과 실행 identity를 확인해 저장 경로로 진행합니다", "warn")
                return self._accept_answer(b, row, data, run)
        if hard:
            message = (self.sup._fast_unavailable_message(run["log_file"]) if cls == "fast_unavailable" else
                       f"AI 실행이 {cls}로 실패했습니다 — 자동 전환·재시도 없이 중지합니다.")
            if cls == "usage_limit":
                data["pause"] = True   # a plan limit is not a defect: PAUSED for the owner's Retry, never a Maintainer incident
            return self._task_failed(b, row, data, f"[{task}] {message}", "hard")
        if cls not in ("rate_limit", "network"):
            return self._task_failed(b, row, data, f"[{task}] AI 실행 실패(코드 {code}, {cls}) — 자동 재시도 없이 보존합니다.", "run_failed")
        retries = data.get("transient_retries", 0)
        if retries < self.cfg["rate_limit_retries"]:   # this task's own transient budget
            data["transient_retries"] = retries + 1
            data["retry_after"] = self.sup.clock() + self.sup._transient_gap(retries + 1)
            self._set(b, task, data, state="PENDING", run_id=None, session_id=None)
            return self.store.log(b["id"], f"[{task}] 일시 실패 — 이 task만 {retries + 1}번째 재시도 예약", "warn")
        self._task_failed(b, row, data, f"[{task}] AI 실행 실패(코드 {code}, {cls}) 재시도 한도 초과", "transient")

    def _accept_answer(self, b, row, data, run) -> None:
        task, ad = row["task"], self._adapter(b)
        final = ad.final_answer(Path(run["log_file"]))
        if complete_response(final, task) is None:   # no answer / no header / header only: never an implicit `none`
            return self._missing_answer(b, row, data, "현재 청크 헤더와 판정 본문이 있는 응답이 없습니다.")
        try:
            view, _prompt, sha, _completed = stage3.read_chunk_by_number(self.sup.runner, self._env(b), self._wt(b), b["shard"], task)
            if sha != row["view_sha256"]:
                return self._task_failed(b, row, data, f"[{task}] 실행 중 청크 view가 바뀌어 응답을 저장하지 않습니다 (응답 보존)", "input_changed")
            normalized, warnings = stage3.normalize_decisions(final, task, stage3.decision_context(view, task))
        except Stage3Error as error:
            return self._task_failed(b, row, data, f"[{task}] 응답을 정규화하지 못했습니다: {error}", "no_response")
        body = [line.strip() for line in final.strip().splitlines() if line.strip()][1:]
        if normalized == f"chunk {task}\nnone\n" and body != ["none"]:   # prose or only-invalid proposals: not an explicit Keep-all
            return self._missing_answer(b, row, data, "유효한 D/L 제안이나 명시적 `none`이 없는 응답입니다.")
        if warnings:
            self.store.log(b["id"], f"[{task}] 판정 정규화: {'; '.join(warnings)}", "warn")
        path = self._decisions(b, task)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(normalized, "utf-8")
        tmp.replace(path)   # the preserved answer: a restart saves it without the AI
        data["response"] = {"run_id": run["id"], "session_id": run["session_id"], "model": run["model"],
                            "effort": run["effort"], "sha256": hashlib.sha256(normalized.encode("utf-8")).hexdigest(),
                            "view_sha256": sha}
        data.pop("failure_kind", None)
        self._set(b, task, data, state="RESPONDED")

    def _missing_answer(self, b, row, data, why: str) -> None:
        task = row["task"]
        if data.get("fresh_retries", 0) < 1:
            data["fresh_retries"] = 1
            self._set(b, task, data, state="PENDING", run_id=None, session_id=None)
            return self.store.log(b["id"], f"[{task}] 응답 누락 — 이 task만 새 세션으로 1회 재실행합니다 ({why})", "warn")
        self._task_failed(b, row, data, f"[{task}] {why} 기록을 보존합니다.", "no_response")

    # ---- saving ---------------------------------------------------------------------------------------------------------------
    def _save_task(self, b, row, round_: _Round) -> None:
        task, data = row["task"], _data(row)
        rel = stage3.task_path(task, "decisions.txt")
        try:
            result = stage3.save_chunk_by_number(self.sup.runner, self._env(b), self._wt(b), b["shard"], task, rel,
                                                 row["view_sha256"])
            state = stage3.checkpoint(self._wt(b), b["shard"])
        except TRANSIENT:
            raise
        except Stage3Error as error:
            detail = str(error)
            if "view changed since it was launched" in detail:
                return self._task_failed(b, row, data, f"[{task}] 실행 시 입력 view가 바뀌어 저장하지 않았습니다. 응답을 보존합니다: {detail[:300]}", "input_changed")
            if "already saved with different decisions" in detail or "outside 001" in detail:
                return self._task_failed(b, row, data, f"[{task}] 이미 다른 판정이 저장돼 있어 덮어쓰지 않습니다: {detail[:300]}", "ownership")
            data["save_failures"] = data.get("save_failures", 0) + 1   # a real strict rejection: never retried by the AI
            self.store.log(b["id"], f"[{task}] 저장 거부: {detail[:300]}", "warn")
            return self._task_failed(b, row, data, f"[{task}] 저장이 거부됐습니다(AI 재호출 없음): {detail[:500]}", "save_rejected")
        except (OSError, ValueError) as error:
            return self._task_failed(b, row, data, f"[{task}] 판정 저장 처리 실패: {error}. 응답을 보존합니다.", "run_failed")
        if state is None or task not in state["completed_chunks"]:
            return self._task_failed(b, row, data, f"[{task}] 저장 결과가 checkpoint에 반영되지 않았습니다", "ownership")
        self._set(b, task, data, state="SAVED")
        self.store.log(b["id"], f"[{task}] 판정이 save-chunk --chunk를 통과해 저장됐습니다" + (" (already_saved)" if result.get("already_saved") else ""))

    def _reconcile_submit_failures(self, b, row, data) -> None:
        """Count a real rejection on the answer's own run exactly once, however often the Supervisor restarted."""
        want, response = data.get("save_failures", 0), data.get("response") or {}
        run_id = response.get("run_id")
        if not want or run_id is None:
            return
        run = self.store.run(run_id)
        have = (run["submit_failures"] or 0) if run is not None else want
        for _ in range(max(0, want - have)):
            self.store.add_submit_failure(b["id"], run_id)

    # ---- slots ----------------------------------------------------------------------------------------------------------------------
    def _fill_slots(self, b, rows, round_: _Round) -> None:
        free = self.cfg["stage3_max_parallel"] - taskruns.slots_used(self.store, b["id"])
        if free <= 0:
            return
        now = self.sup.clock()
        busy = {r["task"] for r in taskruns.open_runs(self.store, b["id"])}
        due = [r for r in sorted(rows.values(), key=lambda r: r["task"])
               if r["state"] == "PENDING" and r["task"] not in busy and _data(r).get("retry_after", 0) <= now]
        retried = lambda r: bool(_data(r).get("fresh_retries") or _data(r).get("transient_retries") or _data(r).get("superseded"))
        queue = [r for r in due if retried(r)] + [r for r in due if not retried(r)]
        if not queue:
            return
        self._start_queued(b, round_, queue, free)

    def _start_allowed(self, b, round_: _Round) -> bool:
        if round_.boundary is None:   # proved once per round, only when something is about to start
            round_.boundary = not self._halted_by_boundary(b, round_)
        if not round_.boundary:
            return False
        problem = round_.preflight()
        if problem:
            from .adapters import PREFLIGHT_PENDING
            if not problem.startswith(PREFLIGHT_PENDING):   # else still proving the pin; the next tick retries
                self.sup._fail(b, "ERROR", f"실행 전 확인 실패: {problem}")
            return False
        return True

    def _start_queued(self, b, round_: _Round, queue, free) -> None:
        checked = False
        for row in queue[:free]:
            if self.store.batch(b["id"])["state"] != "PRODUCING":
                return
            with self.sup.launch_gate.unit():   # one task per admission (#3787)
                if not checked:
                    if not self._start_allowed(b, round_):
                        return
                    checked = True
                if not self._launch_task(b, self.store.task_row(b["id"], row["task"])):
                    return

    @task_launch_scope
    def _launch_task(self, b, row) -> bool:
        task, data, sup = row["task"], _data(row), self.sup
        wt, ad = self._wt(b), self._adapter(b)
        try:
            run = sup._run(b)
        except ValueError as error:
            sup._fail(b, "ERROR", f"실행 설정 오류로 AI를 시작하지 않았습니다: {error}")
            return False
        ts = int(sup.clock())
        while any((sup.paths.logs / f"batch-{b['id']}-s3-{task}-{ts}.{x}").exists() for x in ("log", "exit")):
            ts += 1
        log = sup.paths.logs / f"batch-{b['id']}-s3-{task}-{ts}.log"
        ex = sup.paths.logs / f"batch-{b['id']}-s3-{task}-{ts}.exit"
        try:
            env = self._env(b)
            extra = {"git_dir": sup.git.worktree_gitdir(wt)} if getattr(ad, "needs_git_dir", False) else {}
            view, prompt_view, sha, completed = stage3.read_chunk_by_number(sup.runner, env, wt, b["shard"], task)
            if completed:
                raise prompts.PromptError(f"청크 {task}는 이미 checkpoint에 저장돼 있어 다시 판정하지 않습니다")
            prompt = prompts.stage3_chunk(b, task, prompt_view)
            old = self._decisions(b, task)
            if old.exists():   # an earlier attempt's answer is kept aside, never read as this run's answer
                old.replace(old.with_name(f"previous-{hashlib.sha256(old.read_bytes()).hexdigest()[:12]}.txt"))
            for key in ("response", "save_failures", "failure_kind", "error"):
                data.pop(key, None)
            # The run and the view digest are recorded BEFORE the process exists (pid unknown until it starts), so a
            # crash right after the detached worker starts leaves a visible open run instead of an untracked process.
            self._set(b, task, data, view_sha256=sha)   # makes a crash right after add_run re-attachable by `_adopt`
            run_id = self.store.add_run(b["id"], RUN_RECORD_KIND, None, None, log, ex, model=run.model,
                                        effort=run.effort, permission_profile=run.permission_profile, task=task,
                                        fast_mode=run.fast)
            self._set(b, task, data, state="RUNNING", run_id=run_id, session_id=None, view_sha256=sha,
                      attempts=row["attempts"] + 1)
            try:
                handle = ad.start(prompt, wt, env, run, f"Stage 3 {b['shard']} chunk {task}", log, ex, **extra)
            except LaunchDenied:
                raise   # denial happens before the first write (the permit is held), never through this rollback
            except BaseException:
                self.store.finish_run(run_id, "stopped")   # nothing was started: release the slot and the task
                self._set(b, task, data, state="PENDING", run_id=None, session_id=None)
                raise
            self.store.set_run_pid(run_id, handle.pid)
        except prompts.PromptError as error:
            sup._fail(b, "ERROR", f"프롬프트 오류로 AI를 시작하지 않았습니다: {error}")
            return False
        except TRANSIENT:
            raise
        except Exception as error:
            sup._fail(b, "ERROR", f"AI 실행 시작 실패 [{task}]: {error}")
            return False
        data.pop("retry_after", None)
        self._set(b, task, data)
        self.store.log(b["id"], f"[{task}] 시작 (model={run.model}, effort={run.effort}, {view.get('relation_count')} Relation)")
        return True

    # ---- failures, operator Retry, halt, finish -------------------------------------------------------------------------------
    def _task_failed(self, b, row, data, message: str, kind: str) -> None:
        data.update(error=message, failure_kind=kind)
        self._set(b, row["task"], data, state="FAILED")
        self._reconcile_submit_failures(b, row, data)
        self.store.log(b["id"], message, "error")

    def _halt(self, b, failed) -> None:
        """No worker is running any more: the shard goes to PAUSED (usage_limit only) or ERROR with every answer, session
        and budget preserved."""
        message = "; ".join(_data(r).get("error", f"[{r['task']}] 실패") for r in failed)[:900]
        state = "PAUSED" if all(_data(r).get("pause") for r in failed) else "ERROR"
        for r in failed:
            self._set(b, r["task"], _data(r) | {"ack": True})
        self.sup._fail(b, state, f"Stage 3 병렬 청크 판정 중지: {message}")

    def _reset_acknowledged_failures(self, b, round_: _Round) -> None:
        """After an operator Retry: a rejected save re-saves its preserved answer once more when every proof still holds;
        any other failure without a protected answer re-enters as a new session. Hard/unproven evidence is never re-run
        from the answer file alone."""
        busy = {r["task"] for r in taskruns.open_runs(self.store, b["id"])}
        for row in self.store.task_rows(b["id"]):
            if row["state"] != "FAILED" or row["task"] in busy:
                continue
            data = _data(row)
            if not data.get("ack"):
                continue
            kind = data.get("failure_kind")
            if kind == "ownership":
                continue   # stays FAILED: the operator must inspect it (or Clear)
            if kind == "save_rejected":
                problem = self._resave_problem(b, row, data)
                if problem:
                    data["error"] = f"[{row['task']}] 동일 답변 재저장 불가: {problem}"
                    self._set(b, row["task"], data)
                    continue
                for key in ("ack", "error", "failure_kind", "pause"):
                    data.pop(key, None)
                self._set(b, row["task"], data, state="RESPONDED")
                continue
            for key in ("ack", "error", "failure_kind", "response", "pause"):
                data.pop(key, None)
            self._set(b, row["task"], data, state="PENDING", run_id=None, session_id=None, view_sha256=None)

    def _resave_problem(self, b, row, data) -> str | None:
        """None when the preserved answer may be saved once more; otherwise why not (never decided by the file alone)."""
        task, response = row["task"], data.get("response") or {}
        if data.get("save_failures", 0) >= MAX_SAVE_FAILURES:
            return "저장 거부가 이미 2회입니다"
        run = self.store.run(response.get("run_id")) if response.get("run_id") is not None else None
        if run is None or run["task"] != task or run["session_id"] != response.get("session_id") \
                or run["model"] != response.get("model") or run["effort"] != response.get("effort"):
            return "응답의 run/session/model/effort 핀이 일치하지 않습니다"
        try:
            spec = self.sup._run(b)
            if (spec.model, spec.effort) != (run["model"], run["effort"]):
                return "현재 모델/effort 설정이 응답을 만든 실행과 다릅니다"
            path = self._decisions(b, task)
            if hashlib.sha256(path.read_bytes()).hexdigest() != response.get("sha256"):
                return "보존된 응답 파일이 응답 identity와 다릅니다"
            _view, _prompt, sha, completed = stage3.read_chunk_by_number(self.sup.runner, self._env(b), self._wt(b), b["shard"], task)
        except (Stage3Error, OSError, ValueError, KeyError) as error:
            return f"응답/view를 확인하지 못했습니다: {error}"
        if completed or sha != row["view_sha256"] or sha != response.get("view_sha256"):
            return "현재 prepared view가 최초 view digest와 다릅니다"
        return None

    def _finish(self, b) -> None:
        """Every chunk is SAVED and the checkpoint is complete: persist `closed` first, then finalize."""
        if self.sup._finalization_held(b, "s3_plan_close"):
            return   # Restart STOPPING: nothing is written; the next instance re-enters here from the same facts
        tasks = self.store.task_rows(b["id"])
        if tasks and all(row["state"] == "SAVED" for row in tasks):
            total = len(tasks)
            self.store.update(b["id"], progress_kind="chunks", progress_done=total, progress_total=total,
                              records_done=None)
        self.store.set(stage3.plan_key(b["id"]), "closed")
        self.store.log(b["id"], "Stage 3 병렬 청크 판정 완료: 모든 청크 저장, plan 종료. 최종화(apply → verify → PR)로 진행합니다.")
        self.store.update(b["id"], retries=0, retry_after=None, error=None, session_id=None)
        self.continue_after_close(self.store.batch(b["id"]))

    def continue_after_close(self, b) -> None:
        """Enter (or re-enter after a restart) the existing finalize path."""
        self.sup._stage3_finalize(b)
