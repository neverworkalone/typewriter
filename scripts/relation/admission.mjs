import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildTargetIndex, parseArrowReference, resolveArrowTarget } from '../build/gloss-arrow-reference.mjs';
import { CANDIDATE_BATCH_SIZE, normalizeCandidate, parseCandidateJsonl, validateCandidateBatch } from './candidate-contract.mjs';
import { parseDropJsonl, parseRelationJsonl } from './persisted-jsonl.mjs';

export { normalizeCandidate };

/**
 * Stage 2 Relation Admission tooling (Issues #928/#1665). Rule it guarantees: every unique Stage 1 candidate of a shard
 * ends in exactly one of {new Relation, real Drop, exact-duplicate merge, existing approved Relation}, and every approved
 * Relation names a real Canonical source sense (and, for an ID link, a real target record/sense of the same spelling).
 * It never creates candidates, never rescoring existing Relations and never reads Stage 1 files other than as input.
 */
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const ADMISSION_TYPES = Object.freeze(['near', 'mood', 'scene', 'sensory', 'action', 'association']);
/** Required Stage 1 producers per batch: A/B by Codex and Claude, C and D by one owner-assigned model each. */
export const REQUIRED_PRODUCERS = Object.freeze(['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c', 'd']);
export const BATCHES = Object.freeze(['01', '02']);
export const STAGE2_PART_SIZE = 100;
export const PARTS = Object.freeze(['01', '02', '03', '04', '05']);

const LEGACY_ID_ROW_KEYS = 'relevance,reverse_relevance,reverse_type,source_record_id,source_sense_id,target_record_id,target_sense_id,type';
const ASSIGNED_ID_ROW_KEYS = 'candidate_assignment_version,candidate_forms,relevance,reverse_candidate_forms,reverse_relevance,reverse_type,source_record_id,source_sense_id,target_record_id,target_sense_id,type';
const TEXT_ROW_KEYS = 'relevance,source_record_id,source_sense_id,text,type';
const DROP_ROW_KEYS = 'candidate,reason,source_record_id,source_sense_id';

const keysOf = (row) => Object.keys(row).sort().join(',');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTier = (value) => Number.isInteger(value) && value >= 1 && value <= 9;
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

/** Stage 2 must never ask an editor to judge candidates without an actual source meaning. */
export function assertStage2SourceGloss(senseId, gloss, referenceGloss = null) {
  const normalized = typeof gloss === 'string' ? gloss.trim() : '';
  const reference = parseArrowReference(normalized);
  const referenceTail = reference?.ok
    ? normalized.slice(reference.offset + reference.text.length).replace(/^\.\s*/u, '').trim()
    : null;
  // A reference-only gloss (`→ 둘째.`) is usable only with the meaning of its proven target (`sourceReferenceGloss`).
  const referenceResolved = referenceTail === '' && typeof referenceGloss === 'string' && referenceGloss.trim() !== '';
  if (!normalized || /^→\s*\.\s*$/u.test(normalized) || (referenceTail === '' && !referenceResolved)) {
    throw new Error(`Stage 2 source sense ${senseId} has no usable meaning gloss (${JSON.stringify(gloss)}); candidate adjudication is blocked`);
  }
}

/**
 * Meaning of the ONE Canonical record a reference-only source gloss names (same resolution as the product synonym link),
 * as its non-reference glosses; `null` when the reference is not proven or the target has no definition of its own.
 */
export function sourceReferenceGloss(gloss, targetIndex) {
  const reference = parseArrowReference(typeof gloss === 'string' ? gloss.trim() : '');
  if (!reference?.ok) return null;
  const target = resolveArrowTarget(reference, targetIndex);
  if (target.hold) return null;
  const glosses = target.record.senses.map((sense) => sense.gloss).filter((text) => typeof text === 'string' && !text.trim().startsWith('→')); // any arrow gloss (valid, empty or malformed) is no definition
  return glosses.length > 0 ? glosses.join(' / ') : null;
}

export const shardCanonicalPath = (shard, root = REPOSITORY_DIRECTORY) => path.join(root, 'data/canonical', `stdict-${shard.padStart(4, '0')}.jsonl`);
export const shardRelationPath = (shard, root = REPOSITORY_DIRECTORY) => path.join(root, 'data/relations', `relation-${shard}.jsonl`);
export const shardDropPath = (shard, root = REPOSITORY_DIRECTORY) => path.join(root, 'data/relation-drops', `drop-${shard}.jsonl`);

export function assertShard(shard) {
  if (!/^\d{3}$/u.test(shard ?? '') || Number(shard) < 1 || Number(shard) > 428) throw new Error('shard must be 001..428');
}

/** Producer key of a Candidate file name: `001_01_a_codex.jsonl` -> `a_codex`; C/D collapse to `c`/`d` (single owner-assigned model). */
export function producerOf(fileName) {
  const match = /^\d{3}_(01|02)_([a-d])_([a-z0-9_-]+)\.jsonl$/u.exec(fileName);
  if (!match) throw new Error(`${fileName} does not follow the Candidate v1 filename contract`);
  const [, batch, method, model] = match;
  return { batch, method, model, key: method === 'c' || method === 'd' ? method : `${method}_${model}` };
}

/**
 * Which required (batch, producer) Candidate files are present; optional files (e.g. DeepSeek) are carried along.
 * C and D each have one owner-assigned model per batch, so a second C (or D) file of another model is rejected rather
 * than silently merged under the same producer key.
 */
export function candidateInventory(fileNames, { batches = BATCHES } = {}) {
  const present = new Map();
  for (const name of fileNames) {
    const { batch, key } = producerOf(name);
    const slot = `${batch}/${key}`;
    if (present.has(slot) && (key === 'c' || key === 'd')) {
      throw new Error(`batch ${batch} has more than one ${key.toUpperCase()} producer file (${present.get(slot)}, ${name}); C and D allow exactly one owner-assigned model`);
    }
    present.set(slot, name);
  }
  const missing = [];
  for (const batch of batches) {
    for (const key of REQUIRED_PRODUCERS) if (!present.has(`${batch}/${key}`)) missing.push(`${batch}/${key}`);
  }
  return { files: [...fileNames].sort(), missing };
}

