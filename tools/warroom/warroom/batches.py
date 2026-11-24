"""Open-PR shard claims for Stage 2/3 batches and the shared Git/Candidate-path helpers Stage 2 reads.

A Stage 2 or Stage 3 PR occupies the shard whose Relation/Drop files it touches (#927); a formal Polish data PR occupies
none (#8784). The Stage 1 Candidate filename pattern stays here because Stage 2 consumes those preserved files.
"""
from __future__ import annotations

import re

from .realgit import resolve_git
from .shell import Runner
from .store import STAGE2_METHOD

# Repo-root, whole-path match: `experiments/.../data/relation-candidates/...` is not a production Candidate.
_CAND = re.compile(r"data/relation-candidates/(\d{3})/\1_(\d{2})_([a-d])_([a-z0-9-]+)\.jsonl")


class BatchError(Exception):
    pass


# Stage 2 writes only the shard's cumulative Relation/Drop files (#927): a PR touching them occupies that shard.
_STAGE2_FILE = re.compile(r"data/(?:relations/relation|relation-drops/drop)-(\d{3})\.jsonl")


_POLISH_TITLE = re.compile(r"\[Polish\](?:\s|$)")
_POLISH_ISSUE = re.compile(r"\bRefs\s+(?:#|https://github\.com/[\w.-]+/[\w.-]+/issues/)8777(?!\d)")


def is_polish_data_pr(pr: dict) -> bool:
    """A formal Polish data PR (#8784): `[Polish]` title, `Refs #8777` body and only shard Relation/Drop files.

    Polish edits approved data by relation key and is replayed onto newer data, so it never occupies a shard. Any other
    shape (no body, a code/doc file, an unknown file list) keeps the ordinary occupancy rule.
    """
    files = pr.get("files")
    return (bool(_POLISH_TITLE.match(pr.get("title") or "")) and bool(_POLISH_ISSUE.search(pr.get("body") or ""))
            and isinstance(files, list) and bool(files)
            and all(_STAGE2_FILE.fullmatch((f or {}).get("path", "")) for f in files))


def pr_stage2_shards(pr: dict) -> set[str]:
    """Shards whose Stage 2 Relation/Drop files an open PR touches (an unknown file list is never "no files").

    A formal Polish data PR occupies none (#8784); Stage 2 and Stage 3 PRs keep their mutual shard occupancy."""
    files = pr.get("files")
    if not isinstance(files, list):
        raise BatchError(f"열린 PR #{pr.get('number')}의 파일 목록을 알 수 없어 중복 점유를 배제할 수 없습니다")
    if is_polish_data_pr(pr):
        return set()
    return {m.group(1) for f in files if (m := _STAGE2_FILE.fullmatch((f or {}).get("path", "")))}


def pr_stage3_shards(pr: dict) -> set[str]:
    """Shards claimed by open Stage 3 data PRs. The same shard files also conflict with Stage 2 PRs."""
    return pr_stage2_shards(pr)


def pr_claims(b, pr: dict) -> list:
    """What an open PR claims, in the shape `expected_claim(b)` uses: Stage 2/3 shard keys."""
    return [(b["method"], s) for s in sorted(pr_stage2_shards(pr) if b["method"] == STAGE2_METHOD else pr_stage3_shards(pr))]


def expected_claim(b) -> tuple:
    return (b["method"], b["shard"])


def _git_bin(env) -> str:
    """The verified Git; with none usable, fail instead of letting a bare `git` find the xcrun stub."""
    found = resolve_git(env)
    if not found:
        raise BatchError("사용할 수 있는 실제 Git 실행 파일을 찾지 못했습니다 (xcrun stub은 제외됨)")
    return found


def _counts(runner: Runner, root, env, ref: str, pathspec: str) -> dict[str, int]:
    specs = [pathspec] if isinstance(pathspec, str) else list(pathspec)
    res = runner.run([_git_bin(env), "grep", "-c", "", ref, "--", *specs], cwd=root, env=env,
                     timeout=120)
    if res.code not in (0, 1):
        raise BatchError(f"git grep {pathspec}: {res.err.strip()}")
    out = {}
    for line in res.out.splitlines():
        path, _, n = line.rpartition(":")
        out[path.removeprefix(f"{ref}:")] = int(n)
    return out
