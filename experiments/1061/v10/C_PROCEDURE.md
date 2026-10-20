# C V10 — Candidate production procedure (CALIBRATION)

Status: **calibration procedure, not frozen**. This document describes how one C
producer builds a Candidate v1 batch from one Canonical 500-record shard batch.
It is intentionally limited to Stage 1. It does not define Stage 2 admission,
Tier, type, target IDs, or editorial Drop decisions.

The procedure has one purpose: given a frozen Canonical batch and a read-only
literary index, produce a complete Candidate v1 file whose non-empty senses are
bound to directly verified source-sense usage and whose strings are independent
words or genuinely condensed non-narrative expressions.

## 0. Role and hard boundaries

- The producer is **C only**. It emits candidates. It does not emit `type`,
  `relevance`, Tier, `target_id`, admission, or Drop metadata.
- The producer works only on its own assigned shard/batch and only on its own
  V5–V9 recovery assets. It must not open another producer's Candidate files,
  another model's comparison/evaluation, or another shard batch's candidates.
- Canonical data, the literature index/database, and all formal Candidate,
  Relations, Drops, and cursor files are read-only unless the active issue
  explicitly authorizes a write.
- Raw corpus text, excerpts, SQLite/DB locators, search logs, and source-attributed
  examples stay in local evidence. They are never committed or pasted into a PR.
- No other AI model, CLI agent, subagent, or independent reviewer is started by
  the producer. Deterministic local tools are allowed.
- This is calibration. It does not authorize FREEZE, blind reproduction, or
  formal batch production.

## 1. Pre-flight — freeze the snapshot

Record, before discovery:

| item | value |
| --- | --- |
| mode | `CALIBRATION` |
| shard / batch | `013` / `01` |
| records / senses | 500 / 560 |
| model | exact model name and provider used for this run |
| run ID | stable ID containing version, shard, batch, model, date |
| Canonical SHA-256 | hash of the exact Canonical shard file |
| literature index SHA-256 | hash of the exact read-only index snapshot |
| procedure digest | SHA-256 of this file at run time |
| Git HEAD | commit the run starts from |
| output | `013_01_c_<model>.jsonl` |

Freeze the 500 record IDs, 560 sense IDs, order, lemma, part of speech, gloss,
and search forms. Do not reorder, add, or drop a sense inside the batch. A batch
with a different record/sense shape is not this batch.

Use a small deterministic pilot to fix search/parsing/tool errors only. Do not
change the discovery prompt word by word during the run. Checkpoint local state
every 25–35 records so an interrupted run can resume. Never fill an unperformed
sense with `[]` to mark it complete.

Local per-sense state machine:

```text
PENDING → SEARCHED → INSPECTED → DISCOVERED → RECOVERED → OUTPUT
```

Technical states are separate: `ZERO_HITS`, `UNSEARCHABLE`, `SEARCH_FAILED`,
`NO_VERIFIED`, `INCOMPLETE`. A tool failure is not a completed empty sense.

## 2. PASS A — source-sense search and strict VERIFIED gate

For every sense, search the read-only literary index using the Canonical
`search_forms` and productive inflections. Use trigram/FTS where available for
three or more characters, substring search for two characters, and explicit word
boundary checks. Report one-character, archaic, and homonym limitations instead
of hiding them.

Prefer diversity: different works, authors, genres, speakers, and scenes. Prefer
at most two contexts from one work. Do not reuse the first hit of one record as
evidence for several senses.

Read 1–4 contexts per sense. If distinct contexts remain, extend to 5–8; if
useful or potentially useful relations still appear, extend to 9–12 and then
13–16. Sixteen is a cap, not a target. Count a context as `inspected` only when
it was actually read.

Classify each inspected context against the **exact Canonical sense**:

- `VERIFIED`: the target sense is actually used in the text. The lemma string
  alone is not enough; a different homonym, a different sense, a partial
  substring, or a related word is not `VERIFIED` for this sense.
- `AMBIGUOUS`: the text is compatible with the target sense but does not settle
  it. Re-search and re-read other works/contexts. An `AMBIGUOUS`-only sense may
  not output candidates.
- `REJECTED`: another sense, another word, a substring false positive, or an
  unrelated usage. It cannot support this sense's candidates.

Strictness applies to the **starting sense**, not to the strength of the relation
discovered from it. Once a context is `VERIFIED`, weak, indirect, contrastive,
or unexpected associations may still be retained.

If a sense has candidates but no direct `VERIFIED` context after re-search, mark
it `NO_VERIFIED` locally and output an empty array with the reason recorded. Do
not silently convert a failed search into a normal empty sense, and do not borrow
another sense's verified context because it looks relevant.

