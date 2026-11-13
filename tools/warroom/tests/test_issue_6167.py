"""Issue #6167: a busy master must not turn Stage 2 finalization/reconcile sync into a batch ERROR."""
import unittest

from warroom.gitops import GitTransient
from warroom.supervisor import Supervisor


class _MovingGit:
    def __init__(self, advances):
        self.advances = advances
        self.tip = 0
        self.have = 0
        self.merges = 0

    def fetch_base(self, base):
        if self.advances > 0 and self.tip == self.have:
            self.advances -= 1
            self.tip += 1
        return str(self.tip)

    def contains(self, wt, sha):
        return int(sha) <= self.have

    def integrate(self, wt, branch, base, sha):
        self.have = int(sha)
        self.merges += 1


class _S:
    def __init__(self, git):
        self.git = git


class ConvergeTest(unittest.TestCase):
    def run_it(self, advances):
        g = _MovingGit(advances)
        return g, Supervisor._converge_to_latest_base(_S(g), "wt", "b", "master")

    def test_already_current(self):
        g, r = self.run_it(0)
        self.assertFalse(r)

    def test_master_advances_more_than_twice(self):
        for n in (1, 2, 3, 4, 8):
            g, r = self.run_it(n)
            self.assertTrue(r)
            self.assertGreaterEqual(g.merges, 1)

    def test_endless_advance_is_transient(self):
        with self.assertRaises(GitTransient):
            self.run_it(10**6)


if __name__ == "__main__":
    unittest.main()
