import { MEANING_RELATION_ORIGINS } from '../../src/runtime/dictionary-contract.js';
import { buildTargetIndex, parseArrowReference, resolveArrowTarget } from './gloss-arrow-reference.mjs';

// Meaning of a sense: its own member meaning, else (for a `duplicate` drop) the meaning of `duplicate_of`.
const memberMeaning = (sense) => `(SELECT meaning_id FROM meaning_members WHERE sense_id = ${sense})`;
const resolvedMeaning = (sense) => `COALESCE(${memberMeaning(sense)}, (
  SELECT member.meaning_id FROM sense_adjudications AS adjudication
  INNER JOIN meaning_members AS member ON member.sense_id = adjudication.duplicate_of_sense_id
  WHERE adjudication.sense_id = ${sense} AND adjudication.reason = 'duplicate'))`;
const redirected = (sense) => `(${memberMeaning(sense)} IS NULL)`;


/**
 * Build-time checks of the sense -> meaning relation projection. They run on the Full database, which holds the
 * STDICT source `senses`, `relations` and `meaning_relation_sources` tables (never shipped), and re-derive the
 * expected projection from them, so a deleted, extra or mis-bound provenance row is detected (not only a wrong
 * row count) without a second build or a re-parse of canonical data. Each query counts violations and must return 0.
 */
