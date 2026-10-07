import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { assertLiteraturePermission, DEFAULT_FULL_LITERATURE_INDEX_PATH, REPOSITORY_DIRECTORY } from './literature-index.mjs';
import { EVIDENCE_OUTPUT_DIRECTORY } from './literature-evidence.mjs';
import { evidenceForCandidate, loadEvidenceContext } from './literature-evidence-run.mjs';

// Bounded replay measurement for #391: every historical `deferred` Stage 2 decision plus a
// deterministic sample of clear (included, existing-entry) decisions. Retrieval metrics only; it
// does not re-decide any historical disposition. Output is text-free and written under data/reference.

const COMPARISON_SAMPLE = 40;
const sha = (value) => createHash('sha256').update(value).digest('hex');

// Keyword buckets over the recorded deferral reason (a heuristic label, not a ruling).
export function deferralCategory(reason = '') {
  if (/하드 홀드|공유 계약|coverage_collision|계약/u.test(reason)) return 'shared_contract_hold';
  if (/별도 판단|경계|비유|관용|고정|연어|구성/u.test(reason)) return 'sense_or_expression_boundary';
  if (/근거|증거|불충분|확인할 수 없|판단할 수 없/u.test(reason)) return 'evidence_insufficient';
  return 'other';
}

async function collect(root) {
  const deferred = [];
  const clear = [];
  for (const batch of (await readdir(path.join(root, 'data/reviews'))).sort()) {
    let text;
    try { text = await readFile(path.join(root, 'data/reviews', batch, 'decisions.jsonl'), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').filter(Boolean)) {
      const row = JSON.parse(line);
      if (row.disposition === 'deferred') deferred.push({ batch, id: row.source_candidate_id, category: deferralCategory(row.reason) });
      else if (row.disposition === 'included' && row.target?.kind !== 'new_entry') clear.push({ batch, id: row.source_candidate_id, category: 'clear_included' });
    }
  }
  clear.sort((a, b) => (sha(a.id) < sha(b.id) ? -1 : 1));
  return [...deferred, ...clear.slice(0, COMPARISON_SAMPLE)];
}

await assertLiteraturePermission();
const context = await loadEvidenceContext();
const cohort = await collect(REPOSITORY_DIRECTORY);
const rows = [];
const failures = [];
for (const item of cohort) {
  try {
    const { summary } = await evidenceForCandidate(context, { batchId: item.batch, candidateId: item.id, databasePath: DEFAULT_FULL_LITERATURE_INDEX_PATH });
    rows.push({ ...item, total_match_units: summary.total_match_units, works_matched: summary.distinct_works_matched, contexts: summary.contexts_returned, works_returned: summary.distinct_works_returned, genres: summary.genres_returned, skipped_forms: summary.skipped_forms.length, lookup_ms: summary.lookup_ms, truncated: summary.per_form.some((f) => f.truncated), triggers: summary.trigger_reasons, index: summary.literature_index.logical_rows_sha256 });
  } catch (error) {
    failures.push({ id: item.id, error: error.message });
  }
}
const stat = (list) => {
  const ms = list.map((r) => r.lookup_ms).sort((a, b) => a - b);
  const n = list.length;
  return {
    cases: n,
    with_contexts: list.filter((r) => r.contexts > 0).length,
    no_useful_evidence: list.filter((r) => r.contexts === 0).length,
    fewer_than_3_contexts: list.filter((r) => r.contexts < 3).length,
    truncated_hit_fetch: list.filter((r) => r.truncated).length,
    mean_contexts: n ? Number((list.reduce((t, r) => t + r.contexts, 0) / n).toFixed(2)) : 0,
    lookup_ms_median: ms[Math.floor(n / 2)] ?? null,
    lookup_ms_p95: ms[Math.min(n - 1, Math.floor(n * 0.95))] ?? null,
    lookup_ms_total: ms.reduce((t, v) => t + v, 0),
  };
};
const group = (pred) => rows.filter(pred);
const report = {
  contract: 'literature-evidence-replay-v1',
  literature_index_logical_rows_sha256: [...new Set(rows.map((r) => r.index))],
  deferred: stat(group((r) => r.category !== 'clear_included')),
  deferred_by_category: Object.fromEntries(['shared_contract_hold', 'sense_or_expression_boundary', 'evidence_insufficient', 'other'].map((c) => [c, stat(group((r) => r.category === c))])),
  comparison_clear_included: stat(group((r) => r.category === 'clear_included')),
  failures,
};
const output = path.join(EVIDENCE_OUTPUT_DIRECTORY, 'replay-391.json');
await mkdir(EVIDENCE_OUTPUT_DIRECTORY, { recursive: true });
await writeFile(output, JSON.stringify({ report, rows }, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
