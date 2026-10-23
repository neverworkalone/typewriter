"""Codex runs with War Room's pinned worktree permission profile and operator-defined rules.

War Room pins model, effort, and the worktree permission selection on every launch, while the
profile's filesystem/network rules and approval policy still come from the operator's CLI config.
A command the resulting policy refuses stops the run in PAUSED.
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
HEAD1 = "a" * 40
# Options War Room never passes: approval and legacy sandbox remain local, and bypass flags are never used.
NEVER_PASSED = ("--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--yolo",
                "--full-auto", "--worktree", "--last", "--all", "--ignore-user-config", "--ignore-rules",
                "sandbox_mode", "approval_policy", "sandbox_workspace_write", "writable_roots", "danger-full-access")


def lines(*events) -> str:
    return "".join(json.dumps(e) + "\n" for e in events)


def started(thread=THREAD):
    return {"type": "thread.started", "thread_id": thread}


def completed():
    return {"type": "turn.completed", "usage": {}}


def failed(message="provider failure"):
    return {"type": "turn.failed", "error": {"message": message}}


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
    def test_start_and_resume_pin_model_effort_and_configured_permission_profile(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            a = Recording("codex")
            run = RunSpec("gpt-6-luna", "xhigh", "worktree")
            a.start("prompt body", d, {"GH_CONFIG_DIR": str(d / "gh")}, run, "A 009_02", d / "l.log", d / "l.exit")
            start = a.cmd
            a.resume(THREAD, "again", d, {}, run, d / "l.log", d / "l.exit")
            resume = a.cmd
        self.assertEqual(start[1], "exec")
        self.assertEqual(start[start.index("-m") + 1], "gpt-6-luna")
        self.assertIn("model_reasoning_effort=xhigh", start)
        self.assertEqual(start.count("default_permissions=worktree"), 1)
        self.assertEqual(start[-1], "prompt body")
        self.assertEqual(resume[1:4], ["exec", "resume", THREAD])
        self.assertIn("model_reasoning_effort=xhigh", resume)
        self.assertEqual(resume.count("default_permissions=worktree"), 1)
        self.assertEqual(resume[-1], "again")
        for argv in (start, resume):
            joined = " ".join(argv)
            for bad in NEVER_PASSED:
                self.assertNotIn(bad, joined)

    def test_permission_profile_is_exactly_the_configured_name_or_absent(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            for profile, want in [("worktree", ["default_permissions=worktree"]), ("other-1", ["default_permissions=other-1"]),
                                  ("", [])]:
                with self.subTest(profile=profile):
                    a = Recording("codex")
                    run = RunSpec("gpt-6-luna", "xhigh", profile)
                    for call in (lambda: a.start("p", d, {}, run, "t", d / "l.log", d / "l.exit"),
                                 lambda: a.resume(THREAD, "p", d, {}, run, d / "l.log", d / "l.exit")):
                        call()
                        self.assertEqual([x for x in a.cmd if x.startswith("default_permissions=")], want)

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


BAD_THREADS = [None, "", " ", 7, ["x"], "*", "a/b", "../x", "ab*", "a b"]   # missing/empty/non-string/glob/path forms


class MalformedThreadId(unittest.TestCase):
    """#1381 Stage 1: a thread.started without a usable thread_id is never a session; no rollout search runs for it."""

    def check(self, method, thread, expected):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            log = d / "l.log"
            log.write_text(lines({"type": "thread.started", "thread_id": thread}, completed()))
            # an unrelated past session whose pinned record would pass if the search widened to it
            home = rollout_home(d / "codex", THREAD, [context()])
            with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}):
                a = CodexCLIAdapter()
                if method == "session_id":
                    return a.session_id(log)
                return getattr(a, method)(log, PIN, expected)

    def test_table(self):
        for thread in BAD_THREADS:
            for expected in (None, THREAD):
                for method in ("completion_problem", "run_problem"):
                    with self.subTest(thread=thread, expected=expected, method=method):
                        problem = self.check(method, thread, expected)
                        self.assertEqual(problem[0] if problem else None, "ERROR")
            with self.subTest(thread=thread, method="session_id"):
                self.assertIsNone(self.check("session_id", thread, None))

    def test_a_valid_thread_still_passes(self):
        self.assertIsNone(self.check("completion_problem", THREAD, None))
        self.assertIsNone(self.check("run_problem", THREAD, THREAD))
        self.assertEqual(self.check("session_id", THREAD, None), THREAD)

    def test_no_rollout_is_searched_for_an_unusable_id(self):
        from warroom.adapters import _turn_contexts
        with tempfile.TemporaryDirectory() as d:
            with mock.patch.dict(os.environ, {"CODEX_HOME": str(rollout_home(Path(d), THREAD, [context()]))}):
                for bad in ("", "*", "a/b", None):
                    with self.subTest(bad=bad):
                        self.assertEqual(_turn_contexts(bad), [])
                self.assertEqual(len(_turn_contexts(THREAD)), 1)


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
            ("Operation not permitted was printed by the test; the check passed with exit code 0", False),
            ("I did not run it. Operation not permitted is the error text from the docs", False),
        ]
        for text, refused in cases:
            with self.subTest(text=text), tempfile.TemporaryDirectory() as d:
                log = Path(d) / "l.log"
                log.write_text(lines(started(), {"type": "item.completed",
                                                 "item": {"type": "agent_message", "text": text}}, completed()))
                reason = CodexCLIAdapter().policy_refusal(log)
                self.assertEqual(reason is not None, refused)

    def test_a_structured_refusal_needs_a_failed_command(self):
        def log_with(item):
            with tempfile.TemporaryDirectory() as d:
                log = Path(d) / "l.log"
                log.write_text(lines(started(), {"type": "item.completed", "item": item}, completed()))
                return CodexCLIAdapter().policy_refusal(log)

        self.assertIsNotNone(log_with({"type": "command_execution", "command": "git commit",
                                       "aggregated_output": "index.lock: Operation not permitted", "exit_code": 128}))
        self.assertIsNone(log_with({"type": "command_execution", "command": "echo",
                                    "aggregated_output": "Operation not permitted (handled)", "exit_code": 0}))
        self.assertIsNone(log_with({"type": "command_execution", "command": "git status",
                                    "aggregated_output": "clean", "exit_code": 0}))

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
        completion_problem = CodexCLIAdapter.completion_problem

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



