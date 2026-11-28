"""Issue #9928: Stage 4 is registered on the shared refinement line by spec, rule and prompts only."""
import json
import unittest
from pathlib import Path
from unittest import mock

from tests.fakes import World, assign_profiles
from warroom import prompts, refine, s3parallel, stage3, stage4
from warroom.adapters import RunSpec
from warroom.store import STAGE3_METHOD

S4_RELATION, S4_DROP = "data/relations/relation-001.jsonl", "data/relation-drops/drop-001.jsonl"
OTHER = "data/relations/relation-007.jsonl"


def world(test):
    w = World()
    test.addCleanup(w.tmp.cleanup)
    w.cfg["producers"] = {"codex": {"label": "Sol", "adapter": "codex", "model": "gpt-x", "effort": "high"}}
    assign_profiles(w.cfg)
    w.cfg["model_profiles"]["sol"] = {"adapter": "codex", "model": "gpt-6.1-sol", "effort": "medium",
                                      "permission_profile": "worktree"}
    w.cfg["assignments"]["stage4"] = {"codex": "sol"}
    return w


def view(senses):
    """A stripped Stage 4 chunk view: `senses` is [(record_id, [dir, ...]), ...]."""
    out, n = [], 0
    for index, (record, dirs) in enumerate(senses, start=1):
        rels = []
        for direction in dirs:
            n += 1
            rels.append({"n": n, "dir": direction, "type": "near", "tier": 3})
        out.append({"n": index, "record_id": record, "sense_id": f"{record}-s{index}", "relations": rels})
    return {"chunk": "001", "total_chunks": 1, "sense_count": len(out), "relation_count": n, "senses": out}


