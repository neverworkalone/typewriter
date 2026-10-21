"""GitHub access through the isolated `gh` CLI."""
from __future__ import annotations

import json

from .shell import Runner


class GhError(Exception):
    pass


class GhClient:
    def __init__(self, runner: Runner, env: dict, repo: str):
        self.runner, self.env, self.repo = runner, env, repo

    def _api(self, path: str, paginate: bool = False):
        argv = ["gh", "api", path]
        if paginate:
            argv += ["--paginate", "--slurp"]
        r = self.runner.run(argv, env=self.env, timeout=60)
        if not r.ok:
            raise GhError(f"gh api {path}: {r.err.strip() or r.out.strip()}")
        data = json.loads(r.out or "null")
        if paginate:  # --slurp yields a list of pages
            return [item for page in data for item in page]
        return data

    def open_prs(self) -> list[dict]:
        r = self.runner.run(["gh", "pr", "list", "--repo", self.repo, "--state", "open",
                             "--limit", "300", "--json", "number,headRefName,files,title"],
                            env=self.env, timeout=60)
        if not r.ok:
            raise GhError(f"gh pr list: {r.err.strip()}")
        return json.loads(r.out or "[]")

    def prs_for_branch(self, branch: str) -> list[dict]:
        r = self.runner.run(["gh", "pr", "list", "--repo", self.repo, "--head", branch,
                             "--state", "all", "--json", "number,state,headRefOid"],
                            env=self.env, timeout=60)
        if not r.ok:
            raise GhError(f"gh pr list --head: {r.err.strip()}")
        return json.loads(r.out or "[]")

    def pull(self, n: int) -> dict:
        d = self._api(f"repos/{self.repo}/pulls/{n}")
        return {"number": n, "state": d["state"], "merged": bool(d.get("merged")),
                "head_sha": d["head"]["sha"], "head_ref": d["head"]["ref"],
                "url": d.get("html_url", "")}

    def reviews(self, n: int) -> list[dict]:
        return self._api(f"repos/{self.repo}/pulls/{n}/reviews", paginate=True)

    def inline_comments(self, n: int) -> list[dict]:
        return self._api(f"repos/{self.repo}/pulls/{n}/comments", paginate=True)

    def issue_comments(self, n: int) -> list[dict]:
        return self._api(f"repos/{self.repo}/issues/{n}/comments", paginate=True)

    def commit_time(self, sha: str) -> float:
        from .reviews import _ts
        d = self._api(f"repos/{self.repo}/commits/{sha}")
        return _ts(d["commit"]["committer"]["date"])
