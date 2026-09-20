// Typewriter-authored M5-12 selection metadata.
//
// This catalog intentionally contains no lemma, POS, gloss, relation, or
// proposed canonical record body. Those values belong to a separately
// supplied editorial decision artifact and must not be invented by this
// pre-admission stage.

const CATALOG_GROUPS = Object.freeze([
  { count: 120, axis: 'E', flags: ['mood-range'] },
  { count: 120, axis: 'Q', flags: ['direct-boundary'] },
  { count: 120, axis: 'S', flags: ['sensory-transfer'] },
  { count: 120, axis: 'C', flags: ['scene-expansion'] },
  { count: 140, axis: 'A', flags: ['action-direction'] },
  { count: 100, axis: 'O', flags: ['direct-boundary'] },
  { count: 82, axis: 'X', flags: ['direct-boundary'] },
]);

const FIRST_CATALOG_INDEX = 0;
const FIRST_INVENTORY_NUMBER = 1085;
const EXPECTED_CATALOG_COUNT = 802;

let catalogIndex = FIRST_CATALOG_INDEX;
const catalogRows = [];
for (const group of CATALOG_GROUPS) {
  for (let offset = 0; offset < group.count; offset += 1) {
    catalogRows.push(Object.freeze({
      catalog_index: catalogIndex,
      inventory_id: `m5-${String(FIRST_INVENTORY_NUMBER + catalogIndex).padStart(4, '0')}`,
      axis: group.axis,
      flags: Object.freeze([...group.flags]),
    }));
    catalogIndex += 1;
  }
}

export const M5_12_CATALOG = Object.freeze(catalogRows);

const seenInventoryIds = new Set();
for (const entry of M5_12_CATALOG) {
  if (seenInventoryIds.has(entry.inventory_id)) {
    throw new Error(`duplicate M5-12 catalog inventory_id: ${entry.inventory_id}`);
  }
  seenInventoryIds.add(entry.inventory_id);
}

if (M5_12_CATALOG.length !== EXPECTED_CATALOG_COUNT) {
  throw new Error(
    `M5-12 catalog must contain exactly ${EXPECTED_CATALOG_COUNT} rows; got ${M5_12_CATALOG.length}`,
  );
}
