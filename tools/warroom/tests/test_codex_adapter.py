"""Issue #1376 (mediator decision on #1381): Codex runs under the operator's local CLI policy.

War Room pins the model and effort on every launch and verifies the thread id and the recorded model and effort.
It never adds sandbox, approval, network or writable-root options, and a command the local policy refuses stops
the run in PAUSED.
"""
import json
import os
import stat
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
# Options War Room never passes: the local CLI policy decides sandbox and approval, and bypass flags are never used.
NEVER_PASSED = ("--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--yolo",
                "--full-auto", "--worktree", "--last", "--all", "--ignore-user-config", "--ignore-rules",
                "sandbox_mode", "approval_policy", "sandbox_workspace_write", "writable_roots", "danger-full-access")


def lines(*events) -> str:
    return "".join(json.dumps(e) + "\n" for e in events)


def started(thread=THREAD):
    return {"type": "thread.started", "thread_id": thread}


def completed():
    return {"type": "turn.completed", "usage": {}}


def command(text, exit_code=1, cmd="git commit -q -m x"):
    return {"type": "item.completed", "item": {"id": "i1", "type": "command_execution", "command": cmd,
                                               "aggregated_output": text, "exit_code": exit_code,
                                               "status": "completed" if exit_code == 0 else "failed"}}


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
    def test_start_and_resume_pin_only_model_and_effort(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            a = Recording("codex")
            a.start("prompt body", d, {"GH_CONFIG_DIR": str(d / "gh")}, PIN, "A 009_02", "l.log", "l.exit")
            start = a.cmd
            a.resume(THREAD, "again", d, {}, PIN, "l.log", "l.exit")
            resume = a.cmd
        self.assertEqual(start[1], "exec")
        self.assertEqual(start[start.index("-m") + 1], "gpt-6-luna")
        self.assertIn("model_reasoning_effort=xhigh", start)
        self.assertEqual(start[-1], "prompt body")
        self.assertEqual(resume[1:4], ["exec", "resume", THREAD])
        self.assertIn("model_reasoning_effort=xhigh", resume)
        self.assertEqual(resume[-1], "again")
        for argv in (start, resume):
            joined = " ".join(argv)
            for bad in NEVER_PASSED:
                self.assertNotIn(bad, joined)

    def test_unpinned_run_is_refused_before_any_process(self):
        a = Recording("codex")
        for run in [RunSpec("", "xhigh"), RunSpec("gpt-6-luna", "")]:
            with self.subTest(run=run), self.assertRaises(ValueError):
                a.start("p", ".", {}, run, "t", "l.log", "l.exit")
        self.assertFalse(hasattr(a, "cmd"))


class Preflight(unittest.TestCase):
    EXEC = "--json --model -m --config -c "
    RESUME = "resume --json --model -m "

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
            ("exec lacks --config", {"exec_help": self.EXEC.replace("--config", "")}, "--config"),
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
            ("a different thread id", [started("99999999-0000-4000-8000-000000000000")], [context()], PIN, THREAD, "ERROR"),
            ("legacy run without pin: nothing to compare", [started()], [context(model="x", effort="y")], None, THREAD, None),
        ]
        for name, events, contexts, run, expected, want in cases:
            with self.subTest(name):
                problem = self.check(events, run=run, expected=expected, contexts=contexts)
                self.assertEqual(problem[0] if problem else None, want)

    def test_local_sandbox_and_approval_are_observed_not_enforced(self):
        # The local CLI policy decides these; a different value is not a War Room failure.
        for sandbox, approval in [("workspace-write", "never"), ("danger-full-access", "never"),
                                  ("workspace-write", "on-request"), ("read-only", "untrusted")]:
            with self.subTest(sandbox=sandbox, approval=approval):
                self.assertIsNone(self.check([started(), completed()], contexts=[context(sandbox=sandbox, approval=approval)]))

    def test_a_command_refused_by_the_local_policy_pauses_the_run(self):
        refused = [
            [started(), command("error: Unable to create index.lock: Operation not permitted")],
            [started(), command("fatal: could not write: Permission denied", cmd="gh pr create")],
            [started(), command("action requires approval before running", cmd="git push")],
        ]
        for events in refused:
            with self.subTest(events=events[-1]["item"]["command"]):
                problem = self.check(events, contexts=[context()])
                self.assertEqual(problem[0], "PAUSED")
                self.assertIn("로컬 Codex 정책이 명령을 거부했습니다", problem[1])

    def test_policy_text_in_a_successful_command_is_not_a_refusal(self):
        events = [started(), command("Operation not permitted (printed and handled)", exit_code=0), completed()]
        self.assertIsNone(self.check(events, contexts=[context()]))

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


