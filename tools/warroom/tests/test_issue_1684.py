"""Issue #1684: Stage 2 Relation Admission as one serial War Room process (Claude/Codex only), plus the 5th Board row.

Fake AI/GitHub/git: this proves the state machine, selection and exclusivity logic, not a real model run or real
`admission-cli` output (the real verify is a node process on a detached master checkout).
"""
import sqlite3
import unittest
from unittest import mock

from tests.fakes import HEAD1, HEAD2, World
from warroom import batches, control, prompts, stage2, views
from warroom.config import config_problem, registry, stage2_models, stage2_problem
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
        self.assertEqual(stage2.label(b["shard"], b["batch"]), "Shard 001 · Batch 01 · Part 01")
        launch = w.adapter.launches[-1]
        self.assertEqual((launch["model"], launch["effort"]), ("claude-x", "high"))
        for needle in ("Shard 001 · Batch 01 · Part 01", "--shard 001 --batch 01 --part 01", "s2-claude-001-01-01"):
            self.assertIn(needle, launch["prompt"])
        self.assertEqual(w.git.verify_calls, [("part", "001", "01", "01")])
        st = control.line_status(w.store, "claude", S2)
        self.assertEqual(st["stage2"], {"shard": "001", "batch": "01", "part": "01"})

    def test_completed_parts_are_skipped_and_only_exact_verified_parts_count(self):
        self.w = w = s2_world(self)
        w.git.verified |= {("part", "001", "01", "01"), ("part", "001", "01", "02")}
        b = self.pick(w)
        self.assertEqual(b["batch"], "01-03")
        # A past file/PR is not completion: only the kv record written after a successful verify is.
        self.assertTrue(w.store.get(stage2.ok_key("001", "01", "01")))
        self.assertFalse(w.store.get(stage2.ok_key("001", "01", "03")))

    def test_part_five_of_batch_one_then_batch_two_part_one(self):
        self.w = w = s2_world(self)
        w.git.verified |= {("part", "001", "01", f"{p:02d}") for p in range(1, 6)} | {("batch", "001", "01", None)}
        b = self.pick(w)
        self.assertEqual(b["batch"], "02-01")

    def test_batch_and_shard_verify_close_the_last_part(self):
        self.w = w = s2_world(self, canon={1: 100})
        w.git.verified |= {("part", "001", "01", "01")}
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        self.assertEqual(w.store.peek_line("claude", S2)["blocked"].startswith("Batch 001_01"), True)   # batch verify failed
        w.store.set_line("claude", S2, blocked="")
        w.git.verified.add(("batch", "001", "01", None))
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        self.assertIn("shard verify", w.store.peek_line("claude", S2)["blocked"])
        w.store.set_line("claude", S2, blocked="")
        w.git.verified.add(("shard", "001", None, None))
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        self.assertEqual((w.store.incomplete_batches(), w.store.peek_line("claude", S2)["run"]), ([], 0))
        w.git.verify_calls.clear()
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        self.assertEqual(w.git.verify_calls, [])   # every level is cached: nothing is verified twice

    def test_last_shard_short_batch_two_is_a_single_83_record_part(self):
        self.w = w = s2_world(self, canon={1: 583})   # the real shard 428 has this shape: 500 + 83 records = 6 Parts
        canon = {"data/canonical/stdict-0001.jsonl": 583}
        self.assertEqual([stage2.part_count(batches.expected_records(canon, 1, bb)) for bb in (1, 2)], [5, 1])
        w.git.verified |= {("part", "001", "01", f"{p:02d}") for p in range(1, 6)} | {("batch", "001", "01", None)}
        b = self.pick(w)
        self.assertEqual((b["batch"], w.git.verify_calls[-1]), ("02-01", ("part", "001", "02", "01")))
        self.finish_part(w, "claude", "001", "02", "01")
        w.git.verified |= {("batch", "001", "02", None), ("shard", "001", None, None)}
        w.tick(2)
        self.assertEqual(w.store.peek_line("claude", S2)["run"], 0)   # six Parts in all, no Part 02 of batch 02
        self.assertEqual(len(w.store.line_batches("claude", S2)), 1)

    def test_unready_inputs_wait_without_skipping_to_another_shard_in_single(self):
        done = {**ready("01", 500, "001")}
        del done["data/relation-candidates/001/001_01_d_codex.jsonl"]   # D missing in shard 001
        done.update(ready("01", 500, "002"))
        self.w = w = s2_world(self, canon={1: 500, 2: 500}, done=done)
        b = self.pick(w, mode="continuous")   # Continuous moves on to the next shard that is ready
        self.assertEqual((b["shard"], b["batch"]), ("002", "01-01"))
        w.store.set_line("claude", S2, run=0)
        w.store.finish_clear(b, "x")
        w.store.set_line("claude", S2, shard_pin="001")   # a Single run bound to the not-ready shard waits there
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.store.set_line("claude", S2, shard_pin="001")
        w.tick()
        self.assertIsNone(w.store.active_batch("claude", S2))
        self.assertEqual(w.store.peek_line("claude", S2)["run"], 1)   # waiting, not finished
        self.assertIn("Stage 1 입력", control.line_status(w.store, "claude", S2)["wait"])

    def test_single_is_bound_to_the_first_shard_and_stops_when_it_is_complete(self):
        self.w = w = s2_world(self, canon={1: 100, 2: 100})
        b = self.pick(w)
        self.assertEqual(b["shard"], "001")
        self.assertEqual(w.store.peek_line("claude", S2)["shard_pin"], "001")
        self.finish_part(w, "claude", "001", "01", "01")
        w.git.verified |= {("batch", "001", "01", None), ("shard", "001", None, None)}
        w.tick(2)
        self.assertEqual((w.store.incomplete_batches(), w.store.peek_line("claude", S2)["run"]), ([], 0))   # shard 002 untouched
        self.assertEqual(w.store.claimed_keys(S2, "claude"), {("001", "01-01")})

    def test_continuous_goes_on_to_the_next_shard(self):
        self.w = w = s2_world(self, canon={1: 100, 2: 100})
        self.pick(w, mode="continuous")
        self.finish_part(w, "claude", "001", "01", "01")
        w.git.verified |= {("batch", "001", "01", None), ("shard", "001", None, None)}
        w.tick(2)
        b = w.store.active_batch("claude", S2)
        self.assertEqual((b["shard"], b["batch"]), ("002", "01-01"))
        self.assertEqual(w.store.peek_line("claude", S2)["run"], 1)

    def test_nothing_runnable_waits_and_rechecks_without_a_duplicate_run(self):
        self.w = w = s2_world(self, canon={1: 500}, done={})
        control.start(w.store, "claude", S2, "continuous", cfg=w.cfg)
        w.tick(3)
        self.assertEqual((w.store.incomplete_batches(), w.adapter.launches), ([], []))
        self.assertEqual(w.store.peek_line("claude", S2)["run"], 1)
        w.runner.set_batches(canon={1: 500}, done=ready("01", 500))   # the inputs land on master
        w.now += 400
        w.tick()
        self.assertEqual(w.store.active_batch("claude", S2)["batch"], "01-01")

    def test_open_stage_two_pr_in_the_shard_blocks_another_part(self):
        self.w = w = s2_world(self)
        w.gh.open = [{"number": 99, "files": [{"path": "data/relations/relation-001.jsonl"}]}]
        control.start(w.store, "codex", S2, "single", cfg=w.cfg)
        w.tick(2)
        self.assertEqual((w.store.incomplete_batches(), w.adapter.launches), ([], []))
        self.assertIn("열린 Stage 2 PR", control.line_status(w.store, "codex", S2)["wait"])
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
        """AI opens the PR and exits, the PR is merged, the Part verify succeeds on master, cleanup completes."""
        merge_part(w, model, shard, batch, part, n)
        bid = w.store.active_batch(model, S2)["id"]
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.store.batch(bid)["state"], "WAITING_REVIEW")
        w.pr_info(n, HEAD1, state="closed", merged=True, head_ref=f"s2-{model}-{shard}-{batch}-{part}", merge_sha="c" * 40)
        w.git.verified.add(("part", shard, batch, part))
        w.tick(3)
        self.assertEqual(w.store.batch(bid)["state"], "COMPLETE")


