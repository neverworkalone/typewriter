"""Issue #3378: prompts and the runtime root are bound to the verified operating checkout, never a temporary worktree."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from warroom import prompts
from warroom.config import REPO_ROOT, ROOT_ENV, Paths, RootError, check_runtime_root, operating_root


def fake_root(tmp: str, text: str | None = "main {{issue}} {{branch}}") -> Path:
    root = Path(tmp).resolve()
    d = root / "tools" / "warroom" / "prompts"
    d.mkdir(parents=True)
    if text is not None:
        (d / "m.md").write_text(text, "utf-8")
    return root


VALUES = {"issue": "7", "branch": "b"}


class OperatingRoot(unittest.TestCase):
    def test_prompts_come_from_the_operating_root_not_the_importing_worktree(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict("os.environ", {ROOT_ENV: str(fake_root(tmp))}):
            self.assertEqual(prompts.render("m", VALUES), "main 7 b")
            self.assertEqual(Paths().repo_root, Path(tmp).resolve())

    def test_a_missing_or_empty_main_prompt_fails_without_falling_back(self):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict("os.environ", {ROOT_ENV: str(fake_root(tmp, None))}):
            with self.assertRaises(prompts.PromptError) as e:
                prompts.render("m", VALUES)   # the importing checkout does have m.md; it must not be read
            self.assertIn(tmp, str(e.exception))
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict("os.environ", {ROOT_ENV: str(fake_root(tmp, "  \n"))}):
            with self.assertRaises(prompts.PromptError):
                prompts.render("m", VALUES)

    def test_an_invalid_operating_root_is_a_prompt_error(self):
        for bad in ("relative/path", "/nonexistent/typewriter-root"):
            with mock.patch.dict("os.environ", {ROOT_ENV: bad}), self.assertRaises(prompts.PromptError):
                prompts.render("m", VALUES)

    def test_explicit_directory_injection_is_kept(self):
        with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as other:
            (Path(tmp) / "m.md").write_text("injected {{issue}}", "utf-8")
            with mock.patch.dict("os.environ", {ROOT_ENV: str(fake_root(other))}):
                self.assertEqual(prompts.render("m", VALUES, Path(tmp)), "injected 7")

    def test_runtime_code_must_be_imported_from_the_operating_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict("os.environ", {ROOT_ENV: str(fake_root(tmp))}), self.assertRaises(RootError):
                check_runtime_root()   # this process was imported from REPO_ROOT, not from tmp
        with mock.patch.dict("os.environ", {ROOT_ENV: str(REPO_ROOT)}):
            self.assertEqual(check_runtime_root(), REPO_ROOT)
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertEqual(operating_root(), REPO_ROOT)


class LauncherRoot(unittest.TestCase):
    """`./war` and `./dashboard` refuse a linked worktree (`.git` file) before starting any Python."""

    def run_launcher(self, name: str, git_is_dir: bool) -> subprocess.CompletedProcess:
        with tempfile.TemporaryDirectory() as tmp:
            root = fake_root(tmp, "x")
            shutil.copy(REPO_ROOT / name, root / name)
            if git_is_dir:
                (root / ".git").mkdir()
            else:
                (root / ".git").write_text("gitdir: /elsewhere\n", "utf-8")
            # PATH has no tmux/python venv: a passing check can only fail later, never with the root message.
            return subprocess.run(["/bin/sh", str(root / name)], capture_output=True, text=True,
                                  env={"PATH": "/usr/bin:/bin", "TMUX": ""}, timeout=30)

    def test_linked_worktree_is_refused_and_main_checkout_passes_the_check(self):
        for name in ("war", "dashboard"):
            bad = self.run_launcher(name, git_is_dir=False)
            self.assertEqual(bad.returncode, 1)
            self.assertIn("운영 메인 checkout이 아닙니다", bad.stderr)
            good = self.run_launcher(name, git_is_dir=True)
            self.assertNotIn("운영 메인 checkout이 아닙니다", good.stderr)


if __name__ == "__main__":
    unittest.main()
