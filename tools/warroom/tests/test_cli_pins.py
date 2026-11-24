"""Issue #1373/#1374: pinned model + reasoning effort per producer, fail-closed validation, CLI-independent board order."""
import itertools
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from tests.test_issue_1684 import s2_world
from warroom.adapters import RunSpec, classify_failure
from warroom.config import (DEFAULTS, Paths, adapters, config_problem, effort_problem, load_config, ordered_models,
                            registry_problems, retired_notice, run_spec)
from warroom.store import SCHEMA, SCHEMA_V2, Store

QUOTA = DEFAULTS["quota_patterns"]
SONNET = {"label": "Sonnet", "adapter": "claude", "model": "sonnet", "effort": "medium"}
LUNA = {"label": "Luna", "adapter": "codex", "model": "gpt-6-luna", "effort": "xhigh"}
FORBIDDEN_FLAGS = ("--yolo", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
                   "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--variant")


def cfg_with(producers):
    return {**json.loads(json.dumps(DEFAULTS)), "producers": producers}


class BoardOrder(unittest.TestCase):
    """Claude -> Codex by adapter label; never by the order `producers` was written in."""

    def test_order_is_independent_of_registration_order(self):
        items = [("claude", SONNET), ("codex", LUNA), ("claude-2", {**SONNET, "label": "Zeta", "model": "opus"})]
        for perm in itertools.permutations(items):
            with self.subTest(order=[pid for pid, _ in perm]):
                cfg = cfg_with(dict(perm))
                self.assertEqual(adapters(cfg), ["claude", "codex"])
                self.assertEqual(ordered_models(cfg), ["claude", "claude-2", "codex"])

    def test_models_on_one_cli_sort_by_label_then_id(self):
        cfg = cfg_with({
            "claude-b": {**SONNET, "label": "Beta"},
            "claude-a": {**SONNET, "label": "Beta"},
            "claude-c": {**SONNET, "label": "Alpha", "model": "opus"},
            "codex": LUNA,
        })
        self.assertEqual(ordered_models(cfg), ["claude-c", "claude-a", "claude-b", "codex"])


