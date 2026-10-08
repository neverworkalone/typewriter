import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { STRATA, readOptionalJson, aggregate, assertSealed, classifyCase, nextSeal, selectCohort, validateJudgments } from './literature-validation.mjs';

const D = '0'.repeat(64);
const make = (id, group, evidence_use, outcome) => ({ candidate_id: id, group, evidence_use, outcome, selected_location_digests: [D] });
const rows = [];
for (let i = 0; i < 30; i += 1) {
  rows.push(make(`C1-${i}`, 'deferred', 'supports', 'resolved_covered'), make(`C2-${i}`, 'deferred', 'no_effect', 'still_deferred'),
    make(`C3-${i}`, 'deferred', 'misleading_noise', 'still_deferred'), make(`C4-${i}`, 'deferred', 'exposes_other_sense', 'still_deferred'),
    make(`C5-${i}`, 'clear_included', 'supports', 'unchanged_included'));
}
rows.push(make('C6-0', 'deferred', 'supports', 'partially_resolved'));

test('cohort is deterministic, stratified, blind-labelled and takes every deferred stratum (10 deferred + 2 controls)', () => {
  const cohort = selectCohort(rows);
  assert.deepEqual(selectCohort(rows), cohort);
  assert.equal(cohort.length, 12);
  assert.deepEqual(cohort.map((entry) => entry.blind_id), Array.from({ length: 12 }, (_, i) => 'V' + String(i + 1).padStart(2, '0')));
  for (const stratum of STRATA) assert.equal(cohort.filter((entry) => entry.stratum === stratum.id).length, stratum.count);
  assert.equal(cohort.filter((entry) => entry.stratum.startsWith('deferred_')).length, 10);
  assert.ok(!cohort.some((entry) => entry.candidate_id === 'C6-0'), 'partially_resolved is not a supports-resolved case');
});

const one = (disposition, confidence = 'medium') => ({ disposition, confidence, basis: 'b', seconds: 10 });
const two = (disposition, extra = {}) => ({ ...one(disposition), literature_role: 'helpful', basis_type: 'sense_demonstrated', cited_contexts: [1], conflicts_with_source_evidence: false, owner_endorses_final: true, ...extra });

test('a deferred→confirmed change is an improvement only with every pre-registered condition', () => {
  assert.equal(classifyCase('deferred_supports', one('deferred'), two('covered')).outcome, 'improvement');
  for (const extra of [{ literature_role: 'irrelevant' }, { cited_contexts: [] }, { basis_type: 'none' }, { owner_endorses_final: false }, { confidence: 'low' }, { conflicts_with_source_evidence: true }]) {
    assert.notEqual(classifyCase('deferred_supports', one('deferred'), two('covered', extra)).outcome, 'improvement', JSON.stringify(extra));
  }
  assert.equal(classifyCase('deferred_noise', one('deferred'), two('deferred')).outcome, 'unchanged');
});

test('misleading evidence that drives a confirmation or displaces a confident judgment is harm', () => {
  assert.equal(classifyCase('deferred_noise', one('deferred'), two('included', { literature_role: 'misleading' })).outcome, 'harm');
  assert.equal(classifyCase('control_included', one('included', 'high'), two('deferred', { owner_endorses_final: false })).outcome, 'harm');
  assert.equal(classifyCase('control_included', one('included'), two('included', { literature_role: 'irrelevant', basis_type: 'none', cited_contexts: [] })).outcome, 'unchanged');
});