class CompletionGate(unittest.TestCase):
    """#1381 blocker 1: a run that exits 0 is accepted only with its own thread id and its own turn record."""

    def check(self, events, contexts=None, run=PIN, expected=THREAD, baseline=None):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            log = d / "l.log"
            log.write_text(lines(*events))
            if baseline is not None:   # a resume: the turns recorded before this run
                from warroom.adapters import _baseline_path
                _baseline_path(log).write_text(json.dumps({"thread": THREAD, "turns": baseline}))
            home = rollout_home(d / "codex", THREAD, contexts or []) if contexts is not None else d / "empty"
            with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}):
                return CodexCLIAdapter().completion_problem(log, run, expected)

    def test_table(self):
        cases = [  # name, events, contexts, baseline turns, expected state
            ("no thread id recorded: no PR intake", [completed()], [context()], None, "ERROR"),
            ("thread but no turn record of this run", [started(), completed()], None, None, "ERROR"),
            ("only a past turn's record (resume, no new record)", [started(), completed()], [context()], 1, "ERROR"),
            ("this run's record matches the pins", [started(), completed()], [context()], None, None),
            ("this run's record after a baseline matches", [started(), completed()], [context(), context()], 1, None),
            ("this run's record has another model", [started(), completed()], [context(model="gpt-5")], None, "ERROR"),
            ("this run's record has another effort", [started(), completed()], [context(effort="high")], None, "ERROR"),
            ("another thread than the requested one", [started("99999999-0000-4000-8000-000000000000"), completed()],
             [context()], None, "ERROR"),
            ("turn.failed with a matching record", [started(), failed()], [context()], None, "ERROR"),
            ("turn.failed with a string error", [started(), {"type": "turn.failed", "error": "boom"}], [context()], None, "ERROR"),
            ("turn.failed without an error", [started(), {"type": "turn.failed"}], [context()], None, "ERROR"),
            ("completed and then failed", [started(), completed(), failed()], [context()], None, "ERROR"),
            ("failed and then completed (retry inside the run)", [started(), failed(), completed()], [context()], None, "ERROR"),
            ("no terminal event (truncated log)", [started()], [context()], None, "ERROR"),
            ("a command ran but the turn never completed", [started(), command("ok", exit_code=0)], [context()], None, "ERROR"),
            ("resume: only the past turn completed, none now", [started()], [context(), context()], 1, "ERROR"),
            ("resume: this run completed", [started(), completed()], [context(), context()], 1, None),
        ]
        for name, events, contexts, baseline, want in cases:
            with self.subTest(name):
                problem = self.check(events, contexts=contexts, baseline=baseline)
                self.assertEqual(problem[0] if problem else None, want)

    def test_a_resume_that_switched_threads_is_refused(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            log = d / "l.log"
            log.write_text(lines(started("99999999-0000-4000-8000-000000000000"), completed()))
            from warroom.adapters import _baseline_path
            _baseline_path(log).write_text(json.dumps({"thread": THREAD, "turns": 0}))
            problem = CodexCLIAdapter().completion_problem(log, PIN, None)
            self.assertEqual(problem[0], "ERROR")

    def test_resume_records_the_turn_baseline_of_its_session(self):
        class Spy(CodexCLIAdapter):
            def _spawn(self, cmd, cwd, env, log_file, exit_file):
                return Handle(0, Path(exit_file), Path(log_file))

        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            home = rollout_home(d / "codex", THREAD, [context(), context()])
            log = d / "r.log"
            with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}):
                Spy("codex").resume(THREAD, "again", d, {}, PIN, log, d / "r.exit")
            from warroom.adapters import _baseline
            self.assertEqual(_baseline(log), (THREAD, 2))


