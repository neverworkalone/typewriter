# M1 provisional Editorial Model — #18/#19/#20/#21

## 범위와 상태

이 문서는 M1-2에서 처음 canonical에 넣은 대표 출발어 40개, M1-3에서
추가한 **경계 사례 40개**, M1-4와 M1-5에서 각각 확장한 **추가 출발어 80개씩**을 편집한 결정 기록이다. 정식 JSON Schema나 장기
ontology가 아니다. 실제 검색과 다음 배치의 편집에서 문제가 드러나면 이
모델을 다시 줄이거나 바꿀 수 있다.

canonical 원본은 [`data/canonical/pilot.jsonl`](../data/canonical/pilot.jsonl)이다.
이 누적 배치는 `docs/pilot-scope.md`의 대표 ID 40개, #19의 추가 경계 ID
40개, #20과 #21의 추가 ID 80개씩을 검색 출발어로 포함하고, 관계 대상을
완결하기 위한 참조 전용 레코드 34개를 함께 둔다.

| 항목 | 수량 | 의미 |
| --- | ---: | --- |
| 전체 canonical 레코드 | 274 | 출발어 240 + 참조 전용 34 |
| 검색 출발어 | 240 | #17 대표 40 + #19 경계 사례 40 + #20 확장 80 + #21 확장 80 |
| 참조 전용 레코드 | 34 | 관계 도착점으로만 수록하며 출발어로 세지 않음 |
| sense | 322 | 다의어는 하나의 레코드 안에서 sense를 나눔 |
| relation | 319 | 사람이 이 누적 배치에서 직접 판단해 남긴 관계 |

300개 전체 후보, SQLite, 정식 schema, 자동 의미 판정은 이 PR의 범위가
아니다. 미검수 초안이나 외부 원문은 저장하지 않았고, 아래의 gloss·관계
판단·문장 틀은 Typewriter가 이 배치를 위해 작성한 편집 기록이다.

## 검수 기록 약속

`docs/pilot-scope.md`의 **후속 검수 최소 체크리스트**를 이 배치에도
적용했다. 아래의 #18 40개 ledger, #19 추가 40개 ledger, #20과 #21의 추가
80개 ledger가 각 검색 출발어의 결정 상태와 짧은 판단을 한 번씩 기록한다.

- `included`인 출발어만 canonical에 들어간다. #18과 #19의 각 40개, #20과
  #21의 각 80개는 모두 `role: start`로 수록되었다.
- 참조 레코드는 `role: reference-only`로만 수록되며, 검색 출발어 수에
  포함하지 않는다.
- 참조 레코드도 아래의 별도 ledger에서 `included` 상태, `reference-only`
  역할, 그리고 이 배치에서 출발어가 아닌 이유를 항목별로 기록한다.
- 이 누적 배치에 `held`, `duplicate`, `excluded` 출발어는 없다. 아직
  선택하지 않은 후보를 수량으로 채우지 않았으며, 이번 배치 안에서
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
| w194 | included | start | 손으로 붙드는 물리 sense와 기회나 가능성을 얻는 비유 sense를 나누고 두 sense 사이에 임의 관계를 만들지 않았다. |
| w195 | included | start | 내려 두기, 붙잡은 대상을 풀기, 미련이나 감정을 내려놓기의 세 sense를 분리했다. |
| w203 | included | start | `웃다`는 동작이고 `기쁨`은 그 동작의 가능한 mood라는 방향만 기록했다. |
| w207 | included | start | 물리적으로 흔들리는 sense와 판단이 흔들리는 sense를 나누고 후자만 `불안`과 mood로 연결했다. |
| w213 | included | start | 품에 안기, 책임·결과 떠맡기, 감정·생각 품기의 세 sense를 분리했다. |
| w218 | included | start | `거절하다`는 행동, `서운함`은 가능한 결과 정서로 분리해 mood 방향만 기록했다. |
| w220 | included | start | 지키기로 정하는 약속과 만날 시간·장소를 정하는 약속을 두 sense로 나누었다. |
| w224 | included | start | 사실이나 상태를 알아보는 확인 행동으로 정의하고 `찾다`의 정보 탐색 뒤에만 연결했다. |
| w225 | included | start | 여럿 중 하나를 고르는 동사로 정의하고 `망설임` 뒤의 action target으로만 연결했다. |
| w231 | included | start | 상태가 달라지는 변화 동사로 수록했으며 모든 변화 결과를 relation으로 채우지 않았다. |
| w233 | included | start | 구조나 질서가 내려앉는 붕괴 동사로 수록했으며 `변하다`와 자동 near로 만들지 않았다. |
| w241 | included | start | 글을 담는 재료인 `종이`와 `문장`을 association으로 구분했다. |
| w245 | included | start | 글의 단위인 `문장`이 `쓰다`라는 행동을 불러오는 방향만 action으로 기록했다. |
| w247 | included | start | 대상을 부르는 `이름`을 수록했지만 “문장에 들어간다”는 일반 사실만으로 relation을 만들지는 않았다. |
| w257 | included | start | 입는 물건인 `옷`과 재질 감각인 `촉감`을 sensory로 연결했다. |
| w271 | included | start | 내면의 마음과 하려는 뜻의 두 sense를 나누고 각각 희망·바라다와 다른 type으로 연결했다. |
| w276 | included | start | 사실에 맞는 내용인 `진실`을 수록했지만 발화 행위인 `거짓말`과의 antonym은 단위가 맞지 않아 보류했다. |
| w277 | included | start | 사실이 아닌 내용을 말하는 `거짓말`을 수록했지만 `진실`과의 antonym은 같은 lexical 단위가 아니어서 보류했다. |
| w289 | included | start | 고정 표현 `속이 타다`는 불안한 정서를 장면화하는 expression으로 수록했다. |
| w297 | included | start | 고정 표현 `귀를 기울이다`는 소리를 집중해 듣는 expression으로 수록했다. |

## #20 추가 80개 확장 ledger

