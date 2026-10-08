# 문학 근거 품질 검증 계획 (#392 진입 판단용)

상태: 준비 완료, 소유자 판정 대기. 소유자 결정: #391의 22/50 self-check는 검증된 품질 개선이 아니다. #392 진입 게이트는 미충족이며, 이 검증 결과로 #392 진입과 검색기 개선 필요성을 다시 판단한다. 판정 전에는 #392 구현과 검색기·인덱스 개선(`줄` 등)을 시작하지 않는다. Relation Enrichment는 문학 근거 없이 기존 Stage 2 경로를 유지한다.

## 목적과 제약

문학 근거가 Stage 2 **판단을 실제로 개선하는지** 소규모로 검증한다. 검색 가용성·지연이 아니라 판단 품질이 대상이다.

- 추가 AI 모델·서브에이전트·외부 CLI를 호출하지 않는다. 에이전트는 표본 선정·자료 준비·집계만 한다. 의미 판정은 소유자가 위임한 판정자(ChatGPT)가 수행하며, 판정 파일의 `judge`에 판정자를 기록한다(`owner_direct` 또는 `ai_delegate` + 모델명 + `delegated_by: owner`). **AI 위임 판정을 소유자의 직접 판정으로 기록하지 않는다.** `judge`는 닫힌 형식이다: `{kind: owner_direct}` 또는 `{kind: ai_delegate, name, delegated_by: owner}`뿐이며, 모순되거나 추가된 필드(예: 모델명이 붙은 `owner_direct`, 검증 불가한 보증 플래그)는 봉인과 보고에서 거부한다. 1·2단계 판정자 종류가 달라도 허용하되 보고서에 정확히 밝힌다. 이 저장소의 에이전트(Claude)는 판정하지 않는다. 최종 제품 결정(#392 진입 여부 포함)은 소유자가 한다.
- #391 self-check 결과는 층화 기준일 뿐 정답이 아니다. 정본·과거 결정은 바꾸지 않는다.
- 원문·근거 팩·맹검 자료·층 매핑은 로컬(`~/.cache/typewriter/evidence/validation-392/`)에만 둔다. Git에는 선정 규칙·도구·집계(텍스트 없음)만 둔다.

## 표본 (12건; 전부 기존 `literature-evidence-selfcheck-391.json`에서)

| 층 | 건수 | 목적 |
|---|---|---|
| deferred · supports (`resolved_*`) | 4 | 긍정 |
| deferred · no_effect | 2 | 무효 |
| deferred · misleading_noise | 3 | 노이즈 (핵심 위험) |
| deferred · exposes_other_sense | 1 | 과잉 분할/오해 교정 |
| clear_included 대조 | 2 | 이미 맞는 결정이 흔들리지 않는가 |

**deferred는 4+2+3+1 = 10건이며, 판정 기준의 분모는 이 10건 전체다.** 특정 층을 제외하지 않는다. (이전 초안의 "7건"은 합산 오류였고 폐기한다.) 대조 2건은 deferred 분모에 넣지 않고 안정성·해악 기준에만 쓴다.

선정은 `literature-validation.mjs`의 `selectCohort`가 결정한다: 각 층에서 `sha256("validation-392:" + 후보 id)` 순으로 앞에서 `count`건. 소유자에게 보이는 순서와 `V01`–`V12` 라벨은 `sha256("order-392:" + 후보 id)` 순이다. 코호트 digest(`sha256(JSON(cohort))`): `4a3a8518ee7ffab9826da1f2961898e50dea5ee90517a4d134b50c753a74b61c`. 12건 모두 기록된 선택 위치 digest가 재조회 결과와 일치함을 확인했다.

## 맹검과 절차

소유자에게 제공하는 자료(`owner/`)에는 후보 id, 층, self-check 판정, 과거 결론(처분·사유)이 없다. 표제어·POS 가설·관찰 표면형·말뭉치 관찰 문단·현재 기존 항목의 뜻만 있다. 과거에 그 후보가 추가한 뜻은 기존 항목 목록에서 제거했다(대조군이 과거 결론을 드러내지 않도록). 층 매핑(`cohort.local.json`)은 판정이 끝나기 전에 열지 않는다.

1. **1단계(문학 근거 없음)**: 판정자가 `phase1/V??.md`만 보고 `phase1-judgments.json`에 처분(`included|covered|rejected|deferred`), 확신도, 근거를 기록한다. 걸린 초는 측정했을 때만 기록하고, 측정하지 않았으면 `null`로 둔다(0이나 추정치로 대체하지 않는다).
2. **봉인**: `pnpm run reference:literature:validate -- seal`이 모든 항목이 유효한지 확인하고 1단계 파일의 sha256과 시각을 기록한다.
3. **공개**: `-- reveal`은 봉인 digest가 현재 1단계 파일과 같을 때만 문학 근거(`phase2/`, 후보당 최대 5개 문맥)를 생성한다. 봉인은 한 번만 기록된다: 같은 답안·코호트의 재실행만 허용하고, 답안이나 코호트 digest가 다르면 재봉인과 공개 모두 거부한다. 공개된 2단계 답안은 덮어쓰지 않는다.
4. **2단계**: 같은 항목에 처분·확신도·근거·초와 함께 `literature_role`(`helpful|irrelevant|misleading`), `basis_type`(`sense_demonstrated|contrast_exposed|none`), 인용한 문맥 번호, 일반 소스 근거와의 충돌 여부, 최종 기록으로 승인하는지를 기록한다.
5. `-- report`는 봉인을 다시 확인하고, 인용 문맥 번호가 봉인된 코호트의 선택 위치 digest 수(공개 시 실제 조회와 일치 확인) 안에 있는 중복 없는 값인지 검증한 뒤 텍스트 없는 집계만 출력한다. 범위 밖 번호는 오류이며 개선으로 집계되지 않는다.

## "더 나은 확정"의 사전 정의 (판정 전에 고정)

처분이 deferred에서 확정으로 바뀐 것만으로는 개선이 아니다. deferred 사례는 **다음을 모두** 만족할 때만 `improvement`다.

1. 1단계 처분이 `deferred`였다.
2. 2단계가 `included|covered|rejected` 중 하나이고 확신도가 `medium` 이상이다.
3. 문학 근거 역할이 `helpful`이고, 인용 문맥이 1개 이상이며 근거 유형이 `sense_demonstrated`(뜻/용법이 문맥에서 실제로 확인됨) 또는 `contrast_exposed`(과잉 분할·오해를 드러냄)이다. 빈도, 단순 공기, 같은 문자열 일치는 해당하지 않는다.
4. 일반 소스 근거·기존 뜻과 충돌하지 않는다.
5. 소유자가 그 결과를 최종 Stage 2 기록으로 승인한다.

그 밖의 변경은 `unqualified_change`(개선으로 세지 않음), 변경 없음은 `unchanged`다. **해악(`harm`)**은 실제 해로운 변경이나 명시적 소스 충돌이며, 진단용 `literature_role`만으로는 성립하지 않는다: ① 1단계의 `medium` 이상 확정 판단이 *다른 확정 처분*으로 바뀌었고 근거가 `misleading`이거나 소유자가 승인하지 않음; ② 처분이 바뀌어 확정되었고 근거가 `misleading`임; ③ 확정이 일반 소스 근거와 충돌함. 같은 확정 처분을 유지하며 오도 문맥을 무시한 경우는 `unchanged`, 소유자가 승인한 확정→`deferred`의 신중한 후퇴는 해악이 아니라 `cautious_deferral`로 따로 보고한다.

## 판단 규칙

적용 순서(상호 배타, 위가 우선): ① 검색기 개선 검토 ② #392 진입 후보 ③ 그 외 보류.

- **#392 진입 후보**(①에 해당하지 않을 때만): 해악 0건, 10건 중 `improvement` ≥ 5, 대조 2건 모두 `unchanged`.
- **검색기 개선 검토 후 #392 보류**: 해악 ≥ 1 또는 `misleading` 역할이 12건 중 ≥ 3. 원인이 부분 문자열·동형어·흔한 형 상한·짧은 표제어·다어절 표현 중 무엇인지 귀속해 그 원인에 한정한 별도 이슈를 연다.
- **그 외**: 문학 근거는 선택적 수동 도구로 두고 #392를 보류한다.
- 12건은 방향 판단용이다. 정확도·일반화를 주장하지 않으며 시간 측정은 소표본 한계를 명시한다. 한 단계라도 `seconds`가 `null`인 사례가 있으면 해당 단계의 시간 중앙값과 단계 간 시간 비교는 `not_measurable`(측정 불가)로 보고한다. 이 시간 지표는 #392 진입 판단 규칙에 쓰이지 않는다.

## 도구

`scripts/reference/literature-validation.mjs` (`prepare|seal|reveal|report`), 회귀 `literature-validation.test.mjs`(합성 입력, 선정 결정성·층 구성·개선/해악 분류·집계·입력 검증). 결과가 나오면 텍스트 없는 집계와 권고를 이 문서에 덧붙인다.
