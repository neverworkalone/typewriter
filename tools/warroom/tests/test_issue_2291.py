"""Issue #2291: durable generic Issue publication, without entering the shared-defect pause path."""
import unittest

from tests.fakes import World


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
        self.assertEqual((request["id"], request["issue_number"]), (request_id, 101))
        self.assertEqual((w.gh.issues[101]["title"], w.gh.issues[101]["body"]), (title, body))
        self.assertEqual(w.gh.issues[101]["labels"], [])
        self.assertEqual(len(w.gh.created), 1)
        self.assertEqual(w.store.maintenance_rows(), [])
        self.assertEqual(w.row()["state"], before["state"])
        self.assertEqual(w.row()["pause_reason"], "")

    def test_unavailable_github_keeps_persisted_request_and_processes_it_after_restart(self):
        w = self.w
        w.gh.fail_list = True
        request_id = w.sup.maint.report_issue("목록", "C000123", event_key="list:retry")
        w.tick(2)
        self.assertEqual(w.store.issue_requests()[0]["title"], "목록")
        self.assertEqual(w.gh.created, [])

        w.sup = w.make_sup()
        w.gh.fail_list = False
        w.tick(2)
        request = w.store.issue_requests()[0]
        self.assertEqual((request["id"], request["issue_number"]), (request_id, 101))
        self.assertEqual(w.gh.created, [101])
        self.assertEqual(w.store.maintenance_rows(), [])

    def test_lost_create_response_is_reconciled_without_a_second_issue(self):
        w = self.w
        w.gh.fail_create_lost = True
        request_id = w.sup.maint.report_issue("목록", "C000123", event_key="list:lost-response")
        w.tick()
        self.assertEqual(w.gh.created, [101])
        self.assertNotEqual(w.gh.issues[101]["title"], "목록")

        w.sup = w.make_sup()
        w.tick(2)
        request = w.store.issue_requests()[0]
        self.assertEqual((request["id"], request["issue_number"], w.gh.created),
                         (request_id, 101, [101]))
        self.assertEqual(w.gh.issues[101]["body"], "C000123")
        self.assertEqual(w.gh.issues[101]["title"], "목록")
        self.assertEqual(len(w.gh.issues), 1)

    def test_same_text_issue_created_after_a_failed_attempt_is_not_adopted(self):
        w = self.w
        w.gh.fail_create = True
        request_id = w.sup.maint.report_issue("목록", "C000123", event_key="list:external-race")
        w.tick()

        # Another actor publishes an identical, unmarked Issue before the request retries.
        w.gh.fail_create = False
        w.gh.issues[101] = {"state": "open", "labels": [], "title": "목록", "body": "C000123"}
        w.tick()

        request = next(r for r in w.store.issue_requests() if r["id"] == request_id)
        self.assertEqual(request["issue_number"], 102)
        self.assertEqual(w.gh.created, [102])
        self.assertEqual(w.gh.issues[101]["title"], "목록")
        self.assertEqual(w.gh.issues[102]["title"], "목록")
        self.assertFalse(any("warroom-issue-request:" in c["body"]
                             for c in w.gh.issue_comments_.get(101, [])))

    def test_same_event_is_idempotent_but_distinct_events_with_identical_text_stay_separate(self):
        w = self.w
        one = w.sup.maint.report_issue("목록", "C000123", event_key="same:1")
        self.assertEqual(w.sup.maint.report_issue("목록", "C000123", event_key="same:1"), one)
        w.tick()
        two = w.sup.maint.report_issue("목록", "C000123", event_key="same:2")
        w.tick(2)

        self.assertNotEqual(one, two)
        self.assertEqual(w.gh.created, [101, 102])
        self.assertNotEqual(w.store.issue_requests()[0]["issue_number"],
                            w.store.issue_requests()[1]["issue_number"])

    def test_urgent_request_uses_existing_label_and_maintainer_queue(self):
        w = self.w
        w.sup.maint.report_issue("긴급 작업", "조사", urgent=True, event_key="urgent:1")
        w.tick(2)

        self.assertEqual(w.gh.issues[101]["labels"], ["urgent"])
        self.assertIsNotNone(w.store.maintenance(101))
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
