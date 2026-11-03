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
import os
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
    canonical: str
    output: str


@dataclass(frozen=True)
class ChunkNames:
    directory: str
    active: str
    view: str
    searches: str
    decisions: str
    rejected: str
    technical_skips: str


def names(b) -> Names:
    shard, batch, model = b["shard"], b["batch"], b["producer"]
    directory = f"{SCRATCH}/d-{shard}_{batch}"
    return Names(directory=directory, canonical=f"data/canonical/stdict-{int(shard):04d}.jsonl",
                 output=f"data/relation-candidates/{shard}/{shard}_{batch}_d_{model}.jsonl")


def chunk_names(b, chunk_no: int) -> ChunkNames:
    if not isinstance(chunk_no, int) or not 1 <= chunk_no <= 999:
        raise DChunkError(f"잘못된 D 청크 번호입니다: {chunk_no}")
    directory = names(b).directory
    number = f"{chunk_no:03d}"
    return ChunkNames(directory=directory, active=f"{directory}/active-{number}.json",
                      view=f"{directory}/view-{number}.txt", searches=f"{directory}/search-{number}.jsonl",
                      decisions=f"{directory}/decision-{number}.txt", rejected=f"{directory}/rejected-{number}.json",
                      technical_skips=f"{directory}/technical-skip-{number}.json")


def run_start_key(batch_id: int) -> str:
    return f"d_run_start_{batch_id}"


def fix_key(batch_id: int, chunk_no: int) -> str:
    """Persistent per-chunk count of automatic `d_chunk_fix` runs; only an explicit operator Retry clears it."""
    return f"d_fix_{batch_id}:{chunk_no}"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def cli(runner, env, worktree, *args, timeout: float = 900):
    return runner.run(["node", CLI, *args], cwd=worktree, env=env, timeout=timeout)


def _json(res, what: str) -> dict:
    if not res.ok:
        tail = " ".join((res.err or res.out).split())[-500:]
        raise DChunkError(f"{what} 실패: {tail}")
    try:
        data = json.loads(res.out)
    except ValueError as e:
        raise DChunkError(f"{what} 출력이 JSON이 아닙니다") from e
    if not isinstance(data, dict):
        raise DChunkError(f"{what} 출력 형식이 올바르지 않습니다")
    return data


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
        expected = records[(k - 1) * D_CHUNK_RECORDS:k * D_CHUNK_RECORDS]
        chunk_path = folder / f"chunk-{k:03d}.jsonl"
        _check_chunk(chunk_path, expected)
        _validate_technical_skip_file(folder / f"technical-skip-{k:03d}.json", chunk_path, expected,
                                      b, k)
    return done, total


def chunk_sha(worktree, b, number: int) -> str:
    try:
        return sha256_bytes((Path(worktree) / names(b).directory / f"chunk-{number:03d}.jsonl").read_bytes())
    except OSError as e:
        raise DChunkError(f"청크 {number}을 읽을 수 없습니다: {e}") from e


def technical_skip_sha(worktree, b, number: int) -> str | None:
    path = Path(worktree) / chunk_names(b, number).technical_skips
    try:
        data = path.read_bytes()
    except FileNotFoundError:
        return None
    except OSError as e:
        raise DChunkError(f"청크 {number} technical skip 증거를 읽을 수 없습니다: {e}") from e
    return sha256_bytes(data)


