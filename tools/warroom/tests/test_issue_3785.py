"""Single-run launches hold admission through PID persistence."""
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.fakes import World
from tests.test_issue_1555 import make_batch
from warroom.launch_gate import LaunchDenied
from warroom.adapters import ProcessAdapter


class SingleLaunchPermit(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)

    def test_closed_gate_rejects_before_single_run_or_repair_writes(self):
        w = self.w
        b = make_batch(w, method='a', run_kind='produce', state='PREPARE')
        before = dict(w.store.batch(b['id']))
        w.sup.launch_gate.close()
        with self.assertRaises(LaunchDenied):
            w.sup._launch(b, 'produce')
        with self.assertRaises(LaunchDenied):
            w.sup._launch_stage2_repair_page(b)
        with self.assertRaises(LaunchDenied):
            w.sup.maint._continue_investigation(b, {}, '', '')
        self.assertEqual(dict(w.store.batch(b['id'])), before)
        self.assertEqual(w.store.runs(b['id']), [])
        self.assertEqual(w.adapter.launches, [])

    def test_optional_spawn_assertion_runs_before_file_writes(self):
        w = self.w
        adapter = ProcessAdapter()
        adapter.required_launch_gate = w.sup.launch_gate
        target = Path(w.tmp.name) / 'not-created' / 'run.log'
        with self.assertRaises(RuntimeError):
            adapter._spawn(['false'], w.tmp.name, {}, target, target.with_suffix('.exit'))
        self.assertFalse(target.parent.exists())

    def test_denied_line_is_not_retried_after_gate_reopens(self):
        w = self.w
        make_batch(w, method='a', run_kind='produce', state='PREPARE')
        w.sup.launch_gate.close()
        w.sup._tick_line('deepseek', 'a')
        w.sup.launch_gate.open()
        with patch.object(w.sup, '_tick_line_locked') as tick:
            w.sup._tick_line('deepseek', 'a')
            tick.assert_not_called()

    def test_actual_spawn_error_uses_existing_error_handling(self):
        w = self.w
        b = make_batch(w, method='a', run_kind='produce', state='PREPARE')
        with patch.object(w.adapter, 'start', side_effect=RuntimeError('spawn failed')):
            w.sup._launch(b, 'produce')
        self.assertEqual(w.store.batch(b['id'])['state'], 'ERROR')
        self.assertIn('spawn failed', w.store.batch(b['id'])['error'])
        self.assertEqual(w.store.runs(b['id']), [])

    def test_close_waits_until_started_process_pid_is_persisted(self):
        w = self.w
        b = make_batch(w, method='a', run_kind='produce', state='PREPARE')
        entering, release, closed = threading.Event(), threading.Event(), threading.Event()
        original = w.adapter.start
        def start(*args, **kwargs):
            entering.set()
            self.assertTrue(release.wait(5))
            return original(*args, **kwargs)
        def close():
            w.sup.launch_gate.close()
            closed.set()
        with patch.object(w.adapter, 'start', side_effect=start):
            worker = threading.Thread(target=w.sup._launch, args=(b, 'produce'))
            worker.start()
            self.assertTrue(entering.wait(5))
            closer = threading.Thread(target=close)
            closer.start()
            try:
                gate = w.sup.launch_gate
                with gate._condition:
                    self.assertTrue(gate._condition.wait_for(lambda: not gate._open, timeout=5))
                self.assertFalse(closed.is_set())
            finally:
                release.set()
                worker.join(5)
                closer.join(5)
            self.assertTrue(closed.is_set())
            row = w.store.batch(b['id'])
            self.assertIsNotNone(row['pid'])
            self.assertEqual(w.store.runs(b['id'])[0]['pid'], row['pid'])
