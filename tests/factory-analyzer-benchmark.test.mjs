import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createMecabProvider, pinnedMetadata as mecabMetadata } from '../scripts/factory/mecab-provider.mjs';
import { renderReport } from '../scripts/factory/benchmark-analyzers.mjs';
import {
  BASELINE, BenchmarkError, PROVIDER_IDS, SAMPLE_SEED, STRATUM_ORDER, agreementClass, buildSummary, replayUpstreamHolds, selectSample, sha256, simulateOrder,
  standaloneRecord, validateAdjudication, verifiedLabel, verifyBaseline, wilson,
} from '../scripts/factory/benchmark-core.mjs';
import { item, khaiii, kiwi, stub } from './support/khaiii-fixtures.mjs';

// Synthetic cohort + matching pins: proves every fail-closed rule without the real corpus.
function cohort({ holds = (i) => (i % 2 === 0 ? ['analysis_ambiguous'] : []), count = 6 } = {}) {
  const rows = Array.from({ length: count }, (_, i) => ({
    candidate_id: `C000001-${String(i + 1).padStart(4, '0')}`, input: `단어${'가나다라마바사'[i % 7]}`, pos: 'noun', usage_hint: 'x',
    observedForms: [`표면${'가나다라마바사'[i % 7]}${'가나다라마바사'[Math.floor(i / 7)]}`], evidence: [{ kind: 'corpus-paragraph', ref: `D${i}#P${i}` }, { kind: 'corpus-surface', ref: 'x' }], holds: holds(i),
  }));
  const candidatesText = `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
  const manifest = { batch_id: 'C000001', candidate_count: count, candidates_sha256: sha256(candidatesText), source_evidence_sha256: 'e', source_snapshot: 's', analyzer_digest: 'a', analyzer_version: 'v' };
  const manifestText = `${JSON.stringify(manifest)}\n`;
  const counts = {};
  rows.forEach((row) => row.holds.forEach((hold) => { counts[hold] = (counts[hold] ?? 0) + 1; }));
  const held = rows.filter((row) => row.holds.length).length;
  const pins = { ...BASELINE, manifest_sha256: sha256(manifestText), candidates_sha256: sha256(candidatesText), source_evidence_sha256: 'e', source_snapshot: 's', analyzer_digest: 'a',
    analyzer_version: 'v', usage_rows: count, distinct_lemmas: new Set(rows.map((row) => row.input)).size, held_rows: held, unheld_rows: count - held, hold_counts: counts };
  return { rows, manifestText, candidatesText, pins };
}
const reject = (fn, pattern) => assert.throws(fn, (error) => error instanceof BenchmarkError && pattern.test(error.message), String(pattern));

test('cohort verification accepts the exact cohort and refuses every deviation', () => {
  const { manifestText, candidatesText, pins, rows } = cohort();
  assert.equal(verifyBaseline({ manifestText, candidatesText }, pins).length, rows.length);
  reject(() => verifyBaseline({ manifestText, candidatesText: candidatesText.replace('표면', '표명') }, pins), /candidates\.jsonl sha256/u);
  reject(() => verifyBaseline({ manifestText: manifestText.replace('"v"', '"w"'), candidatesText }, pins), /manifest\.json sha256/u);
  const incomplete = cohort({ count: 5 });
  reject(() => verifyBaseline({ manifestText: incomplete.manifestText, candidatesText: incomplete.candidatesText }, { ...incomplete.pins, usage_rows: 6 }), /exactly 6 v1 usage rows/u);
  for (const [label, mutate, pattern] of [
    ['reordered ids', (list) => { [list[0], list[1]] = [list[1], list[0]]; }, /candidate_id/u],
    ['dropped hold', (list) => { list[0].holds = []; }, /held\/unheld|hold counts/u],
    ['extra observed form', (list) => { list[1].observedForms.push('여분'); }, /exactly one observed form/u],
    ['duplicate surface', (list) => { list[1].observedForms = [...list[0].observedForms]; }, /surfaces are not unique/u],
  ]) {
    const next = cohort();
    const list = next.rows.map((row) => structuredClone(row));
    mutate(list);
    const text = `${list.map((row) => JSON.stringify(row)).join('\n')}\n`;
    const manifest = `${JSON.stringify({ ...JSON.parse(next.manifestText), candidates_sha256: sha256(text) })}\n`;
    reject(() => verifyBaseline({ manifestText: manifest, candidatesText: text }, { ...next.pins, manifest_sha256: sha256(manifest), candidates_sha256: sha256(text) }), pattern);
  }
  const wrongDigest = JSON.stringify({ ...JSON.parse(manifestText), analyzer_digest: 'z' });
  reject(() => verifyBaseline({ manifestText: `${wrongDigest}\n`, candidatesText }, { ...pins, manifest_sha256: sha256(`${wrongDigest}\n`) }), /manifest analyzer_digest/u);
});

test('overlapping original holds: replay separates upstream from Kiwi-derived holds and refuses drift', () => {
  const { rows } = cohort({ count: 3, holds: (i) => [['analysis_ambiguous', 'coverage_collision'], ['analysis_ambiguous'], []][i] });
  const replay = replayUpstreamHolds(rows, [{ holds: ['analysis_ambiguous'] }, { holds: ['analysis_ambiguous'] }, { holds: [] }]);
  assert.deepEqual(replay.map((entry) => entry.upstream), [['coverage_collision'], [], []]);
  assert.deepEqual(replay.map((entry) => entry.ambiguityOriginIndeterminate), [true, true, false]);
  reject(() => replayUpstreamHolds(rows, [{ holds: [] }, { holds: [] }, { holds: ['analysis_unsupported'] }]), /absent from the baseline/u);
});

const mecabStub = (table) => { const inner = stub(table, mecabMetadata()); return { ...createMecabProvider({ analyze: inner.analyze }), calls: inner.calls }; };

test('best-only agreement never clears a hold; later providers see only unresolved surfaces; upstream holds survive', async () => {
  const mk = (lemma, surface, holds) => ({ candidate_id: `C000001-${lemma}`, input: lemma, pos: 'verb', observedForms: [surface], evidence: [{ kind: 'corpus-paragraph', ref: `${lemma}#p` }], holds });
  const rows = [mk('가다', '가서', []), mk('나오다', '나와', ['analysis_ambiguous']), mk('하다', '한', ['analysis_unsupported', 'coverage_collision']), mk('보다', '봐', ['analysis_ambiguous'])];
  const providers = {
    kiwi: kiwi({ 가서: [[item('가다', 'verb')]], 나와: [[item('나오다', 'verb')], [item('나다', 'verb')]], 봐: [[item('보다', 'verb')], [item('봐', 'noun')]] }),
    khaiii: khaiii({ 나와: [[item('나오다', 'verb')]], 한: [[item('하다', 'verb')]], 봐: [[item('보다', 'verb')]] }),
    mecab: mecabStub({ 나와: [[item('나오다', 'verb')]], 한: [[item('하다', 'verb')]], 봐: [[item('보다', 'verb')]] }),
  };
  const replay = rows.map((row) => ({ upstream: row.holds.filter((hold) => hold === 'coverage_collision') }));
  const result = await simulateOrder({ order: ['kiwi', 'khaiii', 'mecab'], rows, replay, providers });
  const byId = Object.fromEntries(result.perId.map((entry) => [entry.candidate_id.slice(8), entry]));
  assert.equal(byId['가다'].state, 'apparent_resolved');
  assert.deepEqual(byId['가다'].providers_asked, ['kiwi'], 'a resolved input is never invoked again');
  assert.equal(byId['나오다'].state, 'needs_verification', 'three agreeing readings are still uncertain');
  assert.ok(byId['나오다'].holds.includes('analysis_ambiguous'), 'best-only agreement does not clear analysis_ambiguous');
  assert.deepEqual(byId['나오다'].providers_asked, ['kiwi', 'khaiii', 'mecab']);
  assert.ok(byId['하다'].holds.includes('coverage_collision'), 'unrelated upstream hold is not dropped');
  assert.deepEqual(providers.khaiii.calls.flat().sort(), ['나와', '봐', '한'], 'Khaiii asked only about the surfaces Kiwi left unresolved');
  assert.equal(result.calls.kiwi.surfaces, 4);
  assert.equal(result.calls.khaiii.calls, 1);
  assert.equal(result.perId.filter((entry) => entry.state === 'apparent_resolved').length, 1);
  assert.equal(result.reached.mecab.length, 3);
});

