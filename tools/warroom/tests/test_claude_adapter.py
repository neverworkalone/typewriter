"""Issue #1375: Claude Code adapter. Pins on every launch, preflight, what the CLI reports vs. the pins, permissions."""
import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path

from tests.fakes import FakeAdapter, World
from warroom.adapters import ClaudeCodeAdapter, Handle, ProcessAdapter, RunSpec, classify_failure
from warroom.config import DEFAULTS
from warroom.shell import Result

QUOTA = DEFAULTS["quota_patterns"]
PIN = RunSpec("sonnet", "medium")
SESSION = "3bbf1f2a-27f9-4a7e-a8ec-400dc799c0f3"
HEAD1 = "a" * 40
HELP_NO_PERMISSION_FLAGS = "  --model <model>  --effort <level>  --output-format <format> stream-json\n  -r, --resume  -n, --name <name>  --verbose\n"
BRANCH = "a-claude-001-01"
# War Room passes no permission option at all: the local Claude settings decide, never a flag from here.
FORBIDDEN = ("--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--permission-mode",
             "bypassPermissions", "dontAsk", "--allowedTools", "--disallowedTools", "--yolo")


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
                    for bad in FORBIDDEN:
                        self.assertNotIn(bad, argv)                   # never a permission option from War Room
                    self.assertEqual(argv[:2], [argv[0], "-p"])
                self.assertEqual(start[1:3], ["-p", "prompt body"])          # prompt is the -p argument
                self.assertEqual(resume[resume.index("--resume") + 1], SESSION)
                self.assertNotIn("--resume", start)

    def test_unpinned_run_is_refused_before_any_process(self):
        a = Recording("claude")
        for run in [RunSpec("", "medium"), RunSpec("sonnet", "")]:
            with self.subTest(run=run), self.assertRaises(ValueError):
                a.start("p", ".", {}, run, "t", "l.log", "l.exit")
        self.assertFalse(hasattr(a, "cmd"))

    def test_no_war_room_allowlist_exists(self):
        import warroom.adapters as adapters
        for name in ("CLAUDE_ALLOWED_TOOLS", "CLAUDE_DISALLOWED_TOOLS"):
            self.assertFalse(hasattr(adapters, name), name)


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
            ("no permission options needed from the CLI help", {"help_text": HELP_NO_PERMISSION_FLAGS}, {}, None),
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


