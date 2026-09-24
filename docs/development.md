# Typewriter Development Workflow

## Current requirements

The complete M2 toolchain uses the built-in `node:sqlite` module and the vendored
SQLite WASM runtime, and the product uses Vite 8.2.2. Together they require
Node.js 22.13.0 or newer; CI uses Node.js 22.13.x.
Install the pinned runtime before running the commands:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npx playwright install chromium
```

The Playwright command installs Chromium for the browser-level product runtime
parity check included in `npm test`. On Linux CI, install its system dependencies
as well with `npx playwright install --with-deps chromium`.

The product MV3 shell uses Vue 3 with Vite. The two product entrypoints are
`popup.html` and `options.html`; their Vue source lives under `src/popup/` and
`src/options/`.
Use the following commands while working on the product shell:

```sh
npm run dev          # Vite development server
npm run build        # production MV3 assets in dist/, minified by esbuild
npm run test:unit    # Vitest component/unit tests
npm run test:mv3:product -- --chrome="/path/to/Google Chrome for Testing" # popup/options CFT check
```

Create the release ZIP in the default non-minified form, or explicitly request the
minified form. Both commands rebuild the product and validate the unpacked directory
and ZIP before returning:

```sh
TYPEWRITER_ZIP_DIR=/tmp/typewriter-package npm run package
TYPEWRITER_ZIP_DIR=/tmp/typewriter-package-minified npm run package:minify
npm run validate:package -- \
  --project-root="$PWD" \
  --dir=dist \
  --zip=/tmp/typewriter-package/typewriter_1.0.zip
```

Without `TYPEWRITER_ZIP_DIR`, the ZIP is written to `~/Downloads`. The packager
builds into `dist/`, removes development-only output, copies the full Apache-2.0
license and third-party notice, and atomically moves the completed ZIP into place.
During local development, a dirty-worktree build must be explicit:
`TYPEWRITER_ALLOW_DIRTY=true TYPEWRITER_ZIP_DIR=/tmp/typewriter-package npm run package`.

When Chrome for Testing is available, verify both the unpacked build and the exact
ZIP contents after extraction:

```sh
npm run test:mv3:package -- \
  --chrome="/path/to/Google Chrome for Testing" \
  --extension=dist \
  --zip=/tmp/typewriter-package/typewriter_1.0.zip
```

The package runner first applies the package validator, then loads `dist/` and a
temporary extraction of the ZIP in isolated Chrome profiles. It runs the same popup
and Settings checks for search forms, expressions, empty and relation results,
content-sized layout, long-result scrolling, saved-option reflection, and zero
external requests. Chrome's GUI-only direct ZIP installation is not automated; the
extracted directory is the equivalent unpacked installation surface used by the
runner.

`npm run build` generates the product's packaged `dictionary.sqlite` and the
`runtime/` SQLite WASM worker assets after the Vite bundle. If the worktree is
dirty, use `TYPEWRITER_ALLOW_DIRTY=true npm run build` explicitly.

npm test runs the current normal CI gate and is equivalent to
npm run ci:normal. The category registry selects the active validation and test
suite instead of running every historical test file as one unfiltered glob. The
normal gate includes Playwright Chromium product-runtime parity, so install the
browser once with `npx playwright install chromium` after npm ci. Use
npm run test:unit for Vue unit tests. Product/package verification runs through
npm run test:mv3:package.

The product popup and options page use only extension-local assets and the
storage permission. When Chrome for Testing is available, the product CFT check
loads both entrypoints, searches the packaged dictionary, follows a relation and
returns with back, verifies keyboard focus, checks the five default toggles, and
reloads Settings to confirm explicit-save persistence. It also checks that the
empty result stays content-sized, that the four-sense `쓰다` result actually
overflows and scrolls inside the popup, verifies the product runtime's SQLite
`query_only` and write rejection, and confirms that search/focus/footer remain
available. It fails if the pages make a non-extension request. The runner uses
isolated temporary profiles with `--password-store=basic` and
`--use-mock-keychain`; it never uses the user's Chrome account or macOS Keychain.

For a clean-checkout verification, clone the repository into a new directory and run
the commands below from its root. The checkout must not contain local drafts,
external responses, generated databases, or credential files.

## Local validation

Run validation, normalization, build, and reproducibility checks before opening or
updating a pull request:

```sh
node scripts/validate/canonical-jsonl.mjs
node scripts/validate/dataset-integrity.mjs
node --test tests/validate-canonical-jsonl.test.mjs
node --test tests/validate-dataset-integrity.test.mjs
node scripts/normalize/canonical.mjs
node --test tests/normalize-canonical.test.mjs
node scripts/build/dictionary.mjs
node --test tests/build-dictionary.test.mjs
node --test tests/reproducibility.test.mjs
```

For the complete CI-equivalent sequence, use `npm run ci:all` from a clean
checkout. Focused work can run one responsibility at a time with
`npm run ci:category -- <category>`; the category runner replaces the old full
CI test glob and keeps each test file in one declared ownership group.

The one-command M2 audit runs the schema and dataset checks, normalization, two
logical reproducibility builds, representative queries, and metadata comparisons.
Use `--allow-dirty` only while developing in a dirty worktree:

```sh
node scripts/verify/m2-pipeline.mjs --allow-dirty
```

The default SQLite build requires a clean Git worktree. While developing locally,
`node scripts/build/dictionary.mjs --allow-dirty` is an explicit non-reproducible
escape hatch; CI always builds from a clean checkout.

For the M5 reviewed batch workflow, keep the raw draft and reviewed staging JSONL in
an external temporary workspace. Validate the metadata manifest and staged rows
before a deliberate canonical import:

```sh
npm run batch:validate -- \
  --manifest=/tmp/typewriter-m5-2/batch.json \
  --staged-records=/tmp/typewriter-m5-2/reviewed.jsonl \
  --semantic-audit=/tmp/typewriter-m5-2/semantic-audit.json
