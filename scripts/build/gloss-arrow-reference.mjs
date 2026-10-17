import { MEANING_RELATION_ORIGINS } from '../../src/runtime/dictionary-contract.js';

/**
 * STDICT `→` gloss references as product synonym links (Issue #834, owner decision on #797).
 *
 * Invariant: a source gloss that begins `→ <reference>` becomes one product `direct` relation (origin
 * `stdict-gloss-reference`) from the meaning that owns the gloss to the meaning of the ONE Canonical record the
 * reference names; a reference that is malformed or names no record, several records, a missing sense or the record
 * itself, or a `[Ⅰ]`-style group Canonical cannot verify, is held, never guessed. The editors' `→` is not re-judged semantically. `projectDirectReverses()` then mirrors
 * the forward row like any other `direct`. Canonical senses and relations are never modified.
 *
 * Grammar (read from the ORIGINAL gloss, before the display-only homograph-number removal of gloss-homograph-reference):
 *   gloss     = '→ ' ['‘'] headword [NN] ['[' group ']'] ['「' n '」'] ['(' foreign ')'] ['’'] ( '.' [' ' text] | end )
 *   headword  = ['-'] hangul { ' ' hangul }          NN = exactly two digits (homograph number)
 *   group     = roman numeral Ⅰ..Ⅻ                    n  = sense number in the target
 * The reference token is everything up to the terminating period; `text` after it is ignored. Only a gloss-initial
 * arrow is a reference: an arrow inside prose (`A→B` formulas) never is.
 */
export const GLOSS_REFERENCE_ORIGIN = MEANING_RELATION_ORIGINS.gloss;
export const GLOSS_REFERENCE_NOTE = '표준국어대사전 참조';
export const ARROW_PREFIX = '→ ';

const REFERENCE = new RegExp(
  '^→ (?<open>‘)?(?<head>-?[가-힣]+(?: [가-힣]+)*)(?<hn>\\d{2})?(?:\\[(?<group>[Ⅰ-Ⅻ]+)\\])?(?:「(?<sense>\\d+)」)?' +
    '(?:\\((?<foreign>[^()]*)\\))?(?<close>’)?(?=\\.(?: |$)|$)',
  'u',
);

/**
 * @param {string} gloss one source gloss
 * @returns {null | { ok: false, reason: 'malformed' } | { ok: true, headword: string, homograph_no: number | null,
 *   sense_no: number | null, group: string | null, offset: number, text: string }} `null` when the gloss is no arrow reference
 */
export function parseArrowReference(gloss) {
  if (typeof gloss !== 'string' || !gloss.startsWith(ARROW_PREFIX)) return null;
  const match = REFERENCE.exec(gloss);
  if (!match || Boolean(match.groups.open) !== Boolean(match.groups.close)) return { ok: false, reason: 'malformed' };
  const { head, hn, group, sense } = match.groups;
  const sense_no = sense === undefined ? null : Number(sense);
  if (sense_no === 0) return { ok: false, reason: 'malformed' };
  return {
    ok: true,
    headword: head,
    homograph_no: hn === undefined ? null : Number(hn),
    sense_no,
    group: group ?? null,
    offset: ARROW_PREFIX.length,
    text: match[0].slice(ARROW_PREFIX.length),
  };
}

export const HOLD_REASONS = Object.freeze([
  'malformed',
  'target_not_found',
  'ambiguous_target',
  'numberless_reference_to_homograph',
  'sense_out_of_range',
  'group_unsupported',
  'self_reference',
]);

const lemmaOf = (headword) => (headword.startsWith('-') ? headword.slice(1) : headword);

/** `lemma -> records that own a product meaning` (`{ id, lemma, homograph_no, senses }`), built once per projection. */
export function buildTargetIndex(records, ownsMeaning) {
  const index = new Map();
  for (const record of records) {
    if (record.senses.length === 0 || !ownsMeaning(record)) continue;
    if (!index.has(record.lemma)) index.set(record.lemma, []);
    index.get(record.lemma).push(record);
  }
  return index;
}

/**
 * Names the one Canonical record a parsed reference stands for, or the reason it cannot.
 * @returns {{ record: object } | { hold: string }}
 */
