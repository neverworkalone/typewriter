"""SQLite persistent state. Short-lived connections: TUI and Supervisor share the file."""
from __future__ import annotations

import json
import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .usage import parse_usage

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  method TEXT NOT NULL, producer TEXT NOT NULL,
  shard TEXT NOT NULL, batch TEXT NOT NULL,
  branch TEXT NOT NULL, worktree TEXT NOT NULL,
  state TEXT NOT NULL, paused_from TEXT,
  pr_number INTEGER, head_sha TEXT, session_id TEXT,
  pid INTEGER, exit_file TEXT, log_file TEXT, run_kind TEXT,
  model_tier TEXT NOT NULL DEFAULT 'free',
  retries INTEGER NOT NULL DEFAULT 0, retry_after REAL,
  records_done INTEGER, records_total INTEGER,
  error TEXT, merged INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, updated_at REAL NOT NULL,
  UNIQUE(method, producer, shard, batch)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER,
  ts REAL NOT NULL, level TEXT NOT NULL, msg TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handled_events (
  batch_id INTEGER NOT NULL, pr INTEGER NOT NULL, head_sha TEXT NOT NULL,
  event_key TEXT NOT NULL, ts REAL NOT NULL,
  PRIMARY KEY (batch_id, pr, head_sha, event_key)
);
-- Operator Clear: one batch-ID-specific request per unfinished batch; the Supervisor owns the teardown.
CREATE TABLE IF NOT EXISTS clear_requests (
  batch_id INTEGER PRIMARY KEY, model TEXT NOT NULL, method TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'REQUESTED',   -- REQUESTED (teardown runs) | BLOCKED (waits for an operator retry)
  error TEXT, note TEXT NOT NULL DEFAULT '', prior_state TEXT, requested_at REAL NOT NULL
);
"""

# Additive migration (user_version 2): per-Line controls and run history. Existing tables/rows
# are never rewritten or dropped; legacy kv controls and logs are imported by _migrate.
SCHEMA_V2 = """
CREATE TABLE IF NOT EXISTS lines (
  model TEXT NOT NULL, method TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'single', run INTEGER NOT NULL DEFAULT 0,
  drain INTEGER NOT NULL DEFAULT 0, force_stop INTEGER NOT NULL DEFAULT 0,
  retry_batch INTEGER, blocked TEXT NOT NULL DEFAULT '',
  model_tier TEXT NOT NULL DEFAULT 'free', updated_at REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (model, method)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER NOT NULL,
  kind TEXT NOT NULL, session_id TEXT, pid INTEGER,
  log_file TEXT, exit_file TEXT,
  started_at REAL NOT NULL, ended_at REAL, exit_status TEXT
);
CREATE INDEX IF NOT EXISTS runs_batch ON runs(batch_id);
CREATE INDEX IF NOT EXISTS events_line ON events(batch_id);
"""
# Additive migration (user_version 3): every run records the CLI model ID and reasoning effort it was pinned to.
# Old runs keep NULL; nothing is rewritten.
RUN_COLUMNS_V3 = ("model", "effort")
# Additive migration (user_version 4): a one-shot "finish this batch, then stop" request set by Drain All.
# Additive migration (user_version 5): every run also records the Codex permission profile it was pinned to
# ('' = none configured). Old runs keep NULL, which the pin-drift check treats as "not recorded".
RUN_COLUMNS_V5 = ("permission_profile",)
# Additive migration (user_version 6, Issue #1555): shared-defect reports (`defects`), the issue-scoped Maintainer
# task record (`maintenance`), and the pause reason / defect link of a batch. Nothing existing is rewritten.
SCHEMA_V6 = """
CREATE TABLE IF NOT EXISTS defects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE, batch_id INTEGER NOT NULL, source TEXT NOT NULL,
  defect_class TEXT NOT NULL DEFAULT '', state TEXT NOT NULL, report TEXT NOT NULL,
  issue_number INTEGER, hold_reason TEXT, merge_sha TEXT, integrated_sha TEXT,
  created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS defects_issue ON defects(issue_number);
CREATE TABLE IF NOT EXISTS maintenance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_number INTEGER NOT NULL UNIQUE, state TEXT NOT NULL,
  batch_id INTEGER, pr_number INTEGER, merge_sha TEXT, hold_reason TEXT,
  created_at REAL NOT NULL, updated_at REAL NOT NULL
);
"""
# Additive migration (user_version 10, Issue #2291): durable requests for ordinary and urgent Issues. These requests
# are separate from `defects`, whose batch-pause and shared-defect lifecycle remains unchanged.
SCHEMA_V10 = """
CREATE TABLE IF NOT EXISTS issue_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL, body TEXT NOT NULL,
  urgent INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'PENDING',
  issue_number INTEGER UNIQUE,
  created_at REAL NOT NULL, updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS issue_requests_state ON issue_requests(state, id);
