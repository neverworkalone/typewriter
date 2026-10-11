# Stage 1 corpus 후보 풀 소진 리포트 — Issue #534

## 결론과 적용 범위

C000066은 남은 제안 535개를 두 페이지에서 처리하여 후보 lemma 44개를
생성했다. 마지막 selector의 `remaining_lemma_count`는 0이며 manifest의
`production.exhausted`는 `true`다. 실행 오류나 시간 제한으로 줄인 배치가
아니라, 고정된 추출 조건과 누적 제외 집합 아래에서 남은 후보 풀이 소진된
결과다. 500개 미만 결과는 Issue #534의 소진 예외에 해당한다.

이 결과는 Written Corpus 2025 전체의 모든 어휘를 발견했다는 뜻이 아니다.
3,410개 문서의 4,988,970개 문단 중 문서별 문단 순번이 20의 배수인
251,086개 문단(약 5.03%)을 분석한 캐시를 사용한다. Kiwi 0.24.0의
`NNG`, `VV`, `VA`와 두 음절 이상의 한글 lemma라는 기존 추출 조건을
유지했다. 이 캐시의 제외 전 고유 lemma는 55,580개(lemma/POS 55,649개)다.
다른 표본, 품사, 형태 조건, 새 corpus 또는 미해결 관찰의 후속 검증으로
추가 어휘가 발견될 가능성은 이 리포트로 배제하지 않는다.

## 실행 및 소진 증거

- 실행: `T534066`, 배치: `C000066`.
- 기반 remote master 및 producer revision:
  `e2a2aa1d3b63618b026a7f78f427115a55785b74`.
- 이전 C000065 마지막 페이지의 digest-bound 분석 캐시, 누적 제외 manifest,
  raw proposal selection을 재사용하고 C000001–C000065 후보 및 기존
  permanent-trash의 실패한 원래 제안을 제외했다. 최종 해석 lemma에도
  같은 제외 규칙을 적용한다.
- 최초 제외 집합은 55,592개 lemma다. 이 수는 이전 proposal과 archive 등을
  합친 집합 크기이며, 현재 분석 캐시의 고유 lemma 수와 같은 모집단이 아니다.
- 원문과 mutable selection/checkpoint는 공유 캐시에만 저장했다.

| 페이지 | 제안 lemma | 페이지 선택 후 남은 lemma | 누적 제안 | 누적 최종 후보 |
| --- | ---: | ---: | ---: | ---: |
| 최초 `T534066` | 500 | 35 | 500 | 43 |
| `refill-C000066-000001` | 35 | 0 | 535 | 44 |

최종 관찰 44건 중 보류 관찰은 27건이다. 미해결 관찰 489건은
`data/candidate-trash/T000164.jsonl`에 보존했고 제외 관찰은 2건이다.
535건 = 후보 관찰 44건 + 미해결 489건 + 제외 2건이다.
44개 후보는 모두 고유하며 이전 후보 및 이전 archive의 실패 제안 lemma와
각각 중복 0건이다. 이월 적격 후보는 없다. 보류는 Stage 2의 후속 판단을
위한 기록이며 Stage 1에서 의미·gloss를 확정하지 않았다.

## Digest 결속

