"""Run the complete War Room unittest inventory in isolated TestCase-class subprocesses."""
from __future__ import annotations

from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import time
import traceback
import unittest


class RunnerError(RuntimeError):
    pass


class StructuredResult(unittest.TestResult):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.failures_detail = []
        self.errors_detail = []
        self.skips_detail = []
        self.expected_failures_detail = []
        self.unexpected_successes_detail = []

    def startTest(self, test):
        self.ids.append(test.id())
        super().startTest(test)

    def addFailure(self, test, err):
        self.failures_detail.append({"id": test.id(), "traceback": self._exc_info_to_string(err, test)})
        super().addFailure(test, err)

    def addError(self, test, err):
        self.errors_detail.append({"id": test.id(), "traceback": self._exc_info_to_string(err, test)})
        super().addError(test, err)

    def addSkip(self, test, reason):
        self.skips_detail.append({"id": test.id(), "reason": reason})
        super().addSkip(test, reason)

    def addExpectedFailure(self, test, err):
        self.expected_failures_detail.append({"id": test.id(), "traceback": self._exc_info_to_string(err, test)})
        super().addExpectedFailure(test, err)

    def addUnexpectedSuccess(self, test):
        self.unexpected_successes_detail.append({"id": test.id()})
        super().addUnexpectedSuccess(test)


def _flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from _flatten(item)
        elif isinstance(item, unittest.TestCase):
            yield item
        else:
            raise RunnerError(f"discovery produced a non-TestCase result: {type(item).__name__}")


def _decorated(test, attr):
    method = getattr(test, test._testMethodName)
    return bool(getattr(test, attr, False) or getattr(type(test), attr, False) or getattr(method, attr, False))


def _uses_process_inventory(test):
    method = getattr(type(test), test._testMethodName)
    code = getattr(method, "__code__", None)
    return bool(code and "ps_table" in code.co_names)


def discover(root: Path):
    root = root.resolve()
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    loader = unittest.TestLoader()
    try:
        suite = loader.discover(str(root / "tests"), top_level_dir=str(root))
        tests = list(_flatten(suite))
    except BaseException as exc:
        raise RunnerError(f"unittest discovery failed: {type(exc).__name__}: {exc}") from exc
    if not tests:
        raise RunnerError("unittest discovery returned no TestCase instances")

    groups = {}
    process_inventory_classes = set()
    seen = set()
    expected_skips, expected_failures = [], []
    for test in tests:
        if type(test).__name__ == "_FailedTest":
            error = getattr(test, "_exception", "unknown discovery error")
            raise RunnerError(f"unittest discovery/import failed for {test.id()}: {error}")
        test_id = test.id()
        if test_id in seen:
            raise RunnerError(f"duplicate discovery ID: {test_id}")
        seen.add(test_id)
        cls = type(test)
        class_id = f"{cls.__module__}.{cls.__qualname__}"
        groups.setdefault(class_id, []).append(test_id)
        if _uses_process_inventory(test):
            process_inventory_classes.add(class_id)
        if _decorated(test, "__unittest_skip__"):
            expected_skips.append(test_id)
        if _decorated(test, "__unittest_expecting_failure__"):
            expected_failures.append(test_id)

    return ([{"class_id": name, "test_ids": ids, "order": order,
              "exclusive": name in process_inventory_classes}
             for order, (name, ids) in enumerate(groups.items())],
            expected_skips, expected_failures)


def _write_report(path: Path, report: dict) -> None:
    path.write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")


def _worker(payload_path: Path, report_path: Path) -> int:
    try:
        payload = json.loads(payload_path.read_text(encoding="utf-8"))
        expected_ids = payload["test_ids"]
        loader = unittest.TestLoader()
        tests = []
        for test_id in expected_ids:
            tests.extend(_flatten(loader.loadTestsFromName(test_id)))
        actual_ids = [test.id() for test in tests]
        if actual_ids != expected_ids:
            raise RunnerError(f"class inventory changed: expected {expected_ids!r}; loaded {actual_ids!r}")

        result = StructuredResult()
        suite = unittest.TestSuite(tests)
        result.startTestRun()
        try:
            suite.run(result)
        finally:
            result.stopTestRun()
        report = {
            "class_id": payload["class_id"], "ids": result.ids, "tests_run": result.testsRun,
            "failures": result.failures_detail, "errors": result.errors_detail,
            "skips": result.skips_detail, "expected_failures": result.expected_failures_detail,
            "unexpected_successes": result.unexpected_successes_detail,
        }
        _write_report(report_path, report)
        return 1 if result.failures or result.errors or result.unexpected_successes_detail else 0
    except BaseException as exc:
        _write_report(report_path, {"bootstrap_error": f"{type(exc).__name__}: {exc}",
                                    "traceback": traceback.format_exc(), "ids": [], "tests_run": 0})
        return 2