#20은 남은 후보를 기계적으로 채우는 배치가 아니라, 누적 80개에서 160개로
확장하면서 범주별 편집 품질을 비교하는 검수 단위다. 기존에 행동(A)이 상대적으로
많았으므로 #20에서는 정서·성질·감각·장면·사물·경계 사례를 더 넓히고, 행동은
8개로 제한했다.

| 범주 | #20 추가 | 누적 출발어 | 추가 ID |
| --- | ---: | ---: | --- |
| 정서·내면 (E) | 12 | 24 | w006, w007, w008, w011, w012, w013, w016, w017, w019, w020, w022, w028 |
| 성질·태도·상태 (Q) | 12 | 24 | w033, w037, w038, w039, w042, w043, w044, w045, w046, w047, w055, w056 |
| 감각 (S) | 14 | 27 | w062, w063, w064, w065, w067, w068, w069, w070, w072, w073, w074, w075, w076, w081 |
| 시간·자연·공간 (C) | 14 | 25 | w122, w124, w125, w128, w129, w130, w131, w134, w135, w136, w138, w139, w142, w144 |
| 움직임·관계·변화 (A) | 8 | 27 | w182, w183, w185, w186, w187, w188, w189, w200 |
| 사물·몸·쓰기 재료 (O) | 12 | 16 | w242, w243, w244, w246, w248, w249, w250, w251, w252, w253, w254, w260 |
| 추상어·표현·경계 (X) | 8 | 17 | w272, w273, w274, w278, w279, w280, w281, w291 |

모든 행은 `included`와 `start`로 확정한 검수 기록이다. 다만 `included`는
표제어 레코드를 수록했다는 뜻이지 가능한 모든 relation을 승인했다는 뜻은
아니다. 직접 대체를 확인하지 못한 항목은 near·mood·scene·sensory·action·
association으로 낮추거나 relation을 만들지 않았다.

