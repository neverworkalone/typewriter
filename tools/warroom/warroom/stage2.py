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

import hashlib
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path

from . import batches
from .gitops import GitError
from . import progress
from . import prompts
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
class VerifyFailure:
    """A deterministic, reproduced rows/accounting verify failure of a completed Batch/shard (#2154)."""
    kind: str            # batch | shard
    shard: str
    batch: str | None
    sha: str             # the master commit it was reproduced on
    command: str
    family: str          # rows | accounting
    errors: tuple[str, ...]   # the complete, untruncated list
    fingerprint: str

    @property
    def total(self) -> int:
        return len(self.errors)

    @property
    def defect_class(self) -> str:
        return verify_class(self.kind, self.shard, self.batch)

    @property
    def scope(self) -> str:
        return scope_label(self.kind, self.shard, self.batch)


@dataclass(frozen=True)
class Choice:
    status: str          # part | wait | done | stop | verify_failed
    part: Part | None = None
    note: str = ""
    failure: VerifyFailure | None = None


def scope_label(kind: str, shard: str, batch: str | None) -> str:
    return f"{shard}_{batch}" if kind == "batch" else shard


_RELATION_FILE = re.compile(r"data/relations/relation-\d{3}\.jsonl")
_SHARED_VERIFY_INPUTS = ("data/canonical/", "scripts/relation/", "scripts/build/gloss-arrow-reference.mjs",
                         "src/runtime/dictionary-contract.js")


def scope_inputs_changed(paths, shard: str) -> bool:
    """True if any changed path is something `admission-cli verify` for this shard reads (see `choose`)."""
    own = (f"data/relation-drops/drop-{shard}.jsonl", f"data/relation-candidates/{shard}/")
    # verify also loads every OTHER shard's approved Relation file (loadApprovedRelations), so any of them counts
    return any(p.startswith(own + _SHARED_VERIFY_INPUTS) or _RELATION_FILE.fullmatch(p) for p in paths)


def stop_head(kind: str, shard: str, batch: str | None) -> str:
    return (f"Batch {shard}_{batch}의 모든 Part가 끝났지만 Batch verify가 실패했습니다" if kind == "batch"
            else f"샤드 {shard}의 모든 Part가 끝났지만 shard verify가 실패했습니다")


def verify_class(kind: str, shard: str, batch: str | None) -> str:
    """Defect class of the one active block of a verify scope: `stage2-verify-batch-001-01` / `stage2-verify-shard-001`."""
    return f"stage2-verify-batch-{shard}-{batch}" if kind == "batch" else f"stage2-verify-shard-{shard}"


def verify_command(kind: str, shard: str, batch: str | None) -> str:
    return f"node scripts/relation/admission-cli.mjs verify --shard {shard}" + (f" --batch {batch}" if kind == "batch" else "") + " --json"


def fingerprint(kind: str, shard: str, batch: str | None, family: str, errors) -> str:
    """Cause identity: scope + family + the sorted COMPLETE error list. Never the master SHA."""
    text = "\n".join([scope_label(kind, shard, batch), family, *sorted(errors)])
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


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


def checkpoint(worktree, shard: str, key: str):
    """The current Part's validated local checkpoint summary, or None before prepare."""
    return progress.stage2_checkpoint(worktree, shard, key)


def next_action(state: dict | None) -> str:
    """Choose the next producer run or deterministic finalization step from persisted Stage 2 state."""
    if state is None:
        return "chunk"
    if not state["complete"]:
        raise ValueError("Stage 2 checkpoint does not contain the complete Candidate input set")
    if state["pending_chunk"] is not None:
        return "chunk"
    if state["decided"] < state["total"]:
        return "chunk"
    if state.get("optional_review_complete"):
        return "finalize"
    return "complete_optional" if state.get("optional_links", 0) == 0 else "links"


