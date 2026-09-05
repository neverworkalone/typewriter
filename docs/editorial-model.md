# M1 provisional Editorial Model — #18

## 범위와 상태

이 문서는 M1-2에서 처음 canonical에 넣은 **대표 출발어 40개**를 편집한
결정 기록이다. 정식 JSON Schema나 장기 ontology가 아니다. 실제 검색과 다음
배치의 편집에서 문제가 드러나면 이 모델을 다시 줄이거나 바꿀 수 있다.

canonical 원본은 [`data/canonical/pilot.jsonl`](../data/canonical/pilot.jsonl)이다.
이 PR은 `docs/pilot-scope.md`의 대표 ID 40개를 검색 출발어로 포함하고, 관계
대상을 완결하기 위한 참조 전용 레코드 29개를 함께 둔다.

| 항목 | 수량 | 의미 |
| --- | ---: | --- |
| 전체 canonical 레코드 | 69 | 출발어 40 + 참조 전용 29 |
| 검색 출발어 | 40 | #17에서 명시한 대표 ID와 정확히 일치 |
| 참조 전용 레코드 | 29 | 관계 도착점으로만 수록하며 출발어로 세지 않음 |
| sense | 74 | 다의어는 하나의 레코드 안에서 sense를 나눔 |
| relation | 56 | 사람이 이 배치에서 직접 판단해 남긴 관계 |

300개 전체 후보, SQLite, 정식 schema, 자동 의미 판정은 이 PR의 범위가
아니다. 미검수 초안이나 외부 원문은 저장하지 않았고, 아래의 gloss·관계
판단·문장 틀은 Typewriter가 이 배치를 위해 작성한 편집 기록이다.

## 검수 기록 약속

`docs/pilot-scope.md`의 **후속 검수 최소 체크리스트**를 이 배치에도
적용했다. 아래의 40개 ledger가 각 대표 ID의 결정 상태와 짧은 판단을 한 번씩
기록한다.

- `included`인 출발어만 canonical에 들어간다. 이 배치의 40개는 모두
  `role: start`로 수록되었다.
- 참조 레코드는 `role: reference-only`로만 수록되며, 검색 출발어 수에
  포함하지 않는다.
- 이 배치에 `held`, `duplicate`, `excluded` 출발어는 없다. 다음 배치에서
  그런 상태를 쓰면 반드시 상태를 택한 사유를 함께 기록하고 canonical 밖에
  둔다.
- 관계 후보를 보류한 경우에는 레코드에 억지로 넣지 않고 아래의 보류 기록에
  남긴다. 따라서 출발어가 `included`라는 사실이 모든 가능한 관계를
  승인했다는 뜻은 아니다.

## 40개 출발어 편집 ledger

