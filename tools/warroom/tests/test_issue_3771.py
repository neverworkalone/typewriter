"""The isolated Coordinator advances independent lines without queuing unlimited jobs."""
import threading
import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from tests.test_issue_2034_d import DWorld
from warroom.config import config_problem
from warroom.restart_controller import record_runtime
from warroom.store import LineBusy

from tests.fakes import no_anchor_module

setUpModule, tearDownModule = no_anchor_module()   # #3801: runs without the test-only Store anchor


class ManualTicks:
    def __init__(self):
        self.condition = threading.Condition()
        self.cycles = 0
        self.permits = 0
        self.stopped = False

    def is_set(self):
        with self.condition:
            return self.stopped

    def wait(self, _timeout):
        with self.condition:
            self.cycles += 1
            self.condition.notify_all()
            self.condition.wait_for(lambda: self.stopped or self.permits > 0, timeout=5)
            if self.permits:
                self.permits -= 1
            return self.stopped

    def cycle(self, n):
        with self.condition:
            self.permits += 1
            self.condition.notify_all()
            return self.condition.wait_for(lambda: self.cycles >= n, timeout=5)

    def wait_for_cycle(self, n):
        with self.condition:
            return self.condition.wait_for(lambda: self.cycles >= n, timeout=5)

    def stop(self):
        with self.condition:
            self.stopped = True
            self.condition.notify_all()


class ParallelCoordinator(unittest.TestCase):
    def test_blocked_verify_does_not_stop_save_next_chunk_or_heartbeat(self):
        w = DWorld(records=60)
        self.addCleanup(w.tmp.cleanup)
        w.cfg['supervisor_workers'] = 16
        w.start('single', 'deepseek', 'd')
        w.ai(session='first')
        w.ai(session='second')
        w.tick()
        w.finish_last()  # the official fake CLI saves chunk 1 before reporting exit
        w.store.line('blocked', 'a')
        entered, unblock, advanced = threading.Event(), threading.Event(), threading.Event()
        real = w.sup._tick_line_locked
        active = []
        def line(model, method):
            if model == 'blocked':
                active.append(1)
                entered.set()
                self.assertTrue(unblock.wait(5))
            else:
                real(model, method)
                if model == 'deepseek' and method == 'd':
                    advanced.set()
        ticks = ManualTicks()
        fake_time = [1000.0]
        w.sup.clock = lambda: fake_time[0]
        with patch.object(w.sup, '_tick_line_locked', side_effect=line):
            thread = threading.Thread(target=w.sup.run_parallel, kwargs={
                'interval': 5, 'stop_event': ticks})
            thread.start()
            try:
                self.assertTrue(ticks.wait_for_cycle(1))
                self.assertTrue(entered.wait(5))
                self.assertTrue(advanced.wait(5))
                self.assertEqual(len(w.adapter.launches), 2)
                self.assertEqual(w.active()['chunk_no'], 2)
                self.assertEqual(w.store.get('heartbeat'), '1000.0')
                # Thirty five-second turns represent a 150-second synchronous verification.
                for n in range(2, 32):
                    fake_time[0] += 5
                    self.assertTrue(ticks.cycle(n))
                self.assertEqual(w.store.get('heartbeat'), '1150.0')
                self.assertEqual(len(active), 1)
            finally:
                unblock.set()
                ticks.stop()
                thread.join(5)
                self.assertFalse(thread.is_alive())

    def test_workers_default_and_runtime_records_actual_workers(self):
        from warroom.config import DEFAULTS
        w = DWorld()
        self.addCleanup(w.tmp.cleanup)
        self.assertEqual(DEFAULTS['supervisor_workers'], 16)
        for value in (0, 17, True, 1.5, '2'):
            w.cfg['supervisor_workers'] = value
            self.assertIn('supervisor_workers', config_problem(w.cfg))
        w.cfg['supervisor_workers'] = 1
        self.assertIsNone(config_problem(w.cfg))
        record_runtime(w.paths, 'a' * 40, configured_workers=16, workers=16, instance='inst-1')
        runtime = json.loads(w.paths.runtime_record_file.read_text())
        self.assertEqual((runtime['supervisor_workers'], runtime['configured_supervisor_workers'], runtime['instance']),
                         (16, 16, 'inst-1'))
        record_runtime(w.paths, 'a' * 40, configured_workers=16)   # never a hard-coded 1 beside a configured 16
        self.assertEqual(json.loads(w.paths.runtime_record_file.read_text())['supervisor_workers'], 16)

    def test_competing_shared_claims_are_atomic(self):
        for methods in (('c', 'c'), ('d', 'd'), ('s2', 's2'), ('s3', 's3'), ('s2', 's3')):
            with self.subTest(methods=methods):
                w = DWorld()
                self.addCleanup(w.tmp.cleanup)
                barrier = threading.Barrier(2)
                def claim(i):
                    method = methods[i]
                    barrier.wait(timeout=5)
                    try:
                        return w.store.create_batch(method=method, producer=f'model{i}', shard='001',
                                                    batch='all' if method == 's3' else '01',
                                                    branch=f'branch{i}', worktree=f'/tmp/wt{i}')
                    except LineBusy:
                        return None
                with ThreadPoolExecutor(max_workers=2) as pool:
                    futures = [pool.submit(claim, i) for i in range(2)]
                    results = [future.result(timeout=5) for future in futures]
                self.assertEqual(sum(result is not None for result in results), 1)

    def test_maintenance_step_runs_even_if_watch_raises(self):
        w = DWorld()
        self.addCleanup(w.tmp.cleanup)
        with patch.object(w.sup, '_tick_maintenance', side_effect=ValueError('watch failure')), \
             patch.object(w.sup.maint, 'step') as step:
            w.sup._parallel_maintenance()
            step.assert_called_once()

    def test_future_exception_is_collected_and_slots_are_bounded(self):
        w = DWorld()
        self.addCleanup(w.tmp.cleanup)
        w.store.line('first', 'a')
        w.store.line('second', 'b')
        pending = {}
        called = threading.Event()
        def fail(model, method):
            called.set()
            raise ValueError('worker failed')
        with ThreadPoolExecutor(max_workers=1) as pool, patch.object(w.sup, '_tick_line', side_effect=fail):
            cursor = w.sup._parallel_cycle(pool, pending, 0, 1)
            self.assertLessEqual(len(pending), 1)
            self.assertTrue(called.wait(5))
            for future in pending.values():
                try:
                    future.result(timeout=5)
                except ValueError:
                    pass
            w.sup._parallel_cycle(pool, pending, cursor, 1)
            self.assertLessEqual(len(pending), 1)
        self.assertTrue(any('worker 예외' in e['msg'] for e in w.store.recent_events()))
