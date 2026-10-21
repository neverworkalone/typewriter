"""Pick the next unfinished, unclaimed 500-record batch for one (method, model).

Follows #860: scan shards in order; a batch is done when master has a
Candidate file with the exact record count; an open PR touching the same
(method, model) file claims it. Corrupt/partial master files are surfaced,
never skipped silently or regenerated.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .shell import Runner

SHARDS = 428
BATCH_SIZE = 500
_CAND = re.compile(r"data/relation-candidates/(\d{3})/\1_(\d{2})_([a-d])_([a-z0-9-]+)\.jsonl$")


class BatchError(Exception):
    pass


@dataclass(frozen=True)
class Batch:
    shard: str
    batch: str
    records: int

    @property
    def stem(self) -> str:
        return f"{self.shard}_{self.batch}"


def _counts(runner: Runner, root, env, ref: str, pathspec: str) -> dict[str, int]:
    res = runner.run(["git", "grep", "-c", "", ref, "--", pathspec], cwd=root, env=env,
                     timeout=120)
    if res.code not in (0, 1):
        raise BatchError(f"git grep {pathspec}: {res.err.strip()}")
    out = {}
    for line in res.out.splitlines():
        path, _, n = line.rpartition(":")
        out[path.removeprefix(f"{ref}:")] = int(n)
    return out


def expected_records(canon: dict[str, int], shard: int, batch: int) -> int:
    total = canon.get(f"data/canonical/stdict-{shard:04d}.jsonl")
    if total is None:
        raise BatchError(f"canonical shard {shard:04d} missing on master")
    return min(max(total - (batch - 1) * BATCH_SIZE, 0), BATCH_SIZE)


def next_batch(runner: Runner, root, env, *, ref: str, method: str, producer: str,
               open_prs: list[dict], owned: set[tuple[str, str]]) -> Batch | None:
    """None means every batch is done/claimed. Raises BatchError on corrupt master data."""
    canon = _counts(runner, root, env, ref, "data/canonical/stdict-*.jsonl")
    done = _counts(runner, root, env, ref,
                   f"data/relation-candidates/*/*_{method}_{producer}.jsonl")
    claimed = set(owned)
    for pr in open_prs:
        for f in pr.get("files") or []:
            m = _CAND.search(f.get("path", ""))
            if m and m.group(3) == method and m.group(4) == producer:
                claimed.add((m.group(1), m.group(2)))
    for s in range(1, SHARDS + 1):
        for b in (1, 2):
            n = expected_records(canon, s, b)
            if n == 0:
                continue
            key = (f"{s:03d}", f"{b:02d}")
            path = f"data/relation-candidates/{key[0]}/{key[0]}_{key[1]}_{method}_{producer}.jsonl"
            if path in done:
                if done[path] != n:
                    raise BatchError(
                        f"{path} has {done[path]} records, expected {n}: corrupt/partial, "
                        "needs owner attention (not regenerating)")
                continue
            if key in claimed:
                continue
            return Batch(key[0], key[1], n)
    return None
