import { createHash } from 'node:crypto';
import { createRequire as createModuleRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  M5_10A_PROCESS_REVISION,
  M5_10A_SENSE_BOUNDARY_IDS,
} from './validate-batch.mjs';

const require = createModuleRequire(import.meta.url);
const EDITORIAL_SCHEMA = require('../../schema/m5-10a-wave-a2-editorial-input.schema.json');
const AUDIT_SCHEMA = require('../../schema/m5-10a-wave-a2-audit-input.schema.json');
const EDITORIAL_DECISIONS_SCHEMA = require('../../schema/m5-10a-wave-a2-editorial-decisions.schema.json');
const AUDIT_DECISIONS_SCHEMA = require('../../schema/m5-10a-wave-a2-audit-decisions.schema.json');
const TIMING_SCHEMA = require('../../schema/m5-10a-wave-a2-timing-input.schema.json');
const PROVENANCE_SCHEMA = require('../../schema/m5-10a-wave-a2-provenance-artifact.schema.json');

const schemaOptions = {
  allErrors: true,
  formats: {
    'date-time': {
      type: 'string',
      validate: (value) => Number.isFinite(Date.parse(value)),
    },
  },
};
const editorialSchemaValidator = new Ajv2020(schemaOptions).compile(EDITORIAL_SCHEMA);
const auditSchemaValidator = new Ajv2020(schemaOptions).compile(AUDIT_SCHEMA);
const editorialDecisionsSchemaValidator = new Ajv2020(schemaOptions).compile(EDITORIAL_DECISIONS_SCHEMA);
const auditDecisionsSchemaValidator = new Ajv2020(schemaOptions).compile(AUDIT_DECISIONS_SCHEMA);
const timingSchemaValidator = new Ajv2020(schemaOptions).compile(TIMING_SCHEMA);
const provenanceSchemaValidator = new Ajv2020(schemaOptions).compile(PROVENANCE_SCHEMA);

const VERIFIED_SOURCE_KINDS = Object.freeze(['human-authored', 'codex-authored']);
const VERIFIED_ACTOR_KINDS = Object.freeze(['human', 'codex']);

export const A2_BATCH_ID = 'm5-10-wave-a2-20260909';
export const A2_INVENTORY_ID = 'm5-core-5k';
export const A2_INVENTORY_REVISION = 'm5-10';
export const A2_TIMING_PASS_IDS = Object.freeze([
  'target-preparation',
  'initial-review',
  'feedback-fixes',
  'final-audit',
  'held-rejected',
]);
export const A2_AUDIT_TIMING_PASS_IDS = Object.freeze(['post-freeze-audit']);
export const A2_PROMOTED_RECORD_REVIEWS = Object.freeze(
  Array.from({ length: 50 }, (_, index) => ({
    inventory_id: `m5-${String(index + 307).padStart(3, '0')}`,
    canonical_id: `w${index + 579}`,
  })),
);
export const A2_BUFFER_INVENTORY_IDS = Object.freeze(
  Array.from({ length: 8 }, (_, index) => `m5-${String(index + 357).padStart(3, '0')}`),
);
export const A2_SELECTED_INVENTORY_IDS = Object.freeze([
  ...A2_PROMOTED_RECORD_REVIEWS.map(({ inventory_id: inventoryId }) => inventoryId),
  ...A2_BUFFER_INVENTORY_IDS,
]);
export const A2_PROMOTED_CANONICAL_IDS = Object.freeze(
  A2_PROMOTED_RECORD_REVIEWS.map(({ canonical_id: canonicalId }) => canonicalId),
);
export const A2_MIN_EDITOR_SECONDS_PER_UNIT = 0.5;
export const A2_TIMING_WORK_UNIT_CONTRACT = Object.freeze({
  'target-preparation': Object.freeze({
    unit_kind: 'selected-target',
    unit_ids: Object.freeze([...A2_SELECTED_INVENTORY_IDS]),
  }),
  'initial-review': Object.freeze({
    unit_kind: 'boundary-check',
    unit_ids: Object.freeze(
      A2_PROMOTED_RECORD_REVIEWS.flatMap(({ inventory_id: inventoryId }) => (
        M5_10A_SENSE_BOUNDARY_IDS.map((boundaryId) => `${inventoryId}:${boundaryId}`)
      )),
    ),
  }),
  'feedback-fixes': Object.freeze({
    unit_kind: 'sense-correction',
    unit_ids: Object.freeze([...A2_PROMOTED_CANONICAL_IDS.filter((canonicalId) => [
      'w582', 'w588', 'w595', 'w598', 'w599', 'w603', 'w604', 'w606', 'w609',
      'w617', 'w618', 'w619', 'w620', 'w621', 'w622', 'w628',
    ].includes(canonicalId))]),
  }),
  'final-audit': Object.freeze({
    unit_kind: 'final-audit-item',
    unit_ids: Object.freeze([
      ...A2_PROMOTED_CANONICAL_IDS,
      ...Array.from({ length: 6 }, (_, index) => `m5-10-wave-a2-rel-00${index + 1}`),
    ]),
  }),
  'held-rejected': Object.freeze({
    unit_kind: 'buffer-decision',
    unit_ids: Object.freeze([...A2_BUFFER_INVENTORY_IDS]),
  }),
  'post-freeze-audit': Object.freeze({
    unit_kind: 'post-freeze-audit-item',
    unit_ids: Object.freeze([
      ...A2_PROMOTED_CANONICAL_IDS,
      ...Array.from({ length: 6 }, (_, index) => `m5-10-wave-a2-rel-00${index + 1}`),
      ...A2_BUFFER_INVENTORY_IDS,
      'a2-audit-sense-boundaries',
      'a2-audit-relation-screen',
      'a2-audit-buffer-decisions',
      'a2-audit-timing-completeness',
    ]),
  }),
});

export class M5A10AWaveA2InputValidationError extends Error {
  constructor(message, code = 'M5_10A_WAVE_A2_INPUT_ERROR') {
    super(message);
    this.name = 'M5A10AWaveA2InputValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_10A_WAVE_A2_INPUT_ERROR') {
  throw new M5A10AWaveA2InputValidationError(message, code);
}

function assertCondition(condition, message, code) {
  if (!condition) fail(message, code);
}

function assertEqual(actual, expected, message, code) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`, code);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail(`${label} must be a non-empty string`, 'INVALID_VALUE');
  }
  if (value !== value.trim()) fail(`${label} must not have surrounding whitespace`, 'UNTRIMMED_VALUE');
  if (value.normalize('NFC') !== value) fail(`${label} must be NFC-normalized`, 'NON_NFC_VALUE');
}

function requireUnique(values, label) {
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`, 'DUPLICATE_VALUE');
}

function schemaErrorPath(error, root) {
  const pathParts = error.instancePath
    .split('/')
    .filter(Boolean)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'));
  if (error.keyword === 'required') pathParts.push(error.params.missingProperty);
  if (error.keyword === 'additionalProperties') pathParts.push(error.params.additionalProperty);
  return pathParts.reduce(
    (result, part) => (/^\d+$/u.test(part) ? `${result}[${part}]` : `${result}.${part}`),
    root,
  );
}

