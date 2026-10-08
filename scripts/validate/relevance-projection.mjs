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
