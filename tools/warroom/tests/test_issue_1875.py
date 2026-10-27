"""Issue #1875: keep producer runs out of Supervisor cleanup and recover proven partial removals safely."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

from tests.fakes import HEAD1, FakeAdapter, World
from warroom.adapters import ProcessAdapter, stage2_chunk_sandbox_command
from warroom import control
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
        self.assertEqual(w.adapter.last_env["PATH"].split(os.pathsep)[0], str(BIN))
        self.assertEqual(w.adapter.last_env["WARROOM_GIT_SHIM"], str(BIN / "git"))
        self.assertNotIn("WARROOM_REAL_GIT", w.adapter.last_env)

        w.tick()  # reap the stopped process and clear the handoff marker
        self.assertIsNone(w.row(model="codex", method="b")["pid"])
        self.assertIsNone(w.store.get(f"stop_after_pr_{b['id']}"))
        self.assertEqual(len(w.adapter.launches), 1)

    def test_worker_git_shim_blocks_cleanup_but_delegates_read_only_git(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            real_bin = root / "real-bin"
            real_bin.mkdir()
            real = real_bin / "git"
            real.write_text("#!/bin/sh\nprintf '%s\\n' \"$*\"\n")
            real.chmod(0o755)
            env = {"WARROOM_GIT_SHIM": str(BIN / "git"),
                   "PATH": os.pathsep.join((str(BIN), str(real_bin), os.environ.get("PATH", "/usr/bin:/bin")))}

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
            chunk_env = {**env, "WARROOM_STAGE2_CHUNK": "1"}
            chunk_commit = subprocess.run(["git", "commit", "-m", "chunk"], env=chunk_env,
                                          capture_output=True, text=True)
            chunk_push = subprocess.run(["git", "push", "origin", "branch"], env=chunk_env,
                                        capture_output=True, text=True)
            chunk_direct_commit = subprocess.run([chunk_env["WARROOM_GIT_SHIM"], "commit", "-m", "chunk"],
                                                 env=chunk_env, capture_output=True, text=True)
            chunk_direct_push = subprocess.run([chunk_env["WARROOM_GIT_SHIM"], "push", "origin", "branch"],
                                               env=chunk_env, capture_output=True, text=True)
            chunk_status = subprocess.run(["git", "status", "--short"], env=chunk_env,
                                          capture_output=True, text=True)
            finalizer_commit = subprocess.run(["git", "commit", "-m", "final"], env=env,
                                              capture_output=True, text=True)
            finalizer_push = subprocess.run(["git", "push", "origin", "branch"], env=env,
                                            capture_output=True, text=True)
            finalizer_direct_commit = subprocess.run([env["WARROOM_GIT_SHIM"], "commit", "-m", "final"],
                                                     env=env, capture_output=True, text=True)
            finalizer_direct_push = subprocess.run([env["WARROOM_GIT_SHIM"], "push", "origin", "branch"],
                                                   env=env, capture_output=True, text=True)

        self.assertNotIn("WARROOM_REAL_GIT", chunk_env)
        self.assertEqual(remove.returncode, 126)
        self.assertEqual(delete.returncode, 126)
        self.assertEqual(move.returncode, 126)
        self.assertEqual(update_ref.returncode, 126)
        self.assertEqual(listing.returncode, 0)
        self.assertEqual(listing.stdout.strip(), "-C /repo status --short")
        self.assertEqual(chunk_commit.returncode, 126)
        self.assertEqual(chunk_push.returncode, 126)
        self.assertEqual((chunk_direct_commit.returncode, chunk_direct_push.returncode), (126, 126))
        self.assertEqual(chunk_status.returncode, 126)
        self.assertEqual((finalizer_commit.returncode, finalizer_push.returncode,
                          finalizer_direct_commit.returncode, finalizer_direct_push.returncode), (0, 0, 0, 0))
        self.assertEqual(finalizer_commit.stdout.strip(), "commit -m final")
        self.assertEqual(finalizer_push.stdout.strip(), "push origin branch")

    def test_shim_never_loops_through_a_git_that_looks_itself_up_on_path(self):
        """macOS /usr/bin/git (xcrun) re-resolves `git` on PATH when its developer-dir Git is unusable."""
        with tempfile.TemporaryDirectory() as tmp:
            real_bin = Path(tmp) / "real-bin"
            real_bin.mkdir()
            path_probe = real_bin / "git"
            path_probe.write_text("#!/bin/sh\nprintf '%s' \"$PATH\"\n")
            path_probe.chmod(0o755)
            base = os.pathsep.join((str(BIN), str(real_bin), os.environ.get("PATH", "/usr/bin:/bin")))
            shim_path = subprocess.run([sys.executable, str(BIN / "git"), "status"], env={"PATH": base},
                                       capture_output=True, text=True, timeout=30)

            # A real Git that re-enters the shim by exec, the way xcrun does, must stop at once.
            path_probe.write_text(f'#!/bin/sh\nexec "{BIN / "git"}" "$@"\n')
            looped = subprocess.run([sys.executable, str(BIN / "git"), "rev-parse", "HEAD"],
                                    env={"PATH": base}, capture_output=True, text=True, timeout=30)

            # A Git spawned by Git (hook, alias) is a different process and still works.
            path_probe.write_text("#!/bin/sh\nprintf 'ok\\n'\n")
            nested = subprocess.run([sys.executable, str(BIN / "git"), "status"],
                                    env={"PATH": base, "WARROOM_GIT_SHIM_EXEC_PID": "1"},
                                    capture_output=True, text=True, timeout=30)
            chunk_version = subprocess.run([sys.executable, str(BIN / "git"), "--version"],
                                           env={"PATH": base, "WARROOM_STAGE2_CHUNK": "1"},
                                           capture_output=True, text=True, timeout=30)

        self.assertEqual(shim_path.returncode, 0)
        self.assertNotIn(str(BIN), shim_path.stdout.split(os.pathsep))
        self.assertIn(str(real_bin), shim_path.stdout.split(os.pathsep))
        self.assertEqual(looped.returncode, 126)
        self.assertIn("re-entered", looped.stderr)
        self.assertEqual((nested.returncode, nested.stdout.strip()), (0, "ok"))
        self.assertEqual(chunk_version.returncode, 126)


class Stage2ProcessSandbox(unittest.TestCase):
    @unittest.skipUnless((sys.platform == "darwin" and shutil.which("sandbox-exec")) or
                         (sys.platform.startswith("linux") and shutil.which("bwrap")),
                         "requires sandbox-exec on macOS or bwrap on Linux")
    def test_direct_git_commit_and_push_are_blocked_but_finalizer_can_publish(self):
        real_git = shutil.which("git")
        self.assertTrue(real_git)
        git_paths = [real_git, str(Path(real_git).resolve())]
        path = os.environ.get("PATH", os.defpath)
        if sys.platform.startswith("linux"):
            probe = subprocess.run(stage2_chunk_sandbox_command(["/bin/true"], git_paths, path),
                                   capture_output=True, text=True)
            if probe.returncode != 0:
                self.skipTest("bwrap is installed but unavailable for unprivileged process isolation")

        def git(*args):
            return subprocess.run([real_git, *args], check=True, capture_output=True, text=True)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            repo, remote = root / "repo", root / "remote.git"
            git("init", "--bare", str(remote))
            repo.mkdir()
            git("init", "-b", "main", str(repo))
            git("-C", str(repo), "config", "user.name", "Stage2 test")
            git("-C", str(repo), "config", "user.email", "stage2@example.invalid")
            git("-C", str(repo), "commit", "--allow-empty", "-m", "initial")
            git("-C", str(repo), "remote", "add", "origin", str(remote))
            git("-C", str(repo), "push", "origin", "HEAD:refs/heads/main")
            before = git("-C", str(repo), "rev-parse", "HEAD").stdout.strip()
            remote_before = git("--git-dir", str(remote), "rev-parse", "refs/heads/main").stdout.strip()

            allowed = subprocess.run(stage2_chunk_sandbox_command(["/bin/echo", "sandbox-ok"], git_paths, path),
                                     capture_output=True, text=True)
            self.assertEqual((allowed.returncode, allowed.stdout.strip()), (0, "sandbox-ok"))
            commit = subprocess.run(stage2_chunk_sandbox_command(
                [real_git, "-C", str(repo), "commit", "--allow-empty", "-m", "chunk"], git_paths, path),
                capture_output=True, text=True)
            push = subprocess.run(stage2_chunk_sandbox_command(
                [real_git, "-C", str(repo), "push", "origin", "HEAD:refs/heads/main"], git_paths, path),
                capture_output=True, text=True)
            self.assertNotEqual(commit.returncode, 0)
            self.assertNotEqual(push.returncode, 0)
            self.assertEqual(git("-C", str(repo), "rev-parse", "HEAD").stdout.strip(), before)
            self.assertEqual(git("--git-dir", str(remote), "rev-parse", "refs/heads/main").stdout.strip(),
                             remote_before)

            git("-C", str(repo), "commit", "--allow-empty", "-m", "finalizer")
            git("-C", str(repo), "push", "origin", "HEAD:refs/heads/main")
            self.assertNotEqual(git("--git-dir", str(remote), "rev-parse", "refs/heads/main").stdout.strip(),
                                remote_before)

    @unittest.skipUnless(sys.platform == "darwin" and shutil.which("sandbox-exec"),
                         "requires sandbox-exec on macOS")
    def test_spawn_strips_sandbox_paths_before_worker_exec(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            git_path = shutil.which("git")
            log_file, exit_file = root / "run.log", root / "run.exit"
            env = {"PATH": os.environ.get("PATH", os.defpath), "WARROOM_STAGE2_CHUNK": "1",
                   "WARROOM_GIT_EXECUTABLES": json.dumps([git_path])}
            with patch("warroom.adapters.subprocess.Popen") as popen:
                popen.return_value.pid = 42
                ProcessAdapter()._spawn(["/bin/echo", "worker"], root, env, log_file, exit_file)
            spawned = popen.call_args.args[0]
            worker_env = popen.call_args.kwargs["env"]
            self.assertIn(shutil.which("sandbox-exec"), spawned)
            self.assertNotIn("WARROOM_GIT_EXECUTABLES", worker_env)


if __name__ == "__main__":
    unittest.main()
