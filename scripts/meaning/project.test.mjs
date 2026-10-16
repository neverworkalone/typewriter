import assert from 'node:assert/strict';
import test from 'node:test';
import { projectMeaningRelations } from './project.mjs';

const rel = (target_sense, type = 'direct', note = 'n') => ({ target: target_sense.split('-')[0], target_sense, type, note });
const rec = (id, senses) => ({ id, senses: senses.map(([sid, relations = []]) => ({ id: sid, relations })) });
const meaning = (id, ...sense_ids) => ({ id, lemma: 'x', gloss: 'g', sense_ids });

test('projects sense relations onto meanings, deduplicates and keeps provenance', () => {
  const records = [
    rec('w1', [['w1-s1', [rel('w2-s1'), rel('w3-s1'), rel('w2-s1', 'antonym')]]]),
    rec('w2', [['w2-s1']]),
    rec('w3', [['w3-s1']]),
  ];
  // w2-s1 and w3-s1 are merged into one meaning: the two direct relations collapse into one.
  const meanings = [meaning('m1', 'w1-s1'), meaning('m2', 'w2-s1', 'w3-s1')];
  const { relations, stats } = projectMeaningRelations({ records, meanings });
  assert.deepEqual(relations.map((r) => [r.source_meaning_id, r.target_meaning_id, r.type, r.position]), [
    ['m1', 'm2', 'direct', 0],
    ['m1', 'm2', 'antonym', 1],
  ]);
  assert.deepEqual(relations[0].sources.map((s) => [s.source_sense_id, s.source_position]), [['w1-s1', 0], ['w1-s1', 1]]);
  assert.deepEqual(stats, {
    source_relation_count: 3, projected_relation_count: 2, redirected_relation_count: 0,
    skipped_out_of_scope_count: 0, skipped_unresolved_count: 0, skipped_self_count: 0, deduplicated_count: 1,
  });
});

test('redirects duplicate endpoints, skips out_of_scope, unresolved and self relations', () => {
  const records = [
    rec('w1', [['w1-s1', [rel('w2-s2'), rel('w3-s1'), rel('w4-s1'), rel('w1-s2')]]]),
    rec('w2', [['w2-s1'], ['w2-s2']]),
    rec('w3', [['w3-s1']]),
    rec('w4', [['w4-s1']]),
    rec('w5', [['w5-s1', [rel('w1-s1')]]]),
  ];
  const meanings = [meaning('m1', 'w1-s1', 'w1-s2'), meaning('m2', 'w2-s1'), meaning('m5', 'w5-s1')];
  const adjudications = [
    { sense_id: 'w2-s2', lemma: 'x', decision: 'drop', reason: 'duplicate', duplicate_of: 'w2-s1' },
    { sense_id: 'w3-s1', lemma: 'x', decision: 'drop', reason: 'out_of_scope' },
  ];
  const { relations, stats } = projectMeaningRelations({ records, meanings, adjudications });
  assert.deepEqual(relations.map((r) => [r.source_meaning_id, r.target_meaning_id]), [['m1', 'm2'], ['m5', 'm1']]);
  assert.deepEqual(relations[0].sources, [{ source_sense_id: 'w1-s1', source_position: 0, source_redirected: 0, target_redirected: 1 }]);
  assert.equal(stats.redirected_relation_count, 1);
  assert.equal(stats.skipped_out_of_scope_count, 1);
  assert.equal(stats.skipped_unresolved_count, 1);
  assert.equal(stats.skipped_self_count, 1);
});

test('a dropped duplicate source sense contributes its relations to the surviving meaning', () => {
  const records = [rec('w1', [['w1-s1'], ['w1-s2', [rel('w2-s1')]]]), rec('w2', [['w2-s1']])];
  const meanings = [meaning('m1', 'w1-s1'), meaning('m2', 'w2-s1')];
  const adjudications = [{ sense_id: 'w1-s2', lemma: 'x', decision: 'drop', reason: 'duplicate', duplicate_of: 'w1-s1' }];
  const run = () => projectMeaningRelations({ records, meanings, adjudications });
  assert.deepEqual(run().relations.map((r) => [r.source_meaning_id, r.target_meaning_id, r.sources[0].source_redirected]), [['m1', 'm2', 1]]);
  assert.deepEqual(run(), run());
});
