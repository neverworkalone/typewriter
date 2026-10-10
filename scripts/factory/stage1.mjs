import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { HOLD_REASONS, POS_VALUES, normalizeText } from '../intake/candidate-contract.mjs';
import { analysisInputDigest, PINNED_ANALYZER } from '../intake/pipeline.mjs';
import {
  FALLBACK_ELIGIBLE_HOLDS,
  RESOLUTION_POLICY,
  assertProvider,
  createKiwiProvider,
  normalizeProviderResult,
  providerDescriptor,
  toLegacyOutcome,
} from './analyzer-providers.mjs';
import { digest } from '../intake/candidate-contract.mjs';
import {
  ASSIGNING_CATEGORIES,
  ENSEMBLE_CONTRACT,
  ENSEMBLE_POLICY,
  EnsembleError,
  decideObservations,
  ensembleCohortMetrics,
  ensembleTraceSha256,
  observationDigestOf,
  reviewSummary,
  runEnsembleProviders,
} from './ensemble-resolver.mjs';
import {
  CONTEXT_CONTRACT,
  ContextFallbackError,
  RESOLVING_OUTCOMES,
  contextDecisionsSha256,
  decisionSha256,
  fallbackBlockers,
  recordContextDecisions,
  replayContextDecisions,
} from './context-fallback.mjs';
import { candidateIdFor, expectedAnalyzerDigest, isBatchId, sha256Hex, validateCandidateBatch } from './contract.mjs';
import { buildCanonicalIndex, classifyLemmaCandidate } from './identity-adapter.mjs';
import {
  LEMMA_CANDIDATE_MANIFEST_CONTRACT,
  LEMMA_POLICY,
  MAX_OBSERVATIONS_PER_CANDIDATE,
  MAX_UNRESOLVED_OBSERVATIONS,
  UNRESOLVED_HOLDS,
  formIdFor,
  isReferenceToken,
  isSurfaceToken,
  groupIdFor,
  observationIdFor,
  observationKey,
  observationSetDigest,
} from './lemma-contract.mjs';

// Factory Stage 1 producer library (issue #264; design docs/lexical-production-factory.md §2).
// Since issue #275 the unit is a distinct citation-form lemma, not a usage row: it turns text-free
// corpus evidence into one immutable lemma-centered (v2) candidate batch. It never writes review
// rows, glosses, canonical records or paragraph text, and it does not touch the legacy
// candidateKey/dedupeCandidates/coveredLemmas path.

export const CORPUS_EVIDENCE_CONTRACT = 'm9-corpus-candidate-evidence-v1';
export const CORPUS_SOURCE_ADAPTER = 'corpus-adapter';
// Stage 1 interprets `derived_from_index`; a service without this proposal contract is refused.
export const REQUIRED_PROPOSAL_CONTRACT = 'derivation-root-v1';
// The bound counts DISTINCT LEMMAS (headwords), never usages or observations.
export const DEFAULT_MAX_CANDIDATES = 500;
export const HARD_MAX_CANDIDATES = 1000;

// Exactly the fields `safeEvidenceHit` of the extractor may emit; anything else (a context,
// paragraph form or text) is raw corpus text that must never reach Git.
const SAFE_HIT_FIELDS = new Set(['source_path', 'corpus_id', 'document_id', 'document_ordinal', 'paragraph_id',
  'paragraph_ordinal', 'source_category', 'source_year', 'matched_surface_form', 'matched_morpheme_span_surface',
  // Optional text-free sense/usage-group token (e.g. a cluster id) when the extractor can tell uses apart.
  'usage_group']);
const KOREAN_WORD = /^[가-힣]+$/u;
const TOKEN = /^[a-z0-9_-]{1,32}$/u;

export class Stage1Error extends Error {
  constructor(errors) {
    super(`Stage 1 producer: ${errors.join('; ')}`);
    this.name = 'Stage1Error';
    this.errors = errors;
  }
}

const compare = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

// Holds the extractor itself recorded (mirrors scripts/intake/adapters/corpus-adapter.mjs, whose
// `decision_state` is not part of the text-free evidence).
function extractorHolds(candidate) {
  const holds = [];
  if (String(candidate.ambiguity_status ?? '').startsWith('held_')) holds.push('analysis_ambiguous');
  if (!['uncovered', 'exact_canonical_lemma', undefined].includes(candidate.coverage_status)) holds.push('coverage_collision');
  return holds;
}

