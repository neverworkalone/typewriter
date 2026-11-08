import { PLAIN_LAYOUT } from './dictionary-contract.js';
import {
  decodePackedRelations,
  decodePackedTextRelations,
  meaningId as meaningIdOf,
  meaningNumber,
} from './packed-relations.js';
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

const LOOKUP_CHUNK = 500;

/** Rows of `sql` (containing one `IN (%)` list) for all `keys`, queried in deterministic chunks: never one SQL per key. */
function chunkedRows(database, sql, keys) {
  const rows = [];
  for (let offset = 0; offset < keys.length; offset += LOOKUP_CHUNK) {
    const chunk = keys.slice(offset, offset + LOOKUP_CHUNK);
    rows.push(...allRows(database, sql.replace('%', chunk.map(() => '?').join(',')), chunk));
  }
  return rows;
}

/**
 * Source Meaning number in SQL, equal to `meaningNumber(id)` for the canonical `m<integer>` IDs the Lite build verifies.
 * The record query joins the packed BLOBs on it, so reading them costs no statement of its own.
 */
const SOURCE_NUMBER_SQL = "CAST(substr(meanings.id, 2) AS INTEGER)";

/** Plain `meaning_relations` rows merged by position with the source's packed authored relations (Lite, ID compression). */
function readMeaningRelationRows(database, meaningId, data) {
  const rows = allRows(database, `
    SELECT relation.position, target.record_id AS target_record, relation.target_meaning_id AS target_sense,
      relation.type, relation.note, relation.relevance, relation.origin,
      target.lemma AS target_lemma, target.gloss AS target_gloss
    FROM meaning_relations AS relation
    INNER JOIN meanings AS target ON target.id = relation.target_meaning_id
    WHERE relation.source_meaning_id = ? ORDER BY relation.position`, [meaningId]);
  if (!data) return rows;

  const packed = decodePackedRelations(data);
  const targets = new Map(chunkedRows(
    database,
    'SELECT id, record_id, lemma, gloss FROM meanings WHERE id IN (%)',
    [...new Set(packed.map((row) => meaningIdOf(row.target)))],
  ).map((target) => [target.id, target]));
  const merged = [];
  let plain = 0;
  for (const row of packed) {
    while (plain < rows.length && rows[plain].position < row.position) merged.push(rows[plain++]);
    const target = targets.get(meaningIdOf(row.target));
    if (!target) throw new Error('Packed relation target is missing');
    merged.push({
      position: row.position, target_record: target.record_id, target_sense: target.id, type: row.type, note: row.note,
      relevance: row.relevance, origin: row.origin, target_lemma: target.lemma, target_gloss: target.gloss,
    });
  }
  return merged.concat(rows.slice(plain));
}

/** Text-only relations of a meaning in position order, from `meaning_text_relations` or the text pool + packed list. */
function readTextRelationRows(database, meaningId, layout, data) {
  if (!layout.textCompression) {
    return allRows(database, `
      SELECT position, text, type, relevance FROM meaning_text_relations
      WHERE source_meaning_id = ? ORDER BY position
    `, [meaningId]);
  }
  if (!data) return [];
  const packed = decodePackedTextRelations(data);
  const texts = new Map(chunkedRows(
    database,
    'SELECT id, text FROM text_pool WHERE id IN (%)',
    [...new Set(packed.map((row) => row.text))],
  ).map((row) => [row.id, row.text]));
  return packed.map((row) => {
    if (!texts.has(row.text)) throw new Error('Packed text relation pool entry is missing');
    return { position: row.position, text: texts.get(row.text), type: row.type, relevance: row.relevance };
  });
}

function readMeaningRelations(database, meaningId, detail, data) {
  return readMeaningRelationRows(database, meaningId, data).map((row) => detail ? {
    position: row.position, target: row.target_record, target_sense: row.target_sense, type: row.type,
    note: row.note, relevance: row.relevance, target_lemma: row.target_lemma, target_gloss: row.target_gloss,
  } : {
    position: row.position, target: row.target_sense, type: row.type, note: row.note,
    relevance: row.relevance, origin: row.origin, target_lemma: row.target_lemma, target_gloss: row.target_gloss,
  });
}

/** Projected meaning relations of one meaning with target display data. */
export function getMeaningRelations(database, meaningId, layout = PLAIN_LAYOUT) {
  const data = layout.idCompression
    ? firstRow(database, 'SELECT data FROM packed_meaning_relations WHERE source = ?', [meaningNumber(meaningId)])?.data
    : undefined;
  return readMeaningRelations(database, meaningId, false, data);
}

/**
 * Meaning view of a record: the record header plus the meanings its senses resolve to (member or `duplicate` redirect), in place of its raw
 * senses, so the UI candidate unit is the Typewriter meaning. Each meaning carries its STDICT homograph number
 * (`homograph_no`; the caller orders by it), its member sense IDs (source evidence only) and its meaning relations; a relation target is the target
 * meaning's owner record plus the meaning ID, which `getMeaningRecord` can open again.
 */
export function getMeaningRecord(database, recordId, layout = PLAIN_LAYOUT) {
  const record = firstRow(database, `
    SELECT id, record_type, role, candidate_id, lemma
    FROM records
    WHERE id = ?
  `, [recordId]);

  if (!record) return null;

  const searchForms = allRows(database, `
    SELECT form FROM search_forms WHERE record_id = ? ORDER BY position
  `, [recordId]).map(({ form }) => form);

  const packedColumns = (layout.idCompression ? ', id_pack.data AS id_blob' : '') + (layout.textCompression ? ', text_pack.data AS text_blob' : '');
  const packedJoins = (layout.idCompression ? ` LEFT JOIN packed_meaning_relations AS id_pack ON id_pack.source = ${SOURCE_NUMBER_SQL}` : '')
    + (layout.textCompression ? ` LEFT JOIN packed_text_relations AS text_pack ON text_pack.source = ${SOURCE_NUMBER_SQL}` : '');
  const senses = allRows(database, `
    SELECT meanings.id, meanings.gloss, meanings.homograph_no${packedColumns}
    FROM meanings${packedJoins}
    WHERE meanings.id IN (
      SELECT meaning_members.meaning_id FROM meaning_members
      WHERE meaning_members.record_id = ?
      UNION
      -- a duplicate sense of this record resolves to the surviving meaning, which may belong to another record
      SELECT meaning_members.meaning_id FROM sense_adjudications AS adjudication
      INNER JOIN meaning_members ON meaning_members.sense_id = adjudication.duplicate_of_sense_id
      WHERE adjudication.reason = 'duplicate' AND adjudication.record_id = ?)
    ORDER BY meanings.id
  `, [recordId, recordId]).map(({ id_blob: idBlob, text_blob: textBlob, ...meaning }) => {
    const links = readMeaningRelations(database, meaning.id, true, idBlob);
    // Text-only authored relations (Issue #928) have no target record: plain text after the linked relations, never a link.
    const textRelations = readTextRelationRows(database, meaning.id, layout, textBlob).map((row) => ({
      position: links.length + row.position,
      target: null,
      target_sense: null,
      type: row.type,
      note: null,
      relevance: row.relevance,
      target_lemma: row.text,
      target_gloss: null,
    }));
    return {
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
      relations: [...links, ...textRelations],
    };
  });

  return { ...record, view: 'meaning', search_forms: searchForms, senses };
}
