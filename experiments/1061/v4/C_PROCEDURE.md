# C Procedure (V4) — Sense-bound literary relation generation

Issue #1061, method C (literature context). Cohort: shard 013 / batch 02
(Canonical `stdict-0013.jsonl` rows 501–1000, 500 records / 571 senses).
This file documents the generalized procedure used to produce
`013_02_c_deepseek.jsonl` (V4). It contains no source text, excerpts, SQLite
files, or search logs.

## 0. What changed from V3, and why

V3 produced 145 candidates over 70 senses, but a manual audit found candidates
whose relation to the exact source sense could not be explained. Six cases were
re-investigated against Canonical and the local literature index:

| Source sense | V3 candidate | Finding | Action |
| --- | --- | --- | --- |
| `건절` (관찰사로 등용됨) | 큰 바람이 일다 | The only attestation is a poem couplet (`建節高臺起大風`). The wind is a line-level image; the appointment sense is not enacted in the scene. | DROP (sense not established in context) |
| `겉날리다` (일을 대충 처리함) | 열여섯에 집을 나서다 | The context shows the boy leaving home; the careless handling is the *manner*, not the departure. The candidate describes the circumstance, not the relation. | DROP |
| `건춘문` (경복궁 동쪽 문) | 봄치장 | The woman's spring dress is co-present. The association is carried by the `春` of the gate name, not by the gate's meaning. | DROP (character-level false association) |
| `검출하다` (화학 분석에서 성분·미생물 확인) | 지문, 분곽 | The novel uses forensic fingerprint detection; the essay uses literary "element" detection. Neither is the chemical-analysis sense. | DROP both (sense mismatch) |
| `거저리` (곡물을 해치는 곤충) | 진짜 알맹이 | The candidate is the rhetorical opposite in the same speech, not a relation to the insect. | DROP (co-occurrence) |
| `건네주다` (건너게 하여 주다) | 호랑이 등에 올라타다 | The tiger is the agent that carries the man across ("대호가 또한 건네주었다"). The mounting is the scene of that crossing. | KEEP (causal path holds) |

The general lesson: V3 verified **string matches**, then decomposed scenes.
V4 verifies **sense-in-context** first, and requires an explicit connection
path for every candidate.

## 1. Phase A — Source sense binding

For each candidate context, decide one of three states **before any candidate
work**:

- **VERIFIED** — the context enacts the bound sense.
- **AMBIGUOUS** — the sense cannot be established; look for more contexts, and
  if still unresolved, do not use it as evidence.
- **REJECTED** — a different word, a different sense, a hanja reading, or a
  substring match.

Checks applied, in order:

1. **Surface/lemma identity** — does the matched string correspond to the target
   lemma or a listed search form, rather than a substring of another word?
2. **Inflection plausibility** — can the matched surface form actually derive
   from this lexeme (stem, ending, irregular conjugation)?
3. **Homograph / polysemy** — does the surrounding text select this sense and
   not another sense of the same headword? Hanja glosses in the text are used as
   evidence when present.
4. **Semantic role** — what does the source word *do* in this sentence (agent,
   object, result, state, metaphor)? If the role cannot be stated, the context
   is AMBIGUOUS.
5. **Register/period** — archaic or dialect uses are acceptable only if the
   sense still holds.

A successful search is **not** evidence of binding. A record may have many
word-initial matches and zero VERIFIED contexts.

## 2. Phase B — Scene decomposition with a required path

Only VERIFIED contexts are decomposed. For each context, list the elements that
the text actually supports:

object/image · action/event · emotion/psychology · sensation · cause/result ·
metaphor/symbol · contrast

For every element, write the connection path:

```
source sense → the word's role in this scene → the element (action/emotion/image)
→ candidate
```

If the path cannot be written in one sentence, the element is not used. A rare
or single-work metaphor is allowed when the path is explicit.

## 3. Phase C — Independent candidate generation

A candidate is kept only if all five hold:

1. bound to the exact source sense;
2. its path is explainable from the actual context;
3. it does not merely re-use the source word;
4. it gives a writer a usable choice (expression, image, mood, action);
5. it adds something not already covered by another candidate of the same sense.

Excluded by rule:

- surrounding nouns and people that merely share the scene;
- associations built on a character of the headword (e.g. `春` in `건춘문`);
- near-duplicate candidates;
- expressions whose only merit is literal presence in the corpus;
- paraphrases of the dictionary gloss;
- ordinary phrases containing the source word.

Exception: a lexicalized idiom or a fixed figurative phrase may contain the
source word when the whole phrase carries an independent meaning.

Exploration does not stop at the first valid candidate: the same context is
re-read for other elements, and, when the record's VERIFIED set is thin,
different works are checked.

## 4. Phase D — Independent verification

Each candidate is judged separately on four axes:

- **A. Sense accuracy** — exact source sense, no homograph/polysemy leakage.
- **B. Context grounding** — the path is explainable from a real work.
- **C. Editorial value** — a writer gains a usable option.
- **D. Independent contribution** — distinct from the other candidates.

All four are required. As a secondary check, a **counterfactual test**: replace
the source word in the sentence with an unrelated word. If the candidate stands
unchanged, it is probably co-occurrence and is re-examined. The test is not an
automatic rejection rule; metaphors and moods are judged semantically.

## 5. Audit of the previous version

Every candidate from the previous run is re-judged as KEEP / REWORK / DROP:

- **KEEP** — sufficient grounding and independent value.
- **REWORK** — the context is valid but the extraction was wrong; re-analyse
  the same context and produce a better candidate.
- **DROP** — wrong sense, ungrounded, co-occurrence, or no editorial value.

REWORK is mandatory where the context still supports a relation: removing a
candidate is not sufficient if a better one can be found in the same scene.

## 6. Controls

- Same cohort and same Candidate JSONL v1 contract as V1–V3.
- Search scope frozen to the V3 context set; no new retrieval beyond the six
  case verifications. Additions come from re-analysing existing contexts.
- No per-word exception lists or hard-coded rules.
- Only `record_id`, `senses[].sense_id`, and `senses[].candidates` are written.
  Sense state, connection path, attested/derived class, and keep/drop reason are
  kept locally and are not part of the artifact.
- Source text, excerpts, SQLite, and search logs are never committed.

## 7. Result of applying this procedure (V4)

- 64 active senses / 135 candidates (2.11 per active sense).
- Previous run: 121 KEEP, 1 REWORK, 23 DROP (24 strings removed, 14 added).
- Attested strings 68 / inflected forms 26 / context-derived 38 (132 unique).
- Category spread: image 42, action 26, sensory 24, mood 18, scene 14,
  association 11.
- Source-word-containing candidates: 7, all lexicalized idioms or fixed
  figurative phrases.

Quality, not candidate count, is the target. Independent comparison with other
producers is out of scope for this procedure document.
