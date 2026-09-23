import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  AUTHORED_SEMANTIC_REVIEW_BINDING_CONTRACT_VERSION,
  SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION,
  compactAuthoredSemanticDecisionRow,
} from '../validate/semantic-decision-row.mjs';
import {
  M5_13_BATCH_ID,
  M5_13_CANDIDATE_IDENTITIES,
  M5_13_CANDIDATE_SOURCE_ID,
  M5_13_CORRECTION_PASS_ID,
  M5_13_GENERATION_PASS_ID,
  M5_13_IMPORT_COUNT,
  M5_13_ISSUE,
  M5_13_PARENT_ISSUE,
  M5_13_RESERVE_COUNT,
  M5_13_SELECTION_COUNT,
  M5_13_SEMANTIC_REVIEW_VERSION,
  M5_13_VERIFICATION_PASS_ID,
} from './m5-13-candidate-source.mjs';
import {
  AuthoredSemanticDecisionSourceError,
  authoredSemanticDecisionRowDigest,
  candidateRecordsFromAuthoredSemanticDecisionSource,
  decisionSenseReviews as sharedDecisionSenseReviews,
  readAuthoredSemanticDecisionSource,
  serializeAuthoredSemanticDecisionSource,
  validateAuthoredSemanticDecisionSource,
} from './authored-semantic-decision-source.mjs';

const REPOSITORY_DIRECTORY = path.resolve(new URL('../..', import.meta.url).pathname);

export const M5_13_SEMANTIC_DECISION_SOURCE_ID = 'm5-13-authored-semantic-decisions-20260923-r6';
export const M5_13_SEMANTIC_DECISION_SOURCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/batches/m5-13-semantic-decisions.json',
);
export const M5_13_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION = SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION;
export const M5_13_SEMANTIC_DECISION_SOURCE_POLICY = 'shared-authored-axis-coverage-selection-v6';

export const M5_13_DECISION_SOURCE_CONFIG = Object.freeze({
  label: 'M5-13',
  errorPrefix: 'M5_13',
  sourceId: M5_13_SEMANTIC_DECISION_SOURCE_ID,
  candidateSourceId: M5_13_CANDIDATE_SOURCE_ID,
  batchId: M5_13_BATCH_ID,
  issue: M5_13_ISSUE,
  parentIssue: M5_13_PARENT_ISSUE,
  generationPassId: M5_13_GENERATION_PASS_ID,
  verificationPassId: M5_13_VERIFICATION_PASS_ID,
  correctionPassId: M5_13_CORRECTION_PASS_ID,
  semanticReviewVersion: M5_13_SEMANTIC_REVIEW_VERSION,
  selectionPolicy: M5_13_SEMANTIC_DECISION_SOURCE_POLICY,
  selectionCount: M5_13_SELECTION_COUNT,
  importCount: M5_13_IMPORT_COUNT,
  reserveCount: M5_13_RESERVE_COUNT,
});

export { AuthoredSemanticDecisionSourceError as M513DecisionSourceError };
export const compactM513DecisionRow = compactAuthoredSemanticDecisionRow;

export function candidateRecordsFromM513DecisionSource(
  source,
  identities = M5_13_CANDIDATE_IDENTITIES,
) {
  return candidateRecordsFromAuthoredSemanticDecisionSource(source, identities, M5_13_DECISION_SOURCE_CONFIG);
}

export function decisionSenseReviews(candidate, row, label = 'decision') {
  return sharedDecisionSenseReviews(candidate, row, label, M5_13_DECISION_SOURCE_CONFIG);
}

export function serializeM513DecisionSource(source) {
  return serializeAuthoredSemanticDecisionSource(source);
}

export function validateM513DecisionSource({
  source,
  sourceBytes,
  identities = M5_13_CANDIDATE_IDENTITIES,
  candidateRecords,
} = {}) {
  return validateAuthoredSemanticDecisionSource({
    source,
    sourceBytes,
    identities,
    candidateRecords,
    config: M5_13_DECISION_SOURCE_CONFIG,
  });
}

export async function readM513DecisionSource(decisionSourcePath = M5_13_SEMANTIC_DECISION_SOURCE_PATH) {
  return readAuthoredSemanticDecisionSource(decisionSourcePath, M5_13_DECISION_SOURCE_CONFIG);
}

export function buildM513DecisionSource() {
  throw new AuthoredSemanticDecisionSourceError(
    'M5-13 semantic decisions are a separately authored durable artifact; the shared producer cannot regenerate or overwrite them',
    'M5_13_DECISION_SOURCE_REGENERATION',
  );
}

export function buildM513DecisionScaffold({ identities = M5_13_CANDIDATE_IDENTITIES } = {}) {
  return {
    source_id: M5_13_SEMANTIC_DECISION_SOURCE_ID,
    candidate_source_id: M5_13_CANDIDATE_SOURCE_ID,
    candidate_identity_count: identities.length,
    selection_capacity: M5_13_SELECTION_COUNT,
    import_target: M5_13_IMPORT_COUNT,
    reserve_capacity: M5_13_RESERVE_COUNT,
    writes_decision_artifact: false,
  };
}

export function applyM513DecisionCorrection() {
  throw new AuthoredSemanticDecisionSourceError(
    'M5-13 corrections must be authored in the durable semantic decision source',
    'M5_13_CORRECTION_POLICY',
  );
}

export function decisionRowDigest(row) {
  return authoredSemanticDecisionRowDigest(row);
}
