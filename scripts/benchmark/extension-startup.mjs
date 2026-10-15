import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [extDir, label, portArg = '9340', reopens = '4'] = process.argv.slice(2);
const CHROME = process.env.TYPEWRITER_CFT || process.env.HOME
  + '/git/neverworkalone/codex/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const port = Number(portArg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--no-first-run', '--disable-gpu',
  '--disable-extensions-except=' + extDir, '--load-extension=' + extDir,
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + mkdtempSync(path.join(os.tmpdir(), 'tw-prof-')), 'about:blank',
], { stdio: 'ignore' });

async function version() {
  for (let i = 0; i < 150; i++) {
    try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(100); }
  }
  throw new Error('no devtools');
}
const v = await version();
const ws = new WebSocket(v.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
});
const cmd = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const i = ++id; pending.set(i, { resolve, reject });
  ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const evalIn = async (sessionId, expression) => (await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)).result?.value;

// Extension ID via chrome://extensions
const mgr = await cmd('Target.createTarget', { url: 'chrome://extensions/' });
const ms = (await cmd('Target.attachToTarget', { targetId: mgr.targetId, flatten: true })).sessionId;
await cmd('Runtime.enable', {}, ms);
await cmd('DOM.enable', {}, ms);
let extId = null;
for (let i = 0; i < 100 && !extId; i++) {
  const { root } = await cmd('DOM.getDocument', { depth: -1, pierce: true }, ms);
  const visit = (n) => {
    if (n.nodeName?.toLowerCase() === 'extensions-item') {
      const a = n.attributes || []; const idx = a.indexOf('id');
      if (idx >= 0 && /^[a-p]{32}$/.test(a[idx + 1])) extId = a[idx + 1];
    }
    [...(n.children || []), ...(n.shadowRoots || [])].forEach(visit);
    if (n.contentDocument) visit(n.contentDocument);
  };
  visit(root);
  if (!extId) await sleep(100);
}
if (!extId) throw new Error('no extension id');

async function poll(sessionId, expr, timeout = 30000) {
  const t = Date.now();
  while (Date.now() - t < timeout) {
    if (await evalIn(sessionId, expr)) return Date.now() - t;
    await sleep(5);
  }
  throw new Error('timeout ' + expr);
}

async function openPopup() {
  const t0 = performance.now();
  const target = await cmd('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
  const sessionId = (await cmd('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await cmd('Runtime.enable', {}, sessionId);
  await poll(sessionId, 'Boolean(document.querySelector("[data-runtime-source-revision]"))');
  const ready = performance.now() - t0;
  const t1 = performance.now();
  await evalIn(sessionId, `(() => { const i = document.querySelector('[aria-label="검색어"]'); i.value = '담담'; i.dispatchEvent(new Event('input',{bubbles:true})); i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true})); return true; })()`);
  await poll(sessionId, 'Boolean(document.querySelector("[data-dictionary-record]"))');
  const search = performance.now() - t1;
  return { target, ready: Math.round(ready), search: Math.round(search) };
}

const rows = [];
const first = await openPopup();
rows.push({ phase: 'first open (cold)', ...first });
await cmd('Target.closeTarget', { targetId: first.target.targetId });
for (let i = 1; i <= Number(reopens); i++) {
  await sleep(500);
  if (process.env.KILL_SW) { const { targetInfos } = await cmd('Target.getTargets'); for (const t of targetInfos.filter((x) => x.type === 'service_worker')) await cmd('Target.closeTarget', { targetId: t.targetId }); await sleep(300); }
  const r = await openPopup();
  rows.push({ phase: `reopen #${i}`, ...r });
  await cmd('Target.closeTarget', { targetId: r.target.targetId });
}
console.log(JSON.stringify({ label, rows: rows.map(({ phase, ready, search }) => ({ phase, ready_ms: ready, search_ms: search })) }));
ws.close(); child.kill('SIGTERM');
