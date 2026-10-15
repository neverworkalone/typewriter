# Meaning layer (Issue #713)

`data/canonical/` is the untouched STDICT source layer (`record -> sense -> relation`). Typewriter's editorial
**meaning** layer sits on top of it; this issue only provides the storage/validation foundation, not the bulk edit.

| Path | Content |
| --- | --- |
| `data/canonical/` | STDICT normalized source. Never modified by meaning work. |
| `data/meanings/` | Final meanings: `{ id, lemma, gloss, sense_ids }`. A meaning references one or more canonical senses that all have the meaning's lemma; the senses may belong to different records. |
| `data/adjudication/` | Editorial verdicts: `{ sense_id, lemma, decision: "drop", reason: "duplicate", duplicate_of }`. |

Only the `duplicate` drop reason is official; add others per concrete case. Meaning criteria are real meaning
differences, not part of speech. A dropped sense is never referenced by a meaning, and `duplicate_of` must be an existing canonical sense of the
same lemma, different from the dropped sense, and not itself dropped. A MERGE (different meanings of one lemma folded into one) and a DROP
`duplicate` (the same source sense repeated) are separate verdicts.

## IDs
`w0097 -> m0097` for a lone meaning; several meanings use `m0097_1`, `m0097_2`, ... (a lone meaning and suffixed ones
never mix; numbers need not be contiguous). The ID's record is only an identifier base, not the sole record of the meaning's senses. When a
MERGE spans records, keep the ID of the member sense with the lowest (record number, sense number); no new ID sequence is created.

## Shards
Files are `cXX_NNN.jsonl` (`NNN` from `001`, contiguous per `cXX`). `cXX` comes from the lemma's Hangul initial via the
explicit table in `scripts/meaning/contract.mjs` (`c01` ㄱ … `c19` ㅎ; `c20` for lemmas starting with neither a Hangul syllable nor a bare initial jamo such as `ㄱ`). Shards hold about
1,000 rows, close only on a lemma boundary, and rows are ordered by lemma then id (enforced by the reader across shards of one `cXX`).
`cXX` is only a data placement area. `meaning` and `adjudication` use the same naming under their own directories.

## API
`scripts/meaning/contract.mjs`: `writeMeanings/readMeanings`, `writeAdjudications/readAdjudications`,
`validateMeaningDataset` (optionally against canonical senses), `loadMeaningData`. Run `node scripts/meaning/validate.mjs`.
Tests: `node --test scripts/meaning/contract.test.mjs`. The contract test (fixtures and single canonical shards only) and the in-process `meaning-references` check are Normal, always-on CI checks; the latter validates stored meanings against the session's already-loaded canonical context (no extra canonical read), so canonical-only changes are checked against stored meanings. `validate.mjs` is the standalone equivalent and reads canonical only when meaning data exists.

## Initial corpus (Issue #714)
`data/meanings/` holds the mechanical initial projection of the whole canonical layer: every sense of every record
(`entry` and `expression`) becomes its own meaning with the canonical gloss and a single `sense_ids` entry. A one-sense
record maps `wNNN -> mNNN`; a multi-sense record maps `wNNN-sK -> mNNN_K` (K is the sense's own number). No MERGE/DROP
has been applied and `data/canonical/` is untouched. Regenerate with `node scripts/meaning/initial.mjs`
(deterministic; a rerun is a no-op) and verify the untouched initial state once with `node scripts/meaning/initial.mjs --check` (a one-off check; it intentionally fails after editing begins). Once editing starts,
the projection is a historical baseline: `validateMeaningDataset({ complete: true })` (used by `validate.mjs` and the
`meaning-references` check) requires every canonical sense to be referenced by exactly one meaning or recorded as dropped.
