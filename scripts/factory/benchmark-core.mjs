import { createHash } from 'node:crypto';

import { normalizeProviderResult, toLegacyOutcome } from './analyzer-providers.mjs';
import { analysisInputDigest } from '../intake/pipeline.mjs';
import { resolveSurface, resolveWithProviders } from './stage1.mjs';

// Pure core of the fixed-cohort analyzer benchmark (issue #274). No runtime, corpus or filesystem
// access: everything here is deterministic over the frozen baseline rows and provider outputs, so
// the regressions can prove every fail-closed rule with synthetic fixtures. The runtime/CLI half is
// scripts/factory/benchmark-analyzers.mjs.

export const BENCHMARK_CONTRACT = 'analyzer-benchmark-v1';
export const PROVIDER_IDS = Object.freeze(['kiwi', 'khaiii', 'mecab']);
export const POLICY_ORDERS = Object.freeze([['kiwi'], ['kiwi', 'khaiii', 'mecab'], ['kiwi', 'mecab', 'khaiii']]);
export const ANALYSIS_HOLDS = Object.freeze(['analysis_ambiguous', 'analysis_unsupported', 'analysis_error', 'analysis_stale', 'analysis_missing', 'analysis_mismatch']);

// Owner decision (2026-10-04): PR #270 is closed unmerged; its immutable head commit is the baseline.
// Every value below is verified from the committed bytes, never taken from PR prose.
export const BASELINE = Object.freeze({
  pull_request: 270,
  commit: '3890edb7e64644ccfd9fac35d68f5e54d95f7965',
  master_sha_at_production: '6a188da03399b63fd51e88eb153f44fa7b4546ce',
  batch_id: 'C000001',
  manifest_path: 'data/candidates/C000001/manifest.json',
  candidates_path: 'data/candidates/C000001/candidates.jsonl',
  manifest_sha256: '117167fdee5c53b13e173026926306340e47909ba17e1dd26fc91dd1acb31a09',
  candidates_sha256: '0747b04fe14cb8b70ec21cb4cb49d000694e4ed4f7a5b21fb0ad79b55379e047',
  source_evidence_sha256: '0627825b8395be56cdcaf2a0e3eea719da6d88b6c3204c76955cb923154db108',
  source_snapshot: 'corpus:50dd0c6c4ecb9250e75c11dde9e854e1b39de14e12d7a7087d2da041d75ef211:c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd',
  analyzer_digest: '6aba30c7f4357010824c9da5fe6d91663ff8dc7d15345325a16c032e35d2b7bd',
  analyzer_version: 'kiwipiepy==0.24.0',
  usage_rows: 500,
  distinct_lemmas: 191,
  held_rows: 451,
  unheld_rows: 49,
  hold_counts: Object.freeze({ analysis_ambiguous: 434, lemma_mismatch: 57, analysis_unsupported: 23, coverage_collision: 15, pos_mismatch: 5 }),
});

export class BenchmarkError extends Error {
  constructor(errors) {
    super(errors.join('\n'));
    this.name = 'BenchmarkError';
    this.errors = errors;
  }
}

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sorted = (values) => [...values].sort(compare);
const countBy = (values) => values.reduce((counts, value) => { counts[value] = (counts[value] ?? 0) + 1; return counts; }, {});

