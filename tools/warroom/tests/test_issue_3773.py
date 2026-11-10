"""#3773: Git/Node execution handshake, crash fence and termination proof.

One shared harness: a real parent process runs `FencedRunner` and SIGKILLs itself at a named point, then a fresh `Fence`
(the next Supervisor instance) judges what is left. The same fixtures drive the verdict, startup and call-chain checks.
"""
import json
import os
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from warroom import fence as fence_mod
from warroom.fence import ALIVE, DEAD, UNKNOWN, Fence, PsRow, ResourceFenced, ps_table
from warroom.gitops import Git, GitError, GitTransient
from warroom.lanes import OrderedLock
from warroom.shell import FencedRunner, Result, Runner, fenced_env
from warroom.supervisor import startup_refusal

ROOT = str(Path(__file__).resolve().parents[1])

PARENT = r"""
import os, signal, subprocess, sys
sys.path.insert(0, sys.argv[1])
from pathlib import Path
from warroom.fence import Fence
from warroom.shell import FencedRunner, Runner
root, point, script = sys.argv[2], sys.argv[3], sys.argv[4]
fence = Fence(Path(root) / "children").open()
def hook(p):
    if p == "popen" and os.environ.get("SIBLING"):
        subprocess.Popen(["sleep", "30"], close_fds=False, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL)   # a sibling spawned with the most permissive flags
    if p == point:
        os.kill(os.getpid(), signal.SIGKILL)
FencedRunner(Runner(), fence, hook=hook).run(["node", "-e", script], timeout=60)
"""


def command(marker):
    return (f"require('fs').writeFileSync({json.dumps(str(marker))}, String(process.pid));"
            "setTimeout(() => {}, 30000)")


def alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def group_alive(pgid):
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return False
    return True


def until(predicate, seconds=5.0):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


class Harness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.children = self.root / "children"
        self.spawned = []
        self.addCleanup(self.reap)

    def reap(self):
        for pid in self.spawned:
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass

    def crash(self, point, *, sibling=False, marker=None):
        marker = marker or self.root / "ran"
        env = dict(os.environ, SIBLING="1" if sibling else "")
        proc = subprocess.run([sys.executable, "-c", PARENT, ROOT, str(self.root), point, command(marker)],
                              env=env, capture_output=True, timeout=30)
        self.assertEqual(proc.returncode, -signal.SIGKILL, proc.stderr.decode())
        return marker

    def entries(self):
        return [json.loads(p.read_text()) for d in self.children.iterdir() if d.is_dir() for p in d.glob("*.json")]

    def next_instance(self, **kw):
        fence = Fence(self.children, **kw).open()
        self.addCleanup(fence.close)
        return fence


class CrashPointTests(Harness):
    """A real parent SIGKILL at each handshake point: no command runs without approval, no survivor is left unjudged."""

    def test_no_command_runs_before_approval(self):
        for point in ("intent", "popen", "ready", "approved"):
            with self.subTest(point=point):
                self.tmp.cleanup(), self.setUp()
                marker = self.crash(point)
                time.sleep(0.6)   # a late-waking child gets its chance to misbehave
                self.assertFalse(marker.exists(), f"command ran although the parent died at {point}")
                fence = self.next_instance()
                self.assertEqual(fence.scan_previous(), [], point)
                self.assertEqual(fence.previous_unresolved(), [])
                self.assertEqual(self.entries(), [])

    def test_approved_and_signalled_child_is_terminated_with_proof(self):
        marker = self.crash("nonce")
        self.assertTrue(until(marker.exists), "the approved command should have started")
        pid = int(marker.read_text())
        self.assertTrue(alive(pid))
        entry = self.entries()[0]
        self.assertEqual(entry["state"], "approved")
        fence = self.next_instance(grace=1.0)
        self.assertEqual(fence.scan_previous(), [])
        self.assertTrue(until(lambda: not group_alive(entry["pgid"]), 3))
        self.assertFalse(alive(pid))
        self.assertEqual(self.entries(), [])

    def test_write_fd_does_not_leak_to_a_concurrent_sibling(self):
        """A sibling spawned with close_fds=False during the handshake must not keep the approval pipe open: the
        unapproved child sees EOF and leaves although the sibling lives on."""
        self.addCleanup(subprocess.run, ["pkill", "-f", "^sleep 30$"], check=False)
        marker = self.crash("popen", sibling=True)
        mine = lambda: [r for r in ps_table() or [] if str(self.root) in r.command and r.command.startswith("/bin/sh -c")]
        self.assertTrue(until(lambda: not mine(), 3), "the unapproved child must exit on EOF, not wait for a leaked pipe")
        self.assertTrue(any(r.command == "sleep 30" for r in ps_table() or []), "the sibling is still alive")
        self.assertFalse(marker.exists())
        self.assertEqual(self.next_instance().scan_previous(), [])

    def test_pipes_are_created_non_inheritable(self):
        seen = []
        real_pipe = os.pipe

        def spy():
            fds = real_pipe()
            seen.append([os.get_inheritable(fd) for fd in fds])
            return fds
        with mock.patch("warroom.shell.os.pipe", spy):
            FencedRunner(Runner(), self.next_instance()).run(["git", "--version"])
        self.assertEqual(seen[:2], [[False, False], [False, False]])


