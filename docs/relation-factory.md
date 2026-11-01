# Relation Factory v1

Typewriter 관계 제작은 **후보 발굴 → Stage 2 최종 편집·승인 → Stage 3 독립 감사·교정 → DB 빌드**로 분리한다. STDICT Canonical JSONL처럼 생성한 **Candidate JSONL을 영구 보관**하고, 이후 원본 문학·말뭉치 DB를 다시 검색하지 않고 Relations를 편집한다. 편집 기준은 [relation-editorial-policy.md](relation-editorial-policy.md)를 따른다.

**1회성 전체 초기화 (오너 결정, Issue #1154):** 영구 보관·소급 수정 금지 원칙의 유일한 예외로, 오너가 기존 생산 데이터를 `candidate` 브랜치(2af4d21a)에 보관한 뒤 구형 A/B/C/D 정식 Candidate 236개, 승인 authored Relation, Drop 판정을 모두 삭제했다. A/B/C/D 모든 방식의 진행 위치는 `001_01`부터 재시작하며(A/B는 모델별, C/D는 방식별 공유 진행 위치 유지), 구형 Relation/Drop은 새 후보 생산 후 Stage 2에서 다시 판정한다. 초기화 이후 머지된 Candidate에는 영구 보관 원칙이 다시 적용된다.

```text
Stage 1 — Candidate Generation: A / B / C / D 독립 병렬 생산
    → data/relation-candidates/<shard>/<shard>_<batch>_<method>_<model>.jsonl
Stage 2 — Relation Admission: 후보 통합 → 채택/제외 → 타입/Tier/대상 확정
    → 승인 Relations / Drops JSONL (샤드 단위)
Stage 3 — Relation Editorial Refinement (#2455, 구현됨): 독립 감사 / Drop / Link Repair
    → 기존 Relation / Drop JSONL을 직접 수정 (추가 edit 파일 없음)
pnpm run build: Canonical + 최종 Relations → Full / Lite SQLite
```

**A/B/C/D는 생성 방법의 이름이며 Stage 번호가 아니다.** A와 B는 합쳐서 실행하지 않는다. C와 D도 앞 단계 결과를 누적하거나 수정하지 않는다. Stage 1 후보에는 타입·Tier·승인 상태·대상 ID가 없고, Stage 2는 새로운 후보를 탐색하지 않는다.

## 1. 범위와 파일

기존 `data/canonical/stdict-0001.jsonl` ~ `stdict-0428.jsonl`의 **428개 샤드, 427,583레코드**를 그대로 사용한다. 샤드마다 Canonical **500레코드(행)씩** 배치로 분할한다. sense 500개 단위가 아니다. 동음이의어 record는 구분하고, 한 record의 모든 sense는 함께 처리한다.

- 샤드 001~427: 각각 1,000레코드 → 배치 `01`(Canonical 1~500행), `02`(501~1000행).
- 샤드 428: 583레코드 → 배치 `01`(500레코드), `02`(마지막 83레코드).
- 총 **856개 배치**. 순서는 샤드 번호 → 샤드 내 Canonical 행 위치다. record ID가 연속된다는 가정은 하지 않는다.

```text
data/relation-candidates/
  001/
    001_01_a_codex.jsonl
    001_01_a_claude.jsonl
    001_01_b_codex.jsonl
    001_01_b_claude.jsonl
    001_01_c_codex.jsonl
    001_01_d_codex.jsonl
    001_01_a_deepseek.jsonl  # 선택
    001_01_b_deepseek.jsonl  # 선택
    001_02_a_codex.jsonl
    ...
  002/
    ...
  428/
    ...
```

경로 계약: `data/relation-candidates/<SSS>/<SSS>_<BB>_<method>_<model>.jsonl`. 샤드 3자리, 배치 2자리(`01`/`02`), method는 `a|b|c|d`, model은 실행한 모델 이름의 소문자 식별자. **A/B는 500레코드 배치·방식·모델당 하나의 파일**, **C/D는 모델을 가리지 않고 500레코드 배치·방식당 하나의 파일**을 허용한다. 실제 생산 모델은 파일명에 남긴다. 배치별 하위 폴더는 만들지 않는다. **War Room 정식 Stage 1 생산은 지정된 배치·방식·모델의 Candidate 파일 하나를 PR 하나로 제출**하고, Stage 2는 `(shard, batch, part)`마다 PR 하나를 제출한다. 이는 기존 파일 형식이나 별도 수정 PR의 범위를 바꾸지 않는다.

## 2. Stage 1 — Candidate Generation

| 방식 | 후보 발굴 방법 | 생산자 |
| --- | --- | --- |
| **A** | 정확한 Canonical sense/뜻풀이에서 직접 생성 | Codex, Claude |
| **B** | 출발 sense에 맞는 가상 장면을 구성하고 후보 추출 | Codex, Claude |
| **C** | 기존 문학 SQLite의 실제 문맥 참조 — 상세 절차 [#1155](https://github.com/neverworkalone/typewriter/issues/1155) | 배치별 오너 지정 Codex·Claude·DeepSeek 중 한 모델 |
| **D** | 기존 문어 말뭉치 SQLite의 실제 문맥 참조 — 상세 절차 [#1156](https://github.com/neverworkalone/typewriter/issues/1156) | 배치별 오너 지정 Codex·Claude·DeepSeek 중 한 모델 |

- **A와 B는 같은 모델에서도 서로 다른 작업/턴**으로 수행한다. 생산자는 다른 방식·모델의 후보를 읽거나 참조하지 않는다. C와 D 역시 서로 독립적이며, **각 배치의 실제 생산 모델(Codex/Claude/DeepSeek)은 오너가 지정**한다. C/D 완료 여부는 생산 모델에 관계없이 방식별로 공유한다.
- **DeepSeek A/B**는 오너가 필요하다고 판단할 때 해당 배치·방식에만 추가한다. 추가하지 않은 파일은 미실행이며 `candidates: []`가 아니다.
- 출발 sense를 정확하게 결속하고, 문학/말뭉치 검색은 해당 자료 이용 조건에 맞게 읽기 전용으로 수행한다. C/D는 원문·발췌문·SQLite를 Git/PR/제품에 포함하지 않는다.
- 생성 단계에는 채택 개수 목표가 없다. 적합한 후보가 없으면 빈 목록을 그대로 기록한다. **500레코드는 내부적으로 나눠 처리해도 되지만, 최종 후보 파일은 해당 배치 전체를 포함하는 한 파일**이어야 한다.

### A/B batch workbench

A and B producers must use [`scripts/relation/candidate-workbench.mjs`](../scripts/relation/candidate-workbench.mjs) for Canonical chunk reads, whole-chunk Candidate saves, local correction, and the final Candidate v1 validation. It keeps no exploration/review receipts and does not perform semantic discovery or judgment: A follows #860's one comprehensive meaning exploration with an optional second exploration only for a worthwhile unexplored semantic direction, while B follows #860's single-scene exploration procedure. Use the [A/B Candidate workbench manual](relation-candidate-workbench.md) for the shortest CLI path. C production uses its method-specific literary-context CLI; D follows #1156's read-only 25-record chunk direct-search workflow without a dedicated Workbench CLI.

### A/B/C/D 공통 후보 표현 단위 — Stage 1 필수 생산 계약

**가능한 연상은 넓게 보존하되, 쉽게 식별되는 불필요한 형태 변이·파생·반복과 뜻풀이 복사·위장 서술구는 Stage 1에서 제외한다.** Stage 1은 작가가 연상할 수 있는 **독립 단어·어휘와 출발 의미에서 확장된 짧은 장면·심상·감각 표현**을 수집한다. 출발 sense에 설명 가능한 연결이 있다면 익숙한 단어, 느슨한 간접 연상, 다른 품사, 의외의 사물·감각·행동을 후보로 남겨 Stage 2가 가치를 판단하도록 한다. 반대로 단어 몇 개로 후보 수를 맞추는 할당량도 없고, 후보 수를 줄이는 것이 목표도 아니다.

| 후보의 형태 | 모든 A/B/C/D 생산자의 출력 규칙 |
| --- | --- |
| **독립 단어·어휘 항목** | 폭넓게 허용. 연상의 강함·Tier·개인적 취향을 이유로 미리 삭제하지 않는다. 단, 출발 sense와 설명 가능한 연결 및 독립된 어휘 항목이어야 한다. |
| **출발 표제어와 후보의 양방향 부분 문자열 포함** | **Stage 1에서 예외 없이 제외한다.** 공백·하이픈을 제거해 비교했을 때 출발 lemma가 후보에 포함되거나 후보가 lemma에 포함되면 무조건 금지한다. 별도 사전 표제어·서로 다른 개념·동음이의어·독립적인 심상·작가에게 쓸모 있는 표현인지 여부도 예외가 아니다. `개→개집`, `반송→반송파`, `눈→눈빛`, `불→불씨`, `꽃→꽃말`, `마흔→마흔 살`, `반자동→반자동식` 모두 제외한다. |
| **명백한 불필요 형태·파생·반복** | Stage 1 제외 사례: `깜빡대다 → 깜빡이다`(단순 어미·표현 변이), `건축 → 건축가`(분야→직업인 파생), `조퇴하다 → 조퇴`(동일 개념의 명사화), `팔딱하다 → 팔딱팔딱`(독립 효용 없는 반복). **위 양방향 부분 문자열 포함을 제외하면**, 동일 어근·접미사·형태 유사성만으로 기계적 일괄 삭제는 금지한다. `어정대다 → 낙타`처럼 의미·연상 가치 판단이 필요한 관계는 Stage 1에서 제외하지 않고 Stage 2에 전달한다. |
| **짧은 구·관용구·여러 어절 또는 붙여 쓴 복합 표현** | **검사 목적은 단순 뜻풀이 재서술·가짜 어휘 방지**다. 출발 sense에서 장면·이미지·감각·행동·정서로 의미가 확장되는 간결한 표현은 **흔하고 평범해도 보존**한다(예: `수괘` [서리] → `겨울 아침`, `산뜩` → `가슴 철렁`). 반면 뜻풀이의 속성+범주를 그대로 옮긴 `가는소금 → 하얀 소금`, `가는솜방망이 → 노란 꽃`, 제시어에 단순 수식어를 붙인 `걸음걸이 → 느린 걸음걸이`와 공백만 제거한 위장 구절은 제외한다. **독창성·문학적 우수성·최종 채택 가치는 Stage 2**에서 판단한다. |
| **문장·서술형 절·사건·동작·과정 설명** | **절대 금지, 최종 후보 0개.** 완결형 문장뿐 아니라 `~하다/~되다` 서술절, 문장에서 종결어미를 지운 파편, 사건·절차 설명을 `일/장면/상황/기술` 등으로 포장한 명사구도 금지. `격벽 → 격벽을 여는 데 에너지가 필요하다`, `겅중 → 긴 다리로 뜀`, `검지기 → 누전이 되면 경보가 울린다` 같은 문구를 그대로 출력하지 않는다. 독립된 동사 어휘(`떨다`, `뛰다`) 자체는 문장이 아니다. |
| **출발 lemma 자체·괄호 주석만 붙인 동일 표제어** | **절대 금지**. `공탁 → 공탁(供托)` 같은 표기 반복은 별도 어휘가 아니다. |

**생산 방법별 적용:** A는 Canonical 뜻풀이를 더 짧은 설명 문구로 바꾸지 말고 **실제 다른 어휘**를 발굴한다. B는 상상한 **장면의 서술문 자체를 제출하지 않고**, 거기서 **사람·사물·감각·행동 등을 나타내는 독립 단어와 간결한 장면·심상 표현**을 추출한다. 장면을 여는 짧은 표현은 B 방식의 정당한 결과이며, 표현이 평범하다는 이유로 제거하지 않는다. C/D는 VERIFIED된 정확한 source sense의 실제 원문에서 단어·짧은 비서술적 심상을 발굴하며, 원문 문장이나 사건을 Candidate로 복사하지 않는다. 전 방법에서 출발 표제어와 후보 사이에 **양방향 부분 문자열 포함이 있으면 독립 단어·구 여부나 표현 가치와 관계없이 모두 제외**한다. 포함 관계가 없는 나머지 단어·구는 무익한 형태 변이·뜻풀이 재서술인지 개별 검토한다. **간결한 장면·감각 확장은 Stage 1에서 문학적 가치나 독창성으로 가지치기하지 않는다.**

**부분 문자열·동일 어근 후보의 이중 점검(생산자 + 1차 PR 리뷰어):** 현재 배치의 각 Canonical 표제어와 해당 Sense 후보 사이에 **어느 한쪽이 다른 쪽에 포함되는 경우를 양방향으로 모두 추출**한다(검출 시 공백·하이픈을 제거한다). **양방향 포함 일치가 한 건이라도 있으면 예외 없이 제외**한다. 별도 사전 표제어, 개별 Sense, 다른 개념, 유의어, 연상 가치, 이미지·감정적 효용은 구제 근거가 아니다. 생산자는 제출 전에 이 결과가 **0건**임을 확인하고, 1차 리뷰어는 제출된 Candidate와 Canonical에서 독립적으로 다시 추출해 **0건**임을 확인해야 한다. `개→개집`, `반송→반송파`, `눈→눈빛`, `불→불씨`, `꽃→꽃말`, `마련하다→마련`, `박제하다/박제되다→박제`, `발버둥질→발버둥`, `반자동→반자동식`, `마흔→마흔 살`은 모두 제외한다. 포함관계로 잡히지 않는 `발라드→발라더` 등 공유 어근·어미·접사·표기 유사 파생은 별도로 찾아 기계적인 변이인지 판정한다. **포함관계 금지는 하드 조건**이며, 다른 공유 어근·접사에 대해 일괄 삭제 규칙을 추가하는 것은 아니다. 과거 머지 데이터에 자동 소급 적용하지 않으며, 신규 생산물의 최초 리뷰에서 확인한다. 수정본 재리뷰는 REVIEW.md의 지적 범위 제한을 유지한다.

**제출 전 모든 후보 문자열 전수 형태 검사:** 최종 `senses[].candidates[]`의 모든 원소를 단어 / 제시어 포함 어휘 / 독립적 응축 구 / 문장·서술 설명 / 정확 자기 반복으로 판별하고, **문장·사건 설명 0건, 자기 반복 0건 및 명백한 불필요 형태·파생 관계 0건**을 확인한다. 제외한 긴 문맥에서 근거 있는 다른 단어를 추출할 수 있으면 추출하고, 없으면 문구로 개수를 채우지 않는다. **전수 형태 검사 중 후보마다 공백 제거형이 같은 source sense 뜻풀이의 연속 구간과 맞는지도 대조한다.** 맞는 경우 원뜻풀이와 비교해 단순히 서술형 구를 붙여 쓴 것인지 판별한다. 이 일치는 검토 신호일 뿐 자동 차단 조건이 아니며, sense에 결속되는 독립 단어·독립 동사·어휘화된 합성어는 그 자체로 제외하지 않는다. **출발 lemma ↔ 후보의 양방향 부분 문자열 포함은 별도 하드 금지 규칙이다.** 그 밖의 후보를 공백 수, `-다` 어미, 어근·접사 유사성만으로 자동 허용·차단하지 않는다. A/B Workbench 저장, C 제출/내보내기, D 저장/내보내기는 기존 저장 경로에서 이 새 포함 규칙에 해당하는 후보를 AI 재생성 없이 제거하고, 유효한 다른 후보와 빈 sense를 보존한다. 기존의 다른 객관적 Candidate 내용 검사는 계속 적용하며, 표현 가치·무익한 파생·뜻풀이 재서술 같은 판단은 생산자와 초기 Stage 1 리뷰어가 맡는다. 공통 Candidate v1 제출 validator는 남은 포함 위반을 차단하는 방어선이고, 포함 이외의 문장·뜻풀이 재서술·공유 어근·파생 의미 판단은 보증하지 않는다. 이 새 포함 규칙은 신규 산출물에 적용하며, 과거 머지 데이터나 Stage 2의 기존 Candidate 입력 검증에는 소급하지 않는다. Stage 2는 기존 검증 계약으로 역사적 파일을 읽고, Candidate 수정·제출 validator는 엄격한 새 규칙을 적용한다. **이 형태 gate는 명백한 서술/뜻풀이 재서술과 자기 반복에 대한 Stage 1 하드 조건이다.** 독립 단어뿐 아니라 **의미가 확장된 짧은 장면·심상·감각 표현**도 보존한다. 표현의 독창성이나 편집적 매력만 논쟁되는 경계 사례는 Stage 1 blocker로 만들지 말고 Stage 2의 채택·Tier 판단에 남긴다. 기존 최종 후보의 형태 확인 의무는 유지하되 별도의 두 번째 전수 의미 심사를 추가로 요구하지 않는다.

- 각 작업자는 **자신의 방식·모델 파일만 작성**한다. 다른 모델·CLI·서브에이전트는 오너가 별도로 실행하며 작업자가 임의 호출하지 않는다.

### C/D 생산 프롬프트 — 실제 문맥에서 의미 있는 후보만

C와 D는 출발 `sense_id`와 Canonical 뜻풀이를 먼저 고정하고, **해당 의미의 실제 사용 문맥**을 조회한 후 후보를 찾는다. 출발 sense와 연결되는 이유가 없다면 후보로 기록하지 않는다. 후보 개수 목표는 없다.

**C — 문학의 장면·정서·감각**

C의 정식 생산 실행 계약은 **[#1155](https://github.com/neverworkalone/typewriter/issues/1155)**이다. 실제 source-sense 문맥 VERIFIED, 일곱 관점의 독립 두 차례 탐색, 후보 전수 형태 검사는 필수다. **재개·source-sense 결속에 필요한 최소 Sense/청크 상태만 로컬에 저장**하며, 관점별·회차별 실측 검산 장부나 후보별 영수증은 요구하지 않는다. 아래는 발굴 원칙을 요약한 것이며 #1155의 상세 탐색 절차를 대체하지 않는다.

Issue #1750/#1761의 공통 read-only 조회·checkpoint·집계·Candidate 출력 도구를 C 생산 절차에서 사용한다. 배치마다 검색/증거/집계 스크립트를 다시 작성하지 않는다. 승인 문학 인덱스의 실제 v1 schema와 CLI·재개·실패·국소 수정 절차는 [`docs/relation-literary-context.md`](relation-literary-context.md)에 있으며, 도구는 검색 결과를 VERIFIED로 판정하거나 lens 후보를 발명하지 않는다.

> 정확한 출발 sense가 쓰인 작품 문맥에서 장면, 감정, 감각, 행동, 이미지와 비유를 살핀다. 작가가 출발어를 쓰면서 연상하거나 표현을 확장할 수 있는 연결만 제안한다. **같은 문장·문단에 같이 있었다는 사실은 관계의 근거가 아니다.** 예를 들어 `가끔가다 → 냉면/무지개`, `가계부 → 넥타이/소독약`처럼 문맥에 우연히 함께 나온 사물을 나열하지 않는다. 다만 단 한 작품에서만 발견한 비유라도 **출발 의미와 장면·정서 사이에 설명 가능한 연결**이 있으면 남길 수 있다. 동음이의어 또는 다른 단어의 문맥을 출발 sense에 잘못 연결하지 않는다. 유용한 후보가 없으면 빈 배열을 반환한다.

**D — 말뭉치의 실제 쓰임과 표현적 연결**

D는 전용 Workbench 없이 #1156의 25-record 청크 직접 검색 → AI 판독 → 후보 편집 → Candidate JSONL 조립 → 공통 validator 순서로 생산한다. 전수 선행 scan, 문맥/후보별 영수증은 요구하지 않는다.

> 정확한 출발 sense가 쓰인 문맥에서 자연스러운 연관 표현, 사용 상황, 함께 발생하는 행동, 의미상 가까운 말, 글쓰기에 도움이 되는 연상을 찾는다. 같은 문서의 주제어, 가까이에 나온 명사, 단순 공출현 빈도만으로 후보를 선택하지 않는다. 후보와 출발 sense 사이의 **구체적인 쓰임·의미 연결**이 실제 문맥에 있어야 한다. `가계도 → 가계도`처럼 출발 표제어 자신은 제외하고, 동음이의어·부분 문자열 검색 오탐을 구별한다. 검색 자료가 문학 분야에 치우친 경우 이를 일반 문어 전체의 대표 용례로 간주하지 않는다. 적절한 후보가 없으면 빈 배열을 반환한다.

**실행 기록과 공개 PR 보고:** C/D는 실제 탐색과 source-sense 판독을 수행하고 재개·검증에 필요한 최소 로컬 상태만 남긴다. **C의 7관점 × 독립 2회 실제 탐색은 필수**지만, 관점별·회차별 실측 검산 장부, 빈 관점별 0건 표, 문맥·후보별 영수증 및 상세 통계는 #1155에 따라 필수로 기록·제출하지 않는다. **C의 공개 PR 본문은 #1155 §4의 여섯 항목(Method, Model, Shard, Batch, Coverage, Candidates)만 기록한다.** 공통 안내의 활성/빈 sense, 문맥 검증 요약, 탐색 수행 여부, 절차 식별·한계 보고를 C PR 본문의 추가 의무로 적용하지 않는다. D의 공개 PR 본문에는 #1156의 최소 실행 요약(실제 모델, shard/batch, 후보 수, 승인 문어 원문 검색·source-sense 확인·Candidate v1 검증 수행 여부, 주요 한계)만 간결히 기록한다. 활성/빈 sense 수, 별도 절차 식별자, PASS별 세부 통계·영수증·장부를 추가 의무로 요구하지 않는다. 단순 표기·전사 오류는 실제 데이터·필수 실행에 영향을 주지 않는다면 PR 본문만 정정할 수 있다. 반면 검증 문맥 날조, 다른 sense 결속, 탐색 누락, 허위 수행 보고는 기술 차단 사항이다. 보고된 합계만으로 비공개 문맥을 독립 확인했다고 주장하지 않는다.

**공통 출력:** Stage 1은 `candidates: string[]`만 기록한다. 타입·Tier·대상 ID·채택 판정은 Stage 2가 한다. 후보별 인용문·검색 로그·근거 설명은 Candidate JSONL에 싣지 않는다. 문학·말뭉치 원문과 SQLite는 Git에 올리지 않는다.

**모든 A/B/C/D 공통 규칙:** 후보 문자열이 해당 source record의 Canonical `lemma`와 정확히 같으면 후보에서 제외한다. 표제어 자체를 다시 제시해도 탐색이 확장되지 않으므로, sense별로 독립 평가한 뒤에도 자기 표제어는 남기지 않는다.

### Candidate JSONL v1

**레코드 하나 = JSONL 한 줄.** Canonical에 있는 모든 source record/sense를 보존하고, 의미별 관계 후보를 **문자열 배열**에 기록한다.

```jsonl
{"record_id":"w001","senses":[{"sense_id":"w001-s1","candidates":["농지","쟁기","흙냄새"]}]}
{"record_id":"w002","senses":[{"sense_id":"w002-s1","candidates":[]},{"sense_id":"w002-s2","candidates":["덧셈","합계"]}]}
```

*후보 문자열은 스키마 예시이며 관계 승인 결과가 아니다.*

| 필드 | 형식 | 의미 |
| --- | --- | --- |
| `record_id` | string | 출발 Canonical record ID |
| `senses` | array | 해당 record의 전체 source sense |
| `sense_id` | string | 출발 Canonical sense ID |
| `candidates` | string[] | 후보 표현 문자열. 빈 배열 허용 |

**Candidate에 포함하지 않음:** `type`, `tier`/`relevance`, 대상 ID, 채택 여부, 평가/확신도, 원본 인용. `lemma`/`gloss`는 Canonical에서 읽고, method/model은 파일명으로 구별한다.

**완료 파일 검증:** 신규 배치를 PR로 제출하기 전에 Candidate v1을 **한 번** 검증한다. **A/B는 Workbench `merge`, C는 literary-context `export`가 이 최종 검증을 이미 실행**하므로 별도로 아래 명령을 반복하지 않는다. **D는 전용 Workbench가 없으므로** 최종 JSONL을 조립한 뒤 아래 공통 validator를 직접 한 번 실행한다(실패를 수정한 경우에만 재검증). 아래는 D 실행 예시다.

```sh
node scripts/relation/candidate-contract.mjs \
  data/canonical/stdict-0005.jsonl \
  data/relation-candidates/005/005_02_d_codex.jsonl
```

신규 Candidate 제출 validator는 JSONL 파싱 및 허용 필드, Canonical 배치와 record 행 수·순서·ID/각 record의 모든 sense 정확히 일치, 후보의 비어 있지 않은 문자열/공백 정리, 같은 파일·source sense 안의 정확한 중복, source lemma와 후보 사이의 양방향 정규화 부분 문자열 포함, source 뜻풀이의 천 단위 쉼표 숫자(`7,460미터`)를 쪼갠 조각 후보(`7`, `460미터`)를 확인한다. 포함 검사는 NFC·공백 정리 후 공백과 하이픈을 제거해 비교하며, 어느 쪽이 다른 쪽에 포함되면 별도 Canonical 표제어·검색형·다른 sense 여부와 관계없이 차단한다. `search_forms`는 검색용 색인이며 포함 금지의 예외가 아니다. 후보가 없는 sense는 `candidates: []`로 기록하며, **행 누락 또는 미완료 파일을 정상적인 빈 후보로 취급하지 않는다**. 모델 간 동일 문자열은 Stage 2에서 비교한다. 이 strict 제출 검사는 신규·수정 Candidate 파일에 적용한다. Stage 2가 이미 머지된 Candidate 파일을 준비 단계에서 읽을 때는 과거 검증 계약을 유지하며 새 양방향 포함 규칙만 적용하지 않는다. 따라서 역사적 Candidate를 자동으로 수정하거나 재검증하지 않는다.

PR의 Normal 검사는 추가·수정된 `data/relation-candidates/` 파일마다 strict 제출 계약을 자동 적용하고, 파일명에 지정된 Canonical shard와 대조해 전체 record/sense 커버리지, 허용 필드, 중복 후보와 source lemma 및 동일 표제어 표기형의 재등장을 검사한다. Stage 2의 기존 Candidate 읽기 경로는 새 포함 규칙을 소급 적용하지 않는다. 문서 전용 PR은 Candidate 검사를 실행하지 않는다.

## 3. `#860 A 진행해` — 다음 배치 자동 선택

`#860 A 진행해`, `#860 B 진행해`, `#1155 C 진행해`, `#1156 D 진행해` 등은 **현재 실행 중인 모델이 지정된 방법으로 다음 미완료 배치를 생산하고 PR을 올리라는 명령**이다. 다른 모델/CLI를 대신 실행하지 않는다. 실행 기준은 **A/B: [#860](https://github.com/neverworkalone/typewriter/issues/860), C: [#1155](https://github.com/neverworkalone/typewriter/issues/1155), D: [#1156](https://github.com/neverworkalone/typewriter/issues/1156)**이다.

**진행 위치 키가 방식마다 다르다.**

- **A/B: `(method, model)`별 독립 진행.** Codex-A, Claude-A, Codex-B, Claude-B, 오너가 추가한 DeepSeek A/B 각각 자신의 다음 배치를 진행한다.
- **C/D: `method`별 공유 진행.** Codex·Claude·DeepSeek는 C의 완료/점유 배치를 함께 확인하고 D도 별도로 함께 확인한다. 한 배치의 C 결과 또는 D 결과는 실제 생산자 모델이 무엇이든 **각 방식당 정확히 하나**만 만든다. 파일명에는 실제 생산 모델을 기록한다.
- 예를 들어 `001_01_c_codex.jsonl`이 완료된 상황에서 Claude가 `#1155 C 진행해`를 받으면 `001_01_c_claude.jsonl`을 새로 만들지 않고 `001_02_c_claude.jsonl`부터 진행한다. 다음 Codex C 작업은 다시 C의 다음 미완료 배치를 선택한다. D도 동일하다.

**War Room 지정 실행(A/B/C/D):** War Room이 `(method,model,shard,batch)`·worktree·branch·HEAD를 지정한 실행은 아래 선택 절차를 수행하지 않는다. 지정 배치를 그대로 생산하고 재선정·반복 재검증하지 않으며, 점유·중복 충돌이 있으면 다른 배치로 넘어가지 않고 보고한다. 아래 순서는 배치 지정 없는 직접 호출에만 적용한다.

명령을 받은 생산자는 다음 순서로 실행한다.

1. 최신 `master`의 `docs/relation-factory.md`, `AGENTS.md`, Canonical을 확인하고 **실제 자신의 모델**과 지정된 방식/배치를 확인한다. C/D의 배치별 담당 모델은 오너가 지시한 모델이다.
2. 샤드 `001`/배치 `01`부터 해당 작업 키의 완료/진행 상태를 확인한다. **A/B는 해당 모델 파일만 검사**하고, **C/D는 해당 방식의 모든 모델 파일**(`<SSS>_<BB>_c_*.jsonl`, `<SSS>_<BB>_d_*.jsonl`)을 검사한다. 매번 모든 Candidate JSONL 내용을 전수 재읽기하지 않는다.
3. `master`에서 찾은 정식 생산 파일은 경로·존재 여부로 완료 처리하며 과거 Canonical·sense·Candidate v1을 매번 재검사하지 않는다. 손상·부분 작성·중복을 실제로 발견했을 때만 해당 파일을 조사하고 건너뛰지 않는다. 새로 생산한 현재 배치의 최종 Candidate v1 검증 의무는 그대로다.
4. **열린 정식 500레코드 PR이 같은 작업 키/배치를 점유했다면** 본인 PR의 유효한 리뷰 Blocker를 우선 해결하고, 다른 모델이 정상적으로 진행 중인 PR을 중복 생산하지 않는다. 정상적인 리뷰 대기 PR은 점유 상태로 건너뛰고 다음 미할당 배치를 찾는다. 닫혔으나 미머지 PR 또는 폐기된 100레코드 Pilot PR은 완료/점유로 보지 않는다.
5. `master`와 열린 PR 어디에도 없는 첫 미점유·미완료 배치를 선택해 정확한 Canonical record/sense 전체의 Candidate JSONL **하나**를 생성·검증·커밋하고 PR을 올린다. PR에는 방식·실제 모델·샤드·배치 및 검증 결과를 명시한다.
6. **같은 C/D 방식·배치의 서로 다른 모델 파일이 중복 발견되면 충돌로 보고**한다. 둘을 합치거나 둘 다 완료로 인정하지 않는다. 기존에 정상적으로 완료된 파일은 이름을 변경하지 않는다.

**동시 실행 한계:** A/B는 같은 `(method, model)` 작업을, C/D는 같은 `method` 작업을 동시에 중복 실행하지 않는다. C와 D는 별개 작업 대기열이다. GitHub 조회와 PR 생성 사이에 원자적 예약은 없으므로 PR 직전 점유 상태를 다시 확인한다. 별도 예약 서비스를 만들지 않는다.

## 4. Stage 2 — Relation Admission

**입력:** 해당 샤드의 필수 Stage 1 후보 파일 전체(2배치 × 기본 생산자 6개)와 해당 배치에 오너가 지정한 선택적 파일, Canonical, 기존 승인 Relations. **새 후보 생성이나 문학·말뭉치 재검색을 하지 않는다.**

샤드 내부에서는 출발 source sense별로 작업할 수 있으나 승인/기록은 **샤드 단위로 직렬** 수행한다.

1. A/B/C/D의 후보를 모아 문자열·의미 중복을 검토한다.
2. **새 Stage 2 Part의 승인 기준은 (a) 출발 sense와의 실제 연결 및 (b) 작가에게 주는 독립적인 표현 가치** 두 가지다(#2544). 후보를 출발 sense 전체 gloss와 기존 승인·이번 Part 동료 관계에 비추어 판정한다. 명백히 무관한 후보뿐 아니라 단순 어미 변이·명사화·반복, 별도 표현 가치가 없는 유의어·직업인 파생, 우연한 문맥 사물·근거 없는 다단계 연상도 Drop한다. Stage 1(#2545)이 명백한 네 유형을 사전 차단하므로 Stage 2는 실제로 넘어온 잔여 후보만 판단하고 동일 필터를 새로 만들지 않는다. **낯선 연상·낮은 Tier 자체는 Drop 근거가 아니다**. `어정대다→낙타`처럼 애매한 경우는 자동 삭제하지 않고 원 Sense에 관한 실제 연상 가치를 판단하며, 유익한 저우선순위 관계는 보존한다. 승인 여부를 정한 뒤 Type/Tier를 부여한다. 신규 Relation이 0건인 Part도 중복·기승인·정당한 Drop 등으로 회계를 맞추어 `verify`에 성공하면 정상이다. 승인·Drop 수 할당량은 없고 Stage 1 원본을 수정하지 않는다.
3. 채택 후보만 말의 결(`near`, `mood`) 또는 연상(`scene`, `sensory`, `action`, `association`)으로 분류한다. 새 STDICT `direct/antonym`은 작성하지 않는다.
4. 동일 출발 sense/동일 UI 그룹의 기존·신규 관계를 비교해 **Tier = relevance 1~9**를 부여한다(1이 최우선, 동순위 허용). 연상 Tier 1은 비공식 유의어 후보급에 한정한다.
5. 정확한 Canonical target record/sense가 확인되면 ID 링크, 아니면 text-only로 확정한다. 같은 이름의 다른 의미에 연결하지 않는다.
6. Typewriter-authored ID↔ID는 양방향 탐색을 제공한다. **출발 sense의 Type/Tier를 한 번 판정하고 제품의 양방향 링크에 같은 값을 쓴다.** marker 없는 checkpoint는 종전 독립 역방향 판단을 읽을 수 있지만, 서로 다른 값이 남은 Part는 저장 경계에서 중단한다. 기존 승인 데이터의 비대칭 역방향 값은 #2446 전환에서 source 값으로 정규화하며 다른 후보 판정은 다시 하지 않는다. text-only는 역방향이 없다.

**출력:** 승인된 Relations JSONL(샤드당 한 파일). 재실행 때 중복 관계를 누적하거나 기존 결정을 임의로 삭제하지 않는다.

### Persisted Relations / Drops JSONL (Issue #2446)

한 줄 = 관계 하나. persisted field 매핑은 `scripts/relation/persisted-jsonl.mjs`가 한 번 정의하고, `scripts/relation/admission.mjs`는 descriptive in-memory 행을 검증한다.

```jsonl
# data/relations/relation-001.jsonl — ID 링크(양방향 한 행)
{"id":"w1","sid":"w1-s1","tid":"w9","tsid":"w9-s1","tp":"near","rv":2,"ver":1,"fm":["표적 표기"],"rfm":["출발 표기"]}
# text-only (reverse 없음, 클릭 불가)
{"id":"w1","sid":"w1-s1","tt":"새 말","tp":"scene","rv":4}
# data/relation-drops/drop-001.jsonl — 실제 Drop만 (없으면 빈 파일/부재 허용)
{"id":"w2","sid":"w2-s1","cd":"버릴말","by":"x"}
```

- 파일에 저장하는 필드만 축약한다. Relation ID 행은 `id`/`sid`/`tid`/`tsid`/`tp`/`rv`와 선택적 `ver`/`fm`/`rfm`, text-only 행은 `id`/`sid`/`tt`/`tp`/`rv`, Drop 행은 `id`/`sid`/`cd`/`by`를 사용한다. JS 내부 객체와 checkpoint는 기존의 descriptive 필드명을 유지할 수 있다. 저장기는 compact 필드만 쓰고, 저장 파일을 읽는 Stage 2 및 제품 빌드 로더는 이전 verbose 키와 혼합된 키를 거부한다.
- `tp`와 `rv`는 ID 링크의 유일한 관계 타입과 relevance다. 제품 역방향 링크도 같은 `tp`/`rv`를 사용하며 역방향 필드를 JSONL에 저장하지 않는다. 새 ID 판단에서 source 방향 값을 한 번만 판단하고 양방향에 적용한다. 이전 형식의 checkpoint에 서로 다른 역방향 판단이 남아 있으면 저장 결과가 달라지므로 해당 Part의 `merge`는 거부하며, 최신 스키마로 Part 경계를 다시 시작해야 한다. 이전 형식의 premerge snapshot은 내용과 hash를 보존하고 자동 변환하거나 다시 캡처하지 않는다.
- `ver`/`fm`/`rfm`은 후보 귀속 근거이며 값과 의미를 보존한다. `ver`가 없는 legacy 행, `ver:0`, `ver:1`은 서로 다르다. 새로 선택한 ID 행은 `ver:1`과 두 배열을 저장한다. 여러 후보형이 같은 source/target sense 쌍으로 병합되면 각 방향에서 처리한 정확한 후보 표기를 합쳐 보존한다. 후보별 relevance가 다를 때는 가장 우선순위가 높은 값(숫자가 가장 작은 relevance)을 저장한다. type 판단이 다르면 임의 선택하지 않고 merge를 거부한다. spacing/hyphen 표기 변형은 별도 규칙으로, 판단이 다를 때 Canonical headword spelling의 판단을 우선한다. 기존 version-less 행에 새 반대 방향 후보 귀속을 합치면 `ver:0`으로 기록한다. 이때 `fm`은 기존 정방향 추론 표기, `rfm`은 새 반대 방향에서 처리된 정확한 후보 표기다. 이 정보는 accounting/restart용이며 제품 링크의 target을 바꾸지 않는다.
- ID 링크의 target은 후보 문자열과 철자가 정확히 같은 Canonical record의 실제 sense여야 한다. Stage 2 Part의 `read-chunk` 입력은 같은 표기의 모든 target record, lemma, sense ID, POS, 전체 gloss를 제공한다. 동철 이의어·다의어는 출발 sense와 각 target sense를 비교해 선택하며 첫 항목을 자동 선택하지 않는다. text-only로 남길 때도 제공된 target sense ID를 전부 검토하고 `no_exact_match`로 명시한다. 일치하는 target이 없으면 text-only이며 가짜 ID를 쓰지 않는다.
- 소유 샤드 = 출발(source) sense가 속한 샤드. 한 쌍(A↔B)은 한 행에만 저장하며, 다른 샤드에 이미 같은 쌍(정·역 모두)이나 같은 text-only가 있으면 거부한다. 새 Part의 각 방향은 source 기준으로 한 번 판단하고 동일한 반대 값을 저장한다. 양쪽 출발 sense의 Candidate가 같은 쌍을 동시에 만들면 기존 방향 충돌 검사가 두 source 판단의 일치 여부를 확인하며, 서로 다르면 한쪽을 임의 선택하지 않고 #2307 preflight/국소 재판정으로 해결한다. 빌드는 ID 행마다 같은 Type/Tier의 양방향 탐색 행 2개를 만든다.
- 모든 고유 후보는 **신규 관계 / Drop / 정확한 중복 병합 / 기존 승인 관계 제외**로 설명되어야 한다. 같은 후보 표기에 ID 관계가 여러 개 있으면 실제 target sense가 서로 다를 때 허용하며, 동일 source/target sense 쌍은 한 번만 저장한다. 여러 후보형이 같은 쌍을 공유하면 위의 type/relevance 병합 규칙을 적용한다. 같은 후보에 대한 text-only 관계나 Drop은 다른 처리와 중복할 수 없다.
- **Stage 2 Drop**은 (1) 실제 출발 sense와 관계가 없는 후보 또는 (2) 의미가 연결되더라도 작가에게 독립적인 표현 가치를 주지 않는 후보에만 쓴다(#2544). `by:"x"`는 무관·오결속 후보, `by:"e"`는 연결은 되지만 독립적인 표현 가치가 없는 후보를 뜻한다. Stage 2는 `x/e`만 저장하며 자유형 설명, `editorial:`, `edit`, `z`를 거부한다. **뜻풀이에 직접 등장하는 후보에 대한 `findGlossNamedDrops` 반례 검사는 `x`에 적용하고, `e`는 면제**한다. `z`는 Stage 3 전용 회계 코드다. 같은 sense의 기존 승인 peer와 모순되는 Drop, 잘못된 후보 회계·중복·샤드 소유는 여전히 금지다.

**도구** (`pnpm run relation:admission -- <command>`, 샤드 번호만 바꿔 재사용):

```sh
node scripts/relation/admission-cli.mjs prepare --shard 001 --out <scratch>/p001.json  # 비-Part 전체 입력 보기
node scripts/relation/admission-cli.mjs verify  --shard 001                           # 전체 스키마·ID 결속·귀속 완전성
node scripts/relation/admission-cli.mjs prepare --shard 003 --batch 01 --part 01      # 기본 checkpoint: .warroom-scratch/relation-admission-003-01-01.json
node scripts/relation/admission-cli.mjs read-chunk --checkpoint .warroom-scratch/relation-admission-003-01-01.json --out .warroom-scratch/active-chunk.json
node scripts/relation/admission-cli.mjs save-chunk --checkpoint .warroom-scratch/relation-admission-003-01-01.json --in .warroom-scratch/decisions.json
# War Room 청크 실행: 같은 청크의 compact 뷰와 compact 판정(아래 설명)
node scripts/relation/admission-cli.mjs read-chunk --checkpoint .warroom-scratch/relation-admission-003-01-01.json --format compact --out .warroom-scratch/active-chunk.txt
node scripts/relation/admission-cli.mjs save-chunk --checkpoint .warroom-scratch/relation-admission-003-01-01.json --in .warroom-scratch/decisions.txt --format compact
node scripts/relation/admission-cli.mjs merge --checkpoint .warroom-scratch/relation-admission-003-01-01.json
node scripts/relation/admission-cli.mjs verify --shard 003 --batch 01 --part 01
```

`--batch 01|02`를 주면 해당 500레코드 배치의 필수 Stage 1 파일 6개·Canonical 행·행 귀속만 대상으로 한다(같은 샤드 파일 `relation-<SSS>.jsonl`에 배치별로 나눠 누적할 때 사용). 다른 배치의 행은 그 실행의 귀속 검사에서 제외되며, 샤드 전체가 끝났는지는 `--batch` 없는 `verify`가 판단한다.

`--part 01|02|03|04|05`는 반드시 `--batch`와 함께 사용하며, 선택한 Stage 1 배치 안에서 Stage 2의 Canonical 순서 100개만 편집·통계·귀속 검사한다. Batch 01의 Part 01–05는 shard record 1–100, 101–200, 201–300, 301–400, 401–500이고 Batch 02는 501–600, 601–700, 701–800, 801–900, 901–1000이다. 마지막 샤드의 Batch 02는 83개이므로 Part 01만 유효하다. 비어 있는 Part와 `--part` 단독 지정은 실패한다. Part별 `prepare` 항목과 `raw`, `unique`, `merged_duplicates`, `skipped_existing`, `skipped_dropped`, `to_edit`, `relation`, `drop`, `reverse_covered`, `missing` 통계는 모두 해당 Part의 source senses만 센다.

Part 모드는 선택한 Stage 1 Batch의 필수 후보 파일 6개를 기존 v1 계약대로 한 번 검증·통합하고, Part checkpoint에 source sense, 후보 provenance, 같은 표기의 모든 target sense/gloss, 같은 출발 sense의 기존 승인 동료, 후보별 판정 상태를 보존한다. 후보 accounting은 `(source sense, candidate)` 단위이므로 기존 ID 링크가 하나라도 있으면 새 필수 판정은 생략한다. 단, 일부 target sense만 연결된 후보는 checkpoint에서 `already_accounted`로 표시하고 나머지 sense 링크를 선택적으로 추가할 수 있다. `prepare --part`를 재실행하면 기존 checkpoint를 이어간다. `read-chunk`는 Canonical이나 승인 관계를 다시 읽지 않고 미판정 후보를 한 번에 보여 준다. 필수 후보 편집이 끝나면 `read-chunk --optional --format compact`가 남은 정확한 target sense/gloss를 부작용 없이 보여 준다. 미연결 링크가 없으면 `complete-optional`을 실행해 완료 증거를 저장하고, 링크가 있으면 `save-optional`로 후보마다 skip 또는 여러 exact target을 한 번에 기록한다. 예전 활성 revision이 남아 있으면 `cancel-revision --chunk-id <exact>`는 해당 미병합 revision ID에만 사용할 수 있다. 기본 250개 후보를 기준으로 여러 완전한 source sense를 묶으며, 하나의 sense가 그보다 크면 정확한 candidate 시작·끝 offset을 표시해 이어서 처리한다. source sense는 이 초과 경우에만 청크 사이에서 이어진다.

`--format compact`는 primary와 `read-chunk --optional`을 모두 손실 없이 렌더링한다. primary 뷰는 target sense 전체 gloss, 출발 sense(`S`), 기존 승인 동료(`P`), 같은 sense의 앞 청크 판정(`Q`)을 싣는다. 새 marker-bearing checkpoint의 exact ID 입력은 `c<n> R <type> <tier> T<k>`이며 CLI가 reverse 값을 파생한다. marker 없는 legacy checkpoint는 `c<n> R <type> <tier> T<k> <reverse_type> <reverse_tier>` 입력을 재개할 수 있지만, source와 reverse 판단이 다르면 compact 저장 형식으로 merge하지 않는다. text-only·target 없는 후보·Drop 문법은 두 정책에서 같다. Optional도 동일 정책을 따르며 여러 target의 관계를 한 번에 기록할 수 있다. CLI는 alias를 exact record/sense ID로 펼친 뒤 source-bound 검증을 거친다. 각 view가 출력 상한을 넘으면 페이지 번호와 크기를 지정해 손실 없는 페이지로 나눈다.

각 후보는 한 번의 통합 판단으로 `relation` 또는 실제 `drop`을 선택한다. Relation은 후보별 `type`과 상대 Tier `1..9`를 가진다. 같은 표기의 target sense가 있으면 `target_resolution`을 명시한다. 정확한 대상은 `exact`와 제공된 record/sense ID를 저장한다. 새 정책에서는 CLI가 reverse type/Tier를 source 값에서 파생하고, legacy checkpoint의 입력은 정·역방향 값을 모두 요구한다. text-only는 `no_exact_match`와 제공된 target sense ID 전체를 `checked_target_sense_ids`에 적는다. 같은 표기의 target이 없으면 target 판정 필드는 생략한다. checkpoint에 필요한 비교 상태만 남기며 의미적 정답을 자동 판정하지 않는다. `save-chunk`는 청크의 누락·중복·범위 밖 decision 및 잘못된 target 결속을 저장 전에 거부한다. Drop은 후보별 근거를 가진다. Type/Tier 기본값이나 별도 ID/Tier 패스는 없다.

모든 primary 청크와 optional review를 저장한 뒤 최초 `merge`는 원본 Relation/Drop 바이트(파일 부재와 빈 파일을 구분)를 scratch snapshot으로 고정하고, 같은 순수 materialize 계산으로 승인·충돌·Candidate accounting을 검증한 뒤에만 Relation→Drop→checkpoint 순으로 쓴다. `inspect --source-sense-id <id[,id...]> --format compact`는 checkpoint와 산출물을 변경하지 않고, 현재 판정 및 optional 상태에 묶인 digest를 출력한다. merged Part의 검토 수정은 그 digest를 가진 `amend` 입력으로 sparse `R`/`D` 행을 한 번에 제출한다. CLI는 premerge snapshot과 기존 checkpoint에서 전체 결과를 재계산하며 여러 파일 저장 중 중단된 네 가지 상태만 같은 요청으로 복구한다. snapshot이 없는 과거 merged checkpoint는 amend할 수 없다. `verify --shard S --batch B --part P --checkpoint <file> --json`은 로컬 merged checkpoint와 실제 Relation/Drop 바이트를 함께 검사하며, 최신 PR HEAD 검증은 checkpoint가 없는 별도 checkout에서 실행한다. Batch 또는 shard가 끝날 때는 범위를 넓혀 별도로 검증하고, `--part` 없는 기존 호출의 의미는 유지한다.

`--batch` 없이 실행하면 필수 Stage 1 파일(2배치 × A-Codex/A-Claude/B-Codex/B-Claude/C/D 12개)이 하나라도 없을 때 실패한다. `--batch BB`는 **해당 배치의 필수 생산자 6개만** 요구하므로 다른 배치 입력이 없어도 착수·검증할 수 있다(다른 배치의 Candidate 파일은 목록 검사·파싱 대상이 아니므로 충돌하거나 미완성이어도 이 실행을 막지 않는다). 다른 배치나 샤드의 ID 관계는 `prepare`와 `verify`에서 실제 target sense별로 계산한다. Stage 2 accounting 단위는 `(source sense, candidate)`다. 후보가 고유 표제어의 한 sense에 이미 ID로 연결됐으면 이 후보는 기존 승인 관계로 처리되어 새 필수 판정을 요구하지 않는다. Part 모드에서는 나머지 target sense의 추가 ID 링크를 `read-chunk --optional`로 검토한다. 링크 후보가 있으면 `save-optional`에서 후보마다 skip 또는 여러 exact target을 한 번에 선택하고, 0개면 `complete-optional`이 AI 실행 없이 완료 증거를 기록한다. 신규 ID 판정에서는 같은 표기의 모든 target sense/gloss를 비교하고 실제로 일치하는 sense를 선택한다. text-only로 남기는 경우에만 모든 sense ID를 확인한다. text-only 승인 관계도 후보 전체를 처리한 것으로 본다. `--allow-partial`은 도구 점검 전용이며 샤드 완료 증거가 아니다. 불완전 Stage 1 입력으로 만든 Part checkpoint는 `merge`가 거부한다. 다른 샤드의 승인 Relations(정·역방향)와 동철 이의어는 위 규칙대로 처리하며, 동철 이의어 철자는 기존 관계로 간주하지 않는다.

**Stage 2 다음 작업 선택(#927):** 완료 단위는 `(shard, batch, part)`다. 샤드 001부터 Batch 01→02, 각 Batch 안에서 Part 01→05의 Canonical 순서로, 필수 Stage 1 파일 6개가 최신 master에 있고 그 master의 정확한 `verify --shard <SSS> --batch <BB> --part <PP>`가 아직 성공하지 못하는 가장 이른 Part를 고른다. 파일이나 이전 PR의 존재·머지만으로 완료를 판단하지 않는다. 해당 Part의 편집 세션 하나가 PR 하나다. 같은 샤드의 열린 Stage 2 PR이 있으면 누적 `relation-<SSS>.jsonl`/`drop-<SSS>.jsonl`의 충돌을 막기 위해 다음 Part를 시작하지 않는다. PR 머지 후 최신 master를 기준으로 다음 Part를 준비한다. 각 Batch의 **모든 유효 Part**가 성공적으로 검증된 뒤 `verify --shard <SSS> --batch <BB>`를 실행하고, 해당 샤드의 **모든 유효 Part**가 끝난 뒤 `verify --shard <SSS>`를 실행한다(샤드 428은 Batch 02의 Part 01만 유효하므로 총 6개 Part). 후보가 없거나 전부 다른 승인 관계로 처리된 범위도 `verify` 성공으로 완료될 수 있다. #927은 이 순차 생산·검증 계약을 계속 소유하며, 구현 이슈 #1665만 구현 완료 후 닫는다.

## 5. Stage 3 — Relation Editorial Refinement (#2455)

> **구현 상태:** [#2450](https://github.com/neverworkalone/typewriter/issues/2450)의 구현 작업은 종료되었으며 Stage 3 CLI(`scripts/relation/edit-cli.mjs`), War Room `s3` 실행(`tools/warroom/warroom/stage3.py`) 및 Stage 2 연계 reconcile 경로가 마련되어 있다. 실제 샤드 작업은 [#2455](https://github.com/neverworkalone/typewriter/issues/2455)의 선행 조건·검증·점유 규칙을 따른다. 구현 완료는 특정 샤드의 파일럿/생산 완료를 의미하지 않는다. REVIEW.md의 *PR review Stage 3*와는 별개다.

**목적:** Stage 3는 **Stage 2 최종 편집 품질을 독립적으로 감사**한다(#2544). Stage 2와 동일한 작가 관점의 표현 가치 기준으로 잘못 승인된 관계·Sense·Link Repair 필요성을 확인하고 필요한 교정을 수행하되, 대량 편집을 정상 운영의 전제로 삼지 않는다. 과거 preserve-first 기준으로 생산된 샤드를 소급 재편집하거나 당시 Stage 2를 지침 위반으로 평가하지 않는다. Stage 3의 삭제 비율은 원인 진단 지표일 뿐 목표/쿼터가 아니며, 독창적이고 유용한 연상은 보호한다. 기존 Drop·Link Repair 교정 능력은 유지한다.

**허용:** (1) 승인 Relation **한 행 전체를 삭제**하는 Drop, (2) 기존 **text-only 관계를 정확한 Canonical target record/sense의 ID 관계로 전환**하는 Link Repair. Repair는 기존 `tp/rv`를 보존한다. ID 행 삭제는 **해당 행이 만든 정·역방향 투영**을 제거한다. 다른 살아 있는 Relation이 같은 meaning-level 관계를 만들면 제품 화면의 링크는 남을 수 있다. 표제어·Sense·후보·새 관계 추가, 대상어 바꿔치기, Type/Tier 재판정, STDICT direct/antonym 편집은 금지한다.

### 5-A. 파일·후보 회계

- **기존 파일만 사용:** `data/relations/relation-SSS.jsonl`에서 Drop 관계를 삭제하고 text-only를 ID 관계로 고친다. `data/relation-drops/drop-SSS.jsonl`에는 **삭제 후 어떤 Relation/역방향 커버도 처리하지 않는 후보 키**만 기존 `{id,sid,cd,by:"z"}`로 추가한다. 같은 후보에 다른 유효 target Sense 관계가 남았다면 Drop하지 않는다. 여러 `fm`, legacy/`ver:0` 추론, `rfm`은 Stage 2의 동일한 후보 귀속 규칙으로 계산한다.
- **Drop 소유:** `drop-SSS`의 `sid`는 항상 SSS의 Canonical source sense에 속한다. 다른 샤드 sense를 넣는 foreign tombstone이나 별도 `edit-SSS.jsonl` 원장은 금지한다. 다른 샤드의 역방향 고아 후보는 **그 샤드 자체 Stage 2 흐름에서** 원인에 따라 처리한다.
- **Stage 3 Drop은 출발 의미와 무관해야 한다는 뜻이 아니다.** 후보가 의미상 유효해도 단순 활용형, 어미 변이, 명사화, 반복·중복, 효용 없는 유의어, 가치 없는 연상 또는 잘못 결속된 Sense면 Relation 삭제 후 고아 후보 Drop이 될 수 있다. 이는 **Stage 2가 먼저 걸러야 할 유형을 감사하며 놓친 사례를 교정**하는 것이지 Stage 3 전용으로 분리된 느슨한 승인 기준이 아니다. Stage 3는 고아 후보의 회계 코드로 `by:"z"`를 만들며, 이 값은 Stage 2 `x`와 달리 출발 sense와 무관하다는 뜻이 아니므로 gloss-name 반례 검사에서 면제한다. Stage 2는 `x/e`만 사용한다.
- **Link Repair:** 동일 표기 Canonical의 **모든 target Sense 및 전체 뜻풀이**를 비교해 정확한 하나를 선택한 경우에만 `{id,sid,tid,tsid,tp,rv,ver:1,fm:[tt],rfm:[…]}`로 교체한다. Stage 2 신규 ID 링크와 Stage 3 Link Repair는 **이미 처리된 target Sense 후보형을 `rfm`에서 제외하는 공유 필터**를 사용한다. target 소유 샤드의 기존 Relation/Drop(`by:"z"` 포함)·역방향 커버로 이미 결정된 형태는 `rfm`에서 제외한다. 아직 판정 전인 실제 후보형은 기존 계약대로 유지한다. 불명확하면 text-only 유지. 중복 ID 쌍·역방향 중복은 금지한다.
- 최종 빌드는 계속 **`pnpm run build`**. 빌더나 persisted JSONL 스키마를 변경하지 않는다. SQLite의 meaning-level 병합/중복 출처가 있을 수 있으므로 관계 삭제의 최종 표시 효과는 실제 provenance를 고려한다.

### 5-B. 실행·토큰·PR 경계

1. **Stage 2 샤드 전체 완료 후 시작.** 해당 샤드의 모든 Batch/Part가 끝나고 최신 master에 대한 샤드 전체 verify 성공이 War Room에 유효해야 한다. Stage 2 Part 완료만으로 Stage 3를 시작하지 않는다. Stage 3 미완료 샤드 가운데 가장 빠른 샤드를 고르되, 같은 샤드 Relation/Drop을 수정하는 열린 PR이나 활성 작업이 있으면 대기한다.
2. **AI 청크: 관계 350~500행 목표**, 출발 Sense의 관계 목록은 **분할하지 않는다**. 한 청크에 여러 Sense를 묶을 수 있다. Source Sense별 전체 gloss를 한 번 제공하고, target 의미 구분에 필요한 경우 ID Sense 뜻풀이를 제공한다. Link Repair 대상은 동일 표기 전체 Sense·전체 gloss를 제공한다.
3. **최소 출력:** `chunk NN` 뒤에 `D 1 5 9`, `L 4 T1`, 또는 `none`만 출력. Keep은 별도 출력하지 않고 기존 Relation을 유지한다. 청크마다 새 AI 세션을 사용하고 이미 검토한 청크 전체를 반복해서 읽지 않는다. 재개용 로컬 checkpoint는 청크 완료 여부와 결정만 저장한다.
4. **Shard당 Stage 3 데이터 PR 한 개.** 모든 청크 완료 후 Relation/Drop에 한꺼번에 반영하고 기존 `validateRelationRows`/`verifyAccounting` 및 실제 DB 결과를 확인한다. 생산 PR은 **해당 샤드의 Relation/Drop 두 파일만** 변경한다. Stage 2와 Stage 3의 같은 샤드 작업 경합은 금지한다.
5. **리뷰:** Repair는 전건 정확한 source/target Sense 및 gloss 확인, Drop은 실제 PR diff에서 위험도 기준 표본 검토. 4만여 관계를 리뷰 AI가 다시 전수 편집하지 않는다. 잘못된 ID·고아 후보 회계·유익한 연상의 체계적 부당 삭제는 blocker; 취향 차이는 blocker가 아니다. 문서·지침 변경은 **별도 `no-review` PR**로 분리한다.

### 5-C. Cross-shard와 기존 Stage 2 보호

- 샤드 S의 Stage 3 ID Relation 삭제로 다른 샤드 T의 역방향 후보 커버가 사라질 수 있다. **모든 `missing`을 자동 Drop하는 것은 금지.** 이미 준비되었거나 완료한 T의 실제 Stage 1 후보이고, **실제 머지된 Stage 3 데이터 PR의 변경 파일/삭제 ID 행을 확인하고 삭제 전후 후보 커버리지를 비교해 그 관계로 인해 커버가 사라졌음이 입증**되고, 현재 다른 처리 관계/Drop도 없을 때만 T 자신의 `drop-TTT`에 `by:"z"`를 추가하는 결정적 reconcile을 허용한다.
- **삭제 근거의 범위:** 실제 머지된 Stage 3 데이터 PR과 그 삭제 행을 기준으로 한 번에 계산한다. 정방향 `by:"z"` Drop이 있으면 보조 근거로 사용할 수 있지만 **필수 조건으로 삼지 않는다**. 정방향 후보가 다른 Relation에 계속 커버되어 Drop이 없더라도 삭제된 행 때문에 **역방향** 후보는 고아가 될 수 있기 때문이다. 일반 Stage 2 `amend`의 삭제는 Stage 3 PR 삭제가 아니므로 자동 reconcile에 포함하지 않는다. 후보마다 반복해 GitHub를 검색하거나 별도 영수증을 쌓지 않는다.
- **C-3 / 역방향 후보 충돌 방지:** 기존 Stage 2 신규 ID 행의 `rfm` 전체 자동 채움은 금지한다. 신규 Stage 2 ID 링크와 Stage 3 Link Repair 모두 **target 소유 Sense에서 이미 Relation/Drop/역방향 커버로 결정된 후보형을 제외**하는 동일 공유 함수를 사용한다. 특히 Stage 3가 S에 기록한 `by:"z"` Drop을 다른 샤드 T가 신규 링크의 `rfm`으로 다시 claim해 S의 verify를 깨뜨리지 않아야 한다. 다만 동일 ID 쌍을 T가 나중에 재승인할 수 있는 것은 별개 문제이며 T의 Stage 3에서 편집한다.
- 아직 Stage 2 준비 전인 T의 후보는 **미리 Drop하지 않는다**. T가 동철 다른 Sense와 연결할 가능성을 기존 Stage 2 판정에 남긴다. 같은 ID 쌍이 나중에 다시 승인되면 그 소유 샤드의 Stage 3에서 판단한다.
- 진행 중인 Stage 2 Part가 오래된 Relations를 기준으로 최종화하지 않게 **AI 판정이 끝난 후, materialize/premerge 전에 최신 master를 안전하게 반영**한다. 기존 AI 판단과 checkpoint를 보존하며 안전한 병합 불가 시 작업을 보존하고 명시적으로 정지한다. Stage 3 변경만으로 AI를 전수 재실행하지 않는다.
- 영향 샤드 확인은 실제 변경된 Relation의 **양 끝 Sense 소유 샤드** 중심으로 하고, 자기 Drop/Candidate·공유 검증 코드·Canonical 등 기존 입력 변화는 계속 감지한다. 불명확한 경우 안전하게 verify한다. 재검증을 위한 새 SHA 영수증, 정책 digest, 전체 Sense 감사 원장, 범용 stale 시스템은 만들지 않는다.
- Stage 3 완료는 War Room `s3` 작업의 실제 merged 상태로 판단하며, 상태 유실 시 **실제 머지된 PR·해당 샤드·변경 파일·이슈 연결**을 확인해 복구한다. PR 제목만으로 완료 확정하지 않는다.

### 5-D. 편집 판단

- **Drop:** 활용형/같은 어근의 단순 어미 변이 (`깜빡대다→깜빡이다`, `어정대다→어정거리다`), 형식만 바뀐 명사화 (`조퇴하다→조퇴`), 반복 (`팔딱하다→팔딱팔딱`), 가치 없는 같은 뜻 되풀이, 잘못 결속된 Sense 및 **작가가 활용할 수 있는 연상 경로가 없는** 관계. `팔딱하다 s1→심장`, `어정대다→낙타`는 정확한 출발 Sense와 표현 가치를 개별 검토하며, 단지 멀거나 낯설다는 이유로 자동 Drop하지 않는다.
- **Keep:** 실제 문장/장면/감각의 새로운 선택지를 여는 `깜빡대다→가물가물`(기억 Sense), `→점멸/명멸`(빛 Sense) 등. 낯설거나 Tier가 높다는 이유만으로 일괄 삭제하지 않는다.
- **판정 시야:** 출발 Sense의 해당 샤드 소유 Relation 전체를 함께 보고 중복과 선택지를 비교한다. ID 삭제가 역방향에도 미치는 영향을 감안한다. 형태 패턴을 정규식으로 자동 Drop하지 않는다.

**프롬프트 등록(완료):** `tools/warroom/warroom/prompts.py`의 `prompts.ALLOWED`에 `s3_policy_card`와 `s3_chunk`가 등록되어 있으며 War Room은 해당 템플릿을 사용한다.

**구현 이력·파일럿:** [#2450](https://github.com/neverworkalone/typewriter/issues/2450)은 정책·Stage 2 회계/최신 master/reconcile·Stage 3 CLI·War Room 연계의 구현 계획이었다. 파일럿 및 각 샤드의 실제 완료 여부는 [#2455](https://github.com/neverworkalone/typewriter/issues/2455)의 실행 결과와 **머지된 Stage 3 데이터 PR·검증 상태**로 판단하며, 계획 이슈의 종료만으로 완료 처리하지 않는다. 삭제율 목표는 없다.

## 6. Build와 검증 경계

`pnpm run build`는 **Canonical JSONL + 승인된 Relations JSONL**을 읽어 Full/Lite SQLite를 결정적으로 생성한다. **Candidate 파일을 직접 읽어 DB를 만들지 않는다.** STDICT 원본 및 공식 `direct/antonym`은 보존하고, text-only/양방향 관계/방향별 Tier/UI 그룹·정렬을 공통 검증한다.

**현재 상태 (Issue #928):** 승인 Relations JSONL(`data/relations/relation-<SSS>.jsonl`)은 공식 Canonical 빌드에서 자동으로 읽힌다(고정 입력 디렉터리, 픽스처는 `relationsDirectory` 옵션). Candidate와 Drop은 빌드 입력이 아니다.

- ID 행 하나 → `meaning_relations` 두 행: 정방향과 역방향 모두 같은 저장 `tp`/`rv`를 사용한다. 둘 다 기존 `source_meaning_id` 조회·정렬 경로와 `idx_meaning_relations_target`를 그대로 쓰며, 같은 한 쌍은 한 행에서만 만들어져 중복 투영되지 않는다. 같은 두 meaning·같은 type에 여러 sense가 닿으면 가장 앞선 Tier 하나만 남긴다.
- text-only 행 → `meaning_text_relations`(Full/Lite 공통). 결과에는 텍스트로만 나오고 target이 없어 클릭·역방향이 생기지 않는다.
- authored 행은 STDICT `note` 대신 빈 note를 가지며 `direct/antonym`을 쓸 수 없다. 기존 STDICT 관계와 같은 쌍·type이면 조용히 병합하지 않고 빌드가 실패한다.
- Full에는 승인 파일 샤드·행 번호와 Canonical sense를 묶는 `meaning_relation_authored_sources`가 있고 Lite에는 싣지 않는다. 빌드 검증이 쌍 존재, 출처 존재, sense→meaning 결속을 확인한다. SQLite 스키마 버전 11.

은퇴한 Lexical Factory와 별도의 Meaning 편집 계층을 되살리지 않는다.
