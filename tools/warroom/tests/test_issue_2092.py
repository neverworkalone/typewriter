"""#2092: a retryable query failure (timeout, 5xx, 429, network) is not a verdict.

Invariant: it never changes the Line (run/mode/drain) or the batch (state/run_kind/baseline/output), never starts an AI,
and only that query/judgement is retried with backoff; "query succeeded and the answer is bad" stays fail-closed, and a
PR-create request whose outcome is unknown is never repeated."""
import os
import tempfile
import unittest
from pathlib import Path

from tests.test_reload import stage2_world
from warroom.adapters import classify_failure
from warroom.github import GhClient, GhError, GhTransient
from warroom.gitops import Git, GitError, GitTransient
from warroom.shell import Result, Runner, gh_transient, transient

ENV = {**os.environ, "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_SYSTEM": "/dev/null"}


def flaky(obj, name, errors):
    """Make `obj.name` raise the queued errors one call at a time, then behave normally."""
    real, queue = getattr(obj, name), list(errors)

    def call(*a, **k):
        if queue:
            raise queue.pop(0)
        return real(*a, **k)
    setattr(obj, name, call)
    return queue


class Classifier(unittest.TestCase):
    def test_table(self):
        cases = [
            (Result(124, "", "timeout: gh"), True), (Result(1, "", "HTTP 500: Server Error"), True),
            (Result(1, "", "gh: HTTP 502 Bad Gateway"), True), (Result(1, "", "HTTP 503"), True),
            (Result(1, "", "HTTP 429: rate limit"), True),
            (Result(1, "", "HTTP 403: You have exceeded a secondary rate limit"), True),
            (Result(128, "", "fatal: unable to access 'https://x/': Could not resolve host: github.com"), True),
            (Result(128, "", "fatal: the remote end hung up unexpectedly"), True),
            (Result(1, "", "error connecting to api.github.com: connection reset by peer"), True),
            (Result(1, "", "HTTP 401: Bad credentials"), False), (Result(1, "", "HTTP 403: Resource not accessible"), False),
            (Result(1, "", "HTTP 404: Not Found"), False), (Result(1, "", "HTTP 422: Validation Failed"), False),
            (Result(128, "", "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 404"), False),
            (Result(128, "", "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 403"), False),
            (Result(128, "", "remote: Repository not found.\nfatal: unable to access 'https://github.com/o/r/': error: 401"), False),
            (Result(128, "", "fatal: unable to access 'https://github.com/o/r/': The requested URL returned error: 503"), True),
            (Result(128, "", "error: RPC failed; HTTP 502 curl 22 The requested URL returned error: 502"), True),
            (Result(128, "", "fatal: unable to access 'https://github.com/o/r/': Failed to connect to github.com port 443"), True),
            (Result(1, "", "To https://github.com/o/r\n ! [remote rejected] HEAD -> b (failed)\nerror: failed to push some refs"), True),
            (Result(1, "", " ! [remote rejected] HEAD -> b (internal error)"), True),
            (Result(1, "", "remote: Internal Server Error\nremote: Request ID X\nTo https://github.com/o/r\n ! [remote rejected] HEAD -> b (Internal Server Error)\nerror: failed to push some refs"), True),
            (Result(1, "", " ! [remote rejected] HEAD -> b (protected branch hook declined)"), False),
            (Result(1, "", "error: cannot lock ref 'refs/remotes/origin/master': is at 1ac573c but expected d02755d\n"
                           " ! d02755d..1ac573c master -> origin/master  (unable to update local ref)"), True),
            (Result(128, "", "fatal: Unable to create '/r/.git/refs/remotes/origin/master.lock': File exists."), True),
            (Result(128, "", "fatal: Unable to create '/r/.git/FETCH_HEAD': Permission denied."), False),
            (Result(128, "", "fatal: Unable to create '/r/.git/refs/remotes/origin/master.lock': Permission denied."), False),
            (Result(1, "", "error: cannot lock ref 'refs/remotes/origin/a/b': 'refs/remotes/origin/a' exists"), False),
            (Result(128, "", "fatal: not a git repository"), False), (Result(1, "", ""), False), (Result(0, "ok", ""), False),
        ]
        for res, want in cases:
            with self.subTest(res.err or res.code):
                self.assertEqual(transient(res) is not None, want)

    def test_gh_table_retries_every_api_or_network_failure_but_not_local_ones(self):
        """#2810: any gh API response failure (404 included) retries; a missing binary / usage error is a local bug."""
        cases = [(Result(1, "", "gh: Not Found (HTTP 404)"), True), (Result(1, "", "gh: Bad credentials (HTTP 401)"), True),
                 (Result(1, "", "gh: Resource not accessible (HTTP 403)"), True),
                 (Result(1, "", "gh: Validation Failed (HTTP 422)"), True), (Result(1, "", "HTTP 429"), True),
                 (Result(1, "", "HTTP 502"), True), (Result(124, "", "timeout: gh"), True),
                 (Result(1, "", "GraphQL: Could not resolve to a Repository (repository)"), True),
                 (Result(1, "", "error connecting to api.github.com"), True),
                 (Result(1, "", "dial tcp: lookup api.github.com: i/o timeout"), True),
                 (Result(1, "", "tls handshake timeout"), True),
                 (Result(127, "", "[Errno 2] No such file or directory: 'gh'"), False),
                 (Result(1, "", "unknown flag: --bogus"), False), (Result(1, "", "accepts 1 arg(s), received 0"), False),
                 (Result(1, "", ""), False), (Result(0, "ok", ""), False)]
        for res, want in cases:
            with self.subTest(res.err or res.code):
                self.assertEqual(gh_transient(res) is not None, want)

    def test_gh_client_failures_are_transient_unless_local(self):
        for err, code, exc in [("gh: Not Found (HTTP 404)", 1, GhTransient), ("unknown flag: --x", 1, GhError)]:
            for call in (lambda c: c.pull(1), lambda c: c.prs_for_branch("b"), lambda c: c.close_pr(1),
                         lambda c: c.urgent_issues(), lambda c: c.create_issue("t", "b", []),
                         lambda c: c.comment_issue(1, "x"), lambda c: c.create_pr("h", "m", "t", "b", [])):
                with self.subTest(err):
                    class R(Runner):
                        def run(self, argv, cwd=None, env=None, input=None, timeout=120):
                            return Result(code, "", err)
                    with self.assertRaises(exc) as cm:
                        call(GhClient(R(), {}, "o/r"))
                    self.assertIs(type(cm.exception), exc)


