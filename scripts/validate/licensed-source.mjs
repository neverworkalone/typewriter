/**
 * Records converted deterministically from an official, licensed dictionary
 * (표준국어대사전) carry `source: "stdict"`. Their definitions are source text,
 * not Typewriter-authored lexical candidates, so authoring-time semantic review
 * and editorial gloss heuristics do not apply to them. Structural, identity,
 * relation and surface-form checks still do. The marker is on the record, not
 * on a file name, so every flow that handles plain records agrees on it.
 */
export const LICENSED_SOURCE_MARKER = 'stdict';

export function isLicensedSourceRecord(record) {
  return record?.source === LICENSED_SOURCE_MARKER;
}

export function isLicensedSourceRecordInfo(recordInfo) {
  return isLicensedSourceRecord(recordInfo?.record ?? recordInfo);
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
