import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  TargetInventoryError,
  validateTargetInventory,
} from '../scripts/validate/target-inventory.mjs';
import {
  DEFAULT_SEED_PATH,
  buildTargetInventory,
  TargetInventoryGenerationError,
  generateTargetInventory,
} from '../scripts/inventory/generate-target-inventory.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';

async function readInventory() {
  return buildTargetInventory();
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

  assert.equal(summary.inventoryEntryCount, 3335);
  assert.equal(summary.canonicalRecordCount, 3042);
  assert.equal(summary.currentStartCount, 3000);
  assert.equal(summary.currentReferenceOnlyCount, 42);
  assert.equal(summary.candidateStartCount, 19);
  assert.equal(summary.plannedStartCount, 3019);
  assert.equal(summary.heldCount, 78);
  assert.equal(summary.duplicateCount, 2);
  assert.equal(summary.inflectedFormCount, 2);
  const inventory = await readInventory();
  assert.ok(inventory.generated_from.includes('data/inventory/m5-target-promotions.jsonl'));
  assert.equal(
    inventory.entries.find((entry) => entry.inventory_id === 'm5-1085').source,
    'canonical',
  );
  assert.deepEqual(summary.reasonCodeCounts, {
    A: 535,
    C: 449,
    E: 429,
    O: 373,
    Q: 421,
    S: 458,
    X: 354,
  });
  assert.deepEqual(summary.recordTypeCounts, {
    entry: 2729,
    expression: 290,
  });
});

test('regenerates the inventory from canonical plus the non-canonical seed', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-inventory-generate-'));
  const outputPath = path.join(temporaryDirectory, 'inventory.json');

  try {
    const generated = await generateTargetInventory({ outputPath });
    assert.equal(generated.entries.length, 3335);
    assert.equal(generated.canonical_snapshot.record_count, 3042);
    assert.equal(
      generated.entries.find((entry) => entry.inventory_id === 'm5-001').source,
      'canonical',
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
  assert.equal(canonical.records.length, 3042);
  assert.equal(canonical.records.some(({ record }) => record.id === 'm5-001'), false);
  assert.equal(canonical.records.some(({ record }) => record.id === 'w301'), true);
  assert.equal(canonical.records.some(({ record }) => record.lemma === '말문이 막히다'), false);

  const generatedA2Candidate = (await readInventory()).entries.find(
    (entry) => entry.inventory_id === 'm5-244',
  );
  assert.equal(generatedA2Candidate.source, 'editorial');
  assert.equal(generatedA2Candidate.status, 'candidate');
  assert.equal(generatedA2Candidate.canonical_id, undefined);
});

test('rejects promotion ledger digests that do not bind canonical and authored decision authority', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-ledger-binding-'));
  const promotionPath = path.join(temporaryDirectory, 'promotions.jsonl');
  const source = await readFile(path.resolve('data/inventory/m5-target-promotions.jsonl'), 'utf8');
  const entries = source.trim().split('\n').map((line) => JSON.parse(line));

  try {
    for (const mutate of [
      (entry) => { entry.record_sha256 = '0'.repeat(64); },
      (entry) => { entry.decision_source_id = 'unbound-source'; },
      (entry) => { entry.decision_row_sha256 = 'f'.repeat(64); },
    ]) {
      const mutated = structuredClone(entries);
      mutate(mutated[0]);
      await writeFile(promotionPath, `${mutated.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
      await assert.rejects(
        generateTargetInventory({ promotionPath }),
        (error) => error instanceof TargetInventoryGenerationError
          && error.code === 'PROMOTION_LEDGER_BINDING_MISMATCH',
      );
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
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
        (entry) => entry.inventory_id === 'm5-135',
      );
      candidate.status = 'candidate';
      candidate.lemma = '담담하다';
      candidate.search_forms = ['담담하다'];
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
  const unmappedSeedPath = path.join(temporaryDirectory, 'unmapped-seed.json');
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
    for (const entry of seed.targets) {
      if (entry.status === 'promoted') {
        entry.status = 'candidate';
        delete entry.canonical_id;
      }
    }
    await writeFile(
      unmappedSeedPath,
      `${JSON.stringify(seed, null, 2)}\n`,
      'utf8',
    );
    const promotedSeed = seed.targets.find((entry) => entry.inventory_id === 'm5-001');
    promotedSeed.status = 'promoted';
    promotedSeed.canonical_id = 'w301';
    await writeFile(seedPath, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');

    await assert.rejects(
      generateTargetInventory({
        canonicalDirectory,
        seedPath: unmappedSeedPath,
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
    assert.equal(summary.candidateStartCount, 996);
    assert.equal(summary.plannedStartCount, 1297);

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
