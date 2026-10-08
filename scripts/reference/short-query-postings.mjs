/**
 * Exact two-character literal *search* through a bigram posting sidecar
 * (Issue #247, M10-B).
 *
 * `short-query-counts.mjs` answers two-character counts, but representative-
 * context search still ran `instr(form, ?)` over `ORDER BY paragraph_rowid`
 * (about 0.6 s per query on the 4.99M-paragraph index; 87-90 % of lookup time
 * in M10-A). A bigram occurs in a paragraph exactly when `instr()` finds it, so
 * the lowest-rowid matches are the first rowids of that bigram's posting list.
 *
 * Only *rare* bigrams (paragraph count <= POSTING_MAX_COUNT) store a posting
 * list. A common bigram needs no list: the ordered scan reaches the LIMIT after
 * about LIMIT * paragraphs / count rows, which is bounded by the threshold. That
 * keeps the structure small (rowids only, delta-varint blobs, no text) and the
 * build memory bounded to one Int32Array per rare bigram.
 *
 * The sidecar is derived local reference data under the shared Typewriter cache,
 * bound to the index's `logical_rows_sha256`, built atomically. A missing,
 * stale, corrupted or unsupported sidecar is ignored and the exact scan runs, so
 * results never depend on whether it exists.
 */

import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { crc32 } from 'node:zlib';

export const SHORT_POSTINGS_VERSION = '1';
export const SHORT_POSTINGS_QUERY_LENGTH = 2;
export const POSTING_MAX_COUNT = 5000;

export function shortPostingsPathFor(indexPath) {
  return indexPath.replace(/\.sqlite$/u, '') + '.short-postings.sqlite';
}

function indexLogicalRowsDigest(database) {
  const row = database.prepare("SELECT value FROM index_metadata WHERE key = 'logical_rows_sha256'").get();
  if (!row || typeof row.value !== 'string' || row.value.length !== 64) {
    throw new Error('The corpus index has no logical_rows_sha256 metadata.');
  }
  return row.value;
}

/** Ascending non-negative integers -> delta varint bytes. */
export function encodePostings(rowids) {
  const bytes = [];
  let previous = 0;
  for (const rowid of rowids) {
    if (!Number.isSafeInteger(rowid) || rowid < previous) throw new RangeError('Posting rowids must be ascending non-negative integers.');
    let delta = rowid - previous;
    previous = rowid;
    while (delta >= 0x80) {
      bytes.push((delta & 0x7f) | 0x80);
      delta = Math.floor(delta / 128);
    }
    bytes.push(delta);
  }
  return Uint8Array.from(bytes);
}

/** Decode at most `limit` rowids; returns null when the blob is malformed. */
export function decodePostings(blob, limit = Infinity, expectedCount = undefined) {
  const rowids = [];
  let position = 0;
  let previous = 0;
  while (position < blob.length && rowids.length < limit) {
    let delta = 0;
    let multiplier = 1;
    for (;;) {
      if (position >= blob.length) return null;
      const byte = blob[position];
      position += 1;
      delta += (byte & 0x7f) * multiplier;
      if (byte < 0x80) break;
      multiplier *= 128;
      if (multiplier > 2 ** 35) return null;
    }
    previous += delta;
    rowids.push(previous);
  }
  if (expectedCount !== undefined && limit >= expectedCount && (rowids.length !== expectedCount || position !== blob.length)) return null;
  return rowids;
}

function* distinctBigramsOf(text, seen) {
  seen.clear();
  let previous = null;
  for (const character of text) {
    if (previous !== null) {
      const bigram = previous + character;
      if (!seen.has(bigram)) {
        seen.add(bigram);
        yield bigram;
      }
    }
    previous = character;
  }
}

/** Pure builder for fixtures and tests: rows are `{ rowid, form }`, ascending by rowid. */
export function collectPostings(rows, maxCount = POSTING_MAX_COUNT) {
  const counts = new Map();
  const seen = new Set();
  for (const row of rows()) for (const bigram of distinctBigramsOf(row.form, seen)) counts.set(bigram, (counts.get(bigram) ?? 0) + 1);
  const lists = new Map();
  const fill = new Map();
  for (const [bigram, count] of counts) {
    if (count <= maxCount) {
      lists.set(bigram, new Int32Array(count));
      fill.set(bigram, 0);
    }
  }
  for (const row of rows()) {
    for (const bigram of distinctBigramsOf(row.form, seen)) {
      const list = lists.get(bigram);
      if (list) {
        list[fill.get(bigram)] = row.rowid;
        fill.set(bigram, fill.get(bigram) + 1);
      }
    }
  }
  return { counts, lists };
}

