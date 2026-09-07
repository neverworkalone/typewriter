import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { buildDictionary } from '../scripts/build/dictionary.mjs';
import {
  findRecordsByExactTerm,
  getRecord,
} from '../scripts/build/query.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';
import {
  DEFAULT_INVENTORY_PATH,
  readTargetInventory,
} from '../scripts/validate/target-inventory.mjs';

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const BATCH_DIRECTORY = path.resolve(TEST_DIRECTORY, '../data/batches');

async function readJson(fileName) {
  return JSON.parse(await readFile(path.join(BATCH_DIRECTORY, fileName), 'utf8'));
}

function numberedIds(prefix, first, last) {
  return Array.from(
    { length: last - first + 1 },
    (_, index) => `${prefix}${String(first + index).padStart(3, '0')}`,
  );
}

test('M5-3 calibration manifest, canonical import, and inventory transition stay aligned', async () => {
  const [manifest, metrics, canonical, inventoryResult] = await Promise.all([
    readJson('m5-3-calibration.json'),
    readJson('m5-3-calibration-metrics.json'),
    readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY),
    readTargetInventory(DEFAULT_INVENTORY_PATH),
  ]);
  const { inventory } = inventoryResult;

  const inventoryDecisions = manifest.records.filter(
    (record) => record.source === 'inventory',
  );
  const decisionCounts = Object.fromEntries(
    ['included', 'corrected', 'held', 'rejected'].map((decision) => [
      decision,
      inventoryDecisions.filter((record) => record.decision === decision).length,
    ]),
  );
  const referenceRecords = manifest.records.filter(
    (record) => record.source === 'reference-closure',
  );

  assert.equal(manifest.inventory_revision, 'm5-1');
  assert.equal(inventoryDecisions.length, 60);
  assert.deepEqual(decisionCounts, {
    included: 11,
    corrected: 41,
    held: 4,
    rejected: 4,
  });
  assert.equal(referenceRecords.length, 12);
  assert.deepEqual(
    referenceRecords.map((record) => record.canonical_id),
    numberedIds('r', 36, 47),
  );

  const canonicalById = new Map(
    canonical.records.map(({ record }) => [record.id, record]),
  );
  const importedIds = [
    ...numberedIds('r', 36, 47),
    ...numberedIds('w', 301, 352),
  ];
  assert.equal(importedIds.filter((id) => canonicalById.has(id)).length, 64);
  assert.equal(metrics.canonical_import.imported_record_count, 64);
  assert.equal(metrics.canonical_import.imported_sense_count, 82);
  assert.equal(metrics.canonical_import.imported_relation_count, 88);
  assert.equal(metrics.decisions.correction_rate_of_selected, 41 / 60);
  assert.equal(metrics.decisions.correction_rate_of_importable, 41 / 52);
  assert.equal(metrics.post_review_audit.removed_relation_count, 51);
  assert.equal(metrics.post_review_audit.relation_count_after_audit, 88);
  assert.equal(metrics.post_review_audit.remaining_over_broad_relation_errors, 0);
  assert.equal(metrics.quality_checks.reference_closure_errors, 0);
  assert.equal(metrics.quality_checks.raw_draft_committed, false);

  assert.equal(inventory.revision, 'm5-2');
  assert.equal(inventory.canonical_snapshot.record_count, 390);
  assert.equal(inventory.canonical_snapshot.start_count, 352);
  assert.equal(inventory.canonical_snapshot.reference_only_count, 38);
  assert.equal(
    inventory.entries.filter((entry) => entry.source === 'editorial' && entry.status === 'candidate').length,
    4,
  );
  assert.equal(
    inventory.entries.filter((entry) => entry.source === 'editorial' && entry.status === 'held').length,
    7,
  );
});

test('new calibration lemmas and sense-level relation targets are searchable in SQLite', async () => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-m5-3-search-'));
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
      assert.deepEqual(findRecordsByExactTerm(database, '감격').map(({ id }) => id), ['w301']);
      assert.deepEqual(findRecordsByExactTerm(database, '미지근하다').map(({ id }) => id), ['w321']);
      assert.deepEqual(findRecordsByExactTerm(database, '여명').map(({ id }) => id), ['w328']);
      assert.deepEqual(findRecordsByExactTerm(database, '목이 메다').map(({ id }) => id), ['w350']);

      const polysemousCalibrationRecord = getRecord(database, 'w321');
      assert.equal(polysemousCalibrationRecord.senses.length, 2);
      assert.ok(
        polysemousCalibrationRecord.senses[1].relations.some(
          ({ target, target_sense }) => target === 'r042' && target_sense === 'r042-s1',
        ),
      );

      const boundaryRecord = getRecord(database, 'w310');
      assert.deepEqual(
        boundaryRecord.senses.map(({ pos }) => pos),
        ['adjective', 'verb'],
      );
      assert.equal(boundaryRecord.senses[1].relations[0].target, 'w200');

      const sensoryRecord = getRecord(database, 'w326');
      assert.deepEqual(
        sensoryRecord.senses.map((sense) => sense.relations.map(({ target }) => target)),
        [['w106'], ['w019']],
      );

      const polysemousPlaceRecord = getRecord(database, 'w329');
      assert.deepEqual(polysemousPlaceRecord.senses[1].relations, []);
      assert.deepEqual(getRecord(database, 'w335').senses[0].relations, []);
      assert.deepEqual(getRecord(database, 'w349').senses[0].relations.map(({ target }) => target), ['w071']);

      const expression = getRecord(database, 'w350');
      assert.ok(
        expression.senses[0].relations.some(
          ({ target, target_sense }) => target === 'r046' && target_sense === 'r046-s1',
        ),
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
