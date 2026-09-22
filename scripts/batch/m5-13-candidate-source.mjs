import source from '../../data/batches/m5-13-lexical-unit-source.json' with { type: 'json' };
import { M5_13_CATALOG } from './m5-13-catalog.mjs';

// M5-13 consumes an explicit Typewriter-authored lexical-unit artifact. A unit
// is already a writer-facing lemma or expression; the producer does not
// synthesize a root x focus Cartesian product.

export const M5_13_BATCH_ID = 'm5-13-expansion-20260922';
export const M5_13_ISSUE = 99;
export const M5_13_PARENT_ISSUE = 7;
export const M5_13_SELECTION_COUNT = 1100;
export const M5_13_IMPORT_COUNT = 1000;
export const M5_13_RESERVE_COUNT = 100;
export const M5_13_FIRST_INVENTORY_NUMBER = 2001;
export const M5_13_FIRST_CANONICAL_NUMBER = 2081;
export const M5_13_GENERATION_PASS_ID = 'm5-13-generation-20260922-r3';
export const M5_13_VERIFICATION_PASS_ID = 'm5-13-agent-semantic-review-20260922-r3';
export const M5_13_CANDIDATE_SOURCE_ID = 'm5-13-typewriter-authored-lexical-units-20260922-r3';
export const M5_13_GENERATOR_VERSION = 'shared-lexical-producer-v3';
export const M5_13_SEMANTIC_REVIEW_VERSION = 'm5-13-authored-semantic-review-v3';
export const M5_13_CANDIDATE_SOURCE = Object.freeze(source);

function sourceBasis(unit, catalogRow) {
  return {
    source_id: M5_13_CANDIDATE_SOURCE_ID,
    source_artifact_sha256: source.artifact_sha256,
    source_unit_id: unit.source_unit_id,
    source_material: 'Typewriter-authored lexical unit source',
    identity_kind: 'explicit-lexical-unit',
    lexical_unit: unit.lemma,
    writer_use: unit.writer_use,
    writer_gloss: unit.writer_gloss,
    source_kind: unit.source_kind,
    source_position: {
      source_unit_index: source.units.indexOf(unit),
      catalog_index: catalogRow.catalog_index,
    },
  };
}
function makeIdentity(catalogRow, unit) {
  if (catalogRow.axis !== unit.axis) {
    throw new Error(`M5-13 catalog axis ${catalogRow.axis} is not bound to lexical unit axis ${unit.axis}`);
  }
  return {
    catalog_index: catalogRow.catalog_index,
    slot_id: catalogRow.slot_id,
    inventory_id: `m5-${String(M5_13_FIRST_INVENTORY_NUMBER + catalogRow.catalog_index).padStart(4, '0')}`,
    candidate_record_id: `w${String(M5_13_FIRST_CANONICAL_NUMBER + catalogRow.catalog_index).padStart(4, '0')}`,
    lemma: unit.lemma,
    axis: unit.axis,
    flags: [...catalogRow.flags],
    record_type: unit.record_type,
    pos: unit.pos,
    source_kind: unit.source_kind,
    writer_gloss: unit.writer_gloss,
    source_basis: sourceBasis(unit, catalogRow),
  };
}

if (source.source_id !== M5_13_CANDIDATE_SOURCE_ID
  || source.candidate_count !== M5_13_SELECTION_COUNT
  || source.units.length !== M5_13_SELECTION_COUNT
  || source.artifact_sha256 === undefined) {
  throw new Error('M5-13 lexical-unit source artifact is incomplete');
}

export const M5_13_CANDIDATE_IDENTITIES = Object.freeze(
  M5_13_CATALOG.map((catalogRow, index) => makeIdentity(catalogRow, source.units[index])),
);

function makeCandidateRecord(identity) {
  return {
    id: identity.candidate_record_id,
    record_type: identity.record_type,
    role: 'start',
    candidate_id: identity.candidate_record_id,
    lemma: identity.lemma,
    search_forms: [identity.lemma],
    senses: [{
      id: `${identity.candidate_record_id}-s1`,
      pos: identity.pos,
      gloss: identity.writer_gloss,
    }],
  };
}

// Shared producer entry point used by the M5-13 pipeline. It materializes
// source-bound units; it does not generate semantic combinations.
export function buildM513CandidateRecords(identities = M5_13_CANDIDATE_IDENTITIES) {
  return identities.map(makeCandidateRecord);
}

const identityKeys = new Set();
for (const identity of M5_13_CANDIDATE_IDENTITIES) {
  for (const key of ['slot_id', 'inventory_id', 'candidate_record_id', 'lemma']) {
    if (identityKeys.has(`${key}:${identity[key]}`)) throw new Error(`duplicate M5-13 ${key}: ${identity[key]}`);
    identityKeys.add(`${key}:${identity[key]}`);
  }
  if (identity.lemma.normalize('NFC') !== identity.lemma) throw new Error(`M5-13 lemma is not NFC: ${identity.lemma}`);
}