test('agreement classes compare only successful readings and never imply correctness', () => {
  const reading = (best, outcome = 'success') => ({ outcome, best });
  assert.equal(agreementClass({ kiwi: reading('a/noun'), khaiii: reading('a/noun'), mecab: reading('a/noun') }), 'all_agree');
  assert.equal(agreementClass({ kiwi: reading('a/noun'), khaiii: reading('a/noun'), mecab: reading('b/noun') }), 'one_vs_two_mecab_differs');
  assert.equal(agreementClass({ kiwi: reading('a/noun'), khaiii: reading('b/noun'), mecab: reading('a/noun') }), 'one_vs_two_khaiii_differs');
  assert.equal(agreementClass({ kiwi: reading('b/noun'), khaiii: reading('a/noun'), mecab: reading('a/noun') }), 'one_vs_two_kiwi_differs');
  assert.equal(agreementClass({ kiwi: reading('a/noun'), khaiii: reading('b/noun'), mecab: reading('c/noun') }), 'three_way_disagreement');
  assert.equal(agreementClass({ kiwi: reading('a/noun'), khaiii: reading('', 'unsupported'), mecab: reading('a/noun') }), 'incomparable_unsupported_or_error');
});

test('stratified sample is deterministic, bounded, and puts each row in exactly one stratum', () => {
  const entries = Array.from({ length: 120 }, (_, i) => ({ candidate_id: `C000001-${String(i + 1).padStart(4, '0')}`, stratum: STRATUM_ORDER[i % 5] }));
  const first = selectSample(entries);
  assert.deepEqual(first, selectSample([...entries].reverse().map((entry) => ({ ...entry }))), 'independent of input order');
  assert.equal(first.seed, SAMPLE_SEED);
  for (const stratum of STRATUM_ORDER.slice(0, 5)) assert.equal(first.strata[stratum].sampled, 10);
  assert.equal(new Set(first.sample.map((entry) => entry.candidate_id)).size, first.sample.length);
  assert.notDeepEqual(first.sample, selectSample(entries, { seed: 'other' }).sample, 'the seed controls the draw');
  const interval = wilson(10, 10);
  assert.ok(interval.low < 0.8 && interval.high === 1, 'a clean small sample still has a wide bound');
  assert.deepEqual(wilson(0, 0), { low: null, high: null });
});

