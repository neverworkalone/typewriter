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
ALLOWED = {"a": _PRODUCE, "b": _PRODUCE, "c": _PRODUCE, "d": _PRODUCE, "recovery": _PRODUCE,
           "fix": {"pr", "head", "branch", "review_events", "session_note"},
           "m": _MAINTAIN, "m_recovery": _MAINTAIN}
MAINTENANCE_METHOD = "m"


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


def produce(b, directory: Path | None = None) -> str:
    if b["method"] == MAINTENANCE_METHOD:
        return render("m", {"issue": b["batch"], "branch": b["branch"]}, directory)
    return render(b["method"], {"batch": f"{b['shard']}_{b['batch']}", "branch": b["branch"]}, directory)


def recovery(b, directory: Path | None = None) -> str:
    if b["method"] == MAINTENANCE_METHOD:
        return render("m_recovery", {"issue": b["batch"], "branch": b["branch"]}, directory)
    return render("recovery", {"batch": f"{b['shard']}_{b['batch']}", "branch": b["branch"]}, directory)


def fix(b, events, resumed: bool, directory: Path | None = None) -> str:
    lines = []
    for e in events:
        loc = f" {e['path']}:{e.get('line')}" if e.get("path") else ""
        lines.append(f"--- {e['kind']} by {e['author']}{loc} [{e['key']}]\n{e['body']}\n")
    note = "" if resumed else ("(이전 AI 세션을 이어받지 못한 새 세션이다. AGENTS.md와 이 worktree의 git 상태, "
                               "PR 내용을 먼저 파악하라.)\n")
    return render("fix", {"pr": b["pr_number"], "head": b["head_sha"], "branch": b["branch"],
                          "review_events": "\n".join(lines), "session_note": note}, directory)
