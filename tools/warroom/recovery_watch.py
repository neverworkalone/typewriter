#!/usr/bin/env python3
"""War Room Recovery watchdog (`./recovery`): the one scope the Supervisor cannot cover itself — its own death or a
failure to start.

Standalone on purpose: standard library only, never `import warroom`, so a Supervisor import or startup error cannot stop
it. What it shares with the Supervisor is checked by tests (the duplicate-launch SQL, the CLI argv, the child env).

Per iteration (`loop` runs one every 60 s):
1. Supervisor healthy (lock held, runtime pid alive, kv heartbeat moving) -> nothing; the internal Recovery lane owns
   everything else. Line controls (Stop / Drain / run=0) are never read or written.
2. A restart in progress (STOPPING within the Controller's handoff window, `restarting` requests still being checked,
   the launcher lock held) -> wait. A pending request alone is never a reason to wait.
3. Dead, stopped or stuck -> the official Controller once: `./kwar --no-attach` (its 0/1/2 result is recorded as is).
4. Still failing -> the attempt's condition key (HEAD, config, environment, blockers) is recorded with its evidence in
   `.git/typewriter-supervisor/recovery/watchdog.json`, one notice is raised, and one `supervisor` recovery case + run
   is opened through the same DB claim the Supervisor uses (it adopts that run once it is back). The same key is never
   retried; a changed HEAD/config/environment/blocker is.
"""
from __future__ import annotations

import fcntl
import hashlib
import json
import os
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

INTERVAL = 60
HANDOFF_GRACE = 30        # = restart_controller.HANDOFF_GRACE (test-checked)
STARTUP_TIMEOUT = 20      # = restart_controller.STARTUP_TIMEOUT (test-checked)
HEARTBEAT_MAX_AGE = 180
VERIFY_SECONDS = 180
KWAR_TIMEOUT = 600
TERMINAL_REQUEST_STATES = ("loaded", "progress_verified", "recovery_blocked", "cancelled")
MAX_PARALLEL_DEFAULT = 1
# = store.CLAIM_RECOVERY_RUN_SQL (test-checked): the one duplicate-launch guard shared with the Supervisor.
CLAIM_RECOVERY_RUN_SQL = (
    "INSERT INTO recovery_runs(case_id,kind,producer,model,effort,permission,session_id,log_file,exit_file,started_at) "
    "SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM recovery_cases WHERE id=? AND state!='RESOLVED') "
    "AND NOT EXISTS (SELECT 1 FROM recovery_runs WHERE case_id=? AND ended_at IS NULL) "
    "AND (SELECT COUNT(*) FROM recovery_runs WHERE ended_at IS NULL) < ?")
SCRUBBED = ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
            "GH_HOST", "GH_REPO", "GIT_ASKPASS", "SSH_ASKPASS", "GIT_SSH_COMMAND", "GIT_SSH")   # = auth.SCRUBBED
ARGV_PROMPT_LIMIT = 64 * 1024   # = ProcessAdapter.ARGV_PROMPT_LIMIT
WRAPPER = ['echo $$ > "$WARROOM_EXIT_FILE.pid" || { echo 126 > "$WARROOM_EXIT_FILE"; exit 126; }', '"$@"',
           "echo $? > \"$WARROOM_EXIT_FILE\""]   # = ProcessAdapter._spawn's exit wrapper


def _read_json(path: Path):
    try:
        return json.loads(Path(path).read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _atomic_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True), "utf-8")
    os.replace(tmp, path)


def lock_held(path: Path) -> bool:
    """True while another process holds the flock (the Supervisor / launcher lock); never creates a missing lock."""
    if not path.exists():
        return False
    try:
        with path.open("a+") as fh:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return True
            fcntl.flock(fh, fcntl.LOCK_UN)
    except OSError:
        return False
    return False


