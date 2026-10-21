import unittest
from pathlib import Path

from tests.fakes import HEAD1, HEAD2, World
from warroom import control
from warroom.supervisor import Supervisor, acquire_lock

BRANCH = "a-deepseek-001-01"


def review(i, head, body="-1", user="genonfire"):
    return {"id": i, "user": {"login": user}, "body": f"{body}\nHEAD: {head}\nfix it",
            "commit_id": head, "submitted_at": "2026-10-21T10:00:00Z"}


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.w = World()

    def tearDown(self):
        self.w.tmp.cleanup()

    def produce_to_review(self, session="ses_1"):
        w = self.w
        control.start(w.store, "single")
        w.adapter.plan.append({"code": 0, "session": session, "effect": self.open_pr})
        w.tick()
        self.assertEqual(w.row()["state"], "PRODUCING")
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")

    def open_pr(self):
        self.w.pr_info(7, HEAD1)
        self.w.gh.by_branch[BRANCH] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]

    def test_full_cycle_with_fix_and_cleanup(self):
        w = self.w
        self.produce_to_review()
        b = w.row()
        self.assertEqual((b["pr_number"], b["head_sha"], b["session_id"]), (7, HEAD1, "ses_1"))
        self.assertEqual(w.git.created[0][1], BRANCH)
        # AI exited, yet nothing is "complete": review watch continues without a live AI.
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 1)

        # -1 on current HEAD -> exactly one resume of the same session in the same worktree.
        w.gh.reviews_ = [review(11, HEAD1)]
        def pushed():
            w.pr_info(7, HEAD2); w.git.local_head = HEAD2
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": pushed})
        w.tick()
        self.assertEqual(w.row()["state"], "FIXING")
        fix = w.adapter.launches[-1]
        self.assertEqual((fix["kind"], fix["session"], fix["cwd"]), ("resume", "ses_1", w.row()["worktree"]))
        self.assertIn("fix it", fix["prompt"])
        w.tick(2)  # still running: no duplicate launch
        self.assertEqual(len(w.adapter.launches), 2)
        w.adapter.finish(fix["pid"])
        w.tick()
        b = w.row()
        self.assertEqual((b["state"], b["head_sha"]), ("WAITING_REVIEW", HEAD2))
        # Review 11 targets the old HEAD: it must not retrigger on the new HEAD.
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 2)

        # merged=true (not +1/+2/closed) completes; cleanup removes owned worktree.
        w.gh.reviews_.append(review(12, HEAD2, "+1"))
        w.tick(2)
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")
        w.pr_info(7, HEAD2, state="closed", merged=True)
        w.tick(3)
        self.assertEqual(w.row()["state"], "COMPLETE")
        self.assertEqual(w.git.removed[0][1], BRANCH)
        self.assertEqual(w.store.get("run"), "0")  # single-batch mode stops here
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 2)

    def test_resume_failure_falls_back_to_new_session_once(self):
        w = self.w
        self.produce_to_review()
        w.gh.reviews_ = [review(11, HEAD1)]
        w.adapter.plan += [{"code": 1, "text": "session not found"}, {"code": 0}]
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual([l["kind"] for l in w.adapter.launches], ["start", "resume", "start"])
        self.assertIn("새 세션", w.adapter.launches[-1]["prompt"])
        self.assertIn("fix it", w.adapter.launches[-1]["prompt"])

    def test_unmerged_close_and_dirty_cleanup_preserve(self):
        w = self.w
        self.produce_to_review()
        w.pr_info(7, HEAD1, state="closed", merged=False)
        w.tick()
        self.assertEqual(w.row()["state"], "ERROR")
        self.assertEqual(w.git.removed, [])

    def test_dirty_worktree_blocks_cleanup(self):
        w = self.w
        self.produce_to_review()
        w.pr_info(7, HEAD1, state="closed", merged=True)
        w.git.dirty_text = " M data/x"
        w.tick(3)
        self.assertEqual(w.row()["state"], "ERROR")
        self.assertIn("보존", w.row()["error"])
        self.assertEqual(w.git.removed, [])
        self.assertTrue(Path(w.row()["worktree"]).exists())

    def test_restart_recovery_no_duplicates(self):
        w = self.w
        control.start(w.store, "single")
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": self.open_pr})
        w.tick()
        # Supervisor dies while the AI runs; a new one adopts the persisted batch.
        w.sup = w.make_sup(); w.sup_runner_ok()
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(len(w.git.created), 1)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.sup = w.make_sup(); w.sup_runner_ok()
        w.tick()
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")
        w.sup = w.make_sup(); w.sup_runner_ok()
        w.gh.reviews_ = [review(11, HEAD1)]
        w.adapter.plan.append({"code": 0})
        w.tick()
        w.sup = w.make_sup(); w.sup_runner_ok()
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 2)  # review 11 handled exactly once

    def test_lost_process_without_exit_status_is_not_reproduced(self):
        w = self.w
        control.start(w.store, "single")
        w.adapter.plan.append({"code": 0})
        w.tick()
        w.adapter.running.clear()  # vanished, no exit file
        w.tick()
        self.assertEqual(w.row()["state"], "ERROR")
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 1)

    def test_pr_missing_after_clean_exit_and_duplicate_pr(self):
        w = self.w
        control.start(w.store, "single")
        w.adapter.plan.append({"code": 0})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        self.assertEqual(w.row()["state"], "ERROR")  # no PR found
        w2 = World()
        control.start(w2.store, "single")
        w2.adapter.plan.append({"code": 0, "effect": lambda: (
            w2.pr_info(7, HEAD1),
            w2.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}),
            w2.gh.open.append({"number": 5, "headRefName": "other", "files": [{
                "path": "data/relation-candidates/001/001_01_a_deepseek.jsonl"}]}))})
        w2.tick(); w2.adapter.finish(w2.adapter.launches[-1]["pid"]); w2.tick()
        self.assertEqual(w2.row()["state"], "ERROR")
        self.assertIn("#5", w2.row()["error"])
        w2.tmp.cleanup()


