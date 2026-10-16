export const DICTIONARY_VERSION = 'm2-pilot-1';
export const SQLITE_SCHEMA_VERSION = '4';

export const MEANING_RELATION_ORIGINS = Object.freeze({
  projection: 'stdict-sense-projection',
  authored: 'typewriter-authored',
});

export const DICTIONARY_COUNT_QUERIES = Object.freeze({
  record_count: 'SELECT COUNT(*) FROM records',
  start_count: "SELECT COUNT(*) FROM records WHERE role = 'start'",
  reference_only_count: "SELECT COUNT(*) FROM records WHERE role = 'reference-only'",
  candidate_count: 'SELECT COUNT(*) FROM records WHERE candidate_id IS NOT NULL',
  search_form_count: 'SELECT COUNT(*) FROM search_forms',
  sense_count: 'SELECT COUNT(*) FROM senses',
  relation_count: 'SELECT COUNT(*) FROM relations',
  generated_surface_form_count: 'SELECT COUNT(*) FROM generated_surface_forms',
  meaning_count: 'SELECT COUNT(*) FROM meanings',
  meaning_member_count: 'SELECT COUNT(*) FROM meaning_members',
  meaning_relation_count: 'SELECT COUNT(*) FROM meaning_relations',
  meaning_relation_source_count: 'SELECT COUNT(*) FROM meaning_relation_sources',
  expression_count: "SELECT COUNT(*) FROM records WHERE record_type = 'expression'",
});

// Meaning of a sense: its own member meaning, else (for a `duplicate` drop) the meaning of `duplicate_of`.
const memberMeaning = (sense) => `(SELECT meaning_id FROM meaning_members WHERE sense_id = ${sense})`;
const resolvedMeaning = (sense) => `COALESCE(${memberMeaning(sense)}, (
  SELECT member.meaning_id FROM sense_adjudications AS adjudication
  INNER JOIN meaning_members AS member ON member.sense_id = adjudication.duplicate_of_sense_id
  WHERE adjudication.sense_id = ${sense} AND adjudication.reason = 'duplicate'))`;
const redirected = (sense) => `(${memberMeaning(sense)} IS NULL)`;

/**
 * Each query counts violations of the sense -> meaning relation projection and must return 0. They re-derive the
 * expected projection from the stored source tables, so a deleted, extra or mis-bound provenance row is detected
 * (not only a wrong row count) without a second build or a re-parse of canonical data.
 */
export const MEANING_INTEGRITY_QUERIES = Object.freeze({
  meaning_relation_without_provenance: `
    SELECT COUNT(*) FROM meaning_relations AS relation
    WHERE relation.origin = '${MEANING_RELATION_ORIGINS.projection}' AND NOT EXISTS (
      SELECT 1 FROM meaning_relation_sources AS source
      WHERE source.source_meaning_id = relation.source_meaning_id
        AND source.relation_position = relation.position
        AND source.position = 0)`,
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
