import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { rebuildSemanticEvidence } from '../scripts/validate/rebuild-semantic-evidence.mjs';
import {
  buildCanonicalSemanticAudit,
  buildSemanticAuditFromDecisionSource,
  compactSemanticDecisionSource,
  compactSemanticReviewArtifact,
  materializeSemanticReviewArtifact,
  SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
  COMPACT_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
  sha256Json,
  validateSemanticAuditCoverage,
} from '../scripts/validate/semantic-audit.mjs';
import {
  AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION,
  authorSemanticReviewBinding,
  compactAuthoredSemanticDecisionRow,
} from '../scripts/validate/semantic-decision-row.mjs';
import {
  makeSemanticAudit,
  makeSemanticReview,
} from './helpers/semantic-audit-fixture.mjs';

function makeRecord(glosses, id = 'w-semantic-source-regression') {
  return {
    id,
    record_type: 'entry',
    role: 'start',
    candidate_id: id,
    lemma: '의미결정회귀',
    search_forms: ['의미결정회귀'],
    senses: glosses.map((gloss, index) => ({
      id: `${id}-s${index + 1}`,
      pos: 'noun',
      gloss,
    })),
  };
}

function authoredDecisionProjection(audit) {
  return audit.review.records.map((record) => ({
    record_id: record.record_id,
    boundary: {
      decision: record.boundary_review.decision,
      classification: record.boundary_review.classification,
      evidence: record.boundary_review.evidence.map((item) => ({
        sense_id: item.sense_id,
        evidence_basis: item.evidence_basis,
        rationale: item.rationale,
      })),
      pairwise: record.boundary_review.pairwise.map((item) => ({
        left_sense_id: item.left_sense_id,
        right_sense_id: item.right_sense_id,
        relationship: item.relationship,
        decision: item.decision,
        evidence_basis: item.evidence_basis,
        distinguishing_feature: item.distinguishing_feature,
        rationale: item.rationale,
      })),
      rationale: record.boundary_review.rationale,
    },
    senses: record.sense_reviews.map((sense) => ({
      sense_id: sense.sense_id,
      boundary: {
        action: sense.sense_boundary.action,
        classification: sense.sense_boundary.classification,
        boundary_decision: sense.sense_boundary.boundary_decision,
      },
      pos: {
        observed_pos: sense.pos.observed_pos,
        decision: sense.pos.decision,
      },
      expression: {
        expected_record_type: sense.expression.expected_record_type,
        observed_record_type: sense.expression.observed_record_type,
        decision: sense.expression.decision,
      },
      relation: {
        decision: sense.relation.decision,
        no_relation_rationale: sense.relation.no_relation_rationale,
      },
      topic: {
        topic_analysis: sense.review_basis.topic_analysis,
        topic_analyses: sense.review_basis.topic_analyses,
      },
    })),
  }));
}

test('authored distinct and retain cannot override mechanically identical or nested pairs', () => {
  for (const glosses of [
    ['같은 뜻을 설명한다', '같은 뜻을 설명한다'],
    ['붉은 꽃', '붉은 꽃 피어남'],
  ]) {
    const record = makeRecord(glosses);
    const infos = [{ record, source: 'semantic-source-regression' }];
    const audit = makeSemanticAudit(infos);

    assert.equal(audit.review.records[0].boundary_review.pairwise[0].relationship, 'distinct');
    assert.equal(audit.review.records[0].boundary_review.pairwise[0].decision, 'retain');
    assert.throws(
      () => validateSemanticAuditCoverage(infos, audit),
      (error) => error.code === 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
    );
  }
});

test('non-mechanical POS, expression, and no-relation outcomes require decision evidence', () => {
  const record = makeRecord(['작가가 문장을 고르는 말.'], 'w-semantic-decision-fields');
  const infos = [{ record, source: 'semantic-source-regression' }];
  const valid = makeSemanticAudit(infos);
  assert.doesNotThrow(() => validateSemanticAuditCoverage(infos, valid));

  const missingDecisionFields = [
    ['pos', (senseReview) => { delete senseReview.pos.decision_source_id; }, 'SEMANTIC_AUDIT_VALUE'],
    ['expression', (senseReview) => { delete senseReview.expression.decision; }, 'SEMANTIC_AUDIT_PROVENANCE'],
    ['no-relation rationale', (senseReview) => { delete senseReview.relation.no_relation_rationale; }, 'SEMANTIC_AUDIT_VALUE'],
  ];
  for (const [label, mutate, expectedCode] of missingDecisionFields) {
    const audit = structuredClone(valid);
    mutate(audit.review.records[0].sense_reviews[0]);
    assert.throws(
      () => validateSemanticAuditCoverage(infos, audit),
      (error) => error.code === expectedCode,
      label,
    );
  }
});

