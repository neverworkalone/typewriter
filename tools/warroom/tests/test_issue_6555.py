"""Issue #6555: a Stage 2 review fix submits only its judgment; the Supervisor applies it with the official CLI."""
import json
import unittest
from pathlib import Path

from tests import test_issue_6249 as t6249
from warroom.gitops import GitTransient, Stage2AmendRejected
from warroom.supervisor import S2_FIX_APPLY_ATTEMPTS, S2_FIX_COMMIT_SUBJECT, S2_FIX_RESPONSE

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

    def test_disagreement_without_amend_only_replies_and_keeps_full_verification(self):
        w, b, wt, fix = self._fix({"event_keys": ["review:77"], "amend": None, "reply": "[review:77] 유지합니다: 근거 …"})
        local_verifies = len(w.git.local_verify_calls)
        b = self._end(w, b, fix)
        self.assertEqual(b["state"], "WAITING_REVIEW", b["error"])
        self.assertEqual(w.git.stage2_amend_calls, [])
        self.assertFalse(getattr(w.git, "owned_fix_pushes", []))
        self.assertEqual(len(self._replies(w, b)), 1)
        self.assertEqual(len(w.git.local_verify_calls), local_verifies + 1)

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
