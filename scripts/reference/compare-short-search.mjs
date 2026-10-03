/**
 * Same-index, same-query, same-LIMIT before/after measurement of two-character
 * literal context search (Issue #247, M10-B). The query list is the first five
 * observed surface forms of each candidate in an inventory whose length is two
 * code points, in inventory order, searched with the production LIMIT. The old
 * path is the exact `instr()` scan (useShortPostings: false); the new path is
 * the posting sidecar. Results are compared paragraph-identity by
 * paragraph-identity (ordered rowid lists) and recorded as digests only: no
 * corpus text is printed. Local/manual: requires the ignored index.
 *
 *   node scripts/reference/compare-short-search.mjs --inventory=<candidate-inventory.json> [--limit=100] [--repeat=3] [--old=1] [--out=data/timing/<file>.json]
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { createCorpusIndexReader, DEFAULT_INDEX_PATH, assertCorpusPermission } from './corpus-index.mjs';

const options = Object.fromEntries(process.argv.slice(2).map((argument) => {
  const match = /^--([a-z-]+)=(.*)$/u.exec(argument);
  if (!match) throw new Error(`invalid argument ${argument}`);
  return [match[1], match[2]];
}));
if (!options.inventory) throw new Error('--inventory is required');
const limit = Number(options.limit ?? 100);
const repeat = Number(options.repeat ?? 3);
await assertCorpusPermission();

const inventory = JSON.parse(await readFile(path.resolve(options.inventory), 'utf8'));
const queries = [];
for (const candidate of inventory.candidates) {
  for (const form of (candidate.observed_surface_forms ?? []).slice(0, 5)) {
    if (typeof form.surface === 'string' && [...form.surface].length === 2) queries.push(form.surface);
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const runAll = (reader) => {
  const perQuery = [];
  const started = performance.now();
  for (const query of queries) {
    const queryStarted = performance.now();
    const rows = reader.search(query, limit);
    perQuery.push({ ms: performance.now() - queryStarted, rowids: rows.map((row) => row.paragraph_rowid), rowsDigest: sha256(JSON.stringify(rows)) });
  }
  return { ms: performance.now() - started, perQuery };
};
const summary = (runs) => runs.map((run) => Math.round(run.ms));

const oldReader = options.old === '0' ? null : createCorpusIndexReader({ databasePath: DEFAULT_INDEX_PATH, useShortPostings: false });
const oldRuns = oldReader ? Array.from({ length: Number(options['old-repeat'] ?? 1) }, () => runAll(oldReader)) : [];
oldReader?.close();

const newReader = createCorpusIndexReader({ databasePath: DEFAULT_INDEX_PATH });
const coldRun = runAll(newReader);
const warmRuns = Array.from({ length: repeat }, () => runAll(newReader));
newReader.close();

let mismatches = 0;
let omissions = 0;
if (oldRuns.length) {
  coldRun.perQuery.forEach((entry, position) => {
    const reference = oldRuns[0].perQuery[position];
    if (JSON.stringify(reference.rowids) !== JSON.stringify(entry.rowids) || reference.rowsDigest !== entry.rowsDigest) mismatches += 1;
    omissions += reference.rowids.filter((rowid) => !entry.rowids.includes(rowid)).length;
  });
}
const slowest = (run) => run.perQuery.map((entry, position) => ({ position, ms: Math.round(entry.ms * 100) / 100 })).sort((a, b) => b.ms - a.ms).slice(0, 5);
const result = {
  workload: 'two-character observed surface forms of the candidate inventory, first five per candidate, inventory order',
  index_digest_note: 'same index file for every run',
  limit,
  query_count: queries.length,
  distinct_query_count: new Set(queries).size,
  queries_digest: sha256(queries.join('\n')),
  results_digest: sha256(coldRun.perQuery.map((entry) => entry.rowsDigest).join('\n')),
  empty_result_queries: coldRun.perQuery.filter((entry) => entry.rowids.length === 0).length,
  limit_reached_queries: coldRun.perQuery.filter((entry) => entry.rowids.length === limit).length,
  old_scan_total_ms: summary(oldRuns),
  old_scan_ms_per_query: oldRuns.length ? Math.round(oldRuns[0].ms / queries.length) : 'unavailable',
  new_cold_first_pass_total_ms: Math.round(coldRun.ms),
  new_warm_total_ms: summary(warmRuns),
  slowest_new_queries_ms: slowest(coldRun),
  result_mismatches: oldRuns.length ? mismatches : 'unavailable',
  omitted_paragraphs: oldRuns.length ? omissions : 'unavailable',
  environment: {
    node: process.version, platform: `${process.platform}-${process.arch}`, os_release: os.release(),
    cpu: os.cpus()[0]?.model, cpu_count: os.cpus().length, memory_gib: Math.round(os.totalmem() / 2 ** 30),
  },
};
if (options.out) await writeFile(path.resolve(options.out), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result, null, 2));
