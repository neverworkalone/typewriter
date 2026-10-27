"""Stage 1 A/B as serial 50-record answer-only chunk sessions (Issue #2035 PR B; production contract: #860).

The Supervisor owns everything deterministic: `prepare` (once per batch), the compact chunk view, extracting the AI's
FINAL answer block, `save-chunk --format compact`, deciding from the SAVED files whether a chunk is done, and (in
`supervisor.py`) merge / commit / push / PR. The AI only reads one inlined chunk view and answers; a new chunk always
starts a new session, and only a rejected save of the same chunk resumes that session (at most MAX_TRIES times).

Completion is judged from `candidates/chunk-NNN.jsonl` against the checkpoint's own chunk list and source files, never
from an exit code, a file count or another chunk's file. A/B state semantics are separate from Stage 2 `next_action`
and Method C's checkpoint; only execution helpers are shared.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from .progress import SCRATCH

METHODS = ("a", "b")
CLI = "scripts/relation/candidate-workbench.mjs"
CHUNK_SIZE = 50
MAX_TRIES = 2          # same-session corrections of one chunk after its first answer
PR_LABEL = "batch"
INLINE_MAX_PROMPT_BYTES = 100_000   # whole prompt as one argv element (Linux MAX_ARG_STRLEN 128 KiB, kept well below)
_ALIAS = re.compile(r"\bS[1-9]\d*\b")
_SENSE = re.compile(r"sense_id ([^\s,;:]+)")
_RECORD = re.compile(r"record_id ([^\s,;:]+)")
_FENCE = re.compile(r"^\s*```\w*\s*$")
_VALID = re.compile(r'"recordCount":(\d+),"senseCount":(\d+),"candidateCount":(\d+),"emptySenseCount":(\d+)')


class ABChunkError(Exception):
    """State that must not advance automatically; the files and the worktree are preserved."""


@dataclass(frozen=True)
class Names:
    directory: str
    checkpoint: str
    output: str


def names(b) -> Names:
    shard, batch, method, model = b["shard"], b["batch"], b["method"], b["producer"]
    directory = f"{SCRATCH}/{shard}_{batch}_{method}_{model}"
    return Names(directory=directory, checkpoint=f"{directory}/checkpoint.json",
                 output=f"data/relation-candidates/{shard}/{shard}_{batch}_{method}_{model}.jsonl")


def run_start_key(batch_id: int) -> str:
    return f"ab_run_start_{batch_id}"


def state_key(batch_id: int, chunk_no: int) -> str:
    return f"ab_chunk_{batch_id}_{chunk_no}"


def cli(runner, env, worktree, *args, timeout: float = 900):
    return runner.run(["node", CLI, *args], cwd=worktree, env=env, timeout=timeout)


def _tail(res) -> str:
    return " ".join((res.err or res.out).split())[-1500:]


# ---- checkpoint and the saved chunks -------------------------------------------------------------------------------
def prepare(runner, env, worktree, b) -> dict:
    """Prepare the batch once (50-record chunks). An existing checkpoint is reused as it is, with ITS chunk size."""
    n = names(b)
    args = ["prepare", "--shard", b["shard"], "--batch", b["batch"], "--method", b["method"], "--model", b["producer"],
            "--scratch-dir", n.directory]
    if not (Path(worktree) / n.checkpoint).is_file():
        args += ["--chunk-size", str(CHUNK_SIZE)]
    res = cli(runner, env, worktree, *args)
    if not res.ok:
        raise ABChunkError(f"candidate-workbench prepare 실패: {_tail(res)}")
    return checkpoint(worktree, b)


def checkpoint(worktree, b) -> dict:
    path = Path(worktree) / names(b).checkpoint
    try:
        data = json.loads(path.read_text("utf-8"))
        batch = data["batch"]
        ok = (batch["shard"], batch["batch"], batch["method"], batch["model"]) == (b["shard"], b["batch"], b["method"], b["producer"]) \
            and isinstance(data["chunks"], list) and data["chunks"] and isinstance(data["source"]["chunk_size"], int)
    except (OSError, ValueError, KeyError, TypeError):
        ok = False
    if not ok:
        raise ABChunkError("A/B checkpoint가 없거나 손상되었거나 다른 배치/방식/모델의 것입니다")
    return data


def _read_jsonl(path: Path) -> list:
    try:
        return [json.loads(line) for line in path.read_bytes().decode("utf-8").split("\n") if line]
    except (OSError, ValueError) as e:
        raise ABChunkError(f"{path.name}을 읽거나 파싱할 수 없습니다: {e}") from e


def _chunk_files(worktree, b, chunk: dict) -> tuple[Path, Path]:
    base = Path(worktree) / names(b).directory
    return base / "source" / chunk["file"], base / "candidates" / chunk["file"]


def chunk_saved(worktree, b, chunk: dict) -> bool:
    """True only when the saved file holds exactly this chunk's Canonical record/sense IDs, in order, as Candidate
    rows. Absent: False. Present but wrong: error (preserved), never a smaller count."""
    source, saved = _chunk_files(worktree, b, chunk)
    if not saved.exists():
        return False
    want = _read_jsonl(source)
    rows = _read_jsonl(saved)
    if len(rows) != len(want):
        raise ABChunkError(f"{saved.name}의 record 수가 chunk와 다릅니다 ({len(rows)} / {len(want)})")
    for row, src in zip(rows, want):
        senses = row.get("senses") if isinstance(row, dict) else None
        if not isinstance(row, dict) or set(row) != {"record_id", "senses"} or row["record_id"] != src["id"] \
                or not isinstance(senses, list) or [s.get("sense_id") if isinstance(s, dict) else None for s in senses] \
                != [s["id"] for s in src["senses"]]:
            raise ABChunkError(f"{saved.name}: record {src['id']}의 구조·순서가 Canonical과 다릅니다")
        if any(set(s) != {"sense_id", "candidates"} or not isinstance(s["candidates"], list)
               or any(not isinstance(c, str) for c in s["candidates"]) for s in senses):
            raise ABChunkError(f"{saved.name}: record {src['id']}의 sense 구조가 올바르지 않습니다")
    return True


def next_chunk(worktree, b, cp: dict) -> dict | None:
    """The first chunk of the checkpoint's own order without a valid saved file; None when all are saved."""
    for chunk in cp["chunks"]:
        if not chunk_saved(worktree, b, chunk):
            return chunk
    return None