// Text-free extractor evidence → usage observations (one per bounded paragraph hit).
export function observationsFromCorpusEvidence(evidence) {
  const errors = [];
  if (evidence?.contract_version !== CORPUS_EVIDENCE_CONTRACT) errors.push(`evidence contract_version must be ${CORPUS_EVIDENCE_CONTRACT}`);
  if (!Array.isArray(evidence?.candidates) || evidence.candidates.length === 0) errors.push('evidence has no candidates');
  const manifestDigest = evidence?.index?.input_manifest_sha256;
  const rowsDigest = evidence?.index?.logical_rows_sha256;
  if (!/^[0-9a-f]{64}$/u.test(String(manifestDigest)) || !/^[0-9a-f]{64}$/u.test(String(rowsDigest))) errors.push('evidence must record the pinned corpus index digests');
  if (typeof evidence?.extractor?.extractor_version !== 'string' || !evidence.extractor.extractor_version) errors.push('evidence must record extractor_version');
  for (const [key, expected] of [['kiwipiepy_version', PINNED_ANALYZER.kiwipiepy_version], ['kiwipiepy_model_version', PINNED_ANALYZER.kiwipiepy_model_version]]) {
    if (evidence?.extractor?.[key] !== expected) errors.push(`extractor ${key} ${evidence?.extractor?.[key] ?? 'missing'} is not the pinned ${expected}`);
  }
  if (errors.length) throw new Stage1Error(errors);

  const observations = [];
  // Matched surfaces are accepted only as-is when they satisfy the tracked token contract. Invalid
  // values are omitted and represented only by an aggregate count; never clean or replace source text.
  // A candidate left with no usable hit stays visible through the explicit `no_evidence` hold.
  let omittedNonTokenSurfaceHits = 0;
  evidence.candidates.forEach((candidate, index) => {
    const at = `evidence candidate ${index + 1}`;
    const input = normalizeText(candidate.proposed_lemma);
    const pos = candidate.proposed_pos ?? null;
    if (!KOREAN_WORD.test(input)) errors.push(`${at}: proposed_lemma must be a Korean word`);
    if (pos !== null && !POS_VALUES.includes(pos)) errors.push(`${at}: proposed_pos is not supported`);
    const hits = candidate.evidence?.representative_hits;
    if (!Array.isArray(hits)) { errors.push(`${at}: representative_hits missing`); return; }
    for (const hit of hits) {
      const unsafe = Object.keys(hit).filter((key) => !SAFE_HIT_FIELDS.has(key));
      if (unsafe.length) errors.push(`${at}: raw corpus text field(s) not allowed: ${unsafe.join(', ')}`);
      if (!hit.document_id || !hit.paragraph_id) errors.push(`${at}: hit needs document_id and paragraph_id`);
      if (hit.usage_group !== undefined && !TOKEN.test(String(hit.usage_group))) errors.push(`${at}: usage_group must be a short text-free token`);
    }
    const holds = extractorHolds(candidate);
    const base = { hint: { input, pos }, holds };
    const usableHits = hits.filter((hit) => isSurfaceToken(hit.matched_surface_form));
    omittedNonTokenSurfaceHits += hits.length - usableHits.length;
    if (usableHits.length === 0) {
      // No valid located surface: keep the candidate visible with a generic hold. The proposed lemma
      // is a bounded placeholder, not a rewrite or replacement derived from an omitted hit.
      const surface = input;
      observations.push({ ...base, surface, holds: [...holds, 'no_evidence'], ref: { kind: 'corpus-surface', ref: surface } });
      return;
    }
    for (const hit of usableHits) {
      const surface = hit.matched_surface_form;
      observations.push({ ...base, surface, group: hit.usage_group, ref: { kind: 'corpus-paragraph', ref: `${hit.document_id}#${hit.paragraph_id}` } });
    }
  });
  // Tracked output may carry only a single bounded word form and an opaque source reference.
  observations.forEach((observation, index) => {
    if (!isSurfaceToken(observation.surface)) errors.push(`observation ${index + 1}: observed surface is not a single bounded word form (phrase or sentence text must never reach Git)`);
    if (!isReferenceToken(observation.ref.ref) || !isReferenceToken(observation.ref.kind)) errors.push(`observation ${index + 1}: evidence reference must be an opaque token`);
  });
  if (errors.length) throw new Stage1Error(errors);
  return {
    observations,
    source: {
      source_snapshot: `corpus:${manifestDigest}:${rowsDigest}`,
      extractor_version: evidence.extractor.extractor_version,
      omitted_non_token_surface_hits: omittedNonTokenSurfaceHits,
    },
  };
}

// Dictionary-form lemma/POS for one inflected observed form, from the pinned Kiwi analysis.
// Anything not explained by exactly one reading becomes an explicit hold, never a guess.
export function resolveSurface(surface, hint, outcome) {
  if (!outcome) return { holds: ['analysis_missing'], lemma: hint?.input, pos: hint?.pos };
  if (outcome.input_digest !== analysisInputDigest(surface)) return { holds: ['analysis_stale'], lemma: hint?.input, pos: hint?.pos };
  if (outcome.status === 'error') return { holds: ['analysis_error'], lemma: hint?.input, pos: hint?.pos };
  if (outcome.status !== 'ok' || !outcome.analyses?.length) return { holds: ['analysis_unsupported'], lemma: hint?.input, pos: hint?.pos };
  const [best, ...alternatives] = outcome.analyses;
  if (!best.length) return { holds: ['analysis_unsupported'], lemma: hint?.input, pos: hint?.pos };
  const hinted = best.find((item) => item.lemma === hint?.input && (!hint.pos || item.pos === hint.pos))
    ?? best.find((item) => item.lemma === hint?.input);
  const chosen = hinted ?? (best.length === 1 ? best[0] : null);
  if (!chosen) return { holds: ['analysis_ambiguous'], lemma: hint?.input ?? best[0].lemma, pos: hint?.pos ?? best[0].pos };
  const holds = [];
  // The chosen reading must explain the whole surface: another content morpheme of the same path
  // is acceptable only as the one root occurrence the analyzer linked to the chosen derived
  // predicate (`derived_from_index`, from an XSV/XSA suffix after NNG). A same-spelled extra
  // morpheme or a string prefix proves nothing.
  const root = Number.isInteger(chosen.derived_from_index) ? best[chosen.derived_from_index] : undefined;
  const derivedBase = (item) => item === root && item.pos === 'noun' && item.form === chosen.derived_from
    && chosen.derived_from_index < best.indexOf(chosen);
  if (best.some((item) => item !== chosen && !derivedBase(item))) holds.push('lemma_mismatch');
  else if (hint?.input && chosen.lemma !== hint.input) holds.push('lemma_mismatch');
  else if (hint?.pos && chosen.pos !== hint.pos) holds.push('pos_mismatch');
  // A competing reading: another ranked path that explains the form without the chosen lemma/POS
  // using no more content morphemes, or the same lemma with a different POS.
  const rival = alternatives.some((analysis) => analysis.length > 0
    && !analysis.some((item) => item.lemma === chosen.lemma && item.pos === chosen.pos)
    && (analysis.some((item) => item.lemma === chosen.lemma) || analysis.length <= best.length));
  if (rival) holds.push('analysis_ambiguous');
  return { holds, lemma: chosen.lemma, pos: chosen.pos };
}

const isEligible = (holds) => holds.length > 0 && holds.every((hold) => FALLBACK_ELIGIBLE_HOLDS.includes(hold));

// Common resolution policy (RESOLUTION_POLICY). One provider's reading of one observation is
// `resolved` (no holds), `needs_verification` (a clean reading from a provider that reports only
// its single best path — it cannot prove the absence of a rival, so it is never certain on its
// own) or `unresolved` (explicit holds). Order controls expense only: a later provider is asked
// only about observations still unresolved after an earlier one, and only for the classified
// holds in FALLBACK_ELIGIBLE_HOLDS; any other hold is final. A later provider confirming a
// best-only reading must agree on lemma/POS, otherwise `analysis_mismatch` is kept.
function judgeAttempt(provider, observation, normalized) {
  if (normalized.outcome === 'ambiguous') return { state: 'unresolved', holds: ['analysis_ambiguous'], lemma: observation.hint?.input, pos: observation.hint?.pos };
  const resolved = resolveSurface(observation.surface, observation.hint, toLegacyOutcome(normalized));
  if (resolved.holds.length) return { state: 'unresolved', ...resolved };
  if (!provider.capabilities.n_best) return { state: 'needs_verification', holds: ['analysis_ambiguous'], lemma: resolved.lemma, pos: resolved.pos };
  return { state: 'resolved', holds: [], lemma: resolved.lemma, pos: resolved.pos };
}

