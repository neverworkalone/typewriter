"""Issue #1867: model profiles + per-stage assignments resolve current settings for each new run."""
import json
import unittest

from tests.test_issue_1555 import produce_and_report
from tests.test_issue_1684 import s2_world
from tests.test_reload import reload, stage2_world, write
from warroom import control
from warroom.config import (DEFAULTS, MAINTAINER, STAGE2, STAGE3, config_problem, maintainer_id, maintainer_problem,
                            registry_problems, reload_problem, role_of, role_problem, role_view, run_spec)

PROFILES = {
    "luna-high": {"adapter": "codex", "model": "gpt-6-luna", "effort": "high", "permission_profile": "worktree", "fast": True},
    "luna-xhigh": {"adapter": "codex", "model": "gpt-6-luna", "effort": "xhigh", "permission_profile": "worktree", "fast": False},
    "sonnet-medium": {"adapter": "claude", "model": "claude-sonnet-5-5", "effort": "medium", "fast": "ignored"},
}
PRODUCERS = {
    "claude": {"label": "Sonnet", "adapter": "claude"},
    "codex": {"label": "Luna", "adapter": "codex"},
}
ASSIGN = {"stage2": {"codex": "luna-xhigh", "claude": "sonnet-medium"},
          "stage3": {"codex": "luna-high", "claude": "sonnet-medium"}}


def cfg(**over):
    c = json.loads(json.dumps(DEFAULTS))
    c.update(producers=json.loads(json.dumps(PRODUCERS)), model_profiles=json.loads(json.dumps(PROFILES)),
             assignments=json.loads(json.dumps(ASSIGN)), maintainer="luna-xhigh")
    c.update(over)
    return c


def pin(c, producer, role):
    s = run_spec(c, producer, role)
    return s.model, s.effort, s.permission_profile


