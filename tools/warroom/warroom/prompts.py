"""Method prompt files: `tools/warroom/prompts/*.md` with `{{name}}` placeholders.

Fail closed: a missing/empty/unreadable file, a placeholder this template does not allow, or one the
caller did not fill raises PromptError, and the Supervisor starts no AI process (no hardcoded fallback).
Values are substituted in one pass, so a value that itself contains `{{x}}` (e.g. a review body) is data.
"""
from __future__ import annotations

import re
from pathlib import Path

PROMPT_DIR = Path(__file__).resolve().parent.parent / "prompts"   # independent of the process cwd
_PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_]\w*)\s*\}\}")
_PRODUCE = {"batch", "branch"}
_MAINTAIN = {"issue", "branch"}
_STAGE2 = {"shard", "batch", "part", "branch", "phase", "checkpoint", "session_note", "chunk_input", "chunk_id",
           "relation_direction_rule"}
_STAGE3 = {"shard", "branch", "chunk_id", "chunk_input", "session_note", "s3_policy_card"}
_STAGE3_FIX = {"pr", "head", "branch", "shard", "review_events", "session_note", "relation_path",
               "drop_path", "verify_command"}
_AB_CHUNK = {"batch", "chunk_no", "session_note", "chunk_input", "method_contract"}
_C_CHUNK = {"batch", "branch", "chunk_no", "checkpoint", "chunk_contexts", "session_note", "chunk_input", "method_contract"}
ALLOWED = {"a": _PRODUCE, "b": _PRODUCE, "c": _PRODUCE, "d": _PRODUCE, "recovery": _PRODUCE | {"resolved_defects"},
           "fix": {"pr", "head", "branch", "shard", "batch", "part", "review_events", "session_note", "source_context",
                   "s2_policy_card"},
           "producer_fix": {"pr", "head", "branch", "review_events", "session_note", "source_context",
                            "canonical", "output", "method_contract", "method_fix_scope"},
           "s3_fix": _STAGE3_FIX,
           "m_fix": {"issue", "pr", "head", "branch", "review_events", "session_note"},
           "contract_a": set(), "contract_b": set(), "contract_c": set(), "contract_d": set(),
           "s2_policy_card": {"relation_direction_rule"},
           "m": _MAINTAIN, "m_recovery": _MAINTAIN, "s2": _STAGE2,
           "s2_chunk": _STAGE2 | {"s2_policy_card"}, "s2_recovery": _STAGE2,
           "s2_chunk_resume": {"chunk_id", "relation_direction_rule"},
           "s2_chunk_fix": {"chunk_id", "problem", "relation_direction_rule"},
           "s2_chunk_format_fix": {"chunk_id", "problem", "relation_direction_rule"},
           "s2_links": _STAGE2 | {"link_input"},
           "s2_links_fix": {"digest", "problem", "relation_direction_rule"},
           "s2_repair": _STAGE2 | {"fingerprint", "repair_input", "round_info"},
           "s3_policy_card": set(), "s3_chunk": _STAGE3,
           "c_chunk": _C_CHUNK, "c_chunk_resume": {"chunk_no", "checkpoint", "remaining", "session_note"},
           "d_chunk": {"batch", "branch", "chunk_no", "session_note", "chunk_input", "method_contract"},
           "d_chunk_resume": {"chunk_no", "decisions", "searches"}, "d_chunk_fix": {"chunk_no", "decisions", "problem"},
           "a_chunk": _AB_CHUNK, "b_chunk": _AB_CHUNK, "ab_chunk_retry": {"chunk_no", "requested", "problem", "chunk_input"}}
MAINTENANCE_METHOD = "m"
STAGE2_METHOD = "s2"
CHUNK_VIEW = ".warroom-scratch/active-chunk.txt"
PRODUCER_HANDOFF = """

The War Room Supervisor owns PR monitoring and worktree/branch cleanup.
Do not poll for reviews or merges, or delete, move, or repair the assigned worktree or branch.
"""


class PromptError(Exception):
    pass


def render(name: str, values: dict, directory: Path | None = None) -> str:
    if name not in ALLOWED:
        raise PromptError(f"알 수 없는 프롬프트: {name!r}")
    path = (directory or PROMPT_DIR) / f"{name}.md"
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
    if name == "c_chunk" and "chunk_contexts" not in used:
        raise PromptError(f"{path.name}: 필수 placeholder {{chunk_contexts}}가 없습니다")
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


def method_contract(method: str, directory: Path | None = None) -> str:
    """Load the one shared Stage 1 candidate-form contract used by its production and review-fix cards."""
    if method not in ("a", "b", "c", "d"):
        raise PromptError(f"알 수 없는 Stage 1 방식: {method!r}")
    return render(f"contract_{method}", {}, directory).rstrip("\n")


