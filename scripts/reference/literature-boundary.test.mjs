import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateLabels, CRITERIA, pickHits, sampleCandidateIds, stratumPopulation, validateLabels } from './literature-boundary-judge.mjs';
import { summarize, toleranceVerdict, TOLERANCES } from './literature-boundary-measure.mjs';

// Synthetic, text-free fixtures only (#414 measurement and judged-sample contract).

const unit = (form, text, n) => ({ forms: [form], text, location_digest: String(n).padStart(64, '0') });

test('sample excludes the #392 validation cohort, is deterministic and bounded', () => {
  const ids = Array.from({ length: 50 }, (_, i) => `C000001-${String(i + 1).padStart(4, '0')}`);
  const excluded = ids.slice(0, 12);
  const sample = sampleCandidateIds(ids, excluded);
  assert.equal(sample.length, 30);
  assert.ok(sample.every((id) => !excluded.includes(id)));
  assert.deepEqual(sample, sampleCandidateIds([...ids].reverse(), excluded));
  assert.equal(sampleCandidateIds(ids, excluded, 5).length, 5);
});

test('hit picking separates boundary-kept from dropped units, de-duplicates and caps each side', () => {
  const units = [
    ...Array.from({ length: 5 }, (_, i) => unit('꼬리', '꾀꼬리 소리' + i, i)),
    ...Array.from({ length: 5 }, (_, i) => unit('꼬리', '꼬리를 흔든다' + i, 10 + i)),
    unit('꼬리', '꼬리를 흔든다0', 10), // duplicate location
  ];
  const picked = pickHits(units);
  assert.equal(picked.filter((hit) => hit.stratum === 'dropped').length, 3);
  assert.equal(picked.filter((hit) => hit.stratum === 'kept').length, 3);
  assert.equal(new Set(picked.map((hit) => hit.location_digest)).size, 6);
  assert.ok(picked.filter((hit) => hit.stratum === 'dropped').every((hit) => hit.text.startsWith('꾀꼬리')));
});

test('a unit matched by several forms is kept when any form starts an eojeol', () => {
  // `보다` only inside `쳐다보다`, `봤다` at an eojeol start: the retriever keeps this unit.
  const mixed = { forms: ['보다', '봤다'], text: '쳐다보다가 봤다', location_digest: '1'.repeat(64) };
  const [hit] = pickHits([mixed]);
  assert.equal(hit.stratum, 'kept');
  assert.equal(hit.form, '봤다');
  assert.equal(pickHits([{ ...mixed, forms: ['보다'] }])[0].stratum, 'dropped');
});

test('labels validate against a closed judge and typed other_word', () => {
  const judge = { kind: 'ai_delegate', name: 'judge-model', delegated_by: 'owner' };
  const ok = { judge, labels: { H001: { label: 'same_word' }, H002: { label: 'other_word', type: 'compound' }, H003: { label: 'unclear' } } };
  assert.deepEqual(validateLabels(ok, ['H001', 'H002', 'H003']), []);
  assert.ok(validateLabels({ ...ok, judge: { kind: 'owner_direct', name: 'x' } }, ['H001']).length > 0);
  assert.ok(validateLabels({ judge, labels: { H001: { label: 'other_word' } } }, ['H001']).length > 0);
  assert.ok(validateLabels({ judge, labels: { H001: { label: 'same_word', type: 'compound' } } }, ['H001']).length > 0);
  assert.ok(validateLabels(ok, ['H001', 'H009']).length > 0);
});

