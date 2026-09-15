import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import {
  auditCanonicalLexicalQuality,
  LexicalQualityError,
  inspectWriterDomainEvidence,
  inspectGlossQuality,
  inspectGlossConnectors,
  validateLexicalSemanticReview,
  validateLexicalRecord,
} from '../scripts/validate/lexical-quality.mjs';
import { validateLexicalAddition } from '../scripts/batch/lexical-admission.mjs';
import { validateLexicalProduction } from '../scripts/batch/lexical-production.mjs';
import {
  buildSemanticCoverageArtifact,
  canonicalRecordsSha256,
  inspectSenseBoundaryPairs,
  validateSemanticAuditCoverage,
} from '../scripts/validate/semantic-audit.mjs';
import {
  makeProductionState,
  makeSemanticAudit,
} from './helpers/semantic-audit-fixture.mjs';
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
  assert.equal(audit.sense_count, 1579);
});

test('the shared lexical audit rejects malformed topic fragments without a record allowlist', () => {
  const record = {
    id: 'w9999',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w9999',
    lemma: '형태오류',
    search_forms: ['형태오류'],
    senses: [{ id: 'w9999-s1', pos: 'noun', gloss: '바닥은 깔개' }],
  };
  const audit = auditCanonicalLexicalQuality([{ record, source: 'synthetic' }], {
    throwOnError: false,
  });
  assert.equal(audit.blocking_findings[0].code, 'LEXICAL_MALFORMED_GLOSS');
  assert.equal(audit.blocking_findings[0].sense_id, 'w9999-s1');
  assert.equal(inspectGlossQuality('바다는 넓다').malformed_structure, false);
});

test('authored distinct and retain cannot override high-confidence usage or paraphrase frames', () => {
  const cases = [
    {
      lemma: '도구용례',
      glosses: ['종이를 자르는 도구', '천을 자르는 도구'],
      relationship: 'usage-variant',
    },
    {
      lemma: '한음절동작',
      glosses: ['국물을 뜨는 도구', '물을 뜨는 자루 달린 도구'],
      relationship: 'usage-variant',
    },
    {
      lemma: '겹침표현',
      glosses: ['남의 마음을 함께 느끼는 일', '처지를 함께 느끼는 일'],
      relationship: 'overlapping',
    },
    {
      lemma: '문맥분할',
      glosses: ['글에서 중심이 되는 생각', '말에서 중심이 되는 생각'],
      relationship: 'usage-variant',
    },
  ];
  for (const [index, item] of cases.entries()) {
    const id = `w-semantic-frame-${index + 1}`;
    const record = {
      id,
      record_type: 'entry',
      role: 'start',
      candidate_id: id,
      lemma: item.lemma,
      search_forms: [item.lemma],
      senses: item.glosses.map((gloss, senseIndex) => ({
        id: `${id}-s${senseIndex + 1}`,
        pos: 'noun',
        gloss,
      })),
    };
    assert.equal(inspectSenseBoundaryPairs(record)[0].relationship, item.relationship);
    const infos = [{ record, source: 'synthetic' }];
    const audit = makeSemanticAudit(infos, {
      boundaryDecisions: {
        [id]: { decision: 'split', classification: 'separated' },
      },
    });
    assert.throws(
      () => validateSemanticAuditCoverage(infos, audit),
      (error) => error.code === 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
    );
  }
});

test('generic tool heads do not turn unrelated action frames into usage variants', () => {
  const record = {
    id: 'w-tool-negative-control',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-tool-negative-control',
    lemma: '열쇠',
    search_forms: ['열쇠'],
    senses: [
      { id: 'w-tool-negative-control-s1', pos: 'noun', gloss: '문을 여는 도구' },
      { id: 'w-tool-negative-control-s2', pos: 'noun', gloss: '문제를 푸는 도구' },
    ],
  };
  const infos = [{ record, source: 'synthetic' }];
  assert.equal(inspectSenseBoundaryPairs(record)[0].relationship, 'distinct');
  const audit = makeSemanticAudit(infos, {
    boundaryDecisions: {
      [record.id]: { decision: 'split', classification: 'separated' },
    },
  });
  assert.doesNotThrow(() => validateSemanticAuditCoverage(infos, audit));
});

