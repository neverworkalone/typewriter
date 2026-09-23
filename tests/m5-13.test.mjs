import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  M5_13_CATALOG,
} from '../scripts/batch/m5-13-catalog.mjs';
import {
  M5_13_CANDIDATE_IDENTITIES,
  M5_13_CORRECTION_PASS_ID,
  M5_13_GENERATION_PASS_ID,
  M5_13_IMPORT_COUNT,
  M5_13_RESERVE_COUNT,
  M5_13_SELECTION_COUNT,
  M5_13_VERIFICATION_PASS_ID,
  buildM513CandidateRecords,
} from '../scripts/batch/m5-13-candidate-source.mjs';
import {
  validateM513SemanticSource,
} from '../scripts/batch/rebuild-m5-13-semantic-source.mjs';
import { M5_13_LEXICAL_UNIT_POOL } from '../scripts/batch/m5-13-lexical-units.mjs';
import {
  buildM513,
} from '../scripts/batch/m5-13-pipeline.mjs';
import {
  M5_13_SEMANTIC_DECISION_SOURCE_ID,
  M5_13_SEMANTIC_DECISION_SOURCE_PATH,
  buildM513DecisionSource,
  candidateRecordsFromM513DecisionSource,
  readM513DecisionSource,
  serializeM513DecisionSource,
  validateM513DecisionSource,
} from '../scripts/batch/m5-13-decision-source.mjs';
import { selectReviewedCandidates } from '../scripts/batch/lexical-selection.mjs';
import {
  M5_13_BASE_SUMMARY,
  M5_13_FINAL_SUMMARY,
  M5_13_TARGET,
  validateM513,
  validateM513Catalog,
} from '../scripts/batch/validate-m5-13.mjs';
import {
  createCanonicalContext,
  loadCanonicalContext,
} from '../scripts/validate/canonical-context.mjs';
import {
  readCanonicalRecords,
  withCanonicalLoadObserver,
} from '../scripts/validate/canonical-jsonl.mjs';

async function buildInputCanonicalContext() {
  const current = await loadCanonicalContext({ contextPath: null });
  const importPath = path.join(current.canonicalDirectory, 'm5-13-expansion.jsonl');
  try {
    await stat(importPath);
  } catch (error) {
    if (error.code === 'ENOENT') return { context: current, cleanup: async () => {} };
    throw error;
  }

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-13-test-'));
  const baseCanonicalDirectory = path.join(temporaryDirectory, 'canonical');
  await cp(current.canonicalDirectory, baseCanonicalDirectory, { recursive: true });
  await rm(path.join(baseCanonicalDirectory, 'm5-13-expansion.jsonl'), { force: true });
  const baseCanonical = await readCanonicalRecords(baseCanonicalDirectory, { useSharedContext: false });
  return {
    context: createCanonicalContext(baseCanonical, { canonicalDirectory: baseCanonicalDirectory }),
    cleanup: () => rm(temporaryDirectory, { recursive: true, force: true }),
  };
}

const preflightStub = async ({ prospectiveCanonicalDigest }) => ({
  status: 'complete',
  input_canonical_directory_sha256: prospectiveCanonicalDigest,
  checks: Object.fromEntries([
    'deterministic_sqlite',
    'search_product_regression',
    'extension_build',
    'package_validation',
    'artifact_policy_clean_checkout',
  ].map((name) => [name, {
    status: 'pass',
    input_canonical_directory_sha256: prospectiveCanonicalDigest,
  }])),
});

test('M5-13 keeps 1,100 capacity slots separate from authored identities', () => {
  assert.equal(M5_13_CATALOG.length, M5_13_TARGET.selection_slot_count);
  assert.equal(M5_13_CANDIDATE_IDENTITIES.length, M5_13_TARGET.candidate_identity_count);
  assert.equal(new Set(M5_13_CANDIDATE_IDENTITIES.map(({ lemma }) => lemma)).size, 1100);
  assert.equal(M5_13_CATALOG.at(0).slot_id, 'm5-13-slot-0001');
  assert.equal(M5_13_CATALOG.at(-1).slot_id, 'm5-13-slot-1100');
  for (const identity of M5_13_CANDIDATE_IDENTITIES) {
    assert.equal(Object.hasOwn(identity.source_basis, 'source_quality'), false);
    assert.equal(Object.hasOwn(identity.source_basis, 'quality_score'), false);
    assert.equal(Object.hasOwn(identity.source_basis, 'selection_basis'), false);
  }
});

