"""Issue #1875: keep producer runs out of Supervisor cleanup and recover proven partial removals safely."""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.fakes import HEAD1, FakeAdapter, World
from warroom import control, prompts
from warroom.gitops import CleanupBlocked, GitError


BIN = Path(__file__).resolve().parents[1] / "bin"


class FinalResultAdapter(FakeAdapter):
    requires_session_for_pr = True
    requires_final_result_for_pr = True

    def start(self, prompt, cwd, env, run, title, log_file, exit_file):
        self.last_env = dict(env)
        return super().start(prompt, cwd, env, run, title, log_file, exit_file)


def install_batch_pr(w, b, number=1870, *, merged=True, state="closed"):
    branch = b["branch"]
    w.pr_info(number, HEAD1, state=state, merged=merged, head_ref=branch)
    w.gh.by_branch[branch] = [{"number": number, "state": state.upper(), "headRefOid": HEAD1}]
    w.gh.files[number] = [{"path": f"data/relation-candidates/{b['shard']}/"
                                  f"{b['shard']}_{b['batch']}_{b['method']}_{b['producer']}.jsonl"}]
    if state == "open":
        w.git.remote[branch] = HEAD1


class Recovery(unittest.TestCase):
    def test_missing_pr_number_recovers_merged_claim_without_registration_or_ai_rerun(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single", method="b")
        w.tick()
        b = w.row(method="b")
        w.adapter.stop(b["pid"])
        w.store.update(b["id"], state="ERROR", paused_from="PRODUCING", pr_number=None,
                       records_done=500, records_total=500, error="lost final run status")
        w.git.reg.pop(b["worktree"])
        install_batch_pr(w, b)

        w.tick()  # recover exact merged PR ownership, without needing the deleted registration
        self.assertEqual((w.row(method="b")["state"], w.row(method="b")["pr_number"]), ("MERGED", 1870))
        w.tick(2)  # cleanup fails closed because this historical case has no pre-removal proof

        row = w.row(method="b")
        self.assertEqual((row["state"], row["paused_from"]), ("ERROR", "CLEANUP"))
        self.assertIn("no matching cleanup proof", row["error"])
        self.assertTrue(Path(b["worktree"]).exists())
        self.assertEqual(len(w.adapter.launches), 1)

    def test_cleanup_proof_survives_supervisor_restart_and_retry(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single", method="b")
        w.tick()
        b = w.row(method="b")
        install_batch_pr(w, b)
        w.store.update(b["id"], state="MERGED", pid=None, pr_number=1870, head_sha=HEAD1, merged=1)
        w.tick()  # MERGED -> CLEANUP

        original = w.git.remove_owned
        failed_once = {"value": False}

        def partial(path, branch, head, *, cleanup_proof=None, on_verified=None):
            if not failed_once["value"]:
                failed_once["value"] = True
                on_verified()
                w.git.reg.pop(str(path), None)  # admin entry gone; checkout remains
                raise GitError("git worktree remove: Operation not permitted")
            return original(path, branch, head, cleanup_proof=cleanup_proof, on_verified=on_verified)

        w.git.remove_owned = partial
        w.tick()
        row = w.row(method="b")
        self.assertEqual((row["state"], row["paused_from"]), ("ERROR", "CLEANUP"))
        self.assertTrue(w.store.get(f"cleanup_proof_{b['id']}"))

        w.sup = w.make_sup()  # same durable Store, a new Supervisor instance
        w.sup_runner_ok()
        self.assertTrue(control.retry(w.store, "deepseek", "b"))
        w.tick()  # Retry restores CLEANUP; no producer launch
        w.tick()  # the saved proof lets cleanup resume

        self.assertEqual(w.row(method="b")["state"], "COMPLETE")
        self.assertFalse(Path(b["worktree"]).exists())
        self.assertIsNone(w.store.get(f"cleanup_proof_{b['id']}"))
        self.assertEqual(len(w.adapter.launches), 1)

    def test_registered_partial_deletion_retries_from_cleanup_without_rerun_or_other_line_changes(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single", method="b")
        w.tick()
        b = w.row(method="b")
        install_batch_pr(w, b)
        w.store.update(b["id"], state="MERGED", pid=None, pr_number=1870, head_sha=HEAD1, merged=1)
        other = dict(w.store.line("deepseek", "a"))
        w.tick()  # MERGED -> CLEANUP

        original = w.git.remove_owned
        failed_once = {"value": False}
        saved_proof = {}

        def registered_owner(path):
            return [owner for worktree, owner in w.git.reg.items()
                    if Path(worktree).resolve() == Path(path).resolve()]

        def partial(path, branch, head, *, cleanup_proof=None, on_verified=None):
            if not failed_once["value"]:
                failed_once["value"] = True
                on_verified()
                w.git.dirty_text = " D tracked.txt"
                raise GitError("git worktree remove: Operation not permitted")
            self.assertEqual(registered_owner(path), [branch])  # registration survived the first remove attempt
            self.assertTrue(cleanup_proof)
            self.assertEqual(cleanup_proof["head_sha"], head)
            saved_proof.update(cleanup_proof)
            w.git.dirty_text = ""  # real Git restores only the proof-verified deletion before normal removal
            return original(path, branch, head, cleanup_proof=cleanup_proof, on_verified=on_verified)

        w.git.remove_owned = partial
        w.tick()
        row = w.row(method="b")
        self.assertEqual((row["state"], row["paused_from"]), ("ERROR", "CLEANUP"))
        self.assertTrue(w.store.get(f"cleanup_proof_{b['id']}"))
        self.assertEqual(registered_owner(b["worktree"]), [b["branch"]])
        self.assertEqual(dict(w.store.line("deepseek", "a")), other)

        self.assertTrue(control.retry(w.store, "deepseek", "b"))
        w.tick()  # Retry restores CLEANUP; no producer launch
        w.tick()  # saved proof plus surviving registration resumes bounded cleanup

        self.assertEqual(w.row(method="b")["state"], "COMPLETE")
        self.assertTrue(saved_proof)
        self.assertFalse(Path(b["worktree"]).exists())
        self.assertEqual(dict(w.store.line("deepseek", "a")), other)
        self.assertEqual(len(w.adapter.launches), 1)

    def test_missing_checkout_with_registered_admin_retries_after_restart_without_rerun(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single", method="b")
        w.tick()
        b = w.row(method="b")
        install_batch_pr(w, b)
        w.store.update(b["id"], state="MERGED", pid=None, pr_number=1870, head_sha=HEAD1, merged=1)
        other = dict(w.store.line("deepseek", "a"))
        w.tick()  # MERGED -> CLEANUP

        failed_once = {"value": False}
        removed = []

        def registered_owner(path):
            return [owner for worktree, owner in w.git.reg.items()
                    if Path(worktree).resolve() == Path(path).resolve()]

        def partial(path, branch, head, *, cleanup_proof=None, on_verified=None):
            if not failed_once["value"]:
                failed_once["value"] = True
                on_verified()
                Path(path).rmdir()  # checkout is gone; the fake Git registration/admin entry remains
                raise GitError("git worktree remove: admin entry Operation not permitted")
            self.assertEqual(registered_owner(path), [branch])
            self.assertTrue(cleanup_proof)
            self.assertEqual(cleanup_proof["head_sha"], head)
            self.assertFalse(Path(path).exists())
            w.git.reg.pop(str(path), None)  # successful non-force retry removes only the stale registration
            removed.append((str(path), branch))

        w.git.remove_owned = partial
        w.tick()
        row = w.row(method="b")
        self.assertEqual((row["state"], row["paused_from"]), ("ERROR", "CLEANUP"))
        self.assertFalse(Path(b["worktree"]).exists())
        self.assertEqual(registered_owner(b["worktree"]), [b["branch"]])
        self.assertTrue(w.store.get(f"cleanup_proof_{b['id']}"))

        w.sup = w.make_sup()
        w.sup_runner_ok()
        self.assertTrue(control.retry(w.store, "deepseek", "b"))
        w.tick()  # Retry restores CLEANUP
        w.tick()  # merged PR and proof are rechecked, no producer launch

        self.assertEqual(w.row(method="b")["state"], "COMPLETE")
        self.assertEqual([(Path(path).resolve(), branch) for path, branch in removed],
                         [(Path(b["worktree"]).resolve(), b["branch"])])
        self.assertIsNone(w.store.get(f"cleanup_proof_{b['id']}"))
        self.assertEqual(dict(w.store.line("deepseek", "a")), other)
        self.assertEqual(len(w.adapter.launches), 1)


class ProducerHandoff(unittest.TestCase):
    def test_validated_pr_stops_codex_style_producer_before_it_can_poll_or_cleanup(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.adapter = FinalResultAdapter()
        w.cfg["producers"] = {"codex": {"label": "Codex", "adapter": "codex",
                                         "model": "gpt-6-luna", "effort": "xhigh"}}
        w.sup = w.make_sup()
        w.sup_runner_ok()
        w.start("single", model="codex", method="b")
        w.adapter.plan.append({"code": 0, "session": "ses_live"})
        w.tick()
        b = w.row(model="codex", method="b")
        pid = b["pid"]
        install_batch_pr(w, b, state="open", merged=False)

        w.tick()
        row = w.row(model="codex", method="b")
        self.assertEqual((row["state"], row["pr_number"]), ("WAITING_REVIEW", 1870))
        self.assertFalse(w.adapter.alive(pid))
        self.assertTrue(w.store.get(f"stop_after_pr_{b['id']}"))
        self.assertIn("lifecycle handoff", w.adapter.launches[0]["prompt"])
        self.assertIn("Do not run PR polling", w.adapter.launches[0]["prompt"])
        self.assertEqual(w.adapter.last_env["PATH"].split(os.pathsep)[0], str(BIN))
        self.assertTrue(Path(w.adapter.last_env["WARROOM_REAL_GIT"]).is_absolute())

        w.tick()  # reap the stopped process and clear the handoff marker
        self.assertIsNone(w.row(model="codex", method="b")["pid"])
        self.assertIsNone(w.store.get(f"stop_after_pr_{b['id']}"))
        self.assertEqual(len(w.adapter.launches), 1)

    def test_worker_git_shim_blocks_cleanup_but_delegates_read_only_git(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            real = root / "git-real"
            real.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\"\n")
            real.chmod(0o755)
            env = {"WARROOM_REAL_GIT": str(real), "PATH": os.environ.get("PATH", "/usr/bin:/bin")}

            remove = subprocess.run([sys.executable, str(BIN / "git"), "-C", "/repo", "worktree", "remove",
                                      "/repo/wts/a"], env=env, capture_output=True, text=True)
            delete = subprocess.run([sys.executable, str(BIN / "git"), "branch", "-D", "a"], env=env,
                                    capture_output=True, text=True)
            move = subprocess.run([sys.executable, str(BIN / "git"), "branch", "-M", "a", "b"], env=env,
                                  capture_output=True, text=True)
            update_ref = subprocess.run([sys.executable, str(BIN / "git"), "update-ref", "refs/heads/a",
                                         HEAD1], env=env, capture_output=True, text=True)
            listing = subprocess.run([sys.executable, str(BIN / "git"), "-C", "/repo", "status", "--short"],
                                     env=env, capture_output=True, text=True)

        self.assertEqual(remove.returncode, 126)
        self.assertEqual(delete.returncode, 126)
        self.assertEqual(move.returncode, 126)
        self.assertEqual(update_ref.returncode, 126)
        self.assertEqual(listing.returncode, 0)
        self.assertEqual(listing.stdout.strip(), "-C /repo status --short")

    def test_stage_one_prompts_override_general_pr_monitoring_instructions(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single", method="a")
        w.tick()
        b = w.row()
        produce = " ".join(prompts.produce(b).split())
        recovery = " ".join(prompts.recovery(b).split())
        fix = " ".join(prompts.fix(b, [], False).split())
        self.assertIn("General repository instructions about monitoring PRs do not apply", produce)
        self.assertIn("finish and exit", recovery)
        self.assertIn("Supervisor owns review monitoring", fix)


if __name__ == "__main__":
    unittest.main()
