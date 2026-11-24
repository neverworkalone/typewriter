"""SQLite migration of legacy Line controls, log tail and the shared elapsed-time display."""
import json
import sqlite3
import tempfile
import unittest
from unittest import mock
from pathlib import Path

from tests.fakes import World
from tests.test_issue_1684 import ready
from warroom import control, views
from warroom.logtail import INITIAL_BYTES, LogTail, redact
from warroom.store import SCHEMA_VERSION, Store
from warroom.timing import elapsed_seconds

PRODUCERS = {
    "claude": {"adapter": "claude", "model": "claude-x", "effort": "high"},
    "codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"},
    "sonnet": {"adapter": "claude", "model": "claude-sonnet", "effort": "high"},
}


def multi_world():
    """Claude, Codex and a second Claude model (the Maintainer's), with one shard whose Stage 2 inputs are ready."""
    w = World()
    w.cfg["producers"] = json.loads(json.dumps(PRODUCERS))
    done = {**ready("01", 500), **ready("02", 500)}
    w.runner.set_batches(canon={1: 1000}, done=done)
    return w


LEGACY_SCHEMA = """
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT, method TEXT NOT NULL, producer TEXT NOT NULL,
  shard TEXT NOT NULL, batch TEXT NOT NULL, branch TEXT NOT NULL, worktree TEXT NOT NULL,
  state TEXT NOT NULL, paused_from TEXT, pr_number INTEGER, head_sha TEXT, session_id TEXT,
  pid INTEGER, exit_file TEXT, log_file TEXT, run_kind TEXT,
  model_tier TEXT NOT NULL DEFAULT 'free', retries INTEGER NOT NULL DEFAULT 0, retry_after REAL,
  records_done INTEGER, records_total INTEGER, error TEXT, merged INTEGER NOT NULL DEFAULT 0,
  created_at REAL NOT NULL, updated_at REAL NOT NULL, UNIQUE(method, producer, shard, batch));
CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id INTEGER, ts REAL NOT NULL,
  level TEXT NOT NULL, msg TEXT NOT NULL);
CREATE TABLE handled_events (batch_id INTEGER NOT NULL, pr INTEGER NOT NULL, head_sha TEXT NOT NULL,
  event_key TEXT NOT NULL, ts REAL NOT NULL, PRIMARY KEY (batch_id, pr, head_sha, event_key));
"""


