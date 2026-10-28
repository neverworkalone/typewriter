"""#2022: Maintainer issue ownership, clear, stop, retry, and drain semantics.

Invariant: every Maintainer control acts on the exact Issue + execution shown, only on the Maintainer Line, and a Clear
removes only a proven-owned execution (fail closed otherwise) while the urgent Issue, its defects and the PAUSED
origin batch stay untouched and nothing restarts without an explicit Retry. Fake AI/GitHub/git only.
"""
import unittest
from pathlib import Path

from tests.fakes import HEAD1
from tests.test_issue_1555 import (MERGE, maintainer_row, produce_and_report, run_maintainer_to_merge, world)
from warroom import control
from warroom.store import CLEARED_HOLD


def start_maintainer(w):
    """A producing batch reports a defect; the Maintainer (sonnet) is running on urgent Issue #101."""
    b = produce_and_report(w)
    w.tick()
    m = maintainer_row(w)
    assert m["producer"] == "sonnet" and m["state"] in ("PREPARE", "PRODUCING"), m["state"]
    return b, m


def open_pr(w, n=50, head=HEAD1):
    w.pr_info(n, head, head_ref="maint-101")
    w.gh.by_branch["maint-101"] = [{"number": n, "state": "OPEN", "headRefOid": head}]
    w.git.remote["maint-101"] = head
    w.git.local_head = head


class World2022(unittest.TestCase):
    def setUp(self):
        self.w = world()

    def tearDown(self):
        self.w.tmp.cleanup()

    def clear(self, m, issue=101):
        return control.request_clear(self.w.store, "sonnet", "m", m["id"], issue)

    def assert_origin_untouched(self, b):
        w = self.w
        now = w.row()
        self.assertEqual((now["state"], now["pause_reason"], now["session_id"]), ("PAUSED", "shared_defect", b["session_id"]))
        self.assertTrue(Path(b["worktree"]).exists())
        self.assertEqual([(d["state"], d["issue_number"]) for d in w.store.defects()], [("LINKED", 101)])
        self.assertEqual(len(w.gh.created), 1)


class MaintainerStatus(World2022):
    def test_control_status_binds_actions_to_the_active_maintainer_issue(self):
        w = self.w
        st = control.maintainer_status(w.store, w.cfg, control.maintainer_producer(w.store, w.cfg))
        self.assertEqual((st["state"], st["maintainer"]["issue"]), ("IDLE", None))
        self.assertEqual(control.maintainer_producer(w.store, w.cfg, "deepseek"), "sonnet")   # not the card's column
        b, m = start_maintainer(w)
        st = control.maintainer_status(w.store, w.cfg, "sonnet")
        self.assertEqual((st["state"], st["maintainer"]["issue"], st["batch_id"]), ("PRODUCING", 101, m["id"]))
        self.assertTrue(st["can_stop"] and st["can_drain"] and not st["can_retry"])
        w.store.update(m["id"], state="ERROR", error="원인 [x] 전문 " * 40, pid=None)
        st = control.maintainer_status(w.store, w.cfg, "sonnet")
        self.assertEqual((st["state"], st["maintainer"]["issue"], st["batch_id"]), ("ERROR", 101, m["id"]))
        self.assertTrue(st["can_retry"] and st["can_clear"] and not st["can_stop"])

    def test_other_open_issues_are_identifiable_and_the_live_one_is_the_target(self):
        w = self.w
        b, m = start_maintainer(w)
        w.store.ensure_maintenance(150)                  # an older, still queued Issue
        w.store.update_maintenance(150, created_at=1)
        st = control.maintainer_status(w.store, w.cfg, "sonnet")
        self.assertEqual(st["maintainer"]["issue"], 101)  # the ACTIVE execution, not the oldest row
        self.assertEqual([n for n, _ in st["maintainer"]["others"]], [150])


