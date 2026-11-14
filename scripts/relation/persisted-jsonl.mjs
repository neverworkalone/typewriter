import { normalizeCandidate } from './candidate-contract.mjs';

const RELATION_ID_KEYS = 'id,rv,sid,tid,tp,tsid';
const ASSIGNED_RELATION_ID_KEYS = 'fm,id,rfm,rv,sid,tid,tp,tsid,ver';
const RELATION_TEXT_KEYS = 'id,rv,sid,tp,tt';
const DROP_KEYS = 'by,cd,id,sid';

const LEGACY_RELATION_KEYS = new Set([
  'source_record_id', 'source_sense_id', 'target_record_id', 'target_sense_id', 'type', 'relevance',
  'reverse_type', 'reverse_relevance', 'candidate_assignment_version', 'candidate_forms', 'reverse_candidate_forms',
  'text',
]);
const LEGACY_DROP_KEYS = new Set(['source_record_id', 'source_sense_id', 'candidate', 'reason']);
const keysOf = (value) => Object.keys(value).sort().join(',');
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function assertCompactFields(row, expected, family, location) {
  if (!isPlainObject(row)) throw new Error(`${location} must be an object`);
  const actual = keysOf(row);
  if (actual === expected) return;
  const legacyKeys = family === 'Relation' ? LEGACY_RELATION_KEYS : LEGACY_DROP_KEYS;
  const legacy = Object.keys(row).filter((key) => legacyKeys.has(key));
  if (legacy.length > 0) {
    throw new Error(`${location} uses obsolete ${family} JSONL field(s) ${legacy.sort().join(', ')}; use the compact persisted schema`);
  }
  throw new Error(`${location} must have exactly ${expected}`);
}

/** Decode one compact persisted Relation into the descriptive in-memory contract. */
export function deserializeRelationRow(row, location = 'Relation JSONL row') {
  if (!isPlainObject(row)) throw new Error(`${location} must be an object`);
  const keys = keysOf(row);
  if (keys === RELATION_TEXT_KEYS) {
    return {
      source_record_id: row.id,
      source_sense_id: row.sid,
      text: row.tt,
      type: row.tp,
      relevance: row.rv,
    };
  }
  if (keys === RELATION_ID_KEYS || keys === ASSIGNED_RELATION_ID_KEYS) {
    const relation = {
      source_record_id: row.id,
      source_sense_id: row.sid,
      target_record_id: row.tid,
      target_sense_id: row.tsid,
      type: row.tp,
      relevance: row.rv,
      // Reverse product behavior is derived from the one persisted source judgment.
      reverse_type: row.tp,
      reverse_relevance: row.rv,
    };
    if (keys === ASSIGNED_RELATION_ID_KEYS) {
      relation.candidate_assignment_version = row.ver;
      relation.candidate_forms = row.fm;
      relation.reverse_candidate_forms = row.rfm;
    }
    return relation;
  }
  const hasAssignmentMarker = ['ver', 'fm', 'rfm'].some((key) => Object.hasOwn(row, key));
  assertCompactFields(row, hasAssignmentMarker ? ASSIGNED_RELATION_ID_KEYS : RELATION_ID_KEYS, 'Relation', location);
}

/** Encode one descriptive in-memory Relation with only the compact persisted fields. */
export function serializeRelationRow(row, location = 'Relation in-memory row') {
  if (!isPlainObject(row)) throw new Error(`${location} must be an object`);
  if (Object.hasOwn(row, 'text')) {
    const expected = 'relevance,source_record_id,source_sense_id,text,type';
    if (keysOf(row) !== expected) throw new Error(`${location} must have exactly ${expected}`);
    return { id: row.source_record_id, sid: row.source_sense_id, tt: row.text, tp: row.type, rv: row.relevance };
  }

  const hasAssignment = Object.hasOwn(row, 'candidate_assignment_version');
  const expected = hasAssignment
    ? 'candidate_assignment_version,candidate_forms,relevance,reverse_candidate_forms,reverse_relevance,reverse_type,source_record_id,source_sense_id,target_record_id,target_sense_id,type'
    : 'relevance,reverse_relevance,reverse_type,source_record_id,source_sense_id,target_record_id,target_sense_id,type';
  if (keysOf(row) !== expected) throw new Error(`${location} must have exactly ${expected}`);
  if (row.reverse_type !== row.type || row.reverse_relevance !== row.relevance) {
    throw new Error(`${location} has legacy reverse judgments; restart or finish this Stage 2 Part at the compact schema boundary`);
  }

  const compact = {
    id: row.source_record_id,
    sid: row.source_sense_id,
    tid: row.target_record_id,
    tsid: row.target_sense_id,
    tp: row.type,
    rv: row.relevance,
  };
  if (hasAssignment) {
    compact.ver = row.candidate_assignment_version;
    compact.fm = row.candidate_forms;
    compact.rfm = row.reverse_candidate_forms;
  }
  return compact;
}

