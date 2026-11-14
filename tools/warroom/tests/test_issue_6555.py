"""Issue #6555: a Stage 2 review fix submits only its judgment; the Supervisor applies it with the official CLI."""
import json
import unittest
from pathlib import Path

from tests import test_issue_6249 as t6249
from warroom.github import GhClient, GhTransient
from warroom.shell import Result
from warroom.gitops import GitError, GitTransient, Stage2AmendRejected
from warroom.supervisor import (S2_FIX_APPLY_ATTEMPTS, S2_FIX_COMMIT_SUBJECT, S2_FIX_REPLY_LIST_WAIT_SECONDS,
                                S2_FIX_RESPONSE)

DROP = "data/relation-drops/drop-001.jsonl"


class SupervisedStage2Fix(unittest.TestCase):
    start_optional_part = t6249.UnansweredStage2Review.start_optional_part
    _waiting = t6249.UnansweredStage2Review._waiting
    _poll = t6249.UnansweredStage2Review._poll

    def _fix(self, response):
        """Wait for the -1, launch the fix and plan its run to submit `response` (None: submit nothing)."""
        w, b = self._waiting()
        wt = Path(b["worktree"])

        def submit(payload=response):
            if payload is not None:
                (wt / S2_FIX_RESPONSE).write_text(json.dumps(payload, ensure_ascii=False), "utf-8")
        w.adapter.plan.append({"code": 0, "session": "ses_fix", "effect": submit})
        self._poll(w, b)
        fix = w.adapter.launches[-1]
        self.assertEqual((fix["kind"], w.store.batch(b["id"])["run_kind"]), ("start", "fix_new"))
        self.assertIn(S2_FIX_RESPONSE, fix["prompt"])
        self.assertNotIn("verify --shard", fix["prompt"])
        old_commit, old_push = w.git.commit_paths, w.git.push_owned_fix

        def commit(path, rels, message, **kwargs):   # every real commit has its own SHA
            parent = w.git.local_head
            old_commit(path, rels, message, **kwargs)
            w.git.local_head = "9" * 40
            w.git.commit_parent_sha = parent
            w.git.ancestor_pairs.add((parent, w.git.local_head))
            return w.git.local_head
        w.git.commit_paths = commit
        w.gh.comment_issue = lambda n, body: w.gh.add_pr_reply(n, body)   # GitHub assigns the id and author

        def push(path, branch, remote_sha, local):   # GitHub moves the PR HEAD with the owned branch
            old_push(path, branch, remote_sha, local)
            w.gh.prs[b["pr_number"]]["head_sha"] = local
        w.git.push_owned_fix = push
        return w, b, wt, fix

    def _end(self, w, b, run):
        w.adapter.finish(run["pid"])
        w.tick()
        return w.store.batch(b["id"])

    def _replies(self, w, b):
        return [c["body"] for c in w.gh.issue_comments_.get(b["pr_number"], [])]

    AMEND = {"event_keys": ["review:77"], "amend": "amend w1-s1 @" + "2" * 64 + "\nc1 D e", "reply": "c1을 D e로 바꿨습니다."}

    def _applied(self, w, b, base):
        """One amend, one commit of exactly its file, the exact commit verified and pushed, one reply."""
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self.assertEqual(len(w.git.stage2_amend_calls), 1)
        self.assertTrue(w.git.stage2_amend_calls[0][3].endswith("c1 D e\n"))
        self.assertEqual(w.git.commits[-1], ([DROP], S2_FIX_COMMIT_SUBJECT))
        new_head = w.git.local_head
        self.assertEqual(w.git.owned_fix_pushes, [(b["branch"], base, new_head)])
        self.assertIn((new_head, "001", "01", "01"), w.git.exact_verify_calls)
        replies = self._replies(w, b)
        self.assertEqual(len(replies), 1)
        self.assertTrue(replies[0].startswith("[review:77] c1을 D e로 바꿨습니다."))
        self.assertIsNone(w.store.get(f"s2_fix_start_{b['id']}"))
        self._completed(w, b, base, new_head)

    def _completed(self, w, b, event_head, fix_head):
        """The review event is HANDLED by the fix run with the id of the one reply bound to it and the fix HEAD."""
        comment = w.gh.issue_comments_[b["pr_number"]][-1]
        lines = {line.strip() for line in comment["body"].splitlines()}
        self.assertLessEqual({"WarRoom-Review-Event: review:77", f"WarRoom-Fix-Head: {fix_head}"}, lines)
        event = w.store.handled_event(b["id"], b["pr_number"], event_head, "review:77")
        fix_run = next(run for run in w.store.runs(b["id"]) if str(run["kind"]).startswith("fix"))
        self.assertEqual((event["status"], event["reply_id"], event["run_id"]), ("HANDLED", comment["id"], fix_run["id"]))
        self.assertIsNotNone(event["completed_at"])

    def test_amended_judgment_is_committed_verified_pushed_and_answered(self):
        w, b, wt, fix = self._fix(self.AMEND)
        base = w.gh.pull(b["pr_number"])["head_sha"]
        local_verifies = len(w.git.local_verify_calls)
        w.git.stage2_amend_results = [{"changes": {DROP: "drop\n"}}]
        b = self._end(w, b, fix)
        self._applied(w, b, base)
        self.assertEqual(len(w.git.local_verify_calls), local_verifies, "the amend's own outputs replace the local verify")
        self.assertTrue(any("verify=reused" in row["msg"] for row in w.store.batch_events(b["id"])))

    def test_interrupted_application_resumes_without_a_second_amend_commit_or_reply(self):
        w, b, wt, fix = self._fix(self.AMEND)
        base = w.gh.pull(b["pr_number"])["head_sha"]
        w.git.stage2_amend_results = [{"changes": {DROP: "drop\n"}}]
        original_push, failures = w.git.push_owned_fix, []

        def flaky_push(*args):   # the push fails after the commit; the next attempt continues from that commit
            if not failures:
                failures.append(args)
                raise GitTransient("network")
            return original_push(*args)
        w.git.push_owned_fix = flaky_push
        b = self._end(w, b, fix)
        for _ in range(3):
            if b["state"] == "WAITING_REVIEW":
                break
            w.tick()
            b = w.store.batch(b["id"])
        self.assertEqual(len(failures), 1)
        self._applied(w, b, base)

    def _settle(self, w, b):
        for _ in range(3):
            if b["state"] != "FIXING":
                break
            w.tick()
            b = w.store.batch(b["id"])
        return b

    def test_amend_written_but_not_committed_resumes_by_replaying_the_same_input(self):
        w, b, wt, fix = self._fix(self.AMEND)
        base = w.gh.pull(b["pr_number"])["head_sha"]
        w.git.stage2_amend_results = [{"changes": {DROP: "drop\n"}}]
        original_commit, stops = w.git.commit_paths, []

        def stop_before_commit(*args, **kwargs):   # the Supervisor stops between the amend's writes and its commit
            if not stops:
                stops.append(w.git.dirty_text)
                raise GitTransient("supervisor stopped")
            return original_commit(*args, **kwargs)
        w.git.commit_paths = stop_before_commit
        b = self._settle(w, self._end(w, b, fix))
        self.assertEqual(stops, [f" M {DROP}\n"])
        self.assertEqual(len(w.git.stage2_amend_calls), 2, "the resumed application replays the same amend input")
        self.assertEqual(w.git.stage2_amend_calls[0][3], w.git.stage2_amend_calls[1][3])
        self.assertEqual(w.git.commits[-1], ([DROP], S2_FIX_COMMIT_SUBJECT))
        self.assertEqual(w.git.owned_fix_pushes, [(b["branch"], base, w.git.local_head)])
        self.assertEqual(len(self._replies(w, b)), 1)
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self.assertEqual([run["kind"] for run in w.adapter.launches[-1:]], ["start"], "no new judgment is requested")

    def test_amend_failing_after_partial_writes_is_recovered_with_the_same_input_not_a_new_judgment(self):
        w, b, wt, fix = self._fix(self.AMEND)
        w.git.stage2_amend_results = [{"changes": {DROP: "drop\n"}, "fail_after_write": True}]
        b = self._end(w, b, fix)
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self.assertEqual(len(w.git.stage2_amend_calls), 2)
        self.assertEqual(w.git.commits[-1], ([DROP], S2_FIX_COMMIT_SUBJECT))
        self.assertTrue((wt / S2_FIX_RESPONSE).exists(), "the accepted submission is kept, never replaced by a retry")
        self.assertEqual(w.adapter.launches[-1]["pid"], fix["pid"])

    def test_operational_amend_failure_before_any_write_keeps_the_judgment_and_reruns_the_same_input(self):
        w, b, wt, fix = self._fix(self.AMEND)
        w.git.stage2_amend_results = [GitError("admission-cli amend 실패(exit 1): another amend is active"),
                                      {"changes": {DROP: "drop\n"}}]
        b = self._end(w, b, fix)
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self.assertEqual([call[3] for call in w.git.stage2_amend_calls], [w.git.stage2_amend_calls[0][3]] * 2)
        self.assertEqual(w.adapter.launches[-1]["pid"], fix["pid"], "no new judgment is requested")

    def test_repeated_operational_amend_failure_stops_with_the_judgment_preserved(self):
        w, b, wt, fix = self._fix(self.AMEND)
        w.git.stage2_amend_results = [GitError("admission-cli amend 실패(exit 1): another amend is active")] * 2
        b = self._end(w, b, fix)
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("another amend is active", b["error"])
        self.assertTrue((wt / S2_FIX_RESPONSE).exists())
        self.assertEqual(w.adapter.launches[-1]["pid"], fix["pid"])
        self.assertEqual(self._replies(w, b), [])

    def test_changes_not_made_by_the_submissions_amend_are_preserved_and_stop_the_batch(self):
        w, b, wt, fix = self._fix(self.AMEND)
        w.adapter.running[fix["pid"]]["effect"] = (lambda effect=w.adapter.running[fix["pid"]]["effect"]:
                                                   (effect(), setattr(w.git, "dirty_text", " M README.md\n")))
        b = self._end(w, b, fix)
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("README.md", b["error"])
        self.assertEqual(w.git.stage2_amend_calls, [])
        self.assertEqual(self._replies(w, b), [])

    def test_reentry_after_the_reply_records_the_same_comment_once(self):
        w, b, wt, fix = self._fix(self.AMEND)
        base = w.gh.pull(b["pr_number"])["head_sha"]
        w.git.stage2_amend_results = [{"changes": {DROP: "drop\n"}}]
        original_pull, stops = w.gh.pull, []

        def stop_after_reply(n):   # the Supervisor stops right after posting, before the completion gate
            if self._replies(w, b) and not stops:
                stops.append(n)
                raise GhTransient("supervisor stopped")
            return original_pull(n)
        w.gh.pull = stop_after_reply
        b = self._settle(w, self._end(w, b, fix))
        self.assertEqual(stops, [b["pr_number"]])
        self._applied(w, b, base)

    def test_a_reply_github_does_not_show_never_completes_the_event(self):
        w, b, wt, fix = self._fix(self.AMEND)
        base = w.gh.pull(b["pr_number"])["head_sha"]
        w.git.stage2_amend_results = [{"changes": {DROP: "drop\n"}}]
        posts = []
        w.gh.comment_issue = lambda n, body: posts.append(body)   # posted, but GitHub does not list it yet
        b = self._end(w, b, fix)
        w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual(b["state"], "FIXING")
        self.assertEqual(len(posts), 1, "a reply GitHub may still be listing is awaited, not posted again")
        self.assertEqual(w.store.handled_event(b["id"], b["pr_number"], base, "review:77")["status"], "LEGACY")
        w.now += S2_FIX_REPLY_LIST_WAIT_SECONDS   # still unconfirmed after the wait: stop, never post a second reply
        for _ in range(3):
            w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual((b["state"], len(posts)), ("ERROR", 1))
        self.assertEqual(w.store.handled_event(b["id"], b["pr_number"], base, "review:77")["status"], "LEGACY")

    def test_a_post_that_timed_out_after_github_accepted_it_is_found_not_posted_again(self):
        w, b, wt, fix = self._fix(self.AMEND)
        base = w.gh.pull(b["pr_number"])["head_sha"]
        w.git.stage2_amend_results = [{"changes": {DROP: "drop\n"}}]
        listed, hidden = w.gh.issue_comments, []

        def accepted_then_timeout(n, body):   # GitHub stores the comment, but the CLI call times out
            hidden.append(w.gh.add_pr_reply(n, body))
            raise GhTransient("gh issue comment timed out")

        def lagging_list(n):   # the first listing after the timeout does not show the new comment yet
            comments = listed(n)
            if hidden and len(hidden) == 1 and not getattr(lagging_list, "shown", False):
                lagging_list.shown = True
                return [comment for comment in comments if comment.get("id") not in hidden]
            return comments
        w.gh.comment_issue, w.gh.issue_comments = accepted_then_timeout, lagging_list
        b = self._settle(w, self._end(w, b, fix))
        self.assertEqual(len(hidden), 1, "the timed-out post is never repeated")
        self.assertEqual(len(self._replies(w, b)), 1)
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self._completed(w, b, base, w.git.local_head)

    def _post_fails(self, w, b, store_comment, result):
        """`gh issue comment` exits with `result` (classified by the real GhClient); GitHub may still have stored it."""
        listed, stored = w.gh.issue_comments, []

        def comment(n, body):
            if store_comment:
                stored.append(w.gh.add_pr_reply(n, body))
            raise GhClient._fail("gh issue comment", result)

        def lagging(n):   # the first two listings after the post do not show it yet
            lagging.calls = getattr(lagging, "calls", 0) + 1
            comments = listed(n)
            return [c for c in comments if c.get("id") not in stored] if stored and lagging.calls <= 3 else comments
        w.gh.comment_issue, w.gh.issue_comments = comment, lagging
        return stored

    def test_a_post_whose_gh_process_was_killed_is_found_and_recorded_once(self):
        w, b, wt, fix = self._fix(self.AMEND)
        base = w.gh.pull(b["pr_number"])["head_sha"]
        w.git.stage2_amend_results = [{"changes": {DROP: "drop\n"}}]
        stored = self._post_fails(w, b, True, Result(-9, "", ""))   # a non-transient GhError: outcome still unknown
        b = self._end(w, b, fix)
        for _ in range(4):
            if b["state"] != "FIXING":
                break
            w.tick()
            b = w.store.batch(b["id"])
        self.assertEqual(len(stored), 1, "an unconfirmed post is never repeated")
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self._completed(w, b, base, w.git.local_head)

    def test_an_unconfirmed_failed_post_is_not_repeated_and_leaves_the_event_open(self):
        w, b, wt, fix = self._fix(self.AMEND)
        base = w.gh.pull(b["pr_number"])["head_sha"]
        w.git.stage2_amend_results = [{"changes": {DROP: "drop\n"}}]
        attempts = []
        self._post_fails(w, b, False, Result(1, "", "HTTP 422: Validation Failed"))
        failing = w.gh.comment_issue
        w.gh.comment_issue = lambda n, body: (attempts.append(body), failing(n, body))
        b = self._end(w, b, fix)
        w.tick()
        w.now += S2_FIX_REPLY_LIST_WAIT_SECONDS
        for _ in range(3):
            w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual((b["state"], len(attempts)), ("ERROR", 1))
        self.assertIn("warroom-s2-fix", b["error"])
        self.assertEqual(w.store.handled_event(b["id"], b["pr_number"], base, "review:77")["status"], "LEGACY")

    def test_a_reply_with_the_nonce_but_wrong_binding_stops_without_completing(self):
        w, b, wt, fix = self._fix(self.AMEND)
        base = w.gh.pull(b["pr_number"])["head_sha"]
        w.git.stage2_amend_results = [{"changes": {DROP: "drop\n"}}]
        nonce = json.loads(w.store.get(f"s2_fix_start_{b['id']}"))["nonce"]
        w.gh.add_pr_reply(b["pr_number"], f"다른 답글\n<!-- warroom-s2-fix {nonce} -->", login="someone-else")
        b = self._end(w, b, fix)
        self.assertEqual(b["state"], "ERROR")
        self.assertEqual(w.store.handled_event(b["id"], b["pr_number"], base, "review:77")["status"], "LEGACY")

    def test_disagreement_without_amend_only_replies_and_keeps_full_verification(self):
        w, b, wt, fix = self._fix({"event_keys": ["review:77"], "amend": None, "reply": "[review:77] 유지합니다: 근거 …"})
        local_verifies = len(w.git.local_verify_calls)
        b = self._end(w, b, fix)
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self.assertEqual(w.git.stage2_amend_calls, [])
        self.assertFalse(getattr(w.git, "owned_fix_pushes", []))
        self.assertEqual(len(self._replies(w, b)), 1)
        self.assertEqual(len(w.git.local_verify_calls), local_verifies + 1)
        self._completed(w, b, w.git.local_head, w.git.local_head)

    def test_refused_submission_returns_its_reason_to_the_same_session_then_stops(self):
        refused = {"event_keys": ["review:77"], "amend": "amend w1-s1 @" + "2" * 64 + "\nc9 D e", "reply": "수정했습니다."}
        w, b, wt, fix = self._fix(refused)
        w.git.stage2_amend_results = [Stage2AmendRejected("unknown alias c9")] * (S2_FIX_APPLY_ATTEMPTS + 1)
        run = fix
        for attempt in range(S2_FIX_APPLY_ATTEMPTS):
            b = self._end(w, b, run)
            run = w.adapter.launches[-1]
            self.assertEqual((b["state"], run["kind"], run.get("session")), ("FIXING", "resume", "ses_fix"))
            self.assertIn("unknown alias c9", run["prompt"])
            self.assertFalse((wt / S2_FIX_RESPONSE).exists(), "a stale submission is never applied again")
            w.adapter.running[run["pid"]]["effect"] = lambda: (wt / S2_FIX_RESPONSE).write_text(json.dumps(refused), "utf-8")
            w.adapter.running[run["pid"]]["session"] = "ses_fix"
        b = self._end(w, b, run)
        self.assertEqual(b["state"], "ERROR")
        self.assertIn("unknown alias c9", b["error"])
        self.assertEqual(self._replies(w, b), [])

    def test_submission_must_answer_exactly_this_runs_events(self):
        w, b, wt, fix = self._fix({"event_keys": ["review:1"], "amend": None, "reply": "유지합니다."})
        b = self._end(w, b, fix)
        resume = w.adapter.launches[-1]
        self.assertEqual((b["state"], resume["kind"]), ("FIXING", "resume"))
        self.assertIn("review:77", resume["prompt"])
        self.assertEqual(w.git.stage2_amend_calls, [])


if __name__ == "__main__":
    unittest.main()
