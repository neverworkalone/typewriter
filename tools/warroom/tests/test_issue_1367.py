"""#1367: Method prompt files and the C/D model-shared batch queue."""
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from tests.fake_runner import ScriptedRunner
from tests.fakes import HEAD1, HEAD2, World
from tests.test_lines import multi_world
from tests.test_supervisor import review
from warroom import batches, control, prompts
from warroom.store import DuplicateBatch, LineBusy

ROW = {"shard": "001", "batch": "01", "branch": "a-deepseek-001-01", "pr_number": 7, "head_sha": HEAD1}


def cand(s, b, method, model):
    return f"data/relation-candidates/{s:03d}/{s:03d}_{b:02d}_{method}_{model}.jsonl"


class PromptFiles(unittest.TestCase):
    def test_four_methods_start_with_their_issue_and_fill_batch_and_branch(self):
        for method, head in (("a", "#860 A 진행해"), ("b", "#860 B 진행해"),
                             ("c", "#1155 C 진행해"), ("d", "#1156 D 진행해")):
            text = prompts.produce({**ROW, "method": method})
            self.assertTrue(text.startswith(head), (method, text[:30]))
            self.assertIn("001_01", text)
            self.assertIn("브랜치 a-deepseek-001-01", text)
            self.assertNotIn("{{", text)
            self.assertLess(len(text.splitlines()), 20, method)       # a pointer to the issue, not a copy of its rules
        self.assertIn("Refs #1155", prompts.produce({**ROW, "method": "c"}))
        self.assertIn("Refs #1156", prompts.produce({**ROW, "method": "d"}))
        self.assertIn("참조하거나 닫지 않는다", prompts.produce({**ROW, "method": "a"}))
        self.assertFalse((prompts.PROMPT_DIR / "common.md").exists())

    def test_every_shipped_template_renders_with_its_declared_values(self):
        for name in prompts.ALLOWED:
            vals = {k: f"<{k}>" for k in prompts.ALLOWED[name]}
            out = prompts.render(name, vals)
            self.assertNotIn("{{", out)

    def test_independent_of_cwd_and_values_are_data(self):
        old = os.getcwd()
        with tempfile.TemporaryDirectory() as d:
            os.chdir(d)
            try:
                ev = [{"kind": "review", "author": "genonfire", "key": "k", "body": "-1 {{batch}} {{x}}"}]
                text = prompts.fix(ROW, ev, False)
            finally:
                os.chdir(old)
        self.assertIn("-1 {{batch}} {{x}}", text)          # a review body is never re-substituted
        self.assertIn("새 세션", text)
        self.assertNotIn("새 세션", prompts.fix(ROW, ev, True))
        self.assertIn("PR #7", text)

    def test_failure_table_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            vals = {"batch": "001_01", "branch": "b"}
            for name, content, want in [
                ("missing", None, "읽을 수 없"), ("empty", "  \n", "비어"),
                ("unknown", "{{nope}} {{batch}}", "허용되지"), ("unfilled", "{{pr}}", "허용되지"),
            ]:
                with self.subTest(name):
                    (d / "a.md").unlink(missing_ok=True)
                    if content is not None:
                        (d / "a.md").write_text(content)
                    with self.assertRaisesRegex(prompts.PromptError, want):
                        prompts.render("a", vals, d)
            (d / "a.md").write_text("{{batch}} {{branch}}")
            with self.assertRaisesRegex(prompts.PromptError, "값이 없는"):
                prompts.render("a", {"batch": "x"}, d)
            with self.assertRaises(prompts.PromptError):
                prompts.render("zzz", vals, d)
            with self.assertRaises(prompts.PromptError):
                prompts.render("a", vals, d / "no-such-dir")


