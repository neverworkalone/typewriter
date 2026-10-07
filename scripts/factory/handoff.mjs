import { findConfusableLemmaHints } from '../validate/lexical-quality.mjs';
import { DISPOSITIONS, TARGET_KINDS } from './contract.mjs';

// Typed Stage 2 → Stage 3 decision handoff (design §5.1). Pure validation against a
// canonical index (see identity-adapter `buildCanonicalIndex`); it writes nothing.

const REASON_REQUIRED = new Set(['held', 'rejected', 'deferred']);
const POS = new Set(['noun', 'verb', 'adjective', 'adverb']);

// Compatibility with the CURRENT canonical writer, verified by reading
// scripts/batch/lexical-production*.mjs, build-issue-223-corpus-batch.mjs and
// validateLexicalAddition: they emit one new `entry` record per lemma with senses and
// have no operation that adds a sense/POS to an existing entry, and the entrypoint
// tripwire/non-batch baseline would reject such an edit. Only `new_entry` is therefore
// writable today; the other two kinds are valid Stage 2 decisions that Stage 3 must
// implement a compatible, validated writer for (issue #266).
export const CURRENT_WRITER_SUPPORT = Object.freeze({
  new_entry: 'current-batch-writer',
  new_pos_on_existing_lemma: 'stage3-writer-required',
  new_sense_on_existing_entry: 'stage3-writer-required',
});

export function validateDecisionRow(row, { canonicalIndex }) {
  const at = `decision ${row?.source_candidate_id}`;
  const errors = [];
  if (!DISPOSITIONS.includes(row?.disposition)) return [`${at}: disposition must be one of ${DISPOSITIONS.join(', ')}`];
  if (REASON_REQUIRED.has(row.disposition)) {
    if (typeof row.reason !== 'string' || !row.reason) errors.push(`${at}: ${row.disposition} requires a candidate-specific reason`);
    if (row.target !== undefined || row.reviewed_record !== undefined) errors.push(`${at}: ${row.disposition} must not carry a target or reviewed record`);
    return errors;
  }
  const kind = row.target?.kind;
  if (!TARGET_KINDS.includes(kind)) return [...errors, `${at}: target.kind must be one of ${TARGET_KINDS.join(', ')}`];
  const record = row.reviewed_record;
  if (typeof record?.lemma !== 'string' || !Array.isArray(record.senses) || record.senses.length === 0) {
    return [...errors, `${at}: reviewed_record needs lemma and at least one sense`];
  }
  for (const sense of record.senses) {
    if (!POS.has(sense?.pos) || typeof sense.gloss !== 'string' || !sense.gloss) errors.push(`${at}: every sense needs pos and gloss`);
  }
  const entries = canonicalIndex.get(record.lemma) ?? [];
  if (kind === 'new_entry') {
    if (entries.length) errors.push(`${at}: new_entry but lemma ${record.lemma} is already canonical`);
    if (row.target.entry_id !== undefined) errors.push(`${at}: new_entry must not name an existing entry id`);
    return errors;
  }
  const target = entries.find((entry) => entry.id === row.target.entry_id);
  if (!target) return [...errors, `${at}: ${kind} requires an existing canonical entry_id for ${record.lemma}`];
  const existingPos = new Set(target.senses.map((sense) => sense.pos));
  if (kind === 'new_pos_on_existing_lemma') {
    for (const sense of record.senses) if (existingPos.has(sense.pos)) errors.push(`${at}: pos ${sense.pos} already exists on ${target.id}`);
  } else {
    if (!target.senses.some((sense) => sense.id === row.target.context_sense_id)) errors.push(`${at}: new_sense_on_existing_entry requires context_sense_id of an existing sense`);
    for (const sense of record.senses) if (!existingPos.has(sense.pos)) errors.push(`${at}: new sense pos ${sense.pos} is not on ${target.id}; use new_pos_on_existing_lemma`);
  }
  return errors;
}

// Non-blocking editorial hints (never validation errors): reviewed glosses that read like a
// confusable counterpart headword, for the author and the independent reviewers to compare.
export function confusableLemmaAdvisories(rows) {
  return rows.flatMap((row) => (row?.reviewed_record
    ? findConfusableLemmaHints({
      lemma: row.reviewed_record.lemma,
      senses: row.reviewed_record.senses,
      label: `decision ${row.source_candidate_id} reviewed_record`,
    }) : []));
}

export function validateDecisionHandoff(rows, { canonicalIndex }) {
  return rows.flatMap((row) => validateDecisionRow(row, { canonicalIndex }));
}

// What the current pipeline can consume now vs what is deferred to Stage 3.
export function partitionByWriterSupport(rows) {
  const writable = [];
  const stage3Required = [];
  for (const row of rows) {
    if (!['included', 'corrected'].includes(row.disposition)) continue;
    (CURRENT_WRITER_SUPPORT[row.target.kind] === 'current-batch-writer' ? writable : stage3Required).push(row);
  }
  return { writable, stage3Required };
}
