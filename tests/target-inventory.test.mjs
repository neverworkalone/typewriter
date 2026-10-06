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

const authority = JSON.parse(await readFile('data/validation/canonical-semantic-decision-source.json', 'utf8'));
const factoryCreations = (authority.factory_admissions ?? []).flatMap((event) => event.changes).filter((change) => change.operation === 'create').length;

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

test('validates the current target inventory and keeps independent start counts', async () => {
  const summary = await validateTargetInventory();

  assert.equal(summary.inventoryEntryCount, 12750 + factoryCreations);
  assert.equal(summary.canonicalRecordCount, 12204 + factoryCreations);
  assert.equal(summary.currentStartCount, 12162 + factoryCreations);
  assert.equal(summary.currentReferenceOnlyCount, 42);
  assert.equal(summary.candidateStartCount, 6);
  assert.equal(summary.plannedStartCount, 12168 + factoryCreations);
  assert.equal(summary.heldCount, 221);
  assert.equal(summary.rejectedCount, 62);
  assert.equal(summary.deferredCount, 252);
  assert.equal(summary.duplicateCount, 3);
  assert.equal(summary.inflectedFormCount, 2);
  const inventory = await readInventory();
  assert.ok(inventory.generated_from.includes('data/inventory/m5-target-promotions.jsonl'));
  assert.equal(
    inventory.entries.find((entry) => entry.inventory_id === 'm5-1085').source,
    'canonical',
  );
  assert.deepEqual(summary.reasonCodeCounts, {
    A: 3309,
    C: 1805,
    E: 1400,
    O: 1997,
    Q: 937,
    S: 968,
    X: 1752,
  });
  assert.deepEqual(summary.recordTypeCounts, {
    entry: 11009 + factoryCreations,
    expression: 1159,
  });
});

test('regenerates the inventory from canonical plus the non-canonical seed', async () => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'typewriter-inventory-generate-'));
  const outputPath = path.join(temporaryDirectory, 'inventory.json');

  try {
    const generated = await generateTargetInventory({ outputPath });
    assert.equal(generated.entries.length, 12750 + factoryCreations);
    assert.equal(generated.canonical_snapshot.record_count, 12204 + factoryCreations);
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
  assert.equal(canonical.records.length, 12204 + factoryCreations);
  assert.equal(canonical.records.some(({ record }) => record.id === 'm5-001'), false);
  assert.equal(canonical.records.some(({ record }) => record.id === 'w301'), true);
  assert.equal(canonical.records.some(({ record }) => record.lemma === '말을 잃다'), false);

  const generatedA2Candidate = (await readInventory()).entries.find(
    (entry) => entry.inventory_id === 'm5-247',
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
      assert.equal(error.code, 'DUPLICATE_SEARCH_LEMMA');
      return true;
    },
  );
});

