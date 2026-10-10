import { createHash } from 'node:crypto';

import { HOLD_REASONS, POS_VALUES, digest } from '../intake/candidate-contract.mjs';
import { PINNED_RUN, analyzerDigest } from '../intake/pipeline.mjs';
import { LEMMA_CANDIDATE_MANIFEST_CONTRACT, validateLemmaCandidateBatch } from './lemma-contract.mjs';
import { COMPACT_CONTRACT } from './permanent-trash.mjs';
import { RESOLUTION_POLICY, createKiwiProvider, providerDescriptor } from './analyzer-providers.mjs';
import { ENSEMBLE_POLICY, ENSEMBLE_PROVIDER_ORDER } from './ensemble-resolver.mjs';
import { KHAIII_RUNTIMES, createKhaiiiProvider } from './khaiii-provider.mjs';
import { createMecabProvider } from './mecab-provider.mjs';

// Lexical production factory contracts (issue #263, design: docs/lexical-production-factory.md).
// This file holds the per-usage v1 candidate contract (historical, e.g. the C000001 comparison
// cohort) and the contracts shared by both versions; the lemma-centered v2 contract of issue #275
// lives in lemma-contract.mjs.
// Factory ids (C…) never reuse canonical `w…` ids or the canonical `candidate_id` field.
export const CANDIDATE_MANIFEST_CONTRACT = 'lexical-factory-candidate-manifest-v1';
export const REVIEW_MANIFEST_CONTRACT = 'lexical-factory-review-manifest-v1';
// `held` (owner-directed exception) is deliberately not accepted: there is no verifiable owner-
// authorization field yet, so an unauthorized hold must fail instead of being trusted.
export const CANDIDATE_STATUSES = Object.freeze(['created', 'complete']);
export const REVIEW_STATUSES = Object.freeze(['ready', 'complete', 'rejected']);
export const DISPOSITIONS = Object.freeze(['included', 'corrected', 'held', 'rejected', 'deferred']);
export const TARGET_KINDS = Object.freeze(['new_entry', 'new_pos_on_existing_lemma', 'new_sense_on_existing_entry']);
export const MAX_EVIDENCE_REFERENCES = 5;
// Semantics of the Kiwi proposals Stage 1 interprets (`derived_from*`); see docs/lexical-factory-contracts.md.
export const PROPOSAL_CONTRACT = 'derivation-root-v1';

// The analyzer digest a Stage 1 manifest must carry: the shared analyzer digest of the pinned run
// for its `analyzer_version`, bound to the proposal contract.
export function expectedAnalyzerDigest(manifest) {
  const version = String(manifest.analyzer_version ?? '').replace(/^kiwipiepy==/u, '');
  const base = digest([analyzerDigest({ ...PINNED_RUN, kiwipiepy_version: version, kiwipiepy_model_version: version }), manifest.proposal_contract]);
  // A non-default provider order binds the ordered provider identities and the resolution policy,
  // so a different provider/model/policy can never share a digest with Kiwi-only output.
  return manifest.analyzer_providers === undefined ? base
    : digest([base, 'providers', JSON.stringify(manifest.analyzer_providers), manifest.resolution_policy]);
}

// Optional `analyzer_providers`/`resolution_policy` (absent for the default [kiwi] order).
export function validateProviderFields(manifest) {
  if (manifest.analyzer_providers === undefined && manifest.resolution_policy === undefined) return [];
  const errors = [];
  const list = manifest.analyzer_providers;
  if (manifest.resolution_policy === ENSEMBLE_POLICY) return validateEnsembleProviders(list);
  if (!Array.isArray(list) || list.length < 2) return ['candidate manifest: analyzer_providers must list at least two ordered providers (omit it for the default kiwi order)'];
  const ids = list.map((entry) => entry?.provider_id);
  if (list.some((entry) => !isPlainObject(entry) || Object.keys(entry).sort().join() !== 'identity_digest,provider_id'
    || typeof entry.provider_id !== 'string' || !isSha256(entry.identity_digest))) errors.push('candidate manifest: analyzer_providers entries need provider_id and sha256 identity_digest only');
  if (new Set(ids).size !== ids.length) errors.push('candidate manifest: analyzer_providers must not repeat a provider');
  const kiwi = providerDescriptor(createKiwiProvider());
  if (!list.some((entry) => entry?.provider_id === 'kiwi' && entry.identity_digest === kiwi.identity_digest)) errors.push('candidate manifest: analyzer_providers must include the pinned kiwi provider');
  if (manifest.resolution_policy !== RESOLUTION_POLICY) errors.push(`candidate manifest: resolution_policy must be ${RESOLUTION_POLICY}`);
  return errors;
}