// Verifies the immutable cohort from its bytes and returns the usage rows. Any deviation is an
// error: the benchmark never adjusts the denominator.
export function verifyBaseline({ manifestText, candidatesText }, pins = BASELINE) {
  const errors = [];
  if (sha256(manifestText) !== pins.manifest_sha256) errors.push(`manifest.json sha256 ${sha256(manifestText)} is not the pinned ${pins.manifest_sha256}`);
  if (sha256(candidatesText) !== pins.candidates_sha256) errors.push(`candidates.jsonl sha256 ${sha256(candidatesText)} is not the pinned ${pins.candidates_sha256}`);
  let manifest = {};
  try { manifest = JSON.parse(manifestText); } catch { errors.push('manifest.json is not valid JSON'); }
  for (const [key, expected] of [['batch_id', pins.batch_id], ['candidates_sha256', pins.candidates_sha256], ['source_evidence_sha256', pins.source_evidence_sha256],
    ['source_snapshot', pins.source_snapshot], ['analyzer_digest', pins.analyzer_digest], ['analyzer_version', pins.analyzer_version], ['candidate_count', pins.usage_rows]]) {
    if (manifest[key] !== expected) errors.push(`manifest ${key} ${manifest[key] ?? 'missing'} is not ${expected}`);
  }
  const lines = candidatesText.split('\n').filter((line) => line !== '');
  let rows = [];
  try { rows = lines.map((line) => JSON.parse(line)); } catch { errors.push('candidates.jsonl contains an invalid row'); }
  if (rows.length !== pins.usage_rows) errors.push(`expected exactly ${pins.usage_rows} v1 usage rows, found ${rows.length}`);
  rows.forEach((row, index) => {
    const expectedId = `${pins.batch_id}-${String(index + 1).padStart(4, '0')}`;
    if (row.candidate_id !== expectedId) errors.push(`row ${index + 1}: candidate_id ${row.candidate_id} is not ${expectedId}`);
    if (!Array.isArray(row.observedForms) || row.observedForms.length !== 1) errors.push(`${row.candidate_id}: a v1 usage row has exactly one observed form`);
    if (!Array.isArray(row.holds) || !Array.isArray(row.evidence) || row.evidence.length !== 2) errors.push(`${row.candidate_id}: malformed holds/evidence`);
  });
  if (errors.length === 0) {
    const lemmas = new Set(rows.map((row) => row.input)).size;
    if (lemmas !== pins.distinct_lemmas) errors.push(`distinct lemmas ${lemmas} is not ${pins.distinct_lemmas}`);
    const held = rows.filter((row) => row.holds.length > 0).length;
    if (held !== pins.held_rows || rows.length - held !== pins.unheld_rows) errors.push(`held/unheld ${held}/${rows.length - held} is not ${pins.held_rows}/${pins.unheld_rows}`);
    const holdCounts = countBy(rows.flatMap((row) => row.holds));
    if (JSON.stringify(Object.fromEntries(sorted(Object.keys(holdCounts)).map((key) => [key, holdCounts[key]])))
      !== JSON.stringify(Object.fromEntries(sorted(Object.keys(pins.hold_counts)).map((key) => [key, pins.hold_counts[key]])))) {
      errors.push(`hold counts ${JSON.stringify(holdCounts)} differ from ${JSON.stringify(pins.hold_counts)}`);
    }
    if (new Set(rows.map((row) => row.observedForms[0])).size !== rows.length) errors.push('observed surfaces are not unique (per-surface results would not map one-to-one)');
  }
  if (errors.length) throw new BenchmarkError(errors);
  return rows;
}

export const observationOf = (row, holds = []) => ({ surface: row.observedForms[0], hint: { input: row.input, pos: row.pos }, holds, ref: row.evidence[0] });

// Kiwi replays the original analysis hold arithmetic. Original holds H = upstream (extractor,
// coverage) U ∪ Kiwi-derived K. K must be a subset of H (otherwise Kiwi, its model or the cohort
// changed); U = H − K is preserved by every policy and never cleared by any provider. When
// `analysis_ambiguous` is in both K and H the extractor may independently hold it: that is
// indeterminate from text-free data, so it is flagged and bounded rather than guessed.
export function replayUpstreamHolds(rows, kiwiResolutions) {
  const errors = [];
  const replay = rows.map((row, index) => {
    const kiwiHolds = kiwiResolutions[index].holds;
    const extra = kiwiHolds.filter((hold) => !row.holds.includes(hold));
    if (extra.length) errors.push(`${row.candidate_id}: Kiwi replay holds ${extra.join(',')} absent from the baseline (runtime or model drift)`);
    return { upstream: sorted(row.holds.filter((hold) => !kiwiHolds.includes(hold))), kiwiHolds: sorted(kiwiHolds),
      ambiguityOriginIndeterminate: kiwiHolds.includes('analysis_ambiguous') && row.holds.includes('analysis_ambiguous') };
  });
  if (errors.length) throw new BenchmarkError(errors);
  return replay;
}

