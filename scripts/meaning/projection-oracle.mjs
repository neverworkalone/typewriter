// Test-only oracle: expected relation provenance per (source Meaning, target Meaning, type),
// derived independently from canonical sense relations and the current sense -> Meaning map.
// Covers records whose senses all resolve directly (no DROP/duplicate redirects).
const keyOf = (source, target, type) => `${source}\u0000${target}\u0000${type}`;

export function expectedRelationProvenance(records, meanings) {
  const senseToMeaning = new Map();
  for (const meaning of meanings) {
    for (const senseId of meaning.sense_ids) senseToMeaning.set(senseId, meaning.id);
  }
  const groups = new Map();
  for (const record of records) {
    for (const sense of record.senses) {
      for (const [position, relation] of (sense.relations ?? []).entries()) {
        const source = senseToMeaning.get(sense.id);
        const target = senseToMeaning.get(relation.target_sense);
        if (!source || !target || source === target) continue;
        const key = keyOf(source, target, relation.type);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(`${sense.id}@${position}`);
      }
    }
  }
  return normalize(groups);
}

export function actualRelationProvenance(relations) {
  const groups = new Map();
  for (const relation of relations) {
    const key = keyOf(relation.source_meaning_id, relation.target_meaning_id, relation.type);
    groups.set(key, [
      ...(groups.get(key) ?? []),
      ...relation.sources.map((source) => `${source.source_sense_id}@${source.source_position}`),
    ]);
  }
  return normalize(groups);
}

function normalize(groups) {
  return Object.fromEntries([...groups].map(([key, values]) => [key, [...values].sort()]).sort(([a], [b]) => (a < b ? -1 : 1)));
}
