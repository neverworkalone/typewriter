import { REVIEWABLE_HOLDS, verifyProductionHandoff } from '../intake/production-handoff.mjs';
import { SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION } from '../validate/semantic-decision-row.mjs';
import { toRawCandidate } from './identity-adapter.mjs';

// Content validation of a review's semantic-decision source and intake hand-off, bound to
// the candidate rows and decision rows (not just their digests). It reuses the existing
// hand-off verifier and contract identifiers. The full historical
// `validateAuthoredSemanticDecisionSource` is bound to per-issue configuration (pass ids,
// identity sources) that the Stage 2 producer (#265) must supply; this layer fixes the
// structure and cross-binding every factory review must satisfy.

const ADMITTED = new Set(['included', 'corrected']);

function parse(text, label, errors) {
  try {
    return JSON.parse(text);
  } catch {
    errors.push(`${label}: not valid JSON`);
    return null;
  }
}

export function validateReviewArtifacts({ batchId, adapterId, candidates, decisions, semanticDecisionsText, handoffText }) {
  const errors = [];
  const admitted = decisions.filter((row) => ADMITTED.has(row.disposition));
  const candidateById = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));

  const semantic = parse(semanticDecisionsText, 'semantic-decisions.json', errors);
  if (semantic) {
    if (semantic.schema_version !== '1' || semantic.contract_version !== SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION
      || semantic.kind !== 'separately-authored-semantic-decision-source') {
      errors.push('semantic-decisions.json: unsupported semantic decision source contract');
    }
    if (semantic.batch_id !== batchId) errors.push('semantic-decisions.json: bound to a different batch');
    if (!Array.isArray(semantic.decisions)) errors.push('semantic-decisions.json: decisions must be an array');
    else {
      const ids = semantic.decisions.map((row) => row?.source_candidate_id);
      if (new Set(ids).size !== ids.length) errors.push('semantic-decisions.json: duplicate source_candidate_id');
      const expected = admitted.map((row) => row.source_candidate_id).sort();
      if (JSON.stringify([...ids].sort()) !== JSON.stringify(expected)) {
        errors.push('semantic-decisions.json: must hold exactly one semantic decision per included/corrected candidate');
      }
    }
  }

  const handoff = parse(handoffText, 'intake-handoff.json', errors);
  if (handoff) {
    try {
      verifyProductionHandoff(handoff, { rawCandidates: candidates.map(toRawCandidate), batchId, adapterId });
    } catch (error) {
      errors.push(`intake-handoff.json: ${error.message}`);
    }
    const entryByKey = new Map((handoff.entries ?? []).map((entry) => [entry.key, entry]));
    for (const row of decisions) {
      const candidate = candidateById.get(row.source_candidate_id);
      if (!candidate) continue;
      const entry = entryByKey.get(`${candidate.input}\u0000${candidate.pos}`);
      if (!entry) { errors.push(`decision ${row.source_candidate_id}: no hand-off entry for its input+POS`); continue; }
      if (!ADMITTED.has(row.disposition)) continue;
      if (row.reviewed_record?.lemma !== candidate.input) errors.push(`decision ${row.source_candidate_id}: reviewed lemma differs from the candidate input`);
      const resolvable = entry.decision === 'hold' && entry.holds.every((hold) => REVIEWABLE_HOLDS.includes(hold));
      if (entry.decision === 'semantic_qa') continue;
      if (!resolvable) errors.push(`decision ${row.source_candidate_id}: hand-off ${entry.decision} (${(entry.holds ?? []).join(', ')}) cannot be admitted`);
      else if (typeof row.hold_resolution !== 'string' || !row.hold_resolution) errors.push(`decision ${row.source_candidate_id}: reviewable hold requires a hold_resolution`);
    }
  }
  return errors;
}
