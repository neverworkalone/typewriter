import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { canonicalTuple, correctionSettled } from './relation-corrections.mjs';

const SAME = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const BACKFILL_ID = /^R\d{6}$/u;
const RECORD_ID = /^[wr]\d+$/u;
const SENSE_ID = /^([wr]\d+)-s[1-9]\d*$/u;
const tupleLocator = (relation) => JSON.stringify([relation.target, relation.target_sense ?? null, relation.type]);
export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

export class RelationPlanError extends Error {
  constructor(message, { category = 'systemic', code = 'RELATION_PLAN' } = {}) {
    super(message);
    this.name = 'RelationPlanError';
    this.category = category;
    this.code = code;
  }
}

const lexical = (message, code) => { throw new RelationPlanError(message, { category: 'lexical', code }); };
const systemic = (message, code) => { throw new RelationPlanError(message, { category: 'systemic', code }); };

export const canonicalRecordSha256 = (record) => sha256Hex(JSON.stringify(record));

/** Digest of [lemma, gloss] for the sense a relation reviewer saw. */
export function targetMeaningSha256(byId, senseId) {
  const recordId = SENSE_ID.exec(senseId ?? '')?.[1];
  const record = recordId ? byId.get(recordId) : undefined;
  const sense = record?.senses?.find(({ id }) => id === senseId);
  return sense ? canonicalRecordSha256([record.lemma, sense.gloss]) : null;
}

function canonicalFileOnDisk(root, file) {
  if (typeof file !== 'string' || !file.startsWith('data/canonical/')) {
    systemic(`relation writer can write only data/canonical JSONL files, got ${file}`, 'RELATION_CANONICAL_PATH');
  }
  const relative = file.slice('data/canonical/'.length);
  const normalized = path.normalize(relative);
  if (!relative || path.isAbsolute(relative) || normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    systemic(`relation canonical path escapes data/canonical: ${file}`, 'RELATION_CANONICAL_PATH');
  }
  return path.join(root, 'data/canonical', normalized);
}

async function writeCanonicalJsonl(root, file, contents) {
  const destination = canonicalFileOnDisk(root, file);
  const relative = path.relative(path.join(root, 'data/canonical'), destination);
  const final = path.join(root, 'data/canonical', relative);
  await writeFile(`${final}.partial`, contents, 'utf8');
  await rename(`${final}.partial`, final);
}

function relationChangeRows({ audit, records }) {
  return [...records].map(([entryId, update]) => {
    const appended = audit.filter((entry) => entry.source_record_id === entryId && entry.outcome === 'appended');
    return {
      entry_id: entryId,
      operation: 'append_relations',
      path: update.file,
      source_candidate_ids: [...new Set(appended.map((entry) => entry.source_candidate_id))],
      added_relation_ids: appended.map((entry) => entry.relation_id),
      before_sha256: canonicalRecordSha256(update.before),
      after_sha256: canonicalRecordSha256(update.record),
    };
  });
}

