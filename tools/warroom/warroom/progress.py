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
    except OSError:
        pass
    return None
