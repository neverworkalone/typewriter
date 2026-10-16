# Issue #764 C09 meaning boundary audit

## Scope and evidence

This is the C09 (ㅃ) source-bound self-check for Issue #764, based on `origin/master` at `417aaf0fd718c6b1695b177b685348cdd6205729`. The complete decision record is [`issue-764-c09.json`](issue-764-c09.json). It records the exact prior Meaning rows and a final group assignment for every C09 lemma, including unchanged groupings.

| Measure | Before | After |
| --- | ---: | ---: |
| C09 canonical records | 2,005 | 2,005 |
| C09 lemmas | 1,848 | 1,848 |
| C09 canonical senses | 3,081 | 3,081 |
| C09 Meaning rows | 2,980 | 1,911 |
| Multi-sense lemmas re-judged | 617 | — |
| Lemmas whose grouping changed | — | 560 |
| Lemmas with multiple final Meanings | — | 53 |
| Final same-record splits | — | 15 |
| Final cross-record-only splits | — | 38 |
| Repository adjudications | 117 | 117 |

The Stage 2 review examined the prior C09 result at 2,101 Meaning rows: 196 lemmas had multiple Meanings, including 146 same-record splits across 147 canonical records and 50 cross-record-only splits. This audit rechecked all 146 same-record cases and all 50 cross-record-only cases against their canonical source senses, then checked related derivatives and linked records. The revised result has 53 multi-Meaning lemmas; 131 of the initial same-record split lemmas no longer split a source record, and 12 of the initial cross-record-only boundaries now share one Meaning. The 9 specifically reported under-merges are included in those changes.

Every canonical C09 sense occurs in exactly one final group. All 1,848 lemmas are represented; the 1,231 lemmas with one canonical sense remain one Meaning each. No sense was dropped and no adjudication was added. Canonical JSONL and adjudication files are unchanged. The editor replay uses each exact `before` snapshot and requires complete, non-overlapping sense coverage.

## Source-bound decision procedure

For every reviewed multi-sense lemma, I expanded all canonical records and senses before comparing the prior Meaning groups. Record number, POS, grammatical role, target, action, and literal-versus-figurative use were treated as evidence, never as automatic split rules. For each boundary I asked whether the source definitions support one ordinary lexical extension or a shared concrete sound, movement, or sensory image. I merged only when that bridge was supported by the source meanings. I retained separate groups where the source senses identify unrelated referents or operations, point to different headwords, or offer no natural semantic bridge; a vague shared abstraction was not enough.

The same check was applied across related forms and separate canonical records. No string-similarity rule or lexical-case validator was added: these are editorial judgments, preserved in the decision spec and audit. `node scripts/meaning/validate.mjs` remains responsible for structural coverage and integrity, not semantic admission.

## Integrated meanings

