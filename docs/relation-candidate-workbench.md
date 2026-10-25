# A/B Candidate workbench

This manual documents `scripts/relation/candidate-workbench.mjs`, the shared A/B tool for paging through Canonical senses, saving Candidate output, binding records and senses, tracking method-specific exploration and candidate-review receipts, and assembling the final file.

The tool handles only mechanical work. A's two semantic explorations and B's two scene explorations remain separate AI-led requirements; receipts record completion claims but do not verify semantic quality. C/D corpus search and their methods remain outside this tool. The final full-batch Candidate v1 check reuses `scripts/relation/candidate-contract.mjs`.

## A batch sequence

Follow [#860's A production contract](https://github.com/neverworkalone/typewriter/issues/860) for semantic exploration and candidate quality; this sequence documents only the shared tool mechanics.

1. Prepare only the owner-assigned A batch and read the complete source sense pages using `read-chunk`. Each item includes the full Canonical record fields with one exact source sense, including its `record_id`, `sense_id`, POS, and unmodified gloss. Continue from the returned `next_offset` until `has_more` is false.
2. For every source sense, perform A's first broad direct-association exploration, then return to that exact Canonical sense for the required independent second exploration in a new meaning direction. Preserve intelligible direct and indirect discoveries; do not impose candidate quotas, early stopping, or automatic semantic filtering. The workbench records the two passes separately and blocks the second-pass receipt until the current first pass is recorded.
3. Save complete chunks by explicit `record_id`/`sense_id`, including empty arrays. Chunk saves are additive and validate the full source mapping immediately; they do not create exploration or semantic-review receipts.
4. After both explorations are complete, page through `read-review-page` until every final candidate has been compared by the producer with its exact source sense and gloss. Mark only the candidates actually reviewed with `mark-reviewed`. Any new candidate remains pending; a Canonical meaning change makes its review stale.
5. Remove a candidate only after the explicit Stage 1 ineligible judgment required by `remove-candidate`. Preserve other eligible discoveries; do not use the workbench to make Stage 2 admission or Tier decisions.
6. Run `merge` only after all chunks are saved, every source sense has current primary and secondary exploration receipts, and all active candidates have current meaning/form review receipts. The workbench rebuilds in Canonical order and runs the full Candidate v1 validator.

Example A commands:

```sh
node scripts/relation/candidate-workbench.mjs prepare \
  --shard 001 --batch 01 --method a --model codex \
  --scratch-dir .warroom-scratch/001_01_a_codex --chunk-size 25

node scripts/relation/candidate-workbench.mjs read-chunk \
  --scratch-dir .warroom-scratch/001_01_a_codex --chunk 1 --offset 0 --limit 10

node scripts/relation/candidate-workbench.mjs save-chunk \
  --scratch-dir .warroom-scratch/001_01_a_codex --chunk 1 \
  --input .warroom-scratch/001_01_a_codex/chunk-001-candidates.jsonl

node scripts/relation/candidate-workbench.mjs read-exploration-page \
  --scratch-dir .warroom-scratch/001_01_a_codex --offset 0 --limit 10

node scripts/relation/candidate-workbench.mjs mark-explored \
  --scratch-dir .warroom-scratch/001_01_a_codex \
  --input .warroom-scratch/001_01_a_codex/primary-explored.jsonl --pass primary

node scripts/relation/candidate-workbench.mjs mark-explored \
  --scratch-dir .warroom-scratch/001_01_a_codex \
  --input .warroom-scratch/001_01_a_codex/secondary-explored.jsonl --pass secondary

node scripts/relation/candidate-workbench.mjs read-review-page \
  --scratch-dir .warroom-scratch/001_01_a_codex --offset 0 --limit 10

node scripts/relation/candidate-workbench.mjs mark-reviewed \
  --scratch-dir .warroom-scratch/001_01_a_codex \
  --input .warroom-scratch/001_01_a_codex/review-receipts.jsonl

node scripts/relation/candidate-workbench.mjs merge \
  --scratch-dir .warroom-scratch/001_01_a_codex \
  --out data/relation-candidates/001/001_01_a_codex.jsonl
```

## B batch sequence

1. Run `prepare` for the owner-assigned B batch. Read each complete Canonical chunk with all original fields and source IDs; do not treat truncated output as a complete chunk.
2. For every exact source sense in the batch, perform both distinct B scenes and discover candidates without quotas or early stopping. Preserve candidates from prior completed work.
3. Save each complete chunk with every source `record_id` and every matching `sense_id`, including empty `candidates` arrays. `save-chunk` records candidate output only; it never marks scene exploration complete.
4. After actually completing both scenes for every source sense, including senses with no candidates, write each exact `record_id`/`sense_id` pair to a scratch JSONL file and call `mark-explored`. A candidate save is not an exploration receipt.
5. Compare every final candidate with its exact Canonical source sense. Complete the AI meaning and form review for every candidate, then call `mark-reviewed` with the exact reviewed candidates. The CLI records explicit receipts; it does not make or verify semantic judgments.
6. Resolve local corrections by source IDs. `patch-sense` is additive and preserves saved candidates. Remove a candidate only after its current meaning/form review confirms it is Stage 1 ineligible, using `remove-candidate` with the explicit confirmation field.
7. Run `merge` only after all chunks are saved, all source senses have current exploration receipts, and all active candidates have current review receipts. It rebuilds in Canonical order and runs the full Candidate v1 batch validator. Run `candidate-contract.mjs` against the final output path before submission.

All checkpoints, chunk inputs, receipts, and temporary outputs belong in `.warroom-scratch/`; commit only the formal Candidate JSONL. If Canonical source meaning changes, `prepare` invalidates affected exploration and review receipts. Use `exploration-pending` and `review-pending` to export only affected work. A Canonical record/sense membership change stops processing and preserves the checkpoint for explicit reconciliation.

### B commands

Replace the example shard, batch, and model with the assigned B queue values. Chunk sizes are 25–50 records.

```sh
node scripts/relation/candidate-workbench.mjs prepare \
  --shard 001 --batch 01 --method b --model codex \
  --scratch-dir .warroom-scratch/001_01_b_codex --chunk-size 25

node scripts/relation/candidate-workbench.mjs save-chunk \
  --scratch-dir .warroom-scratch/001_01_b_codex --chunk 1 \
  --input .warroom-scratch/001_01_b_codex/chunk-001-candidates.jsonl

node scripts/relation/candidate-workbench.mjs patch-sense \
  --scratch-dir .warroom-scratch/001_01_b_codex \
  --input .warroom-scratch/001_01_b_codex/w001-w001-s1-candidates.json

node scripts/relation/candidate-workbench.mjs exploration-pending \
  --scratch-dir .warroom-scratch/001_01_b_codex \
  --out .warroom-scratch/001_01_b_codex/exploration-pending.jsonl

node scripts/relation/candidate-workbench.mjs mark-explored \
  --scratch-dir .warroom-scratch/001_01_b_codex \
  --input .warroom-scratch/001_01_b_codex/chunk-001-explored-senses.jsonl

node scripts/relation/candidate-workbench.mjs review-pending \
  --scratch-dir .warroom-scratch/001_01_b_codex \
  --out .warroom-scratch/001_01_b_codex/review-pending.jsonl

node scripts/relation/candidate-workbench.mjs mark-reviewed \
  --scratch-dir .warroom-scratch/001_01_b_codex \
  --input .warroom-scratch/001_01_b_codex/review-receipts.jsonl

node scripts/relation/candidate-workbench.mjs remove-candidate \
  --scratch-dir .warroom-scratch/001_01_b_codex \
  --input .warroom-scratch/001_01_b_codex/confirmed-ineligible.json

node scripts/relation/candidate-workbench.mjs status \
  --scratch-dir .warroom-scratch/001_01_b_codex

node scripts/relation/candidate-workbench.mjs merge \
  --scratch-dir .warroom-scratch/001_01_b_codex \
  --out data/relation-candidates/001/001_01_b_codex.jsonl

node scripts/relation/candidate-workbench.mjs inspect \
  --shard 001 --record-id w001
```

## Shared input, paging, and checkpoint rules

- `prepare` stores complete Canonical record rows, preserving original fields, in bounded source chunks. Each chunk reports its source range, record count, and sense count.
- `save-chunk` input uses `{"record_id":"w001","senses":[{"sense_id":"w001-s1","candidates":["별빛"]}]}`. It requires exact record and sense coverage for the selected chunk and rejects missing, extra, duplicate, or cross-mapped IDs. It never guesses mappings by array position and never silently slices, pads, drops, or moves candidate arrays. Saves add discoveries without removing previously saved candidates.
- For A, `mark-explored` input is JSONL with exact identities such as `{"record_id":"w001","sense_id":"w001-s1"}` and requires `--pass primary` or `--pass secondary`. Record each pass only after it has actually been completed. The second pass is accepted only after the primary pass for that current source sense. For B, keep the existing two-scene `mark-explored` flow without `--pass`. Neither method stores exploration narrative in the Candidate JSONL.
- `review-pending` exports unchecked or invalidated candidates together with their exact Canonical records/senses. `mark-reviewed` input uses `{"record_id":"w001","sense_id":"w001-s1","reviewed_candidates":["별빛"]}`. A changed candidate or source meaning invalidates the corresponding review receipt.
- `exploration-pending` writes a scratch checkpoint export. Use `read-exploration-page` to page through the pending exact senses and required A pass or B two-scene receipt.
- `patch-sense` accepts one JSON object, such as `{"record_id":"w001","sense_id":"w001-s1","candidates":["별빛","달빛"]}`. It changes only that sense and cannot remove an existing candidate; use `remove-candidate` for a separately reviewed, confirmed ineligible candidate.
- `remove-candidate` accepts one JSON object with `record_id`, `sense_id`, exact `candidate`, and `confirmed_ineligible: true`; it also requires a current AI meaning/form review receipt for that candidate.
- `merge` writes either under `.warroom-scratch/` or to a correctly named A/B Candidate path. It refuses incomplete chunks, missing/stale exploration, and pending/stale candidate reviews before writing output.

`read-chunk`, `read-review-page`, and `read-exploration-page` return `total`, `returned`, `truncated`, `has_more`, and `next_offset`. Continue from the exact returned offset; pages contain complete source-sense or candidate items, never clipped items. The shared CLI caps a page at 25 items, 32,768 Unicode characters, and 64 KiB of UTF-8 stdout, shrinking the returned item count when needed. A single item that cannot fit fails without partial output. Use these commands instead of printing whole Canonical chunks, candidate lists, or review exports. Do not use `forEach(console.log)` or write per-batch `node -e` scripts for workbench operations.

The saved checkpoint is the recovery source after interruption. Resume with `prepare` and `status`; do not rebuild a correct chunk or discard previously saved candidates to recover from a local error.
