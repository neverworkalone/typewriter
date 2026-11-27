"""War Room Recovery lane: the former tools/warroom/recovery-desk, run by the Supervisor itself.

Detection is deterministic (no AI call to look): the Supervisor reads its own DB, the PR facts it already uses and the
restart requests, and opens a case only for a confirmed failure. Only then does a Claude/Codex recovery run start, with
the `prompts/recovery.md` contract: investigation -> fix -> PR/review/merge -> applying it (ff-only + `./kwar`) ->
the original task's official recovery.

Boundaries:
- The run is a detached process group (adapter wrapper), so a Supervisor restart (`./kwar`, the external watchdog)
  leaves it alive; every turn re-adopts open runs from the DB and the wrapper's `.pid`/exit files alone.
- `store.claim_recovery_run` is the one duplicate-launch guard (Supervisor, replacement instance, watchdog).
- Owner Stop / Clear / `run=0` are never released; a Drained Line's current batch is still recovered.
- A run's report is an assertion only: RESOLVED is decided here from official evidence, per failure type.
- No give-up counter: the same evidence and the same prompt are never resent; the prompt turns into a root-cause
  investigation, then the case waits for changed evidence with a 30 min -> 6 h back-off.
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import threading
import time
import traceback
from pathlib import Path

from . import control, prompts, reviews
from .adapters import SpawnNotStarted, usage_limit_reset_at
from .config import RECOVERY, recovery_problem, recovery_target, run_spec
from .launch_gate import LaunchDenied
from .store import CLEARED_HOLD, MAINTENANCE_METHOD

FORCE_STOP_PREFIX = "강제 중지됨"          # supervisor._force_stop's PAUSED text: an owner Stop (or our own takeover)
LIMIT_MARKERS = ("사용량 한도", "무료 한도")   # a real run limit: waited out, never "fixed"
STALL_CHECKS = 3
MERGE_STALL_SECONDS = 1800
BACKOFF_MIN, BACKOFF_MAX = 1800, 6 * 3600
LAUNCH_GRACE = 60      # a claimed run with neither pid nor `.pid` file after this never started
REPORT_KEYS = ("STATUS", "CASE", "DONE", "REMAINING", "BLOCKER", "BOUNDARY", "PR")
STATE_RANK = {"PREPARE": 0, "PRODUCING": 1, "FIXING": 1, "WAITING_REVIEW": 2, "MERGED": 3, "CLEANUP": 4,
              "COMPLETE": 5}
STALL_STATES = ("PREPARE", "PRODUCING", "FIXING", "MERGED", "CLEANUP")   # WAITING_REVIEW waits on people: not a stall
OBS_KEY = "recovery_obs"
LEGACY_KEY = "recovery_legacy_imported"


def resume_key(case_id: int) -> str:
    """kv flag `./recovery resume <case>` writes: the owner's answer to a `denied` wait."""
    return f"recovery_resume_{case_id}"


def parse_report(text: str | None) -> dict:
    """The last `STATUS:` block of a run's final answer: {STATUS, CASE, ...}; {} when there is none."""
    if not text:
        return {}
    idx = text.rfind("STATUS:")
    if idx < 0:
        return {}
    out, key = {}, None
    for line in text[idx:].splitlines():
        m = re.match(r"\s*`?([A-Z]+):\s?(.*)$", line)
        if m and m.group(1) in REPORT_KEYS:
            key = m.group(1)
            out[key] = m.group(2).strip().strip("`")
        elif key and line.strip() and not line.strip().startswith("```"):
            out[key] = (out[key] + " " + line.strip()).strip()
    status = (out.get("STATUS") or "").split()[0].strip("|") if out.get("STATUS") else ""
    out["STATUS"] = status if status in ("RESOLVED", "IN_PROGRESS", "BLOCKED") else ""
    boundary = (out.get("BOUNDARY") or "none").split()[0].lower()
    out["BOUNDARY"] = boundary if boundary in ("none", "limit", "owner_control", "denied", "ownership") else "none"
    pr = re.search(r"\d+", out.get("PR") or "")
    out["PR"] = int(pr.group(0)) if pr else None
    return out


def _sha(obj) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, default=str).encode("utf-8")).hexdigest()[:16]


def _json(text, default):
    try:
        value = json.loads(text) if text else default
    except (TypeError, ValueError):
        return default
    return value if isinstance(value, type(default)) else default