def chunk_by_number(cp: dict, number: int) -> dict:
    for chunk in cp["chunks"]:
        if chunk["number"] == number:
            return chunk
    raise ABChunkError(f"chunk {number}이 checkpoint에 없습니다")


def chunk_sha(worktree, b, chunk: dict) -> str:
    import hashlib
    try:
        return hashlib.sha256(_chunk_files(worktree, b, chunk)[1].read_bytes()).hexdigest()
    except OSError as e:
        raise ABChunkError(f"chunk {chunk['number']}을 읽을 수 없습니다: {e}") from e


# ---- per-chunk retry state (session, tries, requested aliases): chunk-numbered, never a global slot ------------------
def load_state(store, batch_id: int, chunk_no: int) -> dict:
    raw = store.get(state_key(batch_id, chunk_no))
    try:
        data = json.loads(raw) if raw else {}
    except ValueError:
        data = {}
    return {"sid": data.get("sid"), "tries": int(data.get("tries", 0)), "requested": data.get("requested")}


def save_state(store, batch_id: int, chunk_no: int, state: dict) -> None:
    store.set(state_key(batch_id, chunk_no), json.dumps(state, sort_keys=True))


# ---- the chunk view -------------------------------------------------------------------------------------------------
def view_path(b, chunk_no: int) -> str:
    return f"{names(b).directory}/view-{chunk_no:03d}.txt"


def answer_path(b, chunk_no: int) -> str:
    return f"{names(b).directory}/answer-{chunk_no:03d}.tsv"


