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
import os
import re
import time
import traceback
from pathlib import Path

from . import auth, batches, control, prompts, reviews
from .adapters import PREFLIGHT_PENDING, RunSpec, classify_failure
from .config import (TIERED_ADAPTERS, adapter_label, config_problem, load_config, registry, registry_problems,
                     reload_problem, run_spec)
from .gitops import CleanupBlocked, GitError
from .store import LineBusy, LineNotRunnable


class DuplicateClaim(Exception):
    pass


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
        b = self.store.active_batch(model, method)
        if ln["force_stop"]:
            self.store.set_line(model, method, force_stop=0)
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
        self.store.log(b["id"], msg, "error")

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
        ln = self.store.line(b["producer"], b["method"])
        if not self._reap_stopped(b):
            # Stop is pending: Retry is not honoured (and not remembered) while the old AI lives.
            if ln["retry_batch"] is not None:
                self.store.set_line(b["producer"], b["method"], retry_batch=None)
            return
        if ln["retry_batch"] != b["id"] and self._recover_if_merged(b):
            return
        if ln["retry_batch"] == b["id"]:
            self.store.set_line(b["producer"], b["method"], retry_batch=None, run=1)
            self.store.update(b["id"], state=b["paused_from"] or "PRODUCING", error=None,
                              retries=0, retry_after=None)
            self.store.log(b["id"], f"운영자 재시도: {b['paused_from']}로 복귀")

    def _recover_if_merged(self, b) -> bool:
        """ERROR/PAUSED batch whose PR was merged later: resume at MERGED (no AI run); cleanup keeps every safety gate.

        Only GitHub `merged=true` recovers; any other error is untouched. A batch that already failed in CLEANUP is not
        retried automatically (its worktree needs the operator), and lookups are limited to one per
        poll_seconds (at least 60s) so errored batches do not burn GitHub rate limit.
        """
        if not b["pr_number"] or b["paused_from"] == "CLEANUP" or b["pid"] is not None:
            return False
        key = f"last_merge_check_{b['id']}"
        if self.clock() - float(self.store.get(key, "0")) < max(self.cfg["poll_seconds"], 60):
            return False
        self.store.set(key, str(self.clock()))
        try:
            info = self.gh.pull(b["pr_number"])
        except Exception as e:
            self.store.log(b["id"], f"오류 배치 머지 재확인 실패(재시도 예정): {e}", "warn")
            return False
        if not info["merged"]:
            return False
        self.store.update(b["id"], state="MERGED", merged=1, head_sha=info["head_sha"], error=None, retries=0,
                          retry_after=None)
        self.store.log(b["id"], f"{b['state']} 상태였으나 PR #{b['pr_number']} merged=true 확인 → 정리 단계로 자동 복구 (AI 재실행 없음)")
        return True

    def _force_stop(self, b) -> None:
        ad = self._adapter(b["producer"])
        if b["pid"] and ad.alive(b["pid"]):
            ad.stop(b["pid"])   # keep the PID: it is cleared only after exit is confirmed
        self.store.set_line(b["producer"], b["method"], run=0, retry_batch=None)  # Stop wins over Retry
        self.store.update(b["id"], retry_after=None)
        self._fail(b, "PAUSED", "강제 중지됨. worktree·브랜치·PR은 보존됨 (프로세스 종료 확인 후 Retry로 재개).")
        self._reap_stopped(self.store.batch(b["id"]))

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
        d = auth.diagnose(self.runner, self.env, self.cfg["repo"], self.cfg["expected_account"])
        if not d["ok"]:
            return self._blocked(ln, "시작 차단: " + "; ".join(d["problems"]))
        problem = self._preflight(model)
        if problem and problem.startswith(PREFLIGHT_PENDING):
            return   # the CLI check runs in the background: this Line waits here, the others keep moving
        if problem:
            return self._blocked(ln, "시작 차단: " + problem)
        try:
            self.git.fetch_base(self.cfg["base_branch"])
            nb = batches.next_batch(
                self.runner, self.paths.repo_root, self.env,
                ref=f"origin/{self.cfg['base_branch']}", method=method, producer=model,
                open_prs=self.gh.open_prs(),
                owned=self.store.claimed_keys(method, None if batches.is_shared_queue(method) else model))
        except Exception as e:  # BatchError, GitError, GhError
            return self._blocked(ln, f"배치 선정 실패: {e}")
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

    def _tiered(self, producer: str) -> bool:
        """Free/Go tiers and the automatic quota switch belong to the producer's CLI (OpenCode only)."""
        return registry(self.cfg)[producer]["adapter"] in TIERED_ADAPTERS

    def _adapter_problem(self, producer: str) -> str | None:
        """Start is refused, never redirected, when this build has no adapter for the producer's CLI."""
        name = registry(self.cfg)[producer]["adapter"]
        if isinstance(self.adapter, dict) and name not in self.adapter:
            return f"{adapter_label(name)} CLI 어댑터가 이 War Room 빌드에 없습니다 — 다른 CLI로 대신 실행하지 않습니다."
        return None

    def _preflight(self, producer: str) -> str | None:
        """Fail closed before any process starts: the CLI must be able to run exactly the pinned model and effort."""
        problem = self._adapter_problem(producer)
        if problem:
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
            runs = self._pinned_runs(producer)
        except ValueError as e:
            return str(e)
        return ad.preflight(self.runner, self.env, runs)

    def _pinned_runs(self, producer: str):
        """Every model/effort this producer may run with: both tiers of a tiered CLI (a configured Go model too)."""
        if not self._tiered(producer):
            return [run_spec(self.cfg, producer)]
        go = registry(self.cfg)[producer]["models"].get("go")
        return [run_spec(self.cfg, producer, "free")] + ([run_spec(self.cfg, producer, "go")] if go else [])

    def _prepare_existing(self, b) -> None:
        wt = Path(b["worktree"])
        try:
            if not wt.exists():
                self.git.fetch_base(self.cfg["base_branch"])
                self.git.create_worktree(wt, b["branch"], self.cfg["base_branch"])
            elif self.git.registered(wt) != b["branch"]:
                return self._fail(b, "ERROR", f"worktree가 있지만 소유 확인 불가: {wt}")
        except GitError as e:
            return self._fail(b, "ERROR", f"worktree 준비 실패: {e}")
        self._launch(b, "produce")

    # ---- launching runs ------------------------------------------------
    def _run(self, b) -> RunSpec:
        """The model and effort this batch's next run is pinned to (the current tier for OpenCode)."""
        return run_spec(self.cfg, b["producer"], b["model_tier"])

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

    def _launch(self, b, kind: str, events=None) -> None:
        """kind: produce | fix_resume | fix_new | produce_resume | produce_recover"""
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
        problem = self._preflight(b["producer"])   # every launch proves the CLI again (cached once proven)
        if problem and problem.startswith(PREFLIGHT_PENDING):
            return   # still proving the pin in the background; the next tick retries this relaunch
        if problem:
            return self._fail(b, "ERROR", f"실행 전 확인 실패: {problem}")
        extra = {}
        if getattr(ad, "needs_git_dir", False):   # one rule for every launch kind: the owned worktree's Git admin dir
            try:
                extra["git_dir"] = self.git.worktree_gitdir(Path(wt))
            except Exception as e:
                return self._fail(b, "ERROR", f"worktree의 Git 관리 디렉터리를 확인할 수 없어 AI를 시작하지 않았습니다: {e}")
        try:
            if kind == "produce":
                h = ad.start(prompts.produce(b), wt, self.env, run,
                                       f"{b['method'].upper()} {b['shard']}_{b['batch']}", log, ex, **extra)
            elif kind == "produce_resume":
                h = ad.resume(sid, prompts.recovery(b), wt, self.env, run, log, ex, **extra)
            elif kind == "produce_recover":
                h = ad.start(prompts.recovery(b), wt, self.env, run,
                                       f"{b['method'].upper()} {b['shard']}_{b['batch']} recover", log, ex, **extra)
            elif kind == "fix_resume":
                h = ad.resume(sid, prompts.fix(b, events, True), wt, self.env, run, log, ex, **extra)
            else:  # fix_new
                h = ad.start(prompts.fix(b, events, False), wt, self.env, run,
                                       f"PR {b['pr_number']} fix", log, ex, **extra)
        except prompts.PromptError as e:   # rendered before any process is started
            return self._fail(b, "ERROR", f"프롬프트 오류로 AI를 시작하지 않았습니다: {e}")
        except Exception as e:
            return self._fail(b, "ERROR", f"AI 실행 시작 실패: {e}")
        self.store.set(f"headlag_{b['id']}", "")   # a new run supersedes any earlier push verification
        state = "FIXING" if kind.startswith("fix") else "PRODUCING"
        fields = dict(state=state, pid=h.pid, exit_file=str(ex), log_file=str(log),
                      run_kind=kind, retry_after=None, error=None)
        if kind == "fix_new" or kind in ("produce", "produce_recover"):
            fields["session_id"] = None  # captured from the new run's log
        self.store.update(b["id"], **fields)
        self.store.add_run(b["id"], kind, fields.get("session_id", sid), h.pid, log, ex,
                           model=run.model, effort=run.effort, permission_profile=run.permission_profile)
        if events:  # claim only after the run really started
            self.store.mark_handled(b["id"], b["pr_number"], b["head_sha"], [e["key"] for e in events])
        tier = f", tier={b['model_tier']}" if self._tiered(b["producer"]) else ""
        self.store.log(b["id"], f"{state} 시작 ({kind}, model={run.model}, effort={run.effort}{tier})")

    def _relaunch(self, b) -> None:
        kind = b["run_kind"] or "produce"
        base = "fix" if kind.startswith("fix") else "produce"
        if base == "fix":
            return self._launch(b, "fix_resume" if b["session_id"] else "fix_new", self._all_events(b))
        self._launch(b, "produce_resume" if b["session_id"] else "produce_recover")

    # ---- PRODUCING / FIXING -------------------------------------------
    def _poll_run(self, b) -> None:
        if b["pid"] is None:  # backoff elapsed, or operator Retry after PAUSED/ERROR
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
        problem = ad.run_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"])
        if problem:   # the CLI contradicts its pins: stop it, keep worktree/PR, wait for the operator
            state, msg = problem
            if ad.alive(b["pid"]):
                ad.stop(b["pid"])
            return self._fail(b, state, msg)
        if ad.alive(b["pid"]):
            if b["state"] == "PRODUCING":
                self._adopt_pr_while_running(b)
            return
        code = ad.exit_code(Path(b["exit_file"]))
        self.store.update(b["id"], pid=None)
        self.store.finish_runs(b["id"], code)
        b = self.store.batch(b["id"])
        if code is None:
            return self._fail(b, "ERROR", "AI 프로세스가 종료 상태 기록 없이 사라졌습니다. "
                              "자동 재생산하지 않음 — worktree/PR 확인 후 Retry.")
        if code == 0:
            # Accept the result only with the run's own evidence (for Claude: the session its init event reported;
            # for Codex: its thread id and its turn record).
            problem = ad.completion_problem(Path(b["log_file"]), self._recorded_run(b), b["session_id"],
                                            b["worktree"], self.env)
            if problem:
                return self._fail(b, problem[0], problem[1])
            return self._run_ok(b)
        self._run_failed(b, code)

    def _record_progress(self, b) -> None:
        f = Path(b["worktree"]) / "data/relation-candidates" / b["shard"] / \
            f"{b['shard']}_{b['batch']}_{b['method']}_{b['producer']}.jsonl"
        try:
            with open(f, "rb") as fh:
                n = sum(1 for _ in fh)
        except OSError:
            return
        if n != b["records_done"]:
            self.store.update(b["id"], records_done=n)

    def _run_ok(self, b) -> None:
        try:
            if b["state"] == "PRODUCING":
                info = self._find_pr(b)
                if info is None:
                    refusal = self._adapter(b["producer"]).policy_refusal(Path(b["log_file"]))
                    if refusal:   # the local CLI policy stopped the PR step: keep everything, wait for the operator
                        return self._fail(b, "PAUSED", f"{refusal}. PR이 만들어지지 않았습니다. 로컬 설정을 확인한 뒤 "
                                          "Retry 하세요 (worktree·브랜치·세션 보존).")
                    return self._fail(b, "ERROR", "AI가 정상 종료했지만 PR을 찾지 못했습니다 "
                                      "(자동 재생산 안 함, 로그 확인 후 Retry).")
            else:
                info = self.gh.pull(b["pr_number"])
        except DuplicateClaim as e:
            return self._fail(b, "ERROR", str(e))
        except Exception as e:
            return self._fail(b, "ERROR", f"GitHub 조회 실패: {e}")
        if b["state"] == "FIXING":
            if self._check_fix_head(b, info) != "ok":
                return
            if info["head_sha"] == b["head_sha"]:
                self.store.log(b["id"], "수정 실행이 끝났지만 새 HEAD 없음 (코멘트로만 응답했을 수 있음)", "warn")
        self._to_review(b, info)

    def _to_review(self, b, info) -> None:
        self.store.update(b["id"], state="WAITING_REVIEW", pr_number=info["number"],
                          head_sha=info["head_sha"], error=None, retries=0)
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
            self.store.set(key, "expired")   # Retry re-verifies (no AI run) with a fresh window
            self._fail(b, "ERROR", f"PR HEAD 메타데이터 반영 지연 시간 초과({self.cfg['pr_head_lag_timeout_seconds']}s): {what}. "
                       "worktree·원격 브랜치 보존, 수동 확인 후 Retry(AI 재실행 없이 재확인).")
            return "stop"
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
        except Exception as e:
            if self._head_lag_wait(b, key, f"GitHub 조회 실패({e})") == "wait":
                self.store.log(b["id"], f"PR 재조회 실패(재시도 예정): {e}", "warn")
            return
        if self._check_fix_head(b, info) == "ok":
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

    def _adopt_pr_while_running(self, b) -> None:
        """PR existence is independent of AI liveness: hand over to review watching
        even if the AI keeps running (e.g. waiting for merge); the process is
        coordinated/stopped before any fix run (see _watch). A CLI with requires_session_for_pr (Claude, Codex) is not
        taken over from before it reported its session, so a run without its own evidence is not adopted."""
        ad = self._adapter(b["producer"])
        if ad.requires_final_result_for_pr:   # the run is not verified until it exits: no review, merge or cleanup yet
            return
        if ad.requires_session_for_pr and not b["session_id"]:
            return
        last = float(self.store.get(f"last_poll_{b['id']}", "0"))
        if self.clock() - last < self.cfg["poll_seconds"]:
            return
        self.store.set(f"last_poll_{b['id']}", str(self.clock()))
        try:
            info = self._find_pr(b)
        except DuplicateClaim as e:
            return self._fail(b, "ERROR", str(e))
        except Exception as e:
            return self.store.log(b["id"], f"PR 조회 실패(재시도 예정): {e}", "warn")
        if info is None:
            return
        self.store.update(b["id"], state="WAITING_REVIEW", pr_number=info["number"],
                          head_sha=info["head_sha"], error=None, retries=0)
        self.store.set(f"last_poll_{b['id']}", "0")
        self.store.log(b["id"], f"AI 실행 중이지만 PR #{info['number']} 감지 → 리뷰 감시로 인계")

    def _duplicate_claim(self, b, my_pr: int) -> int | None:
        """A rival open PR on the same batch file: same model for A/B, any model for the shared C/D queue."""
        shared = batches.is_shared_queue(b["method"])
        for pr in self.gh.open_prs():
            if pr["number"] == my_pr:
                continue
            try:
                claims = batches.pr_candidates(pr)
            except batches.BatchError as e:   # unknown file list: a duplicate cannot be ruled out -> stop
                raise DuplicateClaim(f"{e} — 중복 방지로 중단") from e
            for shard, batch, method, who in claims:
                if (shard, batch, method) == (b["shard"], b["batch"], b["method"]) and (shared or who == b["producer"]):
                    return pr["number"]
        return None

    def _run_failed(self, b, code: int) -> None:
        try:
            text = Path(b["log_file"]).read_text("utf-8", errors="replace")[-30000:]
        except OSError:
            text = ""
        cls = classify_failure(text, self.cfg["quota_patterns"])
        self.store.log(b["id"], f"AI 종료 코드 {code}, 분류={cls}", "warn")
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
                self.store.log(b["id"], "무료 한도 소진 확인 → Go 모델로 전환")
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
        fresh = [e for e in evs if not self.store.is_handled(b["id"], b["pr_number"], info["head_sha"], e["key"])]
        if fresh and live:
            # Never run two AI processes in one worktree: stop the old one, confirm exit
            # on a following tick, then start the fix run.
            self._adapter(b["producer"]).stop(b["pid"])
            self.store.set(f"last_poll_{b['id']}", "0")
            return self.store.log(b["id"], "새 리뷰 이벤트 — 실행 중인 AI 종료 요청, 종료 확인 후 수정 실행")
        if fresh:
            self.store.log(b["id"], f"새 리뷰 이벤트 {len(fresh)}건 → 수정 실행")
            self._launch(b, "fix_resume" if b["session_id"] else "fix_new", fresh)

    # ---- MERGED / CLEANUP / COMPLETE ---------------------------------
    def _to_cleanup(self, b) -> None:
        try:
            info = self.gh.pull(b["pr_number"])
        except Exception as e:
            return self.store.log(b["id"], f"머지 재확인 실패: {e}", "warn")
        if not info["merged"]:
            return self._fail(b, "ERROR", "merged=true가 재확인되지 않아 정리하지 않습니다.")
        self.store.update(b["id"], state="CLEANUP", head_sha=info["head_sha"])

    def _cleanup(self, b) -> None:
        ad = self._adapter(b["producer"])
        if b["pid"] and ad.alive(b["pid"]):
            ad.stop(b["pid"])
            return self.store.log(b["id"], "남은 AI 프로세스 정지 요청, 종료 확인 대기")
        try:
            info = self.gh.pull(b["pr_number"])
            if not info["merged"]:
                return self._fail(b, "ERROR", "merged=true 아님 — 정리하지 않음")
            self.git.remove_owned(Path(b["worktree"]), b["branch"], info["head_sha"])
        except CleanupBlocked as e:
            return self._fail(b, "ERROR", f"정리 차단(보존): {e}")
        except Exception as e:
            return self._fail(b, "ERROR", f"정리 실패(보존): {e}")
        self.store.update(b["id"], state="COMPLETE", error=None)
        self.store.finish_runs(b["id"], None)
        self.store.log(b["id"], f"배치 {b['shard']}_{b['batch']} 정리 완료")
        ln = self.store.line(b["producer"], b["method"])
        if ln["mode"] != "continuous" or ln["drain"] or ln["drain_once"]:
            # Single batch done, this Line's Drain took effect, or Drain All asked this Line to finish.
            self.store.set_line(b["producer"], b["method"], run=0, drain=0, drain_once=0)

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