test('M5-13 producer preserves unit-authored meaning and metadata before shared selection', async () => {
  const candidates = buildM513CandidateRecords();
  assert.equal(candidates.length, M5_13_LEXICAL_UNIT_POOL.length);
  for (const [index, unit] of M5_13_LEXICAL_UNIT_POOL.entries()) {
    const identity = M5_13_CANDIDATE_IDENTITIES[index];
    const candidate = candidates[index];
    assert.equal(identity.lemma, unit.lemma);
    assert.equal(identity.record_type, unit.record_type);
    assert.equal(identity.pos, unit.pos);
    assert.equal(candidate.lemma, unit.lemma);
    assert.equal(candidate.record_type, unit.record_type);
    assert.equal(candidate.senses[0].pos, unit.pos);
    assert.equal(candidate.senses[0].gloss, unit.writer_gloss);
  }

  for (const lemma of ['불현듯', '문득']) {
    const unit = M5_13_LEXICAL_UNIT_POOL.find((candidate) => candidate.lemma === lemma);
    assert.equal(unit.record_type, 'entry');
    assert.equal(unit.pos, 'adverb');
  }
  assert.equal(M5_13_LEXICAL_UNIT_POOL.some(({ lemma }) => lemma === '기댔다'), false);

  const sourceFile = await readM513DecisionSource();
  const authoredCandidates = candidateRecordsFromM513DecisionSource(sourceFile.source);
  assert.deepEqual(candidates, authoredCandidates);
  assert.equal(candidates.some(({ lemma }) => lemma.includes('에서 읽는')), false);
  assert.equal(candidates.some(({ lemma }) => lemma.includes('기대에서')), false);
  const decisionSource = validateM513DecisionSource({
    source: sourceFile.source,
    sourceBytes: sourceFile.sourceBytes,
    candidateRecords: candidates,
  });
  assert.equal(decisionSource.source.source_id, M5_13_SEMANTIC_DECISION_SOURCE_ID);
  assert.equal(decisionSource.source.review.review_pass_id, M5_13_VERIFICATION_PASS_ID);
  assert.equal(decisionSource.source.provenance.verification_pass_id, M5_13_VERIFICATION_PASS_ID);
  assert.deepEqual(decisionSource.source.review.correction_passes.map(({ review_pass_id: id, candidate_record_ids: ids }) => ({ id, ids })), [
    { id: M5_13_CORRECTION_PASS_ID, ids: ['w2474', 'w2475', 'w2476', 'w2477'] },
  ]);
  assert.notEqual(M5_13_VERIFICATION_PASS_ID, M5_13_GENERATION_PASS_ID);
  assert.equal(Object.values(decisionSource.counts).reduce((sum, count) => sum + count, 0), candidates.length);
  assert.equal(decisionSource.selection.selected.length, M5_13_IMPORT_COUNT);
  assert.equal(decisionSource.selection.reserve.length + decisionSource.selection.excluded.length, M5_13_RESERVE_COUNT);
  assert.equal(decisionSource.selection.excluded.length,
    decisionSource.counts.held + decisionSource.counts.rejected + decisionSource.counts.deferred);
  assert.ok(decisionSource.counts.held + decisionSource.counts.rejected > 0);
  assert.equal(new Set(decisionSource.rows.map(({ decision_rationale: rationale }) => rationale)).size, candidates.length);
  assert.ok(decisionSource.rows.every(({ decision_rationale: rationale }) => (
    !rationale.includes('The unit-level meaning and POS fit this single writer-facing lexical item')
  )));
  assert.ok(decisionSource.rows.every(({ sense_reviews: senseReviews }) => (
    !senseReviews[0].boundary_rationale.includes('the observed gloss domains are')
  )));
  assert.equal(new Set(decisionSource.rows.map(({ sense_reviews: senseReviews }) => (
    senseReviews[0].semantic_rationale
  ))).size, candidates.length);
  assert.deepEqual(decisionSource.counts, {
    included: 1054,
    corrected: 0,
    held: 46,
    rejected: 0,
    deferred: 0,
  });
  assert.deepEqual(decisionSource.counts, sourceFile.source.review.decision_counts);
  const checked = validateM513SemanticSource({
    source: sourceFile.source,
    sourceBytes: sourceFile.sourceBytes,
    candidateRecords: candidates,
  });
  assert.equal(checked.artifactSha256, decisionSource.artifactSha256);
  const beforeDecisionArtifact = await readFile(M5_13_SEMANTIC_DECISION_SOURCE_PATH);
  const validationOutput = execFileSync(process.execPath, [
    'scripts/batch/rebuild-m5-13-semantic-source.mjs',
  ], { encoding: 'utf8' });
  assert.match(validationOutput, /"wrote_decisions": false/u);
  assert.deepEqual(await readFile(M5_13_SEMANTIC_DECISION_SOURCE_PATH), beforeDecisionArtifact);
  assert.throws(
    () => buildM513DecisionSource(),
    (error) => error.code === 'M5_13_DECISION_SOURCE_REGENERATION',
  );
});

