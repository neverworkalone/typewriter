import { createHash } from 'node:crypto';
import { createRequire as createModuleRequire } from 'node:module';

import Ajv2020 from 'ajv/dist/2020.js';

import {
  M5_10A_PROCESS_REVISION,
  M5_10A_SENSE_BOUNDARY_IDS,
} from './validate-batch.mjs';

const require = createModuleRequire(import.meta.url);
const EDITORIAL_SCHEMA = require('../../schema/m5-10a-wave-a2-editorial-input.schema.json');
const AUDIT_SCHEMA = require('../../schema/m5-10a-wave-a2-audit-input.schema.json');
const TIMING_SCHEMA = require('../../schema/m5-10a-wave-a2-timing-input.schema.json');

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
const timingSchemaValidator = new Ajv2020(schemaOptions).compile(TIMING_SCHEMA);

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
      'w588', 'w595', 'w598', 'w599', 'w603', 'w604', 'w606', 'w609',
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
} = {}) {
  let normalized = text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  for (const token of [inventoryId, canonicalId, lemma, boundaryId, ...senseIds]
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
  ];
  if (boilerplate.some((phrase) => text.includes(phrase))) {
    fail(`${label} contains known generated boilerplate`, 'GENERIC_EDITORIAL_EVIDENCE');
  }
}

