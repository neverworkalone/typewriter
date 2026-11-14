from __future__ import annotations

import hashlib
import itertools
import re
import sqlite3
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

from warroom import control
from warroom.adapters import AgentAdapter, Handle, OpenCodeAdapter
from warroom.config import DEFAULTS, Paths
from warroom.gitops import (CleanupBlocked, FastForwardBlocked, FastForwardRace, GitError, GitTransient,
                            IntegrationBlocked)
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

    def read_pid(self, exit_file):
        return next((pid for pid, r in self.running.items() if r.get("ex") == Path(exit_file)), None)

    def start(self, prompt, cwd, env, run, title, log_file, exit_file):
        return self._go("start", cwd, log_file, exit_file, prompt=prompt, model=run.model, effort=run.effort,
                        permission_profile=run.permission_profile, fast=run.fast,
                        approved_literary_db=env.get("TYPEWRITER_APPROVED_LITERARY_DB"),
                        approved_corpus_db=env.get("TYPEWRITER_APPROVED_CORPUS_DB"),
                        stage2_chunk_git=env.get("WARROOM_STAGE2_CHUNK"),
                        stage2_repair=env.get("WARROOM_STAGE2_REPAIR"),
                        d_chunk_cli=env.get("TYPEWRITER_D_CHUNK_CLI"),
                        d_scratch=env.get("TYPEWRITER_D_SCRATCH"),
                        d_canonical_root=env.get("TYPEWRITER_D_CANONICAL_ROOT"),
                        answer_only=env.get("WARROOM_ANSWER_ONLY"), opencode_config=env.get("OPENCODE_CONFIG_CONTENT"),
                        git_shim=env.get("WARROOM_GIT_SHIM"),
                        real_git=env.get("WARROOM_REAL_GIT"),
                        git_sandbox_paths=env.get("WARROOM_GIT_EXECUTABLES"),
                        worker_path=env.get("PATH"))

    def resume(self, session_id, prompt, cwd, env, run, log_file, exit_file):
        return self._go("resume", cwd, log_file, exit_file, prompt=prompt, model=run.model, effort=run.effort,
                        permission_profile=run.permission_profile, fast=run.fast,
                        session=session_id, approved_literary_db=env.get("TYPEWRITER_APPROVED_LITERARY_DB"),
                        approved_corpus_db=env.get("TYPEWRITER_APPROVED_CORPUS_DB"),
                        stage2_chunk_git=env.get("WARROOM_STAGE2_CHUNK"),
                        stage2_repair=env.get("WARROOM_STAGE2_REPAIR"),
                        answer_only=env.get("WARROOM_ANSWER_ONLY"), opencode_config=env.get("OPENCODE_CONFIG_CONTENT"),
                        git_shim=env.get("WARROOM_GIT_SHIM"),
                        real_git=env.get("WARROOM_REAL_GIT"),
                        git_sandbox_paths=env.get("WARROOM_GIT_EXECUTABLES"),
                        worker_path=env.get("PATH"))

    def preflight(self, runner, env, runs, answer_required=frozenset()):
        """Stands in for OpenCode: the provider-qualified (p/...) IDs get the real `opencode models` check."""
        opencode_runs = [r for r in runs if "/" in r.model]
        return (self._opencode.preflight(runner, env, opencode_runs, answer_required=answer_required)
                if opencode_runs else None)

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
        self.integration_proof_calls: list[tuple[str, str, str, str, str]] = []
        self.maintainer_sync_calls: list[tuple] = []
        self.maintainer_pushes: list[tuple[str, str, str]] = []
        self.maintainer_sync_error: Exception | None = None
        self.maintainer_changed_paths: set[str] = set()
        self.maintainer_after_push = None
        self.ancestor_pairs: set[tuple[str, str]] = set()
        self.commit_ranges: set[tuple[str, str, str]] = set()
        self.integrate_updates_head = False
        self.integrate_error: Exception | None = None         # raised by integrate (IntegrationBlocked / GitError)
        self.changed: dict[str, list[str]] = {}               # merge sha -> files the merged PR changed
        self.verified: set[tuple] = set()                     # (kind, shard, batch, part) Stage 2 verifies that succeed on master
        self.verify_heads: set[tuple] = set()                 # (sha, kind, shard, batch, part) exact non-master verification
        self.verify_calls: list[tuple] = []
        self.verify_error: Exception | None = None
        self.changed_between_paths: list[str] = []            # what differs between two master commits
        self.deleted_id_relation_ranges: set[tuple[str, str]] = set()
        self.relation_owner_shards: set[str] | None = None    # changed Relation row owners; None models unavailable evidence
        self.base_sha = "m" * 40                              # origin/<base> as fetch_base reports it
        self.outcomes: dict[tuple, list] = {}                 # (kind, shard, batch) -> queued VerifyOutcome (last one repeats)
        self.on_base = True                                   # is a merge commit already on origin/<base>
        self.plan_calls: list[tuple] = []
        self.task_view_calls: list[str] = []
        self.task_save_calls: list[str] = []
        self.close_plan_calls: list[tuple] = []
        self.chunk_views: list[tuple] = []                    # (worktree, shard, batch, part, prepare) pre-chunk renders
        self.chunk_view_error: Exception | None = None
        self.chunk_view_total = 1                             # candidates a fake `prepare` writes
        self.chunk_view_text: str | None = None               # rendered compact view
        self.chunk_view_sense_id = "source-sense"
        self.save_calls: list[str] = []                       # decisions.txt text at each save-chunk
        self.technical_fallback_calls: list[dict] = []
        self.optional_view_text: str | None = None
        self.optional_candidate_after_chunk = False
        self.optional_save_result: tuple[bool, str] | None = None
        self.optional_save_calls: list[str] = []
        self.finalize_output_paths: list[str] | None = None
        self.finalize_error: Exception | None = None
        self.local_verify_ok = True
        self.exact_verify_ok = True
        self.exact_counts = {"records": 100, "senses": 130, "unique": 40, "skipped_existing": 5, "reverse_covered": 3,
                             "merged_duplicates": 2, "raw": 42, "missing": 0, "relation": 999, "drop": 999}
        self.row_delta_result = {"relations": 20, "drops": 12, "automation_failure_candidates": []}
        self.row_counts = {}
        self.local_verify_calls: list[tuple] = []
        self.exact_verify_calls: list[tuple] = []
        self.inspect_calls: list[tuple] = []
        self.inspect_text = "inspect w1-s1 @" + "2" * 64 + "\n# page 1/1\nS\tw1-s1\tw1\t출발어\tnoun\t출발 의미\n"
        self.commit_parent_sha: str | None = None
        self.commit_message: str | None = None
        self.fast_forward_calls: list[tuple[str, str, str, set[str]]] = []
        self.fast_forward_ancestors: set[tuple[str, str]] = {(HEAD1, HEAD2)}
        self.fast_forward_changed_paths: list[str] = []
        self.fast_forward_recheck_effect = None
        self.commit_empty_allowed: list[bool] = []
        self.stage2_merge_calls: list[tuple] = []
        self.stage2_prepare_merge_calls: list[tuple] = []
        self.stage2_prepare_merge_meta: list[tuple] = []
        self.stage2_preflight_calls: list[tuple] = []
        self.stage2_preflight_reports: list[dict] = []
        self.reconcile_preview_added = 0
        self.reconcile_added = 0
        self.reconcile_preview_calls: list[tuple] = []
        self.reconcile_calls: list[tuple] = []
        self.stage2_repair_calls: list[dict] = []
        self.stage2_repair_check_calls: list[dict] = []
        self.stage2_repair_checker = None
        self.stage2_repair_apply_results: list = []
        self.stage2_repair_results: list[dict] = []
        self.stage2_amend_results: list = []                  # per call: {"changes": {rel: text}} or an exception
        self.stage2_amend_calls: list[tuple] = []

    def fetch_base(self, base):
        return self.base_sha

    def _verify_checkout(self, sha):
        return self.wt_root

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
        self.ancestor_pairs.add((self.commit_parent_sha, self.local_head))
        self.changed[self.local_head] = list(rels)
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

    def push_owned_fix(self, path, branch, remote_sha, local):
        self.owned_fix_pushes = getattr(self, "owned_fix_pushes", [])
        if self.push_error:
            raise GitError(self.push_error)
        self.owned_fix_pushes.append((branch, remote_sha, local))
        self.remote[branch] = local

    def verify_stage2(self, sha, kind, shard, batch, part, timeout=900):
        self.verify_calls.append((kind, shard, batch, part))
        if self.verify_error:
            raise self.verify_error
        ok = (kind, shard, batch, part) in self.verified or (sha, kind, shard, batch, part) in self.verify_heads
        return ok, "" if ok else "Relation Admission accounting failed: candidate has no relation"

    def changed_between(self, old, new):
        return list(self.changed_between_paths)

    def has_deleted_id_relation_rows(self, old, new, *, path=None):
        return (old, new) in self.deleted_id_relation_ranges

    def stage2_affected_relation_shards(self, old, new):
        from warroom.gitops import GitError
        if self.relation_owner_shards is None:
            raise GitError("fixture Relation row-owner evidence is unavailable")
        return set(self.relation_owner_shards)

    def stage2_affected_relation_shards_many(self, old_shas, new):
        from warroom.gitops import GitError
        if self.relation_owner_shards is None:
            raise GitError("fixture Relation row-owner evidence is unavailable")
        return {old: set(self.relation_owner_shards) for old in old_shas}

    def stage2_reconcile_latest(self, sha, shard, diff_from, diff_to, *, batch, part, timeout=900):
        self.reconcile_preview_calls.append((sha, shard, diff_from, diff_to, batch, part))
        return {"version": 1, "ok": True, "shard": shard, "batch": batch, "part": part,
                "added": self.reconcile_preview_added, "dry_run": True, "candidates": []}

    def stage2_reconcile(self, worktree, shard, diff_from, diff_to, *, batch=None, part=None, dry_run=False, timeout=900):
        self.reconcile_calls.append((str(worktree), shard, diff_from, diff_to, batch, part, dry_run))
        if self.reconcile_added:
            self.dirty_text = f" M data/relation-drops/drop-{shard}.jsonl\n"
        return {"version": 1, "ok": True, "shard": shard, "batch": batch, "part": part,
                "added": self.reconcile_added, "dry_run": dry_run, "candidates": []}

    def verify_stage2_outcome(self, sha, kind, shard, batch, part, timeout=900):
        """A queued VerifyOutcome for this scope (last one repeats), else success when verified/unclassified failure."""
        from warroom.gitops import VerifyOutcome
        ok, tail = self.verify_stage2(sha, kind, shard, batch, part, timeout)
        queue = self.outcomes.get((kind, shard, batch))
        if queue:
            return queue.pop(0) if len(queue) > 1 else queue[0]
        return VerifyOutcome(ok, tail, code=0 if ok else 1)

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
                "items": [{"record_id": "source-record", "sense_id": self.chunk_view_sense_id, "candidates": [
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
        pending = data["pending_chunk"]
        if self.chunk_view_text is not None:
            view = self.chunk_view_text
        elif pending is None:
            view = f"# complete: no primary chunk remains ({data['next_chunk_number'] - 1} saved chunks)\n"
        else:
            rows = [f"# Stage 2 chunk {pending['chunk_id']} · shard {shard} batch {batch} part {part} · "
                    f"{pending['candidate_count']} candidates", "# compact view fixture",
                    f"S\t{self.chunk_view_sense_id}\tsource-record\tnoun\tfixture gloss\t"
                    f"candidates 1-{pending['candidate_count']}/{pending['candidate_count']}"]
            rows.extend(f"c{i + 1}\tcandidate-{i}\tfixture\t-" for i in range(pending["candidate_count"]))
            view = "\n".join(rows) + "\n"
        (path.parent / "active-chunk.txt").write_text(view, "utf-8")

    def stage2_save_chunk(self, worktree, shard, batch, part, timeout=900, supervisor_fallback=None,
                          supervisor_state_dir=None):
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
        if supervisor_fallback is not None:
            self.technical_fallback_calls.append(dict(supervisor_fallback))
            alias = supervisor_fallback["alias"]
            if alias in rows:
                return False, "Supervisor fallback candidate must be omitted from model decisions"
            rows[alias] = [f"{alias} D f"]
        problems = []
        for alias, found in rows.items():
            n = int(alias[1:]) if alias[1:].isdigit() else 0
            if not 1 <= n <= count:
                problems.append(f"{alias}: names no candidate")
            elif len(found) > 1:
                problems.append(f"{alias} candidate-{n - 1}: repeated decision row")
            elif " BAD" in found[0]:
                problems.append(f"{alias} candidate-{n - 1}: relation field is malformed")
            elif " T999" in found[0]:
                problems.append(f"{alias} candidate-{n - 1}: target_resolution must name an available target")
        problems += [f"c{n} candidate-{n - 1}: chunk has missing decisions" for n in range(1, count + 1) if f"c{n}" not in rows]
        problems.sort(key=lambda p: int(p.split()[0][1:]) if p.split()[0][1:].isdigit() else 0)
        if problems:
            return False, f"chunk {pending['chunk_id']} not saved, checkpoint unchanged: {len(problems)} problem(s)\n" + "\n".join(problems)
        for sl in pending["slices"]:
            for c in data["items"][0]["candidates"][sl["start"]:sl["end"]]:
                c["decision"] = {"disposition": "drop", "reason": "f" if supervisor_fallback and c["text"] == supervisor_fallback["candidate"] else "x"}
                if self.optional_candidate_after_chunk:
                    c.update({"already_accounted": True, "decision": {"disposition": "existing"},
                              "existing_target_sense_ids": ["target-1"],
                              "unlinked_target_sense_ids": ["target-2"], "additional_relations": []})
        data["pending_chunk"] = None
        data["next_chunk_number"] += 1
        path.write_text(json.dumps(data), "utf-8")
        return True, f"Saved {count} decisions"

    # ---- parallel primary tasks (#3047): a small model of the Admission task API (plan/read/save/close) ----
    task_layout = None   # [(sense_id, candidate count)] a fake `stage2_prepare` writes; None -> one sense of chunk_view_total

    def _task_checkpoint_path(self, worktree, shard, batch, part):
        return Path(worktree) / ".warroom-scratch" / f"relation-admission-{shard}-{batch}-{part}.json"

    def stage2_prepare(self, worktree, shard, batch, part, timeout=900):
        layout = self.task_layout or [(self.chunk_view_sense_id, self.chunk_view_total)]
        path = self._task_checkpoint_path(worktree, shard, batch, part)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "version": 1, "shard": shard, "batch": batch, "part": part, "complete": True, "stats": {},
            "next_chunk_number": 1, "pending_chunk": None, "merged": False,
            "items": [{"record_id": f"rec-{sense}", "sense_id": sense,
                       "candidates": [{"text": f"{sense}-cand-{i}", "decision": None} for i in range(n)]}
                      for sense, n in layout]}), "utf-8")

    def stage2_plan_chunks(self, worktree, shard, batch, part, target, plan, timeout=900):
        self.plan_calls.append((shard, batch, part, target))
        plan_path = Path(worktree) / plan
        if plan_path.exists():
            body = json.loads(plan_path.read_text("utf-8"))
            return {"ok": True, "plan": plan, "reused": True, "target": body["target"], "tasks": len(body["tasks"]),
                    "candidates": sum(t["candidate_count"] for t in body["tasks"])}
        data = json.loads(self._task_checkpoint_path(worktree, shard, batch, part).read_text("utf-8"))
        units = [(order, item["sense_id"], len(item["candidates"])) for order, item in enumerate(data["items"])]
        drafts, small = [], []
        for order, sense, count in units:
            if count <= target:
                small.append((order, sense, count))
                continue
            pieces, start = -(-count // target), 0
            for piece in range(pieces):
                size = count // pieces + (1 if piece < count % pieces else 0)
                drafts.append((order, piece, sense, [{"sense_id": sense, "start": start, "end": start + size}]))
                start += size
        bins = [[0, []] for _ in range(-(-sum(c for _, _, c in small) // target))]
        for unit in sorted(small, key=lambda u: (-u[2], u[0])):
            least = min(bins, key=lambda e: e[0])
            least[0] += unit[2]
            least[1].append(unit)
        for _load, members in bins:
            members.sort()
            drafts.append((members[0][0], 0, None, [{"sense_id": m[1], "start": 0, "end": m[2]} for m in members]))
        drafts.sort(key=lambda d: (d[0], d[1]))
        prefix = f"{shard}-{batch}-{part}"
        tid = lambda i: f"{prefix}-t{i + 1:02d}"
        tasks = [{"id": tid(i), "chunk_id": tid(i), "slices": d[3],
                  "candidate_count": sum(x["end"] - x["start"] for x in d[3]),
                  "depends_on": [tid(i - 1)] if d[2] is not None and d[1] > 0 else []} for i, d in enumerate(drafts)]
        body = {"version": 1, "shard": shard, "batch": batch, "part": part, "target": target, "tasks": tasks,
                "plan_digest": "d" * 64}
        plan_path.parent.mkdir(parents=True, exist_ok=True)
        plan_path.write_text(json.dumps(body), "utf-8")
        return {"ok": True, "plan": plan, "reused": False, "target": target, "tasks": len(tasks),
                "candidates": sum(t["candidate_count"] for t in tasks)}

    def _task_view(self, data, task):
        rows = [f"# Stage 2 chunk {task['chunk_id']} · task view fixture"]
        n = 0
        for sl in task["slices"]:
            item = next(i for i in data["items"] if i["sense_id"] == sl["sense_id"])
            rows.append(f"S\t{item['sense_id']}\t{item['record_id']}\tnoun\tgloss\tcandidates {sl['start'] + 1}-{sl['end']}")
            for c in item["candidates"][:sl["start"]]:   # the earlier decisions of this Sense (Q rows) shape the view
                rows.append(f"Q\t{c['text']}\t{json.dumps(c['decision'], sort_keys=True)}")
            for c in item["candidates"][sl["start"]:sl["end"]]:
                n += 1
                rows.append(f"c{n}\t{c['text']}\tfixture\t-")
        return "\n".join(rows) + "\n"

    def _task_of(self, worktree, plan, task_id):
        body = json.loads((Path(worktree) / plan).read_text("utf-8"))
        return next(t for t in body["tasks"] if t["id"] == task_id)

    def stage2_task_view(self, worktree, shard, batch, part, plan, task, out, timeout=900):
        import hashlib
        self.task_view_calls.append(task)
        data = json.loads(self._task_checkpoint_path(worktree, shard, batch, part).read_text("utf-8"))
        planned = self._task_of(worktree, plan, task)
        text = self._task_view(data, planned)
        Path(worktree, out).parent.mkdir(parents=True, exist_ok=True)
        Path(worktree, out).write_text(text, "utf-8")
        return {"task": task, "chunk_id": planned["chunk_id"], "candidate_count": planned["candidate_count"],
                "view_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest()}

    def stage2_save_task(self, worktree, shard, batch, part, plan, task, decisions, view_sha256, timeout=900,
                         supervisor_fallback=None, supervisor_state_dir=None):
        import hashlib
        path = self._task_checkpoint_path(worktree, shard, batch, part)
        data = json.loads(path.read_text("utf-8"))
        planned = self._task_of(worktree, plan, task)
        slices = planned["slices"]
        cands = [c for sl in slices for c in next(i for i in data["items"] if i["sense_id"] == sl["sense_id"])["candidates"][sl["start"]:sl["end"]]]
        saved = all(c["decision"] is not None for c in cands)
        text = self._task_view(data, planned)   # a task's own decisions never appear in its view
        if hashlib.sha256(text.encode("utf-8")).hexdigest() != view_sha256:
            return False, f"task {task} view changed since it was launched; not saved"
        body = (Path(worktree) / decisions).read_text("utf-8")
        self.save_calls.append(body)
        self.task_save_calls.append(task)
        rows = {}
        for line in body.split("\n")[1:]:
            if line.strip():
                rows.setdefault(line.split()[0], []).append(line.strip())
        count = len(cands)
        if supervisor_fallback is not None:
            self.technical_fallback_calls.append(dict(supervisor_fallback))
            alias = supervisor_fallback["alias"]
            if alias in rows:
                return False, "Supervisor fallback candidate must be omitted from model decisions"
            rows[alias] = [f"{alias} D f"]
        problems = []
        for alias, found in rows.items():
            n = int(alias[1:]) if alias[1:].isdigit() else 0
            if not 1 <= n <= count:
                problems.append(f"{alias}: names no candidate")
            elif len(found) > 1:
                problems.append(f"{alias} {cands[n - 1]['text']}: repeated decision row")
            elif " BAD" in found[0]:
                problems.append(f"{alias} {cands[n - 1]['text']}: relation field is malformed")
        problems += [f"c{n} {cands[n - 1]['text']}: chunk has missing decisions" for n in range(1, count + 1) if f"c{n}" not in rows]
        problems.sort(key=lambda p: int(p.split()[0][1:]) if p.split()[0][1:].isdigit() else 0)
        if problems:
            return False, f"chunk {task} not saved, checkpoint unchanged: {len(problems)} problem(s)\n" + "\n".join(problems)
        if saved:
            return True, "already_saved"
        for k, c in enumerate(cands):
            alias = f"c{k + 1}"
            c["decision"] = {"disposition": "drop", "reason": "f" if supervisor_fallback and supervisor_fallback["alias"] == alias else "x",
                             "row": rows[alias][0]}
        data["next_chunk_number"] += 1
        path.write_text(json.dumps(data), "utf-8")
        return True, f"Saved {count} decisions"

    def stage2_close_plan(self, worktree, shard, batch, part, plan, timeout=900):
        self.close_plan_calls.append((shard, batch, part))
        data = json.loads(self._task_checkpoint_path(worktree, shard, batch, part).read_text("utf-8"))
        if any(c["decision"] is None for i in data["items"] for c in i["candidates"]):
            raise GitError("admission-cli close-plan 실패: unsaved task(s)")

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

    def stage2_prepare_merge(self, worktree, shard, batch, part, relation_diff=None, *, refresh=False, timeout=900):
        self.stage2_prepare_merge_calls.append((shard, batch, part))
        self.stage2_prepare_merge_meta.append((relation_diff, refresh))
        path = Path(worktree) / ".warroom-scratch" / f"relation-admission-{shard}-{batch}-{part}.json"
        data = json.loads(path.read_text("utf-8"))
        data["premerge"] = {"status": "ready", "identity": f"{shard}/{batch}/{part}",
                            "relations": {"exists": False, "sha256": None},
                            "drops": {"exists": False, "sha256": None},
                            "relation_diff": ({"from": relation_diff[0], "to": relation_diff[1]}
                                              if relation_diff else None)}
        path.write_text(json.dumps(data), "utf-8")

    def stage2_preflight(self, worktree, shard, batch, part, timeout=900):
        self.stage2_preflight_calls.append((shard, batch, part))
        if self.stage2_preflight_reports:
            return self.stage2_preflight_reports.pop(0)
        return {"version": 1, "ok": True, "repairable": False, "shard": shard, "batch": batch,
                "part": part, "fingerprint": "a" * 64, "total": 0, "candidate_total": 0,
                "problems": [], "unclassified": [], "coverage": {}}

    def stage2_repair(self, worktree, shard, batch, part, repair, timeout=900, *, check=False):
        if check:
            self.stage2_repair_check_calls.append(repair)
            if self.stage2_repair_checker is not None:
                return self.stage2_repair_checker(repair)
            return {"version": 1, "ok": True, "already_applied": False, "repaired": 0, "normalized": [],
                    "invalid_candidates": []}
        if self.stage2_repair_apply_results:
            outcome = self.stage2_repair_apply_results.pop(0)
            if outcome is not None:
                return outcome
        self.stage2_repair_calls.append(repair)
        path = Path(worktree) / ".warroom-scratch" / f"relation-admission-{shard}-{batch}-{part}.json"
        data = json.loads(path.read_text("utf-8"))
        keys = sorted(f"{row['source_sense_id']}\u0000{row['candidate']}" for row in repair["decisions"])
        prior = next((receipt for receipt in data.get("repair_receipts", [])
                      if receipt["fingerprint"] == repair["fingerprint"] and receipt["candidate_keys"] == keys
                      and receipt["supervisor_nonce"] == repair["supervisor_nonce"]), None)
        if prior:
            for row in repair["decisions"]:
                item = next(item for item in data["items"] if item["sense_id"] == row["source_sense_id"])
                candidate = next(candidate for candidate in item["candidates"] if candidate["text"] == row["candidate"])
                expected = row["additional_relations"] if row["additional_relations"] is not None else row["decision"]
                actual = candidate.get("additional_relations") if row["additional_relations"] is not None else candidate.get("decision")
                if candidate.get("already_accounted") is not True and row["additional_relations"] is None:
                    continue
                if actual != expected:
                    raise GitError("repair receipt exists but its candidate state no longer matches")
            result = {"version": 1, "ok": True, "repaired": 0, "already_applied": True,
                      "request_id": prior["request_id"], "supervisor_nonce": repair["supervisor_nonce"],
                      "candidate_keys": keys}
            self.stage2_repair_results.append(result)
            return result
        for row in repair["decisions"]:
            item = next(item for item in data["items"] if item["sense_id"] == row["source_sense_id"])
            candidate = next(candidate for candidate in item["candidates"] if candidate["text"] == row["candidate"])
            if row["additional_relations"] is not None:
                candidate["additional_relations"] = row["additional_relations"]
            elif candidate.get("already_accounted") is not True:
                candidate["decision"] = row["decision"]
        data.setdefault("repair_receipts", []).append({"request_id": "c" * 64, "fingerprint": repair["fingerprint"],
                                                        "supervisor_nonce": repair["supervisor_nonce"],
                                                        "candidate_keys": keys})
        path.write_text(json.dumps(data), "utf-8")
        result = {"version": 1, "ok": True, "repaired": len(repair["decisions"]),
                  "already_applied": False, "request_id": "c" * 64,
                  "supervisor_nonce": repair["supervisor_nonce"], "candidate_keys": keys}
        self.stage2_repair_results.append(result)
        return result

    def stage2_amend(self, worktree, shard, batch, part, rel_input, *, timeout=900):
        """The official amend: writes the planned data files and reports their exact states (#6555)."""
        self.stage2_amend_calls.append((shard, batch, part, (Path(worktree) / rel_input).read_text("utf-8")))
        result = self.stage2_amend_results.pop(0) if self.stage2_amend_results else {"changes": {}}
        if isinstance(result, Exception):
            raise result
        checkpoint = f".warroom-scratch/relation-admission-{shard}-{batch}-{part}.json"
        if result["changes"]:   # a changed decision raises the revision and leaves recovery evidence, as the CLI does
            data = json.loads((Path(worktree) / checkpoint).read_text("utf-8"))
            data["amend_revision"] = data.get("amend_revision", 0) + 1
            (Path(worktree) / checkpoint).write_text(json.dumps(data), "utf-8")
            (Path(worktree) / checkpoint.replace(".json", ".amend-state.json")).write_text("{}", "utf-8")
        outputs = {checkpoint: hashlib.sha256((Path(worktree) / checkpoint).read_bytes()).hexdigest()}
        for rel, text in result["changes"].items():
            (Path(worktree) / rel).parent.mkdir(parents=True, exist_ok=True)
            (Path(worktree) / rel).write_text(text, "utf-8")
            outputs[rel] = hashlib.sha256(text.encode("utf-8")).hexdigest()
        self.dirty_text = "".join(f" M {rel}\n" for rel in result["changes"])
        return {"amended": True, "checkpoint": checkpoint, "outputs": outputs, "timing": ""}

    def verify_stage2_local(self, worktree, shard, batch, part, *, checkpoint, timeout=900):
        self.local_verify_calls.append((shard, batch, part, checkpoint))
        return self.local_verify_ok, "" if self.local_verify_ok else "local verify failed"

    def verify_stage2_exact(self, sha, shard, batch, part, timeout=900):
        self.exact_verify_calls.append((sha, shard, batch, part))
        return self.exact_verify_ok, "" if self.exact_verify_ok else "exact HEAD verify failed"

    def verify_stage2_exact_counts(self, sha, shard, batch, part, timeout=900):
        ok, detail = self.verify_stage2_exact(sha, shard, batch, part, timeout=timeout)
        return ok, detail, (dict(self.exact_counts) if ok and self.exact_counts is not None else None)

    def row_delta(self, base, head, shard):
        return dict(self.row_delta_result)

    def row_count(self, rev, rel):
        return self.row_counts.get(rel)

    def stage2_inspect(self, worktree, shard, batch, part, sense_ids, timeout=900, selection_path=None):
        self.inspect_calls.append((str(worktree), shard, batch, part, list(sense_ids)))
        if not hasattr(self, "inspect_selection_calls"):
            self.inspect_selection_calls = []
        self.inspect_selection_calls.append(selection_path)
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

    def fast_forward_open_pr(self, path, branch, pr_head_sha, protected_paths, *, recheck=None):
        path = Path(path)
        if self.registered(path) != branch:
            raise FastForwardBlocked("not the owned worktree")
        self.worktree_gitdir(path)
        if self.dirty(path).strip():
            raise FastForwardBlocked("dirty worktree")
        local = self.head(path)
        remote = self.remote_head(branch)
        if remote is None:
            raise FastForwardBlocked("remote branch missing")
        if remote != pr_head_sha:
            raise FastForwardRace("PR/remote mismatch")
        if local == pr_head_sha:
            return local
        if (local, pr_head_sha) not in self.fast_forward_ancestors:
            raise FastForwardBlocked("local is not ancestor")
        if set(self.fast_forward_changed_paths) & protected_paths:
            raise FastForwardBlocked("protected artifact changed")
        self.fast_forward_calls.append((str(path), branch, pr_head_sha, set(protected_paths)))
        if self.fast_forward_recheck_effect:
            self.fast_forward_recheck_effect()
        if recheck is not None:
            recheck()
        if self.remote_head(branch) != pr_head_sha:
            raise FastForwardRace("remote moved during recheck")
        if self.head(path) != local or self.dirty(path).strip():
            raise FastForwardBlocked("worktree changed during recheck")
        self.local_head = pr_head_sha
        return local

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
        before = self.local_head
        if (str(path), sha) not in self.integrated:
            self.integrated.append((str(path), sha))
        if self.integrate_updates_head:
            self.local_head = sha
            self.ancestor_pairs.add((before, sha))
        return self.local_head

    def verified_supervisor_integration(self, path, branch, base, old_head, new_head):
        self.integration_proof_calls.append((str(path), branch, base, old_head, new_head))
        return self.registered(path) == branch and self.head(path) == new_head and self.base_sha == new_head \
            and (str(path), new_head) in self.integrated and (old_head, new_head) in self.ancestor_pairs

    def contains(self, path, sha):
        return (str(path), sha) in self.integrated

    def push_approved_maintainer_integration(self, path, branch, pr_head_sha, batch_head_sha, merge_sha,
                                             protected_paths, *, recheck=None):
        if self.maintainer_sync_error:
            raise self.maintainer_sync_error
        path = Path(path)
        self.maintainer_sync_calls.append((str(path), branch, pr_head_sha, batch_head_sha, merge_sha,
                                           set(protected_paths)))
        if self.registered(path) != branch:
            raise IntegrationBlocked("not the owned worktree")
        self.worktree_gitdir(path)
        if self.dirty(path).strip():
            raise IntegrationBlocked("dirty worktree")
        local = self.head(path)
        if not self.contains(path, merge_sha):
            raise IntegrationBlocked("approved merge missing")
        if self.maintainer_changed_paths & set(protected_paths):
            raise IntegrationBlocked("protected artifact changed")
        remote = self.remote_head(branch)
        expected = {batch_head_sha, local}
        if pr_head_sha not in expected or remote not in expected:
            raise IntegrationBlocked("unexpected PR or remote HEAD")
        if remote != pr_head_sha:
            raise GitTransient("PR API / remote lag")
        if recheck is not None:
            recheck(pr_head_sha)
        if local != pr_head_sha:
            if remote != batch_head_sha:
                raise IntegrationBlocked("remote moved")
            self.maintainer_pushes.append((branch, pr_head_sha, local))
            self.remote[branch] = local
            if self.maintainer_after_push:
                self.maintainer_after_push(local)
            if recheck is not None:
                recheck(local)
        if self.remote_head(branch) != local or self.head(path) != local or self.dirty(path).strip():
            raise IntegrationBlocked("post-push verification failed")
        return local

    def create_worktree_at(self, path, branch, commit):
        self.create_worktree(path, branch, commit)
        self.local_head = commit
        self.integrated.append((str(path), commit))

    def is_ancestor(self, ancestor, descendant, *, path=None):
        return ancestor == descendant or (ancestor, descendant) in self.ancestor_pairs

    def commit_in_range(self, base, commit, head, *, path=None):
        return (base, commit, head) in self.commit_ranges or (
            self.is_ancestor(base, commit, path=path) and self.is_ancestor(commit, head, path=path))

    def changed_files(self, sha):
        return self.changed.get(sha, ["README.md"])   # default: a documentation-only fix

    def remove_diagnosis_worktree(self, path, branch, base_sha):
        if self.block:
            raise CleanupBlocked(self.block)
        if not Path(path).exists():
            return   # idempotent re-entry
        if self.dirty_text.strip() or self.local_head != base_sha:
            raise CleanupBlocked("dirty or moved")
        self.removed.append((str(path), branch))
        import shutil
        shutil.rmtree(path)
        self.reg.pop(str(path), None)

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
        self.pull_files_calls: list[int] = []
        self.latest_stage2_pr = None
        self.merged_stage3_prs: list[dict] = []
        self.merged_stage3_prs_calls = 0
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

    def maintainer_ci_failure(self, pr, head, branch):
        return getattr(self, "ci_failure", None)

    def maintainer_ci_diagnostic(self, event):
        return "Failed test identifiers: unavailable"

    def open_prs(self):
        return self.open

    def latest_stage2_production(self, base):
        return self.latest_stage2_pr

    def latest_stage3_production(self, base):
        self.merged_stage3_prs_calls += 1
        return self.merged_stage3_prs[-1] if self.merged_stage3_prs else None

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
                       "url": "", "merge_commit_sha": "", "title": title, "body": body, "base_ref": "master"}
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

    def reopen_issue(self, n):
        self.issues[n]["state"] = "open"

    def comment_issue(self, n, body):
        self.issue_comments_.setdefault(n, []).append({"body": body})

    def add_pr_reply(self, n, body, login="neverworkalone-agent"):
        comments = self.issue_comments_.setdefault(n, [])
        comment_id = max((int(comment.get("id", 0)) for comment in comments), default=0) + 1
        comments.append({"id": comment_id, "body": body, "user": {"login": login},
                         "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")})
        return comment_id

    def pull_files(self, n):
        self.pull_files_calls.append(n)
        if n in self.files:
            files = self.files[n]
        else:
            # A branch-linked fake PR represents the normal producer output unless a test supplies another file list.
            branch = self.pull(n).get("head_ref", "")
            parts = branch.split("-")
            if len(parts) >= 7 and parts[:2] == ["s2", "reconcile"] and re.fullmatch(r"\d{3}", parts[-4]):
                shard = parts[-4]
                files = [{"path": f"data/relation-drops/drop-{shard}.jsonl"}]
            elif len(parts) >= 5 and parts[0] == "s2" and re.fullmatch(r"\d{3}", parts[-3]):
                shard = parts[-3]
                files = [{"path": f"data/relations/relation-{shard}.jsonl"}]
            elif len(parts) >= 3 and parts[0] == "s3" and re.fullmatch(r"\d{3}", parts[-1]):
                shard = parts[-1]
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


class _WorldTmp(tempfile.TemporaryDirectory):
    """World's tmp dir: every exit path (tearDown, addCleanup, a test's own cleanup(), `with`) closes the World's idle
    anchors before the directory is deleted."""

    def __init__(self):
        super().__init__()
        self.anchors = []

    def cleanup(self):
        anchors, self.anchors = self.anchors, []
        for conn in anchors:
            conn.close()
        super().cleanup()


class World:
    # Test-only speed-up (#3801): an idle sqlite3 connection (never queried) on the Store's DB, so the per-call
    # connections of Store._conn() are not the last close (no WAL checkpoint/-wal delete on each).

    @property
    def store(self):
        return self._store

    @store.setter
    def store(self, store):   # a test re-creating the Store gets its own anchor, all closed before tmp is deleted
        self._store = store
        anchor = sqlite3.connect(store.path, timeout=30, check_same_thread=False)
        anchor.execute("PRAGMA journal_mode=WAL")   # joins the WAL (opens -shm); no query or transaction ever runs
        self.tmp.anchors.append(anchor)

    def __init__(self, models=None):
        self.tmp = _WorldTmp()
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

    parallel_s2 = False   # the serial Stage 2 path stays covered; test_issue_3047 turns the parallel path on
    parallel_s3 = False   # likewise the serial Stage 3 path; test_issue_3149 turns the parallel path on
    parallel_c = False    # likewise the serial C path; test_issue_3076 turns the parallel path on
    intake = False        # autonomous ERROR intake (#3349) is off here so legacy tests keep observing their plain ERROR

    def make_sup(self):
        sup = Supervisor(self.paths, self.cfg, self.store, self.runner_obj(), self.adapter,
                         self.gh, self.git, {"GH_CONFIG_DIR": "x"}, clock=lambda: self.now)
        sup.parallel_new_parts = self.parallel_s2
        sup.parallel_new_c = self.parallel_c
        sup.parallel_new_s3 = self.parallel_s3
        if not self.intake:
            sup.maint._intake_errors = lambda: None
        return sup

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

