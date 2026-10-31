"""War Room control for the one-PR-per-shard Relation Factory Stage 3 editor (#2450)."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from . import batches, stage2
from .store import STAGE3_METHOD

METHOD = STAGE3_METHOD
EDIT_CLI = "scripts/relation/edit-cli.mjs"
SHARDS = 428
_SHARD = re.compile(r"^\d{3}$")
_PR_TITLE = re.compile(r"^\[Relation Stage 3\] (\d{3})$")
_ISSUE_LINK = re.compile(r"(?:#2450|issues/2450)(?!\d)")


class Stage3Error(ValueError):
    pass


@dataclass(frozen=True)
class Choice:
    status: str  # shard | wait | done
    shard: str | None = None
    note: str = ""


def ok_key(shard: str) -> str:
    return f"s3_ok_{shard}"


def run_start_key(batch_id: int) -> str:
    return f"s3_run_start_{batch_id}"


def checkpoint_path(worktree, shard: str) -> Path:
    return Path(worktree) / ".warroom-scratch" / f"relation-edit-{shard}.json"


def checkpoint(worktree, shard: str) -> dict | None:
    """Read the compact CLI checkpoint; its persisted structure is intentionally kept owned by edit-cli."""
    path = checkpoint_path(worktree, shard)
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as error:
        raise Stage3Error(f"Stage 3 checkpoint cannot be read: {error}") from error
    if (not isinstance(value, dict) or value.get("version") != 1 or value.get("shard") != shard
            or type(value.get("chunk_total")) is not int or value["chunk_total"] < 0
            or not isinstance(value.get("completed_chunks"), list)
            or not isinstance(value.get("decisions"), list)):
        raise Stage3Error(f"Stage 3 checkpoint does not match shard {shard}")
    total = value["chunk_total"]
    completed = value["completed_chunks"]
    if any(not isinstance(item, str) or not re.fullmatch(r"\d{3}", item)
           or not 1 <= int(item) <= total for item in completed):
        raise Stage3Error(f"Stage 3 checkpoint has invalid completed chunks for shard {shard}")
    if len(set(completed)) != len(completed):
        raise Stage3Error(f"Stage 3 checkpoint has invalid completed chunks for shard {shard}")
    return value


def progress(state: dict | None) -> tuple[int, int]:
    if state is None:
        return 0, 0
    return len(state["completed_chunks"]), state["chunk_total"]


def next_chunk(state: dict) -> str | None:
    done = set(state["completed_chunks"])
    return next((f"{number:03d}" for number in range(1, state["chunk_total"] + 1)
                 if f"{number:03d}" not in done), None)


def chunk_saved_since(before: dict, after: dict | None) -> bool:
    """The run advanced this shard's checkpoint by exactly its one prepared chunk."""
    if after is None or before["shard"] != after["shard"] or before["chunk_total"] != after["chunk_total"]:
        return False
    old, new = set(before["completed_chunks"]), set(after["completed_chunks"])
    return (len(new - old) == 1 and old <= new and len(new) == len(old) + 1
            and next_chunk(before) in (new - old))


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


def shard_pr(pr: dict) -> str | None:
    match = _PR_TITLE.fullmatch(pr.get("title") or "")
    return match.group(1) if match and _ISSUE_LINK.search(pr.get("body") or "") else None


def validate_pr(pr: dict, files: list[dict]) -> str:
    """Validate a merged/open Stage 3 PR's declared shard against its exact allowed data-file scope."""
    shard = shard_pr(pr)
    if shard is None or pr.get("base_ref") != "master":
        raise Stage3Error(f"PR #{pr.get('number')} is not an issue-linked Relation Stage 3 PR on master")
    if not isinstance(files, list):
        raise Stage3Error(f"PR #{pr.get('number')} changed file list is unavailable")
    allowed = {f"data/relations/relation-{shard}.jsonl", f"data/relation-drops/drop-{shard}.jsonl"}
    paths = [item.get("path") if isinstance(item, dict) else None for item in files]
    if (any(not isinstance(path, str) for path in paths)
            or set(paths) - allowed or len(paths) != len(set(paths))):
        raise Stage3Error(f"PR #{pr.get('number')} changed files do not match Stage 3 shard {shard}")
    return shard