export async function resolveWithProviders({ observations, providers }) {
  const metadataByProvider = new Map();
  const attemptLog = [];
  const decided = new Array(observations.length).fill(null);
  const provisional = new Array(observations.length).fill(null);
  const heldBy = observations.map(() => new Set());
  let pending = observations.map((_, index) => index);
  for (const provider of providers) {
    if (pending.length === 0) break;
    const surfaces = [...new Set(pending.map((index) => observations[index].surface))].sort(compare);
    const requests = surfaces.map((surface) => ({ id: surface, text: surface }));
    let response;
    try {
      response = await provider.analyze(requests);
      provider.assertMetadata(response?.metadata);
    } catch (error) {
      throw new Stage1Error([`analyzer provider ${provider.id} failed closed: ${error.message}`]);
    }
    if (response.metadata.proposal_contract !== REQUIRED_PROPOSAL_CONTRACT) {
      throw new Stage1Error([`analyzer proposal_contract ${response.metadata.proposal_contract ?? 'missing'} is not ${REQUIRED_PROPOSAL_CONTRACT}`]);
    }
    metadataByProvider.set(provider.id, response.metadata);
    const list = Array.isArray(response.results) ? response.results : [];
    const raw = new Map(list.map((outcome) => [outcome?.id, outcome]));
    // More than one result for a requested id is malformed and order-dependent: never trust either.
    const duplicated = new Set(list.map((outcome) => outcome?.id).filter((id, at, ids) => ids.indexOf(id) !== at));
    const normalized = new Map(requests.map((request) => {
      const result = normalizeProviderResult(provider, request, raw.get(request.id));
      return [request.id, duplicated.has(request.id)
        ? { ...result, outcome: 'error', analyses: [], diagnostics: { reason: 'duplicate_result_id' } } : result];
    }));
    const next = [];
    for (const index of pending) {
      const observation = observations[index];
      const result = normalized.get(observation.surface);
      const attempt = judgeAttempt(provider, observation, result);
      if (provisional[index] && attempt.state !== 'unresolved'
        && (attempt.lemma !== provisional[index].lemma || attempt.pos !== provisional[index].pos)) {
        attempt.state = 'unresolved';
        attempt.holds = ['analysis_mismatch'];
      }
      attempt.holds.forEach((hold) => heldBy[index].add(hold));
      attemptLog.push({ provider_id: provider.id, input_digest: analysisInputDigest(observation.surface), outcome: result.outcome, state: attempt.state, holds: [...attempt.holds].sort(compare),
        fallback: attempt.state === 'needs_verification' || isEligible(attempt.holds) });
      if (attempt.state === 'resolved') {
        decided[index] = { holds: [], lemma: attempt.lemma, pos: attempt.pos };
        continue;
      }
      // Two best-only readers agreeing is still not proof of the absence of a rival: keep the hold.
      if (attempt.state === 'needs_verification') provisional[index] ??= { lemma: attempt.lemma, pos: attempt.pos };
      if (attempt.state === 'needs_verification' || isEligible(attempt.holds)) next.push(index);
      else decided[index] = { holds: [...heldBy[index]].sort(compare), lemma: provisional[index]?.lemma ?? attempt.lemma, pos: provisional[index]?.pos ?? attempt.pos };
    }
    pending = next;
  }
  // Never resolved by any provider: the explicit holds of every attempt stay on the row.
  for (const index of pending) {
    decided[index] = { holds: [...heldBy[index]].sort(compare), lemma: provisional[index]?.lemma ?? observations[index].hint?.input, pos: provisional[index]?.pos ?? observations[index].hint?.pos };
  }
  return { resolutions: decided, metadataByProvider, attemptLog };
}

// Lemma-centered grouping (issue #275). Every observation that resolves to a dictionary-form lemma
// joins that lemma's single candidate; observations without a reliable lemma/POS are returned
// separately (preserved, never counted as headwords, never guessed). Holds stay on the observation
// that earned them.
export async function buildLemmaGroups({ observations, analyzer, providers = [createKiwiProvider({ analyze: analyzer })] }) {
  const { resolutions, metadataByProvider, attemptLog } = await resolveWithProviders({ observations, providers });
  const lemmas = new Map();
  const unresolved = new Map();
  let repeatsMerged = 0;
  for (const [index, observation] of observations.entries()) {
    const resolved = resolutions[index];
    const unresolvedHolds = resolved.holds.filter((hold) => UNRESOLVED_HOLDS.includes(hold));
    if (unresolvedHolds.length) {
      const key = [observation.surface, observation.ref.kind, observation.ref.ref].join('\u0000');
      const known = unresolved.get(key);
      if (known) known.holds = [...new Set([...known.holds, ...unresolvedHolds])].sort(compare);
      else unresolved.set(key, { surface: observation.surface, evidence: observation.ref, holds: [...new Set(unresolvedHolds)].sort(compare) });
      continue;
    }
    if (!KOREAN_WORD.test(resolved.lemma ?? '') || !POS_VALUES.includes(resolved.pos)) {
      throw new Stage1Error([`cannot represent ${observation.surface}: no dictionary-form lemma/POS from analysis or extractor hint`]);
    }
    const holds = [...observation.holds, ...resolved.holds].filter((hold) => !UNRESOLVED_HOLDS.includes(hold));
    const group = observation.group ?? '';
    const entry = lemmas.get(resolved.lemma) ?? new Map();
    const key = observationKey(resolved.pos, group, observation.surface, observation.ref);
    const known = entry.get(key);
    if (known) {
      repeatsMerged += 1;
      for (const hold of holds) known.holds.add(hold);
    } else {
      entry.set(key, {
        key, pos: resolved.pos, group, surface: observation.surface, evidence: observation.ref,
        digest: analysisInputDigest(observation.surface), holds: new Set(holds),
      });
    }
    lemmas.set(resolved.lemma, entry);
  }
  return { lemmas, unresolved: [...unresolved.values()].sort((a, b) => compare(a.surface, b.surface) || compare(a.evidence.ref, b.evidence.ref)),
    repeatsMerged, assignedRepeatsMerged: repeatsMerged, metadataByProvider, attemptLog };
}

