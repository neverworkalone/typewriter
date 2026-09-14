# Canonical JSONL validator

## Requirements

Node.js 18 or newer. The validator has no third-party runtime dependencies.

## Commands

From the repository root:

```sh
node scripts/validate/canonical-jsonl.mjs
node scripts/validate/dataset-integrity.mjs
node scripts/validate/lexical-quality.mjs
node scripts/validate/semantic-audit.mjs
node --test tests/validate-canonical-jsonl.test.mjs
node --test tests/validate-dataset-integrity.test.mjs
node --test tests/lexical-quality.test.mjs
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
building are handled by later M2 commands. The dataset command requires the
current `w001`–`w300` pilot candidates by default; additional post-pilot start
candidates are allowed for M5 expansion. Pass `--no-pilot-regression` when
validating a smaller independent fixture.

`lexical-quality.mjs` is the shared dictionary-wide semantic gate. It audits the
complete canonical directory and the same prospective canonical set used by
reviewed batch importers. It covers expression/POS shape, placeholder glosses,
and writer-domain sense boundaries. The semantic-audit v2 contract separates
deterministic content coverage from authored semantic decisions:
`data/validation/canonical-semantic-coverage.json` contains only source facts and
digests, `data/validation/canonical-semantic-review.json` contains the complete
decision rows, and `data/validation/canonical-semantic-audit.json` binds both to
one canonical snapshot. Admission consumes a pre-written matching envelope; it
never regenerates semantic decisions from the records it is admitting. A batch
may add scope, reserve, timing, or authorization rules, but it cannot bypass
this common audit or introduce a batch/ID allowlist. Candidate-producing
workflows additionally use the batch-neutral
`scripts/batch/lexical-production.mjs` contract for complete candidate coverage,
source-bound semantic review, and selection.
