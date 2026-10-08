import { createHash } from 'node:crypto';

import { POS_VALUES, digest } from '../intake/candidate-contract.mjs';
import { analysisInputDigest } from '../intake/pipeline.mjs';
import { normalizeProviderResult, providerDescriptor } from './analyzer-providers.mjs';

// Ensemble Resolver v2 core (issue #285; docs/lexical-factory-ensemble-v2.md).
//
// Kiwi (ranked N-best), Khaiii (best only) and MeCab-ko (best only) are all run on the same complete
// unique-surface input set. This module compares NORMALIZED SURFACE-LEVEL morphological analysis paths
// of one observed eojeol; it never claims a contextual interpretation, sense identity or truth. Three
// correlated analyzers agreeing is a signal strength, not verified correctness and not a calibrated
// probability. It depends only on leaf modules so lemma-contract/contract can import its validators.

export const ENSEMBLE_POLICY = 'provider-resolution-v2-ensemble';
export const LEGACY_ENSEMBLE_CONTRACT = 'ensemble-resolution-v2';
export const ENSEMBLE_CONTRACT = 'ensemble-resolution-v3';
export const ENSEMBLE_PROVIDER_ORDER = Object.freeze(['kiwi', 'khaiii', 'mecab']);
export const PROPOSAL_CONTRACT_REQUIRED = 'derivation-root-v1';

export const CATEGORIES = Object.freeze(['concordant', 'supported_alternative', 'conflicted', 'unsupported_or_unknown']);
// Closed, stable vocabulary: a reason is never free text.
export const ENSEMBLE_REASONS = Object.freeze([
  'three_way_agreement', 'kiwi_alternative_supported', 'one_vs_two_disagreement', 'kiwi_isolated_pair', 'all_three_differ',
  'kiwi_unsupported_rival', 'segmentation_incompatible', 'no_single_target_morpheme', 'extractor_hint_mismatch',
  'unsupported_lemma_shape',
  'kiwi_unusable', 'khaiii_unusable', 'mecab_unusable', 'kiwi_reported_ambiguous', 'khaiii_reported_ambiguous', 'mecab_reported_ambiguous',
]);
export const SUPPORTERS = Object.freeze(['kiwi_alt', 'kiwi_top', 'khaiii', 'mecab']);
export const RESOLUTIONS = Object.freeze(['ensemble', 'context']);
export const PRIORITIES = Object.freeze(['verify_first', 'high', 'standard']);
// Only these categories assign an observation to a lemma by morphology alone.
export const ASSIGNING_CATEGORIES = Object.freeze(['concordant', 'supported_alternative']);
// Extractor holds that no morphological or contextual verdict may clear or bypass.
export const NON_BYPASSABLE_EXTRACTOR_HOLDS = Object.freeze(['coverage_collision', 'no_evidence']);

