"""복구 점검반 상태를 JSON 한 줄로 출력한다 (앱 패널용, 읽기 전용).

{"inspector": {"running", "last_at", "last_result", "last_exit"},
 "cases": [{"key", "status", "session": {"state", "id", "last_report", "last_exit"}}]}
"""
import json
import os
import subprocess
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DESK = os.path.join(ROOT, ".git", "typewriter-supervisor", "recovery-desk")


def tmux_alive(name):
    return subprocess.run(["tmux", "has-session", "-t", "=" + name],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


def tail_log(path, size=400_000):
    """Last result text and exit code of a stream-json log, plus the time of its last write."""
    if not os.path.exists(path):
        return None, None, None
    with open(path, "rb") as f:
        f.seek(max(0, os.path.getsize(path) - size))
        lines = f.read().decode("utf-8", "replace").splitlines()
    result = code = None
    for line in reversed(lines):
        if code is None and line.startswith("exit="):
            code = line[5:].strip()
        if result is None and '"type":"result"' in line:
            try:
                result = json.loads(line).get("result")
            except ValueError:
                pass
        if result is not None and code is not None:
            break
    return result, code, os.path.getmtime(path)


def slug(key):
    return "".join(c if c.isalnum() or c in "_-" else "-" for c in key)


def main():
    res, code, at = tail_log(os.path.join(DESK, "inspector.log"))
    out = {"now": time.time(), "paused": os.path.exists(os.path.join(DESK, "paused")),
           "inspector": {"running": tmux_alive("recovery-inspector"), "last_at": at,
                         "last_result": res, "last_exit": code},
           "cases": []}
    try:
        with open(os.path.join(DESK, "ledger.json"), encoding="utf-8") as f:
            cases = json.load(f).get("cases", [])
    except (OSError, ValueError):
        cases = []
    for case in cases:
        key = str(case.get("key", "?"))
        s = slug(key)
        idf = os.path.join(DESK, "sessions", s + ".id")
        sess = {"state": "none"}
        if os.path.exists(idf):
            r, c, t = tail_log(os.path.join(DESK, "sessions", s + ".log"))
            sess = {"state": "running" if tmux_alive("recovery-" + s) else "idle",
                    "id": open(idf).read().strip(), "last_report": r, "last_exit": c, "last_at": t}
        out["cases"].append({"key": key, "status": case.get("status", "?"),
                             "notes": case.get("notes", ""), "session": sess})
    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
