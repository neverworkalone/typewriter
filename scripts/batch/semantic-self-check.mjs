/**
 * Agent self-check provenance for semantic review inputs (Issue #240, M10).
 *
 * Owner decision (2026-10-02): from M10 batch 11 the main implementation agent
 * may both author and check candidate decisions. That check is recorded as
 * exactly what it is, an AI producer self-check, and is never described as
 * independent or human review. The input keeps every per-candidate judgment the
 * independent-review contract preserved (identity, POS, gloss fit, sense
 * boundary, checked contexts, candidate-specific notes, gloss-digest binding),
 * and forbids the artifacts that would pretend a separate run happened: a
 * registry reviewer label, review runs, a run record, or proposal digests.
 *
 * B05-B10 keep their original contract and evidence unchanged.
 */

import assert from 'node:assert/strict';

import { sha256Json } from '../validate/semantic-audit.mjs';
import { admissionGateFor, assertReviewNotesAreCandidateSpecific } from './reviewer-raw-outputs.mjs';

export const SELF_CHECK_PROVENANCE = 'agent-self-check';
export const SELF_CHECK_FIRST_BATCH = 11;
const SEPARATE_RUN_FIELDS = ['review_runs', 'run_record_sha256', 'generator_proposal_sha256'];
const CLAIM_PATTERN = /independent|reviewer|human/iu;

export function isSelfCheckInput(input) {
  return input?.review_provenance !== undefined;
}

/** Envelope rules; the caller still runs the shared envelope check first. */
export function assertSelfCheckEnvelope(input, { ordinal, candidateAuthor }) {
  assert.equal(input.review_provenance, SELF_CHECK_PROVENANCE, 'semantic review input names an unsupported review provenance');
  assert.ok(ordinal >= SELF_CHECK_FIRST_BATCH,
    `agent self-check applies from batch ${SELF_CHECK_FIRST_BATCH}; earlier batches keep their original review contract`);
  assert.equal(input.independent_review, false, 'a self-check input must state independent_review: false');
  assert.equal(input.reviewer, candidateAuthor,
    'a self-check is recorded under the producing agent itself, never under a separate reviewer identity');
  assert.ok(!CLAIM_PATTERN.test(input.reviewer), 'a self-check reviewer label must not claim independent, reviewer, or human status');
  for (const field of SEPARATE_RUN_FIELDS) {
    assert.equal(input[field], undefined, `a self-check input must not carry ${field}: no separate review run took place`);
  }
}

/**
 * Cross-check the preserved outcomes against the candidate review and the
 * glosses admitted into canonical data (the tracked-artifact half of the
 * independent contract, without any run record).
 */
export function assertSelfCheckBinding({ input, candidateRows, glossByLemma }) {
  assert.equal(input.candidate_outcomes.length, candidateRows.length, 'self-check outcomes must cover every candidate');
  const reviewByLemma = new Map(input.reviews.map((review) => [review.lemma, review]));
  assert.equal(reviewByLemma.size, input.reviews.length, 'self-check reviews contain a duplicate lemma');
  let passes = 0;
  candidateRows.forEach((row, index) => {
    const lemma = row.morphology_proposal.lemma;
    const outcome = input.candidate_outcomes[index];
    assert.equal(outcome?.ordinal, index + 1, `${lemma}: self-check outcome ordinal must follow batch order`);
    assert.equal(outcome.lemma, lemma, `${lemma}: self-check outcome is bound to a different lemma`);
    if (outcome.verdict !== 'pass') {
      assert.equal(reviewByLemma.has(lemma), false, `${lemma}: a held candidate cannot carry a review row`);
      return;
    }
    const gate = admissionGateFor(row);
    if (gate) {
      assert.equal(outcome.admission_gate, gate, `${lemma}: a gated candidate must record the gate that held it`);
      assert.equal(reviewByLemma.has(lemma), false, `${lemma}: a gated candidate cannot carry a review row`);
      return;
    }
    passes += 1;
    const review = reviewByLemma.get(lemma);
    assert.ok(review, `${lemma}: a passed candidate needs its review row`);
    assert.equal(review.gloss_sha256, sha256Json(glossByLemma.get(lemma)),
      `${lemma}: the self-check is not bound to the gloss admitted into canonical data`);
    for (const field of ['identity_check', 'pos_check', 'gloss_check', 'sense_boundary_check', 'checked_hit_indices']) {
      assert.deepEqual(review[field], outcome[field], `${lemma}: the outcome and the review row disagree on ${field}`);
    }
  });
  assert.equal(input.reviews.length, passes, 'review rows must exist exactly for the passed candidates');
  assertReviewNotesAreCandidateSpecific(input.reviews);
}