| 후보 ID | 상태 | 역할 | 검수 판단 |
| --- | --- | --- | --- |
| w006 | included | start | `쓸쓸함`은 관계 부재가 만든 정서와 장면의 허전함으로 두고 `외로움`은 near, `여운`은 mood로 연결했다. |
| w007 | included | start | `외로움`은 홀로라고 느끼는 마음으로 한정하고 `쓸쓸함`과 고독은 near, 혼자 남은 방은 scene으로 기록했다. |
| w008 | included | start | 걱정이 풀린 뒤의 `안도`를 평온과 mood로 구분하고 `안도하다`는 action target으로만 두었다. |
| w011 | included | start | 지나간 선택을 잘못으로 여기는 `후회`를 `뉘우침`과 같은 명사 문장 틀에서만 direct로 확인했다. |
| w012 | included | start | 아직 놓지 못한 마음인 `미련`을 후회와 near, 그리움과 mood로 구분했다. |
| w013 | included | start | `분노`는 큰 화의 감정으로 두고 얼굴의 붉음은 감정이 드러나는 sensory 장면으로만 연결했다. |
| w016 | included | start | 위험을 앞둔 `두려움`과 앞일의 흔들림인 불안을 near로, 몸의 긴장은 mood로 기록했다. |
| w017 | included | start | 드러난 잘못을 부끄러워하는 `수치`를 붉은 얼굴의 sensory와 불안의 mood로 분리했다. |
| w019 | included | start | 상실이나 좌절의 `슬픔`을 쓸쓸함과 mood, 눈물과 sensory로 연결하되 감정과 흔적을 섞지 않았다. |
| w020 | included | start | 가능성을 잃은 `절망`과 방법이 보이지 않는 `막막함`을 near로 두고 슬픔은 mood로만 연결했다. |
| w022 | included | start | 가까운 결과를 기다리는 `기대`를 희망과 near, 바라다와 action으로 구분했다. |
| w028 | included | start | 후보 표면형 `막막`을 `막막하다`로 정리하고 방향을 찾기 어려운 adjective sense로 수록했다. |
| w033 | included | start | 표현이 투박한 `무뚝뚝하다`를 사람을 차갑게 대하는 냉정함과 near로 두었다. |
| w037 | included | start | 흐름이 억지스럽지 않은 `자연스럽다`를 상황의 부자연스러움인 어색함과 antonym으로 연결했다. |
| w038 | included | start | 낯선 경험의 `낯섦`을 `익숙함`과 antonym, 어색함과 near로 기록했다. |
| w039 | included | start | 여러 번 겪어 편안한 `익숙함`을 낯섦과 같은 친숙함 축의 antonym으로만 연결했다. |
| w042 | included | start | 물체의 굳센 성질인 `단단함`을 무름과 antonym, 손으로 느끼는 촉감과 sensory로 기록했다. |
| w043 | included | start | 쉽게 눌리는 `무름`을 단단함과 같은 물리 축의 antonym으로 한정했다. |
| w044 | included | start | 표면의 거침과 말·태도의 거침을 두 sense로 나누고 각각 부드러운 표면·태도와 대응시켰다. |
| w045 | included | start | 표면의 부드러움과 온화한 말투를 두 sense로 나누고 거칠다와 대응시켰다. |
| w046 | included | start | 물체의 끝·모서리와 감각·반응의 `날카로움`을 두 sense로 나누고 대응하는 둔함 sense와만 antonym으로 연결했다. |
| w047 | included | start | 물리적 무딤과 예민하지 않은 `둔함`을 두 sense로 나누어 날카로움의 같은 축과만 대응시켰다. |
| w055 | included | start | 따뜻한 기운인 `온기`를 냉기와 antonym, 온도의 감각과 sensory로 연결했다. |
| w056 | included | start | 차가운 기운인 `냉기`를 온기와 antonym, 서늘함과 near로 구분했다. |
| w062 | included | start | 중립적인 감각 범주인 `냄새`를 향기와 near, 비린내와 sensory로 좁혀 갔다. |
| w063 | included | start | 불쾌한 냄새인 `악취`를 냄새와 near로 두고 비린내와도 평가·원인을 섞지 않는 near로 기록했다. |
| w064 | included | start | 날것의 특유한 `비린내`를 냄새의 구체 종류로 두고 악취와 자동 동의어로 만들지 않았다. |
| w065 | included | start | 코로 느끼는 `단내`와 혀로 느끼는 단맛을 sensory로 연결해 감각 기관을 구분했다. |
| w067 | included | start | 빛이 거의 없는 `어둠`을 빛과 antonym, 밤과 scene으로 연결했다. |
| w068 | included | start | 물리적 그림자와 사건의 어두운 영향을 두 sense로 나누고 각각 빛의 sensory·여운의 mood로 기록했다. |
| w069 | included | start | 순간적으로 빛나는 `반짝임`을 넓은 빛과 구별한 sensory 이미지로 수록했다. |
| w070 | included | start | 색이 약해지는 빛바램과 기억·감정의 빛바램을 두 sense로 나누었다. |
| w072 | included | start | 색조인 `붉음`을 빛의 색감과 sensory, 노을과 감각 장면으로 연결했다. |
| w073 | included | start | `푸름`을 빛의 색조와 바다 장면으로 연결하되 색과 장소를 대체시키지 않았다. |
| w074 | included | start | 해가 지는 시간의 `노을`을 저녁과 scene, 붉음과 sensory로 기록했다. |
| w075 | included | start | 물리적 온도와 관계의 분위기 온도를 두 sense로 나누었다. |
| w076 | included | start | 공기·물체의 열기와 사람들이 달아오른 분위기의 열기를 두 sense로 분리했다. |
| w081 | included | start | 물리적 서늘함과 오싹한 분위기의 서늘함을 두 sense로 나누고 전자는 열기와 antonym으로 기록했다. |
| w122 | included | start | 하루의 활동이 시작되는 `아침`을 새벽과 near, 빛과 sensory로 구분했다. |
| w124 | included | start | 밤으로 넘어가는 `저녁`을 밤과 near, 노을과 scene으로 기록했다. |
| w125 | included | start | 해가 진 뒤의 `밤`을 저녁과 near, 어둠과 scene으로 연결했다. |
| w128 | included | start | 식물이 돋는 `봄`을 계절 레코드로 수록하고 반짝임은 감각 확장으로만 남겼다. |
| w129 | included | start | 더운 계절인 `여름`을 열기와 sensory, 바다와 scene으로 연결했다. |
| w130 | included | start | 서늘해지고 잎이 물드는 `가을`을 빛바랜 색의 sensory로만 확장했다. |
| w131 | included | start | 추운 `겨울`을 서늘함과 sensory, 긴 밤의 어둠과 scene으로 구분했다. |
| w134 | included | start | 공기의 움직임인 바람과 소망의 바람을 두 sense로 나누고, 전자는 바다·온도와, 후자는 소원과 연결했다. |
| w135 | included | start | 시야를 실제로 가리는 `안개`를 희미함과 sensory, 막막함과 mood로 구분했다. |
| w136 | included | start | 하늘의 물방울 덩어리인 `구름`을 빛을 가리는 sensory 장면으로만 기록했다. |
| w138 | included | start | 약한 밤의 빛인 `달빛`을 빛과 sensory, 밤과 scene으로 연결했다. |
| w139 | included | start | 먼 점광원인 `별빛`을 빛과 sensory, 밤과 scene으로 연결했다. |
| w142 | included | start | 넓은 짠물 공간인 `바다`를 파도와 scene, 물소리와 sensory로 확장했다. |
| w144 | included | start | 트인 자연 공간인 `들판`을 그 안을 가르는 바람의 scene으로만 연결했다. |
| w182 | included | start | 빠르게 나아가는 `달리다`를 수록했지만 순차적으로 반대되는 `멈추다`와 near 관계는 만들지 않았다. |
| w183 | included | start | 진행을 그치는 `멈추다`와 몸을 편하게 하는 `쉬다`를 near로 구분했다. |
| w185 | included | start | 뒤를 보는 돌아보기와 지난 일·사람을 살피는 돌아보기를 두 sense로 나누었다. |
| w186 | included | start | 장소를 떠나는 용법과 세상을 떠난다는 완곡 용법을 두 sense로 나누었다. |
| w187 | included | start | 목적지에 이르는 `도착하다`를 역과 scene으로만 기록하고 순차 국면인 `떠나다`와 near로 연결하지 않았다. |
| w188 | included | start | 사람이나 대상을 마주하는 `만나다`를 카페와 scene으로만 확장했다. |
| w189 | included | start | 가까운 사람과 헤어지는 `이별하다`를 쓸쓸함과 mood, 편지와 association으로 구분했다. |
| w200 | included | start | 말소리를 내는 용법과 내용을 알려 주는 용법을 두 sense로 나누었다. |
| w242 | included | start | 연필을 쓰기 도구로 검수하고 기록 행동 `쓰다`와 action으로 연결했다. |
| w243 | included | start | 잉크를 구체적인 기록 재료로 두고 쓰기 행동과 문장을 각각 action·association으로 연결했다. |
| w244 | included | start | 읽을 수 있는 출판물인 `책`을 `서적`과 검증된 문장 틀에서만 direct로 기록했다. |
| w246 | included | start | 문장 안의 어휘 단위인 `단어`를 `낱말`과 direct, 문장과 구성 관계로 구분했다. |
| w248 | included | start | 신체 부위인 얼굴과 표정·겉모습을 두 sense로 나누었다. |
| w249 | included | start | 냄새를 맡는 기관인 `코`를 냄새와 sensory로 연결하고 감각 자체와 섞지 않았다. |
| w250 | included | start | 몸의 손과 도움·일손의 손을 두 sense로 나누었다. |
| w251 | included | start | 몸의 발과 걸음의 흔적을 두 sense로 나누고 달리다·발이 묶이다와 방향을 달리했다. |
| w252 | included | start | 몸의 머리와 사고 능력의 머리를 두 sense로 나누었다. |
| w253 | included | start | 신체 부위인 어깨와 책임을 맡는 위치의 어깨를 두 sense로 나누었다. |
| w254 | included | start | 몸통 뒤쪽의 `등`을 수록하고 뒤를 돌아보는 장면과 association으로 연결했다. |
| w260 | included | start | 비·햇빛을 막는 도구인 우산을 비와 scene, 바람과 association으로만 연결했다. |
| w272 | included | start | 머릿속 작용인 생각과 의견·판단의 생각을 두 sense로 나누었다. |
| w273 | included | start | 낱말·문장으로서의 말과 입으로 하는 발화의 말을 두 sense로 나누었다. |
| w274 | included | start | 어떤 일이 일어난 까닭인 이유를 생각의 판단을 설명하는 association으로만 기록했다. |
| w278 | included | start | 남에게 알리지 않는 내용인 비밀을 숨기다라는 행동과 association으로 연결했다. |
| w279 | included | start | 확인되지 않고 퍼지는 소문을 말하다의 결과 내용과 의심을 부르는 mood로 구분했다. |
| w280 | included | start | 새로 전해진 내용과 안부·근황 전갈의 소식을 두 sense로 나누었다. |
| w281 | included | start | 이루어지기를 바라는 특정한 일인 소원을 희망과 near, 바라다와 action으로 기록했다. |
| w291 | included | start | `발이 묶이다`를 물리적 이동 불능과 사정에 의한 행동 제약의 expression 두 sense로 수록했다. |

