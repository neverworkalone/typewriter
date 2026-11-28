"""Issue #10171: the Drop line (D1) runs the refinement engine beside the Refinement line, Relation-only.
#10330: D1 SSS edits its own Relation file only. #10517: D1 never waits for Stage 4; only its first shard checks Stage 3."""
import json
import unittest
from unittest import mock

from tests.fakes import World, assign_profiles
from warroom import batches, control, github, prbody, refine, stage3, stage4, stage_d1
from warroom.refine import NoJudgment, RefineError
from warroom.store import DROP_METHOD, STAGE3_METHOD, LineBusy

REL = lambda shard: {"path": f"data/relations/relation-{shard}.jsonl"}
DROP = lambda shard: {"path": f"data/relation-drops/drop-{shard}.jsonl"}


def world(test):
    w = World()
    test.addCleanup(w.tmp.cleanup)
    w.cfg["producers"] = {"codex": {"label": "Sol", "adapter": "codex", "model": "gpt-x", "effort": "high"}}
    assign_profiles(w.cfg)
    w.cfg["model_profiles"]["sol"] = {"adapter": "codex", "model": "gpt-6.1-sol", "effort": "medium",
                                      "permission_profile": "worktree"}
    w.cfg["assignments"]["stage4"] = {"codex": "sol"}
    w.cfg["assignments"]["d1"] = {"codex": "sol"}
    return w


def pr(number, title, issue, files):
    return {"number": number, "title": title, "body": f"Refs #{issue}", "files": files, "headRefName": f"b{number}",
            "baseRefName": "master"}


def view(records):
    """A D1 chunk view: `records` is [(record_id, sense count), ...]."""
    senses, n = [], 0
    for record, count in records:
        for index in range(1, count + 1):
            n += 1
            senses.append({"n": n, "lemma": f"말{record}", "homograph": None, "pos": "noun", "gloss": f"뜻 {n}.",
                           "record_id": record, "sense_id": f"{record}-s{index}", "relations": []})
    return {"chunk": "001", "total_chunks": 2, "sense_count": n, "relation_count": 0, "senses": senses}


