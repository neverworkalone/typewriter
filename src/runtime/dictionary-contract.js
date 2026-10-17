export const DICTIONARY_VERSION = 'm2-pilot-1';
export const SQLITE_SCHEMA_VERSION = '10';

export const MEANING_RELATION_ORIGINS = Object.freeze({
  projection: 'stdict-sense-projection',
  authored: 'typewriter-authored',
  reverse: 'direct-reverse-projection',
  gloss: 'stdict-gloss-reference',
});

/**
 * STDICT source tables that back build-time verification only. The product database must not ship them: users see
 * Typewriter meanings and meaning relations, and the source layer would only add size.
 */
export const BUILD_ONLY_TABLES = Object.freeze([
  'senses',
  'relations',
  'meaning_relation_sources',
  'meaning_relation_reverse_sources',
  'meaning_relation_gloss_sources',
]);

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

/**
 * Each query counts violations of the deployed meaning layer and must return 0. They only read tables that ship in
 * the product database; the checks that re-derive the sense -> meaning projection from the STDICT source sense and
 * relation tables run at build time (`scripts/build/meaning-source-checks.mjs`).
 */
export const MEANING_INTEGRITY_QUERIES = Object.freeze({
  meaning_record_mismatch: `
    SELECT COUNT(*) FROM meanings AS meaning
    WHERE meaning.record_id <> 'w' || substr(meaning.id, 2, instr(meaning.id || '_', '_') - 2)`,
  // A verified `direct` is shown in both directions (Issue #797); the reverse is a derived row, but it must exist.
  direct_relation_without_reverse: `
    SELECT COUNT(*) FROM meaning_relations AS relation
    WHERE relation.type = 'direct' AND NOT EXISTS (
      SELECT 1 FROM meaning_relations AS reverse
      WHERE reverse.source_meaning_id = relation.target_meaning_id
        AND reverse.target_meaning_id = relation.source_meaning_id
        AND reverse.type = 'direct')`,
});
