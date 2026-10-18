import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CANDIDATE_BATCH_SIZE, normalizeCandidate, parseCandidateJsonl, validateCandidateBatch } from './candidate-contract.mjs';

export { normalizeCandidate };

/**
 * Stage 2 Relation Admission tooling (Issue #928). Rule it guarantees: every unique Stage 1 candidate of a shard ends
 * in exactly one of {new Relation, real Drop, exact-duplicate merge, existing approved Relation}, and every approved
 * Relation names a real Canonical source sense (and, for an ID link, a real target record/sense of the same spelling).
 * It never creates candidates, never rescoring existing Relations and never reads Stage 1 files other than as input.
 */
const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const ADMISSION_TYPES = Object.freeze(['near', 'mood', 'scene', 'sensory', 'action', 'association']);
/** Required Stage 1 producers per batch: A/B by Codex and Claude, C and D by one owner-assigned model each. */
export const REQUIRED_PRODUCERS = Object.freeze(['a_codex', 'a_claude', 'b_codex', 'b_claude', 'c', 'd']);
export const BATCHES = Object.freeze(['01', '02']);

const ID_ROW_KEYS = 'relevance,reverse_relevance,reverse_type,source_record_id,source_sense_id,target_record_id,target_sense_id,type';
const TEXT_ROW_KEYS = 'relevance,source_record_id,source_sense_id,text,type';
const DROP_ROW_KEYS = 'candidate,reason,source_record_id,source_sense_id';

const keysOf = (row) => Object.keys(row).sort().join(',');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTier = (value) => Number.isInteger(value) && value >= 1 && value <= 9;
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

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

/**
 * Merge Stage 1 Candidate rows into unique candidates per source sense. Each file must already satisfy Candidate v1
 * for its batch. Exact duplicates (after `normalizeCandidate`) merge; the producer list is kept as evidence.
 * @param {{ name: string, rows: object[] }[]} candidateFiles
 */
export function mergeCandidates(canonicalRows, candidateFiles) {
  const merged = new Map();
  let raw = 0;
  for (const file of candidateFiles) {
    const { batch, key } = producerOf(path.basename(file.name));
    validateCandidateBatch(canonicalRows, file.rows, { batch, candidateName: file.name });
    for (const row of file.rows) {
      for (const sense of row.senses) {
        const bySense = merged.get(sense.sense_id) ?? { record_id: row.record_id, candidates: new Map() };
        merged.set(sense.sense_id, bySense);
        for (const text of sense.candidates) {
          raw += 1;
          const normalized = normalizeCandidate(text);
          const producers = bySense.candidates.get(normalized) ?? [];
          if (!producers.includes(key)) producers.push(key);
          bySense.candidates.set(normalized, producers);
        }
      }
    }
  }
  return { merged, rawCandidateCount: raw };
}

/** Lemma -> records and id lookups over the full Canonical (all shards). */
export function buildCanonicalIndex(rows) {
  const byId = new Map();
  const byLemma = new Map();
  const senses = new Map();
  for (const row of rows) {
    byId.set(row.id, row);
    byLemma.set(row.lemma, [...(byLemma.get(row.lemma) ?? []), row]);
    for (const sense of row.senses) senses.set(sense.id, { record: row, sense });
  }
  return { byId, byLemma, senses };
}