test('M5-13 keeps an independently authored semantic hold out of admission', async () => {
  const sourceFile = await readM513DecisionSource();
  const candidates = candidateRecordsFromM513DecisionSource(sourceFile.source);
  const reviewed = validateM513DecisionSource({
    source: sourceFile.source,
    sourceBytes: sourceFile.sourceBytes,
    candidateRecords: candidates,
  });
  const candidateId = 'w3133';
  const decision = reviewed.byCandidateId.get(candidateId);
  assert.equal(decision.decision, 'held');
  assert.equal(decision.gloss_judgment, 'needs-context');
  assert.match(decision.decision_rationale, /인용형/u);
  assert.equal(decision.review_pass_id, M5_13_VERIFICATION_PASS_ID);
  assert.ok(reviewed.selection.excluded.includes(candidateId));
  assert.ok(!reviewed.selection.selected.some(({ candidate_record_id: id }) => id === candidateId));
  assert.ok(!reviewed.selection.reserve.some(({ candidate_record_id: id }) => id === candidateId));
  assert.equal(reviewed.selection.selected.length, M5_13_IMPORT_COUNT);

  const insufficient = selectReviewedCandidates([
    { candidate_record_id: 'bad-semantic', decision: 'rejected', rank: 1, selection_axis: 'E' },
    { candidate_record_id: 'held-for-context', decision: 'held', rank: 2, selection_axis: 'S' },
  ], { capacity: 1, coverageField: 'selection_axis' });
  assert.equal(insufficient.status, 'hold');
  assert.equal(insufficient.reason, 'insufficient-qualified-candidates');
});

test('M5-13 shared preflight rejects adjacent candidate evidence shifted after review', async () => {
  const sourceFile = await readM513DecisionSource();
  const candidates = candidateRecordsFromM513DecisionSource(sourceFile.source);
  const source = structuredClone(sourceFile.source);
  const first = source.decisions.find(({ candidate_record_id: id }) => id === 'w2476');
  const second = source.decisions.find(({ candidate_record_id: id }) => id === 'w2477');
  assert.equal(first.decision, 'included');
  assert.equal(second.decision, 'included');

  const rationaleBody = (rationale) => rationale.slice(rationale.indexOf(':') + 1).trim();
  const firstDecisionBody = rationaleBody(first.decision_rationale);
  const secondDecisionBody = rationaleBody(second.decision_rationale);
  first.decision_rationale = `${first.decision_rationale.slice(0, first.decision_rationale.indexOf(':') + 1)} ${secondDecisionBody}`;
  second.decision_rationale = `${second.decision_rationale.slice(0, second.decision_rationale.indexOf(':') + 1)} ${firstDecisionBody}`;
  [first.sense_reviews[0].semantic_rationale, second.sense_reviews[0].semantic_rationale] = [
    second.sense_reviews[0].semantic_rationale,
    first.sense_reviews[0].semantic_rationale,
  ];

  // Refresh only the outer artifact digest, as a positional importer could;
  // the authored candidate/sense evidence binding must remain immutable.
  const serialized = serializeM513DecisionSource(source);
  assert.throws(
    () => validateM513DecisionSource({
      source: serialized.source,
      sourceBytes: serialized.bytes,
      candidateRecords: candidates,
    }),
    (error) => error.code === 'M5_13_DECISION_SOURCE_BINDING',
  );
});

