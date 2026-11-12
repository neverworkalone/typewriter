"""Parallel Method C chunks inside one batch (Issue #3076, PR 2): dynamic task plan, bounded scheduler, per-task recovery.

A *new* C batch (`c_mode_<batch>` = "parallel") keeps its contract - one checkpoint, one Candidate file, one PR, the
shared C cursor, claim, worktree and branch - but runs its 12-Sense chunks as up to `literary.MAX_PARALLEL` concurrent AI
runs. Chunks are rendered on demand, so the task plan is dynamic: task ID = chunk number `"NNN"` (`s2_tasks` rows of the
batch), and a task owns exactly the Senses of its `c-active-NNN.json`. The batch stays PRODUCING with
`run_kind="c_parallel"` and `pid=None`; the real executions are task runs (`runs.task`). A batch without the mode key that
is already in progress finishes serially.

C workers save through the CLI themselves (one checkpoint, changed only under its lock, per-Sense conditional), so a
chunk's completion is never taken from an exit code: it is `report --sense-ids` saying every Sense of the task is done, and
a slot is returned only after the run's process is confirmed gone. Each tick, recovery first:

1. batch boundary (the one runtime baseline, unexpected PRs), shared-defect reports of every task,
2. existing state is bound before anything new is computed: an active chunk without a task row becomes a PENDING task that
   keeps its view; an open run without a task link is reattached,
3. every open run is followed until its end is confirmed (identity, exit, session and usage go to that exact run),
4. a finished task is accepted when its Senses are all done, else corrected / recovered / skipped / failed - all per task,
5. free slots are filled: corrections and recoveries, prepared chunks (their stored view), then newly rendered chunks that
   exclude every Sense already reserved by an active chunk,
6. once every task is SAVED, no run is open and no active chunk remains, the existing `_c_finalize` exports and opens the PR;
   a Candidate repair keeps the existing serial singleton path.

Task states: PENDING (prepared or waiting for a retry time), RUNNING (a live or just ended run), FIXQ (a correction /
recovery / continuation waits for a slot), SAVED, FAILED (stops new launches and is kept for the operator).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from . import literary, prompts, taskruns
from .gitops import GitError, GitTransient
from .launch_gate import task_launch_scope
from .github import GhTransient
from .usage import official_c_stop_diagnostics, submit_attempts

RUN_KIND = "c_parallel"
TRANSIENT = (GhTransient, GitTransient)
PARALLEL = "parallel"
NEW, RESUME, FIX, RECOVERY = "c_chunk_new", "c_chunk_resume", "c_chunk_fix", "c_chunk_recovery"
SCOPE_RECOVERY = "c_chunk_scope_recovery"
LEGACY_CHUNK_SCOPE_RECOVERY = "legacy_cli_chunk_scope"
AUTO_FIX_LIMIT = 2   # automatic same-session corrections per task; an operator Retry adds one more chance per epoch
EMPTY_RENDERS = 60   # ZERO_HITS-only views in a row before a selection is considered stuck
_ERRORS = (literary.LiteraryError, OSError, ValueError, KeyError, TypeError)


def mode_key(batch_id: int) -> str:
    return f"c_mode_{batch_id}"


def epoch_key(batch_id: int) -> str:
    """Count of operator Retries consumed from ERROR; only this ever grants a task an extra correction chance."""
    return f"c_parallel_retry_epoch_{batch_id}"


def is_parallel(store, b) -> bool:
    return b["method"] == literary.METHOD and store.get(mode_key(b["id"])) == PARALLEL


def defect_path(b, task: str) -> str:
    """Worktree-relative path of this chunk worker's own shared-defect report."""
    return f"{literary.SCRATCH}/shared-defect-c-{task}.json"


def _data(row) -> dict:
    try:
        data = json.loads(row["data"] or "{}")
    except ValueError:
        data = {}
    return data if isinstance(data, dict) else {}


def _fix_budget_used(data: dict) -> int:
    """Count submitted corrections plus bounded no-submit sample continuations."""
    completed = data.get("completed_fix_runs", [])
    sample_runs = data.get("sample_fix_runs", [])
    if not isinstance(completed, list) or not isinstance(sample_runs, list):
        return AUTO_FIX_LIMIT + int(data.get("operator_grants", 0))
    return len(completed) + len(sample_runs)


def _command_failed(fact: dict) -> bool | None:
    """Resolve exact exit codes or adapter error flags; contradictory or absent evidence stays unknown."""
    code = fact.get("exit_code")
    tool_error = fact.get("tool_error")
    exact_code = type(code) is int
    exact_flag = type(tool_error) is bool
    if exact_code and exact_flag and tool_error != (code != 0):
        return None
    if exact_code:
        return code != 0
    if exact_flag:
        return tool_error
    return None


def baseline(store, b) -> dict | None:
    """The batch's current approved runtime baseline (`c_run_start_<id>`), or None when absent or damaged."""
    try:
        base = json.loads(store.get(literary.run_start_key(b["id"])) or "null")
    except ValueError:
        return None
    return base if isinstance(base, dict) and isinstance(base.get("head"), str) else None


def retry_block_reason(store, b) -> str | None:
    """Operator Retry gate of a parallel ERROR: every failed task that recorded an incomplete-run guard still shows the
    evidence of its failure, and no failed task lacks such a guard. The whole checkpoint file is never compared."""
    rows = store.task_rows(b["id"])
    failed = [r for r in rows if r["state"] == "FAILED"]
    if not failed or not isinstance(b["worktree"], str) or not b["worktree"]:
        return None
    codes = []
    for row in failed:
        guard = _data(row).get("guard")
        if not isinstance(guard, dict) or not isinstance(guard.get("baseline"), dict):
            return None   # a failure without recorded guard evidence (auth, usage limit, ...) may always be retried
        if not literary.task_retry_unchanged(Path(b["worktree"]), b, int(row["task"]), guard["baseline"],
                                             session_available=bool(row["session_id"])):
            return None
        codes.extend(guard.get("reason_codes") or [])
    if len(failed) == 1:
        row = failed[0]
        guard = _data(row).get("guard")
        legacy_stop = _legacy_reported_stop_retry_status(store, b, row, guard)
        if legacy_stop == "retry_available":
            return None   # a reported stop with no source-bound CLI stop remains an ordinary operator Retry
        if legacy_stop is not None:
            codes = [legacy_stop]  # replace the old generic code with current source-bound evidence
        elif _legacy_shown_only_retry_available(store, b, row, guard):
            return None   # one owner Retry recovers this exact pre-policy 16-context no-submit task
    return (f"[same_failure; {','.join(dict.fromkeys(codes)) or 'checkpoint_or_chunk_mismatch'}] 실패한 task의 Sense·제출·진단 "
            "evidence가 그대로여서 Retry를 막았습니다. 증거가 바뀐 뒤 재시도하세요.")


def _legacy_shown_only_guard(data: dict, guard) -> bool:
    """Only the known pre-field-summary guard gets the one-time compatibility path."""
    codes = guard.get("reason_codes") if isinstance(guard, dict) else None
    start = data.get("run_start") if isinstance(data, dict) else None
    retry = start.get("retry_state") if isinstance(start, dict) else None
    return (codes == ["checkpoint_changed_without_pending_progress"]
            and isinstance(retry, dict) and isinstance(retry.get("own_state"), str))


def _legacy_shown_only_retry_available(store, b, row, guard) -> bool:
    """Prove the specific pre-policy task 16-context case before allowing one explicit Retry."""
    data = _data(row)
    if (not _legacy_shown_only_guard(data, guard) or data.get("recovery")
            or data.get("operator_grants", 0) != 0 or data.get("completed_fix_runs")
            or data.get("auto_fix_runs")):
        return False
    baseline_state = guard.get("baseline") if isinstance(guard, dict) else None
    start = data.get("run_start")
    retry = start.get("retry_state") if isinstance(start, dict) else None
    if (not isinstance(baseline_state, dict) or not isinstance(retry, dict)
            or not isinstance(baseline_state.get("own_state"), str)
            or baseline_state.get("own_state") == retry.get("own_state")):
        return False
    try:
        rec = literary.read_active(Path(b["worktree"]), b, int(row["task"]))
        if not literary.task_retry_unchanged(Path(b["worktree"]), b, int(row["task"]), baseline_state,
                                             session_available=bool(row["session_id"])):
            return False
        raw_run = store.run(row["run_id"]) if row["run_id"] is not None else None
        run = dict(raw_run) if raw_run is not None else None
        runtime = baseline(store, b)
        if (rec is None or not isinstance(run, dict) or run.get("task") != row["task"]
                or run.get("kind") != NEW or str(run.get("exit_status")) != "0"
                or run.get("ended_at") is None or run.get("session_id") != row["session_id"]
                or not row["session_id"] or start.get("branch") != b["branch"]
                or Path(start.get("worktree", "")) != Path(b["worktree"])
                or not isinstance(runtime, dict) or start.get("head") != runtime.get("head")
                or start.get("remote_head") != runtime.get("remote_head")
                or start.get("head") != rec.get("git_head") or start.get("chunk_no") != rec.get("chunk_no")
                or retry.get("chunk_id") != rec.get("chunk_id")
                or retry.get("chunk_no") != rec.get("chunk_no")
                or retry.get("view_sha256") != rec.get("view_sha256")
                or retry.get("repair") is not False
                or retry.get("pending_sense_ids") != rec.get("sense_ids")
                or baseline_state.get("pending_sense_ids") != rec.get("sense_ids")):
            return False
        submit = Path(b["worktree"]) / f"{literary.names(b).submit_prefix}{rec['chunk_no']:03d}.submit.json"
        if submit.exists() or submit.with_name(submit.name + ".diag.json").exists():
            return False
        from .adapters import final_answer
        from .usage import submit_attempts
        log = Path(run["log_file"]) if run.get("log_file") else None
        answer = final_answer(log) if log else None
        if log is None or submit_attempts(log) != 0 or not answer or literary.reported_stop(answer):
            return False
        return literary.legacy_shown_only_sample(Path(b["worktree"]), b, rec, rec["sense_ids"])
    except (OSError, ValueError, KeyError, TypeError, literary.LiteraryError):
        return False