class DropLineRegistration(unittest.TestCase):
    def test_d1_is_the_drop_line_stage_own_file_only_and_only_its_first_shard_checks_every_stage3(self):
        self.assertEqual([spec.id for spec in refine.stages(DROP_METHOD)], ["d1"])
        self.assertEqual([spec.id for spec in refine.stages(STAGE3_METHOD)], ["s3", "s4"])
        spec = stage_d1.SPEC
        self.assertEqual((spec.method, spec.role, spec.issue, spec.cli), (DROP_METHOD, "d1", 10171, "scripts/relation/d1-cli.mjs"))
        self.assertTrue(spec.relations_only and spec.verify_judgments and spec.refusal_records and spec.cli_verify)
        self.assertFalse(spec.cross_shard, "#10330: D1 SSS edits relation-SSS.jsonl only")
        self.assertEqual(spec.scope("001", ["data/relations/relation-007.jsonl", "data/relation-drops/drop-007.jsonl"]),
                         {"data/relations/relation-001.jsonl"})
        kv = {stage3.ok_key(f"{n:03d}"): "x" for n in range(1, 428)}
        self.assertFalse(spec.gate(kv, "001"), "D1 001 waits for the whole factory's Stage 3, not one shard's")
        kv[stage3.ok_key("428")] = "x"
        self.assertTrue(spec.gate(kv, "001"), "#10517: no Stage 4 completion is needed")
        self.assertTrue(spec.gate({}, "002"), "a successor shard reads no Stage 3 or Stage 4 completion")
        self.assertEqual(control.method_label(DROP_METHOD), "Drop")

    def test_answer_grammar_keeps_d_n_h_lines_for_the_strict_cli_and_never_fills_in(self):
        context = stage_d1.decision_context(view([("w1", 2), ("w2", 1)]), "001")
        self.assertEqual(stage_d1.decision_text("chunk 001\nD 1 4\nN 2\nH 3\n", "001"), "chunk 001\nD 1 4\nN 2\nH 3\n")
        for bad in ("chunk 001\nD 1 12\n", "chunk 001\nnone\n", "chunk 001\nK 1\n", "chunk 002\nN 1\n"):
            with self.assertRaises(RefineError):
                stage_d1.decision_text(bad, "001")
        text, warnings = stage_d1.normalize_decisions("chunk 001\nD  1  4\nfoo\nN 2\n", "001", context)
        # Sense 3 has no verdict: kept for the CLI's strict save to refuse, never filled with N/H/P here.
        self.assertEqual(text, "chunk 001\nD 1 4\nN 2\n")
        self.assertEqual(len(warnings), 1)
        with self.assertRaises(NoJudgment):
            stage_d1.normalize_decisions("chunk 001\nmaybe\n", "001", context)
        prompt = "chunk 001/002 senses 3\nW\t말w1\t-\nS1\tnoun\t뜻 1.\nS2\tnoun\t뜻 2.\nW\t말w2\t-\nS3\tnoun\t뜻 3."
        stage_d1.validate_prompt_view(prompt, context, 2)
        with self.assertRaises(RefineError):
            stage_d1.validate_prompt_view(prompt.replace("S3", "S4"), context, 2)
        record = {**view([("w1", 2), ("w2", 1)]), "record": "w2", "sense_count": 1}
        record["senses"] = record["senses"][2:]
        self.assertEqual(stage_d1.decision_context(record, "001", "w2")["senses"], [{"n": 3, "record_id": "w2"}])

    def test_the_pr_body_reports_the_judgment_counts_and_removals(self):
        body = prbody.d1_body("Sol", "001", result={
            "senses": {"skip_senses": 702, "judged": 701, "no_relations": 1, "dropped": 483, "not_target": 210, "held": 8,
                       "policy_skipped": 0, "by_category": {"1": 300, "8": 183}},
            "removed_relations": 14660, "chunks_done": 8, "chunks_total": 8,
            "changed_files": ["data/relations/relation-001.jsonl", "data/relations/relation-002.jsonl"]}, cost="1h")
        for line in ("- Method: D1", "- Completed Chunks: 8/8",
                     "- Skip Senses: 702 (judged 701, no Relation 1; D 483, N 210, H 8, Policy Skip 0)",
                     "- D by Category: 1: 300, 8: 183", "- Removed Relations: 14660", "- Changed Files: 2 (2 shards)",
                     "- D1 Deletion Verify: PASS", "Refs #10171"):
            self.assertIn(line, body)
        self.assertRegex(stage_d1.SPEC.title_for("Sol", "001"), prbody.D1_TITLE)


