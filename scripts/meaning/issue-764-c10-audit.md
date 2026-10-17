# Issue #764 C10 meaning boundary audit

## Scope and evidence

This is the C10 source-bound self-check for Issue #764, first performed against `417aaf0fd718c6b1695b177b685348cdd6205729`. The PR base is now `2579fbb268b8393b8fb6e2c949eb9ff014a048b6`; comparison confirmed that neither the C10 Meaning shards nor their canonical source records changed between those commits. I reviewed all canonical C10 records and senses together with the current #716 Meaning bindings. The executable edit record is [`issue-764-c10.json`](issue-764-c10.json); its `merges` apply only to untouched single-sense rows, and its `사전` repartition records the exact current rows and every final group for that already-edited lemma.

| Measure | Before | After |
| --- | ---: | ---: |
| C10 lemmas | 42,288 | 42,288 |
| C10 canonical senses in Meaning rows | 60,814 | 60,814 |
| C10 Meaning rows | 60,813 | 56,872 |
| C10 lemmas with multiple Meaning rows | 7,525 | 5,985 |
| Multi-Meaning lemmas re-judged | 7,525 | — |
| Lemmas whose grouping changed | — | 2,682 |
| Multi-Meaning lemmas kept unchanged | — | 4,843 |
| Explicitly held lemmas | — | 1 |
| Repository Meaning rows | 468,828 | 464,887 |
| Repository adjudications | 125 | 125 |

The initial self-check covered all 61 C10 shards and all 7,525 lemmas that had multiple Meaning rows at the base. The remaining 34,763 C10 lemmas each had one Meaning bound to one source sense. After the review corrections below, the result preserves every one of the 60,814 C10 canonical sense IDs exactly once, adds no DROP adjudications, and leaves canonical JSONL unchanged. The spec now contains 3,099 merge groups covering 7,036 source senses (reducing 3,937 rows), plus an exact-snapshot repartition of `사전` from 24 rows to 20 groups (reducing four more rows); the repartition includes the four reviewed merged groups and preserves the other 16 senses. The total C10 reduction is 3,941 rows, from 60,813 to 56,872. Compared with the original PR base, 2,682 multi-Meaning lemmas have a changed grouping and 4,843 retain their prior grouping.

## Boundary decisions

- `새까맣다` and `새카맣다` each become one Meaning. Their senses extend blackness to great distance, complete lack of memory or knowledge, countless quantity, and sly conduct; the stronger form's source senses explicitly point back to the matching `새까맣다` senses. This follows the same lexical core used for `까맣다` in C02.
- Literal and figurative extensions are retained together where the source image supplies the lexical bridge: `새날` (dawning day → new era or future), `생매장` and its verb forms (burial alive → social exclusion), `색안경` (tinted lens → biased view), `소나기` (sudden rain → sudden influx), `수술하다` (physical operation → fundamental correction), and `시금석` (purity-testing stone → criterion for judging value or ability).
- Instrument, measure, and idiom extensions are also grouped when the source connects them directly. `숟가락` covers both the eating utensil and the amount held by one spoonful; `숙맥` retains the beans/barley source behind the expression for someone unable to distinguish them. `수면` groups sleep with inactivity, water surface with the threshold of public attention, and an animal face with a mask or sculpture modeled on it.
- `사전` is repartitioned from the full lemma snapshot. Its taxable-land senses, private-money senses, historical-record senses, and explanatory-reference-book senses are grouped by their shared lexical identities; its other unrelated senses remain separate.
- Independent identities remain separate. For example, `사간` keeps the office, admonishing action, evil qi, secret sexual relations, medicinal plant/treatment, and counterintelligence senses apart; a shared domain alone does not establish a lexical bridge. The held `싱겅싱겅하다` redirects are not used to infer a missing sense.

## Focused recheck of KEEP rationales

A source-bound recheck examined 207 KEEP-only lemma rationales that explicitly framed a boundary as literal versus figurative use, related referents, or a closely related use category. It added 189 source-supported merge groups across 180 lemmas. The remaining 27 candidate lemmas retain separate meanings because their actual source glosses did not establish a natural lexical extension. This check corrected a recurring reasoning error: naming a different referent, POS, application, or figurative use does not by itself prove a separate lexical identity.

