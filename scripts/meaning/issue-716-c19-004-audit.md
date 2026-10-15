# Issue #716 C19 shard c19_004 source-bound edit pass

## Scope and census

This pass starts from origin/master 2ef369d42027c25d84112947012ba0795096213c. The baseline shard has 999 meanings and 1003 unique canonical sense references across 721 lemmas. The source-bound census maps every reference to committed canonical data and finds 147 lemmas with multiple meanings and 574 lemmas with one existing meaning. No lemma in this shard appears in another C19 shard.

The edit specification is scripts/meaning/issue-716-c19-004.json. It makes 19 MERGE decisions covering 39 source senses, makes 6 direct cross-reference GLOSS EDITs, and makes no DROP decisions. The result has 979 meanings and 1003 unique canonical sense references. All source senses not named in a new MERGE remain separate KEEP meanings. The 4 already-grouped base meanings (한국적: w361204-s1 + w361204-s2; 한두째: w364116-s1 + w364116-s2; 한시적: w366602-s1 + w366602-s2; 한의학적: w505373-s1 + w505373-s2) are preserved. Canonical records remain unchanged.

The only verbatim same-lemma, same-POS source gloss match is the already-grouped 한의학적 pair. No other exact duplicate or noun/determiner-equivalent pair was found in this shard.

Across C19, meaning rows move from 33380 to 33360; all canonical sense references remain accounted for.

## Source-bound decisions

The table lists every source sense in all 147 multi-meaning lemmas. A listed sense not named in a MERGE remains a separate KEEP meaning.

