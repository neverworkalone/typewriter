"""#7795: a D worker must not give up when a malformed `reread` request is rejected."""
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[3]


class RereadContract(unittest.TestCase):
    def test_prompts_limit_reread_to_completed_conditions(self):
        for name in ("d_chunk.md", "d_chunk_resume.md"):
            text = (ROOT / "tools/warroom/prompts" / name).read_text(encoding="utf-8")
            self.assertIn('`cursor:"next"`', text, name)
            self.assertIn("LIMITED", text, name)
            self.assertIn("`reread`", text, name)

    def test_resume_prompt_says_rejected_request_is_corrected_not_abandoned(self):
        text = (ROOT / "tools/warroom/prompts/d_chunk_resume.md").read_text(encoding="utf-8")
        self.assertIn("INVALID_CURSOR", text)
        self.assertIn("저장을 포기하지 않는다", text)

    def test_cli_reread_rejection_is_correctable_guidance(self):
        cli = (ROOT / "scripts/relation/d-chunk-cli.mjs").read_text(encoding="utf-8")
        self.assertEqual(cli.count("proven completed condition"), 2)
        self.assertEqual(cli.count("`, 'reread')"), 2)


if __name__ == "__main__":
    unittest.main()