class MaintainerClear(World2022):
    def test_clear_with_open_pr_removes_only_the_execution_and_keeps_the_issue_held(self):
        w = self.w
        b, m = start_maintainer(w)
        open_pr(w)
        self.assertTrue(self.clear(m)[0])
        w.tick(3)
        self.assertEqual(w.gh.closed, [50])                       # closed, never merged
        self.assertEqual(w.git.remote_deleted, ["maint-101"])
        self.assertEqual([x for x in w.git.discarded if x[1] == "maint-101"][0][1], "maint-101")
        self.assertIsNone(maintainer_row(w))                      # no ghost ACTIVE
        row = w.store.maintenance(101)
        self.assertEqual((row["state"], row["batch_id"], row["hold_reason"]), ("HELD", None, CLEARED_HOLD))
        self.assertIsNone(w.store.clear_request("sonnet", "m"))
        self.assert_origin_untouched(b)
        launches, claims = len(w.adapter.launches), len(w.store.all_batches())
        w.tick(5)                                                 # nothing restarts, nothing is released or duplicated
        self.assertEqual((len(w.adapter.launches), len(w.store.all_batches())), (launches, claims))
        self.assertEqual(w.store.maintenance(101)["state"], "HELD")
        st = control.maintainer_status(w.store, w.cfg, "sonnet")
        self.assertEqual((st["state"], st["can_retry"], st["can_clear"], st["can_stop"]), ("HELD", True, False, False))
        # explicit Retry starts exactly one new attempt for the SAME Issue
        self.assertTrue(control.retry_maintainer(w.store, 101))
        self.assertFalse(control.retry_maintainer(w.store, 101))  # a repeated request requeues nothing
        w.tick(2)
        again = maintainer_row(w)
        self.assertEqual((again["batch"], again["branch"], w.store.maintenance(101)["batch_id"]), ("101", "maint-101", again["id"]))
        self.assertEqual(len([x for x in w.store.all_batches() if x["method"] == "m"]), 1)
        self.assertEqual(len(w.gh.created), 1)

    def test_clear_request_cannot_target_another_issue_or_execution(self):
        w = self.w
        b, m = start_maintainer(w)
        w.store.ensure_maintenance(999)
        for args in ((m["id"], 999), (m["id"], None), (m["id"] + 7, 101)):
            ok, _ = control.request_clear(w.store, "sonnet", "m", *args)
            self.assertFalse(ok, args)
        self.assertEqual(control.request_clear(w.store, "deepseek", "m", m["id"], 101)[0], False)
        w.tick(2)
        self.assertEqual((maintainer_row(w)["id"], w.store.maintenance(101)["batch_id"]), (m["id"], m["id"]))

    def test_unverifiable_ownership_fails_closed_and_preserves_everything(self):
        w = self.w
        b, m = start_maintainer(w)
        open_pr(w)
        w.pr_info(50, HEAD1, head_ref="someone-elses-branch")
        self.assertTrue(self.clear(m)[0])
        w.tick(3)
        self.assertEqual((w.gh.closed, w.git.remote_deleted), ([], []))
        row = maintainer_row(w)
        self.assertEqual(row["state"], "CLEARING")
        self.assertEqual(w.store.clear_request("sonnet", "m")["status"], "BLOCKED")
        self.assertEqual((w.store.maintenance(101)["state"], w.store.maintenance(101)["batch_id"]), ("ACTIVE", m["id"]))
        self.assertTrue(Path(m["worktree"]).exists())
        self.assert_origin_untouched(b)
        n = len(w.adapter.launches)
        w.tick(4)
        self.assertEqual(len(w.adapter.launches), n)             # CLEARING pins it: nothing relaunches

    def test_a_branch_that_is_not_the_issues_own_is_refused(self):
        w = self.w
        b, m = start_maintainer(w)
        w.store.update(m["id"], branch="maint-102")
        self.assertTrue(self.clear(m)[0])
        w.tick(3)
        self.assertEqual(w.store.clear_request("sonnet", "m")["status"], "BLOCKED")
        self.assertEqual(w.git.discarded, [])

    def test_a_merged_pr_is_never_abandoned_it_goes_through_the_normal_cleanup(self):
        w = self.w
        b, m = start_maintainer(w)
        open_pr(w)
        w.pr_info(50, HEAD1, state="closed", merged=True, head_ref="maint-101", merge_sha=MERGE)
        self.assertTrue(self.clear(m)[0])
        w.tick(4)
        self.assertEqual((w.gh.closed, w.git.remote_deleted), ([], []))
        self.assertEqual(maintainer_row(w)["state"], "COMPLETE")
        self.assertEqual(w.store.maintenance(101)["state"], "DONE")
        self.assertIsNone(w.store.clear_request("sonnet", "m"))

    def test_clear_waits_for_the_ai_to_exit_before_deleting_anything(self):
        w = self.w
        b, m = start_maintainer(w)
        pid = w.store.batch(m["id"])["pid"]
        self.assertIsNotNone(pid)
        self.assertTrue(self.clear(m)[0])
        w.tick()
        self.assertTrue(Path(m["worktree"]).exists())            # the first tick only stops the AI: nothing removed yet
        w.tick(3)                                                # exit confirmed -> teardown
        self.assertIsNone(maintainer_row(w))
        self.assertFalse(Path(m["worktree"]).exists())
        self.assertEqual(w.store.maintenance(101)["state"], "HELD")