| Lemma | Canonical source senses | Decision and rationale |
| --- | --- | --- |
| 한그루 | w362567-s1, w362567-s2 | KEEP all listed meanings — 한 해 농사 횟수와 한 농경지에서 재배하는 작물 종류는 작업 주기와 재배 방식이다. |
| 한극 | w362572-s1, w500413-s1, w500413-s2 | MERGE w500413-s1 + w500413-s2 → “가장 추운 곳. 지구에서 가장 낮은 온도를 보이는 지점으로, 남반구의 남극 대륙 내륙 고원이나 북반구의 동시베리아 베르호얀스크 부근을 이르기도 한다.” — 두 풀이 모두 가장 낮은 온도를 보이는 극한의 추운 장소를 가리키며, 두 번째는 첫 풀이의 지구상 사례를 구체화한다.<br>KEEP w362572-s1 — 한가한 틈을 뜻하는 시간·상태 표현은 추운 장소와 다르다. |
| 한글 | w362576-s1, w500425-s1 | KEEP all listed meanings — 우리나라의 문자 체계와 한글 학회의 학술 기관지는 지시 대상이 문자와 출판물로 다르다. |
| 한글 학교 | w359095-s1, w359095-s2 | MERGE w359095-s1 + w359095-s2 → “한글을 가르치는 교육 기관. 광복 직후 문맹 퇴치를 위해 세운 학교나 교민·외국인을 대상으로 한 학교를 이르기도 한다.” — 광복 직후의 문맹 퇴치 학교와 교민·외국인 대상 학교는 모두 한글을 가르치는 교육 기관이고, 시기와 학습자만 다르다. |
| 한금 | w359097-s1, w359098-s1 | KEEP all listed meanings — 금덩이와 계절에 따라 이동하는 철새는 물질과 동물이다. |
| 한기 | w359102-s1, w359103-s1, w359104-s1, w504181-s1, w504181-s2 | MERGE w504181-s1 + w504181-s2 → “추운 기운. 병적으로 느끼는 추운 기운을 이르기도 한다.” — 일반적인 추운 기운과 병적으로 느끼는 추운 기운은 같은 냉감이며, 뒤의 용례가 상태를 구체화한다.<br>KEEP w359102-s1, w359103-s1, w359104-s1 — 가뭄, 미리 정한 시기, 북송의 정치가는 기상·시간·인물로 다르며 냉감과 합치지 않는다. |
| 한기신 | w368115-s1, w368115-s2 | MERGE w368115-s1 + w368115-s2 → “죽을 때까지로 한정함. 또는 죽을 때까지.” — 죽을 때까지라는 기간을 한정하는 일과 그 기간을 부사적으로 나타내는 풀이는 품사·문법적 틀만 다르다. |
| 한길 | w368117-s1, w368118-s1 | KEEP all listed meanings — 사람과 차가 다니는 넓은 길과 하나 또는 같은 길은 도로의 공공성·규모와 동일한 경로를 가리킨다. |
| 한나라 | w360236-s1, w360237-s1, w360238-s1 | KEEP all listed meanings — 우리나라를 가리키는 말, 중국 역대 왕조의 통칭, 전국 칠웅의 한 나라는 지리·정치 단위가 다르다. |
| 한나절 | w360504-s1, w360504-s2 | KEEP all listed meanings — 하룻낮의 절반과 하룻낮 전체는 기간 길이가 다르다. |
| 한눈 | w361082-s1, w361083-s1, w504377-s1, w504377-s2 | KEEP all listed meanings — 잠깐 붙이는 잠, 딴 곳을 보는 시선, 한 차례·잠깐의 시각, 한꺼번에 보는 시야는 행위·시간·범위가 다르다. |
| 한단 | w361605-s1, w503855-s1 | KEEP all listed meanings — 중국 허베이성의 도시와 중국산 비단은 지명과 물건이다. |
| 한담 | w361902-s1, w361903-s1 | KEEP all listed meanings — 신체 통증을 동반하는 질병과 한가할 때 나누는 대화는 다르다. |
| 한당 | w362142-s1, w362143-s1 | KEEP all listed meanings — 파렴치한 무리와 조선 중기 서인의 정치 분파는 집단의 성격과 역사적 정체성이 다르다. |
| 한대 | w362146-s1, w498246-s1, w498247-s1, w533319-s1 | KEEP all listed meanings — 건축 부재, 성의 없는 대접, 극지 기후대, 한나라 시대는 물체·행위·기후·시기다. |
| 한대 기단 | w362420-s1, w362420-s2 | MERGE w362420-s1 + w362420-s2 → “아한대 고기압에서 생기는 온도와 습도가 낮고 차가운 기운. 시베리아·오호츠크해 기단 따위의 대륙성·해양성 기단과 한대에서 발생하는 극기단·아한대 기단을 통틀어 이른다.” — 두 풀이는 한대·아한대에서 생기는 차갑고 저온·저습한 기단을 가리키며, 구체적인 대륙성·해양성 사례와 기단 유형을 함께 보존했다. |
| 한더위에 털감투 | w524766-s1, w524766-s2 | MERGE w524766-s1 + w524766-s2 → “제철이 지나 쓸데없거나 격에 맞지 아니하여 거추장스러운 물건을 비유적으로 이르는 말.” — 제철에 맞지 않아 쓸모없고 거추장스러운 물건과 격에 맞지 않는 물건은 때·상황에 부적절하다는 같은 비유다. |
| 한데 | w368165-s1, w502359-s1, w502360-s1 | KEEP all listed meanings — 집 바깥의 트인 곳, 한곳, 비어 있는 지시어 풀이를 각각 유지했다. 빈 인용부의 지시 대상을 알 수 없어 보정하지 않았다. |
| 한도 | w368484-s1, w498846-s1 | KEEP all listed meanings — 기르는 벼와 일정하거나 한정된 정도는 식물과 범위다. |
| 한독 | w368489-s1, w368490-s1, w368491-s1, w498847-s1, w499015-s1, w499015-s2 | KEEP all listed meanings — 가뭄 피해·사나운 성질·한증 병독·턱 종기·한국과 독일·한국어와 독일어는 병리·성질·지명·언어로 다르다. |
| 한둘 | w364384-s1, w364384-s2, w364384-s3 | KEEP all listed meanings — 한두 개쯤의 수, 조금의 양, 적은 수부터 시작함은 수량·정도·점진적 시작의 기능이 다르다. |
| 한등 | w499003-s1, w499003-s2 | KEEP all listed meanings — 추운 밤의 등불과 쓸쓸히 비치는 등불은 놓인 상황과 정서가 다르다. |
| 한때 | w499004-s1, w499004-s2, w499004-s3 | KEEP all listed meanings — 어느 한 시기, 같은 시각, 한 시기의 짧은 동안은 기간 지시와 동시성·부사적 지속이 다르다. |
| 한란 | w365320-s1, w365916-s1, w365917-s1 | KEEP all listed meanings — 겨울에 낳은 달걀, 추움과 따뜻함, 한란초는 음식·기후·식물이다. |
| 한랭대 | w365930-s1, w365930-s2 | KEEP all listed meanings — 추운 지역과 한랭 전선 둘레는 넓은 지대와 기상 경계다. |
| 한량 | w365937-s1, w365938-s1, w365938-s2, w367194-s1, w367194-s2, w367194-s3, w367194-s4 | KEEP all listed meanings — 한정된 분량, 찬·서늘함과 안색, 시대별 한량 계층, 돈 잘 쓰고 노는 사람은 양·상태·역사적 신분·행동 인물이다. |
| 한려 | w366580-s1, w502979-s1 | KEEP all listed meanings — 우아하고 고움과 명나라 사람의 자손 중 제례 관리 역할은 성질과 역사적 직분이다. |
| 한려하다 | w366581-s1, w502978-s1 | KEEP all listed meanings — 우아하고 고운 성질과 사납고 고약한 성질은 평가 방향이 다르다. |
| 한로 | w367196-s1, w367197-s1, w367197-s2 | KEEP all listed meanings — 육상 도로, 절기, 늦가을·초겨울의 이슬은 공간·달력·기상 현상이다. |
| 한뢰 | w367199-s1, w367200-s1 | KEEP all listed meanings — 맑은 하늘의 천둥과 겨울 한랭 전선 때의 천둥은 발생 조건이 다르다. |
| 한류 | w360192-s1, w518834-s1 | KEEP all listed meanings — 차가운 해류와 한국 대중문화의 해외 유행은 물리적 흐름과 사회 현상이다. |
| 한리 | w372211-s1, w372212-s1 | KEEP all listed meanings — 사나운 벼슬아치와 한랭·습기로 생긴 이질은 사람과 질병이다. |
| 한림 | w372213-s1, w372213-s2, w505721-s1, w505721-s2, w505721-s3, w505721-s4, w505721-s5, w505721-s6 | KEEP all listed meanings — 겨울 숲·묘지 숲, 시대·기관별 문서 관직, 유학자 모임, 관아는 자연·장소·직위·모임·기관이다. |
| 한림박사 | w365743-s1, w365743-s2 | KEEP all listed meanings — 고려의 정사품 문서 담당 벼슬과 당나라 조칙 기초 관직은 시대와 제도가 다르다. |
| 한림원 | w505393-s1, w505393-s2, w505393-s3 | KEEP all listed meanings — 고려의 문서 담당 관아, 조선의 사명 작성 관아, 당나라의 조서 기초 관아는 역사적 기관이 다르다. |
| 한림주인 | w365746-s1, w365746-s2 | KEEP all listed meanings — 고려의 정사품 조서 담당 벼슬과 당나라 한림원 관직은 시대별 직분이다. |
| 한림학사 | w505394-s1, w505394-s2 | KEEP all listed meanings — 고려의 정사품 조서 담당 벼슬과 당나라 조칙 기초 관직은 시대별 직분이다. |
| 한마 | w365749-s1, w365749-s2, w365751-s1 | KEEP all listed meanings — 달려 땀이 밴 말, 빠르게 달리는 말, 사나운 말은 운동 후 상태·속도 능력·성질이다. |
| 한마음 | w505170-s1, w505170-s2, w505170-s3 | KEEP all listed meanings — 하나로 합친 마음, 변함없는 마음, 마음을 우주 본체로 보는 교리는 관계·지속성·철학 개념이다. |
| 한마지로 | w366038-s1, w366038-s2 | KEEP all listed meanings — 전장에서 이긴 공로와 땀이 날 정도의 노역은 성취와 노동이다. |
| 한만 | w366070-s1, w366373-s1, w366374-s1, w366376-s1 | KEEP all listed meanings — 등한함, 기한이 다 참, 한가하고 느긋함, 한국과 만주는 행위·시간·상태·지명이다. |
| 한만하다 | w366071-s1, w366371-s1, w366375-s1, w502486-s1 | KEEP all listed meanings — 등한함, 뚜렷하지 않음, 한가롭고 느긋함, 기한이 다 참은 태도·명료도·여유·시간 종료다. |
| 한만히 | w366072-s1, w366372-s1, w502039-s1 | KEEP all listed meanings — 등한하게, 뚜렷하지 않게, 한가롭고 느긋하게는 태도·명료도·여유의 부사 용법이다. |
| 한말 | w366379-s1, w366380-s1 | KEEP all listed meanings — 한국인이 쓰는 언어와 대한 제국의 마지막 시기는 언어와 역사 기간이다. |
| 한맘 | w502238-s1, w502238-s2, w502238-s3 | KEEP all listed meanings — 세 sense는 서로 다른 한마음 의미의 준말을 가리키므로 각각의 지시 의미를 유지한다. |
| 한맛 | w366381-s1, w366382-s1 | KEEP all listed meanings — 불교 가르침의 본뜻과 덜하거나 더한 때의 맛은 교리적 동일성과 감각적 맛이다. |
| 한망 | w366383-s1, w366384-s1 | KEEP all listed meanings — 짐승·물고기를 잡는 그물과 한가로움·바쁨의 병렬 표현은 물건과 상태다. |
| 한명 | w366078-s1, w366079-s1 | KEEP all listed meanings — 하늘이 정한 목숨과 한자로 된 이름은 생명과 이름이다. |
| 한목소리 | w366702-s1, w366702-s2 | KEEP all listed meanings — 여럿의 실제 목소리와 같은 견해·사상을 비유하는 표현은 소리와 의견이다. |
| 한몫 | w366703-s1, w366703-s2 | KEEP all listed meanings — 사람에게 돌아가는 큰 이득과 맡은 역할은 분배 몫과 책임이다. |
| 한문 | w366722-s1, w366723-s1, w366724-s1, w366724-s2 | KEEP all listed meanings — 막는 문, 가난한 집안, 중국 고전 문장, 한자로만 쓴 글은 건축·가계·문장·표기다. |
| 한문자 | w366727-s1, w505384-s1 | KEEP all listed meanings — 한자라는 문자 체계와 필요 없는 개별 문자는 범주와 불필요한 글자다. |
| 한문학 | w366730-s1, w536191-s1 | KEEP all listed meanings — 한문을 연구하는 학문과 한문으로 된 문학 작품은 연구 분야와 문학이다. |
| 한물 | w367056-s1, w367057-s1, w367057-s2 | KEEP all listed meanings — 수확물의 절정기, 홍수로 불어난 물, 미세기의 조수 흐름은 농산물·하천·조석이다. |
| 한물가다 | w502469-s1, w502469-s2, w502469-s3 | MERGE w502469-s1 + w502469-s2 + w502469-s3 → “채소·과일·어물 따위가 한창 나오는 때가 지나거나 어물 따위가 싱싱한 정도가 떨어지다. 한창때가 지나 기세가 꺾이는 일을 이르기도 한다.” — 농산물·어물의 제철이 지남, 어물의 싱싱함이 떨어짐, 사물의 한창때가 지나 기세가 꺾임은 모두 정점 이후의 쇠퇴를 나타낸다. |
| 한미 | w367063-s1, w367065-s1 | KEEP all listed meanings — 가난하고 지체가 낮음과 한국·미국 병칭은 상태와 국가다. |
| 한민 | w367347-s1, w367347-s2 | KEEP all listed meanings — 직업 없는 백성과 한가한 사람은 사회적 처지와 개인의 여유다. |
| 한민족 | w503636-s1, w503637-s1 | KEEP all listed meanings — 중국의 한족과 한반도의 우리 민족은 민족 집단이 다르다. |
| 한바다 | w367354-s1, w367354-s2 | KEEP all listed meanings — w367354-s1은 실제 바다를, w367354-s2는 바다가 아닌 사물·개념의 넓고 방대한 크기를 비유적으로 가리킨다. 공유된 넓이 이미지만으로 자연 대상과 추상적 비유의 독립 지시 대상을 하나로 만들지 않는다. |
| 한바탕 | w505589-s1, w505589-s2 | MERGE w505589-s1 + w505589-s2 → “크게 벌어진 한 판. 또는 한판 크게 하는 모양.” — 크게 벌어진 한 판과 한판 크게 하는 모양은 한 차례 크게 벌이는 일을 명사·부사로 나타낸다. |
| 한바탕하다 | w367636-s1, w367636-s2 | MERGE w367636-s1 + w367636-s2 → “어떠한 일을 크게 한 번 벌이다. 크게 싸우는 일도 이른다.” — 어떤 일을 크게 한 번 벌이는 것과 크게 한 번 싸우는 것은 같은 행위축의 일반 용례와 구체 용례다. |
| 한반 | w367639-s1, w367640-s1 | KEEP all listed meanings — 먹줄의 가운데 기준선과 땀띠의 한방 명칭은 도구 표시와 피부 질환이다. |
| 한반도 | w367641-s1, w367641-s2 | KEEP all listed meanings — 지리적 반도와 남북한을 함께 가리키는 정치적 표현은 땅과 국가·사회 범주다. |
| 한발 | w367642-s1, w367642-s2, w505591-s1 | KEEP all listed meanings — 가뭄 귀신, 심한 가뭄, 동작 사이의 시간·위치 간격은 설화·기상·부사다. |
| 한밤중 | w505592-s1, w505592-s2 | KEEP all listed meanings — 깊은 밤과 어떤 일을 전혀 모르는 상태의 비유는 시간과 인지 상태다. |
| 한밥 | w367655-s1, w367655-s2, w367656-s1 | KEEP all listed meanings — 누에의 마지막 먹이, 배부르게 먹는 음식, 끼니 뒤늦게 차린 밥은 대상과 식사 시점이 다르다. |
| 한방 | w367658-s1, w367658-s2, w367659-s1, w367659-s2 | KEEP all listed meanings — 같은 방·온 방과 한방 의술·한의 처방은 공간과 의료다. |
| 한배 | w364861-s1, w364861-s2, w364862-s1, w364863-s1, w364863-s2, w508694-s1, w518512-s1 | MERGE w364863-s1 + w364863-s2 → “등에 땀이 남. 부끄럽거나 무서워서 땀이 등을 적시는 일도 이른다.” — 등에 땀이 나는 것과 부끄럽거나 무서워 땀이 등을 적시는 것은 같은 신체 현상이며, 뒤는 원인을 구체화한다.<br>KEEP w364861-s1, w364861-s2, w364862-s1, w508694-s1, w518512-s1 — 같은 태에서 남과 동복의 낮춤말, 국악의 빠르기, 등에 땀, 단군 존칭, 같은 배는 친족·음악·신체·종교·운송이다. |
| 한배하다 | w364864-s1, w364864-s2 | MERGE w364864-s1 + w364864-s2 → “등에 땀을 흘리다. 부끄럽거나 무서워서 땀이 등을 적시는 일도 이른다.” — 등에 땀을 흘리는 동작과 부끄럽거나 무서워 등에 땀이 나는 동작은 같은 신체 현상이며, 뒤는 원인을 구체화한다. |
| 한백미 | w364867-s1, w364867-s2 | KEEP all listed meanings — 잡것을 고르지 않은 보통의 좋은 쌀과 국내산 백미는 선별 상태와 산지를 기준으로 한다. |
| 한번 | w508814-s1, w508814-s2, w508814-s3, w508814-s4, w508814-s5 | KEEP all listed meanings — 과거의 시점·기회, 시험 삼아 함, 기회 있는 때, 강조, 일단 한 차례는 문장 기능과 시간 해석이 다르다. |
| 한부 | w502146-s1, w502353-s1 | KEEP all listed meanings — 사나운 여자를 낮잡는 말과 궁녀의 출입 표찰은 사람과 물건이다. |
| 한불 | w367567-s1, w367567-s2 | KEEP all listed meanings — 한국·프랑스 병칭과 한국어·프랑스어 병칭은 국가와 언어다. |
| 한비 | w367845-s1, w367846-s1, w367847-s1, w498662-s1 | KEEP all listed meanings — 겨울 비료, 비증, 높이 날기, 법가 사상가 한비는 농업·질병·동작·인물이다. |
| 한비자 | w367851-s1, w498663-s1 | KEEP all listed meanings — 한비의 존칭과 한비가 지은 책은 사람과 저작이다. |
| 한사 | w367592-s1, w367867-s1, w367868-s1, w367870-s1, w368180-s1, w368181-s1, w368182-s1 | KEEP all listed meanings — 억울한 죽음·한스러운 일·죽을 각오·가난한 선비·이질·쓸데없는 일·신라 관등은 감정·행위·사람·병·평가·직위다. |
| 한사업 | w367904-s1, w367904-s2 | KEEP all listed meanings — 급하지 않은 사업과 필요하지 않은 사업은 시간상 긴급성과 필요성이 다르다. |
| 한사하다 | w367593-s1, w367869-s1 | KEEP all listed meanings — 억울하게 죽는 것과 죽기를 각오하는 것은 결과와 의지다. |
| 한산 | w367905-s1, w367905-s2, w368186-s1, w368187-s1, w368189-s1, w368192-s1, w502378-s1, w502378-s2 | KEEP all listed meanings — 생산·산아 제한, 당나라 승려, 빈곤, 한량·산관, 백제 도읍, 서로 다른 두 병증은 정책·인물·상태·관직·지명·질병이다. |
| 한산 습득 | w498818-s1, w498818-s2 | KEEP all listed meanings — 선화의 그림 주제와 한산·습득 두 대사는 작품의 도상과 인물 집합이다. |
| 한산꾼 | w368193-s1, w368193-s2 | KEEP all listed meanings — 일이 없어 한가한 상태와 게으름을 낮잡는 성격 평가는 활동 여부와 태도가 다르다. |
| 한산하다 | w367906-s1, w367906-s2, w368188-s1, w502379-s1, w502379-s2 | KEEP all listed meanings — 생산 제한과 출산 제한은 대상 분야가 다르고, 빈곤·한가함·인적 드문 장소도 구별된다. |
| 한산히 | w368191-s1, w368191-s2 | KEEP all listed meanings — 일이 없어 한가한 상태와 인적이 드물어 쓸쓸한 장소는 상황과 공간 분위기가 다르다. |
| 한살되다 | w368534-s1, w498831-s1, w498831-s2 | KEEP all listed meanings — 원한으로 죽임을 당함과 물건이 붙거나 남녀가 결합함은 죽음·물체 결합·혼인이다. |
| 한살이 | w368537-s1, w368537-s2 | KEEP all listed meanings — 출생부터 죽음까지의 생애와 곤충의 알부터 성충까지의 변태 한 주기는 기간과 생물 발달 과정이다. |
| 한삼 | w364400-s1, w364400-s2, w368538-s1, w498832-s1 | KEEP all listed meanings — 손을 가리는 소매 덧댐과 속적삼, 심마니 행보 단위, 식물은 의복·계량·생물이다. |
| 한색 | w364411-s1, w502589-s1 | KEEP all listed meanings — 막아 가림과 차가운 느낌의 색은 행위와 색상 분류다. |
| 한생 | w364414-s1, w364414-s2, w364693-s1, w502591-s1 | KEEP all listed meanings — 가난한 선비, 선비의 겸칭, 소설 인물, 한평생은 사회적 처지·화자 표현·인물·시간이다. |
| 한서 | w364423-s1, w364423-s2, w364998-s1, w364998-s2, w364999-s1 | MERGE w364423-s1 + w364423-s2 → “추위와 더위, 겨울과 여름을 아울러 이르는 말.” — 추위·더위와 겨울·여름은 한 해의 양극인 계절과 기후를 함께 나타내는 같은 의미축이다.<br>KEEP w364998-s1, w364998-s2, w364999-s1 — 추위·더위와 겨울·여름은 한 해의 양극인 계절과 기후를 함께 나타내는 같은 의미축이다. |
| 한선 | w365003-s1, w365004-s1, w365004-s2, w365004-s3 | KEEP all listed meanings — 땀샘과 가을·울지 않는 매미 및 특정 매미 종은 기관과 곤충이다. |
| 한설 | w365005-s1, w365006-s1 | KEEP all listed meanings — 복통·설사를 동반하는 질병과 차가운 눈은 질병과 기상 현상이다. |
| 한성 | w499025-s1, w499026-s1, w499026-s2, w499026-s3, w499026-s4 | KEEP all listed meanings — 약재의 찬 성질, 백제·고구려의 서로 다른 도읍, 조선의 관아, 서울의 옛 이름은 성질·지명·행정기관이다. |
| 한세상 | w362441-s1, w362441-s2 | KEEP all listed meanings — 한평생과 잘사는 한때는 생애 전체와 전성기다. |
| 한센 | w363312-s1, w363313-s1, w363314-s1 | KEEP all listed meanings — 나병균을 발견한 노르웨이 의학자, 미국 경제학자, 덴마크 소설가는 서로 다른 인물이다. |
| 한센인 | w514752-s1, w514752-s2 | MERGE w514752-s1 + w514752-s2 → “나병균을 발견한 한센의 이름에서 유래하여 ‘나환자’를 달리 이르는 말. 한센병에 걸린 사람이나 한센병에 걸렸다가 완치된 사람을 이르기도 한다.” — 나환자를 달리 이르는 명칭과 한센병 환자·완치자는 같은 사람 범주이며, 병원균 발견자의 이름이라는 어원도 보존했다. |
| 한소 | w363316-s1, w501546-s1 | KEEP all listed meanings — 가뭄으로 인한 소동과 한적한 장소는 사건과 공간이다. |
| 한소끔 | w363321-s1, w363321-s2 | MERGE w363321-s1 + w363321-s2 → “일정한 정도로 한 차례 진행되는 모양. 물 따위가 한 번 끓어오르는 모양도 이른다.” — 일정한 정도로 한 차례 진행되는 모양과 물이 한 번 끓어오르는 모양은 같은 한 차례 진행의 일반·조리 용례다. |
| 한소하다 | w363317-s1, w363320-s1 | KEEP all listed meanings — 가난하고 검소한 상태와 차분하고 꾸밈없는 성질은 경제 형편·생활 태도·인상이다. |
| 한속 | w365025-s1, w365025-s2, w365026-s1, w499029-s1 | KEEP all listed meanings — 같은 마음·셈속, 한족의 풍속, 추울 때의 소름은 의도·문화·신체 반응이다. |
| 한수 | w365613-s1, w365614-s1, w365614-s2, w365615-s1, w365616-s1, w365616-s2, w365617-s1, w365618-s1, w502773-s1, w502774-s1 | MERGE w365614-s1 + w365614-s2 → “차가운 물. 한중(寒中) 때의 물을 이르기도 한다.” — 차가운 물과 한중 때의 물은 같은 물의 냉한 상태이며, 뒤는 시기를 구체화한다.<br>KEEP w365613-s1, w365615-s1, w365616-s1, w365616-s2, w365617-s1, w365618-s1, w502773-s1, w502774-s1 — 가뭄·홍수, 변변찮은 찬 음식, 국내 한강과 큰 강, 중국 한수이강, 코골이, 기침, 고려 문신은 기상·음식·서로 다른 지리·신체·인물이다. |
| 한수석 | w365620-s1, w365620-s2 | KEEP all listed meanings — 결정질 석회암인 대리석과 석고·방해석 광물은 구성 광물과 용도가 다른 돌이다. |
| 한술 더 뜨다 | w524749-s1, w524749-s2 | KEEP all listed meanings — 잘못을 더하는 부정적 행위와 남의 생각을 미리 헤아려 대처하는 준비는 평가 방향과 행동이 다르다. |
| 한술 밥에 배부르랴 | w524748-s1, w524748-s2 | MERGE w524748-s1 + w524748-s2 → “어떤 일이든 단번에 만족할 수 없으며, 힘을 조금 들이고 많은 효과를 기대할 수 없다는 말.” — 단번에 만족할 수 없다는 풀이와 적은 힘으로 큰 효과를 기대할 수 없다는 풀이는 적은 양·노력으로 큰 만족을 바라기 어렵다는 같은 속담 뜻이다. |
| 한숨 | w365942-s1, w499708-s1, w499708-s2 | KEEP all listed meanings — w365942-s1은 길게 몰아 내쉬는 숨, w499708-s1은 숨 한 번 쉴 동안의 시간 간격, w499708-s2는 잠깐의 휴식이나 잠이라는 사건을 가리킨다. 짧은 기간이라는 공통점만으로 시간량과 휴식·수면 행위를 합치지 않는다. |
| 한습 | w365964-s1, w499895-s1, w499895-s2 | KEEP all listed meanings — 가축의 한 살과 한사·습사 및 냉습 병증은 나이와 병리 개념이다. |
| 한시 | w366256-s1, w366256-s2, w366257-s1, w499896-s1, w499896-s2 | KEEP all listed meanings — 정형 한시, 한나라 때 시, 한영이 전한 시경, 같은 시각, 짧은 시간은 문학 양식·역사 문헌·시간이다. |
| 한시(가) 새롭다 | w532863-s1, w532863-s2, w532863-s3 | KEEP all listed meanings — 시간의 긴요함·아쉬움, 짧은 시간이 괴롭게 느껴짐, 사물 변화의 두드러짐은 정서와 관찰 평가가 다르다. |
| 한식 | w366603-s1, w366604-s1, w366605-s1, w502981-s1 | KEEP all listed meanings — 국사에 골몰해 늦게 먹음, 절기 명절, 한국 고유 양식, 음식·식사는 행위·날짜·양식·먹거리다. |
| 한식집 | w366909-s1, w502982-s1 | KEEP all listed meanings — 한국 고유 형식의 건축물과 한식을 파는 식당은 건물 양식과 업종이다. |
| 한실 | w502983-s1, w502983-s2 | KEEP all listed meanings — 조용하고 한적한 방과 필요하지 않은 방은 정서·환경과 필요 여부다. |
| 한아 | w366919-s1, w366920-s1 | KEEP all listed meanings — 까마귓과 새와 추위·굶주림은 동물과 곤궁한 상태다. |
| 한아스럽다 | w505889-s1, w505889-s2 | KEEP all listed meanings — 한가롭고 아담한 인상과 조용하고 품위 있는 인상은 닮은 차분함을 지니지만 크기·여유와 품위의 뉘앙스를 구별했다. |
| 한아스레 | w372484-s1, w372484-s2 | KEEP all listed meanings — 한가롭고 아담한 모양과 조용하고 품위 있는 모양은 차분함을 공유하나 표현되는 인상 차이를 유지했다. |
| 한아하다 | w363748-s1, w363748-s2 | KEEP all listed meanings — 한가롭고 아담함과 조용하고 품위 있음은 비슷한 우아함을 띠지만 강조하는 성질이 다르다. |
| 한아히 | w364016-s1, w364016-s2 | KEEP all listed meanings — 한가롭고 아담한 모양과 조용하고 품위 있는 모양은 닮았지만 각 수식 의미의 차이를 보존했다. |
| 한안 | w361563-s1, w361563-s2 | KEEP all listed meanings — 땀이 밴 얼굴과 썩 부끄러워하는 얼굴은 신체 상태와 감정 표현이다. |
| 한양 | w361570-s1, w361572-s1, w361573-s1, w505713-s1 | KEEP all listed meanings — 한가로운 휴양, 서울의 옛 이름, 중국 우한의 한 구, 양 품종은 활동·서로 다른 지리·동물이다. |
| 한양가 | w505714-s1, w505714-s2 | KEEP all listed meanings — 조선 후기의 장편 가사와 대한 제국기의 창가는 제목·저자·시기·형식이 다른 작품이다. |
| 한어 | w365772-s1, w365774-s1, w505171-s1 | KEEP all listed meanings — 공격을 막음, 중국 한족의 언어, 한국어는 행위와 서로 다른 언어다. |
| 한언 | w365780-s1, w365780-s2 | KEEP all listed meanings — 천천히 조용히 말하는 방식과 한가할 때 나누는 시시한 이야기는 발화 방식과 대화 내용이다. |
| 한여름 밤의 꿈 | w366062-s1, w366062-s2 | KEEP all listed meanings — 셰익스피어의 희곡과 그 작품에 붙인 멘델스존의 관현악곡은 같은 제목을 공유하는 별도 저작이다. |
| 한역 | w366063-s1, w366081-s1, w366084-s1 | KEEP all listed meanings — 추위로 유행하는 전염병, 한문 번역, 한국어 번역은 질병과 반대 언어 방향이다. |
| 한역되다 | w366082-s1, w366085-s1 | KEEP all listed meanings — 한문으로 옮김과 한국어로 옮김은 번역의 대상 언어가 다르다. |
| 한역하다 | w366083-s1, w366086-s1 | KEEP all listed meanings — 한문으로 옮김과 한국어로 옮김은 번역의 대상 언어가 다르다. |
| 한열 | w366088-s1, w502242-s1 | KEEP all listed meanings — 질병 때 번갈아 나타나는 한기와 열, 가뭄 때 심한 더위는 증상과 기상 현상이다. |
| 한영 | w502244-s1, w502244-s2 | KEEP all listed meanings — 한국·영국 국가 병칭과 한국어·영어 언어 병칭은 대상 종류가 다르다. |
| 한온 | w502247-s1, w502247-s2 | KEEP all listed meanings — 날씨의 온도 변화와 주인·손님의 인사말은 자연 현상과 대화다. |
| 한와 | w366113-s1, w366113-s2, w502248-s1 | KEEP all listed meanings — 한가로이 눕는 자세와 세속을 떠나 편안히 사는 생활은 순간 행위와 생활 방식이다. |
| 한와하다 | w366414-s1, w366414-s2 | KEEP all listed meanings — 한가로이 눕는 행위와 속세를 떠나 묻혀 사는 삶은 행위와 생활 방식이다. |
| 한용하다 | w366749-s1, w366751-s1 | KEEP all listed meanings — 사납고 용맹함과 일이 없어 한가함은 성품과 상태다. |
| 한우 | w366753-s1, w366754-s1, w366754-s2, w366755-s1 | MERGE w366754-s1 + w366754-s2 → “차갑게 느껴지는 비. 겨울에 내리는 비를 이르기도 한다.” — 차갑게 느껴지는 비와 겨울에 내리는 비는 같은 냉한 계절 강수의 의미축이다.<br>KEEP w366753-s1, w366755-s1 — 땀띠의 한방 명칭, 냉한 비의 용례, 한우 품종은 질병·강수·가축이다. |
| 한운 | w366758-s1, w366759-s1, w366760-s1 | KEEP all listed meanings — 가뭄 때 구름, 겨울 구름, 한가로이 떠도는 구름은 기상 조건과 시적 상태가 다르다. |
| 한울 | w366761-s1, w366761-s2 | KEEP all listed meanings — 천도교에서 우주의 본체를 가리키는 교리 개념과 하늘의 다른 이름은 지시 범위가 다르다. |
| 한월 | w367357-s1, w367358-s1, w367358-s2, w367359-s1, w503638-s1 | MERGE w367358-s1 + w367358-s2 → “겨울의 달. 차가워 보이는 달을 이르기도 한다.” — 겨울의 달과 차가워 보이는 달은 겨울의 차가운 달 이미지를 가리킨다.<br>KEEP w367357-s1, w367359-s1, w503638-s1 — 청산 거래의 결제 월, 은하수와 밝은 달, 농한기는 겨울의 달과 구별되는 시간·천체·농사 시기다. |
| 한위 | w367360-s1, w367360-s2, w503639-s1 | KEEP all listed meanings — 한의 지위, 우두머리의 비유적 호칭, 심한 추위는 직위·사람 호칭·기후다. |
| 한위총서 | w503640-s1, w533571-s1 | KEEP all listed meanings — 정영이 편찬한 총서와 하당이 펴낸 별도 총서는 편찬자와 수록 체계가 다른 책이다. |
| 한유 | w367367-s1, w503641-s1 | KEEP all listed meanings — 한가로이 노니는 행위와 당나라 문인 한유는 행동과 인물이다. |
| 한유하다 | w367363-s1, w367365-s1, w367368-s1 | KEEP all listed meanings — 드물게 있음, 한가롭고 여유 있음, 한가로이 노님은 희소성·상태·행동이다. |
| 한음 | w367372-s1, w367374-s1, w503642-s1 | KEEP all listed meanings — 한가로이 시를 읊음, 이덕형의 호, 한자의 중국식 발음은 행위·인물 호칭·음운이다. |
| 한의 | w367376-s1, w367376-s2, w367377-s1, w367653-s1, w367661-s1, w367661-s2 | KEEP all listed meanings — 땀이 밴 옷, 땀받이 속옷, 하늬바람의 한자 표기, 옷을 빪, 한의술, 한의사는 옷·바람·세탁·의술·직업이다. |
| 한의약 | w367665-s1, w367665-s2 | KEEP all listed meanings — 한방에서 쓰는 약과 한의·한약의 총칭은 구체 약재와 의료 분야·약물 범주다. |
| 한인 | w367702-s1, w367703-s1, w505376-s1, w505376-s2, w505377-s1, w505377-s2, w505377-s3 | KEEP all listed meanings — 한족, 해외 거주 한국인, 동정심이 많은 사람, 한이 많은 사람, 한가한 사람, 고려·조선의 서로 다른 무인층은 민족·이주·성격·역사적 신분이다. |
| 한일 | w365150-s1, w365151-s1, w365155-s1, w365155-s2, w367683-s1 | KEEP all listed meanings — 기한으로 정한 날, 한가한 날, 한국·일본, 양국 언어, 한자 부수 一은 시간·국가·언어·문자다. |
| 한일모 | w365158-s1, w365158-s2 | MERGE w365158-s1 + w365158-s2 → “날이 저물 때까지로 한정함. 또는 날이 저물 때까지.” — 날이 저물 때까지를 한정하는 일과 같은 시간 한계를 부사적으로 나타내는 풀이는 문법적 틀만 다르다. |
| 한일월 | w372505-s1, w372505-s2 | KEEP all listed meanings — 한가한 시기와 여유 있는 마음은 시간과 심리 상태다. |
| 한입 | w367556-s1, w367556-s2, w367556-s3 | KEEP all listed meanings — 음식이 가득 찬 입, 한 번 벌린 입, 여러 사람이 같은 말을 함은 상태·동작·비유다. |
| 한자 | w367304-s1, w367305-s1, w367306-s1, w502354-s1 | KEEP all listed meanings — 남자를 낮잡는 말, 한유의 존칭, 한비의 저작, 중국 표의 문자는 인물·책·문자 체계다. |

