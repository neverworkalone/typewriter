# Issue #764 C17 meaning boundary audit

## Scope and evidence

C17(ㅌ)의 Meaning 후보 1,607개를 bound STDICT sense gloss와 대조했다: 다중 Meaning lemma 1,423개와 한 Meaning 안에 여러 sense가 이미 묶인 lemma 184개다. 기준은 독립된 어휘적 정체성이다. 같은 어휘의 자연스러운 의미 확장은 한 Meaning으로, 근거가 이어지지 않는 동형 어휘는 별도 Meaning으로 판정했다.

이 기록은 주 에이전트의 **source-bound 자체 점검(agent self-check)**이며 독립 검토나 사람의 승인이 아니다. canonical STDICT gloss가 기본 증거다. 참조형 source gloss의 표제어 번호 22건을 canonical source ID에 연결할 때는 공식 표준국어대사전 검색 결과를 확인했으며, 허용된 STDICT 외의 사전이나 다른 모델은 사용하지 않았다. 실행 가능한 변경 기록은 issue-764-c17.json이다. 각 변경 lemma는 현재 행의 정확한 before snapshot과 모든 canonical sense를 빠짐없이 나누는 최종 groups를 포함한다. Canonical 및 adjudication은 변경하지 않았다.

| Measure | Before | After |
| --- | ---: | ---: |
| C17 Meaning rows | 11,656 | 10,314 |
| 다중 Meaning lemma | 1,423 | 867 |
| 재분할한 lemma | — | 830 |
| Meaning 행 감소 | — | 1,342 |
| 변경 유형 | — | 801 net row reduction / 0 net row increase / 29 same-count regroup |
| 후보 lemma의 Meaning rows | 4,345 | 3,003 |
| 후보 중 한 Meaning만 남았고 그 안에 여러 sense가 있는 lemma | 184 | 740 |

## Boundary decisions

- 물리·비유·추상·문법·분야 용법이 한 어휘에서 이어질 때 묶었다. 대표 경계는 틀어지다(물체의 꼬임·계획의 어그러짐·감정과 관계의 악화), 틈·틈새(공간·군중·관계·기회), 특허(허가·권리 설정·산업재산권), 틔우다(막힘을 열고 상태·능력·관계를 열어 줌), 티끌(작은 물질과 작거나 적다는 비유)다.
- 같은 표기라도 source gloss가 서로 독립된 어휘 정체성을 가리키면 나눴다. 예: 티보의 두 인물, 틴들의 두 인물, 테티스·트리톤의 신화 인물과 천체, 통고의 일반 행위와 특정 저술, 틀니의 인공 치아와 해초 채취 도구, 특진하다의 의사 요청 진료와 승진. 태조·태종은 서로 다른 군주를 가리키지만, #764 §2-2에서 명시한 같은 구체적 묘호 명명 원리의 적용례로 보아 한 Meaning에 묶었다.
- 감각이나 대상이 달라졌다는 사실만으로 분리하지 않았다. 반대로 어원이나 분야가 같아 보인다는 추측만으로 병합하지 않고, bound gloss에서 연결되는 의미를 확인했다.
- MERGE gloss는 구성 source gloss를 canonical sense 순서대로 이어 붙였다. canonical 원문, ID, 출처 귀속은 그대로다.

## Residual audit

issue-764-c17-residual-audit.md는 결과에 여러 Meaning이 남은 867개 후보를 기록한다. 모든 보존 Meaning 행마다 bound canonical gloss를 인용하고 같은 표제어의 모든 대안 Meaning ID와 source sense ID를 대조한다. 각 대안의 bound gloss도 해당 행에 개별 기록했다. 이미 한 Meaning으로 묶인 다중-sense 후보 가운데 이번 스펙에서 바꾸지 않은 항목은 같은 파일의 별도 절에 남긴다. 각 변경 lemma의 원본·최종 partition은 스펙에서 검토할 수 있다.

이번 스펙의 830개 repartition lemma와 1,339개 최종 group의 모든 source sense, 최종 Meaning, 판정 근거는 [issue-764-c17-merge-audit.md](issue-764-c17-merge-audit.md)에 개별 기록했다.

## Review follow-up