function validateSchema(value, validator, root, label) {
  if (validator(value)) return;
  const error = validator.errors?.[0];
  fail(
    error
      ? `${label} schema validation failed at ${schemaErrorPath(error, root)} ${error.message}`
      : `${label} schema validation failed`,
    'SCHEMA_ERROR',
  );
}

function validateDecisionArtifactProvenance(input, label) {
  const expectedActorKind = input.source_kind === 'codex-authored' ? 'codex' : 'human';
  assertEqual(input.actor_kind, expectedActorKind, `${label} source and actor kinds must agree`, 'DECISION_ARTIFACT_PROVENANCE');
  assertCondition(input.actor_id !== 'unknown', `${label} must identify its actor`, 'DECISION_ARTIFACT_PROVENANCE');
  assertCondition(
    Date.parse(input.finalized_at) >= Date.parse(input.created_at),
    `${label} finalized_at cannot precede created_at`,
    'DECISION_ARTIFACT_CHRONOLOGY',
  );
}

export function validateA2EditorialDecisionArtifact(input) {
  validateSchema(
    input,
    editorialDecisionsSchemaValidator,
    'editorial_decisions',
    'Wave A2 editorial decision artifact',
  );
  assertEqual(input.batch_id, A2_BATCH_ID, 'editorial decision artifact batch_id drifted', 'BATCH_ID_DRIFT');
  validateDecisionArtifactProvenance(input, 'editorial decision artifact');
  assertEqual(
    input.records.map(({ inventory_id: inventoryId }) => inventoryId),
    A2_SELECTED_INVENTORY_IDS,
    'editorial decision artifact scope/order drifted',
    'EDITORIAL_DECISION_ARTIFACT_SCOPE',
  );
  return structuredClone(input);
}

export function validateA2AuditDecisionArtifact(input) {
  validateSchema(
    input,
    auditDecisionsSchemaValidator,
    'audit_decisions',
    'Wave A2 audit decision artifact',
  );
  assertEqual(input.batch_id, A2_BATCH_ID, 'audit decision artifact batch_id drifted', 'BATCH_ID_DRIFT');
  validateDecisionArtifactProvenance(input, 'audit decision artifact');
  return structuredClone(input);
}

function recordMap(recordInfos) {
  return new Map(recordInfos.map((item) => {
    const record = item?.record ?? item;
    return [record.id, record];
  }));
}

function stripEvidenceIdentifiers(text, {
  inventoryId,
  canonicalId,
  lemma,
  boundaryId,
  senseIds = [],
  glosses = [],
} = {}) {
  let normalized = text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  for (const token of [inventoryId, canonicalId, lemma, boundaryId, ...senseIds, ...glosses]
    .filter((token) => typeof token === 'string' && token.length > 0)
    .sort((left, right) => right.length - left.length)) {
    normalized = normalized.replaceAll(token, ' ');
  }
  return normalized.replace(/\d+/gu, '#').replace(/\s+/gu, ' ').trim();
}

function rejectKnownBoilerplate(text, label) {
  const boilerplate = [
    '실제 sense 경계로 대조해 확인했다',
    '여섯 sense 경계를 전수 확인했다',
    'lemma/POS와 여섯 sense 경계를 확인해',
    'source/target sense와 writer-facing relation type으로 독립 대조해',
    '현재 writer-facing 범위에서 안정적인 admission 근거가 부족해',
    '다음 단계에서 검토할 reserve 항목으로 deferred 처리했다',
    '실제 대상의 성질과 비유적 쓰임으로 나누어 읽었다',
    '품사와 문맥을 대조했다',
    '감각, 정서, 상태, 행동의 초점을 구별했다',
    '주체와 대상의 방향 및 상호성 관점에서 확인했다',
    '표기와 검색 단위를 확인했다',
    '관용 표현인지 일반 어휘인지 확인했다',
  ];
  if (boilerplate.some((phrase) => text.includes(phrase))) {
    fail(`${label} contains known generated boilerplate`, 'GENERIC_EDITORIAL_EVIDENCE');
  }
}

const BOUNDARY_DIMENSIONS = Object.freeze({
  'physical-figurative': new Set(['physical', 'figurative', 'usage']),
  'homonym-pos': new Set(['homonym', 'pos', 'usage']),
  'sensory-emotion-state-action': new Set(['sensory', 'emotion', 'state', 'action']),
  'directional-symmetry': new Set(['direction', 'symmetry', 'argument']),
  'compound-spaced-phrase': new Set(['compound', 'spacing', 'form']),
  'word-idiom': new Set(['word', 'idiom', 'usage']),
});

function validateProvenance(input, label, unverifiedStatus = 'in-review') {
  const provenance = input.provenance;
  if (input.source_kind === 'unverified-draft') {
    assertEqual(input.status, unverifiedStatus, `${label} unverified draft cannot be complete`, 'UNVERIFIED_INPUT_COMPLETE');
    assertEqual(provenance.verification_status, 'unverified', `${label} provenance status is inconsistent`, 'PROVENANCE_MISMATCH');
    assertEqual(provenance.actor_kind, 'unknown', `${label} unverified input must not claim a verified actor`, 'PROVENANCE_MISMATCH');
    assertEqual(provenance.actor_id, 'unknown', `${label} unverified input must not name a verified actor`, 'PROVENANCE_MISMATCH');
    assertEqual(provenance.session_id, null, `${label} unverified input must not claim a session`, 'PROVENANCE_MISMATCH');
    assertEqual(provenance.artifact, null, `${label} unverified input must not claim a session artifact`, 'PROVENANCE_MISMATCH');
    assertEqual(provenance.sha256, null, `${label} unverified input must not claim a session digest`, 'PROVENANCE_MISMATCH');
    return false;
  }

  assertCondition(VERIFIED_SOURCE_KINDS.includes(input.source_kind), `${label} source_kind is invalid`, 'PROVENANCE_MISMATCH');
  assertEqual(input.status, 'complete', `${label} verified input must be complete`, 'PROVENANCE_REQUIRED');
  assertEqual(provenance.verification_status, 'verified', `${label} verified input must have verified provenance`, 'PROVENANCE_REQUIRED');
  const expectedActorKind = input.source_kind === 'codex-authored' ? 'codex' : 'human';
  assertEqual(provenance.actor_kind, expectedActorKind, `${label} source and actor kinds must agree`, 'PROVENANCE_REQUIRED');
  assertCondition(VERIFIED_ACTOR_KINDS.includes(provenance.actor_kind), `${label} verified input must identify its actor kind`, 'PROVENANCE_REQUIRED');
  assertCondition(provenance.actor_id !== 'unknown', `${label} verified input must identify its actor`, 'PROVENANCE_REQUIRED');
  if (input.status === 'complete') {
    assertCondition(provenance.session_id !== null, `${label} complete input must bind a session`, 'PROVENANCE_REQUIRED');
    assertCondition(provenance.artifact !== null, `${label} complete input must bind a session artifact`, 'PROVENANCE_REQUIRED');
    assertCondition(provenance.sha256 !== null, `${label} complete input must bind a session digest`, 'PROVENANCE_REQUIRED');
    assertCondition(Object.hasOwn(input, 'completed_at'), `${label} complete input must have completed_at`, 'PROVENANCE_REQUIRED');
  }
  return input.status === 'complete';
}

