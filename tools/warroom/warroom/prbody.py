"""Stage 2/3 PR title and body contract (#2838). Pure functions: every number is an argument measured elsewhere.

A statistic that could not be measured is `None` and is printed as 미측정, never as 0 or a guess.
Legacy titles (`[Stage 2] ...`, `[Relation Stage 3] ...`) stay valid for recovery of existing work.
"""
from __future__ import annotations

import re

S2_ISSUE = 927
S3_ISSUE = 2455
S3_LEGACY_ISSUE = 2450   # the implementation Issue that earlier Stage 3 PRs referenced

S3_TITLE = re.compile(r"^(?:\[Relation Stage 3\]|\[S3/[^\]/\s]+\]) (\d{3})$")
S4_ISSUE = 9929   # the Stage 4 standing production Issue (#9928 implements it)
S4_TITLE = re.compile(r"^\[S4/[^\]/\s]+\] (\d{3})$")
S4_ISSUE_LINK = re.compile(rf"(?:#{S4_ISSUE}|issues/{S4_ISSUE})(?!\d)")
D1_ISSUE = 10171   # the D1 standing production Issue: whole Drop of confirmed Skip Senses
D1_TITLE = re.compile(r"^\[D1/[^\]/\s]+\] (\d{3})$")
D1_ISSUE_LINK = re.compile(rf"(?:#{D1_ISSUE}|issues/{D1_ISSUE})(?!\d)")
S3_ISSUE_LINK = re.compile(rf"(?:#(?:{S3_ISSUE}|{S3_LEGACY_ISSUE})|issues/(?:{S3_ISSUE}|{S3_LEGACY_ISSUE}))(?!\d)")

_COUNT_KEYS = ("unique", "skipped_existing", "reverse_covered", "merged_duplicates", "raw", "missing")


def s2_title(model: str, shard: str, batch: str, part: str) -> str:
    return f"[S2/{model}] {shard}_{batch} Part {part}"


def s2_legacy_title(shard: str, batch: str, part: str) -> str:
    return f"[Stage 2] {shard}_{batch} Part {part}"


def s3_title(model: str, shard: str) -> str:
    return f"[S3/{model}] {shard}"


def s3_legacy_title(shard: str) -> str:
    return f"[Relation Stage 3] {shard}"


def _count(value) -> int | None:
    return value if type(value) is int and value >= 0 else None


def _n(value) -> str:
    return "미측정" if value is None else str(value)


def stage2_counts_problem(counts) -> str | None:
    """Reject verify counts that do not add up; a partly absent shape is handled as unmeasured, not as zero."""
    if not isinstance(counts, dict):
        return "verify 응답에 counts가 없습니다"
    values = {key: counts.get(key) for key in _COUNT_KEYS}
    if any(_count(value) is None for value in values.values()):
        return f"verify counts가 완전하지 않습니다: {values}"
    if values["missing"] != 0:
        return f"verify counts에 누락 후보가 있습니다: {values['missing']}"
    if values["raw"] - values["merged_duplicates"] != values["unique"]:
        return f"raw−중복이 unique와 다릅니다: {values}"
    if values["skipped_existing"] + values["reverse_covered"] > values["unique"]:
        return f"기승인+역방향 흡수가 unique를 넘습니다: {values}"
    return None


