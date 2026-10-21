from __future__ import annotations

import json

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
        self.models = ["p/free-x-free", "p/go"]
        self.models_ok = True
        self.variant_rejected: set[str] = set()   # model#variant the fake OpenCode refuses before the provider call
        self.probe_answer = "text"                # what an accepted probe returns: text | quota | silent | garbage
        self.probes: list[str] = []

    def ok_auth(self, account):
        self.account = account

    def set_batches(self, canon, done):
        self.canon, self.done = canon, done

    def run(self, argv, cwd=None, env=None, input=None, timeout=120):
        self.calls.append(list(argv))
        if argv[:3] == ["gh", "api", "user"]:
            return Result(0, self.account + "\n") if self.api_ok else Result(1, "", "not logged in")
        if argv[:2] == ["gh", "api"] and ".permissions.push" in argv:
            return Result(0, self.push + "\n")
        if argv[:3] == ["gh", "auth", "git-credential"]:
            return Result(0, "username=x\npassword=SECRET\n") if self.cred_ok else Result(1, "", "no")
        if argv[1:] == ["models"]:
            return Result(0, "\n".join(self.models)) if self.models_ok else Result(1, "", "boom")
        if argv[1:2] == ["run"]:   # OpenCode start-time probe: model#variant, then the provider
            spec = argv[argv.index("--model") + 1]
            self.probes.append(spec)
            if spec in self.variant_rejected:
                return Result(1, json.dumps({"type": "error", "error": {"type": "provider.no-route",
                              "message": f"Variant unavailable for {spec}"}}) + "\n")
            if self.probe_answer == "quota":
                return Result(1, json.dumps({"type": "error", "error": {"type": "provider.quota",
                              "message": "Rate limit exceeded"}}) + "\n")
            if self.probe_answer == "silent":
                return Result(124, "", "timeout: opencode")
            if self.probe_answer == "garbage":
                return Result(0, "not json at all\n")
            return Result(0, json.dumps({"type": "text", "part": {"text": "OK"}}) + "\n")
        if argv[:2] == ["git", "ls-tree"]:
            return Result(0, "".join(f"{p}\n" for p in self.done))      # existence, including 0-byte files
        if argv[:2] == ["git", "grep"]:
            ref = argv[4]
            spec = argv[-1]
            if "canonical" in spec:
                rows = {f"data/canonical/stdict-{k:04d}.jsonl": v for k, v in self.canon.items()}
            else:
                rows = {p: n for p, n in self.done.items() if n}   # git grep -c prints nothing for empty files
            return Result(0 if rows else 1, "".join(f"{ref}:{p}:{n}\n" for p, n in rows.items()))
        return Result(0, "")