function senseGlosses(canonicalRecord) {
  return canonicalRecord.senses.map(({ gloss }) => gloss);
}

function validateContrast(contrast, canonicalRecord, evidenceLabel, fingerprints) {
  const senseIds = new Set(canonicalRecord.senses.map(({ id }) => id));
  assertCondition(senseIds.has(contrast.left_sense_id), `${evidenceLabel} contrast cites an unknown left sense`, 'CONTRAST_SENSE_MISMATCH');
  assertCondition(senseIds.has(contrast.right_sense_id), `${evidenceLabel} contrast cites an unknown right sense`, 'CONTRAST_SENSE_MISMATCH');
  assertCondition(contrast.left_sense_id !== contrast.right_sense_id, `${evidenceLabel} contrast must compare two senses`, 'CONTRAST_SENSE_MISMATCH');
  assertCondition(
    BOUNDARY_DIMENSIONS[evidenceLabel.split('.').at(-1)]?.has(contrast.dimension),
    `${evidenceLabel}.contrast.dimension is not valid for its boundary`,
    'CONTRAST_DIMENSION_MISMATCH',
  );
  assertCondition(contrast.facets.length > 0, `${evidenceLabel}.contrast.facets must contain an actual distinction`, 'CONTRAST_FACETS_REQUIRED');
  for (const field of ['left_observation', 'right_observation', 'difference']) {
    requireString(contrast[field], `${evidenceLabel}.contrast.${field}`);
  }
  assertCondition(
    contrast.left_observation !== contrast.right_observation,
    `${evidenceLabel} contrast observations must differ`,
    'GENERIC_EDITORIAL_EVIDENCE',
  );
  assertCondition(
    contrast.difference.length >= 12,
    `${evidenceLabel}.contrast.difference is too generic`,
    'GENERIC_EDITORIAL_EVIDENCE',
  );
  const fingerprint = stripEvidenceIdentifiers(JSON.stringify(contrast), {
    canonicalId: canonicalRecord.id,
    lemma: canonicalRecord.lemma,
    senseIds: canonicalRecord.senses.map(({ id }) => id),
    glosses: senseGlosses(canonicalRecord),
  });
  assertCondition(fingerprint.length >= 12, `${evidenceLabel}.contrast is too generic after removing identifiers`, 'GENERIC_EDITORIAL_EVIDENCE');
  if (fingerprints.has(fingerprint)) {
    fail(`${evidenceLabel}.contrast reuses normalized evidence from ${fingerprints.get(fingerprint)}`, 'GENERIC_EDITORIAL_EVIDENCE');
  }
  fingerprints.set(fingerprint, evidenceLabel);
}

function validateRecordEvidence(recordReview, canonicalRecord, recordIndex, fingerprints, verified) {
  const label = `editorial.records[${recordIndex}]`;
  const decision = recordReview.decision === 'proposed'
    ? recordReview.proposal_decision
    : recordReview.decision;
  const senseIds = canonicalRecord.senses.map(({ id }) => id);
  assertEqual(
    recordReview.observed_sense_count,
    senseIds.length,
    `${label}.observed_sense_count does not match ${canonicalRecord.id}`,
    'CANONICAL_SENSE_COUNT_MISMATCH',
  );
  assertEqual(
    recordReview.observed_pos,
    canonicalRecord.senses.map(({ pos }) => pos),
    `${label}.observed_pos does not match ${canonicalRecord.id}`,
    'CANONICAL_POS_MISMATCH',
  );

  for (const boundaryId of M5_10A_SENSE_BOUNDARY_IDS) {
    const evidence = recordReview.boundary_evidence[boundaryId];
    const evidenceLabel = `${label}.boundary_evidence.${boundaryId}`;
    assertCondition(evidence, `${evidenceLabel} is missing`, 'MISSING_BOUNDARY_EVIDENCE');
    assertEqual(
      [...evidence.candidate_sense_ids].sort(),
      [...senseIds].sort(),
      `${evidenceLabel}.candidate_sense_ids does not match the canonical senses`,
      'BOUNDARY_SENSE_COVERAGE_MISMATCH',
    );
    if (!verified) {
      assertEqual(evidence.review_status, 'unreviewed', `${evidenceLabel} must remain unreviewed`, 'UNREVIEWED_BOUNDARY_EVIDENCE');
      assertEqual(evidence.applicability, 'unknown', `${evidenceLabel} unverified input must not claim applicability`, 'UNREVIEWED_BOUNDARY_EVIDENCE');
      assertEqual(evidence.decision, 'pending', `${evidenceLabel} unverified input must not claim keep/split`, 'UNREVIEWED_BOUNDARY_EVIDENCE');
      assertEqual(evidence.contrasts, [], `${evidenceLabel} unverified input must not claim contrasts`, 'UNREVIEWED_BOUNDARY_EVIDENCE');
      continue;
    }

    assertEqual(evidence.review_status, 'reviewed', `${evidenceLabel} must be reviewed before completion`, 'UNREVIEWED_BOUNDARY_EVIDENCE');
    assertCondition(evidence.applicability !== 'unknown', `${evidenceLabel} must declare applicability`, 'BOUNDARY_APPLICABILITY_MISSING');
    if (evidence.applicability === 'not-applicable') {
      assertEqual(evidence.decision, 'keep', `${evidenceLabel} not-applicable boundary must keep the candidate senses`, 'BOUNDARY_DECISION_MISMATCH');
      assertEqual(evidence.contrasts, [], `${evidenceLabel} not-applicable boundary must not carry contrasts`, 'BOUNDARY_CONTRAST_MISMATCH');
      continue;
    }
    assertCondition(['keep', 'split'].includes(evidence.decision), `${evidenceLabel} has an invalid reviewed decision`, 'BOUNDARY_DECISION_MISMATCH');
    assertCondition(evidence.contrasts.length > 0, `${evidenceLabel} applicable boundary must include an actual contrast`, 'BOUNDARY_CONTRAST_REQUIRED');
    for (const contrast of evidence.contrasts) validateContrast(contrast, canonicalRecord, evidenceLabel, fingerprints);
  }

  const splitBoundaries = M5_10A_SENSE_BOUNDARY_IDS.filter(
    (boundaryId) => recordReview.boundary_evidence[boundaryId].decision === 'split',
  );
  if (decision === 'corrected') {
    assertCondition(canonicalRecord.senses.length > 0, `${label} corrected record must contain at least one canonical sense`, 'CANONICAL_SENSE_COUNT_MISMATCH');
    if (verified) {
      if (canonicalRecord.senses.length > 1) {
        assertCondition(splitBoundaries.length > 0, `${label} corrected multi-sense record must identify a split boundary`, 'BOUNDARY_DECISION_MISMATCH');
      } else {
        assertEqual(splitBoundaries, [], `${label} corrected single-sense record cannot claim a split boundary`, 'BOUNDARY_DECISION_MISMATCH');
      }
    }
  } else if (decision === 'included') {
    assertEqual(canonicalRecord.senses.length, 1, `${label} included record must remain single-sense`, 'CANONICAL_SENSE_COUNT_MISMATCH');
    if (verified) assertEqual(splitBoundaries, [], `${label} included record cannot claim a split boundary`, 'BOUNDARY_DECISION_MISMATCH');
  }
}

