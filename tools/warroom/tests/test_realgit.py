"""War Room's own Git calls and the worker shim never run the shim or a cache-poisoned xcrun stub."""
from __future__ import annotations

import importlib.machinery
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from warroom import realgit
from warroom.gitops import Git
from warroom.realgit import SHIM_DIR, resolve_git
from warroom.shell import Runner


def _script(path: Path, body: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)
    return str(path)


class PoisonedStub(unittest.TestCase):
    """The stub at /usr/bin/git, whose xcrun cache (poisoned by an earlier run) points back at the shim."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        d = Path(self.tmp.name)
        self.stub = _script(d / "usr-bin" / "git", f'exec "{SHIM_DIR / "git"}" "$@"\n')   # what the poisoned cache does
        self.dev = d / "dev"
        self.dev_git = _script(self.dev / "usr" / "bin" / "git", 'echo "real git $*"\n')
        patcher = mock.patch.object(realgit, "XCRUN_STUB", Path(self.stub))
        patcher.start()
        self.addCleanup(patcher.stop)
        realgit._developer_dir.cache_clear()
        self.env = {"PATH": os.pathsep.join((str(SHIM_DIR), str(d / "usr-bin"))), "DEVELOPER_DIR": str(self.dev)}

    def test_resolution_table(self):
        d = Path(self.tmp.name)
        link = d / "link"
        link.mkdir()
        (link / "git").symlink_to(SHIM_DIR / "git")
        other = _script(d / "other" / "git", "true\n")
        no_dev = {**self.env, "DEVELOPER_DIR": str(d / "missing")}
        for case, env, expected in [
                ("stub swapped for the developer-dir git", self.env, self.dev_git),
                ("shim and symlink to it skipped", {**self.env, "PATH": f"{SHIM_DIR}{os.pathsep}{link}{os.pathsep}"
                                                    f"{d / 'usr-bin'}"}, self.dev_git),
                ("unusable stub falls through to the next git", {**no_dev, "PATH": os.pathsep.join(
                    (self.env["PATH"], str(d / "other")))}, other),
                ("unusable stub and nothing else", no_dev, None),
                ("only the shim", {**self.env, "PATH": str(SHIM_DIR)}, None)]:
            with self.subTest(case):
                self.assertEqual(resolve_git(env), expected)

    def test_supervisor_git_runs_the_real_git_when_the_cache_is_poisoned(self):
        git = Git(Runner(), Path(self.tmp.name), self.env, Path(self.tmp.name) / "wt")
        res = git._git("fetch", "origin", "master")
        self.assertEqual(res.out.strip(), "real git fetch origin master")

    def test_worker_shim_runs_the_real_git_when_the_cache_is_poisoned(self):
        loader = importlib.machinery.SourceFileLoader("warroom_git_shim", str(SHIM_DIR / "git"))
        shim = importlib.util.module_from_spec(importlib.util.spec_from_loader(loader.name, loader))
        loader.exec_module(shim)
        with mock.patch.dict(os.environ, self.env):
            real, clean_path = shim._real_git()
        self.assertEqual(real, self.dev_git)
        self.assertNotIn(str(SHIM_DIR), clean_path.split(os.pathsep))


if __name__ == "__main__":
    unittest.main()
