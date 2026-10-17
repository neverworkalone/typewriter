import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  BUILD_ONLY_TABLES,
  BUILD_ONLY_TABLES_QUERY,
  DATABASE_KIND_KEY,
  DATABASE_KINDS,
} from '../../src/runtime/dictionary-contract.js';
import { BuildError, verifyDatabase } from './dictionary.mjs';
import { SQLITE_SCHEMA_SQL, SQLITE_SCHEMA_VERSION } from './sqlite-schema.mjs';

/** Product tables the Lite database carries, with the primary-key order that keeps the output deterministic. */
const LITE_TABLE_COPIES = [
  ['metadata', 'key, value', 'key'],
  ['records', 'id, record_type, role, candidate_id, lemma', 'id'],
  ['search_forms', 'record_id, position, form', 'record_id, position'],
  ['generated_surface_forms', 'form, record_id, sense_id, sense_position, rule_id', 'form, record_id, sense_id'],
  ['meanings', 'id, lemma, gloss, record_id, homograph_no', 'id'],
  ['meaning_members', 'meaning_id, position, sense_id, record_id', 'meaning_id, position'],
  ['sense_adjudications', 'sense_id, reason, record_id, duplicate_of_sense_id', 'sense_id'],
  ['meaning_relations', 'source_meaning_id, position, target_meaning_id, type, note, relevance, origin', 'source_meaning_id, position'],
];

/**
 * Classify an open database as `full` or `lite` from its declared kind and its table set; both must agree. Anything
 * else (no kind, an unknown kind, a kind contradicting its tables) is rejected so a wrong database never passes as
 * the other one.
 */
export function readDatabaseKind(database) {
  let declared;
  try {
    declared = database.prepare('SELECT value FROM metadata WHERE key = ?').get(DATABASE_KIND_KEY)?.value;
  } catch (error) {
    throw new BuildError(`dictionary metadata could not be read: ${error.message}`, 'DATABASE_KIND_UNREADABLE');
  }
  const present = database.prepare(BUILD_ONLY_TABLES_QUERY).all().map(({ name }) => name);
  if (declared === DATABASE_KINDS.full && present.length === BUILD_ONLY_TABLES.length) return DATABASE_KINDS.full;
  if (declared === DATABASE_KINDS.lite && present.length === 0) return DATABASE_KINDS.lite;
  throw new BuildError(
    `dictionary kind ${JSON.stringify(declared ?? null)} is not consistent with its tables `
      + `(source tables present: ${present.join(', ') || 'none'})`,
    'DATABASE_KIND_INVALID',
  );
}

export function assertDatabaseKind(database, expectedKind, label = 'dictionary') {
  const kind = readDatabaseKind(database);
  if (kind !== expectedKind) {
    throw new BuildError(`${label} must be a ${expectedKind} dictionary database, found ${kind}`, 'DATABASE_KIND_MISMATCH');
  }
}

