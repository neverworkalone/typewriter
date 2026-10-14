import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateSelfCheck, validateSelfCheck } from './literature-evidence-selfcheck.mjs';

const D = (n) => String(n).padStart(64, '0');

const row = (candidate_id, group, outcome, evidence_use = 'supports') => ({
  candidate_id, group, outcome, evidence_use, contexts_returned: 1, selected_location_digests: [D(1)], historical_decision_sha256: D(2),
});
const base = {
  retrieval: { max_contexts: 5, max_per_work: 1, hit_fetch_cap: 2000 }, literature_index_logical_rows_sha256: D(3), cohort_selection: 'x',
  cohort: { universe_batches: [], excluded_no_context_ids: [], deferred_per_category: {}, comparison_count: 0 },
};

test('aggregation separates deferred resolutions, partial/still deferred, and the comparison group', () => {
  const record = { ...base, rows: [
    row('C000001-0001', 'deferred', 'resolved_included'),
    row('C000001-0002', 'deferred', 'resolved_covered'),
    row('C000001-0003', 'deferred', 'resolved_rejected', 'exposes_other_sense'),
    row('C000001-0004', 'deferred', 'partially_resolved'),
    row('C000001-0005', 'deferred', 'still_deferred', 'misleading_noise'),
    row('C000001-0006', 'clear_included', 'unchanged_included', 'no_effect'),
  ] };
  assert.deepEqual(validateSelfCheck(record), []);
  const aggregate = aggregateSelfCheck(record);
  assert.equal(aggregate.deferred_cases, 5);
  assert.equal(aggregate.deferred_fully_resolved, 3);
  assert.deepEqual(aggregate.deferred_outcomes, { resolved_included: 1, resolved_covered: 1, resolved_rejected: 1, partially_resolved: 1, still_deferred: 1 });
  assert.equal(aggregate.deferred_evidence_use.misleading_noise, 1);
  assert.deepEqual(aggregate.comparison_outcomes, { unchanged_included: 1 });
});

test('validation rejects cross-group outcomes, unknown enums and duplicate candidates', () => {
  const errors = validateSelfCheck({ ...base, rows: [
    row('C000001-0001', 'deferred', 'unchanged_included'),
    row('C000001-0002', 'clear_included', 'resolved_included'),
    row('C000001-0003', 'deferred', 'still_deferred', 'great'),
    row('C000001-0003', 'deferred', 'still_deferred'),
    row('bad', 'deferred', 'still_deferred'),
  ] });
  assert.equal(errors.length, 5);
  const bound = (patch) => validateSelfCheck({ ...base, rows: [{ ...row('C000001-0001', 'deferred', 'still_deferred'), ...patch }] });
  assert.deepEqual(bound({}), []);
  assert.equal(bound({ contexts_returned: 2 }).length, 1);
  assert.equal(bound({ contexts_returned: 6, selected_location_digests: [1, 2, 3, 4, 5, 6].map(D) }).length, 1);
  assert.equal(bound({ selected_location_digests: ['x'] }).length, 1);
  assert.equal(bound({ historical_decision_sha256: undefined }).length, 1);
  assert.ok(validateSelfCheck({ rows: [] }).length >= 3);
  assert.equal(bound({ contexts_returned: 0, selected_location_digests: [] }).length, 1);
  for (const retrieval of [{ max_contexts: 8 }, { max_per_work: 2 }, { hit_fetch_cap: 10 }]) {
    assert.equal(validateSelfCheck({ ...base, retrieval: { ...base.retrieval, ...retrieval }, rows: [] }).length, 1);
  }
});
