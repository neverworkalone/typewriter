"""Git/worktree handling. War Room only ever removes worktrees/branches it owns."""
from __future__ import annotations

import json
import os
import shutil
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .realgit import resolve_git
from .shell import Runner, transient


class GitError(Exception):
    pass


class GitTransient(GitError):
    """A remote git call failed in a way asking again can fix (timeout, network); nothing was decided."""


class CleanupBlocked(Exception):
    """Removal would risk data loss or touch something War Room does not own."""


class IntegrationBlocked(Exception):
    """A shared fix cannot be brought into a batch worktree safely (conflict, wrong state); nothing was changed."""


@dataclass(frozen=True)
class VerifyOutcome:
    """Result of a Batch/Shard verify (#2154). `failure` = {family, errors, total} only for a deterministic rows/accounting
    failure (exit 2 with a fully valid JSON line); every other failure leaves it None (unclassified)."""
    ok: bool
    tail: str
    failure: dict | None = None


VERIFY_FAMILIES = ("rows", "accounting")


def parse_verify_failure(code: int, out: str) -> dict | None:
    """The structured failure of `verify --json`, or None unless exit 2 AND the single JSON line is entirely valid."""
    if code != 2:
        return None
    try:
        data = json.loads(out.strip())
    except ValueError:
        return None
    if (not isinstance(data, dict) or set(data) != {"version", "ok", "family", "errors", "total"}
            or data["version"] != 1 or data["ok"] is not False or data["family"] not in VERIFY_FAMILIES):
        return None
    errors = data["errors"]
    if (not isinstance(errors, list) or not errors or not all(isinstance(e, str) and e.strip() for e in errors)
            or type(data["total"]) is not int or data["total"] != len(errors)):
        return None
    return {"family": data["family"], "errors": errors, "total": data["total"]}


SCRATCH_DIR = ".warroom-scratch"   # the AI's throw-away files; never part of a batch and never blocks a worktree check


