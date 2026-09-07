import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_INVENTORY_PATH,
  TargetInventoryError,
  validateTargetInventory,
} from '../scripts/validate/target-inventory.mjs';
import {
  DEFAULT_SEED_PATH,
  TargetInventoryGenerationError,
  generateTargetInventory,
} from '../scripts/inventory/generate-target-inventory.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';

async function readInventory() {
  return JSON.parse(await readFile(DEFAULT_INVENTORY_PATH, 'utf8'));
}

async function validateModifiedInventory(mutator) {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-inventory-'));
  const inventoryPath = path.join(temporaryDirectory, 'inventory.json');

  try {
    const inventory = await readInventory();
    mutator(inventory);
    await writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`, 'utf8');
    return await validateTargetInventory({ inventoryPath });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

test('validates the M5 inventory and keeps independent start counts', async () => {
  const summary = await validateTargetInventory();

  assert.equal(summary.inventoryEntryCount, 393);
  assert.equal(summary.canonicalRecordCount, 326);
  assert.equal(summary.currentStartCount, 300);
  assert.equal(summary.currentReferenceOnlyCount, 26);
  assert.equal(summary.candidateStartCount, 60);
  assert.equal(summary.plannedStartCount, 360);
  assert.equal(summary.heldCount, 3);
  assert.equal(summary.duplicateCount, 2);
  assert.equal(summary.inflectedFormCount, 2);
  assert.deepEqual(summary.reasonCodeCounts, {
    A: 70,
    C: 70,
    E: 40,
    O: 35,
    Q: 40,
    S: 70,
    X: 35,
  });
  assert.deepEqual(summary.recordTypeCounts, {
    entry: 342,
    expression: 18,
  });
});

test('regenerates the inventory from canonical plus the non-canonical seed', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-inventory-generate-'));
  const outputPath = path.join(temporaryDirectory, 'inventory.json');

  try {
    const generated = await generateTargetInventory({ outputPath });
    assert.equal(generated.entries.length, 393);
    assert.equal(generated.canonical_snapshot.record_count, 326);
    assert.equal(
      generated.entries.find((entry) => entry.inventory_id === 'm5-001').source,
      'editorial',
    );
    assert.equal(
      generated.entries.find((entry) => entry.inventory_id === 'canonical-r001').planned_role,
      'reference-only',
    );
    const regeneratedSummary = await validateTargetInventory({ inventoryPath: outputPath });
    const checkedInSummary = await validateTargetInventory();
    assert.deepEqual(
      { ...regeneratedSummary, inventoryPath: undefined },
      { ...checkedInSummary, inventoryPath: undefined },
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('inventory candidates remain outside canonical input and SQLite build scope', async () => {
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  assert.equal(canonical.records.length, 326);
  assert.equal(canonical.records.some(({ record }) => record.id === 'm5-001'), false);
  assert.equal(canonical.records.some(({ record }) => record.lemma === '감격'), false);
});

test('rejects an inventory that omits a canonical record', async () => {
  await assert.rejects(
    validateModifiedInventory((inventory) => {
      inventory.entries = inventory.entries.filter(
        (entry) => entry.inventory_id !== 'canonical-w001',
      );
    }),
    (error) => {
      assert.ok(error instanceof TargetInventoryError);
      assert.equal(error.code, 'MISSING_CANONICAL_ENTRY');
      return true;
    },
  );
});

test('rejects a candidate that collides with an active canonical start', async () => {
  await assert.rejects(
    validateModifiedInventory((inventory) => {
      const candidate = inventory.entries.find(
        (entry) => entry.inventory_id === 'm5-001',
      );
      candidate.lemma = '고요';
      candidate.search_forms = ['고요'];
    }),
    (error) => {
      assert.ok(error instanceof TargetInventoryError);
      assert.equal(error.code, 'DUPLICATE_START_LEMMA');
      return true;
    },
  );
});

test('rejects current inventory drift instead of treating the snapshot as source of truth', async () => {
  await assert.rejects(
    validateModifiedInventory((inventory) => {
      const current = inventory.entries.find(
        (entry) => entry.inventory_id === 'canonical-w001',
      );
      current.lemma = '변경된 표제어';
    }),
    (error) => {
      assert.ok(error instanceof TargetInventoryError);
      assert.equal(error.code, 'CANONICAL_DRIFT');
      return true;
    },
  );
});

test('preserves inventory metadata when a candidate is promoted to a new canonical start', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-inventory-promotion-'));
  const canonicalDirectory = path.join(temporaryDirectory, 'canonical');
  const seedPath = path.join(temporaryDirectory, 'seed.json');
  const inventoryPath = path.join(temporaryDirectory, 'inventory.json');

  try {
    await mkdir(canonicalDirectory, { recursive: true });
    const canonicalText = await readFile(
      path.join(path.dirname(DEFAULT_CANONICAL_DIRECTORY), 'canonical/pilot.jsonl'),
      'utf8',
    );
    const promotedRecord = {
      id: 'w301',
      record_type: 'entry',
      role: 'start',
      candidate_id: 'w301',
      lemma: '감격',
      search_forms: ['감격'],
      senses: [{
        id: 'w301-s1',
        pos: 'noun',
        gloss: '벅찬 기쁨이나 감동이 북받치는 마음.',
      }, {
        id: 'w301-s2',
        pos: 'adjective',
        gloss: '감정이 벅차오르는 상태의.',
      }],
    };
    await writeFile(
      path.join(canonicalDirectory, 'pilot.jsonl'),
      `${canonicalText}${JSON.stringify(promotedRecord)}\n`,
      'utf8',
    );

    const seed = JSON.parse(await readFile(DEFAULT_SEED_PATH, 'utf8'));
    const promotedSeed = seed.targets.find((entry) => entry.inventory_id === 'm5-001');
    promotedSeed.status = 'promoted';
    promotedSeed.canonical_id = 'w301';
    await writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

    await assert.rejects(
      generateTargetInventory({
        canonicalDirectory,
        seedPath: DEFAULT_SEED_PATH,
        outputPath: inventoryPath,
      }),
      (error) => {
        assert.ok(error instanceof TargetInventoryGenerationError);
        assert.equal(error.code, 'UNMAPPED_CANONICAL_START');
        return true;
      },
    );

    const generated = await generateTargetInventory({
      canonicalDirectory,
      seedPath,
      outputPath: inventoryPath,
    });
    const promoted = generated.entries.find((entry) => entry.canonical_id === 'w301');
    assert.ok(promoted);
    assert.equal(promoted.inventory_id, 'm5-001');
    assert.equal(promoted.promoted_from, 'm5-001');
    assert.equal(promoted.source, 'canonical');
    assert.equal(promoted.status, 'current');
    assert.deepEqual(promoted.reason_codes, ['E']);
    assert.deepEqual(promoted.pos, ['noun', 'adjective']);
    assert.equal(promoted.sense_profile, 'boundary');
    assert.deepEqual(promoted.flags, ['polysemy', 'direct-boundary']);
    assert.equal(promoted.decision_note, '기쁨과 벅참의 세기를 비교할 정서 후보.');
    assert.equal(
      generated.entries.some((entry) => entry.source === 'editorial' && entry.inventory_id === 'm5-001'),
      false,
    );

    const summary = await validateTargetInventory({
      inventoryPath,
      canonicalDirectory,
      checkPilotCompleteness: false,
    });
    assert.equal(summary.currentStartCount, 301);
    assert.equal(summary.candidateStartCount, 59);
    assert.equal(summary.plannedStartCount, 360);

    for (const [driftIndex, mutate] of [
      (entry) => {
        entry.pos = ['noun'];
      },
      (entry) => {
        entry.sense_profile = 'single';
      },
      (entry) => {
        entry.flags = ['direct-boundary'];
      },
    ].entries()) {
      const driftedInventory = structuredClone(generated);
      mutate(driftedInventory.entries.find((entry) => entry.inventory_id === 'm5-001'));
      const driftedInventoryPath = path.join(
        temporaryDirectory,
        `inventory-drift-${driftIndex + 1}.json`,
      );
      await writeFile(driftedInventoryPath, `${JSON.stringify(driftedInventory)}\n`, 'utf8');
      await assert.rejects(
        validateTargetInventory({
          inventoryPath: driftedInventoryPath,
          canonicalDirectory,
          checkPilotCompleteness: false,
        }),
        (error) => {
          assert.ok(error instanceof TargetInventoryError);
          assert.equal(error.code, 'CANONICAL_DRIFT');
          return true;
        },
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});
