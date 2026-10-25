from __future__ import annotations

import itertools
import tempfile
from pathlib import Path

from warroom import control
from warroom.adapters import AgentAdapter, Handle, OpenCodeAdapter
from warroom.config import DEFAULTS, Paths
from warroom.gitops import CleanupBlocked, GitError
from warroom.shell import Result
from warroom.store import Store
from warroom.supervisor import Supervisor

import json

HEAD1, HEAD2 = "a" * 40, "b" * 40


class FakeAdapter(AgentAdapter):
    """Scripted AI: each launch consumes the next planned outcome."""

    def __init__(self):
        self.launches: list[dict] = []
        self.plan: list[dict] = []   # {code, log, session, on_finish(callable)}
        self.running: dict[int, dict] = {}
        self._pid = itertools.count(1000)
        self._opencode = OpenCodeAdapter("opencode", probe_async=False)   # probes inline in the fake world

    def _go(self, kind, cwd, log, ex, **kw):
        pid = next(self._pid)
        self.launches.append({"kind": kind, "cwd": str(cwd), "pid": pid, **kw})
        self.running[pid] = (self.plan.pop(0) if self.plan else {"code": 0}) | {"log": Path(log), "ex": Path(ex)}
        if self.running[pid].get("session"):  # a real run prints its session id early
            Path(log).parent.mkdir(parents=True, exist_ok=True)
            Path(log).write_text(json.dumps({"sessionID": self.running[pid]["session"]}) + "\n")
        return Handle(pid, Path(ex), Path(log))

    def start(self, prompt, cwd, env, run, title, log_file, exit_file):
        return self._go("start", cwd, log_file, exit_file, prompt=prompt, model=run.model, effort=run.effort)

    def resume(self, session_id, prompt, cwd, env, run, log_file, exit_file):
        return self._go("resume", cwd, log_file, exit_file, prompt=prompt, model=run.model, effort=run.effort,
                        session=session_id)

    def preflight(self, runner, env, runs):
        """Stands in for OpenCode: the provider-qualified (p/...) IDs get the real `opencode models` check."""
        opencode_runs = [r for r in runs if "/" in r.model]
        return self._opencode.preflight(runner, env, opencode_runs) if opencode_runs else None

    def finish(self, pid):
        """Simulate the AI process ending (writes log + exit file, runs side effects)."""
        r = self.running.pop(pid)
        r["log"].parent.mkdir(parents=True, exist_ok=True)
        r["log"].write_text((json.dumps({"sessionID": r["session"]}) + "\n" if r.get("session") else "") + r.get("text", ""))
        r["ex"].write_text(str(r["code"]))
        if r.get("effect"):
            r["effect"]()

    def alive(self, pid):
        return pid in self.running

    def stop(self, pid):
        self.running.pop(pid, None)

    def session_id(self, log_file):
        try:
            for line in Path(log_file).read_text().splitlines():
                try:
                    return json.loads(line)["sessionID"]
                except (ValueError, KeyError):
                    continue
        except OSError:
            pass
        return None

    def exit_code(self, exit_file):
        try:
            return int(Path(exit_file).read_text())
        except (OSError, ValueError):
            return None


