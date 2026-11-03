"""Issue #3129: a finite C literary-context sample is normal progress and can recover once."""
import hashlib
import json
import unittest
from pathlib import Path

from tests.test_issue_3076 import Helpers
from warroom import literary, prompts, control


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

    @staticmethod
    def _write_no_submit_log(w, run, *, query=True):
        info = w.adapter.running[run["pid"]]
        events = [{"type": "thread.started", "thread_id": run["session_id"]}]
        if query:
            events.append({"type": "item.completed", "item": {"id": "context-query", "type": "command_execution",
                           "command": "node scripts/relation/literary-context-cli.mjs chunk --db approved.sqlite "
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


if __name__ == "__main__":
    unittest.main()
