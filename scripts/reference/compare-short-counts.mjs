/**
 * Controlled before/after measurement of the two-character literal count path
 * (Issue #240, M10-A): the same corpus index and the same query workload, run
 * through the exact `instr()` fallback and through the warm sidecar, with the
 * results compared one by one. Corpus text is never printed; the output holds
 * only queries' counts and timings. Local/manual: requires the ignored index.
 *
 *   node scripts/reference/compare-short-counts.mjs --inventory=~/.cache/typewriter/runs/issue-240/corpus-batch-12/candidate-inventory.json [--repeat=1]
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createCorpusIndexReader, DEFAULT_INDEX_PATH, assertCorpusPermission } from './corpus-index.mjs';

const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const match = /^--([a-z-]+)=(.*)$/u.exec(argument);
  if (!match) throw new Error(`invalid argument ${argument}`);
  return [match[1], match[2]];
}));
if (!options.inventory) throw new Error('--inventory is required');
await assertCorpusPermission();

const inventory = JSON.parse(await readFile(path.resolve(options.inventory), 'utf8'));
const queries = [...new Set(inventory.candidates
  .map((candidate) => candidate.observed_surface_forms?.[0]?.surface)
  .filter((surface) => typeof surface === 'string' && [...surface].length === 2))];

const timeAll = (reader) => {
  const counts = [];
  const started = performance.now();
  for (const query of queries) counts.push(reader.count(query));
  return { counts, ms: performance.now() - started };
};

const warm = createCorpusIndexReader({ databasePath: DEFAULT_INDEX_PATH });
timeAll(warm); // first pass opens statements and pages the sidecar in
const warmRuns = Array.from({ length: Number(options.repeat ?? 3) }, () => timeAll(warm));
warm.close();

const old = createCorpusIndexReader({ databasePath: DEFAULT_INDEX_PATH, useShortCounts: false });
const oldRun = timeAll(old);
old.close();

const mismatches = queries.filter((_, index) => oldRun.counts[index] !== warmRuns[0].counts[index]).length;
console.log(JSON.stringify({
  workload: 'two-character first observed forms of the candidate inventory',
  query_count: queries.length,
  fallback_exact_scan_total_ms: Math.round(oldRun.ms),
  fallback_ms_per_query: Math.round(oldRun.ms / queries.length),
  warm_sidecar_runs_total_ms: warmRuns.map((run) => Math.round(run.ms * 1000) / 1000),
  result_mismatches: mismatches,
  zero_count_queries: oldRun.counts.filter((count) => count === 0).length,
}, null, 2));