def run_class(root: Path, group: dict, temp: Path, env: dict, python: str | None = None) -> dict:
    index = group["order"]
    payload_path = temp / f"class-{index:04d}.input.json"
    report_path = temp / f"class-{index:04d}.result.json"
    stdout_path = temp / f"class-{index:04d}.stdout"
    stderr_path = temp / f"class-{index:04d}.stderr"
    payload_path.write_text(json.dumps({"class_id": group["class_id"], "test_ids": group["test_ids"]}),
                            encoding="utf-8")
    result = {"class_id": group["class_id"], "expected_ids": group["test_ids"], "returncode": None,
              "report": None, "launch_error": None, "stdout_path": stdout_path, "stderr_path": stderr_path}
    try:
        with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
            proc = subprocess.run([python or sys.executable, str(Path(__file__).resolve()), "--worker",
                                   str(payload_path), str(report_path)], cwd=root, env=env,
                                  stdout=stdout, stderr=stderr, check=False)
        result["returncode"] = proc.returncode
    except OSError as exc:
        result["launch_error"] = f"{type(exc).__name__}: {exc}"
    if report_path.exists():
        try:
            report = json.loads(report_path.read_text(encoding="utf-8"))
            if not isinstance(report, dict):
                raise ValueError("worker report is not a JSON object")
            result["report"] = report
        except (OSError, ValueError) as exc:
            result["launch_error"] = f"invalid worker report: {type(exc).__name__}: {exc}"
    return result


def audit_results(groups: list[dict], results: list[dict], expected_skips: list[str],
                  expected_failures: list[str]) -> list[str]:
    errors = []
    expected_ids = [test_id for group in groups for test_id in group["test_ids"]]
    expected_classes = [group["class_id"] for group in groups]
    by_class = {}
    for item in results:
        class_id = item["class_id"]
        if class_id in by_class:
            errors.append(f"duplicate worker result for {class_id}")
        by_class[class_id] = item
    if Counter(by_class.keys()) != Counter(expected_classes):
        errors.append("worker class inventory does not match discovery")

    actual_ids, actual_skips, actual_expected_failures = [], [], []
    for class_id in expected_classes:
        item = by_class.get(class_id)
        if item is None:
            continue
        if item.get("launch_error"):
            errors.append(f"worker launch/result failure for {class_id}: {item['launch_error']}")
        report = item.get("report")
        if report is None:
            errors.append(f"worker produced no structured result for {class_id} (exit={item.get('returncode')})")
            continue
        if report.get("class_id", class_id) != class_id:
            errors.append(f"worker reported the wrong class for {class_id}")
        if report.get("bootstrap_error"):
            errors.append(f"worker import/bootstrap failure for {class_id}: {report['bootstrap_error']}")
        ids = report.get("ids", [])
        actual_ids.extend(ids)
        if report.get("tests_run") != len(ids):
            errors.append(f"testsRun/ID count mismatch for {class_id}: {report.get('tests_run')} vs {len(ids)}")
        actual_skips.extend(row["id"] for row in report.get("skips", []))
        actual_expected_failures.extend(row["id"] for row in report.get("expected_failures", []))
        if report.get("failures"):
            errors.append(f"test failure in {class_id}: {', '.join(row['id'] for row in report['failures'])}")
        if report.get("errors"):
            errors.append(f"test error in {class_id}: {', '.join(row['id'] for row in report['errors'])}")
        if report.get("unexpected_successes"):
            errors.append(f"unexpected success in {class_id}: "
                          + ", ".join(row["id"] for row in report["unexpected_successes"]))
        if item.get("returncode") != 0 and not (report.get("failures") or report.get("errors")
                                                  or report.get("bootstrap_error")):
            errors.append(f"worker exited nonzero without a test failure for {class_id}: {item.get('returncode')}")

    expected_counts, actual_counts = Counter(expected_ids), Counter(actual_ids)
    if expected_counts != actual_counts:
        missing = list((expected_counts - actual_counts).elements())
        extra = list((actual_counts - expected_counts).elements())
        errors.append(f"discovered/executed test ID multiset differs: missing={missing[:20]!r}, extra={extra[:20]!r}")
    if Counter(actual_skips) != Counter(expected_skips):
        errors.append("actual skips do not match the discovered skip decorators")
    if Counter(actual_expected_failures) != Counter(expected_failures):
        errors.append("actual expected failures do not match the discovered expected-failure decorators")
    return errors