const pathSignature = (path) => path.map((item) => `${item.lemma}/${item.pos}`).join('+');

// One provider's standalone reading of one surface, text-free, from the normalized result.
export function standaloneRecord(provider, request, row, raw) {
  const normalized = normalizeProviderResult(provider, request, raw);
  const resolved = resolveSurface(request.text, { input: row.input, pos: row.pos }, toLegacyOutcome(normalized));
  const best = normalized.outcome === 'success' ? normalized.analyses[0] : [];
  return {
    outcome: normalized.outcome,
    n_analyses: normalized.analyses.length,
    best: pathSignature(best),
    hint_in_best: best.some((item) => item.lemma === row.input && item.pos === row.pos),
    derived: best.some((item) => item.derived_from !== undefined),
    hint_resolution: { lemma: resolved.lemma, pos: resolved.pos, holds: sorted(resolved.holds) },
  };
}

// Comparison class of the three standalone readings. Only a successful reading is comparable; a
// signature match is agreement on the normalized segmentation, never proof of meaning.
export function agreementClass(readings) {
  const [kiwi, khaiii, mecab] = PROVIDER_IDS.map((id) => readings[id]);
  if ([kiwi, khaiii, mecab].some((reading) => reading.outcome !== 'success')) return 'incomparable_unsupported_or_error';
  const same = (a, b) => a.best === b.best;
  if (same(kiwi, khaiii) && same(khaiii, mecab)) return 'all_agree';
  if (same(kiwi, khaiii)) return 'one_vs_two_mecab_differs';
  if (same(kiwi, mecab)) return 'one_vs_two_khaiii_differs';
  if (same(khaiii, mecab)) return 'one_vs_two_kiwi_differs';
  return 'three_way_disagreement';
}
export const pairAgreement = (a, b) => a.outcome === 'success' && b.outcome === 'success' && a.best === b.best;

// Production policy simulation: the real resolveWithProviders over the unchanged observations with
// the preserved upstream holds. Providers are wrapped to count calls and requested surfaces.
export function instrument(provider, clock = () => performance.now()) {
  const stats = { calls: 0, surfaces: 0, elapsed_ms: 0, requested: [] };
  return {
    stats,
    provider: { ...provider, analyze: async (requests) => {
      stats.calls += 1;
      stats.surfaces += requests.length;
      stats.requested.push(requests.map((request) => request.text));
      const start = clock();
      try { return await provider.analyze(requests); } finally { stats.elapsed_ms += clock() - start; }
    } },
  };
}

