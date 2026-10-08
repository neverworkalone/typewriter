import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { STRATA, validateJudge, buildReport, contextCountsOf, sealPhase1, readOptionalJson, readSeal, recommend, aggregate, assertSealed, classifyCase, nextSeal, selectCohort, validateJudgments } from './literature-validation.mjs';

const D = '0'.repeat(64);
const AI = { kind: 'ai_delegate', name: 'ChatGPT', delegated_by: 'owner' };
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
  assert.equal(classifyCase('control_included', one('included', 'high'), two('covered', { literature_role: 'misleading' })).outcome, 'harm');
  assert.equal(classifyCase('control_included', one('included'), two('included', { literature_role: 'irrelevant', basis_type: 'none', cited_contexts: [] })).outcome, 'unchanged');
});

test('aggregate applies the thresholds over all ten deferred cases and keeps controls stable', () => {
  const cohort = selectCohort(rows);
  const phase1 = { judge: AI, judgments: {} };
  const phase2 = { judge: AI, judgments: {} };
  cohort.forEach((entry, index) => {
    const deferred = entry.stratum.startsWith('deferred_');
    phase1.judgments[entry.blind_id] = one(deferred ? 'deferred' : 'included');
    phase2.judgments[entry.blind_id] = deferred ? (index % 2 === 0 ? two('covered') : two('deferred', { literature_role: 'irrelevant', basis_type: 'none', cited_contexts: [] })) : two('included');
  });
  const result = aggregate(cohort, phase1, phase2);
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
  const phase1 = { judge: AI, judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, one('deferred')])) };
  const phase2 = { judge: AI, judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, two('covered', { cited_contexts: [999] })])) };
  assert.throws(() => aggregate(cohort, phase1, phase2), /cited_contexts/);
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
    assert.deepEqual(await readOptionalJson(file), { exists: false });
    await writeFile(file, JSON.stringify({ phase1_sha256: 'a' }));
    assert.deepEqual(await readOptionalJson(file), { exists: true, value: { phase1_sha256: 'a' } });
    await writeFile(file, 'null');
    assert.deepEqual(await readOptionalJson(file), { exists: true, value: null }, 'JSON null is an existing file, not absence');
    await assert.rejects(readSeal(file), /seal file is invalid/);
    for (const content of ['{}', '[]', '"x"', JSON.stringify({ phase1_sha256: 'a'.repeat(64), cohort_sha256: 'b', sealed_at: 't' })]) {
      await writeFile(file, content);
      await assert.rejects(readSeal(file), /seal file is invalid/, content);
    }
    await writeFile(file, JSON.stringify({ phase1_sha256: 'a'.repeat(64), cohort_sha256: 'b'.repeat(64), sealed_at: 't' }));
    assert.equal((await readSeal(file)).sealed_at, 't');
    await rm(file);
    assert.equal(await readSeal(file), null);
    await writeFile(file, '{ corrupt');
    await assert.rejects(readOptionalJson(file), SyntaxError);
    await rm(file);
    await mkdir(file);
    await assert.rejects(readOptionalJson(file), (error) => error.code === 'EISDIR');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const ignored = { literature_role: 'misleading', basis_type: 'none', cited_contexts: [] };

test('harm is an actual harmful change or source conflict, not a diagnostic misleading role alone', () => {
  assert.equal(classifyCase('control_included', one('included'), two('included', ignored)).outcome, 'unchanged');
  const cautious = classifyCase('control_included', one('included', 'high'), two('deferred', ignored));
  assert.equal(cautious.outcome, 'cautious_deferral');
  assert.deepEqual(cautious.harm, []);
  assert.equal(classifyCase('deferred_noise', one('deferred'), two('included', { literature_role: 'misleading' })).outcome, 'harm');
  assert.equal(classifyCase('control_included', one('included', 'high'), two('covered', { literature_role: 'misleading' })).outcome, 'harm');
  assert.equal(classifyCase('control_included', one('included'), two('included', { conflicts_with_source_evidence: true })).outcome, 'harm');
  assert.equal(classifyCase('control_included', one('included'), two('deferred', { owner_endorses_final: false, ...ignored })).outcome, 'unqualified_change');
});

