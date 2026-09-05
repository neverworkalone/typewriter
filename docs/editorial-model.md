# M1 provisional Editorial Model — #18/#19

## 범위와 상태

이 문서는 M1-2에서 처음 canonical에 넣은 대표 출발어 40개와 M1-3에서
추가한 **경계 사례 40개**를 편집한 결정 기록이다. 정식 JSON Schema나 장기
ontology가 아니다. 실제 검색과 다음 배치의 편집에서 문제가 드러나면 이
모델을 다시 줄이거나 바꿀 수 있다.

canonical 원본은 [`data/canonical/pilot.jsonl`](../data/canonical/pilot.jsonl)이다.
이 누적 배치는 `docs/pilot-scope.md`의 대표 ID 40개와 #19의 추가 경계 ID
40개를 검색 출발어로 포함하고, 관계 대상을 완결하기 위한 참조 전용 레코드
29개를 함께 둔다.

| 항목 | 수량 | 의미 |
| --- | ---: | --- |
| 전체 canonical 레코드 | 109 | 출발어 80 + 참조 전용 29 |
| 검색 출발어 | 80 | #17 대표 40 + #19 경계 사례 40 |
| 참조 전용 레코드 | 29 | 관계 도착점으로만 수록하며 출발어로 세지 않음 |
| sense | 125 | 다의어는 하나의 레코드 안에서 sense를 나눔 |
| relation | 91 | 사람이 이 누적 배치에서 직접 판단해 남긴 관계 |

300개 전체 후보, SQLite, 정식 schema, 자동 의미 판정은 이 PR의 범위가
아니다. 미검수 초안이나 외부 원문은 저장하지 않았고, 아래의 gloss·관계
판단·문장 틀은 Typewriter가 이 배치를 위해 작성한 편집 기록이다.

## 검수 기록 약속

`docs/pilot-scope.md`의 **후속 검수 최소 체크리스트**를 이 배치에도
적용했다. 아래의 #18 40개 ledger와 #19 추가 40개 ledger가 각 검색 출발어의
결정 상태와 짧은 판단을 한 번씩 기록한다.

- `included`인 출발어만 canonical에 들어간다. #18과 #19의 각 40개는 모두
  `role: start`로 수록되었다.
- 참조 레코드는 `role: reference-only`로만 수록되며, 검색 출발어 수에
  포함하지 않는다.
- 참조 레코드도 아래의 별도 ledger에서 `included` 상태, `reference-only`
  역할, 그리고 이 배치에서 출발어가 아닌 이유를 항목별로 기록한다.
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
| w032 | included | start | `냉정하다`로 정규화하고 대인 태도 sense(`w032-s1`)를 `다정하다`와 반대 축으로, 판단 sense(`w032-s2`)를 별도로 기록했다. |
| w036 | included | start | `어색하다`로 정규화하고 관계의 거리감인 `서먹하다`와 near로 구분했다. |
| w040 | included | start | `선명하다`로 정규화하고 시각 윤곽에서 `또렷하다`만 direct, `희미하다`는 antonym으로 두었다. |
| w041 | included | start | `희미하다`로 정규화하고 `선명하다`와 antonym, 빛과는 sensory로 연결했다. |
| w048 | included | start | 물리적 무게와 마음·일의 부담을 두 sense로 나누고 각각 대응하는 `무거움` sense와 antonym으로 기록했다. |
| w049 | included | start | 물리적 무게와 마음·일의 부담을 두 sense로 나누고 각각 대응하는 `가벼움` sense와 antonym으로 기록했다. |
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

## 29개 참조 전용 편집 ledger

참조 레코드도 blanket 승인으로 처리하지 않는다. 아래 29개는 모두
`included` 상태와 `reference-only` 역할을 갖지만, 현재 배치에서는 관계
도착점으로만 검수했다. `w###`인 항목은 이미 300개 후보에 있으므로 별도의
`r###` identity를 만들지 않고, 후속 배치에서 같은 ID를 `start`로 승격한다.

