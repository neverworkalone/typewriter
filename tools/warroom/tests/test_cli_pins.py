"""Issue #1373/#1374: pinned model + reasoning effort per producer, fail-closed validation, CLI-independent board order."""
import itertools
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.fakes import World
from warroom import control
from warroom.adapters import Handle, OpenCodeAdapter, RunSpec, classify_failure
from warroom.config import (DEFAULTS, adapters, effort_problem, ordered_models, pin_summary, registry,
                            registry_problems, run_spec)
from warroom.store import SCHEMA, SCHEMA_V2, Store
from warroom.supervisor import Supervisor

try:
    import textual  # noqa: F401
except ImportError:  # pragma: no cover - the TUI check needs Textual (installed in .local/venv)
    textual = None

QUOTA = DEFAULTS["quota_patterns"]
SONNET = {"label": "Sonnet", "adapter": "claude", "model": "sonnet", "effort": "medium"}
LUNA = {"label": "Luna", "adapter": "codex", "model": "gpt-6-luna", "effort": "xhigh"}
DEEPSEEK = {"label": "DeepSeek", "adapter": "opencode", "effort": "high",
            "models": {"free": "opencode/deepseek-v4.1-flash-free", "go": "opencode-go/deepseek-v4.1-flash"}}
FORBIDDEN_FLAGS = ("--yolo", "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions",
                   "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "--variant")


def cfg_with(producers):
    return {**json.loads(json.dumps(DEFAULTS)), "producers": producers}


class BoardOrder(unittest.TestCase):
    """Claude -> Codex -> OpenCode by adapter label; never by the order `producers` was written in."""

    def test_order_is_independent_of_registration_order(self):
        items = [("claude", SONNET), ("codex", LUNA), ("deepseek", DEEPSEEK)]
        for perm in itertools.permutations(items):
            with self.subTest(order=[pid for pid, _ in perm]):
                cfg = cfg_with(dict(perm))
                self.assertEqual(adapters(cfg), ["claude", "codex", "opencode"])
                self.assertEqual(ordered_models(cfg), ["claude", "codex", "deepseek"])

    def test_models_on_one_cli_sort_by_label_then_id(self):
        cfg = cfg_with({
            "claude-b": {**SONNET, "label": "Beta"},
            "claude-a": {**SONNET, "label": "Beta"},
            "claude-c": {**SONNET, "label": "Alpha", "model": "opus"},
            "codex": LUNA,
        })
        self.assertEqual(ordered_models(cfg), ["claude-c", "claude-a", "claude-b", "codex"])

    def test_legacy_single_worker_is_one_column(self):
        self.assertEqual(ordered_models(DEFAULTS), ["deepseek"])
        self.assertEqual(adapters(DEFAULTS), ["opencode"])


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
        ("opencode high", DEEPSEEK, ""),
        ("opencode effort with hash", {**DEEPSEEK, "effort": "high#low"}, "형식이 올바르지 않습니다"),
        ("opencode effort with space", {**DEEPSEEK, "effort": "high low"}, "형식이 올바르지 않습니다"),
        ("opencode effort empty", {**DEEPSEEK, "effort": ""}, "추론 수준(effort)이 설정되지 않았습니다"),
        ("opencode legacy without effort key", {"adapter": "opencode", "models": DEEPSEEK["models"]}, ""),
        ("unknown adapter", {**SONNET, "adapter": "gemini"}, "알 수 없는 adapter"),
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

    def test_legacy_deepseek_runs_at_owner_fixed_high(self):
        reg = registry(DEFAULTS)
        self.assertEqual(reg["deepseek"]["effort"], "high")
        self.assertEqual(registry_problems(DEFAULTS), {})

    def test_effort_problem_table(self):
        for adapter, effort, ok in [("claude", "medium", True), ("claude", "", False), ("claude", "none", False),
                                    ("codex", "xhigh", True), ("codex", "minimal", False),
                                    ("opencode", "high", True), ("opencode", "Hi", False)]:
            with self.subTest(adapter=adapter, effort=effort):
                self.assertEqual(effort_problem(adapter, effort) is None, ok)


class RunPins(unittest.TestCase):
    def test_every_run_carries_its_model_and_effort(self):
        cfg = cfg_with({"claude": SONNET, "codex": LUNA, "deepseek": DEEPSEEK})
        self.assertEqual(run_spec(cfg, "claude"), RunSpec("sonnet", "medium"))
        self.assertEqual(run_spec(cfg, "codex"), RunSpec("gpt-6-luna", "xhigh"))
        self.assertEqual(run_spec(cfg, "deepseek", "free"), RunSpec("opencode/deepseek-v4.1-flash-free", "high"))
        self.assertEqual(run_spec(cfg, "deepseek", "go"), RunSpec("opencode-go/deepseek-v4.1-flash", "high"))

    def test_go_switch_changes_model_never_effort(self):
        cfg = cfg_with({"deepseek": DEEPSEEK})
        free, go = run_spec(cfg, "deepseek", "free"), run_spec(cfg, "deepseek", "go")
        self.assertNotEqual(free.model, go.model)
        self.assertEqual(free.effort, go.effort)

    def test_unpinned_run_raises_instead_of_defaulting(self):
        for entry, tier in [({**SONNET, "model": ""}, "free"), ({**SONNET, "effort": ""}, "free"),
                            ({"adapter": "opencode", "models": {"free": "", "go": ""}, "effort": "high"}, "free"),
                            ({"adapter": "opencode", "models": {"free": "x-free", "go": ""}, "effort": "high"}, "go")]:
            with self.subTest(entry=entry, tier=tier):
                with self.assertRaises(ValueError):
                    run_spec(cfg_with({"p": entry}), "p", tier)

    def test_pin_summary_shows_effort(self):
        self.assertEqual(pin_summary(registry(cfg_with({"claude": SONNET}))["claude"]), "model=sonnet  effort=medium")
        self.assertIn("effort=high", pin_summary(registry(cfg_with({"deepseek": DEEPSEEK}))["deepseek"]))


class OpenCodeArgv(unittest.TestCase):
    class Recording(OpenCodeAdapter):
        def _spawn(self, cmd, cwd, env, log_file, exit_file):
            self.cmd = cmd
            return Handle(0, Path(exit_file), Path(log_file))

    def test_variant_is_model_suffix_and_no_forbidden_flag(self):
        for model, effort in [("opencode/deepseek-v4.1-flash-free", "high"), ("opencode-go/deepseek-v4.1-flash", "high")]:
            with self.subTest(model=model):
                a = self.Recording("opencode")
                run = RunSpec(model, effort)
                a.start("p", ".", {}, run, "t", "l.log", "l.exit")
                start = list(a.cmd)
                a.resume("ses_1", "again", ".", {}, run, "l.log", "l.exit")
                resume = list(a.cmd)
                for argv in (start, resume):
                    self.assertEqual(argv[argv.index("--model") + 1], f"{model}#high")
                    for flag in FORBIDDEN_FLAGS:
                        self.assertNotIn(flag, argv)

    def test_unpinned_run_is_refused_by_the_adapter_itself(self):
        a = self.Recording("opencode")
        with self.assertRaises(ValueError):
            a.start("p", ".", {}, RunSpec("", "high"), "t", "l.log", "l.exit")
        with self.assertRaises(ValueError):
            a.resume("ses_1", "p", ".", {}, RunSpec("p/m", ""), "l.log", "l.exit")


class EffortRejection(unittest.TestCase):
    def test_classification_table(self):
        cases = [
            ("Variant unavailable for opencode/deepseek-v4.1-flash-free: bogus", "effort"),
            ("Unsupported value: 'minimal' is not supported with the 'gpt-6-luna' model. Supported values are: 'none'", "effort"),
            ("unsupported effort level", "effort"),
            ("FreeUsageLimitError reached", "free_quota"),       # quota first, always
            ("HTTP 429 Too Many Requests", "rate_limit"),
            ("401 unauthorized", "auth"),
            ("weird provider blob", "unknown"),
        ]
        for text, want in cases:
            with self.subTest(text=text):
                self.assertEqual(classify_failure(text, QUOTA), want)

    def test_rejected_effort_stops_the_batch_without_a_go_switch(self):
        w = World()
        w.start("single")
        w.adapter.plan.append({"code": 1, "text": "Variant unavailable for opencode/p/free-x-free: high"})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        row = w.row()
        self.assertEqual((row["state"], row["model_tier"], len(w.adapter.launches)), ("ERROR", "free", 1))
        w.tmp.cleanup()


class PinDrift(unittest.TestCase):
    """A resumed session must continue on the model and effort that started it (non-tiered CLIs)."""

    def test_table(self):
        cases = [  # prev (model, effort), now (model, effort), tiered, drift?
            (("sonnet", "medium"), ("sonnet", "medium"), False, False),
            (("sonnet", "medium"), ("sonnet", "high"), False, True),
            (("sonnet", "medium"), ("opus", "medium"), False, True),
            (("p/free", "high"), ("p/go", "high"), True, False),       # Free -> Go keeps effort: allowed
            (("p/free", "high"), ("p/free", "low"), True, True),       # effort drift always blocks
            ((None, None), ("sonnet", "medium"), False, False),        # legacy run: nothing recorded
        ]
        for (pm, pe), (m, e), tiered, drift in cases:
            with self.subTest(prev=(pm, pe), now=(m, e), tiered=tiered):
                runs = [{"model": pm, "effort": pe}] if pe is not None else [{"model": None, "effort": None}]
                reason = Supervisor._pin_drift({"id": 1}, RunSpec(m, e), tiered, runs)
                self.assertEqual(reason is not None, drift)


class PinnedLaunches(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.w.cfg["producers"] = {"claude": SONNET, "codex": LUNA}
        self.w.cfg["models"] = {"free": "p/free-x-free", "go": "p/go"}

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_start_records_model_and_effort_in_run_history_and_audit_log(self):
        w = self.w
        w.start("single", "claude", "a")
        w.tick()
        launch = w.adapter.launches[-1]
        self.assertEqual((launch["model"], launch["effort"]), ("sonnet", "medium"))
        run = w.store.runs(w.row("claude", "a")["id"])[0]
        self.assertEqual((run["model"], run["effort"]), ("sonnet", "medium"))
        self.assertTrue(any("model=sonnet, effort=medium" in e["msg"] for e in w.store.recent_events(50)))

    def test_codex_pin_on_start(self):
        w = self.w
        w.start("single", "codex", "a")
        w.tick()
        self.assertEqual((w.adapter.launches[-1]["model"], w.adapter.launches[-1]["effort"]), ("gpt-6-luna", "xhigh"))

    def test_unbuilt_cli_is_blocked_explicitly_and_never_redirected(self):
        w = self.w
        w.sup.adapter = {"opencode": w.adapter}           # this build has no Claude adapter
        w.start("single", "claude", "a")
        w.tick()
        self.assertEqual(w.adapter.launches, [])
        self.assertIsNone(w.store.active_batch("claude", "a"))
        self.assertIn("CLI 어댑터가 이 War Room 빌드에 없습니다", w.store.line("claude", "a")["blocked"])

    def test_resume_with_a_different_effort_is_refused(self):
        w = self.w
        w.start("single", "claude", "a")
        w.tick()                                                   # first run pinned to sonnet / medium
        b = w.store.batch(w.row("claude", "a")["id"])
        w.cfg["producers"]["claude"] = {**SONNET, "effort": "high"}  # operator changed the pin mid-batch
        w.sup._launch(b, "produce_resume")
        self.assertEqual(len(w.adapter.launches), 1)                 # never resumed on the new pin
        self.assertEqual(w.row("claude", "a")["state"], "ERROR")
        self.assertIn("실행 설정 변경 차단", w.row("claude", "a")["error"])


@unittest.skipIf(textual is None, "textual not installed")
class BoardFromConfig(unittest.TestCase):
    def test_top_select_and_columns_follow_label_order(self):
        from warroom import tui
        w = World()
        cfg = cfg_with({"deepseek": DEEPSEEK, "codex": LUNA, "claude": SONNET})   # reversed on purpose
        w.paths.ensure()
        with mock.patch.object(tui, "load_config", return_value=cfg), \
                mock.patch.object(tui, "Paths", return_value=w.paths), \
                mock.patch.object(tui, "ensure_supervisor", return_value=None):
            app = tui.WarRoom()
        self.assertEqual(app.models, ["claude", "codex", "deepseek"])
        self.assertEqual([a for _, a in app._model_options("claude")], ["claude"])
        self.assertEqual([m for m in app._lines()], ["claude", "codex", "deepseek"])
        w.tmp.cleanup()


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
            self.assertTrue({"model", "effort"} <= cols)
            run = store.runs(1)[0]
            self.assertIsNone(run["model"])
            self.assertIsNone(run["effort"])

    def test_add_run_round_trips_the_pin(self):
        with tempfile.TemporaryDirectory() as d:
            store = Store(Path(d) / "warroom.db")
            bid = store.create_batch(method="a", producer="claude", shard="001", batch="01", branch="b",
                                     worktree="/w")
            store.add_run(bid, "produce", None, 1, "l.log", "l.exit", model="sonnet", effort="medium")
            run = store.runs(bid)[0]
            self.assertEqual((run["model"], run["effort"]), ("sonnet", "medium"))


class RelaunchPins(unittest.TestCase):
    """#1379 blocker 1: every relaunch is pinned to the last recorded run, not to the current config."""

    def fresh(self, effort="high", plan=None):
        w = World()
        w.cfg["producers"] = {"deepseek": {"adapter": "opencode", "effort": effort,
                                           "models": {"free": "p/free-x-free", "go": "p/go"}}}
        w.start("single", "deepseek", "a")
        if plan:
            w.adapter.plan.append(plan)                # the outcome of launch #1 must be queued before it runs
        w.tick()                                       # launch #1 at the recorded pin
        return w

    def batch(self, w):
        return w.store.batch(w.row("deepseek", "a")["id"])

    def test_a_changed_effort_stops_every_relaunch_kind_without_launching(self):
        for kind in ("produce_recover", "produce_resume", "fix_new", "fix_resume"):
            with self.subTest(kind=kind):
                w = self.fresh()
                launched = len(w.adapter.launches)
                w.cfg["producers"]["deepseek"]["effort"] = "low"     # operator changed the pin mid-batch
                w.sup._launch(self.batch(w), kind, [])
                self.assertEqual(len(w.adapter.launches), launched)
                self.assertEqual(w.row("deepseek", "a")["state"], "ERROR")
                self.assertIn("실행 설정 변경 차단", w.row("deepseek", "a")["error"])
                w.tmp.cleanup()

    def test_retry_after_a_lost_session_relaunches_on_the_same_pin(self):
        w = self.fresh(plan={"code": 1, "text": "something unrecognised"})   # no session id was ever captured
        w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        self.assertEqual(w.row("deepseek", "a")["state"], "PAUSED")
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.tick(); w.tick()                             # operator Retry -> produce_recover on the same pin
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertEqual((w.adapter.launches[-1]["model"], w.adapter.launches[-1]["effort"]), ("p/free-x-free", "high"))
        w.tmp.cleanup()

    def test_free_to_go_keeps_the_effort_and_relaunches(self):
        w = self.fresh()
        w.store.update(self.batch(w)["id"], model_tier="go")
        w.sup._launch(self.batch(w), "produce_recover", [])
        self.assertEqual((w.adapter.launches[-1]["model"], w.adapter.launches[-1]["effort"]), ("p/go", "high"))
        w.tmp.cleanup()

    def test_a_restarted_supervisor_re_proves_the_pin_before_relaunching(self):
        from warroom.adapters import OpenCodeAdapter
        w = self.fresh()
        launched = len(w.adapter.launches)
        w.adapter._opencode = OpenCodeAdapter("opencode", probe_async=False)   # restart: nothing is proven yet
        w.runner.variant_rejected = {"p/free-x-free#high"}                       # the CLI now refuses the variant
        w.sup._launch(self.batch(w), "produce_recover", [])
        self.assertEqual(len(w.adapter.launches), launched)
        self.assertEqual(w.row("deepseek", "a")["state"], "ERROR")
        self.assertIn("지원하지 않습니다", w.row("deepseek", "a")["error"])
        w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
