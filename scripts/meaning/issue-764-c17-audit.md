# Issue #764 C17 meaning boundary audit

## Scope and evidence

C17(ㅌ)의 Meaning 후보 1,607개를 bound STDICT sense gloss와 대조했다: 다중 Meaning lemma 1,423개와 한 Meaning 안에 여러 sense가 이미 묶인 lemma 184개다. 기준은 독립된 어휘적 정체성이다. 같은 어휘의 자연스러운 의미 확장은 한 Meaning으로, 근거가 이어지지 않는 동형 어휘는 별도 Meaning으로 판정했다.

이 기록은 주 에이전트의 **source-bound 자체 점검(agent self-check)**이며 독립 검토나 사람의 승인이 아니다. 외부 사전이나 다른 모델을 사용하지 않았다. 실행 가능한 변경 기록은 issue-764-c17.json이다. 각 변경 lemma는 현재 행의 정확한 before snapshot과 모든 canonical sense를 빠짐없이 나누는 최종 groups를 포함한다. Canonical 및 adjudication은 변경하지 않았다.

| Measure | Before | After |
| --- | ---: | ---: |
| C17 Meaning rows | 11,656 | 10,297 |
| 다중 Meaning lemma | 1,423 | 864 |
| 재분할한 lemma | — | 811 |
| Meaning 행 감소 | — | 1,359 |
| 변경 유형 | — | 811 merge / 0 split / 0 same-count regroup |
| 후보 lemma의 Meaning rows | 4,345 | 2,986 |
| 후보 중 한 Meaning에 여러 sense가 남은 lemma | 184 | 743 |

## Boundary decisions

- 물리·비유·추상·문법·분야 용법이 한 어휘에서 이어질 때 묶었다. 대표 경계는 틀어지다(물체의 꼬임·계획의 어그러짐·감정과 관계의 악화), 틈·틈새(공간·군중·관계·기회), 특허(허가·권리 설정·산업재산권), 틔우다(막힘을 열고 상태·능력·관계를 열어 줌), 티끌(작은 물질과 작거나 적다는 비유)다.
- 같은 표기라도 개별 인물·작품·장치처럼 source gloss가 별개의 정체성을 가리키면 나눴다. 예: 티보의 두 인물, 틴들의 두 인물, 틀니의 인공 치아와 해초 채취 도구, 특진하다의 의사 요청 진료와 승진.
- 감각이나 대상이 달라졌다는 사실만으로 분리하지 않았다. 반대로 어원이나 분야가 같아 보인다는 추측만으로 병합하지 않고, bound gloss에서 연결되는 의미를 확인했다.
- MERGE gloss는 구성 source gloss를 canonical sense 순서대로 이어 붙였다. canonical 원문, ID, 출처 귀속은 그대로다.

## Residual audit

issue-764-c17-residual-audit.md는 결과에 여러 Meaning이 남은 864개 후보를 기록한다. 모든 보존 Meaning 행마다 bound canonical gloss를 인용하고 같은 표제어의 모든 대안 Meaning ID와 source sense ID를 대조한다. 각 대안의 bound gloss도 해당 행에 개별 기록했다. 이미 한 Meaning으로 묶인 다중-sense 후보 가운데 이번 스펙에서 바꾸지 않은 항목은 같은 파일의 별도 절에 남긴다. 각 변경 lemma의 원본·최종 partition은 스펙에서 검토할 수 있다.

이번에 병합한 811개 lemma의 모든 source sense, 최종 Meaning, 판정 근거는 [issue-764-c17-merge-audit.md](issue-764-c17-merge-audit.md)에 개별 기록했다.

## Validation and limits

- Replayed `scripts/meaning/issue-764-c17.json` from PR base `5d35c767b9319e0fbb839a559575c91ef5752d25`: all 811 repartitions applied with complete sense coverage, and the 10,297 C17 output rows matched exactly; all 117 adjudications stayed unchanged.
- `node --test scripts/meaning/issue-764-c17-residual-audit.test.mjs` passed. It checked all 864 residual lemmas and 2,243 retained Meaning rows, including each bound canonical gloss and every competing source ID. The regression checks evidence coverage, not editorial decisions.
- `node scripts/meaning/validate.mjs` passed: 480,766 meanings, 117 adjudications.
- This is an agent self-check, not independent review. Closely related senses and lexicalized technical uses remain editorial boundary judgments for the PR reviewer to assess.