| ID | 상태 | 역할 | 수록·역할 사유 |
| --- | --- | --- | --- |
| w137 | included | reference-only | 후보표의 `햇살`을 `w066 빛`의 자연 감각 target으로만 검수했다. |
| w193 | included | reference-only | 후보표의 `닫다`를 `w192 열다`의 반의 target으로만 검수했다. |
| w275 | included | reference-only | 후보표의 `꿈`을 `w021 희망`이 여는 미래 장면 target으로만 검수했다. |
| w176 | included | reference-only | 후보표의 `편지`를 `w004 그리움`의 전달 장면 target으로만 검수했다. |
| w269 | included | reference-only | 후보표의 `나무`를 `w143 숲`의 구성 이미지 target으로만 검수했다. |
| w088 | included | reference-only | 후보표의 `메아리`를 `w060 여운`의 소리 이미지 target으로만 검수했다. |
| w097 | included | reference-only | 후보표의 `눈길`을 `w133-s2 눈`의 장면 target으로만 검수했다. |
| r001 | included | reference-only | 후보표 밖의 `향내`를 `w061 향기`의 동일 냄새 문장 틀 target으로만 검수했다. |
| r002 | included | reference-only | 후보표 밖의 `감촉`을 `w079 촉감`의 접촉 감각 문장 틀 target으로만 검수했다. |
| r004 | included | reference-only | 후보표 밖의 `달콤함`을 `w099 단맛`의 동일 명사 자리 target으로만 검수했다. |
| r005 | included | reference-only | 후보표 밖의 `아픔`을 `w106 통증`의 신체 감각 문장 틀 target으로만 검수했다. |
| r006 | included | reference-only | 후보표 밖의 `음성`을 `w120 목소리`의 말소리 문장 틀 target으로만 검수했다. |
| r008 | included | reference-only | 후보표 밖의 `덤덤하다`를 `w026 담담하다`의 감정 반응 문장 틀 target으로만 검수했다. |
| r009 | included | reference-only | 후보표 밖의 `평안`을 `w030 평온`의 마음 상태 문장 틀 target으로만 검수했다. |
| r010 | included | reference-only | 후보표 밖의 `거닐다`를 `w181 걷다`와 비교할 느긋한 이동 target으로만 검수했다. |
| r012 | included | reference-only | 후보표 밖의 `응시하다`를 `w202 바라보다`와 비교할 시선 행동 target으로만 검수했다. |
| r013 | included | reference-only | 후보표 밖의 `원하다`를 `w217 바라다`의 원하는 행위 target으로만 검수했다. |
| r014 | included | reference-only | 후보표 밖의 `작성하다`를 `w237-s1 쓰다`의 기록 문장 틀 target으로만 검수했다. |
| r015 | included | reference-only | 후보표 밖의 `사용하다`를 `w237-s2 쓰다`의 도구 이용 문장 틀 target으로만 검수했다. |
| r016 | included | reference-only | 후보표 밖의 `착용하다`를 `w237-s3 쓰다`의 몸에 거는 문장 틀 target으로만 검수했다. |
| r017 | included | reference-only | 후보표 밖의 `안도하다`를 `w288 마음이 놓이다`의 걱정 해소 문장 틀 target으로만 검수했다. |
| r018 | included | reference-only | 후보표 밖의 표현 `호흡을 가다듬다`를 `w296 숨을 고르다`의 호흡 안정 target으로만 검수했다. |
| r019 | included | reference-only | 후보표 밖의 `헤매다`를 `w299 길을 잃다` 뒤의 이동 행동과 비교할 target으로만 검수했다. |
| r020 | included | reference-only | 후보표 밖의 `찜찜하다`를 `w300 마음에 걸리다`와 비교할 꺼림칙한 감정 target으로만 검수했다. |
| r026 | included | reference-only | 후보표 밖의 `서먹하다`를 `w036 어색하다`와 비교할 관계 거리감 target으로만 검수했다. |
| r028 | included | reference-only | 후보표 밖의 `약`을 `w237-s4 쓰다`의 쓴맛 장면 target으로만 검수했다. |
| r029 | included | reference-only | 후보표 밖의 `색조`를 `w066-s2 빛`의 색 감각 target으로만 검수했다. |
| r030 | included | reference-only | 후보표 밖의 `또렷하다`를 `w040 선명하다`의 시각 윤곽 문장 틀 target으로만 검수했다. |
| r031 | included | reference-only | 후보표 밖의 `쉬다`를 `w296 숨을 고르다` 뒤에 이어지는 행동 target으로만 검수했다. |