/**
 * Truthfulness of the admitted semantic decision source. A self-check batch's
 * canonical source must carry the machine-readable provenance flag and no
 * claim of independent, separate, or human review; every other batch must not
 * carry the flag, so historical serialized artifacts stay byte-compatible.
 * (`kind` and `prior_generator_replaced` are structural fields required by the
 * shared decision-source contract and carry no review-independence claim.)
 */
/** The only parenthetical disclaimers allowed to name independent/human review, and only to deny it. */
const SELF_CHECK_DISCLAIMERS = [
  '(agent self-check, not independent or human review)',
  '(agent self-check; not independent, separately authored, or human review)',
  // Structural criterion about relation evidence, not a review-independence claim.
  'zero relations when no candidate-specific relation is separately supported',
];

export function assertSourceClaimsTruthful(source, { selfCheck }) {
  const { review } = source;
  if (!selfCheck) {
    assert.equal(review.review_provenance, undefined, 'only a self-check source may carry review_provenance');
    assert.equal(review.independent_review, undefined, 'only a self-check source may carry independent_review');
    return;
  }
  assert.equal(review.review_provenance, SELF_CHECK_PROVENANCE, 'a self-check source must record its provenance');
  assert.equal(review.independent_review, false, 'a self-check source must state independent_review: false');
  // Every free-text value the source stores about its review, authoring, or
  // selection (criteria and admission rules included) is a possible claim.
  const claims = [];
  const collect = (value) => {
    if (typeof value === 'string') claims.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
  };
  collect(source.provenance);
  collect(review);
  collect(source.selection);
  for (const text of claims) {
    let stripped = text;
    for (const disclaimer of SELF_CHECK_DISCLAIMERS) stripped = stripped.split(disclaimer).join('');
    assert.ok(!REVIEW_CLAIM_PATTERN.test(stripped), `a self-check source must not claim independent, separate, or human review: ${text.slice(0, 80)}`);
  }
}

// One shared claim vocabulary for sources, rationales and decisions: English
// independent/separate/human/reviewer wording and Korean forms with or
// without a particle (인간이 검토, 사람은 검수, 별도 리뷰어, ...).
const REVIEW_CLAIM_PATTERN = /independent|separately|\bhuman\b|\bpeople\b|\bperson\b|\breviewers?\b|\bauditor\b|독립\s*(?:적으로)?\s*(?:검|리뷰)|독립적|(?<![가-힣])(?:사람|인간)(?:이|은|가|의|에\s*의해|에게)?\s*(?:검|리뷰|확인|승인)|별도\s*(?:의\s*)?(?:검|리뷰|에이전트|모델)|검수자|리뷰어|제\s*3\s*자|제삼자/iu;

/**
 * Per-candidate rationales are free text copied into the canonical decisions
 * (and kept in the self-check input); none may claim independent, separate, or
 * human review. Every string under `reviews` and `decisions` is scanned.
 */
export function assertDecisionClaimsTruthful({ reviews, decisions }) {
  // Lexical content (glosses, frames, lemmas) may legitimately contain words
  // such as 사람 or 독립; only free-text explanation fields are claim carriers.
  const CLAIM_KEY = /rationale|reason|note|method|basis|criteria|summary|explanation|status/iu;
  const visit = (value, where, inClaimField) => {
    if (typeof value === 'string') {
      if (inClaimField) {
        assert.ok(!REVIEW_CLAIM_PATTERN.test(value), `a self-check batch must not claim independent, separate, or human review in ${where}: ${value.slice(0, 80)}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${where}[${index}]`, inClaimField));
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit(item, `${where}.${key}`, inClaimField || CLAIM_KEY.test(key));
    }
  };
  visit(reviews, 'reviews', false);
  visit(decisions, 'decisions', false);
}

/**
 * Shared fail-closed gate for the builder and the validator: from the first
 * self-check batch, only self-check input is accepted; earlier batches keep
 * their original review contract and may not carry the self-check marker.
 */
export function assertReviewContractForBatch(ordinal, selfCheck) {
  if (ordinal >= SELF_CHECK_FIRST_BATCH) {
    assert.ok(selfCheck, `batch ${ordinal} must use the agent self-check contract; separate-reviewer input is only accepted for batches before ${SELF_CHECK_FIRST_BATCH}`);
  } else {
    assert.ok(!selfCheck, `batch ${ordinal} predates the agent self-check contract and may not carry self-check input`);
  }
}

/** Legacy separate-reviewer workflows may not be used for self-check batches. */
export function assertLegacyReviewWorkflowAllowed(batchId) {
  const match = /-batch-([0-9]{2})-/u.exec(batchId);
  assert.ok(match, `unsupported batch id ${batchId}`);
  assert.ok(Number(match[1]) < SELF_CHECK_FIRST_BATCH,
    `batch ${match[1]} uses the agent self-check contract; the separate-reviewer workflow is only for earlier batches`);
}
