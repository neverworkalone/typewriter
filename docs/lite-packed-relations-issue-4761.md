# Lite packed relations (Issue #4761, research of #4756)

Scope: the Lite product database `dist/dictionary.sqlite` only. Full (`artifacts/dictionary.sqlite`, `pnpm run build:dictionary`),
Canonical data and the Relation JSONL contracts are unchanged. The result is **not adopted** until the owner decides; the
numbers below are measurements of this implementation, not estimates.

## Build options

`scripts/build/dictionary-config.mjs`:

```js
export const LITE_OPTIMIZATION = { idCompression: true, textCompression: true };
```

| Flag | ON stores | OFF stores |
| --- | --- | --- |
| `idCompression` | Typewriter-authored ID relations as one compressed BLOB per source Meaning (`packed_meaning_relations`, `WITHOUT ROWID`); `meaning_relations` keeps only STDICT rows | every relation in `meaning_relations` |
| `textCompression` | `text_pool(id, text)` (each distinct text once) + one BLOB per source (`packed_text_relations`); no `meaning_text_relations` | `meaning_text_relations` |

The flags are independent (4 combinations), apply to Lite extraction/packaging only, and are written to the Lite `metadata`
(`lite_id_compression`, `lite_text_compression`). The runtime reads them once when the database is opened
(`inspectRuntimeDictionary`) and passes the layout to `getMeaningRecord`/`getMeaningRelations`; metadata and the tables
actually present must agree or the open fails. Schema version is 12.

Format (`src/runtime/packed-relations.js`): version byte, then per relation `varint(position gap)`, `varint(target Meaning
number | text pool id)`, one flag byte (type, relevance, and for ID rows the reverse origin). The Meaning number is the
integer in the canonical ID `m<integer>` (zero-padded to 3 digits); there is no ID map table. The build rejects any Meaning ID
that does not round-trip, authored rows with a non-empty `note`, and `direct`/`antonym`/out-of-range values.

## Checks

- Build: every Meaning ID round-trips and is unique; `verifyLiteExtraction` decodes **every** stored packed list and compares
  source/position/target/type/relevance/origin/note (and every text pool entry and text relation) with Full, for all four
  layouts; plain tables are digest-compared with Full. Run inside `extractLiteDictionary`.
- `validatePackedStorage` (build, `validatePackagedDictionary`, `pnpm run validate:package`): decodes all BLOBs, checks canonical
  IDs, source/target/pool existence, `(target,type)` and `(text,type)` uniqueness, the authored both-directions pairing that
  `authored_relation_without_pair` enforced on plain rows, pool uniqueness/no unused entries; the metadata relation counts
  are logical totals (table rows + decoded rows). Startup (`validateRuntimeDictionary`) never scans BLOBs.

## Measuring variants separately

Each variant is a different file; keep them by name or output directory. Reuse one Full database so the input is identical:

```bash
pnpm run build:dictionary    # once; use --allow-dirty only for local experiments, never as PR evidence
# edit the two flags in scripts/build/dictionary-config.mjs, then for each variant:
TYPEWRITER_SHARED_DICTIONARY_PATH=artifacts/dictionary.sqlite \
TYPEWRITER_BUILD_OUTPUT_DIRECTORY=dist-id-text pnpm run build
```

Or only the Lite file, without the extension bundle (does not touch the config file):

```bash
node -e "import('./scripts/build/lite-dictionary.mjs').then(({extractLiteDictionary})=>extractLiteDictionary({fullPath:'artifacts/dictionary.sqlite',litePath:'/tmp/lite-id-only.sqlite',optimization:{idCompression:true,textCompression:false}}))"
```

Same Full + same flags gives a byte-identical Lite. Size breakdown: `sqlite3 FILE "select name, sum(pgsize) from dbstat group by name order by 2 desc"`.

## Measured results (this implementation)

Input: Full built from the working tree on top of `a45e15856` (427,583 records, 482,125 Meanings, schema 12); macOS arm64,
Node 24.19. Full with `--allow-dirty`, so this is experiment evidence, not release evidence. Lite sizes (`ls -l`, MB = 10^6):

