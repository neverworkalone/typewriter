import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { REVIEWABLE_HOLDS } from '../intake/production-handoff.mjs';
import { assertLiteraturePermission, DEFAULT_FULL_LITERATURE_INDEX_PATH, REPOSITORY_DIRECTORY } from '../reference/literature-index.mjs';
import { deriveSearchForms, loadFactoryCandidate, writeEvidencePack } from '../reference/literature-evidence.mjs';
import { evidenceForCandidate, loadEvidenceContext } from '../reference/literature-evidence-run.mjs';

// Bounded literature rescue of evidence-insufficiency deferrals (issue #392). Stage 2 keeps all
// semantic authority: this module only runs ONE read-only #391 lookup immediately before a
// provisional `deferred` decision whose remaining reason is insufficient contextual evidence, and
// keeps a text-free, candidate-bound record. A missing/noisy/unavailable lookup is never negative
// evidence and never forces any disposition.

export const RESCUE_CONTRACT = 'literature-rescue-lookup-v1';
export const RESCUE_TRIGGER = 'insufficient_context_evidence';
export const RESCUE_BOUNDS = Object.freeze({ max_contexts: 5, max_per_work: 1, match_mode: 'substring' });
export const RESCUE_STATUSES = Object.freeze(['attempted', 'skipped', 'unavailable']);
export const RESCUE_REASON_CODES = Object.freeze(['no_usable_search_forms', 'permission_unavailable', 'database_unavailable', 'lookup_error']);
const SKIP_CODES = new Set(['no_usable_search_forms']);
const ADMITTED = new Set(['included', 'corrected']);
const RECORD_KEYS = ['context_digests', 'contract', 'deferral_changed_to_included', 'informed', 'location_digests', 'lookup_ms', 'match_mode', 'max_contexts', 'max_per_work', 'reason_code', 'status', 'trigger'];
const DIGEST = /^[0-9a-f]{64}$/u;

// Eligible only when the remaining reason is insufficient context for POS/sense/sense boundary and no
// hard hold (anything outside the reviewable analyzer holds) is present on any observation.
export function isRescueEligible(row, reasonClass) {
  if (reasonClass !== RESCUE_TRIGGER || !Array.isArray(row?.observations)) return false;
  return row.observations.every((observation) => (observation.holds ?? []).every((hold) => REVIEWABLE_HOLDS.includes(hold)));
}

const blankRecord = (status, reasonCode = null) => ({
  contract: RESCUE_CONTRACT,
  trigger: RESCUE_TRIGGER,
  status,
  reason_code: reasonCode,
  ...RESCUE_BOUNDS,
  location_digests: [],
  context_digests: [],
  lookup_ms: null,
  informed: false,
  deferral_changed_to_included: false,
});

/**
 * One bounded lookup for an eligible candidate. Never throws for lookup problems: they become an
 * `unavailable`/`skipped` record and the caller continues with its ordinary decision.
 * Returns { eligible: false } when the trigger does not apply (no lookup, no record).
 * `informed`/`deferral_changed_to_included` start false; the Stage 2 author sets them from its own
 * reading of the actual contexts.
 */
export async function runBoundedLiteratureLookup({
  batchId, candidateId, reasonClass, root = REPOSITORY_DIRECTORY, databasePath = DEFAULT_FULL_LITERATURE_INDEX_PATH,
  context, outputDirectory,
}) {
  const row = await loadFactoryCandidate({ batchId, candidateId, root });
  if (!isRescueEligible(row, reasonClass)) return { eligible: false, record: null, files: null };
  try { await assertLiteraturePermission(); } catch { return { eligible: true, record: blankRecord('unavailable', 'permission_unavailable'), files: null }; }
  if (deriveSearchForms(row).forms.length === 0) return { eligible: true, record: blankRecord('skipped', 'no_usable_search_forms'), files: null };
  try {
    const result = await evidenceForCandidate(context ?? await loadEvidenceContext(root), {
      batchId, candidateId, databasePath, maxContexts: RESCUE_BOUNDS.max_contexts, maxPerWork: RESCUE_BOUNDS.max_per_work, matchMode: RESCUE_BOUNDS.match_mode,
    });
    const files = await writeEvidencePack(result, outputDirectory ? { outputDirectory } : undefined);
    return {
      eligible: true,
      files,
      record: {
        ...blankRecord('attempted'),
        location_digests: result.contexts.map((c) => c.location_digest),
        context_digests: result.contexts.map((c) => c.context_digest),
        lookup_ms: result.summary.lookup_ms,
      },
    };
  } catch (error) {
    const code = error?.code === 'ENOENT' || /unable to open|no such table|cannot open/iu.test(error?.message ?? '') ? 'database_unavailable' : 'lookup_error';
    return { eligible: true, record: blankRecord('unavailable', code), files: null };
  }
}

