# Issue #464 CI Check Inventory

[`scripts/ci/check-inventory.json`](../scripts/ci/check-inventory.json) lists
every registered CI check and records its owner, protected contract, timing
estimate, tier, schedule, trigger, consumer, and keep/move reason.
`tests/ci-registry.test.mjs` verifies
that the inventory has exactly one row for every live registration and that its
owner, contract, tier, and schedule stay in sync with the runner.

Deep data dependencies are recorded as `deep_input_paths`; they describe
check inputs but do not by themselves trigger a PR Deep run. Contract
dependencies are recorded separately as `dependency_paths` and select only
their owning check(s). Non-Deep product files are an exact allowlist in
[`scripts/ci/deep-gate-known-non-deep-paths.json`](../scripts/ci/deep-gate-known-non-deep-paths.json);
pure Stage 1 candidate skips are limited to `manifest.json` and `candidates.jsonl`
at the candidate directory root. Routine canonical, relation-backfill,
inventory, reviewed-candidate, and report data must pass changed-row/schema or
JSON shape validation before classification can send the PR through Normal.
The existing Normal validators continue to enforce semantic authority,
provenance, integrity, freshness and product behavior.

The existing `Validate and test Typewriter` PR check runs `ci:normal` for
ordinary changes, `ci:pr --base <sha> --head <sha>` for Normal plus affected
Deep checks, or `ci:all` for full current-system Deep coverage. CI runner,
workflow, registry and classifier changes; unknown paths; and invalid data
evidence fail closed to `ci:all`. Docs-only changes retain the exact-HEAD
Normal skip, and pure Stage 1 artifacts retain `ci:candidates`. The check
summary records exact revisions, change class, matched dependencies, selected
and skipped checks, and the chosen gate. A final step records the gates that
actually ran and the job result. Classification remains within this single PR
status check.

## Classification

| Tier | Checks | Decision |
| --- | ---: | --- |
| Candidate | 2 | Added a no-SQLite gate for pure candidate artifact PRs. |
| Normal | 87 | Retained active canonical, factory, admission, build, search, product, and artifact contracts. |
| Deep | 8 | Retained current-system adversarial/reproducibility/scale checks; moved three exhaustive suites here. |
| Historical | 49 | Preserved completed batch/checkpoint replays for a bounded manual `ci:historical --scope <scope-id>` invocation; excluded from weekly Deep. |

No check is retired. `Test shared batch workflow` stays in Normal because it
covers the shared reviewed-import admission path and canonical-base preservation.
`Test target inventory` moves to Deep while the real inventory validator remains
inside the Normal global canonical audit. The relation backfill suite moves to
Deep while current relation admission and canonical integrity remain Normal.
The exhaustive artifact-policy test moves to Deep while
`scripts/validate/artifact-policy.mjs --clean` remains a live Normal check.

Four prior Deep entries, the independent Issue #219, #220, #222, and #223
checkpoint builds, move to Historical. They replay completed issue evidence;
they do not measure the current system. Current-revision SQLite
reproducibility, reproducible dictionary builds, and the release-shaped scale
benchmark remain in Deep.

Historical scopes are explicit and limited to one per command. Examples:
`pnpm run ci:historical --scope issue-219` replays the Issue #219 checks, while
`pnpm run ci:historical --scope m5-10a` replays only that M5-10A scope. The
registered IDs and per-check scope tags are recorded in
[`scripts/ci/legacy-check-history-scopes.json`](../scripts/ci/legacy-check-history-scopes.json)
and checked against the registry.

## Timing comparison

The pre-migration baseline is successful PR CI run
[#1091](https://github.com/neverworkalone/typewriter/actions/runs/37877241218)
at `8432af5ac6b76c07dbb69f050e7158df99958070`. Its 128 registered check
durations sum to **432.109 seconds**; the final Normal runner summary reports
**434.408 seconds**. Selecting the 87 checks that remain in Normal from those
same measurements sums to **128.156 seconds**, a **70.34% check-time reduction**.
The timing includes `Test shared batch workflow`, which is retained for its
active admission coverage.

The exact-head PR 2 GitHub `ci:normal` run
[#37892126250](https://github.com/neverworkalone/typewriter/actions/runs/37892126250)
on `d322694395053e3ca83c20e98252f6f0c3bf3450` after rebasing onto current master
measured **82.302 seconds**, which is an **81.05% wall-time reduction** against
the baseline runner summary.
It passed with one parent current-revision SQLite build and zero child builds.
The candidate-only gate passed locally in **2.817 seconds** and reported zero
current-revision SQLite builds; its two command measurements were 2.453 seconds
for factory validation and 0.116 seconds for freshness validation.

Baseline check estimates come from #1091 where present. Existing deep and
historical checks that #1091 did not run use completed GitHub CI runs
[#37884785791](https://github.com/neverworkalone/typewriter/actions/runs/37884785791)
and [#37635308613](https://github.com/neverworkalone/typewriter/actions/runs/37635308613).
Candidate check durations are local measurements and are explicitly labeled as
such in the inventory.
