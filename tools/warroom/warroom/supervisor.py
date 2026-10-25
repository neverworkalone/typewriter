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

from . import auth, batches, control, defects, prompts, reviews, stage2
from .adapters import PREFLIGHT_PENDING, RunSpec, classify_failure
from .config import (TIERED_ADAPTERS, adapter_label, config_problem, load_config, registry, registry_problems,
                     reload_problem, run_spec, stage2_problem)
from .gitops import CleanupBlocked, GitError
from .maintenance import Maintenance
from .store import MAINTENANCE_METHOD, STAGE2_METHOD, LineBusy, LineNotRunnable


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
        if ln["retry_batch"] == b["id"]:
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

    def _recover_if_merged(self, b) -> bool:
        """Recover a failed producer batch from its owned PR without starting another AI run.

        Known PRs keep the existing merged-only recovery. A missing PR number is rediscovered only for a completed
        producer run with usable exit evidence; open PRs return to normal review monitoring. Cleanup still rechecks
        merged=true and applies the regular worktree safety gates.
        """
        if b["paused_from"] == "CLEANUP" or b["pid"] is not None:
            return False
        if not b["pr_number"] and not self._verified_late_producer_exit(b):
            return False
        key = f"last_merge_check_{b['id']}"
        if self.clock() - float(self.store.get(key, "0")) < max(self.cfg["poll_seconds"], 60):
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
            return False
        if info is None:
            if self.store.get(f"no_pr_recovery_{b['id']}") != "1":
                self.store.log(b["id"], "종료된 생산 실행의 소유 브랜치에서 기존 PR을 찾지 못했습니다. "
                               "AI 재실행 없이 다음 제한 폴링에서 다시 확인합니다.", "warn")
                self.store.set(f"no_pr_recovery_{b['id']}", "1")
            return False
        if not b["pr_number"]:
            return self._handoff_recovered_pr(b, info, "PAUSED/ERROR 상태에서")
        if not info["merged"]:
            return False
        return self._enter_merged(b, info, f"{b['state']} 상태에서")

    def _handoff_recovered_pr(self, b, info, context: str) -> bool:
        """Attach a previously untracked, fully ownership-checked PR without rerunning production."""
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

    def _verified_late_producer_exit(self, b) -> bool:
        """Only inspect PRs after a terminal producer result, never after a stop or unverified success."""
        if b["pid"] is not None or b["paused_from"] != "PRODUCING":
            return False
        runs = self.store.runs(b["id"])
        if not runs:
            return False
        run = runs[0]
        if not isinstance(run["kind"], str) or not run["kind"].startswith("produce") or run["ended_at"] is None:
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
        return (isinstance(run["kind"], str) and run["kind"].startswith("produce")
                and run["ended_at"] is not None and recorded == code)

    def _find_recovery_pr(self, b):
        """Find one existing PR and prove it belongs to this finished batch before handing it off."""
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
        files = self.gh.pull_files(number)
        candidates = batches.pr_claims(b, {"number": number, "files": files})
        expected = batches.expected_claim(b)
        if candidates.count(expected) != 1 or any(item != expected for item in candidates):
            raise RecoveryBlocked(f"PR #{number}의 Candidate 파일 소유권이 배치와 일치하지 않습니다 "
                                  f"(기대 {expected}, 확인 {candidates})")
        dup = self._duplicate_claim(b, number)
        if dup:
            raise RecoveryBlocked(f"같은 배치를 다른 열린 PR #{dup}이 점유 — 복구를 중단합니다")
        wt = Path(b["worktree"])
        if self.git.registered(wt) != b["branch"]:
            raise RecoveryBlocked(f"worktree가 소유 브랜치 {b['branch']}로 등록되어 있지 않습니다")
        self.git.worktree_gitdir(wt)
        local = self.git.head(wt)
        if info.get("merged"):
            if info.get("state") != "closed":
                raise RecoveryBlocked(f"PR #{number}의 merged/state 값이 상충합니다")
            # _cleanup performs the clean check and permits only a safe fast-forward to the merged PR HEAD.
        elif info.get("state") == "open":
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
        if branch != f"{b['method']}-{b['producer']}-{b['shard']}-{b['batch']}":
            raise RecoveryBlocked(f"브랜치 {branch!r}가 War Room 소유 이름이 아닙니다")
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
        expected = batches.expected_claim(b)
        open_prs = [i for i in infos if i["state"] == "open"]
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
        self.store.finish_clear(b, f"Clear 완료: {b['producer']}/{b['method'].upper()} 배치 {b['shard']}_{b['batch']} "
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
        d = auth.diagnose(self.runner, self.env, self.cfg["repo"], self.cfg["expected_account"])
        if not d["ok"]:
            return self._blocked(ln, "시작 차단: " + "; ".join(d["problems"]))
        problem = self._preflight(model)
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
        pin = ln["shard_pin"] if ln["mode"] == "single" else ""
        try:
            sha = self.git.fetch_base(base)
            choice = stage2.choose(self.runner, self.paths.repo_root, self.env, ref=f"origin/{base}", sha=sha,
                                   open_prs=self.gh.open_prs(), kv=self.store, pin=pin,
                                   verify=lambda *a: self.git.verify_stage2(sha, *a))
        except Exception as e:   # BatchError, GitError, GhError
            return self._blocked(ln, f"Stage 2 Part 선정 실패: {e}")
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
                                          branch=branch, worktree=str(wt), model_tier=ln["model_tier"], from_run=True)
        except LineNotRunnable:
            return
        except LineBusy as e:   # another model already holds the one Stage 2 occupancy
            return self.store.log(None, str(e), "warn", line=line)
        self.store.set_line(model, method, blocked="", shard_pin=part.shard if ln["mode"] == "single" else "")
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
                    try:
                        text = Path(runs[0]["log_file"]).read_text("utf-8", errors="replace")[-30000:]
                    except OSError:
                        text = ""
                    cls = classify_failure(text, self.cfg["quota_patterns"])
                    if self._handoff_failed_pr(b, failed_code, cls):
                        return
                elif is_terminal_producer and failed_code == 0:
                    # Retry is an explicit request to relaunch, but it must first rule out a PR from the prior run.
                    # Only a run that passed its completion gate can be adopted; an unverified zero exit is fail-closed.
                    try:
                        info = self._find_recovery_pr(b)
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
            runs = self.store.runs(b["id"])
            if runs:
                self.store.set(f"verified_completion_run_{b['id']}", str(runs[0]["id"]))
            return self._run_ok(b)
        self._run_failed(b, code)

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
        if self.store.defect_by_event(key):
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

    def _to_review(self, b, info, recovery_note: str | None = None) -> None:
        self.store.update(b["id"], state="WAITING_REVIEW", pr_number=info["number"],
                          head_sha=info["head_sha"], error=recovery_note, retries=0)
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
        except Exception as e:
            self._fail(b, "ERROR", f"AI 종료 코드 {code}, 분류={cls}; 실패 직후 소유 PR 조회/검증 실패: {e}. "
                       "worktree를 보존하고 AI를 재실행하지 않습니다.")
            return True
        if info is None:
            self.store.log(b["id"], f"AI 종료 코드 {code}, 분류={cls}; 소유 브랜치 PR 미발견 "
                           "(확인된 미발견이며 기존 실패 분류를 계속 적용합니다).", "warn")
            return False
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

    def _run_failed(self, b, code: int) -> None:
        try:
            text = Path(b["log_file"]).read_text("utf-8", errors="replace")[-30000:]
        except OSError:
            text = ""
        cls = classify_failure(text, self.cfg["quota_patterns"])
        self.store.log(b["id"], f"AI 종료 코드 {code}, 분류={cls}", "warn")
        if b["state"] == "PRODUCING" and not b["pr_number"]:
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
        self.store.log(b["id"], f"PR #{b['pr_number']} merged=true 재확인 → MERGED→CLEANUP "
                       "(clean/HEAD/소유 worktree 검증)")

    def _cleanup(self, b) -> None:
        ad = self._adapter(b["producer"])
        if b["pid"] and ad.alive(b["pid"]):
            ad.stop(b["pid"])
            return self.store.log(b["id"], "남은 AI 프로세스 정지 요청, 종료 확인 대기")
        try:
            info = self.gh.pull(b["pr_number"])
            if not info["merged"]:
                return self._fail(b, "ERROR", "merged=true 아님 — 정리하지 않음")
            if b["method"] == STAGE2_METHOD and not self._stage2_merged_verify(b, info):
                return
            self.git.remove_owned(Path(b["worktree"]), b["branch"], info["head_sha"])
        except CleanupBlocked as e:
            return self._fail(b, "ERROR", f"정리 차단(보존): {e}")
        except Exception as e:
            return self._fail(b, "ERROR", f"정리 실패(보존): {e}")
        self.store.update(b["id"], state="COMPLETE", error=None)
        self.store.finish_runs(b["id"], None)
        self.store.log(b["id"], f"배치 {b['shard']}_{b['batch']} 정리 완료")
        ln = self.store.line(b["producer"], b["method"])
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
