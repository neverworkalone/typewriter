import { createHash } from 'node:crypto';

import { HOLD_REASONS, POS_VALUES } from '../intake/candidate-contract.mjs';

// Lexical production factory contracts (issue #263, design: docs/lexical-production-factory.md).
// Factory ids (C…) never reuse canonical `w…` ids or the canonical `candidate_id` field.
export const CANDIDATE_MANIFEST_CONTRACT = 'lexical-factory-candidate-manifest-v1';
export const REVIEW_MANIFEST_CONTRACT = 'lexical-factory-review-manifest-v1';
export const CANDIDATE_STATUSES = Object.freeze(['created', 'complete', 'held']);
export const REVIEW_STATUSES = Object.freeze(['ready', 'complete', 'rejected']);
export const DISPOSITIONS = Object.freeze(['included', 'corrected', 'held', 'rejected', 'deferred']);
export const TARGET_KINDS = Object.freeze(['new_entry', 'new_pos_on_existing_lemma', 'new_sense_on_existing_entry']);
export const MAX_EVIDENCE_REFERENCES = 5;

// Operational fields: excluded from every content digest (design §7.3).
export const MUTABLE_MANIFEST_FIELDS = Object.freeze(['status', 'rejected_pr', 'attempt', 'history']);

const BATCH_ID = /^C\d{6}$/u;
const CANDIDATE_ID = /^(C\d{6})-(\d{4})$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const KOREAN_WORD = /^[가-힣]+$/u;

export class FactoryContractError extends Error {
  constructor(errors) {
    super(`Factory contract violation: ${errors.join('; ')}`);
    this.name = 'FactoryContractError';
    this.errors = errors;
  }
}

export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');
export const isSha256 = (value) => typeof value === 'string' && SHA256.test(value);
export const isBatchId = (value) => typeof value === 'string' && BATCH_ID.test(value);
export const candidateIdFor = (batchId, ordinal) => `${batchId}-${String(ordinal).padStart(4, '0')}`;

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isInteger(value) && value >= 1;

