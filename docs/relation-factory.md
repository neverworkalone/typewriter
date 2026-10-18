# Relation Factory v1

Typewriter 관계 제작은 **후보 발굴 → 관계 편집 → DB 빌드**로 분리한다. STDICT Canonical JSONL처럼 생성한 **Candidate JSONL을 영구 보관**하고, 이후 원본 문학·말뭉치 DB를 다시 검색하지 않고 Relations를 편집한다. 편집 기준은 [relation-editorial-policy.md](relation-editorial-policy.md)를 따른다.

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

- 샤드 001 ~ 427: 각각 1,000레코드 → 배치 `01`~`10`.
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

경로 계약: `data/relation-candidates/<SSS>/<SSS>_<BB>_<method>_<model>.jsonl`. 샤드 3자리, 배치 2자리(`01`/`02`), method는 `a|b|c|d`, model은 실행한 모델 이름의 소문자 식별자. **500레코드 배치·방식·모델당 하나의 파일**이며 배치별 하위 폴더는 만들지 않는다. 파일마다 PR을 하나씩 만들 필요는 없다.

**100레코드 파일럿과의 경계:** 기존 `001_01_*` 100행 산출물은 **500레코드 배치 완료로 취급하지 않는다**. 같은 경로를 쓰더라도 Canonical 1~500행을 검증해야 한다. 생산자는 기존 자기 후보 100행을 보존·재사용하면서 101~500행을 완성할 수 있다. 동일 경로에 100행 파일이 들어 있는 열린 PR은 500행으로 수정하거나 정리한 다음 새 PR을 연다. 구형 파일을 임의 삭제·덮어쓰거나 미완료 배치를 건너뛰지 않는다.

## 2. Stage 1 — Candidate Generation

| 방식 | 후보 발굴 방법 | 생산자 |
| --- | --- | --- |
| **A** | 정확한 Canonical sense/뜻풀이에서 직접 생성 | Codex, Claude |
| **B** | 출발 sense에 맞는 가상 장면을 구성하고 후보 추출 | Codex, Claude |
| **C** | 기존 문학 SQLite의 실제 문맥 참조 | 단일 모델 |
| **D** | 기존 문어 말뭉치 SQLite의 실제 문맥 참조 | 단일 모델 |

- **A와 B는 같은 모델에서도 서로 다른 작업/턴**으로 수행한다. 생산자는 다른 방식·모델의 후보를 읽거나 참조하지 않는다. C와 D 역시 서로 독립적이며, **각 방식의 단일 생산 모델은 오너가 지정**한다.
- **DeepSeek A/B**는 오너가 필요하다고 판단할 때 해당 배치·방식에만 추가한다. 추가하지 않은 파일은 미실행이며 `candidates: []`가 아니다.
- 출발 sense를 정확하게 결속하고, 문학/말뭉치 검색은 해당 자료 이용 조건에 맞게 읽기 전용으로 수행한다. C/D는 원문·발췌문·SQLite를 Git/PR/제품에 포함하지 않는다.
- 생성 단계에는 채택 개수 목표가 없다. 적합한 후보가 없으면 빈 목록을 그대로 기록한다. **500레코드는 내부적으로 나눠 처리해도 되지만, 최종 후보 파일은 해당 배치 전체를 포함하는 한 파일**이어야 한다.
- 각 작업자는 **자신의 방식·모델 파일만 작성**한다. 다른 모델·CLI·서브에이전트는 오너가 별도로 실행하며 작업자가 임의 호출하지 않는다.

### C/D 생산 프롬프트 — 실제 문맥에서 의미 있는 후보만

C와 D는 출발 `sense_id`와 Canonical 뜻풀이를 먼저 고정하고, **해당 의미의 실제 사용 문맥**을 조회한 후 후보를 찾는다. 출발 sense와 연결되는 이유가 없다면 후보로 기록하지 않는다. 후보 개수 목표는 없다.

**C — 문학의 장면·정서·감각**

