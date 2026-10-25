# A/B Candidate workbench

`scripts/relation/candidate-workbench.mjs` is the shared A/B tool for reading Canonical chunks, saving complete chunks of Candidate output, making local corrections, and assembling the final file. It does only mechanical work: the AI exploration and final candidate editing remain governed by [#860](https://github.com/neverworkalone/typewriter/issues/860) (A: one sufficient integrated exploration per source sense, with a second one only for a meaningful unexplored direction; B: two distinct scenes). The tool keeps no exploration or review receipts and does not claim that any semantic work happened.

## Normal path

```text
prepare → read-chunk → explore & edit candidates in place → save-chunk (per chunk) → merge → PR
```

1. `prepare` reads the Canonical shard once, fixes the batch, and writes source chunks (25–50 records). Re-running it on an existing scratch directory just reuses the checkpoint and reports which chunks are saved; it does not re-read or re-verify anything.
2. `read-chunk` returns each Canonical record once, with all its senses (original fields and gloss) and, once saved, each sense's current `candidates`. Continue with `--offset <next_offset>` while `has_more` is true. A record too large for one page is split by sense, never clipped.
3. Explore per #860 and finalize the candidates for that exact source sense and gloss right away. Do not re-read the chunk to re-confirm each candidate.
4. `save-chunk` writes the **complete chunk** (every `record_id` and `sense_id`, empty arrays included), replacing any earlier save of that chunk. Only that chunk's IDs and candidate format are checked.
5. Fix several bad candidates in one `patch` call (below), or re-save the chunk.
6. `merge` assembles the saved chunks in Canonical order, compares the batch against the Canonical SHA fixed at `prepare` (only here), and runs the full Candidate v1 validator once. Then open the PR; CI and PR review are unchanged.

## Commands

```sh
node scripts/relation/candidate-workbench.mjs prepare \
  --shard 001 --batch 01 --method a --model codex \
  --scratch-dir .warroom-scratch/001_01_a_codex --chunk-size 25

node scripts/relation/candidate-workbench.mjs read-chunk \
  --scratch-dir .warroom-scratch/001_01_a_codex --chunk 1

node scripts/relation/candidate-workbench.mjs save-chunk \
  --scratch-dir .warroom-scratch/001_01_a_codex --chunk 1 \
  --input .warroom-scratch/001_01_a_codex/chunk-001-candidates.jsonl

node scripts/relation/candidate-workbench.mjs patch \
  --scratch-dir .warroom-scratch/001_01_a_codex \
  --input .warroom-scratch/001_01_a_codex/patches.jsonl

node scripts/relation/candidate-workbench.mjs merge \
  --scratch-dir .warroom-scratch/001_01_a_codex \
  --out data/relation-candidates/001/001_01_a_codex.jsonl
```

`status` lists unsaved chunks; `inspect --shard SSS --record-id ID` prints one full Canonical record. Use `--method b` for B.

## Input formats

- `save-chunk` (JSONL, one row per record): `{"record_id":"w001","senses":[{"sense_id":"w001-s1","candidates":["별빛"]}]}`. IDs must match the chunk exactly: no missing, extra, duplicate, or cross-mapped record or sense. Candidates must be non-empty trimmed strings without normalized duplicates.
- `patch` (JSONL, one row per sense): `{"record_id":"w001","sense_id":"w001-s1","remove":["은하수"],"add":["달무리"]}`. `remove` must match an existing candidate exactly; unknown IDs fail the whole patch and nothing is written. Other senses and candidates are untouched.

## Files and resuming

All scratch data lives in `.warroom-scratch/<batch>/`: `checkpoint.json` (written once), `source/chunk-NNN.jsonl`, and `candidates/chunk-NNN.jsonl` (existence = saved). Commit only the formal Candidate JSONL. Output is capped (25 items, 32,768 characters, 64 KiB per command); use the returned `next_offset`. If the Canonical batch changes after `prepare`, `merge` stops and the saved candidates stay in place.
