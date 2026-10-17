# M4 search UX handoff

> Historical handoff: its start-only and reference-only-blocking behavior is
> superseded by the current role-independent search contract in Issue #209 and
> [`docs/search-regressions.md`](search-regressions.md).

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
pnpm run ci:normal
pnpm run build
TYPEWRITER_ZIP_DIR=/tmp/typewriter-package pnpm run package
TYPEWRITER_ZIP_DIR=/tmp/typewriter-package-minified pnpm run package:minify
```

These checks cover the canonical regression corpus, domain/component state
transitions, deterministic SQLite builds, production asset assembly, and regular
and minified package contents. Per the current product-owner decision, Chrome for
Testing is not a required gate for this app; this document therefore does not
claim a browser E2E result.
