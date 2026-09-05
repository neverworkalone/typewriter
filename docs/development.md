# Typewriter Development Workflow

## Current requirements

The current validation tools require Node.js 18 or newer and have no third-party
runtime dependencies. The CI workflow uses Node.js 20.x. There is no dependency
installation step; the commands use Node.js built-ins only.

For a clean-checkout verification, clone the repository into a new directory and run
the commands below from its root. The checkout must not contain local drafts,
external responses, generated databases, or credential files.

## Local validation

Run both commands before opening or updating a pull request:

```sh
node scripts/validate/canonical-jsonl.mjs
node scripts/validate/dataset-integrity.mjs
node --test tests/validate-canonical-jsonl.test.mjs
node --test tests/validate-dataset-integrity.test.mjs
```

The first command scans only `data/canonical/` and recursively visits its `.jsonl`
files. It does not scan `data/draft/`, `data/reference/`, generated output, or test
fixtures. Each row must also satisfy [`schema/canonical-record.schema.json`](../schema/canonical-record.schema.json).
A repository with no `data/canonical/` directory is an initial empty state: the
validator exits successfully and reports zero files and records, but that output does
not mean the dictionary is complete.

The test command runs self-authored fixtures for valid entry/expression records, JSON
syntax errors after a valid row, blank rows, invalid UTF-8, schema omissions and enum
errors, expression/part-of-speech mismatches, final-newline handling, empty input,
and the real CLI's exit status. The invalid fixtures are expected inputs inside
assertions; the test command itself should pass.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests and pushes to `master`. It checks out
the revision under review, installs no project dependencies, selects Node.js 20.x,
and runs the same validator and regression commands as the local workflow:

1. `node scripts/validate/canonical-jsonl.mjs`
2. `node --test tests/validate-canonical-jsonl.test.mjs`
3. `node scripts/validate/dataset-integrity.mjs`
4. `node --test tests/validate-dataset-integrity.test.mjs`

The workflow proves that the documented JSONL and dataset validators and their
regression tests run in a clean environment. It does not claim that the canonical
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
| M2 | Formal JSONL schema and lexical fields, dataset-wide reference and relation integrity, duplicate and part-of-speech checks, normalization, deterministic SQLite build, and generated metadata. |

Do not extend the M0 workflow to enforce an unvalidated lexical schema or to build the
Chrome product. Those checks belong to the milestone where their requirements are
established.