test('aggregate applies the thresholds over all ten deferred cases and keeps controls stable', () => {
  const cohort = selectCohort(rows);
  const phase1 = { judgments: {} };
  const phase2 = { judgments: {} };
  cohort.forEach((entry, index) => {
    const deferred = entry.stratum.startsWith('deferred_');
    phase1.judgments[entry.blind_id] = one(deferred ? 'deferred' : 'included');
    phase2.judgments[entry.blind_id] = deferred ? (index % 2 === 0 ? two('covered') : two('deferred', { literature_role: 'irrelevant', basis_type: 'none', cited_contexts: [] })) : two('included');
  });
  const result = aggregate(cohort, phase1, phase2, Object.fromEntries(cohort.map((entry) => [entry.blind_id, 3])));
  assert.equal(result.deferred_cases, 10);
  assert.equal(result.harms, 0);
  assert.equal(result.controls_stable, true);
  assert.equal(result.recommendation, result.improvements >= 5 ? 'candidate_for_392_entry' : 'hold_392_literature_optional');
});

test('judgment validation rejects missing and malformed entries', () => {
  assert.deepEqual(validateJudgments({ judgments: { V01: one('included') } }, ['V01'], 1), []);
  assert.ok(validateJudgments({ judgments: {} }, ['V01'], 1).length);
  assert.ok(validateJudgments({ judgments: { V01: { ...one('included'), disposition: null } } }, ['V01'], 1).includes('V01: disposition'));
  assert.ok(validateJudgments({ judgments: { V01: one('included') } }, ['V01'], 2).length);
});

test('a citation must name a revealed context; out-of-range or duplicate numbers are rejected and never count', () => {
  const counts = { V01: 3 };
  const file = (extra) => ({ judgments: { V01: two('covered', extra) } });
  assert.deepEqual(validateJudgments(file({ cited_contexts: [1, 3] }), ['V01'], 2, counts), []);
  for (const cited of [[999], [4], [0], [1, 1]]) assert.ok(validateJudgments(file({ cited_contexts: cited }), ['V01'], 2, counts).includes('V01: cited_contexts'), JSON.stringify(cited));
  assert.ok(validateJudgments(file({}), ['V01'], 2, {}).includes('V01: cited_contexts'), 'no revealed contexts → no valid citation');
  const cohort = selectCohort(rows);
  const phase1 = { judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, one('deferred')])) };
  const phase2 = { judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, two('covered', { cited_contexts: [999] })])) };
  assert.throws(() => aggregate(cohort, phase1, phase2, Object.fromEntries(cohort.map((entry) => [entry.blind_id, 3]))), /cited_contexts/);
});

test('the seal is written once: identical re-seal is allowed, changed answers or cohort fail closed, reveal needs both digests', () => {
  const first = nextSeal(null, 'a'.repeat(64), 'c'.repeat(64), 't0');
  assert.deepEqual(nextSeal(first, 'a'.repeat(64), 'c'.repeat(64), 't1'), first);
  assert.throws(() => nextSeal(first, 'b'.repeat(64), 'c'.repeat(64), 't1'), /already sealed/);
  assert.throws(() => nextSeal(first, 'a'.repeat(64), 'd'.repeat(64), 't1'), /already sealed/);
  assertSealed(first, 'a'.repeat(64), 'c'.repeat(64));
  assert.throws(() => assertSealed(first, 'b'.repeat(64), 'c'.repeat(64)), /not sealed/);
  assert.throws(() => assertSealed(first, 'a'.repeat(64), 'd'.repeat(64)), /not sealed/);
  assert.throws(() => assertSealed(null, 'a'.repeat(64), 'c'.repeat(64)), /not sealed/);
});

test('only a missing seal file counts as unsealed; a corrupt or unreadable one fails closed instead of being resealed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'seal-'));
  try {
    const file = path.join(directory, 'seal.json');
    assert.equal(await readOptionalJson(file), null);
    await writeFile(file, JSON.stringify({ phase1_sha256: 'a' }));
    assert.deepEqual(await readOptionalJson(file), { phase1_sha256: 'a' });
    await writeFile(file, '{ corrupt');
    await assert.rejects(readOptionalJson(file), SyntaxError);
    await rm(file);
    await mkdir(file);
    await assert.rejects(readOptionalJson(file), (error) => error.code === 'EISDIR');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