def pid_alive(pid) -> bool:
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def child_env(base: dict, gh_config: Path, git_name: str = "", git_email: str = "") -> dict:
    """= auth.build_env (test-checked): the producer-scoped gh/git environment every War Room AI child gets."""
    env = {k: v for k, v in base.items() if k not in SCRUBBED and not k.startswith("GIT_CONFIG")}
    env["GH_CONFIG_DIR"] = str(gh_config)
    env["GIT_TERMINAL_PROMPT"] = "0"
    entries = [("credential.helper", ""), ("credential.helper", "!gh auth git-credential"),
               ("url.https://github.com/.insteadOf", "git@github.com:"),
               ("url.https://github.com/.insteadOf", "ssh://git@github.com/")]
    env["GIT_CONFIG_COUNT"] = str(len(entries))
    for i, (k, v) in enumerate(entries):
        env[f"GIT_CONFIG_KEY_{i}"] = k
        env[f"GIT_CONFIG_VALUE_{i}"] = v
    if git_name:
        env["GIT_AUTHOR_NAME"] = env["GIT_COMMITTER_NAME"] = git_name
    if git_email:
        env["GIT_AUTHOR_EMAIL"] = env["GIT_COMMITTER_EMAIL"] = git_email
    return env


def max_parallel(cfg: dict) -> int:
    """`recovery_max_parallel` as config_problem allows it (an int 1-2); anything else is read as the safe 1, never
    passed through: the watchdog runs exactly when the Supervisor's own config check could not."""
    n = cfg.get("recovery_max_parallel", MAX_PARALLEL_DEFAULT)
    return n if type(n) is int and 1 <= n <= 2 else MAX_PARALLEL_DEFAULT


def recovery_pins(cfg: dict) -> dict | None:
    """The configured `recovery` producer/profile resolved like config.role_entry(RECOVERY) (test-checked); None when it
    is off or cannot be resolved to exactly one producer."""
    r = cfg.get("recovery")
    producers = cfg.get("producers") if isinstance(cfg.get("producers"), dict) else {}
    profiles = cfg.get("model_profiles") if isinstance(cfg.get("model_profiles"), dict) else {}
    assignments = cfg.get("assignments") if isinstance(cfg.get("assignments"), dict) else {}
    if not isinstance(r, str) or (r in producers and r in profiles):
        return None

    def assigned(pid):
        return [v.get(pid) for v in assignments.values() if isinstance(v, dict) and v.get(pid)]

    if r in producers:
        if assigned(r):
            return None
        p, producer = producers[r], r
    elif r in profiles:
        p = profiles[r]
        cands = [pid for pid, q in producers.items() if isinstance(q, dict) and q.get("adapter") == p.get("adapter")]
        if len(cands) > 1:
            cands = [pid for pid in cands if r in assigned(pid)]
        if len(cands) != 1:
            return None
        producer = cands[0]
    else:
        return None
    if not isinstance(p, dict) or p.get("adapter") not in ("claude", "codex") or not p.get("model") or not p.get("effort"):
        return None
    return {"producer": producer, "adapter": p["adapter"], "model": p["model"], "effort": p["effort"],
            "permission_profile": p.get("permission_profile") or "",
            "fast": p.get("fast") if p["adapter"] == "codex" else None}


def recovery_argv(pins: dict, prompt: str, title: str, git_dir: str, cfg: dict) -> tuple[list[str], str | None]:
    """(argv, stdin text) = ClaudeCodeAdapter.start(permission_mode="auto") / CodexCLIAdapter.start(git_dir) (test-checked)."""
    big = len(prompt.encode("utf-8", errors="replace")) > ARGV_PROMPT_LIMIT
    if pins["adapter"] == "claude":
        argv = [cfg.get("claude_bin") or "claude", "-p", *([] if big else [prompt]), "--model", pins["model"],
                "--effort", pins["effort"], "--output-format", "stream-json", "--verbose", "--name", title,
                "--permission-mode", "auto"]
    else:
        pin = ["--json", "-m", pins["model"], "-c", f"model_reasoning_effort={pins['effort']}"]
        if pins["permission_profile"]:
            pin += ["-c", f"default_permissions={pins['permission_profile']}"]
        if pins["fast"] is True:
            pin += ["-c", "service_tier=fast", "-c", "features.fast_mode=true"]
        elif pins["fast"] is False:
            pin += ["-c", "service_tier=default", "-c", "features.fast_mode=false"]
        argv = [cfg.get("codex_bin") or "codex", "exec", *pin, "--add-dir", git_dir, "-" if big else prompt]
    return argv, (prompt if big else None)


