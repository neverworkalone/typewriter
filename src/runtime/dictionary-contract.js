import { EXPLORATORY_RELATION_TYPES, LEXICAL_RELATION_TYPES } from './meaning-ranking.js';

export const DICTIONARY_VERSION = 'm2-pilot-1';
export const SQLITE_SCHEMA_VERSION = '7';

export const MEANING_RELATION_ORIGINS = Object.freeze({
  projection: 'stdict-sense-projection',
  authored: 'typewriter-authored',
});

/**
 * STDICT source tables that back build-time verification only. The product database must not ship them: users see
 * Typewriter meanings and meaning relations, and the source layer would only add size.
 */
export const BUILD_ONLY_TABLES = Object.freeze(['senses', 'relations', 'meaning_relation_sources']);

/**
 * Metadata key that identifies the purpose of a dictionary database. `full` is the development/verification database
 * (artifacts/dictionary.sqlite) with the STDICT source layer; `lite` is the Meaning-based product database that ships
 * in the extension and is extracted from a verified Full database.
 */
export const DATABASE_KIND_KEY = 'database_kind';
export const DATABASE_KINDS = Object.freeze({ full: 'full', lite: 'lite' });

export const BUILD_ONLY_TABLES_QUERY = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${
  BUILD_ONLY_TABLES.map((name) => `'${name}'`).join(', ')}) ORDER BY name`;

export const DICTIONARY_COUNT_QUERIES = Object.freeze({
  record_count: 'SELECT COUNT(*) FROM records',
  start_count: "SELECT COUNT(*) FROM records WHERE role = 'start'",
  reference_only_count: "SELECT COUNT(*) FROM records WHERE role = 'reference-only'",
  candidate_count: 'SELECT COUNT(*) FROM records WHERE candidate_id IS NOT NULL',
  search_form_count: 'SELECT COUNT(*) FROM search_forms',
  generated_surface_form_count: 'SELECT COUNT(*) FROM generated_surface_forms',
  meaning_count: 'SELECT COUNT(*) FROM meanings',
  meaning_member_count: 'SELECT COUNT(*) FROM meaning_members',
  meaning_relation_count: 'SELECT COUNT(*) FROM meaning_relations',
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

/**
 * Each query counts violations of the deployed meaning layer and must return 0. They only read tables that ship in
 * the product database; the checks that re-derive the sense -> meaning projection from the STDICT source sense and
 * relation tables run at build time (`scripts/build/meaning-source-checks.mjs`).
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
});
