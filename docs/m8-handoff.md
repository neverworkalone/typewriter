# M8 release-candidate handoff

Audit date: 2026-09-27

> Historical release-candidate snapshot: the source revision, counts, and
> package digests below remain bound to that candidate. Its 5,000-start role
> count is not the current search-eligibility denominator. Issue #212 records
> the current role-independent coverage; this note does not change M8's
> independent data-redistribution hold.

## Decision

**M7 engineering acceptance: PASS** on the exact candidate source revision below.
Normal CI, clean-checkout release validation, package reproducibility, Chrome for
Testing installation/search, same-profile update and database replacement, and
the required failure-state checks passed. Current packaged-worker readiness is
measured through validation at 5K, 500K, and 1M. At 500K it takes 2.75 seconds;
M8 should set a product startup-latency budget before scaling beyond the pilot.

This engineering result does not approve public distribution. The canonical
corpus and every data-bearing package remain held by [DATA-LICENSE.md](../DATA-LICENSE.md)
until record-level redistribution rights are established and the applicable
publication gate approves the release.

## Exact release-candidate contract

| Identity | Validated value |
| --- | --- |
| Source revision | c68fa542b41a795cb5e1ade358213d41ba8dbd4d |
| Normal-CI canonical revision | 8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9 |
| Canonical corpus | 5,042 records; 5,000 starts; 42 reference-only; 5,301 senses; 5,298 search forms; 487 curated relations |
| Generated surface forms | 3,264 |
| npm package / extension version source | 1.0.0 / `public/manifest.json#version` |
| Dictionary / SQLite schema | m2-pilot-1 / 2 |
| Package | `typewriter_<manifest-version>.zip`, 2,440,796 bytes, 28 files |
| Package SHA-256 | 14e76207be6aeef984b714c870623efff1d6d596e9d0e76b43eefbeb596eea24 |
| Packaged database SHA-256 | c266303b18bcb74a9b051d8696c527f4a9d3a4445298fab200015867d24fffd0 |
| Manifest SHA-256 | 25ad1ca69efe322014a5021b0bee7c33ba4340f69e56898af03f073071384144 |
| Lockfile SHA-256 | 6230c9d02a582aa955314a288a278a86d571d92d87a278b270d21485ea1136b6 |

release-info.json records the source as verified and the worktree as clean.
The release validator produced the same package SHA in two independent package
builds. This handoff documentation is repository-only and does not alter the
extension package inputs. The validated ZIP is a local engineering artifact; do
not commit or distribute it while the data hold remains.

## Reproduce the clean-checkout release validation

Start at the exact source revision with a clean worktree. Keep the package output
outside the checkout:

    git checkout c68fa542b41a795cb5e1ade358213d41ba8dbd4d
    npm ci --ignore-scripts --no-audit --no-fund
    npm run validate:release -- --chrome="/path/to/Google Chrome for Testing" --output-dir="/tmp/typewriter-release-c68fa54"

This flow runs ci:normal, builds and validates the production package twice,
requires byte-identical ZIPs, verifies release/source provenance, and exercises
both the unpacked package and the exact ZIP contents in isolated CFT profiles.
The audited run used Node.js 24.19.0, Node SQLite 3.53.3, npm 11.17.0, and Chrome
for Testing 152.0.7977.64. Normal CI passed in 87.826 seconds. The two package
builds were byte-identical; the exact 28-file ZIP and unpacked package passed
the CFT install, popup, settings, local-search, and read-only runtime checks.

For the same-profile update check, supply a genuine earlier production-shaped
unpacked package:

    npm run test:mv3:package -- --chrome="/path/to/Google Chrome for Testing" --extension=dist --zip="/path/to/generated-package.zip" --previous-extension="/path/to/previous-unpacked-package"

The audited predecessor package was built from M7-2 revision
765c9369f95b1747f64a72c8faba4b361ad10742 and carries the fixed engineering
manifest version 1.0. Since that test fixture is newer than the current candidate
manifest, the update harness raises only its temporary test copy to 1.0.1. This
checks same-profile update mechanics; the exact candidate ZIP is separately
installed and exercised by `validate:release`. The test-only version increment
does not change the fixed npm package version or the candidate manifest source.

## Install, update, and failure evidence

- CFT loaded both the 28-file unpacked build and the exact 28-file ZIP extraction.
  The popup and Settings flows passed, the runtime reported read-only SQLite,
  and no request left the extension origin.
- Same-profile replacement changed the database digest from
  538c0c08f5f1eebf365c3b2e669ddaf63537d48e26ca95b53a0e9835908cf58c at the
  predecessor to c266303b18bcb74a9b051d8696c527f4a9d3a4445298fab200015867d24fffd0
  at the candidate. Runtime provenance changed from the predecessor source SHA
  to c68fa542b41a795cb5e1ade358213d41ba8dbd4d.
- Post-update searches passed: 담담하다 (exact, w026), 가누 (search form,
  w1068), and 가냘픈 (generated surface form, w596).
- All saved chrome.storage.local settings survived the update unchanged.
- Missing, corrupt, unreadable, schema-mismatched, dictionary-version-mismatched,
  source-revision-mismatched, incomplete, and foreign-key-invalid databases each
  produced the expected stable load error and successful retry-worker recreation.

The automated release check loads the unpacked build and extracts the exact ZIP
into isolated profiles. Direct installation through Chrome's GUI remains a
separate manual smoke check if a later Store workflow requires it.

## Performance and scale boundary

