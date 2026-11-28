"""Refinement Stages (#6555): one War Room line for every Stage that refines already-approved Relations (S3 onward).

S3, S4, ... S10 are the same kind of work: a shard's approved Relations are judged in prepared chunks, the decisions are
applied by that Stage's official CLI (built on `scripts/relation/refine/core.mjs`), and one PR per shard is reviewed and
merged. They run one after another on the same War Room line (`s3` method), each Stage gated per shard on the Stage
before it, exactly as Stage 3 is gated on Stage 2. A Stage is therefore one `RefineSpec`: what differs is only its
CLI, its prompts and policy card, its answer rule, its PR naming and its gate. Everything else — parallel chunk tasks,
finalize, merge verify, the Review FIXING Coordinator, Maintainer handling — is shared and keyed by the batch's Stage.

A batch records its Stage in `batches.batch` (`spec.tag`); Stage 3 keeps its historical tag `all`. Each Stage's run
profile is `assignments.<spec.role>` (Stage 3: `assignments.stage3`), resolved from the batch's own spec.

`STAGE_MODULES` is the one registration entry point: the Stage modules, in run order. A new Stage is a module that calls
`register(RefineSpec(...))` at import time plus one name appended here; nothing is discovered automatically.
"""
from __future__ import annotations

import importlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

SHARDS = 428
# Refinement Stage modules in run order — the single registration entry point. Each Stage names its line
# (`RefineSpec.method`): the Refinement line runs S3, S4, ...; the Drop line (#10171) runs D1, ...
STAGE_MODULES = ("stage3", "stage4", "stage_d1")
RESERVED_ROLES = ("stage2", "maintainer")   # assignment roles that are not refinement Stages


class RefineError(ValueError):
    pass


class NoJudgment(RefineError):
    """A chunk answer with no usable judgment (every line invalid, or no body): never an implicit Keep-all (#9928)."""


