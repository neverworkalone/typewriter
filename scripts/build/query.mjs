import {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
  getMetadata,
  getMeaningRecord,
} from '../../src/runtime/sqlite-query.js';

export {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
  getMetadata,
  getMeaningRecord,
};

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
    meanings: plainRows(
      database.prepare('SELECT id, lemma, gloss, pos, record_id, lexical_relation_count, exploratory_relation_count, display_rank FROM meanings ORDER BY id').all(),
    ),
    meaning_members: plainRows(
      database
        .prepare('SELECT meaning_id, position, sense_id, record_id FROM meaning_members ORDER BY meaning_id, position')
        .all(),
    ),
    sense_adjudications: plainRows(
      database
        .prepare('SELECT sense_id, reason, record_id, duplicate_of_sense_id FROM sense_adjudications ORDER BY sense_id')
        .all(),
    ),
    meaning_relations: plainRows(
      database
        .prepare(
          `SELECT source_meaning_id, position, target_meaning_id, type, note, relevance, origin
           FROM meaning_relations ORDER BY source_meaning_id, position`,
        )
        .all(),
    ),
    generated_surface_forms: plainRows(
      database
        .prepare(
          `SELECT generated_surface_forms.form,
                  generated_surface_forms.record_id,
                  generated_surface_forms.sense_id,
                  generated_surface_forms.rule_id
           FROM generated_surface_forms
           ORDER BY generated_surface_forms.record_id, generated_surface_forms.sense_position,
                    generated_surface_forms.form, generated_surface_forms.rule_id`,
        )
        .all(),
    ),
  };

  // The STDICT source tables exist only in the build-time staging database, never in the product database.
  const tables = new Set(schema.filter(({ type }) => type === 'table').map(({ name }) => name));
  if (tables.has('senses')) {
    rows.senses = plainRows(
      database
        .prepare('SELECT id, record_id, position, pos, gloss FROM senses ORDER BY record_id, position')
        .all(),
    );
  }
  if (tables.has('relations')) {
    rows.relations = plainRows(
      database
        .prepare(
          `SELECT source_sense_id, position, target_record_id,
                  target_sense_id, type, note, relevance
           FROM relations
           ORDER BY source_sense_id, position`,
        )
        .all(),
    );
  }
  if (tables.has('meaning_relation_sources')) {
    rows.meaning_relation_sources = plainRows(
      database
        .prepare(
          `SELECT source_meaning_id, relation_position, position, source_sense_id, source_position,
                  source_redirected, target_redirected
           FROM meaning_relation_sources ORDER BY source_meaning_id, relation_position, position`,
        )
        .all(),
    );
  }

  return {
    schema,
    indexes: schema.filter(({ type }) => type === 'index'),
    rows,
  };
}

export const logicalDatabaseSnapshot = readLogicalDatabaseSnapshot;