test('balanced control: when every unit is sampled the weighted rates equal the plain counts', () => {
  const mapping = {};
  const labels = {};
  const add = (id, stratum, label, type) => { mapping[id] = { stratum, population: 1, selected: 1 }; labels[id] = type ? { label, type } : { label }; };
  // 6 dropped: 5 other_word, 1 same_word; 6 kept: 1 other_word, 4 same_word, 1 unclear.
  ['a', 'b', 'c', 'd', 'e'].forEach((id) => add('D' + id, 'dropped', 'other_word', id === 'a' ? 'personal_name' : 'compound'));
  add('Df', 'dropped', 'same_word');
  add('Ka', 'kept', 'other_word', 'hanja_homograph');
  ['b', 'c', 'd', 'e'].forEach((id) => add('K' + id, 'kept', 'same_word'));
  add('Kf', 'kept', 'unclear');
  const result = aggregateLabels(mapping, labels);
  assert.deepEqual(result.unclear, { hits: 1, weighted_units: 1 });
  assert.equal(result.other_word_rate.substring, Number((6 / 11).toFixed(4)));
  assert.equal(result.other_word_rate.eojeol, 0.2);
  assert.ok(result.relative_other_word_reduction > CRITERIA.min_relative_other_word_reduction);
  assert.equal(result.same_word_dropped_share, 0.2); // 1 of 5 same_word units dropped > 10 %
  assert.equal(result.criteria_met, false);
  assert.deepEqual(result.other_word_by_type.personal_name, { dropped_weighted: 1, kept_weighted: 0 });
  assert.deepEqual(result.other_word_by_type.hanja_homograph, { dropped_weighted: 0, kept_weighted: 1 });
});

test('imbalanced strata cannot fake a pass: the small dropped stratum is not over-weighted (#414 review)', () => {
  // One candidate: 1 dropped unit (other_word) and 1,000 kept units; 3 kept are sampled, 1 of them other_word.
  // True other_word rate before 401/1001 vs after 400/1000 is a ~0.15 % reduction, not 33 %.
  const mapping = { D1: { stratum: 'dropped', population: 1, selected: 1 } };
  const labels = { D1: { label: 'other_word', type: 'compound' } };
  [['K1', 'other_word'], ['K2', 'same_word'], ['K3', 'same_word']].forEach(([id, label]) => {
    mapping[id] = { stratum: 'kept', population: 1000, selected: 3 };
    labels[id] = label === 'other_word' ? { label, type: 'compound' } : { label };
  });
  const result = aggregateLabels(mapping, labels);
  assert.ok(result.relative_other_word_reduction < 0.01, String(result.relative_other_word_reduction));
  assert.equal(result.criteria_met, false);
  assert.deepEqual(result.represented_units, { dropped: 1, kept: 1000 });
  // Without weights the same labels would report 2/4 → 1/3 (a 33 % reduction) and pass the same-word criterion.
});

test('population counts are recorded per stratum and validated', () => {
  const units = [unit('꼬리', '꾀꼬리', 1), unit('꼬리', '꼬리를', 2), unit('꼬리', '꼬리를', 2), unit('꼬리', '그 꼬리', 3)];
  assert.deepEqual(stratumPopulation(units), { dropped: 1, kept: 2 });
  const labels = { H1: { label: 'same_word' } };
  for (const entry of [{ stratum: 'kept' }, { stratum: 'kept', population: 2, selected: 3 }, { stratum: 'kept', population: 2, selected: 0 }, { stratum: 'x', population: 2, selected: 1 }]) {
    assert.throws(() => aggregateLabels({ H1: entry }, labels), /population >= selected/u);
  }
});

test('measurement summary and tolerance verdict are fail-closed on availability loss', () => {
  const row = (sub, eoj, subUnits, eojUnits) => ({
    substring: { contexts: sub, units: subUnits }, eojeol: { contexts: eoj, units: eojUnits },
    census: { units: subUnits, boundary: eojUnits, after_hangul: subUnits - eojUnits, after_han: 0, after_other: 0, trailing_0: eojUnits, trailing_1_2: 0, trailing_3_plus: 0 },
  });
  const included = summarize([row(8, 8, 100, 80), row(8, 7, 10, 6)]);
  const all = summarize([row(8, 8, 100, 80), row(8, 7, 10, 6), row(8, 8, 50, 50)]);
  assert.equal(all.substring.zero_context_cases, 0);
  assert.equal(all.sample_census.units, 160);
  assert.equal(all.dropped_unit_share_of_sample, Number((24 / 160).toFixed(4)));
  assert.equal(toleranceVerdict(all, included).within_tolerance, true);
  const lossy = summarize(Array.from({ length: TOLERANCES.max_additional_zero_context_cases + 1 }, () => row(3, 0, 10, 0)));
  assert.equal(toleranceVerdict(lossy, lossy).checks.additional_zero_context_cases, false);
  assert.equal(toleranceVerdict(lossy, lossy).within_tolerance, false);
});
