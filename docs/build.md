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

Schema and dataset-integrity validation always run.

## SQLite dictionary

`node scripts/build/dictionary.mjs` consumes the in-memory normalized model and
(`pnpm run build:dictionary`) creates the **Full** database `artifacts/dictionary.sqlite` from a fresh
output path: STDICT source tables, Meaning data and provenance, verified with the source-bound checks. It is the
development, source-lookup and audit database and never builds a Lite file. The generated
database is ignored build output and is never an editable source.

`pnpm run build` (and therefore `./pack.sh`, which calls it once) builds a fresh Full database at
`artifacts/dictionary.sqlite` from the current sources (no cache or reuse; `TYPEWRITER_FULL_DICTIONARY_PATH` redirects
it), verifies it, and then extracts the **Lite** product database `dist/dictionary.sqlite` from it
(`scripts/build/lite-dictionary.mjs`). In CI, `TYPEWRITER_SHARED_DICTIONARY_PATH` names the once-built **Full**
artifact of the current canonical revision; the extension build extracts Lite from it instead of building again, and a
Lite or mislabeled file is rejected. Lite extraction is not a canonical build. Only `dist/` (Lite) is packaged;
`artifacts/` is ignored and never enters a ZIP.

Both databases carry `metadata.database_kind` (`full` or `lite`) that must agree with their table set. Lite inherits
every other metadata value (`source_revision`, `canonical_revision`, `worktree_state`, counts) from the Full it was
extracted from; package and runtime validation reject anything that is not `lite`. The builder
requires Node.js 24.19.0 or newer (Node 24 LTS) for the built-in `node:sqlite` module and the
product Vite toolchain.

The schema in [`scripts/build/sqlite-schema.mjs`](../scripts/build/sqlite-schema.mjs)
contains only the current lookup model:

- `records` preserves record identity, `entry`/`expression`, role, optional
  candidate, and lemma;
