"""GitHub identity isolation.

War Room children (gh, git, OpenCode) get an environment that is scoped to the
producer account via env vars only. `gh auth switch`, `git config --global` and
the user's own GH_TOKEN/GITHUB_TOKEN are never touched or inherited.
"""
from __future__ import annotations

from pathlib import Path

from .shell import Runner

SCRUBBED = ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
            "GH_HOST", "GH_REPO", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH_COMMAND", "GIT_SSH")


class AuthError(Exception):
    pass


def build_env(base: dict, gh_config: Path, git_name: str = "", git_email: str = "") -> dict:
    env = {k: v for k, v in base.items()
           if k not in SCRUBBED and not k.startswith("GIT_CONFIG")}
    env["GH_CONFIG_DIR"] = str(gh_config)
    env["GIT_TERMINAL_PROMPT"] = "0"
    # Env-scoped git config (never written to any config file): HTTPS only, credentials
    # come from the War Room gh config, SSH remotes are rewritten to HTTPS.
    entries = [
        ("credential.helper", ""),
        ("credential.helper", "!gh auth git-credential"),
        ("url.https://github.com/.insteadOf", "git@github.com:"),
        ("url.https://github.com/.insteadOf", "ssh://git@github.com/"),
    ]
    env["GIT_CONFIG_COUNT"] = str(len(entries))
    for i, (k, v) in enumerate(entries):
        env[f"GIT_CONFIG_KEY_{i}"] = k
        env[f"GIT_CONFIG_VALUE_{i}"] = v
    if git_name:
        env["GIT_AUTHOR_NAME"] = env["GIT_COMMITTER_NAME"] = git_name
    if git_email:
        env["GIT_AUTHOR_EMAIL"] = env["GIT_COMMITTER_EMAIL"] = git_email
    return env


def diagnose(runner: Runner, env: dict, repo: str, expected: str) -> dict:
    """Return {ok, account, problems[]}; never raises, never returns a credential."""
    problems: list[str] = []
    account = None
    who = runner.run(["gh", "api", "user", "--jq", ".login"], env=env, timeout=30)
    if not who.ok:
        problems.append(
            "GitHub 인증 없음: `GH_CONFIG_DIR=%s gh auth login` 으로 %s 계정을 로그인하세요."
            % (env["GH_CONFIG_DIR"], expected))
    else:
        account = who.out.strip()
        if account != expected:
            problems.append(f"계정 불일치: 실제 {account!r}, 기대 {expected!r}")
        perm = runner.run(["gh", "api", f"repos/{repo}", "--jq", ".permissions.push"],
                          env=env, timeout=30)
        if perm.out.strip() != "true":
            problems.append(f"{account} 계정에 {repo} push 권한이 없습니다")
        cred = runner.run(["gh", "auth", "git-credential", "get"], env=env, timeout=30,
                          input="protocol=https\nhost=github.com\n\n")
        user_line = next((l for l in cred.out.splitlines() if l.startswith("username=")), "")
        if not cred.ok or "password=" not in cred.out or not user_line:
            problems.append("git push 자격증명(gh auth git-credential)을 사용할 수 없습니다")
    return {"ok": not problems, "account": account, "problems": problems}
