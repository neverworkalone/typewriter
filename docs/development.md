# Typewriter Development Workflow

## Current requirements

The complete M2 toolchain uses the built-in `node:sqlite` module and the vendored
SQLite WASM runtime, and the product uses Vite 8.2.2. Together they require
Node.js 22.13.0 or newer; CI uses Node.js 22.13.x.
Install the pinned runtime before running the commands:

```sh
npm ci --ignore-scripts --no-audit --no-fund
```

The product MV3 shell uses Vue 3 with Vite and is kept separate from the M2 proof
under `extension/mv3-proof/`. The two product entrypoints are `popup.html` and
`options.html`; their Vue source lives under `src/popup/` and `src/options/`.
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
  --zip=/tmp/typewriter-package/typewriter_0.3.0.zip
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
  --zip=/tmp/typewriter-package/typewriter_0.3.0.zip
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

`npm run test` remains the Node.js test command for the M2 toolchain. The product
build does not replace or modify the M2 proof source or its generated package.

The product popup and options page use only extension-local assets and the
storage permission. When Chrome for Testing is available, the product CFT check
loads both entrypoints, searches the packaged dictionary, follows a relation and
returns with back, verifies keyboard focus, checks the five default toggles, and
reloads Settings to confirm explicit-save persistence. It also checks that the
empty result stays content-sized, that the four-sense `쓰다` result actually
overflows and scrolls inside the popup, and that search/focus/footer remain
available. It fails if the pages make a non-extension request. The runner uses
--use-mock-keychain because it is an isolated automation profile and does not
need macOS Keychain-backed browser credentials.

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
node --test tests/*.test.mjs
```

The one-command M2 audit runs the schema and dataset checks, normalization, two
logical reproducibility builds, representative queries, metadata comparisons, and
the packaged MV3 asset build. Use `--allow-dirty` only while developing in a dirty
worktree:

```sh
node scripts/verify/m2-pipeline.mjs --allow-dirty
```

Build the packaged MV3 proof locally with the same clean-build contract. While
developing locally, pass `--allow-dirty` explicitly if the worktree has uncommitted
changes:

```sh
node scripts/extension/build-proof.mjs --allow-dirty
```

The default SQLite build requires a clean Git worktree. While developing locally,
`node scripts/build/dictionary.mjs --allow-dirty` is an explicit non-reproducible
escape hatch; CI always builds from a clean checkout.

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
Node.js 22.13.x, and runs the same validator, normalization, SQLite build, MV3 package,
integrated audit, and regression commands as the local workflow:

1. `node scripts/validate/canonical-jsonl.mjs`
2. `node --test tests/validate-canonical-jsonl.test.mjs`
3. `node scripts/validate/dataset-integrity.mjs`
4. `node --test tests/validate-dataset-integrity.test.mjs`
5. `node scripts/normalize/canonical.mjs`
6. `node --test tests/normalize-canonical.test.mjs`
7. `node scripts/build/dictionary.mjs`
8. `node scripts/extension/build-proof.mjs`
9. `node scripts/verify/m2-pipeline.mjs`
10. `node --test tests/*.test.mjs`
11. `npm run test:unit`
12. `npm run build`
13. `npm run package`
14. Chrome verification of the non-minified package
15. `npm run package:minify`
16. Chrome verification of the minified package

The workflow proves that the documented JSONL, dataset, normalization, SQLite,
reproducibility, integrated audit, MV3 package, and both Chrome-loaded release
package checks run in a clean environment. It does not claim that the canonical
dictionary has editorial, lexical, relation, or coverage quality.

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
| M2 | Formal JSONL schema and lexical fields, dataset-wide reference and relation integrity, duplicate and part-of-speech checks, normalization, deterministic SQLite build, generated metadata, and the packaged MV3 SQLite WASM proof. |

Do not extend the M0 workflow to enforce an unvalidated lexical schema or to build the
Chrome product. Those checks belong to the milestone where their requirements are
established.
