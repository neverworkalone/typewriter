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
                             "--limit", "300", "--json", "number,headRefName,baseRefName,files,title"],
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

    def close_pr(self, n: int) -> None:
        """Close without merging; the branch is left alone (deleted separately, after verification)."""
        r = self.runner.run(["gh", "pr", "close", str(n), "--repo", self.repo], env=self.env, timeout=60)
        if not r.ok:
            raise GhError(f"gh pr close {n}: {r.err.strip() or r.out.strip()}")

    def pull(self, n: int) -> dict:
        d = self._api(f"repos/{self.repo}/pulls/{n}")
        return {"number": n, "state": d["state"], "merged": bool(d.get("merged")),
                "head_sha": d["head"]["sha"], "head_ref": d["head"]["ref"],
                "url": d.get("html_url", ""), "merge_commit_sha": d.get("merge_commit_sha") or ""}

    # ---- Issues (Issue #1555: shared-defect urgent Issues) --------------------------------------------------------
    def issue(self, n: int) -> dict:
        d = self._api(f"repos/{self.repo}/issues/{n}")
        return {"number": n, "state": d["state"], "labels": [l["name"] for l in d.get("labels", [])],
                "pull_request": "pull_request" in d, "body": d.get("body") or ""}

    def urgent_issues(self) -> list[dict]:
        """Every `urgent` Issue, open and closed, with its body. A list call (not search): it is consistent
        right after an Issue is created, so a just-created Issue is always found again (no duplicate)."""
        r = self.runner.run(["gh", "issue", "list", "--repo", self.repo, "--label", "urgent", "--state", "all",
                             "--limit", "500", "--json", "number,state,title,body"], env=self.env, timeout=60)
        if not r.ok:
            raise GhError(f"gh issue list: {r.err.strip()}")
        return [{**i, "state": str(i["state"]).lower()} for i in json.loads(r.out or "[]")]

    def create_issue(self, title: str, body: str, labels: list[str]) -> int:
        argv = ["gh", "issue", "create", "--repo", self.repo, "--title", title, "--body", body]
        for label in labels:
            argv += ["--label", label]
        r = self.runner.run(argv, env=self.env, timeout=60)
        if not r.ok:
            raise GhError(f"gh issue create: {r.err.strip() or r.out.strip()}")
        tail = r.out.strip().rsplit("/", 1)[-1]
        if not tail.isdigit():
            raise GhError(f"gh issue create: Issue 번호를 알 수 없습니다: {r.out.strip()[:200]}")
        return int(tail)

    def comment_issue(self, n: int, body: str) -> None:
        r = self.runner.run(["gh", "issue", "comment", str(n), "--repo", self.repo, "--body", body],
                            env=self.env, timeout=60)
        if not r.ok:
            raise GhError(f"gh issue comment: {r.err.strip() or r.out.strip()}")

    def pull_files(self, n: int) -> list[dict]:
        """All files changed by a PR, including closed and merged PRs."""
        return [{"path": f.get("filename")} for f in
                self._api(f"repos/{self.repo}/pulls/{n}/files", paginate=True)]

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
