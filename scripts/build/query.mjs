export function findRecordsByExactTerm(database, term) {
  return database
    .prepare(`
      SELECT id, record_type, role, candidate_id, lemma
      FROM records
      WHERE lemma = ?
      UNION
      SELECT records.id, records.record_type, records.role,
        records.candidate_id, records.lemma
      FROM records
      INNER JOIN search_forms ON search_forms.record_id = records.id
      WHERE search_forms.form = ?
      ORDER BY id
    `)
    .all(term, term)
    .map((row) => ({ ...row }));
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
