"""Issue #1684: Stage 2 Relation Admission as one serial War Room process (Claude/Codex only), plus the 5th Board row.

Fake AI/GitHub/git: this proves the state machine, selection and exclusivity logic, not a real model run or real
`admission-cli` output (the real verify is a node process on a detached master checkout).
"""
import json
import sqlite3
import unittest
from unittest import mock

from tests.fakes import HEAD1, World
from warroom import batches, control, prompts, stage2
from warroom.config import config_problem, stage2_models, stage2_problem
from warroom.store import SCHEMA_VERSION, LineBusy, Store

PRODUCERS = {
    "claude": {"adapter": "claude", "model": "claude-x", "effort": "high"},
    "codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"},
    "deepseek": {"adapter": "opencode", "models": {"free": "p/free-x-free", "go": "p/go"}},
}
S2 = "s2"


def ready(batch, n, shard="001"):
    """The six required Stage 1 Candidate files of one batch, with their full record count."""
    return {f"data/relation-candidates/{shard}/{shard}_{batch}_{m}_{who}.jsonl": n
            for m, who in (("a", "claude"), ("a", "codex"), ("b", "claude"), ("b", "codex"), ("c", "deepseek"), ("d", "codex"))}


def s2_world(test, canon=None, done=None):
    """A World with Claude/Codex/DeepSeek, `canon` shards (the factory's shard count follows it) and ready Stage 1 inputs."""
    w = World()
    patcher = mock.patch.object(batches, "SHARDS", max(canon or {1: 0}))
    patcher.start()
    test.addCleanup(patcher.stop)
    test.addCleanup(w.tmp.cleanup)
    w.cfg["producers"] = PRODUCERS
    w.runner.models += []
    canon = canon or {1: 1000}
    if done is None:
        done = {}
        for shard, total in canon.items():
            for b, n in ((1, min(total, 500)), (2, max(total - 500, 0))):
                if n:
                    done.update(ready(f"{b:02d}", n, f"{shard:03d}"))
    w.runner.set_batches(canon=canon, done=done)
    return w


def merge_part(w, model, shard, batch, part, n=7, head=HEAD1):
    """The Part's AI opens its PR, the PR merges and the master verify of the Part will succeed."""
    branch = f"s2-{model}-{shard}-{batch}-{part}"
    w.pr_info(n, head, head_ref=branch)
    w.gh.by_branch[branch] = [{"number": n, "state": "OPEN", "headRefOid": head}]
    w.gh.files[n] = [{"path": f"data/relations/relation-{shard}.jsonl"}, {"path": f"data/relation-drops/drop-{shard}.jsonl"}]


def write_checkpoint(w, *, merged=False, shard="001", batch="01", part="01", next_chunk=2):
    from pathlib import Path
    b = w.store.active_batch("claude", S2) or w.store.active_batch("codex", S2)
    path = Path(b["worktree"]) / ".warroom-scratch" / f"relation-admission-{shard}-{batch}-{part}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "version": 1, "shard": shard, "batch": batch, "part": part, "complete": True, "stats": {},
        "next_chunk_number": next_chunk, "pending_chunk": None, "merged": merged,
        "items": [{"sense_id": "source-sense", "candidates": [{"text": "fixture", "decision": {"disposition": "drop"}}]}],
    }), "utf-8")


