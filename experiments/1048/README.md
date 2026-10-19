# Issue #1048 — DeepSeek D experiment (Shard 001 / Batch 01)

This directory contains the **experimental** Method D output for
[Issue #1048](https://github.com/neverworkalone/typewriter/issues/1048). It is
not a formal `data/relation-candidates/` batch and does not advance the #860
production cursor or claim any formal D batch.

## Run

- Model: `deepseek-v4.1-flash`
- Provider path: OpenCode Go
- Run date: 2026-10-19
- Method: D only (written-corpus usage contexts); A/B/C were not run.
- Prompt: the D prompt in [`docs/relation-factory.md`](../../docs/relation-factory.md)
  ("말뭉치의 실제 쓰임과 표현적 연결"), applied unchanged.
- Isolation: the existing Codex C/D candidate files, other producers' candidate
  files, Stage 2 relations/drops, and admission decisions were not read. No
  other model, CLI, or subagent was invoked. No comparison or scoring was
  performed because this task covered D production only.

## Inputs

| Input | Value |
| --- | --- |
| Canonical source | `data/canonical/stdict-0001.jsonl`, records 1–500 |
| Records / senses | 500 / 750 |
| Canonical first-500-lines SHA-256 | `6c63e80c22cf2bb2e8443cbcffdda51f87a2f3a546869d8af0784b0ab80235a4` |
| Corpus index | `~/.cache/typewriter/reference/corpus/indexes/written-corpus-2025.sqlite` |
| Index schema / builder | `1` / `1` |
| Index SQLite version | `3.53.3` |
| Index sources / documents / paragraphs | 3,410 / 3,410 / 4,988,970 |
| Index input-manifest SHA-256 | `50dd0c6c4ecb9250e75c11dde9e854e1b39de14e12d7a7087d2da041d75ef211` |
| Index logical-rows SHA-256 | `c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd` |

The index was opened read-only. Retrieval used FTS5 trigram literal lookup (with
a literal fallback for forms shorter than three characters), up to 60 raw
paragraph hits per search form and up to 8 sentence-level contexts spread across
the hit range and titles. Retrieval of the 500-record batch took about 8 minutes
on the local machine. Token usage was not measured. Raw paragraphs, excerpts,
and search logs were kept outside Git; only the candidate strings below are
committed.

**Corpus limitation:** every source file in this local index snapshot has the
category `문어 > 책-상상 > 문학`. The results therefore reflect this
literary-skewed local corpus and must not be treated as representative of
general written Korean.

## Output

- File: `001_01_d_deepseek.jsonl` (Candidate JSONL v1, 500 lines)
- Records: 500 (all Canonical records and senses preserved in order)
- Senses: 750
- Candidates: 539
- Senses with at least one candidate: 204
- Empty senses: 546 (including senses whose contexts did not support the bound
  sense or where no defensible usage connection was found)

The candidate count is not a quality target. A candidate was kept only when the
retrieved usage context supported a concrete connection to the exact source
sense. Homograph and substring false positives were excluded; for example,
contexts matching `가계도`, `가계부`, `불가결`, `영양결핍`, or `논두렁` were not
used for unrelated senses.

## Validation

`validateCandidateBatch` from `scripts/relation/candidate-contract.mjs` was run
against records 1–500 of the Canonical shard. It reported:

- 500 records / 750 senses
- 539 candidates
- 546 empty senses
- 0 source-lemma candidates, no duplicate candidate within a sense, no
  whitespace or empty-string violations, and only the allowed fields.

This structural check is not an editorial admission decision. Relation type,
relevance/Tier, target IDs, and keep/drop decisions remain for Stage 2.