_SHARD_DATA = re.compile(r"data/(?:relations/relation|relation-drops/drop)-\d{3}\.jsonl")
_RELATION_DATA = re.compile(r"data/relations/relation-\d{3}\.jsonl")


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
    role: str                   # `assignments.<role>` run profile of this Stage ("stage3")
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
    # #9928: a Stage whose CLI edits relations stored in any shard (both directions). Its CLI bounds which relations;
    # the War Room scope is then every shard data file, and verify covers the shards its CLI reports as affected.
    cross_shard: bool = False
    # A shard whose official apply changes nothing completes without a commit or PR (`<id>_nochange_SSS`).
    no_change_complete: bool = False
    # #10512: (apply result) -> the judgment summary logged on that no-change completion, in the Stage's own result
    # format (S4: Sense counts, D1: Skip Sense verdicts). Required with `no_change_complete`.
    no_change_summary: Callable | None = None
    # A provider prompt refusal may be saved as an explicit Keep-all `none` (Stage 3, #2292); False sends it to the
    # ordinary task failure path, since an editorial Skip and a refusal are different results.
    refusal_keep_all: bool = True
    # #10047: a prompt refusal binds to Canonical records. A refused multi-record chunk runs each of its records once
    # as its own task; a refused record (or a refused single-record chunk) is a Policy Skip `P <record_id>`, every
    # other record keeps its ordinary judgment, and a refusal that cannot be bound holds the chunk (never Keep-all).
    refusal_records: bool = False
    # #9929: a Relation-only Stage (S4 onward) reads and changes Relation files only. It narrows the file kind, not the
    # shards: with `cross_shard` any shard's Relation file may change, and a Drop file of any shard is out of scope.
    # The same scope serves PR validation, finalize and replay (`--relations-only`).
    relations_only: bool = False
    body: Callable | None = None   # (model, shard, result=..., cost=...) -> PR body; None = the Stage 3 body
    # #10171: the War Room line (`batches.method`) this Stage runs on: the Refinement line `s3` or the Drop line `drop`.
    # Stages of one line run in order; the two lines run beside each other.
    method: str = "s3"
    # #10171: the Stage CLI keeps its judgments (checkpoint + views) in the batch worktree after apply, and its `verify`
    # checks the PR against them: the exact-commit verify checkout reads them with `--judgments <batch worktree>`.
    verify_judgments: bool = False
    # #10338: a Stage whose PR only removes rows of its own Relation file (D1) replays with `--drops-only`: the same
    # relation-key 3-way merge, limited to that change, with no other shard's Relation file read.
    replay_drops_only: bool = False

    def title_for(self, model: str, shard: str) -> str:
        return f"[{self.short}/{model}] {shard}"

    def branch(self, model: str, shard: str) -> str:
        return f"{self.id}-{model}-{shard}"

    def worktree_name(self, shard: str) -> str:
        return f"{self.id}-{shard}"

    def ok_key(self, shard: str) -> str:
        return f"{self.id}_ok_{shard}"

    def allowed(self, shard: str) -> set:
        relation = f"data/relations/relation-{shard}.jsonl"
        return {relation} if self.relations_only else {relation, f"data/relation-drops/drop-{shard}.jsonl"}

    def scope(self, shard: str, paths=()) -> set:
        """The files this Stage's shard work may change, given the paths it did change: the single edit-scope definition.
        A two-file Stage is exactly `allowed`; a cross-shard Stage adds every shard Relation/Drop file among `paths`
        (Relation files only for a Relation-only Stage)."""
        own = self.allowed(shard)
        data = _RELATION_DATA if self.relations_only else _SHARD_DATA
        return own | {path for path in paths if isinstance(path, str) and data.fullmatch(path)} \
            if self.cross_shard else own

    @property
    def cli_verify(self) -> bool:
        """#10330: the exact-commit verify is the Stage CLI's own `verify` (S4, D1) rather than the shard admission verify
        (Stage 3). A cross-shard Stage and a Stage that keeps its judgments both have one."""
        return self.cross_shard or self.verify_judgments

    def nochange_key(self, shard: str) -> str:
        return f"{self.id}_nochange_{shard}"


_REGISTRY: list[RefineSpec] = []
_OPS: dict[str, object] = {}


def register(spec: RefineSpec) -> RefineSpec:
    from .store import REFINE_METHODS
    if spec.method not in REFINE_METHODS:
        raise ValueError(f"refinement Stage {spec.id} names an unknown line {spec.method!r}")
    if any(existing.id == spec.id or existing.tag == spec.tag or existing.role == spec.role
           for existing in _REGISTRY):
        raise ValueError(f"refinement Stage {spec.id} is registered twice (id, tag or role {spec.role!r})")
    if not isinstance(spec.role, str) or not re.fullmatch(r"[a-z0-9-]+", spec.role) or spec.role in RESERVED_ROLES:
        raise ValueError(f"refinement Stage {spec.id} has an invalid or reserved role {spec.role!r}")
    if spec.no_change_complete and not callable(spec.no_change_summary):
        raise ValueError(f"refinement Stage {spec.id} completes without changes but declares no no_change_summary")
    _REGISTRY.append(spec)
    return spec


def stages(method: str | None = None) -> list[RefineSpec]:
    """Every refinement Stage in run order (the `STAGE_MODULES` order, Stage 3 first); with `method`, only the Stages of
    that line (#10171)."""
    for name in STAGE_MODULES:
        importlib.import_module(f".{name}", __package__)
    return [spec for spec in _REGISTRY if method is None or spec.method == method]


def roles(method: str | None = None) -> tuple[str, ...]:
    """The `assignments` role of every registered refinement Stage (of one line with `method`), in run order."""
    return tuple(spec.role for spec in stages(method))


