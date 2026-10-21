"""Reload (`r`): the Supervisor re-reads config.json at runtime, fail-closed, without touching run pins.

Invariant: the running config is replaced only by a config that passes every start-time check; a rejected
reload leaves the old config, and an unfinished batch keeps relaunching on its recorded model + effort.
"""
import json
import unittest

from tests.fakes import World
from warroom import control
from warroom.config import RESTART_KEYS, load_config, reload_problem

DS = {"label": "DeepSeek", "adapter": "opencode", "effort": "high",
      "models": {"free": "p/free-x-free", "go": "p/go"}}
SONNET = {"label": "Sonnet", "adapter": "claude", "model": "sonnet", "effort": "medium"}


def write(w, producers, **extra):
    w.paths.config_file.write_text(json.dumps({"producers": producers, **extra}), "utf-8")


def reload(w):
    token = control.request_reload(w.store)
    w.tick()
    res = control.reload_result(w.store)
    assert res and res[0] == token
    return res[1], res[2]


class ReloadTable(unittest.TestCase):
    def setUp(self):
        self.w = World()
        write(self.w, {"deepseek": DS})
        self.assertTrue(reload(self.w)[0])

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_valid_and_invalid_inputs(self):
        cases = [  # name, raw config.json text, accepted, expected reason fragment
            ("add claude producer", json.dumps({"producers": {"deepseek": DS, "claude": SONNET}}), True, "claude"),
            ("same config again", json.dumps({"producers": {"deepseek": DS}}), True, "deepseek"),
            ("broken JSON", '{"producers": {', False, "읽을 수 없습니다"),
            ("top level is a list", "[]", False, "JSON 객체"),
            ("producers is an empty list", '{"producers": []}', False, "producers"),
            ("producers empty object is the legacy single entry", '{"producers": {}}', True, "deepseek"),
            ("producers wrong type", '{"producers": [1]}', False, "producers|설정 구조"),
            ("unset effort", json.dumps({"producers": {"deepseek": DS, "claude": {**SONNET, "effort": ""}}}), False, "effort"),
            ("unsupported effort", json.dumps({"producers": {"deepseek": DS, "claude": {**SONNET, "effort": "turbo"}}}), False, "turbo"),
            ("unset model", json.dumps({"producers": {"deepseek": DS, "claude": {**SONNET, "model": ""}}}), False, "model"),
            ("duplicate endpoint", json.dumps({"producers": {"deepseek": DS, "claude": SONNET, "c2": SONNET}}), False, "중복"),
            ("duplicate id by case", json.dumps({"producers": {"deepseek": DS, "DeepSeek": DS}}), False, "중복|허용"),
            ("unknown adapter", json.dumps({"producers": {"deepseek": DS, "x": {**SONNET, "adapter": "nope"}}}), False, "adapter"),
            ("repo change needs restart", json.dumps({"producers": {"deepseek": DS}, "repo": "o/other"}), False, "repo"),
            ("claude_bin change needs restart", json.dumps({"producers": {"deepseek": DS}, "claude_bin": "/x/claude"}), False, "claude_bin"),
            ("in-use producer adapter swapped, same model+effort",
             json.dumps({"producers": {"deepseek": {**DS, "adapter": "claude", "model": "sonnet", "effort": "medium"}}}), False, "adapter를 바꿀"),
            ("in-use producer removed", json.dumps({"producers": {"claude": SONNET}}), False, "미완료"),
        ]
        self.w.start("single", "deepseek")   # deepseek owns an unfinished batch for the whole table
        self.w.tick()
        self.assertIsNotNone(self.w.store.active_batch("deepseek", "a"))
        import re
        for name, raw, ok, frag in cases:
            with self.subTest(name):
                before = json.loads(json.dumps(self.w.sup.cfg))
                self.w.paths.config_file.write_text(raw, "utf-8")
                got, msg = reload(self.w)
                self.assertEqual(got, ok, msg)
                self.assertTrue(re.search(frag, msg), msg)
                if ok:
                    self.assertEqual(self.w.sup.cfg, load_config(self.w.paths))
                else:   # fail-closed: the old config stays, and the reason is in the event log
                    self.assertEqual(self.w.sup.cfg, before)
                    self.assertIn("리로드 거부", self.w.store.recent_events(limit=1)[0]["msg"])
                self.w.paths.config_file.write_text(json.dumps({"producers": {"deepseek": DS}}), "utf-8")
                reload(self.w)

    def test_reload_problem_is_pure_and_covers_restart_keys(self):
        base = load_config(self.w.paths)
        for key in RESTART_KEYS:
            with self.subTest(key):
                self.assertIn(key, reload_problem(base, {**base, key: "changed"}, set()))
        self.assertIsNone(reload_problem(base, {**base, "poll_seconds": 1}, {"deepseek"}))
        c = {**base, "producers": {"c": SONNET}}
        swapped = {**base, "producers": {"c": {**SONNET, "adapter": "codex", "effort": "high"}}}
        self.assertIn("adapter", reload_problem(c, swapped, {"c"}))
        self.assertIsNone(reload_problem(c, swapped, set()))   # idle producer: adapter may change

    def test_one_request_is_answered_once(self):
        self.w.tick(3)
        res = control.reload_result(self.w.store)
        self.assertTrue(res[1])
        self.assertEqual(self.w.store.get("reload_done"), self.w.store.get("reload_req"))


