"""#2092: a retryable query failure (timeout, 5xx, 429, network) is not a verdict.

Invariant: it never changes the Line (run/mode/drain) or the batch (state/run_kind/baseline/output), never starts an AI,
and only that query/judgement is retried with backoff; "query succeeded and the answer is bad" stays fail-closed, and a
PR-create request whose outcome is unknown is never repeated."""
import json
import os
import tempfile
import unittest
from pathlib import Path

from tests.fakes import HEAD1, HEAD2, World
from tests.test_issue_2034_d import DWorld
from tests.test_issue_2035 import ABWorld, log_text
from warroom import control
from warroom.adapters import classify_failure
from warroom.github import GhError, GhTransient
from warroom.gitops import Git, GitError, GitTransient
from warroom.shell import Result, Runner, transient

BRANCH = "a-deepseek-001-01"
ENV = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}


def flaky(obj, name, errors):
    """Make `obj.name` raise the queued errors one call at a time, then behave normally."""
    real, queue = getattr(obj, name), list(errors)

    def call(*a, **k):
        if queue:
            raise queue.pop(0)
        return real(*a, **k)
    setattr(obj, name, call)
    return queue


class Classifier(unittest.TestCase):
    def test_table(self):
        cases = [
            (Result(124, "", "timeout: gh"), True), (Result(1, "", "HTTP 500: Server Error"), True),
            (Result(1, "", "gh: HTTP 502 Bad Gateway"), True), (Result(1, "", "HTTP 503"), True),
            (Result(1, "", "HTTP 429: rate limit"), True),
            (Result(1, "", "HTTP 403: You have exceeded a secondary rate limit"), True),
            (Result(128, "", "fatal: unable to access 'https://x/': Could not resolve host: github.com"), True),
            (Result(128, "", "fatal: the remote end hung up unexpectedly"), True),
            (Result(1, "", "error connecting to api.github.com: connection reset by peer"), True),
            (Result(1, "", "HTTP 401: Bad credentials"), False), (Result(1, "", "HTTP 403: Resource not accessible"), False),
            (Result(1, "", "HTTP 404: Not Found"), False), (Result(1, "", "HTTP 422: Validation Failed"), False),
            (Result(128, "", "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 404"), False),
            (Result(128, "", "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403"), False),
            (Result(128, "", "remote: Repository not found.\nfatal: unable to access 'https://github.com/o/r/': error: 401"), False),
            (Result(128, "", "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 503"), True),
            (Result(128, "", "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502"), True),
            (Result(128, "", "fatal: unable to access 'https://github.com/o/r/': Failed to connect to github.com port 443"), True),
            (Result(128, "", "fatal: not a git repository"), False), (Result(1, "", ""), False), (Result(0, "ok", ""), False),
        ]
        for res, want in cases:
            with self.subTest(res.err or res.code):
                self.assertEqual(transient(res) is not None, want)

    def test_transient_errors_are_caught_by_their_base_classes(self):
        self.assertTrue(issubclass(GhTransient, GhError) and issubclass(GitTransient, GitError))


class ScriptRunner(Runner):
    def __init__(self, ls_remote):
        self.ls_remote = ls_remote

    def run(self, argv, cwd=None, env=None, input=None, timeout=120):
        sub = argv[1]
        if sub == "rev-parse":
            return Result(1)                        # no local branch
        if sub == "ls-remote":
            return self.ls_remote
        return Result(0)


class CreateWorktreeLsRemote(unittest.TestCase):
    """ls-remote --exit-code: 0 = branch exists, 2 = absent, anything else is NOT evidence of absence."""

    def test_table(self):
        cases = [(Result(0, "sha\trefs/heads/x"), GitError, "already exists"), (Result(2), None, ""),
                 (Result(124, "", "timeout: git"), GitTransient, ""),
                 (Result(128, "", "fatal: unable to access: Could not resolve host: github.com"), GitTransient, ""),
                 (Result(128, "", "fatal: repository not found"), GitError, "")]
        for res, exc, text in cases:
            with self.subTest(f"{res.code} {res.err}"):
                with tempfile.TemporaryDirectory() as tmp:
                    git = Git(ScriptRunner(res), Path(tmp), ENV, Path(tmp) / "w")
                    git.ignore_scratch = lambda: None
                    if exc is None:
                        git.create_worktree(Path(tmp) / "w" / "x", "x", "master")
                    else:
                        with self.assertRaises(exc) as cm:
                            git.create_worktree(Path(tmp) / "w" / "x", "x", "master")
                        self.assertIs(type(cm.exception), exc)
                        self.assertIn(text, str(cm.exception))