## #20 참조 전용 ledger

#20에서는 관계를 검증하는 데 필요한 다섯 항목만 참조 전용으로 추가했다.
이들은 출발어 160개에 포함하지 않으며, 후보표의 `w238`은 후속 배치에서
출발어로 승격할 수 있지만 이번에는 책의 action target으로만 두었다.

| ID | 상태 | 역할 | 수록·역할 사유 |
| --- | --- | --- | --- |
| r032 | included | reference-only | `뉘우침`을 `w011 후회`와 같은 명사 문장 틀에서 direct 검증하기 위한 도착점이다. |
| r033 | included | reference-only | `고독`을 `w007 외로움`과 비교할 홀로 있음의 near 도착점으로만 수록했다. |
| r034 | included | reference-only | `낱말`을 `w246 단어`와 같은 어휘 단위 명사 자리에서 direct 검증하기 위한 도착점이다. |
| r035 | included | reference-only | `서적`을 `w244 책`과 출판물 명사 자리에서 direct 검증하기 위한 도착점이다. |
| w238 | included | reference-only | 후보표의 `읽다`를 `w244 책`에서 자연스럽게 이어지는 독서 action target으로만 수록했다. |

## #20 decision log와 보류 구분

- **다의어 경계:** `거칠다/부드럽다`, `그림자`, `빛바램`, `온도`, `열기`,
  `서늘함`, `바람`, `돌아보다`, `떠나다`, `말하다`, `얼굴`, `손`, `발`,
  `머리`, `어깨`, `생각`, `말`, `소식`, `발이 묶이다`는 문장 틀이나
  writer가 다음에 찾을 relation 방향이 달라 sense를 나누었다.
- **표현 경계:** #20에서 새로 수록한 표현은 `발이 묶이다` 하나다. 고정된
  전체 의미와 이동 제약의 장면이 보존되므로 `record_type: expression`으로
  두었고, 임의의 명사구나 활용형은 표현으로 만들지 않았다.
- **직접 대체 문턱:** #20에서 새로 확정한 direct는 `후회→뉘우침`,
  `책→서적`, `단어→낱말` 세 방향뿐이다. `냄새→향기`, `어둠→빛`,
  `계절→날씨`처럼 범위·평가·문장 슬롯이 달라지는 후보는 direct로 올리지
  않았다.
- **관계 방향:** `action`의 새 target은 `안도하다`, `읽다`, `쓰다`,
  `달리다`, `웃다`처럼 동사 또는 동작 표현으로만 남겼다. 상태·감정이
  행동을 부른다고 해서 자동 역방향을 복제하지 않았다.

다음 항목은 후보를 억지로 채우지 않고 relation을 보류하거나 낮춘 판단이다.

| 보류·낮춘 후보 | 판단 |
| --- | --- |
| `w182 달리다 ↔ w183 멈추다`, `w187 도착하다 ↔ w186 떠나다` | 움직임의 순차·대조 국면일 뿐 가까운 뜻이 아니므로 near 관계를 만들지 않았다. |
| `w134-s1 바람 → w281 소원` | 물리적 바람과 소망의 바람은 sense가 달라 연결하지 않았다. `w134-s2`에서만 소원과 near다. |
| `w128 봄`, `w130 가을`, `w144 들판`의 넓은 장면 후보 | 수량을 맞추기 위한 계절·자연 연상을 추가하지 않고, 검수한 장면만 남겼다. |
| `w243 잉크 → w245 문장` | “모든 글이 문장으로 이루어진다”가 아니라 잉크가 실제 기록 재료라는 구체 근거가 있어 association으로만 허용했다. |
| `w247 이름 → w245 문장` | #19에서 보류한 일반 사실 관계를 그대로 유지했으며 이번 확장에서도 되살리지 않았다. |
| 남은 M1 후보 | 이번 80개에 포함하지 않은 후보는 검수 완료나 canonical 수록으로 세지 않고, 다음 선정 단위에서 별도 판단한다. |

## #20 editorial regression set

