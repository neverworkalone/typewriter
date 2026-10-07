import { REVIEWABLE_HOLDS, verifyProductionHandoff } from '../intake/production-handoff.mjs';
import { candidateViews, intakeCandidates, toRawCandidate } from './identity-adapter.mjs';
import { isLemmaRow } from './lemma-contract.mjs';
import { resolveGroupEntries } from './lemma-decisions.mjs';
import { validateScopeDeclarations } from './scope-declaration.mjs';
import { validateSurfaceFormJudgments } from './surface-form-judgments.mjs';
import { inspectSenseBoundaryPairs, sha256Json } from '../validate/semantic-audit.mjs';
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

function validateSemanticRow(row, decision, batchId, errors, { candidate, requireScopeDeclaration } = {}) {
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
  // The evidence scope of a lemma-centered candidate is checked against its own usage-group decisions.
  if (candidate && isLemmaRow(candidate)) errors.push(...validateScopeDeclarations({ decision, candidate, senseReviews: row.sense_reviews, required: requireScopeDeclaration }));
}

function parse(text, label, errors) {
  try {
    return JSON.parse(text);
  } catch {
    errors.push(`${label}: not valid JSON`);
    return null;
  }
}

export function validateReviewArtifacts({ batchId, adapterId, candidates, decisions, semanticDecisionsText, handoffText, requireScopeDeclaration = false, requireSurfaceFormJudgments = false, requireExistingBoundaryPairs = requireScopeDeclaration }) {
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
          const row = rowById.get(decision.source_candidate_id);
          validateSemanticRow(row, decision, batchId, errors, { candidate: candidateById.get(decision.source_candidate_id), requireScopeDeclaration });
          validateFactoryBoundaryPairs(row, decision, errors);
          validateExistingBoundaryPairs(row, decision, errors, requireExistingBoundaryPairs);
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

  // Explicit surface-form (inflection class) judgments: Stage 3 can only record what Stage 2 judged.
  for (const decision of decisions) errors.push(...validateSurfaceFormJudgments(decision, { required: requireSurfaceFormJudgments }));

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

// A new sense on an existing entry must be distinguished from each existing same-POS canonical
// sense by Stage 2: one authored pair per (existing sense, new sense). Stage 3 binds the existing
// gloss digest to canonical and requires a pair for every existing same-POS sense.
export function validateExistingBoundaryPairs(row, decision, errors, required) {
  const label = `semantic decision ${decision.source_candidate_id}`;
  const pairs = row?.existing_boundary_pairs;
  if (decision.target?.kind !== 'new_sense_on_existing_entry') {
    if (pairs !== undefined) errors.push(`${label}: existing_boundary_pairs is only valid for new_sense_on_existing_entry`);
    return;
  }
  if (pairs === undefined && !required) return;
  if (!Array.isArray(pairs) || pairs.length === 0) {
    errors.push(`${label}: new_sense_on_existing_entry requires authored existing_boundary_pairs`);
    return;
  }
  const context = new Set([decision.target.context_sense_id, ...(decision.target.context_sense_ids ?? [])]);
  const senses = decision.reviewed_record.senses;
  const seen = new Set();
  for (const [index, pair] of pairs.entries()) {
    const pairLabel = `${label} existing_boundary_pairs[${index}]`;
    const newIndex = senses.findIndex((_, i) => pair?.new_sense_id === `${decision.source_candidate_id}-s${i + 1}`);
    const key = `${pair?.existing_sense_id}:${pair?.new_sense_id}`;
    if (!context.has(pair?.existing_sense_id) || newIndex < 0 || seen.has(key)) { errors.push(`${pairLabel}: pair identity is unknown, outside the compared context senses, or duplicated`); continue; }
    seen.add(key);
    if (pair.relationship !== 'distinct' || pair.decision !== 'retain') errors.push(`${pairLabel}: an admitted pair must retain a distinct relationship`);
    if (pair.new_gloss_sha256 !== sha256Json(senses[newIndex].gloss) || !/^[0-9a-f]{64}$/.test(pair.existing_gloss_sha256 ?? '')) errors.push(`${pairLabel}: gloss digests do not bind the compared pair`);
    for (const field of ['evidence_basis', 'distinguishing_feature', 'rationale']) {
      if (typeof pair[field] !== 'string' || !pair[field].trim() || !pair[field].includes(decision.source_candidate_id)) errors.push(`${pairLabel}: ${field} must be candidate-specific authored evidence`);
    }
  }
  for (const id of context) {
    if (![...seen].some((key) => key.startsWith(`${id}:`))) errors.push(`${label}: no authored boundary evidence against existing sense ${id}`);
  }
}

function validateFactoryBoundaryPairs(row, decision, errors) {
  const senses = decision.reviewed_record?.senses ?? [];
  const pairs = row?.boundary_pairs;
  const label = `semantic decision ${decision.source_candidate_id}`;
  if (senses.length < 2) {
    if (pairs !== undefined && (!Array.isArray(pairs) || pairs.length !== 0)) errors.push(`${label}: boundary_pairs must be empty for a one-sense candidate`);
    return;
  }
  if (!Array.isArray(pairs)) {
    errors.push(`${label}: multi-sense admissions require source-bound boundary_pairs`);
    return;
  }
  const sourceRecord = {
    id: decision.source_candidate_id,
    lemma: decision.reviewed_record.lemma,
    senses: senses.map((sense, index) => ({ ...sense, id: `${decision.source_candidate_id}-s${index + 1}` })),
  };
  const expected = new Map(inspectSenseBoundaryPairs(sourceRecord).map((pair) => [`${pair.left_sense_id}:${pair.right_sense_id}`, pair]));
  const seen = new Set();
  if (pairs.length !== expected.size) errors.push(`${label}: boundary_pairs must cover every reviewed sense pair`);
  for (const [index, pair] of pairs.entries()) {
    const pairLabel = `${label} boundary_pairs[${index}]`;
    const key = `${pair?.left_sense_id}:${pair?.right_sense_id}`;
    const mechanical = expected.get(key);
    if (!mechanical || seen.has(key)) { errors.push(`${pairLabel}: pair identity is missing, reversed, or duplicated`); continue; }
    seen.add(key);
    const left = sourceRecord.senses.find(({ id }) => id === pair.left_sense_id);
    const right = sourceRecord.senses.find(({ id }) => id === pair.right_sense_id);
    if (pair.relationship !== mechanical.relationship || pair.decision !== 'retain') errors.push(`${pairLabel}: an admitted pair must retain the mechanically classified ${mechanical.relationship} relationship`);
    if (pair.left_gloss_sha256 !== sha256Json(left.gloss) || pair.right_gloss_sha256 !== sha256Json(right.gloss)) errors.push(`${pairLabel}: gloss digests do not bind the reviewed pair`);
    for (const field of ['evidence_basis', 'distinguishing_feature', 'rationale']) {
      if (typeof pair[field] !== 'string' || !pair[field].trim() || !pair[field].includes(decision.source_candidate_id)) errors.push(`${pairLabel}: ${field} must be candidate-specific authored evidence`);
    }
  }
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