/** Decode one compact persisted Drop into the descriptive in-memory contract. */
export function deserializeDropRow(row, location = 'Drop JSONL row') {
  assertCompactFields(row, DROP_KEYS, 'Drop', location);
  return { source_record_id: row.id, source_sense_id: row.sid, candidate: row.cd, reason: row.by };
}

/** Encode one descriptive in-memory Drop with only the compact persisted fields. */
export function serializeDropRow(row, location = 'Drop in-memory row') {
  const expected = 'candidate,reason,source_record_id,source_sense_id';
  if (!isPlainObject(row) || keysOf(row) !== expected) throw new Error(`${location} must have exactly ${expected}`);
  return { id: row.source_record_id, sid: row.source_sense_id, cd: row.candidate, by: row.reason };
}

function parseJsonl(contents, file, decode) {
  if (typeof contents !== 'string') throw new Error(`${file} contents must be text`);
  return contents.split(/\r?\n/u).flatMap((line, index) => {
    if (!line.trim()) return [];
    const location = `${file}:${index + 1}`;
    let row;
    try { row = JSON.parse(line); } catch (error) { throw new Error(`${location} is not valid JSON: ${error.message}`); }
    return [decode(row, location)];
  });
}

export const parseRelationJsonl = (contents, file = 'Relation JSONL') => parseJsonl(contents, file, deserializeRelationRow);
export const parseDropJsonl = (contents, file = 'Drop JSONL') => parseJsonl(contents, file, deserializeDropRow);

// Decode only the lines `select(line)` keeps, with the same locations and errors as the full parse. `position` is the
// row's index in the full parse result (blank lines skipped), so a caller can later splice a changed row back.
function parseSelectedJsonl(contents, file, decode, select) {
  if (typeof contents !== 'string') throw new Error(`${file} contents must be text`);
  const selected = [];
  let position = 0;
  contents.split(/\r?\n/u).forEach((line, index) => {
    if (!line.trim()) return;
    if (select(line)) {
      const location = `${file}:${index + 1}`;
      let row;
      try { row = JSON.parse(line); } catch (error) { throw new Error(`${location} is not valid JSON: ${error.message}`); }
      selected.push({ row: decode(row, location), position });
    }
    position += 1;
  });
  return selected;
}

export const parseSelectedRelationJsonl = (contents, file, select) => parseSelectedJsonl(contents, file, deserializeRelationRow, select);
export const parseSelectedDropJsonl = (contents, file, select) => parseSelectedJsonl(contents, file, deserializeDropRow, select);

function serializeJsonl(rows, encode, family) {
  if (!Array.isArray(rows)) throw new Error(`${family} rows must be an array`);
  return rows.length ? `${rows.map((row, index) => JSON.stringify(encode(row, `${family} row ${index + 1}`))).join('\n')}\n` : '';
}

export const serializeRelationJsonl = (rows) => serializeJsonl(rows, serializeRelationRow, 'Relation');
export const serializeDropJsonl = (rows) => serializeJsonl(rows, serializeDropRow, 'Drop');

// Descriptive in-memory row contract shared by the official Stage 2/3 verifier (`admission.mjs::validateRelationRows`)
// and the lightweight data PR check. Only rules decidable from the row itself live here; Canonical Sense binding,
// target resolution and cross-shard checks stay with their index-backed callers.
export const ADMISSION_TYPES = Object.freeze(['near', 'mood', 'scene', 'sensory', 'action', 'association']);
export const DROP_REASONS = Object.freeze(['x', 'e', 'z', 'f']);
export const LEGACY_ID_ROW_KEYS = 'relevance,reverse_relevance,reverse_type,source_record_id,source_sense_id,target_record_id,target_sense_id,type';
export const ASSIGNED_ID_ROW_KEYS = 'candidate_assignment_version,candidate_forms,relevance,reverse_candidate_forms,reverse_relevance,reverse_type,source_record_id,source_sense_id,target_record_id,target_sense_id,type';
export const TEXT_ROW_KEYS = 'relevance,source_record_id,source_sense_id,text,type';
export const DROP_ROW_KEYS = 'candidate,reason,source_record_id,source_sense_id';
export const isTier = (value) => Number.isInteger(value) && value >= 1 && value <= 9;
export const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isIdString = (value) => typeof value === 'string' && value.length > 0;

