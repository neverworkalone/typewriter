import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertLegacyReviewWorkflowAllowed,
  assertReviewContractForBatch,
  assertSelfCheckBinding,
  assertSelfCheckEnvelope,
  assertSourceClaimsTruthful,
  isSelfCheckInput,
  SELF_CHECK_PROVENANCE,
} from './semantic-self-check.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';

const AUTHOR = 'claude-sonnet-5-5';
const GLOSS = { text: '예시 뜻풀이' };

const NOTES = {
  가나: { boundary: '첫 용례는 장소를, 둘째 용례도 같은 장소를 가리킨다', semantic: '풀이의 핵심어가 두 용례 모두에서 확인된다' },
  다라: { boundary: '용례마다 대상이 달라 하나로 묶기 어렵다', semantic: '풀이가 한 용례에만 맞는다' },
  마바: { boundary: '동사형 활용만 보이며 다른 품사 용법이 없다', semantic: '풀이의 동작 서술이 용례의 흐름과 일치한다' },
};
const row = (lemma) => ({
  morphology_proposal: { lemma, pos: 'noun' },
  bounded_provenance: { representative_hits: [{}, {}, {}] },
});
const outcome = (ordinal, lemma, verdict) => (verdict === 'pass'
  ? {
    ordinal, lemma, verdict, identity_check: 'ok', pos_check: 'ok', gloss_check: 'fit', sense_boundary_check: 'single', checked_hit_indices: [0, 1],
  }
  : { ordinal, lemma, verdict });
const review = (lemma) => ({
  lemma,
  identity_check: 'ok',
  pos_check: 'ok',
  gloss_check: 'fit',
  sense_boundary_check: 'single',
  checked_hit_indices: [0, 1],
  gloss_sha256: sha256Json(GLOSS),
  boundary_rationale: `${lemma}: ${NOTES[lemma].boundary}`,
  semantic_rationale: `${lemma}: ${NOTES[lemma].semantic}`,
});

const fixture = () => {
  const candidateRows = [row('가나'), row('다라'), row('마바')];
  return {
    candidateRows,
    glossByLemma: new Map([['가나', GLOSS], ['다라', GLOSS], ['마바', GLOSS]]),
    input: {
      review_provenance: SELF_CHECK_PROVENANCE,
      independent_review: false,
      reviewer: AUTHOR,
      candidate_outcomes: [outcome(1, '가나', 'pass'), outcome(2, '다라', 'hold'), outcome(3, '마바', 'pass')],
      reviews: [review('가나'), review('마바')],
    },
  };
};
const clone = (value) => structuredClone(value);
const envelope = (input, ordinal = 11) => assertSelfCheckEnvelope(input, { ordinal, candidateAuthor: AUTHOR });
const binding = (f) => assertSelfCheckBinding(f);

test('an honest agent self-check is accepted', () => {
  const f = fixture();
  assert.ok(isSelfCheckInput(f.input));
  envelope(f.input);
  binding(f);
});

