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
from .usage import official_c_stop_diagnostics

METHOD = "c"
SCRATCH = ".warroom-scratch"
ACTIVE = f"{SCRATCH}/c-active-chunk.json"
VIEW = f"{SCRATCH}/c-active-chunk.txt"
CLI = "scripts/relation/literary-context-cli.mjs"
SUPERVISOR_CLI = "scripts/relation/literary-context-supervisor-cli.mjs"
CHUNK_LIMIT = 12
MAX_PARALLEL = 4   # chunk sessions of one new batch that may run at the same time (#3076)
CHUNK_CONTEXTS = 8
MAX_CONTEXTS_PER_SENSE = 16
# The whole initial prompt (card + chunk view) travels as ONE argv element. Linux caps a single argument at 128 KiB
# (MAX_ARG_STRLEN) and macOS the whole command line at 1 MiB; stay clearly below the smaller one.
INLINE_MAX_PROMPT_BYTES = 100_000
# The CLI's own `senseDone` set (literary-context.mjs). Kept for the in-process sanity check of `report` output only.
DONE_STATUSES = ("ZERO_HITS", "SUBMITTED", "NO_VERIFIED", "SAMPLED_NO_VERIFIED", "DISCOVERED", "TECHNICAL_SKIPPED")
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
NO_SUBMISSION_RECOVERY_POLICY_VERSION = 1
_REPORTED_STOP = re.compile(
    r"\b(?:SEARCH_FAILED|UNSEARCHABLE|WRITE_FAILED|SUBMIT_FAILED|stop[_ -]and[_ -]report)\b|"
    r"\b(?:truncated|rate[ -]?limit|usage[ -]?limit|quota|context window|token limit)\b|"
    r"검색\s*(?:실패|불가)|출력\s*(?:한도|제한)|(?:중단|멈추고).{0,20}(?:보고|종료)|(?:보고하고|보고한 뒤).{0,12}종료",
    re.IGNORECASE,
)


def reported_stop(final_answer: str | None) -> bool:
    """Legacy guard fingerprint only; free-form assistant text is not authoritative stop evidence."""
    return isinstance(final_answer, str) and _REPORTED_STOP.search(final_answer) is not None


def resubmit_key(batch_id: int) -> str:
    return f"c_resubmit_{batch_id}"


def retry_guard_key(batch_id: int) -> str:
    """Failure evidence for the current C chunk, used to block an unchanged manual Retry."""
    return f"c_retry_guard_{batch_id}"


def no_submission_recovery_key(batch_id: int, chunk_id: str) -> str:
    return f"c_no_submission_recovery_v{NO_SUBMISSION_RECOVERY_POLICY_VERSION}_{batch_id}:{chunk_id}"


def _file_state(path: Path) -> dict | None:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return None
    except OSError as error:
        raise LiteraryError("C retry evidence file is unavailable") from error
    return {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns, "inode": stat.st_ino}


def _task_senses(worktree, b, sense_ids: list[str]) -> dict:
    try:
        data = json.loads((Path(worktree) / names(b).checkpoint).read_text("utf-8"))
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise LiteraryError("task Sense 상태를 읽을 수 없습니다") from error
    if (not isinstance(sense_ids, list) or not sense_ids
            or any(not isinstance(sense_id, str) for sense_id in sense_ids)
            or len(set(sense_ids)) != len(sense_ids)
            or not isinstance(data, dict) or not isinstance(data.get("records"), list)):
        raise LiteraryError("task Sense 상태를 읽을 수 없습니다")
    wanted, found = set(sense_ids), {}
    for record in data["records"]:
        if not isinstance(record, dict) or not isinstance(record.get("senses"), list):
            raise LiteraryError("task Sense 상태를 읽을 수 없습니다")
        for sense in record["senses"]:
            if not isinstance(sense, dict) or not isinstance(sense.get("sense_id"), str):
                raise LiteraryError("task Sense 상태를 읽을 수 없습니다")
            sense_id = sense["sense_id"]
            if sense_id in wanted:
                if sense_id in found:
                    raise LiteraryError("task Sense checkpoint ID가 중복되었습니다")
                found[sense_id] = (record, sense)
    if set(found) != wanted:
        raise LiteraryError("task Sense가 checkpoint에 없습니다")
    return found


