import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeCanonicalDirectory,
  normalizeRecords,
} from '../scripts/normalize/canonical.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';
import { DatasetIntegrityError } from '../scripts/validate/dataset-integrity.mjs';

const REPOSITORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const PILOT_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
const FIXTURE_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'tests/fixtures/normalization',
);

test('normalizes the pilot without losing records, senses, relations, or notes', async () => {
  const source = await readCanonicalRecords(PILOT_DIRECTORY);
  const model = await normalizeCanonicalDirectory(PILOT_DIRECTORY, {
    checkPilotCompleteness: true,
  });

  assert.equal(model.normalization_version, '1');
  assert.equal(model.records.length, 326);
  assert.equal(
    model.records.reduce((count, record) => count + record.senses.length, 0),
    386,
  );
  assert.equal(
    model.records.reduce(
      (count, record) =>
        count +
        record.senses.reduce(
          (senseCount, sense) => senseCount + sense.relations.length,
          0,
        ),
      0,
    ),
    340,
  );

  const ids = model.records.map((record) => record.id);
  assert.deepEqual(ids, [...ids].sort());

  const normalizedById = new Map(
    model.records.map((record) => [record.id, record]),
  );
  for (const { record: sourceRecord } of source.records) {
    const normalizedRecord = normalizedById.get(sourceRecord.id);
    assert.deepEqual(
      {
        id: normalizedRecord.id,
        record_type: normalizedRecord.record_type,
        role: normalizedRecord.role,
        candidate_id: normalizedRecord.candidate_id,
        lemma: normalizedRecord.lemma,
        search_forms: normalizedRecord.search_forms,
      },
      {
        id: sourceRecord.id,
        record_type: sourceRecord.record_type,
        role: sourceRecord.role,
        candidate_id: sourceRecord.candidate_id ?? null,
        lemma: sourceRecord.lemma,
        search_forms: sourceRecord.search_forms,
      },
    );
    assert.deepEqual(
      normalizedRecord.senses.map(({ id, pos, gloss }) => ({ id, pos, gloss })),
      sourceRecord.senses.map(({ id, pos, gloss }) => ({ id, pos, gloss })),
    );
    assert.deepEqual(
      normalizedRecord.senses.flatMap((sense) =>
        sense.relations.map(({ target, target_sense, type, note }) => ({
          target,
          target_sense,
          type,
          note,
        })),
      ),
      sourceRecord.senses.flatMap((sense) =>
        (sense.relations ?? []).map(({ target, target_sense, type, note }) => ({
          target,
          target_sense: target_sense ?? null,
          type,
          note,
        })),
      ),
    );
  }

  const reference = model.records.find((record) => record.id === 'r001');
  assert.equal(reference.candidate_id, null);
  assert.deepEqual(reference.senses[0].relations, []);

  const relationlessSense = model.records
    .flatMap((record) => record.senses)
    .find((sense) => sense.id === 'w032-s2');
  assert.deepEqual(relationlessSense.relations, []);

  const directRelation = model.records
    .find((record) => record.id === 'w026')
    .senses[0].relations[0];
  assert.equal(directRelation.target_sense, 'r008-s1');
  assert.equal(
    directRelation.note,
    '소식을 담담하게 받아들였다 / 소식을 덤덤하게 받아들였다. 이 문장 틀에서는 직접 바꿔 넣을 수 있다.',
  );
});

test('is independent of file batching, applies defaults, and is idempotent', async () => {
  const oneFile = await normalizeCanonicalDirectory(
    path.join(FIXTURE_DIRECTORY, 'one-file.jsonl'),
  );
  const splitFiles = await normalizeCanonicalDirectory(
    path.join(FIXTURE_DIRECTORY, 'split'),
  );

  assert.deepEqual(oneFile, splitFiles);

  const reference = oneFile.records.find((record) => record.id === 'r001');
  assert.equal(reference.candidate_id, null);
  assert.deepEqual(reference.senses[0].relations, []);

  const optionalTargetSense = oneFile.records
    .find((record) => record.id === 'w001')
    .senses[0].relations[0];
  assert.equal(optionalTargetSense.target_sense, null);

  assert.deepEqual(normalizeRecords(oneFile.records), oneFile);
});

test('does not modify canonical input and refuses invalid dataset input', async () => {
  const sourcePath = path.join(REPOSITORY_DIRECTORY, 'data/canonical/pilot.jsonl');
  const before = await readFile(sourcePath);

  await normalizeCanonicalDirectory(PILOT_DIRECTORY, {
    checkPilotCompleteness: true,
  });

  assert.deepEqual(await readFile(sourcePath), before);

  await assert.rejects(
    normalizeCanonicalDirectory(
      path.join(
        REPOSITORY_DIRECTORY,
        'tests/fixtures/dataset-integrity/missing-target.jsonl',
      ),
    ),
    (error) => {
      assert.ok(error instanceof DatasetIntegrityError);
      assert.equal(error.code, 'MISSING_TARGET_RECORD');
      return true;
    },
  );
});

test('keeps source records unchanged while normalizing them', async () => {
  const source = await readCanonicalRecords(
    path.join(FIXTURE_DIRECTORY, 'one-file.jsonl'),
  );
  const before = structuredClone(source.records);

  normalizeRecords(source.records);

  assert.deepEqual(source.records, before);
});
