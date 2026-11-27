"""War Room Recovery status as one JSON line (the app panel's data source; strictly read-only).

Reads the Recovery tables of the operating DB through a read-only SQLite connection and the external watchdog's record.
It never writes, starts or stops anything.

{"now", "watchdog": {...} | null, "supervisor": {"heartbeat_age"},
 "cases": [{"id", "key", "kind", "state", "issue", "pr", "session", "run": {...} | null, "report": {...} | null,
            "wait": {...} | null, "note"}]}
"""
import json
import os
import sqlite3
import sys
import time

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DB = os.path.join(ROOT, "tools", "warroom", ".local", "warroom.db")
WATCHDOG = os.path.join(ROOT, ".git", "typewriter-supervisor", "recovery", "watchdog.json")


def load(text):
    try:
        return json.loads(text) if text else None
    except ValueError:
        return text


def main():
    now = time.time()
    out = {"now": now, "watchdog": None, "supervisor": {"heartbeat_age": None}, "cases": []}
    try:
        with open(WATCHDOG, encoding="utf-8") as f:
            out["watchdog"] = json.load(f)
    except (OSError, ValueError):
        pass
    try:
        conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True, timeout=10)
    except sqlite3.Error as e:
        out["error"] = f"DB를 열 수 없습니다: {e}"
        json.dump(out, sys.stdout, ensure_ascii=False)
        return
    conn.row_factory = sqlite3.Row
    try:
        hb = conn.execute("SELECT value FROM kv WHERE key='heartbeat'").fetchone()
        if hb:
            out["supervisor"]["heartbeat_age"] = max(0.0, now - float(hb["value"]))
        cases = conn.execute("SELECT * FROM recovery_cases WHERE state!='RESOLVED' ORDER BY id").fetchall()
        for c in cases:
            run = conn.execute("SELECT id, kind, model, pid, log_file, started_at FROM recovery_runs "
                               "WHERE case_id=? AND ended_at IS NULL", (c["id"],)).fetchone()
            notes = (c["notes"] or "").strip().splitlines()
            out["cases"].append({"id": c["id"], "key": c["key"], "kind": c["kind"], "state": c["state"],
                                 "issue": c["issue"], "pr": c["pr_number"], "session": c["session_id"],
                                 "run": dict(run) if run else None, "report": load(c["last_report"]),
                                 "wait": load(c["wait_reason"]), "note": notes[-1] if notes else ""})
    except sqlite3.Error as e:   # an older DB without the Recovery tables
        out["error"] = f"Recovery 기록을 읽을 수 없습니다: {e}"
    finally:
        conn.close()
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
