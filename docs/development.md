# Typewriter Development Workflow

## Current requirements

The complete M2 toolchain uses the built-in `node:sqlite` module and the vendored
SQLite WASM runtime, and the product uses Vite 8.2.2. Together they require
Node.js 24.19.0 or newer (Node 24 LTS); CI uses Node.js 24.x.
From a clean clone, install the pinned dependencies before running the commands:

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

For a newly created Codex worktree without the required dependencies, use the
prepared machine-local store from the repository root:

```sh
corepack pnpm install --offline --frozen-lockfile --ignore-scripts \
  --store-dir "$HOME/.cache/typewriter/pnpm-store"
```

Skip this install when the worktree already has its required dependencies. Each
worktree has its own `node_modules`; do not symlink another worktree's directory.
If a changed lockfile causes an offline cache miss, report the specific missing
artifact. Store preparation or refresh requires an owner-authorized one-time
online frozen install; see [README development setup](../README.md#development).

The product MV3 shell uses Vue 3 with Vite. The two product entrypoints are
`popup.html` and `options.html`; their Vue source lives under `src/popup/` and
`src/options/`.
Use the following commands while working on the product shell:

```sh
pnpm run dev          # Vite development server
pnpm run build        # production MV3 assets in dist/, minified by esbuild
pnpm run test:unit    # Vitest component/unit tests
pnpm run test:mv3:product --chrome="/path/to/Google Chrome for Testing" # popup/options CFT check
```

Create the release ZIP in the default non-minified form, or explicitly request the
minified form. Both commands rebuild the product and validate the unpacked directory
and ZIP before returning:

```sh
TYPEWRITER_ZIP_DIR=/tmp/typewriter-package pnpm run package
TYPEWRITER_ZIP_DIR=/tmp/typewriter-package-minified pnpm run package:minify
pnpm run validate:package \
  --project-root="$PWD" \
  --dir=dist \
  --zip=/tmp/typewriter-package/generated-package.zip
```

Replace the placeholder ZIP path with the path printed by the packager. Its
filename is generated from `public/manifest.json#version`.

Without `TYPEWRITER_ZIP_DIR`, the ZIP is written to `~/Downloads`. The packager
builds into `dist/`, removes development-only output, copies the privacy,
release-identity, and license notices, creates an archive with stable paths,
timestamps, and file modes, then atomically moves the completed ZIP into place.
During local development, a dirty-worktree build must be explicit:
`TYPEWRITER_ALLOW_DIRTY=true TYPEWRITER_ZIP_DIR=/tmp/typewriter-package pnpm run package`.

For the release candidate, start from a clean checkout and use the single M8
handoff validation command. It runs normal CI, builds twice to prove that the ZIP
bytes reproduce, and exercises the exact package in Chrome for Testing:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run validate:release \
  --chrome="/path/to/Google Chrome for Testing" \
  --output-dir="/tmp/typewriter-release"
```

The command prints the validated ZIP's SHA-256 with the app, extension, dictionary,
schema, and source versions. It runs Chrome for Testing only as part of this
explicit release-candidate validation; ordinary CI does not run CFT. Only the
bundled software's Apache and third-party license notices are included in the
ZIP. The privacy policy source remains in `PRIVACY.md` for the Store disclosure
flow, while repository policy documents stay out of the package. The owner-approved
release scope permits Typewriter-authored dictionary data under the project data
license after exact-revision and package-content checks; raw corpus material and
specifically identified copied or restricted third-party content remain excluded.
See `DATA-LICENSE.md`.

When Chrome for Testing is available, verify both the unpacked build and the exact
ZIP contents after extraction:

```sh
pnpm run test:mv3:package \
  --chrome="/path/to/Google Chrome for Testing" \
  --extension=dist \
  --zip=/tmp/typewriter-package/generated-package.zip
```

The package runner first applies the package validator, then loads `dist/` and a
temporary extraction of the ZIP in isolated Chrome profiles. It runs the same popup
and Settings checks for search forms, expressions, empty and relation results,
content-sized layout, long-result scrolling, saved-option reflection, and zero
external requests. Chrome's GUI-only direct ZIP installation is not automated; the
extracted directory is the equivalent unpacked installation surface used by the
runner.

To check a real extension and dictionary update, add the previous production-shaped
unpacked package. The runner installs it into a temporary profile, saves settings,
replaces the extension files with the new ZIP contents under a higher test version,
then verifies the new source revision, exact, search-form, and generated-surface
lookups, and saved settings:

```sh
pnpm run test:mv3:package \
  --chrome="/path/to/Google Chrome for Testing" \
  --extension=dist \
  --zip=/tmp/typewriter-package/generated-package.zip \
  --previous-extension=/path/to/previous/unpacked
```

The package runner also checks exact, search-form, and generated-surface lookups
after replacement. It exercises missing, unreadable, corrupt,
schema-mismatched, dictionary-version-mismatched, revision-mismatched, and
foreign-key-invalid and incomplete database copies in CFT, including a fresh
worker retry from each load failure. Those fixture edits stay in temporary copies
and never change canonical data or the release package.

`pnpm run build` generates the product's packaged `dictionary.sqlite` and the
`runtime/` SQLite WASM worker assets after the Vite bundle. If the worktree is
dirty, use `TYPEWRITER_ALLOW_DIRTY=true pnpm run build` explicitly.

pnpm test runs the current normal CI gate and is equivalent to
pnpm run ci:normal. The category registry selects the active validation and test
suite instead of running every historical test file as one unfiltered glob. The
normal gate includes the product output contract checks. Use pnpm run test:unit
for Vue unit tests. Product/package verification runs through
pnpm run test:mv3:package.

The browser-based check covers the extension search runtime and the static landing
page (rendering, responsive layout, navigation, CTA links, keyboard focus, and zero
dictionary/WASM requests). It is an optional debugging tool; it does not run in `pnpm test` or CI. Build both products, install
Chromium once, then run the check:

```sh
pnpm run build
pnpm run build:web
pnpm exec playwright install chromium
pnpm run test:web:integration
```

On Linux systems missing browser libraries, install them with
`pnpm exec playwright install --with-deps chromium`.

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

The CI registry is the source of truth for automatic tests. Use a focused test
while editing its contract, then run the relevant registered gate from a clean
checkout before opening or updating a pull request:

```sh
node --test tests/validate-canonical-jsonl.test.mjs
node --test tests/validate-dataset-integrity.test.mjs
node --test tests/normalize-canonical.test.mjs
node --test tests/build-dictionary.test.mjs
pnpm run ci:normal
```

`ci:normal` requires an empty worktree and builds the current Canonical revision
once. `pnpm run ci:all` runs Normal plus the current-system Deep checks, including
the Full/Lite reproducibility audit. `pnpm run ci:deep` runs those Deep checks on
the current source. The exact registered files and their callers are listed in
[`test-inventory-823.md`](test-inventory-823.md).

A product build also requires a clean worktree. During local development, an
explicit dirty build is available with `TYPEWRITER_ALLOW_DIRTY=true pnpm run build`;
that output is not reproducibility evidence.

## Continuous integration

`.github/workflows/ci.yml` runs the applicable gate on pull requests and pushes to
`master`. Ordinary pull requests run `ci:normal`; changes to registered Deep
dependencies add only those affected checks through `ci:pr`. Documentation-only
changes may skip Normal and report the skip. Registry, runner, classifier,
workflow, unknown-path, and missing-diff cases retain the Normal fallback.

`.github/workflows/deep.yml` runs `ci:all` on its weekly schedule and supports
manual dispatch. It runs Normal followed by current-system Deep checks; `ci:deep`
selects Deep checks only. A skipped check is not passing evidence.

The Normal domains are Canonical validation, the build toolchain, relations,
product behavior, and generated artifacts. Each registered check has one domain
owner, one protected contract, one execution tier, and one schedule. The registry
also binds every Node test file once and shares an explicit list with Vitest.

## Manual product checks

These commands exercise current browser or packaged-extension behavior and are
invoked explicitly when that surface changes:

```sh
pnpm run test:web:integration
pnpm run test:extension:runtime
pnpm run test:mv3:product --chrome="/path/to/Google Chrome for Testing"
pnpm run test:mv3:package \
  --chrome="/path/to/Google Chrome for Testing" \
  --extension=dist \
  --zip=/tmp/typewriter-package/generated-package.zip
```

The Vitest watch command (`pnpm run test:unit:watch`) is a local editor loop, not a
CI route. The two browser scripts and the CFT package checks protect current web,
extension, interaction, offline-loading, and package boundaries. Retired task,
batch, migration, and scale checks are not kept as Manual test files.

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