## #19 추가 40개 경계 사례 ledger

아래 40개는 #17의 대표 40개에 더해 누적 출발어를 80개로 만든다. 모두
`included`와 `start`로 수록했지만, 모든 후보 관계를 승인한 것은 아니다.
다의어와 표현의 경계를 먼저 기록하고, 관계는 확인한 방향만 남겼다.

| 후보 ID | 상태 | 역할 | 검수 판단 |
| --- | --- | --- | --- |
| w003 | included | start | `설렘`은 아직 오지 않은 일을 기다리는 정서로 `기쁨`과 mood만 연결했다. |
| w005 | included | start | 관계에서 기대가 어긋난 `서운함`을 `그리움`과 mood로만 연결하고 direct는 보류했다. |
| w010 | included | start | 감정 명사 `망설임`을 선택 전의 상태로 두고 `선택하다`는 action target으로만 기록했다. |
| w018 | included | start | `기쁨`이 `웃다`를 불러오는 방향을 action으로 기록하고 행동과 감정을 합치지 않았다. |
| w034 | included | start | `완고하다`를 태도를 굽히지 않는 adjective sense로 두고 `유연하다`와 antonym으로 연결했다. |
| w035 | included | start | `유연하다`를 상황에 맞추는 adjective sense로 두고 `완고하다`와 antonym으로 연결했다. |
| w050 | included | start | 속도의 명사 `느림`을 `빠름`과 antonym으로 연결했다. |
| w051 | included | start | 속도의 명사 `빠름`을 `느림`과 antonym으로 연결했다. |
| w071 | included | start | `색채`는 `빛`의 색조 sense와 sensory로 연결하고 동일어로 다루지 않았다. |
| w077 | included | start | 공기와 물체의 눅눅함을 `비`가 여는 sensory 장면과 구분했다. |
| w090 | included | start | 여러 사람의 낮은 소리인 `웅성거림`을 넓은 `소리`와 sensory로 연결했다. |
| w096 | included | start | `시선`은 `바라보다`가 향하는 방향으로 기록하고 명사와 동사를 대체시키지 않았다. |
| w112 | included | start | `눈물`은 감정의 흔적이지만 특정 감정은 아니므로 `그리움`과 mood로만 연결했다. |
| w127 | included | start | 시간 단위인 `계절`이 `비` 같은 날씨 scene을 열 수 있음을 기록했다. |
| w140 | included | start | 물결 sense와 비유적 흐름 sense를 나누고, 물결의 소리만 sensory로 연결했다. |
| w145 | included | start | 좁은 길인 `골목`과 `창가`의 장면 조합을 scene으로 기록했다. |
| w151 | included | start | 생활 공간인 `방`과 `창가`의 실내 scene을 연결하고 공간을 quota처럼 확장하지 않았다. |
| w160 | included | start | 가게인 `카페`와 `창가`의 머무는 scene만 기록하고 `부엌` 같은 먼 near는 만들지 않았다. |
| w190 | included | start | `숨기다`는 동사로 유지하고 숨기는 대상이 될 수 있는 `마음`과 association으로만 연결했다. |
| w191 | included | start | 잃은 대상을 찾는 sense와 정보·답을 찾는 sense를 나누고 후자만 `확인하다` action으로 연결했다. |
| w194 | included | start | 손으로 붙드는 sense와 기회를 얻는 sense를 나누되 두 sense 사이에 임의 관계를 만들지 않았다. |
| w195 | included | start | 내려 두는 sense와 풀어 보내는 sense를 나누고 활용형 차이를 별도 표제어로 만들지 않았다. |
| w203 | included | start | `웃다`는 동작이고 `기쁨`은 그 동작의 가능한 mood라는 방향만 기록했다. |
| w207 | included | start | 물리적으로 흔들리는 sense와 판단이 흔들리는 sense를 나누고 후자만 `불안`과 mood로 연결했다. |
| w213 | included | start | 품에 안는 sense와 책임·결과를 떠맡는 sense를 분리했다. |
| w218 | included | start | `거절하다`는 행동, `서운함`은 가능한 결과 정서로 분리해 mood 방향만 기록했다. |
| w220 | included | start | 지키기로 정하는 약속과 만날 시간·장소를 정하는 약속을 두 sense로 나누었다. |
| w224 | included | start | 사실이나 상태를 알아보는 확인 행동으로 정의하고 `찾다`의 정보 탐색 뒤에만 연결했다. |
| w225 | included | start | 여럿 중 하나를 고르는 동사로 정의하고 `망설임` 뒤의 action target으로만 연결했다. |
| w231 | included | start | 상태가 달라지는 변화 동사로 수록했으며 모든 변화 결과를 relation으로 채우지 않았다. |
| w233 | included | start | 구조나 질서가 내려앉는 붕괴 동사로 수록했으며 `변하다`와 자동 near로 만들지 않았다. |
| w241 | included | start | 글을 담는 재료인 `종이`와 `문장`을 association으로 구분했다. |
| w245 | included | start | 글의 단위인 `문장`이 `쓰다`라는 행동을 불러오는 방향만 action으로 기록했다. |
| w247 | included | start | 대상을 부르는 `이름`과 문장 속 특정 기능을 association으로 연결했다. |
| w257 | included | start | 입는 물건인 `옷`과 재질 감각인 `촉감`을 sensory로 연결했다. |
| w271 | included | start | 내면의 마음과 하려는 뜻의 두 sense를 나누고 각각 희망·바라다와 다른 type으로 연결했다. |
| w276 | included | start | 사실에 맞는 내용인 `진실`을 `거짓말`과 같은 사실성 축의 antonym으로 기록했다. |
| w277 | included | start | 사실이 아닌 내용을 말하는 `거짓말`을 `진실`과 antonym으로 기록했다. |
| w289 | included | start | 고정 표현 `속이 타다`는 불안한 정서를 장면화하는 expression으로 수록했다. |
| w297 | included | start | 고정 표현 `귀를 기울이다`는 소리를 집중해 듣는 expression으로 수록했다. |