function validateRecordEvidence(recordReview, canonicalRecord, recordIndex, fingerprints) {
  const label = `editorial.records[${recordIndex}]`;
  const senseIds = canonicalRecord.senses.map(({ id }) => id);
  const observedSenseIds = new Set(senseIds);
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
  assertCondition(
    recordReview.boundary_evidence && typeof recordReview.boundary_evidence === 'object',
    `${label} is missing record-specific boundary evidence`,
    'MISSING_BOUNDARY_EVIDENCE',
  );

  for (const boundaryId of M5_10A_SENSE_BOUNDARY_IDS) {
    const evidence = recordReview.boundary_evidence[boundaryId];
    const evidenceLabel = `${label}.boundary_evidence.${boundaryId}`;
    assertCondition(evidence, `${evidenceLabel} is missing`, 'MISSING_BOUNDARY_EVIDENCE');
    assertEqual(
      evidence.status,
      'checked',
      `${evidenceLabel} must be explicitly checked for an importable record`,
      'UNREVIEWED_BOUNDARY_EVIDENCE',
    );
    assertEqual(
      [...evidence.sense_ids].sort(),
      [...observedSenseIds].sort(),
      `${evidenceLabel}.sense_ids does not cover the observed senses`,
      'BOUNDARY_SENSE_COVERAGE_MISMATCH',
    );
    requireString(evidence.note, `${evidenceLabel}.note`);
    assertCondition(
      evidence.note.includes(canonicalRecord.lemma),
      `${evidenceLabel}.note must identify the reviewed lemma`,
      'RECORD_SPECIFIC_EVIDENCE_REQUIRED',
    );
    rejectKnownBoilerplate(evidence.note, evidenceLabel);
    const fingerprint = stripEvidenceIdentifiers(evidence.note, {
      inventoryId: recordReview.inventory_id,
      canonicalId: canonicalRecord.id,
      lemma: canonicalRecord.lemma,
      boundaryId,
      senseIds,
    });
    assertCondition(
      fingerprint.length >= 12,
      `${evidenceLabel}.note is too generic after removing identifiers`,
      'GENERIC_EDITORIAL_EVIDENCE',
    );
    if (fingerprints.has(fingerprint)) {
      fail(`${evidenceLabel}.note reuses normalized evidence from ${fingerprints.get(fingerprint)}`, 'GENERIC_EDITORIAL_EVIDENCE');
    }
    fingerprints.set(fingerprint, evidenceLabel);
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
  assertCondition(input.status === 'complete', 'editorial input must be complete before building an import manifest', 'EDITORIAL_REVIEW_INCOMPLETE');

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
      assertEqual(recordReview.canonical_id, promoted.canonical_id, `${label}.canonical_id is out of deterministic A2 order`, 'EDITORIAL_SCOPE_DRIFT');
      assertCondition(
        recordReview.decision === 'included' || recordReview.decision === 'corrected',
        `${label} promoted record must be included or corrected`,
        'EDITORIAL_DECISION_DRIFT',
      );
      const canonicalRecord = recordsById.get(recordReview.canonical_id);
      assertCondition(canonicalRecord, `${label} canonical record is missing`, 'MISSING_CANONICAL_RECORD');
      if (recordReview.decision === 'corrected') {
        assertEqual(recordReview.corrected_fields, ['senses'], `${label}.corrected_fields must identify sense corrections`, 'CORRECTION_FIELD_DRIFT');
      } else {
        assertCondition(!Object.hasOwn(recordReview, 'corrected_fields'), `${label} included record must not carry corrected_fields`, 'CORRECTION_FIELD_DRIFT');
      }
      assertCondition(
        recordReview.decision_note.includes(recordReview.inventory_id)
          && recordReview.decision_note.includes(canonicalRecord.id)
          && recordReview.decision_note.includes(canonicalRecord.lemma),
        `${label}.decision_note must identify the inventory row, canonical record, and lemma`,
        'RECORD_SPECIFIC_EVIDENCE_REQUIRED',
      );
      validateRecordEvidence(recordReview, canonicalRecord, index, evidenceFingerprints);
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
    .filter(({ decision }) => decision === 'corrected')
    .map(({ canonical_id: canonicalId }) => canonicalId)
    .sort();
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
    correctedIds.length,
    'editorial split count does not match corrected decisions',
    'SENSE_REVIEW_COUNT_MISMATCH',
  );
  assertEqual(
    [...input.sense_review.split_canonical_ids].sort(),
    correctedIds,
    'editorial split IDs do not match corrected decisions',
    'SENSE_REVIEW_CORRECTION_MISMATCH',
  );
  requireString(input.sense_review.note, 'editorial.sense_review.note');
  rejectKnownBoilerplate(input.sense_review.note, 'editorial.sense_review.note');
  return {
    ...input,
    recordsByInventoryId: recordReviewsByInventoryId,
    canonicalRecordsById: recordsById,
  };
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
  assertCondition(audit.auditor_id !== editorialInput.reviewer_id, 'independent audit must use a separate auditor identity', 'AUDIT_NOT_INDEPENDENT');
  assertCondition(audit.status === 'complete', 'audit input must be complete before claiming an independent audit', 'AUDIT_INCOMPLETE');

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
  const relationNotes = new Map();
  for (const [index, review] of audit.relation_reviews.entries()) {
    const label = `audit.relation_reviews[${index}]`;
    requireString(review.review_note, `${label}.review_note`);
    rejectKnownBoilerplate(review.review_note, `${label}.review_note`);
    assertCondition(review.review_note.includes(review.source_sense), `${label}.review_note must identify its source sense`, 'RECORD_SPECIFIC_EVIDENCE_REQUIRED');
    assertCondition(review.review_note.includes(review.target_sense), `${label}.review_note must identify its target sense`, 'RECORD_SPECIFIC_EVIDENCE_REQUIRED');
    assertCondition(
      review.review_note.includes(review.relation_id)
        && review.review_note.includes(review.candidate_id),
      `${label}.review_note must identify its candidate and relation IDs`,
      'RECORD_SPECIFIC_EVIDENCE_REQUIRED',
    );
    const fingerprint = stripEvidenceIdentifiers(review.review_note, {
      senseIds: [review.source_sense, review.target_sense],
    });
    if (relationNotes.has(fingerprint)) fail(`${label}.review_note reuses normalized relation evidence from ${relationNotes.get(fingerprint)}`, 'GENERIC_EDITORIAL_EVIDENCE');
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
  return audit;
}

export function createA2TimingProof(timing) {
  const { recording_proof_sha256: _proof, ...payload } = timing;
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function validateTimingPassOrder(passes) {
  assertEqual(
    passes.map(({ id }) => id),
    A2_TIMING_PASS_IDS,
    'timing pass coverage/order drifted',
    'TIMING_PASS_COVERAGE',
  );
}

export function validateA2TimingInput(timing) {
  validateSchema(timing, timingSchemaValidator, 'timing', 'Wave A2 timing input');
  assertEqual(timing.batch_id, A2_BATCH_ID, 'timing batch_id drifted', 'BATCH_ID_DRIFT');
  validateTimingPassOrder(timing.passes);
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
  assertEqual(timing.events.length, A2_TIMING_PASS_IDS.length * 2, 'complete timing must persist one start and one stop event per pass', 'TIMING_EVENT_COVERAGE');
  const eventsByPass = new Map(A2_TIMING_PASS_IDS.map((id) => [id, []]));
  for (const event of timing.events) eventsByPass.get(event.pass_id).push(event);
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
  }
  return { status: 'complete', unmeasured_pass_count: 0 };
}

export function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}
