import sqlite3InitModule from './vendor/sqlite3.mjs';
import {
  ERROR_CODES,
  MESSAGE_TYPES,
  RUNTIME_PROTOCOL_VERSION,
} from './protocol.js';

let databasePromise;

function workerError(code, message, details) {
  const error = new Error(message);
  error.code = code;

  if (details !== undefined) {
    error.details = details;
  }

  return error;
}

function errorPayload(error, fallbackCode = ERROR_CODES.QUERY_FAILED) {
  return {
    code: typeof error?.code === 'string' ? error.code : fallbackCode,
    message: typeof error?.message === 'string' && error.message.length > 0
      ? error.message
      : 'Dictionary runtime request failed.',
    ...(error?.details === undefined ? {} : { details: error.details }),
  };
}

async function loadDatabase() {
  let sqlite3;

  try {
    sqlite3 = await sqlite3InitModule();
  } catch (error) {
    throw workerError(
      ERROR_CODES.WASM_LOAD_FAILED,
      'The SQLite WASM module could not be initialized.',
      { cause: error?.message || String(error) },
    );
  }

  let response;
  try {
    response = await fetch(new URL('../dictionary.sqlite', self.location.href));
  } catch (error) {
    throw workerError(
      ERROR_CODES.ASSET_LOAD_FAILED,
      'The packaged dictionary database could not be fetched.',
      { cause: error?.message || String(error) },
    );
  }

  if (!response.ok) {
    throw workerError(
      ERROR_CODES.ASSET_LOAD_FAILED,
      `The packaged dictionary database returned HTTP ${response.status}.`,
      { status: response.status },
    );
  }

  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw workerError(
      ERROR_CODES.ASSET_LOAD_FAILED,
      'The packaged dictionary database could not be read.',
      { cause: error?.message || String(error) },
    );
  }

  let database;
  try {
    database = new sqlite3.oo1.DB();
    const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
    const resultCode = sqlite3.capi.sqlite3_deserialize(
      database.pointer,
      'main',
      pointer,
      bytes.byteLength,
      bytes.byteLength,
      sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE,
    );

    database.checkRc(resultCode);
    database.exec('PRAGMA query_only = ON');

    const queryOnly = Number(database.selectValue('PRAGMA query_only'));
    if (queryOnly !== 1) {
      throw workerError(
        ERROR_CODES.DATABASE_LOAD_FAILED,
        'The dictionary database could not be placed in query-only mode.',
        { query_only: queryOnly },
      );
    }

    return {
      database,
      sqlite3,
      bytes: bytes.byteLength,
      queryOnly,
    };
  } catch (error) {
    try {
      database?.close();
    } catch {
      // Preserve the original load error.
    }

    if (error?.code) {
      throw error;
    }

    throw workerError(
      ERROR_CODES.DATABASE_LOAD_FAILED,
      'The packaged dictionary database could not be opened.',
      { cause: error?.message || String(error) },
    );
  }
}

function getDatabase() {
  if (!databasePromise) {
    databasePromise = loadDatabase();
  }

  return databasePromise;
}

function rows(database, sql, parameters = []) {
  return database.selectObjects(sql, parameters).map((row) => ({ ...row }));
}

function getSenseRelations(database, senseId) {
  return rows(database, `
    SELECT
      relations.position,
      relations.target_record_id AS target,
      relations.target_sense_id AS target_sense,
      relations.type,
      relations.note,
      target_records.lemma AS target_lemma,
      target_senses.pos AS target_pos,
      target_senses.gloss AS target_gloss
    FROM relations
    INNER JOIN records AS target_records
      ON target_records.id = relations.target_record_id
    LEFT JOIN senses AS target_senses
      ON target_senses.id = relations.target_sense_id
      AND target_senses.record_id = relations.target_record_id
    WHERE relations.source_sense_id = ?
    ORDER BY relations.position
  `, [senseId]);
}

function getRecord(database, recordId) {
  const record = rows(database, `
    SELECT id, record_type, role, candidate_id, lemma
    FROM records
    WHERE id = ?
  `, [recordId])[0];

  if (!record) {
    return null;
  }

  const searchForms = rows(database, `
    SELECT form
    FROM search_forms
    WHERE record_id = ?
    ORDER BY position
  `, [recordId]).map(({ form }) => form);

  const senses = rows(database, `
    SELECT id, pos, gloss
    FROM senses
    WHERE record_id = ?
    ORDER BY position
  `, [recordId]).map((sense) => ({
    ...sense,
    relations: getSenseRelations(database, sense.id),
  }));

  return {
    ...record,
    search_forms: searchForms,
    senses,
  };
}

function findStartRecords(database, term) {
  return rows(database, `
    SELECT id, record_type, role, candidate_id, lemma
    FROM records
    WHERE role = 'start' AND lemma = ?
    UNION
    SELECT records.id, records.record_type, records.role, records.candidate_id, records.lemma
    FROM records
    INNER JOIN search_forms
      ON search_forms.record_id = records.id
    WHERE records.role = 'start'
      AND search_forms.form = ?
    ORDER BY id
  `, [term, term]);
}

function getMetadata(database) {
  return Object.fromEntries(rows(database, `
    SELECT key, value
    FROM metadata
    ORDER BY key
  `).map(({ key, value }) => [key, value]));
}

function getStatus(runtime) {
  return {
    ready: true,
    state: 'ready',
    query_only: runtime.queryOnly,
    database_bytes: runtime.bytes,
    sqlite_version: runtime.sqlite3.version.libVersion,
  };
}

function validateString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw workerError(ERROR_CODES.INVALID_ARGUMENT, `${name} must be a non-empty string.`);
  }

  return value;
}

async function dispatch(method, params = {}) {
  if (method === 'close') {
    const runtime = await getDatabase();
    runtime.database.close();
    databasePromise = null;
    return { closed: true };
  }

  const runtime = await getDatabase();
  const { database } = runtime;

  try {
    switch (method) {
      case 'ready':
      case 'status':
        return getStatus(runtime);
      case 'search':
        return findStartRecords(database, validateString(params.term, 'term'));
      case 'get-record':
        return getRecord(database, validateString(params.recordId, 'recordId'));
      case 'get-relations':
        return getSenseRelations(database, validateString(params.senseId, 'senseId'));
      case 'metadata':
        return getMetadata(database);
      default:
        throw workerError(
          ERROR_CODES.UNSUPPORTED_REQUEST,
          `Unsupported dictionary runtime request: ${method}.`,
        );
    }
  } catch (error) {
    if (error?.code) {
      throw error;
    }

    throw workerError(
      ERROR_CODES.QUERY_FAILED,
      'The dictionary runtime query failed.',
      { cause: error?.message || String(error) },
    );
  }
}

function postResponse(id, response) {
  self.postMessage({
    protocol: RUNTIME_PROTOCOL_VERSION,
    type: MESSAGE_TYPES.response,
    id,
    ...response,
  });
}

self.addEventListener('message', async (event) => {
  const request = event?.data;

  if (
    !request
    || request.protocol !== RUNTIME_PROTOCOL_VERSION
    || request.type !== MESSAGE_TYPES.request
  ) {
    if (request?.id !== undefined) {
      postResponse(request.id, {
        ok: false,
        error: errorPayload(workerError(
          ERROR_CODES.INVALID_REQUEST,
          'The dictionary worker received an invalid request.',
        )),
      });
    }
    return;
  }

  try {
    const result = await dispatch(request.method, request.params);
    postResponse(request.id, { ok: true, result });
  } catch (error) {
    postResponse(request.id, { ok: false, error: errorPayload(error) });
  }
});
