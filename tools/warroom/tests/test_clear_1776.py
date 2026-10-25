"""#1776 Batch Detail Clear: the Supervisor abandons exactly one pinned unfinished batch and leaves the Line IDLE.

Invariant: nothing is deleted before the AI is gone and ownership of worktree, PR(s) and remote branch is proven;
merged work is never abandoned; a blocked/interrupted Clear resumes teardown and never relaunches production.
"""
import unittest
from pathlib import Path

from tests.fakes import HEAD1, HEAD2, World
from warroom import control

BRANCH = "a-deepseek-001-01"
CAND = {"path": "data/relation-candidates/001/001_01_a_deepseek.jsonl"}


class ClearBase(unittest.TestCase):
    def setUp(self):
        self.w = World()

    def tearDown(self):
        self.w.tmp.cleanup()

    def producing(self):
        w = self.w
        w.start("single")
        w.adapter.plan.append({"code": 0})
        w.tick()
        b = w.row()
        self.assertEqual(b["state"], "PRODUCING")
        return b

    def with_pr(self, n=7, head=HEAD1, **kw):
        w = self.w
        w.pr_info(n, head, head_ref=kw.pop("head_ref", BRANCH), **kw)
        w.gh.by_branch[BRANCH] = [{"number": n, "state": "OPEN", "headRefOid": head}]
        w.gh.files[n] = [CAND]
        w.git.remote[BRANCH] = head
        w.git.local_head = head

    def clear(self, b):
        ok, msg = control.request_clear(self.w.store, "deepseek", "a", b["id"])
        self.assertTrue(ok, msg)

    def removed(self):
        return not Path(self.w.row()["worktree"]).exists() if self.w.store.active_batch("deepseek", "a") else True

    def assert_idle_and_reusable(self):
        w = self.w
        self.assertIsNone(w.store.active_batch("deepseek", "a"))
        self.assertIsNone(w.store.latest_batch("deepseek", "a"))
        self.assertEqual(w.store.claimed_keys("a", "deepseek"), set())
        st = control.line_status(w.store, "deepseek", "a")
        self.assertEqual((st["state"], st["run"], st["occupied"]), ("IDLE", False, False))
        self.assertIsNone(w.store.clear_request("deepseek", "a"))


