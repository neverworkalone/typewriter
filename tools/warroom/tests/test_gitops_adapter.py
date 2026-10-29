import os
import shutil
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from warroom.adapters import OpenCodeAdapter, RunSpec
from warroom.gitops import (CleanupBlocked, FastForwardBlocked, FastForwardRace, Git, GitError)
from warroom.shell import Result, Runner

ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
       "GIT_COMMITTER_EMAIL": "t@t", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}


def sh(*a, cwd):
    subprocess.run(a, cwd=cwd, env=ENV, check=True, capture_output=True)


class RealGit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        sh("git", "init", "-q", "--bare", "-b", "master", "origin.git", cwd=t)
        sh("git", "clone", "-q", "origin.git", "repo", cwd=t)
        self.repo = t / "repo"
        self.other_no = 0
        (self.repo / "f").write_text("x")
        sh("git", "add", "f", cwd=self.repo)
        sh("git", "commit", "-qm", "init", cwd=self.repo)
        sh("git", "push", "-q", "origin", "HEAD:master", cwd=self.repo)
        self.wts = t / "wts"
        self.git = Git(Runner(), self.repo, ENV, self.wts)
        self.wt = self.wts / "w1"

    def tearDown(self):
        self.tmp.cleanup()

    def test_worktree_gitdir_is_the_owned_linked_entry_and_fails_closed(self):
        """#1543 (real git): the Git admin dir comes from git for a War Room worktree; anything else is refused."""
        self.git.fetch_base("master")
        self.git.create_worktree(self.wt, "b1", "master")
        gitdir = self.git.worktree_gitdir(self.wt)
        self.assertEqual(gitdir, (self.repo / ".git" / "worktrees" / "w1").resolve())
        self.git.create_worktree(self.wts / "has space", "b2", "master")
        spaced = self.git.worktree_gitdir(self.wts / "has space")
        self.assertEqual(spaced.parent, (self.repo / ".git" / "worktrees").resolve())
        self.assertNotEqual(spaced, gitdir)
        # not ours: the main checkout, a plain directory, a path outside War Room's directory, a missing path
        plain = self.wts / "plain"
        plain.mkdir()
        outside = Path(self.tmp.name) / "outside"
        sh("git", "worktree", "add", "-q", "-b", "b3", str(outside), "origin/master", cwd=self.repo)
        for name, bad in [("main checkout", self.repo), ("plain dir", plain), ("outside", outside),
                          ("missing", self.wts / "nope")]:
            with self.subTest(name), self.assertRaises(GitError):
                self.git.worktree_gitdir(bad)
        # a worktree whose entry no longer points back at it is refused
        (gitdir / "gitdir").write_text(str(self.wts / "other" / ".git") + "\n")
        with self.assertRaises(GitError):
            self.git.worktree_gitdir(self.wt)

    def test_remote_head_is_the_exact_origin_branch_sha(self):
        self.git.fetch_base("master")
        self.git.create_worktree(self.wt, "a-x-001-01", "master")
        self.assertIsNone(self.git.remote_head("a-x-001-01"))           # not pushed
        sh("git", "push", "-q", "origin", "a-x-001-01", cwd=self.wt)
        self.assertEqual(self.git.remote_head("a-x-001-01"), self.git.head(self.wt))
        sh("git", "push", "-q", "origin", "HEAD:refs/heads/a-x-001-01-longer", cwd=self.wt)
        self.assertIsNone(self.git.remote_head("a-x-001"))              # prefix of another branch is not a match

    def test_create_and_safe_remove(self):
        self.git.fetch_base("master")
        self.git.create_worktree(self.wt, "a-x-001-01", "master")
        self.assertEqual(self.git.registered(self.wt), "a-x-001-01")
        (self.wt / "n").write_text("1")
        sh("git", "add", "n", cwd=self.wt)
        sh("git", "commit", "-qm", "work", cwd=self.wt)
        head = self.git.head(self.wt)
        # dirty tree, wrong merged HEAD and foreign paths are all refused; nothing is removed
        (self.wt / "u").write_text("untracked")
        with self.assertRaises(CleanupBlocked):
            self.git.remove_owned(self.wt, "a-x-001-01", head)
        (self.wt / "u").unlink()
        with self.assertRaises(CleanupBlocked):
            self.git.remove_owned(self.wt, "a-x-001-01", "0" * 40)
        with self.assertRaises(CleanupBlocked):
            self.git.remove_owned(self.repo, "master", head)  # the user's own checkout
        with self.assertRaises(CleanupBlocked):
            self.git.remove_owned(self.wt, "someone-elses-branch", head)
        self.assertTrue(self.wt.exists())
        self.git.remove_owned(self.wt, "a-x-001-01", head)  # squash-merge safe: HEAD equality
        self.assertFalse(self.wt.exists())
        self.assertNotEqual(subprocess.run(["git", "rev-parse", "--verify", "-q", "a-x-001-01"],
                                           cwd=self.repo, env=ENV).returncode, 0)

    def _pr_branch_advanced_remotely(self, branch):
        """Worktree commits+pushes `branch`; a second clone then adds commits on top (GitHub 'Update branch')."""
        self.git.fetch_base("master")
        self.git.create_worktree(self.wt, branch, "master")
        (self.wt / "n").write_text("1")
        sh("git", "add", "n", cwd=self.wt)
        sh("git", "commit", "-qm", "work", cwd=self.wt)
        sh("git", "push", "-q", "origin", f"HEAD:refs/heads/{branch}", cwd=self.wt)
        old = self.git.head(self.wt)
        self.other_no += 1
        other = Path(self.tmp.name) / f"other-{self.other_no}"
        self.other = other
        sh("git", "clone", "-q", "-b", branch, str(Path(self.tmp.name) / "origin.git"), str(other), cwd=self.tmp.name)
        for i in (1, 2):                                    # more than one new commit
            (other / f"u{i}").write_text("u")
            sh("git", "add", f"u{i}", cwd=other)
            sh("git", "commit", "-qm", f"update {i}", cwd=other)
        sh("git", "push", "-q", "origin", f"HEAD:refs/heads/{branch}", cwd=other)
        new = subprocess.run(["git", "rev-parse", "HEAD"], cwd=other, env=ENV, check=True,
                             capture_output=True, text=True).stdout.strip()
        return old, new

    def test_behind_clean_worktree_is_fast_forwarded_then_removed(self):
        old, new = self._pr_branch_advanced_remotely("a-x-001-01")
        self.assertNotEqual(old, new)
        self.git.remove_owned(self.wt, "a-x-001-01", new)
        self.assertFalse(self.wt.exists())

    def test_unsafe_head_mismatch_is_preserved_untouched(self):
        old, new = self._pr_branch_advanced_remotely("a-x-001-01")
        # dirty: not synced, not removed
        (self.wt / "u").write_text("untracked")
        with self.assertRaises(CleanupBlocked):
            self.git.remove_owned(self.wt, "a-x-001-01", new)
        self.assertEqual(self.git.head(self.wt), old)
        (self.wt / "u").unlink()
        # diverged: local commit not in the PR history -> blocked, HEAD kept
        (self.wt / "local").write_text("l")
        sh("git", "add", "local", cwd=self.wt)
        sh("git", "commit", "-qm", "local only", cwd=self.wt)
        mine = self.git.head(self.wt)
        with self.assertRaises(CleanupBlocked):
            self.git.remove_owned(self.wt, "a-x-001-01", new)
        self.assertEqual(self.git.head(self.wt), mine)
        # unreachable PR head: blocked
        with self.assertRaises(CleanupBlocked):
            self.git.remove_owned(self.wt, "a-x-001-01", "0" * 40)
        self.assertTrue(self.wt.exists())

    def test_update_branch_fast_forward_requires_unchanged_protected_artifact(self):
        branch = "a-x-001-01"
        old, new = self._pr_branch_advanced_remotely(branch)
        returned = self.git.fast_forward_open_pr(self.wt, branch, new, {"n"})
        self.assertEqual(returned, old)
        self.assertEqual(self.git.head(self.wt), new)
        self.assertEqual(self.git.dirty(self.wt), "")

    def test_update_branch_fast_forward_blocks_protected_artifact_change(self):
        branch = "a-x-001-01"
        old, new = self._pr_branch_advanced_remotely(branch)
        other = self.other
        (other / "n").write_text("candidate changed by Update branch")
        sh("git", "add", "n", cwd=other)
        sh("git", "commit", "-qm", "change protected candidate", cwd=other)
        sh("git", "push", "-q", "origin", f"HEAD:refs/heads/{branch}", cwd=other)
        changed = subprocess.run(["git", "rev-parse", "HEAD"], cwd=other, env=ENV, check=True,
                                 capture_output=True, text=True).stdout.strip()
        with self.assertRaises(FastForwardBlocked):
            self.git.fast_forward_open_pr(self.wt, branch, changed, {"n"})
        self.assertEqual(self.git.head(self.wt), old)

    def test_update_branch_fast_forward_refuses_local_divergence(self):
        branch = "a-x-001-01"
        old, remote = self._pr_branch_advanced_remotely(branch)
        (self.wt / "local-only").write_text("local")
        sh("git", "add", "local-only", cwd=self.wt)
        sh("git", "commit", "-qm", "local only", cwd=self.wt)
        diverged = self.git.head(self.wt)
        with self.assertRaises(FastForwardBlocked):
            self.git.fast_forward_open_pr(self.wt, branch, remote, {"n"})
        self.assertEqual(self.git.head(self.wt), diverged)

    def test_update_branch_fast_forward_refuses_remote_race_before_merge(self):
        branch = "a-x-001-01"
        old, remote = self._pr_branch_advanced_remotely(branch)
        other = self.other

        def move_remote():
            (other / "u3").write_text("race")
            sh("git", "add", "u3", cwd=other)
            sh("git", "commit", "-qm", "move during pre-FF recheck", cwd=other)
            sh("git", "push", "-q", "origin", f"HEAD:refs/heads/{branch}", cwd=other)

        with self.assertRaises(FastForwardRace):
            self.git.fast_forward_open_pr(self.wt, branch, remote, {"n"}, recheck=move_remote)
        self.assertEqual(self.git.head(self.wt), old)

    def test_scratch_dir_is_ignored_but_other_untracked_files_still_block(self):
        from warroom.gitops import SCRATCH_DIR
        self.git.fetch_base("master")
        self.git.create_worktree(self.wt, "a-x-001-01", "master")
        self.git.ignore_scratch()
        self.git.ignore_scratch()                                 # idempotent
        exclude = (self.repo / ".git/info/exclude").read_text().splitlines()
        self.assertEqual(exclude.count(f"/{SCRATCH_DIR}/"), 1)
        head = self.git.head(self.wt)
        rows = [(f"{SCRATCH_DIR}/a.txt", False), (f"{SCRATCH_DIR}/sub/b.mjs", False),    # scratch: ignored
                ("data/new.jsonl", True), (".scratch-a003/c1.txt", True),               # anything else: dirty
                (f"x{SCRATCH_DIR}/a.txt", True), (f"sub/{SCRATCH_DIR}/a.txt", True)]    # only the root dir is exempt
        for rel, dirty in rows:
            f = self.wt / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text("t")
            self.assertEqual(bool(self.git.dirty(self.wt).strip()), dirty, rel)
            if dirty:
                with self.assertRaises(CleanupBlocked):
                    self.git.remove_owned(self.wt, "a-x-001-01", head)
            f.unlink()
        (self.wt / SCRATCH_DIR).mkdir(exist_ok=True)
        (self.wt / SCRATCH_DIR / "left.txt").write_text("t")
        self.git.remove_owned(self.wt, "a-x-001-01", head)        # leftover scratch does not block cleanup
        self.assertFalse(self.wt.exists())

    def _simulate_registration_removed(self, branch, on_verified=None):
        self.git.fetch_base("master")
        self.git.create_worktree(self.wt, branch, "master")
        head = self.git.head(self.wt)
        gitdir = self.git.worktree_gitdir(self.wt)
        original = self.git._git

        def partial_remove(*args, **kwargs):
            if args[:2] == ("worktree", "remove"):
                shutil.rmtree(gitdir)    # Git dropped its admin entry before checkout deletion failed.
                return Result(255, "", "failed to delete checkout: Operation not permitted")
            return original(*args, **kwargs)

        self.git._git = partial_remove
        try:
            with self.assertRaises(GitError):
                self.git.remove_owned(self.wt, branch, head, on_verified=on_verified)
        finally:
            self.git._git = original
        self.assertIsNone(self.git.registered(self.wt))
        self.assertTrue(self.wt.exists())
        return head

    def _simulate_registered_partial_remove(self, branch, on_verified=None):
        """Delete one tracked path but leave Git's worktree registration/admin entry intact."""
        self.git.fetch_base("master")
        self.git.create_worktree(self.wt, branch, "master")
        (self.wt / "g").write_text("y")
        sh("git", "add", "g", cwd=self.wt)
        sh("git", "commit", "-qm", "add second tracked file", cwd=self.wt)
        head = self.git.head(self.wt)
        original = self.git._git

        def partial_remove(*args, **kwargs):
            if args[:2] == ("worktree", "remove"):
                (self.wt / "f").unlink()   # checkout removal failed after deleting one tracked file
                return Result(255, "", "failed to delete checkout: Operation not permitted")
            return original(*args, **kwargs)

        self.git._git = partial_remove
        try:
            with self.assertRaises(GitError):
                self.git.remove_owned(self.wt, branch, head, on_verified=on_verified)
        finally:
            self.git._git = original
        self.assertEqual(self.git.registered(self.wt), branch)
        self.assertIn("D f", self.git.dirty(self.wt))
        self.assertTrue(self.wt.exists())
        return head

    def _simulate_checkout_removed_admin_present(self, branch, on_verified=None, path=None):
        """Delete the checkout but retain its registered Git admin entry, as when admin deletion fails."""
        path = path or self.wt
        self.git.fetch_base("master")
        self.git.create_worktree(path, branch, "master")
        head = self.git.head(path)
        gitdir = self.git.worktree_gitdir(path)
        original = self.git._git

        def partial_remove(*args, **kwargs):
            if args[:2] == ("worktree", "remove"):
                shutil.rmtree(path)   # checkout deletion succeeded; admin entry deletion fails
                return Result(255, "", "failed to delete Git admin entry: Operation not permitted")
            return original(*args, **kwargs)

        self.git._git = partial_remove
        try:
            with self.assertRaises(GitError):
                self.git.remove_owned(path, branch, head, on_verified=on_verified)
        finally:
            self.git._git = original
        self.assertFalse(path.exists())
        self.assertEqual(self.git.registered(path), branch)
        self.assertTrue(gitdir.is_dir())
        self.assertEqual(Path((gitdir / "gitdir").read_text().strip()).resolve(), (path / ".git").resolve())
        return head, gitdir

    def test_registered_missing_checkout_retries_nonforce_remove_with_matching_proof(self):
        branch = "a-x-001-01"
        proofs = []
        head, gitdir = self._simulate_checkout_removed_admin_present(branch, lambda: proofs.append({
            "version": 1, "path": str(self.wt.resolve()), "branch": branch, "head_sha": self.git.head(self.wt),
            "remove_started": True,
        }))
        proof = proofs[0]
        proof["head_sha"] = head
        original = self.git._git
        observed = {"nonforce": False}

        def observe_retry(*args, **kwargs):
            if args[:2] == ("worktree", "remove"):
                observed["nonforce"] = "--force" not in args
                self.assertFalse(self.wt.exists())
                self.assertEqual(self.git.registered(self.wt), branch)
            return original(*args, **kwargs)

        self.git._git = observe_retry
        try:
            self.git.remove_owned(self.wt, branch, head, cleanup_proof=proof)
        finally:
            self.git._git = original

        self.assertTrue(observed["nonforce"])
        self.assertFalse(gitdir.exists())
        self.assertIsNone(self.git.registered(self.wt))
        self.assertNotEqual(subprocess.run(["git", "rev-parse", "--verify", "-q", branch], cwd=self.repo,
                                           env=ENV).returncode, 0)

    def test_registered_missing_checkout_requires_proof_exact_branch_and_head_and_empty_path(self):
        cases = ["missing proof", "wrong branch", "moved branch", "new file", "new directory", "new symlink"]
        for i, case in enumerate(cases, start=1):
            with self.subTest(case):
                path = self.wts / f"w{case.replace(' ', '-')}"
                branch = f"a-x-001-{i:02d}"
                head, gitdir = self._simulate_checkout_removed_admin_present(branch, path=path)
                proof = {"version": 1, "path": str(path.resolve()), "branch": branch,
                         "head_sha": head, "remove_started": True}
                requested_branch = branch
                requested_proof = proof
                if case == "missing proof":
                    requested_proof = None
                elif case == "wrong branch":
                    requested_branch = "another-branch"
                elif case == "moved branch":
                    moved = subprocess.run(["git", "commit-tree", f"{head}^{{tree}}", "-m", "moved"],
                                           cwd=self.repo, env=ENV, check=True, capture_output=True, text=True).stdout.strip()
                    sh("git", "update-ref", f"refs/heads/{branch}", moved, cwd=self.repo)
                elif case == "new file":
                    path.write_text("owner data")
                elif case == "new directory":
                    path.mkdir()
                    (path / "owner data").write_text("keep")
                else:
                    target = self.wts / f"foreign-{i}"
                    target.mkdir()
                    (target / "owner data").write_text("keep")
                    path.symlink_to(target, target_is_directory=True)

                with self.assertRaises((CleanupBlocked, GitError)):
                    self.git.remove_owned(path, requested_branch, head, cleanup_proof=requested_proof)
                self.assertEqual(self.git.registered(path), branch)
                self.assertTrue(gitdir.exists())
                if case == "new file":
                    self.assertEqual(path.read_text(), "owner data")
                elif case == "new directory":
                    self.assertEqual((path / "owner data").read_text(), "keep")
                elif case == "new symlink":
                    self.assertTrue(path.is_symlink())
                    self.assertEqual((target / "owner data").read_text(), "keep")
                else:
                    self.assertFalse(path.exists())

    def test_registered_partial_tracked_deletion_restores_then_retries_normal_remove(self):
        branch = "a-x-001-01"
        proofs = []
        head = self._simulate_registered_partial_remove(branch, lambda: proofs.append({
            "version": 1, "path": str(self.wt.resolve()), "branch": branch, "head_sha": self.git.head(self.wt),
            "remove_started": True,
        }))
        proof = proofs[0]
        proof["head_sha"] = head
        observed = {"restored_before_remove": False}
        original = self.git._git

        def observe_restore(*args, **kwargs):
            if args[:2] == ("worktree", "remove"):
                observed["restored_before_remove"] = (self.wt / "f").read_text() == "x"
                self.assertEqual(self.git.registered(self.wt), branch)
            return original(*args, **kwargs)

        self.git._git = observe_restore
        try:
            self.git.remove_owned(self.wt, branch, head, cleanup_proof=proof)
        finally:
            self.git._git = original

        self.assertTrue(observed["restored_before_remove"])
        self.assertFalse(self.wt.exists())
        self.assertIsNone(self.git.registered(self.wt))
        self.assertNotEqual(subprocess.run(["git", "rev-parse", "--verify", "-q", branch], cwd=self.repo,
                                           env=ENV).returncode, 0)

    def test_registered_partial_deletion_needs_proof_and_preserves_other_changes(self):
        branch = "a-x-001-01"
        proofs = []
        head = self._simulate_registered_partial_remove(branch, lambda: proofs.append({
            "version": 1, "path": str(self.wt.resolve()), "branch": branch, "head_sha": self.git.head(self.wt),
            "remove_started": True,
        }))
        proof = proofs[0]
        proof["head_sha"] = head

        with self.assertRaisesRegex(CleanupBlocked, "without matching cleanup proof"):
            self.git.remove_owned(self.wt, branch, head)
        self.assertFalse((self.wt / "f").exists())

        (self.wt / "g").write_text("owner edit")
        with self.assertRaisesRegex(CleanupBlocked, "changes outside partial deletion"):
            self.git.remove_owned(self.wt, branch, head, cleanup_proof=proof)
        self.assertEqual((self.wt / "g").read_text(), "owner edit")
        self.assertFalse((self.wt / "f").exists())

        (self.wt / "g").write_text("y")
        untracked = self.wt / "owner-new.txt"
        untracked.write_text("keep this too")
        with self.assertRaisesRegex(CleanupBlocked, "untracked/ignored data"):
            self.git.remove_owned(self.wt, branch, head, cleanup_proof=proof)
        self.assertEqual(untracked.read_text(), "keep this too")
        untracked.unlink()

        ignored = self.wt / "owner-private.txt"
        ignored.write_text("keep me")
        exclude = self.repo / ".git" / "info" / "exclude"
        exclude.write_text(exclude.read_text() + "\n/owner-private.txt\n")
        with self.assertRaisesRegex(CleanupBlocked, "untracked/ignored data"):
            self.git.remove_owned(self.wt, branch, head, cleanup_proof=proof)
        self.assertEqual(ignored.read_text(), "keep me")
        self.assertFalse((self.wt / "f").exists())
        self.assertEqual(self.git.registered(self.wt), branch)

    def test_registered_partial_deletion_blocks_when_branch_head_moved(self):
        branch = "a-x-001-01"
        proofs = []
        head = self._simulate_registered_partial_remove(branch, lambda: proofs.append({
            "version": 1, "path": str(self.wt.resolve()), "branch": branch, "head_sha": self.git.head(self.wt),
            "remove_started": True,
        }))
        proof = proofs[0]
        proof["head_sha"] = head
        (self.wt / "moved").write_text("new head")
        sh("git", "add", "moved", cwd=self.wt)
        sh("git", "commit", "-qm", "move branch after cleanup proof", cwd=self.wt)

        with self.assertRaisesRegex(CleanupBlocked, "HEAD moved"):
            self.git.remove_owned(self.wt, branch, head, cleanup_proof=proof)
        self.assertFalse((self.wt / "f").exists())
        self.assertTrue((self.wt / "moved").exists())
        self.assertEqual(self.git.registered(self.wt), branch)

    def test_partial_remove_persists_proof_and_retry_removes_only_residual_tracked_files(self):
        branch = "a-x-001-01"
        proofs = []
        head = self._simulate_registration_removed(branch, lambda: proofs.append({
            "version": 1, "path": str(self.wt.resolve()), "branch": branch, "head_sha": self.git.head(self.wt),
            "remove_started": True,
        }))
        (self.wt / "f").unlink()    # expected partial directory deletion after the admin entry disappeared
        proof = proofs[0]
        proof["head_sha"] = head

        self.git.remove_owned(self.wt, branch, head, cleanup_proof=proof)

        self.assertFalse(self.wt.exists())
        self.assertNotEqual(subprocess.run(["git", "rev-parse", "--verify", "-q", branch], cwd=self.repo,
                                           env=ENV).returncode, 0)

    def test_partial_remove_without_proof_or_with_ignored_residual_data_is_preserved(self):
        branch = "a-x-001-01"
        head = self._simulate_registration_removed(branch)
        with self.assertRaisesRegex(CleanupBlocked, "no matching durable"):
            self.git.remove_owned(self.wt, branch, head)
        self.assertTrue(self.wt.exists())

        proof = {"version": 1, "path": str(self.wt.resolve()), "branch": branch, "head_sha": head,
                 "remove_started": True}
        ignored = self.wt / "owner-private.txt"
        ignored.write_text("keep me")
        exclude = self.repo / ".git" / "info" / "exclude"
        exclude.write_text(exclude.read_text() + "\n/owner-private.txt\n")
        with self.assertRaisesRegex(CleanupBlocked, "untracked/ignored data"):
            self.git.remove_owned(self.wt, branch, head, cleanup_proof=proof)
        self.assertEqual(ignored.read_text(), "keep me")
        self.assertTrue(self.wt.exists())

    def test_refuses_existing_branch_or_path(self):
        self.git.fetch_base("master")
        self.git.create_worktree(self.wt, "b1", "master")
        with self.assertRaises(GitError):
            self.git.create_worktree(self.wts / "w2", "b1", "master")
        with self.assertRaises(GitError):
            self.git.create_worktree(self.wt, "b2", "master")
        sh("git", "push", "-q", "origin", "HEAD:refs/heads/remote-only", cwd=self.repo)
        with self.assertRaises(GitError):
            self.git.create_worktree(self.wts / "w3", "remote-only", "master")


