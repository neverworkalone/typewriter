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
  'data/batches/m5-10a-wave-a-base-canonical',
);

test('runs the complete M2 pipeline and compares canonical rows to SQLite', async () => {
  const summary = await runM2Pipeline({
    inputDirectory: PILOT_DIRECTORY,
    allowDirty: true,
  });

  assert.equal(summary.fileCount, 6);
  assert.equal(summary.recordCount, 620);
  assert.equal(summary.startCount, 578);
  assert.equal(summary.referenceOnlyCount, 42);
  assert.equal(summary.candidateCount, 578);
  assert.equal(summary.searchFormCount, 696);
  assert.equal(summary.senseCount, 743);
  assert.equal(summary.relationCount, 467);
  assert.equal(summary.expressionCount, 39);
  assert.equal(summary.databaseBuilds, 2);
  assert.equal(summary.normalizationVersion, '1');
  assert.ok(['clean', 'dirty-allowed'].includes(summary.worktreeState));
});

test('rejects normalized semantic-field drift before SQLite comparison', async () => {
  const canonical = await readCanonicalRecords(PILOT_DIRECTORY);
  const model = await normalizeCanonicalDirectory(PILOT_DIRECTORY, {
    checkPilotCompleteness: true,
  });
  const mutations = [
    (candidate) => {
      candidate.records.find((record) => record.id === 'w026').lemma = '변경된 표제어';
    },
    (candidate) => {
      candidate.records
        .find((record) => record.id === 'w026')
        .senses.find((sense) => sense.id === 'w026-s1')
        .gloss = '변경된 풀이';
    },
    (candidate) => {
      candidate.records
        .find((record) => record.id === 'w026')
        .senses.find((sense) => sense.id === 'w026-s1')
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
