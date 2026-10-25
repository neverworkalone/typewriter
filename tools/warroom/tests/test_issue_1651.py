import json
import unittest
from pathlib import Path

from tests.fakes import HEAD1, HEAD2, World
from warroom.github import GhClient
from warroom.shell import Result


class PullRequestFiles(unittest.TestCase):
    def test_rest_filename_fields_are_normalized_for_candidate_ownership(self):
        class Runner:
            def run(self, argv, **kwargs):
                pages = [[{"filename": "data/relation-candidates/024/024_02_b_deepseek.jsonl"}],
                         [{"filename": "README.md"}]]
                return Result(0, json.dumps(pages))

        gh = GhClient(Runner(), {}, "neverworkalone/typewriter")

        self.assertEqual(gh.pull_files(1594), [
            {"path": "data/relation-candidates/024/024_02_b_deepseek.jsonl"},
            {"path": "README.md"},
        ])


class MissingPrRecovery(unittest.TestCase):
    def running_producer(self, method="b", text="unclassified provider failure"):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.adapter.plan.append({"code": 1, "text": text})
        w.start("single", method=method)
        w.tick()
        return w, w.row(method=method)

    def failed_producer(self, method="b", text="unclassified provider failure"):
        w, b = self.running_producer(method, text)
        w.adapter.finish(b["pid"])
        w.tick()
        return w, w.row(method=method)

    def successful_producer_with_transient_pr_lookup(self, failures=1):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.adapter.plan.append({"code": 0})
        w.start("single", method="b")
        w.tick()
        b = w.row(method="b")
        self.install_pr(w, b, state="open", merged=False)
        original = w.gh.prs_for_branch
        remaining = {"count": failures}

        def flaky_lookup(branch):
            if remaining["count"]:
                remaining["count"] -= 1
                w.gh.branch_queries += 1
                raise RuntimeError("GitHub API unavailable")
            return original(branch)

        w.gh.prs_for_branch = flaky_lookup
        w.adapter.finish(b["pid"])
        w.tick()
        return w, w.row(method="b")

    @staticmethod
    def install_pr(w, b, number=1594, state="closed", merged=True, head=HEAD1, file_path=None):
        branch = b["branch"]
        w.pr_info(number, head, state=state, merged=merged, head_ref=branch)
        w.gh.by_branch[branch] = [{"number": number, "state": state.upper(), "headRefOid": head}]
        path = file_path or (
            f"data/relation-candidates/{b['shard']}/"
            f"{b['shard']}_{b['batch']}_{b['method']}_{b['producer']}.jsonl"
        )
        w.gh.files[number] = [{"path": path}]
        if state == "open":
            w.git.remote[branch] = head

    def test_batch_198_exit_1_merged_pr_reaches_complete_without_rerunning_ai(self):
        w, b = self.running_producer()
        branch = "b-deepseek-024-02"
        w.store.update(b["id"], shard="024", batch="02", branch=branch)
        w.git.reg[b["worktree"]] = branch
        b = w.row(method="b")
        self.install_pr(w, b)
        w.adapter.finish(b["pid"])
        w.tick()

        w.tick(2)

        self.assertEqual(w.row(method="b")["state"], "COMPLETE")
        self.assertEqual(w.row(method="b")["pr_number"], 1594)
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(w.store.runs(b["id"])[0]["exit_status"], "1")
        self.assertEqual(w.git.removed[0][1], branch)

    def test_failed_run_with_open_pr_returns_to_normal_review_gate(self):
        w, b = self.running_producer()
        self.install_pr(w, b, state="open", merged=False)
        w.adapter.finish(b["pid"])

        w.tick()

        b = w.row(method="b")
        self.assertEqual((b["state"], b["pr_number"]), ("WAITING_REVIEW", 1594))
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(w.git.removed, [])

    def test_verified_zero_exit_survives_later_github_error_text_and_recovers(self):
        w, b = self.successful_producer_with_transient_pr_lookup(failures=2)
        self.assertEqual((b["state"], b["paused_from"]), ("ERROR", "PRODUCING"))
        self.assertIn("조회 실패", b["error"])

        w.tick()  # first bounded recovery attempt fails and replaces the visible error
        self.assertIn("재발견/머지 확인이 불명확", w.row(method="b")["error"])
        w.now += 60
        w.tick()

        row = w.row(method="b")
        self.assertEqual((row["state"], row["pr_number"]), ("WAITING_REVIEW", 1594))
        self.assertEqual(len(w.adapter.launches), 1)

    def test_retry_checks_for_existing_pr_before_relaunching_verified_zero_exit(self):
        from warroom import control

        w, b = self.successful_producer_with_transient_pr_lookup()
        self.assertIsNone(b["pr_number"])
        self.assertTrue(control.retry(w.store, "deepseek", "b"))

        w.tick(2)  # operator Retry first restores PRODUCING, then performs the pre-relaunch PR check

        row = w.row(method="b")
        self.assertEqual((row["state"], row["pr_number"]), ("WAITING_REVIEW", 1594))
        self.assertEqual(len(w.adapter.launches), 1)

    def test_retry_with_unverified_zero_exit_and_existing_pr_fails_closed(self):
        from warroom import control

        w, b = self.failed_producer()
        self.install_pr(w, b, state="open", merged=False)
        with w.store._conn() as c:
            c.execute("UPDATE runs SET exit_status='0' WHERE batch_id=?", (b["id"],))
        self.assertTrue(control.retry(w.store, "deepseek", "b"))

        w.tick(2)  # operator Retry first restores PRODUCING, then performs the pre-relaunch PR check

        row = w.row(method="b")
        self.assertEqual(row["state"], "ERROR")
        self.assertIsNone(row["pr_number"])
        self.assertIn("완료 증거가 없어", row["error"])
        self.assertEqual(len(w.adapter.launches), 1)

    def test_recovery_poll_is_rate_limited(self):
        w, b = self.failed_producer()
        initial = w.gh.branch_queries
        w.tick(3)
        self.assertEqual(w.gh.branch_queries, initial + 1)
        w.now += 59
        w.tick(2)
        self.assertEqual(w.gh.branch_queries, initial + 1)
        w.now += 1
        w.tick()
        self.assertEqual(w.gh.branch_queries, initial + 2)

    def test_existing_pr_is_checked_before_a_scheduled_failure_retry(self):
        w, b = self.failed_producer(text="HTTP 429 Too Many Requests")
        self.assertEqual(b["state"], "PRODUCING")
        self.install_pr(w, b)

        w.now += 11
        w.tick()
        w.tick(2)

        self.assertEqual(w.row(method="b")["state"], "COMPLETE")
        self.assertEqual(len(w.adapter.launches), 1)

    def test_ambiguous_or_mismatched_pr_fails_closed(self):
        cases = ("multiple", "candidate", "head", "local_head", "branch_api", "files_api", "open_claim")
        for case in cases:
            with self.subTest(case=case):
                w, b = self.failed_producer()
                self.install_pr(w, b, state="open", merged=False,
                                file_path="data/relation-candidates/001/001_02_b_deepseek.jsonl"
                                if case == "candidate" else None)
                if case == "multiple":
                    w.gh.by_branch[b["branch"]].append({"number": 1595, "state": "CLOSED", "headRefOid": HEAD1})
                elif case == "head":
                    w.gh.prs[1594]["head_ref"] = "other-owned-branch"
                elif case == "local_head":
                    w.git.local_head = HEAD2
                elif case == "branch_api":
                    w.gh.branch_errors[b["branch"]] = RuntimeError("GitHub API unavailable")
                elif case == "files_api":
                    w.gh.files[1594] = RuntimeError("GitHub API unavailable")
                elif case == "open_claim":
                    w.gh.open.append({"number": 8, "files": [{
                        "path": f"data/relation-candidates/{b['shard']}/"
                        f"{b['shard']}_{b['batch']}_{b['method']}_{b['producer']}.jsonl"
                    }]})

                w.tick()

                row = w.row(method="b")
                self.assertEqual(row["state"], "ERROR")
                self.assertIsNone(row["pr_number"])
                self.assertEqual(len(w.adapter.launches), 1)
                self.assertTrue(Path(row["worktree"]).exists())
                self.assertEqual(w.git.removed, [])

    def test_unverified_zero_exit_does_not_trigger_missing_pr_recovery(self):
        w, b = self.failed_producer()
        queries = w.gh.branch_queries
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", error="completion evidence rejected")
        with w.store._conn() as c:
            c.execute("UPDATE runs SET exit_status='0' WHERE batch_id=?", (b["id"],))

        w.tick()

        self.assertEqual(w.gh.branch_queries, queries)
        self.assertEqual(w.row(method="b")["state"], "ERROR")
        self.assertEqual(w.git.removed, [])

    def test_unregistered_worktree_blocks_pr_adoption(self):
        w, b = self.failed_producer()
        self.install_pr(w, b)
        del w.git.reg[b["worktree"]]

        w.tick()

        self.assertEqual(w.row(method="b")["state"], "ERROR")
        self.assertIsNone(w.row(method="b")["pr_number"])
        self.assertEqual(w.git.removed, [])
        self.assertEqual(len(w.adapter.launches), 1)


if __name__ == "__main__":
    unittest.main()
