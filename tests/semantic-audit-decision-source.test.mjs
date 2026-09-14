import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { rebuildSemanticEvidence } from '../scripts/validate/rebuild-semantic-evidence.mjs';
import {
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
