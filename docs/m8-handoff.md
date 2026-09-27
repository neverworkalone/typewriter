# M8 release-candidate handoff

Audit date: 2026-09-27

## Decision

**M7 engineering acceptance: PASS** on the exact candidate source revision below.
Normal CI, clean-checkout release validation, package reproducibility, Chrome for
Testing installation/search, same-profile update and database replacement, and
the required failure-state checks passed. No unresolved M7 performance,
lifecycle, or package-boundary blocker was found.

This engineering result does not approve public distribution. The canonical
corpus and every data-bearing package remain held by [DATA-LICENSE.md](../DATA-LICENSE.md)
until record-level redistribution rights are established and the applicable
publication gate approves the release.

## Exact release-candidate contract

| Identity | Validated value |
| --- | --- |
| Source revision | 459f748f1e33ed8bef99e3c3e5e7083995344168 |
| Normal-CI canonical revision | 8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9 |
| Canonical corpus | 5,042 records; 5,000 starts; 42 reference-only; 5,301 senses; 5,298 search forms; 487 curated relations |
| Generated surface forms | 3,264 |
| Application / extension | 1.0.0 / 1.0 |
| Dictionary / SQLite schema | m2-pilot-1 / 2 |
| Package | typewriter_1.0.zip, 2,440,795 bytes, 28 files |
| Package SHA-256 | 416ad29a908775a574638e4ac190a02a874bd193240a17ba60cd5fe37db831e6 |
| Packaged database SHA-256 | c71839f4da1197d5b424b9a1cdd8927bd55ffc6410631c78cbc1c7479e414bf9 |
| Manifest SHA-256 | 3545e6c0fb8aaffc872aba49659688f0509ad57455d881c512bfe9bcf9a8a20d |
| Lockfile SHA-256 | 6230c9d02a582aa955314a288a278a86d571d92d87a278b270d21485ea1136b6 |

release-info.json records the source as verified and the worktree as clean.
The release validator produced the same package SHA in two independent package
builds. This handoff documentation is repository-only and does not alter the
extension package inputs. The validated ZIP is a local engineering artifact; do
not commit or distribute it while the data hold remains.

## Reproduce the clean-checkout release validation

Start at the exact source revision with a clean worktree. Keep the package output
outside the checkout:

    git checkout 459f748f1e33ed8bef99e3c3e5e7083995344168
    npm ci --ignore-scripts --no-audit --no-fund
    npm run validate:release -- --chrome="/path/to/Google Chrome for Testing" --output-dir="/tmp/typewriter-release-459f748"

This flow runs ci:normal, builds and validates the production package twice,
requires byte-identical ZIPs, verifies release/source provenance, and exercises
both the unpacked package and the exact ZIP contents in isolated CFT profiles.
The audited run used Node.js 24.19.0, Node SQLite 3.53.3, npm 11.17.0, and Chrome
for Testing 152.0.7977.64. Normal CI passed in 86.1 seconds.

For the same-profile update check, supply a genuine earlier production-shaped
unpacked package:

    npm run test:mv3:package -- --chrome="/path/to/Google Chrome for Testing" --extension=dist --zip="/path/to/typewriter_1.0.zip" --previous-extension="/path/to/previous-unpacked-package"

The audited predecessor package was built from M7-2 revision
765c9369f95b1747f64a72c8faba4b361ad10742. The runner temporarily raises the
test extension version to 1.0.1 to exercise update behavior; the shipped
candidate remains version 1.0.

## Install, update, and failure evidence

- CFT loaded both the 28-file unpacked build and the exact 28-file ZIP extraction.
  The popup and Settings flows passed, the runtime reported read-only SQLite,
  and no request left the extension origin.
- Same-profile replacement changed the database digest from
  538c0c08f5f1eebf365c3b2e669ddaf63537d48e26ca95b53a0e9835908cf58c at the
  predecessor to c71839f4da1197d5b424b9a1cdd8927bd55ffc6410631c78cbc1c7479e414bf9
  at the candidate. Runtime provenance changed from the predecessor source SHA
  to 459f748f1e33ed8bef99e3c3e5e7083995344168.
- Post-update searches passed: 담담 (exact, w026), 가누 (search form,
  w1068), and 가냘픈 (generated surface form, w596).
- All saved chrome.storage.local settings survived the update unchanged.
- Missing, corrupt, unreadable, schema-mismatched, dictionary-version-mismatched,
  source-revision-mismatched, incomplete, and foreign-key-invalid databases each
  produced the expected stable load error and successful retry-worker recreation.

The automated release check loads the unpacked build and extracts the exact ZIP
into isolated profiles. Direct installation through Chrome's GUI remains a
separate manual smoke check if a later Store workflow requires it.

## Performance and scale boundary

The measured method and full evidence are in
[M7-1 release performance and scale benchmark](m7-1-scale-benchmark.md) and its
[machine-readable report](m7-1-scale-benchmark.json).
That benchmark was measured on 2026-09-26 at source revision
7c604c8c4a94f6934385be8dffda1fe3311e47c3 and checked against the current
architecture here; M7-4 did not repeat the expensive synthetic scale runs.
The 100K–1M workloads are deterministic structural stress fixtures derived from
the real corpus shape; they do not model future lexical entropy or establish
editorial quality. The reported scale runs used an Apple M1 Pro with 8 logical
CPUs and 16 GiB RAM, Node.js 24.19.0, and SQLite WASM 3.53.0.

| Workload | Prep: generate / load-index / semantic audit / normalize | Build: SQLite / product / ZIP | Database / index / full ZIP |
| --- | --- | --- | --- |
| Real 5K baseline | — / 59 / 379 / 146 ms | 129 / 458 / 318 ms | 2.28 / 1.04 MB / 2.42 MB benchmark ZIP; exact audited RC ZIP is 2.44 MB |
| 100K synthetic | 527 / 713 / 2,790 / 45 ms | 1.90 / 0.64 / 1.50 s | 51.4 / 24.4 / 14.05 MB |
| 500K synthetic | 2.63 / 4.17 / 14.11 / 0.28 s | 9.90 / 4.32 / 7.07 s | 259.1 / 123.6 / 64.13 MB |
| 1M synthetic | 5.91 / 9.31 / 40.50 / 0.80 s | 24.67 / 28.64 / 13.95 s | 518.6 / 247.4 / 126.73 MB |

| Workload | First ready / warm reopen | Query p95: lemma / form / surface / ambiguous | Runtime memory and CI result |
| --- | --- | --- | --- |
| Real 5K baseline | 28.29 / 0.61 ms | 0.36 / 0.24 / 0.31 / 0.17 ms | 116.59 MiB runtime RSS |
| 100K synthetic | 43 / 2 ms | 0.39 / 0.32 / 0.18 / 0.17 ms | 216 MiB runtime RSS; fast/normal/deep estimates 20.55 / 78.12 / 194.35 s, all within budget |
| 500K synthetic | 250 / 7 ms | 0.47 / 0.32 / 0.29 / 0.34 ms | 614 MiB runtime RSS; fast/normal/deep estimates 46.78 / 121.53 / 256.80 s, all within budget |
| 1M synthetic | 525 / 33 ms | 0.43 / 0.49 / 0.28 / 0.71 ms | 1,100 MiB runtime RSS; runner 5.64 GiB RSS and 6.63 GiB maximum sampled heap; fast/normal/deep estimates 105.41 / 245.02 / 442.23 s |

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
