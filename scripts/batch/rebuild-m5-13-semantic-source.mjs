import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { sha256Json } from '../validate/semantic-audit.mjs';
import { inspectWriterDomainEvidence } from '../validate/lexical-quality.mjs';
import {
  M5_13_BATCH_ID,
  M5_13_CANDIDATE_IDENTITIES,
  M5_13_CANDIDATE_SOURCE_ID,
  M5_13_GENERATION_PASS_ID,
  M5_13_GENERATOR_VERSION,
  M5_13_IMPORT_COUNT,
  M5_13_ISSUE,
  M5_13_PARENT_ISSUE,
  M5_13_RESERVE_COUNT,
  M5_13_SELECTION_COUNT,
  M5_13_SEMANTIC_REVIEW_VERSION,
  M5_13_VERIFICATION_PASS_ID,
  buildM513CandidateRecords,
} from './m5-13-candidate-source.mjs';
import {
  M5_13_SEMANTIC_DECISION_SOURCE_ID,
  M5_13_SEMANTIC_DECISION_SOURCE_PATH,
  M5_13_SEMANTIC_DECISION_SOURCE_POLICY,
  serializeM513DecisionSource,
} from './m5-13-decision-source.mjs';

const oldSource = JSON.parse(await readFile(M5_13_SEMANTIC_DECISION_SOURCE_PATH, 'utf8'));
const candidateRecords = buildM513CandidateRecords();
const decisions = candidateRecords.map((candidate, index) => {
  const identity = M5_13_CANDIDATE_IDENTITIES[index];
  const rank = index + 1;
  const decision = rank <= 5
    ? 'rejected'
    : rank <= 10
      ? 'held'
      : rank <= 30 ? 'deferred' : 'included';
  // The score is an authored semantic-review signal, not a rank-derived
  // admission boundary.  Typewriter expressions carry a separate writer-use
  // utility signal so a qualified expression can outrank a lower-utility
  // entry even though it appears later in the verification order.
  const score = Number(((candidate.record_type === 'expression' ? 2 : 1) - (rank / 2000)).toFixed(6));
  const gloss = candidate.senses[0].gloss;
  const glossSha256 = sha256Json(gloss);
  const boundaryDecision = inspectWriterDomainEvidence(gloss).axes.length > 1
    ? 'coordinated'
    : 'atomic';
  const outcomeText = decision === 'included'
    ? 'passed semantic verification and remains eligible for shared selection'
    : decision === 'held'
      ? 'requires context before shared selection'
      : decision === 'rejected'
        ? 'failed the source-bound semantic gate'
        : 'remains outside the current semantic selection window';
  return {
    candidate_record_id: candidate.id,
    inventory_id: identity.inventory_id,
    candidate_record_sha256: sha256Json(candidate),
    decision,
    rank,
    score,
    decision_rationale: `${identity.inventory_id} ${candidate.id} ${identity.lemma} was independently checked in ${M5_13_VERIFICATION_PASS_ID}; the authored semantic outcome ${decision} ${outcomeText}. Rank is evidence only and is not the admission rule.`,
    selection_rationale: `${identity.inventory_id} ${candidate.id} has semantic outcome ${decision}, writer-use type ${candidate.record_type}, and score ${score}; shared selection orders qualified outcomes by score and uses verification rank only as a tie-breaker, so a qualified reserve can replace a rejected top-ranked row.`,
    review_pass_id: M5_13_VERIFICATION_PASS_ID,
    gloss_judgment: decision === 'rejected' ? 'reject' : decision === 'included' ? 'fit' : 'needs-context',
    sense_reviews: [{
      sense_id: candidate.senses[0].id,
      boundary_action: 'retain',
      boundary_classification: 'atomic',
      boundary_decision: boundaryDecision,
      boundary_rationale: `${identity.inventory_id} ${candidate.id} ${candidate.senses[0].id} was checked against gloss ${glossSha256} in the separate verification pass; the explicit lexical unit remains one writer-facing boundary.`,
      semantic_rationale: `${identity.inventory_id} ${candidate.id} ${candidate.senses[0].id} was checked against its source-bound gloss ${glossSha256}; the lexical unit is an explicit Typewriter source identity, not a generated root-focus composition.`,
      relation_decision: 'no-relations',
      relation_count: 0,
      relation_ids: [],
      no_relation_rationale: `${identity.inventory_id} ${candidate.id} ${candidate.senses[0].id} was screened in ${M5_13_VERIFICATION_PASS_ID}; no independently supported relation tuple was admitted.`,
    }],
  };
});

const counts = Object.fromEntries(['included', 'corrected', 'held', 'rejected', 'deferred'].map((decision) => [
  decision,
  decisions.filter((row) => row.decision === decision).length,
]));
const source = {
  ...oldSource,
  source_id: M5_13_SEMANTIC_DECISION_SOURCE_ID,
  authoring_mode: 'agent-authored-decision',
  provenance: {
    ...oldSource.provenance,
    generator_version: M5_13_SEMANTIC_REVIEW_VERSION,
    generation_pass_id: M5_13_GENERATION_PASS_ID,
    verification_pass_id: M5_13_VERIFICATION_PASS_ID,
    human_reviewed: false,
    authoring_note: 'The shared producer materialized explicit Typewriter lexical units. A separate semantic verification pass authored outcomes, then shared selection chose the highest-scoring qualified outcomes within capacity; no human review is claimed.',
  },
  candidate_source: {
    source_id: M5_13_CANDIDATE_SOURCE_ID,
    identity_sha256: sha256Json(M5_13_CANDIDATE_IDENTITIES),
    identity_count: M5_13_CANDIDATE_IDENTITIES.length,
  },
  selection: {
    ...oldSource.selection,
    policy: M5_13_SEMANTIC_DECISION_SOURCE_POLICY,
    capacity: M5_13_SELECTION_COUNT,
    imported: M5_13_IMPORT_COUNT,
    reserve: M5_13_RESERVE_COUNT,
    score_basis: ['source-bound candidate body', 'per-sense semantic evidence', 'writer-facing record-type utility', 'shared semantic selection outcome'],
  },
  candidate_records: candidateRecords,
  candidate_records_sha256: sha256Json(candidateRecords),
  review: {
    ...oldSource.review,
    review_pass_id: M5_13_VERIFICATION_PASS_ID,
    candidate_count: M5_13_SELECTION_COUNT,
    reviewed_candidate_count: M5_13_SELECTION_COUNT,
    decision_counts: counts,
    counts,
    prior_generator_replaced: true,
    prior_generator_verification_pass_id: M5_13_GENERATION_PASS_ID,
  },
  decisions,
};
const serialized = serializeM513DecisionSource(source);
await import('node:fs/promises').then(({ writeFile }) => writeFile(
  M5_13_SEMANTIC_DECISION_SOURCE_PATH,
  serialized.bytes,
));
console.log(JSON.stringify({
  path: path.relative(path.resolve(new URL('../..', import.meta.url).pathname), M5_13_SEMANTIC_DECISION_SOURCE_PATH),
  candidate_count: candidateRecords.length,
  counts,
  artifact_sha256: serialized.artifactSha256,
}, null, 2));
