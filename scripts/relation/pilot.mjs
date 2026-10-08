import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import path from 'node:path';

import { EXPLORATORY_RELATION_TYPES, PRECISION_RELATION_TYPES } from '../batch/authored-semantic-decision-source.mjs';
import { sha256Json } from '../validate/semantic-audit.mjs';
import { RELATION_TYPE_TO_GROUP } from '../../src/domain/relation-groups.js';
import { buildRelationIndex, retrieveRelationCandidates, validateRelationCandidateArtifact } from './candidate-retrieval.mjs';

// Relation Enrichment pilot (issue #400). The pilot runs the same retrieval -> relation review -> relevance ->
// amendment path as production over a pre-registered cohort of reviewed Stage 2 senses, and measures it.
// Nothing here judges relations: relation tuples are authored by the reviewing agent and only checked and
// counted by this module. The cohort rule is fixed before any relation outcome is known.

export const PILOT_CONTRACT = 'relation-enrichment-pilot-v1';
export const COHORT_RULE = Object.freeze({
  salt: 'relation-pilot-400',
  batches: Object.freeze(['C000007', 'C000010', 'C000012', 'C000013']),
  per_batch: 10,
  inspect_limit: 10,
  // senses are ordered by sha256(`${salt}:${sense_id}`) and the first `per_batch` of each batch are taken, so
  // neither word difficulty nor relation density can influence selection.
});

const ADMITTED = new Set(['included']);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

export async function readReviewedBatchSenses(batchId, repo = REPO) {
  const raw = await readFile(path.join(repo, 'data/reviews', batchId, 'decisions.jsonl'), 'utf8');
  const senses = [];
  for (const line of raw.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (!ADMITTED.has(row.disposition)) continue;
    row.reviewed_record.senses.forEach((sense, index) => {
      senses.push({
        batch_id: batchId,
        candidate_id: row.source_candidate_id,
        sense_key: `s${index + 1}`,
        sense_id: `${row.source_candidate_id}-s${index + 1}`,
        target_kind: row.target.kind,
        entry_id: row.target.entry_id ?? null,
        lemma: row.reviewed_record.lemma,
        pos: sense.pos,
        gloss: sense.gloss,
      });
    });
  }
  return senses;
}

export function selectCohortSenses(senses, rule = COHORT_RULE) {
  return [...senses]
    .map((sense) => ({ sense, order: sha(`${rule.salt}:${sense.sense_id}`) }))
    .sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0))
    .slice(0, rule.per_batch)
    .map(({ sense }) => sense);
}

export const provisionalSource = (sense) => ({
  kind: 'provisional',
  batch_id: sense.batch_id,
  candidate_id: sense.candidate_id,
  sense_key: sense.sense_key,
  lemma: sense.lemma,
  pos: sense.pos,
  gloss: sense.gloss,
});

/** `provisional:<batch>/<candidate>/<key>` -> reviewed sense ref `<candidate>-<key>`. */
export const senseRefOfTarget = (target) => (target.sense_id
  ? target.sense_id
  : target.provisional_id.replace(/^provisional:/u, '').split('/').slice(1).join('-'));

export const provisionalId = (sense) => `provisional:${sense.batch_id}/${sense.candidate_id}/${sense.sense_key}`;

/** Runs the production retrieval for one batch cohort and times it. */
export async function retrieveForCohort(batchId, senses, { canonical, index }) {
  const start = performance.now();
  const artifact = retrieveRelationCandidates(index, senses.map(provisionalSource));
  const milliseconds = performance.now() - start;
  const errors = validateRelationCandidateArtifact(artifact, index, { expectedSourceIds: senses.map(provisionalId) });
  if (errors.length) throw new Error(`candidate artifact invalid for ${batchId}: ${errors.slice(0, 3).join('; ')}`);
  return { artifact, milliseconds, canonical };
}

// ---- pilot record -----------------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const SENSE_REF = /^C\d{6}-\d{4}-s\d+$/u;

/**
 * Validates the pilot record against the real canonical snapshot and the shared tuple contract: targets must
 * exist (canonical and in the retrieved pool, or a sense of the same reviewed batch), types and relevance follow
 * production (`direct`/`antonym` carry none, exploratory types need 1-9), and there is no self reference or
 * duplicate. `batchSenseIds` is every reviewed sense of the pilot batches; `cohortRefs` the pre-registered cohort.
 */
