import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { buildIssue223CorpusBatch } from '../scripts/batch/build-issue-223-corpus-batch.mjs';
import { ACTIVE_PRODUCTION_ENTRYPOINTS, HISTORICAL_ENTRYPOINTS } from '../scripts/batch/production-entrypoints.mjs';
import { INTAKE_HANDOFF_FIRST_BATCH, assertIntakeHandoffPolicy, requiresIntakeHandoff } from '../scripts/intake/production-handoff.mjs';

async function scriptFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await scriptFiles(full));
    else if (entry.name.endsWith('.mjs') && !entry.name.endsWith('.test.mjs')) found.push(full);
  }
  return found;
}

// A write whose arguments name canonical data (directly or via the import path).
// Writes into a temporary verification copy are not production writes.
const CANONICAL_WRITE = /(?:writeFile|appendFile|rename|copyFile)\([^;]*?(?:[Cc]anonical|importPath)/gu;
const writesCanonical = (source) => [...source.matchAll(CANONICAL_WRITE)].some(([call]) => !/temporary|tmp/iu.test(call));

test('every script that can write canonical records is a declared production entrypoint', async () => {
  const writers = [];
  for (const file of await scriptFiles('scripts')) {
    const source = await readFile(file, 'utf8');
    if (writesCanonical(source)) writers.push(file.split(path.sep).join('/'));
  }
  const declared = [...Object.keys(ACTIVE_PRODUCTION_ENTRYPOINTS), ...Object.keys(HISTORICAL_ENTRYPOINTS)].sort();
  assert.deepEqual(writers.sort(), declared, 'a canonical writer is undeclared (or a declared one no longer writes); declare it as active or historical');
});

test('historical writers are fixed to completed batches and cannot take a new batch id', async () => {
  for (const file of Object.keys(HISTORICAL_ENTRYPOINTS)) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(source, /--batch-id|args\['batch-id'\]/u, `${file} must not accept a batch id`);
  }
});

test('the active builder is gated by the shared intake hand-off policy and boundary check', async () => {
  const [file] = Object.keys(ACTIVE_PRODUCTION_ENTRYPOINTS);
  const source = await readFile(file, 'utf8');
  assert.match(source, /assertIntakeHandoffPolicy\(/u);
  assert.match(source, /assertBatchIntakeHandoff\(/u);
});

test('activation batch: hand-off is optional before it and mandatory from it', async () => {
  assert.equal(INTAKE_HANDOFF_FIRST_BATCH, 16);
  assert.equal(requiresIntakeHandoff(15), false);
  assert.equal(requiresIntakeHandoff(16), true);
  assert.equal(assertIntakeHandoffPolicy({ batchOrdinal: 15, hasHandoff: false }), true);
  assert.equal(assertIntakeHandoffPolicy({ batchOrdinal: 16, hasHandoff: true }), true);
  assert.throws(() => assertIntakeHandoffPolicy({ batchOrdinal: 16, hasHandoff: false }), (error) => error.code === 'INTAKE_HANDOFF_REQUIRED');
  assert.throws(() => assertIntakeHandoffPolicy({ batchOrdinal: 40, hasHandoff: false }), (error) => error.code === 'INTAKE_HANDOFF_REQUIRED');
});

test('old bypass fails: the real builder refuses a post-activation batch without a hand-off before reading anything', async () => {
  await assert.rejects(
    buildIssue223CorpusBatch({
      batchId: 'issue-223-m9-e-corpus-batch-16-20261004',
      analysisDirectory: 'data/reference/does-not-exist',
      authoredDecisionsPath: 'data/reference/does-not-exist/authored.json',
    }),
    (error) => error.code === 'INTAKE_HANDOFF_REQUIRED',
  );
});
