"""Read-only observer of a producer's *saved* intermediate progress (Issue #1809).

The Supervisor's existing poll calls `observe`; producers report nothing. Every unit is read from the current
worktree's own (method, model, shard, batch) artifacts and only counted once its writer finished it atomically:

* A/B: `<scratch>/checkpoint.json` (candidate-workbench) lists the chunks; a chunk is done when the formally saved
  `<scratch>/candidates/<chunk.file>` exists (`save-chunk` validates, then renames into place). Existence only.
* C: a `literary-checkpoint-v2/v3` file; a Sense is done under literary-context.mjs `senseDone()` semantics.
* D: `<scratch>/d-<SSS>_<BB>/chunk-NNN.jsonl`, renamed into place by the producer once the whole chunk is
  assembled (see prompts/d.md); a file only counts when its record ids equal that chunk's Canonical ids, in order.

Anything unreadable, unsupported or belonging to another batch/model yields None (shown as unconfirmed), never an estimate.
"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

SCRATCH = ".warroom-scratch"
D_CHUNK_RECORDS = 25
BATCH_RECORDS = 500
AB_CONTRACT = "candidate-workbench-v2"   # the only workbench contract the producer accepts
_AB_KEYS = {"contract", "batch", "source", "chunks"}
_AB_BATCH_KEYS = {"shard", "batch", "method", "model"}
_AB_SOURCE_KEYS = {"canonical_path", "canonical_sha256", "first_record_index", "record_count", "sense_count", "chunk_size"}
C_CONTRACTS = ("literary-checkpoint-v3", "literary-checkpoint-v2")
_SWEEPS = ("1", "2")
_LENSES = ("image", "action", "emotion", "sensation", "scene_situation", "causality", "metaphor_contrast")
_DONE = {"ZERO_HITS", "SUBMITTED", "NO_VERIFIED", "SAMPLED_NO_VERIFIED", "DISCOVERED"}
_D_CHUNK = re.compile(r"chunk-(\d{3})\.jsonl")
_S2_SHARD = re.compile(r"\d{3}\Z")
_S2_BATCH = re.compile(r"(01|02)-(0[1-5])\Z")
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


def _exact(obj, keys) -> bool:
    """A JSON object with exactly these keys (producer's hasExactKeys): a list of the key names is not one."""
    return isinstance(obj, dict) and set(obj) == keys


def _norm(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).split())


def _sense_state(sense: dict) -> str:
    """Port of literary-context.mjs senseState()/currentSenseStatus(): the state of one Sense."""
    sub = sense.get("submission")
    if sub:
        return sub.get("status") or ""
    search = sense.get("search")
    if not search:
        return "PENDING"
    status = search.get("status")
    contexts = sense.get("contexts") or []
    if status in ("SEARCH_FAILED", "UNSEARCHABLE"):
        return status
    if status == "COUNTED":
        return "NO_VERIFIED" if search.get("total_hits") == 0 else "INCOMPLETE"
    if status == "ZERO_HITS":
        return "NO_VERIFIED"
    if status != "SEARCHED":
        return "INCOMPLETE"
    if any(c.get("judgment") == "PENDING" for c in contexts):
        return "INCOMPLETE"
    verified = [c for c in contexts if c.get("judgment") == "VERIFIED"]
    if not verified:
        return "SAMPLED_NO_VERIFIED" if search.get("sampling_complete") and (search.get("remaining_hit_count") or 0) > 0 \
            else "NO_VERIFIED"
    if any(not (c.get("sweeps") or {}).get(s) for c in verified for s in _SWEEPS):
        return "INSPECTED"
    reviews = sense.get("candidate_reviews") or []
    if any(r.get("decision") not in ("KEEP", "REMOVE") for r in reviews):
        return "INSPECTED"
    seen = {r.get("normalized") for r in reviews}
    for c in verified:
        for s in _SWEEPS:
            results = c["sweeps"][s].get("results") or {}
            for lens in _LENSES:
                if any(_norm(x) not in seen for x in results.get(lens) or []):
                    return "INSPECTED"
    return "DISCOVERED"


def _json_files(base: Path, pattern: str) -> list[Path]:
    try:
        return sorted(base.glob(pattern), key=lambda p: p.stat().st_mtime_ns, reverse=True)
    except OSError:
        return []