class ReloadUnblocksAndPins(unittest.TestCase):
    def setUp(self):
        self.w = World()
        write(self.w, {"deepseek": DS})
        reload(self.w)

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_unregistered_model_block_is_cleared_and_the_line_starts_after_reload(self):
        self.w.store.line("claude", "a")
        control.start(self.w.store, "claude", "a", "single")
        self.w.tick()
        self.assertIn("등록되지 않은 모델", self.w.store.line("claude", "a")["blocked"])
        write(self.w, {"deepseek": DS, "claude": SONNET})
        ok, _ = reload(self.w)
        self.assertTrue(ok)
        self.assertEqual(self.w.store.line("claude", "a")["blocked"], "")
        self.w.start("single", "claude")
        self.w.tick()
        self.assertIsNotNone(self.w.store.active_batch("claude", "a"))
        self.assertEqual(self.w.adapter.launches[-1]["model"], "sonnet")

    def test_rejected_reload_keeps_the_block_and_the_old_config(self):
        control.start(self.w.store, "claude", "a", "single")
        self.w.tick()
        write(self.w, {"deepseek": DS, "claude": {**SONNET, "effort": ""}})
        self.assertFalse(reload(self.w)[0])
        self.assertIn("등록되지 않은 모델", self.w.store.line("claude", "a")["blocked"])
        self.assertNotIn("claude", self.w.sup.cfg["producers"])

    def test_running_batch_pin_is_not_bypassed_by_reload(self):
        write(self.w, {"deepseek": DS, "claude": SONNET})
        reload(self.w)
        self.w.start("single", "claude")
        self.w.tick()
        self.assertEqual(self.w.adapter.launches[-1]["effort"], "medium")
        for name, changed, want_error in [
            ("effort changed", {**SONNET, "effort": "high"}, True),
            ("model changed", {**SONNET, "model": "opus"}, True),
            ("label only", {**SONNET, "label": "Renamed"}, False),
            ("restored", SONNET, False),
        ]:
            with self.subTest(name):
                write(self.w, {"deepseek": DS, "claude": changed})
                self.assertTrue(reload(self.w)[0])
                control.stop_line(self.w.store, "claude", "a")
                self.w.tick()
                b = self.w.store.active_batch("claude", "a")
                self.assertEqual(b["state"], "PAUSED")
                control.retry(self.w.store, "claude", "a")
                self.w.tick(2)
                b = self.w.store.active_batch("claude", "a")
                if want_error:
                    self.assertEqual(b["state"], "ERROR", name)
                    self.assertIn("실행 설정 변경 차단", b["error"])
                    self.assertIn("리로드", b["error"])
                    write(self.w, {"deepseek": DS, "claude": SONNET})   # restore through reload, then Retry
                    reload(self.w)
                    control.retry(self.w.store, "claude", "a")
                    self.w.tick(2)
                    b = self.w.store.active_batch("claude", "a")
                self.assertEqual(b["state"], "PRODUCING", name)
                self.assertEqual((self.w.adapter.launches[-1]["model"], self.w.adapter.launches[-1]["effort"]),
                                 ("sonnet", "medium"))

