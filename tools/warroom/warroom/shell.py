"""Command runner seam: production uses subprocess, tests inject a fake."""
from __future__ import annotations

import os
import re
import selectors
import signal
import subprocess
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from . import lanes


@dataclass
class Result:
    code: int
    out: str = ""
    err: str = ""

    @property
    def ok(self) -> bool:
        return self.code == 0


class Runner:
    def run(self, argv: list[str], cwd: Path | str | None = None,
            env: dict | None = None, input: str | None = None,
            timeout: float | None = 120) -> Result:
        try:
            p = subprocess.run(argv, cwd=cwd, env=env, input=input, text=True,
                               capture_output=True, timeout=timeout)
        except FileNotFoundError as e:
            return Result(127, "", str(e))
        except subprocess.TimeoutExpired:
            return Result(124, "", f"timeout: {argv[0]}")
        return Result(p.returncode, p.stdout, p.stderr)


STARTUP_CAP = 15.0      # finite startup (spawn -> identity confirmed) ceiling, even for timeout=None
DRAIN_CAP = 1.0         # how long output is still collected after the leader exited / the group was killed
FENCED_BINARIES = ("git", "node")
FENCE_CONFIG = (("gc.auto", "0"), ("maintenance.auto", "false"))

# Runs inside the child BEFORE the real command: record own pid/pgid/lstart, signal readiness on the second pipe,
# then wait for the parent's nonce on the approval pipe. EOF or a wrong nonce -> exit WITHOUT running the command.
_WRAPPER = r'''A=$1; R=$2; N=$3; D=$4; shift 4
{ printf '%s %s ' "$$" "$$"; LC_ALL=C /bin/ps -o lstart= -p "$$"; } > "$D.tmp" 2>/dev/null && mv -f "$D.tmp" "$D" || exit 96
eval "printf r >&$R" || exit 95
eval "IFS= read -r g <&$A" || exit 98
[ "$g" = "$N" ] || exit 97
eval "exec $A<&- $R>&-"
exec "$@"
'''


def fenced_env(env: dict | None) -> dict:
    """The child's environment with auto gc/maintenance off, summed into any existing GIT_CONFIG_COUNT entries."""
    out = dict(os.environ if env is None else env)
    try:
        count = max(0, int(out.get("GIT_CONFIG_COUNT", "0") or 0))
    except ValueError:
        count = 0
    for key, value in FENCE_CONFIG:
        out[f"GIT_CONFIG_KEY_{count}"], out[f"GIT_CONFIG_VALUE_{count}"] = key, value
        count += 1
    out["GIT_CONFIG_COUNT"] = str(count)
    return out


