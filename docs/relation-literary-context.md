# C literary context tooling

Issue #1750 adds a small, read-only reader and checkpoint CLI for the existing
approved local literary SQLite index used by Relation Factory method C. It
does not build, update, or redistribute an index, and it is not used by the
product build or runtime.

The reader accepts the current paragraph-index shape: `source_files`,
`documents`, `paragraphs`, a trigram `paragraph_fts` table, and an
`index_metadata` table with an input-manifest or logical-row SHA-256 digest.
An incompatible or incomplete schema fails closed. The index is opened with
SQLite read-only mode and `query_only` enabled. The first preflight hashes the
exact database bytes; a local cache in `.warroom-scratch/` reuses that digest
only while device, inode, size, modification time, and change time still match.

## Typical C run

Run the CLI from the repository root. Replace the example shard, batch, model,
and local index path with the batch assigned to the current C producer.

```sh
node scripts/relation/literary-context-cli.mjs preflight --db /path/to/approved-literary.sqlite
node scripts/relation/literary-context-cli.mjs init \
  --canonical data/canonical/stdict-0001.jsonl \
  --shard 001 --batch 01 --model codex \
  --db /path/to/approved-literary.sqlite \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json
node scripts/relation/literary-context-cli.mjs scan \
  --db /path/to/approved-literary.sqlite \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json
node scripts/relation/literary-context-cli.mjs queue \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --status COUNTED --limit 50
node scripts/relation/literary-context-cli.mjs search \
  --db /path/to/approved-literary.sqlite \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --sense-id SENSE_ID --page-size 4
```

`scan` counts distinct paragraph hits per Canonical sense and returns only
batch totals, failure counts, elapsed query timings, and a bounded failure
preview. `queue` pages through hit senses. Use `search` to read the needed
contexts for one exact sense. The default page returns 1–4 contexts and cannot
exceed four; the #1155 adaptive sequence may continue through 5–8, 9–12, and
13–16, with 16 inspected contexts as the maximum. Each returned excerpt is
capped at 700 Unicode characters. The response includes the total
hit count, `has_more`, `truncated`, and an opaque continuation cursor. A
truncated page is `INCOMPLETE`, never zero hits or completed verification.
Paragraphs matching several Canonical forms are deduplicated. Results interleave
works by hit ordinal: the first hit from each work is returned before second
hits, then later hits, while preserving access to remaining matches. This
supports #1155's work/author/genre variety and preference for no more than two
contexts per work when the result set permits it. Each page reports its
distinct work count and maximum contexts from one work; there is no relevance
score. Pages return at most four rows; the separate
`context` command reads one locator in bounded 1,000-character pages.

If a page lookup fails, the checkpoint records `SEARCH_FAILED` while retaining
the last known hit total and continuation cursor. Retry `search` for that sense
without `--cursor` to resume the saved page. The inspected-context count is the
number of distinct stored locator keys, so a retry cannot inflate the sample or
hide remaining hits.

Three-character and longer forms use a quoted FTS5 trigram literal query;
one- and two-character forms use `instr()` literal matching. Those short
fallbacks may be slower and still require word-boundary and sense review.
Canonical lemma and `search_forms` are searched by default. Add any separately
reviewed inflections after `init` and before `scan`/context retrieval, only when
their form and basis are known. Adding a new form after context retrieval is
blocked so the 16-context-per-sense ceiling stays exact:

```sh
node scripts/relation/literary-context-cli.mjs add-form \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --sense-id SENSE_ID --form INFLECTED_FORM --basis 'reviewed irregular form'
```

## Source-sense review and discoveries

Every returned context begins as `PENDING`. Record one explicit disposition
for each context after comparing it with the exact Canonical sense:

```sh
node scripts/relation/literary-context-cli.mjs review-context \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --sense-id SENSE_ID --locator-key LOCATOR_KEY \
  --judgment VERIFIED --note 'brief source-sense reason'
```

`AMBIGUOUS` and `REJECTED` are also explicit judgments. A pending or unread
context is never automatically rejected, and a failed or unfinished search
cannot become `NO_VERIFIED`.

When the #1155 adaptive search has enough evidence to stop before all indexed
hits are read, record why after judging every returned context:

```sh
node scripts/relation/literary-context-cli.mjs finish-search \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --sense-id SENSE_ID --note 'why this source-sense sample is sufficient'
```

The checkpoint keeps the exact total hit count, contexts inspected, uninspected
hit count, stop note, and discarded continuation cursor. This explicit
sampling completion is distinct from zero hits. If no returned context is
`VERIFIED` while indexed hits remain, the sense is `SAMPLED_NO_VERIFIED` and
the report preserves that distinction.

For every `VERIFIED` context, submit two distinct sweep files. Each file must
contain exactly these seven keys, with a string array for each lens; `[]` is an
explicit inspected zero:

```json
{
  "image": [],
  "action": [],
  "emotion": [],
  "sensation": [],
  "scene_situation": [],
  "causality": [],
  "metaphor_contrast": []
}
```

```sh
node scripts/relation/literary-context-cli.mjs sweep \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --sense-id SENSE_ID --locator-key LOCATOR_KEY --sweep 1 \
  --results .warroom-scratch/sense-sweep-1.json
node scripts/relation/literary-context-cli.mjs sweep \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --sense-id SENSE_ID --locator-key LOCATOR_KEY --sweep 2 \
  --independent-read --results .warroom-scratch/sense-sweep-2.json
```

The tool requires a separate second-sweep operation and records the producer's
independent-read attestation. That attestation is a checkpoint field, not
automated proof that the context was reread. The tool calculates per-lens
counts, duplicates, unique discoveries, and sweep-two discoveries absent from
sweep one. It does not invent candidates or judge their meaning.

Review every unique discovered candidate with `review-candidate`. A kept
candidate needs an explicit `word`, `condensed_phrase`, or `fixed_expression`
classification and a short form-review note. This is an editorial decision;
the tool does not infer it from whitespace or candidate text. `report` emits
only bounded totals and coverage, not the ledger or paragraph text.

## Export, validation, and local repair

`export` requires every sense to have a completed search and every verified
context to have both sweeps. It also requires a form-gate decision for every
discovered expression. It preserves Canonical record/sense order, writes only
Candidate v1 fields, and runs the shared Candidate v1 batch validator before
creating the output:

```sh
node scripts/relation/literary-context-cli.mjs export \
  --checkpoint .warroom-scratch/001_01_c_codex.checkpoint.json \
  --canonical data/canonical/stdict-0001.jsonl \
  --output .warroom-scratch/001_01_c_codex.jsonl
```

For the final repository path, run the standard validator against the complete
shard and candidate file:

```sh
node scripts/relation/candidate-contract.mjs \
  data/canonical/stdict-0001.jsonl \
  data/relation-candidates/001/001_01_c_codex.jsonl
```

If validation identifies a local defect, change only the reviewed
`record_id`/`sense_id`/candidate tuple. First record a `REMOVE` disposition (or
the reviewed replacement's `KEEP` disposition), then use `patch` for that one
candidate. It preserves the rest of the file and reruns Candidate v1 over the
full batch. The output reports any next failing row so repairs can proceed
without repeating literary search or discovery.

All checkpoints, paragraph text, locators, sweep inputs, and digest caches must
remain under the ignored `.warroom-scratch/` directory. Never commit them or
include them in a PR. Only the validated Candidate JSONL belongs in the PR.
