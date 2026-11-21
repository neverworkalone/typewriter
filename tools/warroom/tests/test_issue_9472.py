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


if __name__ == "__main__":
    unittest.main()
