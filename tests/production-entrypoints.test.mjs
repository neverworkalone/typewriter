import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { assertCanonicalOnlyFromReviewedBatches, makeBaseline } from '../scripts/batch/canonical-batch-baseline.mjs';
import { buildIssue223CorpusBatch } from '../scripts/batch/build-issue-223-corpus-batch.mjs';
import { ACTIVE_PRODUCTION_ENTRYPOINTS, HISTORICAL_ENTRYPOINTS, DERIVED_ARTIFACT_WRITERS, writesCanonical } from '../scripts/batch/production-entrypoints.mjs';
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

test('every script that can write canonical records is a declared production entrypoint', async () => {
  const writers = [];
  for (const file of await scriptFiles('scripts')) {
    const source = await readFile(file, 'utf8');
    if (writesCanonical(source)) writers.push(file.split(path.sep).join('/'));
  }
  const declared = [...Object.keys(ACTIVE_PRODUCTION_ENTRYPOINTS), ...Object.keys(HISTORICAL_ENTRYPOINTS), ...DERIVED_ARTIFACT_WRITERS].sort();
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

test('the writer tripwire sees aliased paths, import-path variables and unregistered writers', () => {
  assert.equal(writesCanonical("const target = path.join(root, 'data/canonical', name);\nawait writeFile(target, bytes);"), true);
  assert.equal(writesCanonical("const dir = CANONICAL_DIR;\nawait copyFile(src, path.join(dir, 'x.jsonl'));"), true);
  assert.equal(writesCanonical("await writeFile(importPath, bytes);"), true);
  assert.equal(writesCanonical("await writeFile(path.join(canonicalDirectory, 'a.jsonl'), bytes);"), true);
  // Not writers: a report written elsewhere, or a temporary verification copy.
  assert.equal(writesCanonical("const records = await readCanonicalRecords(canonicalDirectory);\nawait writeFile(reportPath, JSON.stringify(records));"), false);
  assert.equal(writesCanonical("const temporaryCanonicalDirectory = path.join(tmp, 'canonical');\nawait writeFile(path.join(temporaryCanonicalDirectory, 'x.jsonl'), b);"), false);
});

test('data-level gate: a canonical record outside a validated batch import is refused whatever wrote it', () => {
  const record = (id) => ({ id, record_type: 'entry', lemma: id });
  const historical = [record('w0001'), record('w0002')];
  const batch16 = [record('w9001')];
  const baseline = makeBaseline({ canonicalRecords: [...historical, ...batch16], batchImportRecords: batch16, throughBatch: 15 });
  const ok = (canonicalRecords, batchImportRecords) => assertCanonicalOnlyFromReviewedBatches({ canonicalRecords, batchImportRecords, baseline });
  // Allowed: historical records plus a validated batch import.
  assert.equal(ok([...historical, ...batch16], batch16), true);
  assert.equal(ok(historical, []), true);
  // Old bypass → rejected: a B16-style record inserted under any file name, never reaching a reviewed batch.
  const rejects = (canonicalRecords, batchImportRecords) => assert.throws(() => ok(canonicalRecords, batchImportRecords), (error) => error.code === 'CANONICAL_RECORD_OUTSIDE_REVIEWED_BATCH');
  rejects([...historical, record('w9999')], []);
  rejects([...historical, ...batch16, record('w9002')], batch16);
  // A record dropped from the baseline set is equally visible.
  rejects([historical[0]], []);
  // A changed baseline contract is refused outright.
  assert.throws(() => assertCanonicalOnlyFromReviewedBatches({ canonicalRecords: historical, batchImportRecords: [], baseline: { ...baseline, contract_version: 'x' } }));
});

test('the committed baseline matches current canonical data through the real corpus batch imports', async () => {
  const { readCanonicalRecords } = await import('../scripts/validate/canonical-jsonl.mjs');
  const baseline = JSON.parse(await readFile('data/validation/canonical-non-batch-baseline.json', 'utf8'));
  const current = await readCanonicalRecords('data/canonical');
  const files = (await readdir('data/canonical')).filter((name) => /^issue-223-m9-e-corpus-batch-\d+\.jsonl$/u.test(name));
  const imports = [];
  for (const name of files) imports.push(...(await readFile(path.join('data/canonical', name), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)));
  assert.equal(assertCanonicalOnlyFromReviewedBatches({ canonicalRecords: current.records, batchImportRecords: imports, baseline }), true);
});

test('the canonical non-batch baseline is classified as durable tracked evidence', async () => {
  const policy = JSON.parse(await readFile('config/artifact-policy.json', 'utf8'));
  const listed = JSON.stringify(policy);
  assert.ok(listed.includes('data/validation/canonical-non-batch-baseline.json'), 'the baseline must be listed in config/artifact-policy.json');
  const { validateArtifactPolicy } = await import('../scripts/validate/artifact-policy.mjs');
  assert.equal(typeof validateArtifactPolicy, 'function');
});