function validateUnverifiedRecordShape(recordReview, proposalCanonicalId, recordIndex) {
  const label = `editorial.records[${recordIndex}]`;
  assertCondition(
    recordReview.observed_sense_count > 0,
    `${label} proposed record must identify at least one candidate sense`,
    'UNVERIFIED_SENSE_CLAIM',
  );
  assertEqual(
    recordReview.observed_pos.length,
    recordReview.observed_sense_count,
    `${label}.observed_pos must have one POS value per proposed sense`,
    'UNVERIFIED_SENSE_CLAIM',
  );
  const proposedSenseIds = Array.from(
    { length: recordReview.observed_sense_count },
    (_, index) => `${proposalCanonicalId}-s${index + 1}`,
  );
  for (const boundaryId of M5_10A_SENSE_BOUNDARY_IDS) {
    const evidence = recordReview.boundary_evidence[boundaryId];
    const evidenceLabel = `${label}.boundary_evidence.${boundaryId}`;
    assertEqual(
      [...evidence.candidate_sense_ids].sort(),
      [...proposedSenseIds].sort(),
      `${evidenceLabel}.candidate_sense_ids must cover the proposed sense set`,
      'UNVERIFIED_SENSE_CLAIM',
    );
    assertEqual(evidence.review_status, 'unreviewed', `${evidenceLabel} must remain unreviewed`, 'UNREVIEWED_BOUNDARY_EVIDENCE');
    assertEqual(evidence.applicability, 'unknown', `${evidenceLabel} must remain unknown`, 'UNREVIEWED_BOUNDARY_EVIDENCE');
    assertEqual(evidence.decision, 'pending', `${evidenceLabel} must remain pending`, 'UNREVIEWED_BOUNDARY_EVIDENCE');
    assertEqual(evidence.contrasts, [], `${evidenceLabel} must not contain unverified contrasts`, 'UNREVIEWED_BOUNDARY_EVIDENCE');
  }
}

function expectedDecisionForBuffer(inventoryId) {
  const decisions = {
    'm5-357': 'held',
    'm5-358': 'held',
    'm5-359': 'held',
    'm5-360': 'rejected',
    'm5-361': 'rejected',
    'm5-362': 'rejected',
    'm5-363': 'deferred',
    'm5-364': 'deferred',
  };
  return decisions[inventoryId];
}