// The ensemble policy (issue #285) runs ALL three pinned providers on every eligible surface, in a
// fixed order: a manifest that omits, reorders, duplicates or replaces one provider cannot validate.
function validateEnsembleProviders(list) {
  const ids = Array.isArray(list) ? list.map((entry) => entry?.provider_id) : [];
  if (JSON.stringify(ids) !== JSON.stringify(ENSEMBLE_PROVIDER_ORDER)) return [`candidate manifest: the ensemble policy requires analyzer_providers exactly ${ENSEMBLE_PROVIDER_ORDER.join(',')} in that order`];
  const errors = [];
  if (list.some((entry) => !isPlainObject(entry) || Object.keys(entry).sort().join() !== 'identity_digest,provider_id' || !isSha256(entry.identity_digest))) errors.push('candidate manifest: analyzer_providers entries need provider_id and sha256 identity_digest only');
  const pinned = {
    kiwi: [providerDescriptor(createKiwiProvider()).identity_digest],
    khaiii: KHAIII_RUNTIMES.map((runtime) => providerDescriptor(createKhaiiiProvider({ runtime, analyze: async () => ({}) })).identity_digest),
    mecab: [providerDescriptor(createMecabProvider({ analyze: async () => ({}) })).identity_digest],
  };
  list.forEach((entry) => { if (!pinned[entry.provider_id].includes(entry.identity_digest)) errors.push(`candidate manifest: ${entry.provider_id} identity_digest is not the pinned ${entry.provider_id} provider`); });
  return errors;
}

// Operational fields: excluded from every content digest (design §7.3).
export const MUTABLE_MANIFEST_FIELDS = Object.freeze(['status', 'rejected_pr', 'attempt', 'history', 'contract_repairs']);

// Shared-contract changes that may legitimately require an already merged `ready` review to be
// re-bound without a new attempt (see validateContractRepair in transitions.mjs). Each kind names
// the only authored fields that repair may add.
export const CONTRACT_REPAIR_KINDS = Object.freeze(['scope_declaration']);

