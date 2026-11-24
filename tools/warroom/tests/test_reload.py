"""Reload (`r`): the Supervisor re-reads config.json at runtime, fail-closed; each new run uses the loaded settings."""
import json
import unittest

from tests.fakes import HEAD1, World
from tests.test_issue_1684 import ready
from warroom import control
from warroom.config import RESTART_KEYS, load_config, reload_problem

LUNA = {"label": "Luna", "adapter": "codex", "model": "gpt-x", "effort": "high"}
SONNET = {"label": "Sonnet", "adapter": "claude", "model": "sonnet", "effort": "medium"}


def stage2_world():
    """A World whose only shard has its preserved Stage 2 inputs, so a Stage 2 Line can start a Part."""
    w = World()
    w.runner.set_batches(canon={1: 1000}, done={**ready("01", 500), **ready("02", 500)})
    return w


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
        self.w = stage2_world()
        write(self.w, {"codex": LUNA})
        self.assertTrue(reload(self.w)[0])

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_valid_and_invalid_inputs(self):
        cases = [  # name, raw config.json text, accepted, expected reason fragment
            ("add claude producer", json.dumps({"producers": {"codex": LUNA, "claude": SONNET}}), True, "claude"),
            ("same config again", json.dumps({"producers": {"codex": LUNA}}), True, "codex"),
            ("broken JSON", '{"producers": {', False, "읽을 수 없습니다"),
            ("top level is a list", "[]", False, "JSON 객체"),
            ("retired settings of any type are ignored",
             json.dumps({"producers": {"codex": LUNA}, "literary_index_path": [], "methods": "a"}), True, "codex"),
            ("producers is an empty list", '{"producers": []}', False, "producers"),
            ("producers empty object removes the in-use producer", '{"producers": {}}', False, "미완료"),
            ("producers wrong type", '{"producers": [1]}', False, "producers|설정 구조"),
            ("unset effort", json.dumps({"producers": {"codex": LUNA, "claude": {**SONNET, "effort": ""}}}), False, "effort"),
            ("unsupported effort", json.dumps({"producers": {"codex": LUNA, "claude": {**SONNET, "effort": "turbo"}}}), False, "turbo"),
            ("unset model", json.dumps({"producers": {"codex": LUNA, "claude": {**SONNET, "model": ""}}}), False, "model"),
            ("duplicate endpoint", json.dumps({"producers": {"codex": LUNA, "claude": SONNET, "c2": SONNET}}), False, "중복"),
            ("duplicate id by case", json.dumps({"producers": {"codex": LUNA, "Codex": LUNA}}), False, "중복|허용"),
            ("unknown adapter", json.dumps({"producers": {"codex": LUNA, "x": {**SONNET, "adapter": "nope"}}}), False, "adapter"),
            ("repo change needs restart", json.dumps({"producers": {"codex": LUNA}, "repo": "o/other"}), False, "repo"),
            ("claude_bin change needs restart", json.dumps({"producers": {"codex": LUNA}, "claude_bin": "/x/claude"}), False, "claude_bin"),
            ("in-use producer adapter swapped, same model+effort",
             json.dumps({"producers": {"codex": {**LUNA, "adapter": "claude", "model": "sonnet", "effort": "medium"}}}), False, "adapter를 바꿀"),
            ("in-use producer removed", json.dumps({"producers": {"claude": SONNET}}), False, "미완료"),
        ]
        self.w.start("single", "codex", "s2")   # codex owns an unfinished Part for the whole table
        self.w.tick()
        self.assertIsNotNone(self.w.store.active_batch("codex", "s2"))
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
                if ok:
                    self.w.paths.config_file.write_text(json.dumps({"producers": {"codex": LUNA}}), "utf-8")
                    reload(self.w)

    def test_reload_problem_is_pure_and_covers_restart_keys(self):
        base = load_config(self.w.paths)
        for key in RESTART_KEYS:
            with self.subTest(key):
                self.assertIn(key, reload_problem(base, {**base, key: "changed"}, set()))
        self.assertIsNone(reload_problem(base, {**base, "poll_seconds": 1}, {"codex"}))
        c = {**base, "producers": {"c": SONNET}}
        swapped = {**base, "producers": {"c": {**SONNET, "adapter": "codex", "effort": "high"}}}
        self.assertIn("adapter", reload_problem(c, swapped, {"c"}))
        self.assertIsNone(reload_problem(c, swapped, set()))   # idle producer: adapter may change

    def test_one_request_is_answered_once(self):
        self.w.tick(3)
        res = control.reload_result(self.w.store)
        self.assertTrue(res[1])
        self.assertEqual(self.w.store.get("reload_done"), self.w.store.get("reload_req"))