Record per sense: search hits, contexts provided, contexts actually read,
`VERIFIED`/`AMBIGUOUS`/`REJECTED` counts, works/genres, and the final status.

## 3. PASS B — open discovery with seven lenses, two independent sweeps

This is the recall stage. Do not perform Stage 2 value judgments here.

For **every `VERIFIED` context**, apply all seven lenses:

1. **Image** — color, shape, light, object, visual change.
2. **Action** — movement, gesture, behavior, reaction.
3. **Emotion** — feeling, attitude, psychological change.
4. **Sensation** — sound, touch, smell, taste, temperature, bodily sense.
5. **Scene/Situation** — scene, narrative, time/space, event.
6. **Causality** — cause, result, propagation of change.
7. **Metaphor/Contrast** — metaphor, symbol, contrast, loose or unexpected link.

For each lens:

1. read the context;
2. enumerate explicit relations, indirect relations, loose images, and contrasts;
3. store candidates in the local pool;
4. make one more pass for missed possibilities;
5. record zero if nothing is found.

Do not stop after the first two candidates. Do not impose a per-sense quota. Do
not turn the scene into a sentence: the scene is evidence for finding words, not
a candidate string. First enumerate words; only then consider a short phrase that
has independent image or expressive value.

Run **two independent sweeps of the whole verified context set**:

- Sweep 1 re-reads every verified context and records the candidate pool with a
  primary lens attribution.
- Sweep 2 re-reads every verified context again, independently, and records new
  discoveries. It is not a duplicate check, not a sentence-to-word cleanup, and
  not a review of sweep 1's string list.
- A context/lens with no discovery is recorded as zero. Do not invent candidates
  to fill a lens or a count.
- Preserve duplicate lineage when the same candidate appears under several lenses;
  the final Candidate file contains exact duplicates only once.

Local record per discovery: `sense_id`, context locator, textual anchor if any,
lens, candidate, derivation, connection hint, and sweep number. The connection
hint is an explanation aid, not a proof obligation. Do not discard a candidate
merely because a strong causal explanation is hard to write.

Aggregate per sweep × lens: inspected contexts, raw discoveries, unique
discoveries, exact duplicates against the other sweep, newly active senses, and
zero-result cells. The RUN must reproduce these totals from the final file and
the local ledger.

## 4. PASS C — recovery from the producer's own V5–V9 candidates

Combine the producer's own V5, V6, V7, V8, and V9 candidate strings by
`sense_id + candidate`. Treat them as recovery assets, not as automatic output.
A candidate removed in a later version is still eligible for recovery.

Remove only:

- **hard technical errors**: wrong source sense, a different word/sense, a
  substring false positive, a fabricated source/log/locator, a broken fragment,
  a Candidate v1 violation;
- **source failures**: the sense has no direct `VERIFIED` context;
- **output-form failures**: a sentence, predicative clause, narrated
  action/event/procedure, or a disguised nominalization of one.

For a sense with a `VERIFIED` context, a form-eligible word or genuinely
condensed expression is **retained** even if the association is weak, narrow, or
likely to be dropped by Stage 2. Do not perform a semantic-quality Drop here.

Record exactly one attribution per prior unique pair:

- `RETAINED` — already in the current candidate pool and still in the output;
- `RECOVERED` — not in the current pool, but re-admitted from a prior version;
- `EXACT_DUPLICATE` — the same normalized string for the same sense;
- `FORM_EXCLUDED` — sentence/event/routine/mechanical form;
- `FORM_EXTRACTED` — an old ineligible expression was legitimately reduced to a
  different word or condensed expression (record `old → new` locally);
- `TECHNICAL_EXCLUDED` — a hard technical error;
- `STILL_UNVERIFIED_SOURCE` — the sense has no direct verified usage.

The attribution counts must sum to the prior unique-pair total. Do not silently
lose a prior pair.

## 5. PASS D — minimal Stage 1 hygiene and the output-form gate

Separate three things:

1. **Hard technical checks** — exact `record_id`/`sense_id`, actual source-sense
   use, different word/sense, substring false positive, fabricated evidence,
   exact source lemma, normalized exact duplicate in the same sense, empty or
   broken strings, Candidate v1 shape.
2. **Output-form gate** — sentence/clause/event/process descriptions, routine
   `lemma + modifier` phrases, plain collocations, and mechanical compounds with
   no independent lexical contribution are excluded. If a word or condensed
   expression can be extracted from the same evidence, record
   `FORM_EXTRACTED(old → new)`.