class Git:
    def __init__(self, runner: Runner, repo_root: Path, env: dict, worktrees_dir: Path):
        self.r, self.root, self.env = runner, Path(repo_root), env
        self.worktrees_dir = Path(worktrees_dir)
        self._bin = resolve_git(env)   # never the (cache-poisonable) xcrun stub

    @property
    def bin(self) -> str:
        """The verified Git; with none usable, fail instead of letting a bare `git` find the stub."""
        if not self._bin:
            raise GitError("git: 사용할 수 있는 실제 Git 실행 파일을 찾지 못했습니다 (xcrun stub은 제외됨)")
        return self._bin

    def _git(self, *args, cwd=None, check=True, timeout=300, net=False):
        """`net=True` marks a remote-access call: its transient failure is a GitTransient (ask again), not a verdict."""
        res = self.r.run([self.bin, *args], cwd=cwd or self.root, env=self.env, timeout=timeout)
        if check and not res.ok:
            msg = f"git {' '.join(args)}: {res.err.strip() or res.out.strip()}"
            raise (GitTransient(msg) if net and transient(res) else GitError(msg))
        return res

    def fetch_base(self, base: str) -> str:
        self._git("fetch", "origin", base, net=True)
        return self._git("rev-parse", f"origin/{base}").out.strip()

    def create_worktree(self, path: Path, branch: str, base: str) -> None:
        path = Path(path)
        if path.exists():
            raise GitError(f"worktree path already exists (not ours to reuse): {path}")
        if self._git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}",
                     check=False).ok:
            raise GitError(f"local branch already exists: {branch}")
        remote = self._git("ls-remote", "--exit-code", "--heads", "origin", branch, check=False)
        if remote.ok:   # code 0: the branch exists; code 2: it does not; anything else is NOT evidence of absence
            raise GitError(f"remote branch already exists: {branch}")
        if remote.code != 2:
            why = f"git ls-remote {branch}: {remote.err.strip() or remote.out.strip() or remote.code}"
            raise GitTransient(why) if transient(remote) else GitError(why)
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
        res = self._git("ls-remote", "--heads", "origin", f"refs/heads/{branch}", net=True)
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

    def commit_paths(self, path: Path, rels: list[str], message: str) -> str:
        """Commit exactly `rels` (Supervisor-owned finalization). Any other change in the worktree is refused untouched."""
        out = self.dirty(path)
        changed = {line[3:].strip() for line in out.splitlines() if line.strip()}
        if not changed or changed != set(rels):
            raise GitError(f"커밋 대상이 의도한 파일 {sorted(rels)}과 다릅니다 (변경: {sorted(changed)}) — 아무것도 커밋하지 않았습니다")
        self._git("add", "--", *rels, cwd=path)
        self._git("commit", "-q", "-m", message, cwd=path)
        return self.head(path)

    def is_committed(self, path: Path, rel: str) -> bool:
        """`rel` is tracked at HEAD with no change in the worktree (and nothing else is dirty)."""
        if self.dirty(path).strip():
            return False
        return self._git("cat-file", "-e", f"HEAD:{rel}", cwd=path, check=False).ok

    def is_candidate_child(self, path: Path, base_sha: str, rel: str) -> bool:
        """HEAD is a direct child of `base_sha` that changed exactly `rel` (our own interrupted Candidate commit)."""
        parent = self._git("rev-parse", "HEAD^", cwd=path, check=False)
        if not parent.ok or parent.out.strip() != base_sha:
            return False
        files = self._git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD", cwd=path, check=False)
        return files.ok and files.out.split() == [rel]

    def push_branch(self, path: Path, branch: str) -> None:
        """Plain push of HEAD to a not-yet-existing remote branch. Never forced; a moved remote is the caller's ERROR."""
        self._git("push", "origin", f"HEAD:refs/heads/{branch}", cwd=path, timeout=600, net=True)

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
        if not have:
            fetched = self._git("fetch", "origin", pr_head_sha, cwd=path, check=False)
            if not fetched.ok:
                if transient(fetched):   # the network, not the worktree: ask again, never a Cleanup verdict
                    raise GitTransient(f"git fetch origin {pr_head_sha[:10]}: {fetched.err.strip()[:200]}")
                raise CleanupBlocked(f"{desc} (merged PR HEAD를 가져올 수 없음)")
        if not self._git("merge-base", "--is-ancestor", local, pr_head_sha, cwd=path, check=False).ok:
            raise CleanupBlocked(f"{desc} (local HEAD가 PR HEAD의 조상이 아님)")
        if not self._git("merge", "--ff-only", pr_head_sha, cwd=path, check=False).ok:
            raise CleanupBlocked(f"{desc} (fast-forward 실패)")
        if self.head(path) != pr_head_sha:
            raise CleanupBlocked(f"{desc} (동기화 후에도 불일치)")

    def remove_owned(self, path: Path, branch: str, pr_head_sha: str, *,
                     cleanup_proof: dict | None = None, on_verified=None) -> None:
        """Remove worktree + local branch only if provably ours, clean and fully merged.

        `pr_head_sha` is the merged PR's final HEAD; squash merges make ancestry
        checks unreliable, so the invariant is local HEAD == the HEAD GitHub merged.
        A local HEAD that is a strict ancestor of it is fast-forwarded first. Before
        removing a registered worktree, `on_verified` durably records the clean/HEAD
        ownership proof. That record is required to resume a partially completed
        removal whether Git dropped the registration or deleted the checkout first.
        """
        raw_path = Path(os.path.abspath(path))
        if raw_path.is_symlink():
            raise CleanupBlocked(f"worktree path is a symlink (preserved): {raw_path}")
        path = raw_path.resolve()
        try:
            path.relative_to(self.worktrees_dir.resolve())
        except ValueError:
            raise CleanupBlocked(f"worktree is outside War Room's directory: {path}")

        registered = self.registered(path)
        if registered == branch:
            if not path.is_dir():
                if path.exists():
                    raise CleanupBlocked(f"registered worktree path is occupied by a non-directory (preserved): {path}")
                self._retry_registered_missing_checkout(path, branch, pr_head_sha, cleanup_proof)
                return
            if (d := self.dirty(path)).strip():
                if not self._cleanup_proof_matches(path, branch, pr_head_sha, cleanup_proof):
                    raise CleanupBlocked(f"uncommitted changes in worktree without matching cleanup proof:\n"
                                         f"{d.strip()[:400]}")
                if self.head(path) != pr_head_sha:
                    raise CleanupBlocked(f"registered worktree HEAD moved from proven merged PR HEAD "
                                         f"{pr_head_sha}; preserved")
                ref = self._git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}", check=False)
                if not ref.ok or ref.out.strip() != pr_head_sha:
                    raise CleanupBlocked(f"local branch {branch} moved from proven merged PR HEAD "
                                         f"{pr_head_sha}; preserved")
                missing = self._partial_tree_status(path, self._common_dir(), pr_head_sha)
                actual = self._git("status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z",
                                   cwd=path).out
                actual_missing = []
                for record in actual.split("\0"):
                    if not record:
                        continue
                    if len(record) < 4 or record[2] != " " or record[0] != " " or record[1] != "D":
                        raise CleanupBlocked("registered worktree has changes beyond proven tracked-file deletions "
                                             "(preserved)")
                    actual_missing.append(record[3:])
                if not missing or set(actual_missing) != set(missing):
                    raise CleanupBlocked("registered worktree deletions do not match the proven PR HEAD "
                                         "(preserved)")
                self._restore_partial_deletions(path, pr_head_sha, missing)
                if (d := self.dirty(path)).strip():
                    raise CleanupBlocked(f"worktree is still dirty after restoring proven partial deletions:\n"
                                         f"{d.strip()[:400]}")
            local = self.head(path)
            if local != pr_head_sha:
                self._sync_to_pr_head(path, local, pr_head_sha)
            if self.head(path) != pr_head_sha:
                raise CleanupBlocked(f"worktree HEAD does not match merged PR HEAD {pr_head_sha}")
            if (d := self.dirty(path)).strip():
                raise CleanupBlocked(f"uncommitted changes after HEAD synchronization:\n{d.strip()[:400]}")
            if on_verified is not None:
                on_verified()
            res = self._git("worktree", "remove", str(path), check=False)
            if not res.ok:
                detail = res.err.strip() or res.out.strip() or f"exit {res.code}"
                raise GitError(f"git worktree remove {path} (exit={res.code}; {detail}); "
                               "cleanup proof is saved, so Retry can resume cleanup without rerunning production")
            self._delete_owned_branch(branch, pr_head_sha)
            return

        if registered is not None:
            raise CleanupBlocked(f"worktree is registered with a different branch (expected {branch}, got {registered!r})")
        self._remove_partial(path, branch, pr_head_sha, cleanup_proof)

    def _retry_registered_missing_checkout(self, path: Path, branch: str, pr_head_sha: str,
                                           proof: dict | None) -> None:
        """Retry non-force removal when Git registration survives but its checkout was already deleted."""
        if not self._cleanup_proof_matches(path, branch, pr_head_sha, proof):
            raise CleanupBlocked("registered worktree checkout is missing and no matching durable cleanup proof exists; "
                                 "the admin entry and branch are preserved for manual verification")
        if path.exists() or path.is_symlink():
            raise CleanupBlocked(f"missing checkout path became occupied during cleanup (preserved): {path}")

        common = self._common_dir()
        admin = self._registered_admin_entry(path, common)
        branch_ref = self._git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}", check=False)
        if not branch_ref.ok or branch_ref.out.strip() != pr_head_sha:
            raise CleanupBlocked(f"local branch {branch} moved from proven merged PR HEAD {pr_head_sha}; preserved")
        head_file, common_file = admin / "HEAD", admin / "commondir"
        if any(item.is_symlink() or not item.is_file() for item in (head_file, common_file)):
            raise CleanupBlocked(f"registered worktree admin metadata is missing or unexpected (preserved): {admin}")
        try:
            head_ref = head_file.read_text("utf-8").strip()
            common_pointer = common_file.read_text("utf-8").strip()
        except (OSError, UnicodeError) as e:
            raise CleanupBlocked(f"cannot verify registered worktree admin metadata (preserved): {e}")
        if head_ref != f"ref: refs/heads/{branch}":
            raise CleanupBlocked(f"registered worktree admin HEAD does not point to owned branch {branch}; preserved")
        if (admin / common_pointer).resolve() != common:
            raise CleanupBlocked(f"registered worktree admin entry points to a different common directory; preserved")
        admin_head = self._git(f"--git-dir={admin}", "rev-parse", "--verify", "HEAD", check=False)
        if not admin_head.ok or admin_head.out.strip() != pr_head_sha:
            raise CleanupBlocked(f"registered worktree admin HEAD differs from proven merged PR HEAD {pr_head_sha}; "
                                 "preserved")
        if path.exists() or path.is_symlink():
            raise CleanupBlocked(f"missing checkout path became occupied during cleanup (preserved): {path}")

        # Git can safely drop the stale registration when its checkout is already absent. Keep this non-force: the
        # proof, back-pointer, admin HEAD, local branch and absent destination must all agree first.
        res = self._git("worktree", "remove", str(path), check=False)
        if not res.ok:
            detail = res.err.strip() or res.out.strip() or f"exit {res.code}"
            raise GitError(f"git worktree remove {path} (exit={res.code}; {detail}); "
                           "cleanup proof is saved, so Retry can resume cleanup without rerunning production")
        if self.registered(path) is not None or self._registered_admin_entry(path, common, required=False):
            raise CleanupBlocked(f"Git did not remove the proven stale worktree registration (preserved): {path}")
        self._delete_owned_branch(branch, pr_head_sha)

    def _registered_admin_entry(self, path: Path, common: Path, *, required: bool = True) -> Path | None:
        """Find exactly one admin entry whose gitdir back-pointer names this worktree's .git file."""
        root = common / "worktrees"
        try:
            entries = list(root.iterdir()) if root.is_dir() else []
        except OSError as e:
            raise CleanupBlocked(f"cannot inspect registered worktree admin entries (preserved): {e}")
        expected = (path / ".git").resolve()
        matches = []
        for entry in entries:
            if entry.is_symlink() or not entry.is_dir():
                continue
            pointer = entry / "gitdir"
            if pointer.is_symlink() or not pointer.is_file():
                continue
            try:
                owner = Path(pointer.read_text("utf-8").strip()).resolve()
            except (OSError, UnicodeError) as e:
                raise CleanupBlocked(f"cannot read worktree admin back-pointer (preserved): {pointer}: {e}")
            if owner == expected:
                matches.append(entry.resolve())
        if len(matches) == 1:
            return matches[0]
        if not matches and not required:
            return None
        if len(matches) > 1:
            raise CleanupBlocked(f"multiple Git admin entries point to the missing worktree (preserved): {path}")
        raise CleanupBlocked(f"no Git admin entry points to the missing worktree (preserved): {path}")

    def _delete_owned_branch(self, branch: str, pr_head_sha: str) -> None:
        ref = self._git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}", check=False)
        if not ref.ok:
            return
        if ref.out.strip() != pr_head_sha:
            raise CleanupBlocked(f"local branch {branch} moved from merged PR HEAD {pr_head_sha}; preserved")
        self._git("branch", "-D", branch)

    def _common_dir(self) -> Path:
        common = self._git("rev-parse", "--path-format=absolute", "--git-common-dir", check=False)
        if not common.ok or not common.out.strip():
            raise CleanupBlocked(f"Git common directory cannot be verified: {common.err.strip()[:200]}")
        path = Path(common.out.strip()).resolve()
        if not path.is_absolute():
            raise CleanupBlocked(f"Git common directory is not absolute: {common.out.strip()[:200]}")
        return path

    def _has_admin_entry(self, path: Path, common: Path) -> bool:
        worktrees = common / "worktrees"
        expected_gitfile = path / ".git"
        try:
            entries = list(worktrees.iterdir()) if worktrees.exists() else []
        except OSError as e:
            raise CleanupBlocked(f"cannot inspect Git worktree admin entries: {e}")
        for entry in entries:
            if entry.name == path.name:
                return True
            try:
                raw = (entry / "gitdir").read_text("utf-8").strip()
                owner = Path(raw).resolve()
            except (OSError, UnicodeError):
                continue
            if owner == expected_gitfile.resolve():
                return True
        return False

    def _verify_partial_gitfile(self, path: Path, common: Path) -> None:
        gitfile = path / ".git"
        if not gitfile.exists() and not gitfile.is_symlink():
            return
        if gitfile.is_symlink() or not gitfile.is_file():
            raise CleanupBlocked(f"partial worktree has an unexpected .git entry (preserved): {gitfile}")
        try:
            lines = gitfile.read_text("utf-8").splitlines()
        except (OSError, UnicodeError) as e:
            raise CleanupBlocked(f"cannot verify partial worktree .git pointer (preserved): {e}")
        if len(lines) != 1 or not lines[0].startswith("gitdir: "):
            raise CleanupBlocked(f"partial worktree has an invalid .git pointer (preserved): {gitfile}")
        gitdir = Path(lines[0][8:]).resolve()
        if gitdir.parent != (common / "worktrees").resolve() or gitdir.name != path.name:
            raise CleanupBlocked(f"partial worktree .git pointer does not match its expected admin entry: {gitfile}")
        if gitdir.exists():
            raise CleanupBlocked(f"partial worktree Git admin entry still exists (manual check): {gitdir}")

    def _partial_tree_status(self, path: Path, common: Path, pr_head_sha: str) -> list[str]:
        """Read the residual tree against the recorded PR HEAD using a temporary index.

        Missing tracked files are consistent with an interrupted directory removal. Any
        modified, type-changed, or untracked path is ambiguous and blocks deletion.
        """
        with tempfile.TemporaryDirectory(prefix="warroom-cleanup-") as tmp:
            env = dict(self.env)
            env["GIT_INDEX_FILE"] = str(Path(tmp) / "index")
            env["GIT_OPTIONAL_LOCKS"] = "0"
            prefix = [self.bin, f"--git-dir={common}", f"--work-tree={path}"]
            read = self.r.run(prefix + ["read-tree", pr_head_sha], cwd=self.root, env=env, timeout=120)
            if not read.ok:
                detail = read.err.strip() or read.out.strip() or f"exit {read.code}"
                raise CleanupBlocked(f"cannot prepare a read-only PR HEAD comparison for residual worktree: {detail}")
            status = self.r.run(prefix + ["status", "--porcelain=v1", "--untracked-files=all", "--no-renames", "-z"],
                                cwd=self.root, env=env, timeout=120)
            if not status.ok:
                detail = status.err.strip() or status.out.strip() or f"exit {status.code}"
                raise CleanupBlocked(f"cannot inspect residual worktree against merged PR HEAD: {detail}")
            rows, missing = [], []
            for record in status.out.split("\0"):
                if not record:
                    continue
                if len(record) < 4:
                    raise CleanupBlocked("cannot parse merged PR worktree status; residual worktree is preserved")
                rows.append(record[:2] + " " + record[3:])
                if record[1] == "D":
                    missing.append(record[3:])
            files = self.r.run(prefix + ["ls-files", "--stage", "-z"], cwd=self.root, env=env, timeout=120)
            if not files.ok:
                detail = files.err.strip() or files.out.strip() or f"exit {files.code}"
                raise CleanupBlocked(f"cannot enumerate merged PR files for residual cleanup: {detail}")
            tracked = {}
            for record in files.out.split("\0"):
                if not record:
                    continue
                metadata, sep, name = record.partition("\t")
                fields = metadata.split()
                if not sep or len(fields) != 3:
                    raise CleanupBlocked("cannot parse merged PR file list; residual worktree is preserved")
                tracked[os.fsdecode(name)] = fields[0]
        # `git status` omits ignored files. Walk the actual checkout as well, so an ignored or empty untracked item
        # cannot be erased by rmtree. The one repository-defined throw-away scratch directory is already excluded
        # from the regular clean gate and is safe to discard with this owned worktree.
        tracked_dirs = set()
        for rel in tracked:
            parts = rel.split("/")
            tracked_dirs.update("/".join(parts[:i]) for i in range(1, len(parts)))

        def inspect(directory: Path, prefix: str = "") -> None:
            try:
                entries = list(os.scandir(directory))
            except OSError as e:
                raise CleanupBlocked(f"cannot inspect residual worktree contents at {directory}: {e}")
            for entry in entries:
                rel = f"{prefix}/{entry.name}" if prefix else entry.name
                if not prefix and rel == ".git":
                    continue   # verified separately as a stale pointer to the now-absent admin entry
                if rel == SCRATCH_DIR or rel.startswith(SCRATCH_DIR + "/"):
                    if entry.is_dir(follow_symlinks=False):
                        inspect(Path(entry.path), rel)
                    continue
                if rel not in tracked and rel not in tracked_dirs:
                    raise CleanupBlocked(f"residual worktree contains untracked/ignored data (preserved): {rel}")
                is_dir = entry.is_dir(follow_symlinks=False)
                if rel in tracked and (is_dir or tracked[rel] == "160000"):
                    raise CleanupBlocked(f"tracked file has an unexpected directory/submodule residual (preserved): {rel}")
                if rel in tracked_dirs and not is_dir:
                    raise CleanupBlocked(f"tracked directory has an unexpected file residual (preserved): {rel}")
                if is_dir:
                    inspect(Path(entry.path), rel)

        inspect(path)
        # The temporary index is based on the merged PR HEAD while the repository's
        # primary HEAD may be a squash merge. Ignore X (index-vs-HEAD) and inspect
        # only Y (index-vs-worktree): a missing file is expected during removal;
        # every other worktree change is ambiguous.
        unexpected = [row for row in rows if len(row) < 2 or row[1] not in (" ", "D")]
        if unexpected:
            raise CleanupBlocked("residual worktree has changes outside partial deletion (preserved):\n"
                                 + "\n".join(unexpected[:12]))
        return missing

    @staticmethod
    def _cleanup_proof_matches(path: Path, branch: str, pr_head_sha: str, proof: dict | None) -> bool:
        expected = {"version": 1, "path": str(path), "branch": branch, "head_sha": pr_head_sha,
                    "remove_started": True}
        return isinstance(proof, dict) and all(proof.get(k) == v for k, v in expected.items())

    def _restore_partial_deletions(self, path: Path, pr_head_sha: str, paths: list[str]) -> None:
        """Restore only proven missing tracked paths so registered Git can perform its normal non-force removal."""
        with tempfile.TemporaryDirectory(prefix="warroom-cleanup-restore-") as tmp:
            pathspec = Path(tmp) / "paths"
            try:
                pathspec.write_bytes(b"".join(os.fsencode(rel) + b"\0" for rel in paths))
            except OSError as e:
                raise CleanupBlocked(f"cannot prepare exact tracked-file restoration list: {e}")
            self._git("--literal-pathspecs", "restore", f"--source={pr_head_sha}", "--worktree",
                      f"--pathspec-from-file={pathspec}", "--pathspec-file-nul", cwd=path)

    def _remove_partial(self, path: Path, branch: str, pr_head_sha: str, proof: dict | None) -> None:
        if not self._cleanup_proof_matches(path, branch, pr_head_sha, proof):
            raise CleanupBlocked("worktree registration is missing and no matching durable clean/HEAD/ownership "
                                 "cleanup proof exists; residual files and branch are preserved. Verify the saved "
                                 "batch path, branch, PR HEAD, and local changes with the repository owner before "
                                 "retrying cleanup")
        root = self.worktrees_dir.resolve()
        if path.parent.resolve() != root:
            raise CleanupBlocked(f"partial worktree is not a direct child of War Room's directory: {path}")
        if path.is_symlink():
            raise CleanupBlocked(f"partial worktree path is a symlink (preserved): {path}")
        common = self._common_dir()
        if self.registered(path) is not None:
            raise CleanupBlocked(f"partial worktree registration changed during cleanup (preserved): {path}")
        if self._has_admin_entry(path, common):
            raise CleanupBlocked(f"Git still has a worktree admin entry for this path (manual check): {path}")

        ref = self._git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}", check=False)
        if path.exists():
            if not path.is_dir():
                raise CleanupBlocked(f"partial worktree path is not a directory (preserved): {path}")
            if not ref.ok or ref.out.strip() != pr_head_sha:
                raise CleanupBlocked(f"partial worktree still exists but local branch {branch} does not point to "
                                     f"merged PR HEAD {pr_head_sha}; preserved")
            self._verify_partial_gitfile(path, common)
            self._partial_tree_status(path, common, pr_head_sha)
            try:
                shutil.rmtree(path)
            except OSError as e:
                raise CleanupBlocked(f"partial worktree removal failed; files and branch are preserved for Retry: {e}")
        elif ref.ok and ref.out.strip() != pr_head_sha:
            raise CleanupBlocked(f"local branch {branch} moved from merged PR HEAD {pr_head_sha}; preserved")

        self._delete_owned_branch(branch, pr_head_sha)

    # ---- operator Clear: discard ONE owned batch (explicitly confirmed, unlike post-merge cleanup) ----
    def verify_owned(self, path: Path, branch: str) -> bool:
        """Fail closed unless `path` is this batch's War Room worktree. True: it exists and is verified; False: it is
        already gone and git no longer registers it (a resumed Clear). Anything else raises CleanupBlocked."""
        path = Path(path)
        try:
            rel = path.resolve().relative_to(self.worktrees_dir.resolve())
        except ValueError:
            raise CleanupBlocked(f"worktree가 War Room 디렉터리 밖에 있습니다: {path}")
        if not rel.parts:
            raise CleanupBlocked(f"War Room worktree 루트 자체는 대상이 아닙니다: {path}")
        reg = self.registered(path)
        if not path.exists():
            if reg is not None:
                raise CleanupBlocked(f"worktree 경로는 없지만 git에 등록되어 있습니다(수동 확인 필요): {path}")
            return False
        if reg != branch:
            raise CleanupBlocked(f"worktree가 소유 브랜치 {branch}로 등록되어 있지 않습니다 (등록: {reg!r})")
        try:
            self.worktree_gitdir(path)
        except GitError as e:
            raise CleanupBlocked(str(e))
        return True

    def delete_remote_branch(self, branch: str, expected_sha: str) -> None:
        """Delete origin's `branch` only if it still points at `expected_sha` (lease)."""
        self._git("push", "origin", f"--force-with-lease=refs/heads/{branch}:{expected_sha}",
                  "--delete", f"refs/heads/{branch}")

    def discard_owned(self, path: Path, branch: str) -> None:
        """Remove the verified worktree (tracked-dirty and untracked files included) and its local branch; only these."""
        if self.verify_owned(path, branch):
            self._git("worktree", "remove", "--force", str(path))
        if self._git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}", check=False).ok:
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
        self._git("fetch", "origin", base, net=True)   # a network/auth failure is a GitError: transient, caller retries
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

    # ---- Stage 2 verification on the latest master (Issue #1684) -------------------------------------------------
    VERIFY_DIR = "s2-verify"   # War Room's own detached checkout; it holds no work, only the exact commit being verified

    def contains_on_base(self, sha: str, base: str) -> bool:
        """True iff commit `sha` is on (an ancestor of) the fetched origin/<base>."""
        return self._git("merge-base", "--is-ancestor", sha, f"origin/{base}", check=False).ok

    def _verify_checkout(self, sha: str) -> Path:
        """The detached verification worktree at exactly `sha` (created once, then only moved between master commits)."""
        path = self.worktrees_dir / self.VERIFY_DIR
        if not path.exists():
            self.worktrees_dir.mkdir(parents=True, exist_ok=True)
            self._git("worktree", "add", "--detach", str(path), sha)
        elif self.registered(path) != "":   # detached = registered with no branch; anything else is not ours to move
            raise GitError(f"Stage 2 검증 worktree가 War Room의 분리된 체크아웃으로 등록되어 있지 않습니다: {path}")
        else:
            self._git("checkout", "--detach", "--force", sha, cwd=path)
            self._git("clean", "-fdq", cwd=path)
        return path

    def stage2_chunk_view(self, worktree: Path, shard: str, batch: str, part: str, *, prepare: bool,
                          timeout: int = 900) -> None:
        """Deterministic chunk I/O before a Stage 2 chunk run, so the AI only reads one compact view and judges it.

        Prepares a missing Part checkpoint, then renders its pending (or next) primary chunk to
        `.warroom-scratch/active-chunk.txt`. `read-chunk` re-renders an already pending chunk unchanged.
        """
        checkpoint = f".warroom-scratch/relation-admission-{shard}-{batch}-{part}.json"
        steps = [["read-chunk", "--checkpoint", checkpoint, "--format", "compact",
                  "--out", ".warroom-scratch/active-chunk.txt"]]
        if prepare:
            steps.insert(0, ["prepare", "--shard", shard, "--batch", batch, "--part", part, "--checkpoint", checkpoint])
        for args in steps:
            res = self.r.run(["node", "scripts/relation/admission-cli.mjs", *args], cwd=worktree, env=self.env,
                             timeout=timeout)
            if not res.ok:
                tail = " ".join((res.err or res.out).split())[-300:]
                raise GitError(f"admission-cli {args[0]} 실패: {tail}")

    def stage2_save_chunk(self, worktree: Path, shard: str, batch: str, part: str, timeout: int = 900) -> tuple[bool, str]:
        """Run the existing `admission-cli save-chunk --format compact` on the Supervisor-written decision file.
        (ok, output): on rejection the CLI's complete error list, with the checkpoint unchanged."""
        checkpoint = f".warroom-scratch/relation-admission-{shard}-{batch}-{part}.json"
        res = self.r.run(["node", "scripts/relation/admission-cli.mjs", "save-chunk", "--checkpoint", checkpoint,
                          "--in", ".warroom-scratch/decisions.txt", "--format", "compact"],
                         cwd=worktree, env=self.env, timeout=timeout)
        return res.ok, (res.err or res.out).strip()

    def verify_stage2(self, sha: str, kind: str, shard: str, batch: str | None, part: str | None,
                      timeout: int = 900) -> tuple[bool, str]:
        """Run the exact `admission-cli verify` for a Part / Batch / shard on commit `sha` (the latest master)."""
        args = ["--shard", shard] + (["--batch", batch] if batch else []) + (["--part", part] if part else [])
        if kind not in ("part", "batch", "shard") or (kind == "part") != bool(part) or (kind != "shard") != bool(batch):
            raise GitError(f"잘못된 Stage 2 verify 범위: {kind} {shard} {batch} {part}")
        path = self._verify_checkout(sha)
        res = self.r.run(["node", "scripts/relation/admission-cli.mjs", "verify", *args], cwd=path, env=self.env,
                         timeout=timeout)
        tail = " ".join((res.err or res.out).split())[-300:]
        return res.ok, tail

    def verify_stage2_outcome(self, sha: str, kind: str, shard: str, batch: str | None, part: str | None,
                              timeout: int = 900) -> VerifyOutcome:
        """Like `verify_stage2` for a Batch / shard, but with `--json` so a deterministic failure is classifiable.

        Only exit 2 with a complete valid JSON line fills `failure`; exit 1/124/127, broken JSON, a schema mismatch or
        any other result is an unclassified failure. A checkout/fetch GitError/GitTransient propagates as before.
        """
        args = ["--shard", shard] + (["--batch", batch] if batch else []) + (["--part", part] if part else [])
        if kind not in ("part", "batch", "shard") or (kind == "part") != bool(part) or (kind != "shard") != bool(batch):
            raise GitError(f"잘못된 Stage 2 verify 범위: {kind} {shard} {batch} {part}")
        path = self._verify_checkout(sha)
        res = self.r.run(["node", "scripts/relation/admission-cli.mjs", "verify", *args, "--json"], cwd=path,
                         env=self.env, timeout=timeout)
        if res.ok:
            return VerifyOutcome(True, "")
        failure = parse_verify_failure(res.code, res.out)
        if failure:
            tail = f"{failure['family']} {failure['total']}건: {' '.join(failure['errors'][0].split())[:200]}"
        else:
            tail = " ".join((res.err or res.out).split())[-300:]
        return VerifyOutcome(False, tail, failure)
