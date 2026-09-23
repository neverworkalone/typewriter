import assert from 'node:assert/strict';
import test from 'node:test';

import {
  selectionDispositionSummary,
  selectionOutcomeById,
  selectReviewedCandidates,
} from '../scripts/batch/lexical-selection.mjs';

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

test('fit surplus forms the qualified reserve and replaces genuinely held or rejected candidates', () => {
  const rows = [
    { candidate_record_id: 'fit-1', decision: 'included', gloss_judgment: 'fit', rank: 1, selection_axis: 'S' },
    { candidate_record_id: 'fit-2', decision: 'included', gloss_judgment: 'fit', rank: 2, selection_axis: 'S' },
    { candidate_record_id: 'fit-3', decision: 'included', gloss_judgment: 'fit', rank: 3, selection_axis: 'S' },
    { candidate_record_id: 'held-context', decision: 'held', gloss_judgment: 'needs-context', rank: 4, selection_axis: 'S' },
    { candidate_record_id: 'rejected-fit', decision: 'rejected', gloss_judgment: 'reject', rank: 5, selection_axis: 'S' },
  ];
  const options = {
    capacity: 2,
    coverageField: 'selection_axis',
    eligibilityField: 'gloss_judgment',
    eligibilityValue: 'fit',
  };
  const result = selectReviewedCandidates(rows, options);

  assert.equal(result.status, 'pass');
  assert.equal(result.qualified_count, 3);
  assert.deepEqual(result.selected.map(({ candidate_record_id: id }) => id), ['fit-1', 'fit-2']);
  assert.deepEqual(result.reserve.map(({ candidate_record_id: id }) => id), ['fit-3']);
  assert.deepEqual(result.excluded, ['held-context', 'rejected-fit']);

  const selectionStatuses = selectionOutcomeById(result);
  const finalRows = rows.map((row) => ({
    ...row,
    selection_status: selectionStatuses.get(row.candidate_record_id),
    final_decision: selectionStatuses.get(row.candidate_record_id) === 'reserve'
      ? 'deferred'
      : row.decision,
  }));
  const disposition = selectionDispositionSummary(finalRows);
  assert.deepEqual(disposition.counts, {
    included: 2,
    corrected: 0,
    held: 1,
    rejected: 1,
    deferred: 1,
  });
  assert.equal(disposition.processed_start_count, 4);
  assert.equal(disposition.deferred_denominator_excluded, true);
  assert.throws(
    () => selectionDispositionSummary(finalRows.map((row) => (
      row.candidate_record_id === 'fit-3' ? { ...row, final_decision: 'included' } : row
    ))),
    /final_decision does not match the selector outcome/,
  );

  for (const ineligibleOutcome of [
    { decision: 'held', gloss_judgment: 'needs-context' },
    { decision: 'rejected', gloss_judgment: 'reject' },
  ]) {
    const revisedRows = rows.map((row) => (
      row.candidate_record_id === 'fit-1' ? { ...row, ...ineligibleOutcome } : row
    ));
    const replacement = selectReviewedCandidates(revisedRows, options);
    assert.deepEqual(replacement.selected.map(({ candidate_record_id: id }) => id), ['fit-2', 'fit-3']);
    assert.deepEqual(replacement.reserve, []);
    assert.ok(replacement.excluded.includes('fit-1'));
  }
});