class ScriptRunner(Runner):
    def __init__(self, ls_remote):
        self.ls_remote = ls_remote

    def run(self, argv, cwd=None, env=None, input=None, timeout=120):
        sub = argv[1]
        if sub == "rev-parse":
            return Result(1)                        # no local branch
        if sub == "ls-remote":
            return self.ls_remote
        return Result(0)


class CreateWorktreeLsRemote(unittest.TestCase):
    """ls-remote --exit-code: 0 = branch exists, 2 = absent, anything else is NOT evidence of absence."""

    def test_table(self):
        cases = [(Result(0, "sha\trefs/heads/x"), GitError, "already exists"), (Result(2), None, ""),
                 (Result(124, "", "timeout: git"), GitTransient, ""),
                 (Result(128, "", "fatal: unable to access: Could not resolve host: github.com"), GitTransient, ""),
                 (Result(128, "", "fatal: repository not found"), GitError, "")]
        for res, exc, text in cases:
            with self.subTest(f"{res.code} {res.err}"):
                with tempfile.TemporaryDirectory() as tmp:
                    git = Git(ScriptRunner(res), Path(tmp), ENV, Path(tmp) / "w")
                    git.ignore_scratch = lambda: None
                    if exc is None:
                        git.create_worktree(Path(tmp) / "w" / "x", "x", "master")
                    else:
                        with self.assertRaises(exc) as cm:
                            git.create_worktree(Path(tmp) / "w" / "x", "x", "master")
                        self.assertIs(type(cm.exception), exc)
                        self.assertIn(text, str(cm.exception))


def codex_world():
    """A World with one Codex model whose only shard has its preserved Stage 2 inputs."""
    w = stage2_world()
    w.cfg["producers"] = {"codex": {"adapter": "codex", "model": "gpt-x", "effort": "high"}}
    return w


