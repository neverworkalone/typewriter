import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { InvalidCursorError, openReadonlyDb, searchContexts } from './corpus-utility.mjs';

import {
  autoZCandidate,
  buildChunk,
  buildSearchBatch,
  checkDecisions,
  hadaPrefetchForms,
  parseDecisions,
  prepareChunk,
  recordEvidence,
  recordedCondition,
  resolveRecordedCursor,
  saveActive,
  searchActive,
  searchBatchActive,
  searchForContexts,
} from './d-chunk-cli.mjs';

const SYLLABLES = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차'];
const filler = (n) => `${SYLLABLES[n % 10]}${SYLLABLES[Math.floor(n / 10) % 10]}${SYLLABLES[Math.floor(n / 100) % 10]}${SYLLABLES[(n + 3) % 10]}쿠`;

const rec = (id, lemma, senses, extra = {}) => ({
  id, record_type: 'entry', role: 'start', candidate_id: id, lemma, search_forms: [lemma],
  senses: senses.map(([pos, gloss], index) => ({ id: `${id}-s${index + 1}`, pos, gloss })), source: 'stdict', ...extra,
});

const cursorEvidence = (recordId, forms, boundary, cursorOut, cursorIn = null) => ({
  record_id: recordId, key: JSON.stringify([forms, boundary ?? null]), forms, boundary: boundary ?? null,
  status: 'LIMITED', hits: 1, complete: false, cursor_in: cursorIn, cursor_out: cursorOut, source: 'search',
});
const evidenceSummary = (entries, recordId) => {
  const { searches, hits, allComplete } = recordEvidence(entries, recordId);
  return { searches, hits, allComplete };
};

// Chunk 1 holds the special records; chunk 2..20 are all-automatic fillers.
const SPECIAL = [
  rec('w001', '새벽안개', [['noun', '새벽에 끼는 안개.'], ['noun', '비유적으로 흐릿함.']]),
  rec('w002', '존재않는명사', [['noun', '코퍼스에 없는 말.']]),
  rec('w003', '달리다', [['verb', '빨리 움직이다.']]),
  rec('w004', '핫', [['noun', '한 글자 표제어.']]),
  rec('w005', '기회비용', [['noun', '어떤 선택으로 포기한 이익.']]),
];

function canonicalRows() {
  const rows = [...SPECIAL];
  for (let n = rows.length; n < 500; n += 1) rows.push(rec(`w${String(n + 1).padStart(3, '0')}`, filler(n), [['noun', `채움 ${n}.`]]));
  return rows;
}