// Ensemble grouping (issue #285). Kiwi, Khaiii and MeCab all analyze every unique surface; each
// observation is adjudicated by the pure ensemble core. Only concordant / supported_alternative
// observations (or an evidence-bound, replayed context decision) join a lemma; every other
// observation goes to the auditable verification queue with all competing hypotheses and is never
// counted as a headword. A clear sibling form never inherits an ambiguous sibling's state.
export async function buildEnsembleGroups({
  observations, providers, contextProposals = null, contextReplay = null, contextSource = null, snapshot = '', contextAgent = null,
}) {
  // Repeated corpus hits for the same source observation are evidence repeats, not additional
  // dispositions. Normalize them from the source list before analysis/accounting, keeping all
  // extractor holds so a duplicate can never erase a more restrictive source status.
  const uniqueByDigest = new Map();
  const inputCountsByDigest = new Map();
  const hintKeyOf = (observation) => JSON.stringify([observation.hint?.input ?? null, observation.hint?.pos ?? null]);
  for (const observation of observations) {
    const digest = observationDigestOf(observation);
    inputCountsByDigest.set(digest, (inputCountsByDigest.get(digest) ?? 0) + 1);
    const known = uniqueByDigest.get(digest);
    if (known) {
      known.holds = [...new Set([...known.holds, ...(observation.holds ?? [])])].sort(compare);
      if (!known.extractor_hint_conflict && hintKeyOf(known) !== hintKeyOf(observation)) {
        known.extractor_hint_conflict = true;
        known.hint = { input: null, pos: null };
        known.holds = [...new Set([...known.holds, 'analysis_ambiguous'])].sort(compare);
      }
    } else {
      uniqueByDigest.set(digest, { ...observation, holds: [...new Set(observation.holds ?? [])].sort(compare) });
    }
  }
  const sourceObservations = [...uniqueByDigest.values()];
  let run;
  try {
    run = await runEnsembleProviders({ observations: sourceObservations, providers });
  } catch (error) {
    if (error instanceof EnsembleError) throw new Stage1Error(error.errors);
    throw error;
  }
  const decisions = decideObservations({ observations: sourceObservations, run });
  const decisionByDigest = new Map(decisions.map((decision) => [decision.observation_digest, decision]));
  const queueByDigest = new Map();
  sourceObservations.forEach((observation, index) => {
    const decision = decisions[index];
    if (ASSIGNING_CATEGORIES.includes(decision.category)) return;
    if (queueByDigest.has(decision.observation_digest)) return;
    queueByDigest.set(decision.observation_digest, {
      surface: observation.surface, evidence: observation.ref, holds: decision.holds, category: decision.category, reasons: decision.reasons,
      hypotheses: decision.hypotheses, extractor_hint: { lemma: observation.hint?.input ?? null, pos: observation.hint?.pos ?? null },
      extractor_holds: decision.extractor_holds, observation_digest: decision.observation_digest, trace_digest: decision.trace_digest,
    });
  });
  const queueDraft = [...queueByDigest.values()];

  let contextRecords = [];
  let replayed;
  try {
    if (contextProposals) {
      if (!contextSource) throw new ContextFallbackError(['context proposals need a local context source']);
      contextRecords = await recordContextDecisions({ proposals: contextProposals, queue: queueDraft, contextSource, snapshot, agent: contextAgent });
    } else if (contextReplay) {
      contextRecords = contextReplay;
    }
    replayed = replayContextDecisions({ decisions: contextRecords, queue: queueDraft });
  } catch (error) {
    if (error instanceof ContextFallbackError) throw new Stage1Error(error.errors);
    throw error;
  }

  const lemmas = new Map();
  const queue = [];
  let repeatsMerged = [...inputCountsByDigest].reduce((sum, [, count]) => sum + count - 1, 0);
  let assignedRepeatsMerged = [...inputCountsByDigest].reduce((sum, [digest, count]) =>
    sum + (ASSIGNING_CATEGORIES.includes(decisionByDigest.get(digest)?.category) || replayed.resolved.has(digest) ? count - 1 : 0), 0);
  const addToLemma = ({ lemma, pos, observation, observationDigest, holds, ensemble }) => {
    const group = observation.group ?? '';
    const entry = lemmas.get(lemma) ?? new Map();
    const key = observationKey(pos, group, observation.surface, observation.ref);
    const known = entry.get(key);
    if (known) {
      repeatsMerged += 1;
      assignedRepeatsMerged += 1;
      for (const hold of holds) known.holds.add(hold);
    } else {
      entry.set(key, { key, pos, group, surface: observation.surface, evidence: observation.ref, digest: analysisInputDigest(observation.surface),
        observation_digest: observationDigest, holds: new Set(holds), ensemble });
    }
    lemmas.set(lemma, entry);
  };
  const sameReading = (a, b) => a.lemma === b.lemma && a.pos === b.pos;
  const queued = new Set();
  sourceObservations.forEach((observation, index) => {
    const decision = decisions[index];
    const base = { category: decision.category, reasons: decision.reasons, trace_digest: decision.trace_digest };
    if (ASSIGNING_CATEGORIES.includes(decision.category)) {
      if (!KOREAN_WORD.test(decision.assigned.lemma) || !POS_VALUES.includes(decision.assigned.pos)) {
        throw new Stage1Error([`cannot represent ${observation.surface}: no dictionary-form lemma/POS from the ensemble`]);
      }
      const holds = [...observation.holds, ...decision.holds].filter((hold) => !UNRESOLVED_HOLDS.includes(hold));
      addToLemma({ lemma: decision.assigned.lemma, pos: decision.assigned.pos, observation, observationDigest: decision.observation_digest, holds,
        ensemble: { ...base, alternatives: decision.rivals, resolution: 'ensemble' } });
      return;
    }
    const recovered = replayed.resolved.get(decision.observation_digest);
    if (recovered) {
      // A contextual recovery never clears an extractor hold and always stays reviewable.
      const holds = [...new Set([...observation.holds.filter((hold) => !UNRESOLVED_HOLDS.includes(hold)), 'analysis_ambiguous'])];
      addToLemma({ lemma: recovered.lemma, pos: recovered.pos, observation, observationDigest: decision.observation_digest, holds,
        ensemble: { ...base, alternatives: decision.hypotheses.filter((entry) => !sameReading(entry, recovered)), resolution: 'context', context_decision: recovered.decision_id } });
      return;
    }
    queued.add(decision.observation_digest);
  });
  for (const draft of queueDraft) {
    if (!queued.has(draft.observation_digest)) continue;
    const unknown = replayed.unknown.get(draft.observation_digest);
    const blockers = fallbackBlockers(draft);
    queue.push({
      ...draft,
      verification: unknown ? { state: 'truth_unknown', decision_id: unknown.decision_id }
        : blockers.length ? { state: 'blocked', blocked_by: blockers } : { state: 'needs_verification' },
    });
  }
  queue.sort((a, b) => compare(a.surface, b.surface) || compare(a.evidence.ref, b.evidence.ref) || compare(String(a.extractor_hint.lemma), String(b.extractor_hint.lemma))
    || compare(String(a.extractor_hint.pos), String(b.extractor_hint.pos)));
  queue.forEach((entry, index) => { entry.queue_id = `U${String(index + 1).padStart(4, '0')}`; });
  const orderedQueue = queue.map((entry) => ({ queue_id: entry.queue_id, surface: entry.surface, evidence: entry.evidence, holds: entry.holds, category: entry.category,
    reasons: entry.reasons, hypotheses: entry.hypotheses, extractor_hint: entry.extractor_hint, extractor_holds: entry.extractor_holds,
    observation_digest: entry.observation_digest, trace_digest: entry.trace_digest, verification: entry.verification }));
  return { lemmas, unresolved: orderedQueue, repeatsMerged, assignedRepeatsMerged, metadataByProvider: run.metadataByProvider, run,
    decisions, observations: sourceObservations, contextRecords,
    attemptLog: ENSEMBLE_LOG(run) };
}

