"""Multi-Line isolation, scoped commands, drain/stop semantics, SQLite migration, log tail."""
import sqlite3
import tempfile
import unittest
from pathlib import Path

from tests.fakes import HEAD1, HEAD2, World
from tests.test_supervisor import review
from warroom import control
from warroom.config import DEFAULTS, registry, registry_problems
from warroom.logtail import INITIAL_BYTES, LogTail, redact
from warroom.store import LineBusy, Store

PRODUCERS = {
    "deepseek": {"adapter": "opencode", "models": {"free": "p/free-x-free", "go": "p/go"}},
    "sonnet": {"adapter": "opencode", "models": {"free": "p/sonnet-free", "go": ""}},
}


def multi_world():
    w = World()
    w.cfg["producers"] = PRODUCERS
    w.runner.models += ["p/sonnet-free"]
    return w


def open_pr(w, method, model, n, head=HEAD1):
    branch = f"{method}-{model}-001-01"
    w.pr_info(n, head)
    w.gh.by_branch[branch] = [{"number": n, "state": "OPEN", "headRefOid": head}]


def to_review(w, model, method, n):
    w.start("single", model, method)
    w.adapter.plan.append({"code": 0, "session": f"ses_{model}_{method}",
                           "effect": lambda: open_pr(w, method, model, n)})
    w.tick()
    w.adapter.finish(w.adapter.launches[-1]["pid"])
    w.tick()
    assert w.row(model, method)["state"] == "WAITING_REVIEW"


