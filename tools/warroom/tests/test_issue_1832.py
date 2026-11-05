"""Issue #1832 regression: Stage 2 decisions with denied tools still use deterministic finalization."""
import unittest
from unittest import mock
from pathlib import Path

from warroom.gitops import Git
from warroom.shell import Result

from tests.fakes import FakeAdapter, World
from tests.test_issue_1684 import S2, s2_world as base_s2_world
from tests.test_claude_adapter import init, result, stream
from warroom import control
from warroom.adapters import ClaudeCodeAdapter, ProcessAdapter

BASH = [{"tool_name": "Bash", "tool_input": {"command": "gh pr create --fill"}}]
CHUNK = "001-01-01-001"


def answer(text):
    import json
    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n"


class Reporting(FakeAdapter):
    run_problem = ClaudeCodeAdapter.run_problem
    completion_problem = ClaudeCodeAdapter.completion_problem
    denied_actions = ClaudeCodeAdapter.denied_actions
    requires_session_for_pr = ClaudeCodeAdapter.requires_session_for_pr
    requires_final_result_for_pr = ClaudeCodeAdapter.requires_final_result_for_pr
    session_id = ProcessAdapter.session_id


def final(denials=BASH, **kw):
    answer_text = f"chunk {CHUNK}\nc1 D first\nc2 D second"
    return stream(init("claude-x"), result(denials=denials, **kw) | {"result": answer_text})


class DeterministicStage2Completion(unittest.TestCase):
    def setUp(self):
        self.w = w = base_s2_world(self)
        w.git.chunk_view_total = 2
        w.adapter = Reporting()
        w.sup.adapter = w.adapter
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.adapter.plan.append({"code": 0, "text": final()})
        w.tick()

    def test_permission_denial_does_not_trigger_an_ai_finalizer(self):
        w = self.w
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["run_kind"], len(w.adapter.launches)), ("s2_chunk_new", 1))
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual((b["state"], b["run_kind"]), ("WAITING_REVIEW", "s2_deterministic_finalize"))
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(len(w.git.commits), 1)
        self.assertEqual(w.git.pushes, [b["branch"]])
        self.assertEqual(len(w.gh.created_prs), 1)
        # The PR-owned gate reuses the verification from this successful finalization.
        self.assertEqual(w.git.exact_verify_calls, [("f" * 40, "001", "01", "01")])


    def test_successful_verify_timing_reaches_finalization_log(self):
        w = self.w
        timing = 'verify_timing {"stages":[{"stage":"total","elapsed_ms":12,"status":"success"}]}'
        runner = mock.Mock()
        runner.run.return_value = Result(0, '{"ok":true,"counts":{"missing":0}}\n', timing + "\n")
        git = Git(runner, Path("."), {}, Path("."))
        with mock.patch.object(w.git, "verify_stage2_local", side_effect=git.verify_stage2_local), \
             mock.patch.object(w.store, "log", wraps=w.store.log) as log:
            w.adapter.finish(w.adapter.launches[-1]["pid"])
            w.tick()
        self.assertTrue(any(timing in str(call) for call in log.call_args_list))

    def test_verify_failure_preserves_stdout_diagnostic_in_finalization(self):
        w = self.w
        runner = mock.Mock()
        runner.run.return_value = Result(2, '{"ok":false,"family":"accounting","errors":["missing candidate"]}\n',
                                         'verify_timing {"stages":[{"stage":"accounting","status":"failed"}]}\n')
        git = Git(runner, Path("."), {}, Path("."))
        with mock.patch.object(w.git, "verify_stage2_local", side_effect=git.verify_stage2_local):
            w.adapter.finish(w.adapter.launches[-1]["pid"])
            w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertIn("missing candidate", b["error"])

    def test_non_stage2_denial_still_requires_a_clean_owned_pr_at_local_head(self):
        w = base_s2_world(self)
        w.runner.set_batches(canon={1: 1000}, done={})
        w.adapter.plan.append({"code": 0, "session": "ses_a"})
        control.start(w.store, "claude", "a", "single", cfg=w.cfg)
        w.tick()
        b = w.store.active_batch("claude", "a")
        self.assertIsNotNone(b)
        head = "c" * 40
        w.git.local_head = head
        w.git.remote[b["branch"]] = head
        w.gh.git = w.git
        w.gh.created_prs = []
        w.gh._register(b["branch"], "test", "", [])
        b = w.store.batch(b["id"])
        self.assertIsNone(w.sup._denied_run_problem(b))
        w.git.dirty_text = " M README.md\n"
        self.assertIn("미커밋 변경", w.sup._denied_run_problem(b))
        w.git.dirty_text = ""
        w.git.local_head = "d" * 40
        self.assertIn("HEAD가 다릅니다", w.sup._denied_run_problem(b))


if __name__ == "__main__":
    unittest.main()
