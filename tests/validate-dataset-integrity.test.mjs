import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DatasetIntegrityError,
  validateDatasetDirectory,
} from '../scripts/validate/dataset-integrity.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const REPOSITORY_DIRECTORY = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const PILOT_DIRECTORY = path.join(REPOSITORY_DIRECTORY, 'data/canonical');
const FIXTURE_DIRECTORY = path.join(
  REPOSITORY_DIRECTORY,
  'tests/fixtures/dataset-integrity',
);

test('validates the pilot dataset counts and current completeness regression', async () => {
  assert.deepEqual(
    await validateDatasetDirectory(PILOT_DIRECTORY, {
      checkPilotCompleteness: true,
    }),
    {
      fileCount: 1,
      recordCount: 326,
      senseCount: 386,
      relationCount: 340,
      candidateCount: 300,
    },
  );
});

test('accepts valid asymmetric and cross-part-of-speech relations', async () => {
  assert.deepEqual(
    await validateDatasetDirectory(
      path.join(FIXTURE_DIRECTORY, 'valid-asymmetric.jsonl'),
    ),
    {
      fileCount: 1,
      recordCount: 2,
      senseCount: 2,
      relationCount: 2,
      candidateCount: 2,
    },
  );
});

test('allows target_sense to be omitted for a relation that does not need sense precision', async () => {
  assert.equal(
    (await validateDatasetDirectory(
      path.join(FIXTURE_DIRECTORY, 'target-sense-optional.jsonl'),
    )).relationCount,
    1,
  );
});

test('reads multiple canonical files in stable lexical path order', async () => {
  const result = await readCanonicalRecords(path.join(FIXTURE_DIRECTORY, 'multi'));
  assert.equal(result.fileCount, 2);
  assert.deepEqual(
    result.records.map(({ record }) => record.id),
    ['w001', 'w002'],
  );
});

const invalidCases = [
  ['missing-target.jsonl', 'MISSING_TARGET_RECORD', /target record w999 does not exist/],
  [
    'target-sense-mismatch.jsonl',
    'TARGET_SENSE_RECORD_MISMATCH',
    /target_sense w001-s1 belongs to record w001, not w002/,
  ],
  ['duplicate-record.jsonl', 'DUPLICATE_RECORD_ID', /duplicate record id w001/],
  ['duplicate-sense.jsonl', 'DUPLICATE_SENSE_ID', /duplicate sense id w001-s1/],
  [
    'duplicate-candidate.jsonl',
    'DUPLICATE_CANDIDATE_ID',
    /duplicate candidate_id w001/,
  ],
  ['self-reference.jsonl', 'SELF_REFERENCE', /self-reference to source record w001/],
  ['duplicate-relation.jsonl', 'DUPLICATE_RELATION', /duplicate relation/],
  [
    'action-target-pos.jsonl',
    'ACTION_TARGET_POS',
    /action target_sense w002-s1 has pos noun; expected verb or expression/,
  ],
  [
    'action-without-target-sense.jsonl',
    'ACTION_TARGET_SENSE_MISSING',
    /action relation requires target_sense/,
  ],
  [
    'role-candidate.jsonl',
    'REFERENCE_CANDIDATE_FORBIDDEN',
    /pure reference-only record r001 must not have candidate_id/,
  ],
  [
    'start-candidate-missing.jsonl',
    'START_CANDIDATE_MISSING',
    /role start requires candidate_id equal to the record id/,
  ],
];

for (const [filename, code, messagePattern] of invalidCases) {
  test(`rejects ${filename}`, async () => {
    await assert.rejects(
      validateDatasetDirectory(path.join(FIXTURE_DIRECTORY, filename)),
      (error) => {
        assert.ok(error instanceof DatasetIntegrityError);
        assert.equal(error.code, code);
        assert.match(error.message, new RegExp(`${filename}:`));
        assert.match(error.message, messagePattern);
        return true;
      },
    );
  });
}
