import assert from 'node:assert/strict';
import { test } from 'node:test';

import { readFile } from 'node:fs/promises';

import { aggregateSelfCheck, loadSelfCheck, validateCohortBinding, validateSelfCheck } from './literature-evidence-selfcheck.mjs';

const D = (n) => String(n).padStart(64, '0');

const row = (candidate_id, group, outcome, evidence_use = 'supports') => ({
  candidate_id, group, outcome, evidence_use, contexts_returned: 1, selected_location_digests: [D(1)], historical_decision_sha256: D(2),
});
const base = { retrieval: { max_contexts: 5 }, literature_index_logical_rows_sha256: D(3), cohort_selection: 'x' };

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
});

const PINNED = {
  deferred_cases: 50,
  deferred_outcomes: { resolved_included: 7, resolved_covered: 11, resolved_rejected: 4, partially_resolved: 3, still_deferred: 25 },
  deferred_fully_resolved: 22,
  deferred_evidence_use: { supports: 23, no_effect: 14, misleading_noise: 9, exposes_other_sense: 4 },
  comparison_cases: 10,
  comparison_outcomes: { unchanged_included: 10 },
  comparison_evidence_use: { supports: 6, no_effect: 3, misleading_noise: 1, exposes_other_sense: 0 },
};

test('committed self-check record is valid, text-free, honestly labeled, bound to its cohort, and pinned to the published aggregate', async () => {
  const record = await loadSelfCheck();
  assert.deepEqual(validateSelfCheck(record), []);
  assert.deepEqual(await validateCohortBinding(record), []);
  assert.match(record.provenance, /not an independent adjudication/iu);
  assert.equal(record.retrieval.max_contexts, 5);
  assert.deepEqual(aggregateSelfCheck(record), PINNED);
});

test('the published report states exactly the pinned aggregate and the reviewed retrieval condition', async () => {
  const report = await readFile(new URL('../../docs/literature-evidence-pilot-report-issue-391.md', import.meta.url), 'utf8');
  const { deferred_outcomes: o, deferred_evidence_use: u, comparison_evidence_use: c } = PINNED;
  for (const [label, count] of [['`resolved_included`', o.resolved_included], ['`resolved_covered`', o.resolved_covered], ['`resolved_rejected`', o.resolved_rejected], ['`partially_resolved`', o.partially_resolved], ['`still_deferred`', o.still_deferred]]) {
    assert.match(report, new RegExp(`\\| ${label}[^|]*\\| ${count} \\|`, 'u'), label);
  }
  assert.match(report, new RegExp(`완전 해소는 ${PINNED.deferred_fully_resolved}건`, 'u'));
  assert.match(report, new RegExp(`뒷받침 ${u.supports}, 효과 없음 ${u.no_effect}[^,]*, 잡음으로 오히려 방해한 사례 ?${u.misleading_noise}|잡음으로 오히려 방해 ${u.misleading_noise}, 다른 뜻 노출 ${u.exposes_other_sense}`, 'u'));
  assert.match(report, new RegExp(`뒷받침 ${c.supports}, 효과 없음 ${c.no_effect}, 잡음 ${c.misleading_noise}`, 'u'));
  assert.match(report, /`max_contexts=5`/u);
});
