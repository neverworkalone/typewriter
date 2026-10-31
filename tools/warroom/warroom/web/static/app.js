"use strict";
// War Room Web UI: a second View over the shared Store. All data goes in with textContent (never innerHTML).
const $ = (id) => document.getElementById(id);
const app = $("app");
const mobile = window.matchMedia("(max-width: 900px)");
let board = null, view = null, timer = null, selection = {};

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

function toast(msg, bad) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "show" + (bad ? " err" : "");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.className = ""), 4000);
}

async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({ ok: false, error: "응답을 읽을 수 없습니다." }));
  if (!r.ok) throw Object.assign(new Error(data.error || "요청 실패"), { data });
  return data;
}

function ask(text) {
  return new Promise((resolve) => {
    const d = $("confirm");
    $("confirm-text").textContent = text;
    d.addEventListener("close", () => resolve(d.returnValue === "yes"), { once: true });
    d.returnValue = "no";
    d.showModal();
  });
}

async function send(body, confirmText) {
  try {
    if (confirmText && !(await ask(confirmText))) return;
    const r = await api("/api/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    toast(r.message || "완료");
  } catch (e) {
    toast(e.message, true);
  }
  tick();
}

const ATTENTION = { ERROR: 0, PAUSED: 1, CLEARING: 2, FIXING: 3, WAITING_REVIEW: 4, PRODUCING: 5, PREPARE: 6 };
const when = (ts) => (ts ? new Date(ts * 1000).toLocaleTimeString("ko-KR", { hour12: false }) : "-");
const lineName = (l) => `${l.model} / ${l.label}`;

// --- Board ---
function card(l) {
  const go = () => (location.hash = `#/line/${l.model}/${l.method}`);
  const name = l.method === "s2" ? `${l.owner_label} · ${l.label}` : l.label;
  if (l.idle) {
    return h("button", { class: "card empty", onclick: go },
      h("div", { class: "t" }, h("span", {}, name), h("span", { class: "s" }, l.idle_text)),
      l.wait ? h("div", { class: "s" }, "대기: " + l.wait) : null,
      (l.error || l.blocked) ? h("div", { class: "s" }, "⚠ " + (l.error || l.blocked)) : null);
  }
  const bar = h("div", { class: "bar2" }, h("i"));
  bar.firstChild.style.width = (l.progress_pct || 0) + "%";
  const batch = l.stage2 ? `S${l.stage2.shard} B${l.stage2.batch} P${l.stage2.part}` : l.batch;
  const title = l.method === "s2" ? `${l.owner_label} · ${l.label} · ${batch}`
    : (mobile.matches ? l.model + " · " : "") + l.label + " · " + batch;
  return h("button", { class: "card " + l.state, onclick: go },
    h("div", { class: "t" }, h("span", {}, title),
      h("span", {}, l.phase + (l.drain ? "+DRAIN" : "") + "  " + l.icon)),
    h("div", { class: "s" }, l.progress_text ? `${l.method === "s2" ? l.owner_label + " · " : ""}${l.progress_text}  ${l.progress_pct}%` : "진행량 확인 중"),
    l.progress_text ? bar : null,
    h("div", { class: "s" }, (l.pr ? `PR #${l.pr}` : "PR 생성 전") + (l.elapsed_text ? `  ·  경과 ${l.elapsed_text}` : "")),
    l.wait ? h("div", { class: "s" }, "대기: " + l.wait) : null,
    (l.error || l.blocked) ? h("div", { class: "s" }, "⚠ " + (l.error || l.blocked)) : null,
    l.activity ? h("div", { class: "s" }, `${when(l.activity[0])} ${l.activity[1]}`) : null);
}

function stage3Card() {
  return h("div", { class: "card stage3", "aria-disabled": "true" },
    h("div", { class: "t" }, h("span", {}, "Stage 3")),
    h("div", { class: "s" }, "감사 및 수정"),
    h("div", { class: "s" }, "비활성 자리"));
}

function maintainerCard(m) {
  const st = { IDLE: "empty", WORKING: "PRODUCING", ERROR: "ERROR" }[m.state];
  return h("div", { class: "card " + st },
    h("div", { class: "t" }, h("span", {}, "Maintainer"), h("span", {}, m.state === "IDLE" ? "—" : m.state)),
    h("div", { class: "s" }, m.state === "IDLE" ? "진행 중인 작업 없음" : m.text));
}

// The top bar is built once per controls config and kept (focus, open picker, chosen values survive every poll);
// only its buttons' enabled state is refreshed. Notes and the card grid are replaced on EVERY poll.
function controls(b) {
  const c = b.controls, sel = selection;
  const adapter = h("select", { "aria-label": "CLI" }, c.adapters.map((a) => h("option", { value: a.id }, a.label)));
  const model = h("select", { "aria-label": "모델" });
  const method = h("select", { "aria-label": "Method" });
  const mode = h("select", { "aria-label": "Mode" }, c.modes.map((m) => h("option", { value: m.id }, m.label)));
  const fill = () => {
    const a = c.adapters.find((x) => x.id === adapter.value) || c.adapters[0];
    model.replaceChildren(...a.models.map((m) => h("option", { value: m.id }, m.label)));
    method.replaceChildren(...a.methods.map((m) => h("option", { value: m.id }, m.label)));
    model.style.display = a.models.length > 1 ? "" : "none";
    if (sel.model && a.models.some((m) => m.id === sel.model)) model.value = sel.model;
    if (sel.method && a.methods.some((m) => m.id === sel.method)) method.value = sel.method;
  };
  if (sel.adapter) adapter.value = sel.adapter;
  fill();
  if (sel.mode) mode.value = sel.mode;
  adapter.addEventListener("change", () => { sel.adapter = adapter.value; sel.model = sel.method = null; fill(); });
  model.addEventListener("change", () => (sel.model = model.value));
  method.addEventListener("change", () => (sel.method = method.value));
  mode.addEventListener("change", () => (sel.mode = mode.value));
  const start = h("button", { class: "primary", onclick: () => send({ cmd: "start", model: model.value, method: method.value, mode: mode.value }) }, "Start");
  const drainAll = h("button", { onclick: () => send({ cmd: "drain_all" }) }, "Drain All");
  const stopAll = h("button", { class: "danger",
    onclick: () => send({ cmd: "stop_all", confirm: "stop-all" }, "모든 라인의 AI 실행을 즉시 중지합니다.") }, "Stop All");
  const el = h("div", { class: "bar", id: "controls" }, adapter, model, method, mode, start, drainAll, stopAll);
  el.refresh = (nb) => {
    start.disabled = drainAll.disabled = !nb.alive;
    stopAll.disabled = !nb.alive || !nb.can_stop_all;
  };
  return el;
}

let shell = null, controlsKey = "";
function renderBoard(b) {
  const key = JSON.stringify(b.controls);
  if (!shell || !app.contains(shell.controls) || key !== controlsKey) {   // first view, back from Detail, or config change
    controlsKey = key;
    shell = { controls: controls(b), notes: h("div"), grid: h("div") };
    app.replaceChildren(shell.controls, shell.notes, shell.grid);
  }
  shell.controls.refresh(b);
  const notes = [...b.notes, ...b.urgent.map((u) => u.text)];
  const grid = h("div", { class: "board" });
  if (mobile.matches) {
    const lines = b.lines.filter((l) => l.method !== "s2");
    const act = lines.filter((l) => !l.idle).sort((x, y) => (ATTENTION[x.state] ?? 9) - (ATTENTION[y.state] ?? 9));
    const idle = lines.filter((l) => l.idle);
    grid.append(...act.map(card));
    const roles = h("div", { class: "mobile-roles" },
      b.stage2_card ? card(b.stage2_card) : null,
      b.stage3_column ? stage3Card() : null,
      b.maintainer && b.maintainer.state !== "IDLE" ? maintainerCard(b.maintainer) : null);
    if (roles.childElementCount) grid.append(roles);
    if (idle.length) grid.append(h("details", { class: "idle" }, h("summary", {}, `빈 라인 ${idle.length}개`),
      h("div", { class: "board" }, idle.map(card))));
  } else {
    grid.style.setProperty("--cols", b.columns.length);
    for (const c of b.columns) {
      const stage1 = b.lines.filter((l) => l.model === c.id && l.method !== "s2").map(card);
      const roles = [
        b.stage2_card && b.stage2_card.column === c.id ? card(b.stage2_card) : null,
        b.stage3_column === c.id ? stage3Card() : null,
        b.maintainer && b.maintainer.column === c.id ? maintainerCard(b.maintainer) : null,
      ];
      const hasRole = roles.some(Boolean);
      grid.append(h("div", { class: "col" }, h("h2", {}, c.label), ...stage1,
        hasRole ? h("hr", { class: "stage-divider" }) : null, ...roles));
    }
  }
  const noteEl = h("div", notes.length ? { class: "notes" + (!b.alive ? " bad" : "") } : {}, notes.length ? notes.join("\n") : null);
  shell.notes.replaceWith(noteEl);
  shell.grid.replaceWith(grid);
  shell.notes = noteEl;
  shell.grid = grid;
}

// --- Detail ---
function openDetail(model, method) {
  const st = { source: "latest", raw: false, follow: true, cursor: null, key: null, run: null, runsKey: "" };
  const info = h("pre", { class: "info" }), meta = h("pre", { class: "info" });
  const log = h("div", { class: "log", tabindex: "0", role: "log" });
  const source = h("select", { "aria-label": "로그 종류" });
  const btn = (label, fn, cls) => h("button", { class: cls || "", onclick: fn }, label);
  const drain = btn("Drain", () => send({ cmd: "drain", model, method, on: !st.line.line_drain }));
  const stop = btn("Stop", () => send({ cmd: "stop", model, method, confirm: `${model}/${method}` },
    `${model} / ${st.line.label} 라인의 AI 실행을 즉시 중지합니다.`), "danger");
  const retry = btn("Retry", () => send({ cmd: "retry", model, method }));
  const clear = btn("Clear", () => send({ cmd: "clear", model, method, batch_id: st.line.batch_id, confirm: `${model}/${method}/${st.line.batch_id}` },
    `Clear — 미완료 배치를 포기합니다.\nproducer: ${model} · method: ${st.line.label} · batch: ${st.line.batch} (id ${st.line.batch_id})\n` +
    "AI를 중지하고 커밋되지 않은 변경, 소유 worktree·로컬 브랜치·실행 상태/이력·실행 파일을 삭제합니다."), "danger");
  const follow = btn("Auto-scroll: ON", () => { st.follow = !st.follow; follow.textContent = `Auto-scroll: ${st.follow ? "ON" : "OFF"}`; if (st.follow) log.scrollTop = log.scrollHeight; });
  const raw = btn("Raw Log", () => { st.raw = !st.raw; raw.textContent = st.raw ? "Readable Log" : "Raw Log"; reset(); pull(); });
  const reset = () => { st.cursor = null; st.run = null; log.replaceChildren(); };
  source.addEventListener("change", () => { st.source = source.value; reset(); pull(); });
  log.addEventListener("scroll", () => {
    const atEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 8;
    if (!atEnd && st.follow) { st.follow = false; follow.textContent = "Auto-scroll: OFF"; }
  });
  app.replaceChildren(h("div", { class: "detail" },
    btn("← Board", () => (location.hash = "#/")), info,
    h("details", {}, h("summary", {}, "Metadata / Details"), meta),
    h("div", { class: "bar" }, drain, stop, retry, clear, raw, follow), source, log));

  async function refresh() {
    const d = await api(`/api/line/${model}/${method}`);
    const l = (st.line = d.line);
    info.textContent = d.header; meta.textContent = d.meta;
    drain.textContent = l.line_drain ? "Cancel Drain" : "Drain";
    drain.disabled = !(l.can_drain || l.line_drain) || !board.alive;
    stop.disabled = !l.can_stop || !board.alive; retry.disabled = !l.can_retry || !board.alive;
    clear.disabled = !l.can_clear || !board.alive;
    const key = d.runs.map((r) => r.id + ":" + (r.ended_at ? 1 : 0)).join(",");
    if (key !== st.runsKey) {
      st.runsKey = key;
      source.replaceChildren(h("option", { value: "latest" }, "Agent Log — 최신 실행"), h("option", { value: "audit" }, "Audit Log"),
        d.runs.map((r) => h("option", { value: "run:" + r.id },
          `#${r.id} ${r.shard}_${r.batch} ${r.kind}${r.model ? " " + r.model + "/" + (r.effort || "") : ""} ${when(r.started_at)} ` +
          `exit=${r.ended_at ? r.exit_status : "running"}${r.log_exists ? "" : " (로그 없음)"}`)));
      source.value = st.source;
    }
  }
  async function pull() {
    const q = new URLSearchParams({ source: st.source });
    if (st.cursor != null) q.set("cursor", st.cursor);
    if (st.run != null) q.set("run", st.run);
    if (st.raw) q.set("raw", "1");
    const d = await api(`/api/line/${model}/${method}/log?${q}`);
    if (d.key !== st.key || d.reset) { st.key = d.key; log.replaceChildren(); }
    st.cursor = d.cursor; st.run = d.run_id ?? null;
    if (d.missing) { log.replaceChildren(h("div", { class: "miss" }, d.message)); st.key = null; return; }
    if (d.lines.length) {
      log.append(document.createTextNode(d.lines.join("\n") + "\n"));
      while (log.childNodes.length > 400) log.firstChild.remove();
      if (st.follow) log.scrollTop = log.scrollHeight;
    }
  }
  return async () => { await refresh(); await pull(); };
}

// --- loop ---
async function tick() {
  try {
    board = await api("/api/board");
    const on = board.alive;
    $("sup").textContent = on ? "Supervisor ONLINE" : "Supervisor OFFLINE";
    $("sup").className = "pill" + (on ? " on" : "");
    const m = location.hash.match(/^#\/line\/([a-z0-9-]+)\/([a-z0-9]+)$/);
    if (m) {
      if (!view || view.id !== m[0]) view = { id: m[0], step: openDetail(m[1], m[2]) };
      await view.step();
    } else {
      view = null;
      renderBoard(board);
    }
  } catch (e) {
    $("sup").textContent = "연결 끊김"; $("sup").className = "pill";
  }
}
window.addEventListener("hashchange", () => { view = null; tick(); });
mobile.addEventListener("change", () => { view = null; tick(); });
document.addEventListener("visibilitychange", () => document.hidden || tick());
setInterval(() => document.hidden || tick(), 2000);
tick();
