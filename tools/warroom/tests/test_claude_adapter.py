"""Issue #1375: Claude Code adapter. Pins on every launch, preflight, what the CLI reports vs. the pins, permissions."""
import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path

from tests.fakes import FakeAdapter, World
from warroom.adapters import ClaudeCodeAdapter, Handle, RunSpec, classify_failure
from warroom.config import DEFAULTS
from warroom.shell import Result

QUOTA = DEFAULTS["quota_patterns"]
PIN = RunSpec("sonnet", "medium")
SESSION = "3bbf1f2a-27f9-4a7e-a8ec-400dc799c0f3"
HEAD1 = "a" * 40
BRANCH = "a-claude-001-01"
FORBIDDEN = ("--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode=bypassPermissions",
             "bypassPermissions", "--yolo")


def stream(*events) -> str:
    return "".join(json.dumps(e) + "\n" for e in events)


def init(model="claude-sonnet-5-5", session=SESSION):
    return {"type": "system", "subtype": "init", "session_id": session, "model": model, "permissionMode": "dontAsk"}


def result(denials=(), subtype="success", is_error=False):
    return {"type": "result", "subtype": subtype, "is_error": is_error, "session_id": SESSION,
            "permission_denials": list(denials), "result": "OK"}


class Recording(ClaudeCodeAdapter):
    def _spawn(self, cmd, cwd, env, log_file, exit_file):
        self.cmd = cmd
        return Handle(0, Path(exit_file), Path(log_file))


class Argv(unittest.TestCase):
    def test_start_and_resume_pass_both_pins_explicitly(self):
        for run in [RunSpec("sonnet", "medium"), RunSpec("opus", "high")]:
            with self.subTest(run=run):
                a = Recording("claude")
                a.start("prompt body", ".", {}, run, "A 009_02", "l.log", "l.exit")
                start = a.cmd
                a.resume(SESSION, "again", ".", {}, run, "l.log", "l.exit")
                resume = a.cmd
                for argv in (start, resume):
                    self.assertEqual(argv[argv.index("--model") + 1], run.model)
                    self.assertEqual(argv[argv.index("--effort") + 1], run.effort)
                    self.assertEqual(argv[argv.index("--permission-mode") + 1], "dontAsk")
                    for bad in FORBIDDEN:
                        self.assertNotIn(bad, " ".join(argv))
                self.assertEqual(start[1:3], ["-p", "prompt body"])          # prompt is the -p argument
                self.assertEqual(resume[resume.index("--resume") + 1], SESSION)
                self.assertNotIn("--resume", start)

    def test_unpinned_run_is_refused_before_any_process(self):
        a = Recording("claude")
        for run in [RunSpec("", "medium"), RunSpec("sonnet", "")]:
            with self.subTest(run=run), self.assertRaises(ValueError):
                a.start("p", ".", {}, run, "t", "l.log", "l.exit")
        self.assertFalse(hasattr(a, "cmd"))

    def test_allowlist_is_explicit_and_merge_is_denied(self):
        from warroom.adapters import CLAUDE_ALLOWED_TOOLS, CLAUDE_DISALLOWED_TOOLS
        self.assertIn("Bash(gh pr create *)", CLAUDE_ALLOWED_TOOLS)
        self.assertFalse(any(t.startswith("Bash(gh *)") for t in CLAUDE_ALLOWED_TOOLS))
        self.assertIn("Bash(gh pr merge *)", CLAUDE_DISALLOWED_TOOLS)
        self.assertIn("Bash(git push --force *)", CLAUDE_DISALLOWED_TOOLS)


HELP = ("  --model <model>  --effort <level>  --output-format <format> stream-json\n"
        "  --permission-mode <mode> (choices: \"dontAsk\")  --allowedTools  --disallowedTools\n"
        "  -r, --resume  -n, --name <name>  --verbose\n")



class Preflight(unittest.TestCase):
    class Fake:
        def __init__(self, help_text=HELP, login=True, version_ok=True, version="2.1.293 (Claude Code)"):
            self.help_text, self.login, self.version_ok, self.version = help_text, login, version_ok, version

        def run(self, argv, cwd=None, env=None, input=None, timeout=120):
            if argv[1:] == ["--version"]:
                return Result(0, self.version) if self.version_ok else Result(1, "", "boom")
            if argv[1:] == ["--help"]:
                return Result(0, self.help_text)
            if argv[1:] == ["auth", "status"]:
                return Result(0, json.dumps({"loggedIn": self.login}))
            raise AssertionError(argv)

    def test_table(self):
        cases = [
            ("all good", {}, {}, None),
            ("version fails", {"version_ok": False}, {}, "--version"),
            ("help lacks flag", {"help_text": HELP.replace("--effort", "")}, {}, "--effort"),
            ("not logged in", {"login": False}, {}, "로그인"),
            ("env model override differs", {}, {"ANTHROPIC_MODEL": "opus"}, "ANTHROPIC_MODEL"),
            ("env effort override differs", {}, {"CLAUDE_CODE_EFFORT_LEVEL": "high"}, "CLAUDE_CODE_EFFORT_LEVEL"),
            ("env override equal to pin", {}, {"ANTHROPIC_MODEL": "sonnet"}, None),
        ]
        for name, fake_kw, env, want in cases:
            with self.subTest(name):
                reason = ClaudeCodeAdapter().preflight(self.Fake(**fake_kw), dict(env), [PIN])
                if want is None:
                    self.assertIsNone(reason)
                else:
                    self.assertIn(want, reason)


