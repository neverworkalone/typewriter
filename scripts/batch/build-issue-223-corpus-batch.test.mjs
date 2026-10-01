import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindAuthoredParagraphReferences,
  assertIndependentSemanticReviewer,
  assertSemanticReviewEnvelope,
  parseSemanticReviewerRegistry,
  issue223CorrectionPassId,
  makeSemanticDecision,
  parseIssue223BatchId,
  selectPredecessorReviewFiles,
} from './build-issue-223-corpus-batch.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';

test('Issue #223 authored paragraph hit indexes bind to source paragraph IDs', () => {
  const hits = [
    { paragraph_id: 'document.1' },
    { paragraph_id: 'document.2' },
    { paragraph_id: 'document.3' },
  ];

  assert.deepEqual(bindAuthoredParagraphReferences(hits, [2, 0]), ['document.3', 'document.1']);
  assert.deepEqual(bindAuthoredParagraphReferences(hits, ['document.2']), ['document.2']);
  assert.deepEqual(bindAuthoredParagraphReferences(hits), ['document.1', 'document.2', 'document.3']);
});

test('Issue #223 authored paragraph hit indexes must stay within bounded evidence', () => {
  assert.throws(() => bindAuthoredParagraphReferences([{ paragraph_id: 'document.1' }], [1]));
  assert.throws(() => bindAuthoredParagraphReferences([{ paragraph_id: 'document.1' }], [-1]));
});

const REVIEW_NAMES = [1, 2, 3, 4, 5].map((n) => `issue-223-m9-e-corpus-batch-0${n}-candidate-review.json`);

test('Issue #223 rebuilding an earlier batch ignores later batch artifacts', () => {
  assert.deepEqual(
    selectPredecessorReviewFiles(REVIEW_NAMES, 'issue-223-m9-e-corpus-batch-01-20261001'),
    [],
  );
  assert.deepEqual(
    selectPredecessorReviewFiles(REVIEW_NAMES, 'issue-223-m9-e-corpus-batch-03-20261001'),
    REVIEW_NAMES.slice(0, 2),
  );
  assert.deepEqual(
    selectPredecessorReviewFiles(REVIEW_NAMES, 'issue-223-m9-e-corpus-batch-06-20261002'),
    REVIEW_NAMES,
  );
});

test('Issue #223 batch ids accept any valid batch date and reject invalid ones', () => {
  assert.deepEqual(parseIssue223BatchId('issue-223-m9-e-corpus-batch-06-20261102'), {
    ordinal: 6,
    ordinalText: '06',
    date: '20261102',
    stem: 'issue-223-m9-e-corpus-batch-06',
  });
  assert.throws(() => parseIssue223BatchId('issue-223-m9-e-corpus-batch-06-20261302'));
  assert.throws(() => parseIssue223BatchId('issue-223-m9-e-corpus-batch-06-20260230'));
  assert.throws(() => parseIssue223BatchId('issue-223-m9-e-corpus-batch-6-20261001'));
});

const CANDIDATE = { id: 'w9001', lemma: '가락', senses: [{ id: 'w9001-s1', pos: 'noun', gloss: '소리나 움직임이 이어지며 이루는 흐름' }] };
const ROW = { inventory_id: 'm5-1', editorial_judgment: { writer_use_axis: 'S' } };

function authoredReview(overrides = {}) {
  return {
    lemma: CANDIDATE.lemma,
    gloss_sha256: sha256Json(CANDIDATE.senses[0].gloss),
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
    ...overrides,
  };
}

test('Issue #223 builder cannot mint semantic pass evidence without an authored review', () => {
  assert.throws(() => makeSemanticDecision(ROW, CANDIDATE, 1, 'pass', 'source'));
  assert.throws(() => makeSemanticDecision(ROW, CANDIDATE, 1, 'pass', 'source', {}));
  assert.throws(() => makeSemanticDecision(ROW, CANDIDATE, 1, 'pass', 'source', authoredReview({ gloss_sha256: 'stale' })));
  assert.throws(() => makeSemanticDecision(ROW, CANDIDATE, 1, 'pass', 'source', authoredReview({ gloss_judgment: undefined })));
  assert.throws(() => makeSemanticDecision(ROW, CANDIDATE, 1, 'pass', 'source', authoredReview({ frames: [] })));
});

test('Issue #223 builder binds authored review judgments without replacing them', () => {
  const decision = makeSemanticDecision(ROW, CANDIDATE, 1, 'pass', 'source', authoredReview());
  assert.equal(decision.decision_rationale, 'm5-1 w9001: 독립 검토 결과 포함.');
  assert.equal(decision.sense_reviews[0].semantic_rationale, 'w9001 w9001-s1: 풀이가 표제어와 맞는다.');
  assert.equal(
    decision.sense_reviews[0].single_sense_boundary_review.frame_observations[0].sentence_frame,
    '“가락”이라는 말이 문장에 번졌다.',
  );
});

