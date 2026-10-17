# Typewriter 0.3 relation experiment B — imagined scenes

## Scope and method

This is the B-only report for [Issue #844](https://github.com/neverworkalone/typewriter/issues/844), coordinated under [Issue #841](https://github.com/neverworkalone/typewriter/issues/841). It records one scene-first pass over the shared eight-item cohort. No literature or corpus database, external search, source examples, or other experiment report was used. No canonical data or product relation was changed.

**Normalized prompt record (not a verbatim transcript):** For each of the eight supplied Canonical records and bound senses, first imagine a distinct scene that preserves the specified sense, then derive at most eight Korean writer-facing candidates from that scene. Do not search for or supply real literary/corpus context. Do not author `direct` or `antonym`; use only `near`, `mood`, `scene`, `sensory`, `action`, or `association`. Link only an exact existing Canonical target sense; otherwise keep the expression text-only. Assign relative `relevance` and a producer-only `keep`, `revise`, or `reject` judgment, with a non-quoted reason. Do not replace a cohort item or fill a quota. One generation pass was used; no candidates were topped up. Inputs were the exact source rows/senses listed below, including their Canonical glosses; the gloss text is not reproduced in this report.

The scene notes below are AI-created summaries, not source text. They preserve the B-specific intermediate step without reproducing Canonical definitions or external material.

| Source sense | Imagined scene summary (AI-created) |
| --- | --- |
| 나그네 `w408179-s1` | A traveler pauses at a ferry landing, sets down a bundle at a roadside inn, then leaves fading steps on the road. |
| 그리움 `w44055-s1` | A place is kept for someone away; an old letter, a question about their well-being, and a return route bring them to mind. |
| 문턱 `w425010-s1` | Someone stops with a toe at a raised doorway sill, removes their shoes, and reaches for the door ring. |
| 쓸쓸하다 `w213407-s1` | An unlit room, an empty chair, a faint draft, and a voice with no addressee make the evening feel solitary. |
| 흐르다 `w508767-s3` | Water moves down a shallow channel, runs over a stone bed, and falls from an eave with a soft sound. |
| 기다리다 `w405064-s1` | Someone waits in a station hall, leaves a lamp on, and keeps looking toward the entrance for an expected arrival. |
| 번지다 `w434809-s1` | Ink and damp color spread across absorbent paper until their edges soften and leave a stain. |
| 과거 (科擧) `w398310-s1` | A candidate writes in an examination hall, then looks for a name on a result list. |

## Source binding

The exact cohort senses were checked in committed `data/canonical/` records. Sense cues below are paraphrases for identification, not reproduced definitions.

| Lemma | Canonical source | Bound sense and cue |
| --- | --- | --- |
| 나그네 | `data/canonical/stdict-0321.jsonl`, `w408179` | `w408179-s1`, person away from their home place or roaming |
| 그리움 | `data/canonical/stdict-0037.jsonl`, `w44055` | `w44055-s1`, longing for someone or something missed |
| 문턱 | `data/canonical/stdict-0333.jsonl`, `w425010` | `w425010-s1`, physical upper sill under a door |
| 쓸쓸하다 | `data/canonical/stdict-0162.jsonl`, `w213407` | `w213407-s1`, feeling lonely and desolate |
| 흐르다 | `data/canonical/stdict-0405.jsonl`, `w508767` | `w508767-s3`, liquid moving down or spilling over |
| 기다리다 | `data/canonical/stdict-0318.jsonl`, `w405064` | `w405064-s1`, hoping for a person or time to come |
| 번지다 | `data/canonical/stdict-0341.jsonl`, `w434809` | `w434809-s1`, liquid spreading wider as it wets a surface |
| 과거 (科擧) | `data/canonical/stdict-0313.jsonl`, `w398310` | `w398310-s1`, historical examination system for selecting officials; not 過去 |

## Candidate rows

`method` is `B / scene-first` for every row. `target_record_id_or_null` is populated only for an exact inspected Canonical sense; `null` means a plain-text draft with no invented ID. `keep` means provisionally retain for independent review, not product approval. Reasoning is non-quoted. Relevance is a producer's provisional ordering judgment.

### 나그네 — `w408179-s1`

| source_lemma | source_record_id | source_sense | method | target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning | failure_reason |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| 나그네 | w408179 | w408179-s1 | B / scene-first | 길손 | w408160-s1 | association | 1 | keep | Close informal expression for a person traveling away from home. | — |
| 나그네 | w408179 | w408179-s1 | B / scene-first | 주막 | w308349-s1 | scene | 3 | keep | A roadside place where a traveler may stop and stay. | — |
| 나그네 | w408179 | w408179-s1 | B / scene-first | 봇짐 | w150545-s1 | association | 3 | keep | A carried bundle makes the traveler image concrete. | — |
| 나그네 | w408179 | w408179-s1 | B / scene-first | 나루터 | w406967-s1 | scene | 4 | keep | A recognizable place along a journey. | — |
| 나그네 | w408179 | w408179-s1 | B / scene-first | 발자국 | w427735-s1 | sensory | 5 | keep | A trace of someone who has passed through. | — |

### 그리움 — `w44055-s1`

| source_lemma | source_record_id | source_sense | method | target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning | failure_reason |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| 그리움 | w44055 | w44055-s1 | B / scene-first | 사무치다 | w443502-s1 | near | 2 | keep | A verb for a feeling that reaches deeply; usable in a longing context. | — |
| 그리움 | w44055 | w44055-s1 | B / scene-first | 허전하다 | w503759-s2 | mood | 3 | keep | Conveys the emotional vacancy associated with someone's absence. | — |
| 그리움 | w44055 | w44055-s1 | B / scene-first | 빈자리 | w438222-s1 | scene | 3 | keep | An unoccupied place can make absence visible. | — |
| 그리움 | w44055 | w44055-s1 | B / scene-first | 안부 | w458625-s1 | association | 4 | keep | A natural subject of thought or inquiry about someone missed. | — |
| 그리움 | w44055 | w44055-s1 | B / scene-first | 편지 | w499292-s1 | association | 5 | keep | A possible object that carries a message across absence. | — |
| 그리움 | w44055 | w44055-s1 | B / scene-first | 돌아오지 않는 사람 | null | scene | 5 | keep | A plain-text scene target, not a fabricated headword. | — |

### 문턱 — `w425010-s1`

| source_lemma | source_record_id | source_sense | method | target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning | failure_reason |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| 문턱 | w425010 | w425010-s1 | B / scene-first | 문지방 | w124390-s1 | association | 1 | keep | A close informal alternative for the physical sill. | — |
| 문턱 | w425010 | w425010-s1 | B / scene-first | 발끝 | w137610-s1 | sensory | 4 | keep | Directs attention to bodily position at the sill. | — |
| 문턱 | w425010 | w425010-s1 | B / scene-first | 신발을 벗다 | null | action | 3 | keep | A plausible action at an entrance. | — |
| 문턱 | w425010 | w425010-s1 | B / scene-first | 현관 | w506672-s1 | scene | 4 | keep | A familiar setting containing a doorway threshold. | — |
| 문턱 | w425010 | w425010-s1 | B / scene-first | 문고리 | w125005-s1 | association | 5 | keep | A nearby object that completes the doorway image. | — |

### 쓸쓸하다 — `w213407-s1`

| source_lemma | source_record_id | source_sense | method | target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning | failure_reason |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| 쓸쓸하다 | w213407 | w213407-s1 | B / scene-first | 허전하다 | w503759-s2 | near | 2 | keep | Expresses an adjacent feeling of absence or loss. | — |
| 쓸쓸하다 | w213407 | w213407-s1 | B / scene-first | 적막 | w478072-s1 | mood | 2 | keep | Combines quiet and loneliness as an emotional atmosphere. | — |
| 쓸쓸하다 | w213407 | w213407-s1 | B / scene-first | 불 꺼진 방 | null | scene | 3 | keep | A simple setting that can carry solitary mood. | — |
| 쓸쓸하다 | w213407 | w213407-s1 | B / scene-first | 빈자리 | w438222-s1 | association | 3 | keep | A visible sign of someone absent. | — |
| 쓸쓸하다 | w213407 | w213407-s1 | B / scene-first | 혼잣말을 하다 | null | action | 5 | keep | A verbal expression for speaking without a conversational partner. | — |

### 흐르다 — `w508767-s3`

| source_lemma | source_record_id | source_sense | method | target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning | failure_reason |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| 흐르다 | w508767 | w508767-s3 | B / scene-first | 흘러내리다 | w385450-s1 | near | 2 | keep | A close expression for liquid moving from a higher place downward. | — |
| 흐르다 | w508767 | w508767-s3 | B / scene-first | 여울 | w234616-s1 | association | 3 | keep | A place made vivid by moving water. | — |
| 흐르다 | w508767 | w508767-s3 | B / scene-first | 낙숫물 | w406777-s1 | scene | 3 | keep | Evokes water falling from a roof edge. | — |
| 흐르다 | w508767 | w508767-s3 | B / scene-first | 졸졸 | w484429-s1 | sensory | 2 | keep | Captures the sound or manner of a narrow stream. | — |
| 흐르다 | w508767 | w508767-s3 | B / scene-first | 도랑 | w412466-s1 | association | 5 | keep | A narrow watercourse that can carry the movement. | — |
| 흐르다 | w508767 | w508767-s3 | B / scene-first | 물길 | w123269-s2 | association | 6 | keep | Names a channel through which water moves. | — |

### 기다리다 — `w405064-s1`

| source_lemma | source_record_id | source_sense | method | target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning | failure_reason |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| 기다리다 | w405064 | w405064-s1 | B / scene-first | 마중 | w110056-s1 | association | 4 | keep | Closely connected to an expected person's arrival. | — |
| 기다리다 | w405064 | w405064-s1 | B / scene-first | 초조하다 | w329138-s1 | mood | 2 | keep | A possible emotional color of waiting for an uncertain arrival. | — |
| 기다리다 | w405064 | w405064-s1 | B / scene-first | 대합실 | w81787-s1 | scene | 3 | keep | A place built around waiting for someone or something. | — |
| 기다리다 | w405064 | w405064-s1 | B / scene-first | 불을 켜 두다 | null | action | 3 | keep | An action that signals an expected return. | — |
| 기다리다 | w405064 | w405064-s1 | B / scene-first | 문 쪽을 바라보다 | null | action | 4 | keep | A visible act of anticipating someone at the entrance. | — |

### 번지다 — `w434809-s1`

| source_lemma | source_record_id | source_sense | method | target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning | failure_reason |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| 번지다 | w434809 | w434809-s1 | B / scene-first | 퍼지다 | w495642-s5 | association | 1 | keep | A close informal expression for extending over a wider area. | — |
| 번지다 | w434809 | w434809-s1 | B / scene-first | 먹물 | w421304-s1 | association | 4 | keep | A concrete liquid material in the imagined paper scene. | — |
| 번지다 | w434809 | w434809-s1 | B / scene-first | 화선지 | w373672-s1 | scene | 4 | keep | Absorbent paper makes spreading ink or color legible. | — |
| 번지다 | w434809 | w434809-s1 | B / scene-first | 번진 가장자리 | null | scene | 3 | keep | A plain-text image of the softened boundary. | — |
| 번지다 | w434809 | w434809-s1 | B / scene-first | 얼룩 | w460510-s2 | association | 5 | keep | A possible visible result of spreading liquid. | — |

### 과거 (科擧) — `w398310-s1`

| source_lemma | source_record_id | source_sense | method | target_text | target_record_id_or_null | relation_type | relevance | provisional_decision | reasoning | failure_reason |
| --- | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- |
| 과거 | w398310 | w398310-s1 | B / scene-first | 유생 | w466040-s1 | association | 4 | keep | A scholar preparing to enter the examination scene. | — |
| 과거 | w398310 | w398310-s1 | B / scene-first | 답안지 | w78919-s1 | scene | 3 | keep | A concrete object used during the examination. | — |
| 과거 | w398310 | w398310-s1 | B / scene-first | 문과 | w424599-s1 | association | 3 | keep | A specific examination track within the historical system. | — |
| 과거 | w398310 | w398310-s1 | B / scene-first | 급제 | w401322-s2 | association | 3 | keep | Passing the historical examination is a distinct outcome associated with the examination system. The source's official `direct` target `과제` (`w31981-s2`) is the examination system; `급제` (`w401322-s2`) means passing it. | — |
| 과거 | w398310 | w398310-s1 | B / scene-first | 시험장 | w447105-s1 | scene | 3 | keep | The examination setting is a direct scene path. | — |
| 과거 | w398310 | w398310-s1 | B / scene-first | 급제자 명단 | null | scene | 5 | keep | A plain-text scene target for the later result-search moment. | — |

## Provisional results and cost

| Source | Candidates | Keep | Revise | Reject | Exact target IDs | Text-only |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 나그네 | 5 | 5 | 0 | 0 | 5 | 0 |
| 그리움 | 6 | 6 | 0 | 0 | 5 | 1 |
| 문턱 | 5 | 5 | 0 | 0 | 4 | 1 |
| 쓸쓸하다 | 5 | 5 | 0 | 0 | 3 | 2 |
| 흐르다 | 6 | 6 | 0 | 0 | 6 | 0 |
| 기다리다 | 5 | 5 | 0 | 0 | 3 | 2 |
| 번지다 | 5 | 5 | 0 | 0 | 4 | 1 |
| 과거 (科擧) | 6 | 6 | 0 | 0 | 5 | 1 |
| **Total** | **43** | **43** | **0** | **0** | **35** | **8** |

These are producer-only provisional judgments, not an independent quality score or a claim that all 43 relations should enter the product. No generated row was found to repeat a source-sense `direct` relation. In particular, `급제` is associated with the examination-system sense but is not a duplicate of the source's `direct` target `과제` (`w31981-s2`); the `급제` target's own direct relation is to the distinct passing-the-examination sense `과제` (`w31981-s1`). The exact-meaning audit resolved all 35 ID targets; eight phrases remain text-only. The two `과거` senses were kept separate, and only the 科擧 sense was used.

Quality notes: no within-source duplicate candidate remained; no candidate used a wrong homograph after inspection; one close synonym-candidate expression was placed in association Tier 1 for each of `나그네`, `문턱`, and `번지다`; scene and sensory candidates were retained where the imagined situation gave a clear writer path. The `그리움` → `사무치다` and `그리움` → `허전하다` judgments are context-sensitive and especially suitable for independent review. No quota was applied; each source yielded five or six of the permitted maximum eight.

The run used the Codex agent runtime identified as GPT-6. The exact served model revision, temperature, seed, and maximum-output setting were not exposed. The runtime did not expose prompt/output token accounting or separable generation and editorial-review latency, so those values are **unavailable, not zero**, and are not estimated. A combined wall-clock interval of 2 minutes 59 seconds (14:59:17–15:02:16 UTC) covered the candidate pass, local sense/target inspection, and report drafting; it does not isolate model generation or editorial review. The source-sense scan and target lookup were read-only Canonical inspection. Editorial review was performed by the same worker as generation and is not independent reviewer evidence.

The results are limited to this eight-sense pilot, one worker, one model runtime, and one scene-first pass. Worker/model differences and small-sample effects prevent generalizing these counts to all 0.3 vocabulary. This file contains no source definitions, literary or corpus excerpts, DB payloads, or local evidence pack.