export async function simulateOrder({ order, rows, replay, providers, clock }) {
  const wrapped = order.map((id) => instrument(providers[id], clock));
  const observations = rows.map((row, index) => observationOf(row, replay[index].upstream));
  const started = (clock ?? (() => performance.now()))();
  const { resolutions, attemptLog } = await resolveWithProviders({ observations, providers: wrapped.map((entry) => entry.provider) });
  const wall_ms = (clock ?? (() => performance.now()))() - started;
  const reached = Object.fromEntries(order.map((id) => [id, new Set()]));
  const digestToId = new Map(rows.map((row) => [analysisInputDigest(row.observedForms[0]), row.candidate_id]));
  for (const entry of attemptLog) reached[entry.provider_id].add(digestToId.get(entry.input_digest));
  const attemptsByRow = new Map();
  for (const entry of attemptLog) {
    const id = digestToId.get(entry.input_digest);
    attemptsByRow.set(id, [...(attemptsByRow.get(id) ?? []), { provider: entry.provider_id, outcome: entry.outcome, state: entry.state }]);
  }
  const perId = rows.map((row, index) => {
    const final = sorted(new Set([...replay[index].upstream, ...resolutions[index].holds]));
    const analysisHolds = final.filter((hold) => ANALYSIS_HOLDS.includes(hold));
    const attempts = attemptsByRow.get(row.candidate_id) ?? [];
    const last = attempts.at(-1);
    return {
      candidate_id: row.candidate_id,
      holds: final,
      providers_asked: attempts.map((attempt) => attempt.provider),
      state: analysisHolds.length === 0 ? 'apparent_resolved' : attempts.some((attempt) => attempt.state === 'needs_verification') ? 'needs_verification' : 'unresolved',
      stop_reason: last ? stopReason(last, order, analysisHolds) : 'no_provider_asked',
      lemma: resolutions[index].lemma,
      pos: resolutions[index].pos,
    };
  });
  return { order, perId, calls: Object.fromEntries(order.map((id, i) => [id, { calls: wrapped[i].stats.calls, surfaces: wrapped[i].stats.surfaces, elapsed_ms: round(wrapped[i].stats.elapsed_ms) }])),
    reached: Object.fromEntries(order.map((id) => [id, sorted(reached[id])])), wall_ms: round(wall_ms), requested: Object.fromEntries(order.map((id, i) => [id, wrapped[i].stats.requested])) };
}

const round = (value) => Math.round(value * 100) / 100;
const round3 = (value) => Math.round(value * 1000) / 1000;
function stopReason(last, order, analysisHolds) {
  if (analysisHolds.length === 0) return 'resolved_by_n_best_provider';
  if (last.provider === order.at(-1)) return 'providers_exhausted';
  return `final_hold_${analysisHolds.join('+') || 'none'}`;
}

// Summary of one order against the baseline arithmetic. Reason categories overlap, so category
// counts never sum to the held-row count.
export function summarizeOrder(simulation, rows) {
  const holdsOf = new Map(simulation.perId.map((entry) => [entry.candidate_id, entry.holds]));
  const heldRows = rows.filter((row) => (holdsOf.get(row.candidate_id) ?? []).length > 0).length;
  const baselineAmbiguous = rows.filter((row) => row.holds.includes('analysis_ambiguous'));
  return {
    order: simulation.order,
    states: countBy(simulation.perId.map((entry) => entry.state)),
    held_rows: heldRows,
    no_hold_rows: rows.length - heldRows,
    hold_category_counts: countBy(simulation.perId.flatMap((entry) => entry.holds)),
    baseline_ambiguous_reaching: Object.fromEntries(simulation.order.map((id) => [id, baselineAmbiguous.filter((row) => simulation.reached[id].includes(row.candidate_id)).length])),
    calls: simulation.calls,
    wall_ms: simulation.wall_ms,
    stop_reasons: countBy(simulation.perId.map((entry) => entry.stop_reason)),
  };
}

// ---------- adjudication sample ----------

export const SAMPLE_SEED = 'issue-274-v1';
export const STRATUM_QUOTA = 10;
export const STRATUM_ORDER = Object.freeze(['baseline_unheld_control', 'unsupported_or_error', 'lemma_pos_mismatch_or_derivation', 'three_way_disagreement',
  'one_vs_two_mecab_differs', 'one_vs_two_khaiii_differs', 'one_vs_two_kiwi_differs', 'all_agree_kiwi_ambiguous', 'all_agree_kiwi_clean', 'other']);