| 사례 | 기대 결과 |
| --- | --- |
| `w044-s1 ↔ w045-s1` | 물리 표면 sense끼리만 `antonym`; `s1 ↔ s2` 교차 연결은 금지 |
| `w044-s2 ↔ w045-s2` | 말·태도 sense끼리만 `antonym`; 촉감 sense와 섞지 않음 |
| `w067-s1 → w066-s1` | 어둠에서 밝음으로 향하는 시각 축 `antonym`; 관계는 방향성을 가지므로 역행을 자동 생성하지 않음 |
| `w046-s1 ↔ w047-s1` | 물체의 끝·모서리라는 물리 축끼리만 `antonym` |
| `w046-s2 ↔ w047-s2` | 감각·반응의 예민함 축끼리만 `antonym`; `s1 ↔ s2` 교차 연결은 금지 |
| `w135-s1 → w041-s1` | 안개가 시야를 흐리게 하는 감각 효과는 `sensory`; 기상 현상과 시각 성질을 `near`로 묶지 않음 |
| `w070-s1`와 `w070-s2` | 색의 빛바램과 기억·감정의 빛바램을 별도 sense로 유지 |
| `w075-s1`와 `w075-s2` | 물리 온도와 관계 분위기를 별도 sense로 유지 |
| `w134-s1`와 `w134-s2` | 공기의 움직임과 소망을 별도 sense로 유지 |
| `w191-s1 → w224-s1` | 대상 발견 sense에서 확인 행동을 자동으로 만들지 않음; 기존 `action`은 `w191-s2`에만 유지 |
| `w244-s1 → r035-s1` | 출판물 명사 자리의 `direct` |
| `w246-s1 → r034-s1` | 어휘 단위 명사 자리의 `direct` |
| `w247-s1 → w245-s1` | 일반적인 문장 포함 사실만으로 만든 association은 계속 보류 |
| `w200-s1`와 `w200-s2` | 말소리 표현과 내용 전달을 별도 sense로 유지 |
| `w252-s1`와 `w252-s2` | 신체 부위와 사고 능력을 별도 sense로 유지 |
| `w280-s1`와 `w280-s2` | 새 소식과 안부 전갈을 별도 sense로 유지 |
| `w291-s1`와 `w291-s2` | 물리적 이동 불능과 비유적 제약의 expression을 별도 sense로 유지 |
| 모든 `action` target | target 품사는 동사 또는 expression이어야 함 |

## #21 추가 80개 확장 ledger

#21은 누적 출발어를 160개에서 240개로 넓히면서, 이전 배치에서 정한
relation type·sense 분할·관계 방향이 범주가 달라져도 유지되는지 확인하는
확장이다. 숫자를 채우기 위해 관계를 만들지 않고, 참조 전용 레코드는 새로
추가하지 않았다.

| 범주 | #21 추가 | 누적 출발어 | 추가 ID |
| --- | ---: | ---: | --- |
| 정서·내면 (E) | 6 | 30 | w014, w015, w024, w025, w027, w029 |
| 성질·태도·상태 (Q) | 6 | 30 | w052, w053, w054, w057, w058, w059 |
| 감각 (S) | 18 | 45 | w078, w080, w082, w083, w084, w085, w087, w089, w092, w093, w094, w095, w098, w100, w101, w102, w103, w104 |
| 시간·자연·공간·장면 (C) | 18 | 43 | w123, w126, w141, w146, w148, w149, w150, w152, w153, w154, w155, w156, w158, w159, w161, w162, w163, w164 |
| 움직임·관계·변화 (A) | 15 | 42 | w196, w197, w198, w199, w201, w204, w205, w206, w208, w209, w210, w211, w212, w214, w215 |
| 사물·몸·쓰기 재료 (O) | 9 | 25 | w255, w256, w258, w259, w261, w262, w263, w264, w265 |
| 추상어·표현·경계 (X) | 8 | 25 | w282, w283, w284, w285, w286, w287, w290, w292 |

모든 행은 `included`와 `start`로 확정했다. 다만 이는 표제어 레코드를
수록했다는 뜻이지 가능한 모든 relation을 승인했다는 뜻은 아니다. 다음
ledger의 `관계 없음`은 검수 누락이 아니라 일반적·중복적인 연결을 의도적으로
남기지 않은 결과다.

