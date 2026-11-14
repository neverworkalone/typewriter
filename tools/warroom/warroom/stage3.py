"""Stage 3 (#2450, #2455): the first refinement Stage — its spec, its chunk answer rule, and the shared line's keys.

The Stage-independent War Room operations (checkpoint, chunk read/save, apply, report, PR scope, next-shard choice)
live in `refine.RefineOps`; this module binds them to the Stage 3 spec under their historical names, so `stage3` is
both the Stage 3 operations and the Stage 3 answer rule (`decision_text`, `decision_context`, `validate_prompt_view`,
`normalize_decisions`).
"""
from __future__ import annotations

import re
import sys

from . import fixcoord, prbody, refine, stage2
from .refine import SHARDS, Choice, RefineError as Stage3Error  # noqa: F401 - historical names
from .store import STAGE3_METHOD

METHOD = STAGE3_METHOD
EDIT_CLI = "scripts/relation/edit-cli.mjs"
_SHARD = re.compile(r"^\d{3}$")


def run_start_key(batch_id: int) -> str:
    return f"s3_run_start_{batch_id}"


PARALLEL = "parallel"
TASKS_DIR = ".warroom-scratch/s3-tasks"


def mode_key(batch_id: int) -> str:
    """"parallel" for a shard that started with the chunk-task scheduler (#3149); no key = finish serially."""
    return f"s3_mode_{batch_id}"


def plan_key(batch_id: int) -> str:
    """"open" while the chunk tasks own the checkpoint, "closed" once every chunk is saved."""
    return f"s3_plan_{batch_id}"


def parallel_start_key(batch_id: int) -> str:
    return f"s3_parallel_start_{batch_id}"


def task_path(task: str, name: str) -> str:
    return f"{TASKS_DIR}/{task}/{name}"


def decision_text(answer: str, chunk: str) -> str:
    """Accept only the compact answer contract; the edit CLI remains the authority for row/target validation."""
    if not isinstance(answer, str):
        raise Stage3Error("Stage 3 answer is missing")
    lines = [line.strip() for line in answer.strip().splitlines() if line.strip()]
    if not lines or lines[0] != f"chunk {chunk}":
        raise Stage3Error(f"Stage 3 answer must begin with chunk {chunk}")
    if len(lines) == 2 and lines[1] == "none":
        return "\n".join(lines) + "\n"
    if len(lines) < 2 or any(not re.fullmatch(r"(?:D\s+\d+(?:\s+\d+)*|L\s+\d+\s+T\d+)", line)
                             for line in lines[1:]):
        raise Stage3Error("Stage 3 answer must contain only D <row...>, L <row> T<target>, or none")
    return "\n".join(lines) + "\n"