class PrIntake(unittest.TestCase):
    """#1381 blocker 1 at the Supervisor: a PR is taken over only from a run whose own evidence was recorded."""

    class Reporting(FakeAdapter):
        run_problem = CodexCLIAdapter.run_problem
        policy_refusal = CodexCLIAdapter.policy_refusal
        completion_problem = CodexCLIAdapter.completion_problem
        requires_session_for_pr = CodexCLIAdapter.requires_session_for_pr
        requires_final_result_for_pr = CodexCLIAdapter.requires_final_result_for_pr

    def world(self):
        w = World()
        w.cfg["producers"] = {"codex": {"label": "Luna", "adapter": "codex", "model": "gpt-6-luna", "effort": "xhigh"}}
        w.adapter = self.Reporting()
        w.sup.adapter = w.adapter
        w.pr_info(7, HEAD1)
        w.gh.by_branch["a-codex-001-01"] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
        return w

    def test_exit0_with_a_pr_but_no_thread_is_not_accepted(self):
        w = self.world()
        try:
            with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                w.start("single", "codex", "a")
                w.adapter.plan.append({"code": 0, "text": lines(completed())})   # a finished turn, no thread id
                w.tick()
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                w.tick()
            self.assertEqual(w.row("codex", "a")["state"], "ERROR")
            self.assertIn("세션", w.row("codex", "a")["error"])
        finally:
            w.tmp.cleanup()

    def test_exit0_with_a_pr_but_no_successful_turn_is_not_accepted(self):
        runs = {"turn.failed": [started(), failed()], "no terminal event": [started()],
                "completed then failed": [started(), completed(), failed()]}
        for name, events in runs.items():
            with self.subTest(name):
                w = self.world()
                try:
                    with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                        rollout_home(Path(home), THREAD, [context()])   # pin-matching record, owned PR, exit 0
                        w.start("single", "codex", "a")
                        w.adapter.plan.append({"code": 0, "text": lines(*events)})
                        w.tick()
                        w.adapter.finish(w.adapter.launches[-1]["pid"])
                        w.tick()
                    self.assertEqual(w.row("codex", "a")["state"], "ERROR")
                finally:
                    w.tmp.cleanup()

    def test_exit0_with_a_pr_and_a_completed_turn_reaches_review(self):
        w = self.world()
        try:
            with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                rollout_home(Path(home), THREAD, [context()])
                w.start("single", "codex", "a")
                w.adapter.plan.append({"code": 0, "text": lines(started(), completed())})
                w.tick()
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                w.tick()
            self.assertEqual(w.row("codex", "a")["state"], "WAITING_REVIEW")
        finally:
            w.tmp.cleanup()

    def test_exit0_with_a_pr_and_a_malformed_thread_id_is_not_accepted(self):
        for thread in BAD_THREADS:
            with self.subTest(thread=thread):
                w = self.world()
                try:
                    with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                        rollout_home(Path(home), THREAD, [context()])   # an unrelated, pin-matching session
                        w.start("single", "codex", "a")
                        w.adapter.plan.append({"code": 0, "text": lines(
                            {"type": "thread.started", "thread_id": thread}, completed())})
                        w.tick()
                        w.adapter.finish(w.adapter.launches[-1]["pid"])
                        w.tick()
                    self.assertEqual(w.row("codex", "a")["state"], "ERROR")
                finally:
                    w.tmp.cleanup()

    def test_success_output_with_a_refusal_word_and_no_pr_is_an_error(self):
        w = self.world()
        w.gh.by_branch = {}                                    # no PR on the branch
        try:
            with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                rollout_home(Path(home), THREAD, [context()])
                w.start("single", "codex", "a")
                w.adapter.plan.append({"code": 0, "text": lines(started(), command(
                    "Operation not permitted (printed and handled)", exit_code=0), completed())})
                w.tick()
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                w.tick()
            self.assertEqual(w.row("codex", "a")["state"], "ERROR")
            self.assertIn("PR을 찾지 못했습니다", w.row("codex", "a")["error"])
        finally:
            w.tmp.cleanup()

    def test_a_pr_is_not_adopted_while_the_run_has_no_session(self):
        w = self.world()
        try:
            with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                w.start("single", "codex", "a")
                w.tick()                       # launched; nothing recorded yet, the PR already exists
                w.tick()
            self.assertEqual(w.row("codex", "a")["state"], "PRODUCING")
        finally:
            w.tmp.cleanup()

    def test_a_recorded_turn_with_its_pr_reaches_review(self):
        w = self.world()
        try:
            with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"CODEX_HOME": home}):
                rollout_home(Path(home), THREAD, [context()])          # the turn was recorded, as Codex does
                w.start("single", "codex", "a")
                w.adapter.plan.append({"code": 0, "text": lines(started(), completed())})
                w.tick()
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                w.tick()
            self.assertEqual(w.row("codex", "a")["state"], "WAITING_REVIEW")
            self.assertEqual(w.row("codex", "a")["pr_number"], 7)
        finally:
            w.tmp.cleanup()