class TwoLines(unittest.TestCase):
    """The Refinement and Drop lines run beside each other; each still holds one shard at a time."""

    def setUp(self):
        self.w = world(self)

    def test_a_drop_batch_starts_while_a_stage4_batch_runs_and_each_line_keeps_one_shard(self):
        store = self.w.store
        store.create_batch(method=STAGE3_METHOD, producer="codex", shard="005", batch="s4", branch="s4-codex-005",
                           worktree="/w/s4-005")
        self.assertTrue(store.start_stage3("codex", "continuous", DROP_METHOD)[0])
        store.create_batch(method=DROP_METHOD, producer="codex", shard="005", batch="d1", branch="d1-codex-005",
                           worktree="/w/d1-005")
        with self.assertRaises(LineBusy):
            store.create_batch(method=DROP_METHOD, producer="claude", shard="006", batch="d1", branch="d1-claude-006",
                               worktree="/w/d1-006")
        self.assertFalse(store.start_stage3("codex", "continuous", DROP_METHOD)[0], "the Drop line is held")
        self.assertIn((("codex", DROP_METHOD)), control.board_line_keys(store, self.w.cfg))

    def test_another_lines_relation_only_pr_occupies_nothing_but_this_lines_open_pr_holds_its_shard(self):
        s4 = pr(1, "[S4/Sol] 005", 9929, [REL("005"), REL("006")])
        d1 = pr(2, "[D1/Sol] 007", 10171, [REL("008")])
        mixed = pr(3, "[S4/Sol] 009", 9929, [REL("009"), DROP("009")])
        self.assertEqual(batches.pr_line_shards(s4, DROP_METHOD), set())
        self.assertEqual(batches.pr_line_shards(s4, STAGE3_METHOD), {"005", "006"})
        self.assertEqual(batches.pr_line_shards(d1, DROP_METHOD), {"007", "008"}, "its title shard too, without a batch")
        self.assertEqual(batches.pr_line_shards(d1, STAGE3_METHOD), set())
        self.assertEqual(batches.pr_line_shards(mixed, DROP_METHOD), {"009"}, "not a Relation-only PR: file rule")
        with self.assertRaises(batches.BatchError):
            batches.pr_line_shards({"number": 4, "title": "x", "body": "", "files": None}, DROP_METHOD)

    def choose(self, open_prs, stage3_done=428):
        store = self.w.store
        for n in range(1, stage3_done + 1):
            store.set(stage3.ok_key(f"{n:03d}"), "x")
        return refine.ops_for(stage_d1.SPEC).choose(kv=store, open_prs=open_prs, stage2_batches=[], stage3_batches=[],
                                                    latest_pr=None)

    def test_d1_selection_ignores_open_stage4_prs_and_waits_for_its_own(self):
        self.assertEqual(self.choose([pr(1, "[S4/Sol] 002", 9929, [REL("002")])]).shard, "001")
        self.assertEqual(self.choose([pr(2, "[D1/Sol] 001", 10171, [REL("003")])]).status, "wait")

    def test_d1_001_needs_every_stage3_but_no_stage4(self):
        # #10517: no s4_ok at all, and the same shard's S4 PR open (in review or CI): D1 001 still starts.
        self.assertEqual(self.choose([]).shard, "001")
        self.assertEqual(self.choose([pr(1, "[S4/Sol] 001", 9929, [REL("001")])]).shard, "001")
        self.assertEqual(self.choose([pr(3, "[D1/Luna Pilot] Shard 001", 10171, [REL("001")])]).status, "wait",
                         "D1's own PR still holds its shard")

    def test_d1_001_ends_unready_without_every_stage3(self):
        self.assertEqual(self.choose([], stage3_done=427).status, "unready")


class IndependentOfStage4(unittest.TestCase):
    """#10517: the real Drop line selection on a re-created Supervisor over the same DB."""

    def setUp(self):
        self.w = world(self)

    def start(self):
        w = self.w
        self.assertTrue(w.store.start_stage3("codex", "continuous", DROP_METHOD)[0])
        w.sup = w.make_sup()
        read, get = [], w.store.get

        def spy(key, *args, **kwargs):
            read.append(key)
            return get(key, *args, **kwargs)

        with mock.patch.object(w.store, "get", side_effect=spy), mock.patch.object(w.sup, "_prepare_existing"):
            w.sup._prepare_new_stage3(dict(w.store.line("codex", DROP_METHOD)))
        completion = (stage3.ok_key("001")[:-3], stage4.SPEC.ok_key("001")[:-3])
        return w.store.latest_batch("codex", DROP_METHOD), [key for key in read if key.startswith(completion)]

    def test_first_shard_starts_on_every_stage3_with_an_open_stage4_of_the_same_shard(self):
        w = self.w
        for n in range(1, 429):
            w.store.set(stage3.ok_key(f"{n:03d}"), "x")
        w.gh.open = [pr(1, "[S4/Sol] 001", 9929, [REL("001")])]
        b, _ = self.start()
        self.assertEqual((b["shard"], b["batch"]), ("001", "d1"))

    def test_first_shard_without_every_stage3_ends_the_line(self):
        w = self.w
        for n in range(1, 428):
            w.store.set(stage3.ok_key(f"{n:03d}"), "x")
        b, _ = self.start()
        self.assertIsNone(b)
        self.assertEqual(w.store.line("codex", DROP_METHOD)["run"], 0)

    def test_successor_after_a_merged_001_reads_no_stage3_or_stage4_completion(self):
        w = self.w
        w.gh.latest_d1_pr = {"title": "[D1/Sol] 001", "merge_commit_sha": w.git.base_sha}
        w.store.set(stage_d1.SPEC.ok_key("001"), w.git.base_sha)
        b, read = self.start()
        self.assertEqual((b["shard"], b["batch"]), ("002", "d1"))
        self.assertEqual(read, [])

    def test_successor_after_an_official_no_change_001_reads_no_stage3_or_stage4_completion(self):
        w = self.w
        w.store.set(stage_d1.SPEC.nochange_key("001"), w.git.base_sha)
        w.store.set(stage_d1.SPEC.ok_key("001"), w.git.base_sha)
        b, read = self.start()
        self.assertEqual((b["shard"], b["batch"]), ("002", "d1"))
        self.assertEqual(read, [])


