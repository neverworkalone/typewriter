# Extension startup latency (#720)

Measured in Chrome for Testing (headless, macOS arm64) with the unpacked
extension built from `master` (`fa328588`) versus this change. The popup was
opened as a tab (`popup.html`), "ready" is the time from target creation until
the popup reports the dictionary runtime status, and "search" is submit
(`담담`) until the first record is rendered. Reproduce with:

```sh
TYPEWRITER_CFT=<path-to-chrome-for-testing> \
  node scripts/benchmark/extension-startup.mjs <extension-dir> <label> [port] [reopens]
```

(`KILL_SW=1` closes the service worker before each reopen.)

| Phase | Before: ready | After: ready | Before: search | After: search |
| --- | ---: | ---: | ---: | ---: |
| First popup open (cold) | 3347 ms | 518 ms | 14 ms | 14 ms |
| Reopen #1 | 3364 ms | 64 ms | 7 ms | 8 ms |
| Reopen #2 | 3164 ms | 64 ms | 8 ms | 8 ms |
| Reopen #3 | 3179 ms | 46 ms | 8 ms | 8 ms |
| Reopen #4 | 3550 ms | 58 ms | 8 ms | 8 ms |
| Reopen after service worker was killed | – | 331–386 ms | – | 8 ms |

The cold first open also drops (3.3 s → 0.5 s) because runtime validation no
longer runs `PRAGMA quick_check`, `PRAGMA foreign_key_check` and the table
count scans; the package/build validators still run them. Reopening while the
service worker is alive skips fetch, WASM deserialize and validation entirely.
Search latency is unchanged. Single-machine, single-run figures; treat them as
order-of-magnitude evidence.

## Design

- `validateRuntimeDictionary` (schema, dictionary version, verified source
  revision, expected build revision) plus the `query_only` and write-probe
  checks run at startup. `validatePackagedDictionary` (adds integrity, foreign
  key and count checks) remains for build, package, Pages and benchmark tools.
- The database is owned by the MV3 service worker
  (`runtime/dictionary-background.mjs`, no new permission). Popups connect via
  a port; closing a popup only disconnects. If Chrome suspends the service
  worker the next request reconnects and the host reloads the database.
  Service workers cannot spawn Workers, so the shared host logic lives in
  `runtime/dictionary-host.js`; the web build keeps the dedicated Worker.