def chunk_saved_since(before: dict | None, after: dict | None) -> bool:
    """True only for one fully saved checkpoint chunk since that AI run started.

    A first run may only prepare an already-accounted or empty Part; otherwise `save-chunk` advances the cursor by
    exactly one. Pending work, incomplete inputs, a merged checkpoint, a changed candidate inventory or a skipped
    cursor fail closed.
    """
    if after is None or not after["complete"] or after["merged"] or after["pending_chunk"] is not None:
        return False
    if before is None:
        return (after["next_chunk_number"] == 2 or
                (after["next_chunk_number"] == 1 and after["decided"] == after["total"]))
    if any(before[k] != after[k] for k in ("shard", "batch", "part", "total")) or \
            not before["complete"] or before["merged"]:
        return False
    return (after["next_chunk_number"] == before["next_chunk_number"] + 1
            and after["decided"] >= before["decided"])


# One chunk-view page must reach the model whole in one tool call. Codex caps a tool call's whole output at 10,000
# tokens, counted as bytes/4, and ignores larger `max_output_tokens`. Claude's Bash shows at most 30,000 characters.
PAGE_MAX_BYTES = 36_000
PAGE_MAX_CHARS = 28_000
CHUNK_VIEW = prompts.CHUNK_VIEW


def chunk_pages(text: str) -> list[str]:
    """Split the compact chunk view at line boundaries into pages that each fit one tool call.

    Joining the pages gives back `text` exactly: nothing is dropped, duplicated or cut mid-line. A single line over
    the page budget raises ValueError so the Supervisor starts no AI run.
    """
    pages, current, size, chars = [], [], 0, 0
    for line in text.splitlines(keepends=True):
        b, c = len(line.encode("utf-8")), len(line)
        if b > PAGE_MAX_BYTES or c > PAGE_MAX_CHARS:
            raise ValueError(f"compact chunk line exceeds one page ({b} bytes): {line[:80]!r}")
        if current and (size + b > PAGE_MAX_BYTES or chars + c > PAGE_MAX_CHARS):
            pages.append("".join(current))
            current, size, chars = [], 0, 0
        current.append(line)
        size, chars = size + b, chars + c
    if current:
        pages.append("".join(current))
    return pages


def page_path(number: int, total: int, view: str = CHUNK_VIEW) -> str:
    return view if total == 1 else view.replace(".txt", f".p{number}of{total}.txt")


def write_pages(worktree, view: str, pages: list[str]) -> list[str]:
    """Write `pages` next to `view` (shared with Method C); returns worktree-relative paths in reading order.

    One page is the view itself. Otherwise `<stem>.p<i>of<n>.txt` files are written, after removing pages of an
    earlier chunk so a stale page can never be read with the current one.
    """
    view_file = Path(worktree) / view
    for stale in view_file.parent.glob(view_file.name.replace(".txt", ".p*of*.txt")):
        stale.unlink()
    paths = [page_path(i, len(pages), view) for i in range(1, len(pages) + 1)]
    if len(pages) > 1:
        for path, page in zip(paths, pages):
            (Path(worktree) / path).write_text(page, "utf-8")
    return paths


DECISIONS = ".warroom-scratch/decisions.txt"
MAX_FIXES = 2   # AI correction runs per fresh `s2_chunk_new` session
MAX_REPAIR_ROUNDS = 4
REPAIR_GROUPS_PER_RUN = 8
REPAIR_ATTEMPTS_PER_PAGE = 2
_ROW = re.compile(r"c(\d+)\s")
_ROW_START = re.compile(r"c\d+(?:\s|$)")
_RELATION_TYPES = r"near|mood|scene|sensory|action|association"
_DECISION_ROW_PATTERN = rf"(?P<alias>c\d+)[ \t]+(?:R[ \t]+(?:{_RELATION_TYPES})\b|D[ \t]+\S)"
_DECISION_ROW = re.compile(rf"^{_DECISION_ROW_PATTERN}$")
_JOINED_DECISION_ROW = re.compile(rf"[ \t]+{_DECISION_ROW_PATTERN}")
_ERROR_ALIAS = re.compile(r"^(c\d+)\b", re.M)
_FENCE = re.compile(r"^\s*```")
_LINK_ROW = re.compile(r"^c\d+\s")
_SENSE_ID = re.compile(r"(?<![A-Za-z0-9_-])[wr]\d+-s[1-9]\d*(?![A-Za-z0-9_-])")
_REVIEW_TUPLE_START = re.compile(r"(?<![\w-])(?P<record>[wr]\d+)[ \t]*,[ \t]*(?P<sense>[wr]\d+-s[1-9]\d*)[ \t]*,[ \t]*")
_REVIEW_PLAIN_TUPLE = re.compile(r"^[^\s,]+[ \t]*,[ \t]*[^\s,]+[ \t]*,[ \t]*")
_REVIEW_PROSE_BOUNDARY = re.compile(r"(?<=[.!?。！？])[ \t]+(?=\S)")


