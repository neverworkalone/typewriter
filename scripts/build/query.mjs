import {
  createSearchMatch,
  createSearchResponse,
  normalizeSearchInput,
  SEARCH_MATCH_FIELDS,
  SEARCH_UNSUPPORTED_REASONS,
} from '../../src/runtime/search-query.js';

function findSearchRows(database, term) {
  return database
    .prepare(`
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
    `)
    .all(term, term)
    .map((row) => ({ ...row }));
}

function hasReferenceOnlyMatch(database, term) {
  return Boolean(database
    .prepare(`
      SELECT records.id
      FROM records
      LEFT JOIN search_forms ON search_forms.record_id = records.id
      WHERE records.role = 'reference-only'
        AND (records.lemma = ? OR search_forms.form = ?)
      LIMIT 1
    `)
    .get(term, term));
}

export function findRecordsBySearchTerm(database, rawQuery) {
  const input = normalizeSearchInput(rawQuery);
  if (input.unsupportedReason) {
    return createSearchResponse(input);
  }

  const rows = findSearchRows(database, input.normalizedQuery);
  const seen = new Set();
  const matches = [];

  for (const row of rows) {
    if (seen.has(row.id)) {
      continue;
    }
    seen.add(row.id);
    matches.push(createSearchMatch(row, {
      field: row.match_field === 'lemma'
        ? SEARCH_MATCH_FIELDS.lemma
        : SEARCH_MATCH_FIELDS.searchForm,
      value: row.match_value,
      normalizationRules: input.normalizationRules,
    }));
  }

  if (matches.length === 0 && hasReferenceOnlyMatch(database, input.normalizedQuery)) {
    return createSearchResponse(input, [], {
      reason: SEARCH_UNSUPPORTED_REASONS.referenceOnly,
    });
  }

  return createSearchResponse(input, matches);
}

export function findRecordsByExactTerm(database, term) {
  return findRecordsBySearchTerm(database, term).matches.map(({ match, ...record }) => record);
}

export function getMetadata(database) {
  return Object.fromEntries(
    database
      .prepare('SELECT key, value FROM metadata ORDER BY key')
      .all()
      .map(({ key, value }) => [key, value]),
  );
}

export function getSenseRelations(database, senseId) {
  return database
    .prepare(`
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
    `)
    .all(senseId)
    .map((row) => ({ ...row }));
}

export function getRecord(database, recordId) {
  const record = database
    .prepare(
      'SELECT id, record_type, role, candidate_id, lemma FROM records WHERE id = ?',
    )
    .get(recordId);

  if (!record) {
    return null;
  }

  const searchForms = database
    .prepare(
      'SELECT form FROM search_forms WHERE record_id = ? ORDER BY position',
    )
    .all(recordId)
    .map(({ form }) => form);

  const senses = database
    .prepare(
      'SELECT id, pos, gloss FROM senses WHERE record_id = ? ORDER BY position',
    )
    .all(recordId)
    .map((sense) => ({
      ...sense,
      relations: getSenseRelations(database, sense.id),
    }));

  return { ...record, search_forms: searchForms, senses };
}

function plainRows(rows) {
  return rows.map((row) => ({ ...row }));
}

export function readLogicalDatabaseSnapshot(database) {
  const schema = plainRows(
    database
      .prepare(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%'
         ORDER BY type, name`,
      )
      .all(),
  );

  const rows = {
    metadata: plainRows(
      database.prepare('SELECT key, value FROM metadata ORDER BY key').all(),
    ),
    records: plainRows(
      database
        .prepare(
          'SELECT id, record_type, role, candidate_id, lemma FROM records ORDER BY id',
        )
        .all(),
    ),
    search_forms: plainRows(
      database
        .prepare(
          'SELECT record_id, position, form FROM search_forms ORDER BY record_id, position',
        )
        .all(),
    ),
    senses: plainRows(
      database
        .prepare(
          'SELECT id, record_id, position, pos, gloss FROM senses ORDER BY record_id, position',
        )
        .all(),
    ),
    relations: plainRows(
      database
        .prepare(
          `SELECT source_sense_id, position, target_record_id,
                  target_sense_id, type, note
           FROM relations
           ORDER BY source_sense_id, position`,
        )
        .all(),
    ),
  };

  return {
    schema,
    indexes: schema.filter(({ type }) => type === 'index'),
    rows,
  };
}

export const logicalDatabaseSnapshot = readLogicalDatabaseSnapshot;