test('truth labels: best-only is never certainty; unsupported and unknown stay separate', () => {
  const truth = { lemma: '가장하다', pos: 'verb', root: { lemma: '가장', pos: 'noun' } };
  const decision = { status: 'ai_self_check', truth };
  assert.equal(verifiedLabel({ outcome: 'success', best: '가장/noun+가장하다/verb' }, decision), 'self_check_correct', 'a self-check is never promoted to verified');
  assert.equal(verifiedLabel({ outcome: 'success', best: '가/noun+장/adverb' }, decision), 'self_check_wrong');
  const provenance = { adjudicator_role: 'independent_reviewer', independent: true, analyzer_blind: true, evidence_access: 'authorized_original_context' };
  assert.equal(verifiedLabel({ outcome: 'success', best: '가장/noun' }, { status: 'verified', truth, provenance }), 'verified_correct');
  assert.equal(verifiedLabel({ outcome: 'unsupported', best: '' }, decision), 'unsupported');
  assert.equal(verifiedLabel({ outcome: 'success', best: '' }, decision), 'unsupported', 'a path with no content morpheme explains nothing');
  assert.equal(verifiedLabel({ outcome: 'success', best: '가장/noun' }, { status: 'truth_unknown' }), 'truth_unknown');
  assert.equal(verifiedLabel({ outcome: 'success', best: '가장/noun' }, undefined), 'truth_unknown');
  const sample = [{ candidate_id: 'a' }, { candidate_id: 'b' }];
  validateAdjudication([{ candidate_id: 'a', status: 'truth_unknown' }, { candidate_id: 'b', status: 'ai_self_check', truth: { lemma: 'x', pos: 'noun' } }], sample);
  const claimed = [{ candidate_id: 'a', status: 'truth_unknown' }, { candidate_id: 'b', status: 'verified', truth: { lemma: 'x', pos: 'noun' } }];
  reject(() => validateAdjudication(claimed, sample), /verified requires independent, analyzer-blind provenance/u);
  reject(() => validateAdjudication([claimed[0], { ...claimed[1], provenance: { adjudicator_role: 'primary_agent', independent: true, analyzer_blind: true, evidence_access: 'authorized_original_context' } }], sample), /verified requires/u);
  validateAdjudication([claimed[0], { ...claimed[1], provenance: { adjudicator_role: 'human_editor', independent: true, analyzer_blind: true, evidence_access: 'authorized_original_context' } }], sample);
  reject(() => validateAdjudication([{ candidate_id: 'a', status: 'truth_unknown' }], sample), /sampled but not adjudicated/u);
  reject(() => validateAdjudication([{ candidate_id: 'a', status: 'truth_unknown' }, { candidate_id: 'b', status: 'truth_unknown', truth: { lemma: 'x', pos: 'noun' } }], sample), /must not carry a truth/u);
  reject(() => validateAdjudication([{ candidate_id: 'z', status: 'truth_unknown' }, { candidate_id: 'a', status: 'truth_unknown' }, { candidate_id: 'b', status: 'truth_unknown' }], sample), /not in the predeclared sample/u);
});