def _review_triplets(text: str) -> list[tuple[str, str, str, int, int]]:
    """Parse structured `(record, sense, candidate)` rows and retain each tuple's source span."""
    found: list[tuple[str, str, str, int, int]] = []

    def add(value: str, start: int, end: int) -> None:
        fields = value.strip().strip("` ").split(",", 2)
        if len(fields) != 3:
            return
        record_id, sense_id, candidate = (field.strip().strip("` ") for field in fields)
        if record_id and sense_id and candidate:
            found.append((record_id, sense_id, candidate, start, end))

    # Whole-tuple code spans, including candidates that themselves contain commas.
    for match in re.finditer(r"`([^`\n]+)`", text):
        add(match.group(1), match.start(), match.end())

    # Three separately quoted fields, e.g. `w1`, `w1-s1`, `a, b`.
    offset = 0
    for line in text.splitlines(keepends=True):
        spans = list(re.finditer(r"`([^`\n]+)`", line))
        for index in range(len(spans) - 2):
            between = (line[spans[index].end():spans[index + 1].start()] +
                       line[spans[index + 1].end():spans[index + 2].start()])
            if re.fullmatch(r"[\s,()]*", between):
                add(",".join(span.group(1) for span in spans[index:index + 3]),
                    offset + spans[index].start(), offset + spans[index + 2].end())
        offset += len(line)

    # Parenthesized tuples. Balance nested candidate parentheses before taking the first two commas.
    for start, char in enumerate(text):
        if char != "(":
            continue
        depth = 1
        for end in range(start + 1, len(text)):
            if text[end] == "(":
                depth += 1
            elif text[end] == ")":
                depth -= 1
                if depth == 0:
                    add(text[start + 1:end], start, end + 1)
                    break

    # Plain numbered/bulleted rows; only a whole row is treated as a tuple.
    offset = 0
    for line in text.splitlines(keepends=True):
        content = line.rstrip("\r\n")
        prefix = re.match(r"^\s*(?:[-*+]\s+|\d+[.)]\s+)", content)
        row_start = prefix.end() if prefix else 0
        row = content[row_start:]
        leading = len(row) - len(row.lstrip())
        row = row.strip()
        row_start += leading
        if row.startswith("(") or "`" in row or row.count(",") < 2:
            offset += len(line)
            continue
        starts = list(_REVIEW_TUPLE_START.finditer(row))
        if len(starts) > 1:
            for index, match in enumerate(starts):
                end = starts[index + 1].start() if index + 1 < len(starts) else len(row)
                boundary = _REVIEW_PROSE_BOUNDARY.search(row, match.end(), end)
                if boundary:
                    end = boundary.start() - 1  # Keep the sentence punctuation in prose.
                candidate = row[match.end():end].strip().rstrip(";| ")
                if candidate:
                    raw_candidate = row[match.end():end]
                    trim_end = len(raw_candidate.rstrip(";| "))
                    found.append((match.group("record"), match.group("sense"), candidate,
                                  offset + row_start + match.start(),
                                  offset + row_start + match.end() + trim_end))
            offset += len(line)
            continue
        if _REVIEW_PLAIN_TUPLE.match(row):
            boundary = _REVIEW_PROSE_BOUNDARY.search(row)
            tuple_end = boundary.start() - 1 if boundary else len(row)
            trimmed = row[:tuple_end].rstrip(".;")
            add(trimmed, offset + row_start, offset + row_start + len(trimmed))
        offset += len(line)
    return found