- **The 9 Stage 2 findings:** `빠뜨리다` (`w438059-s1..s4`) and `빠트리다` (`w167944-s1..s4`) each now have one Meaning for dropping someone or something into water, a deep place, or difficulty and for losing or omitting an item. `빠글거리다`, `빠글대다`, `빠글빠글`, and `빠글빠글하다` each include liquid, foam, crowded movement, and anxious agitation in one Meaning. `삥` (`w441695-s1..s4`) groups turning, dizziness, surrounding, and tears; the separate card-game sense (`w442477-s1`) stays apart. `뺑그르르` (`w441496-s1/s2`) and `뺑그르르하다` (`w167157-s1/s2`) group rotation with tears at the eye.
- **Connected source uses:** `빠지다` (`w438190-s1..s13`, `w438207-s1..s6`) is one verb Meaning across leaving a place or expected position, absence and decrease, entering a place or state, remaining profit, and comparative appearance. The record split did not establish an independent lexical identity for the profit or state-entry senses.
- **Shared sensory and action images:** related `빠작` forms group dry crackling with burning, sweat, and anxious tension; `빠지직`/`빠직` forms group crackling, splitting, bowel sound, and sweat. `빡빡`, `뻐적`, and `뻑뻑` families group forceful friction or tearing with their source-defined bodily and figurative extensions. `빨딱` and `뻘떡` families include heartbeats, effort, standing or falling, and rapid drinking. `빨쪽` and `뻘쭉` families include openings, smiles, protruding ends, and the related raised shape. `뻐개다` includes splitting, ruining a nearly finished task, striking, and opening the mouth in joy.
- **Related sound-symbolic forms:** the `뺘드득` and `삐드득` families group friction and toy-flute sounds by the shared tight, high-pitched squeak. `뽀도독`, `뽀드득`/`뽀득`, `뿌두둑`, and `뿌드득`/`뿌득` group their source-described rubbing, snow-crunching, and bowel sounds as one sharp, compressed sound image per lemma. `뿌지직`/`뿌직` group sizzling, splitting, bowel, and sweat uses; `뿍` groups a short burst with the forceful scraping and tearing sound. These decisions preserve every sense in the gloss and do not equate the underlying events.
- **Other linked records and derivatives:** `빠금`/`빠끔` forms group small gaps or partly opened doors with mouth-opening and intake uses. `빼다` groups extraction, removal, and escape, while dressing up or posing remains separate. `빨빨` and `뻘뻘` group hurried movement with heavy sweating. `빤짝`/`빤짝빤짝` and `뻔쩍`/`뻔쩍뻔쩍` group sudden lifting or eye-opening with flashes and momentary clarity. `뺑글뺑글` and `삥글삥글` group smooth rotation with the rounded motion of smiling. `삐삐` groups the pager with its signal, flute, and piercing child-cry sounds, while gauntness remains separate. `삥삥하다` groups rotation, dizziness, and dazed movement. `뺑대`, `뿌다구니`, `뼈끝`, `뼈지다`, `뺨`, `뿔`, and `뿔테` group the source-supported plant/tool, part/fragment, bone, cheek-width, horn/projection/anger, and horn-ring/frame extensions respectively.

## Remaining same-record boundaries

The 15 retained same-record splits below were checked against the listed source definitions. These are the remaining cases where the same-record senses describe separate concepts or explicitly redirect to a different headword; none is retained solely because it was split in the previous Meaning result.

| Lemma | Source boundary retained |
| --- | --- |
| `빠꿈이` | `w163053-s1/s2`: a clever person versus a miserly person. |
| `빤빤하다`, `빤빤히` | `w437942-s1/s2`, `w163552-s1/s2`: a flat, even surface versus idling or playing. |
| `빵재비` | `w156465-s1/s2`: a repeat offender versus a pickpocket. |
| `빼치다` | `w439870-s1/s2`: forcing something out versus tapering an end to a point. |
| `뺜하다` | `w162746-s1/s2`: slight infatuation versus a derogatory reference to `빤하다`. |
| `뻥나다` | `w162541-s1/s2`: a secret becoming known versus a reference to `판나다`. |
| `뻥짜` | `w441414-s1/s2`: a failed hope or outcome versus a person lacking intelligence. |
| `뼁끼` | `w437900-s1/s2`: slang for deceiving someone versus a reference to `페인트02`. |
| `뼈들다` | `w443452-s1/s2`: prolonged, onerous work versus playing with a tool. |
| `뼈물다` | `w167452-s1..s3`: dressing up, repeatedly becoming angry, and repeatedly resolving to do something. |
| `뼈칼` | `w440778-s1/s2`: a prehistoric bone knife versus a sewing implement used to mark fabric. |
| `뽕나다` | `w159865-s1..s3`: a secret being exposed versus capital running out or losses exhausting resources. |
| `뿌시다` | `w163397-s1/s2`: references to `부수다` and `부시다01`, respectively. |
| `삐뚤이` | `w160692-s1/s2`: the source's two separate senses of `비뚤이`. |

## Remaining cross-record-only boundaries

These 38 lemmas retain multiple Meanings only across separate canonical records. The source-bound contrasts are recorded here so the record boundary itself is not being used as the rationale.

