"""Issue #2033 (PR 1): per-run usage measurement, unknown-not-zero, no double counting, optional pricing."""
import json
import tempfile
import unittest
from pathlib import Path

from warroom.config import DEFAULTS, config_problem
from warroom.store import Store
from warroom.usage import estimate_cost, parse_usage, pricing_problems, sum_usage
from warroom.views import usage_text

SUBMIT = "node scripts/relation/literary-context-cli.mjs submit --file x.json"


def jl(*events) -> str:
    return "".join(json.dumps(e) + "\n" for e in events)


def codex_usage(inp=1000, cached=600, write=0, out=200, reason=50):
    return {"type": "turn.completed", "usage": {"input_tokens": inp, "cached_input_tokens": cached,
            "cache_write_input_tokens": write, "output_tokens": out, "reasoning_output_tokens": reason}}


def cmd(i, command, code=0):
    return {"type": "item.completed", "item": {"id": f"item_{i}", "type": "command_execution", "command": command,
            "exit_code": code, "status": "completed" if code == 0 else "failed"}}


def claude_result(fresh=30, read=800, write=100, out=500, think=40, **extra):
    u = {"input_tokens": fresh, "cache_read_input_tokens": read, "cache_creation_input_tokens": write,
         "output_tokens": out, "output_tokens_details": {"thinking_tokens": think}}
    u.update(extra)
    return {"type": "result", "subtype": "success", "session_id": "s", "usage": u}


def claude_bash(tid, command):
    return {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": tid, "name": "Bash",
                                                          "input": {"command": command}}]}}


def claude_res(tid, error):
    return {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "is_error": error,
                                                     "content": "x"}]}}


