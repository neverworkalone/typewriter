import { reviewedRelationId } from '../batch/authored-semantic-decision-source.mjs';
import { relationTupleErrors } from './relation-amendments.mjs';

// Relation correction (#501): a relation-only packet may retype, renote, re-rank or remove one already-authored
// canonical relation. The target never changes, so a correction is bound to its source sense by the gloss digest and
// to the relation it replaces by the exact previous tuple; the previous tuple and its position stay in the ledger so
// the history walkers can always rewind to the record as it was before the packet.
// Packet field: `relation_corrections: [{ source_record_id, source_sense_id, source_gloss_sha256, previous_relation,
// relation, position, rationale }]`; `relation` is the replacement tuple, or null to remove the relation, and
// `position` is where the previous tuple sits in the sense's relation list when this item is applied (items apply in order).

export const CORRECTION_FIELD = 'relation_corrections';
const KEYS = ['source_record_id', 'source_sense_id', 'source_gloss_sha256', 'previous_relation', 'relation', 'position', 'rationale'];
const RELATION_KEYS = ['target', 'target_sense', 'type', 'note', 'relevance'];
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

/** Canonical tuple key order (target, target_sense, type, note, relevance), independent of authoring order. */
export const canonicalTuple = ({ target, target_sense: targetSense, type, note, relevance }) => ({
  target, ...(targetSense === undefined ? {} : { target_sense: targetSense }), type, note, ...(relevance === undefined ? {} : { relevance }),
});
export const sameTuple = (left, right) => JSON.stringify(canonicalTuple(left)) === JSON.stringify(canonicalTuple(right));

export function relationCorrectionErrors(row, at) {
  const list = row?.[CORRECTION_FIELD];
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length === 0) return [`${at}: ${CORRECTION_FIELD} must be a non-empty array when present`];
  const errors = [];
  const seen = new Set();
  list.forEach((item, index) => {
    const here = `${at}: ${CORRECTION_FIELD}[${index}]`;
    if (!isObject(item) || Object.keys(item).some((key) => !KEYS.includes(key)) || KEYS.some((key) => item[key] === undefined)) {
      errors.push(`${here} needs exactly ${KEYS.join(', ')}`);
      return;
    }
    const recordOk = typeof item.source_record_id === 'string' && /^[wr]\d+$/u.test(item.source_record_id);
    const senseOk = recordOk && typeof item.source_sense_id === 'string' && item.source_sense_id.startsWith(`${item.source_record_id}-s`);
    if (!recordOk) errors.push(`${here}.source_record_id must be an existing canonical record id`);
    if (!senseOk) errors.push(`${here}.source_sense_id must be a sense of source_record_id`);
    if (!(Number.isInteger(item.position) && item.position >= 0)) errors.push(`${here}.position must be a non-negative integer`);
    if (!(typeof item.source_gloss_sha256 === 'string' && /^[0-9a-f]{64}$/u.test(item.source_gloss_sha256))) errors.push(`${here}.source_gloss_sha256 must be a sha256 of the source sense gloss`);
    if (!(senseOk && isText(item.rationale) && item.rationale.includes(item.source_record_id) && item.rationale.includes(item.source_sense_id))) {
      errors.push(`${here}.rationale must be source-bound: cite the source record and sense ids`);
    }
    const previous = item.previous_relation;
    const relation = item.relation;
    const shapeOk = (value) => isObject(value) && Object.keys(value).every((key) => RELATION_KEYS.includes(key));
    if (!shapeOk(previous)) { errors.push(`${here}.previous_relation must be a relation tuple (${RELATION_KEYS.join(', ')})`); return; }
    if (relation !== null && !shapeOk(relation)) { errors.push(`${here}.relation must be a relation tuple or null to remove the relation`); return; }
    errors.push(...relationTupleErrors(previous, `${here}.previous_relation`));
    if (typeof previous.target_sense !== 'string') errors.push(`${here}.previous_relation.target_sense is required so a correction names exactly one relation`);
    if (relation !== null) {
      errors.push(...relationTupleErrors(relation, `${here}.relation`));
      if (relation.target !== previous.target || relation.target_sense !== previous.target_sense) errors.push(`${here}.relation must keep the target of previous_relation; only type, note and relevance may change`);
      if (sameTuple(relation, previous)) errors.push(`${here}.relation is identical to previous_relation`);
    }
    if (recordOk && (previous.target === item.source_record_id || previous.target_sense === item.source_sense_id)) errors.push(`${here}.previous_relation must not target its own source`);
    if (!senseOk) return;
    const key = JSON.stringify([item.source_sense_id, previous.target, previous.target_sense ?? null]);
    if (seen.has(key)) errors.push(`${here} corrects the same relation as another correction`);
    seen.add(key);
  });
  return errors;
}

const clone = (value) => structuredClone(value);

/**
 * Undoes the applied corrections of one event on `record`, newest first, so the result is the record as it was before
 * the event. A correction whose replacement is not present is skipped (it was never applied or is already undone).
 */
export function revertRelationCorrections(record, corrections) {
  const applied = corrections.filter((item) => item.source_record_id === record.id && item.outcome === 'amended');
  if (!applied.length) return record;
  const senses = record.senses.map((sense) => ({ ...sense, ...(sense.relations ? { relations: sense.relations.map(clone) } : {}) }));
  for (const item of [...applied].reverse()) {
    const sense = senses.find(({ id }) => id === item.source_sense_id);
    if (!sense) continue;
    const relations = sense.relations ?? [];
    if (item.relation === null) {
      // An interrupted apply may not have removed it yet: never restore a relation that is still there.
      if (!relations.some((relation) => sameTuple(relation, item.previous_relation))) relations.splice(Math.min(item.position, relations.length), 0, clone(item.previous_relation));
    } else {
      const at = relations.findIndex((relation) => sameTuple(relation, item.relation));
      if (at < 0) continue;
      relations[at] = clone(item.previous_relation);
    }
    sense.relations = relations;
  }
  return { ...record, senses };
}

/** The ledger id of a relation tuple on its source sense; removals have no replacement id. */
export const correctionRelationId = (senseId, relation) => (relation === null ? null : reviewedRelationId(senseId, relation));