// Fallback is attempted only for a morphologically unassignable observation that has a located
// source paragraph and no extractor hold a verdict may not bypass. The extractor's own
// `analysis_ambiguous` is the one hold this authorized review path may judge (it stays on the
// observation for Stage 2). One shared predicate: the producer, validators and A/B metrics all use it.
export function fallbackBlockers(entry) {
  const blockers = [];
  for (const hold of entry.extractor_holds ?? []) if (hold !== 'analysis_ambiguous') blockers.push(hold);
  if (entry.evidence?.kind !== 'corpus-paragraph' || !/^[^#\s]+#[^#\s]+$/u.test(String(entry.evidence?.ref))) blockers.push('no_located_source');
  return [...new Set(blockers)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export class EnsembleError extends Error {
  constructor(errors) {
    super(`Ensemble resolver: ${errors.join('; ')}`);
    this.name = 'EnsembleError';
    this.errors = errors;
  }
}

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const KOREAN_WORD = /^[가-힣]+$/u;
const readingKey = (reading) => `${reading.lemma}\u0000${reading.pos}`;

// --- 1. Three Provider calls on the same complete unique-surface input -------------------------

// Every Provider analyzes the same sorted, deduplicated surfaces (dedup is per Provider only; results
// are later mapped back to every original observation). Anything that makes a Provider's answer
// untrustworthy for the production run fails the whole run closed — there is no partial success.
export async function runEnsembleProviders({ observations, providers, now = () => performance.now() }) {
  const ids = providers.map((provider) => provider.id);
  if (JSON.stringify(ids) !== JSON.stringify(ENSEMBLE_PROVIDER_ORDER)) {
    throw new EnsembleError([`the ensemble policy ${ENSEMBLE_POLICY} requires exactly the providers ${ENSEMBLE_PROVIDER_ORDER.join(',')} in that order, got ${ids.join(',') || 'none'}; it never degrades to fewer providers`]);
  }
  const surfaces = [...new Set(observations.map((observation) => observation.surface))].sort(compare);
  const requests = surfaces.map((surface) => ({ id: surface, text: surface }));
  const byProvider = new Map();
  const metadataByProvider = new Map();
  const calls = {};
  for (const provider of providers) {
    const started = now();
    let response;
    try {
      response = await provider.analyze(requests);
      provider.assertMetadata(response?.metadata);
    } catch (error) {
      throw new EnsembleError([`analyzer provider ${provider.id} failed closed: ${error.message}`]);
    }
    if (response.metadata.proposal_contract !== PROPOSAL_CONTRACT_REQUIRED) {
      throw new EnsembleError([`analyzer provider ${provider.id} proposal_contract ${response.metadata.proposal_contract ?? 'missing'} is not ${PROPOSAL_CONTRACT_REQUIRED}`]);
    }
    const list = Array.isArray(response.results) ? response.results : [];
    const wanted = new Set(surfaces);
    const returned = list.map((outcome) => outcome?.id);
    const problems = [];
    if (new Set(returned).size !== returned.length) problems.push('duplicate result ids');
    if (returned.some((id) => !wanted.has(id))) problems.push('results for surfaces that were not requested');
    if (surfaces.some((surface) => !returned.includes(surface))) problems.push('missing results for requested surfaces');
    const raw = new Map(list.map((outcome) => [outcome?.id, outcome]));
    // A well-formed explicit `unsupported`/`error`/`ambiguous` is data; an unknown status, a
    // self-contradicting response (`ok` without analyses, a refusal that carries analyses) or a
    // non-object entry is a broken Provider contract and fails the whole production run.
    for (const entry of list) {
      const problem = rawContractProblem(entry);
      if (problem) problems.push(problem);
    }
    const normalized = new Map(requests.map((request) => [request.id, normalizeProviderResult(provider, request, raw.get(request.id))]));
    for (const result of normalized.values()) {
      if (result.outcome === 'stale') problems.push('result input digest does not bind its surface');
      if (result.outcome === 'error' && result.diagnostics?.reason === 'malformed_analysis') problems.push('malformed analysis output');
    }
    if (problems.length) throw new EnsembleError([`analyzer provider ${provider.id} returned unusable coverage (${[...new Set(problems)].join('; ')}); production run failed closed`]);
    byProvider.set(provider.id, normalized);
    metadataByProvider.set(provider.id, response.metadata);
    calls[provider.id] = { surfaces: surfaces.length, observations: observations.length, ms: Math.round(now() - started) };
  }
  return { surfaces, byProvider, metadataByProvider, calls };
}

const RAW_STATUSES = ['ok', 'error', 'unsupported', 'ambiguous'];
function rawContractProblem(entry) {
  if (!isObject(entry)) return 'a non-object result entry';
  if (!RAW_STATUSES.includes(entry.status)) return `invalid result status ${JSON.stringify(entry.status)}`;
  const analyses = entry.analyses;
  if (entry.status === 'ok') return Array.isArray(analyses) && analyses.length > 0 ? null : 'status ok without usable analyses';
  return analyses === undefined || (Array.isArray(analyses) && analyses.length === 0) ? null : `status ${entry.status} that carries analyses`;
}

// --- 2. Per-observation adjudication -----------------------------------------------------------

// One provider path → the one reading it supports for this observation. A path with no single
// target morpheme proves nothing; an extra content morpheme the chosen reading does not explain
// (other than the one root the analyzer linked via derived_from_index) is incompatible segmentation.
function pathReading(path, hint) {
  if (!Array.isArray(path) || path.length === 0) return { reading: null, segmentation_ok: false, item: null };
  const target = path.find((item) => item.lemma === hint.input && (!hint.pos || item.pos === hint.pos))
    ?? path.find((item) => item.lemma === hint.input);
  const chosen = target ?? (path.length === 1 ? path[0] : null);
  if (!chosen) return { reading: null, segmentation_ok: false, item: null };
  const root = Number.isInteger(chosen.derived_from_index) ? path[chosen.derived_from_index] : undefined;
  const derivedBase = (item) => item === root && item.pos === 'noun' && item.form === chosen.derived_from && chosen.derived_from_index < path.indexOf(chosen);
  return { reading: { lemma: chosen.lemma, pos: chosen.pos }, segmentation_ok: !path.some((item) => item !== chosen && !derivedBase(item)), item: chosen };
}

// A lower-ranked Kiwi path that only re-segments the SAME stem is not a competing reading: either its
// content-morpheme forms concatenate to the chosen stem (짠 + 하다 for 짠하다), or it is a bare
// noun/adverb fragment that is a proper prefix of the chosen predicate stem (짠 for 짠하). Another
// complete lemma — a homograph such as 가/noun beside 가다, or 날다 beside 나 — is never filtered.
function isStemVariant(analysis, chosenItem) {
  if (!chosenItem) return false;
  const forms = analysis.map((item) => item.form);
  if (analysis.length >= 2 && forms.join('') === chosenItem.form && !analysis.some((item) => item.lemma === chosenItem.lemma)) return true;
  return analysis.length === 1 && ['noun', 'adverb'].includes(analysis[0].pos) && analysis[0].lemma === analysis[0].form
    && analysis[0].form.length < chosenItem.form.length && chosenItem.form.startsWith(analysis[0].form)
    && ['verb', 'adjective'].includes(chosenItem.pos) && chosenItem.lemma === `${chosenItem.form}다`;
}

// A ranked alternative explaining the form without the chosen lemma/POS with no more content
// morphemes, or the same lemma with another POS (the shared v1 definition of a competing reading),
// after stem re-segmentations are set aside.
const kiwiRival = (paths, chosen, chosenItem) => paths.slice(1).some((analysis) => analysis.length > 0
  && !isStemVariant(analysis, chosenItem)
  && !analysis.some((item) => item.lemma === chosen.lemma && item.pos === chosen.pos)
  && (analysis.some((item) => item.lemma === chosen.lemma) || analysis.length <= paths[0].length));

const sortedUnique = (values) => [...new Set(values)].sort(compare);

function collectHypotheses(top, kiwiAlternatives) {
  const map = new Map();
  const add = (reading, supporter) => {
    // The manifest hypothesis contract permits Hangul citation-form lemmas only. Invalid provider
    // readings remain bound by the trace and unresolved reason, but cannot enter typed hypotheses.
    if (!reading || !KOREAN_WORD.test(String(reading.lemma))) return;
    const entry = map.get(readingKey(reading)) ?? { lemma: reading.lemma, pos: reading.pos, supporters: new Set() };
    entry.supporters.add(supporter);
    map.set(readingKey(reading), entry);
  };
  add(top.kiwi, 'kiwi_top');
  add(top.khaiii, 'khaiii');
  add(top.mecab, 'mecab');
  kiwiAlternatives.forEach((reading) => add(reading, 'kiwi_alt'));
  return [...map.values()].map((entry) => ({ lemma: entry.lemma, pos: entry.pos, supporters: [...entry.supporters].sort(compare) }))
    .sort((a, b) => compare(a.lemma, b.lemma) || compare(a.pos, b.pos));
}

// results: { kiwi, khaiii, mecab } normalized provider results for the observed surface.
export function classifyObservation({ hint, results }) {
  const reasons = [];
  const finish = (category, extra = {}) => ({ category, reasons: sortedUnique(reasons), assigned: null, rivals: [], hypotheses: [], paths: {}, ...extra });
  const ambiguous = ENSEMBLE_PROVIDER_ORDER.filter((id) => results[id].outcome === 'ambiguous');
  const unusable = ENSEMBLE_PROVIDER_ORDER.filter((id) => !['success', 'ambiguous'].includes(results[id].outcome));
  const usable = (id) => results[id].outcome === 'success';
  const kiwiPaths = usable('kiwi') ? results.kiwi.analyses : [];
  const readings = { kiwi: pathReading(kiwiPaths[0], hint), khaiii: usable('khaiii') ? pathReading(results.khaiii.analyses[0], hint) : { reading: null }, mecab: usable('mecab') ? pathReading(results.mecab.analyses[0], hint) : { reading: null } };
  const kiwiAlt = kiwiPaths.slice(1).map((path) => pathReading(path, hint)).filter((entry) => entry.reading && entry.segmentation_ok).map((entry) => entry.reading);
  const top = { kiwi: readings.kiwi.reading, khaiii: readings.khaiii.reading, mecab: readings.mecab.reading };
  const unsupportedLemmaShape = [top.kiwi, top.khaiii, top.mecab, ...kiwiAlt]
    .some((reading) => reading && !KOREAN_WORD.test(String(reading.lemma)));
  const hypotheses = collectHypotheses(top, kiwiAlt);
  const trace = { kiwi_top: top.kiwi, khaiii: top.khaiii, mecab: top.mecab, kiwi_alternatives: kiwiAlt };
  // A structurally valid analyzer response may still be outside the Hangul lemma model.
  if (unsupportedLemmaShape) reasons.push('unsupported_lemma_shape');
  if (ambiguous.length) {
    ambiguous.forEach((id) => reasons.push(`${id}_reported_ambiguous`));
    unusable.forEach((id) => reasons.push(`${id}_unusable`));
    return finish('conflicted', { hypotheses, trace });
  }
  if (unusable.length) {
    unusable.forEach((id) => reasons.push(`${id}_unusable`));
    return finish('unsupported_or_unknown', { hypotheses, trace });
  }
  if (unsupportedLemmaShape) return finish('unsupported_or_unknown', { hypotheses, trace });
  if (ENSEMBLE_PROVIDER_ORDER.some((id) => !readings[id].reading)) {
    reasons.push('no_single_target_morpheme');
    return finish('conflicted', { hypotheses, trace });
  }
  if (ENSEMBLE_PROVIDER_ORDER.some((id) => !readings[id].segmentation_ok)) {
    reasons.push('segmentation_incompatible');
    return finish('conflicted', { hypotheses, trace });
  }
  const tops = [top.kiwi, top.khaiii, top.mecab];
  const votes = (reading) => tops.filter((other) => readingKey(other) === readingKey(reading)).length;
  const hintMismatch = (assigned) => {
    if (assigned.lemma !== hint.input || (hint.pos && assigned.pos !== hint.pos)) reasons.push('extractor_hint_mismatch');
  };
  const assignedHolds = (assigned, holds) => {
    hintMismatch(assigned);
    if (assigned.lemma !== hint.input) holds.push('lemma_mismatch');
    else if (hint.pos && assigned.pos !== hint.pos) holds.push('pos_mismatch');
    return holds;
  };
  const rivalsFor = (assigned) => hypotheses.filter((entry) => readingKey(entry) !== readingKey(assigned));
  if (votes(top.kiwi) === 3) {
    if (kiwiRival(kiwiPaths, top.kiwi, readings.kiwi.item)) {
      reasons.push('kiwi_unsupported_rival');
      return finish('conflicted', { hypotheses, trace });
    }
    reasons.push('three_way_agreement');
    return finish('concordant', { assigned: top.kiwi, holds: assignedHolds(top.kiwi, []), hypotheses, rivals: [], trace });
  }
  // A non-primary Kiwi N-best reading that another provider also proposes.
  const supportedAlt = kiwiAlt.filter((reading) => readingKey(reading) !== readingKey(top.kiwi) && votes(reading) >= 1)
    .sort((a, b) => votes(b) - votes(a) || kiwiAlt.indexOf(a) - kiwiAlt.indexOf(b))[0];
  if (supportedAlt && (votes(supportedAlt) === 2 || votes(top.kiwi) === 2)) {
    const assigned = votes(supportedAlt) === 2 ? supportedAlt : top.kiwi;
    reasons.push('kiwi_alternative_supported');
    // The unsettled rival keeps a reviewable hold: this is review priority, never approval.
    return finish('supported_alternative', { assigned, holds: assignedHolds(assigned, ['analysis_ambiguous']), hypotheses, rivals: rivalsFor(assigned), trace });
  }
  reasons.push(votes(top.kiwi) === 2 ? 'one_vs_two_disagreement' : votes(top.khaiii) === 2 ? 'kiwi_isolated_pair' : 'all_three_differ');
  return finish('conflicted', { hypotheses, trace });
}

// The manifest-level unresolved holds of an unassigned observation (never a lemma/POS guess).
export function unresolvedHoldsFor(decision, providerResults) {
  if (decision.category === 'conflicted') return ['analysis_ambiguous'];
  const outcomes = ENSEMBLE_PROVIDER_ORDER.map((id) => providerResults[id].outcome);
  if (outcomes.includes('missing')) return ['analysis_missing'];
  if (outcomes.includes('error')) return ['analysis_error'];
  return ['analysis_unsupported'];
}

export const observationDigestOf = (observation) => digest(['ensemble-observation', observation.surface, observation.ref.kind, observation.ref.ref,
  observation.group ?? '', observation.hint?.input ?? '', observation.hint?.pos ?? '']);

// Text-free decision trace: surface digest, extractor hint/holds, the Kiwi ranked paths and the
// best-only readings, the category and its reasons. It carries no corpus snippet or paragraph text.
export function buildTrace({ observation, results, decision }) {
  const slim = (path) => path.map((item) => ({ lemma: item.lemma, pos: item.pos, form: item.form,
    ...(item.derived_from === undefined ? {} : { derived_from: item.derived_from, derived_from_index: item.derived_from_index }) }));
  return {
    contract: ENSEMBLE_CONTRACT,
    surface_digest: analysisInputDigest(observation.surface),
    extractor_hint: { lemma: observation.hint?.input ?? null, pos: observation.hint?.pos ?? null },
    extractor_holds: sortedUnique(observation.holds ?? []),
    providers: Object.fromEntries(ENSEMBLE_PROVIDER_ORDER.map((id) => [id, { outcome: results[id].outcome, identity_digest: results[id].identity_digest,
      paths: results[id].analyses.slice(0, id === 'kiwi' ? 8 : 1).map(slim) }])),
    readings: decision.trace,
    category: decision.category,
    reasons: decision.reasons,
    // Holds the observation carries from the extractor and (for an assigned reading) from the ensemble.
    observation_holds: sortedUnique([...(observation.holds ?? []), ...(ASSIGNING_CATEGORIES.includes(decision.category) ? decision.holds : [])]),
  };
}
export const traceDigest = (trace) => sha256(JSON.stringify(trace));

// Decide every observation from the three providers' per-surface results. Resolution is a pure
// function of (observations, run), so it replays byte-identically.
export function decideObservations({ observations, run }) {
  return observations.map((observation) => {
    const results = Object.fromEntries(ENSEMBLE_PROVIDER_ORDER.map((id) => [id, run.byProvider.get(id).get(observation.surface)]));
    const hint = { input: observation.hint?.input, pos: observation.hint?.pos ?? null };
    const decision = classifyObservation({ hint, results });
    const trace = buildTrace({ observation, results, decision });
    const extractorHolds = observation.holds ?? [];
    const assigning = ASSIGNING_CATEGORIES.includes(decision.category);
    return {
      category: decision.category,
      reasons: decision.reasons,
      assigned: decision.assigned,
      holds: assigning ? decision.holds : unresolvedHoldsFor(decision, results),
      rivals: decision.rivals,
      hypotheses: decision.hypotheses,
      trace,
      trace_digest: traceDigest(trace),
      observation_digest: observationDigestOf(observation),
      extractor_holds: sortedUnique(extractorHolds),
    };
  });
}

// --- 3. Review priority and per-row summary ---------------------------------------------------

// Computed over every observation of the lemma (the ensemble policy never omits one), so every hold
// and category drives priority, accounting and the trace identity. Review ORDER only (never lexical admission:
// AGENTS.md — usefulness must not admit, hold or reject). `verify_first`: a rival reading, a hold or
// an unresolved category exists; `high`: two or more independent source observations, all
// concordant and hold-free; `standard`: otherwise. `trace_sha256` commits to all trace digests.
const isHeld = (record) => record.holds.length > 0 || record.ensemble.resolution === 'context';
export const priorityOf = ({ categories, held }, total) => (categories.concordant !== total || held > 0 ? 'verify_first' : total >= 2 ? 'high' : 'standard');
// Order-independent commitment to every observation's (trace, category, held).
export const observationSetTraceDigest = (records) => digest(['ensemble-observation-set', records
  .map((record) => JSON.stringify([record.ensemble.trace_digest, record.ensemble.category, isHeld(record)])).sort()]);
export function reviewSummary(records) {
  const categories = { concordant: 0, supported_alternative: 0, conflicted: 0, unsupported_or_unknown: 0 };
  let held = 0;
  for (const record of records) {
    categories[record.ensemble.category] += 1;
    if (isHeld(record)) held += 1;
  }
  return {
    priority: priorityOf({ categories, held }, records.length),
    categories: Object.fromEntries(Object.entries(categories).filter(([, count]) => count > 0)),
    held,
    trace_sha256: observationSetTraceDigest(records),
  };
}
// --- 4. Shared validators (called by lemma-contract) -----------------------------------------

const SHA256 = /^[0-9a-f]{64}$/u;
export function validateHypotheses(list, at) {
  const errors = [];
  if (!Array.isArray(list)) return [`${at}: hypotheses must be an array`];
  const keys = new Set();
  list.forEach((entry, index) => {
    if (!isObject(entry) || Object.keys(entry).sort().join() !== 'lemma,pos,supporters' || !KOREAN_WORD.test(String(entry.lemma)) || !POS_VALUES.includes(entry.pos)
      || !Array.isArray(entry.supporters) || entry.supporters.length === 0 || entry.supporters.some((supporter) => !SUPPORTERS.includes(supporter))
      || JSON.stringify(sortedUnique(entry.supporters)) !== JSON.stringify(entry.supporters)) {
      errors.push(`${at}: hypotheses[${index}] must be {lemma, pos, supporters}`);
      return;
    }
    if (keys.has(readingKey(entry))) errors.push(`${at}: hypotheses repeat a lemma/POS`);
    keys.add(readingKey(entry));
  });
  const ordered = [...list].sort((a, b) => compare(a?.lemma, b?.lemma) || compare(a?.pos, b?.pos));
  if (JSON.stringify(ordered) !== JSON.stringify(list)) errors.push(`${at}: hypotheses must be ordered by lemma then POS`);
  return errors;
}

export function validateReasons(reasons, at) {
  if (!Array.isArray(reasons) || reasons.length === 0 || reasons.some((reason) => !ENSEMBLE_REASONS.includes(reason))
    || JSON.stringify(sortedUnique(reasons)) !== JSON.stringify(reasons)) return [`${at}: reasons must be a sorted, unique, non-empty list of known reason codes`];
  return [];
}

// Per-observation record inside a v2 candidate row (ensemble policy only).
export function validateEnsembleObservation(record, at, { decisionIds = new Set(), holds = [] } = {}) {
  const errors = [];
  const allowed = ['category', 'reasons', 'alternatives', 'trace_digest', 'resolution', 'context_decision'];
  if (!isObject(record) || Object.keys(record).some((key) => !allowed.includes(key))) return [`${at}: ensemble must be {category, reasons, alternatives, trace_digest, resolution[, context_decision]}`];
  if (!CATEGORIES.includes(record.category)) errors.push(`${at}: ensemble.category must be one of ${CATEGORIES.join(', ')}`);
  errors.push(...validateReasons(record.reasons, at));
  errors.push(...validateHypotheses(record.alternatives, `${at}: ensemble.alternatives`));
  if (typeof record.trace_digest !== 'string' || !SHA256.test(record.trace_digest)) errors.push(`${at}: ensemble.trace_digest must be sha256 hex`);
  if (!RESOLUTIONS.includes(record.resolution)) errors.push(`${at}: ensemble.resolution must be ${RESOLUTIONS.join(' or ')}`);
  else if (record.resolution === 'ensemble') {
    if (!ASSIGNING_CATEGORIES.includes(record.category)) errors.push(`${at}: only a concordant or supported_alternative observation is assigned by morphology alone`);
    if (record.context_decision !== undefined) errors.push(`${at}: an ensemble resolution must not name a context decision`);
    // The shared contract itself guarantees the uncertainty survives: a supported alternative must
    // record its rival hypothesis AND keep the reviewable hold; a concordant one records no rival.
    if (record.category === 'supported_alternative') {
      if (!Array.isArray(record.alternatives) || record.alternatives.length === 0) errors.push(`${at}: a supported_alternative must record its non-empty rival hypotheses`);
      if (!holds.includes('analysis_ambiguous')) errors.push(`${at}: a supported_alternative must keep a reviewable analysis_ambiguous hold`);
    } else if (record.category === 'concordant' && Array.isArray(record.alternatives) && record.alternatives.length) {
      errors.push(`${at}: a concordant observation records no rival hypothesis`);
    }
  } else {
    if (ASSIGNING_CATEGORIES.includes(record.category)) errors.push(`${at}: a context resolution recovers only a morphologically unassignable observation, not an assignable one`);
    if (!decisionIds.has(record.context_decision)) errors.push(`${at}: ensemble.context_decision must name a recorded confirmed/reassigned context decision`);
  }
  return errors;
}

// Under the ensemble policy a lemma's observations are never omitted: every observation (with its
// category, hold and trace digest) is a tracked, individually validated row entry, so `review` is
// recomputed EXACTLY from them and no unseen observation can hide a hold or a category. (A lemma
// that would need more than the bound fails the run — see `buildLemmaRow`.)
export function validateReviewField(review, observations, observationTotal, at) {
  if (!isObject(review) || Object.keys(review).sort().join() !== 'categories,held,priority,trace_sha256' || !PRIORITIES.includes(review.priority)) return [`${at}: review must be {priority, categories, held, trace_sha256}`];
  if (observations.length !== observationTotal) return [`${at}: under the ensemble policy every observation must be retained (observation_total ${observationTotal} vs ${observations.length}); an omitted observation could hide a hold or category`];
  return JSON.stringify(reviewSummary(observations)) === JSON.stringify(review) ? []
    : [`${at}: review does not match the category, hold and trace records of its ${observationTotal} observations`];
}

// LOCAL integration check (needs the ignored `--ensemble-trace` file, never part of routine CI):
// every observation and queue record must be backed by a trace whose digest, category and hold
// state agree. This proves recorded categories/holds against the real analysis.
export function verifyEnsembleTraces({ rows, queue = [], excluded = [], traces }) {
  const errors = [];
  if (!Array.isArray(traces)) return ['local ensemble traces must be an array'];
  const byObservation = new Map();
  const byTrace = new Map();
  const inputObservations = new Set();
  for (const [index, entry] of traces.entries()) {
    if (!isObject(entry) || !SHA256.test(String(entry.trace_digest ?? '')) || !isObject(entry.trace)) {
      errors.push(`local trace ${index + 1}: trace_digest and trace are required`);
      continue;
    }
    if (!SHA256.test(String(entry.observation_digest ?? ''))) errors.push(`local trace ${index + 1}: observation_digest is required`);
    else if (inputObservations.has(entry.observation_digest)) errors.push(`local trace ${index + 1}: duplicate observation_digest`);
    else {
      inputObservations.add(entry.observation_digest);
      byObservation.set(entry.observation_digest, entry);
    }
    const sameTrace = byTrace.get(entry.trace_digest) ?? [];
    sameTrace.push(entry);
    byTrace.set(entry.trace_digest, sameTrace);
  }
  const represented = new Set();
  const sameList = (left, right) => JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right));
  // `holds` is the full recorded hold list; `kind` says how it relates to the trace's pre-context
  // `observation_holds` (the extractor holds, plus the ensemble's own holds for an assigned reading):
  //   assigned — exactly equal; context — the trace holds plus only the reviewable analysis_ambiguous;
  //   queue — the entry's extractor_holds exactly equal the trace holds (an unassigned observation
  //   carries only its extractor holds, never an ensemble-made one).
  const check = (at, record) => {
    let local = record.observation_digest ? byObservation.get(record.observation_digest) : null;
    if (!local && record.trace_digest) local = (byTrace.get(record.trace_digest) ?? []).find((entry) => !represented.has(entry.observation_digest));
    if (!local) { errors.push(`${at}: no local trace for ${record.trace_digest.slice(0, 12)}`); return; }
    if (represented.has(local.observation_digest)) errors.push(`${at}: observation is assigned to more than one disposition`);
    represented.add(local.observation_digest);
    if (local.trace_digest !== record.trace_digest) errors.push(`${at}: recorded trace digest differs from the local observation trace`);
    const { trace } = local;
    if (record.observation_digest && record.observation_digest !== local.observation_digest) {
      errors.push(`${at}: observation_digest differs from the local trace`);
    }
    if (traceDigest(trace) !== record.trace_digest) errors.push(`${at}: local trace does not hash to its digest`);
    if (trace.category !== record.category) errors.push(`${at}: recorded category ${record.category} differs from the trace (${trace.category})`);
    const traced = trace.observation_holds;
    const ok = record.kind === 'context'
      ? traced.every((hold) => record.holds.includes(hold)) && record.holds.every((hold) => traced.includes(hold) || hold === 'analysis_ambiguous')
      : sameList(record.holds, traced);
    if (!ok) errors.push(`${at}: recorded holds ${JSON.stringify(record.holds)} differ from the trace's source holds ${JSON.stringify(traced)}`);
  };
  for (const row of rows) {
    for (const observation of row.observations) {
      check(`${row.candidate_id} ${observation.observation_id}`, { observation_digest: observation.observation_digest,
        trace_digest: observation.ensemble.trace_digest, category: observation.ensemble.category,
        holds: observation.holds, kind: observation.ensemble.resolution === 'context' ? 'context' : 'assigned' });
    }
  }
  for (const entry of queue) check(entry.queue_id, { observation_digest: entry.observation_digest, trace_digest: entry.trace_digest,
    category: entry.category, holds: entry.extractor_holds, kind: 'queue' });
  for (const entry of excluded) check(`${entry.disposition} ${entry.observation_digest}`, { observation_digest: entry.observation_digest,
    trace_digest: entry.ensemble?.trace_digest, category: entry.ensemble?.category, holds: entry.holds,
    kind: entry.ensemble?.resolution === 'context' ? 'context' : 'assigned' });
  for (const [observationDigest, entry] of byObservation) {
    if (!represented.has(observationDigest)) errors.push(`local trace ${entry.trace_digest.slice(0, 12)} for observation ${observationDigest.slice(0, 12)} has no recorded disposition`);
  }
  return errors;
}

// Manifest `ensemble` block and the digest that binds the providers, every observation's trace and
// the recorded context decisions: changing a provider, the order, the policy or any result changes it.
export const ENSEMBLE_MANIFEST_KEYS = ['contract', 'counts', 'trace_sha256'];
export function ensembleTraceSha256({ providers, observationTraceDigests, queueTraceDigests, excludedTraceDigests = [], contextDecisionsSha256,
  contract = ENSEMBLE_CONTRACT }) {
  if (contract === LEGACY_ENSEMBLE_CONTRACT) {
    return digest(['ensemble-trace', contract, ENSEMBLE_POLICY, JSON.stringify(providers), observationTraceDigests, queueTraceDigests, contextDecisionsSha256]);
  }
  return digest(['ensemble-trace', contract, ENSEMBLE_POLICY, JSON.stringify(providers), observationTraceDigests, queueTraceDigests, excludedTraceDigests, contextDecisionsSha256]);
}

export const ensembleProviderDescriptors = (providers) => providers.map(providerDescriptor);

// --- 5. Honest same-cohort yield measurement --------------------------------------------------

// Counts only what the cohort and the shared validators can show. `verified_correct`/`verified_wrong`
// stay `not_established` unless an independently adjudicated set is supplied; model votes, AI
// self-checks and unknown items are never reported as verified accuracy.
export function ensembleCohortMetrics({ observations, decisions, run, contextOutcomes = [], independentlyAdjudicated = null }) {
  const categories = { concordant: 0, supported_alternative: 0, conflicted: 0, unsupported_or_unknown: 0 };
  decisions.forEach((decision) => { categories[decision.category] += 1; });
  const unresolved = decisions.filter((decision) => !ASSIGNING_CATEGORIES.includes(decision.category));
  const contextResolved = contextOutcomes.filter((outcome) => outcome.outcome !== 'truth_unknown').length;
  const assignedLemmas = new Set(decisions.filter((decision) => decision.assigned).map((decision) => decision.assigned.lemma));
  const posOpportunities = new Set(decisions.filter((decision) => decision.assigned).map((decision) => readingKey(decision.assigned)));
  return {
    original_observations: observations.length,
    unique_surfaces: run.surfaces.length,
    provider_calls: Object.fromEntries(Object.entries(run.calls).map(([id, call]) => [id, { surfaces: call.surfaces, ms: call.ms }])),
    categories,
    unique_lemma_proposals: assignedLemmas.size,
    distinct_pos_opportunities: posOpportunities.size,
    apparent_resolved: decisions.length - unresolved.length,
    needs_verification: unresolved.length,
    held_observations: decisions.filter((decision) => ASSIGNING_CATEGORIES.includes(decision.category) && decision.holds.length).length,
    fallback: {
      eligible: decisions.filter((decision, index) => !ASSIGNING_CATEGORIES.includes(decision.category)
        && fallbackBlockers({ extractor_holds: decision.extractor_holds, evidence: observations[index].ref }).length === 0).length,
      attempted: contextOutcomes.length,
      evidence_resolved: contextResolved,
      still_unresolved: unresolved.length - contextResolved,
    },
    verified_correct: independentlyAdjudicated === null ? 'not_established' : independentlyAdjudicated.correct,
    verified_wrong: independentlyAdjudicated === null ? 'not_established' : independentlyAdjudicated.wrong,
    truth_unknown: unresolved.length - contextResolved,
    accuracy: independentlyAdjudicated === null ? 'not_established' : independentlyAdjudicated.correct / Math.max(1, independentlyAdjudicated.correct + independentlyAdjudicated.wrong),
  };
}