def validate_prompt_view(prompt_view, context: dict, total: int) -> None:
    """Fail closed unless the compact view binds to the same chunk, Relation numbers/order and T aliases as the JSON view."""
    if not isinstance(prompt_view, str):
        raise Stage3Error("Stage 3 prompt_view is missing or not text")
    chunk = context["chunk"]
    lines = prompt_view.split("\n")
    header = re.fullmatch(r"chunk (\d+)/(\d+) relations (\d+)", lines[0])
    if (not header or header.group(1) != chunk or int(header.group(2)) != total
            or int(header.group(3)) != context["relation_count"]):
        raise Stage3Error(f"Stage 3 prompt_view header does not match chunk {chunk}")
    expected = iter(context["relations"])
    sense_relations = 0
    current = None
    sense_seen = False
    aliases: list[str] = []

    def close_relation() -> None:
        if current is not None and aliases != [target["alias"] for target in current["targets"]]:
            raise Stage3Error(f"Stage 3 prompt_view target aliases do not match Relation {current['n']}")

    for line in lines[1:]:
        fields = line.split("\t")
        if any("\\" in re.sub(r"\\[\\tnr]", "", field) for field in fields):
            raise Stage3Error(f"Stage 3 prompt_view has an invalid escape in chunk {chunk}")
        tag = re.fullmatch(r"([SIXT])([1-9]\d*)?", fields[0])
        if not tag or (tag.group(1) == "S") != (tag.group(2) is None):
            raise Stage3Error(f"Stage 3 prompt_view has an invalid row tag in chunk {chunk}")
        kind = tag.group(1)
        if kind == "S":
            close_relation()
            current = None
            if sense_relations == 0 and sense_seen:
                raise Stage3Error(f"Stage 3 prompt_view has an empty Source Sense in chunk {chunk}")
            sense_seen, sense_relations = True, 0
            if len(fields) != 4:
                raise Stage3Error(f"Stage 3 prompt_view Sense row is malformed in chunk {chunk}")
        elif not sense_seen:
            raise Stage3Error(f"Stage 3 prompt_view row precedes its Source Sense in chunk {chunk}")
        elif kind == "T":
            if current is None or not current["text_only"] or len(fields) != 4:
                raise Stage3Error(f"Stage 3 prompt_view has a misplaced target row in chunk {chunk}")
            aliases.append(fields[0])
        else:
            close_relation()
            number = int(tag.group(2))
            current = next(expected, None)
            if current is None or current["n"] != number or current["text_only"] != (kind == "X"):
                raise Stage3Error(f"Stage 3 prompt_view Relation {kind}{number} does not match chunk {chunk}")
            if not re.fullmatch(r"[1-9]\d*", fields[3] if len(fields) > 3 else ""):
                raise Stage3Error(f"Stage 3 prompt_view Relation {number} tier is invalid")
            if len(fields) not in ((4,) if kind == "X" else (4, 6)):
                raise Stage3Error(f"Stage 3 prompt_view Relation {number} is malformed")
            aliases, sense_relations = [], sense_relations + 1
    close_relation()
    if next(expected, None) is not None or (context["relation_count"] and sense_relations == 0):
        raise Stage3Error(f"Stage 3 prompt_view is missing Relations in chunk {chunk}")


def decision_context(view: dict, chunk: str) -> dict:
    """Keep only the source-bound facts the Supervisor needs to validate AI edit proposals."""
    if (not isinstance(view, dict) or view.get("chunk") != chunk
            or not isinstance(view.get("senses"), list)
            or type(view.get("relation_count")) is not int or view["relation_count"] < 0):
        raise Stage3Error(f"Stage 3 prepared view does not match chunk {chunk}")
    relations = []
    numbers = set()
    for sense in view["senses"]:
        if not isinstance(sense, dict) or not isinstance(sense.get("relations"), list):
            raise Stage3Error(f"Stage 3 prepared view has an invalid Sense group in chunk {chunk}")
        for relation in sense["relations"]:
            if not isinstance(relation, dict) or type(relation.get("n")) is not int or relation["n"] < 1:
                raise Stage3Error(f"Stage 3 prepared view has an invalid Relation number in chunk {chunk}")
            number = relation["n"]
            if number in numbers:
                raise Stage3Error(f"Stage 3 prepared view repeats Relation number {number} in chunk {chunk}")
            numbers.add(number)
            text_only = "text" in relation
            targets = []
            if text_only:
                if not isinstance(relation.get("text"), str) or not isinstance(relation.get("targets"), list):
                    raise Stage3Error(f"Stage 3 prepared view has invalid text-only Relation {number} in chunk {chunk}")
                for target in relation["targets"]:
                    if (not isinstance(target, dict) or not isinstance(target.get("alias"), str)
                            or not re.fullmatch(r"T[1-9]\d*", target["alias"])
                            or not isinstance(target.get("record_id"), str) or not target["record_id"]
                            or not isinstance(target.get("sense_id"), str) or not target["sense_id"]):
                        raise Stage3Error(f"Stage 3 prepared view has an invalid target alias for Relation {number}")
                    targets.append({"alias": target["alias"], "record_id": target["record_id"],
                                    "sense_id": target["sense_id"]})
                if len(targets) != len({target["alias"] for target in targets}):
                    raise Stage3Error(f"Stage 3 prepared view repeats a target alias for Relation {number}")
            elif "targets" in relation:
                raise Stage3Error(f"Stage 3 prepared view has targets on ID-linked Relation {number} in chunk {chunk}")
            relations.append({"n": number, "text_only": text_only, "targets": targets})
    if len(relations) != view["relation_count"]:
        raise Stage3Error(f"Stage 3 prepared view Relation count does not match chunk {chunk}")
    return {"chunk": chunk, "relation_count": len(relations), "relations": relations}


