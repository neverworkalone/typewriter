import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_CANONICAL_DIRECTORY,
  readCanonicalRecords,
} from '../validate/canonical-jsonl.mjs';
import { validateDatasetRecords } from '../validate/dataset-integrity.mjs';

export const NORMALIZATION_VERSION = '1';

function sourceRecord(recordInfoOrRecord) {
  return recordInfoOrRecord.record ?? recordInfoOrRecord;
}

export function normalizeRelation(relation) {
  return {
    target: relation.target,
    target_sense: relation.target_sense ?? null,
    type: relation.type,
    note: relation.note,
  };
}

export function normalizeSense(sense) {
  return {
    id: sense.id,
    pos: sense.pos,
    gloss: sense.gloss,
    relations: (sense.relations ?? []).map(normalizeRelation),
  };
}

export function normalizeRecord(recordInfoOrRecord) {
  const record = sourceRecord(recordInfoOrRecord);

  return {
    id: record.id,
    record_type: record.record_type,
    role: record.role,
    candidate_id: record.candidate_id ?? null,
    lemma: record.lemma,
    search_forms: [...record.search_forms],
    senses: record.senses.map(normalizeSense),
  };
}

function compareRecordIds(left, right) {
  if (left.id < right.id) {
    return -1;
  }

  if (left.id > right.id) {
    return 1;
  }

  return 0;
}

export function normalizeRecords(recordInfosOrRecords) {
  const records = recordInfosOrRecords.map(normalizeRecord).sort(compareRecordIds);

  return {
    normalization_version: NORMALIZATION_VERSION,
    records,
  };
}

export async function normalizeCanonicalDirectory(
  directory = DEFAULT_CANONICAL_DIRECTORY,
  { checkPilotCompleteness = false } = {},
) {
  const result = await readCanonicalRecords(directory);
  validateDatasetRecords(result.records, { checkPilotCompleteness });

  return normalizeRecords(result.records);
}

export async function main() {
  const model = await normalizeCanonicalDirectory(DEFAULT_CANONICAL_DIRECTORY, {
    checkPilotCompleteness: !process.argv.includes('--no-pilot-regression'),
  });
  const senseCount = model.records.reduce(
    (count, record) => count + record.senses.length,
    0,
  );
  const relationCount = model.records.reduce(
    (count, record) =>
      count +
      record.senses.reduce(
        (senseCountForRecord, sense) =>
          senseCountForRecord + sense.relations.length,
        0,
      ),
    0,
  );

  console.log(
    `Normalized ${model.records.length} record(s) / ${senseCount} sense(s) / ${relationCount} relation(s) in memory (normalization v${model.normalization_version}).`,
  );

  return model;
}

const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