class StageTwoLifecycle(unittest.TestCase):
    def setUp(self):
        self.w = s2_world(self)
        control.start(self.w.store, "claude", S2, "continuous", cfg=self.w.cfg)
        self.w.adapter.plan.append({"code": 0, "session": "ses_s2"})
        self.w.tick()

    def to_review(self):
        w = self.w
        merge_part(w, "claude", "001", "01", "01")
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.store.active_batch("claude", S2)["state"], "WAITING_REVIEW")

    def merge(self):
        self.w.pr_info(7, HEAD1, state="closed", merged=True, head_ref="s2-claude-001-01-01", merge_sha="c" * 40)

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
        self.assertEqual((b["state"], b["pr_number"], b["batch"]), ("PAUSED", 7, "01-01"))
        self.assertEqual(len(w.store.line("claude", S2)) and w.store.peek_line("claude", S2)["mode"], "continuous")
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(2)
        self.assertEqual(w.store.active_batch("claude", S2)["id"], b["id"])
        self.assertEqual(len(w.git.created), 1)   # one worktree, one PR

    def test_clear_of_a_stage_two_part_closes_only_its_own_pr(self):
        w = self.w
        self.to_review()
        w.git.remote["s2-claude-001-01-01"] = HEAD1
        w.git.local_head = HEAD1
        b = w.store.active_batch("claude", S2)
        self.assertTrue(control.request_clear(w.store, "claude", S2, b["id"])[0])
        w.tick(3)
        self.assertEqual(w.gh.closed, [7])
        self.assertIsNone(w.store.active_batch("claude", S2))
        self.assertEqual(w.store.peek_line("claude", S2)["shard_pin"], "")

    def test_clear_refuses_a_pr_that_touches_another_shard(self):
        w = self.w
        self.to_review()
        w.gh.files[7] = [{"path": "data/relations/relation-001.jsonl"}, {"path": "data/relations/relation-002.jsonl"}]
        w.git.remote["s2-claude-001-01-01"] = HEAD1
        b = w.store.active_batch("claude", S2)
        control.request_clear(w.store, "claude", S2, b["id"])
        w.tick(2)
        self.assertEqual((w.gh.closed, w.store.active_batch("claude", S2)["state"]), ([], "CLEARING"))

    def test_a_rival_pr_on_the_same_shard_stops_before_review(self):
        w = self.w
        w.gh.open = [{"number": 55, "files": [{"path": "data/relation-drops/drop-001.jsonl"}]}]
        merge_part(w, "claude", "001", "01", "01")
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        b = w.store.active_batch("claude", S2)
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("#55", b["error"])