class StageTwoExclusivity(unittest.TestCase):
    def setUp(self):
        self.w = s2_world(self)

    def test_only_claude_and_codex_may_run_stage_two(self):
        w = self.w
        self.assertEqual(stage2_models(w.cfg), ["claude", "codex"])
        for model, allowed in (("claude", True), ("codex", True), ("deepseek", False), ("nobody", False)):
            self.assertEqual(stage2_problem(w.cfg, model) is None, allowed, model)
        ok, msg = control.start(w.store, "deepseek", S2, "single", cfg=w.cfg)
        self.assertFalse(ok)
        self.assertIn("Claude 또는 Codex", msg)
        self.assertFalse(control.start(w.store, "claude", S2, "single")[0])   # no config proof: fail closed
        self.assertEqual(w.store.lines(), [])

    def test_supervisor_blocks_a_direct_deepseek_stage_two_reservation(self):
        w = self.w
        w.store.set_line("deepseek", S2, run=1, mode="single")   # bypasses control.start entirely
        w.tick()
        self.assertEqual(w.store.incomplete_batches(), [])
        ln = w.store.peek_line("deepseek", S2)
        self.assertEqual(ln["run"], 0)
        self.assertIn("Claude 또는 Codex", ln["blocked"])

    def test_second_stage_two_start_is_refused_atomically_whatever_the_model(self):
        w = self.w
        self.assertTrue(control.start(w.store, "claude", S2, "single", cfg=w.cfg)[0])
        ok, msg = control.start(w.store, "codex", S2, "single", cfg=w.cfg)
        self.assertFalse(ok)
        self.assertIn("claude", msg)
        w.tick()   # claude owns an unfinished Part now
        self.assertEqual(w.store.active_batch("claude", S2)["state"], "PRODUCING")
        ok, msg = control.start(w.store, "codex", S2, "continuous", cfg=w.cfg)
        self.assertFalse(ok)
        self.assertIn("미완료 Part", msg)
        self.assertEqual(w.store.peek_line("codex", S2)["run"], 0)
        with self.assertRaises(LineBusy):   # the Supervisor's own batch insert has the same limit (races, restarts)
            w.store.create_batch(method=S2, producer="codex", shard="001", batch="01-02", branch="b",
                                 worktree="w", from_run=False)

    def test_stage_one_lines_run_beside_stage_two(self):
        w = self.w
        w.runner.models += ["p/free-x-free"]
        self.assertTrue(control.start(w.store, "claude", S2, "single", cfg=w.cfg)[0])
        self.assertTrue(control.start(w.store, "deepseek", "a", "single", cfg=w.cfg)[0])
        w.tick()
        self.assertEqual(w.store.active_batch("claude", S2)["batch"], "01-01")
        self.assertIsNotNone(w.store.active_batch("deepseek", "a"))

    def test_other_model_restart_does_not_steal_an_unfinished_part(self):
        w = self.w
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        control.stop_all(w.store)
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual(b["state"], "PAUSED")
        ok, msg = control.start(w.store, "codex", S2, "single", cfg=w.cfg)
        self.assertFalse(ok)
        self.assertIn("Retry", msg)
        self.assertEqual((b["worktree"], b["branch"]), (w.store.active_batch("claude", S2)["worktree"], "s2-claude-001-01-01"))

    def test_reserved_names_cannot_be_stage_one_methods(self):
        w = self.w
        for bad in ("s2", "S2", "m"):
            w.cfg["methods"] = ["a", bad]
            self.assertIn("예약", config_problem(w.cfg) or "", bad)
        w.cfg["methods"] = ["a", "b", "c", "d"]
        self.assertIsNone(config_problem(w.cfg))


class StageTwoSelection(unittest.TestCase):
    def pick(self, w, model="claude", mode="single"):
        control.start(w.store, model, S2, mode, cfg=w.cfg)
        w.tick()
        return w.store.active_batch(model, S2)

    def test_first_part_names_its_shard_batch_part_and_pins_the_model(self):
        self.w = w = s2_world(self)
        b = self.pick(w)
        self.assertEqual((b["shard"], b["batch"], b["branch"]), ("001", "01-01", "s2-claude-001-01-01"))
        launch = w.adapter.launches[-1]
        self.assertEqual((launch["model"], launch["effort"]), ("claude-x", "high"))
        for needle in ("001-01-01-001", "s2-claude-001-01-01"):
            self.assertIn(needle, launch["prompt"])
        self.assertEqual(w.git.chunk_views, [(b["worktree"], "001", "01", "01", True)])   # the Supervisor prepares this exact Part
        self.assertEqual(w.git.verify_calls, [])  # no completed Part is verified at selection

    def test_unready_stops_until_owner_restarts(self):
        self.w = w = s2_world(self, done={})
        control.start(w.store, "claude", S2, "continuous", cfg=w.cfg)
        w.tick(3)
        self.assertEqual(w.store.peek_line("claude", S2)["run"], 0)
        self.assertEqual(w.store.incomplete_batches(), [])
        w.runner.set_batches(canon={1: 1000}, done=ready("01", 500))
        w.tick(2)
        self.assertEqual(w.store.incomplete_batches(), [])
        control.start(w.store, "claude", S2, "continuous", cfg=w.cfg)
        w.tick()
        self.assertEqual(w.store.active_batch("claude", S2)["batch"], "01-01")

    def test_open_stage_two_pr_in_the_shard_blocks_another_part(self):
        self.w = w = s2_world(self)
        w.gh.open = [{"number": 99, "files": [{"path": "data/relations/relation-001.jsonl"}]}]
        control.start(w.store, "codex", S2, "single", cfg=w.cfg)
        w.tick(2)
        self.assertEqual((w.store.incomplete_batches(), w.adapter.launches), ([], []))
        w.gh.open = [{"number": 99, "files": [{"path": "data/relations/relation-002.jsonl"}]}]   # other shard: no conflict
        w.now += 400
        w.tick()
        self.assertEqual(w.store.active_batch("codex", S2)["batch"], "01-01")

    def test_unknown_open_pr_file_list_never_means_no_conflict(self):
        self.w = w = s2_world(self)
        w.gh.open = [{"number": 99}]
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        self.assertEqual(w.store.incomplete_batches(), [])
        self.assertIn("파일 목록을 알 수 없어", w.store.peek_line("claude", S2)["blocked"])

    def finish_part(self, w, model, shard, batch, part, n=7):
        """One chunk session saves, then deterministic optional/final steps open the PR and merge verification completes."""
        bid = w.store.active_batch(model, S2)["id"]
        chunk_pid = w.adapter.launches[-1]["pid"]
        w.adapter.running[chunk_pid]["effect"] = lambda: write_checkpoint(w, shard=shard, batch=batch, part=part)
        w.adapter.finish(chunk_pid)
        w.tick()
        b = w.store.batch(bid)
        self.assertEqual(b["state"], "WAITING_REVIEW")
        n = b["pr_number"]
        w.gh.prs[n] |= {"state": "closed", "merged": True, "merge_commit_sha": "c" * 40}
        w.gh.latest_stage2_pr = {"title": f"[S2/{model}] {shard}_{batch} Part {part}", "merge_commit_sha": "c" * 40}
        w.git.ancestor_pairs.add(("c" * 40, w.git.base_sha))
        w.git.verified.add(("part", shard, batch, part))
        w.tick(3)
        self.assertEqual(w.store.batch(bid)["state"], "COMPLETE")