export function validatePilotRecord(pilot, { index, cohortRefs, batchSenseIds, poolBySource }) {
  const errors = [];
  if (pilot?.contract !== PILOT_CONTRACT) errors.push(`contract must be ${PILOT_CONTRACT}`);
  if (!Array.isArray(pilot?.senses)) return [...errors, 'senses must be an array'];
  const expected = [...cohortRefs].sort();
  const actual = pilot.senses.map((s) => s.sense_ref).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) errors.push('senses must cover exactly the pre-registered cohort');
  const seen = new Set();
  for (const entry of pilot.senses) {
    const at = `senses[${entry.sense_ref}]`;
    const pool = poolBySource.get(entry.sense_ref);
    if (!pool) { errors.push(`${at}: not in the retrieval output`); continue; }
    if (entry.candidate_count !== pool.total) errors.push(`${at}: candidate_count differs from retrieval`);
    const maxInspect = Math.min(COHORT_RULE.inspect_limit, pool.total);
    if (entry.inspected_count !== maxInspect) errors.push(`${at}: inspected_count must equal the bounded shortlist (${maxInspect})`);
    const relations = entry.relations ?? [];
    const bound = typeof entry.rationale === 'string' && entry.rationale.includes(entry.sense_ref);
    if (entry.decision === 'no-relations') {
      if (relations.length || !bound) errors.push(`${at}: no-relations needs zero relations and a sense-bound rationale`);
    } else if (entry.decision === 'relations-reviewed') {
      if (!relations.length || !bound) errors.push(`${at}: relations-reviewed needs relations and a sense-bound rationale`);
    } else errors.push(`${at}: decision must be relations-reviewed or no-relations`);
    for (const relation of relations) {
      errors.push(...relationErrors(relation, at, { entry, seen }));
      const id = relation.target_sense;
      if (relation.target_kind === 'canonical') {
        if (!index.bySenseId.has(id)) errors.push(`${at}: canonical target ${id} not found`);
        else if (!pool.shortlist.has(id)) errors.push(`${at}: canonical target ${id} was not in the inspected shortlist`);
      } else if (relation.target_kind === 'same_batch') {
        if (!batchSenseIds.has(id)) errors.push(`${at}: same-batch target ${id} is not a reviewed sense of the batch`);
        else if (!id.startsWith(entry.sense_ref.split('-')[0])) errors.push(`${at}: same-batch target ${id} belongs to another batch`);
        else if (!pool.shortlist.has(id)) errors.push(`${at}: same-batch target ${id} was not in the inspected shortlist`);
      } else errors.push(`${at}: target_kind must be canonical or same_batch`);
    }
  }
  const amendmentSeen = new Set();
  for (const amendment of pilot.amendments ?? []) {
    const at = `amendments[${amendment.source_sense_id}->${amendment.relation?.target_sense}]`;
    const source = index.bySenseId.get(amendment.source_sense_id);
    if (!source) { errors.push(`${at}: source must be an existing canonical sense`); continue; }
    if (amendment.source_gloss_sha256 !== sha256Json(source.gloss)) errors.push(`${at}: stale source gloss digest`);
    if (typeof amendment.rationale !== 'string' || !amendment.rationale.includes(amendment.source_sense_id)) errors.push(`${at}: rationale must cite the source sense`);
    const target = amendment.relation?.target_sense;
    if (!cohortRefs.includes(target)) errors.push(`${at}: amendment target must be a cohort sense`);
    errors.push(...relationErrors(amendment.relation, at, { entry: { sense_ref: amendment.source_sense_id }, seen: amendmentSeen }));
    // The reverse direction is only added where the forward relation was reviewed and accepted (same pair).
    const forward = pilot.senses.find((s) => s.sense_ref === target)?.relations?.some((r) => r.target_sense === amendment.source_sense_id);
    if (!forward) errors.push(`${at}: reverse amendment needs an accepted forward relation of the same pair`);
  }
  return errors;
}

function relationErrors(relation, at, { entry, seen }) {
  const errors = [];
  if (!isObject(relation)) return [`${at}: relation must be an object`];
  const isPrecision = PRECISION_RELATION_TYPES.has(relation.type);
  if (!isPrecision && !EXPLORATORY_RELATION_TYPES.has(relation.type)) errors.push(`${at}: unsupported type ${relation.type}`);
  if (typeof relation.note !== 'string' || !relation.note.trim()) errors.push(`${at}: note required`);
  if (isPrecision && relation.relevance !== undefined) errors.push(`${at}: ${relation.type} must not carry relevance`);
  if (!isPrecision && !(Number.isInteger(relation.relevance) && relation.relevance >= 1 && relation.relevance <= 9)) errors.push(`${at}: exploratory relation needs relevance 1-9`);
  if (typeof relation.target_sense !== 'string' || !relation.target_sense) errors.push(`${at}: target_sense required`);
  if (relation.target_sense === entry.sense_ref) errors.push(`${at}: self reference`);
  const key = JSON.stringify([entry.sense_ref, relation.target_sense, relation.type]);
  if (seen.has(key)) errors.push(`${at}: duplicate ${key}`);
  seen.add(key);
  return errors;
}

