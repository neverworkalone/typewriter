from __future__ import annotations

import json
import fnmatch
import os
from pathlib import Path

from tests.fake_s3 import FakeEditCli, FakeS4Cli
from warroom.shell import Result, Runner


class ScriptedRunner(Runner):
    """Answers gh/git-grep calls from in-memory state; records every argv."""

    def __init__(self):
        self.calls: list[list[str]] = []
        self.account = "neverworkalone-agent"
        self.push = "true"
        self.cred_ok = True
        self.api_ok = True
        self.canon: dict[int, int] = {}
        self.done: dict[str, int] = {}
        self.layout_text: str | None = json.dumps({"version": 1, "legacy_through_shard": "005", "legacy_part_size": 100, "part_size": 250})
        self.layout_refs: list[str] = []          # every `<sha>:config/stage2-part-layout.json` the code asked for
        self.master_stage2_files: list[str] = []  # data/relations|relation-drops files present on the fixed master SHA
        self.edit = FakeEditCli()                  # Stage 3 explicit chunk CLI (#3149)
        self.s4 = FakeS4Cli()                      # Stage 4 chunk CLI with record views (#10047)

    def ok_auth(self, account):
        self.account = account

    def set_batches(self, canon, done):
        self.canon, self.done = canon, done

    def run(self, argv, cwd=None, env=None, input=None, timeout=120):
        argv = ["git", *argv[1:]] if argv and os.path.basename(argv[0]) == "git" else argv   # a resolved Git path
        self.calls.append(list(argv))
        if len(argv) > 2 and Path(argv[1]).name == "edit-cli.mjs":
            return self.edit.run(argv, cwd)
        if len(argv) > 2 and Path(argv[1]).name == "s4-cli.mjs":
            return self.s4.run(argv, cwd)
        if argv[:3] == ["gh", "api", "user"]:
            return Result(0, self.account + "\n") if self.api_ok else Result(1, "", "not logged in")
        if argv[:2] == ["gh", "api"] and ".permissions.push" in argv:
            return Result(0, self.push + "\n")
        if argv[:3] == ["gh", "auth", "git-credential"]:
            return Result(0, "username=x\npassword=SECRET\n") if self.cred_ok else Result(1, "", "no")
        if argv[:2] == ["git", "show"] and argv[2].endswith(":config/stage2-part-layout.json"):
            self.layout_refs.append(argv[2])
            return Result(0, self.layout_text) if self.layout_text is not None else Result(128, "", "missing")
        if argv[:2] == ["git", "ls-tree"]:
            if "data/relations" in argv:
                return Result(0, "".join(f"{p}\n" for p in self.master_stage2_files))
            return Result(0, "".join(f"{p}\n" for p in self.done))      # existence, including 0-byte files
        if argv[:2] == ["git", "grep"]:
            ref = argv[4]
            specs = argv[argv.index("--") + 1:]
            if any("canonical" in spec for spec in specs):
                rows = {f"data/canonical/stdict-{k:04d}.jsonl": v for k, v in self.canon.items()}
            else:
                rows = {p: n for p, n in self.done.items() if n and any(fnmatch.fnmatchcase(p, spec) for spec in specs)}   # empty files yield no grep output
            return Result(0 if rows else 1, "".join(f"{ref}:{p}:{n}\n" for p, n in rows.items()))
        return Result(0, "")
