"""#1367: Method prompt files and the C/D model-shared batch queue."""
import os
import subprocess
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
from warroom.shell import Runner
from warroom.store import DuplicateBatch, LineBusy
from warroom.supervisor import DuplicateClaim

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
            self.assertRegex(text, "브랜치 `?a-deepseek-001-01`?", method)   # A (#1765) quotes the branch in backticks, B/C/D do not
            self.assertNotIn("{{", text)
            self.assertLess(len(text.splitlines()), 40, method)       # still a pointer to the issue, not a copy of its rules (B/C already exceeded 25 on master)
        self.assertIn("#1155를 참조하거나 닫지 않는다", prompts.produce({**ROW, "method": "c"}))   # prompts no longer ask for `Refs`
        self.assertIn("#1156을 참조하거나 닫지 않는다", prompts.produce({**ROW, "method": "d"}))
        self.assertIn("#860을 링크하거나 닫지 않는다", prompts.produce({**ROW, "method": "a"}))
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


class UnknownPrFileLists(unittest.TestCase):
    """A PR's file list that is missing/None is unknown on EVERY path that reads it, never "no files"."""

    def test_both_readers_fail_closed_and_trust_only_a_known_list(self):
        w = multi_world()
        bid = w.store.create_batch(method="c", producer="deepseek", shard="001", batch="01",
                                   branch="c-deepseek-001-01", worktree="/x")
        b = w.store.batch(bid)
        mine = {"number": 7, "files": [{"path": cand(1, 1, "c", "deepseek")}]}
        for name, other, want in [
            ("known empty list", {"number": 9, "files": []}, "none"),
            ("known unrelated files", {"number": 9, "files": [{"path": "README.md"}, {}]}, "none"),
            ("rival C file of another model", {"number": 9, "files": [{"path": cand(1, 1, "c", "sonnet")}]}, "rival"),
            ("files key missing", {"number": 9}, "unknown"),
            ("files None", {"number": 9, "files": None}, "unknown"),
            ("files not a list", {"number": 9, "files": "x"}, "unknown"),
        ]:
            with self.subTest(name):
                w.gh.open = [mine, other]
                if want == "unknown":
                    with self.assertRaises(DuplicateClaim):
                        w.sup._duplicate_claim(b, 7)
                    with self.assertRaises(batches.BatchError):
                        batches.pr_candidates(other)
                    with self.assertRaises(batches.BatchError):
                        batches.next_batch(ScriptedRunner(), ".", {}, ref="r", method="c", producer="deepseek",
                                           open_prs=[other], owned=set())
                else:
                    self.assertEqual(w.sup._duplicate_claim(b, 7), 9 if want == "rival" else None)
        w.gh.open = [{"number": 7}]                       # my own PR's list is irrelevant to the rival check
        self.assertIsNone(w.sup._duplicate_claim(b, 7))
        w.tmp.cleanup()

    def test_supervisor_stops_in_error_when_a_rival_pr_list_is_unknown_after_pr_creation(self):
        w = multi_world()
        w.runner.set_batches({1: 1000}, {})
        w.start("single", "deepseek", "c")
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": lambda: self._open_pr(w)})
        w.tick()
        w.gh.open = [{"number": 7, "files": [{"path": cand(1, 1, "c", "deepseek")}]}, {"number": 9, "files": None}]
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        b = w.row("deepseek", "c")
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("파일 목록을 알 수 없", b["error"])
        w.tmp.cleanup()

    @staticmethod
    def _open_pr(w):
        w.pr_info(7, HEAD1)
        w.gh.by_branch["c-deepseek-001-01"] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]


