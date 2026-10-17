import {
  createSearchResponseFromRows,
  normalizeSearchInput,
} from './search-query.js';

export const EXACT_SEARCH_ROWS_SQL = `
  SELECT id, record_type, role, candidate_id, lemma,
         'lemma' AS match_field, lemma AS match_value, 0 AS match_priority
  FROM records
  WHERE lemma = ?
  UNION ALL
  SELECT records.id, records.record_type, records.role,
         records.candidate_id, records.lemma,
         'search-form' AS match_field, search_forms.form AS match_value,
         1 AS match_priority
  FROM records
  INNER JOIN search_forms ON search_forms.record_id = records.id
  WHERE search_forms.form = ?
  ORDER BY id, match_priority
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
  return allRows(database, EXACT_SEARCH_ROWS_SQL, [term, term]);
}

function findGeneratedSurfaceRows(database, term) {
  return allRows(database, `
    SELECT records.id, records.record_type, records.role,
           records.candidate_id, records.lemma,
           'generated-surface-form' AS match_field,
           generated_surface_forms.form AS match_value,
           generated_surface_forms.rule_id AS rule_id,
           generated_surface_forms.sense_id AS sense_id,
           generated_surface_forms.sense_position AS sense_position
    FROM generated_surface_forms
    INNER JOIN records ON records.id = generated_surface_forms.record_id
    WHERE generated_surface_forms.form = ?
    ORDER BY records.id, generated_surface_forms.sense_position, generated_surface_forms.rule_id
  `, [term]);
}

export function findRecordsBySearchTerm(database, rawQuery) {
  const input = normalizeSearchInput(rawQuery);
  if (input.unsupportedReason) {
    return createSearchResponseFromRows(input);
  }

  return createSearchResponseFromRows(input, {
    exactRows: findSearchRows(database, input.normalizedQuery),
    generatedRows: findGeneratedSurfaceRows(database, input.normalizedQuery),
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

/** Meanings of an exact lemma, each with its member senses (source evidence) in stored order. */
export function getMeaningsByLemma(database, lemma) {
  const meanings = allRows(database, `
    SELECT id, lemma, gloss FROM meanings WHERE lemma = ? ORDER BY id
  `, [lemma]);
  return meanings.map((meaning) => ({
    ...meaning,
    sense_ids: allRows(database, `
      SELECT sense_id FROM meaning_members WHERE meaning_id = ? ORDER BY position
    `, [meaning.id]).map(({ sense_id: senseId }) => senseId),
  }));
}

/** Projected meaning relations of one meaning with target display data. */
export function getMeaningRelations(database, meaningId) {
  return allRows(database, `
    SELECT
      meaning_relations.position,
      meaning_relations.target_meaning_id AS target,
      meaning_relations.type,
      meaning_relations.note,
      meaning_relations.relevance,
      meaning_relations.origin,
      target_meanings.lemma AS target_lemma,
      target_meanings.gloss AS target_gloss
    FROM meaning_relations
    INNER JOIN meanings AS target_meanings
      ON target_meanings.id = meaning_relations.target_meaning_id
    WHERE meaning_relations.source_meaning_id = ?
    ORDER BY meaning_relations.position
  `, [meaningId]);
}

/**
 * Meaning view of a record: the record header plus the meanings its senses resolve to (member or `duplicate` redirect), in place of its raw
 * senses, so the UI candidate unit is the Typewriter meaning. Each meaning carries its precomputed ranking counts,
 * its member sense IDs (source evidence only) and its meaning relations; a relation target is the target
 * meaning's owner record plus the meaning ID, which `getMeaningRecord` can open again.
 */
export function getMeaningRecord(database, recordId) {
  const record = firstRow(database, `
    SELECT id, record_type, role, candidate_id, lemma
    FROM records
    WHERE id = ?
  `, [recordId]);

  if (!record) return null;

  const searchForms = allRows(database, `
    SELECT form FROM search_forms WHERE record_id = ? ORDER BY position
  `, [recordId]).map(({ form }) => form);

  const senses = allRows(database, `
    SELECT meanings.id, meanings.gloss, meanings.display_rank,
           meanings.lexical_relation_count, meanings.exploratory_relation_count
    FROM meanings
    WHERE meanings.id IN (
      SELECT meaning_members.meaning_id FROM meaning_members
      WHERE meaning_members.record_id = ?
      UNION
      -- a duplicate sense of this record resolves to the surviving meaning, which may belong to another record
      SELECT meaning_members.meaning_id FROM sense_adjudications AS adjudication
      INNER JOIN meaning_members ON meaning_members.sense_id = adjudication.duplicate_of_sense_id
      WHERE adjudication.reason = 'duplicate' AND adjudication.record_id = ?)
    ORDER BY meanings.display_rank
  `, [recordId, recordId]).map((meaning) => ({
    ...meaning,
    // Source senses that resolve to this meaning: its members plus the `duplicate` senses redirected to a
    // member (the same resolution the relation projection uses), so a match on any of them finds the meaning.
    sense_ids: allRows(database, `
      SELECT sense_id FROM meaning_members WHERE meaning_id = ?
      UNION ALL
      SELECT adjudication.sense_id FROM sense_adjudications AS adjudication
      INNER JOIN meaning_members AS member ON member.sense_id = adjudication.duplicate_of_sense_id
      WHERE adjudication.reason = 'duplicate' AND member.meaning_id = ?
      ORDER BY 1
    `, [meaning.id, meaning.id]).map(({ sense_id: senseId }) => senseId),
    relations: allRows(database, `
      SELECT
        meaning_relations.position,
        target_meanings.record_id AS target,
        meaning_relations.target_meaning_id AS target_sense,
        meaning_relations.type,
        meaning_relations.note,
        meaning_relations.relevance,
        target_meanings.lemma AS target_lemma,
        target_meanings.gloss AS target_gloss
      FROM meaning_relations
      INNER JOIN meanings AS target_meanings
        ON target_meanings.id = meaning_relations.target_meaning_id
      WHERE meaning_relations.source_meaning_id = ?
      ORDER BY meaning_relations.position
    `, [meaning.id]),
  }));

  return { ...record, view: 'meaning', search_forms: searchForms, senses };
}
