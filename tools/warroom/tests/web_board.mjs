// Issue #1720 regression (run by tests/test_web_board_js.py): the real static/app.js must refresh cards, notes and
// button state on every poll even while a top-bar <select> keeps focus, and must keep the person's choices.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const root = new URL('../warroom/web/static/', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8').replace(/<script[^>]*><\/script>/, '');
const js = readFileSync(new URL('app.js', root), 'utf8');

const CONTROLS = {
  adapters: [{ id: 'claude', label: 'Claude', models: [{ id: 'claude', label: 'Claude (claude)' }],
    methods: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 's2', label: 'Stage 2' }] },
  { id: 'opencode', label: 'OpenCode', models: [{ id: 'ds', label: 'DeepSeek (ds)' }], methods: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }],
  modes: [{ id: 'single', label: 'Single' }, { id: 'continuous', label: 'Continuous' }],
};
const line = (method, o = {}) => ({ model: 'claude', method, label: method.toUpperCase(), idle: true, idle_text: '실행 이력 없음', state: 'IDLE',
  batch: null, drain: false, ...o });
const active = (method, state, o = {}) => line(method, { idle: false, state, batch: '001_01', phase: state, icon: '▶', pr: null,
  progress_text: '10 / 500 records', progress_pct: 2, elapsed_text: '1분', error: null, activity: null, ...o });
const snap = (alive, lines, extra = {}) => ({ alive, notes: alive ? [] : ['Supervisor가 실행 중이 아닙니다(OFFLINE).'], draining: [], urgent: [],
  columns: [{ id: 'claude', label: 'Claude' }], lines, maintainer: null, can_stop_all: true, controls: CONTROLS, ...extra });

async function boot(width) {
  let current = snap(true, []);
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost:8000/' });
  const w = dom.window;
  w.matchMedia = () => ({ matches: width <= 900, addEventListener() {} });
  w.fetch = async () => ({ ok: true, json: async () => current });
  w.eval(js + '\n;window.__tick = tick;');
  await w.__tick();
  return { w, set: (s) => (current = s), tick: () => w.__tick(), $: (q) => w.document.querySelector(q), $$: (q) => [...w.document.querySelectorAll(q)] };
}
const cards = (t) => t.$$('.card').map((c) => c.className.replace('card ', ''));

for (const [name, width] of [['desktop', 1400], ['mobile', 375]]) {
  const t = await boot(width);
  t.set(snap(true, [active('a', 'PRODUCING'), line('b')]));
  await t.tick();
  assert.ok(cards(t).includes('PRODUCING'), `${name}: initial card`);
  assert.equal(t.$('#controls button.danger').disabled, false);

  // the person picks a method and leaves the <select> focused
  const method = t.$$('#controls select')[2];
  method.value = 'b';
  method.dispatchEvent(new t.w.Event('change'));
  method.focus();
  assert.equal(t.w.document.activeElement, method);

  // OFFLINE + ERROR + a new urgent note arrive while the select still has focus
  t.set(snap(false, [active('a', 'ERROR', { error: 'boom' }), line('b')], { urgent: [{ text: 'urgent issue #9 · 수정 중', bad: false }] }));
  await t.tick();
  assert.deepEqual(cards(t).filter((c) => c !== 'empty'), ['ERROR'], `${name}: card updated under focus`);
  assert.match(t.$('.notes').textContent, /OFFLINE[\s\S]*urgent issue #9/, `${name}: notes updated under focus`);
  assert.ok(t.$$('#controls button').every((b) => b.disabled), `${name}: buttons disabled while OFFLINE`);
  assert.equal(t.w.document.activeElement, method, `${name}: focus kept`);
  assert.equal(method.value, 'b', `${name}: chosen Method kept`);

  // back ONLINE, another Line pauses; focus released: still renders, controls enabled again
  method.blur();
  t.set(snap(true, [active('a', 'PRODUCING'), line('b', { ...active('b', 'PAUSED') })]));
  await t.tick();
  assert.deepEqual(cards(t).filter((c) => c !== 'empty').sort(), ['PAUSED', 'PRODUCING']);
  assert.equal(t.$('.notes'), null, `${name}: stale notes cleared`);
  assert.equal(t.$('#controls button.primary').disabled, false);
  assert.equal(t.$$('#controls select')[2].value, 'b', `${name}: Method kept after blur`);
  assert.equal(t.$$('#controls select').length, 4, `${name}: controls not duplicated`);
}

const s2 = await boot(1400);
s2.set(snap(true, [active('s2', 'PRODUCING', { label: 'Stage 2', batch: '001_01-03',
  stage2: { shard: '001', batch: '01', part: '03' }, progress_text: '15 / 100 candidates', progress_pct: 15 })]));
await s2.tick();
const s2card = s2.$('.card.PRODUCING');
assert.match(s2card.textContent, /Stage 2 · S001 B01 P03/);
assert.match(s2card.textContent, /15 \/ 100 candidates  15%/);
assert.equal(s2card.querySelector('.bar2 i').style.width, '15%');
console.log('web_board ok');
process.exit(0);   // the page's poll timer would otherwise keep Node alive
