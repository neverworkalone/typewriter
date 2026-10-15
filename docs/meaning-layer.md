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
explicit table in `scripts/meaning/contract.mjs` (`c01` ㄱ … `c19` ㅎ; `c20` for lemmas starting with neither a Hangul syllable nor a bare initial jamo such as `ㄱ`). Shards hold about
1,000 rows, close only on a lemma boundary, and rows are ordered by lemma then id (enforced by the reader across shards of one `cXX`). Parallel ownership is a whole `cXX`
(all its shards). `meaning` and `adjudication` use the same naming under their own directories.

## API
`scripts/meaning/contract.mjs`: `writeMeanings/readMeanings`, `writeAdjudications/readAdjudications`,
`validateMeaningDataset` (optionally against canonical senses), `loadMeaningData`. Run `node scripts/meaning/validate.mjs`.
Tests: `node --test scripts/meaning/contract.test.mjs`. The contract test (fixtures and single canonical shards only) and the in-process `meaning-references` check are Normal, always-on CI checks; the latter validates stored meanings against the session's already-loaded canonical context (no extra canonical read), so canonical-only changes are checked against stored meanings. `validate.mjs` is the standalone equivalent and reads canonical only when meaning data exists.

## Initial corpus (Issue #714)
`data/meanings/` holds the mechanical initial projection of the whole canonical layer: every sense of every record
(`entry` and `expression`) becomes its own meaning with the canonical gloss and a single `sense_ids` entry. A one-sense
record maps `wNNN -> mNNN`; a multi-sense record maps `wNNN-sK -> mNNN_K` (K is the sense's own number). No MERGE/DROP
has been applied and `data/canonical/` is untouched. Generate with `node scripts/meaning/initial.mjs` (fails closed before any write once editing has started — MERGE, edited gloss, adjudication or any divergence; `--force-reset-initial` is the explicit recovery override)
(deterministic; a rerun is a no-op) and verify the untouched initial state once with `node scripts/meaning/initial.mjs --check` (a one-off check; it intentionally fails after editing begins). Once editing starts,
the projection is a historical baseline: `validateMeaningDataset({ complete: true })` (used by `validate.mjs` and the
`meaning-references` check) requires every canonical sense to be referenced by exactly one meaning or recorded as dropped.