def _mask_spans(text: str, spans: list[tuple[int, int]]) -> str:
    """Replace tuple spans with spaces while preserving text length, newlines, and all later offsets."""
    if not spans:
        return text
    chars = list(text)
    merged = []
    for start, end in sorted(spans):
        start, end = max(0, start), min(len(chars), end)
        if start >= end:
            continue
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))
        else:
            merged.append((start, end))
    for start, end in merged:
        for index in range(start, end):
            if chars[index] not in "\r\n":
                chars[index] = " "
    return "".join(chars)


def review_events(event_texts: list[str], items: list[dict]) -> dict:
    """Select exact candidate pairs and conservative full-Sense fallbacks across independent review events.

    Returned pairs are validated against the Part's exact record/sense/candidate tuples. Invalid structured rows are
    reported in `unmatched_pairs`; their in-Part Sense is a full-Sense fallback. Any Part Sense mentioned outside a
    recognized tuple span is also a full-Sense fallback, even when the prose describes it as a comparison peer.

    A prose reference without a Sense ID or structured tuple (for example, “also fix this Sense's activities photo”)
    cannot be bound to a source by this parser and remains an explicit known limitation.
    """
    available: set[tuple[str, str, str]] = set()
    for item in items:
        record_id, sense_id = item.get("record_id"), item.get("sense_id")
        for candidate in item.get("candidates", []):
            candidate_text = candidate if isinstance(candidate, str) else candidate.get("text") if isinstance(candidate, dict) else None
            if isinstance(record_id, str) and isinstance(sense_id, str) and isinstance(candidate_text, str):
                available.add((record_id, sense_id, candidate_text))
    in_part_senses = {
        item["sense_id"] for item in items
        if isinstance(item, dict) and isinstance(item.get("sense_id"), str)
    }
    valid = []
    unmatched = []
    full = set()
    mentioned = set()
    for text in event_texts:
        tuples = _review_triplets(text)
        for record, sense, candidate, _start, _end in tuples:
            pair = (record, sense, candidate)
            if pair in available:
                valid.append(pair)
            else:
                unmatched.append(pair)
                if sense in in_part_senses:
                    full.add(sense)
        prose = _mask_spans(text, [(start, end) for _, _, _, start, end in tuples])
        full.update(set(_SENSE_ID.findall(prose)) & in_part_senses)
        mentioned.update(_SENSE_ID.findall(text))
    valid = list(dict.fromkeys(valid))
    unmatched = list(dict.fromkeys(unmatched))
    valid = [pair for pair in valid if pair[1] not in full]
    return {
        "pairs": [{"record_id": record, "source_sense_id": sense, "candidate": candidate}
                  for record, sense, candidate in valid],
        "fallback_sense_ids": sorted(full),
        "unmatched_pairs": [{"record_id": record, "source_sense_id": sense, "candidate": candidate}
                            for record, sense, candidate in unmatched],
        "mentioned_sense_ids": sorted(mentioned),
    }


def review_pairs(text: str, items: list[dict]) -> dict:
    """Backward-compatible one-event wrapper for `review_events`."""
    return review_events([text], items)


def extract_decisions(final_text: str | None, chunk_id: str) -> list[str] | None:
    """The `c<n>` rows of the run's FINAL answer after its last `chunk <chunk_id>` line, or None ("no response").

    Text without that exact current-chunk header (a progress note before an interruption, another chunk's answer) is
    not a response. Prose and a code fence around the rows are ignored; the rows themselves are validated by the CLI.
    """
    if not isinstance(final_text, str):
        return None
    lines = final_text.replace("\r\n", "\n").split("\n")
    starts = [i for i, line in enumerate(lines) if line.strip() == f"chunk {chunk_id}"]
    if not starts:
        return None
    rows = []
    for line in lines[starts[-1] + 1:]:
        if _FENCE.match(line):
            break
        if _ROW.match(line.strip()):
            rows.append(line.strip())
    return rows