class RetiredConfig(unittest.TestCase):
    """#9933: only the named Stage 1 / DeepSeek-OpenCode settings are dropped (with a notice); every other wrong value
    still fails the existing validation."""

    OWNER_SHAPE = {
        "producers": {"claude": {"label": "Sonnet", "adapter": "claude"}, "codex": {"label": "Luna", "adapter": "codex"},
                      "deepseek": {"label": "DeepSeek", "adapter": "opencode", "effort": "low",
                                   "models": {"free": "opencode/x-free", "go": "opencode-go/x"},
                                   "tier_efforts": {"api": "none"}, "retired_models": {}}},
        "model_profiles": {"terra": {"adapter": "codex", "model": "gpt-6-terra", "effort": "high", "permission_profile": "worktree"},
                           "luna-fast": {"adapter": "codex", "model": "gpt-6-luna", "effort": "low", "fast": True},
                           "sonnet-medium": {"adapter": "claude", "model": "claude-sonnet", "effort": "medium"}},
        "assignments": {"stage1": {"codex": "terra", "claude": "sonnet-medium"}, "stage1-ab": {"codex": "terra"},
                        "stage1-c": {"codex": "terra"}, "stage1-d": {"codex": "terra"},
                        "stage2": {"codex": "terra", "claude": "sonnet-medium"},
                        "stage3": {"codex": "luna-fast", "claude": "sonnet-medium"}},
        "methods": ["a", "b", "c", "d"], "literary_index_path": "/private/index", "corpus_index_path": "/private/corpus",
        "opencode_bin": "opencode", "free_model_pattern": "-free$", "maintainer": "sonnet-medium",
        "quota_patterns": ["provider quota"], "poll_seconds": 120, "pricing": {},
    }

    def load(self, user):
        with tempfile.TemporaryDirectory() as d:
            paths = Paths(repo_root=Path(d), local=Path(d) / "local")
            paths.ensure()
            paths.config_file.write_text(json.dumps(user), "utf-8")
            return load_config(paths)

    def test_retired_settings_are_dropped_and_the_rest_is_kept(self):
        cfg = self.load(self.OWNER_SHAPE)
        self.assertIsNone(config_problem(cfg))
        self.assertEqual(sorted(cfg["producers"]), ["claude", "codex"])
        self.assertEqual(sorted(cfg["assignments"]), ["stage2", "stage3"])
        self.assertEqual(cfg["model_profiles"], self.OWNER_SHAPE["model_profiles"])
        self.assertEqual((cfg["maintainer"], cfg["quota_patterns"], cfg["poll_seconds"]),
                         ("sonnet-medium", ["provider quota"], 120))
        for key in ("methods", "literary_index_path", "corpus_index_path", "opencode_bin", "free_model_pattern"):
            self.assertNotIn(key, cfg)
        self.assertEqual(cfg["_retired_producers"], ["deepseek"])
        notice = retired_notice(cfg)
        for path in ("producers.deepseek", "assignments.stage1-ab", "methods", "literary_index_path"):
            self.assertIn(path, notice)
        self.assertNotIn("/private/index", notice)          # paths are named, values never
        self.assertIsNone(retired_notice(self.load({"producers": {"codex": LUNA}})))

    def test_the_renamed_parallel_cap_moves_once_and_both_names_together_are_refused(self):
        """#9934: `stage3_max_parallel` is judged on the operator's own file, before DEFAULTS add the new name."""
        moved = self.load({**self.OWNER_SHAPE, "stage3_max_parallel": 6})
        self.assertIsNone(config_problem(moved))
        self.assertEqual(moved["refine_max_parallel"], 6)
        self.assertNotIn("stage3_max_parallel", moved)
        self.assertIn("stage3_max_parallel → refine_max_parallel", retired_notice(moved))
        self.assertEqual(self.load(self.OWNER_SHAPE)["refine_max_parallel"], 16)
        both = self.load({**self.OWNER_SHAPE, "stage3_max_parallel": 6, "refine_max_parallel": 8})
        self.assertIn("stage3_max_parallel와 refine_max_parallel가 함께 있습니다", config_problem(both))

    def test_wrong_values_are_still_rejected(self):
        cases = [
            ("unknown adapter", {"producers": {"codex": {**LUNA, "adapter": "gemini"}}}, "알 수 없는 adapter"),
            ("adapter missing", {"producers": {"codex": {k: v for k, v in LUNA.items() if k != "adapter"}}},
             "알 수 없는 adapter"),
            ("typo in a stage role", {"producers": {"codex": {"adapter": "codex"}}, "model_profiles": {"luna": LUNA},
                                      "assignments": {"stage-2": {"codex": "luna"}}}, "알 수 없는 단계"),
            ("missing profile", {"producers": {"codex": {"adapter": "codex"}}, "model_profiles": {},
                                 "assignments": {"stage2": {"codex": "luna"}}}, "프로필 'luna'가 없습니다"),
            ("OpenCode profile on a live stage", {"producers": {"codex": {"adapter": "codex"}},
                                                  "model_profiles": {"old": {"adapter": "opencode"}},
                                                  "assignments": {"stage2": {"codex": "old"}}}, "프로필 'old'가 없습니다"),
        ]
        for name, user, fragment in cases:
            with self.subTest(name):
                cfg = self.load(user)
                problem = config_problem(cfg) or "; ".join(registry_problems(cfg).values())
                self.assertIn(fragment, problem)


