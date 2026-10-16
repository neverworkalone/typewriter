export const DICTIONARY_VERSION = 'm2-pilot-1';
export const SQLITE_SCHEMA_VERSION = '4';

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
  expression_count: "SELECT COUNT(*) FROM records WHERE record_type = 'expression'",
});
