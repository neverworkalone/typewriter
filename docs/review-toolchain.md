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

### Extending CI change coverage (applies to every future PR)

An unclassified path is a **missing verification responsibility**, not evidence
that every independent Deep check is relevant. Before accepting the full Deep
fallback as routine, trace the change to its protected contract and existing
always-on Normal tests and affected Deep checks:

1. If an already registered, always-on Normal regression protects the changed
   behavior, add an **exact path** binding with the protected contract and
   registered test file(s) in `scripts/ci/deep-gate-coverage.json`. The
   classifier checks test registration, Deep ownership precedence, uniqueness,
   exact-path validity and the additive-only change against the PR base.
   A verified binding-only addition plus ordinary source changes selects Normal
   without unrelated Deep checks. A fabricated or unregistered test cannot
   authorize a skip.
2. If an existing affected Deep check protects the changed contract, register
   its actual dependency path in that Deep check and use `ci:pr` for Normal plus
   **the union of all affected Deep checks**. Never exempt a file from a Deep
   dependency merely because it also has Normal tests.
3. If a required invariant is not tested, first add a **shared old-fails /
   new-passes regression**. Put merge-critical contracts in Normal; put
   independent reproducibility, performance or genuinely expensive integration
   proofs in an affected Deep check, with its exact dependencies. No batch-ID
   fixture, unused test, or unrelated whole-Deep execution counts as a fix.
4. If proof of ownership or impact is still missing, **do not relabel a path as
   non-Deep** to make CI green. Leave it unclassified and fail closed. A full
   `ci:all` is an emergency verification fallback, not a substitute for
   registering the missing coverage. Fix the classifier coverage before the
   same omission can recur in routine batch production.

Coverage registration is **append-only in the narrow path manifest**: an
existing record cannot be silently removed, reassigned, or weakened.
The required Normal CI runs the binding's tests on the **exact PR HEAD**;
`tests/ci-registry.test.mjs` exercises positive routing, unregistered paths,
Deep precedence and registration tampering. Source files not explicitly
registered remain fail closed. Registry/runner/classifier implementation
changes remain the existing conservative full-Deep case until an independent
non-self-certifying proof of changed check selection is available. This avoids
letting a newly edited classifier certify its own reduction in coverage.
The separate candidate-only and documentation-only gates are unaffected.

When a Deep-owned implementation or contract changes, require successful
**exact-HEAD evidence for each affected Deep check**. The existing
`Validate and test Typewriter` PR check runs Normal and then only those checks
selected by the registry through `ci:pr`; CI classifier, registry, workflow,
or runner changes and unclassifiable paths fail closed to full `ci:all`.
Scheduled/manual `ci:all` still runs every current-system Deep check, and
`ci:deep` still selects all current-system Deep checks across scopes. Neither
redefines scoped `ci:historical`.

`deep_input_paths` describe data consumed by a check; they do not by themselves
mean that every byte change invalidates its independent performance or
reproducibility contract. `dependency_paths` identify implementation,
contract, test, or narrowly scoped evidence changes that do affect that check.
The classifier validates changed canonical JSONL rows against the current
record schema and validates the shape of recognized JSON data before allowing
routine data-only changes to take the Normal path. Source-bound relation
packets still pass the existing Normal factory and semantic-authority checks.
Stage 1 permanent trash chunks are **routine factory data** when their
paths match `data/candidate-trash/T######.jsonl` and the exact changed
HEAD bytes pass both strict JSONL parsing and the shared
`validateTrashChunk` contract (identity/digest, analysis variants,
occurrences, text-free source references, and the 500-row bound). Such
validated chunks, even when mixed with candidate rows, compact manifests
and `stage1-decisions.json`, require the **Normal** gate, not unrelated
Deep reproducibility or scale checks. The always-on Normal factory validator
continues to compare changed trash chunks with the merge base and across
changed/unchanged chunks, rejecting altered history and repeated observation
identities. No additional historical full scan is introduced solely by the
classifier. Other trash paths, malformed chunks, unrelated changed paths and
unverified evidence remain fail-closed; mixed trash+candidate PRs are **not**
eligible for the narrow candidate-only gate. This pattern applies to all
future valid chunk numbers, not a specific production batch.

Malformed data, unknown files, missing/empty diff evidence, and unregistered
test paths fail closed. Docs-only changes keep the exact-HEAD Normal skip, and
pure root-level Stage 1 candidate artifacts keep `ci:candidates`. The
classifier records exact base/HEAD, change class, matched dependencies,
selected Deep checks, skipped checks and the selected gate in the existing PR
check summary, followed by a final step outcome record for the gates actually
run and the job result; it does not publish another status check.

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
tagged for that scope; it has no all-history CLI default and stays outside weekly
Deep `ci:all`. The separate `.github/workflows/historical.yml` provides
`workflow_dispatch` for one scope or `all`, plus a weekly schedule that enumerates
all registered scopes as independent runs. This scheduled historical replay is
not a PR merge gate; a passing scheduled/other-HEAD run never substitutes for
the required exact-HEAD PR gate.

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
