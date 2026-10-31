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
  assertCompactFields(row, RELATION_ID_KEYS, 'Relation', location);
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

function serializeJsonl(rows, encode, family) {
  if (!Array.isArray(rows)) throw new Error(`${family} rows must be an array`);
  return rows.length ? `${rows.map((row, index) => JSON.stringify(encode(row, `${family} row ${index + 1}`))).join('\n')}\n` : '';
}

export const serializeRelationJsonl = (rows) => serializeJsonl(rows, serializeRelationRow, 'Relation');
export const serializeDropJsonl = (rows) => serializeJsonl(rows, serializeDropRow, 'Drop');
