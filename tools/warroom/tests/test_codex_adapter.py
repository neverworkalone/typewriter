"""Issue #1376: Codex CLI adapter. Pins and sandbox on every launch, real git roots, rollout-verified effective values."""
import json
import os
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

from tests.fakes import FakeAdapter, World
from warroom.adapters import CodexCLIAdapter, Handle, RunSpec, classify_failure
from warroom.config import DEFAULTS
from warroom.shell import Result

QUOTA = DEFAULTS["quota_patterns"]
PIN = RunSpec("gpt-6-luna", "xhigh")
THREAD = "01a15e50-8832-7502-9680-0e4fdbf5fcb0"
FORBIDDEN = ("--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--yolo",
             "danger-full-access", "--worktree", "--last", "--all", "--full-auto")


def lines(*events) -> str:
    return "".join(json.dumps(e) + "\n" for e in events)


def started(thread=THREAD):
    return {"type": "thread.started", "thread_id": thread}


def completed():
    return {"type": "turn.completed", "usage": {}}


def rollout_home(tmp: Path, thread: str, contexts: list[dict]) -> Path:
    """A fake CODEX_HOME whose rollout for `thread` records `contexts` (the shape Codex writes)."""
    day = tmp / "sessions" / "2026" / "10" / "21"
    day.mkdir(parents=True)
    body = [{"type": "session_meta", "payload": {"id": thread}}]
    body += [{"type": "turn_context", "payload": c} for c in contexts]
    (day / f"rollout-2026-10-21T20-32-10-{thread}.jsonl").write_text(lines(*body))
    return tmp


def context(model="gpt-6-luna", effort="xhigh", sandbox="workspace-write", approval="never"):
    return {"model": model, "effort": effort, "approval_policy": approval,
            "sandbox_policy": {"type": sandbox, "network_access": True}}


class Recording(CodexCLIAdapter):
    def _spawn(self, cmd, cwd, env, log_file, exit_file):
        self.cmd = cmd
        return Handle(0, Path(exit_file), Path(log_file))


