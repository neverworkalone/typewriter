// Packaged as-is into the extension's runtime/ directory (see product-runtime-plugin.mjs): it must not import
// anything outside src/runtime.

/** Candidates (same-spelled meanings) and definitions shown before 더보기. */
export const DEFAULT_CANDIDATE_LIMIT = 3;
export const DEFAULT_DEFINITION_LIMIT = 3;

const MEANING_ID = /^m(\d+)(?:_(\d+))?$/u;

/**
 * `m97` -> [97n, 0n], `m97_2` -> [97n, 2n]. Exact (unbounded) integers; the raw ID is the final tie-break, so
 * IDs that differ only in leading zeros (`m09`, `m9`) still have a fixed order, as in `compareEntryIds`.
 */
export function meaningIdOrder(id) {
  const match = MEANING_ID.exec(String(id));
  if (!match) throw new TypeError(`not a meaning id: ${id}`);
  return [BigInt(match[1]), BigInt(match[2] ?? 0), String(id)];
}

const compareOrdered = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** Total order: (entry number, ordinal, raw ID). */
export function compareMeaningIds(left, right) {
  const leftOrder = meaningIdOrder(left);
  const rightOrder = meaningIdOrder(right);
  return leftOrder.reduce((difference, part, index) => (
    difference || compareOrdered(part, rightOrder[index])
  ), 0);
}

/**
 * STDICT compilation order of same-spelled meanings: the official homograph number (`homograph_no`, 1-99), then the
 * meaning ID as the stable fallback. A meaning without a source number (its headword had no `01`-style suffix) sorts
 * after the numbered ones; this never invents a source order from the ID. Relation counts play no part.
 */
export function compareMeaningOrder(left, right) {
  const leftNo = left.homograph_no ?? Infinity;
  const rightNo = right.homograph_no ?? Infinity;
  return compareOrdered(leftNo, rightNo) || compareMeaningIds(left.id, right.id);
}

/** Split an ordered candidate list into the default view (first `limit`) and 더보기 (the rest, all of them). */
export function partitionCandidates(items, limit = DEFAULT_CANDIDATE_LIMIT) {
  return { primary: items.slice(0, limit), more: items.slice(limit) };
}
