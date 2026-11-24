#927 Stage 2 진행 — 병렬 primary 작업 (task)

War Room이 한 Part의 primary 판정을 고정된 작업(task)으로 나눠 이 세션에 **작업 하나**를 맡겼다. 이 실행은 구현 작업이 아니라 판정이다. 판정 계약은 아래 카드와 task 뷰에 들어 있다. AGENTS.md·`docs/`·이슈·스크립트 소스를 읽지 않는다. **일반적인 판정에서는 도구와 파일을 사용하지 않는다.** Git·web·`gh`·다른 모델·CLI·서브에이전트도 쓰지 않는다. War Room이 마지막 답변을 파일에 기록하고 저장·검증한다. 현재 worktree·브랜치·HEAD·Part를 바꾸지 않는다. 다른 task의 후보나 checkpoint를 판단하지 않는다. 단, 실제 공통 결함을 발견한 경우에는 기존 규약에 따라 `tools/warroom/prompts/shared-defect.md` 형식으로 아래 「이번 task」에 지정된 보고 경로에 작성하고 중단한다.

{{s2_policy_card}}

compact 응답은 task 뷰의 `# decision` grammar를 따른다. CLI가 판정 형식을 자동 복구하도록 역방향 필드를 임의로 추가하거나 생략하지 않는다.

## 이번 task — 저장 거부된 후보만 수정

- Part: Shard {{shard}} · Batch {{batch}} · Part {{part}} (브랜치 `{{branch}}`)
- task ID(= 답변 첫 줄의 chunk ID): `{{chunk_id}}`
- 공통 결함 보고 경로: `{{defect_path}}`

이 task의 이전 답이 저장 검증에서 거부되어 checkpoint는 바뀌지 않았다. 아래 「이전 답」의 **지목된 `c<n>`만** 같은 카드 규칙으로 고쳐 다시 답한다(없던 줄은 새로 쓴다). War Room이 나머지 정상 줄을 그대로 유지한다. 아래 view는 그 후보만 담은 수정용 view이고 `c<n>`·`T<k>` 번호는 원래 task view와 같다.

오류가 필드·형식에만 해당하면 이전 판정의 의미를 유지한다. relation의 `type`, `relevance`, 선택한 대상 Sense는 그대로 두고, validator가 지목한 필드만 바로잡는다. `target_resolution` 오류라면 해당 후보와 표시된 모든 같은 철자 대상 Sense를 비교해 exact target이 맞을 때만 `T<alias>`를 쓰고, 일치 대상이 없으면 `none T<alias>,...`로 그 후보의 별칭을 **모두** 쓴다. 형식 오류만으로 `D f`로 바꾸지 않는다.

## 답변 형식

첫 줄은 정확히 `chunk {{chunk_id}}`, 이어서 아래 지목된 `c<n>` 각각의 행 하나만 쓴다. 진행 안내·설명·코드 펜스를 덧붙이지 않는다.

### 저장 오류

{{problem}}

### 이전 답 (지목된 행)

{{previous_rows}}

{{chunk_input}}
