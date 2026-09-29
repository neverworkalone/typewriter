# Issue #212 — Final coverage audit and corpus handoff

Audit date: 2026-09-29

Canonical revision: `98264ef2163ea9eb43a759978766aefa090a21d8bc8cf7b5c9c9dd47f5cdfe34`

## Decision

The operative invariant is: **every valid lexical record within Typewriter's
supported scope may be reached by direct search, regardless of its historical
`start` or `reference-only` role.** Relation enrichment and writer-task quality
remain separate from lexical admission and search reachability.

The final audit reconciles current canonical coverage, historical recovery
dispositions, shared producer/runtime regressions, and the M1–M8 contracts.
Issues #210 and #211 provide the candidate inventory and bounded recovery
evidence. This issue closes that policy handoff; it does not admit more records,
start a larger corpus batch, or authorize publication.

## Current canonical coverage

Counts below come from all 15 canonical JSONL files at the revision above.
`start` and `reference-only` are reported as historical workflow metadata, not
search-eligibility classes.

| Measure | Current count | Meaning |
| --- | ---: | --- |
| Canonical lexical records | 5,076 | All current records are supported `entry` or `expression` records |
| Entries | 3,922 | `entry` records |
| Expressions | 1,154 | `expression` records |
| Historical `start` role | 5,034 | Metadata count only |
| Historical `reference-only` role | 42 | 41 entries and 1 expression; directly searchable |
| Non-lexical/support records in canonical data | 0 | No current canonical record is outside the lexical record types above |
| Senses | 5,338 | Canonical senses across all records |
| Directed relations | 487 | Existing sense-bound editorial relations |
| Distinct exact lemma/search-form keys | 5,332 | Every key was checked against the current SQLite search path |
| Records with no outgoing relations | 4,740 | Relation sparsity does not remove direct-search eligibility |
| Directly searchable canonical records | 5,076 | No valid in-scope canonical record is unreachable |
| Non-searchable lexical records | 0 | Shared direct-search audit found no missing record |

The 4,740 relation-empty records include all 42 historical reference-only
records. Issue #211 contributed 24 newly admitted starts, each with one sense,
zero relations, and a matching exact-search result. No relation was added to
meet a count or ranking quota.

The 5,332-key coverage result is from the Issue #210 inventory's temporary
SQLite audit: every canonical lemma/search key resolved to its expected record,
with no missing owner, unexpected owner, or cross-record collision. This
describes lookup coverage; it makes no claim about relation completeness,
ranking quality, or writer outcomes.

## Historical recovery inventory

Issue #210 classified 584 historical candidates. Issue #211 re-reviewed all 25
mandatory Issue #204 rejects: 24 were admitted and one (`내다`) remains held for
a source-bound sense split. The old rejection rationale remains historical and
is not an active usefulness/generality exclusion.

| Current inventory disposition | Count | Follow-up meaning |
| --- | ---: | --- |
| `recovered` | 24 | Issue #204 candidates now admitted and searchable |
| `admit-candidate` | 308 | Fresh bounded review only; includes 254 reserves, 35 rows needing authored candidate bodies, and 19 open M5 candidates |
| `hold` | 220 | Candidate-specific identity, context, lexical-unit, or rationale evidence remains incomplete |
| `needs-sense-split` | 27 | Sense boundaries need source-bound resolution; includes the Issue #204 `내다` hold |
| `duplicate` | 2 | Classified as true duplicates; no admission action while identity is unchanged |
| `invalid-lemma` | 2 | Classified as inflected-form proposals rather than separate lemmas |
| `search-surface-collision` | 1 | Held until its collision is resolved |
| **Total** | **584** | Disposition counts reconcile to the audited candidate set |

There are 560 rows outside `recovered`. Of those, 555 remain for fresh review or
evidence resolution (`admit-candidate`, `hold`, and `needs-sense-split`); the
other five already have duplicate, invalid-lemma, or collision dispositions.
The 247 `hold` and `needs-sense-split` rows preserve unresolved evidence rather
than usefulness exclusions. Across the audited historical events, confirmed
active exclusions based only on usefulness or generality: **0**. Unsupported
candidate categories: **0**.

## M1–M8 policy and contract reconciliation

