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
the former `meaningsDirectory` / `adjudicationDirectory` options are rejected with `REMOVED_OPTION`. The removed
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

The shipped (Lite) `dictionary.sqlite` (schema version 7) carries only the product meaning contract. The STDICT source `senses`, `relations` and
`meaning_relation_sources` tables exist only in the Full database `artifacts/dictionary.sqlite` (Issue #792, #795) and are never packaged:

| Table | Content |
| --- | --- |
| `meanings` | `id`, `lemma`, `gloss` (one source gloss per line), `record_id` (ID-base record), ranking metadata (below) |
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
verifies it with the self-contained `MEANING_INTEGRITY_QUERIES` (ranking, record binding). Package and runtime
validation use the same self-contained queries and additionally reject a database that is not labelled `lite` or ships
any `BUILD_ONLY_TABLES`; the CI shared artifact validation requires the Full kind.
`getMeaningsByLemma` and `getMeaningRelations` in `src/runtime/sqlite-query.js` are the shared meaning-based read helpers.
The default canonical build derives the meaning layer from canonical records and reads no other meaning input.
Builds from other canonical fixtures get an empty meaning layer unless `recordMeanings: true` is set.

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
