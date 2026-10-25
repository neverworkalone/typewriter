"""SQLite persistent state. Short-lived connections: TUI and Supervisor share the file."""
from __future__ import annotations

import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

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
# It is separate from the per-Line `drain` setting, which Drain All never touches.
# Additive migration (user_version 5): every run also records the Codex permission profile it was pinned to
# ('' = none configured). Old runs keep NULL, which the pin-drift check treats as "not recorded".
RUN_COLUMNS_V5 = ("permission_profile",)
SCHEMA_VERSION = 5

ACTIVE_STATES = ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING", "MERGED",
                 "CLEANUP", "PAUSED", "ERROR", "CLEARING")
# Per-batch kv keys the Supervisor writes; removed with the batch by Clear.
BATCH_KV_PREFIXES = ("last_poll_", "last_poll_fixhead_", "headlag_", "last_merge_check_", "no_pr_recovery_",
                     "verified_completion_run_")


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
        if "drain_once" not in {r["name"] for r in c.execute("PRAGMA table_info(lines)")}:
            c.execute("ALTER TABLE lines ADD COLUMN drain_once INTEGER NOT NULL DEFAULT 0")
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

    # --- batches ---
    def create_batch(self, from_run: bool = False, **f) -> int:
        """Insert a PREPARE batch. `from_run`: the Supervisor assigns it on behalf of a run reservation, so the
        Line's *current* controls (read under the same write lock) must still allow it: a Stop, Drain or
        Drain All that landed after the tick read the Line cannot be overtaken."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")   # check + insert under one write lock: concurrent Starts cannot both claim
            if from_run:
                ln = c.execute("SELECT run, drain, drain_once, force_stop FROM lines WHERE model=? AND method=?",
                               (f["producer"], f["method"])).fetchone()
                if ln is None or not ln["run"] or ln["drain"] or ln["drain_once"] or ln["force_stop"]:
                    raise LineNotRunnable(f"{f['producer']}/{f['method']} 라인이 신규 배치를 받을 수 없는 상태입니다.")
            if c.execute("SELECT 1 FROM batches WHERE method=? AND producer=? AND state!='COMPLETE'",
                         (f["method"], f["producer"])).fetchone():
                raise LineBusy(f"{f['producer']}/{f['method']} 라인에 미완료 배치가 있습니다.")
            if f["method"] in SHARED_QUEUE_METHODS:
                other = c.execute("SELECT producer, state FROM batches WHERE method=? AND shard=? AND batch=? "
                                  "AND producer!=?", (f["method"], f["shard"], f["batch"], f["producer"])).fetchone()
                if other:
                    raise DuplicateBatch(f"{f['method'].upper()} {f['shard']}_{f['batch']} 배치는 이미 "
                                         f"{other['producer']}({other['state']})가 점유 중입니다.")
            cur = c.execute(
                "INSERT INTO batches(method,producer,shard,batch,branch,worktree,state,"
                "model_tier,records_total,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                (f["method"], f["producer"], f["shard"], f["batch"], f["branch"],
                 f["worktree"], "PREPARE", f.get("model_tier", "free"),
                 f.get("records_total"), now, now))
            return cur.lastrowid

    def update(self, batch_id: int, **fields) -> None:
        if not fields:
            return
        fields["updated_at"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        with self._conn() as c:
            c.execute(f"UPDATE batches SET {cols} WHERE id=?", (*fields.values(), batch_id))

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
            return c.execute("SELECT * FROM lines WHERE model=? AND method=?", (model, method)).fetchone()

    def peek_line(self, model: str, method: str) -> dict:
        """Read-only view of a Line's controls (defaults if it has no row yet); never writes."""
        with self._conn() as c:
            row = c.execute("SELECT * FROM lines WHERE model=? AND method=?", (model, method)).fetchone()
        return dict(row) if row else {"model": model, "method": method, "mode": "single", "run": 0,
                                      "drain": 0, "drain_once": 0, "force_stop": 0, "retry_batch": None, "blocked": "",
                                      "model_tier": "free"}

    def set_line(self, model: str, method: str, **fields) -> None:
        self.line(model, method)
        fields["updated_at"] = time.time()
        cols = ", ".join(f"{k}=?" for k in fields)
        with self._conn() as c:
            c.execute(f"UPDATE lines SET {cols} WHERE model=? AND method=?", (*fields.values(), model, method))

    def lines(self):
        with self._conn() as c:
            return c.execute("SELECT * FROM lines ORDER BY model, method").fetchall()

    def request_drain_all(self, lines) -> int:
        """Drain All as ONE write transaction (shared with `create_batch`): a Line with an unfinished batch gets
        `drain_once`, a Line with only a run reservation loses it. Returns the number of Lines affected."""
        n, now = 0, time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            for model, method in lines:
                busy = c.execute("SELECT 1 FROM batches WHERE producer=? AND method=? AND state!='COMPLETE'",
                                 (model, method)).fetchone()
                ln = c.execute("SELECT run FROM lines WHERE model=? AND method=?", (model, method)).fetchone()
                if busy:
                    c.execute("INSERT OR IGNORE INTO lines(model,method,updated_at) VALUES(?,?,?)", (model, method, now))
                    c.execute("UPDATE lines SET drain_once=1, updated_at=? WHERE model=? AND method=?",
                              (now, model, method))
                    n += 1
                elif ln is not None and ln["run"]:
                    c.execute("UPDATE lines SET run=0, updated_at=? WHERE model=? AND method=?", (now, model, method))
                    n += 1
        return n

    def stop_lines(self, model: str | None = None, method: str | None = None) -> None:
        """Request stop for one Line (or every Line): no new run is allowed until Start/Retry."""
        where, args = ("WHERE model=? AND method=?", (model, method)) if model else ("", ())
        with self._conn() as c:
            c.execute(f"UPDATE lines SET run=0, drain_once=0, force_stop=1, retry_batch=NULL, updated_at=? {where}", (time.time(), *args))

    # --- Clear: abandon one unfinished batch (Supervisor-owned teardown) ---
    def request_clear(self, model: str, method: str, batch_id: int) -> tuple[bool, str]:
        """TUI -> Supervisor. Writes only the batch-ID-specific request; a stale ID is refused, a BLOCKED one is re-armed."""
        now = time.time()
        with self._conn() as c:
            c.execute("BEGIN IMMEDIATE")
            b = c.execute("SELECT state FROM batches WHERE id=? AND producer=? AND method=? AND state!='COMPLETE'",
                          (batch_id, model, method)).fetchone()
            if b is None:
                return False, "대상 배치가 이미 끝났거나 이 라인의 미완료 배치가 아닙니다 (화면을 새로 고치세요)."
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
                c.execute("UPDATE lines SET run=0, drain_once=0, force_stop=0, retry_batch=NULL, blocked='', "
                          "updated_at=? WHERE model=? AND method=?", (time.time(), model, method))
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
            c.execute("DELETE FROM batches WHERE id=?", (bid,))
            c.execute("UPDATE lines SET run=0, drain_once=0, force_stop=0, retry_batch=NULL, blocked='', updated_at=? "
                      "WHERE model=? AND method=?", (now, b["producer"], b["method"]))
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
        """Close the batch's open run(s) with an exit status (None -> 'unknown')."""
        with self._conn() as c:
            c.execute("UPDATE runs SET ended_at=?, exit_status=? WHERE batch_id=? AND ended_at IS NULL",
                      (time.time(), "unknown" if status is None else str(status), batch_id))

    def runs(self, batch_id: int):
        with self._conn() as c:
            return c.execute("SELECT * FROM runs WHERE batch_id=? ORDER BY id DESC", (batch_id,)).fetchall()

    def line_runs(self, model: str, method: str, limit: int = 200):
        with self._conn() as c:
            return c.execute("SELECT r.*, b.shard, b.batch FROM runs r JOIN batches b ON b.id=r.batch_id "
                             "WHERE b.producer=? AND b.method=? ORDER BY r.id DESC LIMIT ?",
                             (model, method, limit)).fetchall()

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
    def log(self, batch_id: int | None, msg: str, level: str = "info", line: str | None = None) -> None:
        with self._conn() as c:
            if line is None and batch_id is not None:
                row = c.execute("SELECT producer, method FROM batches WHERE id=?", (batch_id,)).fetchone()
                line = f"{row['producer']}/{row['method']}" if row else None
            c.execute("INSERT INTO events(batch_id,ts,level,msg,line) VALUES(?,?,?,?,?)",
                      (batch_id, time.time(), level, msg, line))

    def recent_events(self, limit: int = 100):
        with self._conn() as c:
            rows = c.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return list(reversed(rows))

    def line_events(self, model: str, method: str, after_id: int = 0, limit: int = 500):
        """Audit events of one Line (incremental by id)."""
        with self._conn() as c:
            return c.execute(
                "SELECT * FROM events WHERE id>? AND (line=? OR batch_id IN "
                "(SELECT id FROM batches WHERE producer=? AND method=?)) ORDER BY id LIMIT ?",
                (after_id, f"{model}/{method}", model, method, limit)).fetchall()

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
                             "head_sha=? AND event_key=?", (batch_id, pr, head, key)).fetchone() is not None

    def mark_handled(self, batch_id: int, pr: int, head: str, keys: list[str]) -> None:
        with self._conn() as c:
            for key in keys:
                c.execute("INSERT OR IGNORE INTO handled_events VALUES(?,?,?,?,?)",
                          (batch_id, pr, head, key, time.time()))
