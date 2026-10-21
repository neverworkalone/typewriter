"""WAR ROOM / TYPEWRITER situation board (Textual). Pure view over the shared DB."""
from __future__ import annotations

import os
import subprocess
import sys

from textual.app import App, ComposeResult
from textual.containers import Horizontal, HorizontalScroll, Vertical
from textual.screen import ModalScreen, Screen
from textual.widgets import Button, Footer, Header, RichLog, Select, Static

import time

from . import auth, control
from .config import Paths, load_config, methods, registry
from .logtail import LogTail, redact
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


def _hhmm(ts) -> str:
    return time.strftime("%H:%M:%S", time.localtime(ts)) if ts else "-"


def card_text(st: dict) -> str:
    """Card = Line summary; DRAIN is spelled out (never colour-only)."""
    m = st["method"].upper()
    if st["batch"] is None:
        return f"{m}  (비어 있음)"
    phase = st["state"] + (" + DRAIN" if st["drain"] else "")
    prog = st["progress"] or (f"PR #{st['pr']}" if st["pr"] else "진행량 미확인")
    if st["progress"] and st["pr"]:
        prog += f"  PR #{st['pr']}"
    act = f"{_hhmm(st['activity'][0])} {st['activity'][1]}"[:48] if st["activity"] else "-"
    mode = "Multi" if st["mode"] == "continuous" else "Single"
    return f"{m}  {st['batch']}  [{mode}]\n{phase}\n{prog}\n{act}"


class Confirm(ModalScreen[bool]):
    """y/N confirmation. Enter, N and Esc all mean No."""
    BINDINGS = [("y", "answer(True)", "Yes"), ("n", "answer(False)", "No"),
                ("escape", "answer(False)", "Cancel")]

    def __init__(self, text: str):
        super().__init__()
        self.text = text

    def compose(self) -> ComposeResult:
        with Vertical(id="confirm"):
            yield Static(self.text)
            with Horizontal():
                yield Button("Yes (Y)", id="yes", variant="error")
                yield Button("No (N)", id="no", variant="primary")

    def on_mount(self) -> None:
        self.query_one("#no", Button).focus()

    def action_answer(self, yes: bool) -> None:
        self.dismiss(yes)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        e.stop()
        self.dismiss(e.button.id == "yes")


class Card(Static, can_focus=True):
    """One Line. Clicking (or Enter) only opens its detail; it never starts or changes work."""
    BINDINGS = [("enter", "open", "Open")]

    def __init__(self, model: str, method: str):
        super().__init__("", id=f"card-{model}-{method}", classes="card")
        self.model, self.method = model, method

    def on_click(self) -> None:
        self.action_open()

    def action_open(self) -> None:
        self.app.push_screen(LineDetail(self.model, self.method))


class SettingsScreen(Screen):
    BINDINGS = [("escape", "app.pop_screen", "Back")]

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(id="settings-body")
        yield Footer()

    def on_mount(self) -> None:
        self.set_interval(1.0, self.refresh_view)
        self.refresh_view()

    def refresh_view(self) -> None:
        app, a = self.app, self.app._auth
        acct = "확인 중…" if a is None else (a["account"] or "인증 안 됨")
        probs = "" if not a or a["ok"] else "\n  " + "\n  ".join(a["problems"])
        lines = [f"Settings — GitHub: {acct} (기대: {app.cfg['expected_account']}){probs}",
                 f"  로그인: GH_CONFIG_DIR={app.paths.gh_config} gh auth login   설정: {app.paths.config_file}", ""]
        for pid, p in registry(app.cfg).items():
            lines.append(f"{p['label']} ({pid})  adapter={p['adapter']}  free={p['models']['free'] or '(미설정)'}  "
                         f"go={p['models']['go'] or '(미설정)'}")
        self.query_one("#settings-body", Static).update("\n".join(lines))


