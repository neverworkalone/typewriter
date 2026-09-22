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
npm run ci:fast
npm run ci:normal
npm run ci:all
npm run benchmark:canonical -- --sizes=500000,1000000 --sqlite-scale=500000,1000000 --fixed-level-evidence=config/ci-level-evidence.json
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

The public CI levels are nested:

- `ci:fast`: canonical, lexical, and toolchain gates for early pull-request
  feedback, including the complete global audit and one SQLite build.
- `ci:normal`: `ci:fast` plus current batch, product, and artifact gates.
- `ci:all`: `ci:normal` plus historical replay, independent current-revision
  reproducibility, and the 500K/1M synthetic benchmark.

Pull requests run one `ci:normal` process. It emits a `ci:fast` checkpoint
after the canonical, lexical, and toolchain categories, then continues with
the remaining normal categories in the same canonical session. This preserves
the full merge coverage without rerunning the fast work in a second process.
Master pushes run `ci:normal`; scheduled and manually dispatched runs run
`ci:all`. Each final level emits `ci-run-evidence-v1`; the nested checkpoint
emits `ci-run-checkpoint-v1`. Both include wall-clock time, canonical revision,
scan and SQLite-build metrics, context transport counts, and peak RSS for the
runner plus its isolated child processes.

The toolchain stage builds SQLite once after the global audit and passes the
same temporary database to schema, fidelity, query verification, search
regressions, and the product extension build. The product build copies that
exact current-revision artifact instead of rebuilding the canonical directory.
The two-independent-build reproducibility check is intentionally moved to
the deep portion of `npm run ci:all`, which is the manual/scheduled
deep-validation path. The full M5-12A admission/preflight replay is also deep
validation; normal CI retains the shared global audit and promoted-canonical
regressions without replaying admission-time product/package work.

Historical Wave A/Wave B replay is also reserved for the deep/manual level. The
normal path retains the batch contracts and current-canonical regressions that
protect merge correctness, while expensive historical/admission replay remains
available in `ci:deep` and `ci:all`.

For scale evidence, the benchmark generates self-authored synthetic JSONL
without adding a 500K/1M-record corpus to the repository. It runs the real
current-canonical corpus phases in the synthetic mode: semantic decision
materialization, topic evidence, complete lexical quality, dataset validation,
normalization, SQLite construction, shared-database validation, product
consumption, and two independent deep SQLite rebuilds. Each result records
wall-clock time, memory, validator result counts, canonical parse/index/scan
counts, SQLite build count, and context transport counts. These are reported
as corpus-dependent components, not as complete CI-level timings. Supplying
`--fixed-level-evidence` reads a checked-in exact-head evidence record. That
record stores the exact-head level wall-clock, the current-canonical corpus
baseline, and the derived fixed remainder; the benchmark adds only the fixed
remainder to each measured scale component so semantic/lexical/SQLite work is
not counted twice. Batch and historical replay checks remain against their
authoritative fixtures and are included in that fixed remainder; they are
intentionally not synthesized from generated records.

The checked-in evidence records the Actions run used for each level. For the
deep level, the fixed remainder is taken from the exact-head `ci:all` window
before the scale benchmark, so the 500K/1M benchmark itself is not counted
again when its measured corpus component is composed with the fixed work.

Synthetic JSONL generation and construction of the synthetic authored decision
source are fixture preparation, not CI runner gates, so both are excluded from
the reported corpus-dependent wall-clock component. The generated shape keeps
one reference-only noun sense per record and gives 23.8% of non-initial records
one `near` relation, matching the current canonical relation density closely
enough for scale measurement without introducing a second editorial corpus.