test('the misleading/harm veto takes precedence over the entry-candidate branch', () => {
  assert.equal(recommend({ harms: 0, misleading: 3, improvements: 5, controlsStable: true }), 'review_retriever_defects_then_hold_392');
  assert.equal(recommend({ harms: 1, misleading: 0, improvements: 9, controlsStable: true }), 'review_retriever_defects_then_hold_392');
  assert.equal(recommend({ harms: 0, misleading: 2, improvements: 5, controlsStable: true }), 'candidate_for_392_entry');
  assert.equal(recommend({ harms: 0, misleading: 0, improvements: 5, controlsStable: false }), 'hold_392_literature_optional');
  assert.equal(recommend({ harms: 0, misleading: 0, improvements: 4, controlsStable: true }), 'hold_392_literature_optional');
});

test('aggregate over a real 12-case cohort: 5 improvements plus 3 misleading deferred cases vetoes entry; clean and neutral cohorts do not', () => {
  const cohort = selectCohort(rows);
  const deferred = cohort.filter((entry) => entry.stratum.startsWith('deferred_'));
  const build = (assign) => {
    const phase1 = { judge: AI, judgments: {} };
    const phase2 = { judge: AI, judgments: {} };
    for (const entry of cohort) {
      const isDeferred = entry.stratum.startsWith('deferred_');
      phase1.judgments[entry.blind_id] = one(isDeferred ? 'deferred' : 'included');
      phase2.judgments[entry.blind_id] = isDeferred ? assign(deferred.indexOf(entry)) : two('included', { literature_role: 'irrelevant', basis_type: 'none', cited_contexts: [] });
    }
    return aggregate(cohort, phase1, phase2);
  };
  const veto = build((index) => (index < 5 ? two('covered') : index < 8 ? two('deferred', ignored) : two('deferred', { literature_role: 'irrelevant', basis_type: 'none', cited_contexts: [] })));
  assert.equal(veto.improvements, 5);
  assert.equal(veto.misleading_roles, 3);
  assert.equal(veto.harms, 0);
  assert.equal(veto.recommendation, 'review_retriever_defects_then_hold_392');
  const clean = build((index) => (index < 5 ? two('covered') : two('deferred', { literature_role: 'irrelevant', basis_type: 'none', cited_contexts: [] })));
  assert.equal(clean.recommendation, 'candidate_for_392_entry');
  const neutral = build(() => two('deferred', { literature_role: 'irrelevant', basis_type: 'none', cited_contexts: [] }));
  assert.equal(neutral.recommendation, 'hold_392_literature_optional');
});

test('citation bounds come from the sealed cohort digests, so a tampered count cannot validate a phantom citation', () => {
  const cohort = selectCohort(rows);
  assert.ok(Object.values(contextCountsOf(cohort)).every((count) => count === 1));
  const phase1 = { judge: AI, judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, one('deferred')])) };
  const at = (cited) => ({ judge: AI, judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, two('covered', { cited_contexts: cited })])) });
  assert.doesNotThrow(() => aggregate(cohort, phase1, at([1])));
  assert.throws(() => aggregate(cohort, phase1, at([999])), /cited_contexts/);
  assert.throws(() => aggregate(cohort, phase1, at([2])), /cited_contexts/);
  assert.deepEqual(contextCountsOf([{ blind_id: 'V01' }]), { V01: 0 });
});

