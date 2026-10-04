import { HOLD_REASONS, POS_VALUES } from '../intake/candidate-contract.mjs';
import { analysisInputDigest } from '../intake/pipeline.mjs';
import {
  PROPOSAL_CONTRACT,
  CANDIDATE_STATUSES,
  expectedAnalyzerDigest,
  isBatchId,
  isSha256,
  parseJsonl,
  sha256Hex,
  validateProviderFields,
} from './contract.mjs';

// Lemma-centered candidate contract (issue #275). It supersedes the per-usage v1 contract for
// batches created after it; merged v1 batches (the C000001 comparison cohort) stay valid as-is.
//
//   one candidate (`C…-NNNN`)  = one normalized citation-form lemma (표제어)
//   forms                      = observed (inflected) surface forms OF that lemma
//   usage_groups               = prospective sense/usage opportunities, one or more per POS
//   observations               = bounded, text-free, individually referenceable source hits
//
// contract.mjs and this module import each other; neither uses the other's bindings while
// evaluating, only inside functions, so the cycle is safe.
export const LEMMA_CANDIDATE_MANIFEST_CONTRACT = 'lexical-factory-candidate-manifest-v2';
export const LEMMA_POLICY = 'distinct-citation-lemma-v1';
export const MAX_OBSERVATIONS_PER_CANDIDATE = 64;
export const MAX_UNRESOLVED_OBSERVATIONS = 2000;
export const GROUP_BASES = Object.freeze(['pos-default', 'corpus-hint']);
// Analyzer outcomes that yield no reliable lemma/POS. Such an observation cannot be attached to a
// headword and is not counted as a resolved one; it is preserved in the manifest for verification.
export const UNRESOLVED_HOLDS = Object.freeze(['analysis_missing', 'analysis_stale', 'analysis_error', 'analysis_unsupported']);

const KOREAN_WORD = /^[가-힣]+$/u;
const TOKEN = /^[a-z0-9_-]{1,32}$/u;
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const suffix = (letter, ordinal) => `${letter}${String(ordinal).padStart(2, '0')}`;

export const isLemmaManifest = (manifest) => manifest?.contract === LEMMA_CANDIDATE_MANIFEST_CONTRACT;
// Shape test for rows (a v2 row never has a top-level `pos`).
export const isLemmaRow = (row) => Array.isArray(row?.observations);

export const formIdFor = (candidateId, ordinal) => `${candidateId}.${suffix('f', ordinal)}`;
export const groupIdFor = (candidateId, ordinal) => `${candidateId}.${suffix('g', ordinal)}`;
export const observationIdFor = (candidateId, ordinal) => `${candidateId}.${suffix('o', ordinal)}`;

// Key of one distinguishable observation; the digest of all keys binds evidence that a bounded
// selection omitted (the full set stays recoverable from the local text-free evidence).
export const observationKey = (pos, groupKey, surface, evidence) => [pos, groupKey, surface, evidence.kind, evidence.ref].join('\u0000');
export const observationSetDigest = (keys) => sha256Hex([...new Set(keys)].sort().join('\n'));

