import { createHash } from 'node:crypto';

import { CORPUS_ADAPTER_ID, corpusAdapter, corpusHolds } from './adapters/corpus-adapter.mjs';
import { SYNTHETIC_ADAPTER_ID, syntheticAdapter } from './adapters/synthetic-adapter.mjs';
import { dedupeCandidates, digest, normalizeCandidate } from './candidate-contract.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';
import { analyzerDigest, assertPinnedAnalyzer, judgeOutcome, runIntake, verifyAnalysisBinding } from './pipeline.mjs';

// Production hand-off (issue #251, PR A): the bounded, text-free artifact that
// carries one batch's source-neutral intake result into the existing shared
// batch builder, self-check and admission. It adds binding and fail-closed
// checks only; it never admits, glosses, or replaces `validateLexicalAddition`.
export const PRODUCTION_HANDOFF_CONTRACT = 'intake-production-handoff-v1';
export const PRODUCTION_QA_BINDING_CONTRACT = 'intake-production-qa-binding-v1';

// Holds that can never be admitted through manual resolution: the input is not
// a lexical identity, is already owned, or the analysis itself is unusable.
export const HARD_HOLDS = Object.freeze([
  'missing_lemma', 'unresolved_pos', 'invalid_input', 'no_evidence', 'coverage_collision',
  'analysis_error', 'analysis_mismatch', 'analysis_stale', 'analysis_missing',
]);
// Analyzer uncertainty that bounded contexts may legitimately resolve (a
// compound Kiwi splits, an out-of-vocabulary word, a homograph). It requires an
// explicit, evidence-citing resolution; it is neither an auto-hold nor a pass.
export const REVIEWABLE_HOLDS = Object.freeze([
  'analysis_ambiguous', 'analysis_unsupported', 'lemma_mismatch', 'pos_mismatch', 'frame_not_verified',
]);

export class ProductionHandoffError extends Error {
  constructor(message, code = 'INTAKE_HANDOFF') {
    super(message);
    this.name = 'ProductionHandoffError';
    this.code = code;
  }
}

const fail = (message, code) => { throw new ProductionHandoffError(message, code); };
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Maps the batch's analysis inventory + text-free evidence onto the common
// candidate contract (the CorpusAdapter), in inventory order.
export function corpusBatchCandidates(inventory, evidence) {
  if (!Array.isArray(inventory?.candidates) || !Array.isArray(evidence?.candidates)
    || inventory.candidates.length !== evidence.candidates.length) {
    fail('candidate inventory and evidence must be parallel arrays', 'INTAKE_HANDOFF_INPUT');
  }
  return corpusAdapter({
    candidates: inventory.candidates.map((candidate, index) => ({ ...candidate, evidence: evidence.candidates[index].evidence })),
  });
}

// Source adapters the batch builder can be fed from. The builder consumes the
// batch's inventory/evidence files; the adapter named by the hand-off decides how
// those are read into the common contract. The synthetic adapter reads only the
// submitted word and POS (no contextual evidence enters the contract); contexts a
// reviewer cites live in the builder's own bounded `representative_hits`.
export const BATCH_SOURCE_ADAPTERS = Object.freeze({
  [CORPUS_ADAPTER_ID]: corpusBatchCandidates,
  [SYNTHETIC_ADAPTER_ID]: (inventory) => syntheticAdapter(
    // Holds recorded in the batch inventory are facts about the candidate, not about the
    // adapter that reads it: choosing another adapter can never drop them.
    (inventory?.candidates ?? []).map((candidate) => ({ word: candidate.proposed_lemma, pos: candidate.proposed_pos ?? null, holds: corpusHolds(candidate) })),
  ),
});

export function batchCandidatesFor(adapterId, inventory, evidence) {
  const read = BATCH_SOURCE_ADAPTERS[adapterId];
  if (!read) fail(`unknown batch source adapter ${adapterId}`, 'INTAKE_HANDOFF_ADAPTER');
  const candidates = read(inventory, evidence);
  // Whatever adapter the hand-off names, the inventory's own holds must survive.
  (inventory?.candidates ?? []).forEach((source, index) => {
    const have = new Set(normalizeCandidate(candidates[index], { adapterId }).holds);
    for (const hold of corpusHolds(source)) {
      if (!have.has(hold)) fail(`${source.proposed_lemma}: batch inventory hold ${hold} was dropped by adapter ${adapterId}`, 'INTAKE_HANDOFF_HOLD_DROPPED');
    }
  });
  return candidates;
}

