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
  CANDIDATE_MANIFEST_CONTRACT,
  MAX_EVIDENCE_REFERENCES,
  expectedAnalyzerDigest,
  candidateIdFor,
  isBatchId,
  sha256Hex,
  validateCandidateBatch,
} from './contract.mjs';
import { buildCanonicalIndex, classifyAgainstCanonical } from './identity-adapter.mjs';

// Factory Stage 1 producer library (issue #264; design docs/lexical-production-factory.md §2).
// It turns text-free corpus evidence into one immutable candidate batch. It never writes review
// rows, glosses, canonical records or paragraph text, and it does not touch the legacy
// candidateKey/dedupeCandidates/coveredLemmas path.

export const CORPUS_EVIDENCE_CONTRACT = 'm9-corpus-candidate-evidence-v1';
export const CORPUS_SOURCE_ADAPTER = 'corpus-adapter';
// Stage 1 interprets `derived_from_index`; a service without this proposal contract is refused.
export const REQUIRED_PROPOSAL_CONTRACT = 'derivation-root-v1';
export const DEFAULT_MAX_CANDIDATES = 500;
export const HARD_MAX_CANDIDATES = 1000;

// Exactly the fields `safeEvidenceHit` of the extractor may emit; anything else (a context,
// paragraph form or text) is raw corpus text that must never reach Git.
const SAFE_HIT_FIELDS = new Set(['source_path', 'corpus_id', 'document_id', 'document_ordinal', 'paragraph_id',
  'paragraph_ordinal', 'source_category', 'source_year', 'matched_surface_form', 'matched_morpheme_span_surface']);
