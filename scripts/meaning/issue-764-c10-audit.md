# Issue #764 C10 meaning boundary audit

## Scope and evidence

This is the C10 source-bound self-check for Issue #764, first performed against `417aaf0fd718c6b1695b177b685348cdd6205729`. The PR base is now `2579fbb268b8393b8fb6e2c949eb9ff014a048b6`; comparison confirmed that neither the C10 Meaning shards nor their canonical source records changed between those commits. I reviewed all canonical C10 records and senses together with the current #716 Meaning bindings. The executable edit record is [`issue-764-c10.json`](issue-764-c10.json); its `merges` apply only to untouched single-sense rows, and its `사전` repartition records the exact current rows and every final group for that already-edited lemma.

| Measure | Before | After |
| --- | ---: | ---: |
| C10 lemmas | 42,288 | 42,288 |
| C10 canonical senses in Meaning rows | 60,814 | 60,814 |
| C10 Meaning rows | 60,813 | 56,889 |
| C10 lemmas with multiple Meaning rows | 7,525 | 5,985 |
| Multi-Meaning lemmas re-judged | 7,525 | — |
| Lemmas whose grouping changed | — | 2,682 |
| Multi-Meaning lemmas kept unchanged | — | 4,843 |
| Explicitly held lemmas | — | 1 |
| Repository Meaning rows | 468,828 | 464,904 |
| Repository adjudications | 125 | 125 |

The initial self-check covered all 61 C10 shards and all 7,525 lemmas that had multiple Meaning rows at the base. The remaining 34,763 C10 lemmas each had one Meaning bound to one source sense. The current result preserves every one of the 60,814 C10 canonical sense IDs exactly once, adds no DROP adjudications, and leaves canonical JSONL unchanged. The spec contains 3,099 merge groups covering 7,019 source senses (reducing 3,920 rows), plus an exact-snapshot repartition of `사전` from 24 rows to 20 groups (reducing four more rows); the repartition includes the four reviewed merged groups and preserves the other 16 senses. The total C10 reduction is 3,924 rows, from 60,813 to 56,889. Compared with the original PR base, 2,682 multi-Meaning lemmas have a changed grouping and 4,843 retain their prior grouping.

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

The original spec contained 566 cross-record merge groups. The initial risk pass rechecked ten additional source-bound candidates whose combined glosses appeared to share only a broad category or a partial compound. Stage 2's follow-up identified one incorrect KEEP among those ten: `사비`. Its company expense (`w170076-s1`), dormitory payment (`w170077-s1`), private-money procurement act (`w440112-s1`), and privately borne expenditure (`w440113-s1/s2`) do not share one complete lexical meaning. The last two senses remain together as the private-cost Meaning; the other three are separate. The canonical antonym from `w440113-s1` to public cost `w394427-s1` now projects only from that private-cost Meaning. At the PR head `680ffcd`, after the first six Stage 2 splits and this earlier correction, the spec had 555 cross-record groups.

As a focused check of nearby monetary-transfer candidates, I also rechecked `사금`, `사여`, and `사여하다`. They remain grouped: the complete `사금` definitions share the core of money bestowed as recompense, while the noun and verb `사여` groups share the act of giving property, with personal/secret and state/official contexts as extensions. These are source-bound editorial decisions, not rules based on Hanja or a broad money keyword.

| Candidate | Decision and source-bound reason |
| --- | --- |
| `사단` | Split the Buddhist temple/congregation, legal association, and literary society senses. “Group” alone does not establish one lexical identity. The temple and donor-community senses remain together; the association's general and legal senses remain together. |
| `사령` | Split the order/attendant, pardon proclamation, and military/transport command senses. The command and command-role senses remain grouped; the pardon edict is a separate single sense. |
| `사수` | Keep stagnant water and a nearly still fluid region together, but split water excluded from public use. The canonical direct links support the first pair; the legal water-rights definition does not share that sense. |
| `사심` | Split crooked/evil intent from private or self-referential thought. Their canonical direct synonyms point to different `사의` senses, and private motive is not necessarily evil. |
| `사사` | Split the senses for a wrongful act, wrong thought, heretical preacher, and crafty speech. They share a negative quality but not a complete meaning or naming principle. |
| `사견` | Split a person's own opinion from a wrong view; keep the general wrong-view and Buddhist technical senses together. A personal opinion need not be wrong. |
| `사명` | At the earlier reviewed head, retain the mission/command group: the first source-bound pass did not yet separate all of its distinct compounds. The later Stage 2 follow-up below corrects that decision. |
| `사무` | Retain the work/affairs group: temple, private, company, administrative, and palace-purchasing uses all describe matters handled as work or business. |
| `사비` | Split company expense, dormitory payment, and private-money procurement from personal expenditure. Keep `w440113-s1/s2` together as personal costs; the canonical antonym to `공비` belongs only to this Meaning. |
| `사영` | Retain shadow, light/image projection, and geometric projection: the source definitions share projecting light or a form onto a surface. |
| `사금` | Retain the payment group: both definitions describe money bestowed as recompense, either by the state to bereaved families or as a token of thanks. |
| `사여`, `사여하다` | Retain the noun and verb groups: both personal/secret giving and state/official bestowal preserve the complete transfer-of-property action. |