/**
 * Restrict a shard run to one 500-record batch: its Canonical rows and its Candidate files. Relation/Drop rows of the
 * other batch of the same shard file are outside this run's accounting.
 */
export function batchScope(canonicalRows, candidateFiles, batch) {
  if (!BATCHES.includes(batch)) throw new Error('batch must be 01 or 02');
  const offset = (Number(batch) - 1) * CANDIDATE_BATCH_SIZE;
  const scopeRows = canonicalRows.slice(offset, offset + CANDIDATE_BATCH_SIZE);
  if (scopeRows.length === 0) throw new Error(`shard has no records for batch ${batch}`);
  return { scopeRows, files: candidateFiles.filter((file) => producerOf(path.basename(file.name)).batch === batch) };
}

/** Restrict Stage 2 editing within one complete Stage 1 batch to a 100-record part. */
export function partScope(canonicalRows, candidateFiles, batch, part) {
  if (!PARTS.includes(part)) throw new Error('part must be 01, 02, 03, 04 or 05');
  const batchResult = batchScope(canonicalRows, candidateFiles, batch);
  const offset = (Number(part) - 1) * STAGE2_PART_SIZE;
  const scopeRows = batchResult.scopeRows.slice(offset, offset + STAGE2_PART_SIZE);
  if (scopeRows.length === 0) throw new Error(`shard batch ${batch} has no records for part ${part}`);
  return { scopeRows, files: batchResult.files };
}

/**
 * Merge Stage 1 Candidate rows into unique candidates per source sense. Each file must already satisfy Candidate v1
 * for its batch. Exact duplicates (after `normalizeCandidate`) merge; the producer list is kept as evidence.
 * @param {{ name: string, rows: object[] }[]} candidateFiles
 */
export function mergeCandidates(canonicalRows, candidateFiles, { canonicalLemmaForms } = {}) {
  const merged = new Map();
  let raw = 0;
  const rawBySense = new Map();
  const independentLemmaForms = canonicalLemmaForms ?? new Set(canonicalRows.map((row) => normalizeCandidate(row.lemma ?? '')));
  for (const file of candidateFiles) {
    const { batch, key } = producerOf(path.basename(file.name));
    validateCandidateBatch(canonicalRows, file.rows, {
      batch,
      candidateName: file.name,
      canonicalLemmaForms: independentLemmaForms,
    });
    for (const row of file.rows) {
      for (const sense of row.senses) {
        const bySense = merged.get(sense.sense_id) ?? { record_id: row.record_id, candidates: new Map() };
        merged.set(sense.sense_id, bySense);
        for (const text of sense.candidates) {
          raw += 1;
          rawBySense.set(sense.sense_id, (rawBySense.get(sense.sense_id) ?? 0) + 1);
          const normalized = normalizeCandidate(text);
          const producers = bySense.candidates.get(normalized) ?? [];
          if (!producers.includes(key)) producers.push(key);
          bySense.candidates.set(normalized, producers);
        }
      }
    }
  }
  return { merged, rawCandidateCount: raw, rawCandidateCountBySense: rawBySense };
}

function rawCandidateCountForScope(rawCandidateCountBySense, scopeRows) {
  return scopeRows.reduce((count, record) => count + record.senses.reduce(
    (senseCount, sense) => senseCount + (rawCandidateCountBySense.get(sense.id) ?? 0), 0,
  ), 0);
}

/** Orthographic variants emitted by the Canonical converter: only spacing/hyphenation variants of the lemma. */
function canonicalOrthographicForms(record) {
  const lemma = normalizeCandidate(record.lemma ?? '');
  const foldedLemma = lemma.replace(/[\s-]/gu, '');
  if (!foldedLemma) return [];
  return [...new Set([record.lemma, ...(Array.isArray(record.search_forms) ? record.search_forms : [])]
    .filter((form) => typeof form === 'string')
    .map(normalizeCandidate)
    .filter((form) => form.replace(/[\s-]/gu, '') === foldedLemma))];
}

/** Curated search forms that name a lexical alias rather than a spacing/hyphenation variant of the lemma. */
function canonicalNonOrthographicSearchForms(record) {
  const lemma = normalizeCandidate(record.lemma ?? '');
  const foldedLemma = lemma.replace(/[\s-]/gu, '');
  if (!foldedLemma) return [];
  return [...new Set((Array.isArray(record.search_forms) ? record.search_forms : [])
    .filter((form) => typeof form === 'string')
    .map(normalizeCandidate)
    .filter((form) => form && form.replace(/[\s-]/gu, '') !== foldedLemma))];
}

function canonicalRecordsForOrthographicForm(index, form) {
  const normalized = normalizeCandidate(form);
  // An exact Canonical lemma owns its spelling. Do not make that target ambiguous merely because
  // another record lists the same spelling as an orthographic search form.
  return index.byNormalizedLemma?.get(normalized) ?? index.byOrthographicForm?.get(normalized) ?? index.byLemma.get(normalized) ?? [];
}

function canonicalRecordsForRelationForm(index, form) {
  const normalized = normalizeCandidate(form);
  const exactLemmaRecords = index.byNormalizedLemma?.get(normalized) ?? [];
  const nonOrthographicAliases = index.byNonOrthographicSearchForm?.get(normalized) ?? [];
  // Keep exact lemmas ahead of colliding orthographic variants, while retaining explicit lexical aliases
  // from search_forms so an unrelated exact homograph cannot hide the intended sense.
  const matchingRecords = exactLemmaRecords.length > 0
    ? [...exactLemmaRecords, ...nonOrthographicAliases]
    : [...(index.byOrthographicForm?.get(normalized) ?? []), ...nonOrthographicAliases];
  // Each group is already in Canonical order; keep the exact-lemma group first instead of sorting aliases over it.
  return [...new Map(matchingRecords.map((record) => [record.id, record])).values()];
}

function createCanonicalRelationFormIndexes() {
  return {
    byLemma: new Map(),
    byNormalizedLemma: new Map(),
    byOrthographicForm: new Map(),
    byNonOrthographicSearchForm: new Map(),
  };
}

function canonicalRecordOf(recordInfoOrRecord) {
  return recordInfoOrRecord.record ?? recordInfoOrRecord;
}

