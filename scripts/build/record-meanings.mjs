import { MEANING_RELATION_ORIGINS } from '../../src/runtime/dictionary-contract.js';

/**
 * Canonical-only product meaning layer (Issues #820, #822). One STDICT record is one product meaning (the search
 * candidate), and every sense of that record is a member of it, in canonical order. Nothing is split, merged across
 * records, reworded or dropped; no separately maintained Meaning input exists.
 *
 * The meaning `gloss` carries the record's source glosses verbatim, one per line (`MEANING_GLOSS_SEPARATOR`), so the
 * shipped tables stay unchanged and the UI can show every definition inside the one selected item.
 */
export const MEANING_GLOSS_SEPARATOR = '\n';
export const MEANING_RELATION_ORIGIN = MEANING_RELATION_ORIGINS.projection;

const ENTRY_ID = /^w(\d+)$/u;
const MEANING_ID = /^m(\d+)$/u;

/** `w0097` -> `m0097`, deterministic and independent of the sense count. */
export function recordMeaningId(recordId) {
  const match = ENTRY_ID.exec(recordId);
  if (!match) throw new TypeError(`not a canonical entry id: ${recordId}`);
  return `m${match[1]}`;
}

/** `m0097` -> `{ entryId: 'w0097' }`; `null` for anything that is not a record meaning id. */
export function parseMeaningId(id) {
  const match = MEANING_ID.exec(id);
  return match ? { entryId: `w${match[1]}` } : null;
}

/** The individual source glosses of a meaning gloss, in order. */
export const splitMeaningGloss = (gloss) => (typeof gloss === 'string' ? gloss.split(MEANING_GLOSS_SEPARATOR) : []);

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

/**
 * Deterministic sense -> meaning relation projection. Input: normalized records (`record -> sense -> relation`) and
 * their record meanings. Output: meaning-level relations plus provenance rows pointing back to the original sense
 * relations. No editorial decision is made here:
 *
 * - a sense maps to the meaning that lists it in `sense_ids`;
 * - a relation whose endpoint has no meaning is skipped and counted as unresolved;
 * - relations that collapse onto one meaning (self) are skipped;
 * - `source meaning + target meaning + type` is unique; every contributing sense relation stays as provenance.
 */
export function projectMeaningRelations({ records, meanings }) {
  const senseToMeaning = new Map();
  for (const meaning of meanings) {
    for (const senseId of meaning.sense_ids) senseToMeaning.set(senseId, meaning.id);
  }

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
        const sourceMeaningId = senseToMeaning.get(sense.id);
        const targetMeaningId = targetSenseId === null ? undefined : senseToMeaning.get(targetSenseId);
        if (sourceMeaningId === undefined || targetMeaningId === undefined) {
          stats.skipped_unresolved_count += 1;
          continue;
        }
        if (sourceMeaningId === targetMeaningId) {
          stats.skipped_self_count += 1;
          continue;
        }
        const key = `${sourceMeaningId}\u0000${targetMeaningId}\u0000${relation.type}`;
        let entry = byKey.get(key);
        if (entry) {
          stats.deduplicated_count += 1;
        } else {
          entry = {
            source_meaning_id: sourceMeaningId,
            target_meaning_id: targetMeaningId,
            type: relation.type,
            note: relation.note,
            relevance: relation.relevance ?? null,
            origin: MEANING_RELATION_ORIGIN,
            sources: [],
          };
          byKey.set(key, entry);
          order.push(entry);
        }
        entry.sources.push({
          source_sense_id: sense.id,
          source_position: sourcePosition,
          source_redirected: 0,
          target_redirected: 0,
        });
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

/**
 * Test oracle: expected relation provenance per (source meaning, target meaning, type), derived independently from the
 * canonical sense relations and the sense -> meaning map.
 */
const keyOf = (source, target, type) => `${source}\u0000${target}\u0000${type}`;
const normalizeGroups = (groups) =>
  Object.fromEntries([...groups].map(([key, values]) => [key, [...values].sort()]).sort(([a], [b]) => (a < b ? -1 : 1)));

export function expectedRelationProvenance(records, meanings) {
  const senseToMeaning = new Map();
  for (const meaning of meanings) {
    for (const senseId of meaning.sense_ids) senseToMeaning.set(senseId, meaning.id);
  }
  const groups = new Map();
  for (const record of records) {
    for (const sense of record.senses) {
      for (const [position, relation] of (sense.relations ?? []).entries()) {
        const source = senseToMeaning.get(sense.id);
        const target = senseToMeaning.get(relation.target_sense);
        if (!source || !target || source === target) continue;
        const key = keyOf(source, target, relation.type);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(`${sense.id}@${position}`);
      }
    }
  }
  return normalizeGroups(groups);
}

export function actualRelationProvenance(relations) {
  const groups = new Map();
  for (const relation of relations) {
    const key = keyOf(relation.source_meaning_id, relation.target_meaning_id, relation.type);
    groups.set(key, [
      ...(groups.get(key) ?? []),
      ...relation.sources.map((source) => `${source.source_sense_id}@${source.source_position}`),
    ]);
  }
  return normalizeGroups(groups);
}
