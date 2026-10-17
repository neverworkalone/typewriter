# Issue #843 — Experiment A: 뜻풀이 기반 직접 생성

## 실험 범위와 한계

- 방식: A — 출발어의 Canonical record/sense와 짧은 뜻풀이만 입력해 후보를 바로 생성했다.
- 코호트: #841에 고정된 8개 항목을 모두 사용했다. 생성 중 표본이나 의미를 교체하지 않았다.
- 외부 문맥: 문학·말뭉치·웹 검색과 literature/corpus DB를 사용하지 않았다. 원본 의미 확인과 target 연결 확인에만 현재 Git의 Canonical을 읽었다. SQLite는 읽지 않았다.
- 보호 자료: 출처 원문 뜻풀이, 발췌 문맥, DB 파일 및 evidence pack은 이 보고서에 포함하지 않았다.
- 성격: 아래 `keep/revise/reject`와 relevance는 생성자 자신의 잠정 편집 평가다. 독립 리뷰나 오너의 최종 품질 판정이 아니다.

## 입력, 프롬프트, 실행 기록

각 항목의 입력은 표제어, Canonical `record_id`, 정확한 `sense_id`, 해당 sense의 뜻풀이였다. 아래 표에 원문 뜻풀이는 재현하지 않는다.

아래는 이 세션에서 적용한 공통 입력·생성 지시를 보고서용 템플릿으로 정리한 것이다. 각 항목에 같은 템플릿을 한 번 적용했고, 출발어별 추가 지시는 없었다. 입력 변수는 표제어, record/sense ID와 해당 Canonical 뜻풀이뿐이다.

```text
출발어: {{source_lemma}}
Canonical record_id: {{source_record_id}}
정확한 Canonical sense_id: {{source_sense_id}}
Canonical 뜻풀이: {{canonical_gloss}}

이 출발 의미의 표제어와 뜻풀이만 사용해 작가용 말의 결·연상 후보를 0–8개 생성한다. 웹, 문학, 말뭉치, 그 밖의 외부 문맥을 검색하거나 입력에 없는 사실처럼 보태지 않는다. 장면을 먼저 구성하는 방식도 사용하지 않는다. `near`, `mood`, `scene`, `sensory`, `action`, `association`만 사용하고 `direct`와 `antonym`은 작성하지 않는다. 연상 Tier 1은 비공식 유의어 후보로도 고려할 만큼 가까운 경우에만 사용한다. 각 후보에 같은 출발 의미/그룹 안의 상대 relevance 1–9와 짧은 비인용 근거를 붙인다. 정확한 기존 Canonical 대상 record/sense를 확인할 수 있을 때만 ID를 쓰고, 아니면 ID 없이 text-only로 남긴다. 개수를 채우려고 후보를 보태지 않는다.

각 후보는 `source_lemma, source_record_id, source_sense, method, target_text, target_record_id_or_null, relation_type, relevance, provisional_decision, reasoning(non-quoted), failure_reason` 공통 컬럼으로 기록한다.
```

이 실험은 별도의 모델 API 호출이 아니라 Codex 대화 세션에서 수행했다. 당시의 독립된 per-call 원문 프롬프트 로그는 남아 있지 않으므로, 위 블록은 세션에서 적용한 입력·지시를 복원해 정리한 템플릿이며 원시 대화 로그의 축어 인용은 아니다. `{{canonical_gloss}}`는 실제 입력에 제공된 뜻풀이를 가리키며, 보호 출처 자료를 보고서에 복사하지 않기 위한 자리표시자다.

