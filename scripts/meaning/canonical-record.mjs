import { meaningId } from './contract.mjs';

/**
 * Canonical-only meaning projection (Issue #820): one STDICT record is one product meaning (the search candidate), and
 * every sense of that record is a member of it, in canonical order. Nothing is split, merged across records, reworded
 * or dropped, and no `data/meanings` / `data/adjudication` input is read.
 *
 * The meaning `gloss` carries the record's source glosses verbatim, one per line (`MEANING_GLOSS_SEPARATOR`), so the
 * shipped tables stay unchanged and the UI can show every definition inside the one selected item.
 */
export const MEANING_GLOSS_SEPARATOR = '\n';

/** The individual source glosses of a meaning gloss, in order. */
export const splitMeaningGloss = (gloss) => (typeof gloss === 'string' ? gloss.split(MEANING_GLOSS_SEPARATOR) : []);

/** `w0097` -> `m0097`, deterministic and independent of the sense count. */
export const recordMeaningId = (recordId) => meaningId(recordId);

/**
 * @param {Iterable<{ id: string, lemma: string, senses: { id: string, gloss: string }[] }>} records normalized records
 * @returns {{ id: string, lemma: string, gloss: string, sense_ids: string[] }[]} one meaning per record with senses
 */
export function projectRecordMeanings(records) {
  const meanings = [];
  for (const record of records) {
    if (record.senses.length === 0) continue;
    for (const sense of record.senses) {
      if (typeof sense.gloss !== 'string' || sense.gloss === '' || sense.gloss.includes(MEANING_GLOSS_SEPARATOR)) {
        throw new Error(`${sense.id}: source gloss must be a non-empty single-line string`);
      }
    }
    meanings.push({
      id: recordMeaningId(record.id),
      lemma: record.lemma,
      gloss: record.senses.map((sense) => sense.gloss).join(MEANING_GLOSS_SEPARATOR),
      sense_ids: record.senses.map((sense) => sense.id),
    });
  }
  return meanings;
}