def spec_for_role(role: str) -> RefineSpec | None:
    return next((spec for spec in stages() if spec.role == role), None)


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
                or set(paths) - self.spec.scope(shard, paths) or len(paths) != len(set(paths))):
            raise RefineError(f"PR #{pr.get('number')} changed files do not match {label} shard {shard}")
        return shard

    def choose(self, *, kv, open_prs: list[dict], stage2_batches: list, stage3_batches: list,
               latest_pr=None, pin: str = "") -> Choice:
        """Select exactly the successor of the last merged production shard of this Stage."""
        from . import batches

        spec, label = self.spec, self.spec.label
        previous = int(spec.title.fullmatch(latest_pr["title"]).group(1)) if latest_pr else 0
        # A no-change completion has no PR: continue over the contiguous recorded ones after the last merged shard.
        while spec.no_change_complete and previous < SHARDS and kv.get(spec.nochange_key(f"{previous + 1:03d}")):
            previous += 1
        if previous >= SHARDS:
            # #10512: a merged last PR alone is not completion; the final shard's recorded completion is.
            final = f"{SHARDS:03d}"
            if not kv.get(spec.ok_key(final)):
                return Choice("unready", note=f"{label} 최종 샤드 {final} 완료 기록 없음 / 실행 종료")
            return Choice("done", note=f"{label} 전체 샤드 생산이 완료되었습니다.")
        shard = f"{previous + 1:03d}"
        if pin and pin != shard:
            return Choice("unready", note=f"고정 샤드 {pin}와 {label} 순차 대상 {shard} 불일치 / 실행 종료")
        own = [row for row in stage3_batches if row["batch"] == spec.tag]
        if any(row["shard"] == shard and row["state"] == "COMPLETE" and row["merged"] for row in own):
            return Choice("wait", note=f"샤드 {shard} 완료의 GitHub 검색 반영 대기")
        if (any(row["shard"] == shard and row["state"] != "COMPLETE" for row in stage2_batches + stage3_batches)
                or any(shard in batches.pr_line_shards(pr, spec.method) for pr in open_prs)):
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

    def read_chunk_by_number(self, runner, env: dict, worktree, shard: str, chunk: str,
                             record: str | None = None) -> tuple[dict, str, str, bool]:
        """Explicit chunk read: (unchanged prepared view, validated compact prompt view, view digest, completed).
        With `record` (#10047) the view is that record of the chunk, bound to the whole chunk's digest."""
        rule = self.spec.rule
        if record is not None and not self.spec.refusal_records:
            raise RefineError(f"{self.spec.label} has no record-scoped chunk view")
        extra = ("--record", record) if record is not None else ()
        result = self.cli(runner, env, worktree, "read-chunk", "--shard", shard, "--chunk", chunk, *extra)
        state = self.checkpoint(worktree, shard)
        if (not isinstance(result, dict) or result.get("chunk") != chunk or state is None
                or not isinstance(result.get("view_sha256"), str) or not re.fullmatch(r"[0-9a-f]{64}", result["view_sha256"])
                or type(result.get("completed")) is not bool):
            raise RefineError(f"{self.cli_name} read-chunk --chunk {chunk} returned an invalid result")
        view = {key: value for key, value in result.items() if key not in ("prompt_view", "view_sha256", "completed")}
        context = rule.decision_context(view, chunk) if record is None else rule.decision_context(view, chunk, record)
        rule.validate_prompt_view(result.get("prompt_view"), context, state["chunk_total"])
        return view, result["prompt_view"], result["view_sha256"], result["completed"]

    def save_chunk_by_number(self, runner, env: dict, worktree, shard: str, chunk: str, input_rel: str,
                             view_sha256: str) -> dict:
        """Explicit chunk save bound to the launch-time view digest; `already_saved` is the idempotent success."""
        result = self.cli(runner, env, worktree, "save-chunk", "--shard", shard, "--chunk", chunk, "--in", input_rel,
                          "--expect-view-sha256", view_sha256)
        if not isinstance(result, dict) or result.get("chunk") != chunk:
            raise RefineError(f"{self.cli_name} save-chunk --chunk returned an invalid result")
        return result
