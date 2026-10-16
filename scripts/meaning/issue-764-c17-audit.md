# Issue #764 C17 meaning boundary audit

## Scope and evidence

C17(ㅌ)의 Meaning 후보 1,607개를 bound STDICT sense gloss와 대조했다: 다중 Meaning lemma 1,423개와 한 Meaning 안에 여러 sense가 이미 묶인 lemma 184개다. 기준은 독립된 어휘적 정체성이다. 같은 어휘의 자연스러운 의미 확장은 한 Meaning으로, 근거가 이어지지 않는 동형 어휘는 별도 Meaning으로 판정했다.

이 기록은 주 에이전트의 **source-bound 자체 점검(agent self-check)**이며 독립 검토나 사람의 승인이 아니다. canonical STDICT gloss가 기본 증거다. 참조형 source gloss의 표제어 번호 22건을 canonical source ID에 연결할 때는 공식 표준국어대사전 검색 결과를 확인했으며, 허용된 STDICT 외의 사전이나 다른 모델은 사용하지 않았다. 실행 가능한 변경 기록은 issue-764-c17.json이다. 각 변경 lemma는 현재 행의 정확한 before snapshot과 모든 canonical sense를 빠짐없이 나누는 최종 groups를 포함한다. Canonical 및 adjudication은 변경하지 않았다.

| Measure | Before | After |
| --- | ---: | ---: |
| C17 Meaning rows | 11,656 | 10,313 |
| 다중 Meaning lemma | 1,423 | 865 |
| 재분할한 lemma | — | 806 |
| Meaning 행 감소 | — | 1,343 |
| 변경 유형 | — | 806 merge / 0 split / 0 same-count regroup |
| 후보 lemma의 Meaning rows | 4,345 | 3,002 |
| 후보 중 한 Meaning에 여러 sense가 남은 lemma | 184 | 742 |

## Boundary decisions

- 물리·비유·추상·문법·분야 용법이 한 어휘에서 이어질 때 묶었다. 대표 경계는 틀어지다(물체의 꼬임·계획의 어그러짐·감정과 관계의 악화), 틈·틈새(공간·군중·관계·기회), 특허(허가·권리 설정·산업재산권), 틔우다(막힘을 열고 상태·능력·관계를 열어 줌), 티끌(작은 물질과 작거나 적다는 비유)다.
- 같은 표기라도 개별 인물·작품·장치처럼 source gloss가 별개의 정체성을 가리키면 나눴다. 예: 티보의 두 인물, 틴들의 두 인물, 태조·태종의 각 왕조 군주와 일반 묘호, 테티스·트리톤의 신화 인물과 천체, 통고의 일반 행위와 특정 저술, 틀니의 인공 치아와 해초 채취 도구, 특진하다의 의사 요청 진료와 승진.
- 감각이나 대상이 달라졌다는 사실만으로 분리하지 않았다. 반대로 어원이나 분야가 같아 보인다는 추측만으로 병합하지 않고, bound gloss에서 연결되는 의미를 확인했다.
- MERGE gloss는 구성 source gloss를 canonical sense 순서대로 이어 붙였다. canonical 원문, ID, 출처 귀속은 그대로다.

## Residual audit

issue-764-c17-residual-audit.md는 결과에 여러 Meaning이 남은 865개 후보를 기록한다. 모든 보존 Meaning 행마다 bound canonical gloss를 인용하고 같은 표제어의 모든 대안 Meaning ID와 source sense ID를 대조한다. 각 대안의 bound gloss도 해당 행에 개별 기록했다. 이미 한 Meaning으로 묶인 다중-sense 후보 가운데 이번 스펙에서 바꾸지 않은 항목은 같은 파일의 별도 절에 남긴다. 각 변경 lemma의 원본·최종 partition은 스펙에서 검토할 수 있다.

이번에 병합한 806개 lemma의 모든 source sense, 최종 Meaning, 판정 근거는 [issue-764-c17-merge-audit.md](issue-764-c17-merge-audit.md)에 개별 기록했다.

## Review follow-up

- 잔존 다중-Meaning 감사의 reference gloss 22건을 공식 STDICT headword numbering으로 canonical target sense IDs에 연결하고, 각 target의 원문 gloss와 같은 lemma의 대안 비교를 residual audit에 기록했다. sense 번호가 원문에서 특정되지 않는 표제어는 그 표제어의 source senses를 모두 열거하고 C17 gloss가 반영하는 용법을 표시했다.
- `매기09` (`w111437-s1`), `태우다01` (`w494939-s1..s4`), `통09` (`w347596-s1/s2`), `창병02` (`w324047-s1`)의 target을 기존 C17 gloss가 잘못 가리키고 있어 해당 네 Meaning gloss를 수정했다. 재분할은 806개 lemma로 줄었으며 canonical과 adjudication은 바뀌지 않았다.
- 추가 source-bound 피드백에서 `태조`·`태종`의 일반 묘호와 서로 다른 군주, `테티스`·`트리톤`의 각 신화 인물·천체·과학 개념, `통고`의 일반 용법·특정 저술을 한 Meaning으로 합친 경계를 확인했다. 해당 다섯 repartition을 실행 스펙에서 제거하고, 각 source identity와 모든 대안 Meaning을 residual audit에 기록했다. 이 결정은 PR 작성자의 자체 점검이며 독립 검토로 표시하지 않는다.

## Validation and limits

- Replayed `scripts/meaning/issue-764-c17.json` from PR base `5d35c767b9319e0fbb839a559575c91ef5752d25`: all 806 repartitions and two standalone gloss edits applied with complete sense coverage, and the 10,313 C17 output rows matched exactly; all four reference-target gloss corrections were reproduced and all 117 adjudications stayed unchanged.
- `node --test scripts/meaning/issue-764-c17-residual-audit.test.mjs` passed. It checked all 865 residual lemmas and 2,260 retained Meaning rows, including bound source glosses, every competing source ID, canonical target ID/gloss evidence for every reference-bound row, and selected negative/positive identity controls. It does not infer lexical identity automatically.
- `node scripts/meaning/validate.mjs` passed: 480,782 meanings, 117 adjudications.
- This is an agent self-check, not independent review. Closely related senses and lexicalized technical uses remain editorial boundary judgments for the PR reviewer to assess.
