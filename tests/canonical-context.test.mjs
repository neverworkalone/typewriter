import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';
import {
  contextSummary,
  loadCanonicalContext,
  readCanonicalContext,
  writeCanonicalContext,
} from '../scripts/validate/canonical-context.mjs';

test('builds one shared index for records, senses, and source relations', async () => {
  const context = await loadCanonicalContext({
    directory: path.resolve('tests/fixtures/normalization/one-file.jsonl'),
  });

  assert.equal(context.metrics.canonical_load_count, 1);
  assert.equal(context.metrics.canonical_parse_count, 1);
  assert.equal(context.metrics.canonical_index_build_count, 1);
  assert.equal(context.statistics.recordCount, 2);
  assert.equal(context.statistics.senseCount, 2);
  assert.equal(context.statistics.relationCount, 1);
  assert.equal(context.indexes.recordsById.get('w001').record.id, 'w001');
  assert.equal(context.indexes.sensesById.get('w001-s1').recordInfo.record.id, 'w001');
  const relationIndexes = context.indexes.relationsBySourceSenseId.get('w001-s1');
  assert.deepEqual(relationIndexes, 0);
  assert.equal(context.indexes.relations[relationIndexes].relationIndex, 0);
});

test('serializes and rehydrates the shared context without rebuilding from JSONL', async () => {
  const context = await loadCanonicalContext({
    directory: path.resolve('tests/fixtures/normalization/one-file.jsonl'),
  });
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-context-'));
  const contextPath = path.join(temporaryDirectory, 'canonical-context.json');

  try {
    await writeCanonicalContext(context, contextPath);
    const restored = await readCanonicalContext(contextPath, {
      expectedCanonicalDirectory: context.canonicalDirectory,
    });
    assert.deepEqual(contextSummary(restored), contextSummary(context));
    assert.deepEqual(
      restored.records.map(({ record }) => record.id),
      context.records.map(({ record }) => record.id),
    );
    assert.equal(restored.indexes.recordsById.get('r001').record.id, 'r001');
    assert.equal(restored.indexes.relations.length, 1);
    assert.equal(restored.metrics.canonical_parse_count, 1);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('readCanonicalRecords consumes the CI context for the default corpus', async () => {
  const context = await loadCanonicalContext({ directory: DEFAULT_CANONICAL_DIRECTORY });
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-context-env-'));
  const contextPath = path.join(temporaryDirectory, 'canonical-context.json');
  const previousPath = process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH;
  const previousDirectory = process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY;

  try {
    await writeCanonicalContext(context, contextPath);
    process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH = contextPath;
    process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY = context.canonicalDirectory;
    const shared = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
    assert.equal(shared.fileCount, context.fileCount);
    assert.deepEqual(shared.records, context.records);
  } finally {
    if (previousPath === undefined) delete process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH;
    else process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH = previousPath;
    if (previousDirectory === undefined) delete process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY;
    else process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY = previousDirectory;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
