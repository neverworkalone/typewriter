# Issue #764 C17 meaning boundary audit

## Scope and evidence

C17(ㅌ)의 Meaning 후보 1,607개를 bound STDICT sense gloss와 대조했다: 다중 Meaning lemma 1,423개와 한 Meaning 안에 여러 sense가 이미 묶인 lemma 184개다. 기준은 독립된 어휘적 정체성이다. 같은 어휘의 자연스러운 의미 확장은 한 Meaning으로, 근거가 이어지지 않는 동형 어휘는 별도 Meaning으로 판정했다.

이 기록은 주 에이전트의 **source-bound 자체 점검(agent self-check)**이며 독립 검토나 사람의 승인이 아니다. canonical STDICT gloss가 기본 증거다. 참조형 source gloss의 표제어 번호 22건을 canonical source ID에 연결할 때는 공식 표준국어대사전 검색 결과를 확인했으며, 허용된 STDICT 외의 사전이나 다른 모델은 사용하지 않았다. 실행 가능한 변경 기록은 issue-764-c17.json이다. 각 변경 lemma는 현재 행의 정확한 before snapshot과 모든 canonical sense를 빠짐없이 나누는 최종 groups를 포함한다. Canonical 및 adjudication은 변경하지 않았다.

| Measure | Before | After |
| --- | ---: | ---: |
| C17 Meaning rows | 11,656 | 10,296 |
| 다중 Meaning lemma | 1,423 | 861 |
| 재분할한 lemma | — | 811 |
| Meaning 행 감소 | — | 1,360 |
| 변경 유형 | — | 811 merge / 0 split / 0 same-count regroup |
| 후보 lemma의 Meaning rows | 4,345 | 2,985 |
| 후보 중 한 Meaning만 남았고 그 안에 여러 sense가 있는 lemma | 184 | 746 |

## Boundary decisions

- 물리·비유·추상·문법·분야 용법이 한 어휘에서 이어질 때 묶었다. 대표 경계는 틀어지다(물체의 꼬임·계획의 어그러짐·감정과 관계의 악화), 틈·틈새(공간·군중·관계·기회), 특허(허가·권리 설정·산업재산권), 틔우다(막힘을 열고 상태·능력·관계를 열어 줌), 티끌(작은 물질과 작거나 적다는 비유)다.
- 같은 표기라도 source gloss가 서로 독립된 어휘 정체성을 가리키면 나눴다. 예: 티보의 두 인물, 틴들의 두 인물, 테티스·트리톤의 신화 인물과 천체, 통고의 일반 행위와 특정 저술, 틀니의 인공 치아와 해초 채취 도구, 특진하다의 의사 요청 진료와 승진. 태조·태종은 서로 다른 군주를 가리키지만, #764 §2-2에서 명시한 같은 구체적 묘호 명명 원리의 적용례로 보아 한 Meaning에 묶었다.
- 감각이나 대상이 달라졌다는 사실만으로 분리하지 않았다. 반대로 어원이나 분야가 같아 보인다는 추측만으로 병합하지 않고, bound gloss에서 연결되는 의미를 확인했다.
- MERGE gloss는 구성 source gloss를 canonical sense 순서대로 이어 붙였다. canonical 원문, ID, 출처 귀속은 그대로다.

## Residual audit

issue-764-c17-residual-audit.md는 결과에 여러 Meaning이 남은 861개 후보를 기록한다. 모든 보존 Meaning 행마다 bound canonical gloss를 인용하고 같은 표제어의 모든 대안 Meaning ID와 source sense ID를 대조한다. 각 대안의 bound gloss도 해당 행에 개별 기록했다. 이미 한 Meaning으로 묶인 다중-sense 후보 가운데 이번 스펙에서 바꾸지 않은 항목은 같은 파일의 별도 절에 남긴다. 각 변경 lemma의 원본·최종 partition은 스펙에서 검토할 수 있다.

이번에 병합한 811개 lemma의 모든 source sense, 최종 Meaning, 판정 근거는 [issue-764-c17-merge-audit.md](issue-764-c17-merge-audit.md)에 개별 기록했다.

## Review follow-up

- 잔존 다중-Meaning 감사의 reference gloss 22건을 공식 STDICT headword numbering으로 canonical target sense IDs에 연결하고, 각 target의 원문 gloss와 같은 lemma의 대안 비교를 residual audit에 기록했다. sense 번호가 원문에서 특정되지 않는 표제어는 그 표제어의 source senses를 모두 열거하고 C17 gloss가 반영하는 용법을 표시했다.
- `매기09` (`w111437-s1`), `태우다01` (`w494939-s1..s4`), `통09` (`w347596-s1/s2`), `창병02` (`w324047-s1`)의 target을 기존 C17 gloss가 잘못 가리키고 있어 해당 네 Meaning gloss를 수정했다. 당시에는 재분할이 806개였으며 canonical과 adjudication은 바뀌지 않았다.
- 후속 리뷰는 `태조`·`태종`의 서로 다른 군주도 Issue #764 §2-2의 동일한 구체적 묘호 명명 원리에 따른 적용례인지 확인했다. 두 묘호별 source senses를 한 Meaning으로 묶고 원본 gloss를 모두 보존했으며, `태종`의 임신 후 부종 sense는 분리했다. `테티스`·`트리톤`의 신화 인물과 천체·과학 개념, `통고`의 일반 용법과 특정 저술은 별도 source identity로 남겼다. 판정은 주 에이전트의 source-bound 자체 점검이며 독립 검토로 표시하지 않는다.
- Stage 2 후속 리뷰 `5549941029`가 지정한 same-record 후보 집합을 canonical record와 C17 sense-to-Meaning mapping에서 재계산했다: 이전 HEAD에는 316 lemma·332 record가 분리 후보였다. 이 수는 위험 후보 수이지 오류 수가 아니다. source gloss를 대조해 `터놓다`의 물리·규범·심리 용법 세 sense, `태즈메이니아`의 같은 섬·주 두 sense를 각각 하나로 묶었다. 같은 지리/행정 명칭 패턴의 `탐라`도 추가로 확인해 제주 지역의 역사적 정치 명칭과 섬의 옛 이름을 한 Meaning으로 묶고 `w345436-s1`의 direct relation provenance를 보존했다. 남은 집합은 313 lemma·329 record이며, 이 후속은 이 잔여 전체의 의미 오류율을 주장하지 않는다.

## Validation and limits

- Replayed `scripts/meaning/issue-764-c17.json` from PR base `5d35c767b9319e0fbb839a559575c91ef5752d25`: all 811 repartitions and two standalone gloss edits applied with complete sense coverage, producing 10,296 C17 rows; all four reference-target gloss corrections were reproduced and all 117 adjudications stayed unchanged.
- `node --test scripts/meaning/issue-764-c17-residual-audit.test.mjs` checks all 861 residual lemmas and the retained Meaning/source evidence, the prior 316/332 and current 313/329 same-record split candidate counts, the three old-fails/new-passes partitions, and positive/negative identity and relation-projection controls. It does not infer lexical identity automatically.
- `node scripts/meaning/validate.mjs` passed: 480,765 meanings, 117 adjudications.
- This is an agent self-check, not independent review. Closely related senses and lexicalized technical uses remain editorial boundary judgments for the PR reviewer to assess.
