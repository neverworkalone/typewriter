"""Parallel Method D chunks inside one batch (Issue #3074, PR 2): fixed task plan, bounded scheduler, per-task recovery.

A *new* D batch (`d_mode_<batch>` = "parallel") keeps its contract - one Candidate file, one PR, the shared D cursor,
claim, worktree and branch - but runs its 25-record chunks (`s2_tasks`, task ID = chunk number) as up to
`dchunk.MAX_PARALLEL` concurrent AI runs. The batch stays PRODUCING with `run_kind="d_parallel"` and `pid=None`; the real
executions are task runs (`runs.task`). A batch without the mode key that is already in progress finishes serially.

D workers save through the CLI themselves, so a finished chunk file does not end a run: a slot is returned only when the
run's process is confirmed gone, and a result is accepted (SAVED, active scratch cleared) after that, against the batch's
Git boundary and the chunk's own active/view. Each tick:

1. every open run is tracked until its end is confirmed (identity, exit, session and usage go to that exact run),
2. a finished task is accepted when its chunk file is stored, else corrected (same session, persisted budget), resumed
   once, given the restricted technical fallback, or failed - all per task,
3. a stored chunk found without a live run (restart, Retry) is accepted from the original files without any AI call,
4. free slots are filled with waiting corrections first, then chunks in number order (AUTO_COMPLETE needs no slot),
5. once every task is SAVED and no run is open, the existing `_d_finalize` assembles, validates and opens the PR.

Task states: PENDING (not prepared/launched, or waiting for a retry time), RUNNING (a live or just ended run),
FIXQ (prepared; a correction/resume/continuation waits for a slot), SAVED, FAILED (stops new launches and is kept for the
operator; an explicit Retry re-enters it from the preserved files with one more correction chance).
"""
from __future__ import annotations

import json
from pathlib import Path

from . import dchunk, defects, prompts, taskruns
from .gitops import GitError, GitTransient
from .github import GhTransient

RUN_KIND = "d_parallel"
TRANSIENT = (GhTransient, GitTransient)
PARALLEL = "parallel"
NEW, FIX, RESUME = "d_chunk_new", "d_chunk_fix", "d_chunk_resume"


def mode_key(batch_id: int) -> str:
    return f"d_mode_{batch_id}"


def is_parallel(store, b) -> bool:
    return b["method"] == dchunk.METHOD and store.get(mode_key(b["id"])) == PARALLEL


def defect_path(b, task: str) -> str:
    """Worktree-relative path of this chunk worker's own shared-defect report."""
    return f"{dchunk.names(b).directory}/shared-defect-{task}.json"


class _Round:
    """The common lookups of ONE processing round, made lazily and shared by every launch/accept in it."""

    def __init__(self, dp, b):
        self.dp, self.b = dp, b
        self._unset = object()
        self._remote = self._prs = self._preflight = self._saved = self._unset
        self.force = False   # an operator Retry re-entered a task: stored chunks are proved again this round

    def remote(self):
        if self._remote is self._unset:
            self._remote = self.dp.sup.git.remote_head(self.b["branch"])
        return self._remote

    def pr(self):
        if self._prs is self._unset:
            self._prs = self.dp.sup._find_recovery_pr(self.b)
        return self._prs

    def preflight(self):
        if self._preflight is self._unset:
            self._preflight = self.dp.sup._preflight(self.b["producer"], self.b["method"])
        return self._preflight

    def saved(self) -> set[int]:
        """Verified stored chunk numbers; a chunk with an open run may still own a `.tmp` that is being published."""
        if self._saved is self._unset:
            running = {int(r["task"]) for r in taskruns.open_runs(self.dp.store, self.b["id"])}
            self._saved = dchunk.verified_chunks(Path(self.b["worktree"]), self.b, running)[0]
        return self._saved

    def invalidate(self) -> None:
        self._saved = self._unset