def spawn(argv: list[str], cwd: Path, env: dict, log_file: Path, exit_file: Path, stdin_text: str | None) -> int:
    """The adapters' detached exit wrapper: own process group, `<exit>.pid` first, exit status last."""
    log_file.parent.mkdir(parents=True, exist_ok=True)
    exit_file.unlink(missing_ok=True)
    env = {**env, "WARROOM_EXIT_FILE": str(exit_file)}
    stdin = None
    if stdin_text is not None:
        prompt_file = log_file.with_name(log_file.name + ".prompt")
        prompt_file.write_text(stdin_text, "utf-8")
        stdin = open(prompt_file, "rb")
    try:
        with open(log_file, "wb") as log:
            p = subprocess.Popen(["/bin/sh", "-c", "; ".join(WRAPPER), "sh", *argv], cwd=cwd, env=env,
                                 stdin=stdin or subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                                 start_new_session=True)
    finally:
        if stdin:
            stdin.close()
    return p.pid


class Watch:
    def __init__(self, root: Path, *, run=subprocess.run, clock=time.time, sleep=time.sleep, spawn_fn=spawn,
                 environ=None, out=sys.stderr):
        self.root = Path(root).resolve()
        self.run, self.clock, self.sleep, self.spawn_fn = run, clock, sleep, spawn_fn
        self.environ = dict(os.environ if environ is None else environ)
        self.out = out
        self.state_dir = self.root / ".git" / "typewriter-supervisor"
        self.local = self.root / "tools" / "warroom" / ".local"
        self.db = self.local / "warroom.db"
        self.dir = self.state_dir / "recovery"
        self.file = self.dir / "watchdog.json"
        self.paused_flag = self.dir / "paused"

    # ---- reading ------------------------------------------------------------------------------------------------------
    def _connect(self, write: bool = False):
        if write:
            conn = sqlite3.connect(self.db, timeout=30)
        else:
            conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True, timeout=30)
        conn.row_factory = sqlite3.Row
        return conn

    def kv(self, key: str):
        try:
            conn = self._connect()
            try:
                row = conn.execute("SELECT value FROM kv WHERE key=?", (key,)).fetchone()
            finally:
                conn.close()
        except sqlite3.Error:
            return None
        return row["value"] if row else None

    def heartbeat(self) -> float | None:
        try:
            return float(self.kv("heartbeat"))
        except (TypeError, ValueError):
            return None

    def config(self) -> dict:
        cfg = _read_json(self.local / "config.json")
        return cfg if isinstance(cfg, dict) else {}

    def requests(self) -> list[dict]:
        out = []
        for path in sorted((self.state_dir / "restart-requests").glob("restart-*.json")):
            r = _read_json(path)
            if isinstance(r, dict) and r.get("state") not in TERMINAL_REQUEST_STATES:
                out.append({"file": path.name, **r})
        return out

    def status(self) -> dict:
        runtime = _read_json(self.state_dir / "supervisor-runtime.json") or {}
        phase = None
        try:
            phase = json.loads(self.kv("restart_phase") or "null")
        except ValueError:
            phase = None
        hb = self.heartbeat()
        now = self.clock()
        return {"lock": lock_held(self.state_dir / "supervisor.lock"),
                "launching": lock_held(self.local / "supervisor-launch.lock"),
                "pid": runtime.get("pid"), "pid_alive": pid_alive(runtime.get("pid")),
                "instance": runtime.get("instance"), "loaded_code_sha": runtime.get("loaded_code_sha"),
                "heartbeat_age": None if hb is None else max(0.0, now - hb), "phase": phase,
                "requests": self.requests()}

    def healthy(self, st: dict) -> bool:
        age = st["heartbeat_age"]
        return st["lock"] and st["pid_alive"] and age is not None and age < HEARTBEAT_MAX_AGE

    def in_progress(self, st: dict) -> str | None:
        """A restart that is still moving (wait), told apart from one stuck on a blocker (act)."""
        window = HANDOFF_GRACE + 4 * STARTUP_TIMEOUT
        now = self.clock()
        if st["launching"]:
            return "launcher가 Supervisor를 시작/교체 중"
        phase = st["phase"] or {}
        if phase.get("phase") == "STOPPING" and now - float(phase.get("stopping_at") or 0) < window:
            return "Supervisor STOPPING 인계 중"
        for r in st["requests"]:
            if r.get("state") == "restarting" and now - float(r.get("checked_at") or r.get("updated_at") or 0) < window:
                return f"재시작 요청 {r['file']} 진행 중"
        return None

    def supervisor_run_open(self) -> bool:
        try:
            conn = self._connect()
            try:
                return conn.execute("SELECT 1 FROM recovery_runs r JOIN recovery_cases c ON c.id=r.case_id "
                                    "WHERE c.key='supervisor' AND c.state!='RESOLVED' AND r.ended_at IS NULL").fetchone() is not None
            finally:
                conn.close()
        except sqlite3.Error:
            return False

    def head(self) -> str | None:
        r = self.run(["git", "rev-parse", "HEAD"], cwd=self.root, capture_output=True, text=True, timeout=30)
        return r.stdout.strip() if r.returncode == 0 else None

    def condition_key(self, st: dict) -> str:
        venv = self.local / "venv" / "bin" / "python"
        try:
            vstat = [venv.stat().st_mtime, os.path.realpath(venv)]
        except OSError:
            vstat = None
        try:
            cfg_hash = hashlib.sha256((self.local / "config.json").read_bytes()).hexdigest()
        except OSError:
            cfg_hash = None
        blockers = sorted(str(r.get("blocker")) for r in st["requests"] if r.get("blocker"))
        return hashlib.sha256(json.dumps([self.head(), cfg_hash, vstat, blockers]).encode()).hexdigest()[:16]

    # ---- the record -------------------------------------------------------------------------------------------------
    def load(self) -> dict:
        data = _read_json(self.file)
        return data if isinstance(data, dict) else {}

    def save(self, data: dict) -> None:
        _atomic_json(self.file, data)

    def notify(self, title: str, text: str) -> None:
        print(f"[recovery] {title}: {text}", file=self.out)
        try:
            self.run(["osascript", "-e", f"display notification {json.dumps(text[:200])} with title {json.dumps(title)}"],
                     capture_output=True, timeout=10)
        except (OSError, subprocess.SubprocessError):
            pass

    # ---- one iteration ------------------------------------------------------------------------------------------------
    def once(self) -> str:
        if self.paused_flag.exists():
            return "paused"
        st = self.status()
        data = self.load()
        data["checked_at"] = self.clock()
        if self.healthy(st):
            if data.get("failed_key"):
                data.update(failed_key=None, recovered_at=self.clock())
                self.notify("War Room Recovery", "Supervisor가 다시 정상입니다")
            data["state"] = "healthy"
            self.save(data)
            return "healthy"
        why = self.in_progress(st)
        if why:
            data["state"] = "waiting"
            data["waiting"] = why
            self.save(data)
            return "waiting"
        if self.supervisor_run_open():
            data["state"] = "owned"
            self.save(data)
            return "owned"   # an open `supervisor` recovery run owns the restart
        key = self.condition_key(st)
        if data.get("failed_key") == key:
            data["state"] = "failed"
            self.save(data)
            return "held"   # the same conditions already failed: never repeated until one of them changes
        before = self.heartbeat()
        try:
            r = self.run([str(self.root / "kwar"), "--no-attach"], cwd=self.root, capture_output=True, text=True,
                         timeout=KWAR_TIMEOUT, env={**self.environ, "TYPEWRITER_WARROOM_ROOT": str(self.root)})
            code, output = r.returncode, (r.stdout or "") + (r.stderr or "")
        except subprocess.TimeoutExpired as e:
            code, output = 2, f"timeout: {e}"
        except OSError as e:
            code, output = 1, f"{type(e).__name__}: {e}"
        attempt = {"at": self.clock(), "key": key, "kwar_exit": code, "output_tail": output[-2000:], "status": st}
        ok = code == 0 and self._heartbeat_moves(before)
        data["last_attempt"] = attempt
        if ok:
            data.update(state="healthy", failed_key=None, restarted_at=self.clock())
            self.save(data)
            print(f"[recovery] Supervisor 재시작 확인 (kwar exit 0)", file=self.out)
            return "restarted"
        attempt["supervisor_pane"] = self._pane()
        data.update(state="failed", failed_key=key, failed_at=self.clock(), evidence=attempt)
        self.save(data)
        self.notify("War Room Recovery — Supervisor 기동 실패",
                    f"./kwar exit {code}. 같은 조건으로는 다시 시도하지 않습니다. 근거: {self.file}")
        case = self.open_supervisor_case(attempt)
        if case:
            data["case"] = case
            self.save(data)
        return "failed"

    def _heartbeat_moves(self, before: float | None) -> bool:
        deadline = self.clock() + VERIFY_SECONDS
        while True:
            hb = self.heartbeat()
            if hb is not None and hb != before and self.clock() - hb < HEARTBEAT_MAX_AGE:
                return True
            if self.clock() >= deadline:
                return False
            self.sleep(5)

    def _pane(self) -> str:
        try:
            r = self.run(["tmux", "capture-pane", "-p", "-t", "warroom-supervisor"], capture_output=True, text=True,
                         timeout=5)
            return "\n".join(r.stdout.strip().splitlines()[-20:])[-2000:] if r.returncode == 0 else ""
        except (OSError, subprocess.SubprocessError):
            return ""

    # ---- the supervisor case ------------------------------------------------------------------------------------------
    def open_supervisor_case(self, evidence: dict) -> dict | None:
        """One `supervisor` case and its run through the Supervisor's own claim. Nothing when Recovery is off, the DB
        has no Recovery tables yet, or a run for it is already open."""
        cfg = self.config()
        pins = recovery_pins(cfg)
        if pins is None:
            self.notify("War Room Recovery", "recovery가 설정되지 않아(또는 해석 불가) 원인 조사 실행을 열지 않습니다")
            return None
        if pins["adapter"] == "codex" and not pins["permission_profile"]:
            return None
        now = self.clock()
        reason = f"Supervisor 기동 실패: ./kwar exit {evidence.get('kwar_exit')}"
        try:
            conn = self._connect(write=True)
        except sqlite3.Error:
            return None
        try:
            with conn:
                conn.execute("BEGIN IMMEDIATE")
                row = conn.execute("SELECT id FROM recovery_cases WHERE key='supervisor' AND state!='RESOLVED'").fetchone()
                unit = {"reason": reason, "instance": (evidence.get("status") or {}).get("instance"), "watchdog": evidence,
                        "batches": {}}
                if row is None:
                    cid = conn.execute(
                        "INSERT INTO recovery_cases(key,kind,state,blocking_unit,notes,producer,opened_at,updated_at) "
                        "VALUES('supervisor','supervisor','OPEN',?,?,?,?,?)",
                        (json.dumps(unit, sort_keys=True, default=str), "watchdog: Supervisor 기동 실패", pins["producer"],
                         now, now)).lastrowid
                else:
                    cid = row["id"]
        except sqlite3.Error as e:
            print(f"[recovery] supervisor case를 열 수 없습니다: {e}", file=self.out)
            conn.close()
            return None
        prompt = self.prompt(cid, unit)
        logs = self.local / "logs" / "recovery"
        stamp = int(now)
        log, ex = logs / f"case-{cid}-{stamp}.log", logs / f"case-{cid}-{stamp}.exit"
        try:
            with conn:
                cur = conn.execute(CLAIM_RECOVERY_RUN_SQL, (
                    cid, "start", pins["producer"], pins["model"], pins["effort"],
                    pins["permission_profile"] or ("auto" if pins["adapter"] == "claude" else ""), None, str(log), str(ex),
                    time.time(), cid, cid, max_parallel(cfg)))
                if cur.rowcount != 1:
                    return {"case_id": cid, "run_id": None}
                run_id = cur.lastrowid
                conn.execute("UPDATE recovery_cases SET run_id=?, updated_at=? WHERE id=?", (run_id, now, cid))
            argv, stdin_text = recovery_argv(pins, prompt, "Recovery supervisor", str(self.state_dir.parent), cfg)
            env = child_env(self.environ, self.local / "gh", cfg.get("git_name") or "", cfg.get("git_email") or "")
            try:
                pid = self.spawn_fn(argv, self.root, env, log, ex, stdin_text)
            except OSError as e:
                with conn:
                    conn.execute("UPDATE recovery_runs SET ended_at=?, exit_status='not_started' WHERE id=?",
                                 (time.time(), run_id))
                print(f"[recovery] 원인 조사 실행을 시작하지 못했습니다: {e}", file=self.out)
                return {"case_id": cid, "run_id": run_id, "error": str(e)}
            with conn:
                conn.execute("UPDATE recovery_runs SET pid=? WHERE id=?", (pid, run_id))
            print(f"[recovery] supervisor case #{cid} 원인 조사 실행 #{run_id} 시작 (pid {pid})", file=self.out)
            return {"case_id": cid, "run_id": run_id, "pid": pid}
        except sqlite3.Error as e:
            print(f"[recovery] 원인 조사 실행 기록 실패: {e}", file=self.out)
            return None
        finally:
            conn.close()

    def prompt(self, case_id: int, unit: dict) -> str:
        try:
            text = (self.root / "tools" / "warroom" / "prompts" / "recovery.md").read_text("utf-8")
        except OSError:
            text = "STATUS/CASE/DONE/REMAINING/BLOCKER/BOUNDARY/PR 블록으로 보고하세요.\n\nCASE: {{case_key}}\n\n{{case_facts}}"
        facts = {"case": "supervisor", "case_id": case_id, "kind": "supervisor", "reason": unit["reason"],
                 "watchdog_evidence": unit["watchdog"], "watchdog_record": str(self.file),
                 "operating_root": str(self.root), "restart": "./kwar --no-attach",
                 "note": "Supervisor가 기동하지 못해 외부 watchdog이 연 실행입니다. 기동 실패의 원인을 찾아 고치고 "
                         "(코드 결함이면 PR·머지·ff-only 반영), ./kwar --no-attach로 Supervisor를 다시 올린 뒤 "
                         "loaded_code_sha와 Line 재개를 확인하세요."}
        return text.replace("{{case_key}}", "supervisor").replace(
            "{{case_facts}}", json.dumps(facts, ensure_ascii=False, indent=2, default=str))

    # ---- operator commands --------------------------------------------------------------------------------------------
    def resume_case(self, case_id: int) -> bool:
        """The owner's answer to a `denied` wait: one kv flag the Supervisor consumes (no other row changes)."""
        try:
            conn = self._connect(write=True)
        except sqlite3.Error:
            return False
        try:
            with conn:
                if conn.execute("SELECT 1 FROM recovery_cases WHERE id=? AND state='WAITING_OWNER'", (case_id,)).fetchone() is None:
                    return False
                conn.execute("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                             (f"recovery_resume_{case_id}", str(self.clock())))
                return True
        finally:
            conn.close()


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("usage: recovery_watch.py <root> loop|once|status|resume <case-id>|pause|unpause", file=sys.stderr)
        return 2
    watch = Watch(Path(argv[0]))
    cmd = argv[1]
    if cmd == "once":
        print(watch.once())
        return 0
    if cmd == "loop":
        while True:
            try:
                result = watch.once()
                if result not in ("healthy", "paused", "held"):
                    print(f"[recovery] {time.strftime('%F %T')} {result}", file=sys.stderr)
            except Exception as e:   # the watchdog never dies of one bad iteration
                print(f"[recovery] iteration error: {type(e).__name__}: {e}", file=sys.stderr)
            time.sleep(INTERVAL)
    if cmd == "status":
        st = watch.status()
        print(json.dumps({"supervisor": {**st, "healthy": watch.healthy(st)}, "watchdog": watch.load(),
                          "paused": watch.paused_flag.exists()}, ensure_ascii=False, indent=2, default=str))
        return 0
    if cmd == "pause":
        watch.dir.mkdir(parents=True, exist_ok=True)
        watch.paused_flag.touch()
        return 0
    if cmd == "unpause":
        watch.paused_flag.unlink(missing_ok=True)
        return 0
    if cmd == "resume" and len(argv) == 3 and argv[2].isdigit():
        ok = watch.resume_case(int(argv[2]))
        print("resumed" if ok else "case is not WAITING_OWNER; nothing changed")
        return 0 if ok else 1
    print(f"unknown command: {' '.join(argv[1:])}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