def _method_fix_scope(method: str, b) -> str:
    if method in ("a", "b"):
        return ("A/B: 리뷰어가 최초로 명시한 `(record_id, sense_id, candidate)` 목록만 삭제/유지를 판단한다. "
                "목록 밖 후보를 변경하거나 재발굴·전수 재검사하지 않는다.")
    if method == "c":
        from . import literary

        checkpoint = literary.names(b).checkpoint
        return ("C: 리뷰가 지목한 Sense에 한해 #1155의 기존 판정·수정 규칙을 적용한다. 후보 형태 지적과 "
                "VERIFIED/source-sense 지적을 구분하며, C의 수정 범위를 삭제 전용으로 제한하지 않는다. "
                "추가 문학 문맥이 필요한 경우에만 다음 명령을 사용한다: `node scripts/relation/literary-context-cli.mjs "
                f"chunk --db \"$TYPEWRITER_APPROVED_LITERARY_DB\" --checkpoint {checkpoint} "
                "--sense-ids <id,...> --contexts 16 --format text`. 승인 DB 환경변수가 없으면 추측하지 않고 "
                "설정 오류로 중단한다.")
    if method == "d":
        return ("D: `d-chunk-cli.mjs search/search-batch`는 활성 청크를 요구하므로 PR 수정에 실행하지 않는다. "
                "제공된 `source_context`와 저장 후보만으로 판단한다. 새 검색 근거가 필수인데 사용할 수 없으면 "
                "파일을 바꾸지 말고 PR에 사유를 설명한 뒤 해당 수정은 멈춘다. 종료 청크를 복구하거나 다시 활성화하지 않는다.")
    raise PromptError(f"알 수 없는 Stage 1 방식: {method!r}")


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


def _stage2_policy_card(checkpoint: dict | None = None, directory: Path | None = None) -> str:
    """Render the shared judgment card first; `render` intentionally performs one substitution pass."""
    return render("s2_policy_card", {"relation_direction_rule": _relation_direction_rule(checkpoint)}, directory).rstrip("\n")


def produce(b, directory: Path | None = None) -> str:
    if b["method"] == MAINTENANCE_METHOD:
        return render("m", {"issue": b["batch"], "branch": b["branch"]}, directory)
    if b["method"] == STAGE2_METHOD:
        return stage2(b, "chunk", None, directory=directory, view="")
    if b["method"] == "s3":
        raise PromptError("Stage 3는 현재 chunk view를 사용해 prompts.stage3_chunk으로 시작해야 합니다")
    values = {"batch": f"{b['shard']}_{b['batch']}", "branch": b["branch"]}
    out = render(b["method"], values, directory)
    return out.rstrip() + PRODUCER_HANDOFF if b["method"] in {"a", "b", "c", "d"} else out


def recovery(b, directory: Path | None = None, resolved_defects: str = "", checkpoint: dict | None = None) -> str:
    if b["method"] == MAINTENANCE_METHOD:
        return render("m_recovery", {"issue": b["batch"], "branch": b["branch"]}, directory)
    if b["method"] == STAGE2_METHOD:
        values = _stage2_values(b)
        values["relation_direction_rule"] = _relation_direction_rule(checkpoint)
        return render("s2_recovery", values, directory)
    if b["method"] == "s3":
        raise PromptError("Stage 3는 현재 chunk view를 사용해 prompts.stage3_chunk으로 복구해야 합니다")
    out = render("recovery", {"batch": f"{b['shard']}_{b['batch']}", "branch": b["branch"],
                              "resolved_defects": resolved_defects}, directory)
    return out.rstrip() + PRODUCER_HANDOFF if b["method"] in {"a", "b", "c", "d"} else out


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


def stage2_links(b, checkpoint: dict, links: str, directory: Path | None = None) -> str:
    values = _stage2_values(b)
    values.update(checkpoint=(f"{checkpoint['decided']}/{checkpoint['total']} primary decisions; optional links pending"),
                  relation_direction_rule=_relation_direction_rule(checkpoint),
                  session_note="새 optional-link 세션이다. primary 판정은 변경하지 않는다.\n", link_input=links)
    return render("s2_links", values, directory)


def stage2_links_fix(digest: str, problem: str, checkpoint: dict | None = None,
                     directory: Path | None = None) -> str:
    return render("s2_links_fix", {"digest": digest, "problem": problem,
                                    "relation_direction_rule": _relation_direction_rule(checkpoint)}, directory)


