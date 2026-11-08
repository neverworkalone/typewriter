import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  BUILD_ONLY_TABLES,
  BUILD_ONLY_TABLES_QUERY,
  DATABASE_KIND_KEY,
  DATABASE_KINDS,
  LAYOUT_TABLES_QUERY,
  LITE_LAYOUT_KEYS,
  MEANING_RELATION_ORIGINS,
  layoutFromMetadata,
  layoutTableMismatches,
} from '../../src/runtime/dictionary-contract.js';
import {
  decodePackedRelations,
  decodePackedTextRelations,
  encodePackedRelations,
  encodePackedTextRelations,
  meaningId,
  meaningNumber,
} from '../../src/runtime/packed-relations.js';
import { validatePackedStorage } from '../../src/runtime/dictionary-validation.js';
import { BuildError, verifyDatabase } from './dictionary.mjs';
import { LITE_OPTIMIZATION } from './dictionary-config.mjs';
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
];

const RELATION_COLUMNS = 'source_meaning_id, position, target_meaning_id, type, note, relevance, origin';
const TEXT_RELATION_COLUMNS = 'source_meaning_id, position, text, type, relevance';
const AUTHORED_ORIGINS_SQL = `'${MEANING_RELATION_ORIGINS.authored}', '${MEANING_RELATION_ORIGINS.authoredReverse}'`;
/** Metadata rows that legitimately differ between Full and Lite. */
const LITE_ONLY_METADATA_KEYS = new Set([DATABASE_KIND_KEY, ...Object.values(LITE_LAYOUT_KEYS)]);

const PACKED_SCHEMA_SQL = {
  idCompression: `CREATE TABLE packed_meaning_relations (
    source INTEGER PRIMARY KEY NOT NULL,
    data BLOB NOT NULL
  ) WITHOUT ROWID;`,
  textCompression: `DROP TABLE meaning_text_relations;
  CREATE TABLE text_pool (
    id INTEGER PRIMARY KEY NOT NULL,
    text TEXT NOT NULL CHECK (length(text) > 0)
  );
  CREATE TABLE packed_text_relations (
    source INTEGER PRIMARY KEY NOT NULL,
    data BLOB NOT NULL
  ) WITHOUT ROWID;`,
};

function resolveLayout(optimization) {
  for (const key of Object.keys(LITE_LAYOUT_KEYS)) {
    if (typeof optimization?.[key] !== 'boolean') {
      throw new BuildError(`LITE_OPTIMIZATION.${key} must be a boolean`, 'INVALID_LITE_OPTIMIZATION');
    }
  }
  return Object.freeze({ idCompression: optimization.idCompression, textCompression: optimization.textCompression });
}

/** Every Meaning ID must survive string -> integer -> string unchanged and be unique before any integer is stored. */
function assertCanonicalMeaningIds(database) {
  const seen = new Set();
  for (const { id } of database.prepare('SELECT id FROM meanings').iterate()) {
    const number = meaningNumber(id);
    if (seen.has(number)) throw new BuildError(`Meaning ID ${id} collides with another Meaning`, 'MEANING_ID_NOT_PACKABLE');
    seen.add(number);
  }
}

/** Group consecutive rows of `iterator` by `source_meaning_id` (the query orders by it) and hand each group to `write`. */
function forEachSource(iterator, write) {
  let source;
  let group = [];
  for (const row of iterator) {
    if (row.source_meaning_id !== source) {
      if (group.length) write(source, group);
      source = row.source_meaning_id;
      group = [];
    }
    group.push(row);
  }
  if (group.length) write(source, group);
}

function packAuthoredRelations(lite) {
  const insert = lite.prepare('INSERT INTO packed_meaning_relations(source, data) VALUES (?, ?)');
  forEachSource(lite.prepare(`SELECT ${RELATION_COLUMNS} FROM full_source.meaning_relations
    WHERE origin IN (${AUTHORED_ORIGINS_SQL}) ORDER BY source_meaning_id, position`).iterate(), (source, rows) => {
    insert.run(meaningNumber(source), encodePackedRelations(rows.map((row) => ({
      position: row.position,
      target: meaningNumber(row.target_meaning_id),
      type: row.type,
      relevance: row.relevance,
      origin: row.origin,
      note: row.note,
    }))));
  });
}

