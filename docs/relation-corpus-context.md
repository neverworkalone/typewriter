# D written-corpus context tooling

`relation:corpus` is a read-only consumer for the approved NIKL Written Corpus
2025 (1.0) SQLite index. It does not build or update the index, and it is not
used by the product build or runtime. The D editorial and production contract
remains [Issue #1156](https://github.com/neverworkalone/typewriter/issues/1156).

The CLI reuses the shared paragraph-index check and Candidate v1 validator.
`preflight` follows the shared index metadata contract (`schema_version` or
`index_version`), requires the approved source-manifest and logical-row digests
recorded in [`corpus-index-design.md`](corpus-index-design.md), confirms
NIKL/written-corpus source metadata, and opens SQLite read-only with
`query_only`. It does not hash the database file: the file size/mtime identity
bound at `init` is enough for routine batches. Use `preflight --verify-binary`
only for an initial approval or a suspected change. No index path or source path
is printed. A checkpoint is bound to the index identity and the Canonical shard
digest; editing code or documents never invalidates it.

## One batch

Run commands from the repository root with the owner-approved local database
path. Checkpoints, submission files and corpus text stay under the ignored
`.warroom-scratch/`; no corpus text enters Git.

```sh
pnpm run relation:corpus -- preflight --db /path/to/approved-written-corpus.sqlite
pnpm run relation:corpus -- init \
  --canonical data/canonical/stdict-0001.jsonl \
  --shard 001 --batch 01 --model codex \
  --db /path/to/approved-written-corpus.sqlite \
  --checkpoint .warroom-scratch/001_01_d_codex.checkpoint.json
pnpm run relation:corpus -- scan \
  --db /path/to/approved-written-corpus.sqlite \
  --checkpoint .warroom-scratch/001_01_d_codex.checkpoint.json
```

`scan` counts literal substring matches for every sense in 25-record aggregate
queries on one read-only connection (repeated form sets are cached) and saves
once. Each sense becomes `ZERO_HITS`, `UNSEARCHABLE`, `SEARCH_FAILED`, or
`SEARCHED`. A zero-hit sense needs no further work. `SEARCH_FAILED` (for
example a locked database) is never an empty result; rerun `scan`. Add a
human-selected query form before scanning with `add-form --sense-id ID --form F
--basis '...'`.

## Read, judge, submit

```sh
pnpm run relation:corpus -- read --db ... --checkpoint ...
```

`read` prints, once per sense, the Canonical gloss and the first four contexts
(`id` + excerpt) for as many `SEARCHED` senses as fit in one response. It is
stateless: until a sense is submitted, `read` shows it again. Read the contexts,
decide for each which actually uses the exact source sense, use the verified
ones to discover real words (the five guides lexical / action-role-tool /
scene-time-environment / cause-effect-response / contrast-sensation-metaphor
are prompts for that one integrated reading, not cells to fill), and edit the
final `candidates`. Stop as soon as trustworthy VERIFIED contexts give enough
discovery; `--sense-id ID --offset 4` pages more contexts (at most 16) only
when needed.

Write one JSON list for the whole chunk and submit it once:

```json
[
  {"sense_id": "SENSE_ID", "status": "discovered", "verified": [101, 102], "candidates": ["겨울 아침", "잔향"]},
  {"sense_id": "SENSE_ID_2", "status": "no_verified", "rejected": [201, 202, 203, 204]},
  {"sense_id": "SENSE_ID_3", "status": "incomplete", "ambiguous": [301]}
]
```

```sh
pnpm run relation:corpus -- submit --checkpoint ... --results .warroom-scratch/chunk.json
```

- `verified` / `rejected` / `ambiguous` list context ids returned for that
  sense; an id belongs to only one list. Contexts you did not judge are left out.
- `discovered` needs at least one verified context; `candidates` may be empty
  after a real reading. Ineligible candidates are simply omitted.
- `no_verified` needs rejected contexts (exact source-sense mismatch) and nothing
  verified, ambiguous, or discovered.
- `incomplete` records that the reading is unfinished; the sense blocks export.
- A submission is all-or-nothing: errors name each `sense_id` and nothing is
  saved. Resubmitting a sense replaces its earlier result.

## Export

```sh
pnpm run relation:corpus -- export \
  --checkpoint ... --canonical data/canonical/stdict-0001.jsonl \
  --output data/relation-candidates/001/001_01_d_codex.jsonl
```

`export` is the single full Candidate v1 validation. Only `ZERO_HITS`,
`NO_VERIFIED`, and `DISCOVERED` senses can be exported; unfinished, failed, and
unsearchable senses block it. On an error, fix only the reported `sense_id`
(resubmit it) and export again. `validate` and `patch` remain for an existing
Candidate file (for example a review fix): `patch` removes or replaces one
exact candidate tuple and reruns the whole validator.

`report [--status STATUS]` prints status counts or a queue page.

Checkpoints from the earlier per-context format stay readable: finished
`DISCOVERED`/`NO_VERIFIED`/`ZERO_HITS` senses export from their saved `KEEP`
decisions, and unfinished senses are read and submitted like new ones. Never
commit checkpoint JSON, corpus SQLite, source paths, or paragraph text. Do not
execute a formal 500-record D batch merely to benchmark this implementation.
