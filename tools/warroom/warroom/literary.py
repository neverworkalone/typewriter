"""Stage 1 Method C as serial chunk runs (Issue #2033; production contract: #1155).

The Supervisor owns everything deterministic: the one-time `init`, rendering the current chunk, deciding whether a
run really finished it, and (in `supervisor.py`) export / commit / push / PR. An AI session only reads ONE chunk view
and submits it; a new chunk always starts a new session, so the context of earlier chunks is never carried forward.

Completion is never taken from an exit code: a chunk is done only when `report --sense-ids` says every one of its
sense ids is done by the CLI's own `senseDone` meaning. Nothing here parses or re-derives that meaning.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path

from . import stage2

METHOD = "c"
SCRATCH = ".warroom-scratch"
ACTIVE = f"{SCRATCH}/c-active-chunk.json"
VIEW = f"{SCRATCH}/c-active-chunk.txt"
CLI = "scripts/relation/literary-context-cli.mjs"
CHUNK_LIMIT = 12
CHUNK_CONTEXTS = 8
# The whole initial prompt (card + chunk view) travels as ONE argv element. Linux caps a single argument at 128 KiB
# (MAX_ARG_STRLEN) and macOS the whole command line at 1 MiB; stay clearly below the smaller one.
INLINE_MAX_PROMPT_BYTES = 100_000
# The CLI's own `senseDone` set (literary-context.mjs). Kept for the in-process sanity check of `report` output only.
DONE_STATUSES = ("ZERO_HITS", "SUBMITTED", "NO_VERIFIED", "SAMPLED_NO_VERIFIED", "DISCOVERED")
_HEADER = re.compile(r"^## ([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) — (.*)$")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")


class LiteraryError(Exception):
    """State that must not advance automatically; the worktree and every record are preserved."""


@dataclass(frozen=True)
class Names:
    checkpoint: str
    canonical: str
    output: str
    submit_prefix: str


def names(b) -> Names:
    shard, batch, model = b["shard"], b["batch"], b["producer"]
    return Names(checkpoint=f"{SCRATCH}/{shard}_{batch}_c_{model}.checkpoint.json",
                 canonical=f"data/canonical/stdict-{int(shard):04d}.jsonl",
                 output=f"data/relation-candidates/{shard}/{shard}_{batch}_c_{model}.jsonl",
                 submit_prefix=f"{SCRATCH}/c-chunk-")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def run_start_key(batch_id: int) -> str:
    return f"c_run_start_{batch_id}"


MAX_RESUBMITS = 2   # same-session repairs of a rejected submit file per chunk


def resubmit_key(batch_id: int) -> str:
    return f"c_resubmit_{batch_id}"


def submit_retryable(worktree, b, chunk_no: int) -> bool:
    """True only when the submit CLI left a diagnostic for this chunk that a local file repair can fix."""
    path = Path(worktree) / f"{names(b).submit_prefix}{chunk_no:03d}.submit.json.diag.json"
    try:
        diag = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return False
    return (isinstance(diag, dict) and diag.get("diagnostic") in ("submit_validation", "candidate_validation")
            and diag.get("repair_scope") != "stop_and_report")


def cli(runner, env, worktree, *args, db: bool = False, timeout: float = 900):
    argv = ["node", CLI, *args]
    return runner.run(argv, cwd=worktree, env=env, timeout=timeout)


def _json(res, what: str) -> dict:
    if not res.ok:
        tail = " ".join((res.err or res.out).split())[-300:]
        raise LiteraryError(f"{what} 실패: {tail}")
    try:
        data = json.loads(res.out)
    except ValueError as e:
        raise LiteraryError(f"{what} 출력이 JSON이 아닙니다") from e
    if not isinstance(data, dict):
        raise LiteraryError(f"{what} 출력 형식이 올바르지 않습니다")
    return data


# ---- initialization / restart binding -------------------------------------------------------------------------
def checkpoint_exists(worktree, b) -> bool:
    return (Path(worktree) / names(b).checkpoint).exists()


def init_checkpoint(runner, env, worktree, b, db_path: str) -> None:
    """Run the CLI `init` exactly once per batch: never over an existing checkpoint (that would erase every submission)."""
    n = names(b)
    if checkpoint_exists(worktree, b):
        raise LiteraryError("checkpoint가 이미 있어 init을 다시 실행하지 않습니다")
    res = cli(runner, env, worktree, "init", "--canonical", n.canonical, "--shard", b["shard"], "--batch", b["batch"],
              "--model", b["producer"], "--db", db_path, "--checkpoint", n.checkpoint)
    _json(res, "literary init")


def summary(runner, env, worktree, b) -> dict:
    """The checkpoint report (batch binding, coverage, output) after the CLI validated the contract."""
    data = _json(cli(runner, env, worktree, "report", "--checkpoint", names(b).checkpoint), "literary report")
    batch = data.get("batch")
    if not isinstance(batch, dict) or (batch.get("shard"), batch.get("batch"), batch.get("model")) != \
            (b["shard"], b["batch"], b["producer"]):
        raise LiteraryError("checkpoint의 batch/model 결속이 현재 배치와 다릅니다")
    return data


def all_done(report: dict) -> bool:
    """Every sense of the batch is done (only the CLI's done statuses remain), with exact record/sense totals."""
    cov = report.get("coverage")
    if not isinstance(cov, dict) or not isinstance(cov.get("sense_statuses"), dict) or not isinstance(cov.get("senses"), int):
        raise LiteraryError("report coverage 형식이 올바르지 않습니다")
    statuses = cov["sense_statuses"]
    return cov["senses"] > 0 and sum(statuses.values()) == cov["senses"] and all(s in DONE_STATUSES for s in statuses)


def unfinished(report: dict) -> dict:
    return {s: n for s, n in report["coverage"]["sense_statuses"].items() if s not in DONE_STATUSES}


def sense_report(runner, env, worktree, b, sense_ids: list[str]) -> dict:
    """`report --sense-ids` for exactly these ids; the answer must cover exactly them, in order."""
    if not sense_ids or len(set(sense_ids)) != len(sense_ids) or not all(_ID.fullmatch(i) for i in sense_ids):
        raise LiteraryError("활성 청크 sense ID 목록이 올바르지 않습니다")
    data = _json(cli(runner, env, worktree, "report", "--checkpoint", names(b).checkpoint, "--sense-ids",
                     ",".join(sense_ids)), "literary report --sense-ids")
    senses = data.get("senses")
    if not isinstance(senses, list) or [s.get("sense_id") for s in senses if isinstance(s, dict)] != sense_ids or \
            any(not isinstance(s.get("done"), bool) for s in senses):
        raise LiteraryError("report --sense-ids 응답이 요청한 sense와 일치하지 않습니다")
    data["all_done"] = all(s["done"] for s in senses)
    return data


# ---- active chunk ----------------------------------------------------------------------------------------------
def view_ids(text: str) -> tuple[list[str], list[str], list[str]]:
    """(sense ids, SEARCH_FAILED ids, UNSEARCHABLE ids) of a rendered view, in order. Items follow the progress header
    and are separated by a blank line before `## `; the ids are re-proven against the checkpoint by `sense_report`."""
    body = text.partition("\n\n")[2]
    ids, failed, unsearchable = [], [], []
    for block in re.split(r"\n\n(?=## )", body):
        m = _HEADER.match(block.split("\n", 1)[0])
        if not m:
            continue
        ids.append(m.group(1))
        if m.group(2) == "SEARCH_FAILED":
            failed.append(m.group(1))
        elif m.group(2) == "UNSEARCHABLE":
            unsearchable.append(m.group(1))
    return ids, failed, unsearchable


def progress_numbers(text: str) -> tuple[int, int, int, int]:
    """(done, total, zero_hit, not_yet_read) from the view's first line."""
    m = re.match(r"batch=\d+_\d+ done=(\d+)/(\d+) zero_hit=(\d+) not_yet_read=(\d+)\n", text)
    if not m:
        raise LiteraryError("chunk view의 진행 헤더를 읽을 수 없습니다")
    return tuple(int(x) for x in m.groups())  # type: ignore[return-value]


def render_chunk(runner, env, worktree, b, db_path: str, sense_ids: list[str] | None = None) -> str:
    """One `chunk` call with the fixed limits; the view is the exact CLI stdout (UTF-8, never trimmed).
    `sense_ids` (a Candidate v1 repair) re-reads exactly those senses with the 16-context maximum."""
    extra = ["--sense-ids", ",".join(sense_ids), "--contexts", "16"] if sense_ids else ["--contexts", str(CHUNK_CONTEXTS)]
    res = cli(runner, env, worktree, "chunk", "--db", db_path, "--checkpoint", names(b).checkpoint, "--limit",
              str(CHUNK_LIMIT), *extra, "--format", "text")
    if not res.ok:
        tail = " ".join((res.err or res.out).split())[-300:]
        raise LiteraryError(f"literary chunk 실패: {tail}")
    if not res.out.startswith("batch="):
        raise LiteraryError("chunk 출력이 text view가 아닙니다")
    return res.out


def checkpoint_sha(worktree, b) -> str:
    try:
        return hashlib.sha256((Path(worktree) / names(b).checkpoint).read_bytes()).hexdigest()
    except OSError as e:
        raise LiteraryError(f"checkpoint를 읽을 수 없습니다: {e}") from e


def checkpoint_head(worktree, b) -> str:
    """The Git HEAD the checkpoint was initialized on (its own `batch.git_head`)."""
    try:
        head = json.loads((Path(worktree) / names(b).checkpoint).read_text("utf-8"))["batch"]["git_head"]
    except (OSError, ValueError, KeyError, TypeError) as e:
        raise LiteraryError(f"checkpoint의 기준 HEAD를 읽을 수 없습니다: {e}") from e
    if not isinstance(head, str) or not re.fullmatch(r"[0-9a-f]{40}", head):
        raise LiteraryError("checkpoint의 기준 HEAD 형식이 올바르지 않습니다")
    return head


def write_active(worktree, b, view: str, ids: list[str], head: str, chunk_no: int, *, repair: bool = False,
                 checkpoint_sha: str | None = None, note: str = "") -> dict:
    """Store the view and the minimal active-chunk record AFTER the view was generated (chunk may advance ZERO_HITS)."""
    wt = Path(worktree)
    (wt / SCRATCH).mkdir(parents=True, exist_ok=True)
    (wt / VIEW).write_bytes(view.encode("utf-8"))
    record = {"chunk_id": f"{b['shard']}-{b['batch']}-{chunk_no:03d}", "chunk_no": chunk_no, "sense_ids": ids,
              "view_sha256": sha256_text(view), "view_bytes": len(view.encode("utf-8")), "git_head": head,
              "shard": b["shard"], "batch": b["batch"], "model": b["producer"]}
    if repair:   # senses already done: the repair is finished only when a later submit changed the checkpoint
        record.update(repair=True, checkpoint_sha=checkpoint_sha, note=note[:600])
    tmp = wt / (ACTIVE + ".tmp")
    tmp.write_text(json.dumps(record, sort_keys=True), "utf-8")
    tmp.replace(wt / ACTIVE)
    return record


def read_active(worktree, b) -> dict | None:
    """The active record bound to this batch, None when there is none; a damaged or foreign one raises."""
    path = Path(worktree) / ACTIVE
    if not path.exists():
        return None
    try:
        rec = json.loads(path.read_text("utf-8"))
        ok = (isinstance(rec, dict) and (rec.get("shard"), rec.get("batch"), rec.get("model")) ==
              (b["shard"], b["batch"], b["producer"]) and isinstance(rec.get("chunk_no"), int)
              and isinstance(rec.get("view_sha256"), str) and isinstance(rec.get("git_head"), str)
              and isinstance(rec.get("sense_ids"), list) and rec["sense_ids"]
              and all(isinstance(i, str) and _ID.fullmatch(i) for i in rec["sense_ids"]))
    except (OSError, ValueError):
        ok = False
    if not ok:
        raise LiteraryError("활성 청크 기록이 손상되었거나 다른 배치/모델의 것입니다")
    return rec


def chunk_finished(runner, env, worktree, b, rec: dict) -> bool:
    """A normal chunk: every sense done. A repair chunk (senses were already done): the checkpoint changed since."""
    if rec.get("repair"):
        if not isinstance(rec.get("checkpoint_sha"), str):
            raise LiteraryError("복구 청크 기록이 손상되었습니다")
        return checkpoint_sha(worktree, b) != rec["checkpoint_sha"]
    return sense_report(runner, env, worktree, b, rec["sense_ids"])["all_done"]


def read_view(worktree, rec: dict) -> str:
    """The saved view, proven byte-for-byte to be the one the active record was written for."""
    try:
        data = (Path(worktree) / VIEW).read_bytes()
    except OSError as e:
        raise LiteraryError(f"활성 청크 view를 읽을 수 없습니다: {e}") from e
    if hashlib.sha256(data).hexdigest() != rec["view_sha256"]:
        raise LiteraryError("활성 청크 view의 SHA-256이 기록과 다릅니다")
    return data.decode("utf-8")


def clear_active(worktree) -> None:
    for rel in (ACTIVE, VIEW):
        (Path(worktree) / rel).unlink(missing_ok=True)
    for stale in (Path(worktree) / SCRATCH).glob("c-active-chunk.p*of*.txt"):
        stale.unlink()


# ---- delivery of the view to the model ---------------------------------------------------------------------------
def delivery(card_bytes: int, view: str) -> str:
    """"inline" when the whole card + view fits one argv element, else "pages" (that chunk only). Never a partial view."""
    return "inline" if card_bytes + len(view.encode("utf-8")) <= INLINE_MAX_PROMPT_BYTES else "pages"


def write_pages(worktree, view: str) -> list[str]:
    """Fallback pages (Stage 2's 36,000 byte / 28,000 char pages); joining them equals the view exactly."""
    pages = stage2.chunk_pages(view)
    if "".join(pages) != view:
        raise LiteraryError("page 분할 결과가 원본 view와 일치하지 않습니다")
    return stage2.write_pages(worktree, VIEW, pages)


# ---- deterministic, idempotent finalization ----------------------------------------------------------------------
PR_LABEL = "batch"


def pr_title(label: str, b) -> str:
    return f"[C/{label}] {b['shard']}_{b['batch']}"


def pr_body(label: str, b, coverage: dict) -> str:
    """Exactly the six production-PR items, from the real export/validate result (never #1155, paths or reports)."""
    return "\n".join([f"- Method: C", f"- Model: {label}", f"- Shard: {b['shard']}", f"- Batch: {b['batch']}",
                      f"- Coverage: {coverage['records']} records / {coverage['senses']} senses",
                      f"- Candidates: {coverage['candidates']}"]) + "\n"


def affected_senses(stderr: str) -> list[str]:
    """Sense ids a Candidate v1 failure points at (`affected.sense_id` / `affected.sense_ids`); [] when it names none."""
    try:
        diag = json.loads(stderr.strip().splitlines()[-1])
        affected = diag.get("affected") or {}
    except (ValueError, IndexError, AttributeError):
        return []
    if diag.get("diagnostic") != "candidate_validation" or not isinstance(affected, dict):
        return []
    ids = affected.get("sense_ids") if isinstance(affected.get("sense_ids"), list) else [affected.get("sense_id")]
    return [i for i in ids if isinstance(i, str) and _ID.fullmatch(i)]


@dataclass
class Export:
    status: str               # ready | repair
    coverage: dict | None = None
    repair_ids: tuple = ()
    candidate_issues: tuple = ()
    candidate_issue_count: int = 0
    diagnostic: str = ""


def ensure_export(runner, env, worktree, b) -> Export:
    """The batch's Candidate file is exported and valid. An already-current output (path/sha match + VALID) is reused;
    otherwise `export` runs once. A Candidate v1 rejection that names senses becomes a repair of exactly those."""
    n = names(b)
    wt = Path(worktree)
    report = summary(runner, env, wt, b)
    if not all_done(report):
        raise LiteraryError(f"모든 sense가 완료되지 않았습니다: {unfinished(report)}")
    out = report.get("output")
    target = wt / n.output
    if isinstance(out, dict) and out.get("state") == "OUTPUT" and out.get("validation_status") == "VALID" \
            and out.get("path") == n.output and target.is_file() \
            and hashlib.sha256(target.read_bytes()).hexdigest() == out.get("sha256"):
        res = cli(runner, env, wt, "validate", "--checkpoint", n.checkpoint, "--canonical", n.canonical,
                  "--candidate", n.output)
        data = _json(res, "literary validate")
        if data.get("status") != "VALID":
            raise LiteraryError("기존 export 산출물의 Candidate v1 검증이 실패했습니다")
        return Export("ready", _coverage(data))
    res = cli(runner, env, wt, "export", "--checkpoint", n.checkpoint, "--canonical", n.canonical, "--output", n.output)
    if not res.ok:
        ids = affected_senses(res.err)
        issue_count, issues = _candidate_content_issues(res.err, ids)
        if ids and issues and issue_count > 0:
            repair_ids = tuple(dict.fromkeys(issue["sense_id"] for issue in issues))
            return Export("repair", repair_ids=repair_ids, candidate_issues=tuple(issues), candidate_issue_count=issue_count,
                          diagnostic=" ".join(res.err.split())[-400:])
        raise LiteraryError("literary export 실패: " + " ".join((res.err or res.out).split())[-300:])
    data = _json(res, "literary export")
    if data.get("status") != "OUTPUT" or not isinstance(data.get("coverage"), dict):
        raise LiteraryError("export 결과가 올바르지 않습니다")
    return Export("ready", _coverage(data["coverage"]))


def _candidate_content_issues(stderr: str, sense_ids: list[str]) -> tuple[int, list[dict]]:
    """Accept only exact source/sense-bound content diagnostics from the shared Candidate v1 validator."""
    try:
        diagnostic = json.loads(stderr.strip().splitlines()[-1])
        affected = diagnostic.get("affected")
        issues = affected.get("candidate_issues") if isinstance(affected, dict) else None
    except (ValueError, IndexError, AttributeError):
        return 0, []
    if diagnostic.get("diagnostic") != "candidate_validation" or not isinstance(issues, list) \
            or not issues:
        return 0, []
    valid = []
    for issue in issues:
        if not isinstance(issue, dict) or not isinstance(issue.get("record_id"), str) \
                or issue.get("canonical_record_id") != issue.get("record_id") \
                or issue.get("sense_id") not in sense_ids \
                or issue.get("kind") not in ("source_lemma_repeat", "thousands_comma_fragment"):
            return 0, []
        valid.append({key: issue[key] for key in ("record_id", "sense_id", "kind")})
    issue_count = affected.get("candidate_issue_count", len(issues))
    if not isinstance(issue_count, int) or isinstance(issue_count, bool) or issue_count < len(issues):
        return 0, []
    return issue_count, valid


def clear_candidates(runner, env, worktree, b, sense_ids: list[str]) -> dict:
    """Persist an empty candidate list for exact source-bound senses, preserving checkpoint evidence."""
    n = names(b)
    data = _json(cli(runner, env, worktree, "clear-candidates", "--checkpoint", n.checkpoint,
                     "--canonical", n.canonical, "--sense-ids", ",".join(sense_ids)),
                 "literary clear-candidates")
    if data.get("status") != "CLEARED" or data.get("senses") != len(sense_ids) \
            or not isinstance(data.get("candidates"), int) or data["candidates"] < 0:
        raise LiteraryError("clear-candidates 결과가 정확한 sense 폴백을 증명하지 않습니다")
    return data


def _coverage(data: dict) -> dict:
    """records/senses/candidates from `export` (records, senses, candidates) or `validate` (recordCount, ...)."""
    pick = ((("records", "senses", "candidates")), (("recordCount", "senseCount", "candidateCount")))
    for keys in pick:
        values = [data.get(k) for k in keys]
        if all(isinstance(v, int) and not isinstance(v, bool) and v >= 0 for v in values):
            return dict(zip(("records", "senses", "candidates"), values))
    raise LiteraryError("export/validate 결과에서 records/senses/candidates를 읽을 수 없습니다")
