"""The Maintainer never evaluates production evidence while its lane is active."""
import json
import threading
import unittest
from unittest.mock import patch

from tests import test_issue_3614 as fixtures
from tests.test_issue_1555 import make_batch


class RecoveryLaneTests(unittest.TestCase):
    def producer(self, sup, action):
        entered, release = threading.Event(), threading.Event()
        def run():
            with sup.lanes.try_hold('deepseek', 'd') as held:
                self.assertTrue(held)
                action()
                entered.set()
                self.assertTrue(release.wait(5))
        thread = threading.Thread(target=run)
        thread.start()
        self.assertTrue(entered.wait(5))
        self.addCleanup(thread.join, 5)
        self.addCleanup(release.set)
        return release, thread

    def test_saved_and_error_transitions_wait_for_producer(self):
        for outcome in ('saved', 'error'):
            with self.subTest(outcome=outcome):
                fixture = fixtures.MergedFixProgress()
                fixture.setUp()
                self.addCleanup(fixture.doCleanups)
                w = fixture.w
                batch_id, defect_id = fixture.prepare_released_fix()
                def transition():
                    if outcome == 'saved':
                        w.store.update_task(batch_id, '002', state='SAVED')
                    else:
                        w.store.update(batch_id, state='ERROR', error='failed again')
                release, thread = self.producer(w.sup, transition)
                w.sup.maint._verify_recovery_progress()
                proof = json.loads(w.store.get(f'defect_recovery_{defect_id}'))
                self.assertNotIn('status', proof)
                self.assertEqual(w.store.defect(defect_id)['state'], 'RELEASED')
                release.set()
                thread.join(5)
                w.sup.maint._verify_recovery_progress()
                proof = json.loads(w.store.get(f'defect_recovery_{defect_id}'))
                self.assertEqual(proof['status'], 'VERIFIED' if outcome == 'saved' else 'RECURRENCE')
                self.assertEqual(w.store.defect(defect_id)['state'], 'RELEASED' if outcome == 'saved' else 'HELD')

    def test_busy_source_does_not_block_another_recovery(self):
        fixture = fixtures.MergedFixProgress()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        w = fixture.w
        first, _ = fixture.prepare_released_fix()
        other = make_batch(w, 'c', 'sonnet', '002', run_kind='c_parallel')
        defect = w.store.report_defect(other['id'], 'independent', 'report', 'independent',
                                       'RELEASED', '{}', 'shared_defect', None)
        w.store.update_defect(defect, issue_number=102, fix_kind='runtime')
        release, thread = self.producer(w.sup, lambda: None)
        with patch.object(w.sup.maint, '_verify_recovery_progress_locked') as verify:
            w.sup.maint._verify_recovery_progress()
            self.assertEqual([call.args[0]['batch_id'] for call in verify.call_args_list], [other['id']])
        release.set()
        thread.join(5)

    def test_handoff_transaction_rechecks_stop_and_single_source(self):
        fixture = fixtures.NoCodeRecovery()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        w = fixture.w
        batch_id, defect_id, maint, _ = fixture.prepare_failed_d_task()
        w.store.set_line('deepseek', 'd', force_stop=1)
        self.assertFalse(w.store.complete_diagnosis(maint['id'], 101, 'blocked', expected_defect_id=defect_id))
        self.assertEqual(w.store.defect(defect_id)['state'], 'LINKED')
        self.assertEqual(w.store.batch(batch_id)['state'], 'PAUSED')

    def test_c_report_from_fix_run_is_authorized(self):
        fixture = fixtures.NoCodeRecovery()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        w = fixture.w
        batch_id, defect_id, maint, _ = fixture.prepare_failed_d_task()
        row = w.store.task_row(batch_id, '002')
        with w.store._conn() as c:
            c.execute("UPDATE batches SET method='c', run_kind='c_parallel' WHERE id=?", (batch_id,))
            c.execute("UPDATE runs SET kind='c_chunk_fix' WHERE id=?", (row['run_id'],))
            c.execute("UPDATE runs SET ended_at=1 WHERE batch_id=? AND ended_at IS NULL", (maint['id'],))
        source = w.store.batch(batch_id)
        owner = {'task': '002', 'chunk': '002', 'row_state': 'FAILED', 'task_run_id': row['run_id'],
                 'run_id': row['run_id'], 'run_kind': 'c_chunk_fix', 'session_id': row['session_id'],
                 'path': 'report.json'}
        proof = {'batch_id': batch_id, 'event_key': w.store.defect(defect_id)['event_key'],
                 'source_error_seq': source['error_seq'], 'task': '002', 'chunk': '002',
                 'recovery_type': 'resume_report_task', 'baseline_task_state': 'FAILED',
                 'baseline_task_run_id': row['run_id'], 'session_id': row['session_id'],
                 'run_id': row['run_id'], 'task_report_path': 'report.json', 'task_report': owner}
        self.assertTrue(w.store.approve_no_code_resume(maint['id'], 101, defect_id, proof))
        self.assertEqual(w.store.batch(batch_id)['state'], 'PRODUCING')
        self.assertEqual(w.store.defect(defect_id)['state'], 'RECOVERING')

    def test_serial_worktree_progress_is_read_under_source_lane(self):
        fixture = fixtures.NoCodeRecovery()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        w = fixture.w
        batch_id, defect_id, maint, _ = fixture.prepare_failed_d_task()
        proof = {'version': 3, 'outcome': 'no_code_resume', 'batch_id': batch_id, 'defect_id': defect_id,
                 'task': None, 'chunk': '002', 'source_error_seq': 0, 'cause': 'fixture'}
        w.store.set(f'm_diag_{maint["id"]}', json.dumps(proof))
        w.store.update_maintenance(101, state='RECOVERING')
        w.store.update_defect(defect_id, state='RECOVERING')
        def read_under_lock(_proof):
            with self.assertRaises(RuntimeError):
                with w.sup.lanes.try_hold('deepseek', 'd'):
                    pass
            return False
        with patch.object(w.sup.maint, '_serial_recovery_progress', side_effect=read_under_lock) as read:
            w.sup.maint._verify_no_code_recoveries()
            read.assert_called_once()

    def test_diagnosis_and_no_code_progress_defer_until_source_is_free(self):
        fixture = fixtures.NoCodeRecovery()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        w = fixture.w
        batch_id, defect_id, maint, _ = fixture.prepare_failed_d_task()
        release, thread = self.producer(w.sup, lambda: None)
        with patch.object(w.sup.maint, '_finish_diagnosis_locked', return_value=True) as finish:
            self.assertTrue(w.sup.maint.finish_diagnosis(maint))
            w.sup.maint._resume_diagnoses()
            finish.assert_not_called()
        release.set()
        thread.join(5)
        w.store.set_line('deepseek', 'd', force_stop=1)
        with patch.object(w.sup.maint, '_finish_diagnosis_locked') as finish:
            self.assertTrue(w.sup.maint.finish_diagnosis(maint))
            finish.assert_not_called()
        w.store.set_line('deepseek', 'd', force_stop=0)
        proof = {'version': 3, 'outcome': 'no_code_resume', 'batch_id': batch_id, 'defect_id': defect_id,
                 'task': '002', 'chunk': '002', 'source_error_seq': 0, 'cause': 'fixture'}
        w.store.set(f'm_diag_{maint["id"]}', json.dumps(proof))
        w.store.set(f'no_code_approval_{defect_id}', json.dumps({'status': 'APPROVED'}))
        w.store.update_defect(defect_id, state='RECOVERING')
        w.store.update_maintenance(101, state='RECOVERING')
        release, thread = self.producer(w.sup, lambda: w.store.update_task(batch_id, '002', state='SAVED'))
        w.sup.maint._verify_no_code_recoveries()
        self.assertEqual(w.store.defect(defect_id)['state'], 'RECOVERING')
        release.set()
        thread.join(5)
        w.sup.maint._verify_no_code_recoveries()
        self.assertEqual(w.store.defect(defect_id)['state'], 'RELEASED')
