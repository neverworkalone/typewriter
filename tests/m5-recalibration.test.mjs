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
  assert.equal(gate.timing.status, 'incomplete');
  assert.deepEqual(gate.timing.unmeasured_passes, ['post-review-fixes']);
  assert.equal(gate.timing.passes['post-review-audit'].status, 'complete');
  assert.ok(gate.timing.passes['post-review-audit'].editor_seconds > 0);
  assert.equal(gate.timing.passes['post-review-fixes'].status, 'unmeasured');
  assert.equal(gate.timing.total_editor_seconds, null);
  assert.equal(gate.timing.measured_editor_seconds, 643);
  assert.ok(gate.timing.measured_editor_seconds > 455);
  assert.ok(gate.timing.measured_editor_seconds / gate.selection.selected_start_count > 12);
  assert.equal(gate.audit.independent, true);
  assert.equal(gate.audit.open_blocker_count, 0);

  const { inventory } = inventoryResult;
  assert.equal(inventory.revision, 'm5-5');
  assert.deepEqual(inventory.canonical_snapshot, {
    record_count: 470,
    start_count: 428,
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

test('M5-7 new 40-start batch reproduces the updated expansion gate result', async () => {
  const [manifest, relationDiff, metrics, canonicalResult, inventoryResult, preImportInventory] = await Promise.all([
    readJson('m5-7-recalibration.json'),
    readJson('m5-7-recalibration-relation-diff.json'),
    readJson('m5-7-recalibration-metrics.json'),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
    readTargetInventory(DEFAULT_INVENTORY_PATH),
    readFile(path.join(BATCH_DIRECTORY, 'm5-7-preimport-inventory.json'), 'utf8').then(JSON.parse),
  ]);

  validateBatchManifest(manifest);
  validateRelationDiff(relationDiff);
  const derivedArtifact = createMetricsArtifact({
    manifest,
    relationDiff,
    canonicalRecords: canonicalResult.records,
    source: metrics.source,
  });
  assertMetricsMatch(metrics, derivedArtifact);

  assert.equal(manifest.inventory_revision, 'm5-4');
  assert.deepEqual(
    Object.fromEntries(
      ['included', 'corrected', 'held', 'rejected'].map((decision) => [
        decision,
        manifest.records.filter(
          (record) => record.source === 'inventory' && record.decision === decision,
        ).length,
      ]),
    ),
    { included: 23, corrected: 15, held: 1, rejected: 1 },
  );
  assert.equal(metrics.derived.selection.selected_start_count, 40);
  assert.equal(metrics.derived.canonical_import.imported_start_count, 38);
  assert.equal(metrics.derived.canonical_import.imported_reference_only_count, 0);
  assert.equal(metrics.derived.canonical_import.imported_sense_count, 43);
  assert.equal(metrics.derived.canonical_import.imported_relation_count, 7);
  assert.equal(metrics.derived.canonical_import.imported_expression_count, 3);

  assert.deepEqual(
    {
      before: metrics.derived.relation_diff.before_count,
      after: metrics.derived.relation_diff.after_count,
      removed: metrics.derived.relation_diff.removed_count,
      noise: metrics.derived.relation_diff.noise_event_count,
      noise_rate: metrics.derived.relation_diff.noise_rate_of_before,
    },
    { before: 10, after: 7, removed: 3, noise: 3, noise_rate: 0.3 },
  );
  assert.deepEqual(metrics.derived.relation_diff.classification_counts, {
    'broad-common-category': 2,
    'incidental-co-occurrence': 1,
  });
  assert.deepEqual(metrics.derived.canonical_import.relation_type_counts, {
    mood: 4,
    near: 2,
    scene: 1,
  });

  assert.equal(metrics.derived.timing.status, 'complete');
  assert.equal(metrics.derived.timing.total_wall_clock_seconds, 957);
  assert.equal(metrics.derived.timing.total_editor_seconds, 782);
  assert.deepEqual(metrics.derived.timing.unmeasured_passes, []);
  assert.deepEqual(
    Object.keys(metrics.derived.timing.passes).sort(),
    [
      'feedback-fixes',
      'final-audit',
      'held-rejected',
      'initial-review',
      'post-review-audit',
      'post-review-fixes',
      'target-preparation',
    ],
  );
  assert.ok(metrics.derived.timing.total_editor_seconds / 40 > 12);
  assert.equal(metrics.derived.decisions.correction_rate_of_selected, 0.375);
  assert.ok(metrics.derived.relation_diff.noise_rate_of_before > 0.25);
  assert.equal(metrics.derived.audit.independent, true);
  assert.equal(metrics.derived.audit.open_blocker_count, 0);

  assert.equal(preImportInventory.revision, 'm5-4');
  assert.deepEqual(preImportInventory.canonical_snapshot, {
    record_count: 432,
    start_count: 390,
    reference_only_count: 42,
  });
  assert.equal(
    preImportInventory.entries.filter(
      (entry) => entry.source === 'editorial' && entry.status === 'candidate',
    ).length,
    40,
  );

  const { inventory } = inventoryResult;
  assert.equal(inventory.revision, 'm5-5');
  assert.deepEqual(inventory.canonical_snapshot, {
    record_count: 470,
    start_count: 428,
    reference_only_count: 42,
  });
  assert.deepEqual(
    inventory.entries
      .filter((entry) => /^m5-(?:019|034|053|060|10[1-9]|11[0-9]|12[0-9]|13[0-6])$/u.test(entry.inventory_id))
      .sort((left, right) => left.inventory_id.localeCompare(right.inventory_id, 'en', { numeric: true }))
      .map((entry) => entry.status),
    [...Array(38).fill('current'), 'held', 'held'],
  );

  assert.equal(canonicalResult.records.length, 470);
});

test('M5-7 imported starts and expressions are searchable while held rows stay out', async () => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-7-search-'));
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
      assert.deepEqual(findRecordsByExactTerm(database, '서투르다').map(({ id }) => id), ['w391']);
      assert.deepEqual(findRecordsByExactTerm(database, '마음을 열다').map(({ id }) => id), ['w394']);
      assert.deepEqual(findRecordsByExactTerm(database, '귀에 익다').map(({ id }) => id), ['w427']);
      assert.deepEqual(findRecordsByExactTerm(database, '눈에 밟히다').map(({ id }) => id), ['w428']);
      assert.deepEqual(findRecordsByExactTerm(database, '말문이 막히다'), []);
      assert.deepEqual(findRecordsByExactTerm(database, '손을 놓다'), []);
      assert.equal(getRecord(database, 'w405').senses.length, 2);
      assert.deepEqual(getRecord(database, 'w406').senses.map(({ pos }) => pos), ['verb']);
      assert.equal(getRecord(database, 'w410').senses.length, 3);
      assert.equal(getRecord(database, 'w420').senses.length, 2);
      assert.equal(getRecord(database, 'w421').senses.length, 2);
      assert.equal(getRecord(database, 'w394').record_type, 'expression');
      assert.equal(getRecord(database, 'w395').senses[0].relations[0].target, 'w018');
      assert.deepEqual(getRecord(database, 'w400').senses[0].relations, []);
    } finally {
      database.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
