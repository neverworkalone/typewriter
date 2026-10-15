import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Meaning editorial layer (Issue #713). `data/canonical/` stays the untouched STDICT source layer; `data/meanings/`
 * holds Typewriter's final meanings (each referencing one or more canonical senses of ONE entry) and
 * `data/adjudication/` records editorial verdicts such as DROP. This module is the shared contract: ID rules,
 * initial -> `cXX` mapping, shard placement, schema validation, and a deterministic writer/loader.
 */

// Explicit mapping table: Hangul initial consonant (choseong) -> shard group code. `c20` collects lemmas that do not
// start with a Hangul syllable or a bare initial jamo such as `ㄱ`. Order follows the Unicode choseong index so the table is auditable.
export const INITIAL_CODES = Object.freeze({
  'ㄱ': 'c01', 'ㄲ': 'c02', 'ㄴ': 'c03', 'ㄷ': 'c04', 'ㄸ': 'c05', 'ㄹ': 'c06', 'ㅁ': 'c07', 'ㅂ': 'c08', 'ㅃ': 'c09',
  'ㅅ': 'c10', 'ㅆ': 'c11', 'ㅇ': 'c12', 'ㅈ': 'c13', 'ㅉ': 'c14', 'ㅊ': 'c15', 'ㅋ': 'c16', 'ㅌ': 'c17', 'ㅍ': 'c18',
  'ㅎ': 'c19',
});
export const OTHER_INITIAL_CODE = 'c20';
export const INITIAL_CODE_VALUES = Object.freeze([...Object.values(INITIAL_CODES), OTHER_INITIAL_CODE]);
const CHOSEONG = Object.freeze([...'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ']);
const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const SYLLABLES_PER_INITIAL = 21 * 28;

export const TARGET_SHARD_MEANINGS = 1000;
export const ADJUDICATION_REASONS = Object.freeze(['duplicate']);

const ENTRY_ID = /^w(\d+)$/u;
const SENSE_ID = /^(w\d+)-s([1-9]\d*)$/u;
const MEANING_ID = /^m(\d+)(?:_([1-9]\d*))?$/u;
const SHARD_FILE = /^(c\d{2})_(\d{3})\.jsonl$/u;

export const initialCodeOf = (lemma) => {
  const first = String(lemma ?? '').codePointAt(0);
  if (first === undefined) return OTHER_INITIAL_CODE;
  // A bare supported initial jamo (compatibility jamo, e.g. the entry `ㄱ`) maps through the table directly.
  const jamo = String.fromCodePoint(first);
  if (Object.hasOwn(INITIAL_CODES, jamo)) return INITIAL_CODES[jamo];
  if (first < HANGUL_FIRST || first > HANGUL_LAST) return OTHER_INITIAL_CODE;
  return INITIAL_CODES[CHOSEONG[Math.floor((first - HANGUL_FIRST) / SYLLABLES_PER_INITIAL)]];
};

export const entryIdOfSense = (senseId) => SENSE_ID.exec(senseId)?.[1] ?? null;

/** `w0097` -> `m0097` (single meaning) or `m0097_<n>` (several). */
export function meaningId(entryId, ordinal = null) {
  const match = ENTRY_ID.exec(entryId);
  if (!match) throw new TypeError(`not a canonical entry id: ${entryId}`);
  if (ordinal !== null && !(Number.isInteger(ordinal) && ordinal >= 1)) throw new TypeError(`invalid meaning ordinal: ${ordinal}`);
  return ordinal === null ? `m${match[1]}` : `m${match[1]}_${ordinal}`;
}

export function parseMeaningId(id) {
  const match = MEANING_ID.exec(id);
  if (!match) return null;
  return { entryId: `w${match[1]}`, ordinal: match[2] === undefined ? null : Number(match[2]) };
}

export const shardFileName = (code, index) => `${code}_${String(index).padStart(3, '0')}.jsonl`;
export const parseShardFileName = (file) => {
  const match = SHARD_FILE.exec(file);
  return match ? { code: match[1], index: Number(match[2]) } : null;
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value.trim() !== '' && value === value.trim();
function checkKeys(row, allowed, errors, where) {
  for (const key of Object.keys(row)) if (!allowed.includes(key)) errors.push(`${where}: unknown field ${key}`);
}

/** Row-level schema check. Returns a list of error strings. */
export function validateMeaningRow(row, where = 'meaning') {
  const errors = [];
  if (!isObject(row)) return [`${where}: not an object`];
  checkKeys(row, ['id', 'lemma', 'gloss', 'sense_ids'], errors, where);
  const id = parseMeaningId(row.id);
  if (!id) errors.push(`${where}: invalid id ${JSON.stringify(row.id)}`);
  if (!nonEmpty(row.lemma)) errors.push(`${where}: lemma must be a trimmed non-empty string`);
  if (!nonEmpty(row.gloss)) errors.push(`${where}: gloss must be a trimmed non-empty string`);
  if (!Array.isArray(row.sense_ids) || row.sense_ids.length === 0) {
    errors.push(`${where}: sense_ids must be a non-empty array`);
  } else {
    const seen = new Set();
    for (const senseId of row.sense_ids) {
      const entryId = typeof senseId === 'string' ? entryIdOfSense(senseId) : null;
      if (!entryId) errors.push(`${where}: invalid sense id ${JSON.stringify(senseId)}`);
      else if (id && entryId !== id.entryId) errors.push(`${where}: sense ${senseId} does not belong to entry ${id.entryId}`);
      if (seen.has(senseId)) errors.push(`${where}: duplicate sense id ${senseId}`);
      seen.add(senseId);
    }
  }
  return errors;
}

export function validateAdjudicationRow(row, where = 'adjudication') {
  const errors = [];
  if (!isObject(row)) return [`${where}: not an object`];
  checkKeys(row, ['sense_id', 'lemma', 'decision', 'reason', 'duplicate_of'], errors, where);
  if (!entryIdOfSense(row.sense_id ?? '')) errors.push(`${where}: invalid sense_id ${JSON.stringify(row.sense_id)}`);
  if (!nonEmpty(row.lemma)) errors.push(`${where}: lemma must be a trimmed non-empty string`);
  if (row.decision !== 'drop') errors.push(`${where}: decision must be "drop"`);
  if (!ADJUDICATION_REASONS.includes(row.reason)) errors.push(`${where}: reason must be one of ${ADJUDICATION_REASONS.join(', ')}`);
  if (row.reason === 'duplicate') {
    if (!entryIdOfSense(row.duplicate_of ?? '')) errors.push(`${where}: duplicate_of must be a canonical sense id`);
    else if (row.duplicate_of === row.sense_id) errors.push(`${where}: duplicate_of must differ from sense_id`);
  }
  return errors;
}

const rowKey = (kind, row) => (kind === 'meaning' ? row.id : row.sense_id);
// Typed numeric id tuple: meaning `m<entry>[_<n>]` -> (entry, n); adjudication `w<entry>-s<n>` -> (entry, n).
const idTuple = (kind, row) => {
  if (kind === 'meaning') {
    const parsed = parseMeaningId(row.id);
    return [Number(parsed.entryId.slice(1)), parsed.ordinal ?? 0];
  }
  const match = SENSE_ID.exec(row.sense_id);
  return [Number(match[1].slice(1)), Number(match[2])];
};
const compareRows = (kind) => (a, b) => {
  if (a.lemma !== b.lemma) return a.lemma < b.lemma ? -1 : 1;
  const [ea, na] = idTuple(kind, a);
  const [eb, nb] = idTuple(kind, b);
  return ea - eb || na - nb;
};

/**
 * Deterministic placement: group rows by initial code, order by lemma then id, and fill shards of about
 * `target` rows, closing a shard only on a lemma boundary (a lemma is never split across shards).
 * Returns `Map<fileName, row[]>`.
 */
export function planShards(rows, kind, { target = TARGET_SHARD_MEANINGS } = {}) {
  const byCode = new Map();
  for (const row of rows) {
    const code = initialCodeOf(row.lemma);
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push(row);
  }
  const plan = new Map();
  for (const code of [...byCode.keys()].sort()) {
    const sorted = byCode.get(code).sort(compareRows(kind));
    let index = 1;
    let current = [];
    for (let i = 0; i < sorted.length; i += 1) {
      current.push(sorted[i]);
      const boundary = i + 1 === sorted.length || sorted[i + 1].lemma !== sorted[i].lemma;
      if (boundary && current.length >= target) {
        plan.set(shardFileName(code, index++), current);
        current = [];
      }
    }
    if (current.length) plan.set(shardFileName(code, index), current);
  }
  return plan;
}

const serialize = (rows) => rows.map((row) => `${JSON.stringify(row)}\n`).join('');

/** Write rows into `directory` per the placement contract; stale shard files are removed. Never touches other paths. */
export function writeShards(directory, rows, kind, options = {}) {
  const plan = planShards(rows, kind, options);
  mkdirSync(directory, { recursive: true });
  for (const [file, shardRows] of plan) {
    const target = path.join(directory, file);
    const text = serialize(shardRows);
    if (!existsSync(target) || readFileSync(target, 'utf8') !== text) {
      writeFileSync(`${target}.tmp`, text);
      renameSync(`${target}.tmp`, target);
    }
  }
  for (const file of readdirSync(directory)) if (parseShardFileName(file) && !plan.has(file)) rmSync(path.join(directory, file));
  return [...plan.keys()];
}

/** Read shard files in name order. Returns `{ rows, errors }`; JSON/placement problems are reported, not thrown. */
export function readShards(directory, kind) {
  const rows = [];
  const errors = [];
  if (!existsSync(directory)) return { rows, errors };
  const files = readdirSync(directory).filter((name) => !name.startsWith('.')).sort();
  const lastIndex = new Map();
  const lemmaShard = new Map();
  const previous = new Map();
  const order = compareRows(kind);
  for (const file of files) {
    const parsed = parseShardFileName(file);
    if (!parsed) { errors.push(`${file}: not a cXX_NNN.jsonl shard file`); continue; }
    if (!INITIAL_CODE_VALUES.includes(parsed.code)) errors.push(`${file}: unknown initial code ${parsed.code}`);
    if (parsed.index !== (lastIndex.get(parsed.code) ?? 0) + 1) errors.push(`${file}: shard numbers must start at 001 and be contiguous`);
    lastIndex.set(parsed.code, parsed.index);
    const lines = readFileSync(path.join(directory, file), 'utf8').split('\n');
    if (lines.at(-1) !== '') errors.push(`${file}: must end with a newline`);
    lines.pop();
    if (lines.length === 0) errors.push(`${file}: empty shard`);
    lines.forEach((line, i) => {
      const where = `${file}:${i + 1}`;
      let row;
      try { row = JSON.parse(line); } catch { errors.push(`${where}: invalid JSON`); return; }
      const rowErrors = kind === 'meaning' ? validateMeaningRow(row, where) : validateAdjudicationRow(row, where);
      errors.push(...rowErrors);
      if (rowErrors.length) return;
      if (initialCodeOf(row.lemma) !== parsed.code) errors.push(`${where}: lemma ${row.lemma} belongs to ${initialCodeOf(row.lemma)}, not ${parsed.code}`);
      const home = lemmaShard.get(`${row.lemma}`);
      if (home !== undefined && home !== file) errors.push(`${where}: lemma ${row.lemma} is split across ${home} and ${file}`);
      lemmaShard.set(row.lemma, file);
      const before = previous.get(parsed.code);
      if (before && order(before, row) > 0) errors.push(`${where}: rows must be ordered by lemma then id within ${parsed.code} (after ${rowKey(kind, before)})`);
      previous.set(parsed.code, row);
      rows.push(row);
    });
  }
  return { rows, errors };
}

export const readMeanings = (directory) => readShards(directory, 'meaning');
export const readAdjudications = (directory) => readShards(directory, 'adjudication');
export const writeMeanings = (directory, rows, options) => writeShards(directory, rows, 'meaning', options);
export const writeAdjudications = (directory, rows, options) => writeShards(directory, rows, 'adjudication', options);

/**
 * Dataset-level validation. `senses` (optional) is `Map<senseId, { lemma }>` from the untouched canonical layer;
 * when given, every reference must resolve and lemmas must agree.
 */
export function validateMeaningDataset({ meanings, adjudications = [], senses = null }) {
  const errors = [];
  const ids = new Set();
  const byEntry = new Map();
  const claimed = new Map();
  for (const meaning of meanings) {
    if (ids.has(meaning.id)) errors.push(`${meaning.id}: duplicate meaning id`);
    ids.add(meaning.id);
    const parsed = parseMeaningId(meaning.id);
    if (parsed) {
      if (!byEntry.has(parsed.entryId)) byEntry.set(parsed.entryId, []);
      byEntry.get(parsed.entryId).push(parsed);
    }
    for (const senseId of meaning.sense_ids) {
      if (claimed.has(senseId)) errors.push(`${senseId}: referenced by both ${claimed.get(senseId)} and ${meaning.id}`);
      claimed.set(senseId, meaning.id);
    }
  }
  for (const [entryId, list] of byEntry) {
    const plain = list.filter((item) => item.ordinal === null).length;
    if (plain > 0 && list.length > 1) errors.push(`${entryId}: a lone meaning uses ${meaningId(entryId)}; several use ${meaningId(entryId, 1)}, ${meaningId(entryId, 2)}, ...`);
  }
  const dropped = new Set();
  for (const item of adjudications) {
    if (dropped.has(item.sense_id)) errors.push(`${item.sense_id}: adjudicated more than once`);
    dropped.add(item.sense_id);
    if (claimed.has(item.sense_id)) errors.push(`${item.sense_id}: dropped but still referenced by ${claimed.get(item.sense_id)}`);
  }
  for (const item of adjudications) {
    if (item.duplicate_of && dropped.has(item.duplicate_of)) errors.push(`${item.sense_id}: duplicate_of ${item.duplicate_of} is itself dropped`);
  }
  if (senses) {
    for (const meaning of meanings) {
      for (const senseId of meaning.sense_ids) {
        const sense = senses.get(senseId);
        if (!sense) errors.push(`${meaning.id}: unknown canonical sense ${senseId}`);
        else if (sense.lemma !== meaning.lemma) errors.push(`${meaning.id}: lemma ${meaning.lemma} differs from canonical ${sense.lemma}`);
      }
    }
    for (const item of adjudications) {
      const sense = senses.get(item.sense_id);
      if (!sense) errors.push(`${item.sense_id}: adjudicated unknown canonical sense`);
      else if (sense.lemma !== item.lemma) errors.push(`${item.sense_id}: lemma ${item.lemma} differs from canonical ${sense.lemma}`);
      if (item.duplicate_of && !senses.has(item.duplicate_of)) errors.push(`${item.sense_id}: unknown duplicate_of ${item.duplicate_of}`);
    }
  }
  return [...new Set(errors)];
}

/** Senses of the already-loaded shared canonical context (CI Normal session) as `Map<senseId, { lemma }>`; no file reads. */
export function canonicalSensesFromContext(canonicalContext) {
  const senses = new Map();
  for (const [senseId, { recordInfo }] of canonicalContext.indexes.sensesById) {
    senses.set(senseId, { lemma: (recordInfo.record ?? recordInfo).lemma });
  }
  return senses;
}

/** Read the untouched canonical layer from disk into `Map<senseId, { lemma }>` (`files` limits it to named files). */
export function loadCanonicalSenses(directory, { files = null } = {}) {
  const senses = new Map();
  const names = files ?? readdirSync(directory).filter((name) => name.endsWith('.jsonl')).sort();
  for (const file of names) {
    for (const line of readFileSync(path.join(directory, file), 'utf8').split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      for (const sense of entry.senses ?? []) senses.set(sense.id, { lemma: entry.lemma });
    }
  }
  return senses;
}

/**
 * Load and validate `data/meanings` + `data/adjudication`; returns `{ meanings, adjudications, errors }`.
 * References are checked against `senses` (e.g. from the shared CI canonical context) or, failing that,
 * `canonicalDirectory`; with neither only the files themselves are checked.
 */
export function loadMeaningData({ meaningsDirectory, adjudicationDirectory, canonicalDirectory = null, senses = null }) {
  const meanings = readMeanings(meaningsDirectory);
  const adjudications = readAdjudications(adjudicationDirectory);
  const errors = [...meanings.errors, ...adjudications.errors];
  const needsReferences = meanings.rows.length + adjudications.rows.length > 0;
  errors.push(...validateMeaningDataset({
    meanings: meanings.rows,
    adjudications: adjudications.rows,
    senses: senses ?? (canonicalDirectory && needsReferences ? loadCanonicalSenses(canonicalDirectory) : null),
  }));
  return { meanings: meanings.rows, adjudications: adjudications.rows, errors };
}
