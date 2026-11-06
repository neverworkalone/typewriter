"""Crash fence for synchronous Git/Node children (#3773).

A Supervisor that dies must not leave a Git/Node CLI that starts late or survives to race the next instance on the shared
repository, an owned worktree or the shared `s2-verify` checkout. `shell.FencedRunner` journals every such command under
`children/<instance>/` and only releases it after proof; this module owns the journal, the identity checks, the
ALIVE / DEAD / UNKNOWN verdict and the per-resource fence. It is not a process manager and schedules nothing.

Journal invariant: the approval nonce is written to the child only AFTER the `approved` marker is persisted. An entry that
is still `intent` therefore belongs to a command that can never have run once its owner is dead.
"""
from __future__ import annotations

import errno
import fcntl
import json
import os
import re
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from .gitops import ResourceFenced  # noqa: F401  (re-exported: the fence API owns this name)

ALIVE, DEAD, UNKNOWN = "ALIVE", "DEAD", "UNKNOWN"
ALL_RESOURCES = ("repo", "verify")
OWNER_LOCK = "owner.lock"
WRAPPER_PREFIX = "/bin/sh -c"


@dataclass(frozen=True)
class Verdict:
    state: str
    reason: str


_ROW = re.compile(r"^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.*)$")


@dataclass(frozen=True)
class PsRow:
    pid: int
    pgid: int
    stat: str
    lstart: str
    command: str


def norm_lstart(text: str) -> str:
    return " ".join(text.split())


def lstart_epoch(text: str) -> float | None:
    try:
        return time.mktime(time.strptime(norm_lstart(text), "%a %b %d %H:%M:%S %Y"))
    except (ValueError, OverflowError):
        return None


def ps_table() -> list[PsRow] | None:
    """Every process, or None when `ps` failed or printed something unparseable (never an empty answer standing for DEAD)."""
    try:
        cp = subprocess.run(["/bin/ps", "-axo", "pid=,pgid=,stat=,lstart=,command="], capture_output=True, text=True,
                            timeout=15, env={"LC_ALL": "C", "PATH": "/bin:/usr/bin"})
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return None
    if cp.returncode != 0:
        return None
    rows = []
    for line in cp.stdout.splitlines():
        if not line.strip():
            continue
        m = _ROW.match(line)
        if not m:
            return None
        rows.append(PsRow(int(m[1]), int(m[2]), m[3], norm_lstart(m[4]), m[5].strip()))
    return rows or None


def _atomic_write(path: Path, data: dict) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, sort_keys=True), "utf-8")
    os.replace(tmp, path)


def owner_state(directory: Path) -> str:
    """`dead` only when the instance's owner lock can be taken; `alive` when it is held; `unknown` without a lock file."""
    lock = directory / OWNER_LOCK
    try:
        fd = os.open(lock, os.O_RDWR)
    except OSError:
        return "unknown"
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            return "alive" if e.errno in (errno.EWOULDBLOCK, errno.EAGAIN, errno.EACCES) else "unknown"
        fcntl.flock(fd, fcntl.LOCK_UN)
        return "dead"
    finally:
        os.close(fd)


