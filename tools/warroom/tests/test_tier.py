"""Operator Free/Go switch: which models/Lines it touches and how mixed/none boards behave."""
import unittest

from tests.fakes import World
from tests.test_lines import multi_world
from warroom import control

METHODS = ["a", "b", "c", "d"]


class TierSwitch(unittest.TestCase):
    def test_table(self):
        w = multi_world()           # deepseek has a Go model, sonnet does not
        cfg, st = w.cfg, w.store
        self.assertEqual(control.go_models(cfg), ["deepseek"])
        self.assertEqual(control.tier_state(st, cfg, METHODS), "free")
        self.assertEqual(control.next_tier("free"), "go")
        st.set_line("deepseek", "b", model_tier="go")                       # one Line already switched by quota
        self.assertEqual(control.tier_state(st, cfg, METHODS), "mixed")
        self.assertEqual(control.next_tier("mixed"), "free")                # unsure -> back to the free tier
        control.set_tier(st, cfg, METHODS, "go")
        self.assertEqual(control.tier_state(st, cfg, METHODS), "go")
        self.assertEqual(control.next_tier("go"), "free")
        self.assertEqual(st.peek_line("sonnet", "a")["model_tier"], "free")  # no Go model: untouched
        control.set_tier(st, cfg, METHODS, "free")
        self.assertEqual({st.peek_line("deepseek", m)["model_tier"] for m in METHODS}, {"free"})
        with self.assertRaises(ValueError):
            control.set_tier(st, cfg, METHODS, "paid")
        w.tmp.cleanup()

    def test_only_deepseek_is_switched_even_if_another_model_has_a_go_model(self):
        w = multi_world()
        w.cfg["producers"] = {**w.cfg["producers"], "sonnet": {"adapter": "opencode",
                              "models": {"free": "p/sonnet-free", "go": "p/sonnet-go"}}}
        self.assertEqual(control.go_models(w.cfg), ["deepseek"])
        bid = w.store.create_batch(method="a", producer="sonnet", shard="001", batch="01", branch="b", worktree="/s")
        control.set_tier(w.store, w.cfg, METHODS, "go")
        self.assertEqual(w.store.peek_line("sonnet", "a")["model_tier"], "free")
        self.assertEqual(w.store.batch(bid)["model_tier"], "free")
        self.assertEqual(control.tier_state(w.store, w.cfg, METHODS), "go")
        w.tmp.cleanup()

    def test_free_tier_is_opencode_only(self):
        w = multi_world()
        w.cfg["producers"] = {**w.cfg["producers"], "deepseek": {**w.cfg["producers"]["deepseek"], "adapter": "codex"}}
        # (not run through OpenCode: no free/go tiers; the shared PRODUCERS fixture stays untouched)
        self.assertEqual(control.go_models(w.cfg), [])
        self.assertEqual(control.tier_state(w.store, w.cfg, METHODS), "none")
        w.tmp.cleanup()

    def test_none_when_no_model_has_go(self):
        w = World(models={"free": "p/free-x-free", "go": ""})
        self.assertEqual(control.tier_state(w.store, w.cfg, METHODS), "none")
        self.assertIsNone(control.next_tier("none"))
        w.tmp.cleanup()

    def test_unfinished_batches_follow_completed_ones_do_not_and_next_launch_uses_it(self):
        w = World()
        a = w.store.create_batch(method="a", producer="deepseek", shard="001", batch="01", branch="b1", worktree="/1")
        done = w.store.create_batch(method="b", producer="deepseek", shard="001", batch="01", branch="b2", worktree="/2")
        w.store.update(done, state="COMPLETE")
        self.assertEqual(control.set_tier(w.store, w.cfg, METHODS, "go"), 1)
        self.assertEqual(w.store.batch(a)["model_tier"], "go")
        self.assertEqual(w.store.batch(done)["model_tier"], "free")
        self.assertEqual(w.sup._run(w.store.batch(a)).model, "p/go")        # fix/recovery launches read this
        w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