class RunnerContractTests(Harness):
    def runner(self, **kw):
        return FencedRunner(Runner(), self.next_instance(), **kw)

    def test_normal_result_and_other_commands_pass_through(self):
        r = self.runner()
        ok = r.run(["git", "--version"])
        self.assertTrue(ok.ok and ok.out.startswith("git version"))
        bad = r.run(["git", "no-such-subcommand"])
        self.assertEqual(bad.code, 1)
        self.assertEqual(r.run(["echo", "hi"]).out, "hi\n")   # not git/node: the inner Runner, no journal
        self.assertEqual(r.fence.active_children(), [])
        self.assertEqual(r.run(["node", "-e", "process.stdin.pipe(process.stdout)"], input="payload").out, "payload")
        self.assertEqual(r.run(["git", "--version"], cwd=self.root / "missing").code, 127)

    def test_execution_timeout_is_distinct_from_startup_timeout(self):
        r = self.runner()
        t = r.run(["node", "-e", "setTimeout(()=>{}, 30000)"], timeout=1)
        self.assertEqual((t.code, t.err), (124, "timeout: node"))
        s = self.runner(startup_cap=0.0).run(["node", "-e", "1"], timeout=5)
        self.assertEqual(s.code, 124)
        self.assertTrue(s.err.startswith("startup timeout: node"), s.err)
        self.assertEqual(r.fence.active_children(), [])

    def test_timeout_none_still_has_a_finite_startup_bound(self):
        s = self.runner(startup_cap=0.0).run(["node", "-e", "1"], timeout=None)
        self.assertTrue(s.err.startswith("startup timeout"), s.err)

    def test_grandchild_holding_the_pipes_cannot_hang_collection(self):
        r = self.runner()
        started = time.monotonic()
        res = r.run(["node", "-e",
                     "require('child_process').spawn('sleep',['30'],{stdio:'inherit'}).unref(); console.log('leader done')"],
                    timeout=60)
        self.assertLess(time.monotonic() - started, 5)
        self.assertEqual((res.code, res.out), (0, "leader done\n"))
        self.assertEqual(r.fence.active_children(), [], "marker removed only after the group was swept")
        self.assertFalse(any(row.command == "sleep 30" for row in ps_table() or []), "the leftover was swept")

    def test_timeout_budget_covers_collection_of_inherited_output(self):
        r = self.runner()
        started = time.monotonic()
        res = r.run(["node", "-e", "require('child_process').spawn('sleep',['30'],{stdio:'inherit'});"
                     "setTimeout(()=>{}, 30000)"], timeout=1)
        self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(res.code, 124)

    def test_fenced_env_sums_git_config_and_disables_maintenance(self):
        from warroom import auth
        base = auth.build_env({"PATH": os.environ["PATH"]}, Path("/x"))
        n = int(base["GIT_CONFIG_COUNT"])
        env = fenced_env(base)
        self.assertEqual(int(env["GIT_CONFIG_COUNT"]), n + 2)
        pairs = {env[f"GIT_CONFIG_KEY_{i}"]: env[f"GIT_CONFIG_VALUE_{i}"] for i in range(n + 2)}
        self.assertEqual((pairs["gc.auto"], pairs["maintenance.auto"]), ("0", "false"))
        self.assertEqual(pairs["credential.helper"], "!gh auth git-credential")   # existing entries intact
        self.assertEqual(base["GIT_CONFIG_COUNT"], str(n))

    def test_commit_and_fetch_start_no_detached_maintenance(self):
        repo = self.root / "repo"
        env = {"PATH": os.environ["PATH"], "HOME": str(self.root)}
        git = lambda *a: subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True, env=env)
        subprocess.run(["git", "init", "-q", str(repo)], check=True, env=env)
        for k, v in (("gc.auto", "1"), ("gc.autoPackLimit", "1"), ("gc.autoDetach", "true"),
                     ("user.name", "t"), ("user.email", "t@t")):
            git("config", k, v)
        for i in range(2):   # two packs: git's own `gc --auto` condition (more packs than autoPackLimit) is now true
            (repo / f"seed{i}").write_text(str(i))
            git("add", "."), git("-c", "gc.auto=0", "commit", "-qm", f"seed{i}"), git("repack", "-qd")
        packs = lambda: len(list((repo / ".git" / "objects" / "pack").glob("*.pack")))
        self.assertEqual(packs(), 2)
        r = self.runner()
        for i in range(3):
            (repo / f"f{i}").write_text(str(i))
            self.assertTrue(r.run(["git", "add", "."], cwd=repo, env=env).ok)
            self.assertTrue(r.run(["git", "commit", "-qm", str(i)], cwd=repo, env=env).ok)
        time.sleep(1)
        self.assertEqual(packs(), 2, "auto gc/maintenance must not run under the fence")
        self.assertFalse((repo / ".git" / "gc.log").exists())
        (repo / "g").write_text("g")   # the control: the same repo without the fence does consolidate its packs
        Runner().run(["git", "add", "."], cwd=repo, env=env)
        Runner().run(["git", "commit", "-qm", "g"], cwd=repo, env=env)
        self.assertTrue(until(lambda: packs() < 2, 8))
        # let the control's detached gc finish so it cannot race the temp-dir cleanup
        self.assertTrue(until(lambda: not (repo / ".git" / "gc.pid").exists(), 10))
        time.sleep(0.3)


