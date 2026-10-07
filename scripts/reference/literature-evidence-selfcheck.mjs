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
const BATCH_ID = /^C\d{6}$/u;
const CANDIDATE_ID = /^C\d{6}-\d{4}$/u;
export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

// Keyword buckets over the recorded deferral reason (a heuristic label, not a ruling).
export function deferralCategory(reason = '') {
  if (/하드 홀드|공유 계약|coverage_collision|계약/u.test(reason)) return 'shared_contract_hold';
  if (/별도 판단|경계|비유|관용|고정|연어|구성/u.test(reason)) return 'sense_or_expression_boundary';
  if (/근거|증거|불충분|확인할 수 없|판단할 수 없/u.test(reason)) return 'evidence_insufficient';
  return 'other';
}

export const PINNED_RETRIEVAL = Object.freeze({ max_contexts: 5, max_per_work: 1, hit_fetch_cap: 2000 });

export function validateSelfCheck(record) {
  const errors = [];
  const retrieval = record.retrieval;
  for (const [key, value] of Object.entries(PINNED_RETRIEVAL)) {
    if (retrieval?.[key] !== value) errors.push(`retrieval.${key} must be ${value}`);
  }
  if (!HEX64.test(record.literature_index_logical_rows_sha256 ?? '')) errors.push('literature_index_logical_rows_sha256 is required');
  const cohort = record.cohort;
  if (!Array.isArray(cohort?.universe_batches) || !Array.isArray(cohort?.excluded_no_context_ids) || !cohort?.deferred_per_category || !Number.isSafeInteger(cohort?.comparison_count)) {
    errors.push('cohort (universe_batches, excluded_no_context_ids, deferred_per_category, comparison_count) is required');
  }
  if (Array.isArray(cohort?.universe_batches) && !cohort.universe_batches.every((batch) => typeof batch === 'string' && BATCH_ID.test(batch))) {
    errors.push('cohort.universe_batches entries must look like C000001');
  }
  if (Array.isArray(cohort?.excluded_no_context_ids) && !cohort.excluded_no_context_ids.every((id) => typeof id === 'string' && CANDIDATE_ID.test(id))) {
    errors.push('cohort.excluded_no_context_ids entries must look like C000001-0001');
  }
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
    } else if (digests.length < 1 || digests.length !== row.contexts_returned || digests.length > PINNED_RETRIEVAL.max_contexts) {
      errors.push(`${id}: needs 1..${PINNED_RETRIEVAL.max_contexts} contexts matching its digests (contexts_returned ${row.contexts_returned}, digests ${digests.length})`);
    }
    if (!HEX64.test(row.historical_decision_sha256 ?? '')) errors.push(`${id}: historical_decision_sha256 is required`);
  }
  return errors;
}