class RegistryValidation(unittest.TestCase):
    """Table over valid, invalid and unusual pins. Any problem blocks Start with a reason."""

    CASES = [
        # name, producer entry, expected reason fragment ("" = must be accepted)
        ("claude pinned", SONNET, ""),
        ("codex pinned", LUNA, ""),
        ("model missing", {**SONNET, "model": ""}, "모델 ID가 설정되지 않았습니다"),
        ("model absent key", {"label": "x", "adapter": "claude", "effort": "medium"}, "모델 ID가 설정되지 않았습니다"),
        ("model looks like a flag", {**SONNET, "model": "--dangerously-skip-permissions"}, "허용되지 않는 형식"),
        ("model has whitespace", {**SONNET, "model": "sonnet --yolo"}, "허용되지 않는 형식"),
        ("effort missing", {**SONNET, "effort": ""}, "추론 수준(effort)이 설정되지 않았습니다"),
        ("effort absent key", {"label": "x", "adapter": "claude", "model": "sonnet"}, "추론 수준(effort)이 설정되지 않았습니다"),
        ("claude effort upper case", {**SONNET, "effort": "MEDIUM"}, "지원하지 않습니다"),
        ("claude effort not in cli", {**SONNET, "effort": "minimal"}, "지원하지 않습니다"),
        ("codex effort minimal rejected by gpt-6-luna", {**LUNA, "effort": "minimal"}, "지원하지 않습니다"),
        ("codex effort max", {**LUNA, "effort": "max"}, ""),
        ("unknown adapter", {**SONNET, "adapter": "gemini"}, "알 수 없는 adapter"),
        ("retired adapter written directly", {**SONNET, "adapter": "opencode"}, "알 수 없는 adapter"),
    ]

    def test_table(self):
        for name, entry, fragment in self.CASES:
            with self.subTest(name):
                bad = registry_problems(cfg_with({"p": entry}))
                if fragment:
                    self.assertIn(fragment, bad.get("p", ""))
                else:
                    self.assertEqual(bad, {})

    def test_producer_id_and_duplicate_endpoint(self):
        bad = registry_problems(cfg_with({"Bad_ID": SONNET}))
        self.assertIn("Bad_ID", bad)
        bad = registry_problems(cfg_with({"claude": SONNET, "claude-2": {**SONNET, "label": "Dup"}}))
        self.assertIn("중복", bad.get("claude-2", "") + bad.get("claude", ""))

    def test_permission_profile_table(self):
        cases = [("codex", "worktree", None), ("codex", "", None), ("codex", "a_b-1", None),
                 ("codex", "-c", "형식"), ("codex", "a b", "형식"), ("codex", "a=b", "형식"), ("codex", "a/b", "형식"),
                 ("claude", "worktree", "Codex")]
        for adapter, profile, want in cases:
            with self.subTest(adapter=adapter, profile=profile):
                base = {"claude": SONNET, "codex": LUNA}[adapter]
                cfg = cfg_with({"m": {**base, "permission_profile": profile}})
                problem = registry_problems(cfg).get("m")
                self.assertTrue(problem is None if want is None else want in problem, problem)
        self.assertEqual(run_spec(cfg_with({"m": {**LUNA, "permission_profile": "worktree"}}), "m", "stage2"),
                         RunSpec("gpt-6-luna", "xhigh", "worktree"))
        self.assertEqual(run_spec(cfg_with({"m": LUNA}), "m", "stage2").permission_profile, "")
        self.assertIs(run_spec(cfg_with({"m": {**LUNA, "fast": True}}), "m", "stage2").fast, True)
        self.assertIsNone(run_spec(cfg_with({"m": {**SONNET, "fast": "ignored"}}), "m", "stage2").fast)

    def test_effort_problem_table(self):
        for adapter, effort, ok in [("claude", "medium", True), ("claude", "", False), ("claude", "none", False),
                                    ("codex", "xhigh", True), ("codex", "minimal", False)]:
            with self.subTest(adapter=adapter, effort=effort):
                self.assertEqual(effort_problem(adapter, effort) is None, ok)


class RunPins(unittest.TestCase):
    def test_every_run_carries_its_model_and_effort(self):
        cfg = cfg_with({"claude": SONNET, "codex": LUNA})
        self.assertEqual(run_spec(cfg, "claude", "stage2"), RunSpec("sonnet", "medium"))
        self.assertEqual(run_spec(cfg, "codex", "stage2"), RunSpec("gpt-6-luna", "xhigh"))
        with self.assertRaises(ValueError):   # #9934: a refinement Stage never runs on the producer pin
            run_spec(cfg, "codex", "stage3")

    def test_unpinned_run_raises_instead_of_defaulting(self):
        for entry in ({**SONNET, "model": ""}, {**SONNET, "effort": ""}):
            with self.subTest(entry=entry):
                with self.assertRaises(ValueError):
                    run_spec(cfg_with({"p": entry}), "p", "stage2")


class EffortRejection(unittest.TestCase):
    def test_classification_table(self):
        cases = [
            ("Unsupported value: 'minimal' is not supported with the 'gpt-6-luna' model. Supported values are: 'none'", "effort"),
            ("unsupported effort level", "effort"),
            ("FreeUsageLimitError reached", "unknown"),          # no configured quota pattern: never guessed
            ("HTTP 429 Too Many Requests", "rate_limit"),
            ("401 unauthorized", "auth"),
            ("weird provider blob", "unknown"),
        ]
        for text, want in cases:
            with self.subTest(text=text):
                self.assertEqual(classify_failure(text, QUOTA), want)

    def test_rejected_effort_stops_the_batch_without_another_run(self):
        w = s2_world(self)
        w.adapter.plan.append({"code": 1, "text": "Unsupported value: 'xhigh' is not supported. Supported values are: 'low'"})
        w.start("single", "codex", "s2")
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        row = w.row()
        self.assertEqual((row["state"], len(w.adapter.launches)), ("ERROR", 1))


