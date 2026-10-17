import { MEANING_RELATION_ORIGINS } from '../../src/runtime/dictionary-contract.js';

// Meaning of a sense: its own member meaning, else (for a `duplicate` drop) the meaning of `duplicate_of`.
const memberMeaning = (sense) => `(SELECT meaning_id FROM meaning_members WHERE sense_id = ${sense})`;
const resolvedMeaning = (sense) => `COALESCE(${memberMeaning(sense)}, (
  SELECT member.meaning_id FROM sense_adjudications AS adjudication
  INNER JOIN meaning_members AS member ON member.sense_id = adjudication.duplicate_of_sense_id
  WHERE adjudication.sense_id = ${sense} AND adjudication.reason = 'duplicate'))`;
const redirected = (sense) => `(${memberMeaning(sense)} IS NULL)`;


/**
 * Build-time checks of the sense -> meaning relation projection. They run on the Full database, which holds the
 * STDICT source `senses`, `relations` and `meaning_relation_sources` tables (never shipped), and re-derive the
 * expected projection from them, so a deleted, extra or mis-bound provenance row is detected (not only a wrong
 * row count) without a second build or a re-parse of canonical data. Each query counts violations and must return 0.
 */
export const MEANING_SOURCE_INTEGRITY_QUERIES = Object.freeze({
  // The shipped meaning layer carries denormalized copies of source-sense fields in place of a `senses` table.
  meaning_member_sense_mismatch: `
    SELECT COUNT(*) FROM meaning_members AS member
    WHERE NOT EXISTS (
      SELECT 1 FROM senses WHERE senses.id = member.sense_id AND senses.record_id = member.record_id)`,
  sense_adjudication_mismatch: `
    SELECT COUNT(*) FROM sense_adjudications AS adjudication
    WHERE NOT EXISTS (
      SELECT 1 FROM senses WHERE senses.id = adjudication.sense_id AND senses.record_id = adjudication.record_id)
       OR (adjudication.duplicate_of_sense_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM senses WHERE senses.id = adjudication.duplicate_of_sense_id))`,
  generated_surface_form_sense_mismatch: `
    SELECT COUNT(*) FROM generated_surface_forms AS form
    WHERE NOT EXISTS (
      SELECT 1 FROM senses
      WHERE senses.id = form.sense_id AND senses.record_id = form.record_id AND senses.position = form.sense_position)`,
  meaning_relation_without_provenance: `
    SELECT COUNT(*) FROM meaning_relations AS relation
    WHERE relation.origin = '${MEANING_RELATION_ORIGINS.projection}' AND NOT EXISTS (
      SELECT 1 FROM meaning_relation_sources AS source
      WHERE source.source_meaning_id = relation.source_meaning_id
        AND source.relation_position = relation.position
        AND source.position = 0)`,
  // Contributors are stored in canonical order (record id, sense position, relation position), so position 0 is
  // the real first contributor whose note/relevance the projected relation shows.
  meaning_relation_source_order_violation: `
    SELECT COUNT(*) FROM meaning_relation_sources AS earlier
    INNER JOIN meaning_relation_sources AS later
      ON later.source_meaning_id = earlier.source_meaning_id
     AND later.relation_position = earlier.relation_position
     AND later.position > earlier.position
    INNER JOIN relations AS earlier_relation
      ON earlier_relation.source_sense_id = earlier.source_sense_id
     AND earlier_relation.position = earlier.source_position
    INNER JOIN senses AS earlier_sense ON earlier_sense.id = earlier_relation.source_sense_id
    INNER JOIN relations AS later_relation
      ON later_relation.source_sense_id = later.source_sense_id
     AND later_relation.position = later.source_position
    INNER JOIN senses AS later_sense ON later_sense.id = later_relation.source_sense_id
    WHERE (earlier_sense.record_id, earlier_sense.position, earlier_relation.position)
       >= (later_sense.record_id, later_sense.position, later_relation.position)`,
  // Projected relations of one source meaning are positioned by first appearance in canonical order, so their
  // first contributors (position 0) must be strictly increasing with the relation position.
  meaning_relation_position_order_violation: `
    SELECT COUNT(*) FROM meaning_relations AS earlier
    INNER JOIN meaning_relations AS later
      ON later.source_meaning_id = earlier.source_meaning_id
     AND later.position > earlier.position
    INNER JOIN meaning_relation_sources AS earlier_source
      ON earlier_source.source_meaning_id = earlier.source_meaning_id
     AND earlier_source.relation_position = earlier.position
     AND earlier_source.position = 0
    INNER JOIN relations AS earlier_relation
      ON earlier_relation.source_sense_id = earlier_source.source_sense_id
     AND earlier_relation.position = earlier_source.source_position
    INNER JOIN senses AS earlier_sense ON earlier_sense.id = earlier_relation.source_sense_id
    INNER JOIN meaning_relation_sources AS later_source
      ON later_source.source_meaning_id = later.source_meaning_id
     AND later_source.relation_position = later.position
     AND later_source.position = 0
    INNER JOIN relations AS later_relation
      ON later_relation.source_sense_id = later_source.source_sense_id
     AND later_relation.position = later_source.source_position
    INNER JOIN senses AS later_sense ON later_sense.id = later_relation.source_sense_id
    WHERE earlier.origin = '${MEANING_RELATION_ORIGINS.projection}'
      AND later.origin = '${MEANING_RELATION_ORIGINS.projection}'
      AND (earlier_sense.record_id, earlier_sense.position, earlier_relation.position)
       >= (later_sense.record_id, later_sense.position, later_relation.position)`,
  // A projected relation shows the note/relevance of its first contributing source relation, exactly.
  meaning_relation_content_mismatch: `
    SELECT COUNT(*) FROM meaning_relations AS relation
    INNER JOIN meaning_relation_sources AS source
      ON source.source_meaning_id = relation.source_meaning_id
     AND source.relation_position = relation.position
     AND source.position = 0
    INNER JOIN relations AS original
      ON original.source_sense_id = source.source_sense_id
     AND original.position = source.source_position
    WHERE relation.origin = '${MEANING_RELATION_ORIGINS.projection}'
      AND (relation.note IS NOT original.note OR relation.relevance IS NOT original.relevance)`,
  // Typewriter-authored relations carry no STDICT provenance; provenance may only back projected relations.
  meaning_relation_provenance_on_non_projection: `
    SELECT COUNT(*) FROM meaning_relation_sources AS source
    INNER JOIN meaning_relations AS relation
      ON relation.source_meaning_id = source.source_meaning_id
     AND relation.position = source.relation_position
    WHERE relation.origin <> '${MEANING_RELATION_ORIGINS.projection}'`,
  meaning_relation_source_mismatch: `
    SELECT COUNT(*) FROM meaning_relation_sources AS source
    INNER JOIN meaning_relations AS relation
      ON relation.source_meaning_id = source.source_meaning_id
     AND relation.position = source.relation_position
    INNER JOIN relations AS original
      ON original.source_sense_id = source.source_sense_id
     AND original.position = source.source_position
    WHERE original.target_sense_id IS NULL
       OR COALESCE(${resolvedMeaning('original.source_sense_id')} = relation.source_meaning_id, 0) = 0
       OR COALESCE(${resolvedMeaning('original.target_sense_id')} = relation.target_meaning_id, 0) = 0
       OR original.type <> relation.type
       OR source.source_redirected <> ${redirected('original.source_sense_id')}
       OR source.target_redirected <> ${redirected('original.target_sense_id')}`,
  projectable_relation_without_provenance: `
    SELECT COUNT(*) FROM relations AS original
    WHERE original.target_sense_id IS NOT NULL
      AND ${resolvedMeaning('original.source_sense_id')} IS NOT NULL
      AND ${resolvedMeaning('original.target_sense_id')} IS NOT NULL
      AND ${resolvedMeaning('original.source_sense_id')} <> ${resolvedMeaning('original.target_sense_id')}
      AND NOT EXISTS (
        SELECT 1 FROM meaning_relation_sources AS source
        WHERE source.source_sense_id = original.source_sense_id
          AND source.source_position = original.position)`,
});