| 후보 ID | 상태 | 역할 | 검수 판단 |
| --- | --- | --- | --- |
| w014 | included | start | `원망`은 상대에게 탓을 돌리는 마음으로 `서운함`과 near, `분노`와 mood만 남겼다. |
| w015 | included | start | `질투`는 관심을 빼앗길까 하는 마음으로 `의심`을 부를 수 있는 mood로만 기록했다. |
| w024 | included | start | `믿음`은 앞으로의 가능성을 지지할 수 있지만 `희망`과는 다른 방향이므로 mood로 두었다. |
| w025 | included | start | `무심하다`는 관심을 드러내지 않는 태도로 정리하고 `무뚝뚝함`과 near, `냉정함`과 mood로 구분했다. |
| w027 | included | start | `초조`는 기다림 속의 급한 불안으로 `불안`과 near, `긴장`과 mood로 좁혔다. |
| w029 | included | start | `허전하다`는 비어 채워지지 않는 감정으로 `쓸쓸함`과 near, `빈방`과 scene으로 확장했다. |
| w052 | included | start | 물리적 깊이와 생각·감정의 깊이를 두 sense로 나누고 대응하는 `얕음` sense끼리만 antonym으로 연결했다. |
| w053 | included | start | 물리적 얕음과 내용의 얕음을 두 sense로 나누고 `깊음`의 같은 축과만 antonym으로 연결했다. |
| w054 | included | start | 공간의 빈틈과 방어의 허점을 두 sense로 나누고 공간 sense만 `틈`과 near로 연결했다. |
| w057 | included | start | `적막`은 소리와 인기척이 끊긴 장면으로 `고요`와 mood, `소란`과 antonym으로 기록했다. |
| w058 | included | start | `소란`은 소리와 움직임이 넘치는 상태로 `적막`과 같은 장면 축의 antonym만 남겼다. |
| w059 | included | start | `침묵`은 말이나 소리를 내지 않는 상태라 주변 장면인 `적막`과 near로 구분했다. |
| w078 | included | start | 수분이 적은 `건조`를 `젖음`과 antonym, `촉감`과 sensory로 연결했다. |
| w080 | included | start | 찌르는 피부 감각인 `따가움`을 넓은 `통증`과 near, `촉감`과 sensory로 기록했다. |
| w082 | included | start | 몸이 느끼는 온도인 `뜨거움`을 `차가움`과 antonym, 퍼지는 `열기`와 near로 구분했다. |
| w083 | included | start | 직접 느끼는 `차가움`을 `뜨거움`과 antonym, 주변 기운인 `냉기`와 near로 구분했다. |
| w084 | included | start | 수분이 스민 `젖음`을 `건조`와 antonym, 공기·물체의 `습기`와 sensory로 기록했다. |
| w085 | included | start | 수분·생기의 메마름과 감정·관계의 메마름을 두 sense로 나누고 각각 `건조`와 near, `무심함`과 mood로 연결했다. |
| w087 | included | start | 소리가 퍼져 남는 `울림`을 넓은 `소리`와 sensory, 되돌아오는 `메아리`와 near로 구분했다. |
| w089 | included | start | 낮은 말소리인 `속삭임`을 목소리의 크기와 거리감을 드러내는 sensory로 기록했다. |
| w092 | included | start | 걷는 원인이 드러나는 `발소리`를 넓은 `소리`와 sensory로 연결했다. |
| w093 | included | start | 몸에서 나는 `숨소리`를 호흡 장면으로 좁혀 `소리`와 sensory로 기록했다. |
| w094 | included | start | 반복되는 몸의 리듬인 `심장박동`이 긴장할 때 빨라지는 관계를 mood로만 남겼다. |
| w095 | included | start | 보이지 않는 존재를 알아차리게 하는 `기척`을 방 안의 장면인 `방`과 scene으로 연결했다. |
| w098 | included | start | 음식의 맛을 느끼는 감각과 먹고 싶은 정도·취향을 두 sense로 나누고 첫 sense만 `단맛`과 near로 연결했다. |
| w100 | included | start | 혀로 느끼는 `쓴맛`을 단맛과 같은 맛의 대비가 아니라 구체 감각 확장인 sensory로 기록했다. |
| w101 | included | start | `신맛`은 맛 후보로 수록했지만 이번 배치에서 확인된 writer-facing target이 없어 관계를 만들지 않았다. |
| w102 | included | start | `짠맛`은 맛 후보로 수록했지만 일반적인 음식 연상으로 관계를 채우지 않았다. |
| w103 | included | start | `떫은맛`은 독립 감각으로 수록하고 다른 맛과의 중복 near를 보류했다. |
| w104 | included | start | `목마름`은 몸의 상태로 수록했지만 물·습기 같은 일반 장면 target은 만들지 않았다. |
| w123 | included | start | 낮의 시간 축에서 `밤`과 antonym, `아침`과 near를 기록하고 시간 순서를 반의어로 넓히지 않았다. |
| w126 | included | start | 자정 무렵인 `한밤중`을 `밤`과 near, 빛이 적은 `어둠`과 scene으로 구분했다. |
| w141 | included | start | 흐르는 자연 공간인 `강`을 더 넓은 수변 장면인 `바다`와 scene으로만 연결했다. |
| w146 | included | start | 통행이 모이는 `길목`을 수록했지만 일반적인 장소 연상은 관계로 만들지 않았다. |
| w148 | included | start | 건물의 위쪽 구조인 `지붕`을 수록하고 보편적인 건물 장면 target은 보류했다. |
| w149 | included | start | 오르내리는 구조물인 `계단`을 수록했지만 다른 공간과의 일반 장면 연결은 보류했다. |
| w150 | included | start | 드나드는 경계인 `문턱`을 생활 공간인 `방`과 scene으로 기록했다. |
| w152 | included | start | 사람이 없는 공간인 `빈방`을 `방`과 near, `외로움`과 mood로 구분했다. |
| w153 | included | start | 조리 공간인 `부엌`을 넓은 생활 공간인 `방`과 scene으로만 연결했다. |
| w154 | included | start | 이동을 이어 주는 실내 공간인 `복도`를 `방`과 scene으로 기록했다. |
| w155 | included | start | 집 안의 열린 공간인 `마당`을 수록했지만 바람·집 같은 일반 연상은 보류했다. |
| w156 | included | start | 건물 위의 공간인 `옥상`을 수록했지만 수량을 위한 장면 target은 만들지 않았다. |
| w158 | included | start | 사람이 기다리는 `정류장`을 이동 장면의 `역`과 scene으로 연결했다. |
| w159 | included | start | 열차가 서는 `플랫폼`을 `역`과 scene으로 구분했다. |
| w161 | included | start | 물건과 사람이 모이는 `시장`을 수록했지만 일반 장소 관계는 보류했다. |
| w162 | included | start | 배움의 공간인 `학교`를 수록했지만 보편적인 장소 연상은 만들지 않았다. |
| w163 | included | start | 진료와 통증의 장면을 여는 `병원`을 `통증`과 scene으로 기록했다. |
| w164 | included | start | 공연을 보는 `극장`을 수록했지만 카페·학교 같은 넓은 장소 연상은 보류했다. |
| w196 | included | start | 건네고 받는 상호 장면에서 `건네다`와 `받다`를 direct·near가 아닌 association으로 연결했다. |
| w197 | included | start | `받다`도 반대 행동의 대체어가 아니라 `건네다`를 떠올리는 association으로 기록했다. |
| w198 | included | start | `부르다`는 여러 용법이 더 필요한 행동으로 수록하고 이번 배치에서는 관계를 확정하지 않았다. |
| w199 | included | start | 응답 행동인 `대답하다`를 말소리를 내는 `말하다`와 action으로 연결했다. |
| w201 | included | start | 소리를 알아차리는 듣기와 말을 받아들이는 듣기를 두 sense로 나누고 각각 sensory·association으로 기록했다. |
| w204 | included | start | `울다`를 `슬픔`과 mood, `눈물`과 sensory로 연결해 행동과 정서·흔적을 구분했다. |
| w205 | included | start | 몸을 기대는 물리 sense와 사람·도움에 의지하는 sense를 나누고 무리한 near를 만들지 않았다. |
| w206 | included | start | 기울어지는 움직임을 수록했지만 방향만으로 다른 움직임과 near를 만들지 않았다. |
| w208 | included | start | 몸이 떠는 `떨다`를 흔들리는 상태인 `흔들리다`와 near로 기록했다. |
| w209 | included | start | 방향을 바꾸는 `돌아서다`를 수록했지만 앞뒤 이동의 일반 연상은 보류했다. |
| w210 | included | start | 가까워지는 행동인 `다가가다`를 수록했지만 장면만으로 관계를 채우지 않았다. |
| w211 | included | start | 미는 힘의 방향에서 `당기다`와 antonym으로 연결했다. |
| w212 | included | start | 당기는 힘의 방향에서 `밀다`와 antonym으로 연결했다. |
| w214 | included | start | 상대를 밖으로 밀어내는 행동이 `거절하다`를 떠올리는 association으로만 이어진다. |
| w215 | included | start | 붙드는 행동을 `잡다`와 near, 놓아 보내는 방향을 `놓다`와 antonym으로 구분했다. |
| w255 | included | start | 입술은 말소리를 내는 장면을 불러오므로 `말하다`와 action으로 기록했다. |
| w256 | included | start | 목에서 나는 소리와 `목소리`의 관계를 sensory로 기록하고 신체와 소리를 합치지 않았다. |
| w258 | included | start | 물건을 넣는 `주머니`를 수록했지만 일반적인 사물·옷 연상은 보류했다. |
| w259 | included | start | 발에 신는 `신발`을 달리는 장면과 association으로 연결했다. |
| w261 | included | start | 마시는 도구인 `컵`을 머무는 장소인 `카페`와 scene으로 구분했다. |
| w262 | included | start | 음식을 담는 `접시`를 수록했지만 일반적인 식사 장면 target은 만들지 않았다. |
| w263 | included | start | 머리를 정돈하는 `빗`을 신체 부위인 `머리`와 association으로 연결했다. |
| w264 | included | start | 타는 `불`을 시각 감각인 `빛`과 열의 감각인 `열기`에 각각 sensory로 연결했다. |
| w265 | included | start | 불이 타고 남은 `재`를 `불`과 association으로 기록했다. |
| w282 | included | start | 피하기 어려운 미래의 `운명`을 바라는 미래 장면인 `꿈`과 association으로만 연결했다. |
| w283 | included | start | 예기치 않은 `우연`을 누군가를 마주하는 `만나다`와 association으로 기록했다. |
| w284 | included | start | 물리적 공간의 틈과 시간·관계 사이의 여유를 두 sense로 나누고 각각 `빈틈`·`사이`와 near로 연결했다. |
| w285 | included | start | 경계선이나 경계 상태를 수록하고 비어 있는 `틈`과는 association으로 구분했다. |
| w286 | included | start | 시간·관계의 거리인 `사이`를 `틈`의 대응 sense와 near로 기록했다. |
| w287 | included | start | 가까이 있는 `곁`을 수록했지만 `사이`·관계와의 일반적인 연상은 보류했다. |
| w290 | included | start | `가슴이 먹먹하다`는 고정된 감정 표현이므로 expression으로 두고 `슬픔`과 mood로 연결했다. |
| w292 | included | start | `입을 다물다`는 말하지 않는 행동을 보존하는 expression으로 두고 `침묵`과 near로 기록했다. |