/**
 * Validate approved Relation + Drop rows of one shard against the Canonical index. Pure; throws one aggregated error.
 * `otherRelationRows` are approved rows of every other shard (duplicate/reverse-duplicate detection).
 */
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

  relationRows.forEach((row, position) => {
    const at = `relation:${position + 1}`;
    if (!isPlainObject(row)) { errors.push(`${at}: must be an object`); return; }
    const isText_ = 'text' in row;
    const expected = isText_ ? TEXT_ROW_KEYS : ID_ROW_KEYS;
    if (keysOf(row) !== expected) { errors.push(`${at}: must have exactly ${expected}`); return; }
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

  if (errors.length > 0) throw new Error(`Relation Admission rows are invalid:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  return { relationCount: relationRows.length, dropCount: dropRows.length };
}

/**
 * Existing approved Relations (other shards, forward and reverse) mapped to the Stage 1 candidate they already
 * answer, as `sourceSenseId\0normalizedCandidate`. An ID relation answers a candidate only when the candidate equals the
 * counterpart lemma AND that lemma identifies a single Canonical record; an ambiguous homograph spelling is never
 * silently treated as covered.
 */
export function existingCandidateKeys(relationRows, index) {
  const covered = new Map();
  const add = (senseId, text, why) => covered.set(`${senseId}\u0000${normalizeCandidate(text)}`, why);
  for (const row of relationRows) {
    if ('text' in row) { add(row.source_sense_id, row.text, 'text-only'); continue; }
    const target = index.byId.get(row.target_record_id);
    const source = index.byId.get(row.source_record_id);
    if (target && (index.byLemma.get(target.lemma) ?? []).length === 1) add(row.source_sense_id, target.lemma, 'id-forward');
    if (source && (index.byLemma.get(source.lemma) ?? []).length === 1) add(row.target_sense_id, source.lemma, 'id-reverse');
  }
  return covered;
}

/**
 * Prepare the editing input of a shard: unique new candidates with the exact source sense/gloss, minus candidates an
 * existing approved Relation already answers. Never an editorial judgement; nothing is dropped here.
 */
export function prepareShard({ canonicalRows, candidateFiles, approvedRelationRows = [], dropRows = [], index, scopeRows = canonicalRows }) {
  const { merged, rawCandidateCount } = mergeCandidates(canonicalRows, candidateFiles);
  const covered = existingCandidateKeys(approvedRelationRows, index);
  const dropped = new Set(dropRows.map((row) => `${row.source_sense_id}\u0000${normalizeCandidate(row.candidate)}`));
  const items = [];
  const stats = { raw: rawCandidateCount, unique: 0, merged_duplicates: 0, skipped_existing: 0, skipped_dropped: 0, to_edit: 0 };
  for (const record of scopeRows) {
    for (const sense of record.senses) {
      const entry = merged.get(sense.id);
      if (!entry) continue;
      const fresh = [];
      for (const [text, producers] of entry.candidates) {
        stats.unique += 1;
        if (text === normalizeCandidate(record.lemma)) throw new Error(`${sense.id}: candidate ${JSON.stringify(text)} repeats the source lemma`);
        if (covered.has(`${sense.id}\u0000${text}`)) { stats.skipped_existing += 1; continue; }
        if (dropped.has(`${sense.id}\u0000${text}`)) { stats.skipped_dropped += 1; continue; }
        fresh.push({ text, producers, same_spelling_records: (index.byLemma.get(text) ?? []).map((target) => target.id) });
      }
      if (fresh.length === 0) continue;
      stats.to_edit += fresh.length;
      items.push({ record_id: record.id, sense_id: sense.id, lemma: record.lemma, pos: sense.pos, gloss: sense.gloss, candidates: fresh });
    }
  }
  stats.merged_duplicates = stats.raw - stats.unique;
  return { items, stats };
}

/**
 * Account for every unique candidate: new Relation, real Drop or existing approved Relation (excluding this shard's own
 * rows, which are the result being checked). Throws on a missing, doubly-assigned or unknown candidate.
 */
export function verifyAccounting({ canonicalRows, candidateFiles, relationRows: allRelationRows, dropRows: allDropRows, otherRelationRows, index, scopeRows = canonicalRows }) {
  const { merged, rawCandidateCount } = mergeCandidates(canonicalRows, candidateFiles);
  const scopeSenses = new Set(scopeRows.flatMap((record) => record.senses.map((sense) => sense.id)));
  const relationRows = allRelationRows.filter((row) => scopeSenses.has(row.source_sense_id));
  const dropRows = allDropRows.filter((row) => scopeSenses.has(row.source_sense_id));
  const covered = existingCandidateKeys(otherRelationRows, index);
  const errors = [];
  const claimed = new Map();
  const claim = (senseId, text, how, at) => {
    const key = `${senseId}\u0000${text}`;
    if (claimed.has(key)) errors.push(`${at}: candidate ${JSON.stringify(text)} of ${senseId} is already ${claimed.get(key)}`);
    claimed.set(key, how);
    const entry = merged.get(senseId);
    if (!entry || !entry.candidates.has(text)) errors.push(`${at}: ${JSON.stringify(text)} is not a Stage 1 candidate of ${senseId}`);
  };
  relationRows.forEach((row, position) => {
    const at = `relation:${position + 1}`;
    if ('text' in row) claim(row.source_sense_id, row.text, 'a text-only relation', at);
    else {
      const lemma = index.byId.get(row.target_record_id)?.lemma;
      if (lemma === undefined) return;
      claim(row.source_sense_id, lemma, 'an ID relation', at);
    }
  });
  dropRows.forEach((row, position) => claim(row.source_sense_id, row.candidate, 'a drop', `drop:${position + 1}`));
  // A Drop says the candidate is unrelated to the source meaning; the source's own gloss naming it is direct counter-evidence.
  const glossOf = new Map(scopeRows.flatMap((record) => record.senses.map((sense) => [sense.id, sense.gloss])));
  dropRows.forEach((row, position) => {
    if (normalizeCandidate(glossOf.get(row.source_sense_id) ?? '').includes(row.candidate)) errors.push(`drop:${position + 1}: ${JSON.stringify(row.candidate)} is named by the gloss of ${row.source_sense_id} and cannot be dropped as unrelated`);
  });

  // An ID pair is stored once. When both senses listed each other as a Stage 1 candidate, the stored row's reverse
  // direction answers the other candidate, provided the source spelling identifies one Canonical record.
  const reverseCovered = new Map();
  for (const row of allRelationRows) {
    if ('text' in row) continue;
    const source = index.byId.get(row.source_record_id);
    if (source && (index.byLemma.get(source.lemma) ?? []).length === 1) {
      reverseCovered.set(`${row.target_sense_id}\u0000${normalizeCandidate(source.lemma)}`, row.source_sense_id);
    }
  }

  const counts = { unique: 0, relation: relationRows.length, drop: dropRows.length, skipped_existing: 0, reverse_covered: 0, missing: 0 };
  for (const record of scopeRows) {
    for (const sense of record.senses) {
      for (const text of merged.get(sense.id)?.candidates.keys() ?? []) {
        if (text === normalizeCandidate(record.lemma)) throw new Error(`${sense.id}: candidate ${JSON.stringify(text)} repeats the source lemma`);
        counts.unique += 1;
        const key = `${sense.id}\u0000${text}`;
        if (claimed.has(key)) {
          if (covered.has(key)) errors.push(`${sense.id}: ${JSON.stringify(text)} is already answered by an approved Relation (${covered.get(key)}) and must not be re-authored`);
          else if (reverseCovered.has(key)) errors.push(`${sense.id}: ${JSON.stringify(text)} is already answered by the reverse of a stored ID pair (${reverseCovered.get(key)}) and cannot also be ${claimed.get(key)}`);
          continue;
        }
        if (covered.has(key)) { counts.skipped_existing += 1; continue; }
        if (reverseCovered.has(key)) { counts.reverse_covered += 1; continue; }
        counts.missing += 1;
        errors.push(`${sense.id}: candidate ${JSON.stringify(text)} has no relation, drop or existing approved relation`);
      }
    }
  }
  if (errors.length > 0) throw new Error(`Relation Admission accounting failed:\n${errors.slice(0, 50).map((error) => `- ${error}`).join('\n')}${errors.length > 50 ? `\n- ... ${errors.length - 50} more` : ''}`);
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
    rows.push(...await readJsonl(path.join(directory, name)));
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

export async function loadOptionalJsonl(file) {
  return existsSync(file) ? readJsonl(file) : [];
}
