# Canonical-only DB transition trial (Issue #820)

Invariant: **one STDICT record is one product meaning (search candidate); all `senses[]` of that record are members of
it, in canonical order.** No sense is split off, no record is merged with another, and no `data/meanings` or
`data/adjudication` file is read by the default build.

## What changed

- `scripts/meaning/canonical-record.mjs` projects `record -> meaning` (`wN -> mN`, deterministic, independent of the
  sense count). The meaning `gloss` column stores the record's source glosses verbatim, one per line.
- `scripts/build/dictionary.mjs` uses that projection for the default canonical input (and for fixtures with
  `recordMeanings: true`). The legacy reviewed-Meaning layer is only loaded when `meaningsDirectory` is passed
  explicitly. Relations still go through the shared `projectMeaningRelations` (self-link skip, dedup, provenance).
- UI: `projectDefinition` turns the stored lines into one definition item per source gloss; the result card numbers them
  (①②…) when there is more than one, and the candidate picker shows the first gloss. Candidates are records.
- Schema: `meanings`/`meaning_members` are reused as the record based tables, `sense_adjudications` stays empty.
  Owner decision: **the product (Lite) database carries no part of speech.** `meanings.pos` is removed (schema
  version 7), together with its UI/query consumers; source `senses.pos` stays in the Full database only, and the Full
  integrity checks keep binding every member to its source sense.
- `data/meanings/`, `data/adjudication/`, #764 specs and the #814/#816 reports are untouched.

## Contract checks

`tests/canonical-record-meanings.test.mjs` (Normal tier) covers the whole canonical corpus (each sense in exactly one
meaning of its own record, source order, gloss round trip, candidates per lemma == records per lemma), a table over
record shapes, and a fixture build with no Meaning input (`가랑가랑` 3 candidates with 4/2/1 definitions, `배`,
relation projection/dedup/provenance). The existing source-bound Full integrity queries and Lite verification run on
the new build unchanged.

## Audit: legacy Meaning layer vs canonical-only (full corpus, this PR's build)

| | legacy (`data/meanings`) | canonical-only |
|---|---|---|
| records / senses | 427,583 / 499,359 | 427,583 / 499,359 |
| meanings (candidates) | 434,103 | 427,583 |
| meaning members | 499,226 | 499,359 |
| adjudicated senses | 133 | 0 |
| records with >1 candidate | 8,697 | 0 |
| lemmas with >1 candidate | 37,636 | 34,801 |
| projected meaning relations | 162,371 | 161,743 |
| relation sources (provenance) | 168,175 | 168,395 (= all source relations) |
| redirected / self-skipped | 44 / 220 | 0 / 0 |
| Full / Lite size (bytes) | 419,741,696 / 243,838,976 | 418,443,264 / 242,802,688 |

Intended differences: multi-sense records are one candidate; the 133 adjudicated (duplicate/out-of-scope) senses are
now ordinary members; relations that were self links only after Meaning grouping now stay as links between distinct
records or collapse into one deduplicated relation. Part of speech (including the 2,582 records whose senses differ) is intentionally not shipped in Lite.

Not verified here: real-browser popup run (component-level and DB-level checks only).