The added Normal regression in `project.test.mjs` checks all six Stage 2 splits, the risk-focused boundary decisions, and complete C10 source coverage against actual canonical sense IDs and final Meaning rows. It asserts three negative `사비` pairs (company expense, dormitory payment, and procurement act versus personal cost), keeps `w440113-s1/s2` together as a positive control, and verifies through actual `projectMeaningRelations` that the antonym to `공비` originates only from the personal-cost Meaning. It also retains source-supported positive controls for `사금`, `사여`, `사여하다`, `사전`, and checks the `w173076-s1` → `w341062-s1` direct relation. The original cross-record relation regression failed against pre-fix PR data at `35bcf134`; the new `사비` assertions also fail when tested against prior HEAD `3ae10741`. Both pass against the corrected rows. This is a focused risk screen, not a source-by-source re-review of all 566 cross-record groups: 19 original groups were checked and the other 547 were not individually revisited at the `680ffcd` head. The correction and current bounded screen are recorded below.

## Stage 2 follow-up response: compound-identity risk screen (2026-10-17)

At exact PR HEAD `680ffcd38844d75b09e0d2adfabde2b770b2cc23`, Stage 2 found two remaining `사명` overmerges. Both findings are accepted. The bound source glosses distinguish `w171851-s1/s2` (life/death) from `w439234-s1/s2` (a deity and authority over human lifespan). They also distinguish the assigned mission and envoy's commission (`w171852-s1/s2`), company command (`w171853-s1`), waiting for Heaven's or the king's command (`w171854-s1/s2`), teacher's command (`w171855-s1`), and the king's words or words used in diplomatic envoy work (`w439238-s1/s2`). The final groups keep the related senses within each source record together and do not merge the independent compounds.

I then checked a bounded risk-first sample of cross-record groups at that same head. A canonical-gloss cue search selected 19 groups mentioning command, life, lifespan, waiting, mission, envoy, or Heaven's mandate; an additional lemma-name check selected `성명` as a positive control. These criteria overlap the earlier ten-candidate check and are not additive. Source glosses were checked for the selected groups, and no Hanja-only split rule was used. The additional corrections were:

- `사력`: retain `w161248-s1/s2` together for scholar/soldier strength; retain `w161249-s1` with `w436738-s1` for using or exerting all one's strength. Keep personal strength (`w161250-s1`) and mental capacity (`w161253-s1`) separate.
- `사마`: separate the four demons (`w163982-s1`), the death demon (`w163984-s1`), and a demon that obstructs practice (`w164994-s1`).
- `사송` and `사송하다`: separate sending an envoy (`w166126-s1`, `w166127-s1`) from the king sending goods to a subject (`w441026-s1`, `w441027-s1`).
- `사악`: retain ordinary wickedness and exercising wickedness (`w171890-s1`, `w171892-s1`) together; separate the fixed Confucian term for the Four Evils (`w439492-s1`).
- `사유`: separate the Buddhist Four States (`w165872-s1`) from the instant of death (`w165873-s1`).

Eleven other cue-selected groups remain together because the complete meanings connect: `사령하다` (commanding troops / ordering work), `사절` and `사절하다` (integrity and dying for integrity), `사첩` (official appointment documents), `상소` and `상소하다` (petitioning an authority, including the court-review extension), `성총` (favor or grace), `순수` and `순수하다` (following a norm), and `순행` and `순행하다` (acting along or according to a direction). `사력` and `사악` also retain one cross-record group each for the connected meanings described above; `성명` remains a positive control for fame/reputation and making a name. Thus six selected cross-record groups were removed from the prior 555, while 14 of the selected 20 remain represented in the current set of 549. The other 535 current cross-record groups were not individually revisited by this bounded screen. This is not a full source review of all C10 boundaries.

The new `project.test.mjs` assertions cover the `사명` negative boundaries and within-record positive groups, each corrected `사력`/`사마`/`사송`/`사악`/`사유` boundary, and positive controls for the retained groups listed above. Running the same test against the old output failed at the first new `사명` boundary assertion; it passes against the corrected projection. Canonical source data and adjudication remain unchanged. The final replay and validation results are recorded below.

## Hold, validation, and provenance

`싱겅싱겅하다` remains a hold for `w214490-s1`: its committed canonical gloss is the empty redirect `→ .`, and the target cannot be established from the source projection. The two current source-bound meanings remain untouched pending a source-backed target; this is not treated as candidate exhaustion.

`node scripts/meaning/apply-edits.mjs scripts/meaning/issue-764-c10.json` applied 3,099 direct merges and one repartition from the exact PR base snapshot, producing 464,904 meanings and 125 adjudications. The current spec covers 7,019 source senses across its merge groups; the `사전` repartition reduces four additional rows. `project.test.mjs` passed 4/4 and `validate.mjs` passed. Full `corepack pnpm run ci:normal` passed on signed commit `f84417684a8bd99ff210fc5540bd349d867658c9` in 325.9 seconds; the final artifact-policy check reported a clean working tree. `git diff --check` also passed before the commit. This last update records the completed CI result; it changes this audit wording only and does not change validated code or data. Source-bound semantic decisions and this audit were prepared and checked in the primary agent context. This provenance is **agent self-check**; it is not an independent review or human editorial approval. The overall Issue #764 remains open for review.
