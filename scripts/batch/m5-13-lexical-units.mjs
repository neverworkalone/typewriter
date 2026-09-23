// Shared lexical producer input for M5-13.
//
// Every unit carries its own authored identity, record type, POS, and meaning.
// No metadata or definition is projected from an axis-level group.

import { M5_13_CATALOG } from './m5-13-catalog.mjs';
import { M5_13_AUTHORED_LEXICAL_UNITS } from './m5-13-lexical-authoring.mjs';

if (M5_13_AUTHORED_LEXICAL_UNITS.length !== M5_13_CATALOG.length) {
  throw new Error(
    `M5-13 authored lexical source has ${M5_13_AUTHORED_LEXICAL_UNITS.length} units; catalog has ${M5_13_CATALOG.length}`,
  );
}

export const M5_13_LEXICAL_UNIT_POOL = Object.freeze(
  M5_13_AUTHORED_LEXICAL_UNITS.map((unit, index) => {
    const catalogRow = M5_13_CATALOG[index];
    if (unit.axis !== catalogRow.axis) {
      throw new Error(`M5-13 authored unit ${unit.lemma} is not bound to catalog axis ${catalogRow.axis}`);
    }
    return Object.freeze({
      ...unit,
      flags: [...catalogRow.flags],
      source_kind: unit.record_type === 'expression'
        ? 'typewriter-authored-expression'
        : 'typewriter-authored-lexical-unit',
      writer_use: unit.writer_gloss,
    });
  }),
);

export const M5_13_LEXICAL_UNITS = M5_13_LEXICAL_UNIT_POOL;