// Digest of manifest content with every operational field removed, so a
// status-only transition provably leaves the content digest unchanged.
export function manifestContentDigest(manifest) {
  const content = Object.fromEntries(
    Object.entries(manifest).filter(([key]) => !MUTABLE_MANIFEST_FIELDS.includes(key)).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  return sha256Hex(JSON.stringify(content));
}

export function parseJsonl(text, label, errors) {
  const rows = [];
  if (typeof text !== 'string' || text.length === 0 || !text.endsWith('\n')) {
    errors.push(`${label}: must be non-empty newline-terminated JSONL`);
    return rows;
  }
  text.slice(0, -1).split('\n').forEach((line, index) => {
    try {
      const row = JSON.parse(line);
      if (!isPlainObject(row)) errors.push(`${label}:${index + 1}: row must be an object`);
      else rows.push(row);
    } catch {
      errors.push(`${label}:${index + 1}: invalid JSON`);
    }
  });
  return rows;
}

export function validateCandidateRecord(record, { batchId, ordinal }) {
  const errors = [];
  const id = candidateIdFor(batchId, ordinal);
  if (record.candidate_id !== id) errors.push(`candidate ${id}: candidate_id must be ${id}, got ${record.candidate_id}`);
  else if (!CANDIDATE_ID.test(record.candidate_id)) errors.push(`candidate ${id}: malformed candidate_id`);
  const at = `candidate ${id}`;
  if (typeof record.input !== 'string' || !KOREAN_WORD.test(record.input)) errors.push(`${at}: input must be a dictionary-form Korean word`);
  if (!POS_VALUES.includes(record.pos)) errors.push(`${at}: pos must be one of ${POS_VALUES.join(', ')}`);
  if (typeof record.usage_hint !== 'string' || record.usage_hint.length === 0) errors.push(`${at}: usage_hint is required`);
  if (!Array.isArray(record.observedForms) || record.observedForms.some((form) => typeof form !== 'string' || !form)) errors.push(`${at}: observedForms must be non-empty strings`);
  if (!Array.isArray(record.holds) || record.holds.some((hold) => !HOLD_REASONS.includes(hold))) errors.push(`${at}: holds must use known hold reasons`);
  if (!Array.isArray(record.evidence) || record.evidence.length > MAX_EVIDENCE_REFERENCES) {
    errors.push(`${at}: evidence must be an array of at most ${MAX_EVIDENCE_REFERENCES} references`);
  } else {
    for (const entry of record.evidence) {
      if (!isPlainObject(entry) || typeof entry.kind !== 'string' || typeof entry.ref !== 'string' || !entry.kind || !entry.ref) errors.push(`${at}: evidence entries need kind and ref`);
      else if (Object.keys(entry).some((key) => key !== 'kind' && key !== 'ref')) errors.push(`${at}: evidence must be text-free references (kind, ref only)`);
    }
  }
  const allowed = new Set(['candidate_id', 'input', 'pos', 'usage_hint', 'observedForms', 'evidence', 'holds']);
  for (const key of Object.keys(record)) if (!allowed.has(key)) errors.push(`${at}: unknown field ${key}`);
  return errors;
}

export function validateCandidateBatch({ manifest, candidatesText }) {
  const errors = [];
  if (!isPlainObject(manifest)) return ['candidate manifest must be an object'];
  const required = ['contract', 'task_id', 'batch_id', 'candidate_count', 'source_adapter', 'source_snapshot',
    'canonical_snapshot_digest', 'extractor_version', 'analyzer_version', 'candidates_sha256', 'status'];
  for (const key of required) if (manifest[key] === undefined) errors.push(`candidate manifest: missing ${key}`);
  if (errors.length) return errors;
  if (manifest.contract !== CANDIDATE_MANIFEST_CONTRACT) errors.push(`candidate manifest: contract must be ${CANDIDATE_MANIFEST_CONTRACT}`);
  if (!isBatchId(manifest.batch_id)) errors.push('candidate manifest: batch_id must match C000000');
  if (!CANDIDATE_STATUSES.includes(manifest.status)) errors.push(`candidate manifest: status must be one of ${CANDIDATE_STATUSES.join(', ')}`);
  if (!isSha256(manifest.candidates_sha256)) errors.push('candidate manifest: candidates_sha256 must be sha256 hex');
  if (!isSha256(manifest.canonical_snapshot_digest)) errors.push('candidate manifest: canonical_snapshot_digest must be sha256 hex');
  if (manifest.analyzer_version !== undefined && !/^kiwipiepy==\d+\.\d+\.\d+$/u.test(String(manifest.analyzer_version))) errors.push('candidate manifest: analyzer_version must be a pinned kiwipiepy==X.Y.Z');
  for (const key of ['task_id', 'source_adapter', 'source_snapshot', 'extractor_version']) {
    if (typeof manifest[key] !== 'string' || manifest[key].length === 0) errors.push(`candidate manifest: ${key} must be a non-empty string`);
  }
  if (!isPositiveInteger(manifest.candidate_count)) errors.push('candidate manifest: candidate_count must be a positive integer');
  if (typeof candidatesText !== 'string') return [...errors, 'candidates.jsonl is missing'];
  if (sha256Hex(candidatesText) !== manifest.candidates_sha256) errors.push('candidates.jsonl bytes do not match candidates_sha256');
  const rows = parseJsonl(candidatesText, 'candidates.jsonl', errors);
  if (rows.length !== manifest.candidate_count) errors.push(`candidates.jsonl has ${rows.length} rows but candidate_count is ${manifest.candidate_count}`);
  const seen = new Set();
  rows.forEach((row, index) => {
    errors.push(...validateCandidateRecord(row, { batchId: manifest.batch_id, ordinal: index + 1 }));
    if (seen.has(row.candidate_id)) errors.push(`duplicate candidate_id ${row.candidate_id}`);
    seen.add(row.candidate_id);
  });
  return errors;
}

export function validateReviewManifest(manifest, { candidateManifest, decisionsText, semanticDecisionsText, handoffText } = {}) {
  const errors = [];
  if (!isPlainObject(manifest)) return ['review manifest must be an object'];
  const required = ['contract', 'batch_id', 'candidates_sha256', 'canonical_snapshot_digest', 'decisions_sha256',
    'semantic_decisions_sha256', 'handoff_sha256', 'attempt', 'status', 'history'];
  for (const key of required) if (manifest[key] === undefined) errors.push(`review manifest: missing ${key}`);
  if (errors.length) return errors;
  if (manifest.contract !== REVIEW_MANIFEST_CONTRACT) errors.push(`review manifest: contract must be ${REVIEW_MANIFEST_CONTRACT}`);
  if (!isBatchId(manifest.batch_id)) errors.push('review manifest: batch_id must match C000000');
  if (!REVIEW_STATUSES.includes(manifest.status)) errors.push(`review manifest: status must be one of ${REVIEW_STATUSES.join(', ')}`);
  if (!isPositiveInteger(manifest.attempt)) errors.push('review manifest: attempt must be a positive integer');
  for (const key of ['candidates_sha256', 'canonical_snapshot_digest', 'decisions_sha256', 'semantic_decisions_sha256', 'handoff_sha256']) {
    if (!isSha256(manifest[key])) errors.push(`review manifest: ${key} must be sha256 hex`);
  }
  errors.push(...validateHistory(manifest));
  if (manifest.status === 'rejected') {
    if (!isPositiveInteger(manifest.rejected_pr)) errors.push('review manifest: rejected requires a numeric rejected_pr');
  } else if (manifest.rejected_pr !== undefined) {
    errors.push('review manifest: rejected_pr is only valid while status is rejected');
  }
  if (candidateManifest) {
    if (candidateManifest.batch_id !== manifest.batch_id) errors.push('review manifest: batch_id differs from candidate manifest');
    if (candidateManifest.candidates_sha256 !== manifest.candidates_sha256) errors.push('review manifest: candidates_sha256 differs from candidate manifest');
  }
  for (const [text, key, label] of [[decisionsText, 'decisions_sha256', 'decisions.jsonl'],
    [semanticDecisionsText, 'semantic_decisions_sha256', 'semantic-decisions.json'], [handoffText, 'handoff_sha256', 'intake-handoff.json']]) {
    if (typeof text !== 'string') errors.push(`${label} is missing`);
    else if (sha256Hex(text) !== manifest[key]) errors.push(`${label} bytes do not match ${key}`);
  }
  return errors;
}

// `history` lists one {attempt, rejected_pr} per rejected attempt, oldest first.
export function validateHistory(manifest) {
  const errors = [];
  if (!Array.isArray(manifest.history)) return ['review manifest: history must be an array'];
  manifest.history.forEach((entry, index) => {
    if (!isPlainObject(entry) || entry.attempt !== index + 1 || !isPositiveInteger(entry.rejected_pr)) {
      errors.push(`review manifest: history[${index}] must be {attempt: ${index + 1}, rejected_pr}`);
    }
  });
  const rejectedAttempts = manifest.status === 'rejected' ? manifest.attempt : manifest.attempt - 1;
  if (manifest.history.length !== rejectedAttempts) errors.push(`review manifest: history must record ${rejectedAttempts} rejected attempt(s)`);
  if (manifest.status === 'rejected' && manifest.history.at(-1)?.rejected_pr !== manifest.rejected_pr) {
    errors.push('review manifest: rejected_pr must equal the latest history entry');
  }
  return errors;
}

export function validateDecisionRows(rows, candidateIds) {
  const errors = [];
  const seen = new Set();
  rows.forEach((row, index) => {
    const id = row.source_candidate_id;
    if (!candidateIds.includes(id)) errors.push(`decision ${index + 1}: unknown source_candidate_id ${id}`);
    if (seen.has(id)) errors.push(`decision ${index + 1}: duplicate decision for ${id}`);
    seen.add(id);
    if (candidateIds[index] !== id) errors.push(`decision ${index + 1}: rows must follow candidate order`);
  });
  for (const id of candidateIds) if (!seen.has(id)) errors.push(`missing decision row for ${id}`);
  return errors;
}

export function assertNoErrors(errors) {
  if (errors.length) throw new FactoryContractError(errors);
}
