import json
import tempfile
import unittest
from pathlib import Path

from tests.fakes import HEAD1, HEAD2, World
from warroom import control
from warroom.adapters import opencode_free_quota
from warroom.supervisor import Supervisor, acquire_lock

BRANCH = "a-deepseek-001-01"


def review(i, head, body="-1", user="genonfire"):
    return {"id": i, "user": {"login": user}, "body": f"{body}\nHEAD: {head}\nfix it",
            "commit_id": head, "submitted_at": "2026-10-21T10:00:00Z"}


def install_candidate_pr(w, number=7, head=HEAD1, *, state="open", merged=False):
    b = w.row()
    branch = b["branch"]
    w.pr_info(number, head, state=state, merged=merged, head_ref=branch)
    w.gh.by_branch[branch] = [{"number": number, "state": state.upper(), "headRefOid": head}]
    w.gh.files[number] = [{"path": f"data/relation-candidates/{b['shard']}/"
                                  f"{b['shard']}_{b['batch']}_{b['method']}_{b['producer']}.jsonl"}]
    if state == "open":
        w.git.remote[branch] = head



def _quota_event(**over):
    err = {"type": "provider.quota", "status": 429,
           "response": {"body": json.dumps({"type": "error", "error": {"type": "FreeUsageLimitError",
                                                                      "message": "Free usage limit reached."}})}}
    err.update(over)
    return json.dumps({"type": "error", "error": err})


QUOTA_LINE = _quota_event() + "\n"
_TEXT = json.dumps({"type": "text", "part": {"text": "FreeUsageLimitError"}})
_TOOL = json.dumps({"type": "tool_use", "part": {"state": {"output": _quota_event()}}})
_EMBED = json.dumps({"type": "text", "part": {"text": _quota_event()}})
_RATE = json.dumps({"type": "error", "error": {"type": "provider.quota", "status": 429, "response": {"body": "{}"}}})


class StructuredQuota(unittest.TestCase):
    def test_only_a_real_provider_event_qualifies(self):
        big = (_TEXT + "\n") * 3000   # > 30KB of later output must not hide the earlier error event
        cases = [
            ("real event", QUOTA_LINE, True),
            ("early event, big log, other final error", QUOTA_LINE + big + _RATE + "\n", True),
            ("garbage lines around it", "oops\n" + QUOTA_LINE + "{broken\n", True),
            ("ai text", _TEXT + "\n", False),
            ("tool stdout", _TOOL + "\n", False),
            ("embedded json string", _EMBED + "\n", False),
            ("plain text line", "FreeUsageLimitError: Free usage limit reached\n", False),
            ("no body", _quota_event(response={}) + "\n", False),
            ("body not json", _quota_event(response={"body": "FreeUsageLimitError"}) + "\n", False),
            ("body not string", _quota_event(response={"body": {"error": {"type": "FreeUsageLimitError"}}}) + "\n", False),
            ("other inner type", _quota_event(response={"body": json.dumps({"error": {"type": "Other"}})}) + "\n", False),
            ("status 500", _quota_event(status=500) + "\n", False),
            ("status true", _quota_event(status=True) + "\n", False),
            ("other error type", _quota_event(type="provider.rate") + "\n", False),
            ("truncated event", QUOTA_LINE[:-20], False),
            ("empty", "", False),
        ]
        for name, text, want in cases:
            with self.subTest(name), tempfile.TemporaryDirectory() as d:
                f = Path(d) / "run.log"
                f.write_text(text)
                self.assertEqual(opencode_free_quota(f), want)
        self.assertFalse(opencode_free_quota("/nonexistent/run.log"))