class ClearTeardown(ClearBase):
    def test_active_producer_is_stopped_first_then_everything_owned_is_removed(self):
        w = self.w
        b = self.producing()
        pid, wt = b["pid"], Path(b["worktree"])
        w.store.set(f"last_poll_{b['id']}", "1")
        self.clear(b)
        launches = len(w.adapter.launches)
        w.sup.tick()
        self.assertNotIn(pid, w.adapter.running)                    # stop requested...
        self.assertTrue(wt.exists())                                 # ...but the worktree is untouched until exit is confirmed
        w.tick(2)
        self.assert_idle_and_reusable()
        self.assertFalse(wt.exists())
        self.assertEqual(w.git.discarded, [(str(wt), BRANCH)])
        self.assertEqual(len(w.adapter.launches), launches)          # production was never relaunched
        self.assertIsNone(w.store.get(f"last_poll_{b['id']}"))
        audit = [e["msg"] for e in w.store.line_events("deepseek", "a")]
        self.assertTrue(any(m.startswith("Clear 완료") and "001_01" in m for m in audit), audit)

    def test_states_and_worktree_dirtiness_table(self):
        for state in ("PAUSED", "ERROR", "WAITING_REVIEW", "FIXING"):
            for dirty in ("", " M data/x\n?? y.txt\n"):
                with self.subTest(state=state, dirty=bool(dirty)):
                    self.tearDown()
                    self.setUp()
                    b = self.producing()
                    w = self.w
                    w.adapter.running.clear()
                    w.store.update(b["id"], state=state, pid=None)
                    w.git.dirty_text = dirty
                    self.clear(b)
                    w.tick(2)
                    self.assert_idle_and_reusable()
                    self.assertEqual(w.git.discarded[-1][1], BRANCH)

    def test_open_owned_pr_is_closed_unmerged_and_remote_branch_removed(self):
        w = self.w
        b = self.producing()
        w.adapter.running.clear()
        self.with_pr()
        w.store.update(b["id"], state="WAITING_REVIEW", pid=None, pr_number=7, head_sha=HEAD1)
        self.clear(b)
        w.tick(2)
        self.assert_idle_and_reusable()
        self.assertEqual(w.gh.closed, [7])
        self.assertEqual(w.git.remote_deleted, [BRANCH])
        self.assertTrue(any("PR #7 머지 없이 닫음" in e["msg"] for e in w.store.line_events("deepseek", "a")))

    def test_unattached_open_pr_on_owned_branch_is_found(self):
        w = self.w
        b = self.producing()
        w.adapter.running.clear()
        self.with_pr()                                               # the batch record has no pr_number
        w.store.update(b["id"], state="ERROR", pid=None)
        self.clear(b)
        w.tick(2)
        self.assert_idle_and_reusable()
        self.assertEqual(w.gh.closed, [7])

    def test_closed_unmerged_pr_is_left_alone(self):
        w = self.w
        b = self.producing()
        w.adapter.running.clear()
        self.with_pr(state="closed")
        w.store.update(b["id"], state="ERROR", pid=None, pr_number=7)
        self.clear(b)
        w.tick(2)
        self.assert_idle_and_reusable()
        self.assertEqual(w.gh.closed, [])
        self.assertEqual(w.git.remote_deleted, [BRANCH])

    def test_merged_pr_is_never_abandoned(self):
        w = self.w
        b = self.producing()
        w.adapter.running.clear()
        self.with_pr(state="closed", merged=True)
        w.store.update(b["id"], state="ERROR", pid=None, pr_number=7)
        self.clear(b)
        w.tick()
        row = w.store.batch(b["id"])
        self.assertEqual((row["state"], row["merged"]), ("MERGED", 1))
        self.assertEqual(w.git.discarded, [])
        self.assertEqual(w.git.remote_deleted, [])
        self.assertEqual(w.gh.closed, [])
        self.assertIsNone(w.store.clear_request("deepseek", "a"))

    def test_merged_between_inspection_and_close_is_reconciled(self):
        w = self.w
        b = self.producing()
        w.adapter.running.clear()
        self.with_pr()
        w.store.update(b["id"], state="WAITING_REVIEW", pid=None, pr_number=7)
        orig = w.gh.close_pr
        w.gh.close_pr = lambda n: w.gh.prs.__setitem__(n, w.gh.prs[n] | {"state": "closed", "merged": True})
        self.clear(b)
        w.tick()
        self.assertEqual(w.store.batch(b["id"])["state"], "MERGED")
        self.assertEqual(w.git.discarded, [])
        w.gh.close_pr = orig