## Direct glosses and unresolved source references

Opaque cross-references were replaced only when their exact target was available in committed canonical projections. The direct glosses preserve the target source definitions:

- w365617-s1 (한수): source “→ 한수이강.”; direct gloss “중국 양쯔강(揚子江)의 지류. 산시성(陝西省) 서남쪽, 친링산맥(秦嶺山脈)에서 시작하여 한중(漢中)을 지나 후베이성(湖北省) 한커우(漢口)에서 양쯔강으로 흘러든다. 길이는 1,532km.”.
- w367377-s1 (한의): source “→ 하늬. ‘하늬’를 한자를 빌려서 쓴 말이다.”; direct gloss “서쪽에서 부는 바람. 주로 농촌이나 어촌에서 이르는 말이다.”.
- w368700-s1 (한꺾기): source “→ 한것기.”; direct gloss “조수(潮水)의 썰물과 밀물의 차를 헤아릴 때, 음력 닷새와 스무날을 이르는 말.”.
- w360240-s1 (한나산): source “→ 한라산.”; direct gloss “제주특별자치도 중앙에 있는 산. 참나무·산벚나무·단풍나무 따위의 식물이 자라며, 명승지로 삼성혈·백록담 따위가 있다. 국립 공원의 하나이다. 높이는 1,950미터.”.
- w368172-s1 (한데솥): source “→ 한뎃솥.”; direct gloss “한뎃부엌에 걸어 놓은 솥.”.
- w364720-s1 (한등격리산): source “→ 한텡그리산.”; direct gloss “중국 신장 웨이우얼 자치구(新疆維吾爾自治區) 서쪽 끝에 있는 산. 톈산산맥(天山山脈)에서 두 번째로 높은 산이다. 높이는 6,995미터.”.

