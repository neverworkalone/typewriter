import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { initialCodeOf, readAdjudications, readMeanings } from './contract.mjs';
import { readCanonicalEntries } from './initial.mjs';
import { projectMeaningRelations } from './project.mjs';
import { actualRelationProvenance, expectedRelationProvenance } from './projection-oracle.mjs';

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
    authored_relation_count: 0, authored_deduplicated_count: 0,
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
  const singleMeaning = (senseId) => {
    assert.deepEqual(rowFor(senseId).sense_ids, [senseId], `${senseId} must remain a single-sense Meaning`);
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

  // Source-bound risk recheck: a shared Korean form or broad topic does not merge independent compounds.
  distinctMeanings(['w171851-s1', 'w439234-s1']);
  sameMeaning(['w171851-s1', 'w171851-s2']);
  sameMeaning(['w439234-s1', 'w439234-s2']);

  distinctMeanings([
    'w171852-s1', 'w171853-s1', 'w171854-s1', 'w171855-s1', 'w439238-s1',
  ]);
  sameMeaning(['w171852-s1', 'w171852-s2']);
  sameMeaning(['w171854-s1', 'w171854-s2']);
  sameMeaning(['w439238-s1', 'w439238-s2']);
  singleMeaning('w171853-s1');
  singleMeaning('w171855-s1');

  sameMeaning(['w161248-s1', 'w161248-s2']);
  sameMeaning(['w161249-s1', 'w436738-s1']);
  const distinctStrengthCompounds = [
    'w161248-s1', 'w161249-s1', 'w161250-s1', 'w161253-s1',
  ];
  distinctMeanings(distinctStrengthCompounds);

  const distinctBuddhistDemonCompounds = ['w163982-s1', 'w163984-s1', 'w164994-s1'];
  for (const senseId of distinctBuddhistDemonCompounds) singleMeaning(senseId);
  distinctMeanings(distinctBuddhistDemonCompounds);

  for (const senseId of ['w166126-s1', 'w441026-s1', 'w166127-s1', 'w441027-s1']) singleMeaning(senseId);
  distinctMeanings(['w166126-s1', 'w441026-s1']);
  distinctMeanings(['w166127-s1', 'w441027-s1']);

  sameMeaning(['w171890-s1', 'w171892-s1']);
  singleMeaning('w439492-s1');
  distinctMeanings(['w171890-s1', 'w439492-s1']);
  distinctMeanings(['w171892-s1', 'w439492-s1']);

  distinctMeanings(['w165872-s1', 'w165873-s1']);

  // Positive controls: close source-bound uses remain grouped when their complete meanings connect.
  sameMeaning(['w168814-s1', 'w443545-s1']);
  sameMeaning(['w168813-s1', 'w443547-s1']);
  sameMeaning(['w179096-s1', 'w179097-s1']);
  sameMeaning(['w179098-s1', 'w446170-s1']);
  sameMeaning(['w183822-s1', 'w184118-s1', 'w439543-s1']);
  sameMeaning(['w200327-s1', 'w200622-s1']);
  sameMeaning(['w201283-s2', 'w201284-s2']);

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

  // 사비 distinguishes organization/dormitory outlays and the private purchase act from private expenditure.
  for (const senseId of ['w170076-s1', 'w170077-s1', 'w440112-s1']) singleMeaning(senseId);
  sameMeaning(['w440113-s1', 'w440113-s2']);
  distinctMeanings(['w170076-s1', 'w440113-s1']);
  distinctMeanings(['w170077-s1', 'w440113-s1']);
  distinctMeanings(['w440112-s1', 'w440113-s1']);

  // Nearby payment/giving groups were checked and retained because their complete source meanings share the transfer core.
  sameMeaning(['w166221-s1', 'w166222-s1']);
  sameMeaning(['w173815-s1', 'w173817-s1']);
  sameMeaning(['w173816-s1', 'w444519-s1']);

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

  const privateCost = rowFor('w440113-s1');
  const companyCost = rowFor('w170076-s1');
  const dormitoryPayment = rowFor('w170077-s1');
  const privateProvision = rowFor('w440112-s1');
  const expenseRecords = canonical.filter((record) => ['w440113', 'w394427'].includes(record.id));
  const { relations: expenseRelations } = projectMeaningRelations({ records: expenseRecords, meanings, adjudications });
  const privateCostAntonym = expenseRelations.find((relation) => relation.type === 'antonym'
    && relation.sources.some((source) => source.source_sense_id === 'w440113-s1'));
  assert.ok(privateCostAntonym, 'the canonical private-cost antonym to 공비 must be projected');
  assert.equal(privateCostAntonym.source_meaning_id, privateCost.id,
    'the private-cost antonym must originate only from the personal-expenditure Meaning');
  assert.equal(privateCostAntonym.target_meaning_id, rowFor('w394427-s1').id,
    'the private-cost antonym must still reach the 공비 Meaning');
  assert.deepEqual(privateCostAntonym.sources.map((source) => source.source_sense_id), ['w440113-s1']);
  for (const unrelated of [companyCost, dormitoryPayment, privateProvision]) {
    assert.notEqual(privateCostAntonym.source_meaning_id, unrelated.id,
      `${unrelated.sense_ids.join(', ')} must not inherit the 사비↔공비 antonym`);
  }
});

