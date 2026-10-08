/**
 * Exact paragraph counts for two-character literal queries (Issue #240, M10-A).
 *
 * The corpus index answers a literal count of three or more characters through
 * the FTS5 trigram table, but a one- or two-character query cannot use it and
 * falls back to `instr()` over every paragraph (about 4.5 s each on the 4.99M
 * paragraph index). A 500-candidate batch issues roughly 150 such counts, which
 * measured as ~95% of candidate-evidence time. The count is a deterministic
 * function of the index, so one pass over the paragraphs can tally every
 * two-character substring and later counts become a lookup.
 *
 * The sidecar is derived local reference data (aggregate counts only, no
 * paragraph text) kept beside the index in the shared cache. It is
 * bound to the index's `logical_rows_sha256`; a missing or mismatched sidecar is
 * ignored and the reader falls back to the exact scan, so results never differ.
 */

import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SHORT_COUNTS_VERSION = '1';
export const SHORT_QUERY_LENGTH = 2;

export function shortCountsPathFor(indexPath) {
  return indexPath.replace(/\.sqlite$/u, '') + '.short-counts.sqlite';
}

function indexLogicalRowsDigest(database) {
  const row = database.prepare("SELECT value FROM index_metadata WHERE key = 'logical_rows_sha256'").get();
  if (!row || typeof row.value !== 'string' || row.value.length !== 64) {
    throw new Error('The corpus index has no logical_rows_sha256 metadata.');
  }
  return row.value;
}

/** Every distinct code-point bigram of one paragraph, counted once per paragraph. */
export function distinctBigrams(text, into = new Set()) {
  into.clear();
  let previous = null;
  for (const character of text) {
    if (previous !== null) into.add(previous + character);
    previous = character;
  }
  return into;
}

export function tallyParagraphs(forms) {
  const counts = new Map();
  const seen = new Set();
  for (const form of forms) {
    for (const bigram of distinctBigrams(form, seen)) {
      counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
    }
  }
  return counts;
}

export async function buildShortQueryCounts({ indexPath, outputPath = shortCountsPathFor(indexPath) }) {
  const startedAt = performance.now();
  const index = new DatabaseSync(path.resolve(indexPath), { readOnly: true });
  let counts;
  let digest;
  let paragraphCount = 0;
  try {
    digest = indexLogicalRowsDigest(index);
    const forms = (function* rows() {
      for (const row of index.prepare('SELECT form FROM paragraphs ORDER BY paragraph_rowid').iterate()) {
        paragraphCount += 1;
        yield row.form;
      }
    }());
    counts = tallyParagraphs(forms);
  } finally {
    index.close();
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await rm(temporaryPath, { force: true });
  const output = new DatabaseSync(temporaryPath);
  try {
    output.exec(`
      CREATE TABLE short_counts (query TEXT PRIMARY KEY, paragraph_count INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE sidecar_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    `);
    const insert = output.prepare('INSERT INTO short_counts (query, paragraph_count) VALUES (?, ?)');
    output.exec('BEGIN');
    for (const [query, count] of counts) insert.run(query, count);
    const meta = output.prepare('INSERT INTO sidecar_metadata (key, value) VALUES (?, ?)');
    meta.run('version', SHORT_COUNTS_VERSION);
    meta.run('query_length', String(SHORT_QUERY_LENGTH));
    meta.run('index_logical_rows_sha256', digest);
    meta.run('paragraph_count', String(paragraphCount));
    meta.run('distinct_query_count', String(counts.size));
    output.exec('COMMIT');
  } finally {
    output.close();
  }
  await rename(temporaryPath, outputPath);
  return {
    outputPath,
    paragraphCount,
    distinctQueryCount: counts.size,
    elapsedSeconds: Math.round((performance.now() - startedAt)) / 1000,
  };
}

/**
 * Open the sidecar for an index, or return null when it is absent, stale, or
 * built for different rows. Never throws for an unusable sidecar: callers fall
 * back to the exact scan.
 */
export function openShortQueryCounts({ indexPath, indexDatabase }) {
  let sidecar;
  try {
    sidecar = new DatabaseSync(shortCountsPathFor(path.resolve(indexPath)), { readOnly: true });
  } catch {
    return null;
  }
  try {
    const meta = Object.fromEntries(sidecar.prepare('SELECT key, value FROM sidecar_metadata').all().map((row) => [row.key, row.value]));
    if (meta.version !== SHORT_COUNTS_VERSION
      || meta.query_length !== String(SHORT_QUERY_LENGTH)
      || meta.index_logical_rows_sha256 !== indexLogicalRowsDigest(indexDatabase)) {
      sidecar.close();
      return null;
    }
    const lookup = sidecar.prepare('SELECT paragraph_count FROM short_counts WHERE query = ?');
    return {
      count: (query) => lookup.get(query)?.paragraph_count ?? 0,
      close: () => sidecar.close(),
    };
  } catch {
    sidecar.close();
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { DEFAULT_INDEX_PATH, assertCorpusPermission } = await import('./corpus-index.mjs');
  await assertCorpusPermission();
  console.log(JSON.stringify(await buildShortQueryCounts({ indexPath: DEFAULT_INDEX_PATH }), null, 2));
}
