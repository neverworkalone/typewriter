import { EXPLORATORY_RELATION_TYPES, PRECISION_RELATION_TYPES, reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';

// Reverse relation amendment (#399): an admitted Stage 2 decision may also add one reviewed relation
// to an already-existing canonical source sense, e.g. new 서늘하다 -> existing 쓸쓸하다 is the normal
// new-sense path, while existing 쓸쓸하다 -> new 서늘하다 is a relation-only amendment on 쓸쓸하다.
// Row field: `relation_amendments: [{ source_record_id, source_sense_id, source_gloss_sha256, relation, rationale }]`.
// `relation` is the exact authored tuple; its `target` may be an existing canonical id or a same-batch
// candidate id / provisional_ref, which Stage 3 remaps like any other reviewed relation.

const SHA256 = /^[0-9a-f]{64}$/u;
const KEYS = ['source_record_id', 'source_sense_id', 'source_gloss_sha256', 'relation', 'rationale'];
const RELATION_KEYS = ['target', 'target_sense', 'type', 'note', 'relevance'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// Every external JSON field is type-checked before any string operation, so a hostile value can only ever
// produce a contract error, never an exception from implicit coercion.
const isText = (value) => typeof value === 'string' && value.trim().length > 0;
const isSha256 = (value) => typeof value === 'string' && SHA256.test(value);

export const AMENDMENT_FIELD = 'relation_amendments';

export function relationAmendmentErrors(row, at) {
  const list = row?.[AMENDMENT_FIELD];
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length === 0) return [`${at}: ${AMENDMENT_FIELD} must be a non-empty array when present`];
  const errors = [];
  const seen = new Set();
  list.forEach((item, index) => {
    const here = `${at}: ${AMENDMENT_FIELD}[${index}]`;
    if (!isObject(item) || Object.keys(item).some((key) => !KEYS.includes(key)) || KEYS.some((key) => item[key] === undefined)) {
      errors.push(`${here} needs exactly ${KEYS.join(', ')}`);
      return;
    }
    const recordOk = typeof item.source_record_id === 'string' && /^[wr]\d+$/u.test(item.source_record_id);
    const senseOk = recordOk && typeof item.source_sense_id === 'string' && item.source_sense_id.startsWith(`${item.source_record_id}-s`);
    if (!recordOk) errors.push(`${here}.source_record_id must be an existing canonical record id`);
    if (!senseOk) errors.push(`${here}.source_sense_id must be a sense of source_record_id`);
    if (!isSha256(item.source_gloss_sha256)) errors.push(`${here}.source_gloss_sha256 must be a sha256 of the source sense gloss`);
    if (!(senseOk && isText(item.rationale) && item.rationale.includes(item.source_record_id) && item.rationale.includes(item.source_sense_id))) {
      errors.push(`${here}.rationale must be source-bound: cite the source record and sense ids`);
    }
    const relation = item.relation;
    if (!isObject(relation) || Object.keys(relation).some((key) => !RELATION_KEYS.includes(key))) {
      errors.push(`${here}.relation must be a relation tuple (${RELATION_KEYS.join(', ')})`);
      return;
    }
    const isPrecision = PRECISION_RELATION_TYPES.has(relation.type);
    if (!isPrecision && !EXPLORATORY_RELATION_TYPES.has(relation.type)) errors.push(`${here}.relation.type is not a supported relation type`);
    if (!isText(relation.target)) errors.push(`${here}.relation.target is required`);
    if (!isText(relation.note)) errors.push(`${here}.relation.note is required`);
    if (relation.target_sense !== undefined && !isText(relation.target_sense)) errors.push(`${here}.relation.target_sense must be text`);
    if (isPrecision && relation.relevance !== undefined) errors.push(`${here}.relation ${relation.type} keeps its precision contract and must not carry relevance`);
    if (EXPLORATORY_RELATION_TYPES.has(relation.type) && !(Number.isInteger(relation.relevance) && relation.relevance >= 1 && relation.relevance <= 9)) {
      errors.push(`${here}.relation ${relation.type} requires relevance 1-9`);
    }
    if (recordOk && (relation.target === item.source_record_id || relation.target_sense === item.source_sense_id)) errors.push(`${here}.relation must not target its own source`);
    if (!senseOk) return;
    const key = reviewedRelationId(item.source_sense_id, relation);
    if (seen.has(key)) errors.push(`${here} repeats another amendment tuple`);
    seen.add(key);
  });
  return errors;
}