export function validateLemmaCandidateRecord(record, { batchId, ordinal }) {
  const id = `${batchId}-${String(ordinal).padStart(4, '0')}`;
  const at = `candidate ${id}`;
  const errors = [];
  if (record.candidate_id !== id) errors.push(`candidate ${id}: candidate_id must be ${id}, got ${record.candidate_id}`);
  if (typeof record.input !== 'string' || !KOREAN_WORD.test(record.input)) errors.push(`${at}: input must be a dictionary-form Korean lemma`);
  const allowed = new Set(['candidate_id', 'input', 'pos_hypotheses', 'forms', 'usage_groups', 'observations', 'observation_total', 'observation_digest']);
  for (const key of Object.keys(record)) if (!allowed.has(key)) errors.push(`${at}: unknown field ${key}`);

  const posList = record.pos_hypotheses;
  if (!Array.isArray(posList) || posList.length === 0 || posList.some((pos) => !POS_VALUES.includes(pos))
    || new Set(posList).size !== posList.length || JSON.stringify([...posList].sort()) !== JSON.stringify(posList)) {
    errors.push(`${at}: pos_hypotheses must be a sorted, unique, non-empty list of ${POS_VALUES.join(', ')}`);
    return errors;
  }

  const forms = Array.isArray(record.forms) ? record.forms : [];
  const formIds = new Set();
  if (forms.length === 0) errors.push(`${at}: forms must list at least one observed form of the lemma`);
  forms.forEach((form, index) => {
    if (!isPlainObject(form) || Object.keys(form).some((key) => key !== 'form_id' && key !== 'surface')) { errors.push(`${at}: forms[${index}] must be {form_id, surface}`); return; }
    if (form.form_id !== formIdFor(id, index + 1)) errors.push(`${at}: forms[${index}].form_id must be ${formIdFor(id, index + 1)}`);
    if (typeof form.surface !== 'string' || !form.surface || /\s/u.test(form.surface)) errors.push(`${at}: forms[${index}].surface must be a non-empty single token`);
    formIds.add(form.form_id);
  });
  if (new Set(forms.map((form) => form?.surface)).size !== forms.length) errors.push(`${at}: observed forms must be unique`);
  const surfaceOf = new Map(forms.map((form) => [form.form_id, form.surface]));

  const groups = Array.isArray(record.usage_groups) ? record.usage_groups : [];
  const groupPos = new Map();
  groups.forEach((group, index) => {
    if (!isPlainObject(group) || Object.keys(group).some((key) => !['group_id', 'pos', 'basis', 'hint'].includes(key))) { errors.push(`${at}: usage_groups[${index}] has unknown fields`); return; }
    if (group.group_id !== groupIdFor(id, index + 1)) errors.push(`${at}: usage_groups[${index}].group_id must be ${groupIdFor(id, index + 1)}`);
    if (!posList.includes(group.pos)) errors.push(`${at}: usage_groups[${index}].pos must be one of pos_hypotheses`);
    if (!GROUP_BASES.includes(group.basis)) errors.push(`${at}: usage_groups[${index}].basis must be one of ${GROUP_BASES.join(', ')}`);
    if (group.basis === 'corpus-hint' ? !TOKEN.test(String(group.hint)) : group.hint !== undefined) errors.push(`${at}: usage_groups[${index}] hint is required exactly for corpus-hint groups`);
    groupPos.set(group.group_id, group.pos);
  });
  for (const pos of posList) if (![...groupPos.values()].includes(pos)) errors.push(`${at}: POS hypothesis ${pos} has no usage group`);

  const observations = Array.isArray(record.observations) ? record.observations : [];
  if (observations.length === 0 || observations.length > MAX_OBSERVATIONS_PER_CANDIDATE) {
    errors.push(`${at}: observations must hold 1 to ${MAX_OBSERVATIONS_PER_CANDIDATE} bounded references`);
  }
  const usedForms = new Set();
  const usedGroups = new Set();
  const seen = new Set();
  observations.forEach((observation, index) => {
    const here = `${at} observation ${index + 1}`;
    const allowedKeys = ['observation_id', 'form_id', 'group_id', 'pos', 'evidence', 'analysis', 'holds'];
    if (!isPlainObject(observation) || Object.keys(observation).some((key) => !allowedKeys.includes(key))) { errors.push(`${here}: unknown or missing fields`); return; }
    if (observation.observation_id !== observationIdFor(id, index + 1)) errors.push(`${here}: observation_id must be ${observationIdFor(id, index + 1)}`);
    if (!formIds.has(observation.form_id)) errors.push(`${here}: form_id does not name an observed form`);
    if (!groupPos.has(observation.group_id)) errors.push(`${here}: group_id does not name a usage group`);
    else if (groupPos.get(observation.group_id) !== observation.pos) errors.push(`${here}: pos differs from its usage group`);
    usedForms.add(observation.form_id);
    usedGroups.add(observation.group_id);
    const evidence = observation.evidence;
    if (!isPlainObject(evidence) || typeof evidence.kind !== 'string' || typeof evidence.ref !== 'string' || !evidence.kind || !evidence.ref
      || Object.keys(evidence).some((key) => key !== 'kind' && key !== 'ref')) {
      errors.push(`${here}: evidence must be a text-free reference (kind, ref only)`);
    } else {
      const key = [observation.form_id, observation.group_id, evidence.kind, evidence.ref].join('\u0000');
      if (seen.has(key)) errors.push(`${here}: repeats identical source evidence`);
      seen.add(key);
    }
    const analysis = observation.analysis;
    if (!isPlainObject(analysis) || analysis.status !== 'ok' || !isSha256(analysis.input_digest) || Object.keys(analysis).length !== 2) {
      errors.push(`${here}: analysis must be {status: ok, input_digest}; an unresolved analysis is not a lemma observation`);
    } else if (surfaceOf.has(observation.form_id) && analysis.input_digest !== analysisInputDigest(surfaceOf.get(observation.form_id))) {
      errors.push(`${here}: analysis.input_digest does not bind the observed form`);
    }
    if (!Array.isArray(observation.holds) || observation.holds.some((hold) => !HOLD_REASONS.includes(hold) || UNRESOLVED_HOLDS.includes(hold))
      || JSON.stringify([...new Set(observation.holds)].sort()) !== JSON.stringify(observation.holds)) {
      errors.push(`${here}: holds must be sorted known hold reasons (unresolved-analysis reasons belong to unresolved_observations)`);
    }
  });
  for (const formId of formIds) if (!usedForms.has(formId)) errors.push(`${at}: observed form ${formId} has no observation`);
  for (const group of groups) if (!usedGroups.has(group.group_id)) errors.push(`${at}: usage group ${group.group_id} has no observation (a sense opportunity may not be erased)`);

  if (!Number.isInteger(record.observation_total) || record.observation_total < observations.length) errors.push(`${at}: observation_total must cover the retained observations`);
  if (!isSha256(record.observation_digest)) errors.push(`${at}: observation_digest must be sha256 hex`);
  else if (record.observation_total === observations.length && errors.length === 0) {
    const keys = observations.map((observation) => {
      const group = groups.find((entry) => entry.group_id === observation.group_id);
      return observationKey(observation.pos, group.hint ?? '', surfaceOf.get(observation.form_id), observation.evidence);
    });
    if (observationSetDigest(keys) !== record.observation_digest) errors.push(`${at}: observation_digest does not match the retained observations`);
  }
  return errors;
}