/**
 * Canonical-only product coverage (Issue #822), run on the Full database of the official canonical build: every source
 * sense is a member of exactly one meaning, that meaning is its own record's (`wN -> mN`), and there is exactly one
 * meaning per record that has senses. An empty or partial meaning layer fails here, which the member-to-source checks
 * above cannot see. Each query counts violations and must return 0.
 */
export const RECORD_MEANING_COVERAGE_QUERIES = Object.freeze({
  sense_without_exactly_one_own_record_member: `
    SELECT COUNT(*) FROM senses
    WHERE (SELECT COUNT(*) FROM meaning_members WHERE meaning_members.sense_id = senses.id) <> 1
       OR NOT EXISTS (
         SELECT 1 FROM meaning_members INNER JOIN meanings ON meanings.id = meaning_members.meaning_id
         WHERE meaning_members.sense_id = senses.id AND meanings.record_id = senses.record_id
           AND meanings.id = 'm' || substr(senses.record_id, 2))`,
  meaning_not_of_one_record: `
    SELECT COUNT(*) FROM meanings
    WHERE id <> 'm' || substr(record_id, 2)
       OR EXISTS (SELECT 1 FROM meaning_members WHERE meaning_members.meaning_id = meanings.id
                  AND meaning_members.record_id <> meanings.record_id)
       OR NOT EXISTS (SELECT 1 FROM senses WHERE senses.record_id = meanings.record_id)`,
  record_with_senses_without_meaning: `
    SELECT COUNT(*) FROM records
    WHERE EXISTS (SELECT 1 FROM senses WHERE senses.record_id = records.id)
      AND NOT EXISTS (SELECT 1 FROM meanings WHERE meanings.record_id = records.id)`,
});

export function assertRecordMeaningCoverage(database, fail) {
  for (const [name, sql] of Object.entries(RECORD_MEANING_COVERAGE_QUERIES)) {
    const violations = Number(Object.values(database.prepare(sql).get())[0]);
    if (violations !== 0) fail(name, violations);
  }
}