The original M7-1 build/query/scale measurements and method remain in
[M7-1 release performance and scale benchmark](m7-1-scale-benchmark.md) and its
[machine-readable report](m7-1-scale-benchmark.json). Its `first_ready_ms` is a
historical raw-open measure and excludes M7-2 packaged-dictionary validation.
M7-4 re-ran the real 5K, 500K, and 1M SQLite WASM worker-ready path including
`validatePackagedDictionary`; see [current worker-ready evidence](m7-4-worker-ready-evidence.json).
These deterministic synthetic workloads mirror corpus structure, not future
lexical entropy or editorial quality. Measurements used Apple M1 Pro, 8 logical
CPUs, 16 GiB RAM, Node.js 24.19.0, and SQLite WASM 3.53.0.

| Workload | Prep: generate / load-index / semantic audit / normalize | Build: SQLite / product / ZIP | Database / index / full ZIP |
| --- | --- | --- | --- |
| Real 5K baseline | — / 59 / 379 / 146 ms | 129 / 458 / 318 ms | 2.28 / 1.04 MB / 2.42 MB benchmark ZIP; exact audited RC ZIP is 2.44 MB |
| 100K synthetic | 527 / 713 / 2,790 / 45 ms | 1.90 / 0.64 / 1.50 s | 51.4 / 24.4 / 14.05 MB |
| 500K synthetic | 2.63 / 4.17 / 14.11 / 0.28 s | 9.90 / 4.32 / 7.07 s | 259.1 / 123.6 / 64.13 MB |
| 1M synthetic | 5.91 / 9.31 / 40.50 / 0.80 s | 24.67 / 28.64 / 13.95 s | 518.6 / 247.4 / 126.73 MB |

| Workload | Historical raw-open / warm reopen | Query p95: lemma / form / surface / ambiguous | Runtime memory and CI result |
| --- | --- | --- | --- |
| Real 5K baseline | 28.29 / 0.61 ms | 0.36 / 0.24 / 0.31 / 0.17 ms | 116.59 MiB runtime RSS (historical M7-1) |
| 100K synthetic | 43 / 2 ms | 0.39 / 0.32 / 0.18 / 0.17 ms | 216 MiB runtime RSS; fast/normal/deep estimates 20.55 / 78.12 / 194.35 s, all within budget |
| 500K synthetic | 250 / 7 ms | 0.47 / 0.32 / 0.29 / 0.34 ms | 614 MiB runtime RSS; M7-1 CI estimates 46.78 / 121.53 / 256.80 s |
| 1M synthetic | 525 / 33 ms | 0.43 / 0.49 / 0.28 / 0.71 ms | 1,100 MiB runtime RSS; M7-1 runner 5.64 GiB RSS and 6.63 GiB maximum sampled heap |

The M7-1 table above is retained as a historical raw-open baseline. Current
worker-ready results include packaged validation and use the same 5K/500K/1M
workload sizes:

| Workload | Raw-open / packaged validation / worker-ready / warm worker-ready | Query p95: lemma / form / surface / ambiguous | Runtime DB / ZIP | Runner max RSS / sampled heap | Composed fast / normal / deep upper bounds |
| --- | --- | --- | --- | --- | --- |
| Real 5K release DB | 24.65 / 34.74 / 61.99 / 21.91 ms | 0.39 / 0.52 / 0.46 / 0.17 ms | 2.28 / 2.44 MB exact RC | 109.41 MiB runtime RSS | — |
| 500K synthetic | 303.43 / 2,442.80 / 2,749 / 2,259.01 ms | 0.41 / 0.30 / 0.22 / 0.18 ms | 259.14 / 64.13 MB | 3.36 / 3.71 GiB | 45.55 / 126.15 / 262.31 s; all within |
| 1M synthetic | 715.16 / 5,166.92 / 5,885.21 / 4,620.04 ms | 0.47 / 0.55 / 0.27 / 0.21 ms | 518.62 / 126.73 MB | 6.29 / 6.53 GiB | 105.12 / 253.06 / 447.07 s; fast and normal exceed |

`worker-ready` includes SQLite WASM module initialization, packaged DB read and
open, query-only setup, schema/version/source validation, `quick_check`, foreign
key and row-count checks in `validatePackagedDictionary`, and the read-only
probe. Warm readiness excludes fresh WASM initialization but repeats DB open and
packaged validation. It excludes Chrome process startup and worker-message
startup. At 500K, packaged validation accounts for 2.44 seconds of 2.75 seconds
total; this is a measured startup cost for M8 to set an explicit latency budget
around. Query latency, one-live-database lifecycle, reproducible build, and
current fast/normal/deep estimates pass the M7-4 500K scale check. At 1M, deep
remains within its budget while fast and normal exceed theirs, so 1M stays a
stress/deep workload.

At 500K, indexed lemma and search-form checks remove the measured full-scan
blocker; query p95 remains below 0.5 ms. The 1M workload completes on the deep
path, but its fast and normal estimates exceed their 60- and 180-second budgets.
Deep remains within its 600-second budget. Keep the 1M stress run out of normal CI.

## Package, provenance, and M8 boundary

- The package validator checked the exact ZIP-to-unpacked bytes, SQLite/WASM,
  manifest/CSP/permissions, version and source provenance, and included legal
  notices. The runtime keeps dictionary access local and has no external requests.
- The package carries the Apache and third-party software notices. Repository
  policy documents remain outside the Store ZIP.
- Synthetic scale input remains temporary and was excluded from canonical and
  product artifacts; normal artifact policy reported zero generated projections
  and zero unclassified artifacts.
- DATA-LICENSE.md has no record-level clearance allowlist for the current
  canonical corpus. The package therefore remains a held, local RC even though
  its engineering checks pass. M8 must keep redistribution closed until rights
  evidence and publication approval are complete.
- If any source input changes, treat it as a new candidate: rerun the clean
  release command and carry forward its new source SHA, package SHA, database
  SHA, and CFT evidence together.
