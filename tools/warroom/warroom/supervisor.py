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
from .config import TIERED_ADAPTERS, adapter_label, registry, registry_problems, run_spec
from .gitops import CleanupBlocked, GitError
from .store import LineBusy


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
        for b in self.store.incomplete_batches():  # a Line row always exists for a live batch
            self.store.line(b["producer"], b["method"])
        for ln in self.store.lines():
            try:
                self._tick_line(ln["model"], ln["method"])
            except Exception:  # one Line's failure never stalls the others
                self.store.log(None, f"line {ln['model']}/{ln['method']} 예외:\n"
                               + traceback.format_exc()[-800:], "error", line=f"{ln['model']}/{ln['method']}")

    def _tick_line(self, model: str, method: str) -> None:
        ln = self.store.line(model, method)
        b = self.store.active_batch(model, method)
        if ln["force_stop"]:
            self.store.set_line(model, method, force_stop=0)
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
        if ln["retry_batch"] == b["id"]:
            self.store.set_line(b["producer"], b["method"], retry_batch=None, run=1)
            self.store.update(b["id"], state=b["paused_from"] or "PRODUCING", error=None,
                              retries=0, retry_after=None)
            self.store.log(b["id"], f"운영자 재시도: {b['paused_from']}로 복귀")

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
                                          model_tier=ln["model_tier"], records_total=nb.records)
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

    @staticmethod
    def _pin_drift(b, run: RunSpec, tiered: bool, runs) -> str | None:
        """Every relaunch of a batch (resume, recovery, fix) runs on the pin its last recorded run used.

        Applies to all relaunch kinds, including a fresh session after a lost session id. OpenCode may legitimately
        change its model (Free -> Go) mid-batch, so only its effort is compared there.
        """
        prev = next((r for r in runs if r["effort"]), None)
        if prev is None:   # a run from before pins were recorded: nothing to compare with
            return None
        if prev["effort"] != run.effort or (not tiered and prev["model"] != run.model):
            return (f"실행 설정 변경 차단: 기록된 실행 설정 {prev['model']} / {prev['effort']} 과 현재 설정 "
                    f"{run.model} / {run.effort} 이 다릅니다. 설정을 되돌리고 Supervisor를 재시작한 뒤 Retry 하세요.")
        return None

    def _launch(self, b, kind: str, events=None) -> None:
        """kind: produce | fix_resume | fix_new | produce_resume | produce_recover"""
        ts = int(self.clock())
        log, ex = self.paths.logs / f"batch-{b['id']}-{ts}.log", self.paths.logs / f"batch-{b['id']}-{ts}.exit"
        wt = b["worktree"]
        sid = b["session_id"]
        ad = self._adapter(b["producer"])
        try:   # never run with a CLI default model or effort
            run = self._run(b)
        except ValueError as e:
            return self._fail(b, "ERROR", f"실행 설정 오류로 AI를 시작하지 않았습니다: {e}")
        drift = self._pin_drift(b, run, self._tiered(b["producer"]), self.store.runs(b["id"]))
        if drift:
            return self._fail(b, "ERROR", drift)
        problem = self._preflight(b["producer"])   # every launch proves the CLI again (cached once proven)
        if problem and problem.startswith(PREFLIGHT_PENDING):
            return   # still proving the pin in the background; the next tick retries this relaunch
        if problem:
            return self._fail(b, "ERROR", f"실행 전 확인 실패: {problem}")
        try:
            if kind == "produce":
                h = ad.start(prompts.produce(b), wt, self.env, run,
                                       f"{b['method'].upper()} {b['shard']}_{b['batch']}", log, ex)
            elif kind == "produce_resume":
                h = ad.resume(sid, prompts.recovery(b), wt, self.env, run, log, ex)
            elif kind == "produce_recover":
                h = ad.start(prompts.recovery(b), wt, self.env, run,
                                       f"{b['method'].upper()} {b['shard']}_{b['batch']} recover", log, ex)
            elif kind == "fix_resume":
                h = ad.resume(sid, prompts.fix(b, events, True), wt, self.env, run, log, ex)
            else:  # fix_new
                h = ad.start(prompts.fix(b, events, False), wt, self.env, run,
                                       f"PR {b['pr_number']} fix", log, ex)
        except prompts.PromptError as e:   # rendered before any process is started
            return self._fail(b, "ERROR", f"프롬프트 오류로 AI를 시작하지 않았습니다: {e}")
        except Exception as e:
            return self._fail(b, "ERROR", f"AI 실행 시작 실패: {e}")
        state = "FIXING" if kind.startswith("fix") else "PRODUCING"
        fields = dict(state=state, pid=h.pid, exit_file=str(ex), log_file=str(log),
                      run_kind=kind, retry_after=None, error=None)
        if kind == "fix_new" or kind in ("produce", "produce_recover"):
            fields["session_id"] = None  # captured from the new run's log
        self.store.update(b["id"], **fields)
        self.store.add_run(b["id"], kind, fields.get("session_id", sid), h.pid, log, ex,
                           model=run.model, effort=run.effort)
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
                    return self._fail(b, "ERROR", "AI가 정상 종료했지만 PR을 찾지 못했습니다 "
                                      "(자동 재생산 안 함, 로그 확인 후 Retry).")
            else:
                info = self.gh.pull(b["pr_number"])
        except DuplicateClaim as e:
            return self._fail(b, "ERROR", str(e))
        except Exception as e:
            return self._fail(b, "ERROR", f"GitHub 조회 실패: {e}")
        if b["state"] == "FIXING":
            if self.git.dirty(Path(b["worktree"])).strip():
                return self._fail(b, "ERROR", "수정 후 worktree에 미커밋 변경이 있어 보존합니다.")
            if self.git.head(Path(b["worktree"])) != info["head_sha"]:
                return self._fail(b, "ERROR", "로컬 HEAD가 PR HEAD와 다릅니다 (push되지 않은 수정). 보존.")
            if info["head_sha"] == b["head_sha"]:
                self.store.log(b["id"], "수정 실행이 끝났지만 새 HEAD 없음 (코멘트로만 응답했을 수 있음)", "warn")
        self.store.update(b["id"], state="WAITING_REVIEW", pr_number=info["number"],
                          head_sha=info["head_sha"], error=None, retries=0)
        self.store.log(b["id"], f"PR #{info['number']} HEAD {info['head_sha'][:10]} 리뷰 대기")

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
        coordinated/stopped before any fix run (see _watch)."""
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
        if ln["mode"] != "continuous" or ln["drain"]:
            # Single batch done, or this Line's Drain took effect (Drain All stays global).
            self.store.set_line(b["producer"], b["method"], run=0, drain=0)

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

    from .adapters import OpenCodeAdapter
    from .config import Paths, load_config
    from .gitops import Git
    from .github import GhClient
    from .shell import Runner
    from .store import Store
    paths = paths or Paths()
    paths.ensure()
    cfg = load_config(paths)
    env = auth.build_env(dict(_os.environ), paths.gh_config, cfg["git_name"], cfg["git_email"])
    runner = Runner()
    return Supervisor(paths, cfg, Store(paths.db), runner, {"opencode": OpenCodeAdapter(cfg["opencode_bin"])},
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
