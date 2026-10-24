# Relation Factory v1

Typewriter 관계 제작은 **후보 발굴 → 관계 편집 → DB 빌드**로 분리한다. STDICT Canonical JSONL처럼 생성한 **Candidate JSONL을 영구 보관**하고, 이후 원본 문학·말뭉치 DB를 다시 검색하지 않고 Relations를 편집한다. 편집 기준은 [relation-editorial-policy.md](relation-editorial-policy.md)를 따른다.

**1회성 전체 초기화 (오너 결정, Issue #1154):** 영구 보관·소급 수정 금지 원칙의 유일한 예외로, 오너가 기존 생산 데이터를 `candidate` 브랜치(2af4d21a)에 보관한 뒤 구형 A/B/C/D 정식 Candidate 236개, 승인 authored Relation, Drop 판정을 모두 삭제했다. A/B/C/D 모든 방식의 진행 위치는 `001_01`부터 재시작하며(A/B는 모델별, C/D는 방식별 공유 진행 위치 유지), 구형 Relation/Drop은 새 후보 생산 후 Stage 2에서 다시 판정한다. 초기화 이후 머지된 Candidate에는 영구 보관 원칙이 다시 적용된다.

```text
Stage 1 — Candidate Generation: A / B / C / D 독립 병렬 생산
    → data/relation-candidates/<shard>/<shard>_<batch>_<method>_<model>.jsonl
Stage 2 — Relation Admission: 후보 통합 → 채택/제외 → 타입/Tier/대상 확정
    → 승인 Relations JSONL (샤드 단위 편집)
pnpm run build: Canonical + 승인 Relations → Full / Lite SQLite
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

경로 계약: `data/relation-candidates/<SSS>/<SSS>_<BB>_<method>_<model>.jsonl`. 샤드 3자리, 배치 2자리(`01`/`02`), method는 `a|b|c|d`, model은 실행한 모델 이름의 소문자 식별자. **A/B는 500레코드 배치·방식·모델당 하나의 파일**, **C/D는 모델을 가리지 않고 500레코드 배치·방식당 하나의 파일**을 허용한다. 실제 생산 모델은 파일명에 남긴다. 배치별 하위 폴더는 만들지 않으며 파일마다 PR을 하나씩 만들 필요는 없다.

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

### A/B/C/D 공통 후보 표현 단위 — Stage 1 필수 생산 계약

**가능한 연상은 넓게 보존하고, 뜻풀이 복사·위장 서술구만 엄격히 차단한다.** Stage 1은 작가가 연상할 수 있는 **독립 단어·어휘와 출발 의미에서 확장된 짧은 장면·심상·감각 표현**을 수집한다. 출발 sense에 설명 가능한 연결이 있다면 익숙한 단어, 느슨한 간접 연상, 다른 품사, 의외의 사물·감각·행동을 후보로 남겨 Stage 2가 가치를 판단하도록 한다. 반대로 단어 몇 개로 후보 수를 맞추는 할당량도 없고, 후보 수를 줄이는 것이 목표도 아니다.

| 후보의 형태 | 모든 A/B/C/D 생산자의 출력 규칙 |
| --- | --- |
| **독립 단어·어휘 항목** | 폭넓게 허용. 연상의 강함·Tier·개인적 취향을 이유로 미리 삭제하지 않는다. 단, 출발 sense와 설명 가능한 연결 및 독립된 어휘 항목이어야 한다. |
| **제시어(정확한 source lemma)를 포함하는 독립 어휘·합성어** | **문자열 포함만으로 금지하지 않는다.** 별도의 어휘적 의미·역할 또는 탐색 경로가 있는지 sense별로 판단하고, 리뷰어가 검사하도록 한다. 예: `건축 → 건축가`는 가능하다. |
| **짧은 구·관용구·여러 어절 또는 붙여 쓴 복합 표현** | **검사 목적은 단순 뜻풀이 재서술·가짜 어휘 방지**다. 출발 sense에서 장면·이미지·감각·행동·정서로 의미가 확장되는 간결한 표현은 **흔하고 평범해도 보존**한다(예: `수괘` [서리] → `겨울 아침`, `산뜩` → `가슴 철렁`). 반면 뜻풀이의 속성+범주를 그대로 옮긴 `가는소금 → 하얀 소금`, `가는솜방망이 → 노란 꽃`, 제시어에 단순 수식어를 붙인 `걸음걸이 → 느린 걸음걸이`와 공백만 제거한 위장 구절은 제외한다. **독창성·문학적 우수성·최종 채택 가치는 Stage 2**에서 판단한다. |
| **문장·서술형 절·사건·동작·과정 설명** | **절대 금지, 최종 후보 0개.** 완결형 문장뿐 아니라 `~하다/~되다` 서술절, 문장에서 종결어미를 지운 파편, 사건·절차 설명을 `일/장면/상황/기술` 등으로 포장한 명사구도 금지. `격벽 → 격벽을 여는 데 에너지가 필요하다`, `겅중 → 긴 다리로 뜀`, `검지기 → 누전이 되면 경보가 울린다` 같은 문구를 그대로 출력하지 않는다. 독립된 동사 어휘(`떨다`, `뛰다`) 자체는 문장이 아니다. |
| **출발 lemma 자체·괄호 주석만 붙인 동일 표제어** | **절대 금지**. `공탁 → 공탁(供托)` 같은 표기 반복은 별도 어휘가 아니다. |

**생산 방법별 적용:** A는 Canonical 뜻풀이를 더 짧은 설명 문구로 바꾸지 말고 **실제 다른 어휘**를 발굴한다. B는 상상한 **장면의 서술문 자체를 제출하지 않고**, 거기서 **사람·사물·감각·행동 등을 나타내는 독립 단어와 간결한 장면·심상 표현**을 추출한다. 장면을 여는 짧은 표현은 B 방식의 정당한 결과이며, 표현이 평범하다는 이유로 제거하지 않는다. C/D는 VERIFIED된 정확한 source sense의 실제 원문에서 단어·짧은 비서술적 심상을 발굴하며, 원문 문장이나 사건을 Candidate로 복사하지 않는다. 전 방법에서 제시어 포함 **단어**는 독립 어휘로 성립하는지 개별 검토하며, 제시어 포함 **구·문구**는 단순한 수식·뜻풀이 재서술만 제외한다. **간결한 장면·감각 확장은 Stage 1에서 문학적 가치나 독창성으로 가지치기하지 않는다.**

**제출 전 모든 후보 문자열 전수 형태 검사:** 최종 `senses[].candidates[]`의 모든 원소를 단어 / 제시어 포함 어휘 / 독립적 응축 구 / 문장·서술 설명 / 정확 자기 반복으로 판별하고, **문장·사건 설명 0건 및 자기 반복 0건**을 확인한다. 제외한 긴 문맥에서 근거 있는 다른 단어를 추출할 수 있으면 추출하고, 없으면 문구로 개수를 채우지 않는다. **전수 형태 검사 중 후보마다 공백 제거형이 같은 source sense 뜻풀이의 연속 구간과 맞는지도 대조한다.** 맞는 경우 원뜻풀이와 비교해 단순히 서술형 구를 붙여 쓴 것인지 판별한다. 이 일치는 검토 신호일 뿐 자동 차단 조건이 아니며, sense에 결속되는 독립 단어·독립 동사·어휘화된 합성어는 그 자체로 제외하지 않는다. **공백 수, `-다` 어미, source lemma의 부분 문자열 포함 여부만으로 자동 허용·차단하지 않는다.** `candidate-contract.mjs`는 구조·일부 객관적 자기 반복을 검사할 뿐 이 의미/표현 형식 판단을 보증하지 않는다. 새 산출물에 적용하며, 과거 머지 데이터의 일괄 소급 수정은 별도 승인된 작업으로 다룬다. **이 형태 gate는 명백한 서술/뜻풀이 재서술과 자기 반복에 대한 Stage 1 하드 조건이다.** 독립 단어뿐 아니라 **의미가 확장된 짧은 장면·심상·감각 표현**도 보존한다. 표현의 독창성이나 편집적 매력만 논쟁되는 경계 사례는 Stage 1 blocker로 만들지 말고 Stage 2의 채택·Tier 판단에 남긴다. 기존 최종 후보의 형태 확인 의무는 유지하되 별도의 두 번째 전수 의미 심사를 추가로 요구하지 않는다.

- 각 작업자는 **자신의 방식·모델 파일만 작성**한다. 다른 모델·CLI·서브에이전트는 오너가 별도로 실행하며 작업자가 임의 호출하지 않는다.

### C/D 생산 프롬프트 — 실제 문맥에서 의미 있는 후보만

C와 D는 출발 `sense_id`와 Canonical 뜻풀이를 먼저 고정하고, **해당 의미의 실제 사용 문맥**을 조회한 후 후보를 찾는다. 출발 sense와 연결되는 이유가 없다면 후보로 기록하지 않는다. 후보 개수 목표는 없다.

**C — 문학의 장면·정서·감각**

C의 정식 생산 실행 계약은 **[#1155](https://github.com/neverworkalone/typewriter/issues/1155)**이다. 실제 source-sense 문맥 VERIFIED, 일곱 관점의 독립 두 차례 탐색, 비공개 로컬 ledger와 후보 전수 형태 검사는 필수다. 아래는 발굴 원칙을 요약한 것이며 #1155의 상세 탐색 절차를 대체하지 않는다.

> 정확한 출발 sense가 쓰인 작품 문맥에서 장면, 감정, 감각, 행동, 이미지와 비유를 살핀다. 작가가 출발어를 쓰면서 연상하거나 표현을 확장할 수 있는 연결만 제안한다. **같은 문장·문단에 같이 있었다는 사실은 관계의 근거가 아니다.** 예를 들어 `가끔가다 → 냉면/무지개`, `가계부 → 넥타이/소독약`처럼 문맥에 우연히 함께 나온 사물을 나열하지 않는다. 다만 단 한 작품에서만 발견한 비유라도 **출발 의미와 장면·정서 사이에 설명 가능한 연결**이 있으면 남길 수 있다. 동음이의어 또는 다른 단어의 문맥을 출발 sense에 잘못 연결하지 않는다. 유용한 후보가 없으면 빈 배열을 반환한다.

**D — 말뭉치의 실제 쓰임과 표현적 연결**

> 정확한 출발 sense가 쓰인 문맥에서 자연스러운 연관 표현, 사용 상황, 함께 발생하는 행동, 의미상 가까운 말, 글쓰기에 도움이 되는 연상을 찾는다. 같은 문서의 주제어, 가까이에 나온 명사, 단순 공출현 빈도만으로 후보를 선택하지 않는다. 후보와 출발 sense 사이의 **구체적인 쓰임·의미 연결**이 실제 문맥에 있어야 한다. `가계도 → 가계도`처럼 출발 표제어 자신은 제외하고, 동음이의어·부분 문자열 검색 오탐을 구별한다. 검색 자료가 문학 분야에 치우친 경우 이를 일반 문어 전체의 대표 용례로 간주하지 않는다. 적절한 후보가 없으면 빈 배열을 반환한다.

**실행 기록과 공개 PR 보고:** C/D는 실제 수행한 탐색과 source-sense 검증을 내부 기록으로 남긴다. C의 로컬 관점별/회차별 실측 검산은 #1155에 따라 필수이나, 해당 상세 분포를 PR 본문에 전부 옮기는 것은 필수 생산 산출물이 아니다. PR에는 결과물의 record/sense·활성/빈 sense·후보 수, 기본 문맥 검증 요약, 요구한 탐색 수행 여부, 절차 식별과 한계를 간결하게 기록한다. 단순 표기·전사 오류는 실제 데이터·필수 실행에 영향을 주지 않는다면 PR 본문만 정정할 수 있다. 반면 검증 문맥 날조, 다른 sense 결속, 탐색 누락, 허위 수행 보고는 기술 차단 사항이다. 보고된 합계만으로 비공개 문맥을 독립 확인했다고 주장하지 않는다.

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

**완료 파일 검증:** PR을 올리기 전에 다음 명령으로 Candidate v1 계약을 확인한다.

```sh
node scripts/relation/candidate-contract.mjs \
  data/canonical/stdict-0005.jsonl \
  data/relation-candidates/005/005_02_b_codex.jsonl
```

검증기는 JSONL 파싱 및 허용 필드, Canonical 배치와 record 행 수·순서·ID/각 record의 모든 sense 정확히 일치, 후보의 비어 있지 않은 문자열/공백 정리, 같은 파일·source sense 안의 정확한 중복, source lemma·lemma 주석형 및 동일 표제어의 띄어쓰기/하이픈 표기형, source 뜻풀이의 천 단위 쉼표 숫자(`7,460미터`)를 쪼갠 조각 후보(`7`, `460미터`)를 확인한다. `search_forms`는 검색용 색인이므로 그 값과 후보가 일치한다는 사실만으로 자기 반복이라고 판정하지 않는다. lemma와 검색형의 차이가 띄어쓰기/하이픈 표기뿐일 때만 해당 검색형을 같은 표제어의 반복으로 보고, 그 검색형이 다른 Canonical 표제어와 정확히 일치하면 별도 어휘 후보로 보존한다. 표제어와 다른 독립 어휘인 검색 별칭(예: `강경하다`의 검색형 `강경`)도 후보에서 보존한다. 후보가 없는 sense는 `candidates: []`로 기록하며, **행 누락 또는 미완료 파일을 정상적인 빈 후보로 취급하지 않는다**. 모델 간 동일 문자열은 Stage 2에서 비교한다.

PR의 Normal 검사는 추가·수정된 `data/relation-candidates/` 파일마다 이 계약을 자동 적용하고, 파일명에 지정된 Canonical shard와 대조해 전체 record/sense 커버리지, 허용 필드, 중복 후보와 source lemma 및 동일 표제어 표기형의 재등장을 검사한다. 문서 전용 PR은 Candidate 검사를 실행하지 않는다.

## 3. `#860 A 진행해` — 다음 배치 자동 선택

`#860 A 진행해`, `#860 B 진행해`, `#1155 C 진행해`, `#1156 D 진행해` 등은 **현재 실행 중인 모델이 지정된 방법으로 다음 미완료 배치를 생산하고 PR을 올리라는 명령**이다. 다른 모델/CLI를 대신 실행하지 않는다. 기준은 [#860](https://github.com/neverworkalone/typewriter/issues/860)이다.

**진행 위치 키가 방식마다 다르다.**

- **A/B: `(method, model)`별 독립 진행.** Codex-A, Claude-A, Codex-B, Claude-B, 오너가 추가한 DeepSeek A/B 각각 자신의 다음 배치를 진행한다.
- **C/D: `method`별 공유 진행.** Codex·Claude·DeepSeek는 C의 완료/점유 배치를 함께 확인하고 D도 별도로 함께 확인한다. 한 배치의 C 결과 또는 D 결과는 실제 생산자 모델이 무엇이든 **각 방식당 정확히 하나**만 만든다. 파일명에는 실제 생산 모델을 기록한다.
- 예를 들어 `001_01_c_codex.jsonl`이 완료된 상황에서 Claude가 `#860 C 진행해`를 받으면 `001_01_c_claude.jsonl`을 새로 만들지 않고 `001_02_c_claude.jsonl`부터 진행한다. 다음 Codex C 작업은 다시 C의 다음 미완료 배치를 선택한다. D도 동일하다.

명령을 받은 생산자는 다음 순서로 실행한다.

1. 최신 `master`의 `docs/relation-factory.md`, `AGENTS.md`, Canonical을 확인하고 **실제 자신의 모델**과 지정된 방식/배치를 확인한다. C/D의 배치별 담당 모델은 오너가 지시한 모델이다.
2. 샤드 `001`/배치 `01`부터 해당 작업 키의 완료/진행 상태를 확인한다. **A/B는 해당 모델 파일만 검사**하고, **C/D는 해당 방식의 모든 모델 파일**(`<SSS>_<BB>_c_*.jsonl`, `<SSS>_<BB>_d_*.jsonl`)을 검사한다. 매번 모든 Candidate JSONL 내용을 전수 재읽기하지 않는다.
3. `master`에서 찾은 정식 생산 파일은 500레코드(마지막만 83) 전체 커버리지를 검증하고 정상일 때만 완료로 취급한다. 잘못되거나 부분 작성된 파일을 건너뛰지 않는다.
4. **열린 정식 500레코드 PR이 같은 작업 키/배치를 점유했다면** 본인 PR의 유효한 리뷰 Blocker를 우선 해결하고, 다른 모델이 정상적으로 진행 중인 PR을 중복 생산하지 않는다. 정상적인 리뷰 대기 PR은 점유 상태로 건너뛰고 다음 미할당 배치를 찾는다. 닫혔으나 미머지 PR 또는 폐기된 100레코드 Pilot PR은 완료/점유로 보지 않는다.
5. `master`와 열린 PR 어디에도 없는 첫 미점유·미완료 배치를 선택해 정확한 Canonical record/sense 전체의 Candidate JSONL **하나**를 생성·검증·커밋하고 PR을 올린다. PR에는 방식·실제 모델·샤드·배치 및 검증 결과를 명시한다.
6. **같은 C/D 방식·배치의 서로 다른 모델 파일이 중복 발견되면 충돌로 보고**한다. 둘을 합치거나 둘 다 완료로 인정하지 않는다. 기존에 정상적으로 완료된 파일은 이름을 변경하지 않는다.

**동시 실행 한계:** A/B는 같은 `(method, model)` 작업을, C/D는 같은 `method` 작업을 동시에 중복 실행하지 않는다. C와 D는 별개 작업 대기열이다. GitHub 조회와 PR 생성 사이에 원자적 예약은 없으므로 PR 직전 점유 상태를 다시 확인한다. 별도 예약 서비스를 만들지 않는다.

## 4. Stage 2 — Relation Admission

**입력:** 해당 샤드의 필수 Stage 1 후보 파일 전체(2배치 × 기본 생산자 6개)와 해당 배치에 오너가 지정한 선택적 파일, Canonical, 기존 승인 Relations. **새 후보 생성이나 문학·말뭉치 재검색을 하지 않는다.**

샤드 내부에서는 출발 source sense별로 작업할 수 있으나 승인/기록은 **샤드 단위로 직렬** 수행한다.

1. A/B/C/D의 후보를 모아 문자열·의미 중복을 검토한다.
2. **필요한 후보만 채택**한다. 모두 수록할 필요가 없으며 0개 채택도 정상. Stage 1 후보는 채택/제외와 관계없이 영구 보관한다.
3. 채택 후보만 말의 결(`near`, `mood`) 또는 연상(`scene`, `sensory`, `action`, `association`)으로 분류한다. 새 STDICT `direct/antonym`은 작성하지 않는다.
4. 동일 출발 sense/동일 UI 그룹의 기존·신규 관계를 비교해 **Tier = relevance 1~9**를 부여한다(1이 최우선, 동순위 허용). 연상 Tier 1은 비공식 유의어 후보급에 한정한다.
5. 정확한 Canonical target record/sense가 확인되면 ID 링크, 아니면 text-only로 확정한다. 같은 이름의 다른 의미에 연결하지 않는다.
6. Typewriter-authored ID↔ID는 양방향 탐색을 제공하되 **반대 방향의 타입/Tier도 별도 편집 판단**이 필요하다. text-only는 역방향이 없다. 샤드 경계를 넘는 역방향 저장/빌드 투영의 소유권은 구현 시 확정한다.

**출력:** 승인된 Relations JSONL(샤드당 한 파일). 재실행 때 중복 관계를 누적하거나 기존 결정을 임의로 삭제하지 않는다.

### Relations / Drops JSONL v1 (Issue #928)

한 줄 = 관계 하나. 스키마는 `scripts/relation/admission.mjs`가 한 번만 정의한다.

```jsonl
# data/relations/relation-001.jsonl — ID 링크(양방향 한 행)
{"source_record_id":"w1","source_sense_id":"w1-s1","target_record_id":"w9","target_sense_id":"w9-s1","type":"near","relevance":2,"reverse_type":"mood","reverse_relevance":5}
# text-only (reverse 없음, 클릭 불가)
{"source_record_id":"w1","source_sense_id":"w1-s1","text":"새 말","type":"scene","relevance":4}
# data/relation-drops/drop-001.jsonl — 실제 Drop만 (없으면 빈 파일/부재 허용)
{"source_record_id":"w2","source_sense_id":"w2-s1","candidate":"버릴말","reason":"출발 의미와 무관"}
```

- `type`/`reverse_type`: `near|mood|scene|sensory|action|association`. `relevance`/`reverse_relevance`: 정수 1..9. 방향별로 달라도 같아도 된다.
- ID 링크의 target은 후보 문자열과 철자가 정확히 같은 Canonical record의 실제 sense여야 한다. 동철 이의어는 `same_spelling_records`로 확인해 올바른 record를 고른다. 일치하는 target이 없으면 text-only이며 가짜 ID를 쓰지 않는다.
- 소유 샤드 = 출발(source) sense가 속한 샤드. 한 쌍(A↔B)은 한 행에만 저장하며, 다른 샤드에 이미 같은 쌍(정·역 모두)이나 같은 text-only가 있으면 거부한다. 빌드는 ID 행마다 방향별 2개 탐색 행을 만든다(빌드 구현은 별도 PR).
- 모든 고유 후보는 **신규 관계 / Drop / 정확한 중복 병합 / 기존 승인 관계 제외**로 설명되어야 한다. 같은 후보 표기에 ID 관계가 여러 개 있으면 실제 target sense가 서로 다를 때 허용하며, 동일 source/target sense 쌍은 한 번만 저장한다. 같은 후보에 대한 text-only 관계나 Drop은 다른 처리와 중복할 수 없다.
- Drop은 출발 의미와 명백히 무관한 후보에만 쓴다. 출발 sense의 뜻풀이가 그 후보를 직접 언급하면 Drop할 수 없으며(`verify`가 거부), 같은 sense의 승인 peer와 모순되는 Drop도 금지다. 약한 연상은 낮은 Tier의 관계로 보존한다.

**도구** (`pnpm run relation:admission -- <command>`, 샤드 번호만 바꿔 재사용):

```sh
node scripts/relation/admission-cli.mjs prepare --shard 001 --out <scratch>/p001.json  # 편집 입력: 고유 신규 후보 + 출발 sense/뜻풀이
node scripts/relation/admission-cli.mjs verify  --shard 001                           # 스키마·ID 결속·Tier·귀속 완전성
node scripts/relation/admission-cli.mjs prepare --shard 003 --batch 01 --part 01 --out <scratch>/003_01_01.json
node scripts/relation/admission-cli.mjs verify  --shard 003 --batch 01 --part 01
```

`--batch 01|02`를 주면 해당 500레코드 배치의 필수 Stage 1 파일 6개·Canonical 행·행 귀속만 대상으로 한다(같은 샤드 파일 `relation-<SSS>.jsonl`에 배치별로 나눠 누적할 때 사용). 다른 배치의 행은 그 실행의 귀속 검사에서 제외되며, 샤드 전체가 끝났는지는 `--batch` 없는 `verify`가 판단한다.

`--part 01|02|03|04|05`는 반드시 `--batch`와 함께 사용하며, 선택한 Stage 1 배치 안에서 Stage 2의 Canonical 순서 100개만 편집·통계·귀속 검사한다. Batch 01의 Part 01–05는 shard record 1–100, 101–200, 201–300, 301–400, 401–500이고 Batch 02는 501–600, 601–700, 701–800, 801–900, 901–1000이다. 마지막 샤드의 Batch 02는 83개이므로 Part 01만 유효하다. 비어 있는 Part와 `--part` 단독 지정은 실패한다. Part별 `prepare` 항목과 `raw`, `unique`, `merged_duplicates`, `skipped_existing`, `skipped_dropped`, `to_edit`, `relation`, `drop`, `reverse_covered`, `missing` 통계는 모두 해당 Part의 source senses만 센다.

Part 모드는 선택한 Stage 1 Batch의 필수 후보 파일 6개를 기존 v1 계약대로 전부 검증·통합한다. Candidate 입력을 Part별로 자르거나 100개 밖의 후보를 생략하지 않는다. 저장된 Relation/Drop 파일은 기존 샤드 파일을 계속 누적 사용한다. `verify --batch BB --part PP`는 그 Part의 Candidate 귀속 완전성을 판단하지만, 같은 샤드의 모든 저장 Relation/Drop 스키마·ID 결속·중복·역방향 충돌도 계속 검사한다. 같은 샤드 다른 Part의 미처리 후보는 이 호출을 실패시키지 않으며, 해당 Part가 끝난 뒤 그 Part의 정확한 `verify`를 별도로 실행한다. `--part`가 없는 기존 Batch 및 샤드 전체 호출은 이전 범위와 의미를 유지한다.

`--batch` 없이 실행하면 필수 Stage 1 파일(2배치 × A-Codex/A-Claude/B-Codex/B-Claude/C/D 12개)이 하나라도 없을 때 실패한다. `--batch BB`는 **해당 배치의 필수 생산자 6개만** 요구하므로 다른 배치 입력이 없어도 착수·검증할 수 있다(다른 배치의 Candidate 파일은 목록 검사·파싱 대상이 아니므로 충돌하거나 미완성이어도 이 실행을 막지 않는다). 다른 배치나 샤드의 ID 관계는 `prepare`와 `verify`에서 실제 target sense별로 계산한다. 고유 표제어가 여러 sense를 가지면 일부 sense만 기존 관계로 연결된 후보는 나머지 sense 편집을 위해 `prepare`에 남고, 모든 sense가 연결되면 제외한다. text-only 승인 관계는 후보 전체를 처리한 것으로 본다. `--allow-partial`은 도구 점검 전용이며 샤드 완료 증거가 아니다. 다른 샤드의 승인 Relations(정·역방향)와 동철 이의어는 위 규칙대로 처리하며, 동철 이의어 철자는 기존 관계로 간주하지 않는다.

**Stage 2 다음 작업 선택(#927):** 완료 단위는 `(shard, batch, part)`다. 샤드 001부터 Batch 01→02, 각 Batch 안에서 Part 01→05의 Canonical 순서로, 필수 Stage 1 파일 6개가 최신 master에 있고 그 master의 정확한 `verify --shard <SSS> --batch <BB> --part <PP>`가 아직 성공하지 못하는 가장 이른 Part를 고른다. 파일이나 이전 PR의 존재·머지만으로 완료를 판단하지 않는다. 해당 Part의 편집 세션 하나가 PR 하나다. 같은 샤드의 열린 Stage 2 PR이 있으면 누적 `relation-<SSS>.jsonl`/`drop-<SSS>.jsonl`의 충돌을 막기 위해 다음 Part를 시작하지 않는다. PR 머지 후 최신 master를 기준으로 다음 Part를 준비한다. Batch의 Part 5개가 모두 성공적으로 검증된 뒤 `verify --shard <SSS> --batch <BB>`를 실행하고, 두 Batch의 Part 10개가 끝난 뒤 `verify --shard <SSS>`를 실행한다. 후보가 없거나 전부 다른 승인 관계로 처리된 범위도 `verify` 성공으로 완료될 수 있다. #927은 이 순차 생산·검증 계약을 계속 소유하며, 구현 이슈 #1665만 구현 완료 후 닫는다.

## 5. Build와 검증 경계

`pnpm run build`는 **Canonical JSONL + 승인된 Relations JSONL**을 읽어 Full/Lite SQLite를 결정적으로 생성한다. **Candidate 파일을 직접 읽어 DB를 만들지 않는다.** STDICT 원본 및 공식 `direct/antonym`은 보존하고, text-only/양방향 관계/방향별 Tier/UI 그룹·정렬을 공통 검증한다.

**현재 상태 (Issue #928):** 승인 Relations JSONL(`data/relations/relation-<SSS>.jsonl`)은 공식 Canonical 빌드에서 자동으로 읽힌다(고정 입력 디렉터리, 픽스처는 `relationsDirectory` 옵션). Candidate와 Drop은 빌드 입력이 아니다.

- ID 행 하나 → `meaning_relations` 두 행: 정방향(`origin=typewriter-authored`, `type/relevance`)과 역방향(`typewriter-authored-reverse`, `reverse_type/reverse_relevance`). 둘 다 기존 `source_meaning_id` 조회·정렬 경로와 `idx_meaning_relations_target`를 그대로 쓰며, 같은 한 쌍은 한 행에서만 만들어져 중복 투영되지 않는다. 같은 두 meaning·같은 type에 여러 sense가 닿으면 가장 앞선 Tier 하나만 남긴다.
- text-only 행 → `meaning_text_relations`(Full/Lite 공통). 결과에는 텍스트로만 나오고 target이 없어 클릭·역방향이 생기지 않는다.
- authored 행은 STDICT `note` 대신 빈 note를 가지며 `direct/antonym`을 쓸 수 없다. 기존 STDICT 관계와 같은 쌍·type이면 조용히 병합하지 않고 빌드가 실패한다.
- Full에는 승인 파일 샤드·행 번호와 Canonical sense를 묶는 `meaning_relation_authored_sources`가 있고 Lite에는 싣지 않는다. 빌드 검증이 쌍 존재, 출처 존재, sense→meaning 결속을 확인한다. SQLite 스키마 버전 11.

은퇴한 Lexical Factory와 별도의 Meaning 편집 계층을 되살리지 않는다.
