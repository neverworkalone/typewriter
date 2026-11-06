"""Admission and closure of one AI launch permit."""
import threading
import tempfile
from pathlib import Path
import unittest

from warroom.launch_gate import LaunchDenied, LaunchGate

from tests.fakes import no_anchor_module

setUpModule, tearDownModule = no_anchor_module()   # #3801: runs without the test-only Store anchor


class LaunchGateTest(unittest.TestCase):
    def test_close_waits_for_active_permit_and_rejects_future_entries(self):
        gate = LaunchGate()
        entered, release, closed = threading.Event(), threading.Event(), threading.Event()
        def launch():
            with gate.permit():
                self.assertTrue(gate.held())
                entered.set()
                self.assertTrue(release.wait(5))
                # Nested operations are part of the already-admitted launch.
                with gate.permit():
                    self.assertTrue(gate.held())
        def close():
            gate.close()
            closed.set()
        worker = threading.Thread(target=launch)
        worker.start()
        self.assertTrue(entered.wait(5))
        closer = threading.Thread(target=close)
        closer.start()
        try:
            with gate._condition:
                self.assertTrue(gate._condition.wait_for(lambda: not gate._open, timeout=5))
            with self.assertRaises(LaunchDenied):
                with gate.permit():
                    self.fail('a closed gate admitted a new launch')
            self.assertFalse(closed.is_set())
        finally:
            release.set()
            worker.join(5)
            closer.join(5)
        self.assertTrue(closed.is_set())
        with self.assertRaises(LaunchDenied):
            with gate.permit():
                pass

    def test_open_waits_for_close_to_drain_then_repeatedly_resumes(self):
        gate = LaunchGate()
        entered, release, closed, opening, opened = (threading.Event() for _ in range(5))
        def launch():
            with gate.permit():
                entered.set()
                self.assertTrue(release.wait(5))
        def close():
            gate.close()
            closed.set()
        def reopen():
            opening.set()
            gate.open()
            opened.set()
        worker = threading.Thread(target=launch)
        worker.start()
        self.assertTrue(entered.wait(5))
        closer = threading.Thread(target=close)
        closer.start()
        opener = None
        try:
            with gate._condition:
                self.assertTrue(gate._condition.wait_for(lambda: gate._closing == 1, timeout=5))
            opener = threading.Thread(target=reopen)
            opener.start()
            self.assertTrue(opening.wait(5))
            self.assertFalse(gate.is_open)
            self.assertFalse(opened.is_set())
            with self.assertRaises(LaunchDenied):
                with gate.permit():
                    pass
        finally:
            release.set()
            worker.join(5)
            closer.join(5)
            if opener is not None:
                opener.join(5)
        self.assertTrue(closed.is_set())
        self.assertTrue(opened.is_set())
        for _ in range(3):
            with gate.permit():
                self.assertTrue(gate.held())
                with gate.permit():
                    self.assertTrue(gate.held())
            gate.close()
            with self.assertRaises(LaunchDenied):
                with gate.permit():
                    pass
            gate.open()
        with gate.permit():
            with self.assertRaises(RuntimeError):
                gate.close()
            with self.assertRaises(RuntimeError):
                gate.open()

    def test_permit_precedes_first_persistent_write(self):
        gate = LaunchGate()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'launch-state'
            def write_launch():
                with gate.permit():
                    path.write_text('admitted')
            gate.close()
            with self.assertRaises(LaunchDenied):
                write_launch()
            self.assertFalse(path.exists())
            gate.open()
            write_launch()
            self.assertEqual(path.read_text(), 'admitted')
            gate.close()
            with self.assertRaises(LaunchDenied):
                write_launch()
            self.assertEqual(path.read_text(), 'admitted')

    def test_denial_is_not_an_ordinary_launch_exception(self):
        gate = LaunchGate()
        gate.close()
        with self.assertRaises(LaunchDenied):
            try:
                with gate.permit():
                    pass
            except Exception:
                self.fail('ordinary launch error handling must not catch denial')