class Stage4Registration(unittest.TestCase):
    def setUp(self):
        self.w = world(self)
        self.assertTrue(self.w.store.start_stage3("codex", "continuous")[0])

    def start(self):
        with mock.patch.object(self.w.sup, "_prepare_existing") as prepare:
            self.w.sup._prepare_new_stage3(dict(self.w.store.line("codex", STAGE3_METHOD)))
        return prepare

    def test_stage4_follows_stage3_per_shard_on_its_own_profile_and_continues_over_no_change_shards(self):
        w = self.w
        self.assertEqual([spec.id for spec in refine.stages(STAGE3_METHOD)], ["s3", "s4"])   # the Refinement line
        w.gh.merged_stage3_prs = [{"title": "[S3/Sol] 427", "merge_commit_sha": w.git.base_sha}]
        w.store.set(stage3.ok_key("001"), w.git.base_sha)
        self.start()
        latest = w.store.latest_batch("codex", STAGE3_METHOD)
        self.assertTrue(latest is None or latest["batch"] == "all", "Stage 3 is not done: no Stage 4")

        w.gh.merged_stage3_prs = [{"title": "[S3/Sol] 428", "merge_commit_sha": w.git.base_sha}]

        w.store.set(stage3.ok_key("428"), w.git.base_sha)   # its recorded final-shard completion
        self.assertTrue(w.store.start_stage3("codex", "continuous")[0])
        # Shards 001-002 completed without changes (no PR); the next selection is 003, gated on its Stage 3 success.
        w.store.set(stage4.SPEC.nochange_key("001"), w.git.base_sha)
        w.store.set(stage4.SPEC.nochange_key("002"), w.git.base_sha)
        self.start().assert_not_called()   # shard 003 has no Stage 3 success yet: the line ends
        self.assertEqual(w.store.line("codex", STAGE3_METHOD)["run"], 0)
        w.store.set(stage3.ok_key("003"), w.git.base_sha)
        self.assertTrue(w.store.start_stage3("codex", "continuous")[0])
        self.start().assert_called_once()
        b = w.store.latest_batch("codex", STAGE3_METHOD)
        self.assertEqual((b["shard"], b["batch"], b["branch"]), ("003", "s4", "s4-codex-003"))
        self.assertIs(refine.spec_for(b), stage4.SPEC)
        self.assertEqual(w.sup._run(b), RunSpec("gpt-6.1-sol", "medium", "worktree"))
        round_ = s3parallel._Round(w.sup.s3p, b)
        self.assertIsNone(round_.preflight())
        self.assertEqual(round_.run, w.sup._run(b), "the parallel round spawns exactly the Stage 4 profile")

    def test_missing_stage4_assignment_blocks_only_stage4(self):
        w = self.w
        del w.cfg["assignments"]["stage4"]
        w.gh.merged_stage3_prs = [{"title": "[S3/Sol] 428", "merge_commit_sha": w.git.base_sha}]
        w.store.set(stage3.ok_key("428"), w.git.base_sha)   # its recorded final-shard completion
        w.store.set(stage3.ok_key("001"), w.git.base_sha)
        self.start().assert_not_called()
        self.assertIn("Stage 4", w.store.line("codex", STAGE3_METHOD)["blocked"])

    def test_scope_prompts_and_answer_rule(self):
        spec = stage4.SPEC
        other_drop = "data/relation-drops/drop-007.jsonl"
        # #9929: Relation-only — any shard's Relation file, never a Drop file.
        self.assertTrue(spec.relations_only)
        self.assertEqual(spec.scope("001", [OTHER, other_drop, S4_DROP, "README.md"]), {S4_RELATION, OTHER})
        self.assertEqual(stage3.SPEC.scope("001", [OTHER]), {S4_RELATION, S4_DROP}, "Stage 3 keeps its two files")
        pr = {"number": 5, "title": "[S4/Sol] 001", "body": "Refs #9929", "base_ref": "master"}
        self.assertEqual(refine.ops_for(spec).validate_pr(pr, [{"path": OTHER}]), "001", "a reverse-only PR is valid")
        for path in ("README.md", S4_DROP, other_drop):
            with self.assertRaises(refine.RefineError):
                refine.ops_for(spec).validate_pr(pr, [{"path": S4_RELATION}, {"path": path}])
        for name in ("s4_chunk", "s4_fix", "s4_policy_card"):
            self.assertTrue((prompts.PROMPT_DIR / f"{name}.md").read_text("utf-8").strip())

        context = stage4.decision_context(view([("w1", ["F", "R"]), ("w1", ["X"]), ("w2", [])]), "001")
        normalized, warnings = stage4.normalize_decisions(
            "chunk 001\nD 1 7\nC 2 mood 4\nC 2 scene 4\nA 3 \"적적함\" mood 3\nM 3 1\nM 2 3\nprose", "001", context)
        self.assertEqual(normalized, "chunk 001\nA 3 \"적적함\" mood 3\nD 1\nM 3 1\n")
        self.assertEqual(len(warnings), 4)
        with self.assertRaises(refine.NoJudgment):   # nothing usable is never an implicit Keep-all
            stage4.normalize_decisions("chunk 001\nD 99\nprose", "001", context)
        with self.assertRaises(refine.NoJudgment):
            stage4.normalize_decisions("chunk 001\nskip 1 2 3", "001", context)
        with self.assertRaises(refine.NoJudgment):
            stage4.normalize_decisions("chunk 001\nskip 3\nD 1", "001", context)
        with self.assertRaises(refine.RefineError):
            stage4.decision_text("chunk 001\nskip 1", "001")
        self.assertEqual(stage4.normalize_decisions("chunk 001\nnone", "001", context)[0], "chunk 001\nnone\n")
        normalized, warnings = stage4.normalize_decisions("chunk 001\nM 3 w1-s4\nM 2 w2-s1", "001", context)
        self.assertEqual(normalized, "chunk 001\nM 3 w1-s4\n")
        self.assertEqual(len(warnings), 1)
        self.assertEqual(stage4.decision_text(normalized, "001"), normalized)


