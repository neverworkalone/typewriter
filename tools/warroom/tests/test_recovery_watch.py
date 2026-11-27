"""The external Recovery watchdog (`./recovery`, tools/warroom/recovery_watch.py): standalone, acts only when the
Supervisor is dead/stuck, restarts through ./kwar once per condition key, then opens one `supervisor` case + run through
the Supervisor's own claim. Also the cross-checks that keep its copies equal to the Supervisor's code."""
import fcntl
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import recovery_watch
from tests.test_recovery import error_batch, rworld
from warroom import auth, config, restart_controller
from warroom.adapters import ClaudeCodeAdapter, CodexCLIAdapter, RunSpec
from warroom.store import Store

WARROOM = Path(__file__).resolve().parents[1]
REPO = WARROOM.parents[1]


class Done:
    def __init__(self, code=0, out=""):
        self.returncode, self.stdout, self.stderr = code, out, ""


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "root"
        (self.root / ".git" / "typewriter-supervisor").mkdir(parents=True)
        (self.root / "tools" / "warroom" / "prompts").mkdir(parents=True)
        shutil.copy(WARROOM / "prompts" / "recovery.md", self.root / "tools" / "warroom" / "prompts")
        self.local = self.root / "tools" / "warroom" / ".local"
        self.store = Store(self.local / "warroom.db")
        self.cfg = {"recovery": "sonnet", "producers": {"sonnet": {"adapter": "claude", "model": "claude-sonnet",
                                                                   "effort": "high"}}}
        (self.local / "config.json").write_text(json.dumps(self.cfg))
        self.now = 10_000.0
        self.head = "1" * 40
        self.kwar_code = 1
        self.kwar_calls = 0
        self.spawned = []
        self.notices = []
        self.locks = []

        def run(argv, **kw):
            if argv[:2] == ["git", "rev-parse"]:
                return Done(0, self.head + "\n")
            if argv[0].endswith("kwar"):
                self.kwar_calls += 1
                if self.kwar_code == 0:
                    self.store.set("heartbeat", str(self.now + 1))
                return Done(self.kwar_code, "[kwar] out")
            if argv[0] == "osascript":
                self.notices.append(argv)
            return Done(1)

        def sleep(sec):
            self.now += sec

        def spawn(argv, cwd, env, log, ex, stdin):
            self.spawned.append({"argv": argv, "cwd": cwd, "env": env, "log": log})
            return 4321

        self.watch = recovery_watch.Watch(self.root, run=run, clock=lambda: self.now, sleep=sleep, spawn_fn=spawn,
                                          environ={"PATH": "/usr/bin", "GH_TOKEN": "secret"}, out=open(os.devnull, "w"))

    def tearDown(self):
        for fh in self.locks:
            fh.close()
        self.watch.out.close()
        self.tmp.cleanup()

    def hold_supervisor_lock(self):
        fh = (self.root / ".git" / "typewriter-supervisor" / "supervisor.lock").open("a+")
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.locks.append(fh)
        (self.root / ".git" / "typewriter-supervisor" / "supervisor-runtime.json").write_text(
            json.dumps({"pid": os.getpid(), "instance": "i-1"}))


