# Corpus lemma pilot report (#201)

Run date: 2026-09-28. This report records the initial local reference workflow
run. At that stage candidate names and corpus contexts remained in the ignored
local inventory. Issue #204 later records all 100 editorial outcomes and the
bounded canonical follow-up; see
[corpus-lemma-pilot-report-issue-204.md](corpus-lemma-pilot-report-issue-204.md).

## Input and reproducibility

| Input | Result |
| --- | --- |
| Corpus index | 3.67 GiB; 3,410 source files, 3,410 documents, 4,988,970 paragraphs |
| Corpus input-manifest SHA-256 | `50dd0c6c4ecb9250e75c11dde9e854e1b39de14e12d7a7087d2da041d75ef211` |
| Corpus logical-row SHA-256 | `c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd` |
| Extraction sample | Paragraph ordinals divisible by 20 in each source-ordered document; 251,086 paragraphs (5.0328%), spanning all 3,410 documents and sources |
| Typewriter surface | 5,042 records, 5,298 curated search forms, 3,264 generated surface forms; 8,063 distinct NFC/trimmed coverage keys (5,042 with canonical lemmas, 5,298 with curated forms, 2,774 with generated forms) |
| Typewriter canonical revision | `8dad0cd312a7fb8c2073c3aaf8cd2c96e70875a035877e83e9292c6c74d359b9` |
| Morphology tool | Python 3.11.10; kiwipiepy 0.24.0 and model 0.24.0; Node v24.19.0 / SQLite 3.53.3 |

The scan reads at most 32 selected paragraph rows at a time and aggregates one
document/source at a time. It does not load the SQLite file or unbounded
paragraph arrays into application memory. Re-run instructions are in
[`corpus-lemma-pilot-issue-201.md`](corpus-lemma-pilot-issue-201.md).

## Yield and evidence

| Measure | Result |
| --- | ---: |
| NNG/VV/VA observations before lemma-shape filtering | 4,744,393 |
| Accepted analyzer morpheme observations in the sample | 4,073,787 |
| Observations excluded by the two-syllable Hangul shape rule | 669,364 |
| Observations excluded because the analyzer span was invalid | 1,242 |
| Distinct proposed lemma/POS candidates before coverage | 55,649 |
| Distinct proposed lemma strings before coverage | 55,580 |
| Exact canonical lemma matches | 1,976 |
| Candidate strings without an exact canonical lemma | 53,604 |
| Search-form collisions retained for review across the full sample | 25 |
| Generated-surface collisions retained for review across the full sample | 16 |
| Strings colliding with both search and generated surfaces | 0 |
| Total surface collisions retained for review across the full sample | 41 |
| Candidate inventory size | 100 |
| Inventory POS split | 41 nouns, 48 verbs, 11 adjectives |

Only exact canonical lemma matches are excluded as already covered. Search-form
and generated-surface matches retain their match kind, record ID, canonical
lemma, and (for generated forms) sense, POS, and rule. Collisions remain in the
candidate pool with a held decision. Of the selected 100, one had a curated
search-form collision and was held; the other 99 had no Typewriter surface
collision. No generated-surface collision appeared in the selected 100. The
local staging database retains all product matches and per-candidate coverage
statuses so the yield is reproducible.

The inventory contains 60 candidate-state rows and 40 held rows: 39
whose observed morpheme spans map to multiple analyzer interpretations, plus
the one curated search-form collision. Across the full extracted lemma/POS
table, 930 distinct lemma strings had a surface or POS ambiguity, and 22,845
lemma/POS rows contained at least one Kiwi OOV-marked observation. None of the
100 inventory rows had an OOV-marked observation. These are mechanical flags,
not a human false-positive audit. Kiwi confidence is uncalibrated; compound
boundaries and one-best analyses still require editorial review.

For each inventory item, the dominant whitespace-delimited surface containing
the proposed morpheme was counted with `countCorpusMatches()` and queried with
`searchCorpusIndex(limit: 3)`. The run recorded 100 SQL aggregate counts and 300
bounded paragraph hits in the ignored local inventory. The per-candidate
literal paragraph counts ranged from 6,545 to 1,919,357, with a median of
45,897. Their sum is 9,540,066; queries overlap, so this is not a distinct
paragraph count or a lemma/token frequency. Fifty-seven short queries used the
one- or two-character literal fallback. Sample source spread ranged from 1,538
to 3,400 documents per candidate; the median largest-source share was 0.865%,
with a 3.51% maximum.

## Editorial and publication outcome

No candidate was selected for canonical admission. The 100 rows remain in the
local candidate inventory with `candidate` or `held` state. No canonical JSONL
or product file changed. Writer usefulness, correction rate, and editorial
workload remain `NOT_MEASURED`; no writer reviewed the candidates. No weak
record was added to meet the inventory size.

The repository permission record covers local reference analysis. Issue #201
has no comments confirming permission to publish corpus-derived canonical
rows, so the publication state remains held. Any later selected row must pass
the shared lexical production/admission path and normal canonical/search
validation after the owner confirms the publication gate. The pilot tooling
and corpus-reference tests remain local/manual and outside normal CI.

## Local outputs

All three files below are ignored under `data/reference/`:

- `data/reference/pilots/issue-201/candidate-analysis.sqlite` — aggregated
  sample counts, structured coverage provenance, and ambiguity decisions,
  without paragraph text;
- `data/reference/pilots/issue-201/candidate-selection.json` — the 100
  corpus-derived candidate rows before evidence contexts;
- `data/reference/pilots/issue-201/pilot-inventory.json` — tool/index
  provenance, the 100 candidates, full literal counts, and up to three local
  paragraph examples per candidate.

No source paragraph, candidate name, or evidence excerpt is stored in this
tracked report.

## Issue #204 follow-up

After this initial extraction report, issue #204 reviewed all 100 candidates and
prepared ten new searchable starts containing 13 senses through the shared
lexical production/admission path. The complete disposition, provenance,
search validation, and publication-gate status are recorded in the
[issue #204 follow-up report](corpus-lemma-pilot-report-issue-204.md). Its
canonical-mutating PR remains unmerged pending owner confirmation.
