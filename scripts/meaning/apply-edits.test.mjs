import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyEdits } from './apply-edits.mjs';
import { validateMeaningDataset, validateMeaningRow } from './contract.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const senses = (entry, count) => Array.from({ length: count }, (_, i) => `${entry}-s${i + 1}`);
const initial = (entry, lemma, count) => senses(entry, count).map((id, i) => ({
  id: count === 1 ? entry.replace('w', 'm') : `${entry.replace('w', 'm')}_${i + 1}`, lemma, gloss: `${lemma} 뜻 ${i + 1}`, sense_ids: [id],
}));
const allSenses = (...groups) => new Map(groups.flat().map((id) => [id, { lemma: id.startsWith('w2') ? '전락하다' : '가다' }]));

test('merge keeps the lowest member id, lists all sense_ids and covers every sense once', () => {
  const meanings = [...initial('w10', '가다', 4), ...initial('w11', '가다', 1)];
  const spec = { merges: [{ senses: ['w10-s3', 'w10-s1'], gloss: '합친 뜻' }] };
  const next = applyEdits({ meanings, adjudications: [] }, spec);
  assert.deepEqual(next.meanings.find((row) => row.id === 'm10_1'), { id: 'm10_1', lemma: '가다', gloss: '합친 뜻', sense_ids: ['w10-s1', 'w10-s3'] });
  assert.equal(next.meanings.some((row) => row.id === 'm10_3'), false);
  assert.deepEqual(validateMeaningDataset({ ...next, senses: allSenses(senses('w10', 4), senses('w11', 1)), complete: true }), []);
});

test('drop records a duplicate verdict across records and keeps the target meaning', () => {
  const meanings = [...initial('w20', '전락하다', 2), ...initial('w21', '전락하다', 1)];
  const next = applyEdits({ meanings, adjudications: [] }, { drops: [{ sense_id: 'w21-s1', duplicate_of: 'w20-s1' }] });
  assert.deepEqual(next.adjudications, [{ sense_id: 'w21-s1', lemma: '전락하다', decision: 'drop', reason: 'duplicate', duplicate_of: 'w20-s1' }]);
  assert.equal(next.meanings.some((row) => row.sense_ids.includes('w21-s1')), false);
  assert.deepEqual(validateMeaningDataset({ ...next, senses: allSenses(senses('w20', 2), senses('w21', 1)), complete: true }), []);
});

test('invalid edits are rejected whole: cross-record merge, re-edit, single-sense merge, dropped duplicate_of, unknown sense', () => {
  const meanings = [...initial('w30', '사전', 2), ...initial('w31', '사전', 1)];
  const reject = (spec, pattern) => assert.throws(() => applyEdits({ meanings, adjudications: [] }, spec), pattern);
  reject({ merges: [{ senses: ['w30-s1'], gloss: 'x' }] }, /at least two/u);
  reject({ merges: [{ senses: ['w30-s1', 'w30-s5'], gloss: 'x' }] }, /no meaning/u);
  reject({ merges: [{ senses: ['w30-s1', 'w30-s2'], gloss: 'x' }, { senses: ['w30-s2', 'w30-s1'], gloss: 'y' }] }, /more than once/u);
  reject({ merges: [{ senses: ['w30-s1', 'w30-s2'], gloss: ' ' }] }, /gloss/u);
  reject({ drops: [{ sense_id: 'w31-s1', duplicate_of: 'w31-s1' }] }, /differ/u);
  reject({ drops: [{ sense_id: 'w31-s1', duplicate_of: 'w30-s1' }, { sense_id: 'w30-s1', duplicate_of: 'w30-s2' }] }, /itself dropped|more than once/u);
  reject({ drops: [{ sense_id: 'w31-s1', duplicate_of: 'w99-s1' }] }, /no meaning/u);
  // Same record as the dropped sense: a missing target must be rejected exactly like another record's.
  reject({ drops: [{ sense_id: 'w30-s1', duplicate_of: 'w30-s99' }] }, /no meaning/u);
  reject({ drops: [{ sense_id: 'w30-s1', duplicate_of: 'w30-s2' }, { sense_id: 'w30-s2', duplicate_of: 'w31-s1' }] }, /itself dropped/u);
  reject({ merges: [{ senses: ['w30-s1', 'w31-s1'], gloss: 'x' }, { senses: ['w31-s1', 'w30-s2'], gloss: 'y' }] }, /more than once/u);
  reject({ drops: [{ sense_id: 'w31-s1', duplicate_of: 'w30-s1', reason: 'obsolete' }] }, /reason/u);
});

