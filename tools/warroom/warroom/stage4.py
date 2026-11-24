"""Stage 4 (#9928): selective whole-shard Polish — its spec and its chunk answer rule.

Stage 4 runs on the shared refinement line like Stage 3 (`refine.RefineOps`, the parallel chunk engine, finalize, the
Review FIXING Coordinator). Its CLI (`scripts/relation/s4-cli.mjs`) is keyed and cross-shard: decisions name relation
keys, the Polish write path (#8784) applies them, and the CLI bounds them to relations with an end in the shard. This
module only checks the compact answer grammar against the prepared view; Canonical facts (Sense IDs, POS, existing
keys) are checked by the CLI's save.
"""
from __future__ import annotations

import re
import sys

from . import fixcoord, prbody, refine, stage3
from .refine import NoJudgment, RefineError

TYPES = ("near", "mood", "scene", "sensory", "action", "association")
_SENSE_ID = r"w\d+-s\d+"
_TARGET = rf'(?:{_SENSE_ID}|"[^"]+")'
_LINE = {
    "skip": re.compile(r"skip((?:\s+\d+)+)"),
    "D": re.compile(r"D((?:\s+\d+)+)"),
    "C": re.compile(rf"C\s+(\d+)\s+({'|'.join(TYPES)})\s+([1-9])"),
    "A": re.compile(rf"A\s+(\d+)\s+({_TARGET})\s+({'|'.join(TYPES)})\s+([1-9])"),
    "B": re.compile(rf"B\s+(\d+)\s+({_TARGET})(?:\s+({'|'.join(TYPES)})\s+([1-9]))?"),
    "M": re.compile(r"M\s+(\d+)\s+(\d+)"),
}


def decision_text(answer: str, chunk: str) -> str:
    """Accept only the compact answer contract; the CLI remains the authority for numbers, Senses and keys."""
    if not isinstance(answer, str):
        raise RefineError("Stage 4 answer is missing")
    lines = [line.strip() for line in answer.strip().splitlines() if line.strip()]
    if not lines or lines[0] != f"chunk {chunk}":
        raise RefineError(f"Stage 4 answer must begin with chunk {chunk}")
    if lines[1:] == ["none"]:
        return "\n".join(lines) + "\n"
    if len(lines) < 2 or any(not any(pattern.fullmatch(line) for pattern in _LINE.values()) for line in lines[1:]):
        raise RefineError("Stage 4 answer must contain only skip, D, C, A, B, M lines or none")
    return "\n".join(lines) + "\n"


def decision_context(view: dict, chunk: str) -> dict:
    """The Sense and Relation numbers of the prepared view, in order, with each Relation's direction and Sense."""
    if (not isinstance(view, dict) or view.get("chunk") != chunk or not isinstance(view.get("senses"), list)
            or type(view.get("relation_count")) is not int or type(view.get("sense_count")) is not int):
        raise RefineError(f"Stage 4 prepared view does not match chunk {chunk}")
    senses, relations = [], []
    for sense in view["senses"]:
        if (not isinstance(sense, dict) or type(sense.get("n")) is not int or not isinstance(sense.get("relations"), list)
                or not isinstance(sense.get("record_id"), str)):
            raise RefineError(f"Stage 4 prepared view has an invalid Sense in chunk {chunk}")
        senses.append({"n": sense["n"], "record_id": sense["record_id"]})
        for relation in sense["relations"]:
            if (not isinstance(relation, dict) or type(relation.get("n")) is not int
                    or relation.get("dir") not in ("F", "X", "R")):
                raise RefineError(f"Stage 4 prepared view has an invalid Relation in chunk {chunk}")
            relations.append({"n": relation["n"], "dir": relation["dir"], "sense": sense["n"]})
    if ([s["n"] for s in senses] != list(range(1, len(senses) + 1)) or len(senses) != view["sense_count"]
            or [r["n"] for r in relations] != list(range(1, len(relations) + 1)) or len(relations) != view["relation_count"]):
        raise RefineError(f"Stage 4 prepared view numbering does not match chunk {chunk}")
    return {"chunk": chunk, "sense_count": len(senses), "relation_count": len(relations), "senses": senses,
            "relations": relations}


def validate_prompt_view(prompt_view, context: dict, total: int) -> None:
    """Fail closed unless the compact view binds to the same chunk, Senses, Relations and their order."""
    if not isinstance(prompt_view, str):
        raise RefineError("Stage 4 prompt_view is missing or not text")
    chunk = context["chunk"]
    lines = prompt_view.split("\n")
    header = re.fullmatch(r"chunk (\d+)/(\d+) senses (\d+) relations (\d+)", lines[0])
    if (not header or header.group(1) != chunk or int(header.group(2)) != total
            or int(header.group(3)) != context["sense_count"] or int(header.group(4)) != context["relation_count"]):
        raise RefineError(f"Stage 4 prompt_view header does not match chunk {chunk}")
    expected = iter(context["relations"])
    senses = iter(context["senses"])
    sense, word = None, False
    for line in lines[1:]:
        fields = line.split("\t")
        if any("\\" in re.sub(r"\\[\\tnr]", "", field) for field in fields):
            raise RefineError(f"Stage 4 prompt_view has an invalid escape in chunk {chunk}")
        tag = re.fullmatch(r"(W)|([SFXR])([1-9]\d*)", fields[0])
        if not tag:
            raise RefineError(f"Stage 4 prompt_view has an invalid row tag in chunk {chunk}")
        if tag.group(1):
            if len(fields) != 2:
                raise RefineError(f"Stage 4 prompt_view record row is malformed in chunk {chunk}")
            word = True
            continue
        kind, number = tag.group(2), int(tag.group(3))
        if kind == "S":
            sense = next(senses, None)
            if not word or sense is None or sense["n"] != number or len(fields) != 3:
                raise RefineError(f"Stage 4 prompt_view Sense S{number} does not match chunk {chunk}")
            continue
        relation = next(expected, None)
        if (relation is None or sense is None or relation["n"] != number or relation["dir"] != kind
                or relation["sense"] != sense["n"] or len(fields) != (4 if kind == "X" else 6)
                or not re.fullmatch(r"[1-9]", fields[-1])):
            raise RefineError(f"Stage 4 prompt_view Relation {kind}{number} does not match chunk {chunk}")
    if next(expected, None) is not None or next(senses, None) is not None:
        raise RefineError(f"Stage 4 prompt_view is missing Senses or Relations in chunk {chunk}")