class ClearFailClosed(ClearBase):
    def blocked_case(self, mutate):
        w = self.w
        b = self.producing()
        w.adapter.running.clear()
        self.with_pr()
        w.store.update(b["id"], state="WAITING_REVIEW", pid=None, pr_number=7, head_sha=HEAD1)
        mutate(b)
        self.clear(b)
        w.tick(2)
        req = w.store.clear_request("deepseek", "a")
        self.assertEqual(req["status"], "BLOCKED", req["error"])
        self.assertEqual(w.store.batch(b["id"])["state"], "CLEARING")   # still pinned: nothing can relaunch
        self.assertEqual(w.git.discarded, [])
        self.assertEqual(w.git.remote_deleted, [])
        return b

    def test_unsafe_conditions_block_and_preserve(self):
        cases = {
            "pr for other candidate file": lambda b: self.w.gh.files.__setitem__(7, [{"path": "data/relation-candidates/002/002_01_a_deepseek.jsonl"}]),
            "pr with extra candidate file": lambda b: self.w.gh.files.__setitem__(7, [CAND, {"path": "data/relation-candidates/001/001_02_a_deepseek.jsonl"}]),
            "pr head branch mismatch": lambda b: self.w.pr_info(7, HEAD1, head_ref="other"),
            "remote branch moved": lambda b: self.w.git.remote.__setitem__(BRANCH, HEAD2),
            "remote lookup fails": lambda b: self.w.git.remote.__setitem__(BRANCH, RuntimeError("net")),
            "worktree registered to other branch": lambda b: self.w.git.reg.__setitem__(b["worktree"], "other"),
            "pr list fails": lambda b: self.w.gh.branch_errors.__setitem__(BRANCH, RuntimeError("gh down")),
            "close fails": lambda b: setattr(self.w.gh, "close_error", RuntimeError("403")),
            "remote delete fails": lambda b: setattr(self.w.git, "push_error", "rejected"),
            "stacked pr depends on branch": lambda b: self.w.gh.open.append({"number": 9, "headRefName": "z", "baseRefName": BRANCH, "files": []}),
        }
        for name, mutate in cases.items():
            with self.subTest(name):
                self.tearDown()
                self.setUp()
                self.blocked_case(mutate)

    def test_foreign_worktree_path_or_branch_name_is_refused(self):
        for field, value in (("branch", "master"), ("worktree", "/somewhere/else")):
            with self.subTest(field):
                self.tearDown()
                self.setUp()
                b = self.producing()
                self.w.adapter.running.clear()
                self.w.store.update(b["id"], **{field: value}, state="ERROR", pid=None)
                self.clear(b)
                self.w.tick(2)
                self.assertEqual(self.w.store.clear_request("deepseek", "a")["status"], "BLOCKED")
                self.assertEqual(self.w.git.discarded, [])

    def test_blocked_clear_resumes_without_relaunch_after_restart(self):
        w = self.w
        b = self.blocked_case(lambda b: setattr(w.gh, "close_error", RuntimeError("503")))
        launches = len(w.adapter.launches)
        w.tick(3)                                                    # BLOCKED waits for the operator: no auto relaunch/retry
        self.assertEqual(w.store.batch(b["id"])["state"], "CLEARING")
        self.assertEqual(len(w.adapter.launches), launches)
        w.gh.close_error = None
        w.sup = w.make_sup()                                         # Supervisor restart
        control.stop_line(w.store, "deepseek", "a")                  # Stop/Retry/Start cannot undo the pin
        self.assertFalse(control.retry(w.store, "deepseek", "a"))
        self.assertFalse(control.start(w.store, "deepseek", "a", "single")[0])
        ok, _ = control.request_clear(w.store, "deepseek", "a", b["id"])   # explicit re-arm
        self.assertTrue(ok)
        w.tick(2)
        self.assert_idle_and_reusable()
        self.assertEqual(len(w.adapter.launches), launches)

    def test_restart_mid_cleanup_resumes_after_worktree_already_gone(self):
        w = self.w
        b = self.producing()
        w.adapter.running.clear()
        w.store.update(b["id"], state="ERROR", pid=None)
        self.clear(b)
        w.tick()                                                     # pin + (partial) teardown
        self.assert_idle_and_reusable()
        # A crash after the worktree was removed but before the DB commit: row still there, directory unregistered.
        b2 = self.w.store.create_batch(method="a", producer="deepseek", shard="001", batch="01", branch=BRANCH,
                                       worktree=str(w.paths.worktrees / "a-deepseek-001-01"))
        w.store.update(b2, state="ERROR")
        control.request_clear(w.store, "deepseek", "a", b2)
        w.sup = w.make_sup()
        w.tick(2)
        self.assert_idle_and_reusable()


class ClearRequestRules(ClearBase):
    def test_stale_and_repeated_requests(self):
        w = self.w
        b = self.producing()
        w.adapter.running.clear()
        self.clear(b)
        self.assertTrue(control.request_clear(w.store, "deepseek", "a", b["id"])[0])   # repeated: still one request
        import sqlite3
        self.assertEqual(sqlite3.connect(w.paths.db).execute("SELECT COUNT(*) FROM clear_requests").fetchone()[0], 1)
        w.tick(2)
        self.assert_idle_and_reusable()
        ok, msg = control.request_clear(w.store, "deepseek", "a", b["id"])             # stale confirmation screen
        self.assertFalse(ok)
        self.assertTrue(msg)
        self.assertFalse(control.request_clear(w.store, "sonnet", "a", 999)[0])
        self.assertIsNone(w.store.clear_request("deepseek", "a"))

    def test_request_for_batch_that_finished_meanwhile_is_dropped(self):
        w = self.w
        b = self.producing()
        w.adapter.running.clear()
        self.clear(b)
        w.store.update(b["id"], state="COMPLETE")
        w.tick()
        self.assertIsNone(w.store.clear_request("deepseek", "a"))
        self.assertEqual(w.store.batch(b["id"])["state"], "COMPLETE")
        self.assertEqual(w.git.discarded, [])

    def test_clear_is_not_a_side_effect_of_stop(self):
        w = self.w
        b = self.producing()
        control.stop_line(w.store, "deepseek", "a")
        w.tick()
        self.assertEqual(w.store.batch(b["id"])["state"], "PAUSED")
        self.assertEqual(w.git.discarded, [])

    def test_buttons_follow_state(self):
        w = self.w
        st = control.line_status(w.store, "deepseek", "a")
        self.assertFalse(st["can_clear"])                            # no batch selected
        b = self.producing()
        self.assertTrue(control.line_status(w.store, "deepseek", "a")["can_clear"])
        w.adapter.running.clear()
        self.clear(b)
        w.tick(0)
        w.store.pin_clear("deepseek", "a")
        st = control.line_status(w.store, "deepseek", "a")
        self.assertEqual((st["state"], st["can_clear"], st["can_stop"], st["can_retry"]), ("CLEARING", False, False, False))