> 정확한 출발 sense가 쓰인 작품 문맥에서 장면, 감정, 감각, 행동, 이미지와 비유를 살핀다. 작가가 출발어를 쓰면서 연상하거나 표현을 확장할 수 있는 연결만 제안한다. **같은 문장·문단에 같이 있었다는 사실은 관계의 근거가 아니다.** 예를 들어 `가끔가다 → 냉면/무지개`, `가계부 → 넥타이/소독약`처럼 문맥에 우연히 함께 나온 사물을 나열하지 않는다. 다만 단 한 작품에서만 발견한 비유라도 **출발 의미와 장면·정서 사이에 설명 가능한 연결**이 있으면 남길 수 있다. 동음이의어 또는 다른 단어의 문맥을 출발 sense에 잘못 연결하지 않는다. 유용한 후보가 없으면 빈 배열을 반환한다.

**D — 말뭉치의 실제 쓰임과 표현적 연결**

> 정확한 출발 sense가 쓰인 문맥에서 자연스러운 연관 표현, 사용 상황, 함께 발생하는 행동, 의미상 가까운 말, 글쓰기에 도움이 되는 연상을 찾는다. 같은 문서의 주제어, 가까이에 나온 명사, 단순 공출현 빈도만으로 후보를 선택하지 않는다. 후보와 출발 sense 사이의 **구체적인 쓰임·의미 연결**이 실제 문맥에 있어야 한다. `가계도 → 가계도`처럼 출발 표제어 자신은 제외하고, 동음이의어·부분 문자열 검색 오탐을 구별한다. 검색 자료가 문학 분야에 치우친 경우 이를 일반 문어 전체의 대표 용례로 간주하지 않는다. 적절한 후보가 없으면 빈 배열을 반환한다.

**공통 출력:** Stage 1은 `candidates: string[]`만 기록한다. 타입·Tier·대상 ID·채택 판정은 Stage 2가 한다. 후보별 인용문·검색 로그·근거 설명은 Candidate JSONL에 싣지 않는다. 문학·말뭉치 원문과 SQLite는 Git에 올리지 않는다.

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

**완료 파일 검증:** JSONL 파싱 및 허용 필드 검사, Canonical 배치와 record 행 수·순서·ID/각 record의 모든 sense 정확히 일치, 후보의 비어 있지 않은 문자열/공백 정리, 같은 파일·source sense 안의 정확한 중복 제거. 후보가 없는 sense는 `candidates: []`로 기록하며, **행 누락 또는 미완료 파일을 정상적인 빈 후보로 취급하지 않는다**. 모델 간 동일 문자열은 Stage 2에서 비교한다.

## 3. `#860 A 진행해` — 다음 배치 자동 선택

`#860 A 진행해`, `#860 B 진행해` 등은 **현재 실행 중인 모델이 지정된 방법으로 다음 배치 한 개를 처리하라는 명령**이다. 하나의 모델 작업이 다른 모델을 대신 실행하지 않는다.

**작업 키 = (방식, 모델)**. 예를 들어 Codex-A, Claude-A, Codex-B, Claude-B의 진행 위치는 모두 별개다.

명령을 받은 작업자는 다음 순서로 실행한다.

1. 현재 `master`의 `docs/relation-factory.md`와 `AGENTS.md`, Canonical 입력을 읽고 **자신의 모델 식별자와 지시된 방식**을 확정한다. 정해지지 않은 C/D 모델 식별자를 임의로 다른 모델로 가장하지 않는다.
2. 샤드 `001`/배치 `01`부터 순서대로 **해당 방식·모델의 파일만** 살핀다. 전체 다른 모델 파일의 완료 여부는 자신의 다음 배치를 막지 않는다. 샤드 폴더/레코드 목록으로 효율적으로 확인하며, 모든 파일을 매번 열어 읽지는 않는다.
3. **master에 파일이 있는 경우** 해당 배치의 500레코드(마지막만 83) 전체 커버리지를 검증한다. 정상 파일만 완료로 본다. 기존 100행 파일·부분 파일은 복구해야 하며 완료로 건너뛰지 않는다.
4. **열려 있는 PR에 해당 파일이 있는 경우** 파일이 500레코드 계약인지 확인한다. **100행 구형 PR이나 미해결 리뷰 지적이 있으면 먼저 수정·정리**한다. 정상 PR이 단지 리뷰 대기 중이라면 같은 파일을 다시 만들지 않고 다음 배치를 찾을 수 있다. 닫힌 미머지 PR은 완료로 간주하지 않는다.
5. **master에도 없고 진행 중 PR에도 없는 첫 배치**를 선택한다. 해당 배치의 정확한 Canonical record/sense로 후보 JSONL을 생성하고 전체 검증 후 PR을 올린다. **한 번의 지시에 한 배치**만 처리한다.
6. PR에 `방식/모델/샤드/배치`, 정확한 Canonical 기준, 후보 0개인 record/sense 수, 검증 결과를 명시한다. 다음 호출은 다시 GitHub 상태를 조회해 다음 작업을 선택한다.