test('the independent boundary audit uses authored pair decisions for any record', () => {
  const makeRecord = (glosses) => ({
    id: 'w-boundary-regression',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-boundary-regression',
    lemma: '경계회귀',
    search_forms: ['경계회귀'],
    senses: glosses.map((gloss, index) => ({
      id: `w-boundary-regression-s${index + 1}`,
      pos: 'noun',
      gloss,
    })),
  });

  for (const glosses of [
    ['같은 뜻을 설명한다', '같은 뜻을 설명한다'],
    ['붉은 꽃', '붉은 꽃 피어남'],
  ]) {
    const record = makeRecord(glosses);
    const infos = [{ record, source: 'future-candidate' }];
    const audit = makeSemanticAudit(infos, {
      boundaryDecisions: {
        [record.id]: { decision: 'split', classification: 'separated' },
      },
    });
    const pair = audit.review.records[0].boundary_review.pairwise[0];
    assert.throws(
      () => validateSemanticAuditCoverage(infos, audit),
      (error) => error.code === 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
    );
    pair.relationship = glosses[0] === glosses[1] ? 'duplicate' : 'nested';
    pair.decision = 'merge';
    assert.throws(
      () => validateSemanticAuditCoverage(infos, audit),
      (error) => error.code === 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
    );
  }
});

test('usage-variant pair decisions are explicit and do not depend on pair count', () => {
  const record = {
    id: 'w-boundary-usage-variant',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-boundary-usage-variant',
    lemma: '용례변주',
    search_forms: ['용례변주'],
    senses: [
      { id: 'w-boundary-usage-variant-s1', pos: 'noun', gloss: '손으로 만지는 표면의 감각.' },
      { id: 'w-boundary-usage-variant-s2', pos: 'noun', gloss: '말에서 드러나는 표면적인 인상.' },
    ],
  };
  const infos = [{ record, source: 'future-candidate' }];
  const audit = makeSemanticAudit(infos, {
    boundaryDecisions: {
      [record.id]: { decision: 'split', classification: 'separated' },
    },
  });
  const boundary = audit.review.records[0].boundary_review;
  boundary.pairwise[0].relationship = 'usage-variant';
  assert.equal(boundary.decision, 'split');
  assert.doesNotThrow(() => validateSemanticAuditCoverage(infos, audit));
  assert.equal(inspectSenseBoundaryPairs(record)[0].relationship, 'distinct');
});