class StageTwoViews(unittest.TestCase):
    def test_prompt_and_card_text(self):
        for name in ("s2", "s2_recovery"):
            self.assertIn(name, prompts.ALLOWED)
        b = {"method": S2, "shard": "003", "batch": "02-04", "branch": "s2-claude-003-02-04"}
        text = prompts.produce(b)
        self.assertIn("--shard 003 --batch 02 --part 04", text)
        self.assertIn("--shard 003 --batch 02 --part 04", prompts.recovery(b))
        with self.assertRaises(prompts.PromptError):
            prompts.produce({**b, "batch": "02"})
        w = s2_world(self)
        idle = views.card_text(control.line_status(w.store, "claude", S2))
        self.assertEqual(len(idle.split("\n")), views.CARD_LINES)
        self.assertTrue(idle.startswith("Stage 2"))
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.tick()
        active = views.card_text(control.line_status(w.store, "claude", S2)).split("\n")
        self.assertEqual(len(active), views.CARD_LINES)
        self.assertIn("Shard 001 · Batch 01 · Part 01", active[1])
        self.assertTrue(active[0].startswith("Stage 2") and "WORKING" in active[0])

    def test_maintainer_card_text_is_four_lines_and_neutral_when_idle(self):
        idle = views.maintainer_card_text({"state": "IDLE", "text": ""})
        self.assertEqual(len(idle.split("\n")), views.CARD_LINES)
        for state in ("WORKING", "ERROR"):
            card = views.maintainer_card_text({"state": state, "text": "urgent issue #101 · " + "보류: 아주 긴 사유 " * 8})
            lines = card.split("\n")
            self.assertEqual(len(lines), views.CARD_LINES)
            self.assertTrue(all(views.cell_len(x) <= views.CARD_W for x in lines), lines)
            self.assertIn(state, lines[0])