## 임시 레코드 모델

이 구조는 현재 109개 레코드를 사람이 읽고 고치기 위한 최소 표현이다. 정식
schema로 고정하지 않는다.

| 필드 | 현재 의미 |
| --- | --- |
| `id` | 후보표에 있는 항목은 기존 `w###`, 후보표 밖의 순수 참조는 `r###`인 저장소 내부 식별자 |
| `record_type` | 일반 표제어 `entry` 또는 고정된 표현 `expression` |
| `role` | 검색 출발어 `start` 또는 관계 도착점 전용 `reference-only` |
| `candidate_id` | 후보표에 대응하는 출발어 또는 참조 전용 레코드의 후보 ID. 후보표 밖 순수 참조에는 없음 |
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
| `w040-s1 선명하다` | `r030-s1 또렷하다` | `direct` | “멀리서도 윤곽이 선명하다/또렷하다”에서 같은 서술 자리의 대체 |
| `w099-s1 단맛` | `r004-s1 달콤함` | `direct` | “이 과일의 단맛이/달콤함이 강하게 느껴진다”에서 같은 명사 주어 자리의 대체 |
| `w192-s1 열다` | `w193-s1 닫다` | `antonym` | 문·뚜껑의 상태를 바꾸는 반대 방향 |
| `w031-s1 다정하다` | `w032-s1 냉정하다` | `antonym` | 사람을 대하는 태도 sense끼리의 반대 축 |
| `w048-s1 가벼움` | `w049-s1 무거움` | `antonym` | 물체의 물리적 무게 sense끼리의 반대 축 |
| `w048-s2 가벼움` | `w049-s2 무거움` | `antonym` | 일이나 마음의 부담 sense끼리의 반대 축 |
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

## #19 경계 기준과 relation 방향

### Sense를 나누는 기준

