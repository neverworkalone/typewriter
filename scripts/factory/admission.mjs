import { validateDecisionHandoff } from './handoff.mjs';
import { sha256Hex } from './contract.mjs';
import { reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { AMENDMENT_FIELD } from './relation-amendments.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ADMITTED = new Set(['included', 'corrected']);
const W_ID = /^w(\d+)$/u;
const SENSE_ID = /^([wr]\d+)-s([1-9]\d*)$/u;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export class Stage3AdmissionError extends Error {
  constructor(message, { category = 'systemic', code = 'STAGE3_ADMISSION' } = {}) {
    super(message);
    this.name = 'Stage3AdmissionError';
    this.category = category;
    this.code = code;
  }
}

const lexical = (message, code) => { throw new Stage3AdmissionError(message, { category: 'lexical', code }); };
const systemic = (message, code) => { throw new Stage3AdmissionError(message, { category: 'systemic', code }); };

export const canonicalRecordSha256 = (record) => sha256Hex(JSON.stringify(record));

// #396: Stage 3 digests recorded before `relevance` existed bind the record without it.
// Accept such a historical digest only for the same record projected without relevance.
const EXPLORATORY_TYPES = new Set(['near', 'mood', 'scene', 'sensory', 'action', 'association']);
export function matchesHistoricalRecordSha256(record, digest) {
  if (canonicalRecordSha256(record) === digest) return true;
  return canonicalRecordSha256({
    ...record,
    senses: (record.senses ?? []).map((sense) => ({
      ...sense,
      relations: sense.relations?.map((relation) => {
        if (!EXPLORATORY_TYPES.has(relation.type)) return relation;
        const { relevance, ...rest } = relation;
        return rest;
      }),
    })),
  }) === digest;
}
const nextEntryId = (records, offset = 1) => {
  const max = records.reduce((value, record) => Math.max(value, Number(record.id.match(W_ID)?.[1] ?? 0)), 0);
  return 'w' + String(max + offset).padStart(5, '0');
};

function canonicalFileOnDisk(root, file) {
  if (typeof file !== 'string' || !file.startsWith('data/canonical/')) {
    systemic(`Stage 3 can write only data/canonical JSONL files, got ${file}`, 'STAGE3_CANONICAL_PATH');
  }
  const relative = file.slice('data/canonical/'.length);
  const normalized = path.normalize(relative);
  if (!relative || path.isAbsolute(relative) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    systemic(`Stage 3 canonical path escapes data/canonical: ${file}`, 'STAGE3_CANONICAL_PATH');
  }
  return path.join(root, 'data/canonical', normalized);
}

async function writeCanonicalJsonl(root, file, contents) {
  const destination = canonicalFileOnDisk(root, file);
  const relative = path.relative(path.join(root, 'data/canonical'), destination);
  await writeFile(path.join(root, 'data/canonical', relative), contents, 'utf8');
}

function nextSenseOrdinal(record, reserved) {
  const existing = new Set((record?.senses ?? []).map((sense) => sense.id));
  for (const id of reserved) existing.add(id);
  let max = 0;
  for (const id of existing) {
    const match = id.match(SENSE_ID);
    if (match) max = Math.max(max, Number(match[2]));
  }
  return max + 1;
}

function canonicalAliases(decisions) {
  const entryBySource = new Map();
  const senseBySource = new Map();
  const aliasToEntry = new Map();
  const aliasToSense = new Map();
  for (const row of decisions.filter((decision) => ADMITTED.has(decision.disposition))) {
    const entryId = row.target.kind === 'new_entry' ? row.__entry_id : row.target.entry_id;
    entryBySource.set(row.source_candidate_id, entryId);
    row.reviewed_record.senses.forEach((_, index) => {
      const senseId = row.__sense_ids[index];
      senseBySource.set(`${row.source_candidate_id}-s${index + 1}`, senseId);
      if (typeof row.provisional_ref === 'string' && row.provisional_ref) {
        aliasToEntry.set(row.provisional_ref, entryId);
        aliasToSense.set(`${row.provisional_ref}-s${index + 1}`, senseId);
      }
    });
  }
  return { entryBySource, senseBySource, aliasToEntry, aliasToSense };
}

function remapRelations(sense, { aliases, knownRecordIds, knownSenseIds, sourceCandidateId }) {
  if (!Array.isArray(sense.relations)) return undefined;
  return sense.relations.map((relation, index) => {
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) {
      lexical(`${sourceCandidateId}: relation ${index + 1} is not an object`, 'STAGE3_RELATION_SHAPE');
    }
    const target = aliases.entryBySource.get(relation.target)
      ?? aliases.aliasToEntry.get(relation.target)
      ?? relation.target;
    if (typeof target !== 'string' || !knownRecordIds.has(target)) {
      lexical(`${sourceCandidateId}: relation target ${relation.target ?? '(missing)'} cannot be resolved on latest master`, 'STAGE3_RELATION_TARGET');
    }
    const remapped = { ...relation, target };
    if (relation.target_sense !== undefined) {
      const targetSense = aliases.senseBySource.get(relation.target_sense)
        ?? aliases.aliasToSense.get(relation.target_sense)
        ?? relation.target_sense;
      if (typeof targetSense !== 'string' || !knownSenseIds.has(targetSense)) {
        lexical(`${sourceCandidateId}: relation target_sense ${relation.target_sense} cannot be resolved on latest master`, 'STAGE3_RELATION_SENSE');
      }
      remapped.target_sense = targetSense;
    }
    return remapped;
  });
}

