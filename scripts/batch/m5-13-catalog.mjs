// Typewriter-authored M5-13 selection metadata.
//
// This catalog declares capacity only.  It deliberately contains no lemma,
// POS, gloss, relation, or candidate record body; those values require a
// separately supplied, source-bound review artifact before admission.

const CATALOG_GROUPS = Object.freeze([
  { count: 160, axis: 'E', flags: ['mood-range'] },
  { count: 160, axis: 'Q', flags: ['direct-boundary'] },
  { count: 160, axis: 'S', flags: ['sensory-transfer'] },
  { count: 160, axis: 'C', flags: ['scene-expansion'] },
  { count: 180, axis: 'A', flags: ['action-direction'] },
  { count: 140, axis: 'O', flags: ['direct-boundary'] },
  { count: 140, axis: 'X', flags: ['direct-boundary'] },
]);

const FIRST_CATALOG_INDEX = 0;
const FIRST_SLOT_NUMBER = 1;
const EXPECTED_CATALOG_COUNT = 1100;

let catalogIndex = FIRST_CATALOG_INDEX;
const catalogRows = [];
for (const group of CATALOG_GROUPS) {
  for (let offset = 0; offset < group.count; offset += 1) {
    catalogRows.push(Object.freeze({
      catalog_index: catalogIndex,
      slot_id: `m5-13-slot-${String(FIRST_SLOT_NUMBER + catalogIndex).padStart(4, '0')}`,
      axis: group.axis,
      flags: Object.freeze([...group.flags]),
    }));
    catalogIndex += 1;
  }
}

export const M5_13_CATALOG = Object.freeze(catalogRows);

const seenSlotIds = new Set();
for (const entry of M5_13_CATALOG) {
  if (seenSlotIds.has(entry.slot_id)) {
    throw new Error(`duplicate M5-13 catalog slot_id: ${entry.slot_id}`);
  }
  seenSlotIds.add(entry.slot_id);
}

if (M5_13_CATALOG.length !== EXPECTED_CATALOG_COUNT) {
  throw new Error(
    `M5-13 catalog must contain exactly ${EXPECTED_CATALOG_COUNT} rows; got ${M5_13_CATALOG.length}`,
  );
}
