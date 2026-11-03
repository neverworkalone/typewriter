"""Issue #3076 PR 2: Method C runs its 12-Sense chunks as up to four parallel War Room tasks inside one batch."""
import json
import unittest

from pathlib import Path

from tests.test_issue_2033_c import CP_NAME, CWorld
from warroom import control, cparallel, literary, taskruns


class ParallelCWorld(CWorld):
    parallel_c = True


class Helpers:
    def world(self, senses=50, **kw):
        w = ParallelCWorld(senses=senses, **kw)
        self.addCleanup(w.tmp.cleanup)
        w.adapter.plan.extend({"code": 0, "session": f"ses_{i}"} for i in range(60))
        return w

    @staticmethod
    def b(w):
        return w.row("deepseek", "c")

    @staticmethod
    def open_runs(w):
        return taskruns.open_runs(w.store, w.row("deepseek", "c")["id"])

    @staticmethod
    def tasks(w):
        return {r["task"]: r for r in w.store.task_rows(w.row("deepseek", "c")["id"])}

    @staticmethod
    def data(w, task):
        return json.loads(w.store.task_row(w.row("deepseek", "c")["id"], task)["data"] or "{}")

    @staticmethod
    def sense_ids(w, task):
        return literary.read_active(w.wt(), w.row("deepseek", "c"), int(task))["sense_ids"]

    def save(self, w, task):
        w.runner.literary.mark(w.wt(), f".warroom-scratch/{CP_NAME}", self.sense_ids(w, task))

    def finish(self, w, task, save=True):
        run = next(r for r in self.open_runs(w) if r["task"] == task)
        if save:
            self.save(w, task)
        w.adapter.finish(run["pid"])


class ParallelC(Helpers, unittest.TestCase):
    def test_four_slots_refill_one_by_one_no_sense_twice_and_one_pr(self):
        w = self.world(senses=62)                        # chunks of 12: 12,12,12,12,12,2
        w.start("single", "deepseek", "c")
        w.tick()
        b = self.b(w)
        self.assertEqual((b["state"], b["run_kind"], b["pid"]), ("PRODUCING", "c_parallel", None))
        self.assertEqual(w.store.get(f"c_mode_{b['id']}"), "parallel")
        self.assertEqual(sorted(r["task"] for r in self.open_runs(w)), ["001", "002", "003", "004"])
        everything = [i for t in self.tasks(w) for i in self.sense_ids(w, t)]
        self.assertEqual(len(everything), len(set(everything)))          # no Sense is assigned twice
        self.assertEqual(sum(1 for c in w.runner.literary.calls if c[2] == "init"), 1)
        self.finish(w, "003")                                              # no wave barrier
        w.tick()
        self.assertEqual(self.tasks(w)["003"]["state"], "SAVED")
        self.assertEqual(sorted(r["task"] for r in self.open_runs(w)), ["001", "002", "004", "005"])
        for _ in range(12):
            self.assertLessEqual(len(self.open_runs(w)), literary.MAX_PARALLEL)
            for r in list(self.open_runs(w)):
                self.finish(w, r["task"])
            w.tick()
        b = self.b(w)
        self.assertEqual((b["state"], b["pr_number"]), ("WAITING_REVIEW", 100))
        self.assertEqual(len(w.gh.created_prs), 1)
        self.assertEqual(w.runner.literary.exports, 1)
        self.assertEqual(len(w.adapter.launches), 6)
        self.assertTrue(all("--chunk 00" in l["prompt"] for l in w.adapter.launches))

    def test_runtime_baseline_and_mode_exist_before_the_checkpoint(self):
        w = self.world(senses=13)
        order = []
        original = w.runner.literary.run

        def spy(argv, cwd, env=None, input=None):
            if argv[2] == "init":
                order.append((w.store.get(f"c_mode_{self.b(w)['id']}"), w.store.get(literary.run_start_key(self.b(w)["id"])) is not None))
            return original(argv, cwd, env, input)
        w.runner.literary.run = spy
        w.start("single", "deepseek", "c")
        w.tick()
        self.assertEqual(order, [("parallel", True)])

    def test_everything_left_is_reserved_is_a_normal_wait(self):
        w = self.world(senses=24)                        # two chunks, two free slots stay free
        w.start("single", "deepseek", "c")
        w.tick(3)
        b = self.b(w)
        self.assertEqual(b["state"], "PRODUCING")
        self.assertEqual(len(self.open_runs(w)), 2)
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertEqual(sorted(self.tasks(w)), ["001", "002"])

    def test_active_without_task_row_is_adopted_not_rendered_again(self):
        w = self.world(senses=26)
        w.start("single", "deepseek", "c")
        w.tick()
        b = self.b(w)
        for r in list(self.open_runs(w)):                # a restart after the active file but before the task row
            w.store.finish_run(r["id"], "stopped")
        with w.store._conn() as c:
            c.execute("DELETE FROM s2_tasks WHERE batch_id=? AND task='002'", (b["id"],))
            c.execute("UPDATE runs SET task=NULL WHERE batch_id=? AND task='002'", (b["id"],))
        for pid in list(w.adapter.running):
            w.adapter.stop(pid)
        view_before = (w.wt() / ".warroom-scratch/c-active-002.txt").read_bytes()
        w.tick()
        self.assertEqual((w.wt() / ".warroom-scratch/c-active-002.txt").read_bytes(), view_before)
        self.assertIn("002", self.tasks(w))
        self.assertEqual(max(literary.active_chunks(w.wt(), self.b(w))), 3)

    def test_zero_progress_without_reservation_is_an_error(self):
        w = self.world(senses=4)
        w.start("single", "deepseek", "c")
        w.runner.literary.chunk_status = {}
        w.tick()
        self.assertEqual(len(self.open_runs(w)), 1)
        self.assertEqual(self.b(w)["state"], "PRODUCING")


