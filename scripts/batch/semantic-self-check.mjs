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
export const SELF_CHECK_FRAME_GRAMMAR_FIRST_BATCH = 13;
// A verb frame may carry the citation form only where Korean grammar allows it
// before a connective (-다가, -다니, -다 보니, -다 못해, -다 말고, ...), never
// as a bare sentence-final predicate; an adjective's plain form is a valid
// sentence ending and is not restricted.
const VERB_CITATION_CONTINUATION = /^(?:니|가[\s,]|고|는|며|면|\s*(?:말고|못해|못하|보니|보면))/u;
const SENTENCE_END = /^[\s.?!"'”’]*$/u;

/** Rows: { lemma, pos, frames }. Frames lacking the lemma are left to the shared containment check. */
export function assertVerbFramesGrammatical(rows) {
  for (const { lemma, pos, frames } of rows) {
    if (pos !== 'verb') continue;
    for (const frame of frames) {
      const tails = [];
      for (let at = frame.indexOf(lemma); at !== -1; at = frame.indexOf(lemma, at + 1)) tails.push(frame.slice(at + lemma.length));
      if (tails.length === 0) continue;
      assert.ok(!tails.some((tail) => SENTENCE_END.test(tail)),
        `${lemma}: a verb frame must not end the sentence with the bare citation form`);
      assert.ok(tails.some((tail) => VERB_CITATION_CONTINUATION.test(tail)),
        `${lemma}: a verb frame must use the citation form only before a connective such as -다가, -다니, -다 보니, -다 못해, -다 말고`);
    }
  }
}

export const SELF_CHECK_SPECIFIC_FIRST_BATCH = 14;
const FRAME_DEFINITION_FORM = /['"「][^'"」]+['"」](?:은|는|은\(는\)|이|가)\s*['"「][^'"」]+['"」]/u;
const MAX_REPEATED_SELF_CHECK_SHARE = 0.1;

/**
 * Self-check passes are the only evidence for a primary-agent admission, so a
 * pass must say what each checked context shows (a note citing every checked
 * context index), its frames must be usage sentences rather than a restated
 * gloss, and the notes may not be one sentence templated over lemma and gloss.
 * Shared by self-check assembly, the batch builder and the full-revision
 * validator. Each row: { ordinal, lemma, gloss, hits, senseNote, useNote, frames }.
 */
export function assertSelfCheckPassesSpecific(rows) {
  const groups = { senseNote: new Map(), useNote: new Map() };
  for (const row of rows) {
    const gloss = String(typeof row.gloss === 'string' ? row.gloss : (row.gloss?.text ?? '')).replace(/[.\s]+$/u, '');
    const label = `${row.lemma}`;
    for (const index of row.hits) {
      assert.ok(String(row.senseNote).includes(`문맥 ${index}`),
        `${label}: sense_note must state what checked context ${index} shows`);
    }
    for (const frame of row.frames) {
      assert.ok(!frame.includes(gloss) && !FRAME_DEFINITION_FORM.test(frame),
        `${label}: a frame must be a usage sentence, not a restated definition`);
    }
    for (const field of ['senseNote', 'useNote']) {
      const key = String(row[field]).split(row.lemma).join('§').split(gloss).join('¶')
        .replace(/문맥 *[0-9]+/gu, '').replace(/[0-9]/gu, '#').replace(/\s+/gu, ' ').trim();
      groups[field].set(key, (groups[field].get(key) ?? 0) + 1);
    }
  }
  for (const [field, map] of Object.entries(groups)) {
    const repeated = [...map.values()].filter((count) => count > 1).reduce((sum, count) => sum + count, 0);
    assert.ok(repeated <= Math.floor(rows.length * MAX_REPEATED_SELF_CHECK_SHARE),
      `${repeated} of ${rows.length} self-check passes repeat the same ${field === 'senseNote' ? 'sense_note' : 'use_note'} text; notes must be specific to each candidate`);
  }
}

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
  const batchOrdinal = Number(String(input.batch_id).match(/corpus-batch-(\d+)-/u)?.[1]);
  if (batchOrdinal >= SELF_CHECK_FRAME_GRAMMAR_FIRST_BATCH) {
    const posByLemma = new Map(candidateRows.map((row) => [row.morphology_proposal.lemma, row.morphology_proposal.pos]));
    assertVerbFramesGrammatical(input.reviews.map((review) => ({
      lemma: review.lemma,
      pos: posByLemma.get(review.lemma),
      frames: review.frames.map((frame) => frame.sentence_frame),
    })));
  }
  if (batchOrdinal >= SELF_CHECK_SPECIFIC_FIRST_BATCH) {
    assertSelfCheckPassesSpecific(input.reviews.map((review) => ({
      lemma: review.lemma,
      gloss: glossByLemma.get(review.lemma),
      hits: review.checked_hit_indices,
      senseNote: review.boundary_rationale,
      useNote: review.semantic_rationale,
      frames: review.frames.map((frame) => frame.sentence_frame),
    })));
  }
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
const REVIEW_CLAIM_PATTERN = new RegExp([
  // English: who is said to have reviewed, or the act attributed to someone else.
  String.raw`independent|separately|\bhuman\b|\breviewers?\b|\bauditors?\b|\bthird[- ]party\b|\bsecond (?:pair|opinion|session|agent|model)\b`,
  String.raw`\b(?:editors?|experts?|colleagues?|peers?|person|people|team|someone|somebody|claude|model|agent|session)\b[^.;]{0,40}\b(?:reviewed|checked|verified|approved|audited|validated|confirmed|signed[- ]off)\b`,
  String.raw`\b(?:another|other|different|separate|second|new|fresh|outside|external)\s+(?:claude|model|agent|session|ai|llm|instance|team|editor|expert|person)\b`,
  String.raw`\b(?:reviewed|checked|verified|approved|audited|validated|signed[- ]off)\s+(?:by|with)\s+(?!the producing (?:AI )?agent\b)`,
  // Korean, with or without particles.
  String.raw`독립\s*(?:적으로)?\s*(?:검|리뷰)|독립적|(?:(?:별도|다른|외부|추가|독립|제\s*3)\s*(?:의\s*)?(?:사람|인간)|(?<![가-힣])(?:사람|인간))(?:이|은|가|의|들이|에\s*의해|에게)?\s*(?:직접\s*)?(?:검|리뷰|확인|승인|판단|판정|판별|결정|평가|심사|채택|선정|선별|보류|통과|감수|수정|교정|작성)`,
  String.raw`별도\s*(?:의\s*)?(?:검|리뷰|에이전트|모델|세션)|검수자|리뷰어|제\s*3\s*자|제삼자`,
  String.raw`(?<![가-힣])(?:외부|다른|타|추가|두\s*번째)\s*(?:의\s*)?(?:편집자|전문가|검토자|감수자|세션|에이전트|모델|클로드|팀)`,
  String.raw`(?<![가-힣])(?:편집자|전문가|감수자?|검토자|동료|팀)(?:들)?(?:이|가|께서|에게서)?\s*(?:직접\s*)?(?:검토|검수|확인|승인|리뷰)`,
  String.raw`검토자|감수자|(?:에게|한테|로부터|에\s*의해)\s*(?:검토|검수|확인|승인)`,
].join('|'), 'iu');

/**
 * Per-candidate rationales are free text copied into the canonical decisions
 * (and kept in the self-check input); none may claim independent, separate, or
 * human review. Every string under `reviews` and `decisions` is scanned.
 */
export function assertDecisionClaimsTruthful({ reviews, decisions, outcomes = [] }) {
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
  visit(outcomes, 'candidate_outcomes', false);
}

const COPIED_NEIGHBOR_WORDS = 3;
const HOLD_COPIED_NEIGHBOR_WORDS = 2;
const wordsOf = (text) => text.replace(/[^\p{L}\p{N}_\s]/gu, ' ').split(/\s+/u).filter(Boolean);

/**
 * Rationales may name the observed form of a candidate but must not reproduce
 * its corpus contexts. A verbatim run of consecutive context words that holds
 * three or more words other than the lemma, its stem, or an observed form is a copied
 * phrase. Needs the local context text, so it runs where that text exists.
 */
export function findCopiedContextPhrases(text, { contexts, allowedForms, threshold = COPIED_NEIGHBOR_WORDS }) {
  const bigrams = new Set();
  for (const context of contexts) {
    const words = wordsOf(context);
    for (let index = 0; index + 1 < words.length; index += 1) bigrams.add(`${words[index]}\u0000${words[index + 1]}`);
  }
  const words = wordsOf(text);
  const copied = [];
  let index = 0;
  while (index + 1 < words.length) {
    if (!bigrams.has(`${words[index]}\u0000${words[index + 1]}`)) { index += 1; continue; }
    let end = index + 1;
    while (end + 1 < words.length && bigrams.has(`${words[end]}\u0000${words[end + 1]}`)) end += 1;
    const run = words.slice(index, end + 1);
    if (run.filter((word) => !allowedForms.some((form) => word.includes(form))).length >= threshold) copied.push(run.join(' '));
    index = end + 1;
  }
  return copied;
}

export function assertNoCorpusPhraseCopy({ lemma, texts, contexts, allowedForms }) {
  for (const [where, text] of texts) {
    const stem = lemma.endsWith('다') ? lemma.slice(0, -1) : lemma;
    // Holds quote contexts to explain a split; they get the stricter limit.
    const copied = findCopiedContextPhrases(text, { contexts, allowedForms: [lemma, stem, ...allowedForms], threshold: /hold/iu.test(where) ? HOLD_COPIED_NEIGHBOR_WORDS : COPIED_NEIGHBOR_WORDS });
    assert.deepEqual(copied, [], `${lemma} ${where} reproduces corpus context wording; describe contexts in your own words and quote at most the observed form`);
  }
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

/**
 * From the first self-check batch the primary producer authors every decision
 * itself. Merging author outputs therefore needs an explicit statement that
 * the files were written by the primary agent (no worker fan-out).
 */
export function assertPrimaryAuthoringAllowed(batchId, { primaryAgentAuthored } = {}) {
  const match = /-batch-([0-9]{2})-/u.exec(batchId ?? '');
  assert.ok(match, `unsupported batch id ${batchId}`);
  if (Number(match[1]) < SELF_CHECK_FIRST_BATCH) return;
  assert.ok(primaryAgentAuthored === true,
    `batch ${match[1]} uses the agent self-check contract: author outputs must be written by the primary agent; pass --primary-agent-authored to attest that no subagent or worker wrote them`);
}

/** Legacy separate-reviewer workflows may not be used for self-check batches. */
export function assertLegacyReviewWorkflowAllowed(batchId) {
  const match = /-batch-([0-9]{2})-/u.exec(batchId);
  assert.ok(match, `unsupported batch id ${batchId}`);
  assert.ok(Number(match[1]) < SELF_CHECK_FIRST_BATCH,
    `batch ${match[1]} uses the agent self-check contract; the separate-reviewer workflow is only for earlier batches`);
}