def write_view(runner, env, worktree, b, chunk: dict) -> str:
    """The whole compact view, written by the workbench and re-checked here against the chunk's source rows."""
    rel = view_path(b, chunk["number"])
    res = cli(runner, env, worktree, "read-chunk", "--scratch-dir", names(b).directory, "--chunk", str(chunk["number"]),
              "--format", "compact", "--out", rel)
    if not res.ok:
        raise ABChunkError(f"compact view 생성 실패: {_tail(res)}")
    try:
        text = (Path(worktree) / rel).read_text("utf-8")
    except OSError as e:
        raise ABChunkError(f"compact view를 읽을 수 없습니다: {e}") from e
    rows = view_rows(text)
    source, _ = _chunk_files(worktree, b, chunk)
    senses = [(rec["id"], s["id"], s["gloss"]) for rec in _read_jsonl(source) for s in rec["senses"]]
    if len(rows) != len(senses) or len(senses) != chunk["sense_count"] \
            or any(row[0] != f"S{i}" or row[1] != sid or row[5] != gloss for i, (row, (_r, sid, gloss)) in enumerate(zip(rows, senses), 1)):
        raise ABChunkError("compact view가 chunk의 Canonical sense 전수·순서·전체 gloss와 일치하지 않습니다")
    return text


def view_rows(text: str) -> list[list[str]]:
    return [line.split("\t") for line in text.split("\n") if line and not line.startswith(("#", "C\t"))]


def delivery(card_bytes: int, view: str) -> str:
    return "inline" if card_bytes + len(view.encode("utf-8")) <= INLINE_MAX_PROMPT_BYTES else "split"


# ---- the final answer block -------------------------------------------------------------------------------------------
def extract_block(final_text: str | None, chunk_no: int) -> list[str]:
    """The lines between `BEGIN chunk NNN` and `END chunk NNN` of the run's FINAL assistant answer: exactly one pair,
    for the requested chunk, in order. A code fence line is dropped; everything else must be answer lines."""
    if not isinstance(final_text, str) or not final_text.strip():
        raise ABChunkError("최종 assistant 답변이 없습니다")
    begin, end = f"BEGIN chunk {chunk_no:03d}", f"END chunk {chunk_no:03d}"
    lines = final_text.replace("\r\n", "\n").split("\n")
    marks = [(i, line.strip()) for i, line in enumerate(lines) if re.fullmatch(r"(BEGIN|END) chunk \d+", line.strip())]
    if [m[1] for m in marks] != [begin, end]:
        raise ABChunkError(f"최종 답변에 {begin} / {end} 쌍이 정확히 한 번씩 요청 번호로 있어야 합니다 (발견: {[m[1] for m in marks] or '없음'})")
    body = [line for line in lines[marks[0][0] + 1:marks[1][0]] if not _FENCE.match(line)]
    while body and not body[-1].strip():
        body.pop()
    return body


def split_rows(body: list[str]) -> dict[str, str]:
    """alias -> full line; an alias twice or a line without an S<n> alias is a defect the caller reports."""
    rows: dict[str, str] = {}
    for line in body:
        alias = line.split("\t", 1)[0]
        if not re.fullmatch(r"S[1-9]\d*", alias):
            raise ABChunkError(f"답변 줄이 S<n> 별칭으로 시작하지 않습니다: {line[:60]!r}")
        if alias in rows:
            raise ABChunkError(f"별칭 {alias}가 두 번 나왔습니다")
        rows[alias] = line
    return rows


def merge_answer(previous: dict[str, str] | None, requested: list[str] | None, revised: dict[str, str]) -> list[str]:
    """Complete answer lines (alias order) from the earlier answer plus the revised rows. When aliases were requested,
    ONLY those may change and every one must be present; an unrequested alias row is a violation."""
    if previous is None or requested is None:
        merged = dict(revised)
    else:
        extra = sorted(set(revised) - set(requested), key=lambda a: int(a[1:]))
        if extra:
            raise ABChunkError(f"요청하지 않은 별칭 행을 바꿨습니다: {', '.join(extra)}")
        missing = [a for a in requested if a not in revised]
        if missing:
            raise ABChunkError(f"요청한 별칭 행이 없습니다: {', '.join(missing)}")
        merged = {**previous, **revised}
    return [merged[a] for a in sorted(merged, key=lambda a: int(a[1:]))]


