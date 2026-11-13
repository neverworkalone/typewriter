"""Operator Free/Go switch: which models/Lines it touches and how mixed/none boards behave."""
import json
import unittest
from pathlib import Path

from tests.fakes import World
from tests.test_lines import multi_world
from warroom import control, stage1ab

METHODS = ["a", "b", "c", "d"]


class TierSwitch(unittest.TestCase):
    def test_api_switch_and_missing_configuration(self):
        w = multi_world()
        with self.assertRaises(ValueError):
            control.set_tier(w.store, w.cfg, METHODS, "api")
        self.assertEqual(control.tier_state(w.store, w.cfg, METHODS), "free")
        w.cfg["producers"]["deepseek"] = {**w.cfg["producers"]["deepseek"],
            "models": {**w.cfg["producers"]["deepseek"]["models"], "api": "deepseek/deepseek-flash"}}
        control.set_tier(w.store, w.cfg, METHODS, "api")
        self.assertEqual(control.tier_state(w.store, w.cfg, METHODS), "api")
        self.assertEqual(control.next_tier("api"), "free")
        control.set_tier(w.store, w.cfg, METHODS, "free")
        w.tmp.cleanup()

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


# --- #6027: the API slot runs on Command Code GOAT; the stored tier key stays `api` ---
GOAT = "commandcode/deepseek/deepseek-v4-flash"
P429 = json.dumps({"type": "error", "error": {"type": "provider.rate-limit", "status": 429,
                                               "response": {"body": json.dumps({"error": {"message": "slow down"}})}}})


def provider_error(status, param=None):
    body = {"error": {"message": "x", **({"param": param} if param else {})}}
    return json.dumps({"type": "error", "error": {"type": "provider.x", "status": status,
                                                  "response": {"body": json.dumps(body)}}})


def goat_world(world):
    """`world` on the GOAT tier: the API model is GOAT, the fake OpenCode lists it and every Line uses `api`."""
    world.cfg["models"] = {**world.cfg["models"], "api": GOAT}
    world.runner.models.append(GOAT)
    control.set_tier(world.store, world.cfg, METHODS, "api")
    return world


