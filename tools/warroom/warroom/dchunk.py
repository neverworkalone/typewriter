"""Stage 1 Method D as serial 25-record chunk runs (Issue #2034; production contract: #1156).

The Supervisor owns everything deterministic: preparing each chunk (`d-chunk-cli prepare`), deciding from the SAVED
files whether a chunk is done, and (in `supervisor.py`) assemble / validate / commit / push / PR. An AI session reads
ONE chunk view and saves it once; a new chunk always starts a new session.

The one source of truth for progress is the contiguous prefix of exactly valid `chunk-NNN.jsonl` files. An exit code,
the `progress._d` file count and an active-chunk record never decide completion. D has its own state semantics: nothing
here reuses Stage 2 `next_action` or Method C's checkpoint (`literary.py`); only execution helpers are shared.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from . import stage2
from .progress import BATCH_RECORDS, D_CHUNK_RECORDS, SCRATCH

METHOD = "d"
CLI = "scripts/relation/d-chunk-cli.mjs"
CONTRACT_CLI = "scripts/relation/candidate-contract.mjs"
# Same whole-prompt-as-one-argv bound as Method C (Linux MAX_ARG_STRLEN 128 KiB, kept clearly below).
INLINE_MAX_PROMPT_BYTES = 100_000
MAX_FIXES = 1   # automatic same-session corrections per chunk (an operator Retry grants one more)
MAX_DIAGNOSTIC_CHARS = 3000
PR_LABEL = "batch"
_CHUNK = re.compile(r"chunk-(\d{3})\.jsonl")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")
_VALID = re.compile(r"Candidate v1 valid: (\d+) records, (\d+) senses, (\d+) candidates, (\d+) empty senses")


class DChunkError(Exception):
    """State that must not advance automatically; the files and the worktree are preserved."""


@dataclass(frozen=True)
class Names:
    directory: str
    active: str
    view: str
    canonical: str
    output: str
    rejected: str
    decisions: str


def names(b) -> Names:
    shard, batch, model = b["shard"], b["batch"], b["producer"]
    directory = f"{SCRATCH}/d-{shard}_{batch}"
    return Names(directory=directory, active=f"{directory}/active-chunk.json", view=f"{directory}/active-chunk.txt",
                 canonical=f"data/canonical/stdict-{int(shard):04d}.jsonl",
                 output=f"data/relation-candidates/{shard}/{shard}_{batch}_d_{model}.jsonl",
                 rejected=f"{directory}/save-rejected.json", decisions=f"{directory}/decisions.txt")


def run_start_key(batch_id: int) -> str:
    return f"d_run_start_{batch_id}"


def fix_key(batch_id: int, chunk_no: int) -> str:
    """Persistent per-chunk count of automatic `d_chunk_fix` runs; only an explicit operator Retry clears it."""
    return f"d_fix_{batch_id}:{chunk_no}"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def cli(runner, env, worktree, *args, timeout: float = 900):
    return runner.run(["node", CLI, *args], cwd=worktree, env=env, timeout=timeout)


# ---- Canonical structure and the verified prefix ---------------------------------------------------------------------
def canonical_batch(worktree, b) -> list[tuple[str, list[str]]]:
    """(record id, [sense ids]) of the batch in Canonical order."""
    path = Path(worktree) / names(b).canonical
    start = (int(b["batch"]) - 1) * BATCH_RECORDS
    out = []
    try:
        with open(path, "rb") as fh:
            for i, line in enumerate(fh):
                if i >= start + BATCH_RECORDS:
                    break
                if i >= start:
                    row = json.loads(line)
                    out.append((row["id"], [s["id"] for s in row["senses"]]))
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise DChunkError(f"Canonical 배치를 읽을 수 없습니다: {e}") from e
    if not out:
        raise DChunkError("Canonical 배치에 record가 없습니다")
    return out


def total_chunks(records: list) -> int:
    return -(-len(records) // D_CHUNK_RECORDS)


def _check_chunk(path: Path, want: list[tuple[str, list[str]]]) -> None:
    """The chunk file holds exactly these records and senses, in order, with Candidate JSON structure only."""
    try:
        rows = [json.loads(line) for line in path.read_bytes().decode("utf-8").split("\n") if line]
    except (OSError, ValueError) as e:
        raise DChunkError(f"{path.name}을 읽거나 파싱할 수 없습니다: {e}") from e
    if len(rows) != len(want):
        raise DChunkError(f"{path.name}의 record 수가 Canonical과 다릅니다 ({len(rows)} / {len(want)})")
    for row, (rid, sids) in zip(rows, want):
        senses = row.get("senses") if isinstance(row, dict) else None
        if not isinstance(row, dict) or set(row) != {"record_id", "senses"} or row["record_id"] != rid \
                or not isinstance(senses, list) or len(senses) != len(sids):
            raise DChunkError(f"{path.name}: record {rid}의 구조·순서가 Canonical과 다릅니다")
        for sense, sid in zip(senses, sids):
            if not isinstance(sense, dict) or set(sense) != {"sense_id", "candidates"} or sense["sense_id"] != sid \
                    or not isinstance(sense["candidates"], list) or any(not isinstance(c, str) for c in sense["candidates"]):
                raise DChunkError(f"{path.name}: record {rid}의 sense {sid} 구조·순서가 올바르지 않습니다")


def verified_prefix(worktree, b) -> tuple[int, int]:
    """(chunks done, total chunks): the longest run chunk-001..K whose every file matches its Canonical records and
    senses exactly. A gap (001 and 003), a stray number, a leftover `.tmp`, or any unreadable/mismatching file is an
    error, never a smaller prefix: the files are preserved for the operator."""
    n = names(b)
    records = canonical_batch(worktree, b)
    total = total_chunks(records)
    folder = Path(worktree) / n.directory
    numbers = []
    try:
        entries = sorted(p.name for p in folder.iterdir()) if folder.is_dir() else []
    except OSError as e:
        raise DChunkError(f"scratch 폴더를 읽을 수 없습니다: {e}") from e
    for name in entries:
        if name.startswith("chunk-") and name.endswith(".tmp"):
            raise DChunkError(f"완성되지 않은 임시 청크 파일이 남아 있습니다: {name}")
        if name.startswith("chunk-"):
            m = _CHUNK.fullmatch(name)
            if not m or not 1 <= int(m.group(1)) <= total:
                raise DChunkError(f"알 수 없거나 범위 밖의 청크 파일입니다: {name}")
            numbers.append(int(m.group(1)))
    done = 0
    while done + 1 in numbers:
        done += 1
    if len(numbers) != done:
        raise DChunkError(f"연속 prefix 뒤에 청크 파일이 있습니다 (연속 {done}개, 존재 {sorted(numbers)})")
    for k in range(1, done + 1):
        _check_chunk(folder / f"chunk-{k:03d}.jsonl", records[(k - 1) * D_CHUNK_RECORDS:k * D_CHUNK_RECORDS])
    return done, total


def chunk_sha(worktree, b, number: int) -> str:
    try:
        return sha256_bytes((Path(worktree) / names(b).directory / f"chunk-{number:03d}.jsonl").read_bytes())
    except OSError as e:
        raise DChunkError(f"청크 {number}을 읽을 수 없습니다: {e}") from e


# ---- prepare / active chunk --------------------------------------------------------------------------------------------
def prepare(runner, env, worktree, b, chunk_no: int, db_path: str, head: str) -> dict:
    """`prepare` for one chunk. SEARCH_FAILED (exit 3) is returned as a result (the Supervisor pauses); other failures raise."""
    n = names(b)
    res = cli(runner, env, worktree, "prepare", "--canonical", n.canonical, "--shard", b["shard"], "--batch", b["batch"],
              "--chunk", str(chunk_no), "--db", db_path, "--model", b["producer"], "--head", head)
    try:
        data = json.loads(res.out)
    except ValueError:
        data = None
    if not isinstance(data, dict) or data.get("status") not in ("READY", "AUTO_COMPLETE", "SEARCH_FAILED"):
        tail = " ".join((res.err or res.out).split())[-300:]
        raise DChunkError(f"d-chunk prepare 실패: {tail}")
    if (data["status"] == "SEARCH_FAILED") == res.ok:
        raise DChunkError("d-chunk prepare의 종료 코드와 상태가 맞지 않습니다")
    if data.get("chunk_no") != chunk_no:
        raise DChunkError("prepare 결과의 청크 번호가 요청과 다릅니다")
    return data


def read_active(worktree, b) -> dict | None:
    """The active record the CLI wrote for this batch, None when there is none; a damaged or foreign one raises."""
    path = Path(worktree) / names(b).active
    if not path.exists():
        return None
    try:
        rec = json.loads(path.read_text("utf-8"))
        ok = (isinstance(rec, dict) and (rec.get("shard"), rec.get("batch"), rec.get("model")) ==
              (b["shard"], b["batch"], b["producer"]) and isinstance(rec.get("chunk_no"), int)
              and isinstance(rec.get("view_sha256"), str) and isinstance(rec.get("git_head"), str)
              and isinstance(rec.get("senses"), list) and rec["senses"]
              and all(isinstance(s, dict) and _ID.fullmatch(str(s.get("sense_id", ""))) for s in rec["senses"]))
    except (OSError, ValueError):
        ok = False
    if not ok:
        raise DChunkError("활성 청크 기록이 손상되었거나 다른 배치/모델의 것입니다")
    return rec


def read_view(worktree, b, rec: dict) -> str:
    """The saved view, proven byte-for-byte to be the one the active record was written for."""
    try:
        data = (Path(worktree) / names(b).view).read_bytes()
    except OSError as e:
        raise DChunkError(f"활성 청크 view를 읽을 수 없습니다: {e}") from e
    if sha256_bytes(data) != rec["view_sha256"]:
        raise DChunkError("활성 청크 view의 SHA-256이 기록과 다릅니다")
    return data.decode("utf-8")


def clear_active(worktree, b) -> None:
    n = names(b)
    for rel in (n.active, n.view, n.rejected):
        (Path(worktree) / rel).unlink(missing_ok=True)
    for stale in (Path(worktree) / n.directory).glob("active-chunk.p*of*.txt"):
        stale.unlink()


def read_rejection(worktree, b, rec: dict) -> dict | None:
    """The CLI's `save` rejection for exactly this active chunk (number and view hash), or None when there is none, it is
    stale/foreign/damaged, or it says the rejection cannot be repaired by re-judging (`stop_and_report`, e.g. a Z
    refused because a recorded search of the record has hits). Only this file decides repairability; no tool log is parsed."""
    try:
        diag = json.loads((Path(worktree) / names(b).rejected).read_text("utf-8"))
    except (OSError, ValueError):
        return None
    if not (isinstance(diag, dict) and diag.get("diagnostic") == "save_rejected" and diag.get("repair_scope") == "decisions"
            and diag.get("chunk_no") == rec["chunk_no"] and diag.get("view_sha256") == rec["view_sha256"]
            and isinstance(diag.get("errors"), list) and diag["errors"] and all(isinstance(e, str) for e in diag["errors"])):
        return None
    try:   # evidence recorded AFTER the rejection (a later failed search) also makes it non-repairable
        for line in (Path(worktree) / names(b).directory / "searches.jsonl").read_text("utf-8").splitlines():
            if line.strip() and json.loads(line).get("status") == "SEARCH_FAILED":
                return None
    except FileNotFoundError:
        pass
    except (OSError, ValueError, AttributeError):
        return None
    return diag


def fix_problem(diag: dict) -> str:
    """The rejection reasons for the fix prompt (bounded; reasons only, no view or search contexts)."""
    text = "\n".join(diag["errors"])
    more = int(diag.get("error_count") or len(diag["errors"])) - len(diag["errors"])
    if more > 0:
        text += f"\n(그 밖에 {more}건)"
    return text[:MAX_DIAGNOSTIC_CHARS]


def delivery(card_bytes: int, view: str) -> str:
    """"inline" when the whole card + view fits one argv element, else "pages" (that chunk only). Never a partial view."""
    return "inline" if card_bytes + len(view.encode("utf-8")) <= INLINE_MAX_PROMPT_BYTES else "pages"


def write_pages(worktree, b, view: str) -> list[str]:
    """Fallback pages (Stage 2's 36,000 byte / 28,000 char pages); joining them equals the view exactly."""
    pages = stage2.chunk_pages(view)
    if "".join(pages) != view:
        raise DChunkError("page 분할 결과가 원본 view와 일치하지 않습니다")
    return stage2.write_pages(worktree, names(b).view, pages)


# ---- deterministic, idempotent finalization ----------------------------------------------------------------------------
def assemble(worktree, b) -> str:
    """Concatenate the verified chunks (all of them) in Canonical order into the formal Candidate file. An existing
    identical file is left alone; an existing different one is never overwritten."""
    done, total = verified_prefix(worktree, b)
    if done != total:
        raise DChunkError(f"모든 청크가 저장되지 않았습니다 ({done}/{total})")
    n = names(b)
    data = b"".join((Path(worktree) / n.directory / f"chunk-{k:03d}.jsonl").read_bytes() for k in range(1, total + 1))
    target = Path(worktree) / n.output
    if target.exists():
        if target.read_bytes() != data:
            raise DChunkError(f"{n.output}이 이미 있고 저장된 청크의 조립 결과와 다릅니다. 덮어쓰지 않고 보존합니다.")
        return n.output
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(target)
    return n.output


def validate(runner, env, worktree, b) -> dict:
    """The one final Candidate v1 check (`candidate-contract.mjs`). A failure is an error to report, never auto-repaired."""
    n = names(b)
    res = runner.run(["node", CONTRACT_CLI, n.canonical, n.output], cwd=worktree, env=env, timeout=900)
    if not res.ok:
        raise DChunkError("Candidate v1 최종 검증 실패 (자동 재작성 없이 보존합니다): "
                          + " ".join((res.err or res.out).split())[-1500:])
    m = _VALID.search(res.out)
    if not m:
        raise DChunkError("Candidate v1 검증 출력에서 records/senses/candidates를 읽을 수 없습니다")
    records, senses, candidates, empty = (int(x) for x in m.groups())
    return {"records": records, "senses": senses, "candidates": candidates, "empty_senses": empty}


def pr_title(label: str, b) -> str:
    return f"[D/{label}] {b['shard']}_{b['batch']}"


def pr_body(label: str, b, coverage: dict) -> str:
    """The real model, shard/batch, counts and validation facts; never #1156, paths, contexts or search logs."""
    return "\n".join([
        "- Method: D", f"- Model: {label}", f"- Shard: {b['shard']}", f"- Batch: {b['batch']}",
        f"- Coverage: {coverage['records']} records / {coverage['senses']} senses",
        f"- Candidates: {coverage['candidates']} ({coverage['empty_senses']} empty senses)",
        "- Source-sense check: 청크별 AI 판독(승인 문어 index read-only 검색). 독립 검증이 아니며 리뷰에서 확인합니다.",
        "- Candidate v1: validated (candidate-contract.mjs)",
        "- Limits: 청크 병렬화 없음; ZERO_HITS/NO_VERIFIED 상세 집계는 포함하지 않습니다.",
    ]) + "\n"
