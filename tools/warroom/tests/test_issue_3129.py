"""Issue #3129: a finite C literary-context sample is normal progress and can recover once."""
import hashlib
import json
import unittest
from pathlib import Path

from tests.test_issue_3076 import Helpers
from warroom import cparallel, literary, prompts, control


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode()).hexdigest()


class Issue3129(Helpers, unittest.TestCase):
    def _prepare_sixteen_context_state(self, w, task="001"):
        """Give the fake checkpoint the same initial-eight / extended-sixteen shape as the production CLI."""
        b, wt = self.b(w), w.wt()
        row = w.store.task_row(b["id"], task)
        rec = literary.read_active(wt, b, int(task))
        checkpoint_path = wt / literary.names(b).checkpoint
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        forms = ["표제"]
        forms_sha = _digest(forms)
        target_ids = set(rec["sense_ids"])
        for record in checkpoint["records"]:
            for sense in record["senses"]:
                if sense["sense_id"] not in target_ids:
                    continue
                sense["search_forms"] = list(forms)
                sense["added_forms"] = []
                start = (int(sense["sense_id"][1:]) + 1) * 100
                sense["shown"] = {"forms_sha256": forms_sha, "total_hits": 20,
                                  "unit_rowids": list(range(start, start + 8))}
        checkpoint_path.write_text(json.dumps(checkpoint, ensure_ascii=False))

        data = json.loads(row["data"] or "{}")
        data["run_start"]["retry_state"]["own_state"] = literary.own_state(wt, b, rec["sense_ids"])
        data["run_start"]["retry_state"]["checkpoint"] = literary._file_state(checkpoint_path)
        view_path = wt / f"{literary.SCRATCH}/c-active-{int(task):03d}.txt"
        header = view_path.read_text("utf-8").partition("\n\n")[0]
        blocks = []
        for sense_id in rec["sense_ids"]:
            start = (int(sense_id[1:]) + 1) * 100
            contexts = "\n\n".join(f"[{start + index:012d}] 작품 / 작가\n원문 {sense_id} 문맥 {index + 1}"
                                     for index in range(8))
            blocks.append(f"## {sense_id} — 표제 [noun]\n뜻 {sense_id}\nhits=20 unseen=12\n{contexts}")
        view = f"{header}\n\n" + "\n\n".join(blocks) + "\n"
        view_path.write_text(view, encoding="utf-8")
        rec["view_sha256"] = hashlib.sha256(view.encode("utf-8")).hexdigest()
        active_path = wt / f"{literary.SCRATCH}/c-active-{int(task):03d}.json"
        active_path.write_text(json.dumps(rec, ensure_ascii=False))
        data["run_start"]["retry_state"]["view_sha256"] = rec["view_sha256"]

        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        for record in checkpoint["records"]:
            for sense in record["senses"]:
                if sense.get("sense_id") == rec["sense_ids"][0]:
                    start = (int(sense["sense_id"][1:]) + 1) * 100
                    sense["shown"]["unit_rowids"] = list(range(start, start + 16))
        checkpoint_path.write_text(json.dumps(checkpoint, ensure_ascii=False))
        w.store.update_task(b["id"], task, data=json.dumps(data, ensure_ascii=False, sort_keys=True),
                            view_sha256=rec["view_sha256"])
        return rec

    def test_forms_or_submission_change_never_counts_as_shown_only_progress(self):
        w = self.world(senses=12)
        w.start("single", "deepseek", "c")
        w.tick()
        b, rec = self.b(w), literary.read_active(w.wt(), self.b(w), 1)
        checkpoint_path = w.wt() / literary.names(b).checkpoint
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        forms = ["표제"]
        forms_sha = _digest(forms)
        target_ids = set(rec["sense_ids"])
        for record in checkpoint["records"]:
            for sense in record["senses"]:
                if sense["sense_id"] in target_ids:
                    sense["search_forms"] = list(forms)
                    sense["added_forms"] = []
                    sense["shown"] = {"forms_sha256": forms_sha, "total_hits": 20,
                                      "unit_rowids": list(range(100, 108))}
        checkpoint_path.write_text(json.dumps(checkpoint, ensure_ascii=False))
        before = literary.own_state(w.wt(), b, rec["sense_ids"])

        for field, value in (("search_forms", ["다른 표제"]), ("submission", {"status": "SUBMITTED", "candidates": []})):
            changed = json.loads(checkpoint_path.read_text("utf-8"))
            for record in changed["records"]:
                for sense in record["senses"]:
                    if sense["sense_id"] == rec["sense_ids"][0]:
                        sense["shown"]["unit_rowids"] = list(range(100, 116))
                        if field == "search_forms":
                            sense[field] = value
                        else:
                            sense[field] = value
            checkpoint_path.write_text(json.dumps(changed, ensure_ascii=False))
            after = literary.own_state(w.wt(), b, rec["sense_ids"])
            self.assertIsNone(literary.shown_only_progress(before, after), field)
            checkpoint_path.write_text(json.dumps(checkpoint, ensure_ascii=False))

    def test_malformed_task_sense_fails_closed_in_retry_status(self):
        w = self.world(senses=12)
        w.start("single", "deepseek", "c")
        w.tick()
        w.tick()
        b = self.b(w)
        row = w.store.task_row(b["id"], "001")
        rec = literary.read_active(w.wt(), b, 1)
        run = w.store.run(row["run_id"])
        w.adapter.stop(run["pid"])
        w.store.finish_run(run["id"], "stopped")
        data = self.data(w, "001")
        data["guard"] = {"baseline": literary.retry_state(
            w.wt(), b, rec, rec["sense_ids"], session_available=True, task_state=True),
            "reason_codes": ["checkpoint_changed_without_pending_progress"]}
        w.sup.cp._task_failed(b, row, data, "[001] C malformed checkpoint guard fixture")
        w.sup.cp._halt(b, [w.store.task_row(b["id"], "001")])

        checkpoint_path = w.wt() / literary.names(b).checkpoint
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        for record in checkpoint["records"]:
            for index, sense in enumerate(record["senses"]):
                if sense["sense_id"] == rec["sense_ids"][0]:
                    record["senses"][index] = None
        checkpoint_path.write_text(json.dumps(checkpoint, ensure_ascii=False))

        with self.assertRaises(literary.LiteraryError):
            literary.own_state(w.wt(), b, rec["sense_ids"])
        self.assertFalse(control.line_status(w.store, "deepseek", "c")["can_retry"])
        self.assertFalse(control.retry(w.store, "deepseek", "c"))

    def _legacy_stop_task_status(self, *, official_diagnostic=None, command_chunk="001", command_ids="s9999",
                                 command_checkpoint=None):
        w = self.world(senses=12)
        w.start("single", "deepseek", "c")
        w.tick(2)
        b = self.b(w)
        row = w.store.task_row(b["id"], "001")
        run = w.store.run(row["run_id"])
        events = [{"type": "thread.started", "thread_id": run["session_id"]}]
        checkpoint = command_checkpoint or literary.names(b).checkpoint
        if official_diagnostic is not None:
            diagnostics = official_diagnostic if isinstance(official_diagnostic, list) else [official_diagnostic]
            for index, diagnostic in enumerate(diagnostics):
                events.append({"type": "item.completed", "item": {
                    "id": f"chunk-{index + 1}", "type": "command_execution",
                    "command": f"node {literary.cli_path()} chunk --checkpoint {checkpoint} --chunk {command_chunk} --sense-ids {command_ids}",
                    "exit_code": 1, "aggregated_output": json.dumps(diagnostic)}})
        events.extend([
            {"type": "item.completed", "item": {"id": "answer", "type": "agent_message",
             "text": "The stop_and_report marker is being discussed; I did not call submit."}},
            {"type": "turn.completed", "usage": {"input_tokens": 1, "cached_input_tokens": 0,
                                                        "output_tokens": 1, "reasoning_output_tokens": 0}},
        ])
        w.adapter.running[run["pid"]]["text"] = "".join(json.dumps(event) + "\n" for event in events)
        w.adapter.finish(run["pid"])
        w.store.finish_run(run["id"], "0")

        row = w.store.task_row(b["id"], "001")
        rec = literary.read_active(w.wt(), b, 1)
        data = self.data(w, "001")
        w.sup.cp._incomplete_failed(b, row, data, rec, rec["sense_ids"],
                                    {"status": "producer_reported_stop"})
        w.sup._fail(w.store.batch(b["id"]), "ERROR", "legacy producer_reported_stop fixture")
        return w, control.line_status(w.store, "deepseek", "c")

    def test_legacy_text_stop_guard_unlocks_only_when_no_official_scope_stop_exists(self):
        w, status = self._legacy_stop_task_status()
        self.assertTrue(status["can_retry"], status.get("retry_blocked_reason"))
        self.assertIsNone(status.get("retry_blocked_reason"))

        diagnostic = {"status": "FAILED", "diagnostic": "chunk_scope", "code": "LITERARY_CHUNK_SCOPE",
                      "message": "The request is outside the active chunk.", "repair_scope": "stop_and_report"}
        w, status = self._legacy_stop_task_status(official_diagnostic=diagnostic)
        self.assertFalse(status["can_retry"])
        self.assertIn("cli_chunk_scope", status["retry_blocked_reason"])

    def test_legacy_scope_error_needs_one_or_two_excluded_ids_and_no_other_checkpoint_command(self):
        cases = [
            ("more than two excluded IDs", lambda ids, sibling: ids + ["s9997", "s9998", "s9999"]),
        ]
        for label, requested in cases:
            with self.subTest(label=label):
                w = self.world(senses=24)
                w.start("single", "deepseek", "c")
                w.tick()
                active_ids = self.sense_ids(w, "001")
                sibling_ids = self.sense_ids(w, "002")
                initial_run_count = len(w.store.runs(self.b(w)["id"]))
                self._fail_legacy_chunk_scope_run(w, requested_ids=requested(active_ids, sibling_ids))
                w.tick(2)
                status = control.line_status(w.store, "deepseek", "c")
                self.assertEqual(self.b(w)["state"], "ERROR")
                self.assertFalse(status["can_retry"])
                self.assertEqual(len(w.store.runs(self.b(w)["id"])), initial_run_count)

        for label, overrides in (("wrong chunk", {"command_chunk": "002"}),
                                 ("other checkpoint", {"command_checkpoint": ".warroom-scratch/other.json"})):
            with self.subTest(label=label):
                w = self.world(senses=12)
                w.start("single", "deepseek", "c")
                w.tick()
                active_ids = self.sense_ids(w, "001")
                initial_run_count = len(w.store.runs(self.b(w)["id"]))
                self._fail_legacy_chunk_scope_run(w, requested_ids=active_ids + ["s9998"], **overrides)
                w.tick(2)
                self.assertEqual(self.b(w)["state"], "ERROR")
                self.assertEqual(len(w.store.runs(self.b(w)["id"])), initial_run_count)

        w = self.world(senses=24)
        w.start("single", "deepseek", "c")
        w.tick()
        active_ids = self.sense_ids(w, "001")
        sibling_ids = self.sense_ids(w, "002")
        checkpoint = literary.names(self.b(w)).checkpoint
        add_form = (f"node {literary.cli_path()} add-form --checkpoint {checkpoint} "
                    f"--sense-id {sibling_ids[0]} --form 추가형 --basis 근거")
        initial_run_count = len(w.store.runs(self.b(w)["id"]))
        self._fail_legacy_chunk_scope_run(w, requested_ids=active_ids + sibling_ids[:1],
                                          extra_cli_commands=[add_form])
        w.tick(2)
        status = control.line_status(w.store, "deepseek", "c")
        self.assertEqual(self.b(w)["state"], "ERROR")
        self.assertFalse(status["can_retry"])
        self.assertEqual(len(w.store.runs(self.b(w)["id"])), initial_run_count)

    def _fail_legacy_chunk_scope_run(self, w, task="001", requested_ids=None, extra_cli_commands=None,
                                     command_chunk=None, command_checkpoint=None, prior_chunk_reads=(),
                                     log_format="codex", final_tool_error=True):
        b = self.b(w)
        row = w.store.task_row(b["id"], task)
        rec = literary.read_active(w.wt(), b, int(task))
        run = dict(w.store.run(row["run_id"]))
        session_id = run.get("session_id") or w.adapter.session_id(Path(run["log_file"]))
        if session_id:
            w.store.set_run_session_by_id(run["id"], session_id)
            w.store.update_task(b["id"], task, session_id=session_id)
            row = w.store.task_row(b["id"], task)
            run["session_id"] = session_id
        requested_ids = requested_ids or (list(rec["sense_ids"]) + ["s9998", "s9999"])
        diagnostic = {"status": "FAILED", "diagnostic": "chunk_scope", "code": "LITERARY_CHUNK_SCOPE",
                      "message": "The request is outside the active chunk.", "repair_scope": "stop_and_report"}
        checkpoint = command_checkpoint or literary.names(b).checkpoint
        chunk_no = command_chunk or task
        commands = []
        for index, read_ids in enumerate(prior_chunk_reads):
            read_valid = [sense_id for sense_id in read_ids if sense_id in rec["sense_ids"]]
            read_invalid = [sense_id for sense_id in read_ids if sense_id not in rec["sense_ids"]]
            output = (json.dumps({"status": "WARNING", "warning": "active_chunk_scope_ids_excluded",
                                  "chunk_no": int(task), "applied_sense_ids": read_valid,
                                  "excluded_sense_ids": read_invalid}) if read_invalid else "")
            commands.append((f"node {literary.cli_path()} chunk --checkpoint {checkpoint} --chunk {chunk_no} "
                             f"--sense-ids {','.join(read_ids)}", output, 0, False))
        commands.extend((command, "FORM_ADDED\n", 0, False) for command in extra_cli_commands or [])
        commands.append((f"node {literary.cli_path()} chunk --checkpoint {checkpoint} --chunk {chunk_no} "
                         f"--sense-ids {','.join(requested_ids)}", json.dumps(diagnostic), 1, final_tool_error))
        if log_format == "claude":
            events = []
            for index, (command, output, _exit_code, tool_error) in enumerate(commands):
                tool_id = f"tool-{index + 1}"
                events.append({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": tool_id,
                               "name": "Bash", "input": {"command": command}}]}})
                result = {"type": "tool_result", "tool_use_id": tool_id, "content": output}
                if tool_error is not None:
                    result["is_error"] = tool_error
                events.append({"type": "user", "message": {"content": [result]}})
            events.append({"type": "result", "subtype": "success", "is_error": False,
                           "session_id": session_id,
                           "result": "The official CLI returned LITERARY_CHUNK_SCOPE; I stopped."})
        else:
            events = [{"type": "thread.started", "thread_id": session_id}]
            events.extend({"type": "item.completed", "item": {"id": f"cmd-{index + 1}",
                           "type": "command_execution", "command": command, "exit_code": exit_code,
                           "aggregated_output": output}}
                          for index, (command, output, exit_code, _tool_error) in enumerate(commands))
            events.extend([
                {"type": "item.completed", "item": {"id": "answer", "type": "agent_message",
                 "text": "The official CLI returned LITERARY_CHUNK_SCOPE; I stop_and_report."}},
                {"type": "turn.completed", "usage": {"input_tokens": 1, "cached_input_tokens": 0,
                                                           "output_tokens": 1, "reasoning_output_tokens": 0}},
            ])
        w.adapter.running[run["pid"]]["text"] = "".join(json.dumps(event) + "\n" for event in events)
        w.adapter.finish(run["pid"])
        w.store.finish_run(run["id"], "0")
        row = w.store.task_row(b["id"], task)
        data = self.data(w, task)
        w.sup.cp._incomplete_failed(b, row, data, rec, rec["sense_ids"], {"status": "producer_reported_stop"})
        w.sup.cp._halt(b, [w.store.task_row(b["id"], task)])
        return rec, run

    def _claude_scope_error_after_context_progress(self, *, final_tool_error=True):
        w = self.world(senses=24)
        w.start("single", "deepseek", "c")
        w.tick()
        b = self.b(w)
        sibling_ids = self.sense_ids(w, "002")
        self.finish(w, "002")
        w.tick()

        active_ids = self.sense_ids(w, "001")
        self._prepare_sixteen_context_state(w, "001")
        before = self.data(w, "001")["run_start"]["retry_state"]["own_state"]
        current = literary.own_state(w.wt(), b, active_ids)
        self.assertIsNotNone(literary.shown_only_progress(before, current))
        _, source_run = self._fail_legacy_chunk_scope_run(
            w, requested_ids=[sibling_ids[0]], prior_chunk_reads=[active_ids[:2], [active_ids[0], sibling_ids[0]]],
            log_format="claude", final_tool_error=final_tool_error)
        self.assertEqual(self.b(w)["state"], "ERROR")
        return w, b, active_ids, sibling_ids, source_run

    def test_legacy_scope_error_with_only_unassigned_ids_resumes_regardless_of_count(self):
        # #5607: a request made only of a neighbouring group's three IDs returned nothing and is provably read-only.
        w = self.world(senses=24)
        w.start("single", "deepseek", "c")
        w.tick()
        b = self.b(w)
        sibling_ids = self.sense_ids(w, "002")
        _, source_run = self._fail_legacy_chunk_scope_run(w, requested_ids=sibling_ids[:3])
        w.tick(3)
        runs = [run for run in w.store.runs(b["id"]) if run["task"] == "001"]
        self.assertEqual(max(runs, key=lambda run: run["id"])["kind"], "c_chunk_scope_recovery")
        self.assertEqual(max(runs, key=lambda run: run["id"])["session_id"], source_run["session_id"])

    def test_legacy_scope_error_resumes_once_in_same_session_and_preserves_sibling_saves(self):
        w = self.world(senses=24)
        w.start("single", "deepseek", "c")
        w.tick()
        b = self.b(w)
        sibling_ids = self.sense_ids(w, "002")
        self.finish(w, "002")
        w.tick()
        checkpoint_path = w.wt() / literary.names(b).checkpoint
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        saved_before = {sense["sense_id"]: sense["submission"] for record in checkpoint["records"]
                        for sense in record["senses"] if sense["sense_id"] in sibling_ids}

        active_ids = self.sense_ids(w, "001")
        _, source_run = self._fail_legacy_chunk_scope_run(w, requested_ids=active_ids + sibling_ids[:2])
        source_data = self.data(w, "001")
        status = control.line_status(w.store, "deepseek", "c")
        self.assertFalse(status["can_retry"], status.get("retry_blocked_reason"))
        original_resume = w.adapter.resume

        def assert_budget_before_resume(session_id, prompt, cwd, env, run, log_file, exit_file):
            recovery_data = self.data(w, "001")["recovery"]
            self.assertEqual(recovery_data["attempts"], 1)
            self.assertTrue(recovery_data["launch_started"])
            return original_resume(session_id, prompt, cwd, env, run, log_file, exit_file)

        w.adapter.resume = assert_budget_before_resume
        w.tick(2)  # supervisor proves the ended run, queues the one-time budget, then resumes the same session

        data = self.data(w, "001")
        recovery = max((run for run in w.store.runs(b["id"]) if run["task"] == "001"), key=lambda run: run["id"])
        self.assertEqual(recovery["kind"], "c_chunk_scope_recovery")
        self.assertEqual(recovery["session_id"], source_run["session_id"])
        self.assertEqual(data["recovery"]["source_run_id"], source_run["id"])
        self.assertEqual(data["recovery"]["pending_sense_ids"], active_ids)
        self.assertEqual(data["recovery"]["attempts"], 1)
        self.assertTrue(data["recovery"]["launch_started"])
        self.assertEqual(data["recovery"]["source_run_start"], source_data["run_start"])
        self.assertEqual(data["recovery"]["source_guard"], source_data["guard"])
        self.assertEqual(data.get("operator_grants", 0), 0)
        self.assertEqual(int(w.store.get(cparallel.epoch_key(b["id"])) or 0), 0)
        self.assertEqual(self.tasks(w)["002"]["state"], "SAVED")
        self.assertEqual(w.adapter.launches[-1]["kind"], "resume")
        prompt = w.adapter.launches[-1]["prompt"]
        self.assertIn("Supervisor가 배정한 조회 허용 ID(아래 문자열을 그대로 복사): " + ", ".join(active_ids), prompt)
        self.assertIn("이번 실행의 미완료 제출 ID: " + ", ".join(active_ids), prompt)
        self.assertNotIn(sibling_ids[0], prompt)

        self.finish(w, "001")
        w.tick(2)
        checkpoint_after = json.loads(checkpoint_path.read_text("utf-8"))
        submissions_after = {sense["sense_id"]: sense["submission"] for record in checkpoint_after["records"]
                             for sense in record["senses"]}
        self.assertEqual({sense_id: submissions_after[sense_id] for sense_id in sibling_ids}, saved_before)
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")

    def test_legacy_scope_error_recovers_after_same_chunk_reads_and_shown_only_progress(self):
        w = self.world(senses=24)
        w.start("single", "deepseek", "c")
        w.tick()
        b = self.b(w)
        sibling_ids = self.sense_ids(w, "002")
        self.finish(w, "002")
        w.tick()

        active_ids = self.sense_ids(w, "001")
        self._prepare_sixteen_context_state(w, "001")
        before = self.data(w, "001")["run_start"]["retry_state"]["own_state"]
        current = literary.own_state(w.wt(), b, active_ids)
        self.assertIsNotNone(literary.shown_only_progress(before, current))

        _, source_run = self._fail_legacy_chunk_scope_run(
            w, requested_ids=[sibling_ids[0]],
            prior_chunk_reads=[active_ids[:2], [active_ids[0], sibling_ids[0]]])
        self.assertEqual(self.b(w)["state"], "ERROR")
        w.tick(2)

        recovery = max((run for run in w.store.runs(b["id"]) if run["task"] == "001"), key=lambda run: run["id"])
        self.assertEqual(recovery["kind"], "c_chunk_scope_recovery")
        self.assertEqual(recovery["session_id"], source_run["session_id"])
        self.assertEqual(self.data(w, "001")["recovery"]["pending_sense_ids"], active_ids)
        self.assertEqual(self.data(w, "001")["recovery"]["attempts"], 1)
        prompt = w.adapter.launches[-1]["prompt"]
        self.assertIn("Supervisor가 배정한 조회 허용 ID(아래 문자열을 그대로 복사): " + ", ".join(active_ids), prompt)
        self.assertNotIn(sibling_ids[0], prompt)

    def test_legacy_scope_error_recovers_from_claude_tool_result_status(self):
        w, b, active_ids, sibling_ids, source_run = self._claude_scope_error_after_context_progress()
        w.tick(2)

        recovery = max((run for run in w.store.runs(b["id"]) if run["task"] == "001"), key=lambda run: run["id"])
        self.assertEqual(recovery["kind"], "c_chunk_scope_recovery")
        self.assertEqual(recovery["session_id"], source_run["session_id"])
        self.assertEqual(self.data(w, "001")["recovery"]["pending_sense_ids"], active_ids)
        prompt = w.adapter.launches[-1]["prompt"]
        self.assertIn("Supervisor가 배정한 조회 허용 ID(아래 문자열을 그대로 복사): " + ", ".join(active_ids), prompt)
        self.assertNotIn(sibling_ids[0], prompt)

    def test_legacy_scope_error_with_missing_claude_status_stays_fail_closed(self):
        w, b, _active_ids, _sibling_ids, _source_run = self._claude_scope_error_after_context_progress(
            final_tool_error=None)
        w.tick(2)

        self.assertEqual(self.b(w)["state"], "ERROR")
        self.assertFalse(any(run["kind"] == "c_chunk_scope_recovery" for run in w.store.runs(b["id"])))

    def test_unsaved_legacy_scope_recovery_is_not_started_twice(self):
        w = self.world(senses=12)
        w.start("single", "deepseek", "c")
        w.tick()
        _, source_run = self._fail_legacy_chunk_scope_run(w)
        w.tick(2)
        scope_runs = [run for run in w.store.runs(self.b(w)["id"]) if run["kind"] == "c_chunk_scope_recovery"]
        self.assertEqual(len(scope_runs), 1)
        self.assertEqual(scope_runs[0]["session_id"], source_run["session_id"])

        self.finish(w, "001", save=False)
        w.tick(2)
        status = control.line_status(w.store, "deepseek", "c")
        self.assertEqual(self.tasks(w)["001"]["state"], "FAILED")
        self.assertEqual(self.data(w, "001")["guard"]["reason_codes"], ["scope_recovery_not_saved"])
        self.assertFalse(status["can_retry"])
        self.assertFalse(control.retry(w.store, "deepseek", "c"))
        w.tick(3)
        self.assertEqual(len([run for run in w.store.runs(self.b(w)["id"])
                             if run["kind"] == "c_chunk_scope_recovery"]), 1)

    def test_scope_recovery_stopped_by_usage_limit_pauses_and_retry_resumes_the_same_approval(self):
        # PR #5990 review: the one-shot legacy scope recovery returned before classification, so a usage_limit death
        # became ERROR with an unchanged-evidence guard: Retry blocked, reset time lost.
        from warroom.adapters import classify_codex_failure
        limit = json.dumps({"type": "turn.failed", "error": {
            "message": "You've hit your usage limit. Upgrade to Pro or try again at Nov 16th, 2026 11:41 PM."}})
        w = self.world(senses=12)
        w.start("single", "deepseek", "c")
        w.tick()
        _, source_run = self._fail_legacy_chunk_scope_run(w)
        w.tick(2)
        scope = [r for r in w.store.runs(self.b(w)["id"]) if r["kind"] == "c_chunk_scope_recovery"]
        self.assertEqual(len(scope), 1)
        recovery = self.data(w, "001")["recovery"]
        w.sup._classify_run = lambda _p, log: classify_codex_failure(Path(log).read_text("utf-8"), [])
        w.adapter.running[scope[0]["pid"]].update(code=1, text=limit)
        w.adapter.finish(scope[0]["pid"])
        w.tick(2)
        b, data = self.b(w), self.data(w, "001")
        self.assertEqual((b["state"], self.tasks(w)["001"]["state"]), ("PAUSED", "FAILED"))
        self.assertNotEqual(b["pause_reason"], "shared_defect")
        self.assertIn("limit_until", data)
        self.assertNotIn("guard", data)
        self.assertEqual(data["limit_scope_recovery"]["pending_sense_ids"], recovery["pending_sense_ids"])
        self.assertTrue(control.line_status(w.store, "deepseek", "c")["can_retry"])
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.tick(3)
        scope = [r for r in w.store.runs(self.b(w)["id"]) if r["kind"] == "c_chunk_scope_recovery"]
        self.assertEqual(len(scope), 2)                                     # the same approval, relaunched once
        self.assertEqual(scope[0]["session_id"], source_run["session_id"])  # in the preserved session
        self.assertEqual(self.data(w, "001")["recovery"]["pending_sense_ids"], recovery["pending_sense_ids"])

    @staticmethod
    def _write_no_submit_log(w, run, *, query=True, extra_cli_commands=()):
        info = w.adapter.running[run["pid"]]
        events = [{"type": "thread.started", "thread_id": run["session_id"]}]
        events.extend({"type": "item.completed", "item": {"id": f"extra-cli-{index + 1}",
                       "type": "command_execution", "command": command, "exit_code": 0,
                       "aggregated_output": "FORM_ADDED\n"}}
                      for index, command in enumerate(extra_cli_commands))
        if query:
            events.append({"type": "item.completed", "item": {"id": "context-query", "type": "command_execution",
                           "command": f"node {literary.cli_path()} chunk --db approved.sqlite "
                                      "--checkpoint .warroom-scratch/001_01_c_deepseek.checkpoint.json "
                                      "--sense-ids s0000 --skip 8 --contexts 16 --format text --chunk 001",
                           "exit_code": 0}})
        events.extend([
            {"type": "item.completed", "item": {"id": "answer", "type": "agent_message",
             "text": "All reviewed contexts were unrelated. I did not call submit."}},
            {"type": "turn.completed", "usage": {"input_tokens": 1, "cached_input_tokens": 0,
                                                        "output_tokens": 1, "reasoning_output_tokens": 0}},
        ])
        info["text"] = "".join(json.dumps(event) + "\n" for event in events)
        w.adapter.finish(run["pid"])

    def test_context_only_state_change_gets_one_recovery_and_repeated_no_submit_blocks(self):
        w = self.world(senses=12)
        w.start("single", "deepseek", "c")
        w.tick()
        w.tick()  # bind the exact task session before the finished-run evidence is inspected
        b = self.b(w)
        rec = self._prepare_sixteen_context_state(w)
        run = self.open_runs(w)[0]
        self._write_no_submit_log(w, run)
        w.tick()

        data = self.data(w, "001")
        recovery = next(run for run in w.store.runs(b["id"]) if run["kind"] == "c_chunk_recovery")
        self.assertEqual(data["recovery"]["source_run_id"], run["id"])
        self.assertEqual(data["recovery"]["pending_sense_ids"], rec["sense_ids"])
        self.assertEqual(self.tasks(w)["001"]["state"], "RUNNING")
        recovery_prompt = next(launch["prompt"] for launch in reversed(w.adapter.launches)
                               if "16문맥 상한 Sense" in launch["prompt"])
        self.assertIn("--skip 8 --contexts 16", recovery_prompt)
        self.assertIn("shown=16", recovery_prompt)
        self.assertIn("--skip 12 --contexts 16", recovery_prompt)
        self.assertIn("마지막으로 완전히 판독한 앞 문맥 수", recovery_prompt)
        self.assertIn("추가 문맥을 하나도 온전히 받지 못했을 때만", recovery_prompt)
        self.assertNotIn("`--skip 8 --contexts 16` 조회만 사용", recovery_prompt)
        self.assertIn("SAMPLED_NO_VERIFIED", recovery_prompt)
        self.assertIn("`--skip 16`은 호출하지 않는다.", recovery_prompt)

        self._write_no_submit_log(w, recovery, query=False)
        w.tick()
        self.assertEqual(sum(run["kind"] == "c_chunk_recovery" for run in w.store.runs(b["id"])), 1)
        self.assertEqual(self.tasks(w)["001"]["state"], "FAILED")
        self.assertFalse(control.line_status(w.store, "deepseek", "c")["can_retry"])

    def test_old_checkpoint_changed_guard_exposes_one_owner_retry_for_the_exact_sample(self):
        w = self.world(senses=24)
        w.start("single", "deepseek", "c")
        w.tick()
        w.tick()
        b = self.b(w)
        completed_ids = self.sense_ids(w, "002")
        self.finish(w, "002")
        w.tick()
        checkpoint_before = json.loads((w.wt() / literary.names(b).checkpoint).read_text("utf-8"))
        saved_before = {sense["sense_id"]: sense["submission"] for record in checkpoint_before["records"]
                        for sense in record["senses"] if sense["sense_id"] in completed_ids}

        rec = self._prepare_sixteen_context_state(w)
        row = w.store.task_row(b["id"], "001")
        run = w.store.run(row["run_id"])
        self._write_no_submit_log(w, w.store.run(run["id"]))
        run = w.store.run(run["id"])
        w.store.finish_run(run["id"], "0")
        run = w.store.run(run["id"])
        data = self.data(w, "001")
        before = data["run_start"]["retry_state"]["own_state"]
        before_checkpoint = json.loads((w.wt() / literary.names(b).checkpoint).read_text("utf-8"))
        initial = json.loads(json.dumps(before_checkpoint))
        target = rec["sense_ids"][0]
        for record in initial["records"]:
            for sense in record["senses"]:
                if sense.get("sense_id") == target:
                    sense["shown"]["unit_rowids"] = sense["shown"]["unit_rowids"][:8]
        old_digest = hashlib.sha256(json.dumps(
            [sense for record in initial["records"] for sense in record["senses"] if sense["sense_id"] in rec["sense_ids"]],
            sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        data["run_start"]["retry_state"]["own_state"] = old_digest
        row = w.store.task_row(b["id"], "001")
        w.store.update_task(b["id"], "001", data=json.dumps(data, ensure_ascii=False, sort_keys=True))

        current_digest = literary._legacy_own_state(w.wt(), b, rec["sense_ids"])
        baseline = literary.retry_state(w.wt(), b, rec, rec["sense_ids"], session_available=True, task_state=True)
        baseline["own_state"] = current_digest
        failure_data = self.data(w, "001")
        failure_data["guard"] = {"baseline": baseline, "reason_codes": ["checkpoint_changed_without_pending_progress"]}
        w.sup.cp._task_failed(b, row, failure_data, "[001] C legacy no-submit guard")
        w.sup.cp._halt(b, [w.store.task_row(b["id"], "001")])

        self.assertTrue(control.line_status(w.store, "deepseek", "c")["can_retry"])
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.tick(2)
        task_data = self.data(w, "001")
        launched = max((run for run in w.store.runs(b["id"]) if run["task"] == "001"), key=lambda run: run["id"])
        self.assertEqual(launched["kind"], "c_chunk_recovery")
        self.assertEqual(task_data["recovery"]["source_run_id"], run["id"])
        self.assertEqual(task_data.get("operator_grants", 0), 0)
        self.assertEqual(self.tasks(w)["002"]["state"], "SAVED")

        self.finish(w, "001")
        w.tick(2)
        checkpoint_after = json.loads((w.wt() / literary.names(b).checkpoint).read_text("utf-8"))
        submissions_after = {sense["sense_id"]: sense["submission"] for record in checkpoint_after["records"]
                             for sense in record["senses"]}
        self.assertEqual({sense_id: submissions_after[sense_id] for sense_id in saved_before}, saved_before)
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")
        self.assertEqual(w.store.batch(b["id"])["state"], "WAITING_REVIEW")

    def test_prompt_contract_covers_finite_sampling_for_new_and_resumed_chunks(self):
        batch = {"shard": "001", "batch": "01", "producer": "deepseek"}
        batch["branch"] = "c-deepseek-001-01"
        card = prompts.c_chunk(batch, 10, ".warroom-scratch/checkpoint.json",
                               view="batch=001_01 done=0/12 zero_hit=0 not_yet_read=0\n\n## s1 — 표제 [noun]\n뜻\nhits=20 unseen=4\n")
        resume = prompts.c_chunk_resume(10, ".warroom-scratch/checkpoint.json", ["s1"])
        for text in (card, resume):
            self.assertIn("최대 16개", text)
            self.assertIn("SAMPLED_NO_VERIFIED", text)
            self.assertIn("--skip 8 --contexts 16", text)
        self.assertIn("unshown_empty_sample", resume)


if __name__ == "__main__":
    unittest.main()
