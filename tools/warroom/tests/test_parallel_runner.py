from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

from tests.parallel_runner import audit_results, discover, run_class


ROOT = Path(__file__).resolve().parents[1]
ENV = dict(os.environ, PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE="1")


class ParallelRunnerContract(unittest.TestCase):
    def test_global_process_inventory_classes_run_exclusively(self):
        groups, _, _ = discover(ROOT)
        by_class = {group["class_id"]: group for group in groups}
        self.assertTrue(by_class["tests.test_issue_3773.RunnerContractTests"]["exclusive"])
        self.assertFalse(by_class["tests.test_parallel_runner.ParallelRunnerContract"]["exclusive"])

    def test_successful_class_reports_all_executed_ids(self):
        test_id = "tests.runner_fixtures.SuccessfulCase.test_success"
        group = {"class_id": "tests.runner_fixtures.SuccessfulCase", "test_ids": [test_id], "order": 0}
        with tempfile.TemporaryDirectory() as td:
            result = run_class(ROOT, group, Path(td), ENV, sys.executable)
        self.assertEqual(result["returncode"], 0)
        self.assertEqual(result["report"]["ids"], [test_id])

    def test_id_multiset_mismatch_fails_closed(self):
        group = {"class_id": "tests.fixture.Example", "test_ids": ["tests.fixture.Example.test_a",
                                                                       "tests.fixture.Example.test_b"], "order": 0}
        result = {"class_id": group["class_id"], "returncode": 0, "launch_error": None,
                  "report": {"class_id": group["class_id"], "ids": ["tests.fixture.Example.test_a",
                                                                          "tests.fixture.Example.test_a"],
                             "tests_run": 2}}
        errors = audit_results([group], [result], [], [])
        self.assertTrue(any("multiset differs" in error for error in errors))

    def test_intentional_test_failure_is_reported_and_keeps_worker_output(self):
        test_id = "tests.runner_fixtures.IntentionalFailure.test_failure"
        group = {"class_id": "tests.runner_fixtures.IntentionalFailure", "test_ids": [test_id], "order": 0}
        with tempfile.TemporaryDirectory() as td:
            result = run_class(ROOT, group, Path(td), ENV, sys.executable)
            self.assertEqual(result["returncode"], 1)
            self.assertEqual(result["report"]["failures"][0]["id"], test_id)
            self.assertIn("intentional worker stdout", Path(result["stdout_path"]).read_text())

    def test_worker_crash_has_no_implicit_pass(self):
        test_id = "tests.runner_fixtures.ProcessCrash.test_crash"
        group = {"class_id": "tests.runner_fixtures.ProcessCrash", "test_ids": [test_id], "order": 0}
        with tempfile.TemporaryDirectory() as td:
            result = run_class(ROOT, group, Path(td), ENV, sys.executable)
        self.assertEqual(result["returncode"], 91)
        self.assertIsNone(result["report"])
        self.assertTrue(any("no structured result" in error
                            for error in audit_results([group], [result], [], [])))

    def test_import_error_is_nonzero_and_preserved(self):
        test_id = "tests.missing_runner_fixture.MissingCase.test_missing"
        group = {"class_id": "tests.missing_runner_fixture.MissingCase", "test_ids": [test_id], "order": 0}
        with tempfile.TemporaryDirectory() as td:
            result = run_class(ROOT, group, Path(td), ENV, sys.executable)
        self.assertEqual(result["returncode"], 2)
        self.assertIn("bootstrap_error", result["report"])
        self.assertTrue(audit_results([group], [result], [], []))

    def test_unexpected_skip_and_worker_exit_fail_closed(self):
        group = {"class_id": "tests.fixture.Example", "test_ids": ["tests.fixture.Example.test_a"], "order": 0}
        result = {"class_id": group["class_id"], "returncode": 1, "launch_error": None,
                  "report": {"class_id": group["class_id"], "ids": group["test_ids"], "tests_run": 1,
                             "skips": [{"id": group["test_ids"][0], "reason": "unexpected"}]}}
        errors = audit_results([group], [result], [], [])
        self.assertTrue(any("skips" in error for error in errors))
        self.assertTrue(any("worker exited nonzero" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