function addCanonicalRelationFormIndexes(index, recordInfoOrRecord) {
  const record = canonicalRecordOf(recordInfoOrRecord);
  index.byLemma.set(record.lemma, [...(index.byLemma.get(record.lemma) ?? []), record]);
  const normalizedLemma = normalizeCandidate(record.lemma);
  index.byNormalizedLemma.set(normalizedLemma, [
    ...(index.byNormalizedLemma.get(normalizedLemma) ?? []),
    record,
  ]);
  for (const form of canonicalOrthographicForms(record)) {
    const matches = index.byOrthographicForm.get(form) ?? [];
    if (!matches.some((match) => match.id === record.id)) {
      index.byOrthographicForm.set(form, [...matches, record]);
    }
  }
  for (const form of canonicalNonOrthographicSearchForms(record)) {
    const matches = index.byNonOrthographicSearchForm.get(form) ?? [];
    if (!matches.some((match) => match.id === record.id)) {
      index.byNonOrthographicSearchForm.set(form, [...matches, record]);
    }
  }
}

/** Build just the Canonical form lookups used by approved Relation assignment validation. */
export function buildCanonicalRelationFormIndex(recordInfosOrRecords) {
  const index = createCanonicalRelationFormIndexes();
  for (const recordInfoOrRecord of recordInfosOrRecords) {
    addCanonicalRelationFormIndexes(index, recordInfoOrRecord);
  }
  return index;
}

/** Candidate spellings that resolve to this record, including ambiguous forms when it is an exact target. */
export function candidateFormsForRecord(record, index) {
  return canonicalOrthographicForms(record).filter((form) =>
    canonicalRecordsForOrthographicForm(index, form).some((match) => match.id === record.id));
}

/** Candidate spellings legacy Relation rows historically inferred from a record. */
export function legacyCandidateFormsForRecord(record, index) {
  return [...new Set([...candidateFormsForRecord(record, index), ...canonicalNonOrthographicSearchForms(record)])];
}

/** Build the decided-candidate index once, then reuse it while assigning multiple reverse Relation rows. */
export function createReverseCandidateFormLookup({ relationRows = [], dropRows = [], index }) {
  const decidedBySense = new Map();
  const decide = (senseId, candidate) => {
    let candidates = decidedBySense.get(senseId);
    if (!candidates) decidedBySense.set(senseId, candidates = new Set());
    candidates.add(normalizeCandidate(candidate));
  };
  for (const row of dropRows) decide(row.source_sense_id, row.candidate);
  const addRelation = (row) => {
    const keys = relationCandidateKeys(row, null, index);
    for (const key of [...keys.forward, ...keys.reverse, ...keys.reverseAliases, ...keys.deferredForward]) {
      decide(key.senseId, key.candidate);
    }
  };
  for (const row of relationRows) addRelation(row);
  return {
    addRelation,
    available(record, targetSenseId) {
      const decided = decidedBySense.get(targetSenseId);
      return candidateFormsForRecord(record, index).filter((candidate) => !decided?.has(normalizeCandidate(candidate)));
    },
  };
}

/** Reverse spellings that are not already decided for the target sense by any Relation, reverse Relation or Drop. */
export function availableReverseCandidateForms(record, targetSenseId, { relationRows = [], dropRows = [], index }) {
  return createReverseCandidateFormLookup({ relationRows, dropRows, index }).available(record, targetSenseId);
}

/** Lemma, curated search-form, and id lookups over the full Canonical (all shards). */
export function buildCanonicalIndex(rows) {
  const byId = new Map();
  const formIndexes = createCanonicalRelationFormIndexes();
  const senses = new Map();
  for (const row of rows) {
    byId.set(row.id, row);
    addCanonicalRelationFormIndexes(formIndexes, row);
    for (const sense of row.senses) senses.set(sense.id, { record: row, sense });
  }
  return { byId, ...formIndexes, senses };
}

/** Complete, source-bound target context for every matching lemma and curated search form. */
export function sameSpellingTargets(index, form) {
  return canonicalRecordsForRelationForm(index, form).map((record) => ({
    record_id: record.id,
    lemma: record.lemma,
    senses: record.senses.map((sense) => ({ sense_id: sense.id, pos: sense.pos, gloss: sense.gloss })),
  }));
}

/** Existing same-source peers for relative type/Tier decisions, including relations stored in reverse. */
export function approvedPeersForSense(senseId, relationRows, index) {
  const peers = [];
  const add = ({ recordId, targetSenseId, type, relevance, text = null }) => {
    const record = index.byId.get(recordId);
    const found = index.senses.get(targetSenseId);
    if (!record || !found || found.record.id !== recordId) return;
    peers.push({
      ...(text === null ? { target_lemma: record.lemma, target_sense_id: targetSenseId, target_pos: found.sense.pos, target_gloss: found.sense.gloss } : { text }),
      type,
      relevance,
    });
  };

  for (const row of relationRows) {
    if ('text' in row) {
      if (row.source_sense_id === senseId) peers.push({ text: row.text, type: row.type, relevance: row.relevance });
      continue;
    }
    if (row.source_sense_id === senseId) add({
      recordId: row.target_record_id, targetSenseId: row.target_sense_id, type: row.type, relevance: row.relevance,
    });
    if (row.target_sense_id === senseId) add({
      recordId: row.source_record_id, targetSenseId: row.source_sense_id, type: row.reverse_type, relevance: row.reverse_relevance,
    });
  }
  return peers;
}

/**
 * Validate approved Relation + Drop rows of one shard against the Canonical index. Pure; throws one aggregated error.
 * `otherRelationRows` are approved rows of every other shard (duplicate/reverse-duplicate detection).
 */
/** Deterministic Batch/Shard verify failure (#2154): the complete, untruncated error list behind the usual message. */
export class AdmissionVerifyError extends Error {
  constructor(family, errors, message) {
    super(message);
    this.name = 'AdmissionVerifyError';
    this.family = family;
    this.errors = errors;
    this.total = errors.length;
  }
}

