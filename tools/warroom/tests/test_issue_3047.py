"""Issue #3047 PR 2: parallel Stage 2 primary tasks - bounded scheduler, single-writer saves, corrections, Stop/Retry.

Fake AI/git: this proves the Supervisor state machine around the Admission task API (whose own contract is covered by
admission-cli.test.mjs), not a real model run.
"""
import json
import unittest
from pathlib import Path

from tests.fakes import FakeAdapter
from tests.test_issue_1684 import S2, s2_world
from warroom.adapters import classify_codex_failure
from warroom import control, stage2
from warroom.config import DEFAULTS, config_problem
from warroom.store import SCHEMA_VERSION, Store

PREFIX = "001-01-01"


def answer(text):
    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n"


def drop_rows(task, count, *, bad=()):
    lines = [f"chunk {task}"]
    lines += [f"c{n} D {'BAD' if n in bad else 'e'}" for n in range(1, count + 1)]
    return "\n".join(lines)


class Helpers:
    def world(self, layout, *, cap=16, target=250):
        w = s2_world(self)
        w.parallel_s2 = True
        w.sup.parallel_new_parts = True
        w.git.task_layout = layout
        w.cfg["stage2_max_parallel"], w.cfg["stage2_chunk_candidates"] = cap, target
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        return w

    def tasks(self, w):
        b = w.store.active_batch("claude", S2)
        return {r["task"]: r for r in w.store.task_rows(b["id"])}

    def respond(self, w, task, text=None, count=None):
        """The task's AI finishes with its answer (default: Drop e for every candidate of the planned task)."""
        b = w.store.active_batch("claude", S2)
        row = w.store.task_row(b["id"], task)
        run = w.store.run(row["run_id"])
        pid = next(launch["pid"] for launch in w.adapter.launches if launch["pid"] and w.adapter.running.get(launch["pid"], {}).get("log") == Path(run["log_file"]))
        planned = next(t for t in stage2.read_plan(b["worktree"])["tasks"] if t["id"] == task)
        w.adapter.running[pid]["text"] = answer(text if text is not None else drop_rows(task, count or planned["candidate_count"]))
        w.adapter.finish(pid)

    def launch(self, w, n=1):
        for _ in range(n):
            w.adapter.plan.append({"code": 0, "session": f"ses_{len(w.adapter.plan)}"})