class ParallelD:
    def __init__(self, sup):
        self.sup = sup
        self._seen: set[int] = set()   # batches polled since this process started (their stored chunks are re-proved once)

    # ---- small accessors -------------------------------------------------------------------------------------
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

    @staticmethod
    def _data(row) -> dict:
        try:
            data = json.loads(row["data"] or "{}")
        except ValueError:
            data = {}
        return data if isinstance(data, dict) else {}

    def _set(self, b, task: str, data: dict | None = None, **fields) -> None:
        if data is not None:
            fields["data"] = json.dumps(data, ensure_ascii=False, sort_keys=True)
        self.store.update_task(b["id"], task, **fields)

    def workers_alive(self, b) -> bool:
        return taskruns.workers_alive(self.store, self._adapter(b), b["id"])

    def stop_workers(self, b, acknowledge: bool = False) -> bool:
        """Ask every live task process to stop; True once all are confirmed gone and their runs closed.

        A run that had exited 0 keeps its status so the next poll still reads its result. Any other stopped run returns
        its task to what it can restart from: a correction stays a correction, a task with a session resumes it, a
        prepared task continues from its files, otherwise it is prepared again. Stored chunks and budgets are untouched."""
        self._seen.discard(b["id"])   # a stored chunk of a stopped worker is proved and accepted before any new assignment
        if acknowledge:   # only the operator's own Stop acknowledges failures; an automatic stop (shared defect) keeps them
            for row in self.store.task_rows(b["id"]):
                data = self._data(row)
                if row["state"] == "FAILED" and not data.get("ack"):
                    self._set(b, row["task"], data | {"ack": True})

        def returned(run):
            row = self.store.task_row(b["id"], run["task"])
            if row is not None and row["state"] == "RUNNING" and row["run_id"] == run["id"]:
                self._requeue(b, row, self._data(row))
        return taskruns.stop_open_runs(self.store, self._adapter(b), b["id"], returned)

    # ---- batch start ---------------------------------------------------------------------------------------------
    def starts_fresh(self, b) -> bool:
        """A batch with no mode, run, baseline, stored chunk or active chunk is new: it takes the parallel path.
        Anything else without the mode key is an in-progress serial batch and finishes serially."""
        if self.store.get(mode_key(b["id"])) is not None:
            return False
        if self.store.runs(b["id"]) or self.store.get(dchunk.run_start_key(b["id"])) is not None:
            return False
        try:
            saved, _total = dchunk.verified_chunks(self._wt(b), b)
            return not saved and not dchunk.active_chunks(self._wt(b), b)
        except (dchunk.DChunkError, OSError, ValueError):
            return False   # the serial path reports the damaged scratch

    def begin(self, b) -> None:
        """Persist the mode and the batch's Git boundary, register one task per chunk, then run the scheduler."""
        wt = self._wt(b)
        try:
            total = dchunk.total_chunks(dchunk.canonical_batch(wt, b))
            head, remote = self.sup.git.head(wt), self.sup.git.remote_head(b["branch"])
        except TRANSIENT:
            raise
        except (dchunk.DChunkError, GitError, OSError, ValueError, KeyError) as error:
            return self.sup._fail(b, "ERROR", f"D 병렬 task 계획 준비 실패: {error}. worktree를 보존합니다.")
        if total < 1:
            return self.sup._fail(b, "ERROR", "D 배치에 청크가 없습니다. worktree를 보존합니다.")
        self.store.set(mode_key(b["id"]), PARALLEL)
        if self.store.get(dchunk.run_start_key(b["id"])) is None:   # the batch's Git boundary (Maintainer retargets it)
            self.store.set(dchunk.run_start_key(b["id"]), json.dumps(
                {"branch": b["branch"], "worktree": str(b["worktree"]), "head": head, "remote_head": remote}, sort_keys=True))
        self.store.add_tasks(b["id"], [(f"{n:03d}", f"{n:03d}") for n in range(1, total + 1)])
        self.store.update(b["id"], state="PRODUCING", run_kind=RUN_KIND, pid=None, session_id=None,
                          retries=0, retry_after=None, error=None)
        self.store.log(b["id"], f"D 병렬 청크 계획: {total}개 task · 동시 상한 {dchunk.MAX_PARALLEL}")
        self.poll(self.store.batch(b["id"]))

    # ---- one scheduling tick -----------------------------------------------------------------------------------
    def poll(self, b) -> None:
        try:
            self._poll(b)
        except TRANSIENT as error:
            self.sup._transient_wait(f"b{b['id']}:d_parallel", error, b["id"])

    def _poll(self, b) -> None:
        self.sup._record_progress(b)
        if self.sup._scan_task_reports(b, self):
            return
        if not self.store.task_rows(b["id"]):
            return self.begin(b)
        round_ = _Round(self, b)
        first = b["id"] not in self._seen
        self._seen.add(b["id"])
        self._reset_acknowledged_failures(b, round_)
        self._track(b, round_)
        b = self.store.batch(b["id"])
        if b["state"] != "PRODUCING":
            return
        if first or round_.force:
            self._recover_stored(b, round_)
            b = self.store.batch(b["id"])
            if b["state"] != "PRODUCING":
                return
        rows = {r["task"]: r for r in self.store.task_rows(b["id"])}
        failed = [r for r in rows.values() if r["state"] == "FAILED"]
        busy = taskruns.slots_used(self.store, b["id"])
        if failed:
            if not busy and not any(r["state"] == "RUNNING" for r in rows.values()):
                return self._halt(b, failed)
            return   # no new assignment; running tasks keep being collected
        if all(r["state"] == "SAVED" for r in rows.values()) and not busy:
            return self.sup._d_finalize(b)
        self._fill_slots(b, rows, round_)

    # ---- Git boundary ----------------------------------------------------------------------------------------
    def _boundary_problem(self, b, round_: _Round, base_override: dict | None = None) -> str | None:
        """Cheap local ownership checks every time; remote ref and PR lookups once per processing round.
        `base_override` (#3349): a pure query against a baseline the Maintainer has not stored yet."""
        if base_override is None:
            self.sup.maint.adopt_released_baseline(b)   # crash between a Maintainer release and its baseline write
        raw = json.dumps(base_override) if base_override is not None else self.store.get(dchunk.run_start_key(b["id"]))
        try:
            base = json.loads(raw) if raw else None
            if not isinstance(base, dict) or base.get("branch") != b["branch"] or base.get("worktree") != str(b["worktree"]):
                return "D 병렬 배치의 Git 경계 기준이 없거나 다른 실행을 가리킵니다. worktree를 보존합니다."
            head = self.sup.git.head(self._wt(b))
            if head != base.get("head"):
                text = f"D 병렬 실행 중 소유 HEAD가 변경됐습니다 ({base.get('head')} / {head}). 후속 실행을 중단합니다."
                receipt = self.sup.maint.approved_integration_receipt(b, base.get("head"), head, "d-parallel-boundary",
                                                                      base.get("remote_head"))
                return defects.BoundaryProblem(text, receipt) if receipt else text
            if round_.remote() != base.get("remote_head"):
                return (f"D 병렬 실행 중 원격 브랜치 {b['branch']}가 변경됐습니다 "
                        f"({base.get('remote_head')} / {round_.remote()}). 후속 실행을 중단합니다.")
            info = round_.pr()
            if info is not None:
                return f"D 병렬 실행 중 소유 브랜치에 예상하지 않은 PR #{info['number']}이 있습니다. PR과 worktree를 보존합니다."
        except TRANSIENT:
            raise
        except Exception as error:   # RecoveryBlocked, GitError, ...
            return f"D 병렬 배치의 Git/PR 경계를 확인하지 못했습니다: {error}. worktree를 보존합니다."
        return None

    def _halted_by_boundary(self, b, round_: _Round) -> bool:
        problem = self._boundary_problem(b, round_)
        if problem:
            self.sup._fail(b, "ERROR", problem)
            self.stop_workers(b)   # exits are confirmed by _reap_stopped
            return True
        return False

    # ---- tracking runs ------------------------------------------------------------------------------------------
    def _track(self, b, round_: _Round) -> None:
        """Follow EVERY open run to its end, whatever its task's state, then process the finished RUNNING tasks."""
        ad = self._adapter(b)
        for run in taskruns.open_runs(self.store, b["id"]):
            row = self.store.task_row(b["id"], run["task"])
            if row is not None and row["state"] in ("PENDING", "FIXQ") and row["run_id"] is None:
                # a launch recorded its run but not the task (restart between the two): adopt it, never start a twin
                self._set(b, row["task"], state="RUNNING", run_id=run["id"], session_id=run["session_id"])
                continue
            if row is None or row["state"] != "RUNNING" or row["run_id"] != run["id"]:
                taskruns.observe_run(self.store, ad, run, run["session_id"])   # only closes it; nothing to decide
        for row in self.store.task_rows(b["id"]):
            if row["state"] == "RUNNING":
                self._poll_task(b, row, round_)
                if self.store.batch(b["id"])["state"] != "PRODUCING":
                    return

    def _poll_task(self, b, row, round_: _Round) -> None:
        ad, task = self._adapter(b), row["task"]
        run = self.store.run(row["run_id"]) if row["run_id"] is not None else None
        data = self._data(row)
        if run is None:
            return self._task_failed(b, row, data, f"[{task}] task 실행 기록(run)이 없습니다")
        seen = taskruns.observe_run(self.store, ad, run, row["session_id"])
        if seen[0] == "wait":
            if seen[1] and seen[1] != row["session_id"]:
                self._set(b, task, session_id=seen[1])
            return
        if seen[0] == "problem":
            return self._task_failed(b, row, data, f"[{task}] {seen[1]}")
        code, run = seen[1], seen[2]
        sid = row["session_id"] or run["session_id"] or ad.session_id(Path(run["log_file"]))
        if sid and sid != row["session_id"]:
            self._set(b, task, session_id=sid)
            row = self.store.task_row(b["id"], task)
        round_.invalidate()   # the run's process is gone: whatever it stored is final now
        self._after_run(b, row, data, run, code, round_)

    def _after_run(self, b, row, data, run, code, round_: _Round) -> None:
        task, n = row["task"], int(row["task"])
        ad = self._adapter(b)
        if code is None:
            return self._task_failed(b, row, data, f"[{task}] AI 프로세스가 종료 상태 기록 없이 사라졌습니다. 결과·세션을 보존합니다.")
        cls = self.sup._classify_run(b["producer"], run["log_file"]) if code != 0 else None
        if cls == "fast_unavailable":
            return self._task_failed(b, row, data, f"[{task}] {self.sup._fast_unavailable_message(run['log_file'])}")
        try:
            stored = n in round_.saved()
        except (dchunk.DChunkError, OSError, ValueError) as error:
            return self._task_failed(b, row, data, f"[{task}] 저장된 청크를 확인하지 못했습니다: {error}. 보존합니다.")
        if stored:
            if code != 0:   # an ordinary non-zero exit after a stored chunk is accepted only with a proven run identity
                if ad.output_identity_problem(Path(run["log_file"]), taskruns.recorded_spec(run), row["session_id"],
                                              b["worktree"], self.sup.env) is not None:
                    return self._task_failed(b, row, data, f"[{task}] 비정상 종료 뒤 저장된 청크의 실행 identity를 확인하지 못했습니다. 보존합니다.")
                self.store.log(b["id"], f"[{task}] 비정상 종료(코드 {code})지만 저장된 청크와 실행 identity를 확인해 수락 경로로 진행합니다", "warn")
            return self._accept(b, row, data, round_)
        if code != 0:
            return self._run_failed(b, row, data, run, code, cls)
        self._unsaved(b, row, data, run, round_)

    def _run_failed(self, b, row, data, run, code: int, cls: str | None = None) -> None:
        task = row["task"]
        cls = cls if cls is not None else self.sup._classify_run(b["producer"], run["log_file"])
        self.store.log(b["id"], f"[{task}] AI 종료 코드 {code}, 분류={cls}", "warn")
        if cls in ("auth", "usage_limit", "free_quota", "effort", "fast_unavailable"):
            message = (self.sup._fast_unavailable_message(run["log_file"]) if cls == "fast_unavailable" else
                       f"AI 실행이 {cls}로 실패했습니다 — 자동 전환·재시도 없이 중지합니다.")
            return self._task_failed(b, row, data, f"[{task}] {message}")
        if cls not in ("rate_limit", "network"):   # unknown / session_missing: preserved, never silently re-run
            return self._task_failed(b, row, data, f"[{task}] AI 실행 실패(코드 {code}, {cls}) — 자동 재시도 없이 파일·세션을 보존합니다.")
        retries = data.get("transient_retries", 0)
        if retries >= self.cfg["rate_limit_retries"]:
            return self._task_failed(b, row, data, f"[{task}] AI 실행 실패(코드 {code}, {cls}) 재시도 한도 초과")
        data["transient_retries"] = retries + 1   # this task's own transient budget; never the correction budget
        data["retry_after"] = self.sup.clock() + self.sup._transient_gap(retries + 1)
        self._requeue(b, row, data)
        self.store.log(b["id"], f"[{task}] 일시 실패 — 이 task만 {retries + 1}번째 재시도 예약", "warn")

    def _requeue(self, b, row, data: dict) -> None:
        """Return a task whose run ended without a stored chunk to the state it can restart from (files and budget kept)."""
        task = row["task"]
        try:
            prepared = dchunk.read_active(self._wt(b), b, int(task)) is not None
        except (dchunk.DChunkError, OSError, ValueError):
            prepared = False
        if not prepared:
            data.pop("kind", None)
            return self._set(b, task, data, state="PENDING", run_id=None, session_id=None)
        if data.get("kind") != "fix":
            data["kind"] = "resume" if row["session_id"] else "new"
            data["continued"] = True
        self._set(b, task, data, state="FIXQ", run_id=None)

    def _unsaved(self, b, row, data, run, round_: _Round) -> None:
        """The run ended 0 but its chunk is not stored: correction, restricted fallback, one resume, or failure."""
        task, n, wt = row["task"], int(row["task"]), self._wt(b)
        sid = row["session_id"]
        try:
            rec = dchunk.read_active(wt, b, n)
            diag = dchunk.read_rejection(wt, b, rec) if rec else None
            names = dchunk.chunk_names(b, n)
            has_decisions = rec is not None and (wt / names.decisions).is_file()
            searching_failed = rec is not None and dchunk.has_search_failure(wt, b, n)
            rejected = rec is not None and (wt / names.rejected).exists()
        except (dchunk.DChunkError, OSError, ValueError) as error:
            return self._task_failed(b, row, data, f"[{task}] 활성 D 청크 상태를 읽지 못했습니다. 임시 파일을 보존합니다: {error}")
        key = dchunk.fix_key(b["id"], n)
        used = int(self.store.get(key) or 0)
        if rec is not None and diag is not None and has_decisions and sid:
            if used < dchunk.MAX_FIXES:
                data["kind"] = "fix"
                self._set(b, task, data, state="FIXQ", run_id=None)
                self.store.set(key, str(used + 1))   # persisted after the state, so a restart cannot spend it twice
                failed_records = ",".join(f"{i['record_id']}:{','.join(i['failed_sense_ids'])}" for i in diag["failed_records"])
                return self.store.log(b["id"], f"[{task}] D 청크 판정 오류 (failed_records={failed_records}; "
                                      f"{diag.get('error_count', len(diag['errors']))}건). 같은 세션에서 지목된 판정만 수정합니다 "
                                      f"({used + 1}/{dchunk.MAX_FIXES})", "warn")
            return self._technical_skip(b, row, data, rec, round_)
        if rec is not None and not rejected and not searching_failed and run["kind"] != FIX \
                and sid and not data.get("resumed"):
            data["resumed"] = True
            data["kind"] = "resume"
            data["continued"] = True
            self._set(b, task, data, state="FIXQ", run_id=None)
            return self.store.log(b["id"], f"[{task}] 활성 청크 저장 누락 — 같은 세션으로 1회 이어갑니다", "warn")
        self._task_failed(b, row, data, f"[{task}] D 청크 실행이 종료됐지만 활성 청크가 저장되지 않았습니다 (chunk-NNN.jsonl 증거 없음). "
                          "자동 재진입 한도를 소진했거나 저장/검색 진단 때문에 안전하지 않아 보존합니다 — Retry는 같은 청크를 이어갑니다."
                          + self.sup._d_rejection_note(b, n))

    def _technical_skip(self, b, row, data, rec, round_: _Round) -> None:
        task, wt = row["task"], self._wt(b)
        try:
            result = dchunk.supervisor_skip(self.store, self.sup.runner, self.sup._d_env(b), wt, b, rec,
                                            task_session=row["session_id"])
        except (dchunk.DChunkError, OSError, ValueError, KeyError, TypeError) as error:
            return self._task_failed(b, row, data, f"[{task}] D Record 범위 기술적 제외를 증명하지 못했습니다: {error}. 원본을 보존합니다.")
        details = json.dumps(result["technical_skips"], ensure_ascii=False, separators=(",", ":"))
        self.store.log(b["id"], f"[{task}] D 기술적 생산 제외: technical_skips={details} "
                       f"same-session-fixes={self.store.get(dchunk.fix_key(b['id'], int(task)))}; 실패 Sense만 후보 []로 저장했습니다.", "warn")
        round_.invalidate()
        self._accept(b, row, data, round_)

    # ---- accepting a stored chunk --------------------------------------------------------------------------------
    def _accept(self, b, row, data, round_: _Round) -> None:
        """A stored chunk whose run (if any) is gone: bind it to the batch's Git boundary and the chunk's own files,
        remember it, clear its scratch, and mark the task SAVED."""
        task, n, wt = row["task"], int(row["task"]), self._wt(b)
        if self._halted_by_boundary(b, round_):
            return
        try:
            if n not in round_.saved():
                return self._task_failed(b, row, data, f"[{task}] 저장된 청크가 검증되지 않았습니다. 보존합니다.")
            rec = dchunk.read_active(wt, b, n)
            if rec is not None:
                base = json.loads(self.store.get(dchunk.run_start_key(b["id"])))
                if rec["git_head"] != base["head"] and not self.sup.git.contains(wt, rec["git_head"]):
                    return self._task_failed(b, row, data, f"[{task}] 청크의 준비 HEAD가 배치 기준과 이어지지 않습니다. 보존합니다.")
                dchunk.read_view(wt, b, rec)   # the saved metadata must still bind the exact view being cleaned
            saved_tasks = [int(r["task"]) for r in self.store.task_rows(b["id"]) if r["state"] == "SAVED"]
            if problem := self.sup._d_chunks_problem(b, [*saved_tasks, n]):
                return self._task_failed(b, row, data, f"[{task}] {problem}")
            self.sup._d_remember(b, n)
            dchunk.clear_active(wt, b, n)
        except TRANSIENT:
            raise
        except (dchunk.DChunkError, OSError, ValueError, KeyError, TypeError) as error:
            return self._task_failed(b, row, data, f"[{task}] 저장된 청크를 확인하지 못했습니다: {error}. 보존합니다.")
        for key in ("kind", "continued", "resumed", "retry_after", "error"):
            data.pop(key, None)
        self._set(b, task, data, state="SAVED", run_id=None)
        self.store.log(b["id"], f"[{task}] D 청크 저장을 확인했습니다 ({len(self._saved_rows(b))}/{len(self.store.task_rows(b['id']))})")

    def _saved_rows(self, b):
        return [r for r in self.store.task_rows(b["id"]) if r["state"] == "SAVED"]

    def _recover_stored(self, b, round_: _Round) -> None:
        """After a restart or an operator Retry: a stored chunk whose task has no live run is accepted from the original
        files (no AI call, no new file); unreadable scratch stays an error."""
        rows = [r for r in self.store.task_rows(b["id"]) if r["state"] in ("PENDING", "FIXQ")]
        if not rows:
            return
        try:
            stored = round_.saved()
        except (dchunk.DChunkError, OSError, ValueError) as error:
            return self.sup._fail(b, "ERROR", f"D 병렬 저장 청크를 확인하지 못했습니다: {error}. 보존합니다.")
        busy = {r["task"] for r in taskruns.open_runs(self.store, b["id"])}
        for row in rows:
            if int(row["task"]) in stored and row["task"] not in busy:
                self._accept(b, row, self._data(row), round_)
                if self.store.batch(b["id"])["state"] != "PRODUCING":
                    return

    # ---- slots ------------------------------------------------------------------------------------------------
    def _fill_slots(self, b, rows, round_: _Round) -> None:
        free = dchunk.MAX_PARALLEL - taskruns.slots_used(self.store, b["id"])
        if free <= 0:
            return
        now = self.sup.clock()
        busy = {r["task"] for r in taskruns.open_runs(self.store, b["id"])}
        due = lambda r: self._data(r).get("retry_after", 0) <= now and r["task"] not in busy
        queue = [r for r in sorted(rows.values(), key=lambda r: r["task"]) if r["state"] == "FIXQ" and due(r)]
        queue += [r for r in sorted(rows.values(), key=lambda r: r["task"]) if r["state"] == "PENDING" and due(r)]
        if not queue or self._halted_by_boundary(b, round_):
            return
        for row in queue:
            if free <= 0 or self.store.batch(b["id"])["state"] != "PRODUCING":
                return
            row = self.store.task_row(b["id"], row["task"])
            if row["state"] == "SAVED":
                continue
            if row["state"] == "PENDING":
                outcome = self._prepare(b, row, round_)
                if outcome == "auto":
                    continue   # needs no AI and no slot
                if outcome != "ready":
                    return
                row = self.store.task_row(b["id"], row["task"])
            problem = round_.preflight()
            if problem:
                from .adapters import PREFLIGHT_PENDING
                if problem.startswith(PREFLIGHT_PENDING):
                    return   # still proving the pin in the background; the next tick retries
                return self.sup._fail(b, "ERROR", f"실행 전 확인 실패: {problem}")
            if self._launch(b, row, round_):
                free -= 1
            else:
                return

    def _prepare(self, b, row, round_: _Round) -> str:
        """"ready" (an active chunk exists), "auto" (stored with no AI) or "stop" (task failed/batch halted)."""
        task, n, wt, data = row["task"], int(row["task"]), self._wt(b), self._data(row)
        try:
            rec = dchunk.read_active(wt, b, n)
            if rec is not None:   # READY survived a restart: reuse files and search evidence, never prepare twice
                dchunk.read_view(wt, b, rec)
                return "ready"
            res = dchunk.prepare(self.sup.runner, self.sup._d_env(b), wt, b, n,
                                 str(Path(self.cfg["corpus_index_path"].strip()).expanduser()), self.sup.git.head(wt))
        except TRANSIENT:
            raise
        except (dchunk.DChunkError, OSError, ValueError, GitError) as error:
            self._task_failed(b, row, data, f"[{task}] D 청크 준비 실패: {error}. 흔적을 보존합니다.")
            return "stop"
        if res["status"] == "SEARCH_FAILED":
            data["pause"] = True
            self._task_failed(b, row, data, f"[{task}] SEARCH_FAILED record {res.get('failed_records')}: 승인 index 진단이 필요합니다 "
                              "(stop_and_report). AI를 시작하지 않았습니다.")
            return "stop"
        round_.invalidate()
        if res["status"] == "AUTO_COMPLETE":   # every sense mechanically proven ZERO_HITS: stored without an AI
            self.store.log(b["id"], f"[{task}] 모든 sense가 기계적으로 증명된 ZERO_HITS라 AI 없이 저장했습니다.")
            self._accept(b, self.store.task_row(b["id"], task), data, round_)
            return "auto" if self.store.task_row(b["id"], task)["state"] == "SAVED" else "stop"
        try:
            if dchunk.read_active(wt, b, n) is None:
                raise dchunk.DChunkError("prepare가 활성 청크를 만들지 못했습니다")
        except (dchunk.DChunkError, OSError, ValueError) as error:
            self._task_failed(b, row, data, f"[{task}] {error}. 보존합니다.")
            return "stop"
        return "ready"

    def _launch(self, b, row, round_: _Round) -> bool:
        """Start (or resume) this task's AI. False: the batch was failed/halted and nothing started."""
        task, n, data = row["task"], int(row["task"]), self._data(row)
        kind = {"fix": FIX, "resume": RESUME}.get(data.get("kind"), NEW)
        wt, sup, ad = self._wt(b), self.sup, self._adapter(b)
        try:
            run = sup._run(b)
        except ValueError as error:
            sup._fail(b, "ERROR", f"실행 설정 오류로 AI를 시작하지 않았습니다: {error}")
            return False
        ts = int(sup.clock())
        while any((sup.paths.logs / f"batch-{b['id']}-d{task}-{ts}.{x}").exists() for x in ("log", "exit")):
            ts += 1
        log = sup.paths.logs / f"batch-{b['id']}-d{task}-{ts}.log"
        ex = sup.paths.logs / f"batch-{b['id']}-d{task}-{ts}.exit"
        try:
            env = sup._launch_env(b, NEW, sup._agent_env())
            extra = {"git_dir": sup.git.worktree_gitdir(wt)} if getattr(ad, "needs_git_dir", False) else {}
            rec = dchunk.read_active(wt, b, n)
            if rec is None:
                raise prompts.PromptError("활성 청크 기록이 없습니다")
            sid = row["session_id"] if kind != NEW else None
            note = (f"이 청크 전용 공통 결함 보고 파일: `{defect_path(b, task)}` "
                    "(공유 코드·검증기의 결함을 발견했을 때만 이 경로에 쓰고, 다른 경로에는 쓰지 않는다).\n")
            if kind == FIX:
                diag = dchunk.read_rejection(wt, b, rec)
                if not sid or diag is None:
                    raise prompts.PromptError("수정 요청에 기존 세션과 활성 청크에 결속된 저장 거부 진단이 필요합니다")
                if int(self.store.get(dchunk.fix_key(b["id"], n)) or 0) < 1:
                    self.store.set(dchunk.fix_key(b["id"], n), "1")   # a restart between the decision and the launch
                prompt = prompts.d_chunk_fix(b, n, dchunk.fix_problem(diag))
                handle = ad.resume(sid, prompt, wt, env, run, log, ex, **extra)
            elif kind == RESUME:
                if not sid:
                    raise prompts.PromptError("이어가기 요청에 기존 세션이 필요합니다")
                prompt, _ = sup._d_chunk_prompt(b, RESUME, round_.remote(), rec=rec, continued=True)
                handle = ad.resume(sid, prompt, wt, env, run, log, ex, **extra)
            else:
                prompt, _ = sup._d_chunk_prompt(b, NEW, round_.remote(), rec=rec,
                                                continued=bool(data.get("continued")), extra_note=note)
                handle = ad.start(prompt, wt, env, run, f"D {b['shard']}_{b['batch']} chunk {n:03d}", log, ex, **extra)
        except prompts.PromptError as error:
            sup._fail(b, "ERROR", f"프롬프트 오류로 AI를 시작하지 않았습니다: {error}")
            return False
        except TRANSIENT:
            raise
        except Exception as error:
            sup._fail(b, "ERROR", f"AI 실행 시작 실패 [{task}]: {error}")
            return False
        run_id = self.store.add_run(b["id"], kind, sid, handle.pid, log, ex, model=run.model, effort=run.effort,
                                    permission_profile=run.permission_profile, task=task, fast_mode=run.fast)
        data.pop("retry_after", None)
        self._set(b, task, data, state="RUNNING", run_id=run_id, session_id=sid, view_sha256=rec["view_sha256"],
                  attempts=row["attempts"] + 1)
        self.store.log(b["id"], f"[{task}] 시작 ({kind}, model={run.model}, effort={run.effort})")
        return True

    # ---- failures, halt, Retry -------------------------------------------------------------------------------
    def _task_failed(self, b, row, data, message: str) -> None:
        data["error"] = message
        self._set(b, row["task"], data, state="FAILED")
        self.store.log(b["id"], message, "error")

    def _halt(self, b, failed) -> None:
        """No worker is running any more: the batch goes to PAUSED (SEARCH_FAILED) or ERROR with every file kept."""
        message = "; ".join(self._data(r).get("error", f"[{r['task']}] 실패") for r in failed)[:900]
        state = "PAUSED" if all(self._data(r).get("pause") for r in failed) else "ERROR"
        for r in failed:
            self._set(b, r["task"], self._data(r) | {"ack": True})
        self.sup._fail(b, state, f"D 병렬 청크 중지: {message}")

    def _reset_acknowledged_failures(self, b, round_: _Round) -> None:
        """After an operator Retry brought the batch back to PRODUCING: a failed task re-enters from what is preserved
        with exactly one more correction chance (history kept, granted once because `ack` is cleared with the re-entry)."""
        for row in self.store.task_rows(b["id"]):
            if row["state"] != "FAILED":
                continue
            data = self._data(row)
            if not data.get("ack"):
                continue
            n = int(row["task"])
            key = dchunk.fix_key(b["id"], n)
            used = int(self.store.get(key) or 0)
            if used:
                self.store.set(key, str(used - 1))
            data.pop("ack"), data.pop("error", None), data.pop("pause", None), data.pop("resumed", None)
            data["retry_grants"] = data.get("retry_grants", 0) + 1
            data.pop("kind", None)
            self._set(b, row["task"], data, state="PENDING", run_id=None)
            round_.force = True
            fresh = self.store.task_row(b["id"], row["task"])
            try:
                rec = dchunk.read_active(self._wt(b), b, n)
                diag = dchunk.read_rejection(self._wt(b), b, rec) if rec else None
            except (dchunk.DChunkError, OSError, ValueError):
                continue   # prepare/launch will report the damaged scratch
            if rec is not None and diag is not None and fresh["session_id"] and used:
                data["kind"] = "fix"
                self._set(b, row["task"], data, state="FIXQ")
            elif rec is not None:
                self._requeue(b, fresh, data)
