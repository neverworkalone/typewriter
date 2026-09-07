import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BatchValidationError,
  REPOSITORY_DIRECTORY,
  validateBatch,
  validateBatchManifest,
} from '../scripts/batch/validate-batch.mjs';
import {
  compareCanonicalIds,
  writeReviewedBatchImport,
} from '../scripts/batch/import-reviewed-batch.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';
import {
  DEFAULT_INVENTORY_PATH,
  readTargetInventory,
} from '../scripts/validate/target-inventory.mjs';

function createManifest() {
  return {
    schema_version: '1',
    batch_id: 'm5-2-fixture',
    inventory_id: 'm5-core-5k',
    inventory_revision: 'm5-5',
    generator: {
      model_id: 'fixture-model',
      tool_version: 'fixture-tool-1',
      prompt_version: 'fixture-prompt-1',
      draft_sha256: '0'.repeat(64),
    },
    generated_at: '2026-09-07T00:00:00Z',
    review: {
      status: 'complete',
      reviewer: 'fixture-editor',
      completed_at: '2026-09-07T01:00:00Z',
    },
    records: [
      {
        source: 'inventory',
        inventory_id: 'm5-135',
        role: 'start',
        canonical_id: 'w429',
        decision: 'corrected',
        corrected_fields: ['senses'],
        decision_note: '검수 과정에서 감정의 품사와 관계 대상을 확정했다.',
      },
      {
        source: 'reference-closure',
        role: 'reference-only',
        canonical_id: 'r052',
        decision: 'included',
        related_to: ['w429'],
        decision_note: '승격 record의 relation target을 닫기 위한 참조 record다.',
      },
    ],
  };
}

function createStagedRecords() {
  return [
    {
      id: 'w429',
      record_type: 'entry',
      role: 'start',
      candidate_id: 'w429',
      lemma: '검수표적',
      search_forms: ['검수표적'],
      senses: [{
        id: 'w429-s1',
        pos: 'noun',
        gloss: '벅찬 기쁨이나 감동이 북받치는 마음.',
        relations: [{
          target: 'r052',
          target_sense: 'r052-s1',
          type: 'mood',
          note: '감정의 결을 reference-only 이미지로 확장한다.',
        }],
      }],
    },
    {
      id: 'r052',
      record_type: 'entry',
      role: 'reference-only',
      lemma: '검수참조',
      search_forms: ['검수참조'],
      senses: [{
        id: 'r052-s1',
        pos: 'noun',
        gloss: '관계를 닫기 위해서만 사용하는 참조 표제어.',
      }],
    },
  ];
}