test('relation provenance groups by (source, target, type) for merged and split Meaning shapes', () => {
  // Two-way synonym pairs between a two-sense lemma on each side (C08 반송되다 / 환송되다 shape).
  const records = [
    rec('wa', [['wa-s1', [rel('wb-s1')]], ['wa-s2', [rel('wb-s2')]]]),
    rec('wb', [['wb-s1', [rel('wa-s1')]], ['wb-s2', [rel('wa-s2')]]]),
  ];
  const shapes = {
    'merged/merged': [meaning('ma', 'wa-s1', 'wa-s2'), meaning('mb', 'wb-s1', 'wb-s2')],
    'merged/split': [meaning('ma', 'wa-s1', 'wa-s2'), meaning('mb1', 'wb-s1'), meaning('mb2', 'wb-s2')],
    'split/merged': [meaning('ma1', 'wa-s1'), meaning('ma2', 'wa-s2'), meaning('mb', 'wb-s1', 'wb-s2')],
    'split/split': [meaning('ma1', 'wa-s1'), meaning('ma2', 'wa-s2'), meaning('mb1', 'wb-s1'), meaning('mb2', 'wb-s2')],
  };
  const expectedGroupCount = { 'merged/merged': 2, 'merged/split': 4, 'split/merged': 4, 'split/split': 4 };
  for (const [shape, meanings] of Object.entries(shapes)) {
    const { relations } = projectMeaningRelations({ records, meanings });
    const actual = actualRelationProvenance(relations);
    assert.deepEqual(actual, expectedRelationProvenance(records, meanings), shape);
    assert.equal(Object.keys(actual).length, expectedGroupCount[shape], shape);
    assert.equal(Object.values(actual).flat().length, 4, `${shape}: every source relation is preserved`);

    // Fail-closed controls: a lost source or a wrong target endpoint must be detected.
    const lost = relations.map((r) => ({ ...r, sources: r.sources.slice(1) }));
    assert.notDeepEqual(actualRelationProvenance(lost), actual, `${shape}: dropped provenance is detected`);
    const wrong = relations.map((r, index) => (index === 0 ? { ...r, target_meaning_id: 'mX' } : r));
    assert.notDeepEqual(actualRelationProvenance(wrong), actual, `${shape}: wrong endpoint is detected`);
  }
});

test('authored meaning relations are projected as typewriter-authored without provenance (Issue #797)', () => {
  const records = [rec('w1', [['w1-s1', [rel('w2-s1')]]]), rec('w2', [['w2-s1']]), rec('w3', [['w3-s1']])];
  const meanings = [
    { ...meaning('m1', 'w1-s1'), relations: [{ type: 'direct', target: 'm3', note: '표준국어대사전 참조 표제어' }] },
    meaning('m2', 'w2-s1'),
    meaning('m3', 'w3-s1'),
  ];
  const { relations, stats } = projectMeaningRelations({ records, meanings });
  assert.deepEqual(relations.map((r) => [r.source_meaning_id, r.target_meaning_id, r.type, r.position, r.origin]), [
    ['m1', 'm2', 'direct', 0, 'stdict-sense-projection'],
    ['m1', 'm3', 'direct', 1, 'typewriter-authored'],
  ]);
  // Authored relations carry no STDICT provenance: the product database forbids it for non-projected rows.
  assert.deepEqual(relations[1].sources, []);
  assert.equal(relations[1].note, '표준국어대사전 참조 표제어');
  assert.equal(relations[1].relevance, null);
  assert.equal(stats.authored_relation_count, 1);
  assert.equal(stats.projected_relation_count, 2);
});

test('an authored relation repeating a projected key is dropped, not duplicated', () => {
  const records = [rec('w1', [['w1-s1', [rel('w2-s1')]]]), rec('w2', [['w2-s1']])];
  const meanings = [
    { ...meaning('m1', 'w1-s1'), relations: [{ type: 'direct', target: 'm2', note: '중복' }] },
    meaning('m2', 'w2-s1'),
  ];
  const { relations, stats } = projectMeaningRelations({ records, meanings });
  assert.deepEqual(relations.map((r) => [r.source_meaning_id, r.target_meaning_id, r.origin]), [['m1', 'm2', 'stdict-sense-projection']]);
  assert.equal(stats.authored_deduplicated_count, 1);
  assert.equal(stats.authored_relation_count, 0);
});