// Canonical tuple key order (target, target_sense, type, note, relevance), independent of authoring order.
const canonicalTuple = ({ target, target_sense: targetSense, type, note, relevance }) => ({
  target, ...(targetSense === undefined ? {} : { target_sense: targetSense }), type, note, ...(relevance === undefined ? {} : { relevance }),
});
const tupleLocator = (relation) => JSON.stringify([relation.target, relation.target_sense ?? null, relation.type]);

/**
 * Relation-only amendments (#399). Each reviewed tuple is bound to an existing canonical source sense by its gloss
 * digest; the whole-record digest is deliberately NOT bound so unrelated concurrent appends never make it stale.
 * Existing relations are never rewritten or re-ranked; an exact tuple already present is an idempotent no-op.
 */
function planRelationAmendments({ decisions, byId, planned, aliases, allRecordIds, allSenseIds, recordPathById }) {
  const working = new Map();
  const audit = [];
  for (const row of decisions) {
    if (!ADMITTED.has(row.disposition)) continue;
    for (const item of row[AMENDMENT_FIELD] ?? []) {
      const at = `${row.source_candidate_id}: relation amendment on ${item.source_record_id} ${item.source_sense_id}`;
      const base = byId.get(item.source_record_id);
      const baseSense = base?.senses?.find(({ id }) => id === item.source_sense_id);
      if (!baseSense) lexical(`${at} no longer exists on latest master; the enrichment is stale and needs re-review`, 'STAGE3_STALE_RELATION_SOURCE');
      if (canonicalRecordSha256(baseSense.gloss) !== item.source_gloss_sha256) {
        lexical(`${at} changed meaning since Stage 2 reviewed it; the enrichment is stale and needs re-review`, 'STAGE3_STALE_RELATION_SOURCE');
      }
      if (planned.has(item.source_record_id)) {
        lexical(`${at} targets a record this batch also appends senses to; use the normal new-sense relation path`, 'STAGE3_RELATION_SOURCE_CONFLICT');
      }
      const [remapped] = remapRelations({ relations: [item.relation] }, { aliases, knownRecordIds: allRecordIds, knownSenseIds: allSenseIds, sourceCandidateId: row.source_candidate_id });
      const relation = canonicalTuple(remapped);
      if (relation.target === item.source_record_id || relation.target_sense === item.source_sense_id) {
        lexical(`${at} resolves to a self-reference`, 'STAGE3_RELATION_SELF');
      }
      const record = working.get(item.source_record_id) ?? { ...base, senses: base.senses.map((sense) => ({ ...sense })) };
      working.set(item.source_record_id, record);
      const sense = record.senses.find(({ id }) => id === item.source_sense_id);
      const existing = (sense.relations ?? []).find((candidate) => tupleLocator(candidate) === tupleLocator(relation));
      let outcome = 'appended';
      if (existing) {
        if (JSON.stringify(canonicalTuple(existing)) !== JSON.stringify(relation)) {
          lexical(`${at} conflicts with an existing ${relation.type} relation to the same target that carries a different note or relevance; Stage 3 does not rewrite existing relations`, 'STAGE3_RELATION_CONFLICT');
        }
        outcome = 'already_present';
      } else {
        sense.relations = [...(sense.relations ?? []), relation];
      }
      audit.push({
        source_candidate_id: row.source_candidate_id,
        source_record_id: item.source_record_id,
        source_sense_id: item.source_sense_id,
        source_gloss_sha256: item.source_gloss_sha256,
        authored_relation_id: reviewedRelationId(item.source_sense_id, item.relation),
        relation_id: reviewedRelationId(item.source_sense_id, relation),
        relation,
        rationale_sha256: canonicalRecordSha256(item.rationale),
        outcome,
      });
    }
  }
  const records = new Map();
  for (const [id, record] of working) {
    if (!audit.some((entry) => entry.source_record_id === id && entry.outcome === 'appended')) continue;
    const file = recordPathById?.get(id);
    if (!file) systemic(`canonical source path is unknown for ${id}`, 'STAGE3_CANONICAL_PATH');
    records.set(id, { record, file, before: byId.get(id) });
  }
  return { audit, records };
}

