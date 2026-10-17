# Issue #797 C02 gloss number audit

## Scope and evidence

This is the C02 (ㄲ) source-bound self-check for Issue #797 (removing the STDICT homonym
disambiguation number from user-facing Meaning glosses), based on `origin/master` at `2579fbb2`.
It covers every stored C02 shard (`c02_001.jsonl`-`c02_006.jsonl`) and records a decision for
every C02 gloss that contains a digit. The executable decision record is
[`issue-797-c02.json`](issue-797-c02.json) - 80 single-sense `glosses` edits - applied with
`node scripts/meaning/apply-edits.mjs scripts/meaning/issue-797-c02.json`.

| Measure | Before | After |
| --- | ---: | ---: |
| C02 shards inspected | 6 | 6 |
| C02 Meaning rows | 3,744 | 3,744 |
| Glosses exposing a source homonym number | 80 | 0 |
| Gloss edits (`glosses`) | - | 80 |
| Meaning groups / ids / `sense_ids` / relations / adjudications changed | - | 0 |
| canonical files changed | - | 0 |

Meaning grouping, ids, `sense_ids`, relation provenance and adjudications are untouched and
`data/canonical/` is byte-for-byte unchanged. Every edit is identical to the previous gloss except
for the removed two-digit source identifier, so no other lexical or semantic information is lost.
The edited rows are all single-sense Meanings (`glosses` spec), so no merge, repartition or drop was
needed.

| shard | Meaning rows | homonym numbers found | removed | kept |
| --- | ---: | ---: | ---: | ---: |
| c02_001.jsonl | 729 | 27 | 27 | 0 |
| c02_002.jsonl | 727 | 21 | 21 | 0 |
| c02_003.jsonl | 749 | 15 | 15 | 0 |
| c02_004.jsonl | 762 | 8 | 8 | 0 |
| c02_005.jsonl | 699 | 6 | 6 | 0 |
| c02_006.jsonl | 78 | 3 | 3 | 0 |
| **total** | **3,744** | **80** | **80** | **0** |

## Detection rule

A source homonym number is two ASCII digits written directly after a Korean headword and immediately
followed by a reference boundary: a closing quote, the end of the gloss, whitespace, `.`, `,`, a
bracket marker (`[1]`, `[Ⅰ]`) or a sense marker (`「1」`). A digit run that is followed by a counter,
unit or any other letter is a real number and never matches, so the audit did not apply a blanket
`text + two digits` replacement:

| gloss fragment | why it is not a source number |
| --- | --- |
| `높이는 60~90cm이며` | measurement |
| `삭과(蒴果)로 9월에 익는다` | date |
| `몸의 길이는 1.5cm 정도이며` / `1.2~1.5cm` | measurement |
| `줄기는 높이가 50~100cm이고` | measurement |
| `높이는 15미터 정도이며` | measurement |
| `제20대 대통령`, `제23대 왕(1192~1259)` | ordinal rank (`제` + number + counter) |
| `제40조는`, `제16회 국제 연합 총회`, `제25품(品)` | ordinal rank / article / volume number |
| `4개의 꼬리뼈`, `5~6월에 산란한다` | quantity / date |

C02 has no unclassified digit context: all 80 `Hangul + exactly two digits` occurrences are STDICT
homonym references, and all other digit contexts are covered by the preserved categories above.

## Removed numbers - complete list (80)

`before ⇒ after`; `removed` is the exact matched source token.