// Each row has exactly one primary stratum (first match), so quotas and denominators are unambiguous.
export function strataOf(row, readings, kiwiHolds) {
  if (row.holds.length === 0) return 'baseline_unheld_control';
  const cls = agreementClass(readings);
  if (cls === 'incomparable_unsupported_or_error') return 'unsupported_or_error';
  if (row.holds.some((hold) => hold === 'lemma_mismatch' || hold === 'pos_mismatch') || PROVIDER_IDS.some((id) => readings[id].derived)) return 'lemma_pos_mismatch_or_derivation';
  if (cls === 'all_agree') return kiwiHolds.includes('analysis_ambiguous') ? 'all_agree_kiwi_ambiguous' : 'all_agree_kiwi_clean';
  return STRATUM_ORDER.includes(cls) ? cls : 'other';
}

export function selectSample(entries, { seed = SAMPLE_SEED, quota = STRATUM_QUOTA } = {}) {
  const byStratum = new Map(STRATUM_ORDER.map((stratum) => [stratum, []]));
  for (const entry of entries) byStratum.get(entry.stratum).push(entry.candidate_id);
  const strata = {};
  const sample = [];
  for (const [stratum, ids] of byStratum) {
    const ranked = [...ids].sort((a, b) => compare(sha256(`${seed}|${stratum}|${a}`), sha256(`${seed}|${stratum}|${b}`)) || compare(a, b));
    const picked = ranked.slice(0, quota);
    strata[stratum] = { size: ids.length, sampled: picked.length };
    sample.push(...picked.map((candidate_id) => ({ candidate_id, stratum })));
  }
  return { seed, quota, strata, sample };
}

// Wilson score interval (95%); small samples give wide, honest bounds.
export function wilson(successes, total, z = 1.959964) {
  if (total === 0) return { low: null, high: null };
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { low: round3(Math.max(0, center - margin)), high: round3(Math.min(1, center + margin)) };
}

// ---------- adjudication → verified labels ----------

// `verified` is reserved for an independent, evidence-bound, analyzer-blind adjudication and must carry
// that provenance. An AI self-check is recorded as `ai_self_check` and is never promoted to `verified`.
const TRUTH_STATUS = Object.freeze(['verified', 'ai_self_check', 'truth_unknown']);
const PROVENANCE_ROLES = Object.freeze(['human_editor', 'independent_reviewer']);
export function validateAdjudication(decisions, sample) {
  const errors = [];
  const wanted = new Set(sample.map((entry) => entry.candidate_id));
  const seen = new Set();
  for (const decision of decisions) {
    if (!wanted.has(decision.candidate_id)) errors.push(`${decision.candidate_id}: not in the predeclared sample`);
    if (seen.has(decision.candidate_id)) errors.push(`${decision.candidate_id}: decided twice`);
    seen.add(decision.candidate_id);
    if (!TRUTH_STATUS.includes(decision.status)) errors.push(`${decision.candidate_id}: status must be one of ${TRUTH_STATUS.join('|')}`);
    if (decision.status !== 'truth_unknown' && !(typeof decision.truth?.lemma === 'string' && typeof decision.truth?.pos === 'string')) errors.push(`${decision.candidate_id}: ${decision.status} needs truth {lemma,pos}`);
    if (decision.status === 'verified') {
      const provenance = decision.provenance;
      if (!(provenance && PROVENANCE_ROLES.includes(provenance.adjudicator_role) && provenance.independent === true && provenance.analyzer_blind === true
        && provenance.evidence_access === 'authorized_original_context')) errors.push(`${decision.candidate_id}: verified requires independent, analyzer-blind provenance with authorized original-context access`);
    }
    if (decision.status === 'truth_unknown' && decision.truth) errors.push(`${decision.candidate_id}: truth_unknown must not carry a truth`);
  }
  for (const id of wanted) if (!seen.has(id)) errors.push(`${id}: sampled but not adjudicated`);
  if (errors.length) throw new BenchmarkError(errors);
}

