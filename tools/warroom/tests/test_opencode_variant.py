"""OpenCode model+variant is proven at Start, in an isolated probe, before any batch or worktree exists (#1379 review)."""
import threading
import unittest
from pathlib import Path

from tests.fake_runner import ScriptedRunner
from tests.fakes import World
from warroom.adapters import PREFLIGHT_PENDING, OpenCodeAdapter, RunSpec

FREE, GO = "p/free-x-free", "p/go"
REPO = Path(__file__).resolve().parents[3]   # the checkout: a probe must never run here


def runs_for(variant):
    return [RunSpec(FREE, variant), RunSpec(GO, variant)]


class VariantPreflight(unittest.TestCase):
    def check(self, variant, *, rejected=(), answer="text"):
        runner = ScriptedRunner()
        runner.variant_rejected = set(rejected)
        runner.probe_answer = answer
        return OpenCodeAdapter("opencode", probe_async=False).preflight(runner, {}, runs_for(variant)), runner

    def test_table(self):
        cases = [  # name, variant, rejected variants, probe answer, blocked fragment ("" = must pass)
            ("valid high passes on both tiers", "high", (), "text", ""),
            ("unknown variant is refused before the provider", "bogus", (f"{FREE}#bogus", f"{GO}#bogus"), "text", "지원하지 않습니다"),
            ("only the Go tier refuses the variant", "high", (f"{GO}#high",), "text", "지원하지 않습니다"),
            ("provider quota still proves the variant", "high", (), "quota", ""),
            ("silent timeout cannot prove it", "high", (), "silent", "확인하지 못했습니다"),
            ("answer that is neither text nor a provider error", "high", (), "garbage", "확인하지 못했습니다"),
        ]
        for name, variant, rejected, answer, fragment in cases:
            with self.subTest(name):
                problem, _ = self.check(variant, rejected=rejected, answer=answer)
                if fragment:
                    self.assertIn(fragment, problem)
                else:
                    self.assertIsNone(problem)

    def test_probe_runs_isolated_without_auto_or_the_repository(self):
        seen = []

        class Recording(ScriptedRunner):
            def run(self, argv, cwd=None, env=None, input=None, timeout=120):
                if argv[1:2] == ["run"]:
                    seen.append((list(argv), cwd, Path(cwd).exists()))
                return super().run(argv, cwd=cwd, env=env, input=input, timeout=timeout)

        OpenCodeAdapter("opencode", probe_async=False).preflight(Recording(), {}, runs_for("high"))
        self.assertEqual(len(seen), 2)
        for argv, cwd, existed in seen:
            self.assertNotIn("--auto", argv)                                  # no permission grant
            self.assertNotIn("--session", argv)                               # never a real session
            self.assertTrue(Path(cwd).name.startswith("wr-variant-probe-"))   # a fresh throwaway directory
            self.assertTrue(existed)
            self.assertFalse(Path(cwd).exists())                             # removed after the probe
            self.assertFalse(Path(cwd).is_relative_to(REPO))                 # never inside the repository
            self.assertEqual(argv[argv.index("--title") + 1], "WR preflight")

    def test_each_pair_is_probed_once_and_refusals_are_final(self):
        runner = ScriptedRunner()
        adapter = OpenCodeAdapter("opencode", probe_async=False)
        self.assertIsNone(adapter.preflight(runner, {}, runs_for("high")))
        self.assertIsNone(adapter.preflight(runner, {}, runs_for("high")))
        self.assertEqual(len(runner.probes), 2)                    # one probe per tier, then proven for good
        runner.variant_rejected = {f"{FREE}#bogus"}
        first = adapter.preflight(runner, {}, runs_for("bogus"))
        second = adapter.preflight(runner, {}, runs_for("bogus"))
        self.assertIn("지원하지", first)
        self.assertEqual(first, second)
        self.assertEqual(runner.probes.count(f"{FREE}#bogus"), 1)  # a refusal is final until the Supervisor restarts

    def test_model_argument_carries_the_variant_suffix(self):
        self.assertEqual(OpenCodeAdapter.model_arg(RunSpec(GO, "high")), f"{GO}#high")


class BackgroundProbe(unittest.TestCase):
    """The probe never blocks the caller: it answers `pending` until the background check finishes."""

    def test_pending_then_proven_without_blocking(self):
        runner = ScriptedRunner()
        runner.probe_gate = threading.Event()
        adapter = OpenCodeAdapter("opencode", probe_async=True)
        pending = adapter.preflight(runner, {}, [RunSpec(FREE, "high")])
        self.assertTrue(pending.startswith(PREFLIGHT_PENDING))      # returned at once, the gate is still closed
        runner.probe_gate.set()
        self.assertTrue(adapter._probes[f"{FREE}#high"]["done"].wait(timeout=10))
        self.assertIsNone(adapter.preflight(runner, {}, [RunSpec(FREE, "high")]))


class StartGate(unittest.TestCase):
    """The Supervisor refuses Start before it selects a batch or creates a worktree."""

    def world(self, effort):
        w = World()
        w.cfg["producers"] = {"deepseek": {"adapter": "opencode", "effort": effort,
                                           "models": {"free": FREE, "go": GO}}}
        return w

    def test_refused_variant_blocks_start_without_worktree_or_batch(self):
        w = self.world("bogus")
        w.runner.variant_rejected = {f"{FREE}#bogus", f"{GO}#bogus"}
        try:
            w.start("single", "deepseek", "a")
            w.tick()
            self.assertEqual(w.adapter.launches, [])
            self.assertIsNone(w.store.active_batch("deepseek", "a"))
            self.assertEqual(w.git.created, [])                  # no worktree was made
            self.assertIn("지원하지 않습니다", w.store.line("deepseek", "a")["blocked"])
        finally:
            w.tmp.cleanup()

    def test_valid_high_pair_starts_a_batch(self):
        w = self.world("high")
        try:
            w.start("single", "deepseek", "a")
            w.tick()
            self.assertIsNotNone(w.store.active_batch("deepseek", "a"))
            self.assertIn(f"{FREE}#high", w.runner.probes)
            self.assertEqual(w.adapter.launches[-1]["effort"], "high")
        finally:
            w.tmp.cleanup()

    def test_pending_probe_waits_without_blocking_or_creating_anything(self):
        w = self.world("high")
        w.adapter._opencode = OpenCodeAdapter("opencode", probe_async=True)
        w.runner.probe_gate = threading.Event()
        try:
            w.start("single", "deepseek", "a")
            w.tick()
            self.assertIsNone(w.store.active_batch("deepseek", "a"))   # nothing selected while unproven
            self.assertEqual(w.git.created, [])
            self.assertEqual(w.store.line("deepseek", "a")["blocked"], "")   # waiting, not blocked
            w.runner.probe_gate.set()
            for _ in range(10):   # pairs are probed one after another, so tick until both are proven
                w.tick()
                if w.store.active_batch("deepseek", "a") is not None:
                    break
                for probe in list(w.adapter._opencode._probes.values()):
                    probe["done"].wait(timeout=10)
            self.assertIsNotNone(w.store.active_batch("deepseek", "a"))
        finally:
            w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