// ---- measurement ------------------------------------------------------------------------------------

const countBy = (items, key) => items.reduce((acc, item) => { const k = key(item); acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
const sortedObject = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));
const median = (list) => {
  const sorted = [...list].sort((a, b) => a - b);
  if (!sorted.length) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/**
 * Counts, for every canonical sense, its exploratory relations per UI group (말의 결 / 연상) and reports how many
 * exceed the 20-item page and the 100-item window. Relations beyond 100 are stored, never deleted.
 */
export function pagedGroupStats(records) {
  const groups = { texture: [], association: [] };
  for (const info of records) {
    const record = info.record ?? info;
    for (const sense of record.senses ?? []) {
      const counts = { texture: 0, association: 0 };
      for (const relation of sense.relations ?? []) {
        const group = RELATION_TYPE_TO_GROUP[relation.type];
        if (group in counts) counts[group] += 1;
      }
      for (const group of Object.keys(counts)) if (counts[group] > 0) groups[group].push(counts[group]);
    }
  }
  const stat = (list) => ({
    groups: list.length,
    over_20: list.filter((n) => n > 20).length,
    over_100: list.filter((n) => n > 100).length,
    max: list.reduce((m, n) => Math.max(m, n), 0),
  });
  return { texture: stat(groups.texture), association: stat(groups.association) };
}

export function measurePilot(pilot, { canonicalRecords, stage3 = null, runtime = null }) {
  const senses = pilot.senses;
  const accepted = senses.flatMap((s) => (s.relations ?? []));
  const candidates = senses.map((s) => s.candidate_count);
  const inspected = senses.reduce((n, s) => n + s.inspected_count, 0);
  const exploratory = accepted.filter((r) => EXPLORATORY_RELATION_TYPES.has(r.type));
  const amendments = pilot.amendments ?? [];
  return {
    reviewed_senses: senses.length,
    senses_by_target_kind: sortedObject(countBy(senses, (s) => s.target_kind)),
    machine_candidates_per_sense: {
      total: candidates.reduce((a, b) => a + b, 0), min: Math.min(...candidates), median: median(candidates), max: Math.max(...candidates),
    },
    candidates_inspected_by_stage2: inspected,
    accepted_relations: accepted.length,
    acceptance_rate_of_inspected: Number((accepted.length / inspected).toFixed(4)),
    zero_relation_senses: senses.filter((s) => s.decision === 'no-relations').length,
    accepted_per_sense: { min: Math.min(...senses.map((s) => (s.relations ?? []).length)), median: median(senses.map((s) => (s.relations ?? []).length)), max: Math.max(...senses.map((s) => (s.relations ?? []).length)) },
    relation_counts_by_type: sortedObject(countBy(accepted, (r) => r.type)),
    relevance_distribution: sortedObject(countBy(exploratory, (r) => String(r.relevance))),
    new_to_existing_relations: accepted.filter((r) => r.target_kind === 'canonical').length,
    same_batch_relations: accepted.filter((r) => r.target_kind === 'same_batch').length,
    existing_to_new_amendments: amendments.length,
    amendments_by_type: sortedObject(countBy(amendments, (a) => a.relation.type)),
    stage3_simulation: stage3,
    runtime,
    paged_groups_canonical_today: pagedGroupStats(canonicalRecords),
  };
}

// ---- Stage 3 simulation (real production planner, in memory only) -----------------------------------

const refCandidate = (ref) => ref.replace(/-s\d+$/u, '');
const refSenseIndex = (ref) => Number(ref.match(/-s(\d+)$/u)[1]) - 1;

/** Applies the pilot relations to a copy of the reviewed decisions, exactly as a Stage 2 result would carry them. */
export function withPilotRelations(decisions, pilot, batchId, index) {
  const rows = structuredClone(decisions);
  const byCandidate = new Map(rows.map((row) => [row.source_candidate_id, row]));
  const tuple = (relation) => {
    const targetCandidate = relation.target_kind === 'same_batch' ? refCandidate(relation.target_sense) : index.bySenseId.get(relation.target_sense)?.record_id;
    return {
      target: targetCandidate,
      target_sense: relation.target_sense,
      type: relation.type,
      note: relation.note,
      ...(relation.relevance === undefined ? {} : { relevance: relation.relevance }),
    };
  };
  for (const entry of pilot.senses.filter((s) => s.sense_ref.startsWith(`${batchId}-`))) {
    const row = byCandidate.get(refCandidate(entry.sense_ref));
    const sense = row.reviewed_record.senses[refSenseIndex(entry.sense_ref)];
    if (entry.relations?.length) sense.relations = entry.relations.map(tuple);
  }
  for (const amendment of pilot.amendments ?? []) {
    if (!amendment.relation.target_sense.startsWith(`${batchId}-`)) continue;
    const row = byCandidate.get(refCandidate(amendment.relation.target_sense));
    const source = index.bySenseId.get(amendment.source_sense_id);
    row.relation_amendments = [...(row.relation_amendments ?? []), {
      source_record_id: source.record_id,
      source_sense_id: amendment.source_sense_id,
      source_gloss_sha256: amendment.source_gloss_sha256,
      relation: {
        target: refCandidate(amendment.relation.target_sense),
        target_sense: amendment.relation.target_sense,
        type: amendment.relation.type,
        note: amendment.relation.note,
        ...(amendment.relation.relevance === undefined ? {} : { relevance: amendment.relation.relevance }),
      },
      rationale: amendment.rationale,
    }];
  }
  return rows;
}

/**
 * Runs the real Stage 3 planner three times per batch: as authored (appended), replayed on the already-amended
 * source records (idempotent already_present) and with a corrupted source-gloss digest (stale, fail closed).
 */
export async function simulateStage3({ pilot, batchIds, canonical, index, repo = REPO }) {
  const { planStage3Admission } = await import('../factory/admission.mjs');
  const rowsAll = canonical.records.map((info) => info.record);
  const pathById = new Map(canonical.records.map((info) => [info.record.id, info.filePath]));
  const totals = { batches_planned: 0, amendments_appended: 0, replay_already_present: 0, replay_changes: 0, stale_rejected: 0, stale_code: null, relations_in_new_senses: 0 };
  for (const batchId of batchIds) {
    const read = async (file) => readFile(path.join(repo, file), 'utf8');
    const lines = (text) => text.trimEnd().split('\n').map((line) => JSON.parse(line));
    const candidateManifest = JSON.parse(await read(`data/candidates/${batchId}/manifest.json`));
    const reviewManifest = JSON.parse(await read(`data/reviews/${batchId}/manifest.json`));
    const candidates = lines(await read(`data/candidates/${batchId}/candidates.jsonl`));
    const decisions = lines(await read(`data/reviews/${batchId}/decisions.jsonl`));
    const base = {
      batchId, attempt: reviewManifest.attempt, admissionPr: 1, candidateManifest, reviewManifest, candidates,
      recordPathById: pathById, baseCanonicalSnapshotDigest: 'a'.repeat(64),
    };
    const authored = withPilotRelations(decisions, pilot, batchId, index);
    const plan = planStage3Admission({ ...base, decisions: structuredClone(authored), canonicalRecords: rowsAll });
    totals.batches_planned += 1;
    const audit = plan.reviewManifest.admission.relation_amendments ?? [];
    totals.amendments_appended += audit.filter((a) => a.outcome === 'appended').length;
    totals.relations_in_new_senses += authored.flatMap((row) => row.reviewed_record?.senses ?? []).reduce((n, s) => n + (s.relations?.length ?? 0), 0);
    if (!audit.length) continue;
    // Replay: the amended source records are already canonical, so the same tuples are idempotent no-ops.
    const appended = new Map(plan.changes.filter((c) => c.operation === 'append_relations').map((c) => [c.entry_id, plan.records.get(c.entry_id).record]));
    const amendedRows = rowsAll.map((record) => {
      const amended = appended.get(record.id);
      if (!amended) return record;
      // Only the relations change; senses appended by the same batch to other entries stay out of the replay base.
      return { ...record, senses: record.senses.map((sense) => ({ ...sense, ...(amended.senses.find((x) => x.id === sense.id)?.relations ? { relations: amended.senses.find((x) => x.id === sense.id).relations } : {}) })) };
    });
    const replay = planStage3Admission({ ...base, decisions: structuredClone(authored), canonicalRecords: amendedRows });
    const replayAudit = replay.reviewManifest.admission.relation_amendments ?? [];
    totals.replay_already_present += replayAudit.filter((a) => a.outcome === 'already_present').length;
    totals.replay_changes += replay.changes.filter((c) => c.operation === 'append_relations').length;
    // Stale: a changed source gloss digest must fail closed with the lexical stale-source code.
    const stale = structuredClone(authored);
    const row = stale.find((item) => item.relation_amendments);
    row.relation_amendments[0].source_gloss_sha256 = 'f'.repeat(64);
    try {
      planStage3Admission({ ...base, decisions: stale, canonicalRecords: rowsAll });
    } catch (error) {
      if (error.code === 'STAGE3_STALE_RELATION_SOURCE') { totals.stale_rejected += 1; totals.stale_code = error.code; } else throw error;
    }
  }
  return totals;
}
