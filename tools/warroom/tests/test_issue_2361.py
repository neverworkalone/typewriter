"""Issue #2361: aggregate OpenCode step_finish deltas without overstating log completeness."""
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from warroom.logrender import render_line
from warroom.store import Store
from warroom.usage import parse_usage, sum_usage
from warroom.views import usage_text


def jl(*events):
    return "".join(json.dumps(event) + "\n" for event in events)


def step_start(index):
    return {"type": "step_start", "sessionID": "ses_1", "part": {
        "id": f"prt_start_{index}", "sessionID": "ses_1", "messageID": f"msg_{index}", "type": "step-start"}}


def step_finish(index, tokens, *, part_id=None):
    return {"type": "step_finish", "sessionID": "ses_1", "part": {
        "id": part_id or f"prt_finish_{index}", "sessionID": "ses_1", "messageID": f"msg_{index}",
        "type": "step-finish", "reason": "stop", "tokens": tokens}}


def opencode_tool(call_id="call_1", command="node scripts/relation/literary-context-cli.mjs submit --file x.json"):
    return {"type": "tool_use", "sessionID": "ses_1", "part": {
        "id": "prt_tool_1", "sessionID": "ses_1", "messageID": "msg_1", "type": "tool",
        "callID": call_id, "tool": "bash", "state": {
            "status": "completed", "input": {"command": command}, "metadata": {"exit": 1}}}}


class OpenCodeUsage(unittest.TestCase):
    def parse(self, text):
        with tempfile.TemporaryDirectory() as directory:
            log = Path(directory) / "run.jsonl"
            log.write_text(text, encoding="utf-8")
            return parse_usage(log)

    def test_sums_step_deltas_and_deduplicates_part_and_tool_ids(self):
        first = step_finish(1, {"total": 90000, "input": 11, "output": 8, "reasoning": 3,
                                "cache": {"read": 101, "write": 2}})
        second = step_finish(2, {"total": 90000, "input": 13, "output": 9, "reasoning": 4,
                                 "cache": {"read": 103, "write": 0}})
        tool = opencode_tool()
        result = self.parse(jl(step_start(1), first, first, step_start(2), second, tool, tool))
        self.assertEqual(result, {
            "input_tokens": 230, "cached_input_tokens": 204, "cache_write_tokens": 2,
            "output_tokens": 17, "reasoning_output_tokens": 7, "tool_calls": 1,
            "submit_failures": 1, "usage_quality": "best_effort",
        })

    def test_missing_invalid_and_contradictory_fields_stay_unknown(self):
        missing_write = self.parse(jl(step_start(1), step_finish(1, {
            "input": 5, "output": 8, "reasoning": 2, "cache": {"read": 1},
        })))
        self.assertEqual(missing_write["input_tokens"], None)
        self.assertEqual(missing_write["cached_input_tokens"], 1)
        self.assertIsNone(missing_write["cache_write_tokens"])
        self.assertEqual((missing_write["output_tokens"], missing_write["reasoning_output_tokens"]), (8, 2))

        invalid = self.parse(jl(step_start(1), step_finish(1, {
            "input": -1, "output": 4, "reasoning": 5, "cache": {"read": True, "write": -2},
        })))
        self.assertTrue(all(invalid[key] is None for key in (
            "input_tokens", "cached_input_tokens", "cache_write_tokens", "output_tokens",
            "reasoning_output_tokens")))
        self.assertEqual(invalid["usage_quality"], "best_effort")

    def test_unmatched_start_or_trailing_partial_json_marks_lower_bound(self):
        result = self.parse(jl(step_start(1), {"type": "text", "part": {"text": "partial answer"}}))
        self.assertEqual(result["usage_quality"], "incomplete")
        self.assertIsNone(result["input_tokens"])
        self.assertIsNone(result["tool_calls"])

        result = self.parse(jl(step_start(1), step_finish(1, {
            "input": 5, "output": 2, "reasoning": 0, "cache": {"read": 0, "write": 0},
        })) + '{"type":"text"')
        self.assertEqual(result["usage_quality"], "incomplete")
        self.assertEqual((result["input_tokens"], result["output_tokens"]), (5, 2))

    def test_tool_call_without_stable_identity_is_unknown(self):
        unidentifiable = {"type": "tool_use", "part": {"type": "tool", "tool": "bash", "state": {}}}
        result = self.parse(jl(step_start(1), step_finish(1, {
            "input": 0, "output": 0, "reasoning": 0, "cache": {"read": 0, "write": 0},
        }), unidentifiable))
        self.assertIsNone(result["tool_calls"])
        self.assertIsNone(result["submit_failures"])

    def test_finish_runs_persist_per_run_quality_and_view_warns(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = Store(root / "warroom.db")
            complete = root / "complete.jsonl"
            resumed = root / "resumed.jsonl"
            incomplete = root / "incomplete.jsonl"
            complete.write_text(jl(
                step_start(1), step_finish(1, {"input": 5, "output": 2, "reasoning": 1,
                                                "cache": {"read": 3, "write": 0}}),
            ), encoding="utf-8")
            resumed.write_text(jl(
                step_start(1), step_finish(1, {"input": 7, "output": 4, "reasoning": 2,
                                                "cache": {"read": 1, "write": 0}}),
            ), encoding="utf-8")
            incomplete.write_text(jl(step_start(2), {"type": "text", "part": {"text": "partial"}}),
                                  encoding="utf-8")

            for log in (complete, resumed, incomplete):
                store.add_run(1, "opencode", None, 1, log, root / "run.exit")
                store.finish_runs(1, 0)

            runs = store.runs(1)
            self.assertEqual({run["usage_quality"] for run in runs}, {"best_effort", "incomplete"})
            total = sum_usage(runs)
            self.assertEqual((total["input_tokens"], total["output_tokens"]), (16, 6))
            self.assertEqual((total["best_effort_runs"], total["incomplete_runs"]), (3, 1))
            text = usage_text(runs, {"opencode-model": {"input": 1, "cached_input": 0.1,
                                                              "cache_write": 1, "output": 2}}, now=10)
            self.assertIn("관측 토큰은 하한", text)
            self.assertIn("1/3개", text)

    def test_step_finish_log_render_shows_observed_usage_not_total(self):
        event = step_finish(1, {"total": 9999, "input": 5, "output": 3, "reasoning": 1,
                                "cache": {"read": 2, "write": 1}})
        rendered = "\n".join(render_line(json.dumps(event)))
        self.assertIn("input 8 (fresh 5, cache 2/1)", rendered)
        self.assertIn("output 3 (reasoning subset 1)", rendered)
        self.assertNotIn("9999", rendered)

    def test_existing_v11_database_migrates_without_remeasuring_old_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory) / "warroom.db"
            store = Store(db)
            store.add_run(1, "opencode", None, 1, "old.log", "old.exit")
            with sqlite3.connect(db) as conn:
                conn.execute("ALTER TABLE runs DROP COLUMN usage_quality")
                conn.execute("PRAGMA user_version=11")

            migrated = Store(db)
            run = migrated.runs(1)[0]
            self.assertIsNone(run["usage_quality"])
            self.assertIsNone(run["input_tokens"])
