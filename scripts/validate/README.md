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
npm run ci:all
npm run ci:deep
npm run benchmark:canonical -- --sizes=10000,100000,500000 --sqlite-scale=10000
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
and writer-domain sense boundaries. The semantic-audit v3 contract separates
deterministic content coverage from authored semantic decisions. The durable
`data/validation/canonical-semantic-decision-source.json` contains the authored
decision source, while the current coverage, review, and audit envelope are
rebuilt deterministically in memory for each validation. Historical audit
envelopes remain tracked where an immutable replay contract binds their exact
bytes. Admission consumes the authored decision source and a matching in-memory
envelope; it never manufactures semantic decisions from the records it is
admitting. A batch may add scope, reserve, timing, or authorization rules, but
it cannot bypass this common audit or introduce a batch/ID allowlist.
Candidate-producing workflows additionally use the batch-neutral
`scripts/batch/lexical-production.mjs` contract for complete candidate coverage,
source-bound semantic review, and selection.

## Shared CI context

The CI runner creates one fresh `canonical-context-v1` session for the current
canonical revision. The session loads and schema-validates canonical JSONL once,
then shares record/sense/candidate/relation indexes, semantic topic evidence,
and the lexical audit report as the same in-process context object. Production
canonical gates run in that process; fixture and unit tests remain isolated
subprocesses and do not inherit the context transport. A context artifact, when
used by an external caller, is bound to the canonical directory and revision.
External context consumers must provide the expected digest in
`TYPEWRITER_CANONICAL_REVISION`; an unbound context is rejected.
The global canonical audit remains mandatory; a changed-only check cannot
replace it.

The toolchain stage builds SQLite once after the global audit and passes the
same temporary database to schema, fidelity, and query verification. The
two-independent-build reproducibility check is intentionally moved to
`npm run ci:deep`, which is the manual/scheduled deep-validation path. The
pull-request `ci:all` path verifies the one shared current-revision artifact.

For scale evidence, the benchmark generates self-authored synthetic JSONL
without adding a 500K-record corpus to the repository. Each result records
wall-clock time, memory, validator result counts, canonical parse/index/scan
counts, SQLite build count, and context transport counts. The benchmark's
`same-process-shared-context` wiring matches the PR runner; a 500K run is
intended for manual or scheduled validation rather than ordinary pull requests.
