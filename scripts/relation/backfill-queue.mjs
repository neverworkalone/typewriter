import { EXPLORATORY_RELATION_TYPES, reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { relationAmendmentErrors } from '../factory/relation-amendments.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';
import { buildRelationIndex, retrieveRelationCandidates, validateRelationCandidateArtifact } from './candidate-retrieval.mjs';

// Canonical relation backfill queue (issue #400). It only orders and tracks work: every queued sense is reviewed
// through the SAME candidate retrieval, relation tuple contract (types, relevance 1-9, source-bound rationale,
// gloss digest) and amendment validator that new Stage 2 production uses. A sense without relations is never a
// defect or a quota gap; relation density is not an admission gate. Nothing here changes canonical data.

export const BACKFILL_CONTRACT = 'relation-backfill-queue-v1';
export const MAX_PACKET_SIZE = 200; // bounded unit of work per resume step
export const OUTCOMES = Object.freeze(['relations-reviewed', 'no-relations']);

/**
 * One inventory row per canonical sense. `demand` is a transparent, replaceable proxy for writer demand: how many
 * other senses already point at this one with an exploratory relation. It orders work only; it is not lexical truth.
 */
export function inventoryCanonicalSenses(index) {
  const incoming = new Map();
  for (const entry of index.senses) {
    for (const relation of entry.relations) {
      if (!EXPLORATORY_RELATION_TYPES.has(relation.type)) continue;
      const key = relation.target_sense ?? null;
      if (key) incoming.set(key, (incoming.get(key) ?? 0) + 1);
    }
  }
  return index.senses.map((entry) => ({
    sense_id: entry.sense_id,
    record_id: entry.record_id,
    pos: entry.pos,
    gloss_sha256: sha256Json(entry.gloss),
    demand: incoming.get(entry.sense_id) ?? 0,
    outgoing_exploratory: entry.relations.filter((relation) => EXPLORATORY_RELATION_TYPES.has(relation.type)).length,
  }));
}

/** Deterministic order: higher demand first, then fewer existing exploratory relations, then stable id. */
export function orderInventory(rows) {
  return [...rows].sort((a, b) => b.demand - a.demand
    || a.outgoing_exploratory - b.outgoing_exploratory
    || (a.sense_id < b.sense_id ? -1 : a.sense_id > b.sense_id ? 1 : 0));
}

export const newQueueState = (canonicalRevision) => ({ contract: BACKFILL_CONTRACT, canonical_revision: canonicalRevision, done: {} });

const targetId = (target) => target.sense_id ?? target.provisional_id;

/**
 * sense id -> the review-relevant evidence of every retrieved candidate, in rank order: target identity (id, record,
 * POS, lemma/gloss digest), the retrieval signals and the literature location digests. Scores never appear in the artifact.
 */
export function candidateEvidence(artifact, index) {
  return new Map(artifact.sources.map((source) => [
    source.source.sense_id,
    source.candidates.map((candidate) => ({
      id: targetId(candidate.target),
      record_id: candidate.target.record_id ?? null,
      // The reviewer judges the target's meaning, so a changed target lemma/gloss is changed evidence too.
      meaning_sha256: candidate.target.sense_id ? sha256Json([index.bySenseId.get(candidate.target.sense_id).lemma, index.bySenseId.get(candidate.target.sense_id).gloss]) : null,
      pos: candidate.target.pos,
      signals: [...candidate.signals],
      literature: [...(candidate.literature_location_digests ?? [])],
    })),
  ]));
}

/** The preserved approvals must still be exactly what was recorded: ids bind sense, target, type, note and relevance. */
function approvalsIntact(row, entry) {
  const approved = entry.approved_relations;
  if (!Array.isArray(approved) || approved.length !== entry.relation_count) return false;
  if ((entry.outcome === 'no-relations') !== (approved.length === 0)) return false;
  return approved.every((item) => item?.relation && typeof item.rationale === 'string'
    && item.relation_id === reviewedRelationId(row.sense_id, item.relation));
}

/**
 * A completed review stays valid only while the evidence it reviewed still holds: the gloss is unchanged, every
 * current candidate was reviewed with identical identity/POS/signals/literature evidence, and the candidates present
 * in both lists keep their relative order (rank). Candidates that disappeared (for example because the reviewed
 * relation now exists) do not invalidate the review, which also keeps an applied review from re-queueing itself.
 * Missing current candidates fail closed (re-review).
 */
export function isReviewCurrent(row, entry, currentCandidates) {
  if (!entry || entry.gloss_sha256 !== row.gloss_sha256 || !approvalsIntact(row, entry)) return false;
  const current = currentCandidates?.get(row.sense_id);
  if (!current) return false;
  const reviewed = new Map(entry.reviewed_candidates.map((candidate) => [candidate.id, candidate]));
  for (const candidate of current) {
    if (JSON.stringify(reviewed.get(candidate.id) ?? null) !== JSON.stringify(candidate)) return false;
  }
  const common = new Set(current.map((candidate) => candidate.id));
  const before = entry.reviewed_candidates.filter((candidate) => common.has(candidate.id)).map((candidate) => candidate.id);
  return JSON.stringify(before) === JSON.stringify(current.map((candidate) => candidate.id).filter((id) => reviewed.has(id)));
}

/** Current candidate evidence for the senses a state marks done (the only ones whose currency must be checked). */
export function currentCandidatesForDone(canonical, rows, state, { index = buildRelationIndex(canonical) } = {}) {
  const doneRows = rows.filter((row) => state.done[row.sense_id]);
  const result = new Map();
  for (let i = 0; i < doneRows.length; i += MAX_PACKET_SIZE) {
    for (const [id, targets] of candidateEvidence(retrievePacket(canonical, doneRows.slice(i, i + MAX_PACKET_SIZE), { index }), index)) result.set(id, targets);
  }
  return result;
}

/**
 * Next bounded packet of pending senses: never reviewed, or reviewed against a different gloss or an incomplete
 * candidate pool (see isReviewCurrent). A sense that no longer exists is simply dropped from consideration.
 */
export function nextPacket(rows, state, { limit = 50, currentCandidates = new Map() } = {}) {
  if (state?.contract !== BACKFILL_CONTRACT) throw new Error('unknown backfill state contract');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PACKET_SIZE) throw new Error(`limit must be an integer 1-${MAX_PACKET_SIZE}`);
  const pending = orderInventory(rows).filter((row) => !isReviewCurrent(row, state.done[row.sense_id], currentCandidates));
  return pending.slice(0, limit);
}

