import assert from 'node:assert/strict';
import test from 'node:test';

import { runM2Pipeline } from '../scripts/verify/m2-pipeline.mjs';

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
  assert.equal(summary.worktreeState, 'dirty-allowed');
});