/** Plan approved relation additions against current Canonical records. */
export function planRelationBackfill({ packetId, amendments, canonicalRecords, recordPathById }) {
  if (!BACKFILL_ID.test(packetId ?? '')) systemic('backfill packet id must look like R000001', 'RELATION_BACKFILL_ID');
  const byId = new Map(canonicalRecords.map((record) => [record.id, record]));
  const bySenseId = new Map(canonicalRecords.flatMap((record) => (record.senses ?? []).map((sense) => [sense.id, record.id])));
  const working = new Map();
  const audit = [];

  for (const item of amendments) {
    const at = `${packetId}: relation amendment on ${item.source_record_id} ${item.source_sense_id}`;
    const base = byId.get(item.source_record_id);
    const baseSense = base?.senses?.find(({ id }) => id === item.source_sense_id);
    if (!baseSense) lexical(`${at} no longer exists on latest Canonical; the approval is stale and needs re-review`, 'RELATION_STALE_SOURCE');
    if (canonicalRecordSha256(baseSense.gloss) !== item.source_gloss_sha256) {
      lexical(`${at} changed since review; the approval is stale and needs re-review`, 'RELATION_STALE_SOURCE');
    }

    const relation = canonicalTuple(item.relation);
    const targetRecord = byId.get(relation.target);
    if (!RECORD_ID.test(relation.target ?? '') || !targetRecord) lexical(`${at} target record is not in Canonical`, 'RELATION_TARGET');
    if (relation.target === item.source_record_id) lexical(`${at} resolves to a self-reference`, 'RELATION_SELF');
    if (relation.target_sense && bySenseId.get(relation.target_sense) !== relation.target) {
      lexical(`${at} target sense does not belong to its Canonical target record`, 'RELATION_TARGET_SENSE');
    }

    const record = working.get(item.source_record_id) ?? { ...base, senses: base.senses.map((sense) => ({ ...sense })) };
    working.set(item.source_record_id, record);
    const sense = record.senses.find(({ id }) => id === item.source_sense_id);
    const relations = [...(sense.relations ?? [])];
    const existingAt = relations.findIndex((candidate) => tupleLocator(candidate) === tupleLocator(relation));
    if (existingAt >= 0) {
      if (!SAME(canonicalTuple(relations[existingAt]), relation)) {
        lexical(`${at} conflicts with an existing relation to the same target; relation apply does not rewrite existing relations`, 'RELATION_CONFLICT');
      }
      audit.push({ source_candidate_id: packetId, source_record_id: item.source_record_id, source_sense_id: item.source_sense_id,
        source_gloss_sha256: item.source_gloss_sha256, authored_relation_id: reviewedRelationId(item.source_sense_id, item.relation),
        relation_id: reviewedRelationId(item.source_sense_id, relation), rationale_sha256: canonicalRecordSha256(item.rationale), outcome: 'already_present', relation });
      continue;
    }

    relations.push(relation);
    sense.relations = relations;
    audit.push({ source_candidate_id: packetId, source_record_id: item.source_record_id, source_sense_id: item.source_sense_id,
      source_gloss_sha256: item.source_gloss_sha256, authored_relation_id: reviewedRelationId(item.source_sense_id, item.relation),
      relation_id: reviewedRelationId(item.source_sense_id, relation), rationale_sha256: canonicalRecordSha256(item.rationale), outcome: 'appended', relation });
  }

  const records = new Map();
  for (const [id, record] of working) {
    if (!audit.some((entry) => entry.source_record_id === id && entry.outcome === 'appended')) continue;
    const file = recordPathById?.get(id);
    if (!file) systemic(`canonical source path is unknown for ${id}`, 'RELATION_CANONICAL_PATH');
    records.set(id, { record, file, before: byId.get(id) });
  }
  return {
    batchId: packetId,
    attempt: 1,
    decisions: [],
    entries: [],
    records,
    changes: relationChangeRows({ audit, records }),
    relationAmendments: audit,
    relationCorrections: [],
  };
}

