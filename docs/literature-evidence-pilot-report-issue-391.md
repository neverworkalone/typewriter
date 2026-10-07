# Stage 2 문학 근거 파일럿 보고 (#391)

원문·발췌·DB·근거 팩은 Git에 포함하지 않는다. 이 문서는 텍스트 없는 집계만 담는다. 이용 범위는 [외부 자료 검토](external-material-review-public-domain-literature.md), DB 계약은 [#334 보고](literature-index-full-report-issue-334.md)를 따른다.

## 도구

- `pnpm run reference:literature:evidence -- <batch id> <candidate id>` (`scripts/reference/literature-evidence-pack.mjs`): 후보 `data/candidates/<batch>/candidates.jsonl`의 정확한 행을 읽고(`candidates_sha256` 검증), 검색형을 **인용형 + 관찰 표면형 + (기존 정본 엔트리가 있으면) 공유 표면형 투영이 이미 지원하는 형**으로 만든다. 새 형태소/표제어 인덱스는 없다. 2자 미만 형은 건너뛰고 `skipped_forms`에 기록한다.
- 기존 전수 DB(`public-domain-literature.sqlite`)를 읽기 전용으로 조회한다. 스키마 변경·재빌드·네트워크 의존은 없다(테스트가 import 목록을 고정한다).
- 요약 수치: `total_match_units`/`distinct_works_matched`는 상한과 무관한 정확한 합집합이고, `sampled_match_units`/`sampled_works`/`fetch_truncated`가 선택에 쓰인 표본을 구분한다.
- 선택: 같은 text unit과 같은 block의 중복 히트는 한 번만 센다. 작품당 기본 1개(`--max-per-work`, 최대 3), 기본 8개(`--max-contexts`, 최대 10). 장르 → (미검증·약한) 저자 → 결정적 해시 순으로 다양성을 우선한다. 각 형이 2,000 unit을 넘으면 파일 순서 편향이 없는 결정적 산포 표본에서 고른다(`truncated`로 보고).
- 문맥: 히트가 속한 block(≤12행, ≤1,200자)을 통째로, 크면 block 안에서 ±3행. 파일·block 경계를 넘지 않는다.
- 출력(Git 제외, `data/reference/literature-evidence/<batch>/`): `.pack.json`, `.md`(원문 포함, 로컬 전용), `.summary.json`(텍스트 없음: 후보/배치, 표제어·검색형, 총 일치 unit, 작품·장르 수, 반환 수, `index_metadata`의 논리 행 digest·입력 매니페스트 digest, 선택 위치 digest `sha256(source_sha256:unit_ordinal)`, 조회 시간). 출력 경로는 `data/reference/` 밖이면 거부한다.
- 도구는 POS·뜻·`included/covered/rejected/deferred`·직설/비유·관계 유형을 판단하지 않는다. 히트 없음은 부정 근거가 아니다(`no_evidence_note`).
- 트리거 정책(`pilotTriggerReasons`)은 이유만 보고한다: `new_sense_on_existing_entry`, 복수 usage group/POS 가설, 보류된 관찰. 필수 게이트가 아니다.
- 재현 측정: `node scripts/reference/literature-evidence-replay.mjs` (모든 과거 `deferred` 결정 + 정본 기존 엔트리에 `included`된 명확 사례 40건의 해시 순 표본).

## 측정 결과 (검색 단계만, 전수 DB digest `bbb19a0b…52fe`)

| 집단 | 사례 | 근거 있음 | 근거 없음 | 반환 3개 미만 | 형별 2,000 상한 도달 | 평균 반환 | 조회 중앙값/p95 ms |
|---|---|---|---|---|---|---|---|
| 과거 deferred | 123 (+1 실패) | 120 | 3 | 4 (그중 3은 0개) | 10 | 7.71 | 448 / 2,107 |
| 명확 included 비교 | 40 | 40 | 0 | 0 | 3 | 8.00 | 460 / 1,432 |

- 과거 deferred는 124건이며 1건(`C000003-0331`, 표제어·관찰형이 1자 `줄`)은 2자 미만 규칙 때문에 검색형이 없어 실패했다.
- 연결된 과거 deferral 사유의 키워드 분류(휴리스틱): 공유 계약 하드 홀드 14, 뜻/표현 경계 61, 근거 부족 5, 기타 43. 하드 홀드는 어휘 근거로 풀리는 종류가 아니다.
- 조회 시간은 후보당 약 0.5초(총 약 73초/123건)이며, 근거 팩은 기본 8개 문맥으로 한정된다.

## 탐색적 self-check (측정, 정확도 아님)

기록은 최상위에 조회 조건·DB digest·코호트 선택 규칙을, 각 행에 과거 결정 digest와 검토한 근거의 `selected_location_digests`(5개 조건으로 결정적 재생성)를 묶고, 회귀가 조회 설정 전체(`max_contexts=5`·`max_per_work=1`·`hit_fetch_cap=2000`), 각 행의 문맥 ≥1, 선언된 선택 규칙에서 재계산한 코호트 ID 집합(제외 목록 포함)과 기록의 일치, 결정 digest·group/category, 발표 집계를 고정한다. 기록: [`scripts/reference/literature-evidence-selfcheck-391.json`](../scripts/reference/literature-evidence-selfcheck-391.json) (후보 id·열거값만, 원문 없음; 회귀: `literature-evidence-selfcheck.test.mjs`). 과거 deferred 사례 50건(휴리스틱 분류 기준 뜻/표현 경계 36, 근거 부족 4, 기타 10, 각 분류 내 해시 순)과 정본 기존 엔트리에 `included`된 비교 10건에 대해, 주 구현 에이전트(Sonnet 5.5)가 근거 팩(`max_contexts=5`, `max_per_work=1`, `hit_fetch_cap=2000`; 위 재현 표의 8개 문맥 기본값과 다른 조건)을 읽고 과거 deferral 사유와 대조해 "근거가 있었다면 어떤 결과로 갈 수 있었는가"를 탐색적으로 표시했다. **에이전트 self-check이며 독립 판정·인간 승인·정답 집합이 아니고, 어떤 정본/과거 결정도 바꾸지 않았다.**

<!-- selfcheck-contract: 이 블록은 기록(JSON)과 회귀(`checkReportContract`)가 기계적으로 대조한다 -->
```json
{
 "retrieval": {
  "max_contexts": 5,
  "max_per_work": 1,
  "hit_fetch_cap": 2000
 },
 "aggregate": {
  "deferred_cases": 50,
  "deferred_outcomes": {
   "resolved_included": 7,
   "resolved_covered": 11,
   "resolved_rejected": 4,
   "partially_resolved": 3,
   "still_deferred": 25
  },
  "deferred_fully_resolved": 22,
  "deferred_evidence_use": {
   "supports": 23,
   "no_effect": 14,
   "misleading_noise": 9,
   "exposes_other_sense": 4
  },
  "comparison_cases": 10,
  "comparison_outcomes": {
   "unchanged_included": 10
  },
  "comparison_evidence_use": {
   "supports": 6,
   "no_effect": 3,
   "misleading_noise": 1,
   "exposes_other_sense": 0
  }
 }
}
```

| 과거 deferred 50건의 self-check 결과 | 건수 |
|---|---|
| `resolved_included` (더 근거 있는 포함) | 7 |
| `resolved_covered` (기존 뜻의 확장으로 커버) | 11 |
| `resolved_rejected` (독립 뜻/구성으로 세우지 않음) | 4 |
| `partially_resolved` (일부 관찰만 해소) | 3 |
| `still_deferred` | 25 |

- 부분·완전 해소 합 25/50이지만 **완전 해소는 22건(44%)**, 나머지 25건은 보류 유지다. 이는 근거 팩이 판단을 *뒷받침할 수 있었다*는 탐색적 표시일 뿐이며 맞는 결정이라는 뜻이 아니다.
- 근거의 역할(`evidence_use`, 50건): 뒷받침 23, 효과 없음 14(대개 과거 deferral의 관용구/비유형이 검색형에 없어 문학 문맥에서 직접 확인되지 않음), 잡음으로 오히려 방해 9, 다른 뜻 노출 4.
- 비교군 10건: 10건 모두 `included` 유지(뒷받침 6, 효과 없음 3, 잡음 1). 현대 기술 뜻(예: 화학 원소 뜻)은 공개 도메인 문학에서 확인되지 않아도 *부정 근거가 아니다*.
- 잡음 사례의 구조적 원인(후속 인덱스 근거): ① 부분 문자열이 다른 어휘/한자어에 걸림(`지고`⊂`가지고`, `까고`⊂`까다롭다`, `꼬리`⊂`꾀꼬리`, `선도`⊂`윤선도`·`수선도`, `음성(陰城)`·`전당(典當)`·`경고`(한자 동형어)). ② 관용구는 표제어/표면형만 검색해 직접 확인되지 않는다(`엉덩이가 무겁다`, `큰돈을 만지다`, `똑 부러지다`). ③ 매우 흔한 형(`있다`, `지다`, `두다`)은 일치가 수만 건이라 8개 표본이 변별력이 없다. ④ 휴리스틱 분류 "근거 부족"의 일부(예: `닿다`)는 실제로는 공유 계약 보류다.
- 과잉 분할/오해를 드러낸 사례: `미끄러지다`(별도의 '낙방' 뜻 노출), `머리를 싸매다`·`치켜`(관용구/결합형 확인으로 독립 뜻 불필요), `말다`(`-ㄹ까 말까` 구성)가 해당한다. 모두 self-check 해석이다.
- 시간: 조회 시간(후보당 중앙값 약 0.45초)만 측정했다. 이 self-check를 읽는 데 걸린 시간은 비교 가능한 대조군 없이 기록하지 않았으므로 **Stage 2 시간 단축은 측정하지 못했다**.

## 질문별 답

1. **근거 부족 deferral을 실질적으로 줄였나?** — *탐색적 self-check 기준* 50건 중 22건이 더 근거 있는 최종 판정(포함 7·커버 11·거절 4)으로 갈 수 있었고 3건은 일부만 해소됐다. 독립 정답이 없어 정확도는 주장하지 않으며, 25건은 보류가 유지됐다(문학 문맥이 관용구/비유형을 보여주지 못함). 이 비율은 선택된 50건에 대한 에이전트 판단이므로 *일반화하지 않는다*.
2. **뜻 경계·비유 판단을 개선했나?** — 같은 self-check에서 비유적 확장(예: 녹다·옅다·싸이다·날아가다·간직하다)이 문학 속에서 직접 확인돼 `covered`/`included`를 뒷받침한 사례가 있었고, 동형어/부분 문자열 잡음이 방해한 사례도 9건이다. 순효과는 독립 판정 없이는 *미확정*이다.
3. **Stage 2를 빠르게 했나?** — 측정하지 못했다(위 "시간" 참고). 수동 검색 대체 가능성(후보당 한 명령, 약 0.5초, ≤8개 문맥)만 측정했다.
4. **유용한 근거가 없는 비율** — 전체 deferred 123건 중 3건(2.4%, 모두 현대 외래어 *추론*) 문맥 없음. 문맥이 있어도 self-check 기준 '효과 없음/잡음'이 23/50(46%)이므로 "유용한 근거" 비율은 이보다 낮다.
5. **후속 인덱스/재빌드를 정당화할 구체적 실패**
   - 짧은 표제어(1자 `줄` 등)는 부분 문자열 검색이 불가능하다.
   - 부분 문자열/한자 동형어 잡음(위 목록): 표제어·품사 인지 인덱스가 필요하다. 오탐률 자체는 측정하지 않았다.
   - 새 어휘는 활용형이 관찰 표면형만 검색된다(지원형 투영은 기존 정본 엔트리가 있을 때만).
   - 관용구/다어절 표현은 검색형이 아니어서 직접 확인되지 않는다.
   - 행 단위 검색이라 하드랩으로 쪼개진 형은 놓친다(빈도 미측정).
   - 흔한 형은 형별 2,000 unit 상한에 걸린다(deferred 10건, 비교군 3건). 총 일치/작품 수는 상한과 무관하게 정확하며, 선택은 결정적 산포 표본에서 한다.

## 한계

- 위 수치는 검색 가용성과 지연이며 의미 정확도가 아니다. 어떤 정답 집합에도 대비하지 않았다.
- 제목/저자는 파일명 유래 미검증 값이며 저자 다양성은 약한 휴리스틱일 뿐이다.
- 문학 빈도는 의미 편입의 근거가 아니다. 이 이슈는 필수 Stage 2 게이트를 추가하지 않았다.
- 후속(통합) 이슈는 위 1·2번이 독립 판정 표본으로 확인된 뒤에만 정당화된다.