def _ab(worktree: Path, shard: str, batch: str, method: str, model: str):
    base = worktree / SCRATCH
    for cp in _json_files(base, "*/checkpoint.json") + _json_files(base, "checkpoint.json"):
        try:
            data = _load_json(cp)
            b, chunks = data["batch"], data["chunks"]
            if data.get("contract") != AB_CONTRACT or not _exact(data, _AB_KEYS) or not _exact(b, _AB_BATCH_KEYS) \
                    or not _exact(data["source"], _AB_SOURCE_KEYS) or not isinstance(chunks, list):
                continue
            if (b["shard"], b["batch"], b["method"], str(b["model"]).lower()) != (shard, batch, method, model):
                continue
            files = [c["file"] for c in chunks]
        except (OSError, ValueError, KeyError, TypeError):
            continue
        if not files or any(not isinstance(f, str) or "/" in f or ".." in f for f in files):
            continue
        done = sum(1 for f in files if (cp.parent / "candidates" / f).is_file())
        return "chunks", done, len(files)
    return None


def _c(worktree: Path, shard: str, batch: str, model: str):
    base = worktree / SCRATCH
    for cp in _json_files(base, "*.json"):
        try:
            data = _load_json(cp)
            if not isinstance(data, dict) or data.get("contract") not in C_CONTRACTS:
                continue
            b = data["batch"]
            if (b["shard"], b["batch"], str(b["model"]).lower()) != (shard, batch, model):
                continue
            senses = [s for r in data["records"] for s in r["senses"]]
            done = sum(1 for s in senses if _sense_state(s) in _DONE)
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
        if senses:
            return "senses", done, len(senses)
    return None


def _expected_ids(worktree: Path, shard: str, batch: str):
    """Canonical record ids of this batch (rows[(batch-1)*500:+500] of its shard), read again only if the shard changed."""
    f = worktree / "data/canonical" / f"stdict-{int(shard):04d}.jsonl"
    st = f.stat()
    key, sig = (f, batch), (st.st_mtime_ns, st.st_size)
    hit = _cache.get(key)
    if hit and hit[0] == sig:
        return hit[1]
    start = (int(batch) - 1) * BATCH_RECORDS
    ids = []
    with open(f, "rb") as fh:
        for i, line in enumerate(fh):
            if i >= start + BATCH_RECORDS:
                break
            if i >= start:
                ids.append(json.loads(line)["id"])
    if len(_cache) > 64:
        _cache.clear()
    _cache[key] = (sig, ids)
    return ids


def _d(worktree: Path, shard: str, batch: str):
    try:
        ids = _expected_ids(worktree, shard, batch)
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if not ids:
        return None
    total = -(-len(ids) // D_CHUNK_RECORDS)
    folder = worktree / SCRATCH / f"d-{shard}_{batch}"
    done = 0
    try:
        names = [p for p in folder.iterdir() if _D_CHUNK.fullmatch(p.name)]
    except OSError:
        return None
    for p in names:
        n = int(_D_CHUNK.fullmatch(p.name).group(1))
        if not 1 <= n <= total:
            continue
        want = ids[(n - 1) * D_CHUNK_RECORDS:n * D_CHUNK_RECORDS]
        try:
            with open(p, "rb") as fh:
                got = []
                for line in fh:
                    row = json.loads(line)
                    if not isinstance(row.get("senses"), list):
                        raise ValueError
                    got.append(row["record_id"])
        except (OSError, ValueError, AttributeError, KeyError):
            continue
        if got == want:   # exactly this chunk's Canonical records, in order
            done += 1
    return "chunks", done, total


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
        "pending_chunk": pending["chunk_id"] if pending is not None else None,
        "pending_revision": bool(pending and pending.get("revision") is True),
        "complete": data["complete"], "merged": data["merged"], "decided": decided, "total": total,
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
        if method in ("a", "b"):
            return _ab(wt, shard, batch, method, model)
        if method == "c":
            return _c(wt, shard, batch, model)
        if method == "d":
            return _d(wt, shard, batch)
        if method == "s2":
            return _s2(wt, shard, batch)
    except OSError:
        pass
    return None
