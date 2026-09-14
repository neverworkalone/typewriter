import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import {
  auditCanonicalLexicalQuality,
  LexicalQualityError,
  inspectWriterDomainEvidence,
  inspectGlossConnectors,
  validateLexicalRecord,
} from '../scripts/validate/lexical-quality.mjs';
import { validateLexicalAddition } from '../scripts/batch/lexical-admission.mjs';
import { validateLexicalProduction } from '../scripts/batch/lexical-production.mjs';
import { buildSemanticAuditArtifact } from '../scripts/validate/semantic-audit.mjs';
import {
  DatasetIntegrityError,
  validateDatasetRecords,
  validateDatasetDirectory,
} from '../scripts/validate/dataset-integrity.mjs';

const FIXTURE_ROOT = path.resolve('tests/fixtures/lexical-quality');

test('the shared audit covers the complete current canonical dictionary', async () => {
  const result = await validateDatasetDirectory(path.resolve('data/canonical'), {
    checkPilotCompleteness: true,
  });
  assert.equal(result.recordCount, 1320);

  const { readCanonicalRecords } = await import('../scripts/validate/canonical-jsonl.mjs');
  const canonical = await readCanonicalRecords(path.resolve('data/canonical'));
  const audit = auditCanonicalLexicalQuality(canonical.records, { throwOnError: false });
  assert.equal(audit.scope, 'complete-canonical');
  assert.equal(audit.blocking_finding_count, 0);
  assert.equal(audit.record_count, 1320);
  assert.equal(audit.sense_count, 1607);
});

test('the common-domain rule accepts coordinated senses without an ID exception', async () => {
  const result = await validateDatasetDirectory(
    path.join(FIXTURE_ROOT, 'valid/common-domain.jsonl'),
  );
  assert.equal(result.recordCount, 2);
  assert.equal(result.senseCount, 2);
});

test('the complete-canonical audit rejects a merged sensory and affective sense', async () => {
  await assert.rejects(
    validateDatasetDirectory(path.join(FIXTURE_ROOT, 'invalid/merged-sense.jsonl')),
    (error) => {
      assert.ok(error instanceof DatasetIntegrityError);
      assert.equal(error.code, 'LEXICAL_MERGED_SENSE_GLOSS');
      assert.match(error.message, /맛이나 분위기/u);
      return true;
    },
  );
});

test('the shared audit rejects placeholder glosses for any batch', async () => {
  await assert.rejects(
    validateDatasetDirectory(path.join(FIXTURE_ROOT, 'invalid/placeholder.jsonl')),
    (error) => {
      assert.ok(error instanceof DatasetIntegrityError);
      assert.equal(error.code, 'LEXICAL_PLACEHOLDER_GLOSS');
      return true;
    },
  );
});

test('record-type and POS classification are common admission invariants', () => {
  const expressionWithEntryPos = {
    id: 'w903',
    record_type: 'expression',
    role: 'start',
    candidate_id: 'w903',
    lemma: '표현오류',
    search_forms: ['표현오류'],
    senses: [{ id: 'w903-s1', pos: 'noun', gloss: '표현 분류가 잘못된 후보' }],
  };
  assert.throws(
    () => validateLexicalRecord(expressionWithEntryPos, { mode: 'canonical', label: 'future-batch record' }),
    (error) => error instanceof LexicalQualityError && error.code === 'LEXICAL_EXPRESSION_POS',
  );
});

test('a later batch ID uses the same producer and prospective-dictionary gate', () => {
  const invalid = {
    id: 'candidate-future-001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'candidate-future-001',
    lemma: '다음어',
    search_forms: ['다음어'],
    senses: [{ id: 'candidate-future-001-s1', pos: 'adjective', gloss: '빛이나 소리가 선명하다' }],
  };
  const baseRecords = [{
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '기존말',
    search_forms: ['기존말'],
    senses: [{ id: 'w001-s1', pos: 'noun', gloss: '기존 의미' }],
  }];
  const baseRecordInfos = baseRecords.map((record) => ({ record, source: 'base' }));
  const baseAudit = buildSemanticAuditArtifact(baseRecordInfos);
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-2040',
      candidateRecords: [invalid],
      baseRecords: baseRecordInfos,
      prospectiveRecords: baseRecordInfos,
      semanticAudit: baseAudit,
    }),
    /distinct writer domains/u,
  );

  const valid = {
    ...invalid,
    id: 'candidate-future-002',
    candidate_id: 'candidate-future-002',
    senses: [{ id: 'candidate-future-002-s1', pos: 'adjective', gloss: '맛이나 냄새가 은은하다' }],
  };
  const admitted = {
    ...valid,
    id: 'w779',
    candidate_id: 'w779',
    senses: [{ id: 'w779-s1', pos: 'adjective', gloss: '맛이나 냄새가 은은하다' }],
  };
  const prospectiveRecordInfos = [
    ...baseRecordInfos,
    { record: admitted, source: 'prospective' },
  ];
  const result = validateLexicalAddition({
    batchId: 'future-batch-2040',
    candidateRecords: [valid],
    reviewedRecords: [admitted],
    baseRecords: baseRecordInfos,
    prospectiveRecords: prospectiveRecordInfos,
    semanticAudit: buildSemanticAuditArtifact(prospectiveRecordInfos),
  });
  assert.equal(result.pipeline_version, 'lexical-admission-v1');
  assert.equal(result.batch_id, 'future-batch-2040');
  assert.equal(result.audit.blocking_finding_count, 0);
});