class StageTwoMigration(unittest.TestCase):
    def test_v6_database_gains_the_shard_pin_column(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as d:
            db = Path(d) / "w.db"
            Store(db)
            with sqlite3.connect(db) as c:
                c.execute("ALTER TABLE lines DROP COLUMN shard_pin")
                c.execute("INSERT INTO lines(model,method) VALUES('claude','s2')")
                c.execute("PRAGMA user_version=6")
            s = Store(db)
            self.assertEqual(s.peek_line("claude", "s2")["shard_pin"], "")
            with sqlite3.connect(db) as c:
                self.assertEqual(c.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)


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


try:
    import textual  # noqa: F401
except ImportError:  # pragma: no cover - TUI deps are optional for core tests
    textual = None


@unittest.skipIf(textual is None, "textual not installed")
class StageTwoBoard(unittest.TestCase):
    """The 5th Board row: Claude / Codex Stage 2 cards and the status-only Maintainer card in the DeepSeek column."""

    def app(self):
        from tests.test_tui import make_app
        w = s2_world(self)
        w.cfg["maintainer"] = "claude"
        return w, make_app(w, PRODUCERS)

    def test_row_five_layout_and_neutral_idle_colours(self):
        import asyncio
        from textual.widgets import Select
        from warroom import tui

        async def go():
            w, app = self.app()
            async with app.run_test(size=(180, 50)) as pilot:
                await pilot.pause(0.3)
                self.assertEqual([c.id for c in app.query(tui.Card) if c.method == S2], ["card-claude-s2", "card-codex-s2"])
                self.assertEqual(list(app.query("#col-deepseek #card-maintainer")) != [], True)
                self.assertEqual(list(app.query("#card-deepseek-s2")), [])
                cards = list(app.query(tui.Card)) + list(app.query(tui.MaintainerCard))
                self.assertEqual({c.region.height for c in cards}, {6})
                row5 = [app.query_one(i).region for i in ("#card-claude-s2", "#card-codex-s2", "#card-maintainer")]
                self.assertEqual({r.y for r in row5}, {row5[0].y})                        # one row, three columns
                self.assertGreater(row5[0].y, app.query_one("#card-claude-d").region.y)    # below A/B/C/D
                for i in ("#card-claude-s2", "#card-codex-s2", "#card-maintainer"):
                    self.assertTrue(app.query_one(i).has_class("empty"), i)                # no blue/yellow while idle
                self.assertEqual(app.query_one("#card-claude-a").region.width, app.query_one("#card-claude-s2").region.width)
                self.assertIs(app.query_one("#drain-note").display, False)
                adapter, method = app.query_one("#adapter", Select), app.query_one("#method", Select)
                self.assertIn(S2, [v for _, v in method._options])

        asyncio.run(go())

    def test_stage_two_option_only_for_claude_codex_and_deepseek_falls_back_to_a(self):
        import asyncio
        from textual.widgets import Select

        async def go():
            w, app = self.app()
            async with app.run_test(size=(180, 50)) as pilot:
                await pilot.pause(0.3)
                adapter, method = app.query_one("#adapter", Select), app.query_one("#method", Select)
                opts = lambda: [v for _, v in method._options if v is not Select.BLANK]
                self.assertEqual(opts(), ["a", "b", "c", "d", S2])
                method.value = S2
                await pilot.pause(0.1)
                adapter.value = "opencode"
                await pilot.pause(0.3)
                self.assertEqual((opts(), method.value), (["a", "b", "c", "d"], "a"))
                adapter.value = "codex"
                await pilot.pause(0.3)
                self.assertIn(S2, opts())

        asyncio.run(go())

    def test_start_runs_only_the_selected_stage_two_card_and_a_second_start_is_refused(self):
        import asyncio
        from textual.widgets import Button, Select

        async def go():
            w, app = self.app()
            async with app.run_test(size=(180, 50)) as pilot:
                await pilot.pause(0.3)
                app.query_one("#method", Select).value = S2
                await pilot.pause(0.1)
                app.query_one("#start", Button).press()
                await pilot.pause(0.2)
                self.assertEqual(w.store.peek_line("claude", S2)["run"], 1)
                w.tick()
                await pilot.pause(1.3)
                claude, codex = app.query_one("#card-claude-s2"), app.query_one("#card-codex-s2")
                self.assertFalse(claude.has_class("empty"))
                self.assertIn("Shard 001 · Batch 01 · Part 01", str(claude.render()))
                self.assertTrue(codex.has_class("empty"))
                app.query_one("#adapter", Select).value = "codex"
                await pilot.pause(0.3)
                app.query_one("#method", Select).value = S2
                app.query_one("#start", Button).press()
                await pilot.pause(0.2)
                self.assertEqual(w.store.peek_line("codex", S2)["run"], 0)

        asyncio.run(go())

    def test_maintainer_progress_moves_from_the_top_area_to_its_card(self):
        import asyncio

        async def go():
            w, app = self.app()
            w.store.ensure_maintenance(101)
            async with app.run_test(size=(180, 50)) as pilot:
                await pilot.pause(1.3)
                card = app.query_one("#card-maintainer")
                self.assertFalse(card.has_class("empty"))
                self.assertIn("urgent issue #101", str(card.render()))
                self.assertIs(app.query_one("#drain-note").display, False)
                self.assertNotIn("urgent", str(app.query_one("#drain-note").render()))

        asyncio.run(go())