const ENSEMBLE_LOG = (run) => [...run.byProvider].flatMap(([id, results]) => [...results].map(([surface, result]) => ({
  provider_id: id, input_digest: analysisInputDigest(surface), outcome: result.outcome, state: 'analyzed', holds: [], fallback: false })));

const compareObservation = (a, b) => compare(a.pos, b.pos) || compare(a.group, b.group) || compare(a.surface, b.surface)
  || compare(a.evidence.kind, b.evidence.kind) || compare(a.evidence.ref, b.evidence.ref);

// One lemma → one candidate row. A bounded, deterministic selection keeps at least one observation
// for every observed form and every usage group (so no distinct sense opportunity or form is erased);
// the digest and total bind the omitted remainder to the locally recoverable evidence.
export function buildLemmaRow({ lemma, observations: entry, candidateId, ensemble = false }) {
  const all = [...entry.values()].sort(compareObservation);
  const posHypotheses = [...new Set(all.map((item) => item.pos))].sort(compare);
  const groupKeys = [...new Set(all.map((item) => `${item.pos}\u0000${item.group}`))].sort(compare);
  const groups = groupKeys.map((key, index) => {
    const [pos, hint] = key.split('\u0000');
    return { group_id: groupIdFor(candidateId, index + 1), pos, basis: hint ? 'corpus-hint' : 'pos-default', ...(hint ? { hint } : {}) };
  });
  const groupOf = new Map(groupKeys.map((key, index) => [key, groups[index].group_id]));
  const surfaces = [...new Set(all.map((item) => item.surface))].sort(compare);
  const forms = surfaces.map((surface, index) => ({ form_id: formIdFor(candidateId, index + 1), surface }));
  const formOf = new Map(forms.map((form) => [form.surface, form.form_id]));

  const coveredForms = new Set();
  const coveredGroups = new Set();
  const chosen = new Set();
  for (const item of all) {
    const group = groupOf.get(`${item.pos}\u0000${item.group}`);
    if (!coveredGroups.has(group) || !coveredForms.has(item.surface)) {
      chosen.add(item);
      coveredGroups.add(group);
      coveredForms.add(item.surface);
    }
  }
  if (chosen.size > MAX_OBSERVATIONS_PER_CANDIDATE) {
    throw new Stage1Error([`lemma ${lemma} needs ${chosen.size} observations to keep every form and usage group, above the bound ${MAX_OBSERVATIONS_PER_CANDIDATE}`]);
  }
  // Under the ensemble policy no observation may be omitted: an unseen observation could carry a hold
  // or category no tracked artifact shows. A lemma beyond the bound fails the run (split the evidence).
  if (ensemble && all.length > MAX_OBSERVATIONS_PER_CANDIDATE) {
    throw new Stage1Error([`lemma ${lemma} has ${all.length} observations, above the bound ${MAX_OBSERVATIONS_PER_CANDIDATE}; the ensemble policy never omits an observation, so split the evidence run`]);
  }
  for (const item of all) {
    if (chosen.size >= MAX_OBSERVATIONS_PER_CANDIDATE) break;
    chosen.add(item);
  }
  const retained = all.filter((item) => chosen.has(item));
  const observationRecords = retained.map((item, index) => ({
    observation_id: observationIdFor(candidateId, index + 1),
    ...(ensemble ? { observation_digest: item.observation_digest } : {}),
    form_id: formOf.get(item.surface),
    group_id: groupOf.get(`${item.pos}\u0000${item.group}`),
    pos: item.pos,
    evidence: item.evidence,
    analysis: { status: 'ok', input_digest: item.digest },
    holds: [...item.holds].filter((hold) => HOLD_REASONS.includes(hold)).sort(compare),
    ...(ensemble ? { ensemble: item.ensemble } : {}),
  }));
  return {
    candidate_id: candidateId,
    input: lemma,
    pos_hypotheses: posHypotheses,
    forms,
    usage_groups: groups,
    observations: observationRecords,
    observation_total: all.length,
    observation_digest: observationSetDigest(all.map((item) => item.key)),
    ...(ensemble ? { review: reviewSummary(all.map((item) => ({ holds: [...item.holds], ensemble: item.ensemble }))) } : {}),
  };
}

// Eligible lemmas (not yet in any earlier batch) in deterministic lemma order; the first
// `maxCandidates` distinct lemmas become the batch, the rest are deferred.
export function selectLemmas({ lemmas, maxCandidates = DEFAULT_MAX_CANDIDATES, producedLemmas = new Set() }) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > HARD_MAX_CANDIDATES) {
    throw new Stage1Error([`max candidates must be an integer from 1 to ${HARD_MAX_CANDIDATES}`]);
  }
  const fresh = [...lemmas.keys()].filter((lemma) => !producedLemmas.has(lemma)).sort(compare);
  if (fresh.length === 0) throw new Stage1Error(['no unprocessed lemmas: every resolved lemma in the evidence is already in an existing candidate batch (source exhausted)']);
  return { selected: fresh.slice(0, maxCandidates), deferred: fresh.slice(maxCandidates), skippedProduced: lemmas.size - fresh.length };
}