class LazyOpenPrFiles(unittest.TestCase):
    def test_open_prs_lists_metadata_and_fetches_each_prs_files_once_and_never_as_empty(self):
        runner = mock.Mock()
        runner.run.return_value = mock.Mock(ok=True, out=json.dumps([{"number": 7, "title": "t", "body": "",
                                                                      "headRefName": "h", "baseRefName": "master"}]))
        client = github.GhClient.__new__(github.GhClient)
        client.runner, client.repo, client.env = runner, "o/r", {}
        calls = []
        client.pull_files = lambda n: calls.append(n) or [REL("001")]
        open_pr = client.open_prs()[0]
        self.assertNotIn("files", runner.run.call_args.args[0][-1].split(","))
        self.assertEqual(open_pr["baseRefName"], "master")
        self.assertEqual(calls, [], "no file list until one is read")
        self.assertEqual(open_pr.get("files"), [REL("001")])
        self.assertEqual(open_pr["files"], [REL("001")])
        self.assertEqual(calls, [7])

        def fail(_n):
            raise github.GhError("gh api: 502")
        client.pull_files = fail
        broken = client.open_prs()[0]
        with self.assertRaisesRegex(github.GhError, "열린 PR #7 파일 목록 조회 실패"):
            batches.pr_line_shards(broken, DROP_METHOD)


