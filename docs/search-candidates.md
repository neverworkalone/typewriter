# M4 candidate order

The search candidate unit is one `start` record. A sense or relation is never a
separate search candidate, so ranking cannot reorder a polysemous record's senses
or its relation source order.

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

## Keyboard selection contract

The popup exposes the ready exact-search candidates as a separate `listbox`; each
start record is an `option` with `aria-posinset`, `aria-setsize`, and
`aria-selected`. The full result cards remain outside that listbox, so their
relation controls stay ordinary tab stops. Arrow keys move the selected option
without wrapping at either boundary, and Enter confirms the current option
without issuing a second exact search. Relation-target screens do not expose a
candidate list or candidate selection state. The selected record ID is kept in
the current `SearchSession` history snapshot, so relation-target navigation and a
later `back()` restore the same candidate selection while a new exact search
starts with no selection.

Korean IME composition is handled at the input boundary: Enter is ignored while
`compositionstart` is active and only submits after `compositionend`. This
interaction contract is covered by the component tests and the Chrome for Testing
popup smoke path.
