# M4 candidate order

The runtime search candidate unit is one `start` record. A sense or relation is
not ranked independently. In the exact-result UI, however, a record with more
than one sense expands into ordered sense options so a writer can choose the
intended homonym; a single-sense record remains one record option. Record order
comes from the runtime, and sense order comes from the canonical record.

## Match tiers

The shared runtime contract uses a deliberately small, evidence-backed priority:

| Tier | Match provenance | Priority |
| --- | --- | ---: |
| 0 | exact canonical lemma | 0 |
| 1 | exact curated `search_forms` value | 1 |
| 2 | a match reached after NFC or surrounding-whitespace normalization | 2 |

The tier is derived from `match.kind` in
[`src/runtime/search-query.js`](../src/runtime/search-query.js). It is not a
frequency score, an LLM score, or a claim that one relation type is semantically
better than another. `direct`, `near`, `mood`, and association relations remain
their canonical editorial types.

If one record is returned through more than one path, the best path is retained
once. Within a tier, the runtime keeps the deterministic SQLite source order; the
stable record ID is the final defensive tie-break. The Node helper and the
SQLite/WASM worker use the same pure `rankSearchMatches()` implementation.

The SQL source order is explicit (`id`, then match path priority), and no query
uses fuzzy, prefix, morphology, or inferred usage frequency. Therefore repeating
the same query against the packaged database produces the same candidate order.

## Projection and navigation

Candidate order is settled before `SearchSession` loads full records. The session
passes the ordered candidates to `projectSearchResults()`, while each record's
sense and relation arrays remain in their stored `position` order. Relation target
actions carry their source sense and canonical relation type into the existing
history snapshot; candidate ranking does not rewrite that navigation context.
When a relation records `target_sense`, relation navigation carries that target
sense into the projection so a polysemous target shows only the intended sense.

## Keyboard selection contract

The popup exposes ready exact-search candidates as a separate `listbox` only
when two or more record/sense options exist. A single exact result keeps the M3
result layout without a duplicate selector. A polysemous record's options use
the sense gloss as their label; a record with one sense uses its lemma. Each
option has `aria-posinset`, `aria-setsize`, and `aria-selected`. The first option
is selected by default and only the selected record and sense are rendered.
Arrow keys move the selected option without wrapping at either boundary, and
Enter confirms the current option without issuing a second exact search, then
moves focus to the selected result's first relation control (or the result card
when no relation control exists). Changing an option updates the current
`SearchSession` snapshot only: it does not add a history entry or expose the
`← 뒤로` control. Relation-target screens do not expose a candidate list or
candidate selection state, while their existing back navigation remains intact.

Korean IME composition is handled at the input boundary: Enter is ignored while
`compositionstart` is active and only submits after `compositionend`. This
interaction contract is covered by the component tests and the Chrome for Testing
popup smoke path.