같은 표면형이라도 다음 두 조건이 함께 보이면 sense를 나눈다.

1. 목적어·주어·장면 같은 문장 틀이 달라져 서로 바꿔 읽기 어렵다.
2. writer가 다음에 찾을 관계의 방향이나 품사가 달라진다.

이 기준으로 `눈`, `빛`, `쓰다`에 더해 #19의 `찾다`, `잡다`, `놓다`,
`흔들리다`, `안다`, `약속하다`, `마음`, `파도`를 나눴다. 반대로 하나의
정서 색이나 강도 차이만으로는 sense를 늘리지 않았다. 예를 들어 `설렘`의
강한 정도를 별도 sense로 만들지 않았고, `기다렸다` 같은 활용형도 새
표제어로 세지 않았다.

### 표현을 독립 검색 단위로 두는 기준

띄어쓰기와 조사가 고정되어 있고, 전체가 한 단어로는 보존하기 어려운
상황·감정·행동을 불러오면 `expression`으로 둔다. `마음이 놓이다`,
`숨을 고르다`, `길을 잃다`, `속이 타다`, `귀를 기울이다`가 이 배치의
사례다. 이때도 단순한 활용형이나 임의의 명사구는 표현으로 올리지 않는다.
`숨기다`, `확인하다`, `웃다`는 단일 동사이고, `빗소리`와 `눈물`은 한
표제어로 기능하는 명사이므로 expression이 아니다.

### 방향성과 품사 제약

관계는 모두 source sense에서 target sense로 향한다. 대칭이어 보이는
관계도 자동으로 반대 방향을 만들지 않고, 양쪽 판단이 있을 때만 양방향
행을 남긴다.

| 관계 | 방향·품사 결정 |
| --- | --- |
| `direct` | 같은 sense의 같은 문장 슬롯에서 확인한다. 품사가 달라도 표현 전체가 같은 슬롯에 들어가는 경우만 허용하며, 문장 틀이 없으면 수록하지 않는다. |
| `near` | 중심 뜻이 가까운 방향만 기록할 수 있고 대칭을 가정하지 않는다. |
| `antonym` | 같은 비교 축과 대응 sense끼리만 연결한다. `w048-s1 ↔ w049-s1`처럼 물리 축과 비유 축을 섞지 않는다. |
| `mood` | source가 불러오는 정서·톤 방향이며 target이 source의 대체어라는 뜻이 아니다. |
| `scene` | source에서 함께 놓을 수 있는 장소·시간·상황으로 확장한다. |
| `sensory` | source의 감각을 다른 감각 이미지나 더 구체적인 감각 장면으로 확장한다. |
| `action` | target은 동사 또는 동작 표현이어야 한다. source는 명사·형용사·표현일 수 있지만 action target을 명사로 표시하지 않는다. |
| `association` | 방향은 writer가 source에서 target을 떠올릴 수 있는지로 판단하며, 품사 일치를 요구하지 않는다. |

따라서 `기쁨 → 웃다`는 action, `웃다 → 기쁨`은 mood가 될 수 있지만
두 행을 같은 관계로 복제하지 않는다. 내부 type을 UI에서 넓은 묶음으로
보이게 하는 projection은 #18의 임시 표를 유지한다. 이 배치에서는
`action`과 `mood`, `scene`과 `sensory`를 합치지 않는 편이 편집 판단을
보존하므로 새 UI type을 추가하거나 기존 type을 통합하지 않았다.

### #19 최소 editorial regression set

다음은 후속 배치가 다시 확인할 단일 기대값이다.

