"""Issue #3076 PR 2: Method C runs its 12-Sense chunks as up to four parallel War Room tasks inside one batch."""
import hashlib
import json
import unittest

from pathlib import Path

from tests.test_issue_2033_c import CP_NAME, CWorld
from warroom import control, cparallel, literary, taskruns
from warroom.shell import Result


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
        for launch, task in zip(w.adapter.launches, ("001", "002", "003", "004")):
            ids = self.sense_ids(w, task)
            self.assertIn("Supervisor가 배정한 조회 허용 ID(아래 문자열을 그대로 복사): " + ", ".join(ids), launch["prompt"])
            self.assertIn("이번 실행의 미완료 제출 ID: " + ", ".join(ids), launch["prompt"])
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

    def test_complete_unshown_empty_sample_is_resubmitted_by_scoped_supervisor_cli(self):
        w = self.world(senses=24)
        w.start("single", "deepseek", "c")
        w.tick()
        ids = self.sense_ids(w, "001")
        target_id = ids[0]
        checkpoint_path = w.wt() / f".warroom-scratch/{CP_NAME}"
        checkpoint = json.loads(checkpoint_path.read_text())
        senses = {sense["sense_id"]: sense for record in checkpoint["records"] for sense in record["senses"]}
        for sense_id in ids:
            sense = senses[sense_id]
            forms = [f"form-{sense_id}"]
            sense["search_forms"] = forms
            sense["added_forms"] = []
            sense["shown"] = None
        forms = senses[target_id]["search_forms"]
        senses[target_id]["shown"] = {"forms_sha256": literary._state_digest(forms), "total_hits": 42,
                                       "unit_rowids": list(range(1, 9))}
        checkpoint_path.write_text(json.dumps(checkpoint))

        submit_path = w.wt() / ".warroom-scratch/c-chunk-001.submit.json"
        submission = {"senses": [{"sense_id": sense_id,
                                   "verified": [] if sense_id == target_id else ["abcdef123456"],
                                   "candidates": []} for sense_id in ids]}

        def reject_unshown_empty_sample():
            input_bytes = json.dumps(submission).encode()
            submit_path.write_bytes(input_bytes)
            (w.wt() / ".warroom-scratch/c-chunk-001.submit.json.diag.json").write_text(json.dumps({
                "status": "FAILED", "diagnostic": "submit_validation", "reason": "unshown_empty_sample",
                "repair_scope": "resubmit_affected_sense", "affected": {"sense_id": target_id,
                "field": "verified", "entry_number": 1}, "issues": [{"entry_number": 1,
                "reason": "unshown_empty_sample", "field": "verified"}],
                "input_sha256": hashlib.sha256(input_bytes).hexdigest(),
            }) + "\n")

        # A completed sibling remains saved while task 001 gets its one source-bound correction.
        self.finish(w, "002")
        w.tick()
        self.assertEqual(self.tasks(w)["002"]["state"], "SAVED")
        self._finish_rejected(w, "001", submits=1, reject=reject_unshown_empty_sample)
        w.tick()
        fixes = [r for r in w.store.runs(self.b(w)["id"]) if r["kind"] == "c_chunk_fix"]
        self.assertEqual(len(fixes), 1)
        self.assertFalse(any(call[2] == "submit" for call in w.runner.literary.calls if len(call) > 2))

        # The correction run reads the missing suffix but ends without issuing another submit.
        checkpoint = json.loads(checkpoint_path.read_text())
        senses = {sense["sense_id"]: sense for record in checkpoint["records"] for sense in record["senses"]}
        senses[target_id]["shown"]["unit_rowids"] = list(range(1, 17))
        checkpoint_path.write_text(json.dumps(checkpoint))
        self._finish_rejected(w, "001", submits=0, reject=lambda: None)
        w.tick()

        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")
        self.assertEqual(self.tasks(w)["002"]["state"], "SAVED")
        self.assertEqual(self.data(w, "001").get("completed_fix_runs", []), [])
        submit_calls = [call for call in w.runner.literary.calls if len(call) > 2 and call[2] == "submit"]
        self.assertEqual(len(submit_calls), 1)
        self.assertEqual(submit_calls[0][submit_calls[0].index("--chunk") + 1], "001")
        saved = json.loads(checkpoint_path.read_text())
        saved_senses = {sense["sense_id"]: sense for record in saved["records"] for sense in record["senses"]}
        self.assertEqual(saved_senses[target_id]["submission"]["status"], "SAMPLED_NO_VERIFIED")

    def test_sequential_unshown_empty_samples_queue_the_latest_diagnosed_sense(self):
        w = self.world(senses=24)
        w.start("single", "deepseek", "c")
        w.tick()
        ids = self.sense_ids(w, "001")
        target_ids = ids[:2]
        self.finish(w, "002")

        checkpoint_path = w.wt() / f".warroom-scratch/{CP_NAME}"
        checkpoint = json.loads(checkpoint_path.read_text())
        senses = {sense["sense_id"]: sense for record in checkpoint["records"] for sense in record["senses"]}
        for sense_id in ids:
            forms = [f"form-{sense_id}"]
            senses[sense_id]["search_forms"] = forms
            senses[sense_id]["added_forms"] = []
            senses[sense_id]["shown"] = None
        for target_id in target_ids:
            senses[target_id]["shown"] = {"forms_sha256": literary._state_digest(senses[target_id]["search_forms"]),
                                            "total_hits": 42, "unit_rowids": list(range(1, 9))}
        checkpoint_path.write_text(json.dumps(checkpoint))

        submit_path = w.wt() / ".warroom-scratch/c-chunk-001.submit.json"
        entries = [{"sense_id": sense_id,
                    "verified": [] if sense_id in target_ids else ["abcdef123456"],
                    "candidates": []} for sense_id in ids]
        submit_path.write_text(json.dumps({"senses": entries}), encoding="utf-8")
        target_entry = {sense_id: i + 1 for i, sense_id in enumerate(ids)}

        def write_diagnostic(target_id):
            entry_number = target_entry[target_id]
            submit_bytes = submit_path.read_bytes()
            (submit_path.with_name(submit_path.name + ".diag.json")).write_text(json.dumps({
                "status": "FAILED", "diagnostic": "submit_validation", "reason": "unshown_empty_sample",
                "repair_scope": "resubmit_affected_sense", "affected": {"sense_id": target_id,
                "field": "verified", "entry_number": entry_number}, "issues": [{"entry_number": entry_number,
                "reason": "unshown_empty_sample", "field": "verified"}],
                "input_sha256": hashlib.sha256(submit_bytes).hexdigest(),
            }) + "\n")

        write_diagnostic(target_ids[0])
        self._finish_rejected(w, "001", submits=1, reject=lambda: None)
        w.tick()
        self.assertEqual(self.tasks(w)["002"]["state"], "SAVED")
        first_fix = next(r for r in self.open_runs(w) if r["task"] == "001")
        self.assertIn(target_ids[0], w.adapter.launches[-1]["prompt"])

        original_run = w.runner.literary.run

        def progressive_submit(argv, cwd, env=None, input=None):
            if len(argv) > 2 and argv[2] == "submit":
                input_name = w.runner.literary.opt(argv, "--input")
                if Path(input_name).name == "c-chunk-001.submit.json":
                    cp = w.runner.literary.load(cwd, argv)
                    submission = json.loads((Path(cwd) / input_name).read_text())
                    checkpoint_senses = {sense["sense_id"]: sense for record in cp["records"]
                                         for sense in record["senses"]}
                    for entry in submission["senses"]:
                        if entry["sense_id"] not in target_ids or entry["verified"] or entry["candidates"]:
                            continue
                        shown = checkpoint_senses[entry["sense_id"]].get("shown") or {}
                        if len(shown.get("unit_rowids", [])) < min(shown.get("total_hits", 0), 16):
                            write_diagnostic(entry["sense_id"])
                            diagnostic = json.loads(submit_path.with_name(submit_path.name + ".diag.json").read_text())
                            w.runner.literary.calls.append(list(argv))
                            return Result(1, "", json.dumps(diagnostic))
            return original_run(argv, cwd, env, input)

        w.runner.literary.run = progressive_submit
        checkpoint = json.loads(checkpoint_path.read_text())
        senses = {sense["sense_id"]: sense for record in checkpoint["records"] for sense in record["senses"]}
        senses[target_ids[0]]["shown"]["unit_rowids"] = list(range(1, 17))
        checkpoint_path.write_text(json.dumps(checkpoint))
        self._finish_rejected(w, "001", submits=0, reject=lambda: None)
        w.tick()

        data = self.data(w, "001")
        self.assertEqual(data["sample_fix_runs"], [first_fix["id"]])
        second_fix = next(r for r in self.open_runs(w) if r["task"] == "001")
        self.assertEqual(second_fix["kind"], "c_chunk_fix")
        second_prompt = w.adapter.launches[-1]["prompt"]
        self.assertIn(target_ids[1], second_prompt)
        self.assertIn("input_sha256", second_prompt)
        self.assertIn('"version":1', second_prompt)
        self.assertIn('"failing_cases"', second_prompt)

        checkpoint = json.loads(checkpoint_path.read_text())
        senses = {sense["sense_id"]: sense for record in checkpoint["records"] for sense in record["senses"]}
        senses[target_ids[1]]["shown"]["unit_rowids"] = list(range(1, 17))
        checkpoint_path.write_text(json.dumps(checkpoint))
        self._finish_rejected(w, "001", submits=0, reject=lambda: None)
        w.tick()

        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")
        self.assertEqual(self.tasks(w)["002"]["state"], "SAVED")
        saved = json.loads(checkpoint_path.read_text())
        saved_senses = {sense["sense_id"]: sense for record in saved["records"] for sense in record["senses"]}
        self.assertTrue(all(saved_senses[sense_id]["submission"] for sense_id in ids))
        self.assertEqual(len([call for call in w.runner.literary.calls if len(call) > 2 and call[2] == "submit"]), 2)

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