class MaintainerControls(World2022):
    def test_stop_pauses_only_the_maintainer_and_retry_is_pinned_to_the_screen(self):
        w = self.w
        w.start("single", "deepseek", "b")
        w.adapter.plan.append({"code": 0, "session": "ses_b"})
        w.tick()
        other = w.row("deepseek", "b")
        b, m = start_maintainer(w)
        self.assertTrue(control.stop_maintainer(w.store, "sonnet", m["id"]))
        w.tick(2)
        paused = maintainer_row(w)
        self.assertEqual(paused["state"], "PAUSED")
        self.assertTrue(Path(m["worktree"]).exists())
        self.assertEqual(w.store.maintenance(101)["batch_id"], m["id"])
        self.assertEqual(w.row("deepseek", "b")["state"], other["state"])   # no other Line was touched
        self.assertFalse(control.retry_maintainer(w.store, 101, m["id"] + 1))   # stale batch id
        self.assertFalse(control.retry_maintainer(w.store, 999, m["id"]))       # stale Issue
        self.assertTrue(control.retry_maintainer(w.store, 101, m["id"]))
        w.tick(2)
        self.assertEqual(maintainer_row(w)["state"], "PRODUCING")
        self.assertEqual(len([x for x in w.store.all_batches() if x["method"] == "m"]), 1)

    def test_stop_bound_to_a_finished_issue_never_stops_the_next_one(self):
        w = self.w
        b, m = start_maintainer(w)
        w.store.ensure_maintenance(202)
        w.gh.issues[202] = {"state": "open", "labels": ["urgent"], "title": "t", "body": ""}
        run_maintainer_to_merge(w, 101)                          # A completes, B (#202) is claimed
        w.tick(2)
        nxt = w.store.active_batch("sonnet", "m")
        self.assertEqual(nxt["batch"], "202")
        self.assertFalse(control.stop_maintainer(w.store, "sonnet", m["id"]))   # Yes on A's stale confirmation
        w.tick(2)
        self.assertEqual(w.store.active_batch("sonnet", "m")["state"], "PRODUCING")
        # a request that was accepted for A but is consumed after B was claimed is dropped by the Supervisor
        w.store.set("stop_pin_sonnet_m", str(m["id"]))
        w.store.set_line("sonnet", "m", force_stop=1)
        w.tick(2)
        self.assertEqual((w.store.active_batch("sonnet", "m")["id"], w.store.active_batch("sonnet", "m")["state"]), (nxt["id"], "PRODUCING"))
        self.assertIsNone(w.store.get("stop_pin_sonnet_m"))
        self.assertEqual(w.store.peek_line("sonnet", "m")["force_stop"], 0)
        self.assertTrue(control.stop_maintainer(w.store, "sonnet", nxt["id"]))    # the current execution still stops
        w.tick(2)
        self.assertEqual(w.store.active_batch("sonnet", "m")["state"], "PAUSED")

    def test_maintainer_retry_is_available_only_for_a_repairable_issue(self):
        w = self.w
        b, m = start_maintainer(w)
        self.assertFalse(control.retry_maintainer(w.store))
        w.store.update(m["id"], state="ERROR", error="boom", pid=None)
        self.assertTrue(control.retry_maintainer(w.store))

    def test_drain_finishes_the_current_issue_but_claims_no_next_one(self):
        w = self.w
        b, m = start_maintainer(w)
        w.store.ensure_maintenance(202)
        w.gh.issues[202] = {"state": "open", "labels": ["urgent"], "title": "t", "body": ""}
        control.set_drain(w.store, "sonnet", "m", True)
        st = control.maintainer_status(w.store, w.cfg, "sonnet")
        self.assertTrue(st["line_drain"] and st["can_drain"])
        run_maintainer_to_merge(w, 101)                           # the current Issue completes normally ...
        self.assertEqual(w.store.maintenance(101)["state"], "DONE")
        w.tick(4)                                                 # ... and the next is NOT claimed
        self.assertEqual((w.store.maintenance(202)["state"], w.store.maintenance(202)["batch_id"]), ("QUEUED", None))
        self.assertTrue(w.store.maintenance_drained())            # Drain survives the completion until cancelled
        control.set_drain(w.store, "sonnet", "m", False)
        w.tick(2)
        self.assertEqual(w.store.maintenance(202)["state"], "ACTIVE")

    def test_drain_controls_are_unavailable_when_no_issue_is_active(self):
        w = self.w
        st = control.maintainer_status(w.store, w.cfg, "sonnet")
        self.assertFalse(st["can_drain"])
        self.assertFalse(st["can_stop"] or st["can_clear"] or st["can_retry"])

    def test_drain_stop_all_and_drain_all_never_touch_the_maintainer(self):
        w = self.w
        b, m = start_maintainer(w)
        control.stop_all(w.store)
        control.drain_all(w.store, [("deepseek", "a"), ("sonnet", "a")])
        w.tick(2)
        self.assertEqual(maintainer_row(w)["state"], "PRODUCING")
        self.assertFalse(w.store.maintenance_drained())

    def test_a_cleared_issue_never_releases_the_paused_batch(self):
        w = self.w
        b, m = start_maintainer(w)
        self.assertTrue(self.clear(m)[0])
        w.tick(4)
        self.assertEqual(w.git.integrated, [])
        self.assertEqual(w.row()["state"], "PAUSED")
        self.assertEqual(w.store.defects()[0]["state"], "LINKED")
if __name__ == "__main__":
    unittest.main()
