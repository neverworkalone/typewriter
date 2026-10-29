from __future__ import annotations

import itertools
import re
import tempfile
import time
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
                        approved_corpus_db=env.get("TYPEWRITER_APPROVED_CORPUS_DB"),
                        stage2_chunk_git=env.get("WARROOM_STAGE2_CHUNK"),
                        answer_only=env.get("WARROOM_ANSWER_ONLY"), opencode_config=env.get("OPENCODE_CONFIG_CONTENT"),
                        git_shim=env.get("WARROOM_GIT_SHIM"),
                        real_git=env.get("WARROOM_REAL_GIT"),
                        git_sandbox_paths=env.get("WARROOM_GIT_EXECUTABLES"),
                        worker_path=env.get("PATH"))

    def resume(self, session_id, prompt, cwd, env, run, log_file, exit_file):
        return self._go("resume", cwd, log_file, exit_file, prompt=prompt, model=run.model, effort=run.effort,
                        session=session_id, approved_literary_db=env.get("TYPEWRITER_APPROVED_LITERARY_DB"),
                        approved_corpus_db=env.get("TYPEWRITER_APPROVED_CORPUS_DB"),
                        stage2_chunk_git=env.get("WARROOM_STAGE2_CHUNK"),
                        answer_only=env.get("WARROOM_ANSWER_ONLY"), opencode_config=env.get("OPENCODE_CONFIG_CONTENT"),
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
        self.changed_between_paths: list[str] = []            # what differs between two master commits
        self.base_sha = "m" * 40                              # origin/<base> as fetch_base reports it
        self.outcomes: dict[tuple, list] = {}                 # (kind, shard, batch) -> queued VerifyOutcome (last one repeats)
        self.on_base = True                                   # is a merge commit already on origin/<base>
        self.chunk_views: list[tuple] = []                    # (worktree, shard, batch, part, prepare) pre-chunk renders
        self.chunk_view_error: Exception | None = None
        self.chunk_view_total = 1                             # candidates a fake `prepare` writes
        self.chunk_view_text: str | None = None               # rendered view (default: one short line)
        self.chunk_view_sense_id = "source-sense"
        self.save_calls: list[str] = []                       # decisions.txt text at each save-chunk
        self.optional_view_text: str | None = None
        self.optional_candidate_after_chunk = False
        self.optional_save_result: tuple[bool, str] | None = None
        self.optional_save_calls: list[str] = []
        self.finalize_output_paths: list[str] | None = None
        self.finalize_error: Exception | None = None
        self.local_verify_ok = True
        self.exact_verify_ok = True
        self.local_verify_calls: list[tuple] = []
        self.exact_verify_calls: list[tuple] = []
        self.inspect_calls: list[tuple] = []
        self.inspect_text = "inspect w1-s1 @" + "2" * 64 + "\n# page 1/1\nS\tw1-s1\tw1\t출발어\tnoun\t출발 의미\n"
        self.commit_parent_sha: str | None = None
        self.commit_message: str | None = None
        self.commit_empty_allowed: list[bool] = []
        self.stage2_merge_calls: list[tuple] = []
        self.stage2_prepare_merge_calls: list[tuple] = []
        self.stage2_preflight_calls: list[tuple] = []
        self.stage2_preflight_reports: list[dict] = []
        self.stage2_repair_calls: list[dict] = []
        self.stage2_repair_results: list[dict] = []

    def fetch_base(self, base):
        return self.base_sha

    # ---- Method C finalization (Issue #2033) ----
    def commit_paths(self, path, rels, message, *, allow_empty=False):
        self.commits = getattr(self, "commits", [])
        self.commit_empty_allowed.append(allow_empty)
        if not self.dirty_text.strip() and not rels and not allow_empty:
            raise GitError("빈 커밋은 명시적으로 허용된 경우에만 가능합니다")
        if self.dirty_text.strip() and {l[3:].strip() for l in self.dirty_text.splitlines() if l.strip()} != set(rels):
            raise GitError("커밋 대상이 의도한 파일과 다릅니다")
        self.commit_parent_sha = self.local_head
        self.commit_message = message
        self.commits.append((list(rels), message))
        self.local_head = "f" * 40
        self.committed_rels = getattr(self, "committed_rels", set()) | set(rels)
        self.dirty_text = ""
        return self.local_head

    def changed_paths(self, path):
        return {line[3:].strip() for line in self.dirty_text.splitlines() if line.strip()}

    def commit_parent(self, path):
        return self.commit_parent_sha

    def commit_subject(self, path):
        return self.commit_message or ""

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

    def changed_between(self, old, new):
        return list(self.changed_between_paths)

    def verify_stage2_outcome(self, sha, kind, shard, batch, part, timeout=900):
        """A queued VerifyOutcome for this scope (last one repeats), else success when verified/unclassified failure."""
        from warroom.gitops import VerifyOutcome
        ok, tail = self.verify_stage2(sha, kind, shard, batch, part, timeout)
        queue = self.outcomes.get((kind, shard, batch))
        if queue:
            return queue.pop(0) if len(queue) > 1 else queue[0]
        return VerifyOutcome(ok, tail)

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
                "items": [{"sense_id": self.chunk_view_sense_id, "candidates": [
                    {"text": f"candidate-{i}", "decision": None} for i in range(self.chunk_view_total)]}],
            }), "utf-8")
        data = json.loads(path.read_text("utf-8"))
        candidates = data["items"][0]["candidates"]
        start = next((i for i, c in enumerate(candidates) if c["decision"] is None), -1)
        if data["pending_chunk"] is None and start >= 0:
            data["pending_chunk"] = {"chunk_id": f"{shard}-{batch}-{part}-{data['next_chunk_number']:03d}",
                                     "candidate_count": len(candidates) - start,
                                     "slices": [{"sense_id": self.chunk_view_sense_id, "start": start, "end": len(candidates)}]}
            path.write_text(json.dumps(data), "utf-8")
        (path.parent / "active-chunk.txt").write_text(
            self.chunk_view_text or f"# chunk {data['pending_chunk']}\n", "utf-8")

    def stage2_save_chunk(self, worktree, shard, batch, part, timeout=900):
        """Mimic `admission-cli save-chunk --format compact`: one `c<n>` row per pending candidate, none other, else the
        complete error list with the checkpoint untouched; on success the cursor advances and the chunk is decided."""
        wt = Path(worktree)
        text = (wt / ".warroom-scratch" / "decisions.txt").read_text("utf-8")
        self.save_calls.append(text)
        path = wt / ".warroom-scratch" / f"relation-admission-{shard}-{batch}-{part}.json"
        data = json.loads(path.read_text("utf-8"))
        pending = data["pending_chunk"]
        count = pending["candidate_count"]
        rows = {}
        for line in text.split("\n")[1:]:
            if line.strip():
                rows.setdefault(line.split()[0], []).append(line.strip())
        problems = []
        for alias, found in rows.items():
            n = int(alias[1:]) if alias[1:].isdigit() else 0
            if not 1 <= n <= count:
                problems.append(f"{alias}: names no candidate")
            elif len(found) > 1 or " BAD" in found[0]:
                problems.append(f"{alias} candidate-{n}: bad decision")
        problems += [f"c{n} candidate-{n - 1}: chunk has missing decisions" for n in range(1, count + 1) if f"c{n}" not in rows]
        problems.sort(key=lambda p: int(p.split()[0][1:]) if p.split()[0][1:].isdigit() else 0)
        if problems:
            return False, f"chunk {pending['chunk_id']} not saved, checkpoint unchanged: {len(problems)} problem(s)\n" + "\n".join(problems)
        for sl in pending["slices"]:
            for c in data["items"][0]["candidates"][sl["start"]:sl["end"]]:
                c["decision"] = {"disposition": "drop"}
                if self.optional_candidate_after_chunk:
                    c.update({"already_accounted": True, "decision": {"disposition": "existing"},
                              "existing_target_sense_ids": ["target-1"],
                              "unlinked_target_sense_ids": ["target-2"], "additional_relations": []})
        data["pending_chunk"] = None
        data["next_chunk_number"] += 1
        path.write_text(json.dumps(data), "utf-8")
        return True, f"Saved {count} decisions"

    def stage2_optional_view(self, worktree, shard, batch, part, timeout=900):
        if self.optional_view_text is not None:
            return self.optional_view_text
        if self.optional_candidate_after_chunk:
            return ("# optional links · source-sense/candidate-0 · full target context\n"
                    f"links @{'a' * 64}\nS\tsource-sense\tsource\t출발어\tnoun\t출발 의미\n"
                    "T1\ttarget-1\tt1\t표적\tnoun\t기존 연결 sense\n"
                    "T2\ttarget-2\tt2\t표적\tnoun\t추가 검토 sense\n"
                    "c1\tcandidate-0\tT1,T2\n")
        return f"# no optional links · {shard}/{batch}/{part} · review required\nlinks @{'0' * 64}\n"

    def stage2_complete_optional(self, worktree, shard, batch, part, timeout=900):
        path = Path(worktree) / ".warroom-scratch" / f"relation-admission-{shard}-{batch}-{part}.json"
        data = json.loads(path.read_text("utf-8"))
        data["optional_review_complete"] = True
        data["optional_review_digest"] = "0" * 64
        data["optional_review_state_sha256"] = "0" * 64
        path.write_text(json.dumps(data), "utf-8")

    def stage2_save_optional(self, worktree, shard, batch, part, timeout=900):
        decisions = Path(worktree) / ".warroom-scratch" / "optional-decisions.txt"
        self.optional_save_calls.append(decisions.read_text("utf-8"))
        if self.optional_save_result is not None and not self.optional_save_result[0]:
            return self.optional_save_result
        path = Path(worktree) / ".warroom-scratch" / f"relation-admission-{shard}-{batch}-{part}.json"
        data = json.loads(path.read_text("utf-8"))
        data["optional_review_complete"] = True
        data["optional_review_digest"] = "1" * 64
        data["optional_review_state_sha256"] = "1" * 64
        path.write_text(json.dumps(data), "utf-8")
        return self.optional_save_result or (True, "Saved optional links")

    def stage2_merge(self, worktree, shard, batch, part, timeout=900):
        self.stage2_merge_calls.append((shard, batch, part))
        if self.finalize_error:
            raise self.finalize_error
        path = Path(worktree) / ".warroom-scratch" / f"relation-admission-{shard}-{batch}-{part}.json"
        data = json.loads(path.read_text("utf-8"))
        data["merged"] = True
        data["premerge"] = {"status": "ready", "identity": f"{shard}/{batch}/{part}"}
        path.write_text(json.dumps(data), "utf-8")
        outputs = self.finalize_output_paths
        if outputs is None:
            outputs = [f"data/relations/relation-{shard}.jsonl"]
        self.dirty_text = "".join(f" M {output}\n" for output in outputs)

    def stage2_prepare_merge(self, worktree, shard, batch, part, timeout=900):
        self.stage2_prepare_merge_calls.append((shard, batch, part))
        path = Path(worktree) / ".warroom-scratch" / f"relation-admission-{shard}-{batch}-{part}.json"
        data = json.loads(path.read_text("utf-8"))
        data["premerge"] = {"status": "ready", "identity": f"{shard}/{batch}/{part}",
                            "relations": {"exists": False, "sha256": None},
                            "drops": {"exists": False, "sha256": None}}
        path.write_text(json.dumps(data), "utf-8")

    def stage2_preflight(self, worktree, shard, batch, part, timeout=900):
        self.stage2_preflight_calls.append((shard, batch, part))
        if self.stage2_preflight_reports:
            return self.stage2_preflight_reports.pop(0)
        return {"version": 1, "ok": True, "repairable": False, "shard": shard, "batch": batch,
                "part": part, "fingerprint": "a" * 64, "total": 0, "candidate_total": 0,
                "problems": [], "unclassified": [], "coverage": {}}

    def stage2_repair(self, worktree, shard, batch, part, repair, timeout=900):
        self.stage2_repair_calls.append(repair)
        path = Path(worktree) / ".warroom-scratch" / f"relation-admission-{shard}-{batch}-{part}.json"
        data = json.loads(path.read_text("utf-8"))
        keys = sorted(f"{row['source_sense_id']}\u0000{row['candidate']}" for row in repair["decisions"])
        prior = next((receipt for receipt in data.get("repair_receipts", [])
                      if receipt["fingerprint"] == repair["fingerprint"] and receipt["candidate_keys"] == keys), None)
        if prior:
            for row in repair["decisions"]:
                item = next(item for item in data["items"] if item["sense_id"] == row["source_sense_id"])
                candidate = next(candidate for candidate in item["candidates"] if candidate["text"] == row["candidate"])
                expected = row["additional_relations"] if candidate.get("already_accounted") is True else row["decision"]
                actual = candidate.get("additional_relations") if candidate.get("already_accounted") is True else candidate.get("decision")
                if actual != expected:
                    raise GitError("repair receipt exists but its candidate state no longer matches")
            result = {"version": 1, "ok": True, "repaired": 0, "already_applied": True,
                      "request_id": prior["request_id"], "candidate_keys": keys}
            self.stage2_repair_results.append(result)
            return result
        for row in repair["decisions"]:
            item = next(item for item in data["items"] if item["sense_id"] == row["source_sense_id"])
            candidate = next(candidate for candidate in item["candidates"] if candidate["text"] == row["candidate"])
            if candidate.get("already_accounted") is True:
                candidate["additional_relations"] = row["additional_relations"]
            else:
                candidate["decision"] = row["decision"]
        data.setdefault("repair_receipts", []).append({"request_id": "c" * 64, "fingerprint": repair["fingerprint"],
                                                        "candidate_keys": keys})
        path.write_text(json.dumps(data), "utf-8")
        result = {"version": 1, "ok": True, "repaired": len(repair["decisions"]),
                  "already_applied": False, "request_id": "c" * 64, "candidate_keys": keys}
        self.stage2_repair_results.append(result)
        return result

    def verify_stage2_local(self, worktree, shard, batch, part, *, checkpoint, timeout=900):
        self.local_verify_calls.append((shard, batch, part, checkpoint))
        return self.local_verify_ok, "" if self.local_verify_ok else "local verify failed"

    def verify_stage2_exact(self, sha, shard, batch, part, timeout=900):
        self.exact_verify_calls.append((sha, shard, batch, part))
        return self.exact_verify_ok, "" if self.exact_verify_ok else "exact HEAD verify failed"

    def stage2_inspect(self, worktree, shard, batch, part, sense_ids, timeout=900):
        self.inspect_calls.append((str(worktree), shard, batch, part, list(sense_ids)))
        return self.inspect_text

    def contains_on_base(self, sha, base):
        return self.on_base

    def create_worktree(self, path, branch, base):
        Path(path).mkdir(parents=True)
        if getattr(self, "on_create", None):
            self.on_create(Path(path))
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
        self.created_prs: list[dict] = []
        self.issues: dict[int, dict] = {}        # urgent Issues: number -> {state, labels, title, body}
        self.issue_comments_: dict[int, list] = {}
        self.created: list[int] = []
        self.fail_create = self.fail_create_lost = self.fail_list = False
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

    def all_issues(self):
        if self.fail_list:
            raise RuntimeError("issue list failed")
        return [{"number": n, "state": i["state"], "title": i["title"], "body": i["body"],
                 "created_at": i.get("created_at"), "labels": list(i["labels"]), "pull_request": False}
                for n, i in sorted(self.issues.items())]

    def create_issue(self, title, body, labels):
        if self.fail_create_lost:
            self.fail_create_lost = False
            return self._create_issue(title, body, labels, lost=True)
        if self.fail_create:
            raise RuntimeError("issue create failed")
        return self._create_issue(title, body, labels)

    def _create_issue(self, title, body, labels, lost=False):
        n = 100 + len(self.issues) + 1
        self.issues[n] = {"state": "open", "labels": list(labels), "title": title, "body": body,
                          "created_at": time.time()}
        self.created.append(n)
        if lost:
            raise RuntimeError("issue create response lost")
        return n

    def issue(self, n):
        i = self.issues.get(n, {"state": "open", "labels": [], "title": "", "body": ""})
        return {"number": n, "title": i["title"], "state": i["state"], "labels": i["labels"],
                "pull_request": False, "body": i["body"]}

    def edit_issue_title(self, n, title):
        self.issues[n]["title"] = title

    def comment_issue(self, n, body):
        self.issue_comments_.setdefault(n, []).append({"body": body})

    def pull_files(self, n):
        if n in self.files:
            files = self.files[n]
        else:
            # A branch-linked fake PR represents the normal producer output unless a test supplies another file list.
            branch = self.pull(n).get("head_ref", "")
            parts = branch.split("-")
            if len(parts) >= 5 and parts[0] == "s2" and re.fullmatch(r"\d{3}", parts[-3]):
                shard = parts[-3]
                files = [{"path": f"data/relations/relation-{shard}.jsonl"}]
            elif (len(parts) >= 4 and parts[0] in "abcd" and re.fullmatch(r"\d{3}", parts[-2])
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
        self.cfg["ab_chunk_sessions"] = False   # legacy A/B tests drive the long session; test_issue_2035 enables chunks
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