| shard:line | meaning id | lemma | removed | gloss (before ⇒ after) |
| --- | --- | --- | --- | --- |
| c02_001.jsonl:4 | `m400456` | 까까 | `과자02` | 어린아이의 말로, ‘과자02’를 이르는 말. ⇒ 어린아이의 말로, ‘과자’를 이르는 말. |
| c02_001.jsonl:41 | `m53655` | 까닥까닥 | `가닥가닥02` | 물기나 풀기가 있는 물체의 거죽이 거의 말라서 빳빳한 상태. ‘가닥가닥02’보다 센 느낌을 준다. ⇒ 물기나 풀기가 있는 물체의 거죽이 거의 말라서 빳빳한 상태. ‘가닥가닥’보다 센 느낌을 준다. |
| c02_001.jsonl:56 | `m53288` | 까댁 | `까닥01` | → 까닥01. ⇒ → 까닥. |
| c02_001.jsonl:57 | `m53289` | 까댁까댁 | `까닥까닥01` | → 까닥까닥01. ⇒ → 까닥까닥. |
| c02_001.jsonl:65 | `m52230` | 까득 | `가득01` | → 가득01. ⇒ → 가득. |
| c02_001.jsonl:71 | `m53197` | 까들막까들막 | `가들막가들막01` | 신이 나서 잘난 체하며 얄미울 정도로 자꾸 버릇없이 행동하는 모양. ‘가들막가들막01’보다 센 느낌을 준다. ⇒ 신이 나서 잘난 체하며 얄미울 정도로 자꾸 버릇없이 행동하는 모양. ‘가들막가들막’보다 센 느낌을 준다. |
| c02_001.jsonl:72 | `m403683` | 까들막까들막하다 | `가들막가들막하다01` | 신이 나서 잘난 체하며 얄미울 정도로 자꾸 버릇없이 행동하다. ‘가들막가들막하다01’보다 센 느낌을 준다. ⇒ 신이 나서 잘난 체하며 얄미울 정도로 자꾸 버릇없이 행동하다. ‘가들막가들막하다’보다 센 느낌을 준다. |
| c02_001.jsonl:77 | `m404015` | 까딱거리다 | `까닥거리다02` | 분수없이 잘난 체하며 경망하게 자꾸 행동하다. ‘까닥거리다02’보다 센 느낌을 준다. ⇒ 분수없이 잘난 체하며 경망하게 자꾸 행동하다. ‘까닥거리다’보다 센 느낌을 준다. |
| c02_001.jsonl:79 | `m52651` | 까딱까딱 | `까닥까닥02` | 자꾸 분수없이 잘난 체하며 경망하게 행동하는 모양. ‘까닥까닥02’보다 센 느낌을 준다. ⇒ 자꾸 분수없이 잘난 체하며 경망하게 행동하는 모양. ‘까닥까닥’보다 센 느낌을 준다. |
| c02_001.jsonl:80 | `m52652` | 까딱까딱하다 | `까닥까닥하다02` | 자꾸 분수없이 잘난 체하며 경망하게 행동하다. ‘까닥까닥하다02’보다 센 느낌을 준다. ⇒ 자꾸 분수없이 잘난 체하며 경망하게 행동하다. ‘까닥까닥하다’보다 센 느낌을 준다. |
| c02_001.jsonl:83 | `m52648` | 까딱대다 | `까닥대다02` | 분수없이 잘난 체하며 경망하게 자꾸 행동하다. ‘까닥대다02’보다 센 느낌을 준다. ⇒ 분수없이 잘난 체하며 경망하게 자꾸 행동하다. ‘까닥대다’보다 센 느낌을 준다. |
| c02_001.jsonl:88 | `m52649` | 까딱이다 | `까닥이다02` | 분수없이 잘난 체하며 경망하게 행동하다. ‘까닥이다02’보다 센 느낌을 준다. ⇒ 분수없이 잘난 체하며 경망하게 행동하다. ‘까닥이다’보다 센 느낌을 준다. |
| c02_001.jsonl:91 | `m52655` | 까땍 | `까딱01` | → 까딱01. ⇒ → 까딱. |
| c02_001.jsonl:92 | `m52656` | 까땍까땍 | `까딱까딱01` | → 까딱까딱01. ⇒ → 까딱까딱. |
| c02_001.jsonl:263 | `m53661` | 까부러지다 | `까부라지다01` | → 까부라지다01. ⇒ → 까부라지다. |
| c02_001.jsonl:296 | `m52874` | 까이다 | `까다01` | (속되게) 치이거나 맞아서 상처가 나게 되다. ‘까다01「4」’의 피동사. ⇒ (속되게) 치이거나 맞아서 상처가 나게 되다. ‘까다「4」’의 피동사. |
| c02_001.jsonl:309 | `m51867` | 까치 | `개비01` | → 개비01. ⇒ → 개비. |
| c02_001.jsonl:323 | `m52859` | 까치다리 | `까치발02` | → 까치발02. ⇒ → 까치발. |
| c02_001.jsonl:364 | `m55300` | 까칠하다 | `가칠하다01` | 야위거나 메말라 살갗이나 털이 윤기가 없고 조금 거칠다. ‘가칠하다01’보다 센 느낌을 준다. ⇒ 야위거나 메말라 살갗이나 털이 윤기가 없고 조금 거칠다. ‘가칠하다’보다 센 느낌을 준다. |
| c02_001.jsonl:517 | `m52220` | 깔따기 | `깔때기01` | → 깔때기01. ⇒ → 깔때기. |
| c02_001.jsonl:595 | `m405171` | 깜다 | `감다04` | 석탄의 빛깔같이 다소 밝고 짙다. ‘감다04’보다 센 느낌을 준다. ⇒ 석탄의 빛깔같이 다소 밝고 짙다. ‘감다’보다 센 느낌을 준다. |
| c02_001.jsonl:596 | `m52849` | 깜둥강아지 | `순경02` | 은어로, ‘순경02「2」’을 이르는 말. ⇒ 은어로, ‘순경「2」’을 이르는 말. |
| c02_001.jsonl:655 | `m403504` | 깜짝깜짝 | `깜작깜작01` | 자꾸 눈이 살짝 감겼다 뜨이는 모양. ‘깜작깜작01’보다 센 느낌을 준다. ⇒ 자꾸 눈이 살짝 감겼다 뜨이는 모양. ‘깜작깜작’보다 센 느낌을 준다. |
| c02_001.jsonl:657 | `m52989` | 깜짝깜짝하다 | `깜작깜작하다01` | 자꾸 눈이 살짝 감겼다 뜨이다. 또는 그렇게 되게 하다. ‘깜작깜작하다01’보다 센 느낌을 준다. ⇒ 자꾸 눈이 살짝 감겼다 뜨이다. 또는 그렇게 되게 하다. ‘깜작깜작하다’보다 센 느낌을 준다. |
| c02_001.jsonl:712 | `m52248` | 깡깡이 | `해금02` | ‘해금02’을 속되게 이르는 말. ⇒ ‘해금’을 속되게 이르는 말. |
| c02_001.jsonl:715 | `m52251` | 깡동 | `강동01` | 조금 짧은 다리로 가볍게 뛰는 모양. ‘강동01’보다 센 느낌을 준다. ⇒ 조금 짧은 다리로 가볍게 뛰는 모양. ‘강동’보다 센 느낌을 준다. |
| c02_001.jsonl:727 | `m52326` | 깡똥 | `강동01` | 조금 짧은 다리로 가볍게 뛰는 모양. ‘강동01’보다 아주 센 느낌을 준다. ⇒ 조금 짧은 다리로 가볍게 뛰는 모양. ‘강동’보다 아주 센 느낌을 준다. |
| c02_002.jsonl:11 | `m400621` | 깡술 | `강술01` | → 강술01. ⇒ → 강술. |
| c02_002.jsonl:15 | `m54462` | 깡짱 | `강장01` | 짧은 다리를 모으고 가볍게 내뛰는 모양. ‘강장01’보다 아주 센 느낌을 준다. ⇒ 짧은 다리를 모으고 가볍게 내뛰는 모양. ‘강장’보다 아주 센 느낌을 준다. |
| c02_002.jsonl:22 | `m400784` | 깡쭝 | `강중01` | 짧은 다리를 모으고 힘 있게 솟구쳐 뛰는 모양. ‘강중01’보다 아주 센 느낌을 준다. ⇒ 짧은 다리를 모으고 힘 있게 솟구쳐 뛰는 모양. ‘강중’보다 아주 센 느낌을 준다. |
| c02_002.jsonl:27 | `m54424` | 깡창 | `강장01` | 짧은 다리를 모으고 가볍게 내뛰는 모양. ‘강장01’보다 세고 거센 느낌을 준다. ⇒ 짧은 다리를 모으고 가볍게 내뛰는 모양. ‘강장’보다 세고 거센 느낌을 준다. |
| c02_002.jsonl:35 | `m54469` | 깡충 | `강중01` | 짧은 다리를 모으고 힘 있게 솟구쳐 뛰는 모양. ‘강중01’보다 세고 거센 느낌을 준다. ⇒ 짧은 다리를 모으고 힘 있게 솟구쳐 뛰는 모양. ‘강중’보다 세고 거센 느낌을 준다. |
| c02_002.jsonl:118 | `m56422` | 깨뜨리다 | `깨다02` | ‘깨다02’를 강조하여 이르는 말. ⇒ ‘깨다’를 강조하여 이르는 말. |
| c02_002.jsonl:132 | `m54575` | 깨새 | `박새01` | → 박새01. ⇒ → 박새. |
| c02_002.jsonl:134 | `m54577` | 깨성 | `소복07` | → 소복07. ⇒ → 소복. |
| c02_002.jsonl:138 | `m54579` | 깨송이 | `깨보숭이01` | → 깨보숭이01. ⇒ → 깨보숭이. |
| c02_002.jsonl:152 | `m55793` | 깨우다 | `깨다01` | 잠, 꿈 따위에서 벗어나게 하다. ‘깨다01「3」’의 사동사. ⇒ 잠, 꿈 따위에서 벗어나게 하다. ‘깨다「3」’의 사동사. |
| c02_002.jsonl:160 | `m53953` | 깨이다 | `깨다01` | 잠, 꿈 따위에서 벗어나게 되다. ‘깨다01「3」’의 피동사. ⇒ 잠, 꿈 따위에서 벗어나게 되다. ‘깨다「3」’의 피동사. |
| c02_002.jsonl:161 | `m53954` | 깨이다 | `깨다03` | → 깨다03. ⇒ → 깨다. |
| c02_002.jsonl:162 | `m53955` | 깨이다 | `깨다05` | → 깨다05. ⇒ → 깨다. |
| c02_002.jsonl:165 | `m405992` | 깨자반 | `깨보숭이01` | → 깨보숭이01. ⇒ → 깨보숭이. |
| c02_002.jsonl:194 | `m53966` | 깨트리다 | `깨다02` | ‘깨다02’를 강조하여 이르는 말. ⇒ ‘깨다’를 강조하여 이르는 말. |
| c02_002.jsonl:317 | `m53897` | 꺼득꺼득 | `꺼덕꺼덕02` | → 꺼덕꺼덕02. ⇒ → 꺼덕꺼덕. |
| c02_002.jsonl:331 | `m51047` | 꺼떡꺼떡 | `꺼덕꺼덕01` | 분수없이 잘난 체하며 자꾸 매우 경망하게 행동하는 모양. ‘꺼덕꺼덕01’보다 센 느낌을 준다. ⇒ 분수없이 잘난 체하며 자꾸 매우 경망하게 행동하는 모양. ‘꺼덕꺼덕’보다 센 느낌을 준다. |
| c02_002.jsonl:332 | `m403236` | 꺼떡꺼떡하다 | `꺼덕꺼덕하다01` | 분수없이 잘난 체하며 자꾸 매우 경망하게 행동하다. ‘꺼덕꺼덕하다01’보다 센 느낌을 준다. ⇒ 분수없이 잘난 체하며 자꾸 매우 경망하게 행동하다. ‘꺼덕꺼덕하다’보다 센 느낌을 준다. |
| c02_002.jsonl:587 | `m54138` | 껌다 | `검다02` | 숯이나 먹의 빛깔과 같이 어둡고 짙다. ‘검다02「1」’보다 센 느낌을 준다. ⇒ 숯이나 먹의 빛깔과 같이 어둡고 짙다. ‘검다「1」’보다 센 느낌을 준다. |
| c02_002.jsonl:657 | `m54642` | 껑둥 | `겅둥01` | 긴 다리로 채신없이 거볍게 뛰는 모양. ‘겅둥01’보다 센 느낌을 준다. ⇒ 긴 다리로 채신없이 거볍게 뛰는 모양. ‘겅둥’보다 센 느낌을 준다. |
| c02_002.jsonl:663 | `m54220` | 껑뚱 | `겅둥01` | 긴 다리로 채신없이 거볍게 뛰는 모양. ‘겅둥01’보다 아주 센 느낌을 준다. ⇒ 긴 다리로 채신없이 거볍게 뛰는 모양. ‘겅둥’보다 아주 센 느낌을 준다. |
| c02_003.jsonl:68 | `m54590` | 꼬대기다 | `까불다01` | → 까불다01. ⇒ → 까불다. |
| c02_003.jsonl:82 | `m404362` | 꼬락서니 | `꼴01` | ‘꼴01’을 낮잡아 이르는 말. ⇒ ‘꼴’을 낮잡아 이르는 말. |
| c02_003.jsonl:295 | `m55569` | 꼬붕 | `부하03` | → 부하03. ⇒ → 부하. |
| c02_003.jsonl:296 | `m55570` | 꼬빡 | `꼬박02` | ‘꼬박02’의 센말. ⇒ ‘꼬박’의 센말. |
| c02_003.jsonl:299 | `m55637` | 꼬빡꼬빡 | `꼬박꼬박01` | 머리나 몸을 앞으로 자꾸 조금씩 숙였다가 드는 모양. ‘꼬박꼬박01’보다 센 느낌을 준다. ⇒ 머리나 몸을 앞으로 자꾸 조금씩 숙였다가 드는 모양. ‘꼬박꼬박’보다 센 느낌을 준다. |
| c02_003.jsonl:306 | `m55605` | 꼬시다 | `꾀다03` | ‘꾀다03’를 속되게 이르는 말. ⇒ ‘꾀다’를 속되게 이르는 말. |
| c02_003.jsonl:310 | `m55199` | 꼬실꼬실 | `고슬고슬01` | → 고슬고슬01. ⇒ → 고슬고슬. |
| c02_003.jsonl:337 | `m56101` | 꼬지 | `시장06` | 은어로, ‘시장06’을 이르는 말. ⇒ 은어로, ‘시장’을 이르는 말. |
| c02_003.jsonl:352 | `m56006` | 꼬치 | `고추01` | → 고추01. ⇒ → 고추. |
| c02_003.jsonl:353 | `m56007` | 꼬치 | `고치01` | → 고치01. ⇒ → 고치. |
| c02_003.jsonl:363 | `m53914` | 꼬치전 | `산적04` | 꼬치에 꿰어 지진 전이라는 뜻으로, ‘산적04「1」’을 달리 이르는 말. ⇒ 꼬치에 꿰어 지진 전이라는 뜻으로, ‘산적「1」’을 달리 이르는 말. |
| c02_003.jsonl:438 | `m55488` | 꼭히 | `꼭03` | → 꼭03. ⇒ → 꼭. |
| c02_003.jsonl:649 | `m55098` | 꼽장떡 | `산병03` | ‘산병03’을 속되게 이르는 말. ⇒ ‘산병’을 속되게 이르는 말. |
| c02_003.jsonl:656 | `m55425` | 꼽치다 | `곱치다01` | 반으로 접어 한데 합치다. ‘곱치다01’보다 센 느낌을 준다. ⇒ 반으로 접어 한데 합치다. ‘곱치다’보다 센 느낌을 준다. |
| c02_003.jsonl:696 | `m401199_1` | 꽁이 | `수갑01` | 은어로, ‘수갑01’을 이르는 말. ⇒ 은어로, ‘수갑’을 이르는 말. |
| c02_004.jsonl:157 | `m51177` | 꽃방울 | `꽃봉오리01` | → 꽃봉오리01「1」. ⇒ → 꽃봉오리「1」. |
| c02_004.jsonl:207 | `m54953` | 꽃솔 | `꽃술03` | → 꽃술03. ⇒ → 꽃술. |
| c02_004.jsonl:214 | `m55017` | 꽃수염 | `꽃술03` | → 꽃술03. ⇒ → 꽃술. |
| c02_004.jsonl:455 | `m404364` | 꾸다 | `뀌다03` | → 뀌다03. ⇒ → 뀌다. |
| c02_004.jsonl:567 | `m56215` | 꾸뻑꾸뻑 | `꾸벅꾸벅01` | 머리나 몸을 앞으로 자꾸 많이 숙였다가 드는 모양. ‘꾸벅꾸벅01’보다 센 느낌을 준다. ⇒ 머리나 몸을 앞으로 자꾸 많이 숙였다가 드는 모양. ‘꾸벅꾸벅’보다 센 느낌을 준다. |
| c02_004.jsonl:581 | `m56903` | 꾸이다 | `꾸다01` | 꿈이 보이다. ‘꾸다01’의 피동사. ⇒ 꿈이 보이다. ‘꾸다’의 피동사. |
| c02_004.jsonl:614 | `m57781` | 꿀기다 | `꿀리다01` | → 꿀리다01. ⇒ → 꿀리다. |
| c02_004.jsonl:718 | `m55136` | 꿀편 | `꿀떡01` | → 꿀떡01. ⇒ → 꿀떡. |
| c02_005.jsonl:52 | `m407761` | 꿉슬꿉슬 | `굽슬굽슬01` | 머리카락이나 털 따위가 구불구불하거나 말려 있는 모양. ‘굽슬굽슬01’보다 센 느낌을 준다. ⇒ 머리카락이나 털 따위가 구불구불하거나 말려 있는 모양. ‘굽슬굽슬’보다 센 느낌을 준다. |
| c02_005.jsonl:179 | `m57851` | 뀌다 | `꾸이다01` | ‘꾸이다01’의 준말. ⇒ ‘꾸이다’의 준말. |
| c02_005.jsonl:180 | `m57852` | 뀌다 | `꾸이다02` | ‘꾸이다02’의 준말. ⇒ ‘꾸이다’의 준말. |
| c02_005.jsonl:206 | `m56941` | 끄득끄득 | `꺼덕꺼덕01` | → 꺼덕꺼덕01. ⇒ → 꺼덕꺼덕. |
| c02_005.jsonl:510 | `m56628` | 끝 | `끗02` | → 끗02. ⇒ → 끗. |
| c02_005.jsonl:641 | `m57257` | 끼라 | `이러01` | → 이러01. ⇒ → 이러. |
| c02_006.jsonl:66 | `m56448` | 낄룩 | `끼룩02` | → 끼룩02. ⇒ → 끼룩. |
| c02_006.jsonl:67 | `m56974` | 낄쑥 | `끼룩02` | → 끼룩02. ⇒ → 끼룩. |
| c02_006.jsonl:68 | `m56978` | 낌 | `낌새01` | → 낌새01. ⇒ → 낌새. |