## #21 참조 전용 ledger

#21에서는 참조 전용 레코드를 추가하지 않았다. 현재 참조 전용은 34개로
유지되며, 새 relation은 기존 reference 또는 #21의 start 레코드만 target으로
삼는다. 따라서 #21의 80개는 모두 검색 출발어이고, 참조 전용 수를 늘려
출발어 수를 부풀리지 않았다.

| 추가 ID | 상태 | 역할 | 수록·역할 사유 |
| --- | --- | --- | --- |
| 없음 | 해당 없음 | reference-only 없음 | 34개 기존 참조 전용 레코드로 모든 #21 target을 완결할 수 있었다. |

## #21 decision log와 보류 구분

- **관계 밀도:** #20은 출발어 80개에 relation 150개를 추가해 출발어당
  1.88개였지만, #21은 80개에 81개를 추가해 1.01개다. 이는 모델이
  느슨해진 결과가 아니라 `w101–w104`, 여러 일반 공간·사물·행동 후보의
  관계를 quota처럼 만들지 않은 결과다.
- **범주 균형:** #21은 E 6, Q 6, S 18, C 18, A 15, O 9, X 8개를
  추가해 누적 E 30, Q 30, S 45, C 43, A 42, O 25, X 25개가 되었다.
  감각·장면을 넓혔지만 관계 밀도를 동일하게 강제하지 않았다.
- **sense 경계:** `깊음/얕음`은 물리·추상 축, `빈틈`은 공간·방어 축,
  `메마름`은 물리·관계 축, `입맛`은 감각·식욕 축, `듣다`는 소리·수용
  축, `기대다`는 물리·의지 축, `틈`은 공간·시간·관계 축으로 나누었다.
- **표현 경계:** 새 표현은 `가슴이 먹먹하다`, `입을 다물다` 두 개뿐이다.
  단일 동사와 일반 명사구는 expression으로 승격하지 않았다.
- **direct 문턱:** #21에서는 새 `direct`를 추가하지 않았다. 보완·상호
  행동인 `건네다/받다`도 direct나 near가 아니라 association으로 두었다.
- **보류한 관계:** `신맛`, `짠맛`, `떫은맛`, `목마름`, `길목`, `지붕`,
  `계단`, `마당`, `옥상`, `시장`, `학교`, `극장`, `부르다`, `기대다`,
  `기울다`, `돌아서다`, `다가가다`, `주머니`, `접시`, `곁`은 현재
  관계를 남기지 않았다. 이들은 `included`이지만 generic scene·공통
  target을 억지로 채우지 않은 사례다.

| 관계 type | #20 누적 | #21 추가 | #21 누적 |
| --- | ---: | ---: | ---: |
| `direct` | 17 | 0 | 17 |
| `near` | 35 | 20 | 55 |
| `antonym` | 31 | 14 | 45 |
| `mood` | 36 | 11 | 47 |
| `scene` | 24 | 11 | 35 |
| `sensory` | 48 | 13 | 61 |
| `action` | 20 | 2 | 22 |
| `association` | 27 | 10 | 37 |
| **합계** | **238** | **81** | **319** |

## #21 editorial regression set