class LineDetail(Screen):
    """Batch Detail for one Line: controls, live Agent Log (tail -f), Run History, Audit Log."""
    BINDINGS = [("escape", "back", "Back"), ("f", "follow", "Follow"), ("up", "scroll_up", ""),
                ("pageup", "page_up", ""), ("home", "top", ""), ("end", "follow", "")]

    def __init__(self, model: str, method: str):
        super().__init__()
        self.model, self.method = model, method
        self.tail = LogTail(None)
        self.audit_seen = 0
        self.source = "latest"      # latest | audit | run:<id>
        self._run_ids: tuple = ()
        self._shown_path = None

    def compose(self) -> ComposeResult:
        yield Header()
        yield Static(id="info")
        with Horizontal(id="line-controls"):
            yield Button("Drain", id="drain")
            yield Button("Stop", id="stop", variant="error")
            yield Button("Retry", id="retry")
            yield Button("Follow: ON", id="follow")
            yield Button("Back (Esc)", id="back")
        yield Select([("Agent Log — 최신 실행", "latest"), ("Audit Log", "audit")], value="latest",
                     allow_blank=False, id="source")
        yield RichLog(id="agentlog", wrap=True, markup=False, highlight=False, max_lines=5000)
        yield Footer()

    def on_mount(self) -> None:
        self.set_interval(1.0, self.refresh_view)
        self.refresh_view()

    @property
    def log_w(self) -> RichLog:
        return self.query_one("#agentlog", RichLog)

    # --- log following ---
    def _set_follow(self, on: bool) -> None:
        self.log_w.auto_scroll = on
        self.query_one("#follow", Button).label = f"Follow: {'ON' if on else 'OFF'}"
        if on:
            self.log_w.scroll_end(animate=False)

    def action_follow(self) -> None:
        self._set_follow(True)

    def action_scroll_up(self) -> None:
        self._set_follow(False)
        self.log_w.scroll_up()

    def action_page_up(self) -> None:
        self._set_follow(False)
        self.log_w.scroll_page_up()

    def action_top(self) -> None:
        self._set_follow(False)
        self.log_w.scroll_home(animate=False)

    def on_mouse_scroll_up(self, event) -> None:
        self._set_follow(False)

    def action_back(self) -> None:
        self.app.pop_screen()

    # --- sources ---
    def _runs(self):
        return self.app.store.line_runs(self.model, self.method)

    def _run_path(self, runs):
        if self.source.startswith("run:"):
            rid = int(self.source[4:])
            return next((r["log_file"] for r in runs if r["id"] == rid), None)
        return runs[0]["log_file"] if runs else None

    def _switch(self, source: str) -> None:
        self.source = source
        self.log_w.clear()
        self.audit_seen, self._shown_path = 0, None
        self.tail = LogTail(None)

    def on_select_changed(self, e: Select.Changed) -> None:
        if e.select.id == "source" and e.value != self.source and e.value is not Select.BLANK:
            self._switch(str(e.value))

    def _sync_sources(self, runs) -> None:
        ids = tuple(r["id"] for r in runs)
        if ids == self._run_ids:
            return
        self._run_ids = ids
        opts = [("Agent Log — 최신 실행", "latest"), ("Audit Log", "audit")]
        for r in runs:
            st = r["exit_status"] if r["ended_at"] else "running"
            opts.append((f"#{r['id']} {r['shard']}_{r['batch']} {r['kind']} {_hhmm(r['started_at'])} exit={st}",
                         f"run:{r['id']}"))
        sel = self.query_one("#source", Select)
        with sel.prevent(Select.Changed):
            sel.set_options(opts)
            sel.value = self.source if any(o[1] == self.source for o in opts) else "latest"

    def _pump_log(self, runs) -> None:
        log = self.log_w
        if self.source == "audit":
            for ev in self.app.store.line_events(self.model, self.method, self.audit_seen):
                self.audit_seen = ev["id"]
                log.write(f"{_hhmm(ev['ts'])} {ev['level'].upper():5} {redact(ev['msg'])}")
            return
        path = self._run_path(runs)
        if path != self._shown_path:        # new latest run (or none yet): follow it from its start
            self._shown_path = path
            self.tail = LogTail(path)
            if path and self.source == "latest":
                log.clear()
        for line in self.tail.read():
            log.write(line)

    # --- view ---
    def refresh_view(self) -> None:
        st = control.line_status(self.app.store, self.model, self.method)
        reg = registry(self.app.cfg).get(self.model, {})
        info = [f"{reg.get('label', self.model)} ({self.model}) / adapter={reg.get('adapter', '?')} / "
                f"Method {self.method.upper()} / tier={st['tier']}",
                f"Batch: {st['batch'] or '-'}  phase: {st['state']}{' + DRAIN' if st['drain'] else ''}"
                f"{' (전역 Drain)' if st['global_drain'] else ''}  "
                f"mode: {'Multi' if st['mode'] == 'continuous' else 'Single'}  "
                f"예약 실행: {'on' if st['run'] else 'off'}",
                f"PR: {st['pr'] or '-'}  HEAD: {(st['head'] or '-')[:12]}  session: {st['session'] or '-'}  "
                f"progress: {st['progress'] or '미확인'}",
                f"worktree: {st['worktree'] or '-'}"]
        if st["activity"]:
            info.append(f"직전 활동: {_hhmm(st['activity'][0])} {st['activity'][1]}")
        if st["error"]:
            info.append(f"ERROR/PAUSED 사유: {st['error']}")
        if st["blocked"]:
            info.append(f"BLOCKED: {st['blocked']}")
        self.query_one("#info", Static).update("\n".join(info))
        d = self.query_one("#drain", Button)
        d.label = "Cancel Drain" if st["line_drain"] else "Drain"
        d.disabled = not (st["can_drain"] or st["line_drain"])
        self.query_one("#stop", Button).disabled = not st["can_stop"]
        self.query_one("#retry", Button).disabled = not st["can_retry"]
        runs = self._runs()
        self._sync_sources(runs)
        self._pump_log(runs)

    def on_button_pressed(self, e: Button.Pressed) -> None:
        e.stop()
        store, m, me = self.app.store, self.model, self.method
        if e.button.id == "back":
            self.action_back()
        elif e.button.id == "follow":
            self._set_follow(not self.log_w.auto_scroll)
        elif e.button.id == "drain":
            control.set_drain(store, m, me, not bool(store.line(m, me)["drain"]))
        elif e.button.id == "retry":
            control.retry(store, m, me)
        elif e.button.id == "stop":
            self.app.push_screen(Confirm(
                f"{m} / Method {me.upper()} 라인만 AI 실행을 즉시 중지합니다.\n"
                "다른 라인은 영향 없음. worktree·브랜치·PR은 보존되며 Retry로 재개할 수 있습니다.\n"
                "중지하시겠습니까? (Y/N, 기본 N)"), self._stopped)

    def _stopped(self, yes: bool | None) -> None:
        if yes:
            control.stop_line(self.app.store, self.model, self.method)


