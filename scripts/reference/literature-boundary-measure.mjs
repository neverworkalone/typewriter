import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { resolveTypewriterCachePaths } from '../typewriter-cache.mjs';
import { classifyMatchSample, deriveSearchForms, loadFactoryCandidate } from './literature-evidence.mjs';
import { evidenceForCandidate, loadEvidenceContext, supportedFormsForCandidate } from './literature-evidence-run.mjs';
import { assertLiteraturePermission, DEFAULT_FULL_LITERATURE_INDEX_PATH, REPOSITORY_DIRECTORY } from './literature-index.mjs';
import { collectReplayCohort } from './literature-replay-cohort.mjs';
import { SELFCHECK_PATH, selectCohort } from './literature-validation.mjs';
import { readFile } from 'node:fs/promises';

// #414 before/after measurement over the #391 replay cohort. Text-free: counts and enums only.
// `substring` is the pre-#414 retriever, `eojeol` the boundary-filtered one; both read the same DB.

// Fixed before measuring (docs/literature-evidence-boundary-issue-414.md): availability tolerances.
export const TOLERANCES = Object.freeze({
  max_additional_zero_context_cases: 2, // of the whole cohort
  max_additional_fewer_than_3_context_cases: 6, // of the whole cohort
  min_retained_hit_share_included: 0.5, // eojeol/substring exact units, median over clear_included cases
});

const median = (list) => { const sorted = [...list].sort((a, b) => a - b); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
const sum = (list, key) => list.reduce((total, row) => total + row[key], 0);

export function summarize(rows) {
  const count = (predicate) => rows.filter(predicate).length;
  const mode = (name) => ({
    cases_with_contexts: count((r) => r[name].contexts > 0),
    zero_context_cases: count((r) => r[name].contexts === 0),
    fewer_than_3_context_cases: count((r) => r[name].contexts < 3),
    mean_contexts: rows.length ? Number((sum(rows.map((r) => ({ c: r[name].contexts })), 'c') / rows.length).toFixed(2)) : 0,
    total_units: sum(rows.map((r) => ({ c: r[name].units })), 'c'),
  });
  const census = Object.fromEntries(['units', 'boundary', 'after_hangul', 'after_han', 'after_other', 'trailing_0', 'trailing_1_2', 'trailing_3_plus']
    .map((key) => [key, sum(rows.map((r) => r.census), key)]));
  const shares = rows.filter((r) => r.substring.units > 0).map((r) => r.eojeol.units / r.substring.units);
  return {
    cases: rows.length,
    substring: mode('substring'),
    eojeol: mode('eojeol'),
    sample_census: census,
    dropped_unit_share_of_sample: census.units ? Number(((census.units - census.boundary) / census.units).toFixed(4)) : null,
    retained_unit_share_median: median(shares),
    cases_dropping_over_half_of_units: shares.filter((share) => share < 0.5).length,
  };
}

export function toleranceVerdict(all, included) {
  const checks = {
    additional_zero_context_cases: all.eojeol.zero_context_cases - all.substring.zero_context_cases <= TOLERANCES.max_additional_zero_context_cases,
    additional_fewer_than_3_context_cases: all.eojeol.fewer_than_3_context_cases - all.substring.fewer_than_3_context_cases <= TOLERANCES.max_additional_fewer_than_3_context_cases,
    retained_unit_share_clear_included: (included.retained_unit_share_median ?? 0) >= TOLERANCES.min_retained_hit_share_included,
  };
  return { checks, within_tolerance: Object.values(checks).every(Boolean) };
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  await assertLiteraturePermission();
  const context = await loadEvidenceContext();
  const cohort = await collectReplayCohort(REPOSITORY_DIRECTORY);
  const validation = new Set(selectCohort(JSON.parse(await readFile(SELFCHECK_PATH, 'utf8')).rows).map((entry) => entry.row?.candidate_id ?? entry.candidate_id));
  const rows = [];
  const failures = [];
  for (const item of cohort) {
    try {
      const row = await loadFactoryCandidate({ batchId: item.batch, candidateId: item.id });
      const searchForms = deriveSearchForms(row, supportedFormsForCandidate(row, context.canonicalIndex, context.support));
      const run = {};
      for (const matchMode of ['substring', 'eojeol']) {
        const { summary } = await evidenceForCandidate(context, { batchId: item.batch, candidateId: item.id, databasePath: DEFAULT_FULL_LITERATURE_INDEX_PATH, matchMode });
        run[matchMode] = { contexts: summary.contexts_returned, units: summary.total_match_units, works: summary.distinct_works_matched, digests: summary.selected_location_digests };
      }
      const overlap = run.eojeol.digests.filter((digest) => run.substring.digests.includes(digest)).length;
      rows.push({ ...item, validation_case: validation.has(item.id), substring: run.substring, eojeol: run.eojeol, kept_digest_overlap: overlap, census: classifyMatchSample({ searchForms }) });
    } catch (error) {
      failures.push({ id: item.id, error: error.message });
    }
  }
  const groups = {
    all: rows,
    deferred: rows.filter((r) => r.category !== 'clear_included'),
    clear_included: rows.filter((r) => r.category === 'clear_included'),
    validation_392_regression: rows.filter((r) => r.validation_case),
    deferred_holdout: rows.filter((r) => r.category !== 'clear_included' && !r.validation_case),
  };
  const report = { contract: 'literature-boundary-measure-v1', tolerances: TOLERANCES, groups: Object.fromEntries(Object.entries(groups).map(([name, list]) => [name, summarize(list)])), failures };
  report.verdict = toleranceVerdict(report.groups.all, report.groups.clear_included);
  const directory = path.join(resolveTypewriterCachePaths().runs, 'issue-414-literature-boundary');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `measure-${Date.now()}.json`), JSON.stringify({ report, rows: rows.map(({ id, batch, category, validation_case: v, substring, eojeol, kept_digest_overlap, census }) => ({ id, batch, category, validation_case: v, substring: { ...substring, digests: undefined }, eojeol: { ...eojeol, digests: undefined }, kept_digest_overlap, census })) }, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
