# A/B Candidate workbench

`scripts/relation/candidate-workbench.mjs` is the shared A/B tool for reading Canonical chunks, saving complete chunks of Candidate output, making local corrections, and assembling the final file. It does only mechanical work: the AI exploration and final candidate editing remain governed by [#860](https://github.com/neverworkalone/typewriter/issues/860) (A: one sufficient integrated exploration per source sense, with a second one only for a meaningful unexplored direction; B: one hypothetical scene per exact source sense, explored fully). The tool keeps no exploration or review receipts and does not claim that any semantic work happened.

## Normal path

```text
prepare → read-chunk → explore & edit candidates in place → save-chunk (per chunk) → merge → PR
```

1. `prepare` reads the Canonical shard once, fixes the batch, and writes source chunks (25–50 records). Re-running it on an existing scratch directory just reuses the checkpoint and reports which chunks are saved; it does not re-read or re-verify anything.
2. `read-chunk` returns a light, compact-JSON view of each Canonical record once: `id`, `lemma`, `homograph_no` (if any), `search_forms` (only when they differ from the lemma), and every sense's `id`, `pos` and full `gloss`, plus each sense's current `candidates` once saved. Stored Canonical data, the checkpoint and the final validator are unchanged. A 50-record chunk normally fits one page (limit 50); continue with `--offset <next_offset>` only while `has_more` is true. A record too large for one page is split by sense, never clipped.
3. Explore per #860 and finalize the candidates for that exact source sense and gloss right away. Do not re-read the chunk to re-confirm each candidate.
4. `save-chunk` writes the **complete chunk** (every `record_id` and `sense_id`, empty arrays included), replacing any earlier save of that chunk. That chunk's IDs and candidate format are checked. Compact A/B saves also remove only empty fields, normalized duplicates, and source-lemma repeats confirmed by the existing source-bound matcher; they report each removal. Edit while exploring and save each finished chunk once; `status`, `inspect` and `patch` are for errors and resuming only.
5. Fix several bad candidates in one `patch` call (below), or re-save the chunk.
6. `merge` assembles the saved chunks in Canonical order, compares the batch against the Canonical SHA fixed at `prepare` (only here), and runs the full Candidate v1 validator once. Then open the PR; CI and PR review are unchanged.

## Commands

```sh
node scripts/relation/candidate-workbench.mjs prepare \
  --shard 001 --batch 01 --method a --model codex \
  --scratch-dir .warroom-scratch/001_01_a_codex --chunk-size 25
# B: use --method b, a B scratch directory and --chunk-size 50 (10 chunks for a full 500-record batch); read-chunk may paginate at output limits

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

Compact I/O (Supervisor answer-only chunks; the JSON commands above are unchanged):

```sh
node scripts/relation/candidate-workbench.mjs read-chunk \
  --scratch-dir .warroom-scratch/001_01_a_codex --chunk 1 \
  --format compact --out .warroom-scratch/001_01_a_codex/view-001.txt

node scripts/relation/candidate-workbench.mjs save-chunk \
  --scratch-dir .warroom-scratch/001_01_a_codex --chunk 1 --format compact \
  --input .warroom-scratch/001_01_a_codex/answer-001.tsv
```

`status` lists unsaved chunks; `inspect --shard SSS --record-id ID` prints one full Canonical record. Use `--method b` for B.

## Input formats

- `save-chunk` (JSONL, one row per record): `{"record_id":"w001","senses":[{"sense_id":"w001-s1","candidates":["별빛"]}]}`. IDs must match the chunk exactly: no missing, extra, duplicate, or cross-mapped record or sense. Candidates must be non-empty trimmed strings without normalized duplicates, and must not exactly repeat the chunk's own source lemma (also with a lone parenthetical annotation, or as a spacing/hyphen variant listed in its `search_forms`) — the same rule the final `merge` validator applies, reported here at the failing record/sense. Finish editing (dedupe, self-repeats, sentence-like phrases, gloss restatements) **before** writing the array; save the complete configured chunk (A: usually 25 records; B: 50 records for a new full batch, potentially shorter for the final chunk) once, and use `patch` only for clear local fixes to candidates that are actually in the saved chunk.
- Compact view (`read-chunk --format compact`): the whole chunk as tab-separated lines `S<n>`, `sense_id`, `lemma [homograph]`, `pos`, `search_forms` (empty when only the lemma), full untruncated `gloss`; `S<n>` numbers every Canonical sense of the chunk in Canonical order, and a saved chunk adds `C<TAB>S<n><TAB>candidates…`. No paging: with `--out` (inside `.warroom-scratch`) the file is written atomically and read back; without it the text must fit the stdout caps. A field containing a tab or line break fails closed; read that chunk as JSON.
- Compact answer (`save-chunk --format compact`): line 1 `chunk NNN`, then exactly one `S<n>` line per sense of that chunk, candidates tab-separated after the alias (`S<n>` alone = no candidates). Empty fields are treated as absent candidates; exact normalized duplicates keep their first value. Definite source-lemma repeats are removed using the same source-bound matcher as Candidate v1. The CLI result reports every removed value with its alias and reason in `autoRemoved`; the JSON save remains strict. Wrong chunk number, unknown/duplicate/missing alias, CR or blank line still fails closed; aliases expand to exact `record_id`/`sense_id` and the cleaned chunk goes through the same candidate checks and atomic write as the JSON save.
- `patch` (JSONL, one row per sense): `{"record_id":"w001","sense_id":"w001-s1","remove":["은하수"],"add":["달무리"]}`. `remove` must match an existing candidate exactly; unknown IDs fail the whole patch and nothing is written. Other senses and candidates are untouched.

## War Room answer-only path (#2035)

For War Room batches the AI never runs these commands. The Supervisor prepares the batch once (new A/B: `--chunk-size 50`; an existing checkpoint keeps its size), then for each unsaved chunk writes `read-chunk --format compact --out` into `.warroom-scratch/<batch>/view-NNN.txt`, inlines it in a self-contained card (`tools/warroom/prompts/a_chunk.md` / `b_chunk.md`) for one new AI session, and takes only the session's **final answer** (`BEGIN chunk NNN` … `END chunk NNN`, one `S<n>` line per sense) into `answer-NNN.tsv`, which `save-chunk --format compact` validates and stores. A rejected save resumes that same session for the pointed `S<n>` rows only (at most 3 corrections per chunk, limit kept across restarts). After the third correction, only an exactly identified rejected candidate may be removed, and the chunk advances only if that same save validation then succeeds. After all chunks are saved the Supervisor runs `merge` once, then commit/push/PR. A merge rejection that names one chunk's records re-opens only that chunk. Review fixes are small `fix_new` sessions that receive the reviewer's named senses with their exact source rows; candidates of other senses must stay unchanged. Set `ab_chunk_sessions: false` in the War Room config to keep the previous long session.

## Files and resuming

All scratch data lives in `.warroom-scratch/<batch>/`: `checkpoint.json` (written once), `source/chunk-NNN.jsonl`, and `candidates/chunk-NNN.jsonl` (existence = saved). Commit only the formal Candidate JSONL. Output is compact JSON, capped (50 items, 32,768 characters, 64 KiB per command); use the returned `next_offset`. If the Canonical batch changes after `prepare`, `merge` stops and the saved candidates stay in place.