test('standalone record normalizes outcomes and flags malformed output as an error, not a reading', () => {
  const provider = kiwi({});
  const request = { id: '가서', text: '가서' };
  const row = { input: '가다', pos: 'verb' };
  const ok = standaloneRecord(provider, request, row, { id: '가서', input_digest: sha256Digest('가서'), status: 'ok', analyses: [[item('가다', 'verb')]] });
  assert.equal(ok.outcome, 'success');
  assert.equal(ok.best, '가다/verb');
  assert.equal(ok.hint_in_best, true);
  assert.equal(standaloneRecord(provider, request, row, undefined).outcome, 'missing');
  assert.equal(standaloneRecord(provider, request, row, { id: '가서', input_digest: 'wrong', status: 'ok', analyses: [[item('가다', 'verb')]] }).outcome, 'stale');
  assert.equal(standaloneRecord(provider, request, row, { id: '가서', input_digest: sha256Digest('가서'), status: 'ok', analyses: [[{ lemma: 1, pos: 'verb' }]] }).outcome, 'error');
});
import { analysisInputDigest as sha256Digest } from '../scripts/intake/pipeline.mjs';

// ---- committed #274 artifacts (always run; no runtime or corpus needed) ----
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const outcomes = read('docs/audits/issue-274-analyzer-benchmark-outcomes.json');
const adjudication = read('docs/audits/issue-274-analyzer-benchmark-adjudication.json');

test('committed outcomes keep the exact cohort and the original overlapping-hold arithmetic', () => {
  assert.equal(outcomes.rows.length, 500);
  assert.deepEqual(outcomes.rows.map((row) => row.id), Array.from({ length: 500 }, (_, i) => `C000001-${String(i + 1).padStart(4, '0')}`));
  assert.equal(new Set(outcomes.rows.map((row) => row.lemma)).size, BASELINE.distinct_lemmas);
  const counts = {};
  outcomes.rows.forEach((row) => row.holds.forEach((hold) => { counts[hold] = (counts[hold] ?? 0) + 1; }));
  assert.deepEqual(counts, BASELINE.hold_counts);
  assert.equal(outcomes.rows.filter((row) => row.holds.length > 0).length, BASELINE.held_rows);
  assert.ok(outcomes.rows.reduce((total, row) => total + row.holds.length, 0) > BASELINE.held_rows, 'categories overlap; they do not sum to held rows');
  for (const row of outcomes.rows) {
    assert.deepEqual([...new Set([...row.upstream_holds, ...row.kiwi_holds])].sort(), [...row.holds].sort(), `${row.id}: original holds = upstream ∪ Kiwi-derived`);
    assert.ok(row.kiwi_holds.every((hold) => row.holds.includes(hold)));
  }
  assert.equal(outcomes.baseline.commit, BASELINE.commit);
  assert.equal(outcomes.baseline.candidates_sha256, BASELINE.candidates_sha256);
  assert.deepEqual(outcomes.orders.map((order) => order.order), [['kiwi'], ['kiwi', 'khaiii', 'mecab'], ['kiwi', 'mecab', 'khaiii']]);
  for (const id of PROVIDER_IDS) assert.equal(outcomes.providers[id].identity.provider_id, id);
});

