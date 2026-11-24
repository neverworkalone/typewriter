import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { MEANING_RELATION_ORIGINS } from '../../src/runtime/dictionary-contract.js';
import { buildCanonicalIndex, createRelationDuplicateIndex, validateRelationRows } from '../relation/admission.mjs';
import { deserializeRelationRow, isText, relationTextKey } from '../relation/persisted-jsonl.mjs';

/**
 * Approved Relations JSONL (Issue #928) -> product meaning relations.
 *
 * Invariant: every approved ID relation becomes exactly two navigable rows, both using the one persisted type/tier, each
 * in the same `meaning_relations` table and index path as every other
 * relation; every text-only relation becomes one non-navigable `meaning_text_relations` row with no reverse. Candidate
 * and Drop files are never read. A row that duplicates an existing STDICT-derived relation of the same pair and type
 * fails the build instead of being silently merged.
 *
 * Scale (#9922): the approved corpus is read one shard file at a time into compact typed columns. Row objects of one
 * file are never kept past that file, the cross-shard duplicate check is built once for the whole corpus, and the ID
 * projection is computed over typed arrays and streamed to SQLite instead of materializing two objects per row.
 */
export const DEFAULT_RELATIONS_DIRECTORY = path.resolve('data/relations');

/** Exact approved Relation files of a directory in shard order, as `{ shard, path }` (Stage 2 backups are ignored). */
export function listApprovedRelationFiles(directory) {
  if (!directory || !existsSync(directory)) return [];
  return readdirSync(directory).filter((item) => /^relation-\d{3}\.jsonl$/u.test(item)).sort()
    .map((name) => ({ shard: name.slice('relation-'.length, -'.jsonl'.length), path: path.join(directory, name) }));
}

/** Read one approved file as `{ shard, rows }` (line numbers are kept for provenance). An in-memory file is returned as is. */
export async function readApprovedRelationFile(file) {
  if (file.rows) return file;
  const name = path.basename(file.path);
  const rows = [];
  (await readFile(file.path, 'utf8')).split(/\r?\n/u).forEach((text, index) => {
    if (text.length === 0) return;
    try {
      rows.push({ row: deserializeRelationRow(JSON.parse(text)), line: index + 1 });
    } catch (error) {
      throw new Error(`${name}:${index + 1}: ${error.message}`);
    }
  });
  return { shard: file.shard, rows };
}

/** Read every `relation-<SSS>.jsonl` of a directory as `{ shard, rows }`. */
export async function loadApprovedRelationFiles(directory) {
  const files = [];
  for (const file of listApprovedRelationFiles(directory)) files.push(await readApprovedRelationFile(file));
  return files;
}