class Prepare(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)

    def line(self):
        return self.w.store.line("deepseek", "a")

    def test_lookup_failures_keep_the_line_untouched_then_proceed(self):
        sources = {"open_prs": (lambda w: w.gh), "fetch_base": (lambda w: w.git)}
        for name, owner in sources.items():
            with self.subTest(name):
                w = World()
                self.addCleanup(w.tmp.cleanup)
                w.start("continuous")
                before = dict(w.line_row()) if hasattr(w, "line_row") else None
                flaky(owner(w), name, [GhTransient("HTTP 502"), GitTransient("timeout")])
                w.tick()
                ln = w.store.line("deepseek", "a")
                self.assertEqual((ln["run"], ln["mode"], ln["drain"], ln["blocked"]), (1, "continuous", 0, ""))
                self.assertIsNone(w.store.active_batch("deepseek", "a"))
                self.assertIn("조회 재시도", control.line_status(w.store, "deepseek", "a")["wait"])
                w.tick()                                  # still backing off: no second attempt yet
                self.assertIsNone(w.store.active_batch("deepseek", "a"))
                w.now += 10
                w.tick()
                w.now += 20
                w.tick()
                self.assertEqual(w.row()["state"], "PRODUCING")
                self.assertEqual(len(w.adapter.launches), 1)
                self.assertEqual(control.line_status(w.store, "deepseek", "a")["wait"], "")

    def test_auth_transient_is_not_a_missing_login_but_a_definite_401_is(self):
        w = self.w
        real = w.runner.run
        state = {"fail": 2}

        def run(argv, **k):
            if argv[:3] == ["gh", "api", "user"] and state["fail"]:
                state["fail"] -= 1
                return Result(1, "", "HTTP 502: Bad Gateway")
            return real(argv, **k)
        w.runner.run = run
        w.start("single")
        w.tick()
        self.assertEqual((self.line()["blocked"], self.line()["run"]), ("", 1))
        w.now += 10
        w.tick(2)
        w.now += 30
        w.tick()
        self.assertEqual(w.row()["state"], "PRODUCING")
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.runner.api_ok = False
        w.start("single")
        w.tick()
        self.assertIn("인증 없음", w.store.line("deepseek", "a")["blocked"])

    def test_worktree_lookup_failure_stays_prepare_and_launches_once(self):
        w = self.w
        w.start("single")
        flaky(w.git, "create_worktree", [GitTransient("ls-remote timeout")])
        w.tick()
        b = w.row()
        self.assertEqual((b["state"], b["error"]), ("PREPARE", None))
        self.assertEqual(len(w.adapter.launches), 0)
        w.sup = w.make_sup()                              # a Supervisor restart loses nothing
        w.now += 10
        w.tick(2)
        self.assertEqual((w.row()["state"], len(w.adapter.launches)), ("PRODUCING", 1))
        self.assertEqual(w.store.get(f"pending_{b['id']}"), None)
        self.assertEqual(w.store.kv_prefix(f"tw_b{b['id']}:"), [])