// Label of one reading against the independently recorded truth. A best-only single path is never
// certainty: without a truth the label is truth_unknown, never verified_correct.
export function verifiedLabel(record, decision) {
  if (record.outcome !== 'success' || record.best === '') return 'unsupported';
  if (!decision || decision.status === 'truth_unknown') return 'truth_unknown';
  const correct = readingContainsTruth(record.best, decision.truth);
  if (decision.status === 'ai_self_check') return correct ? 'self_check_correct' : 'self_check_wrong';
  return correct ? 'verified_correct' : 'verified_wrong';
}
// A derived predicate (가장하다) is also correctly explained by its recorded root (가장/noun).
export function readingContainsTruth(bestSignature, truth) {
  const parts = bestSignature.split('+');
  return parts.includes(`${truth.lemma}/${truth.pos}`) || (truth.root !== undefined && parts.includes(`${truth.root.lemma}/${truth.root.pos}`));
}

// ---------- summary ----------

const tally = (labels) => Object.fromEntries(['verified_correct', 'verified_wrong', 'self_check_correct', 'self_check_wrong', 'truth_unknown', 'unsupported'].map((label) => [label, labels.filter((value) => value === label).length]));
// Independently verified precision and AI self-check agreement are separate figures; the former is
// null (never computed from self-check records) unless independent verification exists.
const precision = (counts) => {
  const verified = counts.verified_correct + counts.verified_wrong;
  const checked = counts.self_check_correct + counts.self_check_wrong;
  return { ...counts, verified_precision: verified === 0 ? null : round3(counts.verified_correct / verified), verified_wilson95: wilson(counts.verified_correct, verified),
    self_check_agreement: checked === 0 ? null : round3(counts.self_check_correct / checked), self_check_wilson95: wilson(counts.self_check_correct, checked) };
};

