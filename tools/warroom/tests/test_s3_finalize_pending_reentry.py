import json
import re
import unittest
from pathlib import Path

from tests.fakes import World


class S3FinalizePendingReentry(unittest.TestCase):
    """A transient failure inside Stage 3 finalize (e.g. an unconfirmed `gh pr create`) records a `finalize`
    pending with run_kind `s3_finalize`; re-entry must dispatch it instead of raising KeyError every tick."""

    def setUp(self):
        from tests.test_issue_1555 import make_batch
        self.w = World()
        self.addCleanup(self.w.tmp.cleanup)
        self.b = make_batch(self.w, method='s3', run_kind='s3_finalize', state='PRODUCING', worktree=False)

    def test_s3_finalize_pending_reenters_stage3_finalize(self):
        w, b = self.w, self.b
        calls = []
        w.sup._stage3_finalize = lambda x: calls.append(x['id'])
        w.store.set(f"pending_{b['id']}", json.dumps({'stage': 'finalize', 'evidence': {
            'run_kind': 's3_finalize', 'worktree': str(b['worktree']), 'head': None}}))
        self.assertTrue(w.sup._reenter_pending(b, 'finalize', {'run_kind': 's3_finalize'}))
        self.assertEqual(calls, [b['id']])
        self.assertIsNone(w.store.get(f"pending_{b['id']}"))

    def test_every_finalize_run_kind_set_by_the_supervisor_is_reenterable(self):
        src = (Path(__file__).resolve().parents[1] / 'warroom' / 'supervisor.py').read_text()
        body = src[src.index('    def _reenter_pending('):src.index('    def _pending_problem(')]
        table = body[body.index('fin = {'):body.index('fin[ev["run_kind"]](b)')]
        kinds = set(re.findall(r'run_kind="([a-z0-9_]+_finalize)"', src))
        self.assertTrue(kinds)
        for kind in sorted(kinds):
            self.assertIn(f'"{kind}"', table, kind)


if __name__ == '__main__':
    unittest.main()