def normalize_decisions(answer: str | None, chunk: str, context: dict) -> tuple[str, list[str]]:
    """Discard lines that cannot bind to this chunk (unknown numbers, a move to another record's Sense, two edits of one
    Relation number); keep every other line. No usable judgment is `NoJudgment`, never an implicit `none`."""
    if (not isinstance(context, dict) or context.get("chunk") != chunk or not isinstance(context.get("senses"), list)
            or not isinstance(context.get("relations"), list)):
        raise RefineError(f"Stage 4 decision context does not match chunk {chunk}")
    senses = {sense["n"]: sense for sense in context["senses"]}
    relations = {relation["n"]: relation for relation in context["relations"]}
    if not isinstance(answer, str):
        raise NoJudgment("Stage 4 answer is missing")
    lines = [line.strip() for line in answer.strip().splitlines() if line.strip()]
    if not lines or lines[0] != f"chunk {chunk}":
        raise NoJudgment(f"Stage 4 answer must begin with chunk {chunk}")
    body = lines[1:]
    if body == ["none"]:
        return f"chunk {chunk}\nnone\n", []
    accepted, warnings, edited = [], [], {}
    for line in body:
        if line == "none":
            warnings.append("다른 판정과 섞인 none 줄 폐기")
            continue
        kind = next((name for name, pattern in _LINE.items() if pattern.fullmatch(line)), None)
        match = _LINE[kind].fullmatch(line) if kind else None
        if kind is None:
            warnings.append(f"형식이 잘못된 판정 줄 폐기: {line[:100]}")
            continue
        if kind == "skip":
            numbers = [int(value) for value in match.group(1).split()]
            known = [number for number in numbers if number in senses]
            if len(known) != len(numbers):
                warnings.append(f"존재하지 않는 Sense 번호의 skip 폐기: {line[:100]}")
            if known:
                accepted.append("skip " + " ".join(map(str, known)))
            continue
        if kind == "D":
            numbers = [int(value) for value in match.group(1).split()]
            for number in numbers:
                if number not in relations:
                    warnings.append(f"Relation {number}: 존재하지 않는 번호의 D 폐기")
                    continue
                edited.setdefault(number, []).append(f"D {number}")
            continue
        if kind == "A":
            if int(match.group(1)) not in senses:
                warnings.append(f"존재하지 않는 Sense 번호의 A 폐기: {line[:100]}")
                continue
            accepted.append(line)
            continue
        number = int(match.group(1))
        if number not in relations:
            warnings.append(f"Relation {number}: 존재하지 않는 번호의 {kind} 폐기")
            continue
        if kind == "M":
            target = senses.get(int(match.group(2)))
            source = senses[relations[number]["sense"]]
            if target is None or target["record_id"] != source["record_id"] or target["n"] == source["n"]:
                warnings.append(f"Relation {number}: 같은 표제어의 다른 Sense가 아닌 M 폐기")
                continue
        edited.setdefault(number, []).append(line)
    for number, proposals in edited.items():
        if len(set(proposals)) != 1:
            warnings.append(f"Relation {number}: 같은 번호의 상충 지시 전부 폐기; 원본 유지")
            continue
        accepted.append(proposals[0])
    if not accepted:
        raise NoJudgment("유효한 skip/D/C/A/B/M 판정이나 명시적 none이 없는 응답입니다")
    return "\n".join([f"chunk {chunk}", *accepted]) + "\n", warnings


SPEC = refine.register(refine.RefineSpec(
    id="s4", tag="s4", label="Stage 4", role="stage4", short="S4", issue=prbody.S4_ISSUE, cli="scripts/relation/s4-cli.mjs",
    scratch="relation-s4", title=prbody.S4_TITLE, issue_link=prbody.S4_ISSUE_LINK,
    detail_title=re.compile(r"\[S4/([A-Za-z0-9-]+)\] (\d{3})"), search_phrases=('"S4"',), legacy_title=None,
    chunk_prompt="s4_chunk", fix_prompt="s4_fix", policy_card="s4_policy_card",
    gate=lambda kv, shard: bool(kv.get(stage3.ok_key(shard))), gate_label="Stage 3",
    rule=sys.modules[__name__],
    fix=fixcoord.FixSpec(prefix="s4", label="Stage 4", response=".warroom-scratch/s4-fix-response.json",
                         amend_input=".warroom-scratch/s4-fix-amend.txt",
                         commit_subject="Apply Stage 4 review amendments", amend_header="amend"),
    cross_shard=True, no_change_complete=True, refusal_keep_all=False, body=prbody.stage4_body))
