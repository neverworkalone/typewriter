"""Manual operator Free/Go choice is persisted and never swaps a running model."""
import unittest

from tests.fakes import World
from warroom import control


class ManualTierSwitchTests(unittest.TestCase):
    def setUp(self):
        self.w = World()

    def tearDown(self):
        self.w.tmp.cleanup()

    def switch(self, target, method="a"):
        return control.set_model_tier(self.w.store, self.w.cfg, "deepseek", method, target)

    def test_idle_switch_sets_next_batch_and_survives_reopen(self):
        w = self.w
        ok, msg = self.switch("go")
        self.assertTrue(ok, msg)
        self.assertEqual(w.store.peek_line("deepseek", "a")["model_tier"], "go")
        w.start()
        w.tick()
        self.assertEqual(w.adapter.launches[-1]["model"], "p/go")
        self.assertEqual(w.row()["model_tier"], "go")

    def test_paused_batch_can_resume_with_same_session_using_go(self):
        w = self.w
        w.start()
        w.adapter.plan.append({"code": 1, "session": "ses_manual", "text": "unclassified failure"})
        w.tick()
        run = w.adapter.launches[-1]
        self.assertEqual(run["model"], "p/free-x-free")
        w.adapter.finish(run["pid"])
        w.tick()
        self.assertEqual(w.row()["state"], "PAUSED")
        self.assertEqual(w.row()["pid"], None)
        self.assertTrue(self.switch("go")[0])
        self.assertEqual(w.row()["model_tier"], "go")
        self.assertEqual(w.store.peek_line("deepseek", "a")["model_tier"], "go")
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.tick()  # PAUSED -> previous production state
        w.tick()  # start resumed model, no new worktree or PR
        resumed = w.adapter.launches[-1]
        self.assertEqual(resumed["model"], "p/go")
        self.assertEqual(resumed["kind"], "resume")
        self.assertEqual(resumed["session"], "ses_manual")
        self.assertEqual(len(w.git.created), 1)

    def test_paused_switch_back_to_free_for_next_day(self):
        w = self.w
        w.start()
        w.adapter.plan.append({"code": 1, "text": "unclassified failure"})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.row()["state"], "PAUSED")
        self.assertTrue(self.switch("go")[0])
        self.assertTrue(self.switch("free")[0])
        self.assertEqual(w.row()["model_tier"], "free")
        self.assertEqual(w.store.peek_line("deepseek", "a")["model_tier"], "free")
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.tick()
        w.tick()
        self.assertEqual(w.adapter.launches[-1]["model"], "p/free-x-free")

    def test_running_batch_rejects_switch_and_preserves_tier(self):
        w = self.w
        w.start()
        w.tick()
        ok, _ = self.switch("go")
        self.assertFalse(ok)
        self.assertEqual(w.row()["model_tier"], "free")
        self.assertEqual(w.store.peek_line("deepseek", "a")["model_tier"], "free")

    def test_paid_model_must_be_configured(self):
        self.w.cfg["models"]["go"] = ""
        ok, message = self.switch("go")
        self.assertFalse(ok)
        self.assertIn("config.json", message)
        self.assertEqual(self.w.store.peek_line("deepseek", "a")["model_tier"], "free")

    def test_pending_start_and_retry_cannot_be_raced(self):
        w = self.w
        w.start()
        self.assertFalse(self.switch("go")[0])  # pending new batch
        w.tick()
        w.adapter.plan.append({"code": 1, "text": "unclassified failure"})
        # An active process remains guarded regardless of next retry request.
        self.assertFalse(self.switch("go")[0])

    def test_changes_do_not_leak_to_another_method(self):
        self.assertTrue(self.switch("go", "a")[0])
        self.assertEqual(self.w.store.peek_line("deepseek", "b")["model_tier"], "free")


if __name__ == "__main__":
    unittest.main()