class UsageParsing(unittest.TestCase):
    def parse(self, text):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "run.log"
            p.write_text(text, encoding="utf-8")
            return parse_usage(p)

    def test_table(self):
        none5 = dict(input_tokens=None, cached_input_tokens=None, cache_write_tokens=None, output_tokens=None,
                     reasoning_output_tokens=None)
        cases = [
            ("codex normal: reasoning stays a subset of output",
             jl({"type": "thread.started", "thread_id": "t"}, cmd(1, "ls"), cmd(2, SUBMIT, 1), cmd(3, SUBMIT, 0),
                codex_usage()),
             dict(input_tokens=1000, cached_input_tokens=600, cache_write_tokens=0, output_tokens=200,
                  reasoning_output_tokens=50, tool_calls=3, submit_failures=1)),
            ("codex non-error output with non-zero exit of other command is not a submit failure",
             jl({"type": "turn.started"}, cmd(1, "rg foo", 1), codex_usage()),
             dict(input_tokens=1000, cached_input_tokens=600, cache_write_tokens=0, output_tokens=200,
                  reasoning_output_tokens=50, tool_calls=1, submit_failures=0)),
            ("codex duplicate item event counted once",
             jl({"type": "turn.started"}, cmd(1, SUBMIT, 1), cmd(1, SUBMIT, 1), codex_usage()),
             dict(input_tokens=1000, cached_input_tokens=600, cache_write_tokens=0, output_tokens=200,
                  reasoning_output_tokens=50, tool_calls=1, submit_failures=1)),
            ("codex killed before turn.completed: tokens unknown, calls still counted",
             jl({"type": "turn.started"}, cmd(1, "ls")),
             dict(none5, tool_calls=1, submit_failures=0)),
            ("codex usage missing fields: unknown, not 0",
             jl({"type": "turn.started"}, {"type": "turn.completed", "usage": {"input_tokens": 5}}),
             dict(none5, tool_calls=0, submit_failures=0)),
            ("codex reasoning larger than output is contradictory -> unknown",
             jl({"type": "turn.started"}, codex_usage(out=10, reason=50)),
             dict(none5, tool_calls=0, submit_failures=0)),
            ("codex two turns in one log are summed",
             jl({"type": "turn.started"}, codex_usage(), codex_usage()),
             dict(input_tokens=2000, cached_input_tokens=1200, cache_write_tokens=0, output_tokens=400,
                  reasoning_output_tokens=100, tool_calls=0, submit_failures=0)),
            ("claude normal: input folds in cache read + write; thinking is a subset of output",
             jl({"type": "system", "subtype": "init", "session_id": "s"}, claude_bash("a", "ls"),
                claude_res("a", False), claude_bash("b", SUBMIT), claude_res("b", True), claude_bash("c", SUBMIT),
                claude_res("c", False), claude_result()),
             dict(input_tokens=930, cached_input_tokens=800, cache_write_tokens=100, output_tokens=500,
                  reasoning_output_tokens=40, tool_calls=3, submit_failures=1)),
            ("claude error result of a non-submit command is not a submit failure",
             jl({"type": "system", "subtype": "init", "session_id": "s"}, claude_bash("a", "rg x"),
                claude_res("a", True), claude_result()),
             dict(input_tokens=930, cached_input_tokens=800, cache_write_tokens=100, output_tokens=500,
                  reasoning_output_tokens=40, tool_calls=1, submit_failures=0)),
            ("claude usage without cache fields: input unknown, output kept",
             jl({"type": "system", "subtype": "init", "session_id": "s"},
                {"type": "result", "session_id": "s", "usage": {"input_tokens": 3, "output_tokens": 4}}),
             dict(none5, output_tokens=4, tool_calls=0, submit_failures=0)),
            ("claude cache creation missing: total input unknown, read kept",
             jl({"type": "system", "subtype": "init", "session_id": "s"},
                {"type": "result", "session_id": "s", "usage": {"input_tokens": 30, "cache_read_input_tokens": 800,
                                                                  "output_tokens": 4}}),
             dict(none5, cached_input_tokens=800, output_tokens=4, tool_calls=0, submit_failures=0)),
            ("claude cache read missing: total input unknown, creation kept",
             jl({"type": "system", "subtype": "init", "session_id": "s"},
                {"type": "result", "session_id": "s", "usage": {"input_tokens": 30, "cache_creation_input_tokens": 100,
                                                                  "output_tokens": 4}}),
             dict(none5, cache_write_tokens=100, output_tokens=4, tool_calls=0, submit_failures=0)),
            ("claude no result (cut off): tokens unknown",
             jl({"type": "system", "subtype": "init", "session_id": "s"}, claude_bash("a", "ls")),
             dict(none5, tool_calls=1, submit_failures=0)),
            ("claude thinking tokens absent: reasoning unknown only",
             jl({"type": "system", "subtype": "init", "session_id": "s"},
                {"type": "result", "session_id": "s", "usage": {"input_tokens": 1, "cache_read_input_tokens": 2,
                                                                  "cache_creation_input_tokens": 3, "output_tokens": 4}}),
             dict(input_tokens=6, cached_input_tokens=2, cache_write_tokens=3, output_tokens=4,
                  reasoning_output_tokens=None, tool_calls=0, submit_failures=0)),
            ("opencode / unrecognised stream: everything unknown", jl({"type": "step_finish", "part": {}}), None),
            ("garbage lines are skipped", "not json\n{broken\n" + jl(codex_usage()),
             dict(input_tokens=1000, cached_input_tokens=600, cache_write_tokens=0, output_tokens=200,
                  reasoning_output_tokens=50, tool_calls=0, submit_failures=0)),
        ]
        for name, text, want in cases:
            with self.subTest(name):
                self.assertEqual(self.parse(text), want)

    def test_missing_log_is_unknown(self):
        self.assertIsNone(parse_usage("/nonexistent/run.log"))