/** Sense IDs owned by each Canonical shard file (`stdict-NNNN.jsonl` -> `NNN`); a source sense belongs to the shard that stores it. */
export async function loadShardSenseIds(canonicalDirectory) {
  const owners = new Map();
  for (const name of readdirSync(canonicalDirectory).filter((item) => /^stdict-\d{4}\.jsonl$/u.test(item)).sort()) {
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

/** Append-only typed column. */
class Column {
  constructor(Type) {
    this.values = new Type(1 << 12);
    this.length = 0;
  }

  push(value) {
    if (this.length === this.values.length) {
      const next = new this.values.constructor(this.values.length * 2);
      next.set(this.values);
      this.values = next;
    }
    this.values[this.length] = value;
    this.length += 1;
  }

  done() {
    return this.values.subarray(0, this.length);
  }
}

// Direction-free Sense pair of an ID row as one exact number: both interned Sense numbers stay below 2^26.
const SENSE_LIMIT = 2 ** 26;
const pairNumber = (left, right) => (left < right ? left * SENSE_LIMIT + right : right * SENSE_LIMIT + left);

/**
 * Pass 1 over every approved file, in shard order: parse each file (a malformed row fails here, before any validation,
 * as the full loader did), record which direction-free ID Sense pairs and text keys occur more than once, and, when
 * `collect` is set, keep the compact columns the projection needs.
 */
export async function scanApprovedRelationFiles(files, { collect = false } = {}) {
  const senseNumbers = new Map();
  const senseIds = [];
  const intern = (senseId) => {
    let number = senseNumbers.get(senseId);
    if (number === undefined) {
      number = senseIds.length;
      if (number >= SENSE_LIMIT) throw new Error(`approved Relations reference more than ${SENSE_LIMIT} Senses`);
      senseNumbers.set(senseId, number);
      senseIds.push(senseId);
    }
    return number;
  };
  const typeCodes = new Map();
  const types = [];
  const typeCode = (type) => {
    let code = typeCodes.get(type);
    if (code === undefined) {
      code = types.length;
      typeCodes.set(type, code);
      types.push(type);
    }
    return code;
  };

  const pairs = new Column(Float64Array);
  const textKeys = new Set();
  const repeatedTextKeys = new Set();
  const id = collect ? {
    source: new Column(Int32Array), target: new Column(Int32Array), type: new Column(Uint16Array),
    relevance: new Column(Uint8Array), file: new Column(Uint16Array), line: new Column(Int32Array),
  } : null;
  const text = collect ? {
    source: new Column(Int32Array), values: [], type: new Column(Uint16Array),
    relevance: new Column(Uint8Array), file: new Column(Uint16Array), line: new Column(Int32Array),
  } : null;
  const shards = [];
  let rowCount = 0;

  if (files.length > 0xffff) throw new Error(`approved Relations hold more than ${0xffff} files`);
  for (let fileNumber = 0; fileNumber < files.length; fileNumber += 1) {
    const { shard, rows } = await readApprovedRelationFile(files[fileNumber]);
    shards.push(shard);
    rowCount += rows.length;
    for (const { row, line } of rows) {
      if ('text' in row) {
        // Text keys exist only for normalizable text; any other text row fails validation in pass 2.
        if (isText(row.text)) {
          const key = relationTextKey(row.source_sense_id, row.text);
          if (textKeys.has(key)) repeatedTextKeys.add(key);
          else textKeys.add(key);
        }
        if (text) {
          text.source.push(intern(row.source_sense_id));
          text.values.push(row.text);
          text.type.push(typeCode(row.type));
          text.relevance.push(row.relevance);
          text.file.push(fileNumber);
          text.line.push(line);
        }
        continue;
      }
      const source = intern(row.source_sense_id);
      const target = intern(row.target_sense_id);
      pairs.push(pairNumber(source, target));
      if (id) {
        id.source.push(source);
        id.target.push(target);
        id.type.push(typeCode(row.type));
        id.relevance.push(row.relevance);
        id.file.push(fileNumber);
        id.line.push(line);
      }
    }
  }
  textKeys.clear();

  // Native numeric sort of a copy; equal neighbours are the only pairs any duplicate finding can involve.
  const sorted = pairs.done().slice().sort();
  const repeatedPairs = new Set();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index] === sorted[index - 1]) repeatedPairs.add(sorted[index]);
  }

  const done = (columns) => columns && Object.fromEntries(Object.entries(columns).map(([key, value]) => [key, Array.isArray(value) ? value : value.done()]));
  return {
    files,
    shards,
    rowCount,
    senseNumbers,
    senseIds,
    types,
    id: done(id),
    text: done(text),
    // Only rows whose key repeats can match or be matched by another row.
    mayRepeat(row) {
      if ('text' in row) return repeatedTextKeys.has(relationTextKey(row.source_sense_id, row.text));
      const source = senseNumbers.get(row.source_sense_id);
      const target = senseNumbers.get(row.target_sense_id);
      return source !== undefined && target !== undefined && repeatedPairs.has(pairNumber(source, target));
    },
  };
}

/**
 * Pass 2: validate every scanned file in shard order against one complete Canonical index with the shared validator.
 * One duplicate index is built for the whole corpus: each file's rows are remembered once, after that file is
 * validated, instead of re-indexing every earlier file for each shard (#9922). Findings are unchanged: the first
 * invalid file fails with its complete error list, and duplicates name every earlier or same-file match.
 */
export async function validateScannedApprovedRelations(scanned, { index, shardSenseIds }) {
  const duplicates = createRelationDuplicateIndex({ admit: scanned.mayRepeat });
  for (let fileNumber = 0; fileNumber < scanned.files.length; fileNumber += 1) {
    const { shard, rows } = await readApprovedRelationFile(scanned.files[fileNumber]);
    const owned = shardSenseIds?.get(shard);
    if (!owned) throw new Error(`relation-${shard}.jsonl: no Canonical shard stdict-0${shard}.jsonl owns this file`);
    duplicates.setScope(fileNumber);
    try {
      validateRelationRows({ relationRows: rows.map(({ row }) => row), index, shardSenseIds: owned, duplicateIndex: duplicates });
    } catch (error) {
      throw new Error(`relation-${shard}.jsonl: ${error.message}`);
    }
  }
  return { fileCount: scanned.files.length, rowCount: scanned.rowCount };
}

/**
 * Validate all approved files against one complete Canonical index and the full cross-shard input set. `files` are
 * loaded `{ shard, rows }` or listed `{ shard, path }` files; listed files are read one at a time.
 */
export async function validateApprovedRelationRows({ files, records = [], shardSenseIds, canonicalIndex }) {
  const index = canonicalIndex ?? buildCanonicalIndex(records);
  const scanned = await scanApprovedRelationFiles(files);
  const result = await validateScannedApprovedRelations(scanned, { index, shardSenseIds });
  return { ...result, index };
}

