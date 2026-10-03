import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import { validateLexicalAddition } from '../scripts/batch/lexical-admission.mjs';
import { createCanonicalContext } from '../scripts/validate/canonical-context.mjs';
import {
  deepFreezeJson,
  isVerifiedImmutable,
  memoizedDigest,
} from '../scripts/validate/immutable-digest.mjs';
import { productionValueSha256 } from '../scripts/batch/lexical-production-state.mjs';
import {
  assertCompleteRevisionChecksReused,
  createSharedAdmissionContext,
} from '../scripts/batch/shared-admission-context.mjs';
import { validateSemanticAuditCoverage } from '../scripts/validate/semantic-audit.mjs';
import { makeProductionState, makeSemanticAudit } from './helpers/semantic-audit-fixture.mjs';

const FIXTURE_DIRECTORY = path.resolve('tests/fixtures/lexical-quality/surface-form-canonical');

const entry = (id, lemma, gloss) => ({
  id,
  record_type: 'entry',
  role: 'start',
  candidate_id: id,
  lemma,
  search_forms: [lemma],
  senses: [{ id: `${id}-s1`, pos: 'adjective', gloss }],
});

function fixtureRecords() {
  return [
    entry('w779', '맛있다', '음식의 맛이 좋아 먹기에 즐겁다.'),
    entry('w780', '고요하다', '아무런 소리 없이 조용하다.'),
  ].map((record, index) => ({
    record,
    source: 'shared-admission-fixture',
    filePath: 'shared-admission-fixture',
    lineNumber: index + 1,
  }));
}

function installFixtureManifests(context, recordInfos) {
  context.derived.surfaceFormExceptionManifest = {
    schema_version: 1,
    contract_id: 'm6-2-inflection-exceptions-v1',
    source_issue: 174,
    exceptions: [],
  };
  context.derived.surfaceFormReviewManifest = {
    schema_version: 1,
    contract_id: 'm6-3-searchable-predicate-review-v2',
    source_issue: 209,
    dispositions: recordInfos.flatMap(({ record }) => record.senses.map((sense) => ({
      class_id: 'm6-3-predicate-excluded',
      record_id: record.id,
      sense_id: sense.id,
      reason: 'Synthetic admission fixture does not exercise inflection search.',
    }))),
    reviewed_collisions: { exact_generated: [], ambiguous_generated: [] },
  };
  return context;
}

// The previous behaviour: every batch gets a fresh context with no audit cache.
function independentContext(recordInfos) {
  return installFixtureManifests(
    createCanonicalContext({ records: recordInfos }, { canonicalDirectory: FIXTURE_DIRECTORY, source: 'fixture' }),
    recordInfos,
  );
}

function sharedContext(recordInfos, semanticAudit) {
  return installFixtureManifests(
    createSharedAdmissionContext({ records: recordInfos }, semanticAudit, {
      canonicalDirectory: FIXTURE_DIRECTORY,
    }),
    recordInfos,
  );
}

function admissionOptions({ batchIndex, prospectiveRecords, semanticAudit }) {
  const candidate = prospectiveRecords[batchIndex];
  const baseRecords = prospectiveRecords.filter((_, index) => index !== batchIndex);
  const batchId = `shared-context-batch-${batchIndex + 1}`;
  const productionState = makeProductionState({
    batchId,
    candidateRecords: [candidate.record],
    reviewedRecords: [candidate],
    baseRecords,
    prospectiveRecords,
    semanticAudit,
  });
  return {
    batchId,
    candidateRecords: [candidate.record],
    reviewedRecords: [candidate],
    baseRecords,
    prospectiveRecords,
    semanticAudit,
    productionState: productionState.state,
    productionStateSources: productionState.sources,
    productionPayloads: productionState.payloads,
  };
}

function outcome(run) {
  try {
    return { ok: true, result: JSON.stringify(run()) };
  } catch (error) {
    return { ok: false, code: error.code ?? error.name, message: error.message };
  }
}