function validateUnresolved(list) {
  const errors = [];
  if (!Array.isArray(list)) return ['candidate manifest: unresolved_observations must be an array'];
  if (list.length > MAX_UNRESOLVED_OBSERVATIONS) errors.push(`candidate manifest: more than ${MAX_UNRESOLVED_OBSERVATIONS} unresolved observations`);
  list.forEach((entry, index) => {
    const at = `candidate manifest: unresolved_observations[${index}]`;
    if (!isPlainObject(entry) || Object.keys(entry).some((key) => !['surface', 'evidence', 'holds'].includes(key))) { errors.push(`${at} must be {surface, evidence, holds}`); return; }
    if (typeof entry.surface !== 'string' || !entry.surface) errors.push(`${at}: surface is required`);
    if (!isPlainObject(entry.evidence) || !entry.evidence.kind || !entry.evidence.ref || Object.keys(entry.evidence).some((key) => key !== 'kind' && key !== 'ref')) errors.push(`${at}: text-free evidence reference required`);
    if (!Array.isArray(entry.holds) || entry.holds.length === 0 || entry.holds.some((hold) => !UNRESOLVED_HOLDS.includes(hold))) errors.push(`${at}: holds must name an unresolved-analysis reason`);
  });
  return errors;
}

export function validateLemmaCandidateBatch({ manifest, candidatesText }) {
  const errors = [];
  const required = ['contract', 'lemma_policy', 'task_id', 'batch_id', 'candidate_count', 'observation_count', 'selection',
    'unresolved_observations', 'source_adapter', 'source_snapshot', 'canonical_snapshot_digest', 'extractor_version',
    'analyzer_version', 'analyzer_digest', 'proposal_contract', 'source_evidence_sha256', 'candidates_sha256', 'status'];
  for (const key of required) if (manifest[key] === undefined) errors.push(`candidate manifest: missing ${key}`);
  if (errors.length) return errors;
  if (manifest.lemma_policy !== LEMMA_POLICY) errors.push(`candidate manifest: lemma_policy must be ${LEMMA_POLICY}`);
  if (!isBatchId(manifest.batch_id)) errors.push('candidate manifest: batch_id must match C000000');
  if (!CANDIDATE_STATUSES.includes(manifest.status)) errors.push(`candidate manifest: status must be one of ${CANDIDATE_STATUSES.join(', ')}`);
  for (const key of ['candidates_sha256', 'canonical_snapshot_digest', 'source_evidence_sha256']) {
    if (!isSha256(manifest[key])) errors.push(`candidate manifest: ${key} must be sha256 hex`);
  }
  if (manifest.proposal_contract !== PROPOSAL_CONTRACT) errors.push(`candidate manifest: proposal_contract must be ${PROPOSAL_CONTRACT}`);
  if (!isSha256(manifest.analyzer_digest) || manifest.analyzer_digest !== expectedAnalyzerDigest(manifest)) {
    errors.push('candidate manifest: analyzer_digest must bind the pinned analyzer and proposal_contract');
  }
  errors.push(...validateProviderFields(manifest));
  if (!/^kiwipiepy==\d+\.\d+\.\d+$/u.test(String(manifest.analyzer_version))) errors.push('candidate manifest: analyzer_version must be a pinned kiwipiepy==X.Y.Z');
  for (const key of ['task_id', 'source_adapter', 'source_snapshot', 'extractor_version']) {
    if (typeof manifest[key] !== 'string' || manifest[key].length === 0) errors.push(`candidate manifest: ${key} must be a non-empty string`);
  }
  for (const key of ['candidate_count', 'observation_count']) {
    if (!Number.isInteger(manifest[key]) || manifest[key] < 1) errors.push(`candidate manifest: ${key} must be a positive integer`);
  }
  const selection = manifest.selection;
  if (!isPlainObject(selection) || Object.keys(selection).sort().join() !== 'bound,deferred_lemma_count,eligible_lemma_count'
    || !Number.isInteger(selection.bound) || selection.bound < 1
    || !Number.isInteger(selection.eligible_lemma_count) || !Number.isInteger(selection.deferred_lemma_count)) {
    errors.push('candidate manifest: selection must be {bound, eligible_lemma_count, deferred_lemma_count}');
  } else {
    if (manifest.candidate_count > selection.bound) errors.push('candidate manifest: candidate_count exceeds the selection bound');
    if (selection.eligible_lemma_count !== manifest.candidate_count + selection.deferred_lemma_count) errors.push('candidate manifest: eligible lemmas must equal candidates plus deferred lemmas');
  }
  errors.push(...validateUnresolved(manifest.unresolved_observations));
  if (typeof candidatesText !== 'string') return [...errors, 'candidates.jsonl is missing'];
  if (sha256Hex(candidatesText) !== manifest.candidates_sha256) errors.push('candidates.jsonl bytes do not match candidates_sha256');
  const rows = parseJsonl(candidatesText, 'candidates.jsonl', errors);
  if (rows.length !== manifest.candidate_count) errors.push(`candidates.jsonl has ${rows.length} rows but candidate_count is ${manifest.candidate_count}`);
  const lemmas = new Set();
  let observations = 0;
  rows.forEach((row, index) => {
    errors.push(...validateLemmaCandidateRecord(row, { batchId: manifest.batch_id, ordinal: index + 1 }));
    if (lemmas.has(row.input)) errors.push(`candidate ${row.candidate_id}: lemma ${row.input} repeats within the batch (one candidate per lemma)`);
    lemmas.add(row.input);
    if (index > 0 && !(rows[index - 1].input < row.input)) errors.push(`candidate ${row.candidate_id}: rows must be ordered by lemma`);
    observations += Number.isInteger(row.observation_total) ? row.observation_total : 0;
  });
  if (observations !== manifest.observation_count) errors.push(`candidate manifest: observation_count ${manifest.observation_count} differs from the rows' observation_total ${observations}`);
  return errors;
}
