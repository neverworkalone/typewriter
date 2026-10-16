/**
 * Deterministic sense -> meaning relation projection (Issue #717).
 *
 * Input: the untouched canonical records (`record -> sense -> relation`), the final meanings and the adjudication
 * verdicts (`docs/meaning-layer.md`). Output: meaning-level relations plus the provenance rows that point back to the
 * original sense relations. No editorial decision is made here:
 *
 * - a sense maps to the meaning that lists it in `sense_ids`;
 * - a `duplicate` sense is redirected once through `duplicate_of` (which validation guarantees is not dropped);
 * - an `out_of_scope` sense, or a sense without any meaning, has no product endpoint, so its relations are skipped;
 * - relations that collapse onto one meaning (self) are skipped;
 * - `source meaning + target meaning + type` is unique; every contributing sense relation stays as provenance.
 */

export const MEANING_RELATION_ORIGIN = 'stdict-sense-projection';

function resolveEndpoint(senseId, senseToMeaning, dropped) {
  const direct = senseToMeaning.get(senseId);
  if (direct !== undefined) return { meaningId: direct, redirected: false };
  const verdict = dropped.get(senseId);
  if (verdict?.reason === 'duplicate' && verdict.duplicate_of) {
    const target = senseToMeaning.get(verdict.duplicate_of);
    if (target !== undefined) return { meaningId: target, redirected: true };
  }
  return null;
}

/**
 * @param {{ records: Iterable<object>, meanings: object[], adjudications: object[] }} input
 *   `records` are normalized records (senses carry `relations`; relations carry `target_sense`).
 */
export function projectMeaningRelations({ records, meanings, adjudications = [] }) {
  const senseToMeaning = new Map();
  for (const meaning of meanings) {
    for (const senseId of meaning.sense_ids) senseToMeaning.set(senseId, meaning.id);
  }
  const dropped = new Map(adjudications.map((item) => [item.sense_id, item]));

  const stats = {
    source_relation_count: 0,
    projected_relation_count: 0,
    redirected_relation_count: 0,
    skipped_out_of_scope_count: 0,
    skipped_unresolved_count: 0,
    skipped_self_count: 0,
    deduplicated_count: 0,
  };
  const byKey = new Map();
  const order = [];

  for (const record of records) {
    for (const sense of record.senses) {
      for (const [sourcePosition, relation] of (sense.relations ?? []).entries()) {
        stats.source_relation_count += 1;
        const targetSenseId = relation.target_sense ?? null;
        const source = resolveEndpoint(sense.id, senseToMeaning, dropped);
        const target = targetSenseId === null ? null : resolveEndpoint(targetSenseId, senseToMeaning, dropped);
        if (!source || !target) {
          const outOfScope = [sense.id, targetSenseId].some((id) => id !== null && dropped.get(id)?.reason === 'out_of_scope');
          if (outOfScope) stats.skipped_out_of_scope_count += 1;
          else stats.skipped_unresolved_count += 1;
          continue;
        }
        if (source.meaningId === target.meaningId) {
          stats.skipped_self_count += 1;
          continue;
        }
        const key = `${source.meaningId}\u0000${target.meaningId}\u0000${relation.type}`;
        const provenance = {
          source_sense_id: sense.id,
          source_position: sourcePosition,
          source_redirected: source.redirected ? 1 : 0,
          target_redirected: target.redirected ? 1 : 0,
        };
        let entry = byKey.get(key);
        if (entry) {
          stats.deduplicated_count += 1;
        } else {
          entry = {
            source_meaning_id: source.meaningId,
            target_meaning_id: target.meaningId,
            type: relation.type,
            note: relation.note,
            relevance: relation.relevance ?? null,
            origin: MEANING_RELATION_ORIGIN,
            sources: [],
          };
          byKey.set(key, entry);
          order.push(entry);
        }
        entry.sources.push(provenance);
        if (source.redirected || target.redirected) stats.redirected_relation_count += 1;
      }
    }
  }

  // Positions are per source meaning, in first-occurrence (canonical) order.
  const positions = new Map();
  for (const entry of order) {
    const position = positions.get(entry.source_meaning_id) ?? 0;
    entry.position = position;
    positions.set(entry.source_meaning_id, position + 1);
  }
  stats.projected_relation_count = order.length;
  return { relations: order, stats };
}
