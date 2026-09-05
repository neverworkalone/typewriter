# Canonical JSONL validator

## Requirements

Node.js 18 or newer. The validator has no third-party runtime dependencies.

## Commands

From the repository root:

```sh
node scripts/validate/canonical-jsonl.mjs
node scripts/validate/dataset-integrity.mjs
node --test tests/validate-canonical-jsonl.test.mjs
node --test tests/validate-dataset-integrity.test.mjs
```

The validator scans only `data/canonical/` and its `.jsonl` files. It does not scan
drafts, external references, generated output, or test fixtures during the normal
command. A missing canonical directory is an initial empty state: the command exits
successfully and reports that it validated zero files and records; this is not a
claim that the dictionary is complete.

It validates UTF-8 decoding, JSON parsing, and the row-level shape in
`schema/canonical-record.schema.json`. Each non-empty line must contain one current
Editorial Model v1 record. A single final newline is allowed, while blank rows and
schema errors are rejected with the file path and 1-based line number. Cross-record
references, relation ownership, dataset completeness, normalization, and SQLite
building are handled by later M2 commands. The dataset command runs the current
`w001`–`w300` pilot completeness regression by default; pass
`--no-pilot-regression` when validating a smaller independent fixture.
