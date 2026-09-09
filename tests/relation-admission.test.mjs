import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_FIXTURE_PATH,
  DEFAULT_SOURCE_ARTIFACT,
  validateRelationAdmissionRegression,
} from '../scripts/batch/validate-relation-admission.mjs';
import { readCanonicalRecords } from '../scripts/validate/canonical-jsonl.mjs';

const WAVE_A_CANONICAL_DIRECTORY = path.resolve('data/batches/m5-10a-wave-a-base-canonical');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

test('M5-5 relation removals remain human-authored admission regressions', async () => {
  const [fixture, relationDiff] = await Promise.all([
    readJson(DEFAULT_FIXTURE_PATH),
    readJson(DEFAULT_SOURCE_ARTIFACT),
  ]);
  const result = validateRelationAdmissionRegression(fixture, relationDiff);

  assert.equal(result.removed_error_count, 7);
  assert.equal(result.correction_case_count, 1);
  assert.deepEqual(result.failure_categories, [
    'arbitrary-modifier-or-place',
    'broad-common-category',
    'generic-result-or-reaction',
    'incidental-co-occurrence',
    'sense-target-type-error',
    'unsupported-cross-sensory',
  ]);
  assert.ok(fixture.cases.every(({ expected_action }) => expected_action === 'omit'));
  assert.ok(
    fixture.corrections.every(
      ({ expected_action }) => expected_action === 'retarget-after-editor-review',
    ),
  );
});

test('relation admission regression validation does not approve a changed expectation', async () => {
  const [fixture, relationDiff] = await Promise.all([
    readJson(DEFAULT_FIXTURE_PATH),
    readJson(DEFAULT_SOURCE_ARTIFACT),
  ]);
  const changed = structuredClone(fixture);
  changed.cases[0].expected_action = 'accept';

  assert.throws(
    () => validateRelationAdmissionRegression(changed, relationDiff),
    (error) => error.code === 'SCHEMA_ERROR',
  );
});

test('M5-6 admission controls remain present after the M5-7 import', async () => {
  const { records } = await readCanonicalRecords(WAVE_A_CANONICAL_DIRECTORY);
  const recordValues = records.map(({ record }) => record);
  const countRelations = recordValues.reduce(
    (counts, record) => {
      if (record.record_type === 'expression') counts.expression_count += 1;
      if (record.role === 'start') counts.start_count += 1;
      if (record.role === 'reference-only') counts.reference_only_count += 1;
      counts.sense_count += record.senses.length;
      counts.relation_count += record.senses.reduce(
        (count, sense) => count + (sense.relations?.length ?? 0),
        0,
      );
      return counts;
    },
    {
      record_count: 0,
      start_count: 0,
      reference_only_count: 0,
      sense_count: 0,
      relation_count: 0,
      expression_count: 0,
    },
  );
  countRelations.record_count = recordValues.length;

  assert.deepEqual(countRelations, {
    record_count: 620,
    start_count: 578,
    reference_only_count: 42,
    sense_count: 743,
    relation_count: 467,
    expression_count: 39,
  });
});

test('relation admission fixture stays inside the repository as self-authored metadata', () => {
  assert.equal(
    path.relative(process.cwd(), DEFAULT_FIXTURE_PATH),
    'tests/fixtures/relation-admission/m5-5-regressions.json',
  );
  assert.equal(
    path.relative(process.cwd(), DEFAULT_SOURCE_ARTIFACT),
    'data/batches/m5-5-recalibration-relation-diff.json',
  );
});
