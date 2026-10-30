"""Issue #1867: model profiles + per-stage assignments resolve current settings for each new run."""
import json
import unittest
from pathlib import Path

from tests.fakes import World
from tests.test_issue_1555 import produce_and_report
from tests.test_issue_1684 import s2_world
from warroom import control
from warroom.config import (DEFAULTS, MAINTAINER, STAGE1, STAGE2, config_problem, maintainer_id, maintainer_problem,
                            registry_problems, reload_problem, role_of, run_spec)
from tests.test_reload import reload, write

PROFILES = {
    "luna-high": {"adapter": "codex", "model": "gpt-6-luna", "effort": "high", "permission_profile": "worktree"},
    "luna-xhigh": {"adapter": "codex", "model": "gpt-6-luna", "effort": "xhigh", "permission_profile": "worktree"},
    "sonnet-medium": {"adapter": "claude", "model": "claude-sonnet-5-5", "effort": "medium"},
}
PRODUCERS = {
    "claude": {"label": "Sonnet", "adapter": "claude"},
    "codex": {"label": "Luna", "adapter": "codex"},
    "deepseek": {"label": "DeepSeek", "adapter": "opencode", "effort": "high",
                 "models": {"free": "p/free-x-free", "go": "p/go"}},
}
ASSIGN = {"stage1": {"codex": "luna-high", "claude": "sonnet-medium"},
          "stage2": {"codex": "luna-xhigh", "claude": "sonnet-medium"}}


def cfg(**over):
    c = json.loads(json.dumps(DEFAULTS))
    c.update(producers=json.loads(json.dumps(PRODUCERS)), model_profiles=json.loads(json.dumps(PROFILES)),
             assignments=json.loads(json.dumps(ASSIGN)), maintainer="luna-xhigh")
    c.update(over)
    return c


def pin(c, producer, role, tier="free"):
    s = run_spec(c, producer, tier, role)
    return s.model, s.effort, s.permission_profile


class Resolution(unittest.TestCase):
    def test_same_model_two_efforts_is_valid_and_each_role_pins_its_own(self):
        c = cfg()
        self.assertIsNone(config_problem(c))
        self.assertEqual(registry_problems(c), {})
        for method, role in (("a", STAGE1), ("b", STAGE1), ("c", STAGE1), ("d", STAGE1), ("s2", STAGE2), ("m", MAINTAINER)):
            self.assertEqual(role_of(method), role)
        self.assertEqual(pin(c, "codex", STAGE1), ("gpt-6-luna", "high", "worktree"))
        self.assertEqual(pin(c, "codex", STAGE2), ("gpt-6-luna", "xhigh", "worktree"))
        self.assertEqual(pin(c, "codex", MAINTAINER), ("gpt-6-luna", "xhigh", "worktree"))
        self.assertEqual(pin(c, "claude", STAGE1), ("claude-sonnet-5-5", "medium", ""))

    def test_deepseek_tiers_and_effort_are_untouched(self):
        c = cfg()
        self.assertEqual(pin(c, "deepseek", STAGE1, "free"), ("p/free-x-free", "high", ""))
        self.assertEqual(pin(c, "deepseek", STAGE1, "go"), ("p/go", "high", ""))

    def test_maintainer_is_a_profile_id_or_a_legacy_producer_id(self):
        for name, m, want_producer, want_pin, ok in [
            ("luna", "luna-xhigh", "codex", ("gpt-6-luna", "xhigh", "worktree"), True),
            ("switch to claude", "sonnet-medium", "claude", ("claude-sonnet-5-5", "medium", ""), True),
            ("unknown", "nope", None, None, False),
        ]:
            with self.subTest(name):
                c = cfg(maintainer=m)
                self.assertEqual(config_problem(c) is None, ok)
                self.assertEqual(maintainer_problem(c) is None, ok)
                if ok:
                    self.assertEqual(maintainer_id(c), want_producer)
                    self.assertEqual(pin(c, want_producer, MAINTAINER), want_pin)

    def test_legacy_config_is_unchanged(self):
        c = json.loads(json.dumps(DEFAULTS))
        c["producers"] = {"claude": {"adapter": "claude", "model": "sonnet", "effort": "medium"},
                          "codex": {"adapter": "codex", "model": "gpt-6-luna", "effort": "xhigh"}}
        c["maintainer"] = "codex"
        self.assertIsNone(config_problem(c))
        self.assertIsNone(maintainer_problem(c))
        for role in (STAGE1, STAGE2, MAINTAINER):
            self.assertEqual(pin(c, "codex", role), ("gpt-6-luna", "xhigh", ""))

    def test_invalid_and_ambiguous_configs_fail_closed(self):
        def mut(f):
            c = cfg()
            f(c)
            return c
        two_codex = lambda c: c["producers"].update(codex2={"label": "L2", "adapter": "codex"})
        cases = [
            ("profile missing", mut(lambda c: c["assignments"]["stage1"].update(codex="nope"))),
            ("producer missing", mut(lambda c: c["assignments"]["stage1"].update(ghost="luna-high"))),
            ("adapter mismatch", mut(lambda c: c["assignments"]["stage1"].update(codex="sonnet-medium"))),
            ("unknown stage", mut(lambda c: c["assignments"].update(stage3={"codex": "luna-high"}))),
            ("bad effort", mut(lambda c: c["model_profiles"]["luna-high"].update(effort="turbo"))),
            ("no effort", mut(lambda c: c["model_profiles"]["luna-high"].pop("effort"))),
            ("no model", mut(lambda c: c["model_profiles"]["luna-high"].pop("model"))),
            ("flag-like model", mut(lambda c: c["model_profiles"]["luna-high"].update(model="--yolo"))),
            ("bad adapter", mut(lambda c: c["model_profiles"]["luna-high"].update(adapter="gemini"))),
            ("opencode profile", mut(lambda c: c["model_profiles"].update(ds={"adapter": "opencode", "model": "x", "effort": "high"}))),
            ("permission on claude", mut(lambda c: c["model_profiles"]["sonnet-medium"].update(permission_profile="worktree"))),
            ("non-string effort", mut(lambda c: c["model_profiles"]["luna-high"].update(effort=3))),
            ("profiles not object", mut(lambda c: c.update(model_profiles=[]))),
            ("assignments not object", mut(lambda c: c.update(assignments=[]))),
            ("legacy pin + assignment", mut(lambda c: c["producers"]["codex"].update(model="gpt-6-luna", effort="xhigh"))),
            ("maintainer is a governed producer id", mut(lambda c: c.update(maintainer="codex"))),
            ("maintainer in both namespaces", mut(lambda c: (c["model_profiles"].update(claude=PROFILES["sonnet-medium"]), c.update(maintainer="claude")))),
            ("ambiguous maintainer adapter", mut(lambda c: (two_codex(c), c.update(maintainer="luna-xhigh"), c["assignments"]["stage1"].update(codex2="luna-xhigh"), c["assignments"]["stage2"].update(codex2="luna-xhigh")))),
            ("maintainer with no unique producer", mut(lambda c: (two_codex(c), c.update(maintainer="luna-xhigh"), c["assignments"].update(stage1={"claude": "sonnet-medium"}, stage2={})))),
        ]
        for name, c in cases:
            with self.subTest(name):
                self.assertIsNotNone(config_problem(c))
        # a second codex producer is fine once the profile is assigned to exactly one of them
        c = mut(lambda c: (two_codex(c), c["model_profiles"].update(**{"luna-medium": {**PROFILES["luna-high"], "effort": "medium"}}),
                           c["assignments"]["stage1"].update(codex2="luna-medium"), c.update(maintainer="luna-medium")))
        self.assertIsNone(config_problem(c))
        self.assertEqual(maintainer_id(c), "codex2")


