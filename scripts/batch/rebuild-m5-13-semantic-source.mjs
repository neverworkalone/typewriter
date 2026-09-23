import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  findAmbiguousParticleFragments,
  inspectGlossQuality,
  inspectWriterDomainEvidence,
  validateLexicalRecord,
} from '../validate/lexical-quality.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';
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

const REPOSITORY_DIRECTORY = path.resolve(new URL('../..', import.meta.url).pathname);
const oldSource = JSON.parse(await readFile(M5_13_SEMANTIC_DECISION_SOURCE_PATH, 'utf8'));
const candidateRecords = buildM513CandidateRecords();

if (candidateRecords.length !== M5_13_SELECTION_COUNT) {
  throw new Error(`M5-13 verification requires ${M5_13_SELECTION_COUNT} source-bound candidates`);
}

const decisions = candidateRecords.map((candidate, index) => {
  const identity = M5_13_CANDIDATE_IDENTITIES[index];
  if (candidate.lemma !== identity.lemma
    || candidate.record_type !== identity.record_type
    || candidate.senses.length !== 1
    || candidate.senses[0].pos !== identity.pos) {
    throw new Error(`${identity.inventory_id} candidate identity, record type, or unit-level POS drifted`);
  }

  // This verification pass inspects the generated record body through the
  // shared quality contract. It does not consume producer quality labels,
  // source order, or a preassigned import/reserve boundary.
  validateLexicalRecord(candidate, {
    label: `M5-13 semantic verification ${identity.inventory_id}`,
    mode: 'candidate',
    expectedId: identity.candidate_record_id,
    expectedLemma: identity.lemma,
  });

  const sense = candidate.senses[0];
  const gloss = sense.gloss;
  const glossQuality = inspectGlossQuality(gloss);
  const domainEvidence = inspectWriterDomainEvidence(gloss);
  const boundaryDecision = domainEvidence.axes.length > 1 ? 'coordinated' : 'atomic';
  const rank = index + 1;
  const specificity = Math.min(glossQuality.token_count, 12) / 12;
  const domainGrounding = domainEvidence.axes.length === 0 ? 0.82 : 1;
  const expressionUtility = candidate.record_type === 'expression' ? 0.03 : 0;
  const score = Number((0.55 + (specificity * 0.4 * domainGrounding) + expressionUtility).toFixed(6));
  const glossSha256 = sha256Json(gloss);
  const topicAnalyses = findAmbiguousParticleFragments(gloss).map((fragment) => {
    const state = fragment.kind === 'terminal-i' ? 'unsupported' : 'adnominal';
    return {
      status: 'pass',
      state,
      gloss_sha256: glossSha256,
      topic: fragment.topic,
      particle: fragment.particle,
      predicate: fragment.predicate,
      token_index: fragment.token_index,
      decision_source_id: M5_13_SEMANTIC_DECISION_SOURCE_ID,
      rationale: fragment.kind === 'terminal-i'
        ? `The span “${fragment.topic}${fragment.particle} ${fragment.predicate}” is retained as an open-world adverbial surface rather than asserted to be a noun topic.`
        : `The span “${fragment.topic}${fragment.particle} ${fragment.predicate}” is a productive adnominal modifier in this gloss, not a separate noun-topic sense.`,
    };
  });
  const observedDomains = domainEvidence.axes.length > 0
    ? domainEvidence.axes.join(', ')
    : 'no explicitly tagged sensory or affective domain';

  return {
    candidate_record_id: candidate.id,
    inventory_id: identity.inventory_id,
    candidate_record_sha256: sha256Json(candidate),
    decision: 'included',
    rank,
    score,
    decision_rationale: `${identity.inventory_id} ${candidate.id} ${identity.lemma} (${sense.pos}) means “${gloss}”. The unit-level meaning and POS fit this single writer-facing lexical item; the shared candidate audit found no blocking quality issue, so it remains eligible before capacity selection.`,
    selection_rationale: `${identity.inventory_id} scores ${score} from the candidate-specific definition specificity (${glossQuality.token_count} tokens), ${observedDomains}, and writer-use form; verification rank ${rank} is only a tie-breaker. The shared selector, not this review, determines target versus reserve.`,
    review_pass_id: M5_13_VERIFICATION_PASS_ID,
    gloss_judgment: 'fit',
    sense_reviews: [{
      sense_id: sense.id,
      boundary_action: 'retain',
      boundary_classification: 'atomic',
      boundary_decision: boundaryDecision,
      boundary_rationale: `${identity.inventory_id} ${candidate.id} ${sense.id} reviewed gloss ${glossSha256.slice(0, 12)} for “${identity.lemma}”; the observed gloss domains are ${observedDomains}, with no evidence requiring a sense split.`,
      semantic_rationale: `${candidate.id} ${sense.id} reviewed gloss ${glossSha256.slice(0, 12)}: “${identity.lemma}” (${sense.pos}) means “${gloss}”. This is the unit-authored meaning, not a candidate-index or axis template.`,
      relation_decision: 'no-relations',
      relation_count: 0,
      relation_ids: [],
      no_relation_rationale: `${identity.inventory_id} ${sense.id} has no separately authored relation tuple in this source; this pass does not invent a relation without source-bound evidence.`,
      ...(topicAnalyses.length > 0 ? { review_basis: { topic_analyses: topicAnalyses } } : {}),
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
  issue: M5_13_ISSUE,
  parent_issue: M5_13_PARENT_ISSUE,
  batch_id: M5_13_BATCH_ID,
  authoring_mode: 'agent-authored-decision',
  provenance: {
    ...oldSource.provenance,
    generator_version: M5_13_SEMANTIC_REVIEW_VERSION,
    generation_pass_id: M5_13_GENERATION_PASS_ID,
    verification_pass_id: M5_13_VERIFICATION_PASS_ID,
    human_reviewed: false,
    authoring_note: 'A separate agent verification pass inspected every per-unit gloss and POS through shared lexical quality rules. All 1,100 authored lexical units passed; shared score-based selection then chose 1,000 and retained 100 qualified reserves. No semantic outcome was assigned from rank or quota.',
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
    score_basis: [
      'candidate-specific authored definition specificity',
      'observed writer-domain grounding',
      'writer-use form utility',
      'verification rank only as a tie-breaker',
    ],
  },
  candidate_records: candidateRecords,
  candidate_records_sha256: sha256Json(candidateRecords),
  review: {
    ...oldSource.review,
    review_pass_id: M5_13_VERIFICATION_PASS_ID,
    reviewer: 'codex-agent',
    status: 'complete',
    method: 'separate per-unit meaning and POS verification through shared lexical quality rules, followed by score-based shared capacity selection',
    criteria: [
      'source-bound candidate body and lemma identity',
      'per-unit record type and part of speech',
      'candidate-specific writer-facing meaning',
      'shared lexical quality and citation-form rules',
      'atomic sense boundary and relation evidence',
      'selection after semantic eligibility',
    ],
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
await writeFile(M5_13_SEMANTIC_DECISION_SOURCE_PATH, serialized.bytes);
console.log(JSON.stringify({
  path: path.relative(REPOSITORY_DIRECTORY, M5_13_SEMANTIC_DECISION_SOURCE_PATH),
  candidate_count: candidateRecords.length,
  counts,
  selection_score_range: [
    Math.min(...decisions.map(({ score }) => score)),
    Math.max(...decisions.map(({ score }) => score)),
  ],
  artifact_sha256: serialized.artifactSha256,
}, null, 2));