test('a partial prospective dataset cannot bypass the complete-base contract', () => {
  const baseRecords = [{
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '기존말',
    search_forms: ['기존말'],
    senses: [{ id: 'w001-s1', pos: 'noun', gloss: '기존 의미' }],
  }];
  const baseRecordInfos = baseRecords.map((record) => ({ record, source: 'base' }));
  const newRecord = {
    id: 'w779',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w779',
    lemma: '새말',
    search_forms: ['새말'],
    senses: [{ id: 'w779-s1', pos: 'noun', gloss: '새 의미' }],
  };
  const partial = [{ record: newRecord, source: 'partial' }];
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-2041',
      reviewedRecords: [newRecord],
      baseRecords,
      prospectiveRecords: partial,
      semanticAudit: buildSemanticAuditArtifact(partial),
    }),
    /does not preserve base record w001/u,
  );
  assert.throws(
    () => validateDatasetRecords(baseRecordInfos, { requireSemanticAudit: true }),
    /semantic-audit coverage/u,
  );
});

function productionReview({ candidateRecord, reviewedRecord, gloss, boundaryDecision }) {
  const record = reviewedRecord ?? candidateRecord;
  const sense = record.senses[0];
  const evidence = inspectWriterDomainEvidence(gloss);
  return {
    status: 'complete',
    sense_boundary: {
      status: 'pass',
      findings: [{
        sense_id: sense.id,
        action: 'retain',
        classification: 'atomic',
        rationale: `future-batch ${sense.id} semantic boundary was reviewed`,
        semantic_evidence: {
          status: 'pass',
          gloss_sha256: createHash('sha256').update(JSON.stringify(gloss), 'utf8').digest('hex'),
          observed_domain_axes: evidence.axes,
          domain_evidence: evidence.matches,
          connector_observations: inspectGlossConnectors(gloss),
          rationale: `future-batch ${sense.id} observed domain axes were reviewed`,
          boundary_decision: boundaryDecision,
        },
      }],
    },
    pos: {
      status: 'pass',
      observed_pos: [sense.pos],
      rationale: 'future-batch POS was reviewed',
    },
    expression: {
      status: 'pass',
      expected_record_type: 'entry',
      observed_record_type: record.record_type,
      rationale: 'future-batch expression classification was reviewed',
    },
    relation: {
      status: 'pass',
      per_sense: [{
        sense_id: sense.id,
        relation_count: 0,
        relation_ids: [],
        no_relation_rationale: `future-batch ${sense.id} has no relation tuple after review`,
      }],
    },
    selection: {
      status: 'selected',
      rank: 1,
      score: 1,
      rationale: 'future-batch selected by verification and coverage',
    },
  };
}

test('the shared production review catches 과/와 and connector-free merged domains', () => {
  const baseRecords = [{
    id: 'w001',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w001',
    lemma: '기존말',
    search_forms: ['기존말'],
    senses: [{ id: 'w001-s1', pos: 'noun', gloss: '기존 의미' }],
  }];
  for (const [index, gloss] of ['맛과 분위기가 이어진다', '맛 분위기가 이어진다'].entries()) {
    const candidateRecord = {
      id: `proposal-future-${index + 1}`,
      record_type: 'entry',
      role: 'start',
      candidate_id: `proposal-future-${index + 1}`,
      lemma: `미래말${index + 1}`,
      search_forms: [`미래말${index + 1}`],
      senses: [{ id: `proposal-future-${index + 1}-s1`, pos: 'adjective', gloss }],
    };
    const reviewedRecord = {
      ...candidateRecord,
      id: `w${779 + index}`,
      candidate_id: `w${779 + index}`,
      senses: [{ id: `w${779 + index}-s1`, pos: 'adjective', gloss }],
    };
    const baseInfos = baseRecords.map((record) => ({ record, source: 'base' }));
    const prospectiveInfos = [...baseInfos, { record: reviewedRecord, source: 'prospective' }];
    assert.throws(
      () => validateLexicalProduction({
        batchId: `future-batch-204${index + 2}`,
        candidateRecords: [candidateRecord],
        reviews: [{
          candidate_id: candidateRecord.id,
          decision: 'included',
          reviewed_record: reviewedRecord,
          semantic_review: productionReview({
            candidateRecord,
            reviewedRecord,
            gloss,
            boundaryDecision: 'atomic',
          }),
        }],
        baseRecords: baseInfos,
        prospectiveRecords: prospectiveInfos,
        semanticAudit: buildSemanticAuditArtifact(prospectiveInfos),
        stageEvidence: {
          candidate_intake: {
            status: 'complete',
            source_path: '/tmp/future-proposal.json',
            source_bytes: Buffer.from('future proposal'),
            source_sha256: createHash('sha256').update('future proposal').digest('hex'),
          },
          semantic_review: {
            status: 'complete',
            source_path: '/tmp/future-review.json',
            source_bytes: Buffer.from('future review'),
            source_sha256: createHash('sha256').update('future review').digest('hex'),
          },
          selection: {
            status: 'complete',
            source_path: '/tmp/future-selection.json',
            source_bytes: Buffer.from('future selection'),
            source_sha256: createHash('sha256').update('future selection').digest('hex'),
            policy: 'shared',
          },
        },
        catalogCount: 1,
        expectedSelectedCount: 1,
      }),
      /multiple writer domains|semantic review must split/u,
    );
  }
});

test('a later batch cannot bypass the shared generation and review stages', () => {
  assert.throws(
    () => validateLexicalProduction({
      batchId: 'future-batch-2044',
      candidateRecords: [{ id: 'proposal-1' }],
      reviews: [],
    }),
    /reviews must cover every candidate record/u,
  );
});