/** Object/key-set failure of one descriptive Relation row, or undefined. */
export function relationRowShapeError(row, at) {
  if (!isPlainObject(row)) return `${at}: must be an object`;
  const isTextRow = 'text' in row;
  const assignedId = !isTextRow && Object.hasOwn(row, 'candidate_assignment_version');
  const expected = isTextRow ? TEXT_ROW_KEYS : assignedId ? ASSIGNED_ID_ROW_KEYS : LEGACY_ID_ROW_KEYS;
  if (keysOf(row) === expected) return undefined;
  return `${at}: must have exactly ${expected}${!isTextRow && !assignedId ? ` or ${ASSIGNED_ID_ROW_KEYS}` : ''}`;
}

/**
 * Row-local field value failures of a shape-valid descriptive Relation row. `resolvesForm(form, recordId)` is the
 * caller's optional index-backed candidate-form check; it is consulted in the same per-form order as before.
 */
export function relationRowFieldErrors(row, at, { resolvesForm } = {}) {
  const errors = [];
  const isTextRow = 'text' in row;
  const idFields = isTextRow
    ? ['source_record_id', 'source_sense_id']
    : ['source_record_id', 'source_sense_id', 'target_record_id', 'target_sense_id'];
  for (const field of idFields) if (!isIdString(row[field])) errors.push(`${at}: ${field} must be a non-empty string`);
  if (!ADMISSION_TYPES.includes(row.type)) errors.push(`${at}: type ${JSON.stringify(row.type)} is not one of ${ADMISSION_TYPES.join('/')}`);
  if (!isTier(row.relevance)) errors.push(`${at}: relevance must be an integer 1..9`);
  if (isTextRow) {
    if (!isText(row.text) || row.text !== normalizeCandidate(row.text)) errors.push(`${at}: text must be a non-empty normalized string`);
    return errors;
  }
  if (!ADMISSION_TYPES.includes(row.reverse_type)) errors.push(`${at}: reverse_type ${JSON.stringify(row.reverse_type)} is not one of ${ADMISSION_TYPES.join('/')}`);
  if (!isTier(row.reverse_relevance)) errors.push(`${at}: reverse_relevance must be an integer 1..9`);
  if (row.reverse_type !== row.type || row.reverse_relevance !== row.relevance) {
    errors.push(`${at}: reverse_type and reverse_relevance must match type and relevance`);
  }
  if (Object.hasOwn(row, 'candidate_assignment_version')) {
    if (![0, 1].includes(row.candidate_assignment_version)) errors.push(`${at}: candidate_assignment_version must be 0 (legacy inferred) or 1 (selected)`);
    const checkForms = (forms, recordId, field, { allowEmpty = true } = {}) => {
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
        if (resolvesForm && !resolvesForm(form, recordId)) {
          errors.push(`${at}: ${field} candidate ${JSON.stringify(form)} does not resolve to ${recordId}`);
        }
      }
    };
    checkForms(row.candidate_forms, row.target_record_id, 'candidate_forms', { allowEmpty: false });
    checkForms(row.reverse_candidate_forms, row.source_record_id, 'reverse_candidate_forms');
  }
  return errors;
}

/** Object/key-set failure of one descriptive Drop row, or undefined. */
export function dropRowShapeError(row, at) {
  return isPlainObject(row) && keysOf(row) === DROP_ROW_KEYS ? undefined : `${at}: must have exactly ${DROP_ROW_KEYS}`;
}

/** Row-local field value failures of a shape-valid descriptive Drop row. */
export function dropRowFieldErrors(row, at) {
  const errors = [];
  for (const field of ['source_record_id', 'source_sense_id']) if (!isIdString(row[field])) errors.push(`${at}: ${field} must be a non-empty string`);
  if (!isText(row.candidate) || row.candidate !== normalizeCandidate(row.candidate)) errors.push(`${at}: candidate must be a non-empty normalized string`);
  if (!DROP_REASONS.includes(row.reason)) errors.push(`${at}: reason must be one of ${DROP_REASONS.join('/')}`);
  return errors;
}

/** Duplicate keys shared by the official verifier and the data PR check: ID pairs (both directions), text and Drop. */
export const relationPairKey = (sourceSense, targetRecord, targetSense) => `${sourceSense}\u0000${targetRecord}\u0000${targetSense}`;
export const relationTextKey = (sourceSense, text) => `${sourceSense}\u0000${normalizeCandidate(text)}`;