class ParallelCCorrections(Helpers, unittest.TestCase):
    def _rejected(self, w, task):
        ids = self.sense_ids(w, task)
        submit = w.wt() / f".warroom-scratch/c-chunk-{task}.submit.json"
        submit.write_text('{"senses":[]')
        submit.with_name(submit.name + ".diag.json").write_text(json.dumps(
            {"status": "FAILED", "diagnostic": "submit_validation", "repair_scope": "correct_submission_shape"}) + "\n")
        return ids

    def _finish_rejected(self, w, task, submits=1, reject=None):
        run = next(r for r in self.open_runs(w) if r["task"] == task)
        (reject or (lambda: self._rejected(w, task)))()
        pid = run["pid"]
        info = w.adapter.running.pop(pid)
        events = [{"type": "thread.started", "thread_id": info.get("session", "ses")}]
        events += [{"type": "item.completed", "item": {"id": f"{run['id']}-{i}", "type": "command_execution",
                    "command": "node literary-context-cli.mjs submit --checkpoint x --input y", "exit_code": 1}}
                   for i in range(submits)]
        events.append({"type": "turn.completed", "usage": {"input_tokens": 1, "cached_input_tokens": 0,
                                                            "output_tokens": 1, "reasoning_output_tokens": 0}})
        info["log"].write_text(json.dumps({"sessionID": info.get("session", "ses")}) + "\n"
                               + "".join(json.dumps(e) + "\n" for e in events))
        info["ex"].write_text("0")

    def test_fix_without_submit_is_not_completed_and_not_repeated(self):
        w = self.world(senses=12)
        w.start("single", "deepseek", "c")
        w.tick()
        self._finish_rejected(w, "001", submits=1)       # the first run submitted (rejected) -> a correction is queued
        w.tick()
        fixes = [r for r in w.store.runs(self.b(w)["id"]) if r["kind"] == "c_chunk_fix"]
        self.assertEqual(len(fixes), 1)
        self.assertEqual(self.data(w, "001")["fix_launch"], {str(fixes[0]["id"]): "auto"})
        self._finish_rejected(w, "001", submits=0)       # the correction ended without any official submit
        w.tick(2)
        self.assertEqual(self.data(w, "001").get("completed_fix_runs", []), [])
        self.assertEqual(self.tasks(w)["001"]["state"], "FAILED")
        self.assertEqual(len([r for r in w.store.runs(self.b(w)["id"]) if r["kind"] == "c_chunk_fix"]), 1)

    def test_skip_needs_two_completed_automatic_corrections_and_runs_through_the_task_authority(self):
        w = self.world(senses=12)
        w.start("single", "deepseek", "c")
        w.tick()
        ids = self.sense_ids(w, "001")

        def reject():
            entries = [{"sense_id": i, "verified": ["abcdef123456"], "candidates": [f"후보-{n}"]} for n, i in enumerate(ids)]
            submit = w.wt() / ".warroom-scratch/c-chunk-001.submit.json"
            submit.write_text(json.dumps({"senses": entries}, ensure_ascii=False), "utf-8")
            submit.with_name(submit.name + ".diag.json").write_text(json.dumps({
                "status": "FAILED", "diagnostic": "submit_validation", "repair_scope": "resubmit_affected_sense",
                "reason": "context_key_not_found", "affected": {"sense_id": ids[3], "field": "verified", "entry_number": 4},
                "issues": [{"entry_number": 4, "reason": "context_key_not_found", "field": "verified"}]}))
        for attempt in range(3):
            self._finish_rejected(w, "001", reject=reject)
            w.tick()
            if attempt < 2:                                  # a correction is queued and started, then completes with a submit
                self.assertEqual(self.tasks(w)["001"]["state"], "RUNNING")
                self.assertEqual(len(self.data(w, "001").get("auto_fix_runs", [])), attempt)
        d = self.data(w, "001")
        self.assertEqual(len(d["completed_fix_runs"]), 2)
        self.assertEqual(d["auto_fix_runs"], d["completed_fix_runs"])
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")
        call = next(c for c in w.runner.literary.calls if c[1].endswith("literary-context-supervisor-cli.mjs"))
        self.assertEqual(call[call.index("--task") + 1], "001")
        self.assertEqual(call[call.index("--active") + 1], ".warroom-scratch/c-active-001.json")
        cp = json.loads((w.wt() / f".warroom-scratch/{CP_NAME}").read_text())
        senses = {x["sense_id"]: x for r in cp["records"] for x in r["senses"]}
        self.assertEqual(senses[ids[3]]["submission"]["status"], "TECHNICAL_SKIPPED")
        self.assertEqual(sum(senses[i]["submission"]["status"] == "SUBMITTED" for i in ids), 11)

    def test_operator_retry_epoch_grants_once_per_epoch_and_stop_grants_nothing(self):
        w = self.world(senses=12)
        w.start("single", "deepseek", "c")
        w.tick()
        b = self.b(w)
        row = self.tasks(w)["001"]
        run = w.store.run(row["run_id"])
        w.adapter.running.pop(run["pid"])
        w.store.finish_run(run["id"], "1")
        w.adapter.plan.clear()
        w.sup.cp._task_failed(b, row, {}, "[001] AI 실행 실패(코드 1, unknown)")
        w.tick(2)
        self.assertEqual(self.b(w)["state"], "ERROR")
        epoch = lambda: int(w.store.get(cparallel.epoch_key(b["id"])) or 0)
        self.assertEqual(epoch(), 0)
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.tick()
        self.assertEqual(epoch(), 1)
        w.tick()
        self.assertEqual(self.data(w, "001").get("operator_grants"), 1)
        w.tick(3)                                        # repeated polls and a "restarted" Supervisor grant nothing more
        w.sup.cp._seen.clear()
        w.tick(2)
        self.assertEqual(epoch(), 1)
        self.assertEqual(self.data(w, "001").get("operator_grants"), 1)
        self.assertEqual(self.data(w, "001").get("last_operator_retry_epoch"), 1)

    def test_normal_stop_resumes_without_grant_or_epoch(self):
        w = self.world(senses=26)
        w.start("single", "deepseek", "c")
        w.tick()
        b = self.b(w)
        self.finish(w, "001")
        w.tick()
        control.stop_line(w.store, "deepseek", "c")
        w.tick(2)
        self.assertEqual(self.b(w)["state"], "PAUSED")
        self.assertEqual(self.open_runs(w), [])
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.tick(2)
        self.assertEqual(sorted(r["task"] for r in self.open_runs(w)), ["002", "003"])
        self.assertEqual(int(w.store.get(cparallel.epoch_key(b["id"])) or 0), 0)
        self.assertNotIn("operator_grants", self.data(w, "002"))

    def test_no_submission_recovery_ignores_other_tasks_saves_and_runs_once(self):
        w = self.world(senses=26)
        w.start("single", "deepseek", "c")
        w.tick()
        run = next(r for r in self.open_runs(w) if r["task"] == "001")
        self.save(w, "002")                              # another task's normal save changes the whole checkpoint file
        info = w.adapter.running.pop(run["pid"])
        info["log"].write_text(json.dumps({"sessionID": "ses_a"}) + "\n" + "".join(json.dumps(e) + "\n" for e in [
            {"type": "thread.started", "thread_id": "ses_a"},
            {"type": "item.completed", "item": {"id": "answer", "type": "agent_message", "text": "Done, I did not call submit."}},
            {"type": "turn.completed", "usage": {"input_tokens": 1, "cached_input_tokens": 0, "output_tokens": 1,
                                                  "reasoning_output_tokens": 0}}]))
        info["ex"].write_text("0")
        w.tick()
        self.assertEqual(self.data(w, "001").get("recovery", {}).get("source_run_id"), run["id"])
        kinds = [r["kind"] for r in w.store.runs(self.b(w)["id"])]
        self.assertEqual(kinds.count("c_chunk_recovery"), 1)
        self.assertEqual(self.tasks(w)["001"]["state"], "RUNNING")