// Every number the audit report states is computed here from the two committed files.
export function buildSummary(outcomes, adjudication) {
  const rows = outcomes.rows;
  const decisions = new Map(adjudication.decisions.map((decision) => [decision.candidate_id, decision]));
  validateAdjudication(adjudication.decisions, outcomes.sample.sample);
  const baseline = outcomes.baseline;
  const standalone = Object.fromEntries(PROVIDER_IDS.map((id) => {
    const readings = rows.map((row) => row.readings[id]);
    return [id, { success_nonempty: readings.filter((r) => r.outcome === 'success' && r.best !== '').length, unsupported_or_empty: readings.filter((r) => r.outcome !== 'success' || r.best === '').length,
      errors: readings.filter((r) => r.outcome === 'error').length, hint_in_best: readings.filter((r) => r.hint_in_best).length, with_n_best_alternatives: readings.filter((r) => r.n_analyses > 1).length,
      derived: readings.filter((r) => r.derived).length }];
  }));
  const pairs = { kiwi_khaiii: 0, kiwi_mecab: 0, khaiii_mecab: 0 };
  for (const row of rows) {
    pairs.kiwi_khaiii += pairAgreement(row.readings.kiwi, row.readings.khaiii) ? 1 : 0;
    pairs.kiwi_mecab += pairAgreement(row.readings.kiwi, row.readings.mecab) ? 1 : 0;
    pairs.khaiii_mecab += pairAgreement(row.readings.khaiii, row.readings.mecab) ? 1 : 0;
  }
  const orders = outcomes.orders.map((order) => ({ ...summarizeOrder({ order: order.order, perId: order.per_id, reached: order.reached, calls: order.calls, wall_ms: order.wall_ms }, rows.map((row) => ({ candidate_id: row.id, holds: row.holds }))),
    reachedDetail: undefined }));
  const sampled = rows.filter((row) => decisions.has(row.id));
  const labelsOf = (id, subset) => subset.map((row) => verifiedLabel({ ...row.readings[id] }, decisions.get(row.id)));
  const verifiedProvider = Object.fromEntries(PROVIDER_IDS.map((id) => [id, precision(tally(labelsOf(id, sampled)))]));
  const byStratum = {};
  for (const stratum of STRATUM_ORDER) {
    const subset = sampled.filter((row) => row.stratum === stratum);
    if (subset.length === 0) continue;
    byStratum[stratum] = { size: outcomes.sample.strata[stratum].size, sampled: subset.length, providers: Object.fromEntries(PROVIDER_IDS.map((id) => [id, precision(tally(labelsOf(id, subset)))])),
      proposed_confirmed: subset.filter((row) => decisions.get(row.id).reason_code === 'proposed_confirmed').length, truth_unknown: subset.filter((row) => decisions.get(row.id).status === 'truth_unknown').length };
  }
  // Hypothetical agreement rule (NOT implemented anywhere): among Kiwi-ambiguous rows where both
  // best-only providers contain the proposed lemma/POS, how often is the proposal actually right?
  const agreeing = sampled.filter((row) => row.kiwi_holds.includes('analysis_ambiguous') && row.readings.khaiii.hint_in_best && row.readings.mecab.hint_in_best);
  const hypothetical = { rows_in_sample: agreeing.length, ...precisionOfProposal(agreeing, decisions), kiwi_best_only_same_rows: precision(tally(labelsOf('kiwi', agreeing))) };
  const baselineAmbiguousRows = rows.filter((row) => row.holds.includes('analysis_ambiguous'));
  const agreeingPopulation = baselineAmbiguousRows.filter((row) => row.readings.khaiii.hint_in_best && row.readings.mecab.hint_in_best).length;
  const order0 = orders[0].states.apparent_resolved ?? 0;
  return {
    contract: 'analyzer-benchmark-summary-v1',
    baseline: { usage_rows: rows.length, distinct_lemmas: new Set(rows.map((row) => row.lemma)).size, held_rows: rows.filter((row) => row.holds.length > 0).length, unheld_rows: rows.filter((row) => row.holds.length === 0).length,
      analysis_ambiguous_rows: baselineAmbiguousRows.length, hold_counts: countBy(rows.flatMap((row) => row.holds)), pinned: baseline.hold_counts,
      ambiguity_origin_indeterminate_rows: rows.filter((row) => row.ambiguity_origin_indeterminate).length, upstream_hold_counts: countBy(rows.flatMap((row) => row.upstream_holds)) },
    standalone, pair_agreement: pairs, agreement_classes: countBy(rows.map((row) => row.agreement)), orders,
    order_gain_vs_kiwi_only: orders.slice(1).map((order) => ({ order: order.order, apparent_resolved_gain: (order.states.apparent_resolved ?? 0) - order0, held_rows_change: order.held_rows - orders[0].held_rows })),
    adjudication: { sampled: sampled.length, independently_verified: sampled.filter((row) => decisions.get(row.id).status === 'verified').length, ai_self_check: sampled.filter((row) => decisions.get(row.id).status === 'ai_self_check').length,
      truth_unknown: sampled.filter((row) => decisions.get(row.id).status === 'truth_unknown').length,
      proposed_confirmed: sampled.filter((row) => decisions.get(row.id).reason_code === 'proposed_confirmed').length, providers: verifiedProvider, by_stratum: byStratum },
    hypothetical_agreement_rule: { ...hypothetical, baseline_ambiguous_population_matching: agreeingPopulation },
    timing: outcomes.timing,
  };
}

function precisionOfProposal(subset, decisions) {
  const verified = subset.filter((row) => decisions.get(row.id).status !== 'truth_unknown');
  const confirmed = verified.filter((row) => decisions.get(row.id).reason_code === 'proposed_confirmed').length;
  return { proposal_self_checked: verified.length, proposal_confirmed: confirmed, proposal_self_check_agreement: verified.length ? round3(confirmed / verified.length) : null, proposal_wilson95: wilson(confirmed, verified.length),
    proposal_independently_verified: subset.filter((row) => decisions.get(row.id).status === 'verified').length };
}