- `search_forms` preserves every form and its source position;
- `meanings`, `meaning_members`, `sense_adjudications` and `meaning_relations` hold the
  meaning layer and projected relations ([meaning layer](meaning-layer.md#relation-projection-and-sqlite-issue-717));
- `generated_surface_forms` holds the sense-bound generated forms with the source sense position;
- the STDICT source `senses`, `relations` and `meaning_relation_sources` live only in the Full database
  (`SQLITE_SOURCE_SCHEMA_SQL`), where projection/provenance is verified; the Lite product database never ships them (Issue #792, #795);
- `metadata` stores deterministic contract versions and generated row counts.

Exact lemma and search-form indexes support lookup; member and adjudication record
indexes support the meaning view. The builder inserts records and senses before
relations so forward references work in the Full database, whose SQLite foreign keys,
integrity checks and source-derived checks verify the graph before the product tables
are extracted into the Lite database. Each build
removes the requested generated file first; it does not depend on an existing DB or
apply migrations. An output path inside `data/canonical/` is rejected.

The read-only helpers in [`scripts/build/query.mjs`](../scripts/build/query.mjs)
support the same conservative search response as the product worker: raw query,
NFC-plus-surrounding-trim normalization, exact lemma/search-form provenance,
role-independent exact lookup for valid in-scope records, and structured
`no-match`/`unsupported` outcomes. `role` remains stored for historical
editorial and inventory reporting; it is not a search filter.
Complete record/sense retrieval and source-sense relations include target lemma,
part of speech, and gloss display. Fuzzy search, broad relevance scoring,
morphology, user data,
and extension runtime integration beyond this shared contract are outside this
milestone. Candidate ordering uses only the documented exact-match tiers and
deterministic source/ID ties; it does not use frequency or generated scores.

## Product dictionary runtime

`pnpm run build` also assembles the product runtime under `dist/`:

- `dictionary.sqlite` is generated from the canonical JSONL pilot data;
- `runtime/dictionary-host.js` holds the shared database load/query logic;
  `runtime/dictionary-worker.mjs` hosts it in a dedicated module worker (web)
  and `runtime/dictionary-background.mjs` hosts it in the extension service
  worker so popups reuse one prepared database;
- `runtime/protocol.js` contains the versioned request/response contract;
- `runtime/query-adapter.js` is the browser-facing read-only adapter; and
- `runtime/sqlite-query.js` contains the shared SQLite query operations used by
  Node builds and the product worker;
- `runtime/search-query.js` contains the shared pure search normalizer and response
  contract; and
- `runtime/vendor/sqlite3.mjs` plus `runtime/vendor/sqlite3.wasm` are the pinned
  SQLite WASM runtime assets.

The main-thread adapter in [`src/runtime/query-adapter.js`](../src/runtime/query-adapter.js)
exposes exact lexical-record search, record/sense/relation reads, metadata, and
runtime status. The worker and Node helper share
[`src/runtime/sqlite-query.js`](../src/runtime/sqlite-query.js), which uses
[`src/runtime/search-query.js`](../src/runtime/search-query.js) for the pure search
normalizer and response contract.
Historical `reference-only` role does not restrict exact lexical search; every
valid in-scope lexical record can be returned by a matching lemma or curated
search form. The worker loads its own packaged
database with extension-relative URLs, keeps one initialization promise, enables
`PRAGMA query_only = ON`, and returns structured errors for asset, WASM, database,
query, and lifecycle failures. During the same product load it verifies that a
representative SQLite write is rejected and leaves no persisted row; runtime status
exposes `query_only`, `write_blocked`, and `persisted_write_count` for the product
Chrome check. The manifest allows WASM evaluation for extension pages while
retaining only the `storage` permission, no host permissions, and no web-accessible
dictionary asset.

Every runtime load checks the packaged SQLite schema and `user_version`, supported
dictionary version, verified source revision, SQLite quick-check result, and
record-count metadata before serving a query. An incompatible or incomplete file
fails with a stable load error and the popup offers a retry. The dictionary stays
inside the extension package and is loaded read-only; extension updates replace it
without touching `chrome.storage.local`. That storage holds display settings only,
so the current product has no dictionary migration or search-history migration.
After an update the new worker reports the replacement dictionary's version,
schema, and source revision for lifecycle verification.

The product build uses the same clean-worktree provenance contract as the SQLite
builder. During local development with uncommitted changes, use the explicit
escape hatch:

```sh
TYPEWRITER_ALLOW_DIRTY=true pnpm run build
```

The generated product database and runtime assets are build output; canonical JSONL
remains the editable source of truth.

### UI-only development build

```sh
pnpm run build:ui
```

`build:ui` (`vite build --mode ui`) is a fast build for Vue/JS/CSS work. It rebuilds the Extension UI bundles and
copies the ordinary runtime and legal files into `dist/`, but handles **no database at all**: it does not build or
verify a Full database, extract Lite, read or check `artifacts/dictionary.sqlite` or `dist/dictionary.sqlite`, or
generate `runtime/dictionary-build-info.js` (which is derived from the database `source_revision`). It succeeds
without any SQLite file present and never creates one.

- `emptyOutDir` is disabled in this mode. Only the hashed UI bundle directories `dist/assets` and `dist/chunks` are
  cleared and regenerated; an existing `dist/dictionary.sqlite` and `runtime/dictionary-build-info.js` are kept
  byte for byte, as is `artifacts/dictionary.sqlite`.
- The result is **not** an installable or distributable package. To search the dictionary, `dist/` must already hold a
  database from a normal `pnpm run build`. If canonical data changed, `build:ui` does not refresh it (intended).
- `pnpm run build`, `build:dictionary`, `pnpm run package`/`./pack.sh`, CI and release builds are unchanged and never
  use this mode.

## GitHub Pages build and deployment

The Pages workflow builds the separate web source under web/ at the repository path
/typewriter/. The site is a static product landing page for the Chrome Extension:
`/typewriter/` introduces the product and links to the Chrome Web Store, and
`/typewriter/about/` redirects to the landing page's philosophy section. Pages
provides no dictionary search; the dictionary runs only in the installed extension.
`pnpm run build:web` builds no SQLite database and copies no search runtime, so
`dist-web/` contains only hashed JS/CSS, the two HTML entrypoints, the favicon, the
legal files and `pages-build-info.json` (the exact clean Git revision). The command
`pnpm run validate:pages-artifact` rejects unknown files, any database, WASM or
search-runtime file or bundle content (fail-closed), remote page assets, incorrect
base paths, broken internal references, changed legal files, and a build revision that
differs from the checked-out source, and it reports the artifact size and the
initial-load transfer size.

Pull requests build and validate on an ephemeral runner, but never upload or deploy
Pages. The workflow runs on manual dispatch (`workflow_dispatch`) and on pushes to
`master` that change files under `web/`; it has no cron schedule. On `master` it builds and validates the artifact for that exact commit,
uploads it only after validation succeeds, then deploys it to the
`github-pages` environment. The deployment job depends on the successful build and
uses only Pages, OIDC, and Actions read permissions. Configure the repository Pages
publishing source to GitHub Actions and allow `master` in the `github-pages`
environment's deployment branch policy.

Issue #157 remains historical MO public-cutover evidence. Its approval comments
and the `PAGES_RELEASE_APPROVER` variable are not part of steady-state Pages
deployment.

## Product release package

`pnpm run package` creates the default non-minified Chrome release package. The
optional `pnpm run package:minify` command uses the same inputs and validator with
Vite/esbuild minification enabled. Both commands rebuild `dist/`, then create
`<repository>_<manifest-version>.zip` in `TYPEWRITER_ZIP_DIR` or, by default, in
`~/Downloads`.
The Chrome extension release version is read only from
`public/manifest.json#version`. It is independent from the package.json version,
which remains `1.0.0`.

The package contains only the MV3 product surface: `manifest.json`, `popup.html`,
`options.html`, Vite assets/chunks, the current generated `dictionary.sqlite`, the
SQLite worker/contract/validation/protocol/query adapter, the pinned SQLite
JavaScript/WASM runtime, icons and `logo.png`, `release-info.json`, and the
`Apache-2.0.txt` and `THIRD-PARTY-NOTICES.txt` files required for bundled software.
Repository-level policy documents (`LICENSE.md`, `DATA-LICENSE.md`, `BRAND.md`, and
`PRIVACY.md`) stay in the source tree and are not copied into the Store ZIP. The
privacy policy source remains available for the Store privacy-policy URL and
disclosures; see the M8 listing flow.
Development sources, tests, package configuration, source maps, remote code/CDN
references, unapproved runtime assets, host permissions, and web-accessible product
resources are rejected.

`node scripts/validate-package.mjs` checks the manifest contract, package file set,
MV3 permissions/CSP, SQLite integrity and M2 metadata/source revision, release
identity, legal files, file modes, and ZIP integrity and byte-for-byte contents.
`release-info.json` binds the app and extension versions, dictionary and schema
versions, canonical/source revision, generated database digest, manifest digest,
and dependency-lock digest. Package archives use sorted paths, fixed timestamps,
and fixed file modes; `pnpm run validate:release` builds twice and requires identical
ZIP bytes. The pack script writes to a temporary ZIP and moves it atomically only
after creation. `TYPEWRITER_ALLOW_DIRTY=true` remains an explicit local-development
escape hatch and its provenance is marked `dirty-allowed`.

### Clean-checkout release candidate validation

From a clean checkout, install the lockfile dependencies and run one command with
the Chrome for Testing executable and an output directory outside the repository:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run validate:release \
  --chrome="/path/to/Google Chrome for Testing" \
  --output-dir="/tmp/typewriter-release"
```

The command runs normal CI, builds and validates the production package twice,
compares the resulting ZIP digests, and runs the browser install/search/offline
checks against the exact ZIP and unpacked package. CFT runs only through this
explicit release-candidate command, outside ordinary CI. Both builds stay in a
temporary staging directory beneath the requested output directory; the final ZIP
is atomically published only after every check passes, and failed runs remove the
staged artifacts. It prints the package path,
SHA-256, both product versions, dictionary/schema versions, and the source revision.
Keep that ZIP and digest together when handing the validated candidate to M8.
The repository privacy disclosure describes the current extension's local
settings storage and on-device dictionary lookup. The owner-approved release
scope in `DATA-LICENSE.md` permits Typewriter-authored dictionary output to ship
after the exact-revision, deterministic-build, package-content, license/notice,
and applicable Store or Pages checks pass. Keep raw corpus material and any
specifically identified copied or restricted third-party content out of the
package. This command verifies engineering and package properties; it does not
replace those content restrictions or the applicable Store/Pages process.

For Chrome integration, run the following after packaging. The runner validates the
generated package and loads both the working `dist/` and a temporary extraction of
the exact ZIP through isolated Chrome profiles:

```sh
pnpm run test:mv3:package \
  --chrome="/path/to/Google Chrome for Testing" \
  --extension=dist \
  --zip=/path/to/generated-package.zip
```

Substitute the package path printed by the build; the archive filename is
generated from the manifest version.

It checks the popup and Settings flows, local dictionary coverage, saved settings
reflection, content-sized/scrolling layouts, the product runtime's SQLite
`query_only` and write-rejection status, and that no request leaves the extension
origin. This is the supported automated equivalent of installing the ZIP as an
unpacked extension; the Chrome GUI's direct ZIP installation path remains a manual
release smoke check. Pass `--previous-extension=/path/to/previous/unpacked` to
start from a prior real package, preserve its isolated profile, then load the new
ZIP contents at the same extension path with a higher test manifest version.
The runner verifies that the database source revision and bytes change, exact,
search-form, and generated-surface lookups work after restart, and the saved
Settings remain in `chrome.storage.local`. It also boots isolated copies with
missing, unreadable, corrupt, schema-mismatched, dictionary-version-mismatched,
revision-mismatched, referentially invalid, and incomplete databases and checks
the visible load error and worker retry behavior. `foreign_key_check` runs in the
runtime and package/artifact validators because SQLite's quick/integrity checks
do not report dangling foreign-key references.

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
