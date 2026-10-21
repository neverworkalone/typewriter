"""Paths and operator configuration. Everything mutable lives under .local/."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

from .adapters import RunSpec

WARROOM_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = WARROOM_DIR.parents[1]

DEFAULTS = {
    "repo": "neverworkalone/typewriter",
    "base_branch": "master",
    "expected_account": "neverworkalone-agent",
    "git_name": "",
    "git_email": "",
    # Legacy single-worker config; used to synthesise the registry when `producers` is empty.
    "worker": {"adapter": "opencode", "method": "a", "producer": "deepseek"},
    # Model registry: logical model id (= Candidate filename producer suffix) ->
    # {"label", "adapter", "models": {"free", "go"}}. No count limit.
    "producers": {},
    "methods": ["a", "b", "c", "d"],
    "opencode_bin": "opencode",
    "models": {"free": "", "go": ""},
    "free_model_pattern": "-free$",
    "quota_patterns": [
        "FreeUsageLimit",
        "free (usage|tier|quota).{0,40}(exhaust|exceed|limit)",
    ],
    "trusted_reviewers": ["genonfire"],
    "poll_seconds": 300,
    "rate_limit_retries": 3,
    "rate_limit_backoff_seconds": 120,
}


@dataclass
class Paths:
    repo_root: Path = REPO_ROOT
    local: Path = field(default=None)  # type: ignore[assignment]

    def __post_init__(self) -> None:
        if self.local is None:
            self.local = self.repo_root / "tools" / "warroom" / ".local"

    @property
    def db(self) -> Path:
        return self.local / "warroom.db"

    @property
    def gh_config(self) -> Path:
        return self.local / "gh"

    @property
    def worktrees(self) -> Path:
        return self.local / "worktrees"

    @property
    def logs(self) -> Path:
        return self.local / "logs"

    @property
    def lock(self) -> Path:
        return self.local / "supervisor.lock"

    @property
    def config_file(self) -> Path:
        return self.local / "config.json"

    def ensure(self) -> None:
        for d in (self.local, self.gh_config, self.worktrees, self.logs):
            d.mkdir(parents=True, exist_ok=True)


def load_config(paths: Paths) -> dict:
    cfg = json.loads(json.dumps(DEFAULTS))
    if paths.config_file.exists():
        user = json.loads(paths.config_file.read_text("utf-8"))
        for key, value in user.items():
            if isinstance(value, dict) and isinstance(cfg.get(key), dict):
                cfg[key].update(value)
            else:
                cfg[key] = value
    return cfg


_PRODUCER_ID = re.compile(r"^[a-z0-9-]+$")


KNOWN_LABELS = {"deepseek": "DeepSeek"}   # display names for producer ids that have no configured `label`


def registry(cfg: dict) -> dict[str, dict]:
    """Logical model id -> {label, adapter, model, effort, models}. Legacy `worker`/`models` is one entry.

    `model` is the single pinned model of a CLI without free/go tiers (Claude, Codex); `models` holds the
    OpenCode tiers. `effort` is the reasoning level passed explicitly on every run.
    """
    prods = cfg.get("producers") or {}
    if not prods:
        w = cfg["worker"]
        prods = {w["producer"]: {"adapter": w.get("adapter", "opencode"), "models": cfg.get("models", {})}}
    out = {}
    for pid, p in prods.items():
        adapter = p.get("adapter", "opencode")
        out[pid] = {"label": p.get("label") or KNOWN_LABELS.get(pid, pid), "adapter": adapter,
                    "model": p.get("model") or "",
                    "effort": p["effort"] if "effort" in p else LEGACY_EFFORT.get(adapter, ""),
                    "models": {"free": "", "go": "", **(p.get("models") or {})}}
    return out


def _endpoints(p: dict) -> list[str]:
    """Every concrete model ID a logical model runs on (a duplicate endpoint is a duplicate model)."""
    eps = [ep for ep in p["models"].values() if ep]
    if p["adapter"] not in TIERED_ADAPTERS and p["model"]:
        eps.append(p["model"])
    return eps


def _producer_problem(pid: str, p: dict) -> str | None:
    if not _PRODUCER_ID.match(pid):
        return f"모델 ID {pid!r}는 [a-z0-9-]만 허용됩니다."
    if p["adapter"] not in ADAPTER_LABELS:
        return f"알 수 없는 adapter {p['adapter']!r} (허용: {', '.join(ADAPTER_LABELS)})."
    if p["adapter"] not in TIERED_ADAPTERS:
        if not p["model"]:
            return "모델 ID가 설정되지 않았습니다 — CLI 기본 모델에 맡기지 않고 `model`을 명시해야 합니다."
        if not _MODEL_ID.match(p["model"]):
            return f"모델 ID {p['model']!r}는 허용되지 않는 형식입니다 (플래그처럼 보이거나 공백이 있음)."
    return effort_problem(p["adapter"], p["effort"])


def registry_problems(cfg: dict) -> dict[str, str]:
    """producer id -> reason it must not run (bad id, unknown adapter, unpinned model or effort, duplicate)."""
    reg, bad, seen = registry(cfg), {}, {}
    for pid, p in reg.items():
        problem = _producer_problem(pid, p)
        if problem:
            bad.setdefault(pid, problem)
        if pid.lower() in seen and seen[pid.lower()] != pid:
            bad[pid] = f"모델 ID {pid!r}가 {seen[pid.lower()]!r}와 중복 등록되었습니다."
        seen.setdefault(pid.lower(), pid)
    endpoints: dict[str, str] = {}
    for pid, p in reg.items():
        for ep in _endpoints(p):
            if endpoints.setdefault(ep, pid) != pid:
                bad[pid] = f"엔드포인트 {ep!r}가 {endpoints[ep]!r}와 중복 — 같은 논리 모델의 중복 등록입니다."
                bad.setdefault(endpoints[ep], bad[pid])
    return bad


def methods(cfg: dict) -> list[str]:
    return [m.lower() for m in cfg.get("methods") or ["a", "b", "c", "d"]]


ADAPTER_LABELS = {"claude": "Claude", "codex": "Codex", "opencode": "OpenCode"}   # display names only
TIERED_ADAPTERS = ("opencode",)   # the only CLI with a Free and a Go model per logical model
# Reasoning effort each CLI accepts. Claude: its `--effort` choices; Codex: the values the API reports for
# gpt-6-luna (rejected with "Supported values are ..." otherwise). OpenCode variants are model-specific:
# only their format is checked here, and the OpenCode adapter proves each model+variant at Start (preflight).
ADAPTER_EFFORTS = {
    "claude": ("low", "medium", "high", "xhigh", "max"),
    "codex": ("none", "low", "medium", "high", "xhigh", "max"),
    "opencode": None,
}
# A DeepSeek entry without `effort` (configs written before #1373) runs at the owner-fixed `high`, passed explicitly.
LEGACY_EFFORT = {"opencode": "high"}
_MODEL_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:-]*$")   # never a flag ("-x") and never whitespace
_EFFORT_ID = re.compile(r"^[a-z0-9-]+$")


def adapter_label(adapter: str) -> str:
    return ADAPTER_LABELS.get(adapter, adapter)


def effort_problem(adapter: str, effort: str) -> str | None:
    """Why `effort` cannot be passed to `adapter` (None = acceptable). An unset effort is never accepted."""
    if not effort:
        return "추론 수준(effort)이 설정되지 않았습니다 — CLI 기본값에 맡기지 않고 명시해야 합니다."
    allowed = ADAPTER_EFFORTS.get(adapter)
    if allowed is None:
        return None if _EFFORT_ID.match(effort) else f"추론 수준 {effort!r}의 형식이 올바르지 않습니다."
    if effort not in allowed:
        return f"{adapter_label(adapter)}는 추론 수준 {effort!r}를 지원하지 않습니다 (허용: {', '.join(allowed)})."
    return None


def run_spec(cfg: dict, producer: str, tier: str = "free") -> RunSpec:
    """The exact model and effort one run of `producer` is pinned to. Raises ValueError if either is unset.

    Tiered (OpenCode): the model of `tier`; a Go switch changes only the model, never the effort.
    Single-model CLIs: their one `model`; `tier` is ignored (they have no Free/Go tiers).
    """
    p = registry(cfg)[producer]
    model = p["models"].get(tier, "") if p["adapter"] in TIERED_ADAPTERS else p["model"]
    if not model:
        raise ValueError(f"{producer}: {tier if p['adapter'] in TIERED_ADAPTERS else 'model'} 모델 ID가 설정되지 않았습니다.")
    problem = effort_problem(p["adapter"], p["effort"])
    if problem:
        raise ValueError(f"{producer}: {problem}")
    return RunSpec(model=model, effort=p["effort"])


def pin_summary(p: dict) -> str:
    """What one logical model runs on: its CLI model ID(s) and the pinned reasoning effort."""
    effort = p["effort"] or "(미설정)"
    if p["adapter"] in TIERED_ADAPTERS:
        return f"free={p['models']['free'] or '(미설정)'}  go={p['models']['go'] or '(미설정)'}  effort={effort}"
    return f"model={p['model'] or '(미설정)'}  effort={effort}"


def ordered_models(cfg: dict) -> list[str]:
    """Registered logical models in board order: adapter label, then model label, then id.

    Independent of `producers` registration order, so Claude -> Codex -> OpenCode always holds.
    """
    reg = registry(cfg)
    return sorted(reg, key=lambda pid: (adapter_label(reg[pid]["adapter"]), reg[pid]["label"], pid))


def adapters(cfg: dict) -> list[str]:
    """Adapters that have at least one registered logical model, ordered by display label (Claude, Codex, OpenCode)."""
    found = {p["adapter"] for p in registry(cfg).values()}
    return sorted(found, key=lambda a: (adapter_label(a), a))