async function makeWorld({ fillerParagraphs = 2000 } = {}) {
  const root = await mkdtemp(path.join((await mkdir(path.resolve('.warroom-scratch'), { recursive: true })) ?? path.resolve('.warroom-scratch'), 'd-chunk-'));
  const canonicalPath = path.join(root, 'stdict-0001.jsonl');
  await writeFile(canonicalPath, `${canonicalRows().map((row) => JSON.stringify(row)).join('\n')}\n`);
  const databasePath = path.join(root, 'corpus.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE source_files (source_path TEXT PRIMARY KEY, title TEXT, creator TEXT, year TEXT, category TEXT);
    CREATE TABLE documents (document_rowid INTEGER PRIMARY KEY, source_path TEXT, document_id TEXT, document_ordinal INTEGER, title TEXT, author TEXT);
    CREATE TABLE paragraphs (paragraph_rowid INTEGER PRIMARY KEY, document_rowid INTEGER, paragraph_id TEXT, ordinal INTEGER, form TEXT);
    CREATE VIRTUAL TABLE paragraph_fts USING fts5(form, content='paragraphs', content_rowid='paragraph_rowid', tokenize='trigram');
    CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO index_metadata VALUES ('schema_version', '1'), ('input_manifest_sha256', '${'a'.repeat(64)}');
    INSERT INTO source_files VALUES ('s', 't', 'c', '2000', 'x');
    INSERT INTO documents VALUES (1, 's', 'd', 1, '합성 문서', '합성 저자');
  `);
  const corpus = [
    '새벽안개가 마을을 덮었다.', '아침의 새벽안개는 차갑다.', '그는 기회 비용을 따져 보았다.',
    // A small real FTS fixture needs multiple page budgets so prepare can complete a multi-form zero search.
    ...Array.from({ length: fillerParagraphs }, (_, index) => `시험용 문단 ${index}.`),
  ];
  corpus.forEach((form, index) => {
    database.prepare('INSERT INTO paragraphs VALUES (?, 1, ?, ?, ?)').run(index + 1, `p${index}`, index, form);
    database.prepare('INSERT INTO paragraph_fts(rowid, form) VALUES (?, ?)').run(index + 1, form);
  });
  database.close();
  const directory = path.join(root, 'd-001_01');
  const options = { canonicalPath, shard: '001', batch: '01', databasePath, model: 'codex', head: 'a'.repeat(40), directory };
  return { root, directory, options };
}

const withWorld = (name, body) => test(name, async () => {
  const world = await makeWorld();
  try {
    await body(world);
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

const runCli = (args, input, environment) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.resolve('scripts/relation/d-chunk-cli.mjs'), ...args], {
    cwd: process.cwd(), env: { ...process.env, ...environment }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ code, stdout, stderr }));
  child.stdin.end(input);
});

const chunkPath = (world, kind, number = 1) => path.join(world.directory, {
  active: `active-${String(number).padStart(3, '0')}.json`,
  view: `view-${String(number).padStart(3, '0')}.txt`,
  searches: `search-${String(number).padStart(3, '0')}.jsonl`,
  decisions: `decision-${String(number).padStart(3, '0')}.txt`,
  rejected: `rejected-${String(number).padStart(3, '0')}.json`,
}[kind]);
const meta = (world, number = 1) => readFile(chunkPath(world, 'active', number), 'utf8').then(JSON.parse);
const view = (world, number = 1) => readFile(chunkPath(world, 'view', number), 'utf8');

withWorld('prepare shares one record search across senses and judges each sense separately', async (world) => {
  const result = await prepareChunk({ ...world.options, chunkNumber: 1 });
  assert.equal(result.status, 'READY');
  const text = await view(world);
  assert.equal((text.match(/search: forms=새벽안개/gu) ?? []).length, 1, 'one search block per record');
  assert.match(text, /s1 w001-s1 \[noun\] 새벽에 끼는 안개\./u);
  assert.match(text, /s2 w001-s2 \[noun\] 비유적으로 흐릿함\./u);
  assert.ok(text.indexOf('[1] 새벽안개') < text.indexOf('s1 w001-s1'), 'senses follow the shared contexts');
  const saved = await meta(world);
  assert.equal(saved.senses.length, 25 + 1); // w001 has two senses
  assert.equal(saved.view_sha256.length, 64);
  assert.equal(saved.records.length, 25);
});

withWorld('automatic Z is only mechanically proven noun ZERO_HITS; view states expose exact decision evidence', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const saved = await meta(world);
  const refOf = (senseId) => saved.senses.find((item) => item.sense_id === senseId);
  assert.equal(refOf('w002-s1').auto, true, 'long Hangul noun, no hit for the form or any spaced spelling');
  assert.equal(refOf('w003-s1').auto, false, 'a verb is never automatic');
  assert.equal(refOf('w004-s1').auto, false, 'a 1-syllable noun is never automatic');
  assert.equal(refOf('w005-s1').auto, false, 'a spaced spelling has a hit: the AI must read it');
  const text = await view(world);
  assert.match(text, /## w003 달리다[\s\S]*?증거 상태: 모든 검색 완료·누적 0 hit — Z 형식 허용/u);
  assert.match(text, /## w004 핫[\s\S]*?증거 상태: 모든 검색 완료·누적 0 hit — Z 형식 허용/u);
  assert.match(text, /## w005 기회비용[\s\S]*?search: forms=기 회비용,기회 비용,기회비 용[\s\S]*?기회 비용을/u);
  assert.ok(!text.includes('## w002'), 'automatic Z records are not shown');
  assert.match(text.split('\n')[0], /decide=s\d+/u);
  assert.match(text.split('\n')[0], /auto_z=.*s\d+/u);
});

withWorld('a chunk whose senses are all mechanically proven ZERO_HITS is saved without an AI', async (world) => {
  const result = await prepareChunk({ ...world.options, chunkNumber: 2 });
  assert.equal(result.status, 'AUTO_COMPLETE');
  const rows = (await readFile(path.join(world.directory, 'chunk-002.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 25);
  assert.ok(rows.every((row) => row.senses.every((sense) => sense.candidates.length === 0)));
  assert.equal(existsSync(chunkPath(world, 'active', 2)), false);
  await assert.rejects(prepareChunk({ ...world.options, chunkNumber: 2 }), /already saved/u);
});

test('autoZCandidate: POS alone never qualifies; form shape and length are part of the evidence', () => {
  const noun = (lemma, pos = 'noun') => ({ senses: [{ pos }], lemma });
  const table = [
    [noun('서울역'), ['서울역'], true],
    [noun('서울역', 'verb'), ['서울역'], false],
    [noun('서울'), ['서울'], false], // 2 syllables: boundary-both cannot prove sufficiency
    [noun('달리다', 'verb'), ['달리다'], false],
    [noun('abc가나다'), ['abc가나다'], false],
    [noun('가나다-라마'), ['가나다-라마'], false],
    [noun('가나다라마바사아자차카타파'), ['가나다라마바사아자차카타파'], false], // too long for the variant check
    [{ senses: [{ pos: 'noun' }, { pos: 'verb' }] }, ['서울역'], false], // one non-noun sense blocks the whole record
    [noun('서울역'), [], false],
  ];
  for (const [record, forms, want] of table) assert.equal(autoZCandidate(record, forms), want, JSON.stringify([record, forms]));
});

test('hadaPrefetchForms: exact Hangul -하다 bases use POS-scoped forms and omit short or existing forms', () => {
  const verb = rec('w1', '공부하다', [['verb', '학문이나 기술을 배우고 익히다.']]);
  assert.deepEqual(hadaPrefetchForms(verb), [
    '공부해', '공부해서', '공부했다', '공부하여', '공부하고', '공부하면', '공부한', '공부할', '공부하는', '공부한다',
  ]);

  const adjective = rec('w2', '조용하다', [['adjective', '소리가 나지 않고 잠잠하다.']]);
  assert.deepEqual(hadaPrefetchForms(adjective), [
    '조용해', '조용해서', '조용했다', '조용하여', '조용하고', '조용하면', '조용한', '조용할',
  ]);

  const short = rec('w3', '구하다', [['verb', '찾다.']]);
  const shortForms = hadaPrefetchForms(short);
  assert.ok(!shortForms.includes('구해'), 'the two-syllable form 구해 is excluded');
  assert.ok(!shortForms.includes('구한') && !shortForms.includes('구할'));

  const existing = rec('w4', '공부하다', [['verb', '배우고 익히다.']], { search_forms: ['공부하다', '공부해', '말하다'] });
  assert.equal(hadaPrefetchForms(existing).filter((form) => form === '공부해').length, 0, 'Canonical forms are not added twice');
  assert.deepEqual(hadaPrefetchForms(rec('w5', '배가 내박하다', [['verb', '뜻.']])), [], 'phrases are not treated as lexical bases');
  assert.deepEqual(hadaPrefetchForms(rec('w6', '행복스럽다', [['adjective', '뜻.']])), [], 'other endings are out of scope');
  assert.deepEqual(hadaPrefetchForms(rec('w7', '유용하다', [['noun', '뜻.']])), [], 'unsupported POS is not expanded');
});

test('prepare keeps -하다 prefetch opt-in, shows combined evidence, and records the opt-in through the CLI', async () => {
  const world = await makeWorld();
  try {
    const rows = (await readFile(world.options.canonicalPath, 'utf8')).trim().split('\n').map(JSON.parse);
    rows[2] = rec('w003', '공부하다', [['verb', '학문이나 기술을 배우고 익히다.']]);
    await writeFile(world.options.canonicalPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    const calls = [];
    const zeroSearch = (forms) => {
      calls.push(forms);
      return { result: { status: 'ZERO_HITS', items: [], next_cursor: null, scanned_rows: 1 } };
    };
    zeroSearch.corpusRows = 10;
    const record = rows[2];
    const defaultBuilt = buildChunk({ records: [record], shard: '001', batch: '01', chunkNumber: 1, total: 20, search: zeroSearch });
    assert.deepEqual(calls[0], ['공부하다'], 'default prepare searches Canonical forms only');
    const optedInBuilt = buildChunk({ records: [record], shard: '001', batch: '01', chunkNumber: 1, total: 20, search: zeroSearch, hadaPrefetch: true });
    assert.deepEqual(calls[1], ['공부하다', ...hadaPrefetchForms(record)]);
    assert.match(optedInBuilt.view, /search_forms: 공부하다\nsearch: forms=공부하다,공부해,공부해서/u);
    assert.equal(optedInBuilt.entries[0].status, 'ZERO_HITS');
    assert.deepEqual(optedInBuilt.entries[0].forms, ['공부하다', ...hadaPrefetchForms(record)]);
    assert.equal(optedInBuilt.senses[0].auto, false, 'prefetch never expands the automatic-Z rule to verbs');

    const result = await runCli([
      'prepare', '--canonical', world.options.canonicalPath, '--shard', '001', '--batch', '01', '--chunk', '1',
      '--db', world.options.databasePath, '--model', 'codex', '--head', 'a'.repeat(40), '--dir', world.directory, '--hada-prefetch',
    ], '');
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).status, 'READY');
    const activeView = await view(world);
    assert.match(activeView, /search_forms: 공부하다\nsearch: forms=공부하다,공부해,공부해서/u);
    const evidence = (await readFile(chunkPath(world, 'searches'), 'utf8')).trim().split('\n').map(JSON.parse)
      .find((entry) => entry.record_id === 'w003');
    assert.deepEqual(evidence.forms, ['공부하다', ...hadaPrefetchForms(record)]);
    assert.equal(evidence.source, 'prepare');
    assert.equal(evidence.status, 'ZERO_HITS');
    assert.equal(evidence.complete, true);
    const zeroDecision = new Map([['s1', { kind: 'Z', candidates: [], line: 1 }]]);
    assert.deepEqual(checkDecisions({
      meta: { senses: [{ ref: 's1', record_id: 'w003', sense_id: 'w003-s1', auto: false }] },
      records: [record], entries: [evidence], decisions: zeroDecision, lemmaForms: new Map(),
    }).errors, [], 'the existing Z decision gate accepts complete zero-hit prefetch evidence');
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test('prepare collects four distinct contexts across LIMITED pages before returning its view', () => {
  const record = rec('w1', '노래', [['noun', '소리를 내어 부르는 일.']]);
  const contexts = [1, 2, 3, 4].map((paragraph_rowid) => ({ paragraph_rowid, form: '노래', title: '작품', author: '작가', excerpt: `문맥 ${paragraph_rowid}` }));
  const calls = [];
  const search = (_forms, options) => {
    calls.push(options);
    if (calls.length === 1) return { result: { status: 'LIMITED', items: [contexts[0]], next_cursor: 'c1', scanned_rows: 1 } };
    if (calls.length === 2) return { result: { status: 'LIMITED', items: [contexts[1]], next_cursor: 'c2', scanned_rows: 1 } };
    return { result: { status: 'COMPLETE', items: contexts.slice(2), next_cursor: null, scanned_rows: 1 } };
  };
  search.corpusRows = 10;
  const built = buildChunk({ records: [record], shard: '001', batch: '01', chunkNumber: 1, total: 20, search });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map((item) => item.maxSamples), [4, 3, 2]);
  assert.equal(built.entries[0].hits, 4);
  assert.equal(built.entries[0].status, 'COMPLETE');
  assert.equal(new Set([...built.view.matchAll(/문맥 (\d)/gu)].map((match) => match[1])).size, 4);
});

test('searchForContexts fills N, preserves collected hits, and keeps completion tied to cursor provenance', () => {
  const item = (paragraph_rowid) => ({ paragraph_rowid, excerpt: `context-${paragraph_rowid}` });
  const page = (status, items = [], cursor = null, scanned_rows = 1) => ({ status, items, next_cursor: cursor, scanned_rows });
  const run = (pages, options = {}, budget = {}) => {
    const calls = [];
    const search = (forms, opts) => {
      calls.push({ cursor: opts.cursor ?? null, scanRows: opts.scanRows, maxSamples: opts.maxSamples });
      return { result: pages[Math.min(calls.length - 1, pages.length - 1)] };
    };
    return { ...searchForContexts(search, ['눈'], options, budget), calls };
  };
  let out = run([
    page('LIMITED', [item(1)], 'c1'),
    page('LIMITED', [item(2)], 'c2'),
    page('COMPLETE', [item(3), item(4)], null),
  ], { maxSamples: 4 });
  assert.equal(out.result.status, 'COMPLETE');
  assert.deepEqual(out.result.items.map((context) => context.paragraph_rowid), [1, 2, 3, 4]);
  assert.deepEqual(out.calls.map((call) => call.cursor), [null, 'c1', 'c2']);
  assert.deepEqual(out.calls.map((call) => call.maxSamples), [4, 3, 2]);

  // Empty pages continue internally until real completion, and a fresh complete empty search is the only ZERO_HITS.
  out = run([page('LIMITED', [], 'c1'), page('LIMITED', [item(1)], 'c2'), page('COMPLETE', [])], { maxSamples: 4 });
  assert.equal(out.result.status, 'COMPLETE');
  assert.equal(out.result.items.length, 1);
  out = run([page('LIMITED', [], 'c1'), page('COMPLETE', [])]);
  assert.equal(out.result.status, 'ZERO_HITS');

  // A request scan cap returns accumulated contexts with the actual continuation cursor.
  out = run([page('LIMITED', [item(1)], 'c1', 2), page('LIMITED', [item(2)], 'c2', 1), page('COMPLETE', [])], { maxSamples: 4 }, { maxScanRows: 3 });
  assert.equal(out.result.status, 'LIMITED');
  assert.equal(out.result.scanned_rows, 3);
  assert.equal(out.result.next_cursor, 'c2');
  assert.deepEqual(out.calls.map((call) => call.scanRows), [3, 1]);

  // A later failure retains earlier hits and cannot turn them into a false empty result.
  out = run([page('LIMITED', [item(1)], 'c1'), { status: 'SEARCH_FAILED', error: 'index unavailable', items: [], next_cursor: null, scanned_rows: 1 }]);
  assert.equal(out.result.status, 'SEARCH_FAILED');
  assert.deepEqual(out.result.items.map((context) => context.paragraph_rowid), [1]);

  // External cursor completion without new hits remains COMPLETE, never ZERO_HITS.
  out = run([page('COMPLETE', [])], { cursor: 'c1' });
  assert.equal(out.result.status, 'COMPLETE');
  assert.equal(out.cursorIn, 'c1');
  assert.equal(run([page('COMPLETE', [])], { cursor: 'c1' }).result.status, 'COMPLETE');

  // Repeated cursors fail closed; a call limit stays a truthful LIMITED continuation.
  out = run([page('LIMITED', [item(1)], 'c1'), page('LIMITED', [], 'c1')]);
  assert.equal(out.result.status, 'SEARCH_FAILED');
  assert.match(out.result.error, /no progress/u);
  assert.equal(out.result.items.length, 1);
  out = run([page('LIMITED', [item(1)], 'c1')], {}, { maxCalls: 0 });
  assert.equal(out.result.status, 'LIMITED');
  assert.equal(out.result.next_cursor, 'c1');
});

test('searchForContexts over a real index: bounded zero, form-bound cursors, external cursor', async () => {
  const world = await makeWorld({ fillerParagraphs: 0 });
  try {
    const database = openReadonlyDb(world.options.databasePath);
    const search = (forms, options) => ({ result: searchContexts(database, forms, { ...options, scanRows: 1 }) });
    const zero = searchForContexts(search, ['마', '쿠'], {});
    assert.equal(zero.result.status, 'ZERO_HITS');
    assert.ok(zero.followups >= 3);
    const hit = searchForContexts(search, ['기회'], { maxSamples: 4 });
    assert.ok(hit.result.items.length > 0, 'contexts are returned');
    const first = searchContexts(database, ['마', '쿠'], { scanRows: 1 });
    assert.equal(first.status, 'LIMITED');
    const external = searchForContexts(search, ['마', '쿠'], { cursor: first.next_cursor });
    assert.equal(external.result.status, 'COMPLETE', 'external cursor never becomes ZERO_HITS');
    assert.throws(() => searchForContexts(search, ['마'], { cursor: first.next_cursor }), InvalidCursorError, 'a cursor of another form list is rejected');
    database.close();
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test('recordEvidence: hits add up per search; completion needs a proven start', () => {
  const e = (form, status, hits, complete, cursorIn = null, cursorOut = null) => {
    const forms = [form];
    const out = status === 'LIMITED' && cursorOut === null ? `${form}-cursor` : cursorOut;
    return { record_id: 'r', key: JSON.stringify([forms, null]), forms, boundary: null, source: 'search',
      status, hits, complete, cursor_in: cursorIn, cursor_out: out };
  };
  const summary = (entries, record = 'r') => {
    const { searches, hits, allComplete } = recordEvidence(entries, record);
    return { searches, hits, allComplete };
  };
  assert.deepEqual(summary([e('a', 'ZERO_HITS', 0, true)]), { searches: 1, hits: 0, allComplete: true });
  assert.deepEqual(summary([e('a', 'LIMITED', 0, false, null, 'x')]), { searches: 1, hits: 0, allComplete: false });
  // (a) fresh start completed internally
  assert.equal(summary([e('a', 'ZERO_HITS', 0, true)]).allComplete, true);
  // (b) external cursor with no recorded origin: COMPLETE 0 is not proof
  assert.throws(() => summary([e('a', 'COMPLETE', 0, true, 'x')]), /cursor chain/u);
  // (c) earlier page hit + later COMPLETE 0 -> hits > 0 (Z refused by checkDecisions)
  const withHit = summary([e('a', 'LIMITED', 3, false, null, 'x'), e('a', 'COMPLETE', 0, true, 'x')]);
  assert.deepEqual(withHit, { searches: 1, hits: 3, allComplete: true });
  // chain: proven through recorded cursors; a cursor that was never recorded breaks it
  assert.equal(summary([e('a', 'LIMITED', 0, false, null, 'x'), e('a', 'LIMITED', 0, false, 'x', 'y'), e('a', 'COMPLETE', 0, true, 'y')]).allComplete, true);
  assert.throws(() => summary([e('a', 'LIMITED', 0, false, null, 'x'), e('a', 'COMPLETE', 0, true, 'z')]), /cursor chain/u);
  assert.throws(() => summary([e('a', 'COMPLETE', 0, true, 'q', 'x'), e('a', 'COMPLETE', 0, true, 'x')]), /cursor chain/u, 'unproven pages fail closed');
  // (d) another search key does not provide the origin
  assert.throws(() => summary([e('a', 'LIMITED', 0, false, null, 'x'), e('b', 'COMPLETE', 0, true, 'x')]), /cursor chain/u);
  assert.deepEqual(summary([e('a', 'ZERO_HITS', 0, true), e('b', 'LIMITED', 3, false)]), { searches: 2, hits: 3, allComplete: false });
  assert.deepEqual(summary([]), { searches: 0, hits: 0, allComplete: false });
  assert.deepEqual(summary([e('a', 'COMPLETE', 2, true)], 'other'), { searches: 0, hits: 0, allComplete: false });
  const exact = { ...e('a', 'COMPLETE', 2, true), request_key: 'same request' };
  assert.deepEqual(summary([exact, exact]), { searches: 1, hits: 2, allComplete: true }, 'an exact duplicate request never doubles hits');
});

test('recorded cursors require the exact active record, search and unconsumed LIMITED chain', () => {
  const first = cursorEvidence('w1', ['낭축'], 'both', 'cursor-one');
  const second = cursorEvidence('w1', ['낭축'], 'both', 'cursor-two', 'cursor-one');
  const entries = [first, second];
  assert.equal(resolveRecordedCursor({ cursor: 'next', recordId: 'w1', forms: ['낭축'], boundary: 'both', entries }), 'cursor-two');
  assert.equal(resolveRecordedCursor({ cursor: 'cursor-two', recordId: 'w1', forms: ['낭축'], boundary: 'both', entries }), 'cursor-two');
  assert.throws(() => resolveRecordedCursor({ cursor: 'cursor-one', recordId: 'w1', forms: ['낭축'], boundary: 'both', entries }), InvalidCursorError);
  assert.throws(() => resolveRecordedCursor({ cursor: 'cursor-two', recordId: 'w2', forms: ['낭축'], boundary: 'both', entries }), InvalidCursorError);
  assert.throws(() => resolveRecordedCursor({ cursor: 'next', recordId: 'w1', forms: ['낭축'], boundary: 'none', entries }), InvalidCursorError);
  assert.throws(() => resolveRecordedCursor({ cursor: 'cursor-two', recordId: 'w1', forms: ['낭', '축'], boundary: 'both', entries }), InvalidCursorError);
  assert.throws(() => resolveRecordedCursor({ cursor: null, recordId: 'w1', forms: ['낭축'], boundary: 'both', entries }), /unfinished LIMITED search already exists/u);
  assert.throws(() => resolveRecordedCursor({ cursor: null, recordId: 'w1', forms: ['낭축'], boundary: 'both', entries: [{ ...first, key: 'corrupted-key' }] }), /incomplete or malformed/u);

  const complete = { ...second, status: 'COMPLETE', complete: true, cursor_out: null };
  assert.throws(() => resolveRecordedCursor({ cursor: 'next', recordId: 'w1', forms: ['낭축'], boundary: 'both', entries: [first, complete] }), (error) => {
    assert.ok(error instanceof InvalidCursorError);
    assert.match(error.message, /no unfinished search/u);
    assert.match(error.message, /recorded_status=COMPLETE/u);
    assert.doesNotMatch(error.message, /use cursor:"next"/u);
    return true;
  });
  const zero = { ...first, status: 'ZERO_HITS', hits: 0, complete: true, cursor_out: null };
  assert.throws(() => resolveRecordedCursor({ cursor: 'next', recordId: 'w1', forms: ['낭축'], boundary: 'both', entries: [zero] }), /no unfinished search/u);
  const failedStart = { ...first, status: 'SEARCH_FAILED', hits: 0, complete: false, cursor_in: null, cursor_out: null };
  assert.equal(resolveRecordedCursor({ cursor: null, recordId: 'w1', forms: ['낭축'], boundary: 'both', entries: [failedStart] }), null,
    'a failed first page can still be retried without a cursor');
  const successfulRetry = { ...first, cursor_out: 'retry-cursor' };
  const failedThenLimited = [failedStart, successfulRetry];
  assert.equal(resolveRecordedCursor({ cursor: 'next', recordId: 'w1', forms: ['낭축'], boundary: 'both', entries: failedThenLimited }), 'retry-cursor',
    'a prior failed first page does not hide a later successful LIMITED cursor');
  assert.equal(resolveRecordedCursor({ cursor: 'retry-cursor', recordId: 'w1', forms: ['낭축'], boundary: 'both', entries: failedThenLimited }), 'retry-cursor',
    'the exact cursor from a successful retry remains usable');
  assert.throws(() => resolveRecordedCursor({ cursor: null, recordId: 'w1', forms: ['낭축'], boundary: 'both', entries: failedThenLimited }), /unfinished LIMITED search already exists/u,
    'a successful retry still blocks a duplicate cursorless first page');
  const failedContinuation = { ...second, status: 'SEARCH_FAILED', hits: 0, complete: false, cursor_in: 'cursor-one', cursor_out: null };
  for (const cursor of [null, 'next']) {
    assert.throws(() => resolveRecordedCursor({ cursor, recordId: 'w1', forms: ['낭축'], boundary: 'both', entries: [first, failedContinuation] }), (error) => {
      assert.match(error.message, /SEARCH_FAILED/u);
      assert.match(error.message, /preserve the evidence and report/u);
      assert.doesNotMatch(error.message, /continue it with next/u);
      return true;
    });
  }
  const branched = [first, cursorEvidence('w1', ['낭축'], 'both', 'cursor-other')];
  assert.throws(() => resolveRecordedCursor({ cursor: 'next', recordId: 'w1', forms: ['낭축'], boundary: 'both', entries: branched }), (error) => {
    assert.match(error.message, /multiple successful cursor chains/u);
    assert.match(error.message, /preserve the evidence and report/u);
    assert.doesNotMatch(error.message, /use cursor:"next"/u);
    return true;
  });
});

test('search-batch shares identical search work across homonym records and keeps distinct options separate', () => {
  const records = [rec('w1', '난주', [['noun', '첫 뜻.'], ['noun', '둘째 뜻.']]), rec('w2', '난주', [['noun', '다른 표제 record.']])];
  const metaValue = { senses: [
    { ref: 's1', record_id: 'w1', sense_id: 'w1-s1', auto: false },
    { ref: 's2', record_id: 'w1', sense_id: 'w1-s2', auto: false },
    { ref: 's3', record_id: 'w2', sense_id: 'w2-s1', auto: false },
  ] };
  const forms = [' 쉼표,포함 ', '"공백 포함"'];
  const same = (sense) => ({ sense, forms, boundary: 'left', cursor: null, contexts: 2 });
  const calls = [];
  let nextGroup = 0;
  const search = (requestForms, options) => {
    calls.push({ forms: requestForms, options });
    if (options.cursor === 'external-cursor') return { result: { status: 'COMPLETE', items: [], next_cursor: null, scanned_rows: 1 } };
    if (options.cursor === null) {
      const group = ++nextGroup;
      return { result: {
        status: 'LIMITED',
        items: [{ form: requestForms[0], paragraph_rowid: group * 10, title: '문서', author: '저자', excerpt: `context-${group}-1` }],
        next_cursor: `cursor-${group}`, scanned_rows: 1,
      } };
    }
    const group = Number(options.cursor.replace('cursor-', ''));
    return { result: {
      status: 'COMPLETE',
      items: [{ form: requestForms[0], paragraph_rowid: group * 10 + 1, title: '문서', author: '저자', excerpt: `context-${group}-2` }],
      next_cursor: null, scanned_rows: 1,
    } };
  };
  search.corpusRows = 10;
  const requests = [
    same('s1'), same('s2'), same('s3'),
    { ...same('s1'), boundary: 'none' },
    { ...same('s1'), forms: ['별도,검색형', '"인용"'], contexts: 3 },
    { ...same('s1'), forms: ['cursor-condition'], cursor: 'external-cursor' },
    { ...same('s3'), forms: ['별도,검색형', '"인용"'] },
  ];
  const { output, evidence } = buildSearchBatch({
    requests, meta: metaValue, records, search,
    priorEntries: [cursorEvidence('w1', ['cursor-condition'], 'left', 'external-cursor')],
    validateCursor: () => {},
  });
  assert.equal(calls.length, 9, 'record IDs are absent from the request identity, while forms, boundary, cursor and contexts distinguish results');
  assert.equal(output.result_count, 5);
  assert.equal(output.results[0].result_id, 'q1');
  assert.deepEqual(output.results[0].shared_by.map((item) => [item.sense, item.record_id]), [['s1', 'w1'], ['s2', 'w1'], ['s3', 'w2']]);
  assert.equal(output.results[0].contexts.length, 2, 'shared contexts are collected once and included once');
  assert.equal(output.requests[0].result_id, output.requests[1].result_id);
  assert.equal(output.requests[1].result_id, output.requests[2].result_id);
  assert.deepEqual(calls[0].forms, ['쉼표,포함', '"공백 포함"'], 'JSON keeps commas, spaces and quotes inside each form');
  assert.equal(evidence.length, 6, 'same record and identical query produces one evidence row; another record gets its own row');
  assert.deepEqual([...new Set(evidence.slice(0, 2).map((entry) => entry.record_id))], ['w1', 'w2']);
  const continuationHistory = [cursorEvidence('w1', ['cursor-condition'], 'left', 'external-cursor'), ...evidence, evidence[0]];
  assert.deepEqual(evidenceSummary(continuationHistory, 'w1'), { searches: 4, hits: 7, allComplete: true });
});

test('search-batch resolves recorded cursors and leaves actual SEARCH_FAILED intact', () => {
  const records = [rec('w1', '난주', [['noun', '첫 뜻.'], ['noun', '둘째 뜻.']]), rec('w2', '난주', [['noun', '다른 record.']])];
  const metaValue = { senses: [
    { ref: 's1', record_id: 'w1', sense_id: 'w1-s1', auto: false },
    { ref: 's2', record_id: 'w1', sense_id: 'w1-s2', auto: false },
    { ref: 's3', record_id: 'w2', sense_id: 'w2-s1', auto: false },
  ] };
  const search = (forms, options) => {
    if (forms[0] === 'fail') return { result: { status: 'SEARCH_FAILED', error: 'index unavailable', items: [], next_cursor: null, scanned_rows: 1 } };
    if (forms[0] === 'zero') return { result: { status: 'ZERO_HITS', items: [], next_cursor: null, scanned_rows: 1 } };
    if (options.cursor === 'external') return { result: { status: 'COMPLETE', items: [], next_cursor: null, scanned_rows: 1 } };
    if (options.cursor === null) return { result: { status: 'LIMITED', items: [{ paragraph_rowid: 1, excerpt: 'shared hit' }], next_cursor: 'recorded-cursor', scanned_rows: 1 } };
    return { result: { status: 'COMPLETE', items: [], next_cursor: null, scanned_rows: 1 } };
  };
  search.corpusRows = 10;
  const { output, evidence } = buildSearchBatch({
    requests: [
      { sense: 's1', forms: ['shared'], cursor: 'external' },
      { sense: 's2', forms: ['shared'], cursor: 'external' },
      { sense: 's3', forms: ['shared'] },
      { sense: 's3', forms: ['zero'] },
      { sense: 's3', forms: ['fail'] },
    ],
    meta: metaValue, records, search, priorEntries: [cursorEvidence('w1', ['shared'], null, 'external')], validateCursor: () => {},
  });
  assert.deepEqual(output.results.map((result) => result.status), ['COMPLETE', 'COMPLETE', 'ZERO_HITS', 'SEARCH_FAILED']);
  assert.equal(output.status, 'SEARCH_FAILED');
  assert.deepEqual(evidenceSummary([cursorEvidence('w1', ['shared'], null, 'external'), ...evidence], 'w1'), { searches: 1, hits: 1, allComplete: true });
  assert.deepEqual(evidenceSummary(evidence, 'w2'), { searches: 3, hits: 1, allComplete: false });
  const external = evidence.find((entry) => entry.record_id === 'w1' && entry.cursor_in === 'external');
  assert.equal(external.complete, true, 'raw page status remains accurate in the evidence');
});

test('search-batch validates every cursor before any database search', () => {
  const records = [rec('w1', '난주', [['noun', '첫 뜻.']]), rec('w2', '난주', [['noun', '다른 뜻.']])];
  const metaValue = { senses: [
    { ref: 's1', record_id: 'w1', sense_id: 'w1-s1', auto: false },
    { ref: 's2', record_id: 'w2', sense_id: 'w2-s1', auto: false },
  ] };
  let calls = 0;
  const search = () => { calls += 1; throw new Error('must not search'); };
  assert.throws(() => buildSearchBatch({
    requests: [{ sense: 's1', forms: ['new-condition'] }, { sense: 's2', forms: ['shared'], cursor: 'borrowed' }],
    meta: metaValue, records, search, priorEntries: [cursorEvidence('w1', ['shared'], null, 'borrowed')],
  }), InvalidCursorError);
  assert.equal(calls, 0);
});

test('search-batch rejects duplicate starts for one record condition before searching', () => {
  const records = [rec('w1', '난주', [['noun', '첫 뜻.'], ['noun', '둘째 뜻.']])];
  const metaValue = { senses: [
    { ref: 's1', record_id: 'w1', sense_id: 'w1-s1', auto: false },
    { ref: 's2', record_id: 'w1', sense_id: 'w1-s2', auto: false },
  ] };
  let calls = 0;
  const search = () => { calls += 1; throw new Error('must not search'); };
  assert.throws(() => buildSearchBatch({
    requests: [
      { sense: 's1', forms: ['shared'], boundary: 'left', contexts: 2 },
      { sense: 's2', forms: ['shared'], boundary: 'left', contexts: 4 },
    ],
    meta: metaValue, records, search,
  }), /one request per record and search condition/u);
  assert.equal(calls, 0);
});

test('search-batch rejects a cursorless repeat of a recorded LIMITED condition but permits a distinct condition', () => {
  const records = [rec('w1', '난주', [['noun', '첫 뜻.'], ['noun', '둘째 뜻.']])];
  const metaValue = { senses: [
    { ref: 's1', record_id: 'w1', sense_id: 'w1-s1', auto: false },
    { ref: 's2', record_id: 'w1', sense_id: 'w1-s2', auto: false },
  ] };
  const priorEntries = [cursorEvidence('w1', ['shared'], 'left', 'pending')];
  let calls = 0;
  const search = (forms) => {
    calls += 1;
    return { result: { status: 'ZERO_HITS', items: [], next_cursor: null, scanned_rows: 1 } };
  };
  assert.throws(() => buildSearchBatch({
    requests: [{ sense: 's1', forms: ['shared'], boundary: 'left', contexts: 8 }],
    meta: metaValue, records, search, priorEntries,
  }), /unfinished LIMITED search already exists/u);
  assert.equal(calls, 0);

  const { output, evidence } = buildSearchBatch({
    requests: [{ sense: 's1', forms: ['new-condition'], boundary: 'both', cursor: null }],
    meta: metaValue, records, search, priorEntries,
  });
  assert.equal(output.status, 'OK');
  assert.equal(calls, 1);
  assert.equal(evidence.length, 1);
});

test('search-batch reuses completed record evidence while searching an incomplete record with the same query', () => {
  const records = [rec('w1', '첫말', [['noun', '첫 뜻.']]), rec('w2', '둘말', [['noun', '둘 뜻.']])];
  const metaValue = { senses: [
    { ref: 's1', record_id: 'w1', sense_id: 'w1-s1', auto: false },
    { ref: 's2', record_id: 'w2', sense_id: 'w2-s1', auto: false },
  ] };
  const forms = ['공유검색형'];
  const priorEntry = {
    record_id: 'w1', key: JSON.stringify([forms, null]), forms, boundary: null,
    status: 'ZERO_HITS', hits: 0, complete: true, cursor_in: null, cursor_out: null, source: 'prepare',
  };
  let calls = 0;
  const search = () => {
    calls += 1;
    return { result: { status: 'COMPLETE', items: [{ paragraph_rowid: 11, excerpt: 'new record context' }], next_cursor: null, scanned_rows: 3 } };
  };
  search.corpusRows = 100;
  const { output, evidence } = buildSearchBatch({
    requests: [{ sense: 's1', forms }, { sense: 's2', forms }],
    meta: metaValue, records, search, priorEntries: [priorEntry],
  });
  assert.equal(calls, 1, 'the completed record does not trigger a shared-query scan');
  assert.equal(output.already_complete_count, 1);
  assert.deepEqual(output.results.map((result) => result.status), ['ALREADY_COMPLETE', 'COMPLETE']);
  assert.deepEqual(output.requests.map((request) => request.decision_state.state), ['Z_ALLOWED', 'V_N_ALLOWED']);
  assert.deepEqual(evidence.map((entry) => entry.record_id), ['w2']);
  assert.equal(output.scanned_rows, 3);
});

test('search-batch full retry reuses completed groups and executes only the previously deferred request', () => {
  const records = Array.from({ length: 5 }, (_, index) => rec(`w${index + 1}`, `낱말${index + 1}`, [['noun', '뜻.']]));
  const senses = records.map((record, index) => ({ ref: `s${index + 1}`, record_id: record.id, sense_id: `${record.id}-s1`, auto: false }));
  const requests = senses.map((sense, index) => ({ sense: sense.ref, forms: [`재시도${index + 1}`], contexts: 1 }));
  const search = (forms) => ({ result: { status: 'ZERO_HITS', items: [], next_cursor: null, scanned_rows: 1 } });
  search.corpusRows = 1;

  const first = buildSearchBatch({ requests, meta: { senses }, records, search });
  assert.equal(first.output.status, 'PARTIAL');
  assert.deepEqual(first.output.results.map((result) => result.status), ['ZERO_HITS', 'ZERO_HITS', 'ZERO_HITS', 'ZERO_HITS', 'DEFERRED']);
  assert.equal(first.evidence.length, 4);

  const retryCalls = [];
  const retrySearch = (forms, options) => {
    retryCalls.push({ forms, options });
    return { result: { status: 'ZERO_HITS', items: [], next_cursor: null, scanned_rows: 1 } };
  };
  retrySearch.corpusRows = 1;
  const retry = buildSearchBatch({ requests, meta: { senses }, records, search: retrySearch, priorEntries: first.evidence });
  assert.equal(retryCalls.length, 1);
  assert.equal(retryCalls[0].forms[0], '재시도5');
  assert.deepEqual(retry.output.results.map((result) => result.status), ['ALREADY_COMPLETE', 'ALREADY_COMPLETE', 'ALREADY_COMPLETE', 'ALREADY_COMPLETE', 'ZERO_HITS']);
  assert.equal(retry.output.already_complete_count, 4);
  assert.equal(retry.output.scanned_rows, 1);
  assert.deepEqual(retry.evidence.map((entry) => entry.record_id), ['w5']);
});

test('search-batch caps aggregate work and returns started progress plus untouched retry requests', () => {
  const records = Array.from({ length: 6 }, (_, index) => rec(`w${index + 1}`, `lemma${index + 1}`, [['noun', '뜻.']]));
  const senses = records.map((record, index) => ({ ref: `s${index + 1}`, record_id: record.id, sense_id: `${record.id}-s1`, auto: false }));
  const requests = senses.map((sense, index) => ({ sense: sense.ref, forms: [`term${index + 1}`], contexts: 1 }));
  requests[4].cursor = 'unverified-cursor';
  const calls = [];
  const search = (forms, options) => {
    calls.push({ forms, options });
    if (forms[0] === 'term4') return { result: {
      status: 'LIMITED', items: [{ paragraph_rowid: 44, excerpt: 'found before batch limit' }], next_cursor: 'cursor-term4', scanned_rows: 1,
    } };
    return { result: { status: 'ZERO_HITS', items: [], next_cursor: null, scanned_rows: 1 } };
  };
  search.corpusRows = 1;

  const { output, evidence } = buildSearchBatch({
    requests, meta: { senses }, records, search,
    priorEntries: [cursorEvidence('w5', ['term5'], null, 'unverified-cursor')],
    validateCursor: () => {},
  });
  assert.equal(calls.length, 4);
  assert.equal(output.status, 'PARTIAL');
  assert.equal(output.scan_budget_rows, 4);
  assert.equal(output.scanned_rows, 4);
  assert.deepEqual(output.results.map((result) => result.status), ['ZERO_HITS', 'ZERO_HITS', 'ZERO_HITS', 'LIMITED', 'DEFERRED', 'DEFERRED']);
  assert.equal(output.results[3].cursor_out, 'cursor-term4');
  assert.equal(output.requests[4].status, 'DEFERRED');
  assert.equal(output.results[4].cursor_in, null, 'an unstarted result does not claim to have validated its input cursor');
  assert.deepEqual(output.results[4].retry_requests, [requests[4]]);
  assert.deepEqual(output.results[5].retry_requests, [requests[5]]);
  assert.equal(evidence.length, 4, 'only requests that actually ran write evidence');
  assert.equal(evidence.some((entry) => entry.record_id === 'w5' || entry.record_id === 'w6'), false);
  assert.deepEqual(evidenceSummary(evidence, 'w4'), { searches: 1, hits: 1, allComplete: false });
});

test('search-batch defers requests after zero-hit FTS pages spend the aggregate budget', async () => {
  const world = await makeWorld();
  try {
    const records = Array.from({ length: 5 }, (_, index) => rec(`w${index + 1}`, `lemma${index + 1}`, [['noun', '뜻.']]));
    const senses = records.map((record, index) => ({ ref: `s${index + 1}`, record_id: record.id, sense_id: `${record.id}-s1`, auto: false }));
    const requests = senses.map((sense, index) => ({ sense: sense.ref, forms: [`없는말${index}`, `다른말${index}`] }));
    const database = openReadonlyDb(world.options.databasePath);
    const search = (forms, options) => ({ result: searchContexts(database, forms, options) });
    search.corpusRows = 1;

    try {
      const { output, evidence } = buildSearchBatch({ requests, meta: { senses }, records, search });
      assert.equal(output.status, 'PARTIAL');
      assert.equal(output.scanned_rows, 4);
      assert.deepEqual(output.results.map((result) => result.status), ['LIMITED', 'LIMITED', 'LIMITED', 'LIMITED', 'DEFERRED']);
      assert.ok(output.results.slice(0, 4).every((result) => result.cursor_out), 'started searches retain a real continuation cursor');
      assert.deepEqual(output.results[4].retry_requests, [requests[4]]);
      assert.equal(evidence.length, 4, 'the deferred request records no evidence');
      assert.equal(evidence.some((entry) => entry.record_id === 'w5'), false);
    } finally {
      database.close();
    }
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test('parseDecisions accepts the compact grammar and reports every malformed line', () => {
  const ok = parseDecisions('s1 V 건축가|설계도 | 공사장\n\ns2 V\ns3 N\ns4 Z\n');
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.decisions.get('s1').candidates, ['건축가', '설계도', '공사장']);
  assert.deepEqual(ok.decisions.get('s2').candidates, []);
  const bad = parseDecisions('s1 V a||b\ns2 N 후보\nx3 V\ns4 Q\ns5 Z\ns5 Z\n0 V');
  assert.equal(bad.errors.length, 6);
});

const lemmaForms = new Set(['건축', '건축가']);
const fixture = () => {
  const records = [rec('w1', '건축', [['noun', '집을 짓는 일.'], ['noun', '7,460미터 높이.']]), rec('w2', '벽', [['noun', '칸막이.']])];
  const metaValue = {
    senses: [
      { ref: 's1', record_id: 'w1', sense_id: 'w1-s1', auto: false }, { ref: 's2', record_id: 'w1', sense_id: 'w1-s2', auto: false },
      { ref: 's3', record_id: 'w2', sense_id: 'w2-s1', auto: false },
    ],
  };
  const entry = (id, form, status, hits, complete, cursorOut = null) => {
    const forms = [form];
    return { record_id: id, key: JSON.stringify([forms, null]), forms, boundary: null, status, hits, complete,
      cursor_in: null, cursor_out: cursorOut, source: 'search' };
  };
  const hit = (id) => entry(id, `${id}-search`, 'LIMITED', 3, false, `${id}-cursor`);
  const zero = (id) => entry(id, `${id}-zero`, 'ZERO_HITS', 0, true);
  return { records, metaValue, entry, hit, zero };
};

test('checkDecisions: evidence rules for V / N / Z, and Candidate v1 form rules, all reported together', () => {
  const { records, metaValue, entry, hit, zero } = fixture();
  const run = (text, entries) => {
    const { decisions, errors } = parseDecisions(text);
    assert.deepEqual(errors, []);
    return checkDecisions({ meta: metaValue, records, entries, decisions, lemmaForms }).errors;
  };
  // valid-but-unusual: independent compound of the lemma, V with no candidates, N after a LIMITED search with hits
  assert.deepEqual(run('s1 V 건축가|설계도\ns2 V\ns3 N', [hit('w1'), hit('w2')]), []);
  // Z only with every recorded search complete and 0 hits
  assert.deepEqual(run('s1 Z\ns2 Z\ns3 Z', [zero('w1'), zero('w2')]), []);
  const incompleteZero = entry('w1', 'w1-pending', 'LIMITED', 0, false, 'w1-pending-cursor');
  assert.match(run('s1 Z\ns2 Z\ns3 Z', [incompleteZero, zero('w2')]).join('\n'), /s1: Z needs/u);
  assert.match(run('s1 Z\ns2 Z\ns3 Z', [hit('w1'), zero('w2')]).join('\n'), /s2: Z needs/u);
  // V / N need contexts
  assert.match(run('s1 V\ns2 N\ns3 N', [zero('w1'), zero('w2')]).join('\n'), /s1: V needs[\s\S]*s2: N needs[\s\S]*s3: N needs/u);
  // missing, unknown, auto
  assert.match(run('s1 V\ns9 V', [hit('w1'), hit('w2')]).join('\n'), /s9: unknown[\s\S]*s2: missing[\s\S]*s3: missing/u);
  // Save removes only common Candidate v1 content failures and normalized duplicates.
  const parsed = parseDecisions('s1 V 건축|건축(建築)|건축 |설계도|설계도\ns2 V 460미터\ns3 V');
  const cleaned = checkDecisions({ meta: metaValue, records, entries: [hit('w1'), hit('w2')], decisions: parsed.decisions, lemmaForms });
  assert.deepEqual(cleaned.errors, []);
  assert.deepEqual(cleaned.rows[0].senses[0].candidates, ['설계도']);
  assert.deepEqual(cleaned.rows[0].senses[1].candidates, []);
  assert.deepEqual(cleaned.removedCandidates.map(({ ref, candidate, kind }) => [ref, candidate, kind]), [
    ['s1', '건축', 'source_lemma_repeat'],
    ['s1', '건축(建築)', 'source_lemma_repeat'],
    ['s1', '건축', 'duplicate_normalized'],
    ['s1', '설계도', 'duplicate_normalized'],
    ['s2', '460미터', 'thousands_comma_fragment'],
  ]);
});

withWorld('end to end: search records evidence, save stores the chunk once, a rejected save stores nothing', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const saved = await meta(world);
  const ref = (senseId) => saved.senses.find((item) => item.sense_id === senseId).ref;
  const open = saved.senses.filter((item) => !item.auto).map((item) => item.ref);
  const decisionsFile = chunkPath(world, 'decisions');
  const lines = (overrides = {}) => open.map((id) => {
    if (overrides[id]) return `${id} ${overrides[id]}`;
    const sense = saved.senses.find((item) => item.ref === id).sense_id;
    return sense.startsWith('w001') ? `${id} V 해무|새벽 공기|새벽안개|해무` : sense.startsWith('w005') ? `${id} V` : `${id} Z`;
  }).join('\n');

  // Z for a record without a complete zero is rejected, and nothing is stored (other lines were fine)
  await writeFile(decisionsFile, `${lines({ [ref('w005-s1')]: 'Z' })}\n`);
  await assert.rejects(saveActive({ inputPath: decisionsFile, root: world.root }), (error) => error.exitCode === 2 && /w005|s\d+: Z needs/u.test(error.message));
  assert.equal(existsSync(path.join(world.directory, 'chunk-001.jsonl')), false);
  // the rejection leaves one diagnostic bound to the active chunk; a hit-bearing record's Z is not repairable by re-judging
  const rejected = JSON.parse(await readFile(chunkPath(world, 'rejected'), 'utf8'));
  assert.deepEqual([rejected.diagnostic, rejected.chunk_no, rejected.view_sha256, rejected.repair_scope],
    ['save_rejected', 1, saved.view_sha256, 'stop_and_report']);
  assert.ok(rejected.senses.includes(ref('w005-s1')) && rejected.errors.some((line) => /Z needs/u.test(line)));

  // a recorded SEARCH_FAILED makes even a hit-free rejection non-repairable; without it the same rejection stays repairable
  const zeroHitRef = saved.senses.find((item) => !item.auto && !item.sense_id.startsWith('w001') && !item.sense_id.startsWith('w005')).ref;
  const failedEntry = { record_id: saved.senses.find((item) => item.ref === zeroHitRef).record_id, status: 'SEARCH_FAILED', hits: 0,
    complete: false, key: 'x', forms: ['x'], chunk_no: saved.chunk_no, view_sha256: saved.view_sha256 };
  const searches = chunkPath(world, 'searches');
  const priorSearches = await readFile(searches, 'utf8');
  const scope = async () => JSON.parse(await readFile(chunkPath(world, 'rejected'), 'utf8')).repair_scope;
  await writeFile(decisionsFile, `${lines({ [zeroHitRef]: 'V' })}\n`); // V without any recorded context: a pure re-judging error
  await assert.rejects(saveActive({ inputPath: decisionsFile, root: world.root }), (error) => error.exitCode === 2);
  assert.equal(await scope(), 'decisions');
  await writeFile(searches, `${priorSearches}${JSON.stringify(failedEntry)}\n`);
  await assert.rejects(saveActive({ inputPath: decisionsFile, root: world.root }), (error) => error.exitCode === 2);
  assert.equal(await scope(), 'stop_and_report');
  await writeFile(searches, priorSearches);

  // an AI search is recorded; a zero-hit search of another form keeps the record's Z valid
  const out = await searchActive({ ref: ref('w003-s1'), forms: ['달려서'], boundary: 'none', contexts: 16, databasePath: world.options.databasePath, root: world.root });
  assert.equal(out.result.status, 'ZERO_HITS');
  await assert.rejects(searchActive({ ref: 's99', databasePath: world.options.databasePath, root: world.root }), /not a sense of the active chunk/u);
  await assert.rejects(searchActive({ ref: ref('w003-s1'), contexts: 17, databasePath: world.options.databasePath, root: world.root }), /--contexts must be 1..16/u);

  await writeFile(decisionsFile, `${lines()}\n`);
  const done = await saveActive({ inputPath: decisionsFile, root: world.root });
  assert.equal(done.status, 'SAVED');
  assert.deepEqual(done.removed_candidates.map(({ ref, candidate, kind }) => [ref, candidate, kind]), [
    [ref('w001-s1'), '새벽안개', 'source_lemma_repeat'],
    [ref('w001-s1'), '해무', 'duplicate_normalized'],
    [ref('w001-s2'), '새벽안개', 'source_lemma_repeat'],
    [ref('w001-s2'), '해무', 'duplicate_normalized'],
  ]);
  assert.equal(existsSync(chunkPath(world, 'rejected')), true, 'the Supervisor owns scratch cleanup after verifying the saved chunk');
  const rows = (await readFile(path.join(world.directory, 'chunk-001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 25);
  assert.deepEqual(rows[0], { record_id: 'w001', senses: [{ sense_id: 'w001-s1', candidates: ['해무', '새벽 공기'] }, { sense_id: 'w001-s2', candidates: ['해무', '새벽 공기'] }] });
  assert.deepEqual(rows[1].senses[0].candidates, [], 'automatic Z is stored as an empty sense');
  await assert.rejects(saveActive({ inputPath: decisionsFile, root: world.root }), /already saved/u);
});

withWorld('search-batch reuses prepare completion for same-record senses without returning stale contexts', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const active = await meta(world);
  const refs = active.senses.filter((item) => item.record_id === 'w001').map((item) => item.ref);
  assert.equal(refs.length, 2);
  const before = await readFile(chunkPath(world, 'searches'), 'utf8');
  const result = await runCli(['search-batch', '--dir', world.root], JSON.stringify({ requests: refs.map((sense) => ({ sense })) }), {
    TYPEWRITER_APPROVED_CORPUS_DB: world.options.databasePath,
  });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'OK');
  assert.equal(output.request_count, 2);
  assert.equal(output.result_count, 1);
  assert.equal(output.already_complete_count, 2);
  assert.equal(output.requests[0].result_id, output.requests[1].result_id);
  assert.equal(output.results[0].status, 'ALREADY_COMPLETE');
  assert.deepEqual(output.results[0].contexts, []);
  assert.equal(output.requests[0].decision_state.state, 'V_N_ALLOWED');
  assert.equal(await readFile(chunkPath(world, 'searches'), 'utf8'), before, 'completed condition causes no rescan or evidence append');
  const evidence = (await readFile(chunkPath(world, 'searches'), 'utf8')).trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.record_id === 'w001' && entry.request_key !== undefined);
  assert.equal(evidence.length, 1, 'same-record senses share one request evidence row');
  assert.equal(evidence[0].source, 'prepare', 'the identical completed prepare search already supplies the record evidence');
  assert.equal(evidence[0].forms[0], '새벽안개');
});

withWorld('single and batch reread return context without changing evidence or decision state', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const searchesPath = chunkPath(world, 'searches');
  const before = await readFile(searchesPath, 'utf8');

  const cached = await searchActive({ ref: 's1', forms: ['새벽안개'], databasePath: world.options.databasePath, root: world.root });
  assert.equal(cached.result.status, 'ALREADY_COMPLETE');
  assert.equal(cached.result.scanned_rows, 0);
  assert.equal(cached.result.recorded_status, 'COMPLETE');
  assert.equal(cached.result.recorded_hits, 2);
  assert.equal(cached.context_source, 'view');
  assert.match(cached.text, /context_source=view/u);
  await assert.rejects(searchActive({
    ref: 's1', forms: ['새벽안개'], cursor: 'next', databasePath: world.options.databasePath, root: world.root,
  }), (error) => /recorded_status=COMPLETE recorded_hits=2/u.test(error.message)
    && /forms=\["새벽안개"\] boundary=null/u.test(error.message));

  const singleReread = await searchActive({
    ref: 's1', forms: ['새벽안개'], contexts: 1, reread: true,
    databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(singleReread.result.status, 'REREAD');
  assert.equal(singleReread.result.search_status, 'LIMITED');
  assert.equal(singleReread.result.items.length, 1);
  assert.equal(singleReread.result.next_cursor, null, 'unrecorded reread cursor is not exposed');
  assert.equal(singleReread.decision_state.state, cached.decision_state.state);
  assert.equal(await readFile(searchesPath, 'utf8'), before, 'single reread writes no evidence');

  const batchReread = await searchBatchActive({
    requests: [{ sense: 's1', forms: ['새벽안개'], contexts: 1, reread: true }],
    databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(batchReread.results[0].status, 'REREAD');
  assert.equal(batchReread.requests[0].decision_state.state, cached.decision_state.state);
  assert.equal(await readFile(searchesPath, 'utf8'), before, 'batch reread writes no evidence');
});

withWorld('cursor next resumes recorded search pages and invalid cursor input leaves evidence untouched', async (world) => {
  const database = new DatabaseSync(world.options.databasePath);
  for (let index = 0; index < 10; index += 1) {
    const rowid = 2004 + index;
    const form = `새벽안개가 번지는 추가 문맥 ${index}.`;
    database.prepare('INSERT INTO paragraphs VALUES (?, 1, ?, ?, ?)').run(rowid, `extra-${index}`, rowid, form);
    database.prepare('INSERT INTO paragraph_fts(rowid, form) VALUES (?, ?)').run(rowid, form);
  }
  database.close();

  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const searchesPath = chunkPath(world, 'searches');
  const beforeInvalid = await readFile(searchesPath, 'utf8');
  const cliFailure = await runCli(['search-batch', '--dir', world.root], JSON.stringify({
    requests: [{ sense: 's1', forms: ['새벽안개'], cursor: 'not-a-recorded-cursor' }],
  }), {
    TYPEWRITER_APPROVED_CORPUS_DB: world.options.databasePath,
  });
  assert.notEqual(cliFailure.code, 0);
  assert.match(cliFailure.stderr, /INVALID_CURSOR: s1/u);
  assert.equal(await readFile(searchesPath, 'utf8'), beforeInvalid, 'CLI input errors produce no persistent SEARCH_FAILED row');
  await assert.rejects(searchActive({
    ref: 's1', forms: ['새벽안개'], cursor: 'not-a-recorded-cursor', databasePath: world.options.databasePath, root: world.root,
  }), /INVALID_CURSOR: s1/u);
  assert.equal(await readFile(searchesPath, 'utf8'), beforeInvalid, 'invalid cursor input appends no failure evidence');

  const previous = beforeInvalid.split('\n').filter(Boolean).map(JSON.parse).find((entry) => entry.record_id === 'w001' && entry.forms[0] === '새벽안개');
  assert.equal(previous.status, 'LIMITED', 'prepare-issued cursor is persisted as unfinished evidence');
  const failedContinuation = {
    ...previous,
    status: 'SEARCH_FAILED',
    hits: 0,
    complete: false,
    cursor_in: previous.cursor_out,
    cursor_out: null,
    source: 'search',
  };
  await writeFile(searchesPath, `${beforeInvalid}${JSON.stringify(failedContinuation)}\n`);
  const withFailedContinuation = await readFile(searchesPath, 'utf8');
  await assert.rejects(searchActive({
    ref: 's1', contexts: 8, databasePath: world.options.databasePath, root: world.root,
  }), /continuation of this cursor chain has recorded SEARCH_FAILED/u);
  assert.equal(await readFile(searchesPath, 'utf8'), withFailedContinuation, 'cursorless retry preserves failed continuation evidence');
  await assert.rejects(searchActive({
    ref: 's1', cursor: 'next', databasePath: world.options.databasePath, root: world.root,
  }), /continuation of this cursor chain has recorded SEARCH_FAILED/u);
  assert.equal(await readFile(searchesPath, 'utf8'), withFailedContinuation, 'next is also blocked after a failed continuation');
  await assert.rejects(searchBatchActive({
    requests: [{ sense: 's1', cursor: 'next' }], databasePath: world.options.databasePath, root: world.root,
  }), /continuation of this cursor chain has recorded SEARCH_FAILED/u);
  assert.equal(await readFile(searchesPath, 'utf8'), withFailedContinuation, 'search-batch records no evidence after a failed continuation');
  await writeFile(searchesPath, beforeInvalid);

  const altered = JSON.parse(Buffer.from(previous.cursor_out, 'base64url').toString('utf8'));
  altered.after += 1;
  const forged = Buffer.from(JSON.stringify(altered), 'utf8').toString('base64url');
  await assert.rejects(searchActive({ ref: 's1', forms: ['새벽안개'], cursor: forged, databasePath: world.options.databasePath, root: world.root }), /INVALID_CURSOR: s1/u);
  assert.equal(await readFile(searchesPath, 'utf8'), beforeInvalid, 'a well-formed but altered cursor is not recorded');

  const next = await searchActive({ ref: 's1', cursor: 'next', contexts: 4, databasePath: world.options.databasePath, root: world.root });
  assert.equal(next.result.status, 'LIMITED');
  assert.ok(next.result.items.length > 0);
  const afterNext = await readFile(searchesPath, 'utf8');
  await assert.rejects(searchActive({
    ref: 's1', contexts: 8, databasePath: world.options.databasePath, root: world.root,
  }), /unfinished LIMITED search already exists/u, 'changing only contexts must not restart the same incomplete search');
  assert.equal(await readFile(searchesPath, 'utf8'), afterNext, 'a duplicate first-page request preserves the cursor chain');
  const recorded = (await readFile(searchesPath, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.record_id === 'w001' && entry.forms[0] === '새벽안개');
  assert.equal(recorded.at(-1).cursor_in, previous.cursor_out, 'resolved token is persisted verbatim');
  assert.notEqual(recorded.at(-1).cursor_out, previous.cursor_out, 'pagination advances to a new cursor');
  const compareDb = openReadonlyDb(world.options.databasePath);
  try {
    const firstPage = searchContexts(compareDb, ['새벽안개'], { maxSamples: 4, snippetChars: 220 });
    const secondPage = searchContexts(compareDb, ['새벽안개'], { maxSamples: 4, snippetChars: 220, cursor: previous.cursor_out });
    assert.deepEqual(next.result.items.map((item) => item.paragraph_rowid), secondPage.items.map((item) => item.paragraph_rowid));
    assert.equal(firstPage.items.some((item) => next.result.items.some((nextItem) => nextItem.paragraph_rowid === item.paragraph_rowid)), false, 'resumed contexts do not repeat the first page');
  } finally {
    compareDb.close();
  }
  const third = await searchActive({ ref: 's1', cursor: 'next', contexts: 4, databasePath: world.options.databasePath, root: world.root });
  assert.ok(third.result.items.length > 0);
  const afterThird = (await readFile(searchesPath, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.record_id === 'w001' && entry.forms[0] === '새벽안개');
  assert.equal(afterThird.at(-1).cursor_in, recorded.at(-1).cursor_out, 'a cursor issued by single search can itself be resumed with next');

  const manualStart = await searchActive({
    ref: 's1', forms: ['새벽안개'], boundary: 'left', contexts: 1,
    databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(manualStart.result.status, 'LIMITED', 'a distinct manual boundary starts a new condition');
  const beforeDuplicate = await readFile(searchesPath, 'utf8');
  await assert.rejects(searchActive({
    ref: 's1', forms: ['새벽안개'], boundary: 'left', contexts: 8,
    databasePath: world.options.databasePath, root: world.root,
  }), /unfinished LIMITED search already exists/u);
  assert.equal(await readFile(searchesPath, 'utf8'), beforeDuplicate);
  const manualNext = await searchActive({
    ref: 's1', forms: ['새벽안개'], boundary: 'left', cursor: 'next', contexts: 2,
    databasePath: world.options.databasePath, root: world.root,
  });
  assert.ok(manualNext.result.items.length > 0, 'the exact manual forms order and boundary resumes successfully');
});

withWorld('single and batch continuation SEARCH_FAILED is returned, persisted, and blocks save', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const active = await meta(world);
  const batchRef = active.senses.find((sense) => sense.record_id === 'w001' && !sense.auto).ref;
  const singleRef = active.senses.find((sense) => sense.record_id === 'w002' && !sense.auto).ref;
  const forms = ['새벽안개가', 'bad\u0000form'];
  const searchesPath = chunkPath(world, 'searches');

  const firstBatch = await searchBatchActive({
    requests: [{ sense: batchRef, forms, contexts: 1 }], databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(firstBatch.results[0].status, 'LIMITED');
  const failedBatch = await searchBatchActive({
    requests: [{ sense: batchRef, forms, contexts: 1, cursor: 'next' }], databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(failedBatch.status, 'SEARCH_FAILED');
  assert.equal(failedBatch.results[0].status, 'SEARCH_FAILED');
  assert.equal(failedBatch.requests[0].decision_state.state, 'SEARCH_FAILED');
  const batchEntries = (await readFile(searchesPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const batchFailure = batchEntries.findLast((entry) => entry.record_id === 'w001' && JSON.stringify(entry.forms) === JSON.stringify(forms));
  assert.equal(batchFailure.status, 'SEARCH_FAILED');
  assert.equal(batchFailure.cursor_in, firstBatch.results[0].cursor_out);

  const decisionsPath = chunkPath(world, 'decisions');
  const decisions = active.senses.filter((sense) => !sense.auto).map((sense) => `${sense.ref} Z`).join('\n');
  await writeFile(decisionsPath, `${decisions}\n`);
  await assert.rejects(saveActive({ inputPath: decisionsPath, root: world.root }), (error) => {
    assert.equal(error.exitCode, 2);
    assert.match(error.message, /search evidence integrity error/u);
    return true;
  });
  const rejected = JSON.parse(await readFile(chunkPath(world, 'rejected'), 'utf8'));
  assert.equal(rejected.repair_scope, 'stop_and_report');
  assert.equal(existsSync(path.join(world.directory, 'chunk-001.jsonl')), false);

  const firstSingle = await searchActive({
    ref: singleRef, forms, contexts: 1, databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(firstSingle.result.status, 'LIMITED');
  const failedSingle = await searchActive({
    ref: singleRef, forms, cursor: 'next', contexts: 1, databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(failedSingle.result.status, 'SEARCH_FAILED');
  assert.equal(failedSingle.decision_state.state, 'SEARCH_FAILED');
  const singleEntries = (await readFile(searchesPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const singleFailure = singleEntries.findLast((entry) => entry.record_id === 'w002' && JSON.stringify(entry.forms) === JSON.stringify(forms));
  assert.equal(singleFailure.status, 'SEARCH_FAILED');
  assert.equal(singleFailure.cursor_in, firstSingle.result.next_cursor);
});

withWorld('a failed first-page attempt does not block successful single or batch retry pagination', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const active = await meta(world);
  const searchesPath = chunkPath(world, 'searches');
  const database = new DatabaseSync(world.options.databasePath);
  const terms = ['단일재시도검색어', '배치재시도검색어'];
  terms.forEach((term, termIndex) => {
    for (let index = 0; index < 10; index += 1) {
      const rowid = 3000 + termIndex * 20 + index;
      const form = `${term} 뒤의 문맥 ${index}.`;
      database.prepare('INSERT INTO paragraphs VALUES (?, 1, ?, ?, ?)').run(rowid, `retry-${rowid}`, rowid, form);
      database.prepare('INSERT INTO paragraph_fts(rowid, form) VALUES (?, ?)').run(rowid, form);
    }
  });
  database.close();

  const failedStart = (forms) => ({
    ...cursorEvidence('w001', forms, undefined, null),
    status: 'SEARCH_FAILED', hits: 0, complete: false, cursor_in: null, cursor_out: null,
    chunk_no: active.chunk_no, view_sha256: active.view_sha256,
  });
  const prior = await readFile(searchesPath, 'utf8');
  await writeFile(searchesPath, `${prior}${terms.map((term) => JSON.stringify(failedStart([term]))).join('\n')}\n`);

  const singleFirst = await searchActive({ ref: 's1', forms: [terms[0]], contexts: 4, databasePath: world.options.databasePath, root: world.root });
  assert.equal(singleFirst.result.status, 'LIMITED');
  const afterSingleFirstText = await readFile(searchesPath, 'utf8');
  const afterSingleFirst = afterSingleFirstText.trim().split('\n').map(JSON.parse);
  const singleCursor = afterSingleFirst.findLast((entry) => entry.record_id === 'w001' && entry.forms[0] === terms[0]);
  assert.equal(singleCursor.status, 'LIMITED');
  await assert.rejects(searchActive({
    ref: 's1', forms: [terms[0]], contexts: 4, databasePath: world.options.databasePath, root: world.root,
  }), /unfinished LIMITED search already exists/u, 'a successful retry still blocks a duplicate cursorless search');
  assert.equal(await readFile(searchesPath, 'utf8'), afterSingleFirstText, 'duplicate retry adds no evidence');
  const singleNext = await searchActive({
    ref: 's1', forms: [terms[0]], cursor: 'next', contexts: 4, databasePath: world.options.databasePath, root: world.root,
  });
  assert.notEqual(singleNext.result.status, 'SEARCH_FAILED');
  const afterSingleNext = (await readFile(searchesPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const singleContinuation = afterSingleNext.findLast((entry) => entry.record_id === 'w001' && entry.forms[0] === terms[0]);
  assert.equal(singleContinuation.cursor_in, singleCursor.cursor_out);

  const batchRequest = (term, cursor = undefined) => ({ sense: 's1', forms: [term], contexts: 4, ...(cursor === undefined ? {} : { cursor }) });
  const batchFirst = await searchBatchActive({
    requests: [batchRequest(terms[1])], databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(batchFirst.status, 'OK');
  assert.equal(batchFirst.results[0].status, 'LIMITED');
  const afterBatchFirstText = await readFile(searchesPath, 'utf8');
  const afterBatchFirst = afterBatchFirstText.trim().split('\n').map(JSON.parse);
  const batchCursor = afterBatchFirst.findLast((entry) => entry.record_id === 'w001' && entry.forms[0] === terms[1]);
  await assert.rejects(searchBatchActive({
    requests: [batchRequest(terms[1])], databasePath: world.options.databasePath, root: world.root,
  }), /unfinished LIMITED search already exists/u, 'a successful batch retry still blocks duplicate cursorless search');
  assert.equal(await readFile(searchesPath, 'utf8'), afterBatchFirstText, 'duplicate batch retry adds no evidence');
  const batchNext = await searchBatchActive({
    requests: [batchRequest(terms[1], 'next')], databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(batchNext.status, 'OK');
  assert.notEqual(batchNext.results[0].status, 'SEARCH_FAILED');
  const afterBatchNext = (await readFile(searchesPath, 'utf8')).trim().split('\n').map(JSON.parse);
  const batchContinuation = afterBatchNext.findLast((entry) => entry.record_id === 'w001' && entry.forms[0] === terms[1]);
  assert.equal(batchContinuation.cursor_in, batchCursor.cursor_out);
});

withWorld('search-batch cursor next resumes its recorded cursor and rejects a mixed invalid batch atomically', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const searchesPath = chunkPath(world, 'searches');
  const beforeInvalid = await readFile(searchesPath, 'utf8');
  await assert.rejects(searchBatchActive({
    requests: [
      { sense: 's1', forms: ['새벽안개', '새벽안개가'], boundary: 'both' },
      { sense: 's4', forms: ['다른검색형'] },
      { sense: 's2', forms: ['새벽안개'], cursor: 'borrowed-token' },
    ],
    databasePath: world.options.databasePath, root: world.root,
  }), /INVALID_CURSOR: s2/u);
  assert.equal(await readFile(searchesPath, 'utf8'), beforeInvalid, 'one invalid request writes no partial batch evidence');

  const first = await searchBatchActive({
    requests: [{ sense: 's1', forms: ['새벽안개'], boundary: 'left', contexts: 1 }], databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(first.results[0].status, 'LIMITED');
  const firstCursor = first.results[0].cursor_out;
  const afterFirst = await readFile(searchesPath, 'utf8');
  await assert.rejects(searchBatchActive({
    requests: [{ sense: 's2', forms: ['새벽안개'], boundary: 'left', contexts: 4 }],
    databasePath: world.options.databasePath, root: world.root,
  }), /unfinished LIMITED search already exists/u, 'contexts alone cannot start a second search-batch cursor chain');
  assert.equal(await readFile(searchesPath, 'utf8'), afterFirst);
  const second = await searchBatchActive({
    requests: [{ sense: 's1', forms: ['새벽안개'], boundary: 'left', cursor: 'next', contexts: 1 }], databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(second.results[0].cursor_in, firstCursor);
  assert.notEqual(second.results[0].cursor_out, firstCursor);
  assert.notEqual(second.results[0].contexts[0].paragraph_rowid, first.results[0].contexts[0].paragraph_rowid);
  const database = openReadonlyDb(world.options.databasePath);
  try {
    const secondPage = searchContexts(database, ['새벽안개'], { maxSamples: 1, snippetChars: 220, boundary: 'left', cursor: firstCursor });
    assert.deepEqual(first.results[0].contexts.map((item) => item.paragraph_rowid), searchContexts(database, ['새벽안개'], { maxSamples: 1, snippetChars: 220, boundary: 'left' }).items.map((item) => item.paragraph_rowid));
    assert.deepEqual(second.results[0].contexts.map((item) => item.paragraph_rowid), secondPage.items.map((item) => item.paragraph_rowid));
    assert.equal(first.results[0].contexts.some((item) => secondPage.items.some((nextItem) => nextItem.paragraph_rowid === item.paragraph_rowid)), false);
  } finally {
    database.close();
  }
  const recorded = (await readFile(searchesPath, 'utf8')).trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.record_id === 'w001' && entry.forms[0] === '새벽안개' && entry.source === 'search');
  assert.equal(recorded.at(-1).cursor_in, firstCursor, 'search-batch stores the resolved raw cursor');
});

withWorld('search-batch output overflow records no partial evidence', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const before = await readFile(chunkPath(world, 'searches'), 'utf8');
  await assert.rejects(searchBatchActive({
    requests: [{ sense: 's1' }], databasePath: world.options.databasePath, root: world.root, maxOutputBytes: 1,
  }), /No search evidence was recorded/u);
  assert.equal(await readFile(chunkPath(world, 'searches'), 'utf8'), before);
});

withWorld('save requires earlier chunks to exist and the same Canonical records as prepare', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 3 }); // chunk 3 has only automatic senses -> AUTO_COMPLETE
  // use chunk 1 as the active one, then remove nothing: order check is on chunk numbers below the active one
  await rm(path.join(world.directory, 'chunk-003.jsonl'));
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const active = await meta(world);
  const forged = { ...active, chunk_no: 2 };
  await writeFile(chunkPath(world, 'active'), JSON.stringify(forged));
  await writeFile(chunkPath(world, 'decisions'), 's1 V\n');
  await assert.rejects(saveActive({ inputPath: chunkPath(world, 'decisions'), root: world.root }), /active D metadata does not match its exact chunk path/u);
});

withWorld('chunk 002 reads and saves only its own paths when stale chunk 001 scratch remains', async (world) => {
  await mkdir(world.directory, { recursive: true });
  const canonical = canonicalRows();
  canonical[25].senses[0].pos = 'verb'; // keep one sense visible to the AI instead of AUTO_COMPLETE
  await writeFile(world.options.canonicalPath, `${canonical.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const firstRows = canonical.slice(0, 25).map((record) => ({
    record_id: record.id,
    senses: record.senses.map((sense) => ({ sense_id: sense.id, candidates: [] })),
  }));
  await writeFile(path.join(world.directory, 'chunk-001.jsonl'), `${firstRows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  const staleSearch = JSON.stringify({ chunk_no: 1, view_sha256: '1'.repeat(64), record_id: 'w001', status: 'SEARCH_FAILED' });
  await writeFile(chunkPath(world, 'view', 1), 'stale view 001\n');
  await writeFile(chunkPath(world, 'searches', 1), `${staleSearch}\n`);
  await writeFile(chunkPath(world, 'decisions', 1), 's1 V old decision\n');

  const result = await prepareChunk({ ...world.options, chunkNumber: 2 });
  assert.equal(result.status, 'READY');
  const active = await meta(world, 2);
  assert.equal(active.chunk_no, 2);
  assert.match(await view(world, 2), /chunk=002/u);
  const search2 = chunkPath(world, 'searches', 2);
  let entries = (await readFile(search2, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(entries.length > 0 && entries.every((entry) => entry.chunk_no === 2 && entry.view_sha256 === active.view_sha256));
  assert.equal(await readFile(chunkPath(world, 'searches', 1), 'utf8'), `${staleSearch}\n`);

  const activeSense = active.senses.find((item) => !item.auto);
  const source = canonical[25];
  const extra = await searchActive({ ref: activeSense.ref, forms: [source.lemma], databasePath: world.options.databasePath, root: world.root });
  assert.ok(['ZERO_HITS', 'COMPLETE', 'LIMITED', 'ALREADY_COMPLETE'].includes(extra.result.status));
  entries = (await readFile(search2, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(entries.every((entry) => entry.chunk_no === 2 && entry.view_sha256 === active.view_sha256));
  assert.equal(await readFile(chunkPath(world, 'searches', 1), 'utf8'), `${staleSearch}\n`);

  await writeFile(chunkPath(world, 'decisions', 2), `${activeSense.ref} Z\n`);
  await assert.rejects(saveActive({ inputPath: chunkPath(world, 'decisions', 1), root: world.root }), /decision file for active chunk 002/u);
  const saved = await saveActive({ inputPath: chunkPath(world, 'decisions', 2), root: world.root });
  assert.equal(saved.chunk_no, 2);
  assert.equal(existsSync(path.join(world.directory, 'chunk-002.jsonl')), true);
  assert.equal(await readFile(chunkPath(world, 'decisions', 1), 'utf8'), 's1 V old decision\n');
});

withWorld('active chunk ignores inactive legacy scratch from another batch and uses its own files', async (world) => {
  const previousDirectory = path.join(world.root, 'd-050_01');
  const currentDirectory = path.join(world.root, 'd-051_01');
  await mkdir(previousDirectory, { recursive: true });
  const previousLegacy = {
    decisions: 'decisions.txt',
    searches: 'searches.jsonl',
    rejected: 'save-rejected.json',
    view: 'active-chunk.txt',
    page: 'active-chunk.p1of2.txt',
  };
  const previousBytes = new Map();
  for (const [kind, name] of Object.entries(previousLegacy)) {
    const bytes = `old batch ${kind}\n`;
    await writeFile(path.join(previousDirectory, name), bytes);
    previousBytes.set(name, bytes);
  }

  await prepareChunk({ ...world.options, shard: '051', batch: '01', directory: currentDirectory, chunkNumber: 1 });
  const active = JSON.parse(await readFile(path.join(currentDirectory, 'active-001.json'), 'utf8'));
  const w001 = active.senses.find((sense) => sense.sense_id === 'w001-s1');
  const w003 = active.senses.find((sense) => sense.sense_id === 'w003-s1');
  const batch = await searchBatchActive({
    requests: [{ sense: w001.ref }], databasePath: world.options.databasePath, root: world.root,
  });
  assert.equal(batch.request_count, 1);
  const extra = await searchActive({
    ref: w003.ref, forms: ['달려서'], databasePath: world.options.databasePath, root: world.root,
  });
  assert.ok(['ZERO_HITS', 'COMPLETE', 'LIMITED'].includes(extra.result.status));

  const decisions = active.senses.filter((sense) => !sense.auto).map((sense) => {
    if (sense.sense_id.startsWith('w001')) return `${sense.ref} V 해무|새벽 공기`;
    if (sense.sense_id.startsWith('w005')) return `${sense.ref} V`;
    return `${sense.ref} Z`;
  }).join('\n');
  const decisionPath = path.join(currentDirectory, 'decision-001.txt');
  await writeFile(decisionPath, `${decisions}\n`);
  const saved = await saveActive({ inputPath: decisionPath, root: world.root });
  assert.equal(saved.chunk_no, 1);
  assert.equal(existsSync(path.join(currentDirectory, 'chunk-001.jsonl')), true);
  const currentSearches = (await readFile(path.join(currentDirectory, 'search-001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(currentSearches.length > 0 && currentSearches.every((entry) => entry.chunk_no === 1 && entry.view_sha256 === active.view_sha256));
  for (const [name, bytes] of previousBytes) assert.equal(await readFile(path.join(previousDirectory, name), 'utf8'), bytes);
});

withWorld('legacy active marker beside a new active chunk is ambiguous and preserves all files', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const activeBefore = await readFile(chunkPath(world, 'active'), 'utf8');
  const viewBefore = await readFile(chunkPath(world, 'view'), 'utf8');
  const legacy = {
    active: path.join(world.directory, 'active-chunk.json'),
    view: path.join(world.directory, 'active-chunk.txt'),
    decisions: path.join(world.directory, 'decisions.txt'),
    searches: path.join(world.directory, 'searches.jsonl'),
  };
  for (const [name, file] of Object.entries(legacy)) await writeFile(file, `legacy ${name}\n`);
  await assert.rejects(searchActive({ ref: 's1', databasePath: world.options.databasePath, root: world.root }), /more than one active D chunk/u);
  assert.equal(await readFile(chunkPath(world, 'active'), 'utf8'), activeBefore);
  assert.equal(await readFile(chunkPath(world, 'view'), 'utf8'), viewBefore);
  for (const [name, file] of Object.entries(legacy)) assert.equal(await readFile(file, 'utf8'), `legacy ${name}\n`);
});

withWorld('selected active chunk rejects and preserves a legacy paginated view', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const activeBefore = await readFile(chunkPath(world, 'active'), 'utf8');
  const viewBefore = await readFile(chunkPath(world, 'view'), 'utf8');
  const legacyPage = path.join(world.directory, 'active-chunk.p1of2.txt');
  await writeFile(legacyPage, 'legacy page\n');
  await assert.rejects(searchActive({ ref: 's1', databasePath: world.options.databasePath, root: world.root }), /legacy D scratch files are present/u);
  assert.equal(await readFile(chunkPath(world, 'active'), 'utf8'), activeBefore);
  assert.equal(await readFile(chunkPath(world, 'view'), 'utf8'), viewBefore);
  assert.equal(await readFile(legacyPage, 'utf8'), 'legacy page\n');
});

withWorld('legacy D scratch layout blocks prepare and stays byte-for-byte untouched', async (world) => {
  await mkdir(world.directory, { recursive: true });
  const legacy = {
    active: path.join(world.directory, 'active-chunk.json'),
    view: path.join(world.directory, 'active-chunk.txt'),
    decisions: path.join(world.directory, 'decisions.txt'),
    searches: path.join(world.directory, 'searches.jsonl'),
  };
  for (const [name, file] of Object.entries(legacy)) await writeFile(file, `legacy ${name}\n`);
  await assert.rejects(prepareChunk({ ...world.options, chunkNumber: 1 }), /legacy D scratch files are present/u);
  for (const [name, file] of Object.entries(legacy)) assert.equal(await readFile(file, 'utf8'), `legacy ${name}\n`);
  await assert.rejects(searchActive({ ref: 's1', databasePath: world.options.databasePath, root: world.root }), /legacy D scratch files are present/u);
});