- 모델/작업자: Codex GPT-6 계열 인터페이스의 단일 작업자 1명. 제공된 인터페이스에서 더 구체적인 모델 빌드, sampling 설정, temperature 및 max-output 설정은 확인할 수 없었다. 따라서 알고리즘만의 효과로 일반화할 수 없다.
- 반복: 8개 출발 sense에 한 번 생성. 각 sense의 실험 상한은 8개였고, 추가 생성이나 재시도는 없었다.
- 토큰/비용/시간: 이 인터페이스는 이 생성의 개별 입력·출력 토큰, 생성 wall time, 비용을 노출하지 않는다. 생성 및 검수 시간을 따로 계측하지 못했다. 측정하지 않은 값을 0이나 추정치로 바꾸지 않는다.
- Canonical 확인: 8개 출발 record/sense와 연결한 후보 대상의 record/sense를 현재 Git의 Canonical에서 확인했다. 정확한 대상이 없는 구·표현은 `null`로 남겼다.

## 코호트 결속

모든 행은 `method=A_direct_gloss_only`이며 각 구역에 적힌 `source_lemma`, `source_record_id`, `source_sense`를 공유한다. 고정 코호트 의미 힌트와 현재 Canonical을 대조한 결과다. 이 표는 원문 뜻풀이를 복사하지 않는다.

| source_lemma | source_record_id | source_sense | Canonical 결속 메모 |
| --- | --- | --- | --- |
| 나그네 | `w408179` | `w408179-s1` | 이동하는 사람 의미의 s1 |
| 그리움 | `w44055` | `w44055-s1` | 단일 sense |
| 문턱 | `w425010` | `w425010-s1` | homograph 2의 물리적 문턱 의미 |
| 쓸쓸하다 | `w213407` | `w213407-s1` | 외롭고 적적한 상태의 s1 |
| 흐르다 | `w508767` | `w508767-s3` | homograph 1의 액체 이동 의미 중 s3 |
| 기다리다 | `w405064` | `w405064-s1` | 단일 sense |
| 번지다 | `w434809` | `w434809-s1` | homograph 1의 액체가 젖어 퍼지는 s1 |
| 과거 | `w398310` | `w398310-s1` | homograph 1, 科擧 의미 |

## 후보와 생성자 잠정 평가

표의 `target_record_id/sense_id`는 현재 Canonical에서 확인한 정확한 대상이다. 링크 가능한 단일 대상이 확인되지 않은 표현은 `null`이며 text-only 초안에 해당한다. `reasoning`은 출처 뜻풀이를 인용하지 않은 평가 메모다. `failure_reason`은 보류·제외 사유 또는 해당 없음이다.

### 나그네 — `w408179` / `w408179-s1`

| target_text | target_record_id/sense_id | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
| --- | --- | --- | ---: | --- | --- | --- |
| 이방인 | `w469516` / `w469516-s1` | association | 4 | keep | 이동 중 만나는 낯선 사람의 인물상으로 확장된다. | — |
| 방랑자 | `w141383` / `w141383-s1` | association | 1 | keep | 장소를 정하지 않고 떠도는 사람이라는 가까운 표현 대안이다. | — |
| 먼 길 | null | scene | 3 | keep | 이동과 체류를 떠올리는 장면 축이다. | — |
| 보따리 | `w433572` / `w433572-s1` | scene | 5 | keep | 떠나는 사람의 짐 이미지로 이어진다. | — |
| 여인숙 | `w458765` / `w458765-s1` | scene | 4 | keep | 잠시 머무는 공간의 장면을 만든다. | — |
| 발자국 | `w427735` / `w427735-s1` | scene | 5 | keep | 이동 뒤에 남는 흔적으로 연결된다. | — |
| 고향 | `w25899` / `w25899-s3` | association | 3 | keep | 떠남과 귀환의 정서적 배경으로 이어진다. | — |
| 낯선 길 | null | scene | 3 | reject | 이동 장면을 제공하지만 `먼 길`과 이미지가 겹치고 구체성이 낮다. | 다른 후보와 장면 중복, 추가 구별점 없음 |

### 그리움 — `w44055` / `w44055-s1`

