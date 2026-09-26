import {
  createSearchResponseFromRows,
  normalizeSearchInput,
} from './search-query.js';

export const REFERENCE_ONLY_MATCH_SQL = `
  SELECT (
    EXISTS (
      SELECT 1
      FROM records
      WHERE role = 'reference-only' AND lemma = ?
    )
    OR EXISTS (
      SELECT 1
      FROM search_forms
      INNER JOIN records ON records.id = search_forms.record_id
      WHERE records.role = 'reference-only' AND search_forms.form = ?
    )
  ) AS has_reference_only_match
`;

function allRows(database, sql, parameters = []) {
  if (typeof database.selectObjects === 'function') {
    return database.selectObjects(sql, parameters).map((row) => ({ ...row }));
  }

  return database.prepare(sql).all(...parameters).map((row) => ({ ...row }));
}

function firstRow(database, sql, parameters = []) {
  if (typeof database.selectObjects === 'function') {
    return allRows(database, sql, parameters)[0];
  }

  const row = database.prepare(sql).get(...parameters);
  return row ? { ...row } : undefined;
}

function findSearchRows(database, term) {
  return allRows(database, `
    SELECT id, record_type, role, candidate_id, lemma,
           'lemma' AS match_field, lemma AS match_value, 0 AS match_priority
    FROM records
    WHERE role = 'start' AND lemma = ?
    UNION ALL
    SELECT records.id, records.record_type, records.role,
           records.candidate_id, records.lemma,
           'search-form' AS match_field, search_forms.form AS match_value,
           1 AS match_priority
    FROM records
    INNER JOIN search_forms ON search_forms.record_id = records.id
    WHERE records.role = 'start' AND search_forms.form = ?
    ORDER BY id, match_priority
  `, [term, term]);
}

function findGeneratedSurfaceRows(database, term) {
  return allRows(database, `
    SELECT records.id, records.record_type, records.role,
           records.candidate_id, records.lemma,
           'generated-surface-form' AS match_field,
           generated_surface_forms.form AS match_value,
           generated_surface_forms.rule_id AS rule_id,
           generated_surface_forms.sense_id AS sense_id,
           senses.position AS sense_position
    FROM generated_surface_forms
    INNER JOIN records ON records.id = generated_surface_forms.record_id
    INNER JOIN senses ON senses.id = generated_surface_forms.sense_id
      AND senses.record_id = generated_surface_forms.record_id
    WHERE records.role = 'start' AND generated_surface_forms.form = ?
    ORDER BY records.id, senses.position, generated_surface_forms.rule_id
  `, [term]);
}

function hasReferenceOnlyMatch(database, term) {
  const row = firstRow(database, REFERENCE_ONLY_MATCH_SQL, [term, term]);
  return Number(row?.has_reference_only_match) === 1;
}

export function findRecordsBySearchTerm(database, rawQuery) {
  const input = normalizeSearchInput(rawQuery);
  if (input.unsupportedReason) {
    return createSearchResponseFromRows(input);
  }

  return createSearchResponseFromRows(input, {
    exactRows: findSearchRows(database, input.normalizedQuery),
    generatedRows: findGeneratedSurfaceRows(database, input.normalizedQuery),
    hasReferenceOnlyMatch: hasReferenceOnlyMatch(database, input.normalizedQuery),
  });
}

export function findRecordsByExactTerm(database, term) {
  return findRecordsBySearchTerm(database, term).matches.map(({ match, ...record }) => record);
}

export function getMetadata(database) {
  return Object.fromEntries(
    allRows(database, 'SELECT key, value FROM metadata ORDER BY key')
      .map(({ key, value }) => [key, value]),
  );
}

export function getSenseRelations(database, senseId) {
  return allRows(database, `
    SELECT
      relations.position,
      relations.target_record_id AS target,
      relations.target_sense_id AS target_sense,
      relations.type,
      relations.note,
      target_records.lemma AS target_lemma,
      target_senses.pos AS target_pos,
      target_senses.gloss AS target_gloss
    FROM relations
    INNER JOIN records AS target_records
      ON target_records.id = relations.target_record_id
    LEFT JOIN senses AS target_senses
      ON target_senses.id = relations.target_sense_id
     AND target_senses.record_id = relations.target_record_id
    WHERE relations.source_sense_id = ?
    ORDER BY relations.position
  `, [senseId]);
}

export function getRecord(database, recordId) {
  const record = firstRow(database, `
    SELECT id, record_type, role, candidate_id, lemma
    FROM records
    WHERE id = ?
  `, [recordId]);

  if (!record) return null;

  const searchForms = allRows(database, `
    SELECT form
    FROM search_forms
    WHERE record_id = ?
    ORDER BY position
  `, [recordId]).map(({ form }) => form);

  const senses = allRows(database, `
    SELECT id, pos, gloss
    FROM senses
    WHERE record_id = ?
    ORDER BY position
  `, [recordId]).map((sense) => ({
    ...sense,
    relations: getSenseRelations(database, sense.id),
  }));

  return { ...record, search_forms: searchForms, senses };
}