def normalize_decisions(answer: str | None, chunk: str, context: dict) -> tuple[str, list[str]]:
    """Deterministically discard invalid per-Relation proposals before the strict edit CLI sees them.

    The returned warnings describe discarded proposals or body lines. Each body line is independent; a missing or
    mismatched chunk header fails closed because its decisions cannot be bound to the active chunk.
    """
    if (not isinstance(context, dict) or context.get("chunk") != chunk
            or type(context.get("relation_count")) is not int or not isinstance(context.get("relations"), list)):
        raise Stage3Error(f"Stage 3 decision context does not match chunk {chunk}")
    by_number = {}
    for relation in context["relations"]:
        if (not isinstance(relation, dict) or type(relation.get("n")) is not int or relation["n"] < 1
                or relation["n"] in by_number or type(relation.get("text_only")) is not bool
                or not isinstance(relation.get("targets"), list)):
            raise Stage3Error(f"Stage 3 decision context is invalid for chunk {chunk}")
        targets = relation["targets"]
        if (any(not isinstance(target, dict) or not isinstance(target.get("alias"), str)
                or not re.fullmatch(r"T[1-9]\d*", target["alias"])
                or not isinstance(target.get("record_id"), str) or not target["record_id"]
                or not isinstance(target.get("sense_id"), str) or not target["sense_id"] for target in targets)
                or len(targets) != len({target.get("alias") for target in targets if isinstance(target, dict)})):
            raise Stage3Error(f"Stage 3 decision context has invalid target aliases for Relation {relation['n']}")
        by_number[relation["n"]] = relation
    if len(by_number) != context["relation_count"]:
        raise Stage3Error(f"Stage 3 decision context Relation count does not match chunk {chunk}")

    if not isinstance(answer, str):
        raise Stage3Error("Stage 3 answer is missing")
    lines = [line.strip() for line in answer.strip().splitlines() if line.strip()]
    if not lines or lines[0] != f"chunk {chunk}":
        raise Stage3Error(f"Stage 3 answer must begin with chunk {chunk}")
    proposals: dict[int, list[tuple[str, str | None]]] = {}
    warnings: list[str] = []

    def add(number: int, action: str | None, target: str | None = None) -> None:
        proposals.setdefault(number, []).append((action or "invalid", target))

    body = lines[1:]
    if body == ["none"]:
        return f"chunk {chunk}\nnone\n", []

    for line in body:
        if line == "none":
            warnings.append("혼합된 본문의 none 지시 줄 폐기; 다른 D/L은 계속 판정")
            continue
        drop = re.fullmatch(r"D\s+(\d+(?:\s+\d+)*)", line)
        if drop:
            for raw_number in re.split(r"\s+", drop.group(1)):
                add(int(raw_number), "D")
            continue
        tokens = line.split()
        if tokens and tokens[0] == "L":
            pairs = tokens[1:]
            if (len(pairs) >= 2 and len(pairs) % 2 == 0
                    and all(re.fullmatch(r"\d+", pairs[index])
                            and re.fullmatch(r"T\d+", pairs[index + 1])
                            for index in range(0, len(pairs), 2))):
                for index in range(0, len(pairs), 2):
                    add(int(pairs[index]), "L", f"T{int(pairs[index + 1][1:])}")
                continue
        # Retain the row identity when the proposal is malformed so only that row is kept.
        malformed = re.match(r"(?:D|L)\s+(\d+)(?:\s+|$)", line)
        if malformed:
            row_numbers = ([int(value) for value in line.split()[1:] if re.fullmatch(r"\d+", value)]
                           if line.startswith("D") else [int(malformed.group(1))])
            if row_numbers:
                warnings.append(f"Relation {', '.join(map(str, row_numbers))}: 잘못된 제안 줄만 폐기; 원본 유지")
            else:
                warnings.append(f"Relation 번호를 식별할 수 없는 제안 줄 폐기: {line[:100]}")
            continue
        warnings.append(f"Relation 번호를 식별할 수 없는 제안 줄 폐기: {line[:100]}")

    accepted = []
    for number, row_proposals in proposals.items():
        relation = by_number.get(number)
        if relation is None:
            warnings.append(f"Relation {number}: 존재하지 않는 번호의 제안 폐기; 원본 유지")
            continue
        if len(row_proposals) != 1:
            warnings.append(f"Relation {number}: 중복 또는 상충 지시 전부 폐기; 원본 유지")
            continue
        action, target = row_proposals[0]
        if action == "D":
            accepted.append(f"D {number}")
            continue
        if action != "L":
            warnings.append(f"Relation {number}: 형식이 잘못된 제안 폐기; 원본 유지")
            continue
        if not relation["text_only"]:
            warnings.append(f"Relation {number}: ID-linked Relation에 대한 Link Repair 폐기; 원본 유지")
            continue
        if not any(candidate["alias"] == target for candidate in relation["targets"]):
            warnings.append(f"Relation {number}: 실제 후보가 아닌 {target} Link Repair 폐기; 원본 유지")
            continue
        accepted.append(f"L {number} {target}")
    normalized = "\n".join([f"chunk {chunk}", *accepted]) + "\n" if accepted else f"chunk {chunk}\nnone\n"
    if not body:
        warnings.append("청크 표식 뒤에 D/L 제안이 없어 none으로 저장")
    return normalized, warnings