| target_text | target_record_id/sense_id | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
| --- | --- | --- | ---: | --- | --- | --- |
| 향수 | `w375472` / `w375472-s1` | association | 2 | keep | 고향을 향한 그리움으로 범위가 좁아지는 표현이다. | — |
| 허전하다 | `w503759` / `w503759-s2` | mood | 2 | keep | 상실감에 가까운 정서 색을 제공한다. | — |
| 기다림 | null | association | 3 | keep | 보고 싶은 대상의 부재와 함께 떠오르는 상태다. | — |
| 편지 | `w499292` / `w499292-s1` | scene | 3 | keep | 떨어져 있는 대상에게 소식을 보내는 장면이다. | — |
| 빈자리 | `w438222` / `w438222-s1` | scene | 3 | keep | 부재를 시각적으로 드러내는 이미지다. | — |
| 안부 | `w458625` / `w458625-s1` | association | 4 | keep | 그리운 사람의 소식을 묻는 행동으로 이어진다. | — |
| 먼 곳 | null | scene | 4 | keep | 거리와 부재를 함께 암시한다. | — |
| 저녁 불빛 | null | sensory | 5 | reject | 분위기 이미지는 가능하지만 입력 의미와의 연결이 약하고 임의성이 크다. | 뜻풀이만으로 근거가 부족한 일반 이미지 |

### 문턱 — `w425010` / `w425010-s1`

| target_text | target_record_id/sense_id | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
| --- | --- | --- | ---: | --- | --- | --- |
| 경계 | `w18966` / `w18966-s2` | association | 2 | keep | 물리적 출입 경계에서 기준의 한계라는 추상 이미지로 이어진다. | — |
| 문틈 | `w424648` / `w424648-s1` | scene | 3 | keep | 출입구 주변의 좁은 틈으로 장면을 확장한다. | — |
| 발끝 | `w137610` / `w137610-s1` | sensory | 4 | keep | 문턱을 넘는 순간의 신체 감각을 떠올린다. | — |
| 문고리 | `w125005` / `w125005-s1` | scene | 4 | keep | 출입문 주변 사물로 연결된다. | — |
| 첫발 | `w324950` / `w324950-s1` | association | 2 | keep | 경계를 넘어 시작하는 동작의 이미지다. | — |
| 현관 | `w506672` / `w506672-s1` | scene | 3 | keep | 문턱이 놓이는 공간과 연결된다. | — |
| 문 앞 | null | scene | 4 | reject | 문턱 주변을 반복하는 일반 위치 표현이다. | `현관`, `문틈`보다 새 장면 정보가 적음 |
| 문지방 | `w124390` / `w124390-s1` | association | 1 | keep | 물리적 의미가 매우 가까운 표현 대안이다. | — |

### 쓸쓸하다 — `w213407` / `w213407-s1`

| target_text | target_record_id/sense_id | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
| --- | --- | --- | ---: | --- | --- | --- |
| 외롭다 | `w466964` / `w466964-s1` | association | 1 | keep | 혼자이거나 의지할 곳이 없는 정서에 가까운 표현이다. | — |
| 적막하다 | `w279093` / `w279093-s2` | association | 1 | keep | 외로움의 의미를 직접 공유하는 가까운 표현이다. | — |
| 빈 방 | null | scene | 2 | keep | 사람의 부재를 공간으로 드러낸다. | — |
| 남겨지다 | `w515221` / `w515221-s1` | action | 3 | keep | 함께 떠나지 못하고 남은 상황으로 이어진다. | — |
| 혼자 남은 저녁 | null | scene | 3 | revise | 시간·상황을 더하면 장면이 구체화되지만 빈 방과 겹치고 표현이 길다. | 이미지 중복과 후보 형식의 장황함; 더 짧은 장면어 필요 |
| 냉기 | `w405166` / `w405166-s3` | sensory | 4 | keep | 차가운 분위기를 감각적으로 옮긴다. | — |
| 고요하다 | `w396318` / `w396318-s1` | mood | 2 | keep | 정적의 분위기를 제공하지만 외로움과 동일하지는 않다. | — |
| 저녁 창문 | null | scene | 5 | reject | 이미지 자체는 가능하나 입력 의미와의 연결을 특정할 근거가 없다. | 일반적인 장면 연상에 그침 |

