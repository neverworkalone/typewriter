# Toolchain Review

Use this guidance for canonical validation, database builds, package output, and CI changes.

## Current data and product boundary

- Canonical JSONL is the editable dictionary source. A record is one search candidate; its ordered senses are the candidate's definitions.
- Full SQLite, Lite SQLite, and the extension package are generated from Canonical inputs. Never hand-edit generated databases.
- Mechanical checks protect source shape and provenance, record/sense ownership, relation references, deterministic builds, Full/Lite contents, package boundaries, and actual search/runtime behavior.
- Do not use an automated test to re-judge STDICT's lexical identity, sense split, or gloss content. Preserve source evidence and test the conversion contract.

## CI routing and execution

`.github/workflows/ci.yml` runs the applicable gate on the exact PR head:

- Documentation-only changes under `docs/**`, `README.md`, or `REVIEW.md` may skip Normal and must report that skip.
- Every other change, including candidate artifacts, mixed changes, an empty diff, or an unclassifiable path, runs `ci:normal`.
- A changed dependency of a registered Deep contract adds only that affected Deep check through `ci:pr`. CI registry, runner, classifier, workflow, or package changes retain Normal and their independently matched Deep checks.
- `ci:fast` is a checkpoint inside the same Normal session. `ci:all` runs Normal followed by current-system Deep checks; `ci:deep` selects Deep checks only. Full Deep is a weekly/manual audit, not an automatic PR fallback.

CI separates a check's domain owner and protected contract from its execution tier and schedule. Each check has one owner, one contract, one tier (`normal` or `deep`), and one schedule (`always`, `affected`, or `manual`). New checks default to Deep. An `affected` check must list normalized repository-relative dependency paths. `deepInputs` describe data consumed by a check and do not alone select it.

For new or changed paths:

1. Reuse a real always-on Normal regression only when it covers the changed behavior. Bind the exact path and protected contract in `scripts/ci/deep-gate-coverage.json`; that file is append-only and independently checked against the PR base.
2. Register every affected Deep dependency and select the union of those checks. Do not lower an existing trigger.
3. If an invariant lacks a test, add a generalized old-fails/new-passes regression at the common producer, validator, builder, or consumer boundary. Use Normal for merge-critical contracts and affected Deep for independent expensive proofs.
4. If the ownership or impact is unresolved, keep the diagnostic and run Normal. Do not use an unrelated full Deep run as a substitute for missing regression coverage.

## Durable test registration

An automatic test belongs in CI only when both conditions hold:

1. It covers a current product feature or an approved Canonical, database, relation, search, or release path.
2. Its failure identifies a plausible recurring product, data-integrity, or build-contract regression that another registered check does not already detect.

Before registering a test, ask whether its future failure would reveal a user-facing or data/build regression, or only report that a one-time implementation or design choice changed. The latter stays task-local. Delete its test file when it has no lasting regression value; do not preserve it as Manual or let a broad test glob run it indirectly.

Keep functional UI contracts such as keyboard search, candidate selection, relation navigation, settings persistence, offline loading, and package safety. Remove one-off style or markup assertions that freeze CSS colors, selectors, exact source strings, or glyph formatting unless that representation is itself an approved stable product contract with a distinct failure value. Visual choices should be checked in the task that changes them.

Vitest automatic discovery is an explicit list in `scripts/ci/product-unit-test-files.mjs`, shared with `scripts/ci/registry.mjs`. `vitest.config.js` must use that list, and the registry regression verifies the discovered, registered, and on-disk `tests/*.test.js` sets are equal. A new one-off check must not be added to this list, `ci:normal`, `ci:deep`, `ci:all`, `ci:pr`, or a scheduled workflow. Manual tests are retained only for an actual current workflow that is run repeatedly outside CI, not as storage for retired task checks.

Each test file has one CI registry owner. The audit inventory in `docs/test-inventory-823.md` records current callers, protected failures, automatic/direct execution, overlap, and the `KEEP`, `CONSOLIDATE`, or `DELETE` decision.

## Validation evidence

Validator changes need a representative invalid input that fails and a valid input that passes. A test should prove the shared rule for existing and future applicable records; do not encode a list of particular words or old batches in place of a general invariant. Do not replace source-bound editorial judgment with a brittle lexical heuristic.

Every successful Normal run builds SQLite for the exact Canonical revision once across the runner and child commands. The shared build ledger enforces the parent, child, and combined counts. Isolated fixture builds and independent reproducibility builds are counted separately. Reproducibility and other expensive checks remain Deep only when they protect a distinct current contract.

Report only checks actually run. A Normal or Deep result proves only the properties its checks exercise; a skipped check is not evidence that the check passed. For local Normal CI (`ci:normal`, `pnpm test`, `ci:pr`, or `ci:all`), first commit intended changes and require an empty worktree.