test('the self-check envelope rejects spoofed or missing provenance', () => {
  const base = fixture().input;
  const cases = {
    'missing provenance': (i) => { delete i.review_provenance; },
    'invalid provenance': (i) => { i.review_provenance = 'independent-review'; },
    'independent_review omitted': (i) => { delete i.independent_review; },
    'independent_review true': (i) => { i.independent_review = true; },
    'separate reviewer label': (i) => { i.reviewer = 'claude-sonnet-5-5-independent-reviewer'; },
    'review_runs artifact': (i) => { i.review_runs = []; },
    'run record digest': (i) => { i.run_record_sha256 = 'a'.repeat(64); },
    'proposal digest': (i) => { i.generator_proposal_sha256 = 'a'.repeat(64); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const input = clone(base);
    mutate(input);
    assert.throws(() => (isSelfCheckInput(input) ? envelope(input) : assert.fail('not a self-check')), undefined, name);
  }
  assert.throws(() => envelope(clone(base), 10), /from batch 11/u, 'earlier batches keep their original contract');
});

test('the self-check binding rejects inconsistent outcomes and reviews', () => {
  const cases = {
    'missing outcome': (f) => { f.input.candidate_outcomes.pop(); },
    'out-of-order outcome': (f) => { f.input.candidate_outcomes.reverse(); },
    'gloss digest mismatch': (f) => { f.input.reviews[0].gloss_sha256 = sha256Json({ text: '다른 뜻' }); },
    'held candidate carries a review': (f) => { f.input.reviews.push(review('다라')); },
    'passed candidate lacks a review': (f) => { f.input.reviews.pop(); },
    'review and outcome disagree': (f) => { f.input.reviews[0].checked_hit_indices = [2]; },
    'duplicate review lemma': (f) => { f.input.reviews.push(clone(f.input.reviews[0])); },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const f = fixture();
    mutate(f);
    assert.throws(() => binding(f), undefined, name);
  }
});

test('the canonical source of a self-check batch never claims independent or human review', () => {
  const honest = () => ({
    provenance: { authoring_note: 'checked by the producing AI agent (agent self-check; not independent, separately authored, or human review).' },
    review: {
      review_provenance: SELF_CHECK_PROVENANCE,
      independent_review: false,
      method: 'The producing agent checks each identity (agent self-check, not independent or human review).',
    },
    selection: { coverage_basis: ['identity after agent self-check semantic eligibility'], selection_rationale: 'Every self-checked, admitted identity proceeds.' },
  });
  assertSourceClaimsTruthful(honest(), { selfCheck: true });
  const cases = {
    'missing flag': (s) => { delete s.review.review_provenance; },
    'independent_review true': (s) => { s.review.independent_review = true; },
    'separately verify method': (s) => { s.review.method = 'Separately verify each identity.'; },
    'independent coverage basis': (s) => { s.selection.coverage_basis = ['identity after independent semantic eligibility']; },
    'independently reviewed rationale': (s) => { s.selection.selection_rationale = 'Every independently reviewed identity proceeds.'; },
    'self-check parenthetical hiding a human claim': (s) => { s.review.method = 'The agent checks identities (self-check; human review completed).'; },
    'self-check parenthetical hiding an independent claim': (s) => { s.provenance.authoring_note = 'checked (agent self-check and independent reviewer approved).'; },
    'human authoring note': (s) => { s.provenance.authoring_note = 'Each lemma was human reviewed.'; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const source = honest();
    mutate(source);
    assert.throws(() => assertSourceClaimsTruthful(source, { selfCheck: true }), undefined, name);
  }
  // Legacy independent-review sources must not carry the self-check flags.
  assert.throws(() => assertSourceClaimsTruthful(honest(), { selfCheck: false }));
  assertSourceClaimsTruthful({ review: {}, provenance: {}, selection: {} }, { selfCheck: false });
});

test('the shared builder/validator gate fails closed on the review contract by batch', () => {
  assertReviewContractForBatch(10, false);
  assertReviewContractForBatch(11, true);
  assertReviewContractForBatch(12, true);
  assert.throws(() => assertReviewContractForBatch(11, false), /self-check contract/u);
  assert.throws(() => assertReviewContractForBatch(25, false), /self-check contract/u);
  assert.throws(() => assertReviewContractForBatch(10, true), /predates/u);
});

test('the separate-reviewer workflow is refused for self-check batches only', () => {
  assertLegacyReviewWorkflowAllowed('issue-223-m9-e-corpus-batch-10-20261002');
  assert.throws(() => assertLegacyReviewWorkflowAllowed('issue-223-m9-e-corpus-batch-11-20261003'), /self-check contract/u);
  assert.throws(() => assertLegacyReviewWorkflowAllowed('bogus'), /unsupported batch id/u);
});
