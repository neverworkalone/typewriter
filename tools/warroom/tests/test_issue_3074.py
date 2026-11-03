"""Issue #3074 PR 2: Method D runs its 25-record chunks as up to four parallel War Room tasks inside one batch."""
import json
import unittest

from pathlib import Path

from tests.test_issue_2034_d import DWorld, REL
from warroom import control, dchunk, taskruns


class ParallelDHelpers:
    def world(self, records=250, **kw):
        w = DWorld(records=records, parallel=True, **kw)
        self.addCleanup(w.tmp.cleanup)
        return w

    @staticmethod
    def saver(w, chunk, session=None, code=0):
        """A fake AI whose finish saves exactly this chunk through the CLI (as the real worker's `save` does)."""
        return {"code": code, "session": session or f"ses_{chunk}",
                "effect": lambda: w.runner.dchunk.save(w.wt(), chunk)}

    def plan_all(self, w, chunks):
        for n in chunks:
            w.adapter.plan.append(self.saver(w, n))

    @staticmethod
    def open_runs(w):
        return taskruns.open_runs(w.store, w.row_()["id"])

    @staticmethod
    def tasks(w):
        return {r["task"]: r for r in w.store.task_rows(w.row_()["id"])}

    @staticmethod
    def finish_task(w, task):
        row = w.store.task_row(w.row_()["id"], task)
        run = w.store.run(row["run_id"])
        pid = next(l["pid"] for l in w.adapter.launches if w.adapter.running.get(l["pid"], {}).get("log") == Path(run["log_file"]))
        w.adapter.finish(pid)


class ParallelD(ParallelDHelpers, unittest.TestCase):
    def test_four_slots_refill_one_by_one_and_one_pr_in_chunk_order(self):
        w = self.world()
        self.plan_all(w, range(1, 11))
        w.start("single", "deepseek", "d")
        w.tick()
        b = w.row_()
        self.assertEqual((b["state"], b["run_kind"], b["pid"]), ("PRODUCING", "d_parallel", None))
        self.assertEqual(w.store.get(f"d_mode_{b['id']}"), "parallel")
        self.assertEqual(sorted(self.tasks(w)), [f"{n:03d}" for n in range(1, 11)])
        self.assertEqual(len(self.open_runs(w)), dchunk.MAX_PARALLEL)
        self.assertEqual(sorted(r["task"] for r in self.open_runs(w)), ["001", "002", "003", "004"])
        self.assertTrue(all(l["kind"] == "start" for l in w.adapter.launches))
        # no wave barrier: one finished run frees one slot, immediately refilled with the next chunk in number order
        self.finish_task(w, "003")
        w.tick()
        self.assertEqual(self.tasks(w)["003"]["state"], "SAVED")
        self.assertEqual(sorted(r["task"] for r in self.open_runs(w)), ["001", "002", "004", "005"])
        for _ in range(12):
            self.assertLessEqual(len(self.open_runs(w)), dchunk.MAX_PARALLEL)
            for r in list(self.open_runs(w)):
                self.finish_task(w, r["task"])
            w.tick()
        b = w.row_()
        self.assertEqual((b["state"], b["pr_number"]), ("WAITING_REVIEW", 100))
        self.assertEqual(len(w.gh.created_prs), 1)
        self.assertEqual(len(w.adapter.launches), 10)
        assembled = (w.wt() / REL).read_text().splitlines()
        self.assertEqual([json.loads(l)["record_id"] for l in assembled], [r["id"] for r in w.runner.dchunk.rows()])
        self.assertIn("최대 4개", w.gh.created_prs[0]["body"])

    def test_stored_chunk_does_not_free_its_slot_until_the_process_is_gone(self):
        w = self.world()
        self.plan_all(w, range(1, 11))
        w.start("single", "deepseek", "d")
        w.tick()
        w.runner.dchunk.save(w.wt(), 1)                      # the worker has saved but is still finishing
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 4)
        self.assertEqual(self.tasks(w)["001"]["state"], "RUNNING")
        self.assertEqual(len(self.open_runs(w)), 4)
        self.finish_task(w, "001")
        w.tick()
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")
        self.assertEqual(w.store.run(self.tasks(w)["001"]["run_id"] or 1)["task"], "001")
        self.assertIsNone(w.store.get(f"d_chunk_sha_{w.row_()['id']}_2"))
        self.assertIsNotNone(w.store.get(f"d_chunk_sha_{w.row_()['id']}_1"))
        self.assertEqual(len(w.adapter.launches), 5)

    def test_automatic_chunks_use_no_slot_and_no_ai(self):
        w = self.world()
        w.runner.dchunk.auto = {2, 3}
        self.plan_all(w, [1, 4, 5, 6, 7, 8, 9, 10])
        w.start("single", "deepseek", "d")
        w.tick()
        self.assertEqual(sorted(r["task"] for r in self.open_runs(w)), ["001", "004", "005", "006"])
        self.assertEqual({t: r["state"] for t, r in self.tasks(w).items() if t in ("002", "003")}, {"002": "SAVED", "003": "SAVED"})
        self.assertEqual(len(w.adapter.launches), 4)

    def test_stored_chunk_found_without_a_run_is_accepted_without_an_ai_call(self):
        w = self.world()
        self.plan_all(w, range(1, 11))
        w.start("single", "deepseek", "d")
        w.tick()
        w.runner.dchunk.save(w.wt(), 9)                      # stored, its task still waiting (e.g. interrupted just after save)
        w.sup.dp._seen.clear()                                # a restarted Supervisor proves stored chunks once
        launches = len(w.adapter.launches)
        w.tick()
        self.assertEqual(self.tasks(w)["009"]["state"], "SAVED")
        self.assertEqual(len(w.adapter.launches), launches)

    def test_stop_returns_unsaved_tasks_and_retry_continues_only_them(self):
        w = self.world(records=100)
        self.plan_all(w, range(1, 7))
        w.start("single", "deepseek", "d")
        w.tick()
        self.finish_task(w, "001")
        w.tick()
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")
        control.stop_line(w.store, "deepseek", "d")
        w.tick(2)
        b = w.row_()
        self.assertEqual(b["state"], "PAUSED")
        self.assertEqual(self.open_runs(w), [])
        states = {t: r["state"] for t, r in self.tasks(w).items()}
        self.assertEqual(states["001"], "SAVED")
        self.assertTrue(all(s in ("FIXQ", "PENDING") for t, s in states.items() if t != "001"))
        self.assertEqual(w.adapter.running, {})
        before = len(w.adapter.launches)
        self.assertTrue(control.retry(w.store, "deepseek", "d"))
        w.tick(2)
        self.assertEqual(len(self.open_runs(w)), 3)
        self.assertEqual(len(w.adapter.launches), before + 3)
        self.assertTrue(all(l["kind"] == "resume" or "session" not in l for l in w.adapter.launches[before:]))
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")


