import assert from 'node:assert/strict';
import { test } from 'node:test';

import { aggregateSelfCheck, loadSelfCheck, validateSelfCheck } from './literature-evidence-selfcheck.mjs';

const row = (candidate_id, group, outcome, evidence_use = 'supports') => ({ candidate_id, group, outcome, evidence_use });

test('aggregation separates deferred resolutions, partial/still deferred, and the comparison group', () => {
  const record = { rows: [
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
  const errors = validateSelfCheck({ rows: [
    row('C000001-0001', 'deferred', 'unchanged_included'),
    row('C000001-0002', 'clear_included', 'resolved_included'),
    row('C000001-0003', 'deferred', 'still_deferred', 'great'),
    row('C000001-0003', 'deferred', 'still_deferred'),
    row('bad', 'deferred', 'still_deferred'),
  ] });
  assert.equal(errors.length, 5);
});

test('committed self-check record is valid, text-free, honestly labeled and matches the reported numbers', async () => {
  const record = await loadSelfCheck();
  assert.deepEqual(validateSelfCheck(record), []);
  assert.match(record.provenance, /not an independent adjudication/iu);
  assert.deepEqual(Object.keys(record.rows[0]).sort(), ['candidate_id', 'contexts_returned', 'deferral_heuristic_category', 'evidence_use', 'group', 'lookup_ms', 'outcome']);
  const aggregate = aggregateSelfCheck(record);
  assert.ok(aggregate.deferred_cases >= 50 && aggregate.deferred_cases <= 100);
  assert.ok(aggregate.comparison_cases > 0);
  assert.equal(Object.values(aggregate.deferred_outcomes).reduce((a, b) => a + b, 0), aggregate.deferred_cases);
});