const KOREAN_WORD = /^[가-힣]+$/u;

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
    }
    const holds = extractorHolds(candidate);
    const forms = [...new Set((candidate.observed_surface_forms ?? []).map((form) => normalizeText(form.surface)).filter(Boolean))].sort(compare);
    const base = { hint: { input, pos }, holds };
    if (hits.length === 0) {
      // No located paragraph: keep the candidate visible, explicitly held, never fabricate a reference.
      const surface = forms[0] ?? input;
      observations.push({ ...base, surface, holds: [...holds, 'no_evidence'], ref: { kind: 'corpus-surface', ref: surface } });
      return;
    }
    for (const hit of hits) {
      const surface = normalizeText(hit.matched_surface_form) || forms[0] || input;
      observations.push({ ...base, surface, ref: { kind: 'corpus-paragraph', ref: `${hit.document_id}#${hit.paragraph_id}` } });
    }
  });
  if (errors.length) throw new Stage1Error(errors);
  return {
    observations,
    source: {
      source_snapshot: `corpus:${manifestDigest}:${rowsDigest}`,
      extractor_version: evidence.extractor.extractor_version,
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

const keyOf = (usage) => `${usage.input}\u0000${usage.pos}\u0000${usage.ref.kind}\u0000${usage.ref.ref}`;

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
    const raw = new Map((Array.isArray(response.results) ? response.results : []).map((outcome) => [outcome?.id, outcome]));
    const normalized = new Map(requests.map((request) => [request.id, normalizeProviderResult(provider, request, raw.get(request.id))]));
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

// Groups observations into distinguishable usages. Only an identical (lemma, POS, evidence
// reference) is a repeat and merges; same lemma/POS at another reference stays a separate row.
export async function buildUsages({ observations, analyzer, providers = [createKiwiProvider({ analyze: analyzer })] }) {
  const { resolutions, metadataByProvider, attemptLog } = await resolveWithProviders({ observations, providers });
  const usages = new Map();
  observations.forEach((observation, index) => {
    const resolved = resolutions[index];
    if (!KOREAN_WORD.test(resolved.lemma ?? '') || !POS_VALUES.includes(resolved.pos)) {
      throw new Stage1Error([`cannot represent ${observation.surface}: no dictionary-form lemma/POS from analysis or extractor hint`]);
    }
    const draft = { input: resolved.lemma, pos: resolved.pos, ref: observation.ref };
    const usage = usages.get(keyOf(draft)) ?? { ...draft, forms: new Set(), holds: new Set(), repeats: 0 };
    usage.repeats += 1;
    usage.forms.add(observation.surface);
    for (const hold of [...observation.holds, ...resolved.holds]) usage.holds.add(hold);
    usages.set(keyOf(draft), usage);
  });
  return { usages: [...usages.values()], metadataByProvider, attemptLog };
}

// One factory row per usage; ids follow the sorted order so replay is byte-identical.
export function buildCandidateRows({ usages, batchId, maxCandidates = DEFAULT_MAX_CANDIDATES, producedUsageKeys = new Set() }) {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > HARD_MAX_CANDIDATES) {
    throw new Stage1Error([`max candidates must be an integer from 1 to ${HARD_MAX_CANDIDATES}`]);
  }
  const fresh = usages.filter((usage) => !producedUsageKeys.has(keyOf(usage)));
  if (fresh.length === 0) throw new Stage1Error(['no unprocessed usages: every usage in the evidence is already in an existing candidate batch (source exhausted)']);
  const ordered = [...fresh].sort((a, b) => compare(a.input, b.input) || compare(a.pos, b.pos) || compare(a.ref.kind, b.ref.kind) || compare(a.ref.ref, b.ref.ref));
  // Whole lemma groups only, so a lemma's usages never split across batches.
  const groups = new Map();
  for (const usage of ordered) groups.set(usage.input, [...(groups.get(usage.input) ?? []), usage]);
  const selected = [];
  const deferredLemmas = [];
  for (const [lemma, group] of groups) {
    if (group.length > maxCandidates) throw new Stage1Error([`lemma ${lemma} alone has ${group.length} usages, above the batch bound ${maxCandidates}`]);
    if (deferredLemmas.length === 0 && selected.length + group.length <= maxCandidates) selected.push(...group);
    else deferredLemmas.push(lemma);
  }
  const rows = selected.map((usage, index) => {
    const forms = [...usage.forms].sort(compare);
    return {
      candidate_id: candidateIdFor(batchId, index + 1),
      input: usage.input,
      pos: usage.pos,
      usage_hint: `provisional: ${usage.pos} usage observed as ${forms.join('/')}; sense undecided (Stage 2)`,
      observedForms: forms,
      evidence: [usage.ref, ...forms.slice(0, MAX_EVIDENCE_REFERENCES - 1)
        .map((form) => ({ kind: 'corpus-surface', ref: form })).filter((entry) => entry.ref !== usage.ref.ref)].slice(0, MAX_EVIDENCE_REFERENCES),
      holds: [...usage.holds].filter((hold) => HOLD_REASONS.includes(hold)).sort(compare),
    };
  });
  return { rows, deferredLemmas, skippedProduced: usages.length - fresh.length, repeatsMerged: selected.reduce((sum, usage) => sum + usage.repeats - 1, 0) };
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

export const routeCounts = (rows, canonicalEntries) => {
  const index = buildCanonicalIndex(canonicalEntries);
  const counts = { new_entry: 0, new_pos_on_existing_lemma: 0, new_sense_on_existing_entry: 0, held: 0 };
  for (const row of rows) {
    counts[classifyAgainstCanonical(row, index).route] += 1;
    if (row.holds.length) counts.held += 1;
  }
  return counts;
};

// Pure producer: evidence + analyzer + canonical → manifest and candidates.jsonl text.
export async function produceCandidateBatch({
  evidence, analyzer, providers, canonicalEntries, canonicalDigest, batchId, taskId, maxCandidates = DEFAULT_MAX_CANDIDATES, producedUsageKeys = new Set(),
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
  const { usages, attemptLog } = await buildUsages({ observations, providers: ordered });
  const { rows, deferredLemmas, repeatsMerged, skippedProduced } = buildCandidateRows({ usages, batchId, maxCandidates, producedUsageKeys });
  const candidatesText = serializeCandidates(rows);
  // Default [kiwi] omits the provider fields: byte-identical to the pre-provider manifest.
  const providerFields = ids.length === 1 ? {} : { analyzer_providers: ordered.map(providerDescriptor), resolution_policy: RESOLUTION_POLICY };
  const anchor = { analyzer_version: `kiwipiepy==${PINNED_ANALYZER.kiwipiepy_version}`, proposal_contract: REQUIRED_PROPOSAL_CONTRACT, ...providerFields };
  const manifest = {
    contract: CANDIDATE_MANIFEST_CONTRACT,
    task_id: taskId,
    batch_id: batchId,
    candidate_count: rows.length,
    source_adapter: CORPUS_SOURCE_ADAPTER,
    source_snapshot: source.source_snapshot,
    canonical_snapshot_digest: canonicalDigest,
    extractor_version: source.extractor_version,
    analyzer_version: anchor.analyzer_version,
    analyzer_digest: expectedAnalyzerDigest(anchor),
    proposal_contract: REQUIRED_PROPOSAL_CONTRACT,
    ...providerFields,
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
    summary: { providerOrder: ids, providerAttempts: summarizeAttempts(attemptLog), candidates: rows.length, deferredLemmas, skippedProduced, repeatsMerged, routes: routeCounts(rows, canonicalEntries) },
  };
}
