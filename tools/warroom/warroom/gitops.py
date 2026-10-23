"""Git/worktree handling. War Room only ever removes worktrees/branches it owns."""
from __future__ import annotations

from pathlib import Path

from .shell import Runner


class GitError(Exception):
    pass


class CleanupBlocked(Exception):
    """Removal would risk data loss or touch something War Room does not own."""


SCRATCH_DIR = ".warroom-scratch"   # the AI's throw-away files; never part of a batch and never blocks a worktree check


class Git:
    def __init__(self, runner: Runner, repo_root: Path, env: dict, worktrees_dir: Path):
        self.r, self.root, self.env = runner, Path(repo_root), env
        self.worktrees_dir = Path(worktrees_dir)

    def _git(self, *args, cwd=None, check=True, timeout=300):
        res = self.r.run(["git", *args], cwd=cwd or self.root, env=self.env, timeout=timeout)
        if check and not res.ok:
            raise GitError(f"git {' '.join(args)}: {res.err.strip() or res.out.strip()}")
        return res

    def fetch_base(self, base: str) -> str:
        self._git("fetch", "origin", base)
        return self._git("rev-parse", f"origin/{base}").out.strip()

    def create_worktree(self, path: Path, branch: str, base: str) -> None:
        path = Path(path)
        if path.exists():
            raise GitError(f"worktree path already exists (not ours to reuse): {path}")
        if self._git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}",
                     check=False).ok:
            raise GitError(f"local branch already exists: {branch}")
        if self._git("ls-remote", "--exit-code", "--heads", "origin", branch,
                     check=False).ok:
            raise GitError(f"remote branch already exists: {branch}")
        path.parent.mkdir(parents=True, exist_ok=True)
        self.ignore_scratch()
        self._git("worktree", "add", "-b", branch, str(path), f"origin/{base}")

    def head(self, path: Path) -> str:
        return self._git("rev-parse", "HEAD", cwd=path).out.strip()

    def remote_head(self, branch: str) -> str | None:
        """Actual SHA of origin's `branch` (None: no such remote branch); raises GitError if it cannot be queried."""
        res = self._git("ls-remote", "--heads", "origin", f"refs/heads/{branch}")
        for line in res.out.splitlines():
            sha, _, ref = line.partition("\t")
            if ref.strip() == f"refs/heads/{branch}":
                return sha.strip()
        return None

    def ignore_scratch(self) -> None:
        """Keep SCRATCH_DIR out of `git status` in every worktree (shared info/exclude); idempotent."""
        exclude = Path(self._git("rev-parse", "--path-format=absolute", "--git-path", "info/exclude").out.strip())
        line = f"/{SCRATCH_DIR}/"
        try:
            have = exclude.read_text("utf-8").splitlines() if exclude.exists() else []
            if line not in have:
                exclude.parent.mkdir(parents=True, exist_ok=True)
                with exclude.open("a", encoding="utf-8") as fh:
                    fh.write(("" if not have or exclude.read_text("utf-8").endswith("\n") else "\n") + line + "\n")
        except OSError as e:
            raise GitError(f"info/exclude를 갱신할 수 없습니다: {e}")

    def dirty(self, path: Path) -> str:
        self.ignore_scratch()
        return self._git("status", "--porcelain=v1", "--untracked-files=all", cwd=path).out

    def registered(self, path: Path) -> str | None:
        """Branch checked out at `path` according to git, or None if unregistered."""
        out = self._git("worktree", "list", "--porcelain").out
        cur, branch = None, None
        for line in out.splitlines() + [""]:
            if line.startswith("worktree "):
                cur, branch = Path(line[9:]).resolve(), None
            elif line.startswith("branch "):
                branch = line[7:].removeprefix("refs/heads/")
            elif not line and cur is not None:
                if cur == Path(path).resolve():
                    return branch or ""
                cur = None
        return None

    def _sync_to_pr_head(self, path: Path, local: str, pr_head_sha: str) -> None:
        """Fast-forward a clean worktree to the merged PR HEAD (e.g. GitHub "Update branch" added commits).

        Only a fast-forward is ever done: a local HEAD that is not an ancestor of the PR HEAD is
        preserved and blocks cleanup. No reset, rebase or force.
        """
        desc = f"local HEAD {local[:10]} != merged PR HEAD {pr_head_sha[:10]}"
        have = self._git("cat-file", "-e", f"{pr_head_sha}^{{commit}}", cwd=path, check=False).ok
        if not have and not self._git("fetch", "origin", pr_head_sha, cwd=path, check=False).ok:
            raise CleanupBlocked(f"{desc} (merged PR HEAD를 가져올 수 없음)")
        if not self._git("merge-base", "--is-ancestor", local, pr_head_sha, cwd=path, check=False).ok:
            raise CleanupBlocked(f"{desc} (local HEAD가 PR HEAD의 조상이 아님)")
        if not self._git("merge", "--ff-only", pr_head_sha, cwd=path, check=False).ok:
            raise CleanupBlocked(f"{desc} (fast-forward 실패)")
        if self.head(path) != pr_head_sha:
            raise CleanupBlocked(f"{desc} (동기화 후에도 불일치)")

    def remove_owned(self, path: Path, branch: str, pr_head_sha: str) -> None:
        """Remove worktree + local branch only if provably ours, clean and fully merged.

        `pr_head_sha` is the merged PR's final HEAD; squash merges make ancestry
        checks unreliable, so the invariant is local HEAD == the HEAD GitHub merged.
        A local HEAD that is a strict ancestor of it is fast-forwarded first.
        """
        path = Path(path)
        try:
            path.resolve().relative_to(self.worktrees_dir.resolve())
        except ValueError:
            raise CleanupBlocked(f"worktree is outside War Room's directory: {path}")
        if not path.exists():
            raise CleanupBlocked(f"worktree path missing (needs manual check): {path}")
        if self.registered(path) != branch:
            raise CleanupBlocked(f"worktree is not registered with branch {branch}")
        if (d := self.dirty(path)).strip():
            raise CleanupBlocked(f"uncommitted changes in worktree:\n{d.strip()[:400]}")
        local = self.head(path)
        if local != pr_head_sha:
            self._sync_to_pr_head(path, local, pr_head_sha)
        self._git("worktree", "remove", str(path))  # no --force
        self._git("branch", "-D", branch)