export function validateA2EditorialInput({ input, canonicalRecords = [] } = {}) {
  validateSchema(input, editorialSchemaValidator, 'editorial', 'Wave A2 editorial input');
  assertEqual(input.batch_id, A2_BATCH_ID, 'editorial batch_id drifted', 'BATCH_ID_DRIFT');
  assertEqual(input.inventory_id, A2_INVENTORY_ID, 'editorial inventory_id drifted', 'INVENTORY_ID_DRIFT');
  assertEqual(input.inventory_revision, A2_INVENTORY_REVISION, 'editorial inventory_revision drifted', 'INVENTORY_REVISION_DRIFT');
  assertEqual(input.sense_review.boundary_ids, M5_10A_SENSE_BOUNDARY_IDS, 'editorial boundary definition drifted', 'BOUNDARY_DEFINITION_DRIFT');
  const verified = validateProvenance(input, 'editorial input');
  if (verified) {
    assertCondition(
      Date.parse(input.completed_at) >= Date.parse(input.created_at),
      'editorial input completed before its session started',
      'EDITORIAL_CHRONOLOGY_MISMATCH',
    );
    assertCondition(
      Date.parse(input.timing_artifact.started_at) >= Date.parse(input.created_at)
        && Date.parse(input.timing_artifact.started_at) <= Date.parse(input.timing_artifact.completed_at)
        && Date.parse(input.timing_artifact.completed_at) <= Date.parse(input.completed_at),
      'editorial session does not enclose all required timing passes',
      'EDITORIAL_CHRONOLOGY_MISMATCH',
    );
    assertCondition(
      Date.parse(input.decision_artifact.created_at) >= Date.parse(input.created_at)
        && Date.parse(input.decision_artifact.created_at) <= Date.parse(input.completed_at),
      'editorial decision artifact was not supplied during the editorial session',
      'EDITORIAL_DECISION_ARTIFACT_CHRONOLOGY',
    );
    assertCondition(
      Date.parse(input.decision_artifact.finalized_at) >= Date.parse(input.timing_artifact.completed_at)
        && Date.parse(input.decision_artifact.finalized_at) <= Date.parse(input.completed_at),
      'editorial decision artifact was finalized before the required timing passes stopped or after editorial completion',
      'EDITORIAL_DECISION_ARTIFACT_CHRONOLOGY',
    );
  }
  assertEqual(input.sense_review.status, input.status, 'editorial sense_review status does not match input status', 'EDITORIAL_REVIEW_INCOMPLETE');

  const recordsById = recordMap(canonicalRecords);
  const recordReviewsByInventoryId = new Map();
  const decisionNotes = new Set();
  const evidenceFingerprints = new Map();
  for (const [index, recordReview] of input.records.entries()) {
    const label = `editorial.records[${index}]`;
    if (recordReviewsByInventoryId.has(recordReview.inventory_id)) {
      fail(`${label} duplicates inventory_id ${recordReview.inventory_id}`, 'DUPLICATE_INVENTORY_ID');
    }
    recordReviewsByInventoryId.set(recordReview.inventory_id, recordReview);
    requireString(recordReview.decision_note, `${label}.decision_note`);
    rejectKnownBoilerplate(recordReview.decision_note, `${label}.decision_note`);
    if (decisionNotes.has(recordReview.decision_note)) fail(`${label}.decision_note is duplicated`, 'GENERIC_EDITORIAL_EVIDENCE');
    decisionNotes.add(recordReview.decision_note);

    const promoted = A2_PROMOTED_RECORD_REVIEWS[index];
    if (promoted) {
      assertEqual(recordReview.inventory_id, promoted.inventory_id, `${label} is out of deterministic A2 order`, 'EDITORIAL_SCOPE_DRIFT');
      const canonicalIdField = verified ? 'canonical_id' : 'proposal_canonical_id';
      const canonicalId = recordReview[canonicalIdField];
      assertEqual(canonicalId, promoted.canonical_id, `${label}.${canonicalIdField} is out of deterministic A2 order`, 'EDITORIAL_SCOPE_DRIFT');
      const decision = verified ? recordReview.decision : recordReview.proposal_decision;
      assertEqual(
        recordReview.decision,
        verified ? decision : 'proposed',
        `${label}.decision is inconsistent with its provenance state`,
        'EDITORIAL_DECISION_DRIFT',
      );
      assertCondition(
        decision === 'included' || decision === 'corrected',
        `${label} promoted record must be included or corrected`,
        'EDITORIAL_DECISION_DRIFT',
      );
      const canonicalRecord = recordsById.get(canonicalId);
      const correctedFields = verified
        ? recordReview.corrected_fields
        : recordReview.proposal_corrected_fields;
      if (decision === 'corrected') {
        assertEqual(correctedFields, ['senses'], `${label} corrected fields must identify sense corrections`, 'CORRECTION_FIELD_DRIFT');
      } else {
        assertCondition(
          !Object.hasOwn(recordReview, verified ? 'corrected_fields' : 'proposal_corrected_fields'),
          `${label} included record must not carry corrected fields`,
          'CORRECTION_FIELD_DRIFT',
        );
      }
      assertCondition(
        recordReview.decision_note.includes(recordReview.inventory_id)
          && recordReview.decision_note.includes(canonicalId)
          && (!verified || (canonicalRecord && recordReview.decision_note.includes(canonicalRecord.lemma))),
        `${label}.decision_note must identify the inventory row and canonical record${verified ? ' and lemma' : ''}`,
        'RECORD_SPECIFIC_EVIDENCE_REQUIRED',
      );
      if (!canonicalRecord) {
        assertCondition(!verified, `${label} canonical record is missing`, 'MISSING_CANONICAL_RECORD');
        validateUnverifiedRecordShape(recordReview, canonicalId, index);
        continue;
      }
      validateRecordEvidence(recordReview, canonicalRecord, index, evidenceFingerprints, verified);
      continue;
    }

    const expectedDecision = expectedDecisionForBuffer(recordReview.inventory_id);
    assertCondition(expectedDecision, `${label} contains an inventory target outside the A2 scope`, 'EDITORIAL_SCOPE_DRIFT');
    assertEqual(recordReview.inventory_id, A2_BUFFER_INVENTORY_IDS[index - A2_PROMOTED_RECORD_REVIEWS.length], `${label} is out of deterministic buffer order`, 'EDITORIAL_SCOPE_DRIFT');
    assertEqual(recordReview.decision, expectedDecision, `${label} buffer decision drifted`, 'EDITORIAL_DECISION_DRIFT');
    assertCondition(!Object.hasOwn(recordReview, 'canonical_id'), `${label} buffer decision must not carry canonical_id`, 'EDITORIAL_CANONICAL_MISMATCH');
    assertCondition(!Object.hasOwn(recordReview, 'boundary_evidence'), `${label} buffer decision must not synthesize boundary evidence`, 'UNREVIEWED_BOUNDARY_EVIDENCE');
    requireString(recordReview.unreviewed_note, `${label}.unreviewed_note`);
    assertCondition(
      recordReview.decision_note.includes(recordReview.inventory_id)
        && recordReview.unreviewed_note.includes(recordReview.inventory_id),
      `${label} buffer notes must identify the inventory row`,
      'RECORD_SPECIFIC_EVIDENCE_REQUIRED',
    );
    rejectKnownBoilerplate(recordReview.unreviewed_note, `${label}.unreviewed_note`);
  }

  assertEqual(
    [...recordReviewsByInventoryId.keys()].sort(),
    [...A2_SELECTED_INVENTORY_IDS].sort(),
    'editorial input must cover exactly the 50 promoted rows and declared 8-row buffer',
    'EDITORIAL_SCOPE_DRIFT',
  );

  const promotedReviews = input.records.slice(0, A2_PROMOTED_RECORD_REVIEWS.length);
  const correctedIds = promotedReviews
    .filter((recordReview) => (
      (recordReview.decision === 'proposed' ? recordReview.proposal_decision : recordReview.decision) === 'corrected'
    ))
    .map((recordReview) => (
      recordReview.decision === 'proposed'
        ? recordReview.proposal_canonical_id
        : recordReview.canonical_id
    ))
    .sort();
  const splitCanonicalIds = correctedIds.filter((canonicalId) => {
    const canonicalRecord = recordsById.get(canonicalId);
    return canonicalRecord?.senses.length > 1;
  });
  if (verified) {
    assertEqual(
      input.sense_review.reviewed_start_count,
      promotedReviews.length,
      'editorial sense review count does not cover every promoted start',
      'SENSE_REVIEW_COUNT_MISMATCH',
    );
    assertEqual(
      input.sense_review.scoped_single_sense_count + input.sense_review.split_record_count,
      promotedReviews.length,
      'editorial sense review summary does not account for every promoted start',
      'SENSE_REVIEW_COUNT_MISMATCH',
    );
    assertEqual(
      input.sense_review.split_record_count,
      splitCanonicalIds.length,
      'editorial split count does not match corrected multi-sense decisions',
      'SENSE_REVIEW_COUNT_MISMATCH',
    );
    assertEqual(
      [...input.sense_review.split_canonical_ids].sort(),
      [...splitCanonicalIds].sort(),
      'editorial split IDs do not match corrected multi-sense decisions',
      'SENSE_REVIEW_CORRECTION_MISMATCH',
    );
  } else {
    assertEqual(input.sense_review.reviewed_start_count, 0, 'unverified editorial input must not claim reviewed starts', 'UNVERIFIED_REVIEW_CLAIM');
    assertEqual(input.sense_review.scoped_single_sense_count, 0, 'unverified editorial input must not claim single-sense review', 'UNVERIFIED_REVIEW_CLAIM');
    assertEqual(input.sense_review.split_record_count, 0, 'unverified editorial input must not claim split review', 'UNVERIFIED_REVIEW_CLAIM');
    assertEqual(input.sense_review.split_canonical_ids, [], 'unverified editorial input must not claim split IDs', 'UNVERIFIED_REVIEW_CLAIM');
  }
  requireString(input.sense_review.note, 'editorial.sense_review.note');
  rejectKnownBoilerplate(input.sense_review.note, 'editorial.sense_review.note');
  return {
    ...input,
    verified,
    recordsByInventoryId: recordReviewsByInventoryId,
    canonicalRecordsById: recordsById,
  };
}

export async function validateA2ProposalStagingDigest({ input, stagedRecordsPath } = {}) {
  if (!stagedRecordsPath) return;
  const expectedDigest = input?.source_kind === 'unverified-draft'
    ? input.proposal_staging?.sha256
    : input?.reviewed_staging_sha256;
  assertCondition(
    typeof expectedDigest === 'string',
    'A2 staged input digest is missing from the editorial input',
    'STAGED_INPUT_DIGEST_REQUIRED',
  );
  let bytes;
  try {
    bytes = await readFile(stagedRecordsPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      fail(`A2 proposal staging does not exist: ${stagedRecordsPath}`, 'MISSING_PROPOSAL_STAGING');
    }
    throw error;
  }
  assertEqual(
    sha256Bytes(bytes),
    expectedDigest,
    input?.source_kind === 'unverified-draft'
      ? 'A2 proposal staging digest does not match editorial metadata'
      : 'A2 reviewed staging digest does not match editorial metadata',
    input?.source_kind === 'unverified-draft'
      ? 'PROPOSAL_STAGING_DIGEST_MISMATCH'
      : 'REVIEWED_STAGING_DIGEST_MISMATCH',
  );
}

function relationReviewKey(review) {
  return JSON.stringify([
    review.candidate_id,
    review.relation_id,
    review.source_sense,
    review.target_sense,
    review.relation_type,
    review.decision,
  ]);
}