test('semantic evidence rebuild rejects a legacy review passed as the decision source', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-semantic-source-'));
  const canonicalDirectory = path.join(directory, 'canonical');
  const decisionSourcePath = path.join(directory, 'legacy-review.json');
  try {
    await mkdir(canonicalDirectory, { recursive: true });
    const record = makeRecord(['작가가 문장을 고르는 말.'], 'w9001');
    await writeFile(
      path.join(canonicalDirectory, 'records.jsonl'),
      `${JSON.stringify(record)}\n`,
      'utf8',
    );
    await writeFile(
      decisionSourcePath,
      `${JSON.stringify(makeSemanticReview([{ record, source: 'semantic-source-regression' }]))}\n`,
      'utf8',
    );

    await assert.rejects(
      rebuildSemanticEvidence({
        canonicalDirectory,
        decisionSourceInputPath: decisionSourcePath,
        auditOutputPath: path.join(directory, 'audit.json'),
        reviewOutputPath: path.join(directory, 'review.json'),
        coverageOutputPath: path.join(directory, 'coverage.json'),
      }),
      (error) => error.code === 'SEMANTIC_AUDIT_SCHEMA',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('compact canonical decision source replays the authored semantic decisions', () => {
  const record = makeRecord(['작가가 문장을 고르는 말.', '글의 분위기를 만드는 표현.'], 'w9002');
  const infos = [{ record, source: 'semantic-source-replay-regression' }];
  const fullAudit = makeSemanticAudit(infos, {
    artifactId: 'semantic-source-replay',
  });
  const fullSource = {
    schema_version: '1',
    contract_version: SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
    kind: 'separately-authored-semantic-decision-source',
    source_id: fullAudit.review.decision_source.source_id,
    authoring_mode: 'separately-authored',
    scope: 'complete-canonical',
    source: structuredClone(fullAudit.source),
    authored_review_sha256: sha256Json(fullAudit.review),
    authored_review: structuredClone(fullAudit.review),
  };
  const compactSource = compactSemanticDecisionSource(fullSource);
  const replayed = buildSemanticAuditFromDecisionSource(infos, compactSource);

  assert.equal(compactSource.contract_version, 'lexical-semantic-canonical-decision-source-v2');
  assert.equal(Object.hasOwn(compactSource.authored_review.records[0].sense_reviews[0], 'pos'), false);
  assert.equal(Object.hasOwn(compactSource.authored_review.records[0].sense_reviews[0], 'relation'), false);
  assert.ok(compactSource.authored_review.rationale_templates.length > 0);
  assert.equal(Object.hasOwn(
    compactSource.authored_review.records[0].boundary_review.evidence[0],
    'rationale_code',
  ), true);
  assert.deepEqual(authoredDecisionProjection(replayed), authoredDecisionProjection(fullAudit));
  assert.doesNotThrow(() => validateSemanticAuditCoverage(infos, replayed));
});

test('positive relation outcome is retained as authored evidence instead of inferred from canonical relations', () => {
  const record = makeRecord(['작가가 문장을 고르는 말.'], 'w9003');
  record.senses[0].relations = [{ target: 'w9004', type: 'near', note: 'fixture relation' }];
  const infos = [{ record, source: 'semantic-source-relation-regression' }];
  const fullAudit = makeSemanticAudit(infos, { artifactId: 'semantic-source-relation' });
  const fullSource = {
    schema_version: '1',
    contract_version: SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
    kind: 'separately-authored-semantic-decision-source',
    source_id: fullAudit.review.decision_source.source_id,
    authoring_mode: 'separately-authored',
    scope: 'complete-canonical',
    source: structuredClone(fullAudit.source),
    authored_review_sha256: sha256Json(fullAudit.review),
    authored_review: structuredClone(fullAudit.review),
  };
  const compactSource = compactSemanticDecisionSource(fullSource);
  const compactReview = compactSource.authored_review;
  delete compactReview.records[0].sense_reviews[0].relation_decision;
  compactSource.authored_review_sha256 = sha256Json(compactReview);

  assert.throws(
    () => materializeSemanticReviewArtifact(infos, compactReview, {
      decisionSourceId: compactSource.source_id,
    }),
    (error) => error.code === 'SEMANTIC_AUDIT_DECISION_MISSING',
  );
});

test('M5 canonical rows dereference batch authority without copying authored narrative', () => {
  const record = makeRecord(['작가가 문장을 고르는 말.'], 'w9005');
  record.senses[0].relations = [{ target: 'w9006', type: 'near', note: 'fixture relation' }];
  const infos = [{ record, source: 'semantic-source-batch-reference-regression' }];
  const fullAudit = makeSemanticAudit(infos, { artifactId: 'semantic-source-batch-reference' });
  const row = {
    candidate_record_id: record.id,
    candidate_record_sha256: sha256Json(record),
    decision: 'included',
    rank: 1,
    score: 0.9,
    decision_rationale: `${record.id} was included from an authored batch decision.`,
    selection_rationale: `${record.id} was selected from an authored batch decision.`,
    review_pass_id: 'batch-review-v1',
    gloss_judgment: 'fit',
    sense_reviews: [{
      sense_id: record.senses[0].id,
      boundary_action: 'retain',
      boundary_classification: 'atomic',
      boundary_decision: 'atomic',
      boundary_rationale: `${record.id} ${record.senses[0].id} boundary cites ${sha256Json(record.senses[0].gloss).slice(0, 12)}.`,
      semantic_rationale: `${record.id} ${record.senses[0].id} semantic meaning was independently reviewed.`,
      relation_decision: 'relations-reviewed',
      relation_count: 1,
      relation_ids: [`${record.senses[0].id}:relation-1`],
    }],
  };
  row.review_binding = authorSemanticReviewBinding(row, record);
  const batchSourceContent = {
    schema_version: '1',
    contract_version: 'lexical-semantic-decision-source-v3',
    review_binding_contract_version: AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION,
    source_id: 'synthetic-batch-source-v1',
    artifact_sha256: 'a'.repeat(64),
    decisions: [row],
  };
  const sourceBytes = Buffer.from(JSON.stringify(batchSourceContent), 'utf8');
  const batchSource = {
    source: batchSourceContent,
    sourceBytes,
    sourceSha256: sha256Json(sourceBytes.toString('utf8')),
    artifactSha256: 'a'.repeat(64),
    byCandidateId: new Map([[record.id, row]]),
  };
  // The resolver hashes bytes with SHA-256, not the JSON helper's hash.
  batchSource.sourceSha256 = createHash('sha256')
    .update(sourceBytes)
    .digest('hex');
  const binding = {
    source_id: batchSource.source.source_id,
    source_sha256: batchSource.sourceSha256,
    artifact_sha256: batchSource.artifactSha256,
    decision_row_sha256: sha256Json(compactAuthoredSemanticDecisionRow(row)),
    candidate_record_id: record.id,
    candidate_record_sha256: sha256Json(record),
    decision: row.decision,
    selection_rank: row.rank,
    selection_score: row.score,
    reviewed_record_sha256: sha256Json(record),
  };
  const authoredReview = structuredClone(fullAudit.review);
  authoredReview.records[0].authored_batch_decision = binding;
  const compactReview = compactSemanticReviewArtifact(authoredReview);
  assert.deepEqual(Object.keys(compactReview.records[0]).sort(), [
    'authored_batch_decision',
    'record_id',
    'record_sha256',
  ]);
  const decisionSource = {
    schema_version: '1',
    contract_version: COMPACT_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
    kind: 'separately-authored-semantic-decision-source',
    source_id: fullAudit.review.decision_source.source_id,
    authoring_mode: 'separately-authored',
    scope: 'complete-canonical',
    source: structuredClone(fullAudit.source),
    authored_review_sha256: sha256Json(compactReview),
    authored_review: compactReview,
  };
  const replayed = buildSemanticAuditFromDecisionSource(infos, decisionSource, {
    batchDecisionSources: [batchSource],
  });
  assert.equal(replayed.review.records[0].sense_reviews[0].relation.decision, 'relations-reviewed');
  assert.doesNotThrow(() => validateSemanticAuditCoverage(infos, replayed));

  const shiftedRow = structuredClone(row);
  shiftedRow.sense_reviews[0].semantic_rationale = 'w9006 w9006-s1: adjacent candidate rationale was shifted here.';
  const shiftedSourceContent = {
    ...batchSourceContent,
    artifact_sha256: 'b'.repeat(64),
    decisions: [shiftedRow],
  };
  const shiftedBytes = Buffer.from(JSON.stringify(shiftedSourceContent), 'utf8');
  const shiftedSourceSha256 = createHash('sha256').update(shiftedBytes).digest('hex');
  const shiftedBatchSource = {
    source: shiftedSourceContent,
    sourceBytes: shiftedBytes,
    sourceSha256: shiftedSourceSha256,
    artifactSha256: shiftedSourceContent.artifact_sha256,
    byCandidateId: new Map([[record.id, shiftedRow]]),
  };
  const shiftedBinding = {
    ...binding,
    source_sha256: shiftedSourceSha256,
    artifact_sha256: shiftedSourceContent.artifact_sha256,
    decision_row_sha256: sha256Json(compactAuthoredSemanticDecisionRow(shiftedRow)),
  };
  const shiftedReview = structuredClone(fullAudit.review);
  shiftedReview.records[0].authored_batch_decision = shiftedBinding;
  const shiftedCompactReview = compactSemanticReviewArtifact(shiftedReview);
  const shiftedDecisionSource = {
    ...decisionSource,
    authored_review_sha256: sha256Json(shiftedCompactReview),
    authored_review: shiftedCompactReview,
  };
  assert.throws(
    () => buildSemanticAuditFromDecisionSource(infos, shiftedDecisionSource, {
      batchDecisionSources: [shiftedBatchSource],
    }),
    (error) => error.code === 'SEMANTIC_AUDIT_BATCH_SOURCE_MISMATCH',
  );

  const downgradedRow = structuredClone(row);
  delete downgradedRow.review_binding;
  const downgradedSourceContent = {
    ...batchSourceContent,
    contract_version: 'lexical-semantic-decision-source-v2',
    artifact_sha256: 'c'.repeat(64),
    decisions: [downgradedRow],
  };
  delete downgradedSourceContent.review_binding_contract_version;
  const downgradedBytes = Buffer.from(JSON.stringify(downgradedSourceContent), 'utf8');
  const downgradedSourceSha256 = createHash('sha256').update(downgradedBytes).digest('hex');
  const downgradedBatchSource = {
    source: downgradedSourceContent,
    sourceBytes: downgradedBytes,
    sourceSha256: downgradedSourceSha256,
    artifactSha256: downgradedSourceContent.artifact_sha256,
    sourcePath: 'data/batches/m5-14-semantic-decisions.json',
    byCandidateId: new Map([[record.id, downgradedRow]]),
  };
  const downgradedBinding = {
    ...binding,
    source_sha256: downgradedSourceSha256,
    artifact_sha256: downgradedSourceContent.artifact_sha256,
    decision_row_sha256: sha256Json(compactAuthoredSemanticDecisionRow(downgradedRow)),
  };
  const downgradedReview = structuredClone(fullAudit.review);
  downgradedReview.records[0].authored_batch_decision = downgradedBinding;
  const downgradedCompactReview = compactSemanticReviewArtifact(downgradedReview);
  const downgradedDecisionSource = {
    ...decisionSource,
    authored_review_sha256: sha256Json(downgradedCompactReview),
    authored_review: downgradedCompactReview,
  };
  assert.throws(
    () => buildSemanticAuditFromDecisionSource(infos, downgradedDecisionSource, {
      batchDecisionSources: [downgradedBatchSource],
    }),
    (error) => error.code === 'SEMANTIC_AUDIT_BATCH_SOURCE_MISMATCH',
    'a future v2 source cannot bypass semantic review binding validation',
  );

  const duplicatedReview = structuredClone(compactReview);
  duplicatedReview.records[0].boundary_review = structuredClone(fullAudit.review.records[0].boundary_review);
  const duplicatedSource = {
    ...decisionSource,
    authored_review_sha256: sha256Json(duplicatedReview),
    authored_review: duplicatedReview,
  };
  assert.throws(
    () => buildSemanticAuditFromDecisionSource(infos, duplicatedSource, {
      batchDecisionSources: [batchSource],
    }),
    (error) => error.code === 'SEMANTIC_AUDIT_REDUNDANT_AUTHORITY',
  );
});

test('the exact grandfathered M5-12A v2 source still replays through the shared semantic audit', async () => {
  const { artifact } = await buildCanonicalSemanticAudit({
    artifactId: 'm5-12a-grandfathered-replay-regression',
  });

  assert.equal(artifact.record_count, 3042);
  assert.equal(artifact.review.records.length, 3042);
  assert.ok(artifact.review.records.some((review) => review.record_id === 'w1279'));
});