| Milestone | Final status for searchable-start policy | Evidence and remaining boundary |
| --- | --- | --- |
| M1 — Editorial model | Updated | The Editorial Model states role-independent eligibility and separates lexical validity, supported scope, search, relation enrichment, and ranking. Historical pilot counts remain snapshots. |
| M2 — Schema, validation, SQLite | Updated | Shared canonical and prospective admission checks preserve lexical identity, POS, sense, duplicate, and reference integrity without making role a search veto. Current full canonical validation remains applicable. |
| M3 — Runtime | Updated | The shared SQLite query and search response path directly resolves valid records by lemma or curated form regardless of historical role. |
| M4 — Search contract | Updated | Native/WASM regressions cover role-independent exact lookup, supported generated forms, relation navigation, collisions, and deterministic precedence. Extension and Web share the same relation-empty disclosure component. |
| M5 — Selection and recovery | Audited | Issue #210 inventories 584 candidates; Issue #211 routes the 25 mandatory rejects through shared admission, admitting 24 and holding one for a sense split. No larger batch is authorized here. |
| M6 — Quality gates | Reconciled | Search reachability is measured independently from relation and writer-quality measures. The earlier M6-1 digest is a historical snapshot; this report gives current canonical counts and key coverage. |
| M7 — Scale and release | No new scale run required | Issue #209 removed the dedicated reference-only probe and retains indexed lemma/form lookup. This issue changes audit and documentation only; it changes no query, index, role mix, or package input. Existing M7 scale/package evidence remains bound to its recorded source. |
| M8 — Release and product | Historical release contract preserved | The M8 counts and package hashes remain tied to its exact release-candidate revision. DATA-LICENSE redistribution and publication approval remain independent gates. |

No M1–M8 contract permits relation count, word generality, frequency, vividness,
or standalone writer usefulness to reject an otherwise valid in-scope lexical
record. The categories currently unresolved by the POS model are pronouns,
numerals, determiners, particles, and interjections; they require an explicit
scope/schema decision before admission and are not usefulness-based exclusions.

## Future corpus handoff

The [Issue #201 corpus pilot](corpus-lemma-pilot-issue-201.md) now records this
operative handoff:

- Use only sources whose documented permission covers the intended reference
  and candidate-evidence use. Keep source/index digests and bounded evidence
  provenance with the candidate; do not commit raw corpus text or excerpts.
- Preserve observed surface, analyzed morpheme span, proposed lemma/POS,
  ambiguity, and evidence as separate fields. Before admission, check lexical
  identity, supported POS and sense boundaries, canonical lemma and curated
  search-form coverage, supported generated-form collisions, and duplicates.
- Do not use frequency, commonness, generality, low standalone writer
  usefulness, or an empty relation list to exclude a valid in-scope entry.
  Corpus evidence may prioritize later relation-enrichment effort; each
  relation remains a separate, bounded editorial decision. Empty relations are
  valid when no relation has adequate evidence.
- Route cleared candidates through the shared producer, admission validator,
  canonical validator, and direct-search invariant. Fix systemic boundary
  defects in shared code before expanding the corpus batch.
- A larger corpus batch, additional POS categories, and public publication each
  need their own scope and applicable owner/source-policy decisions.

This is a workflow handoff, not a corpus import or a capacity target. The local
pilot and its ignored evidence remain local and manual; it stays outside normal
CI, product runtime, Pages, and extension packaging.

## Regression and reproduction evidence

The corrected rule is protected at shared boundaries rather than by an
Issue #204-only exception:

- `tests/searchable-start-contract.test.mjs` accepts valid common/general
  relation-empty records through shared admission, rejects policy-only
  exclusion bases, and checks native/WASM search and collision behavior.
- `tests/runtime-query-adapter.test.mjs` compares native and WASM lookup for
  lemma, curated form, generated surface, ambiguous results, and a historical
  `reference-only` record; it also preserves relation reads and indexed plans.
- `tests/issue-211-search.test.mjs` verifies direct exact search for the 24
  relation-empty Issue #211 admissions.
- `tests/search-query.test.mjs` protects result precedence, deduplication, and
  deterministic ordering. The shared `DictionaryPanel` preserves relation
  disclosure for both Extension and Web.

Reproduce the current audit and relevant product contracts with:

```sh
npm run inventory:issue-210:write
npm run inventory:issue-210
npm run batch:issue-211:check
npm run validate:search
npm run verify:m2
npm run validate
npm run ci:normal
```

The inventory write refreshes source hashes after this report updates tracked
source documents; the following check verifies that generated inventory and
summary are current. Normal CI covers the relevant deterministic build and
Extension/Web contracts. Chrome for Testing and another 500K/1M scale benchmark
are not required for this documentation-only audit because no browser-only,
runtime, query, index, or package behavior changed.
