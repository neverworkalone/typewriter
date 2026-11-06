"""Parallel runner for the War Room unittest suite (#3801).

Discovers every test exactly like `python -m unittest discover -s tests -t .`, groups the cases into one unit per
TestCase class (a class's tests keep sharing setUpClass state and run in one process), and feeds the units, largest
first, to a pool of worker threads that each run `python -m unittest <ids...>` in a subprocess. The run passes only
when every unit passes AND the testsRun total equals the discovered count (nothing silently dropped).

Env: WARROOM_TEST_JOBS (worker count, default min(4, os.cpu_count()); 1 is handled by run-tests.mjs as the serial path), WARROOM_TEST_SHUFFLE=<seed> (shuffle the unit order
instead of the largest-first order, to prove the units are order independent).
"""
from __future__ import annotations

import collections
import json
import os
import random
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from collections import OrderedDict
from queue import Empty, Queue


def flatten(suite):
    for item in suite:
        if isinstance(item, unittest.TestSuite):
            yield from flatten(item)
        else:
            yield item


def collect(start_dir="tests", top_level_dir="."):
    """Return (units, total, load_errors): units is [(class_name, [test ids])], largest class first."""
    units: "OrderedDict[str, list[str]]" = OrderedDict()
    load_errors = []
    total = 0
    for test in flatten(unittest.TestLoader().discover(start_dir, top_level_dir=top_level_dir)):
        total += 1
        if type(test).__name__ == "_FailedTest":
            load_errors.append(test.id())
        key = f"{type(test).__module__}.{type(test).__name__}"
        units.setdefault(key, []).append(test.id())
    ordered = sorted(units.items(), key=lambda kv: (-len(kv[1]), kv[0]))
    return ordered, total, load_errors


class _Recording(unittest.TextTestResult):
    """Records every started test id and every non-pass outcome, so the parent can check the executed ids."""

    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.started, self.irregular = [], []

    def startTest(self, test):
        self.started.append(test.id())
        super().startTest(test)

    def addSkip(self, test, reason):
        self.irregular.append(f"skipped {test.id()}")
        super().addSkip(test, reason)

    def addExpectedFailure(self, test, err):
        self.irregular.append(f"expectedFailure {test.id()}")
        super().addExpectedFailure(test, err)

    def addUnexpectedSuccess(self, test):
        self.irregular.append(f"unexpectedSuccess {test.id()}")
        super().addUnexpectedSuccess(test)


def child(report_path, ids):
    """Run exactly `ids` in this process (unit of work) and write the structured result to report_path."""
    suite = unittest.TestLoader().loadTestsFromNames(ids)
    result = unittest.TextTestRunner(stream=sys.stdout, resultclass=_Recording).run(suite)
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump({"started": result.started, "irregular": result.irregular,
                   "ok": result.wasSuccessful()}, fh)
    return 0 if result.wasSuccessful() else 1


def run_unit(ids):
    """Run one unit in a subprocess; returns (exit code, structured report or None, output)."""
    with tempfile.TemporaryDirectory() as tmp:
        report = os.path.join(tmp, "report.json")
        proc = subprocess.run([sys.executable, "-m", "tests.parallel_runner", "--child", report, *ids],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace")
        try:
            with open(report, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError):
            data = None
    return proc.returncode, data, proc.stdout


def unit_problem(ids, code, data):
    """Fail-closed check of one unit: executed ids must equal the discovered ids as a multiset."""
    if data is None:
        return f"no structured result (exit={code})"
    problems = []
    if code != 0 or not data["ok"]:
        problems.append(f"unit failed (exit={code})")
    missing = collections.Counter(ids) - collections.Counter(data["started"])
    extra = collections.Counter(data["started"]) - collections.Counter(ids)
    if missing:
        problems.append(f"not run: {sorted(missing.elements())}")
    if extra:
        problems.append(f"unexpected or duplicate: {sorted(extra.elements())}")
    if data["irregular"]:
        problems.append(f"skip/xfail not allowed: {data['irregular']}")
    return "; ".join(problems)


def main() -> int:
    jobs = max(1, int(os.environ.get("WARROOM_TEST_JOBS") or min(4, os.cpu_count() or 1)))
    units, total, load_errors = collect()
    seed = os.environ.get("WARROOM_TEST_SHUFFLE")
    if seed:
        random.Random(seed).shuffle(units)
    queue: Queue = Queue()
    for unit in units:
        queue.put(unit)
    lock = threading.Lock()
    state = {"ran": 0, "bad": 0}
    started = time.monotonic()

    def worker():
        while True:
            try:
                name, ids = queue.get_nowait()
            except Empty:
                return
            code, data, out = run_unit(ids)
            problem = unit_problem(ids, code, data)
            with lock:
                state["ran"] += len(data["started"]) if data else 0
                if problem:
                    state["bad"] += 1
                    print(f"\n===== FAILED unit {name}: {problem} =====\n{out}", flush=True)

    threads = [threading.Thread(target=worker) for _ in range(min(jobs, len(units)) or 1)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    elapsed = time.monotonic() - started
    problems = []
    if state["bad"]:
        problems.append(f"{state['bad']} unit(s) failed")
    if load_errors:
        problems.append(f"import errors: {', '.join(load_errors)}")
    if state["ran"] != total:
        problems.append(f"ran {state['ran']} tests but discovered {total}")
    print(f"\nParallel War Room tests: {len(units)} units, {jobs} workers, ran {state['ran']}/{total} in {elapsed:.1f}s")
    if problems:
        print("FAILED: " + "; ".join(problems))
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--child":
        sys.exit(child(sys.argv[2], sys.argv[3:]))
    sys.exit(main())
