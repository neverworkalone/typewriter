"""Issue #10171: the Drop line (D1) runs the refinement engine beside the Refinement line, Relation-only.
#10330: D1 SSS edits its own Relation file only and starts after Stage 4 SSS completed."""
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
    def test_d1_is_the_drop_line_stage_own_file_only_and_gated_on_every_stage3_and_its_shards_stage4(self):
        self.assertEqual([spec.id for spec in refine.stages(DROP_METHOD)], ["d1"])
        self.assertEqual([spec.id for spec in refine.stages(STAGE3_METHOD)], ["s3", "s4"])
        spec = stage_d1.SPEC
        self.assertEqual((spec.method, spec.role, spec.issue, spec.cli), (DROP_METHOD, "d1", 10171, "scripts/relation/d1-cli.mjs"))
        self.assertTrue(spec.relations_only and spec.verify_judgments and spec.refusal_records and spec.cli_verify)
        self.assertFalse(spec.cross_shard, "#10330: D1 SSS edits relation-SSS.jsonl only")
        self.assertEqual(spec.scope("001", ["data/relations/relation-007.jsonl", "data/relation-drops/drop-007.jsonl"]),
                         {"data/relations/relation-001.jsonl"})
        s4_ok = stage4.SPEC.ok_key
        kv = {stage3.ok_key(f"{n:03d}"): "x" for n in range(1, 428)}
        kv[s4_ok("001")] = "x"
        self.assertFalse(spec.gate(kv, "001"), "D1 waits for the whole factory's Stage 3, not one shard's")
        kv[stage3.ok_key("428")] = "x"
        self.assertTrue(spec.gate(kv, "001"), "S4 001 merged (or its official no-change, also s4_ok_001)")
        self.assertFalse(spec.gate(kv, "002"), "S4 002 not complete: D1 002 waits, whatever other shards' S4 does")
        self.assertFalse(spec.gate({stage3.ok_key(f"{n:03d}"): "x" for n in range(1, 429)}, "001"),
                         "every Stage 3 alone is not enough")
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

    def choose(self, open_prs, s4_done=("001",)):
        store = self.w.store
        for n in range(1, 429):
            store.set(stage3.ok_key(f"{n:03d}"), "x")
        for shard in s4_done:
            store.set(stage4.SPEC.ok_key(shard), "x")
        return refine.ops_for(stage_d1.SPEC).choose(kv=store, open_prs=open_prs, stage2_batches=[], stage3_batches=[],
                                                    latest_pr=None)

    def test_d1_selection_ignores_open_stage4_prs_and_waits_for_its_own(self):
        self.assertEqual(self.choose([pr(1, "[S4/Sol] 002", 9929, [REL("002")])]).shard, "001",
                         "S4 001 complete: another shard's open S4 does not hold D1 001")
        self.assertEqual(self.choose([pr(2, "[D1/Sol] 001", 10171, [REL("003")])]).status, "wait")

    def test_d1_waits_until_its_shards_stage4_is_complete(self):
        # An open S4 PR (in review or CI) or a no-review pilot PR records no s4_ok: not complete (#10330).
        for open_prs in ([pr(1, "[S4/Sol] 001", 9929, [REL("001")])], [pr(3, "[D1/Luna Pilot] Shard 001", 10171, [REL("001")])]):
            self.assertNotEqual(self.choose(open_prs, s4_done=()).status, "shard")
        self.assertEqual(self.choose([], s4_done=()).status, "unready")
        self.assertEqual(self.choose([], s4_done=("002",)).status, "unready", "another shard's S4 does not open D1 001")


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
        self.assertEqual(merged.call_args.args[4], {"data/relations/relation-001.jsonl"})

    def test_merged_verify_uses_each_stages_own_verify_of_the_merged_change(self):
        """#10330: after merge, Stage 3 keeps the shard admission verify; S4 and D1 run their CLI verify over exactly
        merge_sha^1..merge_sha (D1 with its kept judgments), and only success records the ok key."""
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
                self.assertEqual(w.store.get(ok_key), None if fail else w.git.base_sha, tag)
                if spec is None:
                    self.assertEqual(w.git.verify_calls, [("shard", "001", None, None)])
                    self.assertEqual(w.git.__dict__.get("refine_verify_calls", []), [])
                    continue
                self.assertEqual(w.git.verify_calls, [], f"{tag}: no admission verify")
                self.assertEqual(w.git.refine_verify_calls, [(merge, spec.cli, "001", parent)])
                self.assertEqual(w.git.refine_verify_judgments, [path if spec.verify_judgments else None])
                self.assertEqual(base.call_args.args[1:], (f"{merge}^1", merge))

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