class Lifecycle(Env):
    def test_a_healthy_supervisor_is_left_alone(self):
        self.hold_supervisor_lock()
        self.store.set("heartbeat", str(self.now - 5))
        self.assertEqual(self.watch.once(), "healthy")
        self.assertEqual(self.kwar_calls, 0)

    def test_a_restart_in_progress_is_waited_for(self):
        self.store.set("restart_phase", json.dumps({"instance": "i-1", "phase": "STOPPING", "stopping_at": self.now - 20}))
        self.assertEqual(self.watch.once(), "waiting")
        self.assertEqual(self.kwar_calls, 0)
        self.now += 200   # stuck past the Controller's handoff window: act
        self.assertEqual(self.watch.once(), "failed")
        self.assertEqual(self.kwar_calls, 1)

    def test_a_dead_supervisor_is_restarted_once_through_kwar(self):
        self.kwar_code = 0
        self.assertEqual(self.watch.once(), "restarted")
        self.assertEqual(self.kwar_calls, 1)
        self.assertEqual(self.watch.load()["state"], "healthy")

    def test_a_failed_start_records_notifies_opens_one_case_and_never_repeats_the_same_conditions(self):
        self.assertEqual(self.watch.once(), "failed")
        data = self.watch.load()
        self.assertTrue(data["failed_key"])
        self.assertEqual(data["evidence"]["kwar_exit"], 1)
        self.assertEqual(len(self.notices), 1)
        case = self.store.recovery_case_by_key("supervisor")
        self.assertEqual((case["kind"], case["state"]), ("supervisor", "OPEN"))
        runs = self.store.open_recovery_runs()
        self.assertEqual([(r["case_id"], r["pid"], r["model"]) for r in runs], [(case["id"], 4321, "claude-sonnet")])
        argv = self.spawned[0]["argv"]
        self.assertEqual(argv[-2:], ["--permission-mode", "auto"])
        self.assertNotIn("GH_TOKEN", self.spawned[0]["env"])
        self.assertIn("Supervisor 기동 실패", argv[2])
        # the open run owns the restart: no kwar meanwhile
        self.assertEqual(self.watch.once(), "owned")
        self.store.finish_recovery_run(runs[0]["id"], "1")
        self.assertEqual(self.watch.once(), "held")      # same HEAD/config/env/blocker: not repeated
        self.assertEqual(self.kwar_calls, 1)
        self.assertEqual(len(self.notices), 1)            # notified once
        self.head = "2" * 40                               # a fix landed: the conditions changed
        self.kwar_code = 0
        self.assertEqual(self.watch.once(), "restarted")
        self.assertEqual(self.kwar_calls, 2)
        self.assertEqual(len(self.store.open_recovery_cases()), 1)   # still one supervisor case

    def test_no_second_run_when_the_supervisor_case_already_runs(self):
        self.watch.once()
        self.store.finish_recovery_run(self.store.open_recovery_runs()[0]["id"], "1")
        cid = self.store.recovery_case_by_key("supervisor")["id"]
        claim = dict(producer="sonnet", model="m", effort="high", permission="auto", session_id=None, log_file="l",
                     exit_file="e", max_parallel=1)
        self.assertIsNotNone(self.store.claim_recovery_run(cid, "followup", **claim))   # the Supervisor's own run
        self.assertEqual(self.watch.open_supervisor_case({"kwar_exit": 1})["run_id"], None)

    def test_an_out_of_range_parallel_limit_on_disk_is_never_passed_through(self):
        other = self.store.open_recovery_case("batch:9", "task")
        claim = dict(producer="sonnet", model="m", effort="high", permission="auto", session_id=None, log_file="l",
                     exit_file="e", max_parallel=1)
        self.assertIsNotNone(self.store.claim_recovery_run(other, "start", **claim))   # one Recovery run already open
        for raw in (3, "2", True, 0, None):
            with self.subTest(raw=raw):
                (self.local / "config.json").write_text(json.dumps({**self.cfg, "recovery_max_parallel": raw}))
                self.assertEqual(recovery_watch.max_parallel(self.watch.config()), 1)
                result = self.watch.open_supervisor_case({"kwar_exit": 1})
                self.assertIsNone(result["run_id"])   # the safe limit 1 is already used: no second run
        self.assertEqual(len(self.store.open_recovery_runs()), 1)
        self.assertEqual(self.spawned, [])
        self.assertEqual(recovery_watch.max_parallel({"recovery_max_parallel": 2}), 2)

    def test_paused_and_line_controls_untouched(self):
        self.watch.dir.mkdir(parents=True)
        self.watch.paused_flag.touch()
        self.assertEqual(self.watch.once(), "paused")
        self.store.line("codex", "s2")
        self.store.set_line("codex", "s2", run=0, drain=1)
        self.watch.paused_flag.unlink()
        self.watch.once()
        ln = self.store.peek_line("codex", "s2")
        self.assertEqual((ln["run"], ln["drain"], ln["force_stop"]), (0, 1, 0))

    def test_resume_answers_only_a_waiting_case(self):
        cid = self.store.open_recovery_case("batch:1", "task")
        self.assertFalse(self.watch.resume_case(cid))
        self.store.update_recovery_case(cid, state="WAITING_OWNER", wait_reason={"kind": "denied"})
        self.assertTrue(self.watch.resume_case(cid))
        self.assertIsNotNone(self.store.get(f"recovery_resume_{cid}"))

    def test_the_supervisor_adopts_the_watchdog_run(self):
        w = rworld()
        self.addCleanup(w.tmp.cleanup)
        error_batch(w)
        watch = recovery_watch.Watch(w.paths.repo_root, run=lambda *a, **k: Done(1), clock=lambda: w.now,
                                     sleep=lambda s: None, spawn_fn=lambda *a: w.adapter._go("start", "x", a[3], a[4]).pid,
                                     out=open(os.devnull, "w"))
        self.addCleanup(watch.out.close)
        watch.db, watch.local = w.paths.db, w.paths.local
        (w.paths.local / "config.json").write_text(json.dumps({**w.cfg}))
        watch.open_supervisor_case({"kwar_exit": 1, "status": {"instance": "old"}})
        launches = len(w.adapter.launches)
        w.sup.recovery.step()   # the Supervisor is back: it adopts the run, never a second one for that case
        sup_case = w.store.recovery_case_by_key("supervisor")
        self.assertEqual(len([r for r in w.store.open_recovery_runs() if r["case_id"] == sup_case["id"]]), 1)
        self.assertEqual(sum(1 for x in w.adapter.launches[launches:] if "supervisor" in x.get("prompt", "")), 0)


