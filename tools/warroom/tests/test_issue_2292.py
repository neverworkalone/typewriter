"""#2292: an exact Codex prompt-policy refusal skips only its empty new A/B chunk."""
import json
import unittest
from pathlib import Path

from tests.test_issue_2035 import ABWorld
from warroom import control, stage1ab
from warroom.adapters import CodexCLIAdapter

REFUSAL = "Invalid prompt: your prompt was flagged as potentially violating our usage policy."
THREAD = "01a15e50-8832-7502-9680-0e4fdbf5fcb0"


def event_lines(*events):
    return "".join(json.dumps(event) + "\n" for event in events)


def refusal_events(answer=None):
    events = [{"type": "thread.started", "thread_id": THREAD}]
    if answer is not None:
        events.append({"type": "item.completed", "item": {"type": "agent_message", "text": answer}})
    events.append({"type": "turn.failed", "error": {"message": REFUSAL}})
    return event_lines(*events)


class PolicySkip(unittest.TestCase):
    def world(self, method="a", records=120):
        w = ABWorld(records=records, method=method)
        self.addCleanup(w.tmp.cleanup)
        w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-6-luna", "effort": "xhigh"}}
        w.adapter.confirmed_prompt_refusal = CodexCLIAdapter().confirmed_prompt_refusal
        return w

    def launch_refusal(self, w, method, code=0, answer=None):
        w.start("single", "codex", method)
        w.adapter.plan.append({"code": code, "session": THREAD, "text": refusal_events(answer)})
        w.tick()
        b = w.row("codex", method)
        pid = w.adapter.launches[-1]["pid"]
        log = Path(b["log_file"])
        # A terminal event can appear just before the CLI process exits. It must wait for exit, not enter generic failure.
        log.write_text(event_lines({"sessionID": THREAD}, {"type": "thread.started", "thread_id": THREAD},
                                   {"type": "turn.failed", "error": {"message": REFUSAL}}), "utf-8")
        w.tick()
        self.assertEqual(w.row("codex", method)["state"], "PRODUCING")
        w.adapter.finish(pid)
        w.tick()
        return w.row("codex", method)

    @staticmethod
    def chunk_file(b, number=1):
        return Path(b["worktree"]) / stage1ab.names(b).directory / "candidates" / f"chunk-{number:03d}.jsonl"

    @staticmethod
    def record_ids(b, number=1):
        path = Path(b["worktree"]) / stage1ab.names(b).directory / "source" / f"chunk-{number:03d}.jsonl"
        return [json.loads(line)["id"] for line in path.read_text("utf-8").splitlines()]

    def test_a_and_b_save_empty_chunk_and_start_the_next_chunk_normally(self):
        for method, code in (("a", 0), ("b", 1)):
            with self.subTest(method=method):
                w = self.world(method)
                w.adapter.run_problem = lambda *args, **kwargs: ("ERROR", "generic turn.failed")
                b = self.launch_refusal(w, method, code)

                self.assertEqual((b["state"], b["run_kind"], len(w.adapter.launches)),
                                 ("PRODUCING", "ab_chunk_new", 2))
                first, second = w.adapter.launches
                self.assertIn("w0001-s1", first["prompt"])
                self.assertIn("w0051-s1", second["prompt"])
                self.assertNotIn("w0001-s1", second["prompt"])
                rows = [json.loads(line) for line in self.chunk_file(b).read_text("utf-8").splitlines()]
                self.assertEqual([row["record_id"] for row in rows], self.record_ids(b))
                self.assertTrue(all(not sense["candidates"] for row in rows for sense in row["senses"]))

                request = w.store.issue_request(f"ab-policy-skip:001:01:{method}:codex:001")
                ids = self.record_ids(b)
                self.assertEqual(request["title"], f"[Policy Skip][{method.upper()}/codex] 001_01 Chunk 001")
                self.assertEqual(request["body"], "\n".join(ids))
                self.assertNotIn("뜻 ", request["body"])
                self.assertNotIn("Invalid prompt", request["body"])
                issue = w.gh.issues[request["issue_number"]]
                self.assertEqual((issue["body"], issue["labels"]), ("\n".join(ids), []))

                # The next Chunk gets its own ordinary answer and is accepted through the existing save path.
                w.adapter.run_problem = lambda *args, **kwargs: None
                next_pid = second["pid"]
                next_answer = w.block(2)
                w.adapter.running[next_pid]["text"] = event_lines(
                    {"type": "thread.started", "thread_id": THREAD},
                    {"type": "item.completed", "item": {"type": "agent_message", "text": next_answer}},
                    {"type": "turn.completed"},
                )
                w.adapter.finish(next_pid)
                w.tick()
                saved = [json.loads(line) for line in self.chunk_file(w.row("codex", method), 2).read_text("utf-8").splitlines()]
                self.assertTrue(any(sense["candidates"] for row in saved for sense in row["senses"]))

    def test_complete_response_survives_a_failed_terminal_event(self):
        w = self.world()
        complete = w.block(1)
        b = self.launch_refusal(w, "a", code=0, answer=complete)

        rows = [json.loads(line) for line in self.chunk_file(b).read_text("utf-8").splitlines()]
        self.assertEqual(rows[0]["senses"][0]["candidates"], ["후보1-1"])
        self.assertEqual(w.store.issue_requests(), [])
        self.assertEqual(len(w.adapter.launches), 2)

    def test_restart_recovers_after_issue_persist_and_after_chunk_save_without_relaunching(self):
        w = self.world()
        w.start("single", "codex", "a")
        w.adapter.plan.append({"code": 0, "session": THREAD, "text": refusal_events()})
        w.tick()
        first_pid = w.adapter.launches[-1]["pid"]
        w.adapter.finish(first_pid)

        original_save = stage1ab.save

        def crash_before_save(*args, **kwargs):
            raise SystemExit("simulated process exit after durable Issue request")

        stage1ab.save = crash_before_save
        try:
            with self.assertRaises(SystemExit):
                w.tick()
        finally:
            stage1ab.save = original_save
        self.assertEqual(len(w.store.issue_requests()), 1)
        self.assertFalse(self.chunk_file(w.row("codex", "a")).exists())

        w.sup = w.make_sup()
        w.sup._ab_accept = lambda *args, **kwargs: (_ for _ in ()).throw(SystemExit("simulated exit after save"))
        with self.assertRaises(SystemExit):
            w.tick()
        self.assertTrue(self.chunk_file(w.row("codex", "a")).is_file())

        # Saved evidence wins on restart. Acceptance clears the old run and launches Chunk 002 without another Issue.
        w.sup = w.make_sup()
        w.tick()
        b = w.row("codex", "a")
        self.assertEqual((len(w.adapter.launches), b["run_kind"]), (2, "ab_chunk_new"))
        request = w.store.issue_requests()[0]
        self.assertEqual(request["event_key"], "ab-policy-skip:001:01:a:codex:001")
        self.assertEqual(w.gh.created, [101])
        rows = [json.loads(line) for line in self.chunk_file(b).read_text("utf-8").splitlines()]
        self.assertTrue(all(not sense["candidates"] for row in rows for sense in row["senses"]))

    def test_request_persistence_failure_holds_chunk_and_retry_reuses_failure_log(self):
        w = self.world()
        w.start("single", "codex", "a")
        w.adapter.plan.append({"code": 0, "session": THREAD, "text": refusal_events()})
        w.tick()
        pid = w.adapter.launches[-1]["pid"]
        w.adapter.finish(pid)
        original = w.sup.maint.report_issue
        w.sup.maint.report_issue = lambda *args, **kwargs: (_ for _ in ()).throw(OSError("local database unavailable"))
        w.tick()
        b = w.row("codex", "a")
        self.assertEqual((b["state"], len(w.adapter.launches)), ("ERROR", 1))
        self.assertEqual(w.store.issue_requests(), [])
        self.assertFalse(self.chunk_file(b).exists())

        w.sup.maint.report_issue = original
        self.assertTrue(control.retry(w.store, "codex", "a"))
        w.tick(2)  # the first tick restores PRODUCING; the next resumes the failed run from its refusal event
        b = w.row("codex", "a")
        self.assertEqual((b["state"], len(w.adapter.launches)), ("PRODUCING", 2))
        self.assertEqual(len(w.store.issue_requests()), 1)
        self.assertTrue(self.chunk_file(b).is_file())

    def test_github_publication_failure_keeps_batch_running_and_retries_same_request(self):
        w = self.world()
        w.gh.fail_list = True
        b = self.launch_refusal(w, "a")
        self.assertEqual((b["state"], len(w.adapter.launches)), ("PRODUCING", 2))
        self.assertEqual((w.store.issue_requests()[0]["state"], w.gh.created), ("PENDING", []))

        w.sup = w.make_sup()
        w.gh.fail_list = False
        w.gh.fail_create_lost = True
        w.now += 1
        w.tick()
        self.assertEqual((w.store.issue_requests()[0]["state"], w.gh.created), ("CREATING", [101]))

        w.sup = w.make_sup()
        w.tick()
        request = w.store.issue_requests()[0]
        self.assertEqual((request["state"], w.gh.created), ("PUBLISHED", [101]))
        self.assertEqual(w.gh.issues[101]["body"], request["body"])
        self.assertEqual((len(w.gh.issues), w.row("codex", "a")["state"], len(w.adapter.launches)),
                         (1, "PRODUCING", 2))


if __name__ == "__main__":
    unittest.main()
