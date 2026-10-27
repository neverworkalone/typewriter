import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { openReadonlyDb, searchContexts } from './corpus-utility.mjs';

import {
  autoZCandidate,
  checkDecisions,
  parseDecisions,
  prepareChunk,
  recordEvidence,
  saveActive,
  searchActive,
  searchToCompletion,
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

test('searchToCompletion finishes 0-hit LIMITED pages inside one call and never fakes ZERO_HITS', () => {
  const page = (status, items = 0, cursor = null) => ({ status, items: Array.from({ length: items }, () => ({})), next_cursor: cursor });
  const run = (pages, options = {}, budget) => {
    const calls = [];
    const search = (forms, opts) => {
      calls.push(opts.cursor ?? null);
      return { result: pages[Math.min(calls.length - 1, pages.length - 1)] };
    };
    return { ...searchToCompletion(search, ['눈'], options, budget), calls };
  };
  const chain = (count) => [...Array.from({ length: count }, (_, at) => page('LIMITED', 0, `c${at + 1}`)), page('COMPLETE')];
  // 3+ empty LIMITED pages from the start -> ZERO_HITS, one call
  let out = run(chain(5));
  assert.equal(out.result.status, 'ZERO_HITS');
  assert.deepEqual(out.calls, [null, 'c1', 'c2', 'c3', 'c4', 'c5']);
  // a hit after empty pages stops the search at once (rest of the corpus is not scanned); LIMITED with contexts is kept
  out = run([page('LIMITED', 0, 'c1'), page('LIMITED', 0, 'c2'), page('LIMITED', 2, 'c3'), page('COMPLETE')]);
  assert.equal(out.result.items.length, 2);
  assert.equal(out.result.status, 'LIMITED');
  assert.equal(out.calls.length, 3);
  assert.equal(run([page('LIMITED', 3, 'c1')]).calls.length, 1, 'LIMITED with contexts is not scanned further');
  // first ZERO_HITS kept; failure kept
  assert.equal(run([page('ZERO_HITS')]).calls.length, 1);
  assert.equal(run([page('SEARCH_FAILED')]).result.status, 'SEARCH_FAILED');
  assert.equal(run([page('LIMITED', 0, 'c1'), page('SEARCH_FAILED')]).result.status, 'SEARCH_FAILED');
  // external cursor start: COMPLETE 0 is never converted, even after internal pages
  out = run([page('LIMITED', 0, 'c2'), page('COMPLETE')], { cursor: 'c1' });
  assert.equal(out.result.status, 'COMPLETE');
  assert.equal(out.cursorIn, 'c1');
  assert.equal(run([page('COMPLETE')], { cursor: 'c1' }).result.status, 'COMPLETE');
  // no progress (repeated cursor, also the external one) and the call limit fail closed
  out = run([page('LIMITED', 0, 'c1')]);
  assert.equal(out.result.status, 'SEARCH_FAILED');
  assert.match(out.result.error, /no progress/u);
  assert.equal(run([page('LIMITED', 0, 'c1')], { cursor: 'c1' }).result.status, 'SEARCH_FAILED');
  out = run(chain(10), {}, { maxCalls: 3 });
  assert.equal(out.result.status, 'SEARCH_FAILED');
  assert.match(out.result.error, /call limit/u);
});

test('searchToCompletion over a real index: multi-page zero, forms/boundary-bound cursors, external cursor', async () => {
  const world = await makeWorld();
  try {
    const database = openReadonlyDb(world.options.databasePath);
    const search = (forms, options) => ({ result: searchContexts(database, forms, { ...options, scanRows: 1 }) });
    const zero = searchToCompletion(search, ['마', '쿠'], {});
    assert.equal(zero.result.status, 'ZERO_HITS');
    assert.ok(zero.followups >= 3);
    const hit = searchToCompletion(search, ['기회'], { maxSamples: 4 });
    assert.ok(hit.result.items.length > 0, 'first hit is returned');
    const first = searchContexts(database, ['마', '쿠'], { scanRows: 1 });
    assert.equal(first.status, 'LIMITED');
    const external = searchToCompletion(search, ['마', '쿠'], { cursor: first.next_cursor });
    assert.equal(external.result.status, 'COMPLETE', 'external cursor never becomes ZERO_HITS');
    const other = searchToCompletion(search, ['마'], { cursor: first.next_cursor });
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