function normalizedAndMerged(rawCandidates, adapterId) {
  const normalized = rawCandidates.map((raw) => normalizeCandidate(raw, { adapterId: raw.adapterId ?? adapterId }));
  return { normalized, merged: dedupeCandidates(normalized) };
}

// Digest of exactly what the analysis was asked about, in contract form.
export function handoffInputDigest(rawCandidates, adapterId = 'unspecified') {
  const { merged } = normalizedAndMerged(rawCandidates, adapterId);
  return digest(['production-handoff-input', merged.map((candidate) => [candidate.key, candidate.adapterIds, candidate.observedForms, candidate.evidence, candidate.holds])]);
}

export async function buildProductionHandoff({ batchId, rawCandidates, analyzer, coveredLemmas = new Set(), adapterId = 'unspecified' }) {
  const run = await runIntake({ candidates: rawCandidates, analyzer, coveredLemmas, adapterId });
  return {
    contract_version: PRODUCTION_HANDOFF_CONTRACT,
    batch_id: batchId,
    source_adapter: adapterId,
    input_digest: handoffInputDigest(rawCandidates, adapterId),
    analyzer_digest: run.analyzerDigest,
    analyzer: run.metadata,
    entries: run.decisions.map((decision) => ({
      key: decision.key,
      input: decision.input,
      decision: decision.decision,
      holds: decision.holds,
      adapter_ids: decision.adapterIds,
      duplicate_count: decision.duplicateCount,
      ...(decision.outcome ? { analysis_outcome: decision.outcome } : {}),
      ...(decision.decision === 'semantic_qa'
        ? { pos: decision.pos, observed_forms: decision.observedForms, evidence: decision.evidence, analysis_binding: decision.analysisBinding }
        : { proposed_pos: decision.proposedPos ?? null }),
    })),
  };
}

function entryRunShape(entry) {
  return {
    lemma: entry.input,
    pos: entry.pos,
    analysisBinding: entry.analysis_binding,
  };
}

// An analysis was requested exactly when some entry carries an outcome. Then the
// pinned analyzer metadata is mandatory; a batch with nothing to analyze (all
// covered / all adapter-held) legitimately records no analyzer at all.
function checkAnalyzerRecord(handoff) {
  const requested = handoff.entries.some((entry) => entry.analysis_outcome);
  if (requested) {
    try { assertPinnedAnalyzer(handoff.analyzer); } catch (error) { fail(error.message, 'INTAKE_HANDOFF_ANALYZER'); }
    if (handoff.analyzer_digest !== analyzerDigest(handoff.analyzer)) fail('intake hand-off analyzer digest is stale', 'INTAKE_HANDOFF_ANALYZER');
  } else if ((handoff.analyzer ?? null) !== null || (handoff.analyzer_digest ?? null) !== null) {
    fail('intake hand-off records an analyzer although no analysis was requested', 'INTAKE_HANDOFF_ANALYZER');
  }
}

function assertDecisionFollowsOutcome(entry, candidate) {
  if (!entry.analysis_outcome) fail(`${candidate.input}: hand-off lacks the analysis outcome its decision rests on`, 'INTAKE_HANDOFF_OUTCOME');
  const judged = judgeOutcome(candidate, entry.analysis_outcome);
  const expectedDecision = judged.hold ? 'hold' : 'semantic_qa';
  const expectedHolds = judged.hold ? [judged.hold] : [];
  if (entry.decision !== expectedDecision || !sameJson(entry.holds, expectedHolds)
    || (!judged.hold && entry.pos !== judged.proposedPos)) {
    fail(`${candidate.input}: hand-off decision does not follow from its recorded analysis`, 'INTAKE_HANDOFF_DECISION');
  }
}