These references remain explicitly unresolved rather than guessed:

- w365752-s1 (한마니): “→ 할머니_.” — target “할머니_” is not a committed canonical entry, so its precise sense remains unresolved.
- w502360-s1 (한데): “‘’의 뜻을 나타내는 말.”에는 인용된 지시 대상이 비어 있어, 대체 gloss를 추측하지 않았다.

## Review provenance

The source-bound census, decisions, and gloss checks were performed in the primary agent context. This is agent self-check, not an independent first/second review or human editorial approval. Issue #716 independent PR review stages remain separate and required.

### Stage 2 review follow-up — 2026-10-16

Stage 2 review identified independent referents in 한바다 (literal sea vs. non-sea objects described metaphorically) and 한숨 (time interval vs. rest or sleep event). Their MERGE edits were removed and the four original singleton meaning rows restored; no canonical sense reference was changed or dropped. I rechecked the remaining 19 MERGE source groups against their committed canonical glosses for a merge based only on a shared image or short duration. No additional group met that condition: the remaining cold-weather and moon/water/rain cases refer to a shared object and cold-state axis, while the other groups retain their documented same-axis, example, or grammatical-framing rationale.

## Validation

`node scripts/meaning/validate.mjs` passed with 496,959 meanings and 117 adjudications. `git diff --check` passed. The shard has 979 meanings and retains all 1,003 canonical sense references; C19 has 33,360 meanings. No DROP or adjudication change was added, and canonical files remain unchanged.
