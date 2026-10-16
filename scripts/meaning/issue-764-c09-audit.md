# Issue #764 C09 meaning boundary audit

## Scope and evidence

This is the C09 (ㅃ) source-bound self-check for Issue #764, based on `origin/master` at `417aaf0fd718c6b1695b177b685348cdd6205729`. The complete decision record is [`issue-764-c09.json`](issue-764-c09.json). It records the exact current Meaning rows and a complete final group assignment for every C09 lemma, including lemmas whose grouping is retained.

| Measure | Before | After |
| --- | ---: | ---: |
| C09 canonical records | 2,005 | 2,005 |
| C09 lemmas | 1,848 | 1,848 |
| C09 canonical senses | 3,081 | 3,081 |
| C09 Meaning rows | 2,980 | 2,101 |
| Multi-sense lemmas re-judged | 617 | — |
| Lemmas whose grouping changed | — | 497 |
| Lemmas with multiple final Meanings | — | 196 |
| Final same-record splits | — | 146 |
| Repository adjudications | 117 | 117 |

Every canonical C09 sense occurs in exactly one final group. The mapping covers all 1,848 lemmas; the 1,231 lemmas with one canonical sense remain one Meaning each. No sense was dropped and no adjudication was added. Canonical JSONL is unchanged. The edit tool checks each exact `before` snapshot and complete, non-overlapping sense coverage before writing.

## Boundary decisions

- A single lexical identity may cover its connected literal, figurative, grammatical, and usage extensions. `뿌리다` (`w438307-s1..s7`) groups weather, scattering, spending, dissemination, waving, tears, and rumor uses around letting something fall or spread. `뼈` (`w438052-s1..s5`) groups the bodily support, structural/story core, backbone, and underlying intention senses. `뽑다` (`w440358-s1..s11`) remains one verb across extraction, selection, recovery of invested money, production, exertion, scoring, and removal. A source-bound follow-up prompted by PR feedback retained this grouping because the senses remain connected verb uses rather than an independent homonym; it also expanded the gloss to make the lengthening/rising use (`s7`), recovery of invested money (`s3`), exertion (`s8`), and long sound (`s9`) explicit.
- `빠지다` is organized around three source-supported families: absence, loss, and departure (`w438190-s1`, `s3..s13`); profit remaining (`w438190-s2`); and falling or becoming immersed in a state (`w438207-s1..s6`). The meanings retain their canonical senses; the family boundaries follow their distinct lexical axes rather than the record boundary alone.
- Bubbling water and foam share a sound and movement image, while a crowd is not treated as the same event. Accordingly, `빠글거리다`, `빠글대다`, `빠글빠글`, and `빠글빠글하다` group their liquid/foam senses with the boiling-over feeling sense, and keep the crowded-creature/person sense separate.
- `빨깍` and `뻘꺽` group sudden anger or commotion, while opening a closed object remains a separate action. For `뻘꺽거리다` and its derivatives, bubbling liquid and boiling laundry share a sound; kneading dough and gulping a drink remain separate source-bound actions/sounds.
- `뻘쭉` and its derivatives group a slight opening with the smile made by opening the mouth; a pointed end protruding remains separate. The same boundary is used for `빨쪽` (`w167131-s1..s3`).
- Related sound forms do not merge solely because they look alike. `뿌지직` and its derivatives group sizzling/crackling and splitting sounds, while the bowel sound and sweat seeping remain separate. `뿍` keeps the short fart sound separate from scraping/tearing; `삐다` keeps a sprain separate from a pooled-water level receding.
- Clear independent referents remain separate. `뽕` retains four families: slang for methamphetamine, mulberry leaf/tree, a hole/air-release sound, and a clothing insert. `뿔말` retains the antelope, plant, and plankton. `삐치다` retains sulking, becoming exhausted, and drawing a calligraphic stroke as separate identities.
- Redirects to different headwords remain bound to their source senses and are not rewritten or merged merely because they share a lemma. Examples include `뻐기다` (`w442065-s1`), `뿌시다` (`w163397-s1..s2`), and `삐까번쩍하다` (`w163119-s1`, `w533900-s1`).

## Provenance and review status

Semantic decisions and this audit were prepared and checked in the primary agent context against the canonical source glosses and current Meaning bindings. This provenance is **agent self-check**. It is not an independent first or second review and does not claim human editorial approval. Independent reviews listed in Issue #764 remain pending; this audit supports a reviewable C09 PR and does not close the overall issue.
