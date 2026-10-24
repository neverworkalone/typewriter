import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { MEANING_RELATION_ORIGINS } from '../../src/runtime/dictionary-contract.js';
import { buildCanonicalIndex, validateRelationRows } from '../relation/admission.mjs';

/**
 * Approved Relations JSONL (Issue #928) -> product meaning relations.
 *
 * Invariant: every approved ID relation becomes exactly two navigable rows, the forward row with its own type/tier and a
 * reverse row with the reverse type/tier, each in the same `meaning_relations` table and index path as every other
 * relation; every text-only relation becomes one non-navigable `meaning_text_relations` row with no reverse. Candidate
 * and Drop files are never read. A row that duplicates an existing STDICT-derived relation of the same pair and type
 * fails the build instead of being silently merged.
 */
export const DEFAULT_RELATIONS_DIRECTORY = path.resolve('data/relations');

/** Read every `relation-<SSS>.jsonl` of a directory as `{ shard, rows }` (line numbers are kept for provenance). */
export async function loadApprovedRelationFiles(directory) {
  if (!directory || !existsSync(directory)) return [];
  const files = [];
  for (const name of (await readdir(directory)).filter((item) => /^relation-\d{3}\.jsonl$/u.test(item)).sort()) {
    const lines = (await readFile(path.join(directory, name), 'utf8')).split(/\r?\n/u);
    const rows = [];
    lines.forEach((text, index) => {
      if (text.length === 0) return;
      try {
        rows.push({ row: JSON.parse(text), line: index + 1 });
      } catch (error) {
        throw new Error(`${name}:${index + 1} is not valid JSON: ${error.message}`);
      }
    });
    files.push({ shard: name.slice('relation-'.length, -'.jsonl'.length), rows });
  }
  return files;
}

/** Sense IDs owned by each Canonical shard file (`stdict-NNNN.jsonl` -> `NNN`); a source sense belongs to the shard that stores it. */
export async function loadShardSenseIds(canonicalDirectory) {
  const owners = new Map();
  for (const name of (await readdir(canonicalDirectory)).filter((item) => /^stdict-\d{4}\.jsonl$/u.test(item)).sort()) {
    const senseIds = new Set();
    for (const line of (await readFile(path.join(canonicalDirectory, name), 'utf8')).split(/\r?\n/u)) {
      if (line.length === 0) continue;
      for (const sense of JSON.parse(line).senses ?? []) senseIds.add(sense.id);
    }
    owners.set(name.slice('stdict-0'.length, -'.jsonl'.length), senseIds);
  }
  return owners;
}

/** Build source-shard ownership from the already loaded Canonical record infos. */
export function buildShardSenseIdsFromCanonicalRecords(recordInfos) {
  const owners = new Map();
  for (const recordInfo of recordInfos) {
    const record = recordInfo.record ?? recordInfo;
    const fileName = path.basename(recordInfo.filePath ?? '');
    const match = /^stdict-0(\d{3})\.jsonl$/u.exec(fileName);
    if (!match) throw new Error(`Canonical record ${record.id} has no recognized source shard file.`);
    const senseIds = owners.get(match[1]) ?? new Set();
    for (const sense of record.senses ?? []) senseIds.add(sense.id);
    owners.set(match[1], senseIds);
  }
  return owners;
}

const keyOf = (source, target, type) => `${source}\u0000${target}\u0000${type}`;

/**
 * @param {{ shard: string, rows: { row: object, line: number }[] }[]} files
 * @param {object[]} records normalized Canonical records
 * @param {{ id: string, sense_ids: string[] }[]} meanings record meanings
 * @param {object[]} existing meaning relations already projected (STDICT projection, gloss, direct reverse)
 * @param {Map<string, Set<string>>} shardSenseIds Canonical shard -> its sense IDs; a file may only hold relations whose source sense it owns
 */
