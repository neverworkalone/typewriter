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

A deterministic check can establish only the property it actually covers.
**Stage 2 evaluates validation source, design and test adequacy without inspecting,
retrieving or waiting for CI status/logs**; it must not claim unrun native,
corpus, visual or other manual checks passed. **Stage 3 alone verifies required
exact-HEAD CI**. CI success proves only its tested properties; Stage 3 must read
passing CI logs when the workflow, validator, fixture or expected behavior
changed, or when source code contradicts a claimed result. A green badge
alone cannot establish the adequacy of newly changed validation.

For lexical validators and regression tests:

- prefer repository-wide invariants over batch-, record-, or word-specific
  checks;
- verify that general rules run against all applicable existing canonical data;
- verify that future lexical additions reach the same rule through the common
  validation/admission path;
- allow batch-specific checks only for genuinely batch-specific constraints;
- reject fixtures that merely memorize affected canonical records when a small
  synthetic fixture can prove the general rule.

## PR workflow / exact-HEAD CI classification

`.github/workflows/ci.yml` runs on `pull_request`, not post-merge `master`
pushes. **Stage 3 exclusively owns the CI gate**: check the complete changed-path
list and actual successful **exact-HEAD** workflow result, including the summary
of any authorized skip. **Stages 1 and 2 never inspect, retrieve or wait for CI
status, workflow runs or logs**; their `+1`/`+2` do not assert CI success.
Pending CI blocks merge until Stage 3 rechecks the gate with updated evidence;
Stage 2 must not be rerun solely because CI was pending. Failed, missing,
stale or incorrectly skipped CI also blocks merge.

1. **Documentation-only:** every changed path must be beneath `docs/**`
   (including non-Markdown files) or exactly `README.md` or `REVIEW.md`.
   The `Validate and test Typewriter` workflow must still finish
   successfully and explicitly report that `ci:normal` was **skipped**.
   A skip must not be reported as tests/SQLite having run.
2. **Pure Stage 1 candidate artifacts:** the complete diff must contain
   **only** `data/candidates/C######/manifest.json` and/or
   `data/candidates/C######/candidates.jsonl` (six digits in the batch ID).
   Require a successful exact-HEAD `ci:candidates` check. It tests candidate
   schema/manifest/digests/identity and applicable factory contracts **without
   building the current-canonical SQLite database**. Do not require
   `ci:normal` for this authorized narrow gate.
3. **Everything else:** code, schema, canonical, Stage 2 results, source
   policy, non-allowlisted paths or mixtures of any above classes require a
   successful exact-HEAD `ci:normal` result.
4. **Fail-closed classification:** an empty diff, unclassifiable/unknown
   path, or changed file outside the narrow allowlist must take Normal.
   Compare rename **source and destination** paths; a moved source cannot
   become documentation-only. Do not allow an incidental documentation file
   to turn a candidate+docs or code+docs PR into a skip/fast gate.

`ci:fast` is the fast checkpoint **inside the same `ci:normal` context**,
not the candidate-only CI. One Normal invocation continues from that
checkpoint, without repeating global audit or SQLite generation. Historical
replay and Deep are separately owned; neither replaces an applicable Normal
gate.

When Deep workflow/Deep contracts change, require **successful exact-HEAD
Deep** evidence; a scheduled run on another SHA, a skipped Deep gate or
ordinary green Normal cannot substitute. At this document's #469 baseline,
#464 rollout PR #470 adds scoped `ci:historical` and exact-HEAD Deep selection.
The existing `Validate and test Typewriter` PR check performs the path
classification; when Deep is required, that same check runs `ci:all`. The
classifier does not publish a separate PR check. Deep data inputs come from
Deep check registry metadata. The classifier skips only exact known non-Deep
files and recognized Stage 1 artifacts without Deep consumers; unknown or
unclassifiable paths trigger `ci:all`, and a classifier failure also runs
validation. No new CI gates are invented by this review policy.

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

The **scope/domain** is distinct from the **tier**. Normal protects the
current canonical revision, required admission/factory freshness and current
product outputs; optional `ci:fast` is a prefix inside the same session.
`ci:all` selects Normal plus current-system Deep (not a historical replay);
`ci:deep` selects Deep checks across scopes. Independent current-revision
reproducibility and scale/benchmark checks belong in Deep. Completed-issue
checkpoint replays belong in a separately invoked Historical tier:
`ci:historical` requires exactly one registered `--scope` and runs only checks
tagged for that scope; it has no all-history default and stays outside weekly
`ci:all`. A passing scheduled/other-HEAD run never substitutes for the
required exact-HEAD gate.

The Issue #464 migration inventory is at
[`docs/ci-check-inventory.md`](ci-check-inventory.md), with one machine-checked
row per registered CI check in
[`scripts/ci/check-inventory.json`](../scripts/ci/check-inventory.json). It records the
owner, protected contract, measured duration, tier, trigger, migration reason,
and consumer. No check is retired in PR 2.


### Systemic test coverage — do not merely patch the failing fixture

When a defect is found in a shared validator/producer/builder/consumer, require
a minimal representative failing case, correction at the common boundary,
**old-fails/new-passes** regression and proof the same check applies to every
relevant existing record and future addition. A test that recognizes only one
batch's IDs/words is not adequate. Conversely, do not replace source-bound
editorial judgments with mechanical synonym or subjective relation validators;
see `docs/review-data.md`.

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