class LiveAiHandover(unittest.TestCase):
    """Review 1: PR existence/HEAD watching must not depend on the AI having exited."""

    def test_pr_detected_while_ai_alive_then_ai_stopped_before_fix(self):
        w = World()
        control.start(w.store, "single")
        w.adapter.plan.append({"code": 0, "session": "ses_1"})
        w.tick()
        pid = w.adapter.launches[-1]["pid"]
        self.assertEqual(w.row()["state"], "PRODUCING")
        w.pr_info(7, HEAD1)  # AI created the PR but keeps running (waiting for merge)
        w.gh.by_branch[BRANCH] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
        w.tick()
        b = w.row()
        self.assertEqual((b["state"], b["pr_number"], b["pid"]), ("WAITING_REVIEW", 7, pid))
        self.assertTrue(w.adapter.alive(pid))
        # -1 arrives: the live AI is stopped first; no second AI starts while it is alive.
        w.gh.reviews_ = [review(11, HEAD1)]
        stops = []
        orig_stop = w.adapter.stop
        w.adapter.stop = lambda p: (stops.append(p), None)[1]  # AI ignores the first SIGTERM
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")
        self.assertTrue(stops)
        w.adapter.stop = orig_stop
        w.tick()                     # stop now takes effect
        self.assertEqual(len(w.adapter.launches), 1)
        w.adapter.plan.append({"code": 0})
        w.tick(2)                    # exit confirmed -> exactly one fix run, same session
        self.assertEqual([l["kind"] for l in w.adapter.launches], ["start", "resume"])
        self.assertEqual(w.row()["state"], "FIXING")
        w.tmp.cleanup()

    def test_merge_while_ai_alive_stops_ai_before_cleanup(self):
        w = World()
        control.start(w.store, "single")
        w.adapter.plan.append({"code": 0})
        w.tick()
        w.pr_info(7, HEAD1)
        w.gh.by_branch[BRANCH] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
        w.tick()
        w.pr_info(7, HEAD1, state="closed", merged=True)
        w.tick(5)
        self.assertEqual(w.row()["state"], "COMPLETE")
        self.assertFalse(w.adapter.running)
        w.tmp.cleanup()


class ReviewReversal(unittest.TestCase):
    """Review 3: a same-HEAD -1 that was later retracted by +1/+2 is not a blocker."""

    def test_retracted_minus_one_never_triggers_even_after_restart(self):
        w = World()
        control.start(w.store, "single")
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": lambda: (
            w.pr_info(7, HEAD1),
            w.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        m1 = review(11, HEAD1); m1["submitted_at"] = "2026-10-21T10:00:00Z"
        p1 = review(12, HEAD1, "+1"); p1["submitted_at"] = "2026-10-21T10:05:00Z"
        w.gh.reviews_ = [m1, p1]
        w.sup = w.make_sup(); w.sup_runner_ok()  # first poll happens after a restart
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 1)
        # A later -1 on the same HEAD is effective again and is the only event sent.
        m2 = review(13, HEAD1); m2["submitted_at"] = "2026-10-21T10:10:00Z"; m2["body"] = "-1\nHEAD: " + HEAD1 + "\nnew problem"
        w.gh.reviews_.append(m2)
        w.adapter.plan.append({"code": 0})
        w.tick()
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertIn("new problem", w.adapter.launches[-1]["prompt"])
        self.assertNotIn("review:11", w.adapter.launches[-1]["prompt"])
        w.tmp.cleanup()


