# Lite SQLite size and performance study (Issue #800)

Scope: the shipped Lite database `dist/dictionary.sqlite`. Full (`artifacts/dictionary.sqlite`), canonical, Meaning and
adjudication data are untouched. Measured on macOS arm64, Node 24.19, SQLite 3.51 (CLI) / 3.53 (`node:sqlite`).

## Baseline (Lite from `master` build before this change)

`dist/dictionary.sqlite`: 298,696,704 bytes (284.9 MiB), 4096-byte pages, 72,924 pages, gzip -6 110.7 MB.
Rows: 427,583 records, 496,874 search_forms, 317,908 generated_surface_forms, 482,125 meanings,
499,242 meaning_members, 167,011 meaning_relations.

Reproduce: `sqlite3 dist/dictionary.sqlite "select name, count(*), sum(pgsize)/1048576.0 from dbstat group by name order by 3 desc"`.

| Object | MiB |
| --- | ---: |
| meanings (table) | 70.5 |
| generated_surface_forms | 20.5 (+ autoindex 13.4 + idx 7.0) |
| records | 19.6 (+ autoindex 7.3 + idx_records_lemma 9.2) |
| meaning_members | 16.8 (+ 2 autoindexes 19.4 + idx_meaning_members_record 8.5) |
| meaning_relations | 14.3 (+ autoindexes 8.8 + idx_target 2.8) |
| search_forms | 13.5 (+ autoindex 9.1 + idx_search_forms_form 10.9) |
| idx_meanings_lemma / autoindexes / idx_meanings_record | 10.3 / 14.7 / 8.3 |

About 60 MiB are `sqlite_autoindex_*` btrees: with rowid tables, every composite or TEXT primary key is stored twice
(table + index). Page-internal slack is ~14 MiB.

## Candidates measured (independent experiments on copies)

| Candidate | Size | gzip -6 | Search / meaning-view latency | Verdict |
| --- | ---: | ---: | --- | --- |
| Baseline | 284.9 MiB | 105.5 MiB | 2.2 ms / 0.46 ms per record | – |
| `VACUUM` only | 270.9 MiB (−4.9 %) | – | unchanged | adopted |
| `WITHOUT ROWID` + `VACUUM` | 239.1 MiB (−16.1 %) | 77.8 MiB (−26 %) | 2.1 ms / 0.42 ms (same results) | adopted |
| further: drop `idx_meanings_record` | −9 MiB more | – | no runtime query uses it | not adopted (FK child index; <4 %) |

Latency is the in-process `node:sqlite` run of `findRecordsBySearchTerm` (10 terms) and `getMeaningRecord` (200
records × 3); outputs were byte-identical between baseline and variant. Peak memory scales with the fetched/deserialized
file size, so it falls with the file.

Not pursued (insufficient expected gain versus the invariants, or needs a design decision): removing
`meaning_members.record_id` (1,739 members differ from `meanings.record_id`, so it is not derivable), merging
`meaning_members` with source sense IDs (needed for duplicate redirects and source-ID compatibility), page-size changes
(no measurable gain with SQLite WASM in the extension), schema/format replacement.

## Adopted change

Product tables with composite/TEXT primary keys are declared `WITHOUT ROWID`, and Lite extraction ends with `VACUUM`.
Logical contents, queries, schema version and all validators are unchanged; nothing in the repository used `rowid`.

Note on figures: the candidate table was measured on copies of the pre-change `dist/dictionary.sqlite` (older
canonical revision `c03e97079e19`, 427,583 records); the real-build figures below use the current `master` canonical,
which differs slightly in content. That explains 239.1 MiB (candidate) versus 237.8 MiB (real build). The `VACUUM`
gain (−14 MiB, 4.9 %) was measured on the baseline file; the unit fixture is too small to show page slack, so its
compactness assertions are guards, not proof of the repack effect.

## Verification on the real build (current `master` canonical, 427,583 records)

Full built with `node scripts/build/dictionary.mjs`, Lite extracted twice with `extractLiteDictionary`:

- Lite 249,401,344 bytes (237.8 MiB), gzip -6 77.8 MiB; byte-identical (same SHA-1) across both extractions.
- `verifyLiteExtraction` (row-for-row digests of all 8 product tables against Full) passes; `verifyDatabase` integrity,
  foreign-key and count checks run inside the extraction.
- Search / meaning-view latency unchanged (~3 ms open+10 searches, ~0.35 ms per meaning view).
- Not run: browser/Chrome-for-Testing startup (no manifest, permission or WASM-loading change; same SQLite file format).