3. **Soft editorial judgment** — loose image, narrow context, personal reference,
   near-duplicate nuance, likely low Tier. These are **not** grounds for a Stage 1
   Drop. Keep the candidate and let Stage 2 decide.

Mandatory form gate:

- Independent words and lexical items come first and are allowed broadly. A word
  may be ordinary, indirect, or unexpected; that is not a reason to remove it.
- Do not blanket-reject a compound merely because it contains the source lemma.
  Judge it by the actual source sense and its independent lexical contribution:
  `건축 → 건축가` can be a distinct candidate; `걸음걸이 → 느린 걸음걸이` is a
  routine modifier phrase and is not.
- Never output a complete sentence, a predicative clause, a narrated
  action/event/procedure, or a nominalized version of one. Removing the final
  period, changing the ending to an adnominal form, or appending
  `일/장면/상황/기술` does not make it eligible.
- A short, self-contained non-narrative phrase is allowed only when it has
  independent image or expressive value. A paraphrased gloss, routine
  collocation, arbitrary `lemma + modifier`, or a specific scene description is
  not.
- The exact source lemma and a lemma followed only by a parenthetical gloss are
  excluded. Compounds, derivations, and inflected forms are judged individually.
- Exact normalized duplicates in one sense are removed. Near-duplicates with a
  different nuance may remain.
- No per-sense candidate target, no fixed phrase-length cutoff, no substring
  blacklist, and no Stage 2 Tier/Drop decision.

## 6. PASS E — final completeness and reproducibility checks

Read the final JSONL mechanically, not from memory.

1. **Structure**: exactly 500 records and 560 senses, Canonical order and IDs;
   every sense array present; Candidate v1 keys only.
2. **Source binding**: every non-empty sense has at least one direct `VERIFIED`
   context; zero `AMBIGUOUS`-only or `NO_VERIFIED` senses with candidates.
3. **Search completeness**: `ZERO_HITS`, `UNSEARCHABLE`, `SEARCH_FAILED`,
   `NO_VERIFIED`, and `INCOMPLETE` are distinguished; no failed search was
   reported as a completed empty sense.
4. **Two sweeps**: every verified context was read under all seven lenses in
   sweep 1 and again in sweep 2; per-lens inspected/raw/unique/duplicate/
   newly-active/zero counts are in the local ledger and match the RUN.
5. **Form**: every final string is scanned individually. Complete sentences,
   predicative clauses, narrated actions/events/procedures, and disguised
   nominalizations must be **0**. Record `FORM_EXCLUDED` and
   `FORM_EXTRACTED(old → new)` counts.
6. **Lineage**: every prior V5–V9 unique pair has exactly one attribution;
   counts reconcile.
7. **Mechanical counts**: compute no-space and space-containing candidates
   directly from the final file; `no-space + space = total`. Separately compute
   the semantic classification (word / condensed phrase / idiom or fixed
   expression); that sum must also equal the total.
8. **No Stage 2 data**: no `type`, `relevance`, Tier, `target_id`, admission, or
   Drop field. The existing Candidate validator must pass.
9. **Evidence boundary**: raw text, DBs, locators, and detailed logs remain local.

## 7. Output contract

Each line:

```json
{"record_id": "w00000", "senses": [{"sense_id": "w00000-s1", "candidates": []}]}
```

Only `record_id`, `senses`, `sense_id`, and `candidates` are allowed. The output
contains the whole batch, including empty senses. Do not add confidence, quality,
state, lens, Tier, type, or target fields to the JSONL; those belong only in the
local ledger.

## 8. Reproducibility checklist

- [ ] Canonical shard SHA, literature index SHA, model, run ID, procedure digest,
      and Git HEAD recorded before discovery.
- [ ] 500 records / 560 senses frozen in Canonical order.
- [ ] Every non-empty sense has direct `VERIFIED` usage.
- [ ] All `AMBIGUOUS`-only senses resolved to `VERIFIED` or `NO_VERIFIED`; none
      output candidates.
- [ ] Every verified context read under 7 lenses in two independent sweeps.
- [ ] Per-sweep/per-lens ledger and RUN totals match.
- [ ] V5–V9 lineage has one attribution per prior pair and reconciles.
- [ ] Final sentence/event/process-description count is 0.
- [ ] Mechanical no-space + space count equals the total.
- [ ] Semantic word + condensed phrase + idiom count equals the total.
- [ ] Candidate v1 validator passes for 500 records / 560 senses.
- [ ] No raw corpus text, DB, locator, or search log in Git/PR.
- [ ] No Stage 2 output and no FREEZE/blind/formal-production claim.