"""
# Additive migration (user_version 13, Issue #2430): durable one-shot Drain reservations.
SCHEMA_V13 = """
CREATE TABLE IF NOT EXISTS drain_schedules (
  target TEXT PRIMARY KEY,
  model TEXT, method TEXT, batch_id INTEGER,
  due_at REAL NOT NULL, created_at REAL NOT NULL,
  CHECK ((target='all' AND model IS NULL AND method IS NULL AND batch_id IS NULL)
      OR (target LIKE 'batch:%' AND model IS NOT NULL AND method IS NOT NULL AND batch_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS drain_schedules_due ON drain_schedules(due_at);
"""
# Additive migration (user_version 7, Issue #1684): `lines.shard_pin` is the shard a Single-mode Stage 2 run is bound to.
# Additive migration (user_version 8, Issue #1809): the observed unit of intermediate progress (chunks/senses).
# Additive migration (user_version 9, Issue #2033): per-run token / tool-call usage read from the run's own log when
# the run ends. NULL = not measured (old runs, missing usage); never 0 as a stand-in.
RUN_USAGE_COLUMNS_V9 = ("input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens",
                        "reasoning_output_tokens", "tool_calls", "submit_failures")
# Additive migration (user_version 12, Issue #2361): best-effort/incomplete OpenCode usage quality for honest totals.
SCHEMA_VERSION = 13

MAINTENANCE_METHOD = "m"   # the hidden Maintainer's execution record lives in `batches` under this method
CLEARED_HOLD = "운영자가 Maintainer 실행을 Clear함 — Issue·결함 기록 보존, 명시적 Retry 전에는 자동 재시작하지 않습니다"
STAGE2_METHOD = "s2"       # Stage 2 Relation Admission: ONE Part at a time across all models, not a Stage 1 queue method
STAGE3_METHOD = "s3"       # Stage 3 editorial pass: one owned shard and one PR at a time

ACTIVE_STATES = ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING", "MERGED",
                 "CLEANUP", "PAUSED", "ERROR", "CLEARING")
# Per-batch kv keys the Supervisor writes; removed with the batch by Clear.
BATCH_KV_PREFIXES = ("last_poll_", "last_poll_fixhead_", "headlag_", "last_merge_check_", "no_pr_recovery_",
                     "verified_completion_run_", "defect_hold_", "cleanup_proof_", "stop_after_pr_",
                     "fix_claim_", "fix_context_sent_", "fix_context_pending_",
                     "s2_run_start_", "s2_links_start_", "s2_repair_state_", "s2_repair_run_start_",
                     "s2_finalize_base_", "s2_commit_head_", "s2_fix_start_",
                     "s3_run_start_", "s3_wait_", "s3_apply_ready_", "s3_apply_result_", "s3_commit_head_",
                     "s3_merge_wait_",
                     "pending_", "pr_create_")


class LineBusy(Exception):
    """A Line owns at most one unfinished batch."""


class LineNotRunnable(Exception):
    """The Line's controls no longer allow a new batch (run cancelled, Drain, Drain All) at insert time."""


class DuplicateBatch(LineBusy):
    """Another model already holds this (method, shard, batch) of a shared (C/D) queue."""


SHARED_QUEUE_METHODS = ("c", "d")   # one queue across all models; A/B keep a queue per model


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.executescript(SCHEMA)
            if c.execute("PRAGMA user_version").fetchone()[0] < SCHEMA_VERSION:
                self._migrate(c)

    @staticmethod
    def _migrate(c) -> None:
        c.executescript(SCHEMA_V2)
        if "line" not in {r["name"] for r in c.execute("PRAGMA table_info(events)")}:
            c.execute("ALTER TABLE events ADD COLUMN line TEXT")
        have = {r["name"] for r in c.execute("PRAGMA table_info(runs)")}
        for col in RUN_COLUMNS_V3 + RUN_COLUMNS_V5:
            if col not in have:
                c.execute(f"ALTER TABLE runs ADD COLUMN {col} TEXT")
        # Legacy single-worker controls become the controls of that batch's Line.
        legacy = {r["key"]: r["value"] for r in c.execute("SELECT key,value FROM kv")}
        rows = c.execute("SELECT * FROM batches ORDER BY id").fetchall()
        for key in sorted({(r["producer"], r["method"]) for r in rows}):
            latest = [r for r in rows if (r["producer"], r["method"]) == key][-1]
            busy = latest["state"] != "COMPLETE"
            retry = legacy.get("retry", "")
            c.execute(
                "INSERT OR IGNORE INTO lines(model,method,mode,run,drain,force_stop,retry_batch,blocked,"
                "model_tier,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (key[0], key[1], "continuous" if legacy.get("mode") == "continuous" else "single",
                 1 if busy and legacy.get("run") == "1" else 0, 1 if legacy.get("stop_after") == "1" else 0,
                 # A pending (unprocessed) Stop / Retry belongs to the Line owning the unfinished batch.
                 1 if busy and legacy.get("force_stop") == "1" else 0,
                 # Stop wins over a Retry that was queued alongside it.
                 int(retry) if busy and retry == str(latest["id"]) and legacy.get("force_stop") != "1" else None,
                 legacy.get("blocked", "") if busy or legacy.get("run") == "1" else "",
                 latest["model_tier"], time.time()))
        # Run history from the logs the old Supervisor kept: batch-<id>-<ts>.log/.exit
        for r in rows:
            if not r["log_file"]:
                continue
            log = Path(r["log_file"])
            for f in sorted(log.parent.glob(f"batch-{r['id']}-*.log")):
                m = re.fullmatch(rf"batch-{r['id']}-(\d+)\.log", f.name)
                if not m or c.execute("SELECT 1 FROM runs WHERE log_file=?", (str(f),)).fetchone():
                    continue
                ex = f.with_suffix(".exit")
                try:
                    status = ex.read_text().strip() if ex.exists() else None
                except OSError:
                    status = None
                last = str(f) == r["log_file"]
                c.execute("INSERT INTO runs(batch_id,kind,session_id,pid,log_file,exit_file,started_at,ended_at,"
                          "exit_status) VALUES(?,?,?,?,?,?,?,?,?)",
                          (r["id"], (r["run_kind"] if last and r["run_kind"] else "legacy"),
                           r["session_id"] if last else None, r["pid"] if last and status is None else None,
                           str(f), str(ex), float(m.group(1)),
                           ex.stat().st_mtime if status is not None else None, status))
        c.executescript(SCHEMA_V6)
        have = {r["name"] for r in c.execute("PRAGMA table_info(batches)")}
        if "pause_reason" not in have:
            c.execute("ALTER TABLE batches ADD COLUMN pause_reason TEXT NOT NULL DEFAULT ''")
        if "defect_id" not in have:
            c.execute("ALTER TABLE batches ADD COLUMN defect_id INTEGER")
        if "shard_pin" not in {r["name"] for r in c.execute("PRAGMA table_info(lines)")}:
            c.execute("ALTER TABLE lines ADD COLUMN shard_pin TEXT NOT NULL DEFAULT ''")
        for col in ("progress_kind TEXT", "progress_done INTEGER", "progress_total INTEGER"):
            if col.split()[0] not in have:
                c.execute(f"ALTER TABLE batches ADD COLUMN {col}")
        have = {r["name"] for r in c.execute("PRAGMA table_info(runs)")}
        for col in RUN_USAGE_COLUMNS_V9:
            if col not in have:
                c.execute(f"ALTER TABLE runs ADD COLUMN {col} INTEGER")
        if "usage_quality" not in have:
            c.execute("ALTER TABLE runs ADD COLUMN usage_quality TEXT")
        c.executescript(SCHEMA_V10)
        c.executescript(SCHEMA_V13)
        handled_columns = {r["name"] for r in c.execute("PRAGMA table_info(handled_events)")}
        for column in ("status TEXT NOT NULL DEFAULT 'LEGACY'", "run_id INTEGER", "reply_id INTEGER",
                       "completed_at REAL"):
            name = column.split()[0]
            if name not in handled_columns:
                c.execute(f"ALTER TABLE handled_events ADD COLUMN {column}")
        c.execute(f"PRAGMA user_version={SCHEMA_VERSION}")

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(self.path, timeout=30)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    # --- key/value (operator controls, supervisor heartbeat) ---
    def get(self, key: str, default: str | None = None) -> str | None:
        with self._conn() as c:
            row = c.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    def set(self, key: str, value: str) -> None:
        with self._conn() as c:
            c.execute("INSERT INTO kv(key,value) VALUES(?,?) "
                      "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value))

    def kv_prefix(self, prefix: str) -> list:
        with self._conn() as c:
            return c.execute("SELECT key, value FROM kv WHERE substr(key, 1, ?)=? ORDER BY key",
                             (len(prefix), prefix)).fetchall()

    def delete_prefix(self, prefix: str) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM kv WHERE substr(key, 1, ?)=?", (len(prefix), prefix))

    def delete(self, key: str) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM kv WHERE key=?", (key,))

    # --- batches ---
    def create_batch(self, from_run: bool = False, **f) -> int:
        """Insert a PREPARE batch. `from_run`: the Supervisor assigns it on behalf of a run reservation, so the
        Line's *current* controls (read under the same write lock) must still allow it: a Stop, Drain or
        Drain All that landed after the tick read the Line cannot be overtaken."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")   # check + insert under one write lock: concurrent Starts cannot both claim
            if from_run:
                ln = c.execute("SELECT run, drain, force_stop FROM lines WHERE model=? AND method=?",
                               (f["producer"], f["method"])).fetchone()
                if ln is None or not ln["run"] or ln["drain"] or ln["force_stop"]:
                    raise LineNotRunnable(f"{f['producer']}/{f['method']} 라인이 신규 배치를 받을 수 없는 상태입니다.")
            if c.execute("SELECT 1 FROM batches WHERE method=? AND producer=? AND state!='COMPLETE'",
                         (f["method"], f["producer"])).fetchone():
                raise LineBusy(f"{f['producer']}/{f['method']} 라인에 미완료 배치가 있습니다.")
            if f["method"] == STAGE2_METHOD:   # Stage 2 owns ONE Part for the whole factory, whichever model holds it
                held = c.execute("SELECT producer, shard, batch, state FROM batches WHERE method=? AND state!='COMPLETE'",
                                 (STAGE2_METHOD,)).fetchone()
                if held:
                    raise LineBusy(f"Stage 2는 전체에서 한 Part만 점유합니다: {held['producer']}가 "
                                   f"{held['shard']}_{held['batch']}({held['state']})를 소유 중입니다.")
                s3 = c.execute("SELECT producer, shard, state FROM batches WHERE method=? AND shard=? "
                               "AND state!='COMPLETE'", (STAGE3_METHOD, f["shard"])).fetchone()
                if s3:
                    raise LineBusy(f"Stage 3가 샤드 {f['shard']}를 점유 중입니다 ({s3['producer']}/{s3['state']}).")
            if f["method"] == STAGE3_METHOD:
                held = c.execute("SELECT producer, shard, state FROM batches WHERE method=? AND state!='COMPLETE'",
                                 (STAGE3_METHOD,)).fetchone()
                if held:
                    raise LineBusy(f"Stage 3는 한 번에 한 샤드만 점유합니다: {held['producer']}가 "
                                   f"샤드 {held['shard']}({held['state']})를 소유 중입니다.")
                prior = c.execute("SELECT producer, state FROM batches WHERE method=? AND shard=? "
                                  "AND state='COMPLETE' AND merged=1", (STAGE3_METHOD, f["shard"])).fetchone()
                if prior:
                    raise LineBusy(f"Stage 3 샤드 {f['shard']}는 이미 {prior['producer']}의 완료 기록이 있습니다.")
                s2 = c.execute("SELECT producer, batch, state FROM batches WHERE method=? AND shard=? "
                               "AND state!='COMPLETE'", (STAGE2_METHOD, f["shard"])).fetchone()
                if s2:
                    raise LineBusy(f"Stage 2가 샤드 {f['shard']}를 점유 중입니다 ({s2['producer']}/{s2['batch']}/{s2['state']}).")
            if f["method"] in SHARED_QUEUE_METHODS:
                other = c.execute("SELECT producer, state FROM batches WHERE method=? AND shard=? AND batch=? "
                                  "AND producer!=?", (f["method"], f["shard"], f["batch"], f["producer"])).fetchone()
                if other:
                    raise DuplicateBatch(f"{f['method'].upper()} {f['shard']}_{f['batch']} 배치는 이미 "
                                         f"{other['producer']}({other['state']})가 점유 중입니다.")
            cur = c.execute(
                "INSERT INTO batches(method,producer,shard,batch,branch,worktree,state,"
                "model_tier,records_total,run_kind,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                (f["method"], f["producer"], f["shard"], f["batch"], f["branch"],
                 f["worktree"], "PREPARE", f.get("model_tier", "free"),
                 f.get("records_total"), f.get("run_kind"), now, now))
            if f.get("shard_pin") is not None:   # the Single shard binding commits WITH the Part: a crash cannot split them
                c.execute("INSERT OR IGNORE INTO lines(model,method,updated_at) VALUES(?,?,?)", (f["producer"], f["method"], now))
                c.execute("UPDATE lines SET shard_pin=?, blocked='', updated_at=? WHERE model=? AND method=?",
                          (f["shard_pin"], now, f["producer"], f["method"]))
            return cur.lastrowid

    def restart_completed_stage2_for_reconcile(self, *, producer: str, shard: str, batch: str, branch: str,
                                                worktree: str, model_tier: str = "free", run_kind: str,
                                                from_run: bool = False, shard_pin: str | None = None) -> int | None:
        """Reuse this producer's unique Stage 2 Part row for deterministic reconciliation after later Relation edits.

        Stage 2 stores one row per Part. Reconciliation therefore reopens that completed identity in place, while its
        earlier PR remains visible in the event history, instead of inventing a second Part key or violating UNIQUE.
        """
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            if from_run:
                ln = c.execute("SELECT run, drain, force_stop FROM lines WHERE model=? AND method=?",
                               (producer, STAGE2_METHOD)).fetchone()
                if ln is None or not ln["run"] or ln["drain"] or ln["force_stop"]:
                    raise LineNotRunnable(f"{producer}/{STAGE2_METHOD} 라인이 신규 배치를 받을 수 있는 상태가 아닙니다.")
            if c.execute("SELECT 1 FROM batches WHERE method=? AND producer=? AND state!='COMPLETE'",
                         (STAGE2_METHOD, producer)).fetchone():
                raise LineBusy(f"{producer}/{STAGE2_METHOD} 라인에 미완료 배치가 있습니다.")
            held = c.execute("SELECT producer, shard, batch, state FROM batches WHERE method=? AND state!='COMPLETE'",
                             (STAGE2_METHOD,)).fetchone()
            if held:
                raise LineBusy(f"Stage 2는 전체에서 한 Part만 점유합니다: {held['producer']}가 "
                               f"{held['shard']}_{held['batch']}({held['state']})를 소유 중입니다.")
            prior = c.execute("SELECT id, pr_number FROM batches WHERE method=? AND producer=? AND shard=? AND batch=? "
                              "AND state='COMPLETE'", (STAGE2_METHOD, producer, shard, batch)).fetchone()
            if prior is None:
                return None
            batch_id = prior["id"]
            c.execute("UPDATE batches SET branch=?, worktree=?, state='PREPARE', paused_from=NULL, pr_number=NULL, "
                      "head_sha=NULL, session_id=NULL, pid=NULL, exit_file=NULL, log_file=NULL, run_kind=?, model_tier=?, "
                      "retries=0, retry_after=NULL, records_done=NULL, records_total=NULL, progress_kind=NULL, "
                      "progress_done=NULL, progress_total=NULL, error=NULL, merged=0, pause_reason='', defect_id=NULL, updated_at=? "
                      "WHERE id=?", (branch, worktree, run_kind, model_tier, now, batch_id))
            c.execute("DELETE FROM clear_requests WHERE batch_id=?", (batch_id,))
            if prior["pr_number"] is not None:
                c.execute("INSERT INTO events(batch_id,ts,level,msg) VALUES(?,?,?,?)",
                          (batch_id, now, "info", f"Stage 2 Part가 후속 Relation 변경 조정으로 재개됨 (이전 PR #{prior['pr_number']})"))
            if shard_pin is not None:
                c.execute("INSERT OR IGNORE INTO lines(model,method,updated_at) VALUES(?,?,?)",
                          (producer, STAGE2_METHOD, now))
                c.execute("UPDATE lines SET shard_pin=?, blocked='', updated_at=? WHERE model=? AND method=?",
                          (shard_pin, now, producer, STAGE2_METHOD))
            return batch_id

    def update(self, batch_id: int, **fields) -> None:
        if not fields:
            return
        fields["updated_at"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        with self._conn() as c:
            c.execute(f"UPDATE batches SET {cols} WHERE id=?", (*fields.values(), batch_id))

    def complete_batch(self, batch_id: int) -> None:
        """Mark a batch complete and apply its Line's completion policy atomically with Drain requests."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            b = c.execute("SELECT producer, method FROM batches WHERE id=?", (batch_id,)).fetchone()
            if b is None:
                return
            c.execute("UPDATE batches SET state='COMPLETE', error=NULL, updated_at=? WHERE id=?", (now, batch_id))
            if b["method"] == MAINTENANCE_METHOD:
                # Maintainer Drain outlives the Issue; cleanup only ends the current run.
                c.execute("UPDATE lines SET run=0, updated_at=? WHERE model=? AND method=?",
                          (now, b["producer"], b["method"]))
            elif b["method"] == STAGE2_METHOD:
                # Stage 2 keeps its run reservation between Parts unless Drain was requested.
                c.execute("UPDATE lines SET run=0, drain=0, shard_pin='', updated_at=? "
                          "WHERE model=? AND method=? AND drain!=0",
                          (now, b["producer"], b["method"]))
            else:
                # This shares the write lock with request_drain_all: a Drain that wins before completion is
                # cleared here; one that lands after the COMPLETE transition remains armed on the empty Line.
                c.execute("UPDATE lines SET run=0, drain=0, updated_at=? "
                          "WHERE model=? AND method=? AND (mode!='continuous' OR drain!=0)",
                          (now, b["producer"], b["method"]))

    def batch(self, batch_id: int):
        with self._conn() as c:
            return c.execute("SELECT * FROM batches WHERE id=?", (batch_id,)).fetchone()

    def active_batch(self, model: str, method: str):
        """The Line's single unfinished batch (any state except COMPLETE), or None."""
        with self._conn() as c:
            return c.execute("SELECT * FROM batches WHERE producer=? AND method=? AND state != 'COMPLETE' "
                             "ORDER BY id DESC LIMIT 1", (model, method)).fetchone()

    def incomplete_batches(self):
        with self._conn() as c:
            return c.execute("SELECT * FROM batches WHERE state != 'COMPLETE' ORDER BY id").fetchall()

    def latest_batch(self, model: str, method: str):
        with self._conn() as c:
            return c.execute("SELECT * FROM batches WHERE producer=? AND method=? ORDER BY id DESC LIMIT 1",
                             (model, method)).fetchone()

    def line_batches(self, model: str, method: str):
        with self._conn() as c:
            return c.execute("SELECT * FROM batches WHERE producer=? AND method=? ORDER BY id DESC",
                             (model, method)).fetchall()

    # --- lines: per (model, method) operator controls ---
    def line(self, model: str, method: str):
        with self._conn() as c:
            c.execute("INSERT OR IGNORE INTO lines(model,method,updated_at) VALUES(?,?,?)",
                      (model, method, time.time()))
            return c.execute("SELECT model, method, mode, run, drain, force_stop, retry_batch, blocked, model_tier, "
                             "updated_at, shard_pin FROM lines WHERE model=? AND method=?",
                             (model, method)).fetchone()

    def peek_line(self, model: str, method: str) -> dict:
        """Read-only view of a Line's controls (defaults if it has no row yet); never writes."""
        with self._conn() as c:
            row = c.execute("SELECT model, method, mode, run, drain, force_stop, retry_batch, blocked, model_tier, "
                            "updated_at, shard_pin FROM lines WHERE model=? AND method=?",
                            (model, method)).fetchone()
        return dict(row) if row else {"model": model, "method": method, "mode": "single", "run": 0,
                                      "drain": 0, "force_stop": 0, "retry_batch": None, "blocked": "",
                                      "model_tier": "free", "shard_pin": ""}

    def set_line(self, model: str, method: str, **fields) -> None:
        self.line(model, method)
        fields["updated_at"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        with self._conn() as c:
            c.execute(f"UPDATE lines SET {cols} WHERE model=? AND method=?", (*fields.values(), model, method))

    def request_start(self, model: str, method: str, mode: str) -> tuple[str, sqlite3.Row | None]:
        """Reserve a new Stage 1 run unless an active batch or the Line's Drain won the write race."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            active = c.execute("SELECT shard, batch, state FROM batches WHERE producer=? AND method=? "
                               "AND state!='COMPLETE' ORDER BY id DESC LIMIT 1", (model, method)).fetchone()
            if active is not None:
                return "active", active
            c.execute("INSERT OR IGNORE INTO lines(model,method,updated_at) VALUES(?,?,?)", (model, method, now))
            ln = c.execute("SELECT drain FROM lines WHERE model=? AND method=?", (model, method)).fetchone()
            if ln["drain"]:
                return "drain", None
            c.execute("UPDATE lines SET mode=?, force_stop=0, blocked='', run=1, updated_at=? "
                      "WHERE model=? AND method=?", ("continuous" if mode == "continuous" else "single",
                                                       now, model, method))
        return "", None

    def lines(self):
        with self._conn() as c:
            return c.execute("SELECT model, method, mode, run, drain, force_stop, retry_batch, blocked, model_tier, "
                             "updated_at, shard_pin FROM lines ORDER BY model, method").fetchall()

    def request_drain(self, model: str, method: str, on: bool) -> None:
        """Set this Line's Drain explicitly; ON cancels a run reservation only when no batch is active."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            c.execute("INSERT OR IGNORE INTO lines(model,method,updated_at) VALUES(?,?,?)", (model, method, now))
            if on:
                active = c.execute("SELECT state FROM batches WHERE producer=? AND method=? AND state!='COMPLETE'",
                                   (model, method)).fetchone()
                if active is not None and active["state"] == "CLEARING":
                    return
                if active:
                    c.execute("UPDATE lines SET drain=1, updated_at=? WHERE model=? AND method=?",
                              (now, model, method))
                else:
                    c.execute("UPDATE lines SET drain=1, run=0, updated_at=? WHERE model=? AND method=?",
                              (now, model, method))
            else:
                c.execute("UPDATE lines SET drain=0, updated_at=? WHERE model=? AND method=?",
                          (now, model, method))

    def start_stage2(self, model: str, mode: str) -> tuple[bool, str]:
        """Reserve the single Stage 2 occupancy for `model` in ONE write transaction (shared with `create_batch`).

        Refused while any model owns an unfinished Stage 2 Part (a restart with another model must recover that Part
        through its owner) or another model already holds a run reservation, so two Starts can never both win.
        """
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            held = c.execute("SELECT producer, shard, batch, state FROM batches WHERE method=? AND state!='COMPLETE'",
                             (STAGE2_METHOD,)).fetchone()
            if held:
                return False, (f"Stage 2는 전체에서 한 Part만 점유합니다: {held['producer']}가 미완료 Part "
                               f"{held['shard']}_{held['batch']}({held['state']})를 소유 중입니다. "
                               "같은 모델로 Retry하거나 Batch Detail에서 Clear하세요.")
            other = c.execute("SELECT model FROM lines WHERE method=? AND run=1 AND model!=?",
                              (STAGE2_METHOD, model)).fetchone()
            if other:
                return False, f"Stage 2는 이미 {other['model']}가 시작 예약 중입니다 (전체에서 한 작업만 허용)."
            ln = c.execute("SELECT drain FROM lines WHERE model=? AND method=?", (model, STAGE2_METHOD)).fetchone()
            if ln is not None and ln["drain"]:
                return False, f"{model}/S2 라인이 Drain 중입니다. 해당 라인의 Cancel Drain 후 시작하세요."
            c.execute("INSERT OR IGNORE INTO lines(model,method,updated_at) VALUES(?,?,?)", (model, STAGE2_METHOD, now))
            c.execute("UPDATE lines SET mode=?, force_stop=0, blocked='', run=1, shard_pin='', updated_at=? "
                      "WHERE model=? AND method=?", ("continuous" if mode == "continuous" else "single", now, model,
                                                    STAGE2_METHOD))
        return True, ""

    def start_stage3(self, model: str, mode: str) -> tuple[bool, str]:
        """Reserve one shared Stage 3 run; same-shard Stage 2 ownership is checked again at batch creation."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            held = c.execute("SELECT producer, shard, state FROM batches WHERE method=? AND state!='COMPLETE'",
                             (STAGE3_METHOD,)).fetchone()
            if held:
                return False, (f"Stage 3는 전체에서 한 샤드만 점유합니다: {held['producer']}가 "
                               f"샤드 {held['shard']}({held['state']})를 소유 중입니다. "
                               "같은 모델로 Retry하거나 Batch Detail에서 Clear하세요.")
            other = c.execute("SELECT model FROM lines WHERE method=? AND run=1 AND model!=?",
                              (STAGE3_METHOD, model)).fetchone()
            if other:
                return False, f"Stage 3는 이미 {other['model']}가 시작 예약 중입니다."
            ln = c.execute("SELECT drain FROM lines WHERE model=? AND method=?", (model, STAGE3_METHOD)).fetchone()
            if ln is not None and ln["drain"]:
                return False, f"{model}/S3 라인이 Drain 중입니다. 해당 라인의 Cancel Drain 후 시작하세요."
            c.execute("INSERT OR IGNORE INTO lines(model,method,updated_at) VALUES(?,?,?)", (model, STAGE3_METHOD, now))
            c.execute("UPDATE lines SET mode=?, force_stop=0, blocked='', run=1, shard_pin='', updated_at=? "
                      "WHERE model=? AND method=?", ("continuous" if mode == "continuous" else "single", now,
                                                       model, STAGE3_METHOD))
        return True, ""

    def restore_stage3_completion(self, *, producer: str, shard: str, pr_number: int, merge_sha: str) -> bool:
        """Restore one lost Stage 3 completion from a validated merged PR identity; no parallel ledger is created."""
        now = time.time()
        branch = f"s3-{producer}-{shard}"
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            rows = c.execute("SELECT id, producer, state, merged, pr_number, head_sha FROM batches WHERE method=? AND shard=?",
                             (STAGE3_METHOD, shard)).fetchall()
            if any(row["state"] != "COMPLETE" for row in rows):
                return False
            if rows:
                matching = next((row for row in rows if row["pr_number"] == pr_number
                                 and row["head_sha"] == merge_sha and row["merged"]), None)
                return matching is not None
            c.execute("INSERT INTO batches(method,producer,shard,batch,branch,worktree,state,pr_number,head_sha,run_kind,"
                      "merged,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (STAGE3_METHOD, producer, shard, "all", branch, "", "COMPLETE", pr_number, merge_sha,
                       "s3_recovered", 1, now, now))
        return True

    def request_drain_all(self, lines) -> int:
        """Set Drain ON for every target Line in one transaction (shared with `create_batch`).

        A Line with an active batch finishes it; a Line without one loses a pending run reservation and stays
        drained until an explicit Cancel Drain. Returns the number of target Lines updated.
        """
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            return self._drain_all_tx(c, lines, now)

    # --- one-shot Drain reservations (Issue #2430) ---
    def drain_schedule(self, target: str):
        with self._conn() as c:
            return c.execute("SELECT * FROM drain_schedules WHERE target=?", (target,)).fetchone()

    def create_drain_schedule(self, target: str, due_at: float, *, model: str | None = None,
                              method: str | None = None, batch_id: int | None = None,
                              created_at: float | None = None) -> tuple[bool, str]:
        """Persist one schedule. Detail reservations are accepted only for the exact active, non-Clear batch."""
        created_at = time.time() if created_at is None else created_at
        if target == "all":
            if model is not None or method is not None or batch_id is not None:
                raise ValueError("Drain All schedule must not name a Line or batch")
        elif (target.startswith("batch:") and method != MAINTENANCE_METHOD and model and method
              and batch_id is not None and target == f"batch:{batch_id}"):
            pass
        else:
            raise ValueError("invalid Drain schedule target")
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            if target != "all":
                active = c.execute(
                    "SELECT id FROM batches WHERE id=? AND producer=? AND method=? "
                    "AND state NOT IN ('COMPLETE','CLEARING') AND id=(SELECT id FROM batches "
                    "WHERE producer=? AND method=? AND state NOT IN ('COMPLETE','CLEARING') "
                    "ORDER BY id DESC LIMIT 1)",
                    (batch_id, model, method, model, method)).fetchone()
                if active is None:
                    return False, "화면의 미완료 배치가 바뀌었거나 이미 종료되었습니다. 새로 고친 뒤 다시 예약하세요."
            c.execute("INSERT INTO drain_schedules(target,model,method,batch_id,due_at,created_at) "
                      "VALUES(?,?,?,?,?,?) ON CONFLICT(target) DO UPDATE SET "
                      "model=excluded.model,method=excluded.method,batch_id=excluded.batch_id,"
                      "due_at=excluded.due_at,created_at=excluded.created_at",
                      (target, model, method, batch_id, due_at, created_at))
            line = f"{model}/{method}" if model is not None else None
            self._add_event(c, batch_id, f"Drain 예약 저장: {target} · due {due_at:.0f}", line=line, ts=created_at)
        return True, ""

    def cancel_drain_schedule(self, target: str) -> bool:
        """Delete only the planned firing; an already applied Drain flag is left untouched."""
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT * FROM drain_schedules WHERE target=?", (target,)).fetchone()
            if row is None:
                return False
            c.execute("DELETE FROM drain_schedules WHERE target=?", (target,))
            line = f"{row['model']}/{row['method']}" if row["model"] is not None else None
            self._add_event(c, row["batch_id"], f"Drain 예약 취소: {target}", line=line)
        return True

    def fire_due_drain_schedules(self, now: float, board_lines) -> list[dict]:
        """Atomically apply and consume all due reservations; returns one result per fired/expired schedule."""
        results = []
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            rows = c.execute("SELECT * FROM drain_schedules WHERE due_at<=? ORDER BY due_at,target", (now,)).fetchall()
            for row in rows:
                target = row["target"]
                if target == "all":
                    count = self._drain_all_tx(c, board_lines, now)
                    self._add_event(c, None, f"예약 Drain All 발화: {count}개 생산 Line Drain ON", ts=now)
                    result = {"target": target, "status": "fired", "count": count}
                else:
                    active = c.execute(
                        "SELECT id FROM batches WHERE id=? AND producer=? AND method=? "
                        "AND state NOT IN ('COMPLETE','CLEARING') AND id=(SELECT id FROM batches "
                        "WHERE producer=? AND method=? AND state NOT IN ('COMPLETE','CLEARING') "
                        "ORDER BY id DESC LIMIT 1)",
                        (row["batch_id"], row["model"], row["method"], row["model"], row["method"])).fetchone()
                    line = f"{row['model']}/{row['method']}"
                    if active is None:
                        self._add_event(c, row["batch_id"],
                                        f"예약 Drain 만료: batch id {row['batch_id']}가 완료·Clear·교체되었거나 소유 관계가 바뀜",
                                        line=line, ts=now)
                        result = {"target": target, "status": "expired", "count": 0}
                    else:
                        c.execute("INSERT OR IGNORE INTO lines(model,method,updated_at) VALUES(?,?,?)",
                                  (row["model"], row["method"], now))
                        c.execute("UPDATE lines SET drain=1,updated_at=? WHERE model=? AND method=?",
                                  (now, row["model"], row["method"]))
                        self._add_event(c, row["batch_id"],
                                        f"예약 Drain 발화: batch id {row['batch_id']} · {line}", line=line, ts=now)
                        result = {"target": target, "status": "fired", "count": 1}
                c.execute("DELETE FROM drain_schedules WHERE target=?", (target,))
                results.append(result)
        return results

    @staticmethod
    def _drain_all_tx(c, lines, now: float) -> int:
        count = 0
        for model, method in lines:
            if method == MAINTENANCE_METHOD:
                continue
            c.execute("INSERT OR IGNORE INTO lines(model,method,updated_at) VALUES(?,?,?)", (model, method, now))
            c.execute("UPDATE lines SET drain=1, run=CASE WHEN EXISTS ("
                      "SELECT 1 FROM batches WHERE producer=? AND method=? AND state!='COMPLETE'"
                      ") THEN run ELSE 0 END, updated_at=? WHERE model=? AND method=?",
                      (model, method, now, model, method))
            count += 1
        return count

    def stop_lines(self, model: str | None = None, method: str | None = None) -> None:
        """Request stop for one Line (or every Line): no new run is allowed until Start/Retry."""
        where, args = (("WHERE model=? AND method=?", (model, method)) if model
                       else ("WHERE method!=?", (MAINTENANCE_METHOD,)))   # Stop All is a production control
        # A Line whose batch is CLEARING is pinned by the Clear: a Stop (All) must not leave a flag behind that the
        # Supervisor would consume after the Clear ends (e.g. when it hands a merged PR to the regular cleanup).
        where += (" AND NOT EXISTS (SELECT 1 FROM batches b WHERE b.producer=lines.model AND b.method=lines.method "
                  "AND b.state='CLEARING')")
        with self._conn() as c:
            c.execute(f"UPDATE lines SET run=0, force_stop=1, retry_batch=NULL, updated_at=? {where}", (time.time(), *args))

    def request_stop_pinned(self, model: str, method: str, batch_id: int) -> bool:
        """Stop request bound to the execution the operator saw (the Maintainer's Detail): one transaction checks that
        `batch_id` is still this Line's unfinished batch, then writes the flag and the pin the Supervisor re-checks when
        it consumes the flag. False (nothing written): the screen is stale."""
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            if c.execute("SELECT 1 FROM batches WHERE id=? AND producer=? AND method=? AND state NOT IN ('COMPLETE','CLEARING')",
                         (batch_id, model, method)).fetchone() is None:
                return False
            c.execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                      (f"stop_pin_{model}_{method}", str(batch_id)))
            c.execute("UPDATE lines SET run=0, force_stop=1, retry_batch=NULL, updated_at=? "
                      "WHERE model=? AND method=?", (time.time(), model, method))
            return True

    # --- Clear: abandon one unfinished batch (Supervisor-owned teardown) ---
    def request_clear(self, model: str, method: str, batch_id: int, issue_number: int | None = None) -> tuple[bool, str]:
        """TUI -> Supervisor. Writes only the batch-ID-specific request; a stale ID is refused, a BLOCKED one is re-armed.

        The Maintainer's execution also needs the urgent Issue number shown on screen (`issue_number`).
        """
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            b = c.execute("SELECT state FROM batches WHERE id=? AND producer=? AND method=? AND state!='COMPLETE'",
                          (batch_id, model, method)).fetchone()
            if b is None:
                return False, "대상 배치가 이미 끝났거나 이 라인의 미완료 배치가 아닙니다 (화면을 새로 고치세요)."
            if method == MAINTENANCE_METHOD:   # the Issue the operator saw must still own exactly this execution
                m = None if issue_number is None else c.execute(
                    "SELECT 1 FROM maintenance WHERE issue_number=? AND batch_id=?", (issue_number, batch_id)).fetchone()
                if m is None:
                    return False, "화면의 Issue와 현재 Maintainer 실행이 다릅니다 (화면을 새로 고치세요)."
            c.execute("INSERT OR IGNORE INTO clear_requests(batch_id,model,method,prior_state,requested_at) "
                      "VALUES(?,?,?,?,?)", (batch_id, model, method, b["state"], now))
            c.execute("UPDATE clear_requests SET status='REQUESTED', error=NULL WHERE batch_id=?", (batch_id,))
        return True, ""

    def clear_request(self, model: str, method: str):
        with self._conn() as c:
            return c.execute("SELECT * FROM clear_requests WHERE model=? AND method=?", (model, method)).fetchone()

    def set_clear(self, batch_id: int, **fields) -> None:
        cols = ", ".join(f"{k}=?" for k in fields)
        with self._conn() as c:
            c.execute(f"UPDATE clear_requests SET {cols} WHERE batch_id=?", (*fields.values(), batch_id))

    def add_clear_note(self, batch_id: int, text: str) -> None:
        with self._conn() as c:
            c.execute("UPDATE clear_requests SET note=note||? WHERE batch_id=?", (text, batch_id))

    def drop_clear(self, batch_id: int) -> None:
        with self._conn() as c:
            c.execute("DELETE FROM clear_requests WHERE batch_id=?", (batch_id,))
            # Clear ended without removing the batch: no control written meanwhile may act on it afterwards.
            c.execute("UPDATE lines SET force_stop=0, retry_batch=NULL, "
                      "drain=CASE WHEN method=? THEN drain ELSE 0 END "   # a Maintainer Drain outlives a Clear
                      "WHERE (model, method) IN (SELECT producer, method FROM batches WHERE id=?)",
                      (MAINTENANCE_METHOD, batch_id))

    def pin_clear(self, model: str, method: str):
        """Supervisor: atomically pin the requested batch ID as CLEARING and switch off everything that could start,
        retry or recover this Line. Returns the request, or None (no request / stale one dropped)."""
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            req = c.execute("SELECT * FROM clear_requests WHERE model=? AND method=?", (model, method)).fetchone()
            if req is None:
                return None
            b = c.execute("SELECT state FROM batches WHERE id=? AND producer=? AND method=?",
                          (req["batch_id"], model, method)).fetchone()
            if b is None or b["state"] == "COMPLETE":
                c.execute("DELETE FROM clear_requests WHERE batch_id=?", (req["batch_id"],))
                return None
            if b["state"] != "CLEARING":
                c.execute("UPDATE batches SET state='CLEARING', error=NULL, updated_at=? WHERE id=?",
                          (time.time(), req["batch_id"]))
                c.execute("UPDATE lines SET run=0, drain=CASE WHEN method=? THEN drain ELSE 0 END, "
                          "force_stop=0, retry_batch=NULL, blocked='', updated_at=? WHERE model=? AND method=?",
                          (MAINTENANCE_METHOD, time.time(), model, method))
            return req

    def finish_clear(self, b, audit: str) -> None:
        """One transaction: the batch row (so nothing stays claimed), its runs, review dedupe, events, request and
        per-batch kv go; the Line is IDLE; a line-level audit event remains."""
        bid, now = b["id"], time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            for table in ("runs", "handled_events", "events", "clear_requests"):
                c.execute(f"DELETE FROM {table} WHERE batch_id=?", (bid,))
            for prefix in BATCH_KV_PREFIXES:
                c.execute("DELETE FROM kv WHERE key=?", (f"{prefix}{bid}",))
            # Transient-retry backoff keys are `tw_b<bid>:<stage>`; the trailing colon keeps b1 from touching b10.
            c.execute("DELETE FROM kv WHERE substr(key, 1, ?)=?", (len(f"tw_b{bid}:"), f"tw_b{bid}:"))
            # The batch is gone for good: its shared-defect reports must leave the publish/release loops (other
            # batches linked to the same Issue keep their own defect rows untouched).
            c.execute("UPDATE defects SET state='OVERRIDDEN', hold_reason='운영자가 배치를 Clear함', updated_at=? "
                      "WHERE batch_id=? AND state NOT IN ('RELEASED','OVERRIDDEN')", (now, bid))
            # The Maintainer's execution leaves its Issue HELD with no execution (never a dangling batch_id); the urgent
            # Issue, the defects that depend on it and their PAUSED batches stay untouched until an explicit Retry.
            c.execute("UPDATE maintenance SET state='HELD', batch_id=NULL, hold_reason=?, updated_at=? WHERE batch_id=?",
                      (CLEARED_HOLD, now, bid))
            c.execute("DELETE FROM batches WHERE id=?", (bid,))
            c.execute("UPDATE lines SET run=0, drain=CASE WHEN method=? THEN drain ELSE 0 END, "
                      "force_stop=0, retry_batch=NULL, blocked='', shard_pin='', updated_at=? WHERE model=? AND method=?",
                      (MAINTENANCE_METHOD, now, b["producer"], b["method"]))
            c.execute("INSERT INTO events(batch_id,ts,level,msg,line) VALUES(NULL,?,?,?,?)",
                      (now, "info", audit, f"{b['producer']}/{b['method']}"))

    # --- run history ---
    def add_run(self, batch_id: int, kind: str, session_id, pid, log_file, exit_file,
                model: str | None = None, effort: str | None = None,
                permission_profile: str | None = None) -> int:
        """Record a launch with the model ID and effort it was pinned to (what the CLI was asked for)."""
        with self._conn() as c:
            return c.execute("INSERT INTO runs(batch_id,kind,session_id,pid,log_file,exit_file,started_at,model,effort,"
                             "permission_profile) VALUES(?,?,?,?,?,?,?,?,?,?)",
                             (batch_id, kind, session_id, pid, str(log_file), str(exit_file), time.time(),
                              model, effort, permission_profile)).lastrowid

    def set_run_session(self, batch_id: int, session_id: str) -> None:
        with self._conn() as c:
            c.execute("UPDATE runs SET session_id=? WHERE id=(SELECT MAX(id) FROM runs WHERE batch_id=?)",
                      (session_id, batch_id))

    def finish_runs(self, batch_id: int, status) -> None:
        """Close the batch's open run(s) with an exit status (None -> 'unknown') and record each run's own usage.

        Measuring never affects the run's outcome: an unreadable or unrecognised log leaves the usage NULL."""
        with self._conn() as c:
            open_runs = c.execute("SELECT id, log_file FROM runs WHERE batch_id=? AND ended_at IS NULL", (batch_id,)).fetchall()
        measured = []
        for r in open_runs:   # read the logs outside the write transaction
            try:
                u = parse_usage(r["log_file"]) if r["log_file"] else None
            except Exception:   # noqa: BLE001 - a measurement failure must not block closing the run
                u = None
            measured.append((r["id"], u or {}))
        with self._conn() as c:
            sets = ", ".join(f"{k}=?" for k in (*RUN_USAGE_COLUMNS_V9, "usage_quality"))
            for rid, u in measured:
                c.execute(f"UPDATE runs SET {sets} WHERE id=? AND ended_at IS NULL",
                          (*[u.get(k) for k in (*RUN_USAGE_COLUMNS_V9, "usage_quality")], rid))
            c.execute("UPDATE runs SET ended_at=?, exit_status=? WHERE batch_id=? AND ended_at IS NULL",
                      (time.time(), "unknown" if status is None else str(status), batch_id))

    def add_submit_failure(self, batch_id: int) -> None:
        """One rejected `save-chunk` of the batch's latest AI run's own answer (the run already closed, so its CLI log
        cannot show it)."""
        with self._conn() as c:
            c.execute("UPDATE runs SET submit_failures=COALESCE(submit_failures,0)+1 "
                      "WHERE id=(SELECT MAX(id) FROM runs WHERE batch_id=?)", (batch_id,))

    def runs(self, batch_id: int):
        with self._conn() as c:
            return c.execute("SELECT * FROM runs WHERE batch_id=? ORDER BY id DESC", (batch_id,)).fetchall()

    def line_runs(self, model: str, method: str, limit: int = 200):
        """Runs of one Line. The single Maintainer is one Line whichever producer ran an Issue (history spans producers)."""
        who = "" if method == MAINTENANCE_METHOD else "b.producer=? AND "
        args = (method, limit) if method == MAINTENANCE_METHOD else (model, method, limit)
        with self._conn() as c:
            return c.execute("SELECT r.*, b.shard, b.batch FROM runs r JOIN batches b ON b.id=r.batch_id "
                             f"WHERE {who}b.method=? ORDER BY r.id DESC LIMIT ?", args).fetchall()

    def claimed_keys(self, method: str, producer: str | None) -> set[tuple[str, str]]:
        """Batches already owned here, finished ones included. producer=None: every model (shared C/D queue)."""
        with self._conn() as c:
            if producer is None:
                rows = c.execute("SELECT shard,batch FROM batches WHERE method=?", (method,)).fetchall()
            else:
                rows = c.execute("SELECT shard,batch FROM batches WHERE method=? AND producer=?",
                                 (method, producer)).fetchall()
        return {(r["shard"], r["batch"]) for r in rows}

    def all_batches(self):
        with self._conn() as c:
            return c.execute("SELECT * FROM batches ORDER BY id").fetchall()

    # --- events / log ---
    @staticmethod
    def _add_event(c, batch_id: int | None, msg: str, *, line: str | None = None, ts: float | None = None,
                   level: str = "info") -> None:
        if line is None and batch_id is not None:
            row = c.execute("SELECT producer, method FROM batches WHERE id=?", (batch_id,)).fetchone()
            line = f"{row['producer']}/{row['method']}" if row else None
        c.execute("INSERT INTO events(batch_id,ts,level,msg,line) VALUES(?,?,?,?,?)",
                  (batch_id, time.time() if ts is None else ts, level, msg, line))

    def log(self, batch_id: int | None, msg: str, level: str = "info", line: str | None = None) -> None:
        with self._conn() as c:
            self._add_event(c, batch_id, msg, line=line, level=level)

    def recent_events(self, limit: int = 100):
        with self._conn() as c:
            rows = c.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return list(reversed(rows))

    def line_events(self, model: str, method: str, after_id: int = 0, limit: int = 500):
        """Audit events of one Line (incremental by id)."""
        with self._conn() as c:
            if method == MAINTENANCE_METHOD:   # one Maintainer Line across producers
                return c.execute("SELECT * FROM events WHERE id>? AND (line LIKE ? OR batch_id IN "
                                 "(SELECT id FROM batches WHERE method=?)) ORDER BY id LIMIT ?",
                                 (after_id, f"%/{method}", method, limit)).fetchall()
            return c.execute(
                "SELECT * FROM events WHERE id>? AND (line=? OR batch_id IN "
                "(SELECT id FROM batches WHERE producer=? AND method=?)) ORDER BY id LIMIT ?",
                (after_id, f"{model}/{method}", model, method, limit)).fetchall()

    def line_events_tail(self, model: str, method: str, limit: int = 300):
        """The newest `limit` audit events of one Line, oldest first, read with one bounded query."""
        with self._conn() as c:
            rows = c.execute(
                "SELECT * FROM events WHERE (line=? OR batch_id IN "
                "(SELECT id FROM batches WHERE producer=? AND method=?)) ORDER BY id DESC LIMIT ?",
                (f"{model}/{method}", model, method, limit)).fetchall()
        return list(reversed(rows))

    def last_event(self, batch_id: int):
        with self._conn() as c:
            return c.execute("SELECT * FROM events WHERE batch_id=? ORDER BY id DESC LIMIT 1",
                             (batch_id,)).fetchone()

    def events_after(self, after_id: int = 0, limit: int = 500):
        with self._conn() as c:
            return c.execute("SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?", (after_id, limit)).fetchall()

    # --- review event dedupe: PR + HEAD + event id ---
    def is_handled(self, batch_id: int, pr: int, head: str, key: str) -> bool:
        with self._conn() as c:
            return c.execute("SELECT 1 FROM handled_events WHERE batch_id=? AND pr=? AND "
                             "head_sha=? AND event_key=? AND status IN ('HANDLED','LEGACY')",
                             (batch_id, pr, head, key)).fetchone() is not None

    def claim_events(self, batch_id: int, pr: int, head: str, keys: list[str], run_id: int) -> None:
        """Record assignment to one fix run without treating the review event as completed."""
        with self._conn() as c:
            for key in keys:
                c.execute("INSERT INTO handled_events(batch_id,pr,head_sha,event_key,ts,status,run_id,reply_id,completed_at) "
                          "VALUES(?,?,?,?,?,'CLAIMED',?,NULL,NULL) ON CONFLICT(batch_id,pr,head_sha,event_key) "
                          "DO UPDATE SET ts=excluded.ts,status='CLAIMED',run_id=excluded.run_id,reply_id=NULL,completed_at=NULL",
                          (batch_id, pr, head, key, time.time(), run_id))

    def mark_handled(self, batch_id: int, pr: int, head: str, keys: list[str], *,
                     run_id: int | None = None, reply_id: int | None = None) -> None:
        """Complete a Stage 1 fix with proof; no-proof callers retain their legacy Stage 2 behavior."""
        now = time.time()
        with self._conn() as c:
            for key in keys:
                status = "HANDLED" if run_id is not None and reply_id is not None else "LEGACY"
                completed_at = now if status == "HANDLED" else None
                c.execute("INSERT INTO handled_events(batch_id,pr,head_sha,event_key,ts,status,run_id,reply_id,completed_at) "
                          "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(batch_id,pr,head_sha,event_key) "
                          "DO UPDATE SET ts=excluded.ts,status=excluded.status,run_id=excluded.run_id,"
                          "reply_id=excluded.reply_id,completed_at=excluded.completed_at",
                          (batch_id, pr, head, key, now, status, run_id, reply_id, completed_at))

    def handled_event(self, batch_id: int, pr: int, head: str, key: str):
        with self._conn() as c:
            return c.execute("SELECT * FROM handled_events WHERE batch_id=? AND pr=? AND head_sha=? AND event_key=?",
                             (batch_id, pr, head, key)).fetchone()

    # --- durable Issue publication requests (Issue #2291) ---
    def request_issue(self, event_key: str, title: str, body: str, urgent: bool = False) -> dict:
        """Persist an Issue request before any GitHub call; repeated event keys must retain the same payload."""
        if not isinstance(event_key, str) or not event_key.strip():
            raise ValueError("event_key must be a non-empty string")
        if not isinstance(title, str) or not title.strip():
            raise ValueError("title must be a non-empty string")
        if not isinstance(body, str):
            raise ValueError("body must be a string")
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            old = c.execute("SELECT * FROM issue_requests WHERE event_key=?", (event_key,)).fetchone()
            if old is not None:
                if (old["title"], old["body"], bool(old["urgent"])) != (title, body, bool(urgent)):
                    raise ValueError("event_key is already registered with a different Issue request")
                return dict(old)
            issue_id = c.execute(
                "INSERT INTO issue_requests(event_key,title,body,urgent,state,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?)", (event_key, title, body, int(bool(urgent)), "PENDING", now, now)
            ).lastrowid
            return dict(c.execute("SELECT * FROM issue_requests WHERE id=?", (issue_id,)).fetchone())

    def issue_requests(self, states: tuple[str, ...] | None = None) -> list[dict]:
        with self._conn() as c:
            if states:
                rows = c.execute(f"SELECT * FROM issue_requests WHERE state IN ({','.join('?' * len(states))}) "
                                  "ORDER BY id", states).fetchall()
            else:
                rows = c.execute("SELECT * FROM issue_requests ORDER BY id").fetchall()
        return [dict(r) for r in rows]

    def issue_request(self, event_key: str) -> dict | None:
        with self._conn() as c:
            row = c.execute("SELECT * FROM issue_requests WHERE event_key=?", (event_key,)).fetchone()
        return dict(row) if row is not None else None

    def mark_issue_request_creating(self, request_id: int) -> bool:
        """Persist the create attempt before calling GitHub so a lost response can be reconciled after restart."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            cur = c.execute("UPDATE issue_requests SET state='CREATING',updated_at=? "
                            "WHERE id=? AND state IN ('PENDING','CREATING')", (now, request_id))
            return cur.rowcount == 1

    def mark_issue_request_created(self, request_id: int, issue_number: int) -> bool:
        """Persist the remote number before adding its event marker or making the request visible as complete."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT state,issue_number FROM issue_requests WHERE id=?", (request_id,)).fetchone()
            if row is None:
                return False
            if row["state"] in ("CREATED", "PUBLISHED"):
                if row["issue_number"] != issue_number:
                    raise ValueError("Issue request is already linked to a different GitHub Issue")
                return True
            cur = c.execute("UPDATE issue_requests SET state='CREATED',issue_number=?,updated_at=? "
                            "WHERE id=? AND state IN ('PENDING','CREATING')", (issue_number, now, request_id))
            return cur.rowcount == 1

    def complete_issue_request(self, request_id: int, issue_number: int) -> bool:
        """Mark publication complete and, for urgent requests only, register the existing Maintainer queue atomically."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT state,issue_number,urgent FROM issue_requests WHERE id=?", (request_id,)).fetchone()
            if row is None:
                return False
            if row["state"] == "PUBLISHED":
                return row["issue_number"] == issue_number
            if row["state"] != "CREATED" or row["issue_number"] != issue_number:
                return False
            c.execute("UPDATE issue_requests SET state='PUBLISHED',updated_at=? WHERE id=?", (now, request_id))
            if row["urgent"]:
                c.execute("INSERT OR IGNORE INTO maintenance(issue_number,state,created_at,updated_at) "
                          "VALUES(?,?,?,?)", (issue_number, "QUEUED", now, now))
            return True

    # --- shared defects (Issue #1555) ---
    def report_defect(self, batch_id: int, event_key: str, source: str, defect_class: str, state: str,
                      report: str, pause_reason: str, error: str) -> int | None:
        """Record one defect event and pause its batch in ONE transaction. A repeated event_key changes nothing (None).

        The batch keeps its worktree, branch, PR and session; only its state moves to PAUSED (`paused_from` = where it
        was) so a duplicate event, a restart or a crash between the two writes can never leave a half-paused batch.
        """
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            if c.execute("SELECT 1 FROM defects WHERE event_key=?", (event_key,)).fetchone():
                return None
            b = c.execute("SELECT state, paused_from FROM batches WHERE id=?", (batch_id,)).fetchone()
            if b is None or b["state"] in ("COMPLETE", "MERGED", "CLEANUP"):
                return None
            prev = b["paused_from"] if b["state"] in ("PAUSED", "ERROR") else b["state"]
            did = c.execute("INSERT INTO defects(event_key,batch_id,source,defect_class,state,report,created_at,updated_at)"
                            " VALUES(?,?,?,?,?,?,?,?)", (event_key, batch_id, source, defect_class, state, report,
                                                         now, now)).lastrowid
            c.execute("UPDATE batches SET state='PAUSED', paused_from=?, pause_reason=?, defect_id=?, error=?, "
                      "retry_after=NULL, updated_at=? WHERE id=?", (prev, pause_reason, did, error, now, batch_id))
            return did

    def defect(self, defect_id: int):
        with self._conn() as c:
            return c.execute("SELECT * FROM defects WHERE id=?", (defect_id,)).fetchone()

    def defect_by_event(self, event_key: str):
        with self._conn() as c:
            return c.execute("SELECT * FROM defects WHERE event_key=?", (event_key,)).fetchone()

    def defects(self, states=None):
        with self._conn() as c:
            rows = c.execute("SELECT * FROM defects ORDER BY id").fetchall()
        return [r for r in rows if states is None or r["state"] in states]

    def update_defect(self, defect_id: int, **fields) -> None:
        fields["updated_at"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        with self._conn() as c:
            c.execute(f"UPDATE defects SET {cols} WHERE id=?", (*fields.values(), defect_id))

    def release_defect(self, defect_id: int, batch_id: int, integrated_sha: str,
                       run_start: tuple[str, str] | None = None) -> bool:
        """The ONE automatic Retry: batch back to the phase it was paused in, defect RELEASED, in one transaction.

        `run_start` = (kv key, value): a verified Stage 2/3 execution baseline retargeted to the integrated HEAD,
        written in the same transaction so a crash can never leave RELEASED with the superseded baseline.

        False (nothing changed) unless the batch is still paused for exactly this defect and the defect is still
        FIX_MERGED, so a repeated poll or a restart can never retry twice.
        """
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            d = c.execute("SELECT state FROM defects WHERE id=?", (defect_id,)).fetchone()
            b = c.execute("SELECT * FROM batches WHERE id=?", (batch_id,)).fetchone()
            if (d is None or d["state"] != "FIX_MERGED" or b is None or b["state"] != "PAUSED"
                    or b["pause_reason"] != "shared_defect" or b["defect_id"] != defect_id or b["pid"] is not None):
                return False
            c.execute("UPDATE batches SET state=?, pause_reason='', defect_id=NULL, error=NULL, retries=0, "
                      "retry_after=NULL, updated_at=? WHERE id=?", (b["paused_from"] or "PRODUCING", now, batch_id))
            c.execute("INSERT OR IGNORE INTO lines(model,method,updated_at) VALUES(?,?,?)",
                      (b["producer"], b["method"], now))
            c.execute("UPDATE lines SET run=1, retry_batch=NULL, updated_at=? WHERE model=? AND method=?",
                      (now, b["producer"], b["method"]))
            c.execute("UPDATE defects SET state='RELEASED', integrated_sha=?, hold_reason=NULL, updated_at=? WHERE id=?",
                      (integrated_sha, now, defect_id))
            if run_start is not None:
                c.execute("INSERT INTO kv(key,value) VALUES(?,?) "
                          "ON CONFLICT(key) DO UPDATE SET value=excluded.value", run_start)
            return True

    # --- Stage 2 verify blocks (Issue #2154): a completed Batch/shard whose exact verify fails deterministically ---
    # Same `defects` table with source="verify" and batch_id=0 (no production batch exists: nothing is paused, and no
    # batch-keyed path may treat 0 as one). The scope's defect_class identifies the single active block.
    VERIFY_OPEN = ("REPORTED", "LINKED", "FIX_MERGED", "HELD")

    def report_verify_failure(self, event_key: str, defect_class: str, report: str) -> int | None:
        """Insert one verify block, or None when the event exists or the scope already has an active block."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            if c.execute("SELECT 1 FROM defects WHERE event_key=?", (event_key,)).fetchone():
                return None
            if c.execute(f"SELECT 1 FROM defects WHERE source='verify' AND defect_class=? AND state IN ({','.join('?' * len(self.VERIFY_OPEN))})",
                         (defect_class, *self.VERIFY_OPEN)).fetchone():
                return None
            return c.execute("INSERT INTO defects(event_key,batch_id,source,defect_class,state,report,created_at,updated_at)"
                             " VALUES(?,?,?,?,?,?,?,?)", (event_key, 0, "verify", defect_class, "REPORTED", report,
                                                          now, now)).lastrowid

    def active_verify(self, defect_class: str):
        """The scope's active block as a dict (row + `last_sha`, the master SHA it was last verified on), or None."""
        with self._conn() as c:
            row = c.execute(f"SELECT * FROM defects WHERE source='verify' AND defect_class=? AND state IN "
                            f"({','.join('?' * len(self.VERIFY_OPEN))}) ORDER BY id DESC", (defect_class, *self.VERIFY_OPEN)).fetchone()
        if row is None:
            return None
        try:
            last = json.loads(row["report"]).get("sha", "")
        except ValueError:
            last = ""
        return {**dict(row), "last_sha": last}

    def last_verify_defect_id(self, defect_class: str) -> int:
        with self._conn() as c:
            row = c.execute("SELECT MAX(id) AS m FROM defects WHERE source='verify' AND defect_class=?", (defect_class,)).fetchone()
        return row["m"] or 0

    def release_verify(self, defect_id: int, sha: str, ok_key: str) -> bool:
        """The scope's exact verify succeeded on `sha`: RELEASED and the `ok_key` cache in ONE transaction."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            cur = c.execute(f"UPDATE defects SET state='RELEASED', integrated_sha=?, hold_reason=NULL, updated_at=? WHERE id=? "
                            f"AND source='verify' AND state IN ({','.join('?' * len(self.VERIFY_OPEN))})",
                            (sha, now, defect_id, *self.VERIFY_OPEN))
            if cur.rowcount != 1:
                return False
            c.execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (ok_key, sha))
            return True

    def link_defect(self, defect_id: int, issue_number: int) -> bool:
        """REPORTED -> LINKED and the Maintainer queue row (QUEUED, if none) in ONE transaction (shared defects and verify blocks)."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            cur = c.execute("UPDATE defects SET state='LINKED', issue_number=?, updated_at=? WHERE id=? AND state='REPORTED'",
                            (issue_number, now, defect_id))
            if cur.rowcount != 1:
                return False
            c.execute("INSERT OR IGNORE INTO maintenance(issue_number,state,created_at,updated_at) VALUES(?,?,?,?)",
                      (issue_number, "QUEUED", now, now))
            return True

    # --- Maintainer task record: one row per urgent Issue ---
    def ensure_maintenance(self, issue_number: int):
        now = time.time()
        with self._conn() as c:
            c.execute("INSERT OR IGNORE INTO maintenance(issue_number,state,created_at,updated_at) VALUES(?,?,?,?)",
                      (issue_number, "QUEUED", now, now))
            return c.execute("SELECT * FROM maintenance WHERE issue_number=?", (issue_number,)).fetchone()

    def maintenance(self, issue_number: int):
        with self._conn() as c:
            return c.execute("SELECT * FROM maintenance WHERE issue_number=?", (issue_number,)).fetchone()

    def maintenance_rows(self):
        with self._conn() as c:
            return c.execute("SELECT * FROM maintenance ORDER BY id").fetchall()

    def update_maintenance(self, issue_number: int, **fields) -> None:
        fields["updated_at"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        with self._conn() as c:
            c.execute(f"UPDATE maintenance SET {cols} WHERE issue_number=?", (*fields.values(), issue_number))

    def maintenance_batch_open(self) -> bool:
        """The single Maintainer slot: any unfinished Maintainer execution, whichever producer it runs on."""
        with self._conn() as c:
            return c.execute("SELECT 1 FROM batches WHERE method=? AND state!='COMPLETE'",
                             (MAINTENANCE_METHOD,)).fetchone() is not None

    def claim_maintenance(self, issue_number: int, producer: str, branch: str, worktree: str) -> int | None:
        """Create the issue's execution record and link it to its task row in one transaction (None: not claimable).

        An Issue is claimed once (its row leaves QUEUED), and only one Maintainer execution exists at a time.
        """
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            m = c.execute("SELECT * FROM maintenance WHERE issue_number=?", (issue_number,)).fetchone()
            if m is None or m["state"] != "QUEUED" or m["batch_id"] is not None:
                return None
            if c.execute("SELECT 1 FROM batches WHERE method=? AND state!='COMPLETE'",
                         (MAINTENANCE_METHOD,)).fetchone():
                return None
            if c.execute("SELECT 1 FROM lines WHERE method=? AND drain=1", (MAINTENANCE_METHOD,)).fetchone():
                return None   # Drain: the current Issue finishes normally, the next one is not claimed automatically
            bid = c.execute(
                "INSERT INTO batches(method,producer,shard,batch,branch,worktree,state,model_tier,created_at,updated_at)"
                " VALUES(?,?,?,?,?,?,?,?,?,?)", (MAINTENANCE_METHOD, producer, "issue", str(issue_number), branch,
                                                 worktree, "PREPARE", "free", now, now)).lastrowid
            c.execute("UPDATE maintenance SET state='ACTIVE', batch_id=?, updated_at=? WHERE issue_number=?",
                      (bid, now, issue_number))
            return bid

    def maintenance_drained(self) -> bool:
        """The operator's Maintainer Drain (a flag on any Maintainer Line): no further Issue is claimed automatically."""
        with self._conn() as c:
            return c.execute("SELECT 1 FROM lines WHERE method=? AND drain=1", (MAINTENANCE_METHOD,)).fetchone() is not None

    def requeue_maintenance(self, issue_number: int) -> bool:
        """Explicit operator Retry of an Issue the operator cleared: HELD with NO execution -> QUEUED, once.

        Refused (False) for any other row, so an Issue held for a merge/ownership problem, or one that still has an
        execution, is never silently restarted (a new attempt cannot collide with an execution row).
        """
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            cur = c.execute("UPDATE maintenance SET state='QUEUED', hold_reason=NULL, updated_at=? "
                            "WHERE issue_number=? AND state='HELD' AND batch_id IS NULL", (time.time(), issue_number))
            return cur.rowcount == 1
