"""GitHub access through the isolated `gh` CLI."""
from __future__ import annotations

import json
import re

from .shell import Result, Runner, transient


class GhError(Exception):
    pass


class GhTransient(GhError):
    """The query failed in a way asking again can fix (timeout, 5xx, 429, rate limit, network); nothing was decided."""


class GhClient:
    def __init__(self, runner: Runner, env: dict, repo: str):
        self.runner, self.env, self.repo = runner, env, repo

    @staticmethod
    def _fail(what: str, r: Result) -> GhError:
        why = transient(r)
        text = r.err.strip() or r.out.strip()
        return GhTransient(f"{what}: {text or why}") if why else GhError(f"{what}: {text}")

    def _api(self, path: str, paginate: bool = False):
        argv = ["gh", "api", path]
        if paginate:
            argv += ["--paginate", "--slurp"]
        r = self.runner.run(argv, env=self.env, timeout=60)
        if not r.ok:
            raise self._fail(f"gh api {path}", r)
        data = json.loads(r.out or "null")
        if paginate:  # --slurp yields a list of pages
            return [item for page in data for item in page]
        return data

    def open_prs(self) -> list[dict]:
        r = self.runner.run(["gh", "pr", "list", "--repo", self.repo, "--state", "open",
                             "--limit", "300", "--json", "number,headRefName,baseRefName,files,title"],
                            env=self.env, timeout=60)
        if not r.ok:
            raise self._fail("gh pr list", r)
        return json.loads(r.out or "[]")

    def prs_for_branch(self, branch: str) -> list[dict]:
        r = self.runner.run(["gh", "pr", "list", "--repo", self.repo, "--head", branch,
                             "--state", "all", "--json", "number,state,headRefOid,mergedAt"],
                            env=self.env, timeout=60)
        if not r.ok:
            raise self._fail("gh pr list --head", r)
        return json.loads(r.out or "[]")

    def create_pr(self, head: str, base: str, title: str, body: str, labels: list[str]) -> None:
        """Open a PR. The caller re-queries by branch afterwards: a lost response must never create a second one."""
        argv = ["gh", "pr", "create", "--repo", self.repo, "--head", head, "--base", base, "--title", title,
                "--body", body]
        for label in labels:
            argv += ["--label", label]
        r = self.runner.run(argv, env=self.env, timeout=120)
        if not r.ok:
            raise self._fail("gh pr create", r)

    def close_pr(self, n: int) -> None:
        """Close without merging; the branch is left alone (deleted separately, after verification)."""
        r = self.runner.run(["gh", "pr", "close", str(n), "--repo", self.repo], env=self.env, timeout=60)
        if not r.ok:
            raise GhError(f"gh pr close {n}: {r.err.strip() or r.out.strip()}")

    def _owned_ref(self, head: dict) -> str:
        """The PR's head branch name, but only for a PR whose head lives in THIS repository.

        A fork can use the same branch name (`gh pr list --head` filters by name only). Every caller proves ownership by
        comparing this value with the batch's branch, so a foreign or unknown (deleted fork) head is returned as
        `owner/repo:branch`, which can never equal an owned branch name: all those checks then fail closed.
        """
        repo = (head.get("repo") or {}).get("full_name") or "?"
        return head["ref"] if repo.lower() == self.repo.lower() else f"{repo}:{head['ref']}"

    def pull(self, n: int) -> dict:
        d = self._api(f"repos/{self.repo}/pulls/{n}")
        return {"number": n, "state": d["state"], "merged": bool(d.get("merged")),
                "head_sha": d["head"]["sha"], "head_ref": self._owned_ref(d["head"]),
                "url": d.get("html_url", ""), "merge_commit_sha": d.get("merge_commit_sha") or "",
                "title": d.get("title") or "", "body": d.get("body") or "",
                "base_ref": (d.get("base") or {}).get("ref")}

    # ---- Issues (Issue #1555: shared-defect urgent Issues) --------------------------------------------------------
    def issue(self, n: int) -> dict:
        d = self._api(f"repos/{self.repo}/issues/{n}")
        return {"number": n, "title": d.get("title") or "", "state": d["state"],
                "labels": [l["name"] for l in d.get("labels", [])],
                "pull_request": "pull_request" in d, "body": d.get("body") or ""}

    def edit_issue_title(self, n: int, title: str) -> None:
        r = self.runner.run(["gh", "issue", "edit", str(n), "--repo", self.repo, "--title", title],
                            env=self.env, timeout=60)
        if not r.ok:
            raise self._fail(f"gh issue edit {n} --title", r)

    def urgent_issues(self) -> list[dict]:
        """Every `urgent` Issue, open and closed, with its body. A list call (not search): it is consistent
        right after an Issue is created, so a just-created Issue is always found again (no duplicate)."""
        r = self.runner.run(["gh", "issue", "list", "--repo", self.repo, "--label", "urgent", "--state", "all",
                             "--limit", "500", "--json", "number,state,title,body"], env=self.env, timeout=60)
        if not r.ok:
            raise GhError(f"gh issue list: {r.err.strip()}")
        return [{**i, "state": str(i["state"]).lower()} for i in json.loads(r.out or "[]")]

    def all_issues(self) -> list[dict]:
        """List all repository Issues (excluding PRs) for exact-payload recovery after a lost create response."""
        rows = self._api(f"repos/{self.repo}/issues?state=all&per_page=100", paginate=True)
        return [{"number": i["number"], "state": str(i["state"]).lower(), "title": i.get("title") or "",
                 "body": i.get("body") or "", "created_at": i.get("created_at"),
                 "labels": [label["name"] for label in i.get("labels", [])],
                 "pull_request": "pull_request" in i}
                for i in rows if "pull_request" not in i]

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

    def merged_relation_stage3_prs(self) -> list[dict]:
        """Merged, explicitly identified Stage 3 PRs used only to recover Stage 3 worker completion."""
        rows = self._api(f"repos/{self.repo}/pulls?state=closed&per_page=100", paginate=True)
        result = []
        title_pattern = re.compile(r"^\[Relation Stage 3\] (\d{3})$")
        issue_pattern = re.compile(r"(?:#2450|issues/2450)(?!\d)")
        for row in rows:
            title = row.get("title") or ""
            match = title_pattern.fullmatch(title)
            if not match or not row.get("merged_at") or not issue_pattern.search(row.get("body") or ""):
                continue
            result.append({
                "number": row["number"], "title": title, "body": row.get("body") or "",
                "base_ref": (row.get("base") or {}).get("ref"), "shard": match.group(1),
                "merge_commit_sha": row.get("merge_commit_sha") or "",
            })
        return result

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
