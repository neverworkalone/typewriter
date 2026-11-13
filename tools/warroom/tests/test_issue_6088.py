import unittest
from warroom.gitops import Git, NODE_HEAP_MB, _with_node_heap


class NodeHeapForCliRuns(unittest.TestCase):
    def test_default_heap_raised_for_every_git_env(self):
        env = _with_node_heap({"PATH": "/bin"})
        self.assertEqual(env["NODE_OPTIONS"], f"--max-old-space-size={NODE_HEAP_MB}")
        self.assertEqual(env["PATH"], "/bin")

    def test_existing_options_are_kept_and_extended(self):
        env = _with_node_heap({"NODE_OPTIONS": "--trace-warnings"})
        self.assertEqual(env["NODE_OPTIONS"], f"--trace-warnings --max-old-space-size={NODE_HEAP_MB}")

    def test_explicit_operator_heap_wins(self):
        src = {"NODE_OPTIONS": "--max-old-space-size=2048"}
        self.assertIs(_with_node_heap(src), src)

    def test_git_wires_it(self):
        g = Git(object(), "/tmp", {"PATH": "/bin"}, "/tmp/wt")
        self.assertIn("--max-old-space-size", g.env["NODE_OPTIONS"])


if __name__ == "__main__":
    unittest.main()