def format_problem(final_text: str | None, chunk_id: str) -> str | None:
    """Describe a clearly attempted current-chunk answer that failed the header/row layout parser.

    A current chunk id by itself is not evidence: it must be a structural header at the start of a line, followed by a
    `c<n>` row on that line or on the next nonblank line. Limited Markdown/list decoration around the header is
    tolerated for classification only; the answer is never rewritten or normalized.
    """
    if not isinstance(final_text, str) or extract_decisions(final_text, chunk_id) is not None:
        return None
    lines = final_text.replace("\r\n", "\n").split("\n")
    for i, raw in enumerate(lines):
        line = raw.strip().lstrip(">#*`_~- \t")
        if not line.startswith("chunk "):
            continue
        tail = line[len("chunk "):]
        if not tail.startswith(chunk_id):
            continue
        boundary = tail[len(chunk_id):]
        if boundary and boundary[0].isalnum():
            continue
        remainder = boundary.lstrip(" \t:*`_~")
        if _ROW_START.match(remainder):
            return (f"최종 응답에 현재 청크 {chunk_id}의 판정은 있으나, 독립된 `chunk {chunk_id}` 헤더와 "
                    "한 줄당 하나의 `c<n>` 행 형식이 아닙니다. 같은 세션의 기존 판정 의미를 보존해 형식만 고쳐 재제출하세요.")
        if remainder:
            continue
        for following in lines[i + 1:]:
            next_line = following.strip()
            if not next_line:
                continue
            if _ROW_START.match(next_line):
                return (f"최종 응답에 현재 청크 {chunk_id}의 판정은 있으나, 독립된 `chunk {chunk_id}` 헤더와 "
                        "한 줄당 하나의 `c<n>` 행 형식이 아닙니다. 같은 세션의 기존 판정 의미를 보존해 형식만 고쳐 재제출하세요.")
            break
    return None


def extract_link_decisions(final_text: str | None, digest: str) -> list[str] | None:
    """Rows after this link run's exact digest header, or None when it did not answer this view."""
    if not isinstance(final_text, str):
        return None
    lines = final_text.replace("\r\n", "\n").split("\n")
    header = f"links @{digest}"
    starts = [i for i, line in enumerate(lines) if line.strip() == header]
    if not starts:
        return None
    rows = []
    for line in lines[starts[-1] + 1:]:
        if _FENCE.match(line):
            break
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            rows.append(stripped)
    return rows


def link_format_problem(final_text: str | None, digest: str) -> str | None:
    if extract_link_decisions(final_text, digest) is not None:
        return None
    if not isinstance(final_text, str):
        return "최종 응답이 없어 links digest header를 확인할 수 없습니다. 같은 세션에서 exact header와 후보 행을 다시 제출하세요."
    if "links" in final_text or re.search(r"\bc\d+\b", final_text):
        return (f"최종 응답에 optional-link 판정 시도는 있으나 exact `links @{digest}` header가 없습니다. "
                "같은 세션에서 헤더와 후보별 행만 다시 제출하세요.")
    return None


def links_start_key(batch_id: int) -> str:
    return f"s2_links_start_{batch_id}"


def repair_state_key(batch_id: int) -> str:
    return f"s2_repair_state_{batch_id}"


def repair_run_start_key(batch_id: int) -> str:
    return f"s2_repair_run_start_{batch_id}"


def extract_repair_answer(final_text: str | None, fingerprint_: str) -> dict | None:
    """A self-contained final answer for one exact preflight fingerprint; never parse prose as a decision."""
    if not isinstance(final_text, str):
        return None
    lines = final_text.replace("\r\n", "\n").split("\n")
    header = f"repair @{fingerprint_}"
    starts = [index for index, line in enumerate(lines) if line.strip() == header]
    if len(starts) != 1:
        return None
    body = "\n".join(lines[starts[0] + 1:]).strip()
    if not body:
        raise ValueError("repair answer has no JSON body")
    try:
        result = json.loads(body)
    except ValueError as error:
        raise ValueError(f"repair answer JSON is malformed: {error}") from error
    if not isinstance(result, dict) or set(result) != {"decisions", "peer_adjustments", "unresolved"} \
            or not isinstance(result["decisions"], list) or not isinstance(result["peer_adjustments"], list) \
            or not isinstance(result["unresolved"], list):
        raise ValueError('repair answer must contain exactly "decisions", "peer_adjustments" and "unresolved" arrays')
    return result


