# Meaning layer (Issue #713)

`data/canonical/` is the untouched STDICT source layer (`record -> sense -> relation`). Typewriter's editorial
**meaning** layer sits on top of it; this issue only provides the storage/validation foundation, not the bulk edit.

| Path | Content |
| --- | --- |
| `data/canonical/` | STDICT normalized source. Never modified by meaning work. |
| `data/meanings/` | Final meanings: `{ id, lemma, gloss, sense_ids }`. A meaning references one or more canonical senses that all have the meaning's lemma; the senses may belong to different records. |
| `data/adjudication/` | Editorial verdicts: `DROP duplicate` rows include `duplicate_of`; `DROP out_of_scope` rows omit it. |

The official DROP reasons are `duplicate` and `out_of_scope`. Meaning criteria are real meaning differences, not part
of speech. A dropped sense is never referenced by a meaning. For `duplicate`, `duplicate_of` must identify a different,
existing canonical sense of the same lemma that is not itself dropped. `out_of_scope` means the source sense is not part
of Typewriter's current product Meaning layer; it does not say the source entry lacks meaning or value, and it does not
remove or change the canonical source. It has no `duplicate_of` target. Every canonical sense remains covered by exactly
one Meaning or one DROP verdict. The `c20` mapping remains a placement rule, not a blanket exclusion rule; future senses
are adjudicated individually.

When relation projection is implemented, a `duplicate` target may be redirected through its `duplicate_of` sense.
An `out_of_scope` sense produces no product Meaning and cannot remain as a product relation endpoint. These rules define
the contract; relation projection, SQLite, and UI implementation are tracked separately.

## IDs
`w0097 -> m0097` for a lone meaning; several meanings use `m0097_1`, `m0097_2`, ... (a lone meaning and suffixed ones
never mix; numbers need not be contiguous). The ID's record is only an identifier base, not the sole record of the meaning's senses. When a
MERGE spans records, the ID's record number must be the lowest record number among the member senses (enforced by the dataset validator; the suffix is free); no new ID sequence is created.

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
has been applied and `data/canonical/` is untouched. Generate with `node scripts/meaning/initial.mjs` (fails closed before any write once editing has started — MERGE, edited gloss, adjudication or any divergence; `--force-reset-initial` is the explicit meaning-only recovery override and still refuses while `data/adjudication/` holds decisions)
(deterministic; a rerun is a no-op) and verify the untouched initial state once with `node scripts/meaning/initial.mjs --check` (a one-off check; it intentionally fails after editing begins). Once editing starts,
the projection is a historical baseline: `validateMeaningDataset({ complete: true })` (used by `validate.mjs` and the
`meaning-references` check) requires every canonical sense to be referenced by exactly one meaning or recorded as dropped.

## Relation projection and SQLite (Issue #717)
`scripts/meaning/project.mjs` projects the untouched STDICT sense relations onto meanings; it is a deterministic
transformation, not an editorial decision. A sense maps to the meaning listing it in `sense_ids`; a `duplicate` sense
is redirected through `duplicate_of` to the surviving meaning (as source or target). A relation whose endpoint is
`out_of_scope` (or has no meaning) is skipped, as is a relation that collapses onto a single meaning. The rest is
unique per `source meaning + target meaning + type`; every contributing sense relation is kept as provenance. The first
contributing relation (canonical order) supplies `note`/`relevance`; positions are per source meaning in that order.
Skip/dedup/redirect counts are written to `metadata` as `meaning_projection_*`, so
`source = projected + deduplicated + skipped`.

`dictionary.sqlite` (schema version 4) keeps the original source tables and adds the product meaning contract:

| Table | Content |
| --- | --- |
| `meanings` | `id`, `lemma`, `gloss` |
| `meaning_members` | `meaning_id`, `position`, `sense_id` (unique; FK to `senses`): source evidence of each meaning |
| `sense_adjudications` | dropped senses with `reason` and `duplicate_of_sense_id` |
| `meaning_relations` | `source_meaning_id`, `position`, `target_meaning_id`, `type`, `note`, `relevance`, `origin` |
| `meaning_relation_sources` | provenance: FK `(source_sense_id, source_position)` to the original `relations` row, plus redirect flags |

`meaning_relations.origin` is one of `stdict-sense-projection` or `typewriter-authored` (CHECK). Projected rows must have
complete, correctly bound `meaning_relation_sources`; Typewriter-authored relations (유의어, 반의어, 말의 결, 연상) are
edited on the same table with `origin='typewriter-authored'`, need no STDICT provenance, and may not own provenance rows
(a projected row relabelled as authored fails the projectable-relation and provenance-ownership checks). The sense
`relations` table stays the STDICT evidence layer. `getMeaningsByLemma` and `getMeaningRelations` in
`src/runtime/sqlite-query.js` are the shared meaning-based read helpers. The default canonical build requires the complete
meaning corpus and fails closed (`INVALID_MEANING_DATA`); builds from other canonical fixtures get an empty meaning layer
unless a meanings directory is passed.
