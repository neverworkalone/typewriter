import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  M5_12A_BASE_CANONICAL_SHA256,
  M5_12A_FINAL_SUMMARY,
  buildM512A,
  buildM512AReviewRows,
  commitM512APromotionTransaction,
  validatePromotionLedgerPrefix,
  validateM512AAuthoredCanonicalAuthority,
  validateCandidateIdentityBinding,
  validateM512AFinal,
} from '../scripts/batch/m5-12a-pipeline.mjs';
import {
  M5_12A_IMPORT_COUNT,
  M5_12A_RESERVE_COUNT,
  M5_12A_SELECTION_COUNT,
  M5_12A_CANDIDATE_IDENTITIES,
} from '../scripts/batch/m5-12a-candidate-source.mjs';
import {
  compactM512ADecisionRow,
  serializeM512ADecisionSource,
  validateM512ADecisionSource,
} from '../scripts/batch/m5-12a-decision-source.mjs';
import { hashCanonicalDirectory } from '../scripts/batch/validate-m5-8-process.mjs';
import {
  buildM512ASemanticDecisionScaffold,
} from '../scripts/batch/build-m5-12a-decision-scaffold.mjs';

function jsonSha256(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function serializedJsonSha256(value) {
  return createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`, 'utf8').digest('hex');
}

test('M5-12A binds all 802 identities and admits exactly 722 through the shared producer', async () => {
  const result = await buildM512A();

  assert.equal(result.identities.length, M5_12A_SELECTION_COUNT);
  assert.equal(result.artifacts.candidateRecords.length, M5_12A_SELECTION_COUNT);
  assert.equal(result.importedRecords.length, M5_12A_IMPORT_COUNT);
  assert.equal(result.semanticDecisionSource.source.contract_version, 'lexical-semantic-decision-source-v2');
  assert.ok(result.semanticDecisionSource.rows.every((row) => (
    !Object.hasOwn(row, 'source_sha256')
      && !Object.hasOwn(row, 'sense_gloss_sha256')
      && !Object.hasOwn(row, 'domain_evidence')
      && !Object.hasOwn(row, 'connector_observations')
  )));
  assert.equal(result.promotionLedger.length, M5_12A_IMPORT_COUNT);
  assert.ok(result.promotionLedger.every((entry) => (
    !Object.hasOwn(entry, 'lemma')
      && !Object.hasOwn(entry, 'senses')
      && entry.decision_row_sha256 === jsonSha256(
        result.semanticDecisionSource.byCandidateId.get(entry.canonical_id),
      )
  )));
  assert.deepEqual(result.admission.actual, M5_12A_FINAL_SUMMARY);
  const decisions = result.admission.decisions;
  const processed = decisions.included + decisions.corrected + decisions.held + decisions.rejected;
  assert.equal(decisions.included + decisions.corrected, M5_12A_IMPORT_COUNT);
  assert.ok(decisions.held + decisions.rejected <= M5_12A_RESERVE_COUNT);
  assert.equal(decisions.processed_start_count, processed);
  assert.equal(decisions.deferred, M5_12A_SELECTION_COUNT - processed);
  assert.equal(decisions.deferred_denominator_excluded, true);
  assert.equal(result.admission.gate.gate_status, 'pass');
  assert.equal(result.admission.verification.human_editorial_review_complete, false);
  assert.equal(result.admission.verification.generation_pass_id, 'm5-12a-generation-20260920');
  assert.equal(result.admission.verification.verification_pass_id, 'm5-12a-agent-semantic-review-20260920-r4');
  assert.equal(result.admission.provenance.batch_local_quality_fork, false);
  assert.equal(result.promotion.admission_sha256, serializedJsonSha256(result.admission));
  assert.equal(result.promotion.gate, undefined);
  assert.equal(result.relation.events.length, 0);
});

test('M5-12A decision scaffolding cannot manufacture or overwrite semantic authority', async () => {
  const sourcePath = path.resolve('data/batches/m5-12a-semantic-decisions.json');
  const sourceBefore = await readFile(sourcePath);
  const source = JSON.parse(sourceBefore);
  const scaffold = buildM512ASemanticDecisionScaffold();

  assert.equal(scaffold.candidates.length, M5_12A_SELECTION_COUNT);
  assert.equal(scaffold.candidate_source.identity_count, M5_12A_SELECTION_COUNT);
  assert.ok(scaffold.candidates.every((candidate) => (
    Object.keys(candidate).sort().join(',')
    === 'candidate_record_id,candidate_record_sha256,inventory_id,sense_id'
  )));
  assert.ok(scaffold.candidates.every((candidate) => (
    !Object.prototype.hasOwnProperty.call(candidate, 'decision')
    && !Object.prototype.hasOwnProperty.call(candidate, 'rank')
    && !Object.prototype.hasOwnProperty.call(candidate, 'score')
  )));
  assert.notEqual(
    createHash('sha256').update(sourceBefore).digest('hex'),
    '7c655a342a23223b8a4039e126abd2b789edfb21',
    'the durable source must not remain the artifact produced by the removed generator',
  );
  assert.equal(source.review.review_pass_id, 'm5-12a-agent-semantic-review-20260920-r4');
  assert.equal(source.review.reviewed_candidate_count, M5_12A_SELECTION_COUNT);
  assert.equal(source.provenance.generator_version, 'm5-12a-authored-semantic-review-v4');
  assert.equal(source.provenance.human_reviewed, false);
  const identityByCandidateId = new Map(M5_12A_CANDIDATE_IDENTITIES.map((identity) => [identity.candidate_record_id, identity]));
  const admittedExpressionCount = source.decisions.filter((row) => (
    identityByCandidateId.get(row.candidate_record_id).axis === 'X'
      && ['included', 'corrected'].includes(row.decision)
  )).length;
  const nonExpressionReserveCount = source.decisions.filter((row) => (
    identityByCandidateId.get(row.candidate_record_id).axis !== 'X'
      && ['held', 'rejected', 'deferred'].includes(row.decision)
  )).length;
  assert.ok(admittedExpressionCount > 2, 'the authored review must not retain the old non-expression cutoff');
  assert.ok(nonExpressionReserveCount > 0, 'the authored review must record semantic holds outside the expression axis');
  assert.deepEqual(await readFile(sourcePath), sourceBefore);
});

test('M5-12A compact decisions replay the same outcomes as the legacy envelope shape', async () => {
  const result = await buildM512A();
  const expanded = structuredClone(result.semanticDecisionSource.source);
  const candidateById = new Map(result.artifacts.candidateRecords.map((candidate) => [candidate.id, candidate]));
  for (const row of expanded.decisions) {
    const candidate = candidateById.get(row.candidate_record_id);
    row.source_sha256 = expanded.artifact_sha256;
    row.record_type = candidate.record_type;
    row.semantic_rationale = `${candidate.id} legacy envelope projection`;
    for (const senseReview of row.sense_reviews) {
      const sense = candidate.senses.find(({ id }) => id === senseReview.sense_id);
      senseReview.sense_gloss_sha256 = jsonSha256(sense.gloss);
      senseReview.pos = sense.pos;
      senseReview.record_type = candidate.record_type;
      senseReview.observed_domain_axes = [];
      senseReview.domain_evidence = [];
      senseReview.connector_observations = [];
    }
  }

  const compact = serializeM512ADecisionSource(expanded);
  assert.deepEqual(compact.source, result.semanticDecisionSource.source);
  assert.deepEqual(
    compact.source.decisions.map((row) => [row.candidate_record_id, row.decision, row.rank, row.score]),
    result.semanticDecisionSource.rows.map((row) => [row.candidate_record_id, row.decision, row.rank, row.score]),
  );
  assert.deepEqual(
    result.promotionLedger.map((entry) => [entry.inventory_id, entry.decision, entry.decision_row_sha256]),
    result.promotionLedger.map((entry) => [
      entry.inventory_id,
      entry.decision,
      jsonSha256(compactM512ADecisionRow(result.semanticDecisionSource.byCandidateId.get(entry.canonical_id))),
    ]),
  );
});

test('M5-12A decision contract accepts a different legal outcome distribution', async () => {
  const result = await buildM512A();
  const source = structuredClone(result.semanticDecisionSource.source);
  const movedToHeld = source.decisions.filter(({ decision }) => decision === 'included').slice(0, 10);
  const movedToIncluded = source.decisions.filter(({ decision }) => decision === 'deferred').slice(0, 10);
  for (const [index, heldRow] of movedToHeld.entries()) {
    const includedRow = movedToIncluded[index];
    const heldRank = heldRow.rank;
    const heldScore = heldRow.score;
    const includedRank = includedRow.rank;
    const includedScore = includedRow.score;

    heldRow.decision = 'held';
    heldRow.rank = includedRank;
    heldRow.score = includedScore;
    heldRow.decision_rationale = heldRow.decision_rationale.replace('Decision included', 'Decision held');
    heldRow.selection_rationale = heldRow.selection_rationale.replace(`rank ${heldRank}`, `rank ${includedRank}`);

    includedRow.decision = 'included';
    includedRow.rank = heldRank;
    includedRow.score = heldScore;
    includedRow.gloss_judgment = 'fit';
    includedRow.decision_rationale = includedRow.decision_rationale
      .replace('the lexical unit is plausible, but the generated gloss needs a more specific usage context before admission', 'the lexical unit and gloss form a usable writer-facing lookup for this axis')
      .replace('Decision deferred', 'Decision included');
    includedRow.sense_reviews[0].semantic_rationale = includedRow.sense_reviews[0].semantic_rationale
      .replace('the lexical unit is plausible, but the generated gloss needs a more specific usage context before admission', 'the lexical unit and gloss form a usable writer-facing lookup for this axis');
    includedRow.selection_rationale = includedRow.selection_rationale.replace(`rank ${includedRank}`, `rank ${heldRank}`);
  }
  const alternate = serializeM512ADecisionSource(source);
  const validated = validateM512ADecisionSource({
    source: alternate.source,
    sourceBytes: alternate.bytes,
    identities: result.identities,
    candidateRecords: result.artifacts.candidateRecords,
  });

  assert.equal(validated.counts.included, 722);
  assert.equal(validated.counts.corrected, 0);
  assert.equal(validated.counts.held, 40);
  assert.equal(validated.counts.rejected, 20);
  assert.equal(validated.counts.deferred, 20);

  const invalidJudgment = structuredClone(result.semanticDecisionSource.source);
  invalidJudgment.decisions.find(({ decision }) => decision === 'included').gloss_judgment = 'needs-context';
  const invalidJudgmentSerialized = serializeM512ADecisionSource(invalidJudgment);
  assert.throws(
    () => validateM512ADecisionSource({
      source: invalidJudgmentSerialized.source,
      sourceBytes: invalidJudgmentSerialized.bytes,
      identities: result.identities,
      candidateRecords: result.artifacts.candidateRecords,
    }),
    (error) => error.code === 'M5_12A_DECISION_SOURCE_COHERENCE',
  );

  const invalidRank = structuredClone(result.semanticDecisionSource.source);
  const invalidSelected = invalidRank.decisions.find(({ decision }) => decision === 'included');
  const invalidDeferred = invalidRank.decisions.find(({ decision }) => decision === 'deferred');
  [invalidSelected.rank, invalidDeferred.rank] = [invalidDeferred.rank, invalidSelected.rank];
  const invalidRankSerialized = serializeM512ADecisionSource(invalidRank);
  assert.throws(
    () => validateM512ADecisionSource({
      source: invalidRankSerialized.source,
      sourceBytes: invalidRankSerialized.bytes,
      identities: result.identities,
      candidateRecords: result.artifacts.candidateRecords,
    }),
    (error) => error.code === 'M5_12A_DECISION_SOURCE_COHERENCE',
  );

  const invalid = structuredClone(result.semanticDecisionSource.source);
  invalid.decisions.find(({ decision }) => decision === 'included').decision = 'held';
  const invalidSerialized = serializeM512ADecisionSource(invalid);
  assert.throws(
    () => validateM512ADecisionSource({
      source: invalidSerialized.source,
      sourceBytes: invalidSerialized.bytes,
      identities: result.identities,
      candidateRecords: result.artifacts.candidateRecords,
    }),
    (error) => error.code === 'M5_12A_DECISION_SOURCE_SCOPE',
  );
});

test('M5-12A rejects identity drift and canonical collisions before admission', async () => {
  const result = await buildM512A();
  const common = {
    baseRecords: result.inputs.baseCanonical.records,
    baseSeed: result.inputs.baseSeed,
  };

  const drifted = structuredClone(result.identities);
  drifted[0].candidate_record_id = 'w9999';
  assert.throws(
    () => validateCandidateIdentityBinding({
      ...common,
      identities: drifted,
      candidateRecords: result.artifacts.candidateRecords,
    }),
    (error) => error.code === 'SLOT_SOURCE_DRIFT',
  );

  const collidingIdentities = structuredClone(result.identities);
  const collidingRecords = structuredClone(result.artifacts.candidateRecords);
  collidingIdentities[0].lemma = '담담하다';
  collidingRecords[0].lemma = '담담하다';
  collidingRecords[0].search_forms = ['담담하다'];
  assert.throws(
    () => validateCandidateIdentityBinding({
      ...common,
      identities: collidingIdentities,
      candidateRecords: collidingRecords,
    }),
    (error) => error.code === 'CANDIDATE_COLLISION',
  );
});

test('M5-12A keeps authored decisions bound to candidate identity under permutation', async () => {
  const result = await buildM512A();
  const originalByCandidateId = new Map(result.reviewRows.map((row) => [row.candidate_id, {
    decision: row.decision,
    rank: row.semantic_review.selection.rank,
    score: row.semantic_review.selection.score,
  }]));
  const permutedIdentities = [...M5_12A_CANDIDATE_IDENTITIES].reverse();
  const candidateById = new Map(result.artifacts.candidateRecords.map((candidate) => [candidate.id, candidate]));
  const permutedRows = buildM512AReviewRows({
    identities: permutedIdentities,
    candidateRecords: permutedIdentities.map(({ candidate_record_id: candidateId }) => candidateById.get(candidateId)),
    semanticDecisionSource: result.semanticDecisionSource,
  });

  assert.notDeepEqual(
    permutedRows.map((row) => row.candidate_id),
    result.reviewRows.map((row) => row.candidate_id),
  );
  for (const row of permutedRows) {
    assert.deepEqual(originalByCandidateId.get(row.candidate_id), {
      decision: row.decision,
      rank: row.semantic_review.selection.rank,
      score: row.semantic_review.selection.score,
    });
  }
});

test('M5-12A shared production rejects copied semantic evidence before admission', async () => {
  const result = await buildM512A();
  const reviews = structuredClone(result.reviewRows);
  reviews[0].semantic_review.authored_decision.candidate_record_sha256 = '0'.repeat(64);

  await assert.rejects(
    () => import('../scripts/batch/lexical-production.mjs').then(({ validateLexicalProduction }) => (
      validateLexicalProduction({
        batchId: 'm5-12a-expansion-20260920',
        candidateRecords: result.artifacts.candidateRecords,
        reviews,
        baseRecords: result.inputs.baseCanonical.records,
        prospectiveRecords: result.prospective.canonical.records,
        semanticAudit: result.semanticAudit,
        productionState: result.production.production_state,
        productionStateSources: result.production.production_state_sources,
        productionPayloads: result.production.production_payloads,
        catalogCount: M5_12A_SELECTION_COUNT,
        expectedSelectedCount: M5_12A_IMPORT_COUNT,
        checkPilotCompleteness: true,
      })
    )),
    (error) => error.code === 'LEXICAL_SEMANTIC_BINDING',
  );
});

test('M5-12A shared production rejects a batch-local whitespace alias', async () => {
  const result = await buildM512A();
  const reviews = structuredClone(result.reviewRows);
  const included = reviews.find(({ decision, candidate_lemma: lemma }) => (
    decision === 'included' && lemma.includes(' ')
  ));
  included.reviewed_record.search_forms.push(included.candidate_lemma.replaceAll(' ', ''));

  await assert.rejects(
    () => import('../scripts/batch/lexical-production.mjs').then(({ validateLexicalProduction }) => (
      validateLexicalProduction({
        batchId: 'm5-12a-expansion-20260920',
        candidateRecords: result.artifacts.candidateRecords,
        reviews,
        baseRecords: result.inputs.baseCanonical.records,
        prospectiveRecords: result.prospective.canonical.records,
        semanticAudit: result.semanticAudit,
        productionState: result.production.production_state,
        productionStateSources: result.production.production_state_sources,
        productionPayloads: result.production.production_payloads,
        catalogCount: M5_12A_SELECTION_COUNT,
        expectedSelectedCount: M5_12A_IMPORT_COUNT,
        checkPilotCompleteness: true,
      })
    )),
    /collapsed internal-whitespace alias/u,
  );
});

test('M5-12A admission rejects a whitespace alias requested by authored correction evidence', async () => {
  const result = await buildM512A();
  const source = structuredClone(result.semanticDecisionSource.source);
  const candidateById = new Map(result.artifacts.candidateRecords.map((candidate) => [candidate.id, candidate]));
  const row = source.decisions.find(({ decision, candidate_record_id: candidateId }) => (
    decision === 'included' && candidateById.get(candidateId).lemma.includes(' ')
  ));
  const candidate = candidateById.get(row.candidate_record_id);
  const correctedRecord = structuredClone(candidate);
  correctedRecord.search_forms.push(candidate.lemma.replaceAll(' ', ''));
  row.decision = 'corrected';
  row.correction = {
    action: 'replace-authored-record',
    record: correctedRecord,
    output_record_sha256: jsonSha256(correctedRecord),
  };
  const serialized = serializeM512ADecisionSource(source);

  assert.throws(
    () => validateM512ADecisionSource({
      source: serialized.source,
      sourceBytes: serialized.bytes,
      identities: result.identities,
      candidateRecords: result.artifacts.candidateRecords,
    }),
    (error) => error.code === 'LEXICAL_SEARCH_FORM_COLLAPSED_ALIAS',
  );
});

test('M5-12A producer admits multi-sense authored evidence and rejects missing per-sense coverage', async () => {
  const result = await buildM512A();
  const source = structuredClone(result.semanticDecisionSource.source);
  const candidateRecords = structuredClone(result.artifacts.candidateRecords);
  const decisionIndex = source.decisions.findIndex(({ decision }) => decision === 'deferred');
  const row = source.decisions[decisionIndex];
  const candidateIndex = candidateRecords.findIndex(({ id }) => id === row.candidate_record_id);
  const candidate = candidateRecords[candidateIndex];
  const secondSense = {
    id: `${candidate.id}-s2`,
    pos: candidate.senses[0].pos,
    gloss: '서로 다른 사물의 쓰임을 가르는 별도의 의미를 글 속에서 구체화한다.',
  };
  candidate.senses.push(secondSense);
  source.candidate_records[candidateIndex] = candidate;
  source.candidate_records_sha256 = jsonSha256(source.candidate_records);
  row.candidate_record_sha256 = jsonSha256(candidate);
  const firstGlossSha256 = jsonSha256(candidate.senses[0].gloss);
  const secondGlossSha256 = jsonSha256(secondSense.gloss);
  const secondReview = {
    sense_id: secondSense.id,
    boundary_action: 'retain',
    boundary_classification: 'atomic',
    boundary_decision: 'atomic',
    boundary_rationale: `${row.inventory_id} ${candidate.id} ${secondSense.id} was independently reviewed as a distinct atomic writer-facing sense.`,
    semantic_rationale: `${candidate.id} ${secondSense.id} has separately authored meaning evidence.`,
    relation_decision: 'no-relations',
    relation_count: 0,
    relation_ids: [],
    no_relation_rationale: `${row.inventory_id} ${candidate.id} ${secondSense.id} has no independently supported relation tuple after review.`,
    review_basis: {},
  };
  row.sense_reviews = [row.sense_reviews[0], secondReview];
  row.boundary_pairs = [{
    left_sense_id: candidate.senses[0].id,
    right_sense_id: secondSense.id,
    relationship: 'distinct',
    decision: 'retain',
    left_gloss_sha256: firstGlossSha256,
    right_gloss_sha256: secondGlossSha256,
    evidence_basis: `${candidate.id} senses were compared directly.`,
    distinguishing_feature: 'the authored glosses describe separate writer-facing meanings',
    decision_source_id: source.source_id,
    rationale: `${candidate.id} ${candidate.senses[0].id} ${secondSense.id} pair cites ${firstGlossSha256.slice(0, 12)} and ${secondGlossSha256.slice(0, 12)}.`,
  }];
  const serialized = serializeM512ADecisionSource(source);
  const validated = validateM512ADecisionSource({
    source: serialized.source,
    sourceBytes: serialized.bytes,
    identities: result.identities,
    candidateRecords,
  });
  const reviews = buildM512AReviewRows({
    identities: result.identities,
    candidateRecords,
    semanticDecisionSource: validated,
  });
  const production = await import('../scripts/batch/lexical-production.mjs');
  const syntheticStage = (sourcePath) => ({
    status: 'complete',
    source_path: sourcePath,
    source_bytes: Buffer.from('{}\n', 'utf8'),
  });
  const stageEvidence = {
    candidate_intake: syntheticStage('synthetic:m5-12a-candidate-intake'),
    semantic_review: syntheticStage('synthetic:m5-12a-semantic-review'),
    selection: {
      ...syntheticStage('synthetic:m5-12a-selection'),
      policy: 'shared-quality-coverage-selection',
    },
    prospective_canonical: syntheticStage('synthetic:m5-12a-prospective-canonical'),
    audit: syntheticStage('synthetic:m5-12a-audit'),
    admission: {
      ...syntheticStage('synthetic:m5-12a-admission'),
      authorization_ref: 'synthetic:m5-12a-authorization',
      authorization_bytes: Buffer.from('synthetic authorization\n', 'utf8'),
    },
  };
  assert.doesNotThrow(() => production.validateLexicalProduction({
    batchId: 'm5-12a-expansion-20260920',
    candidateRecords,
    reviews,
    baseRecords: result.inputs.baseCanonical.records,
    prospectiveRecords: result.prospective.canonical.records,
    semanticAudit: result.semanticAudit,
    stageEvidence,
    catalogCount: M5_12A_SELECTION_COUNT,
    expectedSelectedCount: M5_12A_IMPORT_COUNT,
    checkPilotCompleteness: true,
  }));

  const missingEvidence = structuredClone(source);
  missingEvidence.decisions[decisionIndex].sense_reviews.splice(1, 1);
  const missingSerialized = serializeM512ADecisionSource(missingEvidence);
  assert.throws(
    () => validateM512ADecisionSource({
      source: missingSerialized.source,
      sourceBytes: missingSerialized.bytes,
      identities: result.identities,
      candidateRecords,
    }),
    (error) => error.code === 'M5_12A_DECISION_SOURCE_SCOPE',
  );
});

test('M5-12A canonical semantic authority retains immutable authored batch bindings', async () => {
  const result = await buildM512A();
  const promoted = result.importedRecords;
  assert.equal(validateM512AAuthoredCanonicalAuthority({
    decisionSource: result.decisionSource,
    m512aDecisionSource: result.semanticDecisionSource,
    records: promoted,
  }), true);

  const sourceReview = result.decisionSource.authored_review.records
    .find(({ record_id: recordId }) => recordId === promoted[0].id);
  assert.equal(
    sourceReview.authored_batch_decision.source_id,
    result.semanticDecisionSource.source.source_id,
  );
  assert.equal(
    sourceReview.authored_batch_decision.source_sha256,
    result.semanticDecisionSource.sourceSha256,
  );
  assert.deepEqual(
    Object.keys(sourceReview.authored_batch_decision).sort(),
    [
      'artifact_sha256',
      'candidate_record_id',
      'candidate_record_sha256',
      'decision',
      'decision_row_sha256',
      'reviewed_record_sha256',
      'selection_rank',
      'selection_score',
      'source_id',
      'source_sha256',
    ],
  );

  const missingEvidence = structuredClone(result.decisionSource);
  delete missingEvidence.authored_review.records
    .find(({ record_id: recordId }) => recordId === promoted[0].id)
    .authored_batch_decision;
  assert.throws(
    () => validateM512AAuthoredCanonicalAuthority({
      decisionSource: missingEvidence,
      m512aDecisionSource: result.semanticDecisionSource,
      records: promoted,
    }),
    (error) => error.code === 'M5_12A_CANONICAL_AUTHORITY_BINDING',
  );

  const changedRows = new Map(result.semanticDecisionSource.rows.map((row) => [row.candidate_record_id, row]));
  const changedRow = structuredClone(changedRows.get(promoted[0].id));
  changedRow.sense_reviews[0].semantic_rationale += ' changed after authoring';
  changedRows.set(changedRow.candidate_record_id, changedRow);
  assert.throws(
    () => validateM512AAuthoredCanonicalAuthority({
      decisionSource: result.decisionSource,
      m512aDecisionSource: {
        ...result.semanticDecisionSource,
        byCandidateId: changedRows,
      },
      records: promoted,
    }),
    (error) => error.code === 'M5_12A_CANONICAL_AUTHORITY_BINDING',
  );
});

test('M5-12A final promotion preserves the exact canonical, seed, and semantic authority digests', async () => {
  const result = await validateM512AFinal();

  assert.deepEqual(result.historical, M5_12A_FINAL_SUMMARY);
  assert.ok(result.current.record_count >= result.historical.record_count);
  assert.equal(result.gate.gate_status, 'pass');
  assert.equal(result.semantic_audit.coverage_complete, true);
  assert.equal(result.semantic_audit.review_complete, true);
});

test('M5-12A historical ledger validation remains local when a later event is appended', async () => {
  const result = await buildM512A();
  const laterEvent = {
    ...structuredClone(result.promotionLedger[0]),
    batch_id: 'later-independent-batch',
    inventory_id: 'later-independent-inventory',
    canonical_id: 'w9999',
  };
  const appended = [...result.promotionLedger, laterEvent];

  assert.doesNotThrow(() => validatePromotionLedgerPrefix({
    currentEntries: appended,
    expectedPrefixEntries: result.promotionLedger,
    baseEntries: result.inputs.basePromotionLedger,
    binding: result.promotionLedgerBinding,
  }));

  const tampered = structuredClone(appended);
  tampered[10].decision_note = 'historical event changed';
  assert.throws(
    () => validatePromotionLedgerPrefix({
      currentEntries: tampered,
      expectedPrefixEntries: result.promotionLedger,
      baseEntries: result.inputs.basePromotionLedger,
      binding: result.promotionLedgerBinding,
    }),
    (error) => error.code === 'PROMOTION_LEDGER_HISTORY_MISMATCH',
  );
});

test('M5-12A promotion rolls back every output when the committed canonical digest drifts', async () => {
  const result = await buildM512A();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-12a-rollback-'));
  const currentCanonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const currentSeedPath = path.join(temporaryDirectory, 'seed.json');
  const promotionLedgerPath = path.join(temporaryDirectory, 'promotions.jsonl');
  const decisionSourcePath = path.join(temporaryDirectory, 'decision-source.json');
  const canonicalImportPath = path.join(currentCanonicalDirectory, 'm5-12a-expansion.jsonl');
  const admissionPath = path.join(temporaryDirectory, 'admission.json');
  const promotionPath = path.join(temporaryDirectory, 'promotion.json');

  try {
    await cp(path.resolve('data/batches/m5-12-base-canonical'), currentCanonicalDirectory, { recursive: true });
    await writeFile(currentSeedPath, result.inputs.baseSeedBytes);
    await writeFile(promotionLedgerPath, result.inputs.basePromotionLedgerBytes);
    await writeFile(decisionSourcePath, result.inputs.currentDecisionSourceBytes);
    const beforeCanonicalDigest = await hashCanonicalDirectory(currentCanonicalDirectory);
    const beforeSeedBytes = await readFile(currentSeedPath);
    const beforePromotionLedgerBytes = await readFile(promotionLedgerPath);
    const beforeDecisionSourceBytes = await readFile(decisionSourcePath);

    const driftedResult = {
      ...result,
      prospective: {
        ...result.prospective,
        importBytes: Buffer.from('not-jsonl-canonical-data\n', 'utf8'),
      },
    };
    await assert.rejects(
      commitM512APromotionTransaction({
        result: driftedResult,
        currentCanonicalDirectory,
        currentSeedPath,
        promotionLedgerPath,
        decisionSourcePath,
        canonicalImportPath,
        admissionPath,
        promotionPath,
      }),
      (error) => error.code === 'PROMOTION_DIGEST_MISMATCH',
    );

    assert.equal(await hashCanonicalDirectory(currentCanonicalDirectory), beforeCanonicalDigest);
    assert.equal(beforeCanonicalDigest, M5_12A_BASE_CANONICAL_SHA256);
    assert.deepEqual(await readFile(currentSeedPath), beforeSeedBytes);
    assert.deepEqual(await readFile(promotionLedgerPath), beforePromotionLedgerBytes);
    assert.deepEqual(await readFile(decisionSourcePath), beforeDecisionSourceBytes);
    await assert.rejects(stat(canonicalImportPath), { code: 'ENOENT' });
    await assert.rejects(stat(admissionPath), { code: 'ENOENT' });
    await assert.rejects(stat(promotionPath), { code: 'ENOENT' });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('M5-12A rejects a failed shared product preflight without mutating promotion outputs', async () => {
  const result = await buildM512A();
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-12a-preflight-rollback-'));
  const currentCanonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const currentSeedPath = path.join(temporaryDirectory, 'seed.json');
  const promotionLedgerPath = path.join(temporaryDirectory, 'promotions.jsonl');
  const decisionSourcePath = path.join(temporaryDirectory, 'decision-source.json');
  const canonicalImportPath = path.join(currentCanonicalDirectory, 'm5-12a-expansion.jsonl');
  const admissionPath = path.join(temporaryDirectory, 'admission.json');
  const promotionPath = path.join(temporaryDirectory, 'promotion.json');

  try {
    await cp(path.resolve('data/batches/m5-12-base-canonical'), currentCanonicalDirectory, { recursive: true });
    await writeFile(currentSeedPath, result.inputs.baseSeedBytes);
    await writeFile(promotionLedgerPath, result.inputs.basePromotionLedgerBytes);
    await writeFile(decisionSourcePath, result.inputs.currentDecisionSourceBytes);
    const beforeCanonicalDigest = await hashCanonicalDirectory(currentCanonicalDirectory);
    const beforeSeedBytes = await readFile(currentSeedPath);
    const beforePromotionLedgerBytes = await readFile(promotionLedgerPath);
    const beforeDecisionSourceBytes = await readFile(decisionSourcePath);
    const failedPreflight = {
      ...result,
      preflight: {
        ...result.preflight,
        checks: {
          ...result.preflight.checks,
          search_product_regression: {
            ...result.preflight.checks.search_product_regression,
            status: 'fail',
          },
        },
      },
    };

    await assert.rejects(
      commitM512APromotionTransaction({
        result: failedPreflight,
        currentCanonicalDirectory,
        currentSeedPath,
        promotionLedgerPath,
        decisionSourcePath,
        canonicalImportPath,
        admissionPath,
        promotionPath,
      }),
      (error) => error.code === 'PROMOTION_PREFLIGHT_REQUIRED',
    );

    assert.equal(await hashCanonicalDirectory(currentCanonicalDirectory), beforeCanonicalDigest);
    assert.deepEqual(await readFile(currentSeedPath), beforeSeedBytes);
    assert.deepEqual(await readFile(promotionLedgerPath), beforePromotionLedgerBytes);
    assert.deepEqual(await readFile(decisionSourcePath), beforeDecisionSourceBytes);
    await assert.rejects(stat(canonicalImportPath), { code: 'ENOENT' });
    await assert.rejects(stat(admissionPath), { code: 'ENOENT' });
    await assert.rejects(stat(promotionPath), { code: 'ENOENT' });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
