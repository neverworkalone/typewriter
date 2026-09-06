# M2 handoff to M3

M2 closes with a pilot dataset of 326 canonical records: 300 `start` records,
26 `reference-only` records, 386 senses, 340 directed relations, 363 search
forms, and 14 expressions. The integrated audit compares every canonical record,
search form, sense, and relation row with two independently generated SQLite
databases.

## M3 contracts

- Canonical JSONL under `data/canonical/` is the editable source of truth. A client
  must not edit `dictionary.sqlite` or treat generated output as canonical data.
- The required pipeline is schema validation → dataset integrity → in-memory
  normalization v1 → SQLite schema v1. Use `node scripts/verify/m2-pipeline.mjs` as
  the local clean-checkout audit.
- SQLite is a read-only dictionary artifact for the client. Exact lemma and
  `search_forms` lookup, record/sense retrieval, and relation target display are
  available through the query shapes in `scripts/build/query.mjs`.
- `records`, `search_forms`, `senses`, and `relations` preserve canonical IDs and
  source order. `reference-only` records are valid relation targets but are not
  search starts. `target_sense` is optional except where the integrity contract
  needs it, such as `action` relations.
- Build provenance is in `metadata`: dictionary/schema/normalization/tool versions,
  source revision, worktree state, runtime versions, and row counts. Clean builds
  require a clean Git worktree; `allowDirty` is for explicitly non-reproducible local
  work only.
- The MV3 proof package contains its own database, module worker, SQLite WASM binary,
  loader, and Apache-2.0 license copy. It has no permissions, host permissions, or
  `web_accessible_resources`; the extension-origin worker performs exact local
  lookups and enables SQLite `query_only`. User favorites, recent searches, and
  settings must remain outside this read-only dictionary database.

## M2 audit boundary

Automation checks syntax, schema shape, IDs, references, duplicates, self-reference,
action target part of speech, normalization defaults, SQLite constraints, logical
reproducibility, metadata/counts, and representative query fields. It does not
decide whether a `direct` relation is editorially correct, whether a sense should be
split, or whether a relation is writer-useful. Those remain human review under
[`docs/editorial-model.md`](editorial-model.md).

## Deliberately deferred to M3

- pilot Chrome search UI, keyboard interaction, and result presentation;
- ranking, fuzzy or morphological search, and broader coverage;
- user-owned state and release/update hardening;
- a larger ontology, embeddings, cloud services, or a generalized NLP layer.

These are product decisions for M3 and are not required to change the current
canonical relation categories or SQLite contract.

## Chrome for Testing evidence

The packaged proof was rerun on 2026-09-05 with Chrome for Testing 152.0.7977.76.
It loaded the MV3 page and module worker from the unpacked package, fetched no
non-extension URL, reported SQLite 3.53.0 and `query_only = 1`, found `담담하다`,
`담담`, and the `w026-s1 → r008-s1` relation with its note, and rejected a test
write without persisting it. Re-run the platform-specific command in
[`docs/build.md`](build.md) when changing the extension loader or vendored runtime.
