"""Parallel Stage 2 primary judgment (Issue #3047, PR 2): fixed task plan, bounded scheduler, single-writer saves.

A *new* Part (`s2_mode_<batch>` = "parallel") splits its primary decisions with `admission-cli plan-chunks` into
tasks of about `stage2_chunk_candidates` candidates. The batch stays PRODUCING with `run_kind="s2_parallel"` and
`pid=None`; the real executions are task runs (`runs.task`, `s2_tasks`). Each tick this module

1. reads the exit/answer of finished task runs and preserves the answer (decision file),
2. saves preserved answers one at a time through `save-chunk --task` with the view hash the task was launched with
   (the Supervisor is the only writer; completion order never changes the final data),
3. gives a rejected answer its one persisted same-session correction, and a still-failing *single* candidate the
   restricted technical Drop `f`,
4. fills free slots with ready tasks: `min(ready, max(0, stage2_max_parallel - active))`, corrections first,
5. closes the plan once every task is SAVED and `decided == total`, then hands over to the existing serial
   follow-up (optional links -> preflight/repair -> finalize -> PR).

Task states: PENDING (not started / waiting for a dependency or a retry time), RUNNING (a live or just ended run),
RESPONDED (answer preserved, save pending), FIXQ (a correction waits for a slot), SAVED, FAILED (halts new launches,
kept for the operator; a Retry re-enters it from the preserved answer, budget and session).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import adapters, prompts, stage2, taskruns
from .gitops import GitError, GitTransient
from .launch_gate import task_launch_scope
from .github import GhTransient
from .store import STAGE2_METHOD

RUN_KIND = "s2_parallel"
TRANSIENT = (GhTransient, GitTransient)
TASK_NEW, TASK_FIX, TASK_FORMAT_FIX = "s2_task_new", "s2_task_fix", "s2_task_format_fix"


def plan_key(batch_id: int) -> str:
    """"open" while the primary plan owns the checkpoint, "closed" once it has been persistently closed."""
    return f"s2_plan_{batch_id}"


def is_parallel(store, b) -> bool:
    return b["method"] == STAGE2_METHOD and store.get(stage2.mode_key(b["id"])) == stage2.PARALLEL


def plan_state(store, b) -> str | None:
    return store.get(plan_key(b["id"])) if is_parallel(store, b) else None


class _Round:
    """The common lookups of ONE processing round, made lazily and shared by every launch/save in it.

    Only a round that really launches or saves asks (a plain wait tick never does), and a round never outlives its
    tick, so a stage change, restart, Retry or config change always starts with fresh lookups."""

    def __init__(self, s2p, b):
        self.s2p, self.b = s2p, b
        self._remote = self._prs = self._preflight = self._unset = object()

    def remote(self):
        if self._remote is self._unset:
            self._remote = self.s2p.sup.git.remote_head(self.b["branch"])
        return self._remote

    def pr(self):
        if self._prs is self._unset:
            self._prs = self.s2p.sup._find_recovery_pr(self.b)
        return self._prs

    def preflight(self):
        if self._preflight is self._unset:
            self._preflight = self.s2p.sup._preflight(self.b["producer"], self.b["method"])
        return self._preflight


class ParallelStage2:
    def __init__(self, sup):
        self.sup = sup

    # ---- small accessors -------------------------------------------------------------------------------------
    @property
    def store(self):
        return self.sup.store

    @property
    def cfg(self):
        return self.sup.cfg

    def _wt(self, b) -> Path:
        return Path(b["worktree"])

    def _data(self, row) -> dict:
        try:
            data = json.loads(row["data"] or "{}")
        except ValueError:
            data = {}
        return data if isinstance(data, dict) else {}

    def _set(self, b, task: str, data: dict | None = None, **fields) -> None:
        if data is not None:
            fields["data"] = json.dumps(data, ensure_ascii=False, sort_keys=True)
        self.store.update_task(b["id"], task, **fields)

    def _adapter(self, b):
        return self.sup._adapter(b["producer"])

    def _recorded(self, run_row):
        return taskruns.recorded_spec(run_row)

    def active_runs(self, b) -> list:
        return taskruns.open_runs(self.store, b["id"])

    def workers_alive(self, b) -> bool:
        """True while any task run of the Part may still be alive (no recorded end, or its PID still lives)."""
        return taskruns.workers_alive(self.store, self._adapter(b), b["id"])

    def stop_workers(self, b) -> bool:
        """Ask every live task process to stop; True once all of them are confirmed gone and their runs closed.

        A run that had already finished successfully keeps its exit status so the next poll still reads its answer.
        Any other stopped run returns its task to the state it can restart from: a first run starts afresh, a
        correction resumes its own session; preserved answers, budgets and SAVED tasks are untouched."""
        def returned(run):
            row = self.store.task_row(b["id"], run["task"])
            if row is not None and row["state"] == "RUNNING" and row["run_id"] == run["id"]:
                data = self._data(row)
                if data.get("kind", "new") == "new":
                    self._set(b, row["task"], data, state="PENDING", run_id=None, session_id=None)
                else:
                    self._set(b, row["task"], data, state="FIXQ", run_id=None)
        return taskruns.stop_open_runs(self.store, self._adapter(b), b["id"], returned)

    # ---- Part start --------------------------------------------------------------------------------------------
    def begin(self, b) -> None:
        """Prepare (once), plan (once), register tasks and the Part's Git boundary, then run the scheduler."""
        wt, (bb, pp) = self._wt(b), stage2.split_key(b["batch"])
        try:
            checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
            if checkpoint is None:
                self.sup.git.stage2_prepare(wt, b["shard"], bb, pp)
                checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
            if stage2.next_action(checkpoint) != "chunk":
                self.store.log(b["id"], "primary 후보가 없어 다음 deterministic Stage 2 단계로 진행합니다.")
                return self.sup._launch_stage2_next(self.store.batch(b["id"]))
            if checkpoint["pending_chunk"] is not None:
                return self.sup._fail(b, "ERROR", f"병렬 Part의 checkpoint에 숫자형 pending 청크 {checkpoint['pending_chunk']}가 있어 "
                                      "task 계획을 만들지 않습니다. checkpoint를 보존합니다.")
            remote = self.sup.git.remote_head(b["branch"])
            plan_info = self.sup.git.stage2_plan_chunks(wt, b["shard"], bb, pp, self.cfg["stage2_chunk_candidates"],
                                                        stage2.PLAN)
            plan = stage2.read_plan(wt)
            head = self.sup.git.head(wt)
        except TRANSIENT:
            raise
        except (GitError, OSError, ValueError, KeyError, TypeError) as error:
            return self.sup._fail(b, "ERROR", f"Stage 2 병렬 task 계획 준비 실패: {error}. worktree를 보존합니다.")
        self.store.add_tasks(b["id"], [(t["id"], t["chunk_id"]) for t in plan["tasks"]])
        if self.store.get(stage2.run_start_key(b["id"])) is None:   # the Part's Git boundary (Maintainer retargets it)
            self.store.set(stage2.run_start_key(b["id"]), json.dumps(
                {"branch": b["branch"], "worktree": str(b["worktree"]), "head": head, "remote_head": remote}, sort_keys=True))
        self.store.set(plan_key(b["id"]), "open")
        self.store.update(b["id"], state="PRODUCING", run_kind=RUN_KIND, pid=None, session_id=None,
                          retries=0, retry_after=None, error=None)
        self.store.log(b["id"], f"Stage 2 병렬 primary 계획: {len(plan['tasks'])}개 task · {plan_info.get('candidates')}후보 · "
                       f"목표 {plan_info.get('target')}후보/task · 동시 상한 {self.cfg['stage2_max_parallel']}"
                       + (" (기존 계획 재사용)" if plan_info.get("reused") else ""))
        self.poll(self.store.batch(b["id"]))

    # ---- one scheduling tick -----------------------------------------------------------------------------------
    def poll(self, b) -> None:
        try:
            self._poll(b)
        except TRANSIENT as error:
            self.sup._transient_wait(f"b{b['id']}:s2_parallel", error, b["id"])

    def _poll(self, b) -> None:
        self.sup._record_progress(b)
        if self.sup._scan_task_reports(b, self):
            return
        try:
            plan = stage2.read_plan(self._wt(b))
        except ValueError as error:
            return self.sup._fail(b, "ERROR", f"{error}. worktree를 보존합니다.")
        if plan is None:
            return self.begin(b)
        self.store.add_tasks(b["id"], [(t["id"], t["chunk_id"]) for t in plan["tasks"]])   # idempotent re-registration
        round_ = _Round(self, b)
        self._reset_acknowledged_failures(b)
        for row in self.store.task_rows(b["id"]):
            if row["state"] == "RUNNING":
                self._poll_task(b, plan, row, round_)
        for row in self.store.task_rows(b["id"]):
            if row["state"] == "RESPONDED" and not self._halted_by_boundary(b, round_):
                self._save_task(b, plan, row, round_, fallback=self._persisted_fallback(b, row))
        b = self.store.batch(b["id"])
        if b["state"] != "PRODUCING":
            return
        rows = {r["task"]: r for r in self.store.task_rows(b["id"])}
        failed = [r for r in rows.values() if r["state"] == "FAILED"]
        if failed:
            if not any(r["state"] in ("RUNNING", "RESPONDED") for r in rows.values()):
                return self._halt(b, failed)
            return
        if all(r["state"] == "SAVED" for r in rows.values()):
            return self._finish(b, plan)
        self._fill_slots(b, plan, rows, round_)

    def _halted_by_boundary(self, b, round_: _Round) -> bool:
        self.sup.maint.adopt_released_baseline(b)   # crash between a Maintainer release and its baseline write
        problem = self._boundary_problem(b, round_)
        if problem:
            self.sup._fail(b, "ERROR", problem)
            return True
        return False

    def _boundary_problem(self, b, round_: _Round) -> str | None:
        """Cheap local ownership checks every time; remote ref and PR lookups once per processing round."""
        raw = self.store.get(stage2.run_start_key(b["id"]))
        try:
            base = json.loads(raw) if raw else None
            if not isinstance(base, dict) or base.get("branch") != b["branch"] or base.get("worktree") != str(b["worktree"]):
                return "Stage 2 병렬 Part의 Git 경계 기준이 없거나 다른 실행을 가리킵니다. worktree를 보존합니다."
            head = self.sup.git.head(self._wt(b))
            if head != base.get("head"):
                return f"Stage 2 병렬 실행 중 소유 HEAD가 변경됐습니다 ({base.get('head')} / {head}). 후속 실행을 중단합니다."
            if round_.remote() != base.get("remote_head"):
                return (f"Stage 2 병렬 실행 중 원격 브랜치 {b['branch']}가 변경됐습니다 "
                        f"({base.get('remote_head')} / {round_.remote()}). 후속 실행을 중단합니다.")
            info = round_.pr()
            if info is not None:
                return f"병렬 Stage 2 실행 중 소유 브랜치에 예상하지 않은 PR #{info['number']}이 있습니다. PR과 worktree를 보존합니다."
        except TRANSIENT:
            raise
        except Exception as error:   # RecoveryBlocked, GitError, ...
            return f"Stage 2 병렬 Part의 Git/PR 경계를 확인하지 못했습니다: {error}. worktree를 보존합니다."
        return None

    # ---- task run results ---------------------------------------------------------------------------------------
    def _poll_task(self, b, plan, row, round_: _Round) -> None:
        ad, task = self._adapter(b), row["task"]
        run = self.store.run(row["run_id"]) if row["run_id"] is not None else None
        data = self._data(row)
        if run is None:
            return self._task_failed(b, row, data, "task 실행 기록(run)이 없습니다")
        log = Path(run["log_file"])
        seen = taskruns.observe_run(self.store, ad, run, row["session_id"])
        if seen[0] == "wait":
            if seen[1] and seen[1] != row["session_id"]:
                self._set(b, task, session_id=seen[1])
            return
        if seen[0] == "problem":
            return self._task_failed(b, row, data, seen[1])
        code, run = seen[1], seen[2]
        if run["session_id"] and run["session_id"] != row["session_id"]:   # discovered on the poll that saw the exit
            self._set(b, task, session_id=run["session_id"])
            row = self.store.task_row(b["id"], task)
        if code is None:
            return self._task_failed(b, row, data, "AI 프로세스가 종료 상태 기록 없이 사라졌습니다. 응답·세션을 보존합니다.")
        if code != 0:
            return self._run_failed(b, row, data, run, code)
        sid = row["session_id"] or ad.session_id(log)
        problem = ad.completion_problem(log, self._recorded(run), sid, b["worktree"], self.sup.env)
        if problem and not ad.completion_incomplete(log, self._recorded(run), sid, b["worktree"], self.sup.env):
            return self._task_failed(b, row, data, problem[1])
        self._accept_answer(b, row, data, run)

    def _run_failed(self, b, row, data, run, code: int) -> None:
        cls = self.sup._classify_run(b["producer"], run["log_file"])
        self.store.log(b["id"], f"[{row['task']}] AI 종료 코드 {code}, 분류={cls}", "warn")
        hard = cls in ("auth", "usage_limit", "free_quota", "effort", "fast_unavailable")
        if not hard:   # a complete current answer survives an ordinary non-zero exit, like the serial path
            ad, log = self._adapter(b), Path(run["log_file"])
            sid = run["session_id"] or ad.session_id(log)
            if stage2.extract_decisions(ad.final_answer(log), row["task"]) is not None \
                    and ad.output_identity_problem(log, self._recorded(run), sid, b["worktree"], self.sup.env) is None:
                self.store.log(b["id"], f"[{row['task']}] 비정상 종료지만 현재 task의 응답과 실행 identity를 확인해 저장 경로로 진행합니다", "warn")
                return self._accept_answer(b, row, data, run)
        if hard:
            message = (self.sup._fast_unavailable_message(run["log_file"]) if cls == "fast_unavailable" else
                       f"AI 실행이 {cls}로 실패했습니다 — 자동 전환·재시도 없이 중지합니다.")
            if cls == "usage_limit":
                data["pause"] = True   # a plan limit is not a defect: PAUSED for the owner's Retry, never a Maintainer incident
            return self._task_failed(b, row, data, f"[{row['task']}] {message}")
        if cls not in ("rate_limit", "network"):   # unknown / session_missing: preserved, never silently re-run
            return self._task_failed(b, row, data, f"[{row['task']}] AI 실행 실패(코드 {code}, {cls}) — 자동 재시도 없이 응답·세션을 보존합니다.")
        retries = data.get("transient_retries", 0)
        if retries < self.cfg["rate_limit_retries"]:   # this task's own transient budget; never the candidate-fix budget
            data["transient_retries"] = retries + 1
            data["retry_after"] = self.sup.clock() + self.sup._transient_gap(retries + 1)
            if data.get("kind", "new") == "new":
                self._set(b, row["task"], data, state="PENDING", run_id=None, session_id=None)
            else:   # a correction keeps its session, answer and budget
                self._set(b, row["task"], data, state="FIXQ", run_id=None)
            return self.store.log(b["id"], f"[{row['task']}] 일시 실패 — 이 task만 {retries + 1}번째 재시도 예약", "warn")
        self._task_failed(b, row, data, f"[{row['task']}] AI 실행 실패(코드 {code}, {cls}) 재시도 한도 초과")

    def _accept_answer(self, b, row, data, run) -> None:
        task, ad = row["task"], self._adapter(b)
        final = ad.final_answer(Path(run["log_file"]))
        rows = stage2.extract_decisions(final, task)
        kind = data.get("kind", "new")
        if rows is None:
            problem = stage2.format_problem(final, task)
            if problem and kind == "new" and not data.get("format_fix_used"):
                data["format_fix_used"] = True
                data["format_problem"] = problem
                data["kind"] = "format_fix"
                return self._set(b, task, data, state="FIXQ")
            if not problem and kind == "new" and data.get("fresh_retries", 0) < 1:   # nothing answered at all
                data["fresh_retries"] = 1
                data.pop("kind", None)
                self._set(b, task, data, state="PENDING", run_id=None, session_id=None)
                return self.store.log(b["id"], f"[{task}] 응답 누락 — 이 task만 새 세션으로 1회 재실행합니다", "warn")
            return self._task_failed(b, row, data, f"[{task}] 현재 task ID 헤더가 있는 판정 응답이 없습니다. 기록을 보존합니다.")
        joined = stage2.joined_decision_rows_problem(rows)
        if joined:
            if kind == "new" and not data.get("format_fix_used"):
                data.update(format_fix_used=True, format_problem=joined, kind="format_fix")
                return self._set(b, task, data, state="FIXQ")
            return self._task_failed(b, row, data, f"[{task}] 판정 행 형식 오류: {joined}")
        rel = stage2.task_path(task, "decisions.txt")
        wt = self._wt(b)
        if kind == "fix":   # merge only the corrected aliases into the answer the failure was diagnosed from
            correction = data.get("correction") or {}
            targets = correction.get("aliases", [])
            got = [stage2.alias_of(r) for r in rows]
            if len(got) != len(set(got)) or set(got) != set(targets):
                return self._task_failed(b, row, data, f"[{task}] 수정 응답은 실패한 후보 각각의 행 하나만 포함해야 합니다")
            merged, _ignored = stage2.merge_fix(stage2.read_rows(wt, rel), rows, targets)
            stage2.write_decisions(wt, task, merged, rel)
            correction["fix_applied"] = True
            correction["decisions_sha256"] = hashlib.sha256((wt / rel).read_bytes()).hexdigest()
            data["correction"] = correction
        else:
            stage2.write_decisions(wt, task, rows, rel)   # the preserved answer: a restart saves it without the AI
        data.pop("kind", None)
        self._set(b, task, data, state="RESPONDED")

    def _persisted_fallback(self, b, row) -> dict | None:
        """The technical-Drop evidence of a task whose fallback save may already have reached the checkpoint: its
        failing row was removed from the decision file on purpose, so a retry must present the same evidence."""
        proof = (self._data(row).get("correction") or {}).get("fallback")
        if not proof:
            return None
        rows = stage2.read_rows(self._wt(b), stage2.task_path(row["task"], "decisions.txt"))
        return proof if all(stage2.alias_of(r) != proof["alias"] for r in rows) else None

    # ---- saving -----------------------------------------------------------------------------------------------
    def _save_task(self, b, plan, row, round_: _Round, *, fallback: dict | None = None) -> None:
        task, data = row["task"], self._data(row)
        wt, (bb, pp) = self._wt(b), stage2.split_key(b["batch"])
        try:
            ok, detail = self.sup.git.stage2_save_task(
                wt, b["shard"], bb, pp, stage2.PLAN, task, stage2.task_path(task, "decisions.txt"),
                row["view_sha256"], supervisor_fallback=fallback, supervisor_state_dir=self.sup.paths.supervisor_state)
        except TRANSIENT:
            raise
        except (OSError, ValueError, GitError) as error:
            return self._task_failed(b, row, data, f"[{task}] 판정 저장 처리 실패: {error}. 응답을 보존합니다.")
        if ok:
            self._set(b, task, data, state="SAVED")
            return self.store.log(b["id"], f"[{task}] 판정이 save-chunk --task를 통과해 저장됐습니다"
                                  + (" (technical Drop f 포함)" if fallback else ""))
        self.store.add_submit_failure(b["id"], row["run_id"])
        self.store.log(b["id"], f"[{task}] 저장 거부: {detail[:300]}", "warn")
        if fallback is not None:   # the restricted technical Drop is attempted once; its rejection is never retried
            return self._task_failed(b, row, data, f"[{task}] reason f Fallback도 공식 save-chunk 검증을 통과하지 못했습니다. "
                                     f"판정 파일과 checkpoint를 보존합니다: {detail[:600]}")
        self._rejected(b, row, data, detail)

    def _rejected(self, b, row, data, detail: str) -> None:
        """One same-session correction of the exactly named failing candidates, then at most one technical Drop."""
        task = row["task"]
        if "view changed since it was launched" in detail:
            return self._task_failed(b, row, data, f"[{task}] 실행 시 입력 view가 바뀌어 저장하지 않았습니다. 응답을 보존합니다: {detail[:400]}")
        if not data.get("action_text_only"):   # once per task: a non-verb exact `action` target never consumes AI/f budget
            wt = self._wt(b)
            rel = stage2.task_path(task, "decisions.txt")
            current = stage2.read_rows(wt, rel)
            repaired, changed = stage2.action_target_text_only_rows(current, detail)
            if changed:
                stage2.write_decisions(wt, task, repaired, rel)
                data["action_text_only"] = changed
                self.store.log(b["id"], f"[{task}] action 정확 대상이 동사/표현이 아니어서 같은 type·tier의 text-only 행으로 "
                                        f"결정적으로 바꿔 다시 저장합니다: {', '.join(changed)}")
                return self._set(b, task, data, state="RESPONDED")
        aliases = stage2.candidate_local_failure_aliases(detail, task)
        correction = data.get("correction")
        if correction is None:
            if not aliases or not row["session_id"]:
                return self._task_failed(b, row, data, f"[{task}] 후보 단위로 결속되지 않는 저장 오류(또는 세션 없음)라 자동 수정·Drop하지 않습니다: {detail[:600]}")
            candidates = [stage2.candidate_binding_from_view(self._wt(b), task, a, row["view_sha256"],
                                                              stage2.task_path(task, "view.txt")) for a in aliases]
            if any(c is None for c in candidates):
                return self._task_failed(b, row, data, f"[{task}] 실패 후보를 view에 정확히 결속하지 못했습니다: {detail[:600]}")
            data["correction"] = {"aliases": aliases, "candidates": candidates, "initial_failure": detail,
                                  "retry_count": 1, "fix_applied": False}
            data["kind"] = "fix"
            data["fix_problem"] = stage2.compact_fix_diagnostic(detail)
            return self._set(b, task, data, state="FIXQ")
        if not correction.get("fix_applied") or correction.get("retry_count") != stage2.MAX_CANDIDATE_RETRIES:
            return self._task_failed(b, row, data, f"[{task}] 수정 증거가 완전하지 않아 중단합니다: {detail[:600]}")
        if aliases and len(aliases) == 1 and aliases[0] in correction["aliases"]:   # exactly one bound residual
            candidate = next(c for c in correction["candidates"] if c["alias"] == aliases[0])
            return self._technical_fallback(b, row, data, detail, candidate)
        self._task_failed(b, row, data, f"[{task}] 수정 후 단일 후보로 결속되지 않는 오류가 남아 자동 f를 만들지 않습니다: {detail[:600]}")

    def _technical_fallback(self, b, row, data, detail: str, candidate: dict) -> None:
        task, wt = row["task"], self._wt(b)
        rel, alias = stage2.task_path(task, "decisions.txt"), candidate["alias"]
        actual = stage2.candidate_binding_from_view(wt, task, alias, row["view_sha256"], stage2.task_path(task, "view.txt"))
        if actual != candidate:
            return self._task_failed(b, row, data, f"[{task}] fallback 후보가 원래 view의 결속과 달라 f를 만들지 않습니다")
        original = stage2.read_rows(wt, rel)
        if len([r for r in original if stage2.alias_of(r) == alias]) != 1:
            return self._task_failed(b, row, data, f"[{task}] fallback 후보의 판정 행을 하나로 결속하지 못했습니다")
        proof = {"alias": alias, "candidate": candidate["candidate"], "chunk_id": task, "failure_reason": detail,
                 "record_id": candidate["record_id"], "retry_count": 1, "sense_id": candidate["sense_id"]}
        data["correction"]["fallback"] = proof   # original evidence stays until the task is SAVED in the store
        self._set(b, task, data)
        try:
            stage2.write_decisions(wt, task, [r for r in original if stage2.alias_of(r) != alias], rel)
            self._save_task(b, None, self.store.task_row(b["id"], task), _Round(self, b), fallback=proof)
        finally:
            if self.store.task_row(b["id"], task)["state"] != "SAVED":
                stage2.write_decisions(wt, task, original, rel)

    # ---- slots ------------------------------------------------------------------------------------------------
    def _fill_slots(self, b, plan, rows, round_: _Round) -> None:
        cap = self.cfg["stage2_max_parallel"]
        active = sum(1 for r in rows.values() if r["state"] == "RUNNING")
        free = max(0, cap - active)
        if free == 0:
            return
        now = self.sup.clock()
        by_id = {t["id"]: t for t in plan["tasks"]}
        queue = [by_id[r["task"]] for r in sorted(rows.values(), key=lambda r: r["task"])
                 if r["state"] == "FIXQ" and self._data(r).get("retry_after", 0) <= now]
        queue += [t for t in stage2.ready_tasks(plan, rows) if self._data(rows[t["id"]]).get("retry_after", 0) <= now]
        if not queue:
            return
        self._start_queued(b, rows, round_, queue, free)

    def _start_allowed(self, b, round_: _Round) -> bool:
        """Boundary adoption and the pin proof, once per fill, inside the first task's launch unit."""
        if self._halted_by_boundary(b, round_):
            return False
        problem = round_.preflight()
        if problem:
            from .adapters import PREFLIGHT_PENDING
            if not problem.startswith(PREFLIGHT_PENDING):   # else still proving the pin; the next tick retries
                self.sup._fail(b, "ERROR", f"실행 전 확인 실패: {problem}")
            return False
        return True

    def _start_queued(self, b, rows, round_: _Round, queue, free) -> None:
        checked = False
        for task in queue[:free]:
            if self.store.batch(b["id"])["state"] != "PRODUCING":
                return
            with self.sup.launch_gate.unit():   # one task per admission: a closed gate stops before the next one
                if not checked:
                    if not self._start_allowed(b, round_):
                        return
                    checked = True
                self._launch_task(b, task, rows[task["id"]], round_)

    @task_launch_scope
    def _launch_task(self, b, planned, row, round_: _Round) -> None:
        task, data = row["task"], self._data(row)
        kind = data.get("kind", "new")
        wt, (bb, pp) = self._wt(b), stage2.split_key(b["batch"])
        ad, sup = self._adapter(b), self.sup
        try:
            run = sup._run(b)
        except ValueError as error:
            return sup._fail(b, "ERROR", f"실행 설정 오류로 AI를 시작하지 않았습니다: {error}")
        ts = int(sup.clock())
        while any((sup.paths.logs / f"batch-{b['id']}-{task}-{ts}.{x}").exists() for x in ("log", "exit")):
            ts += 1
        log = sup.paths.logs / f"batch-{b['id']}-{task}-{ts}.log"
        ex = sup.paths.logs / f"batch-{b['id']}-{task}-{ts}.exit"
        try:
            env = sup._launch_env(b, "s2_chunk_new", sup._agent_env())
            extra = {}
            if getattr(ad, "needs_git_dir", False):
                extra["git_dir"] = sup.git.worktree_gitdir(wt)
            checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
            defect_path = stage2.task_path(task, "shared-defect.json")
            if kind == "new":
                for name in ("decisions.txt", "shared-defect.json"):
                    (wt / stage2.task_path(task, name)).unlink(missing_ok=True)
                (wt / stage2.TASKS_DIR / task).mkdir(parents=True, exist_ok=True)
                view_info = sup.git.stage2_task_view(wt, b["shard"], bb, pp, stage2.PLAN, task, stage2.task_path(task, "view.txt"))
                view = (wt / stage2.task_path(task, "view.txt")).read_text("utf-8")
                prompt = prompts.stage2_task(b, task, view, defect_path, checkpoint)
                sha = view_info["view_sha256"]
                if hashlib.sha256(view.encode("utf-8")).hexdigest() != sha:
                    raise prompts.PromptError("task view 파일이 CLI가 보고한 해시와 다릅니다")
                handle = ad.start(prompt, wt, env, run, f"Stage 2 {stage2.label(b['shard'], b['batch'])} {task}", log, ex, **extra)
                sid = None
            else:
                sid = row["session_id"]
                if not sid:
                    raise prompts.PromptError("수정 요청에 기존 세션이 필요합니다")
                sha = row["view_sha256"]
                if kind == "fix":
                    prompt = prompts.stage2_chunk_fix(task, data["fix_problem"], checkpoint)
                else:
                    prompt = prompts.stage2_chunk_format_fix(task, data["format_problem"], checkpoint)
                handle = ad.resume(sid, prompt, wt, env, run, log, ex, **extra)
        except prompts.PromptError as error:
            return sup._fail(b, "ERROR", f"프롬프트 오류로 AI를 시작하지 않았습니다: {error}")
        except TRANSIENT:
            raise
        except Exception as error:
            return sup._fail(b, "ERROR", f"AI 실행 시작 실패 [{task}]: {error}")
        run_kind = {"new": TASK_NEW, "fix": TASK_FIX, "format_fix": TASK_FORMAT_FIX}[kind]
        run_id = self.store.add_run(b["id"], run_kind, sid, handle.pid, log, ex, model=run.model, effort=run.effort,
                                    permission_profile=run.permission_profile, task=task, fast_mode=run.fast)
        data.pop("retry_after", None)
        self._set(b, task, data, state="RUNNING", run_id=run_id, session_id=sid, view_sha256=sha,
                  attempts=row["attempts"] + 1)
        sup.store.log(b["id"], f"[{task}] 시작 ({run_kind}, model={run.model}, effort={run.effort}, "
                      f"{planned['candidate_count']}후보)")

    # ---- failures, halt, finish ---------------------------------------------------------------------------------
    def _task_failed(self, b, row, data, message: str) -> None:
        data["error"] = message
        self._set(b, row["task"], data, state="FAILED")
        self.store.log(b["id"], message, "error")

    def _halt(self, b, failed) -> None:
        """No worker is running any more: the Part goes to PAUSED (usage_limit only) or ERROR with every answer, session
        and budget preserved."""
        message = "; ".join(self._data(r).get("error", f"[{r['task']}] 실패") for r in failed)[:900]
        state = "PAUSED" if all(self._data(r).get("pause") for r in failed) else "ERROR"
        for r in failed:
            self._set(b, r["task"], self._data(r) | {"ack": True})
        self.sup._fail(b, state, f"Stage 2 병렬 primary 중지: {message}")

    def _reset_acknowledged_failures(self, b) -> None:
        """After an operator Retry brought the Part back to PRODUCING: failed tasks re-enter from what is preserved."""
        for row in self.store.task_rows(b["id"]):
            if row["state"] != "FAILED":
                continue
            data = self._data(row)
            if not data.get("ack"):
                continue
            data.pop("ack"), data.pop("error", None), data.pop("pause", None)
            wt = self._wt(b)
            correction = data.get("correction") or {}
            if data.get("kind") == "fix" and correction and not correction.get("fix_applied") and row["session_id"]:
                # #5204: the correction run itself failed (e.g. usage limit). The answer file is the rejected one, so
                # re-saving it would burn the correction budget without an AI fix; resume the correction session.
                self._hold_for_usage_limit(row, data)
                self._set(b, row["task"], data, state="FIXQ", run_id=None)
                continue
            if stage2.decision_file_state(wt, row["task"], stage2.task_path(row["task"], "decisions.txt")) == "current":
                self._set(b, row["task"], data, state="RESPONDED")   # saved again from the preserved answer, no new AI
            else:
                data.pop("kind", None)
                self._hold_for_usage_limit(row, data)
                self._set(b, row["task"], data, state="PENDING", run_id=None, session_id=None)

    def _hold_for_usage_limit(self, row, data) -> None:
        """#5921: a task whose last run died on a plan usage limit that has not reset yet must not be relaunched by an
        approved resume/Retry (it would fail again at once); the scheduler waits for the reported reset time."""
        run = self.store.run(row["run_id"]) if row["run_id"] else None
        override = int(self.store.get(adapters.usage_limit_override_key(row["batch_id"])) or 0)
        if run is not None and run["id"] <= override:
            return   # the owner's Retry came after this failure and declared the limit reset: relaunch now
        try:
            text = Path(run["log_file"]).read_text(encoding="utf-8", errors="replace") if run and run["log_file"] else ""
        except OSError:
            return
        if adapters.classify_failure(text, []) != "usage_limit":
            return
        reset = adapters.usage_limit_reset_at(text)
        if reset is not None and reset > self.sup.clock():
            data["retry_after"] = reset

    def _finish(self, b, plan) -> None:
        """Every task is SAVED: verify the totals, persist `closed` first, then continue on the existing serial path."""
        if self.sup._finalization_held(b, "s2_plan_close"):
            return   # Restart STOPPING: the saved tasks stay as they are; the next instance re-enters here from the same facts
        wt, (bb, pp) = self._wt(b), stage2.split_key(b["batch"])
        try:
            checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
            if checkpoint["decided"] != checkpoint["total"] or checkpoint["pending_chunk"] is not None:
                return self.sup._fail(b, "ERROR", f"모든 task가 SAVED지만 checkpoint가 {checkpoint['decided']}/{checkpoint['total']} 후보만 "
                                      "저장했습니다. 자동 재판정하지 않고 기록을 보존합니다.")
            self.sup.git.stage2_close_plan(wt, b["shard"], bb, pp, stage2.PLAN)
        except TRANSIENT:
            raise
        except (GitError, OSError, ValueError, KeyError, TypeError) as error:
            return self.sup._fail(b, "ERROR", f"Stage 2 병렬 plan 종료 실패: {error}. 기록을 보존합니다.")
        self.store.set(plan_key(b["id"]), "closed")
        self.store.log(b["id"], f"Stage 2 병렬 primary 완료: {len(plan['tasks'])}개 task 저장, plan 종료. 다음 단계는 기존 경로로 실행합니다.")
        self.store.update(b["id"], retries=0, retry_after=None, error=None, session_id=None)
        self.continue_after_close(self.store.batch(b["id"]))

    def continue_after_close(self, b) -> None:
        """Enter (or re-enter after a restart) the existing optional-link -> repair -> finalize path."""
        self.sup._launch_stage2_next(b)

