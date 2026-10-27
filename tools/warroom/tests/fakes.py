from __future__ import annotations

import itertools
import re
import tempfile
from pathlib import Path

from warroom import control
from warroom.adapters import AgentAdapter, Handle, OpenCodeAdapter
from warroom.config import DEFAULTS, Paths
from warroom.gitops import CleanupBlocked, GitError, IntegrationBlocked
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
        return self._go("start", cwd, log_file, exit_file, prompt=prompt, model=run.model, effort=run.effort,
                        approved_literary_db=env.get("TYPEWRITER_APPROVED_LITERARY_DB"),
                        stage2_chunk_git=env.get("WARROOM_STAGE2_CHUNK"),
                        git_shim=env.get("WARROOM_GIT_SHIM"),
                        real_git=env.get("WARROOM_REAL_GIT"),
                        git_sandbox_paths=env.get("WARROOM_GIT_EXECUTABLES"),
                        worker_path=env.get("PATH"))

    def resume(self, session_id, prompt, cwd, env, run, log_file, exit_file):
        return self._go("resume", cwd, log_file, exit_file, prompt=prompt, model=run.model, effort=run.effort,
                        session=session_id, approved_literary_db=env.get("TYPEWRITER_APPROVED_LITERARY_DB"),
                        stage2_chunk_git=env.get("WARROOM_STAGE2_CHUNK"),
                        git_shim=env.get("WARROOM_GIT_SHIM"),
                        real_git=env.get("WARROOM_REAL_GIT"),
                        git_sandbox_paths=env.get("WARROOM_GIT_EXECUTABLES"),
                        worker_path=env.get("PATH"))

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
        self.integrated: list[tuple[str, str]] = []           # (worktree, sha) of every shared fix merged in
        self.integrate_error: Exception | None = None         # raised by integrate (IntegrationBlocked / GitError)
        self.changed: dict[str, list[str]] = {}               # merge sha -> files the merged PR changed
        self.verified: set[tuple] = set()                     # (kind, shard, batch, part) Stage 2 verifies that succeed on master
        self.verify_heads: set[tuple] = set()                 # (sha, kind, shard, batch, part) exact non-master verification
        self.verify_calls: list[tuple] = []
        self.verify_error: Exception | None = None
        self.on_base = True                                   # is a merge commit already on origin/<base>
        self.chunk_views: list[tuple] = []                    # (worktree, shard, batch, part, prepare) pre-chunk renders
        self.chunk_view_error: Exception | None = None
        self.chunk_view_total = 1                             # candidates a fake `prepare` writes
        self.chunk_view_text: str | None = None               # rendered view (default: one short line)

    def fetch_base(self, base):
        return "m" * 40

    # ---- Method C finalization (Issue #2033) ----
    def commit_paths(self, path, rels, message):
        self.commits = getattr(self, "commits", [])
        if self.dirty_text.strip() and {l[3:].strip() for l in self.dirty_text.splitlines() if l.strip()} != set(rels):
            raise GitError("커밋 대상이 의도한 파일과 다릅니다")
        self.commits.append((list(rels), message))
        self.local_head = "f" * 40
        self.committed_rels = getattr(self, "committed_rels", set()) | set(rels)
        return self.local_head

    def is_committed(self, path, rel):
        return rel in getattr(self, "committed_rels", set()) and not self.dirty_text.strip()

    def is_candidate_child(self, path, base_sha, rel):
        return getattr(self, "child_of", None) == (base_sha, rel)

    def push_branch(self, path, branch):
        self.pushes = getattr(self, "pushes", [])
        if self.push_error:
            raise GitError(self.push_error)
        self.pushes.append(branch)
        self.remote[branch] = self.local_head

    def verify_stage2(self, sha, kind, shard, batch, part, timeout=900):
        self.verify_calls.append((kind, shard, batch, part))
        if self.verify_error:
            raise self.verify_error
        ok = (kind, shard, batch, part) in self.verified or (sha, kind, shard, batch, part) in self.verify_heads
        return ok, "" if ok else "Relation Admission accounting failed: candidate has no relation"

    def stage2_chunk_view(self, worktree, shard, batch, part, *, prepare, timeout=900):
        """Mimic admission-cli prepare + read-chunk: a pending chunk covering every undecided candidate."""
        self.chunk_views.append((str(worktree), shard, batch, part, prepare))
        if self.chunk_view_error:
            raise self.chunk_view_error
        path = Path(worktree) / ".warroom-scratch" / f"relation-admission-{shard}-{batch}-{part}.json"
        if prepare:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({
                "version": 1, "shard": shard, "batch": batch, "part": part, "complete": True, "stats": {},
                "next_chunk_number": 1, "pending_chunk": None, "merged": False,
                "items": [{"sense_id": "source-sense", "candidates": [
                    {"text": f"candidate-{i}", "decision": None} for i in range(self.chunk_view_total)]}],
            }), "utf-8")
        data = json.loads(path.read_text("utf-8"))
        candidates = data["items"][0]["candidates"]
        start = next((i for i, c in enumerate(candidates) if c["decision"] is None), -1)
        if data["pending_chunk"] is None and start >= 0:
            data["pending_chunk"] = {"chunk_id": f"{shard}-{batch}-{part}-{data['next_chunk_number']:03d}",
                                     "candidate_count": len(candidates) - start,
                                     "slices": [{"sense_id": "source-sense", "start": start, "end": len(candidates)}]}
            path.write_text(json.dumps(data), "utf-8")
        (path.parent / "active-chunk.txt").write_text(
            self.chunk_view_text or f"# chunk {data['pending_chunk']}\n", "utf-8")

    def contains_on_base(self, sha, base):
        return self.on_base

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

    def integrate(self, path, branch, base, sha):
        if self.integrate_error:
            raise self.integrate_error
        if (str(path), sha) not in self.integrated:
            self.integrated.append((str(path), sha))
        return self.local_head

    def contains(self, path, sha):
        return (str(path), sha) in self.integrated

    def changed_files(self, sha):
        return self.changed.get(sha, ["README.md"])   # default: a documentation-only fix

    def remove_owned(self, path, branch, pr_head, *, cleanup_proof=None, on_verified=None):
        if self.block:
            raise CleanupBlocked(self.block)
        registered = next((owner for key, owner in self.reg.items()
                           if Path(key).resolve() == Path(path).resolve()), None)
        if registered != branch and not cleanup_proof:
            raise CleanupBlocked("worktree registration is missing and no matching cleanup proof exists")
        if self.dirty_text.strip():
            raise CleanupBlocked("dirty")
        if self.local_head != pr_head:
            raise CleanupBlocked("head mismatch")
        if on_verified is not None:
            on_verified()
        self.removed.append((str(path), branch))
        import shutil
        shutil.rmtree(path)


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
        self.git = None
        self.issues: dict[int, dict] = {}        # urgent Issues: number -> {state, labels, title, body}
        self.issue_comments_: dict[int, list] = {}
        self.created: list[int] = []
        self.fail_create = self.fail_list = False
        self.fail_pull = False

    def open_prs(self):
        return self.open

    def create_pr(self, head, base, title, body, labels):
        self.created_prs = getattr(self, "created_prs", [])
        if getattr(self, "create_pr_error", None):
            # the response may be lost although the PR exists
            if getattr(self, "create_pr_lost", False):
                self._register(head, title, body, labels)
            raise self.create_pr_error
        self._register(head, title, body, labels)

    def _register(self, head, title, body, labels):
        n = 100 + len(self.created_prs)
        self.created_prs.append({"number": n, "head": head, "title": title, "body": body, "labels": labels})
        self.prs[n] = {"number": n, "state": "open", "merged": False, "head_sha": self.git.local_head, "head_ref": head,
                       "url": "", "merge_commit_sha": ""}
        self.by_branch.setdefault(head, []).append({"number": n, "state": "OPEN", "headRefOid": self.git.local_head})

    def prs_for_branch(self, branch):
        self.branch_queries += 1
        if branch in self.branch_errors:
            raise self.branch_errors[branch]
        return self.by_branch.get(branch, [])

    def pull(self, n):
        if self.fail_pull:
            raise RuntimeError("pull failed")
        result = dict(self.prs[n])
        if result.get("head_ref") == "x":   # default from pr_info; preserve deliberate mismatch fixtures
            for branch, prs in self.by_branch.items():
                if any(pr.get("number") == n for pr in prs):
                    result["head_ref"] = branch
                    break
        branch = result.get("head_ref")
        if self.git is not None and result.get("state") == "open" and isinstance(branch, str) and branch != "x":
            self.git.remote.setdefault(branch, result.get("head_sha"))
        return result

    def close_pr(self, n):
        if self.close_error:
            raise self.close_error
        self.prs[n] = self.prs[n] | {"state": "closed"}
        self.closed.append(n)

    # ---- Issues (Issue #1555) ----
    def urgent_issues(self):
        if self.fail_list:
            raise RuntimeError("issue list failed")
        return [{"number": n, "state": i["state"], "title": i["title"], "body": i["body"]}
                for n, i in sorted(self.issues.items()) if "urgent" in i["labels"]]

    def create_issue(self, title, body, labels):
        if self.fail_create:
            raise RuntimeError("issue create failed")
        n = 100 + len(self.issues) + 1
        self.issues[n] = {"state": "open", "labels": list(labels), "title": title, "body": body}
        self.created.append(n)
        return n

    def issue(self, n):
        i = self.issues[n]
        return {"number": n, "state": i["state"], "labels": i["labels"], "pull_request": False, "body": i["body"]}

    def comment_issue(self, n, body):
        self.issue_comments_.setdefault(n, []).append({"body": body})

    def pull_files(self, n):
        if n in self.files:
            files = self.files[n]
        else:
            # A branch-linked fake Stage 1 PR represents the normal producer output unless a test explicitly
            # supplies a different file list (including [] or None for missing/unknown-claim cases).
            branch = self.pull(n).get("head_ref", "")
            parts = branch.split("-")
            if (len(parts) >= 4 and parts[0] in "abcd" and re.fullmatch(r"\d{3}", parts[-2])
                    and re.fullmatch(r"\d{2}", parts[-1])):
                method, shard, batch = parts[0], parts[-2], parts[-1]
                producer = "-".join(parts[1:-2])
                files = [{"path": f"data/relation-candidates/{shard}/"
                                  f"{shard}_{batch}_{method}_{producer}.jsonl"}]
            else:
                files = []
        if isinstance(files, Exception):
            raise files
        return files

    def reviews(self, n): return self.reviews_
    def inline_comments(self, n): return self.inline_
    def issue_comments(self, n): return self.issue_comments_.get(n, self.issue_)
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
        self.gh.git = self.git
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

    def pr_info(self, n=7, head=HEAD1, state="open", merged=False, head_ref="x", merge_sha=""):
        self.gh.prs[n] = {"number": n, "state": state, "merged": merged, "head_sha": head,
                          "head_ref": head_ref, "url": "", "merge_commit_sha": merge_sha}

    def tick(self, n=1):
        for _ in range(n):
            self.sup.tick()

    def start(self, mode="single", model="deepseek", method="a"):
        ok, msg = control.start(self.store, model, method, mode, cfg=self.cfg)
        assert ok, msg

    def row(self, model="deepseek", method="a"):
        return self.store.active_batch(model, method) or self.store.latest_batch(model, method)