class ParallelDCorrections(ParallelDHelpers, unittest.TestCase):
    @staticmethod
    def rejecter(w, chunk, session):
        """A fake AI whose `save` was rejected: the decision file stays and the CLI's diagnostic for this chunk is written."""
        def effect():
            b, wt = w.row_(), w.wt()
            rec = dchunk.read_active(wt, b, chunk)
            names = dchunk.chunk_names(b, chunk)
            sense = rec["senses"][0]
            record = sense["sense_id"].rsplit("-s", 1)[0]
            error = f"{sense['ref']}: Z needs every recorded search of this record to be complete with 0 hits"
            (wt / names.decisions).write_text(f"{sense['ref']} Z\n")
            (wt / names.rejected).write_text(json.dumps({
                "diagnostic": "save_rejected", "chunk_no": chunk, "view_sha256": rec["view_sha256"], "git_head": rec["git_head"],
                "repair_scope": "decisions", "senses": [sense["ref"]], "errors": [error],
                "failed_records": [{"record_id": record, "failed_sense_ids": [sense["sense_id"]], "errors": [error]}],
                "decisions_sha256": dchunk.sha256_bytes((wt / names.decisions).read_bytes()),
                "searches_sha256": dchunk.sha256_bytes((wt / names.searches).read_bytes()), "error_count": 1}))
        return {"code": 0, "session": session, "effect": effect}

    def test_a_rejected_chunk_is_corrected_in_its_own_session_while_others_save(self):
        w = self.world(records=100)
        w.adapter.plan += [self.rejecter(w, 1, "ses_1"), self.saver(w, 2), self.saver(w, 3), self.saver(w, 4), self.saver(w, 1, "ses_1")]
        w.start("single", "deepseek", "d")
        w.tick()
        bid = w.row_()["id"]
        self.finish_task(w, "001")
        self.finish_task(w, "002")
        w.tick()
        states = {t: r["state"] for t, r in self.tasks(w).items()}
        self.assertEqual((states["001"], states["002"]), ("RUNNING", "SAVED"))
        fix = w.adapter.launches[-1]
        self.assertEqual((fix["kind"], fix["session"]), ("resume", "ses_1"))
        self.assertIn(dchunk.fix_problem(dchunk.read_rejection(w.wt(), w.row_(), dchunk.read_active(w.wt(), w.row_(), 1))), fix["prompt"])
        self.assertEqual(w.store.get(dchunk.fix_key(bid, 1)), "1")
        self.assertIsNone(w.store.get(dchunk.fix_key(bid, 2)))
        self.assertEqual([r["kind"] for r in w.store.runs(bid) if r["task"] == "001"], ["d_chunk_fix", "d_chunk_new"])
        for task in ("003", "004", "001"):
            self.finish_task(w, task)
        w.tick()
        self.assertEqual(w.row_()["state"], "WAITING_REVIEW")
        self.assertEqual(w.store.get(dchunk.fix_key(bid, 1)), "1")   # history kept; nothing re-granted without a Retry

    def test_search_failed_chunk_stops_new_launches_and_pauses_after_running_ones_finish(self):
        w = self.world(records=250)
        w.runner.dchunk.failed = {2}
        self.plan_all(w, [1, 3, 4, 5, 6, 7, 8, 9, 10])
        w.start("single", "deepseek", "d")
        w.tick()
        self.assertEqual(self.tasks(w)["002"]["state"], "FAILED")
        self.assertEqual(sorted(r["task"] for r in self.open_runs(w)), ["001"])   # nothing after the failure is assigned
        self.finish_task(w, "001")
        w.tick(2)
        b = w.row_()
        self.assertEqual((b["state"], self.tasks(w)["001"]["state"]), ("PAUSED", "SAVED"))   # SEARCH_FAILED pauses
        self.assertIn("SEARCH_FAILED", b["error"])
        self.assertEqual(len(w.adapter.launches), 1)


