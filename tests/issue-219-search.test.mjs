import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { openCurrentRevisionDatabasePath } from '../scripts/ci/current-revision-database.mjs';
import {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
} from '../scripts/build/query.mjs';
import { DEFAULT_CANONICAL_DIRECTORY } from '../scripts/validate/canonical-jsonl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMPORT_PATH = path.join(ROOT, 'data/canonical/issue-219-m9-a-recovery.jsonl');

function parseJsonl(bytes) {
  return bytes.toString('utf8').split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}

test('Issue #219 held expression stays out of exact search while source terms are pending', async () => {
  const records = parseJsonl(await readFile(IMPORT_PATH));
  assert.deepEqual(records, []);
  const { databasePath, outputDirectory } = await openCurrentRevisionDatabasePath({
    temporaryRoot: os.tmpdir(),
    prefix: 'typewriter-issue-219-search-',
    repositoryDirectory: ROOT,
  });
  let database;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(findRecordsByExactTerm(database, '컨테이너 야드'), []);
    const response = findRecordsBySearchTerm(database, '컨테이너 야드');
    assert.equal(response.status, 'no-match', 'held candidate exact search status');
    assert.deepEqual(response.matches, []);
  } finally {
    database?.close();
    if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  }
});