def stage2_body(model: str, shard: str, batch: str, part: str, *, counts: dict | None, delta: dict | None,
                part_verify: bool, exact_verify: bool) -> str:
    """`counts` is the Part-scoped `admission-cli verify --json` counts; `delta` the Part commit's new row counts."""
    counts = counts if counts is not None and stage2_counts_problem(counts) is None else None
    records, senses = (_count(counts.get("records")), _count(counts.get("senses"))) if counts else (None, None)
    coverage = "미측정" if records is None or senses is None else f"{records} records / {senses} senses"
    get = (lambda key: counts.get(key)) if counts else (lambda key: None)
    new = (lambda key: _count(delta.get(key))) if isinstance(delta, dict) else (lambda key: None)
    failure_candidates = delta.get("automation_failure_candidates") if isinstance(delta, dict) else None
    if isinstance(failure_candidates, list) and all(
            isinstance(row, dict) and all(isinstance(row.get(key), str) for key in ("record_id", "sense_id", "candidate"))
            for row in failure_candidates):
        failure_candidate_list = "; ".join(
            f"{row['record_id']}/{row['sense_id']}: {row['candidate']}" for row in failure_candidates
        ) or "none"
        failure_count = len(failure_candidates)
    else:
        failure_candidate_list, failure_count = "미측정", None
    return "\n".join([
        "- Method: S2",
        f"- Model: {model}",
        f"- Shard: {shard}",
        f"- Batch: {batch}",
        f"- Part: {part}",
        f"- Coverage: {coverage}",
        f"- Unique Candidates: {_n(get('unique'))}",
        f"- New Relations: {_n(new('relations'))}",
        f"- New Drops: {_n(new('drops'))}",
        f"- Technical Failure Drops (f): {_n(failure_count)}",
        f"- Technical Failure Candidates: {failure_candidate_list}",
        f"- Duplicates: {_n(get('merged_duplicates'))}",
        f"- Already Approved: {_n(get('skipped_existing'))}",
        f"- Reverse Absorbed: {_n(get('reverse_covered'))}",
        f"- Part Verify: {'PASS' if part_verify else '미실시'}",
        f"- Exact PR HEAD Verify: {'PASS' if exact_verify else '미실시'}",
        "",
        f"Refs #{S2_ISSUE}",
    ]) + "\n"


def stage3_body(model: str, shard: str, *, result: dict, apply_pass: bool, shard_verify: bool,
                cost: str | None = None, method: str = "S3", issue: int = S3_ISSUE) -> str:
    """`result` is the persisted apply/report outcome; missing members stay unmeasured."""
    reviewed, done, total = _count(result.get("reviewed")), _count(result.get("chunks_done")), _count(result.get("chunks_total"))
    chunks = "미측정" if done is None or total is None else f"{done}/{total}"
    lines = [
        f"- Method: {method}",
        f"- Model: {model}",
        f"- Shard: {shard}",
        "- Scope: Shard-wide editorial audit",
        f"- Reviewed Relations: {_n(reviewed)}",
        f"- Completed Chunks: {chunks}",
        f"- Removed Relations: {_n(_count(result.get('removed')))}",
        f"- Link Repairs: {_n(_count(result.get('repaired')))}",
        f"- Added Orphan Drops (z): {_n(_count(result.get('edit_drops_added')))}",
        f"- Edit Apply: {'PASS' if apply_pass else '미실시'}",
        f"- Shard Verify: {'PASS' if shard_verify else '미실시'}",
    ]
    if cost:
        lines.append(f"- Token Cost / Duration: {cost}")
    return "\n".join(lines + ["", f"Refs #{issue}"]) + "\n"


def run_cost(runs) -> str | None:
    """Sum total input + output tokens and wall time of recorded runs, only if every run was measured; otherwise None (never a partial sum)."""
    rows = list(runs)
    if not rows:
        return None
    tokens = 0
    seconds = 0.0
    for row in rows:
        # input_tokens already includes cached/cache-write input (usage.py), so cache fields are never added again.
        if row["input_tokens"] is None or row["output_tokens"] is None or row["ended_at"] is None:
            return None
        tokens += row["input_tokens"] + row["output_tokens"]
        seconds += max(0.0, row["ended_at"] - row["started_at"])
    return f"{tokens} tokens / {round(seconds / 60)} min"



def stage4_sense_summary(result: dict) -> str:
    selection = result.get("selection") if isinstance(result.get("selection"), dict) else {}
    senses = result.get("senses") if isinstance(result.get("senses"), dict) else {}
    return (f"Senses: {_n(_count(senses.get('total')))} "
            f"(input p {_n(_count(selection.get('p')))}, s {_n(_count(selection.get('s')))}, "
            f"e {_n(_count(selection.get('e')))}; Polish {_n(_count(senses.get('polished')))}, "
            f"Policy Skip {_n(_count(senses.get('policy_skipped')))})")


