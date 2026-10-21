import os
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from warroom.adapters import OpenCodeAdapter, RunSpec
from warroom.gitops import CleanupBlocked, Git, GitError
from warroom.shell import Runner

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
        (self.repo / "f").write_text("x")
        sh("git", "add", "f", cwd=self.repo)
        sh("git", "commit", "-qm", "init", cwd=self.repo)
        sh("git", "push", "-q", "origin", "HEAD:master", cwd=self.repo)
        self.wts = t / "wts"
        self.git = Git(Runner(), self.repo, ENV, self.wts)
        self.wt = self.wts / "w1"

    def tearDown(self):
        self.tmp.cleanup()

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