| 사례 | 기대 결과 |
| --- | --- |
| `w034-s1 완고하다 ↔ w035-s1 유연하다` | 같은 태도 축의 `antonym`; 다른 sense로 확장하지 않음 |
| `w050-s1 느림 ↔ w051-s1 빠름` | 같은 속도 축의 `antonym` |
| `w048-s1 가벼움 ↔ w049-s1 무거움` | 물리적 무게 sense끼리만 `antonym` |
| `w048-s2 가벼움 ↔ w049-s2 무거움` | 부담 sense끼리만 `antonym`; `s1 ↔ s2` 교차 연결은 금지 |
| `w018-s1 기쁨 → w203-s1 웃다` | 감정에서 행동으로 향하는 `action` |
| `w203-s1 웃다 → w018-s1 기쁨` | 행동이 불러오는 정서 색인 `mood`; `action`의 자동 역방향이 아님 |
| `w191-s1 찾다`와 `w191-s2 찾다` | 대상 발견과 정보 탐색을 별도 sense로 유지 |
| `w220-s1 약속하다`와 `w220-s2 약속하다` | 지키기로 정함과 만남을 정함을 별도 sense로 유지 |
| `w289 속이 타다`, `w297 귀를 기울이다` | 고정된 전체 의미를 가진 `expression`으로 수록 |

다음은 오류 또는 보류로 유지하는 사례다.

| 금지·보류 사례 | 이유 |
| --- | --- |
| `w140 파도 → w134 바람`의 `action` | `바람`은 이 배치의 action target이 아니며, 자연물 연상만으로 동작 관계를 만들 수 없다. |
| `w191-s1 찾다 → w224 확인하다` | 정보 탐색 sense인 `w191-s2`에서만 가능한 action 방향이다. 잃은 대상을 찾는 sense로 복제하지 않는다. |
| `w048-s1 → w049-s2`의 `antonym` | 물리 무게와 부담을 섞는 cross-sense 관계라서 금지한다. |
| `w220-s1 ↔ w220-s2`의 `direct` | 같은 표면형이어도 약속의 두 장면이 달라 직접 대체로 합치지 않는다. |
| `w299 길을 잃다 → w191 찾다`의 `antonym` | 길을 잃은 상태와 찾는 행동은 결과 방향이 반대일 수 있어도 어휘 축의 반의어가 아니다. |

### 해결한 판단과 다음 blocker

이번 배치에서 해결한 범위는 누적 80개 출발어, 대표 다의어·표현·비대칭
관계·sense 대응 반의 관계, 그리고 내부 type과 UI projection의 분리다.
다음 배치에서도 먼저 확인해야 할 blocker는 다음과 같다.

- `마음`, `파도`, `찾다`, `놓다`, `안다`, `약속하다`의 추가 용례가 현재
  sense 경계를 실제 writer 검색에서 유지하는지 확인한다.
- 남은 후보를 수량으로 채우기 전에 보류 관계의 문장 틀과 장면 유용성을
  다시 검토한다.
- formal schema validator, 형태론 전체, 검색 ranking은 여전히 M2 이후로
  보류한다. 현재는 문서화한 ledger와 수동 전수 검토가 더 적합하다.

## 검증 기록

다음 검사를 실행했다.

```sh
node scripts/validate/canonical-jsonl.mjs
node --test tests/validate-canonical-jsonl.test.mjs
```

추가로 이 누적 배치의 JSONL을 읽어 다음을 확인했다.

- 레코드 109개, 출발어 80개, 참조 전용 29개, sense 125개, 관계 91개;
- 출발어 ID가 #17 대표 40개와 #19 추가 40개의 ledger 합집합과 정확히 일치;
- 후보표에 있는 참조 target은 `r###`로 중복 생성하지 않고 기존 `w###` ID를
  사용하며, 후보표 밖 target만 `r###`를 사용;
- 모든 relation target과 `target_sense`가 존재;
- self-reference, 동일 lexical identity의 후보-ID/참조-ID 이중 생성, 동일
  source/type/target 중복, 빈 필수 필드가 없음;
- relation type별 수량은 `direct` 14, `near` 7, `antonym` 15, `mood` 17,
  `scene` 7, `sensory` 13, `action` 9, `association` 9;
- 14개의 `direct` 관계 모두 JSONL의 `note`에 확인한 문장 틀을 갖고 있음;
- 9개의 `action` 관계 target은 모두 동사 sense이며, 장소·감각 명사를
  action target으로 잘못 표시하지 않음.

이 검증은 M0 JSONL 문법 검증과 M1 편집 기록을 보여 주는 수준이다. 정식
lexical schema, 의미 validator, ranking, SQLite 재현성 검증은 M2의 작업으로
남긴다.