class Argv(unittest.TestCase):
    def test_start_and_resume_pin_model_effort_and_sandbox(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            env = {"GH_CONFIG_DIR": str(d / "gh")}
            a = Recording("codex")
            with mock.patch("warroom.adapters._writable_roots", return_value=["/w/admin", "/w/objects"]):
                a.start("prompt body", d, env, PIN, "A 009_02", "l.log", "l.exit")
                start = a.cmd
                a.resume(THREAD, "again", d, env, PIN, "l.log", "l.exit")
                resume = a.cmd
        self.assertEqual(start[1], "exec")
        self.assertEqual(start[start.index("-m") + 1], "gpt-6-luna")
        self.assertIn("model_reasoning_effort=xhigh", start)
        self.assertIn('sandbox_mode="workspace-write"', start)
        self.assertIn('approval_policy="never"', start)
        self.assertIn("sandbox_workspace_write.network_access=true", start)
        self.assertIn("--ignore-user-config", start)
        self.assertIn("--ignore-rules", start)
        self.assertEqual(start[-1], "prompt body")
        self.assertEqual(resume[1:4], ["exec", "resume", THREAD])
        self.assertIn("model_reasoning_effort=xhigh", resume)
        self.assertEqual(resume[-1], "again")
        for argv in (start, resume):
            for bad in FORBIDDEN:
                self.assertNotIn(bad, " ".join(argv))

    def test_unpinned_run_is_refused_before_any_process(self):
        a = Recording("codex")
        for run in [RunSpec("", "xhigh"), RunSpec("gpt-6-luna", "")]:
            with self.subTest(run=run), self.assertRaises(ValueError):
                a.start("p", ".", {}, run, "t", "l.log", "l.exit")
        self.assertFalse(hasattr(a, "cmd"))


class WritableRootsRealGit(unittest.TestCase):
    """Against a real repository and worktree: the .git directory itself is never a writable root."""

    def test_worktree_roots_are_admin_dir_and_shared_stores_only(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            repo = d / "repo"
            repo.mkdir()
            run = lambda *a, cwd=repo: subprocess.run(["git", *a], cwd=cwd, check=True, capture_output=True)
            run("init", "-q")
            run("-c", "user.email=p@x", "-c", "user.name=p", "commit", "-q", "--allow-empty", "-m", "init")
            wt = d / "wt"
            run("worktree", "add", "-q", "-b", "probe", str(wt))
            roots = [Path(r) for r in __import__("warroom.adapters", fromlist=["_writable_roots"])._writable_roots(
                wt, {"GH_CONFIG_DIR": str(d / "gh")})]
            common = (repo / ".git").resolve()
            self.assertIn(common / "worktrees" / "wt", roots)
            self.assertIn(common / "objects", roots)
            self.assertIn(common / "refs", roots)
            self.assertIn(common / "logs", roots)
            self.assertNotIn(common, roots)                       # the .git directory itself stays read-only
            self.assertIn((d / "gh").resolve(), roots)

    def test_not_a_git_directory_is_an_error_not_an_empty_list(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(RuntimeError):
                __import__("warroom.adapters", fromlist=["_writable_roots"])._writable_roots(d, {})


class Preflight(unittest.TestCase):
    EXEC = ("--json --model -m --config -c --ignore-user-config --ignore-rules --sandbox ")
    RESUME = ("resume --json --model -m --ignore-user-config --ignore-rules ")

    class Fake:
        def __init__(self, exec_help=None, resume_help=None, login="Logged in using ChatGPT", version_ok=True):
            self.exec_help = Preflight.EXEC if exec_help is None else exec_help
            self.resume_help = Preflight.RESUME if resume_help is None else resume_help
            self.login, self.version_ok = login, version_ok

        def run(self, argv, cwd=None, env=None, input=None, timeout=120):
            if argv[1:] == ["--version"]:
                return Result(0, "codex-cli 0.162.1") if self.version_ok else Result(1, "", "boom")
            if argv[1:] == ["exec", "--help"]:
                return Result(0, self.exec_help)
            if argv[1:] == ["exec", "resume", "--help"]:
                return Result(0, self.resume_help)
            if argv[1:] == ["login", "status"]:
                return Result(0, self.login)
            raise AssertionError(argv)

    def test_table(self):
        cases = [
            ("all good", {}, None),
            ("version fails", {"version_ok": False}, "--version"),
            ("exec lacks --ignore-rules", {"exec_help": self.EXEC.replace("--ignore-rules", "")}, "--ignore-rules"),
            ("resume lacks --json", {"resume_help": self.RESUME.replace("--json", "")}, "--json"),
            ("not logged in", {"login": "Not logged in"}, "로그인"),
        ]
        for name, kw, want in cases:
            with self.subTest(name):
                reason = CodexCLIAdapter().preflight(self.Fake(**kw), {}, [PIN])
                if want is None:
                    self.assertIsNone(reason)
                else:
                    self.assertIn(want, reason)


class RunProblem(unittest.TestCase):
    def check(self, events, run=PIN, expected=THREAD, contexts=None, thread=THREAD):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            log = d / "l.log"
            log.write_text(lines(*events))
            home = rollout_home(d / "codex", thread, contexts) if contexts is not None else d / "empty"
            with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}):
                return CodexCLIAdapter().run_problem(log, run, expected)

    def test_table(self):
        cases = [  # name, events, contexts, run, expected, want state
            ("not started yet", [], None, PIN, None, None),
            ("pinned and recorded", [started(), completed()], [context()], PIN, THREAD, None),
            ("wait while the rollout is still being written", [started()], None, PIN, THREAD, None),
            ("finished but no record", [started(), completed()], None, PIN, THREAD, "ERROR"),
            ("model drift", [started(), completed()], [context(model="gpt-5")], PIN, THREAD, "ERROR"),
            ("effort drift", [started(), completed()], [context(effort="high")], PIN, THREAD, "ERROR"),
            ("full access sandbox", [started(), completed()], [context(sandbox="danger-full-access")], PIN, THREAD, "ERROR"),
            ("approval not never", [started(), completed()], [context(approval="on-request")], PIN, THREAD, "ERROR"),
            ("a different thread id", [started("99999999-0000-4000-8000-000000000000")], [context()], PIN, THREAD, "ERROR"),
            ("legacy run without pin: sandbox still checked", [started()], [context(model="x", effort="y")], None, THREAD, None),
        ]
        for name, events, contexts, run, expected, want in cases:
            with self.subTest(name):
                problem = self.check(events, run=run, expected=expected, contexts=contexts)
                self.assertEqual(problem[0] if problem else None, want)

    def test_session_id_comes_from_thread_started(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.log"
            log.write_text("junk\n" + lines(started(), completed()))
            self.assertEqual(CodexCLIAdapter().session_id(log), THREAD)


class Classification(unittest.TestCase):
    def test_table(self):
        cases = [
            ("Unsupported value: 'minimal' is not supported with the 'gpt-6-luna' model. Supported values are: 'none'", "effort"),
            ("Error: thread/resume failed: no rollout found for thread id 0000 (code -32600)", "session_missing"),
            ("Error: 401 Unauthorized", "auth"),
            ("FreeUsageLimitError reached", "free_quota"),
        ]
        for text, want in cases:
            with self.subTest(text=text):
                self.assertEqual(classify_failure(text, QUOTA), want)


class SupervisorStopsOnRecordedDrift(unittest.TestCase):
    class Reporting(FakeAdapter):
        run_problem = CodexCLIAdapter.run_problem

    def test_finished_run_without_a_record_is_an_error_not_a_pr(self):
        w = World()
        w.cfg["producers"] = {"codex": {"label": "Luna", "adapter": "codex", "model": "gpt-6-luna", "effort": "xhigh"}}
        w.adapter = self.Reporting()
        w.sup.adapter = w.adapter
        try:
            with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                w.start("single", "codex", "a")
                w.adapter.plan.append({"code": 0, "text": lines(started(), completed())})
                w.tick()
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                w.tick()
            row = w.row("codex", "a")
            self.assertEqual(row["state"], "ERROR")
            self.assertIn("turn_context", row["error"])
        finally:
            w.tmp.cleanup()


class RealProcessLaunch(unittest.TestCase):
    def test_pins_reach_the_real_child_process(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            wt = d / "wt"
            wt.mkdir()
            fake = d / "codex"
            fake.write_text('#!/bin/sh\necho "args: $@" >&2\necho \'{"type":"thread.started","thread_id":"' + THREAD
                            + '"}\'\nexit 0\n')
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            a = CodexCLIAdapter(str(fake))
            with mock.patch("warroom.adapters._writable_roots", return_value=["/w/admin"]):
                h = a.start("prompt text", wt, dict(os.environ), PIN, "A 009_02", d / "l.log", d / "l.exit")
            for _ in range(100):
                if not a.alive(h.pid):
                    break
                time.sleep(0.05)
            text = h.log_file.read_text()
            self.assertIn("-m gpt-6-luna", text)
            self.assertIn("model_reasoning_effort=xhigh", text)
            self.assertIn("--ignore-rules", text)
            self.assertEqual(a.session_id(h.log_file), THREAD)


if __name__ == "__main__":
    unittest.main()
