# Experiment C — Literature Context Generation

Issue #845 · 2026-10-18 (Asia/Seoul)

## Result

All eight meanings in the fixed #841 cohort were bound to their current
Canonical record and sense, searched in the existing local literature index,
and evaluated. The single C pass produced 19 provisional relation candidates:
18 `keep`, 1 `revise`, and 0 `reject`. Two candidates were judged to meet the
Association Tier 1 close-alternative standard. These are producer judgments,
not a blinded or independent quality review.

The report contains only candidate words, Canonical identifiers, non-quoted
editorial reasoning, aggregate search metadata, and text-free descriptions of
the selected contexts. No literature excerpt, source file, SQLite database,
canonical record, product artifact, or test fixture was added or changed.

## Input and generation protocol

The fixed cohort and shared protocol came from #841. The exact selected
Canonical senses were:

| Source | Record / sense | Bound meaning |
| --- | --- | --- |
| 나그네 | `w408179` / `w408179-s1` | A person who leaves their home area to stay briefly elsewhere or wander. |
| 그리움 | `w44055` / `w44055-s1` | An aching feeling of wanting to see someone or something again. |
| 문턱 | `w425010` / `w425010-s1` | The upper part of the sill touched by a door. |
| 쓸쓸하다 | `w213407` / `w213407-s1` | To feel lonely and desolate. |
| 흐르다 | `w508767` / `w508767-s12` | A liquid such as a stream or blood to pass through a place. |
| 기다리다 | `w405064` / `w405064-s1` | To hope that a person or time will come. |
| 번지다 | `w434809` / `w434809-s1` | Liquid to wet and spread gradually over a wider area. |
| 과거 (科擧) | `w398310` / `w398310-s1` | The historical examination used to select officials in Korea and China. |

One generation pass was made per source meaning, using only its bound
definition and one selected local context. The applied prompt instructions
were:

> For each fixed source meaning, use only the selected local literature context
> to produce up to eight plausible writer-facing candidates. Return zero when
> the context does not support a useful relation. Do not author `direct` or
> `antonym`. Use only `near`, `mood`, `scene`, `sensory`, `action`, or
> `association`; apply the #838 Tier 1 standard and relative 1–9 relevance.
> Link only an exact existing Canonical target sense; otherwise return plain
> text with no ID. Do not quote or reproduce distinctive source wording.

The model was the Codex GPT-6 assistant in this session. The deployment build,
temperature, exact tokenization, and token-usage telemetry were not exposed by
the interface. There was one attempt per meaning and no additional model or
API call. The full candidate list below was checked against current Canonical
targets and the selected source senses in the same producer pass.

## Literature index and permission basis

The index was discovered in the assigned directory and opened with SQLite's
read-only URI mode. It was not rebuilt, copied, or migrated.

| Item | Value |
| --- | --- |
| Database | `~/.cache/typewriter/reference/literature/indexes/public-domain-literature.sqlite` |
| Integrity | `PRAGMA integrity_check`: `ok` |
| Inventory / indexed works / excluded files | 12,352 / 10,470 / 1,882 |
| Text units | 864,774 |
| Input manifest SHA-256 | `b71366f2e48dea0cf05b03f6051b459b0d5cb71027dd116793d369ceff7d4097` |
| Logical rows SHA-256 | `bbb19a0b3535eca20f11431cf2c786bb399377356147b1224c3515b8bb9752fe` |

