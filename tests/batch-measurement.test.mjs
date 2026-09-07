import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  assertMetricsMatch,
  createMetricsArtifact,
  deriveBatchMetrics,
  main as deriveMetricsMain,
  BatchMetricsError,
} from '../scripts/batch/derive-metrics.mjs';
import {
  compareRelationSnapshots,
  RelationDiffError,
  summarizeRelationDiff,
  validateRelationDiff,
} from '../scripts/batch/relation-diff.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';

const BATCH_DIRECTORY = path.resolve('data/batches');

async function readBatchJson(fileName) {
  return JSON.parse(await readFile(path.join(BATCH_DIRECTORY, fileName), 'utf8'));
}

function relation(id, source_sense, target, type, target_sense = `${target}-s1`) {
  return { id, source_sense, target, target_sense, type };
}

test('relation diff emits one deterministic event for add/remove/retype/retarget', () => {
  const before = [
    relation('rel-keep', 'w001-s1', 'w002', 'near'),
    relation('rel-retype', 'w001-s1', 'w003', 'mood'),
    relation('rel-retarget', 'w001-s1', 'w004', 'scene'),
    relation('rel-remove', 'w001-s1', 'w005', 'sensory'),
  ];
  const after = [
    relation('rel-keep', 'w001-s1', 'w002', 'near'),
    relation('rel-retype', 'w001-s1', 'w003', 'association'),
    relation('rel-retarget', 'w001-s1', 'w006', 'scene'),
    relation('rel-add', 'w001-s1', 'w007', 'action'),
  ];

  const diff = compareRelationSnapshots({
    batchId: 'm5-4-fixture',
    before,
    after,
  });
  const summary = summarizeRelationDiff(diff);

  assert.deepEqual(summary, {
    before_count: 4,
    after_count: 4,
    added_count: 1,
    removed_count: 1,
    retyped_count: 1,
    retargeted_count: 1,
    changed_count: 2,
    net_removed_count: 0,
    noise_event_count: 0,
    noise_rate_of_before: 0,
    classification_counts: {},
  });
  assert.deepEqual(
    diff.events.map(({ operation }) => operation),
    ['add', 'remove', 'retarget', 'retype'],
  );

  const classified = structuredClone(diff);
  classified.events.find(({ operation }) => operation === 'remove').error_category = 'broad-common-category';
  assert.equal(summarizeRelationDiff(classified).noise_event_count, 1);

  const invalid = structuredClone(diff);
  invalid.after_count += 1;
  assert.throws(
    () => validateRelationDiff(invalid),
    (error) => error instanceof RelationDiffError && error.code === 'COUNT_MISMATCH',
  );
});

test('source-sense changes cannot hide inside a retarget event', () => {
  assert.throws(
    () => compareRelationSnapshots({
      batchId: 'm5-4-source-sense-fixture',
      before: [relation('rel-1', 'w001-s1', 'w002', 'near')],
      after: [relation('rel-1', 'w001-s2', 'w002', 'near')],
    }),
    (error) => error instanceof RelationDiffError && error.code === 'SOURCE_SENSE_CHANGED',
  );
});

test('M5-3 metrics reproduce from manifest, relation diff, and canonical records', async () => {
  const [manifest, relationDiff, checkedInMetrics, canonicalResult] = await Promise.all([
    readBatchJson('m5-3-calibration.json'),
    readBatchJson('m5-3-relation-diff.json'),
    readBatchJson('m5-3-calibration-metrics.json'),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
  ]);
  const derivedArtifact = createMetricsArtifact({
    manifest,
    relationDiff,
    canonicalRecords: canonicalResult.records,
    source: checkedInMetrics.source,
  });

  assert.deepEqual(derivedArtifact.derived, checkedInMetrics.derived);
  assert.doesNotThrow(() => assertMetricsMatch(derivedArtifact, checkedInMetrics));

  const tampered = structuredClone(checkedInMetrics);
  tampered.derived.relation_diff.removed_count = 0;
  assert.throws(
    () => assertMetricsMatch(derivedArtifact, tampered),
    (error) => error instanceof BatchMetricsError && error.code === 'METRICS_DRIFT',
  );

  const sourceTampered = structuredClone(checkedInMetrics);
  sourceTampered.source.relation_diff = 'data/batches/other-relation-diff.json';
  assert.throws(
    () => assertMetricsMatch(derivedArtifact, sourceTampered),
    (error) => error instanceof BatchMetricsError && error.code === 'METRICS_DRIFT',
  );
});