class Resolution(unittest.TestCase):
    def test_same_model_two_efforts_is_valid_and_each_role_pins_its_own(self):
        c = cfg()
        self.assertIsNone(config_problem(c))
        self.assertEqual(registry_problems(c), {})
        for method, role in (("s2", STAGE2), ("s3", STAGE3), ("m", MAINTAINER)):
            self.assertEqual(role_of(method), role)
        self.assertEqual(role_of("a"), "")   # a retired Stage 1 method resolves to no role (#9933)
        self.assertEqual(pin(c, "codex", STAGE2), ("gpt-6-luna", "xhigh", "worktree"))
        self.assertEqual(pin(c, "codex", STAGE3), ("gpt-6-luna", "high", "worktree"))
        self.assertEqual(pin(c, "codex", MAINTAINER), ("gpt-6-luna", "xhigh", "worktree"))
        self.assertEqual(pin(c, "claude", STAGE3), ("claude-sonnet-5-5", "medium", ""))
        self.assertIs(run_spec(c, "codex", STAGE3).fast, True)
        self.assertIs(run_spec(c, "codex", STAGE2).fast, False)
        self.assertIsNone(run_spec(c, "claude", STAGE3).fast)

    def test_a_stage_only_assignment_never_leaks_to_another_stage(self):
        c = cfg(assignments={STAGE3: {"codex": "luna-high", "claude": "sonnet-medium"}})
        self.assertIsNone(config_problem(c))
        self.assertEqual(registry_problems(c), {})
        self.assertEqual(pin(c, "codex", STAGE3), ("gpt-6-luna", "high", "worktree"))
        self.assertIsNotNone(role_problem(c, "codex", STAGE2))
        self.assertEqual(role_view(c, "codex", "s2")["model"], "")
        self.assertIn("unassigned", role_view(c, "codex", "s2"))
        self.assertIn("unassigned", role_view(c, "codex", "a"))      # a retired method shows no pin either
        self.assertEqual(role_view(c, "codex", "s3")["effort"], "high")

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
                          "codex": {"adapter": "codex", "model": "gpt-6-luna", "effort": "xhigh", "fast": False}}
        c["maintainer"] = "codex"
        self.assertIsNone(config_problem(c))
        self.assertIsNone(maintainer_problem(c))
        for role in (STAGE2, STAGE3, MAINTAINER):
            self.assertEqual(pin(c, "codex", role), ("gpt-6-luna", "xhigh", ""))
            self.assertIs(run_spec(c, "codex", role).fast, False)
        c["producers"]["codex"]["fast"] = "true"
        self.assertIn("fast", config_problem(c))

    def test_non_codex_fast_is_ignored_even_when_its_value_is_not_boolean(self):
        c = cfg()
        self.assertIsNone(config_problem(c))
        self.assertIsNone(run_spec(c, "claude", STAGE3).fast)

    def test_invalid_and_ambiguous_configs_fail_closed(self):
        def mut(f):
            c = cfg()
            f(c)
            return c
        two_codex = lambda c: c["producers"].update(codex2={"label": "L2", "adapter": "codex"})
        cases = [
            ("profile missing", mut(lambda c: c["assignments"]["stage3"].update(codex="nope"))),
            ("producer missing", mut(lambda c: c["assignments"]["stage3"].update(ghost="luna-high"))),
            ("adapter mismatch", mut(lambda c: c["assignments"]["stage3"].update(codex="sonnet-medium"))),
            ("unknown stage", mut(lambda c: c["assignments"].update(stage4={"codex": "luna-high"}))),
            ("retired Stage 1 role written directly", mut(lambda c: c["assignments"].update(stage1={"codex": "luna-high"}))),
            ("bad effort", mut(lambda c: c["model_profiles"]["luna-high"].update(effort="turbo"))),
            ("no effort", mut(lambda c: c["model_profiles"]["luna-high"].pop("effort"))),
            ("no model", mut(lambda c: c["model_profiles"]["luna-high"].pop("model"))),
            ("flag-like model", mut(lambda c: c["model_profiles"]["luna-high"].update(model="--yolo"))),
            ("bad adapter", mut(lambda c: c["model_profiles"]["luna-high"].update(adapter="gemini"))),
            ("opencode profile written directly", mut(lambda c: c["model_profiles"].update(
                ds={"adapter": "opencode", "model": "x", "effort": "high"}))),
            ("permission on claude", mut(lambda c: c["model_profiles"]["sonnet-medium"].update(permission_profile="worktree"))),
            ("non-boolean codex fast", mut(lambda c: c["model_profiles"]["luna-high"].update(fast="true"))),
            ("non-string effort", mut(lambda c: c["model_profiles"]["luna-high"].update(effort=3))),
            ("profiles not object", mut(lambda c: c.update(model_profiles=[]))),
            ("assignments not object", mut(lambda c: c.update(assignments=[]))),
            ("legacy pin + assignment", mut(lambda c: c["producers"]["codex"].update(model="gpt-6-luna", effort="xhigh"))),
            ("maintainer is a governed producer id", mut(lambda c: c.update(maintainer="codex"))),
            ("maintainer in both namespaces", mut(lambda c: (c["model_profiles"].update(claude=PROFILES["sonnet-medium"]),
                                                             c.update(maintainer="claude")))),
            ("ambiguous maintainer adapter", mut(lambda c: (two_codex(c), c.update(maintainer="luna-xhigh"),
                                                            c["assignments"]["stage3"].update(codex2="luna-xhigh"),
                                                            c["assignments"]["stage2"].update(codex2="luna-xhigh")))),
            ("maintainer with no unique producer", mut(lambda c: (two_codex(c), c.update(maintainer="luna-xhigh"),
                                                                  c["assignments"].update(stage3={"claude": "sonnet-medium"},
                                                                                          stage2={})))),
        ]
        for name, c in cases:
            with self.subTest(name):
                self.assertIsNotNone(config_problem(c))
        # a second codex producer is fine once the profile is assigned to exactly one of them
        c = mut(lambda c: (two_codex(c), c["model_profiles"].update(**{"luna-medium": {**PROFILES["luna-high"], "effort": "medium"}}),
                           c["assignments"]["stage3"].update(codex2="luna-medium"), c.update(maintainer="luna-medium")))
        self.assertIsNone(config_problem(c))
        self.assertEqual(maintainer_id(c), "codex2")