def _validate_technical_skip_file(path: Path, chunk_path: Path, expected: list[tuple[str, list[str]]], b, number: int) -> list[dict]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text("utf-8"))
        rows = [json.loads(line) for line in chunk_path.read_text("utf-8").splitlines() if line]
    except (OSError, ValueError) as e:
        raise DChunkError(f"{path.name} technical skip 증거를 읽지 못했습니다: {e}") from e
    if not isinstance(data, dict) or data.get("contract") != "d-technical-skips-v1" \
            or data.get("diagnostic") != "save_rejected" \
            or (data.get("shard"), data.get("batch"), data.get("model")) != (b["shard"], b["batch"], b["producer"]) \
            or data.get("chunk_no") != number or not re.fullmatch(r"[a-f0-9]{64}", str(data.get("view_sha256", ""))) \
            or not re.fullmatch(r"[a-f0-9]{40}", str(data.get("git_head", ""))) \
            or not re.fullmatch(r"[a-f0-9]{64}", str(data.get("decisions_sha256", ""))) \
            or not re.fullmatch(r"[a-f0-9]{64}", str(data.get("searches_sha256", ""))) \
            or not isinstance(data.get("error_count"), int) or data["error_count"] < 1 \
            or not isinstance(data.get("fix_attempts"), int) or isinstance(data.get("fix_attempts"), bool) or data["fix_attempts"] < 1 \
            or not isinstance(data.get("skips"), list) or not data["skips"]:
        raise DChunkError(f"{path.name} technical skip 증거의 batch/chunk 계약이 손상되었습니다")
    by_id = {row.get("record_id"): row for row in rows if isinstance(row, dict)}
    expected_senses = dict(expected)
    seen = set()
    for item in data["skips"]:
        if not isinstance(item, dict):
            raise DChunkError(f"{path.name} technical skip record 구조가 손상되었습니다")
        rid = item.get("record_id")
        sense_ids = item.get("sense_ids")
        failed_senses = item.get("failed_sense_ids")
        errors = item.get("errors")
        if (rid not in expected_senses or rid in seen or sense_ids != expected_senses[rid]
                or not isinstance(failed_senses, list) or not failed_senses
                or any(not isinstance(sense_id, str) for sense_id in failed_senses)
                or (isinstance(sense_ids, list) and not set(failed_senses) <= set(sense_ids))
                or not isinstance(errors, list) or not errors or any(not isinstance(error, str) or not error for error in errors)):
            raise DChunkError(f"{path.name} technical skip IDs do not match this Canonical chunk")
        if len(set(failed_senses)) != len(failed_senses):
            raise DChunkError(f"{path.name} technical skip repeats a failed Sense for {rid}")
        failed_set = set(failed_senses)
        row = by_id.get(rid)
        if row is None or any(sense.get("candidates") != [] for sense in row.get("senses", [])
                              if sense.get("sense_id") in failed_set):
            raise DChunkError(f"{path.name} technical skip failed Sense candidates are not empty for {rid}")
        seen.add(rid)
    return data["skips"]


