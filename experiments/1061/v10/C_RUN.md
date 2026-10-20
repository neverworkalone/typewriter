# C V10 — Run record (CALIBRATION)

**Issue:** #1109 (this PR uses `Refs #1109`; it does not close the issue)
**Mode:** `CALIBRATION` — not FREEZE, not blind reproduction, not formal batch production
**Shard / batch:** `013` / `01`
**Records / senses:** 500 / 560
**Model:** DeepSeek V4.1 Flash Free (provider: opencode)
**Run ID:** `c-v10-013-01-deepseek-20261020`
**Date:** 2026-10-20

## 1. Frozen snapshot

| item | value |
| --- | --- |
| Canonical shard | `data/canonical/stdict-0013.jsonl` |
| Canonical SHA-256 | `d7d1534437da8db369c0d65eade1e63e45d73e96892aea81a4a420020114192e` |
| Literature index SHA-256 | `07770a5f5db772b66980fe484c30c7448771f8a4629f64abd6072023f1dd99f7` |
| Procedure | `C_PROCEDURE.md` |
| Procedure SHA-256 | `3ac925545449a799f8239ffcd366fe39ed865a0ba07f75d54360e4ed2b1191f3` |
| Candidate output | `013_01_c_deepseek.jsonl` |
| Candidate output SHA-256 | `f72e96828d625e110be275b7b8c788463d2c6758cba8127a813de2711d468f6e` |
| Git HEAD at run | `2af4d21a8775659b8364156b0129615de9d5218d` |

The Canonical shard was frozen before discovery: 500 records, 560 senses, fixed
order, IDs, lemma, part of speech, gloss, and search forms. No Canonical record
was edited by this run.

## 2. Result summary

| metric | value |
| --- | --- |
| records | 500 |
| senses | 560 |
| candidates | **1,322** |
| active senses (non-empty) | **103** |
| empty senses | **457** |
| no-space candidates | **1,220** |
| space-containing candidates | **102** |
| no-space + space | **1,322** |
| complete sentences / predicative clauses / narrated events / process descriptions | **0** |
| active senses without direct `VERIFIED` evidence | **0** |

Mechanical word-count distribution read directly from the final JSONL:

| whitespace tokens | candidates |
| --- | --- |
| 1 | 1,220 |
| 2 | 92 |
| 3 | 10 |
| 4 or more | 0 |
| **total** | **1,322** |

Semantic form classification (mutually exclusive, also sums to the total):

| category | candidates |
| --- | --- |
| word (single lexical item, non-idiom) | 1,217 |
| condensed phrase (space-containing, non-idiom) | 96 |
| idiom / fixed expression | 9 |
| **total** | **1,322** |

The 9 idiom/fixed expressions are counted as 3 no-space and 6 space-containing
items. The no-space total is therefore `1,217 words + 3 idioms = 1,220`, and the
space total is `96 phrases + 6 idioms = 102`.

## 3. Source search and verification

The V9 search ledger is retained as the search-stage record. The V10 strict
re-audit is a separate pass over the exact source-sense binding.

### 3.1 Search-stage record (V9 ledger, retained)

| metric | value |
| --- | --- |
| senses with literary hits and inspection | 218 |
| contexts actually read | 1,360 |
| `VERIFIED` contexts | 393 |
| `AMBIGUOUS` contexts | 19 |
| `REJECTED` contexts | 948 |
| status: `VERIFIED` senses | 106 |
| status: `AMBIGUOUS` senses | 7 |
| status: `NO_VERIFIED` senses | 105 |
| `SEARCH_FAILED` | 0 |

Of the 560 frozen senses, 218 had searchable literary hits. The remaining 342
senses had zero hit units; 4 of those were `UNSEARCHABLE` (the index cannot
resolve them reliably). They remain empty and are not reported as searched.

### 3.2 V10 strict source re-audit

The V10 audit built a direct-usage set from prior V8/V9 evidence plus manual
re-reads of senses that had no base `VERIFIED` record: **108 senses / 409
contexts**. The audit then removed five senses whose inspected contexts did not
actually use the target Canonical sense. Result:

| metric | value |
| --- | --- |
| senses with direct `VERIFIED` usage before removal | 108 |
| contexts in that set before removal | 409 |
| senses removed by strict re-audit | 5 |
| contexts removed with them | 18 |
| **final active senses** | **103** |
| **final direct `VERIFIED` contexts** | **391** |

The final active set is 103 senses / 391 contexts. Every non-empty sense in the
output has at least one direct `VERIFIED` context. No `AMBIGUOUS`-only or
`NO_VERIFIED` sense outputs candidates.

Empty-sense reconciliation:

```text
457 empty = 342 zero-hit (including 4 unsearchable)
          + 105 NO_VERIFIED senses
          +   5 source-failed VERIFIED senses
          +   4 unresolved AMBIGUOUS senses
          +   1 inactive AMBIGUOUS sense
```