test('completed metrics reject incomplete timing and cannot hide audit findings', async () => {
  const [manifest, relationDiff, canonicalResult] = await Promise.all([
    readBatchJson('m5-3-calibration.json'),
    readBatchJson('m5-3-relation-diff.json'),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
  ]);

  const missingDigest = structuredClone(manifest);
  delete missingDigest.measurement.relation_diff.sha256;
  assert.throws(
    () => deriveBatchMetrics({
      manifest: missingDigest,
      relationDiff,
      canonicalRecords: canonicalResult.records,
    }),
    (error) => error.code === 'MISSING_FIELD',
  );

  await assert.rejects(
    deriveMetricsMain([
      '--manifest=data/batches/m5-3-calibration.json',
      '--relation-diff=/tmp/typewriter-other-relation-diff.json',
      '--output=/tmp/typewriter-other-metrics.json',
    ]),
    (error) => error instanceof BatchMetricsError && error.code === 'RELATION_DIFF_PATH_MISMATCH',
  );

  const incompleteTiming = structuredClone(manifest);
  incompleteTiming.measurement.timing.status = 'complete';
  assert.throws(
    () => deriveBatchMetrics({
      manifest: incompleteTiming,
      relationDiff,
      canonicalRecords: canonicalResult.records,
    }),
    (error) => error.code === 'INCOMPLETE_TIMING',
  );

  const auditFinding = structuredClone(manifest);
  auditFinding.measurement.audit.independent = true;
  auditFinding.measurement.audit.findings = [{
    id: 'fixture-open-relation-noise',
    category: 'relation-noise',
    severity: 'warning',
    status: 'open',
    note: 'fixture retains one unresolved noisy relation.',
  }];
  const sourceArtifact = createMetricsArtifact({
    manifest: auditFinding,
    relationDiff,
    canonicalRecords: canonicalResult.records,
    source: {
      manifest: 'fixture/manifest.json',
      relation_diff: 'fixture/relation-diff.json',
      canonical_directory: 'fixture/canonical',
    },
  });
  const claimedZero = structuredClone(sourceArtifact);
  claimedZero.derived.audit.open_finding_count = 0;
  assert.throws(
    () => assertMetricsMatch(sourceArtifact, claimedZero),
    (error) => error instanceof BatchMetricsError && error.code === 'METRICS_DRIFT',
  );
});

test('relation diff events must match approved canonical tuples', async () => {
  const [manifest, relationDiff, canonicalResult] = await Promise.all([
    readBatchJson('m5-3-calibration.json'),
    readBatchJson('m5-3-relation-diff.json'),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
  ]);

  const afterTampered = structuredClone(relationDiff);
  const changedEvent = afterTampered.events.find(
    ({ operation }) => operation === 'retarget' || operation === 'retype' || operation === 'add',
  );
  changedEvent.after.target = 'w999';
  changedEvent.after.target_sense = 'w999-s1';
  assert.throws(
    () => deriveBatchMetrics({
      manifest,
      relationDiff: afterTampered,
      canonicalRecords: canonicalResult.records,
    }),
    (error) => error instanceof BatchMetricsError && error.code === 'RELATION_AFTER_NOT_CANONICAL',
  );

  const beforeTampered = structuredClone(relationDiff);
  const removedEvent = beforeTampered.events.find(({ operation }) => operation === 'remove');
  removedEvent.before = {
    target: 'w227',
    target_sense: 'w227-s1',
    type: 'action',
  };
  assert.throws(
    () => deriveBatchMetrics({
      manifest,
      relationDiff: beforeTampered,
      canonicalRecords: canonicalResult.records,
    }),
    (error) => error instanceof BatchMetricsError && error.code === 'RELATION_BEFORE_REMAINS',
  );
});