class Migration(unittest.TestCase):
    @staticmethod
    def legacy_db(d, kv, batches):
        db = d / "warroom.db"
        c = sqlite3.connect(db)
        c.executescript(LEGACY_SCHEMA)
        for state, extra in batches:
            c.execute("INSERT INTO batches(method,producer,shard,batch,branch,worktree,state,pid,model_tier,"
                      "created_at,updated_at) VALUES('a','deepseek','001',?,?,?,?,?,'free',1,2)",
                      (extra, f"b{extra}", f"/w{extra}", state, 4242 if state == "PRODUCING" else None))
        c.executemany("INSERT INTO kv VALUES(?,?)", list(kv.items()))
        c.commit()
        c.close()
        return db

    def test_pending_legacy_controls_follow_the_unfinished_batch(self):
        cases = [  # name, kv, batch state, expected (run, drain, force_stop, retry_batch)
            ("pending stop", {"run": "1", "force_stop": "1"}, "PRODUCING", (1, 0, 1, None)),
            ("pending retry", {"retry": "1"}, "PAUSED", (0, 0, 0, 1)),
            ("stale retry for other batch", {"retry": "9"}, "PAUSED", (0, 0, 0, None)),
            ("processed values", {"run": "1", "force_stop": "0", "retry": "", "stop_after": "0"},
             "PRODUCING", (1, 0, 0, None)),
            ("stop beats queued retry", {"force_stop": "1", "retry": "1"}, "PAUSED", (0, 0, 1, None)),
            ("stop on finished batch is moot", {"run": "1", "force_stop": "1"}, "COMPLETE", (0, 0, 0, None)),
        ]
        for name, kv, state, want in cases:
            with self.subTest(name), tempfile.TemporaryDirectory() as d:
                db = self.legacy_db(Path(d), kv, [(state, "01")])
                for _ in range(2):                              # idempotent re-open
                    ln = Store(db).line("deepseek", "a")
                    self.assertEqual((ln["run"], ln["drain"], ln["force_stop"], ln["retry_batch"]), want)

    def test_migrated_pending_stop_is_executed_and_pid_kept_until_exit(self):
        w = multi_world()
        w.start("single", "codex", "s2")
        w.tick()
        pid = w.row()["pid"]
        w.store.set_line("codex", "s2", force_stop=1)            # what migration yields for a pending Stop
        w.adapter.stop = lambda p: None                         # AI lingers
        w.tick(2)
        b = w.row()
        self.assertEqual((b["state"], b["pid"]), ("PAUSED", pid))
        self.assertEqual(len(w.adapter.launches), 1)
        w.tmp.cleanup()

    def test_legacy_db_is_migrated_without_loss_and_idempotently(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            logs = d / "logs"
            logs.mkdir()
            (logs / "batch-1-100.log").write_text("old\n")
            (logs / "batch-1-100.exit").write_text("0")
            (logs / "batch-1-200.log").write_text("fix\n")          # current run, still unfinished
            db = d / "warroom.db"
            c = sqlite3.connect(db)
            c.executescript(LEGACY_SCHEMA)
            c.execute("INSERT INTO batches(method,producer,shard,batch,branch,worktree,state,session_id,"
                      "log_file,exit_file,run_kind,pid,model_tier,created_at,updated_at) VALUES"
                      "('a','deepseek','001','01','a-deepseek-001-01','/w','COMPLETE','ses_1',?,?,'fix_resume',"
                      "NULL,'go',1,2)", (str(logs / "batch-1-200.log"), str(logs / "batch-1-200.exit")))
            c.execute("INSERT INTO batches(method,producer,shard,batch,branch,worktree,state,created_at,updated_at)"
                      " VALUES('a','deepseek','001','02','b2','/w2','PAUSED',3,4)")
            c.execute("INSERT INTO events(batch_id,ts,level,msg) VALUES(1,1,'info','old event')")
            c.executemany("INSERT INTO kv VALUES(?,?)", [("run", "1"), ("mode", "continuous"),
                                                         ("stop_after", "1"), ("heartbeat", "5")])
            c.commit()
            c.close()
            for _ in range(2):                                      # second open must change nothing
                s = Store(db)
                self.assertEqual([b["state"] for b in s.all_batches()], ["COMPLETE", "PAUSED"])
                paused = s.all_batches()[1]
                self.assertEqual((paused["pause_reason"], paused["defect_id"]), ("", None))
                ln = s.line("deepseek", "a")
                self.assertEqual((ln["mode"], ln["run"], ln["drain"]), ("continuous", 1, 1))
                self.assertEqual(ln["shard_pin"], "")
                runs = s.line_runs("deepseek", "a")
                self.assertEqual(len(runs), 2)
                old = [r for r in runs if r["started_at"] == 100][0]
                self.assertEqual((old["exit_status"], old["kind"]), ("0", "legacy"))
                self.assertEqual(len(s.line_events("deepseek", "a")), 1)
                self.assertEqual(s.get("heartbeat"), "5")
            with sqlite3.connect(db) as migrated:
                self.assertEqual(migrated.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
                tables = {r[0] for r in migrated.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                self.assertTrue({"drain_schedules", "defects", "maintenance"} <= tables)
            self.assertEqual(s.active_batch("deepseek", "a")["batch"], "02")


class TailTests(unittest.TestCase):
    def test_incremental_truncate_partial_and_missing(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "x.log"
            t = LogTail(f)
            self.assertEqual(t.read(), [])                           # no log yet
            f.write_text("a\nb\npart")
            self.assertEqual(t.read(), ["a", "b"])
            with open(f, "a") as fh:
                fh.write("ial\nc\n")
            self.assertEqual(t.read(), ["partial", "c"])
            self.assertEqual(t.read(), [])
            f.write_text("new\n")                                    # truncated/rotated
            self.assertEqual(t.read(), ["new"])

    def test_large_log_not_reread_from_start(self):
        with tempfile.TemporaryDirectory() as d:
            f = Path(d) / "big.log"
            f.write_text("".join(f"line {i:06d}\n" for i in range(100000)))
            t = LogTail(f)
            first = t.read()
            self.assertLess(len(first) * 12, INITIAL_BYTES + 100)
            self.assertEqual(first[-1], "line 099999")
            self.assertNotEqual(first[0], "line 000000")
            self.assertTrue(first[0].startswith("line "))            # started on a line boundary
            with open(f, "a") as fh:
                fh.write("tail\n")
            self.assertEqual(t.read(), ["tail"])
            self.assertEqual(t.offset, f.stat().st_size)

    def test_secrets_redacted(self):
        for raw in ["ghp_" + "a" * 30, "github_pat_" + "b" * 30, "sk-" + "c" * 24,
                    'Authorization: Bearer ' + "d" * 30, '"apiKey": "' + "e" * 20 + '"']:
            self.assertNotIn(raw.split()[-1].strip('"'), redact(f"x {raw} y"))
        self.assertEqual(redact("plain text"), "plain text")


class ElapsedDisplay(unittest.TestCase):
    NOW = 700.0
    INTERVALS = [(100.0, 300.0), (200.0, 400.0), (350.0, 500.0), (450.0, None)]

    def test_union_cases(self):
        def runs(intervals):
            return [{"started_at": start, "ended_at": end} for start, end in intervals]

        cases = [
            ("four fully overlapping runs", [(0, 300)] * 4, 300, None),
            ("partially overlapping runs", [(0, 240), (120, 360), (300, 420)], 420, None),
            ("sequential runs omit the pause", [(0, 100), (500, 600)], 200, None),
            ("completed and active runs", [(100, 200), (150, None)], 150, 250),
            ("empty and reversed intervals", [], 0, None),
            ("reversed interval contributes zero", [(100, 50), (0, 10)], 10, None),
        ]
        for name, intervals, want, now in cases:
            with self.subTest(name=name):
                self.assertEqual(elapsed_seconds(runs(intervals), now=self.NOW if now is None else now), want)

    def _set_intervals(self, store, batch_id, intervals):
        for index, (started_at, ended_at) in enumerate(intervals):
            run_id = store.add_run(batch_id, "primary", f"s{index}", None,
                                   f"run-{batch_id}-{index}.log", f"run-{batch_id}-{index}.exit")
            with store._conn() as c:
                c.execute("UPDATE runs SET started_at=?, ended_at=? WHERE id=?",
                          (started_at, ended_at, run_id))

    def test_board_and_detail_share_batch_elapsed(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.cfg["producers"] = {
            "claude": {"adapter": "claude", "model": "claude-test", "effort": "high"},
            "codex": {"adapter": "codex", "model": "codex-test", "effort": "high"},
        }
        batch_id = w.store.create_batch(method="s2", producer="claude", shard="001", batch="01-01",
                                        branch="s2-claude-001-01-01", worktree=str(w.paths.worktrees / "s2"))
        w.store.update(batch_id, state="PRODUCING")
        self._set_intervals(w.store, batch_id, self.INTERVALS)

        with mock.patch("warroom.control.time.time", return_value=self.NOW):
            status = control.line_status(w.store, "claude", "s2")
            detail_usage = views.usage_text(w.store.runs(batch_id), now=self.NOW)

        expected_text = views.fmt_elapsed(600)
        self.assertEqual(status["elapsed"], 600)
        self.assertIn(f"경과 {expected_text}", views.card_text(status))
        self.assertIn(f"경과 {expected_text}", detail_usage)
        self.assertEqual(status["batch_id"], batch_id)

    def test_maintainer_card_uses_the_same_elapsed_union(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.store.ensure_maintenance(101)
        batch_id = w.store.claim_maintenance(101, "deepseek", "maint-101", str(w.paths.worktrees / "maint"))
        self.assertIsNotNone(batch_id)
        w.store.update(batch_id, state="PRODUCING")
        self._set_intervals(w.store, batch_id, self.INTERVALS)

        with mock.patch("warroom.control.time.time", return_value=self.NOW):
            card = control.maintainer_card(w.store, w.cfg)

        self.assertEqual(card["elapsed"], 600)


if __name__ == "__main__":
    unittest.main()