Active-sense reconciliation:

```text
103 active = 101 V9 VERIFIED senses that passed the re-audit
           +   2 AMBIGUOUS senses resolved to VERIFIED
```

### 3.3 V9's six AMBIGUOUS active senses

| sense_id | V9 status | V10 attribution | final output |
| --- | --- | --- | --- |
| `w14555-s1` | `AMBIGUOUS` | `NO_VERIFIED` | empty |
| `w14605-s1` | `AMBIGUOUS` | `NO_VERIFIED` | empty |
| `w14807-s1` | `AMBIGUOUS` | `VERIFIED` (乞言 usage confirmed) | 8 candidates |
| `w14896-s1` | `AMBIGUOUS` | `NO_VERIFIED` | empty |
| `w15181-s1` | `AMBIGUOUS` | `VERIFIED` (乾性 usage confirmed) | 8 candidates |
| `w15181-s2` | `AMBIGUOUS` | `NO_VERIFIED` | empty |

Two of the six were re-bound to the exact sense; four remain unresolved and are
excluded. The seventh ledger `AMBIGUOUS` sense, `w14570-s2`, was inactive (no
candidates) and is not one of the six active cases.

### 3.4 Additional senses removed by the V10 source audit

These senses had V9 candidates and appeared in the prior verified set, but
re-reading showed no direct use of the exact Canonical sense. They are
**source failures**, not editorial quality Drops.

| sense_id | reason (no source text reproduced) | final output |
| --- | --- | --- |
| `w14552-s1` | noun sense; inspected contexts use the derived noun 겉치레 only | empty |
| `w14611-s1` | verb sense; inspected contexts use a different noun/verb form | empty |
| `w14742-s1` | inspected contexts use 겁 as an emotion, not the target 겁의 sense | empty |
| `w14792-s1` | noun sense; only adnominal-form contexts were found | empty |
| `w14978-s1` | noun sense; only adnominal-form contexts were found | empty |

Together with the four unresolved `AMBIGUOUS` senses, these are the nine senses
that had V9 candidates and now output `[]`.

## 4. Seven lenses × two independent sweeps

Lenses: `image`, `action`, `emotion`, `sensation`, `scene`, `causality`,
`metaphor`. Every `VERIFIED` context was read under all seven lenses in sweep 1
and again, independently, in sweep 2.

### 4.1 Sweep 1 — full re-read and primary-lens attribution

Sweep 1 covered the V9 active set: 112 senses / 409 verified contexts. It
re-read the contexts and attributed the existing candidate pool to a primary
lens. Raw and unique counts are identical because the pool was already
deduplicated; the point of sweep 1 is independent re-reading and lens coverage,
not string creation.

| lens | inspected contexts | raw candidates | unique | duplicates in sweep | zero sense×lens cells |
| --- | ---: | ---: | ---: | ---: | ---: |
| image | 409 | 392 | 392 | 0 | 26 |
| action | 409 | 104 | 104 | 0 | 52 |
| emotion | 409 | 58 | 58 | 0 | 83 |
| sensation | 409 | 22 | 22 | 0 | 97 |
| scene | 409 | 247 | 247 | 0 | 43 |
| causality | 409 | 4 | 4 | 0 | 108 |
| metaphor | 409 | 2 | 2 | 0 | 110 |
| **total** | **409** | **829** | **829** | **0** | **519** |

Sweep 1 newly active senses: **112** (the V9 active set). Nine of these were
later removed by the strict source re-audit in §3.4, leaving 103.

Zero-result granularity for sweep 1: the local ledger records candidate presence
at **sense × lens** level. `112 senses × 7 lenses = 784` cells; 265 cells have at
least one candidate; 519 are zero. Sweep 1's context-level candidate provenance
was not materialized as a separate context × lens matrix; this is a recorded
limitation, not a claim of per-context zero counts.

### 4.2 Sweep 2 — independent fresh discovery

Sweep 2 re-read all verified contexts again without using sweep 1's string list
as the discovery input. It covered 105 senses / 396 verified contexts (the 103
final active senses plus the two source-failed senses that still had verified
contexts at sweep time).

| lens | inspected contexts | raw discoveries | unique additions | duplicates with sweep 1 | source-failed items | zero context×lens cells |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| image | 396 | 208 | 194 | 13 | 1 | 267 |
| action | 396 | 68 | 63 | 5 | 0 | 340 |
| emotion | 396 | 32 | 27 | 3 | 2 | 372 |
| sensation | 396 | 16 | 13 | 2 | 1 | 382 |
| scene | 396 | 258 | 236 | 19 | 3 | 230 |
| causality | 396 | 5 | 4 | 0 | 1 | 391 |
| metaphor | 396 | 0 | 0 | 0 | 0 | 396 |
| **total** | **396** | **587** | **537** | **42** | **8** | **2,378** |