/**
 * Validates and records review outcomes for a packet. Relation tuples are checked by the shared amendment
 * validator, so a backfill relation obeys exactly the production contract. Returns the updated state (pure).
 */
export function recordOutcomes(state, packet, outcomes, { candidates, index, snapshotDigest } = {}) {
  if (!index || typeof snapshotDigest !== 'string' || !snapshotDigest) throw new Error('recordOutcomes needs the canonical index and the retrieval snapshot digest');
  const byId = new Map(packet.map((row) => [row.sense_id, row]));
  const errors = [];
  const seen = new Set();
  const done = { ...state.done };
  for (const outcome of outcomes) {
    const row = byId.get(outcome.sense_id);
    if (!row) { errors.push(`${outcome.sense_id}: not part of the supplied packet`); continue; }
    if (seen.has(outcome.sense_id)) { errors.push(`${outcome.sense_id}: duplicate outcome`); continue; }
    seen.add(outcome.sense_id);
    if (!OUTCOMES.includes(outcome.outcome)) { errors.push(`${outcome.sense_id}: outcome must be ${OUTCOMES.join(' or ')}`); continue; }
    const amendments = outcome.relation_amendments ?? [];
    if (outcome.outcome === 'no-relations' && amendments.length) { errors.push(`${outcome.sense_id}: no-relations carries amendments`); continue; }
    if (outcome.outcome === 'relations-reviewed' && !amendments.length) { errors.push(`${outcome.sense_id}: relations-reviewed needs amendments`); continue; }
    if (typeof outcome.rationale !== 'string' || !outcome.rationale.includes(outcome.sense_id)) { errors.push(`${outcome.sense_id}: rationale must cite the sense`); continue; }
    const problems = amendments.length ? relationAmendmentErrors({ relation_amendments: amendments }, outcome.sense_id) : [];
    const wrongSource = amendments.filter((a) => a.source_sense_id !== outcome.sense_id || a.source_gloss_sha256 !== row.gloss_sha256);
    if (wrongSource.length) problems.push(`${outcome.sense_id}: amendments must be bound to this sense and its current gloss digest`);
    const reviewedCandidates = candidates?.get(outcome.sense_id);
    if (!reviewedCandidates) { errors.push(`${outcome.sense_id}: the reviewed candidate pool must be supplied`); continue; }
    // Every authored target must be a real canonical sense that this packet's retrieval actually offered.
    const pool = new Set(reviewedCandidates.map((candidate) => candidate.id));
    for (const { relation } of amendments) {
      const target = typeof relation?.target_sense === 'string' ? index.bySenseId.get(relation.target_sense) : null;
      if (!target) problems.push(`${outcome.sense_id}: relation target_sense ${relation?.target_sense} is not a canonical sense`);
      else if (target.record_id !== relation.target) problems.push(`${outcome.sense_id}: relation target ${relation.target} does not own target_sense ${relation.target_sense}`);
      if (!pool.has(relation?.target_sense)) problems.push(`${outcome.sense_id}: relation target_sense ${relation?.target_sense} was not among the reviewed candidates`);
    }
    if (problems.length) { errors.push(...problems); continue; }
    done[outcome.sense_id] = {
      outcome: outcome.outcome,
      gloss_sha256: row.gloss_sha256,
      rationale: outcome.rationale,
      relation_count: amendments.length,
      // The approved tuples are preserved verbatim (never reduced to a count) so a resumed queue can recover,
      // verify and later hand over exactly what was approved, bound to the retrieval snapshot it came from.
      approved_relations: amendments.map((amendment) => ({
        relation_id: reviewedRelationId(row.sense_id, amendment.relation), relation: amendment.relation, rationale: amendment.rationale,
      })),
      canonical_snapshot_digest: snapshotDigest,
      reviewed_candidates: reviewedCandidates,
    };
  }
  if (errors.length) return { state, errors };
  return { state: { ...state, done }, errors: [] };
}

