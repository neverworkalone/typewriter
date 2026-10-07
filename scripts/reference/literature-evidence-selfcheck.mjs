import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Aggregation and validation of the #391 exploratory self-check record (text-free: ids, digests and enums only).

export const DEFERRED_OUTCOMES = Object.freeze(['resolved_included', 'resolved_covered', 'resolved_rejected', 'partially_resolved', 'still_deferred']);
export const COMPARISON_OUTCOMES = Object.freeze(['unchanged_included']);
export const EVIDENCE_USES = Object.freeze(['supports', 'no_effect', 'misleading_noise', 'exposes_other_sense']);
export const SELFCHECK_RECORD_URL = new URL('./literature-evidence-selfcheck-391.json', import.meta.url);
export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const HEX64 = /^[0-9a-f]{64}$/u;
export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

// Keyword buckets over the recorded deferral reason (a heuristic label, not a ruling).
export function deferralCategory(reason = '') {
  if (/하드 홀드|공유 계약|coverage_collision|계약/u.test(reason)) return 'shared_contract_hold';
  if (/별도 판단|경계|비유|관용|고정|연어|구성/u.test(reason)) return 'sense_or_expression_boundary';
  if (/근거|증거|불충분|확인할 수 없|판단할 수 없/u.test(reason)) return 'evidence_insufficient';
  return 'other';
}

export function validateSelfCheck(record) {
  const errors = [];
  const retrieval = record.retrieval;
  if (!retrieval || !Number.isSafeInteger(retrieval.max_contexts) || retrieval.max_contexts < 1) errors.push('retrieval.max_contexts is required');
  if (!HEX64.test(record.literature_index_logical_rows_sha256 ?? '')) errors.push('literature_index_logical_rows_sha256 is required');
  if (typeof record.cohort_selection !== 'string' || record.cohort_selection.length === 0) errors.push('cohort_selection is required');
  const seen = new Set();
  for (const row of record.rows) {
    const id = row.candidate_id;
    if (seen.has(id)) errors.push('duplicate ' + id);
    seen.add(id);
    const allowed = row.group === 'deferred' ? DEFERRED_OUTCOMES : row.group === 'clear_included' ? COMPARISON_OUTCOMES : [];
    if (!allowed.includes(row.outcome)) errors.push(`${id}: outcome ${row.outcome} not allowed for group ${row.group}`);
    if (!EVIDENCE_USES.includes(row.evidence_use)) errors.push(`${id}: unknown evidence_use ${row.evidence_use}`);
    if (!/^C\d{6}-\d{4}$/u.test(id ?? '')) errors.push('bad candidate id ' + id);
    const digests = row.selected_location_digests;
    if (!Array.isArray(digests) || !digests.every((d) => HEX64.test(d)) || new Set(digests).size !== digests.length) {
      errors.push(`${id}: selected_location_digests must be unique sha256 digests`);
    } else if (digests.length !== row.contexts_returned || digests.length > (retrieval?.max_contexts ?? 0)) {
      errors.push(`${id}: contexts_returned ${row.contexts_returned} disagrees with ${digests.length} digests or exceeds max_contexts`);
    }
    if (!HEX64.test(row.historical_decision_sha256 ?? '')) errors.push(`${id}: historical_decision_sha256 is required`);
  }
  return errors;
}

// Cohort binding: each row's historical decision still exists with the claimed group/category and digest.
export async function validateCohortBinding(record, root = REPOSITORY_ROOT) {
  const errors = [];
  const decisions = new Map();
  for (const row of record.rows) {
    const batch = row.candidate_id.slice(0, 7);
    if (!decisions.has(batch)) {
      const text = await readFile(path.join(root, 'data/reviews', batch, 'decisions.jsonl'), 'utf8');
      decisions.set(batch, new Map(text.split('\n').filter(Boolean).map((line) => [JSON.parse(line).source_candidate_id, line])));
    }
    const line = decisions.get(batch).get(row.candidate_id);
    if (line === undefined) { errors.push(row.candidate_id + ': historical decision not found'); continue; }
    const decision = JSON.parse(line);
    if (sha256Hex(line) !== row.historical_decision_sha256) errors.push(row.candidate_id + ': historical decision digest changed');
    const group = decision.disposition === 'deferred' ? 'deferred'
      : decision.disposition === 'included' && decision.target?.kind !== 'new_entry' ? 'clear_included' : null;
    if (group !== row.group) errors.push(`${row.candidate_id}: historical group is ${group}, record says ${row.group}`);
    if (group === 'deferred' && deferralCategory(decision.reason) !== row.deferral_heuristic_category) errors.push(row.candidate_id + ': deferral category changed');
  }
  return errors;
}

const tally = (rows, key, values) => Object.fromEntries(values.map((value) => [value, rows.filter((row) => row[key] === value).length]));

export function aggregateSelfCheck(record) {
  const deferred = record.rows.filter((row) => row.group === 'deferred');
  const comparison = record.rows.filter((row) => row.group === 'clear_included');
  const resolved = deferred.filter((row) => ['resolved_included', 'resolved_covered', 'resolved_rejected'].includes(row.outcome));
  return {
    deferred_cases: deferred.length,
    deferred_outcomes: tally(deferred, 'outcome', DEFERRED_OUTCOMES),
    deferred_fully_resolved: resolved.length,
    deferred_evidence_use: tally(deferred, 'evidence_use', EVIDENCE_USES),
    comparison_cases: comparison.length,
    comparison_outcomes: tally(comparison, 'outcome', COMPARISON_OUTCOMES),
    comparison_evidence_use: tally(comparison, 'evidence_use', EVIDENCE_USES),
  };
}

export async function loadSelfCheck() {
  return JSON.parse(await readFile(SELFCHECK_RECORD_URL, 'utf8'));
}
