"""Refinement Stages (#6555): one War Room line for every Stage that refines already-approved Relations (S3 onward).

S3, S4, ... S10 are the same kind of work: a shard's approved Relations are judged in prepared chunks, the decisions are
applied by that Stage's official CLI (built on `scripts/relation/refine/core.mjs`), and one PR per shard is reviewed and
merged. They run one after another on the same War Room line (`s3` method), each Stage gated per shard on the Stage
before it, exactly as Stage 3 is gated on Stage 2. A Stage is therefore one `RefineSpec`: what differs is only its
CLI, its prompts and policy card, its answer rule, its PR naming and its gate. Everything else — parallel chunk tasks,
finalize, merge verify, the Review FIXING Coordinator, Maintainer handling — is shared and keyed by the batch's Stage.

A batch records its Stage in `batches.batch` (`spec.tag`); Stage 3 keeps its historical tag `all`.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

SHARDS = 428


class RefineError(ValueError):
    pass


@dataclass(frozen=True)
class Choice:
    status: str  # shard | wait | done | unready
    shard: str | None = None
    note: str = ""


@dataclass(frozen=True)
class RefineSpec:
    id: str                     # "s3": branch/worktree/kv prefix and the CLI-facing name
    tag: str                    # `batches.batch` of this Stage's batches ("all" for Stage 3)
    label: str                  # "Stage 3"
    short: str                  # "S3": PR title prefix `[S3/<Model>] SSS`
    issue: int                  # production contract Issue linked from every PR body
    cli: str                    # repository-relative Stage CLI
    scratch: str                # CLI scratch prefix: `.warroom-scratch/<scratch>-SSS.json`
    title: re.Pattern           # an accepted PR title; group(1) is the shard
    issue_link: re.Pattern      # an accepted PR body Issue link
    detail_title: re.Pattern    # PR detail title; group(1) the model (or None for a legacy title), group(2) the shard
    search_phrases: tuple       # GitHub title search phrases that find every production PR of this Stage
    legacy_title: Callable | None   # shard -> the pre-#2838 title still accepted on recovery, or None
    chunk_prompt: str           # prompt template names
    fix_prompt: str
    policy_card: str
    gate: Callable              # (kv, shard) -> True when the previous Stage completed this shard
    gate_label: str             # "Stage 2"
    rule: object                # the Stage's answer rule: decision_text, decision_context, validate_prompt_view,
                                # normalize_decisions (see `stage3`)
    fix: object                 # its `fixcoord.FixSpec`
    module: object = None       # an ops module that replaces `RefineOps(spec)` (Stage 3 keeps `stage3`)

    def title_for(self, model: str, shard: str) -> str:
        return f"[{self.short}/{model}] {shard}"

    def branch(self, model: str, shard: str) -> str:
        return f"{self.id}-{model}-{shard}"

    def worktree_name(self, shard: str) -> str:
        return f"{self.id}-{shard}"

    def ok_key(self, shard: str) -> str:
        return f"{self.id}_ok_{shard}"

    def allowed(self, shard: str) -> set:
        return {f"data/relations/relation-{shard}.jsonl", f"data/relation-drops/drop-{shard}.jsonl"}


_REGISTRY: list[RefineSpec] = []
_OPS: dict[str, object] = {}


def register(spec: RefineSpec) -> RefineSpec:
    if any(existing.id == spec.id or existing.tag == spec.tag for existing in _REGISTRY):
        raise ValueError(f"refinement Stage {spec.id} is registered twice")
    _REGISTRY.append(spec)
    return spec


def stages() -> list[RefineSpec]:
    """Every refinement Stage in run order (Stage 3 first)."""
    from . import stage3  # noqa: F401 - registers Stage 3
    return list(_REGISTRY)


def spec_for(b) -> RefineSpec:
    tag = b["batch"]
    for spec in stages():
        if spec.tag == tag:
            return spec
    raise RefineError(f"batch {b['id']} has no registered refinement Stage ({tag!r})")


def ops_for(spec: RefineSpec):
    if spec.module is not None:
        return spec.module
    return _OPS.setdefault(spec.id, RefineOps(spec))


def ops(b):
    """The Stage operations of a refinement batch (`stage3` for Stage 3 batches)."""
    return ops_for(spec_for(b))


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


class RefineOps:
    """The War Room side of one refinement Stage's CLI: checkpoint, chunk views and saves, apply, report, PR scope and
    the next-shard choice. Every message names the Stage; the answer grammar and view checks are its rule's."""

    def __init__(self, spec: RefineSpec):
        self.spec = spec
        self.cli_name = Path(spec.cli).stem

    def _error(self, message: str) -> RefineError:
        return RefineError(message)

    def checkpoint_path(self, worktree, shard: str) -> Path:
        return Path(worktree) / ".warroom-scratch" / f"{self.spec.scratch}-{shard}.json"

    def checkpoint(self, worktree, shard: str) -> dict | None:
        """Read the compact CLI checkpoint; its persisted structure is intentionally kept owned by the Stage CLI."""
        label = self.spec.label
        path = self.checkpoint_path(worktree, shard)
        if not path.exists():
            return None
        try:
            value = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError) as error:
            raise RefineError(f"{label} checkpoint cannot be read: {error}") from error
        if (not isinstance(value, dict) or value.get("version") != 1 or value.get("shard") != shard
                or type(value.get("chunk_total")) is not int or value["chunk_total"] < 0
                or not isinstance(value.get("completed_chunks"), list)
                or not isinstance(value.get("decisions"), list)):
            raise RefineError(f"{label} checkpoint does not match shard {shard}")
        total = value["chunk_total"]
        completed = value["completed_chunks"]
        if any(not isinstance(item, str) or not re.fullmatch(r"\d{3}", item)
               or not 1 <= int(item) <= total for item in completed):
            raise RefineError(f"{label} checkpoint has invalid completed chunks for shard {shard}")
        if len(set(completed)) != len(completed):
            raise RefineError(f"{label} checkpoint has invalid completed chunks for shard {shard}")
        return value

    progress = staticmethod(progress)
    next_chunk = staticmethod(next_chunk)
    chunk_saved_since = staticmethod(chunk_saved_since)

    def ok_key(self, shard: str) -> str:
        return self.spec.ok_key(shard)

    def shard_pr(self, pr: dict) -> str | None:
        match = self.spec.title.fullmatch(pr.get("title") or "")
        return match.group(1) if match and self.spec.issue_link.search(pr.get("body") or "") else None

    def validate_pr(self, pr: dict, files: list[dict]) -> str:
        """Validate a merged/open PR's declared shard against its exact allowed data-file scope."""
        label = self.spec.label
        shard = self.shard_pr(pr)
        if shard is None or pr.get("base_ref") != "master":
            raise RefineError(f"PR #{pr.get('number')} is not an issue-linked Relation {label} PR on master")
        if not isinstance(files, list):
            raise RefineError(f"PR #{pr.get('number')} changed file list is unavailable")
        paths = [item.get("path") if isinstance(item, dict) else None for item in files]
        if (any(not isinstance(path, str) for path in paths)
                or set(paths) - self.spec.allowed(shard) or len(paths) != len(set(paths))):
            raise RefineError(f"PR #{pr.get('number')} changed files do not match {label} shard {shard}")
        return shard

    def choose(self, *, kv, open_prs: list[dict], stage2_batches: list, stage3_batches: list,
               latest_pr=None, pin: str = "") -> Choice:
        """Select exactly the successor of the last merged production shard of this Stage."""
        from . import batches

        spec, label = self.spec, self.spec.label
        previous = int(spec.title.fullmatch(latest_pr["title"]).group(1)) if latest_pr else 0
        if previous >= SHARDS:
            return Choice("done", note=f"{label} 전체 샤드 생산이 완료되었습니다.")
        shard = f"{previous + 1:03d}"
        if pin and pin != shard:
            return Choice("unready", note=f"고정 샤드 {pin}와 {label} 순차 대상 {shard} 불일치 / 실행 종료")
        own = [row for row in stage3_batches if row["batch"] == spec.tag]
        if any(row["shard"] == shard and row["state"] == "COMPLETE" and row["merged"] for row in own):
            return Choice("wait", note=f"샤드 {shard} 완료의 GitHub 검색 반영 대기")
        if (any(row["shard"] == shard and row["state"] != "COMPLETE" for row in stage2_batches + stage3_batches)
                or any(shard in batches.pr_stage2_shards(pr) for pr in open_prs)):
            return Choice("wait", note=f"샤드 {shard} 작업·PR 점유")
        if not spec.gate(kv, shard):
            return Choice("unready", note=f"다음 샤드 {shard} {spec.gate_label} 미완료 / 실행 종료")
        return Choice("shard", shard)

    def cli(self, runner, env: dict, worktree, *args: str, timeout: int = 900):
        result = runner.run(["node", self.spec.cli, *args], cwd=worktree, env=env, timeout=timeout)
        if not result.ok:
            raise RefineError(" ".join((result.err or result.out).split())[-500:])
        try:
            return json.loads(result.out or "null")
        except ValueError as error:
            raise RefineError(f"{self.cli_name} returned invalid JSON: {error}") from error

    def prepare(self, runner, env: dict, worktree, shard: str) -> dict:
        result = self.cli(runner, env, worktree, "prepare", "--shard", shard)
        if not isinstance(result, dict):
            raise RefineError(f"{self.cli_name} prepare returned an invalid result")
        state = self.checkpoint(worktree, shard)
        if state is None or result.get("chunk_count") != state["chunk_total"]:
            raise RefineError(f"{self.cli_name} prepare did not create the expected checkpoint")
        return state

    def read_chunk_prompt(self, runner, env: dict, worktree, shard: str) -> tuple[dict, str]:
        """Return the unchanged prepared view and its validated compact prompt view (never a JSON fallback)."""
        rule, name = self.spec.rule, self.cli_name
        result = self.cli(runner, env, worktree, "read-chunk", "--shard", shard)
        if not isinstance(result, dict) or not isinstance(result.get("chunk"), str):
            raise RefineError(f"{name} read-chunk returned no active chunk")
        state = self.checkpoint(worktree, shard)
        if state is None or result["chunk"] != next_chunk(state):
            raise RefineError(f"{name} read-chunk is not the next checkpoint chunk")
        if "prompt_view" not in result:
            raise RefineError(f"{name} read-chunk returned no prompt_view")
        view = {key: value for key, value in result.items() if key != "prompt_view"}
        rule.validate_prompt_view(result["prompt_view"], rule.decision_context(view, view["chunk"]), state["chunk_total"])
        return view, result["prompt_view"]

    def read_chunk(self, runner, env: dict, worktree, shard: str) -> dict:
        return self.read_chunk_prompt(runner, env, worktree, shard)[0]

    def refresh_pending_chunks(self, runner, env: dict, worktree, shard: str) -> dict:
        """Recompute pending views from current Git inputs while preserving checkpointed decisions.

        The CLI requires every completed chunk's full prepared view (including hidden Relation row bindings) to match
        the current render before it updates any pending scratch view. A changed chunk count or completed view fails
        closed."""
        rule, name = self.spec.rule, self.cli_name
        result = self.cli(runner, env, worktree, "refresh-pending", "--shard", shard)
        if not isinstance(result, dict) or result.get("shard") != shard or type(result.get("chunk_count")) is not int:
            raise RefineError(f"{name} refresh-pending returned an invalid result")
        state = self.checkpoint(worktree, shard)
        if state is None or result["chunk_count"] != state["chunk_total"]:
            raise RefineError(f"{name} refresh-pending did not preserve the {self.spec.label} checkpoint")
        if "prompt_view" not in result:
            raise RefineError(f"{name} refresh-pending returned no prompt_view")
        prompt_view = result.pop("prompt_view")
        expected = next_chunk(state)
        if expected is None:
            if (result.get("current_chunk") is not None or result.get("current_view") is not None
                    or prompt_view is not None):
                raise RefineError(f"{name} refresh-pending returned a chunk after checkpoint completion")
            return result
        if (result.get("current_chunk") != expected or not isinstance(result.get("current_view"), dict)
                or type(result.get("active_changed")) is not bool):
            raise RefineError(f"{name} refresh-pending returned no exact next chunk view")
        rule.validate_prompt_view(prompt_view, rule.decision_context(result["current_view"], expected), state["chunk_total"])
        return result

    def save_chunk(self, runner, env: dict, worktree, shard: str, chunk: str, answer: str) -> dict:
        text = self.spec.rule.decision_text(answer, chunk)
        scratch = Path(worktree) / ".warroom-scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        input_path = scratch / f"{self.spec.scratch}-{shard}-decisions.txt"
        input_path.write_text(text, "utf-8")
        result = self.cli(runner, env, worktree, "save-chunk", "--shard", shard,
                          "--in", f".warroom-scratch/{input_path.name}")
        if not isinstance(result, dict):
            raise RefineError(f"{self.cli_name} save-chunk returned an invalid result")
        return result

    def apply(self, runner, env: dict, worktree, shard: str) -> dict:
        result = self.cli(runner, env, worktree, "apply", "--shard", shard)
        if not isinstance(result, dict):
            raise RefineError(f"{self.cli_name} apply returned an invalid result")
        return result

    def report(self, runner, env: dict, worktree, shard: str) -> dict:
        scratch = Path(worktree) / ".warroom-scratch"
        scratch.mkdir(parents=True, exist_ok=True)
        output = scratch / f"{self.spec.scratch}-{shard}-report.json"
        self.cli(runner, env, worktree, "report", "--shard", shard, "--out", str(output))
        try:
            value = json.loads(output.read_text("utf-8"))
        except (OSError, ValueError) as error:
            raise RefineError(f"{self.cli_name} report did not create valid JSON: {error}") from error
        if not isinstance(value, dict) or value.get("shard") != shard:
            raise RefineError(f"{self.cli_name} report returned an invalid shard report")
        return value

    def read_chunk_by_number(self, runner, env: dict, worktree, shard: str, chunk: str) -> tuple[dict, str, str, bool]:
        """Explicit chunk read: (unchanged prepared view, validated compact prompt view, view digest, completed)."""
        rule = self.spec.rule
        result = self.cli(runner, env, worktree, "read-chunk", "--shard", shard, "--chunk", chunk)
        state = self.checkpoint(worktree, shard)
        if (not isinstance(result, dict) or result.get("chunk") != chunk or state is None
                or not isinstance(result.get("view_sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", result["view_sha256"])
                or type(result.get("completed")) is not bool):
            raise RefineError(f"{self.cli_name} read-chunk --chunk {chunk} returned an invalid result")
        view = {key: value for key, value in result.items() if key not in ("prompt_view", "view_sha256", "completed")}
        rule.validate_prompt_view(result.get("prompt_view"), rule.decision_context(view, chunk), state["chunk_total"])
        return view, result["prompt_view"], result["view_sha256"], result["completed"]

    def save_chunk_by_number(self, runner, env: dict, worktree, shard: str, chunk: str, input_rel: str,
                             view_sha256: str) -> dict:
        """Explicit chunk save bound to the launch-time view digest; `already_saved` is the idempotent success."""
        result = self.cli(runner, env, worktree, "save-chunk", "--shard", shard, "--chunk", chunk, "--in", input_rel,
                          "--expect-view-sha256", view_sha256)
        if not isinstance(result, dict) or result.get("chunk") != chunk:
            raise RefineError(f"{self.cli_name} save-chunk --chunk returned an invalid result")
        return result
