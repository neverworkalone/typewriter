# Issue #774 C11 post-merge meaning audit

## Scope and reproducible baseline

This is a source-bound, primary-agent self-check of the **final merged C11 output of PR #766** at `9d8585fc364f6f8671c9aec46a58b86e147a0ec2`, using the active Issue #764 criteria. It is not an independent review. I read all 2,120 canonical C11 records and all 2,725 bound senses alongside the three current C11 Meaning shards. Each of the 84 lemmas that had multiple Meaning rows at the #766 final head is listed below, with the source boundary and the disposition. All 25 records whose senses crossed Meaning rows were separately enumerated and checked. The findings are self-check evidence; they do not replace the independent PR review required by the repository process.

| Measure at #766 final HEAD | Count |
| --- | ---: |
| Canonical lemmas | 2,006 |
| Canonical records | 2,120 |
| Bound canonical senses | 2,725 |
| Meaning rows | 2,122 |
| Lemmas with multiple Meaning rows before this audit | 84 |
| Canonical records split across Meaning rows before this audit | 25 |

The prior `scripts/meaning/issue-764-c11-audit.md` table accidentally carried the count `86` from intermediate PR #766 HEAD `35eff327186ce07c9e571d7a180ff7ff9b20e44d`. At that checkpoint, `싹을 밟다` and `쐐기(를) 박다[치다]` still each had two Meaning rows. Final PR HEAD `9d8585fc364f6f8671c9aec46a58b86e147a0ec2` merged both pairs while preserving all bound senses, yielding 84 multi-Meaning lemmas and 25 same-record splits. The old audit's table and final replay count are corrected; its checkpoint history remains explicitly historical.

The replayable changes are in [`issue-774-c11.json`](issue-774-c11.json). It has exact `before` snapshots for eleven affected lemmas: six repartitions merge related senses, and five retain their existing groups while correcting source-bound glosses. All are applied through `node scripts/meaning/apply-edits.mjs scripts/meaning/issue-774-c11.json`. It does not edit canonical records, adjudications, the #766 spec, or other 초성 shards.

## Source-bound audit of all 84 multi-Meaning lemmas

The “source records” column identifies the exact canonical records whose POS/glosses were compared with the existing Meaning membership. `KEEP` means distinct lexical identities remain separated; `MERGE` means the final groups below combine related uses of the same lexical identity. Grouped rows enumerate each lemma individually even where a common family pattern made one concise explanation appropriate.