class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.w = World()

    def tearDown(self):
        self.w.tmp.cleanup()

    def produce_to_review(self, session="ses_1"):
        w = self.w
        w.start("single")
        w.adapter.plan.append({"code": 0, "session": session, "effect": self.open_pr})
        w.tick()
        self.assertEqual(w.row()["state"], "PRODUCING")
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")

    def open_pr(self):
        install_candidate_pr(self.w)

    def test_full_cycle_with_fix_and_cleanup(self):
        w = self.w
        self.produce_to_review()
        b = w.row()
        self.assertEqual((b["pr_number"], b["head_sha"], b["session_id"]), (7, HEAD1, "ses_1"))
        self.assertEqual(w.git.created[0][1], BRANCH)
        # AI exited, yet nothing is "complete": review watch continues without a live AI.
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 1)

        # -1 on current HEAD -> exactly one resume of the same session in the same worktree.
        w.gh.reviews_ = [review(11, HEAD1)]
        def pushed():
            w.pr_info(7, HEAD2); w.git.local_head = HEAD2
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": pushed})
        w.tick()
        self.assertEqual(w.row()["state"], "FIXING")
        fix = w.adapter.launches[-1]
        self.assertEqual((fix["kind"], fix["session"], fix["cwd"]), ("resume", "ses_1", w.row()["worktree"]))
        self.assertIn("fix it", fix["prompt"])
        w.tick(2)  # still running: no duplicate launch
        self.assertEqual(len(w.adapter.launches), 2)
        w.adapter.finish(fix["pid"])
        w.tick()
        b = w.row()
        self.assertEqual((b["state"], b["head_sha"]), ("WAITING_REVIEW", HEAD2))
        # Review 11 targets the old HEAD: it must not retrigger on the new HEAD.
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 2)

        # merged=true (not +1/+2/closed) completes; cleanup removes owned worktree.
        w.gh.reviews_.append(review(12, HEAD2, "+1"))
        w.tick(2)
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")
        w.pr_info(7, HEAD2, state="closed", merged=True)
        w.tick(3)
        self.assertEqual(w.row()["state"], "COMPLETE")
        self.assertEqual(w.git.removed[0][1], BRANCH)
        self.assertEqual(w.store.line("deepseek", "a")["run"], 0)  # single-batch mode stops here
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 2)

    def test_c_requires_configured_index_and_passes_it_to_production_and_review_fixes(self):
        w = self.w
        w.start("single", "deepseek", "c")
        w.tick()
        blocked = control.line_status(w.store, "deepseek", "c")["blocked"]
        self.assertIn("literary_index_path", blocked)
        self.assertEqual(w.adapter.launches, [])
        self.assertIsNone(w.row("deepseek", "c"))

        invalid = World()
        private_path = Path(invalid.tmp.name) / "private-approved-index.sqlite"
        invalid.cfg["literary_index_path"] = str(private_path)
        invalid.start("single", "deepseek", "c")
        invalid.tick()
        invalid_blocked = control.line_status(invalid.store, "deepseek", "c")["blocked"]
        self.assertIn("literary_index_path", invalid_blocked)
        self.assertNotIn(str(private_path), invalid_blocked)
        self.assertEqual(invalid.adapter.launches, [])
        invalid.tmp.cleanup()

        index = Path(w.tmp.name) / "approved literary index.sqlite"
        index.write_bytes(b"synthetic approved-index path")
        w.cfg["literary_index_path"] = str(index)
        w.start("single", "deepseek", "c")
        w.tick()
        launch = w.adapter.launches[-1]
        self.assertEqual(launch["approved_literary_db"], str(index))
        self.assertIn("TYPEWRITER_APPROVED_LITERARY_DB", launch["prompt"])
        resume_env = w.sup._launch_env({"method": "c"}, "produce_resume")
        self.assertEqual(resume_env["TYPEWRITER_APPROVED_LITERARY_DB"], str(index))
        agent_env = {"PATH": "/usr/bin",
                     "TYPEWRITER_APPROVED_LITERARY_DB": "/untrusted/inherited.sqlite"}
        combined_env = w.sup._launch_env({"method": "c"}, "produce", agent_env)
        self.assertEqual(combined_env["PATH"], agent_env["PATH"])
        self.assertEqual(combined_env["TYPEWRITER_APPROVED_LITERARY_DB"], str(index))
        for kind in ("fix_resume", "fix_new"):
            with self.subTest(kind=kind):
                env = w.sup._launch_env({"method": "c"}, kind)
                self.assertEqual(env["TYPEWRITER_APPROVED_LITERARY_DB"], str(index))
        for method in ("a", "b", "d"):
            with self.subTest(method=method):
                env = w.sup._launch_env({"method": method}, "fix_new")
                self.assertIsNone(env.get("TYPEWRITER_APPROVED_LITERARY_DB"))
        # Method D receives the approved index only for its chunk sessions and the Supervisor's own prepare.
        for kind in ("d_chunk_new", "d_chunk_resume", "d_cli"):
            with self.subTest(kind=kind):
                w.cfg["corpus_index_path"] = str(index)
                env = w.sup._launch_env({"method": "d"}, kind)
                self.assertEqual(env["TYPEWRITER_APPROVED_CORPUS_DB"], str(index))
                self.assertIsNone(env.get("TYPEWRITER_APPROVED_LITERARY_DB"))

    def test_c_review_fix_launches_require_the_approved_index(self):
        w = self.w
        index = Path(w.tmp.name) / "approved literary index.sqlite"
        index.write_bytes(b"synthetic approved-index path")
        w.cfg["literary_index_path"] = str(index)
        w.start("single", "deepseek", "c")
        w.tick()
        batch = w.row("deepseek", "c")
        event = [{"kind": "review", "author": "reviewer", "path": "data/relation-candidates/001/001_01_c_deepseek.jsonl",
                  "line": 1, "key": "review-1", "body": "Recheck the exact source sense."}]

        for kind in ("fix_resume", "fix_new"):
            with self.subTest(kind=kind):
                w.store.update(batch["id"], state="WAITING_REVIEW", pid=None,
                               session_id="ses_c" if kind == "fix_resume" else None,
                               pr_number=7, head_sha=HEAD1)
                before = len(w.adapter.launches)
                w.sup._launch(w.store.batch(batch["id"]), kind, event)
                self.assertEqual(len(w.adapter.launches), before + 1)
                launched = w.adapter.launches[-1]
                self.assertEqual(launched["approved_literary_db"], str(index))
                self.assertIn("TYPEWRITER_APPROVED_LITERARY_DB", launched["prompt"])

        w.cfg["literary_index_path"] = ""
        before = len(w.adapter.launches)
        w.sup._launch(w.store.batch(batch["id"]), "fix_new", event)
        self.assertEqual(len(w.adapter.launches), before)
        failed = w.store.batch(batch["id"])
        self.assertEqual(failed["state"], "ERROR")
        self.assertIn("literary_index_path", failed["error"])
        self.assertNotIn(str(index), failed["error"])

    def test_resume_failure_falls_back_to_new_session_once(self):
        w = self.w
        self.produce_to_review()
        w.gh.reviews_ = [review(11, HEAD1)]
        w.adapter.plan += [{"code": 1, "text": "session not found"}, {"code": 0}]
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        self.assertEqual([l["kind"] for l in w.adapter.launches], ["start", "resume", "start"])
        self.assertIn("fix it", w.adapter.launches[-1]["prompt"])

    def test_unmerged_close_and_dirty_cleanup_preserve(self):
        w = self.w
        self.produce_to_review()
        w.pr_info(7, HEAD1, state="closed", merged=False)
        w.tick()
        self.assertEqual(w.row()["state"], "ERROR")
        self.assertEqual(w.git.removed, [])

    def test_dirty_worktree_blocks_cleanup(self):
        w = self.w
        self.produce_to_review()
        w.pr_info(7, HEAD1, state="closed", merged=True)
        w.git.dirty_text = " M data/x"
        w.tick(3)
        self.assertEqual(w.row()["state"], "ERROR")
        self.assertEqual(w.git.removed, [])
        self.assertTrue(Path(w.row()["worktree"]).exists())

    def test_retry_after_cleanup_error_resumes_cleanup_without_rerunning_ai(self):
        w = self.w
        self.produce_to_review()
        w.pr_info(7, HEAD2, state="closed", merged=True)
        w.git.local_head = "9" * 40            # blocked by the fake: not synced
        w.tick(3)
        self.assertEqual(w.row()["state"], "ERROR")
        self.assertEqual(w.row()["paused_from"], "CLEANUP")
        launches = len(w.adapter.launches)
        w.git.local_head = HEAD2               # the operator/War Room made HEAD match
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.tick(3)
        self.assertEqual(w.row()["state"], "COMPLETE")
        self.assertEqual(len(w.adapter.launches), launches)

    def test_restart_recovery_no_duplicates(self):
        w = self.w
        w.start("single")
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": self.open_pr})
        w.tick()
        # Supervisor dies while the AI runs; a new one adopts the persisted batch.
        w.sup = w.make_sup(); w.sup_runner_ok()
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(len(w.git.created), 1)
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.sup = w.make_sup(); w.sup_runner_ok()
        w.tick()
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")
        w.sup = w.make_sup(); w.sup_runner_ok()
        w.gh.reviews_ = [review(11, HEAD1)]
        w.adapter.plan.append({"code": 0})
        w.tick()
        w.sup = w.make_sup(); w.sup_runner_ok()
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 2)  # review 11 handled exactly once

    def test_lost_process_without_exit_status_is_not_reproduced(self):
        w = self.w
        w.start("single")
        w.adapter.plan.append({"code": 0})
        w.tick()
        w.adapter.running.clear()  # vanished, no exit file
        w.tick()
        self.assertEqual(w.row()["state"], "ERROR")
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 1)

        # An explicit Retry must still check the producer-owned branch before launching again.
        b = w.row()
        w.pr_info(7, HEAD1, state="open", merged=False, head_ref=b["branch"])
        w.gh.by_branch[b["branch"]] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
        w.gh.files[7] = [{"path": "data/relation-candidates/001/001_01_a_deepseek.jsonl"}]
        w.git.remote[b["branch"]] = HEAD1
        self.assertTrue(control.retry(w.store, "deepseek", "a"))

        w.tick(2)  # Retry restores PRODUCING, then checks the owned PR before any new launch.

        b = w.row()
        self.assertEqual((b["state"], b["paused_from"]), ("ERROR", "PRODUCING"))
        self.assertIsNone(b["pr_number"])  # unknown completion is not adopted as a successful PR run
        self.assertIn("기존 소유 PR #7", b["error"])
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertTrue(Path(b["worktree"]).exists())
        self.assertEqual(w.git.removed, [])

    def test_pr_missing_after_clean_exit_and_duplicate_pr(self):
        w = self.w
        w.start("single")
        w.adapter.plan.append({"code": 0})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        self.assertEqual(w.row()["state"], "ERROR")  # no PR found
        w2 = World()
        w2.start("single")
        def own_plus_rival():
            install_candidate_pr(w2)
            w2.gh.open.append({"number": 5, "headRefName": "other", "files": [{
                "path": "data/relation-candidates/001/001_01_a_deepseek.jsonl"}]})
        w2.adapter.plan.append({"code": 0, "effect": own_plus_rival})
        w2.tick(); w2.adapter.finish(w2.adapter.launches[-1]["pid"]); w2.tick()
        self.assertEqual(w2.row()["state"], "ERROR")
        self.assertIn("#5", w2.row()["error"])
        w2.tmp.cleanup()

    def test_finished_producer_does_not_accept_unclaimed_open_pr(self):
        w = World()
        w.start("single")
        w.adapter.plan.append({"code": 0, "effect": lambda: install_candidate_pr(w)})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.gh.files[7] = []
        w.tick()
        self.assertEqual(w.row()["state"], "ERROR")
        self.assertIn("Candidate 파일 소유권", w.row()["error"])
        self.assertIsNone(w.row()["pr_number"])
        self.assertTrue(Path(w.row()["worktree"]).exists())
        w.tmp.cleanup()


