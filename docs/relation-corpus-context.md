# D written-corpus context tooling

`relation:corpus` is a read-only consumer for the approved NIKL Written Corpus
2025 (1.0) SQLite index. It does not build or update the index, and it is not
used by the product build or runtime. The D editorial and production contract
remains [Issue #1156](https://github.com/neverworkalone/typewriter/issues/1156).

The CLI reuses the shared paragraph-index check and Candidate v1 validator. It
requires the approved source-manifest and logical-row digests recorded in
[`corpus-index-design.md`](corpus-index-design.md), confirms NIKL/written-corpus
source metadata, schema and software versions, and opens SQLite read-only with
`query_only`. The first preflight hashes the database; `.warroom-scratch/`
reuses that digest only while the file identity remains unchanged. A local
checkpoint also binds to the exact database identity, Canonical shard digest,
and procedure files. No index path or source path is printed.

## Start and search

Run commands from the repository root. Replace the database path with the
owner-approved local path; no local index, source file, or corpus passage is
part of the repository.

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
pnpm run relation:corpus -- queue \
  --checkpoint .warroom-scratch/001_01_d_codex.checkpoint.json \
  --status SEARCHED --limit 50
pnpm run relation:corpus -- search \
  --db /path/to/approved-written-corpus.sqlite \
  --checkpoint .warroom-scratch/001_01_d_codex.checkpoint.json \
  --sense-id SENSE_ID --page-size 4
```

`preflight`, `scan`, and `report` emit compact JSON summaries. Queue pages are
limited to 100 rows. Context pages return at most four excerpts of 700 Unicode
characters each, with total hits, returned count, truncation, and a cursor.
Document metadata and matched forms have their own character/count bounds; the
response flags any such display truncation in `metadata_truncated`. The CLI
never trims a returned context array after advancing its saved cursor.
Use the returned `--cursor` for the next page; the adaptive context cap is 16
per sense. When that cap is reached, or the producer has a specific reason to
stop sooner, first judge every returned context and then record a short stop
reason with `finish-search`. Truncation or an unvisited page is `INCOMPLETE`,
never a successful zero-hit search.

The shared read-only adapter searches three-or-more-character forms through
quoted FTS5 trigram literals and confirms exact substrings with `instr()`. If
the index has a `paragraph_bigrams(gram, paragraph_rowid)` table, two-character
forms use it as a prefilter and still pass the exact literal check. Without
that optional table, one- and two-character forms use the bounded-output
literal fallback. The adapter prepares batch SQL once per operation and reuses
one SQLite connection. It scans and checkpoints every 25 Canonical records,
combines the forms for one 25-record chunk into one aggregate count query, and
caches repeated normalized form sets across chunks. Cache keys include the
database and source digests, query forms, and search options. Shared cache rows
contain only raw hit counts and paragraph locators; source-sense judgments,
exploration, and candidate decisions remain independent for every sense.

The scan only counts literal substring matches. It does not establish word
boundaries, source-sense identity, POS, or a relation. It returns `ZERO_HITS`,
`UNSEARCHABLE`, or `SEARCH_FAILED` distinctly. A busy/locked timeout is recorded
as `SEARCH_FAILED` with `failure.kind: "timeout"`; other SQLite failures keep a
separate error kind. Neither state becomes an empty Candidate.

If a context-page lookup fails after earlier pages were saved, rerun `scan` after
the index is available. The successful count cache is reused and the next cursor
is rebuilt from the saved context count. Then rerun `search`; when contexts are
already saved, omitting `--cursor` resumes from that checkpoint position.

## Verify sense and explore

Each returned context starts `PENDING`. Compare it with the exact Canonical
sense and record the real decision:

```sh
pnpm run relation:corpus -- review-context \
  --checkpoint .warroom-scratch/001_01_d_codex.checkpoint.json \
  --sense-id SENSE_ID --locator-key LOCATOR_KEY \
  --judgment VERIFIED --note '문맥의 쓰임이 출발 sense와 일치'
```

Use `AMBIGUOUS` when the context cannot establish a precise match. Use
`REJECTED --mismatch-confirmed` only when the exact source-sense mismatch was
actually checked. A missing judgment is never treated as a rejection. `NO_VERIFIED`
is possible only after a completed sample where every inspected context has an
explicitly confirmed mismatch. `ZERO_HITS` remains a separate state.

For each `VERIFIED` context, make one integrated PASS B exploration covering
the five lenses `lexical`, `action_role_tool`, `scene_time_environment`,
`cause_effect_response`, and `contrast_sensation_metaphor`. Put the result in a
small JSON file under `.warroom-scratch/` with exactly those keys and string
arrays; `[]` means the lens was considered and yielded nothing. Record it:

```sh
pnpm run relation:corpus -- explore \
  --checkpoint .warroom-scratch/001_01_d_codex.checkpoint.json \
  --sense-id SENSE_ID --locator-key LOCATOR_KEY --pass 1 \
  --results .warroom-scratch/sense-pass-b.json
```

A second pass is optional and does not have to cover every context. If there is
a concrete reason to reread one verified context, record the independent-read
attestation and reason with `--pass 2 --independent-read --note '...'`. The tool
does not judge the sense or invent candidates. Candidate strings remain
separate from source-sense decisions. The CLI reports lens counts and the new
discovery total; the recorded strings remain in the private checkpoint instead
of being echoed back as a potentially large response.

Review every unique discovery for its Stage 1 form. The decision records
whether it is an independent word or a concise phrase; it does not assign a
relation type, Tier, or admission status:

```sh
pnpm run relation:corpus -- review-candidate \
  --checkpoint .warroom-scratch/001_01_d_codex.checkpoint.json \
  --sense-id SENSE_ID --candidate '겨울 아침' --decision KEEP \
  --kind phrase --note 'VERIFIED 문맥의 장면을 압축한 짧은 표현'
```

Use `--decision REMOVE` with a note for a discovered string that fails the
Candidate form gate. The tool preserves weak but intelligible source-sense
associations for Stage 2 and does not apply candidate-count targets. A sense
reaches `DISCOVERED` only after all verified contexts in its completed sample
have an integrated PASS B and every unique discovery has a form decision.

`report` prints batch totals and status counts only. Add a human-selected
search form with `add-form` before `scan`; its source-bound basis is stored in
the private checkpoint. Do not add forms after context retrieval.

## Export, validation, and local repair

`export` writes only Candidate v1 fields, preserves all Canonical records and
senses in order, and runs both the source-sense evidence check and the shared
full-batch Candidate validator before creating output:

```sh
pnpm run relation:corpus -- export \
  --checkpoint .warroom-scratch/001_01_d_codex.checkpoint.json \
  --canonical data/canonical/stdict-0001.jsonl \
  --output data/relation-candidates/001/001_01_d_codex.jsonl
pnpm run relation:corpus -- validate \
  --checkpoint .warroom-scratch/001_01_d_codex.checkpoint.json \
  --canonical data/canonical/stdict-0001.jsonl \
  --candidate data/relation-candidates/001/001_01_d_codex.jsonl
```

Only `ZERO_HITS`, fully checked `NO_VERIFIED`, and `DISCOVERED` senses can be
exported. Failed, unsearchable, ambiguous-without-verification, and unfinished
senses remain blocked. The final validator checks every record and sense,
canonical order, Candidate v1 shape, normalized duplicates, and source-lemma
conditions. A partial repair never replaces this final check.

If a validation error identifies one item, first correct the corresponding
form-gate decision in the private checkpoint, then run `patch` for that exact
`record_id`/`sense_id`/candidate. `patch` preserves all other rows and senses
and reruns the whole Candidate validator. A locator must belong to the exact
source sense that contains the discovery; mismatched or stale locator evidence
fails validation. Never re-run discovery to repair a one-row serialization
error.

All checkpoint JSON, paragraph text, context locators, and PASS B input files
stay under the ignored `.warroom-scratch/` directory. Never commit those files,
corpus SQLite, source paths, or paragraph text. Do not execute a formal 500-
record D batch merely to benchmark this implementation.