def _legacy_reported_stop_retry_status(store, b, row, guard) -> str | None:
    """Reclassify a pre-policy text stop from its original run before exposing a normal operator Retry."""
    data = _data(row)
    if not isinstance(guard, dict) or guard.get("reason_codes") != ["producer_reported_stop"]:
        return None
    if (data.get("recovery") or data.get("operator_grants", 0) != 0
            or data.get("completed_fix_runs") or data.get("auto_fix_runs") or data.get("progress_retry")
            or data.get("last_operator_retry_epoch", 0)):
        return "legacy_retry_already_used"
    baseline_state = guard.get("baseline")
    start = data.get("run_start")
    retry = start.get("retry_state") if isinstance(start, dict) else None
    pending = baseline_state.get("pending_sense_ids") if isinstance(baseline_state, dict) else None
    if not isinstance(pending, list) or not pending or not isinstance(retry, dict):
        return "legacy_recheck_unavailable"
    try:
        wt = Path(b["worktree"])
        rec = literary.read_active(wt, b, int(row["task"]))
        if rec is None or not literary.task_retry_unchanged(wt, b, int(row["task"]), baseline_state,
                                                             session_available=bool(row["session_id"])):
            return "legacy_evidence_changed"
        raw_run = store.run(row["run_id"]) if row["run_id"] is not None else None
        run = dict(raw_run) if raw_run is not None else None
        runtime = baseline(store, b)
        if (run is None or run.get("task") != row["task"] or run.get("kind") not in (NEW, RESUME)
                or str(run.get("exit_status")) != "0" or run.get("ended_at") is None
                or run.get("session_id") != row["session_id"] or not row["session_id"]
                or start.get("branch") != b["branch"] or Path(start.get("worktree", "")) != wt
                or not isinstance(runtime, dict) or start.get("head") != runtime.get("head")
                or start.get("remote_head") != runtime.get("remote_head")
                or start.get("head") != rec.get("git_head") or start.get("chunk_no") != rec.get("chunk_no")
                or retry.get("chunk_id") != rec.get("chunk_id") or retry.get("chunk_no") != rec.get("chunk_no")
                or retry.get("view_sha256") != rec.get("view_sha256") or retry.get("repair") is not False
                or not isinstance(retry.get("pending_sense_ids"), list)
                or not retry.get("pending_sense_ids") or retry.get("pending_sense_ids") != pending
                or any(sense_id not in rec.get("sense_ids", []) for sense_id in pending)):
            return "legacy_recheck_unavailable"
        submit = wt / f"{literary.names(b).submit_prefix}{rec['chunk_no']:03d}.submit.json"
        if submit.exists() or submit.with_name(submit.name + ".diag.json").exists():
            return "submission_artifact_present"
        from .adapters import final_answer
        log = Path(run["log_file"]) if run.get("log_file") else None
        answer = final_answer(log) if log else None
        if log is None or submit_attempts(log) != 0 or not answer:
            return "legacy_recheck_unavailable"
        outcome = literary.no_submission_result(
            wt, b, rec, run, start, pending, final_answer=answer, submit_call_count=0,
            task_session=row["session_id"], own_state_now=literary.own_state(wt, b, rec["sense_ids"]))
        if outcome.get("status") in ("no_submission", "shown_only_progress") and literary.reported_stop(answer):
            return "retry_available"
        return str(outcome.get("status") or "legacy_recheck_unavailable")
    except (OSError, ValueError, KeyError, TypeError, literary.LiteraryError):
        return "legacy_recheck_unavailable"


def _legacy_scope_recovery_proven(store, b, row, data, run, rec, pending, outcome) -> bool:
    """Prove one task-local, read-only scope rejection before scheduling a same-session recovery."""
    try:
        run = dict(run)
        if (row["state"] not in ("RUNNING", "FAILED") or int(row["attempts"] or 0) != 1
                or row["run_id"] != run.get("id") or run.get("task") != row["task"]
                or run.get("kind") != NEW or str(run.get("exit_status")) != "0" or run.get("ended_at") is None
                or not row["session_id"] or run.get("session_id") != row["session_id"]
                or data.get("kind") not in (None, "new") or data.get("recovery") or data.get("fix_launch")
                or data.get("completed_fix_runs") or data.get("auto_fix_runs") or data.get("transient_retries", 0)
                or data.get("progress_retry") or data.get("operator_grants", 0) != 0
                or data.get("last_operator_retry_epoch", 0) != 0):
            return False
        if any(open_run["task"] == row["task"] for open_run in store.open_task_runs(b["id"])):
            return False
        task_runs = [item for item in store.runs(b["id"]) if item["task"] == row["task"]]
        if len(task_runs) != 1 or task_runs[0]["id"] != run["id"]:
            return False

        start = data.get("run_start")
        retry = start.get("retry_state") if isinstance(start, dict) else None
        runtime = baseline(store, b)
        chunk_no = int(row["task"])
        worktree = Path(b["worktree"])
        if (not isinstance(start, dict) or not isinstance(retry, dict) or not isinstance(runtime, dict)
                or start.get("branch") != b["branch"] or Path(start.get("worktree", "")) != worktree
                or start.get("head") != runtime.get("head") or start.get("remote_head") != runtime.get("remote_head")
                or start.get("head") != rec.get("git_head") or start.get("chunk_id") != rec.get("chunk_id")
                or start.get("chunk_no") != chunk_no
                or rec.get("chunk_no") != chunk_no or rec.get("repair") is True
                or retry.get("chunk_id") != rec.get("chunk_id") or retry.get("chunk_no") != chunk_no
                or retry.get("view_sha256") != rec.get("view_sha256") or retry.get("repair") is not False
                or pending != rec.get("sense_ids") or retry.get("pending_sense_ids") != pending
                or not isinstance(retry.get("own_state"), dict)):
            return False
        view_ids, failed, unsearchable = literary.view_ids(literary.read_view(worktree, rec, chunk_no))
        own_state = literary.own_state(worktree, b, rec["sense_ids"])
        run_start_state = retry.get("own_state")
        state_unchanged = own_state == run_start_state
        shown_progress = literary.shown_only_progress(run_start_state, own_state)
        if (view_ids != rec["sense_ids"] or failed or unsearchable
                or not state_unchanged and shown_progress is None):
            return False
        if row["state"] == "FAILED":
            guard = data.get("guard")
            if (not isinstance(guard, dict) or guard.get("reason_codes") not in (["cli_chunk_scope"], ["producer_reported_stop"])
                    or not isinstance(guard.get("baseline"), dict)
                    or guard["baseline"].get("pending_sense_ids") != pending
                    or guard["baseline"].get("own_state") != own_state
                    or not literary.task_retry_unchanged(worktree, b, chunk_no, guard["baseline"],
                                                         session_available=True)):
                return False
        if outcome.get("status") != "cli_chunk_scope" or outcome.get("operation") != "chunk":
            return False
        diagnostics = outcome.get("stop_diagnostics")
        commands = outcome.get("checkpoint_commands")
        if not isinstance(diagnostics, list) or len(diagnostics) != 1 or not isinstance(commands, list) or not commands:
            return False
        diagnostic, command = diagnostics[0], commands[-1]
        if (not isinstance(diagnostic, dict) or diagnostic.get("operation") != "chunk"
                or diagnostic.get("diagnostic") != "chunk_scope" or diagnostic.get("error_code") != "LITERARY_CHUNK_SCOPE"
                or diagnostic.get("occurrences") != 1 or diagnostic.get("chunk_no") != chunk_no
                or not isinstance(command, dict) or command.get("operation") != "chunk"
                or command.get("checkpoint_matches") is not True or command.get("chunk_no") != chunk_no
                or _command_failed(command) is not True):
            return False
        requested = diagnostic.get("sense_ids")
        if (not isinstance(requested, list) or not requested or len(set(requested)) != len(requested)
                or requested != command.get("sense_ids")):
            return False
        allowed = set(rec["sense_ids"])
        invalid = [sense_id for sense_id in requested if sense_id not in allowed]
        # A mixed request keeps the CLI's two-ID filter bound. A request made only of unassigned IDs (e.g. a
        # neighbouring headword's invented sense group) returned nothing, so its read-only rejection is provable
        # for any size: it must not be left blocked merely because the wrong group had three senses.
        if not invalid or (len(invalid) > 2 and len(invalid) != len(requested)):
            return False

        # Earlier same-task chunk reads may extend shown-context evidence. Require every prior call to be a
        # successful read against this exact checkpoint/chunk, with at least one assigned ID and no more than the
        # CLI's two-ID read-filter allowance. The final scope failure may contain only unassigned IDs; its one-time
        # same-session resume is still bounded to the active pending IDs in the generated prompt.
        for fact in commands[:-1]:
            if (not isinstance(fact, dict) or fact.get("operation") != "chunk"
                    or fact.get("checkpoint_matches") is not True or fact.get("chunk_no") != chunk_no
                    or _command_failed(fact) is not False):
                return False
            read_ids = fact.get("sense_ids")
            if not isinstance(read_ids, list) or not read_ids or len(set(read_ids)) != len(read_ids):
                return False
            read_valid = [sense_id for sense_id in read_ids if sense_id in allowed]
            read_invalid = [sense_id for sense_id in read_ids if sense_id not in allowed]
            if not read_valid or len(read_invalid) > 2:
                return False

        log = Path(run["log_file"]) if run.get("log_file") else None
        submit = worktree / f"{literary.names(b).submit_prefix}{chunk_no:03d}.submit.json"
        if (log is None or submit_attempts(log) != 0 or submit.exists()
                or submit.with_name(submit.name + ".diag.json").exists()):
            return False
        if not isinstance(runtime, dict) or runtime.get("branch") != b["branch"] or runtime.get("worktree") != str(worktree):
            return False
        return True
    except (OSError, ValueError, KeyError, TypeError, literary.LiteraryError):
        return False


