"""WAR ROOM / TYPEWRITER situation board (Textual). Pure view over the shared DB."""
from __future__ import annotations

import os
import subprocess
import sys

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Header, RichLog, Select, Static

from . import auth, control
from .config import Paths, load_config
from .store import Store

TMUX_SUP = "warroom-supervisor"


def ensure_supervisor(paths: Paths) -> str | None:
    """Start the detached supervisor in tmux if none holds the lock. Returns a problem or None."""
    from .supervisor import acquire_lock
    lock = acquire_lock(paths.lock)
    if lock is None:
        return None  # already running
    lock.close()
    if subprocess.run(["which", "tmux"], capture_output=True).returncode != 0:
        return "tmux가 설치되어 있지 않습니다: `brew install tmux` 후 다시 ./war 를 실행하세요."
    py = sys.executable
    wr = str(paths.repo_root / "tools" / "warroom")
    subprocess.run(["tmux", "kill-session", "-t", TMUX_SUP], capture_output=True)
    r = subprocess.run(["tmux", "new-session", "-d", "-s", TMUX_SUP, "-c", str(paths.repo_root),
                        f"env PYTHONPATH={wr} {py} -m warroom.supervisor"], capture_output=True, text=True)
    return None if r.returncode == 0 else f"supervisor tmux 시작 실패: {r.stderr.strip()}"


class Confirm(ModalScreen[bool]):
    def __init__(self, text: str):
        super().__init__()
        self.text = text

    def compose(self) -> ComposeResult:
        with Vertical(id="confirm"):
            yield Static(self.text)
            with Horizontal():
                yield Button("강제 중지", id="yes", variant="error")
                yield Button("취소", id="no")

    def on_button_pressed(self, e: Button.Pressed) -> None:
        self.dismiss(e.button.id == "yes")


class WarRoom(App):
    TITLE = "WAR ROOM / TYPEWRITER"
    CSS = """
    #confirm { width: 70; height: auto; padding: 1 2; border: thick $error; background: $surface; margin: 4 8; }
    #status, #settings { border: round $accent; padding: 0 1; height: auto; }
    #controls { height: auto; }
    RichLog { border: round $primary; height: 1fr; }
    """
    BINDINGS = [("q", "quit", "Quit (워커는 계속 실행)")]

    def __init__(self):
        super().__init__()
        self.paths = Paths()
        self.paths.ensure()
        self.cfg = load_config(self.paths)
        self.store = Store(self.paths.db)
        self.problem = ensure_supervisor(self.paths)
        self._seen = 0
        self._auth: dict | None = None

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(id="status")
        with Horizontal(id="controls"):
            yield Select([("OpenCode / A (DeepSeek)", "opencode-a")], value="opencode-a",
                         allow_blank=False, id="worker")
            yield Select([("Single batch", "single"), ("Continuous", "continuous")],
                         value=self.store.get("mode", "single"), allow_blank=False, id="mode")
            yield Button("Start", id="start", variant="success")
            yield Button("Stop after current batch", id="stop")
            yield Button("Retry", id="retry")
            yield Button("Force stop…", id="force", variant="error")
        yield Static(id="settings")
        yield RichLog(id="log", wrap=True, markup=False)
        yield Footer()

    def on_mount(self) -> None:
        self.set_interval(1.0, self.refresh_view)
        self.run_worker(self.check_auth, thread=True)
        self.refresh_view()

    def check_auth(self) -> None:
        from .shell import Runner
        env = auth.build_env(dict(os.environ), self.paths.gh_config,
                             self.cfg["git_name"], self.cfg["git_email"])
        self._auth = auth.diagnose(Runner(), env, self.cfg["repo"], self.cfg["expected_account"])

    def refresh_view(self) -> None:
        s = control.status(self.store)
        lines = [f"State: {s['state']}    Mode: {s['mode']}    "
                 f"Supervisor: {'running' if s['supervisor'] else 'NOT RUNNING'}"
                 f"{'    (stop after current batch)' if s['stop_after'] else ''}"]
        if "batch" in s:
            lines.append(f"Batch: {s['batch']}  branch: {s['branch']}")
            lines.append(f"PR: {s['pr'] or '-'}  HEAD: {(s['head'] or '-')[:12]}  session: {s['session'] or '-'}")
            if "progress" in s:
                lines.append(f"Progress: {s['progress']}")
        if s["error"]:
            lines.append(f"ERROR/PAUSED: {s['error']}")
        if s["blocked"]:
            lines.append(f"BLOCKED: {s['blocked']}")
        if self.problem:
            lines.append(f"! {self.problem}")
        self.query_one("#status", Static).update("\n".join(lines))
        a = self._auth
        acct = "확인 중…" if a is None else (a["account"] or "인증 안 됨")
        probs = "" if not a or a["ok"] else "\n  " + "\n  ".join(a["problems"])
        self.query_one("#settings", Static).update(
            f"Settings — GitHub: {acct} (기대: {self.cfg['expected_account']})  "
            f"Model tier: {s['tier']}  free={self.cfg['models']['free'] or '(opencode 기본)'}  "
            f"go={self.cfg['models']['go'] or '(미설정)'}{probs}\n"
            f"  로그인: GH_CONFIG_DIR={self.paths.gh_config} gh auth login   설정: {self.paths.config_file}")
        log = self.query_one("#log", RichLog)
        for ev in self.store.recent_events(200):
            if ev["id"] > self._seen:
                self._seen = ev["id"]
                log.write(f"{ev['level'].upper():5} {ev['msg']}")

    def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "start":
            control.start(self.store, str(self.query_one("#mode", Select).value))
        elif e.button.id == "stop":
            control.stop_after_current(self.store)
        elif e.button.id == "retry":
            control.retry(self.store)
        elif e.button.id == "force":
            self.push_screen(Confirm("즉시 강제 중지합니다. 진행 중인 AI 작업이 끊기고 미완료 worktree는 "
                                     "보존됩니다(Retry로 재개). 계속할까요?"), self._forced)

    def _forced(self, yes: bool | None) -> None:
        if yes:
            control.force_stop(self.store)


def main() -> None:
    WarRoom().run()


if __name__ == "__main__":
    main()