/** Open a database read-only and require the given kind. Returns the open handle; the caller closes it. */
export function openDictionaryOfKind(databasePath, expectedKind, label = databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assertDatabaseKind(database, expectedKind, label);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

/**
 * Extract the Meaning-based product (Lite) database from a Full database. The Full database is verified first
 * (kind, schema version, FK/integrity and source-bound projection checks); only the product tables are copied, and
 * all metadata -- including source_revision, canonical_revision and worktree_state -- is inherited unchanged except
 * for the database kind. A failed extraction leaves no output file.
 */
export async function extractLiteDictionary({ fullPath, litePath }) {
  const resolvedFull = path.resolve(fullPath);
  const resolvedLite = path.resolve(litePath);
  if (resolvedFull === resolvedLite) {
    throw new BuildError('Lite dictionary output must differ from the Full dictionary', 'INVALID_LITE_PATH');
  }

  await mkdir(path.dirname(resolvedLite), { recursive: true });
  await rm(resolvedLite, { force: true });

  let full;
  let lite;
  try {
    full = openDictionaryOfKind(resolvedFull, DATABASE_KINDS.full, 'Full dictionary input');
    const userVersion = full.prepare('PRAGMA user_version').get().user_version;
    if (userVersion !== Number.parseInt(SQLITE_SCHEMA_VERSION, 10)) {
      throw new BuildError(
        `Full dictionary schema version must be ${SQLITE_SCHEMA_VERSION}, received ${userVersion}`,
        'FULL_SCHEMA_VERSION',
      );
    }
    full.exec('PRAGMA foreign_keys = ON;');
    verifyDatabase(full, { includeSource: true });
    full.close();
    full = undefined;

    lite = new DatabaseSync(resolvedLite);
    lite.exec('PRAGMA foreign_keys = ON;');
    lite.exec(`PRAGMA user_version = ${Number.parseInt(SQLITE_SCHEMA_VERSION, 10)};`);
    lite.exec(SQLITE_SCHEMA_SQL);
    lite.prepare('ATTACH DATABASE ? AS full_source').run(resolvedFull);
    lite.exec('BEGIN IMMEDIATE;');
    for (const [table, columns, order] of LITE_TABLE_COPIES) {
      const select = table === 'metadata'
        ? `key, CASE WHEN key = '${DATABASE_KIND_KEY}' THEN '${DATABASE_KINDS.lite}' ELSE value END`
        : columns;
      lite.exec(`INSERT INTO main.${table} (${columns}) SELECT ${select} FROM full_source.${table} ORDER BY ${order};`);
    }
    lite.exec('COMMIT;');
    lite.exec('DETACH DATABASE full_source;');
    verifyDatabase(lite);
    assertDatabaseKind(lite, DATABASE_KINDS.lite, 'Extracted Lite dictionary');
    // Bulk inserts leave partially filled pages (~5% of the file at release scale); repack deterministically.
    lite.exec('VACUUM;');
    lite.close();
    lite = undefined;
  } catch (error) {
    for (const database of [full, lite]) {
      if (!database) continue;
      try {
        database.exec('ROLLBACK;');
      } catch {
        // No open transaction.
      }
      database.close();
    }
    await rm(resolvedLite, { force: true });
    if (error instanceof BuildError) throw error;
    throw new BuildError(error.message, 'LITE_EXTRACTION_ERROR');
  }

  return { fullPath: resolvedFull, litePath: resolvedLite };
}

function tableDigest(database, table, columns, order, skipKind) {
  const hash = createHash('sha256');
  let rows = 0;
  for (const row of database.prepare(`SELECT ${columns} FROM ${table} ORDER BY ${order}`).iterate()) {
    if (skipKind && row.key === DATABASE_KIND_KEY) continue;
    hash.update(JSON.stringify(Object.values(row)));
    hash.update('\n');
    rows += 1;
  }
  return { rows, sha256: hash.digest('hex') };
}

/**
 * Prove that `litePath` is a Lite extraction of `fullPath`: the kinds are full/lite, and every product table plus all
 * inherited metadata (everything except `database_kind`) is row-for-row identical. Streams the rows, so it stays
 * memory-light at release scale. The two files legitimately differ byte-wise (source tables, kind).
 */
export function verifyLiteExtraction({ fullPath, litePath }) {
  const full = openDictionaryOfKind(path.resolve(fullPath), DATABASE_KINDS.full, 'Full dictionary');
  try {
    const lite = openDictionaryOfKind(path.resolve(litePath), DATABASE_KINDS.lite, 'Lite dictionary');
    try {
      const digests = {};
      for (const [table, columns, order] of LITE_TABLE_COPIES) {
        const skipKind = table === 'metadata';
        const fullDigest = tableDigest(full, table, columns, order, skipKind);
        const liteDigest = tableDigest(lite, table, columns, order, skipKind);
        if (fullDigest.rows !== liteDigest.rows || fullDigest.sha256 !== liteDigest.sha256) {
          throw new BuildError(`Lite ${table} is not identical to the Full dictionary`, 'LITE_EXTRACTION_MISMATCH');
        }
        digests[table] = fullDigest;
      }
      return digests;
    } finally {
      lite.close();
    }
  } finally {
    full.close();
  }
}