// Closed, text-free record check for one lemma decision row (`row.literature_lookup`).
export function validateLiteratureLookup(row) {
  const record = row.literature_lookup;
  if (record === undefined) return [];
  const at = `decision ${row.source_candidate_id} literature_lookup`;
  const errors = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return [`${at}: must be an object`];
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify(RECORD_KEYS)) return [`${at}: must carry exactly ${RECORD_KEYS.join(', ')}`];
  if (record.contract !== RESCUE_CONTRACT) errors.push(`${at}: contract must be ${RESCUE_CONTRACT}`);
  if (record.trigger !== RESCUE_TRIGGER) errors.push(`${at}: trigger must be ${RESCUE_TRIGGER}`);
  for (const [key, value] of Object.entries(RESCUE_BOUNDS)) if (record[key] !== value) errors.push(`${at}: ${key} must be ${value}`);
  if (!RESCUE_STATUSES.includes(record.status)) errors.push(`${at}: status must be one of ${RESCUE_STATUSES.join(', ')}`);
  const attempted = record.status === 'attempted';
  if (attempted ? record.reason_code !== null : !RESCUE_REASON_CODES.includes(record.reason_code)) errors.push(`${at}: reason_code ${attempted ? 'must be null for an attempted lookup' : 'must be one of ' + RESCUE_REASON_CODES.join(', ')}`);
  else if (record.status === 'skipped' && !SKIP_CODES.has(record.reason_code)) errors.push(`${at}: skipped needs a skip reason_code`);
  else if (record.status === 'unavailable' && SKIP_CODES.has(record.reason_code)) errors.push(`${at}: unavailable needs an unavailability reason_code`);
  const lists = [record.location_digests, record.context_digests];
  if (lists.some((list) => !Array.isArray(list) || list.length > RESCUE_BOUNDS.max_contexts || list.some((d) => !DIGEST.test(d)))) errors.push(`${at}: digests must be at most ${RESCUE_BOUNDS.max_contexts} sha256 hex strings`);
  else if (lists[0].length !== lists[1].length || new Set(lists[0]).size !== lists[0].length) errors.push(`${at}: location and context digests must pair up uniquely`);
  else if (!attempted && lists[0].length) errors.push(`${at}: a ${record.status} lookup returns no contexts`);
  if (record.lookup_ms !== null && !(Number.isInteger(record.lookup_ms) && record.lookup_ms >= 0)) errors.push(`${at}: lookup_ms must be null or a non-negative integer`);
  if (typeof record.informed !== 'boolean' || typeof record.deferral_changed_to_included !== 'boolean') errors.push(`${at}: informed and deferral_changed_to_included must be booleans`);
  else {
    if (record.informed && !(attempted && record.location_digests?.length > 0)) errors.push(`${at}: informed requires an attempted lookup that returned contexts`);
    if (record.deferral_changed_to_included) {
      if (!record.informed) errors.push(`${at}: a deferral cannot change to included without informing evidence`);
      if (!ADMITTED.has(row.disposition) || !(row.group_decisions ?? []).some((entry) => entry?.disposition === 'included')) errors.push(`${at}: deferral_changed_to_included requires an admitted candidate with an included group`);
    }
  }
  return errors;
}

// Per-batch production counters from tracked reviews. A change to `included` counts as a confirmed
// rescue only once the review batch is Stage 3 `complete`; earlier it is pending.
export function summarizeLiteratureRescue(batches) {
  return batches.map(({ batchId, status, decisions }) => {
    const records = decisions.filter((row) => row.literature_lookup);
    const changed = records.filter((row) => row.literature_lookup.deferral_changed_to_included);
    return {
      batch_id: batchId,
      lookups_attempted: records.filter((row) => row.literature_lookup.status === 'attempted').length,
      lookups_skipped: records.filter((row) => row.literature_lookup.status === 'skipped').length,
      lookups_unavailable: records.filter((row) => row.literature_lookup.status === 'unavailable').length,
      evidence_informed: records.filter((row) => row.literature_lookup.informed).length,
      changed_to_included: changed.length,
      stage3_admitted: status === 'complete' ? changed.length : null,
      stage3_pending: status === 'complete' ? 0 : changed.length,
      lookup_ms_total: records.reduce((total, row) => total + (row.literature_lookup.lookup_ms ?? 0), 0),
    };
  }).filter((entry) => entry.lookups_attempted + entry.lookups_skipped + entry.lookups_unavailable > 0);
}

export async function loadReviewBatchesForRescueReport(root = REPOSITORY_DIRECTORY) {
  const directory = path.join(root, 'data/reviews');
  const batches = [];
  for (const batchId of (await readdir(directory)).filter((name) => /^C\d{6}$/u.test(name)).sort()) {
    const text = await readFile(path.join(directory, batchId, 'decisions.jsonl'), 'utf8').catch(() => '');
    const manifest = JSON.parse(await readFile(path.join(directory, batchId, 'manifest.json'), 'utf8').catch(() => '{}'));
    batches.push({ batchId, status: manifest.status, decisions: text.split('\n').filter(Boolean).map((line) => JSON.parse(line)) });
  }
  return batches;
}
