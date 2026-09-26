# M7-1 release performance and scale benchmark

Measured 2026-09-26 on source revision `7c604c8c4a94f6934385be8dffda1fe3311e47c3`. The v7 machine-readable result, including phase-level memory snapshots, codepoint-length profiles, and digests, is [`m7-1-scale-benchmark.json`](m7-1-scale-benchmark.json).

## Environment and method

- Apple M1 Pro, 8 logical CPUs, 16 GiB RAM, macOS 25.6, arm64.
- Node.js v24.19.0, Node SQLite 3.53.3, SQLite WASM 3.53.0.
- Benchmark Node processes used `--max-old-space-size=8192`.
- Command: `npm run benchmark:release -- --sizes=100000,500000,1000000 --sqlite-scale=100000,500000,1000000 --fixed-level-evidence=config/ci-level-evidence.json`.
- The real baseline reads the current 5,042-record canonical corpus. Synthetic workloads deterministically cycle its record, sense, search-form, relation, role, and part-of-speech structure while replacing IDs and lexical strings. Synthetic input stays in a temporary directory and is excluded from product ZIPs and canonical data.
- Runtime measurements use the production SQLite WASM module and the shared query adapter in a fresh Node child process. The file is read once and exposed to WASM through a zero-copy `Uint8Array` view; WASM deserialization allocates its own database image. The benchmark closes the cold database before opening the warm instance and records lifecycle events, cold peak/steady/after-close RSS, and warm reopen RSS separately. The test enforces a maximum of one live database.
- The runtime child measures 40 repeated queries after 5 warm-ups. First-ready includes WASM initialization, database read, and first open. OS file-cache state is uncontrolled. The scale-runner process covers generation, audits, validation, normalization, SQLite builds, and reproducibility checks. These measurements do not include Chrome startup or worker-message overhead; those belong to browser install/update validation.
- The CLI prints its report, then exits nonzero if a requested scale failed or is absent, or if a selected SQLite scale lacks valid package, SQLite file/index, startup, four representative query, runtime-memory/lifecycle, scale-runner-memory, synthetic-shape, build-timing, or reproducibility evidence. A `--sqlite-scale` absent from `--sizes` is rejected before benchmarking. Focused fail-closed fixtures exercise missing and malformed evidence through the CLI exit code.
- Synthetic average lemma and gloss codepoint lengths are checked against an ordered canonical-derived template profile. Validation weights complete template cycles plus the first records in a partial final cycle, so an altered average cannot pass while category counts remain plausible. The report stores codepoint lengths only, not canonical text.
- Scale runs are evaluated in ascending order. The scale-runner's RSS is the benchmark process's `process.resourceUsage().maxRSS` high-water mark at each scale boundary; it is cumulative across earlier scales in the same run. The reported V8 heap value is `max_sampled_heap_used_mb`, the greatest `process.memoryUsage().heapUsed` observed at phase boundaries, not a true process peak.

## Real 5K release baseline

| Measure | Result |
| --- | ---: |
| Canonical input | 5,042 records; 1,444,036 bytes |
| Records / senses / search forms / relations | 5,042 / 5,301 / 5,298 / 487 |
| Generated surface forms | 3,264 |
| Input preparation / semantic audit / normalization / SQLite build | 59 / 379 / 146 / 129 ms |
| Canonical-to-SQLite time | 713 ms |
| SQLite file / index bytes | 2,281,472 / 1,044,480 bytes |
| Product build / ZIP creation | 458 / 318 ms |
| Complete ZIP / compressed dictionary entry | 2,420,738 / 820,833 bytes |
| WASM first-ready / warm reopen | 28.29 / 0.61 ms |
| Repeated-query p95: lemma / form / generated surface / ambiguous | 0.36 / 0.24 / 0.31 / 0.17 ms |
| Runtime process maximum RSS | 116.59 MiB |

## Synthetic scale curve