class ReloadAndRuns(unittest.TestCase):
    def world(self, **over):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)
        write(self.w, PRODUCERS, model_profiles=PROFILES, assignments=ASSIGN, **over)
        self.assertTrue(reload(self.w)[0])
        return self.w

    def test_reload_rejects_bad_profiles_and_keeps_old_config(self):
        w = self.world(maintainer="luna-xhigh")
        bad = {**ASSIGN, "stage1": {**ASSIGN["stage1"], "codex": "missing"}}
        write(w, PRODUCERS, model_profiles=PROFILES, assignments=bad, maintainer="luna-xhigh")
        ok, msg = reload(w)
        self.assertFalse(ok)
        self.assertIn("missing", msg)
        self.assertEqual(w.sup.cfg["assignments"]["stage1"]["codex"], "luna-high")

    def test_stage1_methods_run_high_and_start_is_blocked_without_a_stage_pin(self):
        w = self.world()
        index = Path(w.tmp.name) / "approved-literature.sqlite"
        index.write_bytes(b"synthetic approved-index path")
        write(w, PRODUCERS, model_profiles=PROFILES, assignments=ASSIGN, literary_index_path=str(index),
              corpus_index_path=str(index))
        self.assertTrue(reload(w)[0])
        for method in "abcd":
            w.start("single", "codex", method)
        w.tick(4)
        launched = {(l["model"], l["effort"]) for l in w.adapter.launches}
        self.assertEqual(launched, {("gpt-6-luna", "high")})
        self.assertEqual({w.row("codex", m)["producer"] for m in "abcd"}, {"codex"})   # producer identity, not a profile ID
        # a producer whose profile is only assigned to stage 2 cannot start Stage 1
        write(w, PRODUCERS, model_profiles=PROFILES, assignments={"stage2": ASSIGN["stage2"]})
        self.assertTrue(reload(w)[0])
        w.start("single", "claude", "a")
        w.tick()
        self.assertIn("시작 차단", w.store.peek_line("claude", "a")["blocked"])

    def test_running_batch_uses_reloaded_assignment_and_keeps_each_run_record(self):
        w = self.world()
        w.adapter.plan.append({"session": "session-first"})
        w.start("single", "codex", "a")
        w.tick(2)
        bid = w.row("codex", "a")["id"]
        first = w.store.runs(bid)[0]
        self.assertEqual((first["model"], first["effort"], first["permission_profile"]),
                         ("gpt-6-luna", "high", "worktree"))
        write(w, PRODUCERS, model_profiles=PROFILES,
              assignments={**ASSIGN, "stage1": {**ASSIGN["stage1"], "codex": "luna-xhigh"}})
        self.assertTrue(reload(w)[0])
        control.stop_line(w.store, "codex", "a")
        w.tick()
        control.retry(w.store, "codex", "a")
        w.tick(2)
        batch = w.store.active_batch("codex", "a")
        self.assertEqual(batch["state"], "PRODUCING")
        self.assertEqual((w.adapter.launches[-1]["kind"], w.adapter.launches[-1]["model"],
                          w.adapter.launches[-1]["effort"], w.adapter.launches[-1]["permission_profile"],
                          w.adapter.launches[-1]["session"]),
                         ("resume", "gpt-6-luna", "xhigh", "worktree", "session-first"))
        runs = w.store.runs(bid)
        self.assertEqual((runs[0]["model"], runs[0]["effort"], runs[0]["permission_profile"]),
                         ("gpt-6-luna", "xhigh", "worktree"))
        self.assertEqual((runs[1]["model"], runs[1]["effort"], runs[1]["permission_profile"]),
                         ("gpt-6-luna", "high", "worktree"))
        self.assertEqual((runs[0]["session_id"], runs[1]["session_id"]),
                         ("session-first", "session-first"))
        # A different Line also starts from the currently loaded assignment.
        w.start("single", "codex", "b")
        w.tick()
        self.assertEqual(w.adapter.launches[-1]["effort"], "xhigh")

    def test_running_batch_uses_reloaded_permission_profile(self):
        w = self.world()
        w.adapter.plan.append({"session": "session-profile"})
        w.start("single", "codex", "a")
        w.tick(2)
        bid = w.row("codex", "a")["id"]
        profiles = {**PROFILES, "luna-high-restricted": {
            "adapter": "codex", "model": "gpt-6-luna", "effort": "high", "permission_profile": "restricted"}}
        assignments = {**ASSIGN, "stage1": {**ASSIGN["stage1"], "codex": "luna-high-restricted"}}
        write(w, PRODUCERS, model_profiles=profiles, assignments=assignments)
        self.assertTrue(reload(w)[0])
        control.stop_line(w.store, "codex", "a")
        w.tick()
        control.retry(w.store, "codex", "a")
        w.tick(2)
        runs = w.store.runs(bid)
        self.assertEqual((runs[0]["model"], runs[0]["effort"], runs[0]["permission_profile"]),
                         ("gpt-6-luna", "high", "restricted"))
        self.assertEqual((runs[1]["model"], runs[1]["effort"], runs[1]["permission_profile"]),
                         ("gpt-6-luna", "high", "worktree"))

    def test_maintainer_runs_its_profile_and_switches_by_profile_id_only(self):
        for profile, model, effort in (("luna-xhigh", "gpt-6-luna", "xhigh"), ("sonnet-medium", "claude-sonnet-5-5", "medium")):
            with self.subTest(profile):
                w = World()
                self.addCleanup(w.tmp.cleanup)
                w.cfg.update(producers=json.loads(json.dumps({**PRODUCERS, "deepseek": {
                    **PRODUCERS["deepseek"], "models": {"free": "p/free-x-free", "go": "p/go"}}})),
                    model_profiles=PROFILES, assignments=ASSIGN, maintainer=profile)
                self.assertIsNone(config_problem(w.cfg))
                produce_and_report(w)
                w.tick()
                launch = w.adapter.launches[-1]
                self.assertEqual((launch["model"], launch["effort"]), (model, effort))
                m = next(b for b in w.store.all_batches() if b["method"] == "m")
                self.assertEqual(m["producer"], maintainer_id(w.cfg))

    def test_stage2_runs_xhigh_on_the_single_part_slot(self):
        w = s2_world(self)
        w.cfg.update(producers=json.loads(json.dumps({**PRODUCERS})), model_profiles=PROFILES, assignments=ASSIGN)
        w.runner.models += ["p/free-x-free", "p/go"]
        self.assertTrue(control.start(w.store, "codex", "s2", "single", cfg=w.cfg)[0])
        self.assertFalse(control.start(w.store, "claude", "s2", "single", cfg=w.cfg)[0])   # one Part at a time, any model
        w.tick()
        self.assertEqual(w.store.active_batch("codex", "s2")["producer"], "codex")
        self.assertEqual((w.adapter.launches[-1]["model"], w.adapter.launches[-1]["effort"]), ("gpt-6-luna", "xhigh"))

    def test_reload_problem_is_pure_over_profiles(self):
        old, new = cfg(), cfg()
        self.assertIsNone(reload_problem(old, new, {"codex"}))
        new["assignments"]["stage1"]["codex"] = "missing"
        self.assertIsNotNone(reload_problem(old, new, {"codex"}))


if __name__ == "__main__":
    unittest.main()