## Kept in C02: `「N」` source sense numbers (outside #797 scope)

Issue #797 defines the target as the **two-digit homonym number after the headword** (`(표제어 뒤 두
자리 숫자)`). The `「N」` marker is the source *sense*
number, not the homonym number, so it is retained: it is the sense-level distinction the issue asks
not to lose, and removing it would collapse the source sense identity the issue explicitly keeps.
24 C02 glosses contain `「N」`; 7 of them also carried a two-digit homonym number that was removed
here, and 17 contain only `「N」` and are unchanged.

| shard:line | meaning id | lemma | homonym number | user-facing gloss (after) |
| --- | --- | --- | --- | --- |
| `data/meanings/c02_001.jsonl:296` | `m52874` | 까이다 | number removed, `「N」` kept | (속되게) 치이거나 맞아서 상처가 나게 되다. ‘까다「4」’의 피동사. |
| `data/meanings/c02_001.jsonl:596` | `m52849` | 깜둥강아지 | number removed, `「N」` kept | 은어로, ‘순경「2」’을 이르는 말. |
| `data/meanings/c02_002.jsonl:152` | `m55793` | 깨우다 | number removed, `「N」` kept | 잠, 꿈 따위에서 벗어나게 하다. ‘깨다「3」’의 사동사. |
| `data/meanings/c02_002.jsonl:160` | `m53953` | 깨이다 | number removed, `「N」` kept | 잠, 꿈 따위에서 벗어나게 되다. ‘깨다「3」’의 피동사. |
| `data/meanings/c02_002.jsonl:587` | `m54138` | 껌다 | number removed, `「N」` kept | 숯이나 먹의 빛깔과 같이 어둡고 짙다. ‘검다「1」’보다 센 느낌을 준다. |
| `data/meanings/c02_003.jsonl:363` | `m53914` | 꼬치전 | number removed, `「N」` kept | 꼬치에 꿰어 지진 전이라는 뜻으로, ‘산적「1」’을 달리 이르는 말. |
| `data/meanings/c02_004.jsonl:157` | `m51177` | 꽃방울 | number removed, `「N」` kept | → 꽃봉오리「1」. |
| `data/meanings/c02_002.jsonl:124` | `m55903` | 깨물리다 | unchanged | 아랫니와 윗니가 맞닿을 정도로 세게 물리다. ‘깨물다「1」’의 피동사. |
| `data/meanings/c02_002.jsonl:528` | `m54134` | 껀둥껀둥 | unchanged | 하나도 흩어지지 않게 멀끔히 가다듬어 수습하는 모양. ‘건둥건둥「1」’보다 센 느낌을 준다. |
| `data/meanings/c02_002.jsonl:578` | `m54230` | 껄쭉하다 | unchanged | 액체가 묽지 않고 꽤 걸다. ‘걸쭉하다「1」’보다 센 느낌을 준다. |
| `data/meanings/c02_002.jsonl:579` | `m54231` | 껄쭉히 | unchanged | 액체가 묽지 아니하고 꽤 건 정도로. ‘걸쭉히「1」’보다 센 느낌을 준다. |
| `data/meanings/c02_003.jsonl:80` | `m53931` | 꼬라박히다 | unchanged | 거꾸로 내리박히다. ‘꼬라박다「1」’의 피동사. |
| `data/meanings/c02_003.jsonl:325` | `m56586` | 꼬임 | unchanged | ‘꾐「1」’의 본말. |
| `data/meanings/c02_003.jsonl:395` | `m404368` | 꼭두잡이 | unchanged | → 꼭뒤잡이「2」. |
| `data/meanings/c02_003.jsonl:397` | `m55082` | 꼭둑각시놀음 | unchanged | → 꼭두각시놀음「1」. |
| `data/meanings/c02_003.jsonl:547` | `m56337` | 꼴칵 | unchanged | 적은 양의 액체나 음식물 따위가 목구멍이나 좁은 구멍으로 한꺼번에 넘어가는 소리. 또는 그 모양. ‘꼴깍「1」’보다 거센 느낌을 준다. |
| `data/meanings/c02_003.jsonl:548` | `m404520` | 꼴칵거리다 | unchanged | 적은 양의 액체나 음식물 따위가 목구멍이나 좁은 구멍으로 한꺼번에 넘어가는 소리를 자꾸 내다. ‘꼴깍거리다「1」’보다 거센 느낌을 준다. |
| `data/meanings/c02_003.jsonl:549` | `m404521` | 꼴칵꼴칵 | unchanged | 적은 양의 액체나 음식물 따위가 목구멍이나 좁은 구멍으로 한꺼번에 자꾸 넘어가는 소리. 또는 그 모양. ‘꼴깍꼴깍「1」’보다 거센 느낌을 준다. |
| `data/meanings/c02_003.jsonl:550` | `m56773` | 꼴칵꼴칵하다 | unchanged | 적은 양의 액체나 음식물 따위가 목구멍이나 좁은 구멍으로 한꺼번에 자꾸 넘어가는 소리를 내다. ‘꼴깍꼴깍하다「1」’보다 거센 느낌을 준다. |
| `data/meanings/c02_003.jsonl:551` | `m56338` | 꼴칵대다 | unchanged | 적은 양의 액체나 음식물 따위가 목구멍이나 좁은 구멍으로 한꺼번에 넘어가는 소리를 자꾸 내다. ‘꼴깍대다「1」’보다 거센 느낌을 준다. |
| `data/meanings/c02_003.jsonl:552` | `m56771` | 꼴칵이다 | unchanged | 적은 양의 액체나 음식물 따위가 목구멍이나 좁은 구멍으로 한꺼번에 넘어가는 소리를 내다. ‘꼴깍이다「1」’보다 거센 느낌을 준다. |
| `data/meanings/c02_003.jsonl:553` | `m56772` | 꼴칵하다 | unchanged | 적은 양의 액체나 음식물 따위가 목구멍이나 좁은 구멍으로 한꺼번에 넘어가는 소리를 내다. ‘꼴깍하다「1」’보다 거센 느낌을 준다. |
| `data/meanings/c02_005.jsonl:150` | `m57544` | 꿰뚫리다 | unchanged | 이쪽에서 저쪽까지 꿰어져 뚫리다. ‘꿰뚫다「1」’의 피동사. |
| `data/meanings/c02_005.jsonl:670` | `m405834` | 끼얹히다 | unchanged | 액체나 가루 따위가 다른 것 위에 흩어지게 내던져지듯 뿌려지다. ‘끼얹다「1」’의 피동사. |

## Manual judgment and follow-up

Removing the number makes the *displayed* gloss identical for two same-lemma reference rows. Both
keep their own Meaning and `sense_ids`, and canonical is unchanged, so the data-level distinction
survives; only the rendered text no longer separates them:

- `뀌다` `m57851` (`w57851-s1`) and `m57852` (`w57852-s1`): both are `‘꾸이다’의 준말.` after the
  edit. They reference different canonical records - `w56902-s1` "남에게 다음에 받기로 하고 돈이나
  물건 따위를 빌려주다." and `w56903-s1` "꿈이 보이다. ‘꾸다01’의 피동사." - which stay bound through
  `sense_ids`.
- `깨이다` `m53954` (`w53954-s1`) `→ 깨다03.` and `m53955` (`w53955-s1`) `→ 깨다05.`: both become
  `→ 깨다.`. The referenced `깨다` records cannot be resolved from the exported canonical (the
  projection carries no homonym-number field and the STDICT display order differs from record order),
  so rewriting them into definitions would invent content.

Follow-up for the owner: converting these reference-form glosses into definitional glosses (using the
referenced record's canonical definition) is a separate editorial decision, because #797 forbids
inventing canonical content and this audit cannot resolve `깨다03`/`깨다05`. Recorded here rather than
silently collapsed.

## Numeric meaning preservation check

- Each removed token is `headword + NN`; the `NN` value is preserved in `data/canonical/` (records and
  their source senses are unchanged) and reachable through the row's `sense_ids`.
- `git diff` over `data/meanings/` shows 80 changed rows and only the `gloss` field changed; ids,
  `lemma`, `sense_ids` and every other field are identical.
- `data/canonical/` and `data/adjudication/` have no changes.

## Verification

```sh
node scripts/meaning/apply-edits.mjs scripts/meaning/issue-797-c02.json
node scripts/meaning/validate.mjs
node scripts/validate/meaning-gloss-numbers.mjs
node --test tests/meaning-gloss-numbers.test.mjs
```

- `apply-edits`: `applied 80 gloss edits, 0 merges, 0 repartitions and 0 drops`.
- `validate.mjs` (complete): `meaning data valid: 468828 meanings, 125 adjudications`.
- `meaning-gloss-numbers.mjs`: completed scope `c02` has 0 remaining occurrences; 5,905 occurrences
  remain in the 18 pending scopes and are reported as an informational backlog (the whole corpus is
  scanned, only completed scopes fail closed).
- The shared check is registered in `scripts/ci/registry.mjs` (canonical domain, Normal, always-on)
  with `tests/meaning-gloss-numbers.test.mjs`; completed scopes are listed in
  `scripts/validate/meaning-gloss-number-scopes.json`.

## Provenance and review status

This audit and the edit spec were prepared and checked in the primary agent context against the
canonical source glosses and the current Meaning bindings. This provenance is **agent self-check**;
it is not an independent review and does not claim human editorial approval. It supports a reviewable
C02 PR for Issue #797 and does not close the overall issue (18 scopes remain).