async function createFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-batch-'));
  const manifestPath = path.join(directory, 'batch.json');
  const stagedRecordsPath = path.join(directory, 'reviewed.jsonl');
  await writeFile(manifestPath, `${JSON.stringify(createManifest(), null, 2)}\n`, 'utf8');
  await writeFile(
    stagedRecordsPath,
    `${createStagedRecords().map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  return { directory, manifestPath, stagedRecordsPath };
}

async function readManifest(manifestPath) {
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}

async function readStagedRecords(stagedRecordsPath) {
  return (await readFile(stagedRecordsPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

async function writeFixtureFiles({ directory, manifest, records }) {
  const manifestPath = path.join(directory, 'batch.json');
  const stagedRecordsPath = path.join(directory, 'reviewed.jsonl');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(
    stagedRecordsPath,
    records.length > 0
      ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
      : '',
    'utf8',
  );
  return { manifestPath, stagedRecordsPath };
}

async function createIdBoundaryFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'typewriter-batch-id-boundary-'));
  const canonicalDirectory = path.join(directory, 'canonical');
  const inventoryPath = path.join(directory, 'inventory.json');
  await mkdir(canonicalDirectory, { recursive: true });

  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const existingRecord = {
    id: 'w999',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w999',
    lemma: '기존 경계 표제어',
    search_forms: ['기존 경계 표제어'],
    senses: [{
      id: 'w999-s1',
      pos: 'noun',
      gloss: '세 자리 식별자의 마지막에 있는 기존 record.',
    }],
  };
  await writeFile(
    path.join(canonicalDirectory, 'base.jsonl'),
    `${[...canonical.records.map(({ record }) => record), existingRecord]
      .map((record) => JSON.stringify(record))
      .join('\n')}\n`,
    'utf8',
  );

  const { inventory } = await readTargetInventory(DEFAULT_INVENTORY_PATH);
  const inventoryFixture = structuredClone(inventory);
  const candidate = inventoryFixture.entries.find(
    (entry) => entry.source === 'editorial' && ['candidate', 'held'].includes(entry.status),
  );
  assert.ok(candidate, 'the default inventory must contain an editorial target');
  inventoryFixture.entries.push({
    inventory_id: 'm5-boundary-999',
    source: 'canonical',
    canonical_id: 'w999',
    promoted_from: 'm5-boundary-999',
    status: 'current',
    planned_role: 'start',
    record_type: 'entry',
    lemma: existingRecord.lemma,
    search_forms: existingRecord.search_forms,
    reason_codes: ['E'],
    pos: ['noun'],
    sense_profile: 'single',
    flags: [],
    decision_note: '가변 폭 ID 경계 fixture의 기존 canonical start.',
  });
  inventoryFixture.canonical_snapshot.record_count += 1;
  inventoryFixture.canonical_snapshot.start_count += 1;
  await writeFile(inventoryPath, `${JSON.stringify(inventoryFixture, null, 2)}\n`, 'utf8');

  const manifest = createManifest();
  manifest.batch_id = 'm5-2-id-boundary';
  manifest.records = [{
    source: 'inventory',
    inventory_id: candidate.inventory_id,
    role: 'start',
    canonical_id: 'w1000',
    decision: 'included',
    decision_note: '세 자리에서 네 자리로 넘어가는 deterministic ID fixture.',
  }];
  const stagedRecord = {
    id: 'w1000',
    record_type: 'entry',
    role: 'start',
    candidate_id: 'w1000',
    lemma: '다음 경계 표제어',
    search_forms: ['다음 경계 표제어'],
    senses: [{
      id: 'w1000-s1',
      pos: 'noun',
      gloss: '네 자리 식별자를 사용하는 신규 record.',
    }],
  };
  const manifestPath = path.join(directory, 'batch.json');
  const stagedRecordsPath = path.join(directory, 'reviewed.jsonl');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(stagedRecordsPath, `${JSON.stringify(stagedRecord)}\n`, 'utf8');

  return {
    directory,
    manifestPath,
    stagedRecordsPath,
    inventoryPath,
    canonicalDirectory,
  };
}

test('uses the batch JSON Schema conditional rules as the executable manifest contract', () => {
  assert.equal(validateBatchManifest(createManifest()).batch_id, 'm5-2-fixture');

  const invalidCases = [
    ['inventory rows require inventory_id', (manifest) => {
      delete manifest.records[0].inventory_id;
    }],
    ['inventory rows forbid related_to', (manifest) => {
      manifest.records[0].related_to = ['w353'];
    }],
    ['reference closure rows require related_to', (manifest) => {
      delete manifest.records[1].related_to;
    }],
    ['reference closure rows forbid inventory_id', (manifest) => {
      manifest.records[1].inventory_id = 'm5-002';
    }],
    ['source-specific roles are required', (manifest) => {
      manifest.records[0].role = 'reference-only';
    }],
    ['included rows require canonical_id', (manifest) => {
      delete manifest.records[0].canonical_id;
    }],
    ['held rows forbid canonical_id', (manifest) => {
      manifest.records[1].decision = 'held';
    }],
    ['corrected rows require corrected_fields', (manifest) => {
      delete manifest.records[0].corrected_fields;
    }],
    ['included rows forbid corrected_fields', (manifest) => {
      manifest.records[0].decision = 'included';
    }],
    ['complete review requires completed_at', (manifest) => {
      delete manifest.review.completed_at;
    }],
    ['incomplete review forbids completed_at', (manifest) => {
      manifest.review.status = 'in-review';
    }],
  ];

  for (const [label, mutate] of invalidCases) {
    const manifest = structuredClone(createManifest());
    mutate(manifest);
    assert.throws(
      () => validateBatchManifest(manifest),
      (error) => {
        assert.ok(error instanceof BatchValidationError, label);
        return true;
      },
      label,
    );
  }
});

test('validates and imports variable-width IDs at the w999 to w1000 boundary', async () => {
  const fixture = await createIdBoundaryFixture();
  const outputPath = path.join(fixture.directory, 'canonical-import.jsonl');

  try {
    const summary = await validateBatch(fixture);
    assert.equal(summary.stagedRecordCount, 1);
    assert.equal(summary.manifest.records[0].canonical_id, 'w1000');

    const imported = await writeReviewedBatchImport({
      ...fixture,
      outputPath,
    });
    assert.equal(imported.outputRecordCount, 1);
    const importedRecords = await readCanonicalRecords(outputPath);
    assert.deepEqual(
      importedRecords.records.map(({ record }) => record.id),
      ['w1000'],
    );

    assert.ok(compareCanonicalIds('w999', 'w1000') < 0);
    assert.deepEqual(
      ['w1000', 'w999', 'r1000', 'r999'].sort(compareCanonicalIds),
      ['r999', 'r1000', 'w999', 'w1000'],
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('validates a reviewed target plus reference closure and writes only an external import artifact', async () => {
  const fixture = await createFixture();
  const outputPath = path.join(fixture.directory, 'canonical-import.jsonl');

  try {
    const before = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
    const summary = await validateBatch(fixture);

    assert.equal(summary.manifest.batch_id, 'm5-2-fixture');
    assert.equal(summary.canonicalRecordCount, 470);
    assert.equal(summary.stagedRecordCount, 2);
    assert.equal(summary.targetCount, 1);
    assert.equal(summary.referenceClosureCount, 1);
    assert.deepEqual(summary.counts, {
      included: 1,
      held: 0,
      rejected: 0,
      corrected: 1,
    });

    const imported = await writeReviewedBatchImport({
      ...fixture,
      outputPath,
    });
    assert.equal(imported.outputRecordCount, 2);
    const importedRecords = await readCanonicalRecords(outputPath);
    assert.deepEqual(
      importedRecords.records.map(({ record }) => record.id),
      ['r052', 'w429'],
    );

    const after = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
    assert.equal(after.records.length, before.records.length);
    assert.equal(after.records.some(({ record }) => record.id === 'w429'), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('accepts a reviewed record with zero relations when no closure is needed', async () => {
  const fixture = await createFixture();

  try {
    const manifest = await readManifest(fixture.manifestPath);
    const records = await readStagedRecords(fixture.stagedRecordsPath);
    manifest.records = [manifest.records[0]];
    records[0].senses[0].relations = [];
    await writeFixtureFiles({
      directory: fixture.directory,
      manifest,
      records: [records[0]],
    });

    const summary = await validateBatch(fixture);
    assert.equal(summary.stagedRecordCount, 1);
    assert.equal(summary.referenceClosureCount, 0);
    assert.equal(summary.counts.corrected, 1);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects incomplete review before reading or importing staged rows', async () => {
  const fixture = await createFixture();

  try {
    const manifest = await readManifest(fixture.manifestPath);
    manifest.review.status = 'in-review';
    delete manifest.review.completed_at;
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');

    await assert.rejects(
      validateBatch(fixture),
      (error) => {
        assert.ok(error instanceof BatchValidationError);
        assert.equal(error.code, 'REVIEW_NOT_COMPLETE');
        return true;
      },
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects confidence metadata instead of treating it as editorial truth', async () => {
  const fixture = await createFixture();

  try {
    const manifest = await readManifest(fixture.manifestPath);
    manifest.records[0].confidence = 0.99;
    await writeFile(fixture.manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');

    await assert.rejects(
      validateBatch(fixture),
      (error) => {
        assert.ok(error instanceof BatchValidationError);
        assert.equal(error.code, 'UNKNOWN_FIELD');
        return true;
      },
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects unapproved staged rows and non-deterministic canonical IDs', async () => {
  const fixture = await createFixture();

  try {
    const records = await readStagedRecords(fixture.stagedRecordsPath);
    records[0].id = 'w430';
    records[0].candidate_id = 'w430';
    records[0].senses[0].id = 'w430-s1';
    await writeFile(
      fixture.stagedRecordsPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
    await assert.rejects(
      validateBatch(fixture),
      (error) => {
        assert.ok(error instanceof BatchValidationError);
        assert.equal(error.code, 'STAGED_RECORD_NOT_APPROVED');
        return true;
      },
    );

    const manifest = await readManifest(fixture.manifestPath);
    manifest.records[0].canonical_id = 'w430';
    await writeFixtureFiles({ directory: fixture.directory, manifest, records });
    await assert.rejects(
      validateBatch({
        ...fixture,
        manifestPath: path.join(fixture.directory, 'batch.json'),
        stagedRecordsPath: path.join(fixture.directory, 'reviewed.jsonl'),
      }),
      (error) => {
        assert.ok(error instanceof BatchValidationError);
        assert.equal(error.code, 'NON_DETERMINISTIC_CANONICAL_ID');
        return true;
      },
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects lexical collisions and orphaned reference closure', async () => {
  const fixture = await createFixture();

  try {
    const records = await readStagedRecords(fixture.stagedRecordsPath);
    records[0].search_forms = ['고요'];
    await writeFile(
      fixture.stagedRecordsPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
    await assert.rejects(
      validateBatch(fixture),
      (error) => {
        assert.ok(error instanceof BatchValidationError);
        assert.equal(error.code, 'DUPLICATE_SEARCH_FORM');
        return true;
      },
    );

    records[0].search_forms = ['검수표적'];
    records[0].senses[0].relations = [];
    await writeFile(
      fixture.stagedRecordsPath,
      `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
      'utf8',
    );
    await assert.rejects(
      validateBatch(fixture),
      (error) => {
        assert.ok(error instanceof BatchValidationError);
        assert.equal(error.code, 'ORPHAN_REFERENCE_CLOSURE');
        return true;
      },
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('rejects repository-local staging and import output paths', async () => {
  const fixture = await createFixture();
  const repositoryStagingPath = path.join(REPOSITORY_DIRECTORY, 'data', 'draft', 'reviewed.jsonl');
  const repositoryOutputPath = path.join(REPOSITORY_DIRECTORY, 'data', 'canonical', 'import.jsonl');

  try {
    await assert.rejects(
      validateBatch({
        ...fixture,
        stagedRecordsPath: repositoryStagingPath,
      }),
      (error) => {
        assert.ok(error instanceof BatchValidationError);
        assert.equal(error.code, 'STAGED_INPUT_INSIDE_REPOSITORY');
        return true;
      },
    );
    await assert.rejects(
      writeReviewedBatchImport({
        ...fixture,
        outputPath: repositoryOutputPath,
      }),
      (error) => {
        assert.ok(error instanceof BatchValidationError);
        assert.equal(error.code, 'IMPORT_OUTPUT_INSIDE_REPOSITORY');
        return true;
      },
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
