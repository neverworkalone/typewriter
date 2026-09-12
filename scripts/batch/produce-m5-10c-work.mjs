/**
 * Proposal-only producer for M5-10C.
 *
 * This module may expose source-bound proposal facts, but it deliberately does
 * not decide inclusion, correction, relation cleanliness, or audit status.
 * Editorial and audit artifacts are authored separately and are checked by
 * validate-m5-10c-recovery.mjs.
 */

import { createHash } from 'node:crypto';

export const M5_10C_PRODUCER_VERSION = 'm5-10c-proposal-producer-v1';

const FORBIDDEN_VERDICT_KEYS = Object.freeze([
  'decision',
  'verdict',
  'clean',
  'noise_assessment',
  'correction',
  'audit',
  'approved',
  'included',
  'rejected',
  'held',
  'status',
]);

const RECORD_ID_PATTERN = /^cal-m5-10c-[0-9]{3}$/u;
const SENSE_ID_PATTERN = /^cal-m5-10c-[0-9]{3}-s[0-9]+$/u;
const CASE_ID_PATTERN = /^m5-10c-cal-[0-9]{3}$/u;

function fail(message) {
  throw new Error(message);
}
function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) fail(`${label} must be a non-empty string`);
  return value;
}

function assertNoVerdictKeys(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_VERDICT_KEYS.includes(key)) fail(`${label} contains forbidden editorial verdict key ${key}`);
    assertNoVerdictKeys(value[key], `${label}.${key}`);
  }
}

function assertSenseIds(input) {
  if (!Array.isArray(input.source_sense_ids) || input.source_sense_ids.length < 1) {
    fail('proposal input must include source_sense_ids');
  }
  if (input.source_sense_ids.some((id) => !SENSE_ID_PATTERN.test(id))) {
    fail('proposal input contains an invalid source sense ID');
  }
}

function assertCandidate(candidate, sourceSenseIds) {
  if (candidate === null || candidate === undefined) return null;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) fail('relation_candidate must be an object or null');
  for (const field of ['source_sense', 'target_record', 'target_sense', 'type', 'direction']) {
    if (candidate[field] === undefined) fail(`relation_candidate is missing ${field}`);
  }
  if (!sourceSenseIds.includes(candidate.source_sense)) fail('relation candidate source sense is not in the proposal record');
  if (!RECORD_ID_PATTERN.test(candidate.target_record) || !SENSE_ID_PATTERN.test(candidate.target_sense)) {
    fail('relation candidate target ID is invalid');
  }
  if (!['direct', 'near', 'mood', 'scene', 'sensory', 'action', 'association', 'antonym'].includes(candidate.type)) {
    fail('relation candidate type is invalid');
  }
  if (candidate.direction.from !== candidate.source_sense || candidate.direction.to !== candidate.target_sense) {
    fail('relation candidate direction does not match its source and target senses');
  }
  return {
    source_sense: candidate.source_sense,
    target_record: candidate.target_record,
    target_sense: candidate.target_sense,
    type: candidate.type,
    direction: {
      from: candidate.direction.from,
      to: candidate.direction.to,
    },
  };
}

export function proposalInputFromCase(caseRecord) {
  if (!caseRecord || typeof caseRecord !== 'object' || Array.isArray(caseRecord)) fail('proposal case must be an object');
  const record = caseRecord.record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('proposal case is missing its record');
  const sourceSenseIds = record.senses?.map(({ id }) => id) ?? [];
  const compact = {
    phase: 'proposal',
    case_id: caseRecord.case_id,
    record_id: record.id,
    source_record_sha256: sha256Json(record),
    source_sense_ids: sourceSenseIds,
    source_pos: record.senses.map(({ pos }) => pos),
    relation_candidate: caseRecord.relation_candidate ?? null,
  };
  assertNoVerdictKeys(compact, 'proposal input');
  return compact;
}

export function produce({ unitId, unitKind, input } = {}) {
  requireString(unitId, 'unitId');
  requireString(unitKind, 'unitKind');
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('proposal input must be an object');
  assertNoVerdictKeys(input, 'proposal input');
  if (input.phase !== 'proposal') fail('M5-10C producer accepts proposal facts only');
  if (!CASE_ID_PATTERN.test(requireString(input.case_id, 'proposal input.case_id'))) fail('proposal input.case_id is invalid');
  if (!RECORD_ID_PATTERN.test(requireString(input.record_id, 'proposal input.record_id'))) fail('proposal input.record_id is invalid');
  if (!/^[a-f0-9]{64}$/u.test(requireString(input.source_record_sha256, 'proposal input.source_record_sha256'))) {
    fail('proposal input.source_record_sha256 is invalid');
  }
  assertSenseIds(input);
  const candidate = assertCandidate(input.relation_candidate ?? null, input.source_sense_ids);
  if (candidate && candidate.target_record === input.record_id) fail('relation candidate cannot target its own proposal record');
  return {
    producer_version: M5_10C_PRODUCER_VERSION,
    phase: 'proposal',
    unit_id: unitId,
    unit_kind: unitKind,
    case_id: input.case_id,
    record_id: input.record_id,
    source_record_sha256: input.source_record_sha256,
    source_sense_ids: [...input.source_sense_ids],
    source_pos: [...(input.source_pos ?? [])],
    relation_candidate: candidate,
    proposal_only: true,
  };
}