def stage4_body(model: str, shard: str, *, result: dict, cost: str | None = None) -> str:
    """The Stage 4 PR body from the persisted apply result (#9928); missing members stay unmeasured."""
    decisions = result.get("decisions") if isinstance(result.get("decisions"), dict) else {}
    done, total = _count(result.get("chunks_done")), _count(result.get("chunks_total"))
    shards = result.get("affected_shards") if isinstance(result.get("affected_shards"), list) else None
    conflicts = result.get("conflicts")
    lines = [
        "- Method: S4",
        f"- Model: {model}",
        f"- Shard: {shard}",
        "- Scope: Preselected p Senses (Add / Drop / Set / Rebind)",
        f"- Completed Chunks: {'미측정' if done is None or total is None else f'{done}/{total}'}",
        f"- {stage4_sense_summary(result)}",
        f"- Decisions: Add {_n(_count(decisions.get('add')))}, Drop {_n(_count(decisions.get('drop')))}, "
        f"Set {_n(_count(decisions.get('set')))}, Rebind {_n(_count(decisions.get('rebind')))}",
        f"- Key Conflicts Resolved: {_n(len(conflicts) if isinstance(conflicts, list) else None)}",
        f"- Affected Shards: {', '.join(shards) if shards else '미측정'}",
        "- Edit Apply: PASS",
        "- Affected Shard Relation Verify: PASS",
    ]
    if cost:
        lines.append(f"- Token Cost / Duration: {cost}")
    return "\n".join(lines + ["", f"Refs #{S4_ISSUE}"]) + "\n"


def d1_sense_summary(result: dict) -> str:
    """The D1 judgment counts of an apply result (#10171): judged `s` Senses and their verdicts."""
    senses = result.get("senses") if isinstance(result.get("senses"), dict) else {}
    return (f"Skip Senses: {_n(_count(senses.get('skip_senses')))} (judged {_n(_count(senses.get('judged')))}, "
            f"no Relation {_n(_count(senses.get('no_relations')))}; D {_n(_count(senses.get('dropped')))}, "
            f"N {_n(_count(senses.get('not_target')))}, H {_n(_count(senses.get('held')))}, "
            f"Policy Skip {_n(_count(senses.get('policy_skipped')))})")


def d1_body(model: str, shard: str, *, result: dict, cost: str | None = None) -> str:
    """The D1 PR body from the persisted apply result (#10171 §5); missing members stay unmeasured."""
    senses = result.get("senses") if isinstance(result.get("senses"), dict) else {}
    categories = senses.get("by_category") if isinstance(senses.get("by_category"), dict) else None
    done, total = _count(result.get("chunks_done")), _count(result.get("chunks_total"))
    files = result.get("changed_files") if isinstance(result.get("changed_files"), list) else None
    shards = sorted({m.group(1) for path in files or [] if (m := re.search(r"relation-(\d{3})\.jsonl$", str(path)))})
    lines = [
        "- Method: D1",
        f"- Model: {model}",
        f"- Shard: {shard}",
        "- Scope: Confirmed s Senses, whole Drop by the #10171 categories (own Relation file only)",
        f"- Completed Chunks: {'미측정' if done is None or total is None else f'{done}/{total}'}",
        f"- {d1_sense_summary(result)}",
        f"- D by Category: {', '.join(f'{k}: {v}' for k, v in categories.items()) if categories else '없음' if categories == {} else '미측정'}",
        f"- Removed Relations: {_n(_count(result.get('removed_relations')))}",
        f"- Changed Files: {_n(len(files) if files is not None else None)} ({len(shards)} shards)",
        "- Edit Apply: PASS",
        "- D1 Deletion Verify: PASS",
    ]
    if cost:
        lines.append(f"- Token Cost / Duration: {cost}")
    return "\n".join(lines + ["", f"Refs #{D1_ISSUE}"]) + "\n"
