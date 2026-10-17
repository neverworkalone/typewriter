import { MEANING_RELATION_ORIGINS } from '../../src/runtime/dictionary-contract.js';

/**
 * Bidirectional `direct` projection (Issue #797, owner-approved exception to "no invented symmetry").
 *
 * Invariant: every original `direct` meaning relation is shown in both directions. The missing direction is a derived
 * row (`direct-reverse-projection`) that points at the forward row it mirrors; it inherits note and relevance, is never
 * created when the reverse already exists, never mirrors another reverse, and never applies to other relation types.
 * A STDICT `→` gloss is NOT evidence of a synonym (non-standard form -> standard form) and creates no relation here.
 */
export const REVERSE_ORIGIN = MEANING_RELATION_ORIGINS.reverse;

const keyOf = (source, target) => `${source}\u0000${target}`;

/**
 * @param {{ relations: object[] }} input original meaning relations (source projection / authored)
 * @returns {{ relations: object[], stats: { reverse_count: number, reverse_existing_count: number } }}
 */
export function projectDirectReverses({ relations }) {
  const nextPosition = new Map();
  const directKeys = new Set();
  for (const relation of relations) {
    nextPosition.set(relation.source_meaning_id, Math.max(nextPosition.get(relation.source_meaning_id) ?? 0, relation.position + 1));
    if (relation.type === 'direct') directKeys.add(keyOf(relation.source_meaning_id, relation.target_meaning_id));
  }
  const reverses = [];
  let existing = 0;
  for (const relation of relations) {
    if (relation.type !== 'direct') continue;
    const reverseKey = keyOf(relation.target_meaning_id, relation.source_meaning_id);
    if (directKeys.has(reverseKey)) {
      existing += 1;
      continue;
    }
    directKeys.add(reverseKey);
    const position = nextPosition.get(relation.target_meaning_id) ?? 0;
    nextPosition.set(relation.target_meaning_id, position + 1);
    reverses.push({
      source_meaning_id: relation.target_meaning_id,
      target_meaning_id: relation.source_meaning_id,
      type: 'direct',
      note: relation.note,
      relevance: relation.relevance ?? null,
      origin: REVERSE_ORIGIN,
      position,
      sources: [],
      reverse_of: { source_meaning_id: relation.source_meaning_id, position: relation.position },
    });
  }
  return { relations: reverses, stats: { reverse_count: reverses.length, reverse_existing_count: existing } };
}
