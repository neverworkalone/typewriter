import { resolveSurfaceFormJudgments } from '../inflection/surface-form-projection.mjs';

// Stage 2 → Stage 3 hand-off of explicit surface-form (inflection class) judgments (issue #365).
//
// A predicate whose final coda is ambiguous between regular and irregular inflection (for example a
// ㅂ-final adjective) cannot be classified by a mechanical rule. Stage 2 states the judgment per
// reviewed sense; the shared surface-form rule then checks it, and Stage 3 records it in the same
// M6-2/M6-3 manifests it already owns:
//
//   surface_form_judgments: [{ sense_index, class_id, reason }]
//
// - `sense_index` is the 0-based index of the sense in `reviewed_record.senses`;
// - `class_id` is any M6-2/M6-3 class that the existing manifest validators accept for that exact
//   sense (an irregular exception class, the regular risk-coda class, or the predicate exclusion);
// - `reason` is authored, candidate-specific text.
//
// A judgment is allowed only for a sense that actually has an open judgment gap, and a sense with an
// open gap needs one. No word, suffix or class is special-cased here: validity is decided entirely by
// `resolveSurfaceFormJudgments` in the shared projection.
export const SURFACE_FORM_JUDGMENTS_FIELD = 'surface_form_judgments';

const ADMITTED = new Set(['included', 'corrected']);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

export const surfaceFormJudgmentsOf = (decision) => (Array.isArray(decision?.[SURFACE_FORM_JUDGMENTS_FIELD]) ? decision[SURFACE_FORM_JUDGMENTS_FIELD] : []);

// The prospective canonical record of an admitted decision. Only lemma and POS drive the shared rule,
// so the reviewed senses are enough, independent of the final allocated ids.
const prospectiveRecord = (decision) => ({
  id: decision.source_candidate_id,
  record_type: 'entry',
  lemma: decision.reviewed_record.lemma,
  senses: decision.reviewed_record.senses.map((sense, index) => ({ id: `${decision.source_candidate_id}-s${index + 1}`, pos: sense.pos, gloss: sense.gloss })),
});

/**
 * Validates the judgments of one decision row against the shared rule. With `required`, a sense that
 * still needs a judgment is an error; without it (a pending review that predates this field) only the
 * judgments that are present are checked.
 */
export function validateSurfaceFormJudgments(decision, { required = false } = {}) {
  const id = decision?.source_candidate_id;
  const at = `decision ${id}`;
  const present = decision?.[SURFACE_FORM_JUDGMENTS_FIELD];
  if (!ADMITTED.has(decision?.disposition)) {
    return present === undefined ? [] : [`${at}: only an included or corrected decision carries ${SURFACE_FORM_JUDGMENTS_FIELD}`];
  }
  if (typeof decision.reviewed_record?.lemma !== 'string' || !Array.isArray(decision.reviewed_record.senses)) return [];
  if (present !== undefined && !Array.isArray(present)) return [`${at}: ${SURFACE_FORM_JUDGMENTS_FIELD} must be an array`];
  const errors = [];
  const senseCount = decision.reviewed_record.senses.length;
  const judgments = [];
  for (const [position, entry] of surfaceFormJudgmentsOf(decision).entries()) {
    const here = `${at}: ${SURFACE_FORM_JUDGMENTS_FIELD}[${position}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).sort().join() !== 'class_id,reason,sense_index') {
      errors.push(`${here} must have exactly sense_index, class_id and reason`);
      continue;
    }
    if (!Number.isInteger(entry.sense_index) || entry.sense_index < 0 || entry.sense_index >= senseCount) {
      errors.push(`${here}: sense_index must name a reviewed sense`);
      continue;
    }
    if (typeof entry.class_id !== 'string' || !entry.class_id) { errors.push(`${here}: class_id is required`); continue; }
    if (!isText(entry.reason) || !entry.reason.includes(id)) { errors.push(`${here}: reason must be candidate-specific authored text citing ${id}`); continue; }
    judgments.push({ record_id: id, sense_id: `${id}-s${entry.sense_index + 1}`, class_id: entry.class_id, reason: entry.reason });
  }
  if (errors.length) return errors;
  const resolved = resolveSurfaceFormJudgments([prospectiveRecord(decision)], judgments);
  errors.push(...resolved.errors.map((message) => `${at}: ${message}`));
  if (required && !errors.length) {
    for (const gap of resolved.missing) errors.push(`${at}: ${gap.message} Add a ${SURFACE_FORM_JUDGMENTS_FIELD} entry for this sense.`);
  }
  return errors;
}

/** Stage 3: the judgments of the planned admission, addressed by the allocated canonical ids. */
export function stage3SurfaceFormJudgments(decisions) {
  return decisions.filter((row) => ADMITTED.has(row.disposition)).flatMap((row) => surfaceFormJudgmentsOf(row).map((entry) => ({
    record_id: row.__entry_id,
    sense_id: row.__sense_ids[entry.sense_index],
    class_id: entry.class_id,
    reason: entry.reason,
  })));
}
