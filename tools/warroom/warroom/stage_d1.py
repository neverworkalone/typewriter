"""D1 (#10171): whole Drop of confirmed Skip Senses — the first Stage of the Drop line, its spec and its answer rule.

D1 runs on the Drop line (`DROP_METHOD`), the refinement engine's second line beside Refinement: the same parallel
chunk engine, finalize, Review FIXING Coordinator and replay, one shard and one PR at a time on its own line. Its CLI
(`scripts/relation/d1-cli.mjs`) shows each confirmed `s` Sense's headword, POS and gloss only; the model gives every
shown Sense one verdict (`D <n> <1-11>`, `N <n...>`, `H <n...>`) and the CLI drops every Relation of the shard's own
Relation file touching a `D` Sense (#10330) through the Relation-only Polish write path. The CLI's save is strict (a missing or conflicting verdict refuses the
answer); this module only checks the compact grammar against the prepared view.
"""
from __future__ import annotations

import re
import sys

from . import fixcoord, prbody, refine, stage3, stage4
from .refine import NoJudgment, RefineError
from .store import DROP_METHOD

CATEGORIES = 11
_LINE = {
    "D": re.compile(r"D\s+([1-9]\d*)\s+([1-9]|1[01])"),
    "N": re.compile(r"N((?:\s+[1-9]\d*)+)"),
    "H": re.compile(r"H((?:\s+[1-9]\d*)+)"),
}


def _lines(answer, chunk: str, error) -> list[str]:
    if not isinstance(answer, str):
        raise error("D1 answer is missing")
    lines = [line.strip() for line in answer.strip().splitlines() if line.strip()]
    if not lines or lines[0] != f"chunk {chunk}":
        raise error(f"D1 answer must begin with chunk {chunk}")
    return lines


def decision_text(answer: str, chunk: str) -> str:
    """Accept only the compact D/N/H grammar; the CLI remains the authority for numbers and full coverage."""
    lines = _lines(answer, chunk, RefineError)
    if len(lines) < 2 or any(not any(pattern.fullmatch(line) for pattern in _LINE.values()) for line in lines[1:]):
        raise RefineError("D1 answer must contain only D, N and H lines")
    return "\n".join(lines) + "\n"


def decision_context(view: dict, chunk: str, record: str | None = None) -> dict:
    """The prepared view's Sense numbers and records, in order. D1 shows no Relation (`relation_count` 0). A record
    view (#10047) keeps the chunk's own numbers."""
    if (not isinstance(view, dict) or view.get("chunk") != chunk or not isinstance(view.get("senses"), list)
            or type(view.get("sense_count")) is not int or view.get("relation_count") != 0):
        raise RefineError(f"D1 prepared view does not match chunk {chunk}")
    senses = []
    for sense in view["senses"]:
        if (not isinstance(sense, dict) or type(sense.get("n")) is not int or not isinstance(sense.get("record_id"), str)
                or sense.get("relations") != []):
            raise RefineError(f"D1 prepared view has an invalid Sense in chunk {chunk}")
        senses.append({"n": sense["n"], "record_id": sense["record_id"]})
    numbers = [sense["n"] for sense in senses]
    numbered = (numbers == list(range(1, len(numbers) + 1)) if record is None
                else all(n >= 1 for n in numbers) and all(a < b for a, b in zip(numbers, numbers[1:])))
    if (not numbered or len(senses) != view["sense_count"]
            or (record is not None and (not senses or view.get("record") != record
                                        or any(s["record_id"] != record for s in senses)))):
        raise RefineError(f"D1 prepared view numbering does not match chunk {chunk}")
    return {"chunk": chunk, "sense_count": len(senses), "relation_count": 0, "senses": senses, "relations": []}


