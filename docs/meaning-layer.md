# Meaning layer (Issue #713)

`data/canonical/` is the untouched STDICT source layer (`record -> sense -> relation`). Typewriter's editorial
**meaning** layer sits on top of it; this issue only provides the storage/validation foundation, not the bulk edit.

| Path | Content |
| --- | --- |
| `data/canonical/` | STDICT normalized source. Never modified by meaning work. |
| `data/meanings/` | Final meanings: `{ id, lemma, gloss, sense_ids }`. A meaning references one or more senses of **one** entry. |
| `data/adjudication/` | Editorial verdicts: `{ sense_id, lemma, decision: "drop", reason: "duplicate", duplicate_of }`. |

Only the `duplicate` drop reason is official; add others per concrete case. Meaning criteria are real meaning
differences, not part of speech. A dropped sense is never referenced by a meaning, and `duplicate_of` must not itself be dropped.

## IDs
`w0097 -> m0097` for a lone meaning; several meanings use `m0097_1`, `m0097_2`, ... (a lone meaning and suffixed ones
never mix; numbers need not be contiguous).

## Shards
Files are `cXX_NNN.jsonl` (`NNN` from `001`, contiguous per `cXX`). `cXX` comes from the lemma's Hangul initial via the
explicit table in `scripts/meaning/contract.mjs` (`c01` ㄱ … `c19` ㅎ; `c20` for non-Hangul starts). Shards hold about
1,000 rows, close only on a lemma boundary, and rows are ordered by lemma then id. Parallel ownership is a whole `cXX`
(all its shards). `meaning` and `adjudication` use the same naming under their own directories.

## API
`scripts/meaning/contract.mjs`: `writeMeanings/readMeanings`, `writeAdjudications/readAdjudications`,
`validateMeaningDataset` (optionally against canonical senses), `loadMeaningData`. Run `node scripts/meaning/validate.mjs`.
Tests: `node --test scripts/meaning/contract.test.mjs`.