`396 contexts × 7 lenses = 2,772` context × lens cells. 394 cells contain at
least one raw discovery; 2,378 are zero. The total inspected-context value is 396
for each lens, not the sum of the column.

Sweep 2 newly active senses: **0**. Every sense discovered in sweep 2 was already
in the sweep 1 active set. The eight source-failed items belong to `w14552-s1`
and `w14611-s1`, which were removed by the source re-audit; they are not output.

### 4.3 Sweep reconciliation

```text
sweep 2 raw 587 = 42 exact duplicates with sweep 1
                +  8 source-failed items
                + 537 unique output additions
```

The 537 unique output additions are the pass-2 contribution to the final file.
The 42 duplicates preserve the independent-discovery lineage but are not
duplicated in the JSONL.

## 5. Form gate, exclusions, and extractions

### 5.1 Final form classification

| category | definition | count |
| --- | --- | ---: |
| word | one lexical item; may be ordinary, indirect, or unexpected | 1,217 |
| condensed phrase | short, non-narrative, independent image/expression; not an idiom | 96 |
| idiom / fixed expression | non-compositional idiom or lexicalized fixed expression | 9 |
| **total** | | **1,322** |

The nine idiom/fixed expressions:

- no-space (3): `주야겸행`, `풍마우세`, `부대건승`
- space-containing (6): `기진 맥진`, `겉과 속` (two senses), `피땀의 공`,
  `양심의 가책`, `기구한 운명`

The remaining 96 space-containing candidates are condensed phrases such as
object, place, weather, body, and scene images. They are not sentences and do
not narrate a procedure. No candidate has four or more whitespace tokens.

### 5.2 Sentence/event-description check

All 1,322 final strings were inspected individually, including every
space-containing string. Result:

```text
final_sentence_or_event_description_count = 0
```

- No complete sentence.
- No predicative clause presented as a candidate.
- No narrated action/event/procedure.
- No nominalized event/process description retained as a candidate.
- No `source lemma + modifier` routine phrase remains in the final file.

The final file's longest candidates have three whitespace tokens. All ten
three-token items are short images or fixed expressions; none describes who did
what to whom.

### 5.3 `FORM_EXCLUDED`

| source | count |
| --- | ---: |
| V9 form removals | 17 |
| V5–V8 prior form exclusions | 374 |
| **total** | **391** |

Reason split (local classification):

| reason | count |
| --- | ---: |
| sentence / predicative clause / narrated event or process | 242 |
| routine `lemma + modifier` / plain collocation / duplicate expansion / mechanical compound | 149 |
| **total** | **391** |

The 17 V9 removals are mechanical expansion phrases (for example, a source
lemma with a routine modifier, or a `lemma + period/quantity` compound). The 374
prior exclusions include sentence/event descriptions, routine expansions, and
four single-token forms (three routine compounds and one imperative clause).
These are output-form exclusions, not Stage 2 semantic Drops.

### 5.4 `FORM_EXTRACTED`

| source expression | extracted candidate | origin |
| --- | --- | --- |
| V9 phrase with `기금` | `기금` | V9 |
| V9 phrase with `최후` | `최후` | V9 |
| V9 phrase with `느리다` | `느리다` | V9 |
| V9 phrase with `점잖다` | `점잖다` | V9 |
| V9 phrase with `말년` | `말년` | V9 |
| V9 phrase with `건축공학` | `건축공학` | V9 |
| `흠정(欽定)` | `흠정` | V5–V8 |

Total `FORM_EXTRACTED = 7` (6 V9 + 1 prior). The six V9 extractions are the six
new words that are not present in the V9 pool, the pass-2 pool, or the prior
pool; they appear in the final composition as the “extracted” row.

## 6. V5–V9 lineage

### 6.1 V5–V8 prior pool (521 unique `sense_id + candidate` pairs)

| attribution | count |
| --- | ---: |
| `RETAINED` (also in V9 and final) | 114 |
| `RECOVERED` (not in V9, in final) | 19 |
| `FORM_EXTRACTED` | 1 |
| `STILL_UNVERIFIED_SOURCE` | 13 |
| `FORM_EXCLUDED` | 374 |
| **total** | **521** |

Of the 19 recovered pairs, 4 were also independently rediscovered in sweep 2
(`남대문역`, `웅변`, `박검사`, `도버해협`); the other 15 are prior-only
recoveries. The 13 `STILL_UNVERIFIED_SOURCE` pairs belong to senses with no
direct verified usage and are not output.

### 6.2 V9 pool (829 candidates)

| attribution | count |
| --- | ---: |
| `RETAINED` in final | 764 |
| `STILL_UNVERIFIED_SOURCE` (9 removed senses) | 48 |
| `FORM_EXCLUDED` | 17 |
| **total** | **829** |