test('the boundary audit rejects evidence that claims independence but uses the current sense count', () => {
  const record = {
    id: 'w-boundary-independence',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w-boundary-independence',
    lemma: '독립검수',
    search_forms: ['독립검수'],
    senses: [{ id: 'w-boundary-independence-s1', pos: 'noun', gloss: '내용을 따로 살피는 검수.' }],
  };
  const infos = [{ record, source: 'future-candidate' }];
  const audit = makeSemanticAudit(infos);
  audit.review.records[0].boundary_review.independence.independent_of_sense_count = false;
  assert.throws(
    () => validateSemanticAuditCoverage(infos, audit),
    (error) => error.code === 'SEMANTIC_AUDIT_BOUNDARY_BLOCKER',
  );
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

test('the shared audit rejects duplicate lemmas and search forms without a batch exception', () => {
  const records = ['w904', 'w905'].map((id) => ({
    record: {
      id,
      record_type: 'entry',
      role: 'start',
      candidate_id: id,
      lemma: '중복표제어',
      search_forms: ['중복표제어'],
      senses: [{ id: `${id}-s1`, pos: 'noun', gloss: '서로 겹치는 표제어 의미.' }],
    },
    source: 'synthetic',
  }));
  const audit = auditCanonicalLexicalQuality(records, { throwOnError: false });
  assert.deepEqual(
    audit.blocking_findings.map(({ code }) => code).sort(),
    ['LEXICAL_DUPLICATE_LEMMA', 'LEXICAL_DUPLICATE_SEARCH_FORM'],
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
  const baseAudit = makeSemanticAudit(baseRecordInfos);
  const invalidProductionState = makeProductionState({
    batchId: 'future-batch-2040',
    candidateRecords: [invalid],
    baseRecords: baseRecordInfos,
    prospectiveRecords: baseRecordInfos,
    semanticAudit: baseAudit,
  });
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-2040',
      candidateRecords: [invalid],
      baseRecords: baseRecordInfos,
      prospectiveRecords: baseRecordInfos,
      semanticAudit: baseAudit,
      productionState: invalidProductionState.state,
      productionStateSources: invalidProductionState.sources,
      productionPayloads: invalidProductionState.payloads,
    }),
    /distinct writer domains/u,
  );

  const valid = {
    ...invalid,
    id: 'w779',
    candidate_id: 'w779',
    senses: [{ id: 'w779-s1', pos: 'adjective', gloss: '맛이나 냄새가 은은하다' }],
  };
  const admitted = valid;
  const prospectiveRecordInfos = [
    ...baseRecordInfos,
    { record: admitted, source: 'prospective' },
  ];
  const validProductionState = makeProductionState({
    batchId: 'future-batch-2040',
    candidateRecords: [valid],
    reviewedRecords: [admitted],
    baseRecords: baseRecordInfos,
    prospectiveRecords: prospectiveRecordInfos,
    semanticAudit: makeSemanticAudit(prospectiveRecordInfos),
  });
  const result = validateLexicalAddition({
    batchId: 'future-batch-2040',
    candidateRecords: [valid],
    reviewedRecords: [admitted],
    baseRecords: baseRecordInfos,
    prospectiveRecords: prospectiveRecordInfos,
    semanticAudit: makeSemanticAudit(prospectiveRecordInfos),
    productionState: validProductionState.state,
    productionStateSources: validProductionState.sources,
    productionPayloads: validProductionState.payloads,
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
  const partialProductionState = makeProductionState({
    batchId: 'future-batch-2041',
    reviewedRecords: [newRecord],
    baseRecords: baseRecordInfos,
    prospectiveRecords: partial,
    semanticAudit: makeSemanticAudit(partial),
  });
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-2041',
      reviewedRecords: [newRecord],
      baseRecords,
      prospectiveRecords: partial,
      semanticAudit: makeSemanticAudit(partial),
      productionState: partialProductionState.state,
      productionStateSources: partialProductionState.sources,
      productionPayloads: partialProductionState.payloads,
    }),
    /missing base record w001|does not preserve base record w001/u,
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
  const decisionSourceId = `future-batch:${record.id}:decision-source`;
  return {
    status: 'complete',
    decision_source: {
      kind: 'separately-authored-semantic-decision-source',
      contract_version: 'lexical-semantic-decision-source-v1',
      source_id: decisionSourceId,
      path: `tests/fixtures/${record.id}-decision-source.json`,
    },
    sense_boundary: {
      status: 'pass',
      decision_source_id: decisionSourceId,
      review_id: `future-batch:${record.id}:boundary`,
      method: 'gloss-and-usage-pairwise-v2',
      independence: {
        independent_of_sense_count: true,
        source: 'separately-authored-future-boundary-decision',
        decision_source_id: decisionSourceId,
        decision_source_version: 'lexical-semantic-boundary-decisions-v1',
      },
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
          decision_source_id: decisionSourceId,
        },
      }],
      pairwise: [],
      rationale: `future-batch ${record.id} boundary was authored independently of the current sense count`,
    },
    pos: {
      status: 'pass',
      decision: 'verified',
      observed_pos: [sense.pos],
      decision_source_id: decisionSourceId,
      rationale: 'future-batch POS was reviewed',
    },
    expression: {
      status: 'pass',
      decision: 'verified',
      expected_record_type: 'entry',
      observed_record_type: record.record_type,
      decision_source_id: decisionSourceId,
      rationale: 'future-batch expression classification was reviewed',
    },
    relation: {
      status: 'pass',
      decision_source_id: decisionSourceId,
      per_sense: [{
        sense_id: sense.id,
        decision: 'no-relations',
        decision_source_id: decisionSourceId,
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

function multiSenseProductionReview(record, { relationship = 'distinct', pairDecision = 'retain' } = {}) {
  const decisionSourceId = `future-batch:${record.id}:decision-source`;
  const pair = inspectSenseBoundaryPairs(record)[0];
  const left = record.senses[0];
  const right = record.senses[1];
  const leftGlossSha256 = createHash('sha256').update(JSON.stringify(left.gloss), 'utf8').digest('hex');
  const rightGlossSha256 = createHash('sha256').update(JSON.stringify(right.gloss), 'utf8').digest('hex');
  return {
    status: 'complete',
    decision_source: {
      kind: 'separately-authored-semantic-decision-source',
      contract_version: 'lexical-semantic-decision-source-v1',
      source_id: decisionSourceId,
      path: `tests/fixtures/${record.id}-decision-source.json`,
    },
    sense_boundary: {
      status: 'pass',
      decision_source_id: decisionSourceId,
      review_id: `future-batch:${record.id}:boundary`,
      method: 'gloss-and-usage-pairwise-v2',
      independence: {
        independent_of_sense_count: true,
        source: 'separately-authored-future-boundary-decision',
        decision_source_id: decisionSourceId,
        decision_source_version: 'lexical-semantic-boundary-decisions-v1',
      },
      findings: record.senses.map((sense) => ({
        sense_id: sense.id,
        action: 'split',
        classification: 'separated',
        rationale: `${record.id} ${sense.id} was reviewed from the authored pair decision`,
        semantic_evidence: {
          status: 'pass',
          gloss_sha256: createHash('sha256').update(JSON.stringify(sense.gloss), 'utf8').digest('hex'),
          observed_domain_axes: [],
          domain_evidence: [],
          connector_observations: [],
          rationale: `${record.id} ${sense.id} semantic evidence was authored`,
          boundary_decision: 'split',
          decision_source_id: decisionSourceId,
        },
      })),
      pairwise: [{
        left_sense_id: pair.left_sense_id,
        right_sense_id: pair.right_sense_id,
        relationship,
        decision: pairDecision,
        left_gloss_sha256: leftGlossSha256,
        right_gloss_sha256: rightGlossSha256,
        evidence_basis: 'both glosses were explicitly compared by the reviewer',
        distinguishing_feature: 'the pair has an authored writer-facing distinction',
        decision_source_id: decisionSourceId,
        rationale: `${record.id} ${left.id} ${right.id} pair cites ${leftGlossSha256.slice(0, 12)} and ${rightGlossSha256.slice(0, 12)}.`,
      }],
      rationale: `${record.id} pair boundary was authored independently of the current sense count`,
    },
    pos: {
      status: 'pass',
      decision: 'verified',
      observed_pos: ['noun', 'noun'],
      decision_source_id: decisionSourceId,
      rationale: `${record.id} POS was explicitly verified`,
    },
    expression: {
      status: 'pass',
      decision: 'verified',
      expected_record_type: 'entry',
      observed_record_type: 'entry',
      decision_source_id: decisionSourceId,
      rationale: `${record.id} record type was explicitly verified`,
    },
    relation: {
      status: 'pass',
      decision_source_id: decisionSourceId,
      per_sense: record.senses.map((sense) => ({
        sense_id: sense.id,
        decision: 'no-relations',
        decision_source_id: decisionSourceId,
        relation_count: 0,
        relation_ids: [],
        no_relation_rationale: `${record.id} ${sense.id} has no relation tuple after authored review`,
      })),
    },
    selection: {
      status: 'selected',
      rank: 1,
      score: 1,
      rationale: `${record.id} selected by authored verification and coverage`,
    },
  };
}

test('the common production review cannot override mechanical duplicate or nested pairs', () => {
  for (const glosses of [
    ['같은 뜻을 설명한다', '같은 뜻을 설명한다'],
    ['붉은 꽃', '붉은 꽃 피어남'],
  ]) {
    const record = {
      id: 'w-common-boundary-regression',
      record_type: 'entry',
      role: 'start',
      candidate_id: 'w-common-boundary-regression',
      lemma: '공통경계회귀',
      search_forms: ['공통경계회귀'],
      senses: glosses.map((gloss, index) => ({
        id: `w-common-boundary-regression-s${index + 1}`,
        pos: 'noun',
        gloss,
      })),
    };
    assert.throws(
      () => validateLexicalSemanticReview(multiSenseProductionReview(record), {
        decision: 'included',
        candidateRecord: record,
        catalogCount: 1,
        requireSemanticEvidence: true,
      }),
      (error) => error.code === 'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
    );
  }
});

test('the common production review cannot override mechanical usage or paraphrase pairs', () => {
  const cases = [
    ['종이를 자르는 도구', '천을 자르는 도구', 'usage-variant'],
    ['남의 마음을 함께 느끼는 일', '처지를 함께 느끼는 일', 'overlapping'],
    ['글에서 중심이 되는 생각', '말에서 중심이 되는 생각', 'usage-variant'],
  ];
  for (const [index, [leftGloss, rightGloss, relationship]] of cases.entries()) {
    const record = {
      id: `w-common-frame-regression-${index + 1}`,
      record_type: 'entry',
      role: 'start',
      candidate_id: `w-common-frame-regression-${index + 1}`,
      lemma: `공통프레임회귀${index + 1}`,
      search_forms: [`공통프레임회귀${index + 1}`],
      senses: [leftGloss, rightGloss].map((gloss, senseIndex) => ({
        id: `w-common-frame-regression-${index + 1}-s${senseIndex + 1}`,
        pos: 'noun',
        gloss,
      })),
    };
    assert.equal(inspectSenseBoundaryPairs(record)[0].relationship, relationship);
    assert.throws(
      () => validateLexicalSemanticReview(multiSenseProductionReview(record, {
        relationship,
      }), {
        decision: 'included',
        candidateRecord: record,
        catalogCount: 1,
        requireSemanticEvidence: true,
      }),
      (error) => error.code === 'LEXICAL_SEMANTIC_BOUNDARY_BLOCKER',
    );
  }
});

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
      id: `w${779 + index}`,
      record_type: 'entry',
      role: 'start',
      candidate_id: `w${779 + index}`,
      lemma: `미래말${index + 1}`,
      search_forms: [`미래말${index + 1}`],
      senses: [{ id: `w${779 + index}-s1`, pos: 'adjective', gloss }],
    };
    const reviewedRecord = {
      ...candidateRecord,
      id: `w${779 + index}`,
      candidate_id: `w${779 + index}`,
      senses: [{ id: `w${779 + index}-s1`, pos: 'adjective', gloss }],
    };
    const baseInfos = baseRecords.map((record) => ({ record, source: 'base' }));
    const prospectiveInfos = [...baseInfos, { record: reviewedRecord, source: 'prospective' }];
    const semanticAudit = makeSemanticAudit(prospectiveInfos);
    const productionState = makeProductionState({
      batchId: `future-batch-204${index + 2}`,
      candidateRecords: [candidateRecord],
      reviewedRecords: [reviewedRecord],
      baseRecords: baseInfos,
      prospectiveRecords: prospectiveInfos,
      semanticAudit,
    });
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
        semanticAudit,
        productionState: productionState.state,
        productionStateSources: productionState.sources,
        productionPayloads: productionState.payloads,
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

test('a semantic audit becomes stale when gloss, POS, or relation content changes', () => {
  const base = {
    id: 'w901',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w901',
    lemma: '감사기준',
    search_forms: ['감사기준'],
    senses: [{
      id: 'w901-s1',
      pos: 'noun',
      gloss: '검증 가능한 의미 기준.',
    }],
  };
  const baseInfos = [{ record: base, source: 'base' }];
  const audit = makeSemanticAudit(baseInfos);
  const mutations = [
    (record) => ({
      ...record,
      senses: [{ ...record.senses[0], gloss: '검증 가능한 수정 의미 기준.' }],
    }),
    (record) => ({
      ...record,
      senses: [{ ...record.senses[0], pos: 'adjective' }],
    }),
    (record) => ({
      ...record,
      senses: [{
        ...record.senses[0],
        relations: [{ target: 'w902', type: 'near', note: '검증 관계' }],
      }],
    }),
  ];
  for (const mutate of mutations) {
    const prospective = [{ record: mutate(structuredClone(base)), source: 'prospective' }];
    assert.throws(
      () => validateSemanticAuditCoverage(prospective, audit),
      /does not match|mismatch|drifted/u,
    );
  }
});

test('deterministic coverage alone cannot satisfy the semantic review contract', () => {
  const record = {
    id: 'w902',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w902',
    lemma: '검수범위',
    search_forms: ['검수범위'],
    senses: [{ id: 'w902-s1', pos: 'noun', gloss: '명시적으로 검수할 범위.' }],
  };
  const infos = [{ record, source: 'prospective' }];
  const coverageOnly = buildSemanticCoverageArtifact(infos);
  assert.throws(
    () => validateSemanticAuditCoverage(infos, coverageOnly),
    /contract version|semantic audit\.coverage|review/u,
  );
  assert.equal(Object.hasOwn(coverageOnly.records[0].sense_coverage[0], 'sense_boundary'), false);
});

test('reviewed existing-record correction passes while an unreviewed replacement fails', () => {
  const base = {
    id: 'w903',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w903',
    lemma: '교정대상',
    search_forms: ['교정대상'],
    senses: [{ id: 'w903-s1', pos: 'noun', gloss: '기존 의미.' }],
  };
  const corrected = {
    ...base,
    senses: [{ id: 'w903-s1', pos: 'noun', gloss: '검수 후 확정한 의미.' }],
  };
  const baseInfos = [{ record: base, source: 'base' }];
  const prospectiveInfos = [{ record: corrected, source: 'prospective' }];
  const changes = [{
    record_id: corrected.id,
    decision: 'corrected',
    base_record_sha256: createHash('sha256').update(JSON.stringify(base), 'utf8').digest('hex'),
    prospective_record_sha256: createHash('sha256').update(JSON.stringify(corrected), 'utf8').digest('hex'),
    rationale: 'w903 was explicitly corrected and re-reviewed before replacement.',
  }];
  const audit = makeSemanticAudit(prospectiveInfos, { changes });
  const correctionProductionState = makeProductionState({
    batchId: 'future-batch-correction',
    reviewedRecords: [{ record: corrected, decision: 'corrected' }],
    baseRecords: baseInfos,
    prospectiveRecords: prospectiveInfos,
    semanticAudit: audit,
  });
  const admitted = validateLexicalAddition({
    batchId: 'future-batch-correction',
    baseRecords: baseInfos,
    reviewedRecords: [{ record: corrected, decision: 'corrected' }],
    prospectiveRecords: prospectiveInfos,
    semanticAudit: audit,
    productionState: correctionProductionState.state,
    productionStateSources: correctionProductionState.sources,
    productionPayloads: correctionProductionState.payloads,
  });
  assert.equal(admitted.reviewed_count, 1);
  assert.throws(
    () => validateLexicalAddition({
      batchId: 'future-batch-correction',
      baseRecords: baseInfos,
      reviewedRecords: [],
      prospectiveRecords: prospectiveInfos,
      semanticAudit: audit,
      productionState: correctionProductionState.state,
      productionStateSources: correctionProductionState.sources,
      productionPayloads: correctionProductionState.payloads,
    }),
    /does not preserve base record w903|corrected/u,
  );
});
