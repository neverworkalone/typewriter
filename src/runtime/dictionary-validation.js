import {
  decodePackedRelations,
  decodePackedTextRelations,
  meaningNumber,
} from './packed-relations.js';
import {
  BUILD_ONLY_TABLES_QUERY,
  DATABASE_KIND_KEY,
  DATABASE_KINDS,
  DICTIONARY_COUNT_QUERIES,
  DICTIONARY_VERSION,
  LAYOUT_TABLES_QUERY,
  MEANING_INTEGRITY_QUERIES,
  SQLITE_SCHEMA_VERSION,
  layoutFromMetadata,
  layoutTableMismatches,
} from './dictionary-contract.js';
import { ERROR_CODES } from './protocol.js';
import { getMetadata } from './sqlite-query.js';

function validationError(code, message, details = undefined) {
  const error = new Error(message);
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function selectValue(database, sql) {
  if (typeof database.selectValue === 'function') {
    return database.selectValue(sql);
  }

  const row = database.prepare(sql).get();
  return row ? Object.values(row)[0] : undefined;
}

function selectRows(database, sql) {
  if (typeof database.selectObjects === 'function') {
    return database.selectObjects(sql).map((row) => ({ ...row }));
  }
  if (typeof database.prepare === 'function') {
    return database.prepare(sql).all().map((row) => ({ ...row }));
  }

  const resultRows = [];
  database.exec({ sql, rowMode: 'object', resultRows });
  return resultRows;
}

export function readForeignKeyViolations(database) {
  return selectRows(database, 'PRAGMA foreign_key_check');
}

function readMetadata(database) {
  try {
    return getMetadata(database);
  } catch (error) {
    throw validationError(
      ERROR_CODES.DATABASE_METADATA_INVALID,
      'The packaged dictionary metadata could not be read.',
      { cause: error?.message || String(error) },
    );
  }
}

/**
 * Minimal checks the extension needs at startup: schema, dictionary version
 * and source revision. Whole-database scans stay in build/package validation
 * and `validatePackagedDictionary`.
 */
export function validateRuntimeDictionary(database, options = {}) {
  return inspectRuntimeDictionary(database, options).metadata;
}

/**
 * Same checks as `validateRuntimeDictionary`, also returning the Lite storage layout declared by the metadata (read here
 * once, at open time, and passed to the query functions). The layout must match the layout tables actually present.
 */
export function inspectRuntimeDictionary(database, {
  expectedSourceRevision = undefined,
} = {}) {
  const metadata = readMetadata(database);
  const userVersion = String(selectValue(database, 'PRAGMA user_version'));
  if (userVersion !== SQLITE_SCHEMA_VERSION || metadata.schema_version !== SQLITE_SCHEMA_VERSION) {
    throw validationError(
      ERROR_CODES.DATABASE_SCHEMA_MISMATCH,
      'The packaged dictionary schema is not supported by this extension.',
      {
        expected_schema_version: SQLITE_SCHEMA_VERSION,
        metadata_schema_version: metadata.schema_version ?? null,
        user_version: userVersion,
      },
    );
  }

  if (metadata.dictionary_version !== DICTIONARY_VERSION) {
    throw validationError(
      ERROR_CODES.DICTIONARY_VERSION_MISMATCH,
      'The packaged dictionary version is not supported by this extension.',
      {
        expected_dictionary_version: DICTIONARY_VERSION,
        dictionary_version: metadata.dictionary_version ?? null,
      },
    );
  }

  if (
    !/^[0-9a-f]{40}$/.test(metadata.source_revision || '')
    || metadata.source_revision_source !== 'git-head'
    || metadata.source_revision_verified !== 'true'
  ) {
    throw validationError(
      ERROR_CODES.DATABASE_METADATA_INVALID,
      'The packaged dictionary source revision is missing or unverified.',
      {
        source_revision: metadata.source_revision ?? null,
        source_revision_source: metadata.source_revision_source ?? null,
        source_revision_verified: metadata.source_revision_verified ?? null,
      },
    );
  }
  if (
    expectedSourceRevision !== undefined
    && metadata.source_revision !== expectedSourceRevision
  ) {
    throw validationError(
      ERROR_CODES.DICTIONARY_REVISION_MISMATCH,
      'The packaged dictionary source revision does not match this extension build.',
      {
        expected_source_revision: expectedSourceRevision,
        source_revision: metadata.source_revision,
      },
    );
  }

  if (metadata[DATABASE_KIND_KEY] !== DATABASE_KINDS.lite) {
    throw validationError(
      ERROR_CODES.DATABASE_METADATA_INVALID,
      'The packaged dictionary is not a Lite product database.',
      { database_kind: metadata[DATABASE_KIND_KEY] ?? null },
    );
  }

  let buildOnlyTables;
  try {
    buildOnlyTables = selectRows(database, BUILD_ONLY_TABLES_QUERY).map(({ name }) => name);
  } catch (error) {
    throw validationError(
      ERROR_CODES.DATABASE_INTEGRITY_FAILED,
      'The packaged dictionary schema could not be inspected.',
      { cause: error?.message || String(error) },
    );
  }
  if (buildOnlyTables.length > 0) {
    throw validationError(
      ERROR_CODES.DATABASE_INTEGRITY_FAILED,
      'The packaged dictionary contains build-only STDICT source tables.',
      { build_only_tables: buildOnlyTables },
    );
  }

  let layout;
  let layoutTables;
  try {
    layout = layoutFromMetadata(metadata);
    layoutTables = selectRows(database, LAYOUT_TABLES_QUERY).map(({ name }) => name);
  } catch (error) {
    throw validationError(
      ERROR_CODES.DATABASE_METADATA_INVALID,
      'The packaged dictionary storage layout is invalid.',
      { cause: error?.message || String(error) },
    );
  }
  const mismatched = layoutTableMismatches(layout, layoutTables);
  if (mismatched.length > 0) {
    throw validationError(
      ERROR_CODES.DATABASE_INTEGRITY_FAILED,
      'The packaged dictionary tables do not match its declared storage layout.',
      { layout, mismatched_tables: mismatched },
    );
  }

  return { metadata, layout };
}

/**
 * Decode every packed relation list and check what BLOBs cannot enforce with SQLite constraints: canonical Meaning IDs,
 * source/target/pool existence, `(target,type)` and `(text,type)` uniqueness, authored pairing in both directions, and
 * pool integrity. Returns the logical row counts held in packed form. Build and package validation only: startup does
 * not scan the database.
 */
export function validatePackedStorage(database, layout) {
  const counts = { idRelations: 0, textRelations: 0 };
  if (!layout.idCompression && !layout.textCompression) return counts;

  const numbers = new Set(selectRows(database, 'SELECT id FROM meanings').map(({ id }) => meaningNumber(id)));
  if (layout.idCompression) {
    const pairs = new Map();
    for (const { source, data } of selectRows(database, 'SELECT source, data FROM packed_meaning_relations')) {
      if (!numbers.has(Number(source))) throw new Error(`packed relation source ${source} is not a Meaning`);
      const seen = new Set();
      const targets = new Set();
      for (const row of decodePackedRelations(data)) {
        if (!numbers.has(row.target) || row.target === Number(source)) throw new Error(`packed relation target ${row.target} of ${source} is invalid`);
        const key = `${row.target}:${row.type}`;
        if (seen.has(key)) throw new Error(`packed relations of ${source} repeat (target,type) ${key}`);
        seen.add(key);
        targets.add(row.target);
        counts.idRelations += 1;
      }
      pairs.set(Number(source), targets);
    }
    // An authored relation is shown in both directions: each forward row needs some authored row back.
    for (const [source, targets] of pairs) {
      for (const target of targets) {
        if (!pairs.get(target)?.has(source)) throw new Error(`packed authored relation ${source} -> ${target} has no reverse`);
      }
    }
  }
  if (layout.textCompression) {
    const pool = new Map();
    const texts = new Set();
    for (const { id, text } of selectRows(database, 'SELECT id, text FROM text_pool')) {
      if (typeof text !== 'string' || text.length === 0 || texts.has(text)) throw new Error(`text pool entry ${id} is empty or duplicated`);
      texts.add(text);
      pool.set(Number(id), 0);
    }
    for (const { source, data } of selectRows(database, 'SELECT source, data FROM packed_text_relations')) {
      if (!numbers.has(Number(source))) throw new Error(`packed text relation source ${source} is not a Meaning`);
      const seen = new Set();
      for (const row of decodePackedTextRelations(data)) {
        if (!pool.has(row.text)) throw new Error(`packed text relation of ${source} references a missing pool entry`);
        const key = `${row.text}:${row.type}`;
        if (seen.has(key)) throw new Error(`packed text relations of ${source} repeat (text,type) ${key}`);
        seen.add(key);
        pool.set(row.text, pool.get(row.text) + 1);
        counts.textRelations += 1;
      }
    }
    if ([...pool.values()].some((uses) => uses === 0)) throw new Error('text pool has an unused entry');
  }
  return counts;
}

/** Full integrity validation for build, package and benchmark tooling. */
export function validatePackagedDictionary(database, options = {}) {
  const { metadata, layout } = inspectRuntimeDictionary(database, options);

  let integrity;
  try {
    integrity = selectValue(database, 'PRAGMA quick_check');
  } catch (error) {
    throw validationError(
      ERROR_CODES.DATABASE_INTEGRITY_FAILED,
      'The packaged dictionary failed its SQLite integrity check.',
      { cause: error?.message || String(error) },
    );
  }
  if (integrity !== 'ok') {
    throw validationError(
      ERROR_CODES.DATABASE_INTEGRITY_FAILED,
      'The packaged dictionary failed its SQLite integrity check.',
      { integrity_result: integrity ?? null },
    );
  }

  let foreignKeyViolations;
  try {
    foreignKeyViolations = readForeignKeyViolations(database);
  } catch (error) {
    throw validationError(
      ERROR_CODES.DATABASE_INTEGRITY_FAILED,
      'The packaged dictionary foreign-key check could not be completed.',
      { cause: error?.message || String(error) },
    );
  }
  if (foreignKeyViolations.length > 0) {
    throw validationError(
      ERROR_CODES.DATABASE_INTEGRITY_FAILED,
      'The packaged dictionary contains invalid foreign-key references.',
      { foreign_key_violations: foreignKeyViolations },
    );
  }

  let meaningViolations;
  try {
    meaningViolations = Object.fromEntries(
      Object.entries(MEANING_INTEGRITY_QUERIES)
        .map(([key, sql]) => [key, Number(selectValue(database, sql))])
        .filter(([, count]) => count !== 0),
    );
  } catch (error) {
    throw validationError(
      ERROR_CODES.DATABASE_INTEGRITY_FAILED,
      'The packaged dictionary meaning relations could not be verified.',
      { cause: error?.message || String(error) },
    );
  }
  if (Object.keys(meaningViolations).length > 0) {
    throw validationError(
      ERROR_CODES.DATABASE_INTEGRITY_FAILED,
      'The packaged dictionary meaning layer is inconsistent.',
      { meaning_violations: meaningViolations },
    );
  }

  let packedCounts;
  try {
    packedCounts = validatePackedStorage(database, layout);
  } catch (error) {
    throw validationError(
      ERROR_CODES.DATABASE_INTEGRITY_FAILED,
      'The packaged dictionary packed relations are invalid.',
      { cause: error?.message || String(error) },
    );
  }

  let mismatches;
  try {
    // The metadata holds logical totals; the actual value is the table rows plus the decoded packed rows.
    const packedTotals = {
      meaning_relation_count: packedCounts.idRelations,
      meaning_text_relation_count: packedCounts.textRelations,
    };
    mismatches = Object.fromEntries(
      Object.entries(DICTIONARY_COUNT_QUERIES)
        .map(([key, sql]) => {
          const tableRows = key === 'meaning_text_relation_count' && layout.textCompression ? 0 : Number(selectValue(database, sql));
          return [key, { expected: metadata[key], actual: String(tableRows + (packedTotals[key] ?? 0)) }];
        })
        .filter(([, values]) => values.expected !== values.actual),
    );
  } catch (error) {
    throw validationError(
      ERROR_CODES.DATABASE_METADATA_INVALID,
      'The packaged dictionary tables could not be verified.',
      { cause: error?.message || String(error) },
    );
  }
  if (Object.keys(mismatches).length > 0) {
    throw validationError(
      ERROR_CODES.DATABASE_METADATA_INVALID,
      'The packaged dictionary metadata does not match its contents.',
      { count_mismatches: mismatches },
    );
  }

  return metadata;
}
