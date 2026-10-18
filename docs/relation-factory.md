# Relation Factory v1

Typewriter 0.3의 관계 제작 파이프라인. **Stage 1은 관계 후보만 발굴하고, Stage 2는 후보 중 필요한 관계만 확정한다.** 후보와 승인 관계는 각각 JSONL로 영구 보관한다. 사전 편집 기준은 [relation-editorial-policy.md](relation-editorial-policy.md)를 따른다.

```text
Stage 1: A / B / C / D 독립 병렬 생산
    → data/relation-candidates/<shard>/*.jsonl
Stage 2: 샤드별 직렬 Admission (후보 통합·채택·분류·Tier·대상 결속)
    → 승인 Relations JSONL
pnpm run build: Canonical + 승인 Relations
    → Full SQLite → Lite SQLite
```

## 1. 샤드와 배치

기존 STDICT Canonical **428샤드**를 유지하고, 샤드 내 **100레코드씩** 배치로 나눈다. 기준은 sense 수가 아니라 Canonical JSONL의 **레코드 행 순서**다. 한 레코드의 모든 sense는 같은 배치에 속한다.

- 001~427번 샤드: 각 1,000레코드, 배치 `01`~`10`.
- 428번 샤드: 583레코드, 배치 `01`~`06`(마지막 83레코드).
- 전체 427,583레코드 / 4,276배치.
- Stage 1의 결과 단위는 **배치·방식·모델별 파일 하나**, Stage 2의 승인 단위는 **샤드 하나**다. AI가 한 파일을 완성하는 데 여러 턴을 써도 된다.

## 2. Stage 1 — Candidate Generation

### 독립 생산자

| 방식 | 후보 발굴 방법 | 실행 모델 |
| --- | --- | --- |
| A | Canonical 출발 sense의 뜻풀이에서 직접 발굴 | Codex, Claude |
| B | 출발 sense에 맞는 가상 장면을 구성한 뒤 발굴 | Codex, Claude |
| C | 기존 저작권 만료 문학 SQLite의 실제 문맥 참조 | 단일 모델 |
| D | 기존 문어 말뭉치 SQLite의 실제 문맥 참조 | 단일 모델 |

- **A와 B는 별개 작업**이다. 같은 모델이라도 한 턴으로 합치지 않는다.
- A/B 후보가 빈약하거나 다양성이 부족할 때 **DeepSeek A 및/또는 B**를 선택적으로 추가한다. 단순한 개수 quota는 두지 않는다.
- 생산자는 같은 Canonical record/sense를 사용하지만 **다른 생산자의 후보를 읽지 않는다**. 방식·모델 간 중복은 Stage 2에서 처리한다.
- **A/B/C/D는 병렬 생산 가능**하다. C와 D는 서로 다른 SQLite 자료를 사용하며 각 한 모델만 실행한다.
- Stage 1은 **후보 문자열만** 기록한다. 채택/제외, 말의 결·연상 타입, Tier, 대상 Canonical ID는 판단하지 않는다.
- 보호된 원문·발췌문·TXT/JSON/SQLite 원본은 저장소와 후보 파일에 넣지 않는다. 자료 이용·외부 모델 전송·결과 공개 조건은 준수한다.

### 후보 파일 구조

```text
data/relation-candidates/
  001/
    001_01_a_codex.jsonl
    001_01_a_claude.jsonl
    001_01_b_codex.jsonl
    001_01_b_claude.jsonl
    001_01_c_codex.jsonl
    001_01_d_codex.jsonl
    001_01_a_deepseek.jsonl   # 선택
    001_01_b_deepseek.jsonl   # 선택
    001_02_a_codex.jsonl
    ...
  002/
    ...
```

경로: `data/relation-candidates/<SSS>/<SSS>_<BB>_<method>_<model>.jsonl`.

- `SSS`: 샤드 번호 3자리, `BB`: 배치 번호 2자리, `method`: `a|b|c|d`.
- `model`: 실행한 모델의 소문자 식별자. C/D의 실제 모델은 실행 시 결정한다.
- 기본 **6개 파일/배치**(A 2개, B 2개, C 1개, D 1개), DeepSeek 선택 시 최대 **8개**.
- 각 작업자는 **자신의 파일만** 작성한다. 여러 완료 파일을 한 PR에 묶을 수 있다.
- 후보 파일은 Stage 2에서 제외한 표현도 포함해 **영구 보존**한다.

### Candidate JSONL v1

**Canonical 레코드 한 개를 JSONL 한 줄로 기록한다.** 전체 record/sense를 포함하며, 후보가 없으면 빈 배열을 기록한다.

```jsonl
{"record_id":"w001","senses":[{"sense_id":"w001-s1","candidates":["농지","쟁기","흙냄새"]}]}
{"record_id":"w002","senses":[{"sense_id":"w002-s1","candidates":[]},{"sense_id":"w002-s2","candidates":["덧셈","합계"]}]}
```

*후보 문자열은 형식 예시이며 승인된 관계가 아니다.*