def technical_skip_report(worktree, b) -> dict:
    """Return validated, source-bound technical exclusions for the complete D Candidate batch."""
    done, total = verified_prefix(worktree, b)
    if done != total:
        raise DChunkError(f"technical skip report requires every chunk ({done}/{total})")
    records = canonical_batch(worktree, b)
    folder = Path(worktree) / names(b).directory
    skips = []
    for number in range(1, total + 1):
        expected = records[(number - 1) * D_CHUNK_RECORDS:number * D_CHUNK_RECORDS]
        skips.extend(_validate_technical_skip_file(folder / f"technical-skip-{number:03d}.json",
                                                    folder / f"chunk-{number:03d}.jsonl", expected, b, number))
    return {"records": len(skips), "items": skips}


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
    """Read the sole exact active-NNN record; legacy or ambiguous layouts fail closed and remain untouched."""
    folder = Path(worktree) / names(b).directory
    try:
        entries = {p.name for p in folder.iterdir()} if folder.is_dir() else set()
    except OSError as e:
        raise DChunkError(f"D scratch 폴더를 읽을 수 없습니다: {e}") from e
    legacy = {"active-chunk.json", "active-chunk.txt", "searches.jsonl", "decisions.txt", "save-rejected.json"}
    if entries & legacy or any(re.fullmatch(r"active-chunk\.p\d+of\d+\.txt", name) for name in entries):
        raise DChunkError("기존 D 임시 파일 형식이 남아 있습니다. 자동 이전·삭제 없이 보존하고 수동 확인이 필요합니다.")
    active_files = sorted(name for name in entries if name.startswith("active-"))
    if any(not re.fullmatch(r"active-\d{3}\.json", name) for name in active_files):
        raise DChunkError("D 활성 청크 파일명이 잘못되었습니다. 임시 파일을 보존합니다.")
    if len(active_files) > 1:
        raise DChunkError("D 배치에 활성 청크 메타가 둘 이상 있습니다. 임시 파일을 보존합니다.")
    if not active_files:
        return None
    active_name = active_files[0]
    active_no = int(active_name[7:10])
    if active_no < 1:
        raise DChunkError("활성 D 청크 번호가 범위를 벗어났습니다. 임시 파일을 보존합니다.")
    path = folder / active_name
    try:
        rec = json.loads(path.read_text("utf-8"))
        ok = (isinstance(rec, dict) and (rec.get("shard"), rec.get("batch"), rec.get("model")) ==
              (b["shard"], b["batch"], b["producer"]) and isinstance(rec.get("chunk_no"), int)
              and rec.get("chunk_no") == active_no
              and isinstance(rec.get("view_sha256"), str) and re.fullmatch(r"[a-f0-9]{64}", rec["view_sha256"])
              and isinstance(rec.get("git_head"), str) and re.fullmatch(r"[a-f0-9]{40}", rec["git_head"])
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
        data = (Path(worktree) / chunk_names(b, rec["chunk_no"]).view).read_bytes()
    except OSError as e:
        raise DChunkError(f"활성 청크 view를 읽을 수 없습니다: {e}") from e
    if sha256_bytes(data) != rec["view_sha256"]:
        raise DChunkError("활성 청크 view의 SHA-256이 기록과 다릅니다")
    return data.decode("utf-8")


def clear_active(worktree, b, chunk_no: int) -> None:
    """Remove one verified chunk's scratch, leaving its final chunk-NNN.jsonl and every sibling untouched.

    The active metadata is removed first. If cleanup is interrupted after that, the run baseline and verified output
    identify the saved chunk so the Supervisor can retry the remaining chunk-local cleanup before starting a new session.
    """
    rec = read_active(worktree, b)
    active_matches = rec is not None and rec["chunk_no"] == chunk_no
    if not active_matches:
        done, _total = verified_prefix(worktree, b)
        if done < chunk_no:
            raise DChunkError(f"저장 검증이 끝나지 않은 D 청크 {chunk_no:03d}는 정리할 수 없습니다.")
    n = chunk_names(b, chunk_no)
    folder = Path(worktree) / n.directory
    paths = [Path(worktree) / n.active] if active_matches else []
    paths.extend(Path(worktree) / rel for rel in (n.view, n.searches, n.decisions, n.rejected))
    paths.extend(path for base in (folder / n.view, folder / n.searches, folder / n.decisions,
                                   folder / n.rejected, folder / n.active)
                 for path in folder.glob(base.name + ".tmp"))
    try:
        paths.extend(path for path in folder.iterdir()
                     if re.fullmatch(rf"view-{chunk_no:03d}\.p\d+of\d+\.txt(?:\.tmp)?", path.name))
    except OSError as e:
        raise DChunkError(f"D 청크 {chunk_no:03d} 페이지 파일 목록을 읽지 못했습니다: {e}") from e
    seen = set()
    for path in paths:
        if path in seen:
            continue
        seen.add(path)
        try:
            path.unlink(missing_ok=True)
        except OSError as e:
            raise DChunkError(f"D 청크 {chunk_no:03d} 임시 파일 {path.name} 정리에 실패했습니다: {e}") from e


def read_rejection(worktree, b, rec: dict) -> dict | None:
    """The CLI's `save` rejection for exactly this active chunk (number and view hash), or None when there is none, it is
    stale/foreign/damaged, or it says the rejection cannot be repaired by re-judging (`stop_and_report`, e.g. a Z
    refused because a recorded search of the record has hits). Only this file decides repairability; no tool log is parsed."""
    try:
        diag = json.loads((Path(worktree) / chunk_names(b, rec["chunk_no"]).rejected).read_text("utf-8"))
    except (OSError, ValueError):
        return None
    n = chunk_names(b, rec["chunk_no"])
    try:
        decisions_sha = sha256_bytes((Path(worktree) / n.decisions).read_bytes())
        searches_sha = sha256_bytes((Path(worktree) / n.searches).read_bytes())
    except OSError:
        return None
    if not (isinstance(diag, dict) and diag.get("diagnostic") == "save_rejected" and diag.get("repair_scope") == "decisions"
            and diag.get("chunk_no") == rec["chunk_no"] and diag.get("view_sha256") == rec["view_sha256"]
            and diag.get("git_head") == rec["git_head"]
            and diag.get("decisions_sha256") == decisions_sha and diag.get("searches_sha256") == searches_sha
            and isinstance(diag.get("failed_records"), list) and diag["failed_records"]
            and all(isinstance(item, dict) and isinstance(item.get("record_id"), str)
                    and isinstance(item.get("failed_sense_ids"), list) and item["failed_sense_ids"]
                    and all(isinstance(sense_id, str) for sense_id in item["failed_sense_ids"])
                    and isinstance(item.get("errors"), list) and item["errors"]
                    and all(isinstance(error, str) and error for error in item["errors"]) for item in diag["failed_records"])
            and isinstance(diag.get("errors"), list) and diag["errors"] and all(isinstance(e, str) for e in diag["errors"])):
        return None
    if has_search_failure(worktree, b):
        return None
    return diag


def supervisor_skip(store, runner, env, worktree, b, rec: dict) -> dict:
    """Validate and write D's technical fallback inside War Room using its persisted retry count."""
    owner = store.batch(b["id"])
    if (not owner or owner["method"] != "d" or owner["producer"] != b["producer"]
            or owner["shard"] != b["shard"] or owner["batch"] != b["batch"]
            or Path(owner["worktree"]) != Path(worktree) or owner["session_id"] != b["session_id"]):
        raise DChunkError("D technical skip requires the active War Room-owned batch")
    fix_attempts = int(store.get(fix_key(b["id"], rec["chunk_no"])) or 0)
    diag = read_rejection(worktree, b, rec)
    if diag is None or fix_attempts < MAX_FIXES:
        raise DChunkError("D technical skip lacks an exact current rejection or exhausted fix budget")
    n = chunk_names(b, rec["chunk_no"])
    payload = {"inputPath": str((Path(worktree) / n.decisions).resolve()),
               "root": str((Path(worktree) / SCRATCH).resolve())}
    script = ("import { inspectActiveForSupervisor } from './scripts/relation/d-chunk-cli.mjs';\n"
              "let input = ''; for await (const part of process.stdin) input += part;\n"
              "const result = await inspectActiveForSupervisor(JSON.parse(input));\n"
              "process.stdout.write(JSON.stringify(result) + '\\n');")
    supervisor_root = Path(__file__).resolve().parents[3]
    result = runner.run(["node", "--input-type=module", "-e", script], cwd=supervisor_root, env=env,
                        input=json.dumps(payload), timeout=900)
    inspection = _json(result, "D supervisor read-only inspection")
    failed = inspection.get("failed_records")
    if (inspection.get("status") != "REJECTED" or inspection.get("repair_scope") != "decisions"
            or inspection.get("hit_bearing_z") or inspection.get("search_failed") is not False
            or inspection.get("decisions_sha256") != diag["decisions_sha256"]
            or inspection.get("searches_sha256") != diag["searches_sha256"]
            or inspection.get("error_count") != diag.get("error_count")
            or failed != diag["failed_records"] or not isinstance(inspection.get("rows"), list)):
        raise DChunkError("D read-only inspection differs from the current retryable rejection")
    active = read_active(worktree, b)
    if active is None or active.get("chunk_no") != rec["chunk_no"]:
        raise DChunkError("D active chunk changed during technical fallback")
    rows = inspection["rows"]
    rows_by_id = {row.get("record_id"): row for row in rows if isinstance(row, dict)}
    if len(rows_by_id) != len(rows):
        raise DChunkError("D read-only inspection returned malformed Candidate rows")
    skips = []
    for item in failed:
        row = rows_by_id.get(item["record_id"])
        if row is None or not isinstance(row.get("senses"), list) or not row["senses"]:
            raise DChunkError("D rejected Record is absent from the validated chunk rows")
        skips.append({"record_id": item["record_id"],
                      "sense_ids": [sense["sense_id"] for sense in row["senses"]],
                      "failed_sense_ids": item["failed_sense_ids"], "errors": item["errors"]})
    skip_file = {"contract": "d-technical-skips-v1", "diagnostic": "save_rejected",
                 "shard": active["shard"], "batch": active["batch"], "model": active["model"],
                 "chunk_no": rec["chunk_no"], "view_sha256": rec["view_sha256"], "git_head": rec["git_head"],
                 "fix_attempts": fix_attempts, "decisions_sha256": diag["decisions_sha256"],
                 "searches_sha256": diag["searches_sha256"], "error_count": diag["error_count"], "skips": skips}
    skip_path = Path(worktree) / n.technical_skips
    serialized_skip = json.dumps(skip_file, ensure_ascii=False, separators=(",", ":"))
    if skip_path.exists():
        try:
            existing = json.loads(skip_path.read_text("utf-8"))
        except (OSError, ValueError) as error:
            raise DChunkError("existing D technical skip record is damaged") from error
        if existing != skip_file:
            raise DChunkError("existing D technical skip record differs from this failure")
    else:
        temporary = skip_path.with_name(skip_path.name + ".tmp")
        temporary.write_text(serialized_skip, "utf-8")
        os.replace(temporary, skip_path)
    skipped_senses = {item["record_id"]: set(item["failed_sense_ids"]) for item in failed}
    output_rows = []
    for row in rows:
        row = {"record_id": row["record_id"], "senses": row["senses"]}
        failed_sense_ids = skipped_senses.get(row["record_id"], set())
        if failed_sense_ids:
            row["senses"] = [{"sense_id": sense["sense_id"],
                              "candidates": [] if sense["sense_id"] in failed_sense_ids else sense["candidates"]}
                             for sense in row["senses"]]
        output_rows.append(row)
    output = Path(worktree) / n.directory / f"chunk-{rec['chunk_no']:03d}.jsonl"
    if output.exists():
        raise DChunkError("D chunk became saved before the technical fallback")
    temporary_output = output.with_name(output.name + ".tmp")
    temporary_output.write_text("".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) + "\n"
                                    for row in output_rows), "utf-8")
    os.replace(temporary_output, output)
    prefix, _ = verified_prefix(worktree, b)
    if prefix < rec["chunk_no"]:
        raise DChunkError("D technical fallback output did not validate as the next Candidate chunk")
    return {"status": "SAVED_WITH_TECHNICAL_SKIPS", "chunk_no": rec["chunk_no"], "records": len(rows),
            "technical_skipped_records": len(skips),
            "technical_skips": [{"record_id": item["record_id"], "sense_ids": item["sense_ids"],
                                  "failed_sense_ids": item["failed_sense_ids"], "errors": item["errors"]}
                                 for item in skips]}