test('committed orders never lose holds, skip needed calls, or treat best-only as resolved', () => {
  const [kiwiOnly, ...fallbacks] = outcomes.orders;
  const baselineHeld = new Set(outcomes.rows.filter((row) => row.holds.length > 0).map((row) => row.id));
  for (const order of outcomes.orders) {
    assert.equal(order.per_id.length, 500);
    for (const entry of order.per_id) {
      const row = outcomes.rows.find((candidate) => candidate.id === entry.candidate_id);
      assert.ok(row.upstream_holds.every((hold) => entry.holds.includes(hold)), `${entry.candidate_id}: upstream holds preserved`);
      if (baselineHeld.has(entry.candidate_id)) assert.ok(entry.holds.length > 0, `${entry.candidate_id}: a held row is never silently cleared`);
      if (entry.state === 'apparent_resolved') assert.ok(!entry.holds.some((hold) => hold.startsWith('analysis_')), entry.candidate_id);
    }
  }
  for (const order of fallbacks) {
    const eligible = new Set(['analysis_missing', 'analysis_unsupported', 'analysis_error', 'analysis_stale', 'analysis_ambiguous']);
    const byId = new Map(outcomes.rows.map((row) => [row.id, row]));
    const expected = kiwiOnly.per_id.map((entry) => byId.get(entry.candidate_id))
      .filter((row) => row.kiwi_holds.length > 0 && row.kiwi_holds.every((hold) => eligible.has(hold))).map((row) => row.id);
    assert.deepEqual([...order.reached[order.order[1]]].sort(), expected.sort(), 'the second provider is asked about exactly the usages Kiwi left held only with fallback-eligible holds (no skipped, no extra call)');
    for (const entry of order.per_id.filter((candidate) => candidate.providers_asked.length > 1)) assert.notEqual(entry.state, 'apparent_resolved', 'a best-only fallback never resolves');
    assert.ok(order.calls.kiwi.calls === 1 && order.calls[order.order[1]].calls === 1);
  }
});

test('committed adjudication matches the predeclared sample and the report is current', () => {
  const sampleIds = outcomes.sample.sample.map((entry) => entry.candidate_id);
  validateAdjudication(adjudication.decisions, outcomes.sample.sample);
  assert.equal(sampleIds.length, 85);
  assert.equal(outcomes.sample.seed, SAMPLE_SEED);
  assert.deepEqual(selectSample(outcomes.rows.map((row) => ({ candidate_id: row.id, stratum: row.stratum }))).sample, outcomes.sample.sample, 'the sample is reproducible from the rows');
  assert.match(adjudication.method, /AI self-check/u);
  assert.ok(adjudication.decisions.every((decision) => decision.status !== 'verified'), 'no independent adjudication exists, so nothing is verified');
  const summary = buildSummary(outcomes, adjudication);
  assert.equal(summary.adjudication.independently_verified, 0);
  assert.equal(summary.adjudication.ai_self_check + summary.adjudication.truth_unknown, 85);
  for (const id of PROVIDER_IDS) {
    const counts = summary.adjudication.providers[id];
    assert.equal(counts.verified_correct + counts.verified_wrong, 0, 'self-check records never enter verified statistics');
    assert.equal(counts.verified_precision, null);
    assert.ok(counts.self_check_correct + counts.self_check_wrong > 0);
  }
  assert.equal(summary.hypothetical_agreement_rule.proposal_independently_verified, 0);
  assert.equal(readFileSync('docs/audits/issue-274-analyzer-benchmark.md', 'utf8'), renderReport(summary, outcomes), 'run: node scripts/factory/benchmark-analyzers.mjs report');
  assert.equal(summary.baseline.analysis_ambiguous_rows, 434);
  assert.equal(summary.order_gain_vs_kiwi_only.every((entry) => entry.apparent_resolved_gain === 0), true);
});

test('stored baseline snapshot verifies from its own bytes (always runs; no dependence on the PR #270 branch)', () => {
  const text = (name) => readFileSync(`docs/audits/issue-274-baseline/${name}`, 'utf8');
  const rows = verifyBaseline({ manifestText: text('manifest.json'), candidatesText: text('candidates.jsonl') });
  assert.equal(rows.length, 500);
  assert.deepEqual(rows.map((row) => row.candidate_id), outcomes.rows.map((row) => row.id));
  assert.deepEqual(rows.map((row) => row.holds), outcomes.rows.map((row) => row.holds));
});

test('real baseline bytes from the recorded commit verify (skipped when the commit is not local)', (context) => {
  let manifestText;
  let candidatesText;
  try {
    manifestText = execFileSync('git', ['show', `${BASELINE.commit}:${BASELINE.manifest_path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    candidatesText = execFileSync('git', ['show', `${BASELINE.commit}:${BASELINE.candidates_path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    context.skip(`baseline commit ${BASELINE.commit} is not available locally`);
    return;
  }
  assert.equal(verifyBaseline({ manifestText, candidatesText }).length, 500);
});
