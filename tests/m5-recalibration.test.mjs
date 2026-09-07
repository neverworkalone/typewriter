import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import {
  assertMetricsMatch,
  createMetricsArtifact,
} from '../scripts/batch/derive-metrics.mjs';
import { validateBatchManifest } from '../scripts/batch/validate-batch.mjs';
import {
  validateRelationDiff,
  summarizeRelationDiff,
} from '../scripts/batch/relation-diff.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';
import {
  DEFAULT_INVENTORY_PATH,
  readTargetInventory,
} from '../scripts/validate/target-inventory.mjs';
import {
  findRecordsByExactTerm,
  getRecord,
} from '../scripts/build/query.mjs';

const BATCH_DIRECTORY = path.resolve('data/batches');

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(BATCH_DIRECTORY, fileName), 'utf8'));
}

test('M5-5 recalibration artifacts record the fixed gate result', async () => {
  const [manifest, relationDiff, metrics, canonicalResult, inventoryResult] = await Promise.all([
    readJson('m5-5-recalibration.json'),
    readJson('m5-5-recalibration-relation-diff.json'),
    readJson('m5-5-recalibration-metrics.json'),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
    readTargetInventory(DEFAULT_INVENTORY_PATH),
  ]);

  validateBatchManifest(manifest);
  validateRelationDiff(relationDiff);
  const derived = createMetricsArtifact({
    manifest,
    relationDiff,
    canonicalRecords: canonicalResult.records,
    source: metrics.source,
  });
  assertMetricsMatch(metrics, derived);

  assert.equal(manifest.inventory_revision, 'm5-2');
  assert.equal(metrics.derived.selection.selected_start_count, 40);
  assert.deepEqual(
    Object.fromEntries(
      ['included', 'corrected', 'held', 'rejected'].map((decision) => [
        decision,
        manifest.records.filter(
          (record) => record.source === 'inventory' && record.decision === decision,
        ).length,
      ]),
    ),
    { included: 27, corrected: 11, held: 1, rejected: 1 },
  );
  assert.equal(metrics.derived.canonical_import.imported_start_count, 38);
  assert.equal(metrics.derived.canonical_import.imported_reference_only_count, 4);
  assert.equal(metrics.derived.canonical_import.imported_sense_count, 46);
  assert.equal(metrics.derived.canonical_import.imported_relation_count, 14);
  assert.equal(metrics.derived.canonical_import.imported_expression_count, 3);

  const relationSummary = summarizeRelationDiff(relationDiff);
  assert.deepEqual(
    {
      before: relationSummary.before_count,
      after: relationSummary.after_count,
      removed: relationSummary.removed_count,
      retyped: relationSummary.retyped_count,
      retargeted: relationSummary.retargeted_count,
      noise: relationSummary.noise_event_count,
    },
    { before: 20, after: 14, removed: 7, retyped: 0, retargeted: 1, noise: 7 },
  );

  const gate = metrics.derived;
  assert.ok(gate.relation_diff.noise_rate_of_before > 0.25);
  assert.ok(gate.relation_diff.noise_rate_of_before < 51 / 139);
  assert.ok(gate.decisions.correction_rate_of_selected <= 0.5);
  assert.equal(gate.timing.status, 'complete');
  assert.equal(gate.timing.unmeasured_passes.length, 0);
  assert.equal(gate.timing.passes['post-review-audit'].status, 'complete');
  assert.ok(gate.timing.passes['post-review-audit'].editor_seconds > 0);
  assert.ok(gate.timing.total_editor_seconds > 455);
  assert.ok(gate.timing.total_editor_seconds / gate.selection.selected_start_count > 12);
  assert.equal(gate.audit.independent, true);
  assert.equal(gate.audit.open_blocker_count, 0);

  const { inventory } = inventoryResult;
  assert.equal(inventory.revision, 'm5-3');
  assert.deepEqual(inventory.canonical_snapshot, {
    record_count: 432,
    start_count: 390,
    reference_only_count: 42,
  });
  assert.deepEqual(
    inventory.entries
      .filter((entry) => {
        if (!entry.inventory_id.startsWith('m5-')) return false;
        const number = Number(entry.inventory_id.slice(3));
        return number >= 61 && number <= 100;
      })
      .sort((left, right) => Number(left.inventory_id.slice(3)) - Number(right.inventory_id.slice(3)))
      .map((entry) => entry.status),
    [...Array(38).fill('current'), 'held', 'held'],
  );
});

test('M5-5 recalibration records and reference closure are searchable', async () => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-5-search-'));
  const outputPath = path.join(outputDirectory, 'dictionary.sqlite');

  try {
    await buildDictionary({
      inputDirectory: DEFAULT_CANONICAL_DIRECTORY,
      outputPath,
      checkPilotCompleteness: true,
      allowDirty: true,
    });
    const database = new DatabaseSync(outputPath, { readOnly: true });
    try {
      assert.deepEqual(findRecordsByExactTerm(database, '민망함').map(({ id }) => id), ['w353']);
      assert.deepEqual(findRecordsByExactTerm(database, '눈을 피하다').map(({ id }) => id), ['w388']);
      assert.equal(getRecord(database, 'w361').senses.length, 2);
      assert.deepEqual(getRecord(database, 'w361').senses[0].relations, []);
      assert.equal(getRecord(database, 'w361').senses[1].relations[0].target, 'w026');
      assert.equal(getRecord(database, 'w364').senses.length, 2);
      assert.deepEqual(getRecord(database, 'w359').senses[0].relations, []);
      assert.deepEqual(getRecord(database, 'w360').senses[0].relations, []);
      assert.equal(getRecord(database, 'w373').senses.length, 2);
      assert.equal(getRecord(database, 'w362').senses[0].relations[0].target, 'r043');
      assert.equal(getRecord(database, 'w371').senses[0].relations[0].target, 'r048');
      assert.equal(getRecord(database, 'r051').role, 'reference-only');
      assert.equal(getRecord(database, 'r051').senses[0].relations.length, 0);
    } finally {
      database.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
