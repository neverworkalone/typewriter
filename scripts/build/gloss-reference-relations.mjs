import { MEANING_RELATION_ORIGINS } from '../../src/runtime/dictionary-contract.js';
import { recordMeaningId } from './record-meanings.mjs';

/**
 * Gloss-reference `direct` relations and their reverse projection (Issue #797, function B).
 *
 * Invariant: a product `direct` relation is derived from a STDICT `→` gloss only when the gloss is nothing but one
 * reference and that reference resolves, on the canonical source form (before any number is stripped), to exactly
 * one record whose part of speech agrees; everything else is HOLD and reported, never guessed. Every verified
 * `direct` relation is shown in both directions; the reverse is a derived row that points at its forward row and is
 * never recorded as an original source relation. Canonical is untouched.
 *
 * Approval rule (declared, deterministic; no per-word list). A `→` sense is approved when ALL hold:
 *   1. the whole gloss is one reference production (below) — extra text, chains of tokens or odd notation => HOLD;
 *   2. target record: with `NN` exactly the record with that lemma and `homograph_no`; without `NN` the only record
 *      of that lemma (STDICT numbers every reference to a homograph) — missing/ambiguous => HOLD;
 *   3. a `「n」` sense designation names an existing sense of the target; the part of speech of the source sense
 *      equals that of the designated sense (any sense of the target when none is designated) — otherwise HOLD;
 *   4. the designated sense (every sense when none) is not itself a `→` reference — a chain => HOLD;
 *   5. the target is another record (no self reference).
 * `[Ⅰ]`-style group marks and a `(漢字)` annotation are accepted and recorded only as the location of the token.
 */
export const GLOSS_REFERENCE_ORIGIN = MEANING_RELATION_ORIGINS.glossReference;
export const REVERSE_ORIGIN = MEANING_RELATION_ORIGINS.reverse;
export const GLOSS_REFERENCE_NOTE = '표준국어대사전 뜻풀이 참조(→)';

const ARROW = '→ ';
// One anchored production for the whole gloss: `→ ` headword [NN] [`[group]`] [`「n」`] [`(hanja)`] `.`
const REFERENCE_GLOSS =
  /^→ (?<headword>-?[가-힣]+(?: [가-힣]+)*?)(?<homograph>\d{2})?(?<group>\[[^\]\n]+\])?(?:「(?<sense>\d+)」)?(?<hanja>\([^()\n]*\))?\.$/u;

/** @returns {{ headword: string, homograph: string|null, sense: number|null, start: number, length: number }|null} */
export function parseSoleReference(gloss) {
  const match = typeof gloss === 'string' ? REFERENCE_GLOSS.exec(gloss) : null;
  if (!match) return null;
  return {
    headword: match.groups.headword,
    homograph: match.groups.homograph ?? null,
    sense: match.groups.sense === undefined ? null : Number(match.groups.sense),
    start: ARROW.length,
    length: gloss.length - ARROW.length - 1,
  };
}

const isArrow = (gloss) => typeof gloss === 'string' && gloss.startsWith(ARROW);
const pad2 = (value) => String(value ?? '').padStart(2, '0');

/** Resolve a parsed reference against the corpus: `{ target, senseIndex }` or `{ hold }`. */
function resolveReference(record, sense, reference, byLemma) {
  const candidates = byLemma.get(reference.headword) ?? [];
  if (candidates.length === 0) return { hold: 'target_missing' };
  let target;
  if (reference.homograph === null) {
    if (candidates.length !== 1) return { hold: 'unnumbered_ambiguous' };
    [target] = candidates;
  } else {
    const exact = candidates.filter((candidate) => pad2(candidate.homograph_no) === reference.homograph);
    if (exact.length !== 1) return { hold: 'homograph_not_found' };
    [target] = exact;
  }
  if (target.id === record.id) return { hold: 'self_reference' };
  if (target.senses.length === 0) return { hold: 'target_without_senses' };
  let senseIndex = null;
  if (reference.sense !== null) {
    senseIndex = reference.sense - 1;
    if (senseIndex < 0 || senseIndex >= target.senses.length) return { hold: 'target_sense_missing' };
    const designated = target.senses[senseIndex];
    if (isArrow(designated.gloss)) return { hold: 'reference_chain' };
    if (designated.pos !== sense.pos) return { hold: 'pos_mismatch' };
  } else {
    if (target.senses.every((targetSense) => isArrow(targetSense.gloss))) return { hold: 'reference_chain' };
    if (!target.senses.some((targetSense) => targetSense.pos === sense.pos)) return { hold: 'pos_mismatch' };
  }
  return { target, senseIndex };
}