// Identity of a produced usage across batches: lemma + POS + its primary evidence reference
// (always the first evidence entry). Used to skip already-produced usages and to reject repeats.
export const usageKeyOfRow = (row) => `${row.input}\u0000${row.pos}\u0000${row.evidence?.[0]?.kind}\u0000${row.evidence?.[0]?.ref}`;

export const serializeCandidates = (rows) => `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;

// Digest of the whole canonical revision Stage 1 compared against (file names + byte digests).
export async function canonicalSnapshotDigest(root) {
  const directory = path.join(root, 'data/canonical');
  let names = [];
  try {
    names = (await readdir(directory)).filter((name) => name.endsWith('.jsonl')).sort(compare);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parts = [];
  for (const name of names) parts.push([name, sha256Hex(await readFile(path.join(directory, name)))]);
  return sha256Hex(JSON.stringify(parts));
}

// Next serial batch id over every id known locally and on the merged base (fail closed upstream).
export function allocateBatchId(knownIds) {
  const numbers = knownIds.filter(isBatchId).map((id) => Number(id.slice(1)));
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  if (next > 999999) throw new Stage1Error(['batch id space exhausted']);
  return `C${String(next).padStart(6, '0')}`;
}

export function summarizeAttempts(attemptLog) {
  const counts = {};
  for (const entry of attemptLog) {
    const row = counts[entry.provider_id] ??= { attempts: 0, resolved: 0, fell_through: 0 };
    row.attempts += 1;
    if (entry.state === 'resolved') row.resolved += 1;
    else if (entry.fallback) row.fell_through += 1;
  }
  return counts;
}

// Canonical comparison summary (issue #275): per-POS routes, the lemmas whose observed forms the
// shared search-form projection does not support (search/morphology coverage route), and holds.
export const routeCounts = (rows, canonicalEntries, support = new Map()) => {
  const index = buildCanonicalIndex(canonicalEntries);
  const counts = { new_entry: 0, new_pos_on_existing_lemma: 0, new_sense_on_existing_entry: 0, lemmas_with_unsupported_forms: 0, unsupported_forms: 0, lemmas_with_holds: 0 };
  for (const row of rows) {
    const { routes, unsupported_forms: unsupported } = classifyLemmaCandidate(row, index, support);
    for (const route of routes) counts[route.route] += 1;
    if (unsupported.length) { counts.lemmas_with_unsupported_forms += 1; counts.unsupported_forms += unsupported.length; }
    if (row.observations.some((observation) => observation.holds.length)) counts.lemmas_with_holds += 1;
  }
  return counts;
};

// Operator metrics: "500" counts unique lemmas. Surfaces, POS/sense hypotheses and observations are
// reported separately and are never part of the bound.
export const batchMetrics = (rows, { unresolved, repeatsMerged }) => {
  const holdsPerReason = {};
  let heldObservations = 0;
  for (const row of rows) {
    for (const observation of row.observations) {
      if (observation.holds.length) heldObservations += 1;
      for (const hold of observation.holds) holdsPerReason[hold] = (holdsPerReason[hold] ?? 0) + 1;
    }
  }
  return {
    unique_lemmas: rows.length,
    observed_forms: rows.reduce((sum, row) => sum + row.forms.length, 0),
    pos_hypotheses: rows.reduce((sum, row) => sum + row.pos_hypotheses.length, 0),
    usage_groups: rows.reduce((sum, row) => sum + row.usage_groups.length, 0),
    observations_total: rows.reduce((sum, row) => sum + row.observation_total, 0),
    observations_retained: rows.reduce((sum, row) => sum + row.observations.length, 0),
    held_observations: heldObservations,
    holds_by_reason: Object.fromEntries(Object.entries(holdsPerReason).sort(([a], [b]) => compare(a, b))),
    unresolved_observations: unresolved.length,
    repeated_evidence_merged: repeatsMerged,
  };
};

// Keep assigned observations outside the candidate rows in an explicit, text-free disposition
// ledger. This includes prior-produced lemmas and lemmas beyond the current batch bound.
function excludedObservationsForBatch({ grouped, selected, deferred, producedLemmas }) {
  const selectedSet = new Set(selected);
  const deferredSet = new Set(deferred);
  const decisionsByObservation = new Map(grouped.decisions.map((decision) => [decision.observation_digest, decision]));
  const excluded = [];
  for (const [lemma, observations] of grouped.lemmas) {
    if (selectedSet.has(lemma)) continue;
    const disposition = producedLemmas.has(lemma) ? 'prior_produced_lemma'
      : deferredSet.has(lemma) ? 'deferred_lemma' : null;
    if (!disposition) throw new Stage1Error([`resolved lemma ${lemma} has no batch disposition`]);
    for (const item of observations.values()) {
      const decision = decisionsByObservation.get(item.observation_digest);
      if (!decision) throw new Stage1Error([`excluded observation for ${lemma} has no ensemble decision trace`]);
      excluded.push({
        disposition,
        lemma,
        pos: item.pos,
        surface: item.surface,
        evidence: item.evidence,
        analysis: { status: 'ok', input_digest: item.digest },
        holds: [...item.holds].sort(compare),
        observation_digest: decision.observation_digest,
        ensemble: item.ensemble,
      });
    }
  }
  return excluded.sort((left, right) => compare(left.disposition, right.disposition) || compare(left.lemma, right.lemma)
    || compare(left.observation_digest, right.observation_digest));
}

// Context decisions must remain bound wherever the corresponding observation is durably represented:
// selected candidate rows, the excluded-observation ledger, or the truth-unknown verification queue.
function contextDecisionsForBatch(grouped, rows, excludedObservations) {
  const retained = new Set([
    ...rows.flatMap((row) => row.observations.map((observation) => observation.ensemble.context_decision).filter(Boolean)),
    ...excludedObservations.map((entry) => entry.ensemble.context_decision).filter(Boolean),
  ]);
  const queuedUnknown = new Set(grouped.unresolved
    .filter((entry) => entry.verification.state === 'truth_unknown')
    .map((entry) => entry.verification.decision_id));
  const retainedRecords = grouped.contextRecords.filter((decision) => RESOLVING_OUTCOMES.includes(decision.outcome)
    ? retained.has(decision.decision_id)
    : queuedUnknown.has(decision.decision_id));
  const remappedIds = new Map(retainedRecords.map((decision, index) => [
    decision.decision_id,
    `D${String(index + 1).padStart(4, '0')}`,
  ]));
  for (const row of rows) for (const observation of row.observations) {
    if (observation.ensemble.context_decision) observation.ensemble.context_decision = remappedIds.get(observation.ensemble.context_decision);
  }
  for (const entry of excludedObservations) {
    if (entry.ensemble.context_decision) entry.ensemble.context_decision = remappedIds.get(entry.ensemble.context_decision);
  }
  for (const entry of grouped.unresolved) {
    if (entry.verification.state === 'truth_unknown') entry.verification.decision_id = remappedIds.get(entry.verification.decision_id);
  }
  return retainedRecords.map((decision) => {
    const remapped = { ...decision, decision_id: remappedIds.get(decision.decision_id) };
    return { ...remapped, decision_sha256: decisionSha256(remapped) };
  });
}

// Manifest blocks of an ensemble batch: v3 binds each source-observation digest to its disposition
// trace, including unresolved and excluded assigned observations.
function ensembleManifestFields({ grouped, rows, excludedObservations, providers, contextRecords }) {
  const contextDecisionsDigest = contextDecisionsSha256(contextRecords);
  const categories = { concordant: 0, supported_alternative: 0, conflicted: 0, unsupported_or_unknown: 0 };
  for (const row of rows) for (const [category, count] of Object.entries(row.review.categories)) categories[category] += count;
  for (const entry of grouped.unresolved) categories[entry.category] += 1;
  for (const entry of excludedObservations) categories[entry.ensemble.category] += 1;
  return {
    ensemble: {
      contract: ENSEMBLE_CONTRACT,
      counts: {
        input_observations: grouped.decisions.length,
        observations: rows.reduce((sum, row) => sum + row.observation_total, 0) + grouped.unresolved.length + excludedObservations.length,
        categories,
        queue: grouped.unresolved.length,
        excluded: excludedObservations.length,
      },
      trace_sha256: ensembleTraceSha256({
        providers,
        observationTraceDigests: rows.flatMap((row) => [JSON.stringify(['review', row.review.trace_sha256]),
          ...row.observations.map((observation) => JSON.stringify([observation.observation_digest, observation.ensemble.trace_digest]))]),
        queueTraceDigests: grouped.unresolved.map((entry) => JSON.stringify([entry.observation_digest, entry.trace_digest])),
        excludedTraceDigests: excludedObservations.map((entry) => JSON.stringify([entry.observation_digest, entry.ensemble.trace_digest])),
        contextDecisionsSha256: contextDecisionsDigest,
      }),
    },
    context_fallback: { contract: CONTEXT_CONTRACT, decisions: contextRecords, decisions_sha256: contextDecisionsDigest },
  };
}

const groupedMetrics = (grouped, observations) => {
  let assigned = 0;
  let held = 0;
  let heldLemmas = 0;
  let pos = 0;
  for (const entry of grouped.lemmas.values()) {
    let lemmaHeld = false;
    const kinds = new Set();
    for (const item of entry.values()) {
      assigned += 1;
      kinds.add(`${item.pos}\u0000${item.group}`);
      if (item.holds.size) { held += 1; lemmaHeld = true; }
    }
    pos += kinds.size;
    if (lemmaHeld) heldLemmas += 1;
  }
  const assignedRepeatsMerged = grouped.assignedRepeatsMerged ?? grouped.repeatsMerged;
  return {
    original_observations: observations.length,
    unique_surfaces: new Set(observations.map((observation) => observation.surface)).size,
    unique_lemmas: grouped.lemmas.size,
    distinct_pos_group_opportunities: pos,
    assigned_observations: assigned + assignedRepeatsMerged,
    assigned_without_holds: assigned + assignedRepeatsMerged - held,
    held_observations: held,
    held_lemmas: heldLemmas,
    unresolved_observations: grouped.unresolved.length,
  };
};

// Same-cohort A/B measurement (issue #285 §3): legacy Kiwi-only vs the three-Provider ensemble vs
// ensemble + recorded contextual fallback, on the SAME observations. It reports what the cohort can
// show; `verified_*` stay `not_established` without an independently adjudicated set, an unknown item
// is never counted as correct, and the lemma denominator counts distinct lemmas, not observations.
export async function compareResolutionPolicies({ observations, kiwiProvider, ensembleProviders, context = null, independentlyAdjudicated = null, sourceLemmas = null }) {
  const timed = async (work) => { const started = performance.now(); const result = await work(); return [result, Math.round(performance.now() - started)]; };
  const [baseline, baselineMs] = await timed(() => buildLemmaGroups({ observations, providers: [kiwiProvider] }));
  const [ensemble, ensembleMs] = await timed(() => buildEnsembleGroups({ observations, providers: ensembleProviders }));
  const report = {
    cohort: { original_observations: observations.length, unique_surfaces: new Set(observations.map((observation) => observation.surface)).size },
    kiwi_only: { ...groupedMetrics(baseline, observations), provider_surface_calls: summarizeAttempts(baseline.attemptLog), ms: baselineMs },
    three_provider_only: {
      ...groupedMetrics(ensemble, observations),
      ...ensembleCohortMetrics({ observations: ensemble.observations, decisions: ensemble.decisions, run: ensemble.run, independentlyAdjudicated }),
      ms: ensembleMs,
    },
    notes: [
      'accuracy is not established without an independently adjudicated set; model votes and AI self-checks are not verified accuracy',
      'words the upstream extractor never proposed are an extractor recall limitation and are not credited to the ensemble',
    ],
  };
  if (sourceLemmas) {
    // Lemmas present in an independently known source set but never proposed by the upstream extractor
    // are an extractor RECALL limitation: the ensemble only analyzes proposed observations, so it can
    // neither discover nor be credited with them.
    const reached = new Set(observations.map((observation) => observation.hint?.input).filter(Boolean));
    const missed = sourceLemmas.filter((lemma) => !reached.has(lemma)).sort(compare);
    report.extractor_recall = {
      source_lemmas: sourceLemmas.length,
      reached_by_extractor: sourceLemmas.length - missed.length,
      not_extracted: missed,
      credited_to_ensemble: missed.filter((lemma) => ensemble.lemmas.has(lemma)).length,
    };
  }
  if (context) {
    const withContext = await buildEnsembleGroups({ observations, providers: ensembleProviders, ...context });
    report.three_provider_plus_context = {
      ...groupedMetrics(withContext, observations),
      ...ensembleCohortMetrics({ observations: withContext.observations, decisions: withContext.decisions, run: withContext.run, contextOutcomes: withContext.contextRecords, independentlyAdjudicated }),
    };
  }
  return report;
}

// Pure producer: evidence + analyzer + canonical → v2 manifest and candidates.jsonl text.
export async function produceCandidateBatch({
  evidence, analyzer, providers, canonicalEntries, canonicalDigest, batchId, taskId, maxCandidates = DEFAULT_MAX_CANDIDATES,
  producedLemmas = new Set(), searchFormSupport = new Map(), producerRevision = null,
  // `provider-resolution-v1` (conditional fallback, default order [kiwi]) stays the explicit compatibility/A-B baseline of
  // the library; the production CLI selects the all-three ensemble by default (docs/lexical-factory-ensemble-v2.md).
  policy = RESOLUTION_POLICY, contextProposals = null, contextReplay = null, contextSource = null, contextAgent = null,
}) {
  if (!isBatchId(batchId)) throw new Stage1Error(['batchId must match C000000']);
  if (!/^T\d{6}$/u.test(String(taskId))) throw new Stage1Error(['taskId must match T000000']);
  const { observations, source } = observationsFromCorpusEvidence(evidence);
  const ordered = providers ?? [createKiwiProvider({ analyze: analyzer })];
  ordered.forEach(assertProvider);
  const ids = ordered.map((provider) => provider.id);
  if (new Set(ids).size !== ids.length) throw new Stage1Error([`duplicate analyzer provider in order: ${ids.join(',')}`]);
  // The manifest still anchors on the pinned Kiwi (analyzer_version/analyzer_digest); Khaiii-only
  // runs are for a successor issue, so Kiwi must be somewhere in the order.
  if (!ids.includes('kiwi')) throw new Stage1Error(['analyzer provider order must include the pinned kiwi provider']);
  if (![RESOLUTION_POLICY, ENSEMBLE_POLICY].includes(policy)) throw new Stage1Error([`unknown resolution policy ${policy}`]);
  const ensemble = policy === ENSEMBLE_POLICY;
  if (!ensemble && (contextProposals || contextReplay)) throw new Stage1Error([`a contextual fallback decision is only valid under ${ENSEMBLE_POLICY}`]);
  const grouped = ensemble
    ? await buildEnsembleGroups({ observations, providers: ordered, contextProposals, contextReplay, contextSource, snapshot: source.source_snapshot, contextAgent })
    : await buildLemmaGroups({ observations, providers: ordered });
  const { attemptLog } = grouped;
  if (grouped.unresolved.length > MAX_UNRESOLVED_OBSERVATIONS) {
    throw new Stage1Error([`${grouped.unresolved.length} observations have no reliable lemma/POS, above the bound ${MAX_UNRESOLVED_OBSERVATIONS}; split the evidence run`]);
  }
  const { selected, deferred, skippedProduced } = selectLemmas({ lemmas: grouped.lemmas, maxCandidates, producedLemmas });
  const rows = selected.map((lemma, index) => buildLemmaRow({ lemma, observations: grouped.lemmas.get(lemma), candidateId: candidateIdFor(batchId, index + 1), ensemble }));
  const excludedObservations = ensemble ? excludedObservationsForBatch({ grouped, selected, deferred, producedLemmas }) : [];
  const contextRecords = ensemble ? contextDecisionsForBatch(grouped, rows, excludedObservations) : [];
  const candidatesText = serializeCandidates(rows);
  // Default [kiwi] omits the provider fields: byte-identical to the pre-provider manifest.
  const providerFields = ids.length === 1 && !ensemble ? {} : { analyzer_providers: ordered.map(providerDescriptor), resolution_policy: policy };
  const anchor = { analyzer_version: `kiwipiepy==${PINNED_ANALYZER.kiwipiepy_version}`, proposal_contract: REQUIRED_PROPOSAL_CONTRACT, ...providerFields };
  const ensembleFields = ensemble ? ensembleManifestFields({ grouped, rows, excludedObservations, providers: providerFields.analyzer_providers, contextRecords }) : {};
  const manifest = {
    contract: LEMMA_CANDIDATE_MANIFEST_CONTRACT,
    lemma_policy: LEMMA_POLICY,
    task_id: taskId,
    batch_id: batchId,
    candidate_count: rows.length,
    observation_count: rows.reduce((sum, row) => sum + row.observation_total, 0),
    selection: { bound: maxCandidates, eligible_lemma_count: selected.length + deferred.length, deferred_lemma_count: deferred.length },
    unresolved_observations: grouped.unresolved,
    ...(ensemble ? { excluded_observations: excludedObservations } : {}),
    source_adapter: CORPUS_SOURCE_ADAPTER,
    source_snapshot: source.source_snapshot,
    canonical_snapshot_digest: canonicalDigest,
    ...(producerRevision ? { producer_revision: producerRevision } : {}),
    extractor_version: source.extractor_version,
    analyzer_version: anchor.analyzer_version,
    analyzer_digest: expectedAnalyzerDigest(anchor),
    proposal_contract: REQUIRED_PROPOSAL_CONTRACT,
    ...providerFields,
    ...ensembleFields,
    source_evidence_sha256: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
    candidates_sha256: sha256Hex(candidatesText),
    status: 'created',
  };
  const errors = validateCandidateBatch({ manifest, candidatesText });
  if (errors.length) throw new Stage1Error(errors);
  return {
    manifest,
    attemptLog,
    candidatesText,
    rows,
    ensemble: ensemble ? { decisions: grouped.decisions, run: grouped.run } : null,
    summary: {
      effectivePolicy: policy,
      providerOrder: ids,
      providerAttempts: ensemble ? grouped.run.calls : summarizeAttempts(attemptLog),
      ...(ensemble ? { ensemble: ensembleCohortMetrics({ observations: grouped.observations, decisions: grouped.decisions, run: grouped.run, contextOutcomes: grouped.contextRecords }) } : {}),
      candidates: rows.length,
      omittedNonTokenSurfaceHits: source.omitted_non_token_surface_hits,
      deferredLemmas: deferred,
      skippedProducedLemmas: skippedProduced,
      metrics: batchMetrics(rows, grouped),
      routes: routeCounts(rows, canonicalEntries, searchFormSupport),
    },
  };
}
