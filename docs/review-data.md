# Data Review

Use for canonical data, lexical/editorial schema, senses, relations, and
writer-facing classification or ranking.

Consult `domain-model.md` only when the change affects its contract.

Check:

- canonical data remains the editable source of truth;
- review gloss, `direct`, and `antonym` with dictionary-grade precision;
- review `near`, `mood`, `scene`, `sensory`, `action`, and `association` for
  honest type and sense binding while allowing plausible subjective routes;
- `direct` is genuinely substitutable in the relevant sense, and wider
  relations are not presented as equivalence;
- sense distinctions reflect actual use;
- relation enrichment does not gate lexical admission;
- grouping/ranking prioritizes useful results over noise;
- generated draft/confidence metadata is not treated as editorial truth.

Leave schema, references, duplicates, self-reference, missing targets, and
other mechanical integrity checks to validators/CI.

Fix generation/model defects at the source instead of hand-patching generated
records.
