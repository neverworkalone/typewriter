import { HOLD_REASONS, POS_VALUES } from '../intake/candidate-contract.mjs';
import { analysisInputDigest } from '../intake/pipeline.mjs';
import {
  CATEGORIES,
  ENSEMBLE_CONTRACT,
  LEGACY_ENSEMBLE_CONTRACT,
  ENSEMBLE_MANIFEST_KEYS,
  ENSEMBLE_POLICY,
  ensembleTraceSha256,
  validateEnsembleObservation,
  validateHypotheses,
  validateReasons,
  validateReviewField,
} from './ensemble-resolver.mjs';
import { RESOLVING_OUTCOMES, contextDecisionsSha256, fallbackBlockers, validateContextDecisions } from './context-fallback.mjs';
import { COMPACT_CONTRACT, HISTORY_CONTRACT, HISTORY_DIRECTORY } from './permanent-trash.mjs';
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
// Tracked JSON may hold only a single observed word form and an opaque source reference, never a
// phrase, sentence or paragraph of corpus text: letters/digits/hyphen/middle dot, no whitespace or
// control characters, bounded length. The producer applies the same pattern (fail closed).
export const SURFACE_TOKEN = /^[\p{L}\p{N}\-·]{1,24}$/u;
export const REFERENCE_TOKEN = /^[^\s\p{C}]{1,200}$/u;
export const isSurfaceToken = (value) => typeof value === 'string' && SURFACE_TOKEN.test(value);
export const isReferenceToken = (value) => typeof value === 'string' && REFERENCE_TOKEN.test(value);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const suffix = (letter, ordinal) => `${letter}${String(ordinal).padStart(2, '0')}`;
const sortedUnique = (values) => [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

export const isLemmaManifest = (manifest) => [LEMMA_CANDIDATE_MANIFEST_CONTRACT, COMPACT_CONTRACT].includes(manifest?.contract);
// Shape test for rows (a v2 row never has a top-level `pos`).
export const isLemmaRow = (row) => Array.isArray(row?.observations);

export const formIdFor = (candidateId, ordinal) => `${candidateId}.${suffix('f', ordinal)}`;
export const groupIdFor = (candidateId, ordinal) => `${candidateId}.${suffix('g', ordinal)}`;
export const observationIdFor = (candidateId, ordinal) => `${candidateId}.${suffix('o', ordinal)}`;

// Key of one distinguishable observation; the digest of all keys binds evidence that a bounded
// selection omitted (the full set stays recoverable from the local text-free evidence).
export const observationKey = (pos, groupKey, surface, evidence) => [pos, groupKey, surface, evidence.kind, evidence.ref].join('\u0000');
export const observationSetDigest = (keys) => sha256Hex([...new Set(keys)].sort().join('\n'));

// `ensemble` ({ decisionIds }) is supplied for batches produced under the ensemble policy: every
// observation then carries its auditable ensemble record and the row its review priority.
export function validateLemmaCandidateRecord(record, { batchId, ordinal, ensemble = null }) {
  const id = `${batchId}-${String(ordinal).padStart(4, '0')}`;
  const at = `candidate ${id}`;
  const errors = [];
  if (record.candidate_id !== id) errors.push(`candidate ${id}: candidate_id must be ${id}, got ${record.candidate_id}`);
  if (typeof record.input !== 'string' || !KOREAN_WORD.test(record.input)) errors.push(`${at}: input must be a dictionary-form Korean lemma`);
  const allowed = new Set(['candidate_id', 'input', 'pos_hypotheses', 'forms', 'usage_groups', 'observations', 'observation_total', 'observation_digest', ...(ensemble ? ['review'] : [])]);
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
    if (!isSurfaceToken(form.surface)) errors.push(`${at}: forms[${index}].surface must be a single bounded word form (no whitespace or sentence text)`);
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
    const currentEnsemble = ensemble?.contract === ENSEMBLE_CONTRACT;
    const allowedKeys = ['observation_id', ...(currentEnsemble ? ['observation_digest'] : []), 'form_id', 'group_id', 'pos', 'evidence', 'analysis', 'holds', ...(ensemble ? ['ensemble'] : [])];
    if (!isPlainObject(observation) || Object.keys(observation).some((key) => !allowedKeys.includes(key))) { errors.push(`${here}: unknown or missing fields`); return; }
    if (observation.observation_id !== observationIdFor(id, index + 1)) errors.push(`${here}: observation_id must be ${observationIdFor(id, index + 1)}`);
    if (currentEnsemble && !isSha256(observation.observation_digest)) errors.push(`${here}: observation_digest must bind a source observation in ensemble v3`);
    if (!formIds.has(observation.form_id)) errors.push(`${here}: form_id does not name an observed form`);
    if (!groupPos.has(observation.group_id)) errors.push(`${here}: group_id does not name a usage group`);
    else if (groupPos.get(observation.group_id) !== observation.pos) errors.push(`${here}: pos differs from its usage group`);
    usedForms.add(observation.form_id);
    usedGroups.add(observation.group_id);
    const evidence = observation.evidence;
    if (!isPlainObject(evidence) || !isReferenceToken(evidence.kind) || !isReferenceToken(evidence.ref)
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
    if (ensemble) errors.push(...validateEnsembleObservation(observation.ensemble, here, { decisionIds: ensemble.decisionIds, holds: Array.isArray(observation.holds) ? observation.holds : [] }));
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
  if (ensemble && errors.length === 0) errors.push(...validateReviewField(record.review, observations, record.observation_total, at));
  else if (ensemble && record.review === undefined) errors.push(`${at}: review is required under the ensemble policy`);
  return errors;
}

// Ensemble queue entries add the ensemble adjudication, every competing hypothesis and a
// verification state to the base {surface, evidence, holds}.
const QUEUE_STATES = Object.freeze(['needs_verification', 'truth_unknown', 'blocked']);
const QUEUE_KEYS = ['queue_id', 'surface', 'evidence', 'holds', 'category', 'reasons', 'hypotheses', 'extractor_hint', 'extractor_holds', 'observation_digest',
  'trace_digest', 'verification'];

function validateQueueEntry(entry, index) {
  const at = `candidate manifest: unresolved_observations[${index}]`;
  const errors = [];
  if (!isPlainObject(entry) || Object.keys(entry).sort().join() !== [...QUEUE_KEYS].sort().join()) return [`${at} must be {${QUEUE_KEYS.join(', ')}}`];
  if (entry.queue_id !== `U${String(index + 1).padStart(4, '0')}`) errors.push(`${at}: queue_id must be U${String(index + 1).padStart(4, '0')}`);
  if (!isSurfaceToken(entry.surface)) errors.push(`${at}: surface must be a single bounded word form (no whitespace or sentence text)`);
  if (!isPlainObject(entry.evidence) || !isReferenceToken(entry.evidence.kind) || !isReferenceToken(entry.evidence.ref)
    || Object.keys(entry.evidence).some((key) => key !== 'kind' && key !== 'ref')) errors.push(`${at}: text-free evidence reference required`);
  if (!Array.isArray(entry.holds) || entry.holds.length === 0 || entry.holds.some((hold) => ![...UNRESOLVED_HOLDS, 'analysis_ambiguous'].includes(hold))) errors.push(`${at}: holds must name an unresolved or ambiguous-analysis reason`);
  if (!['conflicted', 'unsupported_or_unknown'].includes(entry.category)) errors.push(`${at}: an unresolved observation is conflicted or unsupported_or_unknown, never ${entry.category}`);
  errors.push(...validateReasons(entry.reasons, at));
  errors.push(...validateHypotheses(entry.hypotheses, at));
  if (!isPlainObject(entry.extractor_hint) || Object.keys(entry.extractor_hint).sort().join() !== 'lemma,pos') errors.push(`${at}: extractor_hint must be {lemma, pos}`);
  if (!Array.isArray(entry.extractor_holds) || entry.extractor_holds.some((hold) => !HOLD_REASONS.includes(hold))) errors.push(`${at}: extractor_holds must be known hold reasons`);
  for (const key of ['observation_digest', 'trace_digest']) if (!isSha256(entry[key])) errors.push(`${at}: ${key} must be sha256 hex`);
  const verification = entry.verification;
  if (!isPlainObject(verification) || !QUEUE_STATES.includes(verification.state)) errors.push(`${at}: verification.state must be one of ${QUEUE_STATES.join(', ')}`);
  else if (verification.state === 'blocked') {
    const blockers = Array.isArray(entry.extractor_holds) && isPlainObject(entry.evidence) ? fallbackBlockers({ extractor_holds: entry.extractor_holds, evidence: entry.evidence }) : [];
    if (JSON.stringify(verification.blocked_by) !== JSON.stringify(blockers) || blockers.length === 0) errors.push(`${at}: a blocked observation must name exactly its fallback blockers`);
    if (verification.decision_id !== undefined) errors.push(`${at}: a blocked observation has no context decision`);
  } else if (verification.state === 'truth_unknown') {
    if (typeof verification.decision_id !== 'string' || verification.blocked_by !== undefined) errors.push(`${at}: truth_unknown must name its recorded context decision`);
  } else if (verification.decision_id !== undefined || verification.blocked_by !== undefined) errors.push(`${at}: needs_verification carries no decision or blockers`);
  return errors;
}

export function validateUnresolved(list, ensemble, limit = MAX_UNRESOLVED_OBSERVATIONS) {
  const errors = [];
  if (!Array.isArray(list)) return ['candidate manifest: unresolved_observations must be an array'];
  if (list.length > limit) errors.push(`candidate manifest: more than ${limit} unresolved observations`);
  list.forEach((entry, index) => {
    if (ensemble) { errors.push(...validateQueueEntry(entry, index)); return; }
    const at = `candidate manifest: unresolved_observations[${index}]`;
    if (!isPlainObject(entry) || Object.keys(entry).some((key) => !['surface', 'evidence', 'holds'].includes(key))) { errors.push(`${at} must be {surface, evidence, holds}`); return; }
    if (!isSurfaceToken(entry.surface)) errors.push(`${at}: surface must be a single bounded word form (no whitespace or sentence text)`);
    if (!isPlainObject(entry.evidence) || !isReferenceToken(entry.evidence.kind) || !isReferenceToken(entry.evidence.ref)
      || Object.keys(entry.evidence).some((key) => key !== 'kind' && key !== 'ref')) errors.push(`${at}: text-free evidence reference required`);
    if (!Array.isArray(entry.holds) || entry.holds.length === 0 || entry.holds.some((hold) => !UNRESOLVED_HOLDS.includes(hold))) errors.push(`${at}: holds must name an unresolved-analysis reason`);
  });
  return errors;
}

export function validateLemmaCandidateBatch({ manifest, candidatesText, maxUnresolved, allowEmpty = false }) {
  const errors = [];
  const compact = manifest.contract === COMPACT_CONTRACT;
  const required = ['contract', 'lemma_policy', 'task_id', 'batch_id', 'candidate_count', 'observation_count', 'selection',
    ...(compact ? ['archive'] : ['unresolved_observations']), 'source_adapter', 'source_snapshot', 'canonical_snapshot_digest', 'extractor_version',
    'analyzer_version', 'analyzer_digest', 'proposal_contract', 'source_evidence_sha256', 'candidates_sha256', 'status'];
  for (const key of required) if (manifest[key] === undefined) errors.push(`candidate manifest: missing ${key}`);
  if (errors.length) return errors;
  if (manifest.producer_revision !== undefined
    && (typeof manifest.producer_revision !== 'string'
      || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(manifest.producer_revision))) {
    errors.push('candidate manifest: producer_revision must be a full Git object SHA string');
  }
  if (manifest.lemma_policy !== LEMMA_POLICY) errors.push(`candidate manifest: lemma_policy must be ${LEMMA_POLICY}`);
  if (!isBatchId(manifest.batch_id)) errors.push('candidate manifest: batch_id must match C000000');
  if (!(compact ? [...CANDIDATE_STATUSES, 'exhausted'] : CANDIDATE_STATUSES).includes(manifest.status)) errors.push(`candidate manifest: invalid status ${manifest.status}`);
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
    const minimum = (compact && manifest.status === 'exhausted') || allowEmpty ? 0 : 1;
    if (!Number.isInteger(manifest[key]) || manifest[key] < minimum) errors.push(`candidate manifest: ${key} must be ${minimum ? 'a positive' : 'a nonnegative'} integer`);
  }
  if (compact && manifest.status === 'exhausted' && (manifest.candidate_count !== 0 || manifest.observation_count !== 0
    || manifest.production?.exhausted !== true)) errors.push('exhausted Stage 1 results require zero candidates/observations and proven source exhaustion');
  const selection = manifest.selection;
  if (!isPlainObject(selection) || Object.keys(selection).sort().join() !== 'bound,deferred_lemma_count,eligible_lemma_count'
    || !Number.isInteger(selection.bound) || selection.bound < 1
    || !Number.isInteger(selection.eligible_lemma_count) || !Number.isInteger(selection.deferred_lemma_count)) {
    errors.push('candidate manifest: selection must be {bound, eligible_lemma_count, deferred_lemma_count}');
  } else {
    if (manifest.candidate_count > selection.bound) errors.push('candidate manifest: candidate_count exceeds the selection bound');
    if (selection.eligible_lemma_count !== manifest.candidate_count + selection.deferred_lemma_count) errors.push('candidate manifest: eligible lemmas must equal candidates plus deferred lemmas');
  }
  const ensemble = manifest.resolution_policy === ENSEMBLE_POLICY;
  const decisionIds = new Set(compact ? manifest.context_fallback?.resolved_ids ?? [] : (manifest.context_fallback?.decisions ?? [])
    .filter((entry) => RESOLVING_OUTCOMES.includes(entry?.outcome)).map((entry) => entry.decision_id));
  if (compact) errors.push(...validateCompactMetadata(manifest, ensemble));
  else errors.push(...validateUnresolved(manifest.unresolved_observations, ensemble, maxUnresolved));
  if (ensemble && !compact) {
    errors.push(...validateEnsembleManifest(manifest));
    errors.push(...validateExcludedObservations(manifest, decisionIds));
  }
  else if (!ensemble && (manifest.ensemble !== undefined || manifest.context_fallback !== undefined)) errors.push('candidate manifest: ensemble and context_fallback exist only under the ensemble policy');
  if (typeof candidatesText !== 'string') return [...errors, 'candidates.jsonl is missing'];
  if (sha256Hex(candidatesText) !== manifest.candidates_sha256) errors.push('candidates.jsonl bytes do not match candidates_sha256');
  const rows = parseJsonl(candidatesText, 'candidates.jsonl', errors);
  if (rows.length !== manifest.candidate_count) errors.push(`candidates.jsonl has ${rows.length} rows but candidate_count is ${manifest.candidate_count}`);
  const lemmas = new Set();
  let observations = 0;
  rows.forEach((row, index) => {
    errors.push(...validateLemmaCandidateRecord(row, { batchId: manifest.batch_id, ordinal: index + 1,
      ensemble: ensemble ? { decisionIds, contract: manifest.ensemble?.contract } : null }));
    if (lemmas.has(row.input)) errors.push(`candidate ${row.candidate_id}: lemma ${row.input} repeats within the batch (one candidate per lemma)`);
    lemmas.add(row.input);
    if (index > 0 && !(rows[index - 1].input < row.input)) errors.push(`candidate ${row.candidate_id}: rows must be ordered by lemma`);
    observations += Number.isInteger(row.observation_total) ? row.observation_total : 0;
  });
  if (observations !== manifest.observation_count) errors.push(`candidate manifest: observation_count ${manifest.observation_count} differs from the rows' observation_total ${observations}`);
  if (ensemble && !compact && errors.length === 0) errors.push(...validateEnsembleBindings(manifest, rows));
  return errors;
}

function validateCompactMetadata(manifest, ensemble) {
  const errors = [];
  const keys = new Set(['contract', 'lemma_policy', 'task_id', 'batch_id', 'candidate_count', 'observation_count', 'selection',
    'archive', 'source_adapter', 'source_snapshot', 'canonical_snapshot_digest', 'producer_revision', 'extractor_version',
    'analyzer_version', 'analyzer_digest', 'proposal_contract', 'analyzer_providers', 'resolution_policy', 'ensemble',
    'context_fallback', 'source_evidence_sha256', 'candidates_sha256', 'status', 'production']);
  for (const key of Object.keys(manifest)) if (!keys.has(key)) errors.push(`compact manifest: unknown field ${key}`);
  const archive = manifest.archive;
  if (!isPlainObject(archive) || Object.keys(archive).sort().join() !== 'context_decision_count,contract,excluded_count,path,sha256,unresolved_count,unresolved_sha256'
    || archive.contract !== HISTORY_CONTRACT || archive.path !== `${HISTORY_DIRECTORY}/${manifest.batch_id}.json`
    || !isSha256(archive.sha256) || !isSha256(archive.unresolved_sha256)
    || ['unresolved_count', 'excluded_count', 'context_decision_count'].some((key) => !Number.isSafeInteger(archive[key]) || archive[key] < 0)) errors.push('candidate manifest: invalid compact archive reference');
  if (manifest.unresolved_observations !== undefined || manifest.excluded_observations !== undefined) errors.push('compact manifests cannot contain observation history arrays');
  if (manifest.production !== undefined) {
    const production = manifest.production;
    if (!isPlainObject(production) || production.contract !== 'lexical-factory-refill-v1'
      || production.target !== manifest.selection?.bound || !Number.isSafeInteger(production.pages) || production.pages < 1
      || !Number.isSafeInteger(production.visited_proposal_count) || production.visited_proposal_count < 1
      || typeof production.exhausted !== 'boolean' || !isSha256(production.checkpoint_binding)
      || !isSha256(production.initial_evidence_sha256) || `corpus:${production.source_snapshot}` !== manifest.source_snapshot
      || (manifest.candidate_count < production.target && (!production.exhausted
        || production.exhaustion?.contract !== 'corpus-selector-exhaustion-v1' || production.exhaustion.remaining_lemma_count !== 0))) errors.push('candidate manifest: partial production requires explicit source exhaustion, never a runtime limit');
  }
  if (ensemble) {
    const fallback = manifest.context_fallback;
    if (!isPlainObject(fallback) || Object.keys(fallback).sort().join() !== 'contract,decision_count,decisions_sha256,resolved_ids'
      || fallback.contract !== 'context-fallback-decisions-v1' || !isSha256(fallback.decisions_sha256)
      || fallback.decision_count !== archive?.context_decision_count || !Array.isArray(fallback.resolved_ids)
      || fallback.resolved_ids.some((id) => typeof id !== 'string' || !/^D\d{4,}$/.test(id))
      || JSON.stringify(fallback.resolved_ids) !== JSON.stringify([...new Set(fallback.resolved_ids)].sort())
      || fallback.resolved_ids.length > fallback.decision_count) errors.push('candidate manifest: invalid compact context references');
    // Counts and traces remain historical metadata; their full relationship was
    // checked once before compaction, not reconstructed on every future PR.
    if (![ENSEMBLE_CONTRACT, LEGACY_ENSEMBLE_CONTRACT].includes(manifest.ensemble?.contract)
      || !isSha256(manifest.ensemble?.trace_sha256)) errors.push('candidate manifest: invalid ensemble metadata');
    const counts = manifest.ensemble?.counts;
    const current = manifest.ensemble?.contract === ENSEMBLE_CONTRACT;
    if (!isPlainObject(counts) || Object.keys(counts).sort().join() !== (current ? 'categories,excluded,input_observations,observations,queue' : 'categories,observations,queue')
      || counts.queue !== archive?.unresolved_count || counts.observations !== manifest.observation_count + archive?.unresolved_count + archive?.excluded_count
      || (current && (counts.excluded !== archive?.excluded_count || counts.input_observations !== counts.observations))
      || !isPlainObject(counts.categories) || Object.keys(counts.categories).sort().join() !== [...CATEGORIES].sort().join()
      || Object.values(counts.categories).some((count) => !Number.isSafeInteger(count) || count < 0)
      || Object.values(counts.categories).reduce((sum, count) => sum + count, 0) !== counts.observations) errors.push('candidate manifest: compact ensemble counts must match disposition metadata');
  }
  return errors;
}

// Block shape: ensemble = { contract, counts, trace_sha256 }, context_fallback = { contract, decisions, decisions_sha256 }.
function validateEnsembleManifest(manifest) {
  const errors = [];
  const { ensemble, context_fallback: fallback } = manifest;
  const isLegacy = ensemble?.contract === LEGACY_ENSEMBLE_CONTRACT;
  const supportedContract = isLegacy || ensemble?.contract === ENSEMBLE_CONTRACT;
  if (!isPlainObject(ensemble) || Object.keys(ensemble).sort().join() !== [...ENSEMBLE_MANIFEST_KEYS].sort().join() || !supportedContract || !isSha256(ensemble.trace_sha256)) {
    errors.push(`candidate manifest: ensemble must be {contract: ${LEGACY_ENSEMBLE_CONTRACT} or ${ENSEMBLE_CONTRACT}, counts, trace_sha256}`);
  } else {
    const expectedCounts = isLegacy ? 'categories,observations,queue' : 'categories,excluded,input_observations,observations,queue';
    if (!isPlainObject(ensemble.counts) || Object.keys(ensemble.counts).sort().join() !== expectedCounts) {
      errors.push(isLegacy ? 'candidate manifest: ensemble.counts must be {observations, categories, queue}'
        : 'candidate manifest: ensemble.counts must include {input_observations, observations, categories, queue, excluded}');
    }
    if (isLegacy && manifest.excluded_observations !== undefined) errors.push('candidate manifest: legacy ensemble manifests cannot include excluded_observations');
    if (!isLegacy && !Array.isArray(manifest.excluded_observations)) errors.push('candidate manifest: ensemble v3 requires excluded_observations');
  }
  if (!isPlainObject(fallback) || Object.keys(fallback).sort().join() !== 'contract,decisions,decisions_sha256' || fallback.contract !== 'context-fallback-decisions-v1') {
    errors.push('candidate manifest: context_fallback must be {contract: context-fallback-decisions-v1, decisions, decisions_sha256}');
  } else {
    errors.push(...validateContextDecisions(fallback.decisions));
    if (Array.isArray(fallback.decisions) && fallback.decisions.every((entry) => isSha256(entry?.decision_sha256)) && contextDecisionsSha256(fallback.decisions) !== fallback.decisions_sha256) {
      errors.push('candidate manifest: context_fallback.decisions_sha256 does not bind the recorded decisions');
    }
  }
  return errors;
}

function validateExcludedObservations(manifest, decisionIds) {
  const errors = [];
  if (manifest.ensemble?.contract !== ENSEMBLE_CONTRACT) return errors;
  const entries = manifest.excluded_observations;
  if (!Array.isArray(entries)) return errors;
  const digests = new Set();
  let previousOrder = null;
  for (const [index, entry] of entries.entries()) {
    const at = `candidate manifest excluded_observations[${index}]`;
    const allowed = ['analysis', 'disposition', 'ensemble', 'evidence', 'holds', 'lemma', 'observation_digest', 'pos', 'surface'];
    if (!isPlainObject(entry) || Object.keys(entry).sort().join() !== allowed.sort().join()) {
      errors.push(`${at}: excluded observation has an invalid field set`);
      continue;
    }
    if (!['prior_produced_lemma', 'deferred_lemma'].includes(entry.disposition)) errors.push(`${at}: disposition must be prior_produced_lemma or deferred_lemma`);
    if (typeof entry.lemma !== 'string' || !KOREAN_WORD.test(entry.lemma)) errors.push(`${at}: lemma must be a Korean citation-form word`);
    if (!POS_VALUES.includes(entry.pos)) errors.push(`${at}: pos must be one of ${POS_VALUES.join(', ')}`);
    if (!isSurfaceToken(entry.surface)) errors.push(`${at}: surface must be a single bounded word form`);
    if (!isPlainObject(entry.evidence) || !isReferenceToken(entry.evidence.kind) || !isReferenceToken(entry.evidence.ref)
      || Object.keys(entry.evidence).some((key) => key !== 'kind' && key !== 'ref')) errors.push(`${at}: evidence must be a text-free reference`);
    if (!isPlainObject(entry.analysis) || entry.analysis.status !== 'ok' || !isSha256(entry.analysis.input_digest)
      || Object.keys(entry.analysis).length !== 2) errors.push(`${at}: analysis must be {status: ok, input_digest}`);
    if (!Array.isArray(entry.holds) || entry.holds.some((hold) => !HOLD_REASONS.includes(hold))
      || JSON.stringify(entry.holds) !== JSON.stringify(sortedUnique(entry.holds))) errors.push(`${at}: holds must be sorted, unique known hold reasons`);
    if (!isSha256(entry.observation_digest)) errors.push(`${at}: observation_digest must be sha256 hex`);
    else if (digests.has(entry.observation_digest)) errors.push(`${at}: observation_digest is duplicated`);
    else digests.add(entry.observation_digest);
    errors.push(...validateEnsembleObservation(entry.ensemble, at, { decisionIds, holds: entry.holds }));
    const order = `${entry.disposition}\u0000${entry.lemma}\u0000${entry.observation_digest}`;
    if (previousOrder !== null && !(previousOrder < order)) errors.push(`${at}: excluded observations must be uniquely and deterministically sorted`);
    previousOrder = order;
  }
  return errors;
}

// Read only newly bound/changed batch history. This checks its local contract,
// not its relationship to every observation in the permanent historical archive.
export function validateCandidateHistory(manifest, historyText) {
  let history;
  try { history = JSON.parse(historyText); } catch { return ['candidate history must be JSON']; }
  const errors = [];
  const ensemble = manifest.resolution_policy === ENSEMBLE_POLICY;
  const current = manifest.ensemble?.contract === ENSEMBLE_CONTRACT;
  const expected = ['contract', 'batch_id', 'unresolved', ...(ensemble ? ['context_fallback'] : []), ...(current ? ['excluded_observations'] : [])].sort().join();
  if (!isPlainObject(history) || Object.keys(history).sort().join() !== expected || history.contract !== HISTORY_CONTRACT
    || history.batch_id !== manifest.batch_id) return ['candidate history has invalid fields or batch binding'];
  if (!Array.isArray(history.unresolved) || history.unresolved.length !== manifest.archive.unresolved_count
    || history.unresolved.some((ref) => !isPlainObject(ref) || Object.keys(ref).sort().join() !== 'analysis_sha256,observation_id,queue_id'
      || !isSha256(ref.observation_id) || !isSha256(ref.analysis_sha256) || (ref.queue_id !== null && !/^U\d{4,}$/.test(ref.queue_id)))) errors.push('candidate history has invalid unresolved references');
  if (ensemble) {
    const fallback = history.context_fallback;
    if (!isPlainObject(fallback) || Object.keys(fallback).sort().join() !== 'contract,decisions,decisions_sha256'
      || fallback.contract !== 'context-fallback-decisions-v1' || !Array.isArray(fallback.decisions)) errors.push('candidate history has invalid context decisions');
    else {
      errors.push(...validateContextDecisions(fallback.decisions));
      if (fallback.decisions.length !== manifest.archive.context_decision_count
        || fallback.decisions_sha256 !== manifest.context_fallback.decisions_sha256
        || contextDecisionsSha256(fallback.decisions) !== fallback.decisions_sha256
        || JSON.stringify(fallback.decisions.filter((entry) => RESOLVING_OUTCOMES.includes(entry.outcome)).map((entry) => entry.decision_id).sort()) !== JSON.stringify(manifest.context_fallback.resolved_ids)) errors.push('candidate history context counts/digest/references differ from manifest');
    }
    if (current) {
      if (history.excluded_observations?.length !== manifest.archive.excluded_count) errors.push('candidate history excluded count differs from manifest');
      errors.push(...validateExcludedObservations({ ...manifest, excluded_observations: history.excluded_observations }, new Set(manifest.context_fallback?.resolved_ids ?? [])));
    }
  }
  return errors;
}

// Cross-checks that need the rows: observation counts by category, the trace digest over every
// provider identity, row trace and decision, and the two-way link between context decisions, the
// recovered observations and the still-unresolved queue.
function validateEnsembleBindings(manifest, rows) {
  const errors = [];
  const decisions = manifest.context_fallback.decisions;
  const providers = manifest.analyzer_providers;
  const isCurrent = manifest.ensemble.contract === ENSEMBLE_CONTRACT;
  const excluded = isCurrent ? manifest.excluded_observations : [];
  const observationDigests = isCurrent
    ? rows.flatMap((row) => [JSON.stringify(['review', row.review.trace_sha256]),
      ...row.observations.map((observation) => JSON.stringify([observation.observation_digest, observation.ensemble.trace_digest]))])
    : rows.flatMap((row) => [row.review.trace_sha256, ...row.observations.map((observation) => observation.ensemble.trace_digest)]);
  const queueDigests = isCurrent ? manifest.unresolved_observations.map((entry) => JSON.stringify([entry.observation_digest, entry.trace_digest]))
    : manifest.unresolved_observations.map((entry) => entry.trace_digest);
  const excludedDigests = excluded.map((entry) => JSON.stringify([entry.observation_digest, entry.ensemble.trace_digest]));
  if (ensembleTraceSha256({ contract: manifest.ensemble.contract, providers, observationTraceDigests: observationDigests,
    queueTraceDigests: queueDigests, ...(isCurrent ? { excludedTraceDigests: excludedDigests } : {}),
    contextDecisionsSha256: manifest.context_fallback.decisions_sha256 }) !== manifest.ensemble.trace_sha256) {
    errors.push('candidate manifest: ensemble.trace_sha256 does not bind the providers, every disposition trace and context decisions');
  }
  const retained = rows.reduce((sum, row) => sum + row.observations.length, 0);
  const recomputed = {};
  for (const category of CATEGORIES) recomputed[category] = 0;
  for (const row of rows) for (const [category, count] of Object.entries(row.review.categories)) recomputed[category] += count;
  for (const entry of manifest.unresolved_observations) recomputed[entry.category] += 1;
  for (const entry of excluded) recomputed[entry.ensemble.category] += 1;
  const counts = manifest.ensemble.counts;
  if (!isPlainObject(counts) || counts.queue !== manifest.unresolved_observations.length) errors.push('candidate manifest: ensemble.counts.queue must equal the unresolved queue length');
  else if (counts.observations !== manifest.observation_count + manifest.unresolved_observations.length + excluded.length
    || (isCurrent && counts.input_observations !== counts.observations)
    || (isCurrent && counts.excluded !== excluded.length)
    || JSON.stringify(counts.categories) !== JSON.stringify(Object.fromEntries(CATEGORIES.map((category) => [category, counts.categories?.[category]])))) {
    errors.push('candidate manifest: ensemble.counts does not match the independent input observation count and disposition accounting');
  } else if (CATEGORIES.some((category) => recomputed[category] !== counts.categories[category])) {
    errors.push('candidate manifest: ensemble.counts.categories does not match the candidate, queue and excluded dispositions');
  }
  if (isCurrent) {
    const candidateLemmas = new Set(rows.map((row) => row.input));
    const excludedLemmas = new Map();
    for (const entry of excluded) {
      if (candidateLemmas.has(entry.lemma)) errors.push(`candidate manifest: excluded lemma ${entry.lemma} also appears in candidate rows`);
      const disposition = excludedLemmas.get(entry.lemma);
      if (disposition && disposition !== entry.disposition) errors.push(`candidate manifest: excluded lemma ${entry.lemma} has conflicting dispositions`);
      excludedLemmas.set(entry.lemma, entry.disposition);
    }
    const deferredLemmaCount = [...excludedLemmas.values()].filter((disposition) => disposition === 'deferred_lemma').length;
    if (deferredLemmaCount !== manifest.selection.deferred_lemma_count) errors.push('candidate manifest: deferred exclusions do not match selection.deferred_lemma_count');
  }
  const byId = new Map(decisions.map((decision) => [decision.decision_id, decision]));
  const linked = new Set();
  for (const row of rows) {
    for (const observation of row.observations) {
      if (observation.ensemble.resolution !== 'context') continue;
      const decision = byId.get(observation.ensemble.context_decision);
      const form = row.forms.find((entry) => entry.form_id === observation.form_id);
      if (!decision || !RESOLVING_OUTCOMES.includes(decision.outcome)) { errors.push(`${row.candidate_id}: ${observation.observation_id} names no resolving context decision`); continue; }
      linked.add(decision.decision_id);
      if (decision.lemma !== row.input || decision.pos !== observation.pos || decision.surface !== form?.surface
        || JSON.stringify(decision.evidence) !== JSON.stringify(observation.evidence) || decision.trace_digest !== observation.ensemble.trace_digest) {
        errors.push(`${row.candidate_id}: ${observation.observation_id} does not match its context decision ${decision.decision_id}`);
      }
      if (!observation.holds.includes('analysis_ambiguous')) errors.push(`${row.candidate_id}: ${observation.observation_id} was recovered by an AI self-check and must keep a reviewable analysis_ambiguous hold`);
    }
  }
  for (const entry of excluded) {
    if (entry.ensemble.resolution !== 'context') continue;
    const decision = byId.get(entry.ensemble.context_decision);
    if (!decision || !RESOLVING_OUTCOMES.includes(decision.outcome)) { errors.push(`candidate manifest: excluded observation ${entry.observation_digest} names no resolving context decision`); continue; }
    linked.add(decision.decision_id);
    if (decision.lemma !== entry.lemma || decision.pos !== entry.pos || decision.surface !== entry.surface
      || JSON.stringify(decision.evidence) !== JSON.stringify(entry.evidence) || decision.observation_digest !== entry.observation_digest
      || decision.trace_digest !== entry.ensemble.trace_digest) {
      errors.push(`candidate manifest: excluded observation ${entry.observation_digest} does not match its context decision ${decision.decision_id}`);
    }
    if (!entry.holds.includes('analysis_ambiguous')) errors.push(`candidate manifest: excluded observation ${entry.observation_digest} was recovered by contextual self-check and must keep analysis_ambiguous`);
  }
  const unknownLinked = new Set(manifest.unresolved_observations.filter((entry) => entry.verification.state === 'truth_unknown').map((entry) => entry.verification.decision_id));
  for (const decision of decisions) {
    const resolving = RESOLVING_OUTCOMES.includes(decision.outcome);
    if (resolving && !linked.has(decision.decision_id) && retained === manifest.observation_count) errors.push(`candidate manifest: ${decision.decision_id} resolves no retained observation`);
    if (!resolving && !unknownLinked.has(decision.decision_id)) errors.push(`candidate manifest: ${decision.decision_id} (truth_unknown) is not recorded on a queue entry`);
  }
  for (const entry of manifest.unresolved_observations) {
    if (entry.verification.state !== 'truth_unknown') continue;
    const decision = byId.get(entry.verification.decision_id);
    if (!decision || decision.outcome !== 'truth_unknown' || decision.observation_digest !== entry.observation_digest || decision.trace_digest !== entry.trace_digest) {
      errors.push(`candidate manifest: ${entry.queue_id} does not match its truth_unknown decision`);
    }
  }
  const dispositionIdentities = [
    ...rows.flatMap((row) => row.observations.map((observation) => observation.observation_digest)),
    ...manifest.unresolved_observations.map((entry) => entry.observation_digest),
    ...excluded.map((entry) => entry.observation_digest),
  ];
  if (isCurrent && new Set(dispositionIdentities).size !== dispositionIdentities.length) errors.push('candidate manifest: an observation appears in more than one ensemble disposition');
  const queueKeys = new Set(manifest.unresolved_observations.map((entry) => `${entry.surface}\u0000${entry.evidence.kind}\u0000${entry.evidence.ref}\u0000${entry.extractor_hint.lemma}\u0000${entry.extractor_hint.pos}`));
  if (queueKeys.size !== manifest.unresolved_observations.length) errors.push('candidate manifest: the unresolved queue repeats an observation');
  return errors;
}
