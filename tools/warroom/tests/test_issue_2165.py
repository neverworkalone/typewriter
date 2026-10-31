"""Issue #2165: optional-link review, deterministic finalization and bounded fresh Stage 2 fixes."""
import json
import unittest
from pathlib import Path

from tests.test_issue_1684 import S2
from tests.test_issue_1908 import s2_world, write_state
from warroom import control, prompts, stage2
from warroom.gitops import IntegrationBlocked


def answer(text):
    return json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}) + "\n"


class Stage2Finalization(unittest.TestCase):
    def start_optional_part(self, *plans, sense_id="source-sense"):
        w = s2_world(self)
        w.git.chunk_view_total = 1
        w.git.optional_candidate_after_chunk = True
        w.git.chunk_view_sense_id = sense_id
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.adapter.plan.extend(plans or [{"code": 0, "session": "ses_chunk", "text": answer("chunk 001-01-01-001\nc1 D first")}])
        w.tick()
        return w, w.store.active_batch("claude", S2)

    def test_optional_links_use_one_fresh_run_then_deterministic_finalization(self):
        w, b = self.start_optional_part()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual((b["run_kind"], len(w.adapter.launches)), ("s2_links_new", 2))
        links_run = w.adapter.launches[-1]
        self.assertEqual(links_run["kind"], "start")
        self.assertIn("T2", links_run["prompt"])
        digest = json.loads(w.store.get(stage2.links_start_key(b["id"])))['digest']
        self.assertEqual(digest, "a" * 64)
        w.adapter.running[links_run["pid"]]["text"] = answer(f"links @{digest}\nc1 skip")
        w.adapter.running[links_run["pid"]]["session"] = "ses_links"
        w.adapter.finish(links_run["pid"])
        w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual((b["state"], b["run_kind"], len(w.adapter.launches)),
                         ("WAITING_REVIEW", "s2_deterministic_finalize", 2))
        self.assertEqual(len(w.git.optional_save_calls), 1)
        self.assertIn("c1 skip", w.git.optional_save_calls[0])
        self.assertEqual([run["kind"] for run in w.store.runs(b["id"])], ["s2_links_new", "s2_chunk_new"])
        self.assertEqual(len(w.gh.created_prs), 1)

    def test_optional_format_correction_resumes_only_the_link_session(self):
        w, b = self.start_optional_part()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        b = w.store.batch(b["id"])
        links_run = w.adapter.launches[-1]
        w.adapter.running[links_run["pid"]]["text"] = answer("links c1 skip")
        w.adapter.running[links_run["pid"]]["session"] = "ses_links"
        w.adapter.finish(links_run["pid"])
        w.tick()
        fix = w.adapter.launches[-1]
        self.assertEqual((w.store.batch(b["id"])["run_kind"], fix["kind"], fix.get("session")),
                         ("s2_links_fix", "resume", "ses_links"))
        self.assertEqual(len(w.git.optional_save_calls), 0)
        digest = json.loads(w.store.get(stage2.links_start_key(b["id"])))['digest']
        w.adapter.running[fix["pid"]]["text"] = answer(f"links @{digest}\nc1 skip")
        w.adapter.finish(fix["pid"])
        w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual((b["state"], len(w.adapter.launches)), ("WAITING_REVIEW", 3))
        self.assertEqual(len(w.git.optional_save_calls), 1)
        self.assertEqual([run["kind"] for run in w.store.runs(b["id"])],
                         ["s2_links_fix", "s2_links_new", "s2_chunk_new"])

    def test_review_fix_is_always_new_and_inspect_context_is_limited_to_part_ids(self):
        w, b = self.start_optional_part(sense_id="w1-s1")
        w.store.update(b["id"], session_id="old-production-session")
        b = w.store.batch(b["id"])
        context = w.sup._s2_fix_context(b, [{"body": "Please inspect w1-s1 and unrelated w999-s1."}])
        self.assertEqual(w.sup._fix_kind(b), "fix_new")
        self.assertEqual(w.git.inspect_calls[-1][1:], ("001", "01", "01", ["w1-s1"]))
        self.assertEqual(w.git.inspect_selection_calls[-1], ".warroom-scratch/s2-fix-select.json")
        selection = json.loads((Path(b["worktree"]) / ".warroom-scratch/s2-fix-select.json").read_text("utf-8"))
        self.assertEqual(selection, {"candidates": []}, "an explicit Sense-only target selects the full Sense")
        self.assertIn("inspect w1-s1", context)
        self.assertIn("w999-s1", context)

    def test_stage2_fix_context_selects_only_exact_candidate_pairs(self):
        w, b = self.start_optional_part(sense_id="w1-s1")
        checkpoint_path = Path(b["worktree"]) / ".warroom-scratch/relation-admission-001-01-01.json"
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        checkpoint["items"][0]["record_id"] = "w1"
        checkpoint_path.write_text(json.dumps(checkpoint), "utf-8")
        w.sup._s2_fix_context(b, [{"body": "`w1`, `w1-s1`, `candidate-0`"}])
        self.assertEqual(w.git.inspect_calls[-1][1:], ("001", "01", "01", ["w1-s1"]))
        self.assertEqual(json.loads((Path(b["worktree"]) / ".warroom-scratch/s2-fix-select.json").read_text("utf-8")),
                         {"candidates": [{"source_sense_id": "w1-s1", "candidate": "candidate-0"}]})

    def test_stage2_fix_context_uses_prose_mentions_and_never_selects_pairs_for_full_senses(self):
        w, b = self.start_optional_part(sense_id="w1-s1")
        checkpoint_path = Path(b["worktree"]) / ".warroom-scratch/relation-admission-001-01-01.json"
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        first = checkpoint["items"][0]
        checkpoint["items"] = [
            {**first, "record_id": "w1"},
            {**first, "record_id": "w2", "sense_id": "w2-s1"},
        ]
        checkpoint_path.write_text(json.dumps(checkpoint), "utf-8")

        context = w.sup._s2_fix_context(b, [{"body": "Please Fix w1-s1 and Compare w2-s1."}])

        self.assertEqual(w.git.inspect_calls[-1][1:], ("001", "01", "01", ["w1-s1", "w2-s1"]))
        self.assertEqual(json.loads((Path(b["worktree"]) / ".warroom-scratch/s2-fix-select.json").read_text("utf-8")),
                         {"candidates": []})
        self.assertIn("w1-s1", context)
        self.assertIn("w2-s1", context)

    def test_review_events_combine_and_full_sense_pairs_are_removed_from_inspect_select(self):
        w, b = self.start_optional_part(sense_id="w1-s1")
        checkpoint_path = Path(b["worktree"]) / ".warroom-scratch/relation-admission-001-01-01.json"
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        first = checkpoint["items"][0]
        checkpoint["items"] = [
            {**first, "record_id": "w1", "sense_id": "w1-s1"},
            {**first, "record_id": "w2", "sense_id": "w2-s1"},
        ]
        checkpoint_path.write_text(json.dumps(checkpoint), "utf-8")

        context = w.sup._s2_fix_context(b, [
            {"body": "`w1`, `w1-s1`, `candidate-0`"},
            {"body": "w1-s1 has a prose finding; `w2`, `w2-s1`, `candidate-0` is also named; "
                     "outside target w999-s1 is diagnostic only."},
        ])

        self.assertEqual(w.git.inspect_calls[-1][1:], ("001", "01", "01", ["w1-s1", "w2-s1"]))
        self.assertEqual(json.loads((Path(b["worktree"]) / ".warroom-scratch/s2-fix-select.json").read_text("utf-8")),
                         {"candidates": [{"source_sense_id": "w2-s1", "candidate": "candidate-0"}]})
        self.assertIn("Full-sense detail for prose-mentioned or unmatched-tuple Senses: w1-s1", context)
        self.assertIn("outside this Part (diagnostic only): w999-s1", context)

    def test_same_line_plain_tuple_keeps_later_prose_sense_in_inspect_and_out_of_select(self):
        w, b = self.start_optional_part(sense_id="w1-s1")
        checkpoint_path = Path(b["worktree"]) / ".warroom-scratch/relation-admission-001-01-01.json"
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        first = checkpoint["items"][0]
        checkpoint["items"] = [
            {**first, "record_id": "w1", "sense_id": "w1-s1"},
            {**first, "record_id": "w2", "sense_id": "w2-s1"},
        ]
        checkpoint_path.write_text(json.dumps(checkpoint), "utf-8")

        context = w.sup._s2_fix_context(b, [
            {"body": "- w1, w1-s1, candidate-0; w2-s1 is a comparison peer."},
        ])

        self.assertEqual(w.git.inspect_calls[-1][1:], ("001", "01", "01", ["w1-s1", "w2-s1"]))
        self.assertEqual(json.loads((Path(b["worktree"]) / ".warroom-scratch/s2-fix-select.json").read_text("utf-8")),
                         {"candidates": [{"source_sense_id": "w1-s1", "candidate": "candidate-0"}]})
        self.assertIn("Full-sense detail for prose-mentioned or unmatched-tuple Senses: w2-s1", context)

    def test_sense_id_free_instruction_is_reported_as_unbound(self):
        w, b = self.start_optional_part(sense_id="w1-s1")
        context = w.sup._s2_fix_context(b, [{"body": "Please also fix this Sense's activities photo."}])
        self.assertIn("source_context 없음", context)
        self.assertIn("Sense ID나 유효 튜플이 없는 순수 지시 문장", context)

    def test_fix_context_keeps_40kb_inline_and_pages_only_above_90kb(self):
        w, b = self.start_optional_part(sense_id="w1-s1")
        w.git.inspect_text = "source context\n" + "x" * 40_000
        inline = w.sup._s2_fix_context(b, [{"body": "review w1-s1"}])
        fallback_note = "\n# Full-sense detail for prose-mentioned or unmatched-tuple Senses: w1-s1\n"
        self.assertEqual(inline, w.git.inspect_text + fallback_note)
        self.assertFalse((Path(b["worktree"]) / ".warroom-scratch" / "s2-fix-context.txt").exists())

        w.git.inspect_text = "".join(f"row {i} " + "x" * 1_000 + "\n" for i in range(100))
        paged = w.sup._s2_fix_context(b, [{"body": "review w1-s1"}])
        self.assertIn("bounded pages", paged)
        expected_context = w.git.inspect_text + fallback_note
        pages = stage2.chunk_pages(expected_context)
        page_paths = [Path(b["worktree"]) / stage2.page_path(i, len(pages), ".warroom-scratch/s2-fix-context.txt")
                      for i in range(1, len(pages) + 1)]
        self.assertEqual("".join(path.read_text("utf-8") for path in page_paths), expected_context)

    def test_stage2_fix_prompt_has_the_supported_foreground_verify_and_gh_instructions(self):
        w, b = self.start_optional_part(sense_id="w1-s1")
        fix = prompts.fix(b, [], False, source_context="source context")
        for phrase in ("node scripts/relation/admission-cli.mjs verify --shard 001 --batch 01 --part 01 --json",
                       "600000 ms", "foreground", "GH_CONFIG_DIR", "gh` CLI", "Write tool", "amend --help",
                       "do not use GitHub MCP", "one inspect view that includes all Senses being amended",
                       "After the push and concise replies", "do not run unnecessary `gh pr checks`",
                       "The Supervisor separately verifies the exact pushed HEAD"):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, fix)

    def test_no_optional_links_creates_empty_commit_without_an_ai_run(self):
        w = s2_world(self)
        w.git.chunk_view_total = 0
        w.git.finalize_output_paths = []
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["state"], b["run_kind"], len(w.adapter.launches)),
                         ("WAITING_REVIEW", "s2_deterministic_finalize", 0))
        self.assertEqual(w.git.commits, [([], "[Stage 2] 001_01 Part 01")])
        self.assertEqual(w.git.commit_empty_allowed, [True])
        self.assertEqual(w.git.pushes, [b["branch"]])
        self.assertEqual(len(w.gh.created_prs), 1)

    def test_finalization_commits_only_changed_relation_or_drop_outputs(self):
        relation = "data/relations/relation-001.jsonl"
        drop = "data/relation-drops/drop-001.jsonl"
        for outputs in ([relation], [drop], [relation, drop]):
            with self.subTest(outputs=outputs):
                w = s2_world(self)
                w.git.chunk_view_total = 0
                w.git.finalize_output_paths = outputs
                control.start(w.store, "claude", S2, "single", cfg=w.cfg)
                w.tick()
                b = w.store.active_batch("claude", S2)
                self.assertEqual(b["state"], "WAITING_REVIEW")
                self.assertEqual(w.git.commits, [(sorted(outputs), "[Stage 2] 001_01 Part 01")])
                self.assertEqual(w.git.commit_empty_allowed, [False])
                self.assertEqual(w.git.local_verify_calls[0], ("001", "01", "01", True))
                self.assertEqual(w.git.exact_verify_calls[0], ("f" * 40, "001", "01", "01"))

    def test_legacy_checkpoint_captures_old_head_then_integrates_exact_stage3_deletion_commits(self):
        w, b = self.start_optional_part()
        checkpoint_path = Path(b["worktree"]) / ".warroom-scratch" / "relation-admission-001-01-01.json"
        checkpoint = json.loads(checkpoint_path.read_text("utf-8"))
        checkpoint.pop("base_revision", None)
        checkpoint_path.write_text(json.dumps(checkpoint), "utf-8")

        change_point = w.git.head(Path(b["worktree"]))
        stage3_commit, latest = "2" * 40, "3" * 40
        relation = "data/relations/relation-001.jsonl"
        w.git.base_sha = latest
        w.git.integrate_updates_head = True
        w.git.changed_between_paths = [relation]
        w.git.ancestor_pairs = {(change_point, stage3_commit), (stage3_commit, latest), (change_point, latest)}
        w.git.commit_ranges = {(change_point, stage3_commit, latest)}
        w.git.changed[stage3_commit] = [relation]
        w.gh.merged_stage3_prs = [{"number": 2451, "title": "[Relation Stage 3] 001", "base_ref": "master",
                                   "shard": "001", "merge_commit_sha": stage3_commit}]
        w.gh.files[2451] = [{"path": relation}]

        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        links_run = w.adapter.launches[-1]
        digest = json.loads(w.store.get(stage2.links_start_key(b["id"])))['digest']
        w.adapter.running[links_run["pid"]]["text"] = answer(f"links @{digest}\nc1 skip")
        w.adapter.running[links_run["pid"]]["session"] = "ses_links"
        w.adapter.finish(links_run["pid"])
        w.tick()

        b = w.store.batch(b["id"])
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self.assertEqual(w.git.integrated, [(b["worktree"], latest)])
        self.assertEqual(w.git.stage2_prepare_merge_meta, [((stage3_commit,), True)])
        self.assertEqual(w.store.get(f"s2_stage3_change_point_{b['id']}"), change_point)
        self.assertEqual(w.gh.pull_files_calls, [2451])
        self.assertEqual(len(w.adapter.launches), 2, "latest-base sync and reconciliation do not rerun AI")

    def test_latest_master_conflict_preserves_checkpoint_and_does_not_rerun_ai(self):
        w, b = self.start_optional_part()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        links_run = w.adapter.launches[-1]
        digest = json.loads(w.store.get(stage2.links_start_key(b["id"])))['digest']
        w.adapter.running[links_run["pid"]]["text"] = answer(f"links @{digest}\nc1 skip")
        w.adapter.running[links_run["pid"]]["session"] = "ses_links"
        w.adapter.finish(links_run["pid"])
        checkpoint_path = Path(b["worktree"]) / ".warroom-scratch" / "relation-admission-001-01-01.json"
        checkpoint_before = checkpoint_path.read_bytes()
        w.git.integrate_error = IntegrationBlocked("simulated overlapping worktree change")

        w.tick()

        current = w.store.batch(b["id"])
        self.assertEqual(current["state"], "ERROR")
        self.assertEqual(checkpoint_path.read_bytes(), checkpoint_before)
        self.assertEqual(w.git.stage2_prepare_merge_calls, [])
        self.assertEqual(len(w.adapter.launches), 2, "safe synchronization failure does not restart AI editing")

    def test_retry_after_local_verify_failure_reuses_merge_without_rerunning_ai(self):
        w = s2_world(self)
        w.git.chunk_view_total = 1
        w.git.local_verify_ok = False
        w.adapter.plan.append({"code": 0, "session": "ses_chunk", "text": answer("chunk 001-01-01-001\nc1 D first")})
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["state"], len(w.adapter.launches)), ("ERROR", 1))
        self.assertEqual(getattr(w.git, "commits", []), [])
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.git.local_verify_ok = True
        w.tick(2)  # the first tick restores PRODUCING; the next retries deterministic finalization
        b = w.store.batch(b["id"])
        self.assertEqual((b["state"], len(w.adapter.launches)), ("WAITING_REVIEW", 1), b["error"])
        self.assertEqual(w.git.stage2_merge_calls, [("001", "01", "01"), ("001", "01", "01")])
        self.assertEqual(len(w.git.commits), 1)
        self.assertEqual(w.git.pushes, [b["branch"]])
        self.assertEqual(len(w.gh.created_prs), 1)

    def test_stage2_review_fix_requires_amend_evidence_and_checks_both_verifiers(self):
        w, b = self.start_optional_part({"code": 0, "session": "ses_chunk",
                                         "text": answer("chunk 001-01-01-001\nc1 D first")},
                                         sense_id="w1-s1")
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        b = w.store.batch(b["id"])
        links_run = w.adapter.launches[-1]
        digest = json.loads(w.store.get(stage2.links_start_key(b["id"])))['digest']
        w.adapter.running[links_run["pid"]]["text"] = answer(f"links @{digest}\nc1 skip")
        w.adapter.running[links_run["pid"]]["session"] = "ses_links"
        w.adapter.finish(links_run["pid"])
        w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual(b["state"], "WAITING_REVIEW")
        w.store.update(b["id"], session_id="old-production-session")
        event = {"kind": "issue_comment", "author": "reviewer", "key": "review-1",
                 "body": "Please reconsider w1-s1 and ignore w999-s1."}
        w.adapter.plan.append({"code": 0, "session": "ses_fix"})
        w.sup._launch(w.store.batch(b["id"]), w.sup._fix_kind(w.store.batch(b["id"])), [event])
        fix = w.adapter.launches[-1]
        fix_batch = w.store.batch(b["id"])
        self.assertEqual((fix["kind"], fix.get("session"), w.store.batch(b["id"])["run_kind"]),
                         ("start", None, "fix_new"), fix_batch["error"])
        self.assertIn("inspect w1-s1", fix["prompt"])
        self.assertIn("w999-s1", fix["prompt"])
        self.assertEqual(w.git.inspect_calls[-1][1:], ("001", "01", "01", ["w1-s1"]))

        info = w.gh.pull(b["pr_number"])
        self.assertIsNone(w.sup._stage2_fix_result_problem(w.store.batch(b["id"]), info),
                          "a no-change response may keep the already verified exact HEAD")
        old_head = info["head_sha"]
        safe_update_head = "e" * 40
        w.adapter.stop(fix["pid"])
        w.store.update(b["id"], pid=None)
        w.git.fast_forward_ancestors.add((old_head, safe_update_head))
        w.git.remote[b["branch"]] = safe_update_head
        w.gh.prs[b["pr_number"]]["head_sha"] = safe_update_head
        info = w.gh.pull(b["pr_number"])
        w.sup._fast_forward_pr_head(w.store.batch(b["id"]), info)
        self.assertIsNone(w.sup._stage2_fix_result_problem(w.store.batch(b["id"]), info),
                          "a proven Update branch FF with the Stage 2 outputs and checkpoint unchanged is a no-change fix")

        new_head = "d" * 40
        w.git.local_head = new_head
        w.git.remote[b["branch"]] = new_head
        w.gh.prs[b["pr_number"]]["head_sha"] = new_head
        info = w.gh.pull(b["pr_number"])
        self.assertIn("amend revision", w.sup._stage2_fix_result_problem(w.store.batch(b["id"]), info))

        checkpoint = Path(b["worktree"]) / ".warroom-scratch" / "relation-admission-001-01-01.json"
        data = json.loads(checkpoint.read_text("utf-8"))
        data["amend_revision"] = 1
        checkpoint.write_text(json.dumps(data), "utf-8")
        checkpoint.with_name("relation-admission-001-01-01.amend-state.json").write_text("{}", "utf-8")
        self.assertIsNone(w.sup._stage2_fix_result_problem(w.store.batch(b["id"]), info))
        self.assertEqual(w.git.local_verify_calls[-1], ("001", "01", "01", True))
        self.assertEqual(w.git.exact_verify_calls[-1], (new_head, "001", "01", "01"))


if __name__ == "__main__":
    unittest.main()
