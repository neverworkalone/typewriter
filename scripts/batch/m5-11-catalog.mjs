// Typewriter-authored M5-11 selection metadata.
//
// This tracked catalog identifies the bounded candidate pool and its editorial
// axes only.  It deliberately contains no unreviewed lemma, POS, gloss, or
// proposed canonical record body.  A separately supplied human-complete
// decision artifact carries any semantic proposal that is admitted later and
// is bound to this catalog by digest and count.

const CATALOG_GROUPS = Object.freeze([
  { count: 80, axis: 'E', flags: ['mood-range'] },
  { count: 80, axis: 'Q', flags: ['direct-boundary'] },
  { count: 80, axis: 'S', flags: ['sensory-transfer'] },
  { count: 80, axis: 'C', flags: ['scene-expansion'] },
  { count: 100, axis: 'A', flags: ['action-direction'] },
  { count: 70, axis: 'O', flags: ['direct-boundary'] },
  { count: 50, axis: 'X', flags: ['direct-boundary'] },
  { count: 10, axis: 'X', flags: ['expression-unit'] },
]);

let catalogIndex = 0;
const catalogRows = [];
for (const group of CATALOG_GROUPS) {
  for (let offset = 0; offset < group.count; offset += 1) {
    catalogRows.push(Object.freeze({
      catalog_index: catalogIndex,
      inventory_id: `m5-${String(535 + catalogIndex).padStart(3, '0')}`,
      axis: group.axis,
      flags: Object.freeze([...group.flags]),
    }));
    catalogIndex += 1;
  }
}

export const M5_11_CATALOG = Object.freeze(catalogRows);

const seenInventoryIds = new Set();
for (const entry of M5_11_CATALOG) {
  if (seenInventoryIds.has(entry.inventory_id)) {
    throw new Error(`duplicate M5-11 catalog inventory_id: ${entry.inventory_id}`);
  }
  seenInventoryIds.add(entry.inventory_id);
}

if (M5_11_CATALOG.length !== 550) {
  throw new Error(`M5-11 catalog must contain exactly 550 rows; got ${M5_11_CATALOG.length}`);
}
