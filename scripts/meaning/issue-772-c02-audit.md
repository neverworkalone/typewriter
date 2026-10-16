# Issue #772 C02 post-merge boundary audit

## Scope and evidence

Source-bound self-check for Issue #772, based on `origin/master` at `b67dc3e4` (PR #767 merged). It re-judged all **180** C02 lemmas that still had more than one Meaning after #767, against each lemma's full set of canonical records and senses, in both directions (under-merge and over-merge). The executable record is [`issue-772-c02.json`](issue-772-c02.json): 44 `repartitions`, each with an exact `before` snapshot of the #767 output and a complete `groups` partition, applied with the shared `apply-edits`. Canonical JSONL, adjudications and the other 18 initial-code shards are unchanged.

| Measure | #767 | #772 |
| --- | ---: | ---: |
| C02 Meaning rows | 3,794 | 3,748 |
| C02 source senses | 5,096 | 5,096 |
| Multi-Meaning lemmas | 180 | 148 |
| Lemmas regrouped | — | 44 |

Every C02 sense is still in exactly one Meaning; `validate.mjs` (complete) passes.

## Priority cases

- `끼적거리다` family (5 lemmas) and the matching `깨작거리다` family (5): writing/drawing carelessly and eating reluctantly/sluggishly are one dawdling, half-hearted action ("아무렇게나·마지못해·굼뜨게") applied to different objects, so each lemma is one Meaning. Object (글씨 vs 음식) is not an independent-identity reason. Different lemmas (`끼적`/`깨작`/`끄적`) were not merged with each other.
- `까치놀`: both senses name the glow/white swell seen on the far horizon at sunset (`번득거리는 노을` / `흰빛을 띠며 이는 큰 물결`); the same visual phenomenon and name, so 1 Meaning.
- `꽃노래`: a ritual segment and a folk song are two performance contexts of one "song of flowers"; genre/context alone does not make a homonym, and no source shows a separate proper work or rite name. 1 Meaning.
- `끗`: the counting units for folded cloth and gambling score are merged as one 셈의 단위; the linguistics term `종지사` (주시경) stays separate.
- `꼭`/`꼭꼭`: `w55687`/`w55746` (틀림없이·잘·흡족하게·비슷하게) and `w404222`/`w404409` (야무지게 누름·견딤·숨음) are one "빈틈없이 단단하고 틀림없는" adverb, so they are one Meaning each; the Bukcheong lion-play servant `w404221` and the hen's brooding call `w55747` stay separate.
- Over-merge control `꼭지` (8→1 in #767): `s1~s4` (knob, kite mark, flail pin, fruit stalk) and `s5` (거지 우두머리, a synonym of 꼭지딴: the "head") share the small protruding top/head and form one Meaning. The counting units are not one image: `s6`/`s8` count tied bundles and proof bundles (묶음의 단위), while `s7` measures thread length (1 꼭지 = 20 자). A generic "unit" label cannot show continuity between measuring a length and counting bundles, so `s7` is its own Meaning. Result: 3.
- Over-merge control `껍질샘` (= `각선`): `s1` is the excretory organ of lower crustaceans; `s2`/`s3` (mollusc shell, bird eggshell) are tissues that secrete the shell substance. Different organ function with no extension path, so `s1` is separate from `s2~s3`. The #764 audit listed this as retained while the data was merged; data and audit now agree (2 Meanings).
- Updated #764 criteria (§2-1 same-category kinds, §2-2 shared naming principle): `깔깔이`(조젯 and fresh banknotes are both named for the stiff, rough 깔깔한 feel) and `꽃씨`(화초의 씨앗 and the slang for a matchstick's sulfur grain, named by the same seed image) are 1 Meaning each, with each usage kept as its own sentence. `꽁이`(수갑/열쇠) stays two: sharing a locking context is not a shared naming principle. Other retained splits (`꼬꼬마`, `꽃물`, `꽃자리`, `꽃발`, `까치발`, `깽깽이` …) have no common composition of the whole headword.
- Positive/negative controls kept from #767: `까바리`(밥그릇/깡통) and `꽃내미장단` are single Meanings; `꽁이`(수갑/열쇠) stays two.

## Other regroupings

`꺼지다` (the `거품이 꺼지다` sense bridges sinking and vanishing), `깨다` (egg hatching is breaking the shell; waking from sleep stays separate, per the source's own `깨다` numbering), `까부라지다` (bending/shrinking, linked by `고부라지다` in `w53799-s2`), `까칫까칫하다`/`꺼칫꺼칫하다` (rough skin vs catching on the skin), `꺽` (belch and choked-throat sounds), `껑청` (long legs, standing and leaping), `껴묻히다` (voice variants of burying/attaching together), `꽃봉오리` (the dance gesture imitates a bud), `꽃술` (stamens and the decorative strands that look like them), `꿍치다` (tying up → hiding).

## Gloss fidelity check (Stage 1 feedback)

All merged representative glosses were re-read against their bound canonical sense glosses for abstraction or misstatement. Corrected: `끼적거리다` (the eating sense is stated directly, not as a comparison), `꼭지` units (length vs bundle), `끗` (cloth-fold length stated as such), `꽃노래` (invented "노래하는 노래" opener removed), `꺼지다` (물체의 바닥이 내려앉거나 빠지거나), `깨다` (hatching stated as source does: intransitive 나오다 and causative 까게 하다), `까칫까칫하다` (야위거나 restored). The parallel derivative families (`끼적*`, `깨작*`, `꺼칫꺼칫하다`) were checked for the same pattern; their glosses keep the eating/behavior sense direct. Structural membership checks cannot detect this class of error, so it stays a manual source check.

Owner supplement (#764): a Meaning merge and the gloss wording are separate. Merged glosses therefore list each bound source usage as its own sentence and no longer open with an invented common abstraction; `꼭`, `꼭꼭` and `꼭지` were rewritten accordingly. This does not widen any merge.

## Reference-record check (Stage 1 feedback)

Whether a Meaning row is a `→ X` cross-reference is not itself a reason to keep it apart: the targets' actual senses were looked up. Merged because the targets are the same or neighbouring uses of one word: `끄스르다`/`끄슬리다`/`끄시르다` (→ 그슬리다 `불에 겉만 약간 타다` / → 그을리다 `오래 쬐어 검게 되다`), `깜보기` (꽁초 is a sense of 깜부기), `꼭두` (곡두 and 허깨비 both name a thing seen that is not there; → 꼭뒤 stays separate), `깨적거리다` (깨작거리다02 and 께적거리다 are the same dawdling action), `깡뚱` (깡똥01/02 have the identical gloss), `꾀이다` and `꾀다` (the passive plus the three numbered targets: `꼬이다`의 준말, 속여 끌기, 모여들기 — all of 꼬이다03's lure/gather family; the gloss lists each target usage as its own sentence), `깨이다`(→ 깎이다 and → 줄어지다, both reduction), `끊치다` (그치다/끊어지다), `깽깽` (깨깨01 crying and the pain/dog cry), `깨보숭이` (깨고물/깨소금, sesame powders), `꼭두머리`(맨 처음 / 꼭대기). Kept separate because the targets are different words or things: `꼬망지`(꼬리/꼴찌), `꼬치`(고추/고치), `꽁치`(공것/학꽁치), `꾸레미`(꾸러미/부리망), `꽃굴`(고콜), `꺽쇠`(꺾쇠), `깍정이`(깍쟁이), `꼬질대`(꽂을대), `깔딱`(딸꾹), `깨깨`(깨끗이), `끌`/`끌끌`(끄르륵 준말), `끼룩*`(끼루룩 is a bird call), `꿉실꿉실`(꿉슬꿉슬 curly), `깨치다`(깨뜨리다), `깨이다` → 깨다03/05 (homonym number not resolvable to one sense), `낌새`(틈새). Numbered references collapsed into a bare lemma were re-checked for this pattern: in `깡뚱`, `깨이다`, `끊치다`, `꼭두`, `깨적거리다`, `깜보기` the merged gloss states each target sense instead of only the target word (`깡똥01/02` carry an identical gloss; `깨다03/05` stay unmerged because their number cannot be tied to one sense). The out-of-scope `그스르다` in c01 is untouched.

Basis for `꾀이다`/`꾀다` as one Meaning (editorial judgment, with the source facts stated separately). Source facts: `w55981-s1`/`w404348-s1` mean 그럴듯한 말이나 행동으로 남을 속이거나 부추겨 끌기; `w404071-s1/s2` and `w404537-s1/s2` mean 벌레나 사람이 한곳에 모여듦; `w55980-s1` only says `꾀다` is the 준말 of `꼬이다03`; `w56755-s1` is the passive of the lure usage; `w56756~58-s1` are `→ 꾀다01/02/03`. The earlier #767 grouping of lure and gather in `꾀다` (`m55981`) and `꼬이다` (`m404348`) is a Typewriter editorial grouping, not a source statement. Judgment: luring draws a person or creature toward something, and the same pull gathering them (`벌레가 꼬이다`, `사람이 꼬이다`) is a natural extension of one word, not an independent homonym; the 준말 row and the three numbered references point at those usages. The gloss states each usage in its own sentence.

## Full audit of the 180 lemmas

Counts show #767 → #772 Meaning numbers. Retained splits record why no natural extension path exists in the source senses; each category was applied lemma by lemma to the actual record/sense lists, not to the gloss strings alone.

### MERGED — 42 lemmas

#772에서 하나(또는 같은 어휘 단위)로 재통합·재분할

`까부라지다`(2→1), `까치놀`(2→1), `까칫까칫하다`(2→1), `깔깔이`(2→1), `깜보기`(2→1), `깡뚱`(2→1), `깨다`(4→3), `깨보숭이`(3→2), `깨이다`(5→4), `깨작거리다`(2→1), `깨작깨작`(2→1), `깨작깨작하다`(2→1), `깨작대다`(2→1), `깨작이다`(2→1), `깨적거리다`(2→1), `깽깽`(2→1), `꺼지다`(2→1), `꺼칫꺼칫하다`(2→1), `꺽`(2→1), `껑청`(2→1), `껴묻히다`(2→1), `꼭`(7→2), `꼭꼭`(4→2), `꼭두`(3→2), `꼭두머리`(2→1), `꽃노래`(2→1), `꽃봉오리`(2→1), `꽃술`(3→2), `꽃씨`(2→1), `꾀다`(2→1), `꾀이다`(4→1), `꿍치다`(2→1), `끄스르다`(2→1), `끄슬리다`(2→1), `끄시르다`(2→1), `끊치다`(2→1), `끗`(3→2), `끼적거리다`(2→1), `끼적끼적`(2→1), `끼적끼적하다`(2→1), `끼적대다`(2→1), `끼적이다`(2→1)

### REF — 34 lemmas

다른 낱말을 가리키는 참조형(→, 준말·센말·본말) record가 있어 그 sense는 대상 어휘에 귀속된 별도 행으로 유지하고, 나머지 용법은 해당 record의 판정을 따른다.

`까치`(2→2), `깍정이`(3→3), `깔딱`(2→2), `깔딱깔딱`(2→2), `깔리다`(2→2), `깜짜기`(2→2), `깨깨`(3→3), `깨치다`(2→2), `꺽쇠`(2→2), `껴얹다`(2→2), `꼬독꼬독`(2→2), `꼬망지`(2→2), `꼬빡`(2→2), `꼬임`(2→2), `꼬임수`(2→2), `꼬질대`(2→2), `꼬치`(3→3), `꽁치`(3→3), `꽂이`(2→2), `꽃굴`(2→2), `꾸다`(3→3), `꾸레미`(2→2), `꿉실꿉실`(2→2), `뀌다`(3→3), `끌`(2→2), `끌끌`(2→2), `끌끌하다`(2→2), `끝`(2→2), `끼룩`(2→2), `끼룩거리다`(2→2), `끼룩끼룩`(2→2), `끼룩끼룩하다`(2→2), `끼룩대다`(2→2), `낌새`(2→2)

### HOMO — 39 lemmas

표기만 같고 원본 sense가 가리키는 대상·기능이 서로 이어지지 않는 독립 동음이의어(동물/식물/기구/지명·용어 등)이다. 의미 확장 경로를 원문 gloss에서 찾지 못했다.

`까다`(3→3), `까지다`(2→2), `까치발`(3→3), `깍지`(2→2), `깔때기`(3→3), `깡`(2→2), `깨끼`(2→2), `깽깽이`(2→2), `꺾기`(2→2), `꼬꼬마`(2→2), `꼬느다`(2→2), `꼬박`(3→3), `꼬치꼬치`(2→2), `꼴`(2→2), `꼼치`(2→2), `꽁이`(2→2), `꽃`(3→3), `꽃다지`(2→2), `꽃대`(2→2), `꽃등`(2→2), `꽃물`(3→3), `꽃받기`(3→3), `꽃발`(2→2), `꽃비`(2→2), `꽃자리`(3→3), `꽈리`(2→2), `꽝`(2→2), `꾐`(2→2), `꾸리`(2→2), `꿀떡`(2→2), `꿀리다`(2→2), `꿩`(2→2), `끄다`(2→2), `끝전`(2→2), `끼`(2→2), `끼다`(2→2), `끼이다`(2→2), `끼치다`(2→2), `끽`(2→2)

### MIMETIC — 65 lemmas

의성·의태어/파생어로, 형태가 같아도 소리·움직임의 대상(눈 깜박임과 놀람, 고개 숙임과 어김없음, 물 흐름과 돼지 소리 등)이 달라 한 동작·소리의 확장으로 설명되지 않고, 사전도 별개 어휘로 처리한다.

`까닥거리다`(2→2), `까닥까닥`(3→3), `까닥까닥하다`(3→3), `까닥대다`(2→2), `까닥이다`(2→2), `까딱거리다`(2→2), `까딱까딱`(2→2), `까딱까딱하다`(2→2), `까딱대다`(2→2), `까딱이다`(2→2), `깔깔하다`(3→3), `깔딱하다`(2→2), `깔짝거리다`(2→2), `깔짝깔짝`(2→2), `깔짝깔짝하다`(2→2), `깔짝대다`(2→2), `깜작깜작`(2→2), `깜작깜작하다`(2→2), `깜짝`(2→2), `깜짝거리다`(2→2), `깜짝깜짝`(2→2), `깜짝깜짝하다`(2→2), `깜짝대다`(2→2), `깜짝하다`(2→2), `꺅`(2→2), `꺼덕꺼덕`(2→2), `꺼덕꺼덕하다`(2→2), `꺽꺽`(2→2), `꺽꺽거리다`(2→2), `꺽꺽대다`(2→2), `껄껄하다`(2→2), `껄떡하다`(2→2), `꼬박꼬박`(2→2), `꼬빡꼬빡`(2→2), `꼬이다`(2→2), `꼴꼴`(2→2), `꼴꼴거리다`(2→2), `꼴꼴대다`(2→2), `꼴꼴하다`(2→2), `꽁꽁`(3→3), `꽁꽁거리다`(2→2), `꽁꽁대다`(2→2), `꽁꽁하다`(2→2), `꾸벅꾸벅`(2→2), `꾸뻑꾸뻑`(2→2), `꾸이다`(2→2), `꾸정꾸정`(2→2), `꾸정꾸정하다`(2→2), `꾹꾹`(2→2), `꿀꿀`(2→2), `꿀꿀거리다`(2→2), `꿀꿀대다`(2→2), `꿍꿍`(2→2), `꿍꿍거리다`(2→2), `꿍꿍대다`(2→2), `꿍꿍하다`(2→2), `끌끌거리다`(2→2), `끌끌대다`(2→2), `끌채`(2→2), `끔쩍`(2→2), `끔쩍거리다`(2→2), `끔쩍끔쩍`(2→2), `끔쩍끔쩍하다`(2→2), `끔쩍대다`(2→2), `끔쩍하다`(2→2)

## Provenance and review status

Decisions and this audit were prepared and checked in the primary agent context against canonical source glosses and the current Meaning bindings (agent self-check). They are not independent reviews or human editorial approval; the independent Stage 1/2 reviews for this PR remain pending.
