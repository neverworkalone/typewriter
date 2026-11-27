"""Method prompt files: `tools/warroom/prompts/*.md` with `{{name}}` placeholders.

Fail closed: a missing/empty/unreadable file, a placeholder this template does not allow, or one the
caller did not fill raises PromptError, and the Supervisor starts no AI process (no hardcoded fallback).
Values are substituted in one pass, so a value that itself contains `{{x}}` (e.g. a review body) is data.
"""
from __future__ import annotations

import re
from pathlib import Path

from .config import RootError, operating_root

PROMPT_DIR = Path(__file__).resolve().parent.parent / "prompts"   # the importing checkout: used only when no operating root is set


def prompt_dir() -> Path:
    """Default prompt directory: the operating root's `tools/warroom/prompts` (#3378), never cwd or a temporary worktree."""
    try:
        return operating_root() / "tools" / "warroom" / "prompts"
    except RootError as e:
        raise PromptError(str(e)) from e
_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_]\w*)\s*\}\}")
_MAINTAIN = {"issue", "branch"}
_STAGE2 = {"shard", "batch", "part", "branch", "phase", "checkpoint", "session_note", "chunk_input", "chunk_id",
           "relation_direction_rule"}
_STAGE3 = {"shard", "branch", "chunk_id", "chunk_input", "session_note", "s3_policy_card"}
_STAGE3_FIX = {"pr", "head", "branch", "shard", "review_events", "session_note", "relation_path",
               "drop_path", "source_context"}
ALLOWED = {"fix": {"pr", "head", "branch", "shard", "batch", "part", "review_events", "session_note", "source_context",
                   "s2_policy_card"},
           "s3_fix": _STAGE3_FIX,
           "m_fix": {"issue", "pr", "head", "branch", "review_events", "session_note"},
           "s2_policy_card": {"relation_direction_rule", "whole_drop_rule"},
           "m": _MAINTAIN, "m_recovery": _MAINTAIN, "s2": _STAGE2,
           "s2_chunk": _STAGE2 | {"s2_policy_card"}, "s2_recovery": _STAGE2,
           "s2_task": {"shard", "batch", "part", "branch", "chunk_id", "defect_path", "session_note", "chunk_input",
                       "s2_policy_card"},
           "s2_task_fix_fresh": {"shard", "batch", "part", "branch", "chunk_id", "defect_path", "problem", "previous_rows",
                                 "chunk_input", "s2_policy_card"},
           "s2_chunk_resume": {"chunk_id", "relation_direction_rule"},
           "s2_chunk_fix": {"chunk_id", "problem", "relation_direction_rule"},
           "s2_chunk_format_fix": {"chunk_id", "problem", "relation_direction_rule"},
           "s2_links": _STAGE2 | {"link_input", "whole_drop_rule"},
           "s2_links_fix": {"digest", "problem", "relation_direction_rule"},
           "s2_repair": _STAGE2 | {"repair_input", "round_info", "format_feedback"},
           "s3_policy_card": {"whole_drop_rule"}, "s3_chunk": _STAGE3, "whole_drop_card": set(),
           "recovery": {"case_key", "case_facts"}}   # the Recovery lane's run contract (former recovery-desk brief)
MAINTENANCE_METHOD = "m"
STAGE2_METHOD = "s2"
CHUNK_VIEW = ".warroom-scratch/active-chunk.txt"


class PromptError(Exception):
    pass


def _refine_templates(b):
    """A refinement batch's Stage spec, with its chunk, fix and policy-card templates allowed as Stage 3's are."""
    from . import refine
    spec = refine.spec_for(b)
    ALLOWED.setdefault(spec.chunk_prompt, _STAGE3)
    ALLOWED.setdefault(spec.fix_prompt, _STAGE3_FIX)
    ALLOWED.setdefault(spec.policy_card, {"whole_drop_rule"})   # every card may embed the shared #10171 card
    return spec


def render(name: str, values: dict, directory: Path | None = None) -> str:
    if name not in ALLOWED:
        raise PromptError(f"알 수 없는 프롬프트: {name!r}")
    path = (directory or prompt_dir()) / f"{name}.md"
    try:
        text = path.read_text("utf-8")
    except OSError as e:
        raise PromptError(f"프롬프트 파일을 읽을 수 없습니다: {path} ({e})") from e
    if not text.strip():
        raise PromptError(f"프롬프트 파일이 비어 있습니다: {path}")
    # Any `{{`/`}}` left once the valid tokens are removed is a malformed placeholder ({{batch-name}}, {{a.b}} ...).
    stray = _PLACEHOLDER.sub("", text)
    if "{{" in stray or "}}" in stray:
        raise PromptError(f"{path.name}: 허용되지 않는 이중 중괄호 구문이 있습니다 (placeholder는 {{{{name}}}} 형태만 가능)")
    used = {m.group(1) for m in _PLACEHOLDER.finditer(text)}
    unknown = used - ALLOWED[name]
    if unknown:
        raise PromptError(f"{path.name}: 허용되지 않는 placeholder {sorted(unknown)}")
    missing = used - values.keys()
    if missing:
        raise PromptError(f"{path.name}: 값이 없는 placeholder {sorted(missing)}")
    out = _PLACEHOLDER.sub(lambda m: str(values[m.group(1)]), text)
    if not out.strip():
        raise PromptError(f"{path.name}: 치환 결과가 비어 있습니다")
    return out


