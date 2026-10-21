"""Pick the next unfinished, unclaimed 500-record batch for one Line.

Follows #860 (A/B), #1155 (C) and #1156 (D): scan shards in order; a batch is done when master has a
Candidate file with the exact record count; an open PR touching the same candidate file claims it.
A/B keep one queue per (method, model). C/D share one queue per method across every model: a file or
open PR of any model completes/claims the batch, so two models never produce the same C/D batch.
Corrupt/partial master files and conflicting C/D files are surfaced, never skipped or regenerated.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from .shell import Runner
from .store import SHARED_QUEUE_METHODS

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


def is_shared_queue(method: str) -> bool:
    return method in SHARED_QUEUE_METHODS


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
    """None means every batch is done/claimed. Raises BatchError on corrupt master data.

    `owned` is what this War Room already holds: the Line's own batches for A/B, every model's for C/D.
    """
    shared = is_shared_queue(method)
    canon = _counts(runner, root, env, ref, "data/canonical/stdict-*.jsonl")
    done_files = _counts(runner, root, env, ref,
                         f"data/relation-candidates/*/*_{method}_{'*' if shared else producer}.jsonl")
    done: dict[tuple[str, str], list[tuple[str, int]]] = {}
    for path, n in done_files.items():
        m = _CAND.search(path)
        if m and m.group(3) == method and (shared or m.group(4) == producer):
            done.setdefault((m.group(1), m.group(2)), []).append((path, n))
    for key, files in done.items():
        if len(files) > 1:   # two models' files for one shared batch: never pick one automatically
            raise BatchError(f"{method.upper()} {key[0]}_{key[1]}에 모델 파일이 {len(files)}개 있습니다 "
                             f"({', '.join(sorted(p for p, _ in files))}): 오너 확인 필요")
    claimed = set(owned)
    for pr in open_prs:
        files = pr.get("files")
        if files is None:   # cannot rule out a duplicate claim
            raise BatchError(f"열린 PR #{pr.get('number')}의 파일 목록을 알 수 없어 중복 점유를 배제할 수 없습니다")
        for f in files:
            m = _CAND.search(f.get("path", ""))
            if m and m.group(3) == method and (shared or m.group(4) == producer):
                claimed.add((m.group(1), m.group(2)))
    for s in range(1, SHARDS + 1):
        for b in (1, 2):
            n = expected_records(canon, s, b)
            if n == 0:
                continue
            key = (f"{s:03d}", f"{b:02d}")
            if key in done:
                path, count = done[key][0]
                if count != n:
                    raise BatchError(
                        f"{path} has {count} records, expected {n}: corrupt/partial, "
                        "needs owner attention (not regenerating)")
                continue
            if key in claimed:
                continue
            return Batch(key[0], key[1], n)
    return None
