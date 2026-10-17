import { sha256Json } from '../validate/semantic-audit.mjs';

// Pairwise boundary evidence between a NEW sense and every EXISTING same-POS sense (issue #379).
//
// `new_sense_on_existing_entry` adds senses to a canonical entry. When the entry already has several
// senses of the same POS, a single `context_sense_id` cannot state how the new sense differs from each
// of them. The Stage 2 semantic decision row therefore carries, next to `boundary_pairs` (new ↔ new):
//
//   existing_sense_pairs: [{ existing_sense_id, new_sense_id, relationship: 'distinct', decision: 'retain',
//                            existing_gloss_sha256, new_gloss_sha256,
//                            evidence_basis, distinguishing_feature, rationale }]
//
// - `existing_sense_id` is a sense of the decision's own target entry with the new sense's POS;
// - `new_sense_id` is `<candidate>-s<n>` of a reviewed sense;
// - the set must equal exactly {existing same-POS sense × reviewed sense of that POS}, each once, as soon as
//   the entry has two or more existing same-POS senses (one existing same-POS sense keeps working with
//   `context_sense_id` alone; pairs given for it are still validated);
// - both gloss digests bind the pair to the canonical gloss and the reviewed gloss.
export const EXISTING_SENSE_PAIRS_FIELD = 'existing_sense_pairs';

const PAIR_KEYS = 'decision,distinguishing_feature,evidence_basis,existing_gloss_sha256,existing_sense_id,new_gloss_sha256,new_sense_id,rationale,relationship';
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

export const existingSensePairsOf = (row) => (Array.isArray(row?.[EXISTING_SENSE_PAIRS_FIELD]) ? row[EXISTING_SENSE_PAIRS_FIELD] : []);

/** The (existing sense × reviewed sense index) pairs Stage 2 must evidence, from the canonical target senses. */
export function requiredExistingSensePairs(reviewedSenses, existingSenses) {
  const pairs = [];
  for (const [index, sense] of reviewedSenses.entries()) {
    const samePos = existingSenses.filter((existing) => existing.pos === sense.pos);
    if (samePos.length < 2) continue;
    for (const existing of samePos) pairs.push({ existing_sense_id: existing.id, new_index: index });
  }
  return pairs;
}

/**
 * Validates the pairs of one admitted `new_sense_on_existing_entry` decision. `existingSenses` is the target
 * entry's canonical sense list, or null when the canonical state is not comparable (then only the structure,
 * duplicates and reviewed-side bindings are checked).
 */
export function validateExistingSensePairs(decision, semanticRow, { existingSenses = null, required = false } = {}) {
  const id = decision.source_candidate_id;
  const at = `semantic decision ${id}`;
  const present = semanticRow?.[EXISTING_SENSE_PAIRS_FIELD];
  const isExistingTarget = decision.target?.kind === 'new_sense_on_existing_entry';
  if (!isExistingTarget) return present === undefined ? [] : [`${at}: ${EXISTING_SENSE_PAIRS_FIELD} belongs only to a new_sense_on_existing_entry decision`];
  const reviewed = decision.reviewed_record?.senses ?? [];
  const errors = [];
  if (present !== undefined && !Array.isArray(present)) return [`${at}: ${EXISTING_SENSE_PAIRS_FIELD} must be an array`];
  const seen = new Set();
  for (const [position, pair] of existingSensePairsOf(semanticRow).entries()) {
    const here = `${at} ${EXISTING_SENSE_PAIRS_FIELD}[${position}]`;
    if (!pair || typeof pair !== 'object' || Array.isArray(pair) || Object.keys(pair).sort().join() !== PAIR_KEYS) {
      errors.push(`${here}: must have exactly ${PAIR_KEYS.split(',').join(', ')}`);
      continue;
    }
    const match = /^(.+)-s([1-9]\d*)$/u.exec(pair.new_sense_id ?? '');
    const index = match && match[1] === id ? Number(match[2]) - 1 : -1;
    const sense = reviewed[index];
    if (!sense) { errors.push(`${here}: new_sense_id must name a reviewed sense of ${id}`); continue; }
    const key = `${pair.existing_sense_id}\u0000${pair.new_sense_id}`;
    if (seen.has(key)) { errors.push(`${here}: duplicate pair ${pair.existing_sense_id} / ${pair.new_sense_id}`); continue; }
    seen.add(key);
    if (pair.relationship !== 'distinct' || pair.decision !== 'retain') errors.push(`${here}: an admitted new sense must be a retained distinct sense`);
    if (pair.new_gloss_sha256 !== sha256Json(sense.gloss)) errors.push(`${here}: new_gloss_sha256 does not bind the reviewed gloss`);
    for (const field of ['evidence_basis', 'distinguishing_feature', 'rationale']) {
      if (!isText(pair[field]) || !pair[field].includes(id)) errors.push(`${here}: ${field} must be candidate-specific authored evidence citing ${id}`);
    }
    if (existingSenses) {
      const existing = existingSenses.find((item) => item.id === pair.existing_sense_id);
      if (!existing) errors.push(`${here}: ${pair.existing_sense_id} is not a sense of the target entry ${decision.target.entry_id}`);
      else {
        if (existing.pos !== sense.pos) errors.push(`${here}: existing sense ${existing.id} is ${existing.pos}, the new sense is ${sense.pos}`);
        if (pair.existing_gloss_sha256 !== sha256Json(existing.gloss)) errors.push(`${here}: existing_gloss_sha256 does not bind the canonical gloss of ${existing.id}`);
      }
    }
  }
  if (existingSenses && required) {
    for (const pair of requiredExistingSensePairs(reviewed, existingSenses)) {
      const key = `${pair.existing_sense_id}\u0000${id}-s${pair.new_index + 1}`;
      if (!seen.has(key)) errors.push(`${at}: missing ${EXISTING_SENSE_PAIRS_FIELD} for ${pair.existing_sense_id} / ${id}-s${pair.new_index + 1}`);
    }
  }
  return errors;
}
