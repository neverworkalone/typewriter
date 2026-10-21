"""Paths and operator configuration. Everything mutable lives under .local/."""
from __future__ import annotations

import json
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
    "worker": {"adapter": "opencode", "method": "a", "producer": "deepseek"},
    "opencode_bin": "opencode",
    "models": {"free": "", "go": ""},
    "quota_patterns": [
        "FreeUsageLimit",
        "free (usage|tier|quota).{0,40}(exhaust|exceed|limit)",
    ],
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