| Mode (`idCompression`/`textCompression`) | bytes | MB | MiB | vs OFF/OFF | extract+verify | rebuild SHA |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| OFF / OFF (baseline layout) | 365,101,056 | 365.1 | 348.2 | – | 76 s | identical |
| ON / OFF (ID only) | 246,648,832 | 246.6 | 235.2 | -118.5 MB (-32.4 %) | 57 s | identical |
| OFF / ON (Text only) | 360,468,480 | 360.5 | 343.8 | -4.6 MB (-1.3 %) | 74 s | identical |
| ON / ON (default) | 242,016,256 | 242.0 | 230.8 | -123.1 MB (-33.7 %) | 51 s | identical |

Relations: 1,167,352 authored ID rows (85,547 sources) pack into 5,636,676 BLOB bytes (4.83 B/row); 93,880 text rows pack into
430,230 BLOB bytes over 53,676 pool texts (223,468 text bytes). ID relation storage (table + both indexes) goes from 149.4 MB
to 31.0 MB including the 7.0 MB BLOB table; text from 6.4 MB to 1.7 MB (pool 1.1 MB + lists 0.6 MB). The pool deduplication alone
is not separable from list packing in these numbers. `pnpm run build` with a shared Full produced a byte-identical ON/ON file
(`validate-package` passed on it, 9.6 s including full BLOB decoding).

Equivalence: all 427,583 `getMeaningRecord` results (1,440,092 relations: 178,860 STDICT + 1,167,352 authored + 93,880 text,
largest Meaning 856) and 85,516 `getMeaningRelations`, plus 257,799 `findRecordsBySearchTerm` terms (every 3rd lemma, 5th search
form, 20th generated form) are `deepStrictEqual` between OFF/OFF and each other mode.

Performance (production SQLite WASM module, `sqlite3_deserialize`, in Node; **not Chrome MV3**; 4 interleaved rounds, medians; a
record's first pass is discarded, 6 passes; samples: 300 records each with no / 1-10 / 11-60 relations, top-50 largest, 200 with
ID+text, 400 search terms). p50 change vs OFF/OFF:

| Metric | ID only | Text only | ID + Text |
| --- | ---: | ---: | ---: |
| search p50 / p95 | -2 % / -7 % | 0 % / -5 % | 0 % / -6 % |
| record, no relations p50 | +4.5 % | -4 % | -1 % |
| record, 1-10 relations p50 (0.161 ms) | **+6.5 %** | -2 % | +1 % |
| record, 11-60 p50 / p95 | -7 % / -14 % | +2 % / +1 % | -7 % / -11 % |
| record, 856-relation max group p50 / p95 | -24 % / -30 % | +2 % / -15 % | -24 % / -35 % |
| ID+text record p50 / p95 | -7 % / -9 % | +3 % / +3 % | -7 % / -12 % |
| file read / open (`deserialize`) | -41 % / -59 % | noise (file -1.3 %) | -46 % / -61 % |
| RSS after open | -30 % | -1 % | -31 % |

Search never reads relations, so it is unchanged. The packed BLOBs are joined onto the record's meaning query by
`CAST(substr(id, 2) AS INTEGER)`, so reading them costs no extra statement; targets and pool entries are fetched in chunked
`IN (...)` bulk queries. A first version with one BLOB query per meaning cost +7 % on small records; a `json_each` bulk query was
slower and was dropped. ID-only on 1-10-relation records stays at about +6 % (about +0.01 ms, run-to-run spread about 3 %):
this is the one place the 5 % p50 gate is not met by ID-only. The default ON/ON is within ±1 % there.

Not measured: Chrome MV3 (service worker / offscreen) cold start, peak process memory, and real keyboard-to-render latency;
the numbers above are Node RSS with the production WASM module. `getMeaningRecord` p50/p95 are per call, in ms. Startup
`validateRuntimeDictionary` stayed about 6 ms in every mode (no BLOB scan).
