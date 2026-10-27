"""Issue #1867: model profiles + per-stage assignments. Stage 1 (A/B/C/D), Stage 2 and the Maintainer resolve their own
profile (adapter/model/effort/permission_profile) from config; producer identity, pins and fail-closed rules are unchanged."""
import json
import unittest
from pathlib import Path

from tests.fakes import World
from tests.test_issue_1555 import produce_and_report
from tests.test_issue_1684 import s2_world
from warroom import control
from warroom.config import (DEFAULTS, MAINTAINER, STAGE1, STAGE2, config_problem, maintainer_id, maintainer_problem,
                            registry, registry_problems, reload_problem, role_of, run_spec)
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


class DisplayPins(unittest.TestCase):
    def test_detail_never_shows_another_stages_pin(self):
        from warroom.config import pin_summary
        from warroom.views import detail_meta
        st = {"worktree": "", "state": "", "branch": "", "head": "", "session": "", "tier": "free"}
        for assigned, shown, hidden in [("stage1", "a", "s2"), ("stage2", "s2", "a")]:
            c = cfg(assignments={assigned: {"codex": "luna-high" if assigned == "stage1" else "luna-xhigh"}}, maintainer="sonnet-medium")
            c["assignments"][assigned]["claude"] = "sonnet-medium"
            with self.subTest(assigned):
                from warroom.config import role_view
                ok = detail_meta(st, role_view(c, "codex", shown), "codex")
                no = detail_meta(st, role_view(c, "codex", hidden), "codex")
                self.assertIn("gpt-6-luna", ok)
                self.assertNotIn("gpt-6-luna", no)
                self.assertNotIn("high", no)
                self.assertIn("미배정", no)
                self.assertNotIn("gpt-6-luna", pin_summary(registry(c)["codex"]))   # settings: no stage-less pin either
        self.assertIn("gpt-6-luna", detail_meta(st, role_view(cfg(), "codex", "s2"), "codex"))

    def test_web_line_detail_uses_the_stage_pin(self):
        from tests.test_web_1720 import Env
        from warroom.web import api
        for assigned, shown, hidden, effort in [("stage1", "a", "s2", "high"), ("stage2", "s2", "a", "xhigh"), ("both", "s2", "a", "xhigh")]:
            e = Env()
            self.addCleanup(e.close)
            a = {"stage1": {"codex": "luna-high"}, "stage2": {"codex": "luna-xhigh"}}
            if assigned != "both":
                a = {assigned: a[assigned]}
            e.cfg = cfg(assignments=a, maintainer="sonnet-medium", producers={"codex": PRODUCERS["codex"], "claude": PRODUCERS["claude"]},
                        model_profiles=PROFILES)
            e.cfg["assignments"].setdefault("stage1", {})["claude"] = "sonnet-medium"
            e.cfg["assignments"].setdefault("stage2", {})["claude"] = "sonnet-medium"
            with self.subTest(assigned):
                ok = api.line_detail(e.store, e.cfg, e.paths, "codex", shown)["meta"]
                self.assertIn(f"effort: {effort}" if assigned != "both" else "effort: xhigh", ok)
                if assigned != "both":
                    no = api.line_detail(e.store, e.cfg, e.paths, "codex", hidden)["meta"]
                    self.assertNotIn("gpt-6-luna", no)
                    self.assertIn("미배정", no)
                else:
                    self.assertIn("effort: high", api.line_detail(e.store, e.cfg, e.paths, "codex", "a")["meta"])


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

    def test_running_batch_keeps_its_recorded_pin_across_an_assignment_change(self):
        w = self.world()
        w.start("single", "codex", "a")
        w.tick()
        self.assertEqual(w.adapter.launches[-1]["effort"], "high")
        write(w, PRODUCERS, model_profiles=PROFILES,
              assignments={**ASSIGN, "stage1": {**ASSIGN["stage1"], "codex": "luna-xhigh"}})
        self.assertTrue(reload(w)[0])
        control.stop_line(w.store, "codex", "a")
        w.tick()
        control.retry(w.store, "codex", "a")
        w.tick(2)
        b = w.store.active_batch("codex", "a")
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("실행 설정 변경 차단", b["error"])
        write(w, PRODUCERS, model_profiles=PROFILES, assignments=ASSIGN)   # restore: resumes on the recorded pin
        self.assertTrue(reload(w)[0])
        control.retry(w.store, "codex", "a")
        w.tick(2)
        self.assertEqual(w.store.active_batch("codex", "a")["state"], "PRODUCING")
        self.assertEqual(w.adapter.launches[-1]["effort"], "high")
        # a different Line starting after the change uses the new assignment
        write(w, PRODUCERS, model_profiles=PROFILES,
              assignments={**ASSIGN, "stage1": {**ASSIGN["stage1"], "codex": "luna-xhigh"}})
        self.assertTrue(reload(w)[0])
        w.start("single", "codex", "b")
        w.tick()
        self.assertEqual(w.adapter.launches[-1]["effort"], "xhigh")

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