class FakeGit:
    def __init__(self, wt_root: Path):
        self.wt_root = wt_root
        self.created, self.removed = [], []
        self.dirty_text, self.local_head, self.block = "", HEAD1, None
        self.gitdir_error = ""
        self.push_error, self.remote_deleted, self.discarded = "", [], []
        self.reg: dict[str, str] = {}
        self.remote: dict[str, str | Exception | None] = {}   # branch -> origin SHA, None (absent) or an error to raise

    def fetch_base(self, base):
        return "m" * 40

    def create_worktree(self, path, branch, base):
        Path(path).mkdir(parents=True)
        self.reg[str(path)] = branch
        self.created.append((str(path), branch))

    def registered(self, path):
        return self.reg.get(str(path))

    def worktree_gitdir(self, path):
        if self.gitdir_error:
            raise GitError(self.gitdir_error)
        return Path("/repo/.git/worktrees") / Path(path).name

    def dirty(self, path):
        return self.dirty_text

    def head(self, path):
        return self.local_head

    def remote_head(self, branch):
        v = self.remote.get(branch)
        if isinstance(v, Exception):
            raise v
        return v

    def verify_owned(self, path, branch):
        try:
            Path(path).resolve().relative_to(self.wt_root.resolve())
        except ValueError:
            raise CleanupBlocked("outside worktrees dir")
        reg = self.reg.get(str(path))
        if not Path(path).exists():
            if reg is not None:
                raise CleanupBlocked("registered but missing")
            return False
        if reg != branch:
            raise CleanupBlocked(f"not registered with {branch}")
        return True

    def delete_remote_branch(self, branch, expected_sha):
        if self.push_error:
            raise GitError(self.push_error)
        assert self.remote.get(branch) == expected_sha
        self.remote[branch] = None
        self.remote_deleted.append(branch)

    def discard_owned(self, path, branch):
        import shutil
        if self.verify_owned(path, branch):
            shutil.rmtree(path)
            self.reg.pop(str(path), None)
        self.discarded.append((str(path), branch))

    def remove_owned(self, path, branch, pr_head):
        if self.block:
            raise CleanupBlocked(self.block)
        if self.dirty_text.strip():
            raise CleanupBlocked("dirty")
        if self.local_head != pr_head:
            raise CleanupBlocked("head mismatch")
        self.removed.append((str(path), branch))
        Path(path).rmdir()


class FakeGh:
    def __init__(self):
        self.open: list[dict] = []
        self.prs: dict[int, dict] = {}
        self.by_branch: dict[str, list] = {}
        self.branch_errors: dict[str, Exception] = {}
        self.files: dict[int, list | Exception] = {}
        self.branch_queries = 0
        self.closed, self.close_error = [], None
        self.reviews_, self.inline_, self.issue_ = [], [], []
        self.commit_ts = 0.0

    def open_prs(self):
        return self.open

    def prs_for_branch(self, branch):
        self.branch_queries += 1
        if branch in self.branch_errors:
            raise self.branch_errors[branch]
        return self.by_branch.get(branch, [])

    def pull(self, n):
        return self.prs[n]

    def close_pr(self, n):
        if self.close_error:
            raise self.close_error
        self.prs[n] = self.prs[n] | {"state": "closed"}
        self.closed.append(n)

    def pull_files(self, n):
        files = self.files.get(n, [])
        if isinstance(files, Exception):
            raise files
        return files

    def reviews(self, n): return self.reviews_
    def inline_comments(self, n): return self.inline_
    def issue_comments(self, n): return self.issue_
    def commit_time(self, sha): return self.commit_ts


class World:
    def __init__(self, models=None):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.paths = Paths(repo_root=root, local=root / "local")
        self.paths.ensure()
        self.cfg = json.loads(json.dumps(DEFAULTS))
        self.cfg["poll_seconds"] = 0
        self.cfg["models"] = models or {"free": "p/free-x-free", "go": "p/go"}
        self.cfg["rate_limit_backoff_seconds"] = 10
        self.store = Store(self.paths.db)
        self.adapter, self.git, self.gh = FakeAdapter(), FakeGit(self.paths.worktrees), FakeGh()
        self.now = 1_000_000.0
        self.sup = self.make_sup()
        self.sup_runner_ok()

    def make_sup(self):
        return Supervisor(self.paths, self.cfg, self.store, self.runner_obj(), self.adapter,
                          self.gh, self.git, {"GH_CONFIG_DIR": "x"}, clock=lambda: self.now)

    def runner_obj(self):
        from tests.fake_runner import ScriptedRunner
        self.runner = ScriptedRunner()
        return self.runner

    def sup_runner_ok(self):
        self.runner.ok_auth(self.cfg["expected_account"])
        self.runner.set_batches(canon={1: 1000}, done={})

    def pr_info(self, n=7, head=HEAD1, state="open", merged=False, head_ref="x"):
        self.gh.prs[n] = {"number": n, "state": state, "merged": merged, "head_sha": head,
                          "head_ref": head_ref, "url": ""}

    def tick(self, n=1):
        for _ in range(n):
            self.sup.tick()

    def start(self, mode="single", model="deepseek", method="a"):
        ok, msg = control.start(self.store, model, method, mode)
        assert ok, msg

    def row(self, model="deepseek", method="a"):
        return self.store.active_batch(model, method) or self.store.latest_batch(model, method)