function decisionSenses(row, idStart, aliases, knownRecordIds, knownSenseIds) {
  return row.reviewed_record.senses.map((sense, index) => {
    const result = { id: row.__sense_ids[index], pos: sense.pos, gloss: sense.gloss };
    const relations = remapRelations(sense, { aliases, knownRecordIds, knownSenseIds, sourceCandidateId: row.source_candidate_id });
    if (relations !== undefined) result.relations = relations;
    return result;
  });
}

/**
 * Build the deterministic Stage 3 write set for one fully reviewed batch.
 * `canonicalRecords` is the complete latest canonical revision; `recordPathById`
 * identifies the tracked JSONL file that owns each current record.
 */
export function planStage3Admission({
  batchId, attempt, admissionPr, candidateManifest, reviewManifest, candidates, decisions,
  canonicalRecords, recordPathById, baseCanonicalSnapshotDigest,
} = {}) {
  if (!/^C\d{6}$/u.test(batchId ?? '') || !Number.isInteger(attempt) || attempt < 1) {
    systemic('batch id and attempt are required', 'STAGE3_ATTEMPT');
  }
  if (!Number.isInteger(admissionPr) || admissionPr < 1) systemic('draft admission PR number is required', 'STAGE3_PR');
  if (candidateManifest?.status !== 'complete' || reviewManifest?.status !== 'ready'
    || candidateManifest.batch_id !== batchId || reviewManifest.batch_id !== batchId
    || reviewManifest.attempt !== attempt) {
    lexical(`${batchId}: latest master no longer has the expected complete candidate and ready review attempt`, 'STAGE3_STALE_REVIEW');
  }
  if (candidateManifest.candidates_sha256 !== reviewManifest.candidates_sha256) {
    lexical(`${batchId}: candidate digest changed after Stage 2 review`, 'STAGE3_CANDIDATE_DIGEST');
  }
  const rowsById = new Map(candidates.map((row) => [row.candidate_id, row]));
  if (rowsById.size !== candidates.length) systemic(`${batchId}: duplicate candidate identities reached the allocator`, 'STAGE3_DUPLICATE_CANDIDATE');
  if (decisions.length !== candidates.length || decisions.some((row, index) => row.source_candidate_id !== candidates[index].candidate_id)) {
    lexical(`${batchId}: Stage 2 decisions do not cover candidates in source order`, 'STAGE3_DECISION_COVERAGE');
  }
  const canonicalIndex = new Map();
  const byId = new Map();
  const records = canonicalRecords.map((record) => ({ ...record }));
  for (const record of records) {
    if (!record || typeof record.id !== 'string' || byId.has(record.id)) systemic('latest canonical revision has duplicate or malformed record ids', 'STAGE3_CANONICAL_INDEX');
    byId.set(record.id, record);
    const entries = canonicalIndex.get(record.lemma) ?? [];
    entries.push({ id: record.id, senses: record.senses ?? [] });
    canonicalIndex.set(record.lemma, entries);
  }
  const handoffErrors = validateDecisionHandoff(decisions, { canonicalIndex });
  if (handoffErrors.length) lexical(handoffErrors.join('\n'), 'STAGE3_CANONICAL_CONFLICT');

  // Candidate identity is usage-based. Keep distinct new-entry candidates in
  // distinct canonical records even when their lemmas happen to match.
  const newEntryRows = decisions.filter((row) => ADMITTED.has(row.disposition) && row.target.kind === 'new_entry');
  const entryIdBySource = new Map();
  let allocated = 1;
  for (const row of [...newEntryRows].sort((left, right) => left.source_candidate_id.localeCompare(right.source_candidate_id))) {
    const id = nextEntryId(records, allocated++);
    entryIdBySource.set(row.source_candidate_id, id);
  }
  for (const row of decisions) {
    if (!ADMITTED.has(row.disposition)) continue;
    const entryId = row.target.kind === 'new_entry' ? entryIdBySource.get(row.source_candidate_id) : row.target.entry_id;
    const targetRecord = byId.get(entryId);
    if (row.target.kind !== 'new_entry' && !targetRecord) {
      lexical(`${row.source_candidate_id}: target ${entryId} disappeared from latest canonical data`, 'STAGE3_STALE_TARGET');
    }
    row.__entry_id = entryId;
  }

  const reservedSenses = new Map();
  for (const row of decisions) {
    if (!ADMITTED.has(row.disposition)) continue;
    const entryId = row.__entry_id;
    const existing = byId.get(entryId);
    const reserved = reservedSenses.get(entryId) ?? [];
    let next = reserved.length ? nextSenseOrdinal(existing, reserved) : nextSenseOrdinal(existing, []);
    row.__sense_ids = row.reviewed_record.senses.map(() => `${entryId}-s${next++}`);
    reserved.push(...row.__sense_ids);
    reservedSenses.set(entryId, reserved);
  }

  const aliases = canonicalAliases(decisions);
  const allRecordIds = new Set([...byId.keys(), ...entryIdBySource.values()]);
  const allSenseIds = new Set([...records.flatMap((record) => (record.senses ?? []).map((sense) => sense.id)), ...decisions.flatMap((row) => row.__sense_ids ?? [])]);
  const addedByEntry = new Map();
  for (const row of decisions) {
    if (!ADMITTED.has(row.disposition)) continue;
    const senses = decisionSenses(row, 0, { ...aliases, entryBySource: aliases.entryBySource }, allRecordIds, allSenseIds);
    const additions = addedByEntry.get(row.__entry_id) ?? [];
    additions.push(...senses);
    addedByEntry.set(row.__entry_id, additions);
  }

  const planned = new Map();
  const changeRows = [];
  const sourceIdsByEntry = new Map();
  for (const row of decisions) if (ADMITTED.has(row.disposition)) {
    sourceIdsByEntry.set(row.__entry_id, [...(sourceIdsByEntry.get(row.__entry_id) ?? []), row.source_candidate_id]);
  }

  for (const [entryId, senses] of addedByEntry) {
    const representative = decisions.find((row) => ADMITTED.has(row.disposition) && row.__entry_id === entryId);
    const isNew = representative.target.kind === 'new_entry';
    const existing = byId.get(entryId);
    if (isNew && existing) systemic(`allocator reused canonical record id ${entryId}`, 'STAGE3_ID_COLLISION');
    const before = existing ? { ...existing, senses: [...existing.senses] } : null;
    const record = existing
      ? { ...existing, senses: [...existing.senses, ...senses] }
      : { id: entryId, record_type: 'entry', role: 'start', candidate_id: entryId, lemma: representative.reviewed_record.lemma, search_forms: [representative.reviewed_record.lemma], senses: [...senses] };
    const file = existing ? recordPathById?.get(entryId) : `data/canonical/factory-${batchId}-a${attempt}.jsonl`;
    if (!file) systemic(`canonical source path is unknown for ${entryId}`, 'STAGE3_CANONICAL_PATH');
    planned.set(entryId, { record, file, before });
    changeRows.push({
      entry_id: entryId,
      operation: isNew ? 'create' : 'append_senses',
      path: file,
      source_candidate_ids: sourceIdsByEntry.get(entryId),
      added_sense_ids: senses.map((sense) => sense.id),
      before_sha256: before ? canonicalRecordSha256(before) : null,
      after_sha256: canonicalRecordSha256(record),
    });
  }

  const amendments = planRelationAmendments({ decisions, byId, planned, aliases, allRecordIds, allSenseIds, recordPathById });
  for (const [entryId, update] of amendments.records) {
    planned.set(entryId, update);
    const appended = amendments.audit.filter((entry) => entry.source_record_id === entryId && entry.outcome === 'appended');
    changeRows.push({
      entry_id: entryId,
      operation: 'append_relations',
      path: update.file,
      source_candidate_ids: [...new Set(appended.map((entry) => entry.source_candidate_id))],
      added_relation_ids: appended.map((entry) => entry.relation_id),
      before_sha256: canonicalRecordSha256(update.before),
      after_sha256: canonicalRecordSha256(update.record),
    });
  }

  const entries = decisions.filter((row) => ADMITTED.has(row.disposition)).map((row) => ({
    source_candidate_id: row.source_candidate_id,
    record_id: row.__entry_id,
    sense_ids: [...row.__sense_ids],
  }));
  const nextReviewManifest = {
    ...reviewManifest,
    status: 'complete',
    admission: {
      contract: 'lexical-factory-admission-v1',
      attempt,
      admission_pr: admissionPr,
      base_canonical_snapshot_digest: baseCanonicalSnapshotDigest,
      canonical_snapshot_digest: null,
      entries,
      ...(amendments.audit.length ? { relation_amendments: amendments.audit } : {}),
      changes: changeRows.sort((left, right) => left.entry_id.localeCompare(right.entry_id)),
    },
  };
  delete nextReviewManifest.rejected_pr;
  return { batchId, attempt, decisions, records: planned, reviewManifest: nextReviewManifest, entries, changes: nextReviewManifest.admission.changes, relationAmendments: amendments.audit };
}

