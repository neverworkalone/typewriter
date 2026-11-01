"""Issue #2569: push only a verified Maintainer integration to the owned open PR, then retry once."""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.fakes import HEAD1, World
from tests.test_issue_1555 import MERGE, report
from tests.test_lines import multi_world
from warroom import stage3
from warroom.gitops import Git, GitTransient, IntegrationBlocked
from warroom.shell import Runner
from warroom.store import STAGE3_METHOD

ENV = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
       "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
       "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}
BRANCH = "a-deepseek-001-01"
OUTPUT = "data/relation-candidates/001/001_01_a_deepseek.jsonl"


def sh(*args, cwd):
    subprocess.run(args, cwd=cwd, env=ENV, check=True, capture_output=True)


class RealGitSync(unittest.TestCase):
    """Use linked worktrees and a bare remote to exercise the actual merge and ordinary push path."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.bare = root / "origin.git"
        sh("git", "init", "-q", "--bare", "-b", "master", str(self.bare), cwd=root)
        sh("git", "clone", "-q", str(self.bare), "repo", cwd=root)
        self.repo = root / "repo"
        self.worktrees = root / "worktrees"
        self.git = Git(Runner(), self.repo, ENV, self.worktrees)

        output = self.repo / OUTPUT
        output.parent.mkdir(parents=True)
        output.write_text("source\nmiddle\n", "utf-8")
        (self.repo / "validator.mjs").write_text("before\n", "utf-8")
        sh("git", "add", OUTPUT, "validator.mjs", cwd=self.repo)
        sh("git", "commit", "-qm", "base", cwd=self.repo)
        sh("git", "push", "-q", "origin", "HEAD:refs/heads/master", cwd=self.repo)

        self.wt = self.worktrees / "batch"
        self.git.fetch_base("master")
        self.git.create_worktree(self.wt, BRANCH, "master")
        candidate = self.wt / OUTPUT
        candidate.write_text("source\nmiddle\ncandidate\n", "utf-8")
        sh("git", "add", OUTPUT, cwd=self.wt)
        sh("git", "commit", "-qm", "candidate output", cwd=self.wt)
        sh("git", "push", "-q", "origin", f"HEAD:refs/heads/{BRANCH}", cwd=self.wt)
        self.pr_head = self.git.head(self.wt)

    def tearDown(self):
        self.tmp.cleanup()

    def add_maintainer_commit(self, *, protected=False, descendant_of_pr=False):
        if descendant_of_pr:
            # Model the approved integration as a fast-forward from the recorded PR head.
            sh("git", "push", "-q", "origin", f"{self.pr_head}:refs/heads/master", cwd=self.repo)
            sh("git", "fetch", "-q", "origin", cwd=self.repo)
            sh("git", "merge", "--ff-only", "origin/master", cwd=self.repo)
        target = self.repo / (OUTPUT if protected else "validator.mjs")
        if protected:
            target.write_text("fixed source\nmiddle\n", "utf-8")
        else:
            target.write_text("after\n", "utf-8")
        sh("git", "add", str(target.relative_to(self.repo)), cwd=self.repo)
        sh("git", "commit", "-qm", "approved Maintainer fix", cwd=self.repo)
        sh("git", "push", "-q", "origin", "HEAD:refs/heads/master", cwd=self.repo)
        self.merge_sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo, env=ENV,
                                        check=True, capture_output=True, text=True).stdout.strip()
        self.local_head = self.git.integrate(self.wt, BRANCH, "master", self.merge_sha)

    def sync(self, api_head=None):
        api = {"head": api_head or self.pr_head}
        checks = []

        def recheck(expected):
            checks.append(expected)
            if expected == self.local_head and self.git.remote_head(BRANCH) == self.local_head:
                api["head"] = expected
            if api["head"] != expected:
                if api["head"] in {self.pr_head, self.local_head}:
                    raise GitTransient(f"stale test API HEAD: {api['head']}")
                raise IntegrationBlocked("unexpected PR head")
        result = self.git.push_approved_maintainer_integration(
            self.wt, BRANCH, api["head"], self.pr_head, self.merge_sha, {OUTPUT}, recheck=recheck)
        return result, checks, api

    def test_merge_commit_is_pushed_once_and_repeat_is_idempotent(self):
        self.add_maintainer_commit()
        self.assertNotEqual(self.local_head, self.merge_sha)  # #2562 merge DAG: parents are PR A and fix M.
        result, checks, _ = self.sync()
        self.assertEqual(result, self.local_head)
        self.assertEqual(self.git.remote_head(BRANCH), self.local_head)
        self.assertEqual(self.git.dirty(self.wt), "")
        self.assertEqual(self.git.head(self.wt), result)
        self.assertEqual(checks, [self.pr_head, self.local_head])

        # Crash after push but before defect release: the same evidence proves sync, with no second push.
        before = self.git.remote_head(BRANCH)
        result = self.git.push_approved_maintainer_integration(
            self.wt, BRANCH, before, self.pr_head, self.merge_sha, {OUTPUT},
            recheck=lambda expected: self.assertEqual(expected, before))
        self.assertEqual(result, before)
        self.assertEqual(self.git.remote_head(BRANCH), before)

    def test_fast_forward_form_of_the_approved_integration_is_allowed(self):
        self.add_maintainer_commit(descendant_of_pr=True)
        self.assertEqual(self.local_head, self.merge_sha)
        result, checks, _ = self.sync()
        self.assertEqual(result, self.merge_sha)
        self.assertEqual(self.git.remote_head(BRANCH), self.merge_sha)
        self.assertEqual(checks, [self.pr_head, self.merge_sha])

    def test_extra_local_commit_is_blocked(self):
        self.add_maintainer_commit()
        extra = self.wt / "unapproved.txt"
        extra.write_text("unapproved\n", "utf-8")
        sh("git", "add", "unapproved.txt", cwd=self.wt)
        sh("git", "commit", "-qm", "unapproved local commit", cwd=self.wt)
        with self.assertRaises(IntegrationBlocked):
            self.git.push_approved_maintainer_integration(
                self.wt, BRANCH, self.pr_head, self.pr_head, self.merge_sha, {OUTPUT})
        self.assertEqual(self.git.remote_head(BRANCH), self.pr_head)

    def test_protected_output_change_is_blocked(self):
        self.add_maintainer_commit(protected=True)
        with self.assertRaises(IntegrationBlocked):
            self.git.push_approved_maintainer_integration(
                self.wt, BRANCH, self.pr_head, self.pr_head, self.merge_sha, {OUTPUT})
        self.assertEqual(self.git.remote_head(BRANCH), self.pr_head)

    def test_dirty_worktree_and_remote_race_are_blocked_without_push(self):
        self.add_maintainer_commit()
        (self.wt / "untracked").write_text("partial output", "utf-8")
        with self.assertRaises(IntegrationBlocked):
            self.git.push_approved_maintainer_integration(
                self.wt, BRANCH, self.pr_head, self.pr_head, self.merge_sha, {OUTPUT})
        (self.wt / "untracked").unlink()

        root = Path(self.tmp.name)
        other = root / "other"
        sh("git", "clone", "-q", "-b", BRANCH, str(self.bare), str(other), cwd=root)

        def move_remote(expected):
            self.assertEqual(expected, self.pr_head)
            (other / "racer.txt").write_text("concurrent update\n", "utf-8")
            sh("git", "add", "racer.txt", cwd=other)
            sh("git", "commit", "-qm", "concurrent PR update", cwd=other)
            sh("git", "push", "-q", "origin", f"HEAD:refs/heads/{BRANCH}", cwd=other)

        with self.assertRaises(IntegrationBlocked):
            self.git.push_approved_maintainer_integration(
                self.wt, BRANCH, self.pr_head, self.pr_head, self.merge_sha, {OUTPUT}, recheck=move_remote)
        self.assertEqual(self.git.head(self.wt), self.local_head)
        self.assertNotEqual(self.git.remote_head(BRANCH), self.local_head)


class SupervisorRelease(unittest.TestCase):
    def setUp(self):
        self.w = multi_world()
        self.w.start("single", "deepseek", "a")
        self.w.adapter.plan.append({"code": 0, "session": "producer-session", "effect": lambda: (
            self.w.pr_info(7, HEAD1, head_ref=BRANCH),
            self.w.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        self.w.tick()
        self.w.adapter.finish(self.w.adapter.launches[-1]["pid"])
        self.w.tick()
        body = ("-1\nHEAD: " + HEAD1 + "\n공통 수정 필요\n```warroom-shared-defect\n" +
                json.dumps(report()) + "\n```\n")
        self.w.gh.reviews_ = [{"id": 31, "user": {"login": "genonfire"}, "body": body,
                              "commit_id": HEAD1, "submitted_at": "2026-10-21T10:00:00Z"}]
        self.w.tick(2)
        self.batch = self.w.row()
        self.defect = self.w.store.defects()[0]
        self.assertEqual((self.batch["state"], self.batch["paused_from"], self.batch["pr_number"]),
                         ("PAUSED", "WAITING_REVIEW", 7))
        self.w.git.integrate_updates_head = True
        self.w.git.changed[MERGE] = ["README.md"]
        self.w.store.update_defect(self.defect["id"], state="FIX_MERGED", merge_sha=MERGE)

    def tearDown(self):
        self.w.tmp.cleanup()

    def test_sync_then_release_reuses_the_pr_and_old_minus_one_does_not_replay(self):
        w, batch = self.w, self.batch
        before = len(w.adapter.launches)
        w.git.maintainer_after_push = lambda sha: w.pr_info(7, sha, head_ref=batch["branch"])

        w.sup.maint._release()
        current = w.store.batch(batch["id"])
        self.assertEqual((current["state"], current["pause_reason"], current["pr_number"], current["branch"]),
                         ("WAITING_REVIEW", "", 7, batch["branch"]))
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "RELEASED")
        self.assertEqual(len(w.git.maintainer_pushes), 1)
        self.assertEqual(w.git.maintainer_pushes[0][0], batch["branch"])
        self.assertEqual(len(w.adapter.launches), before)

        # Watcher reads the same PR at its new HEAD; the old -1 is anchored to HEAD1 and is not a fresh event.
        w.tick(2)
        current = w.store.batch(batch["id"])
        self.assertEqual((current["state"], current["head_sha"]), ("WAITING_REVIEW", w.git.local_head))
        self.assertEqual(len(w.adapter.launches), before)
        self.assertEqual(len(w.git.maintainer_pushes), 1)

        # A new blocker on the integrated HEAD still enters the ordinary fix watcher.
        w.gh.reviews_.append({"id": 32, "user": {"login": "genonfire"},
                              "body": "-1\nHEAD: " + w.git.local_head + "\nnew-head finding",
                              "commit_id": w.git.local_head, "submitted_at": "2026-10-22T10:00:00Z"})
        w.tick(2)
        self.assertEqual(w.store.batch(batch["id"])["state"], "FIXING")
        self.assertEqual(len(w.adapter.launches), before + 1)

    def test_push_before_release_crash_and_api_lag_retry_without_duplicate_push(self):
        w, batch = self.w, self.batch
        # Simulate a push that succeeded while the API still returns the original PR SHA.
        w.git.maintainer_after_push = lambda sha: w.pr_info(7, sha, head_ref=batch["branch"])
        w.sup.maint._apply(w.store.defect(self.defect["id"]), w.store.batch(batch["id"]))
        self.assertEqual(len(w.git.maintainer_pushes), 1)
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "FIX_MERGED")

        # A crash/restart repeats integration and sees the exact remote state; it does not push a second time.
        w.pr_info(7, w.git.local_head, head_ref=batch["branch"])
        w.sup.maint._release()
        self.assertEqual(len(w.git.maintainer_pushes), 1)
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "RELEASED")
        self.assertEqual(w.store.batch(batch["id"])["state"], "WAITING_REVIEW")

    def test_api_lag_is_retryable_without_duplicate_push(self):
        w, batch = self.w, self.batch
        w.git.maintainer_after_push = None  # PR API stays at the old SHA after the remote push.
        w.sup.maint._release()
        self.assertEqual(len(w.git.maintainer_pushes), 1)
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "FIX_MERGED")
        self.assertEqual(w.store.batch(batch["id"])["state"], "PAUSED")

        # GitHub now reflects the push; a repeated poll releases the same PR without another push.
        w.pr_info(7, w.git.local_head, head_ref=batch["branch"])
        w.sup.maint._release()
        self.assertEqual(len(w.git.maintainer_pushes), 1)
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "RELEASED")

    def test_pending_stop_and_closed_pr_never_push_or_resume(self):
        w, batch = self.w, self.batch
        w.store.set(f"defect_hold_{batch['id']}", "1")
        w.sup.maint._release()
        self.assertEqual(w.git.maintainer_pushes, [])
        self.assertEqual(w.store.batch(batch["id"])["state"], "PAUSED")

        w.store.delete(f"defect_hold_{batch['id']}")
        w.pr_info(7, HEAD1, state="closed", head_ref=batch["branch"])
        w.sup.maint._release()
        self.assertEqual(w.git.maintainer_pushes, [])
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "HELD")
        self.assertEqual(w.store.batch(batch["id"])["state"], "PAUSED")

    def test_live_ai_process_prevents_integration_and_push(self):
        w, batch = self.w, self.batch
        w.store.update(batch["id"], pid=4242)
        w.sup.maint._release()
        self.assertEqual(w.git.integrated, [])
        self.assertEqual(w.git.maintainer_pushes, [])
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "FIX_MERGED")
        self.assertEqual(w.store.batch(batch["id"])["state"], "PAUSED")

    def test_failed_required_verification_never_pushes_or_releases(self):
        w, batch = self.w, self.batch
        w.git.changed[MERGE] = ["scripts/validator.mjs"]
        w.sup.maint._release()
        self.assertEqual(w.git.maintainer_pushes, [])
        self.assertEqual(w.git.maintainer_sync_calls, [])
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "HELD")
        self.assertEqual(w.store.batch(batch["id"])["state"], "PAUSED")

    def test_wrong_head_branch_is_held_without_push(self):
        w, batch = self.w, self.batch
        w.pr_info(7, HEAD1, head_ref="foreign/repo:" + batch["branch"])
        w.sup.maint._release()
        self.assertEqual(w.git.maintainer_pushes, [])
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "HELD")
        self.assertEqual(w.store.batch(batch["id"])["state"], "PAUSED")


class Stage3FinalizeRelease(unittest.TestCase):
    relation = "data/relations/relation-001.jsonl"
    drops = "data/relation-drops/drop-001.jsonl"

    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)
        self.w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}
        self.path = self.w.paths.worktrees / "s3-001"
        self.path.mkdir(parents=True)
        self.branch = "s3-codex-001"
        self.w.git.reg[str(self.path)] = self.branch
        self.w.git.remote[self.branch] = None
        self.batch_id = self.w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="all",
                                                  branch=self.branch, worktree=str(self.path))
        self.w.store.update(self.batch_id, state="PRODUCING", run_kind="s3_finalize")
        self.w.gh.issues[2450] = {"state": "open", "labels": [], "title": "Stage 3", "body": ""}
        checkpoint_path = stage3.checkpoint_path(self.path, "001")
        checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
        checkpoint_path.write_text(json.dumps({"version": 1, "shard": "001", "chunk_total": 1,
                                               "completed_chunks": ["001"], "decisions": []}), "utf-8")

        def apply(_runner, _env, worktree, shard):
            self.assertEqual((Path(worktree), shard), (self.path, "001"))
            checkpoint_path.unlink()
            self.w.git.dirty_text = f" M {self.relation}\n M {self.drops}\n"
            return {"removed": 0, "repaired": 0, "edit_drops_added": 0}

        with mock.patch.object(stage3, "apply", side_effect=apply), \
                mock.patch.object(stage3, "report", return_value={"shard": "001", "deleted_relations": [],
                                                                     "link_repairs": [], "added_drops": []}), \
                mock.patch.object(self.w.sup, "_stage3_finalize_verify", return_value=None):
            self.w.sup._stage3_finalize_do(self.w.store.batch(self.batch_id))

        self.batch = self.w.store.batch(self.batch_id)
        self.pr_number = self.batch["pr_number"]
        self.committed_head = self.batch["head_sha"]
        self.assertEqual((self.batch["state"], self.batch["run_kind"]), ("WAITING_REVIEW", "s3_finalize"))
        self.assertEqual(self.w.store.get(f"s3_commit_remote_head_{self.batch_id}"), "")
        self.assertEqual(self.w.git.remote_head(self.branch), self.committed_head)

        body = (f"-1\nHEAD: {self.committed_head}\n공통 수정 필요\n```warroom-shared-defect\n"
                + json.dumps(report()) + "\n```\n")
        self.w.gh.reviews_ = [{"id": 41, "user": {"login": "genonfire"}, "body": body,
                               "commit_id": self.committed_head, "submitted_at": "2026-10-21T10:00:00Z"}]
        self.w.sup._watch(self.batch)
        self.batch = self.w.store.batch(self.batch_id)
        self.defect = self.w.store.defects()[0]
        self.assertEqual((self.batch["state"], self.batch["paused_from"], self.batch["pr_number"]),
                         ("PAUSED", "WAITING_REVIEW", self.pr_number))
        self.w.git.integrated.append((str(self.path), self.committed_head))
        self.w.git.integrate_updates_head = True
        self.w.git.changed[MERGE] = ["README.md"]
        self.w.store.update_defect(self.defect["id"], state="FIX_MERGED", merge_sha=MERGE)

    def _reflect_push_in_github(self, sha):
        info = self.w.gh.prs[self.pr_number]
        self.w.gh.prs[self.pr_number] = info | {"head_sha": sha}
        self.w.gh.by_branch[self.branch] = [{"number": self.pr_number, "state": "OPEN", "headRefOid": sha}]

    def test_completed_stage3_pr_preflights_then_releases_on_the_same_updated_pr(self):
        w = self.w
        launches = len(w.adapter.launches)
        w.git.maintainer_after_push = self._reflect_push_in_github

        w.sup.maint._release()

        current = w.store.batch(self.batch_id)
        self.assertEqual((current["state"], current["pr_number"], current["branch"]),
                         ("WAITING_REVIEW", self.pr_number, self.branch))
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "RELEASED")
        self.assertEqual(w.store.get(f"s3_finalize_released_head_{self.batch_id}"), MERGE)
        self.assertEqual(w.git.remote_head(self.branch), MERGE)
        self.assertEqual(w.git.head(self.path), MERGE)
        self.assertEqual(w.gh.pull(self.pr_number)["head_sha"], MERGE)
        self.assertEqual(len(w.git.maintainer_pushes), 1)

        # The trusted -1 belongs to the previous Stage 3 PR HEAD and must not replay after the safe rebind.
        w.sup._watch(current)
        self.assertEqual(w.store.batch(self.batch_id)["head_sha"], MERGE)
        self.assertEqual(w.store.batch(self.batch_id)["state"], "WAITING_REVIEW")
        self.assertEqual(len(w.adapter.launches), launches)
        self.assertEqual(len(w.git.maintainer_pushes), 1)

    def test_damaged_stage3_finalize_remote_baseline_blocks_before_pr_push(self):
        w = self.w
        w.store.set(f"s3_commit_remote_head_{self.batch_id}", "damaged-baseline")
        w.git.maintainer_after_push = self._reflect_push_in_github

        w.sup.maint._release()

        self.assertEqual(w.git.maintainer_pushes, [])
        self.assertEqual(w.git.remote_head(self.branch), self.committed_head)
        self.assertEqual(w.gh.pull(self.pr_number)["head_sha"], self.committed_head)
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "HELD")
        self.assertEqual(w.store.batch(self.batch_id)["state"], "PAUSED")

    def test_stage3_api_lag_retry_reuses_the_completed_push_and_preflight(self):
        w = self.w
        w.git.maintainer_after_push = None

        w.sup.maint._release()

        self.assertEqual(len(w.git.maintainer_pushes), 1)
        self.assertEqual(w.git.remote_head(self.branch), MERGE)
        self.assertEqual(w.gh.pull(self.pr_number)["head_sha"], self.committed_head)
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "FIX_MERGED")
        self.assertEqual(w.store.batch(self.batch_id)["state"], "PAUSED")

        # A retry while GitHub still reports the old SHA waits; it must not hold or push again.
        w.sup.maint._release()
        self.assertEqual(len(w.git.maintainer_pushes), 1)
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "FIX_MERGED")
        self.assertEqual(w.store.batch(self.batch_id)["state"], "PAUSED")

        self._reflect_push_in_github(MERGE)
        w.sup.maint._release()

        self.assertEqual(len(w.git.maintainer_pushes), 1)
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "RELEASED")
        self.assertEqual(w.store.batch(self.batch_id)["state"], "WAITING_REVIEW")
        self.assertEqual(w.store.get(f"s3_finalize_released_head_{self.batch_id}"), MERGE)

    def test_incomplete_stage3_finalize_cannot_use_completed_pr_rebind(self):
        w = self.w
        w.store.update(self.batch_id, paused_from="PRODUCING")
        w.git.maintainer_after_push = self._reflect_push_in_github

        w.sup.maint._release()

        self.assertEqual(w.git.maintainer_pushes, [])
        self.assertEqual(w.git.remote_head(self.branch), self.committed_head)
        self.assertEqual(w.store.defect(self.defect["id"])["state"], "HELD")
        self.assertEqual(w.store.batch(self.batch_id)["state"], "PAUSED")


if __name__ == "__main__":
    unittest.main()
