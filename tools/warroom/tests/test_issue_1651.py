import json
import unittest

from tests.fakes import HEAD1, HEAD2
from warroom import stage3
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

    def test_stage3_search_selects_latest_merge_independent_of_result_order(self):
        from urllib.parse import parse_qs, urlparse
        class Runner:
            def run(self, argv, **kwargs):
                path = argv[2]
                def row(n, shard, date):
                    return {"number": n, "title": f"[S3/Codex] {shard}", "body": "implements #2455",
                            "pull_request": {"merged_at": date}}
                if path.startswith("search/"):
                    q = parse_qs(urlparse(path).query)["q"][0]
                    items = [row(1, "005", "2026-01-01T00:00:00Z"), row(2, "006", "2026-02-01T00:00:00Z")] if '"S3"' in q else []
                    return Result(0, json.dumps({"items": items, "total_count": len(items), "incomplete_results": False}))
                repo = {"full_name": "neverworkalone/typewriter"}
                return Result(0, json.dumps({"number": 2, "title": "[S3/Codex] 006", "body": "implements #2455",
                    "merged": True, "state": "closed", "merged_at": "2026-02-01T00:00:00Z", "merge_commit_sha": HEAD2,
                    "base": {"ref": "master", "repo": repo}, "head": {"ref": "s3-codex-006", "repo": repo}}))
        gh = GhClient(Runner(), {}, "neverworkalone/typewriter")
        self.assertEqual(gh.latest_refine_production("master", stage3.SPEC)["number"], 2)

    def test_stage3_search_limit_is_not_transient(self):
        from warroom.github import GhError, GhTransient
        class Runner:
            def run(self, argv, **kwargs):
                return Result(0, json.dumps({"items": [], "total_count": 1001, "incomplete_results": False}))
        with self.assertRaises(GhError) as caught:
            GhClient(Runner(), {}, "neverworkalone/typewriter").latest_refine_production("master", stage3.SPEC)
        self.assertNotIsInstance(caught.exception, GhTransient)

    def test_branch_pr_listing_includes_merge_timestamp_for_closed_state_classification(self):
        class Runner:
            argv = None

            def run(self, argv, **kwargs):
                self.argv = argv
                return Result(0, json.dumps([{"number": 2050, "state": "CLOSED", "headRefOid": HEAD1,
                                              "mergedAt": None}]))

        runner = Runner()
        gh = GhClient(runner, {}, "neverworkalone/typewriter")

        self.assertEqual(gh.prs_for_branch("c-codex-035-02"), [
            {"number": 2050, "state": "CLOSED", "headRefOid": HEAD1, "mergedAt": None}
        ])
        self.assertIn("number,state,headRefOid,mergedAt", runner.argv)


if __name__ == "__main__":
    unittest.main()