class Stage4Finalize(unittest.TestCase):
    def setUp(self):
        self.w = world(self)
        path = self.w.paths.worktrees / "s4-001"
        path.mkdir(parents=True)
        self.w.git.reg[str(path)] = "s4-codex-001"
        bid = self.w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="s4",
                                        branch="s4-codex-001", worktree=str(path))
        self.w.store.update(bid, state="PRODUCING", run_kind="s3_finalize")
        self.b = self.w.store.batch(bid)
        self.ops = refine.ops_for(stage4.SPEC)
        self.w.gh.issues[9929] = {"state": "open", "labels": ["batch"], "title": "Stage 4", "body": ""}

    def finalize(self, applied):
        cp = {"version": 1, "shard": "001", "chunk_total": 1, "completed_chunks": ["001"], "decisions": []}
        with mock.patch.object(self.ops, "checkpoint", side_effect=[cp, None, None, None]), \
                mock.patch.object(self.ops, "apply", side_effect=applied), \
                mock.patch.object(self.ops, "report", return_value={"shard": "001"}):
            self.w.sup._stage3_finalize_do(self.w.store.batch(self.b["id"]))
        return self.w.store.batch(self.b["id"])

    def test_cross_shard_pr_commits_other_shard_files_and_verifies_affected_shards_once(self):
        w = self.w

        def applied(*_args):
            w.git.dirty_text = f" M {OTHER}\n"   # a reverse-only edit: the produced shard's files are unchanged
            return {"status": "applied", "selection": {"p": 5, "s": 3, "e": 1},
                    "senses": {"total": 9, "skipped": 3, "excluded": 1, "polished": 4, "policy_skipped": 1},
                    "decisions": {"add": 0, "drop": 1, "set": 0, "rebind": 0}, "affected_shards": ["001", "007"],
                    "conflicts": []}
        b = self.finalize(applied)
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self.assertEqual(w.git.commits, [([OTHER], "[S4/Sol] 001")])
        self.assertEqual(len(w.git.refine_verify_calls), 1)
        self.assertEqual(w.git.refine_verify_calls[0][1:3], ("scripts/relation/s4-cli.mjs", "001"))
        body = w.gh.created_prs[0]["body"]
        self.assertIn("Refs #9929", body)
        self.assertIn("- Senses: 9 (input p 5, s 3, e 1; Polish 4, Policy Skip 1)", body)
        self.assertIn("- Affected Shards: 001, 007", body)

    def test_zero_chunk_shard_completes_without_ai_commit_or_pr_and_resumes_cleanup(self):
        w = self.w
        w.runner.s4.chunks = 0
        applied = {"status": "no-change", "selection": {"p": 0, "s": 8, "e": 1},
                   "senses": {"total": 9, "skipped": 8, "excluded": 1, "polished": 0, "policy_skipped": 0},
                   "affected_shards": ["001"], "changed_files": []}
        with mock.patch.object(self.ops, "apply", return_value=applied), \
                mock.patch.object(self.ops, "report", return_value={"shard": "001"}):
            w.sup.s3p.begin(self.b)
        b = w.store.batch(self.b["id"])
        self.assertEqual(b["state"], "CLEANUP", b["error"])
        self.assertEqual(w.adapter.launches, [])
        self.assertEqual(w.store.task_rows(b["id"]), [])
        self.assertEqual((getattr(w.git, "commits", []), getattr(w.gh, "created_prs", [])), ([], []))
        head = w.git.local_head
        self.assertEqual(w.store.get(stage4.SPEC.nochange_key("001")), head)
        self.assertEqual(w.store.get(stage4.SPEC.ok_key("001")), head)
        # A restart before cleanup re-enters CLEANUP only: no AI run and no re-apply.
        w.sup._cleanup(w.store.batch(b["id"]))
        self.assertEqual(w.store.batch(b["id"])["state"], "COMPLETE")
        self.assertEqual(w.git.removed, [(str(self.w.paths.worktrees / "s4-001"), "s4-codex-001")])

    def test_a_stop_between_the_data_commit_and_its_key_submits_that_commit_not_a_no_change(self):
        """#10345: a restart over our own clean data commit recovers it and opens its PR; no S4 completion is recorded."""
        w, commit_key = self.w, f"s3_commit_head_{self.b['id']}"
        set_key = w.store.set

        def interrupted(key, value):
            if key == commit_key:
                raise RuntimeError("stopped after commit")
            return set_key(key, value)

        def applied(*_args):
            w.git.dirty_text = f" M {S4_RELATION}\n"
            return {"status": "applied", "senses": {}, "affected_shards": ["001"], "conflicts": []}
        with mock.patch.object(w.store, "set", side_effect=interrupted):
            self.assertEqual(self.finalize(applied)["state"], "ERROR")
        produced = w.git.local_head
        self.assertEqual((w.store.get(commit_key), w.git.dirty_text), (None, ""))
        w.store.update(self.b["id"], state="PRODUCING", error=None)
        with mock.patch.object(self.ops, "checkpoint", return_value=None), \
                mock.patch.object(self.ops, "report", return_value={"shard": "001"}):
            w.sup._stage3_finalize_do(w.store.batch(self.b["id"]))
        b = w.store.batch(self.b["id"])
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self.assertEqual(w.git.commits, [([S4_RELATION], "[S4/Sol] 001")])
        self.assertEqual((w.store.get(commit_key), w.git.remote["s4-codex-001"]), (produced, produced))
        self.assertEqual(len(w.gh.created_prs), 1)
        self.assertIsNone(w.store.get(stage4.SPEC.nochange_key("001")))
        self.assertIsNone(w.store.get(stage4.SPEC.ok_key("001")))

    def test_a_failed_no_change_verify_records_nothing(self):
        w = self.w
        w.git.refine_verify_fail = ("001",)
        b = self.finalize(lambda *_args: {"status": "no-change", "senses": {}, "affected_shards": ["001"]})
        self.assertEqual(b["state"], "ERROR")
        self.assertIsNone(w.store.get(stage4.SPEC.nochange_key("001")))


