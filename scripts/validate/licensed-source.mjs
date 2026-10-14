import path from 'node:path';

/**
 * Canonical shards converted deterministically from an official, licensed
 * dictionary (표준국어대사전) are named `stdict-NNNN.jsonl`. Their definitions
 * are source text, not Typewriter-authored lexical candidates, so the
 * authoring-time semantic review and editorial gloss heuristics do not apply
 * to them. Structural, identity, relation and surface-form checks still do.
 */
export const LICENSED_SOURCE_SHARD_PATTERN = /^stdict-\d{4,}\.jsonl$/u;

export function isLicensedSourceRecordInfo(recordInfo) {
  const filePath = recordInfo?.filePath ?? recordInfo?.source;
  return typeof filePath === 'string'
    && LICENSED_SOURCE_SHARD_PATTERN.test(path.basename(filePath));
}

const reviewableCache = new WeakMap();

/**
 * Records that still require authored semantic review. The same array is
 * returned when nothing is exempt, and a stable filtered array otherwise, so
 * identity-keyed audit caches keep working.
 */
export function reviewableRecordInfos(recordInfos) {
  if (!Array.isArray(recordInfos)) return recordInfos;
  let reviewable = reviewableCache.get(recordInfos);
  if (!reviewable) {
    reviewable = recordInfos.some(isLicensedSourceRecordInfo)
      ? recordInfos.filter((recordInfo) => !isLicensedSourceRecordInfo(recordInfo))
      : recordInfos;
    reviewableCache.set(recordInfos, reviewable);
  }
  return reviewable;
}