| 후보 ID | 상태 | 역할 | 검수 판단 |
| --- | --- | --- | --- |
| w001 | included | start | `고요`는 잠잠한 상태로 수록하고 `평온`은 mood, `소리`는 sensory로만 연결했다. |
| w002 | included | start | `불안`과 `긴장`은 near, `의심`은 mood로 구분해 직접 대체로 올리지 않았다. |
| w004 | included | start | 대상을 향한 그리움과 남는 여운을 분리하고, 편지는 association으로만 두었다. |
| w009 | included | start | 몸과 태도의 팽팽함을 중심으로 잡아 `불안`과 near로 연결했다. |
| w021 | included | start | 희망이 불러오는 `바라다`는 action, 미래 장면인 꿈은 association으로 기록했다. |
| w023 | included | start | 사실을 믿지 못하는 마음을 `불안`과 mood로 연결하고 direct는 보류했다. |
| w026 | included | start | 후보 표면형은 `담담`, canonical lemma는 `담담하다`로 정리하고 감정 반응 문장에서만 direct를 허용했다. |
| w030 | included | start | 마음의 안정인 `평온`과 `평안`의 direct 문장 틀을 확인하고 `고요`는 mood로 남겼다. |
| w031 | included | start | `다정하다`로 정규화하고 사람을 대하는 태도에서 `냉정하다`와 antonym으로 기록했다. |
| w032 | included | start | `냉정하다`로 정규화하고 `다정하다`와 반대 축을 이루는지 확인했다. |
| w036 | included | start | `어색하다`로 정규화하고 관계의 거리감인 `서먹하다`와 near로 구분했다. |
| w040 | included | start | `선명하다`로 정규화하고 시각 윤곽에서 `또렷하다`만 direct, `희미하다`는 antonym으로 두었다. |
| w041 | included | start | `희미하다`로 정규화하고 `선명하다`와 antonym, 빛과는 sensory로 연결했다. |
| w048 | included | start | 무게와 부담의 명사 `가벼움`을 유지하고 `무거움`과 antonym으로 기록했다. |
| w049 | included | start | 무게와 부담의 명사 `무거움`을 유지하고 `가벼움`과 antonym으로 기록했다. |
| w060 | included | start | 사건 뒤 남는 `여운`을 그리움과 mood, 메아리와 association으로 구분했다. |
| w061 | included | start | 꽃 냄새 문장에서 `향내`로 직접 바꿔 넣을 수 있는지 확인했다. |
| w066 | included | start | `빛`의 광원과 색조 sense를 분리하고 각각 햇살·색조와 sensory로만 연결했다. |
| w079 | included | start | 물체가 닿는 감각으로 한정하고 `감촉`과의 direct 문장 틀을 기록했다. |
| w086 | included | start | 넓은 청각어 `소리`를 유지하고 구체 장면인 `빗소리`와 sensory로 구분했다. |
| w091 | included | start | 비가 내리는 청각 장면으로 정의하고 넓은 `소리`와 sensory 방향만 남겼다. |
| w099 | included | start | 맛을 가리키는 `단맛`과 인상인 `달콤함`의 direct 문장 틀을 확인했다. |
| w106 | included | start | 몸의 아픈 감각으로 한정하고 `아픔`과 direct로 기록했다. |
| w120 | included | start | 사람의 말소리 sense에서 `음성`과 direct로 기록하고 다른 소리로 넓히지 않았다. |
| w121 | included | start | 시간어 `새벽`을 역의 이동 장면과 scene으로 연결했다. |
| w132 | included | start | 기상 현상인 `비`를 `빗소리`라는 감각 이미지로 옮기는 sensory만 남겼다. |
| w133 | included | start | 신체 기관과 기상 현상이라는 `눈`의 두 sense를 분리하고 각각 action·scene으로 연결했다. |
| w143 | included | start | 자연 공간인 `숲`과 구성 이미지인 나무를 association으로 구분했다. |
| w147 | included | start | 창문 가까운 공간을 새벽과 함께 읽는 scene으로 기록했다. |
| w157 | included | start | 장소인 `역`은 `기다리다`라는 행동을 불러오지만 대체어가 아님을 명시했다. |
| w181 | included | start | 기본 이동 동사 `걷다`와 느긋한 `거닐다`를 near로 구분했다. |
| w184 | included | start | 기다림이 불안을 만들 수 있다는 mood만 기록하고 동의어로 처리하지 않았다. |
| w192 | included | start | 문이나 공간을 통하게 하는 동사로 `닫다`와 antonym을 확인했다. |
| w202 | included | start | 시선 동사 `바라보다`와 강한 고정 시선인 `응시하다`를 near로 구분했다. |
| w217 | included | start | 이루어지기를 원하는 동사로 한정하고 `원하다`와 direct 문장 틀을 확인했다. |
| w237 | included | start | 기록·사용·착용·쓴맛의 네 sense를 나누고 앞의 세 sense에만 direct를 허용했다. |
| w288 | included | start | 걱정이 풀리는 표현으로 `안도하다`와 direct 문장 틀을 확인했다. |
| w296 | included | start | 가빠진 숨을 안정시키는 표현으로 `호흡을 가다듬다`와 direct, `쉬다`와 action을 구분했다. |
| w299 | included | start | 길을 잃은 상태와 그 뒤 헤매는 행동을 구분해 `헤매다`는 near로만 기록했다. |
| w300 | included | start | 특정 일이 남는 표현과 일반적인 꺼림칙함을 구분해 `찜찜하다`는 near, `불안`은 mood로 두었다. |

## 임시 레코드 모델

이 구조는 현재 69개 레코드를 사람이 읽고 고치기 위한 최소 표현이다. 정식
schema로 고정하지 않는다.

| 필드 | 현재 의미 |
| --- | --- |
| `id` | 출발어는 `w###`, 참조 전용은 `r###`인 저장소 내부 식별자 |
| `record_type` | 일반 표제어 `entry` 또는 고정된 표현 `expression` |
| `role` | 검색 출발어 `start` 또는 관계 도착점 전용 `reference-only` |
| `candidate_id` | 출발어인 경우 `docs/pilot-scope.md`의 후보 ID. 참조 전용에는 없음 |
| `lemma` | 현재 배치에서 편집 기준으로 삼은 표제어. 활용·어근형 후보는 필요한 만큼 dictionary form으로 정리 |
| `search_forms` | 후보표의 표면형과 현재 검색에 필요한 정규화형. 표현은 고정된 띄어쓰기를 유지 |
| `senses` | 하나 이상의 의미 단위. 각 sense가 독립 ID와 품사를 가짐 |
| `gloss` | Typewriter가 짧게 작성한 writer-facing 의미 설명 |
| `relations` | source sense에서 target record/sense로 향하는 관계. 대상 sense가 중요할 때 `target_sense`를 함께 기록 |
| relation `note` | 관계를 왜 남겼는지와 direct 문장 틀을 적는 편집 판단 |

이번 배치에서 `lemma`는 검색 후보 표면형을 무시한다는 뜻이 아니다. 예를
들어 `다정`, `선명`, `담담`은 `search_forms`에 남기고, sense의 품사와 활용을
검토하기 쉬운 `다정하다`, `선명하다`, `담담하다`를 lemma로 삼았다. 이것은
한국어 전체의 정규화 규칙을 확정한 것이 아니라 이 40개를 혼동 없이 읽기 위한
작은 편집 결정이다.

## 관계 유형과 임시 UI projection

