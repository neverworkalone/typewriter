import { REVIEWABLE_HOLDS, verifyProductionHandoff } from '../intake/production-handoff.mjs';
import { candidateViews, intakeCandidates, toRawCandidate } from './identity-adapter.mjs';
import { isLemmaRow } from './lemma-contract.mjs';
import { resolveGroupEntries } from './lemma-decisions.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';
import { decisionSenseReviews, validateAuthoredDecisionDisposition, validateDistinctSenseSemanticRationales, validateSenseReviews } from '../batch/authored-semantic-decision-source.mjs';
import { SOURCE_BOUND_SEMANTIC_DECISION_SOURCE_CONTRACT_VERSION, validateAuthoredSemanticReviewBinding } from '../validate/semantic-decision-row.mjs';

// Content validation of a review's semantic-decision source and intake hand-off, bound to
// the candidate rows and decision rows (not just their digests). It reuses the existing
// hand-off verifier and the exported per-row semantic validators (review binding, disposition
// basis, distinct sense rationales). The historical whole-source
// `validateAuthoredSemanticDecisionSource` additionally needs per-issue selection/rank/axis
// configuration that has no factory meaning, so the row-level source-bound contract is applied
// to every admitted candidate here instead.

const ADMITTED = new Set(['included', 'corrected']);

const isText = (value) => typeof value === 'string' && value.trim().length > 0;

// The synthetic candidate record a semantic row reviews, derived from the reviewed decision.
export const reviewedCandidateRecord = (decision) => ({
  id: decision.source_candidate_id,
  record_type: 'entry',
  lemma: decision.reviewed_record.lemma,
  senses: decision.reviewed_record.senses.map((sense, index) => ({ id: `${decision.source_candidate_id}-s${index + 1}`, pos: sense.pos, gloss: sense.gloss })),
});

function validateSemanticRow(row, decision, batchId, errors) {
  const id = decision.source_candidate_id;
  const at = `semantic decision ${id}`;
  const record = reviewedCandidateRecord(decision);
  const fail = (message) => errors.push(`${at}: ${message}`);
  if (row.decision !== decision.disposition) fail(`decision ${row.decision} contradicts the reviewed disposition ${decision.disposition}`);
  if (row.candidate_record_id !== id) fail('candidate_record_id must be the source_candidate_id');
  if (row.candidate_record_sha256 !== sha256Json(record)) { fail('candidate_record_sha256 does not bind the reviewed record'); return; }
  if (row.gloss_judgment !== 'fit') fail('gloss_judgment must be fit for an admitted candidate');
  if (!isText(row.decision_rationale) || !row.decision_rationale.includes(id)) fail('decision_rationale must cite the candidate id');
  try {
    const config = { label: 'factory semantic decision', errorPrefix: 'FACTORY_SEMANTIC' };
    validateAuthoredDecisionDisposition(row, at, config);
    const senseReviews = decisionSenseReviews(record, row, at, config);
    validateDistinctSenseSemanticRationales(record, senseReviews);
    validateSenseReviews({ row, candidate: record, senseReviews, label: at, inventoryId: id, decisionSourceId: batchId, config });
    validateAuthoredSemanticReviewBinding(row, record);
  } catch (error) {
    fail(error.message);
  }
}

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
      } else {
        const rowById = new Map(semantic.decisions.map((row) => [row.source_candidate_id, row]));
        for (const decision of admitted) {
          if (typeof decision.reviewed_record?.lemma !== 'string' || !Array.isArray(decision.reviewed_record.senses)) continue;
          validateSemanticRow(rowById.get(decision.source_candidate_id), decision, batchId, errors);
        }
      }
    }
    if (semantic.provenance?.human_reviewed !== false || semantic.authoring_mode !== 'agent-authored-decision') {
      errors.push('semantic-decisions.json: provenance must be honest agent authoring (human_reviewed false)');
    }
    if (semantic.review?.status !== 'complete' || !isText(semantic.review?.reviewer) || semantic.review?.reviewed_candidate_count !== candidates.length) {
      errors.push('semantic-decisions.json: review must be complete, name its reviewer and cover every candidate');
    }
  }

  const handoff = parse(handoffText, 'intake-handoff.json', errors);
  if (handoff) {
    try {
      verifyProductionHandoff(handoff, { rawCandidates: intakeCandidates(candidateViews(candidates)).map(toRawCandidate), batchId, adapterId });
    } catch (error) {
      errors.push(`intake-handoff.json: ${error.message}`);
    }
    const entryByKey = new Map((handoff.entries ?? []).map((entry) => [entry.key, entry]));
    for (const row of decisions) {
      const candidate = candidateById.get(row.source_candidate_id);
      if (!candidate) continue;
      if (isLemmaRow(candidate)) { errors.push(...validateLemmaHandoffEntries(row, candidate, entryByKey)); continue; }
      const entry = entryByKey.get(`${candidate.input}\u0000${candidate.pos}`);
      if (!entry) { errors.push(`decision ${row.source_candidate_id}: no hand-off entry for its input+POS`); continue; }
      if (!ADMITTED.has(row.disposition)) continue;
      // A usage that carries its own Stage 1 hold needs an explicit, candidate-specific resolution.
      if (candidate.holds.length && (typeof row.hold_resolution !== 'string' || !row.hold_resolution)) {
        errors.push(`decision ${row.source_candidate_id}: Stage 1 hold ${candidate.holds.join(', ')} requires a hold_resolution`);
      }
      if (candidate.holds.some((hold) => !REVIEWABLE_HOLDS.includes(hold))) {
        errors.push(`decision ${row.source_candidate_id}: Stage 1 hold ${candidate.holds.join(', ')} cannot be admitted`);
      }
      if (row.reviewed_record?.lemma !== candidate.input) errors.push(`decision ${row.source_candidate_id}: reviewed lemma differs from the candidate input`);
      // The hand-off entry is keyed by input+POS, so for a key whose usages are all held it carries
      // the UNION of their holds. Admissibility is therefore judged per candidate from its own
      // Stage 1 holds (above); the entry is consulted only for a usage with no hold of its own,
      // which is bound to its analysis-backed entry.
      if (candidate.holds.length) continue;
      if (entry.decision === 'semantic_qa') continue;
      // An analysis-originated (Kiwi) hold on a usage with no hold of its own is resolvable only if reviewable.
      const resolvable = entry.decision === 'hold' && entry.holds.every((hold) => REVIEWABLE_HOLDS.includes(hold));
      if (!resolvable) errors.push(`decision ${row.source_candidate_id}: hand-off ${entry.decision} (${(entry.holds ?? []).join(', ')}) cannot be admitted`);
      else if (typeof row.hold_resolution !== 'string' || !row.hold_resolution) errors.push(`decision ${row.source_candidate_id}: reviewable hold requires a hold_resolution`);
    }
  }
  return errors;
}