| Lemma | Source records and decision |
| --- | --- |
| `싸개` | `w218412`, `w218413` wrapping material; `w218687` a quarrel; `w455182` a child/person insult. **KEEP 3**: material, conflict, and person are separate referents; wrapping senses and the source's related insult uses stay grouped within their own targets. |
| `싸개질` | `w218693` infant excretion; `w455184` wrapping/covering; `w455193` a quarrel. **KEEP 3**: the acts are unrelated. |
| `싸개질하다` | `w218692` packing or upholstering; `w218694` excreting; `w218695` quarrelling. **KEEP 3**: separate actions, despite the shared spelling and suffix. |
| `싸다` | `w206890` excretion; `w206891`, `w453733` kindling and wrapping; `w206892` the adjective uses for quick steps, indiscreet speech, strong fire, firm disposition, and a steep slope; `w453734` low cost or proportionate/light punishment. **KEEP 4**: the established adjective family is not split by its applications; excretion, enclosure, and price/appropriateness are separate. Corrected the adjective gloss so “말을 잘 떠벌리다” is not misreported as fast speech. |
| `싸이다` | `w214500` causing a child to excrete; `w454438` being covered, enveloped, or surrounded by people. **KEEP 2**: causation of excretion is not a covering/surrounding use. |
| `싸지르다` | `w214775` roaming about, `w214776` setting a fire, `w454640` vulgar `싸다` excretion. **KEEP 3**: independent actions and source references. |
| `싹` | `w211215` sprout and figurative beginning/sign; `w451260` cutting, sweeping, and removing completely. **KEEP 2**: noun and adverb uses have no natural bridge in the bound senses. |
| `쌀개` | `w217868` a mill component; `w217869` a dog. **KEEP 2**: unrelated referents. |
| `쌀쌀` | `w211321` simmering, gradual warming, crawling, or slow head movement; `w211565` a stinging stomach ache. **KEEP 2**: a motion/manner image is not the cited bodily sensation. |
| `쌈` | `w212917` leaf-wrapped food; `w212918` short for fight; `w212919` bundle-count units versus a gold-weight unit. **KEEP 4**: the needle/textile bundle counters stay together; food, fight, and the mass unit have different referents. |
| `쌈박` | `w212944` cutting sound/motion vs `w212948` one blink. **KEEP 2**: cutting and blinking are distinct actions. |
| `쌈박쌈박` | `w212957` repeated cutting vs `w212959` repeated blinking. **KEEP 2** for the same action boundary. |
| `쌈박쌈박하다` | `w212958` repeated cutting vs `w454684` repeated blinking. **KEEP 2**: aspect and suffix do not erase the action difference. |
| `쌈빡` | `w454685` cutting vs `w454686` one blink. **KEEP 2**. |
| `쌈빡쌈빡` | `w213485` repeated cutting vs `w454227` repeated blinking. **KEEP 2**. |
| `쌈빡쌈빡하다` | `w213486` cutting vs `w213487` blinking. **KEEP 2**. |
| `쌍` | `w214021`, `w454659` pair/rhythm/count uses vs `w454499` an angry expletive. **KEEP 2**: the expressive outburst is not a paired/count use. |
| `쌍가마` | `w214502` twin hair whorls; `w214503` two cauldrons; `w214517` a palanquin carried by two horses. **KEEP 3**: “two” describes different objects, not one lexical referent. |
| `쌍견` | `w214769` a cocoon made by two silkworms vs `w454787` both shoulders. **KEEP 2**: pairedness alone is not an identity. |
| `쌍계` | `w214779` a two-part historical topknot vs `w214780` twin chicks. **KEEP 2**: hairstyle and animals are unrelated. |
| `쌍계사` | `w210978`, `w210979` two separately located temples in Hwaseong and Hadong. **KEEP 2**: distinct proper names, not senses of one temple. |
| `쌍구` | `w451058-s1..s3` contour copying/engraving and double-line painting; `w451058-s4` the three-finger brush grip. **MERGE**: the National Institute of Korean Language lists both uses under `雙鉤`; the outline senses name paired contour lines, while the grip sense names hooking the brush with the index and middle fingers. These are applications of the same specific double-hook construction within calligraphy, not merely two unrelated methods in the same field. The gloss preserves the four source uses in separate sentences. |
| `쌍구법` | `w211795-s1..s3` the same outline techniques; `w211795-s4` brush grip. **MERGE**: the source directly pairs each sense with the corresponding `쌍구` sense, and the same `雙鉤法` construction names both outline work and the two-finger brush grip. The gloss preserves each actual use. |
| `쌍권총` | `w454634-s1` two pistols held one in each hand; `w454634-s2` student slang for two below-minimum-credit courses in a semester. **MERGE**: this is a conventional graphic metaphor from a pair of F grades (each F likened to a pistol), not a link based only on the numeral. University student-press usage confirms the F-grade slang; the two-sense gloss retains both literal and slang uses. |
| `쌍글하다` | `w209905` a quiet, affectionate smile vs `w209916` redirect to `쌍그렇다` (desolate/cool). **KEEP 2**: the redirect target is not a smile or a facial expression. |
| `쌍동` | `w218963` a light, sudden cut vs `w218966` twins born together. **KEEP 2**: shared sound and pair notion do not connect the cutting action to the people. |
| `쌍무` | `w212694` mutual contractual obligation vs `w212695` a paired dance. **KEEP 2**: a shared “two-sided/pair” feature is too broad to make legal duties and dance one word. |
| `쌍미` | `w213216` two beautiful/excellent things or people vs `w454700` the two eyebrows. **KEEP 2**: distinct compound meanings; the eyebrow use is not just another instance of two beauties. |
| `쌍봉` | `w214261` parallel-bar apparatus; `w214262` two phoenixes; `w454476` two adjacent peaks. **KEEP 3**: parallel bars, birds, and landforms are not one referent merely because each occurs in twos. |
| `쌍서` | `w211259` paired/adjacent same consonants vs `w454285` a male/female pair or spouses living together. **KEEP 2**: linguistic form and shared life are unrelated. |
| `쌍성` | `w211485` matching initial consonants in a two-character Sino-Korean word; `w211486` a reed-pipe tone/technique; `w454288` a binary star. **KEEP 3**: independent linguistic, musical, and astronomical terms. |
| `쌍수` | `w209049` both sleeves; `w209050` dual number/count (the two source senses grouped); `w209051` paired trees/śāla trees (the two source senses grouped); `w451062` both hands. **KEEP 4**: grammatical number, Buddhist trees, sleeves, and hands are different referents; count and its grammatical term stay together. |
| `쌍시` | `w209361` a persimmon with a small one inside vs `w209606` a historical northern-market fair. **KEEP 2**: fruit and market are unrelated. |
| `쌍아` | `w209371-s1` a beauty's two eyebrows; `w209371-s2` disease with both tonsils swollen; `w454457` paired plant shoots. **KEEP 3**: appearance, illness, and plant growth are independent targets. |
| `쌍일` | `w205459` stronger form of `상일` vs `w205460` even-numbered or yin days (its two source senses grouped). **KEEP 2**: the intensified adjective and calendar terms are unrelated. |
| `쌍주` | `w218982` a pair of pillars vs `w218983` a kind of silk. **KEEP 2**: unrelated objects. |
| `쌍청` | `w214979` a painting combining plum and narcissus vs `w454755` a pair of voices/singing. **KEEP 2**: an art motif and vocal sound do not share a lexical identity. |
| `쌍현` | `w211894` the bowstring appearing as two strands vs `w211895` a Korean instrument with two strings. **MERGE**: both uses concern the specific feature of a string doubled in appearance or in fact: one bowstring looks like two because the bow shakes, while the instrument has two actual strings. This perceived-versus-physical realization is a natural use shift along the same concrete string feature, not a link based only on the number two or a broad shared category. The two-sentence gloss preserves both source definitions. Unlike `쌍봉`'s parallel bars, phoenixes, and peaks, these senses share the specific string feature. |
| `쌔다` | `w213503-s1` short form for the excretion-causative use of `싸이다`; `w213503-s2..s4` short forms for covering/enveloping/surrounding uses; `w454508` accumulation/abundance uses from `쌓이다`. **KEEP 3**: the source explicitly distinguishes excretion, enclosure, and accumulation; the related enclosure variants stay grouped. |
| `쌕쌔기` | `w214512` redirect to `쌕쌕이` vs `w454490` a specific insect. **KEEP 2**: the redirect is not this insect definition. |
| `쌤` | `w210156` door/window jamb; `w210157` mine shaft; `w211779` slang short form of `쌤통`. **KEEP 3**: construction, mining, and slang targets are separate. |
| `쌩쌩하다` | `w209347` wind/fast-motion sound vs `w209349` adjective uses “stronger than 생생하다” for freshness, vigor, color, and vividness. **KEEP 2**: sound-producing motion and the independent `생생하다` adjective family remain distinct; the four adjective uses stay together. |
| `써내다` | `w214392` redirect to `켜내다` vs `w455413` writing and submitting. **KEEP 2**: source redirect target and written output are different actions. |
| `써레` | `w214629` a coastal shell/seaweed scraper vs `w455035` a paddy harrow. **KEEP 2**: different tools and tasks. |
| `써리다` | `w207427` short form of cutting (`썰다`) vs `w455663` harrowing. **KEEP 2**: cutting and field leveling are distinct actions. |
| `썩` | `w207443` cutting/sweeping/biting sound and manner; `w453026-s1` much above ordinary degree; `w453026-s2` without delay/quickly. **KEEP 3**: the two adverbial axes (degree and time) do not imply each other, and neither is a source-supported extension of the cutting sound. |
| `썩썩` | `w454952-s1..s2` cutting, pushing, sweeping, or rubbing sounds/manner vs `w454951` quickly/without delay. **KEEP 2**: vigorous physical motion may occur quickly, but the bound definitions do not establish that broad temporal meaning as an extension of these sounds. |
| `썩정이` | `w211354-s1` a rotten object vs `w211354-s2` redirect to `삭정이` (dead branch). **KEEP 2**: the redirect names another object. |
| `썰다` | `w212148` short form of harrowing (`써리다`) vs `w452542` sawing/cutting an object. **KEEP 2**: separate field action and cutting action. |
| `썸벅` | `w212983` a cutting sound vs `w213228` redirect to `씀벅`. **KEEP 2**: sound and target redirect differ. |
| `썸벅썸벅` | `w454050` repeated cutting sounds vs `w213505` redirect to `씀벅씀벅`. **KEEP 2**. |
| `썸뻑` | `w213507` cutting sound vs `w213511` redirect to `씀뻑`. **KEEP 2**. |
| `썸뻑썸뻑` | `w213523` repeated cutting sounds vs `w213524` redirect to `씀뻑씀뻑`. **KEEP 2**. |
| `쏙` | `w453517-s1..s13` one adverbial use range; `w455440` the crustacean. **KEEP 2**: depth/protrusion and associated sudden, bodily, exclusion, stain-removal, speech, fit, memory, attention, appeal, and likeness uses remain one adverbial family; the animal name is unrelated. Rewrote the single group gloss to enumerate all source uses rather than assert one abstract core. |
| `쐐기` | `w211902`, `w211903` wedge-tool uses (including the 씨아 component) vs `w211904-s1..s2` two moth-larva descriptions. **KEEP 2**: the tool differs from larvae; the source's larva subtypes stay together. |
| `쐬벌이` | `w212708-s1` slang for money-making vs `w212708-s2` slang for theft. **KEEP 2**: the source gives different actions; theft can be a way to obtain money, but that real-world possibility alone is not a lexical bridge. No verified source/use evidence in this audit establishes that the theft sense means “money-making.” |
| `쑥` | `w210984` a gullible/foolish person or action; `w454098-s1..s11` one adverbial use range; `w454480` mugwort plants. **KEEP 3**: person/action, movement/state adverb, and plant are distinct; rewrote the adverb group gloss to include its several source applications. |
| `쑥대머리` | `w450875-s1` disheveled hair; `w450875-s2` a pansori section in *Chunhyang-ga*. **MERGE**: the section title originates from the opening lyric describing Chunhyang's disheveled hair; it is a natural phrase-to-title extension, not a separate identity merely because it names a work section. Both uses remain explicit in the gloss. |
| `쑥방망이` | `w209646` an Asteraceae perennial plant vs `w450629` a tool for mixing mugwort into rice cake. **KEEP 2**: plant and implement are unrelated referents. |
| `쓰` | `w215295` a Japanese city vs `w455173` the long Morse-code mark/signal. **KEEP 2**: proper place name and code symbol are unrelated. |
| `쓰다` | `w211088` burying; `w211089` moving a game piece; `w211332` bitter/unpleasant experience; `w215568` writing; `w451789` wearing/covering or bearing blame; `w453352-s1..s10` use/employ/spend/attention/effort/body/place/language uses; `w453352-s11` being proper/right. **KEEP 7**: retain the separate source-backed lexical families; the 10 “use” senses remain one Meaning. Rewrote that group's gloss to retain employing, giving/spending, requiring, attention/effort, body, place, and language uses. |
| `쓰렁쓰렁` | `w211915-s1` acting secretly; `w211915-s2` doing work carelessly; `w212161-s1` relations growing distant. **KEEP 3**: secrecy, lack of care, and relationship distance differ in event and meaning; “loose/disengaged” would be an unsupported broad abstraction. |
| `쓰리` | `w206532` an ice-fishing spike vs `w206820` redirect to pickpocketing. **KEEP 2**: tool and person/action redirect are separate. |
| `쓰이다` | `w212752` writing; `w212969` a hat/object being put on; `w454217` use/spending. **KEEP 3**: these follow distinct `쓰다` families (write, wear/cover, use). |
| `쓱싹` | `w214023-s1` sawing/filing sound; `w214023-s2..s3` covertly mishandling a wrong act or omitting a required calculation. **KEEP 2**: the latter two are one underhand/incorrect action range; the sound is not shown to be its source or extension. The National Institute of Korean Language's usage answer distinguishes this underhand use from ordinary “finish something at once,” for which it recommends `뚝딱`. |
| `쓴술` | `w214825-s1` mel-rice wine contrasted with glutinous-rice wine vs `w214825-s2` a bitter medicinal liquor. **KEEP 2**: a grain-defined wine name and a taste/medicinal description are not the same lexical category just because both are alcoholic drinks. |
| `쓸다` | `w208244`, `w454099-s1..s7` abrasion, sweeping, stroking/rubbing, dragging, disaster spread/damage, monopolizing, general all-at-once gathering, and silkworm transfer. **KEEP 2**: these physical and extended sweep/contact uses form one verb family; `w211514` is the separate Bumpae chant noun. The gloss names general gathering separately from monopolizing and preserves silkworm transfer. |
| `쓸리다` | `w208548`, `w208562`, `w208801`, `w455256` abrasion, sweep/displacement, silkworm transfer, disease/disaster spread, and gathering; `w454100` tilting to one side. **KEEP 2**: the first group is explicitly passive/causative to `쓸다` sweep/contact uses; tilt has no such source link. Existing gloss covers each first-group use. |
| `씀벅거리다` | `w455429-s1` repeated blinking vs `w455429-s2` stinging/prickling in eye or flesh. **KEEP 2**: visible action and bodily sensation are not natural extensions of each other. |
| `씀벅대다` | `w214155-s1..s2` the same blink/sensation distinction. **KEEP 2**. |
| `씀벅씀벅` | `w454860-s1..s2` the same repeated blink/sensation distinction. **KEEP 2**. |
| `씀벅씀벅하다` | `w214160-s1..s2` the same repeated blink/sensation distinction. **KEEP 2**. |
| `씀벅이다` | `w214156-s1..s2` the same blink/sensation distinction. **KEEP 2**. |
| `씀뻑거리다` | `w214416-s1..s2` the same repeated blink/sensation distinction, with stronger intensity. **KEEP 2**. |
| `씀뻑대다` | `w214417-s1..s2` the same repeated blink/sensation distinction, with stronger intensity. **KEEP 2**. |
| `씀뻑씀뻑` | `w453719-s1..s2` the same repeated blink/sensation distinction, with stronger intensity. **KEEP 2**. |
| `씀뻑씀뻑하다` | `w214657-s1..s2` the same repeated blink/sensation distinction, with stronger intensity. **KEEP 2**. |
| `씀뻑이다` | `w214655-s1..s2` the same blink/sensation distinction, with stronger intensity. **KEEP 2**. |
| `씌다` | `w210841` ghost possession; `w210842` wearing/covering; `w210843` use/spending; `w455026` writing; `w455027` covering/bearing blame. **KEEP 5**: the forms bind to separate `쓰다` families, and ghost possession is independently unrelated. |
| `씌우다` | `w210857` making someone write; `w210858` using/employing; `w455038` covering/putting on or imposing blame. **KEEP 3**: distinct writing, use, and covering/bearing uses. |
| `씨` | `w207992` interjection; `w210861` weaving thread; `w210862` part-of-speech class; `w454589` surname lineage/title/honorific; `w455012` seed/reproductive source and figurative origin. **KEEP 5**: the address/honorific and seed/source metaphor group internally; the other referents are independent. |
| `씨룩` | `w454353-s1` redirect to `씰긋` (a thing tilting askew); `w454353-s2` redirect to `씰룩` (a muscle moving askew). **MERGE**: the bound targets describe neighboring small, off-axis movements within one adverbial motion range; target wording and both source bindings remain represented in the new gloss. |
| `씩씩하다` | `w212746` firm/strong and dignified vs `w212757` panting/gasping sound. **KEEP 2**: adjective quality and respiratory sound are independent uses. |
| `씽씽하다` | `w214430` wind/fast-motion/cicada sound vs `w214674` adjective uses “stronger than 싱싱하다” for freshness, vigor, and clear color. **KEEP 2**: source explicitly distinguishes the sound verb from the adjective family; the adjective's three applications stay grouped. |