### 흐르다 — `w508767` / `w508767-s3`

| target_text | target_record_id/sense_id | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
| --- | --- | --- | ---: | --- | --- | --- |
| 시냇물 | `w451822` / `w451822-s1` | association | 3 | keep | 흐르는 물의 대표적인 자연 장면이다. | — |
| 빗물 | `w437579` / `w437579-s1` | scene | 3 | keep | 고이고 흘러내리는 물의 장면으로 이어진다. | — |
| 물줄기 | `w425157` / `w425157-s1` | association | 2 | keep | 액체의 이동 경로를 가시화한다. | — |
| 배수구 | `w141743` / `w141743-s1` | scene | 3 | keep | 물이 빠져나가는 장소를 만든다. | — |
| 경사면 | `w395996` / `w395996-s1` | scene | 3 | keep | 낮은 쪽으로 이동하는 경로와 연결된다. | — |
| 졸졸 | `w484429` / `w484429-s1` | sensory | 2 | keep | 가는 물줄기의 흐름을 소리와 모양으로 표현한다. | — |
| 넘치다 | `w405549` / `w405549-s1` | association | 2 | keep | 액체가 경계를 넘어 나오는 특정 상황에서 가까운 동작이다. | — |
| 돌 틈 | null | scene | 4 | keep | 좁은 경로를 따라 흐르는 물의 장면을 만든다. | — |

### 기다리다 — `w405064` / `w405064-s1`

| target_text | target_record_id/sense_id | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
| --- | --- | --- | ---: | --- | --- | --- |
| 초조하다 | `w329138` / `w329138-s1` | mood | 2 | keep | 기다림이 길어질 때의 조급한 정서를 제공한다. | — |
| 시계 | `w199014` / `w199014-s1` | scene | 3 | keep | 기다리는 동안 확인하는 시간의 사물이다. | — |
| 문 앞 | null | scene | 4 | keep | 누군가를 기다리는 구체적인 위치가 된다. | — |
| 연락 | `w459386` / `w459386-s1` | association | 4 | keep | 도착 여부를 알리는 소식과 연결된다. | — |
| 기다림 | null | association | 1 | reject | 출발 표현을 명사화한 반복이라 새로운 탐색 경로가 거의 없다. | 표제어의 형태 변환에 그침; Canonical target도 확인되지 않음 |
| 빈 의자 | null | scene | 3 | keep | 아직 오지 않은 사람의 부재를 장면화한다. | — |
| 약속 시간 | null | scene | 2 | keep | 기다림의 시간적 조건을 구체화한다. | — |
| 그리움 | `w44055` / `w44055-s1` | mood | 3 | keep | 기다리는 대상이 그리운 사람일 때 정서가 겹친다. | — |

### 번지다 — `w434809` / `w434809-s1`

| target_text | target_record_id/sense_id | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
| --- | --- | --- | ---: | --- | --- | --- |
| 얼룩 | `w460510` / `w460510-s2` | scene | 3 | keep | 액체가 퍼진 뒤 남는 흔적이다. | — |
| 종이 | `w486086` / `w486086-s1` | scene | 2 | keep | 액체가 스며들어 퍼지는 표면의 장면이다. | — |
| 잉크 | `w273206` / `w273206-s1` | scene | 2 | keep | 번짐을 눈으로 확인할 수 있는 색 액체다. | — |
| 물기 | `w423973` / `w423973-s1` | sensory | 2 | keep | 젖은 상태의 촉감과 연결된다. | — |
| 번짐 | null | association | 1 | reject | 출발 동작을 명사화해 되풀이할 뿐 별도 탐색을 제공하지 않는다. | 형태상 반복; Canonical target도 확인되지 않음 |
| 종이결 | null | sensory | 4 | keep | 흡수 방향과 표면 질감을 떠올리는 감각 후보다. | — |
| 퍼지다 | `w495642` / `w495642-s5` | association | 2 | keep | 넓은 범위로 퍼지는 동작의 가까운 표현 대안이다. | — |
| 가장자리 | `w2472` / `w2472-s1` | scene | 3 | keep | 액체가 번져 닿는 바깥 경계로 이어진다. | — |