class RealProcess(unittest.TestCase):
    def test_detached_run_records_session_and_exit(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            fake = d / "opencode"
            fake.write_text('#!/bin/sh\necho \'{"type":"x","sessionID":"ses_abc123"}\'\n'
                            'echo "args: $@" >&2\nexit 3\n')
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            a = OpenCodeAdapter(str(fake))
            h = a.start("prompt text", d, dict(os.environ), RunSpec("p/m", "high"), "title", d / "l.log", d / "l.exit")
            for _ in range(100):
                if not a.alive(h.pid):
                    break
                time.sleep(0.05)
            self.assertFalse(a.alive(h.pid))
            self.assertEqual(a.exit_code(h.exit_file), 3)
            self.assertEqual(a.session_id(h.log_file), "ses_abc123")
            self.assertIn("--model p/m#high", h.log_file.read_text())   # variant rides on --model (no --variant flag)
            self.assertNotIn("--variant", h.log_file.read_text())
            h2 = a.resume("ses_abc123", "again", d, dict(os.environ), RunSpec("p/m", "high"), d / "r.log", d / "r.exit")
            for _ in range(100):
                if not a.alive(h2.pid):
                    break
                time.sleep(0.05)
            self.assertIn("--session ses_abc123", h2.log_file.read_text())
            self.assertIn("--model p/m#high", h2.log_file.read_text())   # resume is pinned too

    def test_alive_while_child_outlives_wrapper(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            fake = d / "opencode"
            fake.write_text("#!/bin/sh\nsleep 30 &\nexit 0\n")   # launcher exits, worker stays
            fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
            a = OpenCodeAdapter(str(fake))
            h = a.start("p", d, dict(os.environ), RunSpec("p/m", "high"), "t", d / "c.log", d / "c.exit")
            try:
                for _ in range(100):
                    if a.exit_code(h.exit_file) == 0:   # wrapper finished
                        break
                    time.sleep(0.05)
                time.sleep(0.2)
                self.assertEqual(a.exit_code(h.exit_file), 0)
                self.assertTrue(a.alive(h.pid))          # group still has the worker
                a.stop(h.pid)
                for _ in range(100):
                    if not a.alive(h.pid):
                        break
                    time.sleep(0.05)
                self.assertFalse(a.alive(h.pid))
            finally:
                a.stop(h.pid)


if __name__ == "__main__":
    unittest.main()