- 잔존 다중-Meaning 감사의 reference gloss 22건을 공식 STDICT headword numbering으로 canonical target sense IDs에 연결하고, 각 target의 원문 gloss와 같은 lemma의 대안 비교를 residual audit에 기록했다. sense 번호가 원문에서 특정되지 않는 표제어는 그 표제어의 source senses를 모두 열거하고 C17 gloss가 반영하는 용법을 표시했다.
- `매기09` (`w111437-s1`), `태우다01` (`w494939-s1..s4`), `통09` (`w347596-s1/s2`), `창병02` (`w324047-s1`)의 target을 기존 C17 gloss가 잘못 가리키고 있어 해당 네 Meaning gloss를 수정했다. 당시에는 재분할이 806개였으며 canonical과 adjudication은 바뀌지 않았다.
- 후속 리뷰는 `태조`·`태종`의 서로 다른 군주도 Issue #764 §2-2의 동일한 구체적 묘호 명명 원리에 따른 적용례인지 확인했다. 두 묘호별 source senses를 한 Meaning으로 묶고 원본 gloss를 모두 보존했으며, `태종`의 임신 후 부종 sense는 분리했다. `테티스`·`트리톤`의 신화 인물과 천체·과학 개념, `통고`의 일반 용법과 특정 저술은 별도 source identity로 남겼다. 판정은 주 에이전트의 source-bound 자체 점검이며 독립 검토로 표시하지 않는다.
- Stage 2 후속 리뷰 `5549941029`가 지정한 same-record 후보 집합을 canonical record와 C17 sense-to-Meaning mapping에서 재계산했다: 이전 HEAD에는 316 lemma·332 record가 분리 후보였다. 이 수는 위험 후보 수이지 오류 수가 아니다. source gloss를 대조해 `터놓다`의 물리·규범·심리 용법 세 sense, `태즈메이니아`의 같은 섬·주 두 sense를 각각 하나로 묶었다. 같은 지리/행정 명칭 패턴의 `탐라`도 추가로 확인해 제주 지역의 역사적 정치 명칭과 섬의 옛 이름을 한 Meaning으로 묶고 `w345436-s1`의 direct relation provenance를 보존했다. 이후 `w345148`의 타점 출전 sense를 분리해 현재 집합은 313 lemma·330 record다. 이 수는 위험 후보 수이지 오류 수가 아니며, 이 후속은 잔여 전체의 의미 오류율을 주장하지 않는다.

- Stage 2 리뷰 `5552180549`는 서로 다른 canonical record를 병합한 118개 그룹·114개 lemma를 대상으로 같은 계열의 의미 경계 오류를 재점검해 달라고 요청했다. 이 범위에서 `통신선`의 배/전선, `탈선`·`탈선하다`의 선원 무단 이탈/철도와 그 record 내부 비유 확장, `톳`의 김 계수 단위/해조류를 분리했다. 같은 source-bound 확인에서 `타살`, `타상`, `타점`, `탁발하다`, `탁성`, `탁탁하다`, `태감`, `태반`, `택지`, `토가`, `토향`, `통발`, `통행권`, `투구`, `투전`, `티`도 수정해 총 20개 lemma의 partition을 갱신했다. 해조류 sense `w346982-s1`의 녹미채 direct relation은 분리된 해조 Meaning에만 투영되는 회귀를 추가했다. 이 검토는 118개 그룹의 해당 defect class를 범위로 하며 869개 잔여 lemma 전체나 313개 same-record split-risk 후보 전체의 전수 QA를 뜻하지 않는다.
- 같은 118개 교차-record 후보 중 Stage 1 후속 리뷰 `5552489704`가 `통발`의 고기잡이 함정/식충 식물과 `통행권`의 허가 증서/법률상 권리를 추가로 지적했다. source gloss의 구체적 포획 원리와 통행 허가 축을 대조해 두 경계를 병합했고, `통발`의 `w344145-s1` 어전 relation 및 `통행권`의 `w350643-s1` 통행면장 relation은 각각 원본 sense provenance를 유지하는 projection 회귀를 추가했다. `통행권`은 잔여 다중-Meaning 후보에서 제외했다. 118개 후보 전체의 독립 의미 전수 검토를 주장하지 않는다.

