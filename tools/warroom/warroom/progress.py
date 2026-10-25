"""Read-only observer of a producer's *saved* intermediate progress (Issue #1809).

The Supervisor's existing poll calls `observe`; producers report nothing. Every unit is read from the current
worktree's own (method, model, shard, batch) artifacts and only counted once its writer finished it atomically:

* A/B: `<scratch>/checkpoint.json` (candidate-workbench) lists the chunks; a chunk is done when the formally saved
  `<scratch>/candidates/<chunk.file>` exists (`save-chunk` validates, then renames into place). Existence only.
* C: a `literary-checkpoint-v2/v3` file; a Sense is done under literary-context.mjs `senseDone()` semantics.
* D: `<scratch>/d-<SSS>_<BB>/chunk-NNN.jsonl`, renamed into place by the producer once the whole chunk is
  assembled (see prompts/d.md); a file only counts when it holds exactly that chunk's records.

Anything unreadable, unsupported or belonging to another batch/model yields None (shown as unconfirmed), never an estimate.
"""
from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path

SCRATCH = ".warroom-scratch"
D_CHUNK_RECORDS = 25
AB_CONTRACT = "candidate-workbench"   # prefix of the workbench contract id
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
            if not str(data.get("contract", "")).startswith(AB_CONTRACT) or not isinstance(chunks, list):
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


def _d(worktree: Path, shard: str, batch: str, records_total):
    if not records_total or records_total < 1:
        return None
    total = -(-records_total // D_CHUNK_RECORDS)
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
        want = min(D_CHUNK_RECORDS, records_total - (n - 1) * D_CHUNK_RECORDS)
        try:
            ids = []
            with open(p, "rb") as fh:
                for line in fh:
                    row = json.loads(line)
                    if not isinstance(row.get("record_id"), str) or not isinstance(row.get("senses"), list):
                        raise ValueError
                    ids.append(row["record_id"])
        except (OSError, ValueError, AttributeError):
            continue
        if len(ids) == want and len(set(ids)) == want:
            done += 1
    return "chunks", done, total


def observe(worktree, shard: str, batch: str, method: str, model: str, records_total=None):
    """(kind, done, total) of the saved intermediate progress, or None when it cannot be confirmed."""
    wt, model = Path(worktree), str(model).lower()
    try:
        if method in ("a", "b"):
            return _ab(wt, shard, batch, method, model)
        if method == "c":
            return _c(wt, shard, batch, model)
        if method == "d":
            return _d(wt, shard, batch, records_total)
    except OSError:
        pass
    return None