class Recovery:
    def __init__(self, sup):
        self.sup = sup
        self._lock = threading.Lock()   # tick() and the Coordinator never run two steps at once
        self._logged: set = set()
        self._pulls: dict = {}   # PR number -> (time, info): judging a case never queries GitHub every turn

    # ---- plumbing ---------------------------------------------------------------------------------------------------
    @property
    def store(self):
        return self.sup.store

    @property
    def cfg(self):
        return self.sup.cfg

    def now(self) -> float:
        return self.sup.clock()

    def enabled(self) -> bool:
        return self.cfg.get("recovery") is not None

    def _log(self, msg: str, level: str = "info", batch_id=None) -> None:
        self.store.log(batch_id, f"Recovery: {msg}", level, line="recovery")

    def _log_once(self, msg: str, level: str = "warn") -> None:
        self.store.log_once(None, f"Recovery: {msg}", level, line="recovery")

    def _obs(self) -> dict:
        return _json(self.store.get(OBS_KEY), {})

    def _save_obs(self, obs: dict) -> None:
        self.store.set(OBS_KEY, json.dumps(obs, sort_keys=True))

    @staticmethod
    def _tmux_alive(name: str) -> bool:
        try:
            return subprocess.run(["tmux", "has-session", "-t", "=" + name], capture_output=True,
                                  timeout=5).returncode == 0
        except (OSError, subprocess.SubprocessError):
            return False

    def logs_dir(self) -> Path:
        d = self.sup.paths.logs / "recovery"
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ---- entry point ------------------------------------------------------------------------------------------------
    def step(self) -> None:
        """One Recovery turn. Collection/adoption always runs (it is not new work); detection and launches only while
        this instance accepts new work."""
        if not self._lock.acquire(blocking=False):
            return
        try:
            self._collect()
            if not self.enabled():
                return
            self._import_legacy()
            if self.sup._stop_requested() or not self.sup.accepting_new_work():
                return
            now = self.now()
            self._observe(now)
            self._scan_prs(now)
            for case in self.store.open_recovery_cases():
                try:
                    self._advance(self.store.recovery_case(case["id"]), now)
                except LaunchDenied:
                    return
                except Exception:
                    self._log(f"case {case['key']} 처리 예외:\n" + traceback.format_exc()[-800:], "error")
        finally:
            self._lock.release()

    # ---- adoption and collection of runs ----------------------------------------------------------------------------
    def _run_adapter(self, run):
        try:
            return self.sup._adapter(run["producer"]) if run["producer"] else self.sup._adapter(self._producer())
        except Exception:
            return None

    def _collect(self) -> None:
        for run in self.store.open_recovery_runs():
            ad = self._run_adapter(run)
            if ad is None:
                continue
            pid = run["pid"]
            if pid is None:
                pid = ad.read_pid(Path(run["exit_file"]))   # the Supervisor ended between spawn and its pid record
                if pid is not None:
                    self.store.set_recovery_run(run["id"], pid=pid)
            code = ad.exit_code(Path(run["exit_file"]))
            if code is None:
                if pid is not None and ad.alive(pid):
                    continue   # still running: adopted, never relaunched
                if pid is None and time.time() - run["started_at"] < LAUNCH_GRACE:
                    continue   # the spawn may still be under way in the instance that claimed it
                status = "not_started" if pid is None else "lost"
            else:
                status = str(code)
            if self.store.finish_recovery_run(run["id"], status):
                self._finished(run, status, ad)

    def _finished(self, run, status: str, ad) -> None:
        case = self.store.recovery_case(run["case_id"])
        if case is None or case["state"] == "RESOLVED":
            return
        log = Path(run["log_file"])
        session = ad.session_id(log) or run["session_id"]
        if session and session != case["session_id"]:
            self.store.update_recovery_case(case["id"], session_id=session)
            self.store.set_recovery_run(run["id"], session_id=session)
        answer = None
        try:
            answer = ad.final_answer(log)
        except Exception:
            answer = None
        if not answer:
            try:
                answer = log.read_text("utf-8", errors="replace")[-20000:]
            except OSError:
                answer = ""
        report = parse_report(answer)
        summary = json.dumps({**report, "exit": status, "run_id": run["id"]}, ensure_ascii=False)
        fields = {"last_report": summary}
        if report.get("PR"):
            fields["pr_number"] = report["PR"]
        self.store.update_recovery_case(case["id"], **fields)
        self._log(f"case {case['key']} 실행 #{run['id']} 종료 (exit={status}, STATUS={report.get('STATUS') or '없음'})")
        if status == "not_started":
            return self._backoff(case, "복구 실행이 시작되지 않았습니다")
        st = report.get("STATUS")
        if status != "0" or not st:
            limit = self._limit_evidence(run, ad)
            if limit is not None:
                return self.store.update_recovery_case(case["id"], state="WAITING_OWNER", wait_reason=limit)
        case = self.store.recovery_case(case["id"])
        unit = _json(case["blocking_unit"], {})
        self._note_confirm(case, unit)
        case = self.store.recovery_case(case["id"])
        if st == "RESOLVED":
            if unit.get("took_over_maintainer") and not unit.get("maintainer_restored"):
                self._restore_maintainer(case, unit)
                return self._track(case, "maintainer_restore")
            ok, why = self.resolved(case)
            if ok:
                return self._resolve(case, "실행 보고와 공식 증거가 일치")
            if self._partly_recovered(case, unit):
                return self._track(case, "confirm", note=f"RESOLVED 보고: 정상 생산 지속 확인 대기 ({why})")
            return self.store.update_recovery_case(case["id"], state="OPEN", notes=self._note(
                case, f"RESOLVED 보고 반려: {why}"))
        if st == "BLOCKED":
            if report.get("BOUNDARY", "none") != "none":
                wait = self.boundary_evidence(case, report["BOUNDARY"], run, ad)
                if wait is not None:
                    return self.store.update_recovery_case(case["id"], state="WAITING_OWNER", wait_reason=wait)
                why = f"BOUNDARY {report['BOUNDARY']} 주장이 공식 기록과 맞지 않아 반려"
            else:
                why = "BOUNDARY 없는 BLOCKED 반려 (코드 수정·Issue·승인 대기는 중단 사유가 아님)"
            return self.store.update_recovery_case(case["id"], state="OPEN", notes=self._note(case, why))
        if st == "IN_PROGRESS" and (case["pr_number"] or report.get("PR")):
            return self._track(case, "pr", pr=case["pr_number"] or report["PR"])
        self.store.update_recovery_case(case["id"], state="OPEN")

    def _batch_marks(self, case) -> dict:
        marks = {}
        for bid in self.store.recovery_case_batch_ids(case["id"]):
            b = self.store.batch(bid)
            if b is not None:
                marks[str(bid)] = [b["state"], b["error_seq"], (b["error"] or "")[:200]]
        return marks

    def _track(self, case, kind: str, note: str | None = None, **extra) -> None:
        """TRACKING: a normal wait. It remembers what was failing when it began; only a NEW failure re-opens it."""
        fields = {"state": "TRACKING", "wait_reason": {"kind": kind, "marks": self._batch_marks(case), **extra}}
        if note:
            fields["notes"] = self._note(case, note)
        self.store.update_recovery_case(case["id"], **fields)

    @staticmethod
    def _note(case, text: str) -> str:
        notes = (case["notes"] or "").splitlines()[-9:]
        return "\n".join([*notes, text])

    def _limit_evidence(self, run, ad) -> dict | None:
        try:
            cls = self.sup._classify_run(run["producer"] or self._producer(), run["log_file"])
        except Exception:
            return None
        if cls not in ("usage_limit", "free_quota", "rate_limit"):
            return None
        try:
            text = Path(run["log_file"]).read_text("utf-8", errors="replace")[-30000:]
        except OSError:
            text = ""
        until = usage_limit_reset_at(text) or (self.now() + BACKOFF_MIN)
        return {"kind": "limit", "class": cls, "until": until}

    # ---- legacy ledger (tools/warroom/recovery-desk) ------------------------------------------------------------------
    def legacy_dir(self) -> Path:
        return self.sup.paths.supervisor_state / "recovery-desk"

    def _import_legacy(self) -> None:
        if self.store.get(LEGACY_KEY) is not None:
            return
        ledger = _json(_read(self.legacy_dir() / "ledger.json"), {})
        imported = 0
        claude = self._adapter_name() == "claude"
        for item in ledger.get("cases") or []:
            if not isinstance(item, dict) or item.get("status") == "RESOLVED" or not item.get("key"):
                continue
            old = str(item["key"])
            m = re.fullmatch(r"(batch|maintainer):(\d+)", old)
            key = old if m is None or m.group(1) == "batch" else f"defect:{m.group(2)}"
            slug = "".join(c if c.isalnum() or c in "_-" else "-" for c in old)
            batch_ids = []
            if m and m.group(1) == "batch":
                b = self.store.batch(int(m.group(2)))
                if b is None or b["state"] == "COMPLETE":
                    continue   # already over: nothing left to take over
                batch_ids.append(b["id"])
            session = (_read(self.legacy_dir() / "sessions" / f"{slug}.id") or "").strip() or None
            kind = "supervisor" if key == "supervisor" else "maintainer" if key.startswith("defect:") else "task"
            cid = self.store.open_recovery_case(
                key, kind, batch_ids=batch_ids, issue=item.get("issue"), pr_number=item.get("pr"),
                blocking_unit={"legacy": True, "legacy_key": old, "tmux": f"recovery-{slug}",
                               "legacy_log": str(self.legacy_dir() / "sessions" / f"{slug}.log"),
                               "instance": None,
                               "batches": {str(i): self._progress(self.store.batch(i)) for i in batch_ids}},
                state="TRACKING", notes=f"legacy recovery-desk case: {item.get('notes') or ''}"[:2000],
                session_id=session if claude else None, now=self.now())
            imported += cid is not None
        self.store.set(LEGACY_KEY, str(self.now()))
        if imported:
            self._log(f"기존 recovery-desk 열린 case {imported}건을 이어받았습니다 (legacy tmux가 살아 있는 동안 추적만)")

    # ---- target ------------------------------------------------------------------------------------------------------
    def _producer(self) -> str | None:
        return recovery_target(self.cfg)[0]

    def _adapter_name(self) -> str | None:
        producer = self._producer()
        if producer is None:
            return None
        try:
            return getattr(self.sup._adapter(producer), "name", None)
        except Exception:
            return None

    # ---- observation: progress, groups, ownership --------------------------------------------------------------------
    def _progress(self, b) -> dict:
        """Official progress of one batch: saved tasks, counters, state, HEAD. Never a PID or a log time alone."""
        if b is None:
            return {"gone": True}
        tasks = self.store.task_rows(b["id"])
        state = b["paused_from"] if b["state"] in ("ERROR", "PAUSED") and b["paused_from"] else b["state"]
        return {"state": b["state"], "rank": STATE_RANK.get(state, -1),   # a stopped batch ranks where it stopped
                "saved": sum(1 for t in tasks if t["state"] == "SAVED"), "tasks": len(tasks),
                "progress_done": b["progress_done"] or 0, "records_done": b["records_done"] or 0,
                "head": b["head_sha"] or "", "merged": b["merged"], "error_seq": b["error_seq"]}

    def _fingerprint(self, b) -> str:
        """Observation only (stall detection): official progress plus run/task activity and the growth of live logs."""
        runs = self.store.runs(b["id"])
        tasks = self.store.task_rows(b["id"])
        live = []
        for r in runs:
            if r["ended_at"] is None and r["log_file"]:
                try:
                    live.append(Path(r["log_file"]).stat().st_size)
                except OSError:
                    live.append(-1)
        last_event = self.store.last_event(b["id"])
        return _sha({"p": self._progress(b), "runs": [(r["id"], r["ended_at"]) for r in runs[-5:]], "n": len(runs),
                     "tasks": [(t["task"], t["state"], t["updated_at"]) for t in tasks], "live": live,
                     "ev": last_event["id"] if last_event else None})

    def group(self, b) -> tuple[str, int | None]:
        """Failure group of a batch: `defect:<issue>` when tied to a shared defect / Maintainer Issue, else `batch:<id>`."""
        if b["method"] == MAINTENANCE_METHOD:
            m = next((m for m in self.store.maintenance_rows() if m["batch_id"] == b["id"]), None)
            if m is not None:
                return f"defect:{m['issue_number']}", m["issue_number"]
        d = self.store.defect(b["defect_id"]) if b["defect_id"] else None
        if d is None and b["state"] == "ERROR" and b["error_seq"]:
            d = self.store.defect_by_event(f"incident:{b['id']}:e{b['error_seq']}")   # the Maintainer's ERROR intake
        if d is not None and d["issue_number"]:
            return f"defect:{d['issue_number']}", d["issue_number"]
        return f"batch:{b['id']}", None

    def _owner_stopped(self, b, case=None) -> bool:
        """An owner Stop (force-stop PAUSED) that is not our own Maintainer takeover."""
        if b["state"] != "PAUSED" or not (b["error"] or "").startswith(FORCE_STOP_PREFIX):
            return False
        if case is not None and _json(case["blocking_unit"], {}).get("took_over_maintainer") == b["id"]:
            return False
        taken = self.store.get(f"recovery_takeover_{b['id']}")
        return taken is None

    def _owner_control(self, b, case=None) -> str | None:
        if self.store.clear_request(b["producer"], b["method"], batch_id=b["id"]) is not None or b["state"] == "CLEARING":
            return "clear"
        if self._owner_stopped(b, case):
            return "stop"
        return None

    @staticmethod
    def _limited(b) -> bool:
        return b["state"] == "PAUSED" and any(m in (b["error"] or "") for m in LIMIT_MARKERS)

    def _operator_released(self, m) -> bool:
        """A HELD Maintainer whose linked incidents the operator all took over (OVERRIDDEN): nothing is left to recover."""
        if m["state"] != "HELD" or m["batch_id"]:
            return False
        linked = [d for d in self.store.defects() if d["issue_number"] == m["issue_number"]]
        return bool(linked) and all(d["state"] == "OVERRIDDEN" for d in linked)

    def maintainer_state(self, issue: int | None, obs: dict | None = None) -> str:
        """`progressing` | `stopped` | `owner` | `none` for the Maintainer of one Issue."""
        if issue is None:
            return "none"
        m = self.store.maintenance(issue)
        if m is None or m["state"] == "DONE":
            return "none"
        if self._operator_released(m):
            return "none"
        if m["state"] == "HELD":
            return "owner" if (m["hold_reason"] or "") == CLEARED_HOLD else "stopped"
        mb = self.store.batch(m["batch_id"]) if m["batch_id"] else None
        if mb is None or mb["state"] == "COMPLETE":
            return "progressing"   # QUEUED: waiting for the one Maintainer slot is normal
        if self._owner_control(mb):
            return "owner"
        if mb["state"] in ("ERROR", "PAUSED"):
            return "stopped"
        obs = obs if obs is not None else self._obs()
        if (obs.get("stall", {}).get(str(mb["id"])) or {}).get("count", 0) >= STALL_CHECKS:
            return "stopped"
        return "progressing"

    def batch_failure(self, b, obs: dict) -> tuple[str, str] | None:
        """(kind, reason) of a confirmed failure of one batch now, or None (normal / owner / limit / not yet)."""
        if self._owner_control(b) or self._limited(b):
            return None
        if b["retry_after"] and b["retry_after"] > self.now():
            return None
        key, issue = self.group(b)
        if b["method"] == MAINTENANCE_METHOD:
            st = self.maintainer_state(issue, obs)
            return ("maintainer", f"Maintainer 정지 ({b['state']}): {b['error'] or ''}") if st == "stopped" else None
        if b["state"] == "ERROR":
            if issue is not None:
                st = self.maintainer_state(issue, obs)
                return ("maintainer", f"ERROR 접수 Issue #{issue}의 Maintainer가 진행하지 않습니다") \
                    if st == "stopped" else None
            if self._intake_pending(b, obs):
                return None
            return "task", f"ERROR: {b['error'] or ''}"
        if b["state"] == "PAUSED":
            if b["pause_reason"] == "maintainer_continuation":
                return None
            if b["pause_reason"] == "shared_defect":
                d = self.store.defect(b["defect_id"]) if b["defect_id"] else None
                if d is None or d["state"] == "REPORTED" or not d["issue_number"]:
                    return None   # the Maintainer's intake has not linked an Issue yet
                st = self.maintainer_state(d["issue_number"], obs)
                return ("maintainer", f"공통 결함 Issue #{d['issue_number']}의 Maintainer가 진행하지 않습니다") \
                    if st in ("stopped", "none") else None
            return "task", f"PAUSED: {b['error'] or ''}"
        stall = (obs.get("stall", {}).get(str(b["id"])) or {}).get("count", 0)
        if b["state"] in STALL_STATES and stall >= STALL_CHECKS:
            return "stall", f"{b['state']} 상태에서 task/run/공식 저장 진전이 {STALL_CHECKS}회 연속 없습니다"
        return None

    INTAKE_GRACE = 120

    def _intake_pending(self, b, obs: dict) -> bool:
        """The Maintainer's own ERROR intake gets the first turn: an ERROR it may still take is a failure only after
        it stayed un-taken for INTAKE_GRACE (observed on two turns), never raced on the same tick."""
        if self.cfg.get("maintainer") is None or not b["error_seq"] or b["method"] not in ("s2", "s3", "drop"):
            return False
        if self.store.defect_by_event(f"incident:{b['id']}:e{b['error_seq']}") is not None:
            return False
        seen = obs.setdefault("intake", {})
        key = f"{b['id']}:{b['error_seq']}"
        first = seen.setdefault(key, self.now())
        self._save_obs(obs)
        return self.now() - first < self.INTAKE_GRACE

    def _group_batches(self, key: str, issue: int | None, b) -> list[int]:
        if issue is None:
            return [b["id"]]
        ids = {b["id"]}
        m = self.store.maintenance(issue)
        if m is not None and m["batch_id"]:
            mb = self.store.batch(m["batch_id"])
            if mb is not None and mb["state"] != "COMPLETE":
                ids.add(mb["id"])
        for d in self.store.defects():
            if d["issue_number"] == issue:
                db = self.store.batch(d["batch_id"])
                if db is not None and db["state"] != "COMPLETE" and db["defect_id"] == d["id"]:
                    ids.add(db["id"])
        return sorted(ids)

    def _observe(self, now: float) -> None:
        obs = self._obs()
        stall = obs.setdefault("stall", {})
        due = now - float(obs.get("checked_at") or 0) >= float(self.cfg.get("recovery_stall_seconds", 600))
        live = set()
        for b in self.store.incomplete_batches():
            if control.retired(b, self.cfg):
                continue
            live.add(str(b["id"]))
            if due:
                fp = self._fingerprint(b)
                prev = stall.get(str(b["id"])) or {}
                active = b["state"] in STALL_STATES and not self._owner_control(b)
                stall[str(b["id"])] = {"fp": fp, "count": (prev.get("count", 0) + 1) if active and prev.get("fp") == fp else 0}
        for gone in set(stall) - live:
            del stall[gone]
        if due:
            obs["checked_at"] = now
        self._save_obs(obs)
        for b in self.store.incomplete_batches():
            if control.retired(b, self.cfg) or self.store.recovery_case_for_batch(b["id"]) is not None:
                continue
            failure = self.batch_failure(b, obs)
            if failure is None:
                continue
            key, issue = self.group(b)
            existing = self.store.recovery_case_by_key(key)
            if existing is not None:
                self.store.attach_recovery_batch(existing["id"], b["id"])
                continue
            kind, reason = failure
            ids = self._group_batches(key, issue, b)
            cid = self.store.open_recovery_case(
                key, kind, batch_ids=ids, issue=issue, pr_number=b["pr_number"] if kind != "maintainer" else None,
                blocking_unit=self._blocking_unit(ids, reason, failing=b["id"]), now=now)
            if cid is not None:
                self._log(f"case {key} 열림 ({kind}): {reason}"[:600], "warn", batch_id=b["id"])
        for m in self.store.maintenance_rows():   # a HELD Maintainer Issue with no execution left
            if m["state"] != "HELD" or (m["hold_reason"] or "") == CLEARED_HOLD or m["batch_id"] \
                    or self._operator_released(m):
                continue
            key = f"defect:{m['issue_number']}"
            if self.store.recovery_case_by_key(key) is None:
                deps = sorted({d["batch_id"] for d in self.store.defects() if d["issue_number"] == m["issue_number"]
                               and (self.store.batch(d["batch_id"]) or {"state": "COMPLETE"})["state"] != "COMPLETE"
                               and self.store.recovery_case_for_batch(d["batch_id"]) is None})
                reason = f"Maintainer Issue #{m['issue_number']} HELD: {m['hold_reason'] or ''}"
                if self.store.open_recovery_case(key, "maintainer", batch_ids=deps, issue=m["issue_number"],
                                                 blocking_unit=self._blocking_unit(deps, reason), now=now):
                    self._log(f"case {key} 열림 (maintainer): {reason}"[:600], "warn")
        self._observe_restart(now, obs)

    def _blocking_unit(self, ids, reason: str, failing: int | None = None, **extra) -> dict:
        unit = {"reason": reason[:2000], "failing_batch": failing, "instance": self.sup.phase_instance,
                "code_sha": self.sup.code_sha,
                "batches": {str(i): self._progress(self.store.batch(i)) for i in ids}}
        for i in ids:
            b = self.store.batch(i)
            if b is not None and i == failing:
                unit["failing_tasks"] = [t["task"] for t in self.store.task_rows(i) if t["state"] != "SAVED"][:50]
        unit.update(extra)
        return unit

    def _observe_restart(self, now: float, obs: dict) -> None:
        """A merged fix that cannot be applied: a pending restart request whose blocker stays the same."""
        from . import restart_controller as rc
        try:
            pending = rc.pending_requests(self.sup.paths, self.sup.code_sha)
        except Exception:
            return
        seen = obs.setdefault("restart", {})
        current = {}
        for req in pending:
            blocker = req.get("blocker")
            sha = req.get("merge_sha")
            if not blocker or not isinstance(sha, str):
                continue
            ident = str(req.get("defect_id") or 0)
            prev = seen.get(ident) or {}
            first = prev.get("since") if prev.get("blocker") == blocker else now
            current[ident] = {"blocker": blocker, "since": first, "sha": sha}
            if now - first >= float(self.cfg.get("recovery_stall_seconds", 600)) and \
                    self.store.recovery_case_by_key("supervisor") is None:
                cid = self.store.open_recovery_case(
                    "supervisor", "supervisor",
                    blocking_unit=self._blocking_unit([], f"수정 반영 차단: {blocker}", merge_sha=sha,
                                                      request=ident), now=now)
                if cid is not None:
                    self._log(f"case supervisor 열림: 머지된 수정 {sha[:10]} 반영 차단 — {blocker}"[:600], "warn")
        obs["restart"] = current
        self._save_obs(obs)

    # ---- PR facts ------------------------------------------------------------------------------------------------------
    def _scan_prs(self, now: float) -> None:
        obs = self._obs()
        if now - float(obs.get("pr_scan_at") or 0) < float(self.cfg.get("poll_seconds", 300)):
            return
        obs["pr_scan_at"] = now
        prev_all, cur_all = obs.get("pr") or {}, {}
        targets: dict[int, tuple] = {}
        for b in self.store.incomplete_batches():
            if control.retired(b, self.cfg) or not b["pr_number"] or b["state"] not in ("WAITING_REVIEW", "FIXING"):
                continue
            targets[b["pr_number"]] = ("batch", b)
        for case in self.store.open_recovery_cases():
            if case["pr_number"] and case["pr_number"] not in targets:
                targets[case["pr_number"]] = ("case", case)
        for n, (what, row) in sorted(targets.items()):
            try:
                info = self.sup.gh.pull(n)
                self._pulls[n] = (now, info)
                if info.get("state") != "open" or info.get("merged"):
                    continue
                head = info["head_sha"]
                ci = self.sup.gh.required_check(head)
                review_list = self.sup.gh.reviews(n)
                issue_list = self.sup.gh.issue_comments(n)
            except Exception as e:   # one PR's query never stops the others; asked again next scan
                self._log_once(f"PR #{n} 조회 실패: {type(e).__name__}: {e}"[:300])
                continue
            fixing = what == "batch" and (row["state"] == "FIXING" or row["pid"] is not None
                                          or bool(self.store.open_task_runs(row["id"])))
            if what == "case":
                fixing = any(r["case_id"] == row["id"] for r in self.store.open_recovery_runs())
            events = reviews.fix_events(head_sha=head, head_pushed_at=0.0, self_login=self.cfg.get("expected_account", ""),
                                        reviews=review_list, inline=[], issue=issue_list,
                                        trusted=self.cfg.get("trusted_reviewers", []))
            pending = sorted(e["key"] for e in events
                             if not (what == "batch" and self.store.is_handled(row["id"], n, head, e["key"])))
            cur = {"head": head, "conflict": info.get("mergeable") is False or info.get("mergeable_state") == "dirty",
                   "ci": ci, "pending": pending}
            cur_all[str(n)] = cur
            prev = prev_all.get(str(n)) or {}
            same = prev.get("head") == head and not fixing
            problem = None
            if same and cur["conflict"] and prev.get("conflict"):
                problem = "PR 충돌(CONFLICTING)이 새 push·수정 run 없이 남아 있습니다"
            elif same and ci == "FAILURE" and prev.get("ci") == "FAILURE":
                problem = "필수 CI(Validate and test Typewriter) 실패가 새 push·수정 run 없이 남아 있습니다"
            elif same and pending and set(pending) <= set(prev.get("pending") or []):
                problem = f"리뷰 -1 수정이 처리되지 않았습니다 ({', '.join(pending)})"
            if problem is None and not events and not cur["conflict"] and ci == "SUCCESS" \
                    and not (what == "batch" and row["method"] == MAINTENANCE_METHOD):
                problem = self._merge_stall(n, head, info, review_list, now)
            if problem:
                self._pr_problem(what, row, n, problem, now)
        obs["pr"] = cur_all
        self._save_obs(obs)

    def _merge_stall(self, n: int, head: str, info: dict, review_list: list, now: float) -> str | None:
        """+1 on the current HEAD, no later -1, CI SUCCESS, MERGEABLE/CLEAN, 30 min since the +1: merge deterministically."""
        if info.get("mergeable") is not True or (info.get("mergeable_state") or "").lower() != "clean":
            return None
        allow = {t.lower() for t in self.cfg.get("trusted_reviewers", [])}
        passes = [reviews._ts(r.get("submitted_at")) for r in review_list
                  if reviews.verdict(r.get("body")) in ("+1", "+2")
                  and ((r.get("user") or {}).get("login") or "").lower() in allow
                  and (r.get("state") or "").upper() != "DISMISSED"
                  and (reviews.head_marker(r.get("body")) or (r.get("commit_id") or "").lower()) == head.lower()]
        if not passes or now - max(passes) < MERGE_STALL_SECONDS:
            return None
        try:
            self.sup.gh.merge_squash(n, head)
        except Exception as e:
            return f"머지 정체 처리 실패 (gh pr merge --squash --match-head-commit): {e}"[:600]
        self._log(f"머지 정체 PR #{n}을 squash 머지했습니다 (HEAD {head[:10]}, +1 후 {int((now - max(passes)) // 60)}분)", "warn")
        return None

    def _pr_problem(self, what: str, row, n: int, problem: str, now: float) -> None:
        if what == "case":
            case = self.store.recovery_case(row["id"])
            if case is not None and case["state"] in ("TRACKING", "OPEN"):
                self.store.update_recovery_case(case["id"], state="OPEN",
                                                notes=self._note(case, f"PR #{n}: {problem}"))
            return
        b = row
        if self.store.recovery_case_for_batch(b["id"]) is not None:
            case = self.store.recovery_case_for_batch(b["id"])
            if case["state"] == "TRACKING":
                self.store.update_recovery_case(case["id"], state="OPEN", notes=self._note(case, f"PR #{n}: {problem}"))
            return
        if self._owner_control(b):
            return
        key, issue = self.group(b)
        ids = self._group_batches(key, issue, b)
        if self.store.recovery_case_by_key(key) is None and self.store.open_recovery_case(
                key, "pr", batch_ids=ids, issue=issue, pr_number=n,
                blocking_unit=self._blocking_unit(ids, f"PR #{n}: {problem}", failing=b["id"], pr=n), now=now):
            self._log(f"case {key} 열림 (pr): PR #{n} {problem}"[:600], "warn", batch_id=b["id"])

    # ---- judging ---------------------------------------------------------------------------------------------------
    def _batch_recovered(self, bid: int, unit: dict) -> tuple[bool, str]:
        b = self.store.batch(bid)
        if b is None:
            return True, f"배치 {bid} 기록 없음(Clear)"
        if b["state"] == "COMPLETE":
            return True, f"배치 {bid} COMPLETE"
        if b["state"] in ("ERROR", "PAUSED", "CLEARING"):
            return False, f"배치 {bid}가 아직 {b['state']}입니다"
        before = (unit.get("batches") or {}).get(str(bid)) or {}
        now_p = self._progress(b)
        keys = ("saved", "progress_done", "records_done", "rank", "head", "merged")
        if all(now_p.get(k) == before.get(k) for k in keys):
            return False, f"배치 {bid}의 공식 저장·진전이 아직 없습니다"
        confirm = (unit.get("confirm") or {}).get(str(bid))
        if confirm is None:
            return False, f"배치 {bid} 진전 확인됨 — 다음 확인에서 정상 생산 지속을 봅니다"
        if all(now_p.get(k) == confirm.get(k) for k in keys) and now_p["rank"] < STATE_RANK["WAITING_REVIEW"]:
            return False, f"배치 {bid}의 후속 생산 지속이 아직 확인되지 않았습니다"
        return True, f"배치 {bid} 공식 저장·후속 진전 확인"

    def _partly_recovered(self, case, unit: dict) -> bool:
        ids = [i for i in self.store.recovery_case_batch_ids(case["id"])
               if (b := self.store.batch(i)) is not None and b["method"] != MAINTENANCE_METHOD]
        return bool(ids) and all(self._batch_recovered(i, unit)[0] or str(i) in (unit.get("confirm") or {}) for i in ids)

    def _note_confirm(self, case, unit: dict) -> None:
        """Record the first observed recovery of each batch; RESOLVED needs production continuing after it."""
        confirm = unit.setdefault("confirm", {})
        changed = False
        for bid in self.store.recovery_case_batch_ids(case["id"]):
            b = self.store.batch(bid)
            if b is None or str(bid) in confirm or b["state"] in ("ERROR", "PAUSED", "CLEARING"):
                continue
            before = (unit.get("batches") or {}).get(str(bid)) or {}
            p = self._progress(b)
            if any(p.get(k) != before.get(k) for k in ("saved", "progress_done", "records_done", "rank", "head", "merged")):
                confirm[str(bid)] = p
                changed = True
        if changed:
            self.store.update_recovery_case(case["id"], blocking_unit=unit)

    def _loaded(self, sha: str | None) -> bool:
        if not sha:
            return True
        loaded = self.sup.code_sha
        if not loaded:
            return False
        if loaded == sha:
            return True
        from . import restart_controller as rc
        try:
            return rc._ancestor(self.sup.code_root, sha, loaded)
        except Exception:
            return False

    def _pull(self, n: int) -> dict:
        ttl = min(60.0, float(self.cfg.get("poll_seconds", 300)))
        hit = self._pulls.get(n)
        if hit is not None and self.now() - hit[0] < ttl:
            return hit[1]
        info = self.sup.gh.pull(n)
        self._pulls[n] = (self.now(), info)
        return info

    def _pr_done(self, n: int | None) -> tuple[bool, str]:
        if not n:
            return True, ""
        try:
            info = self._pull(n)
        except Exception as e:
            return False, f"PR #{n} 조회 실패: {e}"
        if info.get("merged"):
            if not self._loaded(info.get("merge_commit_sha")):
                return False, f"PR #{n} 머지 {str(info.get('merge_commit_sha'))[:10]}가 loaded_code_sha에 없습니다"
            return True, ""
        if info.get("state") == "closed":
            return True, ""   # closed as superseded
        return False, f"PR #{n}이 아직 열려 있습니다"

    def resolved(self, case) -> tuple[bool, str]:
        """RESOLVED per failure type, against the blocking unit recorded when the case opened."""
        unit = _json(case["blocking_unit"], {})
        ok, why = self._pr_done(case["pr_number"])
        if not ok:
            return False, why
        if case["kind"] == "supervisor":
            if unit.get("instance") is not None and self.sup.phase_instance == unit.get("instance"):
                return False, "아직 같은 Supervisor instance입니다 (새 instance 미확인)"
            if not self._loaded(unit.get("merge_sha")):
                return False, f"필요한 수정 {str(unit.get('merge_sha'))[:10]}가 loaded_code_sha에 없습니다"
        if case["issue"]:
            st = self.maintainer_state(case["issue"])
            if st not in ("none", "progressing"):
                return False, f"Maintainer Issue #{case['issue']}가 정상화되지 않았습니다 ({st})"
        ids = self.store.recovery_case_batch_ids(case["id"])
        for bid in ids:
            b = self.store.batch(bid)
            if b is not None and b["method"] == MAINTENANCE_METHOD:
                continue   # judged above through its Issue
            ok, why = self._batch_recovered(bid, unit)
            if not ok:
                return False, why
        if not ids and case["kind"] not in ("supervisor", "maintainer"):
            return False, "대조할 배치가 없습니다"
        return True, "공식 증거 확인"

    def boundary_evidence(self, case, boundary: str, run=None, ad=None) -> dict | None:
        """The official record a BOUNDARY claim must match, as the WAITING_OWNER release condition; None = rejected."""
        ids = self.store.recovery_case_batch_ids(case["id"])
        if boundary == "owner_control":
            owned = [(bid, why) for bid in ids if (b := self.store.batch(bid)) is not None
                     and (why := self._owner_control(b, case))]
            return {"kind": "owner_control", "batches": [bid for bid, _ in owned]} if owned else None
        if boundary == "limit" and run is not None and ad is not None:
            return self._limit_evidence(run, ad)
        if boundary == "denied" and run is not None and ad is not None:
            try:
                denied = ad.denied_actions(Path(run["log_file"]))
            except Exception:
                denied = None
            if denied:
                return {"kind": "denied", "actions": denied[:5], "cfg": _sha(self.cfg)}
            return None
        if boundary == "ownership" and case["issue"]:
            if self.maintainer_state(case["issue"]) == "progressing":
                return {"kind": "ownership", "issue": case["issue"]}
        return None

    def _wait_released(self, case, now: float) -> bool:
        wait = _json(case["wait_reason"], {})
        kind = wait.get("kind")
        if kind == "owner_control":
            return not any((b := self.store.batch(bid)) is not None and self._owner_control(b, case)
                           for bid in wait.get("batches") or [])
        if kind == "limit":
            return now >= float(wait.get("until") or 0)
        if kind == "denied":
            return self.store.get(resume_key(case["id"])) is not None or _sha(self.cfg) != wait.get("cfg")
        if kind == "ownership":
            return self.maintainer_state(wait.get("issue")) != "progressing"
        return True

    # ---- case lifecycle ---------------------------------------------------------------------------------------------
    def _resolve(self, case, why: str) -> None:
        if self.store.resolve_recovery_case(case["id"], f"RESOLVED: {why}"):
            self.store.delete(resume_key(case["id"]))
            unit = _json(case["blocking_unit"], {})
            if unit.get("took_over_maintainer"):
                self.store.delete(f"recovery_takeover_{unit['took_over_maintainer']}")
            self._log(f"case {case['key']} RESOLVED — {why}")

    def _restore_maintainer(self, case, unit: dict) -> None:
        bid = unit["took_over_maintainer"]
        if control.retry_maintainer(self.store, case["issue"], bid):
            unit["maintainer_restored"] = True
            self.store.update_recovery_case(case["id"], blocking_unit=unit)
            self._log(f"case {case['key']}: 넘겨받았던 Maintainer 실행 #{bid}를 공식 Retry로 되돌립니다")

    def _advance(self, case, now: float) -> None:
        if case is None or case["state"] == "RESOLVED":
            return
        if any(r["case_id"] == case["id"] for r in self.store.open_recovery_runs()):
            return   # its run works; collection judges it when it ends
        if not case["issue"]:   # an ERROR the Maintainer took in after this case opened joins its Issue
            for bid in self.store.recovery_case_batch_ids(case["id"]):
                b = self.store.batch(bid)
                if b is not None and (issue := self.group(b)[1]) is not None:
                    self.store.update_recovery_case(case["id"], issue=issue)
                    case = self.store.recovery_case(case["id"])
                    break
        unit = _json(case["blocking_unit"], {})
        if unit.get("legacy") and not unit.get("legacy_done"):
            if self._tmux_alive(unit.get("tmux", "")) or self._tmux_alive("recovery-inspector"):
                return   # the old desk's session still owns this failure
            unit["legacy_done"] = True
            self.store.update_recovery_case(case["id"], state="OPEN", blocking_unit=unit,
                                            notes=self._note(case, "legacy 세션 종료 — Recovery가 이어받습니다"))
            case = self.store.recovery_case(case["id"])
        self._note_confirm(case, unit)
        case = self.store.recovery_case(case["id"])
        ok, why = self.resolved(case)
        if ok:
            return self._resolve(case, why)
        if case["state"] == "WAITING_OWNER":
            if not self._wait_released(case, now):
                return
            self.store.delete(resume_key(case["id"]))
            self.store.update_recovery_case(case["id"], state="OPEN", wait_reason=None,
                                            notes=self._note(case, "오너 대기 해소 — 같은 세션으로 이어갑니다"))
            case = self.store.recovery_case(case["id"])
        ids = self.store.recovery_case_batch_ids(case["id"])
        owned = [bid for bid in ids if (b := self.store.batch(bid)) is not None and self._owner_control(b, case)]
        if owned and len(owned) == len([i for i in ids if self.store.batch(i) is not None]):
            return self.store.update_recovery_case(case["id"], state="WAITING_OWNER",
                                                   wait_reason={"kind": "owner_control", "batches": owned})
        if case["issue"] and self.maintainer_state(case["issue"]) == "progressing" and not unit.get("took_over_maintainer"):
            if case["state"] != "MAINTAINER":
                self.store.update_recovery_case(case["id"], state="MAINTAINER")
            return   # the Maintainer owns this failure now: track only
        if case["state"] == "MAINTAINER":
            self.store.update_recovery_case(case["id"], state="OPEN")
            case = self.store.recovery_case(case["id"])
        if case["state"] == "TRACKING":
            if not self._tracking_needs_action(case, unit):
                return   # a normal wait (review / CI / merge / confirmation): no AI until a fact changes
            self.store.update_recovery_case(case["id"], state="OPEN", wait_reason=None)
            case = self.store.recovery_case(case["id"])
        if case["next_action_at"] and now < case["next_action_at"]:
            return
        if not self._takeover_if_needed(case, unit):
            return
        self._launch(self.store.recovery_case(case["id"]), now)

    def _tracking_needs_action(self, case, unit: dict) -> bool:
        wait = _json(case["wait_reason"], {})
        obs = self._obs()
        for bid in self.store.recovery_case_batch_ids(case["id"]):
            b = self.store.batch(bid)
            if b is None or b["method"] == MAINTENANCE_METHOD:
                continue
            mark = (wait.get("marks") or {}).get(str(bid))
            now_mark = [b["state"], b["error_seq"], (b["error"] or "")[:200]]
            if b["state"] in ("ERROR", "PAUSED") and not self._owner_control(b, case) and not self._limited(b) \
                    and b["pause_reason"] != "shared_defect" and now_mark != mark:
                return True   # a new failure since the wait began
            if (obs.get("stall", {}).get(str(bid)) or {}).get("count", 0) >= STALL_CHECKS:
                return True
        kind = wait.get("kind")
        if kind == "pr":
            try:
                info = self._pull(wait.get("pr"))
            except Exception:
                return False   # asked again next turn
            return bool(info.get("merged")) or info.get("state") == "closed"   # the next step (apply, recover) is due
        if kind == "maintainer_restore":
            return case["issue"] is not None and self.maintainer_state(case["issue"]) == "stopped"
        if kind == "confirm":
            return False
        return not (unit.get("legacy") and not unit.get("legacy_done"))

    def _takeover_if_needed(self, case, unit: dict) -> bool:
        """A stopped Maintainer is handed over through the official Stop first; True once nothing else works on it."""
        if not case["issue"]:
            return True
        m = self.store.maintenance(case["issue"])
        mb = self.store.batch(m["batch_id"]) if m is not None and m["batch_id"] else None
        if mb is None or mb["state"] == "COMPLETE":
            return True
        if not unit.get("took_over_maintainer"):
            if self.maintainer_state(case["issue"]) != "stopped":
                return True
            self.store.set(f"recovery_takeover_{mb['id']}", str(case["id"]))
            if mb["state"] not in ("ERROR", "PAUSED") and not control.stop_maintainer(self.store, mb["producer"], mb["id"]):
                self.store.delete(f"recovery_takeover_{mb['id']}")
                return False
            unit["took_over_maintainer"] = mb["id"]
            self.store.attach_recovery_batch(case["id"], mb["id"])
            self.store.update_recovery_case(case["id"], blocking_unit=unit,
                                            notes=self._note(case, f"멈춘 Maintainer 실행 #{mb['id']}를 공식 Stop으로 넘겨받음"))
            self._log(f"case {case['key']}: 멈춘 Maintainer 실행 #{mb['id']}를 공식 Stop으로 넘겨받습니다", "warn",
                      batch_id=mb["id"])
            mb = self.store.batch(mb["id"])
        if unit.get("took_over_maintainer") == mb["id"] and not unit.get("maintainer_restored"):
            # Never two fixers at once: wait until the Maintainer's own run is gone.
            return mb["state"] in ("ERROR", "PAUSED") and mb["pid"] is None and not self.store.open_task_runs(mb["id"])
        return True

    # ---- prompts and launch -----------------------------------------------------------------------------------------
    def evidence(self, case) -> dict:
        """The facts a follow-up depends on. Unchanged evidence + the same prompt kind = no resend."""
        batches = []
        for bid in self.store.recovery_case_batch_ids(case["id"]):
            b = self.store.batch(bid)
            if b is not None:
                batches.append({"id": bid, "state": b["state"], "error": (b["error"] or "")[:400], "head": b["head_sha"],
                                "pr": b["pr_number"], "progress": self._progress(b)})
        report = _json(case["last_report"], {})
        return {"batches": batches, "pr": case["pr_number"],
                "report": {k: report.get(k) for k in ("STATUS", "BLOCKER", "BOUNDARY", "exit")},
                "maint": dict(self.store.maintenance(case["issue"])) if case["issue"] and self.store.maintenance(case["issue"]) else None,
                "code": self.sup.code_sha}

    def facts(self, case) -> dict:
        unit = _json(case["blocking_unit"], {})
        rows = []
        for bid in self.store.recovery_case_batch_ids(case["id"]):
            b = self.store.batch(bid)
            if b is None:
                continue
            ln = self.store.peek_line(b["producer"], b["method"])
            rows.append({
                "batch_id": bid, "line": f"{b['producer']}/{b['method']}", "state": b["state"],
                "error": b["error"], "pause_reason": b["pause_reason"] or None, "shard": b["shard"], "batch": b["batch"],
                "worktree": b["worktree"], "branch": b["branch"], "head_sha": b["head_sha"], "pr": b["pr_number"],
                "session_id": b["session_id"], "log_file": b["log_file"], "defect_id": b["defect_id"],
                "line_controls": {k: ln.get(k) for k in ("mode", "run", "drain", "force_stop")} if ln else None,
                "failing_tasks": [dict(t) | {"data": None} for t in self.store.task_rows(bid) if t["state"] != "SAVED"][:20],
                "recent_runs": [{k: r[k] for k in ("id", "kind", "task", "pid", "log_file", "exit_status", "started_at",
                                                   "ended_at")} for r in self.store.runs(bid)[-5:]],
            })
        runtime = _json(_read(self.sup.paths.runtime_record_file), {})
        return {"case": case["key"], "kind": case["kind"], "opened_at": case["opened_at"], "issue": case["issue"],
                "pr": case["pr_number"], "reason": unit.get("reason"), "took_over_maintainer": unit.get("took_over_maintainer"),
                "required_merge_sha": unit.get("merge_sha"), "batches": rows,
                "maintenance": dict(self.store.maintenance(case["issue"])) if case["issue"] and self.store.maintenance(case["issue"]) else None,
                "supervisor_runtime": runtime or "미확인", "repo": self.cfg.get("repo"),
                "operating_root": str(self.sup.paths.repo_root),
                "stop_retry": "sh tools/warroom/recovery-desk/control.sh stop-retry <model> <method> <batch-id>",
                "restart": "./kwar --no-attach",
                "legacy_log": unit.get("legacy_log"), "previous_report": _json(case["last_report"], {}) or None,
                "notes": (case["notes"] or "")[-1500:] or None}

    LEADS = {
        "followup": ("Supervisor가 이 case를 다시 확인했고 아직 해결되지 않았습니다. 아래 최신 사실에서 수행 가능한 다음 단계를 "
                     "진행하세요. 이미 한 일을 반복하지 말고, 남은 단계부터 이어갑니다."),
        "investigate": ("같은 증거에 같은 후속 지시가 반복됐고 진전이 없었습니다. '계속'하지 말고 **왜 진전이 없는지 근본 원인을 "
                        "조사**하세요. 실패한 명령·반환값·마지막 오류를 다시 확인하고, 같은 실패를 다시 만들지 않는 공통 수정"
                        "(입력·프롬프트·task 계약·Supervisor/CLI fallback)을 구현해 PR로 진행하세요."),
    }

    def prompt(self, case, kind: str, fresh: bool) -> str:
        """A new session gets the whole contract with the case facts; a follow-up resumes the same session."""
        facts = json.dumps(self.facts(case), ensure_ascii=False, indent=2, default=str)
        if fresh:
            text = prompts.render("recovery", {"case_key": case["key"], "case_facts": facts})
            return text + (f"\n\n## 이번 지시\n\n{self.LEADS[kind]}\n" if kind in self.LEADS else "")
        return (f"# Recovery 후속 지시 — CASE `{case['key']}`\n\n{self.LEADS.get(kind, self.LEADS['followup'])}\n\n"
                f"```json\n{facts}\n```\n\n"
                "계약(prompts/recovery.md)은 그대로 유효합니다: 운영 DB 직접 수정·완료 플래그 조작·운영 checkout 직접 수정 금지, "
                "오너 Stop·Clear·run=0 해제 금지, 권한 거절 우회 금지. 마지막 답변은 STATUS/CASE/DONE/REMAINING/BLOCKER/"
                "BOUNDARY/PR 블록으로 끝냅니다.\n")

    def _backoff(self, case, why: str) -> None:
        turns = (case["no_progress_turns"] or 0) + 1
        wait = min(BACKOFF_MIN * (2 ** (turns - 1)), BACKOFF_MAX)
        self.store.update_recovery_case(case["id"], no_progress_turns=turns, next_action_at=self.now() + wait,
                                        notes=self._note(case, f"{why} — {int(wait // 60)}분 뒤 다시 확인"))
        self._log(f"case {case['key']}: {why} — {int(wait // 60)}분 뒤 다시 확인", "warn")

    def _launch(self, case, now: float) -> None:
        problem = recovery_problem(self.cfg)
        if problem:
            return self._log_once(f"설정 오류로 복구 실행을 시작하지 않습니다: {problem}", "error")
        producer = self._producer()
        evidence = _sha(self.evidence(case))
        last = case["last_prompt_hash"]
        repeat = False
        if last in (_sha(["start", evidence]), _sha(["followup", evidence])):
            kind = "investigate"   # the same evidence would get the same prompt: never resent as is
        elif last == _sha(["investigate", evidence]):
            if not case["next_action_at"]:
                return self._backoff(case, "같은 증거로 원인 조사까지 진전이 없었습니다 (증거 변화 대기)")
            kind, repeat = "investigate", True   # the back-off ran out with unchanged evidence: look once more
        else:
            kind = "followup" if case["session_id"] else "start"
        prompt_hash = _sha([kind, evidence])
        try:
            run = run_spec(self.cfg, producer, RECOVERY)
        except ValueError as e:
            return self._log_once(f"실행 설정 오류: {e}", "error")
        pre = self.sup._preflight_run(producer, run)
        if pre:
            if not pre.startswith("추론 수준 확인 중"):
                self._log_once(f"실행 전 확인 실패: {pre}", "error")
            return
        session = case["session_id"]
        try:
            text = self.prompt(case, kind, fresh=not session)
        except prompts.PromptError as e:
            return self._log_once(f"프롬프트 오류: {e}", "error")
        ad = self.sup._adapter(producer)
        ts = int(now)
        log = self.logs_dir() / f"case-{case['id']}-{ts}.log"
        while log.exists():
            ts += 1
            log = self.logs_dir() / f"case-{case['id']}-{ts}.log"
        ex = log.with_suffix(".exit")
        extra = {}
        name = getattr(ad, "name", "")
        if name == "claude":
            extra["permission_mode"] = "auto"
        if getattr(ad, "needs_git_dir", False):
            extra["git_dir"] = str(self.sup.paths.git_admin_dir)
        with self.sup.launch_gate.permit():
            run_id = self.store.claim_recovery_run(
                case["id"], kind, producer=producer, model=run.model, effort=run.effort,
                permission=run.permission_profile or ("auto" if name == "claude" else ""), session_id=session,
                log_file=log, exit_file=ex, max_parallel=int(self.cfg.get("recovery_max_parallel", 1)), now=time.time())
            if run_id is None:
                return   # another instance/the watchdog already runs this case, or the parallel limit is reached
            try:
                env = self.sup._agent_env()
                if session:
                    h = ad.resume(session, text, self.sup.paths.repo_root, env, run, log, ex, **extra)
                else:
                    h = ad.start(text, self.sup.paths.repo_root, env, run, f"Recovery {case['key']}", log, ex, **extra)
            except SpawnNotStarted as e:
                self.store.finish_recovery_run(run_id, "not_started")
                return self._backoff(case, f"복구 실행을 시작하지 못했습니다: {e}")
            except Exception as e:
                self.store.finish_recovery_run(run_id, "launch_error")
                return self._backoff(case, f"복구 실행 시작 오류: {type(e).__name__}: {e}"[:400])
            self.store.set_recovery_run(run_id, pid=h.pid)
        fields = {"last_prompt_hash": prompt_hash, "state": "OPEN"}
        if repeat:
            turns = (case["no_progress_turns"] or 0) + 1
            fields.update(no_progress_turns=turns, next_action_at=now + min(BACKOFF_MIN * (2 ** turns), BACKOFF_MAX))
        elif kind != "investigate":
            fields.update(no_progress_turns=0, next_action_at=None)
        self.store.update_recovery_case(case["id"], **fields)
        self._log(f"case {case['key']} 복구 실행 #{run_id} 시작 ({kind}, {producer} {run.model})")


def _read(path: Path) -> str | None:
    try:
        return Path(path).read_text("utf-8")
    except OSError:
        return None