class Standalone(unittest.TestCase):
    def test_it_never_imports_the_warroom_package(self):
        import re
        src = (WARROOM / "recovery_watch.py").read_text("utf-8")
        self.assertIsNone(re.search(r"^\s*(import|from)\s+(warroom|\.)", src, re.M))
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "broken" / "warroom"
            broken.mkdir(parents=True)
            (broken / "__init__.py").write_text("raise ImportError('broken supervisor package')\n")
            root = Path(tmp) / "root"
            (root / ".git").mkdir(parents=True)
            r = subprocess.run([sys.executable, str(WARROOM / "recovery_watch.py"), str(root), "status"],
                               capture_output=True, text=True, env={**os.environ, "PYTHONPATH": str(broken.parent)})
            self.assertEqual(r.returncode, 0, r.stderr)
            self.assertIn('"supervisor"', r.stdout)

    def test_constants_match_the_restart_controller(self):
        self.assertEqual((recovery_watch.HANDOFF_GRACE, recovery_watch.STARTUP_TIMEOUT),
                         (restart_controller.HANDOFF_GRACE, restart_controller.STARTUP_TIMEOUT))
        self.assertEqual(recovery_watch.SCRUBBED, auth.SCRUBBED)
        self.assertEqual(recovery_watch.TERMINAL_REQUEST_STATES, restart_controller.TERMINAL_REQUEST_STATES)

    def test_child_env_matches_auth_build_env(self):
        base = {"PATH": "/bin", "GH_TOKEN": "x", "GIT_CONFIG_GLOBAL": "/y", "HOME": "/h"}
        self.assertEqual(recovery_watch.child_env(base, Path("/gh"), "n", "e@x"),
                         auth.build_env(base, Path("/gh"), "n", "e@x"))