def decision_file_state(worktree, chunk_id: str) -> str:
    """Classify the decisions file as `missing`, `current`, or fail-closed `corrupt` for a pending chunk."""
    path = Path(worktree) / DECISIONS
    if not path.exists() and not path.is_symlink():
        return "missing"
    try:
        text = path.read_text("utf-8")
    except (OSError, UnicodeError):
        return "corrupt"
    if not text.strip():
        return "corrupt"
    lines = text.replace("\r\n", "\n").split("\n")
    meaningful = [(i, line.strip()) for i, line in enumerate(lines) if line.strip() and not line.strip().startswith("#")]
    if not meaningful or meaningful[0][1] != f"chunk {chunk_id}":
        return "corrupt"
    header_index = meaningful[0][0]
    for line in lines[header_index + 1:]:
        value = line.strip()
        if value and not value.startswith("#") and not _ROW.match(value):
            return "corrupt"
    return "current"


def decisions_header(worktree) -> str | None:
    """The chunk ID in the first line of the saved decision file, or None (absent, empty or not a header)."""
    try:
        for line in (Path(worktree) / DECISIONS).read_text("utf-8").split("\n"):
            line = line.strip()
            if line and not line.startswith("#"):
                parts = line.split()
                return parts[1] if len(parts) == 2 and parts[0] == "chunk" else None
    except OSError:
        pass
    return None


def write_decisions(worktree, chunk_id: str, rows: list[str]) -> None:
    path = Path(worktree) / DECISIONS
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(f"chunk {chunk_id}\n" + "".join(f"{row}\n" for row in rows), "utf-8")
    tmp.replace(path)


def clear_decisions(worktree) -> None:
    (Path(worktree) / DECISIONS).unlink(missing_ok=True)


def read_rows(worktree) -> list[str]:
    try:
        return [line.strip() for line in (Path(worktree) / DECISIONS).read_text("utf-8").split("\n") if _ROW.match(line.strip())]
    except OSError:
        return []


def alias_of(row: str) -> str:
    return row.split(None, 1)[0]


def error_aliases(diagnostic: str) -> list[str]:
    """The `c<n>` aliases a save-chunk rejection names (errors and missing rows), in order of first mention."""
    return list(dict.fromkeys(_ERROR_ALIAS.findall(diagnostic)))


def joined_decision_rows_problem(rows: list[str]) -> str | None:
    """Short format-only diagnostic when a decision row contains another complete row after horizontal whitespace."""
    malformed = [(row, [] if _DECISION_ROW.fullmatch(row) else
                  [match.group("alias") for match in _JOINED_DECISION_ROW.finditer(row)]) for row in rows]
    malformed = [(row, aliases) for row, aliases in malformed if aliases]
    if not malformed:
        return None
    aliases = list(dict.fromkeys(alias for _, found in malformed for alias in found))
    examples = ", ".join(aliases[:6])
    more = f" 외 {len(aliases) - 6}개" if len(aliases) > 6 else ""
    return (f"현재 청크에서 {len(malformed)}개 판정 행 안에 새 판정 행이 공백으로 이어졌습니다 "
            f"(추가 행 별칭 {len(aliases)}개, 예: {examples}{more}). 줄바꿈만 바로잡고 기존 판정 내용을 보존하세요.")