class _Round:
    """The common lookups of ONE processing round, made lazily and shared by every launch/accept in it."""

    def __init__(self, cp, b):
        self.cp, self.b = cp, b
        self._unset = object()
        self._remote = self._pr = self._preflight = self._unset
        self.force = False        # an operator Retry re-entered a task: prepared tasks are proved against the checkpoint again
        self.block_new = False    # an open run could not be linked to a task: it is followed, but nothing new starts
        self.boundary = None      # None: not checked this round; otherwise whether a launch is allowed

    def remote(self):
        if self._remote is self._unset:
            self._remote = self.cp.sup.git.remote_head(self.b["branch"])
        return self._remote

    def pr(self):
        if self._pr is self._unset:
            self._pr = self.cp.sup._find_recovery_pr(self.b)
        return self._pr

    def preflight(self):
        if self._preflight is self._unset:
            self._preflight = self.cp.sup._preflight(self.b["producer"], self.b["method"], self.b["model_tier"])
        return self._preflight


class ParallelC:
    def __init__(self, sup):
        self.sup = sup
        self._seen: set[int] = set()   # batches polled since this process started (prepared tasks are re-proved once)

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

    def _env(self, b) -> dict:
        return self.sup._c_env(b)

    def _set(self, b, task: str, data: dict | None = None, **fields) -> None:
        if data is not None:
            fields["data"] = json.dumps(data, ensure_ascii=False, sort_keys=True)
        self.store.update_task(b["id"], task, **fields)

    def workers_alive(self, b) -> bool:
        return taskruns.workers_alive(self.store, self._adapter(b), b["id"])

    def stop_workers(self, b, acknowledge: bool = False) -> bool:
        """Ask every live task process to stop; True once all are confirmed gone and their runs closed.

        A run that had exited 0 keeps its status so the next poll still reads its result. Any other stopped run returns
        its task to what it can restart from. Stored Senses and every budget are untouched."""
        self._seen.discard(b["id"])   # prepared tasks are proved against the checkpoint before any new assignment
        if acknowledge:   # only the operator's own Stop acknowledges failures; an automatic stop (shared defect) keeps them
            for row in self.store.task_rows(b["id"]):
                data = _data(row)
                if row["state"] == "FAILED" and not data.get("ack"):
                    self._set(b, row["task"], data | {"ack": True})

        def returned(run):
            row = self.store.task_row(b["id"], run["task"])
            if row is not None and row["state"] == "RUNNING" and row["run_id"] == run["id"]:
                self._requeue(b, row, _data(row))
        return taskruns.stop_open_runs(self.store, self._adapter(b), b["id"], returned)

    # ---- batch start ---------------------------------------------------------------------------------------------
    def starts_fresh(self, b) -> bool:
        """A batch with no mode, run, baseline, checkpoint or active chunk is new: it takes the parallel path.
        Anything else without the mode key is an in-progress serial batch and finishes serially."""
        if self.store.get(mode_key(b["id"])) is not None:
            return False
        if self.store.runs(b["id"]) or self.store.get(literary.run_start_key(b["id"])) is not None:
            return False
        try:
            return not literary.checkpoint_exists(self._wt(b), b) and not literary.active_chunks(self._wt(b), b) \
                and literary.read_active(self._wt(b), b) is None
        except _ERRORS:
            return False   # the serial path reports the damaged scratch

    def needs_begin(self, b) -> bool:
        """A new batch, or one interrupted between persisting the mode and starting the scheduler (idempotent begin)."""
        if not is_parallel(self.store, b):
            return self.starts_fresh(b)
        return (not self.store.task_rows(b["id"]) and not self.store.runs(b["id"]) and not b["run_kind"])

    def begin(self, b) -> None:
        """Persist the mode BEFORE the checkpoint exists, then the batch's Git boundary, and start the scheduler."""
        wt = self._wt(b)
        try:
            head, remote = self.sup.git.head(wt), self.sup.git.remote_head(b["branch"])
            source = wt / literary.names(b).canonical
            canonical = hashlib.sha256(source.read_bytes()).hexdigest() if source.is_file() else None   # `init` rejects a missing shard
        except TRANSIENT:
            raise
        except (GitError, OSError, ValueError, KeyError) as error:
            return self.sup._fail(b, "ERROR", f"C 병렬 task 계획 준비 실패: {error}. worktree를 보존합니다.")
        self.store.set(mode_key(b["id"]), PARALLEL)
        if self.store.get(literary.run_start_key(b["id"])) is None:   # the one runtime baseline (Maintainer retargets it)
            self.store.set(literary.run_start_key(b["id"]), json.dumps(
                {"branch": b["branch"], "worktree": str(b["worktree"]), "head": head, "remote_head": remote,
                 "canonical_sha256": canonical}, sort_keys=True))
        try:
            if not literary.checkpoint_exists(wt, b):
                literary.init_checkpoint(self.sup.runner, self._env(b), wt, b, self.sup._c_db())
            elif problem := self.sup._c_head_problem(b, wt):
                return self.sup._fail(b, "ERROR", problem + " worktree를 보존합니다.")
        except TRANSIENT:
            raise
        except _ERRORS + (GitError,) as error:
            return self.sup._fail(b, "ERROR", f"Method C 상태 확인 실패: {error}. worktree를 보존합니다.")
        self.store.update(b["id"], state="PRODUCING", run_kind=RUN_KIND, pid=None, session_id=None,
                          retries=0, retry_after=None, error=None)
        self.store.log(b["id"], f"C 병렬 청크 실행: 동시 상한 {literary.MAX_PARALLEL}")
        self.poll(self.store.batch(b["id"]))

    # ---- one scheduling tick -----------------------------------------------------------------------------------
    def poll(self, b) -> None:
        try:
            self._poll(b)
        except TRANSIENT as error:
            self.sup._transient_wait(f"b{b['id']}:c_parallel", error, b["id"])

    def _poll(self, b) -> None:
        self.sup._record_progress(b)
        if self.sup._scan_task_reports(b, self):
            return
        round_ = _Round(self, b)
        first = b["id"] not in self._seen
        self._seen.add(b["id"])
        if not self._adopt(b):
            return
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
        self._fill_slots(b, rows, round_)
        self._maybe_finalize(self.store.batch(b["id"]))

    def _maybe_finalize(self, b) -> None:
        if b["state"] != "PRODUCING" or b["run_kind"] != RUN_KIND:
            return
        rows = self.store.task_rows(b["id"])
        if any(r["state"] != "SAVED" for r in rows) or taskruns.slots_used(self.store, b["id"]):
            return
        try:
            if literary.active_chunks(self._wt(b), b):
                return
            done = literary.all_done(literary.summary(self.sup.runner, self._env(b), self._wt(b), b))
        except _ERRORS as error:
            return self.sup._fail(b, "ERROR", f"C 병렬 최종화 전 상태 확인 실패: {error}. worktree를 보존합니다.")
        if done:
            self.sup._c_finalize(b)   # export, Candidate commit, PR; a Candidate repair keeps the singleton serial path

    # ---- existing state binding (before any new computation) ---------------------------------------------------
    def _adopt(self, b) -> bool:
        """An active chunk without a task row is a prepared task (it keeps its view, is never re-rendered)."""
        try:
            actives = literary.active_chunks(self._wt(b), b)
        except _ERRORS as error:
            self.sup._fail(b, "ERROR", f"C 병렬 활성 청크 기록을 읽지 못했습니다: {error}. 보존합니다.")
            return False
        known = {r["task"] for r in self.store.task_rows(b["id"])}
        for number, rec in actives.items():
            task = f"{number:03d}"
            if task not in known:
                self.store.add_tasks(b["id"], [(task, task)])
                self._set(b, task, {}, state="PENDING", view_sha256=rec["view_sha256"])
                self.store.log(b["id"], f"[{task}] 활성 청크를 task로 채택했습니다 (view 보존)")
        return True

    # ---- Git boundary ----------------------------------------------------------------------------------------
    def _boundary_problem(self, b, round_: _Round, base_override: dict | None = None) -> str | None:
        """The single runtime baseline: HEAD must equal it (an older approved HEAD is no longer valid), the remote ref must
        be as recorded and no PR may exist. Local checks every time; remote ref and PR lookups once per round."""
        if base_override is None:
            self.sup.maint.adopt_released_baseline(b)   # crash between a Maintainer release and its baseline write
        try:
            base = base_override if base_override is not None else baseline(self.store, b)
            if base is None or base.get("branch") != b["branch"] or base.get("worktree") != str(b["worktree"]):
                return "C 병렬 배치의 Git 경계 기준이 없거나 다른 실행을 가리킵니다. worktree를 보존합니다."
            head = self.sup.git.head(self._wt(b))
            if head != base["head"]:
                return f"C 병렬 실행 중 소유 HEAD가 현재 승인 기준과 다릅니다 ({base['head']} / {head}). 후속 실행을 중단합니다."
            if round_.remote() != base.get("remote_head"):
                return (f"C 병렬 실행 중 원격 브랜치 {b['branch']}가 변경됐습니다 "
                        f"({base.get('remote_head')} / {round_.remote()}). 후속 실행을 중단합니다.")
            info = round_.pr()
            if info is not None:
                return f"C 병렬 실행 중 소유 브랜치에 예상하지 않은 PR #{info['number']}이 있습니다. PR과 worktree를 보존합니다."
        except TRANSIENT:
            raise
        except Exception as error:   # RecoveryBlocked, GitError, ...
            return f"C 병렬 배치의 Git/PR 경계를 확인하지 못했습니다: {error}. worktree를 보존합니다."
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
            if row is None:
                round_.block_new = True   # followed to its end, but nothing new starts while it cannot be explained
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
        data = _data(row)
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
        self._after_run(b, row, data, run, code, round_)

    def _pending(self, b, rec: dict) -> list[str]:
        report = literary.sense_report(self.sup.runner, self._env(b), self._wt(b), b, rec["sense_ids"])
        return [s["sense_id"] for s in report["senses"] if not s["done"]]

    def _after_run(self, b, row, data, run, code, round_: _Round) -> None:
        task, n = row["task"], int(row["task"])
        ad = self._adapter(b)
        if code is None:
            return self._task_failed(b, row, data, f"[{task}] AI 프로세스가 종료 상태 기록 없이 사라졌습니다. 결과·세션을 보존합니다.")
        cls = self.sup._classify_run(b["producer"], run["log_file"]) if code != 0 else None
        if cls == "fast_unavailable":
            return self._task_failed(b, row, data, f"[{task}] {self.sup._fast_unavailable_message(run['log_file'])}")
        try:
            rec = literary.read_active(self._wt(b), b, n)
            if rec is None:
                return self._task_failed(b, row, data, f"[{task}] 활성 청크 기록이 없습니다. 보존합니다.")
            pending = self._pending(b, rec)
        except _ERRORS as error:
            return self._task_failed(b, row, data, f"[{task}] 청크 완료 상태를 확인하지 못했습니다: {error}. 보존합니다.")
        if run["kind"] == FIX:
            self._complete_fix(b, row, data, run)
        if not pending:
            if code != 0:   # an ordinary non-zero exit after the saved Senses is accepted only with a proven run identity
                if ad.output_identity_problem(Path(run["log_file"]), taskruns.recorded_spec(run), row["session_id"],
                                              b["worktree"], self.sup.env) is not None:
                    return self._task_failed(b, row, data, f"[{task}] 비정상 종료 뒤 저장된 청크의 실행 identity를 확인하지 못했습니다. 보존합니다.")
                self.store.log(b["id"], f"[{task}] 비정상 종료(코드 {code})지만 모든 Sense 저장과 실행 identity를 확인해 수락 경로로 진행합니다", "warn")
            return self._accept(b, row, data, round_)
        if code != 0:
            return self._run_failed(b, row, data, run, code, cls)
        self._unsaved(b, row, data, run, rec, pending, round_)

    def _complete_fix(self, b, row, data, run) -> None:
        """A correction counts as completed only when it ended with a proven identity AND the log shows an official submit."""
        log = Path(run["log_file"])
        if submit_attempts(log) in (None, 0) or run["id"] in data.get("completed_fix_runs", []):
            return
        data.setdefault("completed_fix_runs", []).append(run["id"])
        if data.get("fix_launch", {}).get(str(run["id"])) == "auto":
            data.setdefault("auto_fix_runs", []).append(run["id"])
        self._set(b, row["task"], data)

    def _run_failed(self, b, row, data, run, code: int, cls: str | None = None) -> None:
        task = row["task"]
        if run["kind"] == SCOPE_RECOVERY:
            try:
                rec = literary.read_active(self._wt(b), b, int(task))
                pending = self._pending(b, rec) if rec is not None else []
                if rec is not None:
                    return self._incomplete_failed(b, row, data, rec, pending,
                                                   {"status": "scope_recovery_run_failed"})
            except _ERRORS:
                pass
            return self._task_failed(b, row, data, f"[{task}] legacy chunk_scope 복구 실행이 실패했습니다. 파일과 세션을 보존합니다.")
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
        """Return a task whose run ended without finishing its Senses to the state it can restart from (files and
        budgets kept): a correction stays a correction; otherwise its remaining Senses go to a new self-contained session."""
        task = row["task"]
        try:
            prepared = literary.read_active(self._wt(b), b, int(task)) is not None
        except _ERRORS:
            prepared = False
        if not prepared:
            data.pop("kind", None)
            return self._set(b, task, data, state="PENDING", run_id=None, session_id=None)
        if data.get("kind") not in ("fix", "recovery", "scope_recovery"):
            data["kind"] = "new"
            data["continued"] = True
        self._set(b, task, data, state="FIXQ", run_id=None)

    # ---- an unfinished task: correction, skip, recovery, continuation, failure ------------------------------
    def _fix_allowed(self, data: dict) -> bool:
        """Bound submitted fixes and source-sample continuations by the same automatic/granted correction budget."""
        return _fix_budget_used(data) < AUTO_FIX_LIMIT + int(data.get("operator_grants", 0))

    def _sample_followup_targets(self, b, row, data, run, rec, pending) -> list[str]:
        """Allow another bounded C fix only after a successful no-submit run made source-bound sample progress.

        The exact submit diagnostic may advance to a second empty Sense when the Supervisor revalidates the unchanged
        file after the first Sense's sample becomes complete. Queue that newly exposed Sense instead of ending the task.
        """
        if (run["kind"] != FIX or run["id"] != row["run_id"] or run["task"] != row["task"]
                or str(run["exit_status"]) != "0" or run["ended_at"] is None
                or run["session_id"] != row["session_id"] or not row["session_id"]
                or run["id"] in data.get("completed_fix_runs", [])):
            return []
        start = data.get("run_start")
        baseline_state = start.get("retry_state") if isinstance(start, dict) else None
        if (not isinstance(start, dict) or not isinstance(baseline_state, dict)
                or start.get("branch") != b["branch"] or Path(start.get("worktree", "")) != Path(b["worktree"])
                or start.get("head") != rec.get("git_head") or start.get("chunk_no") != rec.get("chunk_no")
                or baseline_state.get("chunk_id") != rec.get("chunk_id")
                or baseline_state.get("view_sha256") != rec.get("view_sha256")
                or baseline_state.get("pending_sense_ids") != pending
                or not isinstance(baseline_state.get("own_state"), dict)):
            return []
        log = Path(run["log_file"]) if run["log_file"] else None
        if log is None or submit_attempts(log) != 0:
            return []
        try:
            current_state = literary.own_state(self._wt(b), b, rec["sense_ids"])
            progressed = literary.shown_only_progress(baseline_state["own_state"], current_state)
            if not progressed:
                return []
            targets = literary.unshown_empty_sample_targets(self._wt(b), b, rec["chunk_no"])
            if not targets:
                return []
            current_retry = literary.retry_state(self._wt(b), b, rec, pending,
                                                  session_available=True, task_state=True)
        except _ERRORS:
            return []
        if (baseline_state.get("diagnostic") == current_retry.get("diagnostic")
                and not set(targets).intersection(progressed)):
            return []
        return targets

    def _queue_sample_followup(self, b, row, data, run, rec, pending) -> bool:
        targets = self._sample_followup_targets(b, row, data, run, rec, pending)
        if not targets or not self._fix_allowed(data):
            return False
        runs = data.setdefault("sample_fix_runs", [])
        if run["id"] in runs:
            return False
        runs.append(run["id"])
        data["kind"] = "fix"
        self._set(b, row["task"], data, state="FIXQ", run_id=None)
        budget = _fix_budget_used(data)
        limit = AUTO_FIX_LIMIT + int(data.get("operator_grants", 0))
        self.store.log(b["id"], f"[{row['task']}] 공식 재검증에서 새 미노출 빈 표본을 확인했습니다. "
                       f"현재 진단의 Sense {', '.join(targets)}만 같은 세션에서 이어갑니다 "
                       f"(수정 예산 {budget}/{limit})", "warn")
        return True

    def _unsaved(self, b, row, data, run, rec, pending, round_: _Round) -> None:
        task, n, wt, sid = row["task"], int(row["task"]), self._wt(b), row["session_id"]
        names = literary.names(b)
        submit = wt / f"{names.submit_prefix}{n:03d}.submit.json"
        diagnostic = submit.with_name(submit.name + ".diag.json")
        try:
            if run["kind"] == SCOPE_RECOVERY:
                return self._incomplete_failed(b, row, data, rec, pending,
                                               {"status": "scope_recovery_not_saved"})
            if literary.deterministic_context_trim_candidate(wt, b, n):
                refreshed = literary.revalidate_submit_before_skip(self.sup.runner, self._env(b), wt, b, n, scoped=True)
                if refreshed is not None:
                    if self._pending(b, rec):
                        return self._task_failed(b, row, data, f"[{task}] 결정적 CLI 복구 뒤에도 청크 완료를 확인하지 못했습니다. 보존합니다.")
                    self.store.log(b["id"], f"[{task}] 변경 없는 제출을 일반 CLI로 재검증해 저장했습니다 (문맥 키 공백 정규화).", "warn")
                    return self._accept(b, row, data, round_)
            if literary.deterministic_context_sample_candidate(wt, b, n):
                refreshed = literary.revalidate_submit_before_skip(self.sup.runner, self._env(b), wt, b, n, scoped=True)
                if refreshed is not None:
                    if self._pending(b, rec):
                        return self._task_failed(b, row, data, f"[{task}] 완전한 문맥 표본의 결정적 재제출 뒤에도 청크 완료를 확인하지 못했습니다. 보존합니다.")
                    self.store.log(b["id"], f"[{task}] 변경 없는 빈 결과 제출을 공식 CLI로 재검증해 저장했습니다 (unshown_empty_sample 표본 완료).", "warn")
                    return self._accept(b, row, data, round_)
            # Refresh legacy key diagnostics through the official scoped CLI. A newly located key is
            # actionable evidence, not permission to guess or edit its value.
            if (diagnostic.is_file() and literary.technical_skip_reason_code(wt, b, n) is None
                    and literary.context_key_diagnostic_position(wt, b, n) is None
                    and not data.get("key_position_refresh")):
                old = json.loads(diagnostic.read_text("utf-8"))
                if old.get("reason") in ("context_key_not_found", "context_key_ambiguous", "context_key_too_short"):
                    data["key_position_refresh"] = True
                    refreshed = literary.revalidate_submit_before_skip(self.sup.runner, self._env(b), wt, b, n, scoped=True)
                    if refreshed is not None:
                        if self._pending(b, rec):
                            return self._task_failed(b, row, data, f"[{task}] CLI 재검증 뒤 청크 완료를 확인하지 못했습니다.")
                        return self._accept(b, row, data, round_)
                    if (run["kind"] == FIX and self._fix_allowed(data)
                            and literary.context_key_diagnostic_position(wt, b, n) is not None):
                        data["kind"] = "fix"
                        self._set(b, task, data, state="FIXQ", run_id=None)
                        return self.store.log(b["id"], f"[{task}] 공식 CLI가 거부된 문맥 키 위치를 확인했습니다. 같은 세션에서 수정합니다.", "warn")
            no_submit_fix = run["kind"] == FIX and run["id"] not in data.get("completed_fix_runs", [])
            if no_submit_fix:   # a correction that never submitted is not a completed one, and is never simply repeated
                if self._queue_sample_followup(b, row, data, run, rec, pending):
                    return
                return self._incomplete_failed(b, row, data, rec, pending, {"status": "fix_run_without_submit"})
            if sid and literary.submit_retryable(wt, b, n) and self._fix_allowed(data):
                data["kind"] = "fix"
                self._set(b, task, data, state="FIXQ", run_id=None)
                return self.store.log(b["id"], f"[{task}] C 제출이 저장되지 않았습니다. 같은 세션에서 제출 파일만 국소 수정합니다 "
                                      f"(완료 {len(data.get('completed_fix_runs', []))}회 / 자동 {AUTO_FIX_LIMIT} + 운영자 {data.get('operator_grants', 0)})", "warn")
            if sid and len(data.get("auto_fix_runs", [])) >= AUTO_FIX_LIMIT and literary.technical_skip_candidate(wt, b, n):
                return self._technical_skip(b, row, data, run, rec, round_)
            outcome = self._no_submission(b, row, data, rec, run, pending)
            if (outcome.get("status") == "cli_chunk_scope"
                    and _legacy_scope_recovery_proven(self.store, b, row, data, run, rec, pending, outcome)):
                self._queue_scope_recovery(b, row, data, run, pending)
                return self.store.log(b["id"], f"[{task}] 조회 ID 범위 오류를 공식 CLI 증거로 확인했습니다. "
                                      "같은 세션을 미완료 Sense 범위로 한 번 재개합니다.", "warn")
            if outcome.get("status") in ("no_submission", "shown_only_progress") and not data.get("recovery"):
                data["recovery"] = {"source_run_id": run["id"], "pending_sense_ids": list(pending)}
                data["kind"] = "recovery"
                self._set(b, task, data, state="FIXQ", run_id=None)
                detail = ("새 문맥 조회만 저장되어 submit 없이 종료된 것을 확인했습니다."
                          if outcome.get("status") == "shown_only_progress" else "정상 종료·submit 호출 없음으로 확인했습니다.")
                return self.store.log(b["id"], f"[{task}] {detail} 기존 view의 미완료 Sense만 "
                                      "새 세션에서 한 번 재개합니다.", "warn")
            progress = outcome.get("status") == "checkpoint_progress" or submit.is_file()
            if not diagnostic.exists() and progress and run["kind"] != FIX and not data.get("progress_retry"):
                data["progress_retry"] = True
                data["kind"] = "new"
                data["continued"] = True
                self._set(b, task, data, state="FIXQ", run_id=None)
                return self.store.log(b["id"], f"[{task}] 기존 제출 파일 또는 부분 진행 확인 — 남은 Sense를 새 세션으로 한 번 이어갑니다", "warn")
            self._incomplete_failed(b, row, data, rec, pending, outcome)
        except _ERRORS as error:
            self._task_failed(b, row, data, f"[{task}] 미완료 청크 상태를 확인하지 못했습니다: {error}. 원본을 보존합니다.")

    def _no_submission(self, b, row, data, rec, run, pending) -> dict:
        if run["id"] != row["run_id"] or run["task"] != row["task"]:
            return {"status": "task_or_run_mismatch"}
        start = data.get("run_start")
        checked_rec = rec
        if isinstance(start, dict) and rec is not None and start.get("head") != rec.get("git_head"):
            old, head = start.get("head"), rec.get("git_head")
            try:
                base = baseline(self.store, b)
                if (run["batch_id"] != b["id"] or run["ended_at"] is None
                        or not isinstance(base, dict) or base.get("head") != head
                        or self.sup.git.head(self._wt(b)) != head
                        or literary.names(b).canonical in self.sup.git.changed_between(old, head)
                        or not self.sup.maint._released_integration_proof(b, old, head)):
                    return {"status": "checkpoint_or_chunk_mismatch"}
                checked_rec = dict(rec, git_head=old)
            except Exception:
                return {"status": "checkpoint_or_chunk_mismatch"}
        log = Path(run["log_file"]) if run["log_file"] else None
        return literary.no_submission_result(
            self._wt(b), b, checked_rec, dict(run), start, pending,
            final_answer=self._final_answer(log), submit_call_count=submit_attempts(log) if log else None,
            task_session=row["session_id"], own_state_now=literary.own_state(self._wt(b), b, rec["sense_ids"]))

    def auto_recover_integrated_no_submission(self, b) -> bool:
        """Reclassify one preserved failure only after its own approved integration is proven."""
        if (b["state"] != "ERROR" or b["method"] != literary.METHOD or b["run_kind"] != RUN_KIND
                or b["pid"] is not None or b["pr_number"] is not None or b["pause_reason"] == "shared_defect"):
            return False
        failed = [r for r in self.store.task_rows(b["id"]) if r["state"] == "FAILED"]
        if len(failed) != 1:
            return False
        row = failed[0]
        data = _data(row)
        guard = data.get("guard")
        if (not isinstance(guard, dict) or guard.get("reason_codes") != ["checkpoint_or_chunk_mismatch"]
                or data.get("recovery") or not isinstance(guard.get("baseline"), dict)):
            return False
        try:
            run = self.store.run(row["run_id"]) if row["run_id"] is not None else None
            rec = literary.read_active(self._wt(b), b, int(row["task"]))
            saved = guard["baseline"]
            if (run is None or rec is None or not row["session_id"]
                    or not isinstance(data.get("run_start"), dict)
                    or data["run_start"].get("head") == rec.get("git_head")
                    or not literary.task_retry_unchanged(self._wt(b), b, int(row["task"]), saved,
                                                        session_available=True)):
                return False
            pending = self._pending(b, rec)
            if pending != saved.get("pending_sense_ids"):
                return False
            outcome = self._no_submission(b, row, data, rec, run, pending)
            if outcome.get("status") not in ("no_submission", "shown_only_progress"):
                return False
        except _ERRORS:
            return False
        data["recovery"] = {"source_run_id": run["id"], "pending_sense_ids": list(pending)}
        data["kind"] = "recovery"
        for key in ("ack", "error", "guard", "progress_retry"):
            data.pop(key, None)
        self._set(b, row["task"], data, state="FIXQ", run_id=None)
        self.store.set_line(b["producer"], b["method"], retry_batch=None, run=1)
        self.store.update(b["id"], state="PRODUCING", error=None, retries=0, retry_after=None,
                          pause_reason="", defect_id=None)
        self.store.log(b["id"], f"[{row['task']}] 승인 통합과 기존 무제출 증거를 확인해 해당 task만 한 번 복구합니다.", "warn")
        return True

    @staticmethod
    def _final_answer(log):
        from .adapters import final_answer
        return final_answer(log) if log else None

    def _incomplete_failed(self, b, row, data, rec, pending, outcome) -> None:
        """FAILED with the exact evidence a later Retry must change (own Senses, submit and diagnostic files)."""
        task = row["task"]
        state = literary.retry_state(self._wt(b), b, rec, pending, session_available=bool(row["session_id"]), task_state=True)
        data["guard"] = {"baseline": state, "reason_codes": [outcome.get("status") or "checkpoint_or_chunk_mismatch"]}
        self._task_failed(b, row, data, f"[{task}] C 청크 실행이 종료됐지만 모든 Sense가 완료되지 않았습니다 "
                          f"(pending={len(pending)}/{len(rec['sense_ids'])}) [{outcome.get('status')}]. 동일 증거의 Retry는 차단됩니다. "
                          "제출·진단 또는 이 task의 Sense 상태가 바뀐 뒤 재시도하세요; 완료 Sense와 worktree/checkpoint는 보존했습니다.")

    def _technical_skip(self, b, row, data, run, rec, round_: _Round) -> None:
        task, n, wt = row["task"], int(row["task"]), self._wt(b)
        if run["kind"] != FIX or run["id"] not in data.get("completed_fix_runs", []):
            return self._task_failed(b, row, data, f"[{task}] C technical skip blocked [last_run_not_completed_correction]. 원본을 보존합니다.")
        try:
            base = baseline(self.store, b)
            refreshed = literary.revalidate_submit_before_skip(self.sup.runner, self._env(b), wt, b, n, scoped=True)
            if refreshed is not None:
                if self._pending(b, rec):
                    return self._task_failed(b, row, data, f"[{task}] C 결정적 CLI 복구 뒤에도 청크 완료를 확인하지 못했습니다. 보존합니다.")
                self.store.log(b["id"], f"[{task}] 변경 없는 제출을 일반 CLI로 재검증해 저장했습니다. technical skip 없이 진행합니다.", "warn")
                return self._accept(b, row, data, round_)
            if not literary.technical_skip_candidate(wt, b, n):
                code = literary.technical_skip_reason_code(wt, b, n)
                return self._task_failed(b, row, data, f"[{task}] C technical skip blocked [technical_skip_ineligible:{code or 'diagnostic_not_authorized'}]. 원본을 보존합니다.")
            result = literary.supervisor_skip(
                self.store, self.sup.runner, self._env(b), wt, b, rec,
                {"session_id": row["session_id"], "run_id": run["id"], "expected_head": base["head"],
                 "auto_fix_runs": data.get("auto_fix_runs", [])})
        except _ERRORS as error:
            return self._task_failed(b, row, data, f"[{task}] C 국소 기술적 제외를 증명하지 못했습니다: {error}. 원본을 보존합니다.")
        self.store.log(b["id"], f"[{task}] C 기술적 생산 제외: record={result['record_id']} sense={result['sense_id']} "
                       f"diagnostic={result['diagnostic']}/{result['reason']} field={result['field']} "
                       f"auto-fix-runs={data.get('auto_fix_runs')}; 나머지 제출은 기존 CLI 경로로 저장했습니다.", "warn")
        try:
            if self._pending(b, rec):
                return self._task_failed(b, row, data, f"[{task}] C technical skip 이후에도 청크 전체 완료를 확인하지 못했습니다. 보존합니다.")
        except _ERRORS as error:
            return self._task_failed(b, row, data, f"[{task}] C technical skip 이후 상태를 확인하지 못했습니다: {error}. 보존합니다.")
        self._accept(b, row, data, round_)

    # ---- accepting a finished chunk --------------------------------------------------------------------------------
    def _accept(self, b, row, data, round_: _Round) -> None:
        """All Senses of the task are done and its run (if any) is gone: bind to the batch's Git boundary and the chunk's
        own active files, clear its scratch, and mark the task SAVED."""
        task, n, wt = row["task"], int(row["task"]), self._wt(b)
        if self._halted_by_boundary(b, round_):
            return
        try:
            rec = literary.read_active(wt, b, n)
            if rec is not None:
                base = baseline(self.store, b)
                if base is None or rec["git_head"] != base["head"]:
                    return self._task_failed(b, row, data, f"[{task}] 청크의 준비 HEAD가 현재 runtime baseline과 다릅니다. 보존합니다.")
                literary.read_view(wt, rec, n)   # the saved record must still bind the exact view being cleaned
                if self._pending(b, rec):
                    return self._task_failed(b, row, data, f"[{task}] 청크의 모든 Sense 저장이 검증되지 않았습니다. 보존합니다.")
            literary.clear_active(wt, n)
        except TRANSIENT:
            raise
        except _ERRORS + (GitError,) as error:
            return self._task_failed(b, row, data, f"[{task}] 저장된 청크를 확인하지 못했습니다: {error}. 보존합니다.")
        for key in ("kind", "continued", "retry_after", "error", "guard", "progress_retry"):
            data.pop(key, None)
        self._set(b, task, data, state="SAVED", run_id=None)
        saved = sum(1 for r in self.store.task_rows(b["id"]) if r["state"] == "SAVED")
        self.store.log(b["id"], f"[{task}] C 청크 저장을 확인했습니다 (저장 {saved}/{len(self.store.task_rows(b['id']))} task)")

    def _recover_stored(self, b, round_: _Round) -> None:
        """After a restart or an operator Retry: a prepared task whose Senses are all done and that has no live run is
        accepted from the original files (no AI call); unreadable scratch stays an error."""
        busy = {r["task"] for r in taskruns.open_runs(self.store, b["id"])}
        for row in self.store.task_rows(b["id"]):
            if row["state"] not in ("PENDING", "FIXQ") or row["task"] in busy:
                continue
            try:
                rec = literary.read_active(self._wt(b), b, int(row["task"]))
                finished = rec is not None and not self._pending(b, rec)
            except _ERRORS as error:
                return self.sup._fail(b, "ERROR", f"C 병렬 저장 청크를 확인하지 못했습니다: {error}. 보존합니다.")
            if finished:
                self._accept(b, row, _data(row), round_)
                if self.store.batch(b["id"])["state"] != "PRODUCING":
                    return

    # ---- slots ------------------------------------------------------------------------------------------------
    def _fill_slots(self, b, rows, round_: _Round) -> None:
        free = literary.MAX_PARALLEL - taskruns.slots_used(self.store, b["id"])
        if free <= 0 or round_.block_new:
            return
        now = self.sup.clock()
        busy = {r["task"] for r in taskruns.open_runs(self.store, b["id"])}
        due = lambda r: _data(r).get("retry_after", 0) <= now and r["task"] not in busy
        ordered = sorted(rows.values(), key=lambda r: r["task"])
        queue = [r for r in ordered if r["state"] == "FIXQ" and due(r)] + [r for r in ordered if r["state"] == "PENDING" and due(r)]
        self._start_queued(b, round_, queue, free)

    def _start_queued(self, b, round_: _Round, queue, free) -> None:
        for row in queue:
            if free <= 0 or self.store.batch(b["id"])["state"] != "PRODUCING":
                return
            with self.sup.launch_gate.unit():   # one task per admission: a closed gate stops before the next one
                row = self.store.task_row(b["id"], row["task"])
                if row["state"] == "SAVED":
                    continue
                outcome = self._start(b, row, round_)
            if outcome == "stop":
                return
            if outcome == "started":
                free -= 1
        while free > 0 and self.store.batch(b["id"])["state"] == "PRODUCING":
            with self.sup.launch_gate.unit():   # rendering a new chunk writes: it is admitted together with its launch
                row = self._render_new(b, round_)
                if row is None:
                    return
                outcome = self._start(b, row, round_)
            if outcome != "started":
                return
            free -= 1

    def _start(self, b, row, round_: _Round) -> str:
        """"started" | "stop" (batch failed/halted, or the CLI pin is still being proved)."""
        if round_.boundary is None:   # the Git boundary is proved once per round, only when something is about to start
            round_.boundary = not self._halted_by_boundary(b, round_)
        if not round_.boundary:
            return "stop"
        problem = round_.preflight()
        if problem:
            from .adapters import PREFLIGHT_PENDING
            if problem.startswith(PREFLIGHT_PENDING):
                return "stop"   # still proving the pin in the background; the next tick retries
            self.sup._fail(b, "ERROR", f"실행 전 확인 실패: {problem}")
            return "stop"
        return "started" if self._launch(b, row, round_) else "stop"

    def _render_new(self, b, round_: _Round):
        """Render the next chunk from Senses no active chunk reserves and register it as a PENDING task holding its view.
        None: nothing to start now (everything is reserved / all done / failed or halted)."""
        wt, env = self._wt(b), self._env(b)
        try:
            reserved = literary.reserved_sense_ids(wt, b)
            for _ in range(EMPTY_RENDERS):   # chunks that only advance ZERO_HITS render empty: re-evaluate, bounded
                view = literary.render_chunk(self.sup.runner, env, wt, b, self.sup._c_db(), exclude=reserved)
                ids, failed, _unsearchable = literary.view_ids(view)
                _done, _total, zero, _unread = literary.progress_numbers(view)
                excluded = literary.excluded_pending(view)
                number = self._next_number(b)
                if failed:   # no new assignment; running tasks finish and are collected, then the batch pauses
                    rec = literary.write_active(wt, b, view, ids, self._runtime_head(b), number, numbered=True)
                    task = f"{number:03d}"
                    self.store.add_tasks(b["id"], [(task, task)])
                    self._task_failed(b, self.store.task_row(b["id"], task), {"pause": True, "search_failed": True},
                                      f"[{task}] SEARCH_FAILED sense {failed}: 승인 index 진단이 필요합니다 (stop_and_report). AI를 시작하지 않았습니다.")
                    self._set(b, task, view_sha256=rec["view_sha256"])
                    return None
                if not ids:
                    if excluded > 0 and zero == 0:
                        return None   # the rest is already reserved by running tasks: a normal wait
                    if zero > 0:
                        continue
                    if literary.all_done(literary.summary(self.sup.runner, env, wt, b)):
                        return None
                    self.sup._fail(b, "ERROR", "chunk가 항목도 ZERO_HITS 진전도 예약 사유도 없이 비었는데 미완료 sense가 남았습니다. 보존합니다.")
                    return None
                literary.sense_report(self.sup.runner, env, wt, b, ids)   # unknown / damaged ids fail closed
                rec = literary.write_active(wt, b, view, ids, self._runtime_head(b), number, numbered=True)
                task = f"{number:03d}"
                self.store.add_tasks(b["id"], [(task, task)])
                self._set(b, task, {}, state="PENDING", view_sha256=rec["view_sha256"])
                return self.store.task_row(b["id"], task)
            self.sup._fail(b, "ERROR", f"chunk가 {EMPTY_RENDERS}번 연속 비어 진행하지 않습니다. 보존합니다.")
        except TRANSIENT:
            raise
        except _ERRORS + (GitError,) as error:
            self.sup._fail(b, "ERROR", f"Method C 상태 확인 실패: {error}. worktree를 보존합니다.")
        return None

    def _runtime_head(self, b) -> str:
        base = baseline(self.store, b)
        if base is None:
            raise literary.LiteraryError("runtime baseline이 없습니다")
        return base["head"]

    def _next_number(self, b) -> int:
        """max(task rows, active files) + 1: a number is never reused, even after a restart between the two records."""
        numbers = [int(r["task"]) for r in self.store.task_rows(b["id"])]
        numbers += list(literary.active_chunks(self._wt(b), b))
        return max(numbers, default=0) + 1

    @task_launch_scope
    def _launch(self, b, row, round_: _Round) -> bool:
        """Start this task's AI (new, same-session correction, or fresh-session recovery). False: batch failed/halted."""
        task, n, data = row["task"], int(row["task"]), _data(row)
        kind = {"fix": FIX, "recovery": RECOVERY, "scope_recovery": SCOPE_RECOVERY}.get(data.get("kind"), NEW)
        wt, sup, ad = self._wt(b), self.sup, self._adapter(b)
        try:
            run = sup._run(b)
        except ValueError as error:
            sup._fail(b, "ERROR", f"실행 설정 오류로 AI를 시작하지 않았습니다: {error}")
            return False
        ts = int(sup.clock())
        while any((sup.paths.logs / f"batch-{b['id']}-c{task}-{ts}.{x}").exists() for x in ("log", "exit")):
            ts += 1
        log = sup.paths.logs / f"batch-{b['id']}-c{task}-{ts}.log"
        ex = sup.paths.logs / f"batch-{b['id']}-c{task}-{ts}.exit"
        try:
            env = sup._launch_env(b, NEW, sup._agent_env())
            extra = {"git_dir": sup.git.worktree_gitdir(wt)} if getattr(ad, "needs_git_dir", False) else {}
            rec = literary.read_active(wt, b, n)
            if rec is None:
                raise prompts.PromptError("활성 청크 기록이 없습니다")
            sid = row["session_id"] if kind in (FIX, SCOPE_RECOVERY) else None
            if kind in (FIX, SCOPE_RECOVERY) and not sid:
                raise prompts.PromptError("수정 요청에 기존 세션이 필요합니다")
            if kind == FIX and not self._fix_allowed(data):
                raise prompts.PromptError("자동 수정 허용량과 운영자 grant를 모두 사용했습니다")
            base = baseline(self.store, b)
            if base is None or rec["git_head"] != base["head"]:
                raise prompts.PromptError("활성 청크의 HEAD가 현재 runtime baseline과 다릅니다")
            remaining = self._pending(b, rec)
            if not remaining:
                raise prompts.PromptError("이어갈 미완료 Sense가 없습니다")
            recovery = data.get("recovery") if kind in (RECOVERY, SCOPE_RECOVERY) else None
            if (isinstance(recovery, dict) and recovery.get("scope_retry") == LEGACY_CHUNK_SCOPE_RECOVERY
                    and (kind not in (RECOVERY, SCOPE_RECOVERY) or remaining != recovery.get("pending_sense_ids")
                         or any(sense_id not in rec["sense_ids"] for sense_id in remaining))):
                raise prompts.PromptError("chunk_scope 1회 복구의 미완료 Sense 범위가 기존 승인과 다릅니다")
            if kind == SCOPE_RECOVERY and (not isinstance(recovery, dict) or recovery.get("attempts") != 1
                    or recovery.get("launch_started") is not False):
                raise prompts.PromptError("legacy chunk_scope 복구 예산이 이미 사용됐거나 손상되었습니다")
            prompt = self._prompt(b, kind, rec, remaining, data)
            if kind in (FIX, SCOPE_RECOVERY):
                sup._check_session_pin(b, sid, run)
            if kind == SCOPE_RECOVERY:
                recovery["launch_started"] = True
                data["recovery"] = recovery
                self._set(b, task, data, state="FIXQ", run_id=None)
            if kind in (FIX, SCOPE_RECOVERY):
                handle = ad.resume(sid, prompt, wt, env, run, log, ex, **extra)
            else:
                handle = ad.start(prompt, wt, env, run, f"C {b['shard']}_{b['batch']} chunk {n:03d}", log, ex, **extra)
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
        if kind == FIX:   # corrections within the bounded budget are automatic; further ones need an operator grant
            data.setdefault("fix_launch", {})[str(run_id)] = \
                "auto" if _fix_budget_used(data) < AUTO_FIX_LIMIT else "grant"
        data["run_start"] = {"branch": b["branch"], "worktree": str(wt), "head": base["head"],
                             "remote_head": round_.remote(), "chunk_id": rec["chunk_id"], "chunk_no": n,
                             "retry_state": literary.retry_state(wt, b, rec, remaining, session_available=bool(sid),
                                                                 task_state=True)}
        self._set(b, task, data, state="RUNNING", run_id=run_id, session_id=sid, view_sha256=rec["view_sha256"],
                  attempts=row["attempts"] + 1)
        self.store.log(b["id"], f"[{task}] 시작 ({kind}, 남은 Sense {len(remaining)}, model={run.model}, effort={run.effort})")
        return True

    def _prompt(self, b, kind: str, rec: dict, remaining: list[str], data: dict) -> str:
        wt, n = self._wt(b), rec["chunk_no"]
        checkpoint = literary.names(b).checkpoint
        note = (f"이 청크 전용 공통 결함 보고 파일: `{defect_path(b, f'{n:03d}')}` "
                "(공유 코드·검증기의 결함을 발견했을 때만 이 경로에 쓰고, 다른 경로에는 쓰지 않는다).\n"
                "공통 결함 보고는 실제로 실행해 확인한 재현만 기록한다. 로그에 없는 CLI 호출을 했다고 주장하거나, "
                "AI의 설명만으로 CLI 결함을 단정하지 않는다. 보고 파일은 아래 v1 필수 필드만 사용한다(추가 필드 금지): "
                f'{{"version":1,"defect_class":"c-chunk-{n:03d}-cli","summary":"...",'
                '"failing_cases":["..."],"reproduction":"실제 CLI 명령·인자·종료 상태·관측 결과",'
                '"suspected_layer":"C CLI"}. 선택 필드는 root_cause, scope, proposed_fix, regression이며 '
                "값이 없으면 생략한다.\n"
                f"이 청크 범위의 Sense만 다룬다. 공식 CLI 호출(`chunk --sense-ids`, `add-form`, `submit`)에는 모두 `--chunk {n:03d}`를 붙인다.\n"
                "Supervisor가 배정한 조회 허용 ID(아래 문자열을 그대로 복사): " + ", ".join(rec["sense_ids"]) + "\n"
                "표제어나 번호에서 인접 Sense ID를 만들지 않는다. 이번 실행의 미완료 제출 ID: " + ", ".join(remaining) + "\n")
        if kind in (FIX, SCOPE_RECOVERY):
            diagnostic_path = wt / f"{literary.names(b).submit_prefix}{n:03d}.submit.json.diag.json"
            try:
                diagnostic = json.loads(diagnostic_path.read_text("utf-8"))
                current_diagnostic = {key: diagnostic[key] for key in
                                      ("status", "diagnostic", "reason", "affected", "issues", "repair_scope", "input_sha256")
                                      if key in diagnostic}
                note += ("Supervisor가 현재 저장된 submit 진단을 아래처럼 다시 확인했다. 이 진단은 이 세션의 마지막 CLI 출력보다 "
                         "최신일 수 있으므로 아래의 affected/entry_number, verified_number(1부터 시작), input_sha256를 기준으로 수정한다. "
                         "키를 직접 대조할 때는 CLI 출력에서 프로그램으로 추출하고 수기로 복사하지 않는다:\n"
                         + json.dumps(current_diagnostic, ensure_ascii=False, sort_keys=True) + "\n")
            except (OSError, ValueError, TypeError):
                pass
            return prompts.c_chunk_resume(n, checkpoint, remaining, note=note, scoped=True)
        view = literary.read_view(wt, rec, n)
        if kind == RECOVERY:
            recovery = data.get("recovery") if isinstance(data.get("recovery"), dict) else {}
            shown = literary.own_state(wt, b, remaining)["senses"]
            capped = [sense_id for sense_id, state in shown.items()
                      if state.get("shown", {}).get("valid") is True
                      and state.get("shown", {}).get("context_count") == 16]
            note += ("무제출 복구 정책 v1: 직전 정상 종료 실행은 공식 submit 호출 0회였고 submit/diag 파일도 없었다. "
                     "새 self-contained 세션에서 기존 active view의 아래 미완료 Sense만 처리한다. 이미 checkpoint에 저장된 Sense는 "
                     "다시 판독하거나 제출하지 않는다. 제공된 같은 view 증거를 우선 재사용하고, 기존 view로 판독할 수 없을 때에만 "
                     "카드에 정한 공식 추가 조회를 수행한다. 아래 Sense의 source-sense 판독과 C의 발굴·형태 검사는 정해진 전체 계약대로 "
                     "수행하고, 완료 Sense를 모두 포함한 단일 제출을 실행한다. 필수 검색·출처 근거가 불충분하거나 정당한 stop 사유가 "
                     "있으면 추측·technical skip 없이 그 사유를 보고한다: " + ", ".join(remaining) + "\n")
            if capped:
                note += ("이전에 CLI가 기록한 16문맥 상한 Sense: " + ", ".join(capped) + ". `shown=16`은 CLI 노출 기록일 뿐, "
                         "이 세션이 9–16 문맥 전체를 받아 판독했다는 증거가 아니다. 출력이 잘렸거나 읽지 못한 문맥이 있으면 마지막으로 "
                         "완전히 판독한 앞 문맥 수(8–15)를 `--skip`으로 지정해 그 Sense의 미수신 suffix만 `--contexts 16`으로 다시 조회한다. "
                         "예: 9–12를 판독했고 13–16을 받지 못했다면 `--skip 12 --contexts 16`; 추가 문맥을 하나도 온전히 받지 못했을 때만 "
                         "`--skip 8 --contexts 16`을 쓴다. 16개 전체를 읽고도 VERIFIED가 없을 때만 `verified: []`, `candidates: []`로 제출한다. "
                         "`unseen_hits`가 남아 있어도 정상적인 `SAMPLED_NO_VERIFIED` 완료이며 16개 상한을 넘지 않는다.\n")
            view = literary.view_for_senses(view, remaining)
        elif data.get("continued") or len(remaining) < len(rec["sense_ids"]):
            note += ("같은 활성 청크의 미완료 Sense만 새 세션으로 이어간다. 제공된 view와 제출 배열에는 아래 남은 ID만 포함하고, "
                     "checkpoint에 저장된 Sense는 다시 판독하거나 제출하지 않는다: " + ", ".join(remaining) + "\n")
            view = literary.view_for_senses(view, remaining)
        card = len(prompts.c_chunk(b, n, checkpoint, view="", note=note, scoped=True).encode("utf-8"))
        if literary.delivery(card, view) == "inline":
            return prompts.c_chunk(b, n, checkpoint, view=view, note=note, scoped=True)
        return prompts.c_chunk(b, n, checkpoint, pages=literary.write_pages(wt, view, n), note=note, scoped=True)

    # ---- failures, halt, Retry -------------------------------------------------------------------------------
    def _task_failed(self, b, row, data, message: str) -> None:
        data["error"] = message
        self._set(b, row["task"], data, state="FAILED")
        self.store.log(b["id"], message, "error")

    def _halt(self, b, failed) -> None:
        """No worker is running any more: the batch goes to PAUSED (SEARCH_FAILED) or ERROR with every file kept."""
        message = "; ".join(_data(r).get("error", f"[{r['task']}] 실패") for r in failed)[:900]
        state = "PAUSED" if all(_data(r).get("pause") for r in failed) else "ERROR"
        for r in failed:
            self._set(b, r["task"], _data(r) | {"ack": True})
        self.sup._fail(b, state, f"C 병렬 청크 중지: {message}")

    def operator_retry(self, b) -> int:
        """An operator Retry is consumed from ERROR: exactly one epoch step. Stop-resume and the Maintainer's automatic
        release never call this, so they grant nothing."""
        epoch = int(self.store.get(epoch_key(b["id"])) or 0) + 1
        self.store.set(epoch_key(b["id"]), str(epoch))
        return epoch

    def _queue_scope_recovery(self, b, row, data: dict, run, pending: list[str]) -> None:
        recovery = {
            "scope_retry": LEGACY_CHUNK_SCOPE_RECOVERY,
            "source_run_id": run["id"],
            "pending_sense_ids": list(pending),
            "attempts": 1,
            "launch_started": False,
            "source_run_start": data.get("run_start"),
        }
        if isinstance(data.get("guard"), dict):
            recovery["source_guard"] = data["guard"]
        if isinstance(data.get("error"), str):
            recovery["source_task_error"] = data["error"]
        data["recovery"] = recovery
        data["kind"] = "scope_recovery"
        for key in ("ack", "error", "guard", "progress_retry"):
            data.pop(key, None)
        self._set(b, row["task"], data, state="FIXQ", run_id=None)

    def auto_recover_legacy_scope_error(self, b) -> bool:
        """Re-enter exactly one proven legacy scope failure without an owner Retry or a new correction budget."""
        if (b["state"] != "ERROR" or b["method"] != literary.METHOD or b["run_kind"] != RUN_KIND
                or b["pid"] is not None or b["pr_number"] is not None
                or b["pause_reason"] == "shared_defect" or not isinstance(b["worktree"], str) or not b["worktree"]):
            return False
        failed = [row for row in self.store.task_rows(b["id"]) if row["state"] == "FAILED"]
        queued = [row for row in self.store.task_rows(b["id"])
                  if row["state"] == "FIXQ" and _data(row).get("kind") == "scope_recovery"]
        queued_plan = False
        if len(failed) == 1:
            row = failed[0]
            data = _data(row)
        elif not failed and len(queued) == 1:
            row = queued[0]
            data = _data(row)
            recovery = data.get("recovery") if isinstance(data.get("recovery"), dict) else {}
            if (recovery.get("scope_retry") != LEGACY_CHUNK_SCOPE_RECOVERY or recovery.get("attempts") != 1
                    or recovery.get("launch_started") is not False or not isinstance(recovery.get("source_guard"), dict)):
                return False
            data = data | {"guard": recovery["source_guard"], "run_start": recovery.get("source_run_start")}
            data.pop("kind", None)
            data.pop("recovery", None)
            row = dict(row) | {"state": "FAILED", "run_id": recovery.get("source_run_id")}
            queued_plan = True
        else:
            return False
        baseline_state = data.get("guard", {}).get("baseline") if isinstance(data.get("guard"), dict) else None
        pending = baseline_state.get("pending_sense_ids") if isinstance(baseline_state, dict) else None
        if not isinstance(pending, list) or not pending:
            return False
        try:
            raw_run = self.store.run(row["run_id"]) if row["run_id"] is not None else None
            run = dict(raw_run) if raw_run is not None else None
            rec = literary.read_active(self._wt(b), b, int(row["task"]))
            log = Path(run["log_file"]) if run and run.get("log_file") else None
            outcome = literary.no_submission_result(
                self._wt(b), b, rec, run, data.get("run_start"), pending,
                final_answer=self._final_answer(log) if log else None,
                submit_call_count=submit_attempts(log) if log else None,
                task_session=row["session_id"],
                own_state_now=literary.own_state(self._wt(b), b, rec["sense_ids"]) if rec else None)
            if not _legacy_scope_recovery_proven(self.store, b, row, data, run, rec, pending, outcome):
                return False
        except _ERRORS:
            return False

        if not queued_plan:
            self._queue_scope_recovery(b, row, data, run, pending)
        self.store.set_line(b["producer"], b["method"], retry_batch=None, run=1)
        self.store.update(b["id"], state="PRODUCING", error=None, retries=0, retry_after=None,
                          pause_reason="", defect_id=None)
        self.store.log(b["id"], f"[{row['task']}] legacy chunk_scope 증거를 확인해 task 한 건만 같은 세션으로 자동 복구합니다.", "warn")
        return True

    def _reset_acknowledged_failures(self, b, round_: _Round) -> None:
        """After the batch returned to PRODUCING: a failed task re-enters from what is preserved. Only a task not yet
        granted for the current Retry epoch receives one more correction chance (restart or repeated polls cannot repeat it)."""
        epoch = int(self.store.get(epoch_key(b["id"])) or 0)
        for row in self.store.task_rows(b["id"]):
            data = _data(row)
            if row["state"] != "FAILED" or not data.get("ack"):
                continue
            if data.get("search_failed"):   # its SEARCH_FAILED view is stale: drop it, the Senses are rendered again
                literary.clear_active(self._wt(b), int(row["task"]))
                self._set(b, row["task"], {"superseded": True}, state="SAVED", run_id=None)
                round_.force = True
                continue
            guard = data.get("guard")
            legacy_shown_retry = _legacy_shown_only_guard(data, guard)
            legacy_retry = legacy_shown_retry
            if isinstance(guard, dict) and guard.get("reason_codes") == ["producer_reported_stop"]:
                scope_status = _legacy_reported_stop_retry_status(self.store, b, row, guard)
                if scope_status != "retry_available":
                    return self.sup._fail(b, "ERROR", f"[{row['task']}] 공식 C 무제출 복구의 기존 run 증거가 달라져 Retry를 차단했습니다. 원본을 보존합니다.")
            if legacy_shown_retry and not _legacy_shown_only_retry_available(self.store, b, row, guard):
                return self.sup._fail(b, "ERROR", f"[{row['task']}] 16문맥 무제출 복구의 기존 증거가 달라져 Retry를 차단했습니다. 원본을 보존합니다.")
            for key in ("ack", "error", "pause", "guard", "progress_retry"):
                data.pop(key, None)
            if not legacy_retry and epoch > int(data.get("last_operator_retry_epoch", 0)):
                data["operator_grants"] = int(data.get("operator_grants", 0)) + 1
                data["last_operator_retry_epoch"] = epoch
            if legacy_shown_retry:
                run = self.store.run(row["run_id"])
                rec = literary.read_active(self._wt(b), b, int(row["task"]))
                data["kind"] = "recovery"
                data["recovery"] = {"source_run_id": run["id"], "pending_sense_ids": list(rec["sense_ids"]),
                                    "operator_retry_epoch": epoch}
            else:
                data.pop("kind", None)
            self._set(b, row["task"], data, state="PENDING", run_id=None)
            round_.force = True
            fresh = self.store.task_row(b["id"], row["task"])
            try:
                rec = literary.read_active(self._wt(b), b, int(row["task"]))
                retryable = (rec is not None and fresh["session_id"] and self._fix_allowed(data)
                             and literary.submit_retryable(self._wt(b), b, int(row["task"])))
            except _ERRORS:
                continue   # prepare/launch will report the damaged scratch
            if retryable:
                data["kind"] = "fix"
                self._set(b, row["task"], data, state="FIXQ")
            elif rec is not None:
                self._requeue(b, fresh, data)