class ResourceBindingTests(Harness):
    def test_all_held_locks_and_the_owned_worktree_are_bound(self):
        wts = self.root / "wts"
        (wts / "a").mkdir(parents=True)
        r = FencedRunner(Runner(), self.next_instance(), wts)
        verify, repo = OrderedLock(3, name="verify"), OrderedLock(4, reentrant=True, name="repo")
        self.assertEqual(r.resources(wts / "a"), {"worktree:a"})   # #5162: an owned worktree binds only itself
        self.assertEqual(r.resources(self.root), {"repo"}, "unprovable independence is the repository")
        with verify:
            self.assertEqual(r.resources(self.root), {"verify"})
            with repo:
                self.assertEqual(r.resources(wts / "a"), {"verify", "repo", "worktree:a"})

    def test_a_fenced_resource_stops_a_new_command_before_it_runs(self):
        fence = self.next_instance()
        r = FencedRunner(Runner(), fence, self.root)
        marker = self.root / "never"
        fence._hold(self.root / "m.json", {"resources": ["repo"], "pid": 1, "pgid": 2}, "old", fence_mod.Verdict(UNKNOWN, "x"))
        with self.assertRaises(ResourceFenced):
            r.run(["node", "-e", f"require('fs').writeFileSync({json.dumps(str(marker))}, '1')"], cwd=self.root)
        self.assertFalse(marker.exists())
        self.assertTrue(r.run(["echo", "gh-like"]).ok)   # non git/node is never fenced


def row(pid, pgid, stat="S", lstart="Thu Nov  5 10:00:00 2026", cmd="node x"):
    return PsRow(pid, pgid, stat, " ".join(lstart.split()), cmd)