def compact_fix_diagnostic(diagnostic: str, threshold: int = 6_000) -> str:
    """Collapse only large, repeated relation-field or missing-decision errors, preserving every affected alias."""
    if len(diagnostic) <= threshold:
        return diagnostic
    lines = diagnostic.splitlines()
    first, last = None, None
    groups: dict[str, list[tuple[str, str]]] = {"relation fields": [], "missing decisions": []}
    for index, line in enumerate(lines):
        match = re.match(r"^(c\d+)(?:\s+[^:]+)?:\s+(.*)$", line)
        if not match:
            if re.match(r"^c\d+\b", line):
                return diagnostic
            continue
        alias, detail = match.groups()
        detail, separator, hint = detail.partition("  ->  ")
        detail = re.sub(rf"^{re.escape(alias)}:\s*", "", detail)
        if detail == "relation needs 2, 4 or 5 fields after R":
            group = "relation fields"
        elif detail.startswith("chunk has missing decisions"):
            group = "missing decisions"
        else:
            return diagnostic
        groups[group].append((alias, hint if separator else ""))
        first = index if first is None else first
        last = index
    if first is None or sum(map(len, groups.values())) < 20:
        return diagnostic
    out = lines[:first]
    if groups["relation fields"]:
        rows = groups["relation fields"]
        out.append(f"relation needs 2, 4 or 5 fields after R ({len(rows)} aliases)")
        out.extend(f"{alias}: {hint}" if hint else alias for alias, hint in rows)
        out.append("각 listed R 행의 기존 의미를 보존하고 필요한 필드 수만 바로잡으세요.")
    if groups["missing decisions"]:
        rows = groups["missing decisions"]
        out.append(f"chunk has missing decisions ({len(rows)} aliases)")
        out.extend(f"{alias}: {hint}" if hint else alias for alias, hint in rows)
        out.append("각 listed alias의 누락 판정 행을 추가하고 이미 저장된 정상 행은 바꾸지 마세요.")
    out.extend(lines[last + 1:])
    return "\n".join(out)


def unknown_aliases(diagnostic: str) -> list[str]:
    """Aliases a save-chunk rejection says name no candidate of the chunk (rows that can never be valid)."""
    return list(dict.fromkeys(re.findall(r"^(c\d+): .*names no candidate", diagnostic, re.M)))


def merge_fix(existing: list[str], revised: list[str], allowed: list[str]) -> tuple[list[str], list[str]]:
    """(complete rows, ignored rows): replace or add only the `allowed` aliases; every other existing row is unchanged
    and a revised row outside `allowed` is ignored (the caller logs it)."""
    merged = {alias_of(row): row for row in existing}
    ignored = []
    for row in revised:
        if alias_of(row) in allowed:
            merged[alias_of(row)] = row
        else:
            ignored.append(row)
    return [merged[a] for a in sorted(merged, key=lambda a: int(a[1:]))], ignored


def fixes_used(runs, new_kind: str, fix_kinds: tuple[str, ...]) -> int:
    """Count output-producing fixes after the latest `new_kind` (`runs` newest first, as Store.runs gives them).

    A failed fix is free only when a numeric nonzero exit and an explicitly measured zero output-token count both prove
    that it returned no answer. Unknown exit or usage values conservatively consume one correction opportunity.
    """
    n = 0
    for r in runs:
        if r["kind"] == new_kind:
            break
        if r["kind"] not in fix_kinds:
            continue
        status, output_tokens = r["exit_status"], r["output_tokens"]
        try:
            failed = status is not None and int(status) != 0
        except (TypeError, ValueError):
            failed = False
        n += not (failed and output_tokens == 0)
    return n


def retry_fix_key(batch_id: int) -> str:
    """The one-use explicit owner Retry allowance for a Stage 2 chunk and its recorded session."""
    return f"s2_chunk_retry_fix_{batch_id}"


def run_start_key(batch_id: int) -> str:
    return f"s2_run_start_{batch_id}"


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