test('Issue #223 correction pass id derives from the batch date', () => {
  assert.equal(issue223CorrectionPassId('issue-223-m9-e-corpus-batch-06-20261002'),
    'issue-223-m9-e-corpus-batch-06-correction-20261002-r1');
});

test('Issue #223 semantic review input needs a bound, completed envelope', () => {
  const batchId = 'issue-223-m9-e-corpus-batch-06-20261002';
  const envelope = { schema_version: '1',
    contract_version: 'authored-semantic-review-input-v1',
    kind: 'authored-semantic-review-input', batch_id: batchId, reviewer: 'r', review_status: 'complete', reviews: [] };
  assertSemanticReviewEnvelope(envelope, batchId);
  assert.throws(() => assertSemanticReviewEnvelope([], batchId));
  assert.throws(() => assertSemanticReviewEnvelope({ ...envelope, batch_id: 'issue-223-m9-e-corpus-batch-05-20261001' }, batchId));
  assert.throws(() => assertSemanticReviewEnvelope({ ...envelope, review_status: 'draft' }, batchId));
  assert.throws(() => assertSemanticReviewEnvelope({ ...envelope, reviewer: '' }, batchId));
});

test('Issue #223 builder requires explicit authored boundary and topic outcomes', () => {
  assert.throws(() => makeSemanticDecision(ROW, CANDIDATE, 1, 'pass', 'source', authoredReview({ single_sense_boundary_status: undefined })));
  assert.throws(() => makeSemanticDecision(ROW, CANDIDATE, 1, 'pass', 'source', authoredReview({ single_sense_boundary_status: 'fail' })));
  const topicCandidate = { ...CANDIDATE, senses: [{ ...CANDIDATE.senses[0], gloss: '주문과 마술을 부리는 여성으로 그려지는 존재' }] };
  const topicReview = authoredReview({
    gloss_sha256: sha256Json(topicCandidate.senses[0].gloss),
    frames: [authoredReview().frames[0]],
  });
  assert.throws(() => makeSemanticDecision(ROW, topicCandidate, 1, 'pass', 'source', topicReview), /topic outcome/u);
  const reviewed = { ...topicReview, topic_analysis: { status: 'pass', state: 'adnominal', rationale: '관형 용법이다.' } };
  assert.equal(makeSemanticDecision(ROW, topicCandidate, 1, 'pass', 'source', reviewed)
    .sense_reviews[0].review_basis.topic_analysis.rationale, 'w9001 w9001-s1: 관형 용법이다.');
});

test('Issue #223 authored frames must match derived gloss spans exactly', () => {
  const multi = { ...CANDIDATE, senses: [{ ...CANDIDATE.senses[0], gloss: '집이나 길의 옆에 붙어 있는 집.' }] };
  const frame = authoredReview().frames[0];
  const review = (frames) => authoredReview({ gloss_sha256: sha256Json(multi.senses[0].gloss), frames });
  assert.throws(() => makeSemanticDecision(ROW, multi, 1, 'pass', 'source', review([frame])), /one frame per gloss span/u);
  assert.throws(() => makeSemanticDecision(ROW, multi, 1, 'pass', 'source', review([frame, frame, frame])), /one frame per gloss span/u);
});

test('Issue #223 independent reviewer must be registered and differ from the candidate author', () => {
  const registry = parseSemanticReviewerRegistry({ schema_version: 1, reviewers: [{ id: 'reviewer-a' }, { id: 'reviewer-b' }] });
  assertIndependentSemanticReviewer({ reviewer: 'reviewer-a', candidateAuthor: 'codex-agent', registry });
  assert.throws(() => assertIndependentSemanticReviewer({ reviewer: 'reviewer-a', candidateAuthor: 'reviewer-a', registry }), /self-review/u);
  assert.throws(() => assertIndependentSemanticReviewer({ reviewer: 'codex-agent', candidateAuthor: 'reviewer-a', registry }), /registry/u);
  assert.throws(() => assertIndependentSemanticReviewer({ reviewer: '', candidateAuthor: 'reviewer-a', registry }));
  assert.throws(() => parseSemanticReviewerRegistry({ schema_version: 1, reviewers: [{ id: 'a' }, { id: 'a' }] }));
  assert.throws(() => parseSemanticReviewerRegistry({ schema_version: 1, reviewers: [] }));
});