예: `001_01_a_codex.jsonl`, `001_02_a_codex.jsonl`은 완료이고 `001_01_a_claude.jsonl`만 완료됐다면, `#860 A 진행해`를 받은 **Codex는 001_03**, **Claude는 001_02**를 선택한다.

**동시 실행 한계:** GitHub 조회와 PR 생성 사이에 원자적 예약은 없다. **동일한 (방식, 모델)의 생산 작업은 동시에 하나만 실행**한다. 이 전제 없이 동시 시작하면 같은 파일에 대한 중복 작업을 완전히 막을 수 없다. 서로 다른 방식/모델은 파일 소유권이 달라 병렬 실행 가능하다.

## 4. Stage 2 — Relation Admission

**입력:** 해당 샤드의 필수 Stage 1 후보 파일 전체(2배치 × 기본 생산자 6개)와 해당 배치에 오너가 지정한 선택적 파일, Canonical, 기존 승인 Relations. **새 후보 생성이나 문학·말뭉치 재검색을 하지 않는다.**

샤드 내부에서는 출발 source sense별로 작업할 수 있으나 승인/기록은 **샤드 단위로 직렬** 수행한다.

1. A/B/C/D의 후보를 모아 문자열·의미 중복을 검토한다.
2. **필요한 후보만 채택**한다. 모두 수록할 필요가 없으며 0개 채택도 정상. Stage 1 후보는 채택/제외와 관계없이 영구 보관한다.
3. 채택 후보만 말의 결(`near`, `mood`) 또는 연상(`scene`, `sensory`, `action`, `association`)으로 분류한다. 새 STDICT `direct/antonym`은 작성하지 않는다.
4. 동일 출발 sense/동일 UI 그룹의 기존·신규 관계를 비교해 **Tier = relevance 1~9**를 부여한다(1이 최우선, 동순위 허용). 연상 Tier 1은 비공식 유의어 후보급에 한정한다.
5. 정확한 Canonical target record/sense가 확인되면 ID 링크, 아니면 text-only로 확정한다. 같은 이름의 다른 의미에 연결하지 않는다.
6. Typewriter-authored ID↔ID는 양방향 탐색을 제공하되 **반대 방향의 타입/Tier도 별도 편집 판단**이 필요하다. text-only는 역방향이 없다. 샤드 경계를 넘는 역방향 저장/빌드 투영의 소유권은 구현 시 확정한다.

**출력:** 승인된 Relations JSONL. `data/relations/<SSS>.jsonl`은 제안 경로이며 최종 스키마·경로·양방향 투영 규약은 구현 시 확정한다. 재실행 때 중복 관계를 누적하거나 기존 결정을 임의로 삭제하지 않는다.

## 5. Build와 검증 경계

`pnpm run build`는 **Canonical JSONL + 승인된 Relations JSONL**을 읽어 Full/Lite SQLite를 결정적으로 생성한다. **Candidate 파일을 직접 읽어 DB를 만들지 않는다.** STDICT 원본 및 공식 `direct/antonym`은 보존하고, text-only/양방향 관계/방향별 Tier/UI 그룹·정렬을 공통 검증한다.

**현재 상태:** Typewriter-authored 승인 Relations 소스, text-only 타깃, authored ID↔ID 역방향 빌드가 아직 구현되지 않았다. 이 문서는 **생산·구현 계약**이며 이미 빌드가 동작한다는 의미가 아니다. 은퇴한 Lexical Factory와 별도의 Meaning 편집 계층을 되살리지 않는다.
