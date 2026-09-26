# M7-1 release performance and scale benchmark

Measured 2026-09-26 on source revision `a65af8a74318cf9b05d1264f876ff21d00bed1b8`.
The full machine-readable result is [`m7-1-scale-benchmark.json`](m7-1-scale-benchmark.json).

## Environment and method

- Apple M1 Pro, 8 logical CPUs, 16 GiB RAM, macOS 25.6, arm64.
- Node.js v24.19.0, Node SQLite 3.53.3, SQLite WASM 3.53.3.
- Benchmark Node processes used `--max-old-space-size=8192`.
- Command: `npm run benchmark:release -- --sizes=100000,500000,1000000 --sqlite-scale=100000,500000,1000000 --fixed-level-evidence=config/ci-level-evidence.json`.
- The real baseline reads the current 5,042-record canonical corpus. Synthetic workloads cycle its record, sense, role, POS, relation, and search-form structure; generated text and IDs are deterministic replacements. Synthetic glosses preserve codepoint and whitespace counts without copying canonical text.
- Vite output and release ZIPs are built in a temporary directory. The benchmark rejects JSONL/canonical paths from the ZIP inputs. Synthetic canonical input never enters `data/canonical/` or a committed product artifact.
- Runtime timings use the production SQLite WASM module and shared SQLite query adapter in a fresh Node child process. The cold-ready value includes WASM initialization, database read, and first open. OS file-cache state is uncontrolled. Query p95 values use 40 measured repetitions after 5 warm-ups.
- Runtime memory is the child process RSS. The separate scale-runner peak is the Node process doing generation, audits, normalization, SQLite build, and reproducibility checks. This does not measure Chrome startup or worker-message overhead; those belong to the browser install/update validation boundary.

## Real 5K release baseline

| Measure | Result |
| --- | ---: |
| Canonical input | 5,042 records; 1,444,036 bytes |
| Records / senses / search forms / relations | 5,042 / 5,301 / 5,298 / 487 |
| Generated surface forms | 3,264 |
| Semantic audit / normalization / SQLite build | 331 / 141 / 123 ms |
| Canonical-to-SQLite time, including input preparation | 652 ms |
| SQLite file / index bytes | 2,281,472 / 1,044,480 bytes |
| Product build / ZIP creation | 329 / 289 ms |
| Complete ZIP / compressed dictionary entry | 2,420,646 / 820,831 bytes |
| WASM first-ready / warm reopen | 29.30 / 0.81 ms |
| Repeated-query p95: lemma / form / generated surface / ambiguous | 0.85 / 0.54 / 0.59 / 0.51 ms |
| Runtime process peak RSS | 121.25 MiB |

## Synthetic scale curve

| Records | Senses / relations / forms / surfaces | SQLite build | DB / index size | Full ZIP | First-ready / warm reopen | Query p95, exact / form / surface / ambiguous | Scale-runner peak RSS / heap |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100K | 105,080 / 9,278 / 105,044 / 70,340 | 1.84 s | 51.4 / 24.4 MB | 14.05 MB | 46 / 7 ms | 6.39 / 6.35 / 6.39 / 6.21 ms | 1.26 / 0.81 GB |
| 500K | 525,800 / 48,238 / 525,524 / 353,768 | 10.27 s | 259.1 / 123.6 MB | 64.13 MB | 367 / 104 ms | 35.53 / 35.95 / 36.41 / 36.24 ms | 4.66 / 4.30 GB |
| 1M | 1,051,441 / 96,451 / 1,050,868 / 706,109 | 25.07 s | 518.6 / 247.4 MB | 126.73 MB | 1,083 / 53 ms | 70.34 / 70.54 / 71.23 / 71.21 ms | 6.42 / 6.74 GB |

The runtime child peak RSS was 312 MiB, 1.06 GiB, and 1.55 GiB at 100K, 500K, and 1M. Product output reused the shared SQLite artifact at every scale, and two independent SQLite rebuilds reproduced the same digest for each workload.

Input generation took 0.53 s, 2.65 s, and 6.23 s. Load/index took 0.70 s, 3.94 s, and 9.75 s. Canonical validation plus one database build (`fast` corpus component) took 5.95 s, 32.05 s, and 90.77 s. The complete deep corpus component, including two independent rebuilds, took 13.20 s, 85.17 s, and 241.47 s.

## Findings and scale boundary

- **No 500K runtime blocker was found on this 16 GiB host.** At 500K, all four repeated query paths remain below 37 ms p95, first database readiness is 367 ms, the SQLite file is 259 MB, and the full release ZIP is 64.13 MB. The main scale process peaked at 4.66 GiB RSS with 4.30 GiB V8 heap.
- The measured curve is close to linear across 100K–1M for SQLite size, build time, and repeated query latency. It does not show a sudden 500K cliff.
- The 1M stress run completes, but uses 6.42 GiB scale-runner RSS and a 6.74 GiB V8 heap, near the benchmark's 8 GiB heap limit. First readiness rises to 1.08 s and repeated query p95 to about 71 ms. The current 1M package is 126.73 MB.
- Composed fixed-remainder plus corpus upper bounds at 500K are 46.5 s fast, 129.9 s normal, and 267.2 s deep; each remains within the 60 s, 180 s, and 600 s level targets. At 1M the corresponding bounds are 105.2 s, 238.7 s, and 423.5 s: fast and normal targets are exceeded, while the deep target remains within budget. Keep these scale measurements in the existing deep/manual/scheduled path; do not add 1M to normal CI.
- Chrome Web Store package guidance lists a 2 GB upload ceiling, so the measured 64.13 MB 500K and 126.73 MB 1M archives remain below that hard limit. An update uploads a new ZIP containing changed and unchanged files, so these values describe the full package payload for an update, not a binary delta. See [package size guidance](https://developer.chrome.com/docs/webstore/publish/) and [update package guidance](https://developer.chrome.com/docs/webstore/update).

The benchmark deliberately uses synthetic text with the real corpus's per-field lengths and whitespace structure. Its compression ratio and lexical entropy are not a forecast of future authored data. Use the real 5K package as the product baseline; treat 100K–1M ZIP sizes as deterministic structural stress evidence.