class RealGitMaster(unittest.TestCase):
    """Real Git objects: `git grep -c ''` prints nothing for a committed 0-byte file, so scripted counts cannot cover it."""

    def master(self, files: dict) -> Path:
        d = Path(self._tmp.name) / f"repo{len(list(Path(self._tmp.name).iterdir()))}"
        d.mkdir()
        env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
               "GIT_COMMITTER_EMAIL": "t@t"}
        git = lambda *a: subprocess.run(["git", *a], cwd=d, env=env, check=True, capture_output=True)
        git("init", "-q")
        files = {"data/canonical/stdict-0001.jsonl": 1000, "data/canonical/stdict-0002.jsonl": 600, **files}
        for rel, lines in files.items():
            f = d / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text("x\n" * lines)
        git("add", "-A")
        git("commit", "-q", "-m", "m")
        return d

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def pick(self, files, method, producer="deepseek"):
        root = self.master(files)
        return batches.next_batch(Runner(), root, dict(os.environ), ref="HEAD", method=method, producer=producer,
                                  open_prs=[], owned=set())

    def test_git_grep_really_omits_a_committed_empty_file(self):
        root = self.master({cand(1, 1, "c", "codex"): 0, cand(1, 2, "c", "codex"): 2})
        out = subprocess.run(["git", "grep", "-c", "", "HEAD", "--", "data/relation-candidates/*/*_c_*.jsonl"],
                             cwd=root, capture_output=True, text=True).stdout
        self.assertNotIn("001_01_c_codex", out)       # the premise of the finding
        self.assertIn("001_02_c_codex", out)

    def test_table(self):
        none = None
        for name, files, method, producer, want in [
            ("C: 500 lines by another model = done", {cand(1, 1, "c", "codex"): 500}, "c", "deepseek", ("001", "02")),
            ("C: nothing on master", {}, "c", "deepseek", ("001", "01")),
            ("C: 0-byte file", {cand(1, 1, "c", "codex"): 0}, "c", "deepseek", batches.BatchError),
            ("D: 0-byte file", {cand(1, 1, "d", "claude"): 0}, "d", "deepseek", batches.BatchError),
            ("C: 0-byte beside a good one", {cand(1, 1, "c", "claude"): 0, cand(1, 2, "c", "codex"): 500}, "c", "deepseek",
             batches.BatchError),
            ("C: 499 lines", {cand(1, 1, "c", "codex"): 499}, "c", "deepseek", batches.BatchError),
            ("C: 501 lines", {cand(1, 1, "c", "codex"): 501}, "c", "deepseek", batches.BatchError),
            ("C: two models, one batch", {cand(1, 1, "c", "codex"): 500, cand(1, 1, "c", "claude"): 500}, "c", "deepseek",
             batches.BatchError),
            ("C: next after three done is the short 100-record batch", {cand(1, 1, "c", "codex"): 500,
                                                                        cand(1, 2, "c", "codex"): 500,
                                                                        cand(2, 1, "c", "claude"): 500},
             "c", "deepseek", ("002", "02")),
            ("C: short last batch 99 lines", {cand(1, 1, "c", "codex"): 500, cand(1, 2, "c", "codex"): 500,
                                              cand(2, 1, "c", "codex"): 500, cand(2, 2, "c", "claude"): 99},
             "c", "deepseek", batches.BatchError),
            ("A: other model's 0-byte file does not touch deepseek", {cand(1, 1, "a", "codex"): 0}, "a", "deepseek",
             ("001", "01")),
            ("A: own 0-byte file", {cand(1, 1, "a", "deepseek"): 0}, "a", "deepseek", batches.BatchError),
            ("A: other model's 500 lines does not complete", {cand(1, 1, "a", "codex"): 500}, "a", "deepseek",
             ("001", "01")),
            ("B: own 500 lines done", {cand(1, 1, "b", "deepseek"): 500}, "b", "deepseek", ("001", "02")),
            ("D independent of a corrupt C file", {cand(1, 1, "c", "codex"): 0}, "d", "deepseek", ("001", "01")),
            ("experiments/ copy is no Candidate", {"experiments/x/" + cand(1, 1, "c", "codex"): 0}, "c", "deepseek",
             ("001", "01")),
        ]:
            with self.subTest(name):
                if want is batches.BatchError:
                    with self.assertRaises(batches.BatchError):
                        self.pick(files, method, producer)
                else:
                    b = self.pick(files, method, producer)
                    self.assertEqual(None if b is None else (b.shard, b.batch), want)