class Stage4RelationReplay(unittest.TestCase):
    """#9929: a conflicting S4 PR is replayed Relation-only; Stage 3 keeps the Candidate/Drop replay."""

    def replay(self, tag):
        w = world(self)
        path = w.paths.worktrees / f"{tag}-001"
        path.mkdir(parents=True)
        branch = f"{tag}-codex-001"
        w.git.reg[str(path)] = branch
        head, w.git.base_sha = "a" * 40, "b" * 40
        w.git.local_head, w.git.remote[branch] = head, head
        bid = w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch=tag, branch=branch,
                                   worktree=str(path))
        w.store.update(bid, state="WAITING_REVIEW", pr_number=60, head_sha=head)
        w.gh.prs[60] = {"number": 60, "head_sha": head, "head_ref": branch, "state": "open", "merged": False,
                        "base_ref": w.cfg["base_branch"], "base_sha": w.git.base_sha}
        w.gh.files[60] = [{"path": S4_RELATION}, {"path": OTHER}]
        info = {"base_ref": w.cfg["base_branch"], "base_sha": w.git.base_sha, "head_sha": head}
        merged = mock.Mock(return_value=("c" * 40, {"ok": True, "files": []}))
        with mock.patch.object(w.git, "replay_relation_merge", merged, create=True), \
                mock.patch.object(w.sup, "_refine_verify", return_value=(True, "")):
            w.sup._replay_relation_pr(w.store.batch(bid), info)
        self.assertEqual(w.store.batch(bid)["error"] or "", "")
        return merged.call_args

    def test_stage4_passes_relations_only_and_owns_relation_files_only(self):
        call = self.replay("s4")
        self.assertIs(call.kwargs["relations_only"], True)
        self.assertEqual(call.args[4], {S4_RELATION, OTHER})

    def test_stage3_keeps_the_default_replay(self):
        call = self.replay("all")
        self.assertIs(call.kwargs["relations_only"], False)
        self.assertEqual(call.args[4], {S4_RELATION, S4_DROP})