class LineIsolation(unittest.TestCase):
    def setUp(self):
        self.w = multi_world()

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_lines_are_independent_and_unbounded(self):
        w = self.w
        for model, method in [("deepseek", "a"), ("deepseek", "b"), ("sonnet", "a"), ("sonnet", "d")]:
            w.start("single", model, method)
        w.tick()
        rows = [w.row(m, me) for m, me in [("deepseek", "a"), ("deepseek", "b"), ("sonnet", "a"), ("sonnet", "d")]]
        self.assertEqual({r["state"] for r in rows}, {"PRODUCING"})
        self.assertEqual(len({r["worktree"] for r in rows}), 4)
        self.assertEqual(len({r["branch"] for r in rows}), 4)
        self.assertEqual(len({l["pid"] for l in w.adapter.launches}), 4)
        # each run used its own model's endpoint
        models = {l["cwd"].split("/")[-1]: l["model"] for l in w.adapter.launches}
        self.assertEqual(models["a-sonnet-001_01"], "p/sonnet-free")
        self.assertEqual(models["a-deepseek-001_01"], "p/free-x-free")

    def test_second_batch_on_occupied_line_is_refused_but_other_methods_start(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.tick()
        ok, msg = control.start(w.store, "deepseek", "a", "single")
        self.assertFalse(ok)
        self.assertIn("이미", msg)
        with self.assertRaises(LineBusy):
            w.store.create_batch(method="a", producer="deepseek", shard="001", batch="02",
                                 branch="x", worktree="/x")
        ok, _ = control.start(w.store, "deepseek", "b", "single")
        self.assertTrue(ok)

    def test_review_wait_does_not_block_another_line_and_states_do_not_mix(self):
        w = self.w
        to_review(w, "deepseek", "a", 7)
        to_review(w, "sonnet", "a", 8)
        w.gh.reviews_ = [review(11, HEAD1)]  # shared fake: both PRs see it
        w.adapter.plan += [{"code": 0}, {"code": 0}]
        w.tick()
        kinds = {w.row(m, "a")["id"]: w.row(m, "a")["state"] for m in ("deepseek", "sonnet")}
        self.assertEqual(set(kinds.values()), {"FIXING"})
        # a third Line starts producing while both reviews/fixes are pending
        w.start("single", "deepseek", "b")
        w.adapter.plan.append({"code": 0})
        w.tick()
        self.assertEqual(w.row("deepseek", "b")["state"], "PRODUCING")
        self.assertEqual(w.row("deepseek", "a")["pr_number"], 7)
        self.assertEqual(w.row("sonnet", "a")["pr_number"], 8)

    def test_one_line_exception_does_not_stall_others(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.start("single", "sonnet", "a")
        orig = w.git.create_worktree

        def boom(path, branch, base):
            if "deepseek" in str(path):
                raise RuntimeError("boom")
            return orig(path, branch, base)
        w.git.create_worktree = boom
        w.tick()
        self.assertEqual(w.row("sonnet", "a")["state"], "PRODUCING")

    def test_registry_duplicates_blocked(self):
        cfg = {**DEFAULTS, "producers": {
            "gpt": {"adapter": "codex", "models": {"free": "x/m", "go": ""}},
            "gpt-alt": {"adapter": "opencode", "models": {"free": "x/m", "go": ""}},
            "Bad_ID": {"models": {}}}}
        bad = registry_problems(cfg)
        self.assertIn("gpt", bad)
        self.assertIn("gpt-alt", bad)
        self.assertIn("Bad_ID", bad)
        self.assertEqual(len(registry(cfg)), 3)  # no count limit
        w = self.w
        w.cfg["producers"] = {"deepseek": PRODUCERS["deepseek"],
                              "dup": {"models": {"free": "p/free-x-free", "go": ""}}}
        w.start("single", "dup", "a")
        w.tick()
        self.assertEqual(w.adapter.launches, [])
        self.assertIn("중복", w.store.line("dup", "a")["blocked"])


class DrainAndStop(unittest.TestCase):
    def setUp(self):
        self.w = multi_world()

    def tearDown(self):
        self.w.tmp.cleanup()

    def _finish_batch(self, w, model="deepseek", pr=7):
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        open_pr(w, "a", model, pr)
        w.tick(2)
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")
        w.pr_info(pr, HEAD1, state="closed", merged=True)
        w.tick(4)
        self.assertEqual(w.row()["state"], "COMPLETE")

    def test_drain_all_is_one_shot_and_does_not_block_other_lines(self):
        w = self.w
        lines = [(m, "a") for m in ("deepseek", "sonnet")]
        w.start("continuous", "deepseek", "a")
        w.tick()                                   # batch 001_01 running
        control.set_drain(w.store, "sonnet", "a", True)          # a per-Line drain Drain All must not change
        control.drain_all(w.store, lines)
        self.assertTrue(w.store.peek_line("sonnet", "a")["drain"])
        self.assertTrue(control.line_status(w.store, "deepseek", "a")["drain_once"])
        self._finish_batch(w)
        w.tick(4)
        self.assertEqual(len(w.store.all_batches()), 1)         # no next batch after the current one
        ln = w.store.peek_line("deepseek", "a")
        self.assertEqual((ln["run"], ln["drain_once"]), (0, 0))
        st = control.line_status(w.store, "deepseek", "a")
        self.assertEqual((st["state"], st["batch"]), ("IDLE", None))   # EMPTY
        # another Line can Start right after Drain All; the drained Line is not restarted
        self.assertTrue(control.start(w.store, "sonnet", "a", "single")[0] is False)   # its own Line drain still applies
        control.set_drain(w.store, "sonnet", "a", False)
        self.assertTrue(control.start(w.store, "sonnet", "a", "single")[0])
        w.tick(3)
        self.assertEqual(len(w.store.all_batches()), 2)
        self.assertEqual(w.store.peek_line("deepseek", "a")["run"], 0)

    def test_drain_all_cancels_reservation_and_survives_pause_and_restart(self):
        w = self.w
        w.start("continuous", "sonnet", "a")                    # reserved, no batch yet
        control.drain_all(w.store, [("sonnet", "a")])
        self.assertEqual(w.store.peek_line("sonnet", "a")["run"], 0)
        w.tick()
        self.assertEqual(w.store.all_batches(), [])
        w.start("continuous", "deepseek", "a")
        w.tick()
        control.drain_all(w.store, [("deepseek", "a")])
        w.store.update(w.row()["id"], state="ERROR", paused_from="PRODUCING", error="x")
        self.assertEqual(w.store.peek_line("deepseek", "a")["drain_once"], 1)   # PAUSED/ERROR keeps the request
        control.stop_line(w.store, "deepseek", "a")
        self.assertEqual(w.store.peek_line("deepseek", "a")["drain_once"], 0)   # Stop supersedes it

    def test_line_drain_takes_effect_after_complete_in_continuous_mode(self):
        w = self.w
        w.start("continuous", "deepseek", "a")
        w.tick()
        control.set_drain(w.store, "deepseek", "a", True)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        open_pr(w, "a", "deepseek", 7)
        w.tick(2)
        w.pr_info(7, HEAD1, state="closed", merged=True)
        w.tick(5)
        ln = w.store.line("deepseek", "a")
        self.assertEqual((w.row()["state"], ln["run"], ln["drain"]), ("COMPLETE", 0, 0))
        self.assertEqual(len(w.store.all_batches()), 1)

    def test_stop_line_preserves_work_blocks_resume_and_spares_others(self):
        w = self.w
        w.start("continuous", "deepseek", "a")
        w.start("continuous", "sonnet", "a")
        w.tick()
        pid_other = w.row("sonnet", "a")["pid"]
        control.stop_line(w.store, "deepseek", "a")
        w.tick(3)
        b = w.row("deepseek", "a")
        self.assertEqual(b["state"], "PAUSED")
        self.assertTrue(Path(b["worktree"]).exists())
        self.assertEqual(w.store.line("deepseek", "a")["run"], 0)
        self.assertEqual(len(w.adapter.launches), 2)            # nothing restarted
        self.assertTrue(w.adapter.alive(pid_other))
        self.assertEqual(w.row("sonnet", "a")["state"], "PRODUCING")
        # Retry applies only to PAUSED/ERROR and reuses the same batch/worktree
        self.assertFalse(control.retry(w.store, "sonnet", "a"))
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.adapter.plan.append({"code": 0})
        w.tick(2)
        self.assertEqual(w.row("deepseek", "a")["state"], "PRODUCING")
        self.assertEqual(len(w.store.line_batches("deepseek", "a")), 1)

    def test_retry_waits_for_confirmed_exit_after_stop(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.tick()
        pid = w.row()["pid"]
        stubborn = {"left": 2}          # the AI survives SIGTERM for two more polls
        orig_alive = w.adapter.alive
        w.adapter.stop = lambda p: None
        w.adapter.alive = lambda p: True if stubborn["left"] > 0 else orig_alive(p)
        control.stop_line(w.store, "deepseek", "a")
        w.tick()
        b = w.row()
        self.assertEqual((b["state"], b["pid"]), ("PAUSED", pid))
        self.assertFalse(control.line_status(w.store, "deepseek", "a")["can_retry"])
        self.assertFalse(control.retry(w.store, "deepseek", "a"))
        w.store.set_line("deepseek", "a", retry_batch=b["id"])   # even a forced request is ignored
        w.tick()
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(w.row()["state"], "PAUSED")
        stubborn["left"] = 0
        w.adapter.running.pop(pid)       # the process finally exits
        w.tick()
        self.assertIsNone(w.row()["pid"])
        self.assertEqual(w.store.runs(b["id"])[0]["exit_status"], "stopped")
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.adapter.plan.append({"code": 0})
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 2)

    def test_start_cannot_bypass_line_drain(self):
        w = self.w
        w.start("single", "deepseek", "a")                  # reserved, no batch yet
        control.set_drain(w.store, "deepseek", "a", True)
        ok, msg = control.start(w.store, "deepseek", "a", "single")
        self.assertFalse(ok)
        self.assertIn("Cancel Drain", msg)
        w.tick(3)
        self.assertEqual(w.store.all_batches(), [])        # drained Line assigns nothing
        self.assertTrue(w.store.line("deepseek", "a")["drain"])
        self.assertTrue(control.start(w.store, "sonnet", "a", "single")[0])  # other Line unaffected
        control.set_drain(w.store, "deepseek", "a", False)  # only Cancel Drain releases it
        w.tick()
        self.assertEqual(len(w.store.all_batches()), 2)

    def test_stop_wins_over_queued_retry(self):
        def paused_world():
            w = self.w
            w.start("single", "deepseek", "a")
            w.start("single", "sonnet", "a")
            w.tick()
            control.stop_all(w.store)
            w.tick(2)
            for m in ("deepseek", "sonnet"):
                self.assertEqual(w.row(m, "a")["state"], "PAUSED")
            return w
        # (1)(2) Retry queued on both Lines, then Stop All before the Supervisor ticks
        w = paused_world()
        n = len(w.adapter.launches)
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        self.assertTrue(control.retry(w.store, "sonnet", "a"))
        control.stop_all(w.store)
        w.tick(5)
        self.assertEqual(len(w.adapter.launches), n)
        for m in ("deepseek", "sonnet"):
            self.assertEqual((w.row(m, "a")["state"], w.store.line(m, "a")["run"]), ("PAUSED", 0))
        # (3) a single-Line Stop cancels only its own queued Retry
        control.retry(w.store, "deepseek", "a")
        control.retry(w.store, "sonnet", "a")
        control.stop_line(w.store, "deepseek", "a")
        w.adapter.plan.append({"code": 0})
        w.tick(3)
        self.assertEqual(w.row("deepseek", "a")["state"], "PAUSED")
        self.assertEqual(w.row("sonnet", "a")["state"], "PRODUCING")
        # (4) a plain Retry still resumes
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.adapter.plan.append({"code": 0})
        w.tick(3)
        self.assertEqual(w.row("deepseek", "a")["state"], "PRODUCING")

    def test_stop_all(self):
        w = self.w
        w.start("continuous", "deepseek", "a")
        w.start("continuous", "sonnet", "a")
        w.start("single", "sonnet", "d")  # no batch yet beyond tick
        w.tick()
        control.stop_all(w.store)
        w.tick(3)
        self.assertFalse(w.adapter.running)
        for m, me in [("deepseek", "a"), ("sonnet", "a"), ("sonnet", "d")]:
            self.assertEqual(w.row(m, me)["state"], "PAUSED")
            self.assertEqual(w.store.line(m, me)["run"], 0)
        n = len(w.adapter.launches)
        w.tick(4)
        self.assertEqual(len(w.adapter.launches), n)

    def test_run_history(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": lambda: open_pr(w, "a", "deepseek", 7)})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        w.gh.reviews_ = [review(11, HEAD1)]
        w.adapter.plan.append({"code": 0})
        w.tick()
        runs = w.store.runs(w.row()["id"])
        self.assertEqual([r["kind"] for r in runs], ["fix_resume", "produce"])
        done = runs[1]
        self.assertEqual((done["exit_status"], done["session_id"]), ("0", "ses_1"))
        self.assertTrue(done["log_file"] and done["exit_file"] and done["pid"] and done["ended_at"])
        self.assertIsNone(runs[0]["ended_at"])
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.pr_info(7, HEAD2); w.git.local_head = HEAD2
        w.tick()
        self.assertEqual(w.store.runs(w.row()["id"])[0]["exit_status"], "0")
        # history survives cleanup
        w.pr_info(7, HEAD2, state="closed", merged=True)
        w.tick(4)
        self.assertEqual(w.row()["state"], "COMPLETE")
        self.assertEqual(len(w.store.line_runs("deepseek", "a")), 2)


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
        w.tmp.cleanup()
        w = multi_world()
        w.start("single", "deepseek", "a")
        w.tick()
        pid = w.row()["pid"]
        w.store.set_line("deepseek", "a", force_stop=1)          # what migration yields for a pending Stop
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
                ln = s.line("deepseek", "a")
                self.assertEqual((ln["mode"], ln["run"], ln["drain"]), ("continuous", 1, 1))
                runs = s.line_runs("deepseek", "a")
                self.assertEqual(len(runs), 2)
                old = [r for r in runs if r["started_at"] == 100][0]
                self.assertEqual((old["exit_status"], old["kind"]), ("0", "legacy"))
                self.assertEqual(len(s.line_events("deepseek", "a")), 1)
                self.assertEqual(s.get("heartbeat"), "5")
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


if __name__ == "__main__":
    unittest.main()