export const MEANING_SOURCE_INTEGRITY_QUERIES = Object.freeze({
  // The shipped meaning layer carries denormalized copies of source-sense fields in place of a `senses` table.
  meaning_member_sense_mismatch: `
    SELECT COUNT(*) FROM meaning_members AS member
    WHERE NOT EXISTS (
      SELECT 1 FROM senses WHERE senses.id = member.sense_id AND senses.record_id = member.record_id)`,
  sense_adjudication_mismatch: `
    SELECT COUNT(*) FROM sense_adjudications AS adjudication
    WHERE NOT EXISTS (
      SELECT 1 FROM senses WHERE senses.id = adjudication.sense_id AND senses.record_id = adjudication.record_id)
       OR (adjudication.duplicate_of_sense_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM senses WHERE senses.id = adjudication.duplicate_of_sense_id))`,
  generated_surface_form_sense_mismatch: `
    SELECT COUNT(*) FROM generated_surface_forms AS form
    WHERE NOT EXISTS (
      SELECT 1 FROM senses
      WHERE senses.id = form.sense_id AND senses.record_id = form.record_id AND senses.position = form.sense_position)`,
  meaning_relation_without_provenance: `
    SELECT COUNT(*) FROM meaning_relations AS relation
    WHERE relation.origin = '${MEANING_RELATION_ORIGINS.projection}' AND NOT EXISTS (
      SELECT 1 FROM meaning_relation_sources AS source
      WHERE source.source_meaning_id = relation.source_meaning_id
        AND source.relation_position = relation.position
        AND source.position = 0)`,
  // Contributors are stored in canonical order (record id, sense position, relation position), so position 0 is
  // the real first contributor whose note/relevance the projected relation shows.
  meaning_relation_source_order_violation: `
    SELECT COUNT(*) FROM meaning_relation_sources AS earlier
    INNER JOIN meaning_relation_sources AS later
      ON later.source_meaning_id = earlier.source_meaning_id
     AND later.relation_position = earlier.relation_position
     AND later.position > earlier.position
    INNER JOIN relations AS earlier_relation
      ON earlier_relation.source_sense_id = earlier.source_sense_id
     AND earlier_relation.position = earlier.source_position
    INNER JOIN senses AS earlier_sense ON earlier_sense.id = earlier_relation.source_sense_id
    INNER JOIN relations AS later_relation
      ON later_relation.source_sense_id = later.source_sense_id
     AND later_relation.position = later.source_position
    INNER JOIN senses AS later_sense ON later_sense.id = later_relation.source_sense_id
    WHERE (earlier_sense.record_id, earlier_sense.position, earlier_relation.position)
       >= (later_sense.record_id, later_sense.position, later_relation.position)`,
  // Projected relations of one source meaning are positioned by first appearance in canonical order, so their
  // first contributors (position 0) must be strictly increasing with the relation position.
  meaning_relation_position_order_violation: `
    SELECT COUNT(*) FROM meaning_relations AS earlier
    INNER JOIN meaning_relations AS later
      ON later.source_meaning_id = earlier.source_meaning_id
     AND later.position > earlier.position
    INNER JOIN meaning_relation_sources AS earlier_source
      ON earlier_source.source_meaning_id = earlier.source_meaning_id
     AND earlier_source.relation_position = earlier.position
     AND earlier_source.position = 0
    INNER JOIN relations AS earlier_relation
      ON earlier_relation.source_sense_id = earlier_source.source_sense_id
     AND earlier_relation.position = earlier_source.source_position
    INNER JOIN senses AS earlier_sense ON earlier_sense.id = earlier_relation.source_sense_id
    INNER JOIN meaning_relation_sources AS later_source
      ON later_source.source_meaning_id = later.source_meaning_id
     AND later_source.relation_position = later.position
     AND later_source.position = 0
    INNER JOIN relations AS later_relation
      ON later_relation.source_sense_id = later_source.source_sense_id
     AND later_relation.position = later_source.source_position
    INNER JOIN senses AS later_sense ON later_sense.id = later_relation.source_sense_id
    WHERE earlier.origin = '${MEANING_RELATION_ORIGINS.projection}'
      AND later.origin = '${MEANING_RELATION_ORIGINS.projection}'
      AND (earlier_sense.record_id, earlier_sense.position, earlier_relation.position)
       >= (later_sense.record_id, later_sense.position, later_relation.position)`,
  // A projected relation shows the note/relevance of its first contributing source relation, exactly.
  meaning_relation_content_mismatch: `
    SELECT COUNT(*) FROM meaning_relations AS relation
    INNER JOIN meaning_relation_sources AS source
      ON source.source_meaning_id = relation.source_meaning_id
     AND source.relation_position = relation.position
     AND source.position = 0
    INNER JOIN relations AS original
      ON original.source_sense_id = source.source_sense_id
     AND original.position = source.source_position
    WHERE relation.origin = '${MEANING_RELATION_ORIGINS.projection}'
      AND (relation.note IS NOT original.note OR relation.relevance IS NOT original.relevance)`,
  // Typewriter-authored relations carry no STDICT provenance; provenance may only back projected relations.
  meaning_relation_provenance_on_non_projection: `
    SELECT COUNT(*) FROM meaning_relation_sources AS source
    INNER JOIN meaning_relations AS relation
      ON relation.source_meaning_id = source.source_meaning_id
     AND relation.position = source.relation_position
    WHERE relation.origin <> '${MEANING_RELATION_ORIGINS.projection}'`,
  // Derived relations (Issue #797): each carries its own provenance kind, never a fake original source position.
  // Derived reverse relations (Issue #797) carry their own provenance kind, never a fake original source position.
  reverse_relation_without_provenance: `
    SELECT COUNT(*) FROM meaning_relations AS relation
    WHERE relation.origin = '${MEANING_RELATION_ORIGINS.reverse}' AND NOT EXISTS (
      SELECT 1 FROM meaning_relation_reverse_sources AS source
      WHERE source.source_meaning_id = relation.source_meaning_id AND source.relation_position = relation.position)`,
  // A reverse mirrors a forward \`direct\` that is itself not a reverse; note and relevance are inherited, never invented.
  reverse_relation_mismatch: `
    SELECT COUNT(*) FROM meaning_relation_reverse_sources AS source
    INNER JOIN meaning_relations AS reverse
      ON reverse.source_meaning_id = source.source_meaning_id AND reverse.position = source.relation_position
    LEFT JOIN meaning_relations AS forward
      ON forward.source_meaning_id = source.forward_source_meaning_id AND forward.position = source.forward_position
    WHERE reverse.origin <> '${MEANING_RELATION_ORIGINS.reverse}'
       OR reverse.type <> 'direct'
       OR forward.source_meaning_id IS NULL
       OR forward.type <> 'direct'
       OR forward.origin = '${MEANING_RELATION_ORIGINS.reverse}'
       OR forward.source_meaning_id <> reverse.target_meaning_id
       OR forward.target_meaning_id <> reverse.source_meaning_id
       OR forward.note IS NOT reverse.note
       OR forward.relevance IS NOT reverse.relevance`,
  // Issue #834: a gloss-reference relation is a \`direct\` backed by gloss evidence; evidence never hangs on another type.
  gloss_relation_without_evidence: `
    SELECT COUNT(*) FROM meaning_relations AS relation
    WHERE relation.origin = '${MEANING_RELATION_ORIGINS.gloss}' AND (relation.type <> 'direct' OR NOT EXISTS (
      SELECT 1 FROM meaning_relation_gloss_sources AS source
      WHERE source.source_meaning_id = relation.source_meaning_id AND source.relation_position = relation.position))`,
  gloss_evidence_on_wrong_relation: `
    SELECT COUNT(*) FROM meaning_relation_gloss_sources AS source
    INNER JOIN meaning_relations AS relation
      ON relation.source_meaning_id = source.source_meaning_id AND relation.position = source.relation_position
    WHERE relation.type <> 'direct' OR relation.origin = '${MEANING_RELATION_ORIGINS.reverse}'`,
  meaning_relation_source_mismatch: `
    SELECT COUNT(*) FROM meaning_relation_sources AS source
    INNER JOIN meaning_relations AS relation
      ON relation.source_meaning_id = source.source_meaning_id
     AND relation.position = source.relation_position
    INNER JOIN relations AS original
      ON original.source_sense_id = source.source_sense_id
     AND original.position = source.source_position
    WHERE original.target_sense_id IS NULL
       OR COALESCE(${resolvedMeaning('original.source_sense_id')} = relation.source_meaning_id, 0) = 0
       OR COALESCE(${resolvedMeaning('original.target_sense_id')} = relation.target_meaning_id, 0) = 0
       OR original.type <> relation.type
       OR source.source_redirected <> ${redirected('original.source_sense_id')}
       OR source.target_redirected <> ${redirected('original.target_sense_id')}`,
  projectable_relation_without_provenance: `
    SELECT COUNT(*) FROM relations AS original
    WHERE original.target_sense_id IS NOT NULL
      AND ${resolvedMeaning('original.source_sense_id')} IS NOT NULL
      AND ${resolvedMeaning('original.target_sense_id')} IS NOT NULL
      AND ${resolvedMeaning('original.source_sense_id')} <> ${resolvedMeaning('original.target_sense_id')}
      AND NOT EXISTS (
        SELECT 1 FROM meaning_relation_sources AS source
        WHERE source.source_sense_id = original.source_sense_id
          AND source.source_position = original.position)`,
});