test('M5-13 executes producer, semantic audit, selection, prospective canonical, and admission', async () => {
  const beforeCanonical = await readFile('data/canonical/m5-12a-expansion.jsonl');
  const beforeSeed = await readFile('data/inventory/m5-target-seed.json');
  const { context, cleanup } = await buildInputCanonicalContext();
  try {
    const result = await buildM513({ canonicalContext: context, preflightRunner: preflightStub });
    assert.deepEqual({
      record_count: result.prospective.canonical.records.length,
      start_count: result.prospective.canonical.records.filter(({ record, role }) => (record ?? { role }).role === 'start').length,
      expression_count: result.prospective.canonical.records.filter(({ record, record_type }) => (record ?? { record_type }).record_type === 'expression').length,
    }, {
      record_count: M5_13_FINAL_SUMMARY.record_count,
      start_count: M5_13_FINAL_SUMMARY.start_count,
      expression_count: M5_13_FINAL_SUMMARY.expression_count,
    });
    assert.equal(result.importedRecords.length, M5_13_IMPORT_COUNT);
    assert.equal(result.admission.gate.gate_status, 'pass');
    assert.equal(result.production.production_state.producer_mode, 'live');
    assert.equal(result.semanticAuditCoverage.coverage_complete, true);
    assert.equal(result.semanticDecisionSource.byCandidateId.get('w3133').decision, 'held');
    assert.ok(result.semanticDecisionSource.selection.excluded.includes('w3133'));
    assert.ok(!result.importedRecords.some(({ id }) => id === 'w3133'));
    assert.deepEqual(result.reviewRows.filter(({ decision }) => ['held', 'rejected', 'deferred'].includes(decision)).length,
      result.semanticDecisionSource.counts.held + result.semanticDecisionSource.counts.rejected + result.semanticDecisionSource.counts.deferred);
    assert.deepEqual(result.reviewRows.filter(({ selection_status: status }) => status === 'selected').length, 1000);
    assert.deepEqual(
      result.reviewRows.filter(({ selection_status: status }) => status === 'reserve').length,
      result.semanticDecisionSource.selection.reserve.length,
    );
    const importedExpressionCount = result.importedRecords.filter(({ record_type: recordType }) => recordType === 'expression').length;
    const prospectiveExpressionCount = result.prospective.canonical.records.filter(({ record, record_type: recordType }) => (
      (record ?? { record_type: recordType }).record_type === 'expression'
    )).length;
    assert.equal(importedExpressionCount, prospectiveExpressionCount - M5_13_BASE_SUMMARY.expression_count);
    assert.deepEqual(await readFile('data/canonical/m5-12a-expansion.jsonl'), beforeCanonical);
    assert.deepEqual(await readFile('data/inventory/m5-target-seed.json'), beforeSeed);
    assert.equal(result.semanticDecisionSource.source.artifact_sha256, result.semanticDecisionSource.artifactSha256);
  } finally {
    await cleanup();
  }
});

test('M5-13 proves supplied canonical context is the loader authority', async () => {
  const canonicalContext = await loadCanonicalContext({ contextPath: null });
  const loaderEvents = [];
  const result = await withCanonicalLoadObserver(
    (event) => loaderEvents.push(event),
    () => validateM513({ canonicalContext }),
  );
  assert.equal(result.candidate_count, M5_13_TARGET.candidate_identity_count);
  assert.equal(loaderEvents.some(({ directory }) => directory === canonicalContext.canonicalDirectory), false);
});

test('M5-13 catalog validation rejects an unbound inventory field', () => {
  const driftedCatalog = M5_13_CATALOG.map((entry, index) => (
    index === 0 ? { ...entry, inventory_id: 'm5-9999' } : entry
  ));
  assert.throws(
    () => validateM513Catalog(driftedCatalog),
    (error) => error.code === 'CATALOG_SHAPE_ERROR',
  );
});