export function projectAuthoredRelations({ files, records, meanings, existing, shardSenseIds }) {
  const stats = { authored_file_count: files.length, authored_row_count: 0, authored_id_relation_count: 0, authored_text_relation_count: 0, authored_deduplicated_count: 0 };
  if (files.length === 0) return { relations: [], textRelations: [], stats };

  const { index } = validateApprovedRelationRows({ files, records, shardSenseIds });
  const senseToMeaning = new Map();
  for (const meaning of meanings) for (const senseId of meaning.sense_ids) senseToMeaning.set(senseId, meaning.id);

  const idEntries = [];
  const textEntries = [];
  let order = 0;
  for (const { shard, rows } of files) {
    for (const { row, line } of rows) {
      stats.authored_row_count += 1;
      const source = senseToMeaning.get(row.source_sense_id);
      if (source === undefined) throw new Error(`relation-${shard}.jsonl:${line}: ${row.source_sense_id} has no meaning`);
      order += 1;
      if ('text' in row) {
        textEntries.push({ source_meaning_id: source, text: row.text, type: row.type, relevance: row.relevance, order });
        continue;
      }
      const target = senseToMeaning.get(row.target_sense_id);
      if (target === undefined) throw new Error(`relation-${shard}.jsonl:${line}: ${row.target_sense_id} has no meaning`);
      const provenance = { shard, line, source_sense_id: row.source_sense_id, target_sense_id: row.target_sense_id };
      idEntries.push({
        source_meaning_id: source, target_meaning_id: target, type: row.type, relevance: row.relevance,
        origin: MEANING_RELATION_ORIGINS.authored, authored_source: { ...provenance, direction: 'forward' }, order,
      });
      idEntries.push({
        source_meaning_id: target, target_meaning_id: source, type: row.reverse_type, relevance: row.reverse_relevance,
        origin: MEANING_RELATION_ORIGINS.authoredReverse, authored_source: { ...provenance, direction: 'reverse' }, order,
      });
    }
  }

  const existingKeys = new Set(existing.map((relation) => keyOf(relation.source_meaning_id, relation.target_meaning_id, relation.type)));
  const taken = new Set(existingKeys);
  const nextPosition = new Map();
  for (const relation of existing) {
    nextPosition.set(relation.source_meaning_id, Math.max(nextPosition.get(relation.source_meaning_id) ?? 0, relation.position + 1));
  }
  // Most prominent tier first, then file order: a pair/type reached by several senses of the same meanings keeps its best tier.
  const side = (entry) => (entry.authored_source?.direction === 'reverse' ? 1 : 0);
  const byTier = (left, right) => left.relevance - right.relevance || left.order - right.order || side(left) - side(right);
  const relations = [];
  const kept = new Map();
  for (const entry of [...idEntries].sort(byTier)) {
    const key = keyOf(entry.source_meaning_id, entry.target_meaning_id, entry.type);
    if (taken.has(key)) {
      if (existingKeys.has(key)) throw new Error(`authored ${entry.type} ${entry.authored_source.source_sense_id} -> ${entry.authored_source.target_sense_id} duplicates an existing relation of the same pair and type`);
      stats.authored_deduplicated_count += 1;
      // The lower-tier row still contributed: the kept row records every approved row that reached it.
      kept.get(key)?.authored_sources.push(entry.authored_source);
      continue;
    }
    taken.add(key);
    const position = nextPosition.get(entry.source_meaning_id) ?? 0;
    nextPosition.set(entry.source_meaning_id, position + 1);
    const relation = {
      source_meaning_id: entry.source_meaning_id,
      target_meaning_id: entry.target_meaning_id,
      type: entry.type,
      note: '',
      relevance: entry.relevance,
      origin: entry.origin,
      position,
      sources: [],
      authored_sources: [entry.authored_source],
    };
    kept.set(key, relation);
    relations.push(relation);
  }

  const textTaken = new Set();
  const textPosition = new Map();
  const textRelations = [];
  for (const entry of [...textEntries].sort(byTier)) {
    const key = `${entry.source_meaning_id}\u0000${entry.text}\u0000${entry.type}`;
    if (textTaken.has(key)) { stats.authored_deduplicated_count += 1; continue; }
    textTaken.add(key);
    const position = textPosition.get(entry.source_meaning_id) ?? 0;
    textPosition.set(entry.source_meaning_id, position + 1);
    textRelations.push({ source_meaning_id: entry.source_meaning_id, position, text: entry.text, type: entry.type, relevance: entry.relevance });
  }

  stats.authored_id_relation_count = relations.length;
  stats.authored_text_relation_count = textRelations.length;
  return { relations, textRelations, stats };
}

/** Validate all approved files against one complete Canonical index and the full cross-shard input set. */
export function validateApprovedRelationRows({ files, records = [], shardSenseIds, canonicalIndex }) {
  const index = canonicalIndex ?? buildCanonicalIndex(records);
  const previous = [];
  let rowCount = 0;
  for (const { shard, rows } of files) {
    const owned = shardSenseIds?.get(shard);
    if (!owned) throw new Error(`relation-${shard}.jsonl: no Canonical shard stdict-0${shard}.jsonl owns this file`);
    const relationRows = rows.map(({ row }) => row);
    try {
      validateRelationRows({ relationRows, index, shardSenseIds: owned, otherRelationRows: previous });
    } catch (error) {
      throw new Error(`relation-${shard}.jsonl: ${error.message}`);
    }
    previous.push(...relationRows);
    rowCount += relationRows.length;
  }
  return { fileCount: files.length, rowCount, index };
}
