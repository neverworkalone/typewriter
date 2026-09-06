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
requires Node.js 22.13.0 or newer for the built-in `node:sqlite` module and the
product Vite toolchain.

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
support the same conservative search response as the product worker: raw query,
NFC-plus-surrounding-trim normalization, exact lemma/search-form provenance,
reference-only blocking, and structured `no-match`/`unsupported` outcomes.
Complete record/sense retrieval and source-sense relations include target lemma,
part of speech, and gloss display. Fuzzy search, ranking, morphology, user data,
and extension runtime integration beyond this shared contract are outside this
milestone.

## Product dictionary runtime

`npm run build` also assembles the product runtime under `dist/`:

- `dictionary.sqlite` is generated from the canonical JSONL pilot data;
- `runtime/dictionary-worker.mjs` is the dedicated module worker;
- `runtime/protocol.js` contains the versioned request/response contract;
- `runtime/query-adapter.js` is the browser-facing read-only adapter; and
- `runtime/search-query.js` contains the shared pure search normalizer and response
  contract; and
- `runtime/vendor/sqlite3.mjs` plus `runtime/vendor/sqlite3.wasm` are the pinned
  SQLite WASM runtime assets.

The main-thread adapter in [`src/runtime/query-adapter.js`](../src/runtime/query-adapter.js)
exposes only exact start-record search, record/sense/relation reads, metadata, and
runtime status. The worker and Node helper share
[`src/runtime/search-query.js`](../src/runtime/search-query.js), so raw and
normalized query fields plus match provenance use one implementation.
Reference-only records can be fetched by ID for relation display, but are never
returned from free-term search. The worker loads its own packaged
database with extension-relative URLs, keeps one initialization promise, enables
`PRAGMA query_only = ON`, and returns structured errors for asset, WASM, database,
query, and lifecycle failures. During the same product load it verifies that a
representative SQLite write is rejected and leaves no persisted row; runtime status
exposes `query_only`, `write_blocked`, and `persisted_write_count` for the product
Chrome check. The manifest allows WASM evaluation for extension pages while
retaining only the `storage` permission, no host permissions, and no web-accessible
dictionary asset.

The product build uses the same clean-worktree provenance contract as the SQLite
builder. During local development with uncommitted changes, use the explicit
escape hatch:

```sh
TYPEWRITER_ALLOW_DIRTY=true npm run build
```

The generated product database and runtime assets are build output; canonical JSONL
remains the editable source of truth.

## Product release package

`npm run package` creates the default non-minified Chrome release package. The
optional `npm run package:minify` command uses the same inputs and validator with
Vite/esbuild minification enabled. Both commands rebuild `dist/`, then create
`<repository>_<manifest-version>.zip` in `TYPEWRITER_ZIP_DIR` or, by default, in
`~/Downloads`.

The package contains only the MV3 product surface: `manifest.json`, `popup.html`,
`options.html`, Vite assets/chunks, the current generated `dictionary.sqlite`, the
SQLite worker/protocol/query adapter, the pinned SQLite JavaScript/WASM runtime,
icons and `logo.png`, plus the full `Apache-2.0.txt` license and
`THIRD-PARTY-NOTICES.txt`. Development sources, tests, package configuration,
source maps, remote code/CDN references, host permissions, and web-accessible product
resources are rejected.

`node scripts/validate-package.mjs` checks the manifest contract, package file set,
MV3 permissions/CSP, SQLite integrity and M2 metadata/source revision, legal files,
file modes, and ZIP integrity/contents. The pack script writes to a temporary ZIP
and moves it atomically only after creation; `TYPEWRITER_ALLOW_DIRTY=true` is an
explicit local-development escape hatch that records `dirty-allowed` provenance.

For Chrome integration, run the following after packaging. The runner validates the
generated package and loads both the working `dist/` and a temporary extraction of
the exact ZIP through isolated Chrome profiles:

```sh
npm run test:mv3:package -- \
  --chrome="/path/to/Google Chrome for Testing" \
  --extension=dist \
  --zip=/path/to/typewriter_0.3.0.zip
```

It checks the popup and Settings flows, local dictionary coverage, saved settings
reflection, content-sized/scrolling layouts, the product runtime's SQLite
`query_only` and write-rejection status, and that no request leaves the extension
origin. This is the supported automated equivalent of installing the ZIP as an
unpacked extension; the Chrome GUI's direct ZIP installation path remains a manual
release smoke check.

실제 검증 기록 (2026-09-06, Chrome for Testing 152.0.7977.82): 제품 `popup.html`에서
패키지된 query adapter가 worker와 SQLite/WASM을 로드했고, `담담하다` lemma, `담담`
search form, expression `마음이 놓이다`, 다의어 sense 순서, `r008`
reference-only ID 조회, relation target/note, metadata를 확인했다. 제품 runtime
상태는 `query_only = 1`, `write_blocked = true`, `persisted_write_count = 0`이었고
외부 요청은 0건이었다.

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