class FencedRunner:
    """`Runner` for git/node when several Workers run: journalled intent -> approved marker -> nonce -> exec.

    Same `run(argv, cwd, env, input, timeout) -> Result` contract; every other command (gh ...) goes to `inner`.
    The total `timeout` is ONE deadline covering startup, execution and output collection.
    """

    def __init__(self, inner, fence, worktrees_dir=None, *, hook=None, startup_cap: float = STARTUP_CAP):
        self.inner, self.fence = inner, fence
        self.worktrees = Path(worktrees_dir).resolve() if worktrees_dir else None
        self._hook, self._startup_cap = hook, startup_cap

    def _at(self, point: str) -> None:
        if self._hook is not None:
            self._hook(point)

    def resources(self, cwd) -> set[str]:
        """Locks the calling thread holds (L3 verify, L4 repo: ALL of them) plus the owned worktree it works in. With no
        lock and no owned worktree, independence from shared state is unprovable -> the repository.

        A command inside an owned worktree that holds no repo lock binds only that worktree (#5162): in normal operation
        such commands of different batches already run side by side, so a child of an ended Supervisor that cannot be
        judged holds back its own batch, not every Line."""
        found = set(lanes.held_names()) & {"repo", "verify"}
        owned = None
        if self.worktrees is not None and cwd:
            try:
                path = Path(cwd).resolve()
                if path == self.worktrees or self.worktrees in path.parents:
                    owned = path.relative_to(self.worktrees).parts[0]
            except (OSError, ValueError, IndexError):
                owned = None
        if owned:
            found.add(f"worktree:{owned}")
        return found or {"repo"}

    def run(self, argv, cwd=None, env=None, input=None, timeout=120) -> Result:
        if not argv or os.path.basename(str(argv[0])) not in FENCED_BINARIES:
            return self.inner.run(argv, cwd=cwd, env=env, input=input, timeout=timeout)
        resources = self.resources(cwd)
        self.fence.check(resources)
        t0 = time.monotonic()
        deadline = None if timeout is None else t0 + timeout
        startup_end = t0 + self._startup_cap if deadline is None else min(deadline, t0 + self._startup_cap)
        entry = self.fence.begin(argv, cwd, resources)
        self._at("intent")
        nonce = uuid.uuid4().hex
        a_r, a_w = os.pipe()   # approval: parent writes, child reads
        r_r, r_w = os.pipe()   # ready: child writes, parent reads (non-inheritable; only the child's ends are passed)
        child_file = str(self.fence.child_path(entry))
        try:
            p = subprocess.Popen(["/bin/sh", "-c", _WRAPPER, "sh", str(a_r), str(r_w), nonce, child_file, *map(str, argv)],
                                 cwd=cwd, env=fenced_env(env), pass_fds=(a_r, r_w), start_new_session=True,
                                 stdin=subprocess.PIPE if input is not None else None,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        except OSError as e:
            for fd in (a_r, a_w, r_r, r_w):
                os.close(fd)
            self.fence.retire(entry)
            return Result(127 if isinstance(e, FileNotFoundError) else 126, "", str(e))
        os.close(a_r)
        os.close(r_w)
        try:
            self._at("popen")
            failure = self._await_ready(p, r_r, startup_end, entry)
            if failure is None:
                child = self.fence.read_child(entry)
                if child is None or child[0] != p.pid or child[1] != p.pid or lstart_missing(child[2]):
                    failure = ("startup failed", f"child identity record missing or mismatched: {child}")
            self._at("ready")
            if failure is not None:
                self._abort(p, entry)
                return Result(124 if failure[0] == "startup timeout" else 126, "", f"{failure[0]}: {argv[0]} ({failure[1]})")
            self.fence.approve(entry, child[0], child[1], child[2])
            self._at("approved")
            os.write(a_w, (nonce + "\n").encode())
            self._at("nonce")
        finally:
            os.close(r_r)
            try:
                os.close(a_w)
            except OSError:
                pass
        res = self._collect(p, input, deadline, argv)
        self._finish(p, entry)
        return res

    # ---- startup ------------------------------------------------------
    def _await_ready(self, p, r_r, startup_end, entry):
        sel = selectors.DefaultSelector()
        sel.register(r_r, selectors.EVENT_READ)
        try:
            left = startup_end - time.monotonic()
            if left <= 0 or not sel.select(left):
                return ("startup timeout", "child never signalled readiness within the startup budget")
            if os.read(r_r, 1) != b"r":
                return ("startup failed", f"child exited before readiness (code {p.poll()})")
            return None
        finally:
            sel.close()

    def _abort(self, p, entry) -> None:
        """A child that never became approved cannot run the command; make sure its group is gone, then forget it."""
        self._kill_group(p.pid, p, grace=0.5)
        try:
            p.stdout.close(), p.stderr.close()
            if p.stdin:
                p.stdin.close()
        except OSError:
            pass
        p.wait()
        self._finish(p, entry)

    # ---- execution / collection --------------------------------------
    def _kill_group(self, pgid: int, p, grace: float = 1.0) -> None:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pgid, sig)
            except (ProcessLookupError, PermissionError):
                break
            end = time.monotonic() + (grace if sig == signal.SIGTERM else 2.0)
            while time.monotonic() < end:
                if not self._group_exists(pgid):
                    return
                time.sleep(0.02)

    @staticmethod
    def _group_exists(pgid: int) -> bool:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        return True

    def _collect(self, p, input, deadline, argv) -> Result:
        sel = selectors.DefaultSelector()
        bufs = {p.stdout: [], p.stderr: []}
        for f in (p.stdout, p.stderr):
            os.set_blocking(f.fileno(), False)
            sel.register(f, selectors.EVENT_READ)
        data = memoryview(input.encode()) if input is not None else None
        if p.stdin is not None:
            if data:
                os.set_blocking(p.stdin.fileno(), False)
                sel.register(p.stdin, selectors.EVENT_WRITE)
            else:
                p.stdin.close()
        swept_at, timed_out = None, False
        while sel.get_map() or p.poll() is None:
            now = time.monotonic()
            if deadline is not None and now >= deadline and not timed_out:
                timed_out = True
                self._kill_group(p.pid, p)
                swept_at = time.monotonic()
            if p.poll() is not None and swept_at is None:
                self._kill_group(p.pid, p, grace=0.0)   # leader gone: sweep leftovers that may hold our pipes
                swept_at = time.monotonic()
            if swept_at is not None and time.monotonic() - swept_at > DRAIN_CAP:
                break
            limit = 0.2
            if deadline is not None and not timed_out:
                limit = max(0.0, min(limit, deadline - time.monotonic()))
            if not sel.get_map():
                time.sleep(min(limit, 0.05))
                continue
            for key, _ in sel.select(limit):
                f = key.fileobj
                if f is p.stdin:
                    try:
                        n = os.write(f.fileno(), data[:65536])
                        data = data[n:]
                    except BlockingIOError:
                        continue
                    except OSError:
                        data = memoryview(b"")
                    if not len(data):
                        sel.unregister(f)
                        f.close()
                    continue
                try:
                    chunk = os.read(f.fileno(), 65536)
                except BlockingIOError:
                    continue
                except OSError:
                    chunk = b""
                if chunk:
                    bufs[f].append(chunk)
                else:
                    sel.unregister(f)
        sel.close()
        for f in (p.stdout, p.stderr, p.stdin):
            try:
                if f:
                    f.close()
            except OSError:
                pass
        try:
            code = p.wait(timeout=2)
        except subprocess.TimeoutExpired:
            p.kill()
            code = p.wait()
        if timed_out:
            return Result(124, "", f"timeout: {argv[0]}")
        text = lambda f: b"".join(bufs[f]).decode("utf-8", "replace")
        return Result(code, text(p.stdout), text(p.stderr))

    def _finish(self, p, entry) -> None:
        """Delete the journal marker only once the whole process group is proven gone."""
        pgid = p.pid
        self._kill_group(pgid, p, grace=0.0)
        if self._group_exists(pgid):
            time.sleep(0.2)
        if not self._group_exists(pgid) or self.fence.group_verdict({**entry, "pid": p.pid, "pgid": pgid}).state == "DEAD":
            self.fence.retire(entry)
        else:
            self.fence.keep(entry, "process group still present after TERM/KILL: completion unproven")