class StageTwoPartLayout(unittest.TestCase):
    SHA = "e" * 40

    def choose(self, previous=None, *, inputs=None, pin="", marker=None):
        w = s2_world(self, done=inputs or {})
        if marker is not None:
            w.store.set(stage2.layout_key("006"), marker)
        return stage2.choose(w.runner, w.paths.repo_root, w.sup.env, ref=self.SHA, sha=self.SHA,
                             open_prs=[], kv=w.store, latest_pr={"title": previous} if previous else None, pin=pin)

    def test_sequential_boundaries(self):
        for previous, expected in [
            (None, ("001", "01", "01")),
            ("[Stage 2] 005_02 Part 05", ("006", "01", "01")),
            ("[S2/Codex] 006_01 Part 01", ("006", "01", "02")),
            ("[S2/Codex] 024_02 Part 02", ("025", "01", "01")),
            ("[S2/Codex] 428_01 Part 02", ("428", "02", "01")),
        ]:
            with self.subTest(previous=previous):
                shard, batch, part = expected
                result = self.choose(previous, inputs=ready(batch, 83 if (shard, batch) == ("428", "02") else 500, shard))
                self.assertEqual((result.part.shard, result.part.batch, result.part.part), expected)
        self.assertEqual(self.choose("[S2/Codex] 428_02 Part 01").status, "done")

    def test_missing_input_never_skips_and_reports_target(self):
        result = self.choose("[S2/Codex] 006_01 Part 01", inputs=ready("01", 500, "007"))
        self.assertEqual(result.status, "unready")
        self.assertIn("006_01 Part 02", result.note)
        self.assertIn("입력 미준비", result.note)

    def test_marker_and_pin(self):
        previous = "[S2/Codex] 005_02 Part 05"
        self.assertEqual(self.choose(previous, inputs=ready("01", 500, "006")).part.layout_marker, "250")
        self.assertEqual(self.choose(previous, inputs=ready("01", 500, "006"), marker="100").status, "stop")
        self.assertEqual(self.choose(previous, pin="005").status, "done")

    def test_bad_title_and_layout_fail_closed(self):
        with self.assertRaises(batches.BatchError):
            self.choose("[S2/Codex] 006_01 Part 03")
        w = s2_world(self)
        w.runner.layout_text = "invalid"
        with self.assertRaises(batches.BatchError):
            stage2.choose(w.runner, w.paths.repo_root, w.sup.env, ref=self.SHA, sha=self.SHA, open_prs=[], kv=w.store)


