"""Codex `exec --json` events in the readable log; Raw Log stays untouched and other agents do not regress."""
import json
import unittest

from warroom.logrender import render_line


def line(**e):
    return json.dumps(e, ensure_ascii=False)


def item(phase, **it):
    return line(type=f"item.{phase}", item=it)


def cmd(phase, **kw):
    return item(phase, id="i1", type="command_execution", command="git status", aggregated_output="",
                exit_code=None, status="in_progress", **kw)


class CodexReadable(unittest.TestCase):
    def test_event_table(self):
        cases = [
            (line(type="thread.started", thread_id="T1"), ["── session T1 ──"]),
            (line(type="turn.started"), ["── turn 시작 ──"]),
            (line(type="turn.completed", usage={"input_tokens": 1}), ["■ turn 완료"]),
            (line(type="turn.failed", error={"message": "provider down"}), ["✖ turn 실패: provider down"]),
            (line(type="error", message="stream broke"), ["✖ ERROR: stream broke"]),
            (item("completed", id="m", type="agent_message", text="done\nsecond"), ["● done", "  second"]),
            (item("started", id="m", type="agent_message", text="partial"), []),
            (item("updated", id="m", type="agent_message", text="partial"), []),
            (item("completed", id="r", type="reasoning", text="**Plan**"), ["… **Plan**"]),
            (cmd("started"), ["▸ command", "  $ git status"]),
            (cmd("updated"), []),
            (item("completed", id="i1", type="command_execution", command="git status", aggregated_output="clean\nok",
                  exit_code=0, status="completed"), ["▸ command", "  $ git status", "  exit=0", "  → clean", "    ok"]),
            (item("completed", id="i1", type="command_execution", command="false", aggregated_output="boom",
                  exit_code=2, status="failed"), ["▸ command", "  $ false", "✖ command failed (exit=2)", "  → boom"]),
            (item("completed", id="i1", type="command_execution", command="rm -rf x", aggregated_output="",
                  exit_code=None, status="declined"), ["▸ command", "  $ rm -rf x", "✖ command declined (정책/승인 거부)"]),
            (item("completed", id="f", type="file_change", status="completed",
                  changes=[{"path": "a.py", "kind": "update"}, {"path": "b.py", "kind": "add"}]),
             ["▸ file_change", "  update a.py", "  add b.py"]),
            (item("completed", id="f", type="file_change", status="failed", changes=[{"path": "a.py", "kind": "update"}]),
             ["✖ file_change failed", "  update a.py"]),
            (item("completed", id="t", type="mcp_tool_call", server="s", tool="t", arguments={"a": 1}, status="failed",
                  error={"message": "nope"}), ["▸ s.t", '  {"a": 1}', "  ✖ nope"]),
            (item("completed", id="w", type="web_search", query="q"), ["▸ web_search q"]),
            (item("completed", id="d", type="todo_list", items=[{"text": "a", "completed": True}, {"text": "b", "completed": False}]),
             ["▸ todo", "  [x] a", "  [ ] b"]),
        ]
        for raw, want in cases:
            self.assertEqual(render_line(raw), want, raw)

    def test_mcp_tool_call_real_shape(self):
        base = dict(id="item_4", type="mcp_tool_call", server="codex_apps", tool="github.fetch_issue",
                    arguments={"issue_number": 860}, error=None)
        self.assertEqual(render_line(item("started", result=None, status="in_progress", **base)), [])
        done = render_line(item("completed", status="completed", **base,
                                result={"content": [{"type": "text", "text": "Action completed."}]}))
        self.assertEqual(done, ["▸ codex_apps.github.fetch_issue", '  {"issue_number": 860}', "  → Action completed."])
        big = render_line(item("completed", status="completed", **base,
                               result={"content": [{"type": "text", "text": "x" * 14000}]}))
        self.assertLess(sum(map(len, big)), 2000)
        self.assertNotIn("? ", "".join(big))

    def test_started_then_completed_shows_the_command_once(self):
        def done(**kw):
            return item("completed", id="i1", type="command_execution", command="git status",
                        aggregated_output="x", **kw)
        for kw in ({"exit_code": 0, "status": "completed"}, {"exit_code": 2, "status": "failed"},
                   {"exit_code": None, "status": "declined"}):
            seen: set = set()
            shown = [l for raw in (cmd("started"), cmd("updated"), done(**kw)) for l in render_line(raw, seen)]
            self.assertEqual(sum(l.startswith("  $ ") for l in shown), 1, kw)
            self.assertEqual(shown[:2], ["▸ command", "  $ git status"], kw)
            self.assertEqual(seen, set(), kw)

    def test_completed_without_seen_start_still_shows_the_command(self):
        for kw in ({"exit_code": 0, "status": "completed"}, {"exit_code": 2, "status": "failed"},
                   {"exit_code": None, "status": "declined"}):
            out = render_line(item("completed", id="i9", type="command_execution", command="git status",
                                   aggregated_output="", **kw), set())
            self.assertEqual(out[:2], ["▸ command", "  $ git status"], kw)

    def test_interleaved_items_are_tracked_by_id(self):
        seen: set = set()
        a, b = ("command_execution",) * 2
        render_line(item("started", id="1", type=a, command="one", status="in_progress"), seen)
        render_line(item("started", id="2", type=b, command="two", status="in_progress"), seen)
        out = render_line(item("completed", id="2", type=b, command="two", aggregated_output="", exit_code=0,
                               status="completed"), seen)
        self.assertEqual(out, ["  exit=0"])
        self.assertEqual(seen, {"1"})

    def test_long_command_and_output_are_shortened_with_raw_pointer(self):
        big = "\n".join(f"row {i}" for i in range(100))
        out = render_line(item("completed", id="i", type="command_execution", command=big, aggregated_output=big,
                               exit_code=1, status="failed"))
        self.assertLess(len(out), 35)
        self.assertEqual(sum("Raw Log" in l for l in out), 2)
        started = render_line(item("started", id="i", type="command_execution", command=big, status="in_progress"))
        self.assertIn("Raw Log", started[-1])

    def test_secrets_are_redacted(self):
        out = render_line(item("completed", id="m", type="agent_message", text="token: ghp_" + "a" * 30))
        self.assertNotIn("ghp_a", "".join(out))
        self.assertIn("[REDACTED]", "".join(out))

    def test_unsupported_events_fall_back_without_json_loss(self):
        unknown_item = render_line(item("completed", id="x", type="mystery", v=1))
        self.assertTrue(unknown_item[0].startswith("? completed item mystery:"))
        unknown = render_line(line(type="turn.mystery", a=1))
        self.assertTrue(unknown[0].startswith("? turn.mystery:"))
        self.assertEqual(render_line(line(type="item.completed", item="bad"))[0][:2], "? ")

    def test_other_agents_unchanged(self):
        self.assertEqual(render_line(line(type="result", subtype="success", is_error=False)), ["■ result: success"])
        self.assertEqual(render_line(line(type="text", part={"text": "hi"})), ["● hi"])
        self.assertEqual(render_line(line(type="error", error={"name": "E", "data": {"message": "m"}})), ["✖ ERROR: E — m"])


if __name__ == "__main__":
    unittest.main()