function bothModes({ prospectiveRecords, semanticAudit, tamperedRecords, tamperedAudit }) {
  const results = { independent: [], shared: [] };
  // A validator builds its shared context from the inputs it actually read, so a
  // tampered input is also what the shared context describes.
  const shared = sharedContext(
    tamperedRecords ?? prospectiveRecords,
    tamperedAudit ?? semanticAudit,
  );
  for (const batchIndex of [0, 1]) {
    const options = admissionOptions({ batchIndex, prospectiveRecords, semanticAudit });
    const effective = {
      ...options,
      prospectiveRecords: tamperedRecords ?? options.prospectiveRecords,
      semanticAudit: tamperedAudit ?? options.semanticAudit,
    };
    results.independent.push(outcome(() => validateLexicalAddition({
      ...effective,
      canonicalContext: independentContext(effective.prospectiveRecords),
    })));
    results.shared.push(outcome(() => validateLexicalAddition({
      ...effective,
      canonicalContext: shared,
    })));
  }
  return results;
}

test('shared admission context yields the same accepted result for every batch', () => {
  const records = fixtureRecords();
  const audit = makeSemanticAudit(records);
  const { independent, shared } = bothModes({ prospectiveRecords: records, semanticAudit: audit });
  assert.ok(independent.every(({ ok }) => ok), JSON.stringify(independent.map(({ message }) => message)));
  assert.deepEqual(shared, independent);
});

test('shared admission context rejects a tampered prospective record exactly like independent validation', () => {
  const records = fixtureRecords();
  const audit = makeSemanticAudit(records);
  const tampered = structuredClone(records);
  tampered[1].record.senses[0].gloss = '아무 소리도 없이 몹시 시끄럽다.';
  const { independent, shared } = bothModes({
    prospectiveRecords: records,
    semanticAudit: audit,
    tamperedRecords: tampered,
  });
  assert.ok(independent.every(({ ok }) => !ok), 'tampered prospective canonical must be rejected');
  assert.deepEqual(shared, independent);
});

test('shared admission context rejects a tampered semantic audit exactly like independent validation', () => {
  const records = fixtureRecords();
  const audit = makeSemanticAudit(records);
  const tampered = structuredClone(audit);
  tampered.review.records[0].sense_reviews[0].review_basis = `${JSON.stringify(
    tampered.review.records[0].sense_reviews[0].review_basis,
  )} (tampered)`;
  const { independent, shared } = bothModes({
    prospectiveRecords: records,
    semanticAudit: audit,
    tamperedAudit: tampered,
  });
  assert.ok(independent.every(({ ok }) => !ok), 'tampered semantic audit must be rejected');
  assert.deepEqual(shared, independent);
});

test('a context for a different record array or audit object is not trusted for reuse', () => {
  const records = fixtureRecords();
  const audit = makeSemanticAudit(records);
  const options = admissionOptions({ batchIndex: 0, prospectiveRecords: records, semanticAudit: audit });
  const expected = outcome(() => validateLexicalAddition({
    ...options,
    canonicalContext: independentContext(records),
  }));
  // Equal content, different identity: falls back to full recomputation.
  const copiedRecords = structuredClone(records);
  const copiedContext = sharedContext(copiedRecords, structuredClone(audit));
  const viaCopy = outcome(() => validateLexicalAddition({ ...options, canonicalContext: copiedContext }));
  assert.deepEqual(viaCopy, expected);
  assert.equal(copiedContext.derived.admissionTopicEvidence, undefined, 'no reuse state is written for a foreign context');
});

test('shared admission inputs are immutable so reused digests cannot go stale', () => {
  const records = fixtureRecords();
  const audit = makeSemanticAudit(records);
  const context = sharedContext(records, audit);
  assert.equal(isVerifiedImmutable(context.records[0].record), true);
  assert.throws(() => { context.records[0].record.lemma = '바뀜'; }, TypeError);
  assert.throws(() => { audit.review.records.push({}); }, TypeError);
});

