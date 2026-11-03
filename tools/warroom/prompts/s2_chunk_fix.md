청크 {{chunk_id}} 저장 거부 — 지목된 줄만 수정

방금 판정이 저장 검증에서 거부되어 checkpoint는 바뀌지 않았다. 같은 카드 규칙으로 아래 **오류가 있는 `c<n>` 줄을 고치고, 누락된 `c<n>` 줄을 추가**해 답한다. 정상인 줄과 아래에 없는 별칭은 쓰지 않는다(War Room이 기존 정상 줄을 그대로 유지한다). 첫 줄은 `chunk {{chunk_id}}`, 이어서 고친/추가한 줄만 쓴다. 도구·파일·Git은 쓰지 않는다.

오류가 필드·형식에만 해당하면 기존 판정의 의미를 유지한다. relation의 `type`, `relevance`, 선택한 대상 Sense는 그대로 두고, validator가 지목한 필드만 바로잡는다. `target_resolution` 오류라면 현재 view의 해당 후보와 모든 표시된 같은 철자 대상 Sense를 비교해 exact target이 맞을 때만 `T<alias>`를 쓰고, 일치 대상이 없으면 `none T<alias>,...`를 쓴다. 형식 오류만으로 `D f`로 바꾸지 않는다.

{{relation_direction_rule}}

{{problem}}