def _stage2_values(b) -> dict:
    try:
        batch, part = b["batch"].split("-")
    except ValueError as e:
        raise PromptError(f"Stage 2 배치 키 {b['batch']!r}는 'BB-PP' 형식이어야 합니다") from e
    return {"shard": b["shard"], "batch": batch, "part": part, "branch": b["branch"]}


def _relation_direction_rule(checkpoint: dict | None = None) -> str:
    """State the answer contract for this checkpoint while keeping marker-free work resumable."""
    if checkpoint is None or checkpoint.get("type_tier_policy") == "source-mirror-v1":
        return ("For each ID↔ID relation, judge type/relevance once from the source sense. The CLI derives and saves the "
                "same type/relevance in reverse_type/reverse_relevance. Never supply or independently judge reverse values.")
    if checkpoint.get("type_tier_policy") in (None, "legacy-independent"):
        return ("This checkpoint predates the source-mirror policy. Preserve its legacy contract: independently judge "
                "the reverse type/relevance and provide both values in the exact format shown by its CLI view.")
    raise PromptError("Stage 2 checkpoint has an unsupported Type/Tier direction policy")


def _whole_drop_rule(directory: Path | None = None) -> str:
    """The #10171 whole-Drop categories for `s`-marked Senses (#10265), shared by S2 primary/links and S3 cards."""
    return render("whole_drop_card", {}, directory).rstrip("\n")


def _stage2_policy_card(checkpoint: dict | None = None, directory: Path | None = None) -> str:
    """Render the shared judgment card first; `render` intentionally performs one substitution pass."""
    return render("s2_policy_card", {"relation_direction_rule": _relation_direction_rule(checkpoint),
                                     "whole_drop_rule": _whole_drop_rule(directory)}, directory).rstrip("\n")


def produce(b, directory: Path | None = None) -> str:
    if b["method"] == MAINTENANCE_METHOD:
        return render("m", {"issue": b["batch"], "branch": b["branch"]}, directory)
    if b["method"] == STAGE2_METHOD:
        return stage2(b, "chunk", None, directory=directory, view="")
    raise PromptError(f"{b['method']!r}의 시작 프롬프트가 없습니다 (정제 Stage는 prompts.stage3_chunk으로 시작합니다)")


def recovery(b, directory: Path | None = None, checkpoint: dict | None = None) -> str:
    if b["method"] == MAINTENANCE_METHOD:
        return render("m_recovery", {"issue": b["batch"], "branch": b["branch"]}, directory)
    if b["method"] == STAGE2_METHOD:
        values = _stage2_values(b)
        values["relation_direction_rule"] = _relation_direction_rule(checkpoint)
        return render("s2_recovery", values, directory)
    raise PromptError(f"{b['method']!r}의 복구 프롬프트가 없습니다 (정제 Stage는 prompts.stage3_chunk으로 복구합니다)")


def stage2(b, phase: str, checkpoint: dict | None, *, resumed: bool = False,
           directory: Path | None = None, view: str | None = None) -> str:
    """One bounded Stage 2 primary chunk run; finalization is deterministic Supervisor work."""
    if phase != "chunk":
        raise PromptError(f"알 수 없는 Stage 2 실행 단계: {phase!r}")
    if view is None:
        raise PromptError("Stage 2 청크 실행에는 청크 view가 필요합니다")
    values = _stage2_values(b)
    batch, part = values["batch"], values["part"]
    pending = f"{b['shard']}-{batch}-{part}-001"
    if checkpoint is None:
        chunk = f"checkpoint 미준비; 다음 청크 ID는 {pending}"
    else:
        pending = checkpoint["pending_chunk"] or \
            f"{b['shard']}-{batch}-{part}-{checkpoint['next_chunk_number']:03d}"
        chunk = (f"checkpoint {checkpoint['decided']}/{checkpoint['total']} 후보 판정 저장; "
                 f"next_chunk_number={checkpoint['next_chunk_number']}; 다음 청크 ID={pending}; "
                 f"pending_chunk={'없음' if checkpoint['pending_chunk'] is None else checkpoint['pending_chunk']}")
    chunk_input = (f"아래가 이번 청크의 **전체 view**다(손실 없음).\n{VIEW_BEGIN}\n{view}"
                   f"{'' if view.endswith(chr(10)) else chr(10)}{VIEW_END}") if view is not None else ""
    values.update(phase="chunk", checkpoint=chunk, chunk_input=chunk_input, chunk_id=pending,
                  relation_direction_rule=_relation_direction_rule(checkpoint),
                  s2_policy_card=_stage2_policy_card(checkpoint, directory),
                  session_note=("중단된 같은 청크를 이어간다. 이미 checkpoint에 저장된 결정을 다시 만들지 않는다.\n"
                                if resumed else ""))
    return render("s2_chunk", values, directory)


