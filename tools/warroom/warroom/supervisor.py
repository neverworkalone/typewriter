"""Supervisor: persistent per-batch state machine, independent of the TUI.

One Supervisor drives many independent Production Lines: a Line is (logical model, method)
and owns at most one unfinished batch. Every state transition, poll, stop and drain below is
scoped to that Line; no Line reads another Line's controls or batch.

PREPARE -> PRODUCING -> WAITING_REVIEW <-> FIXING -> MERGED -> CLEANUP -> COMPLETE
with PAUSED (recoverable, needs operator) and ERROR (safety stop, everything kept).
The AI process exiting never completes a batch; only GitHub `merged=true` does.
"""
from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
import re
import secrets
import subprocess
import time
import traceback
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from functools import wraps
from pathlib import Path

from . import (auth, batches, control, defects, fixcoord, prbody, progress, prompts, refine, reviews, s2parallel, s3parallel,
               stage2, stage3)
from .adapters import (NO_CHILD_ERRNOS, PREFLIGHT_PENDING, SpawnNotStarted, RunSpec, classify_claude_failure, classify_failure,
                       classify_codex_failure, usage_limit_override_key)
from .config import (adapter_label, config_problem, load_config, registry, registry_problems,
                     refine_problem, reload_problem, role_for, role_problem, run_spec, stage2_problem, STAGE2)
from .github import GhError, GhTransient
from .gitops import CleanupBlocked, FastForwardBlocked, FastForwardRace, GitError, GitTransient, InspectContextFailure, IntegrationBlocked, RefineAmendRejected, ResourceFenced, Stage2AmendRejected
from .lanes import Lanes
from .launch_gate import LaunchDenied, LaunchGate
from . import maintenance as maint_results
from .maintenance import Maintenance
from .store import MAINTENANCE_METHOD, STAGE2_METHOD, STAGE3_METHOD, LineBusy, LineNotRunnable, exit_verdict_key


# A failed *query* asking again can fix. It is never a verdict: callers re-raise it past every broad `except`.
TRANSIENT = (GhTransient, GitTransient)

# #6555 Stage 2 review fix: the AI writes only its judgment here; the Supervisor applies it with the official CLI.
S2_FIX_RESPONSE = ".warroom-scratch/s2-fix-response.json"
S2_FIX_AMEND_INPUT = ".warroom-scratch/s2-fix-amend.txt"
S2_FIX_COMMIT_SUBJECT = "Apply Stage 2 review amendments"
S2_FIX_APPLY_ATTEMPTS = 2   # returns of a refused judgment to the same session before the batch stops
S2_FIX_REPLY_LIST_WAIT_SECONDS = 600   # a possibly posted reply is awaited, never posted again; then ERROR
S3_FIX_CONTEXT_ROWS = 400   # base rows shown to a Stage 3 fix; more are read with one `decisions --senses` call


class DuplicateClaim(Exception):
    pass


class RecoveryBlocked(Exception):
    """A discovered PR cannot be tied safely to this batch's completed producer run."""


class Stage2RepairSchemaError(ValueError):
    """A candidate row's answer fields do not match its persisted per-candidate output contract."""


class Stage2RepairUnresolvedError(ValueError):
    """The answer explicitly left one or more in-scope candidates unresolved."""


class Stage2RepairContentError(ValueError):
    """The parsed answer has invalid target, coverage, or peer-adjustment content."""


class Stage2RepairMissingCandidatesError(Stage2RepairContentError):
    """The response is otherwise valid, but omits one or more requested page candidates."""


def acquire_lock(path: Path):
    """Single War Room instance: returns an open locked file, or None if held."""
    path.parent.mkdir(parents=True, exist_ok=True)
    f = open(path, "a+")
    owner_path = path.with_name(f"{path.stem}-owner{path.suffix}")
    owner = None
    try:
        owner = open(owner_path, "a+")
        # flock preserves same-process and cross-process single-instance behavior. POSIX record
        # locks conflict with flock on macOS, so hold the queryable owner lock on a companion file.
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.lockf(owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        if owner is not None:
            owner.close()
        f.close()
        return None
    f.seek(0)
    f.truncate()
    f.write(str(os.getpid()))
    f.flush()
    return _SupervisorLock(f, owner)


class _SupervisorLock:
    """Keep both OS locks alive and release them together through the existing close() seam."""

    def __init__(self, instance_file, owner_file):
        self.instance_file, self.owner_file = instance_file, owner_file

    def close(self):
        self.owner_file.close()
        self.instance_file.close()


def _single_launch_scope(fn):
    """Keep the single-run launch's durable preparation and PID publication in one permit."""
    @wraps(fn)
    def wrapped(self, *args, **kwargs):
        with self.launch_gate.permit():
            return fn(self, *args, **kwargs)
    return wrapped


class FixIncomplete(str):
    """A review-fix outcome whose reply/completion record is missing (#5245). It is still a plain problem text for every
    producer; the Maintainer continues the same attempt with it instead of parking an ERROR."""


class NoOwnedPR(str):
    """A denial-completion reason meaning only "the owned branch has no PR". Plain text for every producer; a Maintainer
    run then reaches its own no-PR diagnosis path instead of pausing on the missing PR alone (#5471)."""


class Supervisor:
    def __init__(self, paths, cfg, store, runner, adapter, gh, git, env, clock=time.time, fence=None):
        self.paths, self.cfg, self.store = paths, cfg, store
        self.fence = fence   # crash fence (#3773); its instance id is the one #3774's record_runtime() reuses
        if fence is not None:
            fence.attach_log(lambda message: store.log(None, message, "warn"))
        self.runner, self.adapter, self.gh, self.git, self.env = runner, adapter, gh, git, env
        self.clock = clock
        self.lanes = Lanes()
        self.launch_gate = LaunchGate()
        self.launch_gate.guard = self._stop_requested   # an in-flight tick admits no new AI once STOPPING is recorded
        for ad in (adapter.values() if isinstance(adapter, dict) else [adapter]):
            if hasattr(ad, 'required_launch_gate'):   # every AI spawn must run inside a permit (#3787)
                ad.required_launch_gate = self.launch_gate
        self._frozen_lanes = set()
        self._frozen_lock = threading.Lock()
        # Restart handoff (#5162): the Controller moves this instance RUNNING -> STOPPING and nothing moves it back.
        # `_submit_hold` is the Coordinator's own; `_drain` is the one memory boundary Workers read through
        # accepting_new_work().
        self.phase_instance = (fence.instance if fence is not None else None) or str(uuid.uuid4())
        self._drain = threading.Event()   # STOPPING: no new production, batch, Finalization or review-fix
        self._submit_hold = False         # STOPPING: the Coordinator submits no Worker at all
        self._stop_seen = False           # this process has read its own STOPPING (any thread)
        self._interval = 5.0
        self._submitted_at: dict = {}
        self._slow_logged: set = set()
        self._phase_logged: set = set()
        self._maintenance_lane = threading.Lock()
        self._s2_fix_problem: dict[int, str] = {}   # batch id -> the save/format diagnostic for the next same-session fix
        self._s2_links_problem: dict[int, str] = {} # batch id -> optional-link save/format diagnostic
        # The Supervisor code this process loaded (#3326): a merged fix to tools/warroom/warroom/ is applied only after it is in this HEAD.
        self.code_root = Path(__file__).resolve().parents[3]
        self.code_sha = self._loaded_code_sha(git)
        self.maint = Maintenance(self)   # shared-defect Issues, the hidden Maintainer and applying its merged fix
        self.s2p = s2parallel.ParallelStage2(self)   # parallel Stage 2 primary tasks of new Parts (#3047)
        self.s3p = s3parallel.ParallelStage3(self)   # parallel Stage 3 chunk tasks inside a new shard (#3149)
        self.refine_fix = {}   # #6555: one Review FIXING Coordinator per refinement Stage (`_refine_fix`)
        self.parallel_new_s3 = True   # False only lets a fixture exercise the serial Stage 3 path an already running shard keeps
        self.parallel_new_parts = True   # False only lets a fixture exercise the serial path an already running Part keeps

    @property
    def instance_id(self) -> str | None:
        return self.fence.instance if self.fence is not None else None

    def accepting_new_work(self) -> bool:
        """False from the moment this instance is STOPPING. Collecting an already running AI's exit, saving it, Stop and
        Clear are NOT new work."""
        return not self._drain.is_set() and self.launch_gate.is_open

    def _finalization_held(self, b, kind: str) -> bool:
        """Hold a Finalization that has not made its first persistent write yet. One that already started (its run_kind is
        the finalize kind) runs to completion; a held one is re-entered by the next instance from its checkpoint/HEAD/PR."""
        if self.accepting_new_work():
            return False
        run_kind = b["run_kind"] or ""
        if run_kind == kind or (kind.startswith("s2_") and run_kind.startswith("s2_finalize_")):
            return False
        key = (b["id"], kind)
        if key not in self._phase_logged:
            self._phase_logged.add(key)
            self.store.log(b["id"], f"Restart STOPPING 중이므로 새 Finalization({kind})을 시작하지 않습니다 — 저장된 상태를 보존하고 "
                           "새 instance가 이어서 실행합니다", "warn")
        return True

    def begin_instance(self) -> None:
        """Publish this instance's RUNNING restart_phase (superseding whatever an earlier instance left)."""
        self.store.begin_restart_phase(self.phase_instance)

    # ---- Restart handoff (#5162) --------------------------------------------------------------------------------------
    def _stopping(self) -> bool:
        """True once the Controller moved THIS instance to STOPPING: no Worker is submitted, no new AI, batch or
        Finalization starts, and the process leaves as soon as its in-flight Workers return. It never decides that work is
        "finished" - whatever still runs at the Controller's deadline is recovered by the next instance from the batch's
        own DB, checkpoint, process, Git and PR facts, exactly as after a crash."""
        if self._submit_hold:
            return True
        if not self._stop_requested():
            return False
        self._submit_hold = True
        self.store.log(None, "Restart: STOPPING — 새 Worker·AI·배치·Finalization을 시작하지 않고, 진행 중 Worker가 반환되면 "
                       "종료합니다 (남은 작업은 새 instance가 이어서 처리)", "warn")
        return True

    def _stop_requested(self) -> bool:
        """Has the Controller recorded STOPPING for THIS instance? Read from the Store by whichever thread asks (the
        Coordinator, the serial loop, and the LaunchGate before every admission), so a tick already under way starts no
        new AI either. The first reader closes the memory boundary and the gate; nothing reopens them."""
        if self._stop_seen:
            return True
        cur = self.store.restart_phase()
        if cur is None or cur.get("instance") != self.phase_instance or cur.get("phase") != "STOPPING":
            return False
        self._drain.set()          # memory boundary first: no new batch, Finalization or review-fix from here
        self.launch_gate.shut()    # every later AI permit is denied, also for a thread inside a wider permit
        self._stop_seen = True
        return True

    def _batch_has_open_work(self, b) -> bool:
        """An AI/task still running, or a recorded outcome not yet collected and saved."""
        if b["pid"] is not None or self.store.open_task_runs(b["id"]):
            return True
        runs = self.store.runs(b["id"])
        if any(r["ended_at"] is None for r in runs):
            return True
        tasks = [r for r in self.store.task_rows(b["id"]) if r["state"] in ("RUNNING", "RESPONDED", "FIXING")]
        if tasks:
            if b["state"] != "PAUSED" or b["pause_reason"] != "shared_defect":
                return True   # an active batch still needs this result officially collected
            by_id = {r["id"]: r for r in runs}
            for task in tasks:
                run = by_id.get(task["run_id"]) if task["run_id"] is not None else None
                if run is None or run["batch_id"] != b["id"] or run["task"] != task["task"]:
                    return True   # defer only task evidence bound to a confirmed, ended run
            # The shared-defect pause intentionally prevents collection until Maintenance releases the batch. Preserve
            # these completed run/task rows for the next instance instead of resubmitting an unproductive Line forever.
        return self.store.get(exit_verdict_key(b["id"])) is not None

    def _freeze(self, key) -> None:
        with self._frozen_lock:
            self._frozen_lanes.add(key)

    def _frozen_skips(self, key) -> bool:
        """A frozen lane means "no new AI start". While the gate is closed it still runs its tick (collection, save, Stop/
        Clear: a denied launch there writes nothing); with the gate open it keeps its old meaning and is skipped."""
        with self._frozen_lock:
            return key in self._frozen_lanes and self.launch_gate.is_open

    def _repo_fenced(self) -> bool:
        return self.fence is not None and bool(self.fence.blocked({"repo"}))

    def _adapter(self, producer: str):
        """`adapter` is one AgentAdapter, or a {name: adapter} map resolved via the registry."""
        if not isinstance(self.adapter, dict):
            return self.adapter
        name = registry(self.cfg).get(producer, {}).get("adapter", "")
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
            if not control.retired(b, self.cfg):
                self.store.line(b["producer"], b["method"])
        for ln in self.store.lines():
            if ln["method"] == MAINTENANCE_METHOD or control.retired(ln, self.cfg):
                continue   # Maintainer has one serialized AI slot; a retired Line (#9933) is history only
            if self._stop_requested():
                return   # STOPPING was recorded during this tick: no further Line is dispatched
            try:
                self._tick_line(ln["model"], ln["method"])
            except Exception:  # one Line's failure never stalls the others
                self.store.log(None, f"line {ln['model']}/{ln['method']} 예외:\n"
                               + traceback.format_exc()[-800:], "error", line=f"{ln['model']}/{ln['method']}")
        with self._frozen_lock:
            maintenance_frozen = None in self._frozen_lanes
        if self._stop_requested():
            return
        if not maintenance_frozen and not self._repo_fenced():
            try:
                try:
                    self._tick_maintenance()
                except Exception:
                    batches_ = self.store.maintenance_batches()
                    self.store.log(None, "Maintainer 실행/PR 감시 예외:\n" + traceback.format_exc()[-800:], "error",
                                   line=f"{batches_[0]['producer']}/m" if batches_ else None)
                self.maint.step()   # after the Lines: it reads the batch states they just advanced
            except LaunchDenied:
                self._freeze(None)

    def _handle_reload(self) -> None:
        """Operator `r`: re-read config.json. The new config replaces `self.cfg` only if it passes every check."""
        token = self.store.get("reload_req")
        if token is None or token == self.store.get("reload_done"):
            return
        self.store.set("reload_done", token)   # one request is answered once, whatever the outcome
        try:
            new = load_config(self.paths)
            problem = reload_problem(self.cfg, new, {b["producer"] for b in self.store.incomplete_batches()
                                                     if not control.retired(b, self.cfg) and not control.retired(b, new)})
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
        key = (model, method)
        if self._frozen_skips(key):
            return
        if self._repo_fenced():
            return   # every Line needs the repository: wait for the fence to clear without touching Line state
        with self.lanes.try_hold(model, method) as held:
            if held:
                try:
                    self._tick_line_locked(model, method)
                except LaunchDenied:
                    self._freeze(key)

    def _tick_line_locked(self, model: str, method: str) -> None:
        ln = self.store.line(model, method)
        if method == MAINTENANCE_METHOD:
            return self._tick_maintenance()
        if control.retired_line(model, method, self.cfg):
            return   # #9933: a retired Line is never dispatched, whichever loop reached it
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
            if (ln["run"] and not control.drained(self.store, ln) and not self._drain.is_set()
                    and not self._stop_requested()):
                self._prepare_new(ln)   # selecting a new batch is new work: never once this instance is STOPPING
            return
        handler = {"PREPARE": self._prepare_existing, "PRODUCING": self._poll_producing,
                   "FIXING": self._poll_run, "WAITING_REVIEW": self._watch,
                   "MERGED": self._to_cleanup, "CLEANUP": self._cleanup,
                   "PAUSED": self._wait_operator, "ERROR": self._wait_operator}[b["state"]]
        handler(b)

    def _tick_batch(self, b, *, allow_maintenance_fix: bool = True) -> None:
        """Advance one already-claimed batch without selecting a different issue or batch."""
        handler = {"PREPARE": self._prepare_existing, "PRODUCING": self._poll_producing,
                   "FIXING": self._poll_run, "WAITING_REVIEW": self._watch,
                   "MERGED": self._to_cleanup, "CLEANUP": self._cleanup,
                   "PAUSED": self._wait_operator, "ERROR": self._wait_operator}.get(b["state"])
        if handler is None:
            return
        if b["state"] == "WAITING_REVIEW" and b["method"] == MAINTENANCE_METHOD:
            return self._watch(b, allow_fix=allow_maintenance_fix)
        handler(b)

    def _tick_maintenance(self, *, collection_only: bool = False) -> None:
        """Run one Maintainer AI task while continuing every issue's independent PR lifecycle.

        Review feedback discovered during another issue's AI run stays attached to its own WAITING_REVIEW batch. It is
        applied only after the shared AI slot becomes free; merge detection and cleanup can continue in the meantime.
        """
        batches_ = self.store.maintenance_batches()
        current = [b for b in batches_ if b["state"] in ("PREPARE", "PRODUCING", "FIXING")
                   or b["pid"] is not None or self.store.open_task_runs(b["id"])]
        if len(current) > 1:
            ids = ", ".join(str(b["id"]) for b in current)
            self.store.log_once(None, f"Maintainer AI slot 충돌: 실행 상태 배치가 여러 개입니다 ({ids}). 모두 보존하고 시작을 멈춥니다.",
                                "error", line="maintainer")
            return
        # An operator Retry belongs to its producer, even when all Maintainer lines are idle.
        # Otherwise alphabetical default selection can leave another model's request stranded.
        model = (current[0]["producer"] if current else
                 next((line["model"] for line in self.store.lines() if line["method"] == MAINTENANCE_METHOD
                       and line["retry_batch"] is not None), None))
        if model is None:
            model = next((line["model"] for line in self.store.lines() if line["method"] == MAINTENANCE_METHOD
                          and line["run"]), None)
        if model is None:
            model = next((line["model"] for line in self.store.lines()
                          if line["method"] == MAINTENANCE_METHOD), None)
        if model is None:
            return
        ln = self.store.line(model, MAINTENANCE_METHOD)

        # Clear belongs to the request owner, even when the active/default Maintainer model differs.
        clear = next((request for line in self.store.lines() if line["method"] == MAINTENANCE_METHOD
                      if (request := self.store.clear_request(line["model"], MAINTENANCE_METHOD, actionable=True))
                      is not None), None)
        request = (self.store.pin_clear(clear["model"], MAINTENANCE_METHOD, batch_id=clear["batch_id"])
                   if clear is not None else None)
        if request is not None:
            clearing = self.store.batch(request["batch_id"])
            if clearing is not None and clearing["state"] == "CLEARING":
                self._clear(clearing)
                batches_ = self.store.maintenance_batches()
                current = [b for b in batches_ if b["state"] in ("PREPARE", "PRODUCING", "FIXING")
                           or b["pid"] is not None or self.store.open_task_runs(b["id"])]

        pin = self.store.get(f"stop_pin_{model}_{MAINTENANCE_METHOD}")
        if ln["force_stop"]:
            target = next((b for b in batches_ if str(b["id"]) == str(pin)), None) if pin else None
            if pin is None:
                target = current[0] if current else self.store.active_batch(model, MAINTENANCE_METHOD)
            self.store.set_line(model, MAINTENANCE_METHOD, force_stop=0)
            if pin is not None:
                self.store.delete(f"stop_pin_{model}_{MAINTENANCE_METHOD}")
                if target is None:
                    return self.store.log(None, f"Stop 무시: 요청한 실행 #{pin}이 더 이상 현재 실행이 아닙니다",
                                          "warn", line=f"{model}/{MAINTENANCE_METHOD}")
            if target is not None:
                return self._force_stop(target)
            return self.store.set_line(model, MAINTENANCE_METHOD, run=0)

        just_ticked = current[0]["id"] if current else None
        if current and (not collection_only or self._batch_has_open_work(current[0])):
            pending_diagnosis = (current[0]["method"] == MAINTENANCE_METHOD
                                 and current[0]["state"] == "PRODUCING"
                                 and current[0]["pid"] is None
                                 and self.store.get(f"m_diag_{current[0]['id']}") is not None)
            if not pending_diagnosis:
                self._tick_batch(current[0])

        if collection_only or self._drain.is_set():
            return

        # Review/merge/cleanup work does not use the Maintainer AI slot. Keep every owned PR attached and progressing.
        for b in self.store.maintenance_batches():
            if self._drain.is_set():
                return
            if b["id"] == just_ticked:
                continue   # a batch that just reached WAITING_REVIEW is watched on the next tick
            if b["state"] not in ("WAITING_REVIEW", "MERGED", "CLEANUP"):
                continue
            self._tick_batch(b, allow_maintenance_fix=not self.store.maintenance_batch_open())

        # A Retry is pinned to its issue attempt. Parked failures without an explicit Retry never claim or run AI.
        if self._drain.is_set():
            return
        retry_id = self.store.line(model, MAINTENANCE_METHOD)["retry_batch"]
        if retry_id is not None:
            target = self.store.batch(retry_id)
            if target is not None and target["method"] == MAINTENANCE_METHOD and target["state"] in ("PAUSED", "ERROR"):
                self._tick_batch(target)

    def _poll_producing(self, b) -> None:
        """A parallel Stage 2 Part is driven by its task plan (checked before the single-run poll); a closed plan
        re-enters the existing follow-up stages; every other batch keeps the single-run path."""
        plan = s2parallel.plan_state(self.store, b)
        if plan == "open":
            return self.s2p.poll(b)
        if plan == "closed" and b["run_kind"] == s2parallel.RUN_KIND and b["pid"] is None:
            return self.s2p.continue_after_close(b)
        if s3parallel.is_parallel(self.store, b) and b["run_kind"] == s3parallel.RUN_KIND:
            if s3parallel.plan_state(self.store, b) == "closed":
                return self.s3p.continue_after_close(b)   # a restart after the plan closed re-enters finalize
            return self.s3p.poll(b)
        return self._poll_run(b)

    # Templates used by the next AI launch, if one is needed, after a released batch resumes (#3349). Every run_kind
    # not modelled here returns None = "cannot prove what is delivered" and a prompt-only fix is held, never guessed.
    def resume_prompt_names(self, b) -> set[str] | None:
        if (b["method"] == STAGE2_METHOD and b["run_kind"] in ("fix_new", "fix_resume")
                and b["paused_from"] == "FIXING" and b["pr_number"]):
            # Every Stage 2 review-fix launch renders these templates, whether it starts a fresh
            # session or resumes the verified unpushed fix. Other gates may still prevent launch.
            return {"fix", "s2_policy_card"}
        if (b["method"] == STAGE2_METHOD and b["run_kind"] == "s2_repair_new"
                and b["paused_from"] == "PRODUCING" and not b["pr_number"]):
            try:
                state = self._stage2_repair_state(b, required=True)
                current = state.get("current")
                attempts = current.get("attempt_log") if isinstance(current, dict) else None
                groups = current.get("groups") if isinstance(current, dict) else None
                cursor = current.get("cursor") if isinstance(current, dict) else None
                if (isinstance(current, dict) and current.get("pending_answer") is None
                        and current.get("apply_intent") is None and isinstance(attempts, list) and attempts
                        and isinstance(attempts[-1], dict) and attempts[-1].get("status") == "rejected"
                        and isinstance(groups, list) and type(cursor) is int and 0 <= cursor < len(groups)
                        and any(group.get("candidate_keys") for group in stage2.repair_page(groups, cursor))
                        and self._stage2_repair_noncandidate_attempts(current) < stage2.REPAIR_ATTEMPTS_PER_PAGE):
                    # The retry either fails its existing guards or launches a fresh repair page; it cannot apply
                    # an old answer in this state. The page launch renders the operating checkout's s2_repair.
                    return {"s2_repair"}
            except (ValueError, TypeError, KeyError, AttributeError):
                pass
            return None
        if (b["method"] == STAGE2_METHOD and b["run_kind"] == "s2_deterministic_finalize"
                and b["paused_from"] == "PRODUCING" and not b["pr_number"]):
            # Finalization can finish without AI. If it needs AI, its only launch is a new repair page, which
            # renders s2_repair from the operating checkout; checkpoint and ownership guards still apply.
            return {"s2_repair"}
        return None

    def prompt_checkout_clean(self, paths: list[str]) -> bool:
        """The main checkout (where prompts are re-read) has these files committed and unmodified."""
        try:
            r = subprocess.run(["git", "status", "--porcelain", "--", *paths], cwd=self.code_root,
                               capture_output=True, text=True, timeout=30)
            return r.returncode == 0 and not r.stdout.strip()
        except Exception:
            return False

    def _loaded_code_sha(self, git) -> str | None:
        """HEAD of the checkout this process loaded its code from; None when unknown or its runtime source is modified
        (then no commit can be claimed as loaded and runtime-code fixes wait)."""
        try:
            if not self.code_root.joinpath(".git").exists():
                return None
            r = subprocess.run(["git", "status", "--porcelain", "--", "tools/warroom/warroom"], cwd=self.code_root,
                               capture_output=True, text=True, timeout=30)
            if r.returncode != 0 or r.stdout.strip():
                return None
            return git.head(self.code_root)
        except Exception:
            return None

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
                current = refine.ops(b).checkpoint(wt, b["shard"])
                if current != baseline["checkpoint"] or self._stage3_chunk_saved(b):
                    return None
                return f"s3:{b['shard']}:{baseline['chunk']}"
        except (OSError, ValueError, KeyError, TypeError, stage3.Stage3Error):
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
        with self.launch_gate.permit():   # the budget is consumed only by a launch that is actually admitted
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
            context = refine.spec_for(b).rule.decision_context(baseline["view"], baseline["chunk"])
            # The normalizer deliberately turns an empty body into `none` for its caller's save path. An
            # answer-only recovery must require an explicit decision body so a truncated header cannot advance.
            answer_lines = [line.strip() for line in answer.splitlines() if line.strip()] \
                if isinstance(answer, str) else []
            if len(answer_lines) < 2:
                return False
            normalized, warnings = refine.spec_for(b).rule.normalize_decisions(answer, baseline["chunk"], context)
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
        if self._stage3_chunk_run(b) and b["run_kind"] == "s3_chunk_new":
            raw = self.store.get(stage3.run_start_key(b["id"]))
            try:
                baseline = json.loads(raw or "null")
                if (not isinstance(baseline, dict) or baseline.get("view") is None
                        or self._stage3_chunk_boundary_problem(b) is not None
                        or self._stage3_chunk_saved(b)):
                    return False
                view = refine.ops(b).read_chunk(self.runner, self.env, wt, b["shard"])
                return view == baseline["view"] and view.get("chunk") == baseline.get("chunk")
            except (OSError, ValueError, KeyError, TypeError, stage3.Stage3Error):
                return False
        return False

    def _guarded(self, b, stage: str, fn, **evidence):
        """Run one retryable step; a transient query failure becomes a pending re-entry instead of ERROR/PAUSED."""
        if stage == "prelaunch":   # preparation (worktree, evidence, plans) precedes the launch's first write
            with self.launch_gate.permit():
                return self._guarded_admitted(b, stage, fn, **evidence)
        return self._guarded_admitted(b, stage, fn, **evidence)

    def _guarded_admitted(self, b, stage: str, fn, **evidence):
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
        if stage == "prelaunch":   # consuming the record is a write: admission comes first, so a denial leaves it intact
            with self.launch_gate.permit():
                return self._reenter_pending(b, stage, ev)
        return self._reenter_pending(b, stage, ev)

    def _reenter_pending(self, b, stage: str, ev: dict) -> bool:
        self.store.delete(f"pending_{b['id']}")   # consumed: a repeated transient failure records a new one
        if stage == "exit0":
            self._guarded(b, "exit0", self._judge_exit0, run_id=ev["run_id"])
        elif stage == "exit_failed":
            self._guarded(b, "exit_failed", lambda x: self._run_failed(x, ev["code"]), run_id=ev["run_id"], code=ev["code"])
        elif stage == "finalize":
            fin = {"s2_deterministic_finalize": self._stage2_finalize, "s3_finalize": self._stage3_finalize}
            fin[ev["run_kind"]](b)
        elif stage == "prelaunch":
            entry = {"prepare_existing": self._prepare_existing,
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
        if s2parallel.is_parallel(self.store, b) and not self.s2p.stop_workers(b):
            return False   # parallel Stage 2: every task process must be confirmed gone
        if s3parallel.is_parallel(self.store, b) and not self.s3p.stop_workers(b):
            return False   # parallel Stage 3: the same for every chunk task process
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
            # Its own PR merged meanwhile (merged=true is completion): hand it to cleanup instead of resuming or
            # holding it on a resume proof the merge itself invalidated (the deleted branch moves remote_head).
            if b["pr_number"] and self._recover_if_merged(b, force=ln["retry_batch"] == b["id"]):
                return
            if ln["retry_batch"] != b["id"]:
                return
            if not self.store.get(f"defect_hold_{b['id']}"):
                return self.store.set_line(b["producer"], b["method"], retry_batch=None)
            self._override_defect(b)
        elif ((ln["retry_batch"] != b["id"] or b["pr_number"])
              and self._recover_if_merged(b, force=ln["retry_batch"] == b["id"])):
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
            # An owner Stop turns the exhausted ERROR into PAUSED, so Stop & Retry arrives here as PAUSED.
            target = self._chunk_retry_target(b)
            if target is not None:
                self.store.delete(self._auto_retry_key(b, target))   # only an explicit operator Retry grants one new chance
            resume_state = b["paused_from"] or "PRODUCING"
            legacy_ff_error = (b["state"] == "ERROR" and b["paused_from"] == "FIXING" and b["pr_number"] is not None
                              and isinstance(b["error"], str)
                              and b["error"].startswith("원격 ref와 로컬 HEAD 불일치:"))
            if legacy_ff_error:
                # Older Supervisor releases treated every remote/local SHA difference as divergence. Re-enter the
                # owned PR watcher; it retries only after the complete safe fast-forward proof below.
                resume_state = "WAITING_REVIEW"
                self.store.log(b["id"], "기존 원격/local HEAD 불일치 오류: AI 재실행 없이 소유 PR fast-forward 안전 조건을 재확인합니다", "warn")
            fields = dict(state=resume_state, error=None, retries=0, retry_after=None,
                          pause_reason="", defect_id=None)
            self._drop_usage_limit_holds(b)
            self.store.set_line(b["producer"], b["method"], retry_batch=None, run=1)
            self.store.update(b["id"], **fields)
            self.store.log(b["id"], f"운영자 재시도: {resume_state}로 복귀")

    def _drop_usage_limit_holds(self, b) -> None:
        """An operator Retry declares the plan usage limit reset (e.g. the owner reset the tokens): every stated-reset
        wait on this batch's parallel tasks is dropped so they relaunch now. A failure after this Retry is held again."""
        now = self.clock()
        self.store.set(usage_limit_override_key(b["id"]), str(max((r["id"] for r in self.store.runs(b["id"])), default=0)))
        dropped = []
        for row in self.store.task_rows(b["id"]):
            if row["state"] == "SAVED":
                continue
            try:
                data = json.loads(row["data"] or "{}")
            except ValueError:
                continue
            if not isinstance(data, dict) or ("limit_until" not in data and float(data.get("retry_after") or 0) <= now):
                continue
            data.pop("limit_until", None)
            data.pop("retry_after", None)
            self.store.update_task(b["id"], row["task"], data=json.dumps(data, ensure_ascii=False, sort_keys=True))
            dropped.append(row["task"])
        if dropped:
            self.store.log(b["id"], f"운영자 Retry: 사용량 한도 해제 대기를 무시하고 즉시 재개합니다 ({', '.join(dropped)})", "warn")

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
            return force  # an explicit retry must not relaunch while the owned PR state is unknown
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
        if info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]:
            self.store.log(b["id"], "PR 소유권이 배치와 일치하지 않아 복구하지 않습니다", "error")
            return True
        if not info["merged"]:
            return force and info.get("state", "").lower() != "open"
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

    def _completed_fix_run(self, b) -> bool:
        """The last run is a finished FIX run (exit 0) whose completion the Supervisor verified; replies may still be pending."""
        last = self._last_run(b)
        return (last is not None and isinstance(last["kind"], str) and last["kind"].startswith("fix")
                and last["ended_at"] is not None and str(last["exit_status"]) == "0"
                and self.store.get(f"verified_completion_run_{b['id']}") == str(last["id"]) and bool(b["pr_number"]))

    def _verified_fix_exit(self, b) -> bool:
        """The last run is a finished FIX run (exit 0) whose completion evidence the Supervisor recorded."""
        return self._completed_fix_run(b)

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

    def _stage2_foreign_paths(self, b, info, files) -> set[str]:
        """Prove cross-shard amend output against the saved Part and its original commit."""
        own = {f"data/relations/relation-{b['shard']}.jsonl", f"data/relation-drops/drop-{b['shard']}.jsonl"}
        paths = {f["path"] for f in files}
        foreign = paths - own
        if not foreign or any(not re.fullmatch(r"data/relations/relation-\d{3}\.jsonl", p) for p in foreign):
            raise RecoveryBlocked("Stage 2 외부 Relation 산출물 범위가 잘못되었습니다")
        wt = Path(b["worktree"])
        initial = self.store.get(f"s2_commit_head_{b['id']}")
        head = info.get("head_sha")
        if not isinstance(initial, str) or not re.fullmatch(r"[a-f0-9]{40}", initial) or \
                self.git.head(wt) != head or self.git.dirty(wt).strip():
            raise RecoveryBlocked("외부 Relation의 초기 commit 또는 현재 clean HEAD를 증명할 수 없습니다")
        bb, pp = b["batch"].split("-")
        journal_path = wt / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.amend-state.json"
        try:
            journal = json.loads(journal_path.read_text("utf-8"))
            if journal.get("version") != 2 or not isinstance(journal.get("foreign"), dict):
                raise ValueError("missing foreign amend evidence")
            for name in foreign:
                entry = journal["foreign"][Path(name).name]
                for field, revision in (("baseline", initial), ("new", head)):
                    state = entry[field]
                    if state.get("exists") is not True or base64.b64decode(state["bytes"], validate=True) != self.git.file_at_revision(wt, revision, name):
                        raise ValueError(f"{name} {field} does not match commit")
        except (OSError, ValueError, KeyError, TypeError) as error:
            raise RecoveryBlocked(f"외부 Relation amend 증거가 일치하지 않습니다: {error}") from error
        ok, detail = self.git.verify_stage2_local(wt, b["shard"], bb, pp, checkpoint=True)
        if not ok:
            raise RecoveryBlocked(f"외부 Relation checkpoint 검증 실패: {detail}")
        return paths & own | foreign

    def _find_recovery_pr(self, b):
        """Find one owned-branch PR; data batches must also prove their Candidate or shard claim."""
        prs = self.gh.prs_for_branch(b["branch"])
        if not isinstance(prs, list):
            raise RecoveryBlocked("소유 브랜치 PR 조회 결과 형식이 잘못되었습니다")
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
        if b["method"] != MAINTENANCE_METHOD:
            files = self.gh.pull_files(number)
            if b["method"] == STAGE3_METHOD:
                try:
                    shard = refine.ops(b).validate_pr(info, files)
                except stage3.Stage3Error as error:
                    raise RecoveryBlocked(str(error)) from error
                if shard != b["shard"]:
                    raise RecoveryBlocked(f"PR #{number}가 {self._stage(b)} 소유 샤드 {b['shard']}와 다릅니다 ({shard})")
            candidates = batches.pr_claims(b, {"number": number, "files": files})
            expected = batches.expected_claim(b)
            # A no-op Stage 3 PR has no files; a cross-shard Stage's PR claims every shard it edits (#9928), its
            # scope already proven by `validate_pr` above.
            stage3_empty_diff = b["method"] == STAGE3_METHOD and (files == [] or refine.spec_for(b).cross_shard)
            foreign_stage2 = b["method"] == STAGE2_METHOD and candidates.count(expected) == 1 and len(candidates) > 1
            if foreign_stage2:
                self._stage2_foreign_paths(b, info, files)
            if not stage3_empty_diff and not foreign_stage2 and (candidates.count(expected) != 1 or any(item != expected for item in candidates)):
                raise RecoveryBlocked(f"PR #{number}의 Candidate 파일 소유권이 배치와 일치하지 않습니다 "
                                      f"(기대 {expected}, 확인 {candidates})")
        dup = self._duplicate_claim(b, number, set(candidates) if b["method"] == STAGE2_METHOD else None)
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
        if s2parallel.is_parallel(self.store, b):
            self.s2p.stop_workers(b)   # every task process; exits are confirmed by _reap_stopped
        if s3parallel.is_parallel(self.store, b):
            self.s3p.stop_workers(b, acknowledge=True)   # the operator's Stop
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
        req = self.store.clear_request(b["producer"], b["method"], batch_id=b["id"])
        if req is None or req["batch_id"] != b["id"]:
            return self._fail(b, "ERROR", "Clear 요청 기록을 찾을 수 없어 보존합니다.")
        if req["status"] == "BLOCKED":
            return
        ad = self._adapter(b["producer"])
        if s2parallel.is_parallel(self.store, b) and not self.s2p.stop_workers(b):
            return self.store.log(b["id"], "Clear: 병렬 Stage 2 task AI 프로세스 종료 요청, 종료 확인 대기")
        if s3parallel.is_parallel(self.store, b) and not self.s3p.stop_workers(b):
            return self.store.log(b["id"], f"Clear: 병렬 {self._stage(b)} task AI 프로세스 종료 요청, 종료 확인 대기")
        if b["pid"] is not None:
            if ad.alive(b["pid"]):
                ad.stop(b["pid"])
                return self.store.log(b["id"], "Clear: AI 프로세스 종료 요청, 종료 확인 대기")
            self.store.update(b["id"], pid=None)
            self.store.finish_runs(b["id"], "cleared")
            b = self.store.batch(b["id"])
        try:
            merged = self._clear_teardown(b, req)
        except ResourceFenced:
            raise
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
        if not (re.fullmatch(rf"maint-{re.escape(str(b['batch']))}(?:-[0-9]+)?", branch) if maint
                else branch == f"{b['method']}-{b['producer']}-{b['shard']}-{b['batch']}"):
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
        note = self.store.clear_request(b["producer"], b["method"], batch_id=b["id"])["note"]
        what = f"Maintainer urgent Issue #{b['batch']}" if maint else f"{b['method'].upper()} 배치 {b['shard']}_{b['batch']}"
        self.store.finish_clear(b, f"Clear 완료: {b['producer']}/{b['method'].upper()} {what} "
                                   f"(이전 상태 {req['prior_state']}, 기록 PR {('#' + str(b['pr_number'])) if b['pr_number'] else '없음'}); "
                                   f"{note}worktree·로컬 브랜치·실행 파일 정리")
        return None

    def _remove_run_files(self, b) -> None:
        logs = self.paths.logs.resolve()
        files = {Path(f) for r in self.store.runs(b["id"]) for f in (r["log_file"], r["exit_file"]) if f}
        files |= {Path(f) for f in (b["log_file"], b["exit_file"]) if f}
        files |= {f.with_name(f.name + ".prompt") for f in files if f.suffix == ".log"}   # oversized prompt (#6920)
        files |= set(logs.glob(f"batch-{b['id']}-*.log")) | set(logs.glob(f"batch-{b['id']}-*.exit"))
        files |= set(logs.glob(f"batch-{b['id']}-*.log.prompt"))
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
        if method == STAGE3_METHOD and (why := refine_problem(self.cfg, model)):
            return self._blocked(ln, "시작 차단: " + why)
        # The Stage 2 profile is proven here; a refinement shard's Stage (and so its `assignments.<role>`) is known only
        # once it is selected, and is proven there before any batch exists.
        if method == STAGE2_METHOD and (why := role_problem(self.cfg, model, STAGE2)):
            return self._blocked(ln, "시작 차단: " + why)
        key, line = f"line:{model}:{method}:prepare", f"{model}/{method}"
        if not self._transient_due(key):
            return   # a retryable lookup is backing off: the Line stays exactly as the operator left it
        d = auth.diagnose(self.runner, self.env, self.cfg["repo"], self.cfg["expected_account"])
        if d.get("transient"):
            return self._transient_wait(key, d["transient"], line=line)
        if not d["ok"]:
            return self._blocked(ln, "시작 차단: " + "; ".join(d["problems"]))
        if method == STAGE2_METHOD:
            problem = self._preflight_role(model, STAGE2)
            if problem and problem.startswith(PREFLIGHT_PENDING):
                return   # the CLI check runs in the background: this Line waits here, the others keep moving
            if problem:
                return self._blocked(ln, "시작 차단: " + problem)
        elif (problem := self._adapter_problem(model)):
            return self._blocked(ln, "시작 차단: " + problem)
        if self._stop_requested():
            return   # STOPPING landed while this Line was being checked: no Git work and no claim start after it
        if method == STAGE2_METHOD:
            return self._prepare_new_stage2(ln)
        if method == STAGE3_METHOD:
            return self._prepare_new_stage3(ln)
        return self._blocked(ln, f"시작 차단: 지원하지 않는 Line {method!r} (#9933)")

    def _prepare_new_stage3(self, ln) -> None:
        """Select the strict successor of the latest merged production PR of the first unfinished refinement Stage.

        Refinement Stages (S3, then S4, ...) share this line and run in order: a Stage starts only once every shard of
        the Stage before it is done, and each shard is gated on the previous Stage exactly as Stage 3 is on Stage 2."""
        model, method = ln["model"], STAGE3_METHOD
        base, line = self.cfg["base_branch"], f"{model}/{method}"
        key = f"line:{model}:{method}:prepare"
        wait_key, poll_key = f"s3_wait_{model}", f"s3_poll_{model}"
        if self.store.get(wait_key) and self.clock() - float(self.store.get(poll_key, "0")) < self.cfg["poll_seconds"]:
            return
        if not self._transient_due(key):
            return
        all_batches = self.store.all_batches()
        s3_batches = [b for b in all_batches if b["method"] == STAGE3_METHOD]
        occupied = next((b for b in s3_batches if b["state"] != "COMPLETE"), None)
        spec = refine.spec_for(occupied) if occupied else refine.stages()[0]
        try:
            if occupied:
                choice = refine.Choice("wait", note=f"{spec.label} 샤드 {occupied['shard']} 작업 점유")
            else:
                sha = None
                for spec in refine.stages():
                    latest = self.gh.latest_refine_production(base, spec)
                    sha = sha or self.git.fetch_base(base)
                    if latest and not self.git.is_ancestor(latest["merge_commit_sha"], sha):
                        choice = refine.Choice("wait", note=f"최근 {spec.label} 머지의 master 반영 대기")
                        break
                    choice = refine.ops_for(spec).choose(
                        kv=self.store, open_prs=self.gh.open_prs(),
                        stage2_batches=[b for b in all_batches if b["method"] == STAGE2_METHOD],
                        stage3_batches=s3_batches, latest_pr=latest,
                        pin=ln["shard_pin"] if ln["mode"] == "single" else "")
                    if choice.status != "done":
                        break
        except TRANSIENT as error:
            return self._transient_wait(key, error, line=line)
        except Exception as error:
            return self._blocked(ln, f"{spec.label} 샤드 선정 실패: {error}")
        self._transient_clear(key, line=line)
        if choice.status == "wait":
            if self.store.get(wait_key) != choice.note:
                self.store.log(None, f"{spec.label} 대기: {choice.note}", line=line)
            self.store.set(wait_key, choice.note)
            return self.store.set(poll_key, str(self.clock()))
        self.store.set(wait_key, "")
        if choice.status in ("done", "unready"):
            self.store.set_line(model, method, run=0, shard_pin="")
            note = "등록된 모든 정제 Stage의 전체 샤드 생산이 완료되었습니다." if choice.status == "done" else choice.note
            return self.store.log(None, note, line=line)
        # The selected Stage's own profile, proven before the batch exists: a missing `assignments.<role>` blocks only
        # this line (never borrows another Stage's profile); the pin proven here is the one its runs resolve to.
        if why := refine_problem(self.cfg, model, spec.role):
            return self._blocked(ln, f"{spec.label} 시작 차단: {why}")
        problem = self._preflight_role(model, spec.role)
        if problem and problem.startswith(PREFLIGHT_PENDING):
            return
        if problem:
            return self._blocked(ln, f"{spec.label} 시작 차단: {problem}")
        shard = choice.shard
        branch = spec.branch(model, shard)
        wt = self.paths.worktrees / spec.worktree_name(shard)
        try:
            bid = self.store.create_batch(method=method, producer=model, shard=shard, batch=spec.tag, branch=branch,
                                          worktree=str(wt), model_tier=ln["model_tier"], from_run=True,
                                          shard_pin=shard if ln["mode"] == "single" else None,
                                          run_kind="s3_chunk_new",
                                          kv={"s3_mode_{id}": stage3.PARALLEL}
                                          if self.parallel_new_s3 else None)   # same transaction as the batch row
        except LineNotRunnable:
            return
        except LineBusy as error:
            return self.store.log(None, str(error), "warn", line=line)
        self.store.log(bid, f"{spec.label} 샤드 {shard} 선정, 단일 PR 청크 편집을 준비합니다")
        self._prepare_existing(self.store.batch(bid))

    def _prepare_new_stage2(self, ln) -> None:
        """Assign the strict successor of the latest merged production Part."""
        model, method, base = ln["model"], STAGE2_METHOD, self.cfg["base_branch"]
        wait_key, poll_key, line = f"s2_wait_{model}", f"s2_poll_{model}", f"{model}/{method}"
        if self.store.get(wait_key) and self.clock() - float(self.store.get(poll_key, "0")) < self.cfg["poll_seconds"]:
            return
        if not self._transient_due(f"line:{model}:{method}:prepare"):
            return
        pin = ln["shard_pin"] if ln["mode"] == "single" else ""
        try:
            latest = self.gh.latest_stage2_production(base)
            sha = self.git.fetch_base(base)
            if latest and not self.git.is_ancestor(latest["merge_commit_sha"], sha):
                return self._stage2_selection_wait(wait_key, poll_key, line, "merge commit master 반영 대기")
            choice = stage2.choose(self.runner, self.paths.repo_root, self.env, ref=sha, sha=sha,
                                   open_prs=self.gh.open_prs(), kv=self.store, pin=pin, latest_pr=latest)
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
            return self._stage2_selection_wait(wait_key, poll_key, line, choice.note)
        self.store.set(wait_key, "")
        self.store.set(poll_key, "")
        if choice.status in ("done", "unready"):
            self.store.set_line(model, method, run=0, shard_pin="")
            return self.store.log(None, choice.note, line=line)
        part = choice.part
        if self.store.stage2_merged_complete(part.shard, part.key):
            return self._stage2_selection_wait(wait_key, poll_key, line,
                                               f"{part.shard}_{part.batch} Part {part.part} 검색 반영 대기")
        branch = f"{method}-{model}-{part.shard}-{part.key}"
        wt = self.paths.worktrees / f"{method}-{model}-{part.shard}_{part.key}"
        try:
            bid = self.store.create_batch(method=method, producer=model, shard=part.shard, batch=part.key,
                                          branch=branch, worktree=str(wt), model_tier=ln["model_tier"], from_run=True,
                                          shard_pin=part.shard if ln["mode"] == "single" else "",
                                          kv={stage2.layout_key(part.shard): part.layout_marker} if part.layout_marker else None)
        except LineNotRunnable:
            return
        except LineBusy as e:   # another model already holds the one Stage 2 occupancy
            return self.store.log(None, str(e), "warn", line=line)
        if self.parallel_new_parts:
            self.store.set(stage2.mode_key(bid), stage2.PARALLEL)   # fixed for this Part; a Part without it stays serial
        self.store.log(bid, f"Stage 2 {stage2.label(part.shard, part.key)} 선정, worktree 준비")
        self._prepare_existing(self.store.batch(bid))

    def _stage2_selection_wait(self, wait_key, poll_key, line, note):
        if self.store.get(wait_key) != note:
            self.store.log(None, f"Stage 2 대기: {note}", line=line)
        self.store.set(wait_key, note)
        self.store.set(poll_key, str(self.clock()))

    def _adapter_problem(self, producer: str) -> str | None:
        """Start is refused, never redirected, when this build has no adapter for the producer's CLI."""
        name = registry(self.cfg)[producer]["adapter"]
        if isinstance(self.adapter, dict) and name not in self.adapter:
            return f"{adapter_label(name)} CLI 어댑터가 이 War Room 빌드에 없습니다 — 다른 CLI로 대신 실행하지 않습니다."
        return None

    def _preflight_run(self, producer: str, run: RunSpec) -> str | None:
        """Fail closed before any process starts: the CLI must be able to run exactly this pinned RunSpec."""
        if problem := self._adapter_problem(producer):
            return problem
        return self._adapter(producer).preflight(self.runner, self.env, [run])

    def _preflight_role(self, producer: str, role: str) -> str | None:
        """Preflight of a not-yet-created batch: the pin `role` resolves to (Stage 2, or a selected refinement Stage)."""
        try:
            run = run_spec(self.cfg, producer, role)
        except ValueError as e:
            return str(e)
        return self._preflight_run(producer, run)

    def batch_run(self, b) -> tuple[RunSpec | None, str | None]:
        """(the RunSpec this batch's next session runs with, why it must not start). The one resolution every launch
        path (serial, review FIXING, Retry/Resume, parallel chunks) uses: the batch's own Stage role (`role_for`),
        proven by preflight on exactly the returned RunSpec, which is then the one spawned."""
        if b["method"] == STAGE3_METHOD and (problem := refine_problem(self.cfg, b["producer"])):
            return None, problem
        try:
            run = self._run(b)
        except ValueError as e:
            return None, str(e)
        return run, self._preflight_run(b["producer"], run)

    def _launch_env(self, b, kind: str, base_env: dict | None = None) -> dict:
        """Add run-specific worker environment without inheriting Stage 2 chunk restrictions into finalization."""
        env = dict(self.env if base_env is None else base_env)
        env.pop("WARROOM_SUPERVISOR_STATE_DB", None)
        env.pop("WARROOM_SUPERVISOR_BATCH_ID", None)
        env.pop("WARROOM_STAGE2_CHUNK", None)
        env.pop("WARROOM_STAGE2_REPAIR", None)
        env.pop("WARROOM_GIT_EXECUTABLES", None)
        env.pop("WARROOM_PROTECTED_PATHS", None)
        env.pop("WARROOM_ANSWER_ONLY", None)
        if b["method"] == STAGE2_METHOD and kind == "s2_repair_new":
            env["WARROOM_ANSWER_ONLY"] = "1"
            env["WARROOM_STAGE2_REPAIR"] = "1"
        # Chunk runs suppress auto-loaded AGENTS.md and web lookup. Execution rules stay adapter-specific; Codex keeps
        # the operator's configured permission profile, while answer-only results are judged by their output contract.
        if (b["method"] in (STAGE2_METHOD, STAGE3_METHOD) and isinstance(kind, str) and
                kind.startswith(("s2_chunk_", "s2_links_", "s2_repair_", "s3_chunk_"))):
            env["WARROOM_STAGE2_CHUNK"] = "1"
            git_executables = set()
            for entry in env.get("PATH", os.defpath).split(os.pathsep):
                candidate = Path(entry or os.curdir).expanduser() / "git"
                if candidate.is_file() and os.access(candidate, os.X_OK):
                    git_executables.update((str(candidate.absolute()), str(candidate.resolve())))
            env["WARROOM_GIT_EXECUTABLES"] = json.dumps(sorted(git_executables))
            env["WARROOM_PROTECTED_PATHS"] = json.dumps([
                str(self.paths.git_admin_dir.resolve()), str((Path(b["worktree"]) / ".git").resolve()),
            ])
        return env

    def _prepare_existing(self, b) -> None:
        if self._pending_gate(b):
            return
        self._guarded(b, "prelaunch", self._prepare_existing_do, entrypoint="prepare_existing")

    def _prepare_existing_do(self, b) -> None:
        wt = Path(b["worktree"])
        try:
            if not wt.exists():
                if self._stage2_reconcile_task(b):
                    base_revision, _change_point = self._stage2_reconcile_task(b)
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
        if b["method"] == MAINTENANCE_METHOD:
            if problem := self.maint.write_incident_evidence(b):
                return self._fail(b, "ERROR", problem)
        if b["method"] == STAGE2_METHOD:
            if self._stage2_reconcile_task(b):
                return self._stage2_reconcile_finalize(b)
            return self._launch_stage2_next(b)
        if b["method"] == STAGE3_METHOD:
            return self._launch_stage3_next(b)
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
        if phase == "chunk" and s2parallel.plan_state(self.store, b) in (None, "open") \
                and s2parallel.is_parallel(self.store, b):
            return self.s2p.begin(b)
        return self._launch(b, "s2_links_new" if phase == "links" else "s2_chunk_new")

    def _launch_stage3_next(self, b) -> None:
        if s3parallel.is_parallel(self.store, b):   # the mode was fixed with the batch row (#3149)
            if s3parallel.plan_state(self.store, b) == "closed":
                return self._guarded(b, "prelaunch", self.s3p.continue_after_close, entrypoint="launch_stage3_next")
            return self._guarded(b, "prelaunch", self.s3p.begin, entrypoint="launch_stage3_next")
        self._guarded(b, "prelaunch", lambda current: self._launch(current, "s3_chunk_new"),
                      entrypoint="launch_stage3_next")

    @_single_launch_scope
    def _relaunch_stage3_chunk(self, b) -> None:
        """Resume this exact unsaved chunk or accept its one saved checkpoint advance; never select a new shard."""
        try:
            if self.git.registered(Path(b["worktree"])) != b["branch"]:
                return self._fail(b, "ERROR", f"{self._stage(b)} worktree가 소유 브랜치에 등록되어 있지 않습니다. 보존합니다.")
            if self.git.dirty(b["worktree"]).strip():
                return self._fail(b, "ERROR", f"{self._stage(b)} 재시도 전 추적 파일 변경이 있어 보존합니다.")
            if self._find_recovery_pr(b) is not None:
                return self._fail(b, "ERROR", f"{self._stage(b)} 청크 중 예상하지 않은 소유 PR이 있어 재실행을 중단합니다. 보존합니다.")
        except TRANSIENT:
            raise
        except Exception as error:
            return self._fail(b, "ERROR", f"{self._stage(b)} 재시도 전 worktree/PR 확인 실패: {error}. 보존합니다.")
        raw = self.store.get(stage3.run_start_key(b["id"]))
        if raw is not None:
            problem = self._stage3_chunk_boundary_problem(b)
            if problem:
                return self._fail(b, "ERROR", problem)
            baseline = json.loads(raw)
            if baseline.get("view") is None:
                if self._stage3_chunk_saved(b):
                    return self._fail(b, "ERROR", f"view 스냅샷이 없는 구 {self._stage(b)} 실행에서 checkpoint가 진행됐습니다. 저장 응답의 원본을 증명할 수 없어 다음 청크로 진행하지 않고 보존합니다.")
                return self._stage3_fallback_for_missing_view(b)
            if not isinstance(baseline["view"], dict):
                return self._fail(b, "ERROR", f"{self._stage(b)} 실행 시작 read-chunk view 스냅샷이 손상되었습니다. worktree와 응답을 보존합니다.")
            if baseline.get("answer_invalidated"):
                if self._stage3_chunk_saved(b):
                    return self._fail(b, "ERROR", f"입력 view 변경으로 응답이 무효화된 {self._stage(b)} 청크가 이미 저장됐습니다. checkpoint와 결과를 보존합니다.")
                try:
                    current_view = refine.ops(b).read_chunk(self.runner, self.env, b["worktree"], b["shard"])
                except TRANSIENT:
                    raise
                except Exception as error:
                    return self._fail(b, "ERROR", f"Maintainer 통합 후 현재 {self._stage(b)} 청크 재준비를 확인하지 못했습니다: {error}. 보존합니다.")
                if current_view != baseline["view"] or current_view.get("chunk") != baseline.get("chunk"):
                    return self._fail(b, "ERROR", f"Maintainer 통합 후 {self._stage(b)} 청크 view가 재결속된 기준과 달라 재사용/재생성을 중단합니다. 보존합니다.")
                try:
                    if self._find_recovery_pr(b) is not None:
                        return self._fail(b, "ERROR", f"{self._stage(b)} 청크 재준비 전에 예상하지 않은 소유 PR이 있어 중단합니다. 보존합니다.")
                except TRANSIENT:
                    raise
                except Exception as error:
                    return self._fail(b, "ERROR", f"{self._stage(b)} 청크 재준비 전 PR 소유권 확인 실패: {error}. 보존합니다.")
                self.store.log(b["id"], f"Maintainer 통합으로 {self._stage(b)} 청크 {baseline['chunk']} 입력 view가 바뀌어 이전 답변을 폐기하고 같은 미완료 청크만 새 세션으로 준비합니다.", "warn")
                self.store.update(b["id"], session_id=None)
                return self._launch(self.store.batch(b["id"]), "s3_chunk_fallback_new")
        if self._stage3_chunk_saved(b):
            if problem := self._saved_chunk_identity_problem(b):
                return self._fail(b, problem[0], f"저장된 {self._stage(b)} 청크의 실행 소유권/핀 확인 실패: {problem[1]}")
            self.store.log(b["id"], f"이전 실행의 현재 {self._stage(b)} 청크 저장을 확인했습니다. 재생산하지 않고 다음 청크로 진행합니다.")
            self.store.delete(stage3.run_start_key(b["id"]))
            self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
            return self._launch_stage3_next(self.store.batch(b["id"]))
        if raw is not None:
            if b["run_kind"] == "s3_chunk_fallback_new":
                return self._fail(b, "PAUSED", f"해당 {self._stage(b)} 청크의 허용된 새 세션도 완료되지 않았습니다. 추가 AI 재호출 없이 상태를 보존합니다.")
            latest_run = next(iter(self.store.runs(b["id"])), None)
            submit_failures = int(latest_run["submit_failures"] or 0) if latest_run else 0
            if submit_failures >= 2:
                return self._fail(b, "ERROR", f"정규화한 {self._stage(b)} 응답도 strict save-chunk가 거부했습니다. AI 재호출 없이 worktree와 응답을 보존합니다.")
            answer = self._adapter(b["producer"]).final_answer(Path(b["log_file"])) if b["log_file"] else None
            if answer is not None:
                if problem := self._saved_chunk_identity_problem(b):
                    self.store.log(b["id"], f"보존된 {self._stage(b)} 응답 소유권을 확인하지 못해 현재 청크만 새 세션으로 전환합니다: {problem[1]}", "warn")
                else:
                    self.store.log(b["id"], f"보존된 {self._stage(b)} 응답과 청크 소유권을 확인했습니다. AI 재호출 없이 결정 정규화와 strict 저장을 다시 수행합니다.", "warn")
                    return self._run_ok_stage3_chunk(self.store.batch(b["id"]))
            else:
                self.store.log(b["id"], f"보존된 {self._stage(b)} 최종 응답이 없어 현재 미완료 청크만 새 세션으로 생성합니다.", "warn")
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
            after = refine.ops(b).checkpoint(b["worktree"], b["shard"])
            return stage3.chunk_saved_since(baseline["checkpoint"], after)
        except (OSError, ValueError, KeyError, TypeError, stage3.Stage3Error):
            return False

    def _stage3_chunk_boundary_problem(self, b, base_override: dict | None = None) -> str | None:
        raw = json.dumps(base_override) if base_override is not None else self.store.get(stage3.run_start_key(b["id"]))
        if raw is None:
            return f"{self._stage(b)} 청크 실행 기준이 없어 재개를 중단합니다. worktree를 보존합니다."
        try:
            baseline = json.loads(raw)
            if (not isinstance(baseline, dict) or baseline.get("branch") != b["branch"]
                    or baseline.get("worktree") != str(b["worktree"])
                    or baseline.get("chunk") != stage3.next_chunk(baseline.get("checkpoint", {}))):
                return f"{self._stage(b)} 청크 실행 기준이 손상되었거나 다른 실행을 가리킵니다. worktree를 보존합니다."
            wt = Path(b["worktree"])
            if self.git.registered(wt) != b["branch"]:
                return f"{self._stage(b)} worktree가 소유 브랜치에 등록되어 있지 않습니다. 보존합니다."
            if self.git.head(wt) != baseline.get("head"):
                return f"{self._stage(b)} AI 실행 중 worktree HEAD가 바뀌었습니다. 보존합니다."
            if self.git.remote_head(b["branch"]) != baseline.get("remote_head"):
                return f"{self._stage(b)} AI 실행 중 원격 브랜치가 바뀌었습니다. 보존합니다."
            if self.git.dirty(wt).strip():
                return f"{self._stage(b)} AI가 Git 추적 파일을 변경했습니다. 결정 파일로 받아들이지 않고 보존합니다."
            current = refine.ops(b).checkpoint(wt, b["shard"])
            original = baseline["checkpoint"]
            if current is None or (current != original and not stage3.chunk_saved_since(original, current)):
                return f"{self._stage(b)} checkpoint가 실행 시작 상태와 다릅니다. 변경을 Keep-all로 가리지 않고 보존합니다."
        except TRANSIENT:
            raise
        except Exception as error:
            return f"{self._stage(b)} 실행 경계를 확인하지 못했습니다: {error}. 보존합니다."
        return None

    def _stage3_fallback_for_missing_view(self, b) -> None:
        """Discard an unbound legacy answer and start this exact chunk once with a saved view."""
        if b["run_kind"] == "s3_chunk_fallback_new":
            return self._fail(b, "PAUSED", f"새 {self._stage(b)} fallback 실행 기준에 read-chunk view가 없습니다. 추가 AI 재호출 없이 상태를 보존합니다.")
        with self.launch_gate.permit():
            self.store.log(b["id"], f"기존 {self._stage(b)} 실행에 원본 read-chunk view 스냅샷이 없어 보존 응답을 폐기하고 현재 청크만 새 세션으로 처리합니다.", "warn")
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
                    return self._fail(b, "ERROR", f"view 스냅샷이 없는 구 {self._stage(b)} 실행에서 checkpoint가 진행됐습니다. 저장 응답의 원본을 증명할 수 없어 다음 청크로 진행하지 않고 보존합니다.")
                info = self._find_recovery_pr(b)
                if info is not None:
                    raise stage3.Stage3Error(f"청크 실행 중 소유 PR #{info['number']}이 발견되었습니다")
                return self._stage3_fallback_for_missing_view(b)
            if not isinstance(baseline["view"], dict):
                raise stage3.Stage3Error(f"{self._stage(b)} 실행 시작 read-chunk view 스냅샷이 손상되었습니다")
            if self._stage3_chunk_saved(b):
                info = self._find_recovery_pr(b)
                if info is not None:
                    raise stage3.Stage3Error(f"저장 청크 진행 중 소유 PR #{info['number']}이 발견되었습니다")
                saved = {"chunk": chunk}
                after = refine.ops(b).checkpoint(b["worktree"], b["shard"])
            else:
                info = self._find_recovery_pr(b)
                if info is not None:
                    raise stage3.Stage3Error(f"청크 실행 중 소유 PR #{info['number']}이 발견되었습니다")
                answer = self._adapter(b["producer"]).final_answer(Path(b["log_file"]))
                view = refine.ops(b).read_chunk(self.runner, self.env, b["worktree"], b["shard"])
                original_view = baseline["view"]
                if original_view != view:
                    raise stage3.Stage3Error("read-chunk view가 실행 시작 시 저장한 결정 기준과 다릅니다")
                context = refine.spec_for(b).rule.decision_context(original_view, chunk)
                normalized, warnings = refine.spec_for(b).rule.normalize_decisions(answer, chunk, context)
                if warnings:
                    self.store.log(b["id"], f"{self._stage(b)} 청크 {chunk} 판정 정규화: {'; '.join(warnings)}", "warn")
                saved = refine.ops(b).save_chunk(self.runner, self.env, b["worktree"], b["shard"], chunk, normalized)
                after = refine.ops(b).checkpoint(b["worktree"], b["shard"])
                if saved.get("chunk") != chunk or not stage3.chunk_saved_since(baseline["checkpoint"], after):
                    raise stage3.Stage3Error("save-chunk 결과가 checkpoint를 정확히 한 청크만 진행시키지 않았습니다")
            progress = stage3.progress(after)
        except TRANSIENT:
            raise
        except (OSError, ValueError, KeyError, TypeError, RecoveryBlocked, DuplicateClaim, stage3.Stage3Error) as error:
            self.store.add_submit_failure(b["id"])
            return self._fail(b, "ERROR", f"{self._stage(b)} 청크 응답을 저장하지 못했습니다. worktree와 로그를 보존합니다: {error}")
        self.store.delete(stage3.run_start_key(b["id"]))
        self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None,
                          progress_kind="chunks", progress_done=progress[0], progress_total=progress[1])
        self.store.log(b["id"], f"{self._stage(b)} 청크 {saved.get('chunk', chunk)} 저장 ({progress[0]}/{progress[1]}). 다음 청크는 새 세션에서 시작합니다.")
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
        verify, command = self._refine_verify_call(b, head)
        first = verify()
        if first.ok:
            return None
        if first.failure is not None:
            return f"{self._stage(b)} shard verify에서 데이터/편집 검증 오류가 확인됐습니다 (HEAD {head[:10]}): {first.tail}"
        second = verify()
        same_failure = (not second.ok and second.failure is None and first.code == second.code
                        and first.tail == second.tail)
        if not same_failure or not self._stage3_cli_crash(first):
            detail = second.tail if not same_failure else first.tail
            return (f"{self._stage(b)} shard verify 실패를 공통 코드 결함으로 확인하지 못했습니다 "
                    f"(HEAD {head[:10]}, 재현 일치={same_failure}): {detail}")

        fingerprint = hashlib.sha256(f"{head}\n{command}\n{first.code}\n{first.tail}".encode("utf-8")).hexdigest()[:16]
        report = {
            "version": 1,
            "defect_class": f"stage3-verify-cli-{b['shard']}",
            "summary": f"{self._stage(b)} 샤드 {b['shard']} verify가 같은 HEAD에서 Relation CLI runtime exception으로 두 번 실패했습니다.",
            "failing_cases": [f"HEAD {head}; {command}; exit {first.code}; {first.tail}"],
            "reproduction": f"{command} at HEAD {head}; 두 번 실행해 exit {first.code}와 동일 오류를 확인했습니다.",
            "suspected_layer": f"{command} (uncaught project-code runtime exception)",
            "root_cause": "공식 verify 명령이 코드 예외로 종료했습니다. Maintainer가 공유 CLI/검증기 원인을 조사해야 합니다.",
            "scope": f"{self._stage(b)} 최종화, shard {b['shard']}; 동일 명령과 오류를 재현한 HEAD {head}.",
            "proposed_fix": "예외를 발생시킨 공유 CLI/검증기 원인을 수정하고 재현 회귀를 추가합니다.",
            "regression": f"HEAD {head}의 {command}에서 관찰된 예외를 old-fails/new-passes로 재현합니다.",
        }
        event_key = f"stage3-verify:{b['id']}:{head}:{fingerprint}"
        self.maint.report(b, "report", event_key, json.dumps(report, ensure_ascii=False, sort_keys=True))
        current = self.store.batch(b["id"])
        if current["state"] == "PAUSED" and current["pause_reason"] == "shared_defect":
            self.store.log(b["id"], f"{self._stage(b)} shard verify의 공통 CLI 예외를 같은 HEAD에서 재현해 기존 Maintainer 경로로 이관했습니다 ({command}).", "warn")
            return "reported"
        return f"{self._stage(b)} verify의 재현된 CLI 오류를 Maintainer 경로에 등록하지 못했습니다. worktree를 보존합니다."

    def _refine_verify_call(self, b, head: str):
        """The exact-commit verify of a refinement batch's Stage, and its command for reports: the shard's admission
        verify, or for a cross-shard Stage its CLI verify over every shard the PR (merge base..`head`) affects."""
        spec = refine.spec_for(b)
        if not spec.cross_shard:
            return (lambda: self.git.verify_stage2_outcome(head, "shard", b["shard"], None, None),
                    f"node scripts/relation/admission-cli.mjs verify --shard {b['shard']} --json")
        base = self.git.merge_base(Path(b["worktree"]), head, f"origin/{self.cfg['base_branch']}")
        return (lambda: self.git.verify_refine_outcome(head, spec.cli, b["shard"], base),
                f"node {spec.cli} verify --shard {b['shard']} --base {base}")

    def _refine_verify(self, b, head: str) -> tuple[bool, str]:
        """(ok, tail) of the exact-commit verify: Stage 3 keeps its shard `verify_stage2`."""
        if not refine.spec_for(b).cross_shard:
            return self.git.verify_stage2(head, "shard", b["shard"], None, None)
        outcome = self._refine_verify_call(b, head)[0]()
        return outcome.ok, outcome.tail

    def _refine_no_change(self, b, head: str, result: dict) -> None:
        """#9928: every chunk is saved and the official apply changed nothing. Verify the unchanged HEAD, record the
        shard's completion (`<id>_nochange_SSS`, the produced shard only) and clean up without a commit or PR."""
        spec, wt = refine.spec_for(b), Path(b["worktree"])
        if self.git.registered(wt) != b["branch"] or self.git.dirty(wt).strip():
            raise GitError(f"{self._stage(b)} 무변경 완료 전 worktree 소유권·clean 상태를 확인하지 못했습니다")
        verify = self._stage3_finalize_verify(b, head)
        if verify == "reported":
            return
        if verify:
            raise GitError(verify)
        self.store.set(spec.nochange_key(b["shard"]), head)
        self.store.set(spec.ok_key(b["shard"]), head)
        self.store.log(b["id"], f"{self._stage(b)} 샤드 {b['shard']} 무변경 완료: {prbody.stage4_sense_summary(result)}, "
                       f"비용 {prbody.run_cost(self.store.runs(b['id'])) or '미측정'}. commit·PR 없이 정리합니다.")
        self.store.update(b["id"], state="CLEANUP", run_kind=None, pid=None)

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
        if self._finalization_held(b, "s3_finalize"):
            return
        self._guarded(b, "finalize", self._stage3_finalize_do)

    def _stage3_finalize_do(self, b) -> None:
        """Apply all persisted chunk edits, verify and submit the shard's single bounded data PR."""
        wt = Path(b["worktree"])
        self.store.update(b["id"], state="PRODUCING", pid=None, run_kind="s3_finalize", error=None)
        spec = refine.spec_for(b)
        label = registry(self.cfg)[b["producer"]].get("label", b["producer"])
        title = spec.title_for(label, b["shard"])
        legacy_title = spec.legacy_title(b["shard"]) if spec.legacy_title else None   # commits made before #2838
        try:
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._to_review(b, info)
            checkpoint = refine.ops(b).checkpoint(wt, b["shard"])
            applied_key = f"s3_apply_ready_{b['id']}"
            result_key = f"s3_apply_result_{b['id']}"
            pre_key = f"s3_pre_apply_{b['id']}"
            if checkpoint is not None:
                if len(checkpoint["completed_chunks"]) != checkpoint["chunk_total"]:
                    raise stage3.Stage3Error(f"모든 {self._stage(b)} 청크 완료 전에 apply 할 수 없습니다")
                # The edit CLI removes the local checkpoint after its atomic two-file apply. Persist this in-flight
                # finalization state so a Supervisor restart can report the Git diff and continue without re-editing.
                self.store.set(applied_key, "1")
                # The CLI deletes the checkpoint when apply finishes: persist the baseline measurements first so a
                # restart between apply and the result save can still report them.
                pre = {"chunks_done": len(checkpoint["completed_chunks"]), "chunks_total": checkpoint["chunk_total"]}
                reviewed = self.git.row_count(self.git.head(wt), f"data/relations/relation-{b['shard']}.jsonl")
                if reviewed is not None:
                    pre["reviewed"] = reviewed
                self.store.set(pre_key, json.dumps(pre, sort_keys=True))
                result = refine.ops(b).apply(self.runner, self.env, wt, b["shard"])
                result.update(pre)
                self.store.set(result_key, json.dumps(result, sort_keys=True))
            elif self.store.get(applied_key) == "1":
                raw_result = self.store.get(result_key)
                try:
                    result = json.loads(raw_result) if raw_result else {}
                except (TypeError, ValueError) as error:
                    raise stage3.Stage3Error(f"저장된 {self._stage(b)} apply 결과를 읽을 수 없습니다") from error
                if not isinstance(result, dict):
                    raise stage3.Stage3Error(f"저장된 {self._stage(b)} apply 결과 형식이 올바르지 않습니다")
                try:
                    pre = json.loads(self.store.get(pre_key) or "{}")
                except ValueError:
                    pre = {}
                for key, value in (pre if isinstance(pre, dict) else {}).items():
                    result.setdefault(key, value)
            else:
                raise stage3.Stage3Error(f"{self._stage(b)} checkpoint가 없어 apply 완료 여부를 복구할 수 없습니다")
            self._stage3_log_repair_conflicts(b, result)
            report = refine.ops(b).report(self.runner, self.env, wt, b["shard"])
            result.setdefault("removed", len(report.get("deleted_relations", [])))
            result.setdefault("repaired", len(report.get("link_repairs", [])))
            result.setdefault("edit_drops_added", len(report.get("added_drops", [])))
            self.store.set(result_key, json.dumps(result, sort_keys=True))
            changed = self.git.changed_paths(wt)
            # The Stage's edit scope, given what changed: the single definition (`RefineSpec.scope`).
            allowed = spec.scope(b["shard"], changed)
            unexpected = changed - allowed
            if unexpected:
                raise GitError(f"{self._stage(b)} apply가 허용되지 않은 파일을 변경했습니다: {sorted(unexpected)}")
            commit_key = f"s3_commit_head_{b['id']}"
            committed = self.store.get(commit_key)
            head = self.git.head(wt)
            self.maint.adopt_released_baseline(self.store.batch(b["id"]))
            released_head = self.store.get(f"s3_finalize_released_head_{b['id']}")
            if committed is not None:
                if committed == head:
                    if changed or set(self.git.changed_files(head)) - spec.scope(b["shard"], self.git.changed_files(head)):
                        raise GitError(f"기록된 {self._stage(b)} commit이 허용 파일 범위를 벗어났습니다 ({committed} / {head})")
                elif (released_head != head or not self.git.contains(wt, committed)
                      or set(self.git.changed_files(committed)) - spec.scope(b["shard"], self.git.changed_files(committed))):
                    raise GitError(f"기록된 {self._stage(b)} commit과 승인된 Maintainer 통합 HEAD가 다릅니다 ({committed} / {head})")
                else:
                    self.store.log(b["id"], f"승인된 Maintainer 통합 HEAD {head[:10]}에서 기존 {self._stage(b)} 데이터 commit {committed[:10]}을 이어 검증합니다.")
            elif changed:
                head = self.git.commit_paths(wt, sorted(changed), title)
                self.store.set(commit_key, head)
                self.store.log(b["id"], f"{self._stage(b)} 변경 파일을 commit했습니다 ({head[:10]})")
            elif spec.no_change_complete:
                return self._refine_no_change(b, head, result)
            elif self.git.commit_subject(wt) in (title, legacy_title) and self.git.commit_parent(wt) is not None:
                committed_paths = set(self.git.changed_files(head))
                unexpected = committed_paths - spec.scope(b["shard"], committed_paths)
                if unexpected:
                    raise GitError(f"기존 {self._stage(b)} commit이 허용되지 않은 파일을 변경했습니다: {sorted(unexpected)}")
                head = self.git.head(wt)
                self.store.set(commit_key, head)
            else:
                head = self.git.commit_paths(wt, [], title, allow_empty=True)
                self.store.set(commit_key, head)
                self.store.log(b["id"], f"{self._stage(b)} 변경이 없는 샤드를 명시적 empty commit으로 기록했습니다")
            if self.git.dirty(wt).strip():
                raise GitError(f"{self._stage(b)} commit 뒤 worktree가 깨끗하지 않아 push를 중단합니다")
            remote = self.git.remote_head(b["branch"])
            remote_key = f"s3_commit_remote_head_{b['id']}"
            previous_remote = self.store.get(remote_key)
            if previous_remote is None:
                self.store.set(remote_key, remote or "")
            elif previous_remote != (remote or "") and remote != head:
                raise GitError(f"{self._stage(b)} verify 전 기록한 원격 기준이 변경됐습니다 ({previous_remote or None} / {remote})")
            verify = self._stage3_finalize_verify(b, head)
            if verify == "reported":
                return
            if verify:
                raise GitError(verify)
            if remote != head:
                if remote is not None and not self.git.contains(wt, remote):
                    raise GitError(f"{self._stage(b)} 원격 브랜치가 로컬 HEAD의 조상이 아닙니다 ({remote} / {head})")
                self.git.push_branch(wt, b["branch"])
                remote = self.git.remote_head(b["branch"])
            if remote != head:
                raise GitError(f"push 뒤 {self._stage(b)} 원격 HEAD가 다릅니다 ({remote} / {head})")
            open_prs = self.gh.open_prs()
            occupied = set().union(*(batches.pr_stage3_shards(pr) for pr in open_prs)) if open_prs else set()
            if b["shard"] in occupied:
                raise stage3.Stage3Error(f"샤드 {b['shard']} Relation/Drop을 점유한 다른 PR이 열려 있습니다")
            info = self._find_recovery_pr(b)
            if info is not None:
                return self._to_review(b, info)
            issue = self.gh.issue(spec.issue)
            labels = issue.get("labels", [])
            cost = prbody.run_cost(self.store.runs(b["id"]))
            body = (spec.body(label, b["shard"], result=result, cost=cost) if spec.body else
                    prbody.stage3_body(label, b["shard"], result=result, apply_pass=True, shard_verify=True,
                                       cost=cost, method=spec.short, issue=spec.issue))
            return self._create_pr_once(b, title, body, labels)
        except TRANSIENT:
            raise
        except (GitError, stage3.Stage3Error, OSError, ValueError, KeyError, TypeError) as error:
            return self._fail(b, "ERROR", f"{self._stage(b)} 최종화 중단: {error}. worktree와 checkpoint를 보존합니다.")
        except Exception as error:
            return self._fail(b, "ERROR", f"{self._stage(b)} 최종화 중단: {error}. worktree와 checkpoint를 보존합니다.")

    # ---- launching runs ------------------------------------------------
    def _stage(self, b) -> str:
        """The label of a refinement batch's own Stage for messages ("Stage 3"); "정제 Stage" for an unknown tag."""
        return control.stage_label(b) or "정제 Stage"

    def _run(self, b) -> RunSpec:
        """The model and effort this batch's next run is pinned to: its own Stage's assignment (`role_for`)."""
        return run_spec(self.cfg, b["producer"], role_for(b))

    def _recorded_run(self, b) -> RunSpec | None:
        """The settings the batch's current run was launched with (the store is the source of truth)."""
        r = next((r for r in self.store.runs(b["id"]) if r["model"]), None)
        return RunSpec(r["model"], r["effort"], r["permission_profile"] or "",
                       fast=None if r["fast_mode"] is None else bool(r["fast_mode"])) if r else None

    def _agent_env(self) -> dict:
        """Worker CLIs run with the normal environment (and normal Git). The Git binaries on PATH are only recorded so
        a Stage 2 chunk can have them blocked; with none found, only that chunk fails closed (`stage2_git_executables`)."""
        env = {k: v for k, v in self.env.items() if k not in ("WARROOM_GIT_SHIM", "WARROOM_GIT_SHIM_EXEC_PID",
                                                               "WARROOM_REAL_GIT")}   # leftovers of the removed shim
        return env

    @_single_launch_scope
    def _launch(self, b, kind: str, events=None, *, s2_resume_run_id=None, s2_fix_note: str = "") -> None:
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
        repair_spawn_entered = False
        try:   # never run with a CLI default model or effort
            run = self._run(b)
        except ValueError as e:
            return self._fail(b, "ERROR", f"실행 설정 오류로 AI를 시작하지 않았습니다: {e}")
        if b["method"] == STAGE3_METHOD and kind.endswith("_resume"):
            recorded = self._recorded_run(b)
            stage = refine.spec_for(b).label
            if recorded is None:
                return self._fail(b, "ERROR", f"{stage} 기존 세션의 model/effort/permission_profile/fast 기록이 없어 재개하지 않습니다. "
                                  "worktree와 세션을 보존합니다.")
            if recorded != run:
                return self._fail(
                    b, "ERROR",
                    f"{stage} 프로필이 기존 실행 후 바뀌어 그 세션을 새 설정으로 재개하지 않습니다 "
                    f"(기존 model={recorded.model}, effort={recorded.effort}, "
                    f"permission_profile={recorded.permission_profile or '(기본)'}, fast={recorded.fast}; "
                    f"현재 model={run.model}, effort={run.effort}, "
                    f"permission_profile={run.permission_profile or '(기본)'}, fast={run.fast}). "
                    "worktree와 세션을 보존합니다.",
                )
        if kind.startswith("fix") and b["method"] in (STAGE3_METHOD, MAINTENANCE_METHOD) and not events:
            return self._fail(b, "ERROR", "현재 PR HEAD에 유효한 리뷰 수정 이벤트가 없어 AI를 시작하지 않았습니다. 오래된 HEAD 이벤트는 되살리지 않습니다.")
        # Every launch proves the CLI again (cached once proven), on exactly the RunSpec it spawns.
        if b["method"] == STAGE3_METHOD and (problem := refine_problem(self.cfg, b["producer"])):
            return self._fail(b, "ERROR", f"실행 전 확인 실패: {problem}")
        problem = self._preflight_run(b["producer"], run)
        if problem and problem.startswith(PREFLIGHT_PENDING):
            return   # still proving the pin in the background; the next tick retries this relaunch
        if problem:
            return self._fail(b, "ERROR", f"실행 전 확인 실패: {problem}")
        preclaimed_run_id = None
        if b["method"] == MAINTENANCE_METHOD and kind.startswith("fix"):
            # Persist assignment before spawning. A crash leaves CLAIMED evidence and never silently relaunches.
            preclaimed_run_id = self.store.add_run(
                b["id"], kind, None if kind == "fix_new" else sid, None, log, ex,
                model=run.model, effort=run.effort, permission_profile=run.permission_profile, fast_mode=run.fast)
            keys = [e["key"] for e in events]
            self.store.claim_events(b["id"], b["pr_number"], b["head_sha"], keys, preclaimed_run_id)
            self.store.set(f"fix_claim_{b['id']}", json.dumps({
                "pr": b["pr_number"], "head_sha": b["head_sha"], "event_keys": keys,
                "run_id": preclaimed_run_id, "status": "CLAIMED",
            }, sort_keys=True))
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
        def resume_checked(session, *args, **kwargs):
            if s2_resume_run_id is not None:
                key = f"s2_unpushed_fix_resume_{b['id']}"
                if kind != "fix_resume" or b["method"] != STAGE2_METHOD or self.store.get(key):
                    raise prompts.PromptError("Stage 2 리뷰 수정 재개가 이미 사용되었거나 대상이 다릅니다")
                # The launch gate covers this write and spawn. A crash or failed spawn consumes the attempt.
                self.store.set(key, str(s2_resume_run_id))
            return ad.resume(session, *args, **kwargs)

        try:
            run_env = self._launch_env(b, kind, agent_env)
            remote = "?"
            if isinstance(kind, str) and kind.startswith(("s2_chunk_", "s2_links_", "s2_repair_", "s3_chunk_")):
                remote = self.git.remote_head(b["branch"])   # the one remote read, before any view/page/decision write
            if b["method"] == STAGE3_METHOD and kind.startswith("s3_chunk_"):
                checkpoint = refine.ops(b).checkpoint(wt, b["shard"])
                if checkpoint is None:
                    checkpoint = refine.ops(b).prepare(self.runner, run_env, wt, b["shard"])
                chunk = stage3.next_chunk(checkpoint)
                if chunk is None:
                    return self._stage3_finalize(b)
                view, prompt_view = refine.ops(b).read_chunk_prompt(self.runner, run_env, wt, b["shard"])
                if view["chunk"] != chunk:
                    raise prompts.PromptError(f"{self._stage(b)} read-chunk가 checkpoint의 다음 청크와 다릅니다")
                # The model sees only the compact view; the baseline keeps the unchanged JSON view for equality checks.
                prompt = prompts.stage3_chunk(b, chunk, prompt_view, resumed=kind == "s3_chunk_resume")
                baseline = {"checkpoint": checkpoint, "chunk": chunk, "branch": b["branch"],
                            "worktree": str(wt), "head": self.git.head(Path(wt)), "remote_head": remote,
                            "view": view}
                self.store.set(stage3.run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                title = f"{self._stage(b)} {b['shard']} chunk {chunk}"
                if kind == "s3_chunk_resume":
                    h = resume_checked(sid, prompt, wt, run_env, run, log, ex, **extra)
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
                        if detail is None and kind == "s2_chunk_fix" and checkpoint.get("pending_chunk"):
                            try:
                                correction = self._stage2_correction_state(b, checkpoint["pending_chunk"])
                            except ValueError as error:
                                return self._fail(b, "ERROR", f"Stage 2 수정 재개 기준이 손상되어 중단합니다: {error}")
                            detail = correction.get("initial_failure") if correction is not None else None
                            if correction is not None and correction["version"] == 2:
                                detail = stage2.compact_fix_diagnostic(detail)
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
                        h = resume_checked(sid, prompt, wt, run_env, run, log, ex, **extra)
                    else:
                        if kind == "s2_chunk_resume":
                            if not checkpoint["pending_chunk"]:
                                raise prompts.PromptError("이어갈 pending 청크가 없습니다")
                            prompt = prompts.stage2_chunk_resume(checkpoint["pending_chunk"], checkpoint)
                        else:
                            prompt = prompts.stage2(b, "chunk", checkpoint, resumed=False, view=view)
                        view_bytes = (Path(wt) / stage2.CHUNK_VIEW).read_bytes()
                        checkpoint_path = Path(wt) / ".warroom-scratch" / \
                            f"relation-admission-{b['shard']}-{b['batch'].split('-')[0]}-{b['batch'].split('-')[1]}.json"
                        baseline = {"checkpoint": checkpoint, "branch": b["branch"], "worktree": str(wt),
                                    "head": self.git.head(wt), "remote_head": remote,
                                    "chunk_view_sha256": hashlib.sha256(view_bytes).hexdigest(),
                                    "checkpoint_sha256": hashlib.sha256(checkpoint_path.read_bytes()).hexdigest()}
                        self.store.set(stage2.run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                        if kind.endswith("_resume"):
                            h = resume_checked(sid, prompt, wt, run_env, run, log, ex, **extra)
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
                        h = resume_checked(sid, prompt, wt, run_env, run, log, ex, **extra)
                elif kind == "s2_repair_new":
                    state = self._stage2_repair_state(b, required=True)
                    current = state.get("current")
                    if not isinstance(current, dict) or current.get("pending_answer") is not None:
                        raise prompts.PromptError("Stage 2 repair needs one unapplied, persisted repair page")
                    reserved = current.get("attempt_log") or []
                    if reserved and isinstance(reserved[-1], dict) and reserved[-1].get("status") == "launched":
                        # bind this launch's log/exit files before any process exists, so an orphan can be recognised
                        reserved[-1]["spawn"] = {"log_file": str(log), "exit_file": str(ex)}
                        self._save_stage2_repair_state(b, state)
                    cursor = current.get("cursor")
                    groups = current.get("groups")
                    if type(cursor) is not int or not isinstance(groups, list) or cursor >= len(groups):
                        raise prompts.PromptError("Stage 2 repair page cursor is outside its saved conflict list")
                    page = self._stage2_repair_active_page(current)
                    page_keys = sorted({key for group in page for key in group.get("candidate_keys", [])})
                    correction = self._stage2_repair_correction(current)
                    bb, pp = stage2.split_key(b["batch"])
                    cp_path = Path(wt) / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.json"
                    baseline = {"branch": b["branch"], "worktree": str(wt), "head": self.git.head(Path(wt)),
                                "remote_head": remote, "checkpoint_sha256": hashlib.sha256(cp_path.read_bytes()).hexdigest(),
                                "fingerprint": current["fingerprint"], "cursor": cursor, "page_keys": page_keys,
                                "attempt": current["attempts"],
                                "correction_candidate_keys": correction["requested_keys"] if correction else None,
                                "correction_response_sha256": correction.get("response_sha256") if correction else None}
                    self.store.set(stage2.repair_run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
                    repair_input = self._stage2_repair_prompt_input(current, page, page_keys)
                    attempts = current.get("attempt_log") or []
                    prior_attempt = attempts[-2] if len(attempts) >= 2 and isinstance(attempts[-1], dict) \
                        and attempts[-1].get("status") == "launched" else (attempts[-1] if attempts else None)
                    format_error = (current.get("last_error") if isinstance(prior_attempt, dict)
                                    and prior_attempt.get("reason_code") == "format" else None)
                    prompt = prompts.stage2_repair(
                        b, json.dumps(repair_input, ensure_ascii=False, separators=(",", ":")),
                        f"{state['rounds_used']}/{stage2.MAX_REPAIR_ROUNDS}; groups {cursor + 1}..{cursor + len(page)} of {len(groups)}",
                        format_error=format_error,
                        type_tier_policy=current.get("type_tier_policy", "legacy-independent"),
                    )
                    repair_spawn_entered = True
                    h = ad.start(prompt, wt, run_env, run,
                                 f"Stage 2 {stage2.label(b['shard'], b['batch'])} local repair", log, ex, **extra)
                else:
                    raise prompts.PromptError("Stage 2 finalization은 Supervisor의 deterministic 단계입니다")
            elif kind == "produce":
                h = ad.start(prompts.produce(b), wt, run_env, run,
                                       f"{b['method'].upper()} {b['shard']}_{b['batch']}", log, ex, **extra)
            elif kind == "produce_resume":
                checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"]) if b["method"] == STAGE2_METHOD else None
                h = resume_checked(sid, prompts.recovery(b, checkpoint=checkpoint), wt, run_env, run, log, ex, **extra)
            elif kind == "produce_recover":
                checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"]) if b["method"] == STAGE2_METHOD else None
                h = ad.start(prompts.recovery(b, checkpoint=checkpoint), wt, run_env, run,
                                       f"{b['method'].upper()} {b['shard']}_{b['batch']} recover", log, ex, **extra)
            elif kind == "fix_resume":
                checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"]) if b["method"] == STAGE2_METHOD else None
                if b["method"] == STAGE2_METHOD and checkpoint is None:
                    raise prompts.PromptError("Stage 2 리뷰 수정 재개에 현재 Part checkpoint가 없습니다")
                h = resume_checked(sid, prompts.fix(b, events, True,
                                               checkpoint=checkpoint, retry_note=s2_fix_note), wt, run_env, run, log, ex, **extra)
            else:  # fix_new
                context = ""
                checkpoint = None
                if b["method"] == STAGE3_METHOD:
                    head = self.git.head(Path(wt))
                    base = self.git.merge_base(Path(wt), head, f"origin/{self.cfg['base_branch']}")
                    context = self._s3_fix_context(b, events or [], base, head)
                    self._refine_fix(b).begin(b, events or [], head=head, base=base)
                elif b["method"] == STAGE2_METHOD:
                    context = self._s2_fix_context(b, events)
                    checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
                    if checkpoint is None:
                        raise prompts.PromptError("Stage 2 리뷰 수정에 현재 Part checkpoint가 없습니다")
                    cp_path = Path(wt) / ".warroom-scratch" / f"relation-admission-{b['shard']}-{b['batch'].split('-')[0]}-{b['batch'].split('-')[1]}.json"
                    baseline = {"branch": b["branch"], "worktree": str(wt), "head": self.git.head(wt),
                                "checkpoint_sha256": hashlib.sha256(cp_path.read_bytes()).hexdigest(),
                                "amend_revision": self._stage2_fix_baseline_revision(
                                    b, wt, checkpoint.get("amend_revision", 0)),
                                # #6555: the AI only submits its judgment; the Supervisor applies it (_stage2_apply_fix).
                                "supervised": True, "event_keys": [e["key"] for e in events or []],
                                "event_head": b["head_sha"], "nonce": uuid.uuid4().hex}
                    self.store.set(f"s2_fix_start_{b['id']}", json.dumps(baseline, sort_keys=True))
                    self.store.delete(f"s2_unpushed_fix_resume_{b['id']}")
                    self.store.delete(f"s2_fix_apply_attempts_{b['id']}")
                    for rel in (S2_FIX_RESPONSE, S2_FIX_AMEND_INPUT):
                        (Path(wt) / rel).unlink(missing_ok=True)
                h = ad.start(prompts.fix(b, events, False, source_context=context, checkpoint=checkpoint), wt, run_env, run,
                                       f"PR {b['pr_number']} fix", log, ex, **extra)
        except prompts.PromptError as e:   # rendered before any process is started
            return self._fail(b, "ERROR", f"프롬프트 오류로 AI를 시작하지 않았습니다: {e}")
        except TRANSIENT:
            raise
        except Exception as e:
            if b["method"] == STAGE2_METHOD and kind == "s2_repair_new":
                if isinstance(e, SpawnNotStarted) or not repair_spawn_entered:
                    self._stage2_repair_mark_start_failed(b)   # provably no child (refused spawn, or never reached it)
                else:
                    return self._fail(b, "ERROR", f"AI 실행 시작 오류(자식 생성 여부 불명, 증거 보존): {e}")
            return self._fail(b, "ERROR", f"{self.START_FAILURE_PREFIX}: {e}")
        self.store.set(f"headlag_{b['id']}", "")   # a new run supersedes any earlier push verification
        if b["method"] == STAGE2_METHOD:
            self.store.delete(f"s2_safe_ff_{b['id']}")
        self._clear_batch_retry(b["id"])
        state = "FIXING" if kind.startswith("fix") else "PRODUCING"
        fields = dict(state=state, pid=h.pid, exit_file=str(ex), log_file=str(log),
                      run_kind=kind, retry_after=None, error=None)
        if kind == "fix_new" or kind in ("produce", "produce_recover", "s2_chunk_new", "s2_links_new", "s2_repair_new", "s2_finalize_new", "s3_chunk_new"):
            fields["session_id"] = None  # captured from the new run's log
        self.store.update(b["id"], **fields)
        if preclaimed_run_id is not None:
            run_id = preclaimed_run_id
            self.store.set_run_pid(run_id, h.pid)
        else:
            run_id = self.store.add_run(b["id"], kind, fields.get("session_id", sid), h.pid, log, ex,
                                        model=run.model, effort=run.effort, permission_profile=run.permission_profile,
                                        fast_mode=run.fast)
        if b["method"] == STAGE2_METHOD and kind == "s2_repair_new":
            repair_state = self._stage2_repair_state(b, required=True)
            current = repair_state.get("current")
            attempts = current.get("attempt_log") if isinstance(current, dict) else None
            if isinstance(attempts, list) and attempts and isinstance(attempts[-1], dict) \
                    and attempts[-1].get("status") == "launched":
                attempts[-1]["run_id"] = run_id
                self._save_stage2_repair_state(b, repair_state)
        if events:
            keys = [e["key"] for e in events]
            if preclaimed_run_id is not None:
                pass  # Maintainer assignment was durably recorded before starting the process.
            elif b["method"] == STAGE3_METHOD and kind.startswith("fix"):
                self.store.claim_events(b["id"], b["pr_number"], b["head_sha"], keys, run_id)
                self.store.set(f"fix_claim_{b['id']}", json.dumps({
                    "pr": b["pr_number"], "head_sha": b["head_sha"], "event_keys": keys,
                    "run_id": run_id, "status": "CLAIMED",
                }, sort_keys=True))
            else:  # Stage 2 retains its existing event lifecycle; its behavior is outside #2322.
                self.store.mark_handled(b["id"], b["pr_number"], b["head_sha"], keys)
        permission = (f", permission_profile={run.permission_profile or '(기본)'}"
                      if registry(self.cfg)[b["producer"]]["adapter"] == "codex" else "")
        self.store.log(b["id"], f"{state} 시작 ({kind}, model={run.model}, effort={run.effort}{permission})")

    def _retry_denied_success(self, b) -> bool:
        """Retry after a denial pause: if the last exited run was a successful one (own session/result evidence) whose only
        problem was its permission denials, re-run the same completion evidence check instead of relaunching the AI."""
        if b["state"] == "FIXING" and b["method"] != MAINTENANCE_METHOD:
            return False   # a fix denial is never cleared for other producers (see _denied_run_problem): Retry re-runs it
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
        if b["state"] == "FIXING":
            # Maintainer fix: consume the Retry only when the preserved result alone can be handed off (or the regular fix
            # gate records its continuation); anything that needs the work resumed takes the regular relaunch path.
            why = self._maintainer_fix_retry_problem(b)
            if why is not None:
                self.store.log(b["id"], f"권한 관련 실패 후 Retry: 수정 완료 근거 없음({why}) — 기존 재개 경로로 진행", "warn")
                return False
            self.store.log(b["id"], "권한 관련 실패 후 Retry: 보존된 수정 결과(소유 PR·push된 HEAD)를 기존 리뷰 수정 완료 검증으로 판정합니다", "warn")
            self.store.set(f"verified_completion_run_{b['id']}", str(runs[0]["id"]))
            self._run_ok(b)
            return True
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

    def _maintainer_fix_retry_problem(self, b) -> str | None:
        """Why a Maintainer fix run's preserved result cannot go straight to the fix gate, or None. Reads only: the fix
        gate (`_run_ok`) alone completes review events, so nothing is consumed here."""
        try:
            info = self.gh.pull(b["pr_number"])
            if info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]:
                return "PR 번호 또는 소유 브랜치가 다릅니다"
            if info.get("state") != "open" or info.get("merged"):
                return "소유 PR이 열린 상태가 아닙니다"
            wt = Path(b["worktree"])
            if self.git.dirty(wt).strip():
                return "worktree에 미커밋 변경이 있습니다"
            if self.git.head(wt) != info["head_sha"]:
                return "worktree HEAD가 PR HEAD와 다릅니다"
        except TRANSIENT:
            raise
        except Exception as e:
            return f"확인 실패: {e}"
        return None

    def _relaunch(self, b) -> None:
        self._guarded(b, "prelaunch", self._relaunch_do, entrypoint="relaunch")

    def _relaunch_do(self, b) -> None:
        if self._retry_denied_success(b):
            return
        if b["method"] == STAGE3_METHOD and not b["pr_number"] and s3parallel.is_parallel(self.store, b) \
                and b["run_kind"] in ("s3_chunk_new", s3parallel.RUN_KIND):
            return self._launch_stage3_next(b)   # a parallel shard never takes the serial chunk relaunch (#3149)
        if b["method"] == STAGE3_METHOD and not b["pr_number"]:
            if b["run_kind"] == "s3_finalize":
                self.maint.adopt_released_baseline(b)
                return self._stage3_finalize(b)
            if isinstance(b["run_kind"], str) and b["run_kind"].startswith("s3_chunk_"):
                self.maint.adopt_released_baseline(b)
                return self._relaunch_stage3_chunk(b)
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
                    attempts = current.get("attempt_log")
                    attempt = attempts[-1] if isinstance(attempts, list) and attempts else None
                    if not isinstance(attempt, dict) or attempt.get("status") != "answer_saved":
                        return self._fail(b, "ERROR", "Stage 2 pending repair answer has no saved response attempt; preserving evidence")
                    return self._apply_stage2_repair_answer(b, state)
                if problem := self._stage2_repair_boundary_problem(b):
                    return self._fail(b, "ERROR", problem)
                if self._stage2_repair_refresh_stale_unresolved_round(b, state):
                    return
                if problem := self._stage2_repair_replay_missing_response(b, state):
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
            try:
                correction = self._stage2_correction_state(b, pending) if pending is not None else None
            except ValueError as error:
                return self._fail(b, "ERROR", f"Stage 2 후보 Retry 한도를 검증하지 못해 AI 재실행을 막았습니다: {error}")
            if correction is not None:
                return self._fail(b, "ERROR", "이 pending 후보의 자동 수정 1회는 이미 사용됐습니다. 새 AI run으로 한도를 재설정하지 않고 worktree와 기록을 보존합니다.")
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
            if b["method"] == STAGE2_METHOD and self._verified_fix_exit(b) and \
                    (baseline := self._stage2_supervised_fix(b)) is not None and self._stage2_apply_fix(b, baseline):
                return   # resumed the Supervisor's own idempotent application
            if b["method"] == STAGE3_METHOD and self._verified_fix_exit(b) and \
                    (baseline := self._refine_fix(b).baseline(b)) is not None and self._refine_fix(b).apply(b, baseline):
                return
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
                    elif b["method"] == MAINTENANCE_METHOD:
                        if (info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]
                                or info.get("state") != "open" or info.get("merged")):
                            return self._fail(b, "ERROR", "Maintainer PR 소유권 확인 실패. 보존합니다.")
                        if problem := self._complete_producer_fix_events(b, info):
                            return self._maintainer_fix_problem(b, problem)
                    self._to_review(b, info)
                return
            if b["method"] == MAINTENANCE_METHOD:
                # Never relaunch blindly, never park it (#5245): the continuation queue releases only this attempt's
                # unproven CLAIMED events and returns the PR watch to the current HEAD's unanswered events.
                return self.maint.continue_later(b, "fix_incomplete", "Maintainer 수정 실행의 완료 증거가 없습니다. "
                                                 + self._maintainer_run_facts(b), "fix")
            if b["method"] == STAGE2_METHOD and b["run_kind"] == "fix_resume" and self.store.get(f"s2_unpushed_fix_resume_{b['id']}"):
                return self._fail(b, "ERROR", "Stage 2 리뷰 수정 재개 결과가 확인되지 않아 새 세션을 시작하지 않습니다. worktree와 PR을 보존합니다.")
            if b["method"] == STAGE3_METHOD:
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
            if self._reapply_exit_verdict(b):
                return   # the last run ended but its outcome was never committed (crash / denied launch): re-derive it
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
        tolerant = {"tolerate_denied": True} if self._s2_chunk_run(b) \
            and getattr(ad, "supports_tolerate_denied", False) else {}
        problem = ad.run_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"], **tolerant)
        if problem:   # the CLI contradicts its pins: stop it, keep worktree/PR, wait for the operator
            state, msg = problem
            if ad.alive(b["pid"]):
                ad.stop(b["pid"])
            return self._fail(b, state, msg)
        if ad.alive(b["pid"]):
            return   # Claude/Codex: a PR is taken over only after the run exited and its final result was verified
        code = ad.exit_code(Path(b["exit_file"]))
        # One transaction: pid=None, the run's exit status and the "outcome not yet committed" marker (#3790), for every
        # exit (0, non-zero, missing). Until a state/backoff/new-run write clears it, a new Supervisor re-derives this exact
        # verdict, unless the run's own official save already happened (see `_reapply_exit_verdict`).
        self.store.finish_runs(b["id"], code, clear_pid=True, verdict=True)
        b = self.store.batch(b["id"])
        self._apply_exit_verdict(b, code)

    def _exit_output_saved(self, b) -> bool:
        """The exact output of the run that just ended is already officially saved (bound to its start baseline)."""
        try:
            return bool(self._saved_chunk_for_run(b))
        except Exception:   # unknown is not saved: the verdict is re-derived, never skipped
            return False

    def _saved_exit_acceptable(self, b, code) -> bool:
        """The checks the normal path applies before it accepts stored output: blocking failure class, identity, completion."""
        try:
            ad = self._adapter(b["producer"])
            if code not in (None, 0) and self._classify_run(b["producer"], b["log_file"]) in (
                    "effort", "auth", "usage_limit", "fast_unavailable"):
                return False
            if self._saved_chunk_identity_problem(b):
                return False
            if code in (None, 0):
                problem = ad.completion_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"],
                                                b["worktree"], self.env)
                if problem and not ad.completion_incomplete(Path(b["log_file"]), self._recorded_run(b),
                                                            b["session_id"], b["worktree"], self.env):
                    return False
            return True
        except Exception:
            return False

    def _reapply_exit_verdict(self, b) -> bool:
        """Re-derive the verdict of the last run from its exact evidence when no outcome was committed. True: handled."""
        raw = self.store.get(exit_verdict_key(b["id"]))
        if raw is None:
            return False
        last = self._last_run(b)
        try:
            rec = json.loads(raw)
            run_id, code = int(rec["run_id"]), rec["code"]
            want = "unknown" if code is None else str(code)
            if last is None or last["id"] != run_id or last["ended_at"] is None or str(last["exit_status"]) != want:
                raise ValueError(f"기대 run #{run_id} exit {want} / 실제 {last['id'] if last else None}")
        except (TypeError, ValueError, KeyError) as e:
            self._fail(b, "ERROR", f"종료 판정 재진입 증거가 일치하지 않아 AI 재실행 없이 보존합니다: {e}")
            return True
        if self._exit_output_saved(b) and self._saved_exit_acceptable(b, code):
            if not self._denials_cleared(b, Path(b["log_file"])):
                return True   # the same permission-denial verdict as the normal path (PAUSED) is already committed
            # The run's own official save already completed and the original classification / identity checks pass: the
            # saved file is the authoritative effect, so the run-baseline-bound recovery (`_relaunch_*`) accepts it
            # instead of re-judging a tree the save itself changed. Anything else re-applies the full verdict below.
            self.store.delete(exit_verdict_key(b["id"]))
            return False
        self.store.log(b["id"], f"run #{run_id}의 종료 판정이 확정되기 전에 중단되어 같은 증거로 판정을 다시 적용합니다 (AI 재실행 없음).", "warn")
        self._apply_exit_verdict(b, code)
        return True

    def _apply_exit_verdict(self, b, code) -> None:
        """Classify the run that just ended. Nothing here may depend on the LaunchGate: only a truly new AI run asks for a
        permit, at its own first launch-specific write.

        An outcome write (state / backoff / a new run) clears the marker in its own transaction (Store). A handler that
        completes with no such write (a wait it records itself, e.g. a pending query or a fix-head lag) clears it here. A
        `LaunchDenied` or a crash leaves the marker, so the next Supervisor re-derives this exact verdict."""
        self._apply_exit_verdict_do(b, code)
        self.store.delete(exit_verdict_key(b["id"]))

    def _apply_exit_verdict_do(self, b, code) -> None:
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
                    self.store.log(b["id"], f"AI 종료 상태 기록은 없지만 현재 {self._stage(b)} 청크의 완전한 D/L 응답과 실행 핀을 확인했습니다. 같은 strict save 경로로 저장합니다.", "warn")
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
        answer_only = self._stage3_answer_only(b)
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
            if (((self._s2_chunk_run(b) or self._s2_links_run(b) or self._s2_repair_run(b))
                 and b["state"] == "PRODUCING")
                    or (self._stage3_chunk_run(b) and b["state"] == "PRODUCING"
                        and (self._stage3_chunk_saved(b) or self._stage3_answer_only(b)))):
                self.store.log(b["id"], "answer-only 청크 권한 결과가 없어도 출력·저장 및 부작용 경계로 판정합니다.", "warn")
                return True
            self._fail(b, "PAUSED", "CLI 최종 result가 없어 권한 거부 여부를 확인할 수 없습니다. 저장물과 실행 기록을 보존하고 중지합니다.")
            return False
        if not denied:
            return True
        if (((self._s2_chunk_run(b) or self._s2_links_run(b) or self._s2_repair_run(b))
             and b["state"] == "PRODUCING")
                or (self._stage3_chunk_run(b) and b["state"] == "PRODUCING"
                    and (self._stage3_chunk_saved(b) or self._stage3_answer_only(b)))):
            # Answer-only: a refused tool call is a metric, not a failure. The answer is judged by its block and its save,
            # and any real side effect (dirty tracked tree, moved HEAD/remote) by its boundary check.
            if self._stage3_chunk_run(b):
                problem = self._stage3_chunk_boundary_problem(b)
                if problem:
                    self._fail(b, "ERROR", problem)
                    return False
                self.store.log(b["id"], f"{self._stage(b)} answer-only 청크에서 도구 호출 {len(denied)}건이 거부됐습니다 "
                               "(정확한 view/checkpoint 경계와 출력 검증으로 판정합니다)", "warn")
                return True
            self.store.log(b["id"], f"answer-only 청크에서 도구 호출 {len(denied)}건이 거부됐습니다 (부작용 없으면 실패 아님)", "warn")
            return True
        names = sorted({str(d.get("tool_name")) for d in denied})
        cmds = [" ".join(str((d.get("tool_input") or {}).get("command", "")).split())[:80] for d in denied
                if isinstance(d.get("tool_input"), dict) and (d.get("tool_input") or {}).get("command")]
        what = f"도구: {', '.join(names)}" + (f"; 명령: {' | '.join(cmds[:3])}" if cmds else "")
        # Codex evidence is a failed command's output: it cannot tell a policy refusal, an approval wait and an OS error apart.
        kind = ("권한 관련 명령 실패(정책 거절·승인 대기·일반 OS 오류 구분 불가 — 미확인)" if any("evidence" in d for d in denied)
                else "로컬 CLI 권한 정책상 거부")
        pause = (f"{kind}로 실행이 불완전합니다 ({what}). 자동 권한 상승 없이 중지합니다. "
                 "로컬 CLI 설정을 직접 확인한 뒤 Retry 하세요 (worktree·PR·세션 보존).")
        if b["method"] == MAINTENANCE_METHOD and b["state"] in ("PRODUCING", "FIXING"):
            # A failed command is evidence, not the verdict: the Maintainer's own fix / no-PR diagnosis gates decide (#5471).
            why = None if b["state"] == "FIXING" else self._denied_run_problem(b)
            if why is None or isinstance(why, NoOwnedPR):
                route = ("리뷰 수정 완료 검증" if b["state"] == "FIXING"
                         else "소유 PR·push된 HEAD 확인" if why is None else "PR 없는 Maintainer 진단 결과 검증")
                self._note_denials(b, f"권한 관련 명령 실패 {len(denied)}건({what}) — 실패 증거를 보존하고 기존 {route}으로 판정합니다")
                return True
            self._fail(b, "PAUSED", f"{pause} 완료 증거 없음: {why}")
            return False
        why = self._denied_run_problem(b)
        if why is None:
            self.store.log(b["id"], f"권한 거부 {len(denied)}건({what}) 있었으나 소유 PR·push된 HEAD·Part verify로 "
                           "필수 작업 완료를 확인했습니다 — 리뷰 감시로 인계", "warn")
            return True
        self._fail(b, "PAUSED", f"{pause} 완료 증거 없음: {why}")
        return False

    def _note_denials(self, b, msg: str) -> None:
        """Record a run's permission-failure evidence once per run (verdict re-entry and Retry never repeat it)."""
        run = self._last_run(b)
        key = f"denial_noted_{b['id']}_{run['id'] if run else 0}"
        if self.store.get(key) is None:
            self.store.log(b["id"], msg, "warn")
            self.store.set(key, "1")

    def _denied_run_problem(self, b) -> str | None:
        """Why a run with permission denials cannot be accepted as complete, or None when the evidence is conclusive."""
        try:
            info = self._find_recovery_pr(b)
            if info is None:
                return NoOwnedPR("소유 브랜치에 PR이 없습니다")
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
                # Batches without a Part verify: the same proof as a clean run is the owned open PR carrying the
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

    def _task_report_files(self, b) -> list[str]:
        """Worktree-relative shared-defect report path of every task of a parallel Stage 2 Part."""
        if b["method"] == STAGE3_METHOD:
            return []   # answer-only chunks: no per-task shared-defect file (#3149)
        return [stage2.task_path(row["task"], "shared-defect.json") for row in self.store.task_rows(b["id"])]

    def _task_report_row(self, b, rel: str):
        for row in self.store.task_rows(b["id"]):
            if b["method"] == STAGE2_METHOD:
                path = stage2.task_path(row["task"], "shared-defect.json")
            else:
                continue
            if path == rel:
                return row
        return None

    def _capture_task_report_session(self, b, rel: str) -> bool:
        """Persist the report owner's exact session before stopping its worker for the shared-defect pause."""
        row = self._task_report_row(b, rel)
        if row is None:
            return False
        run = self.store.run(row["run_id"]) if row["run_id"] is not None else next(
            (item for item in self.store.runs(b["id"]) if item["task"] == row["task"]), None)
        if (run is None or run["batch_id"] != b["id"] or run["task"] != row["task"]
                or (row["session_id"] and run["session_id"] not in (None, row["session_id"]))):
            return False
        session = row["session_id"] or run["session_id"] or self._adapter(b["producer"]).session_id(Path(run["log_file"]))
        if not isinstance(session, str) or not session:
            return False
        if run["session_id"] != session:
            self.store.set_run_session_by_id(run["id"], session)
        if row["session_id"] != session:
            self.store.update_task(b["id"], row["task"], session_id=session)
        return True

    def _scan_task_reports(self, b, s2p) -> bool:
        """Shared-defect reports of parallel tasks (Stage 2 `s2-tasks/<id>/shared-defect.json`, D
        `shared-defect-NNN.json`): same stability and once-per-content rules as `_scan_report`, but ALL task workers are
        stopped and the defect remembers the exact report file (the Maintainer archives that file, not a batch-wide one)."""
        for rel in self._task_report_files(b):
            f = Path(b["worktree"]) / rel
            try:
                st = f.stat()
                raw = f.read_text("utf-8", errors="replace")
            except OSError:
                continue
            if not raw.strip():
                continue
            key = defects.report_event_key(b["id"], raw)
            prior = self.store.defect_by_event(key)
            while prior is not None and prior["state"] == "RELEASED":
                key = f"{key}:after:{prior['id']}"
                prior = self.store.defect_by_event(key)
            if prior is not None:
                continue
            live = s2p.workers_alive(b)
            sig, sig_key = f"{st.st_mtime_ns}:{st.st_size}", f"defect_file_{b['id']}_{rel}"
            if live and self.store.get(sig_key) != sig:
                self.store.set(sig_key, sig)
                continue
            # Capture the session while its worker is still alive when possible. A missing session must not
            # prevent stopping workers and recording the incident; the resume gate separately requires proof.
            self._capture_task_report_session(b, rel)
            if self.store.open_task_runs(b["id"]):
                if not s2p.stop_workers(b) or self.store.open_task_runs(b["id"]):
                    return True   # wait for every exact worker run to close before pausing and snapshotting its owner
            self.store.set(f"s2_defect_path_{b['id']}", rel)
            self.maint.report(b, "report", key, raw)
            return True
        return False

    def _record_progress(self, b) -> None:
        """Observed progress of the current worktree only: Stage 3 checkpoint chunks or Stage 2 saved candidates."""
        if b["method"] == STAGE3_METHOD:
            try:
                done, total = stage3.progress(refine.ops(b).checkpoint(b["worktree"], b["shard"]))
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
        # Maintainer batches have no saved-progress artifact (#9933 removed the Stage 1 Candidate counters).

    def _run_ok(self, b) -> None:
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
        if b["state"] == "FIXING" and b["method"] == STAGE2_METHOD and \
                (baseline := self._stage2_supervised_fix(b)) is not None and self._stage2_apply_fix(b, baseline):
            return
        if b["state"] == "FIXING" and b["method"] == STAGE3_METHOD and \
                (baseline := self._refine_fix(b).baseline(b)) is not None and self._refine_fix(b).apply(b, baseline):
            return
        try:
            if b["state"] == "PRODUCING":
                info = self._find_pr(b)
                if info is None:
                    if b["method"] == MAINTENANCE_METHOD:
                        return self._maintainer_without_pr(b)
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
            if b["method"] == MAINTENANCE_METHOD:
                if info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]:
                    return self._fail(b, "ERROR", "리뷰 수정 완료 PR의 번호 또는 소유 브랜치가 다릅니다. worktree·PR을 보존합니다.")
                if info.get("state") != "open" or info.get("merged"):
                    return self._fail(b, "ERROR", "리뷰 수정 완료 시 소유 PR이 열린 상태가 아닙니다. worktree·PR을 보존합니다.")
                if problem := self._complete_producer_fix_events(b, info if b["method"] == MAINTENANCE_METHOD else None):
                    if b["method"] == MAINTENANCE_METHOD:
                        return self._maintainer_fix_problem(b, problem)
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

    def _maintainer_fix_problem(self, b, problem: str) -> None:
        """A missing reply or completion record of a Maintainer fix continues the attempt; other problems stop it."""
        if isinstance(problem, FixIncomplete):
            return self.maint.continue_later(self.store.batch(b["id"]), "fix_incomplete",
                                             f"{problem} {self._maintainer_run_facts(b)}", "fix")
        return self._fail(b, "ERROR", problem)

    def _maintainer_without_pr(self, b) -> None:
        """A Maintainer run ended without an adoptable PR: hand it off, continue it, or stop at a boundary (#5245).

        A run ending (exit 0, a "cannot" answer, a comment) is never completion and never a parked ERROR by itself.
        Only a verified handoff completes the attempt; an integrity/ownership boundary stops it with its reason; every
        other case continues the same attempt with the exact reason through the continuation queue.
        """
        result = self.maint.finish_diagnosis(b)
        if result.kind in (maint_results.HANDED_OFF, maint_results.DEFERRED):
            return   # proof-backed handoff (#3409) or a later re-judgement: not production completion
        if result.kind == maint_results.BLOCKED:
            current = self.store.batch(b["id"])
            if current is not None and current["state"] == "PRODUCING":
                self._fail(current, "ERROR", f"Maintainer 결과를 받을 수 없는 무결성·소유권 경계 [{result.reason}]: "
                           f"{result.fact}. worktree·증거를 보존합니다. 경계를 확인한 뒤 운영자 Retry로 같은 attempt를 재개합니다.")
            return
        if result.kind == maint_results.NOT_DIAGNOSIS or result.reason == "no_pr_no_result":
            refusal = self._adapter(b["producer"]).policy_refusal(Path(b["log_file"]))
            if refusal:   # the local CLI policy stopped the PR step: an independently confirmed external condition
                return self._fail(b, "PAUSED", f"{refusal}. PR이 만들어지지 않았습니다. 로컬 설정을 확인한 뒤 "
                                  "Retry 하세요 (worktree·브랜치·세션 보존).")
            result = maint_results.DiagnosisResult(maint_results.CONTINUE, "no_pr_no_result",
                                                   "PR도 구조화 진단 결과도 없이 실행이 끝났습니다. " + self._maintainer_run_facts(b))
        self.maint.continue_later(b, result.reason, result.fact, "produce")

    def _maintainer_run_facts(self, b) -> str:
        """Observed facts of the ended run, for the next run's handoff; an unobservable fact is stated as unknown."""
        facts = []
        runs = self.store.runs(b["id"])
        facts.append(f"exit={runs[0]['exit_status'] if runs else 'unknown'}")
        try:
            cls = self._classify_run(b["producer"], b["log_file"])
            if cls:
                facts.append(f"run_class={cls}")
        except Exception:
            facts.append("run_class=unknown")
        wt = Path(b["worktree"])
        try:
            base = self.store.get(f"m_base_head_{b['id']}")
            head = self.git.head(wt)
            facts.append(f"head={'시작 HEAD 그대로' if head == base else (head or 'unknown')[:12]}")
            facts.append(f"remote_branch={'있음' if self.git.remote_head(b['branch']) else '없음'}")
            dirty = self.git.dirty(wt).strip()
            facts.append(f"uncommitted={len(dirty.splitlines()) if dirty else 0}")
        except Exception:
            facts.append("git=unknown")
        cause = self.maint.resolved_note(b, short=True)
        if cause:
            facts.append(cause)
        return ", ".join(facts)

    def _stage3_fix_result_problem(self, b, info, verified: str | None = None) -> str | None:
        """Accept a Stage 3 review fix only when its owned PR still has the shard scope and verify passes on its HEAD.

        `verified` is the HEAD this same call already verified exactly before pushing it (#6555); it is not re-run."""
        if (info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]
                or info.get("state") != "open" or info.get("merged")):
            return f"{self._stage(b)} 리뷰 수정이 열린 소유 PR 번호/head 브랜치에서 끝나지 않았습니다. worktree와 PR을 보존합니다."
        head = info.get("head_sha")
        if not isinstance(head, str) or not re.fullmatch(r"[a-f0-9]{40}", head):
            return f"{self._stage(b)} 리뷰 수정 PR HEAD가 유효한 commit SHA가 아닙니다. PR을 보존합니다."
        try:
            files = self.gh.pull_files(b["pr_number"])
            shard = refine.ops(b).validate_pr(info, files)
        except TRANSIENT:
            raise
        except Exception as error:
            return f"{self._stage(b)} 리뷰 수정 PR 파일 범위를 검증할 수 없습니다: {error}. PR을 보존합니다."
        if shard != b["shard"]:
            return f"{self._stage(b)} 리뷰 수정 PR 샤드 {shard}가 소유 샤드 {b['shard']}와 다릅니다. PR을 보존합니다."
        if verified == head:
            return None
        try:
            ok, detail = self._refine_verify(b, head)
        except TRANSIENT:
            raise
        except Exception as error:
            return f"{self._stage(b)} 리뷰 수정 HEAD 검증을 실행할 수 없습니다: {error}. PR을 보존합니다."
        if not ok:
            return f"{self._stage(b)} 리뷰 수정 HEAD의 shard verify 실패: {detail}. PR을 보존합니다."
        return None

    def _stage3_fix_completion_problem(self, b, info, verified: str | None = None) -> str | None:
        """Share the same PR scope, exact-HEAD verify and event-reply gate across every fix completion route."""
        if problem := self._stage3_fix_result_problem(b, info, verified):
            return problem
        return self._complete_producer_fix_events(b)

    def _refine_fix(self, b):
        """The Review FIXING Coordinator of this refinement batch's Stage."""
        return self._refine_fix_for(refine.spec_for(b))

    def _refine_fix_for(self, spec):
        """A Stage's coordinator: it applies that Stage's own CLI `amend` and shares Stage 3's completion gate."""
        if spec.id not in self.refine_fix:
            self.refine_fix[spec.id] = fixcoord.ReviewFixCoordinator(self, spec.fix, fixcoord.FixStage(
                allowed=lambda b, paths=(): spec.scope(b["shard"], paths),
                amend=lambda b, baseline, wt, rel: self.git.refine_amend(wt, spec.cli, b["shard"], baseline["base"], rel),
                rejected=RefineAmendRejected,
                verify_exact=self._refine_verify,
                completion=self._stage3_fix_completion_problem))
        return self.refine_fix[spec.id]

    def _s3_fix_context(self, b, events, base: str, head: str) -> str:
        """Bounded Stage 3 review context (#6555): the PR's decisions by base row, for the Senses the review names, or
        every edit of the PR when it names none. The AI reads nothing else to judge, so a failed lookup is a PromptError
        and no session starts."""
        wt = Path(b["worktree"])
        named = sorted(set(re.findall(r"\bw\d+-s\d+\b", "\n".join(str(e.get("body") or "") for e in events))))
        try:
            listed = self.git.refine_decisions(wt, refine.spec_for(b).cli, b["shard"], base, named or None)
        except TRANSIENT:
            raise
        except GitError as e:
            # Fail closed: without the PR's decisions the judgment would have no evidence, so no session starts and
            # the review events stay unanswered (#6599 review).
            raise prompts.PromptError(f"{self._stage(b)} 리뷰 수정 PR context(edit-cli decisions)를 만들지 못했습니다: {e}. "
                                      "PR과 리뷰 이벤트를 보존합니다") from e
        rows = listed.get("rows") or []
        scope = f"every base row of the named Senses {', '.join(named)}"
        if not rows:
            rows = listed["decisions"]
            scope = ("every edit of this PR" + (f" (the named Senses {', '.join(named)} have no base row in this shard)"
                                                  if named else ""))
        counts = {action: sum(1 for d in listed["decisions"] if d.get("action") == action) for action in ("drop", "repair")}
        summary = (f"this PR adds {listed['counts'].get('add')}, drops {listed['counts'].get('drop')} and sets "
                   f"{listed['counts'].get('set')} relations by key" if isinstance(listed.get("counts"), dict) else
                   f"this PR drops {counts['drop']} and repairs {counts['repair']} base rows")
        lines = [f"base {base}; PR HEAD {head}; {summary}.",
                 f"Rows below: {scope}{f' (first {S3_FIX_CONTEXT_ROWS} of {len(rows)})' if len(rows) > S3_FIX_CONTEXT_ROWS else ''}."]
        lines += [json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows[:S3_FIX_CONTEXT_ROWS]]
        return "\n".join(lines)

    @staticmethod
    def _merged_owned_pr(b, info) -> bool:
        """Merge is a fact about the PR: a merged PR on this batch's owned branch.

        The merge normally deletes its remote branch, so only the remote-HEAD comparison is waived for it; ownership,
        reconcile scope, base commit, worktree HEAD and Part/exact-HEAD verify still apply."""
        return (info.get("merged") is True and info.get("state") == "closed"
                and info.get("head_ref") == b["branch"] and isinstance(info.get("number"), int))

    def _stage2_final_pr_problem(self, b, info, verified=None, telemetry=None) -> str | None:
        """Require both verifications, or reuse this finalization call’s matching successful results."""
        merged = self._merged_owned_pr(b, info)
        try:
            reconcile_task = self._stage2_reconcile_task(b)
            if reconcile_task:
                base_revision, _change_point = reconcile_task
                if info.get("head_ref") != b["branch"]:
                    return "Stage 2 reconciliation PR head branch does not match its owned branch"
                wt = Path(b["worktree"])
                if self.git.dirty(wt).strip():
                    return "Stage 2 reconciliation PR worktree has uncommitted changes"
                head = self.git.head(wt)
                if not head or head != info.get("head_sha"):
                    return f"Stage 2 reconciliation PR HEAD differs from its owned worktree ({info.get('head_sha')} / {head})"
                if not merged and self.git.remote_head(b["branch"]) != head:
                    return "Stage 2 reconciliation PR HEAD is not on its remote owned branch"
                allowed = {f"data/relation-drops/drop-{b['shard']}.jsonl"}
                files = {row.get("path") for row in self.gh.pull_files(info["number"])}
                if files != allowed or set(self.git.changed_files(head)) != allowed:
                    return f"Stage 2 reconciliation PR must change only its shard Drop file (found {sorted(files)})"
                if not self.git.is_ancestor(base_revision, head, path=wt):
                    return "Stage 2 reconciliation PR does not contain its recorded base revision"
                bb, pp = stage2.split_key(b["batch"])
                if telemetry is not None:
                    telemetry["checkpoint_verify"] = 1
                ok, tail = self.git.verify_stage2_local(wt, b["shard"], bb, pp, checkpoint=False)
                if not ok:
                    return f"{stage2.label(b['shard'], b['batch'])} reconciliation verify failed: {tail}"
                if telemetry is not None:
                    telemetry["exact_head_verify"] = 1
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
            if not merged:   # a merged PR's remote branch is normally deleted
                remote = self.git.remote_head(b["branch"])
                if remote != head:
                    return f"Stage 2 PR HEAD가 원격 소유 브랜치에 없습니다 ({remote} / {head})"
            batch, part = stage2.split_key(b["batch"])
            path = (wt / ".warroom-scratch" / f"relation-admission-{b['shard']}-{batch}-{part}.json").resolve()
            try:
                stat = path.stat()
                fingerprint = (stat.st_ino, stat.st_size, stat.st_mtime_ns)
            except OSError:
                fingerprint = None
            # stat detects accidental checkpoint changes within this call; CLI verification supplies integrity.
            if (isinstance(verified, dict) and type(verified.get("batch_id")) is type(b["id"])
                    and verified.get("batch_id") == b["id"]
                    and verified.get("checkpoint_path") == str(path) and verified.get("head") == head
                    and fingerprint is not None and verified.get("checkpoint_stat") == fingerprint):
                if telemetry is not None:
                    telemetry["mode"] = "reused"
                return None
            if telemetry is not None:
                telemetry["checkpoint_verify"] = 1
            ok, tail = self.git.verify_stage2_local(wt, b["shard"], batch, part, checkpoint=True)
            if not ok:
                return f"{stage2.label(b['shard'], b['batch'])} 로컬 checkpoint verify 실패: {tail}"
            if telemetry is not None:
                telemetry["exact_head_verify"] = 1
            ok, tail = self.git.verify_stage2_exact(head, b["shard"], batch, part)
            if not ok:
                return f"{stage2.label(b['shard'], b['batch'])} PR 정확한 HEAD의 별도 checkout verify 실패: {tail}"
        except TRANSIENT:
            raise
        except Exception as e:
            return f"Stage 2 PR 검증 실패: {e}"
        return None

    def _stage2_supervised_fix(self, b) -> dict | None:
        """The current Stage 2 review fix's baseline when its AI run only submits a judgment (#6555)."""
        try:
            baseline = json.loads(self.store.get(f"s2_fix_start_{b['id']}") or "")
        except (TypeError, ValueError):
            return None
        if not isinstance(baseline, dict) or baseline.get("supervised") is not True \
                or baseline.get("branch") != b["branch"] or baseline.get("worktree") != str(b["worktree"]) \
                or not isinstance(baseline.get("event_keys"), list) or not isinstance(baseline.get("nonce"), str) \
                or not isinstance(baseline.get("event_head"), str):
            return None
        return baseline

    def _stage2_fix_response(self, b, baseline) -> tuple[dict | None, str | None]:
        """The AI's submitted judgment, or why it cannot be applied as written."""
        path = Path(b["worktree"]) / S2_FIX_RESPONSE
        try:
            data = json.loads(path.read_text("utf-8"))
        except FileNotFoundError:
            return None, f"{S2_FIX_RESPONSE} was not written"
        except (OSError, ValueError) as e:
            return None, f"{S2_FIX_RESPONSE} is not valid JSON: {e}"
        if not isinstance(data, dict) or set(data) != {"event_keys", "amend", "reply"}:
            return None, f"{S2_FIX_RESPONSE} must be one object with exactly event_keys, amend and reply"
        keys = data["event_keys"]
        if not isinstance(keys, list) or len(set(map(str, keys))) != len(keys) \
                or set(keys) != set(baseline["event_keys"]):
            return None, f"event_keys must list exactly this run's review event keys {sorted(baseline['event_keys'])}"
        if data["amend"] is not None and (not isinstance(data["amend"], str) or not data["amend"].startswith("amend ")):
            return None, "amend must be null or the complete amend input text starting with `amend `"
        if not isinstance(data["reply"], str) or not data["reply"].strip():
            return None, "reply must be the non-empty PR reply text"
        return data, None

    def _stage2_fix_retry(self, b, problem: str) -> None:
        """Return an unusable judgment or a refused official amend to the same fix session, a bounded number of times."""
        key = f"s2_fix_apply_attempts_{b['id']}"
        try:
            attempts = int(self.store.get(key) or 0)
        except ValueError:
            attempts = S2_FIX_APPLY_ATTEMPTS
        if attempts >= S2_FIX_APPLY_ATTEMPTS or not b["session_id"]:
            return self._fail(b, "ERROR", f"Stage 2 리뷰 수정 판정을 적용하지 못했습니다: {problem}. "
                              "worktree·PR·세션을 보존합니다.")
        self.store.set(key, str(attempts + 1))
        (Path(b["worktree"]) / S2_FIX_RESPONSE).unlink(missing_ok=True)
        self.store.log(b["id"], f"Stage 2 리뷰 수정 판정 적용 거부 ({attempts + 1}/{S2_FIX_APPLY_ATTEMPTS}): {problem} "
                       "— 같은 세션에 사유를 전달합니다", "warn")
        return self._launch(self.store.batch(b["id"]), "fix_resume", [], s2_fix_note=problem)

    @staticmethod
    def _file_sha256(path: Path) -> str | None:
        return hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None

    def _stage2_amend_state(self, wt: Path, checkpoint_rel: str) -> tuple:
        """Everything an official amend can write: changed tracked files, the checkpoint and its recovery journal."""
        rels = sorted(self.git.changed_paths(wt)) + [checkpoint_rel, checkpoint_rel.replace(".json", ".amend-state.json")]
        return tuple((rel, self._file_sha256(wt / rel)) for rel in rels)

    def _stage2_fix_proof(self, b, wt: Path, head: str, outputs: dict) -> dict | None:
        """The `_stage2_final_pr_problem` reuse proof when the clean worktree holds exactly what this call's own amend
        established; None (full verification) otherwise."""
        try:
            for rel, digest in outputs.items():
                path = wt / rel
                actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
                if actual != digest:
                    return None
            batch, part = stage2.split_key(b["batch"])
            checkpoint = (wt / ".warroom-scratch" / f"relation-admission-{b['shard']}-{batch}-{part}.json").resolve()
            stat = checkpoint.stat()
        except (OSError, ValueError):
            return None
        return {"batch_id": b["id"], "checkpoint_path": str(checkpoint), "head": head,
                "checkpoint_stat": (stat.st_ino, stat.st_size, stat.st_mtime_ns)}

    def _stage2_fix_reply_lines(self, baseline, head: str) -> list[str]:
        """The reply's binding: this round's nonce, every review event it answers and the PR HEAD it answers with."""
        return ([f"WarRoom-Review-Event: {key}" for key in baseline["event_keys"]]
                + [f"WarRoom-Fix-Head: {head}", f"<!-- warroom-s2-fix {baseline['nonce']} -->"])

    def _stage2_fix_reply_id(self, b, baseline, head: str) -> int | None:
        """The id of this round's reply on GitHub: posted by our account, carrying its nonce, every event key and `head`."""
        login = str(self.cfg["expected_account"]).casefold()
        wanted = set(self._stage2_fix_reply_lines(baseline, head))
        nonce = f"<!-- warroom-s2-fix {baseline['nonce']} -->"
        for comment in self.gh.issue_comments(b["pr_number"]):
            body = str(comment.get("body") or "")
            if nonce not in body:
                continue
            lines = {line.strip() for line in body.splitlines()}
            user = comment.get("user") if isinstance(comment.get("user"), dict) else {}
            if str(user.get("login") or "").casefold() != login or not wanted <= lines \
                    or not isinstance(comment.get("id"), int):
                raise GitError(f"이번 리뷰 수정 답글(nonce {baseline['nonce'][:8]})이 계정·이벤트·HEAD 결속과 다릅니다")
            return comment["id"]
        return None

    def _stage2_post_fix_reply(self, b, baseline, response, head: str) -> int:
        """Post the AI's reply once per fix round and return its GitHub comment id. A re-entered application finds its
        own post by the nonce instead of posting again; a post GitHub does not list yet is re-read on a later tick."""
        reply_id = self._stage2_fix_reply_id(b, baseline, head)
        if reply_id is None:
            posted_key = f"s2_fix_reply_posted_{b['id']}"
            try:
                posted = json.loads(self.store.get(posted_key) or "")
            except (TypeError, ValueError):
                posted = None
            if not (isinstance(posted, dict) and posted.get("nonce") == baseline["nonce"]):
                reply = response["reply"].strip()
                missing = "".join(f"[{event}] " for event in response["event_keys"] if f"[{event}]" not in reply)
                # Recorded before the call and never cleared by a failure: a `gh` exit (timeout, signal, an error
                # printed after GitHub stored the comment) cannot prove the post did not happen, so a round posts at
                # most once and afterwards only looks for its own post (#6555 review).
                posted = {"nonce": baseline["nonce"], "at": self.clock()}
                self.store.set(posted_key, json.dumps(posted))
                try:
                    self.gh.comment_issue(b["pr_number"], "\n".join([f"{missing}{reply}", ""]
                                                                       + self._stage2_fix_reply_lines(baseline, head)))
                except (GhError, GhTransient) as e:
                    raise GhTransient(f"Stage 2 리뷰 수정 답글 게시 결과를 확정할 수 없습니다({e}); 게시 여부를 다시 조회합니다") from e
                reply_id = self._stage2_fix_reply_id(b, baseline, head)
            if reply_id is None:
                if self.clock() - float(posted.get("at") or 0) < S2_FIX_REPLY_LIST_WAIT_SECONDS:
                    raise GhTransient("게시한 Stage 2 리뷰 수정 답글이 아직 PR 댓글 목록에 없습니다")
                raise GitError(f"Stage 2 리뷰 수정 답글 게시를 시도했지만 {S2_FIX_REPLY_LIST_WAIT_SECONDS}s 동안 PR 댓글에서 확인하지 "
                               f"못했습니다. 중복을 피하려고 다시 게시하지 않습니다. PR #{b['pr_number']}에 "
                               f"`<!-- warroom-s2-fix {baseline['nonce']} -->` 댓글이 있는지 확인하세요; 리뷰 이벤트는 미완료로 보존합니다")
        self.store.set(f"s2_fix_reply_{b['id']}", json.dumps({"nonce": baseline["nonce"], "reply_id": reply_id,
                                                              "head": head}, sort_keys=True))
        return reply_id

    def _stage2_record_fix_reply(self, b, baseline, head: str) -> str | None:
        """Complete this round's review events with the run and reply that answered them (`handled_events`), or say why
        the fix is not complete. Called only after the fix itself passed the completion gate."""
        try:
            record = json.loads(self.store.get(f"s2_fix_reply_{b['id']}") or "")
        except (TypeError, ValueError):
            record = None
        run = self._last_run(b)
        if not isinstance(record, dict) or record.get("nonce") != baseline["nonce"] or record.get("head") != head \
                or not isinstance(record.get("reply_id"), int) or run is None or not str(run["kind"]).startswith("fix"):
            return "Stage 2 리뷰 수정 답글 증거가 이번 실행·HEAD와 결속되지 않았습니다. 이벤트를 완료하지 않고 보존합니다."
        try:
            found = self._stage2_fix_reply_id(b, baseline, head)
        except GitError as e:
            return f"{e}. 이벤트를 완료하지 않고 보존합니다."
        if found != record["reply_id"]:
            return f"기록한 Stage 2 리뷰 수정 답글 #{record['reply_id']}을 PR에서 확인할 수 없습니다. 이벤트를 완료하지 않고 보존합니다."
        keys = baseline["event_keys"]
        self.store.mark_handled(b["id"], b["pr_number"], baseline["event_head"], keys,
                                run_id=run["id"], reply_id=record["reply_id"])
        for key in keys:
            event = self.store.handled_event(b["id"], b["pr_number"], baseline["event_head"], key)
            if event is None or event["status"] != "HANDLED" or event["reply_id"] != record["reply_id"] \
                    or event["run_id"] != run["id"] or event["completed_at"] is None:
                return f"리뷰 이벤트 {key}의 완료 기록을 확인하지 못했습니다. 보존합니다."
        return None

    def _stage2_apply_fix(self, b, baseline) -> bool:
        """Apply a Stage 2 review-fix judgment with the official CLI (#6555): amend, commit, exact-HEAD verify, push,
        reply, then the usual completion gate. Every step is re-entrant: a restart resumes from what is already done.

        False when the run submitted nothing at all: that silent fix keeps the existing unanswered-review handling
        (PR #6249) of the caller's regular path. True when this call decided the outcome."""
        if not (Path(b["worktree"]) / S2_FIX_RESPONSE).exists():
            return False
        self._stage2_apply_fix_do(b, baseline)
        return True

    def _stage2_apply_fix_do(self, b, baseline) -> None:
        wt, timings = Path(b["worktree"]), {}
        batch, part = stage2.split_key(b["batch"])
        base_head = baseline["head"]
        outputs = None

        def timed(stage, call, *args, **kwargs):
            started = self.clock()
            try:
                return call(*args, **kwargs)
            finally:
                timings[stage] = round((self.clock() - started) * 1000)

        try:
            head = self.git.head(wt)
            if head == base_head:
                checkpoint_rel = f".warroom-scratch/relation-admission-{b['shard']}-{batch}-{part}.json"
                dirty = self.git.changed_paths(wt)
                response, problem = self._stage2_fix_response(b, baseline)
                if problem:
                    if dirty:
                        return self._fail(b, "ERROR", f"worktree 변경 {sorted(dirty)}이 있는데 제출 판정을 쓸 수 없습니다: "
                                          f"{problem}. 보존합니다.")
                    return self._stage2_fix_retry(b, problem)
                text = None if response["amend"] is None else \
                    response["amend"] if response["amend"].endswith("\n") else response["amend"] + "\n"
                input_path = wt / S2_FIX_AMEND_INPUT
                # Changes are resumable only as this submission's own interrupted amend (#6555 review): the data files it
                # may write, with its exact input still in place. Anything else is preserved untouched.
                if dirty and (text is None or any(not rel.startswith("data/") for rel in dirty)
                              or not input_path.is_file() or input_path.read_text("utf-8") != text):
                    return self._fail(b, "ERROR", f"Stage 2 리뷰 수정 제출과 연결되지 않은 worktree 변경이 있습니다: "
                                      f"{sorted(dirty)}. 적용하지 않고 보존합니다.")
                if text is not None:
                    if not dirty:
                        input_path.write_text(text, "utf-8")
                    before = self._stage2_amend_state(wt, checkpoint_rel)
                    try:
                        receipt = timed("amend", self.git.stage2_amend, wt, b["shard"], batch, part, S2_FIX_AMEND_INPUT)
                    except TRANSIENT:
                        raise
                    except GitError as e:
                        if dirty:   # this input was already accepted once: a failed replay is not a new judgment
                            return self._fail(b, "ERROR", f"중단된 공식 amend를 같은 입력으로 복구하지 못했습니다: {e}. "
                                              "입력·판정·journal·worktree를 보존합니다.")
                        if isinstance(e, Stage2AmendRejected) and self._stage2_amend_state(wt, checkpoint_rel) == before:
                            # Only the CLI's own refusal of the submitted input asks the AI for a corrected judgment.
                            return self._stage2_fix_retry(b, f"the official amend refused the submitted input: {e}")
                        # An operational failure (lock, drift, I/O, a partial write): the judgment stands. Run the same
                        # input once more; if that fails too, stop with everything preserved.
                        try:
                            receipt = timed("amend_recovery", self.git.stage2_amend, wt, b["shard"], batch, part,
                                            S2_FIX_AMEND_INPUT)
                        except TRANSIENT:
                            raise
                        except GitError as again:
                            return self._fail(b, "ERROR", f"공식 amend 실행이 판정과 무관하게 실패했고 같은 입력의 재시도도 "
                                              f"실패했습니다: {again}. 입력·판정·journal·worktree를 보존합니다.")
                    changed = self.git.changed_paths(wt)
                    data_outputs = {rel: digest for rel, digest in receipt["outputs"].items() if rel.startswith("data/")}
                    if not changed <= set(data_outputs) or any(
                            self._file_sha256(wt / rel) != data_outputs[rel] for rel in changed):
                        return self._fail(b, "ERROR", f"공식 amend 결과와 다른 파일 변경이 있습니다: {sorted(changed)}. 보존합니다.")
                    if changed:
                        timed("commit", self.git.commit_paths, wt, sorted(changed), S2_FIX_COMMIT_SUBJECT)
                        outputs = receipt["outputs"]
            else:
                # Re-entry after this application's own commit: a clean direct child of the baseline with our subject.
                if self.git.dirty(wt).strip() or self.git.commit_parent(wt) != base_head \
                        or self.git.commit_subject(wt) != S2_FIX_COMMIT_SUBJECT:
                    return self._fail(b, "ERROR", "Stage 2 리뷰 수정 적용을 재개할 수 없는 worktree 상태입니다 "
                                      f"(HEAD {head[:10]}, 기준 {base_head[:10]}). 보존합니다.")
                response, problem = self._stage2_fix_response(b, baseline)
                if problem:
                    return self._fail(b, "ERROR", f"Stage 2 리뷰 수정 재개에 제출 판정이 없습니다: {problem}. 보존합니다.")
            head = self.git.head(wt)
            if head != base_head:
                ok, tail = timed("exact_verify", self.git.verify_stage2_exact, head, b["shard"], batch, part)
                if not ok:
                    return self._fail(b, "ERROR", f"{stage2.label(b['shard'], b['batch'])} 리뷰 수정 commit의 정확한 HEAD "
                                      f"verify 실패: {tail}. push하지 않고 보존합니다.")
                remote = self.git.remote_head(b["branch"])
                if remote == base_head:
                    timed("push", self.git.push_owned_fix, wt, b["branch"], remote, head)
                elif remote != head:
                    return self._fail(b, "ERROR", f"원격 소유 브랜치가 리뷰 수정 기준에서 이동했습니다 ({remote} / {base_head}). 보존합니다.")
            timed("reply", self._stage2_post_fix_reply, b, baseline, response, head)
            info = self.gh.pull(b["pr_number"])
        except TRANSIENT:
            raise
        except GitError as e:
            return self._fail(b, "ERROR", f"Stage 2 리뷰 수정 적용 실패: {e}. worktree·PR을 보존합니다.")
        verified = self._stage2_fix_proof(b, wt, head, outputs) if outputs is not None else None
        if self._check_fix_head(b, info) != "ok":
            return
        if problem := timed("completion", self._stage2_fix_result_problem, b, info, verified) \
                or self._stage2_record_fix_reply(b, baseline, head):
            return self._fail(b, "ERROR", problem)
        self.store.delete(f"s2_fix_start_{b['id']}")
        self.store.log(b["id"], "Stage 2 리뷰 수정 적용 " + " ".join(f"{k}={v}ms" for k, v in timings.items())
                       + (" verify=reused" if verified else ""))
        self._to_review(b, info)

    def _stage2_fix_baseline_revision(self, b, wt, current: int) -> int:
        """Amend revision a review fix must exceed.

        A fix run that was interrupted after its official amend leaves the revision already raised in the
        preserved checkpoint. Its baseline is deleted only when a fix is accepted, so a restarted fix_new
        keeps the older, lower revision; otherwise the re-run's `already_applied` amend could never "increase" it.
        """
        try:
            prev = json.loads(self.store.get(f"s2_fix_start_{b['id']}") or "")
            if prev.get("branch") == b["branch"] and prev.get("worktree") == str(wt):
                return min(current, int(prev.get("amend_revision", 0)))
        except (TypeError, ValueError, AttributeError):
            pass
        return current

    def _stage2_fix_result_problem(self, b, info, verified=None) -> str | None:
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
            files = self.gh.pull_files(info["number"])
            claims = batches.pr_claims(b, {"number": info["number"], "files": files})
            if len(claims) > 1:
                self._stage2_foreign_paths(b, info, files)
                if rival := self._duplicate_claim(b, info["number"], set(claims)):
                    return f"외부 Relation shard를 열린 PR #{rival}이 점유합니다. worktree와 PR을 보존합니다."
            return self._stage2_final_pr_problem(b, info, verified)
        except TRANSIENT:
            raise
        except Exception as e:
            return f"Stage 2 리뷰 수정 결과 검증 실패: {e}"

    def _stage2_finalize(self, b) -> None:
        if self._finalization_held(b, "s2_deterministic_finalize"):
            return
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

    @staticmethod
    def _stage2_repair_correction(current: dict) -> dict | None:
        """Read the generic correction state and the pre-#3044 schema-only state."""
        correction = current.get("response_correction")
        legacy = current.get("schema_repair")
        if correction is not None and legacy is not None:
            raise ValueError("Stage 2 repair has conflicting correction evidence")
        return correction if correction is not None else legacy

    def _save_stage2_repair_state(self, b, state: dict) -> None:
        self.store.set(stage2.repair_state_key(b["id"]), json.dumps(state, ensure_ascii=False, sort_keys=True))

    def _stage2_repair_boundary_problem(self, b, base_override: dict | None = None) -> str | None:
        raw = json.dumps(base_override) if base_override is not None else self.store.get(stage2.repair_run_start_key(b["id"]))
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
            attempts = current.get("attempt_log")
            attempt = attempts[-1] if isinstance(attempts, list) and attempts else None
            if "attempt" in baseline and (not isinstance(attempt, dict)
                    or attempt.get("attempt") != baseline.get("attempt")
                    or attempt.get("fingerprint") != baseline.get("fingerprint")
                    or attempt.get("cursor") != baseline.get("cursor")
                    or attempt.get("target_keys") != baseline.get("page_keys")
                    or attempt.get("correction_candidate_keys") != baseline.get("correction_candidate_keys")
                    or attempt.get("correction_response_sha256") != baseline.get("correction_response_sha256")):
                return "Stage 2 repair run does not match its persisted attempt and correction scope"
            if current.get("pending_answer") is not None and "attempt" in baseline:
                if not isinstance(attempt, dict) or attempt.get("status") != "answer_saved" \
                        or type(attempt.get("run_id")) is not int \
                        or not re.fullmatch(r"[a-f0-9]{64}", attempt.get("response_sha256", "")) \
                        or hashlib.sha256((current.get("last_response") or "").encode("utf-8")).hexdigest() \
                        != attempt.get("response_sha256"):
                    return "Stage 2 pending repair answer is not bound to its completed attempt output"
                run_id = attempt["run_id"]
                run = next((row for row in self.store.runs(b["id"]) if row["id"] == run_id), None)
                if run is None or run["kind"] != "s2_repair_new" or run["ended_at"] is None \
                        or str(run["exit_status"]) != "0" or run["log_file"] != b["log_file"] \
                        or self._adapter(b["producer"]).final_answer(Path(run["log_file"])) != current.get("last_response"):
                    return "Stage 2 pending repair answer differs from its completed output run"
        except TRANSIENT:
            raise
        except Exception as error:
            return f"Stage 2 repair boundary check failed: {error}"
        return None

    def _stage2_repair_mark_rejected(self, b, state: dict, final: str, error: ValueError,
                                     reason_code: str) -> None:
        """Persist a completed output-validation failure without turning it into an applied judgment."""
        current = state.get("current")
        attempts = current.get("attempt_log") if isinstance(current, dict) else None
        if not isinstance(attempts, list) or not attempts or not isinstance(attempts[-1], dict) \
                or attempts[-1].get("status") != "launched":
            self._save_stage2_repair_state(b, state)
            return
        run = self._last_run(b)
        if run is None or run["kind"] != "s2_repair_new" or run["ended_at"] is None \
                or str(run["exit_status"]) != "0" \
                or attempts[-1].get("run_id") not in (None, run["id"]) \
                or str(run["log_file"]) != str(b["log_file"]):
            self._save_stage2_repair_state(b, state)
            return
        attempt = attempts[-1]
        attempt.update({
            "status": "rejected",
            "rejection_version": 1,
            "reason_code": reason_code,
            "response_sha256": hashlib.sha256(final.encode("utf-8")).hexdigest(),
            "error_sha256": hashlib.sha256(str(error).encode("utf-8")).hexdigest(),
            "rejected_at": self.clock(),
        })
        attempt["run_id"] = run["id"]
        attempt["run_exit_status"] = str(run["exit_status"])
        attempt["run_ended_at"] = run["ended_at"]
        correction = self._stage2_repair_correction(current)
        if correction is not None and correction.get("source_attempt") == attempt.get("attempt"):
            if "correction_response_sha256" not in attempt:   # an attempt that itself ran a correction keeps its own scope
                attempt["correction_candidate_keys"] = correction["requested_keys"]
                attempt["correction_kind"] = correction["kind"]
            else:
                attempt["produced_correction_keys"] = correction["requested_keys"]
            correction["source_run_id"] = run["id"]
        self._save_stage2_repair_state(b, state)

    @staticmethod
    def _stage2_repair_legacy_reason_code(error_text: str) -> str | None:
        """Classify only known completed response-validation diagnostics from the pre-proof Supervisor."""
        lowered = error_text.lower()
        if lowered.startswith("unresolved:"):
            return "unresolved"
        if any(token in lowered for token in (
                "schema", "already_accounted", "additional_relations", "complete optional-link list")):
            return "schema"
        if any(token in lowered for token in (
                "repair decision needs", "repair response contains", "unresolved repair items need",
                "repair response does not cover", "peer adjustments need", "peer adjustment is outside")):
            return "content"
        return None

    @staticmethod
    def _stage2_repair_answer_keys(answer: dict) -> list[str] | None:
        keys = []
        for row in answer["decisions"] + answer["unresolved"]:
            if not isinstance(row, dict) or not isinstance(row.get("source_sense_id"), str) \
                    or not isinstance(row.get("candidate"), str):
                return None
            keys.append(f"{row['source_sense_id']}\u0000{row['candidate']}")
        return keys

    def _stage2_repair_reconcile_legacy_launches(self, b, current: dict, attempts: list) -> tuple[list, str | None]:
        """Reconcile one old `launched` row only when its exact finished run and validation error are provable."""
        legacy_positions = [i for i, attempt in enumerate(attempts)
                            if isinstance(attempt, dict) and attempt.get("status") == "launched"
                            and "rejection_version" not in attempt]
        normalized = json.loads(json.dumps(attempts))
        if not legacy_positions:
            return normalized, None
        if len(legacy_positions) != 1:
            return normalized, "multiple legacy launched attempts cannot be safely reconciled"
        if normalized[legacy_positions[0]].get("receipt") is not None:
            return normalized, "legacy launched attempt unexpectedly contains a receipt"

        fingerprint = current.get("fingerprint")
        groups = current.get("groups")
        if not isinstance(fingerprint, str) or not isinstance(groups, list):
            return normalized, "legacy attempt has no stable repair page identity"

        runs = list(reversed(self.store.runs(b["id"])))
        repair_runs = [run for run in runs if run["kind"] == "s2_repair_new"]
        matching_runs = []
        for run in repair_runs:
            if not run["log_file"]:
                continue
            response = self._adapter(b["producer"]).final_answer(Path(run["log_file"]))
            if not isinstance(response, str):
                continue
            answer = stage2.extract_legacy_repair_answer(response, fingerprint)
            if answer is not None:
                if run["ended_at"] is None or str(run["exit_status"]) != "0":
                    return normalized, "a fingerprint-matched legacy repair run is not complete"
                matching_runs.append((run, response, answer))
        if len(matching_runs) != len(normalized):
            return normalized, "legacy repair runs do not map one-to-one to persisted page attempts"

        events = self.store.batch_events(b["id"])
        legacy_index = legacy_positions[0]
        if legacy_index == len(normalized) - 1 or not any(
                later.get("status") == "applied" and later.get("cursor") == normalized[legacy_index].get("cursor")
                and later.get("target_keys") == normalized[legacy_index].get("target_keys")
                for later in normalized[legacy_index + 1:] if isinstance(later, dict)):
            return normalized, "legacy rejection has no later applied attempt for the same page"

        for index, (attempt, run_answer) in enumerate(zip(normalized, matching_runs)):
            run, response, answer = run_answer
            cursor = attempt.get("cursor") if isinstance(attempt, dict) else None
            if type(cursor) is not int or not 0 <= cursor < len(groups):
                return normalized, "legacy repair attempt cursor is invalid"
            page = stage2.repair_page(groups, cursor, attempt.get("target_keys"))
            page_keys = sorted({key for group in page if isinstance(group, dict)
                                for key in group.get("candidate_keys", [])})
            if not page_keys or attempt.get("target_keys") != page_keys:
                return normalized, "legacy repair attempt targets differ from its persisted page"
            if attempt.get("run_id") is not None and attempt.get("run_id") != run["id"]:
                return normalized, "legacy repair run ID differs from its attempt record"
            requested_keys = attempt.get("correction_candidate_keys") or page_keys
            if not isinstance(requested_keys, list) or not requested_keys or requested_keys != sorted(set(requested_keys)) \
                    or not set(requested_keys).issubset(page_keys):
                return normalized, "legacy correction scope is malformed"
            response_keys = self._stage2_repair_answer_keys(answer)
            if not response_keys or len(response_keys) != len(set(response_keys)) \
                    or not set(response_keys).issubset(requested_keys):
                return normalized, "legacy response keys differ from the recorded repair scope"
            if attempt.get("status") == "applied" and set(response_keys) != set(requested_keys):
                return normalized, "legacy applied response does not cover its recorded repair scope"

            if index == legacy_index:
                if run["ended_at"] is None or str(run["exit_status"]) != "0":
                    return normalized, "legacy response run did not terminate successfully"
                later_runs = [item for item in repair_runs if item["id"] > run["id"]]
                if not later_runs:
                    return normalized, "legacy response has no subsequent repair attempt"
                next_start = later_runs[0]["started_at"]
                prefix = "Stage 2 repair answer rejected; no checkpoint change was made:"
                errors = [event for event in events if event["level"] == "error"
                          and run["ended_at"] <= event["ts"] < next_start
                          and event["msg"].startswith(prefix)]
                if len(errors) != 1:
                    return normalized, "legacy run has no unique persisted response-validation error"
                event = errors[0]
                error_text = event["msg"][len(prefix):].strip()
                reason_code = self._stage2_repair_legacy_reason_code(error_text)
                if reason_code is None:
                    return normalized, "legacy error is not a recognized response-validation failure"
                if not any(key in error_text or key.replace("\u0000", "/") in error_text for key in response_keys):
                    return normalized, "legacy error is not bound to a candidate in its response"
                response_sha256 = hashlib.sha256(response.encode("utf-8")).hexdigest()
                error_sha256 = hashlib.sha256(error_text.encode("utf-8")).hexdigest()
                proof = {
                    "run_id": run["id"], "run_exit_status": str(run["exit_status"]),
                    "run_ended_at": run["ended_at"], "response_sha256": response_sha256,
                    "error_event_id": event["id"],
                    "error_event_sha256": hashlib.sha256(event["msg"].encode("utf-8")).hexdigest(),
                    "fingerprint": fingerprint, "cursor": cursor, "target_keys": page_keys,
                    "response_candidate_keys": response_keys,
                }
                proof_sha256 = hashlib.sha256(json.dumps(
                    proof, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
                reconciled_at = self.clock()
                attempt.update({
                    "status": "rejected", "rejection_version": 1, "reason_code": reason_code,
                    "response_sha256": response_sha256, "error_sha256": error_sha256,
                    "run_id": run["id"], "run_exit_status": str(run["exit_status"]),
                    "run_ended_at": run["ended_at"], "rejected_at": reconciled_at, "reconciled_at": reconciled_at,
                    "reconciliation": {"source": "legacy_run_ledger", "error_event_id": event["id"],
                                       "error_event_ts": event["ts"],
                                       "error_event_sha256": proof["error_event_sha256"],
                                       "proof_sha256": proof_sha256},
                })
        return normalized, None

    def _stage2_repair_explicit_rejection_problem(self, b, current_fp: str, attempt: dict, runs_by_id: dict) -> str | None:
        """Check the durable run/output proof written for rejection statuses produced by this version."""
        if "rejection_version" not in attempt:
            return None
        if attempt.get("rejection_version") != 1:
            return "Stage 2 rejected attempt evidence version is invalid"
        if attempt.get("reason_code") not in {"format", "schema", "unresolved", "content", "coverage"} \
                or not re.fullmatch(r"[a-f0-9]{64}", attempt.get("response_sha256", "")) \
                or not re.fullmatch(r"[a-f0-9]{64}", attempt.get("error_sha256", "")) \
                or type(attempt.get("run_id")) is not int \
                or not isinstance(attempt.get("rejected_at"), (int, float)):
            return "Stage 2 rejected attempt evidence is malformed"
        reconciliation = attempt.get("reconciliation")
        if reconciliation is not None:
            if not isinstance(reconciliation, dict) or reconciliation.get("source") != "legacy_run_ledger" \
                    or type(reconciliation.get("error_event_id")) is not int \
                    or not isinstance(reconciliation.get("error_event_ts"), (int, float)) \
                    or not re.fullmatch(r"[a-f0-9]{64}", reconciliation.get("error_event_sha256", "")) \
                    or not re.fullmatch(r"[a-f0-9]{64}", reconciliation.get("proof_sha256", "")):
                return "Stage 2 legacy rejection proof is malformed"
        run = runs_by_id.get(attempt["run_id"])
        if run is None or run["kind"] != "s2_repair_new" or run["ended_at"] is None \
                or str(run["exit_status"]) != "0" or attempt.get("run_exit_status") != "0" \
                or attempt.get("run_ended_at") != run["ended_at"] or not run["log_file"]:
            return "Stage 2 rejected attempt has no matching completed run"
        response = self._adapter(b["producer"]).final_answer(Path(run["log_file"]))
        if not isinstance(response, str) or hashlib.sha256(response.encode("utf-8")).hexdigest() != attempt["response_sha256"]:
            return "Stage 2 rejected attempt response hash differs from its run log"
        parsed_answer = (None if attempt["reason_code"] == "format"
                         else stage2.extract_repair_answer(response, current_fp))
        if attempt["reason_code"] != "format" and parsed_answer is None:
            return "Stage 2 rejected answer fingerprint differs from its run output"
        if attempt["reason_code"] == "coverage":
            response_keys = self._stage2_repair_answer_keys(parsed_answer) if parsed_answer is not None else None
            targets = attempt.get("target_keys")
            requested = attempt.get("correction_candidate_keys")
            if not isinstance(targets, list) or not isinstance(requested, list) or response_keys is None \
                    or len(response_keys) != len(set(response_keys)) or not set(response_keys).issubset(targets) \
                    or sorted(set(targets) - set(response_keys)) != requested or not requested \
                    or attempt.get("correction_kind") != "coverage":
                return "Stage 2 coverage rejection does not prove the exact missing candidate set"
        if reconciliation is not None:
            prefix = "Stage 2 repair answer rejected; no checkpoint change was made:"
            matches = [event for event in self.store.batch_events(b["id"])
                       if event["id"] == reconciliation["error_event_id"]]
            if len(matches) != 1 or matches[0]["ts"] != reconciliation["error_event_ts"] \
                    or not matches[0]["msg"].startswith(prefix):
                return "Stage 2 legacy rejection event is missing or changed"
            event = matches[0]
            event_sha256 = hashlib.sha256(event["msg"].encode("utf-8")).hexdigest()
            error_text = event["msg"][len(prefix):].strip()
            response_keys = self._stage2_repair_answer_keys(parsed_answer) if parsed_answer is not None else None
            if not response_keys or not any(
                    key in error_text or key.replace("\u0000", "/") in error_text for key in response_keys):
                return "Stage 2 legacy error is not bound to its saved response keys"
            if event_sha256 != reconciliation["error_event_sha256"] \
                    or hashlib.sha256(error_text.encode("utf-8")).hexdigest() != attempt["error_sha256"] \
                    or self._stage2_repair_legacy_reason_code(error_text) != attempt["reason_code"]:
                return "Stage 2 legacy rejection details differ from their saved proof"
            proof = {
                "run_id": run["id"], "run_exit_status": str(run["exit_status"]),
                "run_ended_at": run["ended_at"], "response_sha256": attempt["response_sha256"],
                "error_event_id": event["id"], "error_event_sha256": event_sha256,
                "fingerprint": current_fp, "cursor": attempt["cursor"],
                "target_keys": attempt["target_keys"],
                "response_candidate_keys": response_keys,
            }
            proof_sha256 = hashlib.sha256(json.dumps(
                proof, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest()
            if proof_sha256 != reconciliation["proof_sha256"]:
                return "Stage 2 legacy rejection proof hash does not match its evidence"
        return None

    @staticmethod
    def _stage2_repair_page_is_stale(current: dict, fingerprint: str) -> bool:
        """An unresolved-rejected, unapplied page whose basis a clean preflight (different fingerprint) has superseded."""
        attempts, groups, cursor = current.get("attempt_log"), current.get("groups"), current.get("cursor")
        attempt = attempts[-1] if isinstance(attempts, list) and attempts else None
        return isinstance(attempt, dict) and attempt.get("status") == "rejected" \
            and attempt.get("reason_code") == "unresolved" and current.get("pending_answer") is None \
            and current.get("apply_intent") is None and current.get("duplicate_pair_fallback") is None \
            and isinstance(groups, list) and type(cursor) is int and cursor < len(groups) \
            and current.get("fingerprint") != fingerprint

    def _stage2_repair_rebind_problem(self, b, state: dict, checkpoint: dict, fingerprint: str) -> str | None:
        """Advance a completed Repair identity only after current-base preflight and durable owner evidence."""
        try:
            identity = state.get("identity")
            if not isinstance(identity, dict):
                return "Stage 2 repair has no owner identity to rebind"
            if b["pid"] is not None:
                return "Stage 2 repair still has a running process; preserving state"
            old_head = identity.get("base_head")
            if not re.fullmatch(r"[a-f0-9]{40}", old_head or ""):
                return "Stage 2 repair owner baseline is invalid; preserving prior decisions and receipts"
            wt = Path(b["worktree"])
            if self.git.registered(wt) != b["branch"]:
                return "Stage 2 repair rebind worktree is not registered to its owned branch"
            self.git.worktree_gitdir(wt)
            if self.git.dirty(wt).strip():
                return "Stage 2 repair rebind found a dirty worktree; preserving prior decisions and receipts"

            head = self.git.head(wt)
            remote = self.git.remote_head(b["branch"])
            if identity.get("remote_head") != remote:
                return "Stage 2 repair remote branch identity changed; preserving prior decisions and receipts"
            if head == old_head:
                return None
            finalize_base = self.store.get(f"s2_finalize_base_{b['id']}")
            # A Maintainer master-integration during a Repair run retargets only the Repair run-start baseline
            # (never `s2_finalize_base`); accept that exact baseline too. The master-integration chain proof below
            # remains the authority for the HEAD move.
            try:
                start_head = json.loads(self.store.get(stage2.repair_run_start_key(b["id"])) or "").get("head")
            except (ValueError, AttributeError):
                start_head = None
            if head not in (finalize_base, start_head) or not re.fullmatch(r"[a-f0-9]{40}", head or ""):
                return "Stage 2 repair rebind lacks the matching Supervisor finalization HEAD baseline"

            bb, pp = stage2.split_key(b["batch"])
            expected_part = f"{b['shard']}/{bb}/{pp}"
            premerge = checkpoint.get("premerge")
            if checkpoint.get("merged") or not isinstance(premerge, dict) or \
                    premerge.get("status") != "ready" or premerge.get("identity") != expected_part:
                return "Stage 2 repair rebind requires the current Part's ready premerge snapshot"

            histories = state.get("history")
            current = state.get("current")
            if isinstance(histories, list) and histories and isinstance(current, dict) and (
                    current.get("abandoned") is not None or self._stage2_repair_page_is_stale(current, fingerprint)):
                # The preflight is clean, so a rejected-unresolved page that never reached an apply boundary has
                # nothing left to repair. Rebind only the owner identity (verified Supervisor integration), and close
                # the superseded page instead of leaving an unfinished cursor.
                if not self.git.verified_supervisor_integration(wt, b["branch"], self.cfg["base_branch"], old_head, head):
                    return "Stage 2 repair rebind lacks a verified Supervisor master-integration chain"
                updated = json.loads(json.dumps(state))
                cur = updated["current"]
                if cur.get("abandoned") is None:
                    cur["abandoned"] = {"fingerprint": cur.get("fingerprint"), "cursor": cur.get("cursor"),
                                        "target_keys": cur.get("target_keys"),
                                        "applied_candidate_keys": cur.get("applied_candidate_keys"),
                                        "attempt_log": cur.get("attempt_log"), "last_error": cur.get("last_error"),
                                        "superseded_by": fingerprint}
                    for key in ("last_error", "last_response", "schema_repair", "response_correction"):
                        cur.pop(key, None)
                    cur.update({"groups": [], "cursor": 0, "attempts": 0, "attempt_log": []})
                updated.setdefault("rebindings", []).append({
                    "from_head": old_head, "to_head": head, "branch": b["branch"], "worktree": str(wt),
                    "base_branch": self.cfg["base_branch"], "remote_head": remote,
                    "preflight_fingerprint": fingerprint,
                })
                updated["identity"]["base_head"] = head
                updated["identity"]["remote_head"] = remote
                self._save_stage2_repair_state(b, updated)
                state.clear()
                state.update(updated)
                return None
            if not isinstance(histories, list) or not histories or not isinstance(current, dict):
                return "Stage 2 repair rebind has no completed repair history; preserving state"
            groups = current.get("groups")
            cursor = current.get("cursor")
            if not isinstance(groups, list) or not groups or type(cursor) is not int or cursor != len(groups) \
                    or current.get("pending_answer") is not None or current.get("apply_intent") is not None \
                    or self._stage2_repair_correction(current) is not None or current.get("last_error") is not None \
                    or current.get("attempts") != 0 or "last_response" in current:
                return "Stage 2 repair page is unfinished; preserving its answer and apply boundary"

            checkpoint_path = wt / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.json"
            raw_checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
            if not isinstance(raw_checkpoint, dict) or raw_checkpoint.get("merged") is not False or \
                    raw_checkpoint.get("optional_review_complete") is not True:
                return "Stage 2 repair rebind checkpoint is incomplete or already merged"
            receipts = raw_checkpoint.get("repair_receipts")
            if not isinstance(receipts, list):
                return "Stage 2 repair receipt list is missing; preserving state"
            receipt_by_id, receipts_by_fingerprint = {}, {}
            for receipt in receipts:
                if not isinstance(receipt, dict):
                    return "Stage 2 repair receipt is malformed; preserving state"
                request_id = receipt.get("request_id")
                receipt_fp = receipt.get("fingerprint")
                nonce = receipt.get("supervisor_nonce")
                keys = receipt.get("candidate_keys")
                if not re.fullmatch(r"[a-f0-9]{64}", request_id or "") or \
                        not re.fullmatch(r"[a-f0-9]{64}", receipt_fp or "") or \
                        not re.fullmatch(r"[a-f0-9]{64}", nonce or "") or \
                        not isinstance(keys, list) or not keys or any(not isinstance(key, str) or key.count("\u0000") != 1
                                                                     or not all(key.split("\u0000")) for key in keys) \
                        or keys != sorted(set(keys)) or request_id in receipt_by_id:
                    return "Stage 2 repair receipt identity or candidate set does not match; preserving state"
                receipt_by_id[request_id] = receipt
                receipts_by_fingerprint.setdefault(receipt_fp, set()).update(keys)

            history_fingerprints = set()
            for index, entry in enumerate(histories):
                if not isinstance(entry, dict):
                    return "Stage 2 repair history is malformed; preserving state"
                entry_fp = entry.get("fingerprint")
                targets, applied = entry.get("target_keys"), entry.get("applied_candidate_keys")
                if not re.fullmatch(r"[a-f0-9]{64}", entry_fp or "") or entry_fp in history_fingerprints \
                        or not isinstance(targets, list) or not isinstance(applied, list) \
                        or any(not isinstance(key, str) for key in targets + applied) \
                        or len(set(targets)) != len(targets) or len(set(applied)) != len(applied):
                    return "Stage 2 repair history or applied candidate set is malformed; preserving state"
                history_fingerprints.add(entry_fp)
                receipt_keys = receipts_by_fingerprint.get(entry_fp, set())
                # A superseded earlier round legitimately leaves targets unreceipted: they are exactly the next
                # round's recorded targets (`remaining_candidate_keys`), and later rounds re-examined them.
                next_entry = histories[index + 1] if index + 1 < len(histories) else None
                remaining = entry.get("remaining_candidate_keys")
                superseded = isinstance(next_entry, dict) and not entry.get("resolved") \
                    and entry.get("residual_fingerprint") == next_entry.get("fingerprint") \
                    and isinstance(remaining, list) and remaining == next_entry.get("target_keys") \
                    and set(remaining).issubset(targets)
                if set(applied) != receipt_keys or not (superseded or set(targets).issubset(receipt_keys)):
                    return "Stage 2 repair receipt does not match its persisted history; preserving state"
            if set(receipts_by_fingerprint) - history_fingerprints:
                return "Stage 2 checkpoint contains an untracked repair receipt; preserving state"

            last_history = histories[-1]
            current_fp = current.get("fingerprint")
            current_applied = current.get("applied_candidate_keys")
            if last_history.get("fingerprint") != current_fp or not isinstance(current_applied, list) or \
                    set(current_applied) != set(last_history.get("applied_candidate_keys", [])):
                return "Stage 2 current repair does not match its saved history; preserving state"
            expected_targets = sorted({key for group in groups if isinstance(group, dict)
                                       for key in group.get("candidate_keys", [])})
            if expected_targets != current.get("target_keys") or not set(expected_targets).issubset(set(current_applied)):
                return "Stage 2 completed repair targets do not match their applied receipt set"

            attempt_log = current.get("attempt_log")
            if not isinstance(attempt_log, list) or not attempt_log:
                return "Stage 2 completed repair has no persisted page attempts"
            attempt_log, problem = self._stage2_repair_reconcile_legacy_launches(b, current, attempt_log)
            if problem:
                return f"Stage 2 legacy attempt reconciliation failed: {problem}; preserving state"
            runs_by_id = {run["id"]: run for run in self.store.runs(b["id"])}
            covered = set()
            attempt_numbers, recorded_run_ids = {}, set()
            for attempt in attempt_log:
                if not isinstance(attempt, dict) or attempt.get("fingerprint") != current_fp \
                        or type(attempt.get("cursor")) is not int or not 0 <= attempt["cursor"] < len(groups) \
                        or attempt.get("status") not in {"applied", "rejected"}:
                    return "Stage 2 repair has an unfinished or mismatched page attempt"
                if type(attempt.get("attempt")) is not int or attempt["attempt"] < 1:
                    return "Stage 2 repair attempt number is malformed"
                expected_attempt_number = attempt_numbers.get(attempt["cursor"], 0) + 1
                if attempt["attempt"] != expected_attempt_number:
                    return "Stage 2 repair attempt sequence is incomplete or duplicated"
                attempt_numbers[attempt["cursor"]] = expected_attempt_number
                run_id = attempt.get("run_id")
                if run_id is not None:
                    if type(run_id) is not int or run_id < 1 or run_id in recorded_run_ids:
                        return "Stage 2 repair attempts have a malformed or duplicate run identity"
                    recorded_run_ids.add(run_id)
                page = stage2.repair_page(groups, attempt["cursor"], attempt.get("target_keys"))
                page_targets = sorted({key for group in page if isinstance(group, dict)
                                       for key in group.get("candidate_keys", [])})
                if not page_targets or attempt.get("target_keys") != page_targets:
                    return "Stage 2 repair attempt targets do not match their page"
                if "correction_source_attempt" in attempt:
                    source_attempt = next((row for row in attempt_log if isinstance(row, dict)
                                           and row.get("cursor") == attempt["cursor"]
                                           and row.get("attempt") == attempt.get("correction_source_attempt")), None)
                    source_run = runs_by_id.get(attempt.get("correction_source_run_id"))
                    requested = attempt.get("correction_candidate_keys")
                    correction_kind = attempt.get("correction_kind")
                    if not isinstance(source_attempt, dict) or source_attempt.get("status") != "rejected" \
                            or source_attempt.get("run_id") != attempt.get("correction_source_run_id") \
                            or source_attempt.get("response_sha256") != attempt.get("correction_response_sha256") \
                            or source_attempt.get("fingerprint") != current_fp \
                            or source_attempt.get("target_keys") != page_targets \
                            or not isinstance(requested, list) or requested != sorted(set(requested)) \
                            or not set(requested).issubset(page_targets) \
                            or correction_kind not in {"coverage", "schema", "schema_and_coverage", "problems"} \
                            or source_run is None or source_run["kind"] != "s2_repair_new" \
                            or source_run["ended_at"] is None or str(source_run["exit_status"]) != "0":
                        return "Stage 2 repair correction is not bound to its rejected source attempt"
                    source_response = self._adapter(b["producer"]).final_answer(Path(source_run["log_file"]))
                    if not isinstance(source_response, str) \
                            or hashlib.sha256(source_response.encode("utf-8")).hexdigest() != attempt["correction_response_sha256"]:
                        return "Stage 2 repair correction source response hash does not match its run"
                    if "correction_problems" in attempt:
                        if sorted({row.get("candidate_key") for row in attempt["correction_problems"]
                                   if isinstance(row, dict)}) != sorted(set(requested) | set(attempt.get("correction_peer_keys", []))):
                            return "Stage 2 repair correction problems do not match their requested candidates"
                    elif correction_kind in {"coverage", "schema", "schema_and_coverage"}:
                        source_answer = stage2.extract_repair_answer(source_response, current_fp)
                        response_keys = self._stage2_repair_answer_keys(source_answer) if source_answer is not None else None
                        missing = sorted(set(page_targets) - set(response_keys or [])) if response_keys is not None else None
                        page_candidates = {f"{candidate['source_sense_id']}\u0000{candidate['candidate']}": candidate
                                           for group in page if isinstance(group, dict)
                                           for candidate in group.get("candidates", []) if isinstance(candidate, dict)}
                        schema_invalid = []
                        if source_answer is not None:
                            for row in source_answer["decisions"]:
                                key = f"{row.get('source_sense_id')}\u0000{row.get('candidate')}"
                                candidate = page_candidates.get(key)
                                if candidate is None:
                                    return "Stage 2 repair correction source contains a candidate outside its page"
                                required_fields = ({"source_sense_id", "candidate", "additional_relations"}
                                                   if candidate.get("already_accounted")
                                                   else {"source_sense_id", "candidate", "decision"})
                                bad_shape = set(row) != required_fields
                                if not bad_shape and candidate.get("already_accounted"):
                                    bad_shape = not isinstance(row.get("additional_relations"), list)
                                elif not bad_shape:
                                    bad_shape = not isinstance(row.get("decision"), dict)
                                if bad_shape:
                                    schema_invalid.append(key)
                        expected_correction = (set(missing or []) if correction_kind == "coverage"
                                               else set(schema_invalid) if correction_kind == "schema"
                                               else set(missing or []) | set(schema_invalid))
                        correction_causes_match = (
                            (correction_kind == "coverage" and not schema_invalid and bool(missing))
                            or (correction_kind == "schema" and not missing and bool(schema_invalid))
                            or (correction_kind == "schema_and_coverage" and bool(missing) and bool(schema_invalid)))
                        if source_answer is None or response_keys is None or len(response_keys) != len(set(response_keys)) \
                                or not set(response_keys).issubset(page_targets) or source_answer["unresolved"] \
                                or not correction_causes_match or set(requested) != expected_correction:
                            return "Stage 2 repair correction does not preserve the exact missing candidate set"
                if attempt["status"] == "rejected":
                    if problem := self._stage2_repair_explicit_rejection_problem(
                            b, current_fp, attempt, runs_by_id):
                        return f"{problem}; preserving state"
                    continue
                if run_id is None and any(isinstance(prior, dict) and prior.get("cursor") == attempt["cursor"]
                                          and prior.get("target_keys") == page_targets
                                          and prior.get("status") == "rejected"
                                          and prior.get("reason_code") == "format"
                                          and prior.get("attempt", 0) < attempt["attempt"]
                                          for prior in attempt_log):
                    return "Stage 2 applied repair attempt has no run identity after a rejected format response"
                receipt = receipt_by_id.get(attempt.get("receipt"))
                if receipt is None or receipt.get("fingerprint") != current_fp or \
                        attempt.get("target_keys") != page_targets or \
                        not set(page_targets).issubset(receipt.get("candidate_keys", [])):
                    return "Stage 2 repair attempt and idempotent receipt do not match"
                covered.update(range(attempt["cursor"], min(len(groups), attempt["cursor"] + len(page))))
            if covered != set(range(len(groups))) or attempt_log[-1].get("status") != "applied":
                return "Stage 2 repair groups are not fully covered by applied receipts"

            run_start_raw = self.store.get(stage2.repair_run_start_key(b["id"]))
            run_start = json.loads(run_start_raw or "")
            last_attempt = attempt_log[-1]
            if not isinstance(run_start, dict) or run_start.get("branch") != b["branch"] or \
                    run_start.get("worktree") != str(wt) or run_start.get("remote_head") != identity.get("remote_head") or \
                    not re.fullmatch(r"[a-f0-9]{64}", run_start.get("checkpoint_sha256", "")) or \
                    run_start.get("fingerprint") != current_fp or run_start.get("cursor") != last_attempt.get("cursor") or \
                    run_start.get("page_keys") != last_attempt.get("target_keys"):
                return "Stage 2 repair run boundary does not match its completed receipt; preserving state"
            round_base = last_history.get("base_head") or run_start.get("head")
            if not re.fullmatch(r"[a-f0-9]{40}", round_base or "") or run_start.get("head") not in (round_base, head):
                return "Stage 2 repair round does not retain its original owner HEAD baseline"

            rebindings = state.get("rebindings", [])
            if not isinstance(rebindings, list):
                return "Stage 2 repair rebind history is malformed; preserving state"
            if rebindings:
                chain_start = rebindings[0].get("from_head") if isinstance(rebindings[0], dict) else None
                chain_head = chain_start
                checkpoints = {chain_start}
                for entry in rebindings:
                    if not isinstance(entry, dict) or entry.get("from_head") != chain_head or \
                            not re.fullmatch(r"[a-f0-9]{40}", entry.get("to_head", "")) or \
                            entry.get("to_head") == chain_head or entry.get("branch") != b["branch"] or \
                            entry.get("worktree") != str(wt) or entry.get("base_branch") != self.cfg["base_branch"] or \
                            entry.get("remote_head") != identity.get("remote_head") or \
                            not re.fullmatch(r"[a-f0-9]{64}", entry.get("preflight_fingerprint", "")):
                        return "Stage 2 repair rebind history is not a continuous owner-bound chain"
                    chain_head = entry["to_head"]
                    checkpoints.add(chain_head)
                if chain_head != old_head or round_base not in checkpoints:
                    return "Stage 2 repair rebind history does not reach its current identity"
                if re.fullmatch(r"[a-f0-9]{40}", histories[0].get("base_head", "")) and \
                        histories[0]["base_head"] != chain_start:
                    return "Stage 2 repair rebind history differs from its first repair round"
            else:
                chain_start = round_base
                if old_head != round_base:
                    return "Stage 2 repair identity changed without a recorded rebind"

            if not self.git.verified_supervisor_integration(wt, b["branch"], self.cfg["base_branch"],
                                                           chain_start, head):
                return "Stage 2 repair rebind lacks a verified Supervisor master-integration chain"

            updated = json.loads(json.dumps(state))
            updated["current"]["attempt_log"] = attempt_log
            updated.setdefault("rebindings", []).append({
                "from_head": old_head, "to_head": head, "branch": b["branch"], "worktree": str(wt),
                "base_branch": self.cfg["base_branch"], "remote_head": remote,
                "preflight_fingerprint": fingerprint,
            })
            updated["identity"]["base_head"] = head
            updated["identity"]["remote_head"] = remote
            self._save_stage2_repair_state(b, updated)
            state.clear()
            state.update(updated)
            return None
        except TRANSIENT:
            raise
        except Exception as error:
            return f"Stage 2 repair rebind evidence check failed: {error}; preserving prior decisions and receipts"

    START_FAILURE_PREFIX = "AI 실행 시작 실패"

    def _spawn_never_started(self, b, spawn: dict, attempt: dict, current: dict) -> bool:
        """True only with durable proof that this reservation's launch FAILED before any worker existed (#6920).

        Absence of files is never proof: the detached wrapper writes `<exit>.pid` after `Popen` returns and the parent
        stores the pid/run row after that, so a restart in between would look identical to a never-started launch.
        Proof is (1) the `start_failed` marker `_launch` stored when `ad.start` raised, or (2) for a reservation made
        before that marker existed, a start-failure audit event newer than the last consumed one and not older than this
        reservation's own launch second (so an earlier launch's failure never vouches for it). Either way no exit/pid file may exist and the log must be absent or empty."""
        log, ex = spawn.get("log_file"), spawn.get("exit_file")
        if not isinstance(log, str) or not isinstance(ex, str):
            return False
        try:
            if Path(ex).exists() or Path(ex + ".pid").exists():
                return False
            logp = Path(log)
            if logp.exists() and logp.stat().st_size != 0:
                return False
            if spawn.get("start_failed") is True:
                return True
            consumed = current.get("start_failure_consumed_event", 0)
            # Attribute the event to THIS reservation: `_launch` names the log `batch-<id>-<launch second>.log` and a
            # later reservation only exists after the earlier failure moved the batch out of PRODUCING, so an earlier
            # launch's failure event is older than this launch second. No parseable launch time => no attribution.
            m = re.fullmatch(r"batch-\d+-(\d+)\.log", logp.name)
            if m is None or type(consumed) is not int:
                return False
            launched_at = int(m.group(1))
            def refused(msg: str) -> bool:   # only a fork/exec refusal (`[Errno N]`) proves no child existed
                found = re.search(r"\[Errno (\d+)\]", msg)
                return str(msg).startswith(self.START_FAILURE_PREFIX) and found is not None \
                    and int(found.group(1)) in NO_CHILD_ERRNOS
            return any(e["id"] > consumed and e["ts"] >= launched_at and refused(str(e["msg"]))
                       for e in self.store.batch_events(b["id"]))
        except (OSError, KeyError, TypeError):
            return False

    def _stage2_repair_mark_start_failed(self, b) -> None:
        """Durably record that the reserved launch raised before a worker existed (see `_spawn_never_started`)."""
        try:
            state = self._stage2_repair_state(b, required=True)
            current = state.get("current")
            attempts = current.get("attempt_log") if isinstance(current, dict) else None
            last = attempts[-1] if isinstance(attempts, list) and attempts else None
            if isinstance(last, dict) and last.get("status") == "launched" and isinstance(last.get("spawn"), dict):
                last["spawn"]["start_failed"] = True
                self._save_stage2_repair_state(b, state)
        except Exception:
            pass   # without the marker the recovery stays fail-closed

    def _stage2_repair_input_rejected(self, run, attempt: dict, current: dict) -> bool:
        """True only with proof that this run's turn/start rejected the prompt as `input_too_large` before any work,
        and that the recorded page is larger than the budgeted page a relaunch would use (so a relaunch makes progress)."""
        try:
            logp = Path(str(run["log_file"]))
            if not logp.is_file() or logp.stat().st_size > 65_536:
                return False
            text = logp.read_text(encoding="utf-8", errors="replace")
            if '"input_error_code":"input_too_large"' not in text or "turn/start" not in text \
                    or '"type":"item.' in text or '"type":"turn.completed"' in text:
                return False
            groups, cursor = current.get("groups"), current.get("cursor")
            if not isinstance(groups, list) or type(cursor) is not int or not 0 <= cursor < len(groups):
                return False
            budgeted = sorted({key for group in stage2.repair_page(groups, cursor) for key in group.get("candidate_keys", [])})
            return bool(budgeted) and attempt.get("target_keys") != budgeted \
                and set(budgeted) < set(attempt.get("target_keys") or [])
        except (OSError, KeyError, TypeError, AttributeError):
            return False

    def _stage2_repair_recover_launched(self, b, state: dict, current: dict) -> bool:
        """Settle a `launched` attempt left by a restart: attach, judge a finished run, or re-run a never-started one.

        True when this call already handled the batch; False when a fresh launch may proceed."""
        attempts = current.get("attempt_log")
        attempt = attempts[-1] if isinstance(attempts, list) and attempts else None
        if not isinstance(attempt, dict) or attempt.get("status") != "launched" or "prior_run_id" not in attempt:
            return False
        if attempt.get("fingerprint") != current.get("fingerprint") or attempt.get("cursor") != current.get("cursor"):
            return False
        ad = self._adapter(b["producer"])
        prior_run_id = attempt.get("prior_run_id")
        if type(prior_run_id) is not int or prior_run_id < 0:
            self._fail(b, "ERROR", "Stage 2 repair launch has no valid prior-run boundary; preserving all evidence")
            return True
        newer = [run for run in self.store.runs(b["id"])
                 if run["kind"] == "s2_repair_new" and run["id"] > prior_run_id]
        if len(newer) > 1:
            self._fail(b, "ERROR", "Stage 2 repair launch matches multiple newer runs; preserving all evidence")
            return True
        if not newer:
            if b["pid"] is not None and ad.alive(b["pid"]):
                return True   # the process may be between spawn and its durable run row
            if b["pid"] is not None:
                self._fail(b, "ERROR", "Stage 2 repair attempt has a process but no recorded run; preserving all evidence")
                return True
            spawn = attempt.get("spawn")
            if not isinstance(spawn, dict) or not self._spawn_never_started(b, spawn, attempt, current):
                self._fail(b, "ERROR", "Stage 2 repair attempt has no recorded run, but its launch may have started a "
                           "process (log/exit files exist or the launch binding is missing); not re-running, preserving all evidence")
                return True
            # reserved but never started: drop the stale reservation and let the caller launch the same request once
            attempts.pop()
            current["attempts"] = max(0, current.get("attempts", 1) - 1)
            events = self.store.batch_events(b["id"])
            current["start_failure_consumed_event"] = max([e["id"] for e in events], default=0)
            self._save_stage2_repair_state(b, state)
            return False
        run = newer[0]
        spawn = attempt.get("spawn")
        if not isinstance(spawn, dict) or not isinstance(spawn.get("log_file"), str) \
                or not isinstance(spawn.get("exit_file"), str) \
                or str(run["log_file"]) != spawn["log_file"] \
                or str(run["exit_file"]) != spawn["exit_file"] \
                or str(run["log_file"]) != str(b["log_file"]) \
                or str(run["exit_file"]) != str(b["exit_file"]) \
                or (attempt.get("run_id") is not None and attempt.get("run_id") != run["id"]) \
                or (b["pid"] is not None and run["pid"] != b["pid"]):
            self._fail(b, "ERROR", "Stage 2 repair run does not match its exact persisted launch binding; preserving all evidence")
            return True
        if attempt.get("run_id") is None:
            attempt["run_id"] = run["id"]
            self._save_stage2_repair_state(b, state)
        if b["pid"] is not None and ad.alive(b["pid"]):
            return True   # run identity is now durable; the poll loop re-attaches without a second run
        if run["ended_at"] is None:
            code = ad.exit_code(Path(b["exit_file"])) if b["exit_file"] else None
            if code is None:
                self._fail(b, "ERROR", "Stage 2 repair run has no recorded end or exit status; preserving all evidence")
                return True
            self.store.update(b["id"], pid=None)
            self.store.finish_runs(b["id"], code)
            run = next(row for row in self.store.runs(b["id"]) if row["id"] == run["id"])
        if str(run["exit_status"]) != "0":
            # An explicit operator Retry authorizes another execution after a usage limit.  Keep the
            # failed run in the ledger, but release its page reservation only if the checkpoint and
            # exact launch binding still match.  A restart without Retry must never relaunch it.
            try:
                override = int(self.store.get(usage_limit_override_key(b["id"])) or 0)
                baseline = json.loads(self.store.get(stage2.repair_run_start_key(b["id"])) or "{}")
                bb, pp = stage2.split_key(b["batch"])
                cp = Path(b["worktree"]) / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.json"
                retry_limit = (override >= run["id"] and self._classify_run(b["producer"], run["log_file"]) == "usage_limit"
                               and baseline.get("branch") == b["branch"] and baseline.get("worktree") == str(b["worktree"])
                               and baseline.get("fingerprint") == attempt.get("fingerprint")
                               and baseline.get("cursor") == attempt.get("cursor")
                               and baseline.get("attempt") == attempt.get("attempt")
                               and baseline.get("page_keys") == attempt.get("target_keys")
                               and baseline.get("checkpoint_sha256") == hashlib.sha256(cp.read_bytes()).hexdigest())
            except (OSError, ValueError, TypeError, KeyError):
                retry_limit = False
            if retry_limit:
                current.setdefault("interrupted_runs", []).append(attempt.copy())
                attempts.pop()
                current["attempts"] = max(0, current.get("attempts", 1) - 1)
                self._save_stage2_repair_state(b, state)
                self.store.log(b["id"], "Stage 2 repair 사용량 한도 실행을 보존하고 운영자 Retry로 같은 페이지를 재개합니다", "warn")
                return False
            if self._stage2_repair_input_rejected(run, attempt, current):
                # turn/start refused the oversized page before any model work: drop that attempt so the caller
                # relaunches the same cursor with the size-budgeted page (guaranteed to be a different, smaller page)
                attempts.pop()
                current["attempts"] = max(0, current.get("attempts", 1) - 1)
                if self._stage2_repair_correction(current) is not None:
                    # a correction re-asks its rejected page and would keep that oversized boundary; its accepted rows
                    # cover the whole old page, so it cannot be re-scoped to a smaller one. Drop the correction (the
                    # rejected attempt stays in attempt_log as evidence) and ask the cursor again as a fresh budgeted page.
                    for key in ("schema_repair", "response_correction", "last_response", "last_error"):
                        current.pop(key, None)
                self._save_stage2_repair_state(b, state)
                self.store.log(b["id"], "Stage 2 repair 입력이 turn/start 크기 상한을 넘어 거부됨 — 작업 없이 거부된 attempt를 폐기하고 "
                               "크기 상한 page로 다시 시작합니다", "warn")
                return False
            self._fail(b, "ERROR", f"Stage 2 repair run ended with exit {run['exit_status']}; preserving all evidence")
            return True
        self.store.log(b["id"], "Stage 2 repair run already finished before the restart; judging its saved output without re-running", "warn")
        self._run_ok_stage2_repair(self.store.batch(b["id"]))
        return True

    @_single_launch_scope
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
            handled = self._stage2_repair_recover_launched(b, state, current)
            if handled:
                return
            if self._stage2_repair_noncandidate_attempts(current) >= stage2.REPAIR_ATTEMPTS_PER_PAGE:
                return self._fail(b, "ERROR", "Stage 2 repair response retry limit reached; saved checkpoint and round evidence are preserved")
            page = self._stage2_repair_launch_page(current)
            page_keys = sorted({key for group in page for key in group.get("candidate_keys", [])})
            if not page_keys:
                return self._fail(b, "ERROR", "Stage 2 repair page has no target candidates")
            correction = self._stage2_repair_correction(current)
            if correction is not None:
                if not isinstance(correction, dict) \
                        or correction.get("fingerprint") != current.get("fingerprint") \
                        or correction.get("page_keys") != page_keys \
                        or not isinstance(correction.get("requested_keys"), list) \
                        or not (correction["requested_keys"] or correction.get("requested_peer_keys")) \
                        or correction["requested_keys"] != sorted(set(correction["requested_keys"])) \
                        or any(key not in page_keys for key in correction["requested_keys"]) \
                        or not re.fullmatch(r"[a-f0-9]{64}", correction.get("response_sha256", "")) \
                        or hashlib.sha256((current.get("last_response") or "").encode("utf-8")).hexdigest() \
                        != correction.get("response_sha256"):
                    return self._fail(b, "ERROR", "Stage 2 repair correction evidence does not match the active page; preserving all evidence")
                if "response_correction" in current:
                    attempts = current.get("attempt_log")
                    previous = attempts[-1] if isinstance(attempts, list) and attempts else None
                    if not isinstance(previous, dict) or previous.get("status") != "rejected" \
                            or previous.get("fingerprint") != current.get("fingerprint") \
                            or previous.get("cursor") != cursor or previous.get("target_keys") != page_keys \
                            or previous.get("attempt") != correction.get("source_attempt") \
                            or previous.get("run_id") != correction.get("source_run_id") \
                            or previous.get("response_sha256") != correction.get("response_sha256") \
                            or (previous.get("reason_code") not in {"coverage", "schema"}
                                and not (previous.get("reason_code") in {"content", "unresolved"}
                                         and correction.get("source_replayed") is True)):
                        return self._fail(b, "ERROR", "Stage 2 repair correction is not bound to its rejected source attempt; preserving all evidence")
            current["attempts"] = current.get("attempts", 0) + 1
            current["page_keys"] = page_keys
            prior_run = self._last_run(b)
            attempt = {"cursor": cursor, "attempt": current["attempts"],
                       "fingerprint": current["fingerprint"], "target_keys": page_keys, "status": "launched",
                       "prior_run_id": prior_run["id"] if prior_run else 0}
            if correction is not None:
                attempt["correction_candidate_keys"] = correction["requested_keys"]
                attempt["correction_response_sha256"] = correction["response_sha256"]
                attempt["correction_kind"] = correction.get("kind", "schema")
                attempt["correction_problems"] = self._stage2_repair_correction_problems(correction)
                attempt["correction_peer_keys"] = correction.get("requested_peer_keys", [])
                if "response_correction" in current:
                    attempt["correction_source_attempt"] = correction["source_attempt"]
                    attempt["correction_source_run_id"] = correction["source_run_id"]
            current.setdefault("attempt_log", []).append(attempt)
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
                        "fingerprint": current["fingerprint"], "cursor": cursor, "page_keys": page_keys,
                        "attempt": current["attempts"],
                        "correction_candidate_keys": correction["requested_keys"] if correction else None,
                        "correction_response_sha256": correction.get("response_sha256") if correction else None}
            self.store.set(stage2.repair_run_start_key(b["id"]), json.dumps(baseline, sort_keys=True))
            return self._launch(self.store.batch(b["id"]), "s2_repair_new")
        except TRANSIENT:
            raise
        except (OSError, ValueError, KeyError, TypeError, GitError) as error:
            return self._fail(b, "ERROR", f"Stage 2 repair page 준비 실패: {error}. worktree와 checkpoint를 보존합니다.")

    def _stage2_repair_launch_page(self, current: dict) -> list:
        """Page for the next launch: a correction re-asks its rejected attempt's page (recorded boundary);
        every other launch is a new page and gets the size budget."""
        log, cursor = current.get("attempt_log"), current["cursor"]
        previous = log[-1] if isinstance(log, list) and log and isinstance(log[-1], dict) else {}
        recorded = previous.get("target_keys") if previous.get("status") == "rejected" \
            and previous.get("cursor") == cursor and self._stage2_repair_correction(current) is not None else None
        return stage2.repair_page(current["groups"], cursor, recorded)

    @staticmethod
    def _stage2_repair_active_page(current: dict) -> list:
        """The active page; an already launched attempt keeps the boundary recorded in its target_keys."""
        log = current.get("attempt_log")
        last = log[-1] if isinstance(log, list) and log and isinstance(log[-1], dict) else {}
        recorded = last.get("target_keys") if last.get("cursor") == current["cursor"] else None
        return stage2.repair_page(current["groups"], current["cursor"], recorded)

    def _stage2_repair_prompt_input(self, current: dict, page: list, page_keys: list[str]) -> dict:
        """Render only the active page, or only its persisted correction candidates."""
        correction = self._stage2_repair_correction(current)
        selected_keys = set(correction["requested_keys"]) if isinstance(correction, dict) else set(page_keys)
        prompt_groups = []
        for group in page:
            candidates = []
            for candidate in group.get("candidates", []):
                key = f"{candidate['source_sense_id']}\u0000{candidate['candidate']}"
                if key not in selected_keys:
                    continue
                if candidate.get("already_accounted") is True:
                    required_fields = ["source_sense_id", "candidate", "additional_relations"]
                    forbidden_fields = ["decision"]
                else:
                    required_fields = ["source_sense_id", "candidate", "decision"]
                    forbidden_fields = ["additional_relations"]
                candidates.append({**candidate, "required_output_fields": required_fields,
                                   "forbidden_output_fields": forbidden_fields})
            if candidates:
                prompt_groups.append({**group,
                    "candidate_keys": sorted(f"{row['source_sense_id']}\u0000{row['candidate']}" for row in candidates),
                    "candidates": candidates})
        prompt_keys = {key for group in prompt_groups for key in group["candidate_keys"]}
        peer_keys = set(correction.get("requested_peer_keys", [])) if isinstance(correction, dict) else set()
        peers = [peer for group in page for candidate in group.get("candidates", [])
                 for peer in candidate.get("same_group_peers", [])
                 if f"{peer['source_sense_id']}\u0000{peer['candidate']}" in peer_keys]
        if prompt_keys != selected_keys:
            raise ValueError("Stage 2 repair prompt candidate keys differ from its persisted page/correction scope")
        if correction is None:
            return {"groups": prompt_groups}
        diagnostics = [{key: row[key] for key in ("candidate_key", "code", "required_fields", "actual_fields",
                                                  "field_path", "condition", "message") if key in row}
                       for row in correction.get("diagnostics", [])]
        payload = {"repair_correction": {"kind": correction.get("kind", "schema"),
                                         "candidate_keys": sorted(selected_keys), "diagnostics": diagnostics},
                   "groups": prompt_groups}
        if peer_keys:
            payload["repair_correction"]["peer_keys"] = sorted(peer_keys)
            payload["repair_correction"]["peers"] = peers
            payload["repair_correction"]["accepted_decisions"] = [
                row for row in correction.get("accepted_answer", {}).get("decisions", [])
                if row.get("source_sense_id") in {peer["source_sense_id"] for peer in peers}]
        return payload

    def _stage2_repair_response_run(self, b, state: dict):
        """Resolve the response only from the exact completed run recorded for this active page attempt."""
        current = state.get("current")
        attempts = current.get("attempt_log")
        attempt = attempts[-1] if isinstance(attempts, list) and attempts else None
        groups, cursor = current.get("groups"), current.get("cursor")
        if not isinstance(attempt, dict) or attempt.get("status") != "launched" \
                or not isinstance(groups, list) or type(cursor) is not int or not 0 <= cursor < len(groups):
            raise ValueError("repair response has no active persisted page attempt")
        page = stage2.repair_page(groups, cursor, attempt.get("target_keys"))
        page_keys = sorted({key for group in page if isinstance(group, dict)
                            for key in group.get("candidate_keys", [])})
        if not page_keys or attempt.get("fingerprint") != current.get("fingerprint") \
                or attempt.get("cursor") != cursor or attempt.get("target_keys") != page_keys:
            raise ValueError("repair response attempt does not bind the active fingerprint, page, and run")
        try:
            baseline = json.loads(self.store.get(stage2.repair_run_start_key(b["id"])) or "")
        except (TypeError, ValueError) as error:
            raise ValueError("repair response has no valid persisted run-start boundary") from error
        if not isinstance(baseline, dict) or baseline.get("branch") != b["branch"] \
                or baseline.get("worktree") != str(b["worktree"]) \
                or baseline.get("fingerprint") != current.get("fingerprint") \
                or baseline.get("cursor") != cursor or baseline.get("page_keys") != page_keys \
                or baseline.get("attempt") != attempt.get("attempt"):
            raise ValueError("repair response does not match its persisted Supervisor page/run-start boundary")
        runs = self.store.runs(b["id"])
        run_id = attempt.get("run_id")
        if run_id is None:
            prior_run_id = attempt.get("prior_run_id")
            spawn = attempt.get("spawn")
            if type(prior_run_id) is not int or prior_run_id < 0 or not isinstance(spawn, dict) \
                    or not isinstance(spawn.get("log_file"), str) or not isinstance(spawn.get("exit_file"), str):
                raise ValueError("repair response has no recoverable persisted run identity")
            candidates = [row for row in runs if row["kind"] == "s2_repair_new" and row["id"] > prior_run_id]
            if len(candidates) != 1 or str(candidates[0]["log_file"]) != spawn["log_file"] \
                    or str(candidates[0]["exit_file"]) != spawn["exit_file"]:
                raise ValueError("repair response cannot be rebound to one exact launched run")
            run = candidates[0]
            attempt["run_id"] = run["id"]
            self._save_stage2_repair_state(b, state)
        else:
            if type(run_id) is not int:
                raise ValueError("repair response attempt has a malformed run ID")
            run = next((row for row in runs if row["id"] == run_id), None)
        if run is None or run["kind"] != "s2_repair_new" or run["ended_at"] is None \
                or str(run["exit_status"]) != "0" or not run["log_file"] \
                or str(run["log_file"]) != str(b["log_file"]):
            raise ValueError("repair response does not belong to its exact completed run")
        if attempt.get("run_exit_status") not in (None, "0") \
                or attempt.get("run_ended_at") not in (None, run["ended_at"]):
            raise ValueError("repair response run completion differs from its saved attempt")
        return run

    def _stage2_repair_response(self, b, state: dict) -> dict | None:
        current = state["current"]
        if current.get("pending_answer") is not None:
            return current["pending_answer"]
        run = self._stage2_repair_response_run(b, state)
        final = self._adapter(b["producer"]).final_answer(Path(run["log_file"]))
        current["last_response"] = final
        self._save_stage2_repair_state(b, state)
        if final is None:
            current["last_error"] = "repair run produced no complete final response"
            self._save_stage2_repair_state(b, state)
            return None
        try:
            answer = self._stage2_repair_validate_response(b, state, final)
        except stage2.RepairFormatError as error:
            current["last_error"] = str(error)
            self._stage2_repair_mark_rejected(b, state, final, error, "format")
            return None
        except Stage2RepairSchemaError as error:
            current["last_error"] = str(error)
            self._stage2_repair_mark_rejected(b, state, final, error, "schema")
            raise
        except Stage2RepairUnresolvedError as error:
            current["last_error"] = str(error)
            self._stage2_repair_mark_rejected(b, state, final, error, "unresolved")
            raise
        except Stage2RepairMissingCandidatesError as error:
            current["last_error"] = str(error)
            attempts = current.get("attempt_log")
            ran_correction = bool(attempts) and isinstance(attempts[-1], dict) and "correction_response_sha256" in attempts[-1]
            self._stage2_repair_mark_rejected(b, state, final, error, "schema" if ran_correction else "coverage")
            raise
        except Stage2RepairContentError as error:
            current["last_error"] = str(error)
            self._stage2_repair_mark_rejected(b, state, final, error, "content")
            raise
        if answer is None:
            current["last_error"] = (
                "repair response has a header that does not match the active legacy contract; return the JSON object without a header"
                if isinstance(final, str) and any(line.strip().startswith("repair @") for line in final.splitlines())
                else "repair response must be one JSON object without prose or a header"
            )
            error = ValueError(current["last_error"])
            self._stage2_repair_mark_rejected(b, state, final, error, "format")
            return None
        return answer

    def _stage2_repair_refresh_stale_unresolved_round(self, b, state: dict) -> bool:
        """Retry of an `unresolved` rejection whose preflight basis has since changed (for example a shared validator fix).

        An unresolved answer that no correction can absorb is never replayable, so after a validator fix the Part would
        stay stuck on the old diagnostics. When nothing of the round was applied and the read-only preflight now has a
        different fingerprint, the saved page is stale: start a fresh bounded round from the current preflight.
        Earlier pages of the same round may already be applied (`applied_candidate_keys`): they are checkpoint facts the
        new preflight already reflects, so only an in-flight apply of the rejected page blocks the refresh.
        Returns True once this Retry was handled; False when the normal replay/launch path applies.
        """
        current = state.get("current")
        attempts = current.get("attempt_log") if isinstance(current, dict) else None
        attempt = attempts[-1] if isinstance(attempts, list) and attempts else None
        if not isinstance(attempt, dict) or attempt.get("status") != "rejected" or attempt.get("reason_code") != "unresolved" \
                or current.get("pending_answer") is not None \
                or current.get("apply_intent") is not None or current.get("duplicate_pair_fallback") is not None:
            return False
        bb, pp = stage2.split_key(b["batch"])
        report = self.git.stage2_preflight(Path(b["worktree"]), b["shard"], bb, pp)
        if not isinstance(report, dict) or report.get("fingerprint") == current.get("fingerprint") \
                or report.get("ok") is not True and report.get("repairable") is not True:
            return False
        checkpoint = stage2.checkpoint(b["worktree"], b["shard"], b["batch"])
        if not self._stage2_preflight_repair(b, checkpoint, report):
            self._launch_stage2_next(self.store.batch(b["id"]))
        return True

    def _stage2_repair_replay_missing_response(self, b, state: dict) -> str | None:
        """On operator Retry, recover an old rejected missing-row response without rerunning the full page."""
        current = state.get("current")
        if not isinstance(current, dict) or current.get("pending_answer") is not None \
                or self._stage2_repair_correction(current) is not None:
            return None
        attempts = current.get("attempt_log")
        attempt = attempts[-1] if isinstance(attempts, list) and attempts else None
        error = current.get("last_error")
        if not isinstance(attempt, dict) or attempt.get("status") != "rejected" \
                or not isinstance(error, str) or not (
                    attempt.get("reason_code") == "content"
                    and error.startswith("repair response does not cover every requested candidate (")
                    or attempt.get("reason_code") == "unresolved" and error.startswith("unresolved:")):
            return None
        groups, cursor = current.get("groups"), current.get("cursor")
        if not isinstance(groups, list) or type(cursor) is not int or not 0 <= cursor < len(groups):
            return "Rejected Stage 2 repair response has no valid persisted page; preserving all evidence"
        page = stage2.repair_page(groups, cursor, attempt.get("target_keys"))
        page_keys = sorted({key for group in page for key in group.get("candidate_keys", [])})
        final = current.get("last_response")
        run_id = attempt.get("run_id")
        response_sha256 = hashlib.sha256(final.encode("utf-8")).hexdigest() if isinstance(final, str) else None
        run = next((row for row in self.store.runs(b["id"]) if row["id"] == run_id), None) if type(run_id) is int else None
        if run is None or attempt.get("fingerprint") != current.get("fingerprint") or attempt.get("cursor") != cursor \
                or attempt.get("target_keys") != page_keys or not page_keys \
                or response_sha256 is None or response_sha256 != attempt.get("response_sha256") \
                or attempt.get("rejection_version") != 1 \
                or attempt.get("run_exit_status") != "0" or attempt.get("run_ended_at") != run["ended_at"] \
                or hashlib.sha256(error.encode("utf-8")).hexdigest() != attempt.get("error_sha256") \
                or run["kind"] != "s2_repair_new" or run["ended_at"] is None \
                or str(run["exit_status"]) != "0" or str(run["log_file"]) != str(b["log_file"]) \
                or self._adapter(b["producer"]).final_answer(Path(run["log_file"])) != final:
            return "Rejected Stage 2 repair response cannot be rebound to its exact page, run, and output hash"
        try:
            answer = self._stage2_repair_validate_response(b, state, final)
            if answer is not None:
                return "Previously rejected Stage 2 repair response no longer reproduces its coverage failure"
            return "Previously rejected Stage 2 repair response has no complete output"
        except (Stage2RepairSchemaError, Stage2RepairMissingCandidatesError) as correction_error:
            correction = self._stage2_repair_correction(current)
            if not isinstance(correction, dict) or correction.get("kind") not in {"coverage", "schema_and_coverage", "problems"} \
                    or correction.get("requested_keys") != sorted(set(correction.get("requested_keys", []))):
                return f"Rejected Stage 2 repair response did not produce an exact missing-candidate scope: {correction_error}"
            correction["source_run_id"] = run_id
            correction["source_replayed"] = True
            self._save_stage2_repair_state(b, state)
            return None
        except (ValueError, KeyError, TypeError) as validation_error:
            return f"Rejected Stage 2 repair response failed revalidation; preserving all evidence: {validation_error}"

    def _stage2_repair_mark_answer_saved(self, b, state: dict, final: str) -> None:
        """Bind a validated pending answer to its exact completed repair run and output hash."""
        current = state.get("current")
        attempts = current.get("attempt_log") if isinstance(current, dict) else None
        if not isinstance(attempts, list) or not attempts or not isinstance(attempts[-1], dict) \
                or attempts[-1].get("status") != "answer_saved":
            raise ValueError("validated repair answer has no matching persisted attempt")
        run = self._last_run(b)
        attempt = attempts[-1]
        if run is None or run["kind"] != "s2_repair_new" or run["ended_at"] is None \
                or str(run["exit_status"]) != "0" \
                or attempt.get("run_id") not in (None, run["id"]) \
                or str(run["log_file"]) != str(b["log_file"]):
            raise ValueError("validated repair answer has no matching completed output run")
        attempt.update({
            "response_sha256": hashlib.sha256(final.encode("utf-8")).hexdigest(),
            "run_id": run["id"],
            "run_exit_status": str(run["exit_status"]),
            "run_ended_at": run["ended_at"],
        })
        correction = self._stage2_repair_correction(current)
        if correction is not None and correction.get("source_run_id") is None \
                and correction.get("source_attempt") == attempt.get("attempt"):
            correction["source_run_id"] = run["id"]

    def _stage2_repair_cli_input(self, current: dict, answer: dict) -> dict:
        """The one CLI repair input shared by `repair --check` and the apply call (the nonce is added by apply)."""
        page = self._stage2_repair_active_page(current)
        targets = {}
        for group in page:
            for candidate in group["candidates"]:
                targets[(candidate["source_sense_id"], candidate["candidate"])] = candidate
        changes = []
        fallback = []

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
                if row.get("supervisor_fallback") is not None:
                    fallback.append({"source_sense_id": key[0], "candidate": key[1], "evidence": row["supervisor_fallback"]})
        for row in answer["peer_adjustments"]:
            add_change((row["source_sense_id"], row["candidate"]), row["decision"], None)
        repair_input = {"version": 1, "fingerprint": current["fingerprint"],
                        "decisions": sorted(changes, key=lambda row: (row["source_sense_id"], row["candidate"]))}
        if fallback:
            repair_input["supervisor_fallback"] = sorted(fallback, key=lambda row: (row["source_sense_id"], row["candidate"]))
        return repair_input

    def _stage2_repair_check(self, b, current: dict, rows: list, peers: list) -> dict:
        """Run the read-only official check; candidate-local diagnostics come back, global failures raise."""
        repair_input = self._stage2_repair_cli_input(current, {"decisions": rows, "peer_adjustments": peers})
        result = self.git.stage2_repair(Path(b["worktree"]), b["shard"], *stage2.split_key(b["batch"]),
                                        repair_input, check=True)
        if not isinstance(result, dict) or not isinstance(result.get("ok"), bool) \
                or not isinstance(result.get("invalid_candidates"), list) \
                or (result["ok"] is False and not result["invalid_candidates"]) \
                or (result["ok"] is True and result["invalid_candidates"]):
            raise ValueError("official repair check returned an inconsistent result")
        for entry in result["invalid_candidates"]:
            if not isinstance(entry, dict) or not isinstance(entry.get("candidate_key"), str) \
                    or not isinstance(entry.get("problems"), list) or not entry["problems"] \
                    or any(not isinstance(problem, dict) or not isinstance(problem.get("field_path"), str)
                           or not isinstance(problem.get("condition"), str)
                           or not isinstance(problem.get("message"), str) for problem in entry["problems"]):
                raise ValueError("official repair check returned a malformed candidate diagnostic")
        return result

    def _stage2_repair_checkpoint_path(self, b) -> Path:
        bb, pp = stage2.split_key(b["batch"])
        return Path(b["worktree"]) / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.json"

    def _stage2_repair_binding(self, b, current: dict, answer: dict, final: str, check: dict | None) -> dict:
        """Bind a checked answer to the exact response, CLI input and checkpoint it was checked against."""
        repair_input = self._stage2_repair_cli_input(current, answer)
        return {"response_sha256": hashlib.sha256(final.encode("utf-8")).hexdigest(),
                "cli_input_sha256": hashlib.sha256(json.dumps(
                    repair_input, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")).hexdigest(),
                "checkpoint_sha256": hashlib.sha256(self._stage2_repair_checkpoint_path(b).read_bytes()).hexdigest(),
                "check_request_id": (check or {}).get("request_id")}

    @staticmethod
    def _stage2_repair_correction_problems(correction: dict) -> list[dict]:
        """The `(candidate_key, field_path, condition)` problems a correction asked for (legacy: derived)."""
        problems = correction.get("problems")
        if isinstance(problems, list):
            return [{"candidate_key": row["candidate_key"], "field_path": row["field_path"], "condition": row["condition"]}
                    for row in problems if isinstance(row, dict)]
        if correction.get("kind") == "coverage":
            return [{"candidate_key": key, "field_path": "row", "condition": "required"}
                    for key in correction.get("requested_keys", [])]
        return [{"candidate_key": key, "field_path": "row", "condition": "legacy"}
                for key in correction.get("requested_keys", [])]

    @staticmethod
    def _stage2_repair_requested_problems(current: dict) -> dict:
        """Cumulative problems already requested on this page: `(key, field_path, condition)` → requesting attempt."""
        out = {}
        for attempt in current.get("attempt_log", []):
            if not isinstance(attempt, dict) or attempt.get("cursor") != current.get("cursor") \
                    or attempt.get("fingerprint") != current.get("fingerprint"):
                continue
            problems = attempt.get("correction_problems")
            if problems is None and attempt.get("correction_kind") == "coverage" \
                    and "correction_source_attempt" in attempt:
                problems = [{"candidate_key": key, "field_path": "row", "condition": "required"}
                            for key in attempt.get("correction_candidate_keys", [])]
            for problem in problems or []:
                out[(problem["candidate_key"], problem["field_path"], problem["condition"])] = attempt
        return out

    @staticmethod
    def _stage2_repair_noncandidate_attempts(current: dict) -> int:
        """Attempts on this page that made no candidate-local progress (the retry budget's unit)."""
        count = 0
        for attempt in current.get("attempt_log", []):
            if not isinstance(attempt, dict) or attempt.get("cursor") != current.get("cursor") \
                    or attempt.get("fingerprint") != current.get("fingerprint"):
                continue
            if attempt.get("status") in {"answer_saved", "applied"} \
                    or (attempt.get("status") == "rejected" and attempt.get("reason_code") in {"schema", "coverage"}):
                continue
            count += 1
        return count

    def _stage2_repair_fallback_evidence(self, b, current: dict, final: str, problem: dict, current_row: dict | None) -> dict | None:
        """Prove that the exact problem was requested by a completed correction run; None if anything is missing."""
        attempt = self._stage2_repair_requested_problems(current).get(
            (problem["candidate_key"], problem["field_path"], problem["condition"]))
        attempts = current.get("attempt_log") or []
        if attempt is None or not attempts:
            return None
        runs_by_id = {run["id"]: run for run in self.store.runs(b["id"])}
        if attempt is attempts[-1] and attempt.get("status") == "launched":
            run = self._last_run(b)    # the correction run whose response is being validated right now
            if run is None or run["kind"] != "s2_repair_new" or run["ended_at"] is None or str(run["exit_status"]) != "0" \
                    or str(run["log_file"]) != str(b["log_file"]) or attempt.get("run_id") not in (None, run["id"]):
                return None
            run_id, response_sha256 = run["id"], hashlib.sha256(final.encode("utf-8")).hexdigest()
        else:
            if attempt.get("status") != "rejected" or attempt.get("rejection_version") != 1 \
                    or self._stage2_repair_explicit_rejection_problem(b, current["fingerprint"], attempt, runs_by_id) is not None:
                return None
            run_id, response_sha256 = attempt["run_id"], attempt["response_sha256"]
        return {"prior_request": {"attempt": attempt["attempt"], "run_id": run_id, "response_sha256": response_sha256,
                                  "problem": {"field_path": problem["field_path"], "condition": problem["condition"]}},
                "current_row": current_row}

    def _stage2_repair_validate_response(self, b, state: dict, final: str) -> dict | None:
        current = state["current"]
        answer = stage2.extract_repair_answer(final, current["fingerprint"])
        if answer is None:
            return None
        page = self._stage2_repair_active_page(current)
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
        correction = self._stage2_repair_correction(current)
        page_keys = sorted(f"{sense_id}\u0000{candidate}" for sense_id, candidate in required)
        if correction is None:
            response_keys = set(required)
            accepted_rows, accepted_peers = [], []
        else:
            if not isinstance(correction, dict) or correction.get("fingerprint") != current["fingerprint"] \
                    or correction.get("page_keys") != page_keys:
                raise ValueError("repair-correction evidence is stale or belongs to another repair page")
            requested_keys = correction.get("requested_keys")
            accepted = correction.get("accepted_answer")
            requested_peer_keys = correction.get("requested_peer_keys", [])
            if not isinstance(requested_keys, list) or not (requested_keys or requested_peer_keys) or any(
                    not isinstance(key, str) or key.count("\u0000") != 1 for key in requested_keys) \
                    or len(set(requested_keys)) != len(requested_keys):
                raise ValueError("repair-correction candidate keys are malformed")
            response_keys = {tuple(key.split("\u0000", 1)) for key in requested_keys}
            if not response_keys.issubset(set(required)) or not isinstance(accepted, dict) \
                    or not isinstance(accepted.get("decisions"), list) \
                    or not isinstance(accepted.get("peer_adjustments"), list):
                raise ValueError("repair-correction answer evidence is malformed")
            accepted_rows = accepted["decisions"]
            accepted_peers = accepted["peer_adjustments"]
            accepted_keys = {(row.get("source_sense_id"), row.get("candidate")) for row in accepted_rows
                             if isinstance(row, dict)}
            if len(accepted_keys) != len(accepted_rows) or accepted_keys & response_keys \
                    or accepted_keys | response_keys != set(required):
                raise ValueError("repair-correction evidence does not cover the unchanged page exactly once")
        seen = set()
        valid_direct_rows = []
        schema_diagnostics = []
        for row in direct_rows:
            if not isinstance(row, dict) or not isinstance(row.get("source_sense_id"), str) or not isinstance(row.get("candidate"), str):
                raise Stage2RepairContentError("repair decision needs an exact source_sense_id/candidate key")
            key = (row["source_sense_id"], row["candidate"])
            if key not in required or key not in response_keys or key in seen:
                raise Stage2RepairContentError("repair response contains a duplicate or out-of-page candidate")
            candidate = required[key]
            if candidate["already_accounted"]:
                required_fields = {"source_sense_id", "candidate", "additional_relations"}
                if set(row) != required_fields:
                    schema_diagnostics.append({"candidate_key": f"{key[0]}\u0000{key[1]}",
                        "code": "already_accounted_fields_mismatch", "required_fields": sorted(required_fields),
                        "actual_fields": sorted(row)})
                elif not isinstance(row["additional_relations"], list):
                    schema_diagnostics.append({"candidate_key": f"{key[0]}\u0000{key[1]}",
                        "code": "additional_relations_not_array", "required_fields": sorted(required_fields),
                        "actual_fields": sorted(row)})
                else:
                    valid_direct_rows.append(row)
            else:
                required_fields = {"source_sense_id", "candidate", "decision"}
                if set(row) != required_fields:
                    schema_diagnostics.append({"candidate_key": f"{key[0]}\u0000{key[1]}",
                        "code": "ordinary_candidate_fields_mismatch", "required_fields": sorted(required_fields),
                        "actual_fields": sorted(row)})
                elif not isinstance(row["decision"], dict):
                    schema_diagnostics.append({"candidate_key": f"{key[0]}\u0000{key[1]}",
                        "code": "decision_not_object", "required_fields": sorted(required_fields),
                        "actual_fields": sorted(row)})
                else:
                    valid_direct_rows.append(row)
            seen.add(key)
        unresolved_for_correction = []
        unresolved_seen = set()
        for row in unresolved_rows:
            if not isinstance(row, dict) or set(row) != {"source_sense_id", "candidate", "reason"} \
                    or not isinstance(row.get("reason"), str) or not row["reason"].strip():
                raise Stage2RepairContentError("unresolved repair items need an exact candidate key and reason")
            key = (row["source_sense_id"], row["candidate"])
            if key not in required or key not in response_keys or key in seen or key in unresolved_seen:
                raise Stage2RepairContentError("unresolved response contains a duplicate or out-of-page candidate")
            unresolved_seen.add(key)
            group = next(group for group in page if key in {
                (candidate["source_sense_id"], candidate["candidate"]) for candidate in group.get("candidates", [])})
            if correction is None and not required[key]["already_accounted"] and any(
                    conflict.get("code") == "id-pair-conflict" for conflict in group.get("conflicts", [])):
                unresolved_for_correction.append(row)
            else:
                seen.add(key)
        if len(unresolved_for_correction) != len(unresolved_rows):
            current["last_error"] = "unresolved: " + "; ".join(
                f"{row['source_sense_id']}/{row['candidate']}: {row['reason']}" for row in unresolved_rows[:8])
            raise Stage2RepairUnresolvedError(current["last_error"])
        requested_peer_keys = correction.get("requested_peer_keys", []) if correction is not None else []
        if correction is not None and (unresolved_rows or any(
                not isinstance(row, dict) or f"{row.get('source_sense_id')}\u0000{row.get('candidate')}" not in requested_peer_keys
                for row in peer_rows)):
            raise Stage2RepairContentError("repair-correction response may contain only the requested candidate and peer rows")
        unresolved_keys = {(row["source_sense_id"], row["candidate"]) for row in unresolved_for_correction}
        missing = sorted(response_keys - seen - unresolved_keys)

        def affected_for(rows):
            affected = {}
            for row in rows:
                candidate = required[(row["source_sense_id"], row["candidate"])]
                previous = candidate.get("decision") or {}
                changed = row.get("decision", {}).get("type") if isinstance(row.get("decision"), dict) else None
                if changed and previous.get("type") != changed:
                    types = affected.setdefault(row["source_sense_id"], set())
                    if previous.get("disposition") == "relation" and previous.get("type"):
                        types.add(previous["type"])
                    types.add(changed)
            return affected

        affected_types = affected_for(list(accepted_rows) + list(valid_direct_rows))
        normalized_peers = set()
        for row in peer_rows:
            if not isinstance(row, dict) or set(row) != {"source_sense_id", "candidate", "decision"} \
                    or not isinstance(row.get("decision"), dict):
                raise Stage2RepairContentError("peer adjustments need an exact candidate key and complete decision")
            key = (row["source_sense_id"], row["candidate"])
            peer = allowed_peers.get(key)
            if peer is None or key in required or key in normalized_peers or row["source_sense_id"] not in affected_types \
                    or peer["decision"].get("type") not in affected_types[row["source_sense_id"]]:
                raise Stage2RepairContentError("peer adjustment is outside the directly affected same-source UI group")
            normalized_peers.add(key)

        key_text = lambda row: f"{row['source_sense_id']}\u0000{row['candidate']}"
        requested_texts = {f"{sense_id}\u0000{name}" for sense_id, name in response_keys}
        all_peers = list(accepted_peers if correction is not None else []) + list(peer_rows)
        peer_texts = {key_text(row) for row in all_peers}
        cli_rows = list(accepted_rows) + list(valid_direct_rows)

        peer_problem_texts = peer_texts | set(requested_peer_keys)

        def run_check(rows, peers):
            """The official CLI check over the composed answer: candidate-local and peer diagnostics."""
            result = self._stage2_repair_check(b, current, rows, peers)
            local = []
            for entry in result["invalid_candidates"]:
                key = entry["candidate_key"]
                if key not in requested_texts and key not in peer_problem_texts:
                    raise Stage2RepairContentError(
                        f"previously accepted repair row {key.replace(chr(0), '/')} no longer passes the official check")
                local.extend({"candidate_key": key, "field_path": problem["field_path"],
                              "condition": problem["condition"], "message": problem["message"], "source": "cli"}
                             for problem in entry["problems"])
            return result, local

        check, cli_problems = None, []
        if cli_rows:
            check, cli_problems = run_check(cli_rows, all_peers)

        problems = [{"candidate_key": row["candidate_key"], "field_path": "row", "condition": row["code"],
                     "message": row["code"], "source": "wrapper"} for row in schema_diagnostics]
        problems += [{"candidate_key": f"{sense_id}\u0000{name}", "field_path": "row", "condition": "required",
                      "message": "the candidate row is missing", "source": "missing"} for sense_id, name in missing]
        problems += [{"candidate_key": f"{row['source_sense_id']}\u0000{row['candidate']}",
                      "field_path": "decision", "condition": "independent_judgment",
                      "message": "Reconsider independent editorial value without assuming duplicate projection; "
                                 "if no supported decision resolves the conflict, remain unresolved. Previous reason: " + row["reason"],
                      "source": "semantic_contract"} for row in unresolved_for_correction]
        given_peer_texts = {key_text(row) for row in peer_rows}
        problems += [{"candidate_key": key, "field_path": "row", "condition": "required",
                      "message": "the peer adjustment row is missing", "source": "missing"}
                     for key in requested_peer_keys if key not in given_peer_texts]
        problems += cli_problems
        fallback_rows, fallback_keys, fallback_peer_keys = [], set(), set()
        if problems:
            history = self._stage2_repair_requested_problems(current)
            by_key = {}
            for problem in problems:
                by_key.setdefault(problem["candidate_key"], []).append(problem)
            repeated_by_key = {key: next((p for p in rows if (p["candidate_key"], p["field_path"], p["condition"]) in history), None)
                               for key, rows in by_key.items()}
            correction_keys = sorted(key for key, rep in repeated_by_key.items() if rep is None and key not in peer_problem_texts)
            correction_peer_keys = sorted(key for key, rep in repeated_by_key.items() if rep is None and key in peer_problem_texts)
            valid_by_key = {key_text(row): row for row in valid_direct_rows}
            peer_by_key = {key_text(row): row for row in peer_rows}
            for key, repeated in sorted(repeated_by_key.items()):
                if repeated is None:
                    continue
                is_peer = key in peer_problem_texts
                label = key.replace("\u0000", "/")
                if not is_peer and required[tuple(key.split("\u0000", 1))]["already_accounted"]:
                    raise Stage2RepairContentError(f"{label}: a repeated optional-link problem cannot use a technical fallback")
                source_row = peer_by_key.get(key) if is_peer else valid_by_key.get(key)
                if repeated["source"] == "missing":
                    current_row = None
                elif repeated["source"] == "cli" and source_row is not None:
                    current_row = {"source_sense_id": source_row["source_sense_id"],
                                   "candidate": source_row["candidate"], "decision": source_row["decision"]}
                else:
                    raise Stage2RepairContentError(f"{label}: {repeated['field_path']} [{repeated['condition']}] repeated but cannot be re-verified by the official CLI")
                evidence = self._stage2_repair_fallback_evidence(b, current, final, repeated, current_row)
                if evidence is None:
                    raise Stage2RepairContentError(f"{label}: a repeated problem lacks completed correction-run evidence; refusing technical fallback")
                source_sense_id, name = key.split("\u0000", 1)
                if is_peer:   # keep the stored peer decision; only the failing adjustment is excluded
                    fallback_peer_keys.add(key)
                    current.setdefault("peer_fallbacks", []).append({"candidate_key": key, "evidence": evidence})
                    continue
                fallback_rows.append({"source_sense_id": source_sense_id, "candidate": name,
                    "decision": {"source_sense_id": source_sense_id, "candidate": name, "disposition": "drop", "reason": "f"},
                    "supervisor_fallback": evidence})
                fallback_keys.add(key)
            correction_keys = [key for key in correction_keys if key not in fallback_keys]
            kept_rows = [row for row in cli_rows if key_text(row) not in fallback_keys and key_text(row) not in correction_keys]
            kept_peers = [row for row in all_peers if key_text(row) not in correction_peer_keys
                          and key_text(row) not in fallback_peer_keys]
            if correction_keys or correction_peer_keys:
                requested = [p for p in problems if p["candidate_key"] in correction_keys or p["candidate_key"] in correction_peer_keys]
                wrapper_requested = [p for p in requested if p["source"] == "wrapper"]
                missing_requested = [p for p in requested if p["source"] == "missing"]
                if any(p["source"] in {"cli", "semantic_contract"} for p in requested) or correction_peer_keys:
                    correction_kind = "problems"
                elif wrapper_requested and missing_requested:
                    correction_kind = "schema_and_coverage"
                elif wrapper_requested:
                    correction_kind = "schema"
                else:
                    correction_kind = "coverage"
                diagnostics = []
                for problem in requested:
                    if problem["source"] in {"cli", "semantic_contract"}:
                        diagnostics.append({"candidate_key": problem["candidate_key"],
                            "code": "cli_problem" if problem["source"] == "cli" else "independent_judgment",
                            "field_path": problem["field_path"], "condition": problem["condition"],
                            "message": problem["message"], "required_fields": [], "actual_fields": []})
                diagnostics += [row for row in schema_diagnostics if row["candidate_key"] in correction_keys]
                for problem in missing_requested:
                    if problem["candidate_key"] in correction_peer_keys:
                        diagnostics.append({"candidate_key": problem["candidate_key"], "code": "missing_peer_adjustment",
                            "required_fields": ["source_sense_id", "candidate", "decision"], "actual_fields": []})
                        continue
                    sense_id, name = problem["candidate_key"].split("\u0000", 1)
                    candidate_row = required[(sense_id, name)]
                    diagnostics.append({"candidate_key": problem["candidate_key"], "code": "missing_candidate",
                        "required_fields": (["source_sense_id", "candidate", "additional_relations"]
                                            if candidate_row["already_accounted"] else ["source_sense_id", "candidate", "decision"]),
                        "actual_fields": []})
                current["response_correction"] = {
                    "kind": correction_kind,
                    "fingerprint": current["fingerprint"], "page_keys": page_keys,
                    "requested_keys": correction_keys,
                    "requested_peer_keys": correction_peer_keys,
                    "response_sha256": hashlib.sha256(final.encode("utf-8")).hexdigest(),
                    "source_attempt": current.get("attempt_log", [{}])[-1].get("attempt"),
                    "source_run_id": None,
                    "problems": [{"candidate_key": p["candidate_key"], "field_path": p["field_path"],
                                  "condition": p["condition"]} for p in requested],
                    "diagnostics": diagnostics,
                    "accepted_answer": {"decisions": kept_rows + fallback_rows, "peer_adjustments": kept_peers},
                }
                current["last_error"] = f"repair response needs correction for {len(correction_keys) + len(correction_peer_keys)} candidate(s)"
                if correction_peer_keys or any(p["source"] != "missing" for p in requested):
                    raise Stage2RepairSchemaError(current["last_error"])
                raise Stage2RepairMissingCandidatesError(current["last_error"])
            # Every problem is a proven repeat: finish with the technical fallback and re-check the composed page.
            final_rows = kept_rows + fallback_rows
            affected = affected_for([row for row in final_rows if key_text(row) not in fallback_keys])
            all_peers = [row for row in kept_peers if row["source_sense_id"] in affected
                         and allowed_peers[(row["source_sense_id"], row["candidate"])]["decision"].get("type")
                         in affected[row["source_sense_id"]]]
            check, cli_problems = run_check(final_rows, all_peers)
            if cli_problems:
                raise Stage2RepairContentError("the technical-fallback page does not pass the official check; refusing to apply")
            answer["decisions"] = final_rows
            answer["peer_adjustments"] = all_peers
        else:
            answer["decisions"] = cli_rows
            answer["peer_adjustments"] = all_peers
        answer["unresolved"] = []
        current["pending_answer"] = answer
        if current.get("attempt_log"):
            current["attempt_log"][-1]["status"] = "answer_saved"
        self._stage2_repair_mark_answer_saved(b, state, final)
        current["pending_binding"] = self._stage2_repair_binding(b, current, answer, final, check)
        current.pop("last_error", None)
        self._save_stage2_repair_state(b, state)
        return answer

    def _stage2_repair_demote(self, b, state: dict, check: dict) -> None:
        """An unapplied pending answer no longer passes the official check: reject it and ask only the new problems."""
        current = state["current"]
        attempts = current.get("attempt_log")
        attempt = attempts[-1] if isinstance(attempts, list) and attempts else None
        if not isinstance(attempt, dict) or attempt.get("status") != "answer_saved":
            return self._fail(b, "ERROR", "pending Stage 2 repair answer fails the official check but has no demotable attempt; preserving evidence")
        keys = ", ".join(sorted(entry["candidate_key"].replace("\u0000", "/") for entry in check["invalid_candidates"])[:8])
        attempt["status"] = "launched"
        current["pending_answer"] = None
        current.pop("pending_binding", None)
        current.pop("apply_intent", None)
        self._save_stage2_repair_state(b, state)
        self.store.log(b["id"], f"Stage 2 repair pending answer failed the official check ({keys}); re-validating its saved response", "warn")
        return self._run_ok_stage2_repair(self.store.batch(b["id"]))

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
            page = self._stage2_repair_active_page(current)
            repair_input = self._stage2_repair_cli_input(current, answer)
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
            checkpoint_file = self._stage2_repair_checkpoint_path(b)
            receipts = json.loads(checkpoint_file.read_text("utf-8")).get("repair_receipts", [])
            receipt_proven = any(isinstance(receipt, dict) and receipt.get("supervisor_nonce") == intent["supervisor_nonce"]
                                 and receipt.get("fingerprint") == current["fingerprint"]
                                 and receipt.get("candidate_keys") == candidate_keys for receipt in receipts)
            binding = current.get("pending_binding")
            current_binding = self._stage2_repair_binding(b, current, answer, current.get("last_response") or "", None)
            if not receipt_proven and not (isinstance(binding, dict)
                    and binding.get("cli_input_sha256") == current_binding["cli_input_sha256"]
                    and binding.get("checkpoint_sha256") == current_binding["checkpoint_sha256"]):
                # Unbound (legacy) or changed inputs, and no successful receipt: the official check decides again.
                check = self._stage2_repair_check(b, current, answer["decisions"], answer["peer_adjustments"])
                if check["ok"] is not True:
                    return self._stage2_repair_demote(b, state, check)
                binding = {**current_binding, "check_request_id": check.get("request_id")}
                current["pending_binding"] = binding
                self._save_stage2_repair_state(b, state)
            repair_input["supervisor_nonce"] = intent["supervisor_nonce"]
            receipt = self.git.stage2_repair(Path(b["worktree"]), b["shard"], *stage2.split_key(b["batch"]), repair_input)
            if receipt.get("ok") is False:
                causes = []
                if isinstance(binding, dict) and binding.get("checkpoint_sha256") != current_binding["checkpoint_sha256"]:
                    causes.append("the checkpoint changed after the answer was checked")
                if isinstance(binding, dict) and binding.get("cli_input_sha256") != current_binding["cli_input_sha256"]:
                    causes.append("the regenerated CLI input differs from the checked input")
                return self._fail(b, "ERROR", "official repair CLI rejected an answer its check accepted ("
                                  + ("; ".join(causes) or "check and apply disagree with identical checkpoint and input")
                                  + "); response, checkpoint and receipts are preserved")
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
            current.pop("schema_repair", None)
            current.pop("response_correction", None)
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

    @staticmethod
    def _stage2_relation_projects_candidate(relation: dict, source_sense_id: str, candidate: str,
                                            target_senses: list | None = None) -> bool:
        """Whether one approved ID row already exposes this exact candidate from the requested Sense."""
        source = relation.get("source") if isinstance(relation, dict) else None
        target = relation.get("target") if isinstance(relation, dict) else None
        if not isinstance(source, dict) or not isinstance(target, dict):
            return False
        def orthographic_target(endpoint, record_id, sense_id):
            lemma = endpoint.get("lemma")
            if not isinstance(lemma, str) or not isinstance(target_senses, list):
                return False
            fold = lambda value: re.sub(r"[\s-]", "", value)
            return bool(fold(candidate)) and fold(candidate) == fold(lemma) and any(
                isinstance(row, dict) and row.get("record_id") == record_id
                and row.get("sense_id") == sense_id and row.get("lemma") == lemma
                for row in target_senses)

        if relation.get("source_sense_id") == source_sense_id:
            forms = relation.get("candidate_forms")
            return (candidate == target.get("lemma") or isinstance(forms, list) and candidate in forms
                    or orthographic_target(target, relation.get("target_record_id"), relation.get("target_sense_id")))
        if relation.get("target_sense_id") == source_sense_id:
            forms = relation.get("reverse_candidate_forms")
            return (candidate == source.get("lemma") or isinstance(forms, list) and candidate in forms
                    or orthographic_target(source, relation.get("source_record_id"), relation.get("source_sense_id")))
        return False

    @staticmethod
    def _stage2_repair_exact_pair(decision: dict, source_sense_id: str, target_record_id: str,
                                  target_sense_id: str) -> bool:
        return isinstance(decision, dict) and decision.get("disposition") == "relation" \
            and decision.get("target_resolution") == "exact" \
            and decision.get("source_sense_id") == source_sense_id \
            and decision.get("target_record_id") == target_record_id \
            and decision.get("target_sense_id") == target_sense_id

    @classmethod
    def _stage2_duplicate_pair_fallback_plan(cls, report: dict) -> dict | None:
        """Build only source-bound e/optional-link removals proven redundant by an existing ID pair."""
        if not isinstance(report, dict) or report.get("ok") is not False or report.get("repairable") is not True \
                or report.get("unclassified") or not isinstance(report.get("problems"), list) or not report["problems"]:
            return None
        fingerprint = report.get("fingerprint")
        if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            return None

        candidates: dict[str, dict] = {}
        for group in report["problems"]:
            if not isinstance(group, dict) or group.get("drop_gloss") or not isinstance(group.get("candidates"), list):
                return None
            for candidate in group["candidates"]:
                if not isinstance(candidate, dict) or not isinstance(candidate.get("source_sense_id"), str) \
                        or not isinstance(candidate.get("candidate"), str):
                    return None
                key = f"{candidate['source_sense_id']}\u0000{candidate['candidate']}"
                if key in candidates:
                    return None
                candidates[key] = candidate

        actions: dict[str, dict] = {}
        covered_pairs: set[tuple[str, str, str]] = set()
        for group in report["problems"]:
            conflicts = group.get("conflicts")
            if not isinstance(conflicts, list) or not conflicts:
                return None
            group_keys = set(group.get("candidate_keys", []))
            if any(key not in candidates for key in group_keys):
                return None
            for conflict in conflicts:
                if not isinstance(conflict, dict) or conflict.get("code") != "id-pair-conflict":
                    return None
                rows = conflict.get("relations")
                # Admission preflight exposes candidate identities on the enclosing group.
                conflict_keys = group_keys
                if not isinstance(rows, list) or len(rows) != 2 or not conflict_keys:
                    return None
                # collectMergeConflicts returns the already-approved row first and the proposed Part row second.
                existing, proposed = rows
                source_sense_id = proposed.get("source_sense_id") if isinstance(proposed, dict) else None
                target_sense_id = proposed.get("target_sense_id") if isinstance(proposed, dict) else None
                target_record_id = proposed.get("target_record_id") if isinstance(proposed, dict) else None
                existing_pair = (existing.get("source_sense_id"), existing.get("target_sense_id")) \
                    if isinstance(existing, dict) else (None, None)
                proposed_pair = (source_sense_id, target_sense_id)
                if not isinstance(source_sense_id, str) or not isinstance(target_sense_id, str) \
                        or not isinstance(target_record_id, str) or source_sense_id == target_sense_id \
                        or set(existing_pair) != set(proposed_pair):
                    return None
                proposed_forms = proposed.get("candidate_forms")
                if not isinstance(proposed_forms, list) or any(not isinstance(form, str) for form in proposed_forms):
                    return None
                proposed_target = proposed.get("target")
                target_lemma = proposed_target.get("lemma") if isinstance(proposed_target, dict) else None
                matched = 0
                for key in conflict_keys:
                    candidate = candidates.get(key)
                    if candidate is None:
                        return None
                    if key not in group_keys:
                        return None
                    if candidate["source_sense_id"] != source_sense_id \
                            or (candidate["candidate"] not in proposed_forms and candidate["candidate"] != target_lemma):
                        continue
                    if candidate.get("already_accounted") is True:
                        optional = candidate.get("additional_relations")
                        if not isinstance(optional, list):
                            continue
                        if not any(cls._stage2_repair_exact_pair(link, source_sense_id, target_record_id, target_sense_id)
                                   for link in optional):
                            continue
                        action = "remove-optional-pair"
                    elif candidate.get("already_accounted") is False:
                        if not cls._stage2_repair_exact_pair(candidate.get("decision"), source_sense_id,
                                                             target_record_id, target_sense_id):
                            continue
                        action = "drop-redundant-candidate"
                    else:
                        return None
                    if not cls._stage2_relation_projects_candidate(existing, source_sense_id, candidate["candidate"],
                                                                   candidate.get("target_senses")):
                        return None
                    prior = actions.get(key)
                    if prior is not None and prior["action"] != action:
                        return None
                    if prior is None:
                        prior = {"candidate": candidate, "action": action, "target_pairs": set()}
                        actions[key] = prior
                    prior["target_pairs"].add((target_record_id, target_sense_id))
                    covered_pairs.add((source_sense_id, target_record_id, target_sense_id))
                    matched += 1
                if matched == 0:
                    return None

        if not actions:
            return None
        decisions = []
        changes = []
        for key, action in sorted(actions.items()):
            candidate = action["candidate"]
            source_sense_id, candidate_text = candidate["source_sense_id"], candidate["candidate"]
            if action["action"] == "drop-redundant-candidate":
                decisions.append({
                    "source_sense_id": source_sense_id, "candidate": candidate_text,
                    "expected_decision": candidate.get("decision"),
                    "expected_additional_relations": candidate.get("additional_relations"),
                    "decision": {"source_sense_id": source_sense_id, "candidate": candidate_text,
                                 "disposition": "drop", "reason": "e"},
                    "additional_relations": None,
                })
            else:
                optional = candidate.get("additional_relations")
                if not isinstance(optional, list):
                    return None
                remaining = [link for link in optional
                             if (link.get("target_record_id"), link.get("target_sense_id")) not in action["target_pairs"]]
                if len(remaining) == len(optional):
                    return None
                decisions.append({
                    "source_sense_id": source_sense_id, "candidate": candidate_text,
                    "expected_decision": candidate.get("decision"),
                    "expected_additional_relations": optional,
                    "decision": None, "additional_relations": remaining,
                })
            changes.append({"candidate_key": key, "action": action["action"],
                            "target_sense_ids": sorted(sense_id for _record_id, sense_id in action["target_pairs"])})
        candidate_keys = sorted(actions)
        return {
            "repair_input": {"version": 1, "fingerprint": fingerprint, "decisions": decisions},
            "candidate_keys": candidate_keys,
            "covered_pairs": [list(pair) for pair in sorted(covered_pairs)],
            "changes": changes,
        }

    def _stage2_duplicate_pair_fallback_context(self, b, state: dict):
        wt = Path(b["worktree"])
        if self.git.registered(wt) != b["branch"]:
            raise ValueError("deterministic duplicate-pair fallback no longer owns the Part worktree")
        self.git.worktree_gitdir(wt)
        if self.git.dirty(wt).strip():
            raise ValueError("deterministic duplicate-pair fallback found tracked worktree changes")
        identity = state.get("identity", {})
        head = self.git.head(wt)
        remote_head = self.git.remote_head(b["branch"])
        if identity.get("base_head") != head or identity.get("remote_head") != remote_head:
            raise ValueError("deterministic duplicate-pair fallback Part identity changed")
        checkpoint = self._stage2_repair_checkpoint_path(b)
        return checkpoint, hashlib.sha256(checkpoint.read_bytes()).hexdigest(), head, remote_head

    def _stage2_duplicate_pair_fallback_has_receipt(self, b, fallback: dict) -> bool:
        checkpoint = self._stage2_repair_checkpoint_path(b)
        data = json.loads(checkpoint.read_text("utf-8"))
        if not isinstance(data, dict):
            return False
        receipts = data.get("repair_receipts", [])
        return isinstance(receipts, list) and any(
            isinstance(receipt, dict)
            and receipt.get("request_id") == fallback.get("request_id")
            and receipt.get("fingerprint") == fallback.get("fingerprint")
            and receipt.get("supervisor_nonce") == fallback.get("supervisor_nonce")
            and receipt.get("candidate_keys") == fallback.get("candidate_keys")
            for receipt in receipts)

    def _stage2_apply_duplicate_pair_fallback(self, b, state: dict, plan: dict) -> None:
        """Apply only an exact reverse-covered ID-pair cleanup through Admission CLI, with replay proof."""
        current = state["current"]
        repair_input = plan["repair_input"]
        candidate_keys = plan["candidate_keys"]
        input_sha256 = hashlib.sha256(json.dumps(repair_input, ensure_ascii=False, sort_keys=True,
                                                  separators=(",", ":")).encode("utf-8")).hexdigest()
        fallback = current.get("duplicate_pair_fallback")
        initial_check = None
        if fallback is None:
            checkpoint, checkpoint_sha256, head, remote_head = self._stage2_duplicate_pair_fallback_context(b, state)
            initial_check = self.git.stage2_repair(Path(b["worktree"]), b["shard"],
                *stage2.split_key(b["batch"]), repair_input, check=True)
            if not isinstance(initial_check, dict) or initial_check.get("ok") is not True \
                    or initial_check.get("invalid_candidates") != [] \
                    or not re.fullmatch(r"[a-f0-9]{64}", initial_check.get("request_id", "")) \
                    or initial_check.get("candidate_keys") != candidate_keys:
                raise ValueError("official Admission CLI did not accept the deterministic duplicate-pair fallback")
            fallback = {
                "version": 1, "kind": "reverse-covered-id-pair", "status": "prepared",
                "fingerprint": repair_input["fingerprint"], "candidate_keys": candidate_keys,
                "repair_input": repair_input, "repair_input_sha256": input_sha256,
                "request_id": initial_check["request_id"], "supervisor_nonce": secrets.token_hex(32),
                "checkpoint_sha256": checkpoint_sha256, "head": head, "remote_head": remote_head,
                "covered_pairs": plan["covered_pairs"], "changes": plan["changes"],
            }
            current["duplicate_pair_fallback"] = fallback
            self._save_stage2_repair_state(b, state)
        elif not isinstance(fallback, dict) or fallback.get("version") != 1 \
                or fallback.get("kind") != "reverse-covered-id-pair" \
                or fallback.get("fingerprint") != repair_input.get("fingerprint") \
                or fallback.get("candidate_keys") != candidate_keys \
                or fallback.get("repair_input") != repair_input \
                or fallback.get("repair_input_sha256") != input_sha256 \
                or fallback.get("covered_pairs") != plan["covered_pairs"] \
                or fallback.get("changes") != plan["changes"] \
                or not re.fullmatch(r"[a-f0-9]{64}", fallback.get("request_id", "")) \
                or not re.fullmatch(r"[a-f0-9]{64}", fallback.get("supervisor_nonce", "")):
            raise ValueError("persisted deterministic duplicate-pair fallback does not match the active conflict")

        if self._stage2_duplicate_pair_fallback_has_receipt(b, fallback):
            fallback["status"] = "applied"
            fallback["checkpoint_sha256_after"] = hashlib.sha256(
                self._stage2_repair_checkpoint_path(b).read_bytes()).hexdigest()
            self._save_stage2_repair_state(b, state)
            return
        if fallback.get("status") not in ("prepared", "applying"):
            raise ValueError("deterministic duplicate-pair fallback was already applied without its receipt")

        checkpoint, checkpoint_sha256, head, remote_head = self._stage2_duplicate_pair_fallback_context(b, state)
        if checkpoint_sha256 != fallback.get("checkpoint_sha256") \
                or head != fallback.get("head") or remote_head != fallback.get("remote_head"):
            raise ValueError("checkpoint or Part identity changed before deterministic duplicate-pair fallback")
        if initial_check is None:
            check = self.git.stage2_repair(Path(b["worktree"]), b["shard"],
                *stage2.split_key(b["batch"]), repair_input, check=True)
        else:
            check = initial_check
        if not isinstance(check, dict) or check.get("ok") is not True \
                or check.get("request_id") != fallback.get("request_id") \
                or check.get("candidate_keys") != candidate_keys or check.get("invalid_candidates") != []:
            raise ValueError("deterministic duplicate-pair fallback check changed before apply")

        fallback["status"] = "applying"
        self._save_stage2_repair_state(b, state)
        apply_input = {**repair_input, "supervisor_nonce": fallback["supervisor_nonce"]}
        receipt = self.git.stage2_repair(Path(b["worktree"]), b["shard"],
            *stage2.split_key(b["batch"]), apply_input)
        if not isinstance(receipt, dict) or receipt.get("ok") is not True \
                or receipt.get("request_id") != fallback.get("request_id") \
                or receipt.get("supervisor_nonce") != fallback.get("supervisor_nonce") \
                or receipt.get("candidate_keys") != candidate_keys \
                or not self._stage2_duplicate_pair_fallback_has_receipt(b, fallback):
            raise ValueError("official Admission CLI did not persist the deterministic duplicate-pair receipt")
        fallback["status"] = "applied"
        fallback["checkpoint_sha256_after"] = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
        self._save_stage2_repair_state(b, state)
        self.store.log(b["id"], f"Stage 2 exact reverse-covered ID-pair conflict fallback saved {len(candidate_keys)} decision(s) through admission-cli", "warn")

    def _stage2_preflight_repair(self, b, checkpoint: dict, report_override: dict | None = None) -> bool:
        """Run the read-only complete preflight; return True once it has launched or stopped a repair action."""
        if report_override is None:
            try:
                bb, pp = stage2.split_key(b["batch"])
                report = self.git.stage2_preflight(Path(b["worktree"]), b["shard"], bb, pp)
            except TRANSIENT:
                raise
            except Exception as error:
                self._fail(b, "ERROR", f"Stage 2 read-only preflight failed: {error}. Worktree is preserved.")
                return True
        else:
            report = report_override
        bb, pp = stage2.split_key(b["batch"])
        if not isinstance(report, dict) or (report.get("shard"), report.get("batch"), report.get("part")) != \
                (b["shard"], bb, pp):
            self._fail(b, "ERROR", "Stage 2 preflight returned a different Part identity; preserving repair history")
            return True
        fingerprint = report.get("fingerprint")
        if not isinstance(fingerprint, str) or not re.fullmatch(r"[a-f0-9]{64}", fingerprint):
            self._fail(b, "ERROR", "Stage 2 preflight returned an invalid conflict fingerprint")
            return True
        state = self._stage2_repair_state(b)
        fallback = state.get("current", {}).get("duplicate_pair_fallback") if state else None
        if fallback is not None:
            try:
                has_receipt = self._stage2_duplicate_pair_fallback_has_receipt(b, fallback)
            except (OSError, ValueError, TypeError) as error:
                self._fail(b, "ERROR", f"Stage 2 duplicate-pair fallback receipt could not be verified: {error}")
                return True
            if has_receipt:
                if fallback.get("status") not in ("applying", "applied", "verified", "applied_unresolved"):
                    self._fail(b, "ERROR", "Stage 2 duplicate-pair fallback has an unbound Admission CLI receipt")
                    return True
                fallback["status"] = "verified"
                fallback["postflight_fingerprint"] = fingerprint
                if state.get("history"):
                    state["history"][-1]["duplicate_pair_fallback"] = {
                        "kind": fallback.get("kind"), "request_id": fallback.get("request_id"),
                        "candidate_keys": fallback.get("candidate_keys"),
                        "covered_pairs": fallback.get("covered_pairs"), "changes": fallback.get("changes"),
                        "postflight_fingerprint": fingerprint,
                    }
                self._save_stage2_repair_state(b, state)
                if fingerprint == fallback.get("fingerprint"):
                    fallback["status"] = "applied_unresolved"
                    self._save_stage2_repair_state(b, state)
                    self._fail(b, "ERROR", "Stage 2 deterministic duplicate-pair fallback was applied but the exact preflight conflict remains; evidence is preserved")
                    return True
            elif report.get("ok") is True or fingerprint != fallback.get("fingerprint") \
                    or fallback.get("status") not in ("prepared", "applying"):
                self._fail(b, "ERROR", "Stage 2 preflight changed without a matching deterministic duplicate-pair receipt; preserving the checkpoint")
                return True
        if report.get("ok") is True:
            if state:
                identity = state.get("identity", {})
                if identity.get("base_head") != self.git.head(Path(b["worktree"])) or \
                        identity.get("remote_head") != self.git.remote_head(b["branch"]):
                    problem = self._stage2_repair_rebind_problem(b, state, checkpoint, fingerprint)
                    if problem:
                        self._fail(b, "ERROR", f"Stage 2 repair identity rebind failed: {problem}")
                        return True
                state["status"] = "complete"
                state["last_success_fingerprint"] = fingerprint
                if state.get("history"):
                    state["history"][-1]["resolved"] = True
                    state["history"][-1]["residual_fingerprint"] = fingerprint
                self._save_stage2_repair_state(b, state)
            return False
        if report.get("repairable") is not True or not report.get("problems"):
            summary = "; ".join(report.get("unclassified", [])[:3]) or "no bounded repairable cases were returned"
            self._fail(b, "ERROR", f"Stage 2 preflight found a non-local or incomplete failure; automatic semantic repair is blocked: {summary}")
            return True
        if state is None:
            state = {"version": 1, "identity": {"branch": b["branch"], "worktree": str(b["worktree"]),
                      "base_head": self.git.head(Path(b["worktree"])), "remote_head": self.git.remote_head(b["branch"])},
                     "rounds_used": 0, "history": [], "rebindings": [], "status": "active", "current": None}
        else:
            identity = state.get("identity", {})
            if identity.get("base_head") != self.git.head(Path(b["worktree"])) or \
                    identity.get("remote_head") != self.git.remote_head(b["branch"]):
                problem = self._stage2_repair_rebind_problem(b, state, checkpoint, fingerprint)
                if problem:
                    self._fail(b, "ERROR", f"Stage 2 repair identity rebind failed: {problem}")
                    return True
        seen = {entry.get("fingerprint") for entry in state["history"] if isinstance(entry, dict)}
        if fingerprint in seen:
            plan = self._stage2_duplicate_pair_fallback_plan(report)
            if plan is None:
                # A formerly accepted x may now be rejected by the official local check. Permit one
                # bounded fresh round only when that check identifies every repeated gloss conflict;
                # the normal correction/fallback proof still applies to the new response.
                groups = report["problems"]
                probe = {"fingerprint": fingerprint, "groups": groups, "cursor": 0}
                rows = [{"source_sense_id": c["source_sense_id"], "candidate": c["candidate"], "decision": c["decision"]}
                        for g in groups for c in g.get("candidates", []) if not c.get("already_accounted")]
                keys = sorted({key for g in groups for key in g.get("candidate_keys", [])})
                eligible = (len(stage2.repair_page(groups, 0)) == len(groups) and keys and
                            all(g.get("drop_gloss") and not g.get("conflicts") for g in groups) and
                            sorted(f"{r['source_sense_id']}\0{r['candidate']}" for r in rows) == keys and
                            fingerprint not in state.get("gloss_rechecks", []))
                if eligible:
                    try:
                        checked = self._stage2_repair_check(b, probe, rows, [])
                        invalid = checked["invalid_candidates"]
                        eligible = (checked["ok"] is False and sorted(x["candidate_key"] for x in invalid) == keys and
                                    all(any(p["field_path"] == "decision.reason" and p["condition"] == "gloss_named"
                                            for p in x["problems"]) for x in invalid))
                    except TRANSIENT:
                        raise
                    except (OSError, ValueError, TypeError, KeyError, GitError):
                        eligible = False
                if not eligible:
                    self._fail(b, "ERROR", f"Stage 2 repair made no preflight progress (repeated fingerprint {fingerprint[:12]}); evidence is preserved")
                    return True
                state.setdefault("gloss_rechecks", []).append(fingerprint)
            else:
                try:
                    self._stage2_apply_duplicate_pair_fallback(b, state, plan)
                    after = self.git.stage2_preflight(Path(b["worktree"]), b["shard"], bb, pp)
                except TRANSIENT:
                    raise
                except Exception as error:
                    self._fail(b, "ERROR", f"Stage 2 deterministic duplicate-pair fallback failed; checkpoint and prior repairs are preserved: {error}")
                    return True
                if isinstance(after, dict) and after.get("fingerprint") == fingerprint and after.get("ok") is not True:
                    fallback = state["current"].get("duplicate_pair_fallback", {})
                    fallback["status"] = "applied_unresolved"
                    fallback["postflight_fingerprint"] = fingerprint
                    self._save_stage2_repair_state(b, state)
                    self._fail(b, "ERROR", "Stage 2 deterministic duplicate-pair fallback was applied but the exact preflight conflict remains; evidence is preserved")
                    return True
                return self._stage2_preflight_repair(b, checkpoint, after)
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
        with self.launch_gate.permit():   # a repair round is reserved only by an admitted launch
            state["rounds_used"] += 1
            state["current"] = {"fingerprint": fingerprint, "groups": groups, "cursor": 0, "attempts": 0,
                                 "target_keys": target_keys, "pending_answer": None, "applied_candidate_keys": [],
                                 "attempt_log": [], "type_tier_policy": report.get("type_tier_policy", "legacy-independent")}
            state["history"].append({"round": state["rounds_used"], "fingerprint": fingerprint,
                                     "target_keys": target_keys, "applied_candidate_keys": [], "resolved": False,
                                     "base_head": self.git.head(Path(b["worktree"]))})
            state["status"] = "active"
            self._save_stage2_repair_state(b, state)
            self.store.log(b["id"], f"Stage 2 preflight detected {len(groups)} conflict groups / {len(target_keys)} candidates; starting fresh bounded repair round {state['rounds_used']}/{stage2.MAX_REPAIR_ROUNDS}", "warn")
            self._launch_stage2_repair_page(b)
            return True

    def _relation_deletion_between(self, base_revision: str, head: str, worktree: Path) -> bool:
        """Whether approved ID Relation coverage was actually deleted between two known data snapshots."""
        if not self.git.is_ancestor(base_revision, head, path=worktree):
            raise IntegrationBlocked("Stage 2 change-point is not an ancestor of the synchronized worktree")
        return self.git.has_deleted_id_relation_rows(base_revision, head, path=worktree)

    def _stage2_change_point(self, b, checkpoint, worktree: Path) -> str:
        """Durably capture pre-sync HEAD for checkpoints created before `base_revision` was recorded."""
        key = f"s2_relation_change_point_{b['id']}"
        legacy = self.store.get(f"s2_stage3_change_point_{b['id']}")
        stored = self.store.get(key)
        if stored is not None and legacy is not None and stored != legacy:
            raise IntegrationBlocked("Stage 2 change point differs from its legacy checkpoint; preserving the worktree")
        stored = stored or legacy
        checkpoint_revision = checkpoint.get("base_revision")
        if stored is not None and checkpoint_revision is not None and stored != checkpoint_revision:
            raise IntegrationBlocked("Stage 2 change point differs from its checkpoint; preserving the worktree")
        revision = stored or checkpoint_revision
        if revision is None:
            revision = self.git.head(worktree)
        if not re.fullmatch(r"[a-f0-9]{40}", revision or ""):
            raise IntegrationBlocked("Stage 2 change-point revision is invalid; preserving the worktree")
        if self.store.get(key) != revision:
            self.store.set(key, revision)
        return revision

    @staticmethod
    def _stage2_reconcile_task(b) -> tuple[str, str] | None:
        """Decode a data-diff reconciliation task, accepting old commit payloads during rollout."""
        value = b["run_kind"]
        if not isinstance(value, str) or not value.startswith("s2_reconcile|"):
            return None
        fields = value.split("|")
        if len(fields) not in {3, 4} or not all(re.fullmatch(r"[a-f0-9]{40}", sha) for sha in fields[1:3]):
            raise ValueError("Stage 2 reconciliation task has invalid base/change-point revisions")
        if len(fields) == 4:
            commits = fields[3].split(",") if fields[3] else []
            if not commits or any(not re.fullmatch(r"[a-f0-9]{40}", sha) for sha in commits) or len(set(commits)) != len(commits):
                raise ValueError("legacy Stage 2 reconciliation task has invalid commit IDs")
        return fields[1], fields[2]

    def _stage2_start_reconcile(self, ln, shard: str, batch: str, part: str,
                                old_sha: str, sha: str) -> str | None:
        """Preview the exact Part on latest master and enqueue a Stage2-only Drop repair if proven necessary."""
        verifier = self.git._verify_checkout(sha)
        if not self._relation_deletion_between(old_sha, sha, verifier):
            return None
        preview = self.git.stage2_reconcile_latest(sha, shard, old_sha, sha, batch=batch, part=part)
        if preview["added"] == 0:
            return None
        if self.git.fetch_base(self.cfg["base_branch"]) != sha:
            return "master advanced during completed-Part reconciliation preview; checking the new head next"
        model = ln["model"]
        task = f"s2_reconcile|{sha}|{old_sha}"
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
        self.store.log(bid, f"승인 Relation 삭제 후 고아 Candidate {preview['added']}개를 확인해 "
                       f"{stage2.label(shard, stage2.batch_key(batch, part))} 전용 Drop 조정을 시작합니다")
        self._prepare_existing(self.store.batch(bid))
        return f"{stage2.label(shard, stage2.batch_key(batch, part))} 고아 Candidate를 위한 Stage 2 reconcile PR 대기"

    def _stage2_reconcile_review_fix(self, b, events) -> None:
        """A reconcile PR has no Part checkpoint; preserve it for an explicit owner edit instead of launching AI."""
        if not events:
            return self._fail(b, "ERROR", "현재 HEAD에 유효한 reconcile 리뷰 수정 이벤트가 없습니다. PR과 worktree를 보존합니다.")
        keys = ", ".join(str(event.get("key", "unknown")) for event in events)
        self._fail(b, "PAUSED", "Stage 2 reconcile PR은 Part checkpoint가 없는 결정적 Drop 수정 작업입니다. "
                   "AI 수정은 시작하지 않았습니다. 오너가 리뷰 근거에 따라 기존 소유 브랜치의 "
                   "Drop 전용 변경을 명시적으로 수정하고 검증해 푸시한 뒤 Retry를 실행하세요. "
                   f"현재 리뷰 이벤트: {keys}. 기존 Stage 2 Part 판정과 reconcile 증거는 보존했습니다.")

    def _converge_to_latest_base(self, wt, branch: str, target: str, attempts: int = 12) -> bool:
        """Merge origin/<target> until the worktree contains its freshly fetched tip; True if any merge happened.

        A busy master can advance between consecutive fetches, so a fixed few passes turned a benign race into a
        batch ERROR. Merge conflicts still raise IntegrationBlocked from integrate(); only exhausting the bound is
        reported as transient so the tick asks again with the worktree preserved."""
        integrated = False
        for _ in range(attempts):
            latest = self.git.fetch_base(target)
            if self.git.contains(wt, latest):
                return integrated
            self.git.integrate(wt, branch, target, latest)
            integrated = True
        latest = self.git.fetch_base(target)
        if self.git.contains(wt, latest):
            return integrated
        raise GitTransient(f"latest {target} kept advancing during integration; preserving the worktree")

    def _stage2_reconcile_finalize(self, b) -> None:
        """Write only proven orphan Drops, verify the exact Part, and submit a separate Stage2-only PR."""
        wt = Path(b["worktree"])
        try:
            info = self._find_recovery_pr(b)
            if info is not None:
                if problem := self._stage2_final_pr_problem(b, info):
                    return self._fail(b, "ERROR", problem)
                return self._to_review(b, info)
            base_revision, change_point = self._stage2_reconcile_task(b)
            if not self.git.is_ancestor(base_revision, self.git.head(wt), path=wt):
                raise IntegrationBlocked("reconciliation branch no longer contains its verified base revision")
            self._converge_to_latest_base(wt, b["branch"], self.cfg["base_branch"])
            head = self.git.head(wt)
            if not self._relation_deletion_between(change_point, head, wt):
                bb, pp = stage2.split_key(b["batch"])
                ok, tail = self.git.verify_stage2_local(wt, b["shard"], bb, pp, checkpoint=False)
                if not ok:
                    raise IntegrationBlocked(f"no eligible Relation deletion remains and exact Part verify still fails: {tail}")
                self.git.remove_owned(wt, b["branch"], head)
                self.store.complete_batch(b["id"])
                self.store.log(b["id"], "최신 데이터에서 실제 ID Relation 삭제가 없어 exact Part verify 통과; PR 없이 정리 완료")
                return
            task = f"s2_reconcile|{base_revision}|{change_point}"
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
                result = self.git.stage2_reconcile(wt, b["shard"], change_point, head, batch=bb, part=pp)
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
                f"- 비교 커밋: {change_point} → {head}",
                "- 근거: 이전 승인 데이터의 ID Relation 삭제, 현재 정·역방향 Relation/Drop 커버리지 확인 및 Part verify 통과",
                "- 변경: 사유가 z인 Drop만 추가; 신규 후보 발굴·의미 판단 없음",
                "- 관련 이슈: #927, #2567",
            ]) + "\n"
            return self._create_pr_once(b, title, body, labels)
        except TRANSIENT:
            raise
        except (GitError, IntegrationBlocked, RecoveryBlocked, OSError, ValueError, KeyError, TypeError) as error:
            return self._fail(b, "ERROR", f"Stage 2 orphan reconciliation stopped: {error}. Worktree is preserved.")

    def _stage2_finalize_do(self, b) -> None:
        """Optional completion, snapshot merge, two validations, one commit/push and one owned PR; every step resumes from facts."""
        wt = Path(b["worktree"])
        label = registry(self.cfg)[b["producer"]].get("label", b["producer"])
        title = prbody.s2_title(label, b["shard"], *b["batch"].split("-"))
        legacy_title = prbody.s2_legacy_title(b["shard"], *b["batch"].split("-"))   # commits made before #2838
        self.store.update(b["id"], state="PRODUCING", pid=None, run_kind="s2_deterministic_finalize", error=None)
        active_stage = None
        stage_started = None

        def begin_stage(name):
            nonlocal active_stage, stage_started
            active_stage, stage_started = name, time.monotonic()

        def end_stage(status="success"):
            nonlocal active_stage, stage_started
            if active_stage is not None:
                elapsed_ms = round((time.monotonic() - stage_started) * 1000)
                self.store.log(b["id"], f"S2 finalization {b['shard']}/{b['batch']} stage={active_stage} elapsed_ms={elapsed_ms} status={status}")
                active_stage, stage_started = None, None

        try:
            begin_stage("recovery_pr_initial")
            info = self._find_recovery_pr(b)
            end_stage()
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
                    if repair_state:
                        identity = repair_state.get("identity", {})
                        remote = self.git.remote_head(b["branch"])
                        if identity.get("remote_head") != remote:
                            return self._fail(b, "ERROR", "Stage 2 repair owner remote branch changed; preserving prior decisions and receipts")
                        current_head = self.git.head(wt)
                        if identity.get("base_head") != current_head:
                            saved_base = self.store.get(f"s2_finalize_base_{b['id']}")
                            if saved_base != current_head or self.git.dirty(wt).strip() or \
                                    not self.git.verified_supervisor_integration(
                                        wt, b["branch"], self.cfg["base_branch"], identity.get("base_head"), current_head):
                                return self._fail(b, "ERROR", "Stage 2 repair owner HEAD changed without a verified prior Supervisor integration; preserving prior decisions and receipts")
                    if isinstance(current_repair, dict):
                        groups = current_repair.get("groups")
                        cursor = current_repair.get("cursor")
                        unfinished = current_repair.get("pending_answer") is not None or \
                            current_repair.get("apply_intent") is not None or not isinstance(groups, list) or \
                            type(cursor) is not int or cursor < len(groups)
                        if unfinished:
                            if identity.get("base_head") != current_head:
                                return self._fail(b, "ERROR", "Stage 2 repair page is unfinished after an owner HEAD/remote change; preserving its answer and apply boundary")
                        if current_repair.get("pending_answer") is not None:
                            return self._apply_stage2_repair_answer(b, repair_state)
                        if current_repair.get("apply_intent") is not None:
                            return self._fail(b, "ERROR", "Stage 2 repair has an apply intent without its persisted answer; preserving state")
                        if type(cursor) is int and isinstance(groups, list) and cursor < len(groups):
                            return self._launch_stage2_repair_page(b)
                        if not isinstance(groups, list) or type(cursor) is not int or cursor != len(groups):
                            return self._fail(b, "ERROR", "Stage 2 repair cursor is invalid; preserving state")
                    premerge = checkpoint.get("premerge")
                    integrated = False
                    target = self.cfg["base_branch"]
                    begin_stage("master_sync")
                    change_point = self._stage2_change_point(b, checkpoint, wt)
                    integrated = self._converge_to_latest_base(wt, b["branch"], target)
                    synchronized_head = self.git.head(wt)
                    end_stage()
                    begin_stage("prepare_merge")
                    relation_diff = (change_point, synchronized_head) if self._relation_deletion_between(
                        change_point, synchronized_head, wt) else None
                    relation_diff_manifest = {"from": relation_diff[0], "to": relation_diff[1]} if relation_diff else None
                    refresh_premerge = integrated or not isinstance(premerge, dict) or \
                        premerge.get("relation_diff") != relation_diff_manifest
                    self.git.stage2_prepare_merge(wt, b["shard"], bb, pp, relation_diff,
                                                  refresh=refresh_premerge)
                    base = synchronized_head
                    self.store.set(base_key, base)
                    checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
                    if checkpoint is None or not isinstance(checkpoint.get("premerge"), dict) \
                            or checkpoint["premerge"].get("status") != "ready":
                        return self._fail(b, "ERROR", "trusted premerge snapshot could not be prepared")
                    end_stage()
                    begin_stage("preflight")
                    if self._stage2_preflight_repair(b, checkpoint):
                        end_stage("stopped")
                        return
                    end_stage()
                except TRANSIENT:
                    raise
                except (GitError, IntegrationBlocked, OSError, ValueError, KeyError, TypeError) as e:
                    return self._fail(b, "ERROR", f"Stage 2 preflight preparation failed: {e}. Worktree is preserved.")
            begin_stage("merge")
            self.git.stage2_merge(wt, b["shard"], bb, pp)
            checkpoint = stage2.checkpoint(wt, b["shard"], b["batch"])
            if checkpoint is None or not checkpoint.get("merged") or not checkpoint.get("optional_review_complete") or \
                    not isinstance(checkpoint.get("premerge"), dict) or checkpoint["premerge"].get("status") != "ready":
                return self._fail(b, "ERROR", "merge가 완료되지 않았거나 trusted premerge snapshot이 없습니다")
            end_stage()
            begin_stage("part_verify")
            ok, detail = self.git.verify_stage2_local(wt, b["shard"], bb, pp, checkpoint=True)
            if not ok:
                return self._fail(b, "ERROR", f"로컬 checkpoint-bearing Part verify 실패: {detail}")
            if detail:
                self.store.log(b["id"], f"S2 part_verify {detail}")
            checkpoint_path = (wt / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.json").resolve()
            try:
                st = checkpoint_path.stat()
                checkpoint_stat = (st.st_ino, st.st_size, st.st_mtime_ns)
            except OSError:
                checkpoint_stat = None
            end_stage()
            begin_stage("commit")
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
            elif self.git.commit_parent(wt) == base and self.git.commit_subject(wt) in (title, legacy_title):
                # A crash after Git commit but before the persistent marker; accept only our exact one-commit transition.
                self.store.set(commit_key, head)
            else:
                return self._fail(b, "ERROR", f"HEAD가 finalization baseline과 달라 승인된 Stage 2 commit을 확인하지 못했습니다 ({base} / {head})")
            end_stage()
            begin_stage("push")
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
            end_stage()
            begin_stage("recovery_pr_after_push")
            info = self._find_recovery_pr(b)
            end_stage()
            if info is not None:
                if problem := self._stage2_final_pr_problem(b, info):
                    return self._fail(b, "ERROR", problem)
                return self._to_review(b, info)
            # Statistics come from the exact pushed commit: its own Part verify (no private checkpoint) and the rows
            # this Part's commit added relative to the finalization baseline, never the shard's cumulative files.
            begin_stage("exact_head_verify")
            exact_ok, exact_detail, counts = self.git.verify_stage2_exact_counts(head, b["shard"], bb, pp)
            if not exact_ok:
                return self._fail(b, "ERROR", f"Stage 2 PR 생성 전 정확한 HEAD verify 실패: {exact_detail}")
            end_stage()
            proof = {"head": head, "batch_id": b["id"], "checkpoint_path": str(checkpoint_path),
                     "checkpoint_stat": checkpoint_stat}
            begin_stage("pr_prep")
            if (problem := prbody.stage2_counts_problem(counts)) is not None:
                self.store.log(b["id"], f"Stage 2 통계를 측정하지 못해 미측정으로 표기합니다: {problem}", "warn")
            delta = self.git.row_delta(base, head, b["shard"]) if base else None
            body = prbody.stage2_body(label, b["shard"], bb, pp, counts=counts, delta=delta,
                                      part_verify=True, exact_verify=True)
            issue = self.gh.issue(927)
            labels = [label for label in issue.get("labels", []) if label != "batch"]
            end_stage()
            begin_stage("pr_create_handoff")
            result = self._create_pr_once(b, title, body, labels, stage2_proof=proof)
            end_stage("returned")
            return result
        except TRANSIENT:
            raise
        except (GitError, DuplicateClaim, OSError, ValueError, KeyError, TypeError) as e:
            return self._fail(b, "ERROR", f"Stage 2 deterministic finalization 중단: {e}. worktree를 보존합니다.")
        except Exception as e:
            return self._fail(b, "ERROR", f"Stage 2 deterministic finalization 중단: {e}. worktree를 보존합니다.")
        finally:
            end_stage("failed")

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

    def _stage2_chunk_boundary_problem(self, b, key: str | None = None, base_override: dict | None = None) -> str | None:
        """Fail closed if a chunk run changed or lost the Part's owned HEAD or remote branch ref."""
        label = "Stage 2" if b["method"] == STAGE2_METHOD else str(b["method"]).upper()
        raw = json.dumps(base_override) if base_override is not None else self.store.get(key or stage2.run_start_key(b["id"]))
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

    def _stage2_links_boundary_problem(self, b, base_override: dict | None = None) -> str | None:
        """Optional-link sessions may read, but cannot change checkpoint, tracked outputs, HEAD, or remote ref."""
        raw = json.dumps(base_override) if base_override is not None else self.store.get(stage2.links_start_key(b["id"]))
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
            try:
                answer = self._stage2_repair_response(b, state)
            except Stage2RepairSchemaError as error:
                self.store.log(b["id"], f"Stage 2 repair output rejected ({error}); requesting only the unrequested candidate problems (each problem is asked at most once)", "warn")
                return self._launch_stage2_repair_page(b)
            except Stage2RepairMissingCandidatesError as error:
                current = state.get("current", {})
                correction = self._stage2_repair_correction(current)
                if not isinstance(correction, dict) or correction.get("kind") not in {"coverage", "schema_and_coverage"}:
                    return self._fail(b, "ERROR", f"Stage 2 repair missing-candidate response has no exact correction scope; preserving all evidence: {error}")
                self.store.log(b["id"], f"Stage 2 repair response omitted {len(correction['requested_keys'])} candidates; requesting only those keys on the same page", "warn")
                return self._launch_stage2_repair_page(b)
            except stage2.RepairFormatError:
                answer = None
            if answer is None:   # output-format failure only: same page, bounded by the persisted attempt budget
                self.store.log(b["id"], "Stage 2 repair 응답이 형식 검증을 통과하지 못했습니다. 같은 페이지만 남은 attempt 한도 안에서 다시 실행합니다", "warn")
                return self._launch_stage2_repair_page(b)
            return self._apply_stage2_repair_answer(b, state)
        except TRANSIENT:
            raise
        except (OSError, ValueError, KeyError, TypeError, GitError) as error:
            return self._fail(b, "ERROR", f"Stage 2 repair answer rejected; no checkpoint change was made: {error}")

    def _stage2_links_rejected(self, b, diagnostic: str) -> None:
        used = stage2.fixes_used(self.store.runs(b["id"]), "s2_links_new", ("s2_links_fix",))
        if used < stage2.MAX_FIXES and b["session_id"]:
            with self.launch_gate.permit():   # only the same-session fix run needs admission; the ERROR below never does
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

    def _stage2_correction_state(self, b, pending: str) -> dict | None:
        raw = self.store.get(stage2.correction_key(b["id"]))
        if raw is None:
            return None
        try:
            state = json.loads(raw)
        except (TypeError, ValueError) as error:
            raise ValueError("Stage 2 correction budget is malformed") from error
        common = {"batch_id", "shard", "batch", "chunk_id", "retry_count", "initial_failure",
                  "initial_decisions_b64", "retry_decisions_sha256", "retry_answer_applied", "retry_run_id"}
        if not isinstance(state, dict) or type(state.get("version")) is not int \
                or type(state.get("batch_id")) is not int or type(state.get("retry_count")) is not int \
                or state.get("batch_id") != b["id"] or state.get("shard") != b["shard"] \
                or state.get("batch") != b["batch"] or state.get("chunk_id") != pending \
                or state.get("retry_count") != stage2.MAX_CANDIDATE_RETRIES \
                or not isinstance(state.get("initial_failure"), str) \
                or not isinstance(state.get("initial_decisions_b64"), str) \
                or not isinstance(state.get("retry_answer_applied"), bool) \
                or (state.get("retry_decisions_sha256") is not None
                    and (not isinstance(state.get("retry_decisions_sha256"), str)
                         or not re.fullmatch(r"[a-f0-9]{64}", state["retry_decisions_sha256"]))) \
                or (state.get("retry_run_id") is not None and type(state.get("retry_run_id")) is not int):
            raise ValueError("Stage 2 correction budget is damaged or belongs to another pending chunk")
        try:
            snapshot = base64.b64decode(state["initial_decisions_b64"], validate=True)
            snapshot.decode("utf-8")
        except (ValueError, UnicodeError):
            raise ValueError("Stage 2 correction decision snapshot is malformed") from None
        if state["version"] == 1:
            required = common | {"version", "candidate", "retry_answer_alias", "retry_save_failed", "header_repaired"}
            candidate = state.get("candidate")
            if set(state) != required or not isinstance(candidate, dict) \
                    or set(candidate) != {"alias", "record_id", "sense_id", "candidate"} \
                    or not all(isinstance(candidate.get(name), str) and candidate[name]
                               for name in ("alias", "record_id", "sense_id", "candidate")) \
                    or (state.get("retry_answer_alias") is not None
                        and not isinstance(state.get("retry_answer_alias"), str)) \
                    or not isinstance(state.get("retry_save_failed"), bool) \
                    or not isinstance(state.get("header_repaired"), bool):
                raise ValueError("Stage 2 correction candidate binding is malformed")
            applied = state["retry_answer_applied"]
            if (applied and (state["retry_answer_alias"] != candidate["alias"]
                             or state["retry_decisions_sha256"] is None)) \
                    or (not applied and (state["retry_answer_alias"] is not None
                                         or state["retry_decisions_sha256"] is not None
                                         or state["retry_save_failed"] or state["header_repaired"])) \
                    or (state["retry_save_failed"] and not applied):
                raise ValueError("Stage 2 correction outcome fields are inconsistent")
        elif state["version"] == 2:
            required = common | {"version", "candidates", "retry_answer_aliases", "retry_save_failed",
                                 "retry_save_failed_alias", "fallback_attempted"}
            candidates = state.get("candidates")
            if set(state) != required or not isinstance(candidates, list) or len(candidates) < 2 \
                    or not isinstance(state.get("retry_answer_aliases"), list) \
                    or not isinstance(state.get("retry_save_failed"), bool) \
                    or (state.get("retry_save_failed_alias") is not None
                        and not isinstance(state.get("retry_save_failed_alias"), str)) \
                    or not isinstance(state.get("fallback_attempted"), bool):
                raise ValueError("Stage 2 multi-candidate correction evidence is malformed")
            aliases = []
            for candidate in candidates:
                if not isinstance(candidate, dict) or set(candidate) != {"alias", "record_id", "sense_id", "candidate"} \
                        or not all(isinstance(candidate.get(name), str) and candidate[name]
                                   for name in ("alias", "record_id", "sense_id", "candidate")):
                    raise ValueError("Stage 2 multi-candidate binding is malformed")
                aliases.append(candidate["alias"])
            if len(set(aliases)) != len(aliases) \
                    or stage2.candidate_local_failure_aliases(state["initial_failure"], pending) != aliases:
                raise ValueError("Stage 2 multi-candidate failure evidence is incomplete or inconsistent")
            lines = state["initial_failure"].replace("\r\n", "\n").splitlines()[1:]
            if any(not any(line.startswith(f"{candidate['alias']} {candidate['candidate']}:") for line in lines)
                   for candidate in candidates):
                raise ValueError("Stage 2 multi-candidate names differ from the saved failure evidence")
            applied = state["retry_answer_applied"]
            if (applied and (state["retry_answer_aliases"] != aliases
                             or state["retry_decisions_sha256"] is None
                             or state["retry_run_id"] is None)) \
                    or (not applied and (state["retry_answer_aliases"] or state["retry_decisions_sha256"] is not None
                                         or state["retry_save_failed"]
                                         or state["retry_save_failed_alias"] is not None
                                         or state["fallback_attempted"])) \
                    or (state["retry_save_failed"] and (not applied
                        or state["retry_save_failed_alias"] not in aliases)) \
                    or (not state["retry_save_failed"] and state["retry_save_failed_alias"] is not None) \
                    or (state["fallback_attempted"] and not state["retry_save_failed"]):
                raise ValueError("Stage 2 multi-candidate correction outcome fields are inconsistent")
        else:
            raise ValueError("Stage 2 correction state version is unsupported")
        return state

    def _stage2_reserve_candidate_correction(self, b, pending: str, diagnostic: str, *, plan_only: bool = False) -> dict | None:
        aliases = stage2.candidate_local_failure_aliases(diagnostic, pending)
        if aliases is None:
            return None
        if len(aliases) > 1 and len(stage2.compact_fix_diagnostic(diagnostic)) > stage2.MAX_CANDIDATE_FIX_DIAGNOSTIC_CHARS:
            return None
        try:
            baseline = json.loads(self.store.get(stage2.run_start_key(b["id"])) or "null")
        except (TypeError, ValueError):
            return None
        if not isinstance(baseline, dict) or baseline.get("branch") != b["branch"] \
                or baseline.get("worktree") != str(b["worktree"]) or not isinstance(baseline.get("head"), str) \
                or not isinstance(baseline.get("remote_head"), (str, type(None))) \
                or not self._stage2_checkpoint_unchanged(b, pending, baseline):
            return None
        candidates = []
        problem_lines = diagnostic.replace("\r\n", "\n").splitlines()[1:]
        for alias in aliases:
            candidate = stage2.candidate_binding_from_view(
                b["worktree"], pending, alias, baseline.get("chunk_view_sha256", ""))
            if candidate is None or not any(line.startswith(f"{alias} {candidate['candidate']}:")
                                            for line in problem_lines):
                return None
            candidates.append(candidate)
        decisions_path = Path(b["worktree"]) / stage2.DECISIONS
        try:
            initial_decisions = decisions_path.read_bytes()
            if stage2.decision_file_state(b["worktree"], pending) != "current":
                return None
        except OSError:
            return None
        state = {
            "version": 1 if len(candidates) == 1 else 2,
            "batch_id": b["id"], "shard": b["shard"], "batch": b["batch"],
            "chunk_id": pending, "retry_count": stage2.MAX_CANDIDATE_RETRIES, "initial_failure": diagnostic,
            "retry_answer_applied": False,
            "initial_decisions_b64": base64.b64encode(initial_decisions).decode("ascii"),
            "retry_decisions_sha256": None, "retry_run_id": None,
        }
        if len(candidates) == 1:
            state.update(candidate=candidates[0], retry_answer_alias=None, retry_save_failed=False, header_repaired=False)
        else:
            state.update(candidates=candidates, retry_answer_aliases=[], retry_save_failed=False,
                         retry_save_failed_alias=None, fallback_attempted=False)
        if plan_only:   # the binding verdict alone; nothing is reserved until a launch is admitted
            return state
        self.store.set(stage2.correction_key(b["id"]), json.dumps(state, ensure_ascii=False, sort_keys=True))
        evidence = {"candidates": candidates, "chunk_id": pending, "failure_reason": diagnostic,
                    "retry_count": 1, "correction_runs_max": 1}
        self.store.log(b["id"], "Stage 2 후보 단위 수정 1회를 결속했습니다: " + json.dumps(evidence, ensure_ascii=False, sort_keys=True), "warn")
        return state

    def _stage2_restore_unchanged_decisions(self, b, pending: str, correction: dict) -> bool:
        """Require the retry to start from the exact Supervisor snapshot; restore it and fail closed on any drift."""
        try:
            snapshot = base64.b64decode(correction["initial_decisions_b64"], validate=True)
            path = Path(b["worktree"]) / stage2.DECISIONS
            current = path.read_bytes()
            if current == snapshot:
                return True
            temporary = path.with_name(path.name + ".restore")
            temporary.write_bytes(snapshot)
            temporary.replace(path)
            return False
        except (KeyError, OSError, ValueError):
            return False

    def _stage2_mark_candidate_correction(self, b, pending: str, alias: str, *, header_repaired: bool) -> bool:
        state = self._stage2_correction_state(b, pending)
        if state is None or state["version"] != 1 or state["candidate"]["alias"] != alias:
            return False
        state["retry_answer_applied"] = True
        state["retry_answer_alias"] = alias
        decisions_path = Path(b["worktree"]) / stage2.DECISIONS
        state["retry_decisions_sha256"] = hashlib.sha256(decisions_path.read_bytes()).hexdigest()
        state["retry_save_failed"] = False
        state["header_repaired"] = bool(header_repaired)
        self.store.set(stage2.correction_key(b["id"]), json.dumps(state, ensure_ascii=False, sort_keys=True))
        return True

    def _stage2_mark_multi_candidate_correction(self, b, pending: str, aliases: list[str]) -> bool:
        state = self._stage2_correction_state(b, pending)
        if state is None or state["version"] != 2 \
                or aliases != [candidate["alias"] for candidate in state["candidates"]] \
                or not self._stage2_correction_run_completed(b, state):
            return False
        decisions_path = Path(b["worktree"]) / stage2.DECISIONS
        try:
            decisions = decisions_path.read_bytes()
            rows = stage2.read_rows(b["worktree"])
        except OSError:
            return False
        row_aliases = [stage2.alias_of(row) for row in rows]
        if len(row_aliases) != len(set(row_aliases)) or not set(aliases).issubset(row_aliases):
            return False
        state["retry_answer_applied"] = True
        state["retry_answer_aliases"] = aliases
        state["retry_decisions_sha256"] = hashlib.sha256(decisions).hexdigest()
        state["retry_save_failed"] = False
        state["retry_save_failed_alias"] = None
        state["fallback_attempted"] = False
        self.store.set(stage2.correction_key(b["id"]), json.dumps(state, ensure_ascii=False, sort_keys=True))
        return True

    def _stage2_mark_candidate_failure(self, b, pending: str, diagnostic: str, correction: dict) -> bool:
        candidate = correction["candidate"]
        if not correction["retry_answer_applied"] or correction["retry_answer_alias"] != candidate["alias"] \
                or not self._stage2_correction_run_completed(b, correction) \
                or stage2.single_candidate_failure_alias(diagnostic, pending, candidate) != candidate["alias"]:
            return False
        decisions_path = Path(b["worktree"]) / stage2.DECISIONS
        try:
            if not decisions_path.is_file() or hashlib.sha256(decisions_path.read_bytes()).hexdigest() != correction["retry_decisions_sha256"]:
                return False
        except OSError:
            return False
        correction["retry_save_failed"] = True
        self.store.set(stage2.correction_key(b["id"]), json.dumps(correction, ensure_ascii=False, sort_keys=True))
        return True

    def _stage2_mark_multi_candidate_failure(self, b, pending: str, diagnostic: str, correction: dict) -> bool:
        if correction["version"] != 2 or not correction["retry_answer_applied"] \
                or correction["retry_answer_aliases"] != [candidate["alias"] for candidate in correction["candidates"]] \
                or not self._stage2_correction_run_completed(b, correction):
            return False
        alias = stage2.single_candidate_failure_alias(diagnostic, pending)
        candidate = next((item for item in correction["candidates"] if item["alias"] == alias), None)
        if candidate is None or stage2.single_candidate_failure_alias(diagnostic, pending, candidate) != alias:
            return False
        decisions_path = Path(b["worktree"]) / stage2.DECISIONS
        try:
            if not decisions_path.is_file() \
                    or hashlib.sha256(decisions_path.read_bytes()).hexdigest() != correction["retry_decisions_sha256"]:
                return False
        except OSError:
            return False
        correction["retry_save_failed"] = True
        correction["retry_save_failed_alias"] = alias
        self.store.set(stage2.correction_key(b["id"]), json.dumps(correction, ensure_ascii=False, sort_keys=True))
        return True

    def _stage2_correction_run_completed(self, b, correction: dict) -> bool:
        run_id = correction.get("retry_run_id")
        if type(run_id) is not int:
            return False
        return any(run["id"] == run_id and run["kind"] == "s2_chunk_fix"
                   and run["ended_at"] is not None for run in self.store.runs(b["id"]))

    def _stage2_checkpoint_unchanged(self, b, pending: str, baseline: dict) -> bool:
        expected = baseline.get("checkpoint")
        expected_hash = baseline.get("checkpoint_sha256")
        if not isinstance(expected, dict) or expected.get("pending_chunk") != pending \
                or not isinstance(expected_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", expected_hash):
            return False
        try:
            batch, part = stage2.split_key(b["batch"])
            checkpoint_path = Path(b["worktree"]) / ".warroom-scratch" / \
                f"relation-admission-{b['shard']}-{batch}-{part}.json"
            return stage2.checkpoint(b["worktree"], b["shard"], b["batch"]) == expected \
                and hashlib.sha256(checkpoint_path.read_bytes()).hexdigest() == expected_hash
        except (OSError, ValueError, KeyError, TypeError):
            return False

    def _stage2_save(self, b, supervisor_fallback: dict | None = None) -> tuple[bool, str]:
        bb, pp = stage2.split_key(b["batch"])
        if supervisor_fallback is None:
            return self.git.stage2_save_chunk(Path(b["worktree"]), b["shard"], bb, pp)
        return self.git.stage2_save_chunk(Path(b["worktree"]), b["shard"], bb, pp,
                                          supervisor_fallback=supervisor_fallback,
                                          supervisor_state_dir=self.paths.supervisor_state)

    def _stage2_accept(self, b) -> None:
        self._clear_batch_retry(b["id"])
        self.store.delete(stage2.run_start_key(b["id"]))
        self.store.delete(stage2.correction_key(b["id"]))
        self.store.update(b["id"], session_id=None, retries=0, retry_after=None, error=None)
        self.store.log(b["id"], "Stage 2 청크가 admission-cli save-chunk를 통과해 checkpoint에 저장됐습니다. 다음 단계는 새 세션으로 실행합니다.")
        return self._launch_stage2_next(self.store.batch(b["id"]))

    def _stage2_saved_or_fail(self, b) -> None:
        if not self._stage2_chunk_saved(b):
            return self._fail(b, "ERROR", "save-chunk가 성공했지만 checkpoint가 시작 시점 대비 정확히 한 청크만 전진하지 않았습니다. "
                              "자동 재생산하지 않고 worktree와 기록을 보존합니다.")
        return self._stage2_accept(b)

    def _stage2_rejected(self, b, diagnostic: str) -> None:
        """Retry one source-bound candidate once, then use only its technical Drop fallback if it still fails."""
        pending = self._stage2_pending(b)
        if pending is None:
            return self._fail(b, "ERROR", "Stage 2 수정 요청에 현재 pending 청크가 없습니다. 결정 파일과 checkpoint를 보존합니다.")
        file_state = stage2.decision_file_state(b["worktree"], pending)
        if file_state == "corrupt":
            return self._fail(b, "ERROR", f"Stage 2 판정 파일이 비어 있거나 현재 청크와 맞지 않거나 손상되어 수정하지 않습니다. "
                              f"파일과 checkpoint를 보존합니다: {stage2.DECISIONS}")
        if file_state != "current":
            return self._fail(b, "ERROR", "Stage 2 전체 응답·판정 파일을 후보 하나에 결속할 수 없어 자동 수정하거나 Drop하지 않습니다. "
                              f"worktree와 checkpoint를 보존합니다: {diagnostic[:600]}")
        if problem := self._stage2_chunk_boundary_problem(b):
            return self._fail(b, "ERROR", problem)
        try:
            correction = self._stage2_correction_state(b, pending)
        except ValueError as error:
            return self._fail(b, "ERROR", f"Stage 2 수정 한도 증거를 확인하지 못해 중단합니다: {error}")
        if correction is None:
            if not b["session_id"]:
                return self._fail(b, "ERROR", "후보 단위 오류는 확인했지만 연결된 기존 Stage 2 세션이 없어 AI Retry를 시작하지 않습니다. "
                                  f"worktree와 checkpoint를 보존합니다: {diagnostic[:600]}")
            bind_error = ("save-chunk 오류를 한 개의 현재 청크 후보와 정확히 결속하지 못해 자동 Retry/Fallback을 하지 않습니다. "
                          f"worktree와 checkpoint를 보존합니다: {diagnostic[:800]}")
            if self._stage2_reserve_candidate_correction(b, pending, diagnostic, plan_only=True) is None:
                return self._fail(b, "ERROR", bind_error)
            with self.launch_gate.permit():   # the correction budget is written only for a launch that is admitted
                correction = self._stage2_reserve_candidate_correction(b, pending, diagnostic)
                if correction is None:
                    return self._fail(b, "ERROR", bind_error)
                self._s2_fix_problem[b["id"]] = stage2.compact_fix_diagnostic(diagnostic)
                self.store.update(b["id"], retries=0, retry_after=None, error=None)
                result = self._launch(self.store.batch(b["id"]), "s2_chunk_fix")
                runs = self.store.runs(b["id"])
                if runs and runs[0]["kind"] == "s2_chunk_fix":
                    correction["retry_run_id"] = runs[0]["id"]
                    self.store.set(stage2.correction_key(b["id"]), json.dumps(correction, ensure_ascii=False, sort_keys=True))
                    evidence = {"candidates": correction.get("candidates", [correction.get("candidate")]),
                                "chunk_id": pending, "retry_count": correction["retry_count"],
                                "retry_run_id": correction["retry_run_id"]}
                    self.store.log(b["id"], "Stage 2 후보 수정 run 결속: " + json.dumps(evidence, ensure_ascii=False, sort_keys=True))
                return result
        if correction["retry_answer_applied"] and not correction["retry_save_failed"]:
            marked = (self._stage2_mark_multi_candidate_failure(b, pending, diagnostic, correction)
                      if correction["version"] == 2
                      else self._stage2_mark_candidate_failure(b, pending, diagnostic, correction))
            if not marked:
                return self._fail(b, "ERROR", "수정 응답을 적용한 decisions.txt와 현재 후보 단위 save-chunk 실패를 함께 증명하지 못했습니다. Fallback 없이 기록을 보존합니다.")
        result = self._stage2_technical_fallback(b, pending, diagnostic, correction)
        if result is not None:
            return result
        return self._fail(b, "ERROR", "Stage 2의 후보 단위 Retry 1회가 끝났으나 기술적 Fallback 조건을 증명하지 못했습니다. "
                          f"판정 파일과 checkpoint를 보존합니다: {diagnostic[:800]}")

    def _stage2_recover_headerless_fix(self, b, final_text: str | None):
        """Restore only the current fix run's one valid alias row when its exact chunk header alone is missing."""
        pending = self._stage2_pending(b)
        if pending is None or b["run_kind"] != "s2_chunk_fix":
            return None
        try:
            correction = self._stage2_correction_state(b, pending)
        except ValueError as error:
            return self._fail(b, "ERROR", f"Stage 2 header 복구 기준이 손상되어 중단합니다: {error}")
        if correction is None or not b["session_id"]:
            return None
        if not self._stage2_correction_run_completed(b, correction):
            return self._fail(b, "ERROR", "현재 headerless 응답을 완료된 단일 Retry run에 결속하지 못해 복구하지 않습니다.")
        candidate = correction.get("candidate")
        if not isinstance(candidate, dict):
            return None
        row = stage2.headerless_fix_row(final_text, candidate["alias"])
        if row is None or correction["retry_count"] != stage2.MAX_CANDIDATE_RETRIES:
            return None
        if problem := self._stage2_chunk_boundary_problem(b):
            return self._fail(b, "ERROR", problem)
        try:
            baseline = json.loads(self.store.get(stage2.run_start_key(b["id"])) or "null")
        except (TypeError, ValueError):
            baseline = None
        if not isinstance(baseline, dict) or not self._stage2_checkpoint_unchanged(b, pending, baseline):
            return self._fail(b, "ERROR", "header-only 복구의 시작 checkpoint가 현재 pending 청크와 다릅니다. 파일과 checkpoint를 보존합니다.")
        if stage2.decision_file_state(b["worktree"], pending) != "current":
            return self._fail(b, "ERROR", "현재 청크의 정상 판정 파일이 없어 header-only 복구를 결속할 수 없습니다. worktree와 checkpoint를 보존합니다.")
        if not self._stage2_restore_unchanged_decisions(b, pending, correction):
            return self._fail(b, "ERROR", "Retry 중 기존 판정 파일이 바뀌어 최초 스냅샷을 복원했습니다. header-only 복구를 중단하고 checkpoint를 보존합니다.")
        try:
            ok, detail = self._stage2_save(b)
            if ok:
                return self._stage2_saved_or_fail(b)
            if stage2.single_candidate_failure_alias(detail, pending, candidate) != candidate["alias"]:
                return self._fail(b, "ERROR", f"header-only 복구 전에 기존 CLI 오류가 동일한 한 후보로 재현되지 않았습니다. "
                                  f"판정 파일과 checkpoint를 보존합니다: {detail[:800]}")
            existing = stage2.read_rows(b["worktree"])
            if sum(stage2.alias_of(saved) == candidate["alias"] for saved in existing) != 1:
                return self._fail(b, "ERROR", "현재 decisions.txt에서 대상 alias가 정확히 한 행이 아니어서 header-only 복구를 중단합니다.")
            if not self._stage2_restore_unchanged_decisions(b, pending, correction):
                return self._fail(b, "ERROR", "header-only 행을 적용하기 전 기존 판정 파일이 바뀌어 최초 스냅샷을 복원했습니다. checkpoint를 보존합니다.")
            merged, ignored = stage2.merge_fix(existing, [row], [candidate["alias"]])
            if ignored:
                return self._fail(b, "ERROR", "현재 최종 응답을 초기 실패 alias에 결속하지 못해 복구하지 않습니다.")
            stage2.write_decisions(b["worktree"], pending, merged)
            if not self._stage2_mark_candidate_correction(b, pending, candidate["alias"], header_repaired=True):
                return self._fail(b, "ERROR", "현재 최종 응답을 적용한 decisions.txt와 수정 한도를 결속하지 못해 복구하지 않습니다.")
            event = {**candidate, "chunk_id": pending, "failure_reason": detail,
                     "retry_count": 1, "deterministic_recovery": "restored_exact_chunk_header"}
            self.store.log(b["id"], "Stage 2 header-only 결정적 복구를 적용했습니다: " + json.dumps(event, ensure_ascii=False, sort_keys=True), "warn")
            ok, detail = self._stage2_save(b)
        except TRANSIENT:
            raise
        except (OSError, ValueError, GitError, KeyError, TypeError) as error:
            return self._fail(b, "ERROR", f"Stage 2 header-only 복구 처리 실패: {error}. 판정 파일과 checkpoint를 보존합니다.")
        if ok:
            return self._stage2_saved_or_fail(b)
        self.store.add_submit_failure(b["id"])
        self.store.log(b["id"], f"header-only 복구 뒤 후보 저장 거부: {detail[:800]}", "warn")
        return self._stage2_rejected(b, detail)

    def _stage2_technical_fallback(self, b, pending: str, diagnostic: str, correction: dict):
        """Apply reason f to the one retried candidate through the restricted official save-chunk path."""
        if correction.get("version") == 2:
            return self._stage2_multi_candidate_technical_fallback(b, pending, diagnostic, correction)
        candidate = correction["candidate"]
        alias = candidate["alias"]
        if not correction["retry_answer_applied"] or not correction["retry_save_failed"] \
                or correction["retry_answer_alias"] != alias \
                or correction["retry_count"] != stage2.MAX_CANDIDATE_RETRIES \
                or not self._stage2_correction_run_completed(b, correction):
            return None
        if stage2.single_candidate_failure_alias(diagnostic, pending, candidate) != alias:
            return None
        try:
            baseline = json.loads(self.store.get(stage2.run_start_key(b["id"])) or "null")
        except (TypeError, ValueError):
            return None
        if not isinstance(baseline, dict) or baseline.get("branch") != b["branch"] \
                or baseline.get("worktree") != str(b["worktree"]) \
                or baseline.get("chunk_view_sha256") is None \
                or not self._stage2_checkpoint_unchanged(b, pending, baseline):
            return None
        actual = stage2.candidate_binding_from_view(b["worktree"], pending, alias, baseline["chunk_view_sha256"])
        if actual != candidate:
            return None
        rows = stage2.read_rows(b["worktree"])
        matching = [row for row in rows if stage2.alias_of(row) == alias]
        if len(matching) != 1 or stage2.decisions_header(b["worktree"]) != pending:
            return None
        decisions_path = Path(b["worktree"]) / stage2.DECISIONS
        try:
            if hashlib.sha256(decisions_path.read_bytes()).hexdigest() != correction["retry_decisions_sha256"]:
                return None
        except OSError:
            return None
        proof = {
            "alias": alias, "candidate": candidate["candidate"], "chunk_id": pending,
            "failure_reason": diagnostic, "record_id": candidate["record_id"],
            "retry_count": correction["retry_count"], "sense_id": candidate["sense_id"],
        }
        original_rows = rows
        try:
            stage2.write_decisions(b["worktree"], pending, [row for row in rows if stage2.alias_of(row) != alias])
            ok, detail = self._stage2_save(b, supervisor_fallback=proof)
        except TRANSIENT:
            raise
        except (OSError, ValueError, GitError, KeyError, TypeError) as error:
            try:
                stage2.write_decisions(b["worktree"], pending, original_rows)
            except OSError as restore_error:
                return self._fail(b, "ERROR", f"Stage 2 technical Fallback 처리 및 원래 판정 복원이 실패했습니다: {error}; {restore_error}")
            return self._fail(b, "ERROR", f"Stage 2 technical Fallback 처리에 실패해 원래 판정을 복원했습니다: {error}")
        if ok or self._stage2_chunk_saved(b):
            event = {**candidate, "chunk_id": pending, "failure_reason": diagnostic,
                     "initial_failure": correction["initial_failure"], "retry_count": 1,
                     "deterministic_header_repair": correction["header_repaired"], "drop_reason": "f"}
            self.store.log(b["id"], "Stage 2 technical Drop Fallback 저장: " + json.dumps(event, ensure_ascii=False, sort_keys=True), "warn")
            return self._stage2_saved_or_fail(b)
        stage2.write_decisions(b["worktree"], pending, original_rows)
        self.store.log(b["id"], f"Stage 2 technical Fallback CLI 저장이 거부되어 원래 판정 행을 복원했습니다: {detail[:800]}", "warn")
        return self._fail(b, "ERROR", f"reason f Fallback도 공식 save-chunk 검증을 통과하지 못했습니다. 판정 파일과 checkpoint를 보존합니다: {detail[:800]}")

    def _stage2_multi_candidate_technical_fallback(self, b, pending: str, diagnostic: str, correction: dict):
        """Allow one existing-policy Fallback only for a single candidate still rejected after the shared repair run."""
        alias = correction.get("retry_save_failed_alias")
        candidate = next((item for item in correction.get("candidates", []) if item["alias"] == alias), None)
        if candidate is None or not correction["retry_answer_applied"] or not correction["retry_save_failed"] \
                or correction["retry_answer_aliases"] != [item["alias"] for item in correction["candidates"]] \
                or correction["retry_count"] != stage2.MAX_CANDIDATE_RETRIES \
                or correction["fallback_attempted"] or not self._stage2_correction_run_completed(b, correction) \
                or stage2.single_candidate_failure_alias(diagnostic, pending, candidate) != alias:
            return None
        try:
            baseline = json.loads(self.store.get(stage2.run_start_key(b["id"])) or "null")
        except (TypeError, ValueError):
            return None
        if not isinstance(baseline, dict) or baseline.get("branch") != b["branch"] \
                or baseline.get("worktree") != str(b["worktree"]) \
                or baseline.get("chunk_view_sha256") is None \
                or not self._stage2_checkpoint_unchanged(b, pending, baseline):
            return None
        actual = stage2.candidate_binding_from_view(b["worktree"], pending, alias, baseline["chunk_view_sha256"])
        if actual != candidate:
            return None
        rows = stage2.read_rows(b["worktree"])
        matching = [row for row in rows if stage2.alias_of(row) == alias]
        if len(matching) != 1 or stage2.decisions_header(b["worktree"]) != pending:
            return None
        decisions_path = Path(b["worktree"]) / stage2.DECISIONS
        try:
            if hashlib.sha256(decisions_path.read_bytes()).hexdigest() != correction["retry_decisions_sha256"]:
                return None
        except OSError:
            return None
        proof = {
            "alias": alias, "candidate": candidate["candidate"], "chunk_id": pending,
            "failure_reason": diagnostic, "record_id": candidate["record_id"],
            "retry_count": correction["retry_count"], "sense_id": candidate["sense_id"],
        }
        original_rows = rows
        # Persist before invoking the CLI so a crash or owner Retry cannot spend this one Fallback twice.
        correction["fallback_attempted"] = True
        self.store.set(stage2.correction_key(b["id"]), json.dumps(correction, ensure_ascii=False, sort_keys=True))
        try:
            stage2.write_decisions(b["worktree"], pending, [row for row in rows if stage2.alias_of(row) != alias])
            ok, detail = self._stage2_save(b, supervisor_fallback=proof)
        except TRANSIENT:
            raise
        except (OSError, ValueError, GitError, KeyError, TypeError) as error:
            try:
                stage2.write_decisions(b["worktree"], pending, original_rows)
            except OSError as restore_error:
                return self._fail(b, "ERROR", f"Stage 2 multi-candidate Fallback 처리 및 원래 판정 복원이 실패했습니다: {error}; {restore_error}")
            return self._fail(b, "ERROR", f"Stage 2 multi-candidate Fallback 처리에 실패해 원래 판정을 복원했습니다: {error}")
        if ok or self._stage2_chunk_saved(b):
            event = {**candidate, "chunk_id": pending, "failure_reason": diagnostic,
                     "initial_failure": correction["initial_failure"], "retry_count": correction["retry_count"],
                     "drop_reason": "f"}
            self.store.log(b["id"], "Stage 2 단일 후보 technical Drop Fallback 저장: " +
                           json.dumps(event, ensure_ascii=False, sort_keys=True), "warn")
            return self._stage2_saved_or_fail(b)
        stage2.write_decisions(b["worktree"], pending, original_rows)
        self.store.log(b["id"], f"multi-candidate Fallback CLI 저장이 거부되어 원래 판정 행을 복원했습니다: {detail[:800]}", "warn")
        return self._fail(b, "ERROR", f"reason f Fallback도 공식 save-chunk 검증을 통과하지 못했습니다. 판정 파일과 checkpoint를 보존합니다: {detail[:800]}")

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
            if b["run_kind"] == "s2_chunk_fix":
                try:
                    final_text = self._adapter(b["producer"]).final_answer(Path(b["log_file"]))
                except (OSError, ValueError, TypeError) as error:
                    return self._fail(b, "ERROR", f"현재 Stage 2 수정 응답을 읽지 못해 보존합니다: {error}")
                recovered = self._stage2_recover_headerless_fix(b, final_text)
                if recovered is not None:
                    return recovered
            elif b["run_kind"] != "s2_chunk_format_fix" \
                    and self._retry_unsaved_chunk(b, "현재 청크 응답 누락"):
                return
            return self._fail(b, "ERROR", "Stage 2 청크 실행은 종료됐지만 현재 청크 ID 헤더가 있는 판정 응답이 없고 시작 시점 대비 "
                              "checkpoint가 정확히 전진하지 않았거나 pending_chunk가 남아 있습니다. 전체 응답 누락/비국소 형식 오류는 자동 재실행하지 않고 기록을 보존합니다.")
        if format_problem := stage2.joined_decision_rows_problem(rows):
            return self._stage2_invalid_format(b, format_problem)
        pending = self._stage2_pending(b)
        try:
            file_state = stage2.decision_file_state(b["worktree"], pending)
            if b["run_kind"] == "s2_chunk_fix":
                if file_state != "current":
                    return self._fail(b, "ERROR", "부분 수정 응답을 병합할 현재 청크 판정 파일이 없거나 손상됐습니다. "
                                      f"수정하지 않고 파일과 checkpoint를 보존합니다: {stage2.DECISIONS}")
                try:
                    correction = self._stage2_correction_state(b, pending)
                except ValueError as error:
                    return self._fail(b, "ERROR", f"Stage 2 후보 Retry 증거가 손상되어 응답을 병합하지 않습니다: {error}")
                if correction is None:
                    return self._fail(b, "ERROR", "Stage 2 수정 응답에 결속된 단일 후보 Retry 증거가 없습니다. 판정 파일을 보존합니다.")
                try:
                    baseline = json.loads(self.store.get(stage2.run_start_key(b["id"])) or "null")
                except (TypeError, ValueError):
                    baseline = None
                if not isinstance(baseline, dict) or not self._stage2_checkpoint_unchanged(b, pending, baseline):
                    return self._fail(b, "ERROR", "수정 응답의 시작 checkpoint가 현재 pending 청크와 다릅니다. 판정 파일과 checkpoint를 보존합니다.")
                candidates = correction["candidates"] if correction["version"] == 2 else [correction["candidate"]]
                targets = [candidate["alias"] for candidate in candidates]
                if not self._stage2_restore_unchanged_decisions(b, pending, correction):
                    return self._fail(b, "ERROR", "Retry 중 기존 판정 파일이 바뀌어 최초 스냅샷을 복원했습니다. 수정 응답과 저장을 중단하고 checkpoint를 보존합니다.")
                ok, detail = self._stage2_save(b)   # the same rejection the fix prompt was built from, to find its rows
                if ok:
                    return self._stage2_saved_or_fail(b)
                if correction["version"] == 1:
                    candidate = candidates[0]
                    if stage2.single_candidate_failure_alias(detail, pending, candidate) != candidate["alias"]:
                        return self._fail(b, "ERROR", f"수정 전 저장 진단이 처음 실패한 후보와 달라져 응답을 병합하지 않습니다: {detail[:800]}")
                    if len(rows) != 1 or stage2.alias_of(rows[0]) != candidate["alias"]:
                        return self._fail(b, "ERROR", "Stage 2 수정 응답이 실패한 후보 하나의 행과 정확히 일치하지 않습니다. 아무 행도 병합하지 않고 보존합니다.")
                else:
                    if detail != correction["initial_failure"] \
                            or stage2.candidate_local_failure_aliases(detail, pending) != targets:
                        return self._fail(b, "ERROR", f"수정 전 전체 저장 진단이 최초 후보 집합과 달라져 응답을 병합하지 않습니다: {detail[:800]}")
                    response_aliases = [stage2.alias_of(row) for row in rows]
                    if len(rows) != len(targets) or len(set(response_aliases)) != len(response_aliases) \
                            or set(response_aliases) != set(targets):
                        return self._fail(b, "ERROR", "Stage 2 수정 응답은 실패한 후보 각각의 행 하나만 포함해야 합니다. 아무 행도 병합하지 않고 보존합니다.")
                if not self._stage2_restore_unchanged_decisions(b, pending, correction):
                    return self._fail(b, "ERROR", "Retry 중 기존 판정 파일이 바뀌어 최초 스냅샷을 복원했습니다. 수정 응답 병합을 중단하고 checkpoint를 보존합니다.")
                merged, ignored = stage2.merge_fix(stage2.read_rows(b["worktree"]), rows, targets)
                if ignored and correction["version"] == 1:
                    self.store.log(b["id"], f"수정 응답의 허용 범위 밖 행 {len(ignored)}개를 무시했습니다: "
                                   f"{', '.join(stage2.alias_of(r) for r in ignored[:10])}", "warn")
                if ignored:
                    return self._fail(b, "ERROR", "Stage 2 수정 응답의 허용 별칭 집합이 달라 병합하지 않고 보존합니다.")
                stage2.write_decisions(b["worktree"], pending, merged)
                marked = (self._stage2_mark_multi_candidate_correction(b, pending, targets)
                          if correction["version"] == 2
                          else self._stage2_mark_candidate_correction(b, pending, targets[0], header_repaired=False))
                if not marked:
                    return self._fail(b, "ERROR", "Stage 2 수정 행을 적용한 decisions.txt와 후보 Retry에 결속하지 못해 보존합니다.")
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

    # ---- PR creation ----------------------------------------------------------------------------------------------
    def _create_pr_once(self, b, title: str, body: str, labels: list[str], *, stage2_proof=None) -> None:
        """Open the batch PR at most once. Invariant: while it is unknown whether a create request made a PR, the request is
        never repeated; only the owned-branch lookup is (a transient 'unconfirmed' outcome raises GhTransient)."""
        key = f"pr_create_{b['id']}"
        raw = self.store.get(key)
        created = False
        create_started = time.monotonic()
        if raw is None:
            self.store.set(key, json.dumps({"head": self._local_head(b), "at": self.clock()}))
            try:
                self.gh.create_pr(b["branch"], self.cfg["base_branch"], title, body, labels)
                created = True
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
        create_ms = round((time.monotonic() - create_started) * 1000)
        lookup_started = time.monotonic()
        info = self._find_recovery_pr(b)
        lookup_ms = round((time.monotonic() - lookup_started) * 1000)
        if info is not None:
            self.store.delete(key)
            if b["method"] == STAGE2_METHOD:
                telemetry = {"mode": "full", "checkpoint_verify": 0, "exact_head_verify": 0}
                started = time.monotonic()
                problem = self._stage2_final_pr_problem(b, info, verified=stage2_proof if created else None,
                                                        telemetry=telemetry)
                elapsed = round((time.monotonic() - started) * 1000)
                self.store.log(b["id"], f"pr_handoff_verify elapsed_ms={elapsed} mode={telemetry['mode']} "
                               f"checkpoint_verify={telemetry['checkpoint_verify']} exact_head_verify={telemetry['exact_head_verify']} "
                               f"create_ms={create_ms} lookup_ms={lookup_ms}")
                if problem:
                    return self._fail(b, "ERROR", problem)
            return self._to_review(b, info)
        try:
            waited = self.clock() - float(json.loads(raw)["at"])
        except (TypeError, ValueError, KeyError):
            waited = 0
        if waited >= self.cfg["pr_head_lag_timeout_seconds"]:
            # Past the head-lag window the owned-branch listing still shows no PR, so the earlier request created none
            # (a rejected/lost create, #2810): forget the marker and let the next pass ask exactly once more.
            self.store.delete(key)
            raise GhTransient("PR 생성 여부 확인 시간 초과 — 소유 브랜치에 PR이 없어 생성 요청을 한 번 다시 보냅니다(복구 대기)")
        raise GhTransient("PR 생성 반영 대기(목록 조회만 반복, 재생성 없음)")

    def _fix_kind(self, b) -> str:
        """Stage 2/3 review fixes start a bounded fresh session; the Maintainer resumes its own session when it has one."""
        if b["method"] in (STAGE2_METHOD, STAGE3_METHOD):
            return "fix_new"
        return "fix_resume" if b["session_id"] else "fix_new"

    @_single_launch_scope
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

    def _run_bound_app_replies(self, run, pr, comments) -> set[int]:
        """Bind a Codex app reply to its actual successful tool call and the unchanged GitHub comment."""
        try:
            found = set()
            for line in Path(run["log_file"]).read_text("utf-8").splitlines():
                try:
                    event = json.loads(line)
                    item = event.get("item", {})
                    if (event.get("type") != "item.completed" or item.get("type") != "mcp_tool_call"
                            or item.get("server") != "codex_apps" or item.get("tool") != "github.add_comment_to_issue"
                            or item.get("status") != "completed" or item.get("error") is not None):
                        continue
                    args, result = item["arguments"], item["result"]
                    comment_id = result["structured_content"]["id"]
                    if (args.get("repo_full_name") != self.cfg["repo"] or args.get("pr_number") != pr
                            or type(comment_id) is not int or not isinstance(args.get("comment"), str)):
                        continue
                    for comment in comments:
                        if (comment.get("id") == comment_id and comment.get("body") == args["comment"]
                                and reviews._ts(comment.get("created_at")) >= run["started_at"]):
                            found.add(comment_id)
                except (ValueError, TypeError, KeyError, AttributeError):
                    continue
            return found
        except (OSError, UnicodeError, TypeError):
            return set()

    def _complete_producer_fix_events(self, b, maintainer_info=None) -> str | None:
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
                return FixIncomplete("수정 완료 증거가 현재 PR/HEAD에 배정된 fix 실행과 일치하지 않습니다. 리뷰 이벤트는 미완료로 보존했습니다.")
            conflict_keys = [key for key in claim["event_keys"] if key.startswith("conflict:")]
            if conflict_keys:
                current = self.gh.pull(b["pr_number"])
                if (maintainer_info is None or current.get("number") != b["pr_number"]
                        or current.get("state") != "open" or current.get("merged")
                        or current.get("head_ref") != b["branch"]
                        or current.get("base_ref") != self.cfg["base_branch"]
                        or current.get("head_sha") != maintainer_info.get("head_sha")
                        or self.git.registered(Path(b["worktree"])) != b["branch"]
                        or self.git.head(Path(b["worktree"])) != current.get("head_sha")
                        or self.git.remote_head(b["branch"]) != current.get("head_sha")):
                    return "충돌 수정 완료 시 PR/worktree/원격 소유 HEAD가 일치하지 않습니다. 보존합니다."
                if (len(conflict_keys) != 1
                        or not re.fullmatch(r"conflict:[a-f0-9]{40}", conflict_keys[0])
                        or maintainer_info.get("head_sha") == claim["head_sha"]
                        or not self.git.contains(Path(b["worktree"]), claim["head_sha"])
                        or not self.git.contains(Path(b["worktree"]), conflict_keys[0].split(":", 1)[1])):
                    return "충돌 수정 HEAD가 원래 PR HEAD와 기준 커밋을 모두 포함하지 않습니다. worktree와 이벤트를 보존합니다."
            replies = []
            comments = self.gh.issue_comments(b["pr_number"])
            app_reply_ids = self._run_bound_app_replies(run, b["pr_number"], comments)
            for comment in comments:
                user = comment.get("user") if isinstance(comment.get("user"), dict) else {}
                if ((str(user.get("login") or "").casefold() != str(self.cfg["expected_account"]).casefold()
                     and comment.get("id") not in app_reply_ids)
                        or not str(comment.get("body") or "").strip()
                        or reviews._ts(comment.get("created_at")) < run["started_at"]
                        or comment.get("id") is None):
                    continue
                replies.append(comment)
            event_replies = {}
            for comment in replies:
                body_lines = {line.strip() for line in str(comment.get("body") or "").splitlines()}
                for key in claim["event_keys"]:
                    marker = ("WarRoom-CI-Event" if key.startswith("ci:") else
                              "WarRoom-Conflict-Event" if key.startswith("conflict:") else "WarRoom-Review-Event")
                    if (f"{marker}: {key}" in body_lines
                            and (not key.startswith(("ci:", "conflict:")) or (maintainer_info is not None
                                 and maintainer_info.get("head_sha") != claim["head_sha"]
                                 and f"WarRoom-{'CI' if key.startswith('ci:') else 'Conflict'}-Fix-Head: {maintainer_info.get('head_sha')}" in body_lines))):
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
                    return FixIncomplete(f"fix 실행 #{run['id']}의 성공 응답은 확인했지만 PR #{b['pr_number']}에 리뷰 이벤트 키가 표시된 "
                                         "실행 후 답글이 없습니다. 이벤트는 미완료로 보존했습니다. 원인 확인 후 소유자 Retry가 필요합니다.")
                return FixIncomplete(f"fix 실행 #{run['id']}의 PR 답글은 확인했지만 답변 증거가 없는 리뷰 이벤트가 남았습니다: "
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
        except InspectContextFailure:
            raise
        except Exception as e:
            return f"source_context 조회 실패: {e}. 전체 checkpoint를 출력하지 말고 필요한 ID만 inspect 하세요."

    def _to_review(self, b, info, recovery_note: str | None = None) -> None:
        if self._merged_owned_pr(b, info):   # already merged: recover through MERGED→CLEANUP, never back to review
            self._enter_merged(b, info, "기존 소유 PR 재발견:")
            return
        if b["method"] == STAGE2_METHOD:
            self._record_progress(b)   # the verified final checkpoint may be newer than the last producer poll
            self.store.delete(stage2.run_start_key(b["id"]))
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
            if b["method"] == STAGE2_METHOD:
                claim = batches.expected_claim(b)
                found = batches.pr_claims(b, {"number": info["number"], "files": files})
                if found.count(claim) == 1 and len(found) > 1:
                    try:
                        return self._stage2_foreign_paths(b, info, files)
                    except RecoveryBlocked as error:
                        raise FastForwardBlocked(str(error)) from error
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
                    raise FastForwardBlocked(f"PR #{info['number']}의 {self._stage(b)} 산출물 소유권이 샤드와 일치하지 않습니다")
                try:
                    shard = refine.ops(b).validate_pr(info, files)
                except stage3.Stage3Error as error:
                    raise FastForwardBlocked(str(error)) from error
                if shard != b["shard"]:
                    raise FastForwardBlocked(f"PR #{info['number']}의 {self._stage(b)} 샤드가 배치와 일치하지 않습니다")
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
    def _resume_unpushed_stage2_fix(self, b, info, local: str) -> bool:
        """One same-session continuation of a completed fix that left an owned commit unpushed."""
        if b["method"] != STAGE2_METHOD or b["run_kind"] != "fix_new" or not b["session_id"]:
            return False
        try:
            baseline = json.loads(self.store.get(f"s2_fix_start_{b['id']}") or "")
            last = self._last_run(b)
            wt = Path(b["worktree"])
            key = f"s2_unpushed_fix_resume_{b['id']}"
            if (not isinstance(baseline, dict) or baseline.get("branch") != b["branch"]
                    or baseline.get("worktree") != str(wt) or baseline.get("head") != info.get("head_sha")
                    or info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]
                    or info.get("state") != "open" or info.get("merged") or self.store.get(key)
                    or not self._verified_fix_exit(b) or last is None or last["kind"] != "fix_new"
                    or last["session_id"] != b["session_id"] or self.git.registered(wt) != b["branch"]
                    or not self.git.is_ancestor(info["head_sha"], local, path=wt)):
                return False
            current = self.gh.pull(b["pr_number"])
            if (current.get("number") != info["number"] or current.get("head_ref") != b["branch"]
                    or current.get("head_sha") != info["head_sha"] or current.get("state") != "open"
                    or current.get("merged") or self.git.remote_head(b["branch"]) != info["head_sha"]
                    or self.git.head(wt) != local or self.git.dirty(wt).strip()):
                return False
            # _launch records the attempt immediately before spawn, after any asynchronous preflight wait.
            self._launch(b, "fix_resume", [], s2_resume_run_id=last["id"])
            return True
        except (TypeError, ValueError, KeyError):
            return False

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
            if remote == info["head_sha"] and self._resume_unpushed_stage2_fix(b, info, local):
                return "stop"
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
            if b["method"] == MAINTENANCE_METHOD:
                if (info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]
                        or info.get("state") != "open" or info.get("merged")):
                    return self._fail(b, "ERROR", "수정 완료 PR 소유권 또는 상태가 바뀌었습니다. 보존합니다.")
                if problem := self._complete_producer_fix_events(b, info):
                    return self._maintainer_fix_problem(b, problem)
            if b["method"] == STAGE2_METHOD:
                supervised = self._stage2_supervised_fix(b)
                if problem := self._stage2_fix_result_problem(b, info) or (
                        supervised is not None and (Path(b["worktree"]) / S2_FIX_RESPONSE).exists()
                        and self._stage2_record_fix_reply(b, supervised, info["head_sha"])):
                    return self._fail(b, "ERROR", problem)
                self.store.delete(f"s2_fix_start_{b['id']}")
            elif b["method"] == STAGE3_METHOD:
                if problem := self._stage3_fix_completion_problem(b, info):
                    return self._fail(b, "ERROR", problem)
            self._to_review(b, info)

    def _find_pr(self, b):
        """The batch's PR (by its owned branch) or None; raises DuplicateClaim on a rival PR."""
        prs = self.gh.prs_for_branch(b["branch"])
        if not prs:
            return None
        pr = sorted(prs, key=lambda p: p["number"])[-1]
        dup = self._duplicate_claim(b, pr["number"])
        if dup:
            raise DuplicateClaim(f"같은 배치를 다른 열린 PR #{dup}이 점유 — 중복 방지로 중단")
        return self.gh.pull(pr["number"])

    def _duplicate_claim(self, b, my_pr: int, own_claims: set | None = None) -> int | None:
        """A rival open PR on the same shard: one Stage 2/3 PR per shard, since the Relation/Drop files collide."""
        if b["method"] == MAINTENANCE_METHOD:   # an Issue-scoped PR, not a shard batch: the Issue claim is the guard
            return None
        for pr in self.gh.open_prs():
            if pr["number"] == my_pr:
                continue
            try:
                claims = batches.pr_claims(b, pr)
            except batches.BatchError as e:   # unknown file list: a duplicate cannot be ruled out -> stop
                raise DuplicateClaim(f"{e} — 중복 방지로 중단") from e
            if (own_claims or {batches.expected_claim(b)}) & set(claims):
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
        """Failure class of ONE run's log. Codex Fast rejection needs an explicit CLI diagnostic."""
        try:
            text = Path(log_file).read_text("utf-8", errors="replace")[-30000:]
        except OSError:
            text = ""
        if getattr(self._adapter(producer), "name", None) == "claude":
            return classify_claude_failure(log_file, text, self.cfg["quota_patterns"])
        if getattr(self._adapter(producer), "name", None) == "codex":
            return classify_codex_failure(text, self.cfg["quota_patterns"])
        return classify_failure(text, self.cfg["quota_patterns"])

    @staticmethod
    def _fast_unavailable_message(log_file) -> str:
        return ("Codex가 Fast 설정을 지원하지 않는다고 명시했습니다. Fast로 실행하지 않았고 자동 Standard 재시도도 하지 않습니다. "
                "모델·로그인 방식·CLI 지원을 확인한 뒤 프로필을 조정하고 Retry하세요. "
                f"로그: {log_file}")

    def _saved_output_failure(self, b, cls: str) -> bool:
        """Keep known authentication, quota, Fast, and run-pin failures blocking even when a chunk file exists."""
        if cls == "fast_unavailable":
            self._fail(b, "ERROR", self._fast_unavailable_message(b["log_file"]))
            return True
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

    def _accept_stored_output(self, accept, b) -> None:
        """A non-zero exit that left this run's stored output is judged by the success route. The exit marker is kept until
        an outcome commits; once the official save exists, re-entry accepts that saved file (`_reapply_exit_verdict`)."""
        return accept(b)

    def _run_failed(self, b, code: int) -> None:
        cls = self._classify_run(b["producer"], b["log_file"])
        self.store.log(b["id"], f"AI 종료 코드 {code}, 분류={cls}", "warn")
        if b["state"] == "FIXING" and b["method"] == STAGE2_METHOD and b["run_kind"] == "fix_resume":
            return self._fail(b, "ERROR", "Stage 2 리뷰 수정 세션 재개 실패. 새 세션을 시작하지 않고 worktree와 PR을 보존합니다.")
        # A stored chunk can outlive an ordinary non-zero exit, but it never converts a known authentication,
        # quota, or run-pin failure into success.
        safe_to_accept_stored = cls not in ("effort", "auth", "usage_limit", "free_quota", "fast_unavailable")
        if safe_to_accept_stored and self._stage3_chunk_run(b) and b["state"] == "PRODUCING":
            saved = self._stage3_chunk_saved(b)
            answer = self._stage3_answer_only(b)
            if saved or answer:
                reason = "checkpoint 저장" if saved else "완전한 현재 청크 D/L 응답"
                self.store.log(b["id"], f"AI가 비정상 종료했지만 {reason}을 확인해 {self._stage(b)}의 기존 검증·저장 경로로 전달합니다.", "warn")
                if problem := self._saved_chunk_identity_problem(b):
                    if cls == "session_missing":
                        self.store.log(b["id"], f"현재 {self._stage(b)} 응답의 세션 identity가 불충분합니다. 새 세션 재진입 안전성을 확인합니다: {problem[1]}", "warn")
                        if saved:
                            return self._fail(b, "PAUSED", f"저장 청크의 실행 세션을 확인할 수 없어 완료로 인정하지 않습니다. checkpoint와 worktree를 보존합니다: {problem[1]}")
                    else:
                        return self._fail(b, problem[0], f"현재 {self._stage(b)} 응답의 소유권/모델·effort/session 핀 확인 실패: {problem[1]}")
                else:
                    if not self._denials_cleared(b, Path(b["log_file"])):
                        return
                    return self._accept_stored_output(self._run_ok_stage3_chunk, b)
        if safe_to_accept_stored and self._s2_chunk_run(b) and b["state"] == "PRODUCING" and self._stage2_chunk_saved(b):
            self.store.log(b["id"], "AI가 비정상 종료했지만 현재 Stage 2 청크의 checkpoint 저장이 확인되어 재생산하지 않습니다.", "warn")
            if problem := self._saved_chunk_identity_problem(b):
                return self._fail(b, problem[0], f"저장 청크 실행의 소유권/핀 확인 실패: {problem[1]}")
            if not self._denials_cleared(b, Path(b["log_file"])):
                return
            return self._accept_stored_output(self._run_ok_stage2_chunk, b)
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
            return self._accept_stored_output(self._run_ok_stage2_chunk, b)
        chunk_run = (b["method"] == STAGE2_METHOD and isinstance(b["run_kind"], str)
                     and (b["run_kind"].startswith("s2_chunk_") or b["run_kind"] == "s2_repair_new")) \
            or self._stage3_chunk_run(b)
        if b["state"] == "PRODUCING" and not b["pr_number"] and not chunk_run:
            if self._handoff_failed_pr(b, code, cls):
                return
        if cls == "effort":
            return self._fail(b, "ERROR", "CLI가 요청한 모델 또는 추론 수준을 받아들이지 않았습니다 — 다른 값으로 "
                              f"대체하지 않습니다. 로그 확인 후 설정을 고치세요: {b['log_file']}")
        if cls == "fast_unavailable":
            return self._fail(b, "ERROR", self._fast_unavailable_message(b["log_file"]))
        if cls == "session_missing":
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
            return self._fail(b, "PAUSED", "사용량 한도 도달로 보입니다. 이 CLI는 자동 모델 전환을 하지 않습니다 "
                              "(로그 확인 후 Retry).")
        if cls in ("rate_limit", "network"):
            if b["retries"] < self.cfg["rate_limit_retries"]:
                wait = self.cfg["rate_limit_backoff_seconds"] * (2 ** b["retries"])
                self.store.update(b["id"], retries=b["retries"] + 1, retry_after=self.clock() + wait)
                return self.store.log(b["id"], f"{cls}: {wait}s 후 재시도 ({b['retries'] + 1})", "warn")
            return self._fail(b, "PAUSED", f"{cls} 재시도 한도 초과 (무료 한도 소진으로 간주하지 않음)")
        if cls == "auth":
            return self._fail(b, "PAUSED", "인증 실패 — Board 상단의 GitHub 인증 안내를 확인하세요.")
        if b["run_kind"] == "fix_resume":  # session resume impossible -> safe recovery once
            with self.launch_gate.permit():
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

    def _watch(self, b, *, allow_fix: bool = True) -> None:
        b, live = self._reap(b)
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
                if b["method"] == MAINTENANCE_METHOD:
                    if info.get("number") != b["pr_number"] or info.get("head_ref") != b["branch"]:
                        return self._fail(b, "ERROR", "Maintainer PR 소유권이 일치하지 않습니다. 보존합니다.")
                    ci = self.gh.maintainer_ci_failure(b["pr_number"], info["head_sha"], b["branch"])
                    if ci:
                        current = self.gh.pull(b["pr_number"])
                        if (current.get("number") != b["pr_number"] or current.get("head_ref") != b["branch"]
                                or current.get("head_sha") != info["head_sha"] or current.get("state") != "open"
                                or current.get("merged")):
                            return self.store.log(b["id"], "CI 조회 중 PR이 변경되어 다음 감시에서 재확인합니다.", "warn")
                        evs.append(ci)
                    if info.get("mergeable") is False:
                        base_sha = info.get("base_sha")
                        if (info.get("base_ref") != self.cfg["base_branch"] or
                                not isinstance(base_sha, str) or not re.fullmatch(r"[a-f0-9]{40}", base_sha)):
                            return self._fail(b, "ERROR", "충돌 PR의 기준 브랜치 또는 SHA가 유효하지 않습니다. 보존합니다.")
                        evs.append({"kind": "conflict", "author": "Supervisor", "key": f"conflict:{base_sha}",
                                    "body": f"소유 PR HEAD {info['head_sha']}와 기준 {info['base_ref']} {base_sha}의 충돌을 해결한다."})
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
                if b["method"] in (STAGE3_METHOD, MAINTENANCE_METHOD) and not live:
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
                if b["method"] == STAGE2_METHOD and not live and not fresh and evs:
                    redo = self._stage2_unanswered_refix(b, info, evs)
                    if redo is None:
                        return
                    fresh = redo
                if fresh:
                    if b["method"] == MAINTENANCE_METHOD and not allow_fix:
                        pending_key = f"maintenance_review_pending_{b['id']}"
                        self.store.set(pending_key, json.dumps({
                            "pr": b["pr_number"], "head_sha": info["head_sha"],
                            "event_keys": [e["key"] for e in fresh],
                        }, sort_keys=True))
                        return self.store.log_once(
                            b["id"], "Maintainer PR 리뷰 수정은 다른 Issue의 AI 작업이 끝난 뒤 같은 PR/HEAD에서 직렬 실행합니다.")
                    if b["method"] == MAINTENANCE_METHOD:
                        for event in fresh:
                            if event.get("kind") == "ci":
                                event["body"] += "\n" + self.gh.maintainer_ci_diagnostic(event)
                    with self.launch_gate.permit():
                        if b["method"] == MAINTENANCE_METHOD and any(e.get("kind") == "conflict" for e in fresh):
                            wt = Path(b["worktree"])
                            if self.git.registered(wt) != b["branch"] or self.git.dirty(wt).strip():
                                return self._fail(b, "ERROR", "충돌 수정 전 worktree/브랜치 확인 실패. 보존합니다.")
                            if self.git.remote_head(b["branch"]) != info["head_sha"]:
                                # the owned branch moved (or was deleted by a merge) after this poll's snapshot: a
                                # newer push is not damage, so re-read the PR instead of freezing the batch (#5922)
                                self.store.set(f"last_poll_{b['id']}", "0")
                                return self.store.log(b["id"], "충돌 확인 중 원격 브랜치 HEAD가 바뀌어 다시 감시합니다.", "warn")
                            fetched = self.git.fetch_base(info["base_ref"])
                            current = self.gh.pull(b["pr_number"])
                            if (fetched != info["base_sha"] or current.get("base_sha") != fetched
                                    or current.get("head_sha") != info["head_sha"]
                                    or current.get("head_ref") != b["branch"] or current.get("number") != b["pr_number"]
                                    or current.get("base_ref") != info["base_ref"] or current.get("state") != "open"
                                    or current.get("merged") or current.get("mergeable") is not False):
                                self.store.set(f"last_poll_{b['id']}", "0")
                                return self.store.log(b["id"], "충돌 확인 중 PR 또는 기준이 바뀌어 다시 감시합니다.", "warn")
                        self.store.delete(f"maintenance_review_pending_{b['id']}")
                        if b["method"] == STAGE2_METHOD:
                            self._clear_dead_amend_lock(b)
                        self.store.log(b["id"], f"새 리뷰 이벤트 {len(fresh)}건 → 수정 실행")
                        self._launch(b, self._fix_kind(b), fresh)
                elif (b["method"] in (STAGE2_METHOD, STAGE3_METHOD) and not live and info.get("mergeable") is False
                      and not (b["method"] == STAGE2_METHOD and self._stage2_reconcile_task(b))):
                    self._replay_relation_pr(b, info)
                return
        except TRANSIENT as e:
            return self._transient_wait(f"b{b['id']}:watch", e, b["id"])
        except Exception as e:
            return self.store.log(b["id"], f"GitHub 폴링 실패(재시도 예정): {e}", "warn")

    def _replay_relation_pr(self, b, info) -> None:
        """#8784: rebuild an owned Stage 2/3 PR that conflicts with its base by relation-key replay, verify and push it.

        Only a PR whose shared changes are its own shard Relation/Drop files is replayed, once per (PR HEAD, base). Its
        decisions are re-applied key by key onto the latest base by the official CLI (no AI run, no re-judgment); a key the
        latest data changed keeps the latest value. Completed work is never re-checked or reopened by this step."""
        wt, number = Path(b["worktree"]), b["pr_number"]
        base_ref, base_sha, head = info.get("base_ref"), info.get("base_sha"), info.get("head_sha")
        if base_ref != self.cfg["base_branch"] or not re.fullmatch(r"[a-f0-9]{40}", base_sha or ""):
            return self._fail(b, "ERROR", "충돌 PR의 기준 브랜치 또는 SHA가 유효하지 않습니다. 보존합니다.")
        attempt = f"{head}:{base_sha}"
        key = f"relation_replay_{b['id']}"
        if self.store.get(key) == attempt:
            return
        try:
            if (self.git.registered(wt) != b["branch"] or self.git.dirty(wt).strip() or self.git.head(wt) != head
                    or self.git.remote_head(b["branch"]) != head):
                self.store.set(f"last_poll_{b['id']}", "0")
                return self.store.log(b["id"], "relation replay 전 worktree·원격 HEAD가 PR과 달라 다시 감시합니다.", "warn")
            if self.git.fetch_base(base_ref) != base_sha:
                self.store.set(f"last_poll_{b['id']}", "0")
                return self.store.log(b["id"], "relation replay 확인 중 기준 브랜치가 이동해 다시 감시합니다.", "warn")
            self.store.set(key, attempt)
            owned = (refine.spec_for(b).scope(b["shard"], {f.get("path") for f in self.gh.pull_files(number)}
                                              if refine.spec_for(b).cross_shard else ())
                     if b["method"] == STAGE3_METHOD else
                     {f"data/relations/relation-{b['shard']}.jsonl", f"data/relation-drops/drop-{b['shard']}.jsonl"})
            checkpoint = None
            if b["method"] == STAGE2_METHOD:
                bb, pp = stage2.split_key(b["batch"])
                checkpoint = f".warroom-scratch/relation-admission-{b['shard']}-{bb}-{pp}.json"
            new_head, report = self.git.replay_relation_merge(wt, b["branch"], base_ref, base_sha, owned, checkpoint)
            if b["method"] == STAGE2_METHOD:
                ok, detail = self.git.verify_stage2_local(wt, b["shard"], bb, pp, checkpoint=True)
            else:
                ok, detail = self._refine_verify(b, new_head)
            if not ok:
                return self._fail(b, "ERROR", f"relation replay 뒤 verify 실패: {detail}. 미푸시 merge commit과 worktree를 보존합니다.")
            current = self.gh.pull(number)
            if current.get("head_sha") != head or current.get("state") != "open" or current.get("merged"):
                return self._fail(b, "ERROR", "relation replay 중 PR이 이동했습니다. 미푸시 merge commit과 worktree를 보존합니다.")
            self.git.push_owned_fix(wt, b["branch"], head, new_head)
            if self.git.remote_head(b["branch"]) != new_head:
                return self._fail(b, "ERROR", "relation replay push 뒤 원격 HEAD가 다릅니다. 보존합니다.")
            self.store.update(b["id"], head_sha=new_head)
            conflicts = report.get("conflicts")
            if conflicts is None:
                conflicts = [c for file in report.get("files") or [] for c in file.get("conflicts") or []]
            self.store.log(b["id"], f"PR #{number} 기준 {base_sha[:10]}와의 shard 데이터 충돌을 관계 키 replay로 해소: "
                           f"{head[:10]} -> {new_head[:10]}" + (f"; 최신 값 유지 {len(conflicts)}건: {', '.join(conflicts[:10])}"
                                                               if conflicts else ""))
        except TRANSIENT:
            raise
        except (GitError, IntegrationBlocked, FastForwardBlocked, OSError, ValueError, KeyError, TypeError) as error:
            return self._fail(b, "ERROR", f"PR #{number} relation replay 중단: {error}. worktree와 PR을 보존합니다.")

    def _stage2_unanswered_refix(self, b, info, evs) -> list[dict] | None:
        """Stage 2 marks a review event handled when its fix run STARTS. A run that ended with neither a new HEAD (the
        `-1` still applies to this HEAD) nor a reply from our account after it left the review unanswered for ever
        (PR #6249). Re-run the fix once per HEAD; a second silent failure stops the batch (ERROR) with its evidence.
        Returns the events to fix now, [] when nothing is unanswered, or None when the batch was stopped."""
        login = str(self.cfg["expected_account"]).casefold()

        def ours(c) -> bool:
            return (str((c.get("user") or {}).get("login") or "").casefold() == login
                    and bool(str(c.get("body") or "").strip()))

        conversation = [reviews._ts(c.get("created_at")) for c in self.gh.issue_comments(b["pr_number"]) if ours(c)]
        inline = list(self.gh.inline_comments(b["pr_number"]))
        by_id = {c.get("id"): c for c in inline}
        thread_replies = [c for c in inline if ours(c) and c.get("in_reply_to_id") is not None]

        def answered(e) -> bool:
            """A PR conversation comment after the event, or a reply inside THIS review's thread (#6285 reviews);
            a top-level inline comment or one in another review's thread is not an answer."""
            ts = float(e.get("ts") or 0)
            if any(t > ts for t in conversation):
                return True
            rid = e.get("review_id")
            return rid is not None and any(
                reviews._ts(c.get("created_at")) > ts
                and rid in (c.get("pull_request_review_id"),
                            (by_id.get(c.get("in_reply_to_id")) or {}).get("pull_request_review_id"))
                for c in thread_replies)

        pending = [e for e in evs if e.get("kind") in ("review", "comment") and not answered(e)]
        if not pending:
            return []
        key = f"s2_refix_{b['id']}_{info['head_sha']}"
        if int(self.store.get(key) or 0) >= 1:
            self._fail(b, "ERROR", "Stage 2 리뷰 -1이 재수정 뒤에도 새 HEAD와 답글 없이 남았습니다 "
                       f"({', '.join(e['key'] for e in pending)}). worktree·PR·scratch를 보존합니다.")
            return None
        self.store.set(key, "1")
        self.store.log(b["id"], "Stage 2 리뷰 -1이 새 HEAD·답글 없이 남아 있어 같은 HEAD에서 수정을 한 번 더 실행합니다 "
                       f"({', '.join(e['key'] for e in pending)})", "warn")
        return list(evs)   # the same events (with their inline context) the first fix run received

    def _clear_dead_amend_lock(self, b) -> None:
        """An amend that died leaves `<checkpoint>.amend-lock`. Inside the AI sandbox its owner cannot be probed
        (kill/ps are denied), so the CLI must treat it as live and every later amend stops. The Supervisor runs outside
        the sandbox and no AI runs in this worktree now: remove the lock only when its owner pid is provably gone."""
        try:
            bb, pp = stage2.split_key(b["batch"])
            lock = Path(b["worktree"]) / ".warroom-scratch" / f"relation-admission-{b['shard']}-{bb}-{pp}.json.amend-lock"
            owner = lock.read_text("utf-8")
            pid = int(owner.split(":", 1)[0])
        except (OSError, ValueError, KeyError, TypeError):
            return
        if pid <= 0:
            return
        try:
            os.kill(pid, 0)
            return   # the owner still exists (or cannot be probed): keep the lock
        except ProcessLookupError:
            pass
        except OSError:
            return
        try:
            if lock.read_text("utf-8") == owner:
                lock.unlink()
                self.store.log(b["id"], f"종료된 amend(pid {pid})가 남긴 checkpoint amend-lock을 제거했습니다", "warn")
        except OSError:
            pass

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
        if b["method"] == STAGE3_METHOD and not b["pr_number"]:
            return self._cleanup_no_change(b, key)
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
                    if refine.ops(b).validate_pr(info, self.gh.pull_files(b["pr_number"])) != b["shard"]:
                        return self._fail(b, "ERROR", f"머지 {self._stage(b)} PR 파일 범위가 소유 샤드와 다릅니다. worktree를 보존합니다.")
                except stage3.Stage3Error as error:
                    return self._fail(b, "ERROR", f"머지 {self._stage(b)} PR 범위 검증 실패: {error}. worktree를 보존합니다.")
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
        self._finish_cleanup(b)

    def _cleanup_no_change(self, b, key: str) -> None:
        """#9928: a refinement shard completed without changes has no PR; its worktree never committed, so the
        non-force removal of an uncommitted worktree (as for a diagnosis-only Maintainer run) is the whole cleanup."""
        spec = refine.spec_for(b)
        base = self.store.get(spec.nochange_key(b["shard"])) if spec.no_change_complete else None
        if not base:
            return self._fail(b, "ERROR", f"{self._stage(b)} PR 없는 배치에 무변경 완료 기록이 없어 정리하지 않습니다.")
        try:
            self.git.remove_diagnosis_worktree(Path(os.path.abspath(b["worktree"])), b["branch"], base)
        except TRANSIENT as e:
            return self._transient_wait(key, e, b["id"])
        except CleanupBlocked as e:
            return self._fail(b, "ERROR", f"정리 차단(보존): {e}")
        except Exception as e:
            return self._fail(b, "ERROR", f"정리 실패(보존): {e}")
        self._finish_cleanup(b)

    def _finish_cleanup(self, b) -> None:
        self.store.complete_batch(b["id"])
        self._clear_batch_retry(b["id"])
        self.store.delete(f"pr_create_{b['id']}")
        self.store.delete(f"cleanup_proof_{b['id']}")
        if b["method"] == STAGE2_METHOD:
            self.store.delete(stage2.run_start_key(b["id"]))
            self.store.delete(f"s2_reconcile_commit_{b['id']}")
            self.store.delete(f"s2_relation_change_point_{b['id']}")
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
        cached = self.store.get(ok_key)
        try:
            # A restart after the Part success must still finish its boundary scopes before cleanup.
            if cached and not is_reconciliation:
                layout = stage2.read_layout(self.runner, self.paths.repo_root, self.env, cached)
                records = 83 if (b["shard"], bb) == ("428", "02") else 500
                last_part = int(pp) == stage2.part_count(records, layout.size(b["shard"]))
                required = ([stage2.ok_key(b["shard"], bb)] if last_part else [])
                if last_part and bb == "02":
                    required.append(stage2.ok_key(b["shard"], None))
                if all(self.store.get(key) == cached for key in required):
                    return True
            if self.clock() - float(self.store.get(gate, "0")) < self.cfg["poll_seconds"]:
                return False
            self.store.set(gate, str(self.clock()))
            base = self.cfg["base_branch"]
            sha = self.git.fetch_base(base)
            merged = info.get("merge_commit_sha")
            if merged and not self.git.contains_on_base(merged, base):
                self.store.log(b["id"], f"머지 커밋 {merged[:10]}이 아직 origin/{base}에 보이지 않습니다 — 재확인 예정", "warn")
                return False
            layout = stage2.read_layout(self.runner, self.paths.repo_root, self.env, sha)
            records = 83 if (b["shard"], bb) == ("428", "02") else 500
            last_part = int(pp) == stage2.part_count(records, layout.size(b["shard"]))
            scopes = [("part", bb, pp, ok_key)]
            if last_part and not is_reconciliation:
                scopes.append(("batch", bb, None, stage2.ok_key(b["shard"], bb)))
                if bb == "02":
                    scopes.append(("shard", None, None, stage2.ok_key(b["shard"], None)))
            for kind, batch, part, key in scopes:
                if self.store.get(key) == sha and not is_reconciliation:
                    continue
                ok, tail = self.git.verify_stage2(sha, kind, b["shard"], batch, part)
                if not ok:
                    self._fail(b, "ERROR", f"PR #{info['number']} 머지 후 최신 master에서 {kind} "
                               f"{stage2.label(b['shard'], b['batch'])} verify가 실패했습니다: {tail}. "
                               "worktree를 보존하고 다음 Part를 시작하지 않습니다 (확인 후 Retry).")
                    self.store.set(gate, "0")
                    return False
                self.store.set(key, sha)
                self.store.log(b["id"], f"최신 master {sha[:10]}에서 {kind} "
                               f"{stage2.label(b['shard'], b['batch'])} verify 통과")
        except Exception as e:
            self.store.log(b["id"], f"머지 후 verify 준비 실패(재시도 예정): {e}", "warn")
            return False
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
                self._fail(b, "ERROR", f"{self._stage(b)} PR merge commit SHA를 확인할 수 없어 완료 처리하지 않습니다.")
                return False
            if not self.git.contains_on_base(merge_sha, base):
                self.store.log(b["id"], f"머지 커밋 {merge_sha[:10]}이 아직 origin/{base}에 보이지 않습니다 — 재확인 예정", "warn")
                return False
            if self.store.get(refine.ops(b).ok_key(b["shard"])) == sha:
                return True
            ok, detail = self.git.verify_stage2(sha, "shard", b["shard"], None, None)
        except TRANSIENT as error:
            self._transient_wait(gate, error, b["id"])
            return False
        except Exception as error:
            self.store.log(b["id"], f"머지 후 {self._stage(b)} shard verify 준비 실패(재시도 예정): {error}", "warn")
            return False
        if not ok:
            self._fail(b, "ERROR", f"PR #{info['number']} 머지 후 최신 master에서 샤드 {b['shard']} verify 실패: "
                       f"{detail}. worktree를 보존하고 확인 후 Retry 하세요.")
            self.store.set(gate, "0")
            return False
        self.store.set(refine.ops(b).ok_key(b["shard"]), sha)
        self.store.log(b["id"], f"최신 master {sha[:10]}에서 {self._stage(b)} 샤드 {b['shard']} verify 통과")
        return True

    def _parallel_maintenance(self) -> None:
        # The Maintainer owns a distinct lane; it may non-blockingly acquire a production L1.
        with self._maintenance_lane:
            try:
                self._tick_maintenance(collection_only=self._drain.is_set())
            except Exception:
                self.store.log(None, "Maintainer 실행/PR 감시 예외:\n" + traceback.format_exc()[-800:],
                               "error", line="maintainer")
            if self._drain.is_set():
                return   # draining: only the collection above; no diagnosis, Issue, review-fix or production
            self.maint.step()

    def _parallel_cycle(self, pool, pending: dict, cursor: int, workers: int) -> int:
        """Coordinate one fixed-interval turn; no worker job is queued beyond available slots.

        RUNNING submits every lane; STOPPING submits nothing (in-flight Workers only return)."""
        self.store.set("heartbeat", str(self.clock()))
        self._handle_reload()
        self.store.fire_due_drain_schedules(self.clock(), control.board_line_keys(self.store, self.cfg))
        for b in self.store.incomplete_batches():
            if not control.retired(b, self.cfg):
                self.store.line(b["producer"], b["method"])
        for key, future in list(pending.items()):
            if not future.done():
                continue
            del pending[key]
            self._submitted_at.pop(key, None)
            self._slow_logged.discard(key)
            try:
                future.result()
            except LaunchDenied:
                self._freeze(key)
            except Exception:
                label = "Maintainer" if key is None else f"{key[0]}/{key[1]}"
                self.store.log(None, f"{label} worker 예외:\n" + traceback.format_exc()[-800:], "error", line=label)
        now = time.monotonic()
        for key, started in self._submitted_at.items():   # one line per long job, no per-Task logging or DB writes
            if key in pending and key not in self._slow_logged and now - started > 2 * self._interval:
                self._slow_logged.add(key)
                label = "maintainer" if key is None else f"{key[0]}/{key[1]}"
                self.store.log(None, f"Line job이 {2 * self._interval:g}초(2×interval)를 넘어 실행 중입니다: {label}", "warn", line=label)
        if self._stopping():
            return cursor
        keys = [(ln["model"], ln["method"]) for ln in self.store.lines()
                if ln["method"] != MAINTENANCE_METHOD and not control.retired(ln, self.cfg)]
        keys.append(None)
        offset = cursor % len(keys)
        for key in keys[offset:] + keys[:offset]:
            if self._frozen_skips(key):
                continue
            if len(pending) >= workers:
                break
            if key in pending:
                continue
            pending[key] = (pool.submit(self._parallel_maintenance) if key is None
                            else pool.submit(self._tick_line, *key))
            self._submitted_at[key] = time.monotonic()
        return (offset + 1) % len(keys)

    def run_parallel(self, interval: float = 5.0, *, stop_event) -> None:
        """The workers>1 production loop: one Coordinator thread plus up to `supervisor_workers` Line Workers."""
        workers = self.cfg.get("supervisor_workers", 1)
        if type(workers) is not int or not 1 <= workers <= 16 or interval <= 0:
            raise ValueError("invalid parallel coordinator configuration")
        self._interval = interval
        pending = {}
        cursor, deadline = 0, time.monotonic()
        with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="warroom-line") as pool:
            while not stop_event.is_set():
                try:
                    cursor = self._parallel_cycle(pool, pending, cursor, workers)
                except Exception:
                    self.store.log(None, "parallel coordinator 예외:\n" + traceback.format_exc()[-800:], "error")
                if self._submit_hold:
                    if not pending:   # STOPPING and every in-flight Worker returned: leave now, the lock goes with us
                        self.store.log(None, "Restart: 진행 중 Worker가 모두 반환되어 이 instance를 종료합니다")
                        return
                    stop_event.wait(min(interval, 0.5))   # only waiting for Workers to return: look again soon
                    continue
                deadline += interval
                now = time.monotonic()
                if deadline < now:
                    deadline = now + interval
                stop_event.wait(max(0, deadline - now))

    # ---- daemon --------------------------------------------------------
    def run_forever(self, interval: float = 5.0) -> None:
        while True:
            if self._stopping():   # checked BEFORE every dispatch: the serial loop has no in-flight Worker between ticks
                self.store.log(None, "Restart: 이 instance를 종료합니다")
                return
            try:
                self.tick()
            except Exception:
                self.store.log(None, "supervisor tick 예외:\n" + traceback.format_exc()[-800:], "error")
            if self._stop_seen:
                continue   # STOPPING arrived during the tick: leave now instead of sleeping first
            time.sleep(interval)


def startup_refusal(fence, workers: int) -> str | None:
    """workers=1 keeps the plain serial Runner, so an unresolved earlier child must stop the start instead of being ignored."""
    if workers != 1 or fence is None:
        return None
    held = fence.unresolved()
    if not held:
        return None
    lines = []
    for item in held:
        e = item["entry"] if isinstance(item["entry"], dict) else {}
        lines.append(f"resource={','.join(item['resources'])} instance={item['instance']} pid={e.get('pid')} "
                     f"pgid={e.get('pgid')} marker={item['path']} 판정={item['verdict'].state}: {item['verdict'].reason}")
    return "이전 인스턴스의 Git/Node 자식이 해소되지 않아 시작할 수 없습니다 (기록 삭제는 안전 증명이 아님):\n  " + "\n  ".join(lines)


def build(paths=None, fence=None):
    """Wire the production Supervisor. `fence` (already scanned) protects git/node when several Workers run."""
    import os as _os

    from .adapters import ClaudeCodeAdapter, CodexCLIAdapter
    from .config import Paths, load_config, retired_notice
    from .gitops import Git
    from .github import GhClient
    from .shell import FencedRunner, Runner
    from .store import Store
    paths = paths or Paths()
    paths.ensure()
    cfg = load_config(paths)
    problem = config_problem(cfg)   # the same check a reload applies: never start on a config a reload would refuse
    if problem:
        raise SystemExit(f"config.json 오류: {problem}")
    env = auth.build_env(dict(_os.environ), paths.gh_config, cfg["git_name"], cfg["git_email"])
    refusal = startup_refusal(fence, cfg["supervisor_workers"])
    if refusal:
        raise SystemExit(refusal)
    runner = Runner()
    plain = runner   # gh and every non-git/node command, and the whole serial (workers=1) path
    if fence is not None and cfg["supervisor_workers"] > 1:
        runner = FencedRunner(plain, fence, paths.worktrees)
    adapters = {"claude": ClaudeCodeAdapter(cfg["claude_bin"]), "codex": CodexCLIAdapter(cfg["codex_bin"])}
    store = Store(paths.db)
    if notice := retired_notice(cfg):
        store.log(None, notice, "warn")
    if retired := control.retired_rows(store, cfg):
        store.log(None, f"지원 종료된 Line/배치 {len(retired)}건은 조회만 하고 실행하지 않습니다 (#9933): "
                  + ", ".join(sorted({f"{r['producer'] if 'producer' in r.keys() else r['model']}/{r['method']}" for r in retired})),
                  "warn")
    return Supervisor(paths, cfg, store, runner, adapters,
                      GhClient(runner, env, cfg["repo"]),
                      Git(runner, paths.repo_root, env, paths.worktrees, fence=fence), env, fence=fence)


def main() -> int:
    import sys

    from .config import Paths, RootError, check_runtime_root
    try:
        root = check_runtime_root()
    except RootError as e:
        print(f"[supervisor] 시작 거부: {e}", file=sys.stderr)
        return 1
    paths = Paths(repo_root=root)
    paths.ensure()
    lock = acquire_lock(paths.lock)
    if lock is None:
        print("War Room supervisor가 이미 실행 중입니다.")
        return 1
    paths.runtime_root_file.write_text(str(root), "utf-8")   # lets a launcher spot a live Supervisor from another checkout
    from .fence import Fence
    fence = Fence(paths.children).open()
    fence.scan_previous()   # before any Lane action or start log, whatever the Worker count (#3773)
    try:
        sup = build(paths, fence)
    except SystemExit as refused:
        for line in fence.drain_reports():
            print(f"[supervisor] {line}", file=sys.stderr)
        print(f"[supervisor] 시작 거부: {refused.code}", file=sys.stderr)
        return 1
    from .restart_controller import record_runtime
    workers = sup.cfg["supervisor_workers"]
    # Order (#3774): lock -> instance -> fence scan (above) -> startup checks (build) -> this instance's phase and runtime
    # record, naming the workers it ACTUALLY runs -> the first Coordinator/Line dispatch.
    sup.begin_instance()
    record_runtime(paths, sup.code_sha, configured_workers=workers, workers=workers, instance=sup.phase_instance)
    sup.store.log(None, f"supervisor 시작 (workers={workers}, instance={sup.phase_instance[:8]})")
    if workers > 1:
        sup.run_parallel(stop_event=threading.Event())
    else:
        sup.run_forever()   # workers=1: the serial regression/fallback path
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