const emptyStats = (fileCount = 0) => ({
  authored_file_count: fileCount, authored_row_count: 0, authored_id_relation_count: 0, authored_text_relation_count: 0, authored_deduplicated_count: 0,
});

/** Stable counting sort of row numbers by relevance 1..9: most prominent tier first, then file order. */
function rowsByTier(relevance) {
  const starts = new Int32Array(11);
  for (let row = 0; row < relevance.length; row += 1) {
    const tier = relevance[row];
    if (!Number.isInteger(tier) || tier < 1 || tier > 9) throw new Error(`approved Relation relevance ${tier} is not 1..9`);
    starts[tier + 1] += 1;
  }
  for (let tier = 1; tier <= 10; tier += 1) starts[tier] += starts[tier - 1];
  const ordered = new Int32Array(relevance.length);
  for (let row = 0; row < relevance.length; row += 1) {
    ordered[starts[relevance[row]]] = row;
    starts[relevance[row]] += 1;
  }
  return ordered;
}

/**
 * @param {object | undefined} approved the validated `scanApprovedRelationFiles(..., { collect: true })` result
 * @param {{ id: string, sense_ids: string[] }[]} meanings record meanings
 * @param {object[]} existing meaning relations already projected (STDICT projection, gloss, direct reverse)
 *
 * Ordering is the historical one: most prominent tier first, then file order, forward before reverse. A pair/type
 * reached by several approved rows keeps its best tier once and records every contributing row in that order.
 * ID relations are returned as a streamed projection (`forEachRelation`, `forEachAuthoredSource`), text relations as rows.
 */