The 48 source-failed candidates are distributed across the nine removed senses
listed in §3.3–§3.4. The 17 form exclusions are the V9 mechanical phrases.

### 6.3 Sweep 2 pool (587 raw discoveries)

| attribution | count |
| --- | ---: |
| exact duplicate with sweep 1 | 42 |
| `STILL_UNVERIFIED_SOURCE` | 8 |
| output addition | 537 |
| **total** | **587** |

### 6.4 Final composition

| source | count |
| --- | ---: |
| V9 retained | 764 |
| sweep 2 output additions | 537 |
| prior-only recoveries | 15 |
| `FORM_EXTRACTED` new words | 6 |
| **total** | **1,322** |

This composition is disjoint: each final candidate is counted in exactly one
row. The four prior recoveries that were also rediscovered in sweep 2 appear in
the sweep 2 row, not the prior-only row, which is why the prior-only row is 15
rather than 19.

## 7. Validation

### 7.1 Candidate contract

The existing validator was run against the complete Canonical shard and the
final file with batch 1. Output:

```json
{"recordCount":500,"senseCount":560,"candidateCount":1322,"emptySenseCount":457}
```

The validator checks record order and IDs, all 560 sense IDs, Candidate v1 keys,
normalized exact duplicates, source-lemma projections, thousands-comma
fragments, and the 500-record batch boundary.

### 7.2 Additional final checks

| check | result |
| --- | --- |
| records / senses | 500 / 560 |
| every non-empty sense has direct `VERIFIED` usage | 103 / 103 |
| `AMBIGUOUS`-only senses with candidates | 0 |
| exact source-lemma candidates | 0 |
| lemma + parenthetical-only candidates | 0 |
| normalized exact duplicates in one sense | 0 |
| empty or untrimmed strings | 0 |
| sentence / event / process descriptions | 0 |
| no-space + space = total | 1,220 + 102 = 1,322 |
| word + phrase + idiom = total | 1,217 + 96 + 9 = 1,322 |
| 1/2/3/4+ token distribution | 1,220 / 92 / 10 / 0 = 1,322 |
| Stage 2 fields (`type`, Tier, `target_id`, admission) | 0 |

### 7.3 What was not done

- No Stage 2 Drop, Tier, type, target, or admission decision.
- No read of another producer's candidates or another model's comparison.
- No other AI model, CLI agent, subagent, or reviewer was started.
- No Canonical, Relation, Drop, cursor, or V5–V9 artifact was modified.
- No raw corpus text, DB, locator, or search log is in this PR.
- No FREEZE, blind reproduction, or formal batch production was started.

## 8. Limits and unresolved items

1. **Calibration only.** This run does not claim blind reproducibility. The
   013/01 cohort has been viewed in earlier versions and cannot be used as a
   blind test.
2. **Coverage.** 342 of 560 senses had no searchable literary hit (4 of them
   unsearchable). They remain empty. 105 searched senses had no `VERIFIED`
   context. The output does not pretend those senses were completed.
3. **Source failures.** Five senses with V9 candidates were removed by the
   strict re-audit; four V9 `AMBIGUOUS` senses remain unresolved. All nine are
   recorded in §3.3–§3.4 and output `[]`.
4. **Context cap.** Search stopped at 16 inspected contexts per sense. A larger
   index or more windows could add relations for some senses.
5. **Zero-result granularity.** Sweep 1 zero counts are recorded at sense × lens
   level; sweep 2 zero counts are recorded at context × lens level. The RUN does
   not claim a context-level zero matrix for sweep 1.
6. **Editorial judgment.** The form gate is deliberately form-focused. Weak but
   eligible words and condensed images were retained for Stage 2. The producer
   did not estimate their eventual Tier or usefulness.
7. **No independent review.** This is the producer's self-check, not independent
   or human review. The issue's evaluation and FREEZE decision belong to the
   owner/ChatGPT.

## 9. Completion checklist

- [x] V9 word-centred recall, diversity, and zero sentence forms preserved.
- [x] Six V9 `AMBIGUOUS` active senses individually resolved or marked unresolved.
- [x] Every active sense has direct `VERIFIED` evidence; zero `AMBIGUOUS`-only.
- [x] Every verified context read under seven lenses in two independent sweeps.
- [x] Per-sweep/per-lens ledger and RUN totals reconcile.
- [x] V5–V9 recovery, `FORM_EXCLUDED`, and `FORM_EXTRACTED` attributed.
- [x] 500/560 Candidate v1 contract passes.
- [x] Final sentence/event/process-description count is 0.
- [x] No-space + space = total; semantic categories also equal the total.
- [x] Three files under `experiments/1061/v10/`.
- [x] PR uses `no-review` and `Refs #1109` only.
- [x] No FREEZE, blind, or formal production started.