class LaunchLogIsOwn(unittest.TestCase):
    """#1381 Stage 1: a launch's completion evidence comes from its own log, never from an earlier run's events."""

    def fake_codex(self, d, body):
        fake = d / "codex"
        fake.write_text("#!/bin/sh\n" + body)
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        return CodexCLIAdapter(str(fake))

    def wait(self, a, h):
        for _ in range(100):
            if not a.alive(h.pid):
                break
            time.sleep(0.05)

    def test_a_launch_never_continues_an_earlier_log(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            wt = d / "wt"
            wt.mkdir()
            a = self.fake_codex(d, 'echo \'{"type":"thread.started","thread_id":"' + THREAD + '"}\'\nexit 0\n')
            log = d / "l.log"
            log.write_text(lines(started(), completed()))               # an earlier run's events at the same path
            home = rollout_home(d / "codex-home", THREAD, [context()])
            with mock.patch.dict(os.environ, {"CODEX_HOME": str(home)}):
                h = a.resume(THREAD, "p", wt, dict(os.environ), PIN, log, d / "l.exit")
                self.wait(a, h)
                rollout_home_files = list((home / "sessions").glob("*/*/*/rollout-*.jsonl"))
                rollout_home_files[0].write_text(lines(
                    {"type": "turn_context", "payload": context()}, {"type": "turn_context", "payload": context()}))
                # this run recorded its own pinned turn and exited 0, but never reported turn.completed
                problem = a.completion_problem(log, PIN, THREAD)
            self.assertNotIn("turn.completed", log.read_text())
            self.assertEqual(problem[0] if problem else None, "ERROR")

    def test_a_fresh_start_drops_a_stale_resume_baseline(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            wt = d / "wt"
            wt.mkdir()
            a = self.fake_codex(d, "exit 0\n")
            log = d / "l.log"
            from warroom.adapters import _baseline_path
            _baseline_path(log).write_text(json.dumps({"thread": THREAD, "turns": 5}))
            h = a.start("p", wt, dict(os.environ), PIN, "t", log, d / "l.exit")
            self.wait(a, h)
            self.assertFalse(_baseline_path(log).exists())

    def test_launches_in_the_same_second_get_distinct_logs(self):
        for kind in ("produce_resume", "produce_recover"):
            with self.subTest(kind):
                w = World()
                try:
                    w.start("single", "deepseek", "a")
                    w.tick()
                    b = w.row("deepseek", "a")
                    first = Path(b["log_file"])
                    first.write_text("earlier run\n")
                    first.with_suffix(".exit").write_text("0")
                    w.sup._launch(w.sup.store.batch(b["id"]), kind)    # the clock has not moved
                    second = Path(w.sup.store.batch(b["id"])["log_file"])
                    self.assertNotEqual(first, second)
                    self.assertEqual(first.read_text(), "earlier run\n")
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