export function resolveArrowTarget(reference, index) {
  // `[Ⅰ]`/`[Ⅱ]` select a sense group of the target. Canonical keeps no group structure (a record is a flat list of senses),
  // so which senses a group means cannot be proven from it; such a reference is held, never guessed from part of speech.
  if (reference.group !== null) return { hold: 'group_unsupported' };
  const candidates = index.get(lemmaOf(reference.headword)) ?? [];
  const matching = reference.homograph_no === null
    ? candidates
    : candidates.filter((record) => record.homograph_no === reference.homograph_no);
  if (matching.length === 0) return { hold: 'target_not_found' };
  if (matching.length > 1) return { hold: 'ambiguous_target' };
  const [record] = matching;
  // A numberless reference names a headword STDICT has no homographs of; a numbered target contradicts that.
  if (reference.homograph_no === null && record.homograph_no !== null && record.homograph_no !== undefined) {
    return { hold: 'numberless_reference_to_homograph' };
  }
  if (reference.sense_no !== null && reference.sense_no > record.senses.length) return { hold: 'sense_out_of_range' };
  return { record };
}

const keyOf = (source, target) => `${source}\u0000${target}`;

/**
 * Adds the gloss-derived forward `direct` relations to the original projection. A pair that already exists as an
 * original `direct` keeps its origin and order and only gains the gloss evidence; several glosses naming one pair share
 * one relation with several evidence rows.
 *
 * @param {{ records: object[], meanings: { id: string, sense_ids: string[] }[], relations: object[] }} input
 * @returns {{ relations: object[], holds: { sense_id: string, gloss: string, reason: string }[], stats: object }}
 */
export function projectGlossReferences({ records, meanings, relations }) {
  const senseToMeaning = new Map();
  for (const meaning of meanings) for (const senseId of meaning.sense_ids) senseToMeaning.set(senseId, meaning.id);
  const index = buildTargetIndex(records, (record) => senseToMeaning.has(record.senses[0].id));
  const meaningOfRecord = (record) => senseToMeaning.get(record.senses[0].id);

  const nextPosition = new Map();
  const directByKey = new Map();
  const result = relations.map((relation) => {
    const copy = { ...relation, gloss_sources: [] };
    nextPosition.set(copy.source_meaning_id, Math.max(nextPosition.get(copy.source_meaning_id) ?? 0, copy.position + 1));
    if (copy.type === 'direct') directByKey.set(keyOf(copy.source_meaning_id, copy.target_meaning_id), copy);
    return copy;
  });

  const holds = [];
  const stats = {
    gloss_reference_count: 0,
    gloss_reference_resolved_count: 0,
    gloss_reference_held_count: 0,
    ...Object.fromEntries(HOLD_REASONS.map((reason) => [`gloss_reference_hold_${reason}_count`, 0])),
    gloss_forward_count: 0,
    gloss_forward_existing_direct_count: 0,
    gloss_forward_shared_count: 0,
  };
  const hold = (sense, reason) => {
    stats.gloss_reference_held_count += 1;
    stats[`gloss_reference_hold_${reason}_count`] += 1;
    holds.push({ sense_id: sense.id, gloss: sense.gloss, reason });
  };

  for (const record of records) {
    for (const [senseIndex, sense] of record.senses.entries()) {
      const reference = parseArrowReference(sense.gloss);
      if (reference === null) continue;
      stats.gloss_reference_count += 1;
      const sourceMeaningId = senseToMeaning.get(sense.id);
      if (!reference.ok) {
        hold(sense, reference.reason);
        continue;
      }
      const target = resolveArrowTarget(reference, index);
      if (target.hold) {
        hold(sense, target.hold);
        continue;
      }
      const targetMeaningId = meaningOfRecord(target.record);
      if (sourceMeaningId === undefined || targetMeaningId === sourceMeaningId) {
        hold(sense, 'self_reference');
        continue;
      }
      stats.gloss_reference_resolved_count += 1;
      const evidence = {
        source_sense_id: sense.id,
        gloss_offset: reference.offset,
        reference_text: reference.text,
        target_record_id: target.record.id,
        target_sense_position: reference.sense_no === null ? null : reference.sense_no - 1,
        sense_position: senseIndex,
      };
      const key = keyOf(sourceMeaningId, targetMeaningId);
      const existing = directByKey.get(key);
      if (existing) {
        if (existing.origin === GLOSS_REFERENCE_ORIGIN) stats.gloss_forward_shared_count += 1;
        else stats.gloss_forward_existing_direct_count += 1;
        existing.gloss_sources.push(evidence);
        continue;
      }
      const position = nextPosition.get(sourceMeaningId) ?? 0;
      nextPosition.set(sourceMeaningId, position + 1);
      const row = {
        source_meaning_id: sourceMeaningId,
        target_meaning_id: targetMeaningId,
        type: 'direct',
        note: GLOSS_REFERENCE_NOTE,
        relevance: null,
        origin: GLOSS_REFERENCE_ORIGIN,
        position,
        sources: [],
        gloss_sources: [evidence],
      };
      directByKey.set(key, row);
      result.push(row);
      stats.gloss_forward_count += 1;
    }
  }
  return { relations: result, holds, stats };
}