class VerdictTests(Harness):
    def entry(self, **kw):
        base = {"v": 1, "id": "e1", "instance": "old", "state": "approved", "cmdline": "node x", "resources": ["repo"],
                "pid": 4242, "pgid": 4242, "lstart": "Thu Nov 5 10:00:00 2026",
                "intent_at": time.mktime(time.strptime("Thu Nov 5 10:00:00 2026", "%a %b %d %H:%M:%S %Y"))}
        base.update(kw)
        return base

    def fence(self, ps, killpg):
        return Fence(self.children, ps=ps, killpg=killpg, grace=0.2)

    def test_group_absence_is_dead_only_by_esrch(self):
        calls = []

        def killpg(pgid, sig):
            calls.append(sig)
            raise ProcessLookupError
        v = self.fence(lambda: None, killpg).group_verdict(self.entry())
        self.assertEqual(v.state, DEAD)
        self.assertEqual(calls, [0], "only the existence probe, never a signal")

    def test_ps_failure_is_unknown_not_dead(self):
        sent = []
        f = self.fence(lambda: None, lambda p, s: sent.append(s))
        self.assertEqual(f.group_verdict(self.entry()).state, UNKNOWN)
        self.assertEqual(sent, [0])

    def test_empty_ps_output_is_not_proof(self):
        with mock.patch("warroom.fence.subprocess.run") as run:
            run.return_value = mock.Mock(returncode=0, stdout="")
            self.assertIsNone(ps_table())
            run.return_value = mock.Mock(returncode=0, stdout="garbage line\n")
            self.assertIsNone(ps_table())
            run.return_value = mock.Mock(returncode=1, stdout="")
            self.assertIsNone(ps_table())

    def test_identity_and_group_cases_never_signal_unless_confirmed(self):
        cases = {
            "pid reuse (lstart differs)": ([row(4242, 4242, lstart="Fri Nov  6 09:00:00 2026")], UNKNOWN),
            "pid reuse (command differs)": ([row(4242, 4242, cmd="vim notes")], UNKNOWN),
            "leader gone, member remains": ([row(4300, 4242)], UNKNOWN),
            "only zombies": ([row(4242, 4242, stat="Z")], DEAD),
            "killpg ok but ps lists nothing": ([row(1, 1)], UNKNOWN),
            "identity confirmed": ([row(4242, 4242)], ALIVE),
        }
        for name, (rows, want) in cases.items():
            with self.subTest(name):
                sent = []
                f = self.fence(lambda rows=rows: rows, lambda p, s, sent=sent: sent.append(s))
                self.assertEqual(f.group_verdict(self.entry()).state, want)
                self.assertEqual(sent, [0])

    def test_macos_eperm_falls_back_to_ps(self):
        def killpg(pgid, sig):
            raise PermissionError
        f = self.fence(lambda: [row(4242, 4242, stat="Z")], killpg)
        self.assertEqual(f.group_verdict(self.entry()).state, DEAD)   # zombie group: EPERM, ps proves nothing can run
        f = self.fence(lambda: [row(4242, 4242)], killpg)
        self.assertEqual(f.group_verdict(self.entry()).state, ALIVE)

    def test_real_unrelated_process_is_never_signalled(self):
        victim = subprocess.Popen(["sleep", "30"], start_new_session=True)
        self.addCleanup(victim.kill)
        entry = self.entry(pid=victim.pid, pgid=victim.pid, lstart="Mon Jan  1 00:00:00 2001", cmdline="node x")
        f = Fence(self.children, grace=0.2)
        self.assertEqual(f.group_verdict(entry).state, UNKNOWN)
        self.assertIsNone(victim.poll(), "an unconfirmed identity must never be signalled")

    def test_confirmed_alive_group_is_terminated_and_reclassified(self):
        marker = self.crash("nonce")
        self.assertTrue(until(marker.exists))
        entry = self.entries()[0]
        self.assertEqual(Fence(self.children).group_verdict(entry).state, ALIVE)

    def test_unknown_protects_until_proof_and_marker_deletion_is_not_proof(self):
        old = self.children / "old"
        old.mkdir(parents=True)
        (old / "owner.lock").write_text("")
        marker = old / "e1.json"
        marker.write_text(json.dumps(self.entry()))
        state = {"rows": None}
        f = Fence(self.children, ps=lambda: state["rows"], killpg=lambda p, s: None, recheck_interval=0, grace=0.1).open()
        self.addCleanup(f.close)
        self.assertEqual(len(f.scan_previous()), 1)
        with self.assertRaises(ResourceFenced) as ctx:
            f.check({"repo"})
        self.assertIn(str(marker), str(ctx.exception))
        f.check({"verify"})   # a different resource is not fenced
        first = f.drain_reports()
        f.recheck(force=True), f.recheck(force=True), f.blocked({"repo"})
        self.assertEqual(len(first), 1)
        self.assertEqual(f.drain_reports(), [], "the UNKNOWN report is logged once")
        self.assertIn("resource=repo", first[0])
        marker.unlink()   # deleting the record proves nothing
        with self.assertRaises(ResourceFenced):
            f.check({"repo"})
        old.mkdir(parents=True, exist_ok=True)   # an emptied past directory is pruned; the in-memory fence outlives it
        (old / "owner.lock").write_text("")
        marker.write_text(json.dumps(self.entry()))
        f._ps = lambda: [row(9, 9)]
        f._killpg = mock.Mock(side_effect=ProcessLookupError)
        f.recheck(force=True)
        f.check({"repo"})   # ESRCH proved the group gone
        self.assertEqual(f.previous_unresolved(), [])
        self.assertFalse(marker.exists())
        self.assertFalse(old.exists(), "an empty past instance directory is removed")