def _state_digest(value) -> str:
    return sha256_text(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")))


def _sense_forms(record: dict, sense: dict) -> tuple[list[str], bool]:
    search_forms, added_forms = sense.get("search_forms"), sense.get("added_forms")
    valid = (isinstance(search_forms, list) and all(isinstance(form, str) and form for form in search_forms)
             and isinstance(added_forms, list)
             and all(isinstance(item, dict) and isinstance(item.get("form"), str) and item["form"]
                     for item in added_forms))
    if not valid:
        return [], False
    return sorted(set(search_forms + [item["form"] for item in added_forms])), True


def _shown_state(shown, forms_sha256: str, forms_valid: bool) -> dict:
    valid = shown is None
    count, total_hits, shown_forms = 0, None, None
    if isinstance(shown, dict):
        rowids = shown.get("unit_rowids")
        total_hits, shown_forms = shown.get("total_hits"), shown.get("forms_sha256")
        valid = (set(shown) == {"forms_sha256", "total_hits", "unit_rowids"}
                 and isinstance(shown_forms, str) and re.fullmatch(r"[a-f0-9]{64}", shown_forms) is not None
                 and isinstance(total_hits, int) and not isinstance(total_hits, bool) and total_hits > 0
                 and isinstance(rowids, list) and 1 <= len(rowids) <= 16
                 and all(isinstance(rowid, int) and not isinstance(rowid, bool) and rowid > 0 for rowid in rowids)
                 and len(set(rowids)) == len(rowids)
                 and len(rowids) <= total_hits)
        count = len(rowids) if isinstance(rowids, list) else 0
    elif shown is not None:
        valid = False
    return {"sha256": _state_digest(shown), "valid": valid and (shown is None or forms_valid and shown_forms == forms_sha256),
            "context_count": count, "total_hits": total_hits, "forms_sha256": shown_forms}


def _legacy_own_state(worktree, b, sense_ids: list[str]) -> str:
    """Read the former whole-Sense digest only to keep already-written task Retry guards comparable."""
    found = _task_senses(worktree, b, sense_ids)
    return sha256_text(json.dumps([found[i][1] for i in sorted(found)], sort_keys=True, ensure_ascii=False))


def own_state(worktree, b, sense_ids: list[str]) -> dict:
    """Field-level summary of exactly this task's forms, shown contexts and submission; no candidate content is stored.

    Another task's save changes the checkpoint file but never this summary. Separate fields let no-submit recovery
    recognize a successful context lookup without confusing a form or submission change for useful progress.
    """
    found = _task_senses(worktree, b, sense_ids)
    senses = {}
    for sense_id in sorted(found):
        record, sense = found[sense_id]
        forms, forms_valid = _sense_forms(record, sense)
        forms_sha256 = _state_digest(forms)
        shown = _shown_state(sense.get("shown"), forms_sha256, forms_valid)
        senses[sense_id] = {"forms_sha256": forms_sha256, "forms_valid": forms_valid,
                            "shown": shown, "submission_sha256": _state_digest(sense.get("submission"))}
    return {"version": 1, "senses": senses}


def shown_only_progress(baseline, current) -> list[str] | None:
    """Return Senses whose valid shown-context sample grew while forms and submissions stayed byte-stable."""
    if (not isinstance(baseline, dict) or baseline.get("version") != 1
            or not isinstance(current, dict) or current.get("version") != 1
            or not isinstance(baseline.get("senses"), dict) or not isinstance(current.get("senses"), dict)
            or set(baseline["senses"]) != set(current["senses"])):
        return None
    progressed = []
    for sense_id, before in baseline["senses"].items():
        after = current["senses"].get(sense_id)
        if not isinstance(before, dict) or not isinstance(after, dict):
            return None
        if (before.get("forms_sha256") != after.get("forms_sha256")
                or before.get("submission_sha256") != after.get("submission_sha256")
                or before.get("forms_valid") is not True or after.get("forms_valid") is not True):
            return None
        old_shown, new_shown = before.get("shown"), after.get("shown")
        if not isinstance(old_shown, dict) or not isinstance(new_shown, dict):
            return None
        if old_shown.get("sha256") == new_shown.get("sha256"):
            continue
        if (old_shown.get("valid") is not True or new_shown.get("valid") is not True
                or old_shown.get("context_count", 0) < 1
                or new_shown.get("context_count", 0) <= old_shown.get("context_count", 0)
                or old_shown.get("total_hits") != new_shown.get("total_hits")
                or new_shown.get("forms_sha256") != after.get("forms_sha256")):
            return None
        progressed.append(sense_id)
    return progressed or None


def legacy_shown_only_sample(worktree, b, rec: dict, pending_sense_ids: list[str]) -> bool:
    """Validate the old 16-context ERROR shape whose run-start state only kept a whole-Sense digest."""
    if pending_sense_ids != rec.get("sense_ids"):
        return False
    try:
        view = read_view(worktree, rec, rec["chunk_no"])
        ids, failed, unsearchable = view_ids(view)
        if ids != rec.get("sense_ids") or failed or unsearchable:
            return False
        view_items = {}
        for block in re.split(r"\n\n(?=## )", view.partition("\n\n")[2]):
            match = _HEADER.match(block.split("\n", 1)[0])
            if not match:
                continue
            lines = block.splitlines()
            lemma_match = re.match(r"^(.*?) \[[^\]]+\]$", match.group(2))
            if not lemma_match:
                return False
            lemma = lemma_match.group(1)
            forms = [lemma]
            forms_line = next((line for line in lines if line.startswith("forms: ")), None)
            if forms_line is not None:
                forms = forms_line.removeprefix("forms: ").split(", ")
            hits_line = next((line for line in lines if line.startswith("hits=")), None)
            hits = re.fullmatch(r"hits=(\d+) unseen=(\d+)", hits_line or "")
            if not hits:
                return False
            view_items[match.group(1)] = {"forms": forms, "total_hits": int(hits.group(1)),
                                          "unseen_hits": int(hits.group(2)),
                                          "visible_contexts": sum(1 for line in lines
                                                                   if re.match(r"^\[[A-Za-z0-9]{12}\] ", line))}
        found = _task_senses(worktree, b, pending_sense_ids)
    except (OSError, LiteraryError, ValueError, KeyError, TypeError):
        return False
    reached_cap = False
    for sense_id in pending_sense_ids:
        item = view_items.get(sense_id)
        record, sense = found[sense_id]
        forms, forms_valid = _sense_forms(record, sense)
        shown = _shown_state(sense.get("shown"), _state_digest(forms), forms_valid)
        if (item is None or not forms_valid or forms != item["forms"] or sense.get("submission") is not None
                or sense.get("contexts", []) not in ([], None) or sense.get("candidate_reviews", []) not in ([], None)
                or shown.get("valid") is not True or shown.get("context_count", 0) > 16
                or shown.get("total_hits") != item["total_hits"]
                or shown.get("forms_sha256") != _state_digest(forms)):
            return False
        if (shown.get("context_count") == 16 and item["visible_contexts"] == CHUNK_CONTEXTS
                and item["total_hits"] > 16 and item["unseen_hits"] > 0):
            reached_cap = True
    return reached_cap


def retry_state(worktree, b, rec: dict, pending_sense_ids: list[str], *, session_available: bool,
                task_state: bool = False) -> dict:
    """Compact exact active-chunk recovery state; it avoids re-reading candidate content.
    `task_state` (a parallel task) adds the digest of the task's own Senses, so recovery never depends on the
    whole checkpoint file that other tasks also write."""
    n = names(b)
    submit = Path(worktree) / f"{n.submit_prefix}{rec['chunk_no']:03d}.submit.json"
    diagnostic = submit.with_name(submit.name + ".diag.json")
    state = {"chunk_id": rec.get("chunk_id"), "chunk_no": rec["chunk_no"],
             "view_sha256": rec.get("view_sha256"), "repair": rec.get("repair") is True,
             "pending_sense_ids": list(pending_sense_ids), "session_available": bool(session_available),
             "checkpoint": _file_state(Path(worktree) / n.checkpoint),
             "submit": _file_state(submit), "diagnostic": _file_state(diagnostic)}
    if task_state:
        state["own_state"] = own_state(worktree, b, rec["sense_ids"])
    return state


def task_retry_unchanged(worktree, b, chunk_no: int, baseline: dict, *, session_available: bool) -> bool:
    """Cheap Retry gate of one failed parallel task: unchanged when its view, submit/diagnostic files and OWN Sense
    state are as at the failure (the whole checkpoint file is never compared). Damaged evidence stays blocked."""
    if not isinstance(baseline.get("own_state"), (str, dict)):
        return True
    try:
        rec = read_active(worktree, b, chunk_no)
        if (rec is None or rec.get("chunk_id") != baseline.get("chunk_id")
                or rec.get("view_sha256") != baseline.get("view_sha256")):
            return True
        current = retry_state(worktree, b, rec, baseline.get("pending_sense_ids", []),
                              session_available=session_available, task_state=True)
        keys = ("chunk_id", "chunk_no", "view_sha256", "repair", "session_available", "submit", "diagnostic", "own_state")
        for key in keys:
            if key == "own_state" and isinstance(baseline.get(key), str):
                if _legacy_own_state(worktree, b, rec["sense_ids"]) != baseline[key]:
                    return False
            elif current.get(key) != baseline.get(key):
                return False
        return True
    except (LiteraryError, OSError, ValueError, KeyError, TypeError):
        return True


def retry_guard_unchanged_fast(worktree, b, guard: dict, *, session_available: bool) -> bool:
    """Cheap UI/control gate. The Supervisor verifies the full pending-sense state before launching."""
    try:
        baseline = guard.get("baseline")
        if not isinstance(baseline, dict):
            return True
        rec = read_active(worktree, b)
        if (rec is None or rec.get("chunk_no") != baseline.get("chunk_no")
                or rec.get("chunk_id") != baseline.get("chunk_id")
                or rec.get("view_sha256") != baseline.get("view_sha256")):
            return True
        current = retry_state(worktree, b, rec, baseline.get("pending_sense_ids", []),
                              session_available=session_available)
        keys = ("chunk_id", "chunk_no", "view_sha256", "repair", "session_available", "checkpoint", "submit", "diagnostic")
        return all(current.get(key) == baseline.get(key) for key in keys)
    except (LiteraryError, OSError, ValueError, KeyError, TypeError):
        return True   # missing or damaged evidence never enables another production run


def retry_state_same(current: dict, baseline: dict) -> bool:
    """Compare semantic progress and local recovery evidence; ignore checkpoint timestamp-only rewrites."""
    keys = ("chunk_id", "chunk_no", "view_sha256", "repair", "pending_sense_ids", "session_available",
            "submit", "diagnostic")
    if not all(current.get(key) == baseline.get(key) for key in keys):
        return False
    return not baseline.get("repair") or current.get("checkpoint") == baseline.get("checkpoint")


def no_submission_result(worktree, b, rec: dict | None, run: dict | None, run_start: dict | None,
                         pending_sense_ids: list[str], *, final_answer: str | None,
                         submit_call_count: int | None, task_session: str | None = None,
                         own_state_now: dict | None = None) -> dict:
    """Classify an ended C chunk without reading or storing candidate content.

    A recoverable no-submission result requires a successful, session-bound run; unchanged checkpoint and active
    view; no submit/diagnostic artifacts; and a recognized adapter log proving zero official submit calls. Stop
    decisions come from the CLI's structured result or the exact failed submit-file writer marker, never answer prose.

    A parallel task passes its own `task_session` and `own_state_now`: the run's session is compared with the task's,
    and "unchanged" means the task's own Senses (forms/shown/submission), never the whole checkpoint file that other
    tasks save concurrently.
    """
    task_mode = own_state_now is not None
    if not isinstance(b, dict):
        b = dict(b)
    if rec is None or rec.get("repair") is True or not isinstance(run, dict):
        return {"status": "not_applicable"}
    if run.get("kind") not in ("c_chunk_new", "c_chunk_resume", "c_chunk_recovery"):
        return {"status": "not_applicable"}
    if str(run.get("exit_status")) != "0":
        return {"status": "run_not_successful"}
    expected_session = task_session if task_mode else b.get("session_id")
    if run.get("session_id") != expected_session or not run.get("session_id"):
        return {"status": "session_mismatch"}

    required = {"branch", "worktree", "head", "remote_head", "chunk_no", "retry_state"}
    baseline = run_start if isinstance(run_start, dict) else {}
    retry = baseline.get("retry_state") if isinstance(baseline.get("retry_state"), dict) else {}
    retry_required = {"chunk_id", "chunk_no", "view_sha256", "repair", "pending_sense_ids",
                      "session_available", "checkpoint", "submit", "diagnostic"} | ({"own_state"} if task_mode else set())
    if (not required <= set(baseline) or not retry_required <= set(retry)
            or baseline.get("branch") != b.get("branch")
            or not isinstance(baseline.get("worktree"), str)
            or Path(baseline["worktree"]) != Path(worktree)
            or baseline.get("head") != rec.get("git_head")
            or baseline.get("chunk_no") != rec.get("chunk_no")
            or retry.get("chunk_id") != rec.get("chunk_id")
            or retry.get("chunk_no") != rec.get("chunk_no")
            or retry.get("view_sha256") != rec.get("view_sha256")
            or retry.get("repair") is not False
            or retry.get("submit") is not None or retry.get("diagnostic") is not None):
        return {"status": "checkpoint_or_chunk_mismatch"}
    n = names(b)
    try:
        current_checkpoint = _file_state(Path(worktree) / n.checkpoint)
    except LiteraryError:
        return {"status": "checkpoint_or_chunk_mismatch"}
    if current_checkpoint is None:
        return {"status": "checkpoint_or_chunk_mismatch"}

    try:
        ids, failed, unsearchable = view_ids(read_view(worktree, rec, rec["chunk_no"] if task_mode else None))
    except (OSError, LiteraryError, ValueError, KeyError, TypeError):
        return {"status": "checkpoint_or_chunk_mismatch"}
    if ids != rec.get("sense_ids"):
        return {"status": "checkpoint_or_chunk_mismatch"}
    if failed:
        return {"status": "search_failed", "sense_count": len(failed)}
    if unsearchable:
        return {"status": "unsearchable", "sense_count": len(unsearchable)}
    checkpoint_commands = []
    stop_diagnostics = official_c_stop_diagnostics(
        run.get("log_file"), expected_cli_path=cli_path(), command_cwd=Path(worktree),
        expected_checkpoint_path=Path(worktree) / n.checkpoint, command_facts=checkpoint_commands)
    if any(command.get("operation") == "unparsed_checkpoint_mutation" for command in checkpoint_commands):
        return {"status": "checkpoint_mutation_command_unparsed", "checkpoint_commands": checkpoint_commands}
    for diagnostic in stop_diagnostics:
        status = (diagnostic["diagnostic"] if diagnostic["operation"] == "submit_write"
                  else f"cli_{diagnostic['diagnostic']}")
        return {"status": status, "operation": diagnostic["operation"],
                "stop_diagnostics": stop_diagnostics, "checkpoint_commands": checkpoint_commands}

    baseline_pending = retry.get("pending_sense_ids")
    if not isinstance(baseline_pending, list) or not all(isinstance(sense_id, str) for sense_id in baseline_pending):
        return {"status": "checkpoint_or_chunk_mismatch"}
    if pending_sense_ids != baseline_pending:
        changed = (own_state_now != retry.get("own_state")) if task_mode else (current_checkpoint != retry.get("checkpoint"))
        if changed and set(pending_sense_ids) < set(baseline_pending):
            return {"status": "checkpoint_progress", "pending_sense_ids": list(pending_sense_ids)}
        return {"status": "checkpoint_or_chunk_mismatch"}
    if retry.get("pending_sense_ids") != pending_sense_ids:
        return {"status": "checkpoint_or_chunk_mismatch"}
    task_progress = None
    if task_mode:
        baseline_own_state = retry.get("own_state")
        if baseline_own_state != own_state_now:
            task_progress = shown_only_progress(baseline_own_state, own_state_now)
            if task_progress is None:
                return {"status": "checkpoint_changed_without_pending_progress"}
    elif retry.get("checkpoint") != current_checkpoint:
        return {"status": "checkpoint_changed_without_pending_progress"}

    submit = Path(worktree) / f"{n.submit_prefix}{rec['chunk_no']:03d}.submit.json"
    diagnostic = submit.with_name(submit.name + ".diag.json")
    try:
        if submit.exists() or diagnostic.exists():
            return {"status": "submission_artifact_present", "submit_calls": submit_call_count}
    except OSError:
        return {"status": "submission_artifact_unavailable"}

    if submit_call_count is None:
        return {"status": "submission_status_unknown"}
    if submit_call_count:
        return {"status": "submit_attempt_without_artifacts", "submit_calls": submit_call_count}
    if not isinstance(final_answer, str) or not final_answer.strip():
        return {"status": "producer_output_missing"}

    return {"status": "shown_only_progress" if task_progress is not None else "no_submission",
            "shown_sense_ids": task_progress or [], "policy_version": NO_SUBMISSION_RECOVERY_POLICY_VERSION,
            "source_run_id": run.get("id"), "chunk_id": rec.get("chunk_id"),
            "view_sha256": rec.get("view_sha256"), "pending_sense_ids": list(pending_sense_ids),
            "submit_calls": 0}


def submit_retryable(worktree, b, chunk_no: int) -> bool:
    """True only when the submit CLI left a diagnostic for this chunk that a local file repair can fix."""
    path = Path(worktree) / f"{names(b).submit_prefix}{chunk_no:03d}.submit.json.diag.json"
    try:
        diag = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return False
    return (isinstance(diag, dict) and diag.get("diagnostic") in ("submit_validation", "candidate_validation")
            and diag.get("repair_scope") != "stop_and_report")


def technical_skip_reason_code(worktree, b, chunk_no: int, *, require_input_digest: bool = True) -> str | None:
    """Return a safe reason code for the current local diagnostic, without exposing submitted content."""
    n = names(b)
    path = Path(worktree) / f"{n.submit_prefix}{chunk_no:03d}.submit.json.diag.json"
    try:
        diag = json.loads(path.read_text("utf-8"))
        submit_path = Path(worktree) / f"{n.submit_prefix}{chunk_no:03d}.submit.json"
        submission = json.loads(submit_path.read_text("utf-8"))
    except (OSError, ValueError):
        return "current_evidence_unavailable"
    if not isinstance(diag, dict) or not isinstance(submission, dict) or set(submission) != {"senses"} \
            or not isinstance(submission.get("senses"), list) or not submission["senses"]:
        return "submit_shape_invalid"
    if diag.get("status") != "FAILED" or diag.get("diagnostic") != "submit_validation":
        return "diagnostic_kind_mismatch"
    if diag.get("repair_scope") != "resubmit_affected_sense":
        return "diagnostic_scope_mismatch"
    if diag.get("issues_truncated") is True:
        return "diagnostic_issues_truncated"
    if diag.get("reason") not in {"context_key_not_found", "context_key_ambiguous", "context_key_too_short",
                                   "duplicate_verified", "missing_verified", "no_literary_hits", "submission_schema"}:
        return "diagnostic_reason_unsupported"
    issues = diag.get("issues")
    if not isinstance(issues, list) or len(issues) != 1:
        return "diagnostic_issue_count"
    affected = diag.get("affected") if isinstance(diag, dict) else None
    if not isinstance(affected, dict) or not isinstance(affected.get("sense_id"), str) \
            or not isinstance(affected.get("entry_number"), int) or isinstance(affected.get("entry_number"), bool) \
            or not 1 <= affected["entry_number"] <= len(submission["senses"]):
        return "affected_entry_invalid"
    entry = submission["senses"][affected["entry_number"] - 1]
    issue = issues[0]
    if not isinstance(entry, dict) or entry.get("sense_id") != affected["sense_id"] \
            or not isinstance(issue, dict) or issue.get("entry_number") != affected["entry_number"] \
            or issue.get("reason") != diag["reason"] or issue.get("field") != affected.get("field"):
        return "affected_entry_mismatch"
    if require_input_digest:
        try:
            current_sha = hashlib.sha256(submit_path.read_bytes()).hexdigest()
        except OSError:
            return "submit_unavailable"
        if diag.get("input_sha256") != current_sha:
            return "input_digest_mismatch"
    return None


def technical_skip_candidate(worktree, b, chunk_no: int) -> bool:
    """Cheap routing check; the Supervisor CLI revalidates the full active view and checkpoint before it writes."""
    return technical_skip_reason_code(worktree, b, chunk_no, require_input_digest=False) is None


def deterministic_context_trim_candidate(worktree, b, chunk_no: int) -> bool:
    """True only when the exact failed verified key has surrounding whitespace that the CLI can trim safely."""
    n = names(b)
    path = Path(worktree) / f"{n.submit_prefix}{chunk_no:03d}.submit.json.diag.json"
    submit_path = Path(worktree) / f"{n.submit_prefix}{chunk_no:03d}.submit.json"
    try:
        diag = json.loads(path.read_text("utf-8"))
        submission = json.loads(submit_path.read_text("utf-8"))
    except (OSError, ValueError):
        return False
    affected = diag.get("affected") if isinstance(diag, dict) else None
    issues = diag.get("issues") if isinstance(diag, dict) else None
    if not (isinstance(diag, dict) and diag.get("status") == "FAILED"
            and diag.get("diagnostic") == "submit_validation" and diag.get("reason") == "context_key_not_found"
            and diag.get("repair_scope") == "resubmit_affected_sense" and diag.get("issues_truncated") is not True
            and isinstance(issues, list) and len(issues) == 1
            and isinstance(affected, dict) and affected.get("field") == "verified"
            and isinstance(affected.get("entry_number"), int) and not isinstance(affected.get("entry_number"), bool)
            and isinstance(submission, dict) and isinstance(submission.get("senses"), list)
            and 1 <= affected["entry_number"] <= len(submission["senses"])):
        return False
    issue = issues[0]
    entry = submission["senses"][affected["entry_number"] - 1]
    if not (isinstance(issue, dict) and isinstance(entry, dict) and entry.get("sense_id") == affected.get("sense_id")
            and issue.get("entry_number") == affected["entry_number"]
            and issue.get("reason") == diag["reason"] and issue.get("field") == affected["field"]
            and isinstance(entry.get("verified"), list)):
        return False
    return any(isinstance(key, str) and key != key.strip() and len(key.strip()) >= 12 for key in entry["verified"])


def deterministic_context_sample_candidate(worktree, b, chunk_no: int) -> bool:
    """Retry an unchanged empty-result submission only after every diagnosed Sense has a complete shown sample."""
    n = names(b)
    submit_path = Path(worktree) / f"{n.submit_prefix}{chunk_no:03d}.submit.json"
    diagnostic_path = submit_path.with_name(submit_path.name + ".diag.json")
    try:
        input_bytes = submit_path.read_bytes()
        submission = json.loads(input_bytes)
        diagnostic = json.loads(diagnostic_path.read_text("utf-8"))
    except (OSError, ValueError):
        return False
    issues = diagnostic.get("issues") if isinstance(diagnostic, dict) else None
    affected = diagnostic.get("affected") if isinstance(diagnostic, dict) else None
    if (not isinstance(diagnostic, dict)
            or diagnostic.get("status") != "FAILED" or diagnostic.get("diagnostic") != "submit_validation"
            or diagnostic.get("reason") != "unshown_empty_sample"
            or diagnostic.get("repair_scope") != "resubmit_affected_sense"
            or diagnostic.get("issues_truncated") is True
            or diagnostic.get("input_sha256") != hashlib.sha256(input_bytes).hexdigest()
            or not isinstance(issues, list) or not issues
            or not isinstance(affected, dict) or affected.get("field") != "verified"
            or not isinstance(affected.get("entry_number"), int) or isinstance(affected.get("entry_number"), bool)
            or not isinstance(submission, dict) or set(submission) != {"senses"}
            or not isinstance(submission.get("senses"), list)):
        return False
    try:
        rec = read_active(worktree, b, chunk_no)
        if rec is None or rec.get("repair") is True:
            return False
        active_ids = rec.get("sense_ids")
        entries = submission["senses"]
        if (not isinstance(active_ids, list) or not active_ids or len(entries) != len(active_ids)
                or [entry.get("sense_id") if isinstance(entry, dict) else None for entry in entries] != active_ids
                or any(not isinstance(entry, dict) or set(entry) != {"sense_id", "verified", "candidates"}
                       or not isinstance(entry.get("verified"), list) or not isinstance(entry.get("candidates"), list)
                       for entry in entries)):
            return False
        if not 1 <= affected["entry_number"] <= len(entries):
            return False
        first_issue = issues[0]
        if (not isinstance(first_issue, dict) or first_issue.get("entry_number") != affected["entry_number"]
                or first_issue.get("reason") != "unshown_empty_sample" or first_issue.get("field") != "verified"
                or entries[affected["entry_number"] - 1]["sense_id"] != affected.get("sense_id")):
            return False
        states = own_state(worktree, b, active_ids)["senses"]
    except (LiteraryError, OSError, ValueError, KeyError, TypeError):
        return False

    for issue in issues:
        if (not isinstance(issue, dict) or issue.get("reason") != "unshown_empty_sample"
                or issue.get("field") != "verified"
                or not isinstance(issue.get("entry_number"), int) or isinstance(issue.get("entry_number"), bool)
                or not 1 <= issue["entry_number"] <= len(entries)):
            return False
        entry = entries[issue["entry_number"] - 1]
        shown = states.get(entry["sense_id"], {}).get("shown")
        if (entry["verified"] or entry["candidates"] or not isinstance(shown, dict)
                or shown.get("valid") is not True or not isinstance(shown.get("total_hits"), int)
                or isinstance(shown.get("total_hits"), bool) or shown["total_hits"] <= 0
                or shown.get("context_count") != min(shown["total_hits"], MAX_CONTEXTS_PER_SENSE)):
            return False
    return True


def supervisor_skip(store, runner, env, worktree, b, rec: dict, task: dict | None = None) -> dict:
    """Orchestrate C's source-Sense fallback through the pinned Supervisor-only CLI.

    `task` (a parallel batch) is {"session_id", "run_id", "expected_head", "auto_fix_runs"}: the authority is the task's
    own finished run and its two completed automatic corrections, not the batch-wide serial counters."""
    owner = store.batch(b["id"])
    if (not owner or owner["method"] != "c" or owner["producer"] != b["producer"]
            or owner["shard"] != b["shard"] or owner["batch"] != b["batch"]
            or Path(owner["worktree"]) != Path(worktree) or (task is None and owner["session_id"] != b["session_id"])):
        raise LiteraryError("C technical skip requires the active War Room-owned batch")
    if task is not None:
        auto_runs = task.get("auto_fix_runs")
        if not isinstance(auto_runs, list) or len(auto_runs) < MAX_RESUBMITS:
            raise LiteraryError("C technical skip requires two completed automatic corrections of this task")
        if owner["state"] != "PRODUCING" or owner["pid"] is not None or owner["run_kind"] != "c_parallel":
            raise LiteraryError("C technical skip requires an idle, Supervisor-owned parallel batch")
        retry_attempts, session_id, run_id, expected_head = MAX_RESUBMITS, task["session_id"], task["run_id"], task["expected_head"]
        current_run = store.run(run_id)
        if (not current_run or current_run["kind"] not in ("c_chunk_new", "c_chunk_fix", "c_chunk_recovery")
                or current_run["task"] != f"{rec['chunk_no']:03d}" or current_run["ended_at"] is None
                or current_run["session_id"] != session_id):
            raise LiteraryError("C technical skip requires the finished current run of this task")
    else:
        retry_attempts = int(store.get(resubmit_key(b["id"])) or 0)
        if retry_attempts != MAX_RESUBMITS:
            raise LiteraryError("C technical skip requires the exhausted Supervisor resubmit budget")
        if owner["state"] != "PRODUCING" or owner["pid"] is not None:
            raise LiteraryError("C technical skip requires an idle, Supervisor-owned batch")
        current_runs = store.runs(b["id"])
        current_run = current_runs[0] if current_runs else None
        if (not current_run or current_run["kind"] not in ("c_chunk_new", "c_chunk_resume", "c_chunk_recovery")
                or current_run["session_id"] != b["session_id"] or current_run["ended_at"] is None
                or owner["run_kind"] != current_run["kind"]):
            raise LiteraryError("C technical skip requires the finished current C chunk run")
        session_id, run_id, expected_head = b["session_id"], current_run["id"], rec["git_head"]
    n = names(b)
    if rec.get("repair") is True:
        raise LiteraryError("C technical skip is not allowed during a Candidate repair chunk")
    input_path = f"{n.submit_prefix}{rec['chunk_no']:03d}.submit.json"
    absolute_input = Path(worktree) / input_path
    diagnostic_path = absolute_input.with_name(absolute_input.name + ".diag.json")
    try:
        input_bytes = absolute_input.read_bytes()
        submission = json.loads(input_bytes)
        diagnostic = json.loads(diagnostic_path.read_text("utf-8"))
    except (OSError, ValueError) as error:
        raise LiteraryError("C technical skip inputs are unavailable") from error
    reason_code = technical_skip_reason_code(worktree, b, rec["chunk_no"])
    if reason_code:
        raise LiteraryError(f"C technical skip blocked [{reason_code}]")
    affected = diagnostic["affected"]
    entry_number = affected.get("entry_number") if isinstance(affected, dict) else None
    target_id = affected.get("sense_id") if isinstance(affected, dict) else None
    entries = submission["senses"]
    active_ids = rec.get("sense_ids")
    if (rec.get("repair") is True or not isinstance(active_ids, list) or target_id not in active_ids
            or len({entry.get("sense_id") for entry in entries if isinstance(entry, dict)}) != len(entries)
            or any(not isinstance(entry, dict) or set(entry) != {"sense_id", "verified", "candidates"}
                   or entry.get("sense_id") not in active_ids for entry in entries)):
        raise LiteraryError("C technical skip submission does not match the active chunk")
    active_path, view_path = _active_paths(rec["chunk_no"] if task is not None else None)
    before = sense_report(runner, env, worktree, b, active_ids)
    done = {item["sense_id"] for item in before["senses"] if item["done"]}
    pending = [entry for entry in entries if entry["sense_id"] != target_id and entry["sense_id"] not in done]
    if pending:
        temporary = absolute_input.with_name(f"c-chunk-{rec['chunk_no']:03d}.supervisor-submit.json")
        temporary_diagnostic = temporary.with_name(temporary.name + ".diag.json")
        temporary.write_text(json.dumps({"senses": pending}, ensure_ascii=False), "utf-8")
        try:
            result = cli(runner, env, worktree, "submit", "--db", env["TYPEWRITER_APPROVED_LITERARY_DB"],
                         "--checkpoint", n.checkpoint, "--input", str(temporary.relative_to(worktree)),
                         *(["--chunk", f"{rec['chunk_no']:03d}"] if task is not None else []))
            _json(result, "C unaffected Sense resubmission")
        finally:
            temporary.unlink(missing_ok=True)
            temporary_diagnostic.unlink(missing_ok=True)

    result = runner.run(["node", str(supervisor_cli_path()), "--checkpoint", n.checkpoint,
                         "--input", input_path, "--diagnostic", str(diagnostic_path.relative_to(worktree)),
                         "--active", active_path, "--view", view_path, "--chunk-no", str(rec["chunk_no"]),
                         "--supervisor-store", str(Path(store.path).resolve()), "--batch-id", str(b["id"]),
                         "--branch", b["branch"], "--session-id", session_id,
                         "--run-id", str(run_id), "--expected-head", expected_head,
                         *(["--task", f"{rec['chunk_no']:03d}"] if task is not None else [])],
                        cwd=worktree, env=env, timeout=900)
    if not result.ok:
        try:
            detail = json.loads(result.out or result.err)
            reason_code = detail.get("reason_code") if isinstance(detail, dict) else None
        except ValueError:
            reason_code = None
        raise LiteraryError(f"C technical skip blocked [{reason_code or 'supervisor_cli_failed'}]")
    saved = _json(result, "C Supervisor technical skip")
    if saved.get("status") != "TECHNICAL_SKIPPED" or saved.get("sense_id") != target_id:
        raise LiteraryError("C Supervisor technical skip returned an unexpected state")
    after = sense_report(runner, env, worktree, b, active_ids)
    if not all(item["done"] for item in after["senses"]):
        raise LiteraryError("C technical skip was written but the complete active chunk did not validate")
    return {"status": "TECHNICAL_SKIPPED", "record_id": saved["record_id"], "sense_id": target_id,
            "diagnostic": diagnostic["diagnostic"], "reason": diagnostic["reason"], "field": affected["field"],
            "retry_attempts": retry_attempts, "pending_senses": 0}


def revalidate_submit_before_skip(runner, env, worktree, b, chunk_no: int, *, scoped: bool = False) -> dict | None:
    """Re-run the unchanged full submit through the normal CLI before a skip, refreshing its exact failure binding.

    A successful deterministic CLI repair completes the chunk without a skip. A failed validation leaves the CLI's
    current diagnostic beside the unchanged submission for the Supervisor-only fallback to verify.
    """
    n = names(b)
    input_path = f"{n.submit_prefix}{chunk_no:03d}.submit.json"
    args = ["submit", "--db", env["TYPEWRITER_APPROVED_LITERARY_DB"],
            "--checkpoint", n.checkpoint, "--input", input_path]
    if scoped:
        args.extend(("--chunk", f"{chunk_no:03d}"))
    result = cli(runner, env, worktree, *args)
    if not result.ok:
        return None
    data = _json(result, "C normal submit revalidation")
    if data.get("status") != "SAVED":
        raise LiteraryError("C normal submit revalidation returned an unexpected state")
    return data


def cli(runner, env, worktree, *args, db: bool = False, timeout: float = 900):
    argv = ["node", str(cli_path()), *args]
    return runner.run(argv, cwd=worktree, env=env, timeout=timeout)


def cli_path() -> Path:
    """Current Supervisor checkout's official C CLI, run with the batch worktree as cwd."""
    return Path(__file__).resolve().parents[3] / CLI


def supervisor_cli_path() -> Path:
    """Internal save path for Supervisor-owned state transitions; never included in producer prompts."""
    return Path(__file__).resolve().parents[3] / SUPERVISOR_CLI


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


def view_for_senses(text: str, sense_ids: list[str]) -> str:
    """Select only requested Sense blocks from a validated active view; malformed scope fails closed."""
    if not sense_ids or len(set(sense_ids)) != len(sense_ids) or not all(_ID.fullmatch(i) for i in sense_ids):
        raise LiteraryError("새 세션의 미완료 Sense 목록이 올바르지 않습니다")
    header, separator, body = text.partition("\n\n")
    if not separator or not header.startswith("batch="):
        raise LiteraryError("미완료 Sense용 chunk view 형식이 올바르지 않습니다")
    blocks = {}
    for block in re.split(r"\n\n(?=## )", body):
        match = _HEADER.match(block.split("\n", 1)[0])
        if not match or match.group(1) in blocks:
            raise LiteraryError("미완료 Sense용 chunk view에 잘못된 항목이 있습니다")
        blocks[match.group(1)] = block
    if any(sense_id not in blocks for sense_id in sense_ids):
        raise LiteraryError("미완료 Sense가 저장된 chunk view에 없습니다")
    selected = "\n\n".join(blocks[sense_id] for sense_id in sense_ids)
    suffix = "\n" if text.endswith("\n") else ""
    return f"{header}\n\n{selected}{suffix}"


_PROGRESS = re.compile(r"batch=\d+_\d+ done=(\d+)/(\d+) zero_hit=(\d+) not_yet_read=(\d+)(?: excluded_pending=(\d+))?"
                       r"(?: truncated=true)?\n")


def progress_numbers(text: str) -> tuple[int, int, int, int]:
    """(done, total, zero_hit, not_yet_read) from the view's first line; serial views and views with an
    `excluded_pending` field are both accepted."""
    m = _PROGRESS.match(text)
    if not m:
        raise LiteraryError("chunk view의 진행 헤더를 읽을 수 없습니다")
    return tuple(int(x) for x in m.groups()[:4])  # type: ignore[return-value]


def excluded_pending(text: str) -> int:
    """Unfinished Senses left out of the selection by `--exclude-sense-ids` (0 when the header has no such field)."""
    m = _PROGRESS.match(text)
    if not m:
        raise LiteraryError("chunk view의 진행 헤더를 읽을 수 없습니다")
    return int(m.group(5) or 0)


def render_chunk(runner, env, worktree, b, db_path: str, sense_ids: list[str] | None = None,
                 exclude: list[str] | set[str] | None = None) -> str:
    """One `chunk` call with the fixed limits; the view is the exact CLI stdout (UTF-8, never trimmed).
    `sense_ids` (a Candidate v1 repair) re-reads exactly those senses with the 16-context maximum.
    `exclude` keeps Senses reserved by other chunks out of a general selection; read `excluded_pending(view)`."""
    if sense_ids and exclude:
        raise LiteraryError("sense_ids와 exclude는 함께 쓸 수 없습니다")
    extra = ["--sense-ids", ",".join(sense_ids), "--contexts", "16"] if sense_ids else ["--contexts", str(CHUNK_CONTEXTS)]
    if exclude:
        extra += ["--exclude-sense-ids", ",".join(sorted(exclude))]
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


def _active_paths(chunk_no: int | None) -> tuple[str, str]:
    """(active record, view) of the numbered parallel chunk, or of the singleton when no number is given."""
    if chunk_no is None:
        return ACTIVE, VIEW
    return f"{SCRATCH}/c-active-{chunk_no:03d}.json", f"{SCRATCH}/c-active-{chunk_no:03d}.txt"


def write_active(worktree, b, view: str, ids: list[str], head: str, chunk_no: int, *, repair: bool = False,
                 checkpoint_sha: str | None = None, note: str = "", numbered: bool = False) -> dict:
    """Store the view and the minimal active-chunk record AFTER the view was generated (chunk may advance ZERO_HITS).
    `numbered` writes `c-active-NNN.*` for a parallel chunk instead of the singleton `c-active-chunk.*`."""
    wt = Path(worktree)
    active, view_path = _active_paths(chunk_no if numbered else None)
    (wt / SCRATCH).mkdir(parents=True, exist_ok=True)
    (wt / view_path).write_bytes(view.encode("utf-8"))
    record = {"chunk_id": f"{b['shard']}-{b['batch']}-{chunk_no:03d}", "chunk_no": chunk_no, "sense_ids": ids,
              "view_sha256": sha256_text(view), "view_bytes": len(view.encode("utf-8")), "git_head": head,
              "shard": b["shard"], "batch": b["batch"], "model": b["producer"]}
    if repair:   # senses already done: the repair is finished only when a later submit changed the checkpoint
        record.update(repair=True, checkpoint_sha=checkpoint_sha, note=note[:600])
    tmp = wt / (active + ".tmp")
    tmp.write_text(json.dumps(record, sort_keys=True), "utf-8")
    tmp.replace(wt / active)
    return record


def _load_active(path: Path, b, chunk_no: int | None) -> dict:
    try:
        rec = json.loads(path.read_text("utf-8"))
        ok = (isinstance(rec, dict) and (rec.get("shard"), rec.get("batch"), rec.get("model")) ==
              (b["shard"], b["batch"], b["producer"]) and isinstance(rec.get("chunk_no"), int)
              and not isinstance(rec.get("chunk_no"), bool) and (chunk_no is None or rec["chunk_no"] == chunk_no)
              and isinstance(rec.get("view_sha256"), str) and isinstance(rec.get("git_head"), str)
              and isinstance(rec.get("sense_ids"), list) and rec["sense_ids"]
              and all(isinstance(i, str) and _ID.fullmatch(i) for i in rec["sense_ids"]))
    except (OSError, ValueError):
        ok = False
    if not ok:
        raise LiteraryError("활성 청크 기록이 손상되었거나 다른 배치/모델의 것입니다")
    return rec


def read_active(worktree, b, chunk_no: int | None = None) -> dict | None:
    """The active record bound to this batch (the numbered one, else the singleton), None when there is none;
    a damaged or foreign one raises."""
    path = Path(worktree) / _active_paths(chunk_no)[0]
    if not path.exists():
        return None
    return _load_active(path, b, chunk_no)


_ACTIVE_NUMBERED = re.compile(r"c-active-(\d{3,})\.json")


def active_chunks(worktree, b) -> dict[int, dict]:
    """Every numbered active chunk of this batch. A normal `.tmp` is ignored; a damaged final file raises."""
    found: dict[int, dict] = {}
    for path in sorted((Path(worktree) / SCRATCH).glob("c-active-*.json")):
        m = _ACTIVE_NUMBERED.fullmatch(path.name)
        if not m:
            continue
        number = int(m.group(1))
        found[number] = _load_active(path, b, number)
    return found


def reserved_sense_ids(worktree, b) -> set[str]:
    """Senses already assigned to a numbered active chunk (the exclusion for the next general selection)."""
    return {sense_id for rec in active_chunks(worktree, b).values() for sense_id in rec["sense_ids"]}


def chunk_finished(runner, env, worktree, b, rec: dict) -> bool:
    """A normal chunk: every sense done. A repair chunk (senses were already done): the checkpoint changed since."""
    if rec.get("repair"):
        if not isinstance(rec.get("checkpoint_sha"), str):
            raise LiteraryError("복구 청크 기록이 손상되었습니다")
        return checkpoint_sha(worktree, b) != rec["checkpoint_sha"]
    return sense_report(runner, env, worktree, b, rec["sense_ids"])["all_done"]


def read_view(worktree, rec: dict, chunk_no: int | None = None) -> str:
    """The saved view, proven byte-for-byte to be the one the active record was written for."""
    try:
        data = (Path(worktree) / _active_paths(chunk_no)[1]).read_bytes()
    except OSError as e:
        raise LiteraryError(f"활성 청크 view를 읽을 수 없습니다: {e}") from e
    if hashlib.sha256(data).hexdigest() != rec["view_sha256"]:
        raise LiteraryError("활성 청크 view의 SHA-256이 기록과 다릅니다")
    return data.decode("utf-8")


def clear_active(worktree, chunk_no: int | None = None) -> None:
    active, view = _active_paths(chunk_no)
    for rel in (active, view):
        (Path(worktree) / rel).unlink(missing_ok=True)
    stem = Path(view).stem
    for stale in (Path(worktree) / SCRATCH).glob(f"{stem}.p*of*.txt"):
        stale.unlink()


# ---- delivery of the view to the model ---------------------------------------------------------------------------
def delivery(card_bytes: int, view: str) -> str:
    """"inline" when the whole card + view fits one argv element, else "pages" (that chunk only). Never a partial view."""
    return "inline" if card_bytes + len(view.encode("utf-8")) <= INLINE_MAX_PROMPT_BYTES else "pages"


def write_pages(worktree, view: str, chunk_no: int | None = None) -> list[str]:
    """Fallback pages (Stage 2's 36,000 byte / 28,000 char pages); joining them equals the view exactly."""
    pages = stage2.chunk_pages(view)
    if "".join(pages) != view:
        raise LiteraryError("page 분할 결과가 원본 view와 일치하지 않습니다")
    return stage2.write_pages(worktree, _active_paths(chunk_no)[1], pages)


# ---- deterministic, idempotent finalization ----------------------------------------------------------------------
PR_LABEL = "batch"


def pr_title(label: str, b) -> str:
    return f"[C/{label}] {b['shard']}_{b['batch']}"


def pr_body(label: str, b, coverage: dict) -> str:
    """Six standard production items plus an auditable exclusion line only when a technical skip occurred."""
    lines = [f"- Method: C", f"- Model: {label}", f"- Shard: {b['shard']}", f"- Batch: {b['batch']}",
             f"- Coverage: {coverage['records']} records / {coverage['senses']} senses",
             f"- Candidates: {coverage['candidates']}"]
    skips = coverage.get("technical_skips", [])
    if skips:
        details = ", ".join(f"{item['record_id']}/{item['sense_id']} ({item['reason']})" for item in skips)
        lines.append(f"- Technical skips: {len(skips)} senses — {details}")
    return "\n".join(lines) + "\n"


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
    technical_skips = report.get("technical_skips", [])
    if not isinstance(technical_skips, list) or any(not isinstance(item, dict)
            or not all(isinstance(item.get(key), str) and item[key]
                       for key in ("record_id", "sense_id", "diagnostic", "reason", "field"))
            for item in technical_skips):
        raise LiteraryError("report technical skip 목록이 손상되었습니다")
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
        coverage = _coverage(data)
        coverage["technical_skips"] = technical_skips
        return Export("ready", coverage)
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
    coverage = _coverage(data["coverage"])
    coverage["technical_skips"] = technical_skips
    return Export("ready", coverage)


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
                or issue.get("kind") not in ("source_lemma_repeat", "thousands_comma_fragment", "duplicate_candidate"):
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
