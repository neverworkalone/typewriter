import assert from 'node:assert/strict';
import test from 'node:test';

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateAuthoredSemanticDecisionSource } from './authored-semantic-decision-source.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';
import { makeSemanticDecision } from './build-issue-223-corpus-batch.mjs';
import { compactAuthoredSemanticDecisionRow } from '../validate/semantic-decision-row.mjs';
import { semanticDecisionConfig, validateReviewOnlyCanonicalImportBoundary, validateSemanticReviewInputBinding } from './validate-issue-223.mjs';

function reviewOnlyBatch() {
  return {
    batch_id: 'issue-223-m9-e-corpus-batch-05-20261001',
    canonical_import_status: 'owner-deferred-review-only',
    canonical_import_count: 0,
    canonical_import_deferred_count: 1,
    canonical_import_deferred_reason: 'Owner requested review decisions only for this checkpoint.',
    decision_counts: { admit: 1, hold: 1, reject: 0 },
    decisions: [
      {
        morphology_proposal: { lemma: '검토어' },
        editorial_judgment: { disposition: 'admit', candidate_record_id: 'w9064' },
      },
      {
        morphology_proposal: { lemma: '보류어' },
        editorial_judgment: { disposition: 'hold', candidate_record_id: null },
      },
    ],
  };
}

test('Issue #223 review-only candidates remain outside canonical imports', () => {
  const deferred = validateReviewOnlyCanonicalImportBoundary({
    candidateReview: reviewOnlyBatch(),
    semanticSourceExists: false,
    canonicalImportExists: false,
    currentCanonicalRecords: [{ record: { id: 'w9063', lemma: '기존어' } }],
  });

  assert.equal(deferred, 1);
});

test('Issue #223 review-only boundary rejects generated sidecars and existing canonical rows', () => {
  const candidateReview = reviewOnlyBatch();
  const base = {
    candidateReview,
    semanticSourceExists: false,
    canonicalImportExists: false,
    currentCanonicalRecords: [],
  };

  assert.throws(() => validateReviewOnlyCanonicalImportBoundary({ ...base, semanticSourceExists: true }));
  assert.throws(() => validateReviewOnlyCanonicalImportBoundary({ ...base, canonicalImportExists: true }));
  assert.throws(() => validateReviewOnlyCanonicalImportBoundary({
    ...base,
    currentCanonicalRecords: [{ id: 'w9064', lemma: '검토어' }],
  }));
});

test('Issue #223 review-only boundary binds its deferred count to the admit decisions', () => {
  const candidateReview = reviewOnlyBatch();
  candidateReview.canonical_import_deferred_count = 2;

  assert.throws(() => validateReviewOnlyCanonicalImportBoundary({
    candidateReview,
    semanticSourceExists: false,
    canonicalImportExists: false,
    currentCanonicalRecords: [],
  }));
});

test('Issue #223 validator derives the correction pass from a later batch date', () => {
  const review = {
    batch_id: 'issue-223-m9-e-corpus-batch-06-20261002',
    source_id: 'candidate-source',
    provenance: { generation_pass_id: 'generation' },
    decision_counts: { admit: 1 },
  };
  const semantic = { source_id: 'semantic-source', provenance: { verification_pass_id: 'verify', generator_version: 'v' } };
  assert.equal(
    semanticDecisionConfig(review, semantic, 'data/batches/x.json').correctionPassId,
    'issue-223-m9-e-corpus-batch-06-correction-20261002-r1',
  );
});

const BOUND_BATCH = 'issue-223-m9-e-corpus-batch-06-20261002';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const RECORD = { id: 'w9001', lemma: '가락', senses: [{ id: 'w9001-s1', pos: 'noun', gloss: '소리나 움직임이 이어지며 이루는 흐름' }] };
const ROW = {
  inventory_id: 'm5-1',
  morphology_proposal: { lemma: '가락' },
  editorial_judgment: { writer_use_axis: 'S' },
};

function authoredReview() {
  return {
    lemma: RECORD.lemma,
    gloss_sha256: sha256Json(RECORD.senses[0].gloss),
    gloss_judgment: 'fit',
    boundary_action: 'retain',
    boundary_classification: 'atomic',
    boundary_rationale: '하나의 의미로 읽힌다.',
    semantic_rationale: '풀이가 표제어와 맞는다.',
    no_relation_rationale: '관계 근거 없음.',
    decision_rationale: '독립 검토 결과 포함.',
    frame_rationale: '프레임이 같은 의미를 유지한다.',
    single_sense_boundary_status: 'pass',
    frames: [{ sentence_frame: '“가락”이라는 말이 문장에 번졌다.', relation_type: 'near', target_class: '흐름' }],
  };
}

function boundFixture({ input: inputOverrides = {}, mutateDecision } = {}) {
  const review = authoredReview();
  const input = {
    schema_version: '1',
    contract_version: 'authored-semantic-review-input-v1',
    kind: 'authored-semantic-review-input',
    batch_id: BOUND_BATCH,
    reviewer: 'independent-agent',
    review_status: 'complete',
    reviews: [review],
    ...inputOverrides,
  };
  const inputBytes = Buffer.from(JSON.stringify(input));
  const decision = makeSemanticDecision(ROW, RECORD, 1, 'pass-1', 'source-1', review);
  if (mutateDecision) mutateDecision(decision);
  return {
    semanticSource: {
      source_id: 'source-1',
      source_basis: { semantic_review_input_sha256: sha(inputBytes) },
      review: { reviewer: input.reviewer, review_pass_id: 'pass-1' },
      candidate_records: [RECORD],
      decisions: [decision],
    },
    inputBytes,
    batchId: BOUND_BATCH,
    admittedRows: [ROW],
  };
}