def stage2_repair(b, fingerprint: str, repair_input: str, round_info: str,
                  type_tier_policy: str = "source-mirror-v1", directory: Path | None = None) -> str:
    values = _stage2_values(b)
    values.update(fingerprint=fingerprint, repair_input=repair_input, round_info=round_info,
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
        raise PromptError(f"Stage 3 chunk ID가 잘못되었습니다: {chunk_id!r}")
    chunk_input = (f"아래가 이번 청크의 전체 입력이다. 손실 없이 함께 판단한다.\n"
                   f"<<<STAGE3_CHUNK_BEGIN>>>\n{view}"
                   f"{'' if view.endswith(chr(10)) else chr(10)}<<<STAGE3_CHUNK_END>>>")
    return render("s3_chunk", {"shard": b["shard"], "branch": b["branch"], "chunk_id": chunk_id,
                               "chunk_input": chunk_input,
                               "session_note": "중단된 같은 청크를 다시 본다. checkpoint에 완료된 청크는 건드리지 않는다.\n"
                               if resumed else "새 AI 세션으로 현재 청크만 편집한다.\n",
                               "s3_policy_card": render("s3_policy_card", {}, directory).rstrip()}, directory)


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


def c_chunk(b, chunk_no: int, checkpoint: str, *, view: str | None = None, pages: list[str] | None = None,
            note: str = "", directory: Path | None = None) -> str:
    """The self-contained card of ONE new Method C chunk session: the whole view inline, or (only when it cannot be
    delivered that way) the page files to read once each. Exactly one of `view` / `pages`."""
    if (view is None) == (pages is None):
        raise PromptError("C 청크 입력은 inline view 또는 page 목록 중 정확히 하나여야 합니다")
    from . import literary

    if view is not None:
        chunk_input = (f"아래가 이번 청크의 **전체 view**다(손실 없음). 다시 `cat`으로 읽지 않는다.\n{VIEW_BEGIN}\n{view}"
                       f"{'' if view.endswith(chr(10)) else chr(10)}{VIEW_END}")
    else:
        reads = "\n".join(f"   - `cat {path}` ({i}/{len(pages)})" for i, path in enumerate(pages, 1))
        chunk_input = ("청크 view가 한 번에 전달하기에 커서 page 파일로 나눴다. 아래 page를 순서대로 **page마다 별도 도구 호출 한 번씩** "
                       "`cat`으로 읽는다(Codex는 각 호출에 `max_output_tokens: 10000`). 모두 이으면 view와 같다. "
                       "하나라도 받지 못했거나 truncated 경고가 보이면 제출하지 말고 그 사실을 보고한 뒤 종료한다.\n" + reads)
    return render("c_chunk", {"batch": f"{b['shard']}_{b['batch']}", "branch": b["branch"],
                              "chunk_no": f"{chunk_no:03d}", "checkpoint": checkpoint,
                              "chunk_contexts": literary.CHUNK_CONTEXTS, "session_note": note,
                              "chunk_input": chunk_input, "method_contract": method_contract("c", directory)}, directory)


def c_chunk_resume(chunk_no: int, checkpoint: str, remaining: list[str], *, note: str = "",
                   directory: Path | None = None) -> str:
    """Resuming the same session: only the still-open sense ids, never the chunk body again."""
    return render("c_chunk_resume", {"chunk_no": f"{chunk_no:03d}", "checkpoint": checkpoint,
                                     "remaining": "남은 Sense ID: " + ", ".join(remaining),
                                     "session_note": note}, directory)


def d_chunk(b, chunk_no: int, *, view: str | None = None, pages: list[str] | None = None,
            note: str = "", directory: Path | None = None) -> str:
    """The self-contained card of ONE new Method D chunk session: the whole view inline, or (only when it cannot be
    delivered that way) the page files to read once each. Exactly one of `view` / `pages`."""
    if (view is None) == (pages is None):
        raise PromptError("D 청크 입력은 inline view 또는 page 목록 중 정확히 하나여야 합니다")
    if view is not None:
        chunk_input = (f"아래가 이번 청크의 **전체 view**다(손실 없음). 다시 `cat`으로 읽지 않는다.\n{VIEW_BEGIN}\n{view}"
                       f"{'' if view.endswith(chr(10)) else chr(10)}{VIEW_END}")
    else:
        reads = "\n".join(f"   - `cat {path}` ({i}/{len(pages)})" for i, path in enumerate(pages, 1))
        chunk_input = ("청크 view가 한 번에 전달하기에 커서 page 파일로 나눴다. 아래 page를 순서대로 **page마다 별도 도구 호출 한 번씩** "
                       "`cat`으로 읽는다(Codex는 각 호출에 `max_output_tokens: 10000`). 모두 이으면 view와 같다. "
                       "하나라도 받지 못했거나 truncated 경고가 보이면 저장하지 말고 그 사실을 보고한 뒤 종료한다.\n" + reads)
    return render("d_chunk", {"batch": f"{b['shard']}_{b['batch']}", "branch": b["branch"], "chunk_no": f"{chunk_no:03d}",
                              "session_note": note, "chunk_input": chunk_input,
                              "method_contract": method_contract("d", directory)}, directory)


def d_chunk_resume(chunk_no: int, *, decisions: str, searches: str, directory: Path | None = None) -> str:
    """Resuming the same session: a short continue instruction only, never the chunk view again."""
    return render("d_chunk_resume", {"chunk_no": f"{chunk_no:03d}", "decisions": decisions,
                                     "searches": searches}, directory)


def d_chunk_fix(b, chunk_no: int, problem: str, directory: Path | None = None) -> str:
    """Same session after a rejected `save`: only the CLI's rejection reasons, never the view again."""
    return render("d_chunk_fix", {"chunk_no": f"{chunk_no:03d}", "problem": problem,
                                  "decisions": f".warroom-scratch/d-{b['shard']}_{b['batch']}/decision-{chunk_no:03d}.txt"}, directory)


def ab_chunk(b, chunk_no: int, *, view: str, note: str = "", directory: Path | None = None) -> str:
    """The self-contained card of ONE new A/B chunk session (`a_chunk.md` / `b_chunk.md`): the fixed contract first (a
    stable prompt-cache prefix), the whole compact view last, inline and lossless."""
    if b["method"] not in ("a", "b"):
        raise PromptError("A/B 청크 카드는 방식 a/b에만 있습니다")
    chunk_input = (f"아래가 이번 청크의 **전체 view**다(손실 없음). `#` 줄은 설명, `C` 줄은 이미 저장된 후보다.\n{VIEW_BEGIN}\n{view}"
                   f"{'' if view.endswith(chr(10)) else chr(10)}{VIEW_END}")
    return render(f"{b['method']}_chunk", {"batch": f"{b['shard']}_{b['batch']}", "chunk_no": f"{chunk_no:03d}",
                                           "session_note": note, "chunk_input": chunk_input,
                                           "method_contract": method_contract(b["method"], directory)}, directory)


def ab_chunk_retry(chunk_no: int, requested: str, problem: str, directory: Path | None = None) -> str:
    """Resuming the same session after a rejected save: only the rejection and the aliases to redo, never the view again."""
    return render("ab_chunk_retry", {"chunk_no": f"{chunk_no:03d}", "requested": requested, "problem": problem,
                                     "chunk_input": ""}, directory)


def fix(b, events, resumed: bool, directory: Path | None = None, source_context: str = "",
        checkpoint: dict | None = None) -> str:
    lines = []
    for e in events:
        loc = f" {e['path']}:{e.get('line')}" if e.get("path") else ""
        lines.append(f"--- {e['kind']} by {e['author']}{loc} [{e['key']}]\n{e['body']}\n")
    note = "" if resumed else "새 리뷰 수정 세션이다. 아래 고정 계약과 제공된 리뷰 이벤트·source_context를 사용한다.\n"
    if b["method"] == MAINTENANCE_METHOD:
        template = "m_fix"
    elif b["method"] == STAGE2_METHOD:
        template = "fix"
    elif b["method"] == "s3":
        template = "s3_fix"
        note = "" if resumed else "새 Stage 3 리뷰 수정 세션이다. 제공된 현재 HEAD 리뷰 이벤트만 처리한다.\n"
    else:
        template = "producer_fix"
    values = {"pr": b["pr_number"], "head": b["head_sha"], "branch": b["branch"],
              "shard": b["shard"], "batch": b["batch"].split("-")[0] if b["method"] == STAGE2_METHOD else b["batch"],
              "part": b["batch"].split("-")[1] if b["method"] == STAGE2_METHOD else "",
              "review_events": "\n".join(lines), "session_note": note,
              "source_context": source_context,
              "s2_policy_card": (_stage2_policy_card(checkpoint, directory)
                                 if b["method"] == STAGE2_METHOD else "")}
    if b["method"] == MAINTENANCE_METHOD:
        values["issue"] = b["batch"]
    if b["method"] == "s3":
        values.update(relation_path=f"data/relations/relation-{b['shard']}.jsonl",
                      drop_path=f"data/relation-drops/drop-{b['shard']}.jsonl",
                      verify_command=f"node scripts/relation/admission-cli.mjs verify --shard {b['shard']} --json")
    if b["method"] in ("a", "b", "c", "d"):
        from . import dchunk, literary, stage1ab

        if b["method"] in stage1ab.METHODS:
            canonical, output = stage1ab.names(b).canonical, stage1ab.names(b).output
        elif b["method"] == "c":
            canonical, output = literary.names(b).canonical, literary.names(b).output
        else:
            canonical, output = dchunk.names(b).canonical, dchunk.names(b).output
        values.update(canonical=canonical, output=output,
                      method_contract=method_contract(b["method"], directory),
                      method_fix_scope=_method_fix_scope(b["method"], b))
    out = render(template, values, directory)
    return out.rstrip() + PRODUCER_HANDOFF if b["method"] in {"a", "b", "c", "d"} else out