관계 유형은 source sense와 target sense 사이의 **정직한 거리**를 표시한다.
평면적인 synonym 목록으로 합치지 않는다.

| 내부 type | 이 배치에서의 의미 | 임시 UI 묶음 |
| --- | --- | --- |
| `direct` | 표시한 sense와 문장 틀에서 직접 바꿔 넣을 수 있음 | 유의어 |
| `near` | 중심 뜻이 가깝지만 대체하면 범위·강도·상황이 달라짐 | 말의 결 |
| `antonym` | 같은 비교 축에서 반대 방향임 | 반의어 |
| `mood` | 비슷한 정서·톤을 불러오지만 뜻의 등가가 아님 | 말의 결 |
| `scene` | 함께 놓을 수 있는 장면·상황을 연다 | 연상 |
| `sensory` | 소리·빛·냄새·맛·몸 감각의 이미지를 잇는다 | 연상 |
| `action` | source가 자연스럽게 불러오는 동작. target은 이 배치에서 동사 또는 동작 표현이어야 함 | 연상 |
| `association` | writer에게 유용하지만 더 넓은 연결 | 연상 |

이 projection은 M1에서 검색 결과를 생각하기 위한 메모이며 제품 UI 계약이
아니다. 특히 `direct`와 `near`를 같은 결과로 보여 주더라도 데이터에서는
둘을 합치지 않는다.

## 회귀로 고정한 편집 판단

아래 결과는 이 배치에서 하나의 기대값으로 고정한 사례다. 대체 후보를
여러 type 중 하나로 허용하지 않는다.

| source | target | 기대 type | 검수 이유 |
| --- | --- | --- | --- |
| `w026-s1 담담하다` | `r008-s1 덤덤하다` | `direct` | “소식을 담담하게/덤덤하게 받아들였다”에서 직접 대체 가능 |
| `w040-s1 선명하다` | `r030-s1 또렷하다` | `direct` | 시각 윤곽 문맥에서 직접 대체 가능 |
| `w192-s1 열다` | `r011-s1 닫다` | `antonym` | 문·뚜껑의 상태를 바꾸는 반대 방향 |
| `w299-s1 길을 잃다` | `r019-s1 헤매다` | `near` | 상태와 그 뒤의 이동 행동이 달라 직접 대체·반의가 아님 |
| `w133-s1 눈(기관)` | `w202-s1 바라보다` | `action` | 신체 기관이 시선 행동을 불러오며 target이 동사임 |
| `w021-s1 희망` | `w217-s1 바라다` | `action` | 희망이 바람의 행동을 불러오며 target이 동사임 |
| `w004-s1 그리움` | `w060-s1 여운` | `mood` | 함께 남을 수 있는 정서 색이지만 직접 대체어가 아님 |
| `w132-s1 비` | `w091-s1 빗소리` | `sensory` | 기상 장면을 청각 이미지로 확장 |

## 보류한 관계와 경계

다음 후보는 현재 canonical에 넣지 않았다. 이 목록은 “관계가 있을 수
있다”는 메모이지, 미검수 데이터를 우회해 수록한 것이 아니다.

| 보류 후보 | 보류 이유 |
| --- | --- |
| `그리움 → 애틋함`의 `direct` | 정서 색은 가까울 수 있지만 일반 문장 대체를 확인하지 못해 mood 이상으로 확정하지 않음 |
| `길을 잃다 → 찾다`의 `antonym` | 결과 방향이 반대일 수 있어도 같은 어휘 축의 반의어라고 볼 근거가 부족함 |
| `빛 → 바람`의 `action` | 바람은 이 배치에서 action target이 아니므로 해당 관계를 canonical에 만들지 않음 |
| `카페 → 부엌`, `시계 → 계절` 같은 넓은 장면 연결 | writer에게 즉시 유용한 장면인지 확인되지 않아 quota처럼 채우지 않음 |

## 검증 기록

다음 검사를 실행했다.

```sh
node scripts/validate/canonical-jsonl.mjs
node --test tests/validate-canonical-jsonl.test.mjs
```

추가로 이 배치의 JSONL을 읽어 다음을 확인했다.

- 레코드 69개, 출발어 40개, 참조 전용 29개, sense 74개, 관계 56개;
- 출발어 ID가 `docs/pilot-scope.md`의 명시적 대표 40개와 정확히 일치;
- 모든 relation target과 `target_sense`가 존재;
- self-reference, 동일 source/type/target 중복, 빈 필수 필드가 없음;
- relation type별 수량은 `direct` 14, `near` 7, `antonym` 7, `mood` 9,
  `scene` 3, `sensory` 7, `action` 4, `association` 5;
- 14개의 `direct` 관계 모두 JSONL의 `note`에 확인한 문장 틀을 갖고 있음;
- 4개의 `action` 관계 target은 모두 동사 sense이며, 장소·감각 명사를
  action target으로 잘못 표시하지 않음.

이 검증은 M0 JSONL 문법 검증과 M1 편집 기록을 보여 주는 수준이다. 정식
lexical schema, 의미 validator, ranking, SQLite 재현성 검증은 M2의 작업으로
남긴다.