def _serial(root: Path) -> int:
    result = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", "."],
                            cwd=root, env=dict(os.environ, PYTHONPATH=str(root), PYTHONDONTWRITEBYTECODE="1"))
    return result.returncode


def main(argv=None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "--worker":
        if len(argv) != 3:
            return 2
        return _worker(Path(argv[1]), Path(argv[2]))

    root = Path.cwd()
    raw_jobs = os.environ.get("WARROOM_TEST_JOBS")
    if raw_jobs == "1":
        return _serial(root)
    try:
        jobs = min(4, os.cpu_count() or 1) if raw_jobs in (None, "") else int(raw_jobs)
        if jobs < 1:
            raise ValueError("WARROOM_TEST_JOBS must be a positive integer")
        groups, expected_skips, expected_failures = discover(root)
    except (ValueError, RunnerError) as exc:
        print(f"War Room parallel test inventory failed closed: {exc}", file=sys.stderr)
        return 1

    started = time.monotonic()
    shuffle_seed = os.environ.get("WARROOM_TEST_SHUFFLE")
    if shuffle_seed:
        ordered = list(groups)
        random.Random(shuffle_seed).shuffle(ordered)
    else:
        ordered = sorted(groups, key=lambda group: (-len(group["test_ids"]), group["order"]))
    env = dict(os.environ, PYTHONPATH=str(root), PYTHONDONTWRITEBYTECODE="1")
    results = []
    with tempfile.TemporaryDirectory(prefix="warroom-test-workers-") as td:
        temp = Path(td)
        parallel_groups = [group for group in ordered if not group["exclusive"]]
        exclusive_groups = [group for group in ordered if group["exclusive"]]
        with ThreadPoolExecutor(max_workers=jobs, thread_name_prefix="warroom-test-class") as pool:
            futures = {pool.submit(run_class, root, group, temp, env): group for group in parallel_groups}
            for future in as_completed(futures):
                results.append(future.result())
                print(".", end="", flush=True)
        for group in exclusive_groups:
            results.append(run_class(root, group, temp, env))
            print(".", end="", flush=True)
        print()
        errors = audit_results(groups, results, expected_skips, expected_failures)
        if errors:
            by_class = {item["class_id"]: item for item in results}
            failed_classes = set()
            for error in errors:
                print(error, file=sys.stderr)
            for item in results:
                report = item.get("report") or {}
                if (item.get("returncode") not in (0, None) or item.get("launch_error") or report.get("failures")
                        or report.get("errors") or report.get("bootstrap_error")):
                    failed_classes.add(item["class_id"])
            for class_id in sorted(failed_classes):
                item = by_class[class_id]
                report = item.get("report") or {}
                if report.get("bootstrap_error"):
                    print(report.get("traceback", report["bootstrap_error"]), file=sys.stderr)
                for key in ("failures", "errors"):
                    for row in report.get(key, []):
                        print(f"\n{row['id']}\n{row['traceback']}", file=sys.stderr)
                for label, path_key in (("stdout", "stdout_path"), ("stderr", "stderr_path")):
                    path = item[path_key]
                    try:
                        content = path.read_text(encoding="utf-8", errors="replace")
                    except OSError:
                        content = ""
                    if content:
                        print(f"\n--- {class_id} {label} ---\n{content}", file=sys.stderr)
        ran = sum((item.get("report") or {}).get("tests_run", 0) for item in results)
        duration = time.monotonic() - started
        print(f"Ran {ran} tests across {len(groups)} classes in {duration:.1f}s (jobs={jobs})")
        if errors:
            print(f"FAILED ({len(errors)} runner/test errors)")
            return 1
        print("OK")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