class ReloadAndRuns(unittest.TestCase):
    def world(self, **over):
        self.w = stage2_world()
        self.addCleanup(self.w.tmp.cleanup)
        options = {"model_profiles": PROFILES, "assignments": ASSIGN, **over}
        write(self.w, PRODUCERS, **options)
        self.assertTrue(reload(self.w)[0])
        return self.w

    def test_reload_rejects_bad_profiles_and_keeps_old_config(self):
        w = self.world(maintainer="luna-xhigh")
        self.assertIsNone(reload_problem(w.sup.cfg, w.sup.cfg, {"codex"}))
        bad = {**ASSIGN, "stage3": {**ASSIGN["stage3"], "codex": "missing"}}
        write(w, PRODUCERS, model_profiles=PROFILES, assignments=bad, maintainer="luna-xhigh")
        ok, msg = reload(w)
        self.assertFalse(ok)
        self.assertIn("missing", msg)
        self.assertEqual(w.sup.cfg["assignments"]["stage3"]["codex"], "luna-high")

    def test_start_is_blocked_without_a_stage_pin(self):
        w = self.world()
        write(w, PRODUCERS, model_profiles=PROFILES, assignments={"stage3": ASSIGN["stage3"]})
        self.assertTrue(reload(w)[0])
        w.store.set_line("claude", "s2", run=1, mode="single")   # a reservation that bypassed Start's own check
        w.tick()
        self.assertIn("시작 차단", w.store.peek_line("claude", "s2")["blocked"])
        self.assertEqual(w.adapter.launches, [])

    def test_running_batch_uses_reloaded_assignment_and_keeps_each_run_record(self):
        w = self.world()
        w.adapter.plan.append({"session": "session-first"})
        w.start("single", "codex", "s2")
        w.tick(2)
        bid = w.row("codex", "s2")["id"]
        first = w.store.runs(bid)[0]
        self.assertEqual((first["model"], first["effort"], first["permission_profile"], first["fast_mode"]),
                         ("gpt-6-luna", "xhigh", "worktree", 0))
        write(w, PRODUCERS, model_profiles=PROFILES, assignments={**ASSIGN, "stage2": {**ASSIGN["stage2"], "codex": "luna-high"}})
        self.assertTrue(reload(w)[0])
        w.sup._launch(w.store.batch(bid), "produce_resume")
        self.assertEqual((w.adapter.launches[-1]["kind"], w.adapter.launches[-1]["model"],
                          w.adapter.launches[-1]["effort"], w.adapter.launches[-1]["permission_profile"],
                          w.adapter.launches[-1]["session"]),
                         ("resume", "gpt-6-luna", "high", "worktree", "session-first"))
        self.assertIs(w.adapter.launches[-1]["fast"], True)
        runs = w.store.runs(bid)
        self.assertEqual((runs[0]["effort"], runs[1]["effort"]), ("high", "xhigh"))
        self.assertEqual((runs[0]["fast_mode"], runs[1]["fast_mode"]), (1, 0))
        self.assertEqual((runs[0]["session_id"], runs[1]["session_id"]), ("session-first", "session-first"))

    def test_running_batch_uses_reloaded_permission_profile(self):
        w = self.world()
        w.adapter.plan.append({"session": "session-profile"})
        w.start("single", "codex", "s2")
        w.tick(2)
        bid = w.row("codex", "s2")["id"]
        profiles = {**PROFILES, "luna-xhigh-restricted": {**PROFILES["luna-xhigh"], "permission_profile": "restricted"}}
        assignments = {**ASSIGN, "stage2": {**ASSIGN["stage2"], "codex": "luna-xhigh-restricted"}}
        write(w, PRODUCERS, model_profiles=profiles, assignments=assignments)
        self.assertTrue(reload(w)[0])
        w.sup._launch(w.store.batch(bid), "produce_resume")
        runs = w.store.runs(bid)
        self.assertEqual((runs[0]["permission_profile"], runs[1]["permission_profile"]), ("restricted", "worktree"))

    def test_maintainer_runs_its_profile_and_switches_by_profile_id_only(self):
        for profile, model, effort in (("luna-xhigh", "gpt-6-luna", "xhigh"), ("sonnet-medium", "claude-sonnet-5-5", "medium")):
            with self.subTest(profile):
                w = s2_world(self)
                w.cfg.update(producers=json.loads(json.dumps(PRODUCERS)), model_profiles=PROFILES, assignments=ASSIGN,
                             maintainer=profile)
                self.assertIsNone(config_problem(w.cfg))
                produce_and_report(w)
                w.tick()
                launch = w.adapter.launches[-1]
                self.assertEqual((launch["model"], launch["effort"]), (model, effort))
                self.assertEqual(launch["fast"], False if profile == "luna-xhigh" else None)
                m = next(b for b in w.store.all_batches() if b["method"] == "m")
                self.assertEqual(m["producer"], maintainer_id(w.cfg))

    def test_stage2_runs_xhigh_on_the_single_part_slot(self):
        w = s2_world(self)
        w.cfg.update(producers=json.loads(json.dumps(PRODUCERS)), model_profiles=PROFILES, assignments=ASSIGN)
        self.assertTrue(control.start(w.store, "codex", "s2", "single", cfg=w.cfg)[0])
        self.assertFalse(control.start(w.store, "claude", "s2", "single", cfg=w.cfg)[0])   # one Part at a time, any model
        w.tick()
        self.assertEqual(w.store.active_batch("codex", "s2")["producer"], "codex")
        self.assertEqual((w.adapter.launches[-1]["model"], w.adapter.launches[-1]["effort"]), ("gpt-6-luna", "xhigh"))
        self.assertIs(w.adapter.launches[-1]["fast"], False)


if __name__ == "__main__":
    unittest.main()
