"""Issue #2291: durable generic Issue publication, without entering the shared-defect pause path."""
import unittest

from tests.fakes import World
from warroom.store import SCHEMA_VERSION


class IssuePublication(unittest.TestCase):
    def setUp(self):
        self.w = World()

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_manual_request_publishes_exact_text_without_pausing_or_queueing(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.tick()
        before = w.row()
        title, body = "수동 확인 목록", "C000123\nC000456"
        request_id = w.sup.maint.report_issue(title, body, event_key="manual-list:001")
        w.tick(3)

        request = w.store.issue_requests()[0]
        self.assertEqual((request["id"], request["state"], request["issue_number"]),
                         (request_id, "PUBLISHED", 101))
        self.assertEqual((w.gh.issues[101]["title"], w.gh.issues[101]["body"]), (title, body))
        self.assertEqual(w.gh.issues[101]["labels"], [])
        self.assertEqual(len(w.gh.created), 1)
        self.assertEqual(w.store.maintenance_rows(), [])
        self.assertEqual(w.row()["state"], before["state"])
        self.assertEqual(w.row()["pause_reason"], "")
        self.assertEqual(SCHEMA_VERSION, 11)

    def test_unavailable_github_keeps_persisted_request_and_processes_it_after_restart(self):
        w = self.w
        w.gh.fail_list = True
        request_id = w.sup.maint.report_issue("목록", "C000123", event_key="list:retry")
        w.tick(2)
        self.assertEqual(w.store.issue_requests()[0]["state"], "PENDING")
        self.assertEqual(w.gh.created, [])

        w.sup = w.make_sup()
        w.gh.fail_list = False
        w.tick(2)
        request = w.store.issue_requests()[0]
        self.assertEqual((request["id"], request["state"], request["issue_number"]),
                         (request_id, "PUBLISHED", 101))
        self.assertEqual(w.gh.created, [101])
        self.assertEqual(w.store.maintenance_rows(), [])

    def test_lost_create_response_is_reconciled_without_a_second_issue(self):
        w = self.w
        w.gh.fail_create_lost = True
        w.sup.maint.report_issue("목록", "C000123", event_key="list:lost-response")
        w.tick()
        request = w.store.issue_requests()[0]
        self.assertEqual((request["state"], request["attempt_issue_numbers"], w.gh.created),
                         ("CREATING", "[]", [101]))
        # The API may expose only second-resolution timestamps; the pre-create ID snapshot is the recovery proof.
        w.gh.issues[101]["created_at"] = request["created_at"]

        w.sup = w.make_sup()
        w.tick(2)
        request = w.store.issue_requests()[0]
        self.assertEqual((request["state"], request["issue_number"], w.gh.created),
                         ("PUBLISHED", 101, [101]))
        self.assertEqual(w.gh.issues[101]["body"], "C000123")
        self.assertEqual(len(w.gh.issue_comments_[101]), 1)

    def test_same_second_preexisting_issue_is_not_reused(self):
        w = self.w
        w.gh.issues[101] = {"state": "open", "labels": [], "title": "목록", "body": "C000123",
                            "created_at": 123.0}
        w.sup.maint.report_issue("목록", "C000123", event_key="list:after-existing")
        request = w.store.issue_requests()[0]
        # Reproduce a GitHub timestamp that collides with the request's Unix second.
        w.gh.issues[101]["created_at"] = request["created_at"]
        w.tick()

        request = w.store.issue_requests()[0]
        self.assertEqual((request["state"], request["issue_number"]), ("PUBLISHED", 102))
        self.assertEqual(w.gh.created, [102])
        self.assertNotIn("warroom-issue-request:", "".join(
            c["body"] for c in w.gh.issue_comments_.get(101, [])))
        self.assertEqual(w.gh.issues[102]["body"], "C000123")

    def test_same_event_is_idempotent_but_distinct_events_with_identical_text_stay_separate(self):
        w = self.w
        one = w.sup.maint.report_issue("목록", "C000123", event_key="same:1")
        self.assertEqual(w.sup.maint.report_issue("목록", "C000123", event_key="same:1"), one)
        w.tick()
        two = w.sup.maint.report_issue("목록", "C000123", event_key="same:2")
        w.tick(2)

        self.assertNotEqual(one, two)
        self.assertEqual(w.gh.created, [101, 102])
        self.assertEqual([r["state"] for r in w.store.issue_requests()], ["PUBLISHED", "PUBLISHED"])
        self.assertNotEqual(w.store.issue_requests()[0]["issue_number"],
                            w.store.issue_requests()[1]["issue_number"])

    def test_urgent_request_uses_existing_label_and_maintainer_queue(self):
        w = self.w
        w.sup.maint.report_issue("긴급 작업", "조사", urgent=True, event_key="urgent:1")
        w.tick(2)

        self.assertEqual(w.gh.issues[101]["labels"], ["urgent"])
        self.assertEqual(w.store.issue_requests()[0]["state"], "PUBLISHED")
        self.assertEqual(w.store.maintenance(101)["state"], "QUEUED")
        self.assertEqual(len(w.store.all_batches()), 0)  # the default test world has no configured Maintainer

    def test_event_key_cannot_be_reused_with_a_different_payload(self):
        w = self.w
        w.sup.maint.report_issue("목록", "C000123", event_key="fixed:key")
        with self.assertRaises(ValueError):
            w.sup.maint.report_issue("다른 제목", "C000123", event_key="fixed:key")
        self.assertEqual(w.store.issue_requests()[0]["title"], "목록")
        self.assertEqual(w.gh.created, [])


if __name__ == "__main__":
    unittest.main()