export function projectAuthoredRelations({ approved, meanings, existing }) {
  if (!approved || approved.files.length === 0) {
    return { relationCount: 0, textRelations: [], stats: emptyStats(), forEachRelation() {}, forEachAuthoredSource() {} };
  }
  const stats = emptyStats(approved.files.length);
  stats.authored_row_count = approved.rowCount;
  const { id, text, senseIds, types, shards } = approved;

  const meaningNumbers = new Map();
  meanings.forEach((meaning, number) => meaningNumbers.set(meaning.id, number));
  const meaningOfSense = new Int32Array(senseIds.length).fill(-1);
  meanings.forEach((meaning, number) => {
    for (const senseId of meaning.sense_ids) {
      const sense = approved.senseNumbers.get(senseId);
      if (sense !== undefined) meaningOfSense[sense] = number;
    }
  });

  // The first row in file order whose source or target Sense has no meaning fails the build.
  const missing = [];
  for (let row = 0; row < id.source.length; row += 1) {
    const sense = meaningOfSense[id.source[row]] < 0 ? id.source[row] : meaningOfSense[id.target[row]] < 0 ? id.target[row] : -1;
    if (sense >= 0) { missing.push({ file: id.file[row], line: id.line[row], sense }); break; }
  }
  for (let row = 0; row < text.source.length; row += 1) {
    if (meaningOfSense[text.source[row]] < 0) { missing.push({ file: text.file[row], line: text.line[row], sense: text.source[row] }); break; }
  }
  if (missing.length > 0) {
    const [first] = missing.sort((left, right) => left.file - right.file || left.line - right.line);
    throw new Error(`relation-${shards[first.file]}.jsonl:${first.line}: ${senseIds[first.sense]} has no meaning`);
  }

  // Existing pair/type keys and next free position per source meaning.
  const typeNumbers = new Map(types.map((type, code) => [type, code]));
  for (const relation of existing) if (!typeNumbers.has(relation.type)) typeNumbers.set(relation.type, typeNumbers.size);
  const typeSpan = typeNumbers.size;
  const existingKeys = new Map();
  const nextPosition = new Int32Array(meanings.length);
  for (const relation of existing) {
    const source = meaningNumbers.get(relation.source_meaning_id);
    if (source === undefined) continue;
    const target = meaningNumbers.get(relation.target_meaning_id);
    const keys = existingKeys.get(source) ?? new Set();
    if (target !== undefined) keys.add(target * typeSpan + typeNumbers.get(relation.type));
    existingKeys.set(source, keys);
    nextPosition[source] = Math.max(nextPosition[source], relation.position + 1);
  }

  // Directed entries: `2 * row` is the forward entry of an ID row, `2 * row + 1` its reverse. Group them by source
  // meaning while keeping tier order inside each group: positions and deduplication are per source meaning.
  const rowCount = id.source.length;
  const tierRows = rowsByTier(id.relevance);
  const entrySource = (entry) => meaningOfSense[(entry & 1) === 0 ? id.source[entry >> 1] : id.target[entry >> 1]];
  const entryTarget = (entry) => meaningOfSense[(entry & 1) === 0 ? id.target[entry >> 1] : id.source[entry >> 1]];
  const groupStarts = new Int32Array(meanings.length + 1);
  for (let row = 0; row < rowCount; row += 1) {
    groupStarts[meaningOfSense[id.source[row]] + 1] += 1;
    groupStarts[meaningOfSense[id.target[row]] + 1] += 1;
  }
  for (let meaning = 1; meaning <= meanings.length; meaning += 1) groupStarts[meaning] += groupStarts[meaning - 1];
  const cursor = groupStarts.slice(0, meanings.length);
  const grouped = new Int32Array(rowCount * 2);
  for (const row of tierRows) {
    // Forward before reverse within one row.
    const forward = meaningOfSense[id.source[row]];
    grouped[cursor[forward]] = row * 2;
    cursor[forward] += 1;
    const reverse = meaningOfSense[id.target[row]];
    grouped[cursor[reverse]] = row * 2 + 1;
    cursor[reverse] += 1;
  }

  const relationPosition = new Int32Array(rowCount * 2);
  const sourcePosition = new Int32Array(rowCount * 2);
  const local = new Map();
  let conflict = -1;
  let kept = 0;
  const before = (left, right) => {
    const leftRow = left >> 1;
    const rightRow = right >> 1;
    return id.relevance[leftRow] - id.relevance[rightRow] || leftRow - rightRow || (left & 1) - (right & 1);
  };
  for (let meaning = 0; meaning < meanings.length; meaning += 1) {
    const start = groupStarts[meaning];
    const end = groupStarts[meaning + 1];
    if (start === end) continue;
    local.clear();
    const existingForSource = existingKeys.get(meaning);
    let position = nextPosition[meaning];
    for (let index = start; index < end; index += 1) {
      const entry = grouped[index];
      const key = entryTarget(entry) * typeSpan + id.type[entry >> 1];
      if (existingForSource?.has(key)) {
        if (conflict < 0 || before(entry, conflict) < 0) conflict = entry;
        continue;
      }
      const prior = local.get(key);
      if (prior === undefined) {
        local.set(key, { entry, sources: 1 });
        relationPosition[entry] = position;
        sourcePosition[entry] = 0;
        position += 1;
        kept += 1;
        continue;
      }
      // The lower-tier row still contributed: the kept row records every approved row that reached it.
      stats.authored_deduplicated_count += 1;
      relationPosition[entry] = relationPosition[prior.entry];
      sourcePosition[entry] = prior.sources;
      prior.sources += 1;
    }
  }
  local.clear();
  if (conflict >= 0) {
    const row = conflict >> 1;
    throw new Error(`authored ${types[id.type[row]]} ${senseIds[id.source[row]]} -> ${senseIds[id.target[row]]} duplicates an existing relation of the same pair and type`);
  }

  const textTaken = new Set();
  const textPosition = new Int32Array(meanings.length);
  const textRelations = [];
  for (const row of rowsByTier(text.relevance)) {
    const source = meanings[meaningOfSense[text.source[row]]].id;
    const type = types[text.type[row]];
    const key = `${source}\u0000${text.values[row]}\u0000${type}`;
    if (textTaken.has(key)) { stats.authored_deduplicated_count += 1; continue; }
    textTaken.add(key);
    const sourceNumber = meaningOfSense[text.source[row]];
    textRelations.push({ source_meaning_id: source, position: textPosition[sourceNumber], text: text.values[row], type, relevance: text.relevance[row] });
    textPosition[sourceNumber] += 1;
  }
  textTaken.clear();

  stats.authored_id_relation_count = kept;
  stats.authored_text_relation_count = textRelations.length;
  return {
    relationCount: kept,
    textRelations,
    stats,
    /** `callback(source_meaning_id, position, target_meaning_id, type, relevance, origin)` once per kept ID relation. */
    forEachRelation(callback) {
      for (const entry of grouped) {
        if (sourcePosition[entry] !== 0) continue;
        const row = entry >> 1;
        callback(
          meanings[entrySource(entry)].id, relationPosition[entry], meanings[entryTarget(entry)].id, types[id.type[row]], id.relevance[row],
          (entry & 1) === 0 ? MEANING_RELATION_ORIGINS.authored : MEANING_RELATION_ORIGINS.authoredReverse,
        );
      }
    },
    /** `callback(source_meaning_id, relation_position, position, direction, source_sense_id, target_sense_id, shard, line)` per contributing row and direction. */
    forEachAuthoredSource(callback) {
      for (const entry of grouped) {
        const row = entry >> 1;
        callback(
          meanings[entrySource(entry)].id, relationPosition[entry], sourcePosition[entry], (entry & 1) === 0 ? 'forward' : 'reverse',
          senseIds[id.source[row]], senseIds[id.target[row]], shards[id.file[row]], id.line[row],
        );
      }
    },
  };
}