class ExitJudgement(unittest.TestCase):
    def setUp(self):
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)

    def produce(self, code=0):
        w = self.w
        w.start("single")
        w.adapter.plan.append({"code": code, "session": "ses_1",
                               "effect": lambda: (w.pr_info(7, HEAD1, head_ref=BRANCH),
                                                  w.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick()
        w.git.remote[BRANCH] = HEAD1
        w.adapter.finish(w.adapter.launches[-1]["pid"])

    def test_clean_exit_with_unreachable_github_is_rejudged_not_failed(self):
        w = self.w
        self.produce()
        flaky(w.gh, "prs_for_branch", [GhTransient("HTTP 503"), GhTransient("HTTP 503")])
        w.tick()
        b = w.row()
        self.assertEqual((b["state"], b["error"]), ("PRODUCING", None))
        self.assertEqual(json.loads(w.store.get(f"pending_{b['id']}"))["stage"], "exit0")
        w.sup = w.make_sup()                              # restart: the record and the run history are enough
        w.now += 10
        w.tick()
        self.assertEqual(w.row()["state"], "PRODUCING")
        w.now += 40
        w.tick()
        self.assertEqual((w.row()["state"], w.row()["pr_number"]), ("WAITING_REVIEW", 7))
        self.assertEqual(len(w.adapter.launches), 1)
        self.assertIsNone(w.store.get(f"pending_{b['id']}"))

    def test_failed_exit_with_unreachable_github_still_hands_off_the_pr(self):
        w = self.w
        self.produce(code=1)
        flaky(w.gh, "prs_for_branch", [GhTransient("HTTP 502")])
        w.tick()
        b = w.row()
        self.assertEqual((b["state"], json.loads(w.store.get(f"pending_{b['id']}"))["stage"]), ("PRODUCING", "exit_failed"))
        w.now += 10
        w.tick()
        self.assertEqual((w.row()["state"], len(w.adapter.launches)), ("WAITING_REVIEW", 1))

    def test_stale_pending_evidence_fails_closed_without_launching(self):
        w = self.w
        self.produce()
        flaky(w.gh, "prs_for_branch", [GhTransient("HTTP 503")])
        w.tick()
        b = w.row()
        w.store.add_run(b["id"], "produce", None, 4242, "l", "e")     # a newer run appeared: the evidence is stale
        w.now += 10
        w.tick()
        self.assertEqual(w.row()["state"], "ERROR")
        self.assertIn("pending 재판정 증거 불일치", w.row()["error"])
        self.assertEqual(len(w.adapter.launches), 1)

    def test_permanent_query_failure_and_real_mismatch_remain_errors(self):
        w = self.w
        self.produce()
        flaky(w.gh, "prs_for_branch", [GhError("gh pr list --head: HTTP 404: Not Found")])
        w.tick()
        self.assertEqual(w.row()["state"], "ERROR")


class VerifiedFixExit(unittest.TestCase):
    def test_retry_of_a_verified_fix_goes_to_review_without_ai_commit_or_push(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single")
        w.adapter.plan.append({"code": 0, "session": "ses_1",
                               "effect": lambda: (w.pr_info(7, HEAD1, head_ref=BRANCH),
                                                  w.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        w.gh.reviews_ = [{"id": 11, "user": {"login": "genonfire"}, "body": f"-1\nHEAD: {HEAD1}\nfix it",
                          "commit_id": HEAD1, "submitted_at": "2026-10-21T10:00:00Z"}]
        w.adapter.plan.append({"code": 0, "session": "ses_1", "effect": lambda: setattr(w.git, "local_head", HEAD2)})
        w.git.remote[BRANCH] = HEAD2
        w.tick()
        self.assertEqual(w.row()["state"], "FIXING")
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.pr_info(7, HEAD2, head_ref=BRANCH)
        b = w.row()
        w.store.update(b["id"], state="PAUSED", paused_from="FIXING", error="old gate", pid=None)
        # the completion evidence of the finished fix run is on record, so Retry only re-checks the push
        runs = w.store.runs(b["id"])
        w.store.finish_runs(b["id"], 0)
        w.store.set(f"verified_completion_run_{b['id']}", str(w.store.runs(b["id"])[0]["id"]))
        n = len(w.adapter.launches)
        self.assertTrue(control.retry(w.store, "deepseek", "a"))
        w.tick(2)
        self.assertEqual((w.row()["state"], w.row()["head_sha"]), ("WAITING_REVIEW", HEAD2))
        self.assertEqual((len(w.adapter.launches), getattr(w.git, "commits", []), getattr(w.git, "pushes", [])), (n, [], []))


class ABFixWithoutScopeGate(unittest.TestCase):
    def test_gate_state_is_gone(self):
        from warroom import stage1ab, supervisor
        self.assertFalse(hasattr(stage1ab, "out_of_scope_changes"))
        self.assertFalse(hasattr(supervisor.Supervisor, "_ab_fix_diff_problem"))


class ABRescue(unittest.TestCase):
    def setUp(self):
        self.w = ABWorld()
        self.addCleanup(self.w.tmp.cleanup)

    def test_complete_answer_survives_an_abnormal_exit(self):
        w = self.w
        w.start("single", "deepseek", "a")
        w.ai(w.block(1), code=1, session="ses_1")
        w.ai(w.block(2), session="ses_2")
        w.tick()
        w.finish_last()
        w.tick()
        self.assertEqual(w.kinds(), ["ab_chunk_new", "ab_chunk_new"])        # chunk 1 saved, chunk 2 is the next launch
        self.assertEqual(w.row_()["state"], "PRODUCING")

    def test_only_an_exact_current_begin_marker_routes_malformed_nonzero_answers_to_existing_fix(self):
        cases = [("missing end", lambda w: w.block(1, end=False), True),
                 ("duplicate S", lambda w: w.block(1).replace("S2\t", "S1\t", 1), True),
                 ("other chunk", lambda w: w.block(1, no=2), False), ("empty", lambda w: "", False)]
        for name, make, attempted in cases:
            with self.subTest(name):
                w = ABWorld()
                self.addCleanup(w.tmp.cleanup)
                w.start("single", "deepseek", "a")
                w.ai(make(w), code=1, session="ses_1")
                w.tick()
                w.finish_last()
                w.tick()
                if attempted:
                    self.assertEqual((w.row_()["state"], w.row_()["run_kind"], len(w.adapter.launches)),
                                     ("PRODUCING", "ab_chunk_retry", 2))
                else:
                    self.assertIn(w.row_()["state"], ("PAUSED", "ERROR"))
                    self.assertEqual(len(w.adapter.launches), 1)
                self.assertFalse((w.wt() / "data/relation-candidates").exists() and
                                 list((w.wt() / stage1ab_dir(w)).glob("candidates/chunk-001.jsonl")))

    def test_provider_invalid_output_is_not_free_quota(self):
        text = '{"type":"error","error":{"name":"provider.invalid-output","message":"OpenAI Chat stream ended without finish_reason"}}'
        self.assertNotEqual(classify_failure(text, ["quota exhausted"]), "free_quota")


def stage1ab_dir(w):
    from warroom import stage1ab
    return stage1ab.names(w.row_()).directory


class PrCreatedOnce(unittest.TestCase):
    def setUp(self):
        self.w = DWorld(records=25)
        self.addCleanup(self.w.tmp.cleanup)

    def to_finalize(self):
        w = self.w
        w.start("single", "deepseek", "d")
        w.ai()
        w.tick()
        w.finish_last()
        w.tick()
        return w.row_()

    def test_unknown_outcome_never_repeats_the_request_and_hands_off_when_listed(self):
        w = self.w
        w.gh.create_pr_error = GhTransient("gh pr create: HTTP 502")
        b = self.to_finalize()
        self.assertEqual(b["state"], "PRODUCING")
        self.assertIsNotNone(w.store.get(f"pr_create_{b['id']}"))
        calls = []
        real = w.gh.create_pr
        w.gh.create_pr = lambda *a, **k: (calls.append(1), real(*a, **k))[1]
        for _ in range(6):                                # far beyond the lag window: still no second request
            w.now += 2000
            w.tick(2)
        self.assertEqual((calls, len(getattr(w.gh, "created_prs", [])), w.row_()["state"]), ([], 0, "PRODUCING"))
        self.assertIn("운영자 확인", control.line_status(w.store, "deepseek", "d")["wait"])
        w.sup = w.make_sup()                              # the marker survives a restart
        w.tick(2)
        self.assertEqual(calls, [])
        w.gh._register(b["branch"], "t", "b", ["batch"])  # the operator (or a late listing) shows the owned PR
        w.now += 2000
        w.tick(2)
        self.assertEqual(w.row_()["state"], "WAITING_REVIEW")
        self.assertEqual(len(w.gh.created_prs), 1)
        self.assertIsNone(w.store.get(f"pr_create_{b['id']}"))

    def test_lost_response_with_delayed_listing_creates_exactly_one_pr(self):
        w = self.w
        w.gh.create_pr_error = GhTransient("gh pr create: timeout")
        w.gh.create_pr_lost = True
        listing = flaky(w.gh, "prs_for_branch", [GhTransient("HTTP 502")] * 2)
        b = self.to_finalize()
        self.assertEqual(b["state"], "PRODUCING")
        for _ in range(4):
            w.now += 200
            w.tick()
        self.assertEqual((listing, w.row_()["state"], len(w.gh.created_prs)), ([], "WAITING_REVIEW", 1))

    def test_already_exists_is_diagnosed_through_the_owned_branch_lookup(self):
        w = self.w
        w.gh.create_pr_error = GhError("gh pr create: a pull request for branch already exists: HTTP 422")
        w.gh.create_pr_lost = True                       # the existing PR is the owned one
        b = self.to_finalize()
        self.assertEqual((b["state"], len(w.gh.created_prs)), ("WAITING_REVIEW", 1))

    def test_definite_rejection_is_an_error_and_clears_the_marker(self):
        w = self.w
        w.gh.create_pr_error = GhError("gh pr create: HTTP 422: Validation Failed: no commits between master and x")
        b = self.to_finalize()
        self.assertEqual(b["state"], "ERROR")
        self.assertIsNone(w.store.get(f"pr_create_{b['id']}"))
        w.gh.create_pr_error = None
        self.assertTrue(control.retry(w.store, "deepseek", "d"))
        w.tick(2)
        self.assertEqual((w.row_()["state"], len(w.gh.created_prs)), ("WAITING_REVIEW", 1))


class Cleanup(unittest.TestCase):
    def test_transient_lookup_keeps_cleanup_then_completes_once(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single")
        w.adapter.plan.append({"code": 0, "session": "ses_1",
                                "effect": lambda: (w.pr_info(7, HEAD1, head_ref=BRANCH),
                                                   w.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick()
        w.git.remote[BRANCH] = HEAD1
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        w.pr_info(7, HEAD1, state="closed", merged=True, head_ref=BRANCH)
        w.tick()                                         # WAITING_REVIEW -> MERGED
        w.tick()                                         # MERGED -> CLEANUP
        self.assertEqual(w.row()["state"], "CLEANUP")
        flaky(w.gh, "pull", [GhTransient("HTTP 502"), GhTransient("HTTP 502")])
        w.tick()
        self.assertEqual((w.row()["state"], w.row()["error"]), ("CLEANUP", None))
        self.assertEqual(w.git.removed, [])
        for _ in range(3):
            w.now += 60
            w.tick()
        self.assertEqual(w.row()["state"], "COMPLETE")
        self.assertEqual(len(w.git.removed), 1)


class KvIsolation(unittest.TestCase):
    def test_clear_removes_exactly_its_own_retry_keys(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single")
        w.tick()
        b = w.row()
        bid = b["id"]
        other = bid + 9                                   # b1 must never touch b10-style keys
        for key in (f"pending_{bid}", f"pr_create_{bid}", f"tw_b{bid}:exit0", f"tw_b{bid}:cleanup",
                    f"pending_{other}", f"pr_create_{other}", f"tw_b{other}:exit0", f"tw_b{bid}0:exit0"):
            w.store.set(key, "x")
        w.store.finish_clear(b, "audit")
        for key in (f"pending_{bid}", f"pr_create_{bid}", f"tw_b{bid}:exit0", f"tw_b{bid}:cleanup"):
            self.assertIsNone(w.store.get(key), key)
        for key in (f"pending_{other}", f"pr_create_{other}", f"tw_b{other}:exit0", f"tw_b{bid}0:exit0"):
            self.assertEqual(w.store.get(key), "x", key)

    def test_unconfirmed_pr_marker_survives_retry_and_error(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single")
        w.tick()
        b = w.row()
        w.store.set(f"pr_create_{b['id']}", "{}")
        w.sup._fail(b, "ERROR", "x")
        self.assertEqual(w.store.get(f"pr_create_{b['id']}"), "{}")


class OperatorCommands(unittest.TestCase):
    def test_drain_keeps_the_current_batch_recovering_and_stop_discards_pending(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("continuous")
        w.adapter.plan.append({"code": 0, "session": "ses_1",
                               "effect": lambda: (w.pr_info(7, HEAD1, head_ref=BRANCH),
                                                  w.gh.by_branch.update({BRANCH: [{"number": 7, "state": "OPEN", "headRefOid": HEAD1}]}))})
        w.tick()
        w.git.remote[BRANCH] = HEAD1
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        flaky(w.gh, "prs_for_branch", [GhTransient("HTTP 503")])
        w.tick()
        b = w.row()
        self.assertIsNotNone(w.store.get(f"pending_{b['id']}"))
        control.drain_all(w.store, [("deepseek", "a")])
        w.now += 10
        w.tick(2)
        self.assertEqual(w.row()["state"], "WAITING_REVIEW")            # recovery continued under Drain All
        self.assertEqual(len(w.adapter.launches), 1)

    def test_stop_wins_over_a_pending_reentry(self):
        w = World()
        self.addCleanup(w.tmp.cleanup)
        w.start("single")
        w.adapter.plan.append({"code": 0, "session": "ses_1"})
        w.tick()
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        flaky(w.gh, "prs_for_branch", [GhTransient("HTTP 503")])
        w.tick()
        b = w.row()
        self.assertIsNotNone(w.store.get(f"pending_{b['id']}"))
        control.stop_line(w.store, "deepseek", "a")
        w.tick()
        self.assertEqual(w.row()["state"], "PAUSED")
        self.assertIsNone(w.store.get(f"pending_{b['id']}"))
        self.assertEqual(w.store.kv_prefix(f"tw_b{b['id']}:"), [])
        w.now += 100
        w.tick(2)
        self.assertEqual((w.row()["state"], len(w.adapter.launches)), ("PAUSED", 1))


if __name__ == "__main__":
    unittest.main()
