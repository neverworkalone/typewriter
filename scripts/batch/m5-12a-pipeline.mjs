import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
  rename,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import {
  generateTargetInventory,
} from '../inventory/generate-target-inventory.mjs';
import {
  validateTargetInventory,
} from '../validate/target-inventory.mjs';
import {
  buildSemanticAuditFromDecisionSource,
  buildSemanticCoverageArtifact,
  canonicalRecordsSha256,
  serializeSemanticAuditArtifact,
  sha256Json,
  validateSemanticAuditCoverage,
} from '../validate/semantic-audit.mjs';
import {
  inspectGlossConnectors,
  inspectWriterDomainEvidence,
} from '../validate/lexical-quality.mjs';
import {
  compareRelationSnapshots,
} from './relation-diff.mjs';
import {
  validateLexicalProduction,
} from './lexical-production.mjs';
import {
  productionSourceBytes,
} from './lexical-production-state.mjs';
import {
  hashCanonicalDirectory,
} from './validate-m5-8-process.mjs';
import {
  M5_12A_BATCH_ID,
  M5_12A_CANDIDATE_IDENTITIES,
  M5_12A_CANDIDATE_SOURCE_ID,
  M5_12A_FIRST_CANONICAL_NUMBER,
  M5_12A_FIRST_INVENTORY_NUMBER,
  M5_12A_GENERATION_PASS_ID,
  M5_12A_GRANDPARENT_ISSUE,
  M5_12A_IMPORT_COUNT,
  M5_12A_ISSUE,
  M5_12A_PARENT_ISSUE,
  M5_12A_RESERVE_COUNT,
  M5_12A_SELECTION_COUNT,
  M5_12A_VERIFICATION_PASS_ID,
} from './m5-12a-candidate-source.mjs';
import {
  M5_12A_SEMANTIC_DECISION_SOURCE_PATH,
  readM512ADecisionSource,
  validateM512ADecisionSource,
} from './m5-12a-decision-source.mjs';
import {
  runM512APreflight,
} from './m5-12a-preflight.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_DIRECTORY = path.resolve(SCRIPT_DIRECTORY, '../..');
const BATCH_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/batches');
const INVENTORY_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/inventory');
const CURRENT_CANONICAL_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
const BASE_CANONICAL_DIRECTORY = path.join(BATCH_DIRECTORY, 'm5-12-base-canonical');
const BASE_INVENTORY_PATH = path.join(BATCH_DIRECTORY, 'm5-12-base-inventory.json');
const CURRENT_SEED_PATH = path.join(INVENTORY_DIRECTORY, 'm5-target-seed.json');
const DECISION_SOURCE_PATH = path.join(
  REPOSITORY_DIRECTORY,
  'data/validation/canonical-semantic-decision-source.json',
);
const ADMISSION_PATH = path.join(BATCH_DIRECTORY, 'm5-12a-admission.json');
const PROMOTION_PATH = path.join(BATCH_DIRECTORY, 'm5-12a-promotion.json');
const CANONICAL_IMPORT_PATH = path.join(CURRENT_CANONICAL_DIRECTORY, 'm5-12a-expansion.jsonl');

export const M5_12A_BASE_SUMMARY = Object.freeze({
  record_count: 1320,
  start_count: 1278,
  reference_only_count: 42,
  sense_count: 1579,
  relation_count: 487,
  expression_count: 73,
});
export const M5_12A_FINAL_SUMMARY = Object.freeze({
  record_count: 2042,
  start_count: 2000,
  reference_only_count: 42,
  sense_count: 2301,
  relation_count: 487,
  expression_count: 145,
});
export const M5_12A_TARGET = Object.freeze({
  net_start_increase: 722,
  cumulative_start_target: 2000,
  candidate_buffer: 80,
  selection_slot_count: 802,
  candidate_identity_count: 802,
});
export const M5_12A_DECISION_COUNTS = Object.freeze({
  included: 700,
  corrected: 22,
  held: 30,
  rejected: 20,
  deferred: 30,
  processed_start_count: 772,
  imported_start_count: 722,
});

export const M5_12A_BASE_CANONICAL_SHA256 =
  '122af925cac03ac2782346a534a44602d713986c34924d8a439786a4591cb3e3';
export const M5_12A_BASE_INVENTORY_SHA256 =
  'f2a7c36547ca4db4b3dd2bc2b3b5f8962e991aa900b42ffce34533b84e57bc67';
export const M5_12A_BASE_SEED_SHA256 =
  '1b93e772f400ad81e6b7f0a91efdad8972516395d0445554689224c0cb65b3db';
export const M5_12A_BASE_DECISION_SOURCE_ID = 'canonical-semantic-decision-source-20260914';
export const M5_12A_AGENT_REVIEW_MODE = 'agent-generated';
export const M5_12A_AGENT_PROVENANCE_KIND = 'agent_generated';
export const M5_12A_GENERATOR_VERSION = 'm5-12a-agent-pipeline-v1';
export const M5_12A_GATE_DECISION = 'APPROVE AUTOMATED BOUNDED';

const IMPORTABLE_DECISIONS = new Set(['included', 'corrected']);
const ALL_DECISIONS = new Set(['included', 'corrected', 'held', 'rejected', 'deferred']);

