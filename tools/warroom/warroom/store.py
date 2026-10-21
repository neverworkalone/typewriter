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
SCHEMA_VERSION = 2

ACTIVE_STATES = ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING", "MERGED",
                 "CLEANUP", "PAUSED", "ERROR")


class LineBusy(Exception):
    """A Line owns at most one unfinished batch."""


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
    def create_batch(self, **f) -> int:
        now = time.time()
        with self._conn() as c:
            if c.execute("SELECT 1 FROM batches WHERE method=? AND producer=? AND state!='COMPLETE'",
                         (f["method"], f["producer"])).fetchone():
                raise LineBusy(f"{f['producer']}/{f['method']} 라인에 미완료 배치가 있습니다.")
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
                                      "drain": 0, "force_stop": 0, "retry_batch": None, "blocked": "",
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

    def stop_lines(self, model: str | None = None, method: str | None = None) -> None:
        """Request stop for one Line (or every Line): no new run is allowed until Start/Retry."""
        where, args = ("WHERE model=? AND method=?", (model, method)) if model else ("", ())
        with self._conn() as c:
            c.execute(f"UPDATE lines SET run=0, force_stop=1, retry_batch=NULL, updated_at=? {where}", (time.time(), *args))

    # --- run history ---
    def add_run(self, batch_id: int, kind: str, session_id, pid, log_file, exit_file) -> int:
        with self._conn() as c:
            return c.execute("INSERT INTO runs(batch_id,kind,session_id,pid,log_file,exit_file,started_at) "
                             "VALUES(?,?,?,?,?,?,?)",
                             (batch_id, kind, session_id, pid, str(log_file), str(exit_file), time.time())).lastrowid

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

    def claimed_keys(self, method: str, producer: str) -> set[tuple[str, str]]:
        """Batches this worker already owns (including finished ones)."""
        with self._conn() as c:
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
