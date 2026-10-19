# C V5 Blind Reproduction — shard 013 / batch 01

Frozen procedure: `experiments/1061/v5/C_PROCEDURE.md` (V5, digest
`4f8b8bfbb1543b48fd4027646f6b8b40e7859caaaf2c1a973d292ba5a1f46e1b`).
This run is a reproduction, not a V6 development. No new rules were added.

No source text, excerpts, SQLite files or raw search logs are committed.

## 1. Input and environment

| Item | Value |
|---|---|
| Canonical | `data/canonical/stdict-0013.jsonl` (SHA-256 `d7d1534437da8db369c0d65eade1e63e45d73e96892aea81a4a420020114192e`) |
| Batch | `01`, rows 1–500 |
| Records | 500 (`w14502` … `w15188`) |
| Senses | 560 (47 records have more than one sense) |
| Literature index | local SQLite, read-only, SHA-256 `07770a5f5db772b66980fe484c30c7448771f8a4629f64abd6072023f1dd99f7` (10,470 works / 864,774 units) |
| Search layer | FTS5 trigram for forms of 3+ characters, `instr()` scan for 2-character forms, word-initial boundary filter, `instr()` re-verification |
| Model | DeepSeek (single producer, no other model or subagent) |

Blind control: no Codex candidate, no other producer's candidate, no A/B/D
result, and no previous DeepSeek candidate file was opened. Nothing under
`data/relation-candidates/` was read.

## 2. Execution structure

- **PASS 1** — every record searched; every hit record's sampled context read,
  sense-bound, and examined against the seven lenses (image, action, emotion,
  sensation, situation, causality, metaphor/contrast).
- **PASS 2** — adaptive expansion: four senses re-queried with a different
  work sample (`거세다`, `걸음걸이`, `검거하다`, `검거되다`); three yielded new
  relations.
- **PASS 3** — adversarial audit of the whole pool (sense accuracy, evidence,
  editorial value, independent contribution, counterargument).

Checkpoints: the per-sense state log was kept locally and updated after each
block of 35 records; the final counts below are read from it.

## 3. Search status

| Status | Records | Senses |
|---|---:|---:|
| No searchable form (1-character headword) | 3 | 3 |
| Searched, zero word-initial context | 322 | 340 |
| Word-initial contexts found | 175 | 217 |
| Search failure (index error) | 0 | 0 |
| **Total** | **500** | **560** |

Contexts: 13,381 word-initial matches were available; **175 sampled contexts**
in PASS 1 (one per hit record) and **32** in PASS 2 were actually read
(207 inspected). Sense binding of the sampled context: **51 VERIFIED**,
83 REJECTED (other word/sense/hanja reading), 28 no-evidence, 8 AMBIGUOUS.
The remaining senses had no VERIFIED context in the single sampled context.

## 4. Discovery and audit

| Stage | Candidates |
|---|---:|
| PASS 1 discovery | 68 |
| PASS 2 expansion | 6 |
| Discovery pool | 74 |
| Audit removals | 9 |
| **Final** | **65** |

Audit removals: 1 source-word phrase (`건백서를 올리다`), 5 plain nouns/verbs
with no independent relation, 1 fragment (`불안한`), 1 sense-duplicate
(`보리밭` vs `누런 밭`), 1 co-present object (`개구리`).

Final distribution: 43 active senses, 1.51 candidates per active sense.
Per-sense: 1 → 24, 2 → 17, 3 → 1, 4 → 1.

Relation types (lens of origin): image 17, association 13, action 10,
emotion 8, sensation 8, situation 4, sensory 3, contrast 2.

Derivation: exact 49 / inflected 7 / context-derived 9 (63 unique strings).
Source-lemma-containing: 0.

## 5. New relations found by expansion

| Sense | New relation |
|---|---|
| `거세다` (기세가 세차다) | `무서운 정열` |
| `걸음걸이` | `비실비실` |
| `검거하다` | `연루자`, `엄중 취조` |
| `검거되다` | `유언비어` |

Expansion stop reasons: for the four senses, new contexts either duplicated
the existing relation (`거세다`, `검거하다`) or stopped adding after the second
sample. All other active senses were not expanded in this run (see §7).

## 6. Stop-reason distribution (sense level)

| Reason | Senses |
|---|---:|
| VERIFIED context, no further relation supported | 51 |
| No VERIFIED context in the sampled context | 390 |
| Rejected (other word/sense/hanja reading) | 83 |
| No evidence in sample | 28 |
| Ambiguous | 8 |
| **Total** | **560** |

## 7. Honest execution limits

1. **One sampled context per hit record.** The seven lenses were applied to
   each VERIFIED context, but one context rarely supports all seven; several
   lenses are empty because the sample holds no evidence, not because the
   corpus lacks it.
2. **PASS 2 was partial.** Only 4 of 217 candidate senses were re-queried with
   a fresh work sample. The remaining senses stop at "no second sample in this
   run" — this is an execution limit, not a conclusion that no further
   relations exist.
3. **390 senses have no VERIFIED context in the sample.** `no_verified_context`
   means "not found in the one context read", not "absent from the corpus".
4. **The seven-lens review was applied per context, not exhaustively per
   sense.** Some senses with zero candidates may hold valid relations in
   unsampled works.
5. **No independent audit.** All counts above are producer-side tallies from
   the local state log; the contract validator only proves structure.
6. **No comparison with Codex or other producers was made.** Candidate count is
   not a quality claim.

## 8. Cost

- Preflight (500 records, probe generation, index scan): ~34 s.
- Digest generation: ~20 s.
- Reading: 175 digest blocks (~35 KB) + 32 expansion contexts (~8 KB).
- Local queries: 648 probe forms × (match + count) in preflight, plus 12
  expansion probes.
- Token usage is not exposed by the harness; not estimated.

## 9. Contract validation

`validateCandidateBatch(stdict-0013, batch='01')` →
`recordCount=500, senseCount=560, candidateCount=65, emptySenseCount=517`.
That is structural validation, not semantic certification.
