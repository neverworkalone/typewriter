import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  DEFAULT_SEMANTIC_DECISION_SOURCE_PATH,
  serializeSemanticDecisionSource,
  sha256Json,
} from '../scripts/validate/semantic-audit.mjs';

function changedLineCount(before, after) {
  const beforeLines = before.toString('utf8').split('\n');
  const afterLines = after.toString('utf8').split('\n');
  const sharedLineCount = Math.min(beforeLines.length, afterLines.length);
  let changed = Math.abs(beforeLines.length - afterLines.length);
  for (let index = 0; index < sharedLineCount; index += 1) {
    if (beforeLines[index] !== afterLines[index]) changed += 1;
  }
  return changed;
}

test('semantic decision source preserves locality for a representative future batch delta', async () => {
  const beforeBytes = await readFile(DEFAULT_SEMANTIC_DECISION_SOURCE_PATH);
  const before = JSON.parse(beforeBytes);
  assert.deepEqual(serializeSemanticDecisionSource(before), beforeBytes);

  const after = structuredClone(before);
  const target = after.authored_review.records.find((record) => record.record_id === 'w529');
  const unaffected = after.authored_review.records.find((record) => record.record_id === 'w530');
  assert.ok(target);
  assert.ok(unaffected);

  if (typeof target.boundary_review.rationale === 'string') {
    target.boundary_review.rationale += ' [future-batch-locality-fixture]';
  } else {
    target.boundary_review.rationale_code += '-future-batch-locality-fixture';
  }
  after.authored_review_sha256 = sha256Json(after.authored_review);

  const afterBytes = serializeSemanticDecisionSource(after);
  assert.equal(
    JSON.stringify(unaffected),
    JSON.stringify(before.authored_review.records.find((record) => record.record_id === 'w530')),
  );
  assert.notEqual(after.authored_review_sha256, before.authored_review_sha256);
  assert.ok(
    changedLineCount(beforeBytes, afterBytes) <= 4,
    'a one-record semantic decision change must not rewrite the retained decision source corpus',
  );
});