class ParallelCBoundary(Helpers, unittest.TestCase):
    def test_older_head_than_the_runtime_baseline_is_rejected_and_serial_batches_stay_serial(self):
        w = self.world(senses=26)
        w.start("single", "deepseek", "c")
        w.tick()
        b = self.b(w)
        base = cparallel.baseline(w.store, b)
        self.assertEqual(base["head"], w.git.local_head)
        w.git.local_head = "e" * 40                      # HEAD moved away from the approved baseline
        self.finish(w, "001")
        w.tick()
        self.assertEqual(self.b(w)["state"], "ERROR")
        self.assertIn("승인 기준", self.b(w)["error"])

    def test_maintainer_integration_moves_the_one_baseline_forward_only_with_inputs_intact(self):
        w = self.world(senses=26)
        w.git.on_create = lambda path: (Path(path) / "data/canonical").mkdir(parents=True, exist_ok=True) or \
            (Path(path) / "data/canonical/stdict-0001.jsonl").write_text('{"id":1}\n')
        w.start("single", "deepseek", "c")
        w.tick()
        b = self.b(w)
        base = cparallel.baseline(w.store, b)
        self.assertIsNotNone(base["canonical_sha256"])
        new = "f" * 40
        w.git.local_head = new
        w.git.reg[b["branch"]] = b["branch"]
        w.git.contains = lambda path, sha: sha in (base["head"], new)
        w.git.remote[b["branch"]] = base["remote_head"]
        key, value = w.sup.maint._retargeted_run_start(b, new)
        self.assertEqual((key, json.loads(value)["head"]), (literary.run_start_key(b["id"]), new))
        w.store.set(key, value)
        self.assertEqual({r["git_head"] for r in literary.active_chunks(w.wt(), b).values()}, {new})   # views follow the baseline
        rec = literary.read_active(w.wt(), b, 1)
        self.assertEqual(rec["git_head"], cparallel.baseline(w.store, b)["head"])
        self.assertIsNone(cparallel.ParallelC._boundary_problem(w.sup.cp, b, cparallel._Round(w.sup.cp, b)))
        # the old approved HEAD is not a valid runtime baseline any more
        w.git.local_head = base["head"]
        self.assertIn("승인 기준", cparallel.ParallelC._boundary_problem(w.sup.cp, b, cparallel._Round(w.sup.cp, b)))
        # a changed Canonical shard means the batch's inputs are not intact: no automatic retargeting
        w.git.local_head = new
        (w.wt() / "data/canonical/stdict-0001.jsonl").write_text('{"id":2}\n')
        self.assertIsNone(w.sup.maint._retargeted_run_start(b, new))

    def test_active_chunk_bound_to_an_older_head_is_not_launched_or_accepted(self):
        w = self.world(senses=26)
        w.start("single", "deepseek", "c")
        w.tick()
        b = self.b(w)
        for r in list(self.open_runs(w)):
            w.adapter.stop(r["pid"])
            w.store.finish_run(r["id"], "stopped")
        path = w.wt() / ".warroom-scratch/c-active-001.json"
        rec = json.loads(path.read_text())
        path.write_text(json.dumps({**rec, "git_head": "d" * 40}))
        w.store.update_task(b["id"], "001", state="PENDING", run_id=None)
        before = len(w.adapter.launches)
        w.tick()
        self.assertEqual(self.b(w)["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), before)

    def test_serial_world_keeps_the_serial_path(self):
        w = CWorld(senses=13)
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()
        b = w.row("deepseek", "c")
        self.assertEqual(b["run_kind"], "c_chunk_new")
        self.assertIsNone(w.store.get(f"c_mode_{b['id']}"))


if __name__ == "__main__":
    unittest.main()