class GoatTier(unittest.TestCase):
    def test_api_tier_key_and_pin_are_kept(self):
        w = goat_world(World())
        self.addCleanup(w.tmp.cleanup)
        self.assertEqual({w.store.peek_line("deepseek", m)["model_tier"] for m in METHODS}, {"api"})
        self.assertEqual(control.tier_state(w.store, w.cfg, METHODS), "api")
        w.start("single", "deepseek", "a")
        w.tick()
        b = w.row("deepseek", "a")
        self.assertEqual(b["model_tier"], "api")
        self.assertEqual(w.sup._run(b).model, GOAT)
        self.assertEqual(w.store.runs(b["id"])[0]["model"], GOAT)

    def test_goat_failure_classes_come_only_from_top_level_provider_events(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        bid = w.store.create_batch(method="a", producer="deepseek", shard="001", batch="01", branch="b", worktree="/w")
        cases = [  # name, log, persisted model, class
            ("401 is auth", provider_error(401), GOAT, "auth"),
            ("403 is auth", provider_error(403), GOAT, "auth"),
            ("429 is a hold", P429, GOAT, "usage_limit"),
            ("5xx is transient", provider_error(503), GOAT, "network"),
            ("400 on reasoning_effort is effort", provider_error(400, "reasoning_effort"), GOAT, "effort"),
            ("another 400 is unknown", provider_error(400, "messages"), GOAT, "unknown"),
            ("no evidence is unknown", json.dumps({"type": "step_start"}), GOAT, "unknown"),
            ("AI text naming 429/401 is no evidence",
             json.dumps({"type": "text", "part": {"text": "429 Too Many Requests 401 unauthorized usage limit"}}), GOAT, "unknown"),
            ("a CLI diagnostic may prove a network fault", "Error: ECONNRESET", GOAT, "network"),
            ("a CLI diagnostic never proves a limit", "429 rate limit exceeded", GOAT, "unknown"),
            ("a Go run keeps the existing classification", P429, "p/go", "rate_limit"),
        ]
        for i, (name, log, model, want) in enumerate(cases):
            with self.subTest(name):
                path = Path(w.tmp.name) / f"goat-{i}.log"
                path.write_text(log + "\n")
                w.store.add_run(bid, "produce", None, None, str(path), str(path) + ".exit", model=model, effort="none")
                self.assertEqual(w.sup._classify_run("deepseek", str(path)), want)
                # the verdict follows the run's persisted model ID, never the current configuration
                w.cfg["models"] = {**w.cfg["models"], "api": "deepseek/deepseek-flash"}
                self.assertEqual(w.sup._classify_run("deepseek", str(path)), want)

    def test_ab_chunk_goat_429_holds_after_a_clean_exit_and_retry_accepts_the_answer_without_ai(self):
        from tests.test_issue_2035 import ABWorld, log_text
        w = goat_world(ABWorld())
        self.addCleanup(w.tmp.cleanup)
        w.adapter.plan.append({"code": 0, "session": "ses_1", "text": log_text(w.block(1)) + P429 + "\n"})
        w.start("single", "deepseek", "a")
        w.tick()
        self.assertEqual(w.adapter.launches[-1]["model"], GOAT)
        w.finish_last()
        w.tick(3)
        b = w.row_()
        self.assertEqual(b["state"], "PAUSED")
        self.assertIn("GOAT provider 429", b["error"])
        self.assertIsNone(b["retry_after"])
        self.assertEqual(len(w.adapter.launches), 1)                      # no relaunch and no next chunk
        self.assertFalse(stage1ab.chunk_saved(w.wt(), b, stage1ab.chunk_by_number(stage1ab.checkpoint(w.wt(), b), 1)))

        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.adapter.plan.append({"code": 0, "session": "ses_2", "text": log_text(w.block(2)) + P429 + "\n"})
        w.tick(2)
        b = w.row_()
        self.assertTrue(stage1ab.chunk_saved(w.wt(), b, stage1ab.chunk_by_number(stage1ab.checkpoint(w.wt(), b), 1)))
        self.assertEqual(len(w.adapter.launches), 2)                      # chunk 1 accepted without the AI; chunk 2 starts
        w.finish_last()
        w.tick(3)
        self.assertEqual(w.row_()["state"], "PAUSED")                     # a 429 after the Retry is held again
        self.assertEqual(len(w.adapter.launches), 2)

    def test_goat_429_after_a_failed_exit_is_held_without_backoff(self):
        from tests.test_issue_2035 import ABWorld, log_text
        w = goat_world(ABWorld())
        self.addCleanup(w.tmp.cleanup)
        w.adapter.plan.append({"code": 1, "session": "ses_1", "text": log_text("partial") + P429 + "\n"})
        w.start("single", "deepseek", "a")
        w.tick()
        w.finish_last()
        w.tick(3)
        b = w.row_()
        self.assertEqual((b["state"], b["retry_after"], b["retries"]), ("PAUSED", None, 0))
        self.assertEqual(len(w.adapter.launches), 1)

    def test_ai_text_that_mentions_429_does_not_hold_a_goat_chunk(self):
        from tests.test_issue_2035 import ABWorld, log_text
        w = goat_world(ABWorld())
        self.addCleanup(w.tmp.cleanup)
        w.adapter.plan.append({"code": 0, "session": "ses_1", "text": log_text(w.block(1)) +
                               json.dumps({"type": "text", "part": {"text": "HTTP 429 limit"}}) + "\n"})
        w.start("single", "deepseek", "a")
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual(w.row_()["state"], "PRODUCING")
        self.assertEqual(len(w.adapter.launches), 2)

    def test_parallel_c_goat_429_stops_new_assignment_follows_siblings_then_pauses_and_retry_accepts_saved(self):
        from tests.test_issue_3076 import Helpers
        h = Helpers()
        h.addCleanup = self.addCleanup
        w = goat_world(h.world(senses=100))                               # nine 12-Sense tasks for eight slots
        w.adapter.plan.clear()
        w.adapter.plan.extend({"code": 0, "session": f"ses_{i}"} for i in range(1, 12))
        w.adapter.plan[0] = {"code": 0, "session": "ses_1", "text": P429 + "\n"}
        w.start("single", "deepseek", "c")
        w.tick()
        running = sorted(r["task"] for r in h.open_runs(w))
        self.assertEqual(len(running), 8)
        self.assertTrue(all(r["model"] == GOAT for r in h.open_runs(w)))
        launches = len(w.adapter.launches)
        h.finish(w, "001")                                                # saved, but the run got a provider 429
        w.tick()
        self.assertEqual(h.tasks(w)["001"]["state"], "FAILED")
        self.assertTrue(h.data(w, "001")["goat_429"])
        self.assertEqual(h.b(w)["state"], "PRODUCING")                    # siblings are still followed to their end
        for task in running[1:]:
            h.finish(w, task)
            w.tick()
        self.assertEqual(len(w.adapter.launches), launches)               # no new chunk was assigned meanwhile
        b = h.b(w)
        self.assertEqual(b["state"], "PAUSED")
        self.assertIn("GOAT provider 429", b["error"])

        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.tick(2)
        self.assertEqual(h.tasks(w)["001"]["state"], "SAVED")             # the saved Senses are accepted without the AI
        self.assertNotIn("goat_429", h.data(w, "001"))
        self.assertEqual([l["kind"] for l in w.adapter.launches[launches:]], ["start"])   # only the unassigned task 009
        self.assertEqual(sorted(r["task"] for r in h.open_runs(w)), ["009"])


if __name__ == "__main__":
    unittest.main()