class CompletionGate(unittest.TestCase):
    """An exited run is accepted only with the session its own init event reported."""

    def check(self, raw, expected=SESSION):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.log"
            log.write_text(raw)
            return ClaudeCodeAdapter().completion_problem(log, PIN, expected)

    def test_table(self):
        cases = [  # name, raw log, expected state or None
            ("empty log", "", "ERROR"),
            ("only non-JSON output", "something went wrong\nno events here\n", "ERROR"),
            ("result but no init", stream(result()), "ERROR"),
            ("init with the session, then a clean result", stream(init(), result()), None),
            ("init with another session than requested", stream(init(session="11111111-2222-4333-8444-555555555555")), "ERROR"),
            ("init with an empty session", stream(init(session="")), "ERROR"),
            ("init only, no final result", stream(init()), "ERROR"),
            ("result is_error with subtype success", stream(init(), result(is_error=True)), "ERROR"),
            ("result error_max_turns", stream(init(), result(subtype="error_max_turns", is_error=True)), "ERROR"),
            ("result error subtype without is_error", stream(init(), result(subtype="error_during_execution")), "ERROR"),
            ("result without is_error", stream(init(), {"type": "result", "subtype": "success", "session_id": SESSION}), "ERROR"),
            ("result of another session", stream(init(), {**result(), "session_id": "11111111-2222-4333-8444-555555555555"}), "ERROR"),
            ("result without a session id", stream(init(), {k: v for k, v in result().items() if k != "session_id"}), "ERROR"),
            ("result with a null session id", stream(init(), {**result(), "session_id": None}), "ERROR"),
            ("result with an empty session id", stream(init(), {**result(), "session_id": ""}), "ERROR"),
            ("result with a blank session id", stream(init(), {**result(), "session_id": "  "}), "ERROR"),
            ("result with a non-string session id", stream(init(), {**result(), "session_id": 7}), "ERROR"),
            ("success with denials pauses", stream(init(), result(denials=[{"tool_name": "Bash"}])), "PAUSED"),
        ]
        for name, raw, want in cases:
            with self.subTest(name):
                problem = self.check(raw)
                self.assertEqual(problem[0] if problem else None, want)

    def test_an_empty_log_is_still_waiting_mid_run_but_refused_at_completion(self):
        # run_problem keeps waiting for a live run; the completion gate refuses the same empty log once the process exited 0
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "l.log"
            log.write_text("")
            self.assertIsNone(ClaudeCodeAdapter().run_problem(log, PIN, SESSION))
            self.assertEqual(ClaudeCodeAdapter().completion_problem(log, PIN, SESSION)[0], "ERROR")


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
        self.assertIn("로컬 CLI 권한 정책상 거부", problem[1])          # the local settings decided, not a War Room list
        self.assertNotIn("허용 목록", problem[1])


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
        completion_problem = ClaudeCodeAdapter.completion_problem
        requires_session_for_pr = ClaudeCodeAdapter.requires_session_for_pr
        requires_final_result_for_pr = ClaudeCodeAdapter.requires_final_result_for_pr
        session_id = ProcessAdapter.session_id   # the stream carries "session_id" on every event

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

    def test_exit0_with_an_empty_log_and_a_pr_is_not_accepted(self):
        w = self.w
        w.start("single", "claude", "a")
        w.pr_info(7, HEAD1)
        w.gh.by_branch[BRANCH] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
        w.adapter.plan.append({"code": 0, "text": ""})            # exits 0 having written nothing parsable
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.row("claude", "a")["state"], "ERROR")
        self.assertIn("세션", w.row("claude", "a")["error"])

    def test_a_pr_is_not_adopted_from_a_live_run_before_its_session(self):
        w = self.w
        w.start("single", "claude", "a")
        w.pr_info(7, HEAD1)
        w.gh.by_branch[BRANCH] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
        w.tick()                                                  # launched, nothing reported yet
        w.tick()
        self.assertEqual(w.row("claude", "a")["state"], "PRODUCING")

    # Review (Stage 2, #1380): a PR that appears while the run is still alive is not a verified result. It is taken
    # over only after the run exited and its final denials, session and model were checked.

    def live_log(self, pid, text):
        Path(self.w.adapter.running[pid]["log"]).write_text(text)   # what the CLI has written so far

    def test_early_pr_with_a_session_is_not_taken_over_before_the_final_result(self):
        w = self.w
        w.start("single", "claude", "a")
        w.pr_info(7, HEAD1)
        w.gh.by_branch[BRANCH] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
        w.adapter.plan.append({"code": 0, "text": stream(init(), result(denials=[{"tool_name": "Bash"}]))})
        w.tick()
        pid = w.adapter.launches[-1]["pid"]
        self.live_log(pid, stream(init()))                       # session and model known, PR already open
        w.tick()
        self.assertEqual(w.row("claude", "a")["state"], "PRODUCING")
        self.assertIsNone(w.row("claude", "a")["pr_number"])
        w.adapter.finish(pid)                                    # the final result: a denial, exit 0
        w.tick()
        self.assertEqual(w.row("claude", "a")["state"], "PAUSED")
        self.assertNotIn(w.row("claude", "a")["state"], ("COMPLETE", "CLEANUP", "MERGED"))

    def test_early_pr_with_a_normal_final_result_reaches_review(self):
        w = self.w
        w.start("single", "claude", "a")
        w.pr_info(7, HEAD1)
        w.gh.by_branch[BRANCH] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
        w.adapter.plan.append({"code": 0, "text": stream(init(), result())})
        w.tick()
        pid = w.adapter.launches[-1]["pid"]
        self.live_log(pid, stream(init()))
        w.tick()
        self.assertEqual(w.row("claude", "a")["state"], "PRODUCING")
        w.adapter.finish(pid)
        w.tick()
        self.assertEqual(w.row("claude", "a")["state"], "WAITING_REVIEW")
        self.assertEqual(w.row("claude", "a")["pr_number"], 7)

    def test_exit0_without_a_success_result_is_not_accepted_even_with_a_pr(self):
        # Review (post-merge, #1380): init alone, or an error result, must not reach WAITING_REVIEW.
        cases = [("init only", stream(init())),
                 ("error_max_turns", stream(init(), result(subtype="error_max_turns", is_error=True))),
                 ("is_error", stream(init(), result(is_error=True))),
                 ("result without session_id", stream(init(), {k: v for k, v in result().items() if k != "session_id"})),
                 ("result with null session_id", stream(init(), {**result(), "session_id": None}))]
        for name, text in cases:
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                w = self.w
                w.start("single", "claude", "a")
                w.pr_info(7, HEAD1)
                w.gh.by_branch[BRANCH] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
                w.adapter.plan.append({"code": 0, "text": text})
                w.tick()
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                w.tick()
                self.assertEqual(w.row("claude", "a")["state"], "ERROR")
                self.assertIsNone(w.row("claude", "a")["pr_number"])

    def test_a_denial_without_any_pr_pauses(self):
        w = self.w
        w.start("single", "claude", "a")
        w.adapter.plan.append({"code": 0, "text": stream(init(), result(denials=[{"tool_name": "Bash"}]))})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.row("claude", "a")["state"], "PAUSED")

    def test_merged_pr_seen_while_the_run_is_alive_does_not_clean_up_early(self):
        w = self.w
        w.start("single", "claude", "a")
        w.pr_info(7, HEAD1, state="closed", merged=True)
        w.gh.by_branch[BRANCH] = [{"number": 7, "state": "CLOSED", "headRefOid": HEAD1}]
        w.adapter.plan.append({"code": 0, "text": stream(init(), result())})
        w.tick()
        pid = w.adapter.launches[-1]["pid"]
        self.live_log(pid, stream(init()))
        w.tick(3)
        self.assertEqual(w.row("claude", "a")["state"], "PRODUCING")     # not MERGED, not CLEANUP, not COMPLETE
        self.assertTrue(w.adapter.alive(pid))                           # the run was not stopped for cleanup
        w.adapter.finish(pid)
        w.tick()
        self.assertEqual(w.row("claude", "a")["state"], "WAITING_REVIEW")  # verified at exit, then watched for merge

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
            self.assertNotIn("--permission-mode", text)              # the local settings decide, not War Room
            self.assertEqual(a.session_id(h.log_file), SESSION)
            self.assertIsNone(a.run_problem(h.log_file, PIN, SESSION))


if __name__ == "__main__":
    unittest.main()
