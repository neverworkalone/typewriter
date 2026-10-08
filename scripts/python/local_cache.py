"""Resolve Typewriter's machine-local cache root for repository Python tools."""

from __future__ import annotations

import os
from pathlib import Path

_CACHE_AREAS = {"corpus", "literature", "indexes", "evidence", "runs"}


def typewriter_cache_root() -> Path:
    configured = os.environ.get("TYPEWRITER_CACHE_ROOT")
    if configured:
        expanded = Path(configured).expanduser()
        if not expanded.is_absolute():
            raise ValueError("TYPEWRITER_CACHE_ROOT must be an absolute path so all worktrees share it")
        return expanded.resolve()
    return (Path.home() / ".cache" / "typewriter").resolve()


def assert_cache_path(value: Path, area: str, label: str) -> Path:
    if area not in _CACHE_AREAS:
        raise ValueError(f"unknown Typewriter cache area: {area}")
    root = typewriter_cache_root()
    base = (root / area).resolve()
    try:
        base.relative_to(root)
    except ValueError as error:
        raise ValueError(f"Typewriter cache area {area} resolves outside {root}") from error
    candidate = Path(value).expanduser().resolve()
    try:
        relative = candidate.relative_to(base)
    except ValueError as error:
        raise ValueError(f"{label} must be inside {base}: {candidate}") from error
    if relative == Path("."):
        raise ValueError(f"{label} must be below {base}: {candidate}")
    return candidate
