import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actualRelationProvenance,
  expectedRelationProvenance,
  parseMeaningId,
  projectMeaningRelations,
  projectRecordMeanings,
  recordMeaningId,
} from '../scripts/build/record-meanings.mjs';
import { buildDictionary } from '../scripts/build/dictionary.mjs';

const rel = (target_sense, type = 'direct', note = 'n') => ({ target: target_sense.split('-')[0], target_sense, type, note });
const rec = (id, lemma, senses) => ({
  id,
  lemma,
  senses: senses.map(([sid, relations = [], gloss]) => ({ id: sid, gloss: gloss === undefined ? `${sid} 뜻풀이` : gloss, relations })),
});

test('record meaning ids: valid record ids map to m-ids, anything else is rejected', () => {
  assert.equal(recordMeaningId('w0097'), 'm0097');
  assert.deepEqual(parseMeaningId('m0097'), { entryId: 'w0097' });
  for (const bad of ['m0097', 'r001', 'w', 'w12a', '']) assert.throws(() => recordMeaningId(bad), TypeError, bad);
  // Legacy split ids (`m0097_2`) no longer exist in the canonical-only product.
  for (const bad of ['m0097_2', 'w0097', 'm', '']) assert.equal(parseMeaningId(bad), null, bad);
});

test('projection table: one record = one meaning holding all senses in order; valid-but-unusual shapes pass', () => {
  const cases = [
    ['single sense', [rec('w1', 'a', [['w1-s1']])], [['m1', ['w1-s1']]]],
    ['polysemy keeps every sense in one meaning', [rec('w2', 'a', [['w2-s1'], ['w2-s2'], ['w2-s3']])], [['m2', ['w2-s1', 'w2-s2', 'w2-s3']]]],
    ['homonym records of one lemma stay separate', [rec('w3', 'a', [['w3-s1']]), rec('w4', 'a', [['w4-s1'], ['w4-s2']])], [['m3', ['w3-s1']], ['m4', ['w4-s1', 'w4-s2']]]],
    ['non-contiguous ids', [rec('w9', 'b', [['w9-s1']]), rec('w100', 'b', [['w100-s1']])], [['m9', ['w9-s1']], ['m100', ['w100-s1']]]],
    ['record without senses has no meaning', [rec('w5', 'c', [])], []],
  ];
  for (const [name, records, expected] of cases) {
    const meanings = projectRecordMeanings(records);
    assert.deepEqual(meanings.map((m) => [m.id, m.sense_ids]), expected, name);
    for (const meaning of meanings) {
      const record = records.find((item) => recordMeaningId(item.id) === meaning.id);
      assert.equal(meaning.gloss, record.senses.map((sense) => sense.gloss).join('\n'), `${name}: gloss order`);
    }
  }
});

test('projection fail-closed controls: empty, multi-line or missing source gloss is rejected', () => {
  for (const gloss of ['', 'a\nb', null, 7]) {
    assert.throws(() => projectRecordMeanings([rec('w1', 'a', [['w1-s1', [], gloss]])]), /single-line/u, String(gloss));
  }
});

test('relation projection: dedup, provenance, self and unresolved skips, and the independent oracle agrees', () => {
  const records = [
    rec('w1', 'a', [['w1-s1', [rel('w2-s1'), rel('w2-s2'), rel('w2-s1', 'antonym'), rel('w1-s2'), rel('w9-s1')]], ['w1-s2', [rel('w3-s1', 'near')]]]),
    rec('w2', 'b', [['w2-s1'], ['w2-s2']]),
    rec('w3', 'c', [['w3-s1', [rel('w1-s1')]]]),
  ];
  const meanings = projectRecordMeanings(records);
  const { relations, stats } = projectMeaningRelations({ records, meanings });
  assert.deepEqual(relations.map((r) => [r.source_meaning_id, r.target_meaning_id, r.type, r.position]), [
    ['m1', 'm2', 'direct', 0],
    ['m1', 'm2', 'antonym', 1],
    ['m1', 'm3', 'near', 2],
    ['m3', 'm1', 'direct', 0],
  ]);
  assert.deepEqual(relations[0].sources.map((s) => [s.source_sense_id, s.source_position]), [['w1-s1', 0], ['w1-s1', 1]]);
  assert.deepEqual(stats, {
    source_relation_count: 7, projected_relation_count: 4, redirected_relation_count: 0,
    skipped_out_of_scope_count: 0, skipped_unresolved_count: 1, skipped_self_count: 1, deduplicated_count: 1,
  });
  assert.deepEqual(actualRelationProvenance(relations), expectedRelationProvenance(records, meanings));
  // A wrong attribution is detected by the oracle (fail control).
  const tampered = relations.map((r) => ({ ...r, sources: r.sources.slice(1) }));
  assert.notDeepEqual(actualRelationProvenance(tampered), expectedRelationProvenance(records, meanings));
});

test('removed legacy build options are rejected, never silently ignored', async () => {
  for (const option of ['meaningsDirectory', 'adjudicationDirectory']) {
    await assert.rejects(
      buildDictionary({ outputPath: '/nonexistent/never-built.sqlite', [option]: 'data/meanings' }),
      (error) => error.code === 'REMOVED_OPTION',
      option,
    );
  }
});
