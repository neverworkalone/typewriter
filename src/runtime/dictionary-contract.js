export const DICTIONARY_VERSION = 'm2-pilot-1';
export const SQLITE_SCHEMA_VERSION = '12';

export const MEANING_RELATION_ORIGINS = Object.freeze({
  projection: 'stdict-sense-projection',
  authored: 'typewriter-authored',
  reverse: 'direct-reverse-projection',
  gloss: 'stdict-gloss-reference',
  authoredReverse: 'typewriter-authored-reverse',
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
  'meaning_relation_authored_sources',
]);

/**
 * Metadata key that identifies the purpose of a dictionary database. `full` is the development/verification database
 * (artifacts/dictionary.sqlite) with the STDICT source layer; `lite` is the Meaning-based product database that ships
 * in the extension and is extracted from a verified Full database.
 */
export const DATABASE_KIND_KEY = 'database_kind';
export const DATABASE_KINDS = Object.freeze({ full: 'full', lite: 'lite' });

/**
 * Lite storage layout (Issue #4761). The two flags are written to the Lite `metadata` at build time, read once when the
 * database is opened, and passed to the query functions. `metadata` and the actual tables must agree (fail-closed).
 * Full databases carry no flags and always use the plain tables.
 */
export const LITE_LAYOUT_KEYS = Object.freeze({
  idCompression: 'lite_id_compression',
  textCompression: 'lite_text_compression',
});
export const PLAIN_LAYOUT = Object.freeze({ idCompression: false, textCompression: false });

/** Tables whose presence depends on the layout; every other product table is always present. */
export function layoutTables(layout) {
  return {
    packed_meaning_relations: layout.idCompression,
    text_pool: layout.textCompression,
    packed_text_relations: layout.textCompression,
    meaning_text_relations: !layout.textCompression,
  };
}

export const LAYOUT_TABLES_QUERY = `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${
  Object.keys(layoutTables(PLAIN_LAYOUT)).map((name) => `'${name}'`).join(', ')}) ORDER BY name`;

/** Layout declared by `metadata`; throws on a Lite database without both exact `true`/`false` flags or a Full database with any. */
export function layoutFromMetadata(metadata) {
  const values = Object.values(LITE_LAYOUT_KEYS).map((key) => metadata[key]);
  if (metadata[DATABASE_KIND_KEY] !== DATABASE_KINDS.lite) {
    if (values.some((value) => value !== undefined)) throw new Error('A non-Lite dictionary must not declare a Lite storage layout');
    return PLAIN_LAYOUT;
  }
  if (values.some((value) => value !== 'true' && value !== 'false')) {
    throw new Error('The Lite dictionary does not declare a valid storage layout');
  }
  return Object.freeze({
    idCompression: metadata[LITE_LAYOUT_KEYS.idCompression] === 'true',
    textCompression: metadata[LITE_LAYOUT_KEYS.textCompression] === 'true',
  });
}

/** Names of layout tables that disagree with `layout` (present but unexpected, or missing); `present` is a list of names. */
export function layoutTableMismatches(layout, present) {
  return Object.entries(layoutTables(layout))
    .filter(([name, expected]) => present.includes(name) !== expected)
    .map(([name]) => name);
}

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
  // Logical totals, independent of the Lite layout: validation adds the decoded packed rows to these table counts
  // (`meaning_relations` / `meaning_text_relations` only hold the rows that are not packed).
  meaning_relation_count: 'SELECT COUNT(*) FROM meaning_relations',
  meaning_text_relation_count: 'SELECT COUNT(*) FROM meaning_text_relations',
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
  // Issue #928: an authored ID<->ID relation is shown in both directions, each with its own type and relevance. Several
  // approved rows can reach the same two meanings, so a direction only needs some authored row (either origin) back.
  authored_relation_without_pair: `
    SELECT COUNT(*) FROM meaning_relations AS relation
    WHERE relation.origin IN ('typewriter-authored', 'typewriter-authored-reverse') AND NOT EXISTS (
      SELECT 1 FROM meaning_relations AS pair
      WHERE pair.source_meaning_id = relation.target_meaning_id
        AND pair.target_meaning_id = relation.source_meaning_id
        AND pair.origin IN ('typewriter-authored', 'typewriter-authored-reverse'))`,
  // Authored and reverse rows are exploratory (never direct/antonym) and always carry an editorial tier.
  authored_relation_invalid: `
    SELECT COUNT(*) FROM meaning_relations
    WHERE origin IN ('typewriter-authored', 'typewriter-authored-reverse')
      AND (type IN ('direct', 'antonym') OR relevance IS NULL)`,
});