test('report boundary: sealed cohort bounds citations; a planted count file or tampered answers cannot approve a phantom citation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'report-'));
  try {
    const cohort = selectCohort(rows);
    await mkdir(path.join(directory, 'owner'), { recursive: true });
    await writeFile(path.join(directory, 'cohort.local.json'), JSON.stringify({ cohort }));
    const phase1 = { phase: 1, judge: AI, judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, one('deferred')])) };
    const phase2 = (cited) => ({ phase: 2, judge: AI, judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, two('covered', { cited_contexts: cited })])) });
    await writeFile(path.join(directory, 'owner', 'phase1-judgments.json'), JSON.stringify(phase1));
    await writeFile(path.join(directory, 'owner', 'phase2-judgments.json'), JSON.stringify(phase2([1])));
    await assert.rejects(buildReport(directory), /not sealed/, 'unsealed phase 1 cannot be reported');
    assert.equal(await sealPhase1(directory), 'phase 1 sealed');
    assert.equal((await buildReport(directory)).improvements, 10);
    // A planted, inflated count file is ignored: the phantom citation is still out of the sealed cohort's range.
    await writeFile(path.join(directory, 'context-counts.local.json'), JSON.stringify(Object.fromEntries(cohort.map((entry) => [entry.blind_id, 999]))));
    await writeFile(path.join(directory, 'owner', 'phase2-judgments.json'), JSON.stringify(phase2([999])));
    await assert.rejects(buildReport(directory), /cited_contexts/);
    // Edited phase 1 answers after sealing cannot be re-sealed or reported.
    await writeFile(path.join(directory, 'owner', 'phase2-judgments.json'), JSON.stringify(phase2([1])));
    await writeFile(path.join(directory, 'owner', 'phase1-judgments.json'), JSON.stringify({ ...phase1, judgments: { ...phase1.judgments, V01: one('included') } }));
    await assert.rejects(sealPhase1(directory), /already sealed/);
    await assert.rejects(buildReport(directory), /not sealed/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unmeasured time stays null and its comparison is not_measurable; a measured value must be a non-negative number', () => {
  assert.deepEqual(validateJudgments({ judgments: { V01: { ...one('included'), seconds: null } } }, ['V01'], 1), []);
  for (const seconds of [-1, Number.NaN, '5', undefined]) assert.ok(validateJudgments({ judgments: { V01: { ...one('included'), seconds } } }, ['V01'], 1).includes('V01: seconds'), String(seconds));
  const cohort = selectCohort(rows);
  const timed = (seconds, judge = AI) => ({ judge, judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, entry.stratum.startsWith('deferred_') ? { ...one('deferred'), seconds } : { ...one('included'), seconds }])) });
  const phase2 = (seconds) => ({ judge: AI, judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, { ...two(entry.stratum.startsWith('deferred_') ? 'deferred' : 'included', { literature_role: 'irrelevant', basis_type: 'none', cited_contexts: [] }), seconds }])) });
  const unmeasured = aggregate(cohort, timed(null), phase2(null));
  assert.equal(unmeasured.median_seconds_phase1, 'not_measurable');
  assert.equal(unmeasured.median_seconds_phase2, 'not_measurable');
  assert.equal(aggregate(cohort, timed(30), phase2(null)).median_seconds_phase1, 30);
  assert.equal(aggregate(cohort, timed(30), phase2(null)).median_seconds_phase2, 'not_measurable');
});

test('the judge must be declared; an AI delegate is never recorded as the owner direct judgment', () => {
  assert.deepEqual(validateJudge({ judge: { kind: 'owner_direct' } }), []);
  assert.deepEqual(validateJudge({ judge: AI }), []);
  for (const judge of [undefined, null, {}, { kind: 'human' }, { kind: 'ai_delegate' }, { kind: 'ai_delegate', name: 'ChatGPT' }, { kind: 'ai_delegate', name: '', delegated_by: 'owner' }]) {
    assert.ok(validateJudge({ judge }).length, JSON.stringify(judge));
  }
  const cohort = selectCohort(rows);
  const file = (judge) => ({ judge, judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, { ...one('included') }])) });
  const phase2 = { judge: AI, judgments: Object.fromEntries(cohort.map((entry) => [entry.blind_id, two('included', { literature_role: 'irrelevant', basis_type: 'none', cited_contexts: [] })])) };
  assert.throws(() => aggregate(cohort, file(undefined), phase2), /judge/);
  const delegated = aggregate(cohort, file(AI), phase2);
  assert.deepEqual(delegated.judged_by.phase1, AI);
  assert.match(delegated.judgment_provenance, /not the owner direct/);
  assert.match(delegated.limits, /AI delegate ChatGPT/);
  assert.doesNotMatch(delegated.limits, /owner/i, 'an AI delegate result must not read as owner-judged');
  const direct = aggregate(cohort, file({ kind: 'owner_direct' }), { ...phase2, judge: { kind: 'owner_direct' } });
  assert.equal(direct.judgment_provenance, 'Owner direct judgments.');
  assert.match(direct.limits, /judged by the owner directly/);
  assert.doesNotMatch(direct.limits, /AI/);
  assert.match(aggregate(cohort, file({ kind: 'owner_direct' }), phase2).limits, /the owner directly and AI delegate ChatGPT/);
});