npm run batch:import -- \
  --manifest=/tmp/typewriter-m5-2/batch.json \
  --staged-records=/tmp/typewriter-m5-2/reviewed.jsonl \
  --semantic-audit=/tmp/typewriter-m5-2/semantic-audit.json \
  --output=/tmp/typewriter-m5-2/canonical-import.jsonl

npm run batch:process:check
npm run batch:repair:check
npm run batch:m5-10d:contract:check
# M5-10D keeps its calibration-only proposal separate from canonical data.
npm run batch:m5-10d:calibration:prepare
# After initial-review judgment rows are complete, freeze the recorder-owned follow-up source.
npm run batch:m5-10d:recovery:contract:check
npm run batch:m5-10d:recovery:check
npm run batch:m5-10d:authorization:check
# Start and stop each calibration pass explicitly; the command persists its session.
npm run batch:m5-10a:calibration:timing -- \
  --action=start --pass=target-preparation --output=/tmp/typewriter-m5-10a-timing-session.json
npm run batch:m5-10a:calibration:timing -- \
  --action=stop --pass=target-preparation \
  --input=/tmp/typewriter-m5-10a-timing-session.json \
  --output=/tmp/typewriter-m5-10a-timing-session.json
npm run batch:m5-10a:calibration:timing -- \
  --action=start --pass=final-audit \
  --input=/tmp/typewriter-m5-10a-timing-session.json \
  --output=/tmp/typewriter-m5-10a-timing-session.json
# Stop final-audit only after reviewing all 20 cases; include the generated raw-proposal digest.
npm run batch:m5-10a:calibration:timing -- \
  --action=stop --pass=final-audit \
  --case-ids=m5-10a-cal-001,...,m5-10a-cal-020 \
  --raw-proposal-sha256=<sha256> \
  --input=/tmp/typewriter-m5-10a-timing-session.json \
  --output=/tmp/typewriter-m5-10a-timing-session.json
# Commit a separately authored per-case audit input before building. The builder
# refuses a missing audit and derives counts/rates/gate status from its decisions.
# The default path is data/batches/m5-10a-relation-calibration-audit.json.
npm run batch:m5-10a:calibration:build
npm run batch:m5-10a:calibration:check
npm run batch:m5-10a:process:check
npm run batch:m5-10a:repair:check
npm run batch:timing:feedback -- \
  --manifest=/tmp/typewriter-wave/manifest.json \
  --output=/tmp/typewriter-wave/feedback.json
npm run batch:timing:start -- \
  --manifest=/tmp/typewriter-wave/feedback.json \
  --output=/tmp/typewriter-wave/audit-started.json \
  --pass=post-review-audit
npm run batch:timing:stop -- \
  --manifest=/tmp/typewriter-wave/audit-started.json \
  --output=/tmp/typewriter-wave/audit-complete.json \
  --pass=post-review-audit