class PinnedLaunches(unittest.TestCase):
    def setUp(self):
        self.w = s2_world(self)
        self.w.cfg["producers"] = {"claude": SONNET, "codex": LUNA}

    def test_start_records_model_and_effort_in_run_history_and_audit_log(self):
        w = self.w
        w.start("single", "claude", "s2")
        w.tick()
        launch = w.adapter.launches[-1]
        self.assertEqual((launch["model"], launch["effort"]), ("sonnet", "medium"))
        run = w.store.runs(w.row("claude", "s2")["id"])[0]
        self.assertEqual((run["model"], run["effort"]), ("sonnet", "medium"))
        self.assertTrue(any("model=sonnet, effort=medium" in e["msg"] for e in w.store.recent_events(50)))

    def test_codex_pin_on_start(self):
        w = self.w
        w.start("single", "codex", "s2")
        w.tick()
        self.assertEqual((w.adapter.launches[-1]["model"], w.adapter.launches[-1]["effort"]), ("gpt-6-luna", "xhigh"))

    def test_unbuilt_cli_is_blocked_explicitly_and_never_redirected(self):
        w = self.w
        w.sup.adapter = {"codex": w.adapter}              # this build has no Claude adapter
        w.start("single", "claude", "s2")
        w.tick()
        self.assertEqual(w.adapter.launches, [])
        self.assertIsNone(w.store.active_batch("claude", "s2"))
        self.assertIn("CLI 어댑터가 이 War Room 빌드에 없습니다", w.store.line("claude", "s2")["blocked"])

    def test_resume_uses_current_model_effort_and_permission_profile_and_preserves_history(self):
        w = self.w
        w.cfg["producers"] = {"codex": {**LUNA, "permission_profile": "worktree", "fast": True}}
        w.adapter.plan.append({"session": "session-first"})
        w.start("single", "codex", "s2")
        w.tick(2)   # capture the first run's session ID
        bid = w.row("codex", "s2")["id"]
        old_run = w.store.runs(bid)[0]
        self.assertEqual((old_run["model"], old_run["effort"], old_run["permission_profile"]),
                         ("gpt-6-luna", "xhigh", "worktree"))
        self.assertEqual(old_run["fast_mode"], 1)

        w.cfg["producers"]["codex"] = {"label": "Luna", "adapter": "codex", "model": "gpt-6-sol",
                                         "effort": "high", "permission_profile": "restricted", "fast": False}
        w.sup._launch(w.store.batch(bid), "produce_resume")

        self.assertEqual((w.adapter.launches[-1]["kind"], w.adapter.launches[-1]["model"],
                          w.adapter.launches[-1]["effort"], w.adapter.launches[-1]["permission_profile"],
                          w.adapter.launches[-1]["session"]),
                         ("resume", "gpt-6-sol", "high", "restricted", "session-first"))
        self.assertIs(w.adapter.launches[-1]["fast"], False)
        runs = w.store.runs(bid)
        self.assertEqual((runs[0]["model"], runs[0]["effort"], runs[0]["permission_profile"]),
                         ("gpt-6-sol", "high", "restricted"))
        self.assertEqual((runs[1]["model"], runs[1]["effort"], runs[1]["permission_profile"]),
                         ("gpt-6-luna", "xhigh", "worktree"))
        self.assertEqual((runs[0]["fast_mode"], runs[1]["fast_mode"]), (0, 1))
        self.assertEqual((runs[0]["session_id"], runs[1]["session_id"]),
                         ("session-first", "session-first"))


class StoreV3(unittest.TestCase):
    def test_v2_database_gains_run_pin_columns_and_keeps_old_runs(self):
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "warroom.db"
            c = sqlite3.connect(db)
            c.executescript(SCHEMA + SCHEMA_V2)
            c.execute("PRAGMA user_version=2")
            c.execute("INSERT INTO batches(method,producer,shard,batch,branch,worktree,state,created_at,updated_at) "
                      "VALUES('a','deepseek','001','01','b','/w','COMPLETE',1,1)")
            c.execute("INSERT INTO runs(batch_id,kind,started_at) VALUES(1,'legacy',1)")
            c.commit()
            c.close()
            store = Store(db)
            with store._conn() as c:
                cols = {r["name"] for r in c.execute("PRAGMA table_info(runs)")}
            self.assertTrue({"model", "effort", "fast_mode"} <= cols)
            run = store.runs(1)[0]
            self.assertIsNone(run["model"])
            self.assertIsNone(run["effort"])
            self.assertIsNone(run["fast_mode"])

    def test_add_run_round_trips_the_pin(self):
        with tempfile.TemporaryDirectory() as d:
            store = Store(Path(d) / "warroom.db")
            bid = store.create_batch(method="a", producer="claude", shard="001", batch="01", branch="b",
                                     worktree="/w")
            store.add_run(bid, "produce", None, 1, "l.log", "l.exit", model="gpt-6-luna", effort="xhigh",
                          fast_mode=True)
            run = store.runs(bid)[0]
            self.assertEqual((run["model"], run["effort"], run["fast_mode"]), ("gpt-6-luna", "xhigh", 1))


if __name__ == "__main__":
    unittest.main()
