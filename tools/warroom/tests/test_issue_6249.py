"""PR #6249: a Stage 2 review fix that ends with neither a new HEAD nor a reply re-runs once; a dead amend's lock
left in the worktree is cleared by the Supervisor before the fix starts."""
import json
import os
import subprocess
import unittest
from pathlib import Path

from tests import test_issue_2165 as t2165
from warroom import stage2


class UnansweredStage2Review(unittest.TestCase):
    start_optional_part = t2165.Stage2Finalization.start_optional_part

    def _waiting(self):
        w, b = self.start_optional_part({"code": 0, "session": "ses_chunk",
                                         "text": t2165.answer("chunk 001-01-01-001\nc1 D first")}, sense_id="w1-s1")
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        w.tick()
        b = w.store.batch(b["id"])
        links = w.adapter.launches[-1]
        digest = json.loads(w.store.get(stage2.links_start_key(b["id"])))["digest"]
        w.adapter.running[links["pid"]]["text"] = t2165.answer(f"links @{digest}\nc1 skip")
        w.adapter.running[links["pid"]]["session"] = "ses_links"
        w.adapter.finish(links["pid"])
        w.tick()
        b = w.store.batch(b["id"])
        self.assertEqual(b["state"], "WAITING_REVIEW")
        head = w.gh.pull(b["pr_number"])["head_sha"]
        w.gh.reviews_ = [{"id": 77, "user": {"login": "genonfire"}, "state": "COMMENTED", "commit_id": head,
                          "body": f"-1\nHEAD: {head}\nover-approval", "submitted_at": "2026-11-13T16:27:55Z"}]
        w.gh.issue_ = []
        return w, b

    def _poll(self, w, b):
        w.store.set(f"last_poll_{b['id']}", "0")
        w.sup._watch(w.store.batch(b["id"]))

    def _fix_ends_silently(self, w, b):
        fix = w.adapter.launches[-1]
        w.adapter.finish(fix["pid"])
        w.tick()
        self.assertEqual(w.store.batch(b["id"])["state"], "WAITING_REVIEW")

    def test_silent_fix_reruns_once_then_stops_with_evidence(self):
        w, b = self._waiting()
        launches = len(w.adapter.launches)
        self._poll(w, b)
        self.assertEqual(len(w.adapter.launches), launches + 1)          # first fix run for the -1
        self._fix_ends_silently(w, b)
        self._poll(w, b)
        self.assertEqual(len(w.adapter.launches), launches + 2)          # no HEAD, no reply: the same fix once more
        self.assertEqual(w.store.batch(b["id"])["run_kind"], "fix_new")
        self._fix_ends_silently(w, b)
        self._poll(w, b)
        b = w.store.batch(b["id"])
        self.assertEqual(b["state"], "ERROR")                              # not a silent review wait for ever
        self.assertIn("review:77", b["error"])
        self.assertEqual(len(w.adapter.launches), launches + 2)

    def test_a_reply_after_the_review_is_a_rebuttal_awaiting_re_review(self):
        w, b = self._waiting()
        self._poll(w, b)
        self._fix_ends_silently(w, b)
        w.gh.issue_ = [{"id": 5, "user": {"login": "neverworkalone-agent"}, "body": "반론: 근거 …",
                        "created_at": "2026-11-13T16:40:00Z"}]
        launches = len(w.adapter.launches)
        self._poll(w, b)
        self._poll(w, b)
        self.assertEqual(len(w.adapter.launches), launches)
        self.assertEqual(w.store.batch(b["id"])["state"], "WAITING_REVIEW")

    def test_an_inline_review_thread_reply_is_also_a_rebuttal(self):
        w, b = self._waiting()
        self._poll(w, b)
        self._fix_ends_silently(w, b)
        head = w.gh.pull(b["pr_number"])["head_sha"]
        w.gh.inline_ = [{"id": 9, "user": {"login": "neverworkalone-agent"}, "body": "이 행은 정책상 유지합니다: 근거 …",
                         "commit_id": head, "pull_request_review_id": 77, "in_reply_to_id": 8,
                         "created_at": "2026-11-13T16:41:00Z"}]
        launches = len(w.adapter.launches)
        self._poll(w, b)
        self._poll(w, b)
        self.assertEqual(len(w.adapter.launches), launches)
        self.assertEqual(w.store.batch(b["id"])["state"], "WAITING_REVIEW")

    def test_dead_amend_lock_is_removed_before_the_fix_and_a_live_one_is_kept(self):
        w, b = self._waiting()
        lock = Path(b["worktree"]) / ".warroom-scratch" / "relation-admission-001-01-01.json.amend-lock"
        gone = subprocess.Popen(["true"])
        gone.wait()
        lock.write_text(f"{gone.pid}:3cef53a3-fb13-4ac9-ba7d-c3c895d1aae8:", "utf-8")
        self._poll(w, b)
        self.assertFalse(lock.exists())
        live = f"{os.getpid()}:uuid:"
        lock.write_text(live, "utf-8")
        self._fix_ends_silently(w, b)
        self._poll(w, b)
        self.assertEqual(lock.read_text("utf-8"), live)


if __name__ == "__main__":
    unittest.main()