The existing external-material review identifies the collection as
공유마당 만료저작물 and records local storage, indexing, and lexical-reference
use as permitted. The official [expired works guidance](https://gongu.copyright.or.kr/gongu/main/contents.do?menuNo=200091)
was rechecked on 2026-10-18; it says expired works may be used without a
separate permission or approval. The page does not separately discuss model
prompts; treating this transient, non-published input as permitted follows
from that unrestricted-use statement. The current Codex session was the only
model recipient. The selected DB entries report `metadata_origin` as
`filename (unverified)`, so this report does not rely on their parsed title or
author fields as verified identity.

## Search and context selection

Search used the existing FTS5 trigram index with `instr()` verification for
strings of at least three characters. The two-character `과거` query used a
read-only `instr()` scan because it is shorter than a trigram. Candidate-row
counts below are lexical search results before
manual sense screening. They are not sense-certified occurrence counts or
word-frequency measurements. The `과거` search includes the homographic
過去 use; only the context matching the fixed 科擧 sense was selected. A broad
`번지` substring search also surfaced one title/name match, which was excluded;
the refined inflection list below was used for its reported count.

| Source | Search forms | Candidate text units | Distinct files | Essay / novel / poem rows |
| --- | --- | ---: | ---: | ---: |
| 나그네 | `나그네` | 241 | 145 | 55 / 115 / 71 |
| 그리움 | `그리움`, `그리워-`, `그리운` | 1,041 | 531 | 315 / 509 / 217 |
| 문턱 | `문턱` | 172 | 105 | 16 / 153 / 3 |
| 쓸쓸하다 | `쓸쓸하-` | 353 | 224 | 88 / 226 / 39 |
| 흐르다 | `흐르-`, `흘러-`, `흘렀-`, `흐른-` | 4,336 | 1,529 | 1,060 / 2,616 / 660 |
| 기다리다 | `기다리-`, `기다렸-`, `기다린-` | 3,546 | 1,064 | 575 / 2,690 / 281 |
| 번지다 | `번져-`, `번지는`, `번진`, `번지고`, `번지다`, `번지며`, `번졌다`, `번졌`, `번져서`, `번지듯`, `번지기`, `번지도록` | 68 | 54 | 23 / 39 / 6 |
| 과거 (科擧) | `과거` | 1,497 | 667 | 870 / 564 / 63 |

One context window per cohort item was retained for generation. They came from
eight distinct local work IDs: four novels, three essays, and one poem. Each
window used only the matched text unit, no adjacent rows or lines, and was
clipped to at most 150 characters around the match. The selected contexts
contained 607 Unicode characters in total. Thirteen short windows (833
characters total) were surfaced while selecting the final eight; five were
not used. No excerpts are reproduced here.

| Source | Selected local work ID / genre | Text-free context note |
| --- | --- | --- |
| 나그네 | `3082` / novel | A traveler on a little-used mountain route, with wind and falling leaves. |
| 그리움 | `6916` / poem | Longing presented through a moving-water image. |
| 문턱 | `3080` / novel | A car crosses the physical sill and enters a house. |
| 쓸쓸하다 | `5` / essay | Loneliness occurs among several mixed feelings. |
| 흐르다 | `570` / essay | A river's movement appears in a passage that also mentions flood danger. |
| 기다리다 | `2845` / novel | The narrator eagerly waits for morning. |
| 번지다 | `2747` / novel | Ink spreads into the iris of an eye. |
| 과거 (科擧) | `647` / essay | The context explicitly concerns sitting the historical examination and placing first. |

The eight search families took 1,792 ms in the measured SQLite search segment.
The selected-context token count is unavailable because the model tokenizer
and usage telemetry are not exposed; the measured character count is reported
instead. No token count is presented as zero or estimated as fact.

## Candidate output

`target_record_id / target_sense_id` is populated only where the exact
Canonical target sense was checked. `—` means no failure reason was recorded.
All decisions remain provisional producer assessments.

| source_lemma | source_record_id / source_sense | method | target_text | target_record_id_or_null / target_sense | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
| --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| 나그네 | `w408179` / `w408179-s1` | C | 길손 | `w408160` / `w408160-s1` | association | 1 | keep | Close traveler alternative; the selected meaning is exact and it is not one of the source sense's existing STDICT `direct` targets. | — |
| 나그네 | `w408179` / `w408179-s1` | C | 산길 | `w165674` / `w165674-s1` | scene | 3 | keep | A concrete route scene supported by the selected travel context. | — |
| 나그네 | `w408179` / `w408179-s1` | C | 바람 | `w426114` / `w426114-s1` | sensory | 5 | keep | A weather image in the exposed travel setting; broader than a lexical alternative. | — |
| 그리움 | `w44055` / `w44055-s1` | C | 물결 | `w424611` / `w424611-s2` | sensory | 2 | keep | A figurative moving-water image for longing, with the target's figurative sense selected. | — |
| 문턱 | `w425010` / `w425010-s1` | C | 문지방 | `w124390` / `w124390-s1` | association | 1 | keep | A close expression alternative for the physical sill; no new `direct` row is proposed. | — |
| 문턱 | `w425010` / `w425010-s1` | C | 대문 | `w411783` / `w411783-s1` | scene | 4 | keep | The entry point gives the threshold a concrete surrounding scene. | — |
| 쓸쓸하다 | `w213407` / `w213407-s1` | C | 적막하다 | `w279093` / `w279093-s1` | near | 2 | keep | Close emotional texture, distinct from a new dictionary-grade synonym claim. | — |
| 쓸쓸하다 | `w213407` / `w213407-s1` | C | 섭섭하다 | `w448155` / `w448155-s1` | mood | 4 | keep | A neighboring feeling in the mixed emotional state, not an interchangeable meaning. | — |
| 쓸쓸하다 | `w213407` / `w213407-s1` | C | 두려움 | `w416772` / `w416772-s1` | mood | 6 | keep | A weaker companion mood in the selected emotional mixture. | — |
| 흐르다 | `w508767` / `w508767-s12` | C | 물살 | `w424863` / `w424863-s1` | sensory | 3 | keep | Captures the force of moving water without restating the source verb. | — |
| 흐르다 | `w508767` / `w508767-s12` | C | 홍수 | `w377674` / `w377674-s1` | scene | 5 | keep | A plausible river situation; not a synonym for flowing. | — |
| 기다리다 | `w405064` / `w405064-s1` | C | 아침 | `w458645` / `w458645-s1` | scene | 3 | keep | The awaited time is concrete and directly supported by the selected context. | — |
| 기다리다 | `w405064` / `w405064-s1` | C | 기대 | `w406740` / `w406740-s1` | near | 2 | keep | The exact Canonical sense is hoping while waiting for something desired. | — |
| 번지다 | `w434809` / `w434809-s1` | C | 먹물 | `w421304` / `w421304-s1` | association | 3 | keep | A liquid material that can leave a spreading mark. | — |
| 번지다 | `w434809` / `w434809-s1` | C | 얼룩 | `w460510` / `w460510-s2` | sensory | 2 | keep | A visible mark caused by liquid, matching the selected sense. | — |
| 번지다 | `w434809` / `w434809-s1` | C | 홍채 | `w507700` / `w507700-s1` | sensory | 7 | revise | The image is intelligible and its exact eye-structure sense is linked, but its writing value may depend on this single context. | Single-context generality needs independent review. |
| 과거 | `w398310` / `w398310-s1` | C | 급제 | `w401322` / `w401322-s2` | association | 2 | keep | A relevant result of taking the historical exam, not the exam itself. | — |
| 과거 | `w398310` / `w398310-s1` | C | 문과 | `w424599` / `w424599-s1` | association | 3 | keep | A concrete examination category included in the bound historical system. | — |
| 과거 | `w398310` / `w398310-s1` | C | 장원급제 | `null` | association | 4 | keep | A specific examination outcome; no exact Canonical target was found, so it remains text-only. | — |

### Producer self-check

- Candidate counts by source in cohort order: `3, 1, 2, 3, 2, 2, 3, 3` (19 total; below the eight-candidate cap for every item).
- Provisional decisions: 18 keep, 1 revise, 0 reject. The `홍채` item is retained for review at lower priority rather than removed for being unusual.
- Association Tier 1: 2 candidates (`길손`, `문지방`); each is a close expression alternative, and neither is proposed as `direct`.
- Exact target IDs/senses: 18. Text-only targets: 1 (`장원급제`). No new IDs were invented.
- Duplicate candidates in this output: 0. Wrong source senses among the selected contexts: 0 in this producer check. A broad substring false positive in the `번지다` search was excluded before generation.
- Repetition of an existing official relation on the selected source sense: 0 of 19 after checking the source-sense relation lists. No `direct` or `antonym` was authored.
- Familiar imagery is present, including travel with a mountain route or wind, longing with a wave, and a river with flood risk. This is a qualitative producer note, not a measured cliché rate. Independent blinded review may change every provisional decision and Tier.

Candidate synthesis and Canonical target/sense verification took 2 minutes 6
seconds elapsed from selected contexts ready to the completed candidate set.
That combined segment includes local target lookup; editorial self-review time
was not separately instrumented. Candidate/output token usage and any model
service cost were not exposed, so no token or cost estimate is claimed.

## Scope and remaining review

This was only Experiment C. No other experiment output, prompt, or workstream
was inspected. No relation source, canonical data, headword-candidate file,
SQLite build, product code, or persistent search tool was created or changed.
The next quality judgment belongs to the common independent/blinded review
described in #841; this report does not claim a winning generation method.