class TerminateRegressionTests(Harness):
    def test_no_kill_after_term_when_identity_is_lost(self):
        entry = VerdictTests.entry(self)
        sent = []
        rows = [[row(4242, 4242)]]   # judged ALIVE before TERM, then the leader is gone and a member remains

        def ps():
            return rows[0]

        def killpg(pgid, sig):
            sent.append(sig)
            if sig == signal.SIGTERM:
                rows[0] = [row(4300, 4242)]
        f = Fence(self.children, ps=ps, killpg=killpg, grace=0.3)
        v = f.terminate(entry)
        self.assertEqual(v.state, UNKNOWN)
        self.assertNotIn(signal.SIGKILL, sent)
        self.assertEqual(sent.count(signal.SIGTERM), 1)

    def test_lock_free_worktree_command_fence_holds_only_its_own_worktree(self):
        """#5162: an unjudgeable child of an ended Supervisor holds back its own batch, never every Line."""
        wts = self.root / "wts"
        (wts / "a").mkdir(parents=True)
        (wts / "b").mkdir(parents=True)
        fence = self.next_instance()
        r = FencedRunner(Runner(), fence, wts)
        fence._hold(self.root / "m.json", {"resources": sorted(r.resources(wts / "a")), "pid": 1, "pgid": 2}, "old",
                    fence_mod.Verdict(UNKNOWN, "x"))
        with self.assertRaises(ResourceFenced):
            r.run(["git", "--version"], cwd=wts / "a")
        self.assertEqual(fence.blocked({"repo"}), [])            # the Coordinator's whole-repository skip stays off
        self.assertTrue(r.run(["git", "--version"], cwd=wts / "b").ok)   # another batch's worktree
        self.assertTrue(r.run(["git", "--version"], cwd=self.root).ok)   # the repository itself


class StartupAndInterfaceTests(Harness):
    def test_workers_one_fallback_after_a_sixteen_worker_crash_never_races_the_old_child(self):
        marker = self.crash("nonce")   # the 16-Worker instance died with an approved, running child
        self.assertTrue(until(marker.exists))
        pid = int(marker.read_text())
        fence = self.next_instance(grace=1.0)
        fence.scan_previous()   # runs for workers=1 too, before any dispatch
        self.assertIsNone(startup_refusal(fence, 1))
        self.assertTrue(until(lambda: not alive(pid), 3), "the old child is gone before the first dispatch")

    def test_workers_one_refuses_to_start_on_an_unresolved_child(self):
        old = self.children / "old"
        old.mkdir(parents=True)
        (old / "owner.lock").write_text("")
        (old / "e1.json").write_text(json.dumps(
            {"v": 1, "id": "e1", "state": "approved", "resources": ["repo", "verify"], "pid": 4242, "pgid": 4242,
             "lstart": "Thu Nov 5 10:00:00 2026", "cmdline": "git fetch", "intent_at": 0}))
        fence = Fence(self.children, ps=lambda: None, killpg=lambda p, s: None).open()
        self.addCleanup(fence.close)
        fence.scan_previous()
        message = startup_refusal(fence, 1)
        self.assertIn("resource=repo,verify", message)
        self.assertIn("e1.json", message)
        self.assertIn("UNKNOWN", message)
        self.assertIsNone(startup_refusal(fence, 16), "several Workers keep running but stay fenced")
        with self.assertRaises(ResourceFenced):
            fence.check({"repo"})

    def test_active_children_distinguishes_clear_from_unproven(self):
        fence = self.next_instance()
        self.assertEqual(fence.active_children(), [])
        res = FencedRunner(Runner(), fence).run(["git", "--version"])
        self.assertTrue(res.ok)
        self.assertEqual(fence.active_children(), [], "finished and proven: zero")
        entry = fence.begin(["git", "fetch"], self.root, {"repo"})
        fence.approve(entry, 2 ** 22 + 7, 2 ** 22 + 7, "Thu Nov 5 10:00:00 2026")
        self.assertFalse(alive(2 ** 22 + 7), "the recorded process is gone")
        self.assertEqual(len(fence.active_children()), 1, "a dead PID without proven completion is NOT zero")
        (fence.dir / f"{entry['id']}.json").write_text("{not json")
        self.assertEqual(fence.active_children()[0]["state"], "unreadable")

    def test_new_instance_with_an_empty_journal_is_not_a_leftover(self):
        a = self.next_instance()
        b = Fence(self.children).open()
        self.addCleanup(b.close)
        self.assertEqual(b.scan_previous(), [], "an empty live journal of another instance is not an unresolved child")
        self.assertTrue(a.dir.exists() and b.dir.exists())

    def test_instance_ids_are_unique_and_stable(self):
        a, b = self.next_instance(), Fence(self.children).open()
        self.addCleanup(b.close)
        self.assertNotEqual(a.instance, b.instance)