const keyOf = (source, target) => `${source}\u0000${target}`;

/**
 * @param {{ records: object[], relations: object[] }} input normalized records and the existing meaning relations
 *   (original-source projection); returned relations continue each source meaning's positions.
 * @returns {{ relations: object[], stats: object, holds: Map<string, number> }} gloss-reference forward relations
 *   followed by derived reverse relations
 */
export function projectGlossReferenceDirects({ records, relations }) {
  const byLemma = new Map();
  for (const record of records) {
    if (!byLemma.has(record.lemma)) byLemma.set(record.lemma, []);
    byLemma.get(record.lemma).push(record);
  }

  const nextPosition = new Map();
  const directKeys = new Set();
  for (const relation of relations) {
    nextPosition.set(relation.source_meaning_id, Math.max(nextPosition.get(relation.source_meaning_id) ?? 0, relation.position + 1));
    if (relation.type === 'direct') directKeys.add(keyOf(relation.source_meaning_id, relation.target_meaning_id));
  }
  const allocate = (meaningId) => {
    const position = nextPosition.get(meaningId) ?? 0;
    nextPosition.set(meaningId, position + 1);
    return position;
  };

  const holds = new Map();
  const hold = (reason) => holds.set(reason, (holds.get(reason) ?? 0) + 1);
  const stats = { arrow_gloss_count: 0, approved_count: 0, already_direct_count: 0, hold_count: 0, reverse_count: 0, reverse_existing_count: 0 };

  const forward = new Map();
  const forwardOrder = [];
  for (const record of records) {
    if (record.senses.length === 0) continue;
    const sourceMeaningId = recordMeaningId(record.id);
    for (const sense of record.senses) {
      if (!isArrow(sense.gloss)) continue;
      stats.arrow_gloss_count += 1;
      const reference = parseSoleReference(sense.gloss);
      if (!reference) {
        hold('not_sole_reference');
        stats.hold_count += 1;
        continue;
      }
      const resolved = resolveReference(record, sense, reference, byLemma);
      if (resolved.hold) {
        hold(resolved.hold);
        stats.hold_count += 1;
        continue;
      }
      const targetMeaningId = recordMeaningId(resolved.target.id);
      const key = keyOf(sourceMeaningId, targetMeaningId);
      const gloss_source = {
        source_sense_id: sense.id,
        gloss_start: reference.start,
        gloss_length: reference.length,
        target_record_id: resolved.target.id,
        target_sense_position: resolved.senseIndex,
      };
      stats.approved_count += 1;
      if (directKeys.has(key) && !forward.has(key)) {
        // An original `direct` already links these meanings; keep exactly one relation (the original) and its provenance.
        stats.already_direct_count += 1;
        continue;
      }
      if (forward.has(key)) {
        forward.get(key).gloss_sources.push(gloss_source);
        continue;
      }
      const relation = {
        source_meaning_id: sourceMeaningId,
        target_meaning_id: targetMeaningId,
        type: 'direct',
        note: GLOSS_REFERENCE_NOTE,
        relevance: null,
        origin: GLOSS_REFERENCE_ORIGIN,
        position: allocate(sourceMeaningId),
        sources: [],
        gloss_sources: [gloss_source],
      };
      forward.set(key, relation);
      forwardOrder.push(relation);
      directKeys.add(key);
    }
  }

  // Reverse projection of every verified `direct` (original or gloss-reference), never of a reverse.
  const reverses = [];
  for (const relation of [...relations.filter(({ type }) => type === 'direct'), ...forwardOrder]) {
    const reverseKey = keyOf(relation.target_meaning_id, relation.source_meaning_id);
    if (directKeys.has(reverseKey)) {
      stats.reverse_existing_count += 1;
      continue;
    }
    directKeys.add(reverseKey);
    reverses.push({
      source_meaning_id: relation.target_meaning_id,
      target_meaning_id: relation.source_meaning_id,
      type: 'direct',
      note: relation.note,
      relevance: relation.relevance ?? null,
      origin: REVERSE_ORIGIN,
      position: allocate(relation.target_meaning_id),
      sources: [],
      reverse_of: { source_meaning_id: relation.source_meaning_id, position: relation.position },
    });
  }
  stats.reverse_count = reverses.length;
  return { relations: [...forwardOrder, ...reverses], stats, holds };
}
