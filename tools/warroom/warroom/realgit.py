"""Find the real Git binary that War Room's own (non-worker) Git calls and the worker shim run.

Invariant: a Git War Room runs is never the worker shim, never a symlink to it, and never macOS's /usr/bin/git xcrun
stub — the stub looks `git` up through xcrun's cache, which an earlier shim-first PATH can have poisoned with the
shim's path (the shim then re-enters itself). The stub is replaced by the developer-dir Git it would run, executed
directly. Nothing here runs xcrun."""
from __future__ import annotations

import functools
import os
import subprocess
import sys
from pathlib import Path

SHIM_DIR = (Path(__file__).resolve().parents[1] / "bin").resolve()
XCRUN_STUB = Path("/usr/bin/git") if sys.platform == "darwin" else None   # only macOS has the stub; tests may set it


def is_shim(path) -> bool:
    """True for the War Room Git shim, its directory, or any symlink resolving to them."""
    try:
        real = Path(path).resolve()
    except (OSError, RuntimeError):
        return True   # unresolvable: treat as unsafe
    return real == SHIM_DIR / "git" or real.parent == SHIM_DIR or real == SHIM_DIR


@functools.lru_cache(maxsize=32)
def _developer_dir(configured: str) -> str:
    if configured:
        return configured
    try:
        return subprocess.run(["/usr/bin/xcode-select", "-p"], env={}, capture_output=True, text=True,
                              timeout=60).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def developer_git(env) -> str | None:
    """The developer-dir Git that the xcrun stub runs, built from `DEVELOPER_DIR` / `xcode-select -p` (neither reads
    or updates xcrun's cache); a missing, non-executable or shim result is discarded."""
    developer_dir = _developer_dir(env.get("DEVELOPER_DIR") or "")
    found = os.path.join(developer_dir, "usr", "bin", "git")
    ok = os.path.isabs(developer_dir) and os.path.isfile(found) and os.access(found, os.X_OK) and not is_shim(found)
    return found if ok else None


def resolve_git(env) -> str | None:
    """The first PATH `git` that is neither the shim nor the xcrun stub (the stub is swapped for its developer-dir
    Git). None when there is no usable one."""
    for entry in (env.get("PATH") or os.defpath).split(os.pathsep):
        candidate = Path(entry or os.curdir) / "git"
        if not candidate.is_file() or not os.access(candidate, os.X_OK) or is_shim(candidate):
            continue
        if XCRUN_STUB is not None and candidate.resolve() == XCRUN_STUB.resolve():
            found = developer_git(env)
            if found:
                return found
            continue
        return str(candidate)
    return None
