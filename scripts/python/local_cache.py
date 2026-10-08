"""Resolve Typewriter's machine-local cache root for repository Python tools."""

from __future__ import annotations

import os
import re
from pathlib import Path, PurePosixPath

_CACHE_AREAS = {"corpus", "literature", "indexes", "evidence", "runs"}


def typewriter_cache_root() -> Path:
    configured = os.environ.get("TYPEWRITER_CACHE_ROOT")
    if configured:
        if configured.startswith("~") and configured != "~" and not configured.startswith(f"~{os.sep}"):
            raise ValueError("TYPEWRITER_CACHE_ROOT only supports ~ or ~/... home expansion")
        expanded = Path(configured).expanduser()
        if not expanded.is_absolute():
            raise ValueError("TYPEWRITER_CACHE_ROOT must be an absolute path so all worktrees share it")
        return expanded.resolve()
    return (Path.home() / ".cache" / "typewriter").resolve()


def cache_relative_path(value: Path, label: str = "Cached artifact") -> str:
    root = typewriter_cache_root()
    candidate = Path(value).expanduser().resolve()
    try:
        relative = candidate.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label} must be inside the Typewriter cache root {root}: {candidate}") from error
    if relative == Path("."):
        raise ValueError(f"{label} must be below the Typewriter cache root {root}: {candidate}")
    return relative.as_posix()


def map_legacy_reference_path(value: str) -> str:
    normalized = value.replace("\\", "/").strip("/")
    prefix = "data/reference/"
    if not normalized.startswith(prefix):
        raise ValueError("legacy reference path must start with data/reference/")
    parts = [part for part in normalized[len(prefix):].split("/") if part]
    if not parts or parts[0] in {".", ".."} or any(part in {".", ".."} for part in parts[1:]):
        raise ValueError("legacy reference path must not contain traversal segments")
    legacy_area, *rest = parts
    if legacy_area == "benchmark-274":
        mapped = ["runs", legacy_area, *rest]
    elif legacy_area == "literature-evidence" and len(rest) >= 2:
        batch_id, *artifact_path = rest
        match = re.fullmatch(r"([A-Z]\d{6}-\d{4})(\.pack\.json|\.summary\.json|\.md)", artifact_path[0]) \
            if len(artifact_path) == 1 else None
        if match:
            file_name = {
                ".pack.json": "pack.json",
                ".summary.json": "summary.json",
                ".md": "evidence.md",
            }[match.group(2)]
            mapped = ["evidence", batch_id, match.group(1), file_name]
        else:
            mapped = ["evidence", batch_id, "legacy", *artifact_path]
    elif legacy_area == "pilots":
        mapped = ["runs", f"{rest[0]}-pilot", *rest[1:]] if rest else ["runs", "legacy", "pilots"]
    elif legacy_area in {"corpus", "public-domain", "indexes", "production", "timing", "literature-evidence"}:
        mapped = {
            "corpus": ["corpus"],
            "public-domain": ["literature"],
            "indexes": ["indexes"],
            "production": ["runs"],
            "timing": ["runs", "timing"],
            "literature-evidence": ["evidence"],
        }[legacy_area] + rest
    else:
        mapped = ["runs", "legacy", legacy_area, *rest]
    return PurePosixPath(*mapped).as_posix()


def normalize_cache_run_binding(value: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError("cached analysis database path binding is required")
    normalized = value.replace("\\", "/")
    if normalized.startswith("data/reference/"):
        relative = map_legacy_reference_path(normalized)
    elif Path(normalized).is_absolute():
        relative = cache_relative_path(Path(normalized), "Cached analysis database binding")
    else:
        parts = normalized.split("/")
        if any(part in {"", ".", ".."} for part in parts):
            raise ValueError("cached analysis database binding must not contain traversal segments")
        relative = PurePosixPath(*parts).as_posix()
    parts = PurePosixPath(relative).parts
    if len(parts) < 2 or parts[0] != "runs":
        raise ValueError("cached analysis database binding must point inside the runs cache area")
    return PurePosixPath(*parts).as_posix()


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
