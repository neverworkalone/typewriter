# M7-1 release performance and scale benchmark

Measured 2026-09-26 on source revision `c1ff6385c517f896d79aff69b89245b85936b830`. The full machine-readable result, including phase-level memory snapshots and digests, is [`m7-1-scale-benchmark.json`](m7-1-scale-benchmark.json).

## Environment and method

- Apple M1 Pro, 8 logical CPUs, 16 GiB RAM, macOS 25.6, arm64.
- Node.js v24.19.0, Node SQLite 3.53.3, SQLite WASM 3.53.0.
- Benchmark Node processes used `--max-old-space-size=8192`.
- Command: `npm run benchmark:release -- --sizes=100000,500000,1000000 --sqlite-scale=100000,500000,1000000 --fixed-level-evidence=config/ci-level-evidence.json`.
- The real baseline reads the current 5,042-record canonical corpus. Synthetic workloads deterministically cycle its record, sense, search-form, relation, role, and part-of-speech structure while replacing IDs and lexical strings. Synthetic input stays in a temporary directory and is excluded from product ZIPs and canonical data.
- Runtime measurements use the production SQLite WASM module and the shared query adapter in a fresh Node child process. The file is read once and exposed to WASM through a zero-copy `Uint8Array` view; WASM deserialization allocates its own database image. The benchmark closes the cold database before opening the warm instance and records lifecycle events, cold peak/steady/after-close RSS, and warm reopen RSS separately. The test enforces a maximum of one live database.
- The runtime child measures 40 repeated queries after 5 warm-ups. First-ready includes WASM initialization, database read, and first open. OS file-cache state is uncontrolled. The separate scale-runner peak includes generation, audits, validation, normalization, SQLite builds, and reproducibility checks. These measurements do not include Chrome startup or worker-message overhead; those belong to browser install/update validation.
- The CLI prints its report, then exits nonzero if a requested scale failed or is absent, or if a requested SQLite scale lacks product, runtime, or reproducibility evidence. A `--sqlite-scale` absent from `--sizes` is rejected before benchmarking.

## Real 5K release baseline

| Measure | Result |
| --- | ---: |
| Canonical input | 5,042 records; 1,444,036 bytes |
| Records / senses / search forms / relations | 5,042 / 5,301 / 5,298 / 487 |
| Generated surface forms | 3,264 |
| Input preparation / semantic audit / normalization / SQLite build | 66 / 366 / 154 / 140 ms |
| Canonical-to-SQLite time | 726 ms |
| SQLite file / index bytes | 2,281,472 / 1,044,480 bytes |
| Product build / ZIP creation | 519 / 343 ms |
| Complete ZIP / compressed dictionary entry | 2,420,746 / 820,841 bytes |
| WASM first-ready / warm reopen | 31.27 / 0.57 ms |
| Repeated-query p95: lemma / form / generated surface / ambiguous | 0.58 / 0.41 / 0.31 / 0.18 ms |
| Runtime process peak RSS | 118.48 MiB |

## Synthetic scale curve

| Records | Senses / relations / forms / surfaces | SQLite build | DB / index | Full ZIP | First-ready / warm reopen | Query p95: lemma / form / surface / ambiguous | WASM runtime peak RSS | Scale-runner peak RSS / heap |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100K | 105,080 / 9,278 / 105,044 / 70,340 | 1.93 s | 51.4 / 24.4 MB | 14.05 MB | 46 / 2 ms | 0.51 / 0.34 / 0.26 / 0.17 ms | 215 MiB | 1.21 / 0.79 GiB |
| 500K | 525,800 / 48,238 / 525,524 / 353,768 | 10.16 s | 259.1 / 123.6 MB | 64.13 MB | 107 / 7 ms | 0.36 / 0.36 / 0.27 / 0.18 ms | 613 MiB | 4.17 / 4.22 GiB |
| 1M | 1,051,441 / 96,451 / 1,050,868 / 706,109 | 27.20 s | 518.6 / 247.4 MB | 126.73 MB | 598 / 27 ms | 0.33 / 0.32 / 0.18 / 0.17 ms | 1,106 MiB | 6.35 / 6.58 GiB |

The runtime peak is the child process maximum RSS. At 500K, cold steady-state RSS was 612.70 MiB and warm reopen changed it from 612.80 to 612.81 MiB. At 1M, cold steady-state RSS was 1,105.53 MiB and warm reopen changed it from 1,105.56 to 1,105.59 MiB. In both cases the lifecycle was `cold_open → cold_close → warm_open → warm_close`; the benchmark never held two database instances concurrently.

The scale-runner peak is separate from runtime RSS. Its 1M peak was 6.35 GiB RSS and 6.58 GiB V8 heap, below the 8 GiB heap limit on this 16 GiB host.

## CI level estimates

Each composed upper bound adds the measured synthetic corpus component to the repository's fixed-remainder evidence. Corpus time is measured using the same category wiring as the corresponding CI level.

| Records | Fast upper bound / 60 s | Normal upper bound / 180 s | Deep upper bound / 600 s |
| ---: | ---: | ---: | ---: |
| 100K | 20.81 s — within | 78.27 s — within | 194.67 s — within |
| 500K | 46.87 s — within | 120.32 s — within | 250.01 s — within |
| 1M | 108.90 s — exceeds | 260.27 s — exceeds | 487.19 s — within |

Keep full scale measurements in the existing deep/manual/scheduled path; do not add 1M to normal CI. The complete corpus components were 6.35 / 9.10 / 12.59 seconds at 100K, 32.42 / 51.15 / 67.93 seconds at 500K, and 94.45 / 191.10 / 305.11 seconds at 1M for fast / normal / deep.

## Findings and scale boundary

- **The 500K runtime query blocker is fixed.** The prior reference-only check scanned `records` and scaled to tens of milliseconds. The adapter now runs separate indexed lemma and search-form existence checks. Regression coverage checks `EXPLAIN QUERY PLAN` on both native and WASM SQLite, requires `idx_records_lemma` and `idx_search_forms_form`, and rejects table scans. After the fix, every 500K repeated query path is at or below 0.36 ms p95, with first-ready at 107 ms.
- **The benchmark no longer opens two WASM databases at once.** It closes the cold database before warm reopen, asserts the one-instance lifecycle, and reports each memory phase independently. At 500K the product package is 64.13 MB and the runtime child peaks at 613 MiB RSS; the separate full scale-runner peaks at 4.17 GiB RSS / 4.22 GiB heap. No 500K scale blocker remains in this benchmark.
- **1M completes as a deep stress workload.** It builds a 518.6 MB database and 126.73 MB ZIP. Runtime child peak is 1,106 MiB RSS; the scale-runner uses 6.35 GiB RSS and 6.58 GiB heap. The composed 1M fast and normal upper bounds exceed their current budgets, while deep remains within its 600-second target. Keep 1M out of fast and normal CI.
- Independent SQLite builds reproduced the same digest for each scale, and product output reused the validated SQLite artifact. Synthetic JSONL was not included in canonical directories or product packages.

Synthetic text preserves the real corpus's per-field lengths and whitespace structure, but not future lexical entropy or compression behavior. Treat 100K–1M package sizes as deterministic structural stress evidence; use the real 5K package as the product baseline.