// Paths whose change on master can invalidate a Stage 2 result that was authored against the older
// contract. A result PR whose branch point predates such a change must be re-synchronised before merge.
export const SHARED_FACTORY_CONTRACT_PATHS = Object.freeze(['scripts/factory/', 'scripts/validate/', 'scripts/batch/', 'scripts/intake/', 'schema/']);

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
  if (text === '') return rows; // zero rows; enclosing contracts enforce their count/state
  if (typeof text !== 'string' || !text.endsWith('\n')) {
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

export function validateCandidateBatch({ manifest, candidatesText, maxUnresolved, allowEmpty }) {
  const errors = [];
  if (!isPlainObject(manifest)) return ['candidate manifest must be an object'];
  // v2 (lemma-centered, issue #275) batches; the per-usage v1 contract below stays valid for merged history.
  if ([LEMMA_CANDIDATE_MANIFEST_CONTRACT, COMPACT_CONTRACT].includes(manifest.contract)) return validateLemmaCandidateBatch({ manifest, candidatesText, maxUnresolved, allowEmpty });
  const required = ['contract', 'task_id', 'batch_id', 'candidate_count', 'source_adapter', 'source_snapshot',
    'canonical_snapshot_digest', 'extractor_version', 'analyzer_version', 'analyzer_digest', 'proposal_contract',
    'source_evidence_sha256', 'candidates_sha256', 'status'];
  for (const key of required) if (manifest[key] === undefined) errors.push(`candidate manifest: missing ${key}`);
  if (errors.length) return errors;
  if (manifest.contract !== CANDIDATE_MANIFEST_CONTRACT) errors.push(`candidate manifest: contract must be ${CANDIDATE_MANIFEST_CONTRACT}`);
  if (!isBatchId(manifest.batch_id)) errors.push('candidate manifest: batch_id must match C000000');
  if (!CANDIDATE_STATUSES.includes(manifest.status)) errors.push(`candidate manifest: status must be one of ${CANDIDATE_STATUSES.join(', ')}`);
  if (!isSha256(manifest.candidates_sha256)) errors.push('candidate manifest: candidates_sha256 must be sha256 hex');
  if (!isSha256(manifest.canonical_snapshot_digest)) errors.push('candidate manifest: canonical_snapshot_digest must be sha256 hex');
  if (manifest.proposal_contract !== PROPOSAL_CONTRACT) errors.push(`candidate manifest: proposal_contract must be ${PROPOSAL_CONTRACT}`);
  if (!isSha256(manifest.source_evidence_sha256)) errors.push('candidate manifest: source_evidence_sha256 must be sha256 hex');
  if (!isSha256(manifest.analyzer_digest) || manifest.analyzer_digest !== expectedAnalyzerDigest(manifest)) {
    errors.push('candidate manifest: analyzer_digest must bind the pinned analyzer and proposal_contract');
  }
  errors.push(...validateProviderFields(manifest));
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
  errors.push(...validateContractRepairs(manifest));
  if (manifest.status === 'rejected') {
    if (!isPositiveInteger(manifest.rejected_pr)) errors.push('review manifest: rejected requires a numeric rejected_pr');
  } else if (manifest.rejected_pr !== undefined) {
    errors.push('review manifest: rejected_pr is only valid while status is rejected');
  }
  if (manifest.status === 'complete') {
    if (!manifest.admission || manifest.admission.contract !== 'lexical-factory-admission-v1') {
      errors.push('review manifest: complete requires a Stage 3 admission mapping');
    }
  } else if (manifest.admission !== undefined) {
    errors.push('review manifest: admission mapping is only valid while status is complete');
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

// `contract_repairs` is an append-only chain of semantic-decision re-bindings after a shared
// contract change; its last link must be the current semantic_decisions_sha256.
export function validateContractRepairs(manifest) {
  if (manifest.contract_repairs === undefined) return [];
  if (!Array.isArray(manifest.contract_repairs) || manifest.contract_repairs.length === 0) return ['review manifest: contract_repairs must be a non-empty array when present'];
  const errors = [];
  let expectedBefore = null;
  manifest.contract_repairs.forEach((entry, index) => {
    const at = `review manifest: contract_repairs[${index}]`;
    if (!isPlainObject(entry) || Object.keys(entry).sort().join() !== 'contract,previous_semantic_decisions_sha256,semantic_decisions_sha256'
      || !CONTRACT_REPAIR_KINDS.includes(entry.contract) || !isSha256(entry.previous_semantic_decisions_sha256) || !isSha256(entry.semantic_decisions_sha256)) {
      errors.push(`${at} must be {contract (${CONTRACT_REPAIR_KINDS.join('|')}), previous_semantic_decisions_sha256, semantic_decisions_sha256}`);
      return;
    }
    if (expectedBefore !== null && entry.previous_semantic_decisions_sha256 !== expectedBefore) errors.push(`${at} does not continue the previous repair`);
    expectedBefore = entry.semantic_decisions_sha256;
  });
  if (expectedBefore !== null && expectedBefore !== manifest.semantic_decisions_sha256) errors.push('review manifest: the last contract repair must produce the current semantic_decisions_sha256');
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
