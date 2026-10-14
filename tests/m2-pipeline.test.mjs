import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  assertCanonicalModelMatchesRaw,
  runM2Pipeline,
} from '../scripts/verify/m2-pipeline.mjs';
import {
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';
import { normalizeCanonicalDirectory } from '../scripts/normalize/canonical.mjs';

const PILOT_DIRECTORY = path.resolve(
  'tests/fixtures/canonical-sample',
);

test('runs the complete M2 pipeline and compares canonical rows to SQLite', async () => {
  const summary = await runM2Pipeline({
    inputDirectory: PILOT_DIRECTORY,
    allowDirty: true,
  });

  assert.equal(summary.fileCount, 1);
  assert.equal(summary.recordCount, 6);
  assert.equal(summary.startCount, 5);
  assert.equal(summary.referenceOnlyCount, 1);
  assert.equal(summary.candidateCount, 5);
  assert.equal(summary.searchFormCount, 7);
  assert.equal(summary.senseCount, 7);
  assert.equal(summary.relationCount, 3);
  assert.equal(summary.expressionCount, 1);
  assert.equal(summary.databaseBuilds, 2);
  assert.equal(summary.normalizationVersion, '1');
  assert.ok(['clean', 'dirty-allowed'].includes(summary.worktreeState));
});

test('rejects normalized semantic-field drift before SQLite comparison', async () => {
  const canonical = await readCanonicalRecords(PILOT_DIRECTORY);
  const model = await normalizeCanonicalDirectory(PILOT_DIRECTORY, {
  });
  const mutations = [
    (candidate) => {
      candidate.records.find((record) => record.id === 'w001').lemma = '변경된 표제어';
    },
    (candidate) => {
      candidate.records
        .find((record) => record.id === 'w001')
        .senses.find((sense) => sense.id === 'w001-s1')
        .gloss = '변경된 풀이';
    },
    (candidate) => {
      candidate.records
        .find((record) => record.id === 'w001')
        .senses.find((sense) => sense.id === 'w001-s1')
        .relations[0]
        .note = '변경된 관계 메모';
    },
  ];

  for (const mutate of mutations) {
    const corruptedModel = structuredClone(model);
    mutate(corruptedModel);
    assert.throws(
      () => assertCanonicalModelMatchesRaw(canonical.records, corruptedModel),
      /normalized model must preserve canonical logical fields/,
    );
  }
});
