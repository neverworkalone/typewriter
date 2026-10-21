from __future__ import annotations

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
        if argv[:2] == ["git", "grep"]:
            ref = argv[4]
            spec = argv[-1]
            if "canonical" in spec:
                rows = {f"data/canonical/stdict-{k:04d}.jsonl": v for k, v in self.canon.items()}
            else:
                rows = self.done
            return Result(0 if rows else 1, "".join(f"{ref}:{p}:{n}\n" for p, n in rows.items()))
        return Result(0, "")