class DropVerifyAndReplay(unittest.TestCase):
    def batch(self, w, method, tag):
        path = w.paths.worktrees / f"{tag}-001"
        path.mkdir(parents=True)
        w.git.reg[str(path)] = f"{tag}-codex-001"
        bid = w.store.create_batch(method=method, producer="codex", shard="001", batch=tag, branch=f"{tag}-codex-001",
                                   worktree=str(path))
        return w.store.batch(bid), path

    def test_d1_verify_reads_the_kept_judgments_of_the_batch_worktree(self):
        w = world(self)
        b, path = self.batch(w, DROP_METHOD, "d1")
        with mock.patch.object(w.git, "merge_base", return_value="b" * 40, create=True):
            call, command = w.sup._refine_verify_call(b, "a" * 40)
            self.assertTrue(call().ok)
        self.assertEqual(w.git.refine_verify_judgments, [path])
        self.assertIn(f"--judgments {path}", command)
        s4, _ = self.batch(w, STAGE3_METHOD, "s4")
        with mock.patch.object(w.git, "merge_base", return_value="b" * 40, create=True):
            w.sup._refine_verify_call(s4, "a" * 40)[0]()
        self.assertEqual(w.git.refine_verify_judgments[-1], None, "Stage 4 verify is unchanged")
        other = world(self)
        s3, _ = self.batch(other, STAGE3_METHOD, "all")
        self.assertIn("admission-cli.mjs verify", w.sup._refine_verify_call(s3, "a" * 40)[1], "Stage 3 keeps admission verify")

    def test_d1_conflicts_are_replayed_relation_only(self):
        w = world(self)
        b, path = self.batch(w, DROP_METHOD, "d1")
        head, w.git.base_sha = "a" * 40, "b" * 40
        w.git.local_head, w.git.remote[b["branch"]] = head, head
        w.store.update(b["id"], state="WAITING_REVIEW", pr_number=61, head_sha=head)
        w.gh.prs[61] = {"number": 61, "head_sha": head, "head_ref": b["branch"], "state": "open", "merged": False,
                        "base_ref": w.cfg["base_branch"], "base_sha": w.git.base_sha}
        w.gh.files[61] = [REL("001")]
        merged = mock.Mock(return_value=("c" * 40, {"ok": True, "files": []}))
        with mock.patch.object(w.git, "replay_relation_merge", merged, create=True), \
                mock.patch.object(w.sup, "_refine_verify", return_value=(True, "")):
            w.sup._replay_relation_pr(w.store.batch(b["id"]), {"base_ref": w.cfg["base_branch"],
                                                               "base_sha": w.git.base_sha, "head_sha": head})
        self.assertIs(merged.call_args.kwargs["relations_only"], True)
        self.assertIs(merged.call_args.kwargs["drops_only"], True, "#10338: D1 replays its own file drop-only")
        self.assertEqual(merged.call_args.args[4], {"data/relations/relation-001.jsonl"})
        self.assertFalse(stage4.SPEC.replay_drops_only, "S4 keeps its cross-shard replay")

    def test_merged_verify_uses_each_stages_own_verify_of_the_merged_change(self):
        """#10330: after merge, Stage 3 keeps the shard admission verify; S4 and D1 run their CLI verify over exactly
        merge_sha^1..merge_sha (D1 with its kept judgments), and only success records the ok key: the verified
        merge_sha for S4/D1 (#10338), the latest master for Stage 3."""
        merge, parent = "c" * 40, "d" * 40
        for tag, method, spec in (("all", STAGE3_METHOD, None), ("s4", STAGE3_METHOD, stage4.SPEC), ("d1", DROP_METHOD, stage_d1.SPEC)):
            for fail in (False, True):
                w = world(self)
                w.now, w.git.on_base = 10 ** 9, True
                if not fail:
                    w.git.verified.add(("shard", "001", None, None))
                w.git.refine_verify_fail = ("001",) if fail else ()
                b, path = self.batch(w, method, tag)
                with mock.patch.object(w.git, "merge_base", return_value=parent, create=True) as base:
                    result = w.sup._stage3_merged_verify(b, {"number": 7, "merge_commit_sha": merge})
                self.assertEqual(result, not fail, (tag, [e["msg"] for e in w.store.events_after(0)][-3:]))
                ok_key = spec.ok_key("001") if spec else stage3.ok_key("001")
                self.assertEqual(w.store.get(ok_key), None if fail else (merge if spec else w.git.base_sha), tag)
                if spec is None:
                    self.assertEqual(w.git.verify_calls, [("shard", "001", None, None)])
                    self.assertEqual(w.git.__dict__.get("refine_verify_calls", []), [])
                    continue
                self.assertEqual(w.git.verify_calls, [], f"{tag}: no admission verify")
                self.assertEqual(w.git.refine_verify_calls, [(merge, spec.cli, "001", parent)])
                self.assertEqual(w.git.refine_verify_judgments, [path if spec.verify_judgments else None])
                self.assertEqual(base.call_args.args[1:], (f"{merge}^1", merge))

    def test_a_cleanup_retry_after_master_moved_finishes_without_the_removed_worktree(self):
        """#10338: S4/D1 verified the merged change and recorded its merge_sha; the worktree was removed and the run
        stopped before branch cleanup. After master moves on, Retry finds the shard complete (no second verify, no
        merge base or judgments of the removed worktree) and the existing cleanup proof path finishes."""
        merge, head = "c" * 40, "a" * 40
        for tag, method, spec, title in (("s4", STAGE3_METHOD, stage4.SPEC, "[S4/Sol] 001"),
                                         ("d1", DROP_METHOD, stage_d1.SPEC, "[D1/Sol] 001")):
            w = world(self)
            w.now, w.git.on_base, w.git.base_sha = 10 ** 9, True, "e" * 40   # master moved past the merge
            b, path = self.batch(w, method, tag)
            w.store.update(b["id"], state="CLEANUP", pr_number=7, head_sha=head)
            w.store.set(spec.ok_key("001"), merge)
            path.rmdir()
            del w.git.reg[str(path)]
            w.gh.prs[7] = {"number": 7, "title": title, "body": f"Refs #{9929 if tag == 's4' else 10171}",
                           "head_ref": b["branch"], "head_sha": head, "base_ref": "master", "state": "closed",
                           "merged": True, "merge_commit_sha": merge}
            w.gh.files[7] = [REL("001")]
            removed = mock.Mock()
            with mock.patch.object(w.git, "merge_base", side_effect=AssertionError("removed worktree read"), create=True), \
                    mock.patch.object(w.git, "remove_owned", removed):
                w.sup._cleanup(w.store.batch(b["id"]))
            self.assertEqual(w.store.batch(b["id"])["state"], "COMPLETE", (tag, [e["msg"] for e in w.store.events_after(0)][-3:]))
            self.assertEqual(w.git.__dict__.get("refine_verify_calls", []), [], tag)
            self.assertEqual(w.store.get(spec.ok_key("001")), merge, tag)

    def test_d1_card_has_no_marker_contradiction_and_no_d2_handoff(self):
        """#10338: the shared whole-Drop card no longer tells D1 (no marker) to skip unmarked Senses; S2/S3 keep it."""
        from warroom import prompts
        card = prompts.stage3_chunk({"method": DROP_METHOD, "shard": "001", "batch": "d1", "branch": "d1-codex-001"},
                                    "001", "chunk 001/001 senses 1\nW\t말\t-\nS1\tnoun\t뜻.")
        self.assertIn("in D1 every displayed Sense is already a confirmed Skip", card)
        self.assertIn("in S2/S3 a trailing `s` field marks it", card)
        self.assertNotIn("a Sense without the marker is never judged", card)
        self.assertNotIn("D2", card)
        self.assertIn("**`H <n...>`:**", card)

    def test_d1_fix_context_shows_only_the_named_senses_verdicts(self):
        w = world(self)
        b, _path = self.batch(w, DROP_METHOD, "d1")
        listed = {"senses": {"judged": 3, "dropped": 1}, "removed_relations": 5, "changed_files": [REL("001")["path"]],
                  "decisions": [{"sense": "w1-s1", "verdict": "D", "category": 8}, {"sense": "w2-s1", "verdict": "N"},
                                {"sense": "w3-s1", "verdict": "H"}],
                  "rows": [{"status": "drop", "source_sense_id": "w1-s1", "text": "말"}]}
        with mock.patch.object(w.git, "refine_decisions", return_value=listed, create=True) as decisions:
            named = w.sup._s3_fix_context(b, [{"body": "w1-s1 is not an idiom"}], "b" * 40, "a" * 40)
            silent = w.sup._s3_fix_context(b, [{"body": "please check"}], "b" * 40, "a" * 40)
        self.assertEqual(decisions.call_args_list[0].args[-1], ["w1-s1"])
        self.assertIn('"sense":"w1-s1","verdict":"D","category":8', named)
        self.assertNotIn("w2-s1", named)
        self.assertIn('"status":"drop"', named)
        self.assertNotIn("w1-s1", silent, "no named Sense: verdict counts only, never the whole list")
        self.assertIn("removes 5 relations in 1 files", silent)


if __name__ == "__main__":
    unittest.main()