class StageTwoLifecycle(unittest.TestCase):
    def setUp(self):
        self.w = s2_world(self)
        control.start(self.w.store, "claude", S2, "continuous", cfg=self.w.cfg)
        self.w.adapter.plan.append({"code": 0, "session": "ses_chunk",
                                    "effect": lambda: write_checkpoint(self.w)})
        self.w.tick()

    def to_review(self):
        w = self.w
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual(b["state"], "WAITING_REVIEW")
        w.gh.files[b["pr_number"]] = [
            {"path": "data/relations/relation-001.jsonl"},
            {"path": "data/relation-drops/drop-001.jsonl"},
        ]

    def merge(self):
        b = self.w.store.active_batch("claude", S2)
        self.w.gh.prs[b["pr_number"]] |= {"state": "closed", "merged": True, "merge_commit_sha": "c" * 40}
        self.w.gh.latest_stage2_pr = {"title": "[S2/claude] 001_01 Part 01", "merge_commit_sha": "c" * 40}
        self.w.git.ancestor_pairs.add(("c" * 40, self.w.git.base_sha))

    def test_next_part_never_starts_before_merge_and_master_verify(self):
        w = self.w
        self.to_review()
        w.tick(3)   # PR exists but is not merged: no second Part, no second AI
        self.assertEqual(len(w.adapter.launches), 1)
        self.merge()
        w.tick(3)   # merged, but the exact Part verify fails on the latest master: ERROR, worktree kept
        b = w.store.active_batch("claude", S2)
        bid = b["id"]
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(b["paused_from"], "CLEANUP")
        self.assertIn("Shard 001 · Batch 01 · Part 01", b["error"])
        self.assertEqual((len(w.adapter.launches), w.git.removed), (1, []))
        self.assertFalse(w.store.get(stage2.ok_key("001", "01", "01")))
        w.git.verified.add(("part", "001", "01", "01"))   # the owner fixes it; Retry re-verifies without any AI run
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(4)
        self.assertEqual(w.store.batch(bid)["state"], "COMPLETE")
        self.assertEqual(w.store.get(stage2.ok_key("001", "01", "01")), "m" * 40)
        w.tick()
        self.assertEqual(w.store.active_batch("claude", S2)["batch"], "01-02")   # next Part only now

    def test_drain_finishes_the_current_part_then_clears_without_starting_another(self):
        w = self.w
        bid = w.store.active_batch("claude", S2)["id"]
        control.drain_all(w.store, [("claude", S2)])
        self.assertEqual(w.store.peek_line("claude", S2)["drain"], 1)
        StageTwoSelection.finish_part(self, w, "claude", "001", "01", "01")

        ln = w.store.peek_line("claude", S2)
        self.assertEqual((ln["run"], ln["drain"], ln["shard_pin"]), (0, 0, ""))
        self.assertEqual(w.store.batch(bid)["state"], "COMPLETE")
        w.tick()
        self.assertEqual(len(w.store.line_batches("claude", S2)), 1)

    def test_merge_commit_not_yet_on_master_waits(self):
        w = self.w
        self.to_review()
        self.merge()
        w.git.on_base = False
        w.git.verified.add(("part", "001", "01", "01"))
        bid = w.store.active_batch("claude", S2)["id"]
        calls = len(w.git.verify_calls)
        w.tick(3)
        self.assertEqual(w.store.batch(bid)["state"], "CLEANUP")   # waits: no verify against a master without the merge
        self.assertEqual(len(w.git.verify_calls), calls)
        w.git.on_base = True
        w.tick(3)
        self.assertEqual(w.store.batch(bid)["state"], "COMPLETE")

    def test_stop_preserves_the_part_and_retry_resumes_the_same_batch_and_mode(self):
        w = self.w
        self.to_review()
        control.stop_line(w.store, "claude", S2)
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["state"], b["pr_number"], b["batch"]), ("PAUSED", 100, "01-01"))
        self.assertEqual(len(w.store.line("claude", S2)) and w.store.peek_line("claude", S2)["mode"], "continuous")
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        self.assertEqual(w.store.active_batch("claude", S2)["id"], b["id"])
        self.assertEqual(len(w.git.created), 1)   # one worktree, one PR

    def test_clear_of_a_stage_two_part_closes_only_its_own_pr(self):
        w = self.w
        self.to_review()
        b = w.store.active_batch("claude", S2)
        w.git.remote[b["branch"]] = b["head_sha"]
        w.git.local_head = b["head_sha"]
        self.assertTrue(control.request_clear(w.store, "claude", S2, b["id"])[0])
        w.tick(3)
        self.assertEqual(w.gh.closed, [b["pr_number"]])
        self.assertIsNone(w.store.active_batch("claude", S2))
        self.assertEqual(w.store.peek_line("claude", S2)["shard_pin"], "")

    def test_clear_refuses_a_pr_that_touches_another_shard(self):
        w = self.w
        self.to_review()
        b = w.store.active_batch("claude", S2)
        w.gh.files[b["pr_number"]] = [{"path": "data/relations/relation-001.jsonl"}, {"path": "data/relations/relation-002.jsonl"}]
        w.git.remote[b["branch"]] = b["head_sha"]
        control.request_clear(w.store, "claude", S2, b["id"])
        w.tick(2)
        self.assertEqual((w.gh.closed, w.store.active_batch("claude", S2)["state"]), ([], "CLEARING"))

    def test_a_rival_pr_on_the_same_shard_stops_before_review(self):
        w = self.w
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.gh.open = [{"number": 55, "files": [{"path": "data/relation-drops/drop-001.jsonl"}]}]
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("#55", b["error"])


