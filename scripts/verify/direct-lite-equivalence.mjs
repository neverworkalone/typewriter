import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { buildDictionary } from '../build/dictionary.mjs';
import { LITE_TABLE_COPIES, extractLiteDictionary } from '../build/lite-dictionary.mjs';
import { PROVENANCE_KEYS, buildProductDictionary } from '../build/direct-lite.mjs';
import { createDictionaryProgress } from '../build/dictionary-progress.mjs';
import { decodePackedRelations, decodePackedTextRelations, meaningId } from '../../src/runtime/packed-relations.js';

/**
 * Issue #9931 equivalence audit: the Full -> Lite reference path and the Direct Lite product path must produce the same
 * logical product dictionary from the same inputs. Every product table, every decoded packed relation (text resolved
 * through the pool) and all metadata are streamed into per-table digests; only the per-build provenance keys may
 * differ. Audit tooling only: not part of `pnpm run build` or CI.
 */
const SKIPPED_METADATA = new Set(PROVENANCE_KEYS);

function digestRows(rows) {
  const hash = createHash('sha256');
  let count = 0;
  for (const row of rows) {
    hash.update(JSON.stringify(row));
    hash.update('\n');
    count += 1;
  }
  return { rows: count, sha256: hash.digest('hex') };
}

function* packedRelations(database) {
  for (const { source, data } of database.prepare('SELECT source, data FROM packed_meaning_relations ORDER BY source').iterate()) {
    for (const row of decodePackedRelations(data)) yield [meaningId(Number(source)), row.position, meaningId(row.target), row.type, row.note, row.relevance, row.origin];
  }
}

function* packedTextRelations(database) {
  const pool = new Map(database.prepare('SELECT id, text FROM text_pool').all().map(({ id, text }) => [Number(id), text]));
  for (const { source, data } of database.prepare('SELECT source, data FROM packed_text_relations ORDER BY source').iterate()) {
    for (const row of decodePackedTextRelations(data)) yield [meaningId(Number(source)), row.position, pool.get(row.text), row.type, row.relevance];
  }
}

const hasTable = (database, name) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));

/** Logical per-table digests of a Lite database (any layout). */
export function liteLogicalDigest(litePath) {
  const database = new DatabaseSync(litePath, { readOnly: true });
  try {
    const digests = {};
    for (const [table, columns, order] of LITE_TABLE_COPIES) {
      const rows = database.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${order}`).iterate();
      digests[table] = digestRows((function* filter() {
        for (const row of rows) if (table !== 'metadata' || !SKIPPED_METADATA.has(row.key)) yield Object.values(row);
      }()));
    }
    digests.meaning_relations_plain = digestRows((function* plain() {
      for (const row of database.prepare('SELECT source_meaning_id, position, target_meaning_id, type, note, relevance, origin FROM meaning_relations ORDER BY source_meaning_id, position').iterate()) yield Object.values(row);
    }()));
    digests.meaning_relations_packed = hasTable(database, 'packed_meaning_relations') ? digestRows(packedRelations(database)) : { rows: 0 };
    digests.meaning_text_relations = hasTable(database, 'packed_text_relations')
      ? digestRows(packedTextRelations(database))
      : digestRows((function* plainText() {
        for (const row of database.prepare('SELECT source_meaning_id, position, text, type, relevance FROM meaning_text_relations ORDER BY source_meaning_id, position').iterate()) yield Object.values(row);
      }()));
    digests.schema = digestRows(database.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all().map(Object.values));
    return digests;
  } finally {
    database.close();
  }
}

/** Table names whose digests differ. */
export function digestDifferences(left, right) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => JSON.stringify(left[key]) !== JSON.stringify(right[key]));
}

export async function compareDirectLite({ canonicalDirectory, relationsDirectory, recordMeanings, allowDirty = true, onProgress } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-equivalence-'));
  try {
    const fullPath = path.join(directory, 'full.sqlite');
    const referencePath = path.join(directory, 'reference-lite.sqlite');
    const directPath = path.join(directory, 'direct-lite.sqlite');
    let started = performance.now();
    await buildDictionary({ inputDirectory: canonicalDirectory, outputPath: fullPath, relationsDirectory, recordMeanings, allowDirty, onProgress });
    await extractLiteDictionary({ fullPath, litePath: referencePath });
    const referenceSeconds = (performance.now() - started) / 1000;
    await rm(fullPath, { force: true });
    started = performance.now();
    await buildProductDictionary({ canonicalDirectory, relationsDirectory, recordMeanings, outputPath: directPath, allowDirty, cache: false, onProgress });
    const directSeconds = (performance.now() - started) / 1000;
    const reference = liteLogicalDigest(referencePath);
    const direct = liteLogicalDigest(directPath);
    return { differences: digestDifferences(reference, direct), reference, direct, referenceSeconds, directSeconds };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  compareDirectLite({ allowDirty: process.argv.includes('--allow-dirty'), onProgress: createDictionaryProgress() }).then((result) => {
    for (const [table, digest] of Object.entries(result.direct)) console.log(`${table}: ${digest.rows} row(s) ${digest.sha256 ?? ''}`);
    console.log(`Full -> Lite: ${result.referenceSeconds.toFixed(1)}s, Direct Lite (cache off): ${result.directSeconds.toFixed(1)}s`);
    if (result.differences.length > 0) {
      console.error(`Direct Lite differs from Full -> Lite in: ${result.differences.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('Direct Lite is logically identical to Full -> Lite (provenance metadata excluded).');
    }
  }).catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
