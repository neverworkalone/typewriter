import assert from 'node:assert/strict';
import test from 'node:test';

import { selectReviewedCandidates } from '../scripts/batch/lexical-selection.mjs';

test('shared lexical selection rejects a top-ranked semantic failure and admits a qualified reserve', () => {
  const result = selectReviewedCandidates([
    { candidate_record_id: 'c1', decision: 'rejected', rank: 1, selection_axis: 'E' },
    { candidate_record_id: 'c2', decision: 'included', rank: 2, selection_axis: 'E' },
    { candidate_record_id: 'c3', decision: 'included', rank: 3, selection_axis: 'S' },
    { candidate_record_id: 'c4', decision: 'included', rank: 4, selection_axis: 'S' },
  ], { capacity: 2, coverageField: 'selection_axis' });

  assert.equal(result.status, 'pass');
  assert.deepEqual(result.selected.map(({ candidate_record_id: id }) => id), ['c2', 'c3']);
  assert.deepEqual(result.reserve.map(({ candidate_record_id: id }) => id), ['c4']);
  assert.deepEqual(result.excluded, ['c1']);
});

test('shared lexical selection holds when semantic review cannot fill capacity', () => {
  const result = selectReviewedCandidates([
    { candidate_record_id: 'c1', decision: 'included', rank: 1, selection_axis: 'E' },
    { candidate_record_id: 'c2', decision: 'corrected', rank: 2, selection_axis: 'S' },
    { candidate_record_id: 'c3', decision: 'held', rank: 3, selection_axis: 'X' },
  ], { capacity: 3, coverageField: 'selection_axis' });

  assert.equal(result.status, 'hold');
  assert.equal(result.reason, 'insufficient-qualified-candidates');
  assert.equal(result.qualified_count, 2);
  assert.deepEqual(result.selected, []);
});

test('shared lexical selection allocates target capacity proportionally across source-bound axes', () => {
  const result = selectReviewedCandidates([
    { candidate_record_id: 'a1', decision: 'included', rank: 1, selection_axis: 'A' },
    { candidate_record_id: 'a2', decision: 'included', rank: 2, selection_axis: 'A' },
    { candidate_record_id: 'a3', decision: 'included', rank: 3, selection_axis: 'A' },
    { candidate_record_id: 'b1', decision: 'included', rank: 4, selection_axis: 'B' },
    { candidate_record_id: 'c1', decision: 'included', rank: 5, selection_axis: 'C' },
    { candidate_record_id: 'c2', decision: 'included', rank: 6, selection_axis: 'C' },
  ], { capacity: 3, coverageField: 'selection_axis' });

  assert.equal(result.status, 'pass');
  assert.deepEqual(result.coverage_allocation, [
    { value: 'A', qualified_count: 3, selected_count: 2, reserve_count: 1 },
    { value: 'B', qualified_count: 1, selected_count: 0, reserve_count: 1 },
    { value: 'C', qualified_count: 2, selected_count: 1, reserve_count: 1 },
  ]);
  assert.deepEqual(result.selected.map(({ candidate_record_id: id }) => id), ['a1', 'a2', 'c1']);
});