class ArgvCrossCheck(unittest.TestCase):
    def capture(self, ad, *args, **kw):
        seen = {}

        def spawn(cmd, cwd, env, log, ex, stdin_text=None):
            seen.update(cmd=cmd, stdin=stdin_text)
        ad._spawn = spawn
        ad.start(*args, **kw)
        return seen["cmd"], seen["stdin"]

    def cfgs(self):
        base = json.loads(json.dumps(config.DEFAULTS))
        claude = {**base, "recovery": "sonnet", "claude_bin": "/opt/claude",
                  "producers": {"sonnet": {"adapter": "claude", "model": "claude-sonnet-5-5", "effort": "medium"}}}
        codex = {**base, "recovery": "terra", "codex_bin": "/opt/codex",
                 "producers": {"codex": {"adapter": "codex"}},
                 "model_profiles": {"terra": {"adapter": "codex", "model": "gpt-terra", "effort": "high",
                                              "permission_profile": "worktree", "fast": True}}}
        return claude, codex

    def test_pins_match_run_spec(self):
        for cfg in self.cfgs():
            pins = recovery_watch.recovery_pins(cfg)
            producer = config.recovery_target(cfg)[0]
            spec = config.run_spec(cfg, producer, config.RECOVERY)
            self.assertEqual(pins["producer"], producer)
            self.assertEqual(RunSpec(pins["model"], pins["effort"], pins["permission_profile"], pins["fast"]), spec)
        self.assertIsNone(recovery_watch.recovery_pins({"recovery": None}))

    def test_argv_matches_the_adapters(self):
        claude_cfg, codex_cfg = self.cfgs()
        for prompt in ("짧은 지시", "x" * (70 * 1024)):
            pins = recovery_watch.recovery_pins(claude_cfg)
            spec = config.run_spec(claude_cfg, "sonnet", config.RECOVERY)
            want = self.capture(ClaudeCodeAdapter("/opt/claude"), prompt, "/r", {}, spec, "T", "/l", "/e",
                                permission_mode="auto")
            self.assertEqual(recovery_watch.recovery_argv(pins, prompt, "T", "/r/.git", claude_cfg), want)
            pins = recovery_watch.recovery_pins(codex_cfg)
            spec = config.run_spec(codex_cfg, "codex", config.RECOVERY)
            want = self.capture(CodexCLIAdapter("/opt/codex"), prompt, "/r", {}, spec, "T", "/l", "/e", git_dir="/r/.git")
            self.assertEqual(recovery_watch.recovery_argv(pins, prompt, "T", "/r/.git", codex_cfg), want)


class Scripts(unittest.TestCase):
    def test_recovery_outside_the_operating_checkout_exits_3(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tools" / "warroom" / "recovery-desk").mkdir(parents=True)
            shutil.copy(REPO / "recovery", root / "recovery")
            shutil.copy(WARROOM / "recovery-desk" / "guard.sh", root / "tools" / "warroom" / "recovery-desk")
            (root / ".git").write_text("gitdir: /elsewhere\n")   # a linked worktree
            r = subprocess.run(["sh", str(root / "recovery"), "status"], capture_output=True, text=True)
            self.assertEqual(r.returncode, 3, r.stderr)
            self.assertFalse((root / ".git").is_dir())

    def test_shell_syntax(self):
        for name in ("recovery", "war", "kwar"):
            self.assertEqual(subprocess.run(["sh", "-n", str(REPO / name)]).returncode, 0, name)

    def test_status_py_reads_the_db_read_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            store = Store(root / "tools" / "warroom" / ".local" / "warroom.db")
            cid = store.open_recovery_case("batch:3", "task", notes="first\nlast note")
            store.set("heartbeat", "1")
            before = (root / "tools" / "warroom" / ".local" / "warroom.db").stat().st_mtime_ns
            r = subprocess.run([sys.executable, "-I", str(WARROOM / "recovery-desk" / "status.py"), str(root)],
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr)
            out = json.loads(r.stdout)
            self.assertEqual([(c["id"], c["key"], c["note"]) for c in out["cases"]], [(cid, "batch:3", "last note")])
            self.assertEqual((root / "tools" / "warroom" / ".local" / "warroom.db").stat().st_mtime_ns, before)


if __name__ == "__main__":
    unittest.main()
