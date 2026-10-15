import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  INITIAL_CODES, OTHER_INITIAL_CODE, initialCodeOf, loadCanonicalSenses, meaningId, parseMeaningId,
  parseShardFileName, planShards, readAdjudications, readMeanings, shardFileName, validateAdjudicationRow,
  validateMeaningDataset, validateMeaningRow, writeAdjudications, writeMeanings,
} from './contract.mjs';
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
  const invalid = [
    { id: 'm0097_1', lemma: '가다', gloss: '이동하다.', sense_ids: [] },
    { id: 'm0097_1', lemma: '가다', gloss: '이동하다.', sense_ids: ['w0098-s1'] },
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
  const senses = loadCanonicalSenses(canonicalDir);
  const [firstId, { lemma }] = [...senses][0];
  const entryId = firstId.split('-')[0];
  const dir = tmp();
  writeMeanings(dir, [{ id: meaningId(entryId), lemma, gloss: '확인용 뜻', sense_ids: [firstId] }]);
  const loaded = readMeanings(dir);
  assert.deepEqual(validateMeaningDataset({ meanings: loaded.rows, senses }), []);
  assert.equal(digest(), before);
});

test('every real canonical lemma initial maps consistently to a valid code', () => {
  const senses = loadCanonicalSenses(path.resolve(import.meta.dirname, '../../data/canonical'));
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

test('committed meaning and adjudication data satisfy the contract', () => {
  assert.deepEqual(validateMeaningFiles().errors, []);
});
