import { createHash } from 'node:crypto';

import {
  dedupeCandidates,
  digest,
  normalizeCandidate,
  validateCandidate,
} from './candidate-contract.mjs';

// Shared, source-agnostic intake stages (issue #249):
//   contract → dedupe → Kiwi analysis → coverage → QA hand-off / HOLD.
// This module must not import or reference any adapter.

export const PINNED_RUN = Object.freeze({ service_version: '1', top_n: 3 });
export const PINNED_ANALYZER = Object.freeze({ kiwipiepy_version: '0.24.0', kiwipiepy_model_version: '0.24.0' });

export function assertPinnedAnalyzer(metadata) {
  if (metadata === null || typeof metadata !== 'object') {
    throw new Error('Analyzer metadata is required to verify the pinned analyzer');
  }
  for (const [key, expected] of Object.entries(PINNED_RUN)) {
    if (metadata[key] !== expected) throw new Error(`Analyzer ${key} ${metadata[key] ?? 'missing'} does not match supported ${expected}`);
  }
  for (const [key, expected] of Object.entries(PINNED_ANALYZER)) {
    if (metadata?.[key] !== expected) {
      throw new Error(`Analyzer ${key} ${metadata?.[key] ?? 'unknown'} does not match pinned ${expected}`);
    }
  }
}

export function analyzerDigest(metadata) {
  return digest([metadata?.service_version, metadata?.kiwipiepy_version, metadata?.kiwipiepy_model_version, metadata?.top_n]);
}

// Mirrors kiwi_service: sha256 of the NFC-trimmed UTF-8 input (hex).
export function analysisInputDigest(input) {
  return createHash('sha256').update(input.normalize('NFC').trim(), 'utf8').digest('hex');
}

// Binding ties a verified analysis to exactly one input/lemma/POS and analyzer.
function bindingFor({ input, lemma, pos, metadata }) {
  return digest(['analysis-binding', input, lemma, pos, analyzerDigest(metadata)]);
}

// Interpret ranked Kiwi analyses of a citation form. The best analysis must
// explain the whole input as exactly one lemma (a substring match is not proof).
// Another analysis claiming the same lemma with a different POS is ambiguity;
// a noun reading of a verb/adjective-shaped "...다" input is an OOV artifact.
function interpret(candidate, outcome) {
  if (!outcome) return { hold: 'analysis_missing' };
  if (outcome.status === 'error') return { hold: 'analysis_error' };
  if (outcome.status !== 'ok') return { hold: 'analysis_unsupported' };
  // Derived predicates (망각 + 하다) also list their base noun; any other extra
  // morpheme means the input is a multi-morpheme string, not one lemma.
  const wholeInput = (analysis) => {
    const hits = analysis.filter((item) => item.lemma === candidate.input);
    const others = analysis.filter((item) => item.lemma !== candidate.input);
    return hits.length === 1 && others.every((item) => candidate.input.startsWith(item.lemma)) ? hits[0] : null;
  };
  const [best, ...alternatives] = outcome.analyses;
  const match = wholeInput(best ?? []);
  if (!match) return { hold: 'lemma_mismatch' };
  const rivals = alternatives
    .map(wholeInput)
    .filter((rival) => rival && rival.pos !== match.pos && !(rival.pos === 'noun' && candidate.input.endsWith('다')));
  if (rivals.length) return { hold: 'analysis_ambiguous', proposedPos: match.pos };
  if (candidate.pos && candidate.pos !== match.pos) return { hold: 'pos_mismatch', proposedPos: match.pos };
  return { proposedPos: match.pos };
}

// Deterministic judgement of one analysis outcome (stale check, then interpretation).
// Exported so a stored hand-off can be recomputed instead of trusted.
export function judgeOutcome(candidate, outcome) {
  const result = interpret(candidate, outcome);
  if (outcome && outcome.input_digest !== analysisInputDigest(candidate.input)) return { hold: 'analysis_stale' };
  return result;
}

// The text-free part of a Kiwi outcome needed to re-derive the decision.
export function boundedOutcome(outcome) {
  if (!outcome) return null;
  return { status: outcome.status, input_digest: outcome.input_digest, analyses: outcome.analyses ?? [] };
}

export async function runIntake({ candidates, analyzer, coveredLemmas = new Set(), adapterId = 'unspecified' }) {
  const normalized = candidates.map((raw) => normalizeCandidate(raw, { adapterId: raw.adapterId ?? adapterId }));
  for (const candidate of normalized) {
    const errors = validateCandidate(candidate);
    if (errors.length) throw new Error(`Invalid candidate contract: ${errors.join(', ')}`);
  }
  const unique = dedupeCandidates(normalized);
  const analyzable = unique.filter((candidate) => candidate.holds.length === 0 && !coveredLemmas.has(candidate.input));
  const analysis = analyzable.length
    ? await analyzer(analyzable.map((candidate) => ({ id: candidate.key, text: candidate.input })))
    : { metadata: null, results: [] };
  // A real analysis request always needs verifiable, pinned run metadata.
  if (analyzable.length > 0) assertPinnedAnalyzer(analysis.metadata);
  const outcomes = new Map(analysis.results.map((outcome) => [outcome.id, outcome]));

  const decisions = unique.map((candidate) => {
    const base = { key: candidate.key, input: candidate.input, adapterIds: candidate.adapterIds, duplicateCount: candidate.duplicateCount };
    if (candidate.holds.length) return { ...base, decision: 'hold', holds: candidate.holds };
    if (coveredLemmas.has(candidate.input)) return { ...base, decision: 'covered', holds: [] };
    const outcome = outcomes.get(candidate.key);
    const result = judgeOutcome(candidate, outcome);
    if (result.hold) return { ...base, decision: 'hold', holds: [result.hold], proposedPos: result.proposedPos ?? null, outcome: boundedOutcome(outcome) };
    return {
      outcome: boundedOutcome(outcome),
      ...base,
      decision: 'semantic_qa',
      holds: [],
      lemma: candidate.input,
      pos: result.proposedPos,
      observedForms: candidate.observedForms,
      evidence: candidate.evidence,
      analysisBinding: bindingFor({ input: candidate.input, lemma: candidate.input, pos: result.proposedPos, metadata: analysis.metadata }),
    };
  });
  return { contractVersion: 1, analyzerDigest: analysis.metadata ? analyzerDigest(analysis.metadata) : null, metadata: analysis.metadata, decisions };
}

// Downstream admission re-verifies a hand-off against the analysis run that
// produced it; stale or mismatched bindings fail loudly (no regex fallback).
export function verifyAnalysisBinding(record, metadata) {
  assertPinnedAnalyzer(metadata);
  const expected = bindingFor({ input: record.lemma, lemma: record.lemma, pos: record.pos, metadata });
  if (record.analysisBinding !== expected) {
    throw new Error(`Stale or mismatched analysis binding for ${record.lemma}/${record.pos}`);
  }
  return true;
}
