import assert from 'node:assert/strict';
import test from 'node:test';

import { selectReviewedCandidates } from '../scripts/batch/lexical-selection.mjs';

test('shared lexical selection rejects a top-ranked semantic failure and admits a qualified reserve', () => {
  const result = selectReviewedCandidates([
    { candidate_record_id: 'c1', decision: 'rejected', rank: 1, score: 1 },
    { candidate_record_id: 'c2', decision: 'included', rank: 2, score: 0.8 },
    { candidate_record_id: 'c3', decision: 'included', rank: 3, score: 0.7 },
    { candidate_record_id: 'c4', decision: 'included', rank: 4, score: 0.6 },
  ], { capacity: 2 });

  assert.equal(result.status, 'pass');
  assert.deepEqual(result.selected.map(({ candidate_record_id: id }) => id), ['c2', 'c3']);
  assert.deepEqual(result.reserve.map(({ candidate_record_id: id }) => id), ['c4']);
  assert.deepEqual(result.excluded, ['c1']);
});

test('shared lexical selection holds when semantic review cannot fill capacity', () => {
  const result = selectReviewedCandidates([
    { candidate_record_id: 'c1', decision: 'included', rank: 1, score: 0.9 },
    { candidate_record_id: 'c2', decision: 'corrected', rank: 2, score: 0.8 },
    { candidate_record_id: 'c3', decision: 'held', rank: 3, score: 0.7 },
  ], { capacity: 3 });

  assert.equal(result.status, 'hold');
  assert.equal(result.reason, 'insufficient-qualified-candidates');
  assert.equal(result.qualified_count, 2);
  assert.deepEqual(result.selected, []);
});