SPEC = refine.register(refine.RefineSpec(
    id="s3", tag="all", label="Stage 3", short="S3", issue=prbody.S3_ISSUE, cli=EDIT_CLI, scratch="relation-edit",
    title=prbody.S3_TITLE,   # new `[S3/<Model>] SSS` and legacy `[Relation Stage 3] SSS` (#2838)
    issue_link=prbody.S3_ISSUE_LINK,   # #2455 (production contract) or legacy #2450
    detail_title=re.compile(r"(?:\[S3/([A-Za-z0-9-]+)\]|\[Relation Stage 3\]) (\d{3})"),
    search_phrases=('"S3"', '"Relation Stage 3"'), legacy_title=prbody.s3_legacy_title,
    chunk_prompt="s3_chunk", fix_prompt="s3_fix", policy_card="s3_policy_card",
    gate=lambda kv, shard: bool(kv.get(stage2.ok_key(shard, None))), gate_label="Stage 2",
    rule=sys.modules[__name__],
    # #6555: a Stage 3 review fix submits only its judgment; the Review FIXING Coordinator applies it with `amend`.
    fix=fixcoord.FixSpec(prefix="s3", label="Stage 3", response=".warroom-scratch/s3-fix-response.json",
                         amend_input=".warroom-scratch/s3-fix-amend.txt",
                         commit_subject="Apply Stage 3 review amendments", amend_header="amend"),
    module=sys.modules[__name__]))
OPS = refine.RefineOps(SPEC)
ok_key = SPEC.ok_key
progress, next_chunk, chunk_saved_since = refine.progress, refine.next_chunk, refine.chunk_saved_since
checkpoint_path, checkpoint = OPS.checkpoint_path, OPS.checkpoint
shard_pr, validate_pr, choose = OPS.shard_pr, OPS.validate_pr, OPS.choose
cli, prepare, apply, report = OPS.cli, OPS.prepare, OPS.apply, OPS.report
read_chunk_prompt, read_chunk, refresh_pending_chunks = OPS.read_chunk_prompt, OPS.read_chunk, OPS.refresh_pending_chunks
save_chunk, read_chunk_by_number, save_chunk_by_number = OPS.save_chunk, OPS.read_chunk_by_number, OPS.save_chunk_by_number
