import { CONTRACT_REPAIR_KINDS, MUTABLE_MANIFEST_FIELDS } from './contract.mjs';

// Durable state exists only in merged manifests (design §7). Each function compares
// the manifests on the base (merged `master`) with those in a candidate merge result and
// returns error strings; an empty list means the change is a legal transition.

const withoutMutable = (manifest) => Object.fromEntries(
  Object.entries(manifest).filter(([key]) => !MUTABLE_MANIFEST_FIELDS.includes(key)),
);
const withoutAdmission = (manifest) => Object.fromEntries(
  Object.entries(manifest).filter(([key]) => key !== 'admission'),
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
  if (before.contract !== after.contract) errors.push(`candidate contract migration ${before.contract} → ${after.contract} is not authorized; merged batches keep their contract`);
  if (!(CANDIDATE_TRANSITIONS[before.status] ?? []).includes(after.status)) {
    errors.push(`illegal candidate transition ${before.status} → ${after.status}`);
  }
  if (!same(Object.fromEntries(Object.entries(before).filter(([key]) => key !== 'status')),
    Object.fromEntries(Object.entries(after).filter(([key]) => key !== 'status')))) {
    errors.push('candidate manifest content is immutable; only status may change');
  }
  return errors;
}

// The authored fields each repair kind may add; everything else must stay byte-for-byte equal.
// `review_binding` is derived from the authored evidence, so it is re-bound, never compared.
const REPAIR_ADDED_SENSE_FIELDS = Object.freeze({ scope_declaration: ['scope_declaration'] });

// Fields the merged source already carries are authored judgments and stay in the comparison, so
// a repair may only add the field where it was missing, never change a declaration that exists.
function preservedRepairFields(semanticText, kind) {
  const preserved = new Set();
  for (const row of JSON.parse(semanticText).decisions ?? []) {
    (row.sense_reviews ?? []).forEach((sense, index) => {
      for (const field of REPAIR_ADDED_SENSE_FIELDS[kind]) if (Object.hasOwn(sense, field)) preserved.add(`${row.source_candidate_id}:${index}:${field}`);
    });
  }
  return preserved;
}

function withoutRepairFields(semanticText, kind, preserved) {
  const source = JSON.parse(semanticText);
  for (const row of source.decisions ?? []) {
    delete row.review_binding;
    (row.sense_reviews ?? []).forEach((sense, index) => {
      for (const field of REPAIR_ADDED_SENSE_FIELDS[kind]) if (!preserved.has(`${row.source_candidate_id}:${index}:${field}`)) delete sense[field];
    });
  }
  return JSON.stringify(source);
}

// A merged `ready` review authored against an older shared contract is re-bound in place (same
// attempt, no rejection) only when the shared contract added a required authored field. The
// lexical decisions must be untouched, which is proved from the semantic source text itself.
function validateContractRepair(before, after, evidence) {
  const errors = [];
  const repairs = after.contract_repairs ?? [];
  const prior = before.contract_repairs ?? [];
  if (repairs.length !== prior.length + 1 || prior.some((entry, index) => !same(entry, repairs[index]))) {
    return [`illegal review transition ${before.status} → ${after.status}`];
  }
  const repair = repairs.at(-1);
  if (before.status !== 'ready' || after.status !== 'ready') errors.push('a contract repair applies only to a ready review');
  if (!CONTRACT_REPAIR_KINDS.includes(repair.contract)) errors.push(`unknown contract repair ${repair.contract}`);
  if (after.attempt !== before.attempt || !same(before.history, after.history)) errors.push('a contract repair must not change attempt or history');
  const strip = (manifest) => withoutMutable(Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'semantic_decisions_sha256')));
  if (!same(strip(before), strip(after))) errors.push('a contract repair may change only semantic_decisions_sha256');
  if (repair.previous_semantic_decisions_sha256 !== before.semantic_decisions_sha256 || repair.semantic_decisions_sha256 !== after.semantic_decisions_sha256) {
    errors.push('contract repair must link the previous and the new semantic_decisions_sha256');
  }
  if (typeof evidence?.semanticBefore !== 'string' || typeof evidence?.semanticAfter !== 'string') {
    errors.push('a contract repair requires the merged and the new semantic-decisions.json to prove no authored decision changed');
  } else {
    try {
      const preserved = preservedRepairFields(evidence.semanticBefore, repair.contract);
      if (withoutRepairFields(evidence.semanticBefore, repair.contract, preserved) !== withoutRepairFields(evidence.semanticAfter, repair.contract, preserved)) {
        errors.push(`a ${repair.contract} repair may only add ${repair.contract}; no other authored semantic decision may change`);
      }
    } catch {
      errors.push('a contract repair requires parseable semantic-decisions.json');
    }
  }
  return errors;
}

export function validateReviewTransition(before, after, evidence) {
  if (before === null || before === undefined) {
    if (after?.status !== 'ready') return [`new review manifest must start as ready, got ${after?.status}`];
    return after.attempt === 1 && after.history.length === 0 ? [] : ['first review must be attempt 1 with empty history'];
  }
  const errors = [];
  const key = `${before.status} → ${after.status}`;
  if (before.history.some((entry, index) => !same(entry, after.history[index]))) errors.push('attempt history may not be rewritten');
  switch (key) {
    case 'ready → ready':
      return [...errors, ...validateContractRepair(before, after, evidence)];
    case 'ready → complete':
      if (after.attempt !== before.attempt) errors.push('admission must not change attempt');
      if (!same(before.history, after.history)) errors.push('admission must not change history');
      if (before.admission !== undefined) errors.push('ready review must not already carry an admission mapping');
      if (!after.admission || after.admission.contract !== 'lexical-factory-admission-v1') errors.push('completion must add a Stage 3 admission mapping');
      if (!same(withoutAdmission(withoutMutable(before)), withoutAdmission(withoutMutable(after)))) errors.push('admission must not change Stage 2 review content');
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
export function validateLinkedTransition({ candidateBefore = null, candidateAfter, reviewBefore = null, reviewAfter, evidence }) {
  const errors = [
    ...validateCandidateTransition(candidateBefore, candidateAfter),
    ...validateReviewTransition(reviewBefore, reviewAfter, evidence),
  ];
  const candidateStep = `${candidateBefore?.status ?? 'new'} → ${candidateAfter.status}`;
  const reviewStep = `${reviewBefore?.status ?? 'new'} → ${reviewAfter.status}`;
  if (reviewStep === 'new → ready' && candidateStep !== 'created → complete') {
    errors.push(`review new → ready requires candidate created → complete in the same PR, got ${candidateStep}`);
  }
  if (candidateStep === 'created → complete' && reviewStep !== 'new → ready') {
    errors.push(`candidate created → complete requires a new ready review in the same PR, got ${reviewStep}`);
  }
  if (reviewStep === 'ready → ready' && candidateStep !== 'complete → complete') {
    errors.push('a contract repair must not change the candidate manifest');
  }
  if (reviewStep === 'rejected → ready' && candidateBefore?.status !== 'complete') {
    errors.push('rework requires an already complete candidate manifest');
  }
  if (['ready → complete', 'ready → rejected'].includes(reviewStep) && candidateStep !== 'complete → complete') {
    errors.push('Stage 3 transitions must not change the candidate manifest');
  }
  return errors;
}