```

The import helper never edits `data/canonical/`; it only emits validated rows outside
the repository. See [`m5-batch-workflow.md`](m5-batch-workflow.md) for the manifest,
ID allocation, reference-closure, and reproducibility contract.

When a review event creates a follow-up cycle, run
`npm run batch:timing:feedback` at the event. It records the current UTC clock,
generates the paired cycle automatically, and writes a new manifest to the
`--output` path. Use `batch:timing:start` and `batch:timing:stop` around every
editorial session; stop derives wall-clock and editor seconds from the recorded
start/stop timestamps. The CLI does not accept user-supplied timestamps or
durations and does not estimate or backfill work.

The first command scans only `data/canonical/` and recursively visits its `.jsonl`
files. It does not scan `data/draft/`, `data/reference/`, generated output, or test
fixtures. Each row must also satisfy [`schema/canonical-record.schema.json`](../schema/canonical-record.schema.json).
A repository with no `data/canonical/` directory is an initial empty state: the
validator exits successfully and reports zero files and records, but that output does
not mean the dictionary is complete.

The validator test commands run self-authored fixtures for valid entry/expression
records, JSON syntax errors after a valid row, blank rows, invalid UTF-8, schema
omissions and enum errors, expression/part-of-speech mismatches, final-newline
handling, empty input, and the real CLI's exit status. The dataset validator tests
cover cross-record references, relation ownership, duplicate/self-reference checks,
and part-of-speech constraints. The normalization tests cover defaults, ordering,
meaning preservation, file batching, idempotence, input immutability, and refusal of
invalid datasets. Invalid fixtures are expected inputs inside assertions; the test
commands themselves should pass.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `master`. It checks out
the revision under review, installs the pinned dependency with `npm ci`, selects
Node.js 22.13.x, installs Playwright Chromium and its system dependencies, then
runs `npm run ci:normal` in one process. The normal runner emits the `ci:fast`
checkpoint and then continues with the remaining normal checks; the fast
checkpoint is not started as a second GitHub Actions workflow.

`.github/workflows/deep.yml` owns scheduled and manual full validation. It runs
`npm run ci:all`, which includes normal validation followed by historical replay,
reproducibility, and the scale benchmark. Its weekly schedule is Sunday 22:00 UTC
(Monday 07:00 KST).

The normal category order is:

1. `npm run ci:category -- canonical` — manifest, canonical, dataset, inventory, and rule checks;
2. `npm run ci:category -- lexical` — shared lexical and semantic validation;
3. `npm run ci:category -- toolchain` — normalization, SQLite, and integrated M2 checks;
4. `npm run ci:category -- batch` — batch process, contract, recovery, and authorization checks;
5. `npm run ci:category -- product` — shared search, unit tests, and extension build;
6. `npm run ci:category -- artifacts` — package/artifact tests and the final clean-checkout policy.

The deep-only additions are `historical` replay and the `deep` category. To run the
complete sequence locally, use `npm run ci:all`.

The registry in `scripts/ci/registry.mjs` owns every root `tests/*.test.mjs` file
exactly once. Each declared check is logged by name and has its own execution
boundary; checks run sequentially and a failure stops the category before any later
check starts. Historical runner inputs are copied to an external temporary directory by
`scripts/ci/run-category.mjs`; the workflows do not need one YAML step per
materialization. A representative future batch check should be added to the
appropriate registry category rather than to a workflow file.

Release ZIP creation (`npm run package` and `npm run package:minify`) and Chrome for
Testing package verification (`npm run test:mv3:package`) are intentionally deferred
from ordinary pre-1.0 PR/push CI to keep feedback focused and inexpensive. The
underlying scripts remain available for explicit manual execution and future
release-oriented automation; this is a scheduling decision, not deprecation. The
workflows prove that the documented JSONL, dataset, normalization, SQLite,
integrated-audit, regression, unit-test, and product-build checks run in a clean
environment. It does not claim that the canonical dictionary has editorial,
lexical, relation, or coverage quality.

## Failure diagnosis

Validator errors include the repository-relative file path and, for row-level input,
the 1-based line number. Typical causes are:

- `invalid UTF-8 encoding`: save the file as UTF-8 and remove the malformed bytes;
- `empty lines are not allowed`: remove the blank row; one final newline is allowed;
- `invalid JSON`: inspect the reported line for a JSON syntax error.
- `schema validation failed`: inspect the reported `$` path and add or correct only
  the current Editorial Model v1 fields; cross-record references are checked by the
  later dataset validator.
- `relation target ... does not exist` or `target_sense ...`: inspect the target
  record and sense IDs. The dataset validator checks ownership and existence but
  does not create, reverse, or classify relations.

When the validator reports zero files and records, first confirm that canonical data
has not been added yet. Do not treat an empty initial dataset as a successful
dictionary-data review. If a new path is being scanned unexpectedly, check that the
command is being run from the repository and that only `data/canonical/` is used as
the canonical input location.

Do not place raw API responses, scraped material, unreviewed drafts, or secrets in the
repository to reproduce a failure. Keep those materials outside the repository and
use the smallest self-authored fixture that demonstrates the behavior.

## Scope by milestone

| Stage | Validation that belongs there |
| --- | --- |
| M0 | Canonical-only file discovery, strict UTF-8 decoding, JSON parsing, blank-row and final-newline behavior, empty initial state, line-aware errors, and repeatable tests/CI. |
| M1 | Editorial model and pilot-data review: senses, expressions, relation categories, and the criteria used to curate writer-facing records. |
| M2 | Formal JSONL schema and lexical fields, dataset-wide reference and relation integrity, duplicate and part-of-speech checks, normalization, deterministic SQLite build, generated metadata, and SQLite data regression. |

Do not extend the M0 workflow to enforce an unvalidated lexical schema or to build the
Chrome product. Those checks belong to the milestone where their requirements are
established.