class ParallelStage2(Helpers, unittest.TestCase):
    def test_five_tasks_start_together_and_save_in_completion_order(self):
        w = self.world([(f"sense-{i}", 240) for i in range(5)])
        self.launch(w, 5)
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["state"], b["run_kind"], b["pid"]), ("PRODUCING", "s2_parallel", None))
        self.assertEqual(len(w.adapter.launches), 5)
        self.assertEqual(w.store.get(stage2.mode_key(b["id"])), "parallel")
        self.assertEqual(len({r["task"] for r in w.store.open_task_runs(b["id"])}), 5)
        order = [f"{PREFIX}-t0{n}" for n in (4, 1, 5, 2, 3)]
        for task in order:
            self.respond(w, task)
            w.tick()
        self.assertEqual(w.git.task_save_calls, order)   # saved one by one as they completed, never two at once
        checkpoint = stage2.checkpoint(b["worktree"], "001", "01-01")
        self.assertEqual((checkpoint["decided"], checkpoint["total"], checkpoint["next_chunk_number"]), (1200, 1200, 6))
        row = w.store.batch(b["id"])
        self.assertEqual(w.store.get(f"s2_plan_{b['id']}"), "closed")
        self.assertEqual((row["state"], row["run_kind"]), ("WAITING_REVIEW", "s2_deterministic_finalize"))
        self.assertEqual(len(w.adapter.launches), 5)   # nothing else ran an AI: finalization is deterministic
        self.assertEqual(w.git.close_plan_calls, [("001", "01", "01")])

    def test_cap_bounds_active_sessions_and_free_slots_refill_immediately(self):
        w = self.world([(f"sense-{i}", 240) for i in range(20)], cap=16)
        self.launch(w, 20)
        w.tick()
        self.assertEqual(len(w.adapter.launches), 16)
        self.respond(w, f"{PREFIX}-t01")
        self.respond(w, f"{PREFIX}-t02")
        w.tick()
        self.assertEqual(len(w.adapter.launches), 18)   # two slots opened, two refilled, no wave barrier
        self.assertEqual(len([t for t in self.tasks(w).values() if t["state"] == "RUNNING"]), 16)

    def test_a_250_record_part_scale_plan_keeps_the_250_candidate_task_size_and_the_16_cap(self):
        # #3385: a 250-record Part holds ~8k-12k candidates, i.e. 30-50 tasks of about 250 candidates; s2parallel is unchanged.
        w = self.world([(f"sense-{i}", 240) for i in range(40)], cap=16, target=250)
        self.launch(w, 40)
        w.tick()
        b = w.store.active_batch("claude", S2)
        tasks = stage2.read_plan(b["worktree"])["tasks"]
        self.assertTrue(30 <= len(tasks) <= 50, len(tasks))
        self.assertTrue(all(t["candidate_count"] <= 500 for t in tasks))
        self.assertEqual(len(w.adapter.launches), 16)   # still the configured concurrency, not the Part size

    def test_cap_one_runs_the_same_plan_sequentially(self):
        w = self.world([(f"sense-{i}", 240) for i in range(3)], cap=1)
        self.launch(w, 3)
        for n in range(1, 4):
            w.tick()
            self.assertEqual(len(w.adapter.launches), n)
            self.respond(w, f"{PREFIX}-t0{n}")
        w.tick()
        self.assertEqual(w.store.batch(w.store.active_batch("claude", S2)["id"])["state"], "WAITING_REVIEW")

    def test_large_sense_chain_waits_for_saved_predecessor_and_gets_slot_priority(self):
        w = self.world([("big", 600), ("small", 100)], cap=2, target=250)
        self.launch(w, 4)
        w.tick()
        tasks = self.tasks(w)
        # big -> t01..t03 (chain), small -> t04. Cap 2: the chain head and the (larger) chain outranks the small one.
        self.assertEqual(sorted(t for t, r in tasks.items() if r["state"] == "RUNNING"), [f"{PREFIX}-t01", f"{PREFIX}-t04"])
        self.assertEqual(tasks[f"{PREFIX}-t02"]["state"], "PENDING")
        self.respond(w, f"{PREFIX}-t01")
        w.tick()
        tasks = self.tasks(w)
        self.assertEqual(tasks[f"{PREFIX}-t01"]["state"], "SAVED")
        self.assertEqual(tasks[f"{PREFIX}-t02"]["state"], "RUNNING")   # the freed slot continues the chain
        self.assertEqual(tasks[f"{PREFIX}-t03"]["state"], "PENDING")   # still waits for t02's save

    def test_rejected_candidate_gets_one_same_session_correction_then_saves(self):
        w = self.world([("s", 3)], target=250)
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.respond(w, task, drop_rows(task, 3, bad=(2,)))
        w.tick()
        row = self.tasks(w)[task]
        self.assertEqual(row["state"], "RUNNING")
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        self.assertIn("c2", w.adapter.launches[-1]["prompt"])
        self.respond(w, task, f"chunk {task}\nc2 D e")
        w.tick()
        self.assertEqual(self.tasks(w)[task]["state"], "SAVED")
        self.assertEqual(len(w.adapter.launches), 2)

    def test_single_residual_candidate_after_the_correction_gets_technical_drop(self):
        w = self.world([("s", 3)], target=250)
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.respond(w, task, drop_rows(task, 3, bad=(2,)))
        w.tick()
        self.respond(w, task, f"chunk {task}\nc2 D BAD")
        w.tick()
        self.assertEqual(self.tasks(w)[task]["state"], "SAVED")
        self.assertEqual([c["alias"] for c in w.git.technical_fallback_calls], ["c2"])
        self.assertEqual(len(w.adapter.launches), 2)   # no further AI run for the fallback

    def test_multiple_residual_candidates_after_the_correction_stop_without_f(self):
        w = self.world([("s", 3)], target=250)
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.respond(w, task, drop_rows(task, 3, bad=(1, 2)))
        w.tick()
        self.respond(w, task, f"chunk {task}\nc1 D BAD\nc2 D BAD")
        w.tick(2)
        b = w.store.active_batch("claude", S2)
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(w.git.technical_fallback_calls, [])
        self.assertEqual(self.tasks(w)[task]["state"], "FAILED")

    def test_failed_task_keeps_other_tasks_saving_then_halts_and_retry_reruns_only_it(self):
        w = self.world([(f"sense-{i}", 10) for i in range(2)], target=10)
        self.launch(w, 3)
        w.tick()
        t1, t2 = f"{PREFIX}-t01", f"{PREFIX}-t02"
        self.respond(w, t1, "no decisions at all")   # no task header: the task re-runs once in a fresh session
        self.respond(w, t2)
        w.tick()
        self.assertEqual(self.tasks(w)[t2]["state"], "SAVED")
        self.assertEqual(len(w.adapter.launches), 3)
        self.respond(w, t1, "still nothing")
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["state"], self.tasks(w)[t1]["state"]), ("ERROR", "FAILED"))
        self.assertEqual(self.tasks(w)[t2]["state"], "SAVED")
        self.launch(w, 1)
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 4)   # only the failed task runs again; SAVED work is not redone
        self.assertEqual(self.tasks(w)[t1]["state"], "RUNNING")

    def test_stop_stops_every_task_and_retry_restarts_only_unsaved_tasks(self):
        w = self.world([(f"sense-{i}", 240) for i in range(3)])
        self.launch(w, 6)
        w.tick()
        t1 = f"{PREFIX}-t01"
        self.respond(w, t1)
        w.tick()   # t01 SAVED
        self.assertEqual(self.tasks(w)[t1]["state"], "SAVED")
        control.stop_line(w.store, "claude", S2)
        w.tick(2)
        b = w.store.active_batch("claude", S2)
        self.assertEqual(b["state"], "PAUSED")
        self.assertEqual(w.adapter.running, {})
        self.assertEqual(w.store.open_task_runs(b["id"]), [])
        launches = len(w.adapter.launches)
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        tasks = self.tasks(w)
        self.assertEqual(tasks[t1]["state"], "SAVED")
        self.assertEqual(len(w.adapter.launches), launches + 2)   # only the two unsaved tasks run again

    def test_restart_keeps_polling_running_tasks_without_new_launches(self):
        w = self.world([(f"sense-{i}", 240) for i in range(2)])
        self.launch(w, 2)
        w.tick()
        w.sup = w.make_sup()   # Supervisor restart: everything is rebuilt from the store and the worktree
        w.sup.parallel_new_parts = True
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 2)
        self.respond(w, f"{PREFIX}-t01")
        self.respond(w, f"{PREFIX}-t02")
        w.sup = w.make_sup()
        w.sup.parallel_new_parts = True
        w.tick()
        self.assertEqual(w.store.get(f"s2_plan_{w.store.active_batch('claude', S2)['id']}"), "closed")

    def test_common_remote_and_pr_lookups_do_not_grow_with_the_task_count(self):
        w = self.world([(f"sense-{i}", 240) for i in range(16)])
        calls = {"remote": 0, "pr": 0}
        remote, pr = w.git.remote_head, w.sup._find_recovery_pr
        w.git.remote_head = lambda *a, **k: (calls.__setitem__("remote", calls["remote"] + 1), remote(*a, **k))[1]
        w.sup._find_recovery_pr = lambda *a, **k: (calls.__setitem__("pr", calls["pr"] + 1), pr(*a, **k))[1]
        self.launch(w, 16)
        w.tick()
        self.assertEqual(len(w.adapter.launches), 16)
        started = dict(calls)
        w.tick()   # a plain waiting tick adds no common remote/PR lookup
        self.assertEqual(calls, started)
        self.assertLessEqual(started["pr"], 1)

    def test_prompt_puts_policy_before_the_task_block_and_the_whole_view_after_it(self):
        w = self.world([("s", 3)])
        self.launch(w, 1)
        w.tick()
        prompt = w.adapter.launches[0]["prompt"]
        task = f"{PREFIX}-t01"
        self.assertLess(prompt.index("답변 형식"), prompt.index("## 이번 task"))
        self.assertLess(prompt.index("## 이번 task"), prompt.index("<<<CHUNK_VIEW_BEGIN>>>"))
        self.assertIn(f"chunk <task ID>", prompt)
        self.assertIn(f"`{task}`", prompt)
        self.assertIn("c3\ts-cand-2", prompt)   # the full view, nothing truncated
        self.assertNotIn("checkpoint 0/", prompt)   # Part-wide progress is left out of the shared prefix


