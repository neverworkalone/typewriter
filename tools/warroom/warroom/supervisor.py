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

from . import auth, batches, control, reviews
from .adapters import classify_failure
from .config import registry, registry_problems
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


def produce_prompt(cfg, b) -> str:
    m, p = b["method"].upper(), b["producer"]
    return (
        f"#860 {m} 진행해\n\n"
        f"War Room(생산 Supervisor)이 이미 배치를 선정했다. 이번 작업 대상은 정확히 "
        f"`{b['shard']}_{b['batch']}` ({m}/{p}) 하나이며 다른 배치를 고르지 않는다.\n"
        f"- 현재 디렉터리는 이 배치 전용 git worktree이고 브랜치 `{b['branch']}`가 이미 "
        f"체크아웃되어 있다. 브랜치를 바꾸거나 새로 만들지 않는다.\n"
        f"- 반드시 이 저장소의 AGENTS.md와 docs/relation-factory.md의 {m} 생산 규칙을 따르고, "
        f"정식 Candidate v1 검증 후 커밋·push하고 `batch` 라벨의 PR을 만든다.\n"
        f"- PR 생성 직전 같은 배치를 점유한 열린 PR이 없는지 다시 확인한다. 있으면 PR을 만들지 말고 "
        f"종료하며 사유를 출력한다.\n"
        f"- PR을 만든 뒤에는 리뷰·CI·머지를 기다리지 말고 종료한다. 감시는 War Room이 한다.\n"
        f"- 다른 모델/CLI/서브에이전트를 실행하지 않는다.")


def fix_prompt(b, events, resumed: bool) -> str:
    lines = [f"PR #{b['pr_number']} (브랜치 `{b['branch']}`, 현재 HEAD {b['head_sha']})에 새 리뷰가 달렸다.",
             "아래 리뷰/코멘트를 현재 HEAD 기준으로 검토하고, 동의하는 지적은 수정·검증한 뒤 "
             "같은 브랜치에만 커밋·push한다. 동의하지 않으면 근거를 PR 코멘트로 남긴다. "
             "새 PR을 만들지 않고, 리뷰를 요청하거나 머지하지 않는다. 끝나면 종료한다. "
             "이전 실행이 중단되며 worktree에 미커밋 변경이 남아 있을 수 있으니 먼저 git status로 확인하라.", ""]
    if not resumed:
        lines += ["(이전 AI 세션을 이어받지 못한 새 세션이다. AGENTS.md와 이 worktree의 git 상태, "
                  "PR 내용을 먼저 파악하라.)", ""]
    for e in events:
        loc = f" {e['path']}:{e.get('line')}" if e.get("path") else ""
        lines.append(f"--- {e['kind']} by {e['author']}{loc} [{e['key']}]\n{e['body']}\n")
    return "\n".join(lines)