class ParallelDRecovery(ParallelDHelpers, unittest.TestCase):
    def test_chunk_saved_before_stop_is_accepted_on_retry_not_run_again(self):
        w = self.world(records=100)
        self.plan_all(w, range(1, 8))
        w.start("single", "deepseek", "d")
        w.tick()
        w.runner.dchunk.save(w.wt(), 1)                      # saved, then the operator stops the still-running worker
        control.stop_line(w.store, "deepseek", "d")
        w.tick(2)
        self.assertEqual(w.row_()["state"], "PAUSED")
        before = len(w.adapter.launches)
        self.assertTrue(control.retry(w.store, "deepseek", "d"))
        w.tick(2)
        self.assertEqual(self.tasks(w)["001"]["state"], "SAVED")
        self.assertEqual(len(w.adapter.launches), before + 3)    # only chunks 2-4 are run again

    def test_failed_task_waiting_for_a_running_one_is_reentered_by_one_retry_after_stop(self):
        w = self.world(records=100)
        w.runner.dchunk.failed = {2}
        self.plan_all(w, range(1, 8))
        w.start("single", "deepseek", "d")
        w.tick()
        self.assertEqual(self.tasks(w)["002"]["state"], "FAILED")
        self.assertEqual([r["task"] for r in self.open_runs(w)], ["001"])
        control.stop_line(w.store, "deepseek", "d")
        w.tick(2)
        self.assertEqual(w.row_()["state"], "PAUSED")
        w.runner.dchunk.failed = set()                        # the operator fixed the index
        self.assertTrue(control.retry(w.store, "deepseek", "d"))
        w.tick(2)
        self.assertNotEqual(self.tasks(w)["002"]["state"], "FAILED")
        self.assertIn("002", {r["task"] for r in self.open_runs(w)})

    def test_twin_report_archive_resumes_after_a_partial_failure(self):
        from unittest import mock
        from warroom import defects, dparallel
        w = self.world(records=100)
        self.plan_all(w, range(1, 5))
        w.start("single", "deepseek", "d")
        w.tick()
        b = w.row_()
        raw = '{"defect_class": "x"}'
        paths = [w.wt() / dparallel.defect_path(b, t) for t in ("001", "002")]
        for p in paths:
            p.write_text(raw)
        w.store.set(f"s2_defect_path_{b['id']}", dparallel.defect_path(b, "001"))
        d = {"id": 1, "event_key": defects.report_event_key(b["id"], raw)}
        real, state = Path.replace, {"fail": True}

        def flaky(self_, target):
            if self_.name == "shared-defect-002.json" and state["fail"]:
                state["fail"] = False
                raise OSError("disk")
            return real(self_, target)
        with mock.patch.object(Path, "replace", flaky):
            self.assertFalse(w.sup.maint._archive_report(d, b))
            self.assertTrue(w.sup.maint._archive_report(d, b))
        self.assertFalse(paths[0].exists() or paths[1].exists())

    def test_automatic_stop_keeps_failed_tasks_unacknowledged(self):
        w = self.world(records=100)
        w.runner.dchunk.failed = {2}
        self.plan_all(w, range(1, 8))
        w.start("single", "deepseek", "d")
        w.tick()
        w.sup.dp.stop_workers(w.row_())                       # what a detected shared-defect report does
        self.assertNotIn('"ack"', w.store.task_row(w.row_()["id"], "002")["data"])
        w.runner.dchunk.failed = set()
        w.tick(3)                                             # an automatic release alone never re-enters the failure
        self.assertEqual(w.store.task_row(w.row_()["id"], "002")["state"], "FAILED")