| 증거 | SHA-256 |
| --- | --- |
| corpus input manifest | `50dd0c6c4ecb9250e75c11dde9e854e1b39de14e12d7a7087d2da041d75ef211` |
| corpus logical rows | `c3b2befa1480804bf6c005cb4a43eb7b2e82d6ad7d77790af4dc82b76f4bd1dd` |
| 최초 exclusion 내용 digest | `2285483fa45216e50bbfbc317e0d53bf0fa59035e9e75661a38501954b2fd574` |
| 최초 selection 파일 | `c87c0d56bb853eed815897d17c710841101cf70cbcc13dd3bb84d7acb44770d9` |
| 최초 evidence 파일 | `5c36091e497e3bc4f1504cee139e36f3cca7ed0e6e5e3363f1112157d3b06dd3` |
| 마지막 exclusion 내용 digest | `31514be3f3d3f8fee46ea49142742069d35f313fe2b8a85b5af9c624222e7d27` |
| 마지막 selection 파일 | `c78ac7a76b7b9af3c7148de9fa025d5eb3420530172e908b418121c2f15ba424` |
| 마지막 evidence 파일 | `7ae3c2d7951e0f223d572635f9993d331e9bd2b03da20bbb61f80a22945fcf37` |
| 통합 source evidence | `6a721198ad3ef89bdcc89abea682de1f72a2caada841a295c638fc9a6f9ca96a` |
| candidates 파일 | `ed09b047f2e682e82e47ab6badf9fdf0869b2409609a97c915617c41697f6d70` |
| archive unresolved 내용 digest | `ed5d88fcc3201ca56bf3d6d322d37108c48bdf95a4b6b58b842d3a09d2f5e2cd` |
| refill checkpoint binding | `3e4507bcd6f8745b0a1b90955b576107ca3c768a595940e8dedf8db424c57718` |

공유 캐시의 각 페이지 `candidate-selection.json`은 source/index, permission,
분석기 버전, 분석 SQLite 파일, selector 및 제외 출처를 결속한다.
마지막 소진 증거는 커밋된
[`C000066/manifest.json`](../data/candidates/C000066/manifest.json)의
`production.exhaustion`에도 보존한다.

## Issue #534 진행 기록과 남은 범위

| 배치 | PR | 후보 | 관찰 | 보류 관찰 | 미해결 관찰 | 제외 관찰 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| C000059 | [#535](https://github.com/neverworkalone/typewriter/pull/535), merged | 500 | 880 | 34 | 1,935 | 162 |
| C000060 | [#537](https://github.com/neverworkalone/typewriter/pull/537), merged | 500 | 775 | 96 | 2,078 | 182 |
| C000061 | [#538](https://github.com/neverworkalone/typewriter/pull/538), merged | 500 | 619 | 205 | 6,262 | 19 |
| C000062 | [#539](https://github.com/neverworkalone/typewriter/pull/539), merged | 500 | 508 | 294 | 6,319 | 35 |
| C000063 | [#540](https://github.com/neverworkalone/typewriter/pull/540), merged | 500 | 500 | 262 | 6,938 | 52 |
| C000064 | [#544](https://github.com/neverworkalone/typewriter/pull/544), merged | 500 | 844 | 118 | 2,007 | 147 |
| C000065 | [#546](https://github.com/neverworkalone/typewriter/pull/546), merged | 500 | 501 | 277 | 6,472 | 179 |
| C000066 | 이번 제출, 미병합 | 44 | 44 | 27 | 489 | 2 |

C000059–C000065의 7개 배치는 병합되었다. C000066은 별도 PR로 제출하여
일반 리뷰와 병합을 기다린다. C000067–C000080의 14개 배치는 현 소스 풀이
소진되어 시작하지 않는다. 반복 빈 배치나 이미 제외된 제안을 다시 채우지
않는다. Issue #534는 전체 22개 배치가 완료된 상태가 아니므로 열어 둔다.
후속 실행에는 새로운 승인 소스 또는 추출 범위에 대한 owner 결정이 필요하다.
canonical JSONL과 Stage 2/3 산출물은 변경하지 않았다.

검증 결과 및 정확한 PR HEAD/CI 링크는 PR과 Issue #534 제출 기록에 남긴다.
factory validator는 이 산출물의 계약 검증을 통과했다. 최초 Normal 실행은
작업 트리에 `node_modules`가 없어 시작에 실패했으며 잠금파일 의존성을
설치한 뒤 재실행했다. 그 실행은 lexical 검증을 통과했으나 실행 중 추가된
이 리포트가 미커밋 상태여서 SQLite build의 clean-tree 검사에 막혔다.
리포트까지 커밋한 최종 HEAD에서 Normal을 다시 실행한다.
이 두 실패는 소진 판정 근거가 아니다.