def validate_prompt_view(prompt_view, context: dict, total: int) -> None:
    """Fail closed unless the compact view binds to the same chunk and Senses in order: `W` rows (headword, homograph
    number or `-`) and `S<n>` rows (POS, gloss) only."""
    if not isinstance(prompt_view, str):
        raise RefineError("D1 prompt_view is missing or not text")
    chunk = context["chunk"]
    lines = prompt_view.split("\n")
    header = re.fullmatch(r"chunk (\d+)/(\d+) senses (\d+)", lines[0])
    if (not header or header.group(1) != chunk or int(header.group(2)) != total
            or int(header.group(3)) != context["sense_count"]):
        raise RefineError(f"D1 prompt_view header does not match chunk {chunk}")
    senses = iter(context["senses"])
    word = False
    for line in lines[1:]:
        fields = line.split("\t")
        if any("\\" in re.sub(r"\\[\\tnr]", "", field) for field in fields):
            raise RefineError(f"D1 prompt_view has an invalid escape in chunk {chunk}")
        if fields[0] == "W":
            if len(fields) != 3:
                raise RefineError(f"D1 prompt_view record row is malformed in chunk {chunk}")
            word = True
            continue
        tag = re.fullmatch(r"S([1-9]\d*)", fields[0])
        sense = next(senses, None)
        if not tag or not word or sense is None or sense["n"] != int(tag.group(1)) or len(fields) != 3:
            raise RefineError(f"D1 prompt_view Sense row does not match chunk {chunk}")
    if next(senses, None) is not None:
        raise RefineError(f"D1 prompt_view is missing Senses in chunk {chunk}")


def normalize_decisions(answer: str | None, chunk: str, context: dict) -> tuple[str, list[str]]:
    """Discard only lines that are not D/N/H grammar; keep every other line for the CLI's strict save (a missing,
    repeated or unknown Sense refuses there and the answer is kept, never filled in). No usable line is `NoJudgment`."""
    if not isinstance(context, dict) or context.get("chunk") != chunk or not isinstance(context.get("senses"), list):
        raise RefineError(f"D1 decision context does not match chunk {chunk}")
    lines = _lines(answer, chunk, NoJudgment)
    accepted, warnings = [], []
    for line in lines[1:]:
        if any(pattern.fullmatch(line) for pattern in _LINE.values()):
            accepted.append(" ".join(line.split()))
        else:
            warnings.append(f"형식이 잘못된 판정 줄 폐기: {line[:100]}")
    if not accepted:
        raise NoJudgment("유효한 D/N/H 판정이 없는 응답입니다")
    return "\n".join([f"chunk {chunk}", *accepted]) + "\n", warnings


def _all_stage3(kv, shard: str) -> bool:
    """Every shard's Stage 3 is complete (#10171 §1): the whole factory's gate, kept by #10330."""
    return all(kv.get(stage3.ok_key(f"{number:03d}")) for number in range(1, refine.SHARDS + 1))


def _gate(kv, shard: str) -> bool:
    """D1 SSS starts after every shard's Stage 3 and after Stage 4 SSS completed (#10330): its merged-and-verified PR or
    its official no-change completion, both recorded as `s4_ok_SSS`. An open, reviewing or failed S4 is not complete;
    other shards' S4 progress does not matter."""
    return _all_stage3(kv, shard) and bool(kv.get(stage4.SPEC.ok_key(shard)))


SPEC = refine.register(refine.RefineSpec(
    id="d1", tag="d1", label="D1", role="d1", short="D1", issue=prbody.D1_ISSUE, cli="scripts/relation/d1-cli.mjs",
    scratch="relation-d1", title=prbody.D1_TITLE, issue_link=prbody.D1_ISSUE_LINK,
    detail_title=re.compile(r"\[D1/([A-Za-z0-9-]+)\] (\d{3})"), search_phrases=('"D1"',), legacy_title=None,
    chunk_prompt="d1_chunk", fix_prompt="d1_fix", policy_card="d1_policy_card",
    gate=_gate, gate_label="전체 Stage 3·동일 샤드 Stage 4",
    rule=sys.modules[__name__],
    fix=fixcoord.FixSpec(prefix="d1", label="D1", response=".warroom-scratch/d1-fix-response.json",
                         amend_input=".warroom-scratch/d1-fix-amend.txt",
                         commit_subject="Apply D1 review amendments", amend_header="amend"),
    cross_shard=False, no_change_complete=True, refusal_keep_all=False, refusal_records=True, relations_only=True,
    method=DROP_METHOD, verify_judgments=True, replay_drops_only=True, body=prbody.d1_body))
