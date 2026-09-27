import {
  DICTIONARY_COUNT_QUERIES,
  DICTIONARY_VERSION,
  SQLITE_SCHEMA_VERSION,
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

export function validatePackagedDictionary(database, {
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

  let mismatches;
  try {
    mismatches = Object.fromEntries(
      Object.entries(DICTIONARY_COUNT_QUERIES)
        .map(([key, sql]) => [key, {
          expected: metadata[key],
          actual: String(selectValue(database, sql)),
        }])
        .filter(([key, values]) => values.expected !== values.actual),
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