class ClearQueues(unittest.TestCase):
    """After Clear exactly the cleared batch is eligible again; other Lines stay untouched."""

    def test_ab_per_model_and_cd_shared_queue(self):
        for method in ("a", "c"):
            with self.subTest(method=method):
                w = World(models=None)
                try:
                    w.start("single", "deepseek", method)
                    w.tick()
                    mine = w.row("deepseek", method)
                    w.start("single", "deepseek", "b")
                    w.tick()
                    other = w.row("deepseek", "b")
                    w.adapter.running.pop(mine["pid"])
                    w.store.update(mine["id"], state="ERROR", pid=None)
                    control.request_clear(w.store, "deepseek", method, mine["id"])
                    w.tick(2)
                    self.assertIsNone(w.store.latest_batch("deepseek", method))
                    self.assertEqual(w.store.claimed_keys(method, None), set())
                    self.assertEqual(w.store.batch(other["id"])["state"], other["state"])
                    self.assertTrue(Path(other["worktree"]).exists())
                    w.start("single", "deepseek", method)
                    w.tick()
                    again = w.row("deepseek", method)
                    self.assertEqual((again["shard"], again["batch"]), (mine["shard"], mine["batch"]))
                    self.assertNotEqual(again["id"], mine["id"])
                finally:
                    w.tmp.cleanup()


class ClearRealGit(unittest.TestCase):
    """The real git path of Clear: only the owned worktree/branch go, dirty and untracked included."""

    def setUp(self):
        from tests.test_gitops_adapter import RealGit
        self.rg = RealGit("setUp")
        self.rg.setUp()
        self.git, self.repo, self.wts = self.rg.git, self.rg.repo, self.rg.wts

    def tearDown(self):
        self.rg.tearDown()

    def test_dirty_and_untracked_worktree_is_discarded_and_resume_is_idempotent(self):
        self.git.fetch_base("master")
        wt = self.wts / "w1"
        self.git.create_worktree(wt, "b1", "master")
        (wt / "f").write_text("dirty")
        (wt / "new.txt").write_text("untracked")
        self.assertTrue(self.git.verify_owned(wt, "b1"))
        self.git.discard_owned(wt, "b1")
        self.assertFalse(wt.exists())
        self.assertIsNone(self.git.registered(wt))
        self.assertFalse(self.git._git("rev-parse", "--verify", "--quiet", "refs/heads/b1", check=False).ok)
        self.assertTrue((self.repo / "f").exists())                  # main checkout untouched
        self.assertFalse(self.git.verify_owned(wt, "b1"))            # resumed Clear: already gone is fine
        self.git.discard_owned(wt, "b1")

    def test_foreign_paths_and_branches_are_refused(self):
        from warroom.gitops import CleanupBlocked
        self.git.fetch_base("master")
        wt = self.wts / "w1"
        self.git.create_worktree(wt, "b1", "master")
        other = self.wts / "w2"
        self.git.create_worktree(other, "b2", "master")
        for path, branch in ((wt, "b2"), (self.repo, "master"), (self.wts, "b1"), (self.wts.parent / "x", "b1")):
            with self.subTest(path=str(path), branch=branch):
                with self.assertRaises(CleanupBlocked):
                    self.git.discard_owned(path, branch)
        self.assertTrue(wt.exists() and other.exists())

    def test_remote_delete_requires_the_expected_head(self):
        from warroom.gitops import GitError
        self.git.fetch_base("master")
        wt = self.wts / "w1"
        self.git.create_worktree(wt, "b1", "master")
        self.git._git("push", "origin", "b1", cwd=wt)
        head = self.git.remote_head("b1")
        with self.assertRaises(GitError):
            self.git.delete_remote_branch("b1", "0" * 40)
        self.assertEqual(self.git.remote_head("b1"), head)
        self.git.delete_remote_branch("b1", head)
        self.assertIsNone(self.git.remote_head("b1"))


if __name__ == "__main__":
    unittest.main()
