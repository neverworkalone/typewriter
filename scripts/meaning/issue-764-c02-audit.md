# Issue #764 C02 meaning boundary audit

## Scope and evidence

This is the C02 (ㄲ) source-bound self-check for Issue #764, based on `origin/master` at `80632ae9`. It re-judged every C02 lemma that had more than one #716 Meaning row (770 lemmas, 1,928 rows) against the lemma's full set of canonical records and senses. The executable decision record is [`issue-764-c02.json`](issue-764-c02.json): each of the 649 lemmas whose grouping changed carries an exact `before` snapshot and a complete `groups` partition. The other 121 multi-Meaning lemmas were re-read and deliberately retained (see below); single-Meaning lemmas cannot be split or merged and are untouched.

| Measure | Before | After |
| --- | ---: | ---: |
| C02 lemmas | 3,578 | 3,578 |
| C02 canonical senses in Meaning rows | 5,096 | 5,096 |
| C02 Meaning rows | 4,736 | 3,796 |
| Multi-Meaning lemmas re-judged | 770 | — |
| Lemmas whose Meaning count changed | — | 649 |
| Multi-Meaning lemmas retained as is | — | 121 |
| Repository adjudications | 117 | 117 |

Every canonical C02 sense stays in exactly one final group; no sense is dropped and no adjudication is added. Canonical JSONL is unchanged. `apply-edits` checks the exact current snapshot of each lemma and rejects missing, duplicated or foreign senses before writing.

## Boundary decisions

- Senses of one lexical item that extend by literal ↔ figurative use, concrete ↔ abstract use, object/argument, grammatical voice (사동·피동·준말·센말 families) or per-usage synonym lists are merged. Examples: `까다롭다` (conditions / temperament), `깎다` (peeling → lowering price, honor, rank), `꺾다`/`꺾이다`, `깔다`/`깔리다`, `끌다`, `끊다`/`끊기다`/`끊어지다`, `꿰다`, `꾸미다`, `꼬리`, `꼭지`, `꽃`, `꽃밭`, `꿈`, `끈`, `끓다`, `깨끗하다`.
- Mimetic and onomatopoeic words whose senses share one sound/movement image (`까르르`, `깜박`, `껌벅`, `꼬르륵`, `꿀꺽`, `꼴깍`, `꿈틀`, `꾸역꾸역`, `끅끅`) are merged across the whole derivative family (-거리다, -대다, -하다, -이다) so that the Meaning units stay parallel.
- Independent homonyms stay separate. Examples: `까치발` (heel-raised foot / bracket / plant), `까치놀`, `깍정이`, `꼬치꼬치`, `꽃술`, `꽃자리`, `꽃다지`, `꽃대`, `껍질샘` (excretory organ vs shell-secreting tissue), `꺾기` (loan deposit vs judo), `끼적거리다` (writing vs eating), `깨작거리다`, `꾸다` (borrow / dream), `끌` (chisel vs abbreviation), `낌새`.
- `까닥거리다`/`까딱거리다` families keep the 'show-off' homonym apart from the head-nodding/shaking sense; within the 까딱 family only same-record head-nod and small-object senses are merged. Likewise `까부라지다` keeps the 'bent' and 'shrunken/limp' records apart, and `꼬이다`/`꾀다` keep 'twisted' separate from 'lure / gather'.
- `끼다` was re-judged from all its records: insertion, being held between, linking arms, keeping close, adding, mixing in and borrowing power form one Meaning; fog, smoke, dirt, moss, rust and a hint of expression settling on a surface (`w404652`) form a second Meaning. `끼치다` keeps 'bring about an influence' apart from 'goosebumps / being overwhelmed'.
- Form identity or a shared mimetic base alone did not justify a merge (`꼴꼴`, `꿀꿀`, `꽁꽁거리다`, `끔쩍`/`깜짝` eye vs startled, `꼭`/`꼭꼭`, `꼬질꼬질`), and a plain list of unrelated senses was not accepted as a merged gloss.

- Stage 2 feedback on PR #767 identified `까먹다`, `깜둥이` and `깜찍이` as under-merged. All three were re-grouped as one lexical item each (사람/개, 명사/부사, 돈/기억 are usage differences, not independent homonyms). The same cause was then checked across every C02 lemma whose senses of one record or of near-identical records sit in different groups; `깜부기`, `꽁꽁`, `꽃시계`, `꼬질꼬질(하다)`, `꼴리다`, `꿇다` and `껍질샘` were merged on the same ground. A follow-up Stage 1 review showed that listing two distinct referents is not a shared core, so `꽁이`(수갑/열쇠), `까바리`, `깔깔이`, `꼬꼬마`, `꽃씨`, `끗`(피륙/노름 단위), `꽃내미장단` and `꽃노래` were returned to separate Meanings. Cross-reference records that point to different words, and independent homonyms (`꾐`, `꾸정꾸정` s4, `꺾기`, `끗` 종지사) stay separate.

## Gloss checks

Merged glosses lead with the shared core (the physical act, sound, or image) and then state the extended uses in the same sentence; senses unrelated to the core were not merged just to shorten a list. Cross-reference records (`→ …`, 본말/준말/센말 pointers) remain bound to their own source senses and were not rewritten.

## Provenance and review status

Semantic decisions and this audit were prepared and checked in the primary agent context against the canonical source glosses and current Meaning bindings. This provenance is **agent self-check**. It is not an independent first or second review and does not claim human editorial approval. The independent reviews listed in Issue #764 remain pending; this audit supports a reviewable C02 PR and does not close the overall issue.