| Records | Senses / relations / forms / surfaces | SQLite build | DB / index | Full ZIP | First-ready / warm reopen | Query p95: lemma / form / surface / ambiguous | WASM runtime max RSS | Scale-runner process max RSS / max sampled heap |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100K | 105,080 / 9,278 / 105,044 / 70,340 | 1.90 s | 51.4 / 24.4 MB | 14.05 MB | 43 / 2 ms | 0.39 / 0.32 / 0.18 / 0.17 ms | 216 MiB | 1.28 / 0.78 GiB |
| 500K | 525,800 / 48,238 / 525,524 / 353,768 | 9.90 s | 259.1 / 123.6 MB | 64.13 MB | 250 / 7 ms | 0.47 / 0.32 / 0.29 / 0.34 ms | 614 MiB | 3.92 / 4.17 GiB |
| 1M | 1,051,441 / 96,451 / 1,050,868 / 706,109 | 24.67 s | 518.6 / 247.4 MB | 126.73 MB | 525 / 33 ms | 0.43 / 0.49 / 0.28 / 0.71 ms | 1,100 MiB | 5.64 / 6.63 GiB |

The runtime RSS is the SQLite WASM child process maximum. At 500K, cold steady-state RSS was 613.53 MiB and warm reopen changed it from 613.58 to 613.59 MiB. At 1M, cold steady-state RSS was 1,098.20 MiB and warm reopen changed it from 1,096.73 to 1,094.81 MiB. In both cases the lifecycle was `cold_open → cold_close → warm_open → warm_close`; the benchmark never held two database instances concurrently.

The scale-runner memory is separate from runtime RSS. At 1M, the runner's process maximum RSS was 5.64 GiB and the maximum sampled V8 heap-used value was 6.63 GiB. Heap usage is sampled after benchmark phases and is not a true peak measurement.

## CI level estimates

Each composed upper bound adds the measured synthetic corpus component to the repository's fixed-remainder evidence. Corpus time is measured using the same category wiring as the corresponding CI level.

| Records | Fast upper bound / 60 s | Normal upper bound / 180 s | Deep upper bound / 600 s |
| ---: | ---: | ---: | ---: |
| 100K | 20.55 s — within | 78.12 s — within | 194.35 s — within |
| 500K | 46.78 s — within | 121.53 s — within | 256.80 s — within |
| 1M | 105.41 s — exceeds | 245.02 s — exceeds | 442.23 s — within |

Keep full scale measurements in the existing deep/manual/scheduled path; do not add 1M to normal CI. The complete corpus components were 6.10 / 8.95 / 12.27 seconds at 100K, 32.32 / 52.35 / 74.73 seconds at 500K, and 90.95 / 175.85 / 260.16 seconds at 1M for fast / normal / deep.

## Findings and scale boundary

- **The 500K runtime query blocker is fixed.** The prior reference-only check scanned `records` and scaled to tens of milliseconds. The adapter now runs separate indexed lemma and search-form existence checks. Regression coverage checks `EXPLAIN QUERY PLAN` on both native and WASM SQLite, requires `idx_records_lemma` and `idx_search_forms_form`, and rejects table scans. After the fix, every 500K repeated query path is at or below 0.47 ms p95, with first-ready at 250 ms.
- **The benchmark no longer opens two WASM databases at once.** It closes the cold database before warm reopen, asserts the one-instance lifecycle, and reports each memory phase independently. At 500K the product package is 64.13 MB and the runtime child maximum is 614 MiB RSS; the separate scale-runner process maximum is 3.92 GiB RSS and its maximum sampled heap-used value is 4.17 GiB. The report CLI now rejects a selected scale when any required product, startup, query, memory, shape, timing, or reproducibility evidence is missing or malformed.
- **1M completes as a deep stress workload.** It builds a 518.6 MB database and 126.73 MB ZIP. Runtime child maximum is 1,100 MiB RSS; the scale-runner process maximum is 5.64 GiB RSS and its maximum sampled heap-used value is 6.63 GiB. The composed 1M fast and normal upper bounds exceed their current budgets, while deep remains within its 600-second target. Keep 1M out of fast and normal CI.
- Independent SQLite builds reproduced the same digest for each scale, and product output reused the validated SQLite artifact. Synthetic JSONL was not included in canonical directories or product packages.

Synthetic glosses and relation notes preserve the real corpus's codepoint lengths and whitespace structure. Lemmas and search forms use deterministic synthetic values, so their lengths follow the recorded synthetic profile rather than the canonical lemma lengths. These workloads do not model future lexical entropy or compression behavior. Treat 100K–1M package sizes as deterministic structural stress evidence; use the real 5K package as the product baseline.
