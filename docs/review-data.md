# Data Review

Use for canonical data, lexical/editorial schema, senses, relations, and
writer-facing classification or ranking.

Consult `domain-model.md` only when the change affects its contract.

Check:

- canonical data remains the editable source of truth;
- relation types honestly represent writer-facing meaning;
- `direct` is genuinely substitutable in the relevant sense;
- wider relations are not presented as equivalence;
- sense distinctions reflect actual use;
- grouping/ranking prioritizes useful results over noise;
- generated draft/confidence metadata is not treated as editorial truth.

Leave schema, references, duplicates, self-reference, missing targets, and
other mechanical integrity checks to validators/CI.

For large data changes, review changed editorial decisions and representative
samples rather than the full dataset.

Fix generation/model defects at the source instead of hand-patching generated
records.
