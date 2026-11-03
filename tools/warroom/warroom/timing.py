"""Small helpers for elapsed wall time shown by the War Room."""
from __future__ import annotations

import time


def elapsed_seconds(runs, now: float | None = None) -> float:
    """Length of the union of recorded run intervals, excluding overlap and gaps.

    A running interval ends at `now`; reversed or zero-length intervals contribute nothing.
    """
    now = time.time() if now is None else now
    intervals = []
    for run in runs:
        started_at = run["started_at"]
        if started_at is None:
            continue
        ended_at = run["ended_at"]
        ended_at = now if ended_at is None else ended_at
        if ended_at > started_at:
            intervals.append((started_at, ended_at))
    if not intervals:
        return 0.0

    intervals.sort()
    start, end = intervals[0]
    elapsed = 0.0
    for next_start, next_end in intervals[1:]:
        if next_start <= end:
            end = max(end, next_end)
        else:
            elapsed += end - start
            start, end = next_start, next_end
    return elapsed + end - start