def has_search_failure(worktree, b) -> bool:
    """Fail closed when the active D chunk's accumulated search evidence contains SEARCH_FAILED or is unreadable."""
    rec = read_active(worktree, b)
    if rec is None:
        return True
    n = chunk_names(b, rec["chunk_no"])
    try:
        lines = (Path(worktree) / n.searches).read_text("utf-8").splitlines()
    except OSError:
        return True
    try:
        entries = [json.loads(line) for line in lines if line.strip()]
        if any(not isinstance(item, dict) or item.get("chunk_no") != rec["chunk_no"]
               or item.get("view_sha256") != rec["view_sha256"] for item in entries):
            return True
        return any(item.get("status") == "SEARCH_FAILED" for item in entries)
    except (ValueError, AttributeError, TypeError):
        return True


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
    rec = read_active(worktree, b)
    if rec is None:
        raise DChunkError("페이지 분할 전에 활성 D 청크를 확인할 수 없습니다")
    return stage2.write_pages(worktree, chunk_names(b, rec["chunk_no"]).view, pages)


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
    lines = [
        "- Method: D", f"- Model: {label}", f"- Shard: {b['shard']}", f"- Batch: {b['batch']}",
        f"- Coverage: {coverage['records']} records / {coverage['senses']} senses",
        f"- Candidates: {coverage['candidates']} ({coverage['empty_senses']} empty senses)",
        "- Source-sense check: 청크별 AI 판독(승인 문어 index read-only 검색). 독립 검증이 아니며 리뷰에서 확인합니다.",
        "- Candidate v1: validated (candidate-contract.mjs)",
        "- Limits: 청크 병렬화 없음; ZERO_HITS/NO_VERIFIED 상세 집계는 포함하지 않습니다.",
    ]
    skips = coverage.get("technical_skips", [])
    if skips:
        details = ", ".join(f"{item['record_id']} ({len(item['sense_ids'])} senses)" for item in skips)
        lines.append(f"- Technical skips: {len(skips)} records — {details}")
    return "\n".join(lines) + "\n"
