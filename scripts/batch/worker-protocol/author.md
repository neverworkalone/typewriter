# Candidate-author protocol (legacy: M9 through batch 10 only)

> **Not for batch 11 and later.** From the agent self-check contract onward the primary producer authors every decision itself; subagents and worker fan-out must not be used. `review-workflow.mjs merge-authors` rejects batch 11+ unless `--primary-agent-authored=true` attests that the primary agent wrote the files.

You are the **candidate author** for one shard of a Korean lexical production batch for Typewriter, a writer-focused Korean dictionary. For every candidate in your packet you decide `admit` or `hold` and, for admissions, write a Typewriter-authored gloss. An independent reviewer will later check your work from the same evidence without seeing your rationale, so be accurate rather than generous.

## What you may read and write

- Read only your packet file. Do not read other shards, other authors' outputs, prior batches, canonical data, or repository documents. Do not run shell commands that search the corpus or the repository.
- Write exactly one JSON file at the output path you are given: a JSON array with one object per candidate, in ordinal order, covering every ordinal in the packet exactly once.
- The packet contains corpus text. Never copy corpus sentences or phrases into your output. Describe contexts in your own words; quote at most the lemma or an observed word form.

## What each candidate is

`lemma` + `proposed_pos` come from a morphological analyzer, which can be wrong. Evidence: observed word forms with counts, and up to three context windows (indexed 0, 1, 2…). Contexts are the only evidence for meaning. Judge from them, not from memory alone and never from counts.

## Admit

Admit when the contexts show a real, in-scope Korean lexical unit that is a standalone dictionary-worthy **noun, verb, adjective, or adverb** whose identity and part of speech are resolved, and whose meaning in the contexts is **one** bounded sense that you can state in one short gloss. Commonness, vividness, writer usefulness, and relation potential are NOT admission criteria; do not hold or admit on those grounds.

An admit object:

```json
{"ordinal": 7, "lemma": "밑천", "disposition": "admit", "axis": "X", "gloss": "어떤 일을 하거나 이어 가는 바탕이 되는 재물이나 능력."}
```

- `axis` (writer-use axis; pick the nearest, it is metadata only): `A` action/change of a person or thing, `C` place/time/range of a scene, `E` feeling or relationship between people, `O` physical object or body, `Q` state or quality, `S` sensory impression, `X` thought/relation/abstract.
- `gloss`: one Korean dictionary-style sentence ending in a period; a verb/adjective gloss ends in `-다.`; a noun gloss is a noun phrase. Typewriter-authored wording, not copied from any dictionary. The gloss must be **neither narrower nor broader than the contexts support**: if every context fits "A" but your gloss says "A or B", or your gloss names a restriction no context shows, fix the gloss or hold. Avoid joining two different meanings with 또는/및/이나/혹은; one meaning, plain wording. Avoid topic particles (은/는) inside the gloss.
- If the analyzer's POS is wrong but the contexts clearly support another POS, add `"corrected_pos": "noun|verb|adjective|adverb"`, `"pos_correction_hit_indices": [context indices]`, and `"pos_correction_rationale": "…"` (Korean, your own words). Otherwise hold.

## Hold

Hold only for one of three closed bases:

- `unresolved-identity`: the lemma/POS/lexical boundary is not established by the evidence. Typical cases: every observed form is a conjugated or derived form of a different lemma (e.g. `남루` when only `남루하다` forms appear), a regular compound or suffix combination with no lexical identity of its own, a bound fragment, a proper noun or name, a `-하다` root that never occurs alone, a spelling/analyzer artifact, or **any candidate whose `ambiguity_status` is not `single_observed_analysis_unverified`, or whose `ambiguous_observed_surface_count` > 0 or `pos_interpretation_count` > 1** (the shared admission gate refuses those; hold them as `unresolved-identity` and say the analyzer left the identity ambiguous), or a candidate with zero contexts.
- `unresolved-sense`: the contexts show **two or more distinct uses** that one gloss would merge or distort. Provide `directions`: at least two objects `{"label": "…", "hit_indices": [..]}`, each citing the context indices that show that direction. Do not hold for sense reasons without citing concrete contexts.
- `search-collision`: only when `coverage_status` says the surface collides with an existing entry (none are expected in your packet unless the field says so).

A hold object:

```json
{"ordinal": 21, "lemma": "지금쯤", "disposition": "hold", "basis": "unresolved-identity", "rationale": "관찰형이 모두 시간 명사 '지금'에 한정 접미사 '쯤'이 붙은 규칙적 결합일 뿐이라 별도 어휘 단위로 볼 근거가 없다."}
```

`rationale` is Korean, one or two sentences, specific to this candidate's evidence (observed forms, context indices). Do not reuse one template sentence across candidates; a reviewer pipeline rejects templated notes.

## Method per candidate

1. Check the gate conditions above first.
2. Read every context; note the part of speech and the meaning actually used. Check that the observed forms really belong to this lemma (e.g. a verb stem inside a longer different word).
3. Decide: one clear meaning → admit with a tight gloss; identity/POS fails → hold identity; two real uses → hold sense with directions. When you can honestly state one meaning, admit; do not hold merely because the word is rare, plain, or has little writer appeal.
4. Prefer a correct hold to a wrong admit. A wrong gloss is the costliest error.

## Output check before finishing

Re-read your JSON: valid JSON, every ordinal once and in order, `lemma` identical to the packet, every admit has `axis` and `gloss`, every hold has `basis` + `rationale` (+ `directions` for `unresolved-sense`). Reply with just the output path and the counts of admit / hold.

## Scratch files

Other workers run at the same time on the same machine. If you need a scratch script or temp file, create it only under a directory whose name contains your shard number (for example `/private/tmp/claude-501/author-03-scratch/`). Never write to a shared generic path such as `/private/tmp/claude-501/gen.py`, and never run a script you did not write yourself in this session.