## Same-record split audit: all 25 at #766 final HEAD

These are all 25 canonical records that had senses distributed across more than one Meaning row before this audit. The reason below is the bound source distinction, never the record boundary by itself. Five of these partitions are merged by the new spec (`쌍구`, `쌍구법`, `쌍권총`, `쑥대머리`, `씨룩`), leaving 20 same-record splits in the audited result. `쌍현` is a separate-record merge and was not part of this count.

| Lemma and record | Decision from the exact source senses |
| --- | --- |
| `쌈` — `w212919-s1..s3` | Keep needle/textile bundle counters together; keep the gold mass unit separate because it counts weight, not bundled objects. |
| `쌍구` — `w451058-s1..s4` | **Merge** outline copying/inscription, double-line painting, and the grip that hooks the brush with the index and middle fingers; all are named by the same specific `雙鉤` construction. |
| `쌍구법` — `w211795-s1..s4` | **Merge** the corresponding outline, painting, and brush-grip uses under the same `雙鉤法` construction; each sense has a direct source-synonym pairing with `쌍구`. |
| `쌍권총` — `w454634-s1/s2` | **Merge** literal two pistols and slang for two below-minimum-credit courses: two F marks are conventionally likened to the paired pistols. |
| `쌍아` — `w209371-s1/s2` | Keep eyebrow appearance separate from bilateral tonsil disease; sharing bilateral anatomy is only a broad category. |
| `쌔다` — `w213503-s1..s4` | Keep the excretion-causative short form separate from the short forms of cover/envelop/surround; merge the latter uses. |
| `썩` — `w453026-s1/s2` | Keep “far above the usual degree” separate from “without delay/quickly”; degree and time are independent axes here. |
| `썩정이` — `w211354-s1/s2` | Keep a rotten object separate from the redirect to `삭정이` (a dead branch). |
| `쐬벌이` — `w212708-s1/s2` | Keep slang for money-making separate from slang for theft; no source or checked usage bridges them. |
| `쑥대머리` — `w450875-s1/s2` | **Merge** disheveled hair and the pansori section title; the title comes from the opening lyric describing the jailed Chunhyang's hair. |
| `쓰다` — `w453352-s1..s11` | Keep s1..s10 (use/employ/give/spend/attend/demand/effort/body/place/language) together; keep s11 “be in a proper state” separate. |
| `쓰렁쓰렁` — `w211915-s1/s2` | Keep secretive conduct separate from careless work; the shared adverbial manner form supplies no common event or source bridge. |
| `쓱싹` — `w214023-s1..s3` | Keep sawing/filing sound separate from covert wrongdoing/miscalculation; s2 and s3 remain grouped as underhand handling. |
| `쓴술` — `w214825-s1/s2` | Keep the grain-defined wine name separate from bitter medicinal liquor; alcohol is too broad a common category. |
| `씀벅거리다` — `w455429-s1/s2` | Keep blinking separate from stinging/prickling in the eye or flesh. |
| `씀벅대다` — `w214155-s1/s2` | Same action vs bodily-sensation boundary. |
| `씀벅씀벅` — `w454860-s1/s2` | Same action vs bodily-sensation boundary. |
| `씀벅씀벅하다` — `w214160-s1/s2` | Same action vs bodily-sensation boundary. |
| `씀벅이다` — `w214156-s1/s2` | Same action vs bodily-sensation boundary. |
| `씀뻑거리다` — `w214416-s1/s2` | Same action vs bodily-sensation boundary; stronger degree does not change the relation. |
| `씀뻑대다` — `w214417-s1/s2` | Same action vs bodily-sensation boundary; stronger degree does not change the relation. |
| `씀뻑씀뻑` — `w453719-s1/s2` | Same action vs bodily-sensation boundary; stronger degree does not change the relation. |
| `씀뻑씀뻑하다` — `w214657-s1/s2` | Same action vs bodily-sensation boundary; stronger degree does not change the relation. |
| `씀뻑이다` — `w214655-s1/s2` | Same action vs bodily-sensation boundary; stronger degree does not change the relation. |
| `씨룩` — `w454353-s1/s2` | **Merge** the redirect senses: the targets are a crooked tilt and a small askew muscle movement, two neighboring uses in one movement range. |