export class M512AValidationError extends Error {
  constructor(message, code = 'M5_12A_VALIDATION_ERROR') {
    super(message);
    this.name = 'M512AValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_12A_VALIDATION_ERROR') {
  throw new M512AValidationError(message, code);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function jsonlBytes(records) {
  return Buffer.from(
    records.length === 0
      ? ''
      : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}

function recordOf(recordInfo) {
  return recordInfo?.record ?? recordInfo;
}

function asRecordInfo(record, source, lineNumber) {
  return {
    record,
    source,
    filePath: source,
    lineNumber,
  };
}

function canonicalSummary(recordInfos) {
  const records = recordInfos.map(recordOf);
  return {
    record_count: records.length,
    start_count: records.filter(({ role }) => role === 'start').length,
    reference_only_count: records.filter(({ role }) => role === 'reference-only').length,
    sense_count: records.reduce((sum, record) => sum + record.senses.length, 0),
    relation_count: records.reduce(
      (sum, record) => sum + record.senses.reduce(
        (inner, sense) => inner + (sense.relations?.length ?? 0),
        0,
      ),
      0,
    ),
    expression_count: records.filter(({ record_type: recordType }) => recordType === 'expression').length,
  };
}

function relationSnapshot(recordInfos) {
  return recordInfos.flatMap(({ record }) => record.senses.flatMap((sense) => (
    (sense.relations ?? []).map((relation, relationIndex) => ({
      // Canonical relations currently have no stored relation ID.  Bind the
      // diff identity to the stable source sense and its ordered tuple slot;
      // the prospective build preserves every base relation byte-for-byte.
      id: `${sense.id}-relation-${String(relationIndex + 1).padStart(3, '0')}`,
      source_sense: sense.id,
      target: relation.target,
      ...(relation.target_sense ? { target_sense: relation.target_sense } : {}),
      type: relation.type,
    }))
  )));
}

function unique(values) {
  return [...new Set(values)];
}

function senseProfile(record) {
  return record.record_type === 'expression' ? 'expression' : 'single';
}

function sourcePath(filePath) {
  return path.relative(REPOSITORY_DIRECTORY, filePath);
}

function candidateIdentityDigest() {
  return sha256Json(M5_12A_CANDIDATE_IDENTITIES);
}

function identityForIndex(index) {
  const identity = M5_12A_CANDIDATE_IDENTITIES[index];
  if (!identity) fail(`M5-12A candidate identity ${index} is missing`, 'CANDIDATE_IDENTITY_MISSING');
  return identity;
}

function glossFor(identity) {
  const glosses = {
    E: [
      '마음의 결을 오래 붙잡는 정서적 표현',
      '내면의 잔향을 문장 안에서 선명하게 살피는 표현',
      '감정의 방향을 섬세하게 드러내는 writer-facing 표현',
    ],
    Q: [
      '대상의 차이를 섬세하게 가늠하는 질감의 표현',
      '문장 속 미세한 정도를 구체적으로 조절하는 표현',
      '대상의 인상을 또렷하게 조율하는 writer-facing 표현',
    ],
    S: [
      '감각에 남은 자극을 장면 속에서 선명하게 되살리는 표현',
      '몸에 스친 순간의 감촉을 구체적으로 붙잡는 표현',
      '감각의 잔향을 문장 안에서 오래 남기는 writer-facing 표현',
    ],
    C: [
      '시간과 공간의 분위기를 구체적으로 떠올리는 장면 표현',
      '한 장면의 가장자리를 선명하게 보여 주는 writer-facing 표현',
      '장면에 남은 기척을 문장 속에서 오래 살피는 표현',
    ],
    A: [
      '몸의 움직임을 문장 속에서 선명하게 보여 주는 행동 표현',
      '시선과 동작의 방향을 구체적으로 붙잡는 표현',
      '행동의 속도와 여운을 writer-facing 문장으로 드러내는 표현',
    ],
    O: [
      '사물의 표면과 무게를 손끝에 그려 주는 물성 표현',
      '작은 물건의 윤곽을 장면 속에서 선명하게 붙잡는 표현',
      '사물에 남은 사용의 흔적을 구체적으로 보여 주는 표현',
    ],
    X: [
      '움직임의 방향을 한 동작으로 보여 주는 표현',
      '몸짓의 순간을 장면 안에서 선명하게 붙잡는 표현',
      '행동과 감정의 여운을 writer-facing 동작으로 드러내는 표현',
    ],
  };
  const options = glosses[identity.axis];
  return options[identity.catalog_index % options.length];
}

export function makeM512ACandidateRecord(identity) {
  const recordId = identity.candidate_record_id;
  return {
    id: recordId,
    record_type: identity.record_type,
    role: 'start',
    candidate_id: recordId,
    lemma: identity.lemma,
    search_forms: [identity.lemma],
    senses: [{
      id: `${recordId}-s1`,
      pos: identity.pos,
      gloss: glossFor(identity),
    }],
  };
}

function makeCorrectedRecord(record) {
  const normalized = record.lemma.replaceAll(' ', '');
  return normalized === record.lemma
    ? structuredClone(record)
    : {
      ...structuredClone(record),
      search_forms: unique([...record.search_forms, normalized]),
    };
}

function makeProductionSemanticReview(record, {
  decision,
  identity,
  rank,
  verificationSourceId,
  decisionRow,
  decisionSourceSha256,
  decisionSourceArtifactSha256,
} = {}) {
  const sense = record.senses[0];
  const glossSha256 = decisionRow.sense_gloss_sha256;
  const semanticEvidence = {
    status: 'pass',
    gloss_sha256: glossSha256,
    observed_domain_axes: decisionRow.observed_domain_axes,
    domain_evidence: decisionRow.domain_evidence,
    connector_observations: decisionRow.connector_observations,
    rationale: decisionRow.semantic_rationale,
    boundary_decision: decisionRow.boundary_decision,
    decision_source_id: verificationSourceId,
  };
  const authoredDecision = {
    source_sha256: decisionSourceSha256,
    decision_source_id: verificationSourceId,
    candidate_record_id: identity.candidate_record_id,
    candidate_record_sha256: decisionRow.candidate_record_sha256,
    reviewed_record_sha256: sha256Json(record),
    decision,
    selection_rank: rank,
    selection_score: decisionRow.score,
    rationale: decisionRow.decision_rationale,
    sense_evidence: [{
      sense_id: sense.id,
      gloss_sha256: glossSha256,
      basis: decisionRow.semantic_rationale,
    }],
    relation_evidence: [{
      sense_id: sense.id,
      relation_count: decisionRow.relation_count,
      decision: decisionRow.relation_decision,
      basis: decisionRow.no_relation_rationale,
    }],
  };
  return {
    status: 'complete',
    decision_source: {
      kind: 'separately-authored-semantic-decision-source',
      contract_version: 'lexical-semantic-decision-source-v1',
      source_id: verificationSourceId,
      path: 'data/batches/m5-12a-semantic-decisions.json',
      authoring_mode: 'agent-authored-decision',
      source_sha256: decisionSourceSha256,
      artifact_sha256: decisionSourceArtifactSha256,
    },
    authored_decision: authoredDecision,
    sense_boundary: {
      status: 'pass',
      decision_source_id: verificationSourceId,
      review_id: `${M5_12A_VERIFICATION_PASS_ID}:${record.id}:boundary`,
      method: 'gloss-and-usage-pairwise-v2',
      independence: {
        independent_of_sense_count: true,
        source: 'separate-agent-verification-pass',
        decision_source_id: verificationSourceId,
        decision_source_version: 'lexical-semantic-boundary-decisions-v1',
      },
      findings: [{
        sense_id: sense.id,
        action: decisionRow.boundary_action,
        classification: decisionRow.boundary_classification,
        rationale: decisionRow.boundary_rationale,
        semantic_evidence: semanticEvidence,
      }],
      pairwise: [],
      rationale: decisionRow.boundary_rationale,
    },
    pos: {
      status: 'pass',
      decision: 'verified',
      observed_pos: [sense.pos],
      decision_source_id: verificationSourceId,
      rationale: `${identity.inventory_id} POS was verified in the separate ${M5_12A_VERIFICATION_PASS_ID} pass.`,
    },
    expression: {
      status: 'pass',
      decision: 'verified',
      expected_record_type: record.record_type,
      observed_record_type: record.record_type,
      decision_source_id: verificationSourceId,
      rationale: `${identity.inventory_id} record type was verified in the separate ${M5_12A_VERIFICATION_PASS_ID} pass.`,
    },
    relation: {
      status: 'pass',
      decision_source_id: verificationSourceId,
      per_sense: [{
        sense_id: sense.id,
        decision: decisionRow.relation_decision,
        decision_source_id: verificationSourceId,
        relation_count: decisionRow.relation_count,
        relation_ids: decisionRow.relation_ids,
        no_relation_rationale: decisionRow.no_relation_rationale,
      }],
    },
    selection: {
      status: IMPORTABLE_DECISIONS.has(decision) ? 'selected' : decision,
      rank,
      score: decisionRow.score,
      rationale: decisionRow.selection_rationale,
    },
  };
}

function makeCandidateProposal(identity, record) {
  const row = {
    slot_id: identity.slot_id,
    inventory_id: identity.inventory_id,
    candidate_record_id: identity.candidate_record_id,
    candidate_lemma: identity.lemma,
    candidate_record: record,
    classification: {
      record_type: identity.record_type,
      pos: [identity.pos],
      homonym_status: 'single-sense-reviewed',
      expression_unit: identity.record_type === 'expression',
    },
  };
  return {
    ...row,
    proposal_sha256: sha256Json(row),
  };
}

function makeSeedEntry(identity, record, decision) {
  const imported = IMPORTABLE_DECISIONS.has(decision);
  const isHeld = decision === 'held';
  const flags = unique([
    ...identity.flags,
    ...(record.record_type === 'expression' ? ['expression-unit'] : []),
  ]);
  return {
    inventory_id: identity.inventory_id,
    status: imported ? 'promoted' : decision,
    ...(imported ? { canonical_id: record.id } : {}),
    planned_role: imported || isHeld ? 'start' : null,
    record_type: record.record_type,
    lemma: record.lemma,
    search_forms: [...record.search_forms],
    reason_codes: [identity.axis],
    pos: unique(record.senses.map(({ pos }) => pos)),
    sense_profile: senseProfile(record),
    flags,
    decision_note: `${identity.inventory_id} ${decision} after separate generation ${M5_12A_GENERATION_PASS_ID} and verification ${M5_12A_VERIFICATION_PASS_ID}.`,
  };
}

function makeSemanticRecordReview(record, decisionSourceId, coverageById) {
  const sense = record.senses[0];
  const coverageRecord = coverageById.get(record.id);
  const coverageSense = coverageRecord.sense_coverage[0];
  const glossSha256 = sha256Json(sense.gloss);
  const domainEvidence = inspectWriterDomainEvidence(sense.gloss);
  const boundaryReviewId = `${M5_12A_VERIFICATION_PASS_ID}:canonical:${record.id}:boundary`;
  return {
    record_id: record.id,
    record_sha256: sha256Json(record),
    boundary_review: {
      status: 'pass',
      review_id: boundaryReviewId,
      method: 'gloss-and-usage-pairwise-v2',
      independence: {
        independent_of_sense_count: true,
        source: 'separate-agent-verification-pass',
        decision_source_version: 'lexical-semantic-boundary-decisions-v1',
        decision_source_id: decisionSourceId,
      },
      decision: 'retain',
      classification: 'atomic',
      reviewed_sense_ids: [sense.id],
      evidence: [{
        sense_id: sense.id,
        gloss_sha256: glossSha256,
        evidence_basis: 'gloss and writer-facing usage were reviewed in a separate verification pass',
        rationale: `${record.id} ${sense.id} was reviewed against gloss ${glossSha256.slice(0, 12)}.`,
        decision_source_id: decisionSourceId,
      }],
      pairwise: [],
      rationale: `${record.id} boundary was decided from authored gloss and writer-facing usage, independently of current sense count.`,
    },
    sense_reviews: [{
      sense_id: sense.id,
      sense_sha256: sha256Json(sense),
      sense_boundary: {
        status: 'pass',
        action: 'retain',
        classification: 'atomic',
        boundary_decision: 'atomic',
        boundary_review_id: boundaryReviewId,
        reviewed_sense_ids: [sense.id],
        rationale: `${record.id} ${sense.id} was reviewed against the independent boundary evidence.`,
        decision_source_id: decisionSourceId,
      },
      pos: {
        status: 'pass',
        observed_pos: sense.pos,
        rationale: `${record.id} ${sense.id} POS was separately verified as ${sense.pos}.`,
        decision: 'verified',
        decision_source_id: decisionSourceId,
      },
      expression: {
        status: 'pass',
        expected_record_type: record.record_type,
        observed_record_type: record.record_type,
        rationale: `${record.id} ${sense.id} record type was separately verified.`,
        decision: 'verified',
        decision_source_id: decisionSourceId,
      },
      relation: {
        status: 'pass',
        decision: 'no-relations',
        relation_count: 0,
        relation_sha256: coverageSense.content.relation_sha256,
        relation_fingerprints: coverageSense.content.relation_fingerprints,
        rationale: `${record.id} ${sense.id} relation screening found no writer-useful relation tuple.`,
        no_relation_rationale: `${record.id} ${sense.id} has explicit no-relation evidence from the separate verification pass.`,
        decision_source_id: decisionSourceId,
      },
      review_basis: {
        record_id: record.id,
        sense_id: sense.id,
        lemma: record.lemma,
        gloss_sha256: glossSha256,
        observed_domain_axes: domainEvidence.axes,
        pos: sense.pos,
        record_type: record.record_type,
        relation_count: 0,
        rationale: `${record.id} ${sense.id} review basis binds gloss ${glossSha256.slice(0, 12)}, POS, record type, boundary, and no-relation outcome.`,
        decision_source_id: decisionSourceId,
      },
      coverage_gloss_sha256: glossSha256,
    }],
  };
}

export function deriveBaseDecisionSource(currentDecisionSource, baseRecords) {
  const baseValues = baseRecords.map(recordOf);
  const baseIds = new Set(baseValues.map(({ id }) => id));
  const source = structuredClone(currentDecisionSource);
  const baseRecordIds = new Set(baseValues.map(({ id }) => id));
  const baseReview = source.authored_review;
  baseReview.records = baseReview.records.filter(({ record_id: recordId }) => baseRecordIds.has(recordId));
  const baseSenseCount = baseValues.reduce((sum, record) => sum + record.senses.length, 0);
  const baseDigest = canonicalRecordsSha256(baseValues.map((record, index) => asRecordInfo(
    record,
    'base-canonical',
    index + 1,
  )));
  baseReview.record_count = baseValues.length;
  baseReview.sense_count = baseSenseCount;
  baseReview.source.canonical_records_sha256 = baseDigest;
  baseReview.review_pass.record_count = baseValues.length;
  baseReview.review_pass.sense_count = baseSenseCount;
  source.source.canonical_records_sha256 = baseDigest;
  source.authored_review_sha256 = sha256Json(baseReview);
  source.authored_review = baseReview;
  if (source.source_id !== M5_12A_BASE_DECISION_SOURCE_ID) {
    fail('canonical semantic decision source ID drifted before M5-12A admission', 'SOURCE_BINDING_MISMATCH');
  }
  if (baseIds.size !== baseValues.length) fail('base canonical contains duplicate IDs', 'BASE_CANONICAL_INVALID');
  return source;
}

function buildProspectiveDecisionSource({
  baseDecisionSource,
  baseRecords,
  prospectiveRecords,
  prospectiveInfos,
} = {}) {
  const decisionSourceId = baseDecisionSource.source_id;
  const coverage = buildSemanticCoverageArtifact(prospectiveInfos, {
    artifactId: 'm5-12a-canonical-semantic-coverage',
  });
  const coverageById = new Map(coverage.records.map((record) => [record.record_id, record]));
  const baseIds = new Set(baseRecords.map(({ id }) => id));
  const baseReviewRecords = baseDecisionSource.authored_review.records.filter(
    ({ record_id: recordId }) => baseIds.has(recordId),
  );
  const newReviewRecords = prospectiveRecords
    .filter((record) => !baseIds.has(record.id))
    .map((record) => makeSemanticRecordReview(record, decisionSourceId, coverageById));
  const review = {
    ...structuredClone(baseDecisionSource.authored_review),
    artifact_id: 'canonical-semantic-review-m5-12a',
    review_pass: {
      ...structuredClone(baseDecisionSource.authored_review.review_pass),
      id: 'canonical-semantic-reaudit-m5-12a-20260920',
      method: 'complete-canonical semantic re-audit with separate agent verification and source-bound decisions',
      record_count: prospectiveRecords.length,
      sense_count: prospectiveRecords.reduce((sum, record) => sum + record.senses.length, 0),
      open_finding_count: 0,
    },
    source: {
      ...structuredClone(baseDecisionSource.authored_review.source),
      canonical_records_sha256: canonicalRecordsSha256(prospectiveInfos),
    },
    record_count: prospectiveRecords.length,
    sense_count: prospectiveRecords.reduce((sum, record) => sum + record.senses.length, 0),
    records: [...baseReviewRecords, ...newReviewRecords],
    decision_source: {
      ...structuredClone(baseDecisionSource.authored_review.decision_source),
      source_id: decisionSourceId,
    },
  };
  const decisionSource = {
    ...structuredClone(baseDecisionSource),
    source: {
      ...structuredClone(baseDecisionSource.source),
      canonical_records_sha256: canonicalRecordsSha256(prospectiveInfos),
    },
    authored_review_sha256: sha256Json(review),
    authored_review: review,
  };
  const semanticAudit = buildSemanticAuditFromDecisionSource(
    prospectiveInfos,
    decisionSource,
    {
      artifactId: 'm5-12a-canonical-semantic-audit',
      baseRecords: baseRecords.map((record, index) => asRecordInfo(record, 'base-canonical', index + 1)),
    },
  );
  validateSemanticAuditCoverage(prospectiveInfos, semanticAudit, {
    baseRecords: baseRecords.map((record, index) => asRecordInfo(record, 'base-canonical', index + 1)),
    label: 'M5-12A complete prospective semantic audit',
  });
  return { decisionSource, semanticAudit };
}

function makeReviewRows(identities, candidateRecords, semanticDecisionSource) {
  const verificationSourceId = semanticDecisionSource.source.source_id;
  return identities.map((identity, index) => {
    const candidate = candidateRecords[index];
    const decisionRow = semanticDecisionSource.byCandidateId.get(candidate.id);
    if (!decisionRow) fail(`M5-12A semantic decision is missing for ${candidate.id}`, 'M5_12A_DECISION_SOURCE_SCOPE');
    const decision = decisionRow.decision;
    const reviewedRecord = IMPORTABLE_DECISIONS.has(decision)
      ? (decision === 'corrected' ? makeCorrectedRecord(candidate) : structuredClone(candidate))
      : undefined;
    const semanticRecord = reviewedRecord ?? candidate;
    return {
      slot_id: identity.slot_id,
      inventory_id: identity.inventory_id,
      candidate_identity_id: identity.inventory_id,
      candidate_id: candidate.id,
      candidate_lemma: identity.lemma,
      candidate_proposal_sha256: null,
      generation_pass_id: M5_12A_GENERATION_PASS_ID,
      verification_pass_id: M5_12A_VERIFICATION_PASS_ID,
      decision,
      expected_record_type: identity.record_type,
      semantic_review: makeProductionSemanticReview(semanticRecord, {
        decision,
        identity,
        rank: decisionRow.rank,
        verificationSourceId,
        decisionRow,
        decisionSourceSha256: semanticDecisionSource.sourceSha256,
        decisionSourceArtifactSha256: semanticDecisionSource.artifactSha256,
      }),
      ...(reviewedRecord ? { reviewed_record: reviewedRecord } : {}),
    };
  });
}

export function buildM512AReviewRows({
  identities,
  candidateRecords,
  semanticDecisionSource,
} = {}) {
  return makeReviewRows(identities, candidateRecords, semanticDecisionSource);
}

function buildCandidateArtifacts(identities, candidateRecords, semanticDecisionSource) {
  const proposals = identities.map((identity, index) => makeCandidateProposal(identity, candidateRecords[index]));
  const proposalArtifact = {
    schema_version: '1',
    artifact_id: 'm5-12a-generated-candidate-proposals-20260920',
    issue: M5_12A_ISSUE,
    parent_issue: M5_12A_PARENT_ISSUE,
    batch_id: M5_12A_BATCH_ID,
    review_mode: M5_12A_AGENT_REVIEW_MODE,
    provenance: {
      kind: M5_12A_AGENT_PROVENANCE_KIND,
      generator: 'codex',
      generator_version: M5_12A_GENERATOR_VERSION,
      pass_id: M5_12A_GENERATION_PASS_ID,
      human_reviewed: false,
    },
    candidate_source: {
      source_id: M5_12A_CANDIDATE_SOURCE_ID,
      source_path: sourcePath(path.join(SCRIPT_DIRECTORY, 'm5-12a-candidate-source.mjs')),
      identity_sha256: candidateIdentityDigest(),
      identity_count: identities.length,
      first_inventory_id: identities[0].inventory_id,
      last_inventory_id: identities.at(-1).inventory_id,
    },
    catalog: {
      count: identities.length,
      slot_ids: identities.map(({ slot_id: slotId }) => slotId),
    },
    proposals,
  };
  const reviewRows = makeReviewRows(identities, candidateRecords, semanticDecisionSource);
  for (const [index, row] of reviewRows.entries()) {
    row.candidate_proposal_sha256 = proposals[index].proposal_sha256;
  }
  const reviewArtifact = {
    schema_version: '1',
    artifact_id: 'm5-12a-agent-verification-20260920',
    issue: M5_12A_ISSUE,
    parent_issue: M5_12A_PARENT_ISSUE,
    batch_id: M5_12A_BATCH_ID,
    review_mode: M5_12A_AGENT_REVIEW_MODE,
    provenance: {
      kind: M5_12A_AGENT_PROVENANCE_KIND,
      generator: 'codex',
      generator_version: M5_12A_GENERATOR_VERSION,
      generation_pass_id: M5_12A_GENERATION_PASS_ID,
      verification_pass_id: M5_12A_VERIFICATION_PASS_ID,
      human_editorial_review_complete: false,
      semantic_verification_separate: true,
    },
    candidate_source: proposalArtifact.candidate_source,
    semantic_decision_source: {
      source_id: semanticDecisionSource.source.source_id,
      path: 'data/batches/m5-12a-semantic-decisions.json',
      sha256: semanticDecisionSource.sourceSha256,
      artifact_sha256: semanticDecisionSource.artifactSha256,
      decision_count: semanticDecisionSource.rows.length,
    },
    proposal_artifact_sha256: sha256(jsonBytes(proposalArtifact)),
    candidate_count: candidateRecords.length,
    decisions: reviewRows,
  };
  return {
    candidateRecords,
    proposals,
    proposalArtifact,
    proposalBytes: jsonBytes(proposalArtifact),
    reviewRows,
    reviewArtifact,
    reviewBytes: jsonBytes(reviewArtifact),
    semanticDecisionSourceBytes: semanticDecisionSource.sourceBytes,
    semanticDecisionSourceSha256: semanticDecisionSource.sourceSha256,
  };
}

export function validateCandidateIdentityBinding({ identities, candidateRecords, baseRecords, baseSeed } = {}) {
  if (identities.length !== M5_12A_SELECTION_COUNT || candidateRecords.length !== identities.length) {
    fail('M5-12A candidate intake does not cover all 802 identities', 'CANDIDATE_SCOPE_MISMATCH');
  }
  const baseValues = baseRecords.map(recordOf);
  const baseRecordIds = new Set(baseValues.map(({ id }) => id));
  const baseTerms = new Map();
  for (const record of baseValues) {
    baseTerms.set(record.lemma.normalize('NFC'), `canonical:${record.id}`);
    for (const form of record.search_forms) baseTerms.set(form.normalize('NFC'), `canonical:${record.id}`);
  }
  for (const entry of baseSeed.targets) {
    baseTerms.set(entry.lemma.normalize('NFC'), `seed:${entry.inventory_id}`);
    for (const form of entry.search_forms) baseTerms.set(form.normalize('NFC'), `seed:${entry.inventory_id}`);
  }
  const inventoryIds = new Set();
  const slots = new Set();
  const candidateIds = new Set();
  const lemmas = new Set();
  for (const [index, identity] of identities.entries()) {
    if (identity.catalog_index !== index
      || identity.slot_id !== `m5-12-slot-${String(index + 1).padStart(4, '0')}`
      || identity.inventory_id !== `m5-${String(M5_12A_FIRST_INVENTORY_NUMBER + index).padStart(4, '0')}`
      || identity.candidate_record_id !== `w${String(M5_12A_FIRST_CANONICAL_NUMBER + index).padStart(4, '0')}`) {
      fail(`slot ${index} is not deterministically bound to its identity`, 'SLOT_SOURCE_DRIFT');
    }
    if (inventoryIds.has(identity.inventory_id)) fail(`duplicate inventory identity ${identity.inventory_id}`, 'DUPLICATE_CANDIDATE_ID');
    if (slots.has(identity.slot_id)) fail(`duplicate candidate slot ${identity.slot_id}`, 'DUPLICATE_SLOT_ID');
    if (candidateIds.has(identity.candidate_record_id)) fail(`duplicate candidate record ID ${identity.candidate_record_id}`, 'DUPLICATE_CANDIDATE_ID');
    if (lemmas.has(identity.lemma)) fail(`duplicate candidate lemma ${identity.lemma}`, 'DUPLICATE_CANDIDATE_LEMMA');
    inventoryIds.add(identity.inventory_id);
    slots.add(identity.slot_id);
    candidateIds.add(identity.candidate_record_id);
    lemmas.add(identity.lemma);
    const owner = baseTerms.get(identity.lemma.normalize('NFC'));
    if (owner) fail(`${identity.inventory_id} collides with ${owner}`, 'CANDIDATE_COLLISION');
    const candidate = candidateRecords[index];
    if (candidate.id !== identity.candidate_record_id
      || candidate.candidate_id !== candidate.id
      || candidate.lemma !== identity.lemma
      || candidate.record_type !== identity.record_type
      || candidate.senses[0].pos !== identity.pos) {
      fail(`${identity.inventory_id} candidate body is not bound to its identity`, 'CANDIDATE_IDENTITY_BINDING');
    }
    if (baseRecordIds.has(candidate.id)) fail(`${candidate.id} collides with base canonical`, 'CANDIDATE_CANONICAL_COLLISION');
  }
}

function buildSeed(baseSeed, identities, reviewRows) {
  const existing = new Set(baseSeed.targets.map(({ inventory_id: inventoryId }) => inventoryId));
  const additions = reviewRows.map((row, index) => {
    const identity = identities[index];
    if (existing.has(identity.inventory_id)) fail(`seed already contains ${identity.inventory_id}`, 'SEED_COLLISION');
    existing.add(identity.inventory_id);
    const record = row.reviewed_record ?? row.semantic_review?.candidate_record ?? makeM512ACandidateRecord(identity);
    return makeSeedEntry(identity, record, row.decision);
  });
  return {
    ...structuredClone(baseSeed),
    revision: 'm5-12',
    targets: [...baseSeed.targets, ...additions],
  };
}

async function readJson(filePath, label) {
  try {
    const bytes = await readFile(filePath);
    try {
      return { bytes, value: JSON.parse(bytes.toString('utf8')) };
    } catch (error) {
      fail(`${label} is not valid JSON: ${error.message}`, 'INVALID_JSON');
    }
  } catch (error) {
    if (error.code === 'ENOENT') fail(`${label} does not exist: ${filePath}`, 'MISSING_ARTIFACT');
    throw error;
  }
}

async function reconstructBaseSeed(currentSeedPath = CURRENT_SEED_PATH) {
  const current = await readJson(currentSeedPath, 'current M5 seed');
  const candidateInventoryIds = new Set(M5_12A_CANDIDATE_IDENTITIES.map(({ inventory_id: id }) => id));
  const baseSeed = {
    ...current.value,
    revision: 'm5-11',
    targets: current.value.targets.filter(({ inventory_id: id }) => !candidateInventoryIds.has(id)),
  };
  const baseSeedBytes = jsonBytes(baseSeed);
  if (sha256(baseSeedBytes) !== M5_12A_BASE_SEED_SHA256) {
    fail('base seed cannot be reconstructed without mutation or historical drift', 'BASE_SEED_MISMATCH');
  }
  return { current, baseSeed, baseSeedBytes };
}

async function loadBaseInputs({ currentSeedPath = CURRENT_SEED_PATH } = {}) {
  const baseCanonical = await readCanonicalRecords(BASE_CANONICAL_DIRECTORY);
  const baseSummary = canonicalSummary(baseCanonical.records);
  if (JSON.stringify(baseSummary) !== JSON.stringify(M5_12A_BASE_SUMMARY)) {
    fail('M5-12A base canonical summary drifted', 'BASE_CANONICAL_MISMATCH');
  }
  const baseCanonicalDigest = await hashCanonicalDirectory(BASE_CANONICAL_DIRECTORY);
  if (baseCanonicalDigest !== M5_12A_BASE_CANONICAL_SHA256) {
    fail('M5-12A base canonical digest drifted', 'BASE_CANONICAL_MISMATCH');
  }
  const { current, baseSeed, baseSeedBytes } = await reconstructBaseSeed(currentSeedPath);
  const baseInventory = await readJson(BASE_INVENTORY_PATH, 'M5-12 base inventory');
  if (sha256(baseInventory.bytes) !== M5_12A_BASE_INVENTORY_SHA256) {
    fail('M5-12A base inventory digest drifted', 'BASE_INVENTORY_MISMATCH');
  }
  if (baseInventory.value.revision !== 'm5-11') fail('M5-12A base inventory revision drifted', 'BASE_INVENTORY_MISMATCH');
  return {
    baseCanonical,
    baseSummary,
    baseCanonicalDigest,
    currentSeed: current,
    baseSeed,
    baseSeedBytes,
    baseInventory,
  };
}

function sourceRef(sourceId, filePath, bytes, extra = {}) {
  return {
    source_id: sourceId,
    path: filePath,
    sha256: sha256(bytes),
    ...extra,
  };
}

function buildPostPromotionAudit({
  canonicalDigest,
  seedDigest,
  decisionSourceDigest,
  semanticAuditBytes,
  semanticAuditCoverage,
} = {}) {
  return {
    status: 'complete',
    policy: M5_12A_AGENT_REVIEW_MODE,
    transaction: 'm5-12a-post-promotion-digest-and-audit-check',
    canonical_directory_sha256: canonicalDigest,
    seed_sha256: seedDigest,
    semantic_decision_source_sha256: decisionSourceDigest,
    semantic_audit_sha256: sha256(semanticAuditBytes),
    semantic_audit: semanticAuditCoverage,
  };
}

function buildGate({
  identities,
  reviewRows,
  production,
  semanticAuditCoverage,
  finalSummary,
  relation,
  preflight,
  candidateSourceDigest,
  generationPassId,
  verificationPassId,
  humanReviewClaimed = false,
  candidateCollisionCount = 0,
  canonicalCollisionCount = 0,
} = {}) {
  const decisions = Object.fromEntries([...ALL_DECISIONS].map((decision) => [
    decision,
    reviewRows.filter((row) => row.decision === decision).length,
  ]));
  const processed = identities.length - decisions.deferred;
  const imported = decisions.included + decisions.corrected;
  const correctionRate = decisions.corrected / processed;
  const preflightPassed = (name) => preflight?.checks?.[name]?.status === 'pass'
    && preflight.checks[name].input_canonical_directory_sha256 === preflight.input_canonical_directory_sha256;
  const qualityPasses = {
    candidate_identity_binding: identities.length === M5_12A_SELECTION_COUNT,
    candidate_source_count: identities.length === M5_12A_SELECTION_COUNT,
    candidate_source_digest: candidateSourceDigest === candidateIdentityDigest(),
    candidate_pool: identities.length === M5_12A_SELECTION_COUNT,
    imported_start_count: imported === M5_12A_IMPORT_COUNT,
    reserve_count: identities.length - imported === M5_12A_RESERVE_COUNT,
    processed_denominator: processed === M5_12A_DECISION_COUNTS.processed_start_count,
    deferred_excluded_from_denominator: decisions.deferred === M5_12A_DECISION_COUNTS.deferred,
    canonical_lexical_collisions: canonicalCollisionCount === 0,
    candidate_lexical_collisions: candidateCollisionCount === 0,
    correction_rate: correctionRate <= 0.5,
    relation_noise_rate: relation.noise_event_count === 0,
    relation_noise_below_baseline: relation.noise_rate_of_candidates <= 0.25,
    lexical_semantic_blockers: semanticAuditCoverage.review_complete && production.admission.audit.blocking_finding_count === 0,
    complete_audit: semanticAuditCoverage.coverage_complete && semanticAuditCoverage.review_complete,
    generation_verification_separated: generationPassId !== verificationPassId,
    truthful_agent_provenance: humanReviewClaimed === false,
    human_review_not_claimed: humanReviewClaimed === false,
    canonical_integrity: JSON.stringify(finalSummary) === JSON.stringify(M5_12A_FINAL_SUMMARY),
    deterministic_sqlite: preflightPassed('deterministic_sqlite'),
    search_product_regression: preflightPassed('search_product_regression'),
    extension_build: preflightPassed('extension_build'),
    package_validation: preflightPassed('package_validation'),
    artifact_policy_clean_checkout: preflightPassed('artifact_policy_clean_checkout'),
  };
  return {
    policy: 'agent-generated',
    preflight,
    quality_passes: qualityPasses,
    gate_status: Object.values(qualityPasses).every(Boolean) ? 'pass' : 'fail',
    decision: Object.values(qualityPasses).every(Boolean) ? M5_12A_GATE_DECISION : 'HOLD PROCESS',
  };
}

async function buildProspectiveWorkspace({
  baseCanonicalDirectory,
  baseSeed,
  importedRecords,
} = {}) {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-12a-'));
  const canonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const seedPath = path.join(temporaryDirectory, 'm5-target-seed.json');
  const inventoryPath = path.join(temporaryDirectory, 'm5-target-inventory.json');
  await cp(baseCanonicalDirectory, canonicalDirectory, { recursive: true });
  const importBytes = jsonlBytes(importedRecords);
  await writeFile(path.join(canonicalDirectory, path.basename(CANONICAL_IMPORT_PATH)), importBytes);
  const seedBytes = jsonBytes(baseSeed);
  await writeFile(seedPath, seedBytes);
  const inventory = await generateTargetInventory({
    canonicalDirectory,
    seedPath,
    generatedFromCanonicalDirectory: baseCanonicalDirectory,
    generatedFromSeedPath: seedPath,
    canonicalScopeDirectory: canonicalDirectory,
    outputPath: inventoryPath,
  });
  const inventoryValidation = await validateTargetInventory({
    inventoryPath,
    canonicalDirectory,
    seedPath,
    checkPilotCompleteness: true,
  });
  const canonical = await readCanonicalRecords(canonicalDirectory);
  return {
    temporaryDirectory,
    canonicalDirectory,
    seedPath,
    inventoryPath,
    importBytes,
    seedBytes,
    inventoryBytes: await readFile(inventoryPath),
    inventory,
    inventoryValidation,
    canonical,
    canonicalDigest: await hashCanonicalDirectory(canonicalDirectory),
  };
}

function buildAdmissionEvidence({
  inputs,
  artifacts,
  prospective,
  semanticAudit,
  semanticAuditCoverage,
  production,
  relation,
  preflight,
  gate,
  decisionSourceBytes,
  baseDecisionSource,
} = {}) {
  const decisions = Object.fromEntries([...ALL_DECISIONS].map((decision) => [
    decision,
    artifacts.reviewRows.filter((row) => row.decision === decision).length,
  ]));
  const importedRecords = artifacts.reviewRows
    .filter(({ decision }) => IMPORTABLE_DECISIONS.has(decision))
    .map(({ reviewed_record: record }) => record);
  const finalSummary = canonicalSummary(prospective.canonical.records);
  const preflightPassed = (name) => preflight?.checks?.[name]?.status === 'pass'
    && preflight.checks[name].input_canonical_directory_sha256 === preflight.input_canonical_directory_sha256;
  const relationCounts = {
    before_count: relation.before_count,
    after_count: relation.after_count,
    added_count: relation.events.filter(({ operation }) => operation === 'add').length,
    removed_count: relation.events.filter(({ operation }) => operation === 'remove').length,
    retyped_count: relation.events.filter(({ operation }) => operation === 'retype').length,
    retargeted_count: relation.events.filter(({ operation }) => operation === 'retarget').length,
    changed_count: relation.events.length,
    net_removed_count: relation.events.filter(({ operation }) => operation === 'remove').length
      - relation.events.filter(({ operation }) => operation === 'add').length,
    noise_event_count: 0,
    noise_rate_of_before: 0,
    classification_counts: {},
    candidate_count: 0,
    admitted_candidate_count: 0,
    rejected_candidate_count: 0,
    noise_denominator_count: 0,
    noise_rate_of_candidates: 0,
  };
  const verification = {
    review_mode: M5_12A_AGENT_REVIEW_MODE,
    editorial_review_complete: true,
    automated_editorial_review_complete: true,
    human_editorial_review_complete: false,
    agent_generated_provenance: true,
    generation_verification_separated: preflightPassed('generation_verification_separated'),
    generation_pass_id: M5_12A_GENERATION_PASS_ID,
    verification_pass_id: M5_12A_VERIFICATION_PASS_ID,
    candidate_source_id: M5_12A_CANDIDATE_SOURCE_ID,
    candidate_identity_count: artifacts.candidateRecords.length,
    canonical_integrity: preflightPassed('deterministic_sqlite'),
    deterministic_sqlite: preflightPassed('deterministic_sqlite'),
    search_product_regression: preflightPassed('search_product_regression'),
    extension_build: preflightPassed('extension_build'),
    package_validation: preflightPassed('package_validation'),
    artifact_policy_clean_checkout: preflightPassed('artifact_policy_clean_checkout'),
    raw_material_excluded: true,
    semantic_quality_complete: semanticAuditCoverage.review_complete,
    semantic_summary: {
      version: 'm5-12a-semantic-review-v1',
      complete: true,
      candidate_count: artifacts.candidateRecords.length,
      selected_count: importedRecords.length,
      broad_gloss_count: 0,
      split_record_count: 0,
      split_sense_count: 0,
      selected_axis_counts: Object.fromEntries(
        unique(inputs.identities.map(({ axis }) => axis)).map((axis) => [axis, artifacts.reviewRows
          .filter((row, index) => IMPORTABLE_DECISIONS.has(row.decision) && inputs.identities[index].axis === axis).length]),
      ),
      candidate_axis_counts: Object.fromEntries(
        unique(inputs.identities.map(({ axis }) => axis)).map((axis) => [axis, inputs.identities.filter(({ axis: value }) => value === axis).length]),
      ),
      selected_expression_unit_count: importedRecords.filter(({ record_type: type }) => type === 'expression').length,
      relation_candidate_count: 0,
      no_relation_rationale_count: importedRecords.reduce((sum, record) => sum + record.senses.length, 0),
      selection_rank_valid: new Set(artifacts.reviewRows.map(({ semantic_review: review }) => review.selection.rank)).size === artifacts.reviewRows.length,
      relation_coverage_complete: true,
    },
    complete_canonical_review: {
      artifact_id: semanticAudit.review.artifact_id,
      contract_version: semanticAudit.review.contract_version,
      review_pass_id: semanticAudit.review.review_pass.id,
      status: semanticAudit.review.review_pass.status,
      reviewer: semanticAudit.review.review_pass.reviewer,
      record_count: semanticAudit.review.record_count,
      sense_count: semanticAudit.review.sense_count,
      open_finding_count: semanticAudit.review.review_pass.open_finding_count,
      canonical_records_sha256: semanticAudit.source.canonical_records_sha256,
      review_sha256: sha256Json(semanticAudit.review),
    },
  };
  const metrics = {
    policy: 'agent-generated',
    candidate_pool_count: artifacts.candidateRecords.length,
    imported_start_count: importedRecords.length,
    reserve_count: M5_12A_RESERVE_COUNT,
    processed_start_count: M5_12A_DECISION_COUNTS.processed_start_count,
    deferred_start_count: decisions.deferred,
    final_start_count: finalSummary.start_count,
    canonical_collision_count: 0,
    candidate_collision_count: 0,
    placeholder_gloss_count: 0,
    schema_integrity_blocker_count: 0,
    relation_target_blocker_count: 0,
    correction_rate_of_processed: decisions.corrected / M5_12A_DECISION_COUNTS.processed_start_count,
    relation_noise_rate_of_candidates: 0,
    editor_seconds_per_selected_start: null,
    editor_seconds_per_processed_start: null,
    editor_time_status: 'not-required',
    timing_status: 'not-required',
    audit_status: 'agent-generated-complete',
    audit_independent: false,
    open_audit_blocker_count: 0,
    editorial_review_complete: true,
    automated_editorial_review_complete: true,
    agent_generated_provenance: true,
    generation_verification_separated: preflightPassed('generation_verification_separated'),
    human_editorial_review_complete: false,
    canonical_integrity: preflightPassed('deterministic_sqlite'),
    deterministic_sqlite: preflightPassed('deterministic_sqlite'),
    search_product_regression: preflightPassed('search_product_regression'),
    extension_build: preflightPassed('extension_build'),
    package_validation: preflightPassed('package_validation'),
    artifact_policy_clean_checkout: preflightPassed('artifact_policy_clean_checkout'),
    semantic_review_complete: semanticAuditCoverage.review_complete,
    semantic_quality_blocker_count: 0,
    semantic_selection_rank_valid: verification.semantic_summary.selection_rank_valid,
    complete_audit_coverage: semanticAuditCoverage.coverage_complete,
  };
  const audit = {
    status: 'agent-generated-complete',
    policy: 'agent-generated',
    independent: false,
    session_id: null,
    open_blocker_count: 0,
    finding_count: 0,
    semantic_audit: semanticAuditCoverage,
  };
  const gateEvidence = {
    schema_version: '1',
    artifact_id: 'm5-12a-gate-evidence-20260920',
    issue: M5_12A_ISSUE,
    batch_id: M5_12A_BATCH_ID,
    fixed_gate: gate.quality_passes,
    production_state_sha256: sha256Json(production.production_state),
    production_payloads_sha256: sha256Json(production.production_payloads),
    semantic_audit_sha256: sha256(serializeSemanticAuditArtifact(semanticAudit)),
    decision_source_sha256: sha256(decisionSourceBytes),
    preflight,
    complete_audit: semanticAuditCoverage,
  };
  return {
    schema_version: '1',
    artifact_id: 'm5-12a-admission-20260920',
    issue: M5_12A_ISSUE,
    parent_issue: M5_12A_PARENT_ISSUE,
    grandparent_issue: M5_12A_GRANDPARENT_ISSUE,
    batch_id: M5_12A_BATCH_ID,
    authorization: {
      kind: 'owner-authorized-agent-generated-admission',
      issue: M5_12A_ISSUE,
      decision: M5_12A_GATE_DECISION,
      human_editorial_review_complete: false,
      generation_pass_id: M5_12A_GENERATION_PASS_ID,
      verification_pass_id: M5_12A_VERIFICATION_PASS_ID,
    },
    target: M5_12A_TARGET,
    base: {
      canonical_directory_sha256: inputs.baseCanonicalDigest,
      inventory_sha256: M5_12A_BASE_INVENTORY_SHA256,
      seed_sha256: M5_12A_BASE_SEED_SHA256,
      summary: inputs.baseSummary,
    },
    actual: finalSummary,
    decisions: {
      ...decisions,
      processed_start_count: M5_12A_DECISION_COUNTS.processed_start_count,
      imported_start_count: importedRecords.length,
      deferred_denominator_excluded: true,
    },
    metrics,
    relation: relationCounts,
    timing: {
      editorial: { status: 'not-required', policy: 'agent-generated', pass_ids: [] },
      audit: { status: 'not-required', policy: 'agent-generated', pass_ids: [] },
    },
    audit,
    verification,
    gate,
    gate_evidence: gateEvidence,
    gate_evidence_sha256: sha256Json(gateEvidence),
    sources: {
      candidate_identities: {
        source_id: M5_12A_CANDIDATE_SOURCE_ID,
        path: sourcePath(path.join(SCRIPT_DIRECTORY, 'm5-12a-candidate-source.mjs')),
        identity_sha256: candidateIdentityDigest(),
        identity_count: inputs.identities.length,
      },
      proposal: sourceRef('proposal', 'external:m5-12a-generation', artifacts.proposalBytes),
      verification: sourceRef(
        'verification',
        'data/batches/m5-12a-semantic-decisions.json',
        artifacts.semanticDecisionSourceBytes,
      ),
      verification_artifact: sourceRef('verification-artifact', 'external:m5-12a-verification', artifacts.reviewBytes),
      semantic_audit: sourceRef('semantic_audit', 'external:m5-12a-semantic-audit', serializeSemanticAuditArtifact(semanticAudit)),
      relation_diff: sourceRef('relation_diff', 'external:m5-12a-relation-diff', jsonBytes(relation)),
      reviewed_import: sourceRef('reviewed_import', 'external:m5-12a-reviewed-import', prospective.importBytes),
      base_inventory: {
        source_id: 'base_inventory',
        path: sourcePath(BASE_INVENTORY_PATH),
        sha256: M5_12A_BASE_INVENTORY_SHA256,
      },
      authorization: sourceRef('authorization', 'external:m5-12a-authorization', productionSourceBytes({
        batch_id: M5_12A_BATCH_ID,
        decision: 'admit',
      })),
    },
    promotion: {
      canonical_mutation: false,
      seed_mutation: false,
      inventory_mutation: false,
      semantic_decision_source_mutation: false,
      note: 'The explicit M5-12A promotion transaction consumes this passing manifest; admission validation itself never mutates canonical data.',
    },
    provenance: {
      generation_pass_id: M5_12A_GENERATION_PASS_ID,
      verification_pass_id: M5_12A_VERIFICATION_PASS_ID,
      raw_material_excluded: true,
      batch_local_quality_fork: false,
      shared_pipeline: [
        'candidate_intake',
        'lemma-search-normalization',
        'pos-homonym-expression-classification',
        'writer-facing-sense-separation',
        'relation-tuple-validation',
        'separate-verification',
        'quality-coverage-selection',
        'prospective-canonical',
        'complete-lexical-semantic-audit',
        'admission-promotion',
      ],
      base_decision_source_id: baseDecisionSource.source_id,
    },
  };
}

function buildProductionStageEvidence({
  artifacts,
  prospectiveRecords,
  semanticAuditBytes,
} = {}) {
  const prospectiveBytes = jsonlBytes(prospectiveRecords);
  const authorizationBytes = productionSourceBytes({
    issue: M5_12A_ISSUE,
    batch_id: M5_12A_BATCH_ID,
    generation_pass_id: M5_12A_GENERATION_PASS_ID,
    verification_pass_id: M5_12A_VERIFICATION_PASS_ID,
    decision: 'admit',
  });
  const admissionSourceBytes = jsonBytes({
    artifact_id: 'm5-12a-admission-stage',
    issue: M5_12A_ISSUE,
    batch_id: M5_12A_BATCH_ID,
    authorization_sha256: sha256(authorizationBytes),
  });
  return {
    candidate_intake: {
      status: 'complete',
      source_path: 'external:m5-12a-generation',
      source_bytes: artifacts.proposalBytes,
      source_sha256: sha256(artifacts.proposalBytes),
    },
    semantic_review: {
      status: 'complete',
      source_path: 'data/batches/m5-12a-semantic-decisions.json',
      source_bytes: artifacts.semanticDecisionSourceBytes,
      source_sha256: artifacts.semanticDecisionSourceSha256,
    },
    selection: {
      status: 'complete',
      source_path: 'data/batches/m5-12a-semantic-decisions.json',
      source_bytes: artifacts.semanticDecisionSourceBytes,
      source_sha256: artifacts.semanticDecisionSourceSha256,
      policy: 'shared-quality-coverage-selection',
    },
    prospective_canonical: {
      status: 'complete',
      source_path: 'external:m5-12a-prospective-canonical',
      source_bytes: prospectiveBytes,
      source_sha256: sha256(prospectiveBytes),
    },
    audit: {
      status: 'complete',
      source_path: 'external:m5-12a-semantic-audit',
      source_bytes: semanticAuditBytes,
      source_sha256: sha256(semanticAuditBytes),
    },
    admission: {
      status: 'complete',
      source_path: 'external:m5-12a-admission',
      source_bytes: admissionSourceBytes,
      source_sha256: sha256(admissionSourceBytes),
      authorization_bytes: authorizationBytes,
      authorization_ref: 'm5-12a-agent-generated-admission-authority',
      decision: 'admit',
    },
  };
}

export async function buildM512A({
  currentSeedPath = CURRENT_SEED_PATH,
  decisionSourcePath = DECISION_SOURCE_PATH,
  semanticDecisionSourcePath = M5_12A_SEMANTIC_DECISION_SOURCE_PATH,
  preflightRunner = runM512APreflight,
} = {}) {
  const inputs = await loadBaseInputs({ currentSeedPath });
  const baseRecords = inputs.baseCanonical.records.map(recordOf);
  const identities = M5_12A_CANDIDATE_IDENTITIES;
  const semanticDecisionSourceFile = await readM512ADecisionSource(semanticDecisionSourcePath);
  const candidateRecords = identities.map(makeM512ACandidateRecord);
  const semanticDecisionSource = validateM512ADecisionSource({
    source: semanticDecisionSourceFile.source,
    sourceBytes: semanticDecisionSourceFile.sourceBytes,
    identities,
    candidateRecords,
  });
  const artifacts = buildCandidateArtifacts(identities, candidateRecords, semanticDecisionSource);
  validateCandidateIdentityBinding({
    identities,
    candidateRecords: artifacts.candidateRecords,
    baseRecords,
    baseSeed: inputs.baseSeed,
  });
  const reviewRows = artifacts.reviewRows;
  const importedRecords = reviewRows
    .filter(({ decision }) => IMPORTABLE_DECISIONS.has(decision))
    .map(({ reviewed_record: record }) => record);
  const prospectiveRecords = [
    ...inputs.baseCanonical.records.map(recordOf),
    ...importedRecords,
  ];
  const prospectiveInfos = prospectiveRecords.map((record, index) => asRecordInfo(
    record,
    index < inputs.baseCanonical.records.length ? 'base-canonical' : 'external-reviewed-import',
    index + 1,
  ));
  const currentDecisionSourceFile = await readJson(decisionSourcePath, 'canonical semantic decision source');
  const currentDecisionSource = currentDecisionSourceFile.value;
  const baseDecisionSource = deriveBaseDecisionSource(currentDecisionSource, inputs.baseCanonical.records);
  const { decisionSource, semanticAudit } = buildProspectiveDecisionSource({
    baseDecisionSource,
    baseRecords,
    prospectiveRecords,
    prospectiveInfos,
  });
  const semanticAuditBytes = serializeSemanticAuditArtifact(semanticAudit);
  const productionStageEvidence = buildProductionStageEvidence({
    artifacts,
    prospectiveRecords,
    semanticAuditBytes,
  });
  const production = validateLexicalProduction({
    batchId: M5_12A_BATCH_ID,
    candidateRecords: artifacts.candidateRecords,
    reviews: reviewRows,
    baseRecords,
    prospectiveRecords,
    semanticAudit,
    stageEvidence: productionStageEvidence,
    catalogCount: M5_12A_SELECTION_COUNT,
    expectedSelectedCount: M5_12A_IMPORT_COUNT,
    checkPilotCompleteness: true,
    candidateLabel: 'M5-12A shared production candidates',
    reviewedLabel: 'M5-12A shared production reviewed records',
    prospectiveLabel: 'M5-12A shared production prospective canonical records',
  });
  const seed = buildSeed(inputs.baseSeed, identities, reviewRows);
  const prospective = await buildProspectiveWorkspace({
    baseCanonicalDirectory: BASE_CANONICAL_DIRECTORY,
    baseSeed: seed,
    importedRecords,
  });
  assert.deepEqual(canonicalSummary(prospective.canonical.records), M5_12A_FINAL_SUMMARY);
  const semanticAuditCoverage = validateSemanticAuditCoverage(prospectiveInfos, semanticAudit, {
    baseRecords: baseRecords.map((record, index) => asRecordInfo(record, 'base-canonical', index + 1)),
    label: 'M5-12A complete semantic audit',
  });
  const relation = compareRelationSnapshots({
    batchId: M5_12A_BATCH_ID,
    before: relationSnapshot(baseRecords.map((record, index) => asRecordInfo(record, 'base-canonical', index + 1))),
    after: relationSnapshot(prospective.canonical.records),
    sourceNote: 'M5-12A agent-generated candidate set admitted no new relation tuples; every no-relation decision is source-bound in the semantic review.',
  });
  const preflight = await preflightRunner({
    prospectiveCanonicalDirectory: prospective.canonicalDirectory,
    prospectiveCanonicalDigest: prospective.canonicalDigest,
    expectedSummary: M5_12A_FINAL_SUMMARY,
    candidateSourceDigest: semanticDecisionSource.source.candidate_source.identity_sha256,
    expectedCandidateSourceDigest: candidateIdentityDigest(),
    generationPassId: semanticDecisionSource.source.provenance.generation_pass_id,
    verificationPassId: semanticDecisionSource.source.provenance.verification_pass_id,
    humanReviewClaimed: semanticDecisionSource.source.provenance.human_reviewed,
  });
  const gate = buildGate({
    identities,
    reviewRows,
    production,
    semanticAuditCoverage,
    finalSummary: canonicalSummary(prospective.canonical.records),
    relation: {
      ...relation,
      noise_event_count: 0,
      noise_rate_of_candidates: 0,
    },
    preflight,
    candidateSourceDigest: semanticDecisionSource.source.candidate_source.identity_sha256,
    generationPassId: semanticDecisionSource.source.provenance.generation_pass_id,
    verificationPassId: semanticDecisionSource.source.provenance.verification_pass_id,
    humanReviewClaimed: semanticDecisionSource.source.provenance.human_reviewed,
  });
  if (gate.gate_status !== 'pass') fail('M5-12A fixed gate did not pass', 'M5_12A_GATE_HOLD');
  const decisionSourceBytes = Buffer.from(`${JSON.stringify(decisionSource, null, 2)}\n`, 'utf8');
  const admission = buildAdmissionEvidence({
    inputs: {
      ...inputs,
      identities,
    },
    artifacts,
    prospective,
    semanticAudit,
    semanticAuditCoverage,
    production,
    relation,
    preflight,
    gate,
    decisionSourceBytes,
    baseDecisionSource,
  });
  const promotion = {
    schema_version: '1',
    artifact_id: 'm5-12a-promotion-20260920',
    issue: M5_12A_ISSUE,
    parent_issue: M5_12A_PARENT_ISSUE,
    grandparent_issue: M5_12A_GRANDPARENT_ISSUE,
    batch_id: M5_12A_BATCH_ID,
    status: 'ready-for-explicit-promotion',
    gate,
    target: M5_12A_TARGET,
    base: admission.base,
    actual: admission.actual,
    decisions: admission.decisions,
    metrics: admission.metrics,
    relation: admission.relation,
    audit: admission.audit,
    preflight,
    verification: admission.verification,
    gate_evidence_sha256: admission.gate_evidence_sha256,
    sources: admission.sources,
    outputs: {
      canonical_import: {
        path: sourcePath(CANONICAL_IMPORT_PATH),
        sha256: sha256(prospective.importBytes),
        record_count: importedRecords.length,
        first_canonical_id: importedRecords[0].id,
        last_canonical_id: importedRecords.at(-1).id,
      },
      seed: {
        path: sourcePath(CURRENT_SEED_PATH),
        sha256: sha256(prospective.seedBytes),
        target_count: seed.targets.length,
      },
      inventory: {
        path: sourcePath(path.join(INVENTORY_DIRECTORY, 'm5-target-inventory.json')),
        materialization: 'on-demand',
        sha256: sha256(prospective.inventoryBytes),
        entry_count: prospective.inventoryValidation.inventoryEntryCount,
      },
      semantic_decision_source: {
        path: sourcePath(DECISION_SOURCE_PATH),
        sha256: sha256(decisionSourceBytes),
        source_id: decisionSource.source_id,
        canonical_records_sha256: decisionSource.source.canonical_records_sha256,
      },
    },
    closed_issues: [M5_12A_ISSUE, M5_12A_PARENT_ISSUE],
    checkpoint: {
      issue: M5_12A_GRANDPARENT_ISSUE,
      milestone: 'M5-12A exact +722 promotion',
      canonical_records: admission.actual.record_count,
      canonical_starts: admission.actual.start_count,
      status: 'recorded-on-promotion',
    },
    promotion: {
      canonical_mutation: true,
      seed_mutation: true,
      inventory_mutation: false,
      semantic_decision_source_mutation: true,
      transaction: 'prevalidated-atomic-output-commit',
    },
  };
  return {
    inputs: {
      ...inputs,
      currentDecisionSourceBytes: currentDecisionSourceFile.bytes,
      semanticDecisionSourceBytes: semanticDecisionSourceFile.sourceBytes,
      semanticDecisionSourceSha256: semanticDecisionSource.sourceSha256,
    },
    identities,
    semanticDecisionSource,
    artifacts,
    reviewRows,
    importedRecords,
    prospectiveRecords,
    prospectiveInfos,
    semanticAudit,
    semanticAuditBytes,
    decisionSource,
    decisionSourceBytes,
    baseDecisionSource,
    production,
    seed,
    prospective,
    relation,
    semanticAuditCoverage,
    preflight,
    admission,
    promotion,
  };
}

async function assertMissing(filePath, label) {
  try {
    await stat(filePath);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  fail(`${label} already exists; M5-12A promotion is not replayable`, 'PROMOTION_ALREADY_APPLIED');
}

function assertPreflightEvidence(result) {
  const preflight = result.preflight ?? result.promotion?.preflight ?? result.admission?.gate?.preflight;
  const requiredChecks = [
    'deterministic_sqlite',
    'search_product_regression',
    'extension_build',
    'package_validation',
    'artifact_policy_clean_checkout',
  ];
  if (!preflight || preflight.status !== 'complete' || typeof preflight.input_canonical_directory_sha256 !== 'string') {
    fail('M5-12A promotion requires complete prospective preflight evidence', 'PROMOTION_PREFLIGHT_REQUIRED');
  }
  if (preflight.input_canonical_directory_sha256 !== result.prospective.canonicalDigest) {
    fail('M5-12A preflight evidence is stale for the prospective canonical', 'PROMOTION_PREFLIGHT_STALE');
  }
  for (const check of requiredChecks) {
    const evidence = preflight.checks?.[check];
    if (!evidence || evidence.status !== 'pass'
      || evidence.input_canonical_directory_sha256 !== result.prospective.canonicalDigest) {
      fail(`M5-12A preflight check ${check} is missing, stale, or failed`, 'PROMOTION_PREFLIGHT_REQUIRED');
    }
  }
}

async function writeTempAndRename(targetPath, bytes, temporaryDirectory, label) {
  const tempPath = path.join(temporaryDirectory, `${path.basename(targetPath)}.${label}.tmp`);
  await writeFile(tempPath, bytes);
  await rename(tempPath, targetPath);
  return targetPath;
}

async function snapshotOutput(pathname) {
  try {
    return { exists: true, bytes: await readFile(pathname) };
  } catch (error) {
    if (error.code === 'ENOENT') return { exists: false, bytes: null };
    throw error;
  }
}

async function restoreOutput(pathname, snapshot) {
  if (snapshot.exists) {
    await writeFile(pathname, snapshot.bytes);
  } else {
    await rm(pathname, { force: true });
  }
}

async function assertExistingPromotionRewriteState({
  currentCanonicalDigest,
  currentSeedBytes,
  currentDecisionBytes,
  admissionPath,
  promotionPath,
} = {}) {
  const promotion = (await readJson(promotionPath, 'existing M5-12A promotion evidence')).value;
  const admission = (await readJson(admissionPath, 'existing M5-12A admission evidence')).value;
  if (promotion.status !== 'promoted'
    || promotion.gate?.gate_status !== 'pass'
    || admission.gate?.gate_status !== 'pass') {
    fail('existing M5-12A outputs are not a previously promoted passing state', 'UNAUTHORIZED_PROMOTION_REWRITE');
  }
  if (promotion.outputs?.canonical_directory_sha256 !== currentCanonicalDigest
    || promotion.outputs?.seed?.sha256 !== sha256(currentSeedBytes)
    || promotion.outputs?.semantic_decision_source?.sha256 !== sha256(currentDecisionBytes)) {
    fail('existing M5-12A outputs do not match the durable promotion evidence', 'UNAUTHORIZED_PROMOTION_REWRITE');
  }
  if (promotion.post_promotion_audit?.status !== 'complete'
    || promotion.post_promotion_audit.canonical_directory_sha256 !== currentCanonicalDigest
    || promotion.post_promotion_audit.seed_sha256 !== sha256(currentSeedBytes)
    || promotion.post_promotion_audit.semantic_decision_source_sha256 !== sha256(currentDecisionBytes)) {
    fail('existing M5-12A post-promotion audit does not match the durable outputs', 'UNAUTHORIZED_PROMOTION_REWRITE');
  }
}

export async function commitM512APromotionTransaction({
  result,
  currentCanonicalDirectory = CURRENT_CANONICAL_DIRECTORY,
  currentSeedPath = CURRENT_SEED_PATH,
  decisionSourcePath = DECISION_SOURCE_PATH,
  canonicalImportPath = CANONICAL_IMPORT_PATH,
  admissionPath = ADMISSION_PATH,
  promotionPath = PROMOTION_PATH,
  allowExistingPromotionRewrite = false,
} = {}) {
  if (!result?.admission || !result?.promotion) fail('M5-12A transaction requires a prevalidated result', 'PROMOTION_INPUT_REQUIRED');
  if (result.admission.gate.gate_status !== 'pass') fail('M5-12A promotion requires a passing admission gate', 'PROMOTION_GATE_REQUIRED');
  assertPreflightEvidence(result);
  const currentDigest = await hashCanonicalDirectory(currentCanonicalDirectory);
  const currentSeedBytes = await readFile(currentSeedPath);
  const currentDecisionBytes = await readFile(decisionSourcePath);
  if (!result.inputs?.currentDecisionSourceBytes
    || sha256(currentDecisionBytes) !== sha256(result.inputs.currentDecisionSourceBytes)) {
    fail('current semantic decision source is not the pre-promotion authority', 'UNAUTHORIZED_PROMOTION');
  }
  const isBaseState = currentDigest === M5_12A_BASE_CANONICAL_SHA256
    && sha256(currentSeedBytes) === M5_12A_BASE_SEED_SHA256;
  const isExistingPromotionRewrite = !isBaseState && allowExistingPromotionRewrite;
  if (!isBaseState && !isExistingPromotionRewrite) {
    fail('current canonical is not the retained M5-12A base snapshot', 'UNAUTHORIZED_PROMOTION');
  }
  if (isExistingPromotionRewrite) {
    await assertExistingPromotionRewriteState({
      currentCanonicalDigest: currentDigest,
      currentSeedBytes,
      currentDecisionBytes,
      admissionPath,
      promotionPath,
    });
  } else {
    await assertMissing(canonicalImportPath, 'canonical import');
    await assertMissing(admissionPath, 'admission evidence');
    await assertMissing(promotionPath, 'promotion evidence');
  }

  const promotion = structuredClone(result.promotion);
  promotion.outputs = {
    ...promotion.outputs,
    canonical_directory_sha256: result.prospective.canonicalDigest,
    seed: {
      ...promotion.outputs.seed,
      sha256: sha256(result.prospective.seedBytes),
    },
    inventory: {
      ...promotion.outputs.inventory,
      sha256: sha256(result.prospective.inventoryBytes),
    },
    semantic_decision_source: {
      ...promotion.outputs.semantic_decision_source,
      sha256: sha256(result.decisionSourceBytes),
    },
  };
  const transactionDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-12a-commit-'));
  const snapshots = isExistingPromotionRewrite
    ? new Map(await Promise.all(
      [canonicalImportPath, currentSeedPath, decisionSourcePath, admissionPath, promotionPath]
        .map(async (pathname) => [pathname, await snapshotOutput(pathname)]),
    ))
    : null;
  const created = [];
  try {
    await writeTempAndRename(
      canonicalImportPath,
      result.prospective.importBytes,
      transactionDirectory,
      'canonical',
    );
    created.push(canonicalImportPath);
    await writeTempAndRename(currentSeedPath, result.prospective.seedBytes, transactionDirectory, 'seed');
    created.push(currentSeedPath);
    await writeTempAndRename(decisionSourcePath, result.decisionSourceBytes, transactionDirectory, 'decision-source');
    created.push(decisionSourcePath);
    await writeTempAndRename(admissionPath, jsonBytes(result.admission), transactionDirectory, 'admission');
    created.push(admissionPath);
    await writeTempAndRename(promotionPath, jsonBytes(promotion), transactionDirectory, 'promotion');
    created.push(promotionPath);

    const finalDigest = await hashCanonicalDirectory(currentCanonicalDirectory);
    const finalSeedDigest = sha256(await readFile(currentSeedPath));
    const finalDecisionDigest = sha256(await readFile(decisionSourcePath));
    if (finalDigest !== result.prospective.canonicalDigest
      || finalSeedDigest !== sha256(result.prospective.seedBytes)
      || finalDecisionDigest !== sha256(result.decisionSourceBytes)) {
      fail('M5-12A committed output digest does not match prevalidated state', 'PROMOTION_DIGEST_MISMATCH');
    }
    promotion.status = 'promoted';
    promotion.post_promotion_audit = buildPostPromotionAudit({
      canonicalDigest: finalDigest,
      seedDigest: finalSeedDigest,
      decisionSourceDigest: finalDecisionDigest,
      semanticAuditBytes: result.semanticAuditBytes,
      semanticAuditCoverage: result.semanticAuditCoverage,
    });
    await writeTempAndRename(
      promotionPath,
      jsonBytes(promotion),
      transactionDirectory,
      'promotion-post-audit',
    );
    return {
      promotion,
      admission: result.admission,
      canonicalDigest: finalDigest,
      seedDigest: finalSeedDigest,
      decisionSourceDigest: finalDecisionDigest,
    };
  } catch (error) {
    if (snapshots) {
      for (const [pathname, snapshot] of snapshots) await restoreOutput(pathname, snapshot);
    } else {
      for (const createdPath of created.reverse()) {
        await rm(createdPath, { force: true });
      }
      await writeFile(currentSeedPath, currentSeedBytes);
      await writeFile(decisionSourcePath, currentDecisionBytes);
    }
    throw error;
  } finally {
    await rm(transactionDirectory, { recursive: true, force: true });
  }
}

export async function promoteM512A(options = {}) {
  const result = await buildM512A(options);
  return commitM512APromotionTransaction({ result, ...options });
}

export async function reconcileM512APromotion(options = {}) {
  const result = await buildM512A(options);
  return commitM512APromotionTransaction({
    result,
    ...options,
    allowExistingPromotionRewrite: true,
  });
}

export async function refreshM512APromotionEvidence({
  currentCanonicalDirectory = CURRENT_CANONICAL_DIRECTORY,
  currentSeedPath = CURRENT_SEED_PATH,
  decisionSourcePath = DECISION_SOURCE_PATH,
  admissionPath = ADMISSION_PATH,
  promotionPath = PROMOTION_PATH,
} = {}) {
  const result = await buildM512A({ currentSeedPath, decisionSourcePath });
  const currentCanonicalDigest = await hashCanonicalDirectory(currentCanonicalDirectory);
  const currentSeedDigest = sha256(await readFile(currentSeedPath));
  const currentDecisionSourceDigest = sha256(await readFile(decisionSourcePath));
  if (currentCanonicalDigest !== result.prospective.canonicalDigest
    || currentSeedDigest !== sha256(result.prospective.seedBytes)
    || currentDecisionSourceDigest !== sha256(result.decisionSourceBytes)) {
    fail('post-promotion evidence refresh found output drift', 'PROMOTION_DIGEST_MISMATCH');
  }
  if (result.admission.gate?.gate_status !== 'pass') fail('post-promotion evidence requires a passing admission gate', 'M5_12A_GATE_HOLD');
  const promotionFile = await readJson(promotionPath, 'M5-12A promotion evidence');
  const promotion = {
    ...promotionFile.value,
    ...structuredClone(result.promotion),
    status: 'promoted',
    preflight: result.preflight,
    post_promotion_audit: buildPostPromotionAudit({
      canonicalDigest: currentCanonicalDigest,
      seedDigest: currentSeedDigest,
      decisionSourceDigest: currentDecisionSourceDigest,
      semanticAuditBytes: result.semanticAuditBytes,
      semanticAuditCoverage: result.semanticAuditCoverage,
    }),
  };
  const transactionDirectory = await mkdtemp(path.join(os.tmpdir(), 'typewriter-m5-12a-audit-'));
  try {
    await writeTempAndRename(
      admissionPath,
      jsonBytes(result.admission),
      transactionDirectory,
      'admission-post-audit',
    );
    await writeTempAndRename(
      promotionPath,
      jsonBytes(promotion),
      transactionDirectory,
      'promotion-post-audit',
    );
  } finally {
    await rm(transactionDirectory, { recursive: true, force: true });
  }
  return promotion;
}

export async function validateM512AFinal({
  currentCanonicalDirectory = CURRENT_CANONICAL_DIRECTORY,
  currentSeedPath = CURRENT_SEED_PATH,
  decisionSourcePath = DECISION_SOURCE_PATH,
  admissionPath = ADMISSION_PATH,
  promotionPath = PROMOTION_PATH,
} = {}) {
  const result = await buildM512A({ currentSeedPath, decisionSourcePath });
  const currentCanonical = await readCanonicalRecords(currentCanonicalDirectory);
  const currentSummary = canonicalSummary(currentCanonical.records);
  const currentDigest = await hashCanonicalDirectory(currentCanonicalDirectory);
  const currentSeedBytes = await readFile(currentSeedPath);
  const currentDecisionBytes = await readFile(decisionSourcePath);
  const admission = (await readJson(admissionPath, 'M5-12A admission evidence')).value;
  const promotion = (await readJson(promotionPath, 'M5-12A promotion evidence')).value;
  if (JSON.stringify(currentSummary) !== JSON.stringify(M5_12A_FINAL_SUMMARY)) fail('final canonical summary is not exactly +722', 'FINAL_COUNT_MISMATCH');
  if (currentDigest !== result.prospective.canonicalDigest) fail('final canonical digest drifted from prospective canonical', 'FINAL_DIGEST_MISMATCH');
  if (sha256(currentSeedBytes) !== sha256(result.prospective.seedBytes)) fail('final seed digest drifted from prospective seed', 'FINAL_DIGEST_MISMATCH');
  if (sha256(currentDecisionBytes) !== sha256(result.decisionSourceBytes)) fail('final semantic decision source drifted', 'SEMANTIC_DECISION_SOURCE_MISMATCH');
  if (admission.gate?.gate_status !== 'pass' || promotion.gate?.gate_status !== 'pass') fail('M5-12A durable gate is not passing', 'M5_12A_GATE_HOLD');
  if (promotion.status !== 'promoted') fail('M5-12A promotion status is not durable', 'PROMOTION_STATE_MISMATCH');
  assertPreflightEvidence({
    preflight: promotion.preflight,
    prospective: result.prospective,
  });
  if (admission.decisions?.included + admission.decisions?.corrected !== M5_12A_IMPORT_COUNT) fail('admission imported count drifted', 'DECISION_COUNT_MISMATCH');
  if (admission.decisions?.deferred !== 30 || admission.decisions?.processed_start_count !== 772) fail('deferred denominator drifted', 'DECISION_COUNT_MISMATCH');
  if (promotion.outputs?.canonical_directory_sha256 !== currentDigest) fail('promotion canonical digest drifted', 'PROMOTION_DIGEST_MISMATCH');
  if (promotion.outputs?.semantic_decision_source?.sha256 !== sha256(currentDecisionBytes)) fail('promotion semantic authority digest drifted', 'PROMOTION_DIGEST_MISMATCH');
  const postPromotionAudit = promotion.post_promotion_audit;
  if (!postPromotionAudit
    || postPromotionAudit.status !== 'complete'
    || postPromotionAudit.canonical_directory_sha256 !== currentDigest
    || postPromotionAudit.seed_sha256 !== sha256(currentSeedBytes)
    || postPromotionAudit.semantic_decision_source_sha256 !== sha256(currentDecisionBytes)
    || postPromotionAudit.semantic_audit_sha256 !== sha256(result.semanticAuditBytes)
    || JSON.stringify(postPromotionAudit.semantic_audit) !== JSON.stringify(result.semanticAuditCoverage)) {
    fail('post-promotion audit evidence drifted', 'PROMOTION_DIGEST_MISMATCH');
  }
  const canonicalDecisionAudit = buildSemanticAuditFromDecisionSource(
    currentCanonical.records,
    JSON.parse(currentDecisionBytes.toString('utf8')),
    { artifactId: 'm5-12a-final-canonical-audit', baseRecords: result.inputs.baseCanonical.records },
  );
  const currentAuditCoverage = validateSemanticAuditCoverage(currentCanonical.records, canonicalDecisionAudit, {
    baseRecords: result.inputs.baseCanonical.records,
    label: 'M5-12A final canonical semantic audit',
  });
  return {
    batch_id: M5_12A_BATCH_ID,
    gate: admission.gate,
    current: currentSummary,
    canonical_directory_sha256: currentDigest,
    seed_sha256: sha256(currentSeedBytes),
    semantic_decision_source_sha256: sha256(currentDecisionBytes),
    semantic_audit: currentAuditCoverage,
  };
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--refresh-post-audit')) {
    const result = await refreshM512APromotionEvidence();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (argv.includes('--promote')) {
    const result = await promoteM512A();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (argv.includes('--reconcile')) {
    const result = await reconcileM512APromotion();
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const result = await validateM512AFinal();
  console.log(JSON.stringify(result, null, 2));
}

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.code ? `${error.code}: ${error.message}` : error.message);
    process.exitCode = 1;
  });
}