// Revalidates a hand-off against the batch inputs at the trust boundary: pinned
// analyzer, per-entry analysis bindings, and exact agreement with what the
// shared contract stages derive from the current inventory/evidence (so changed
// input, removed/reordered evidence, or a dropped adapter cannot keep a prior
// disposition). The Kiwi service is not needed; this is deterministic.
export function verifyProductionHandoff(handoff, { rawCandidates, batchId, adapterId = 'unspecified' }) {
  if (handoff?.contract_version !== PRODUCTION_HANDOFF_CONTRACT) fail('intake hand-off has an unsupported contract version', 'INTAKE_HANDOFF_CONTRACT');
  if (handoff.batch_id !== batchId) fail('intake hand-off is bound to a different batch', 'INTAKE_HANDOFF_BATCH');
  if (!Array.isArray(handoff.entries)) fail('intake hand-off needs entries', 'INTAKE_HANDOFF_CONTRACT');
  const { merged } = normalizedAndMerged(rawCandidates, adapterId);
  if (handoff.input_digest !== handoffInputDigest(rawCandidates, adapterId)) {
    fail('intake hand-off input digest does not match the current candidate inventory and evidence', 'INTAKE_HANDOFF_INPUT_DIGEST');
  }
  checkAnalyzerRecord(handoff);
  if (handoff.entries.length !== merged.length) fail('intake hand-off does not cover exactly the current candidates', 'INTAKE_HANDOFF_COVERAGE');
  const byKey = new Map(handoff.entries.map((entry) => [entry.key, entry]));
  if (byKey.size !== handoff.entries.length) fail('intake hand-off has duplicate candidate identities', 'INTAKE_HANDOFF_DUPLICATE');
  for (const candidate of merged) {
    const entry = byKey.get(candidate.key);
    if (!entry) fail(`intake hand-off is missing candidate ${candidate.input}`, 'INTAKE_HANDOFF_COVERAGE');
    if (!sameJson(entry.adapter_ids, candidate.adapterIds)) fail(`${candidate.input}: contributing adapters changed`, 'INTAKE_HANDOFF_ADAPTERS');
    // Adapter-observed holds are preserved by every decision branch: a held
    // candidate can never be re-labelled semantic_qa or covered.
    if (candidate.holds.length && (entry.decision !== 'hold' || candidate.holds.some((hold) => !entry.holds.includes(hold)))) {
      fail(`${candidate.input}: adapter hold ${candidate.holds.join(', ')} was not preserved`, 'INTAKE_HANDOFF_HOLD_DROPPED');
    }
    // Analyzer-originated decisions are recomputed from the stored, bounded Kiwi
    // outcome, so an analysis hold cannot be relabelled semantic_qa (or vice versa).
    if (!candidate.holds.length && entry.decision !== 'covered') assertDecisionFollowsOutcome(entry, candidate);
    if (entry.decision === 'semantic_qa') {
      if (!sameJson(entry.evidence, candidate.evidence) || !sameJson(entry.observed_forms, candidate.observedForms)) {
        fail(`${candidate.input}: evidence references changed since analysis`, 'INTAKE_HANDOFF_EVIDENCE');
      }
      try { verifyAnalysisBinding(entryRunShape(entry), handoff.analyzer); } catch (error) { fail(error.message, 'INTAKE_HANDOFF_ANALYSIS_BINDING'); }
    } else if (entry.decision === 'hold') {
      // Holds are checked above; nothing further to compare.
    } else if (entry.decision !== 'covered') {
      fail(`${candidate.input}: unknown hand-off decision ${entry.decision}`, 'INTAKE_HANDOFF_CONTRACT');
    }
  }
  return true;
}

// Authenticates the recorded analysis: re-runs the pinned local analyzer on the
// current candidates and requires a byte-equal hand-off (entries, outcomes,
// metadata). Without this, stored outcomes are only self-consistent. `covered`
// entries are taken as recorded; a forged `covered` can only block, never admit.
export async function assertHandoffMatchesFreshAnalysis(handoff, { rawCandidates, batchId, analyzer, adapterId = 'unspecified' }) {
  const coveredLemmas = new Set(handoff.entries.filter((entry) => entry.decision === 'covered').map((entry) => entry.input));
  const fresh = await buildProductionHandoff({ batchId, rawCandidates, analyzer, coveredLemmas, adapterId });
  if (!sameJson(fresh, handoff)) {
    fail('intake hand-off does not match a fresh run of the pinned analyzer on the current candidates', 'INTAKE_HANDOFF_FRESH_ANALYSIS');
  }
  return true;
}

