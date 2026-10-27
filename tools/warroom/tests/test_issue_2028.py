"""Issue #2028: an approved Maintainer integration moves the Stage 2 chunk run-start baseline to the integrated HEAD;
any other HEAD/remote movement keeps failing closed."""
import json
import unittest

from tests.fakes import HEAD1, HEAD2
from tests.test_issue_1908 import s2_world, write_state
from tests.test_issue_1684 import S2
from warroom import control, stage2

MERGE = "c" * 40
HEAD3 = "e" * 40


class Stage2BaselineAfterMaintainerFix(unittest.TestCase):
    def setUp(self):
        self.w = w = s2_world(self)
        self.addCleanup(w.tmp.cleanup)
        control.start(w.store, "claude", S2, "single", cfg=w.cfg)
        w.adapter.plan.append({"code": 2, "session": "ses_old", "effect": lambda: write_state(
            w.store.active_batch("claude", S2), decided=1, total=2, next_chunk=2)})
        w.tick()                                           # chunk 1 starts: baseline A = HEAD1 stored
        self.b = w.store.active_batch("claude", S2)
        self.key = stage2.run_start_key(self.b["id"])
        w.adapter.finish(w.adapter.launches[-1]["pid"])    # the old chunk process is gone
        # forward-merge semantics for the fake: the old HEAD is an ancestor of the integrated one
        self.ancestors = {HEAD1}
        w.git.contains = lambda path, sha: sha in self.ancestors or (str(path), sha) in w.git.integrated

    def pause_for_defect(self, state="FIX_MERGED"):
        w, b = self.w, self.b
        did = w.store.report_defect(b["id"], "k", "report", "source-sense-gloss-missing", "REPORTED", "{}",
                                    "shared_defect", "paused")
        w.store.update(b["id"], state="PAUSED", pause_reason="shared_defect", paused_from="PRODUCING",
                       defect_id=did, pid=None)
        w.store.update_defect(did, state=state, issue_number=1, merge_sha=MERGE)
        w.store.ensure_maintenance(1)
        return did

    def head(self):
        return json.loads(self.w.store.get(self.key))["head"]

    def test_release_moves_baseline_and_resumes_exactly_one_new_chunk(self):
        w = self.w
        did = self.pause_for_defect()
        w.git.local_head = HEAD2                           # git.integrate merged the PR commit
        launches = len(w.adapter.launches)
        w.tick(3)
        b = w.store.batch(self.b["id"])
        self.assertEqual(w.store.defect(did)["state"], "RELEASED")
        self.assertEqual((b["state"], b["run_kind"]), ("PRODUCING", "s2_chunk_new"))
        self.assertEqual(len(w.adapter.launches), launches + 1)          # exactly one new chunk run
        self.assertEqual(self.head(), HEAD2)                              # boundary now recorded at B
        w.tick(3)
        self.assertEqual(len(w.adapter.launches), launches + 1)

    def test_unrelated_head_is_not_retargeted_at_release(self):
        w = self.w
        self.ancestors.clear()                             # old HEAD is NOT an ancestor of the integrated HEAD
        did = self.pause_for_defect()
        w.git.local_head = HEAD2
        w.tick(3)
        self.assertEqual(self.head(), HEAD1)
        self.assertEqual(w.store.batch(self.b["id"])["state"], "ERROR")  # fails closed, record preserved

    def test_remote_moved_is_not_retargeted(self):
        w = self.w
        self.pause_for_defect()
        w.git.local_head = HEAD2
        w.git.remote[self.b["branch"]] = HEAD3
        w.tick(3)
        self.assertEqual(w.store.batch(self.b["id"])["state"], "ERROR")

    def test_released_batch_in_error_recovers_only_for_the_integrated_head(self):
        w = self.w
        did = self.pause_for_defect()
        w.git.local_head = HEAD2
        w.tick(3)
        # reproduce the reported state: RELEASED, but the baseline still holds the old HEAD and the batch is ERROR
        w.adapter.finish(w.adapter.launches[-1]["pid"])
        stale = json.loads(w.store.get(self.key)); stale["head"] = HEAD1
        w.store.set(self.key, json.dumps(stale, sort_keys=True))
        w.store.update(self.b["id"], state="ERROR", pid=None, error="boundary")
        w.git.local_head = HEAD3                           # unauthorized: not the integrated HEAD
        n = len(w.adapter.launches)
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(3)
        self.assertEqual(w.store.batch(self.b["id"])["state"], "ERROR")
        self.assertEqual((self.head(), len(w.adapter.launches)), (HEAD1, n))
        w.git.local_head = HEAD2                           # the exact HEAD the released defect integrated
        w.store.update(self.b["id"], state="ERROR", pid=None)
        self.assertTrue(control.retry(w.store, "claude", S2))
        w.tick(3)
        self.assertEqual(w.store.batch(self.b["id"])["state"], "PRODUCING")
        self.assertEqual(len(w.adapter.launches), n + 1)


if __name__ == "__main__":
    unittest.main()