class StageTwoPromptLoader(unittest.TestCase):
    def test_a_malformed_part_is_refused_by_the_loader(self):
        b = {"method": S2, "shard": "003", "batch": "02-04", "branch": "s2-claude-003-02-04"}
        prompts.produce(b)
        prompts.recovery(b)
        with self.assertRaises(prompts.PromptError):
            prompts.produce({**b, "batch": "02"})


if __name__ == "__main__":
    unittest.main()


class StageTwoRealGit(unittest.TestCase):
    """The real `Git.verify_stage2` against a temp repo: a detached checkout of exactly the requested master commit."""

    def sh(self, *args, cwd=None):
        import subprocess
        return subprocess.run(args, cwd=cwd or self.repo, check=True, capture_output=True, text=True).stdout.strip()

    def commit(self, ok_exit: int) -> str:
        script = self.repo / "scripts/relation/admission-cli.mjs"
        script.parent.mkdir(parents=True, exist_ok=True)
        script.write_text(f"console.log('args', process.argv.slice(2).join(' '));\nprocess.exit({ok_exit});\n")
        self.sh("git", "add", "-A")
        self.sh("git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", f"exit {ok_exit}")
        return self.sh("git", "rev-parse", "HEAD")

    def setUp(self):
        import os
        import tempfile
        from pathlib import Path
        from warroom.gitops import Git
        from warroom.shell import Runner
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.repo, self.wts = Path(tmp.name) / "repo", Path(tmp.name) / "worktrees"
        self.repo.mkdir()
        self.sh("git", "init", "-q", "-b", "master")
        self.git = Git(Runner(), self.repo, dict(os.environ), self.wts)

    def test_verify_runs_the_exact_scope_on_exactly_the_given_commit(self):
        from warroom.gitops import GitError
        good, bad = self.commit(0), self.commit(1)
        ok, tail = self.git.verify_stage2(good, "part", "003", "01", "04")
        self.assertEqual((ok, self.sh("git", "rev-parse", "HEAD", cwd=self.wts / "s2-verify")), (True, good))
        ok, tail = self.git.verify_stage2(bad, "batch", "003", "01", None)   # the same checkout moves to the next master
        self.assertFalse(ok)
        self.assertIn("args verify --shard 003 --batch 01", tail)
        self.assertEqual(self.sh("git", "rev-parse", "HEAD", cwd=self.wts / "s2-verify"), bad)
        self.assertTrue(self.git.verify_stage2(good, "shard", "003", None, None)[0])
        for args in (("part", "003", "01", None), ("batch", "003", None, "02"), ("shard", "003", "01", None), ("all", "003", None, None)):
            with self.assertRaises(GitError):   # a scope that does not match its kind never reaches node
                self.git.verify_stage2(good, *args)

    def test_a_non_detached_directory_is_not_moved(self):
        from warroom.gitops import GitError
        good = self.commit(0)
        self.sh("git", "worktree", "add", "-q", "-b", "other", str(self.wts / "s2-verify"), good)
        with self.assertRaises(GitError):
            self.git.verify_stage2(good, "part", "003", "01", "01")

    def test_contains_on_base_is_a_real_ancestry_check(self):
        first = self.commit(0)
        self.sh("git", "update-ref", "refs/remotes/origin/master", first)
        second = self.commit(1)
        self.assertTrue(self.git.contains_on_base(first, "master"))
        self.assertFalse(self.git.contains_on_base(second, "master"))
