import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  INITIAL_CODES, OTHER_INITIAL_CODE, initialCodeOf, canonicalSensesFromContext, loadCanonicalSenses, meaningId, parseMeaningId,
  parseShardFileName, planShards, readAdjudications, readMeanings, shardFileName, validateAdjudicationRow,
  validateMeaningDataset, validateMeaningRow, writeAdjudications, writeMeanings,
} from './contract.mjs';
import { mkdirSync } from 'node:fs';
import { generateInitialMeanings, projectInitialMeanings } from './initial.mjs';
import { createCanonicalContext } from '../validate/canonical-context.mjs';
import { runChecks } from '../ci/run-category.mjs';
import { loadMeaningData } from './contract.mjs';
import { validateMeaningFiles } from './validate.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'meaning-'));
const row = (id, lemma, senses = [`${id.replace('m', 'w').split('_')[0]}-s1`]) => ({ id, lemma, gloss: `${lemma} 뜻`, sense_ids: senses });

test('initial mapping covers every choseong, jamo-independent of final consonant', () => {
  assert.equal(Object.keys(INITIAL_CODES).length, 19);
  assert.equal(initialCodeOf('가다'), 'c01');
  assert.equal(initialCodeOf('깎다'), 'c02');
  assert.equal(initialCodeOf('힣'), 'c19');
  assert.equal(initialCodeOf('까'), 'c02');
  for (const [jamo, code] of Object.entries(INITIAL_CODES)) assert.equal(initialCodeOf(jamo), code, jamo);
  assert.equal(initialCodeOf('ㄱ'), 'c01');
  assert.equal(initialCodeOf('ㅏ'), OTHER_INITIAL_CODE);
  assert.equal(initialCodeOf('apple'), OTHER_INITIAL_CODE);
  assert.equal(initialCodeOf(''), OTHER_INITIAL_CODE);
  assert.equal(new Set(Object.values(INITIAL_CODES)).size, 19);
});

test('meaning ids reuse the entry number; numbering need not be contiguous', () => {
  assert.equal(meaningId('w0097'), 'm0097');
  assert.equal(meaningId('w0097', 2), 'm0097_2');
  assert.deepEqual(parseMeaningId('m0097_2'), { entryId: 'w0097', ordinal: 2 });
  assert.deepEqual(parseMeaningId('m536222'), { entryId: 'w536222', ordinal: null });
  for (const bad of ['m', 'w0097', 'm0097_0', 'm0097_', 'm00x7']) assert.equal(parseMeaningId(bad), null);
  assert.throws(() => meaningId('m0097'));
  assert.equal(shardFileName('c01', 1), 'c01_001.jsonl');
  assert.deepEqual(parseShardFileName('c19_012.jsonl'), { code: 'c19', index: 12 });
  assert.equal(parseShardFileName('c1_1.jsonl'), null);
});

test('row schema accepts valid and rejects invalid meanings and adjudications', () => {
  assert.deepEqual(validateMeaningRow({ id: 'm0097_1', lemma: '가다', gloss: '이동하다.', sense_ids: ['w0097-s1', 'w0097-s3'] }), []);
  assert.deepEqual(validateMeaningRow({ id: 'm0097_1', lemma: '가다', gloss: '이동하다.', sense_ids: ['w0097-s1', 'w0098-s2'] }), []);
  const invalid = [
    { id: 'm0097_1', lemma: '가다', gloss: '이동하다.', sense_ids: [] },
    { id: 'm0097_1', lemma: '가다', gloss: '이동하다.', sense_ids: ['w0097-s1', 'w0097-s1'] },
    { id: 'm0097_1', lemma: ' 가다', gloss: '이동하다.', sense_ids: ['w0097-s1'] },
    { id: 'm0097_1', lemma: '가다', gloss: '', sense_ids: ['w0097-s1'] },
    { id: 'x1', lemma: '가다', gloss: '뜻', sense_ids: ['w1-s1'] },
    { id: 'm0097_1', lemma: '가다', gloss: '뜻', sense_ids: ['w0097-s1'], extra: 1 },
    null,
  ];
  for (const item of invalid) assert.notEqual(validateMeaningRow(item).length, 0, JSON.stringify(item));
  const ok = { sense_id: 'w2-s2', lemma: '가다', decision: 'drop', reason: 'duplicate', duplicate_of: 'w2-s1' };
  assert.deepEqual(validateAdjudicationRow(ok), []);
  const outOfScope = { sense_id: 'w2-s3', lemma: '가다', decision: 'drop', reason: 'out_of_scope' };
  assert.deepEqual(validateAdjudicationRow(outOfScope), []);
  assert.match(validateAdjudicationRow({ ...outOfScope, duplicate_of: 'w2-s1' }).join('\n'), /duplicate_of must be absent/u);
  for (const patch of [{ reason: 'other' }, { decision: 'keep' }, { duplicate_of: 'w2-s2' }, { duplicate_of: undefined }, { sense_id: 'x' }]) {
    assert.notEqual(validateAdjudicationRow({ ...ok, ...patch }).length, 0, JSON.stringify(patch));
  }
});

