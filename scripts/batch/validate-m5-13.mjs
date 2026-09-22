import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { M5_13_CATALOG } from './m5-13-catalog.mjs';
import {
  M5_13_BASE_CANONICAL_SHA256,
  M5_13_BASE_INVENTORY_SHA256,
  M5_13_BASE_SEED_SHA256,
  M5_13_BASE_SUMMARY,
  M5_13_FINAL_SUMMARY,
  M5_13_TARGET,
  validateM513Final,
} from './m5-13-pipeline.mjs';

export {
  M5_13_BASE_CANONICAL_SHA256,
  M5_13_BASE_INVENTORY_SHA256,
  M5_13_BASE_SEED_SHA256,
  M5_13_BASE_SUMMARY,
  M5_13_FINAL_SUMMARY,
  M5_13_TARGET,
};

// Kept as a compatibility alias for callers that used the pre-admission name.
export {
  M5_13_BASE_INVENTORY_SHA256 as M5_13_GENERATED_INVENTORY_SHA256,
} from './m5-13-pipeline.mjs';

export class M513ValidationError extends Error {
  constructor(message, code = 'M5_13_VALIDATION_ERROR') {
    super(message);
    this.name = 'M513ValidationError';
    this.code = code;
  }
}

function fail(message, code = 'M5_13_VALIDATION_ERROR') {
  throw new M513ValidationError(message, code);
}

export function validateM513Catalog(catalog = M5_13_CATALOG) {
  if (!Array.isArray(catalog) || catalog.length !== M5_13_TARGET.selection_slot_count) {
    fail(`M5-13 catalog must contain ${M5_13_TARGET.selection_slot_count} capacity slots`, 'CATALOG_SHAPE_ERROR');
  }
  const expectedKeys = ['axis', 'catalog_index', 'flags', 'slot_id'];
  const seenSlots = new Set();
  for (const [index, entry] of catalog.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`M5-13 catalog row ${index} must be an object`, 'CATALOG_SHAPE_ERROR');
    }
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(expectedKeys)) {
      fail(`M5-13 catalog row ${index} has unbound fields`, 'CATALOG_SHAPE_ERROR');
    }
    if (entry.catalog_index !== index
      || entry.slot_id !== `m5-13-slot-${String(index + 1).padStart(4, '0')}`
      || seenSlots.has(entry.slot_id)
      || !/^[EQSCAOX]$/u.test(entry.axis)
      || !Array.isArray(entry.flags)
      || entry.flags.length === 0) {
      fail(`M5-13 catalog row ${index} is not deterministically bound`, 'CATALOG_SHAPE_ERROR');
    }
    seenSlots.add(entry.slot_id);
  }
  return { count: catalog.length };
}

// The common CI hook now validates the completed shared-producer promotion.
// The pre-admission boundary is represented by the durable base snapshot and
// the exact admission manifest, not by an unresolved manual-review placeholder.
export async function validateM513(options = {}) {
  return validateM513Final(options);
}

export { M5_13_CATALOG };

const isMainModule = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  validateM513()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.stack ?? error.message);
      process.exitCode = 1;
    });
}
