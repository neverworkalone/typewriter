"""Event-based proof: closing the gate just before a parallel launcher's slot fill leaves DB and files byte-identical.
Restart behaviour is covered by test_issue_3786_3787_units."""
import json
import sqlite3
import threading
import unittest
from pathlib import Path

from tests.fakes import World
from tests.test_issue_1684 import S2, s2_world
from tests.test_issue_2034_d import DWorld
from tests.test_issue_2033_c import CWorld
from tests.test_issue_2450_stage3 import PRODUCERS
from warroom import control, stage2, taskruns
from warroom.launch_gate import LaunchDenied
from warroom.store import STAGE3_METHOD

from tests.fakes import no_anchor_module

setUpModule, tearDownModule = no_anchor_module()   # #3801: runs without the test-only Store anchor


def snapshot(w):
    """Every DB row (except the per-tick heartbeat) and every file below the world's root, byte for byte."""
    conn = sqlite3.connect(w.store.path)
    try:
        dump = [line for line in conn.iterdump() if "heartbeat" not in line]
    finally:
        conn.close()
    files = {}
    for path in sorted(Path(w.tmp.name).rglob("*")):
        if path.is_file() and path.suffix not in (".sqlite", ".db") and not path.name.endswith(("-wal", "-shm")):
            files[str(path)] = path.read_bytes()
    return dump, files


def build_s3(case):
    from tests.test_issue_3149 import Helpers
    h = Helpers()
    h.addCleanup = case.addCleanup
    h.assertTrue = case.assertTrue
    w = h.world(3, cap=1)   # one slot: the other chunks wait for a freed slot, which is filled outside any admission
    return w, w.sup.s3p, lambda: h.respond(w, "001")


def build_s2(case):
    from tests.test_issue_3047 import Helpers, PREFIX
    h = Helpers()
    h.addCleanup = case.addCleanup
    w = h.world([(f"sense-{i}", 240) for i in range(3)], cap=1)
    h.launch(w, 3)
    w.tick(3)
    return w, w.sup.s2p, lambda: h.respond(w, f"{PREFIX}-t01")


def build_d(case):
    from tests.test_issue_3074 import ParallelDHelpers
    h = ParallelDHelpers()
    h.addCleanup = case.addCleanup
    w = h.world()
    h.plan_all(w, range(1, 11))
    w.start("single", "deepseek", "d")
    w.tick()
    return w, w.sup.dp, lambda: h.finish_task(w, "003")


def build_c(case):
    from tests.test_issue_3076 import Helpers
    h = Helpers()
    h.addCleanup = case.addCleanup
    w = h.world(senses=400)   # more chunks than slots: the next chunk is rendered only once a slot frees
    w.start("single", "deepseek", "c")
    w.tick()
    return w, w.sup.cp, lambda: h.finish(w, "001")


class DenialIsWriteFree(unittest.TestCase):
    def check(self, build):
        w, par, free_one = build(self)
        gate, seen = w.sup.launch_gate, {}
        original = par._fill_slots

        def closing_fill(*args, **kwargs):
            if "before" in seen or gate.held():   # inside an admitted launch the gate may close, but cannot deny it
                return original(*args, **kwargs)
            closer = threading.Thread(target=gate.close)
            closer.start()
            with gate._condition:
                self.assertTrue(gate._condition.wait_for(lambda: not gate._open, timeout=5))
            seen["before"] = snapshot(w)
            seen["launches"] = len(w.adapter.launches)
            try:
                return original(*args, **kwargs)
            finally:
                seen["closer"] = closer

        par._fill_slots = closing_fill
        free_one()   # a slot frees: the next tick collects the result and fills the slot with the next task
        w.tick()
        self.assertIn("before", seen, "the launcher never reached its slot fill")
        seen["closer"].join(5)
        self.assertEqual(snapshot(w), seen["before"])
        self.assertEqual(len(w.adapter.launches), seen["launches"])
        w.tick(2)   # a frozen lane stays frozen while the gate is closed
        self.assertEqual(snapshot(w)[1], seen["before"][1])
        self.assertEqual(len(w.adapter.launches), seen["launches"])

    def test_s2(self):
        self.check(build_s2)

    def test_d(self):
        self.check(build_d)

    def test_c(self):
        self.check(build_c)

    def test_s3(self):
        self.check(build_s3)
