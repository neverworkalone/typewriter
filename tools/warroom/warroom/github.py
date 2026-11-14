"""GitHub access through the isolated `gh` CLI."""
from __future__ import annotations

import json
import re

from . import prbody
from .shell import Result, Runner, gh_transient


class GhError(Exception):
    pass


class GhTransient(GhError):
    """The gh call failed on the API/network side (any HTTP status incl. 404/401/403/422, timeout, DNS, TLS); nothing was decided."""


class GhClient:
    def __init__(self, runner: Runner, env: dict, repo: str):
        self.runner, self.env, self.repo = runner, env, repo

    @staticmethod
    def _fail(what: str, r: Result) -> GhError:
        why = gh_transient(r)
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

    def latest_stage2_production(self, base: str) -> dict | None:
        """Search contiguous UTC windows, newest first, without trusting Search ordering."""
        from datetime import datetime, timedelta, timezone
        from urllib.parse import urlencode

        def parse(value):
            try:
                dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    raise ValueError("missing timezone")
                return dt.astimezone(timezone.utc)
            except (AttributeError, TypeError, ValueError):
                raise GhTransient("invalid Stage 2 merge time")

        def stamp(dt):
            return dt.strftime("%Y-%m-%dT%H:%M:%SZ")

        now = datetime.now(timezone.utc).replace(microsecond=0)
        pattern = r"(?:\[S2/[A-Za-z0-9-]+\]|\[Stage 2\]) \d{3}_\d{2} Part \d{2}"

        def window(lower, upper):
            bounds = f"{stamp(lower)}..{stamp(upper)}" if upper else f">={stamp(lower)}"
            results = []
            overflow = False
            for phrase in ('"S2"', '"Stage 2"'):
                query = f'repo:{self.repo} is:pr is:merged base:{base} {phrase} Part in:title merged:{bounds}'
                first = None
                page = 1
                while True:
                    params = urlencode({"q": query, "per_page": 100, "page": page})
                    result = self._api(f"search/issues?{params}")
                    if (not isinstance(result, dict) or result.get("incomplete_results") is not False
                            or not isinstance(result.get("items"), list)
                            or type(result.get("total_count")) is not int or result["total_count"] < 0):
                        raise GhTransient("incomplete Stage 2 merged PR search")
                    count = result["total_count"]
                    if first is None:
                        first = count
                    elif count != first:
                        raise GhTransient("changing Stage 2 merged PR search")
                    if count > 1000:
                        overflow = True
                        break
                    items = result["items"]
                    if len(items) != min(100, count - (page - 1) * 100):
                        raise GhTransient("incomplete Stage 2 merged PR search page")
                    results.extend(items)
                    if page * 100 >= count:
                        break
                    page += 1
            if overflow:
                span = (upper or now) - lower
                if span <= timedelta(hours=1):
                    raise GhError("Stage 2 merged PR search exceeds 1000 within one hour")
                middle = lower + timedelta(seconds=int(span.total_seconds() // 2))
                return window(middle, upper) or window(lower, middle)
            rows = {}
            for item in results:
                if not isinstance(item, dict):
                    raise GhTransient("invalid Stage 2 search result")
                if re.fullmatch(pattern, item.get("title") or ""):
                    number = item.get("number")
                    if type(number) is not int:
                        raise GhTransient("Stage 2 search result lacks PR number")
                    merged = parse((item.get("pull_request") or {}).get("merged_at"))
                    if number in rows and rows[number][1] != merged:
                        raise GhTransient("inconsistent Stage 2 merge time")
                    rows[number] = (item, merged)
            if not rows:
                return None
            latest = max(value[1] for value in rows.values())
            winners = [value[0] for value in rows.values() if value[1] == latest]
            if len(winners) != 1:
                raise GhError("latest Stage 2 production merge time is ambiguous")
            return winners[0]

        days = 7
        lower = now - timedelta(days=days)
        row = window(lower, None)
        if row is None:
            repo = self._api(f"repos/{self.repo}")
            created = parse(repo.get("created_at") if isinstance(repo, dict) else None)
            while row is None and lower > created:
                days *= 2
                older = max(created, now - timedelta(days=days))
                row = window(older, lower)
                lower = older
        if row is None:
            return None
        detail = self._api(f"repos/{self.repo}/pulls/{row['number']}")
        if (not detail.get("merged") or not detail.get("merged_at") or detail.get("state") != "closed"
                or (detail.get("base") or {}).get("ref") != base
                or ((detail.get("base") or {}).get("repo") or {}).get("full_name", "").lower() != self.repo.lower()
                or ((detail.get("head") or {}).get("repo") or {}).get("full_name", "").lower() != self.repo.lower()
                or detail.get("title") != row.get("title") or detail.get("merged_at") != row["pull_request"]["merged_at"]
                or not re.fullmatch(r"[a-f0-9]{40}", detail.get("merge_commit_sha") or "")):
            raise GhError("latest Stage 2 PR identity or merge evidence is incomplete")
        match = re.fullmatch(r"(?:\[S2/([A-Za-z0-9-]+)\]|\[Stage 2\]) (\d{3})_(\d{2}) Part (\d{2})", detail["title"])
        branch = (detail.get("head") or {}).get("ref", "")
        branch_match = re.fullmatch(r"s2-([a-z0-9-]+)-(\d{3})-(\d{2})-(\d{2})", branch)
        if (not match or not branch_match or tuple(match.group(i) for i in (2, 3, 4)) != branch_match.groups()[1:]
                or (match.group(1) and match.group(1).lower() != branch_match.group(1))
                or not re.search(r"(?:#927|issues/927)(?!\d)", detail.get("body") or "")):
            raise GhError("latest Stage 2 PR title, branch or issue ownership is ambiguous")
        return detail

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
            raise self._fail(f"gh pr close {n}", r)

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
                "base_ref": (d.get("base") or {}).get("ref"),
                "base_sha": (d.get("base") or {}).get("sha"), "mergeable": d.get("mergeable")}

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

    def reopen_issue(self, n: int) -> None:
        r = self.runner.run(["gh", "issue", "reopen", str(n), "--repo", self.repo], env=self.env, timeout=60)
        if not r.ok:
            raise self._fail(f"gh issue reopen {n}", r)

    def urgent_issues(self) -> list[dict]:
        """Every `urgent` Issue, open and closed, with its body. A list call (not search): it is consistent
        right after an Issue is created, so a just-created Issue is always found again (no duplicate)."""
        r = self.runner.run(["gh", "issue", "list", "--repo", self.repo, "--label", "urgent", "--state", "all",
                             "--limit", "500", "--json", "number,state,title,body"], env=self.env, timeout=60)
        if not r.ok:
            raise self._fail("gh issue list", r)
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
            raise self._fail("gh issue create", r)
        tail = r.out.strip().rsplit("/", 1)[-1]
        if not tail.isdigit():
            raise GhError(f"gh issue create: Issue 번호를 알 수 없습니다: {r.out.strip()[:200]}")
        return int(tail)

    def comment_issue(self, n: int, body: str) -> None:
        r = self.runner.run(["gh", "issue", "comment", str(n), "--repo", self.repo, "--body", body],
                            env=self.env, timeout=60)
        if not r.ok:
            raise self._fail("gh issue comment", r)

    def pull_files(self, n: int) -> list[dict]:
        """All files changed by a PR, including closed and merged PRs."""
        return [{"path": f.get("filename")} for f in
                self._api(f"repos/{self.repo}/pulls/{n}/files", paginate=True)]

    def latest_stage3_production(self, base: str) -> dict | None:
        from . import stage3
        return self.latest_refine_production(base, stage3.SPEC)

    def latest_refine_production(self, base: str, spec) -> dict | None:
        """The latest merged production PR of one refinement Stage (`refine.RefineSpec`). Search all bounded production
        results; GitHub relevance order is not merge order."""
        from urllib.parse import urlencode
        label = spec.label
        rows = {}
        for phrase in spec.search_phrases:
            total = None
            for page in range(1, 11):
                query = urlencode({"q": f'repo:{self.repo} is:pr is:merged base:{base} {phrase} in:title',
                                   "per_page": 100, "page": page})
                result = self._api(f"search/issues?{query}")
                if (not isinstance(result, dict) or result.get("incomplete_results") is not False
                        or not isinstance(result.get("items"), list) or type(result.get("total_count")) is not int):
                    raise GhTransient(f"incomplete {label} merged PR search")
                if total is None:
                    total = result["total_count"]
                if total > 1000:
                    raise GhError(f"{label} merged PR search exceeds 1000 results")
                if result["total_count"] != total:
                    raise GhTransient(f"{label} merged PR search changed its bounded results")
                items = result["items"]
                if len(items) != min(100, total - (page - 1) * 100):
                    raise GhTransient(f"incomplete {label} merged PR search page")
                for row in items:
                    if spec.title.fullmatch(row.get("title") or "") and spec.issue_link.search(row.get("body") or ""):
                        merged = (row.get("pull_request") or {}).get("merged_at")
                        if not isinstance(merged, str) or not merged or type(row.get("number")) is not int:
                            raise GhTransient(f"{label} search result lacks merge evidence")
                        rows[row["number"]] = row
                if page * 100 >= total:
                    break
        if not rows:
            return None
        ordered = sorted(rows.values(), key=lambda row: row["pull_request"]["merged_at"], reverse=True)
        row = ordered[0]
        if len(ordered) > 1 and ordered[1]["pull_request"]["merged_at"] == row["pull_request"]["merged_at"]:
            raise GhError(f"latest {label} production merge time is ambiguous")
        detail = self._api(f"repos/{self.repo}/pulls/{row['number']}")
        match = spec.detail_title.fullmatch(detail.get("title") or "")
        head, target = detail.get("head") or {}, detail.get("base") or {}
        branch = re.fullmatch(rf"{re.escape(spec.id)}-([A-Za-z0-9-]+)-(\d{{3}})", head.get("ref") or "")
        if (not detail.get("merged") or detail.get("state") != "closed"
                or detail.get("merged_at") != row["pull_request"]["merged_at"]
                or detail.get("title") != row.get("title") or target.get("ref") != base
                or (target.get("repo") or {}).get("full_name", "").lower() != self.repo.lower()
                or (head.get("repo") or {}).get("full_name", "").lower() != self.repo.lower()
                or not match or not branch or match.group(2) != branch.group(2)
                or (match.group(1) and match.group(1).lower() != branch.group(1).lower())
                or not 1 <= int(match.group(2)) <= 428
                or not spec.issue_link.search(detail.get("body") or "")
                or not re.fullmatch(r"[a-f0-9]{40}", detail.get("merge_commit_sha") or "")):
            raise GhError(f"latest {label} PR identity or merge evidence is incomplete")
        return detail

    def maintainer_ci_failure(self, pr: int, head: str, branch: str):
        """Return only a terminal failure of this PR's required CI job, with bound API evidence."""
        from urllib.parse import urlencode
        query = urlencode({"event": "pull_request", "branch": branch, "per_page": 100})
        data = self._api(f"repos/{self.repo}/actions/workflows/ci.yml/runs?{query}")
        if not isinstance(data, dict) or not isinstance(data.get("workflow_runs"), list) or data.get("total_count", 101) > 100:
            return None
        runs = data["workflow_runs"]
        if not runs:
            return None
        if any(not isinstance(r, dict) or not isinstance(r.get("id"), int) for r in runs):
            return None
        run = max(runs, key=lambda r: r["id"])
        if run.get("status") != "completed" or run.get("conclusion") != "failure":
            return None
        run_id = run["id"]
        run = self._api(f"repos/{self.repo}/actions/runs/{run_id}")
        if not isinstance(run, dict) or run.get("id") != run_id:
            return None
        prs = run.get("pull_requests")
        if (run.get("event") != "pull_request" or run.get("path") != ".github/workflows/ci.yml"
                or not isinstance(run.get("head_sha"), str) or not re.fullmatch(r"[0-9a-f]{40}", run["head_sha"])
                or run.get("head_branch") != branch
                or not isinstance(prs, list) or len(prs) != 1 or prs[0].get("number") != pr
                or (prs[0].get("head") or {}).get("sha") != head
                or run.get("status") != "completed" or run.get("conclusion") != "failure"
                or not isinstance(run.get("run_attempt"), int) or run["run_attempt"] < 1):
            return None
        attempt, run_id = run["run_attempt"], run["id"]
        data = self._api(f"repos/{self.repo}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100")
        if not isinstance(data, dict) or not isinstance(data.get("jobs"), list) or data.get("total_count", 101) > 100:
            return None
        jobs = [j for j in data["jobs"] if isinstance(j, dict) and j.get("name") == "Validate and test Typewriter"]
        if len(jobs) != 1:
            return None
        job = jobs[0]
        if (job.get("head_sha") != run["head_sha"] or job.get("status") != "completed" or job.get("conclusion") != "failure"
                or not isinstance(job.get("steps"), list) or not isinstance(job.get("id"), int)):
            return None
        steps = [s.get("name") for s in job["steps"] if isinstance(s, dict) and s.get("conclusion") == "failure" and isinstance(s.get("name"), str)]
        if not steps:
            return None
        # Names and links are untrusted data; no log content is executed or interpolated into shell commands.
        body = (f"GitHub Actions PR CI: PR HEAD {head}; execution SHA {run['head_sha']}; run {run_id}, attempt {attempt}; "
                f"job Validate and test Typewriter ({job.get('html_url', '')}); failed steps: " + ", ".join(steps))[:4000]
        return {"kind": "ci", "author": "GitHub Actions", "key": f"ci:{run_id}:{attempt}", "body": body,
                "job_id": job["id"], "run_id": run_id, "attempt": attempt}

    def maintainer_ci_diagnostic(self, event):
        # Fetch only the failed required job, once when it is about to be assigned. Extract bounded test names,
        # not arbitrary log lines, which may contain secrets or prompt instructions.
        r = self.runner.run(["gh", "run", "view", str(event["run_id"]), "--repo", self.repo,
                             "--attempt", str(event["attempt"]), "--job", str(event["job_id"]), "--log-failed"],
                            env=self.env, timeout=60)
        if not r.ok:
            raise self._fail("gh run view failed job", r)
        names = []
        for line in r.out.splitlines():
            match = re.search(r"(?:FAIL|ERROR): ([A-Za-z0-9_.]+)(?: \([A-Za-z0-9_.]+\))?", line)
            if match and match.group(1) not in names:
                names.append(match.group(1))
            if len(names) >= 20:
                break
        return "Failed test identifiers: " + (", ".join(names) if names else "unavailable; inspect the linked failed job")

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