// Cohort binding: the recorded ids are exactly the set the declared selection rule yields from the
// tracked review decisions, and each row still carries its historical group/category and digest.
export async function validateCohortBinding(record, root = REPOSITORY_ROOT) {
  const errors = [];
  const { universe_batches: batches, excluded_no_context_ids: excluded, deferred_per_category: perCategory, comparison_count: comparisonCount } = record.cohort;
  const lines = new Map();
  const deferred = [];
  const clear = [];
  for (const batch of batches) {
    if (!BATCH_ID.test(batch)) { errors.push(`${JSON.stringify(batch)}: universe batch id must look like C000001`); continue; }
    let text;
    try {
      text = await readFile(path.join(root, 'data/reviews', batch, 'decisions.jsonl'), 'utf8');
    } catch (error) {
      errors.push(`${batch}: declared universe batch is unreadable (${error.code ?? error.message})`);
      continue;
    }
    for (const line of text.split('\n').filter(Boolean)) {
      const decision = JSON.parse(line);
      const id = decision.source_candidate_id;
      lines.set(id, line);
      if (decision.disposition === 'deferred' && !excluded.includes(id)) deferred.push({ id, category: deferralCategory(decision.reason) });
      else if (decision.disposition === 'included' && decision.target?.kind !== 'new_entry') clear.push(id);
    }
  }
  const byHash = (a, b) => (sha256Hex(a) < sha256Hex(b) ? -1 : 1);
  const expectedDeferred = Object.entries(perCategory).flatMap(([category, count]) => deferred
    .filter((entry) => entry.category === category).map((entry) => entry.id).sort(byHash).slice(0, count));
  const expectedClear = clear.sort(byHash).slice(0, comparisonCount);
  const recorded = (group) => record.rows.filter((row) => row.group === group).map((row) => row.candidate_id).sort();
  if (JSON.stringify(recorded('deferred')) !== JSON.stringify([...expectedDeferred].sort())) errors.push('deferred cohort differs from the declared selection rule');
  if (JSON.stringify(recorded('clear_included')) !== JSON.stringify([...expectedClear].sort())) errors.push('comparison cohort differs from the declared selection rule');
  for (const row of record.rows) {
    const line = lines.get(row.candidate_id);
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

// Report contract: every published measurement field must equal the structured record. The JSON block is
// compared exactly; the prose that repeats the numbers is checked field by field so it cannot drift alone.
export function checkReportContract(report, record) {
  const errors = [];
  const aggregate = aggregateSelfCheck(record);
  const retrieval = Object.fromEntries(Object.keys(PINNED_RETRIEVAL).map((key) => [key, record.retrieval[key]]));
  const match = /<!-- selfcheck-contract[^>]*-->\s*```json\n([\s\S]*?)\n```/u.exec(report);
  if (!match) return ['report lacks the selfcheck-contract JSON block'];
  let published;
  try { published = JSON.parse(match[1]); } catch { return ['selfcheck-contract block is not valid JSON']; }
  if (JSON.stringify(published) !== JSON.stringify({ literature_index_logical_rows_sha256: record.literature_index_logical_rows_sha256, retrieval, aggregate })) errors.push('selfcheck-contract block differs from the record');
  for (const [key, value] of Object.entries(retrieval)) {
    const values = [...report.matchAll(new RegExp(`\\b${key}=(\\d+)`, 'gu'))].map((m) => Number(m[1]));
    if (values.length === 0 || values.some((found) => found !== value)) errors.push(`report states ${key}=${values.join('/')} but the record says ${value}`);
  }
  const digest = record.literature_index_logical_rows_sha256;
  const shown = [...report.matchAll(/DB digest `([0-9a-f]{8})…([0-9a-f]{4})`/gu)];
  if (shown.length === 0 || shown.some(([, head, tail]) => head !== digest.slice(0, 8) || tail !== digest.slice(-4))) errors.push('report DB digest differs from the record');
  const o = aggregate.deferred_outcomes;
  for (const [name, count] of Object.entries(o)) {
    if (!new RegExp(`\\| \`${name}\`[^|]*\\| ${count} \\|`, 'u').test(report)) errors.push(`report table row ${name} is not ${count}`);
  }
  if (!new RegExp(`완전 해소는 ${aggregate.deferred_fully_resolved}건`, 'u').test(report)) errors.push('report fully-resolved count differs');
  const use = aggregate.deferred_evidence_use;
  const deferredLine = /뒷받침 (\d+), 효과 없음 (\d+)[^,]*?, 잡음으로 오히려 방해 (\d+), 다른 뜻 노출 (\d+)/u.exec(report);
  if (!deferredLine || deferredLine.slice(1).map(Number).join() !== [use.supports, use.no_effect, use.misleading_noise, use.exposes_other_sense].join()) errors.push('report deferred evidence-use line differs');
  const cu = aggregate.comparison_evidence_use;
  const comparisonLine = /뒷받침 (\d+), 효과 없음 (\d+), 잡음 (\d+)/u.exec(report);
  if (!comparisonLine || comparisonLine.slice(1).map(Number).join() !== [cu.supports, cu.no_effect, cu.misleading_noise].join()) errors.push('report comparison evidence-use line differs');
  if (cu.exposes_other_sense !== 0) errors.push('report comparison line omits exposes_other_sense');
  errors.push(...checkReportProse(report, aggregate));
  return errors;
}

// Every number the report prose states about the self-check, as [pattern, expected captures]. Each capture is
// compared with the value derived from the record, so no published figure can change on its own.
export function reportProseClaims(aggregate) {
  const o = aggregate.deferred_outcomes;
  const u = aggregate.deferred_evidence_use;
  const c = aggregate.comparison_evidence_use;
  const cases = aggregate.deferred_cases;
  const full = aggregate.deferred_fully_resolved;
  const pct = (part) => Math.round((part * 100) / cases);
  return [
    [/과거 deferred (\d+)건의 self-check 결과/u, [cases]],
    [/부분·완전 해소 합 (\d+)\/(\d+)이지만 \*\*완전 해소는 (\d+)건\((\d+)%\)\*\*, 나머지 (\d+)건은 보류 유지/u, [full + o.partially_resolved, cases, full, pct(full), o.still_deferred]],
    [/\(`evidence_use`, (\d+)건\): 뒷받침 (\d+), 효과 없음 (\d+)[^,]*?, 잡음으로 오히려 방해 (\d+), 다른 뜻 노출 (\d+)\./u, [cases, u.supports, u.no_effect, u.misleading_noise, u.exposes_other_sense]],
    [/비교군 (\d+)건: (\d+)건 모두 `included` 유지\(뒷받침 (\d+), 효과 없음 (\d+), 잡음 (\d+)\)/u, [aggregate.comparison_cases, aggregate.comparison_outcomes.unchanged_included, c.supports, c.no_effect, c.misleading_noise]],
    [/\*탐색적 self-check 기준\* (\d+)건 중 (\d+)건이 더 근거 있는 최종 판정\(포함 (\d+)·커버 (\d+)·거절 (\d+)\)으로 갈 수 있었고 (\d+)건은 일부만 해소/u, [cases, full, o.resolved_included, o.resolved_covered, o.resolved_rejected, o.partially_resolved]],
    [/잡음이 방해한 사례도 (\d+)건/u, [u.misleading_noise]],
    [/'효과 없음\/잡음'이 (\d+)\/(\d+)\((\d+)%\)/u, [u.no_effect + u.misleading_noise, cases, pct(u.no_effect + u.misleading_noise)]],
  ];
}

export function checkReportProse(report, aggregate) {
  const errors = [];
  for (const [pattern, expected] of reportProseClaims(aggregate)) {
    const found = pattern.exec(report);
    if (!found) { errors.push(`report prose claim not found: ${pattern}`); continue; }
    if (found.slice(1).map(Number).join() !== expected.join()) errors.push(`report prose ${found[0].slice(0, 40)}… says ${found.slice(1).join('/')}, record says ${expected.join('/')}`);
  }
  return errors;
}
