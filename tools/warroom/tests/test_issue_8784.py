"""Issue #8784 PR-2: formal Polish data PRs never occupy a shard; a conflicting Stage 2/3 PR is rebuilt by relation-key
replay through the official CLI instead of a textual Git merge."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from warroom import batches
from warroom.gitops import Git, IntegrationBlocked
from warroom.shell import Result, Runner

ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
       "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
       "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}
RELATION = "data/relations/relation-001.jsonl"
DROP = "data/relation-drops/drop-001.jsonl"
BRANCH = "s3-codex-001"


def sh(*args, cwd):
    return subprocess.run(args, cwd=cwd, env=ENV, check=True, capture_output=True, text=True).stdout.strip()


class PolishOccupancy(unittest.TestCase):
    def pr(self, title="[Polish] 고요하다", body="Refs #8777\n", paths=(RELATION, DROP)):
        return {"number": 9, "title": title, "body": body, "files": [{"path": p} for p in paths]}

    def test_formal_polish_data_pr_occupies_no_shard(self):
        self.assertEqual(batches.pr_stage2_shards(self.pr()), set())
        self.assertEqual(batches.pr_stage3_shards(self.pr()), set())
        self.assertEqual(batches.pr_stage2_shards(self.pr(body="Refs https://github.com/o/r/issues/8777")), set())

    def test_every_other_shape_keeps_the_shard_occupancy(self):
        for pr in (self.pr(body=""), self.pr(body="Refs #87770"), self.pr(title="[S2/Codex] 001_01 Part 01"),
                   self.pr(paths=(RELATION, "scripts/relation/polish-cli.mjs")), self.pr(title="Polish")):
            self.assertEqual(batches.pr_stage2_shards(pr), {"001"}, pr)
        no_body = {"number": 9, "title": "[Polish] x", "files": [{"path": RELATION}]}
        self.assertEqual(batches.pr_claims({"method": batches.STAGE2_METHOD}, no_body), [(batches.STAGE2_METHOD, "001")])


class ReplayRunner(Runner):
    """Real Git; the Node replay CLI is replaced by a fixed result so only the Git choreography is under test."""

    def __init__(self):
        self.calls, self.resolved, self.fail = [], None, False

    def run(self, argv, cwd=None, env=None, input=None, timeout=120):
        if argv[0] != "node":
            return super().run(argv, cwd=cwd, env=env, input=input, timeout=timeout)
        self.calls.append(argv)
        if self.fail:
            return Result(1, "", "replay would introduce Candidate accounting problems")
        Path(cwd, RELATION).write_text(self.resolved, "utf-8")
        return Result(0, json.dumps({"version": 1, "ok": True, "files": [{"path": RELATION, "conflicts": []}]}) + "\n")


class RelationReplayMerge(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        bare = root / "origin.git"
        sh("git", "init", "-q", "--bare", "-b", "master", str(bare), cwd=root)
        sh("git", "clone", "-q", str(bare), "repo", cwd=root)
        self.repo = root / "repo"
        self.runner = ReplayRunner()
        self.git = Git(self.runner, self.repo, ENV, root / "worktrees")
        (self.repo / RELATION).parent.mkdir(parents=True)
        (self.repo / RELATION).write_text('{"a":1}\n', "utf-8")
        (self.repo / "notes.txt").write_text("base\n", "utf-8")
        sh("git", "add", "-A", cwd=self.repo)
        sh("git", "commit", "-qm", "base", cwd=self.repo)
        sh("git", "push", "-q", "origin", "HEAD:refs/heads/master", cwd=self.repo)
        self.wt = root / "worktrees" / "s3"
        self.git.fetch_base("master")
        self.git.create_worktree(self.wt, BRANCH, "master")
        (self.wt / RELATION).write_text('{"a":1}\n{"stage":3}\n', "utf-8")
        sh("git", "commit", "-qam", "Stage 3", cwd=self.wt)
        self.before = self.git.head(self.wt)

    def tearDown(self):
        self.tmp.cleanup()

    def polish(self, **files):
        for name, text in files.items():
            (self.repo / name).write_text(text, "utf-8")
        sh("git", "commit", "-qam", "[Polish] merged", cwd=self.repo)
        sh("git", "push", "-q", "origin", "HEAD:refs/heads/master", cwd=self.repo)
        return sh("git", "rev-parse", "HEAD", cwd=self.repo)

    def test_append_conflict_is_replayed_by_the_cli_and_committed_as_a_merge(self):
        sha = self.polish(**{RELATION: '{"a":1}\n{"polish":1}\n'})
        self.runner.resolved = '{"a":1}\n{"polish":1}\n{"stage":3}\n'
        head, report = self.git.replay_relation_merge(self.wt, BRANCH, "master", sha, {RELATION, DROP})
        self.assertTrue(report["ok"])
        self.assertEqual(sh("git", "rev-parse", "HEAD^1", "HEAD^2", cwd=self.wt).split(), [self.before, sha])
        self.assertEqual((self.wt / RELATION).read_text("utf-8"), self.runner.resolved)
        self.assertEqual(self.git.dirty(self.wt).strip(), "")
        base = sh("git", "merge-base", self.before, sha, cwd=self.wt)
        self.assertEqual(self.runner.calls[0][1:], ["scripts/relation/replay-cli.mjs", "--base", base, "--ours", self.before,
                                                    "--theirs", sha])
        self.assertEqual(self.git.replay_relation_merge(self.wt, BRANCH, "master", sha, {RELATION})[1], {"status": "no-op"})

    def test_stage2_uses_its_checkpoint_replay(self):
        sha = self.polish(**{RELATION: '{"a":1}\n{"polish":1}\n'})
        self.runner.resolved = '{"a":1}\n{"polish":1}\n{"stage":3}\n'
        self.git.replay_relation_merge(self.wt, BRANCH, "master", sha, {RELATION}, ".warroom-scratch/cp.json")
        self.assertEqual(self.runner.calls[0][1:], ["scripts/relation/admission-cli.mjs", "replay", "--checkpoint",
                                                    ".warroom-scratch/cp.json", "--theirs", sha])

    def assert_untouched(self):
        self.assertEqual(self.git.head(self.wt), self.before)
        self.assertEqual(self.git.dirty(self.wt).strip(), "")

    def test_other_conflicts_or_a_failed_replay_leave_the_worktree_as_it_was(self):
        (self.wt / "notes.txt").write_text("stage\n", "utf-8")
        sh("git", "commit", "-qam", "notes", cwd=self.wt)
        self.before = self.git.head(self.wt)
        sha = self.polish(**{RELATION: '{"a":1}\n{"polish":1}\n', "notes.txt": "polish\n"})
        with self.assertRaisesRegex(IntegrationBlocked, "notes.txt"):
            self.git.replay_relation_merge(self.wt, BRANCH, "master", sha, {RELATION})
        self.assert_untouched()
        self.assertEqual(self.runner.calls, [])
        with self.assertRaisesRegex(IntegrationBlocked, "소유가 아닌"):
            self.git.replay_relation_merge(self.wt, BRANCH, "master", sha, {DROP})
        self.assert_untouched()

    def test_failed_replay_aborts_the_merge(self):
        sha = self.polish(**{RELATION: '{"a":1}\n{"polish":1}\n'})
        self.runner.fail = True
        with self.assertRaisesRegex(IntegrationBlocked, "relation replay 실패"):
            self.git.replay_relation_merge(self.wt, BRANCH, "master", sha, {RELATION})
        self.assert_untouched()


if __name__ == "__main__":
    unittest.main()
