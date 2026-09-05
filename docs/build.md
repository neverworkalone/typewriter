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

## SQLite dictionary

`node scripts/build/dictionary.mjs` consumes the in-memory normalized model and
creates `artifacts/dictionary.sqlite` from a fresh output path. The generated
database is ignored build output and is never an editable source. The builder
requires Node.js 22.5 or newer for the built-in `node:sqlite` module.

The schema in [`scripts/build/sqlite-schema.mjs`](../scripts/build/sqlite-schema.mjs)
contains only the current lookup model:

- `records` preserves record identity, `entry`/`expression`, role, optional
  candidate, and lemma;
- `search_forms` preserves every form and its source position;
- `senses` preserves source record, sense position, part of speech, and gloss;
- `relations` preserves source sense order, target record/sense, relation type, and
  note;
- `metadata` stores deterministic contract versions and generated row counts.

Exact lemma and search-form indexes support lookup. Sense-by-record and
source/target relation indexes support ordered record and relation traversal. The
builder inserts records and senses before relations so forward references work, and
SQLite foreign keys plus integrity checks verify the resulting graph. Each build
removes the requested generated file first; it does not depend on an existing DB or
apply migrations. An output path inside `data/canonical/` is rejected.

The read-only helpers in [`scripts/build/query.mjs`](../scripts/build/query.mjs)
support exact term lookup, complete record/sense retrieval, and source-sense
relations with target lemma, part of speech, and gloss display. Fuzzy search,
ranking, morphology, user data, and extension runtime integration are outside this
contract.

## MV3 SQLite WASM proof

`node scripts/extension/build-proof.mjs` assembles a self-contained extension
directory at `dist/mv3-proof/`. It contains the generated `dictionary.sqlite`, the
module worker, the proof page, and the pinned `@sqlite.org/sqlite-wasm` module plus
WASM binary. The manifest has no permissions, host permissions, or
`web_accessible_resources`; an extension-origin worker can fetch its own packaged
database without exposing it to web origins. The worker deserializes the database
into an in-memory SQLite connection, enables `query_only`, runs exact
lemma/search-form/relation lookups, and verifies that a write is rejected and not
persisted.

The proof runs in an action popup extension page (`proof.html`) that creates a
dedicated module worker (`sqlite-worker.mjs`). It does not use a service worker or
offscreen document. The worker lifetime is tied to the proof page and the page
terminates it after the result. Package-relative `chrome.runtime.getURL()` and
`self.location` URLs are used for all assets; no filesystem path, CDN, or runtime
external request is part of the contract. The generated SQLite is read-only runtime
output derived from canonical JSONL and is never the source of truth.

The static/package checks run as part of the normal test suite. When Chrome for
Testing is available, run the actual MV3 proof with:

```sh
npm run build:proof -- --allow-dirty
npm run test:mv3:chrome -- \
  --chrome="/path/to/Google Chrome for Testing"
```

The CFT runner discovers the unpacked extension ID through `chrome://extensions/`,
opens `proof.html`, blocks ordinary network resolution, and fails if the proof page
makes a non-extension request or if the read-only assertion fails. The current proof
uses `@sqlite.org/sqlite-wasm` 3.53.0-build1 under its Apache-2.0 license; see
`extension/mv3-proof/THIRD-PARTY-NOTICES.txt` and the included full license copy
`extension/mv3-proof/Apache-2.0.txt`.

실제 검증 기록 (2026-09-05, Chrome for Testing 152.0.7977.76): unpacked MV3
패키지가 로드됐고 `Proof passed`를 반환했다. 비확장 요청은 0건이었으며, SQLite
3.53.0에서 `query_only = 1`, `담담하다` lemma, `담담` search form, `w026-s1`
관계가 조회됐다. 쓰기 시도는 차단됐고 테스트 행은 저장되지 않았다.

## Reproducibility and provenance

The builder records `dictionary_version`, `schema_version`,
`normalization_version`, `build_tool_version`, `node_version`, `sqlite_module`,
`sqlite_version`, source revision fields, and generated row counts in `metadata`.
It does not record a build timestamp, absolute input path, or output path.

By default, `source_revision` is the full Git `HEAD` commit and the source
worktree must be clean. A dirty worktree fails with `DIRTY_WORKTREE`; passing
`allowDirty: true` is an explicit escape hatch for local or otherwise
non-reproducible builds and records `worktree_state: "dirty-allowed"`. An explicit
commit revision is resolved and verified when Git is available. In a Git-less
environment, only a full 40-character SHA may be injected, and the metadata marks
it as `source_revision_verified: "false"` and `worktree_state: "unavailable"`.
When Git is available, an explicit revision must resolve to the current `HEAD`; the
builder does not materialize historical commits, so a different commit is rejected
instead of being recorded as verified provenance.

`readLogicalDatabaseSnapshot` in [`scripts/build/query.mjs`](../scripts/build/query.mjs)
compares the schema, named indexes, and ordered contents of every dictionary table.
Two builds with the same canonical revision and fixed runtime/tool inputs must have
the same logical snapshot. SQLite byte-for-byte identity is not required: page
layout and other file-level details are implementation artifacts rather than part of
the dictionary contract.
