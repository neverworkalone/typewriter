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

    def test_drain_scopes_and_priority(self):
        w = self.w
        w.start("continuous", "deepseek", "a")
        w.tick()                                   # batch 001_01 running
        control.set_drain(w.store, "deepseek", "a", True)
        control.set_drain_all(w.store, True)
        control.set_drain_all(w.store, False)      # Cancel Drain (All) keeps the Line drain
        self.assertTrue(control.line_status(w.store, "deepseek", "a")["drain"])
        control.set_drain_all(w.store, True)
        control.set_drain(w.store, "deepseek", "a", False)
        st = control.line_status(w.store, "deepseek", "a")
        self.assertTrue(st["drain"] and not st["line_drain"])   # Drain All alone still blocks
        # the current batch still finishes through review/merge/cleanup
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        open_pr(w, "a", "deepseek", 7)
        w.tick(2)
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")
        w.pr_info(7, HEAD1, state="closed", merged=True)
        w.tick(4)
        self.assertEqual(w.row()["state"], "COMPLETE")
        w.tick(4)
        self.assertEqual(len(w.store.all_batches()), 1)         # no next batch under Drain All
        control.set_drain_all(w.store, False)
        w.start("continuous", "deepseek", "a")
        w.tick()
        self.assertEqual(len(w.store.all_batches()), 2)
        # drain refused on start
        control.set_drain_all(w.store, True)
        self.assertFalse(control.start(w.store, "sonnet", "a", "single")[0])

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