// Binds one authored review (the exact gloss digest and admitted POS) to the
// exact reviewed hand-off entry. Any change to input, evidence, analyzer, POS,
// decision or gloss yields a different binding.
export function handoffQaBinding(handoff, entry, { glossSha256, pos }) {
  return sha256(JSON.stringify([
    PRODUCTION_QA_BINDING_CONTRACT, handoff.input_digest, handoff.analyzer_digest, entry.key, entry.decision, entry.holds,
    entry.adapter_ids, entry.evidence ?? [], entry.analysis_binding ?? null, pos, glossSha256,
  ]));
}

export function handoffEntryFor(handoff, { lemma, proposedPos }) {
  const matches = handoff.entries.filter((entry) => entry.input === lemma && (entry.pos ?? entry.proposed_pos ?? null) === (proposedPos ?? null));
  if (matches.length > 1) fail(`${lemma}: ambiguous hand-off identity`, 'INTAKE_HANDOFF_DUPLICATE');
  return matches[0] ?? handoff.entries.find((entry) => entry.input === lemma);
}

// Admission gate for one authored review row. `integration.bindings[lemma]` is
// the review's recorded binding; `resolutions[lemma]` is the explicit,
// evidence-citing resolution of a reviewable analyzer hold.
export function assertHandoffAdmits(handoff, { lemma, proposedPos, finalPos, glossSha256, integration, hitCount }) {
  const entry = handoffEntryFor(handoff, { lemma, proposedPos });
  if (!entry) fail(`${lemma}: admitted candidate is absent from the intake hand-off`, 'INTAKE_HANDOFF_MISSING_CANDIDATE');
  if (entry.decision === 'covered') fail(`${lemma}: already covered by canonical data`, 'INTAKE_HANDOFF_COVERED');
  const resolution = integration?.resolutions?.[lemma];
  if (entry.decision === 'hold') {
    const hard = entry.holds.filter((hold) => HARD_HOLDS.includes(hold) || !REVIEWABLE_HOLDS.includes(hold));
    if (hard.length) fail(`${lemma}: intake hold ${hard.join(', ')} cannot be admitted`, 'INTAKE_HANDOFF_HELD');
    assertResolution(lemma, resolution, hitCount);
  } else if (entry.pos !== finalPos) {
    assertResolution(lemma, resolution, hitCount);
  }
  const binding = integration?.bindings?.[lemma];
  if (!binding || binding !== handoffQaBinding(handoff, entry, { glossSha256, pos: finalPos })) {
    fail(`${lemma}: semantic review is not bound to this intake hand-off entry, POS and gloss`, 'INTAKE_HANDOFF_QA_BINDING');
  }
  return entry;
}

function assertResolution(lemma, resolution, hitCount) {
  const indices = resolution?.checked_hit_indices;
  const ok = Array.isArray(indices) && indices.length > 0
    && indices.every((index) => Number.isInteger(index) && index >= 0 && (hitCount === undefined || index < hitCount))
    && typeof resolution.rationale === 'string' && resolution.rationale.trim().length > 0;
  if (!ok) fail(`${lemma}: an analyzer-uncertain candidate needs an explicit resolution citing the contexts it checked`, 'INTAKE_HANDOFF_HOLD_UNRESOLVED');
}

// Shape stored in the semantic review input (`intake_handoff`).
export function integrationBlock(handoff, handoffBytes, { bindings, resolutions = {} }) {
  return {
    contract_version: PRODUCTION_QA_BINDING_CONTRACT,
    handoff_sha256: sha256(handoffBytes),
    bindings,
    resolutions,
  };
}

