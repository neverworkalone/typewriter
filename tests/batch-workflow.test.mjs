import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BatchValidationError,
  REPOSITORY_DIRECTORY,
  validateBatch,
} from '../scripts/batch/validate-batch.mjs';
import { writeReviewedBatchImport } from '../scripts/batch/import-reviewed-batch.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';

function createManifest() {
  return {
    schema_version: '1',
    batch_id: 'm5-2-fixture',
    inventory_id: 'm5-core-5k',
    inventory_revision: 'm5-1',
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
        inventory_id: 'm5-001',
        role: 'start',
        canonical_id: 'w301',
        decision: 'corrected',
        corrected_fields: ['senses'],
        decision_note: '검수 과정에서 감정의 품사와 관계 대상을 확정했다.',
      },
      {
        source: 'reference-closure',
        role: 'reference-only',
        canonical_id: 'r036',
        decision: 'included',
        related_to: ['w301'],
        decision_note: '승격 record의 relation target을 닫기 위한 참조 record다.',
      },
    ],
  };
}

function createStagedRecords() {
  return [
    {
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
        relations: [{
          target: 'r036',
          target_sense: 'r036-s1',
          type: 'mood',
          note: '감정의 결을 reference-only 이미지로 확장한다.',
        }],
      }],
    },
    {
      id: 'r036',
      record_type: 'entry',
      role: 'reference-only',
      lemma: '참조표',
      search_forms: ['참조표'],
      senses: [{
        id: 'r036-s1',
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

test('validates a reviewed target plus reference closure and writes only an external import artifact', async () => {
  const fixture = await createFixture();
  const outputPath = path.join(fixture.directory, 'canonical-import.jsonl');

  try {
    const before = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
    const summary = await validateBatch(fixture);

    assert.equal(summary.manifest.batch_id, 'm5-2-fixture');
    assert.equal(summary.canonicalRecordCount, 326);
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
      ['r036', 'w301'],
    );

    const after = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
    assert.equal(after.records.length, before.records.length);
    assert.equal(after.records.some(({ record }) => record.id === 'w301'), false);
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
    records[0].id = 'w302';
    records[0].candidate_id = 'w302';
    records[0].senses[0].id = 'w302-s1';
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
    manifest.records[0].canonical_id = 'w302';
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

    records[0].search_forms = ['감격'];
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