test('memoized digests are reused only for verified-immutable values', () => {
  const frozen = { values: [1, 2, 3] };
  assert.equal(deepFreezeJson(frozen), true);
  let computations = 0;
  const compute = () => { computations += 1; return `digest-${computations}`; };
  assert.equal(memoizedDigest('ns', frozen, compute), 'digest-1');
  assert.equal(memoizedDigest('ns', frozen, compute), 'digest-1');
  assert.equal(memoizedDigest('other-ns', frozen, compute), 'digest-2', 'namespaces never share digests');

  const mutable = { values: [1, 2, 3] };
  assert.equal(memoizedDigest('ns', mutable, compute), 'digest-3');
  assert.equal(memoizedDigest('ns', mutable, compute), 'digest-4', 'unfrozen values are always recomputed');

  const first = { id: 1 };
  const second = { id: 2 };
  deepFreezeJson(first);
  deepFreezeJson(second);
  const calls = [];
  const recordOrder = (value) => memoizedDigest('seq', value, () => { calls.push(value.map(({ id }) => id).join()); return calls.length; });
  assert.equal(recordOrder([first, second]), 1);
  assert.equal(recordOrder([first, second]), 1, 'same frozen element sequence reuses its digest');
  assert.equal(recordOrder([second, first]), 2, 'order changes the digest');
  assert.equal(recordOrder([first]), 3, 'membership changes the digest');
  assert.equal(recordOrder([first, { id: 2 }]), 4, 'an unfrozen look-alike element is never reused');
});

test('production digests of frozen values equal digests computed from scratch', () => {
  const records = fixtureRecords().map(({ record }) => structuredClone(record));
  const fresh = productionValueSha256(structuredClone(records));
  records.forEach(deepFreezeJson);
  assert.equal(productionValueSha256(records), fresh);
  assert.equal(productionValueSha256(records), fresh);
  assert.equal(productionValueSha256([...records].reverse()) === fresh, false);
});

test('complete-revision judgments are computed once and reused by later batches', () => {
  const records = fixtureRecords();
  const audit = makeSemanticAudit(records);
  const shared = sharedContext(records, audit);
  for (const batchIndex of [0, 1]) {
    validateLexicalAddition({
      ...admissionOptions({ batchIndex, prospectiveRecords: records, semanticAudit: audit }),
      canonicalContext: shared,
    });
  }
  assertCompleteRevisionChecksReused(shared, 2);
  const coverage = shared.semanticAuditCache.completeRevisionStats.coverage;
  assert.equal(coverage.computed, 1, 'semantic coverage is validated once for the revision');
  assert.ok(coverage.reused >= 1);
  assert.equal(shared.completeRevisionStats['lexical-audit'].computed, 1);
  assert.equal(shared.completeRevisionStats['role-relations'].computed, 1);

  // Independent (unshared) validation never records reuse and cannot pass the assertion.
  const independent = independentContext(records);
  for (const batchIndex of [0, 1]) {
    validateLexicalAddition({
      ...admissionOptions({ batchIndex, prospectiveRecords: records, semanticAudit: audit }),
      canonicalContext: independent,
    });
  }
  assert.throws(() => assertCompleteRevisionChecksReused(independent, 2), /must be validated once and reused/u);
});

test('a memoized complete-revision success never skips the batch-specific base check', () => {
  const records = fixtureRecords();
  const audit = makeSemanticAudit(records);
  const shared = sharedContext(records, audit);
  const options = { requireDecisionSource: true, requireTopicAnalysis: true, hashCache: shared.semanticAuditCache };
  // First batch: correct base, the complete-revision core is computed and remembered.
  validateSemanticAuditCoverage(shared.records, audit, { ...options, baseRecords: [records[0]] });
  // Later batch: a base record that differs from the prospective record without a
  // reviewed correction must still be rejected although the core is memoized.
  const alteredBase = [{
    ...records[1],
    record: { ...records[1].record, lemma: '다른말하다' },
  }];
  assert.throws(
    () => validateSemanticAuditCoverage(shared.records, audit, { ...options, baseRecords: alteredBase }),
    (error) => error.code === 'SEMANTIC_AUDIT_CORRECTION_REQUIRED',
  );
  assert.ok(shared.semanticAuditCache.completeRevisionStats.coverage.reused >= 1);
});
