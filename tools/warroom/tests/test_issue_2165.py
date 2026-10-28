"""Issue #2165: optional-link review, deterministic finalization and bounded fresh Stage 2 fixes."""
import json
import unittest
from pathlib import Path

from tests.test_issue_1684 import S2
from tests.test_issue_1908 import s2_world, write_state
from warroom import control, prompts, stage2


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
        self.assertIn("inspect w1-s1", context)
        self.assertIn("w999-s1", context)

    def test_fix_context_keeps_40kb_inline_and_pages_only_above_90kb(self):
        w, b = self.start_optional_part(sense_id="w1-s1")
        w.git.inspect_text = "source context\n" + "x" * 40_000
        inline = w.sup._s2_fix_context(b, [{"body": "review w1-s1"}])
        self.assertEqual(inline, w.git.inspect_text)
        self.assertFalse((Path(b["worktree"]) / ".warroom-scratch" / "s2-fix-context.txt").exists())

        w.git.inspect_text = "source context\n" + "x" * 100_000
        paged = w.sup._s2_fix_context(b, [{"body": "review w1-s1"}])
        self.assertIn("bounded pages", paged)
        pages = stage2.chunk_pages(w.git.inspect_text)
        page_paths = [Path(b["worktree"]) / stage2.page_path(i, len(pages), ".warroom-scratch/s2-fix-context.txt")
                      for i in range(1, len(pages) + 1)]
        self.assertEqual("".join(path.read_text("utf-8") for path in page_paths), w.git.inspect_text)

    def test_stage2_fix_prompt_has_the_supported_foreground_verify_and_gh_instructions(self):
        w, b = self.start_optional_part(sense_id="w1-s1")
        fix = prompts.fix(b, [], False, source_context="source context")
        for phrase in ("node scripts/relation/admission-cli.mjs verify --shard 001 --batch 01 --part 01 --json",
                       "120000 ms", "foreground", "GH_CONFIG_DIR", "gh` CLI", "Write tool", "amend --help",
                       "do not use GitHub MCP"):
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
        new_head = "e" * 40
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
