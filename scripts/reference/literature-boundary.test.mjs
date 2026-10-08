import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateLabels, CRITERIA, pickHits, sampleCandidateIds, validateLabels } from './literature-boundary-judge.mjs';
import { summarize, toleranceVerdict, TOLERANCES } from './literature-boundary-measure.mjs';

// Synthetic, text-free fixtures only (#414 measurement and judged-sample contract).

const unit = (form, text, n) => ({ form, text, location_digest: String(n).padStart(64, '0') });

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

test('labels validate against a closed judge and typed other_word', () => {
  const judge = { kind: 'ai_delegate', name: 'judge-model', delegated_by: 'owner' };
  const ok = { judge, labels: { H001: { label: 'same_word' }, H002: { label: 'other_word', type: 'compound' }, H003: { label: 'unclear' } } };
  assert.deepEqual(validateLabels(ok, ['H001', 'H002', 'H003']), []);
  assert.ok(validateLabels({ ...ok, judge: { kind: 'owner_direct', name: 'x' } }, ['H001']).length > 0);
  assert.ok(validateLabels({ judge, labels: { H001: { label: 'other_word' } } }, ['H001']).length > 0);
  assert.ok(validateLabels({ judge, labels: { H001: { label: 'same_word', type: 'compound' } } }, ['H001']).length > 0);
  assert.ok(validateLabels(ok, ['H001', 'H009']).length > 0);
});

test('aggregation reports other-word reduction and dropped same-word share against fixed criteria', () => {
  const mapping = {};
  const labels = {};
  const add = (id, stratum, label, type) => { mapping[id] = { stratum }; labels[id] = type ? { label, type } : { label }; };
  // 6 dropped: 5 other_word, 1 same_word; 6 kept: 1 other_word, 4 same_word, 1 unclear.
  ['a', 'b', 'c', 'd', 'e'].forEach((id) => add('D' + id, 'dropped', 'other_word', id === 'a' ? 'personal_name' : 'compound'));
  add('Df', 'dropped', 'same_word');
  add('Ka', 'kept', 'other_word', 'hanja_homograph');
  ['b', 'c', 'd', 'e'].forEach((id) => add('K' + id, 'kept', 'same_word'));
  add('Kf', 'kept', 'unclear');
  const result = aggregateLabels(mapping, labels);
  assert.equal(result.unclear, 1);
  assert.equal(result.other_word_rate.substring, Number((6 / 11).toFixed(4)));
  assert.equal(result.other_word_rate.eojeol, 0.2);
  assert.ok(result.relative_other_word_reduction > CRITERIA.min_relative_other_word_reduction);
  assert.equal(result.same_word_dropped_share, 0.2); // 1 of 5 same_word units dropped > 10 %
  assert.equal(result.criteria_met, false);
  assert.deepEqual(result.other_word_by_type.personal_name, { dropped: 1, kept: 0 });
  assert.deepEqual(result.other_word_by_type.hanja_homograph, { dropped: 0, kept: 1 });
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
