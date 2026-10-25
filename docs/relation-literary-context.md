# C literary context tooling

Issue #1750 added the read-only reader and checkpoint CLI for the approved local
public-domain literature index used by Relation Factory method C. Issue #1761
bound it to the actual schema v1 contract. Issue #1774 slimmed the repeated
production path: read a chunk once, submit a chunk once, validate once. The
tool never builds, updates, or redistributes the index and is not used by the
product build or runtime.

## Approved index schema v1

The reader supports one schema: `source_files`, `works`, `text_units`,
`unit_fts`, and key/value `index_metadata`. It rejects retired
`documents`/`paragraphs`/`paragraph_fts` tables and incomplete or mixed schemas.

- `source_files.file_id` is the file key. `works.file_id` is unique and
  references that key; `text_units.file_id` references the same key.
- A work exposes `work_id`, `genre`, `title`, `author`, and `metadata_origin`.
  Work identity and unit order come from the index, not from inferred paths.
- `text_units` stores physical source lines: `unit_rowid`, `file_id`, `ordinal`,
  `kind`, `block_ordinal`, exact `text`, and exact `eol`. `(file_id, ordinal)`
  is unique and ordinals are zero-based and contiguous within each file.
- `unit_fts` is FTS5 over external content `text_units`, with
  `content_rowid='unit_rowid'` and `tokenize='trigram'`.
- `index_metadata` declares schema and builder version `1`, a full build,
  literal FTS/instr search semantics, format-valid input-manifest and
  logical-row SHA-256 digests, and file/work/unit counts matching the index.

Preflight opens SQLite read-only with `query_only` enabled. It checks the
schema, foreign keys, file/work/unit connections, metadata versions and counts
format, FTS configuration, and that a literal FTS probe runs. The approved index
is **not** hashed byte-for-byte and its FTS index is **not** rebuilt or compared
posting by posting on a normal run. Those deep checks (`preflight --deep`: whole-file
SHA-256 with a `.warroom-scratch/` digest cache, temporary FTS rebuild and posting
comparison) are for first approval of an index or a suspected change only. The
checkpoint binds the private DB path, stat fingerprint and the metadata
manifest/logical-row digests; the index is never regenerated. CLI diagnostics
report bounded schema/version/count/status fields and suppress local paths, raw
manifests, source lists, environment values, and credentials.
Checkpoint contract v3 binds that identity, the Canonical shard digest, the tool
procedure digest, and the Git HEAD. A v2 checkpoint stays readable, resumable
(`chunk`), reportable and exportable; v1 (retired paragraph schema) is rejected.

## Typical C run

Run the CLI from the repository root with the batch assigned to the current C
producer. The normal path is: **init once, then `chunk` → `submit` per chunk, then
`export` once.** There is no per-context, per-candidate or per-sense command.

```sh
node scripts/relation/literary-context-cli.mjs preflight --db /path/to/approved-literary.sqlite
node scripts/relation/literary-context-cli.mjs init \
  --canonical data/canonical/stdict-0001.jsonl \
  --shard 001 --batch 01 --model codex \
  --db /path/to/approved-literary.sqlite \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json
node scripts/relation/literary-context-cli.mjs chunk \
  --db /path/to/approved-literary.sqlite \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json
# read the chunk, judge and search, write .warroom-scratch/chunk-01.json, then:
node scripts/relation/literary-context-cli.mjs submit \
  --db /path/to/approved-literary.sqlite \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --input .warroom-scratch/chunk-01.json
# repeat chunk/submit until `chunk` returns no items, then:
node scripts/relation/literary-context-cli.mjs export \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --canonical data/canonical/stdict-0001.jsonl \
  --output data/relation-candidates/001/001_01_c_codex.jsonl
```

`chunk` opens the read-only index once and returns the next senses that are not
yet submitted (default 12 senses, 8 contexts each, bounded to ~36k characters).
Each item carries the sense id, lemma, POS, gloss, `total_hits`, `unseen_hits`
and the contexts with a short key `k`, a work/author label `src` and the excerpt
`x` (≤700 characters, two adjacent physical units on each side of the hit).
Results interleave works by hit ordinal before a second context from one work.
Senses with **zero hits** are recorded as `ZERO_HITS` in the same single
checkpoint write and are not shown; a failed or unsearchable sense is reported as
`SEARCH_FAILED`/`UNSEARCHABLE` and is never a normal empty result. Senses with
hits are written only when you submit them. Options: `--limit`, `--contexts`
(1–16; 16 is the ceiling per sense), `--snippet-chars`, and `--sense-ids a,b` to
re-read specific senses (for example with `--contexts 16` when the first sample
is not enough). One- and two-character forms use a literal `instr()` scan;
longer forms use an FTS5 trigram literal query re-checked with `instr()`; a form
split by a hard-wrapped line is not a hit. Canonical lemma and `search_forms`
are searched; add reviewed inflections before reading the sense:

```sh
node scripts/relation/literary-context-cli.mjs add-form \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --sense-id SENSE_ID --form INFLECTED_FORM --basis 'reviewed irregular form'
```

## What you still do for every sense with hits

The semantic work is unchanged: compare each context with the exact Canonical
source sense, decide which contexts are genuinely that sense (`VERIFIED`), and
search each VERIFIED literary context twice, independently, through the seven
lenses (image, action, emotion, sensation, scene/situation, causality,
metaphor/contrast), then edit the discoveries into final candidates under the
shared Stage 1 form rules. If the sample is not enough, read more with
`--sense-ids`, up to 16 contexts. **Nothing about this work is recorded per
lens, per context or per discarded candidate**: no empty lens arrays, no
KEEP/REMOVE ledger, no per-context receipt. Ineligible discoveries simply are
not listed.

`submit` takes one JSON file under `.warroom-scratch/` for the whole chunk and
saves it in one checkpoint write:

```json
{"senses": [
  {"sense_id": "SENSE_ID", "verified": ["KEY12CHARS", "KEY12CHARS"], "candidates": ["서리", "겨울 아침"]},
  {"sense_id": "OTHER_SENSE_ID", "verified": [], "candidates": []}
]}
```

`verified` lists the short keys of contexts you judged to be the source sense
(empty when none of the read contexts is); `candidates` is the final candidate
list. A sense with hits must be listed explicitly; omission is not an empty
result. The tool re-resolves each key against the index, so only real contexts
of that sense can be cited, and rejects candidates without a VERIFIED context,
unknown, ambiguous or duplicate keys and malformed entries. The whole submission
is validated first and nothing is written on failure. The checkpoint keeps only
what resumes a run: per sense the total hit count, the cited contexts' source
locators and digests, and the final candidates. It does not store excerpt text.
Resubmitting a sense replaces its earlier submission.

## Export, final validation, and fixes

`export` requires every sense to be `ZERO_HITS` or submitted, preserves Canonical
record/sense order, writes only Candidate v1 fields and runs the shared
Candidate v1 batch validator **once** over the whole batch before creating the
output. Do not run a second `validate` on the same file. A validator failure
names the affected row; resubmit only that sense, then export again (the
checkpoint's own previous output is overwritten). `validate` remains only for a
hand-edited file. All checkpoints, submissions and digest caches stay under the
ignored `.warroom-scratch/` directory; only the validated Candidate JSONL belongs
in the PR. `report` prints bounded totals.
