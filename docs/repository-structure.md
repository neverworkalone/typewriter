# Typewriter Repository Structure

This page describes files used by the current product and approved maintenance paths. Older issue reports and task artifacts under `docs/` are historical records; their procedures are not active production instructions.

## Source and generated data

| Material | Location | Use |
| --- | --- | --- |
| Licensed editable dictionary projection and reviewed Typewriter relations | `data/canonical/*.jsonl` | Source of truth. See [`DATA-LICENSE.md`](../DATA-LICENSE.md) and [`docs/data-policy.md`](data-policy.md). |
| Canonical source validation and projections | `scripts/validate/`, `scripts/normalize/`, `scripts/build/` | Validate Canonical records and generate Full SQLite, Lite SQLite, and product runtime assets. |
| Relation packets and correction records | `data/relation-backfill/`, `scripts/relation/` | Current source-bound relation authoring and apply path. |
| Legacy permanent trash archive | `data/candidate-trash/T######.jsonl` | Historical, text-free unresolved-source archive. Changed chunks remain subject to strict Normal validation; this does not enable new lexical production. |
| Generated databases and packages | ignored `artifacts/` and `dist/` | Reproducible output only; never hand-edit or treat as source. Only the Lite database is included in the extension. |
| Extension state | Chrome extension storage | Search history, favorites, settings, and other user data remain outside the read-only dictionary. |

## Product and CI code

- `src/domain/` contains UI-independent search state and Canonical record/sense projection.
- `src/runtime/` contains the extension's offline SQLite worker and query boundary.
- `src/popup/`, `src/options/`, and `web/` contain the extension UI and static web application.
- `public/` contains the extension manifest and approved product assets. Root `popup.html` and `options.html` are the extension entrypoints.
- `scripts/ci/registry.mjs` owns automatic checks and their tier/dependency metadata. `scripts/ci/product-unit-test-files.mjs` is the explicit Vitest file set shared with the registry and `vitest.config.js`.
- `tests/` and the directly invoked `scripts/**.test.mjs` files protect current product, source-integrity, build, relation, and CI contracts. Their current execution and disposition are recorded in [`docs/test-inventory-823.md`](test-inventory-823.md).

## Local-only and historical material

External source files and permitted local indexes belong under `~/.cache/typewriter/` or a temporary location outside the checkout; raw dictionary responses and corpus passages do not belong in Git or product packages. See [`docs/data-policy.md`](data-policy.md) before introducing any source.

Historical M5 batch reports, old lexical-production instructions, and completed issue evidence may remain for audit history. Do not use their old commands, candidate workflows, or Meaning-editing procedures as active product inputs. Git history and linked issues/PRs preserve detailed task records; the current workflow is defined by the root instructions and current policy documents.
