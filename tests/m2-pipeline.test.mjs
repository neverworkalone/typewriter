import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCanonicalModelMatchesRaw,
  runM2Pipeline,
} from '../scripts/verify/m2-pipeline.mjs';
import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../scripts/validate/canonical-jsonl.mjs';
import { normalizeCanonicalDirectory } from '../scripts/normalize/canonical.mjs';

test('runs the complete M2 pipeline and compares canonical rows to SQLite', async () => {
  const summary = await runM2Pipeline({ allowDirty: true });

  assert.equal(summary.fileCount, 1);
  assert.equal(summary.recordCount, 326);
  assert.equal(summary.startCount, 300);
  assert.equal(summary.referenceOnlyCount, 26);
  assert.equal(summary.candidateCount, 300);
  assert.equal(summary.searchFormCount, 363);
  assert.equal(summary.senseCount, 386);
  assert.equal(summary.relationCount, 340);
  assert.equal(summary.expressionCount, 14);
  assert.equal(summary.databaseBuilds, 2);
  assert.equal(summary.normalizationVersion, '1');
  assert.ok(['clean', 'dirty-allowed'].includes(summary.worktreeState));
});

test('rejects normalized semantic-field drift before SQLite comparison', async () => {
  const canonical = await readCanonicalRecords(DEFAULT_CANONICAL_DIRECTORY);
  const model = await normalizeCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY, {
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
