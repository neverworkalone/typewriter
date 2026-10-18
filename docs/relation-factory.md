# Relation Factory v1

Typewriter 0.3의 관계 제작 파이프라인. 상위 기준은 [#838](https://github.com/neverworkalone/typewriter/issues/838)의 2026-10-18 오너 결정(**3단계 누적 프로토콜**)이며, 이 문서는 그 실행 계약이다. 충돌하면 #838이 우선한다. 사전 편집 기준은 [relation-editorial-policy.md](relation-editorial-policy.md)를 따른다.

```text
Stage 1: A+B 기본 관계 집합 (한 작업 턴, 모델별 Codex·Claude)
    → Stage 2: C 문학 문맥 보강 (Stage 1 결과에 추가)
    → Stage 3: D 문어 말뭉치 보강 (Stage 1+2 결과에 추가)
    → 통합 편집 게이트 (독립 검수·최종 승인)
    → 승인 Relations JSONL
pnpm run build: Canonical + 승인 Relations
    → Full SQLite → Lite SQLite
```

Stage 1→2→3은 **순차 누적**이다. 앞 단계 결과를 지우거나 덮어쓰지 않고 새 관계와 출처를 **추가**한다. 병렬화는 서로 다른 배치·샤드 사이에서만 한다. 폐기된 Lexical Factory의 Stage 1/2/3과는 별개의 절차다.

## 1. 샤드와 배치

기존 STDICT Canonical **428샤드**를 유지하고, 샤드 내 **100레코드씩** 배치로 나눈다. 기준은 sense 수가 아니라 Canonical JSONL의 **레코드 행 순서**이며, 한 레코드의 모든 sense는 같은 배치에 속한다.

- 001~427번 샤드: 각 1,000레코드, 배치 `01`~`10`.
- 428번 샤드: 583레코드, 배치 `01`~`06`(마지막 83레코드).
- 전체 427,583레코드 / 4,276배치.
- 작업 단위는 **배치 하나**다. 한 단계를 끝내는 데 여러 턴을 써도 된다.

## 2. 단계별 절차

모든 단계는 같은 Canonical 출발 record/sense/뜻풀이를 사용하고, **관계 개수 목표나 채우기 quota를 두지 않는다**(후보가 없으면 0개).

### Stage 1 — A+B 기본 관계 집합 (한 작업 턴)

- 한 모델이 **하나의 작업 턴**에서 A(뜻풀이 직접 생성)와 B(먼저 가상 장면을 구성한 뒤 후보 추출)를 **둘 다** 실행한다. A/B 생성 구간을 내부에서 구분하되, 한 턴이 엄격한 블라인드 독립성을 보장하지는 않는다는 점을 기록에 남긴다.
- 우선 모델은 **Codex와 Claude**다. 두 모델은 서로의 결과를 보지 않고 각자 독립 생산한 뒤 통합한다. 후보가 빈약하면 DeepSeek을 선택적으로 추가할 수 있다.
- 말의 결·연상의 기본 범위를 폭넓게 구성한다. 이 단계부터 **타입, 출발·대상 sense, relevance, 출처**를 기록한다.

### Stage 2 — C 문학 문맥 보강

- Stage 1의 완성된 집합을 **보존**한 채 기존 저작권 만료 문학 SQLite(읽기 전용)에서 출발 sense의 실제 용례를 제한적으로 찾아 새 정서·감각·장면·행동·비유 표현을 **추가**한다.
- 같은 문자열·실질적 중복을 검토하되 고유한 이미지와 희소한 연결을 자동 배제하지 않는다. 단일 작품·짧은 문맥의 우연한 공출현을 보편적 관계로 오인하지 않는다.

### Stage 3 — D 문어 말뭉치 보강

- Stage 1+2의 누적 집합을 보존한 채 기존 국립국어원 문어 말뭉치 SQLite(읽기 전용)에서 앞 단계에 없던 실제 사용 장면·표현을 **추가**한다.
- 정확한 동음이의어·활용형·sense를 확인한다. 근거가 없는 출발어는 `no useful evidence`로 남기고 관계를 채우지 않는다. 검색 자료의 범주 편중은 보고하고 일반 문어 다양성으로 과장하지 않는다.

### 공통 규칙

- 다음 단계로 넘길 때 기존 관계를 삭제하거나 이전 결론을 덮어쓰지 않는다.
- 자료 규칙: 보호된 원문·발췌문·TXT/JSON/SQLite 원본은 저장소·PR·CI·제품에 넣지 않는다. 기존 SQLite는 읽기 전용으로 재사용하고, 저작권·외부 모델 전송·결과 공개 조건을 각각 확인한다.
- 생산 전 출발 **sense ID와 뜻풀이를 고정**해 단계·모델 간 의미 불일치를 막는다. 정책 예시(특히 `나그네`)는 성능 평가 표본에서 제외하고 필요한 편집 규칙만 모델에 준다.
- 신규 공식 `direct/antonym`은 만들지 않는다.

## 3. 파일과 스키마

경로: `data/relation-drafts/<SSS>/<SSS>_<BB>.jsonl` — **배치당 누적 파일 하나**. `SSS`는 샤드 3자리, `BB`는 배치 2자리. 각 단계는 같은 파일에 관계와 출처를 추가한다. Stage 1에서 모델별 결과를 통합하기 전의 작업 산출물은 로컬 캐시에 두고, 커밋 대상은 누적 파일이다.

**Canonical 레코드 한 개를 JSONL 한 줄로 기록**하며, 관계가 없으면 `relations`를 빈 배열로 둔다.

```jsonl
{"record_id":"w001","senses":[{"sense_id":"w001-s1","relations":[{"text":"쟁기","target_id":null,"type":"scene","relevance":4,"sources":[{"stage":1,"method":"b","model":"codex"},{"stage":2,"method":"c","model":"claude"}]}]}]}
```

*값은 형식 예시이며 승인된 관계가 아니다.*

| 필드 | 형식 | 역할 |
| --- | --- | --- |
| `record_id`, `sense_id` | string | Canonical 출발 record/sense |
| `relations[].text` | string | 대상 표현 |
| `relations[].target_id` | string \| null | 정확한 대상 Canonical record/sense ID, 없으면 `null`(text-only) |
| `relations[].type` | `near`\|`mood`\|`scene`\|`sensory`\|`action`\|`association` | 말의 결·연상 타입 |
| `relations[].relevance` | 1..9 | 같은 출발 sense·UI 그룹 안의 상대 우선순위(1이 최우선) |
| `relations[].sources` | array | 발견한 `stage`(1\|2\|3), `method`(a\|b\|c\|d), `model`. 자료 버전은 집계 메타로 기록 |

- 같은 대상을 여러 단계·모델이 독립 발견하면 **관계 한 건에 출처를 병합**한다. 의미가 다른 후보를 문자열 동일성만으로 합치지 않는다.
- 동음이의어는 문자열만으로 대상 ID에 결속하지 않는다. 확인되지 않으면 text-only다.
- 연상 Tier 1은 비공식 유의어 후보급의 가까운 대안에만 준다.
- 생산자의 `keep/revise/reject` 표시는 승인이 아니다.

**단계 공통 검증:**
1. 각 행은 위 구조의 유효한 JSON이고, `type`·`relevance`·`target_id`가 규칙에 맞으며 같은 sense 안에서 (`text`, `target_id`) 중복이 없다.
2. 파일은 해당 배치의 Canonical 레코드·sense를 **누락·중복 없이 원래 순서대로** 포함한다.
3. 이전 단계의 관계와 출처가 **삭제·변경 없이 보존**되고 새 단계는 출처만 추가한다.
4. 커밋 전 파일 전체를 검증한다. 검증된 완료 파일만 다음 단계 입력으로 인정한다.

## 4. 통합 편집 게이트와 승인

최종 승인은 생산자 자체 표시가 아니라 **독립 검수**가 한다. 검수는 정확한 출발/대상 sense, 타입, 공식 STDICT `direct/antonym`과의 경계, 그룹 내 상대 relevance, 실제 글쓰기 활용성을 평가한다. 비유·문학적 연상을 사전 동의어 기준으로만 배제하지 않고, 의미가 명백히 틀린 관계와 잘못된 ID는 거른다. 에이전트 자체 점검은 독립 검수로 표기하지 않는다.

- 승인 관계 중 Typewriter-authored ID↔ID는 **양방향 탐색**을 제공하되 각 방향의 타입·Tier는 해당 출발어 관점에서 따로 판단한다. text-only는 역방향이 없다. 샤드 간 역방향 저장/투영 규약은 구현 전에 확정한다.
- 승인은 샤드별로 **직렬** 수행하고, 다른 샤드의 생산은 병렬로 계속할 수 있다.
- **출력:** 승인 Relations JSONL. 위치 후보는 `data/relations/<SSS>.jsonl`이며 실제 스키마와 경로는 빌드 구현에서 확정한다. 같은 입력의 재실행은 결정적·멱등적이어야 한다.
- 단계·모델별 신규 **독립 검수 통과 관계 수**, 중복·보류·제외, 추가 시간·토큰·검색 비용, 결과 다양성을 실측해 후속 최적화에 쓴다. 생성 후보 수는 품질 목표가 아니다.

## 5. Build

`pnpm run build`에서 **Canonical JSONL + 승인된 Relations JSONL**로 Full/Lite SQLite를 생성한다. **draft 파일은 Build 입력이 아니다.**

- 기존 STDICT Canonical 및 공식 `direct/antonym` 투영을 보존한다.
- 승인 관계의 ID 링크와 text-only, 양방향 탐색·방향별 Tier, UI 그룹, 정렬, 검색/페이지네이션, Full→Lite 재현성을 검증한다.
- generated SQLite를 수작업으로 수정하지 않고, 폐기된 Lexical Factory 또는 `data/meanings/` 계층을 재도입하지 않는다.
- **현재 구현은 Canonical-only**이며 authored Relations source, text-only, 양방향 authored 관계 빌드는 아직 없다. 이 문서는 구현 계약이지 구현 완료 선언이 아니다. 구현 게이트 통과 전에는 draft를 프로덕션·Canonical에 승격하지 않는다.

## 6. 구현 전 확인 사항

- 단계 누적: 이전 단계 보존, 출처 병합, 필수 단계 순서, 모든 source record/sense 커버리지.
- 승인: 독립 검수 기록, 정확한 대상 결속, 샤드 간 역방향 처리, 멱등성.
- Build: 승인 Relations 투영, 공통 회귀 테스트, 데이터·DB 크기/조회 성능.
- 100레코드 실배치에서 관계가 있는 sense·승인 비율, 생성/편집 토큰과 시간을 **실측**하여 작업량을 평가하고, 오너가 확대 여부를 결정한다.
