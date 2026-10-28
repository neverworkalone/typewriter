import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { openReadonlyDb, searchContexts } from './corpus-utility.mjs';

import {
  autoZCandidate,
  buildChunk,
  buildSearchBatch,
  checkDecisions,
  parseDecisions,
  prepareChunk,
  recordEvidence,
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

async function makeWorld() {
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
  ['새벽안개가 마을을 덮었다.', '아침의 새벽안개는 차갑다.', '그는 기회 비용을 따져 보았다.'].forEach((form, index) => {
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

const meta = (world) => readFile(path.join(world.directory, 'active-chunk.json'), 'utf8').then(JSON.parse);
const view = (world) => readFile(path.join(world.directory, 'active-chunk.txt'), 'utf8');

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

withWorld('automatic Z is only mechanically proven noun ZERO_HITS; everything else is Z? or shown', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const saved = await meta(world);
  const refOf = (senseId) => saved.senses.find((item) => item.sense_id === senseId);
  assert.equal(refOf('w002-s1').auto, true, 'long Hangul noun, no hit for the form or any spaced spelling');
  assert.equal(refOf('w003-s1').auto, false, 'a verb is never automatic');
  assert.equal(refOf('w004-s1').auto, false, 'a 1-syllable noun is never automatic');
  assert.equal(refOf('w005-s1').auto, false, 'a spaced spelling has a hit: the AI must read it');
  const text = await view(world);
  assert.match(text, /## w003 달리다[\s\S]*?Z\?:/u);
  assert.match(text, /## w004 핫[\s\S]*?Z\?:/u);
  assert.match(text, /## w005 기회비용[\s\S]*?search: forms=기 회비용,기회 비용,기회비 용[\s\S]*?기회 비용을/u);
  assert.ok(!text.includes('## w002'), 'automatic Z records are not shown');
  assert.match(text.split('\n')[0], /auto_z=.*s\d+/u);
});

withWorld('a chunk whose senses are all mechanically proven ZERO_HITS is saved without an AI', async (world) => {
  const result = await prepareChunk({ ...world.options, chunkNumber: 2 });
  assert.equal(result.status, 'AUTO_COMPLETE');
  const rows = (await readFile(path.join(world.directory, 'chunk-002.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 25);
  assert.ok(rows.every((row) => row.senses.every((sense) => sense.candidates.length === 0)));
  assert.equal(existsSync(path.join(world.directory, 'active-chunk.json')), false);
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
  const world = await makeWorld();
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
    const other = searchForContexts(search, ['마'], { cursor: first.next_cursor });
    assert.equal(other.result.status, 'SEARCH_FAILED', 'a cursor of another form list is rejected');
    database.close();
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test('recordEvidence: hits add up per search; completion needs a proven start', () => {
  const e = (key, status, hits, complete, cursorIn = null, cursorOut = null) => ({
    record_id: 'r', key, status, hits, complete, cursor_in: cursorIn, cursor_out: cursorOut,
  });
  assert.deepEqual(recordEvidence([e('a', 'ZERO_HITS', 0, true)], 'r'), { searches: 1, hits: 0, allComplete: true });
  assert.deepEqual(recordEvidence([e('a', 'LIMITED', 0, false, null, 'x')], 'r'), { searches: 1, hits: 0, allComplete: false });
  // (a) fresh start completed internally
  assert.equal(recordEvidence([e('a', 'ZERO_HITS', 0, true)], 'r').allComplete, true);
  // (b) external cursor with no recorded origin: COMPLETE 0 is not proof
  assert.equal(recordEvidence([e('a', 'COMPLETE', 0, true, 'x')], 'r').allComplete, false);
  // (c) earlier page hit + later COMPLETE 0 -> hits > 0 (Z refused by checkDecisions)
  const withHit = recordEvidence([e('a', 'LIMITED', 3, false, null, 'x'), e('a', 'COMPLETE', 0, true, 'x')], 'r');
  assert.deepEqual(withHit, { searches: 1, hits: 3, allComplete: true });
  // chain: proven through recorded cursors; a cursor that was never recorded breaks it
  assert.equal(recordEvidence([e('a', 'LIMITED', 0, false, null, 'x'), e('a', 'LIMITED', 0, false, 'x', 'y'), e('a', 'COMPLETE', 0, true, 'y')], 'r').allComplete, true);
  assert.equal(recordEvidence([e('a', 'LIMITED', 0, false, null, 'x'), e('a', 'COMPLETE', 0, true, 'z')], 'r').allComplete, false);
  assert.equal(recordEvidence([e('a', 'COMPLETE', 0, true, 'q', 'x'), e('a', 'COMPLETE', 0, true, 'x')], 'r').allComplete, false, 'unproven pages stay unproven');
  // (d) another search key does not provide the origin
  assert.equal(recordEvidence([e('a', 'LIMITED', 0, false, null, 'x'), e('b', 'COMPLETE', 0, true, 'x')], 'r').allComplete, false);
  assert.deepEqual(recordEvidence([e('a', 'ZERO_HITS', 0, true), e('b', 'LIMITED', 3, false)], 'r'), { searches: 2, hits: 3, allComplete: false });
  assert.deepEqual(recordEvidence([], 'r'), { searches: 0, hits: 0, allComplete: false });
  assert.deepEqual(recordEvidence([e('a', 'COMPLETE', 2, true)], 'other'), { searches: 0, hits: 0, allComplete: false });
  const exact = { ...e('a', 'COMPLETE', 2, true), request_key: 'same request' };
  assert.deepEqual(recordEvidence([exact, exact], 'r'), { searches: 1, hits: 2, allComplete: true }, 'an exact duplicate request never doubles hits');
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
    { ...same('s1'), contexts: 3 },
    { ...same('s1'), cursor: 'external-cursor' },
    { ...same('s1'), forms: ['별도,검색형', '"인용"'] },
  ];
  const { output, evidence } = buildSearchBatch({ requests, meta: metaValue, records, search });
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
  assert.deepEqual(recordEvidence([...evidence, evidence[0]], 'w1'), { searches: 5, hits: 8, allComplete: false });
});

test('search-batch preserves mixed statuses and rejects unproven external cursors per record', () => {
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
      { sense: 's1', forms: ['shared'] },
      { sense: 's2', forms: ['shared'], cursor: 'external' },
      { sense: 's3', forms: ['shared'] },
      { sense: 's3', forms: ['zero'] },
      { sense: 's3', forms: ['fail'] },
    ],
    meta: metaValue, records, search,
  });
  assert.deepEqual(output.results.map((result) => result.status), ['COMPLETE', 'COMPLETE', 'ZERO_HITS', 'SEARCH_FAILED']);
  assert.equal(output.status, 'SEARCH_FAILED');
  assert.deepEqual(recordEvidence(evidence, 'w1'), { searches: 2, hits: 1, allComplete: false });
  assert.deepEqual(recordEvidence(evidence, 'w2'), { searches: 3, hits: 1, allComplete: false });
  const external = evidence.find((entry) => entry.record_id === 'w1' && entry.cursor_in === 'external');
  assert.equal(external.complete, true, 'raw page status remains accurate in the evidence');
  assert.equal(recordEvidence(evidence, 'w1').allComplete, false, 'raw COMPLETE does not bypass missing cursor provenance');
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

  const { output, evidence } = buildSearchBatch({ requests, meta: { senses }, records, search });
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
  assert.deepEqual(recordEvidence(evidence, 'w4'), { searches: 1, hits: 1, allComplete: false });
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
  const hit = (id) => ({ record_id: id, key: 'k', status: 'LIMITED', hits: 3, complete: false });
  const zero = (id) => ({ record_id: id, key: 'k', status: 'ZERO_HITS', hits: 0, complete: true });
  return { records, metaValue, hit, zero };
};

test('checkDecisions: evidence rules for V / N / Z, and Candidate v1 form rules, all reported together', () => {
  const { records, metaValue, hit, zero } = fixture();
  const run = (text, entries) => {
    const { decisions, errors } = parseDecisions(text);
    assert.deepEqual(errors, []);
    return checkDecisions({ meta: metaValue, records, entries, decisions, lemmaForms }).errors;
  };
  // valid-but-unusual: independent compound of the lemma, V with no candidates, N after a LIMITED search with hits
  assert.deepEqual(run('s1 V 건축가|설계도\ns2 V\ns3 N', [hit('w1'), hit('w2')]), []);
  // Z only with every recorded search complete and 0 hits
  assert.deepEqual(run('s1 Z\ns2 Z\ns3 Z', [zero('w1'), zero('w2')]), []);
  assert.match(run('s1 Z\ns2 Z\ns3 Z', [{ ...zero('w1'), status: 'LIMITED', complete: false }, zero('w2')]).join('\n'), /s1: Z needs/u);
  assert.match(run('s1 Z\ns2 Z\ns3 Z', [hit('w1'), zero('w2')]).join('\n'), /s2: Z needs/u);
  // V / N need contexts
  assert.match(run('s1 V\ns2 N\ns3 N', [zero('w1'), zero('w2')]).join('\n'), /s1: V needs[\s\S]*s2: N needs[\s\S]*s3: N needs/u);
  // missing, unknown, auto
  assert.match(run('s1 V\ns9 V', [hit('w1'), hit('w2')]).join('\n'), /s9: unknown[\s\S]*s2: missing[\s\S]*s3: missing/u);
  // one pass reports every class of candidate error
  const errors = run('s1 V 건축|건축(建築)|건축 |설계도|설계도\ns2 V 460미터\ns3 V', [hit('w1'), hit('w2')]).join('\n');
  assert.match(errors, /s1: candidate repeats source lemma/u);
  assert.match(errors, /s1: .*parenthetical annotation/u);
  assert.match(errors, /s1: duplicate candidate "설계도"/u);
  assert.match(errors, /s2: candidate "460미터" is a fragment/u);
});

withWorld('end to end: search records evidence, save stores the chunk once, a rejected save stores nothing', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const saved = await meta(world);
  const ref = (senseId) => saved.senses.find((item) => item.sense_id === senseId).ref;
  const open = saved.senses.filter((item) => !item.auto).map((item) => item.ref);
  const decisionsFile = path.join(world.root, 'decisions.txt');
  const lines = (overrides = {}) => open.map((id) => {
    if (overrides[id]) return `${id} ${overrides[id]}`;
    const sense = saved.senses.find((item) => item.ref === id).sense_id;
    return sense.startsWith('w001') ? `${id} V 해무|새벽 공기` : sense.startsWith('w005') ? `${id} V` : `${id} Z`;
  }).join('\n');

  // Z for a record without a complete zero is rejected, and nothing is stored (other lines were fine)
  await writeFile(decisionsFile, `${lines({ [ref('w005-s1')]: 'Z' })}\n`);
  await assert.rejects(saveActive({ inputPath: decisionsFile, root: world.root }), (error) => error.exitCode === 2 && /w005|s\d+: Z needs/u.test(error.message));
  assert.equal(existsSync(path.join(world.directory, 'chunk-001.jsonl')), false);

  // an AI search is recorded; a zero-hit search of another form keeps the record's Z valid
  const out = await searchActive({ ref: ref('w003-s1'), forms: ['달려서'], boundary: 'none', contexts: 16, databasePath: world.options.databasePath, root: world.root });
  assert.equal(out.result.status, 'ZERO_HITS');
  await assert.rejects(searchActive({ ref: 's99', databasePath: world.options.databasePath, root: world.root }), /not a sense of the active chunk/u);
  await assert.rejects(searchActive({ ref: ref('w003-s1'), contexts: 17, databasePath: world.options.databasePath, root: world.root }), /--contexts must be 1..16/u);

  await writeFile(decisionsFile, `${lines()}\n`);
  const done = await saveActive({ inputPath: decisionsFile, root: world.root });
  assert.equal(done.status, 'SAVED');
  const rows = (await readFile(path.join(world.directory, 'chunk-001.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 25);
  assert.deepEqual(rows[0], { record_id: 'w001', senses: [{ sense_id: 'w001-s1', candidates: ['해무', '새벽 공기'] }, { sense_id: 'w001-s2', candidates: ['해무', '새벽 공기'] }] });
  assert.deepEqual(rows[1].senses[0].candidates, [], 'automatic Z is stored as an empty sense');
  await assert.rejects(saveActive({ inputPath: decisionsFile, root: world.root }), /already saved/u);
});

withWorld('search-batch CLI accepts JSON on stdin and records one shared search per record', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const active = await meta(world);
  const refs = active.senses.filter((item) => item.record_id === 'w001').map((item) => item.ref);
  assert.equal(refs.length, 2);
  const result = await runCli(['search-batch', '--dir', world.root], JSON.stringify({ requests: refs.map((sense) => ({ sense })) }), {
    TYPEWRITER_APPROVED_CORPUS_DB: world.options.databasePath,
  });
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.status, 'OK');
  assert.equal(output.request_count, 2);
  assert.equal(output.result_count, 1);
  assert.equal(output.requests[0].result_id, output.requests[1].result_id);
  assert.equal(output.results[0].contexts.length, 2);
  const evidence = (await readFile(path.join(world.directory, 'searches.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    .filter((entry) => entry.record_id === 'w001' && entry.request_key !== undefined);
  assert.equal(evidence.length, 1, 'same-record senses share one request evidence row');
  assert.equal(evidence[0].source, 'prepare', 'the identical completed prepare search already supplies the record evidence');
  assert.equal(evidence[0].forms[0], '새벽안개');
});

withWorld('search-batch output overflow records no partial evidence', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const before = await readFile(path.join(world.directory, 'searches.jsonl'), 'utf8');
  await assert.rejects(searchBatchActive({
    requests: [{ sense: 's1' }], databasePath: world.options.databasePath, root: world.root, maxOutputBytes: 1,
  }), /No search evidence was recorded/u);
  assert.equal(await readFile(path.join(world.directory, 'searches.jsonl'), 'utf8'), before);
});

withWorld('save requires earlier chunks to exist and the same Canonical records as prepare', async (world) => {
  await prepareChunk({ ...world.options, chunkNumber: 3 }); // chunk 3 has only automatic senses -> AUTO_COMPLETE
  // use chunk 1 as the active one, then remove nothing: order check is on chunk numbers below the active one
  await rm(path.join(world.directory, 'chunk-003.jsonl'));
  await prepareChunk({ ...world.options, chunkNumber: 1 });
  const active = await meta(world);
  const forged = { ...active, chunk_no: 2 };
  await writeFile(path.join(world.directory, 'active-chunk.json'), JSON.stringify(forged));
  await writeFile(path.join(world.root, 'd.txt'), 's1 V\n');
  await assert.rejects(saveActive({ inputPath: path.join(world.root, 'd.txt'), root: world.root }), /chunk-001\.jsonl is missing|changed since prepare/u);
});
