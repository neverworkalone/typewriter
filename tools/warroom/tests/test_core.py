import unittest

from tests.fake_runner import ScriptedRunner
from warroom import auth, batches, reviews
from warroom.adapters import classify_failure
from warroom.config import Paths

H = "c" * 40
OLD = "d" * 40
ME = "neverworkalone-agent"


def rv(i, body, commit=H, user="genonfire", ts="2026-10-21T10:00:00Z"):
    return {"id": i, "user": {"login": user}, "body": body, "commit_id": commit, "submitted_at": ts}


def ic(i, commit=H, user="genonfire", body="nit", path="a.py"):
    return {"id": i, "user": {"login": user}, "body": body, "commit_id": commit,
            "path": path, "line": 3, "created_at": "2026-10-21T10:00:00Z"}


def ev(**kw):
    base = dict(head_sha=H, head_pushed_at=0.0, self_login=ME, reviews=[], inline=[], issue=[])
    base.update(kw)
    return reviews.fix_events(**base)


class ReviewEventTable(unittest.TestCase):
    def test_table(self):
        cases = [  # name, kwargs, expected keys
            ("-1 on current head", dict(reviews=[rv(1, f"-1\nHEAD: {H}\nbad")]), ["review:1"]),
            ("-1 marker for old head ignored", dict(reviews=[rv(1, f"-1\nHEAD: {OLD}\nbad", commit=H)]), []),
            ("-1 without marker, commit_id old", dict(reviews=[rv(1, "-1\nbad", commit=OLD)]), []),
            ("-1 without marker, commit_id head", dict(reviews=[rv(1, "-1\nbad")]), ["review:1"]),
            ("+1 / +2 never trigger", dict(reviews=[rv(1, f"+1\nHEAD: {H}"), rv(2, f"+2\nHEAD: {H}")]), []),
            ("own -1 ignored", dict(reviews=[rv(1, "-1\nx", user=ME)]), []),
            ("inline alone never triggers", dict(inline=[ic(5)]), []),
            ("inline on head rides with -1",
             dict(reviews=[rv(1, "-1\nx")], inline=[ic(5), ic(6, commit=OLD)]), ["review:1", "inline:5"]),
            ("inline of +1 review w/o -1", dict(reviews=[rv(1, "+1\nnits")], inline=[ic(5)]), []),
            ("issue -1 with matching marker", dict(issue=[{"id": 9, "user": {"login": "genonfire"},
                "body": f"-1\nHEAD: {H}", "created_at": "2026-10-21T10:00:00Z"}]), ["issue:9"]),
            ("issue -1 older than head push", dict(head_pushed_at=9e12, issue=[{"id": 9,
                "user": {"login": "genonfire"}, "body": "-1 old", "created_at": "2026-10-21T10:00:00Z"}]), []),
            ("issue plain comment ignored", dict(issue=[{"id": 9, "user": {"login": "genonfire"},
                "body": "hello", "created_at": "2026-10-21T10:00:00Z"}]), []),
        ]
        for name, kw, want in cases:
            with self.subTest(name):
                self.assertEqual([e["key"] for e in ev(**kw)], want)


class EffectiveVerdict(unittest.TestCase):
    def test_table(self):
        def r(i, v, ts, **kw):
            x = rv(i, f"{v}\nHEAD: {H}", ts=f"2026-10-21T10:{ts}:00Z")
            x.update(kw)
            return x
        cases = [
            ("-1 then +1 same HEAD: retracted", [r(1, "-1", "00"), r(2, "+1", "05")], []),
            ("-1 then +2: retracted", [r(1, "-1", "00"), r(2, "+2", "05")], []),
            ("+1 then -1: blocks", [r(1, "+1", "00"), r(2, "-1", "05")], ["review:2"]),
            ("-1 +1 -1: only last", [r(1, "-1", "00"), r(2, "+1", "05"), r(3, "-1", "09")], ["review:3"]),
            ("two open -1", [r(1, "-1", "00"), r(2, "-1", "05")], ["review:1", "review:2"]),
            ("dismissed -1", [r(1, "-1", "00", state="DISMISSED")], []),
            ("input order irrelevant", [r(2, "+1", "05"), r(1, "-1", "00")], []),
        ]
        for name, revs, want in cases:
            with self.subTest(name):
                self.assertEqual([e["key"] for e in ev(reviews=revs)], want)

    def test_inline_follows_its_review(self):
        m = rv(1, f"-1\nHEAD: {H}", ts="2026-10-21T10:00:00Z")
        p = rv(2, f"+1\nHEAD: {H}", ts="2026-10-21T10:05:00Z")
        old = {**ic(5), "pull_request_review_id": 1}
        other = {**ic(6), "pull_request_review_id": 2}
        self.assertEqual([e["key"] for e in ev(reviews=[m], inline=[old, other])], ["review:1", "inline:5"])
        self.assertEqual(ev(reviews=[m, p], inline=[old, other]), [])