export function validateRelationRows({ relationRows, dropRows = [], index, shardSenseIds, otherRelationRows = [] }) {
  const errors = [];
  const seenPairs = new Map();
  const pairKey = (sourceSense, targetRecord, targetSense) => `${sourceSense}\u0000${targetRecord}\u0000${targetSense}`;
  const textKey = (sourceSense, text) => `${sourceSense}\u0000${normalizeCandidate(text)}`;

  for (const row of otherRelationRows) {
    if ('text' in row) seenPairs.set(textKey(row.source_sense_id, row.text), 'other shard');
    else {
      seenPairs.set(pairKey(row.source_sense_id, row.target_record_id, row.target_sense_id), 'other shard');
      seenPairs.set(pairKey(row.target_sense_id, row.source_record_id, row.source_sense_id), 'other shard');
    }
  }

  const checkSource = (row, at) => {
    const found = index.senses.get(row.source_sense_id);
    if (!found || found.record.id !== row.source_record_id) errors.push(`${at}: source_sense_id ${row.source_sense_id} is not a sense of ${row.source_record_id}`);
    else if (!shardSenseIds.has(row.source_sense_id)) errors.push(`${at}: source sense ${row.source_sense_id} is outside this shard`);
    return found;
  };
  const checkCandidateForms = (forms, recordId, at, field, { allowEmpty = true } = {}) => {
    if (!Array.isArray(forms)) { errors.push(`${at}: ${field} must be an array of normalized candidate strings`); return; }
    if (!allowEmpty && forms.length === 0) errors.push(`${at}: ${field} must contain at least one candidate spelling`);
    const seen = new Set();
    for (const form of forms) {
      if (!isText(form) || form !== normalizeCandidate(form)) {
        errors.push(`${at}: ${field} must contain only non-empty normalized candidate strings`);
        continue;
      }
      if (seen.has(form)) errors.push(`${at}: ${field} repeats candidate ${JSON.stringify(form)}`);
      seen.add(form);
      if (!canonicalRecordsForRelationForm(index, form).some((record) => record.id === recordId)) {
        errors.push(`${at}: ${field} candidate ${JSON.stringify(form)} does not resolve to ${recordId}`);
      }
    }
  };

  relationRows.forEach((row, position) => {
    const at = `relation:${position + 1}`;
    if (!isPlainObject(row)) { errors.push(`${at}: must be an object`); return; }
    const isText_ = 'text' in row;
    const assignedId = !isText_ && Object.hasOwn(row, 'candidate_assignment_version');
    const expected = isText_ ? TEXT_ROW_KEYS : assignedId ? ASSIGNED_ID_ROW_KEYS : LEGACY_ID_ROW_KEYS;
    if (keysOf(row) !== expected) {
      errors.push(`${at}: must have exactly ${expected}${!isText_ && !assignedId ? ` or ${ASSIGNED_ID_ROW_KEYS}` : ''}`);
      return;
    }
    const source = checkSource(row, at);
    if (!ADMISSION_TYPES.includes(row.type)) errors.push(`${at}: type ${JSON.stringify(row.type)} is not one of ${ADMISSION_TYPES.join('/')}`);
    if (!isTier(row.relevance)) errors.push(`${at}: relevance must be an integer 1..9`);
    if (isText_) {
      if (!isText(row.text) || row.text !== normalizeCandidate(row.text)) errors.push(`${at}: text must be a non-empty normalized string`);
      else {
        if (source && row.text === normalizeCandidate(source.record.lemma)) errors.push(`${at}: text repeats the source lemma`);
        const key = textKey(row.source_sense_id, row.text);
        if (seenPairs.has(key)) errors.push(`${at}: duplicate text relation ${row.source_sense_id} -> ${row.text} (${seenPairs.get(key)})`);
        seenPairs.set(key, 'this shard');
      }
      return;
    }
    if (!ADMISSION_TYPES.includes(row.reverse_type)) errors.push(`${at}: reverse_type ${JSON.stringify(row.reverse_type)} is not one of ${ADMISSION_TYPES.join('/')}`);
    if (!isTier(row.reverse_relevance)) errors.push(`${at}: reverse_relevance must be an integer 1..9`);
    if (row.reverse_type !== row.type || row.reverse_relevance !== row.relevance) {
      errors.push(`${at}: reverse_type and reverse_relevance must match type and relevance`);
    }
    if (assignedId) {
      if (![0, 1].includes(row.candidate_assignment_version)) errors.push(`${at}: candidate_assignment_version must be 0 (legacy inferred) or 1 (selected)`);
      checkCandidateForms(row.candidate_forms, row.target_record_id, at, 'candidate_forms', { allowEmpty: false });
      checkCandidateForms(row.reverse_candidate_forms, row.source_record_id, at, 'reverse_candidate_forms');
    }
    const target = index.senses.get(row.target_sense_id);
    if (!target || target.record.id !== row.target_record_id) { errors.push(`${at}: target_sense_id ${row.target_sense_id} is not a sense of ${row.target_record_id}`); return; }
    if (row.target_record_id === row.source_record_id) errors.push(`${at}: relation targets its own record`);
    const forward = pairKey(row.source_sense_id, row.target_record_id, row.target_sense_id);
    if (seenPairs.has(forward)) errors.push(`${at}: duplicate or reverse-duplicate ID relation ${row.source_sense_id} <-> ${row.target_sense_id} (${seenPairs.get(forward)})`);
    seenPairs.set(forward, 'this shard');
    seenPairs.set(pairKey(row.target_sense_id, row.source_record_id, row.source_sense_id), 'this shard');
  });

  const dropSeen = new Set();
  dropRows.forEach((row, position) => {
    const at = `drop:${position + 1}`;
    if (!isPlainObject(row) || keysOf(row) !== DROP_ROW_KEYS) { errors.push(`${at}: must have exactly ${DROP_ROW_KEYS}`); return; }
    checkSource(row, at);
    if (!isText(row.candidate) || row.candidate !== normalizeCandidate(row.candidate)) errors.push(`${at}: candidate must be a non-empty normalized string`);
    if (!isText(row.reason)) errors.push(`${at}: reason must be non-empty text`);
    const key = textKey(row.source_sense_id, row.candidate ?? '');
    if (dropSeen.has(key)) errors.push(`${at}: duplicate drop ${row.source_sense_id} -> ${row.candidate}`);
    dropSeen.add(key);
  });

  if (errors.length > 0) throw new AdmissionVerifyError('rows', errors, `Relation Admission rows are invalid:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  return { relationCount: relationRows.length, dropCount: dropRows.length };
}

/**
 * Coarse existing approved Relation coverage mapped to `sourceSenseId\0normalizedCandidate`, without retaining the
 * target sense. Target-sensitive preparation and accounting use existingCandidateLinks instead. An ID relation is
 * mapped when its exact counterpart is among the Canonical records matched by the candidate spelling.
 */
export function existingCandidateKeys(relationRows, index) {
  const covered = new Map();
  for (const [key, links] of existingCandidateLinks(relationRows, index)) covered.set(key, links.at(-1).why);
  return covered;
}

/**
 * Candidate keys owned by one stored relation. `merged` is the Stage 1 candidate map when the caller has it; without
 * that map legacy rows retain the previous Canonical-form inference used for cross-shard coverage. Version 1 forward
 * forms and version 0/1 reverse forms are explicit assignments. Legacy search aliases remain conditional forward
 * claims in accounting, so they cannot override a separately decided candidate.
 */
export function relationCandidateKeys(row, merged, index) {
  if ('text' in row) return {
    forward: [{ senseId: row.source_sense_id, candidate: normalizeCandidate(row.text), kind: 'text', direction: 'forward' }],
    reverse: [],
    reverseAliases: [],
    deferredForward: [],
  };

  const source = index.byId.get(row.source_record_id);
  const target = index.byId.get(row.target_record_id);
  if (!source || !target) return { forward: [], reverse: [], reverseAliases: [], deferredForward: [] };
  const sourceCandidates = merged?.get(row.source_sense_id)?.candidates;
  let forward;
  let deferredForward = [];
  if (row.candidate_assignment_version === 1 && Array.isArray(row.candidate_forms)) {
    forward = row.candidate_forms.map((candidate) => ({ senseId: row.source_sense_id, candidate, kind: 'id', direction: 'forward', targetSenseId: row.target_sense_id }));
  } else if (sourceCandidates) {
    const matchingForms = candidateFormsForRecord(target, index).filter((form) => sourceCandidates.has(form));
    const matchingAliases = canonicalNonOrthographicSearchForms(target).filter((form) => sourceCandidates.has(form));
    const formsToClaim = matchingForms.length > 0 ? matchingForms
      : matchingAliases.length > 0 ? [] : [normalizeCandidate(target.lemma)];
    forward = formsToClaim.map((candidate) => ({ senseId: row.source_sense_id, candidate, kind: 'id', direction: 'forward', targetSenseId: row.target_sense_id }));
    deferredForward = matchingAliases.map((candidate) => ({
      senseId: row.source_sense_id, candidate, kind: 'id', direction: 'forward', targetSenseId: row.target_sense_id, deferred: true,
    }));
  } else {
    forward = legacyCandidateFormsForRecord(target, index).map((candidate) => ({
      senseId: row.source_sense_id, candidate, kind: 'id', direction: 'forward', targetSenseId: row.target_sense_id,
    }));
  }

  const hasAssignedReverse = [0, 1].includes(row.candidate_assignment_version) && Array.isArray(row.reverse_candidate_forms);
  const reverseForms = hasAssignedReverse ? row.reverse_candidate_forms : candidateFormsForRecord(source, index);
  const reverseAliases = hasAssignedReverse ? [] : canonicalNonOrthographicSearchForms(source);
  return {
    forward,
    reverse: reverseForms.map((candidate) => ({
      senseId: row.target_sense_id, candidate, kind: 'id', direction: 'reverse', targetSenseId: row.source_sense_id,
    })),
    reverseAliases: reverseAliases.map((candidate) => ({
      senseId: row.target_sense_id, candidate, kind: 'id', direction: 'reverse', targetSenseId: row.source_sense_id,
    })),
    deferredForward,
  };
}

/** Existing approved candidate links, retaining the exact target sense and assigned spellings when present. */
function existingCandidateLinks(relationRows, index, merged = null) {
  const links = new Map();
  const add = ({ senseId, candidate, kind, targetSenseId, direction }) => {
    const key = `${senseId}\u0000${normalizeCandidate(candidate)}`;
    const link = { kind, ...(targetSenseId ? { targetSenseId } : {}),
      why: kind === 'text' ? 'text-only' : direction === 'reverse' ? 'id-reverse' : 'id-forward' };
    links.set(key, [...(links.get(key) ?? []), link]);
  };
  for (const row of relationRows) {
    const keys = relationCandidateKeys(row, merged, index);
    for (const key of [...keys.forward, ...keys.reverse, ...keys.reverseAliases, ...keys.deferredForward]) add(key);
  }
  return links;
}

/**
 * Stage 3 deletions may orphan only the exact Stage 1 candidate keys they previously covered. This returns Drops owned
 * by the selected Canonical scope, and only when no current forward/reverse Relation or existing Drop still covers
 * the key. Callers still run the ordinary row and accounting validators before persisting the result.
 */
export function orphanedCandidateDrops({ canonicalRows, candidateFiles, scopeRows = canonicalRows, removedRelationRows = [],
  relationRows = [], dropRows = [], index }) {
  const canonicalLemmaForms = new Set([...index.byLemma.keys()].map(normalizeCandidate));
  const { merged } = mergeCandidates(canonicalRows, candidateFiles, { canonicalLemmaForms });
  const scopeSenses = new Set(scopeRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  const covered = existingCandidateLinks(relationRows, index, merged);
  const dropped = new Set(dropRows.map((row) => `${row.source_sense_id}\u0000${normalizeCandidate(row.candidate)}`));
  const orphaned = new Map();
  for (const removed of removedRelationRows) {
    if ('text' in removed) continue;
    const keys = relationCandidateKeys(removed, merged, index);
    for (const key of [...keys.forward, ...keys.reverse, ...keys.reverseAliases, ...keys.deferredForward]) {
      const candidate = normalizeCandidate(key.candidate);
      const mapKey = `${key.senseId}\u0000${candidate}`;
      if (!scopeSenses.has(key.senseId) || !merged.get(key.senseId)?.candidates.has(candidate)
          || covered.has(mapKey) || dropped.has(mapKey)) continue;
      const recordId = merged.get(key.senseId).record_id;
      orphaned.set(mapKey, { source_record_id: recordId, source_sense_id: key.senseId, candidate, reason: 'edit' });
    }
  }
  return [...orphaned.values()];
}

/**
 * Prepare unique candidates with the exact source sense/gloss. Candidate accounting is per (source sense, candidate);
 * an existing ID relation answers it without requiring links to every sense of a polysemous target. When requested by
 * the Part workflow, partially covered candidates remain visible for optional additional links to unlinked senses.
 * Never an editorial judgement; nothing is dropped here.
 */
export function prepareShard({ canonicalRows, candidateFiles, approvedRelationRows = [], dropRows = [], index, scopeRows = canonicalRows, includePartiallyCovered = false }) {
  const canonicalLemmaForms = new Set([...index.byLemma.keys()].map(normalizeCandidate));
  const { merged, rawCandidateCountBySense } = mergeCandidates(canonicalRows, candidateFiles, { canonicalLemmaForms });
  const rawCandidateCount = rawCandidateCountForScope(rawCandidateCountBySense, scopeRows);
  const covered = existingCandidateLinks(approvedRelationRows, index, merged);
  const dropped = new Set(dropRows.map((row) => `${row.source_sense_id}\u0000${normalizeCandidate(row.candidate)}`));
  let referenceTargets = null;
  const targetIndex = { get: (lemma) => (referenceTargets ??= buildTargetIndex([...index.byId.values()], () => true)).get(lemma) };
  const items = [];
  const stats = { raw: rawCandidateCount, unique: 0, merged_duplicates: 0, skipped_existing: 0, skipped_dropped: 0, to_edit: 0 };
  for (const record of scopeRows) {
    for (const sense of record.senses) {
      const entry = merged.get(sense.id);
      if (!entry) continue;
      const fresh = [];
      const partiallyCovered = [];
      for (const [text, producers] of entry.candidates) {
        stats.unique += 1;
        if (text === normalizeCandidate(record.lemma)) throw new Error(`${sense.id}: candidate ${JSON.stringify(text)} repeats the source lemma`);
        const links = covered.get(`${sense.id}\u0000${text}`) ?? [];
        const nonIdLink = links.some((link) => link.kind !== 'id');
        const targetRecords = canonicalRecordsForRelationForm(index, text);
        const targetSenseIds = targetRecords.flatMap((targetRecord) => targetRecord.senses.map((targetSense) => targetSense.id));
        const hasExistingIdLink = links.some((link) => link.kind === 'id' && targetSenseIds.includes(link.targetSenseId));
        if (nonIdLink || hasExistingIdLink) {
          stats.skipped_existing += 1;
          const existingTargetSenseIds = [...new Set(links.filter((link) => link.kind === 'id').map((link) => link.targetSenseId))]
            .filter((targetSenseId) => targetSenseIds.includes(targetSenseId)).sort();
          const unlinkedTargetSenseIds = targetSenseIds.filter((targetSenseId) => !existingTargetSenseIds.includes(targetSenseId));
          if (includePartiallyCovered && !nonIdLink && hasExistingIdLink && unlinkedTargetSenseIds.length > 0) {
            partiallyCovered.push({
              text,
              producers,
              same_spelling_records: targetRecords.map((target) => target.id),
              already_accounted: true,
              existing_target_sense_ids: existingTargetSenseIds,
              unlinked_target_sense_ids: unlinkedTargetSenseIds,
            });
          }
          continue;
        }
        if (dropped.has(`${sense.id}\u0000${text}`)) { stats.skipped_dropped += 1; continue; }
        fresh.push({ text, producers, same_spelling_records: targetRecords.map((target) => target.id) });
      }
      if (fresh.length === 0 && partiallyCovered.length === 0) continue;
      const referenceGloss = sourceReferenceGloss(sense.gloss, targetIndex);
      assertStage2SourceGloss(sense.id, sense.gloss, referenceGloss);
      stats.to_edit += fresh.length;
      items.push({
        record_id: record.id,
        sense_id: sense.id,
        lemma: record.lemma,
        pos: sense.pos,
        gloss: sense.gloss,
        ...(referenceGloss === null ? {} : { reference_gloss: referenceGloss }),
        // Pre-accounted candidates go first so regular chunks remain a contiguous undecided prefix.
        candidates: [...partiallyCovered, ...fresh],
      });
    }
  }
  stats.merged_duplicates = stats.raw - stats.unique;
  return { items, stats };
}

const GLOSS_GRAMMATICAL_SUFFIXES = [
  '으로부터', '에서부터', '에게서', '한테서', '은커녕', '는커녕', '이라도', '이든지', '으로', '에서',
  '에게', '한테', '께서', '까지', '부터', '보다', '처럼', '만큼', '조차', '마저', '밖에', '마다', '든지',
  '이라', '이랑', '이며', '이고', '이라서', '인데', '이면', '이라면', '으로는', '에서는', '에게는',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '나', '야', '요', '든', '들',
].sort((left, right) => right.length - left.length);

const GLOSS_NUMERIC_UNITS = [
  '센티미터', '킬로미터', '세기', '단계', '미터', '년', '월', '일', 'cm', 'mm', 'km',
].sort((left, right) => right.length - left.length);

const isWordCharacter = (character) => Boolean(character) && /[\p{L}\p{N}]/u.test(character);

function endsAtGlossWordBoundary(text, { allowNumericUnit = false, depth = 0 } = {}) {
  const firstCharacter = Array.from(text)[0] ?? '';
  if (!isWordCharacter(firstCharacter)) return true;
  if (depth >= 3) return false;
  const hasNumericUnit = allowNumericUnit && GLOSS_NUMERIC_UNITS.some((unit) => text.startsWith(unit)
    && endsAtGlossWordBoundary(text.slice(unit.length), { depth: depth + 1 }));
  return hasNumericUnit || GLOSS_GRAMMATICAL_SUFFIXES.some((suffix) => text.startsWith(suffix)
    && endsAtGlossWordBoundary(text.slice(suffix.length), { depth: depth + 1 }));
}

/**
 * A gloss names a candidate only when the occurrence has lexical boundaries. Plain substring matching mistakes a
 * short word inside a different compound (for example, `떡` inside `떡갈나무`) for a direct mention. A candidate may
 * still be named with an attached Korean particle/plural marker or a numeric unit (`가로에`, `수들`, `1971년에`).
 * Recognize grammatical suffixes at a word boundary, and numeric units only after a numeric candidate, so `소` inside
 * `소년` is not a match.
 */
function glossNamesExactCandidate(gloss, candidate) {
  const normalizedGloss = normalizeCandidate(gloss);
  const normalizedCandidate = normalizeCandidate(candidate);
  if (!normalizedCandidate) return false;
  let offset = normalizedGloss.indexOf(normalizedCandidate);
  const isNumericCandidate = /^\d+(?:[,.]\d+)*$/u.test(normalizedCandidate);
  while (offset !== -1) {
    const before = Array.from(normalizedGloss.slice(0, offset)).at(-1) ?? '';
    const afterText = normalizedGloss.slice(offset + normalizedCandidate.length);
    if (!isWordCharacter(before) && endsAtGlossWordBoundary(afterText, { allowNumericUnit: isNumericCandidate })) return true;
    offset = normalizedGloss.indexOf(normalizedCandidate, offset + 1);
  }
  return false;
}

function glossNamesCandidate(gloss, candidate, index) {
  const normalized = normalizeCandidate(candidate);
  const forms = new Set([normalized]);
  for (const record of canonicalRecordsForOrthographicForm(index, normalized)) {
    for (const form of canonicalOrthographicForms(record)) forms.add(form);
  }
  return [...forms].some((form) => glossNamesExactCandidate(gloss, form));
}

/** The existing accounting rule for Drops that repeat the bound meaning gloss. */
export function findGlossNamedDrops({ dropRows, scopeRows, index }) {
  const scopeSenses = new Set(scopeRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  const glossOf = new Map(scopeRows.flatMap((record) => record.senses.map((sense) => [sense.id, sense.gloss])));
  return dropRows.flatMap((row, position) => {
    if (row.reason === 'edit' || row.reason === 'e' || !scopeSenses.has(row.source_sense_id)
        || !glossNamesCandidate(glossOf.get(row.source_sense_id) ?? '', row.candidate, index)) return [];
    return [{
      position: position + 1,
      source_sense_id: row.source_sense_id,
      candidate: row.candidate,
      message: `drop:${position + 1}: ${JSON.stringify(row.candidate)} is named by the gloss of ${row.source_sense_id} and cannot be dropped as unrelated`,
    }];
  });
}

/**
 * Account for every unique candidate: new Relation, real Drop or existing approved Relation (excluding this shard's own
 * rows, which are the result being checked). Throws on a missing, doubly-assigned or unknown candidate.
 */
export function verifyAccounting({ canonicalRows, candidateFiles, relationRows: allRelationRows, dropRows: allDropRows, otherRelationRows, index, scopeRows = canonicalRows }) {
  const canonicalLemmaForms = new Set([...index.byLemma.keys()].map(normalizeCandidate));
  const { merged, rawCandidateCountBySense } = mergeCandidates(canonicalRows, candidateFiles, { canonicalLemmaForms });
  const rawCandidateCount = rawCandidateCountForScope(rawCandidateCountBySense, scopeRows);
  const scopeSenses = new Set(scopeRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  const relationRows = allRelationRows.filter((row) => scopeSenses.has(row.source_sense_id));
  const dropRows = allDropRows.filter((row) => scopeSenses.has(row.source_sense_id));
  // Keep the bound sense as well as the candidate spelling. A single lexical candidate can point to distinct senses
  // of a polysemous lemma; only a repeated sense pair is a duplicate disposition.
  const approvedLinks = existingCandidateLinks(otherRelationRows, index, merged);
  const errors = [];
  const claimed = new Map();
  const deferredSearchAliasClaims = [];
  const canShareCandidate = (left, right) => left.kind === 'id' && right.kind === 'id' && left.targetSenseId !== right.targetSenseId;
  const claim = (senseId, text, how, link, at) => {
    const key = `${senseId}\u0000${text}`;
    const priorClaims = claimed.get(key) ?? [];
    const conflict = priorClaims.find((prior) => !canShareCandidate(prior.link, link));
    if (conflict) errors.push(`${at}: candidate ${JSON.stringify(text)} of ${senseId} is already ${conflict.how}`);
    claimed.set(key, [...priorClaims, { how, link }]);
    const entry = merged.get(senseId);
    if (!entry || !entry.candidates.has(text)) errors.push(`${at}: ${JSON.stringify(text)} is not a Stage 1 candidate of ${senseId}`);
  };
  relationRows.forEach((row, position) => {
    const at = `relation:${position + 1}`;
    const keys = relationCandidateKeys(row, merged, index);
    for (const key of keys.forward) {
      claim(key.senseId, key.candidate, key.kind === 'text' ? 'a text-only relation' : 'an ID relation',
        { kind: key.kind, ...(key.targetSenseId ? { targetSenseId: key.targetSenseId } : {}) }, at);
    }
    for (const key of keys.deferredForward) deferredSearchAliasClaims.push({
      source_sense_id: key.senseId,
      form: key.candidate,
      link: { kind: key.kind, targetSenseId: key.targetSenseId },
      at,
    });
  });
  dropRows.forEach((row, position) => claim(row.source_sense_id, row.candidate, 'a drop', { kind: 'drop' }, `drop:${position + 1}`));
  // `x` marks an unrelated Drop, so a source gloss naming the candidate is counter-evidence; `e` means it is connected but expression-free.
  errors.push(...findGlossNamedDrops({ dropRows, scopeRows, index }).map((entry) => entry.message));

  // An ID pair is stored once. When both senses listed each other as a Stage 1 candidate, the stored row's reverse
  // direction answers the other candidate when the exact source record matches that candidate spelling.
  const reverseCovered = new Map();
  for (const row of allRelationRows) {
    const keys = relationCandidateKeys(row, merged, index);
    for (const reverse of keys.reverse) {
      const key = `${reverse.senseId}\u0000${reverse.candidate}`;
      reverseCovered.set(key, [...(reverseCovered.get(key) ?? []), { kind: 'id', targetSenseId: reverse.targetSenseId }]);
    }
  }

  // Legacy ID rows (unversioned or version 0) infer non-orthographic search aliases only when no explicit
  // Relation, Drop, or already-approved relation owns that Candidate.
  for (const alias of deferredSearchAliasClaims) {
    const key = `${alias.source_sense_id}\u0000${alias.form}`;
    if ((claimed.get(key)?.length ?? 0) > 0 || approvedLinks.has(key) || reverseCovered.has(key)) continue;
    claim(alias.source_sense_id, alias.form, 'an ID relation', alias.link, alias.at);
  }

  const counts = { unique: 0, relation: relationRows.length, drop: dropRows.length, skipped_existing: 0, reverse_covered: 0, missing: 0 };
  for (const record of scopeRows) {
    for (const sense of record.senses) {
      for (const text of merged.get(sense.id)?.candidates.keys() ?? []) {
        if (text === normalizeCandidate(record.lemma)) throw new Error(`${sense.id}: candidate ${JSON.stringify(text)} repeats the source lemma`);
        counts.unique += 1;
        const key = `${sense.id}\u0000${text}`;
        const claims = claimed.get(key) ?? [];
        const approved = approvedLinks.get(key) ?? [];
        const reverse = reverseCovered.get(key) ?? [];
        if (claims.length > 0) {
          const priorApproval = approved.find((link) => claims.some((claim_) => !canShareCandidate(claim_.link, link)));
          if (priorApproval) errors.push(`${sense.id}: ${JSON.stringify(text)} is already answered by an approved Relation (${priorApproval.why}) and must not be re-authored`);
          const priorReverse = reverse.find((link) => claims.some((claim_) => !canShareCandidate(claim_.link, link)));
          if (priorReverse) {
            const conflictingClaim = claims.find((claim_) => !canShareCandidate(claim_.link, priorReverse));
            errors.push(`${sense.id}: ${JSON.stringify(text)} is already answered by the reverse of a stored ID pair (${priorReverse.targetSenseId}) and cannot also be ${conflictingClaim.how}`);
          }
          continue;
        }
        if (approved.length > 0) { counts.skipped_existing += 1; continue; }
        if (reverse.length > 0) { counts.reverse_covered += 1; continue; }
        counts.missing += 1;
        errors.push(`${sense.id}: candidate ${JSON.stringify(text)} has no relation, drop or existing approved relation`);
      }
    }
  }
  if (errors.length > 0) throw new AdmissionVerifyError('accounting', errors, `Relation Admission accounting failed:\n${errors.slice(0, 50).map((error) => `- ${error}`).join('\n')}${errors.length > 50 ? `\n- ... ${errors.length - 50} more` : ''}`);
  return { ...counts, raw: rawCandidateCount, merged_duplicates: rawCandidateCount - counts.unique };
}

// ---- file IO -------------------------------------------------------------------------------------------------

async function readJsonl(file) {
  return parseCandidateJsonl(await readFile(file, 'utf8'), file);
}

export async function loadAllCanonical(root = REPOSITORY_DIRECTORY) {
  const directory = path.join(root, 'data/canonical');
  const files = (await readdir(directory)).filter((name) => /^stdict-\d{4}\.jsonl$/u.test(name)).sort();
  const rows = [];
  for (const file of files) rows.push(...await readJsonl(path.join(directory, file)));
  return rows;
}

export async function loadApprovedRelations(root = REPOSITORY_DIRECTORY, { exceptShard = null } = {}) {
  const directory = path.join(root, 'data/relations');
  if (!existsSync(directory)) return [];
  const rows = [];
  for (const name of (await readdir(directory)).filter((item) => /^relation-\d{3}\.jsonl$/u.test(item)).sort()) {
    if (exceptShard && name === `relation-${exceptShard}.jsonl`) continue;
    rows.push(...parseRelationJsonl(await readFile(path.join(directory, name), 'utf8'), name));
  }
  return rows;
}

export async function loadOptionalRelationJsonl(file) {
  return existsSync(file) ? parseRelationJsonl(await readFile(file, 'utf8'), path.basename(file)) : [];
}

export async function loadOptionalDropJsonl(file) {
  return existsSync(file) ? parseDropJsonl(await readFile(file, 'utf8'), path.basename(file)) : [];
}

export async function loadAllApprovedDrops(root = REPOSITORY_DIRECTORY) {
  const directory = path.join(root, 'data/relation-drops');
  if (!existsSync(directory)) return [];
  const rows = [];
  for (const name of (await readdir(directory)).filter((item) => /^drop-\d{3}\.jsonl$/u.test(item)).sort()) {
    rows.push(...parseDropJsonl(await readFile(path.join(directory, name), 'utf8'), name));
  }
  return rows;
}

/**
 * With `batch`, files that belong to the other batch are neither inventoried nor parsed: a batch run depends only on its
 * own Candidate files, so a conflicting or unfinished file of the other batch cannot block it.
 */
export async function loadShardCandidateFiles(shard, root = REPOSITORY_DIRECTORY, { batch = null } = {}) {
  const directory = path.join(root, 'data/relation-candidates', shard);
  const otherBatch = (name) => batch !== null && /^\d{3}_(01|02)_/u.test(name) && !new RegExp(`^\\d{3}_${batch}_`, 'u').test(name);
  const names = existsSync(directory) ? (await readdir(directory)).filter((name) => name.endsWith('.jsonl') && !otherBatch(name)).sort() : [];
  const inventory = candidateInventory(names, batch === null ? {} : { batches: [batch] });
  const files = [];
  for (const name of inventory.files) files.push({ name, rows: await readJsonl(path.join(directory, name)) });
  return { files, inventory };
}

export async function loadShard(shard, root = REPOSITORY_DIRECTORY, { batch = null } = {}) {
  assertShard(shard);
  const canonicalRows = await readJsonl(shardCanonicalPath(shard, root));
  const [{ files, inventory }, allCanonical] = await Promise.all([loadShardCandidateFiles(shard, root, { batch }), loadAllCanonical(root)]);
  return { canonicalRows, candidateFiles: files, inventory, index: buildCanonicalIndex(allCanonical), batchSize: CANDIDATE_BATCH_SIZE };
}