/**
 * Canonical-only product coverage (Issue #822), run on the Full database of the official canonical build: every source
 * sense is a member of exactly one meaning, that meaning is its own record's (`wN -> mN`), and there is exactly one
 * meaning per record that has senses. An empty or partial meaning layer fails here, which the member-to-source checks
 * above cannot see. Each query counts violations and must return 0.
 */
export const RECORD_MEANING_COVERAGE_QUERIES = Object.freeze({
  sense_without_exactly_one_own_record_member: `
    SELECT COUNT(*) FROM senses
    WHERE (SELECT COUNT(*) FROM meaning_members WHERE meaning_members.sense_id = senses.id) <> 1
       OR NOT EXISTS (
         SELECT 1 FROM meaning_members INNER JOIN meanings ON meanings.id = meaning_members.meaning_id
         WHERE meaning_members.sense_id = senses.id AND meanings.record_id = senses.record_id
           AND meanings.id = 'm' || substr(senses.record_id, 2))`,
  meaning_not_of_one_record: `
    SELECT COUNT(*) FROM meanings
    WHERE id <> 'm' || substr(record_id, 2)
       OR EXISTS (SELECT 1 FROM meaning_members WHERE meaning_members.meaning_id = meanings.id
                  AND meaning_members.record_id <> meanings.record_id)
       OR NOT EXISTS (SELECT 1 FROM senses WHERE senses.record_id = meanings.record_id)`,
  record_with_senses_without_meaning: `
    SELECT COUNT(*) FROM records
    WHERE EXISTS (SELECT 1 FROM senses WHERE senses.record_id = records.id)
      AND NOT EXISTS (SELECT 1 FROM meanings WHERE meanings.record_id = records.id)`,
});