## Merged-case gloss fidelity and controls

- `썰렁썰렁하다` remains one Meaning for all four `w452544-s1..s4` uses. Its current gloss explicitly covers a cool breeze, boiling/moving water, lightly waving arms or tail, and a very chilly state, and retains the comparison to `설렁설렁하다`. Multiple clauses are appropriate here; no forced abstract single-sentence gloss or split is needed.
- The `쏙` group (`w453517-s1..s13`) had one abstract sentence that omitted specific source applications. The new gloss separately names in/out motion, insertion/removal, popping/bursting, loss of energy/weight, exclusion, stain removal, rash speech, sleek appearance, vivid memory/impression, sudden mental change, indulgence, appeal, and likeness.
- The `쑥` adverb group (`w454098-s1..s11`) likewise now names all bound uses: entering/protruding, pushing/pulling, popping/bursting, loss of energy/weight, exclusion, stain removal, rash speech, sleek appearance, sudden mental change, sharp rise/fall, and moving forward/appearing.
- `쓰다` use group (`w453352-s1..s10`) now keeps the source's distinct actions visible in four sentences: use materials/tools/means or employ people; give/pay, attend, and demand; spend time/money/effort or move a body part; use a place or language. The separate “proper/right state” source sense is unchanged.
- `쓸다`'s contact/sweep family now explicitly includes sweeping away, stroking/rubbing, dragging, disaster spread/damage, monopolizing, the distinct general all-at-once gathering sense, and collecting/transferring newly hatched silkworms from the incubation paper. The Bumpae chant remains separate. `쓸리다`'s current group already names abrasion, displacement, spread/damage, silkworm transfer, and gathering; the source-unrelated tilt use stays separate.
- Controls remain source-faithful: `쐐기` keeps the wedge tool separate from the two grouped larva descriptions; `쌍계사` keeps the two real temples separate; `쌩쌩하다` and `씽씽하다` keep the sound verbs separate from adjectives whose sources explicitly compare them with `생생하다`/`싱싱하다`.