NUMERIC = [  # key, value, accepted
    ("poll_seconds", 0, True), ("poll_seconds", 300, True), ("poll_seconds", 2.5, True),
    ("poll_seconds", "300", False), ("poll_seconds", None, False), ("poll_seconds", -1, False),
    ("poll_seconds", True, False), ("poll_seconds", [1], False),
    ("rate_limit_retries", 0, True), ("rate_limit_retries", 3, True), ("rate_limit_retries", "3", False),
    ("rate_limit_retries", 2.5, False), ("rate_limit_retries", -1, False), ("rate_limit_retries", True, False),
    ("rate_limit_retries", None, False),
    ("rate_limit_backoff_seconds", 0, True), ("rate_limit_backoff_seconds", 120, True),
    ("rate_limit_backoff_seconds", "120", False), ("rate_limit_backoff_seconds", None, False),
    ("rate_limit_backoff_seconds", -5, False),
    ("quota_patterns", ["x"], True), ("quota_patterns", "x", False), ("quota_patterns", ["("], False),
    ("quota_patterns", [1], False),
    ("trusted_reviewers", ["genonfire"], True), ("trusted_reviewers", "genonfire", False),
    ("free_model_pattern", "-free$", True), ("free_model_pattern", "(", False), ("free_model_pattern", 1, False),
    ("methods", ["a", "b"], True), ("methods", [], False), ("methods", "a", False), ("methods", [1], False),
    ("base_branch", "", False), ("expected_account", None, False), ("models", "x", False),
]


class RuntimeValueTypes(unittest.TestCase):
    """Every runtime consumer needs its value in the right type; a wrong one is refused before it replaces cfg."""

    def setUp(self):
        self.w = World()
        write(self.w, {"deepseek": DS, "claude": SONNET})
        self.assertTrue(reload(self.w)[0])

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_table(self):
        for key, value, ok in NUMERIC:
            with self.subTest(key=key, value=value):
                before = json.loads(json.dumps(self.w.sup.cfg))
                write(self.w, {"deepseek": DS, "claude": SONNET}, **{key: value})
                got, msg = reload(self.w)
                self.assertEqual(got, ok, msg)
                self.assertEqual(self.w.sup.cfg[key] == value, ok) if ok else self.assertEqual(self.w.sup.cfg, before)
                write(self.w, {"deepseek": DS, "claude": SONNET})
                reload(self.w)

    def test_consumers_keep_working_after_a_rejected_reload(self):
        # (a) WAITING_REVIEW keeps being watched; (c) a rate-limit failure keeps its bounded backoff
        self.w.start("single", "claude")
        self.w.tick()
        b = self.w.store.active_batch("claude", "a")
        self.w.store.update(b["id"], state="WAITING_REVIEW", pid=None, pr_number=7, head_sha="h")
        self.w.pr_info(7, "h")
        for key, value in [("poll_seconds", "300"), ("rate_limit_retries", "3"), ("rate_limit_backoff_seconds", None)]:
            write(self.w, {"deepseek": DS, "claude": SONNET}, **{key: value})
            self.assertFalse(reload(self.w)[0])
        self.w.tick(2)
        self.assertEqual(self.w.store.active_batch("claude", "a")["state"], "WAITING_REVIEW")
        self.assertFalse(any(e["level"] == "error" and "예외" in e["msg"] for e in self.w.store.recent_events(50)))
        self.assertEqual(self.w.sup.cfg["rate_limit_retries"], 3)

    def test_start_applies_the_same_check(self):
        from warroom.config import config_problem
        for key, value, ok in NUMERIC:
            with self.subTest(key=key, value=value):
                cfg = {**load_config(self.w.paths), key: value}
                self.assertEqual(config_problem(cfg) is None, ok)


if __name__ == "__main__":
    unittest.main()