/** Plan a source-bound retype, renote, rerank, or removal of an existing relation. */
export function planRelationCorrections({ packetId, corrections, canonicalRecords, recordPathById }) {
  if (!BACKFILL_ID.test(packetId ?? '')) systemic('correction packet id must look like R000001', 'RELATION_BACKFILL_ID');
  const byId = new Map(canonicalRecords.map((record) => [record.id, record]));
  const working = new Map();
  const audit = [];
  for (const item of corrections) {
    const at = `${packetId}: relation correction on ${item.source_record_id} ${item.source_sense_id}`;
    const base = byId.get(item.source_record_id);
    const baseSense = base?.senses?.find(({ id }) => id === item.source_sense_id);
    if (!baseSense) lexical(`${at} no longer exists on latest Canonical; the correction is stale and needs re-review`, 'RELATION_STALE_SOURCE');
    if (canonicalRecordSha256(base) !== item.source_record_sha256) {
      lexical(`${at} source record changed since it was reviewed; the correction is stale and needs re-review`, 'RELATION_STALE_SOURCE');
    }
    if (canonicalRecordSha256(baseSense.gloss) !== item.source_gloss_sha256) {
      lexical(`${at} source sense changed meaning since it was reviewed; the correction is stale and needs re-review`, 'RELATION_STALE_SOURCE');
    }
    const previous = canonicalTuple(item.previous_relation);
    const targetMeaning = targetMeaningSha256(byId, previous.target_sense);
    if (targetMeaning !== item.target_meaning_sha256) {
      lexical(`${at} target ${previous.target_sense} changed meaning since it was reviewed`, 'RELATION_STALE_TARGET');
    }
    const replacement = item.relation === null ? null : canonicalTuple(item.relation);
    const record = working.get(item.source_record_id) ?? { ...base, senses: base.senses.map((sense) => ({ ...sense })) };
    working.set(item.source_record_id, record);
    const sense = record.senses.find(({ id }) => id === item.source_sense_id);
    const relations = [...(sense.relations ?? [])];
    const position = relations.findIndex((candidate) => tupleLocator(candidate) === tupleLocator(previous));
    const entry = {
      source_candidate_id: packetId,
      source_record_id: item.source_record_id,
      source_sense_id: item.source_sense_id,
      source_record_sha256: item.source_record_sha256,
      source_gloss_sha256: item.source_gloss_sha256,
      target_meaning_sha256: item.target_meaning_sha256,
      previous_relation_id: reviewedRelationId(item.source_sense_id, previous),
      previous_relation: previous,
      relation_id: replacement === null ? null : reviewedRelationId(item.source_sense_id, replacement),
      relation: replacement,
      rationale_sha256: canonicalRecordSha256(item.rationale),
    };
    if (position < 0 || !SAME(canonicalTuple(relations[position]), previous) || position !== item.position) {
      if (!correctionSettled(relations, previous, replacement)) lexical(`${at} no longer holds the relation it corrects; the correction is stale and needs re-review`, 'RELATION_CORRECTION_STALE');
      audit.push({ ...entry, position: null, outcome: 'already_applied' });
      continue;
    }
    entry.previous_relation = structuredClone(relations[position]);
    if (replacement === null) relations.splice(position, 1);
    else {
      if (relations.some((candidate, index) => index !== position && tupleLocator(candidate) === tupleLocator(replacement))) {
        lexical(`${at} would duplicate another relation to ${replacement.target_sense}`, 'RELATION_CONFLICT');
      }
      relations[position] = replacement;
    }
    if (relations.length) sense.relations = relations;
    else delete sense.relations;
    audit.push({ ...entry, position, outcome: 'amended' });
  }

  const records = new Map();
  for (const [id, record] of working) {
    if (!audit.some((entry) => entry.source_record_id === id && entry.outcome === 'amended')) continue;
    const file = recordPathById?.get(id);
    if (!file) systemic(`canonical source path is unknown for ${id}`, 'RELATION_CANONICAL_PATH');
    records.set(id, { record, file, before: byId.get(id) });
  }
  const changes = [...records].map(([entryId, update]) => ({
    entry_id: entryId,
    operation: 'amend_relations',
    path: update.file,
    source_candidate_ids: [packetId],
    amended_relation_ids: audit.filter((entry) => entry.source_record_id === entryId && entry.outcome === 'amended').map((entry) => entry.previous_relation_id),
    before_sha256: canonicalRecordSha256(update.before),
    after_sha256: canonicalRecordSha256(update.record),
  }));
  return { batchId: packetId, attempt: 1, decisions: [], entries: [], records, changes, relationAmendments: [], relationCorrections: audit };
}

/** Write only planned Canonical record changes using atomic same-directory replacement. */
export async function writePlannedRecords(plan, root) {
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
      if (replaced) systemic(`${entryId} appears more than once in ${update.file}`, 'RELATION_DUPLICATE_SOURCE_RECORD');
      replaced = true;
      return JSON.stringify(update.record);
    });
    if (!replaced) systemic(`${entryId} was not found in ${update.file}`, 'RELATION_SOURCE_RECORD_MISSING');
    await writeCanonicalJsonl(root, update.file, lines.join('\n'));
  }
  for (const [file, rows] of appendByPath) {
    rows.sort((left, right) => left.id.localeCompare(right.id));
    await writeCanonicalJsonl(root, file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  }
}