class StoreRecordsUsage(unittest.TestCase):
    def test_finish_runs_records_each_run_only_from_its_own_log(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            store = Store(d / "w.db")
            first, resumed, opencode = d / "1.log", d / "2.log", d / "3.log"
            first.write_text(jl({"type": "turn.started"}, cmd(1, SUBMIT, 2), codex_usage(inp=100, cached=60, out=20, reason=5)))
            resumed.write_text(jl({"type": "turn.started"}, cmd(1, "ls"), codex_usage(inp=300, cached=250, out=30, reason=9)))
            opencode.write_text(jl({"type": "step_finish"}))
            b = 7
            ids = []
            for log in (first, resumed):
                ids.append(store.add_run(b, "c", None, 1, log, d / "x.exit"))
                store.finish_runs(b, 0)
            ids.append(store.add_run(8, "c", None, 1, opencode, d / "x.exit"))
            store.finish_runs(8, 0)
            ids.append(store.add_run(9, "c", None, 1, d / "missing.log", d / "x.exit"))
            store.finish_runs(9, None)
            r1, r2 = (store.runs(b)[1], store.runs(b)[0])
            self.assertEqual((r1["input_tokens"], r1["submit_failures"], r1["tool_calls"]), (100, 1, 1))
            self.assertEqual((r2["input_tokens"], r2["submit_failures"], r2["tool_calls"]), (300, 0, 1))
            total = sum_usage(store.runs(b))
            self.assertEqual((total["input_tokens"], total["output_tokens"], total["reasoning_output_tokens"]),
                             (400, 50, 14))
            self.assertEqual(total["partial"], [])
            for batch in (8, 9):   # unmeasured stays NULL, never 0
                run = store.runs(batch)[0]
                self.assertTrue(all(run[k] is None for k in ("input_tokens", "tool_calls", "submit_failures")))
            # closing again does not re-measure or overwrite a finished run
            first.write_text("")
            store.finish_runs(b, 0)
            self.assertEqual(store.runs(b)[1]["input_tokens"], 100)

    def test_old_database_gains_nullable_columns(self):
        import sqlite3
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "old.db"
            Store(db)
            con = sqlite3.connect(db)
            con.execute("INSERT INTO runs(batch_id,kind,started_at) VALUES(1,'c',1.0)")
            con.commit()
            con.close()
            run = Store(db).runs(1)[0]
            self.assertIsNone(run["input_tokens"])
            self.assertIsNone(run["submit_failures"])


class Totals(unittest.TestCase):
    def row(self, **kw):
        base = dict(input_tokens=None, cached_input_tokens=None, cache_write_tokens=None, output_tokens=None,
                    reasoning_output_tokens=None, tool_calls=None, submit_failures=None)
        base.update(kw)
        return base

    def test_partial_and_unknown_totals(self):
        a = self.row(input_tokens=10, output_tokens=2, tool_calls=1)
        b = self.row()
        t = sum_usage([a, b])
        self.assertEqual((t["input_tokens"], t["cached_input_tokens"]), (10, None))
        self.assertIn("input_tokens", t["partial"])
        self.assertNotIn("cached_input_tokens", t["partial"])
        self.assertIsNone(sum_usage([b])["input_tokens"])

    def test_cost_table(self):
        price = {"input": 1.0, "cached_input": 0.1, "cache_write": 2.0, "output": 10.0}
        base = dict(input_tokens=2_000_000, cached_input_tokens=1_000_000, cache_write_tokens=0, output_tokens=100_000,
                    partial=[])
        cases = [
            ("priced", base, price, 1.0 + 0.1 + 1.0),
            ("write rate not needed when no writes", base, {k: v for k, v in price.items() if k != "cache_write"}, 2.1),
            ("needed rate missing -> unknown", base, {"input": 1.0, "output": 10.0}, None),
            ("no pricing -> unknown, never 0", base, None, None),
            ("negative rate -> unknown", base, dict(price, output=-1), None),
            ("unknown tokens -> unknown", dict(base, output_tokens=None), price, None),
            ("claude partial cache fields -> input unknown -> cost unknown", dict(base, input_tokens=None), price, None),
            ("cache split unknown -> unknown", dict(base, cached_input_tokens=None), price, None),
            ("partial totals -> unknown", dict(base, partial=["input_tokens"]), price, None),
        ]
        for name, usage, pricing, want in cases:
            with self.subTest(name):
                got = estimate_cost(usage, pricing)
                if want is None:
                    self.assertIsNone(got)
                else:
                    self.assertAlmostEqual(got, want)

    def test_usage_text_shows_unknown_and_incomplete(self):
        runs = [dict(self.row(input_tokens=10, output_tokens=2, tool_calls=1, submit_failures=0),
                     started_at=0.0, ended_at=60.0), dict(self.row(), started_at=60.0, ended_at=90.0)]
        text = usage_text(runs, None, now=100.0)
        self.assertIn("unknown", text)
        self.assertIn("불완전", text)
        self.assertNotIn("$", text)


class PricingConfig(unittest.TestCase):
    def test_validation_table(self):
        cases = [
            (None, False), ({}, False),
            ({"m": {"input": 1, "cached_input": 0.1, "cache_write": 1.25, "output": 5}}, False),
            ({"m": {"input": -1}}, True), ({"m": {"input": "1"}}, True), ({"m": {"cache_read": 1}}, True),
            ({"m": 5}, True), ([], True), ({"m": {"input": True}}, True),
        ]
        for pricing, bad in cases:
            with self.subTest(pricing=pricing):
                self.assertEqual(bool(pricing_problems(pricing)), bad)

    def test_bad_pricing_blocks_config(self):
        cfg = json.loads(json.dumps(DEFAULTS))
        self.assertIsNone(config_problem(cfg))
        cfg["pricing"] = {"m": {"output": "x"}}
        self.assertIn("pricing", config_problem(cfg) or "")

    def test_example_config_has_no_invented_prices(self):
        ex = json.loads((Path(__file__).resolve().parents[1] / "config.example.json").read_text("utf-8"))
        self.assertEqual(ex.get("pricing"), {})


if __name__ == "__main__":
    unittest.main()