class CandidatePathBoundary(unittest.TestCase):
    def test_only_repo_root_candidate_paths_count(self):
        good = cand(1, 1, "c", "codex")
        for name, path, want in [
            ("production path", good, [("001", "01", "c", "codex")]),
            ("experiments copy", "experiments/sample/" + good, []),
            ("nested copy", "docs/" + good, []),
            ("leading slash", "/" + good, []),
            ("backup suffix", good + ".bak", []),
            ("shard prefix mismatch", "data/relation-candidates/001/002_01_c_codex.jsonl", []),
            ("unknown method", "data/relation-candidates/001/001_01_e_codex.jsonl", []),
            ("trailing newline", good + "\n", []),
        ]:
            with self.subTest(name):
                self.assertEqual(batches.pr_candidates({"number": 1, "files": [{"path": path}]}), want)
        runner = ScriptedRunner()
        runner.set_batches({1: 1000}, {})
        claimed = batches.next_batch(runner, ".", {}, ref="r", method="c", producer="deepseek",
                                     open_prs=[{"number": 5, "files": [{"path": "experiments/sample/" + good}]}],
                                     owned=set())
        self.assertEqual((claimed.shard, claimed.batch), ("001", "01"))      # an experiment PR claims nothing


class MalformedPlaceholders(unittest.TestCase):
    def test_every_non_token_double_brace_is_rejected_but_values_are_data(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            vals = {"batch": "001_01", "branch": "b"}
            for name, text, ok in [
                ("valid", "x {{batch}} {{ branch }}", True),
                ("hyphen", "x {{batch-name}} {{branch}}", False),
                ("dotted", "x {{batch.id}} {{branch}}", False),
                ("digit first", "{{1batch}} {{batch}}", False),
                ("empty", "{{}} {{batch}}", False),
                ("blank", "{{ }} {{batch}}", False),
                ("unterminated", "{{batch {{branch}}", False),
                ("closing only", "{{batch}} }} {{branch}}", False),
                ("opening only", "{{ {{batch}}", False),
                ("single braces are plain text", "{\"a\": 1} {{batch}} {{branch}}", True),
            ]:
                with self.subTest(name):
                    (d / "a.md").write_text(text)
                    if ok:
                        out = prompts.render("a", vals, d)
                        self.assertNotIn("{{", out)
                    else:
                        with self.assertRaises(prompts.PromptError):
                            prompts.render("a", vals, d)
            (d / "fix.md").write_text("{{pr}} {{head}} {{branch}} {{review_events}} {{session_note}}")
            out = prompts.render("fix", {"pr": 7, "head": "h", "branch": "b", "session_note": "",
                                         "review_events": "-1 {{batch-name}} }} {{"}, d)
            self.assertIn("{{batch-name}} }} {{", out)           # reviewer text is data, never validated as a template

    def test_launch_starts_no_ai_for_a_malformed_template(self):
        with tempfile.TemporaryDirectory() as d:
            for n in prompts.ALLOWED:
                (Path(d) / f"{n}.md").write_text("[ok] " + " ".join("{{%s}}" % k for k in sorted(prompts.ALLOWED[n])))
            (Path(d) / "c.md").write_text("배치 {{batch-name}} / 브랜치 {{branch}}")
            with mock.patch.object(prompts, "PROMPT_DIR", Path(d)):
                w = multi_world()
                w.start("single", "deepseek", "c")
                w.tick(2)
                self.assertEqual(w.adapter.launches, [])
                b = w.row("deepseek", "c")
                self.assertEqual(b["state"], "ERROR")
                self.assertIn("이중 중괄호", b["error"])
                self.assertTrue(any("이중 중괄호" in e["msg"] for e in w.store.recent_events(20)))
                w.start("single", "deepseek", "a")                # a healthy template still runs
                w.tick()
                self.assertEqual(len(w.adapter.launches), 1)
                w.tmp.cleanup()


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
