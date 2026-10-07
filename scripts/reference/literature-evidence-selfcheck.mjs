import { readFile } from 'node:fs/promises';

// Aggregation and validation of the #391 exploratory self-check record (text-free: ids and enums only).

export const DEFERRED_OUTCOMES = Object.freeze(['resolved_included', 'resolved_covered', 'resolved_rejected', 'partially_resolved', 'still_deferred']);
export const COMPARISON_OUTCOMES = Object.freeze(['unchanged_included']);
export const EVIDENCE_USES = Object.freeze(['supports', 'no_effect', 'misleading_noise', 'exposes_other_sense']);
export const SELFCHECK_RECORD_URL = new URL('./literature-evidence-selfcheck-391.json', import.meta.url);

export function validateSelfCheck(record) {
  const errors = [];
  const seen = new Set();
  for (const row of record.rows) {
    if (seen.has(row.candidate_id)) errors.push('duplicate ' + row.candidate_id);
    seen.add(row.candidate_id);
    const allowed = row.group === 'deferred' ? DEFERRED_OUTCOMES : row.group === 'clear_included' ? COMPARISON_OUTCOMES : [];
    if (!allowed.includes(row.outcome)) errors.push(`${row.candidate_id}: outcome ${row.outcome} not allowed for group ${row.group}`);
    if (!EVIDENCE_USES.includes(row.evidence_use)) errors.push(`${row.candidate_id}: unknown evidence_use ${row.evidence_use}`);
    if (!/^C\d{6}-\d{4}$/u.test(row.candidate_id)) errors.push('bad candidate id ' + row.candidate_id);
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
