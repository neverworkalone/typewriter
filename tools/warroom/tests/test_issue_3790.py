"""#3790: a closed LaunchGate or a dead Supervisor never loses an AI run's exit verdict.

Every scenario freezes the stage right after `finish_runs()` (pid=None) and before the outcome is committed, then compares
(a) normal classification, (b) a closed gate, (c) a Supervisor that dies at that boundary. (b) and (c) finish with a NEW
`Supervisor` against the same DB/worktree: reopening the same gate on the same instance is not a restart."""
import json
import unittest

from tests.test_reload import stage2_world
from warroom.store import exit_verdict_key


def World(models=None):
    """A Codex World whose only shard has its preserved Stage 2 inputs: every scenario runs on one Stage 2 chunk."""
    w = stage2_world()
    w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}
    return w


class Died(BaseException):
    """A process death: not an Exception, so no tick handler can absorb it."""


def restart(w):
    w.sup = w.make_sup()
    w.sup_runner_ok()


def failed_world(text, code=1, models=None):
    w = World(models)
    w.start("single")
    w.adapter.plan.append({"code": code, "text": text})
    w.tick()
    w.adapter.finish(w.adapter.launches[-1]["pid"])
    return w


def counts(w):
    b = w.row()
    return (b["state"], b["retries"], b["model_tier"], len(w.adapter.launches), len(w.store.runs(b["id"])))


def settle(w, mode):
    """Run the verdict tick under `mode`, then (for b/c) recover on a fresh Supervisor."""
    if mode == "normal":
        w.tick()
        return
    if mode == "denied":
        w.sup.launch_gate.close()
        w.tick()
    else:
        w.sup._apply_exit_verdict_do = lambda *a, **k: (_ for _ in ()).throw(Died())
        with unittest.TestCase().assertRaises(Died):
            w.tick()
    restart(w)
    w.tick()


# text, expected (state, retries, tier, launches, runs) after the verdict has been applied
VERDICTS = [
    ("auth", "401 unauthorized: please login", ("PAUSED", 0, "free", 1, 1)),
    ("usage_limit", "session limit reached", ("PAUSED", 0, "free", 1, 1)),
    ("rate_limit", "HTTP 429 Too Many Requests", ("PRODUCING", 1, "free", 1, 1)),
    ("unknown", "weird provider blob", ("PAUSED", 0, "free", 1, 1)),
]


class ExitVerdictSurvives(unittest.TestCase):
    def test_non_zero_exit_verdict_is_identical_when_denied_or_interrupted(self):
        for name, text, want in VERDICTS:
            for mode in ("normal", "denied", "death"):
                with self.subTest(name, mode=mode):
                    w = failed_world(text)
                    self.addCleanup(w.tmp.cleanup)
                    settle(w, mode)
                    self.assertEqual(counts(w), want)        # no silent extra AI run, no lost verdict, no double attempt
                    self.assertIsNone(w.store.get(exit_verdict_key(w.row()["id"])))   # committed exactly once

    def test_closed_gate_does_not_defer_a_pause_on_the_same_instance(self):
        w = failed_world("401 unauthorized: please login")
        self.addCleanup(w.tmp.cleanup)
        w.sup.launch_gate.close()
        w.tick()
        self.assertEqual((w.row()["state"], len(w.adapter.launches)), ("PAUSED", 1))

    def test_rate_limit_backoff_is_consumed_once_and_survives_restart(self):
        w = failed_world("HTTP 429 Too Many Requests")
        self.addCleanup(w.tmp.cleanup)
        w.sup.launch_gate.close()
        w.tick()
        b = w.row()
        self.assertEqual((b["retries"], b["retry_after"] is not None, len(w.adapter.launches)), (1, True, 1))
        restart(w)
        w.tick(3)
        self.assertEqual((w.row()["retries"], len(w.adapter.launches)), (1, 1))     # still backing off, nothing relaunched
        w.now += 100
        w.tick()
        self.assertEqual((w.row()["retries"], len(w.adapter.launches)), (1, 2))     # exactly one relaunch after the backoff

    def test_stale_marker_for_another_run_fails_closed_without_an_ai(self):
        w = failed_world("HTTP 429 Too Many Requests")
        self.addCleanup(w.tmp.cleanup)
        w.sup._apply_exit_verdict_do = lambda *a, **k: (_ for _ in ()).throw(Died())
        with self.assertRaises(Died):
            w.tick()
        w.store.set(exit_verdict_key(w.row()["id"]), json.dumps({"run_id": 999, "code": 1}))
        restart(w)
        w.tick()
        self.assertEqual((w.row()["state"], len(w.adapter.launches)), ("ERROR", 1))

    def test_zero_exit_and_missing_status_verdicts_do_not_need_the_gate(self):
        # A Stage 2 chunk that exits 0 without an answer gets its one bounded re-entry (#2136); a lost exit status
        # stays an ERROR. Either way the verdict is applied exactly once, whatever the gate or a restart does.
        for name, code, want in (("exit0", 0, ("PRODUCING", "PRODUCING", 2)), ("missing", None, ("ERROR", "ERROR", 1))):
            with self.subTest(name):
                w = World()
                self.addCleanup(w.tmp.cleanup)
                w.start("single")
                w.adapter.plan.append({"code": 0, "text": ""})
                w.tick()
                pid = w.adapter.launches[-1]["pid"]
                w.adapter.finish(pid)
                if code is None:
                    w.adapter.running.get(pid)
                    next(iter(w.paths.logs.glob("*.exit"))).unlink()
                w.sup.launch_gate.close()
                w.tick()
                state = w.row()["state"]
                restart(w)
                w.tick()
                self.assertEqual((state, w.row()["state"], len(w.adapter.launches)), want)


