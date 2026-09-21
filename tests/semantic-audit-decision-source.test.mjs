import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { rebuildSemanticEvidence } from '../scripts/validate/rebuild-semantic-evidence.mjs';
import {
  buildSemanticAuditFromDecisionSource,
  compactSemanticDecisionSource,
  SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
  sha256Json,
  validateSemanticAuditCoverage,
} from '../scripts/validate/semantic-audit.mjs';
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
  assert.deepEqual(authoredDecisionProjection(replayed), authoredDecisionProjection(fullAudit));
  assert.doesNotThrow(() => validateSemanticAuditCoverage(infos, replayed));
});
