import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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
const completeSetOf = new WeakMap();

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
    if (reviewable !== recordInfos) completeSetOf.set(reviewable, recordInfos);
  }
  return reviewable;
}

/**
 * The complete record set a reviewable subset was taken from. The admission ledger also names licensed-source records
 * and is therefore checked against the complete set.
 */
export function completeRecordInfos(recordInfos) {
  return completeSetOf.get(recordInfos) ?? recordInfos;
}

// ---------------------------------------------------------------------------------------------------------------
// Source binding. A marker alone is a claim; the exemption is only valid for records that provably are the official
// projection of a committed provenance manifest. Every canonical admission passes validateDatasetRecords, which runs
// this check first, so an unbound or altered record never reaches the exemptions above.

export const LICENSED_SOURCE_SHARD_PATTERN = /^stdict-\d{4,}\.jsonl$/u;
export const LICENSED_SOURCE_PROVENANCE_CONTRACT = 'stdict-shard-provenance-v1';
/** Relation notes of links taken from the source dictionary; any other relation on a record is later editorial work. */
export const STDICT_NOTES = Object.freeze({
  direct: '표준국어대사전 동의어',
  antonym: '표준국어대사전 반대말',
});
const SOURCE_NOTES = new Set(Object.values(STDICT_NOTES));

/** The source-derived content of a record: everything except relations added after conversion. */
export function sourceProjectionLine(record) {
  return JSON.stringify({
    id: record.id,
    record_type: record.record_type,
    role: record.role,
    candidate_id: record.candidate_id,
    lemma: record.lemma,
    search_forms: record.search_forms,
    senses: record.senses.map((sense) => ({
      id: sense.id,
      pos: sense.pos,
      gloss: sense.gloss,
      relations: (sense.relations ?? [])
        .filter((relation) => SOURCE_NOTES.has(relation.note) && ['direct', 'antonym'].includes(relation.type))
        .map(({ target, target_sense: targetSense, type, note }) => ({ target, target_sense: targetSense, type, note })),
    })),
    source: record.source,
  });
}

export function sourceProjectionSha256(records) {
  return createHash('sha256').update(records.map(sourceProjectionLine).join('\n')).digest('hex');
}

export class LicensedSourceBindingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LicensedSourceBindingError';
    this.code = 'LICENSED_SOURCE_BINDING';
  }
}

const bindingChecked = new WeakSet();

/**
 * Every record carrying the marker must sit in a `stdict-NNNN.jsonl` file whose records are exactly the ones its
 * committed provenance manifest lists (ids, sense counts) and whose source-derived content matches the manifest digest.
 * Relations added afterwards by the backfill do not change that content.
 */
export function assertLicensedSourceBinding(recordInfos) {
  if (!Array.isArray(recordInfos) || bindingChecked.has(recordInfos)) return;
  const byFile = new Map();
  for (const info of recordInfos) {
    const filePath = info?.filePath ?? info?.source;
    const record = info?.record ?? info;
    const inShardFile = typeof filePath === 'string' && LICENSED_SOURCE_SHARD_PATTERN.test(path.basename(filePath));
    if (!isLicensedSourceRecord(record) && !inShardFile) continue;
    if (!inShardFile) {
      throw new LicensedSourceBindingError(`${record?.id}: carries source "${record?.source}" outside a stdict-NNNN.jsonl shard, so it is not bound to a provenance manifest`);
    }
    (byFile.get(filePath) ?? byFile.set(filePath, []).get(filePath)).push(record);
  }
  for (const [filePath, records] of byFile) {
    const name = path.basename(filePath);
    const stem = name.replace(/\.jsonl$/u, '');
    const manifestPath = path.join(path.dirname(path.dirname(filePath)), 'provenance', `${stem}.json`);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new LicensedSourceBindingError(`${name}: provenance manifest ${manifestPath} is unreadable (${error.message})`);
    }
    const fail = (message) => { throw new LicensedSourceBindingError(`${name}: ${message}`); };
    if (manifest.contract !== LICENSED_SOURCE_PROVENANCE_CONTRACT || manifest.shard !== name) fail('provenance manifest does not describe this shard');
    if (!Array.isArray(manifest.records) || manifest.records.length !== records.length) fail(`shard has ${records.length} record(s) but the manifest lists ${manifest.records?.length}`);
    records.forEach((record, position) => {
      const row = manifest.records[position];
      if (!isLicensedSourceRecord(record)) fail(`${record.id} is in a licensed-source shard without the source marker`);
      if (record.id !== row.id || record.id !== `w${String(row.target_code).padStart(3, '0')}`) fail(`${record.id} does not match manifest record ${row.id} (target_code ${row.target_code})`);
      if (record.senses.length !== row.sense_codes.length) fail(`${record.id} has ${record.senses.length} sense(s); the manifest maps ${row.sense_codes.length} sense_code(s)`);
      record.senses.forEach((sense, senseIndex) => {
        if (sense.id !== `${record.id}-s${senseIndex + 1}`) fail(`${sense.id} is not the sense id for position ${senseIndex + 1}`);
      });
    });
    if (sourceProjectionSha256(records) !== manifest.source_projection_sha256) fail('source-derived record content does not match the provenance manifest digest');
  }
  bindingChecked.add(recordInfos);
}