/** Deduplicated texts get pool IDs by descending use (small varints for common texts), ties by text: deterministic. */
function packTextRelations(lite) {
  const rows = lite.prepare(`SELECT ${TEXT_RELATION_COLUMNS} FROM full_source.meaning_text_relations
    ORDER BY source_meaning_id, position`).all();
  const uses = new Map();
  for (const { text } of rows) uses.set(text, (uses.get(text) ?? 0) + 1);
  const poolIds = new Map([...uses].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([text], index) => [text, index + 1]));
  const insertText = lite.prepare('INSERT INTO text_pool(id, text) VALUES (?, ?)');
  for (const [text, id] of poolIds) insertText.run(id, text);
  const insert = lite.prepare('INSERT INTO packed_text_relations(source, data) VALUES (?, ?)');
  forEachSource(rows, (source, group) => {
    insert.run(meaningNumber(source), encodePackedTextRelations(group.map((row) => ({
      position: row.position, text: poolIds.get(row.text), type: row.type, relevance: row.relevance,
    }))));
  });
}

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
export async function extractLiteDictionary({ fullPath, litePath, optimization = LITE_OPTIMIZATION }) {
  const layout = resolveLayout(optimization);
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
    for (const [flag, sql] of Object.entries(PACKED_SCHEMA_SQL)) if (layout[flag]) lite.exec(sql);
    lite.prepare('ATTACH DATABASE ? AS full_source').run(resolvedFull);
    lite.exec('BEGIN IMMEDIATE;');
    for (const [table, columns, order] of LITE_TABLE_COPIES) {
      const select = table === 'metadata'
        ? `key, CASE WHEN key = '${DATABASE_KIND_KEY}' THEN '${DATABASE_KINDS.lite}' ELSE value END`
        : columns;
      lite.exec(`INSERT INTO main.${table} (${columns}) SELECT ${select} FROM full_source.${table} ORDER BY ${order};`);
    }
    const insertFlag = lite.prepare('INSERT INTO metadata(key, value) VALUES (?, ?)');
    for (const [flag, key] of Object.entries(LITE_LAYOUT_KEYS)) insertFlag.run(key, String(layout[flag]));
    // Packed rows leave their plain table; with a flag off the plain table keeps every row, as before.
    lite.exec(`INSERT INTO main.meaning_relations (${RELATION_COLUMNS}) SELECT ${RELATION_COLUMNS}
      FROM full_source.meaning_relations${layout.idCompression ? ` WHERE origin NOT IN (${AUTHORED_ORIGINS_SQL})` : ''}
      ORDER BY source_meaning_id, position;`);
    if (!layout.textCompression) {
      lite.exec(`INSERT INTO main.meaning_text_relations (${TEXT_RELATION_COLUMNS}) SELECT ${TEXT_RELATION_COLUMNS}
        FROM full_source.meaning_text_relations ORDER BY source_meaning_id, position;`);
    }
    if (layout.idCompression || layout.textCompression) assertCanonicalMeaningIds(lite);
    if (layout.idCompression) packAuthoredRelations(lite);
    if (layout.textCompression) packTextRelations(lite);
    lite.exec('COMMIT;');
    lite.exec('DETACH DATABASE full_source;');
    verifyDatabase(lite);
    validatePackedStorage(lite, layout);
    assertDatabaseKind(lite, DATABASE_KINDS.lite, 'Extracted Lite dictionary');
    // Bulk inserts leave partially filled pages (~5% of the file at release scale); repack deterministically.
    lite.exec('VACUUM;');
    lite.close();
    lite = undefined;
    verifyLiteExtraction({ fullPath: resolvedFull, litePath: resolvedLite });
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

function tableDigest(database, table, columns, order, skipKeys, where = '1') {
  const hash = createHash('sha256');
  let rows = 0;
  for (const row of database.prepare(`SELECT ${columns} FROM ${table} WHERE ${where} ORDER BY ${order}`).iterate()) {
    if (skipKeys && skipKeys.has(row.key)) continue;
    hash.update(JSON.stringify(Object.values(row)));
    hash.update('\n');
    rows += 1;
  }
  return { rows, sha256: hash.digest('hex') };
}

function mismatch(what) {
  return new BuildError(`Lite ${what} is not identical to the Full dictionary`, 'LITE_EXTRACTION_MISMATCH');
}

function equalDigests(left, right) {
  return left.rows === right.rows && left.sha256 === right.sha256;
}

/** Decode every packed authored list and compare it, field by field, with the Full rows of the same source. */
function compareAuthoredRelations(full, lite) {
  const fullRows = full.prepare(`SELECT ${RELATION_COLUMNS} FROM meaning_relations
    WHERE source_meaning_id = ? AND origin IN (${AUTHORED_ORIGINS_SQL}) ORDER BY position`);
  let rows = 0;
  for (const { source, data } of lite.prepare('SELECT source, data FROM packed_meaning_relations ORDER BY source').iterate()) {
    const id = meaningId(source);
    const expected = fullRows.all(id);
    const decoded = decodePackedRelations(data);
    if (decoded.length !== expected.length) throw mismatch('packed relations');
    decoded.forEach((row, index) => {
      const want = expected[index];
      if (want.position !== row.position || want.target_meaning_id !== meaningId(row.target) || want.type !== row.type
        || want.note !== row.note || want.relevance !== row.relevance || want.origin !== row.origin) {
        throw mismatch('packed relations');
      }
    });
    rows += decoded.length;
  }
  const total = full.prepare(`SELECT COUNT(*) AS count FROM meaning_relations WHERE origin IN (${AUTHORED_ORIGINS_SQL})`).get().count;
  if (rows !== total) throw mismatch('packed relations');
  return rows;
}

/** Restore the text pool and every packed text relation and compare them with the Full text relations. */
function compareTextRelations(full, lite) {
  const pool = new Map(lite.prepare('SELECT id, text FROM text_pool').all().map(({ id, text }) => [id, text]));
  const distinct = full.prepare('SELECT COUNT(DISTINCT text) AS count FROM meaning_text_relations').get().count;
  if (pool.size !== distinct) throw mismatch('text pool');
  const fullRows = full.prepare(`SELECT ${TEXT_RELATION_COLUMNS} FROM meaning_text_relations
    WHERE source_meaning_id = ? ORDER BY position`);
  let rows = 0;
  for (const { source, data } of lite.prepare('SELECT source, data FROM packed_text_relations ORDER BY source').iterate()) {
    const expected = fullRows.all(meaningId(source));
    const decoded = decodePackedTextRelations(data);
    if (decoded.length !== expected.length) throw mismatch('packed text relations');
    decoded.forEach((row, index) => {
      const want = expected[index];
      if (want.position !== row.position || want.text !== pool.get(row.text) || want.type !== row.type || want.relevance !== row.relevance) {
        throw mismatch('packed text relations');
      }
    });
    rows += decoded.length;
  }
  if (rows !== full.prepare('SELECT COUNT(*) AS count FROM meaning_text_relations').get().count) throw mismatch('packed text relations');
  return rows;
}

/**
 * Prove that `litePath` is a Lite extraction of `fullPath` for whichever layout the Lite declares: the kinds are
 * full/lite, the inherited product tables and metadata are row-for-row identical, and every logical relation of Full
 * (stored or decoded from a packed list) is present in Lite with the same source, position, target, type, relevance,
 * origin and note, and every text pool entry and text relation is restored. The same checks run for all four layouts;
 * nothing is skipped because a layout does not use a table. Streams rows, so it stays memory-light at release scale.
 */
export function verifyLiteExtraction({ fullPath, litePath }) {
  const full = openDictionaryOfKind(path.resolve(fullPath), DATABASE_KINDS.full, 'Full dictionary');
  try {
    const lite = openDictionaryOfKind(path.resolve(litePath), DATABASE_KINDS.lite, 'Lite dictionary');
    try {
      const layout = layoutFromMetadata(Object.fromEntries(lite.prepare('SELECT key, value FROM metadata').all().map(({ key, value }) => [key, value])));
      const tables = layoutTableMismatches(layout, lite.prepare(LAYOUT_TABLES_QUERY).all().map(({ name }) => name));
      if (tables.length > 0) throw new BuildError(`Lite tables do not match its declared storage layout: ${tables.join(', ')}`, 'LITE_LAYOUT_MISMATCH');

      const digests = {};
      for (const [table, columns, order] of LITE_TABLE_COPIES) {
        const skipKeys = table === 'metadata' ? LITE_ONLY_METADATA_KEYS : undefined;
        const fullDigest = tableDigest(full, table, columns, order, skipKeys);
        if (!equalDigests(fullDigest, tableDigest(lite, table, columns, order, skipKeys))) throw mismatch(table);
        digests[table] = fullDigest;
      }

      const plainWhere = layout.idCompression ? `origin NOT IN (${AUTHORED_ORIGINS_SQL})` : '1';
      const fullPlain = tableDigest(full, 'meaning_relations', RELATION_COLUMNS, 'source_meaning_id, position', undefined, plainWhere);
      if (!equalDigests(fullPlain, tableDigest(lite, 'meaning_relations', RELATION_COLUMNS, 'source_meaning_id, position'))) throw mismatch('meaning_relations');
      const packed = validatePackedStorage(lite, layout);
      const packedRelations = layout.idCompression ? compareAuthoredRelations(full, lite) : 0;
      if (packedRelations !== packed.idRelations) throw mismatch('packed relations');
      digests.meaning_relations = { rows: fullPlain.rows + packedRelations };

      if (layout.textCompression) {
        const textRelations = compareTextRelations(full, lite);
        if (textRelations !== packed.textRelations) throw mismatch('packed text relations');
        digests.meaning_text_relations = { rows: textRelations };
      } else {
        const fullText = tableDigest(full, 'meaning_text_relations', TEXT_RELATION_COLUMNS, 'source_meaning_id, position');
        if (!equalDigests(fullText, tableDigest(lite, 'meaning_text_relations', TEXT_RELATION_COLUMNS, 'source_meaning_id, position'))) throw mismatch('meaning_text_relations');
        digests.meaning_text_relations = fullText;
      }
      return digests;
    } finally {
      lite.close();
    }
  } finally {
    full.close();
  }
}