class RunProblem(unittest.TestCase):
    def check(self, events, run=PIN, expected=SESSION, raw=None):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.log"
            log.write_text(raw if raw is not None else stream(*events))
            return ClaudeCodeAdapter().run_problem(log, run, expected)

    def test_table(self):
        cases = [  # name, events, expected state or None
            ("not started yet", [], None),
            ("matching model and session", [init()], None),
            ("alias matches a full model id", [init("claude-sonnet-5-5")], None),
            ("different model reported", [init("claude-opus-5-5")], "ERROR"),
            ("model not reported", [{**init(), "model": ""}], "ERROR"),
            ("session changed by the CLI", [init(session="11111111-2222-4333-8444-555555555555")], "ERROR"),
            ("denied tool at the end", [init(), result(denials=[{"tool_name": "Bash"}])], "PAUSED"),
            ("clean result", [init(), result()], None),
            ("session id absent from the init event", [{k: v for k, v in init().items() if k != "session_id"}], "ERROR"),
            ("session id empty", [init(session="")], "ERROR"),
            ("session id whitespace only", [init(session="   ")], "ERROR"),
            ("session id not a string", [init(session=7)], "ERROR"),
            ("run ended without any init event", [result()], "ERROR"),
        ]
        for name, events, want in cases:
            with self.subTest(name):
                problem = self.check(events)
                self.assertEqual(problem[0] if problem else None, want)

    def test_effort_fallback_is_an_error_even_when_the_run_exits_0(self):
        raw = "Warning: Unknown --effort value 'bogus' — ignoring it and using the default effort. Valid values: low\n" + stream(init())
        self.assertEqual(self.check([], raw=raw)[0], "ERROR")

    def test_legacy_run_without_recorded_pin_skips_the_model_comparison(self):
        self.assertIsNone(self.check([init("claude-opus-5-5")], run=None))

    def test_denied_tool_names_are_reported(self):
        problem = self.check([init(), result(denials=[{"tool_name": "Bash"}, {"tool_name": "Bash"}])])
        self.assertIn("Bash", problem[1])


class Classification(unittest.TestCase):
    def test_table(self):
        cases = [
            ("No conversation found with session ID: 0000", "session_missing"),
            ("no rollout found for thread id 0000 (code -32600)", "session_missing"),
            ("Claude AI usage limit reached. Your limit resets at 5pm", "usage_limit"),
            ("5-hour limit reached", "usage_limit"),
            ("Warning: Unknown --effort value 'bogus' — ignoring it", "effort"),
            ("Not logged in · Please run /login", "auth"),
            ("Rate limit reached for model in the org", "rate_limit"),   # generic 429 keeps the backoff path
            ("FreeUsageLimitError reached", "free_quota"),               # quota patterns still come first
        ]
        for text, want in cases:
            with self.subTest(text=text):
                self.assertEqual(classify_failure(text, QUOTA), want)


class SupervisorStopsOnContradiction(unittest.TestCase):
    class Reporting(FakeAdapter):
        run_problem = ClaudeCodeAdapter.run_problem

    def setUp(self):
        self.w = World()
        self.w.cfg["producers"] = {"claude": {"label": "Sonnet", "adapter": "claude", "model": "sonnet", "effort": "medium"}}
        self.w.adapter = self.Reporting()
        self.w.sup.adapter = self.w.adapter

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_opus_report_stops_the_run_before_a_pr_is_accepted(self):
        w = self.w
        w.start("single", "claude", "a")
        w.adapter.plan.append({"code": 0, "text": stream(init("claude-opus-5-5"))})   # the run's output, set before launch
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        row = w.row("claude", "a")
        self.assertEqual(row["state"], "ERROR")
        self.assertIn("다릅니다", row["error"])
        self.assertIsNone(w.adapter.running.get(w.adapter.launches[-1]["pid"]))   # the run was stopped

    def test_finished_run_without_a_session_is_not_accepted_even_with_a_pr(self):
        w = self.w
        w.start("single", "claude", "a")
        w.pr_info(7, HEAD1)
        w.gh.by_branch[BRANCH] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
        w.adapter.plan.append({"code": 0, "text": stream(result())})     # exits 0, never reported its session
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.row("claude", "a")["state"], "ERROR")
        self.assertIn("세션", w.row("claude", "a")["error"])

    def test_denial_pauses_for_the_operator(self):
        w = self.w
        w.start("single", "claude", "a")
        w.adapter.plan.append({"code": 0, "text": stream(init(), result(denials=[{"tool_name": "Bash"}]))})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.row("claude", "a")["state"], "PAUSED")


class RealProcessLaunch(unittest.TestCase):
    def test_pins_reach_the_real_child_process(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            fake = d / "claude"
            fake.write_text('#!/bin/sh\necho "args: $@" >&2\necho \'{"type":"system","subtype":"init","session_id":"'
                            + SESSION + '","model":"claude-sonnet-5-5"}\'\nexit 0\n')
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            a = ClaudeCodeAdapter(str(fake))
            h = a.start("prompt text", d, dict(os.environ), PIN, "A 009_02", d / "l.log", d / "l.exit")
            for _ in range(100):
                if not a.alive(h.pid):
                    break
                time.sleep(0.05)
            text = h.log_file.read_text()
            self.assertIn("--model sonnet --effort medium", text)
            self.assertIn("--permission-mode dontAsk", text)
            self.assertEqual(a.session_id(h.log_file), SESSION)
            self.assertIsNone(a.run_problem(h.log_file, PIN, SESSION))


if __name__ == "__main__":
    unittest.main()