class Prepare(unittest.TestCase):
    def setUp(self):
        self.w = codex_world()
        self.addCleanup(self.w.tmp.cleanup)

    def line(self):
        return self.w.store.line("codex", "s2")

    def test_lookup_failures_keep_the_line_untouched_then_proceed(self):
        sources = {"open_prs": (lambda w: w.gh), "fetch_base": (lambda w: w.git)}
        for name, owner in sources.items():
            with self.subTest(name):
                w = codex_world()
                self.addCleanup(w.tmp.cleanup)
                w.start("continuous")
                before = dict(w.line_row()) if hasattr(w, "line_row") else None
                flaky(owner(w), name, [GhTransient("HTTP 502"), GitTransient("timeout")])
                w.tick()
                ln = w.store.line("codex", "s2")
                self.assertEqual((ln["run"], ln["mode"], ln["drain"], ln["blocked"]), (1, "continuous", 0, ""))
                self.assertIsNone(w.store.active_batch("codex", "s2"))
                w.tick()                                  # still backing off: no second attempt yet
                self.assertIsNone(w.store.active_batch("codex", "s2"))
                w.now += 10
                w.tick()
                w.now += 20
                w.tick()
                self.assertEqual(w.row()["state"], "PRODUCING")
                self.assertEqual(len(w.adapter.launches), 1)

    def test_auth_transient_is_not_a_missing_login_but_a_definite_401_is(self):
        w = self.w
        real = w.runner.run
        state = {"fail": 2}

        def run(argv, **k):
            if argv[:3] == ["gh", "api", "user"] and state["fail"]:
                state["fail"] -= 1
                return Result(1, "", "HTTP 502: Bad Gateway")
            return real(argv, **k)
        w.runner.run = run
        w.start("single")
        w.tick()
        self.assertEqual((self.line()["blocked"], self.line()["run"]), ("", 1))
        w.now += 10
        w.tick(2)
        w.now += 30
        w.tick()
        self.assertEqual(w.row()["state"], "PRODUCING")
        w = codex_world()
        self.addCleanup(w.tmp.cleanup)
        w.runner.api_ok = False
        w.start("single")
        w.tick()
        self.assertIn("인증 없음", w.store.line("codex", "s2")["blocked"])

    def test_auth_api_answers_of_any_status_wait_instead_of_blocking(self):
        """#2810: user 401 and permission lookup 403 retry; the Line is never BLOCKED."""
        for target, err in [("user", "gh: Bad credentials (HTTP 401)"),
                            ("repos", "gh: Resource not accessible (HTTP 403)")]:
            with self.subTest(target, err=err):
                w = codex_world()
                self.addCleanup(w.tmp.cleanup)
                real, state = w.runner.run, {"fail": 2}

                def run(argv, real=real, state=state, target=target, err=err, **k):
                    if argv[:2] == ["gh", "api"] and argv[2].startswith(target) and state["fail"]:
                        state["fail"] -= 1
                        return Result(1, "", err)
                    return real(argv, **k)
                w.runner.run = run
                w.start("single")
                w.tick()
                self.assertEqual((w.store.line("codex", "s2")["blocked"], w.store.line("codex", "s2")["run"]), ("", 1))
                for _ in range(3):
                    w.now += 40
                    w.tick(2)
                self.assertEqual(w.row()["state"], "PRODUCING")

    def test_worktree_lookup_failure_stays_prepare_and_launches_once(self):
        w = self.w
        w.start("single")
        flaky(w.git, "create_worktree", [GitTransient("ls-remote timeout")])
        w.tick()
        b = w.row()
        self.assertEqual((b["state"], b["error"]), ("PREPARE", None))
        self.assertEqual(len(w.adapter.launches), 0)
        w.sup = w.make_sup()                              # a Supervisor restart loses nothing
        w.now += 10
        w.tick(2)
        self.assertEqual((w.row()["state"], len(w.adapter.launches)), ("PRODUCING", 1))
        self.assertEqual(w.store.get(f"pending_{b['id']}"), None)
        self.assertEqual(w.store.kv_prefix(f"tw_b{b['id']}:"), [])


def stage1ab_dir(w):
    from warroom import stage1ab
    return stage1ab.names(w.row_()).directory


class KvIsolation(unittest.TestCase):
    def test_clear_removes_exactly_its_own_retry_keys(self):
        w = codex_world()
        self.addCleanup(w.tmp.cleanup)
        w.start("single")
        w.tick()
        b = w.row()
        bid = b["id"]
        other = bid + 9                                   # b1 must never touch b10-style keys
        for key in (f"pending_{bid}", f"pr_create_{bid}", f"tw_b{bid}:exit0", f"tw_b{bid}:cleanup",
                    f"pending_{other}", f"pr_create_{other}", f"tw_b{other}:exit0", f"tw_b{bid}0:exit0"):
            w.store.set(key, "x")
        w.store.finish_clear(b, "audit")
        for key in (f"pending_{bid}", f"pr_create_{bid}", f"tw_b{bid}:exit0", f"tw_b{bid}:cleanup"):
            self.assertIsNone(w.store.get(key), key)
        for key in (f"pending_{other}", f"pr_create_{other}", f"tw_b{other}:exit0", f"tw_b{bid}0:exit0"):
            self.assertEqual(w.store.get(key), "x", key)

    def test_unconfirmed_pr_marker_survives_retry_and_error(self):
        w = codex_world()
        self.addCleanup(w.tmp.cleanup)
        w.start("single")
        w.tick()
        b = w.row()
        w.store.set(f"pr_create_{b['id']}", "{}")
        w.sup._fail(b, "ERROR", "x")
        self.assertEqual(w.store.get(f"pr_create_{b['id']}"), "{}")


if __name__ == "__main__":
    unittest.main()
