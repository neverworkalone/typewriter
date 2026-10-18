# Relation Factory v1 — 관계 후보 생산과 Relations 편집

> **Typewriter 0.3 · 아키텍처/실행 계약 (2026-10-18 오너 결정)**
>
> 상태: **설계 문서**. 이 문서를 추가하는 PR은 Factory 실행 코드·후보 데이터·Relations·SQLite를 변경하지 않는다.
> 상위 제품/편집 정책은 [#838](https://github.com/neverworkalone/typewriter/issues/838), 생성 방식 실험은 [#841](https://github.com/neverworkalone/typewriter/issues/841), 편집 타입/Tier 기준은 [relation-editorial-policy.md](relation-editorial-policy.md)를 따른다. 본 문서의 **A/B 독립 병렬·2단계 작업 경계**는 #838의 2026-10-18 초기 `A+B 한 턴` 초안보다 **나중에 확정된 오너 결정**이다. 정책 문서와 AGENTS.md의 오래된 실행 문구는 별도 동기화가 필요하다.

## 1. 목적과 변하지 않는 원칙

STDICT 원본을 한 번 Canonical JSONL로 확보한 뒤 Meaning·유의어·SQLite를 빠르게 재생성했듯이, 관계도 **느린 후보 발굴을 한 번 실행해 JSONL 자산으로 보존**하고, 이후 빠른 관계 편집과 빌드를 반복한다.

```text
[Stage 1] Candidate Generation (A, B, C, D 독립 병렬)
  └─ data/relation-candidates/<shard>/<shard>_<batch>_<method>_<model>.jsonl
      └─ 생성한 후보 문자열을 전부 보존 (채택 여부/타입/Tier 없음)
                ↓
[Stage 2] Relation Admission (샤드 단위 직렬 편집)
  └─ 기존 후보만 통합 → 선택/제외 → 말의 결·연상 분류 → Tier → target 결속
      └─ Typewriter-authored Relations JSONL (승인된 편집 원본)
                ↓
[pnpm run build] Canonical JSONL + 승인된 Relations JSONL
  └─ Full SQLite → 검증된 Lite SQLite → Extension
```

- **Candidate는 영구 보관할 원재료**다. Stage 2가 제외한 후보도 삭제하지 않는다.
- **Stage 1은 후보 발굴만** 한다. 채택/제외, `type`, `relevance`(Tier), 대상 사전 ID 결속을 결정하지 않는다.
- **Stage 2는 후보 탐색을 하지 않는다.** 제공된 후보 중 유용한 것만 채택한다. 후보 전량 수록 의무나 수량 quota는 없다.
- **Build는 후보 파일을 읽거나 편집 판단을 하지 않는다.** 승인된 Relations만 정해진 방식으로 SQLite에 투영한다. Canonical 원본은 변경하지 않는다.
- 이는 #823에서 폐기한 **Lexical Factory를 복원하는 작업이 아니다.** Typewriter 0.3의 새 Relation Factory다.

## 2. 처리 단위: 기존 428샤드, 100레코드 배치

현재 STDICT Canonical은 `stdict-0001.jsonl` ~ `stdict-0428.jsonl`, **428개 샤드 / 427,583레코드 / 499,359 sense**다([settlement](../data/provenance/stdict-settlement.json)).

- 기존 샤드 경계와 Canonical 행 순서를 변경하지 않는다.
- **샤드마다 Canonical 레코드 100개씩 배치**한다. sense 100개 단위가 아니다. 한 레코드의 여러 sense는 같은 배치에서 모두 처리한다.
- 일반 샤드는 1,000레코드 → **배치 01~10**; 마지막 428번 샤드는 583레코드 → **배치 01~06**(마지막 83레코드). 전체 **4,276배치**다.
- 배치의 입력 범위는 **해당 샤드의 Canonical 행 위치**로 결정한다(01=1~100, 02=101~200, …). 서로 다른 파일의 같은 문자열·동음이의어를 합쳐 배치하지 않는다.
- 한 배치의 후보 생성은 AI 내부에서 여러 턴에 걸쳐도 된다. **산출물 계약은 배치당·생산자당 파일 하나**이며, 중단/재개 시에는 완료한 레코드가 누락되거나 중복되지 않아야 한다.
- Stage 1 생산 완료 단위는 **배치/생산자 파일**; Stage 2 최종 승인/저장 단위는 **샤드**다. Stage 2가 메모리를 절약하려면 샤드 내부를 배치/출발 sense별로 처리할 수 있다.

## 3. 파일 배치와 독립 생산자

```text
data/
  canonical/
    stdict-0001.jsonl         # 보존: STDICT Canonical
    ...
  relation-candidates/
    001/
      001_01_a_codex.jsonl
      001_01_a_claude.jsonl
      001_01_b_codex.jsonl
      001_01_b_claude.jsonl
      001_01_c_codex.jsonl
      001_01_d_codex.jsonl
      001_01_a_deepseek.jsonl   # 필요할 때만
      001_01_b_deepseek.jsonl   # 필요할 때만
      001_02_a_codex.jsonl
      ...
      001_10_d_codex.jsonl
    002/
      ...
    428/
      ...
  relations/                   # 제안된 승인 원본 위치: 구현 전에 확정
    001.jsonl
    ...
```

- 경로 계약: `data/relation-candidates/<SSS>/<SSS>_<BB>_<m>_<model>.jsonl`. SSS는 001~428, BB는 01~10(마지막 샤드 01~06), m은 `a|b|c|d`, model은 소문자 생산 모델 식별자다.
- **A**: 출발 표제어의 정확한 뜻풀이를 기반으로 직접 후보를 발굴한다. **Codex, Claude** 각각 독립 실행.
- **B**: 출발 의미에 맞는 장면을 먼저 상상한 후 후보를 발굴한다. **Codex, Claude** 각각 독립 실행. **A와 B는 한 턴으로 묶지 않고 별도 작업**이다.
- **DeepSeek**: A 또는 B의 후보가 부족하다고 판단되는 범위에 **선택적으로 추가**한다. 단순 후보 수 quota가 아니라 유효한 표현 폭/다양성을 보고 판단한다. 미실행 파일은 없어야 하며 빈 파일로 가장하지 않는다.
- **C**: 기존 만료저작물 문학 SQLite에서 실제 문맥을 참조해 후보를 발굴한다. **단일 모델**.
- **D**: 기존 국립국어원 문어 말뭉치 SQLite에서 실제 문맥을 참조해 후보를 발굴한다. **단일 모델**.
- 기본 **6개 생산 파일/배치**(A 두 모델, B 두 모델, C 한 모델, D 한 모델), 선택적 DeepSeek 추가 시 최대 **8개**. 기본 25,656개, 최대 34,208개 파일이므로 **샤드별 폴더**로 관리한다. C/D 생산 모델 이름은 실행 전에 선택해 파일명에 반영한다; 예시는 Codex다.
- **A, B, C, D 및 각 모델은 서로의 후보를 읽고 따라 하지 않는다.** 동일한 Canonical 출발 record/sense를 기준으로 별도 작업/별도 파일을 생성한다. 생산자의 파일 소유권을 분리하므로 샤드·배치별 후보 생산을 병렬화할 수 있다.
- 파일 하나마다 PR을 강제하지 않는다. **서로 충돌하지 않는 완성 파일을 여러 개 묶어 PR 제출**할 수 있다. 후보 자산은 Admission 후에도 Git에서 유지한다.

## 4. Candidate JSONL Schema v1 — 원재료만

**레코드 1개 = JSONL 한 줄**, 해당 레코드의 **모든 sense**와 각 sense가 발견한 **후보 문자열 배열**을 담는다. Canonical 자체의 `lemma`, `gloss`, 대상 ID, 생성 방법/모델을 행마다 복제하지 않는다(방법/모델은 파일명에 있다).

```jsonl
{"record_id":"w001","senses":[{"sense_id":"w001-s1","candidates":["농지","쟁기","흙냄새"]}]}
{"record_id":"w002","senses":[{"sense_id":"w002-s1","candidates":[]},{"sense_id":"w002-s2","candidates":["덧셈","합계"]}]}
```

> 위 후보 문자열은 **스키마 예시일 뿐** 아직 생성·승인된 Typewriter 관계가 아니다. `w001` 및 `w002`의 record/sense 구조는 기존 Canonical과 일치한다.

| 필드 | 형식 | 필수 | 뜻 |
| --- | --- | --- | --- |
| `record_id` | Canonical record ID | O | 대상 **출발 레코드**. 현재 `w숫자` 형식 |
| `senses` | array | O | 해당 레코드의 Canonical sense를 순서대로 모두 포함 |
| `sense_id` | Canonical sense ID | O | 각 출발 의미(`w숫자-s숫자`) |
| `candidates` | string[] | O | 그 의미에서 발견한 후보의 표시 문자열. **빈 배열 허용** |

**Candidate에 넣지 않는 것:** `type`, `tier`, `relevance`, `target_record_id`, `target_sense_id`, `keep/reject`, `status`, `confidence`, `reason`, 원본 문학/말뭉치 발췌문, AI 추론 기록.

Validation 계약:
1. **JSONL 각 행은 JSON 객체 1개**(JSON 배열 전체를 파일 한 번에 쓰지 않음). 허용 필드는 위 네 이름만 사용하며 구조 외 필드는 거부한다.
2. 파일 내 record는 배치의 Canonical record를 **빠짐없이, 중복 없이, 같은 순서로** 수록한다. 각 record의 `senses`도 Canonical sense와 정확히 일치해야 한다.
3. 후보 0건은 `candidates: []`로 표시한다. 반면 **레코드 행·sense 자체 누락은 실패**다. 비어 있는 후보를 억지로 채우지 않는다.
4. 후보 문자열은 빈 문자열·공백만 있는 문자열을 금지하고 앞뒤 공백을 제거한다. 하나의 source sense/한 생산 파일 내 동일한 문자열은 중복 기록하지 않는다. 모델 **간** 중복은 허용하며 Stage 2가 통합한다.
5. 파일 경로의 샤드/배치가 Canonical 행 범위와 일치해야 한다. JSONL을 처음부터 전체 파일로 재검증하여 부분 기록·중단 상태를 **완료 파일로 오인하지 않는다**.
6. Stage 1의 검사 대상은 **형식/커버리지/명백히 잘못된 출발 의미 결속**이다. 후보의 관계 타입/Tier나 최종 채택률을 여기서 심사하지 않는다.

## 5. Stage 1 — Candidate Generation

- 공통 입력은 해당 배치의 정확한 **Canonical record와 각 sense의 뜻풀이**. A/B는 문학·말뭉치 DB를 사용하지 않고, C/D는 각각 허용된 **기존 읽기 전용 SQLite**를 조회한다.
- A/B/C/D는 생성 경로만 다를 뿐 **동일한 Candidate v1 형식**을 낸다. 개수 상한/최소 수록량을 맞추기 위한 생성은 금지한다.
- 문어·문학에서 문장에 단순히 함께 등장했다는 사실만으로 관계를 확정하지 않는다. 출발 sense가 다른 실제 용례는 생성에 이용하지 않는다. 일치하는 근거가 없으면 해당 후보 목록은 비워 둔다.
- 보호된 **원문, 문맥 발췌, 문학 TXT, 말뭉치 JSON, SQLite DB, 증거 묶음**은 후보 Git 파일이나 제품/CI에 올리지 않는다. 실제 C/D 소스는 현행 이용 허가와 외부 모델 전송·결과 공개 범위 안에서만 사용한다.
- 최종 후보 파일을 **검증해 커밋하면 자산 확보가 끝난다.** 모든 대상의 후보가 확보된 뒤 제품 빌드/Stage 2가 원래의 로컬 문학·말뭉치 인덱스를 읽을 이유는 없다. 단, 원본을 지우면 신규 발굴이나 원문 재검증을 위해 다시 확보해야 할 수 있고, 이용 허가/보존 의무는 별도로 따른다.

## 6. Stage 2 — Relation Admission

**입력**: 동일 샤드에 대해 Stage 1이 제출한 모든 완료 후보 파일 + 현재 Canonical + 기존 승인 Relations(있는 경우). **외부 문학/말뭉치 검색과 신규 후보 생성 없음.**

출발 `source_sense_id`별로:
1. 모든 A/B/C/D·모델 후보 문자열을 모으고 기계적 동일 문자열 중복을 제거한다. 문맥에 따라 다른 의미일 수 있으므로 문자열 중복만으로 최종 의미 동일을 단정하지 않는다.
2. **채택/제외**를 판단한다. 창작에 도움이 되는 낯선 연결도 검토하되, 무관한 연결·잘못된 의미·쓸모없는 반복은 버릴 수 있다. **후보 전량 채택 의무 없음**; 후보가 있어도 승인 관계 0개 가능. 제외한 후보는 Stage 1 파일에서 삭제하지 않는다.
3. 채택 후보에만 **말의 결**(`near`/`mood`) 또는 **연상**(`scene`/`sensory`/`action`/`association`)의 `type`을 편집한다. STDICT 공식 `direct`/`antonym`을 새로 집필하지 않는다.
4. 채택 후보에만 같은 출발 의미·**같은 UI 그룹**의 기존/신규 관계를 비교해 `relevance` **1~9**를 부여한다(1이 최우선, 동점 가능, 수량 quota 없음). **연상 Tier 1은 가까운 비공식 유의어 후보급**이라는 #838 편집 기준을 적용한다.
5. 현재 Canonical에서 후보의 **정확한 표제어·동음이의어·sense**가 확인되면 대상 ID를 연결하고, 없으면 **text-only**로 남긴다. 가짜 ID·임의의 첫 번째 동음이의어 결속 금지.
6. 기존 `direct/antonym`의 원본 투영을 손대지 않는다. 새 Typewriter-authored **ID↔ID 관계는 양방향 탐색을 제공**해야 하며 방향별 타입/Tier는 각각 편집한 결과여야 한다. Stage 2에서 반대 방향을 검토하는 것은 **승인한 관계의 방향별 판정**이지 새로운 후보 발굴이 아니다. **다른 샤드의 출력 파일을 동시에 덮어쓰지 않도록** 승인 원본의 역방향 표현/소유권과 빌드 투영 계약은 구현 단계에서 결정한다. text-only에는 역방향이 없다.
7. 샤드 내부를 여러 작업으로 나누어 검수할 수 있지만, **샤드 승인 결과는 결정적이고 멱등적**이어야 한다. 같은 입력을 다시 처리해도 관계가 중복되거나 사라지지 않아야 하며, 재편집은 명시된 변경으로 남긴다.

**출력**: 별도 승인 Relations JSONL (경로 예: `data/relations/001.jsonl`). 이 결과가 **Typewriter-authored 관계의 편집 원본**이다. 기존 Stage 1 후보를 다시 생산하거나 교체하지 않는다. 최종 Relations의 정확한 행 스키마는 현행 Meaning/SQLite 계약을 고려해 **후속 구현에서 정한다**; Candidate v1의 단순함을 핑계로 승인 데이터까지 미정의 ID/타입/Tier 없이 만들지 않는다.

## 7. Build 통합 — 결정적 파생물

- `pnpm run build`는 **Canonical JSONL + 승인된 Relations JSONL**을 입력으로 기존 한 record = 한 Meaning 투영을 유지한다. Candidate는 빌드 입력이 아니다.
- 새 authored 관계는 Full/Lite SQLite와 UI/검색에 정확히 반영된다. source/target 정확성, 두 대상 모드(ID 링크·text-only), 양방향 탐색, 방향별 Tier, 정렬·중복 제거, 페이지네이션, 오프라인·옵션 토글을 공통 테스트로 검증한다.
- 기존 **STDICT Canonical 원본·공식 유의어/반의어**, Full→Lite 경계, build reproducibility를 보존한다. SQLite 수작업 수정, 은퇴한 `data/meanings/` 재도입, 외부 AI 온라인 런타임 의존성은 금지한다.
- **현재 구현 상태:** `docs/meaning-layer.md` 기준으로 빌드는 Canonical-only, `target_meaning_id NOT NULL`이고 text-only 및 Typewriter-authored 관계의 별도 source/양방향 투영이 아직 없다. **본 PR은 문서 설계만 제출**하며 이 기능들이 이미 동작한다고 주장하지 않는다.

## 8. 병렬 운영, 완료 조건, 후속 검증

- 각 Stage 1 작업은 **자기 `<shard>_<batch>_<method>_<model>.jsonl` 파일만 작성**한다. 다른 작업 결과를 읽거나 수정하지 않는다.
- 선택적 DeepSeek 파일은 미실행을 정상적으로 표시할 수 있도록 **요구 작업 목록에서만 선택적으로 추가**한다. 필수 생산 작업 미완료/실패/부분 업로드를 `candidates: []`와 혼동하지 않는다. Admission은 해당 샤드의 필수 후보 파일이 모두 검증 완료된 다음 시작한다.
- 샤드별 Admission은 우선 **직렬**로 수행한다. Stage 2가 샤드 001을 처리하는 동안 Stage 1은 샤드 002~ 이후 후보를 계속 생산할 수 있다.
- PR은 후보 파일 묶음이나 승인 Relations의 **작고 검증 가능한 작업 단위**로 분리한다. 하나의 생산자 실패는 다른 생산자의 자산을 덮어쓰지 않는다.
- **100레코드 배치 파일럿**에서 Stage 1 후보 0개인 source sense/record 비율, Stage 2 실제 채택 레코드 비율(추정상 절반 미만이지만 미측정), 생성/검수 시간과 토큰, 후보·승인 파일 크기, DB 크기/검색 성능을 계측한다. 8개 출발어 실험 #841의 후보 개수를 전체 평균으로 외삽하지 않는다.

### 검증 체크리스트 (구현/파일럿 인수 기준)

- [ ] 428샤드/4,276배치 Canonical 100레코드 경계와 마지막 83레코드를 정확히 처리
- [ ] 모든 필수 생산자 파일의 레코드/sense 100% 커버리지, 부분 업로드·누락·중복을 공통 검증
- [ ] A, B 각각 Codex·Claude 독립 실행; C/D 각각 단일 모델; DeepSeek 선택적. 모델 출력 간 독립성과 경로 소유권 유지
- [ ] Candidate v1에는 후보 문자열만 기록하고 타입/Tier/채택·대상 ID 없음; 모두 영구 보관
- [ ] Stage 2가 후보만으로 채택/제외·타입·Tier·정확한 대상 ID 또는 text-only를 판정하고 새 후보를 검색/발굴하지 않음
- [ ] 승인 Relations의 소유권/양방향 투영과 멱등성 검증; 동일한 입력은 동일한 논리적 결과
- [ ] `pnpm run build`가 승인 Relations만 추가 입력으로 사용하고 Full/Lite/UI 회귀를 모두 통과
- [ ] 원본 Canonical·STDICT `direct/antonym`·라이선스 및 원문 비공개 경계 준수

### 참고

- [#838 Typewriter 0.3 오너 정책](https://github.com/neverworkalone/typewriter/issues/838)
- [#841 A/B/C/D 생성 방식 실험 결과](https://github.com/neverworkalone/typewriter/issues/841)
- [relation-editorial-policy.md](relation-editorial-policy.md)
- [meaning-layer.md](meaning-layer.md)
- [stdict-settlement.json](../data/provenance/stdict-settlement.json)