def stage2_task(b, task_id: str, view: str, defect_path: str, checkpoint: dict | None = None, *,
                resumed: bool = False, directory: Path | None = None) -> str:
    """One parallel Stage 2 primary task (#3047). Order: shared instructions and policy card (identical for every task
    of a Part and across Parts), then the variable task block (ID, reporting path), then that task's whole view.
    The Part-wide progress counters are intentionally absent so the prefix never changes while tasks are saved."""
    values = _stage2_values(b)
    chunk_input = (f"아래가 이번 task의 **전체 view**다(손실 없음).\n{VIEW_BEGIN}\n{view}"
                   f"{'' if view.endswith(chr(10)) else chr(10)}{VIEW_END}")
    values.update(chunk_id=task_id, defect_path=defect_path, chunk_input=chunk_input,
                  s2_policy_card=_stage2_policy_card(checkpoint, directory),
                  session_note=("중단된 같은 task를 이어간다. 이미 checkpoint에 저장된 결정을 다시 만들지 않는다.\n"
                                if resumed else ""))
    return render("s2_task", values, directory)


def stage2_task_fix_fresh(b, task_id: str, view: str, defect_path: str, problem: str, previous_rows: list[str],
                          checkpoint: dict | None = None, directory: Path | None = None) -> str:
    """A rejected task's correction as a NEW session (adapters whose resume re-reads the whole thread uncached, #7827):
    the same shared card, the CLI diagnostic, the named rows of the previous answer and a view of only those candidates
    (full-view aliases), so the answer merges into the preserved decisions exactly like a same-session fix."""
    values = _stage2_values(b)
    chunk_input = (f"아래가 수정할 후보만 담은 view다.\n{VIEW_BEGIN}\n{view}"
                   f"{'' if view.endswith(chr(10)) else chr(10)}{VIEW_END}")
    values.update(chunk_id=task_id, defect_path=defect_path, problem=problem, chunk_input=chunk_input,
                  previous_rows="\n".join(previous_rows) or "(없음 — 지목된 행을 새로 쓴다)",
                  s2_policy_card=_stage2_policy_card(checkpoint, directory))
    return render("s2_task_fix_fresh", values, directory)


def stage2_links(b, checkpoint: dict, links: str, directory: Path | None = None) -> str:
    values = _stage2_values(b)
    values.update(checkpoint=(f"{checkpoint['decided']}/{checkpoint['total']} primary decisions; optional links pending"),
                  relation_direction_rule=_relation_direction_rule(checkpoint),
                  session_note="새 optional-link 세션이다. primary 판정은 변경하지 않는다.\n", link_input=links,
                  whole_drop_rule=_whole_drop_rule(directory))
    return render("s2_links", values, directory)


def stage2_links_fix(digest: str, problem: str, checkpoint: dict | None = None,
                     directory: Path | None = None) -> str:
    return render("s2_links_fix", {"digest": digest, "problem": problem,
                                    "relation_direction_rule": _relation_direction_rule(checkpoint)}, directory)


def stage2_repair(b, repair_input: str, round_info: str, type_tier_policy: str = "source-mirror-v1",
                  directory: Path | None = None, *, format_error: str | None = None) -> str:
    values = _stage2_values(b)
    values.update(repair_input=repair_input, round_info=round_info,
                  format_feedback=(f"The previous response failed deterministic format validation: {format_error}\n"
                                   "Correct the response format only; preserve the already supplied judgments."
                                   if format_error else ""),
                  relation_direction_rule=_relation_direction_rule({"type_tier_policy": type_tier_policy}))
    return render("s2_repair", values, directory)


def stage2_chunk_resume(chunk_id: str, checkpoint: dict | None = None, directory: Path | None = None) -> str:
    """Same session, same unsaved chunk: a short request for the final decisions, never the view again."""
    return render("s2_chunk_resume", {"chunk_id": chunk_id,
                                       "relation_direction_rule": _relation_direction_rule(checkpoint)}, directory)


