# Toolchain Review

Use for validators, import/normalization scripts, canonical builds, SQLite,
generated artifacts, and CI.

Check:

- canonical source remains authoritative;
- generated output comes only from canonical/build inputs;
- generated artifacts are not hand-edited;
- canonical → generated data remains faithful;
- required builds are logically deterministic;
- required schema/index/metadata behavior is preserved.

Mechanical checks belong in scripts/CI, including schema validity, references,
duplicates, invalid relations, generated-data fidelity, DB structure, and
package contents.

When a validator, fixture, expected result, or CI workflow changes, verify that
the check itself is still valid.

Validator changes must include evidence that known-invalid input fails and
valid input passes.

Otherwise, a passing deterministic check is sufficient evidence for the
property it covers.

For lexical validators and regression tests:

- prefer repository-wide invariants over batch-, record-, or word-specific
  checks;
- verify that general rules run against all applicable existing canonical data;
- verify that future lexical additions reach the same rule through the common
  validation/admission path;
- allow batch-specific checks only for genuinely batch-specific constraints;
- reject fixtures that merely memorize affected canonical records when a small
  synthetic fixture can prove the general rule.

## Canonical and CI architecture changes

When these paths change, verify the complete canonical revision feeds a shared
in-process context; global semantic audit precedes SQLite build; downstream
checks consume the same artifact; current-canonical gates and isolated tests
do not repeatedly parse, scan, build, or transport the entire context.
Check reported parse/full-scan/index/build counts against actual runner wiring.
Changed-only validation may give early feedback, not final coverage.

CI registration separates **scope** (the domain and protected contract) from
**execution policy** (tier and schedule). Each check records one owner, one
protected contract, one tier (`candidate`, `normal`, `deep`, or `historical`),
and one schedule (`always`, `affected`, or `manual`). New checks default to
Deep. Normal registration requires a concrete same-PR merge invariant.
`affected` checks must list normalized repository-relative dependency paths;
missing or unclassifiable changed-path evidence fails closed to the full
applicable gate. Each test file has exactly one registry owner.

Pure Stage 1 artifact PRs use `ci:candidates`, which validates the factory
candidate contracts without creating the current-canonical SQLite database.
Ordinary code/data/mixed PRs require `ci:normal` for current canonical,
admission, and product protection. A PR may expose the fast checkpoint and
continue Normal **within one process/session**, not repeat full-canonical work.
`ci:all` runs Normal then current-system Deep, and `ci:deep` selects Deep checks
across all domain scopes. Current-revision independent builds and scale checks
belong in Deep; completed Issue checkpoint replays belong in Historical.
Historical replay is excluded from weekly Deep CI; PR 3 adds bounded
`ci:historical` and the exact-HEAD `Deep CI Gate`. Check the actual command
registry and workflow on the current HEAD. A scheduled or skipped run does not
satisfy the exact-HEAD Deep requirement.

The Issue #464 migration inventory is at
[`docs/ci-check-inventory.md`](ci-check-inventory.md), with one machine-checked
row per registered CI check in
[`scripts/ci/check-inventory.json`](../scripts/ci/check-inventory.json). It records the
owner, protected contract, measured duration, tier, trigger, migration reason,
and consumer. No check is retired in PR 2.

### One current-revision SQLite build in `ci:normal` (enforced invariant)

Every successful `ci:normal` must build SQLite for the **exact current canonical
revision exactly once** across the whole workflow (parent process, spawned
commands, nested validators). Counters are derived from one append-only ledger
(`TYPEWRITER_PROCESS_METRICS_PATH`) written by `markSQLiteBuild` and bound to the
revision computed from the canonical bytes, never to a caller-provided label:

- `parent_current_revision_sqlite_build_count === 1`
- `child_current_revision_sqlite_build_count === 0`
- `current_revision_sqlite_build_count === 1` (normal phase)
- reported separately and never relaxing the gate:
  `deep_current_revision_sqlite_build_count`, `other_revision_sqlite_build_count`
  (isolated fixture/historical revisions), `all_sqlite_build_count`,
  `parent_context_sqlite_build_count` (the shared context's in-memory counter).

`scripts/ci/run-category.mjs` enforces this for `fast`, `normal` and `all` at the
fast checkpoint, at normal-phase completion (before deep phases) and at final
exit, plus per command: a child current-revision build fails the command
immediately. The guard fails closed: an unreadable or malformed ledger, or a
command that registered no child process (omitted metrics hook), is a failure,
never "zero builds". Validators and tests reuse the shared artifact through
`scripts/ci/current-revision-database.mjs`, which binds it to the revision the
validator read itself and never falls back to another build. Independent two-build
current-revision reproducibility runs in Deep (checks marked
`independentCurrentRevisionBuilds`, which receive no shared artifact).
Completed-issue checkpoint replays use the separately selected Historical tier.

`tests/ci-sqlite-build-guard.test.mjs` (registered in the `canonical` category)
proves pass/fail behavior through the real runner on a fixture session: one
parent build passes (other-revision fixture builds allowed); zero builds, two
parent builds, parent plus child, two child builds, an omitted hook and a
malformed/deleted ledger all exit nonzero although every command succeeds; deep
independent rebuilds are allowed while the normal phase stays one-build.
Reviewers must block a PR that adds a second exact-current-revision build in
normal, bypasses or falsifies the guard, or adds a batch-specific full-canonical
replay instead of reusing the shared validation context.
