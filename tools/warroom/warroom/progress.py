"""Read-only observer of a producer's *saved* intermediate progress (Issue #1809).

The Supervisor's existing poll calls `observe`; producers report nothing. A Stage 2 Part's progress is read from its
own identity-bound checkpoint in the current worktree. Anything unreadable, unsupported or belonging to another Part
yields None (shown as unconfirmed), never an estimate.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

SCRATCH = ".warroom-scratch"
_S2_SHARD = re.compile(r"\d{3}\Z")
_S2_BATCH = re.compile(r"(01|02)-(0[1-5])\Z")
_S2_TYPE_TIER_POLICY = "source-mirror-v1"
_cache: dict = {}   # (path) -> ((mtime_ns, size), parsed JSON): parse a checkpoint again only when it changed


def _load_json(path: Path):
    st = path.stat()
    sig = (st.st_mtime_ns, st.st_size)
    hit = _cache.get(path)
    if hit and hit[0] == sig:
        return hit[1]
    with open(path, "rb") as fh:
        data = json.loads(fh.read())
    if len(_cache) > 64:
        _cache.clear()
    _cache[path] = (sig, data)
    return data


def stage2_checkpoint(worktree, shard: str, batch_key: str):
    """Read one supported, identity-bound Stage 2 checkpoint from this Part's worktree.

    `None` means it has not been prepared yet. A malformed or mismatched file raises ValueError so a Supervisor
    cannot mistake corruption for a fresh Part. This intentionally validates only the checkpoint structure and
    saved-decision prefix; admission-cli remains authoritative for complete decision semantics.
    """
    match = _S2_BATCH.fullmatch(batch_key or "")
    if not _S2_SHARD.fullmatch(shard or "") or not match:
        raise ValueError("invalid Stage 2 Part identity")
    batch, part = match.groups()
    path = Path(worktree) / SCRATCH / f"relation-admission-{shard}-{batch}-{part}.json"
    try:
        data = _load_json(path)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as e:
        raise ValueError(f"cannot read Stage 2 checkpoint: {e}") from e
    if not isinstance(data, dict) or type(data.get("version")) is not int or data.get("version") != 1 or \
            (data.get("shard"), data.get("batch"), data.get("part")) != (shard, batch, part):
        raise ValueError("unsupported or mismatched Stage 2 checkpoint")
    if data.get("type_tier_policy") not in (None, _S2_TYPE_TIER_POLICY):
        raise ValueError("unsupported Stage 2 Type/Tier direction policy")
    if data.get("base_revision") is not None and (not isinstance(data.get("base_revision"), str)
                                                    or not re.fullmatch(r"[a-f0-9]{40}", data["base_revision"])):
        raise ValueError("malformed Stage 2 base revision")
    if not isinstance(data.get("complete"), bool) or not isinstance(data.get("merged"), bool) or \
            type(data.get("next_chunk_number")) is not int or data["next_chunk_number"] < 1 or \
            not isinstance(data.get("items"), list) or "pending_chunk" not in data:
        raise ValueError("malformed Stage 2 checkpoint")

    total = decided = 0
    seen_senses: set[str] = set()
    for item in data["items"]:
        if not isinstance(item, dict) or not isinstance(item.get("sense_id"), str) or \
                not isinstance(item.get("candidates"), list) or item["sense_id"] in seen_senses:
            raise ValueError("malformed Stage 2 checkpoint source sense")
        seen_senses.add(item["sense_id"])
        pending_seen = False
        seen_candidates: set[str] = set()
        for candidate in item["candidates"]:
            if not isinstance(candidate, dict) or not isinstance(candidate.get("text"), str) or \
                    candidate["text"] in seen_candidates or "decision" not in candidate:
                raise ValueError("malformed Stage 2 checkpoint candidate")
            seen_candidates.add(candidate["text"])
            total += 1
            decision = candidate["decision"]
            if decision is None:
                pending_seen = True
            else:
                if not isinstance(decision, dict) or pending_seen:
                    raise ValueError("Stage 2 decisions are not a saved prefix")
                if candidate.get("already_accounted") is True:
                    if decision.get("disposition") != "existing":
                        raise ValueError("invalid Stage 2 existing-coverage decision")
                elif decision.get("disposition") not in ("relation", "drop"):
                    raise ValueError("invalid Stage 2 saved decision")
                decided += 1

    pending = data["pending_chunk"]
    if pending is not None:
        if not isinstance(pending, dict) or not isinstance(pending.get("chunk_id"), str) or \
                pending["chunk_id"] != f"{shard}-{batch}-{part}-{data['next_chunk_number']:03d}" or \
                type(pending.get("candidate_count")) is not int or pending["candidate_count"] < 1 or \
                not isinstance(pending.get("slices"), list) or not pending["slices"]:
            raise ValueError("malformed Stage 2 pending chunk")
        revision = pending.get("revision") is True
        if set(pending) != ({"chunk_id", "candidate_count", "slices", "revision"} if revision else
                            {"chunk_id", "candidate_count", "slices"}):
            raise ValueError("malformed Stage 2 pending chunk fields")
        slice_senses: set[str] = set()
        count = 0
        by_sense = {item["sense_id"]: item["candidates"] for item in data["items"]}
        for item_slice in pending["slices"]:
            if not isinstance(item_slice, dict) or set(item_slice) != {"sense_id", "start", "end"}:
                raise ValueError("malformed Stage 2 pending slice")
            sense_id, start, end = item_slice["sense_id"], item_slice["start"], item_slice["end"]
            candidates = by_sense.get(sense_id)
            if sense_id in slice_senses or candidates is None or type(start) is not int or \
                    type(end) is not int or start < 0 or end > len(candidates) or end <= start:
                raise ValueError("invalid Stage 2 pending slice")
            slice_senses.add(sense_id)
            first_undecided = next((i for i, c in enumerate(candidates) if c["decision"] is None), -1)
            if revision:
                if end != start + 1 or candidates[start]["decision"] is None:
                    raise ValueError("invalid Stage 2 revision slice")
            elif start != first_undecided:
                raise ValueError("invalid Stage 2 pending decision slice")
            count += end - start
        if count != pending["candidate_count"]:
            raise ValueError("Stage 2 pending count does not match its slices")
    if data["merged"] and (pending is not None or decided != total):
        raise ValueError("incomplete Stage 2 checkpoint is marked merged")
    return {
        "shard": shard, "batch": batch, "part": part, "next_chunk_number": data["next_chunk_number"],
        "base_revision": data.get("base_revision"),
        "type_tier_policy": data.get("type_tier_policy"),
        "pending_chunk": pending["chunk_id"] if pending is not None else None,
        "pending_revision": bool(pending and pending.get("revision") is True),
        "complete": data["complete"], "merged": data["merged"], "decided": decided, "total": total,
        "optional_review_complete": data.get("optional_review_complete") is True,
        "optional_links": sum(
            1 for item in data["items"] for candidate in item["candidates"]
            if candidate.get("already_accounted") is True
            and (candidate.get("decision") or {}).get("disposition") == "existing"
            and any(sense_id not in candidate.get("existing_target_sense_ids", [])
                    and sense_id not in {row.get("target_sense_id") for row in candidate.get("additional_relations", [])}
                    for sense_id in candidate.get("unlinked_target_sense_ids", []))
        ),
        "premerge": data.get("premerge"),
        "amend_revision": data.get("amend_revision", 0),
        "repair_receipts": len(data.get("repair_receipts", [])),
    }


def _s2(worktree: Path, shard: str, batch_key: str):
    try:
        checkpoint = stage2_checkpoint(worktree, shard, batch_key)
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if checkpoint is None or not checkpoint["complete"]:
        return None
    return "candidates", checkpoint["decided"], checkpoint["total"]


def observe(worktree, shard: str, batch: str, method: str, model: str):
    """(kind, done, total) of the saved intermediate progress, or None when it cannot be confirmed."""
    wt, model = Path(worktree), str(model).lower()
    try:
        if method == "s2":
            return _s2(wt, shard, batch)
    except OSError:
        pass
    return None