| Lemma | Source boundary retained |
| --- | --- |
| `빠득빠득` | `w166009` sound-symbolic short forms versus `w442051`/`w442052` insistence, effort, and a rigid manner. |
| `빠삭하다` | `w165965`/`w440368` dry, crisp sound or texture versus `w166233` being well-informed. |
| `빠치다` | `w167943` excessive enjoyment versus the reference to `빠뜨리다` in `w437996`. |
| `빡빡이` | `w162107` texture, quantity, tightness, or rigidity; `w162109` certainty; `w516580` a shaved-headed person. |
| `빨강이` | `w165704` a red object versus `w436191`'s reference to `빨갱이01`. |
| `빨갱이` | `w165708` a derogatory term for a communist versus `w435984` a fish. |
| `빨깍빨깍` | `w156695` abrupt anger, commotion, and opening versus `w438171` wet bubbling, kneading, and drinking sounds. |
| `빨다` | `w156717` sucking or licking, `w156718` laundering, and `w156719` tapering to a point. |
| `빨리다` | `w166258`/`w166260` laundering passive or causative versus `w166259`/`w440557` suction and being drawn in. |
| `빵` | `w167440` bread or food versus `w167441` impact sounds, `w167442` prison slang, and `w534216` sexual slang. |
| `빵빵하다` | `w159963` kicking, bursting, or horns versus `w437924` fullness, plumpness, or influence. |
| `빼다` | `w163814` grooming or posing versus `w163825`/`w441769` extraction, removal, and escape. |
| `빼도리` | `w164075` adjusting an object's structure versus `w442672` a roof-supporting member. |
| `빼빼`, `빼빼하다` | `w165727`/`w435986` whistle or child-cry sound versus `w442047`/`w165726` gauntness. |
| `빽` | `w166534` a sharp cry, `w166535` a reference to `백06`, and `w440556` a tightly packed group. |
| `빽빽이` | `w166539` close spacing versus `w166540` a squeaking toy. |
| `뻐기다` | `w164364` boastful behavior versus `w442065`'s reference to `뻐개다01`. |
| `뻑뻑이` | `w166560` dryness, thickness, tightness, or rigidity versus `w166561` certainty. |
| `뻔하다` | `w440785` the auxiliary near-miss construction versus `w440786` brightness, clarity, relief, and related descriptive uses. |
| `뻔히` | `w167126` brightness, clarity, and a distinct gaze versus `w438593` objects arranged continuously. |
| `뻘꺽뻘꺽` | `w441491` sudden emotion, commotion, or opening versus `w441492` wet bubbling, kneading, and drinking sounds. |
| `뻥` | `w165765` a failed hope or outcome versus `w165766` explosion, opening, or a forceful kick sound. |
| `뻥뻥하다` | `w162544` boasting, kicking, or explosions versus `w162546` being dazed or unable to state a judgment. |
| `뼘` | `w440780` a shim versus `w440781` hand-span and its length unit. |
| `뽁` | `w164912` sexual slang versus `w435970` scraping or tearing sounds. |
| `뽕` | `w163135` drug slang, `w163136` mulberry, `w163388` a hole or escaping-gas sound, and `w534235` a clothing insert. |
| `뿌르르` | `w165176` running or chasing versus `w169302` light trembling. |
| `뿔말` | `w167875` antelope, `w167876` aquatic plant, and `w167877` algae. |
| `삐까번쩍하다`, `삐까삐까하다` | `w163119`/`w533900` and `w163120`/`w533902` preserve their distinct source-record redirects. |
| `삐다` | `w163664` a sprain versus `w437711` pooled water receding. |
| `삐삐` | `w160740`/`w160743` pager and high-pitched signal uses versus `w160741` gauntness. |
| `삐삐하다` | `w160742` gauntness versus `w160746` a child crying. |
| `삐지다` | `w437557` slicing thinly and diagonally versus `w518872` sulking. |
| `삐치다` | `w163845` sulking, `w167621` becoming exhausted, and `w167622` a calligraphic stroke. |
| `삑` | `w167868` a sharp cry versus `w167869` a tightly packed group. |
| `삥` | `w441695` rotation, dizziness, surrounding, and tears versus `w442477` the card-game score. |

## Provenance and review status

Semantic decisions and this audit were prepared and checked in the primary agent context against canonical source glosses and current Meaning bindings. This provenance is **agent self-check**. It is not an independent first or second review and does not claim human editorial approval. Independent PR reviews remain separate from this audit and follow `REVIEW.md`; this work does not close Issue #764.