def recovery_prompt(b) -> str:
    return (f"이전 AI 실행이 중단되어 같은 worktree에서 이어서 진행한다 (배치 {b['shard']}_{b['batch']}, "
            f"브랜치 `{b['branch']}`). worktree의 현재 상태와 기존 산출물을 확인하고, 이미 있는 "
            "산출물·PR을 버리거나 중복 PR을 만들지 말고 남은 작업만 완료하라. 이후 지침은 AGENTS.md를 따른다.")


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
        problem = self._model_problem(model)
        if problem:
            return self._blocked(ln, "시작 차단: " + problem)
        try:
            self.git.fetch_base(self.cfg["base_branch"])
            nb = batches.next_batch(
                self.runner, self.paths.repo_root, self.env,
                ref=f"origin/{self.cfg['base_branch']}", method=method, producer=model,
                open_prs=self.gh.open_prs(), owned=self.store.claimed_keys(method, model))
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

    def _model_problem(self, producer: str) -> str | None:
        """Fail closed: the free tier must be an explicit, installed, recognisably free model."""
        models = registry(self.cfg)[producer]["models"]
        free, go = models.get("free", ""), models.get("go", "")
        if not free:
            return (f"{producer}: models.free 미설정 — OpenCode 기본 모델이 무료라는 보장이 없어 실행하지 않습니다 "
                    f"({self.paths.config_file}).")
        if not re.search(self.cfg.get("free_model_pattern", r"-free$"), free):
            return f"models.free={free!r} 는 무료 모델 ID로 확인되지 않습니다 (패턴 {self.cfg.get('free_model_pattern', '-free$')})."
        res = self.runner.run([self.cfg["opencode_bin"], "models"], env=self.env, timeout=60)
        if not res.ok:
            return f"`{self.cfg['opencode_bin']} models` 실행 실패: {res.err.strip()[:200]}"
        known = set(res.out.split())
        missing = [m for m in (free, go) if m and m not in known]
        if missing:
            return f"OpenCode가 지원하지 않는 모델 ID: {', '.join(missing)}"
        return None

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
    def _model(self, b) -> str:
        return registry(self.cfg).get(b["producer"], {}).get("models", {}).get(b["model_tier"], "")

    def _launch(self, b, kind: str, events=None) -> None:
        """kind: produce | fix_resume | fix_new | produce_resume | produce_recover"""
        ts = int(self.clock())
        log, ex = self.paths.logs / f"batch-{b['id']}-{ts}.log", self.paths.logs / f"batch-{b['id']}-{ts}.exit"
        wt, model = b["worktree"], self._model(b)
        sid = b["session_id"]
        ad = self._adapter(b["producer"])
        if not model:  # never run with OpenCode's implicit default model
            return self._fail(b, "ERROR", f"{b['model_tier']} 모델 ID가 설정되지 않아 실행하지 않습니다.")
        try:
            if kind == "produce":
                h = ad.start(produce_prompt(self.cfg, b), wt, self.env, model,
                                       f"{b['method'].upper()} {b['shard']}_{b['batch']}", log, ex)
            elif kind == "produce_resume":
                h = ad.resume(sid, recovery_prompt(b), wt, self.env, model, log, ex)
            elif kind == "produce_recover":
                h = ad.start(recovery_prompt(b), wt, self.env, model,
                                       f"{b['method'].upper()} {b['shard']}_{b['batch']} recover", log, ex)
            elif kind == "fix_resume":
                h = ad.resume(sid, fix_prompt(b, events, True), wt, self.env, model, log, ex)
            else:  # fix_new
                h = ad.start(fix_prompt(b, events, False), wt, self.env, model,
                                       f"PR {b['pr_number']} fix", log, ex)
        except Exception as e:
            return self._fail(b, "ERROR", f"AI 실행 시작 실패: {e}")
        state = "FIXING" if kind.startswith("fix") else "PRODUCING"
        fields = dict(state=state, pid=h.pid, exit_file=str(ex), log_file=str(log),
                      run_kind=kind, retry_after=None, error=None)
        if kind == "fix_new" or kind in ("produce", "produce_recover"):
            fields["session_id"] = None  # captured from the new run's log
        self.store.update(b["id"], **fields)
        self.store.add_run(b["id"], kind, fields.get("session_id", sid), h.pid, log, ex)
        if events:  # claim only after the run really started
            self.store.mark_handled(b["id"], b["pr_number"], b["head_sha"], [e["key"] for e in events])
        self.store.log(b["id"], f"{state} 시작 ({kind}, model tier={b['model_tier']})")

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
        stem = f"data/relation-candidates/{b['shard']}/{b['shard']}_{b['batch']}_{b['method']}_{b['producer']}.jsonl"
        for pr in self.gh.open_prs():
            if pr["number"] != my_pr and any(f.get("path") == stem for f in pr.get("files") or []):
                return pr["number"]
        return None

    def _run_failed(self, b, code: int) -> None:
        try:
            text = Path(b["log_file"]).read_text("utf-8", errors="replace")[-30000:]
        except OSError:
            text = ""
        cls = classify_failure(text, self.cfg["quota_patterns"])
        self.store.log(b["id"], f"AI 종료 코드 {code}, 분류={cls}", "warn")
        if cls == "free_quota":
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