def choose(*, sha: str, kv, open_prs: list[dict], stage2_batches: list, stage3_batches: list,
           pin: str = "", refresh_stage2=None) -> Choice:
    """Pick the earliest current-master Stage 2 verified shard without same-shard ownership or PR conflict.

    `refresh_stage2(shard) -> (ready, detail)` carries an old shard verify only across irrelevant changes, or runs the
    exact shard verify on this master. It is called lazily while considering a shard; missing completion evidence is
    never upgraded into a success.
    """
    occupied_prs: set[str] = set()
    for pr in open_prs:
        occupied_prs |= batches.pr_stage2_shards(pr)
    s2_owned = {row["shard"] for row in stage2_batches if row["state"] != "COMPLETE"}
    s3_done = {row["shard"] for row in stage3_batches if row["state"] == "COMPLETE" and row["merged"]}
    s3_owned = {row["shard"] for row in stage3_batches if row["state"] != "COMPLETE"}
    incomplete: list[str] = []
    stale: list[str] = []
    occupied: list[str] = []
    for number in range(1, SHARDS + 1):
        shard = f"{number:03d}"
        if pin and shard != pin or shard in s3_done:
            continue
        if shard in s2_owned or shard in occupied_prs or shard in s3_owned:
            occupied.append(shard)
            continue
        old = kv.get(stage2.ok_key(shard, None))
        if old == sha:
            return Choice("shard", shard)
        if not old:
            incomplete.append(shard)
            continue
        if refresh_stage2 is None:
            stale.append(f"{shard} (최신 master verify 필요)")
            continue
        ready, detail = refresh_stage2(shard)
        if ready:
            return Choice("shard", shard)
        stale.append(f"{shard} (최신 master verify 실패: {detail})")
        break   # do not run exact verifies across later shards after the earliest stale candidate failed
    if incomplete or stale or occupied:
        reasons = []
        if incomplete:
            reasons.append("Stage 2 미완료(현재 SHA shard verify 성공 기록 없음): " + ", ".join(incomplete[:8]))
        if stale:
            reasons.append("구 SHA shard verify 필요 또는 실패: " + "; ".join(stale[:8]))
        if occupied:
            reasons.append("동일 샤드 작업·PR 점유: " + ", ".join(occupied[:8]))
        return Choice("wait", note="; ".join(reasons))
    if pin:
        return Choice("wait", note=f"고정된 Stage 3 샤드 {pin}이 아직 Stage 2 완료·미점유 상태가 아닙니다")
    return Choice("done", note="Stage 2가 완료된 미점유 Stage 3 샤드가 없습니다")


def cli(runner, env: dict, worktree, *args: str, timeout: int = 900):
    result = runner.run(["node", EDIT_CLI, *args], cwd=worktree, env=env, timeout=timeout)
    if not result.ok:
        raise Stage3Error(" ".join((result.err or result.out).split())[-500:])
    try:
        return json.loads(result.out or "null")
    except ValueError as error:
        raise Stage3Error(f"edit-cli returned invalid JSON: {error}") from error


def prepare(runner, env: dict, worktree, shard: str) -> dict:
    result = cli(runner, env, worktree, "prepare", "--shard", shard)
    if not isinstance(result, dict):
        raise Stage3Error("edit-cli prepare returned an invalid result")
    state = checkpoint(worktree, shard)
    if state is None or result.get("chunk_count") != state["chunk_total"]:
        raise Stage3Error("edit-cli prepare did not create the expected checkpoint")
    return state


def read_chunk(runner, env: dict, worktree, shard: str) -> dict:
    result = cli(runner, env, worktree, "read-chunk", "--shard", shard)
    if not isinstance(result, dict) or not isinstance(result.get("chunk"), str):
        raise Stage3Error("edit-cli read-chunk returned no active chunk")
    state = checkpoint(worktree, shard)
    if state is None or result["chunk"] != next_chunk(state):
        raise Stage3Error("edit-cli read-chunk is not the next checkpoint chunk")
    decision_context(result, result["chunk"])
    return result


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
        repair = re.fullmatch(r"L\s+(\d+)\s+T(\d+)", line)
        if repair:
            add(int(repair.group(1)), "L", f"T{int(repair.group(2))}")
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
    if not accepted and body and not any("none 지시 줄 폐기" in warning for warning in warnings):
        warnings.append("유효한 D/L 제안이 없어 none으로 저장")
    if not body:
        warnings.append("청크 표식 뒤에 D/L 제안이 없어 none으로 저장")
    return normalized, warnings


def save_chunk(runner, env: dict, worktree, shard: str, chunk: str, answer: str) -> dict:
    text = decision_text(answer, chunk)
    scratch = Path(worktree) / ".warroom-scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    input_path = scratch / f"relation-edit-{shard}-decisions.txt"
    input_path.write_text(text, "utf-8")
    result = cli(runner, env, worktree, "save-chunk", "--shard", shard,
                 "--in", f".warroom-scratch/{input_path.name}")
    if not isinstance(result, dict):
        raise Stage3Error("edit-cli save-chunk returned an invalid result")
    return result


def apply(runner, env: dict, worktree, shard: str) -> dict:
    result = cli(runner, env, worktree, "apply", "--shard", shard)
    if not isinstance(result, dict):
        raise Stage3Error("edit-cli apply returned an invalid result")
    return result


def report(runner, env: dict, worktree, shard: str) -> dict:
    scratch = Path(worktree) / ".warroom-scratch"
    scratch.mkdir(parents=True, exist_ok=True)
    output = scratch / f"relation-edit-{shard}-report.json"
    cli(runner, env, worktree, "report", "--shard", shard, "--out", str(output))
    try:
        value = json.loads(output.read_text("utf-8"))
    except (OSError, ValueError) as error:
        raise Stage3Error(f"edit-cli report did not create valid JSON: {error}") from error
    if not isinstance(value, dict) or value.get("shard") != shard:
        raise Stage3Error("edit-cli report returned an invalid shard report")
    return value