class PromptsDriveEveryRun(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.dir = tempfile.TemporaryDirectory()
        for n in prompts.ALLOWED:
            tmpl = " ".join("{{%s}}" % k for k in sorted(prompts.ALLOWED[n]))
            (Path(self.dir.name) / f"{n}.md").write_text(f"[{n}] {tmpl}")
        patcher = mock.patch.object(prompts, "PROMPT_DIR", Path(self.dir.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def tearDown(self):
        self.dir.cleanup()
        self.w.tmp.cleanup()

    def open_pr(self):
        self.w.pr_info(7, HEAD1)
        self.w.gh.by_branch["a-deepseek-001-01"] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]

    def test_produce_fix_and_recovery_paths_read_the_files(self):
        w = self.w
        w.start("single")
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": self.open_pr})
        w.tick()
        self.assertTrue(w.adapter.launches[-1]["prompt"].startswith("[a] 001_01"))
        first_prompt = w.adapter.launches[-1]["prompt"]
        (Path(self.dir.name) / "a.md").write_text("[a] CHANGED")        # an active run keeps what it was given
        self.assertEqual(w.adapter.launches[-1]["prompt"], first_prompt)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        w.gh.reviews_ = [review(11, HEAD1)]
        w.tick(2)
        fix = w.adapter.launches[-1]
        self.assertEqual(fix["kind"], "resume")
        self.assertIn("[fix]", fix["prompt"])
        self.assertIn("fix it", fix["prompt"])
        # produce_resume / produce_recover / fix_new use recovery.md and fix.md as well
        b = w.row()
        for kind, marker in (("produce_resume", "[recovery]"), ("produce_recover", "[recovery]")):
            w.store.update(b["id"], session_id="ses_1" if kind.endswith("resume") else None, pid=None)
            w.sup._launch(w.store.batch(b["id"]), kind)
            self.assertIn(marker, w.adapter.launches[-1]["prompt"], kind)
        w.store.update(b["id"], session_id=None, pid=None)
        w.sup._launch(w.store.batch(b["id"]), "fix_new", [{"kind": "review", "author": "genonfire", "key": "k", "body": "-1"}])
        self.assertIn("새 세션", w.adapter.launches[-1]["prompt"])

    def test_unusable_prompt_starts_no_process_and_is_visible(self):
        for name, content in (("missing", None), ("empty", ""), ("unknown", "[a] {{secret}}")):
            with self.subTest(name):
                w = World()
                (Path(self.dir.name) / "a.md").unlink(missing_ok=True)
                if content is not None:
                    (Path(self.dir.name) / "a.md").write_text(content)
                w.start("single")
                w.tick(2)
                self.assertEqual(w.adapter.launches, [])
                b = w.row()
                self.assertEqual(b["state"], "ERROR")
                self.assertIn("프롬프트", b["error"])
                self.assertTrue(any("프롬프트" in e["msg"] for e in w.store.recent_events(20)))
                w.tmp.cleanup()
            (Path(self.dir.name) / "a.md").write_text("[a] {{batch}} {{branch}}")


class SharedQueueSelection(unittest.TestCase):
    CANON = {1: 1000, 2: 600}

    def pick(self, method, done, prs=(), owned=(), producer="deepseek"):
        r = ScriptedRunner()
        r.set_batches(self.CANON, {p: n for p, n in done.items()})
        return batches.next_batch(r, ".", {}, ref="origin/master", method=method, producer=producer,
                                  open_prs=list(prs), owned=set(owned))

    def key(self, b):
        return None if b is None else (b.shard, b.batch)

    def test_table(self):
        pr = lambda m, model, s, b: {"number": 9, "files": [{"path": cand(s, b, m, model)}]}
        for name, method, done, prs, owned, want in [
            ("A: another model's file does not complete", "a", {cand(1, 1, "a", "codex"): 500}, [], [], ("001", "01")),
            ("B: another model's file does not complete", "b", {cand(1, 1, "b", "codex"): 500}, [], [], ("001", "01")),
            ("C: another model's file completes", "c", {cand(1, 1, "c", "codex"): 500}, [], [], ("001", "02")),
            ("D: another model's file completes", "d", {cand(1, 1, "d", "claude"): 500}, [], [], ("001", "02")),
            ("C: own file completes", "c", {cand(1, 1, "c", "deepseek"): 500}, [], [], ("001", "02")),
            ("C ignores D completion", "c", {cand(1, 1, "d", "codex"): 500}, [], [], ("001", "01")),
            ("D ignores C completion", "d", {cand(1, 1, "c", "codex"): 500}, [], [], ("001", "01")),
            ("C: other model's open PR claims", "c", {}, [pr("c", "codex", 1, 1)], [], ("001", "02")),
            ("A: other model's open PR does not", "a", {}, [pr("a", "codex", 1, 1)], [], ("001", "01")),
            ("C: open D PR does not claim", "c", {}, [pr("d", "codex", 1, 1)], [], ("001", "01")),
            ("C: owned by War Room (any model)", "c", {}, [], [("001", "01")], ("001", "02")),
            ("C: skips done, claimed, then picks the next", "c",
             {cand(1, 1, "c", "codex"): 500}, [pr("c", "claude", 1, 2)], [], ("002", "01")),
            ("C: experiments/ and other files do not claim", "c", {}, [{"number": 3, "files": [
                {"path": "experiments/x/001_01_c_codex.jsonl"}, {"path": "README.md"}]}], [], ("001", "01")),
            ("C: short last batch counted", "c", {cand(1, 1, "c", "codex"): 500, cand(1, 2, "c", "claude"): 500,
                                                  cand(2, 1, "c", "codex"): 500}, [], [], ("002", "02")),
        ]:
            with self.subTest(name):
                self.assertEqual(self.key(self.pick(method, done, prs, owned)), want)

    def test_conflicts_and_unknowns_fail_closed(self):
        for name, method, done, prs in [
            ("two models' files for one C batch", "c", {cand(1, 1, "c", "codex"): 500, cand(1, 1, "c", "claude"): 500}, []),
            ("two models' files for a later D batch", "d", {cand(2, 1, "d", "codex"): 100, cand(2, 1, "d", "claude"): 100}, []),
            ("partial file of another model", "c", {cand(1, 1, "c", "codex"): 499}, []),
            ("PR file list unknown", "c", {}, [{"number": 5}]),
            ("PR file list unknown (A too)", "a", {}, [{"number": 5, "files": None}]),
        ]:
            with self.subTest(name):
                with self.assertRaises(batches.BatchError):
                    self.pick(method, done, prs)
        # A/B keep ignoring other models' files, even duplicate ones.
        self.assertEqual(self.key(self.pick("a", {cand(1, 1, "a", "codex"): 500, cand(1, 1, "a", "claude"): 499})),
                         ("001", "01"))


class SharedQueueInSupervisor(unittest.TestCase):
    def setUp(self):
        self.w = multi_world()

    def tearDown(self):
        self.w.tmp.cleanup()

    def start_and_tick(self, model, method):
        self.w.start("single", model, method)
        self.w.tick()
        return self.w.row(model, method)

    def test_other_models_master_file_is_skipped_for_c_not_for_a(self):
        w = self.w
        w.runner.set_batches({1: 1000}, {cand(1, 1, "c", "sonnet"): 500, cand(1, 1, "a", "sonnet"): 500})
        self.assertEqual(self.start_and_tick("deepseek", "c")["batch"], "02")
        self.assertEqual(self.start_and_tick("deepseek", "a")["batch"], "01")

    def test_every_unfinished_state_of_another_model_occupies_the_batch(self):
        for state in ("PREPARE", "PRODUCING", "WAITING_REVIEW", "FIXING", "MERGED", "CLEANUP", "PAUSED", "ERROR"):
            with self.subTest(state):
                w = multi_world()
                bid = w.store.create_batch(method="c", producer="sonnet", shard="001", batch="01",
                                           branch="c-sonnet-001-01", worktree=str(w.paths.worktrees / "x"))
                w.store.update(bid, state=state)
                b = None
                w.start("single", "deepseek", "c")
                w.tick()
                b = w.row("deepseek", "c")
                self.assertEqual((b["shard"], b["batch"]), ("001", "02"), state)
                w.tmp.cleanup()

    def test_completed_batch_not_yet_on_master_is_not_reproduced(self):
        w = self.w
        bid = w.store.create_batch(method="d", producer="sonnet", shard="001", batch="01",
                                   branch="d-sonnet-001-01", worktree=str(w.paths.worktrees / "x"))
        w.store.update(bid, state="COMPLETE", merged=1)
        self.assertEqual(self.start_and_tick("deepseek", "d")["batch"], "02")

    def test_other_models_open_pr_and_c_d_queues_are_independent(self):
        w = self.w
        w.gh.open = [{"number": 9, "files": [{"path": cand(1, 1, "c", "sonnet")}]}]
        self.assertEqual(self.start_and_tick("deepseek", "c")["batch"], "02")
        self.assertEqual(self.start_and_tick("deepseek", "d")["batch"], "01")     # D has its own queue

    def test_conflicting_master_files_block_with_a_visible_reason(self):
        w = self.w
        w.runner.set_batches({1: 1000}, {cand(1, 1, "c", "codex"): 500, cand(1, 1, "c", "claude"): 500})
        w.start("single", "deepseek", "c")
        w.tick()
        self.assertIsNone(w.row("deepseek", "c"))
        self.assertIn("배치 선정 실패", control.line_status(w.store, "deepseek", "c")["blocked"])
        self.assertEqual(w.adapter.launches, [])

    def test_rival_pr_check_after_pr_creation_is_shared_for_c_d_only(self):
        w = self.w
        for method, shared in (("c", True), ("d", True), ("a", False), ("b", False)):
            bid = w.store.create_batch(method=method, producer="deepseek", shard="001", batch="01",
                                       branch=f"{method}-deepseek-001-01", worktree="/x")
            w.gh.open = [{"number": 9, "files": [{"path": cand(1, 1, method, "sonnet")}]}]
            self.assertEqual(w.sup._duplicate_claim(w.store.batch(bid), 7), 9 if shared else None, method)
            w.gh.open = [{"number": 7, "files": [{"path": cand(1, 1, method, "sonnet")}]}]
            self.assertIsNone(w.sup._duplicate_claim(w.store.batch(bid), 7))     # my own PR is not a rival


class AtomicClaim(unittest.TestCase):
    def test_same_cd_batch_cannot_be_reserved_by_two_models(self):
        for method, ok_both in (("c", False), ("d", False), ("a", True), ("b", True)):
            with self.subTest(method):
                w = World()
                models = ["deepseek", "sonnet", "codex", "claude"]
                results, barrier = [], threading.Barrier(len(models))

                def reserve(model):
                    barrier.wait()
                    try:
                        w.store.create_batch(method=method, producer=model, shard="001", batch="01",
                                             branch=f"{method}-{model}-001-01", worktree=f"/x/{model}")
                        results.append("ok")
                    except DuplicateBatch:
                        results.append("dup")
                    except LineBusy:
                        results.append("busy")

                ts = [threading.Thread(target=reserve, args=(m,)) for m in models]
                [t.start() for t in ts]
                [t.join() for t in ts]
                self.assertEqual(results.count("ok"), len(models) if ok_both else 1, results)
                if not ok_both:
                    self.assertEqual(results.count("dup"), len(models) - 1)
                w.tmp.cleanup()

    def test_existing_history_is_untouched_and_other_batches_still_reservable(self):
        w = World()
        w.store.create_batch(method="c", producer="deepseek", shard="001", batch="01", branch="b1", worktree="/1")
        w.store.update(w.store.latest_batch("deepseek", "c")["id"], state="COMPLETE")
        w.store.create_batch(method="c", producer="sonnet", shard="001", batch="02", branch="b2", worktree="/2")
        self.assertEqual(len(w.store.all_batches()), 2)
        with self.assertRaises(DuplicateBatch):
            w.store.create_batch(method="c", producer="codex", shard="001", batch="01", branch="b3", worktree="/3")
        w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