- Stage 2 리뷰 `5552670746` 당시의 차단 세 경계(`토성` 姓/聲, `토제` 제방/제작, `통상시` 판단 행위/시간)를 source-bound로 분리했다. 같은 범위의 잔존 교차-record 100개 group도 다시 대조해 `탕산`·`탕산하다`의 가산 소진/파멸 결과, `투광`·`투광하다`의 조명 행위/투과 현상 네 그룹을 추가 분리했다. 당시 남은 93개 교차-record group은 각 lemma의 canonical gloss를 기준으로 공유 identity·자연스러운 확장 근거가 있는 경우 유지했다. 통상시와 평상시의 실제 양방향 `direct` 투영이 w517385-s1(보통 때) Meaning에만 연결되고 w347118-s1(보통으로 봄)으로 번지지 않는 회귀를 추가했다. `reviewCases`는 30개 source-bound 경계를 검사하고, 네 탕산 관계 사례도 실제 projector의 source-sense provenance를 확인한다. 이는 해당 100개 cross-record 위험 집합 검토이며 전체 C17의 독립 재검토가 아니다.
- Stage 2 리뷰 `5553014074`에서 확인한 `타종`(종파/종류), `탐리`(이익을 탐내는 행위/탐욕스러운 관리), `탈거`·`탈거하다`(몸의 이탈·탈피/물건의 강제 취득)를 source gloss 경계에 따라 분리했다. 추가 대조에서 `퇴경`은 시골 은퇴의 두 용법을 함께 두고, 경계 밖으로 후퇴하는 sense를 분리했다. 당시 잔여 93개 cross-record group/89개 lemma 중 이 네 과병합을 고친 뒤 89개/85개를 source-bound로 다시 대조했고, `토번`(특정 역사 집단/토착민 일반)은 전체 명명 원리의 근거가 없어 추가 분리했다. 현재는 88개 group/84개 lemma가 남는다. 각 최종 membership과 source gloss를 merge audit에 기록했고, `탐구`는 두 gloss 모두 조사·연구하여 찾는 탐색 행위라 대상·깊이만 달라 유지했다. `퇴경`은 농촌 은퇴를 뜻하는 두 record를 묶고 경계 밖 후퇴는 분리했다. `reviewCases`는 36개 source-bound 경계와 실제 탐관↔탐리 direct 투영의 양방향 provenance 및 누출 부정을 검사한다. 이 source-bound 집중 점검도 전체 C17의 독립 의미 전수 검토를 주장하지 않는다.

- Stage 1 후속 리뷰 `5555058430`의 두 `탄탄하다/탄탄히`·`탐미/탐미하다` 경계를 source-bound로 분리했다. 견고함→조직 안정과 평탄한 길→장래 순탄은 각 source 내부에서 유지하고, 맛을 깊이 즐김과 아름다움 추구는 나눴다. 이전 88개 cross-record risk group/84개 lemma를 source-bound로 대조해 8개 경계를 분리하고 80개 group/76개 lemma를 유지했다. 이어 Stage 2 리뷰 `5555233634`가 지정한 80개 유지 group을 다시 확인해 `특이성`의 성질(性)과 특수한 항성(星)을 분리했다. 현재는 9개 group을 분리하고 79개 group/75개 lemma를 유지한다. `특이성`(性)↔`특성` direct의 양방향 source provenance와 항성 Meaning 누출 부정을 실제 projector 회귀에 추가했다. 총 45개 source-bound partition을 검사한다. 이는 지정 risk cohort의 주 에이전트 자체 점검이며 C17 전체의 독립 재감사를 뜻하지 않는다.
- Stage 2 리뷰 `5555339457`에 따라 같은 canonical record의 명시적 비유 용법이 서로 다른 Meaning으로 갈린 28개 source record를 집중 대조했다. 21개에서 자연스러운 물리·행위·명칭·공간 의미 확장을 묶고 7개는 source gloss에 연결 근거가 없어 유지했다. `투영`·`투영하다`의 광학·심리·기하 용법은 각 1 Meaning이 되었고, 다섯 canonical direct relation은 각 원래 `source_sense_id`를 보존해 통합 Meaning으로 투영된다. `특이성` 성질/항성 분리 및 성질↔`특성` 관계 회귀는 계속 유지한다. 회귀는 66개 exact source-bound partition과 28개 비유 표지 후보 판정을 검사한다. 현재 same-record split risk는 309 record/293 lemma이고 오류 수가 아닌 후보 분모다. 이 집중 점검은 나머지 위험 후보 전체의 전수 승인이나 독립 검토를 주장하지 않는다.

## Validation and limits

- Replayed `scripts/meaning/issue-764-c17.json` from PR base `5d35c767b9319e0fbb839a559575c91ef5752d25`: all 830 repartitions and two standalone gloss edits applied with complete sense coverage, producing 10,314 C17 rows; all 12 replayed C17 shards match the current output byte-for-byte, all four reference-target gloss corrections were reproduced, and all 117 adjudications stayed unchanged.
- `node --test scripts/meaning/issue-764-c17-residual-audit.test.mjs` checks all 867 residual lemmas and retained Meaning/source evidence, the pre-follow-up 316/332 and current 309/293 same-record split candidate counts, 66 exact source-bound partition cases, the 28-record explicit-figurative scan, and positive/negative identity and relation-projection controls. It does not infer lexical identity automatically.
- `node scripts/meaning/validate.mjs` passed after the source-bound follow-up: 480,783 meanings, 117 adjudications.
- This is an agent self-check, not independent review. Closely related senses and lexicalized technical uses remain editorial boundary judgments for the PR reviewer to assess.
