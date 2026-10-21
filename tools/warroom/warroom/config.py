"""Paths and operator configuration. Everything mutable lives under .local/."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

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
    """Logical model id -> {label, adapter, models}. Legacy `worker`/`models` is one entry."""
    prods = cfg.get("producers") or {}
    if not prods:
        w = cfg["worker"]
        prods = {w["producer"]: {"adapter": w.get("adapter", "opencode"), "models": cfg.get("models", {})}}
    out = {}
    for pid, p in prods.items():
        out[pid] = {"label": p.get("label") or KNOWN_LABELS.get(pid, pid), "adapter": p.get("adapter", "opencode"),
                    "models": {"free": "", "go": "", **(p.get("models") or {})}}
    return out


def registry_problems(cfg: dict) -> dict[str, str]:
    """producer id -> reason it must not run (bad id, or a duplicate logical model)."""
    reg, bad, seen = registry(cfg), {}, {}
    for pid, p in reg.items():
        if not _PRODUCER_ID.match(pid):
            bad[pid] = f"모델 ID {pid!r}는 [a-z0-9-]만 허용됩니다."
        if pid.lower() in seen and seen[pid.lower()] != pid:
            bad[pid] = f"모델 ID {pid!r}가 {seen[pid.lower()]!r}와 중복 등록되었습니다."
        seen.setdefault(pid.lower(), pid)
    endpoints: dict[str, str] = {}
    for pid, p in reg.items():
        for ep in p["models"].values():
            if ep and endpoints.setdefault(ep, pid) != pid:
                bad[pid] = f"엔드포인트 {ep!r}가 {endpoints[ep]!r}와 중복 — 같은 논리 모델의 중복 등록입니다."
                bad.setdefault(endpoints[ep], bad[pid])
    return bad


def methods(cfg: dict) -> list[str]:
    return [m.lower() for m in cfg.get("methods") or ["a", "b", "c", "d"]]


ADAPTER_LABELS = {"codex": "Codex", "claude": "Claude", "opencode": "OpenCode"}   # display order too


def adapter_label(adapter: str) -> str:
    return ADAPTER_LABELS.get(adapter, adapter)


def adapters(cfg: dict) -> list[str]:
    """Adapters that have at least one registered logical model (Codex, Claude, OpenCode first)."""
    found = {p["adapter"] for p in registry(cfg).values()}
    order = list(ADAPTER_LABELS)
    return sorted(found, key=lambda a: (order.index(a) if a in order else len(order), a))
