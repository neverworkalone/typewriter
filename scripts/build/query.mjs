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

/**
 * Raw STDICT source views of the Full database (`artifacts/dictionary.sqlite`, the `buildDictionary` output). The Lite
 * product database ships no source senses or relations, so the product runtime has no equivalent.
 */
export function getSourceSenseRelations(database, senseId) {
  return plainRows(database.prepare(`
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
  `).all(senseId));
}

export function getSourceRecord(database, recordId) {
  const found = database.prepare(`
    SELECT id, record_type, role, candidate_id, lemma
    FROM records
    WHERE id = ?
  `).get(recordId);

  if (!found) return null;
  const record = { ...found };

  const searchForms = database.prepare(`
    SELECT form
    FROM search_forms
    WHERE record_id = ?
    ORDER BY position
  `).all(recordId).map(({ form }) => form);

  const senses = plainRows(database.prepare(`
    SELECT id, pos, gloss
    FROM senses
    WHERE record_id = ?
    ORDER BY position
  `).all(recordId)).map((sense) => ({
    ...sense,
    relations: getSourceSenseRelations(database, sense.id),
  }));

  return { ...record, search_forms: searchForms, senses };
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
      database.prepare('SELECT id, lemma, gloss, record_id, homograph_no FROM meanings ORDER BY id').all(),
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

  // The STDICT source tables exist only in the Full database, never in the Lite product database.
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
  if (tables.has('meaning_relation_gloss_sources')) {
    rows.meaning_relation_gloss_sources = plainRows(
      database
        .prepare(
          `SELECT source_meaning_id, relation_position, position, source_sense_id, gloss_start, gloss_length,
                  target_record_id, target_sense_position
           FROM meaning_relation_gloss_sources ORDER BY source_meaning_id, relation_position, position`,
        )
        .all(),
    );
  }
  if (tables.has('meaning_relation_reverse_sources')) {
    rows.meaning_relation_reverse_sources = plainRows(
      database
        .prepare(
          `SELECT source_meaning_id, relation_position, forward_source_meaning_id, forward_position
           FROM meaning_relation_reverse_sources ORDER BY source_meaning_id, relation_position`,
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
