"""Git/worktree handling. War Room only ever removes worktrees/branches it owns."""
from __future__ import annotations

from pathlib import Path

from .shell import Runner


class GitError(Exception):
    pass


class CleanupBlocked(Exception):
    """Removal would risk data loss or touch something War Room does not own."""


class IntegrationBlocked(Exception):
    """A shared fix cannot be brought into a batch worktree safely (conflict, wrong state); nothing was changed."""


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

    def worktree_gitdir(self, path: Path) -> Path:
        """Absolute Git admin directory of the War Room-owned linked worktree at `path`, or GitError (fail closed).

        Invariant: the result is exactly `<repo common dir>/worktrees/<entry>` of a worktree War Room created, asked
        of git itself and confirmed by the entry's back-pointer to `path`; never the repo's `.git`, never a guess.
        """
        path = Path(path)
        try:
            path.resolve().relative_to(self.worktrees_dir.resolve())
        except ValueError:
            raise GitError(f"worktree가 War Room 디렉터리 밖에 있습니다: {path}")
        if not path.is_dir() or self.registered(path) is None:
            raise GitError(f"War Room이 등록한 worktree가 아닙니다: {path}")
        out = self._git("rev-parse", "--absolute-git-dir", cwd=path, check=False)
        text = out.out.strip()
        if not out.ok or not text or "\n" in text or any(ord(c) < 32 for c in text):
            raise GitError(f"worktree의 Git 관리 디렉터리를 조회할 수 없습니다: {path}: {out.err.strip()[:200]}")
        gitdir = Path(text)
        common = self._git("rev-parse", "--path-format=absolute", "--git-common-dir", check=False)
        if not gitdir.is_absolute() or not common.ok or not common.out.strip():
            raise GitError(f"Git 관리 디렉터리 경로가 절대 경로가 아닙니다: {text}")
        worktrees = Path(common.out.strip()).resolve() / "worktrees"
        resolved = gitdir.resolve()
        if resolved.parent != worktrees or not resolved.is_dir():
            raise GitError(f"Git 관리 디렉터리가 저장소의 linked worktree 항목이 아닙니다: {text}")
        try:
            owner = Path((resolved / "gitdir").read_text("utf-8").strip()).resolve()
        except OSError as e:
            raise GitError(f"worktree 항목의 소유 경로를 확인할 수 없습니다: {resolved}: {e}")
        if owner != (path.resolve() / ".git"):
            raise GitError(f"Git 관리 디렉터리({resolved})가 이 worktree({path})의 것이 아닙니다.")
        return resolved

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

    # ---- applying a merged shared fix to a paused batch (Issue #1555) -----------------------------------------------
    def _owned(self, path: Path) -> Path:
        path = Path(path)
        try:
            path.resolve().relative_to(self.worktrees_dir.resolve())
        except ValueError:
            raise IntegrationBlocked(f"worktree가 War Room 디렉터리 밖에 있습니다: {path}")
        if not path.is_dir():
            raise IntegrationBlocked(f"worktree 경로가 없습니다: {path}")
        return path

    def contains(self, path: Path, sha: str) -> bool:
        """True iff commit `sha` is an ancestor of (or equal to) the worktree's HEAD."""
        return self._git("merge-base", "--is-ancestor", sha, "HEAD", cwd=path, check=False).ok

    def changed_files(self, sha: str) -> list[str]:
        """Paths a merged PR changed (first-parent diff of its merge/squash commit on the base branch)."""
        out = self._git("diff", "--name-only", f"{sha}^1", sha).out
        return [p for p in out.splitlines() if p]

    def integrate(self, path: Path, branch: str, base: str, sha: str) -> str:
        """Bring the merged shared fix `sha` into the paused batch worktree and return the resulting HEAD.

        Invariant: only a commit that is already on `origin/<base>` is merged, as a plain merge into a worktree that
        War Room owns and that is on its own branch. No reset, rebase, force, stash or checkout. Uncommitted and
        partial output files stay as they are (git refuses a merge that would touch them). Any conflict or refusal
        aborts the merge, leaves the worktree exactly as it was, and raises IntegrationBlocked. Idempotent: a HEAD
        that already contains `sha` is returned unchanged.
        """
        path = self._owned(path)
        if self.registered(path) != branch:
            raise IntegrationBlocked(f"worktree가 브랜치 {branch}에 등록되어 있지 않습니다")
        self._git("fetch", "origin", base)   # a network/auth failure is a GitError: transient, caller retries
        if not self._git("merge-base", "--is-ancestor", sha, f"origin/{base}", check=False).ok:
            raise IntegrationBlocked(f"{sha[:10]}이 origin/{base}에 포함되어 있지 않습니다")
        if self._git("rev-parse", "-q", "--verify", "MERGE_HEAD", cwd=path, check=False).ok:
            raise IntegrationBlocked("worktree에 진행 중인 merge가 있습니다")
        if self.contains(path, sha):
            return self.head(path)
        before = self.head(path)
        res = self._git("merge", "--no-edit", sha, cwd=path, check=False)
        if not res.ok:
            self._git("merge", "--abort", cwd=path, check=False)
            if self.head(path) != before:   # defensive: an aborted merge must leave HEAD untouched
                raise IntegrationBlocked(f"merge 실패 후 HEAD가 변경되어 있습니다: {before[:10]} → {self.head(path)[:10]}")
            raise IntegrationBlocked(f"merge 충돌 또는 거부: {(res.err or res.out).strip()[:300]}")
        if not self.contains(path, sha):
            raise IntegrationBlocked("merge 후에도 수정 commit이 HEAD에 포함되지 않았습니다")
        return self.head(path)