The full correction groups and representative glosses are in the executable spec. Examples include `생명력` (living force → the force sustaining an object's function), `속옷` (underclothing → hidden interior), `소용돌이` (water whirl, fluid vortex, spiral, and figurative intermingling), `손아귀` (hand grip → influence held in one's power), and `신호탄` (signaling projectile → event announcing a beginning). These were checked against their bound canonical definitions rather than admitted by a general metaphor rule.

## Stage 2 review response: cross-record risk recheck

The Stage 2 review's six proposed splits were confirmed against the canonical glosses: `상민` distinguishes occupation from social status; `삼루` distinguishes Buddhist afflictions from liquid leakage; `상송` and `상송하다` distinguish upward submission from reciprocal sending; and `사육` and `사육하다` distinguish serving/raising people from feeding and raising animals. Those six merge instructions were removed from the spec.

The original spec contained 566 cross-record merge groups. I rechecked ten additional source-bound risk candidates whose combined glosses appeared to share only a broad category or a partial compound: six were split and four were retained after checking the complete source glosses.

| Candidate | Decision and source-bound reason |
| --- | --- |
| `사단` | Split the Buddhist temple/congregation, legal association, and literary society senses. “Group” alone does not establish one lexical identity. The temple and donor-community senses remain together; the association's general and legal senses remain together. |
| `사령` | Split the order/attendant, pardon proclamation, and military/transport command senses. The command and command-role senses remain grouped; the pardon edict is a separate single sense. |
| `사수` | Keep stagnant water and a nearly still fluid region together, but split water excluded from public use. The canonical direct links support the first pair; the legal water-rights definition does not share that sense. |
| `사심` | Split crooked/evil intent from private or self-referential thought. Their canonical direct synonyms point to different `사의` senses, and private motive is not necessarily evil. |
| `사사` | Split the senses for a wrongful act, wrong thought, heretical preacher, and crafty speech. They share a negative quality but not a complete meaning or naming principle. |
| `사견` | Split a person's own opinion from a wrong view; keep the general wrong-view and Buddhist technical senses together. A personal opinion need not be wrong. |
| `사명` | Retain the mission/command group: the source definitions consistently describe assigned duties, orders, waiting for orders, and words carried by an envoy. The separate life/death group remains separate. |
| `사무` | Retain the work/affairs group: temple, private, company, administrative, and palace-purchasing uses all describe matters handled as work or business. |
| `사비` | Retain the cost group: company, dormitory, and personally borne expenses, including a shared purchase paid for privately, all preserve the private-cost meaning. |
| `사영` | Retain shadow, light/image projection, and geometric projection: the source definitions share projecting light or a form onto a surface. |

The added Normal regression in `project.test.mjs` checks all six review splits and all six additional boundary decisions against actual canonical sense IDs and final Meaning rows, verifies complete C10 source coverage, and exercises `projectMeaningRelations` on the real `w173076-s1` → `w341062-s1` direct relation. It also keeps `사전`'s historical-record extension as a positive control. The same regression failed when run against the pre-fix PR data at `35bcf134`; it passes against the corrected rows. This is a focused risk screen, not a source-by-source re-review of all 566 cross-record groups: 16 groups were checked in this response and the other 550 original groups were not individually revisited. The corrected spec now has 556 cross-record groups.

## Hold, validation, and provenance

`싱겅싱겅하다` remains a hold for `w214490-s1`: its committed canonical gloss is the empty redirect `→ .`, and the target cannot be established from the source projection. The two current source-bound meanings remain untouched pending a source-backed target; this is not treated as candidate exhaustion.

`node scripts/meaning/apply-edits.mjs scripts/meaning/issue-764-c10.json` applied 3,099 direct merges and one repartition from the exact PR base snapshot. Final validator, replay, Normal CI, and whitespace results are recorded after they are rerun on the corrected tree. Source-bound semantic decisions and this audit were prepared and checked in the primary agent context. This provenance is **agent self-check**; it is not an independent review or human editorial approval. The overall Issue #764 remains open for review.
