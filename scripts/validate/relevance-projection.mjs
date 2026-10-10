const EXPLORATORY_RELATION_TYPES = new Set(['near', 'mood', 'scene', 'sensory', 'action', 'association']);

/**
 * #396: frozen historical records predate `relevance`. Compare them with the live
 * record through this projection, which drops only `relevance` on exploratory
 * relations; every other field difference stays visible to the comparison.
 */
export function withoutRelevance(record) {
  if (!record || !Array.isArray(record.senses)) return record;
  return {
    ...record,
    senses: record.senses.map((sense) => (Array.isArray(sense.relations)
      ? {
        ...sense,
        relations: sense.relations.map((relation) => {
          if (!EXPLORATORY_RELATION_TYPES.has(relation.type) || !Object.hasOwn(relation, 'relevance')) return relation;
          const { relevance, ...rest } = relation;
          return rest;
        }),
      }
      : sense)),
  };
}

function withoutRelations(record) {
  if (!record || !Array.isArray(record.senses)) return record;
  const { senses, ...recordFields } = record;
  return {
    ...recordFields,
    senses: senses.map(({ relations, ...sense }) => sense),
  };
}

function projectedRelations(relations) {
  return withoutRelevance({ senses: [{ relations }] }).senses[0].relations;
}

/**
 * Relation enrichment is independent of lexical admission. Compare a later
 * canonical record with the reviewed record while requiring every reviewed
 * field and relation to remain intact; only appended relations and the
 * separately versioned exploratory-relevance field may differ.
 */
export function preservesReviewedRecord(reviewedRecord, canonicalRecord) {
  if (!reviewedRecord || !canonicalRecord) return false;
  if (!Array.isArray(reviewedRecord.senses) || !Array.isArray(canonicalRecord.senses)) return false;

  if (JSON.stringify(withoutRelations(reviewedRecord))
    !== JSON.stringify(withoutRelations(canonicalRecord))) return false;

  return reviewedRecord.senses.every((reviewedSense, index) => {
    const reviewedRelations = reviewedSense.relations ?? [];
    const canonicalRelations = canonicalRecord.senses[index].relations ?? [];
    if (canonicalRelations.length < reviewedRelations.length) return false;
    return JSON.stringify(projectedRelations(canonicalRelations.slice(0, reviewedRelations.length)))
      === JSON.stringify(projectedRelations(reviewedRelations));
  });
}

export function preservesReviewedRecords(reviewedRecords, canonicalRecords) {
  if (!Array.isArray(reviewedRecords) || !Array.isArray(canonicalRecords)
    || reviewedRecords.length !== canonicalRecords.length) return false;
  return reviewedRecords.every((reviewed, index) => (
    preservesReviewedRecord(
      reviewed?.record ?? reviewed,
      canonicalRecords[index]?.record ?? canonicalRecords[index],
    )
  ));
}
