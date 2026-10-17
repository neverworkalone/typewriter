# Legacy Meaning editing layer removal (Issue #822)

Invariant: **the product dictionary is built from `data/canonical/` alone; one STDICT record is one meaning (search
candidate) with all of its senses.** No separately stored, edited or adjudicated Meaning input exists or is accepted.

History (the #713–#718 contract, #716/#764 re-edits, #772/#774/#814 follow-ups) remains in Git history and in the linked
issues/PRs; the last commit that contained the removed files is the parent of this change (`git show b55f5fd5:<path>`).
Past audits were editing evidence for the removed layer, not evidence for the canonical-only product.

## Removed (read-only inventory taken before deletion, base `b55f5fd5`)

| Area | Files | Bytes | Lines |
| --- | ---: | ---: | ---: |
| `data/meanings/` (C01–C20 shards, 434,103 meaning rows) | 507 | 81,797,715 | 434,103 |
| `data/adjudication/` (133 DROP rows) | 9 | 13,424 | 133 |
| `scripts/meaning/` (initial/apply-edits/validate/contract/project, #716/#764/#772/#774 specs, audits, tests; 45 audit reports, 16 test files) | 127 | 77,490,600 | 1,979,658 |
| `docs/meaning-editing-contract.md` | 1 | – | 107 |
| **Total** | **644** | **≈159.3 MB** | **≈2.41 M** |

Also removed: the Normal checks `Test Issue #713 …`, `#715 …`, `#717 …`, `#764 C19 …` and the in-process
`meaning-references` check (`scripts/ci/run-category.mjs`), the `data/meanings/**` / `data/adjudication/**` entries of
`config/artifact-policy.json`, the legacy `meaningsDirectory` / `adjudicationDirectory` branch and `loadMeaningData` use
of `scripts/build/dictionary.mjs`, and the legacy sections of `docs/meaning-layer.md`.

## Kept (not part of the editing layer)

- Canonical records/senses/relations: byte-for-byte unchanged (`data/canonical/` is not in this diff).
- Generated SQLite tables `meanings`, `meaning_members`, `meaning_relations`, `meaning_relation_sources`,
  `sense_adjudications` (now always empty), `m<record-id>` ids and the runtime read APIs. Renaming/removing tables is a
  separate optimisation.
- The projection, moved to the standalone `scripts/build/record-meanings.mjs`: record meanings, relation projection with
  provenance (stats keys unchanged; `redirected`/`out_of_scope` are always 0), and the provenance oracle.
- Shared invariants (Normal): `tests/canonical-record-meanings.test.mjs`, `tests/meaning-provenance.test.mjs`,
  `tests/meaning-search.test.mjs`, `tests/meaning-rank-order.test.mjs`, plus the new
  `tests/record-meaning-projection.test.mjs` (ids, projection table, fail-closed controls, oracle, removed options) and a
  registry guard in `tests/ci-registry.test.mjs` that no registered check references the removed paths.

## Removed options fail explicitly

`buildDictionary({ meaningsDirectory })` and `buildDictionary({ adjudicationDirectory })` throw `BuildError`
`REMOVED_OPTION`; they are never ignored and never produce an empty Meaning result.

## Issue #797

The plan to edit `data/meanings/` files directly (user-facing gloss cleanup, homonym-number removal, source `→`
reference relations) is **void**: those files no longer exist. #797's functional goal is not implemented here and must
be redesigned as a separate Canonical-only derivation and persistence path.