// Validates the review input's integration block against the hand-off and the
// candidate rows. Every admitted row must be bound; a held candidate may not
// carry a binding or review.
export function assertReviewsBoundToHandoff({ handoff, handoffBytes, integration, admittedRows, hitCountByLemma }) {
  if (integration?.contract_version !== PRODUCTION_QA_BINDING_CONTRACT) fail('semantic review input lacks the intake integration block', 'INTAKE_HANDOFF_QA_BINDING');
  if (integration.handoff_sha256 !== sha256(handoffBytes)) fail('semantic review input is bound to a different intake hand-off', 'INTAKE_HANDOFF_QA_BINDING');
  const lemmas = admittedRows.map((row) => row.lemma);
  const bound = Object.keys(integration.bindings ?? {}).sort();
  if (!sameJson(bound, [...lemmas].sort())) fail('intake bindings must exist exactly for the admitted candidates', 'INTAKE_HANDOFF_QA_BINDING');
  for (const row of admittedRows) {
    assertHandoffAdmits(handoff, {
      lemma: row.lemma,
      proposedPos: row.proposedPos,
      finalPos: row.finalPos,
      glossSha256: row.glossSha256,
      integration,
      hitCount: hitCountByLemma?.get(row.lemma),
    });
  }
  return true;
}

// Offline re-check of a tracked hand-off against the tracked candidate review and
// semantic review input (no local corpus or Kiwi needed). Used by the batch
// validator so a committed hand-off cannot drift from its admissions.
// Mirrors the CorpusAdapter's hold rule over the tracked candidate-review row
// (ambiguity held_* or a non-clean coverage state).
function rowHasAdapterHold(row) {
  const coverage = row.coverage_status ?? row.corpus_evidence?.coverage_status;
  return String(row.morphology_proposal?.ambiguity_status ?? '').startsWith('held_')
    || !['uncovered', 'exact_canonical_lemma', undefined].includes(coverage);
}

export function verifyTrackedHandoff({ handoffBytes, semanticInput, candidateRows, batchId }) {
  const handoff = JSON.parse(handoffBytes.toString('utf8'));
  if (handoff?.contract_version !== PRODUCTION_HANDOFF_CONTRACT || handoff.batch_id !== batchId) {
    fail('tracked intake hand-off has the wrong contract or batch', 'INTAKE_HANDOFF_CONTRACT');
  }
  checkAnalyzerRecord(handoff);
  const admitted = candidateRows.filter((row) => row.editorial_judgment.disposition === 'admit');
  const rowByLemma = new Map(candidateRows.map((row) => [row.morphology_proposal.lemma, row]));
  for (const entry of handoff.entries) {
    if (entry.decision === 'semantic_qa') {
      try { verifyAnalysisBinding(entryRunShape(entry), handoff.analyzer); } catch (error) { fail(error.message, 'INTAKE_HANDOFF_ANALYSIS_BINDING'); }
    }
    if (entry.decision === 'covered') continue;
    // Only admissions depend on a hold's origin; non-admitted holds fail closed anyway.
    const row = rowByLemma.get(entry.input);
    if (entry.decision === 'hold' && !(row && admitted.includes(row))) continue;
    const [input, pos = ''] = entry.key.split('\u0000');
    // The hold's origin is not read from the (editable) hand-off alone: an entry that
    // records no analysis must correspond to an adapter-level hold in the tracked
    // candidate review; everything else is recomputed from its recorded outcome.
    if (entry.analysis_outcome || entry.decision === 'semantic_qa') {
      assertDecisionFollowsOutcome(entry, { input, pos: pos || null, holds: [] });
    } else if (!row || !rowHasAdapterHold(row)) {
      fail(`${entry.input}: a hand-off hold without recorded analysis must correspond to an adapter-level hold in the candidate review`, 'INTAKE_HANDOFF_HOLD_ORIGIN');
    }
  }
  return assertReviewsBoundToHandoff({
    handoff,
    handoffBytes,
    integration: semanticInput.intake_handoff,
    admittedRows: admitted.map((row) => ({
      lemma: row.morphology_proposal.lemma,
      proposedPos: row.editorial_judgment.pos_correction?.analyzer_mapped_pos ?? row.morphology_proposal.pos,
      finalPos: row.morphology_proposal.pos,
      glossSha256: sha256Json(row.editorial_judgment.writer_gloss),
    })),
    hitCountByLemma: new Map(candidateRows.map((row) => [row.morphology_proposal.lemma, row.bounded_provenance.representative_hits.length])),
  });
}
