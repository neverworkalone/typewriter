import {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
  getMetadata,
  getRecord,
  getSenseRelations,
} from '../../src/runtime/sqlite-query.js';

export {
  findRecordsByExactTerm,
  findRecordsBySearchTerm,
  getMetadata,
  getRecord,
  getSenseRelations,
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
    generated_surface_forms: plainRows(
      database
        .prepare(
          `SELECT generated_surface_forms.form,
                  generated_surface_forms.record_id,
                  generated_surface_forms.sense_id,
                  generated_surface_forms.rule_id
           FROM generated_surface_forms
           INNER JOIN senses
             ON senses.id = generated_surface_forms.sense_id
            AND senses.record_id = generated_surface_forms.record_id
           ORDER BY generated_surface_forms.record_id, senses.position,
                    generated_surface_forms.form, generated_surface_forms.rule_id`,
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