def compact_text(chunk_no: int, lines: list[str]) -> str:
    return f"chunk {chunk_no:03d}\n" + "\n".join(lines) + "\n"


def rejected_aliases(message: str, rows: list[list[str]]) -> list[str] | None:
    """The view aliases a save error points at: explicit `S<n>` tokens plus sense_id / record_id tokens mapped through
    the view. None when it names nothing (the whole answer is then asked again)."""
    by_sense = {row[1]: row[0] for row in rows}
    found = set(a for a in _ALIAS.findall(message) if a in {r[0] for r in rows})
    found |= {by_sense[s] for s in _SENSE.findall(message) if s in by_sense}
    for rid in _RECORD.findall(message):
        found |= {row[0] for row in rows if row[1].startswith(rid + "-")}
    return sorted(found, key=lambda a: int(a[1:])) or None


def save(runner, env, worktree, b, chunk: dict, lines: list[str]) -> tuple[bool, str]:
    """Write answer-NNN.tsv and run the existing `save-chunk --format compact`. (ok, diagnostic)."""
    rel = answer_path(b, chunk["number"])
    path = Path(worktree) / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(compact_text(chunk["number"], lines), "utf-8")
    tmp.replace(path)
    res = cli(runner, env, worktree, "save-chunk", "--scratch-dir", names(b).directory, "--chunk", str(chunk["number"]),
              "--format", "compact", "--input", rel)
    return res.ok, _tail(res)


def saved_answer_lines(worktree, b, chunk: dict) -> list[str]:
    """The answer lines equivalent to the saved chunk (used to repair a chunk the final merge points at)."""
    source, saved = _chunk_files(worktree, b, chunk)
    by_sense = {s["sense_id"]: s["candidates"] for row in _read_jsonl(saved) for s in row["senses"]}
    return [f"S{i}" + "".join("\t" + c for c in by_sense[s["id"]])
            for i, s in enumerate((s for rec in _read_jsonl(source) for s in rec["senses"]), 1)]


# ---- merge (final, once) -----------------------------------------------------------------------------------------------
def merge(runner, env, worktree, b) -> dict:
    """The one Candidate v1 batch check. Returns coverage; a failure raises MergeRejected with the chunk it points at."""
    n = names(b)
    res = cli(runner, env, worktree, "merge", "--scratch-dir", n.directory, "--out", n.output)
    if not res.ok:
        raise MergeRejected(_tail(res), res.err or res.out)
    m = _VALID.search(res.out)
    if not m:
        raise ABChunkError("workbench merge 출력에서 records/senses/candidates를 읽을 수 없습니다")
    records, senses, candidates, empty = (int(x) for x in m.groups())
    return {"records": records, "senses": senses, "candidates": candidates, "empty_senses": empty}


class MergeRejected(ABChunkError):
    def __init__(self, summary: str, raw: str):
        super().__init__(f"Candidate v1 최종 검증 실패: {summary}")
        self.raw = raw


def chunk_of_error(cp: dict, raw: str) -> dict | None:
    """The one chunk whose records the merge error names (record_id tokens); None when it names none or several."""
    hits = set()
    ids = {rid: chunk["number"] for chunk in cp["chunks"] for rid in chunk["record_ids"]}
    for token in re.findall(r"[^\s\"',:;()\[\]{}]+", raw):
        if token in ids:
            hits.add(ids[token])
    return chunk_by_number(cp, hits.pop()) if len(hits) == 1 else None


def pr_title(label: str, b) -> str:
    return f"[{b['method'].upper()}/{label}] {b['shard']}_{b['batch']}"