class ModelPolicy(unittest.TestCase):
    def test_fail_closed_without_verified_free_model(self):
        for name, models, mutate, expect in [
            ("unset free", {"free": "", "go": "p/go"}, None, "models.free"),
            ("not free-looking", {"free": "p/paid", "go": ""}, None, "무료 모델"),
            ("unknown to opencode", {"free": "p/other-free", "go": ""}, None, "지원하지 않는"),
            ("unknown go", {"free": "p/free-x-free", "go": "p/nope"}, None, "p/nope"),
            ("opencode models fails", None, lambda r: setattr(r, "models_ok", False), "models"),
        ]:
            with self.subTest(name):
                w = World(models)
                if mutate:
                    mutate(w.runner)
                control.start(w.store, "single")
                w.tick()
                self.assertIsNone(w.store.active_batch())
                self.assertEqual(w.adapter.launches, [])
                self.assertIn(expect, w.store.get("blocked"))
                w.tmp.cleanup()


    def run_failure(self, text, models=None, retries=0):
        w = World(models)
        control.start(w.store, "single")
        w.adapter.plan.append({"code": 1, "text": text})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        return w

    def test_table(self):
        cases = [  # text, models, state, tier, launches
            ("FreeUsageLimitError reached", None, "PRODUCING", "go", 2),
            ("FreeUsageLimitError reached", {"free": "p/free-x-free", "go": ""}, "PAUSED", "free", 1),
            ("HTTP 429 Too Many Requests", None, "PRODUCING", "free", 1),   # backoff, not Go
            ("401 unauthorized", None, "PAUSED", "free", 1),
            ("weird provider blob", None, "PAUSED", "free", 1),             # never silently paid
        ]
        for text, models, state, tier, n in cases:
            with self.subTest(text, models=models):
                w = self.run_failure(text, models)
                self.assertEqual((w.row()["state"], w.row()["model_tier"], len(w.adapter.launches)),
                                 (state, tier, n))
                if tier == "go":
                    self.assertEqual(w.adapter.launches[-1]["model"], "p/go")
                w.tmp.cleanup()

    def test_rate_limit_backoff_then_retry_same_batch(self):
        w = self.run_failure("429 Too Many Requests")
        self.assertEqual(len(w.adapter.launches), 1)
        w.tick()
        self.assertEqual(len(w.adapter.launches), 1)  # waiting
        w.now += 11
        w.adapter.plan.append({"code": 0})
        w.tick()
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertEqual(len(w.git.created), 1)  # same worktree / batch
        w.tmp.cleanup()


class Operations(unittest.TestCase):
    def test_blocked_on_wrong_account(self):
        w = World()
        w.runner.account = "genonfire"
        control.start(w.store, "single")
        w.tick()
        self.assertIsNone(w.store.active_batch())
        self.assertEqual(w.adapter.launches, [])
        self.assertIn("계정 불일치", w.store.get("blocked"))
        w.tmp.cleanup()

    def test_continuous_starts_next_batch_fresh_after_cleanup(self):
        w = World()
        control.start(w.store, "continuous")
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": lambda: (
            w.pr_info(7, HEAD1),
            w.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        w.pr_info(7, HEAD1, state="closed", merged=True)
        w.tick(3)
        self.assertEqual(w.store.all_batches()[0]["state"], "COMPLETE")
        w.adapter.plan.append({"code": 0})
        w.tick()  # next batch: 001_02, new worktree, brand-new session
        b = w.row()
        self.assertEqual((b["shard"], b["batch"], b["session_id"]), ("001", "02", None))
        self.assertNotEqual(b["worktree"], w.store.all_batches()[0]["worktree"])
        self.assertEqual(w.adapter.launches[-1]["kind"], "start")
        self.assertNotIn("session", w.adapter.launches[-1])
        w.tmp.cleanup()

    def test_stop_after_current_prevents_next_batch(self):
        w = World()
        control.start(w.store, "continuous")
        control.stop_after_current(w.store)
        w.adapter.plan.append({"code": 0, "effect": lambda: (
            w.pr_info(7, HEAD1),
            w.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        w.pr_info(7, HEAD1, state="closed", merged=True)
        w.tick(6)
        self.assertEqual(len(w.store.all_batches()), 1)
        w.tmp.cleanup()

    def test_force_stop_preserves_and_retry_resumes(self):
        w = World()
        control.start(w.store, "single")
        w.adapter.plan.append({"code": 0})
        w.tick()
        control.force_stop(w.store)
        w.tick()
        self.assertEqual(w.row()["state"], "PAUSED")
        self.assertTrue(Path(w.row()["worktree"]).exists())
        control.retry(w.store)
        w.adapter.plan.append({"code": 0})
        w.tick(2)
        self.assertEqual(w.row()["state"], "PRODUCING")
        self.assertEqual(len(w.git.created), 1)
        w.tmp.cleanup()

    def test_progress_only_when_recorded(self):
        w = World()
        control.start(w.store, "single")
        w.adapter.plan.append({"code": 0})
        w.tick()
        self.assertNotIn("progress", control.status(w.store))
        f = Path(w.row()["worktree"]) / "data/relation-candidates/001/001_01_a_deepseek.jsonl"
        f.parent.mkdir(parents=True); f.write_text("{}\n" * 120)
        w.tick()
        self.assertEqual(control.status(w.store)["progress"], "120/500")
        w.tmp.cleanup()

    def test_single_instance_lock(self):
        w = World()
        a = acquire_lock(w.paths.lock)
        self.assertIsNotNone(a)
        self.assertIsNone(acquire_lock(w.paths.lock))
        a.close()
        b = acquire_lock(w.paths.lock)
        self.assertIsNotNone(b)
        b.close()
        w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
