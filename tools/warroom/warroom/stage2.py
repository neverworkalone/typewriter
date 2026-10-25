"""Stage 2 Relation Admission as one serial War Room process (Issue #1684; data/work contract: #927, #1665).

A Stage 2 unit is a *Part*: 100 canonical records of one Stage 1 batch (5 Parts per batch, 10 per shard; shard 428
Batch 02 has 83 records = 1 Part). One Part = one AI edit run = one PR. It lives in the ordinary `batches` table
under the reserved method `s2` with `batch` = "BB-PP", so launching, session/pin handling, PR watching, review
fixes, Stop/Drain/Retry/Clear and recovery are the Supervisor's existing code.

This module owns only what is new: which Part comes next. A Part is complete only when the exact
`admission-cli verify --shard S --batch B --part P` has succeeded on the latest master (cached in the kv table once it
did, so a finished Part is never re-verified or re-produced). Past file existence or a PR never counts as completion.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from . import batches
from .store import STAGE2_METHOD

METHOD = STAGE2_METHOD
PART_SIZE = 100
_AB_MODELS = ("claude", "codex")   # #927: the six required Stage 1 inputs of a batch are A/B x Claude/Codex plus one C and one D


@dataclass(frozen=True)
class Part:
    shard: str
    batch: str
    part: str
    records: int

    @property
    def key(self) -> str:   # stored in `batches.batch`
        return batch_key(self.batch, self.part)


@dataclass(frozen=True)
class Choice:
    status: str          # part | wait | done | stop
    part: Part | None = None
    note: str = ""


def batch_key(batch: str, part: str) -> str:
    return f"{batch}-{part}"


def split_key(key: str) -> tuple[str, str]:
    """('01', '03') from "01-03"; ValueError for anything else (a Stage 2 row always has this shape)."""
    batch, sep, part = (key or "").partition("-")
    if not sep or not (batch.isdigit() and part.isdigit()):
        raise ValueError(f"Stage 2 배치 키 {key!r}는 'BB-PP' 형식이어야 합니다")
    return batch, part


def label(shard: str, key: str) -> str:
    batch, part = split_key(key)
    return f"Shard {shard} · Batch {batch} · Part {part}"


def part_count(records: int) -> int:
    return math.ceil(records / PART_SIZE)


def ok_key(shard: str, batch: str, part: str | None = None) -> str:
    """kv key recording that an exact verify succeeded on master: a Part, a Batch (part=None) or a shard (batch=None)."""
    if batch is None:
        return f"s2_oks_{shard}"
    return f"s2_okb_{shard}_{batch}" if part is None else f"s2_ok_{shard}_{batch}_{part}"


def inputs_ready(cands: dict[str, int], shard: str, batch: str, records: int) -> bool:
    """The six required Stage 1 Candidate files of this 500-record batch are on the ref with their full record count."""
    have: dict[tuple[str, str], int] = {}
    for path, n in cands.items():
        m = batches._CAND.fullmatch(path)
        if m and (m.group(1), m.group(2)) == (shard, batch):
            have[(m.group(3), m.group(4))] = n
    for method in ("a", "b"):
        if any(have.get((method, who)) != records for who in _AB_MODELS):
            return False
    return all(any(m == method and n == records for (m, _), n in have.items()) for method in ("c", "d"))


def choose(runner, root, env, *, ref: str, sha: str, open_prs: list[dict], verify, kv, pin: str = "") -> Choice:
    """The earliest ready, incomplete Part in canonical order (a pinned shard only, for a Single run).

    `verify(kind, shard, batch, part) -> (ok, tail)` runs the exact admission verify on the latest master; `kv` caches
    its successes. A Part whose Stage 1 inputs are not on master, or whose shard has an open Stage 2 PR, is waited
    for, never skipped by changing the Single shard. Batch and shard verify close out their last Part. Raises
    BatchError / GitError on unreadable master data or an open PR with an unknown file list (never "no PR").
    """
    canon = batches._counts(runner, root, env, ref, "data/canonical/stdict-*.jsonl")
    cands = batches._candidate_counts(runner, root, env, ref)
    occupied: set[str] = set()
    for pr in open_prs:
        occupied |= batches.pr_stage2_shards(pr)
    waiting: list[str] = []
    for s in range(1, batches.SHARDS + 1):
        shard = f"{s:03d}"
        if pin and shard != pin:
            continue
        batches_open = []
        for b in (1, 2):
            records = batches.expected_records(canon, s, b)
            if records == 0:
                continue
            batch = f"{b:02d}"
            parts = [f"{p:02d}" for p in range(1, part_count(records) + 1)]
            for part in parts:
                if kv.get(ok_key(shard, batch, part)):
                    continue
                if not inputs_ready(cands, shard, batch, records):
                    waiting.append(f"{shard}_{batch} Stage 1 입력(6개 Candidate 파일)이 master에 완성되지 않음")
                    break
                if shard in occupied:
                    waiting.append(f"샤드 {shard}에 열린 Stage 2 PR이 있음")
                    break
                ok, _tail = verify("part", shard, batch, part)
                if not ok:
                    return Choice("part", Part(shard, batch, part, min(PART_SIZE, records - (int(part) - 1) * PART_SIZE)))
                kv.set(ok_key(shard, batch, part), sha)
            open_ = any(not kv.get(ok_key(shard, batch, part)) for part in parts)
            batches_open.append(open_)
            if not open_ and not kv.get(ok_key(shard, batch)):
                ok, tail = verify("batch", shard, batch, None)
                if not ok:
                    return Choice("stop", note=f"Batch {shard}_{batch}의 모든 Part가 끝났지만 Batch verify가 실패했습니다: {tail}")
                kv.set(ok_key(shard, batch), sha)
        if batches_open and not any(batches_open) and not kv.get(ok_key(shard, None)):
            ok, tail = verify("shard", shard, None, None)
            if not ok:
                return Choice("stop", note=f"샤드 {shard}의 모든 Part가 끝났지만 shard verify가 실패했습니다: {tail}")
            kv.set(ok_key(shard, None), sha)
    if waiting:
        return Choice("wait", note="; ".join(dict.fromkeys(waiting)))
    return Choice("done", note="더 이상 진행할 Stage 2 Part가 없습니다." if not pin else f"샤드 {pin}의 Stage 2 Part가 모두 완료되었습니다.")