test('an already merged meaning cannot be merged again', () => {
  const meanings = initial('w40', '보다', 3);
  const once = applyEdits({ meanings, adjudications: [] }, { merges: [{ senses: ['w40-s1', 'w40-s2'], gloss: '둘' }] });
  assert.throws(() => applyEdits(once, { merges: [{ senses: ['w40-s1', 'w40-s3'], gloss: '셋' }] }), /already merged/u);
});

test('valid DROPs pass within one record and across records', () => {
  const meanings = [...initial('w30', '사전', 3), ...initial('w31', '사전', 1)];
  const sameRecord = applyEdits({ meanings, adjudications: [] }, { drops: [{ sense_id: 'w30-s2', duplicate_of: 'w30-s1' }] });
  assert.equal(sameRecord.adjudications.length, 1);
  const crossRecord = applyEdits({ meanings, adjudications: [] }, { drops: [{ sense_id: 'w31-s1', duplicate_of: 'w30-s3' }] });
  assert.equal(crossRecord.adjudications[0].duplicate_of, 'w30-s3');
});

test('senses of different records of the SAME lemma merge under the first sense id; other lemmas are rejected', () => {
  const meanings = [...initial('w50', '강피밥', 1), ...initial('w51', '강피밥', 1), ...initial('w52', '다른말', 1)];
  const next = applyEdits({ meanings, adjudications: [] }, { merges: [{ senses: ['w51-s1', 'w50-s1'], gloss: '합친 뜻' }] });
  assert.deepEqual(next.meanings.find((row) => row.id === 'm50'), { id: 'm50', lemma: '강피밥', gloss: '합친 뜻', sense_ids: ['w50-s1', 'w51-s1'] });
  assert.equal(next.meanings.some((row) => row.id === 'm51'), false);
  const known = new Map([['w50-s1', { lemma: '강피밥' }], ['w51-s1', { lemma: '강피밥' }], ['w52-s1', { lemma: '다른말' }]]);
  assert.deepEqual(validateMeaningDataset({ ...next, senses: known, complete: true }), []);
  assert.throws(() => applyEdits({ meanings, adjudications: [] }, { merges: [{ senses: ['w50-s1', 'w52-s1'], gloss: 'x' }] }), /different lemmas/u);
});

test('row contract: id derives from the first sense and sense_ids are in canonical order', () => {
  const ok = { id: 'm50', lemma: '가', gloss: 'g', sense_ids: ['w50-s1', 'w51-s1'] };
  assert.deepEqual(validateMeaningRow(ok), []);
  assert.match(validateMeaningRow({ ...ok, id: 'm51' }).join(), /first sense/u);
  assert.match(validateMeaningRow({ ...ok, sense_ids: ['w51-s1', 'w50-s1'] }).join(), /canonical order/u);
  assert.match(validateMeaningRow({ ...ok, sense_ids: ['w50-s1', 'w50-s1'] }).join(), /duplicate sense id/u);
});

test('pilot spec (#715) uses valid sense ids, unique members and never edits away a duplicate_of target', () => {
  const spec = JSON.parse(readFileSync(path.join(root, 'scripts/meaning/pilot-715.json'), 'utf8'));
  const seen = new Set();
  for (const merge of spec.merges) {
    assert.ok(merge.senses.length >= 2, 'merge of fewer than two senses');
    assert.equal(merge.gloss, merge.gloss.trim());
    for (const id of merge.senses) {
      assert.match(id, /^w\d+-s[1-9]\d*$/u);
      assert.equal(seen.has(id), false, `${id} used twice`);
      seen.add(id);
    }
  }
  for (const drop of spec.drops) {
    assert.equal(seen.has(drop.sense_id), false);
    assert.equal(seen.has(drop.duplicate_of), false, 'duplicate_of must not be edited away');
  }
});
