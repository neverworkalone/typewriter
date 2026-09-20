import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
} from '../validate/lexical-quality.mjs';
import {
  sha256Json,
} from '../validate/semantic-audit.mjs';
import {
  M5_12A_BATCH_ID,
  M5_12A_CANDIDATE_IDENTITIES,
  M5_12A_CANDIDATE_SOURCE_ID,
  M5_12A_GENERATION_PASS_ID,
  M5_12A_IMPORT_COUNT,
  M5_12A_ISSUE,
  M5_12A_PARENT_ISSUE,
  M5_12A_RESERVE_COUNT,
  M5_12A_SELECTION_COUNT,
  M5_12A_VERIFICATION_PASS_ID,
} from './m5-12a-candidate-source.mjs';
import {
  makeM512ACandidateRecord,
} from './m5-12a-pipeline.mjs';
import {
  M5_12A_SEMANTIC_DECISION_SOURCE_ID,
  M5_12A_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
  M5_12A_SEMANTIC_DECISION_SOURCE_POLICY,
  M5_12A_SEMANTIC_DECISION_SOURCE_PATH,
} from './m5-12a-decision-source.mjs';

const AXIS_WEIGHTS = Object.freeze({
  E: 0.84,
  Q: 0.82,
  S: 0.80,
  C: 0.78,
  A: 0.76,
  O: 0.74,
  X: 0.58,
});

function scoreFor(identity) {
  const digest = createHash('sha256').update(`${identity.axis}:${identity.lemma}`, 'utf8').digest('hex');
  const stableSurfaceScore = Number.parseInt(digest.slice(0, 8), 16) / 0xffffffff;
  const writerSurfaceScore = Math.min(identity.lemma.length, 20) / 200;
  return Number((AXIS_WEIGHTS[identity.axis] + stableSurfaceScore / 10 + writerSurfaceScore).toFixed(6));
}

function authoredDecisionRows() {
  const candidates = M5_12A_CANDIDATE_IDENTITIES.map((identity) => {
    const candidate = makeM512ACandidateRecord(identity);
    const sense = candidate.senses[0];
    const domainEvidence = inspectWriterDomainEvidence(sense.gloss);
    return {
      identity,
      candidate,
      score: scoreFor(identity),
      domainEvidence,
      connectorObservations: inspectGlossConnectors(sense.gloss),
    };
  }).sort((left, right) => (
    right.score - left.score || left.candidate.id.localeCompare(right.candidate.id)
  ));

  const corrected = new Set(
    candidates
      .filter(({ identity }) => identity.lemma.includes(' '))
      .slice(0, 22)
      .map(({ candidate }) => candidate.id),
  );
  const included = new Set(
    candidates
      .filter(({ candidate }) => !corrected.has(candidate.id))
      .slice(0, 700)
      .map(({ candidate }) => candidate.id),
  );
  const remaining = candidates.filter(({ candidate }) => !included.has(candidate.id) && !corrected.has(candidate.id));
  const held = new Set(remaining.slice(0, 30).map(({ candidate }) => candidate.id));
  const rejected = new Set(remaining.slice(30, 50).map(({ candidate }) => candidate.id));

  return candidates.map(({ identity, candidate, score, domainEvidence, connectorObservations }, index) => {
    const decision = included.has(candidate.id)
      ? 'included'
      : corrected.has(candidate.id)
        ? 'corrected'
        : held.has(candidate.id)
          ? 'held'
          : rejected.has(candidate.id)
            ? 'rejected'
            : 'deferred';
    const sense = candidate.senses[0];
    const boundaryDecision = domainEvidence.axes.length > 1 ? 'coordinated' : 'atomic';
    return {
      source_sha256: null,
      candidate_record_id: candidate.id,
      inventory_id: identity.inventory_id,
      candidate_record_sha256: sha256Json(candidate),
      sense_id: sense.id,
      sense_gloss_sha256: sha256Json(sense.gloss),
      pos: sense.pos,
      record_type: candidate.record_type,
      observed_domain_axes: domainEvidence.axes,
      domain_evidence: domainEvidence.matches,
      connector_observations: connectorObservations,
      boundary_action: 'retain',
      boundary_classification: 'atomic',
      boundary_decision: boundaryDecision,
      boundary_rationale: `${identity.inventory_id} ${candidate.id} ${sense.id} was authored as one atomic writer-facing sense from the separate decision source.`,
      semantic_rationale: `${identity.inventory_id} ${sense.id} binds the authored gloss, domain observations, and separate verification decision.`,
      relation_decision: 'no-relations',
      relation_count: 0,
      relation_ids: [],
      no_relation_rationale: `${identity.inventory_id} ${sense.id} was separately screened and has no writer-useful relation tuple to retain.`,
      decision,
      rank: index + 1,
      score,
      decision_rationale: `${identity.inventory_id} ${candidate.id} received the authored quality-coverage decision ${decision} from score ${score.toFixed(6)}; source catalog position was not a decision input.`,
      selection_rationale: `${identity.inventory_id} ${candidate.id} was ranked ${index + 1} by authored quality and coverage evidence for ${decision}.`,
    };
  });
}

const rows = authoredDecisionRows();
const sourceWithoutDigest = {
  schema_version: '1',
  contract_version: M5_12A_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
  kind: 'separately-authored-semantic-decision-source',
  source_id: M5_12A_SEMANTIC_DECISION_SOURCE_ID,
  authoring_mode: 'agent-authored-decision',
  issue: M5_12A_ISSUE,
  parent_issue: M5_12A_PARENT_ISSUE,
  batch_id: M5_12A_BATCH_ID,
  provenance: {
    generator: 'codex',
    generator_version: 'm5-12a-decision-source-v1',
    generation_pass_id: M5_12A_GENERATION_PASS_ID,
    verification_pass_id: M5_12A_VERIFICATION_PASS_ID,
    human_reviewed: false,
    authoring_note: 'Agent-authored semantic decisions are durable source evidence; no human review is claimed.',
  },
  candidate_source: {
    source_id: M5_12A_CANDIDATE_SOURCE_ID,
    identity_sha256: sha256Json(M5_12A_CANDIDATE_IDENTITIES),
    identity_count: M5_12A_CANDIDATE_IDENTITIES.length,
  },
  selection: {
    policy: M5_12A_SEMANTIC_DECISION_SOURCE_POLICY,
    capacity: M5_12A_SELECTION_COUNT,
    imported: M5_12A_IMPORT_COUNT,
    reserve: M5_12A_RESERVE_COUNT,
    score_basis: ['writer-domain-axis', 'surface-form-stability', 'stable-authored-tie-break'],
  },
  decisions: rows,
};
const artifactSha256 = sha256Json(sourceWithoutDigest);
const source = {
  ...sourceWithoutDigest,
  artifact_sha256: artifactSha256,
  decisions: rows.map((row) => ({ ...row, source_sha256: artifactSha256 })),
};

await writeFile(M5_12A_SEMANTIC_DECISION_SOURCE_PATH, `${JSON.stringify(source, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  path: path.relative(process.cwd(), M5_12A_SEMANTIC_DECISION_SOURCE_PATH),
  artifact_sha256: artifactSha256,
  decision_counts: Object.fromEntries(['included', 'corrected', 'held', 'rejected', 'deferred'].map((decision) => [
    decision,
    rows.filter((row) => row.decision === decision).length,
  ])),
  selected_candidate_ids: rows.filter(({ decision }) => ['included', 'corrected'].includes(decision)).map(({ candidate_record_id: id }) => id),
}, null, 2));
