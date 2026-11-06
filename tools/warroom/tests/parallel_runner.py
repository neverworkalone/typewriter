"""Parallel runner for the War Room unittest suite (#3801).

Discovers every test exactly like `python -m unittest discover -s tests -t .`, groups the cases into one unit per
TestCase class (a class's tests keep sharing setUpClass state and run in one process), and feeds the units, largest
first, to a pool of worker threads that each run `python -m unittest <ids...>` in a subprocess. The run passes only
when every unit passes AND the testsRun total equals the discovered count (nothing silently dropped).

Env: WARROOM_TEST_JOBS (worker count, default os.cpu_count()), WARROOM_TEST_SHUFFLE=<seed> (shuffle the unit order
instead of the largest-first order, to prove the units are order independent).
"""
from __future__ import annotations

import os
import random
import re
import subprocess
import sys
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


def run_unit(ids):
    proc = subprocess.run([sys.executable, "-m", "unittest", *ids], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, errors="replace")
    ran = re.findall(r"^Ran (\d+) tests? in ", proc.stdout, re.M)
    return proc.returncode, (int(ran[-1]) if ran else None), proc.stdout


def main() -> int:
    jobs = max(1, int(os.environ.get("WARROOM_TEST_JOBS") or os.cpu_count() or 1))
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
            code, ran, out = run_unit(ids)
            ok = code == 0 and ran == len(ids)
            with lock:
                state["ran"] += ran or 0
                if not ok:
                    state["bad"] += 1
                    print(f"\n===== FAILED unit {name} (exit={code}, ran={ran}, expected={len(ids)}) =====\n{out}",
                          flush=True)

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
    sys.exit(main())
