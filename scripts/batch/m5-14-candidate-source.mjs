import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import source from '../../data/batches/m5-14-lexical-unit-source.json' with { type: 'json' };
import { materializeLexicalUnitCandidates } from './lexical-production.mjs';

const REPOSITORY_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_PATH = path.join(REPOSITORY_DIRECTORY, 'data/batches/m5-14-lexical-unit-source.json');

export const M5_14_BATCH_ID = 'm5-14-expansion-20260923';
export const M5_14_SLOT_BATCH_ID = 'm5-14';
export const M5_14_ISSUE = 100;
export const M5_14_PARENT_ISSUE = 7;
export const M5_14_SELECTION_COUNT = 1100;
export const M5_14_IMPORT_COUNT = 1000;
export const M5_14_RESERVE_COUNT = 100;
export const M5_14_FIRST_INVENTORY_NUMBER = 3101;
export const M5_14_FIRST_CANONICAL_NUMBER = 3181;
export const M5_14_GENERATION_PASS_ID = 'm5-14-generation-20260923-r1';
export const M5_14_VERIFICATION_PASS_ID = 'm5-14-agent-semantic-review-20260923-r1';
export const M5_14_CORRECTION_PASS_ID = 'm5-14-agent-semantic-correction-20260923-r1';
export const M5_14_CANDIDATE_SOURCE_ID = source.source_id;
export const M5_14_GENERATOR_VERSION = 'shared-lexical-producer-v5';
export const M5_14_SEMANTIC_REVIEW_VERSION = 'm5-14-authored-semantic-review-v1';
export const M5_14_CANDIDATE_SOURCE = Object.freeze(source);
export const M5_14_CANDIDATE_SOURCE_BYTES = readFileSync(SOURCE_PATH);

function materialize(options = {}) {
  return materializeLexicalUnitCandidates({
    batchId: M5_14_SLOT_BATCH_ID,
    source: M5_14_CANDIDATE_SOURCE,
    sourceBytes: M5_14_CANDIDATE_SOURCE_BYTES,
    firstInventoryNumber: M5_14_FIRST_INVENTORY_NUMBER,
    firstCanonicalNumber: M5_14_FIRST_CANONICAL_NUMBER,
    ...options,
  });
}

const initialMaterialization = materialize();

if (M5_14_CANDIDATE_SOURCE_ID !== 'm5-14-typewriter-authored-lexical-units-20260923-r1'
  || M5_14_CANDIDATE_SOURCE.generation_pass_id !== M5_14_GENERATION_PASS_ID
  || M5_14_CANDIDATE_SOURCE.candidate_count !== M5_14_SELECTION_COUNT
  || M5_14_CANDIDATE_SOURCE.units.length !== M5_14_SELECTION_COUNT
  || M5_14_CANDIDATE_SOURCE.candidate_count !== M5_14_IMPORT_COUNT + M5_14_RESERVE_COUNT
  || M5_14_CANDIDATE_SOURCE.candidate_buffer !== M5_14_RESERVE_COUNT) {
  throw new Error('M5-14 lexical-unit source is incomplete or outside the declared target/reserve pool');
}

export const M5_14_CANDIDATE_IDENTITIES = Object.freeze(initialMaterialization.identities);
export const M5_14_CATALOG = Object.freeze(M5_14_CANDIDATE_IDENTITIES.map((identity) => ({
  catalog_index: identity.catalog_index,
  slot_id: identity.slot_id,
  axis: identity.axis,
  flags: [...identity.flags],
})));

export function buildM514CandidateRecords({ baseRecords = [], baseSeedTargets = [] } = {}) {
  return materialize({ baseRecords, baseSeedTargets }).candidateRecords;
}

export function validateM514CandidateSourceBindings({ baseRecords = [], baseSeedTargets = [] } = {}) {
  return materialize({ baseRecords, baseSeedTargets });
}
