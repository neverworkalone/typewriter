"""Production lanes and the two Maintainer paths share the same L1."""
import threading
import unittest
from unittest.mock import patch

from tests.test_issue_1555 import world, make_batch, break_batch, incidents
from warroom.lanes import Lanes, OrderedLock

from tests.fakes import no_anchor_module

setUpModule, tearDownModule = no_anchor_module()   # #3801: runs without the test-only Store anchor


class LaneMaintenance(unittest.TestCase):
    def setUp(self):
        self.w = world()
        self.w.sup.maint.__dict__.pop("_intake_errors", None)

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_busy_lane_skips_intake_and_release_but_other_lane_proceeds(self):
        w = self.w
        first = break_batch(w, make_batch(w, 'd', 'deepseek', '001'))
        second = break_batch(w, make_batch(w, 'c', 'sonnet', '002', run_kind='c_chunk_new'))
        entered, release = threading.Event(), threading.Event()
        def producer():
            with w.sup.lanes.try_hold('deepseek', 'd') as held:
                self.assertTrue(held)
                entered.set()
                self.assertTrue(release.wait(5))
        thread = threading.Thread(target=producer)
        thread.start()
        try:
            self.assertTrue(entered.wait(5))
            w.sup.maint._intake_errors()
            self.assertEqual(w.store.batch(first['id'])['state'], 'ERROR')
            self.assertEqual(w.store.batch(second['id'])['state'], 'PAUSED')
            # A pending fix for the busy lane must not invoke the integration path.
            with patch.object(w.store, 'defects', return_value=[{'id': 99, 'batch_id': first['id'], 'source': 'incident'}]), \
                 patch.object(w.sup.maint, '_release_locked') as apply:
                w.sup.maint._release()
                apply.assert_not_called()
        finally:
            release.set()
            thread.join(5)
        w.sup.maint._intake_errors()
        self.assertEqual(w.store.batch(first['id'])['state'], 'PAUSED')
        self.assertEqual(len(incidents(w)), 2)

    def test_release_skips_busy_lane_and_rechecks_other_lane(self):
        w = self.w
        first = break_batch(w, make_batch(w, 'd', 'deepseek', '001'))
        second = break_batch(w, make_batch(w, 'c', 'sonnet', '002', run_kind='c_chunk_new'))
        w.sup.maint._intake_errors()
        for defect in incidents(w):
            w.store.update_defect(defect['id'], state='FIX_MERGED', merge_sha='a' * 40)
        entered, release = threading.Event(), threading.Event()
        def producer():
            with w.sup.lanes.try_hold('deepseek', 'd') as held:
                self.assertTrue(held)
                entered.set()
                self.assertTrue(release.wait(5))
        thread = threading.Thread(target=producer)
        thread.start()
        try:
            self.assertTrue(entered.wait(5))
            with patch.object(w.sup.maint, '_release_incident') as apply:
                w.sup.maint._release()
                self.assertEqual([call.args[1]['id'] for call in apply.call_args_list], [second['id']])
                w.store.set_line('sonnet', 'c', force_stop=1)
                apply.reset_mock()
                w.sup.maint._release()
                apply.assert_not_called()
        finally:
            release.set()
            thread.join(5)
        with patch.object(w.sup.maint, '_release_incident') as apply:
            w.sup.maint._release()
            self.assertEqual([call.args[1]['id'] for call in apply.call_args_list], [first['id']])

    def test_intake_reloads_state_after_candidate_snapshot(self):
        w = self.w
        b = break_batch(w, make_batch(w))
        old = w.store.intake_candidates()
        w.store.update(b['id'], state='PRODUCING')
        with patch.object(w.store, 'intake_candidates', return_value=old), patch.object(w.sup.maint, '_intake') as intake:
            w.sup.maint._intake_errors()
            intake.assert_not_called()

    def test_lock_order_and_non_reentrant_lane(self):
        lanes = Lanes()
        verify, repo = OrderedLock(3), OrderedLock(4, reentrant=True)
        with lanes.try_hold('p', 'd') as held:
            self.assertTrue(held)
            with verify, repo, repo:
                with self.assertRaises(RuntimeError):
                    with lanes.try_hold('q', 'c'):
                        pass
            with self.assertRaises(RuntimeError):
                with lanes.try_hold('p', 'd'):
                    pass