class DeathBeforeTheVerdict(unittest.TestCase):
    def die_then_restart(self, w):
        w.sup._apply_exit_verdict_do = lambda *a, **k: (_ for _ in ()).throw(Died())
        with self.assertRaises(Died):
            w.tick()
        restart(w)
        w.tick()

    def test_zero_exit_and_missing_status_keep_their_original_error_after_death(self):
        for name, code, want in (("exit0", 0, ("PRODUCING", 2)), ("missing", None, ("ERROR", 1))):
            with self.subTest(name):
                w = World()
                self.addCleanup(w.tmp.cleanup)
                w.start("single")
                w.adapter.plan.append({"code": 0, "text": ""})
                w.tick()
                w.adapter.finish(w.adapter.launches[-1]["pid"])
                if code is None:
                    next(iter(w.paths.logs.glob("*.exit"))).unlink()
                self.die_then_restart(w)
                self.assertEqual((w.row()["state"], len(w.adapter.launches)), want)
                self.assertIsNone(w.store.get(exit_verdict_key(w.row()["id"])))

class GateSemantics(unittest.TestCase):
    def test_close_waits_for_a_permit_taken_before_it_and_a_close_before_a_permit_denies(self):
        import threading
        from warroom.launch_gate import LaunchDenied, LaunchGate
        gate, inside, release, closed = LaunchGate(), threading.Event(), threading.Event(), threading.Event()

        def launch():
            with gate.permit():
                inside.set()
                release.wait(5)
        t = threading.Thread(target=launch)
        t.start()
        self.assertTrue(inside.wait(5))
        c = threading.Thread(target=lambda: (gate.close(), closed.set()))
        c.start()
        self.assertFalse(closed.wait(0.2))          # permit first: close waits through its run/PID persistence
        release.set()
        t.join(5)
        c.join(5)
        self.assertTrue(closed.is_set())
        with self.assertRaises(LaunchDenied):        # close first: no new launch-specific write is admitted
            with gate.permit():
                self.fail("admitted")

    def test_adapter_spawn_failure_is_not_a_gate_denial(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single")
        orig = w.adapter.start

        def boom(*a, **k):
            raise OSError("spawn failed")
        w.adapter.start = boom
        w.tick()
        self.assertEqual(w.adapter.launches, [])
        self.assertIn(w.row()["state"], ("ERROR", "PAUSED"))      # the existing rollback/recovery, not a frozen lane
        self.assertFalse(w.sup._frozen_lanes)
        w.adapter.start = orig


if __name__ == "__main__":
    unittest.main()