export function assertRecordMeaningCoverage(database, fail) {
  for (const [name, sql] of Object.entries(RECORD_MEANING_COVERAGE_QUERIES)) {
    const violations = Number(Object.values(database.prepare(sql).get())[0]);
    if (violations !== 0) fail(name, violations);
  }
}


/**
 * Independent re-derivation of the \`→\` gloss references (Issue #834) from the Full database tables alone: the source
 * \`senses\` glosses, the \`meanings\` and their members. The expected evidence set must equal the stored
 * \`meaning_relation_gloss_sources\` exactly, so a missing, extra, relocated or mis-targeted row is a violation, and each
 * evidence row must hang on the \`direct\` relation between the right two meanings. Returns violation counts by check.
 */
export function glossReferenceViolations(database) {
  const meaningOfRecord = new Map(
    database.prepare('SELECT id, record_id FROM meanings').all().map((row) => [row.record_id, row.id]),
  );
  const recordList = [];
  const senses = database.prepare('SELECT id, record_id, gloss FROM senses ORDER BY record_id, position').all();
  const byRecord = new Map();
  for (const sense of senses) {
    if (!byRecord.has(sense.record_id)) byRecord.set(sense.record_id, []);
    byRecord.get(sense.record_id).push(sense);
  }
  for (const meaning of database.prepare('SELECT lemma, homograph_no, record_id FROM meanings').all()) {
    recordList.push({
      id: meaning.record_id, lemma: meaning.lemma, homograph_no: meaning.homograph_no,
      senses: byRecord.get(meaning.record_id) ?? [],
    });
  }
  const index = buildTargetIndex(recordList, (record) => meaningOfRecord.has(record.id));

  const expected = new Map();
  for (const sense of senses) {
    const reference = parseArrowReference(sense.gloss);
    if (reference === null || !reference.ok) continue;
    const target = resolveArrowTarget(reference, index);
    if (target.hold) continue;
    const source = meaningOfRecord.get(sense.record_id);
    const targetMeaning = meaningOfRecord.get(target.record.id);
    if (source === undefined || source === targetMeaning) continue;
    expected.set(sense.id, {
      source_meaning_id: source,
      target_meaning_id: targetMeaning,
      gloss_offset: reference.offset,
      reference_text: reference.text,
      target_record_id: target.record.id,
      target_sense_position: reference.sense_no === null ? null : reference.sense_no - 1,
    });
  }
  const actual = new Map(
    database.prepare(
      `SELECT source.*, relation.target_meaning_id, relation.type
       FROM meaning_relation_gloss_sources AS source
       LEFT JOIN meaning_relations AS relation
         ON relation.source_meaning_id = source.source_meaning_id AND relation.position = source.relation_position`,
    ).all().map((row) => [row.source_sense_id, row]),
  );
  const violations = {
    gloss_reference_evidence_missing: 0,
    gloss_reference_evidence_forged: 0,
    gloss_reference_evidence_mismatch: 0,
  };
  for (const [senseId, want] of expected) {
    const have = actual.get(senseId);
    if (!have) violations.gloss_reference_evidence_missing += 1;
    else if (
      have.source_meaning_id !== want.source_meaning_id || have.target_meaning_id !== want.target_meaning_id
      || have.type !== 'direct' || have.gloss_offset !== want.gloss_offset
      || have.reference_text !== want.reference_text || have.target_record_id !== want.target_record_id
      || have.target_sense_position !== want.target_sense_position
    ) violations.gloss_reference_evidence_mismatch += 1;
  }
  for (const senseId of actual.keys()) if (!expected.has(senseId)) violations.gloss_reference_evidence_forged += 1;
  return violations;
}