// Hand-off binding of a lemma-centered decision: every POS hypothesis has a hand-off entry, and an
// admitted group is bound to the entry of its own POS. Holds are judged per group from its own
// observations (group-level resolutions are checked by validateLemmaDecision); a group with an
// unheld observation is additionally bound to its analysis-backed entry.
function validateLemmaHandoffEntries(row, candidate, entryByKey) {
  const errors = [];
  for (const pos of candidate.pos_hypotheses) {
    if (!entryByKey.has(`${candidate.input}\u0000${pos}`)) errors.push(`decision ${row.source_candidate_id}: no hand-off entry for its input+POS (${pos})`);
  }
  if (!ADMITTED.has(row.disposition)) return errors;
  if (row.reviewed_record?.lemma !== candidate.input) errors.push(`decision ${row.source_candidate_id}: reviewed lemma differs from the candidate input`);
  // Group entries are already validated by validateLemmaDecision; only the judged observations matter here.
  const { entries } = resolveGroupEntries(row, candidate);
  for (const { entry, group, members } of entries) {
    if (entry.disposition !== 'included') continue;
    if (members.every((observation) => observation.holds.length)) continue;
    const handoffEntry = entryByKey.get(`${candidate.input}\u0000${group.pos}`);
    if (!handoffEntry || handoffEntry.decision === 'semantic_qa') continue;
    const resolvable = handoffEntry.decision === 'hold' && handoffEntry.holds.every((hold) => REVIEWABLE_HOLDS.includes(hold));
    const resolution = entry.hold_resolution;
    if (!resolvable) errors.push(`decision ${row.source_candidate_id} group ${group.group_id}: hand-off ${handoffEntry.decision} (${(handoffEntry.holds ?? []).join(', ')}) cannot be admitted`);
    else if (typeof resolution !== 'string' || !resolution) errors.push(`decision ${row.source_candidate_id} group ${group.group_id}: reviewable hold requires a hold_resolution`);
  }
  return errors;
}
