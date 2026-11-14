"""Issue #6555: a Stage 3 review fix submits only its judgment; the Review FIXING Coordinator applies it."""
import json
import unittest
from pathlib import Path
from unittest import mock

from tests import test_issue_2450_stage3 as t2450
from tests.fakes import HEAD1
from warroom.gitops import GitError, RefineAmendRejected
from warroom.supervisor import S3_FIX

RELATION, DROP = t2450.RELATION, t2450.DROP
NEW_HEAD = "9" * 40
EVENT = {"kind": "review", "author": "reviewer", "key": "review:31",
         "body": f"-1\nHEAD: {HEAD1}\nw1-s1 row 2 links the wrong Sense."}
AMEND = {"event_keys": ["review:31"], "amend": "amend\nK 2\nD 3", "reply": "Kept row 2 and dropped row 3."}


class SupervisedStage3Fix(unittest.TestCase):
    setUp = t2450.Stage3SupervisorFlow.setUp
    _batch = t2450.Stage3SupervisorFlow._batch

    def _fix(self, response):
        """Launch a fix for one -1, let its run submit `response` and end successfully; return the FIXING batch."""
        w = self.w
        batch = self._batch(state="WAITING_REVIEW", run_kind="s3_finalize")
        w.store.update(batch["id"], pr_number=9, head_sha=HEAD1, session_id="production-session")
        with mock.patch.object(w.sup, "_preflight", return_value=None), \
                mock.patch.object(w.sup, "_agent_env", return_value={}), \
                mock.patch.object(w.sup, "_launch_env", return_value={}):
            w.sup._launch(w.store.batch(batch["id"]), "fix_new", [EVENT])
        self.assertEqual(w.git.refine_decision_calls[-1], ("001", "b" * 40, ("w1-s1",)))
        wt = Path(batch["worktree"])
        if response is not None:
            (wt / S3_FIX.response).parent.mkdir(parents=True, exist_ok=True)
            (wt / S3_FIX.response).write_text(json.dumps(response), "utf-8")
        run = w.store.runs(batch["id"])[0]
        w.store.finish_runs(batch["id"], 0)
        w.store.update(batch["id"], pid=None, session_id="fix-session")
        w.store.set(f"verified_completion_run_{batch['id']}", str(run["id"]))
        w.gh.prs[9] = {"number": 9, "state": "open", "merged": False, "head_sha": HEAD1, "head_ref": batch["branch"],
                        "title": "[Relation Stage 3] 001", "body": "Implements #2450", "base_ref": "master"}
        w.gh.files[9] = [{"path": RELATION}, {"path": DROP}]
        w.gh.comment_issue = lambda n, body: w.gh.add_pr_reply(n, body, login=w.cfg["expected_account"])
        old_commit, old_push = w.git.commit_paths, w.git.push_owned_fix

        def commit(path, rels, message, **kwargs):
            parent = w.git.local_head
            old_commit(path, rels, message, **kwargs)
            w.git.local_head, w.git.commit_parent_sha = NEW_HEAD, parent
            return NEW_HEAD

        def push(path, branch, remote_sha, local):
            old_push(path, branch, remote_sha, local)
            w.gh.prs[9]["head_sha"] = local
        w.git.commit_paths, w.git.push_owned_fix = commit, push
        return w.store.batch(batch["id"])

    def _apply(self, batch):
        self.w.sup._run_ok(self.w.store.batch(batch["id"]))
        return self.w.store.batch(batch["id"])

    def _replies(self):
        return [c["body"] for c in self.w.gh.issue_comments_.get(9, [])]

    def _handled(self, batch):
        event = self.w.store.handled_event(batch["id"], 9, HEAD1, "review:31")
        return event is not None and event["status"] == "HANDLED" and event["reply_id"] is not None

    def test_amend_is_committed_verified_once_pushed_and_answered_once(self):
        w = self.w
        batch = self._fix(AMEND)
        w.git.refine_amend_results.append({"changes": {RELATION: "after\n"}})
        w.git.verify_heads.add((NEW_HEAD, "shard", "001", None, None))
        done = self._apply(batch)
        self.assertEqual(done["state"], "WAITING_REVIEW", done["error"])
        self.assertEqual(w.git.refine_amend_calls, [("001", "b" * 40, "amend\nK 2\nD 3\n")])
        self.assertEqual(w.git.commits[-1], ([RELATION], S3_FIX.commit_subject))
        self.assertEqual(w.git.owned_fix_pushes, [(batch["branch"], HEAD1, NEW_HEAD)])
        self.assertEqual(w.git.verify_calls.count(("shard", "001", None, None)), 1, "the exact HEAD is verified once")
        replies = self._replies()
        self.assertEqual(len(replies), 1)
        self.assertIn("WarRoom-Review-Event: review:31", replies[0].splitlines())
        self.assertIn(f"WarRoom-Fix-Head: {NEW_HEAD}", replies[0].splitlines())
        self.assertTrue(self._handled(batch))
        self.assertIsNone(w.sup.s3fix.baseline(done))

    def test_rebuttal_changes_nothing_and_is_answered(self):
        w = self.w
        batch = self._fix(dict(AMEND, amend=None, reply="Row 2 is the correct Sense."))
        w.git.verify_heads.add((HEAD1, "shard", "001", None, None))
        done = self._apply(batch)
        self.assertEqual(done["state"], "WAITING_REVIEW", done["error"])
        self.assertEqual((getattr(w.git, "refine_amend_calls", []), getattr(w.git, "commits", [])), ([], []))
        self.assertEqual(len(self._replies()), 1)
        self.assertTrue(self._handled(batch))

    def test_refused_delta_returns_to_the_session_with_its_events_then_stops(self):
        w = self.w
        batch = self._fix(AMEND)
        relaunch = mock.Mock()
        with mock.patch.object(w.sup, "_launch", relaunch):
            for _ in range(S3_FIX.attempts):
                w.git.refine_amend_results.append(RefineAmendRejected("D 9: base Relation row is unknown"))
                (Path(batch["worktree"]) / S3_FIX.response).write_text(json.dumps(AMEND), "utf-8")
                w.git.refine_amend_requests = {}
                self.assertEqual(self._apply(batch)["state"], "FIXING")
            self.assertEqual(relaunch.call_count, S3_FIX.attempts)
            self.assertEqual(relaunch.call_args.args[1:3], ("fix_resume", [dict(EVENT, path=None, line=None)]))
            self.assertIn("base Relation row is unknown", relaunch.call_args.kwargs["s2_fix_note"])
            w.git.refine_amend_results.append(RefineAmendRejected("D 9: base Relation row is unknown"))
            (Path(batch["worktree"]) / S3_FIX.response).write_text(json.dumps(AMEND), "utf-8")
            w.git.refine_amend_requests = {}
            self.assertEqual(self._apply(batch)["state"], "ERROR")
        self.assertEqual(self._replies(), [])

    def test_interrupted_amend_replays_the_same_input(self):
        w = self.w
        batch = self._fix(AMEND)
        w.git.refine_amend_results.append({"changes": {RELATION: "after\n"}, "fail_after_write": True})
        w.git.refine_amend_results.append({"changes": {RELATION: "after\n"}})
        w.git.verify_heads.add((NEW_HEAD, "shard", "001", None, None))
        # An operational failure after a partial write: the same input runs again, never a new judgment.
        done = self._apply(batch)
        self.assertEqual(done["state"], "WAITING_REVIEW", done["error"])
        self.assertEqual([call[2] for call in w.git.refine_amend_calls], ["amend\nK 2\nD 3\n"] * 2)


    def test_a_failed_pr_context_lookup_starts_no_session_and_completes_nothing(self):
        w = self.w
        batch = self._batch(state="WAITING_REVIEW", run_kind="s3_finalize")
        w.store.update(batch["id"], pr_number=9, head_sha=HEAD1, session_id="production-session")
        launches = len(w.adapter.launches)
        with mock.patch.object(w.git, "refine_decisions", side_effect=GitError("edit-cli decisions 실패(exit 1)")), \
                mock.patch.object(w.sup, "_preflight", return_value=None), \
                mock.patch.object(w.sup, "_agent_env", return_value={}), \
                mock.patch.object(w.sup, "_launch_env", return_value={}):
            w.sup._launch(w.store.batch(batch["id"]), "fix_new", [EVENT])
        failed = w.store.batch(batch["id"])
        self.assertEqual(failed["state"], "ERROR")
        self.assertIn("PR context", failed["error"])
        self.assertEqual(len(w.adapter.launches), launches)
        self.assertEqual(w.store.runs(batch["id"]), [])
        self.assertIsNone(w.sup.s3fix.baseline(failed))
        self.assertIsNone(w.store.handled_event(batch["id"], 9, HEAD1, "review:31"))

    def test_changes_unrelated_to_the_submission_are_preserved_not_applied(self):
        w = self.w
        batch = self._fix(AMEND)
        (Path(batch["worktree"]) / "README.md").write_text("stray\n", "utf-8")
        w.git.dirty_text = " M README.md\n"
        self.assertEqual(self._apply(batch)["state"], "ERROR")
        self.assertEqual((w.git.refine_amend_calls, self._replies()), ([], []))

    def test_reentry_after_commit_resumes_without_a_second_amend_or_reply(self):
        w = self.w
        batch = self._fix(AMEND)
        w.git.refine_amend_results.append({"changes": {RELATION: "after\n"}})
        w.git.verify_heads.add((NEW_HEAD, "shard", "001", None, None))
        with mock.patch.object(w.git, "push_owned_fix", side_effect=GitError("network down")):
            self.assertEqual(self._apply(batch)["state"], "ERROR")
        w.store.update(batch["id"], state="FIXING", error=None)
        done = self._apply(batch)
        self.assertEqual(done["state"], "WAITING_REVIEW", done["error"])
        self.assertEqual(len(w.git.refine_amend_calls), 1)
        self.assertEqual(len(self._replies()), 1)


if __name__ == "__main__":
    unittest.main()