class LiveAiHandover(unittest.TestCase):
    """Review 1: PR existence/HEAD watching must not depend on the AI having exited."""

    def test_pr_detected_while_ai_alive_then_ai_stopped_before_fix(self):
        w = World()
        w.start("single")
        w.adapter.plan.append({"code": 0, "session": "ses_1"})
        w.tick()
        pid = w.adapter.launches[-1]["pid"]
        self.assertEqual(w.row()["state"], "PRODUCING")
        w.pr_info(7, HEAD1, head_ref=BRANCH)  # AI created the PR but keeps running (waiting for merge)
        w.gh.by_branch[BRANCH] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
        w.gh.files[7] = [{"path": "data/relation-candidates/001/001_01_a_deepseek.jsonl"}]
        w.git.remote[BRANCH] = HEAD1
        stops = []
        orig_stop = w.adapter.stop
        w.adapter.stop = lambda p: (stops.append(p), None)[1]  # producer ignores the first stop request
        w.tick()
        b = w.row()
        self.assertEqual((b["state"], b["pr_number"], b["pid"]), ("WAITING_REVIEW", 7, pid))
        self.assertTrue(w.adapter.alive(pid))
        # Supervisor keeps requesting the stop and does not poll/fix while the producer remains live.
        w.gh.reviews_ = [review(11, HEAD1)]
        w.tick(2)
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")
        self.assertTrue(stops)
        w.adapter.stop = orig_stop
        w.tick()                     # stop now takes effect; the marker still blocks review work this tick
        self.assertEqual(len(w.adapter.launches), 1)
        w.tick()                    # exit confirmed -> exactly one fix run, same session
        self.assertEqual([l["kind"] for l in w.adapter.launches], ["start", "resume"])
        self.assertEqual(w.row()["state"], "FIXING")
        w.tmp.cleanup()

    def test_open_pr_requires_exact_candidate_claim_and_matching_branch_and_heads(self):
        cases = [
            ("missing claim", lambda w, b: w.gh.files.update({7: []}), "Candidate 파일 소유권"),
            ("wrong claim", lambda w, b: w.gh.files.update({7: [{"path":
                "data/relation-candidates/001/001_02_a_deepseek.jsonl"}]}), "Candidate 파일 소유권"),
            ("wrong PR branch", lambda w, b: w.pr_info(7, HEAD1, head_ref="other-branch"), "head 브랜치"),
            ("wrong local HEAD", lambda w, b: setattr(w.git, "local_head", HEAD2), "로컬 worktree HEAD"),
            ("wrong remote HEAD", lambda w, b: w.git.remote.update({b["branch"]: HEAD2}), "원격 소유 브랜치"),
        ]
        for name, mutate, expected in cases:
            with self.subTest(name):
                w = World()
                self.addCleanup(w.tmp.cleanup)
                w.start("single")
                w.adapter.plan.append({"code": 0, "session": "ses_1"})
                w.tick()
                b = w.row()
                w.pr_info(7, HEAD1, head_ref=b["branch"])
                w.gh.by_branch[b["branch"]] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
                w.gh.files[7] = [{"path": f"data/relation-candidates/{b['shard']}/"
                                          f"{b['shard']}_{b['batch']}_{b['method']}_{b['producer']}.jsonl"}]
                w.git.remote[b["branch"]] = HEAD1
                mutate(w, b)
                w.tick()
                row = w.row()
                self.assertEqual(row["state"], "ERROR")
                self.assertIn(expected, row["error"])
                self.assertTrue(Path(row["worktree"]).exists())
                self.assertEqual(w.git.removed, [])

    def test_merge_while_ai_alive_stops_ai_before_cleanup(self):
        w = World()
        w.start("single")
        w.adapter.plan.append({"code": 0})
        w.tick()
        w.pr_info(7, HEAD1, head_ref=BRANCH)
        w.gh.by_branch[BRANCH] = [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]
        w.gh.files[7] = [{"path": "data/relation-candidates/001/001_01_a_deepseek.jsonl"}]
        w.git.remote[BRANCH] = HEAD1
        w.tick()
        w.pr_info(7, HEAD1, state="closed", merged=True)
        w.tick(5)
        self.assertEqual(w.row()["state"], "COMPLETE")
        self.assertFalse(w.adapter.running)
        w.tmp.cleanup()


