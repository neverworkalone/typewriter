"""Issue #9472: a D chunk session with no shell tool must continue in a fresh session, not resume the dead one."""
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from warroom import dchunk, dparallel


def _log(*parts) -> str:
    return "\n".join(json.dumps({"type": "tool_use", "part": p}) for p in parts)


NO_SHELL = [
    {"type": "tool", "tool": "execute", "state": {"input": {"code": "const r = await tools.shell({command: 'x'})"}}},
    {"type": "tool", "tool": "execute", "state": {"input": {"code": "return Object.keys(tools);"}}},
]
WITH_SHELL = [{"type": "tool", "tool": "shell", "state": {"input": {"command": "node cli save"}}}]


class SessionLacksShell(unittest.TestCase):
    def _check(self, parts) -> bool:
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "run.log"
            p.write_text(_log(*parts), encoding="utf-8")
            return dparallel.session_lacks_shell(p)

    def test_detection(self):
        self.assertTrue(self._check(NO_SHELL))
        self.assertFalse(self._check(WITH_SHELL))
        self.assertFalse(self._check(NO_SHELL + WITH_SHELL))
        self.assertFalse(self._check([]))
        self.assertFalse(dparallel.session_lacks_shell("/nonexistent/x.log"))


class UnsavedNoShell(unittest.TestCase):
    def _run(self, data, parts):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "run.log"
            log.write_text(_log(*parts), encoding="utf-8")
            logs = []
            store = SimpleNamespace(get=lambda k: None, log=lambda *a: logs.append(a))
            sup = SimpleNamespace(_d_env=lambda b: {}, runner=None, _d_rejection_note=lambda b, n: "", store=store)
            drv = dparallel.ParallelD(sup)
            calls = {}
            drv._wt = lambda b: Path(d)
            drv._set = lambda b, task, data=None, **kw: calls.update(data=dict(data or {}), **kw)
            drv._task_failed = lambda *a: calls.update(failed=a[-1])
            row = {"task": "019", "session_id": "ses_x"}
            names = SimpleNamespace(decisions="dec", rejected="rej")
            with mock.patch.object(dchunk, "read_active", return_value={"view_sha256": "v"}), \
                    mock.patch.object(dchunk, "read_rejection", return_value=None), \
                    mock.patch.object(dchunk, "refresh_stale_search_rejection", return_value=None), \
                    mock.patch.object(dchunk, "chunk_names", return_value=names), \
                    mock.patch.object(dchunk, "has_search_failure", return_value=False):
                drv._unsaved({"id": 1}, row, data, {"kind": dparallel.RESUME, "log_file": str(log)}, None)
            return calls

    def test_first_no_shell_run_gets_one_fresh_session(self):
        c = self._run({}, NO_SHELL)
        self.assertEqual((c["state"], c["session_id"]), ("FIXQ", None))
        self.assertEqual(c["data"]["kind"], "new")
        self.assertTrue(c["data"]["continued"] and c["data"]["fresh_no_shell"])

    def test_fresh_session_without_shell_fails_instead_of_looping(self):
        c = self._run({"fresh_no_shell": True}, NO_SHELL)
        self.assertIn("저장되지 않았습니다", c["failed"])

    def test_shell_session_keeps_the_same_session_resume(self):
        c = self._run({}, WITH_SHELL)
        self.assertEqual(c["data"]["kind"], "resume")
        self.assertNotIn("session_id", c)


class RetryAfterNoShell(unittest.TestCase):
    def test_operator_retry_starts_a_fresh_session_and_keeps_chunk_and_budget(self):
        with tempfile.TemporaryDirectory() as d:
            sets, budget = [], {}
            row = {"task": "019", "state": "FAILED", "session_id": "ses_noshell", "run_id": 5, "attempts": 2,
                   "data": json.dumps({"ack": True, "error": "x", "fresh_no_shell": True, "continued": True})}
            rows = [row]

            def _set(b, task, data=None, **kw):
                sets.append((dict(data or {}), kw))
                if "session_id" in kw:
                    row["session_id"] = kw["session_id"]
                if "state" in kw:
                    row["state"] = kw["state"]
            store = SimpleNamespace(task_rows=lambda i: rows, task_row=lambda i, t: row,
                                    get=lambda k: budget.get(k), set=lambda k, v: budget.__setitem__(k, v))
            sup = SimpleNamespace(store=store, runner=None, _d_env=lambda b: {})
            drv = dparallel.ParallelD(sup)
            drv._data = lambda r: json.loads(r["data"])
            drv._wt = lambda b: Path(d)
            drv._set = _set
            key = dchunk.fix_key(1, 19)
            budget[key] = "1"
            with mock.patch.object(dchunk, "read_active", return_value={"view_sha256": "v"}), \
                    mock.patch.object(dchunk, "read_rejection", return_value=None), \
                    mock.patch.object(dchunk, "refresh_stale_search_rejection", return_value=None):
                drv._reset_acknowledged_failures({"id": 1}, SimpleNamespace(force=False))
            data, kw = sets[-1]
            self.assertEqual(data["kind"], "new")                 # never "resume" of the shell-less session
            self.assertTrue(data["continued"])
            self.assertNotIn("fresh_no_shell", data)
            self.assertIsNone(row["session_id"])
            self.assertEqual(row["state"], "FIXQ")                # prepared chunk kept, not restarted from scratch
            self.assertEqual(budget[key], "0")                    # exactly one more correction chance


if __name__ == "__main__":
    unittest.main()