| 사례 | 기대 결과 |
| --- | --- |
| `w052-s1 ↔ w053-s1`, `w052-s2 ↔ w053-s2` | 물리 깊이와 내용의 깊이를 각각 대응 sense끼리만 `antonym`; cross-sense 금지 |
| `w078-s1 ↔ w084-s1` | 수분 축의 `antonym`; `건조`와 `젖음`을 촉감의 near로 바꾸지 않음 |
| `w082-s1 ↔ w083-s1` | 직접 느끼는 온도 축의 `antonym`; `열기`·`냉기`는 near로 분리 |
| `w057-s1 ↔ w058-s1`와 `w059-s1 → w057-s1` | 소란과 적막은 `antonym`, 침묵과 적막은 주변 장면 차이의 `near` |
| `w085-s1`와 `w085-s2` | 물리적 메마름과 관계의 메마름을 분리하고 각각 near·mood로 유지 |
| `w098-s1`와 `w098-s2` | 맛을 느끼는 감각과 식욕·취향을 분리; 첫 sense만 `단맛`과 near |
| `w123-s1 → w125-s1` | 낮과 밤은 시간 축의 `antonym`; 아침은 `near`이며 단순 순서 관계가 아님 |
| `w201-s1`와 `w201-s2` | 소리를 듣는 sense와 말을 받아들이는 sense를 분리해 sensory·association으로 유지 |
| `w196-s1 ↔ w197-s1` | 건네고 받기는 상호 행동이지만 직접 대체·near가 아닌 association |
| `w211-s1 ↔ w212-s1` | 밀기와 당기기는 같은 힘의 방향 축에서 `antonym` |
| `w284-s1`와 `w284-s2` | 물리적 틈과 시간·관계의 틈을 분리하고 `빈틈`·`사이` target도 대응 sense로 제한 |
| `w290`, `w292` | 고정된 전체 의미를 가진 독립 `expression`; 단순 활용형으로 취급하지 않음 |
| 모든 #21 `action` target | target 품사는 동사 또는 expression이어야 하며, 전수 audit에서 이를 확인 |

### #22로 넘기는 blocker

현재 blocker는 없다. #21의 80개 start, 34개 reference-only, 322개 sense,
319개 relation과 새 표현 2개를 검수했고, #20 대비 관계 밀도·범주별 분포·
보류 관계를 기록했다. #22는 이 PR이 머지된 최신 `master`에서 남은 후보를
별도 배치로 검토하면 된다.

## #20에서 #21로 넘긴 blocker

이 절은 #20 당시의 handoff 기록이다. 당시 blocker는 없었고, 누적 160개
출발어, 34개 참조 전용 레코드, 234개 sense, 238개 relation을 전수 점검한
뒤 #21을 최신 `master`에서 시작했다.

### M2 이후의 비차단 보류

- formal schema validator, 형태론 전체, 검색 ranking은 여전히 M2 이후로 보류한다.
- 이 항목들은 #21의 canonical 검수와 #22 착수를 막지 않으며, JSONL validator와
  수동 identity·sense·relation audit로 현재 M1 범위를 검증한다.

## 검증 기록

다음 검사를 실행했다.

```sh
node scripts/validate/canonical-jsonl.mjs
node --test tests/validate-canonical-jsonl.test.mjs
```

추가로 #17–#21 누적 JSONL을 읽어 다음을 확인했다.

- 전체 274 records 중 `role: start` 240개와 `role: reference-only` 34개;
- 240개 출발어의 `candidate_id`가 중복 없이 존재하고 #21 ledger 80개가 모두 수록됨;
- 전체 322개 sense ID와 319개 relation target/target_sense가 존재하며 self-reference 없음;
- relation type별 수량은 `direct` 17, `near` 55, `antonym` 45, `mood` 47,
  `scene` 35, `sensory` 61, `action` 22, `association` 37;
- #21 범주별 추가 수량은 E 6, Q 6, S 18, C 18, A 15, O 9, X 8이며,
  참조 전용 추가 0개와 새 expression 2개를 확인했다;
- `git diff --check`와 후보 표면형 300개 대조, target·sense·중복·action
  품사 전수 audit도 통과했다.

## 임시 레코드 모델

이 구조는 현재 274개 레코드를 사람이 읽고 고치기 위한 최소 표현이다. 정식
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
`숨을 고르다`, `길을 잃다`, `속이 타다`, `귀를 기울이다`, `발이 묶이다`가 이 배치의
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
| `w194-s1 잡다`와 `w194-s2 잡다` | 물리적으로 붙드는 용법과 기회·가능성을 얻는 비유 용법을 별도 sense로 유지 |
| `w195-s1/s2/s3 놓다` | 내려 두기, 물리적 해제, 심리적 내려놓기를 세 sense로 유지 |
| `w213-s1/s2/s3 안다` | 품에 안기, 책임·결과 떠맡기, 감정·생각 품기를 세 sense로 유지 |
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
| `w276 진실 ↔ w277 거짓말`의 `antonym` | 참된 내용과 거짓 발화 행위의 단위가 달라 현재는 보류한다. |
| `w247 이름 → w245 문장`의 `association` | 모든 단어가 문장에 들어간다는 일반 사실만으로는 writer-facing 관계가 되지 않아 보류한다. |

### #19에서 #20으로 넘긴 blocker

현재 blocker는 없다. 누적 80개 출발어, 대표 다의어·표현·비대칭 관계,
sense 대응 반의 관계, 내부 type과 UI projection의 분리를 이 PR에서
검토했고, 이 판단으로 #20은 이 PR이 머지된 최신 master에서 시작할 수 있었다.

### #20으로 넘긴 재검토 항목

- `마음`, `파도`, `찾다`, `놓다`, `안다`, `약속하다`의 추가 용례가 현재
  sense 경계를 실제 writer 검색에서 유지하는지 확인한다.
- 남은 후보를 수량으로 채우기 전에 보류 관계의 문장 틀과 장면 유용성을
  다시 검토한다.

### M2 이후의 비차단 보류

- formal schema validator, 형태론 전체, 검색 ranking은 M2 이후로 보류한다.
- 이 항목들은 #20의 검수나 다음 태스크 착수를 막지 않으며, 문서화한 ledger와
  수동 전수 검토로 M1의 현재 범위를 충분히 검증한다.
