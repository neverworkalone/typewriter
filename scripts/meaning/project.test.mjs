import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initialCodeOf, readAdjudications, readMeanings } from './contract.mjs';
import { readCanonicalEntries } from './initial.mjs';
import { projectMeaningRelations } from './project.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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

test('C10 source-bound Meaning boundaries prevent cross-record homonym relation leakage', () => {
  const meaningDir = path.join(root, 'data/meanings');
  const meaningRead = readMeanings(meaningDir);
  assert.deepEqual(meaningRead.errors, []);
  const meanings = meaningRead.rows;
  const adjudicationRead = readAdjudications(path.join(root, 'data/adjudication'));
  assert.deepEqual(adjudicationRead.errors, []);
  const adjudications = adjudicationRead.rows;
  const canonical = readCanonicalEntries(path.join(root, 'data/canonical'));
  const c10Senses = new Set(canonical
    .filter((record) => initialCodeOf(record.lemma) === 'c10')
    .flatMap((record) => (record.senses ?? []).map((sense) => sense.id)));
  const c10Adjudicated = adjudications.filter((item) => initialCodeOf(item.lemma) === 'c10');
  const c10Rows = meanings.filter((row) => initialCodeOf(row.lemma) === 'c10');
  const allRowsBySense = new Map();
  for (const row of meanings) {
    for (const senseId of row.sense_ids) allRowsBySense.set(senseId, row);
  }
  const rowBySense = new Map();
  for (const row of c10Rows) {
    for (const senseId of row.sense_ids) {
      assert.equal(rowBySense.has(senseId), false, `${senseId} must belong to only one C10 Meaning`);
      rowBySense.set(senseId, row);
    }
  }
  const adjudicatedIds = new Set(c10Adjudicated.map((item) => item.sense_id));
  assert.equal([...rowBySense.keys()].some((id) => adjudicatedIds.has(id)), false,
    'a C10 source sense cannot be both in a Meaning and adjudicated');
  assert.deepEqual([...new Set([...rowBySense.keys(), ...adjudicatedIds])].sort(), [...c10Senses].sort(),
    'each C10 canonical sense must be assigned to one Meaning or an explicit adjudication');

  const rowFor = (senseId) => {
    const row = allRowsBySense.get(senseId);
    assert.ok(row, `${senseId} must have a Meaning`);
    return row;
  };
  const sameMeaning = (senseIds) => {
    const rows = senseIds.map(rowFor);
    assert.equal(new Set(rows.map((row) => row.id)).size, 1, `${senseIds.join(', ')} must share a Meaning`);
    assert.deepEqual([...rows[0].sense_ids].sort(), [...senseIds].sort(),
      `${senseIds.join(', ')} must be the complete source membership of that Meaning`);
  };
  const distinctMeanings = (senseIds) => {
    const rows = senseIds.map(rowFor);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length,
      `${senseIds.join(', ')} must remain separate Meanings`);
  };

  // Six Stage 2 blockers: the source definitions describe independent compounds, not one word's extension.
  for (const [lemma, first, second] of [
    ['상민', 'w164979-s1', 'w164980-s1'],
    ['삼루', 'w173074-s1', 'w173076-s1'],
    ['상송', 'w180326-s1', 'w180335-s1'],
    ['상송하다', 'w180334-s1', 'w180336-s1'],
    ['사육', 'w167011-s1', 'w167013-s1'],
    ['사육하다', 'w167012-s1', 'w440007-s1'],
  ]) {
    assert.equal(rowFor(first).lemma, lemma, `${first}: expected source lemma`);
    assert.equal(rowFor(second).lemma, lemma, `${second}: expected source lemma`);
    distinctMeanings([first, second]);
  }

  // Risk-focused cross-record recheck: different full meanings had been joined by only a broad category.
  sameMeaning(['w165273-s1', 'w441863-s1']);
  sameMeaning(['w165275-s1', 'w165275-s2']);
  distinctMeanings(['w165273-s1', 'w165275-s1', 'w166654-s1']);

  sameMeaning(['w169133-s1', 'w169133-s2']);
  sameMeaning(['w442231-s1', 'w442231-s2', 'w442231-s3', 'w442231-s4']);
  distinctMeanings(['w169133-s1', 'w169135-s1', 'w442231-s1']);

  sameMeaning(['w440190-s1', 'w440190-s2']);
  distinctMeanings(['w440190-s1', 'w440192-s1']);

  sameMeaning(['w170662-s1', 'w170662-s2', 'w171262-s1']);
  sameMeaning(['w439514-s1', 'w439514-s2']);
  distinctMeanings(['w170662-s1', 'w439514-s1']);

  distinctMeanings(['w172179-s1', 'w172180-s1', 'w172181-s1', 'w172182-s1']);
  distinctMeanings(['w160764-s1', 'w440451-s1']);
  sameMeaning(['w440451-s1', 'w440451-s2']);

  // Positive control: the historical record senses of 사전 are one natural lexical extension.
  sameMeaning(['w173020-s1', 'w173020-s2']);

  const relevantRecords = canonical.filter((record) => ['w173076', 'w341062'].includes(record.id));
  const { relations } = projectMeaningRelations({ records: relevantRecords, meanings, adjudications });
  const leakageSense = rowFor('w173076-s1');
  const buddhistSense = rowFor('w173074-s1');
  const target = rowFor('w341062-s1');
  assert.notEqual(leakageSense.id, buddhistSense.id, 'liquid leakage and Buddhist afflictions are separate Meanings');
  const direct = relations.find((relation) => relation.sources.some((source) => source.source_sense_id === 'w173076-s1'));
  assert.ok(direct, 'the canonical direct synonym from the liquid-leakage sense must be projected');
  assert.equal(direct.source_meaning_id, leakageSense.id, 'the source relation must remain on the liquid-leakage Meaning');
  assert.equal(direct.target_meaning_id, target.id, 'the source relation must still reach its canonical synonym Meaning');
  assert.deepEqual(direct.sources.map((source) => source.source_sense_id), ['w173076-s1']);
  assert.equal(relations.some((relation) => relation.source_meaning_id === buddhistSense.id
    && relation.sources.some((source) => source.source_sense_id === 'w173076-s1')), false,
  'the liquid-leakage relation must not be projected from the Buddhist Meaning');
});