class PolicyRefusal(unittest.TestCase):
    def test_table(self):
        cases = [  # the refusal shows in agent text too (not only in a command item)
            ("Exit code: 128 — fatal: Unable to create index.lock: Operation not permitted", True),
            ("the command was denied by the sandbox policy", False),
            ("all checks passed", False),
        ]
        for text, refused in cases:
            with self.subTest(text=text), tempfile.TemporaryDirectory() as d:
                log = Path(d) / "l.log"
                log.write_text(lines(started(), {"type": "item.completed",
                                                 "item": {"type": "agent_message", "text": text}}, completed()))
                reason = CodexCLIAdapter().policy_refusal(log)
                self.assertEqual(reason is not None, refused or "Operation not permitted" in text)

    def test_other_adapters_never_report_a_refusal(self):
        from warroom.adapters import ClaudeCodeAdapter, OpenCodeAdapter
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.log"
            log.write_text("Operation not permitted\n")
            self.assertIsNone(OpenCodeAdapter().policy_refusal(log))
            self.assertIsNone(ClaudeCodeAdapter().policy_refusal(log))


class SupervisorStopsOnRecordedDrift(unittest.TestCase):
    class Reporting(FakeAdapter):
        run_problem = CodexCLIAdapter.run_problem
        policy_refusal = CodexCLIAdapter.policy_refusal

    def world(self):
        w = World()
        w.cfg["producers"] = {"codex": {"label": "Luna", "adapter": "codex", "model": "gpt-6-luna", "effort": "xhigh"}}
        w.adapter = self.Reporting()
        w.sup.adapter = w.adapter
        return w

    def test_finished_run_without_a_record_is_an_error_not_a_pr(self):
        w = self.world()
        try:
            with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                w.start("single", "codex", "a")
                w.adapter.plan.append({"code": 0, "text": lines(started(), completed())})
                w.tick()
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                w.tick()
            self.assertEqual(w.row("codex", "a")["state"], "ERROR")
            self.assertIn("turn_context", w.row("codex", "a")["error"])
        finally:
            w.tmp.cleanup()

    def test_no_pr_after_a_policy_refusal_pauses_instead_of_erroring(self):
        w = self.world()
        try:
            with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                rollout_home(Path(home), THREAD, [context()])          # the turn was recorded, as Codex does
                w.start("single", "codex", "a")
                w.adapter.plan.append({"code": 0, "text": lines(started(), {"type": "item.completed", "item": {
                    "type": "agent_message", "text": "Exit code: 128 Operation not permitted"}}, completed())})
                w.tick()
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                w.tick()
            self.assertEqual(w.row("codex", "a")["state"], "PAUSED")
        finally:
            w.tmp.cleanup()

    def test_no_pr_without_a_refusal_stays_an_error(self):
        w = self.world()
        try:
            with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                rollout_home(Path(home), THREAD, [context()])
                w.start("single", "codex", "a")
                w.adapter.plan.append({"code": 0, "text": lines(started(), completed())})
                w.tick()
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                w.tick()
            self.assertEqual(w.row("codex", "a")["state"], "ERROR")
            self.assertIn("PR을 찾지 못했습니다", w.row("codex", "a")["error"])
        finally:
            w.tmp.cleanup()

    def test_refused_command_pauses_and_keeps_the_batch(self):
        w = self.world()
        try:
            with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                w.start("single", "codex", "a")
                w.adapter.plan.append({"code": 0, "text": lines(started(), command("Operation not permitted"))})
                w.tick()
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                w.tick()
            row = w.row("codex", "a")
            self.assertEqual(row["state"], "PAUSED")
            self.assertIsNotNone(row["worktree"])                  # worktree, branch and session are kept
            self.assertEqual(len(w.adapter.launches), 1)           # no automatic retry
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
            h = a.start("prompt text", wt, dict(os.environ), PIN, "A 009_02", d / "l.log", d / "l.exit")
            for _ in range(100):
                if not a.alive(h.pid):
                    break
                time.sleep(0.05)
            text = h.log_file.read_text()
            self.assertIn("-m gpt-6-luna", text)
            self.assertIn("model_reasoning_effort=xhigh", text)
            self.assertNotIn("--ignore-rules", text)
            self.assertEqual(a.session_id(h.log_file), THREAD)


if __name__ == "__main__":
    unittest.main()