## External usage evidence consulted

- The [National Institute of Korean Language answer on `쓱싹`](https://www.korean.go.kr/front/onlineQna/onlineQnaView.do?mn_id=27&pageIndex=1&qna_seq=326892) distinguishes the listed “underhand/incorrect act” use from ordinary finishing something at once. This supports retaining the sound and underhand use as separate rather than generalizing the second gloss to any quick action.
- The [Yonsei Chunchu article on grades](https://chunchu.yonsei.ac.kr/news/articleView.html?idxno=9539) documents the student use of `쌍권총` for two F grades. A [secondary popular reference](https://readonly.wiki/w/%EC%8C%8D%EA%B6%8C%EC%B4%9D) explains the F-shape/pistol association; I treat that as corroboration of a familiar graphic metaphor, not as official lexicographic authority. The two source senses are retained together in one Meaning with both gloss statements.
- The [National Gugak Encyclopedia entry for `쑥대머리`](https://www.gugak.go.kr/ency/topic/view/778) explains that the pansori section title comes from its opening lyric. This directly supports the phrase-to-title extension and the merge.
- The National Institute of Korean Language's [two `쌍구` entries](https://kli.korean.go.kr/term/trgtWord/indexTrgtWord.do?trgtWordNo=2311759) name both outline drawing and the two-finger brush grip with the same `雙鉤` form; its [`쌍구법` entry](https://kli.korean.go.kr/term/trgtWord/indexTrgtWord.do?trgtWordNo=2311764) gives the same grip definition under `雙鉤法`. The Academy of Korean Studies' [calligraphy-method article](https://encykorea.aks.ac.kr/Article/E0027755) identifies the index/middle-finger grip, while its [outline-painting entry](https://encykorea.aks.ac.kr/Article/E0005743) calls the contour method `쌍구법(雙鉤法)`. Together with the canonical cross-sense synonym relations, these support one concrete double-hook naming principle across the uses.

## Expected result after replay

The six merged lemmas each go from two Meaning rows to one: `쌍권총`, `쑥대머리`, `씨룩`, `쌍현`, `쌍구`, and `쌍구법`. Therefore the replay is expected to produce **2,116 C11 Meaning rows**, **2,006 lemmas**, **78 multi-Meaning lemmas**, **20 same-record splits**, and the same **2,725 bound canonical senses**. All 84 pre-edit multi-Meaning lemmas have a disposition above. Canonical and adjudication data remain unchanged, and all modified rows stay in C11.
