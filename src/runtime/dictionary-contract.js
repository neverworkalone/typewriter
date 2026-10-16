import { EXPLORATORY_RELATION_TYPES, LEXICAL_RELATION_TYPES } from './meaning-ranking.js';

export const DICTIONARY_VERSION = 'm2-pilot-1';
export const SQLITE_SCHEMA_VERSION = '5';

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

const quoted = (types) => types.map((type) => `'${type}'`).join(', ');
const MEANING_LEXICAL_TYPES_SQL = quoted(LEXICAL_RELATION_TYPES);
const MEANING_EXPLORATORY_TYPES_SQL = quoted(EXPLORATORY_RELATION_TYPES);
// Total order of a meaning ID as a row value, equal to `compareMeaningIds`: (entry number, ordinal, raw ID).
// Numbers are compared exactly as digit strings (leading zeros stripped, then by length, then text), so no
// integer overflow or packing is involved: `m09` < `m9`, `m1_1000001` < `m2`, `m99...9` < `m100...0`.
const MEANING_ENTRY_DIGITS = (id) => `substr(${id}, 2, instr(${id} || '_', '_') - 2)`;
const MEANING_ORDINAL_DIGITS = (id) => `CASE WHEN instr(${id}, '_') = 0 THEN '0' ELSE substr(${id}, instr(${id}, '_') + 1) END`;
const NORMALIZED_DIGITS = (digits) => `CASE WHEN ltrim(${digits}, '0') = '' THEN '0' ELSE ltrim(${digits}, '0') END`;
const MEANING_ORDER_SQL = (id) => {
  const entry = NORMALIZED_DIGITS(MEANING_ENTRY_DIGITS(id));
  const ordinal = NORMALIZED_DIGITS(MEANING_ORDINAL_DIGITS(id));
  return `length(${entry}), ${entry}, length(${ordinal}), ${ordinal}, ${id}`;
};

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
  // Ranking metadata is precomputed at build time: counts are the distinct relation targets per ranking key
  // (유의어·반의어 / 말의 결·연상), and display_rank is the dense total order by counts DESC then numeric meaning ID.
  meaning_relation_count_mismatch: `
    SELECT COUNT(*) FROM meanings AS meaning
    WHERE meaning.lexical_relation_count <> (
        SELECT COUNT(DISTINCT target_meaning_id) FROM meaning_relations
        WHERE source_meaning_id = meaning.id AND type IN (${MEANING_LEXICAL_TYPES_SQL}))
       OR meaning.exploratory_relation_count <> (
        SELECT COUNT(DISTINCT target_meaning_id) FROM meaning_relations
        WHERE source_meaning_id = meaning.id AND type IN (${MEANING_EXPLORATORY_TYPES_SQL}))`,
  meaning_rank_not_dense: `
    SELECT CASE WHEN COUNT(*) = COALESCE(MAX(display_rank), 0) THEN 0 ELSE 1 END FROM meanings`,
  meaning_rank_order_violation: `
    SELECT COUNT(*) FROM meanings AS earlier
    INNER JOIN meanings AS later ON later.display_rank = earlier.display_rank + 1
    WHERE earlier.lexical_relation_count < later.lexical_relation_count
       OR (earlier.lexical_relation_count = later.lexical_relation_count
           AND (earlier.exploratory_relation_count < later.exploratory_relation_count
             OR (earlier.exploratory_relation_count = later.exploratory_relation_count
                 AND (${MEANING_ORDER_SQL('earlier.id')}) >= (${MEANING_ORDER_SQL('later.id')}))))`,
  meaning_record_mismatch: `
    SELECT COUNT(*) FROM meanings AS meaning
    WHERE meaning.record_id <> 'w' || substr(meaning.id, 2, instr(meaning.id || '_', '_') - 2)`,
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
