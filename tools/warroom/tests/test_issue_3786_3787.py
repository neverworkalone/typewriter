"""Parallel C/D/Stage 2/Stage 3 task launchers hold admission from first write through PID evidence."""
import threading
import unittest

from tests.fakes import World
from warroom import adapters, cparallel, dparallel, s2parallel, s3parallel
from warroom.launch_gate import LaunchDenied, LaunchGate, task_launch_scope

from tests.fakes import no_anchor_module

setUpModule, tearDownModule = no_anchor_module()   # #3801: runs without the test-only Store anchor

LAUNCHERS = [(s2parallel.ParallelStage2, '_launch_task'), (dparallel.ParallelD, '_launch'),
             (cparallel.ParallelC, '_launch'), (s3parallel.ParallelStage3, '_launch_task')]


class _Sup:
    def __init__(self):
        self.launch_gate = LaunchGate()


class _Probe:
    def __init__(self):
        self.sup, self.writes, self.held = _Sup(), 0, []

    @task_launch_scope
    def launch(self):
        self.writes += 1   # stands for the launcher's first durable write
        self.held.append(self.sup.launch_gate.held())


class TaskLauncherPermit(unittest.TestCase):
    def test_every_task_launcher_is_permit_scoped(self):
        for cls, name in LAUNCHERS:
            self.assertTrue(hasattr(getattr(cls, name), '__wrapped__'), f'{cls.__name__}.{name}')

    def test_closed_gate_denies_before_any_write_and_close_waits_for_active_launch(self):
        probe = _Probe()
        probe.sup.launch_gate.close()
        with self.assertRaises(LaunchDenied):
            probe.launch()
        self.assertEqual(probe.writes, 0)
        probe.sup.launch_gate.open()
        probe.launch()
        self.assertEqual(probe.held, [True])

        entered, release, closed = threading.Event(), threading.Event(), threading.Event()
        gate = probe.sup.launch_gate

        def held_launch():
            with gate.permit():
                entered.set()
                release.wait(5)

        worker = threading.Thread(target=held_launch)
        worker.start()
        self.assertTrue(entered.wait(5))
        closer = threading.Thread(target=lambda: (gate.close(), closed.set()))
        closer.start()
        with gate._condition:
            self.assertTrue(gate._condition.wait_for(lambda: not gate._open, timeout=5))
        self.assertFalse(closed.is_set())
        with self.assertRaises(LaunchDenied):
            probe.launch()
        release.set()
        worker.join(5), closer.join(5)
        self.assertTrue(closed.is_set())
        self.assertEqual(probe.writes, 1)

    def test_supervisor_requires_permit_on_every_process_adapter(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        ad = adapters.ProcessAdapter()
        sup_cls = type(w.sup)
        built = sup_cls(w.sup.paths, w.sup.cfg, w.store, w.sup.runner, {'x': ad}, w.sup.gh, w.sup.git, w.sup.env)
        self.assertIs(ad.required_launch_gate, built.launch_gate)
        with self.assertRaises(RuntimeError):
            ad._spawn(['true'], w.tmp.name, {}, w.sup.paths.logs / 'x.log', w.sup.paths.logs / 'x.exit')


class PreparationIsAdmitted(unittest.TestCase):
    """Writes that precede a launch (worktree, pending record) happen only after admission."""

    def setUp(self):
        from tests.test_issue_1555 import make_batch
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)
        self.b = make_batch(self.w, method='a', run_kind='produce', state='PREPARE', worktree=False)

    def test_denied_prepare_creates_no_worktree_and_changes_no_row(self):
        w, b = self.w, self.b
        before = dict(w.store.batch(b['id']))
        w.sup.launch_gate.close()
        with self.assertRaises(LaunchDenied):
            w.sup._prepare_existing(b)
        self.assertFalse(__import__('pathlib').Path(b['worktree']).exists())
        self.assertEqual(dict(w.store.batch(b['id'])), before)
        self.assertEqual(w.store.runs(b['id']), [])
        self.assertEqual(w.adapter.launches, [])

    def test_denied_relaunch_and_pending_reentry_leave_the_pending_record(self):
        import json
        w, b = self.w, self.b
        key = f"pending_{b['id']}"
        w.store.set(key, json.dumps({'stage': 'prelaunch', 'evidence': {
            'entrypoint': 'prepare_existing', 'worktree': str(b['worktree']), 'run_kind': b['run_kind'],
            'last_run_id': None, 'head': None, 'target': None}}, sort_keys=True))
        w.sup.launch_gate.close()
        with self.assertRaises(LaunchDenied):
            w.sup._pending_gate(b)
        self.assertIsNotNone(w.store.get(key))
        with self.assertRaises(LaunchDenied):
            w.sup._relaunch(b)
        self.assertEqual(w.store.runs(b['id']), [])
