import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION,
  SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
  compactAuthoredSemanticDecisionRow,
} from '../validate/semantic-decision-row.mjs';
import {
  M5_15_BATCH_ID,
  M5_15_CANDIDATE_IDENTITIES,
  M5_15_CANDIDATE_SOURCE_ID,
  M5_15_CORRECTION_PASS_ID,
  M5_15_GENERATION_PASS_ID,
  M5_15_IMPORT_COUNT,
  M5_15_ISSUE,
  M5_15_PARENT_ISSUE,
  M5_15_RESERVE_COUNT,
  M5_15_SELECTION_COUNT,
  M5_15_SEMANTIC_REVIEW_VERSION,
  M5_15_VERIFICATION_PASS_ID,
} from './m5-15-candidate-source.mjs';
import {
  AuthoredSemanticDecisionSourceError,
  authoredSemanticDecisionRowDigest,
  candidateRecordsFromAuthoredSemanticDecisionSource,
  decisionSenseReviews as sharedDecisionSenseReviews,
  readAuthoredSemanticDecisionSource,
  serializeAuthoredSemanticDecisionSource,
  validateAuthoredSemanticDecisionSource,
} from './authored-semantic-decision-source.mjs';

const REPOSITORY_DIRECTORY = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const M5_15_SEMANTIC_DECISION_SOURCE_ID = 'm5-15-authored-semantic-decisions-20260923-r1';
export const M5_15_SEMANTIC_DECISION_SOURCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-15-semantic-decisions.json',
);
export const M5_15_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION = SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION;
export const M5_15_SEMANTIC_DECISION_SOURCE_POLICY = 'shared-authored-axis-coverage-selection-v6';

export const M5_15_DECISION_SOURCE_CONFIG = Object.freeze({
  label: 'M5-15',
  errorPrefix: 'M5_15',
  sourceId: M5_15_SEMANTIC_DECISION_SOURCE_ID,
  candidateSourceId: M5_15_CANDIDATE_SOURCE_ID,
  batchId: M5_15_BATCH_ID,
  issue: M5_15_ISSUE,
  parentIssue: M5_15_PARENT_ISSUE,
  generationPassId: M5_15_GENERATION_PASS_ID,
  verificationPassId: M5_15_VERIFICATION_PASS_ID,
  correctionPassId: M5_15_CORRECTION_PASS_ID,
  semanticReviewVersion: M5_15_SEMANTIC_REVIEW_VERSION,
  selectionPolicy: M5_15_SEMANTIC_DECISION_SOURCE_POLICY,
  selectionCount: M5_15_SELECTION_COUNT,
  importCount: M5_15_IMPORT_COUNT,
  reserveCount: M5_15_RESERVE_COUNT,
});

export { AuthoredSemanticDecisionSourceError as M515DecisionSourceError };
export const compactM515DecisionRow = compactAuthoredSemanticDecisionRow;

export function candidateRecordsFromM515DecisionSource(
  source,
  identities = M5_15_CANDIDATE_IDENTITIES,
) {
  return candidateRecordsFromAuthoredSemanticDecisionSource(source, identities, M5_15_DECISION_SOURCE_CONFIG);
}

export function decisionSenseReviews(candidate, row, label = 'decision') {
  return sharedDecisionSenseReviews(candidate, row, label, M5_15_DECISION_SOURCE_CONFIG);
}

export function serializeM515DecisionSource(source) {
  return serializeAuthoredSemanticDecisionSource(source);
}

export function validateM515DecisionSource({
  source,
  sourceBytes,
  identities = M5_15_CANDIDATE_IDENTITIES,
  candidateRecords,
} = {}) {
  return validateAuthoredSemanticDecisionSource({
    source,
    sourceBytes,
    identities,
    candidateRecords,
    config: M5_15_DECISION_SOURCE_CONFIG,
  });
}

export async function readM515DecisionSource(decisionSourcePath = M5_15_SEMANTIC_DECISION_SOURCE_PATH) {
  return readAuthoredSemanticDecisionSource(decisionSourcePath, M5_15_DECISION_SOURCE_CONFIG);
}

export function buildM515DecisionSource() {
  throw new AuthoredSemanticDecisionSourceError(
    'M5-15 semantic decisions are a separately authored durable artifact; the shared producer cannot regenerate or overwrite them',
    'M5_15_DECISION_SOURCE_REGENERATION',
  );
}

export function buildM515DecisionScaffold({ identities = M5_15_CANDIDATE_IDENTITIES } = {}) {
  return {
    source_id: M5_15_SEMANTIC_DECISION_SOURCE_ID,
    candidate_source_id: M5_15_CANDIDATE_SOURCE_ID,
    candidate_identity_count: identities.length,
    selection_capacity: M5_15_SELECTION_COUNT,
    import_target: M5_15_IMPORT_COUNT,
    reserve_capacity: M5_15_RESERVE_COUNT,
    writes_decision_artifact: false,
  };
}

export function applyM515DecisionCorrection() {
  throw new AuthoredSemanticDecisionSourceError(
    'M5-15 corrections must be authored in the durable semantic decision source',
    'M5_15_CORRECTION_POLICY',
  );
}

export function decisionRowDigest(row) {
  return authoredSemanticDecisionRowDigest(row);
}
