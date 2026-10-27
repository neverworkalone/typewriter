"""Issue #2033 (PR 2): Method C runs as serial chunk sessions with a deterministic, idempotent finalization."""
import json
import unittest
from pathlib import Path

from tests.fakes import HEAD1, HEAD2, World
from warroom import control, literary, prompts, stage2
from warroom.supervisor import RecoveryBlocked

CP_NAME = "001_01_c_deepseek.checkpoint.json"


class CWorld(World):
    def __init__(self, senses=30, **kw):
        super().__init__(**kw)
        index = Path(self.tmp.name) / "approved.sqlite"
        index.write_bytes(b"x")
        self.cfg["literary_index_path"] = str(index)
        self.runner.literary.senses = senses
        self.runner.literary.head = HEAD1

    def wt(self):
        return Path(self.row("deepseek", "c")["worktree"])

    def active(self):
        return json.loads((self.wt() / literary.ACTIVE).read_text())

    def ai(self, mark=None, code=0, session="ses_c"):
        """Queue a fake AI whose effect stores the active chunk's senses (or only `mark` of them)."""
        def effect():
            ids = self.active()["sense_ids"]
            self.runner.literary.mark(self.wt(), f".warroom-scratch/{CP_NAME}", ids if mark is None else ids[:mark])
        self.adapter.plan.append({"code": code, "session": session, "effect": effect})

    def finish_last(self):
        self.adapter.finish(self.adapter.launches[-1]["pid"])

    def kinds(self):
        return [r["kind"] for r in reversed(self.store.runs(self.row("deepseek", "c")["id"]))]

    def add_branch_pr(self, number, *, state="closed", merged=False, head="b" * 40, merged_at=None):
        b = self.row("deepseek", "c")
        branch = b["branch"]
        self.gh.prs[number] = {"number": number, "state": state, "merged": merged, "head_sha": head,
                               "head_ref": branch, "url": "", "merge_commit_sha": ""}
        summary = {"number": number, "state": state.upper(), "headRefOid": head}
        if state == "closed":
            summary["mergedAt"] = merged_at
        self.gh.by_branch.setdefault(branch, []).append(summary)
        self.gh.files[number] = [{"path": f"data/relation-candidates/{b['shard']}/"
                                           f"{b['shard']}_{b['batch']}_{b['method']}_{b['producer']}.jsonl"}]
        if state == "open":
            self.git.remote[branch] = head
        return b


