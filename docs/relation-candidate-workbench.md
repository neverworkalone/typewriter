# B Candidate workbench

This manual documents `scripts/relation/candidate-workbench.mjs`, a B-production tool for preparing Canonical chunks, saving Candidate output, binding records and senses, tracking explicit exploration and edit-review receipts, and assembling the final file.

The tool supports **only `--method b`**. It preserves B's AI-led two-scene exploration and editorial judgments; it does not define or change A/C/D production. The shared reuse boundary is `scripts/relation/candidate-contract.mjs` for the final full-batch Candidate v1 check; this tool does not claim to be a shared A/B/C/D workbench.

## B batch sequence

1. Run `prepare` for the owner-assigned B batch. Read each complete Canonical chunk with all original fields and source IDs; do not treat truncated output as a complete chunk.
2. For every exact source sense in the batch, perform both distinct B scenes and discover candidates without quotas or early stopping. Preserve candidates from prior completed work.
3. Save each complete chunk with every source `record_id` and every matching `sense_id`, including empty `candidates` arrays. `save-chunk` records candidate output only; it never marks scene exploration complete.
4. After actually completing both scenes for every source sense, including senses with no candidates, write each exact `record_id`/`sense_id` pair to a scratch JSONL file and call `mark-explored`. A candidate save is not an exploration receipt.
5. Compare every final candidate with its exact Canonical source sense. Complete the AI meaning and form review for every candidate, then call `mark-reviewed` with the exact reviewed candidates. The CLI records explicit receipts; it does not make or verify semantic judgments.
6. Resolve local corrections by source IDs. `patch-sense` is additive and preserves saved candidates. Remove a candidate only after its current meaning/form review confirms it is Stage 1 ineligible, using `remove-candidate` with the explicit confirmation field.
7. Run `merge` only after all chunks are saved, all source senses have current exploration receipts, and all active candidates have current review receipts. It rebuilds in Canonical order and runs the full Candidate v1 batch validator. Run `candidate-contract.mjs` against the final output path before submission.

All checkpoints, chunk inputs, receipts, and temporary outputs belong in `.warroom-scratch/`; commit only the formal Candidate JSONL. If Canonical source meaning changes, `prepare` invalidates affected exploration and review receipts. Use `exploration-pending` and `review-pending` to export only affected work. A Canonical record/sense membership change stops processing and preserves the checkpoint for explicit reconciliation.

## Commands

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

## Input and checkpoint rules

- `prepare` stores complete Canonical record rows, preserving original fields, in bounded source chunks. Each chunk reports its source range, record count, and sense count.
- `save-chunk` input uses `{"record_id":"w001","senses":[{"sense_id":"w001-s1","candidates":["별빛"]}]}`. It requires exact record and sense coverage for the selected chunk and rejects missing, extra, duplicate, or cross-mapped IDs. It never guesses mappings by array position and never silently slices, pads, drops, or moves candidate arrays. Saves add discoveries without removing previously saved candidates.
- `mark-explored` input is JSONL with exact identities, for example `{"record_id":"w001","sense_id":"w001-s1"}`. Include every source sense whose two scenes were actually explored. The file stores no scene narrative.
- `review-pending` exports unchecked or invalidated candidates together with their exact Canonical records/senses. `mark-reviewed` input uses `{"record_id":"w001","sense_id":"w001-s1","reviewed_candidates":["별빛"]}`. A changed candidate or source meaning invalidates the corresponding review receipt.
- `exploration-pending` exports pending or stale source senses and their current candidates. `mark-explored` after completing both scenes records the exact affected IDs.
- `patch-sense` accepts one JSON object, such as `{"record_id":"w001","sense_id":"w001-s1","candidates":["별빛","달빛"]}`. It changes only that sense and cannot remove an existing candidate; use `remove-candidate` for a separately reviewed, confirmed ineligible candidate.
- `remove-candidate` accepts one JSON object with `record_id`, `sense_id`, exact `candidate`, and `confirmed_ineligible: true`; it also requires a current AI meaning/form review receipt for that candidate.
- `merge` writes either under `.warroom-scratch/` or to a correctly named B Candidate path. It refuses incomplete chunks, missing/stale exploration, and pending/stale candidate reviews before writing output.

The saved checkpoint is the recovery source after interruption. Resume with `prepare` and `status`; do not rebuild a correct chunk or discard previously saved candidates to recover from a local error.
