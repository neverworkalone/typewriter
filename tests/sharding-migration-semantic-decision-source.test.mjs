import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import { planShardedJsonChanges, readShardedJson, readShardedJsonLogicalBytes } from '../scripts/lib/sharded-json.mjs';
import { SEMANTIC_DECISION_SOURCE_ARRAYS, SEMANTIC_DECISION_SOURCE_PATH } from '../scripts/lib/sharded-json-sources.mjs';

// One-off migration check (Issue #590). It is intentionally not registered in any CI tier: it compares the
// sharded files against the single 65.7MB file as it existed before the split (master 5c2f06ef).
const BEFORE_SPLIT = '5c2f06ef';

test('the sharded canonical semantic decision source restores exactly the pre-split single file', async () => {
  const originalBytes = execFileSync('git', ['show', `${BEFORE_SPLIT}:${SEMANTIC_DECISION_SOURCE_PATH}`], { maxBuffer: 512 * 1024 * 1024 });
  const original = JSON.parse(originalBytes.toString('utf8'));
  const restored = await readShardedJson(SEMANTIC_DECISION_SOURCE_PATH);

  assert.deepEqual(restored, original);
  assert.equal(restored.authored_review.records.length, original.authored_review.records.length);
  assert.equal(restored.factory_admissions.length, original.factory_admissions.length);
  assert.deepEqual(Object.keys(restored.authored_review), Object.keys(original.authored_review), 'key order is preserved for digests');
  assert.ok((await readShardedJsonLogicalBytes(SEMANTIC_DECISION_SOURCE_PATH)).equals(originalBytes), 'byte-identical single-file serialization');
});

test('rewriting an unchanged logical source touches no shard, and appending touches only the last shard and manifest', async () => {
  const logical = await readShardedJson(SEMANTIC_DECISION_SOURCE_PATH);
  const unchanged = await planShardedJsonChanges(logical, SEMANTIC_DECISION_SOURCE_PATH, { arrays: SEMANTIC_DECISION_SOURCE_ARRAYS });
  assert.equal(unchanged.changed.size, 0);

  logical.factory_admissions.push({ batch_id: 'R999999', attempt: 1, entries: [], changes: [] });
  const appended = await planShardedJsonChanges(logical, SEMANTIC_DECISION_SOURCE_PATH, { arrays: SEMANTIC_DECISION_SOURCE_ARRAYS });
  assert.equal(appended.changed.size, 2);
  assert.ok([...appended.changed.keys()].some((file) => /factory-admissions-\d+\.json$/u.test(file)));
  assert.ok(appended.changed.has('canonical-semantic-decision-source.json'));
});
