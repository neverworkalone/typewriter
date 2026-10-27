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
_STAGE2 = {"shard", "batch", "part", "branch", "phase", "checkpoint", "session_note", "chunk_read"}
ALLOWED = {"a": _PRODUCE, "b": _PRODUCE, "c": _PRODUCE, "d": _PRODUCE, "recovery": _PRODUCE | {"resolved_defects"},
           "fix": {"pr", "head", "branch", "review_events", "session_note"},
           "m": _MAINTAIN, "m_recovery": _MAINTAIN, "s2": _STAGE2, "s2_chunk": _STAGE2, "s2_recovery": _STAGE2}
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


def produce(b, directory: Path | None = None) -> str:
    if b["method"] == MAINTENANCE_METHOD:
        return render("m", {"issue": b["batch"], "branch": b["branch"]}, directory)
    if b["method"] == STAGE2_METHOD:
        return stage2(b, "chunk", None, directory=directory)
    out = render(b["method"], {"batch": f"{b['shard']}_{b['batch']}", "branch": b["branch"]}, directory)
    return out.rstrip() + PRODUCER_HANDOFF if b["method"] in {"a", "b", "c", "d"} else out


def recovery(b, directory: Path | None = None, resolved_defects: str = "") -> str:
    if b["method"] == MAINTENANCE_METHOD:
        return render("m_recovery", {"issue": b["batch"], "branch": b["branch"]}, directory)
    if b["method"] == STAGE2_METHOD:
        return render("s2_recovery", _stage2_values(b), directory)
    out = render("recovery", {"batch": f"{b['shard']}_{b['batch']}", "branch": b["branch"],
                              "resolved_defects": resolved_defects}, directory)
    return out.rstrip() + PRODUCER_HANDOFF if b["method"] in {"a", "b", "c", "d"} else out


def stage2(b, phase: str, checkpoint: dict | None, *, resumed: bool = False,
           directory: Path | None = None, pages: list[str] | None = None) -> str:
    """One bounded Stage 2 chunk run (`s2_chunk.md`, self-contained) or the separate finalization run (`s2.md`)."""
    if phase not in ("chunk", "finalize"):
        raise PromptError(f"알 수 없는 Stage 2 실행 단계: {phase!r}")
    values = _stage2_values(b)
    batch, part = values["batch"], values["part"]
    if checkpoint is None:
        chunk = f"checkpoint 미준비; 다음 청크 ID는 {b['shard']}-{batch}-{part}-001"
    else:
        pending = checkpoint["pending_chunk"] or \
            f"{b['shard']}-{batch}-{part}-{checkpoint['next_chunk_number']:03d}"
        chunk = (f"checkpoint {checkpoint['decided']}/{checkpoint['total']} 후보 판정 저장; "
                 f"next_chunk_number={checkpoint['next_chunk_number']}; 다음 청크 ID={pending}; "
                 f"pending_chunk={'없음' if checkpoint['pending_chunk'] is None else checkpoint['pending_chunk']}")
    pages = pages or [CHUNK_VIEW]   # the Supervisor passes the pages it wrote; one page is the view itself
    values["chunk_read"] = "\n".join(f"   - `cat {path}` ({i}/{len(pages)})" for i, path in enumerate(pages, 1)) \
        if phase == "chunk" else ""
    values.update(phase="chunk" if phase == "chunk" else "finalize", checkpoint=chunk,
                  session_note=("중단된 같은 청크를 이어간다. 이미 checkpoint에 저장된 결정을 다시 만들지 않는다.\n"
                                if resumed else ""))
    return render("s2_chunk" if phase == "chunk" else "s2", values, directory)


def fix(b, events, resumed: bool, directory: Path | None = None) -> str:
    lines = []
    for e in events:
        loc = f" {e['path']}:{e.get('line')}" if e.get("path") else ""
        lines.append(f"--- {e['kind']} by {e['author']}{loc} [{e['key']}]\n{e['body']}\n")
    note = "" if resumed else ("(이전 AI 세션을 이어받지 못한 새 세션이다. AGENTS.md와 이 worktree의 git 상태, "
                               "PR 내용을 먼저 파악하라.)\n")
    out = render("fix", {"pr": b["pr_number"], "head": b["head_sha"], "branch": b["branch"],
                         "review_events": "\n".join(lines), "session_note": note}, directory)
    return out.rstrip() + PRODUCER_HANDOFF if b["method"] in {"a", "b", "c", "d"} else out