class ReviewReversal(unittest.TestCase):
    """Review 3: a same-HEAD -1 that was later retracted by +1/+2 is not a blocker."""

    def test_retracted_minus_one_never_triggers_even_after_restart(self):
        w = World()
        w.start("single")
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": lambda: install_candidate_pr(w)})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        m1 = review(11, HEAD1); m1["submitted_at"] = "2026-10-21T10:00:00Z"
        p1 = review(12, HEAD1, "+1"); p1["submitted_at"] = "2026-10-21T10:05:00Z"
        w.gh.reviews_ = [m1, p1]
        w.sup = w.make_sup(); w.sup_runner_ok()  # first poll happens after a restart
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), 1)
        # A later -1 on the same HEAD is effective again and is the only event sent.
        m2 = review(13, HEAD1); m2["submitted_at"] = "2026-10-21T10:10:00Z"; m2["body"] = "-1\nHEAD: " + HEAD1 + "\nnew problem"
        w.gh.reviews_.append(m2)
        w.adapter.plan.append({"code": 0})
        w.tick()
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertIn("new problem", w.adapter.launches[-1]["prompt"])
        self.assertNotIn("review:11", w.adapter.launches[-1]["prompt"])
        w.tmp.cleanup()


class ModelPolicy(unittest.TestCase):
    def test_fail_closed_without_verified_free_model(self):
        for name, models, mutate, expect in [
            ("unset free", {"free": "", "go": "p/go"}, None, "models.free"),
            ("not free-looking", {"free": "p/paid", "go": ""}, None, "무료 모델"),
            ("unknown to opencode", {"free": "p/other-free", "go": ""}, None, "지원하지 않는"),
            ("unknown go", {"free": "p/free-x-free", "go": "p/nope"}, None, "p/nope"),
            ("opencode models fails", None, lambda r: setattr(r, "models_ok", False), "models"),
        ]:
            with self.subTest(name):
                w = World(models)
                if mutate:
                    mutate(w.runner)
                w.start("single")
                w.tick()
                self.assertIsNone(w.store.active_batch("deepseek", "a"))
                self.assertEqual(w.adapter.launches, [])
                self.assertIn(expect, w.store.line("deepseek", "a")["blocked"])
                w.tmp.cleanup()


    def run_failure(self, text, models=None, retries=0):
        w = World(models)
        w.start("single")
        w.adapter.plan.append({"code": 1, "text": text})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        return w

    def test_table(self):
        cases = [  # text, models, state, tier, launches
            (QUOTA_LINE, None, "PRODUCING", "go", 2),
            (QUOTA_LINE, {"free": "p/free-x-free", "go": ""}, "PAUSED", "free", 1),
            ("FreeUsageLimitError reached", None, "PAUSED", "free", 1),     # bare text is never quota evidence
            ("HTTP 429 Too Many Requests", None, "PRODUCING", "free", 1),   # backoff, not Go
            ("401 unauthorized", None, "PAUSED", "free", 1),
            ("weird provider blob", None, "PAUSED", "free", 1),             # never silently paid
        ]
        for text, models, state, tier, n in cases:
            with self.subTest(text, models=models):
                w = self.run_failure(text, models)
                self.assertEqual((w.row()["state"], w.row()["model_tier"], len(w.adapter.launches)),
                                 (state, tier, n))
                if tier == "go":
                    self.assertEqual(w.adapter.launches[-1]["model"], "p/go")
                w.tmp.cleanup()

    def test_rate_limit_backoff_then_retry_same_batch(self):
        w = self.run_failure("429 Too Many Requests")
        self.assertEqual(len(w.adapter.launches), 1)
        w.tick()
        self.assertEqual(len(w.adapter.launches), 1)  # waiting
        w.now += 11
        w.adapter.plan.append({"code": 0})
        w.tick()
        self.assertEqual(len(w.adapter.launches), 2)
        self.assertEqual(len(w.git.created), 1)  # same worktree / batch
        w.tmp.cleanup()