test('write -> read round-trips deterministically and removes stale shards', () => {
  const dir = tmp();
  const rows = [row('m0003', '다'), row('m0001_2', '가'), row('m0001_1', '가'), row('m0002', '나')];
  const files = writeMeanings(dir, rows);
  assert.deepEqual(files, ['c01_001.jsonl', 'c03_001.jsonl', 'c04_001.jsonl']);
  const { rows: back, errors } = readMeanings(dir);
  assert.deepEqual(errors, []);
  assert.deepEqual(back.map((item) => item.id), ['m0001_1', 'm0001_2', 'm0002', 'm0003']);
  const before = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8'));
  writeMeanings(dir, [...rows].reverse());
  assert.deepEqual(readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8')), before);
  writeMeanings(dir, [row('m0001', '가')]);
  assert.deepEqual(readdirSync(dir), ['c01_001.jsonl']);
});

test('shards never split a lemma and close only after the target is reached', () => {
  const rows = [];
  for (let i = 1; i <= 7; i += 1) rows.push(row(`m${i}`, `가${i < 4 ? 'a' : i < 6 ? 'b' : 'c'}`));
  const plan = planShards(rows, 'meaning', { target: 3 });
  assert.deepEqual([...plan].map(([file, items]) => [file, items.length]), [['c01_001.jsonl', 3], ['c01_002.jsonl', 4]]);
  const lemmas = [...plan.values()].map((items) => new Set(items.map((item) => item.lemma)));
  assert.equal([...lemmas[0]].filter((lemma) => lemmas[1].has(lemma)).length, 0);
  const dir = tmp();
  writeMeanings(dir, rows, { target: 3 });
  assert.deepEqual(readMeanings(dir).errors, []);
});

test('reader rejects placement violations', () => {
  const dir = tmp();
  const line = (item) => `${JSON.stringify(item)}\n`;
  writeFileSync(path.join(dir, 'c03_001.jsonl'), line(row('m1', '가')));
  assert.match(readMeanings(dir).errors.join('\n'), /belongs to c01, not c03/);
  const gap = tmp();
  writeFileSync(path.join(gap, 'c01_002.jsonl'), line(row('m1', '가')));
  assert.match(readMeanings(gap).errors.join('\n'), /contiguous/);
  const split = tmp();
  writeFileSync(path.join(split, 'c01_001.jsonl'), line(row('m1', '가')));
  writeFileSync(path.join(split, 'c01_002.jsonl'), line(row('m2', '가')));
  assert.match(readMeanings(split).errors.join('\n'), /split across/);
  const junk = tmp();
  writeFileSync(path.join(junk, 'notes.txt'), 'x');
  writeFileSync(path.join(junk, 'c01_001.jsonl'), JSON.stringify(row('m1', '가')));
  assert.match(readMeanings(junk).errors.join('\n'), /not a cXX_NNN|newline/);
});

test('reader enforces lemma-then-id row order inside and across shards, for both kinds', () => {
  const line = (item) => `${JSON.stringify(item)}\n`;
  const write = (files) => {
    const dir = tmp();
    for (const [name, items] of Object.entries(files)) writeFileSync(path.join(dir, name), items.map(line).join(''));
    return dir;
  };
  const order = /must be ordered/;
  assert.deepEqual(readMeanings(write({ 'c01_001.jsonl': [row('m1', '가'), row('m2', '가나')] })).errors, []);
  assert.match(readMeanings(write({ 'c01_001.jsonl': [row('m2', '가나'), row('m1', '가')] })).errors.join('\n'), order);
  assert.match(readMeanings(write({ 'c01_001.jsonl': [row('m1_2', '가'), row('m1_1', '가')] })).errors.join('\n'), order);
  assert.match(readMeanings(write({ 'c01_001.jsonl': [row('m9', '가나')], 'c01_002.jsonl': [row('m1', '가')] })).errors.join('\n'), order);
  const drop = (id, lemma) => ({ sense_id: id, lemma, decision: 'drop', reason: 'duplicate', duplicate_of: 'w1-s1' });
  assert.deepEqual(readAdjudications(write({ 'c01_001.jsonl': [drop('w3-s1', '가'), drop('w3-s2', '가')] })).errors, []);
  assert.match(readAdjudications(write({ 'c01_001.jsonl': [drop('w3-s2', '가'), drop('w3-s1', '가')] })).errors.join('\n'), order);
});

test('adjudication order compares (entry, sense) numerically, never concatenated digits', () => {
  const drop = (id) => ({ sense_id: id, lemma: '가', decision: 'drop', reason: 'duplicate', duplicate_of: 'w1-s1' });
  const ids = ['w7-s2', 'w7-s10', 'w7-s34', 'w8-s1', 'w10-s1'];
  const dir = tmp();
  writeAdjudications(dir, [...ids].reverse().map(drop));
  const back = readAdjudications(dir);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(back.rows.map((item) => item.sense_id), ids);
  const line = (item) => `${JSON.stringify(item)}\n`;
  const external = tmp();
  writeFileSync(path.join(external, 'c01_001.jsonl'), ['w7-s34', 'w8-s1'].map((id) => line(drop(id))).join(''));
  assert.deepEqual(readAdjudications(external).errors, []);
  const reversed = tmp();
  writeFileSync(path.join(reversed, 'c01_001.jsonl'), ['w8-s1', 'w7-s34'].map((id) => line(drop(id))).join(''));
  assert.match(readAdjudications(reversed).errors.join('\n'), /must be ordered/);
  const meanings = tmp();
  writeMeanings(meanings, [row('m10', '가'), row('m9', '가'), row('m9_1', '가')].slice(0, 2));
  assert.deepEqual(readMeanings(meanings).rows.map((item) => item.id), ['m9', 'm10']);
});

test('dataset validation rejects DROP-to-DROP in any order and stays linear on large input', () => {
  const drop = (id, of) => ({ sense_id: id, lemma: '가', decision: 'drop', reason: 'duplicate', duplicate_of: of });
  const forward = [drop('w1-s2', 'w1-s3'), drop('w1-s3', 'w1-s1')];
  assert.match(validateMeaningDataset({ meanings: [], adjudications: forward }).join('\n'), /w1-s2: duplicate_of w1-s3 is itself dropped/);
  assert.match(validateMeaningDataset({ meanings: [], adjudications: [...forward].reverse() }).join('\n'), /itself dropped/);
  const many = Array.from({ length: 50000 }, (_, i) => drop(`w${i + 2}-s2`, `w${i + 2}-s1`));
  const started = performance.now();
  assert.deepEqual(validateMeaningDataset({ meanings: [], adjudications: many }), []);
  assert.ok(performance.now() - started < 2000, 'validation must be linear in the number of DROP rows');
});

test('dataset validation: id shape, ownership, adjudication and canonical references', () => {
  const canonical = new Map([['w1-s1', { lemma: '가' }], ['w1-s2', { lemma: '가' }], ['w1-s3', { lemma: '가' }]]);
  const meanings = [row('m1_1', '가', ['w1-s1', 'w1-s2']), row('m1_2', '가', ['w1-s3'])];
  assert.deepEqual(validateMeaningDataset({ meanings, senses: canonical }), []);
  const drop = { sense_id: 'w1-s2', lemma: '가', decision: 'drop', reason: 'duplicate', duplicate_of: 'w1-s1' };
  const only = [row('m1', '가', ['w1-s1']), row('m1_1', '가', ['w1-s3'])];
  assert.match(validateMeaningDataset({ meanings: only }).join('\n'), /lone meaning/);
  assert.deepEqual(validateMeaningDataset({ meanings: [row('m1', '가', ['w1-s1', 'w1-s3'])], adjudications: [drop], senses: canonical }), []);
  assert.match(validateMeaningDataset({ meanings, adjudications: [drop] }).join('\n'), /still referenced/);
  assert.match(validateMeaningDataset({ meanings: [row('m1', '가', ['w1-s1']), row('m1', '가', ['w1-s3'])] }).join('\n'), /duplicate meaning id/);
  assert.match(validateMeaningDataset({ meanings: [row('m1_1', '가', ['w1-s1']), row('m1_2', '가', ['w1-s1'])] }).join('\n'), /referenced by both/);
  assert.match(validateMeaningDataset({ meanings: [row('m1', '가', ['w1-s9'])], senses: canonical }).join('\n'), /unknown canonical sense/);
  assert.match(validateMeaningDataset({ meanings: [row('m1', '나', ['w1-s1'])], senses: canonical }).join('\n'), /differs from canonical/);
  const chain = [drop, { ...drop, sense_id: 'w1-s3', duplicate_of: 'w1-s2' }];
  assert.match(validateMeaningDataset({ meanings: [row('m1', '가', ['w1-s1'])], adjudications: chain, senses: canonical }).join('\n'), /itself dropped/);
  const dir = tmp();
  writeAdjudications(dir, [drop]);
  assert.deepEqual(readAdjudications(dir), { rows: [drop], errors: [] });
});

test('real canonical layer: reference shapes resolve and canonical is read-only', () => {
  const canonicalDir = path.resolve(import.meta.dirname, '../../data/canonical');
  const digest = () => createHash('sha256').update(readFileSync(path.join(canonicalDir, 'stdict-0001.jsonl'))).digest('hex');
  const before = digest();
  const senses = loadCanonicalSenses(canonicalDir, { files: ['stdict-0001.jsonl'] });
  const [firstId, { lemma }] = [...senses][0];
  const entryId = firstId.split('-')[0];
  const dir = tmp();
  writeMeanings(dir, [{ id: meaningId(entryId), lemma, gloss: '확인용 뜻', sense_ids: [firstId] }]);
  const loaded = readMeanings(dir);
  assert.deepEqual(validateMeaningDataset({ meanings: loaded.rows, senses }), []);
  assert.equal(digest(), before);
});

test('every real canonical lemma initial maps consistently to a valid code', () => {
  const senses = loadCanonicalSenses(path.resolve(import.meta.dirname, '../../data/canonical'), { files: ['stdict-0002.jsonl'] });
  const seen = new Map();
  for (const { lemma } of senses.values()) {
    const first = [...lemma][0];
    if (!seen.has(first)) seen.set(first, initialCodeOf(lemma));
  }
  assert.equal(seen.get('ㄱ'), 'c01');
  for (const [first, code] of seen) {
    const isChoseong = Object.hasOwn(INITIAL_CODES, first) || (first >= '가' && first <= '힣');
    assert.equal(code === OTHER_INITIAL_CODE, !isChoseong, first);
  }
});

test('canonical-only edits break unchanged meaning/adjudication references (real-shaped canonical)', () => {
  const real = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../data/canonical/stdict-0001.jsonl'), 'utf8').split('\n')[1]);
  assert.ok(real.senses.length >= 2);
  const [keep, other] = real.senses.map((sense) => sense.id);
  const setup = (entry) => {
    const root = tmp();
    const canonical = path.join(root, 'canonical');
    mkdirSync(canonical);
    writeFileSync(path.join(canonical, 'stdict-0001.jsonl'), `${JSON.stringify(entry)}\n`);
    writeMeanings(path.join(root, 'meanings'), [{ id: meaningId(real.id), lemma: real.lemma, gloss: '뜻', sense_ids: [keep] }]);
    writeAdjudications(path.join(root, 'adjudication'), [{ sense_id: other, lemma: real.lemma, decision: 'drop', reason: 'duplicate', duplicate_of: keep }]);
    return () => loadMeaningData({ meaningsDirectory: path.join(root, 'meanings'), adjudicationDirectory: path.join(root, 'adjudication'), canonicalDirectory: canonical }).errors;
  };
  assert.deepEqual(setup(real)(), []);
  assert.match(setup({ ...real, senses: real.senses.filter((sense) => sense.id !== keep) })().join('\n'), /unknown canonical sense/);
  assert.match(setup({ ...real, senses: real.senses.filter((sense) => sense.id !== other) })().join('\n'), /adjudicated unknown canonical sense/);
  assert.match(setup({ ...real, lemma: `${real.lemma}다` })().join('\n'), /differs from canonical/);
});

test('committed meaning and adjudication data satisfy the file contract without re-reading canonical', () => {
  // Canonical references of stored data are validated by the Normal in-process `meaning-references` check on the
  // shared session context; this isolated test must never re-parse the whole canonical revision.
  assert.deepEqual(validateMeaningFiles({ canonical: false }).errors, []);
  const root = tmp();
  writeMeanings(path.join(root, 'm'), [row('m1', '가', ['w1-s1'])]);
  const args = { meaningsDirectory: path.join(root, 'm'), adjudicationDirectory: path.join(root, 'a') };
  assert.deepEqual(loadMeaningData({ ...args, canonicalDirectory: null }).errors, []);
  assert.throws(() => loadMeaningData({ ...args, canonicalDirectory: '/nonexistent/canonical' }), /ENOENT/, 'stored rows + canonicalDirectory do read canonical');
});

test('Normal meaning check reuses the shared canonical context instead of reading canonical again', async () => {
  const records = [
    { id: 'w1', lemma: '가', search_forms: ['가'], senses: [{ id: 'w1-s1' }, { id: 'w1-s2' }] },
    { id: 'w2', lemma: '나', search_forms: ['나'], senses: [{ id: 'w2-s1' }] },
  ];
  const canonicalContext = createCanonicalContext({ records, fileCount: 1 }, { canonicalDirectory: '/nonexistent/canonical' });
  const fromContext = canonicalSensesFromContext(canonicalContext);
  assert.deepEqual([...fromContext], [['w1-s1', { lemma: '가' }], ['w1-s2', { lemma: '가' }], ['w2-s1', { lemma: '나' }]]);
  // Shared-context references are validated without touching any canonical directory.
  const root = tmp();
  writeMeanings(path.join(root, 'm'), [row('m1', '가', ['w1-s1']), row('m2', '나', ['w2-s1'])]);
  const args = { meaningsDirectory: path.join(root, 'm'), adjudicationDirectory: path.join(root, 'a'), canonicalDirectory: '/nonexistent/canonical' };
  assert.deepEqual(loadMeaningData({ ...args, senses: fromContext }).errors, []);
  assert.match(loadMeaningData({ ...args, senses: new Map([['w2-s1', { lemma: '나' }]]) }).errors.join('\n'), /unknown canonical sense/);
  assert.throws(() => loadMeaningData(args), /ENOENT/);
  // The real runner path: the registered Normal in-process check runs on the session context.
  const check = { label: 'meaning', inProcess: 'meaning-references', command: () => ({ executable: '[in-process]', args: [] }) };
  // The committed full corpus does not resolve against this tiny context, which proves the check uses the context.
  await assert.rejects(runChecks([check], { canonicalContext }, { log: () => {} }), /Meaning data invalid/);
});

test('initial projection: one sense = one meaning, deterministic ids, canonical gloss, complete coverage (synthetic)', () => {
  const entries = [
    { id: 'w001', lemma: '가다', senses: [{ id: 'w001-s1', gloss: 'A' }] },
    { id: 'w002', lemma: '가다', senses: [{ id: 'w002-s1', gloss: 'B' }, { id: 'w002-s3', gloss: 'C' }] },
    { id: 'w003', lemma: 'abc', senses: [{ id: 'w003-s1', gloss: 'D' }] },
  ];
  const rows = projectInitialMeanings(entries);
  assert.deepEqual(rows.map((r) => [r.id, r.sense_ids[0], r.gloss]), [
    ['m001', 'w001-s1', 'A'], ['m002_1', 'w002-s1', 'B'], ['m002_3', 'w002-s3', 'C'], ['m003', 'w003-s1', 'D'],
  ]);
  const senses = new Map(entries.flatMap((e) => e.senses.map((s) => [s.id, { lemma: e.lemma }])));
  assert.deepEqual(validateMeaningDataset({ meanings: rows, senses, complete: true }), []);
  const missing = validateMeaningDataset({ meanings: rows.slice(1), senses, complete: true });
  assert.ok(missing.some((e) => e.startsWith('w001-s1: canonical sense has no meaning')));
  // An adjudicated drop counts as covered; incomplete mode never demands coverage.
  const dropped = { sense_id: 'w001-s1', lemma: '가다', decision: 'drop', reason: 'duplicate', duplicate_of: 'w002-s1' };
  assert.deepEqual(validateMeaningDataset({ meanings: rows.slice(1), adjudications: [dropped], senses, complete: true }), []);
  assert.deepEqual(validateMeaningDataset({ meanings: rows.slice(1), senses }), []);
  const dir = tmp();
  writeMeanings(dir, rows);
  const first = readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8'));
  writeMeanings(dir, projectInitialMeanings(entries));
  assert.deepEqual(readdirSync(dir).map((f) => readFileSync(path.join(dir, f), 'utf8')), first);
});

test('edited corpus (merge, gloss edit, DROP) stays valid under the complete contract; omissions fail', () => {
  const entries = [
    { id: 'w001', lemma: '가다', senses: [{ id: 'w001-s1', gloss: 'A' }, { id: 'w001-s2', gloss: 'B' }, { id: 'w001-s3', gloss: 'C' }] },
    { id: 'w002', lemma: '가다', senses: [{ id: 'w002-s1', gloss: 'D' }] },
  ];
  const senses = new Map(entries.flatMap((e) => e.senses.map((s) => [s.id, { lemma: e.lemma }])));
  const edited = [
    { id: 'm001_1', lemma: '가다', gloss: '편집된 뜻', sense_ids: ['w001-s1', 'w001-s2'] },
    { id: 'm002', lemma: '가다', gloss: 'D', sense_ids: ['w002-s1'] },
  ];
  const drop = { sense_id: 'w001-s3', lemma: '가다', decision: 'drop', reason: 'duplicate', duplicate_of: 'w001-s1' };
  assert.deepEqual(validateMeaningDataset({ meanings: edited, adjudications: [drop], senses, complete: true }), []);
  assert.ok(validateMeaningDataset({ meanings: edited, senses, complete: true }).some((e) => e.startsWith('w001-s3: canonical sense has no meaning')));
});

test('out_of_scope covers a product-excluded sense without redirect and does not auto-exclude future c20 senses', () => {
  const senses = new Map([
    ['w020-s1', { lemma: 'ㅏ' }],
    ['w021-s1', { lemma: 'apple' }],
  ]);
  const meanings = [row('m021', 'apple', ['w021-s1'])];
  const outOfScope = { sense_id: 'w020-s1', lemma: 'ㅏ', decision: 'drop', reason: 'out_of_scope' };
  assert.deepEqual(validateMeaningDataset({ meanings, adjudications: [outOfScope], senses, complete: true }), []);

  senses.set('w022-s1', { lemma: 'ㅑ' });
  assert.match(
    validateMeaningDataset({ meanings, adjudications: [outOfScope], senses, complete: true }).join('\n'),
    /w022-s1: canonical sense has no meaning and is not dropped/u,
  );

  const redirecting = { ...outOfScope, reason: 'duplicate', duplicate_of: 'w021-s1' };
  assert.match(
    validateMeaningDataset({ meanings, adjudications: [redirecting], senses }).join('\n'),
    /duplicate_of w021-s1 has lemma apple, not ㅏ/u,
  );
});

test('real data: committed meanings satisfy the file contract without re-reading canonical', () => {
  // Canonical references and completeness of the stored corpus are checked once, by the Normal in-process
  // `meaning-references` check on the shared session context. Equality with the initial projection is a one-off
  // manual check (`node scripts/meaning/initial.mjs --check`), not a standing invariant.
  // The impossible canonical directory is injected into the real wrapper: any canonical read would throw ENOENT.
  const missingCanonical = '/nonexistent/canonical';
  const { meanings, errors } = validateMeaningFiles({ canonical: false, canonicalDirectory: missingCanonical });
  assert.deepEqual(errors, []);
  assert.ok(meanings.length > 0);
  // Positive probe: the same injection does trip when canonical is requested, so the guard above is effective.
  assert.throws(() => validateMeaningFiles({ canonicalDirectory: missingCanonical }), /ENOENT/);
  // A stored row plus an impossible canonical directory proves the opt-out never scans canonical.
  const root = tmp();
  writeMeanings(path.join(root, 'm'), [row('m1', '가', ['w1-s1'])]);
  const args = { meaningsDirectory: path.join(root, 'm'), adjudicationDirectory: path.join(root, 'a') };
  assert.deepEqual(loadMeaningData({ ...args, canonicalDirectory: null, complete: true }).errors, []);
  // The shared-context path enforces completeness: an uncovered canonical sense fails, a covered one passes.
  const senses = new Map([['w1-s1', { lemma: '가' }], ['w1-s2', { lemma: '가' }]]);
  assert.match(loadMeaningData({ ...args, senses, complete: true }).errors.join('\n'), /w1-s2: canonical sense has no meaning/);
  assert.deepEqual(loadMeaningData({ ...args, senses: new Map([['w1-s1', { lemma: '가' }]]), complete: true }).errors, []);
});

test('cross-record MERGE: same lemma passes, different lemma fails, duplicate_of must share the lemma', () => {
  const senses = new Map([['w1-s1', { lemma: '가' }], ['w1-s2', { lemma: '가' }], ['w2-s1', { lemma: '가' }], ['w3-s1', { lemma: '나' }]]);
  const errorsOf = (meanings, adjudications = []) => validateMeaningDataset({ meanings, adjudications, senses }).join('\n');
  assert.equal(errorsOf([row('m1_1', '가', ['w1-s1', 'w1-s2'])]), '');
  assert.equal(errorsOf([row('m1_1', '가', ['w1-s1', 'w2-s1'])]), '');
  assert.match(errorsOf([row('m2_1', '가', ['w1-s1', 'w2-s1'])]), /lowest member record \(w1\)/);
  assert.equal(errorsOf([row('m1_2', '가', ['w2-s1', 'w1-s2'])]), '');
  assert.equal(errorsOf([row('m2_1', '가', ['w2-s1'])]), '');
  const padded = new Map([['w0097-s1', { lemma: '가' }], ['w0100-s1', { lemma: '가' }]]);
  const paddedErrors = (id, ids) => validateMeaningDataset({ meanings: [row(id, '가', ids)], senses: padded }).join('\n');
  assert.equal(paddedErrors('m0097_1', ['w0100-s1', 'w0097-s1']), '');
  assert.match(paddedErrors('m97_1', ['w0097-s1', 'w0100-s1']), /lowest member record \(w0097\)/);
  assert.equal(paddedErrors('m0097', ['w0097-s1']), '');
  assert.match(paddedErrors('m97', ['w0097-s1']), /lowest member record/);
  const big = new Map([['w9007199254740992-s1', { lemma: '가' }], ['w9007199254740993-s1', { lemma: '가' }], ['w00097-s1', { lemma: '가' }], ['w0097-s1', { lemma: '가' }]]);
  const bigErrors = (id, ids) => validateMeaningDataset({ meanings: [row(id, '가', ids)], senses: big }).join('\n');
  assert.equal(bigErrors('m9007199254740992_1', ['w9007199254740993-s1', 'w9007199254740992-s1']), '');
  assert.match(bigErrors('m9007199254740993_1', ['w9007199254740992-s1', 'w9007199254740993-s1']), /lowest member record \(w9007199254740992\)/);
  assert.equal(bigErrors('m00097_1', ['w0097-s1', 'w00097-s1']), '');
  assert.match(bigErrors('m0097_1', ['w0097-s1', 'w00097-s1']), /lowest member record \(w00097\)/);
  const bigRows = [{ id: 'm9007199254740993', lemma: '가', gloss: 'g', sense_ids: ['w9007199254740993-s1'] }, { id: 'm9007199254740992', lemma: '가', gloss: 'g', sense_ids: ['w9007199254740992-s1'] }];
  assert.deepEqual(planShards(bigRows, 'meaning').get('c01_001.jsonl').map((r) => r.id), ['m9007199254740992', 'm9007199254740993']);
  const ordinalRows = ['m1_9007199254740993', 'm1_9007199254740992', `m1_${'9'.repeat(400)}`, 'm1_2'].map((id) => row(id, '가', ['w1-s1']));
  assert.deepEqual(planShards(ordinalRows, 'meaning').get('c01_001.jsonl').map((r) => r.id), ['m1_2', 'm1_9007199254740992', 'm1_9007199254740993', `m1_${'9'.repeat(400)}`]);
  const tied = [row('m0097', '가', ['w0097-s1']), row('m00097', '가', ['w00097-s1'])];
  const tiedIds = (rows) => planShards(rows, 'meaning').get('c01_001.jsonl').map((r) => r.id);
  assert.deepEqual(tiedIds(tied), tiedIds([...tied].reverse()));
  assert.deepEqual(tiedIds(tied), ['m00097', 'm0097']);
  const adj = (id) => ({ sense_id: id, lemma: '가', decision: 'drop', reason: 'duplicate', duplicate_of: 'w1-s1' });
  const tiedAdj = [adj('w0097-s2'), adj('w00097-s2')];
  const adjIds = (rows) => planShards(rows, 'adjudication').get('c01_001.jsonl').map((r) => r.sense_id);
  assert.deepEqual(adjIds(tiedAdj), adjIds([...tiedAdj].reverse()));
  const tieDir = tmp();
  for (const [kind, rows, reader] of [['meaning', tied, readMeanings], ['adjudication', tiedAdj, readAdjudications]]) {
    const dir = path.join(tieDir, kind);
    mkdirSync(dir);
    const ordered = [...(kind === 'meaning' ? tiedIds(rows) : adjIds(rows))];
    const byKey = (key) => rows.find((r) => (r.id ?? r.sense_id) === key);
    const write = (keys) => writeFileSync(path.join(dir, 'c01_001.jsonl'), keys.map((k) => `${JSON.stringify(byKey(k))}\n`).join(''));
    write(ordered);
    assert.deepEqual(reader(dir).errors, []);
    write([...ordered].reverse());
    assert.match(reader(dir).errors.join('\n'), /rows must be ordered/);
  }
  const ordDir = tmp();
  mkdirSync(path.join(ordDir, 'm'));
  writeFileSync(path.join(ordDir, 'm', 'c01_001.jsonl'), [ordinalRows[0], ordinalRows[1]].map((r) => `${JSON.stringify(r)}\n`).join(''));
  assert.match(readMeanings(path.join(ordDir, 'm')).errors.join('\n'), /rows must be ordered/);
  assert.match(paddedErrors('m0100_1', ['w0097-s1', 'w0100-s1']), /lowest member record/);
  assert.match(errorsOf([row('m1_1', '가', ['w1-s1', 'w3-s1'])]), /differs from canonical/);
  assert.match(errorsOf([row('m1_1', '가', ['w1-s1']), row('m2_1', '가', ['w1-s1', 'w2-s1'])]), /referenced by both/);
  const drop = { sense_id: 'w2-s1', lemma: '가', decision: 'drop', reason: 'duplicate', duplicate_of: 'w1-s1' };
  assert.equal(errorsOf([row('m1_1', '가', ['w1-s1'])], [drop]), '');
  assert.match(errorsOf([row('m1_1', '가', ['w1-s1', 'w2-s1'])], [drop]), /still referenced/);
  assert.match(errorsOf([], [{ ...drop, duplicate_of: 'w9-s1' }]), /unknown duplicate_of/);
  assert.match(errorsOf([], [{ ...drop, duplicate_of: 'w3-s1' }]), /has lemma 나, not 가/);
  assert.match(errorsOf([], [drop, { ...drop, sense_id: 'w1-s2', duplicate_of: 'w2-s1' }]), /itself dropped/);
});

/** Synthetic canonical (3 entries, one with two senses) and a snapshot helper for the overwrite guard. */
function guardFixture() {
  const root = tmp();
  const canonicalDirectory = path.join(root, 'canonical');
  mkdirSync(canonicalDirectory);
  const entry = (id, lemma, glosses) => ({ id, lemma, senses: glosses.map((gloss, i) => ({ id: glosses.length === 1 ? `${id}-s1` : `${id}-s${i + 1}`, gloss })) });
  writeFileSync(path.join(canonicalDirectory, 'a.jsonl'), [entry('w1', '가다', ['움직이다']), entry('w2', '나무', ['식물', '재료']), entry('w3', '다리', ['신체'])].map((e) => `${JSON.stringify(e)}\n`).join(''));
  const meaningsDirectory = path.join(root, 'meanings');
  const adjudicationDirectory = path.join(root, 'adjudication');
  const options = { canonicalDirectory, meaningsDirectory, adjudicationDirectory };
  const snapshot = () => {
    const out = {};
    for (const dir of [canonicalDirectory, meaningsDirectory, adjudicationDirectory]) {
      if (!existsSync(dir)) { out[dir] = null; continue; }
      for (const file of readdirSync(dir).sort()) out[`${dir}/${file}`] = readFileSync(path.join(dir, file), 'utf8');
    }
    return JSON.stringify(out);
  };
  return { options, snapshot, meaningsDirectory, adjudicationDirectory };
}

test('initial generator: empty corpus generates, identical corpus is a no-op', () => {
  const { options, meaningsDirectory } = guardFixture();
  assert.equal(generateInitialMeanings(options).written, true);
  const first = readMeanings(meaningsDirectory);
  assert.deepEqual(first.errors, []);
  assert.equal(first.rows.length, 4);
  assert.equal(generateInitialMeanings(options).written, false);
});

test('initial generator refuses MERGE, edited gloss, DROP and stray files with no change at all', () => {
  const edits = {
    merge: ({ meaningsDirectory }) => {
      const { rows } = readMeanings(meaningsDirectory);
      const [a, b, ...rest] = rows;
      writeMeanings(meaningsDirectory, [{ ...a, sense_ids: [...a.sense_ids, ...rows.find((r) => r.lemma === '나무').sense_ids] }, ...rest.filter((r) => r.lemma !== '나무'), b].filter((r) => r.lemma !== '나무' || r === a));
    },
    gloss: ({ meaningsDirectory }) => {
      const { rows } = readMeanings(meaningsDirectory);
      rows[0] = { ...rows[0], gloss: '편집된 뜻' };
      writeMeanings(meaningsDirectory, rows);
    },
    drop: ({ adjudicationDirectory }) => writeAdjudications(adjudicationDirectory, [{ sense_id: 'w2-s2', lemma: '나무', decision: 'drop', reason: 'duplicate', duplicate_of: 'w2-s1' }]),
    extraMeaning: ({ meaningsDirectory }) => {
      const { rows } = readMeanings(meaningsDirectory);
      writeMeanings(meaningsDirectory, [...rows, row('m9', '라면', ['w9-s1'])]);
    },
  };
  for (const [name, edit] of Object.entries(edits)) {
    const fixture = guardFixture();
    generateInitialMeanings(fixture.options);
    edit(fixture);
    const before = fixture.snapshot();
    assert.throws(() => generateInitialMeanings(fixture.options), /editing has started/, name);
    assert.equal(fixture.snapshot(), before, `${name}: no file changed`);
  }
});

test('initial generator refuses adjudication-only state, with or without force, leaving both directories unchanged', () => {
  const fixture = guardFixture();
  writeAdjudications(fixture.adjudicationDirectory, [{ sense_id: 'w2-s2', lemma: '나무', decision: 'drop', reason: 'duplicate', duplicate_of: 'w2-s1' }]);
  const before = fixture.snapshot();
  assert.throws(() => generateInitialMeanings(fixture.options), /adjudication data exists/);
  assert.throws(() => generateInitialMeanings({ ...fixture.options, force: true }), /even with force/);
  assert.equal(fixture.snapshot(), before);
});

test('force reset restores a consistent initial corpus when no adjudication exists', () => {
  const fixture = guardFixture();
  generateInitialMeanings(fixture.options);
  const { rows } = readMeanings(fixture.meaningsDirectory);
  rows[0] = { ...rows[0], gloss: '편집된 뜻' };
  writeMeanings(fixture.meaningsDirectory, rows);
  assert.throws(() => generateInitialMeanings(fixture.options), /editing has started/);
  assert.equal(generateInitialMeanings({ ...fixture.options, force: true }).written, true);
  const senses = loadCanonicalSenses(fixture.options.canonicalDirectory);
  assert.deepEqual(validateMeaningDataset({ meanings: readMeanings(fixture.meaningsDirectory).rows, adjudications: [], senses, complete: true }), []);
});

test('initial generator CLI (temp root): --check and default run follow the repository state and never alter edited data', () => {
  const script = path.resolve(import.meta.dirname, 'initial.mjs');
  const fixture = guardFixture();
  const root = path.dirname(fixture.meaningsDirectory);
  const cliRoot = path.join(root, 'cli');
  mkdirSync(path.join(cliRoot, 'data'), { recursive: true });
  symlinkSync(fixture.options.canonicalDirectory, path.join(cliRoot, 'data/canonical'));
  symlinkSync(fixture.meaningsDirectory, path.join(cliRoot, 'data/meanings'));
  symlinkSync(fixture.adjudicationDirectory, path.join(cliRoot, 'data/adjudication'));
  const run = (...args) => spawnSync(process.execPath, [script, '--root', cliRoot, ...args], { encoding: 'utf8' });
  // meaning/adjudication directories must exist for the symlinks above to resolve; the default run creates meanings.
  mkdirSync(fixture.meaningsDirectory, { recursive: true });
  mkdirSync(fixture.adjudicationDirectory, { recursive: true });
  assert.equal(run().status, 0);
  assert.equal(run('--check').status, 0);
  assert.equal(run().status, 0, 'rerun on the initial state is a no-op');
  const { rows } = readMeanings(fixture.meaningsDirectory);
  rows[0] = { ...rows[0], gloss: '편집된 뜻' };
  writeMeanings(fixture.meaningsDirectory, rows);
  const before = fixture.snapshot();
  assert.equal(run('--check').status, 1);
  const refused = run();
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /editing has started/);
  assert.equal(fixture.snapshot(), before, 'edited data is byte-identical after both CLI calls');
  assert.equal(run('--check').status, 1);
});

const ADVERBIAL_OBJECT_PARTICLE = /(?:[하않없있롭럽같르렵웁듯]게|히)를 포함한다/;

test('merged glosses never attach the object particle to an adverbial -게/-히 clause', () => {
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '../../data/meanings');
  const bad = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl'))) {
    for (const line of readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean)) {
      const meaning = JSON.parse(line);
      if (meaning.sense_ids.length > 1 && ADVERBIAL_OBJECT_PARTICLE.test(meaning.gloss)) bad.push(`${meaning.id} ${meaning.gloss}`);
    }
  }
  assert.deepEqual(bad, []);
  for (const bad of ['뚜렷하게를 포함한다', '어긋나지 아니하게를 포함한다', '확실히를 포함한다']) assert.ok(ADVERBIAL_OBJECT_PARTICLE.test(bad), bad);
  for (const ok of ['대게를 포함한다', '가게를 포함한다', '종이를 포함한다']) assert.ok(!ADVERBIAL_OBJECT_PARTICLE.test(ok), ok);
});