export function validateA2AuditInput({ audit, editorialInput, relationDiff, canonicalRecords = [] } = {}) {
  validateSchema(audit, auditSchemaValidator, 'audit', 'Wave A2 audit input');
  assertEqual(audit.batch_id, A2_BATCH_ID, 'audit batch_id drifted', 'BATCH_ID_DRIFT');
  assertEqual(audit.editorial_input_id, editorialInput.input_id, 'audit editorial input binding drifted', 'AUDIT_INPUT_BINDING_MISMATCH');
  const verified = validateProvenance(audit, 'audit input', 'incomplete');
  if (!verified) {
    assertEqual(audit.independent, false, 'unverified audit must not claim independence', 'AUDIT_NOT_INDEPENDENT');
    assertEqual(audit.reviewed_record_ids, [], 'unverified audit must not claim reviewed records', 'UNVERIFIED_AUDIT_CLAIM');
    assertEqual(audit.relation_reviews, [], 'unverified audit must not claim reviewed relations', 'UNVERIFIED_AUDIT_CLAIM');
    assertCondition(
      audit.findings.some(({ category, severity, status }) => category === 'provenance' && severity === 'blocker' && status === 'open'),
      'unverified audit must retain an open provenance blocker',
      'UNVERIFIED_AUDIT_CLAIM',
    );
    requireString(audit.note, 'audit.note');
    return { ...audit, verified: false };
  }

  assertCondition(editorialInput.verified === true, 'audit cannot complete while editorial provenance is unverified', 'AUDIT_EDITORIAL_PROVENANCE_MISMATCH');
  assertCondition(audit.independent, 'complete audit must claim independence only after verification', 'AUDIT_NOT_INDEPENDENT');
  assertCondition(
    Date.parse(audit.completed_at) >= Date.parse(audit.created_at)
      && Date.parse(audit.created_at) >= Date.parse(editorialInput.completed_at),
    'audit chronology must begin after the completed editorial pass',
    'AUDIT_CHRONOLOGY_MISMATCH',
  );
  assertCondition(
    Date.parse(audit.editorial_timing_artifact.completed_at) <= Date.parse(audit.created_at),
    'audit cannot start before the editorial timing passes stopped',
    'AUDIT_CHRONOLOGY_MISMATCH',
  );
  assertCondition(
    Date.parse(audit.decision_artifact.created_at) >= Date.parse(audit.created_at)
      && Date.parse(audit.decision_artifact.created_at) <= Date.parse(audit.completed_at),
    'audit decision artifact was not supplied during the audit session',
    'AUDIT_DECISION_ARTIFACT_CHRONOLOGY',
  );
  assertCondition(
    Date.parse(audit.decision_artifact.finalized_at) >= Date.parse(audit.decision_artifact.created_at)
      && Date.parse(audit.decision_artifact.finalized_at) <= Date.parse(audit.completed_at),
    'audit decision artifact was finalized outside the audit session',
    'AUDIT_DECISION_ARTIFACT_CHRONOLOGY',
  );
  assertEqual(
    audit.editorial_timing_artifact,
    editorialInput.timing_artifact,
    'audit editorial timing artifact must bind the editorial timing result',
    'AUDIT_TIMING_BINDING_MISMATCH',
  );
  assertEqual(
    audit.reviewed_staging_sha256,
    editorialInput.reviewed_staging_sha256,
    'audit reviewed staging digest must match the editorial input',
    'AUDIT_STAGING_BINDING_MISMATCH',
  );
  assertCondition(
    audit.timing_artifact.path !== audit.editorial_timing_artifact.path,
    'post-freeze audit timing must use a distinct timing artifact',
    'AUDIT_TIMING_BINDING_MISMATCH',
  );
  assertEqual(
    audit.timing_artifact.audit_session_id,
    audit.provenance.session_id,
    'post-freeze audit timing must bind the audit provenance session',
    'AUDIT_TIMING_BINDING_MISMATCH',
  );
  assertEqual(
    audit.timing_artifact.reviewed_staging_sha256,
    audit.reviewed_staging_sha256,
    'post-freeze audit timing must bind the reviewed staging digest',
    'AUDIT_TIMING_BINDING_MISMATCH',
  );
  assertCondition(
    Date.parse(audit.timing_artifact.started_at) >= Date.parse(audit.created_at)
      && Date.parse(audit.timing_artifact.started_at) <= Date.parse(audit.timing_artifact.completed_at)
      && Date.parse(audit.timing_artifact.completed_at) <= Date.parse(audit.decision_artifact.finalized_at)
      && Date.parse(audit.timing_artifact.completed_at) <= Date.parse(audit.completed_at),
    'post-freeze audit timing must run after audit start and stop before audit decision finalization and completion',
    'AUDIT_TIMING_CHRONOLOGY_MISMATCH',
  );
  assertEqual(audit.auditor_id, audit.provenance.actor_id, 'audit auditor_id must match its provenance actor', 'AUDIT_PROVENANCE_MISMATCH');
  assertCondition(
    audit.provenance.session_id !== editorialInput.provenance.session_id,
    'independent audit must use a separate pass session',
    'AUDIT_NOT_INDEPENDENT',
  );
  assertCondition(
    audit.provenance.artifact !== editorialInput.provenance.artifact,
    'independent audit must use a separate pass artifact',
    'AUDIT_NOT_INDEPENDENT',
  );

  const canonicalById = recordMap(canonicalRecords);
  assertEqual(
    [...audit.reviewed_record_ids].sort(),
    [...A2_PROMOTED_CANONICAL_IDS].sort(),
    'audit must cover every promoted canonical start exactly once',
    'AUDIT_SCOPE_MISMATCH',
  );
  for (const canonicalId of audit.reviewed_record_ids) {
    assertCondition(canonicalById.has(canonicalId), `audit references missing canonical record ${canonicalId}`, 'MISSING_CANONICAL_RECORD');
  }

  const candidateReviews = relationDiff.candidate_reviews ?? [];
  assertCondition(
    candidateReviews.every(({ decision }) => decision === 'admit' || decision === 'reject'),
    'complete audit cannot finalize pending relation candidates',
    'AUDIT_INCOMPLETE',
  );
  assertEqual(
    audit.relation_reviews.map(relationReviewKey).sort(),
    candidateReviews.map((review) => relationReviewKey({
      candidate_id: review.candidate_id,
      relation_id: review.relation_id,
      source_sense: review.source_sense,
      target_sense: review.relation.target_sense,
      relation_type: review.relation.type,
      decision: review.decision,
    })).sort(),
    'audit relation reviews must cover the exact reviewed candidate set and final types',
    'AUDIT_RELATION_SCOPE_MISMATCH',
  );
  for (const [index, candidate] of candidateReviews.entries()) {
    const label = `relationDiff.candidate_reviews[${index}]`;
    const sourceRecordId = candidate.source_sense.replace(/-s[1-9][0-9]*$/u, '');
    const sourceRecord = canonicalById.get(sourceRecordId);
    assertCondition(sourceRecord, `${label} references an unknown source record`, 'MISSING_CANONICAL_RECORD');
    assertCondition(
      sourceRecord.senses.some(({ id }) => id === candidate.source_sense),
      `${label}.source_sense is not a sense of ${sourceRecordId}`,
      'MISSING_CANONICAL_SENSE',
    );
    const targetRecord = canonicalById.get(candidate.relation.target);
    assertCondition(targetRecord, `${label} references an unknown target record`, 'MISSING_CANONICAL_RECORD');
    if (candidate.relation.target_sense) {
      const targetRecordId = candidate.relation.target_sense.replace(/-s[1-9][0-9]*$/u, '');
      assertEqual(
        targetRecordId,
        targetRecord.id,
        `${label}.relation.target_sense points outside its target record`,
        'CANONICAL_RELATION_MISMATCH',
      );
      assertCondition(
        targetRecord.senses.some(({ id }) => id === candidate.relation.target_sense),
        `${label}.relation.target_sense is not a sense of ${targetRecord.id}`,
        'MISSING_CANONICAL_SENSE',
      );
    }
  }
  const relationNotes = new Map();
  for (const [index, review] of audit.relation_reviews.entries()) {
    const label = `audit.relation_reviews[${index}]`;
    assertEqual(review.review_status, 'reviewed', `${label} must be reviewed before completion`, 'AUDIT_INCOMPLETE');
    assertCondition(review.basis.facets.length > 0, `${label}.basis.facets must contain an actual distinction`, 'AUDIT_EVIDENCE_REQUIRED');
    requireString(review.basis.source_observation, `${label}.basis.source_observation`);
    requireString(review.basis.target_observation, `${label}.basis.target_observation`);
    requireString(review.basis.difference, `${label}.basis.difference`);
    assertCondition(review.basis.source_observation !== review.basis.target_observation, `${label}.basis observations must differ`, 'GENERIC_EDITORIAL_EVIDENCE');
    assertCondition(review.basis.difference.length >= 12, `${label}.basis.difference is too generic`, 'GENERIC_EDITORIAL_EVIDENCE');
    const sourceRecord = canonicalById.get(review.source_sense.split('-s')[0]);
    const targetRecord = canonicalById.get(review.target_sense.split('-s')[0]);
    assertCondition(
      sourceRecord && targetRecord,
      `${label} references an unknown source or target record`,
      'MISSING_CANONICAL_RECORD',
    );
    const fingerprint = stripEvidenceIdentifiers(JSON.stringify(review.basis), {
      senseIds: [review.source_sense, review.target_sense],
      glosses: [...senseGlosses(sourceRecord), ...senseGlosses(targetRecord)],
    });
    assertCondition(fingerprint.length >= 12, `${label}.basis is too generic after removing identifiers`, 'GENERIC_EDITORIAL_EVIDENCE');
    if (relationNotes.has(fingerprint)) fail(`${label}.basis reuses normalized relation evidence from ${relationNotes.get(fingerprint)}`, 'GENERIC_EDITORIAL_EVIDENCE');
    relationNotes.set(fingerprint, label);
  }

  const findingIds = new Set();
  const findingNotes = new Map();
  for (const [index, finding] of audit.findings.entries()) {
    const label = `audit.findings[${index}]`;
    if (findingIds.has(finding.id)) fail(`${label}.id is duplicated`, 'DUPLICATE_AUDIT_FINDING');
    findingIds.add(finding.id);
    requireString(finding.note, `${label}.note`);
    rejectKnownBoilerplate(finding.note, `${label}.note`);
    const fingerprint = stripEvidenceIdentifiers(finding.note);
    if (findingNotes.has(fingerprint)) fail(`${label}.note reuses normalized audit evidence`, 'GENERIC_EDITORIAL_EVIDENCE');
    findingNotes.set(fingerprint, label);
    assertCondition(finding.evidence_refs.length > 0, `${label} must cite evidence`, 'AUDIT_EVIDENCE_REQUIRED');
  }
  assertCondition(
    audit.findings.every(({ status, severity }) => status === 'resolved' && severity !== 'blocker'),
    'complete independent audit cannot contain open or blocker findings',
    'AUDIT_BLOCKER_OPEN',
  );
  requireString(audit.note, 'audit.note');
  rejectKnownBoilerplate(audit.note, 'audit.note');
  return { ...audit, verified: true };
}