class Operations(unittest.TestCase):
    def test_blocked_on_wrong_account(self):
        w = World()
        w.runner.account = "genonfire"
        w.start("single")
        w.tick()
        self.assertIsNone(w.store.active_batch("deepseek", "a"))
        self.assertEqual(w.adapter.launches, [])
        self.assertIn("계정 불일치", w.store.line("deepseek", "a")["blocked"])
        w.tmp.cleanup()

    def test_continuous_starts_next_batch_fresh_after_cleanup(self):
        w = World()
        w.start("continuous")
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": lambda: install_candidate_pr(w)})
        w.tick(); w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        w.pr_info(7, HEAD1, state="closed", merged=True)
        w.tick(3)
        self.assertEqual(w.store.all_batches()[0]["state"], "COMPLETE")
        w.adapter.plan.append({"code": 0})
        w.tick()  # next batch: 001_02, new worktree, brand-new session
        b = w.row()
        self.assertEqual((b["shard"], b["batch"], b["session_id"]), ("001", "02", None))
        self.assertNotEqual(b["worktree"], w.store.all_batches()[0]["worktree"])
        self.assertEqual(w.adapter.launches[-1]["kind"], "start")
        self.assertNotIn("session", w.adapter.launches[-1])
        w.tmp.cleanup()

    def test_stop_after_current_prevents_next_batch(self):
        w = World()
        w.start("continuous")
        w.adapter.plan.append({"code": 0, "effect": lambda: install_candidate_pr(w)})
        w.tick()
        control.set_drain(w.store, "deepseek", "a", True)  # current batch continues, no next one
        w.adapter.finish(w.adapter.launches[-1]["pid"]); w.tick()
        w.pr_info(7, HEAD1, state="closed", merged=True)
        w.tick(6)
        self.assertEqual(len(w.store.all_batches()), 1)
        w.tmp.cleanup()

    def test_force_stop_preserves_and_retry_resumes(self):
        w = World()
        w.start("single")
        w.adapter.plan.append({"code": 0})
        w.tick()
        control.stop_line(w.store, "deepseek", "a")
        w.tick()
        self.assertEqual(w.row()["state"], "PAUSED")
        self.assertTrue(Path(w.row()["worktree"]).exists())
        control.retry(w.store, "deepseek", "a")
        w.adapter.plan.append({"code": 0})
        w.tick(2)
        self.assertEqual(w.row()["state"], "PRODUCING")
        self.assertEqual(len(w.git.created), 1)
        w.tmp.cleanup()

    def test_progress_only_when_recorded(self):
        w = World()
        w.start("single")
        w.adapter.plan.append({"code": 0})
        w.tick()
        self.assertIsNone(w.row()["records_done"])
        f = Path(w.row()["worktree"]) / "data/relation-candidates/001/001_01_a_deepseek.jsonl"
        f.parent.mkdir(parents=True); f.write_text("{}\n" * 120)
        w.tick()
        self.assertEqual((w.row()["records_done"], w.row()["records_total"]), (120, 500))
        w.tmp.cleanup()

    def test_single_instance_lock(self):
        w = World()
        a = acquire_lock(w.paths.lock)
        self.assertIsNotNone(a)
        self.assertIsNone(acquire_lock(w.paths.lock))
        a.close()
        b = acquire_lock(w.paths.lock)
        self.assertIsNotNone(b)
        b.close()
        w.tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