export async function buildShortQueryPostings({ indexPath, outputPath = shortPostingsPathFor(indexPath), maxCount = POSTING_MAX_COUNT }) {
  const startedAt = performance.now();
  const index = new DatabaseSync(path.resolve(indexPath), { readOnly: true });
  let digest;
  let paragraphCount = 0;
  let collected;
  try {
    digest = indexLogicalRowsDigest(index);
    const rows = function* rows() {
      for (const row of index.prepare('SELECT paragraph_rowid AS rowid, form FROM paragraphs ORDER BY paragraph_rowid').iterate()) {
        paragraphCount += 1;
        yield row;
      }
    };
    collected = collectPostings(rows, maxCount);
    paragraphCount /= 2; // two streaming passes over the same rows
  } finally {
    index.close();
  }

  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.tmp`;
  await rm(temporaryPath, { force: true });
  const output = new DatabaseSync(temporaryPath);
  let postingRows = 0;
  let postingCount = 0;
  try {
    output.exec(`
      CREATE TABLE short_postings (bigram TEXT PRIMARY KEY, paragraph_count INTEGER NOT NULL, rowids BLOB, checksum INTEGER) WITHOUT ROWID;
      CREATE TABLE sidecar_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    `);
    const insert = output.prepare('INSERT INTO short_postings (bigram, paragraph_count, rowids, checksum) VALUES (?, ?, ?, ?)');
    output.exec('BEGIN');
    for (const [bigram, count] of collected.counts) {
      const list = collected.lists.get(bigram);
      const blob = list ? encodePostings(list) : null;
      insert.run(bigram, count, blob, blob ? crc32(blob) : null);
      if (list) {
        postingRows += 1;
        postingCount += list.length;
      }
    }
    const meta = output.prepare('INSERT INTO sidecar_metadata (key, value) VALUES (?, ?)');
    meta.run('version', SHORT_POSTINGS_VERSION);
    meta.run('query_length', String(SHORT_POSTINGS_QUERY_LENGTH));
    meta.run('index_logical_rows_sha256', digest);
    meta.run('paragraph_count', String(paragraphCount));
    meta.run('max_posting_count', String(maxCount));
    meta.run('distinct_bigram_count', String(collected.counts.size));
    meta.run('posting_list_count', String(postingRows));
    meta.run('posting_rowid_count', String(postingCount));
    output.exec('COMMIT');
  } finally {
    output.close();
  }
  await rename(temporaryPath, outputPath);
  return {
    outputPath,
    paragraphCount,
    distinctBigramCount: collected.counts.size,
    postingListCount: postingRows,
    postingRowidCount: postingCount,
    maxPostingCount: maxCount,
    fileBytes: (await stat(outputPath)).size,
    elapsedSeconds: Math.round(performance.now() - startedAt) / 1000,
  };
}

/**
 * Open the posting sidecar, or return null when absent, stale, built for other
 * rows or unsupported. `lookup(query, limit)` returns `{ rowids }` (the first
 * `limit` matching rowids in ascending order, an exact answer), or null when
 * the scan must run (common bigram, missing row, or a malformed list).
 */
export function openShortQueryPostings({ indexPath, indexDatabase }) {
  let sidecar;
  try {
    sidecar = new DatabaseSync(shortPostingsPathFor(path.resolve(indexPath)), { readOnly: true });
  } catch {
    return null;
  }
  try {
    const meta = Object.fromEntries(sidecar.prepare('SELECT key, value FROM sidecar_metadata').all().map((row) => [row.key, row.value]));
    if (meta.version !== SHORT_POSTINGS_VERSION
      || meta.query_length !== String(SHORT_POSTINGS_QUERY_LENGTH)
      || meta.index_logical_rows_sha256 !== indexLogicalRowsDigest(indexDatabase)) {
      sidecar.close();
      return null;
    }
    const lookup = sidecar.prepare('SELECT paragraph_count, rowids, checksum FROM short_postings WHERE bigram = ?');
    return {
      lookup(query, limit) {
        let row;
        try {
          row = lookup.get(query);
        } catch {
          return null;
        }
        // A missing row is not evidence of zero matches: a damaged sidecar looks
        // the same, so the exact scan decides.
        if (!row) return null;
        if (row.rowids === null || row.rowids === undefined) return null;
        // Posting lists are at most POSTING_MAX_COUNT rowids, so the whole list is
        // decoded and checked (count + CRC-32) before its first rows are trusted.
        if (crc32(row.rowids) !== row.checksum) return null;
        const all = decodePostings(row.rowids, Infinity, row.paragraph_count);
        if (all === null || all.length !== row.paragraph_count) return null;
        return { rowids: all.slice(0, limit), paragraphCount: row.paragraph_count };
      },
      close: () => sidecar.close(),
    };
  } catch {
    sidecar.close();
    return null;
  }
}
