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

function interpret(candidate, outcome) {
  if (!outcome) return { hold: 'analysis_missing' };
  if (outcome.status === 'error') return { hold: 'analysis_error' };
  if (outcome.status === 'unsupported') return { hold: 'analysis_unsupported' };
  const matching = (outcome.proposals ?? []).filter((proposal) => proposal.lemma === candidate.input);
  // The whole input must be explained by one lemma; a substring match is not proof.
  if (outcome.proposals.length !== 1 || matching.length !== 1) return { hold: 'lemma_mismatch' };
  if (outcome.status === 'ambiguous') return { hold: 'analysis_ambiguous', proposedPos: matching[0].pos };
  if (candidate.pos && candidate.pos !== matching[0].pos) return { hold: 'pos_mismatch', proposedPos: matching[0].pos };
  return { proposedPos: matching[0].pos };
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
  const outcomes = new Map(analysis.results.map((outcome) => [outcome.id, outcome]));

  const decisions = unique.map((candidate) => {
    const base = { key: candidate.key, input: candidate.input, adapterId: candidate.adapterId, duplicateCount: candidate.duplicateCount };
    if (candidate.holds.length) return { ...base, decision: 'hold', holds: candidate.holds };
    if (coveredLemmas.has(candidate.input)) return { ...base, decision: 'covered', holds: [] };
    const outcome = outcomes.get(candidate.key);
    const result = interpret(candidate, outcome);
    if (outcome && outcome.input_digest !== undefined && outcome.input_digest !== analysisInputDigest(candidate.input)) {
      return { ...base, decision: 'hold', holds: ['analysis_stale'] };
    }
    if (result.hold) return { ...base, decision: 'hold', holds: [result.hold], proposedPos: result.proposedPos ?? null };
    return {
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
  const expected = bindingFor({ input: record.lemma, lemma: record.lemma, pos: record.pos, metadata });
  if (record.analysisBinding !== expected) {
    throw new Error(`Stale or mismatched analysis binding for ${record.lemma}/${record.pos}`);
  }
  return true;
}