class Failures(unittest.TestCase):
    def test_classification_table(self):
        pats = ["FreeUsageLimit"]
        for text, want in [
            ("Error: FreeUsageLimitError: daily free limit", "free_quota"),
            ("HTTP 429 Too Many Requests", "rate_limit"),
            ("429 rate limit; FreeUsageLimit reached", "free_quota"),
            ("401 Unauthorized", "auth"),
            ("ECONNRESET", "network"),
            ("something odd from provider", "unknown"),
            ("", "unknown"),
        ]:
            with self.subTest(text):
                self.assertEqual(classify_failure(text, pats), want)


class AuthIsolation(unittest.TestCase):
    def test_env(self):
        base = {"PATH": "/bin", "GH_TOKEN": "t", "GITHUB_TOKEN": "t2", "GIT_CONFIG_COUNT": "1",
                "GIT_CONFIG_KEY_0": "user.name", "GIT_CONFIG_VALUE_0": "me", "GIT_SSH_COMMAND": "ssh -i k"}
        env = auth.build_env(base, Paths().gh_config)
        for k in ("GH_TOKEN", "GITHUB_TOKEN", "GIT_SSH_COMMAND"):
            self.assertNotIn(k, env)
        self.assertEqual(env["GH_CONFIG_DIR"], str(Paths().gh_config))
        keys = [env[f"GIT_CONFIG_KEY_{i}"] for i in range(int(env["GIT_CONFIG_COUNT"]))]
        self.assertNotIn("user.name", keys)
        self.assertIn("credential.helper", keys)

    def test_diagnose_table(self):
        for name, mut, ok in [("ok", lambda r: None, True),
                              ("wrong account", lambda r: setattr(r, "account", "genonfire"), False),
                              ("no login", lambda r: setattr(r, "api_ok", False), False),
                              ("no push perm", lambda r: setattr(r, "push", "false"), False),
                              ("no git credential", lambda r: setattr(r, "cred_ok", False), False)]:
            with self.subTest(name):
                r = ScriptedRunner()
                mut(r)
                d = auth.diagnose(r, {"GH_CONFIG_DIR": "x"}, "o/r", ME)
                self.assertEqual(d["ok"], ok)
                self.assertNotIn("SECRET", repr(d))
                # never switches accounts or writes global config
                self.assertFalse(any(c[:3] == ["gh", "auth", "switch"] or c[:3] == ["git", "config", "--global"]
                                     for c in r.calls))


class BatchSelection(unittest.TestCase):
    def pick(self, canon, done, prs=(), owned=()):
        r = ScriptedRunner()
        r.set_batches(canon, done)
        return batches.next_batch(r, ".", {}, ref="origin/master", method="a", producer="deepseek",
                                  open_prs=list(prs), owned=set(owned))

    def path(self, s, b):
        return f"data/relation-candidates/{s:03d}/{s:03d}_{b:02d}_a_deepseek.jsonl"

    def test_table(self):
        canon = {1: 1000, 2: 600}
        d1 = {self.path(1, 1): 500}
        pr = {"files": [{"path": self.path(1, 2)}]}
        other_model = {"files": [{"path": "data/relation-candidates/001/001_02_a_codex.jsonl"}]}
        for name, done, prs, owned, want in [
            ("first", {}, [], [], ("001", "01")),
            ("skips done", d1, [], [], ("001", "02")),
            ("open PR same model occupies", d1, [pr], [], ("002", "01")),
            ("other model PR does not", d1, [other_model], [], ("001", "02")),
            ("owned by War Room", d1, [], [("001", "02")], ("002", "01")),
            ("short last batch", {**d1, self.path(1, 2): 500, self.path(2, 1): 500}, [], [], ("002", "02")),
        ]:
            with self.subTest(name):
                b = self.pick(canon, done, prs, owned)
                self.assertEqual((b.shard, b.batch), want)
        self.assertEqual(self.pick(canon, {**d1, self.path(1, 2): 500, self.path(2, 1): 500}).records, 100)

    def test_corrupt_master_file_is_error_not_skipped(self):
        with self.assertRaises(batches.BatchError):
            self.pick({1: 1000}, {self.path(1, 1): 499})

    def test_exhausted(self):
        self.assertIsNone(batches.next_batch(
            _AllDone(), ".", {}, ref="r", method="a", producer="deepseek", open_prs=[], owned=set()))


class _AllDone(ScriptedRunner):
    def __init__(self):
        super().__init__()
        self.canon = {i: 1000 for i in range(1, 429)}
        self.canon[428] = 583
        self.done = {f"data/relation-candidates/{s:03d}/{s:03d}_{b:02d}_a_deepseek.jsonl":
                     (500 if not (s == 428 and b == 2) else 83) for s in range(1, 429) for b in (1, 2)}


if __name__ == "__main__":
    unittest.main()
