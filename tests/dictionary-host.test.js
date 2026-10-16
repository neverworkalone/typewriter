import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { SQLITE_SCHEMA_SQL } from '../scripts/build/sqlite-schema.mjs';
import {
  DICTIONARY_COUNT_QUERIES,
  DICTIONARY_VERSION,
  SQLITE_SCHEMA_VERSION,
} from '../src/runtime/dictionary-contract.js';
import { createDictionaryHost } from '../src/runtime/dictionary-host.js';
import {
  createRequest,
  MESSAGE_TYPES,
  REQUEST_METHODS,
  RUNTIME_PROTOCOL_VERSION,
} from '../src/runtime/protocol.js';

const SOURCE_REVISION = 'a'.repeat(40);
let databaseBytes;

beforeAll(() => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'typewriter-host-')), 'dictionary.sqlite');
  const database = new DatabaseSync(file);
  database.exec(`PRAGMA user_version = ${Number(SQLITE_SCHEMA_VERSION)}; ${SQLITE_SCHEMA_SQL}`);
  const metadata = {
    dictionary_version: DICTIONARY_VERSION,
    schema_version: SQLITE_SCHEMA_VERSION,
    source_revision: SOURCE_REVISION,
    source_revision_source: 'git-head',
    source_revision_verified: 'true',
    database_kind: 'lite',
    ...Object.fromEntries(Object.keys(DICTIONARY_COUNT_QUERIES).map((key) => [key, '0'])),
  };
  const insert = database.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
  for (const [key, value] of Object.entries(metadata)) insert.run(key, value);
  database.close();
  databaseBytes = readFileSync(file);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function request(id, method, params) {
  return createRequest(id, method, params);
}

describe('dictionary host load lifecycle', () => {
  it('retries the database load after a transient failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Response(databaseBytes));
    vi.stubGlobal('fetch', fetchMock);
    const host = createDictionaryHost({
      sqlite3InitModule,
      dictionaryUrl: 'chrome-extension://test/dictionary.sqlite',
      expectedSourceRevision: SOURCE_REVISION,
    });

    const failed = await host.handleRequest(request('1', REQUEST_METHODS.ready));
    expect(failed).toMatchObject({ ok: false, error: { code: 'ASSET_LOAD_FAILED' } });

    const recovered = await host.handleRequest(request('2', REQUEST_METHODS.ready));
    expect(recovered).toMatchObject({
      protocol: RUNTIME_PROTOCOL_VERSION,
      type: MESSAGE_TYPES.response,
      id: '2',
      ok: true,
      result: { ready: true, query_only: 1, source_revision: SOURCE_REVISION },
    });

    await host.handleRequest(request('3', REQUEST_METHODS.status));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries after a validation failure and reuses a successful load', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(databaseBytes));
    vi.stubGlobal('fetch', fetchMock);
    const host = createDictionaryHost({
      sqlite3InitModule,
      dictionaryUrl: 'chrome-extension://test/dictionary.sqlite',
      expectedSourceRevision: 'b'.repeat(40),
    });

    const mismatched = await host.handleRequest(request('1', REQUEST_METHODS.ready));
    expect(mismatched).toMatchObject({ ok: false, error: { code: 'DICTIONARY_REVISION_MISMATCH' } });
    await host.handleRequest(request('2', REQUEST_METHODS.ready));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