test('Issue #223 bound semantic review input passes and any non-reviewer reviewer is carried to the shared contract', () => {
  const fixture = boundFixture();
  const input = validateSemanticReviewInputBinding(fixture);
  assert.equal(input.reviewer, 'independent-agent');
  const review = { batch_id: BOUND_BATCH, source_id: 'c', provenance: { generation_pass_id: 'g' }, decision_counts: { admit: 1 } };
  const semantic = { source_id: 's', provenance: { verification_pass_id: 'v', generator_version: 'x' } };
  assert.equal(semanticDecisionConfig(review, semantic, 'p', input.reviewer).reviewer, 'independent-agent');
  assert.equal(semanticDecisionConfig(review, semantic, 'p').reviewer, undefined);
});

test('Issue #223 semantic review input binding fails closed when missing, tampered, mismatched, or unbound', () => {
  const ok = boundFixture();
  assert.throws(() => validateSemanticReviewInputBinding({ ...ok, inputBytes: null }), /missing/u);
  assert.throws(() => validateSemanticReviewInputBinding({ ...ok, inputBytes: Buffer.concat([ok.inputBytes, Buffer.from(' ')]) }), /digest/u);
  const other = boundFixture({ input: { batch_id: 'issue-223-m9-e-corpus-batch-05-20261001' } });
  assert.throws(() => validateSemanticReviewInputBinding({ ...other, batchId: BOUND_BATCH }));
  const extra = { ...ROW, morphology_proposal: { lemma: '다른' } };
  assert.throws(() => validateSemanticReviewInputBinding({ ...ok, admittedRows: [ROW, extra] }), /exactly the admitted/u);
  assert.throws(() => validateSemanticReviewInputBinding({ ...ok, semanticSource: { ...ok.semanticSource, review: { ...ok.semanticSource.review, reviewer: 'codex-agent' } } }), /reviewer/u);
  assert.throws(() => validateSemanticReviewInputBinding({
    ...ok, semanticSource: { ...ok.semanticSource, source_basis: {} }, inputBytes: null,
  }), /must bind/u);
});

test('Issue #223 emitted decisions must match the bound authored review even with a recomputed digest', () => {
  const mutations = {
    gloss_judgment: (d) => { d.gloss_judgment = 'weak'; },
    decision_rationale: (d) => { d.decision_rationale = '다른 근거'; },
    boundary_action: (d) => { d.sense_reviews[0].boundary_action = 'split'; },
    single_sense_status: (d) => { d.sense_reviews[0].single_sense_boundary_review.status = 'fail'; },
    frame: (d) => { d.sense_reviews[0].single_sense_boundary_review.frame_observations[0].sentence_frame = '바뀐 프레임 “가락”'; },
    frame_route: (d) => { d.sense_reviews[0].single_sense_boundary_review.frame_observations[0].writer_route.relation_type = 'mood'; },
  };
  for (const [name, mutateDecision] of Object.entries(mutations)) {
    const fixture = boundFixture({ mutateDecision });
    assert.throws(() => validateSemanticReviewInputBinding(fixture), /does not match its bound authored semantic review/u, name);
  }
  const missing = boundFixture();
  missing.semanticSource.decisions = [];
  assert.throws(() => validateSemanticReviewInputBinding(missing), /decision count/u);
});

test('Issue #223 legacy B01-B04 semantic sources stay exempt only without an input', () => {
  const legacy = { semanticSource: { source_basis: {} }, inputBytes: null, admittedRows: [] };
  assert.equal(validateSemanticReviewInputBinding({ ...legacy, batchId: 'issue-223-m9-e-corpus-batch-04-20261001' }), null);
  assert.throws(() => validateSemanticReviewInputBinding({ ...legacy, batchId: 'issue-223-m9-e-corpus-batch-05-20261001' }));
});

test('Issue #223 shared semantic validator enforces the bound reviewer, not a fixed one', () => {
  const batchFile = (suffix) => new URL(`../../data/batches/issue-223-m9-e-corpus-batch-01-${suffix}`, import.meta.url);
  const review = JSON.parse(readFileSync(batchFile('candidate-review.json')));
  const original = JSON.parse(readFileSync(batchFile('semantic-decisions.json')));
  const identities = review.decisions
    .filter((row) => row.editorial_judgment.disposition === 'admit')
    .map((row, index) => ({
      catalog_index: index,
      slot_id: `${review.batch_id}-slot-${String(index + 1).padStart(4, '0')}`,
      inventory_id: row.inventory_id,
      candidate_record_id: row.editorial_judgment.candidate_record_id,
      lemma: row.morphology_proposal.lemma,
      axis: row.editorial_judgment.writer_use_axis,
      record_type: 'entry',
      pos: row.morphology_proposal.pos,
    }));
  const run = (source, reviewer) => validateAuthoredSemanticDecisionSource({
    source,
    sourceBytes: Buffer.from(`${JSON.stringify(source, null, 2)}\n`),
    identities,
    candidateRecords: source.candidate_records,
    config: semanticDecisionConfig(review, source, 'data/batches/issue-223-m9-e-corpus-batch-01-semantic-decisions.json', reviewer),
  });
  const changed = structuredClone(original);
  changed.review.reviewer = 'independent-agent';
  const withoutDigest = structuredClone(changed);
  delete withoutDigest.artifact_sha256;
  withoutDigest.decisions = withoutDigest.decisions.map(compactAuthoredSemanticDecisionRow);
  changed.artifact_sha256 = sha256Json(withoutDigest);

  assert.doesNotThrow(() => run(changed, 'independent-agent'));
  assert.throws(() => run(changed), /review is incomplete/u);
  assert.throws(() => run(changed, 'someone-else'), /review is incomplete/u);
});
