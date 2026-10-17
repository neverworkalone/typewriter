# Meaning layer (Issue #713)

`data/canonical/` is the untouched STDICT source layer (`record -> sense -> relation`). Typewriter's editorial
**meaning** layer sits on top of it; this issue only provides the storage/validation foundation, not the bulk edit.

> **Current product build (Issue #820).** The default Full/Lite build no longer reads `data/meanings/` or
> `data/adjudication/`. It derives the product meanings from `data/canonical/` alone: **one STDICT record is one
> meaning (search candidate)** and every sense of that record is a member, in canonical order
> (`scripts/meaning/canonical-record.mjs`, see [`canonical-only-db-issue-820.md`](canonical-only-db-issue-820.md)).
> The meaning `gloss` holds the record's source glosses verbatim, one per line; the UI shows each as a numbered
> definition inside the one selected candidate. Same-lemma records remain separate homonym candidates. The sections
> below describe the stored Meaning data contract (`data/meanings/`, `data/adjudication/`), which is preserved
> unchanged as a legacy layer: it is still validated by the `meaning-references` check and is only used by a build
> when a meanings directory is passed explicitly. Where they mention reviewed meanings feeding the product database,
> read them as that legacy layer.

| Path | Content |
| --- | --- |
| `data/canonical/` | STDICT normalized source. Never modified by meaning work. |
| `data/meanings/` | Final meanings: `{ id, lemma, gloss, sense_ids }`. A meaning references one or more canonical senses that all have the meaning's lemma; the senses may belong to different records. |
| `data/adjudication/` | Editorial verdicts: `DROP duplicate` rows include `duplicate_of`; `DROP out_of_scope` rows omit it. |

The official DROP reasons are `duplicate` and `out_of_scope`. Meaning criteria are real meaning differences, not part
of speech. (The product database carries no part of speech; the source `senses.pos` exists only in Full.) A dropped sense is never referenced by a meaning. For `duplicate`, `duplicate_of` must identify a different,
existing canonical sense of the same lemma that is not itself dropped. `out_of_scope` means the source sense is not part
of Typewriter's current product Meaning layer; it does not say the source entry lacks meaning or value, and it does not
remove or change the canonical source. It has no `duplicate_of` target. Every canonical sense remains covered by exactly
one Meaning or one DROP verdict. The `c20` mapping remains a placement rule, not a blanket exclusion rule; future senses
are adjudicated individually.

When relation projection is implemented, a `duplicate` target may be redirected through its `duplicate_of` sense.
An `out_of_scope` sense produces no product Meaning and cannot remain as a product relation endpoint. These rules define
the contract; relation projection, SQLite, and UI implementation are tracked separately.

## IDs
(Canonical-only build, Issue #820: always `wN -> mN`, one meaning per record regardless of its sense count; the suffixed form below belongs to the legacy `data/meanings/` layer.)
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

The shipped (Lite) `dictionary.sqlite` (schema version 7) carries only the product meaning contract. The STDICT source `senses`, `relations` and
`meaning_relation_sources` tables exist only in the Full database `artifacts/dictionary.sqlite` (Issue #792, #795) and are never packaged:

| Table | Content |
| --- | --- |
| `meanings` | `id`, `lemma`, `gloss` (one source gloss per line), `record_id` (ID-base record), `homograph_no` (nullable STDICT homograph number, below) |
| `meaning_members` | `meaning_id`, `position`, `sense_id` (unique source sense ID, no FK), `record_id` (owner record of that sense) |
| `sense_adjudications` | dropped senses with `reason`, owner `record_id` and `duplicate_of_sense_id` (no FK) |
| `meaning_relations` | `source_meaning_id`, `position`, `target_meaning_id`, `type`, `note`, `relevance`, `origin` |
| `generated_surface_forms` | `form`, `record_id`, `sense_id`, `sense_position` (source sense position, for stable ordering), `rule_id` |

`meaning_relations.origin` is one of `stdict-sense-projection` or `typewriter-authored` (CHECK). Typewriter-authored
relations (유의어, 반의어, 말의 결, 연상) are edited on the same table with `origin='typewriter-authored'`.

`buildDictionary` writes the Full database (`artifacts/dictionary.sqlite`) with the source tables and runs there the
relation-projection and provenance checks of `scripts/build/meaning-source-checks.mjs` (complete, correctly bound and
ordered provenance; note/relevance equal to the first contributing source relation; the denormalized
`meaning_members.record_id`, `sense_adjudications.record_id` and
`generated_surface_forms.sense_position` equal the source senses'). The extension build then re-verifies the Full
database, copies only the product tables, in primary-key order, into the Lite database (`extractLiteDictionary`) and
verifies it with the self-contained `MEANING_INTEGRITY_QUERIES` (record binding). Package and runtime
validation use the same self-contained queries and additionally reject a database that is not labelled `lite` or ships
any `BUILD_ONLY_TABLES`; the CI shared artifact validation requires the Full kind.
`getMeaningsByLemma` and `getMeaningRelations` in `src/runtime/sqlite-query.js` are the shared meaning-based read helpers.
The default canonical build derives the meaning layer from canonical records (Issue #820) and reads no meaning or adjudication data;
building with an explicitly passed meanings directory uses the legacy layer, which must be complete (`INVALID_MEANING_DATA` otherwise).
Builds from other canonical fixtures get an empty meaning layer unless a meanings directory is passed or `recordMeanings: true` is set.

## Search order and 더보기 (Issues #718, #828)
The search candidate unit is the meaning; raw STDICT senses are never listed or shipped, their IDs stay in
`meaning_members` as evidence. `getMeaningRecord` (`get-meaning-record`) is the only record read of the runtime: it returns a record
whose `senses` are the meanings it contributes member senses to, with meaning gloss, meaning relations and the meaning's
`homograph_no` (the former raw `getRecord` / `getSenseRelations` APIs were removed with the source tables). Relation targets open the target meaning (its `record_id` plus the meaning ID).

Candidates follow the 표준국어대사전 compilation order, never a relation count. The only order information the source carries
is the homograph number of the headword (`각본01`, `각본02`, …); `target_code` is **not** ordered by it. The converter keeps that
number as the optional canonical field `homograph_no` (integer 1..99, `scripts/stdict/convert.mjs`, `homographNumber`), the build copies
it to `meanings.homograph_no` (nullable), and the UI never shows it. Because it lives in the versioned canonical shards, a clean
checkout rebuilds Canonical → Full → Lite without the STDICT source. No relation count, rank or "more" count is stored.

Fallback (`compareMeaningOrder` in `src/runtime/meaning-order.js`): meanings of one lemma sort by `homograph_no` ascending, a meaning
without a number after the numbered ones, and equal or missing numbers (for example two source headwords that normalise to one lemma,
or a headword with no suffix) by the numeric meaning ID. The ID order is a stable tie-break and is not claimed to be the source order.

Default view and 더보기: one search lists its lemmas in the existing match order (match tier, then record order) and each lemma's
meanings in STDICT order. The first three candidates of the whole search are shown; with four or more, 더보기 reveals all the rest
and can be collapsed again (`partitionCandidates`). The first selection is the first candidate. A meaning's definitions
(`gloss`, one source sense per line) are shown the same way: the first three, then 뜻풀이 더보기 for all the others and 뜻풀이 접기; the
two states are independent and are dropped when the result or the selected candidate changes. Relation groups keep their own
relevance order and the 20-per-round (up to 100) paging.