class SerialChunks(unittest.TestCase):
    def setUp(self):
        self.w = CWorld()
        self.addCleanup(self.w.tmp.cleanup)

    def test_new_session_per_chunk_inline_view_then_one_pr(self):
        w = self.w
        w.start("single", "deepseek", "c")
        for n in range(3):
            w.ai(session=f"ses_{n}")
        for n in range(3):
            w.tick()
            if n == 0:   # init exactly once, the card carries the whole view and the chunk policy env
                launch = w.adapter.launches[-1]
                self.assertEqual(launch["stage2_chunk_git"], "1")
                self.assertTrue(launch["approved_literary_db"])
                ids = w.active()["sense_ids"]
                self.assertEqual(len(ids), 12)
                self.assertTrue(all(f"## {i} — " in launch["prompt"] for i in ids))
                self.assertIn(prompts.VIEW_BEGIN, launch["prompt"])
                self.assertNotIn("cat .warroom-scratch", launch["prompt"])
                self.assertNotIn("AGENTS.md를 읽", launch["prompt"])
            w.finish_last()
            w.tick()
        self.assertEqual(w.kinds(), ["c_chunk_new"] * 3)
        self.assertTrue(all(l["kind"] == "start" for l in w.adapter.launches))   # never a resume of an old chunk
        prompts_ = [l["prompt"] for l in w.adapter.launches]
        self.assertNotIn("s0000 —", prompts_[2])    # chunk 3 does not carry chunk 1's text
        self.assertEqual(sum(1 for c in w.runner.literary.calls if c[2] == "init"), 1)
        b = w.row("deepseek", "c")
        self.assertEqual(b["state"], "WAITING_REVIEW")
        self.assertEqual(b["pr_number"], 100)
        pr = w.gh.created_prs[0]
        self.assertEqual(pr["labels"], ["batch"])
        self.assertRegex(pr["title"], r"^\[C/[^\]]+\] 001_01$")
        self.assertEqual([l.split(":")[0] for l in pr["body"].splitlines()],
                         ["- Method", "- Model", "- Shard", "- Batch", "- Coverage", "- Candidates"])
        self.assertNotIn("1155", pr["body"])
        self.assertEqual(w.git.commits[0][0], ["data/relation-candidates/001/001_01_c_deepseek.jsonl"])
        self.assertEqual(w.git.pushes, [b["branch"]])
        self.assertEqual(w.runner.literary.exports, 1)

    def test_zero_exit_without_checkpoint_evidence_is_not_success_and_retry_resumes_only_the_rest(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai(mark=5)
        w.tick()
        ids = w.active()["sense_ids"]
        w.finish_last()
        w.tick()
        b = w.row("deepseek", "c")
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(len(w.adapter.launches), 1)
        # Retry continues the same chunk in the same session with only the open sense ids, never the chunk body.
        w.ai()
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.tick(2)
        resume = w.adapter.launches[-1]
        self.assertEqual(resume["kind"], "resume")
        self.assertNotIn(prompts.VIEW_BEGIN, resume["prompt"])
        self.assertNotIn("원문", resume["prompt"])
        for done in ids[:5]:
            self.assertNotIn(done, resume["prompt"])
        for left in ids[5:]:
            self.assertIn(left, resume["prompt"])

    def test_saved_submit_survives_an_unclean_exit(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai(code=1)   # submit stored, then the CLI died
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual(w.kinds()[:2], ["c_chunk_new", "c_chunk_new"])   # moved on to a NEW chunk, not a re-run
        self.assertEqual(len(w.adapter.launches), 2)

    def _leave_rejected_submit(self, saved):
        w = self.w

        def effect():
            ids = w.active()["sense_ids"]
            w.runner.literary.mark(w.wt(), f".warroom-scratch/{CP_NAME}", ids[:saved])
            (w.wt() / f".warroom-scratch/c-chunk-{w.active()['chunk_no']:03d}.submit.json").write_text('{"senses":[]')
        w.adapter.plan.append({"code": 0, "session": "ses_c", "effect": effect})

    def test_rejected_submit_file_is_repaired_in_the_same_session_at_most_twice(self):
        w = self.w
        w.start("single", "deepseek", "c")
        self._leave_rejected_submit(0)
        w.tick()
        chunk_no = w.active()["chunk_no"]
        for attempt in (1, 2):
            self._leave_rejected_submit(0)
            w.finish_last()
            w.tick(2)
            self.assertEqual(w.row("deepseek", "c")["state"], "PRODUCING", attempt)
            self.assertEqual(w.adapter.launches[-1]["kind"], "resume", attempt)
            self.assertEqual(w.active()["chunk_no"], chunk_no)
        w.finish_last()
        w.tick()
        b = w.row("deepseek", "c")
        self.assertEqual(b["state"], "ERROR")   # fail-closed once the cap is spent; nothing is regenerated
        self.assertIn("checkpoint 완료 증거 없음", b["error"])
        self.assertEqual(len(w.adapter.launches), 3)
        self.assertEqual(w.active()["chunk_no"], chunk_no)

    def test_repaired_submit_resets_the_budget_and_next_chunk_starts_new(self):
        w = self.w
        w.start("single", "deepseek", "c")
        self._leave_rejected_submit(0)
        w.tick()
        w.ai()   # the resumed session stores the whole chunk
        w.finish_last()
        w.tick(2)
        self.assertEqual(w.adapter.launches[1]["kind"], "resume")
        w.finish_last()
        w.tick(2)
        self.assertEqual(w.kinds()[-1], "c_chunk_new")
        self.assertIsNone(w.store.get(literary.resubmit_key(w.row("deepseek", "c")["id"])))

    def test_retry_after_partial_checkpoint_ignores_multiple_old_closed_prs_and_resumes_same_chunk(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai(mark=5)
        w.tick()
        active_before = w.active()
        ids = list(active_before["sense_ids"])
        w.add_branch_pr(2050, head="b" * 40)
        w.add_branch_pr(2051, head="c" * 40)

        w.finish_last()
        w.tick()

        b = w.row("deepseek", "c")
        self.assertEqual(b["state"], "ERROR")  # partial checkpoint remains a stop; it is not treated as saved
        self.assertIn("checkpoint 완료 증거 없음", b["error"])
        self.assertIsNone(b["pr_number"])
        self.assertEqual(w.active()["chunk_no"], active_before["chunk_no"])
        self.assertEqual(w.active()["sense_ids"], ids)
        self.assertEqual(len(w.adapter.launches), 1)

        w.ai()
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.tick(2)

        b = w.row("deepseek", "c")
        resume = w.adapter.launches[-1]
        self.assertEqual(b["state"], "PRODUCING")
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertEqual(resume["kind"], "resume")
        self.assertEqual(w.active()["chunk_no"], active_before["chunk_no"])
        self.assertEqual(w.active()["sense_ids"], ids)
        for done in ids[:5]:
            self.assertNotIn(done, resume["prompt"])
        for remaining in ids[5:]:
            self.assertIn(remaining, resume["prompt"])
        self.assertIsNone(b["pr_number"])

    def test_c_recovery_keeps_merged_pr_eligible_beside_old_closed_history(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.tick()
        b = w.row("deepseek", "c")
        w.add_branch_pr(2050, head="b" * 40)
        w.add_branch_pr(2051, head="c" * 40)
        w.add_branch_pr(2060, state="closed", merged=True, head=HEAD1, merged_at="2026-10-27T00:00:00Z")

        info = w.sup._find_recovery_pr(w.row("deepseek", "c"))

        self.assertEqual(info["number"], 2060)
        self.assertTrue(info["merged"])

    def test_c_live_pr_lookup_ignores_old_closed_history_but_finds_new_open_pr(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.tick()
        b = w.row("deepseek", "c")
        w.add_branch_pr(2050, head="b" * 40)
        w.add_branch_pr(2051, head="c" * 40)

        self.assertIsNone(w.sup._find_pr(b))

        w.add_branch_pr(2052, head=HEAD1)
        self.assertEqual(w.sup._find_pr(b)["number"], 2052)

        w.add_branch_pr(2060, state="open", head=HEAD1)
        self.assertEqual(w.sup._find_pr(b)["number"], 2060)

    def test_c_recovery_preserves_attached_closed_pr_validation(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.tick()
        b = w.row("deepseek", "c")
        w.add_branch_pr(2050, head=HEAD2)
        w.store.update(b["id"], pr_number=2050)

        with self.assertRaisesRegex(RecoveryBlocked, "닫힌 PR #2050 HEAD와 로컬 worktree HEAD가 다릅니다"):
            w.sup._find_recovery_pr(w.row("deepseek", "c"))

    def test_c_recovery_keeps_unattached_closed_pr_at_current_worktree_head(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.tick()
        b = w.add_branch_pr(2050, head=HEAD1)

        info = w.sup._find_recovery_pr(b)

        self.assertEqual(info["number"], 2050)
        self.assertFalse(info["merged"])

    def test_c_recovery_keeps_closed_pr_at_recorded_finalization_head(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.tick()
        b = w.row("deepseek", "c")
        w.store.set(f"c_commit_head_{b['id']}", HEAD2)
        w.add_branch_pr(2050, head=HEAD2)

        with self.assertRaisesRegex(RecoveryBlocked, "닫힌 PR #2050 HEAD와 로컬 worktree HEAD가 다릅니다"):
            w.sup._find_recovery_pr(b)

    def test_c_recovery_keeps_open_pr_head_checks(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.tick()
        w.add_branch_pr(2050, state="open", head=HEAD2)

        with self.assertRaisesRegex(RecoveryBlocked, "PR #2050 HEAD와 로컬 worktree HEAD가 다릅니다"):
            w.sup._find_recovery_pr(w.row("deepseek", "c"))

    def test_c_recovery_keeps_multiple_open_prs_and_remote_head_checks(self):
        for case in ("multiple", "candidate_claim", "remote_head"):
            with self.subTest(case=case):
                w = CWorld()
                self.addCleanup(w.tmp.cleanup)
                w.start("single", "deepseek", "c")
                w.tick()
                b = w.row("deepseek", "c")
                w.add_branch_pr(2050, state="open", head=HEAD1)
                if case == "multiple":
                    w.add_branch_pr(2051, state="open", head=HEAD1)
                    expected = "소유 브랜치에 PR이 여러 개 있습니다"
                elif case == "candidate_claim":
                    w.gh.files[2050] = [{"path": "README.md"}]
                    expected = "Candidate 파일 소유권이 배치와 일치하지 않습니다"
                else:
                    w.git.remote[b["branch"]] = HEAD2
                    expected = "PR #2050 HEAD와 원격 소유 브랜치가 다릅니다"

                with self.assertRaisesRegex(RecoveryBlocked, expected):
                    w.sup._find_recovery_pr(b)

    def test_search_failed_stops_before_any_ai(self):
        w = self.w
        w.runner.literary.chunk_status["s0003"] = "SEARCH_FAILED"
        w.start("single", "deepseek", "c")
        w.tick()
        self.assertEqual(w.adapter.launches, [])
        self.assertEqual(w.row("deepseek", "c")["state"], "PAUSED")

    def test_restart_never_reinitializes_a_checkpoint(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()
        w.finish_last()
        w.tick()
        literary_cli = w.runner.literary
        w.sup = w.make_sup()   # Supervisor restart: new process, same files
        w.runner.literary = literary_cli
        b = w.row("deepseek", "c")
        w.sup._launch_c_next(w.store.batch(b["id"]))
        self.assertEqual(sum(1 for c in w.runner.literary.calls if c[2] == "init"), 1)

    def test_foreign_checkpoint_head_is_an_error_and_nothing_is_overwritten(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()
        w.finish_last()
        w.git.local_head = "9" * 40   # HEAD moved by something that is not our commit
        w.tick()
        self.assertEqual(w.row("deepseek", "c")["state"], "ERROR")

    def test_oversize_view_falls_back_to_pages_for_that_chunk_only(self):
        w = self.w
        w.runner.literary.senses = 12
        orig = literary.INLINE_MAX_PROMPT_BYTES
        literary.INLINE_MAX_PROMPT_BYTES = 3_000   # card alone is bigger: forces the page path
        self.addCleanup(setattr, literary, "INLINE_MAX_PROMPT_BYTES", orig)
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()
        prompt = w.adapter.launches[-1]["prompt"]
        self.assertNotIn(prompts.VIEW_BEGIN, prompt)
        self.assertIn("cat .warroom-scratch/c-active-chunk", prompt)


class Finalization(unittest.TestCase):
    def setUp(self):
        self.w = CWorld(senses=12)
        self.addCleanup(self.w.tmp.cleanup)

    def run_to_finalize(self, tick_after=True):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()
        w.finish_last()
        if tick_after:
            w.tick()
        return w.row("deepseek", "c")

    def test_lost_pr_response_never_creates_a_second_pr(self):
        w = self.w
        w.gh.create_pr_error = RuntimeError("timeout")
        w.gh.create_pr_lost = True   # the PR exists although the answer was lost
        b = self.run_to_finalize()
        self.assertEqual(b["state"], "WAITING_REVIEW")
        self.assertEqual(len(w.gh.created_prs), 1)

    def test_old_closed_history_does_not_block_saved_chunk_or_new_pr(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()
        w.add_branch_pr(2050, head="b" * 40)
        w.add_branch_pr(2051, head="c" * 40)

        w.finish_last()
        w.tick()

        b = w.row("deepseek", "c")
        self.assertEqual(b["state"], "WAITING_REVIEW")
        self.assertEqual(b["pr_number"], 100)
        self.assertEqual(len(w.gh.created_prs), 1)
        self.assertEqual(w.sup._find_recovery_pr(b)["number"], 100)
        self.assertEqual(w.gh.prs[2050]["state"], "closed")
        self.assertEqual(w.gh.prs[2051]["state"], "closed")

    def test_retry_preserves_a_closed_pr_matching_the_current_head_without_creating_another(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai(mark=5)
        w.tick()
        w.add_branch_pr(2050, head=HEAD1)
        w.finish_last()
        w.tick()

        b = w.row("deepseek", "c")
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("예상하지 않은 PR #2050", b["error"])
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertIsNone(b["pr_number"])

        w.ai()
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.tick(2)

        self.assertEqual(w.row("deepseek", "c")["state"], "ERROR")
        self.assertIn("이미 PR이 있어 자동 재개를 중단합니다", w.row("deepseek", "c")["error"])
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(w.gh.created_prs if hasattr(w.gh, "created_prs") else [], [])


    def test_failed_pr_creation_keeps_commit_and_push_and_retry_does_not_repeat_them(self):
        w = self.w
        w.gh.create_pr_error = RuntimeError("boom")
        b = self.run_to_finalize()
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual((len(w.git.commits), len(w.git.pushes)), (1, 1))
        w.gh.create_pr_error = None
        self.assertTrue(control.retry(w.store, "deepseek", "c"))
        w.tick(2)
        self.assertEqual((len(w.git.commits), len(w.git.pushes), w.runner.literary.exports), (1, 1, 1))
        self.assertEqual(w.row("deepseek", "c")["state"], "WAITING_REVIEW")

    def test_unintended_tracked_change_blocks_the_commit(self):
        w = self.w
        w.git.dirty_text = " M README.md\n"
        b = self.run_to_finalize()
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(getattr(w.git, "commits", []), [])
        self.assertEqual(w.gh.created_prs if hasattr(w.gh, "created_prs") else [], [])

    def test_moved_remote_branch_is_an_error_without_force(self):
        w = self.w
        w.git.remote[w.row("deepseek", "c")["branch"] if w.row("deepseek", "c") else "c-deepseek-001-01"] = "e" * 40
        b = self.run_to_finalize()
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(getattr(w.gh, "created_prs", []), [])

    def test_occupied_batch_stops_instead_of_switching_batches(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.ai()
        w.tick()   # the batch is assigned and its chunk running; only then does a rival PR claim the same C batch
        w.gh.open = [{"number": 9, "headRefName": "c-codex-001-01", "files": [{"path": "data/relation-candidates/001/001_01_c_codex.jsonl"}]}]
        w.finish_last()
        w.tick()
        b = w.row("deepseek", "c")
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(getattr(w.gh, "created_prs", []), [])

    def test_candidate_v1_rejection_reopens_only_the_named_senses(self):
        w = self.w
        w.runner.literary.export_error = json.dumps({"status": "FAILED", "diagnostic": "candidate_validation",
                                                      "affected": {"sense_ids": ["s0002", "s0007"]}})

        def resubmit():   # the repair run changes the checkpoint (a successful submit); export is then accepted
            w.runner.literary.mark(w.wt(), f".warroom-scratch/{CP_NAME}", ["s0002", "s0007"])
            w.runner.literary.export_error = None
        w.start("single", "deepseek", "c")
        w.ai()
        w.adapter.plan.append({"code": 0, "session": "ses_r", "effect": resubmit})
        w.tick()
        w.finish_last()
        w.tick()
        rec = json.loads((w.wt() / literary.ACTIVE).read_text())
        self.assertTrue(rec["repair"])
        self.assertEqual(rec["sense_ids"], ["s0002", "s0007"])
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertIn("s0002", w.adapter.launches[-1]["prompt"])
        self.assertNotIn("s0005 —", w.adapter.launches[-1]["prompt"])
        w.finish_last()
        w.tick()
        self.assertEqual(w.row("deepseek", "c")["state"], "WAITING_REVIEW")
        self.assertEqual(len(w.gh.created_prs), 1)


class RecoveryScope(unittest.TestCase):
    def test_other_methods_still_block_unmerged_closed_prs(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single", "deepseek", "a")
        w.tick()
        b = w.row("deepseek", "a")
        w.gh.prs[2050] = {"number": 2050, "state": "closed", "merged": False, "head_sha": "b" * 40,
                           "head_ref": b["branch"], "url": "", "merge_commit_sha": ""}
        w.gh.by_branch[b["branch"]] = [{"number": 2050, "state": "CLOSED", "headRefOid": "b" * 40,
                                         "mergedAt": None}]
        w.gh.files[2050] = [{"path": f"data/relation-candidates/{b['shard']}/"
                                      f"{b['shard']}_{b['batch']}_{b['method']}_{b['producer']}.jsonl"}]

        with self.assertRaisesRegex(RecoveryBlocked, "닫힌 PR #2050 HEAD와 로컬 worktree HEAD가 다릅니다"):
            w.sup._find_recovery_pr(b)


class CommitRecovery(unittest.TestCase):
    def test_restart_between_commit_and_recording_resumes_but_arbitrary_head_does_not(self):
        rel = "data/relation-candidates/001/001_01_c_deepseek.jsonl"
        for name, child, want in (("our exact commit", True, "WAITING_REVIEW"), ("arbitrary HEAD move", False, "ERROR")):
            with self.subTest(name):
                w = CWorld(senses=12)
                self.addCleanup(w.tmp.cleanup)
                real_set, armed = w.store.set, [True]

                def crashing_set(key, value, _real=real_set, _armed=armed):
                    if key.startswith("c_commit_head_") and _armed[0]:
                        _armed[0] = False
                        raise RuntimeError("process died right after the commit")
                    return _real(key, value)
                w.store.set = crashing_set
                w.start("single", "deepseek", "c")
                w.ai()
                w.tick()
                w.finish_last()
                w.tick()   # commit happened, its HEAD was never recorded
                self.assertEqual(w.row("deepseek", "c")["state"], "ERROR")
                self.assertEqual(len(w.git.commits), 1)
                w.git.child_of = (HEAD1, rel) if child else None
                self.assertTrue(control.retry(w.store, "deepseek", "c"))
                w.tick(2)
                self.assertEqual(w.row("deepseek", "c")["state"], want)
                self.assertEqual(len(w.git.commits), 1)   # never a second commit


class PureHelpers(unittest.TestCase):
    def test_view_ids_table(self):
        view = ("batch=001_01 done=0/5 zero_hit=0 not_yet_read=0\n\n## a1 — 표제 [noun]\n뜻\nhits=1 unseen=0\n[k] 출처\n"
                "본문 ## x — 가짜\n\n## a2 — SEARCH_FAILED\n\n## a3 — UNSEARCHABLE\n")
        self.assertEqual(literary.view_ids(view), (["a1", "a2", "a3"], ["a2"], ["a3"]))
        self.assertEqual(literary.view_ids("batch=001_01 done=5/5 zero_hit=2 not_yet_read=0\n\n"), ([], [], []))
        self.assertEqual(literary.progress_numbers(view), (0, 5, 0, 0))
        with self.assertRaises(literary.LiteraryError):
            literary.progress_numbers("nonsense")

    def test_delivery_and_pages_are_lossless(self):
        view = "".join(f"줄 {i} 한국어 원문\n" for i in range(5000))
        self.assertEqual(literary.delivery(8000, view), "pages")
        self.assertEqual(literary.delivery(8000, "짧은 view\n"), "inline")
        self.assertEqual("".join(stage2.chunk_pages(view)), view)
        with self.assertRaises(ValueError):
            stage2.chunk_pages("가" * 30_000 + "\n")   # an over-long single line is never cut

    def test_affected_senses(self):
        ok = json.dumps({"diagnostic": "candidate_validation", "affected": {"sense_id": "s1"}})
        many = json.dumps({"diagnostic": "candidate_validation", "affected": {"sense_ids": ["s1", "s2", "bad id"]}})
        for text, want in [(ok, ["s1"]), (many, ["s1", "s2"]), ("not json", []), ("", []),
                           (json.dumps({"diagnostic": "other", "affected": {"sense_id": "s1"}}), [])]:
            self.assertEqual(literary.affected_senses(text), want)

    def test_pr_body_has_exactly_six_items(self):
        b = {"shard": "001", "batch": "01"}
        body = literary.pr_body("Luna", b, {"records": 500, "senses": 560, "candidates": 3})
        self.assertEqual(len(body.strip().splitlines()), 6)
        self.assertIn("Coverage: 500 records / 560 senses", body)


if __name__ == "__main__":
    unittest.main()
