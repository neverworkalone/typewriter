# M4 search UX handoff

M4 keeps the writer-facing search boundary deliberately small: exact canonical
lemmas, exact curated search forms, and the two approved normalization rules.
The popup now reports why a search did not produce a usable result instead of
using one generic failure message.

## State contract

| Situation | State/category | Writer-facing behavior |
| --- | --- | --- |
| A canonical start record matches | `ready` | Show the record and its canonical senses/relations. |
| No start record matches | `empty/no-data` | Say that the word is not in the current dictionary; do not invent an answer. |
| The input violates a current policy boundary | `empty/unsupported` | Explain the boundary and the supported input shape. |
| A relation target cannot be loaded | `empty/relation-target` | Say that the relation target is not currently available. |
| A start record has no relations | `ready` + `data-editorial-gap` | Show the definition and disclose that related words are not curated yet. |
| Dictionary/WASM loading fails | `error/runtime` | Offer retry and identify the packaged dictionary/runtime failure. |
| A query fails after runtime loading | `error/runtime` | Offer retry without claiming that the query had no result. |

The structured reason is preserved in `SearchSession.emptyReason` and exposed on
the panel as `data-search-reason`. Runtime failures remain in the typed error
state, so a missing word is not presented as an infrastructure failure.

## Regression disposition

The shared M4 corpus remains the source for the supported search boundary. Exact
lemma, exact search form, NFC, surrounding whitespace, reference-only blocking,
no-data, and editorial-gap cases are retained. The inflected query `담담했다`
remains `pending`: the current product intentionally has no general Korean
morphology policy, so it is not relabeled as unsupported merely because it has no
exact match. This avoids presenting an implementation limitation as a confident
linguistic classification.

The current pilot also contains polysemous records such as `눈` with multiple
senses. Homonym-specific candidate separation is a separate follow-up and is not
expanded as part of this handoff.

## Validation evidence

The non-browser handoff gate is:

```sh
npm test
npm run test:unit
npm run validate:search
npm run verify:m2
npm run build
TYPEWRITER_ZIP_DIR=/tmp/typewriter-package npm run package
TYPEWRITER_ZIP_DIR=/tmp/typewriter-package-minified npm run package:minify
```

These checks cover the canonical regression corpus, domain/component state
transitions, deterministic SQLite builds, production asset assembly, and regular
and minified package contents. Per the current product-owner decision, Chrome for
Testing is not a required gate for this app; this document therefore does not
claim a browser E2E result.

## M5 handoff

M5 #7 must begin with evidence collection, not a 5K generation run. Before the
first larger batch:

1. collect the smallest writer-facing query cases and classify them as supported,
   no-data, unsupported-policy, or editorial-gap;
2. measure target-list preparation, draft review, relation review, correction
   rate, and per-record human review time;
3. keep external raw responses and unreviewed drafts outside the repository;
4. commit only reviewed canonical JSONL, then run the existing integrity/build
   pipeline; and
5. stop or repair the curation process when direct-relation accuracy, noise, or
   review cost misses an agreed batch threshold.

No M5 batch implementation or automatic dictionary expansion is started by this
handoff. The next product decision is whether the collected writing demand and
editorial cost justify a small reviewed batch.