export function createA2TimingProof(timing) {
  const { recording_proof_sha256: _proof, ...payload } = timing;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function validateTimingPassOrder(passes, expectedPassIds, label) {
  assertEqual(
    passes.map(({ id }) => id),
    expectedPassIds,
    `${label} timing pass coverage/order drifted`,
    'TIMING_PASS_COVERAGE',
  );
}

function validateA2TimingInputForPasses(timing, expectedPassIds, expectedTimingKind, label) {
  validateSchema(timing, timingSchemaValidator, 'timing', 'Wave A2 timing input');
  assertEqual(timing.batch_id, A2_BATCH_ID, 'timing batch_id drifted', 'BATCH_ID_DRIFT');
  assertEqual(timing.timing_kind ?? 'editorial', expectedTimingKind, `${label} timing_kind drifted`, 'TIMING_KIND_MISMATCH');
  validateTimingPassOrder(timing.passes, expectedPassIds, label);
  if (timing.status === 'incomplete') {
    assertEqual(timing.events, [], 'incomplete timing must not retain partial synthetic events', 'INVALID_INCOMPLETE_TIMING');
    for (const pass of timing.passes) {
      assertEqual(pass.status, 'unmeasured', `incomplete timing pass ${pass.id} must remain unmeasured`, 'INVALID_INCOMPLETE_TIMING');
      for (const field of ['started_at', 'completed_at', 'wall_clock_seconds', 'editor_seconds', 'session_id', 'recording_source', 'work_evidence']) {
        assertCondition(!Object.hasOwn(pass, field), `incomplete timing pass ${pass.id} contains ${field}`, 'INVALID_INCOMPLETE_TIMING');
      }
    }
    return { status: 'incomplete', unmeasured_pass_count: timing.passes.length };
  }

  assertCondition(timing.recording_proof_sha256 === createA2TimingProof(timing), 'timing recording proof does not match persisted events', 'TIMING_RECORDING_PROOF_MISMATCH');
  assertEqual(timing.events.length, expectedPassIds.length * 2, 'complete timing must persist one start and one stop event per pass', 'TIMING_EVENT_COVERAGE');
  const eventsByPass = new Map(expectedPassIds.map((id) => [id, []]));
  for (const event of timing.events) eventsByPass.get(event.pass_id).push(event);
  for (let index = 1; index < timing.passes.length; index += 1) {
    assertCondition(
      Date.parse(timing.passes[index].started_at) >= Date.parse(timing.passes[index - 1].completed_at),
      `timing pass ${timing.passes[index].id} starts before the previous pass stopped`,
      'TIMING_CHRONOLOGY_MISMATCH',
    );
  }
  for (const pass of timing.passes) {
    assertEqual(pass.status, 'complete', `complete timing pass ${pass.id} is not complete`, 'INCOMPLETE_TIMING');
    for (const field of ['started_at', 'completed_at', 'wall_clock_seconds', 'editor_seconds', 'session_id', 'recording_source', 'work_evidence']) {
      assertCondition(Object.hasOwn(pass, field), `complete timing pass ${pass.id} lacks ${field}`, 'INCOMPLETE_TIMING');
    }
    const events = eventsByPass.get(pass.id);
    assertEqual(events.map(({ kind }) => kind), ['start', 'stop'], `timing events for ${pass.id} must be start then stop`, 'TIMING_EVENT_COVERAGE');
    assertEqual(events[0].session_id, pass.session_id, `${pass.id} start event session drifted`, 'TIMING_EVENT_BINDING_MISMATCH');
    assertEqual(events[1].session_id, pass.session_id, `${pass.id} stop event session drifted`, 'TIMING_EVENT_BINDING_MISMATCH');
    assertEqual(events[0].at, pass.started_at, `${pass.id} start event timestamp drifted`, 'TIMING_EVENT_BINDING_MISMATCH');
    assertEqual(events[1].at, pass.completed_at, `${pass.id} stop event timestamp drifted`, 'TIMING_EVENT_BINDING_MISMATCH');
    const elapsedSeconds = (Date.parse(pass.completed_at) - Date.parse(pass.started_at)) / 1000;
    assertEqual(pass.wall_clock_seconds, elapsedSeconds, `${pass.id} wall-clock duration drifted`, 'TIMING_DURATION_DRIFT');
    assertEqual(pass.editor_seconds, elapsedSeconds, `${pass.id} editor duration drifted`, 'TIMING_DURATION_DRIFT');
    assertCondition(
      pass.editor_seconds >= pass.work_evidence.unit_count * A2_MIN_EDITOR_SECONDS_PER_UNIT,
      `${pass.id} editor session is shorter than the persisted work-unit lower bound`,
      'TIMING_WORK_DURATION_TOO_SHORT',
    );
    assertEqual(
      pass.work_evidence.unit_ids.length,
      pass.work_evidence.unit_count,
      `${pass.id} work evidence unit_count does not match unit_ids`,
      'TIMING_WORK_EVIDENCE_MISMATCH',
    );
    const workContract = A2_TIMING_WORK_UNIT_CONTRACT[pass.id];
    assertEqual(
      pass.work_evidence.unit_kind,
      workContract.unit_kind,
      `${pass.id} work evidence unit_kind does not match the A2 timing contract`,
      'TIMING_WORK_EVIDENCE_MISMATCH',
    );
    assertEqual(
      [...pass.work_evidence.unit_ids].sort(),
      [...workContract.unit_ids].sort(),
      `${pass.id} work evidence unit_ids do not cover the A2 timing contract`,
      'TIMING_WORK_EVIDENCE_MISMATCH',
    );
    if (pass.id === 'post-freeze-audit') {
      assertCondition(
        pass.work_evidence.before_sha256 === pass.reviewed_staging_sha256
          && pass.work_evidence.after_sha256 === pass.reviewed_staging_sha256,
        'post-freeze audit work evidence must remain bound to the frozen reviewed staging digest',
        'AUDIT_TIMING_STAGING_BINDING_MISMATCH',
      );
    }
  }
  return { status: 'complete', unmeasured_pass_count: 0 };
}

export function validateA2TimingInput(timing) {
  return validateA2TimingInputForPasses(timing, A2_TIMING_PASS_IDS, 'editorial', 'editorial');
}

export function validateA2AuditTimingInput(
  timing,
  {
    auditSessionId,
    reviewedStagingSha256,
    auditSessionStartedAt,
    decisionFinalizedAt,
  } = {},
) {
  const result = validateA2TimingInputForPasses(
    timing,
    A2_AUDIT_TIMING_PASS_IDS,
    'post-freeze-audit',
    'post-freeze audit',
  );
  if (timing.status === 'incomplete') return result;

  const pass = timing.passes[0];
  if (auditSessionId) {
    assertEqual(
      pass.audit_session_id,
      auditSessionId,
      'post-freeze audit timing session binding drifted',
      'AUDIT_TIMING_BINDING_MISMATCH',
    );
  }
  if (reviewedStagingSha256) {
    assertEqual(
      pass.reviewed_staging_sha256,
      reviewedStagingSha256,
      'post-freeze audit timing staging binding drifted',
      'AUDIT_TIMING_STAGING_BINDING_MISMATCH',
    );
  }
  if (auditSessionStartedAt) {
    assertCondition(
      Date.parse(pass.started_at) >= Date.parse(auditSessionStartedAt),
      'post-freeze audit timing started before the audit provenance session',
      'AUDIT_TIMING_CHRONOLOGY_MISMATCH',
    );
  }
  if (decisionFinalizedAt) {
    assertCondition(
      Date.parse(pass.completed_at) <= Date.parse(decisionFinalizedAt),
      'post-freeze audit timing completed after audit decision finalization',
      'AUDIT_TIMING_CHRONOLOGY_MISMATCH',
    );
  }
  return result;
}

export async function validateA2ProvenanceArtifact({
  input,
  repositoryDirectory,
  subjectKind,
} = {}) {
  const verified = VERIFIED_SOURCE_KINDS.includes(input?.source_kind) && input?.status === 'complete';
  if (!verified) return null;
  assertCondition(
    typeof repositoryDirectory === 'string' && repositoryDirectory.length > 0,
    'repositoryDirectory is required to verify a completed A2 provenance artifact',
    'PROVENANCE_ARTIFACT_REQUIRED',
  );
  const artifactPath = path.resolve(repositoryDirectory, input.provenance.artifact);
  let artifactBytes;
  try {
    artifactBytes = await readFile(artifactPath);
  } catch (error) {
    if (error.code === 'ENOENT') fail(`completed ${subjectKind} input provenance artifact does not exist: ${input.provenance.artifact}`, 'PROVENANCE_ARTIFACT_MISSING');
    throw error;
  }
  let artifact;
  try {
    artifact = JSON.parse(artifactBytes.toString('utf8'));
  } catch (error) {
    fail(`completed ${subjectKind} provenance artifact is not valid JSON: ${error.message}`, 'PROVENANCE_ARTIFACT_INVALID');
  }
  validateSchema(artifact, provenanceSchemaValidator, `${subjectKind}.provenance`, 'Wave A2 provenance artifact');
  assertEqual(artifact.subject_kind, subjectKind, `${subjectKind} provenance subject kind drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  const subjectId = subjectKind === 'editorial' ? input.input_id : input.audit_id;
  assertEqual(artifact.subject_id, subjectId, `${subjectKind} provenance subject ID drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(artifact.subject_sha256, sha256ProvenanceSubject(input), `${subjectKind} provenance input digest drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(input.provenance.sha256, sha256Bytes(artifactBytes), `${subjectKind} provenance artifact digest drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(artifact.session_id, input.provenance.session_id, `${subjectKind} provenance session drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(artifact.actor_id, input.provenance.actor_id, `${subjectKind} provenance actor drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertEqual(artifact.completed_at, input.completed_at, `${subjectKind} provenance completion time drifted`, 'PROVENANCE_ARTIFACT_MISMATCH');
  assertCondition(Date.parse(artifact.completed_at) >= Date.parse(artifact.started_at), `${subjectKind} provenance artifact completed before it started`, 'PROVENANCE_ARTIFACT_MISMATCH');
  return artifact;
}

export function sha256ProvenanceSubject(input) {
  const subject = structuredClone(input);
  subject.provenance.sha256 = null;
  return sha256Bytes(Buffer.from(JSON.stringify(subject), 'utf8'));
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