class Stage4PolicySkip(unittest.TestCase):
    """#10047: a refusal binds to Canonical records; only a confirmed record is skipped, everything else continues."""
    MESSAGE = ("Invalid prompt: your prompt was flagged as potentially violating our usage policy. "
               "Please try again with a different prompt: "
               "https://platform.openai.com/docs/guides/reasoning#advice-on-prompting")

    def setUp(self):
        from warroom.adapters import CodexCLIAdapter
        w = self.w = world(self)
        w.cfg["refine_max_parallel"] = 16
        w.adapter.confirmed_prompt_refusal = CodexCLIAdapter().confirmed_prompt_refusal
        w.runner.s4.chunks = 3
        w.runner.s4.layout = {"001": ["w1", "w2", "w3"], "002": ["w9"], "003": ["w5"]}
        path = w.paths.worktrees / "s4-001"
        path.mkdir(parents=True)
        w.git.reg[str(path)] = "s4-codex-001"
        self.bid = w.store.create_batch(method=STAGE3_METHOD, producer="codex", shard="001", batch="s4",
                                        branch="s4-codex-001", worktree=str(path))
        w.store.set(stage3.mode_key(self.bid), stage3.PARALLEL)
        w.store.update(self.bid, state="PRODUCING", run_kind=s3parallel.RUN_KIND)
        w.sup.s3p.poll(w.store.batch(self.bid))

    def tick(self, n=1):
        for _ in range(n):
            b = self.w.store.batch(self.bid)
            if b["state"] == "PRODUCING":
                self.w.sup.s3p.poll(b)

    def states(self):
        return {r["task"]: r["state"] for r in self.w.store.task_rows(self.bid)}

    def finish(self, task, text, code=0):
        w, row = self.w, self.w.store.task_row(self.bid, task)
        log = Path(w.store.run(row["run_id"])["log_file"])
        pid = next(x["pid"] for x in w.adapter.launches if w.adapter.running.get(x["pid"], {}).get("log") == log)
        w.adapter.running[pid].update(code=code, text=text)
        w.adapter.finish(pid)

    def answer(self, task, text):
        self.finish(task, json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n")

    def refuse(self, task):
        events = [{"type": "thread.started", "thread_id": "t"}, {"type": "turn.started"},
                  {"type": "turn.failed", "error": {"message": self.MESSAGE}}]
        self.finish(task, "".join(json.dumps(e) + "\n" for e in events), code=1)

    def issues(self, kind):
        return [r for r in self.w.store.issue_requests() if kind in r["title"]]

    def test_a_mixed_chunk_saves_answered_records_and_skips_only_the_refused_record(self):
        w = self.w
        self.refuse("001")
        self.refuse("002")   # a single-record chunk is already bound: no record run
        self.tick()
        self.assertEqual(self.states()["001"], "SPLIT")
        self.assertEqual({t: s for t, s in self.states().items() if t.startswith("001-")},
                         {"001-w1": "RUNNING", "001-w2": "RUNNING", "001-w3": "RUNNING"})
        self.answer("001-w1", "chunk 001\nD 1")
        self.refuse("001-w2")
        self.answer("001-w3", "chunk 001\nnone")
        self.answer("003", "chunk 003\nnone")
        self.tick(2)
        s4 = w.runner.s4
        self.assertEqual(s4.saved["001"], "chunk 001\nD 1\nP w2\n")
        self.assertEqual(s4.saved["002"], "chunk 002\nP w9\n")
        self.assertEqual(s4.saved["003"], "chunk 003\nnone\n")
        self.assertEqual({t: s for t, s in self.states().items() if "-" in t},
                         {"001-w1": "MERGED", "001-w2": "MERGED", "001-w3": "MERGED", "002-w9": "MERGED"})
        requests = self.issues("Policy Skip")
        self.assertEqual(sorted(r["title"] for r in requests), ["[Policy Skip][S4/codex] 001 Chunk 001",
                                                                 "[Policy Skip][S4/codex] 001 Chunk 002"])
        self.assertIn("w2\t말w2\tSense 1\tw2-s1", next(r["body"] for r in requests if r["title"].endswith("001")))
        self.assertEqual(len(w.adapter.launches), 6, "three chunks and three record runs, nothing resubmitted")

    def test_all_none_records_save_none_without_an_issue_and_a_composition_restart_is_idempotent(self):
        w = self.w
        self.refuse("001")
        self.tick()
        for record in ("w1", "w2", "w3"):
            self.answer(f"001-{record}", "chunk 001\nnone")
        with mock.patch.object(s3parallel.ParallelStage3, "_save_task"):   # stop right after the composition
            self.tick()
        self.assertEqual(self.states()["001"], "RESPONDED")
        for record in ("w1", "w2"):   # a crash before every MERGED mark was written
            w.store.update_task(self.bid, f"001-{record}", state="RESPONDED")
        self.tick()
        self.assertEqual(w.runner.s4.saved["001"], "chunk 001\nnone\n")
        self.assertEqual(self.states()["001"], "SAVED")
        self.assertTrue(all(s == "MERGED" for t, s in self.states().items() if t.startswith("001-")))
        self.assertEqual(self.issues("Policy Skip"), [])
        self.assertEqual(len(w.adapter.launches), 6)

    def test_an_unresolved_record_holds_its_chunk_without_a_retry_while_other_chunks_complete(self):
        w = self.w
        self.refuse("001")
        self.tick()
        self.answer("001-w1", "chunk 001\nD 1")
        self.finish("001-w2", "plain failure\n", code=1)   # no judgment and no official refusal: HELD, never re-run
        self.tick()
        self.assertEqual(self.states()["001-w2"], "HELD")
        self.assertEqual(self.states()["001"], "HELD")
        self.answer("001-w3", "chunk 001\nnone")
        self.answer("002", "chunk 002\nnone")
        self.answer("003", "chunk 003\nnone")
        self.tick(3)
        self.assertEqual(sorted(w.runner.s4.saves), ["002", "003"], "sibling chunks are saved, the held one is not")
        self.assertTrue(all(s == "HELD" for t, s in self.states().items() if t.startswith("001")))
        b = w.store.batch(self.bid)
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("001", b["error"])
        self.assertEqual(len(self.issues("Policy Hold")), 1)
        self.assertEqual(self.issues("Policy Skip"), [])
        self.assertEqual(len(w.adapter.launches), 6)


if __name__ == "__main__":
    unittest.main()