class ReloadUnblocksAndRuns(unittest.TestCase):
    def setUp(self):
        self.w = stage2_world()
        write(self.w, {"codex": LUNA})
        reload(self.w)

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_unregistered_model_block_is_cleared_and_the_line_starts_after_reload(self):
        self.w.store.line("claude", "s2")
        self.w.store.set_line("claude", "s2", run=1, mode="single")   # a reservation Start could not prove
        self.w.tick()
        self.assertIn("등록되지 않은 모델", self.w.store.line("claude", "s2")["blocked"])
        write(self.w, {"codex": LUNA, "claude": SONNET})
        ok, _ = reload(self.w)
        self.assertTrue(ok)
        self.assertEqual(self.w.store.line("claude", "s2")["blocked"], "")
        self.w.start("single", "claude", "s2")
        self.w.tick()
        self.assertIsNotNone(self.w.store.active_batch("claude", "s2"))
        self.assertEqual(self.w.adapter.launches[-1]["model"], "sonnet")

    def test_rejected_reload_keeps_the_block_and_the_old_config(self):
        self.w.store.set_line("claude", "s2", run=1, mode="single")   # a reservation Start could not prove
        self.w.tick()
        write(self.w, {"codex": LUNA, "claude": {**SONNET, "effort": ""}})
        self.assertFalse(reload(self.w)[0])
        self.assertIn("등록되지 않은 모델", self.w.store.line("claude", "s2")["blocked"])
        self.assertNotIn("claude", self.w.sup.cfg["producers"])

    def test_running_batch_uses_reloaded_model_and_effort_on_its_next_run(self):
        write(self.w, {"codex": LUNA, "claude": SONNET})
        reload(self.w)
        self.w.adapter.plan.append({"session": "session-before-reload"})
        self.w.start("single", "claude", "s2")
        self.w.tick(2)
        bid = self.w.store.active_batch("claude", "s2")["id"]
        write(self.w, {"codex": LUNA, "claude": {**SONNET, "model": "opus", "effort": "high"}})
        self.assertTrue(reload(self.w)[0])
        control.stop_line(self.w.store, "claude", "s2")
        self.w.tick()
        control.retry(self.w.store, "claude", "s2")
        self.w.tick(2)

        batch = self.w.store.active_batch("claude", "s2")
        self.assertEqual(batch["state"], "PRODUCING")
        self.assertEqual((self.w.adapter.launches[-1]["kind"], self.w.adapter.launches[-1]["model"],
                          self.w.adapter.launches[-1]["effort"], self.w.adapter.launches[-1]["session"]),
                         ("resume", "opus", "high", "session-before-reload"))
        runs = self.w.store.runs(bid)
        self.assertEqual((runs[0]["model"], runs[0]["effort"]), ("opus", "high"))
        self.assertEqual((runs[1]["model"], runs[1]["effort"]), ("sonnet", "medium"))

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
    ("base_branch", "", False), ("expected_account", None, False),
]


class RuntimeValueTypes(unittest.TestCase):
    """Every runtime consumer needs its value in the right type; a wrong one is refused before it replaces cfg."""

    def setUp(self):
        self.w = stage2_world()
        write(self.w, {"codex": LUNA, "claude": SONNET})
        self.assertTrue(reload(self.w)[0])

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_table(self):
        for key, value, ok in NUMERIC:
            with self.subTest(key=key, value=value):
                before = json.loads(json.dumps(self.w.sup.cfg))
                write(self.w, {"codex": LUNA, "claude": SONNET}, **{key: value})
                got, msg = reload(self.w)
                self.assertEqual(got, ok, msg)
                self.assertEqual(self.w.sup.cfg[key] == value, ok) if ok else self.assertEqual(self.w.sup.cfg, before)
                if ok:
                    write(self.w, {"codex": LUNA, "claude": SONNET})
                    reload(self.w)

    def test_nested_producer_entries(self):
        cases = [  # name, producers, accepted
            ("valid", {"codex": LUNA, "claude": SONNET}, True),
            ("model is a number", {"codex": LUNA, "claude": {**SONNET, "model": 5}}, False),
            ("effort is a number", {"codex": LUNA, "claude": {**SONNET, "effort": 3}}, False),
            ("label is a number", {"codex": LUNA, "claude": {**SONNET, "label": 1}}, False),
            ("adapter is a number", {"codex": LUNA, "claude": {**SONNET, "adapter": 1}}, False),
            ("entry is a string", {"codex": LUNA, "claude": "sonnet"}, False),
        ]
        for name, prods, ok in cases:
            with self.subTest(name):
                before = json.loads(json.dumps(self.w.sup.cfg))
                write(self.w, prods)
                got, msg = reload(self.w)
                self.assertEqual(got, ok, msg)
                if not ok:
                    self.assertEqual(self.w.sup.cfg, before)
                    from warroom.config import config_problem
                    self.assertIsNotNone(config_problem(load_config(self.w.paths)))   # Start refuses it too
                if ok:
                    write(self.w, {"codex": LUNA, "claude": SONNET})
                    reload(self.w)

    def test_consumers_keep_working_after_a_rejected_reload(self):
        # (a) WAITING_REVIEW keeps being watched; (c) a rate-limit failure keeps its bounded backoff
        self.w.start("single", "claude", "s2")
        self.w.tick()
        b = self.w.store.active_batch("claude", "s2")
        self.w.store.update(b["id"], state="WAITING_REVIEW", pid=None, pr_number=7, head_sha=HEAD1)
        self.w.pr_info(7, HEAD1)
        for key, value in [("poll_seconds", "300"), ("rate_limit_retries", "3"), ("rate_limit_backoff_seconds", None)]:
            write(self.w, {"codex": LUNA, "claude": SONNET}, **{key: value})
            self.assertFalse(reload(self.w)[0])
        self.w.tick(2)
        self.assertEqual(self.w.store.active_batch("claude", "s2")["state"], "WAITING_REVIEW")
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