def pr_body(label: str, b, coverage: dict) -> str:
    """The #860 PR form: method, real model, shard/batch, counts. Never #860 itself, paths or scratch contents."""
    return "\n".join([
        f"- Method: {b['method'].upper()}", f"- Model: {label}", f"- Shard: {b['shard']}", f"- Batch: {b['batch']}",
        f"- Coverage: {coverage['records']} records / {coverage['senses']} senses",
        f"- Candidates: {coverage['candidates']} ({coverage['empty_senses']} empty senses)",
        "- Production: 50-record answer-only 청크 세션 (Supervisor가 prepare/save/merge/commit/push/PR 수행)",
        "- Candidate v1: validated (candidate-workbench merge)",
    ]) + "\n"


# ---- review fixes (`fix_new`): the reviewer's fixed list, its exact source rows, and the out-of-list diff ---------------
_TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*")   # the ID alphabet; `/`, spaces and punctuation separate tokens


def _candidate_rows(text: str) -> dict[tuple[str, str], list[str]]:
    out: dict[tuple[str, str], list[str]] = {}
    for line in text.split("\n"):
        if line:
            row = json.loads(line)
            for sense in row["senses"]:
                out[(row["record_id"], sense["sense_id"])] = sense["candidates"]
    return out


def fix_scope(worktree, b, review_text: str) -> tuple[set[tuple[str, str]], str]:
    """The (record_id, sense_id) pairs the review text names (by exact id membership in this batch's Candidate file)
    and a compact source context for them: Canonical lemma / pos / full gloss plus the saved candidates."""
    root = Path(worktree)
    try:
        saved = _candidate_rows((root / names(b).output).read_text("utf-8"))
    except (OSError, ValueError, KeyError) as e:
        raise ABChunkError(f"리뷰 대상 Candidate 파일을 읽을 수 없습니다: {e}") from e
    records = {rid for rid, _ in saved}
    senses = {sid: (rid, sid) for rid, sid in saved}
    tokens = {t for raw in _TOKEN.findall(review_text) for t in (raw, raw.rstrip(".:-_"))}   # "w1-s1." ends a sentence
    allowed = {senses[t] for t in tokens if t in senses}
    for rid in tokens & records:
        allowed |= {key for key in saved if key[0] == rid}
    start = (int(b["batch"]) - 1) * 500
    canonical: dict[str, dict] = {}
    try:
        with open(root / f"data/canonical/stdict-{int(b['shard']):04d}.jsonl", "rb") as fh:
            for i, line in enumerate(fh):
                if i >= start + 500:
                    break
                if i >= start:
                    row = json.loads(line)
                    if row["id"] in {rid for rid, _ in allowed}:
                        canonical[row["id"]] = row
    except (OSError, ValueError, KeyError) as e:
        raise ABChunkError(f"Canonical를 읽을 수 없습니다: {e}") from e
    lines = ["source_context (리뷰가 지목한 sense의 Canonical 근거와 저장 후보; `record_id⇥sense_id⇥표제어⇥품사⇥뜻풀이⇥저장 후보`):"]
    for rid, sid in sorted(allowed):
        record = canonical.get(rid)
        sense = next((s for s in (record or {}).get("senses", []) if s["id"] == sid), None)
        if record and sense:
            lines.append("\t".join([rid, sid, record["lemma"], str(sense.get("pos", "")), sense["gloss"],
                                    " | ".join(saved[(rid, sid)])]))
    if len(lines) == 1:
        lines.append("(리뷰 본문에서 식별된 sense 없음 — 리뷰가 명시한 항목만 직접 따른다)")
    return allowed, "\n".join(lines) + "\n"


def out_of_scope_changes(old_text: str, new_text: str, allowed: set[tuple[str, str]]) -> list[str]:
    """Every (record_id, sense_id) outside `allowed` whose candidates differ between the two Candidate files."""
    old, new = _candidate_rows(old_text), _candidate_rows(new_text)
    return [f"{k[0]}/{k[1]}" for k in sorted(set(old) | set(new)) if k not in allowed and old.get(k) != new.get(k)]
