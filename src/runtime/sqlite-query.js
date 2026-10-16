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
           senses.position AS sense_position
    FROM generated_surface_forms
    INNER JOIN records ON records.id = generated_surface_forms.record_id
    INNER JOIN senses ON senses.id = generated_surface_forms.sense_id
      AND senses.record_id = generated_surface_forms.record_id
    WHERE generated_surface_forms.form = ?
    ORDER BY records.id, senses.position, generated_surface_forms.rule_id
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

export function getSenseRelations(database, senseId) {
  return allRows(database, `
    SELECT
      relations.position,
      relations.target_record_id AS target,
      relations.target_sense_id AS target_sense,
      relations.type,
      relations.note,
      relations.relevance,
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

/** Projected meaning relations of one meaning with target display data and source-sense provenance. */
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
  `, [meaningId]).map((relation) => ({
    ...relation,
    sources: allRows(database, `
      SELECT source_sense_id, source_position, source_redirected, target_redirected
      FROM meaning_relation_sources
      WHERE source_meaning_id = ? AND relation_position = ?
      ORDER BY position
    `, [meaningId, relation.position]),
  }));
}

/**
 * Meaning view of a record: the record header plus the meanings it contributes member senses to, in place of its raw
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
           meanings.lexical_relation_count, meanings.exploratory_relation_count,
           (SELECT senses.pos FROM meaning_members
              INNER JOIN senses ON senses.id = meaning_members.sense_id
              WHERE meaning_members.meaning_id = meanings.id
              ORDER BY meaning_members.position LIMIT 1) AS pos
    FROM meanings
    WHERE meanings.id IN (
      SELECT meaning_members.meaning_id FROM meaning_members
      INNER JOIN senses ON senses.id = meaning_members.sense_id
      WHERE senses.record_id = ?)
    ORDER BY meanings.display_rank
  `, [recordId]).map((meaning) => ({
    ...meaning,
    sense_ids: allRows(database, `
      SELECT sense_id FROM meaning_members WHERE meaning_id = ? ORDER BY position
    `, [meaning.id]).map(({ sense_id: senseId }) => senseId),
    relations: allRows(database, `
      SELECT
        meaning_relations.position,
        target_meanings.record_id AS target,
        meaning_relations.target_meaning_id AS target_sense,
        meaning_relations.type,
        meaning_relations.note,
        meaning_relations.relevance,
        target_meanings.lemma AS target_lemma,
        (SELECT senses.pos FROM meaning_members
           INNER JOIN senses ON senses.id = meaning_members.sense_id
           WHERE meaning_members.meaning_id = target_meanings.id
           ORDER BY meaning_members.position LIMIT 1) AS target_pos,
        target_meanings.gloss AS target_gloss
      FROM meaning_relations
      INNER JOIN meanings AS target_meanings
        ON target_meanings.id = meaning_relations.target_meaning_id
      WHERE meaning_relations.source_meaning_id = ?
      ORDER BY meaning_relations.position
    `, [meaning.id]),
  }));

  return { ...record, search_forms: searchForms, senses };
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
