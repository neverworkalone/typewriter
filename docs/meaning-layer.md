# Meaning layer (Canonical-only)

`data/canonical/` is the untouched STDICT source layer (`record -> sense -> relation`) and the only input of the product
dictionary. The product **meaning** tables are generated from it on every build (Issues #820, #822); there is no
separately maintained, edited or adjudicated Meaning data.

**Contract: one STDICT record is one meaning (search candidate); every sense of that record is a member of it, in
canonical order.** Polysemy is the several glosses inside one record; homonyms are different records of the same
lemma and are separate candidates. Nothing is split, merged across records, reworded or dropped. The meaning `gloss`
holds the record's source glosses verbatim, one per line; the UI shows each as a numbered definition inside the one
selected candidate. The product (Lite) database ships no part of speech; the source `senses.pos` exists only in Full.

Source of truth in code: `scripts/build/record-meanings.mjs` (`wN -> mN` ids, `projectRecordMeanings`,
`projectMeaningRelations`, and the test oracle for relation provenance). `buildDictionary` takes no meaning input;
the former `meaningsDirectory` / `adjudicationDirectory` options are rejected with `REMOVED_OPTION`, and the official canonical input rejects `recordMeanings: false` (`RECORD_MEANINGS_REQUIRED`). The projected Full database is checked by `RECORD_MEANING_COVERAGE_QUERIES` (every sense in exactly one meaning of its own record, one meaning per record with senses), at build time and in the shared-artifact validation of the official corpus. The removed
`data/meanings/`, `data/adjudication/` and `scripts/meaning/` editing layer is inventoried in
[`legacy-meaning-removal-issue-822.md`](legacy-meaning-removal-issue-822.md); [`canonical-only-db-issue-820.md`](canonical-only-db-issue-820.md)
records the transition audit.

Shared invariants (Normal CI, applied to the whole canonical corpus and future records):
`tests/canonical-record-meanings.test.mjs` (every sense in exactly one meaning of its own record, source order and
gloss round trip, candidates per lemma == records per lemma), `tests/record-meaning-projection.test.mjs` (ids,
projection table, fail-closed controls, relation projection vs. an independent oracle),
`tests/meaning-provenance.test.mjs` (relation provenance binding) and `tests/meaning-search.test.mjs` (ranking and 더보기).

## IDs
`w0097 -> m0097`, always, independent of the sense count. The ID's record is the meaning's only record.

## Relation projection and SQLite (Issue #717)
`projectMeaningRelations` (`scripts/build/record-meanings.mjs`) projects the untouched STDICT sense relations onto
meanings; it is a deterministic transformation, not an editorial decision. A sense maps to the meaning listing it in
`sense_ids`. A relation whose endpoint has no meaning is skipped, as is a relation that collapses onto a single
meaning (a self link inside one record). The rest is
unique per `source meaning + target meaning + type`; every contributing sense relation is kept as provenance. The first
contributing relation (canonical order) supplies `note`/`relevance`, verified exactly against the first provenance row, whose position is checked against canonical order (record id, sense position, relation position); positions are per source meaning in that order (the first contributors of projected relations of one source meaning must increase with the position).
Skip/dedup/redirect counts are written to `metadata` as `meaning_projection_*`, so
`source = projected + deduplicated + skipped`.

The shipped (Lite) `dictionary.sqlite` (schema version 8) carries only the product meaning contract. The STDICT source `senses`, `relations` and
`meaning_relation_sources` tables exist only in the Full database `artifacts/dictionary.sqlite` (Issue #792, #795) and are never packaged:

| Table | Content |
| --- | --- |
| `meanings` | `id`, `lemma`, `gloss` (one source gloss per line), `record_id` (ID-base record), `homograph_no` (nullable STDICT homograph number, below) |
| `meaning_members` | `meaning_id`, `position`, `sense_id` (unique source sense ID, no FK), `record_id` (owner record of that sense) |
| `sense_adjudications` | legacy table kept for the runtime contract; always empty in the canonical-only build (dropping it is a separate optimisation) |
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
The default canonical build derives the meaning layer from canonical records and reads no other meaning input.
Builds from other canonical fixtures get an empty meaning layer unless `recordMeanings: true` is set.

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

