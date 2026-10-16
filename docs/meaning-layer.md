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
contributing relation (canonical order) supplies `note`/`relevance`, verified exactly against the first provenance row, whose position is checked against canonical order (record id, sense position, relation position); positions are per source meaning in that order (the first contributors of projected relations of one source meaning must increase with the position).
Skip/dedup/redirect counts are written to `metadata` as `meaning_projection_*`, so
`source = projected + deduplicated + skipped`.

`dictionary.sqlite` (schema version 6) ships only the product meaning contract. The STDICT source `senses`, `relations` and
`meaning_relation_sources` tables exist only in a build-time staging database (Issue #792) and are never packaged:

| Table | Content |
| --- | --- |
| `meanings` | `id`, `lemma`, `gloss`, `pos` (part of speech of the first member sense), `record_id` (ID-base record), ranking metadata (below) |
| `meaning_members` | `meaning_id`, `position`, `sense_id` (unique source sense ID, no FK), `record_id` (owner record of that sense) |
| `sense_adjudications` | dropped senses with `reason`, owner `record_id` and `duplicate_of_sense_id` (no FK) |
| `meaning_relations` | `source_meaning_id`, `position`, `target_meaning_id`, `type`, `note`, `relevance`, `origin` |
| `generated_surface_forms` | `form`, `record_id`, `sense_id`, `sense_position` (source sense position, for stable ordering), `rule_id` |

`meaning_relations.origin` is one of `stdict-sense-projection` or `typewriter-authored` (CHECK). Typewriter-authored
relations (유의어, 반의어, 말의 결, 연상) are edited on the same table with `origin='typewriter-authored'`.

`buildDictionary` first writes the staging database (`<output>.staging`, removed after the build unless `keepStaging` is
set) with the full source tables, and runs there the relation-projection and provenance checks of
`scripts/build/meaning-source-checks.mjs` (complete, correctly bound and ordered provenance; note/relevance equal to the
first contributing source relation; the denormalized `meaning_members.record_id`, `meanings.pos`,
`sense_adjudications.record_id` and `generated_surface_forms.sense_position` equal the source senses'). Only after those
pass does it copy the product tables, in primary-key order, into the shipped database and verify it again with the
self-contained `MEANING_INTEGRITY_QUERIES` (ranking, record binding). Package, shared-artifact and runtime validation
use the same self-contained queries and additionally reject a database that ships any `BUILD_ONLY_TABLES`.
`getMeaningsByLemma` and `getMeaningRelations` in `src/runtime/sqlite-query.js` are the shared meaning-based read helpers.
The default canonical build requires the complete meaning corpus and fails closed (`INVALID_MEANING_DATA`); builds from
other canonical fixtures get an empty meaning layer unless a meanings directory is passed.

## Search, ranking and 더보기 (Issue #718)
The search candidate unit is the meaning; raw STDICT senses are never listed or shipped, their IDs stay in
`meaning_members` as evidence. `getMeaningRecord` (`get-meaning-record`) is the only record read of the runtime: it returns a record
whose `senses` are the meanings it contributes member senses to, with meaning gloss, meaning relations and ranking
counts (the former raw `getRecord` / `getSenseRelations` APIs were removed with the source tables). Relation targets open the target meaning (its `record_id` plus the meaning ID).

Ranking metadata is computed once at build time (`scripts/build/dictionary.mjs`) and stored in `meanings`:

| Column | Content |
| --- | --- |
| `lexical_relation_count` | distinct targets of `direct` + `antonym` (유의어 + 반의어) |
| `exploratory_relation_count` | distinct targets of `near`, `mood`, `scene`, `sensory`, `action`, `association` (말의 결 + 연상) |
| `display_rank` | dense unique order: lexical DESC, exploratory DESC, numeric meaning ID |

The build verification, `validatePackagedDictionary` and `validate-package` re-derive the counts and check the rank
order (`MEANING_INTEGRITY_QUERIES`). The partition rule lives in `src/runtime/meaning-ranking.js`
(`partitionMeanings`): meanings with at least one relation fill the default view in rank order up to 3; the rest,
including every meaning without relations, go behind 더보기. If no meaning of the result has a relation, the lowest-ID
meaning is shown and the rest go behind 더보기. The UI shows the default candidates and a 더보기 control for the rest.

The default view and the candidate list use one search-wide ranking: when several records match (for example one
surface form reaching several lemmas), the split into at most 3 default meanings and 더보기 is made once over all of
their meanings, candidates are listed in `compareMeaningRank` order regardless of record or input order, and the first
selection is the top-ranked meaning. Each candidate keeps its record and match.