test('rejects a candidate that collides with a historical reference-only searchable record', async () => {
  await assert.rejects(
    validateModifiedInventory((inventory) => {
      const candidate = inventory.entries.find((entry) => entry.inventory_id === 'm5-135');
      const historicalReference = inventory.entries.find((entry) => entry.inventory_id === 'canonical-r001');
      candidate.status = 'candidate';
      candidate.lemma = historicalReference.lemma;
      candidate.search_forms = [...historicalReference.search_forms];
    }),
    (error) => {
      assert.ok(error instanceof TargetInventoryError);
      assert.equal(error.code, 'DUPLICATE_SEARCH_LEMMA');
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
    assert.equal(summary.candidateStartCount, 1003);
    assert.equal(summary.plannedStartCount, 1304);

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

// Synthetic records exercise the shared promotion/admission boundary without modifying historical ledgers.
test('factory admission preserves original promotion bindings and fails closed on rewritten history', async () => {
  const { validatePromotionLedgerBindings, factoryInventoryMappings } = await import('../scripts/inventory/generate-target-inventory.mjs');
  const { sha256Json, restorePreFactoryDecisionSource, canonicalRecordsBeforeFactoryAdmissions } = await import('../scripts/validate/semantic-audit.mjs');
  const original = { id: 'w90001', role: 'start', lemma: '합성어', senses: [{ id: 'w90001-s1', pos: 'noun', gloss: '첫째 뜻' }] };
  const current = { ...original, senses: [...original.senses, { id: 'w90001-s2', pos: 'noun', gloss: '둘째 뜻' }] };
  const binding = { source_id: 'original-source', artifact_sha256: 'a'.repeat(64), decision_row_sha256: 'b'.repeat(64), candidate_record_id: original.id, decision: 'included', reviewed_record_sha256: sha256Json(original) };
  const previousReview = { record_id: original.id, record_sha256: sha256Json(original), authored_batch_decision: binding };
  const review = { record_id: current.id, record_sha256: sha256Json(current) };
  const change = { entry_id: current.id, operation: 'append_senses', before_sha256: sha256Json(original), after_sha256: sha256Json(current), previous_semantic_review_sha256: sha256Json(previousReview), semantic_review_sha256: sha256Json(review), previous_semantic_review: previousReview, previous_record: original, source_candidate_ids: ['C900001-0001'] };
  const event = { batch_id: 'C900001', attempt: 1, semantic_decisions_sha256: 'c'.repeat(64), entries: [{ source_candidate_id: 'C900001-0001', record_id: current.id, sense_ids: ['w90001-s2'] }], changes: [change] };
  event.sha256 = sha256Json(event);
  const source = { authored_review: { records: [review] }, factory_admissions: [event] };
  const entry = { canonical_id: current.id, record_sha256: sha256Json(original), decision_source_id: binding.source_id, decision_source_sha256: binding.artifact_sha256, decision_row_sha256: binding.decision_row_sha256, decision: 'included' };
  const check = (authority = source, ledger = entry, record = current) => validatePromotionLedgerBindings({ entries: [ledger], canonicalRecords: [record], decisionSource: authority });
  assert.equal(check(), true);
  assert.deepEqual(canonicalRecordsBeforeFactoryAdmissions([current], source), [original]);
  assert.deepEqual(canonicalRecordsBeforeFactoryAdmissions([{ record: current, filePath: 'synthetic.jsonl' }], source), [{ record: original, filePath: 'synthetic.jsonl' }]);
  const historical = restorePreFactoryDecisionSource(source, [original]);
  assert.deepEqual(historical.authored_review.records, [previousReview]);
  assert.equal(historical.factory_admissions, undefined);
  assert.deepEqual(source.factory_admissions, [event], 'current authority remains intact');
  assert.throws(() => restorePreFactoryDecisionSource(source, [current]), /does not match the retained admission history/);
  assert.equal(factoryInventoryMappings(source, [current]).size, 0, 'an amendment is not a new inventory creation');
  assert.throws(() => check(source, { ...entry, decision_source_id: 'invented-source' }), /not bound/);
  const tampered = structuredClone(source);
  tampered.factory_admissions[0].changes[0].previous_record.senses[0].gloss = 'rewritten';
  const eventWithoutHash = { ...tampered.factory_admissions[0] }; delete eventWithoutHash.sha256;
  tampered.factory_admissions[0].sha256 = sha256Json(eventWithoutHash);
  assert.throws(() => check(tampered), /preserved pre-admission/);
  assert.throws(() => restorePreFactoryDecisionSource(tampered, [original]), /bound pre-admission/);
  const changed = structuredClone(current); changed.senses[0].gloss = 'rewritten old sense';
  const rewritten = structuredClone(source);
  rewritten.authored_review.records[0].record_sha256 = sha256Json(changed);
  rewritten.factory_admissions[0].changes[0].after_sha256 = sha256Json(changed);
  rewritten.factory_admissions[0].changes[0].semantic_review_sha256 = sha256Json(rewritten.authored_review.records[0]);
  const unsigned = { ...rewritten.factory_admissions[0] }; delete unsigned.sha256;
  rewritten.factory_admissions[0].sha256 = sha256Json(unsigned);
  assert.throws(() => check(rewritten, entry, changed), /rewrote the original promoted payload/);
  assert.throws(() => canonicalRecordsBeforeFactoryAdmissions([changed], rewritten), /rewrote an existing canonical payload/);

  // A historical batch import file is compared as it was admitted, but only while the file record is
  // still exactly the live canonical record; a file that diverges from canonical stays divergent.
  const { restoreImportRecordsBeforeFactoryAdmissions } = await import('../scripts/validate/semantic-audit.mjs');
  assert.deepEqual(await restoreImportRecordsBeforeFactoryAdmissions([current], [current], source), [original]);
  assert.deepEqual(await restoreImportRecordsBeforeFactoryAdmissions([original], [current], source), [original], 'an already original file record is unchanged');
  const edited = { ...current, lemma: '다른어' };
  assert.deepEqual(await restoreImportRecordsBeforeFactoryAdmissions([edited], [current], source), [edited], 'a divergent file record is not rewound');
});

test('historical surface-form views drop exception bindings of later factory admissions', async () => {
  const { projectHistoricalSurfaceFormExceptions } = await import('../scripts/batch/historical-canonical.mjs');
  const records = [{ id: 'w1', senses: [{ id: 'w1-s1' }] }, { record: { id: 'w2', senses: [{ id: 'w2-s1' }] } }];
  const manifest = { exceptions: [
    { record_id: 'w1', sense_id: 'w1-s1', class_id: 'a' },
    { record_id: 'w1', sense_id: 'w1-s2', class_id: 'a' },
    { record_id: 'w2', sense_id: 'w2-s1', class_id: 'a' },
    { record_id: 'w3', sense_id: 'w3-s1', class_id: 'a' },
  ] };
  assert.deepEqual(projectHistoricalSurfaceFormExceptions(manifest, records).exceptions.map((entry) => entry.sense_id), ['w1-s1', 'w2-s1']);
  assert.equal(manifest.exceptions.length, 4, 'the live manifest is not mutated');
});

test('every historical batch validator that runs shared admission uses the projected historical context', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const file of ['scripts/batch/validate-issue-221.mjs']) {
    assert.match(await readFile(file, 'utf8'), /canonicalContext: historicalAdmissionContext\(currentCanonical\.records, semanticAudit\)/u, `${file} must not apply live surface-form manifests to historical records`);
  }
  const { applyHistoricalSurfaceFormViews } = await import('../scripts/batch/historical-canonical.mjs');
  const { readCanonicalRecords } = await import('../scripts/validate/canonical-jsonl.mjs');
  const { loadCanonicalBeforeFactoryAdmissions } = await import('../scripts/validate/semantic-audit.mjs');
  const live = (await readCanonicalRecords()).records;
  const historical = await loadCanonicalBeforeFactoryAdmissions(live);
  const ids = new Set(historical.map((info) => (info.record ?? info).id));
  const context = applyHistoricalSurfaceFormViews({ derived: {} }, historical);
  assert.ok(context.derived.surfaceFormReviewManifest.dispositions.every((entry) => ids.has(entry.record_id)));
  assert.ok(context.derived.surfaceFormExceptionManifest.exceptions.every((entry) => ids.has(entry.record_id)));
});

test('factory inventory mappings require digest-bound canonical creations', async () => {
  const { factoryInventoryMappings } = await import('../scripts/inventory/generate-target-inventory.mjs');
  const { sha256Json } = await import('../scripts/validate/semantic-audit.mjs');
  const record = { id: 'w90002', senses: [{ id: 'w90002-s1', pos: 'noun', gloss: '합성 뜻' }] };
  const review = { record_id: record.id, record_sha256: sha256Json(record) };
  const event = { batch_id: 'C900002', attempt: 2, semantic_decisions_sha256: 'c'.repeat(64), entries: [{ source_candidate_id: 'C900002-0001', record_id: record.id, sense_ids: ['w90002-s1'] }], changes: [{ entry_id: record.id, operation: 'create', before_sha256: null, after_sha256: sha256Json(record), previous_semantic_review_sha256: null, semantic_review_sha256: sha256Json(review), source_candidate_ids: ['C900002-0001'] }] };
  event.sha256 = sha256Json(event);
  const source = { authored_review: { records: [review] }, factory_admissions: [event] };
  assert.equal(factoryInventoryMappings(source, [record]).get(record.id), 'C900002-a2');
  assert.throws(() => factoryInventoryMappings(source, [{ ...record, senses: [] }]), /current canonical record/);
});

test('an inventory cannot invent factory admission provenance', async () => {
  await assert.rejects(validateModifiedInventory((inventory) => {
    inventory.entries.find((entry) => entry.canonical_id === 'w001').admitted_from = 'C900001-a1';
  }), (error) => error.code === 'FACTORY_ADMISSION_BINDING');
});