def stage3_chunk(b, chunk_id: str, view: str, *, resumed: bool = False,
                 directory: Path | None = None) -> str:
    """One new Stage 3 editing session for exactly one complete source-Sense chunk."""
    if not re.fullmatch(r"\d{3}", chunk_id):
        raise PromptError(f"정제 Stage chunk ID가 잘못되었습니다: {chunk_id!r}")
    chunk_input = (f"아래가 이번 청크의 전체 입력이다. 손실 없이 함께 판단한다.\n"
                   f"<<<STAGE3_CHUNK_BEGIN>>>\n{view}"
                   f"{'' if view.endswith(chr(10)) else chr(10)}<<<STAGE3_CHUNK_END>>>")
    spec = _refine_templates(b)
    return render(spec.chunk_prompt, {"shard": b["shard"], "branch": b["branch"], "chunk_id": chunk_id,
                                      "chunk_input": chunk_input,
                                      "session_note": "중단된 같은 청크를 다시 본다. checkpoint에 완료된 청크는 건드리지 않는다.\n"
                                      if resumed else "새 AI 세션으로 현재 청크만 편집한다.\n",
                                      "s3_policy_card": render(spec.policy_card,
                                                               {"whole_drop_rule": _whole_drop_rule(directory)},
                                                               directory).rstrip()}, directory)


def stage2_chunk_fix(chunk_id: str, problem: str, checkpoint: dict | None = None,
                     directory: Path | None = None) -> str:
    """Same session after a rejected save: only the CLI's complete error list and the rows to redo."""
    return render("s2_chunk_fix", {"chunk_id": chunk_id, "problem": problem,
                                   "relation_direction_rule": _relation_direction_rule(checkpoint)}, directory)


def stage2_chunk_format_fix(chunk_id: str, problem: str, checkpoint: dict | None = None,
                            directory: Path | None = None) -> str:
    """Same session after a malformed full answer: preserve its judgments and resubmit the whole current chunk."""
    return render("s2_chunk_format_fix", {"chunk_id": chunk_id, "problem": problem,
                                          "relation_direction_rule": _relation_direction_rule(checkpoint)}, directory)


VIEW_BEGIN, VIEW_END = "<<<CHUNK_VIEW_BEGIN>>>", "<<<CHUNK_VIEW_END>>>"


def fix(b, events, resumed: bool, directory: Path | None = None, source_context: str = "",
        checkpoint: dict | None = None, retry_note: str = "") -> str:
    lines = []
    for e in events:
        loc = f" {e['path']}:{e.get('line')}" if e.get("path") else ""
        lines.append(f"--- {e['kind']} by {e['author']}{loc} [{e['key']}]\n{e['body']}\n")
    note = "" if resumed else "새 리뷰 수정 세션이다. 아래 고정 계약과 제공된 리뷰 이벤트·source_context를 사용한다.\n"
    if b["method"] == MAINTENANCE_METHOD:
        template = "m_fix"
    elif b["method"] == STAGE2_METHOD:
        template = "fix"
        note = ("This continues the same Stage 2 review-fix session. Use the review events already given in this "
                "session and submit the complete judgment again." if resumed else
                "This is a fresh Stage 2 review-fix session. Do not resume a production or earlier fix session.")
        if retry_note:
            note += (" The Supervisor could not apply the previous submission and wrote nothing: "
                     f"{retry_note} Correct the judgment and write the response file again.")
    elif b["method"] in ("s3", "drop"):
        spec = _refine_templates(b)
        template = spec.fix_prompt
        note = (f"This continues the same {spec.label} review-fix session. Use the review events and PR context already "
                "given in this session and submit the complete judgment again." if resumed else
                f"This is a fresh {spec.label} review-fix session for the current-HEAD review events below.")
        if retry_note:
            note += (" The Supervisor could not apply the previous submission and wrote nothing: "
                     f"{retry_note} Correct the judgment and write the response file again.")
    else:
        raise PromptError(f"{b['method']!r}의 리뷰 수정 프롬프트가 없습니다")
    values = {"pr": b["pr_number"], "head": b["head_sha"], "branch": b["branch"],
              "shard": b["shard"], "batch": b["batch"].split("-")[0] if b["method"] == STAGE2_METHOD else b["batch"],
              "part": b["batch"].split("-")[1] if b["method"] == STAGE2_METHOD else "",
              "review_events": "\n".join(lines), "session_note": note,
              "source_context": source_context,
              "s2_policy_card": (_stage2_policy_card(checkpoint, directory)
                                 if b["method"] == STAGE2_METHOD else "")}
    if b["method"] == MAINTENANCE_METHOD:
        values["issue"] = b["batch"]
    if b["method"] in ("s3", "drop"):
        values.update(relation_path=f"data/relations/relation-{b['shard']}.jsonl",
                      drop_path=f"data/relation-drops/drop-{b['shard']}.jsonl")
    return render(template, values, directory)