| 필드 | 형식 | 역할 |
| --- | --- | --- |
| `record_id` | string | Canonical 출발 record ID |
| `senses` | array | 해당 record의 모든 sense |
| `sense_id` | string | Canonical 출발 sense ID |
| `candidates` | string[] | 발견한 후보 문자열 목록. 빈 배열 허용 |

**후보에는** `type`, `tier/relevance`, `target_id`, `keep/reject`, 근거 문장 등을 **넣지 않는다**. `lemma`와 `gloss`는 Canonical에 있고, 방식/모델은 파일명에 있다.

**Stage 1 공통 검증:**
1. 각 행은 지정된 네 필드 구조의 유효한 JSON 객체이며, 후보는 비어 있지 않은 문자열이다(앞뒤 공백 제거, 파일 내부 동일 sense 중복 제거).
2. 파일은 해당 배치의 Canonical 레코드를 **누락·중복 없이 원래 순서대로** 모두 포함한다. `sense_id`도 각각 실제 record에 속한 전체 sense와 일치해야 한다.
3. `candidates: []`는 정상 생성 결과이고, 행/sense 누락·미완료 파일은 오류다. 필수 생산자 파일과 선택적 DeepSeek 미실행을 구분한다.
4. 커밋 전 파일 전체를 검증한다. **검증된 완료 파일만** Stage 2 입력으로 인정한다.

## 3. Stage 2 — Relation Admission

**입력:** 한 샤드의 Stage 1 완료 후보 파일 전체 + Canonical + 기존 승인 관계(있는 경우). **새 후보 탐색·문학/말뭉치 검색은 하지 않는다.** 샤드 내 편집은 배치/출발 sense별로 나누어 수행할 수 있다.

각 출발 sense별로 다음을 수행한다.

1. 모든 모델/방식의 후보 문자열을 합치고 단순·의미 중복을 검토한다.
2. **채택/제외**한다. Stage 1 후보를 **전부 수록할 의무는 없고**, 승인 관계 0개도 가능하다. 원래 후보 파일은 고치지 않는다.
3. 채택 후보에만 말의 결(`near`, `mood`) 또는 연상(`scene`, `sensory`, `action`, `association`) **type**을 부여한다. 신규 공식 `direct/antonym`을 만들지 않는다.
4. 같은 출발 sense의 **같은 UI 그룹**에서 기존·신규 관계를 함께 비교해 **relevance 1~9**를 부여한다. 낮은 숫자가 높은 우선순위다. 연상 Tier 1은 비공식 유의어 후보급의 가까운 대안에만 적용한다.
5. 대상의 정확한 Canonical record/sense가 확인되면 **ID 링크**, 없으면 **text-only**로 승인한다. 동음이의어를 문자열만으로 임의 결속하지 않는다.
6. 승인된 Typewriter-authored ID↔ID 관계는 **양방향 탐색**을 제공하되 각 방향의 타입·Tier는 해당 출발어 관점에서 별도로 판단한다. text-only는 역방향이 없다. **다른 샤드의 승인 파일을 덮어쓰지 않도록** 역방향 저장/투영 규약을 구현 전에 확정한다.

**출력:** 별도의 승인 Relations JSONL. 위치 후보는 `data/relations/<SSS>.jsonl`이며 **실제 스키마와 경로는 빌드 구현에서 확정**한다. 동일한 입력의 재실행은 중복 생성이나 임의 삭제 없이 결정적·멱등적이어야 한다.

Stage 2는 샤드별로 **직렬 수행**한다. Stage 2가 한 샤드를 편집하는 동안 다른 샤드의 Stage 1은 계속 병렬 생산할 수 있다.

## 4. Build

`pnpm run build`에서 **Canonical JSONL + 승인된 Relations JSONL**로 Full/Lite SQLite를 생성한다. **Candidate JSONL은 Build 입력이 아니다.**

- 기존 STDICT Canonical 및 공식 `direct/antonym` 투영을 보존한다.
- 승인 관계의 ID 링크와 text-only, 양방향 탐색·방향별 Tier, UI 그룹, 정렬, 검색/페이지네이션, Full→Lite 재현성을 검증한다.
- generated SQLite를 수작업으로 수정하지 않고, 폐기된 Lexical Factory 또는 `data/meanings/` 계층을 재도입하지 않는다.
- **현재 구현은 Canonical-only**이며 authored Relations source, text-only, 양방향 authored 관계 빌드는 아직 없다. 이 문서는 구현 계약이지 구현 완료 선언이 아니다.

## 5. 구현 전 확인 사항

- Stage 1: 배치 입력 범위와 필수 파일의 완전성, 모든 source record/sense 커버리지, 파일별 독립성.
- Stage 2: 실제 후보 선택/제외·타입·Tier 판단, 정확한 대상 결속, 샤드 간 역방향 처리, 멱등성.
- Build: 승인 Relations 투영, 공통 회귀 테스트, 데이터·DB 크기/조회 성능.
- 100레코드 실배치에서 후보가 있는 sense·실제 승인 레코드 비율, 생성/편집 토큰과 시간을 **실측**하여 작업량을 평가한다.