def lstart_missing(text: str) -> bool:
    return not text or len(text.split()) != 5


# A failure that asking again can fix (the request itself was fine): one table for gh and git diagnostics.
# An explicit HTTP status decides first (`HTTP 502`, git's `returned error: 404`): only 5xx / 429 / a secondary rate limit
# retry, every other status is a definite answer. Network phrases apply only when the diagnostic carries no status, and
# never a generic wrapper such as git's `unable to access` (it prefixes definite 404s too).
_STATUS = re.compile(r"\b(?:http(?:/\d(?:\.\d)?)?|error:)\s*(\d{3})\b")
RATE_LIMIT_TOKENS = ("secondary rate limit", "abuse detection", "rate limit exceeded")
NETWORK_TOKENS = (
    "could not resolve host", "could not resolve hostname", "temporary failure in name resolution",
    "connection timed out", "connection reset", "connection refused", "connection closed", "broken pipe",
    "operation timed out", "network is unreachable", "no route to host", "ssl connection timeout",
    "tls handshake timeout", "i/o timeout", "unexpected eof", "the remote end hung up", "early eof",
    "gnutls_handshake", "timeout awaiting response", "failed to connect to", "bad gateway",
    "service unavailable", "gateway time-out",
    # #5633: GitHub's receive side answering a push with a reasonless `! [remote rejected] ... (failed)` or
    # `(internal error)` is a server fault; real rejections carry a reason (hook declined, protected branch, ...).
    "(failed)", "(internal error)",
)


def transient(res: Result) -> str | None:
    """Why `res` (a failed command) is worth asking again, or None for a definite answer (401/403/404/422, local errors)."""
    if res.ok:
        return None
    why = (res.err.strip() or res.out.strip())[:300]
    if res.code == 124:
        return why or "timeout"
    text = f"{res.err}\n{res.out}".lower()
    statuses = [int(x) for x in _STATUS.findall(text)]
    if statuses:
        if any(x >= 500 or x == 429 for x in statuses) or (403 in statuses and any(t in text for t in RATE_LIMIT_TOKENS)):
            return why or "http"
        return None
    if any(t in text for t in RATE_LIMIT_TOKENS + NETWORK_TOKENS):
        return why or "network"
    return None


# `gh` talks only to GitHub, so (#2810) a failed gh command is retried unless the diagnostic proves it never reached
# GitHub's API: every HTTP status (404/401/403/422 included), a GraphQL error, a timeout or a network failure is a
# retryable API/network outcome; a missing binary or a usage/argument error is a local bug and stays definite.
_GH_API_TOKENS = ("graphql:", "error connecting to", "api.github.com")


def gh_transient(res: Result) -> str | None:
    """Why a failed `gh` command is retried, or None when the failure is local (no gh binary, bad arguments)."""
    if res.ok or res.code == 127:
        return None
    why = (res.err.strip() or res.out.strip())[:300]
    if res.code == 124:
        return why or "timeout"
    text = f"{res.err}\n{res.out}".lower()
    if _STATUS.search(text) or any(t in text for t in RATE_LIMIT_TOKENS + NETWORK_TOKENS + _GH_API_TOKENS):
        return why or "gh api"
    return None
