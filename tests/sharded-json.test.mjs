import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { planShardedJsonChanges, readShardedJson, writeShardedJson } from '../scripts/lib/sharded-json.mjs';

const arrays = [{ path: ['rows'], key: (row) => row.id }];
const row = (id, extra = {}) => ({ id, ...extra });
const initial = [['w0001', 'w0003', 'w0005'], ['w0007', 'w0009', 'w0011'], ['w0013', 'w0015', 'w0017']].map((ids) => ids.map((id) => row(id)));

// A stored layout with three small shards, as an earlier writer would have left it.
async function storedLayout() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sharded-json-'));
  const manifestPath = path.join(directory, 'source.json');
  await mkdir(path.join(directory, 'source.shards'));
  const files = initial.map((_, index) => `source.shards/rows-${String(index + 1).padStart(3, '0')}.json`);
  for (const [index, part] of initial.entries()) await writeFile(path.join(directory, files[index]), `${JSON.stringify(part, null, 2)}\n`);
  const manifest = { name: 'fixture', rows: { $shards: files.map((file, index) => ({ file, count: initial[index].length })) } };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { directory, manifestPath, files };
}

const changedShards = (plan) => [...plan.changed.keys()].filter((file) => file.includes('.shards/')).sort();

test('writer keeps row-to-shard membership and rewrites only the shard a change belongs to', async () => {
  const { directory, manifestPath, files } = await storedLayout();
  try {
    const base = await readShardedJson(manifestPath);

    const unchanged = await planShardedJsonChanges(base, manifestPath, { arrays });
    assert.equal(unchanged.changed.size, 0);

    // Sorted insertion in the middle of the first shard: only that shard changes (and the manifest count).
    const inserted = { ...base, rows: [...base.rows, row('w0004')].sort((a, b) => a.id.localeCompare(b.id)) };
    assert.deepEqual(changedShards(await planShardedJsonChanges(inserted, manifestPath, { arrays })), [files[0]]);

    // Modification of an existing row.
    const modified = structuredClone(base);
    modified.rows.find((item) => item.id === 'w0009').note = 'edited';
    assert.deepEqual(changedShards(await planShardedJsonChanges(modified, manifestPath, { arrays })), [files[1]]);

    // Deletion.
    const deleted = { ...base, rows: base.rows.filter((item) => item.id !== 'w0015') };
    assert.deepEqual(changedShards(await planShardedJsonChanges(deleted, manifestPath, { arrays })), [files[2]]);

    // Tail append.
    const appended = { ...base, rows: [...base.rows, row('w0019')] };
    assert.deepEqual(changedShards(await planShardedJsonChanges(appended, manifestPath, { arrays })), [files[2]]);

    // Writing back restores the logical object in order.
    await writeShardedJson(inserted, manifestPath, { arrays });
    assert.deepEqual((await readShardedJson(manifestPath)).rows.map((item) => item.id), inserted.rows.map((item) => item.id));
    assert.equal(JSON.parse(await readFile(path.join(directory, files[1]), 'utf8')).length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('decision-source promotion files cover only the changed manifest and shards, and a plain target stays a single file', async () => {
  const { planDecisionSourceFiles, SEMANTIC_DECISION_SOURCE_ARRAYS } = await import('../scripts/lib/sharded-json-sources.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sharded-json-promotion-'));
  try {
    const manifestPath = path.join(directory, 'source.json');
    const logical = { authored_review: { records: [{ record_id: 'w1' }, { record_id: 'w2' }] }, factory_admissions: [{ batch_id: 'C1', attempt: 1 }] };
    const plain = Buffer.from(JSON.stringify(logical));
    assert.deepEqual(await planDecisionSourceFiles(plain, manifestPath), [{ path: manifestPath, bytes: plain }]);

    await writeShardedJson(logical, manifestPath, { arrays: SEMANTIC_DECISION_SOURCE_ARRAYS });
    assert.equal((await planDecisionSourceFiles(Buffer.from(JSON.stringify(logical)), manifestPath)).length, 0);
    const next = structuredClone(logical);
    next.factory_admissions.push({ batch_id: 'C2', attempt: 1 });
    const files = await planDecisionSourceFiles(Buffer.from(JSON.stringify(next)), manifestPath);
    assert.deepEqual(files.map((file) => path.basename(file.path)).sort(), ['factory-admissions-001.json', 'source.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a first split rolls over by size and restores the logical order', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sharded-json-first-'));
  try {
    const manifestPath = path.join(directory, 'source.json');
    const payload = 'x'.repeat(3 * 1024 * 1024);
    const logical = { rows: ['a', 'b', 'c', 'd'].map((id) => row(id, { payload })) };
    await writeShardedJson(logical, manifestPath, { arrays });
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.ok(manifest.rows.$shards.length >= 2, 'more than one shard');
    assert.ok(manifest.rows.$shards.every(({ count }) => count < 4));
    assert.deepEqual(await readShardedJson(manifestPath), logical);

    // The same holds when no stored row shares a key with the new rows.
    const replaced = { rows: ['e', 'f', 'g', 'h'].map((id) => row(id, { payload })) };
    await writeShardedJson(replaced, manifestPath, { arrays });
    assert.ok(JSON.parse(await readFile(manifestPath, 'utf8')).rows.$shards.length >= 2);
    assert.deepEqual(await readShardedJson(manifestPath), replaced);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('removing the last row of a shard plans its deletion with the other promotion files', async () => {
  const { planDecisionSourceFiles, SEMANTIC_DECISION_SOURCE_ARRAYS } = await import('../scripts/lib/sharded-json-sources.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sharded-json-delete-'));
  try {
    const manifestPath = path.join(directory, 'source.json');
    const payload = 'x'.repeat(6 * 1024 * 1024);
    const admission = (n) => ({ batch_id: `R${n}`, attempt: 1, payload });
    const logical = { authored_review: { records: [] }, factory_admissions: [admission(1), admission(2)] };
    await writeShardedJson(logical, manifestPath, { arrays: SEMANTIC_DECISION_SOURCE_ARRAYS });
    assert.equal(JSON.parse(await readFile(manifestPath, 'utf8')).factory_admissions.$shards.length, 2);

    const next = { ...logical, factory_admissions: [admission(1)] };
    const files = await planDecisionSourceFiles(Buffer.from(JSON.stringify(next)), manifestPath);
    assert.deepEqual(files.filter((file) => file.bytes === null).map((file) => path.basename(file.path)), ['factory-admissions-002.json']);
    assert.ok(files.some((file) => file.path === manifestPath && file.bytes));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
