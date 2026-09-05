# Typewriter build contracts

## Normalization

`node scripts/normalize/canonical.mjs` reads canonical JSONL only after the row
schema validator and dataset-integrity validator have succeeded. It returns a
logical model in memory for the next build step. It does not write a normalized
dataset and never overwrites `data/canonical/`.

The normalization contract is intentionally small:

- canonical `.jsonl` files are discovered recursively and read in lexical path
  order by the canonical reader;
- records are ordered by `id`, so moving unchanged records between input files does
  not change the logical result;
- sense order, `search_forms` order, and relation order inside each record are
  preserved;
- an absent `candidate_id` becomes internal `null`;
- an absent `relations` field becomes internal `[]`;
- an absent relation `target_sense` becomes internal `null`;
- IDs, lemma/search forms, parts of speech, glosses, relation types, and notes are
  copied without language, lexical, or editorial correction;
- no relation is created, reversed, or symmetrized, and no sense is merged or
  split.

The output is an object with `normalization_version: "1"` and a `records` array.
It is a build input, not a second source of truth and is not committed as a
normalized dataset. The mapping is pure and idempotent: applying
`normalizeRecords` to its own `records` produces the same logical object.

The command runs the current `w001`–`w300` pilot completeness regression by
default. Use `--no-pilot-regression` for a smaller valid fixture; schema and
dataset-integrity validation still run in either mode.

SQLite building, generated artifacts, and runtime packaging are separate later
contracts. This issue does not introduce them.
