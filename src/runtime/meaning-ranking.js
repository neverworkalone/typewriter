import { RELATION_GROUP_DEFINITIONS, UI_GROUP_IDS } from '../domain/relation-groups.js';

export const DEFAULT_MEANING_LIMIT = 3;

const typesOf = (...groupIds) => Object.freeze(
  RELATION_GROUP_DEFINITIONS
    .filter(({ id }) => groupIds.includes(id))
    .flatMap(({ relationTypes }) => relationTypes),
);

/** Relation types counted as 유의어 + 반의어 (first ranking key). */
export const LEXICAL_RELATION_TYPES = typesOf(UI_GROUP_IDS.synonyms, UI_GROUP_IDS.antonyms);
/** Relation types counted as 말의 결 + 연상 (second ranking key). */
export const EXPLORATORY_RELATION_TYPES = typesOf(UI_GROUP_IDS.texture, UI_GROUP_IDS.association);

const MEANING_ID = /^m(\d+)(?:_(\d+))?$/u;

/** `m97` -> [97, 0], `m97_2` -> [97, 2]; numeric so `m443` sorts before `m1000`. */
export function meaningIdOrder(id) {
  const match = MEANING_ID.exec(String(id));
  if (!match) throw new TypeError(`not a meaning id: ${id}`);
  return [Number(match[1]), match[2] === undefined ? 0 : Number(match[2])];
}

export function compareMeaningIds(left, right) {
  const [leftEntry, leftOrdinal] = meaningIdOrder(left);
  const [rightEntry, rightOrdinal] = meaningIdOrder(right);
  return leftEntry - rightEntry || leftOrdinal - rightOrdinal;
}

/** Counts DESC (유의어·반의어, then 말의 결·연상), then meaning ID. A total order for distinct IDs. */
export function compareMeaningRank(left, right) {
  return right.lexical_relation_count - left.lexical_relation_count
    || right.exploratory_relation_count - left.exploratory_relation_count
    || compareMeaningIds(left.id, right.id);
}

/** Distinct relation targets per ranking key, from one meaning's outgoing relations. */
export function countMeaningRelations(relations) {
  const lexical = new Set();
  const exploratory = new Set();
  for (const { type, target_meaning_id: target } of relations) {
    if (LEXICAL_RELATION_TYPES.includes(type)) lexical.add(target);
    else if (EXPLORATORY_RELATION_TYPES.includes(type)) exploratory.add(target);
  }
  return { lexical: lexical.size, exploratory: exploratory.size };
}

export const hasMeaningRelations = (meaning) => (
  meaning.lexical_relation_count + meaning.exploratory_relation_count > 0
);

/**
 * Split the meanings of one search result into the default view and 더보기.
 * Related meanings fill the default view in rank order, up to `limit`; the rest go to 더보기. If no meaning
 * has any relation, the first one (lowest ID) is still shown.
 */
export function partitionMeanings(meanings, limit = DEFAULT_MEANING_LIMIT) {
  const ordered = [...meanings].sort(compareMeaningRank);
  const related = ordered.filter(hasMeaningRelations);
  const primary = related.length > 0 ? related.slice(0, limit) : ordered.slice(0, 1);
  const shown = new Set(primary);
  return { ordered, primary, more: ordered.filter((meaning) => !shown.has(meaning)) };
}
