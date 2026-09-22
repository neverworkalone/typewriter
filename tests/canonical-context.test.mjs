import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  markSQLiteBuild,
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
    const { metrics: restoredMetrics, ...restoredSummary } = contextSummary(restored);
    const { metrics: originalMetrics, ...originalSummary } = contextSummary(context);
    assert.deepEqual(restoredSummary, originalSummary);
    assert.equal(originalMetrics.canonical_context_serialize_count, 1);
    assert.equal(restoredMetrics.canonical_context_deserialize_count, 1);
    assert.equal(restoredMetrics.canonical_context_rehydrate_count, 1);
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
  const previousRevision = process.env.TYPEWRITER_CANONICAL_REVISION;

  try {
    await writeCanonicalContext(context, contextPath);
    process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH = contextPath;
    process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY = context.canonicalDirectory;
    process.env.TYPEWRITER_CANONICAL_REVISION = context.canonicalRevision;
    const shared = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
    assert.equal(shared.fileCount, context.fileCount);
    assert.deepEqual(shared.records, context.records);
  } finally {
    if (previousPath === undefined) delete process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH;
    else process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH = previousPath;
    if (previousDirectory === undefined) delete process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY;
    else process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY = previousDirectory;
    if (previousRevision === undefined) delete process.env.TYPEWRITER_CANONICAL_REVISION;
    else process.env.TYPEWRITER_CANONICAL_REVISION = previousRevision;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('rejects a shared context bound to a stale canonical revision', async () => {
  const context = await loadCanonicalContext({
    directory: path.resolve('tests/fixtures/normalization/one-file.jsonl'),
  });
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-context-stale-'));
  const contextPath = path.join(temporaryDirectory, 'canonical-context.json');
  const previousRevision = process.env.TYPEWRITER_CANONICAL_REVISION;

  try {
    await writeCanonicalContext(context, contextPath);
    const stale = JSON.parse(await readFile(contextPath, 'utf8'));
    stale.canonical_revision = 'stale-revision';
    await writeFile(contextPath, `${JSON.stringify(stale)}\n`, 'utf8');
    process.env.TYPEWRITER_CANONICAL_REVISION = context.canonicalRevision;

    await assert.rejects(
      readCanonicalContext(contextPath, {
        expectedCanonicalDirectory: context.canonicalDirectory,
      }),
      (error) => error.code === 'CONTEXT_REVISION_MISMATCH',
    );
  } finally {
    if (previousRevision === undefined) delete process.env.TYPEWRITER_CANONICAL_REVISION;
    else process.env.TYPEWRITER_CANONICAL_REVISION = previousRevision;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('fresh canonical loads bypass an inherited shared context', async () => {
  const directory = path.resolve('tests/fixtures/normalization/one-file.jsonl');
  const fresh = await loadCanonicalContext({ directory, contextPath: null });
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-context-fresh-'));
  const contextPath = path.join(temporaryDirectory, 'canonical-context.json');
  const previousPath = process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH;
  const previousDirectory = process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY;

  try {
    await writeCanonicalContext(fresh, contextPath);
    const stale = JSON.parse(await readFile(contextPath, 'utf8'));
    stale.records = stale.records.slice(0, 1);
    stale.file_count = 1;
    await writeFile(contextPath, `${JSON.stringify(stale)}\n`, 'utf8');
    process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH = contextPath;
    process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY = directory;

    const loaded = await loadCanonicalContext({ directory, contextPath: null });
    assert.equal(loaded.records.length, fresh.records.length);
    assert.equal(loaded.canonicalRevision, fresh.canonicalRevision);
  } finally {
    if (previousPath === undefined) delete process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH;
    else process.env.TYPEWRITER_CANONICAL_CONTEXT_PATH = previousPath;
    if (previousDirectory === undefined) delete process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY;
    else process.env.TYPEWRITER_CANONICAL_CONTEXT_DIRECTORY = previousDirectory;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('records SQLite build events for parent evidence to aggregate', async () => {
  const context = await loadCanonicalContext({
    directory: path.resolve('tests/fixtures/normalization/one-file.jsonl'),
  });
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-process-metrics-'));
  const metricsPath = path.join(temporaryDirectory, 'metrics.jsonl');
  const previousMetricsPath = process.env.TYPEWRITER_PROCESS_METRICS_PATH;

  try {
    process.env.TYPEWRITER_PROCESS_METRICS_PATH = metricsPath;
    markSQLiteBuild(context, 2);
    const events = (await readFile(metricsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(events, [{
      type: 'sqlite-build',
      pid: process.pid,
      count: 2,
      canonical_directory: context.canonicalDirectory,
      canonical_revision: context.canonicalRevision,
    }]);
    assert.equal(context.metrics.sqlite_build_count, 2);
  } finally {
    if (previousMetricsPath === undefined) delete process.env.TYPEWRITER_PROCESS_METRICS_PATH;
    else process.env.TYPEWRITER_PROCESS_METRICS_PATH = previousMetricsPath;
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