### 과거 — `w398310` / `w398310-s1`

| target_text | target_record_id/sense_id | relation_type | relevance | provisional_decision | reasoning (non-quoted) | failure_reason |
| --- | --- | --- | ---: | --- | --- | --- |
| 문과 | `w424599` / `w424599-s1` | association | 2 | keep | 과거 제도의 문관 선발 갈래를 가리킨다. | — |
| 무과 | `w120720` / `w120720-s1` | association | 2 | keep | 무관 선발 갈래를 가리킨다. | — |
| 급제 | `w401322` / `w401322-s2` | scene | 2 | keep | 시험 합격이라는 결과 장면과 연결된다. | — |
| 방 | `w141678` / `w141678-s1` | scene | 3 | keep | 합격자 명부를 통해 결과를 구체화한다. | — |
| 선비 | `w443813` / `w443813-s1` | association | 3 | keep | 응시·학문을 둘러싼 인물상을 떠올리게 한다. | — |
| 과거장 | `w30760` / `w30760-s1` | scene | 3 | keep | 시험이 치러지는 장소를 직접 제시한다. | — |
| 붓과 먹 | null | sensory | 4 | keep | 시험을 준비하고 치르는 필기 도구의 감각 이미지다. | — |
| 합격 방 | null | scene | 5 | reject | 어떤 장소나 표지인지 의미가 모호해 장면이 안정적으로 읽히지 않는다. | 모호한 text-only 표현; 대상 sense를 특정할 수 없음 |

## 집계

| 항목 | 결과 |
| --- | ---: |
| 고정 코호트 | 8 / 8 |
| 생성 후보 | 64 (각 출발 sense 8, 최대 8) |
| 생성자 잠정 평가 | keep 56, revise 1, reject 7 |
| Canonical target record/sense 연결 | 46 |
| text-only 초안 (`target_record_id_or_null=null`) | 18 |
| 후보 관계 유형 | association 21, scene 31, sensory 7, mood 4, action 1, near 0 |
| 연상 relevance 1 잠정 후보 | 4 — 방랑자, 문지방, 외롭다, 적막하다 |
| 새 `direct` / `antonym` 작성 | 0 |
| 출발 sense의 기존 공식 관계와 정확한 target ID 중복 | 0 / 64 |
| 웹·문학·말뭉치 문맥 입력 및 문맥 검색 | 0 |

ID 연결은 해당 Canonical 표제어의 정확한 homograph/sense를 뜻풀이까지 대조해 선택했다. text-only 초안은 현재 표제어·sense를 임의로 만들거나 비슷한 ID에 붙이지 않았다. `keep`은 제품 데이터로 승인되었다는 뜻이 아니다. 특히 관계 relevance는 생성자 평가이므로 같은 UI 그룹의 독립 오너 평가 후 달라질 수 있다.

## 해석상 한계

- 짧은 뜻풀이에서 바로 생성한 결과라 장면 후보는 익숙한 사물·장소 쪽으로 기울었다. 실제 문장에 자연스럽게 쓰이는지 검증하지 않았다.
- 이 코호트의 8개 항목과 한 번의 생성으로 Typewriter 전체의 생산 품질이나 비용 우위를 주장할 수 없다.
- 사람이 직접 편집한 잠정 점수이며 blind independent reviewer의 평가가 아니다. 후보 수와 keep 비율은 생산자 자체 평가다.
- 모델 세부 버전·파라미터, 토큰, 생성·검수 시간은 이 인터페이스에서 계측할 수 없어 방법 간 정량 비교에는 결측으로 남긴다.
- 이번 PR은 실험 보고서 한 파일만 추가한다. Canonical, 제품 데이터·코드, SQLite, 공통 정책 및 다른 실험군의 보고서는 변경하지 않았다.
