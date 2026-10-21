"""Review #1379: an OpenCode model+variant is proven at Start, before any batch or worktree exists."""
import unittest

from tests.fake_runner import ScriptedRunner
from tests.fakes import World
from warroom.adapters import OpenCodeAdapter, RunSpec

FREE, GO = "p/free-x-free", "p/go"


def runs_for(variant):
    return [RunSpec(FREE, variant), RunSpec(GO, variant)]


class VariantPreflight(unittest.TestCase):
    def check(self, variant, *, rejected=(), answer="text"):
        runner = ScriptedRunner()
        runner.variant_rejected = set(rejected)
        runner.probe_answer = answer
        return OpenCodeAdapter("opencode").preflight(runner, {}, runs_for(variant)), runner

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
                problem, runner = self.check(variant, rejected=rejected, answer=answer)
                if fragment:
                    self.assertIn(fragment, problem)
                else:
                    self.assertIsNone(problem)

    def test_proven_pairs_are_cached_and_refusals_are_not(self):
        runner = ScriptedRunner()
        adapter = OpenCodeAdapter("opencode")
        self.assertIsNone(adapter.preflight(runner, {}, runs_for("high")))
        self.assertIsNone(adapter.preflight(runner, {}, runs_for("high")))
        self.assertEqual(len(runner.probes), 2)            # one probe per tier, then cached
        runner.variant_rejected = {f"{FREE}#bogus"}
        self.assertIn("지원하지", adapter.preflight(runner, {}, runs_for("bogus")))
        self.assertIn("지원하지", adapter.preflight(runner, {}, runs_for("bogus")))
        self.assertEqual(runner.probes.count(f"{FREE}#bogus"), 2)   # a refusal is re-proven every time

    def test_model_argument_carries_the_variant_suffix(self):
        self.assertEqual(OpenCodeAdapter.model_arg(RunSpec(GO, "high")), f"{GO}#high")


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


if __name__ == "__main__":
    unittest.main()
