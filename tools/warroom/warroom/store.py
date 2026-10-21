"""SQLite persistent state. Short-lived connections: TUI and Supervisor share the file."""
from __future__ import annotations

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

ACTIVE_STATES = ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING", "MERGED",
                 "CLEANUP", "PAUSED", "ERROR")


class Store:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.executescript(SCHEMA)

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

    def active_batch(self):
        """The single unfinished batch (any state except COMPLETE), newest first."""
        with self._conn() as c:
            return c.execute("SELECT * FROM batches WHERE state != 'COMPLETE' "
                             "ORDER BY id DESC LIMIT 1").fetchone()

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
    def log(self, batch_id: int | None, msg: str, level: str = "info") -> None:
        with self._conn() as c:
            c.execute("INSERT INTO events(batch_id,ts,level,msg) VALUES(?,?,?,?)",
                      (batch_id, time.time(), level, msg))

    def recent_events(self, limit: int = 100):
        with self._conn() as c:
            rows = c.execute("SELECT * FROM events ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
        return list(reversed(rows))

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
