import { MUTABLE_MANIFEST_FIELDS } from './contract.mjs';

// Durable state exists only in merged manifests (design §7). Each function compares
// the manifests on the base (merged `master`) with those in a candidate merge result and
// returns error strings; an empty list means the change is a legal transition.

const withoutMutable = (manifest) => Object.fromEntries(
  Object.entries(manifest).filter(([key]) => !MUTABLE_MANIFEST_FIELDS.includes(key)),
);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// No `held` transition: it requires owner authorization, which has no verifiable contract yet,
// so it is rejected rather than trusted. Add it together with a checkable authorization field.
const CANDIDATE_TRANSITIONS = Object.freeze({
  created: ['created', 'complete'],
  complete: ['complete'],
});

export function validateCandidateTransition(before, after) {
  if (before === null || before === undefined) {
    return after?.status === 'created' ? [] : [`new candidate manifest must start as created, got ${after?.status}`];
  }
  const errors = [];
  if (!(CANDIDATE_TRANSITIONS[before.status] ?? []).includes(after.status)) {
    errors.push(`illegal candidate transition ${before.status} → ${after.status}`);
  }
  if (!same(Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'status')),
    Object.fromEntries(Object.entries(after).filter(([key]) => key !== 'status')))) {
    errors.push('candidate manifest content is immutable; only status may change');
  }
  return errors;
}

export function validateReviewTransition(before, after) {
  if (before === null || before === undefined) {
    if (after?.status !== 'ready') return [`new review manifest must start as ready, got ${after?.status}`];
    return after.attempt === 1 && after.history.length === 0 ? [] : ['first review must be attempt 1 with empty history'];
  }
  const errors = [];
  const key = `${before.status} → ${after.status}`;
  if (before.history.some((entry, index) => !same(entry, after.history[index]))) errors.push('attempt history may not be rewritten');
  switch (key) {
    case 'ready → complete':
      if (after.attempt !== before.attempt) errors.push('admission must not change attempt');
      if (!same(before.history, after.history)) errors.push('admission must not change history');
      if (!same(withoutMutable(before), withoutMutable(after))) errors.push('admission must not change review content');
      break;
    case 'ready → rejected':
      if (after.attempt !== before.attempt) errors.push('rejection must not change attempt');
      if (!Number.isInteger(after.rejected_pr)) errors.push('rejection requires rejected_pr');
      if (after.history.length !== before.history.length + 1) errors.push('rejection must append one history entry');
      if (!same(withoutMutable(before), withoutMutable(after))) errors.push('a status-only rejection must not change review content');
      break;
    case 'rejected → ready':
      if (after.attempt !== before.attempt + 1) errors.push('rework must advance attempt by exactly one');
      if (!same(before.history, after.history)) errors.push('rework must preserve rejection history unchanged');
      if (after.rejected_pr !== undefined) errors.push('a ready review carries no rejected_pr');
      if (before.decisions_sha256 === after.decisions_sha256) errors.push('rework must produce new decisions');
      if (before.candidates_sha256 !== after.candidates_sha256) errors.push('rework may not change candidate bindings');
      break;
    default:
      errors.push(`illegal review transition ${key}`);
  }
  return errors;
}

// One Stage 2 result PR changes candidate and review together (design §5.2):
//   first attempt: candidate created → complete AND review (new) → ready
//   rework:        candidate stays complete AND review rejected → ready (attempt + 1)
// Stage 3 changes only the review (ready → complete / ready → rejected) and never the candidate.
export function validateLinkedTransition({ candidateBefore = null, candidateAfter, reviewBefore = null, reviewAfter }) {
  const errors = [
    ...validateCandidateTransition(candidateBefore, candidateAfter),
    ...validateReviewTransition(reviewBefore, reviewAfter),
  ];
  const candidateStep = `${candidateBefore?.status ?? 'new'} → ${candidateAfter.status}`;
  const reviewStep = `${reviewBefore?.status ?? 'new'} → ${reviewAfter.status}`;
  if (reviewStep === 'new → ready' && candidateStep !== 'created → complete') {
    errors.push(`review new → ready requires candidate created → complete in the same PR, got ${candidateStep}`);
  }
  if (candidateStep === 'created → complete' && reviewStep !== 'new → ready') {
    errors.push(`candidate created → complete requires a new ready review in the same PR, got ${reviewStep}`);
  }
  if (reviewStep === 'rejected → ready' && candidateBefore?.status !== 'complete') {
    errors.push('rework requires an already complete candidate manifest');
  }
  if (['ready → complete', 'ready → rejected'].includes(reviewStep) && candidateStep !== 'complete → complete') {
    errors.push('Stage 3 transitions must not change the candidate manifest');
  }
  return errors;
}