export async function applyStage3FileChanges(plan, { root = process.cwd(), reviewManifestPath } = {}) {
  if (!reviewManifestPath) systemic('review manifest path is required', 'STAGE3_FILE_IO');
  const appendByPath = new Map();
  for (const [entryId, update] of plan.records) {
    if (!update.before) {
      appendByPath.set(update.file, [...(appendByPath.get(update.file) ?? []), update.record]);
      continue;
    }
    const absolute = canonicalFileOnDisk(root, update.file);
    const text = await readFile(absolute, 'utf8');
    let replaced = false;
    const lines = text.split('\n').map((line) => {
      if (!line) return line;
      const current = JSON.parse(line);
      if (current.id !== entryId) return line;
      if (replaced) systemic(`${entryId} appears more than once in ${update.file}`, 'STAGE3_DUPLICATE_SOURCE_RECORD');
      replaced = true;
      return JSON.stringify(update.record);
    });
    if (!replaced) systemic(`${entryId} was not found in ${update.file}`, 'STAGE3_SOURCE_RECORD_MISSING');
    await writeCanonicalJsonl(root, update.file, lines.join('\n'));
  }
  for (const [file, rows] of appendByPath) {
    rows.sort((left, right) => left.id.localeCompare(right.id));
    await writeCanonicalJsonl(root, file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  }
  await writeFile(reviewManifestPath, `${JSON.stringify(plan.reviewManifest, null, 2)}\n`, 'utf8');
}

export function validateStage3AdmissionManifest(reviewManifest, decisions, canonicalById) {
  const errors = [];
  if (reviewManifest.status !== 'complete') {
    if (reviewManifest.admission !== undefined) errors.push('non-complete review must not carry admission mapping');
    return errors;
  }
  const admission = reviewManifest.admission;
  if (!admission || admission.contract !== 'lexical-factory-admission-v1'
    || admission.attempt !== reviewManifest.attempt || !Number.isInteger(admission.admission_pr)
    || !/^[0-9a-f]{64}$/u.test(admission.base_canonical_snapshot_digest ?? '')
    || !/^[0-9a-f]{64}$/u.test(admission.canonical_snapshot_digest ?? '')
    || !Array.isArray(admission.entries) || !Array.isArray(admission.changes)
    || admission.semantic_authority?.path !== 'data/validation/canonical-semantic-decision-source.json'
    || typeof admission.semantic_authority.source_id !== 'string'
    || !/^[0-9a-f]{64}$/u.test(admission.semantic_authority.admission_sha256 ?? '')) {
    return ['complete review requires a valid Stage 3 admission mapping'];
  }
  const expected = decisions.filter((row) => ADMITTED.has(row.disposition)).map((row) => row.source_candidate_id).sort();
  const found = admission.entries.map((row) => row.source_candidate_id).sort();
  if (!same(expected, found) || new Set(found).size !== found.length) errors.push('admission mapping must cover exactly every included/corrected source candidate');
  const entriesBySource = new Map(admission.entries.map((row) => [row.source_candidate_id, row]));
  const decisionBySource = new Map(decisions.map((row) => [row.source_candidate_id, row]));
  const senseOwners = new Set();
  for (const mapping of admission.entries) {
    const decision = decisionBySource.get(mapping.source_candidate_id);
    const record = canonicalById.get(mapping.record_id);
    if (!decision || !record) { errors.push(`admission ${mapping.source_candidate_id} references a missing decision or canonical entry`); continue; }
    if (decision.target.kind !== 'new_entry' && decision.target.entry_id !== mapping.record_id) {
      errors.push(`admission ${mapping.source_candidate_id} changed its reviewed existing entry target`);
    }
    if (record.lemma !== decision.reviewed_record.lemma) errors.push(`admission ${mapping.source_candidate_id} canonical lemma differs from reviewed lemma`);
    if (!Array.isArray(mapping.sense_ids) || mapping.sense_ids.length !== decision.reviewed_record.senses.length) {
      errors.push(`admission ${mapping.source_candidate_id} must map every reviewed sense`); continue;
    }
    mapping.sense_ids.forEach((senseId, index) => {
      if (senseOwners.has(senseId)) errors.push(`admission repeats canonical sense ${senseId}`);
      senseOwners.add(senseId);
      const canonicalSense = record.senses.find((sense) => sense.id === senseId);
      if (!canonicalSense) errors.push(`admission ${mapping.source_candidate_id} is missing canonical sense ${senseId}`);
      else if (canonicalSense.pos !== decision.reviewed_record.senses[index].pos || canonicalSense.gloss !== decision.reviewed_record.senses[index].gloss) {
        errors.push(`admission ${mapping.source_candidate_id} canonical sense ${senseId} differs from the reviewed payload`);
      }
    });
  }
  for (const change of admission.changes) {
    if (!canonicalById.has(change.entry_id)) errors.push(`admission change references missing canonical entry ${change.entry_id}`);
    if (!['create', 'append_senses', 'append_relations'].includes(change.operation)) errors.push(`admission change ${change.entry_id} has an invalid operation`);
    if (typeof change.path !== 'string' || !change.path.startsWith('data/canonical/') || !change.path.endsWith('.jsonl')) errors.push(`admission change ${change.entry_id} has an invalid canonical path`);
    if (change.operation === 'create' && change.before_sha256 !== null) errors.push(`new canonical entry ${change.entry_id} must not have a before digest`);
    if (change.operation !== 'create' && !/^[0-9a-f]{64}$/u.test(change.before_sha256 ?? '')) errors.push(`canonical amendment ${change.entry_id} needs a before digest`);
    if (!/^[0-9a-f]{64}$/u.test(change.after_sha256 ?? '')) errors.push(`admission change ${change.entry_id} needs an after digest`);
    const addedKey = change.operation === 'append_relations' ? 'added_relation_ids' : 'added_sense_ids';
    if (!Array.isArray(change.source_candidate_ids) || !Array.isArray(change[addedKey])
      || change.source_candidate_ids.length === 0 || change[addedKey].length === 0) {
      errors.push(`admission change ${change.entry_id} needs source candidate and ${addedKey}`);
    }
  }
  const amendments = admission.relation_amendments ?? [];
  if (!Array.isArray(amendments)) errors.push('admission relation_amendments must be an array');
  else {
    const admitted = new Set(expected);
    for (const amendment of amendments) {
      const here = `relation amendment ${amendment?.source_candidate_id} ${amendment?.source_sense_id}`;
      const source = canonicalById.get(amendment?.source_record_id);
      const sense = source?.senses?.find(({ id }) => id === amendment.source_sense_id);
      if (!admitted.has(amendment?.source_candidate_id)) errors.push(`${here} is not bound to an admitted source candidate`);
      if (!sense) { errors.push(`${here} names a missing canonical source sense`); continue; }
      if (!['appended', 'already_present'].includes(amendment.outcome)) errors.push(`${here} has an invalid outcome`);
      if (!/^[0-9a-f]{64}$/u.test(amendment.source_gloss_sha256 ?? '') || !/^[0-9a-f]{64}$/u.test(amendment.rationale_sha256 ?? '')) errors.push(`${here} needs gloss and rationale digests`);
      if (!(sense.relations ?? []).some((relation) => JSON.stringify(relation) === JSON.stringify(amendment.relation))) errors.push(`${here} tuple is absent from the canonical source sense`);
      const change = admission.changes.find((item) => item.entry_id === amendment.source_record_id);
      const recorded = change?.operation === 'append_relations' && change.added_relation_ids.includes(amendment.relation_id);
      if ((amendment.outcome === 'appended') !== recorded) errors.push(`${here} outcome does not match the recorded canonical change`);
    }
    for (const change of admission.changes.filter((item) => item.operation === 'append_relations')) {
      const ids = amendments.filter((item) => item.source_record_id === change.entry_id && item.outcome === 'appended').map((item) => item.relation_id);
      if (!same(ids, change.added_relation_ids)) errors.push(`admission change ${change.entry_id} added_relation_ids differ from its relation amendments`);
    }
  }
  return errors;
}