class WarRoom(App):
    TITLE = "WAR ROOM / TYPEWRITER"
    CSS = """
    #confirm { width: 70; height: auto; padding: 1 2; border: thick $error; background: $surface; margin: 4 8; }
    #banner { height: auto; color: $error; }
    #factory-status { height: auto; }
    #controls, #factory, #line-controls { height: auto; }
    #columns { height: 1fr; }
    .col { width: 38; min-width: 30; height: auto; margin: 0 1; }
    .coltitle { text-style: bold; }
    .card { border: round $primary; height: 6; padding: 0 1; }
    .card:focus { border: heavy $accent; }
    .card.ERROR, .card.PAUSED { border: round $error; }
    .card.COMPLETE { border: round $success; }
    .card.empty { border: dashed $primary-darken-2; color: $text-muted; }
    #info { border: round $accent; padding: 0 1; height: auto; }
    #settings-body { padding: 1 2; }
    RichLog { border: round $primary; height: 1fr; }
    """
    BINDINGS = [("q", "quit", "Quit (워커는 계속 실행)"), ("s", "settings", "Settings")]

    def __init__(self):
        super().__init__()
        self.paths = Paths()
        self.paths.ensure()
        self.cfg = load_config(self.paths)
        self.store = Store(self.paths.db)
        self.problem = ensure_supervisor(self.paths)
        self._auth: dict | None = None
        reg = registry(self.cfg)
        self.models = list(reg)
        self.methods = methods(self.cfg)

    def _lines(self):
        """Columns come from the registry (+ models that still own history), never a fixed 3."""
        known = set(self.models)
        extra = sorted({ln["model"] for ln in self.store.lines()} - known)
        return self.models + extra

    def compose(self) -> ComposeResult:
        reg = registry(self.cfg)
        adapters = sorted({p["adapter"] for p in reg.values()})
        first = next(iter(reg.values()), {"adapter": "opencode"})
        yield Header()
        yield Static(id="banner")
        with Horizontal(id="controls"):
            yield Select([(a, a) for a in adapters], value=first["adapter"], allow_blank=False, id="adapter")
            yield Select(self._model_options(first["adapter"]), allow_blank=False, id="model")
            yield Select([(m.upper(), m) for m in self.methods], allow_blank=False, id="method")
            yield Select([("Single — 배치 1개 후 종료", "single"),
                          ("Multi — 같은 라인 배치를 순차 연속", "continuous")],
                         value="single", allow_blank=False, id="mode")
            yield Button("Start", id="start", variant="success")
        with Horizontal(id="factory"):
            yield Button("Drain All", id="drain-all")
            yield Button("Stop All", id="stop-all", variant="error")
            yield Static(id="factory-status")
        with HorizontalScroll(id="columns"):
            for model in self._lines():
                with Vertical(classes="col", id=f"col-{model}"):
                    yield Static(model, classes="coltitle", id=f"title-{model}")
                    for me in self.methods:
                        yield Card(model, me)
        yield Footer()

    def _model_options(self, adapter: str):
        return [(f"{p['label']} ({pid})", pid) for pid, p in registry(self.cfg).items()
                if p["adapter"] == adapter]

    def on_mount(self) -> None:
        self.set_interval(1.0, self.refresh_view)
        self.run_worker(self.check_auth, thread=True)
        self.refresh_view()

    def on_select_changed(self, e: Select.Changed) -> None:
        if e.select.id == "adapter" and e.value is not Select.BLANK:
            sel = self.query_one("#model", Select)
            sel.set_options(self._model_options(str(e.value)))

    def check_auth(self) -> None:
        from .shell import Runner
        env = auth.build_env(dict(os.environ), self.paths.gh_config,
                             self.cfg["git_name"], self.cfg["git_email"])
        self._auth = auth.diagnose(Runner(), env, self.cfg["repo"], self.cfg["expected_account"])

    def action_settings(self) -> None:
        self.push_screen(SettingsScreen())

    def refresh_view(self) -> None:
        store = self.store
        gd = control.global_drain(store)
        alive = control.supervisor_alive(store)
        statuses = {}
        for model in self._lines():
            for me in self.methods:
                st = statuses[(model, me)] = control.line_status(store, model, me)
                try:
                    card = self.query_one(f"#card-{model}-{me}", Card)
                except Exception:
                    continue
                card.update(card_text(st))
                card.set_classes("card " + (st["state"] if st["batch"] else "empty"))
        active = [s for s in statuses.values() if s["occupied"]]
        self.query_one("#factory-status", Static).update(
            f"Supervisor: {'running' if alive else 'NOT RUNNING'}   진행 라인 {len(active)}/{len(statuses)}   "
            f"{'DRAIN ALL: 모든 라인 신규 배치 중지' if gd else ''}")
        b = self.query_one("#drain-all", Button)
        b.label = "Cancel Drain" if gd else "Drain All"
        # Only auth/model problems surface on the board.
        a, notes = self._auth, []
        if a is not None and not a["ok"]:
            notes += ["! GitHub 인증: " + "; ".join(a["problems"]) + "  ('s' Settings)"]
        notes += [f"! {s['model']}/{s['method'].upper()} BLOCKED: {s['blocked']}"
                  for s in statuses.values() if s["blocked"]]
        if self.problem:
            notes.append(f"! {self.problem}")
        self.query_one("#banner", Static).update("\n".join(notes))

    def on_button_pressed(self, e: Button.Pressed) -> None:
        if e.button.id == "start":
            model, me = self.query_one("#model", Select).value, self.query_one("#method", Select).value
            if Select.BLANK in (model, me):
                return self.notify("모델과 Method를 선택하세요.", severity="warning")
            ok, msg = control.start(self.store, str(model), str(me),
                                    str(self.query_one("#mode", Select).value))
            if not ok:
                self.notify(msg, severity="warning")
        elif e.button.id == "drain-all":
            control.set_drain_all(self.store, not control.global_drain(self.store))
        elif e.button.id == "stop-all":
            n = len(self.store.incomplete_batches())
            self.push_screen(Confirm(
                f"모든 라인({len(self._lines()) * len(self.methods)}개 중 미완료 배치 {n}개)의 AI 실행을 즉시 "
                "중지합니다. 모든 라인의 예약 실행이 해제되며 worktree·브랜치·PR은 보존됩니다(Retry로 재개).\n"
                "중지하시겠습니까? (Y/N, 기본 N)"), self._stopped_all)

    def _stopped_all(self, yes: bool | None) -> None:
        if yes:
            control.stop_all(self.store)


def main() -> None:
    WarRoom().run()


if __name__ == "__main__":
    main()