class Fence:
    def __init__(self, root: Path, instance: str | None = None, *, ps=ps_table, killpg=os.killpg,
                 grace: float = 3.0, recheck_interval: float = 5.0, clock=time.time, monotonic=time.monotonic):
        self.root = Path(root)
        self.instance = instance or str(uuid.uuid4())
        self.dir = self.root / self.instance
        self._ps, self._killpg, self.grace = ps, killpg, grace
        self._interval, self._clock, self._mono = recheck_interval, clock, monotonic
        self._guard = threading.RLock()
        self._unresolved: dict[str, dict] = {}   # key -> {entry, path, instance, verdict, resources}
        self._reported: set[tuple[str, str]] = set()
        self._reports: list[str] = []
        self._log = None
        self._last_recheck = float("-inf")
        self._lock_fd: int | None = None

    # ---- identity / logging ------------------------------------------
    def open(self) -> "Fence":
        """Create this instance's journal and take its owner lock; must follow the Supervisor single-instance lock."""
        self.dir.mkdir(parents=True, exist_ok=True)
        fd = os.open(self.dir / OWNER_LOCK, os.O_RDWR | os.O_CREAT, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self._lock_fd = fd
        return self

    def close(self) -> None:
        if self._lock_fd is not None:
            os.close(self._lock_fd)
            self._lock_fd = None

    def attach_log(self, log) -> None:
        """`log(message)`; reports produced before the Store existed are flushed now."""
        self._log = log
        for message in self.drain_reports():
            log(message)

    def drain_reports(self) -> list[str]:
        with self._guard:
            out, self._reports = self._reports, []
            return out

    def _report(self, key: str, reason: str, message: str) -> None:
        with self._guard:
            if (key, reason) in self._reported:
                return
            self._reported.add((key, reason))
            self._reports.append(message)
        if self._log is not None:
            for text in self.drain_reports():
                self._log(text)

    # ---- journal -------------------------------------------------------
    def begin(self, argv: list[str], cwd, resources) -> dict:
        entry = {"v": 1, "id": uuid.uuid4().hex, "instance": self.instance, "state": "intent",
                 "argv0": os.path.basename(argv[0]), "cmdline": " ".join(argv)[:2000], "cwd": str(cwd or ""),
                 "resources": sorted(resources), "intent_at": self._clock(), "supervisor_pid": os.getpid()}
        _atomic_write(self.dir / f"{entry['id']}.json", entry)
        return entry

    def child_path(self, entry: dict) -> Path:
        return self.dir / f"{entry['id']}.child"

    def read_child(self, entry: dict) -> tuple[int, int, str] | None:
        try:
            pid, pgid, rest = self.child_path(entry).read_text("utf-8").split(None, 2)
            return int(pid), int(pgid), norm_lstart(rest)
        except (OSError, ValueError):
            return None

    def approve(self, entry: dict, pid: int, pgid: int, lstart: str) -> None:
        entry.update(state="approved", pid=pid, pgid=pgid, lstart=lstart, approved_at=self._clock())
        _atomic_write(self.dir / f"{entry['id']}.json", entry)

    def retire(self, entry: dict) -> None:
        """Delete the markers. Only after the command's process group is proven gone."""
        for suffix in (".json", ".child", ".child.tmp", ".json.tmp"):
            try:
                (self.dir / f"{entry['id']}{suffix}").unlink()
            except OSError:
                pass

    def keep(self, entry: dict, reason: str) -> None:
        """Completion could not be proven: the entry stays on disk and its resources stay fenced."""
        self._hold(self.dir / f"{entry['id']}.json", entry, self.instance, Verdict(UNKNOWN, reason))

    # ---- classification -----------------------------------------------
    def _identity_ok(self, row: PsRow, entry: dict) -> bool:
        if row.pid != entry.get("pid") or row.pgid != entry.get("pgid") or row.lstart != entry.get("lstart"):
            return False
        started = lstart_epoch(row.lstart)
        if started is None or started < float(entry.get("intent_at", 0)) - 2:
            return False
        return row.command == entry.get("cmdline") or row.command.startswith(WRAPPER_PREFIX)

    def group_verdict(self, entry: dict) -> Verdict:
        pgid = entry.get("pgid")
        if type(pgid) is not int or pgid <= 1 or type(entry.get("pid")) is not int:
            return Verdict(UNKNOWN, "approved marker has no usable pid/pgid")
        try:
            self._killpg(pgid, 0)
        except ProcessLookupError:
            return Verdict(DEAD, f"killpg({pgid},0)=ESRCH: process group absent")
        except PermissionError:
            pass   # macOS reports EPERM for a group of zombies / another user's group: only ps can tell
        except OSError as e:
            return Verdict(UNKNOWN, f"killpg({pgid},0) failed: {e}")
        rows = self._ps()
        if rows is None:
            return Verdict(UNKNOWN, "ps failed or unparseable: group not proven absent")
        members = [r for r in rows if r.pgid == pgid]
        if not members:
            return Verdict(UNKNOWN, f"killpg says pgid {pgid} exists but ps lists no member")
        live = [r for r in members if not r.stat.startswith("Z")]
        if not live:
            return Verdict(DEAD, f"pgid {pgid}: only zombies remain")
        leader = [r for r in live if r.pid == entry["pid"]]
        if leader and self._identity_ok(leader[0], entry):
            return Verdict(ALIVE, f"pid {entry['pid']} identity confirmed (lstart/command)")
        if leader:
            return Verdict(UNKNOWN, f"pid {entry['pid']} exists with a different identity: PID/PGID reuse suspected")
        return Verdict(UNKNOWN, f"leader {entry['pid']} gone but pgid {pgid} still has members: identity unproven")

    def classify(self, entry: dict, owner: str) -> Verdict:
        if entry.get("state") != "approved":
            if owner == "dead":
                return Verdict(DEAD, "never approved and its parent is dead: command cannot run (nonce never sent)")
            return Verdict(UNKNOWN, f"unapproved entry whose owner is {owner}")
        return self.group_verdict(entry)

    def terminate(self, entry: dict) -> Verdict:
        """TERM -> grace -> KILL -> re-judge, for a group whose identity is confirmed. Never for UNKNOWN."""
        pgid = entry["pgid"]
        for sig, wait in ((signal.SIGTERM, self.grace), (signal.SIGKILL, self.grace)):
            try:
                self._killpg(pgid, sig)
            except ProcessLookupError:
                break
            except OSError:
                return Verdict(UNKNOWN, f"signal {sig.name} to pgid {pgid} failed")
            end = self._mono() + wait
            while self._mono() < end:
                if self.group_verdict(entry).state == DEAD:
                    return Verdict(DEAD, f"pgid {pgid} terminated ({sig.name})")
                time.sleep(0.05)
        verdict = self.group_verdict(entry)
        return verdict if verdict.state != ALIVE else Verdict(UNKNOWN, f"pgid {pgid} survived TERM/KILL")

    def _entry_resources(self, entry) -> list[str]:
        res = entry.get("resources") if isinstance(entry, dict) else None
        if not isinstance(res, list) or not res or not all(isinstance(r, str) for r in res):
            return list(ALL_RESOURCES)   # an unreadable marker protects everything
        return res

    def _hold(self, path: Path, entry, instance: str, verdict: Verdict) -> None:
        key = str(path)
        with self._guard:
            self._unresolved[key] = {"entry": entry, "path": path, "instance": instance, "verdict": verdict,
                                     "resources": self._entry_resources(entry)}
        e = entry if isinstance(entry, dict) else {}
        self._report(key, verdict.reason,
                     f"fence 유지(UNKNOWN/미해소): resource={','.join(self._entry_resources(entry))} pid={e.get('pid')} "
                     f"pgid={e.get('pgid')} marker={path} 판정={verdict.state}: {verdict.reason}")

    def _settle(self, path: Path, entry, instance: str, owner: str) -> bool:
        """True when the entry is proven finished/non-executable (markers deleted); otherwise it stays fenced."""
        if not isinstance(entry, dict):
            self._hold(path, entry, instance, Verdict(UNKNOWN, "unreadable journal marker"))
            return False
        verdict = self.classify(entry, owner)
        if verdict.state == ALIVE:
            verdict = self.terminate(entry)
        if verdict.state == DEAD:
            with self._guard:
                self._unresolved.pop(str(path), None)
            for suffix in (".json", ".child", ".child.tmp", ".json.tmp"):
                try:
                    path.with_name(path.name[: -len(".json")] + suffix).unlink()
                except OSError:
                    pass
            return True
        self._hold(path, entry, instance, verdict)
        return False

    def _load(self, path: Path):
        try:
            data = json.loads(path.read_text("utf-8"))
        except (OSError, ValueError):
            return None
        return data if isinstance(data, dict) and data.get("v") == 1 else None

    # ---- startup scan / recheck ---------------------------------------
    def scan_previous(self) -> list[dict]:
        """Judge every other instance's journal (run for ANY workers value, before the first Lane action)."""
        if not self.root.is_dir():
            return []
        for directory in sorted(p for p in self.root.iterdir() if p.is_dir() and p.name != self.instance):
            owner = owner_state(directory)
            for path in sorted(directory.glob("*.json")):
                self._settle(path, self._load(path), directory.name, owner)
            self._prune(directory, owner)
        self._last_recheck = self._mono()
        return self.previous_unresolved()

    def _prune(self, directory: Path, owner: str) -> None:
        """A past instance's directory goes only when empty (its owner lock file does not count) and its owner is dead."""
        if owner != "dead":
            return
        names = {p.name for p in directory.iterdir()}
        if names - {OWNER_LOCK}:
            return
        try:
            (directory / OWNER_LOCK).unlink()
            directory.rmdir()
        except OSError:
            pass

    def recheck(self, force: bool = False) -> None:
        """Re-judge held entries (rate limited); a provably finished one releases its resource without a restart."""
        now = self._mono()
        with self._guard:
            if not self._unresolved or (not force and now - self._last_recheck < self._interval):
                return
            self._last_recheck = now
            held = list(self._unresolved.values())
        for item in held:
            directory = item["path"].parent
            # our own entry: the owner is this process, so only an approved group verdict can release it
            owner = "alive" if item["instance"] == self.instance else owner_state(directory)
            self._settle(item["path"], self._load(item["path"]) if item["path"].exists() else item["entry"],
                         item["instance"], owner)
            if item["instance"] != self.instance:
                self._prune(directory, owner)

    # ---- queries -------------------------------------------------------
    def blocked(self, resources) -> list[dict]:
        wanted = set(resources)
        self.recheck()
        with self._guard:
            return [item for item in self._unresolved.values() if wanted & set(item["resources"])]

    def check(self, resources) -> None:
        hits = self.blocked(resources)
        if hits:
            item = hits[0]
            e = item["entry"] if isinstance(item["entry"], dict) else {}
            raise ResourceFenced(
                f"자원 fence: {','.join(sorted(set(resources) & set(item['resources'])))} · instance {item['instance']} · "
                f"pid {e.get('pid')}/pgid {e.get('pgid')} · marker {item['path']} · "
                f"{item['verdict'].state}: {item['verdict'].reason}")

    def previous_unresolved(self) -> list[dict]:
        """Unresolved fences left by OTHER instances (for #3774 READY)."""
        with self._guard:
            return [dict(item) for item in self._unresolved.values() if item["instance"] != self.instance]

    def unresolved(self) -> list[dict]:
        with self._guard:
            return [dict(item) for item in self._unresolved.values()]

    def active_children(self) -> list[dict]:
        """Every journalled command of THIS instance not yet proven finished or non-executable (never just live Popens)."""
        out = []
        for path in sorted(self.dir.glob("*.json")):
            entry = self._load(path)
            out.append(entry if entry is not None else {"id": path.stem, "state": "unreadable", "resources": list(ALL_RESOURCES)})
        return out