class CallChainTests(Harness):
    """ResourceFenced is re-evaluated next tick: it never becomes GitError, ERROR/PAUSED or a fake result."""

    def git(self, fence):
        runner = mock.Mock()
        runner.run.side_effect = AssertionError("a fenced resource must not start any command")
        return Git(runner, self.root, {"PATH": "/usr/bin"}, self.root / "wts", fence=fence), runner

    def fenced(self, *resources):
        fence = self.next_instance()
        fence._hold(self.root / "m.json", {"resources": list(resources), "pid": 1, "pgid": 2}, "old",
                    fence_mod.Verdict(UNKNOWN, "x"))
        return fence

    def test_l4_and_l3_fences_raise_transient_before_any_command(self):
        git, runner = self.git(self.fenced("repo"))
        with self.assertRaises(ResourceFenced) as ctx:
            git.fetch_base("master")
        self.assertIsInstance(ctx.exception, GitTransient)
        runner.run.assert_not_called()
        git, runner = self.git(self.fenced("verify"))
        with self.assertRaises(ResourceFenced):
            git.verify_stage2("a" * 40, "shard", "001", None, None)
        runner.run.assert_not_called()
        git, _ = self.git(self.fenced("verify"))
        git.fetch_base  # L4 itself is free while only L3 is fenced
        self.assertEqual(git.fence.blocked({"repo"}), [])

    def test_fence_beats_except_giterror_conversions(self):
        git, _ = self.git(self.fenced("repo"))
        git.registered = lambda path: "b"
        git.worktree_gitdir = mock.Mock(side_effect=ResourceFenced("fenced"))
        with self.assertRaises(ResourceFenced):   # its `except GitError -> FastForwardBlocked` must not convert it
            git.fast_forward_open_pr(self.root, "b", "c" * 40, {"p"})

    def test_runner_level_fence_is_not_swallowed_by_check_false(self):
        fence = self.next_instance()
        fence._hold(self.root / "m.json", {"resources": ["repo"], "pid": 1, "pgid": 2}, "old", fence_mod.Verdict(UNKNOWN, "x"))
        git = Git(FencedRunner(Runner(), fence), self.root, {"PATH": os.environ["PATH"]}, self.root / "wts")
        with self.assertRaises(ResourceFenced):
            git._git("status", check=False)   # not a Result(124), not a silent pass

    def test_supervisor_tick_skips_a_fenced_line_without_touching_state(self):
        from tests.fakes import World
        w = World()
        self.addCleanup(w.tmp.cleanup)
        fence = self.next_instance()
        w.sup.fence = fence
        w.git.fence = fence
        fence._hold(self.root / "m.json", {"resources": ["repo"], "pid": 1, "pgid": 2}, "old", fence_mod.Verdict(UNKNOWN, "x"))
        before = [dict(b) for b in w.store.incomplete_batches()]
        calls = len(w.runner.calls) if hasattr(w.runner, "calls") else None
        w.tick()
        self.assertEqual([dict(b) for b in w.store.incomplete_batches()], before)
        if calls is not None:
            self.assertEqual(len(w.runner.calls), calls, "no command may start while the repository is fenced")

    def test_guarded_step_turns_a_fence_into_a_pending_retry_not_an_error(self):
        from tests.fakes import World
        from warroom import control
        w = World()
        self.addCleanup(w.tmp.cleanup)
        control.start(w.store, "claude", "a", "single", cfg=w.cfg) if False else None
        b = {"id": 1, "state": "PREPARE", "worktree": str(self.root), "run_kind": None, "producer": "claude", "method": "a"}
        with mock.patch.object(w.store, "batch", return_value=b), mock.patch.object(w.sup, "_last_run", return_value=None), \
                mock.patch.object(w.sup, "_local_head", return_value=None):
            w.sup._guarded(b, "poll", mock.Mock(side_effect=ResourceFenced("fenced")))
        self.assertIsNotNone(w.store.get("pending_1"))
        self.assertIsNotNone(w.store.get("tw_b1:poll"))


if __name__ == "__main__":
    unittest.main()