class ParallelStage2Recovery(Helpers, unittest.TestCase):
    def finish_code(self, w, task, code, text):
        b = w.store.active_batch("claude", S2)
        run = w.store.run(w.store.task_row(b["id"], task)["run_id"])
        pid = next(l["pid"] for l in w.adapter.launches if w.adapter.running.get(l["pid"], {}).get("log") == Path(run["log_file"]))
        w.adapter.running[pid].update(code=code, text=text)
        w.adapter.finish(pid)

    def test_complete_answer_survives_a_nonzero_exit(self):
        w = self.world([("s", 3)])
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.finish_code(w, task, 1, answer(drop_rows(task, 3)))
        w.tick()
        self.assertEqual(self.tasks(w)[task]["state"], "SAVED")
        self.assertEqual(len(w.adapter.launches), 1)

    def test_fast_unavailable_blocks_a_complete_answer_after_nonzero_exit(self):
        w = self.world([("s", 3)])
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.finish_code(w, task, 1, "Fast mode is not available for this model\n" + answer(drop_rows(task, 3)))
        w.sup._classify_run = lambda _producer, log: classify_codex_failure(Path(log).read_text("utf-8"), [])
        w.tick()

        self.assertEqual(self.tasks(w)[task]["state"], "FAILED")
        self.assertIn("Codex가 Fast 설정을 지원하지 않는다고 명시했습니다", json.loads(self.tasks(w)[task]["data"])["error"])
        self.assertEqual(w.store.active_batch("claude", S2)["state"], "ERROR")

    def test_unknown_failure_without_answer_is_preserved_not_rerun(self):
        w = self.world([("s", 3)])
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.finish_code(w, task, 1, "something odd happened\n")
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(w.store.active_batch("claude", S2)["state"], "ERROR")

    def test_rate_limit_failure_is_retried_for_that_task(self):
        w = self.world([("s", 3)])
        self.launch(w, 2)
        w.tick()
        task = f"{PREFIX}-t01"
        self.finish_code(w, task, 1, "HTTP 429 rate limit exceeded\n")
        w.tick()
        w.now += 1000
        w.tick()
        self.assertEqual(len(w.adapter.launches), 2)

    def test_codex_capacity_error_retries_only_failed_task(self):
        w = self.world([("s", 3)])
        self.launch(w, 2)
        w.tick()
        task = f"{PREFIX}-t01"
        w.sup._classify_run = lambda _producer, log: classify_codex_failure(Path(log).read_text("utf-8"), [])
        self.finish_code(w, task, 1, '{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}\n')
        w.tick()
        self.assertNotEqual(self.tasks(w)[task]["state"], "FAILED")
        w.now += 1000
        w.tick()
        self.assertEqual(len(w.adapter.launches), 2)

    def test_retry_after_failed_correction_run_resumes_the_correction_not_the_rejected_save(self):
        # #5204: the correction run died (usage limit) before fixing anything. A resume must relaunch the correction in
        # its own session; re-saving the still-rejected answer would fail "수정 증거가 완전하지 않아" without any AI fix.
        w = self.world([("s", 3)])
        self.launch(w, 2)
        w.tick()
        task = f"{PREFIX}-t01"
        self.respond(w, task, drop_rows(task, 3, bad=(2,)))
        w.tick()
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        w.sup._classify_run = lambda _producer, _log: "usage_limit"
        self.finish_code(w, task, 1, "limit\n")
        w.tick(2)
        # A plan limit is not a defect: PAUSED for the owner's Retry, never an ERROR the Maintainer takes as an incident.
        self.assertEqual((w.store.active_batch("claude", S2)["state"], self.tasks(w)[task]["state"]), ("PAUSED", "FAILED"))
        w.sup._classify_run = lambda _producer, _log: "unknown"
        saves = len(w.git.task_save_calls)
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        self.assertEqual(len(w.git.task_save_calls), saves)   # the rejected answer is not saved again
        self.assertEqual(self.tasks(w)[task]["state"], "RUNNING")
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        self.assertIn("c2", w.adapter.launches[-1]["prompt"])
        self.respond(w, task, f"chunk {task}\nc2 D e")
        w.tick()
        self.assertEqual(self.tasks(w)[task]["state"], "SAVED")

    def test_resume_after_usage_limit_waits_for_the_reported_reset_5921(self):
        # #5921: an approved resume/Retry relaunched the failed task at once while the plan limit was still active.
        import datetime
        w = self.world([("s", 3)])
        self.launch(w, 3)
        w.tick()
        task = f"{PREFIX}-t01"
        self.respond(w, task, drop_rows(task, 3, bad=(2,)))
        w.tick()
        w.sup._classify_run = lambda _producer, _log: "usage_limit"
        reset = datetime.datetime.fromtimestamp(w.now + 3 * 86400).replace(second=0, microsecond=0)
        text = reset.strftime("%b %d, %Y %I:%M %p")
        self.finish_code(w, task, 1, '{"type":"error","message":"hit your usage limit, try again at %s"}\n' % text)
        w.tick(2)
        self.assertEqual(self.tasks(w)[task]["state"], "FAILED")
        launches = len(w.adapter.launches)
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), launches)   # held until the reset
        self.assertEqual(self.tasks(w)[task]["state"], "FIXQ")
        w.now = reset.timestamp() + 1
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), launches + 1)

    def test_usage_limit_reset_parsing_5921(self):
        from warroom.adapters import usage_limit_reset_at
        import datetime
        got = usage_limit_reset_at("You’ve hit your usage limit. try again at Nov 16th, 2026 11:41 PM.")
        self.assertEqual(datetime.datetime.fromtimestamp(got), datetime.datetime(2026, 11, 16, 23, 41))
        self.assertIsNone(usage_limit_reset_at("no limit here"))

    def test_restart_after_technical_drop_save_resaves_with_persisted_evidence(self):
        w = self.world([("s", 3)])
        self.launch(w, 1)
        w.tick()
        task = f"{PREFIX}-t01"
        self.respond(w, task, drop_rows(task, 3, bad=(2,)))
        w.tick()
        self.respond(w, task, f"chunk {task}\nc2 D BAD")
        real = w.store.update_task
        def lose_saved(batch_id, t, **fields):   # the CLI saved, then the process died before recording SAVED
            if fields.get("state") == "SAVED":
                raise RuntimeError("crash")
            return real(batch_id, t, **fields)
        w.store.update_task = lose_saved
        b = w.store.active_batch("claude", S2)
        with self.assertRaises(RuntimeError):
            w.sup.s2p.poll(b)
        w.store.update_task = real
        # A killed process never runs the restore in `finally`: the decision file keeps the failing row removed.
        rel = stage2.task_path(task, "decisions.txt")
        stage2.write_decisions(b["worktree"], task, [r for r in stage2.read_rows(b["worktree"], rel) if not r.startswith("c2 ")], rel)
        self.assertEqual(self.tasks(w)[task]["state"], "RESPONDED")
        calls = len(w.git.task_save_calls)
        w.sup = w.make_sup()
        w.sup.parallel_new_parts = True
        w.tick()
        self.assertEqual(self.tasks(w)[task]["state"], "SAVED")
        self.assertEqual(len(w.git.task_save_calls), calls + 1)   # one re-save, no fallback-less attempt in between
        self.assertEqual([c["alias"] for c in w.git.technical_fallback_calls], ["c2", "c2"])   # persisted proof re-presented
        b = w.store.active_batch("claude", S2) or w.store.latest_batch("claude", S2)
        self.assertEqual(stage2.checkpoint(b["worktree"], "001", "01-01")["next_chunk_number"], 2)   # cursor not advanced twice


class ConfigAndMigration(unittest.TestCase):
    def test_defaults_and_validation(self):
        self.assertEqual((DEFAULTS["stage2_chunk_candidates"], DEFAULTS["stage2_max_parallel"]), (250, 16))
        for key in ("stage2_chunk_candidates", "stage2_max_parallel"):
            bad = json.loads(json.dumps(DEFAULTS))
            bad[key] = 0
            self.assertIn(key, config_problem(bad) or "")

    def test_additive_migration_creates_task_state(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(Path(tmp) / "w.db")
            with store._conn() as c:
                tables = {r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                runs = {r["name"] for r in c.execute("PRAGMA table_info(runs)")}
                version = c.execute("PRAGMA user_version").fetchone()[0]
        self.assertIn("s2_tasks", tables)
        self.assertIn("task", runs)
        self.assertEqual(version, SCHEMA_VERSION)


if __name__ == "__main__":
    unittest.main()