/** Retrieval for a packet through the production retriever; the artifact is validated before it is handed out. */
export function retrievePacket(canonical, packet, { index = buildRelationIndex(canonical), literature = {} } = {}) {
  const sources = packet.map((row) => ({ kind: 'canonical', sense_id: row.sense_id }));
  const artifact = retrieveRelationCandidates(index, sources, { literature });
  const errors = validateRelationCandidateArtifact(artifact, index, { expectedSourceIds: packet.map((row) => row.sense_id) });
  if (errors.length) throw new Error(`candidate artifact invalid: ${errors.slice(0, 3).join('; ')}`);
  return artifact;
}

export function summarizeQueue(rows, state, currentCandidates = new Map()) {
  const done = rows.filter((row) => isReviewCurrent(row, state.done[row.sense_id], currentCandidates));
  const outcomes = {};
  for (const row of done) { const o = state.done[row.sense_id].outcome; outcomes[o] = (outcomes[o] ?? 0) + 1; }
  return {
    canonical_senses: rows.length,
    with_incoming_demand: rows.filter((row) => row.demand > 0).length,
    with_no_outgoing_exploratory: rows.filter((row) => row.outgoing_exploratory === 0).length,
    completed: done.length,
    pending: rows.length - done.length,
    outcomes,
    note: 'empty relation lists are not defects; ordering is a demand heuristic, not a quota',
  };
}