def choose(runner, root, env, *, ref: str, sha: str, open_prs: list[dict], verify, kv, pin: str = "",
           outcome=None, blocks=None, changed=None) -> Choice:
    """The earliest ready, incomplete Part in canonical order (a pinned shard only, for a Single run).

    `verify(kind, shard, batch, part) -> (ok, tail)` runs the exact admission verify on the latest master; `kv` caches
    its successes. A Part whose Stage 1 inputs are not on master, or whose shard has an open Stage 2 PR, is waited
    for, never skipped by changing the Single shard. Batch and shard verify close out their last Part. Raises
    BatchError / GitError on unreadable master data or an open PR with an unknown file list (never "no PR").

    Batch/shard close-out (#2154): with `outcome(kind, shard, batch, part) -> VerifyOutcome` a deterministic verify
    failure reproduced on the same SHA becomes `Choice("verify_failed")`, and `blocks` (the Store) holds the one active
    block per scope: while it is current on this SHA the scope waits; a new SHA is re-verified exactly, and only a
    success releases it. Without `outcome` a failure stops the Line as before.

    A cached Batch/shard success is the master SHA it was verified on. On another SHA it stands only while
    `changed(old, new)` shows nothing that verify reads for that shard (any Relation file, its own Drop/Candidate files, canonical
    data, shared verify code); otherwise the exact verify runs again, so a later regression is found and a RELEASED scope
    can fail as a new event. Every shard's Relation file counts, since verify reads all of them.
    """
    diffs: dict[str, list[str] | None] = {}

    def verified(key, shard):
        """True while the scope's cached success still holds on `sha`."""
        old = kv.get(key)
        if not old:
            return False
        if old == sha or changed is None:
            return True
        if old not in diffs:
            try:
                diffs[old] = changed(old, sha)
            except GitError:
                diffs[old] = None   # the old commit is unavailable: unknown, so verify again
        paths = diffs[old]
        if paths is None or scope_inputs_changed(paths, shard):
            return False
        kv.set(key, sha)   # nothing it reads changed: the success carries over to this commit
        return True

    def close(kind, shard, batch):
        """None once the scope's exact verify succeeded (cached), else the Choice that holds the Line."""
        key = ok_key(shard, batch) if kind == "batch" else ok_key(shard, None)
        if outcome is None:
            ok, tail = verify(kind, shard, batch, None)
            if not ok:
                return Choice("stop", note=f"{stop_head(kind, shard, batch)}: {tail}")
            kv.set(key, sha)
            return None
        block = blocks.active_verify(verify_class(kind, shard, batch))
        if block is not None and block["last_sha"] == sha:   # already verified on this exact master: wait, never re-verify
            return Choice("wait", note=f"urgent Issue #{block['issue_number']} 복구 대기" if block["issue_number"]
                          else f"{scope_label(kind, shard, batch)} verify 실패 차단(Issue 등록 대기)")
        first = outcome(kind, shard, batch, None)
        if first.ok:
            if block is not None:
                blocks.release_verify(block["id"], sha, key)
            else:
                kv.set(key, sha)
            return None
        if first.failure is None:
            return Choice("stop", note=f"{stop_head(kind, shard, batch)} (결정적 rows/accounting 실패로 분류되지 않음 — 운영자 확인): {first.tail}")
        again = outcome(kind, shard, batch, None)   # the same SHA must reproduce the same cause
        fps = [fingerprint(kind, shard, batch, o.failure["family"], o.failure["errors"]) if o.failure else None for o in (first, again)]
        if again.ok or fps[0] != fps[1]:
            return Choice("stop", note=f"{stop_head(kind, shard, batch)} (같은 SHA에서 같은 원인으로 재현되지 않음 — 운영자 확인): {again.tail or first.tail}")
        f = first.failure
        return Choice("verify_failed", note=first.tail, failure=VerifyFailure(
            kind, shard, batch, sha, verify_command(kind, shard, batch), f["family"], tuple(f["errors"]), fps[0]))

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
            if not open_ and not verified(ok_key(shard, batch), shard):
                if (held := close("batch", shard, batch)) is not None:
                    return held
        if batches_open and not any(batches_open) and not verified(ok_key(shard, None), shard):
            if (held := close("shard", shard, None)) is not None:
                return held
    if waiting:
        return Choice("wait", note="; ".join(dict.fromkeys(waiting)))
    return Choice("done", note="더 이상 진행할 Stage 2 Part가 없습니다." if not pin else f"샤드 {pin}의 Stage 2 Part가 모두 완료되었습니다.")

